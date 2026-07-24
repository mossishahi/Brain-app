import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  CreditBlockedError,
  addUsage,
  emptyUsage,
  serializeError,
  textContent,
  type AgentExecutionContext,
  type AgentProgress,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type JsonObject,
  type JsonValue,
  type ModelMessage,
  type TokenUsage,
} from "@brainstorm-agentic/core";
import {
  isCreditLimitMessage,
  resolveCreditReset,
  type CreditResetResolution,
} from "@brainstorm-agentic/credit-recovery";

type UnknownRecord = Record<string, unknown>;

export interface ClaudeAgentQuery {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  interrupt?(): Promise<void>;
}

export interface ClaudeAgentQueryInput {
  readonly prompt: string;
  readonly options: UnknownRecord;
}

export type ClaudeAgentQueryFn = (
  input: ClaudeAgentQueryInput,
) => ClaudeAgentQuery;

export interface ClaudeAgentExecutorConfig {
  /** Long-lived token printed by `claude setup-token`. */
  readonly token: string;
  /** Agent SDK model alias/full id. Omit to use the Claude Code default. */
  readonly model?: string;
  readonly cwd?: string;
  /** Job-owned attachment directories the built-in Read/Glob/Grep may access. */
  readonly attachmentRoots?: readonly string[];
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly thinking?: "adaptive" | "disabled";
  readonly fallbackModel?: string;
  /** Authoritative post-generation validator (for constraints JSON Schema cannot express). */
  readonly outputValidator?: ClaudeAgentOutputValidator;
  /** Full Agent SDK attempts for post-generation validation. Default 3. */
  readonly maxValidationAttempts?: number;
  /**
   * Minimum quiet time before a content-free "model working" heartbeat is
   * reported during long streamed turns. Default 20000 ms; 0 reports on every
   * stream delta (tests only).
   */
  readonly progressHeartbeatMs?: number;
  readonly creditRecovery?: {
    readonly safetyBufferSeconds?: number;
    readonly openRouterApiKey?: string;
    readonly openRouterModel?: string;
    readonly timeZone?: string;
    readonly now?: () => Date;
    readonly resolver?: (
      message: string,
    ) => Promise<CreditResetResolution>;
  };
  /** Parent for per-attempt disposable workspaces. Defaults under os.tmpdir(). */
  readonly taskWorkspaceRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam. Production callers omit this. */
  readonly queryFn?: ClaudeAgentQueryFn;
}

export type ClaudeAgentValidationResult =
  | boolean
  | {
      readonly success: boolean;
      readonly value?: JsonValue;
      readonly issues?: readonly (string | { readonly message?: string })[];
    };

export interface ClaudeAgentOutputValidator {
  validate(
    value: JsonValue,
    schema: JsonObject,
  ):
    | ClaudeAgentValidationResult
    | Promise<ClaudeAgentValidationResult>;
}

export interface ValidateClaudeSetupTokenInput {
  readonly token: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly queryFn?: ClaudeAgentQueryFn;
  readonly timeoutMs?: number;
}

const CAPABILITY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "web-search": ["WebSearch", "WebFetch"],
  "code-execution": ["Bash"],
  "attachment-access": ["Read", "Glob", "Grep"],
};

const LOGICAL_TOOLS: Readonly<Record<string, readonly string[]>> = {
  ...CAPABILITY_TOOLS,
};

const KNOWN_BUILTIN_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "Agent",
  "Task",
  "TodoWrite",
] as const;

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : {};
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value as UnknownRecord).every(isJsonValue)
  );
}

function abortError(reason?: unknown): Error {
  const error = new Error(
    typeof reason === "string" ? reason : "Claude Agent SDK task cancelled",
  );
  error.name = "AbortError";
  return error;
}

function assertToken(token: string): void {
  if (token.trim() === "") {
    throw new Error("Claude setup token must not be empty");
  }
}

function assertConfig(config: ClaudeAgentExecutorConfig): void {
  assertToken(config.token);
  if (
    config.maxTurns !== undefined &&
    (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1)
  ) {
    throw new Error("Claude Agent SDK maxTurns must be a positive integer");
  }
  if (
    config.maxBudgetUsd !== undefined &&
    (!Number.isFinite(config.maxBudgetUsd) || config.maxBudgetUsd <= 0)
  ) {
    throw new Error("Claude Agent SDK maxBudgetUsd must be positive");
  }
  if (
    config.maxValidationAttempts !== undefined &&
    (!Number.isSafeInteger(config.maxValidationAttempts) ||
      config.maxValidationAttempts < 1)
  ) {
    throw new Error(
      "Claude Agent SDK maxValidationAttempts must be a positive integer",
    );
  }
  if (
    config.progressHeartbeatMs !== undefined &&
    (!Number.isFinite(config.progressHeartbeatMs) ||
      config.progressHeartbeatMs < 0)
  ) {
    throw new Error(
      "Claude Agent SDK progressHeartbeatMs must be zero or positive",
    );
  }
}

function sdkEnvironment(
  token: string,
  supplied: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...supplied,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_AGENT_SDK_CLIENT_APP: "brainstorm-agentic/0.1.0",
  };
  // Make authentication unambiguous: this backend must use the setup token,
  // never an API key inherited from the shell that launched the server.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function taskWorkspace(
  config: ClaudeAgentExecutorConfig,
  task: AgentTask,
  context: AgentExecutionContext,
  attempt: number,
): string {
  const root =
    config.taskWorkspaceRoot ??
    join(tmpdir(), "brainstorm-agentic-agent-tasks");
  const digest = createHash("sha256")
    .update(`${context.runId}\0${task.taskId}`)
    .digest("hex")
    .slice(0, 20);
  const directory = join(root, digest, `attempt-${attempt}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function messagePrompt(messages: readonly ModelMessage[]): string {
  const rendered = messages
    .map((message) => {
      const text = textContent(message.content).trim();
      return text === ""
        ? ""
        : `${message.role === "assistant" ? "Assistant context" : "Task"}:\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
  return rendered === "" ? "Complete the task described in the system prompt." : rendered;
}

function allowedTools(task: AgentTask): string[] {
  const tools = new Set<string>();

  // If a capability plan is present, use it to determine available tools
  if (task.capabilityPlan) {
    for (const op of task.capabilityPlan.operations) {
      if (op.source === "unavailable") continue;
      // For provider-source ops on the SDK path, map through CAPABILITY_TOOLS
      // For host-source ops, the SDK uses its own builtin mapping
      const capTools = CAPABILITY_TOOLS[op.capabilityId];
      if (capTools) {
        for (const name of capTools) tools.add(name);
      }
    }
    // Also add any logical tools from task.tools
    for (const logical of task.tools ?? []) {
      const mapped = LOGICAL_TOOLS[logical];
      if (mapped) mapped.forEach((name) => tools.add(name));
      else if ((KNOWN_BUILTIN_TOOLS as readonly string[]).includes(logical)) {
        tools.add(logical);
      }
    }
    return [...tools];
  }

  // Legacy path: use allowedCapabilities directly
  for (const capability of task.allowedCapabilities ?? []) {
    for (const name of CAPABILITY_TOOLS[capability] ?? []) tools.add(name);
  }
  for (const logical of task.tools ?? []) {
    const mapped = LOGICAL_TOOLS[logical];
    if (mapped) mapped.forEach((name) => tools.add(name));
    else if ((KNOWN_BUILTIN_TOOLS as readonly string[]).includes(logical)) {
      tools.add(logical);
    }
  }
  return [...tools];
}

function progress(
  context: AgentExecutionContext,
  value: AgentProgress,
): void {
  context.reportProgress?.(value);
}

function shortText(value: unknown, limit = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact === "") return undefined;
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

/** Name Claude Code gives the internal tool that transports structured output. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

function toolMessage(name: string, input: unknown): string {
  const args = record(input);
  switch (name) {
    case "WebSearch": {
      const query = shortText(args.query);
      return query ? `Searching the web — ${query}` : "Searching the web";
    }
    case "WebFetch": {
      const url = shortText(args.url);
      return url ? `Fetching a source — ${url}` : "Fetching a source";
    }
    case "Read": {
      // The path is part of the message so the activity feed and events
      // journal double as the attachment access log.
      const path = shortText(args.file_path ?? args.path);
      return path ? `Reading an input file — ${path}` : "Reading an input file";
    }
    case "Glob": {
      const pattern = shortText(args.pattern);
      return pattern
        ? `Discovering relevant files — ${pattern}`
        : "Discovering relevant files";
    }
    case "Grep": {
      const pattern = shortText(args.pattern);
      return pattern
        ? `Searching within files — ${pattern}`
        : "Searching within files";
    }
    case "Bash":
      return "Running a verification command";
    case STRUCTURED_OUTPUT_TOOL:
      return "Submitting the structured output";
    default:
      return `Using ${name}`;
  }
}

const TOOL_END_LABELS: Readonly<Record<string, string>> = {
  WebSearch: "Web search",
  WebFetch: "Source fetch",
  Read: "File read",
  Glob: "File discovery",
  Grep: "File search",
  Bash: "Verification command",
  [STRUCTURED_OUTPUT_TOOL]: "Structured output",
};

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * Per-query progress bookkeeping. Everything here observes messages the SDK
 * already sends; nothing adds model turns, tokens, or API calls.
 */
interface SdkProgressState {
  /** Quiet time before a streamed-turn heartbeat is emitted. */
  readonly heartbeatMs: number;
  /** tool_use_id -> last reported elapsedMs (throttles SDK tool_progress). */
  readonly lastToolProgress: Map<string, number>;
  /** tool_use_id -> start bookkeeping for tool_end durations. */
  readonly pendingTools: Map<string, { name: string; startedAt: number }>;
  /** What the current streamed turn is doing (reasoning / writing output). */
  phase?: { label: string; startedAt: number };
  /** Timestamp of the last progress event of any kind we emitted. */
  lastEmitAt: number;
}

function newProgressState(config: ClaudeAgentExecutorConfig): SdkProgressState {
  return {
    heartbeatMs: config.progressHeartbeatMs ?? 20_000,
    lastToolProgress: new Map(),
    pendingTools: new Map(),
    lastEmitAt: Date.now(),
  };
}

function emit(
  state: SdkProgressState,
  context: AgentExecutionContext,
  value: AgentProgress,
): void {
  state.lastEmitAt = Date.now();
  progress(context, value);
}

/**
 * Translates raw API stream events (thinking/text/tool-input deltas) into
 * throttled, content-free heartbeats so a minutes-long model turn never looks
 * like a hang. Deltas are reduced to a phase label + elapsed time; their
 * content is never read beyond the block type.
 */
function reportStreamEvent(
  message: UnknownRecord,
  context: AgentExecutionContext,
  state: SdkProgressState,
): void {
  const event = record(message.event);
  const now = Date.now();
  if (event.type === "message_start") {
    state.phase = { label: "Model reasoning", startedAt: now };
    return;
  }
  if (event.type === "message_stop") {
    state.phase = undefined;
    return;
  }
  if (event.type === "content_block_start") {
    const block = record(event.content_block);
    const label =
      block.type === "thinking"
        ? "Model reasoning"
        : block.type === "text"
          ? "Composing the response"
          : block.type === "tool_use"
            ? block.name === STRUCTURED_OUTPUT_TOOL
              ? "Writing the structured output"
              : `Preparing ${typeof block.name === "string" ? block.name : "tool"} input`
            : undefined;
    if (label !== undefined && state.phase?.label !== label) {
      state.phase = { label, startedAt: now };
    }
  } else if (event.type !== "content_block_delta") {
    return;
  }
  const phase = state.phase;
  if (!phase) return;
  if (now - state.lastEmitAt < state.heartbeatMs) return;
  emit(state, context, {
    kind: "model",
    elapsedMs: now - phase.startedAt,
    message: `${phase.label} · ${formatElapsed(now - phase.startedAt)}`,
  });
}

function reportSdkMessage(
  message: UnknownRecord,
  context: AgentExecutionContext,
  state: SdkProgressState,
): void {
  if (message.type === "stream_event") {
    reportStreamEvent(message, context, state);
    return;
  }
  if (message.type === "assistant") {
    const content = record(message.message).content;
    if (!Array.isArray(content)) return;
    for (const candidate of content) {
      const block = record(candidate);
      if (block.type !== "tool_use" || typeof block.name !== "string") continue;
      if (typeof block.id === "string") {
        state.pendingTools.set(block.id, {
          name: block.name,
          startedAt: Date.now(),
        });
      }
      emit(state, context, {
        kind: "tool_start",
        toolName: block.name,
        message: toolMessage(block.name, block.input),
      });
    }
    return;
  }
  if (message.type === "user") {
    // Tool results echo back as user messages; report each completion with
    // its duration and how many tool calls are still in flight.
    const content = record(message.message).content;
    if (!Array.isArray(content)) return;
    for (const candidate of content) {
      const block = record(candidate);
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      const pending = state.pendingTools.get(block.tool_use_id);
      if (!pending) continue;
      state.pendingTools.delete(block.tool_use_id);
      const elapsedMs = Date.now() - pending.startedAt;
      const label = TOOL_END_LABELS[pending.name] ?? pending.name;
      const outcome = block.is_error === true ? "failed" : "finished";
      const remaining = state.pendingTools.size;
      emit(state, context, {
        kind: "tool_end",
        toolName: pending.name,
        elapsedMs,
        message:
          `${label} ${outcome} · ${formatElapsed(elapsedMs)}` +
          (remaining > 0
            ? ` · ${remaining} tool${remaining === 1 ? "" : "s"} still running`
            : ""),
      });
    }
    return;
  }
  if (
    message.type === "tool_progress" &&
    typeof message.tool_name === "string"
  ) {
    const id =
      typeof message.tool_use_id === "string"
        ? message.tool_use_id
        : message.tool_name;
    const elapsedSeconds =
      typeof message.elapsed_time_seconds === "number"
        ? message.elapsed_time_seconds
        : 0;
    const elapsedMs = Math.round(elapsedSeconds * 1000);
    const last = state.lastToolProgress.get(id) ?? -5000;
    if (elapsedMs - last < 5000) return;
    state.lastToolProgress.set(id, elapsedMs);
    emit(state, context, {
      kind: "tool_progress",
      toolName: message.tool_name,
      elapsedMs,
      message: `${message.tool_name} still running · ${Math.round(elapsedSeconds)}s`,
    });
    return;
  }
  if (message.type !== "system") return;
  if (message.subtype === "init") {
    emit(state, context, {
      kind: "status",
      message:
        typeof message.model === "string"
          ? `Agent initialized with ${message.model}`
          : "Agent initialized",
    });
  } else if (message.subtype === "status" && message.status === "requesting") {
    emit(state, context, { kind: "model", message: "Requesting Claude response" });
  } else if (message.subtype === "status" && message.status === "compacting") {
    emit(state, context, { kind: "status", message: "Compacting agent context" });
  } else if (message.subtype === "api_retry") {
    const attempt =
      typeof message.attempt === "number" ? message.attempt : undefined;
    const max =
      typeof message.max_retries === "number"
        ? message.max_retries
        : undefined;
    emit(state, context, {
      kind: "retry",
      ...(attempt !== undefined ? { turn: attempt } : {}),
      message:
        attempt !== undefined && max !== undefined
          ? `API retry ${attempt}/${max}`
          : "Retrying the Claude API",
    });
  }
}

/**
 * Claude Code's `--json-schema` validator accepts the schema body but does not
 * preload the draft-2020-12 meta-schema URI emitted by our shared converter.
 * Keep the structural contract and remove only the adapter-incompatible
 * declaration. The runtime still validates the result with the authoritative
 * Zod schema after execution.
 */
function agentSdkOutputSchema(schema: JsonObject): JsonObject {
  const entries = Object.entries(schema).filter(([key]) => key !== "$schema");
  const sanitized = Object.fromEntries(entries) as JsonObject;
  if (
    sanitized.type === undefined &&
    Array.isArray(sanitized.oneOf) &&
    sanitized.oneOf.every(
      (branch) =>
        typeof branch === "object" &&
        branch !== null &&
        !Array.isArray(branch) &&
        (branch as JsonObject).type === "object",
    )
  ) {
    // Claude Code transports structured output as a custom tool. Its input
    // schema rejects oneOf/allOf/anyOf at the top level, so flatten a
    // discriminated object union into one object: common fields stay
    // required, branch-only fields become optional, and string const
    // discriminators become an enum. Authoritative Zod validation still
    // enforces branch-specific required fields after generation.
    const branches = sanitized.oneOf as JsonObject[];
    const propertyNames = new Set<string>();
    branches.forEach((branch) =>
      Object.keys((branch.properties as JsonObject | undefined) ?? {}).forEach(
        (name) => propertyNames.add(name),
      ),
    );
    const properties: Record<string, JsonValue> = {};
    for (const name of propertyNames) {
      const variants = branches.flatMap((branch) => {
        const property = (branch.properties as JsonObject | undefined)?.[name];
        return property === undefined ? [] : [property];
      });
      const constStrings = variants.map((variant) =>
        typeof variant === "object" &&
        variant !== null &&
        !Array.isArray(variant) &&
        typeof (variant as JsonObject).const === "string"
          ? ((variant as JsonObject).const as string)
          : undefined,
      );
      if (
        constStrings.length === branches.length &&
        constStrings.every((value) => value !== undefined)
      ) {
        properties[name] = {
          type: "string",
          enum: [...new Set(constStrings as string[])],
        };
      } else {
        properties[name] = variants[0] ?? {};
      }
    }
    const required = branches
      .map((branch) =>
        Array.isArray(branch.required)
          ? new Set(branch.required.filter((item): item is string => typeof item === "string"))
          : new Set<string>(),
      )
      .reduce<string[]>(
        (common, current) => common.filter((name) => current.has(name)),
        [...(branches[0]?.required as string[] | undefined ?? [])],
      );
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }
  return sanitized;
}

function usageFromResult(value: unknown): TokenUsage {
  const usage = record(value);
  const inputTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens
      : undefined;
  const cacheWrite =
    typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
  };
}

function parseResultOutput(result: UnknownRecord, task: AgentTask): JsonValue {
  const candidate = result.structured_output;
  if (candidate !== undefined) {
    if (!isJsonValue(candidate)) {
      throw new Error("Claude Agent SDK returned a non-JSON structured output");
    }
    return candidate;
  }
  const text = typeof result.result === "string" ? result.result : "";
  if (task.outputSchema !== undefined) {
    try {
      const trimmed = text.trim();
      const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
      const parsed: unknown = JSON.parse(fenced?.[1] ?? trimmed);
      if (!isJsonValue(parsed)) throw new Error("output is not JSON-safe");
      return parsed;
    } catch (error) {
      throw new Error("Claude Agent SDK did not return valid structured JSON", {
        cause: error,
      });
    }
  }
  return text;
}

function normalizeValidation(
  result: ClaudeAgentValidationResult,
  original: JsonValue,
): { success: boolean; value: JsonValue; issues: string[] } {
  if (typeof result === "boolean") {
    return {
      success: result,
      value: original,
      issues: result ? [] : ["Output does not satisfy its artifact schema"],
    };
  }
  const issues = (result.issues ?? []).map((issue) =>
    typeof issue === "string"
      ? issue
      : issue.message ?? "Output validation failed",
  );
  return {
    success: result.success,
    value: result.value ?? original,
    issues:
      result.success || issues.length > 0
        ? issues
        : ["Output does not satisfy its artifact schema"],
  };
}

function insideDirectory(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Claude Code's native file tools are provider-specific and powerful. Scope
 * them to the disposable task workspace plus server-ingested attachment roots
 * so an attachment-aware role cannot read arbitrary host files.
 */
function fileAccessHooks(
  config: ClaudeAgentExecutorConfig,
): UnknownRecord {
  const taskRoot = resolve(config.cwd ?? process.cwd());
  const roots = [
    taskRoot,
    ...(config.attachmentRoots ?? []).map((root) => resolve(root)),
  ];
  const hook = async (input: unknown): Promise<UnknownRecord> => {
    const event = record(input);
    if (event.hook_event_name !== "PreToolUse") return { continue: true };
    if (
      event.tool_name !== "Read" &&
      event.tool_name !== "Glob" &&
      event.tool_name !== "Grep"
    ) {
      return { continue: true };
    }
    const toolInput = record(event.tool_input);
    const supplied =
      typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : typeof toolInput.path === "string"
          ? toolInput.path
          : undefined;
    // Glob/Grep without a path default to the already-scoped task workspace.
    if (supplied === undefined) return { continue: true };
    const candidate = isAbsolute(supplied)
      ? supplied
      : resolve(taskRoot, supplied);
    if (roots.some((root) => insideDirectory(root, candidate))) {
      return { continue: true };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "File access is limited to this run's ingested attachments.",
      },
    };
  };
  return {
    PreToolUse: [
      {
        matcher: "Read|Glob|Grep",
        hooks: [hook],
      },
    ],
  };
}

function queryOptions(
  config: ClaudeAgentExecutorConfig,
  task: AgentTask,
  controller: AbortController,
  nativeStructuredOutput: boolean,
): UnknownRecord {
  const tools = allowedTools(task);
  const disallowedTools = KNOWN_BUILTIN_TOOLS.filter(
    (name) => !tools.includes(name),
  );
  const description = task.modelRequest;
  const options: UnknownRecord = {
    abortController: controller,
    allowedTools: tools,
    disallowedTools,
    tools,
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    // Forward the (already-streamed) API deltas so long turns can report
    // content-free heartbeats. This adds no tokens, turns, or API calls.
    includePartialMessages: true,
    maxTurns: config.maxTurns ?? 100,
    effort: config.effort ?? "high",
    thinking:
      config.thinking === "disabled"
        ? { type: "disabled" }
        : { type: "adaptive", display: "omitted" },
    cwd: config.cwd ?? process.cwd(),
    env: sdkEnvironment(config.token, config.env),
    hooks: fileAccessHooks(config),
  };
  if ((config.attachmentRoots?.length ?? 0) > 0) {
    options.additionalDirectories = [...config.attachmentRoots!];
  }
  const model = description?.modelId ?? config.model;
  if (model) options.model = model;
  if (description?.system) options.systemPrompt = description.system;
  if (task.outputSchema && nativeStructuredOutput) {
    options.outputFormat = {
      type: "json_schema",
      schema: agentSdkOutputSchema(task.outputSchema.schema),
    };
  }
  if (config.maxBudgetUsd !== undefined) {
    options.maxBudgetUsd = config.maxBudgetUsd;
  }
  if (config.fallbackModel) options.fallbackModel = config.fallbackModel;
  return options;
}

/** Compact JSON of a rejected output for retry feedback (fresh sessions have no memory of it). */
function rejectedOutputSnippet(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return [];
  }
  const limit = 6000;
  if (text.length > limit) text = `${text.slice(0, limit)}… (truncated)`;
  return ["It returned:", text];
}

async function executeQuery(
  config: ClaudeAgentExecutorConfig,
  task: AgentTask,
  context: AgentExecutionContext,
  validationIssues: readonly string[] = [],
  nativeStructuredOutput = true,
  rejectedOutput: JsonValue | undefined = undefined,
): Promise<AgentResult> {
  assertToken(config.token);
  if (context.signal?.aborted) throw abortError(context.signal.reason);
  if (!task.modelRequest) {
    throw new Error(`Agent task "${task.taskId}" has no model request`);
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const queryFn =
      config.queryFn ??
      ((input: ClaudeAgentQueryInput) =>
        sdkQuery(
          input as Parameters<typeof sdkQuery>[0],
        ) as unknown as ClaudeAgentQuery);
    let finalResult: UnknownRecord | undefined;
    const progressState = newProgressState(config);
    let messageCount = 0;
    for await (const message of queryFn({
      prompt: [
        messagePrompt(task.modelRequest.messages),
        ...(task.outputSchema
          ? [
              "",
              "Your structured output submission is FINAL and recorded verbatim as your answer.",
              'Never submit placeholder, trial, or test values (such as "test" or "ok") to probe the output tool.',
            ]
          : []),
        ...(validationIssues.length > 0
          ? [
              "",
              "A previous session's structured result failed authoritative validation.",
              ...rejectedOutputSnippet(rejectedOutput),
              "Issues:",
              ...validationIssues.map((issue) => `- ${issue}`),
              "Produce a corrected complete result. Do not discuss the validation errors.",
            ]
          : []),
        ...(!nativeStructuredOutput && task.outputSchema
          ? [
              "",
              "Native structured-output transport is unavailable for this attempt.",
              "Return ONLY the complete raw JSON object. Do not use Markdown fences or commentary.",
            ]
          : []),
      ].join("\n"),
      options: queryOptions(config, task, controller, nativeStructuredOutput),
    })) {
      const current = record(message);
      // Stream deltas are progress signals, not conversation turns.
      if (current.type !== "stream_event") messageCount += 1;
      reportSdkMessage(current, context, progressState);
      if (current.type === "result") finalResult = current;
    }
    if (context.signal?.aborted || controller.signal.aborted) {
      throw abortError(context.signal?.reason);
    }
    if (!finalResult) {
      throw new Error("Claude Agent SDK ended without a result message");
    }
    if (finalResult.subtype !== "success" || finalResult.is_error === true) {
      const errors = Array.isArray(finalResult.errors)
        ? finalResult.errors.map(String).join("; ")
        : `Claude Agent SDK ended with ${String(finalResult.subtype)}`;
      throw new Error(errors);
    }
    const output = parseResultOutput(finalResult, task);
    const metadata: JsonObject = {
      executor: "claude-agent-sdk",
      ...(typeof finalResult.session_id === "string"
        ? { sessionId: finalResult.session_id }
        : {}),
      ...(typeof finalResult.num_turns === "number"
        ? { turns: finalResult.num_turns }
        : {}),
      ...(typeof finalResult.total_cost_usd === "number"
        ? { totalCostUsd: finalResult.total_cost_usd }
        : {}),
    };
    progress(context, {
      kind: "validation",
      message: task.outputSchema
        ? "Structured output received; validating artifact"
        : "Agent output received",
      ...(typeof finalResult.num_turns === "number"
        ? { turn: finalResult.num_turns }
        : { turn: messageCount }),
    });
    return {
      taskId: task.taskId,
      status: "ok",
      output,
      usage: usageFromResult(finalResult.usage),
      metadata,
    };
  } finally {
    context.signal?.removeEventListener("abort", onAbort);
  }
}

export class ClaudeAgentExecutor implements AgentExecutor {
  private readonly config: ClaudeAgentExecutorConfig;

  constructor(config: ClaudeAgentExecutorConfig) {
    assertConfig(config);
    this.config = config;
  }

  async execute(
    task: AgentTask,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    const attempts = this.config.maxValidationAttempts ?? 3;
    let validationIssues: string[] = [];
    let rejectedOutput: JsonValue | undefined;
    let usage = emptyUsage();
    let nativeStructuredOutput = true;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const workspace = taskWorkspace(this.config, task, context, attempt);
      try {
        const result = await executeQuery(
          { ...this.config, cwd: workspace },
          task,
          context,
          validationIssues,
          nativeStructuredOutput,
          rejectedOutput,
        );
        if (result.usage) usage = addUsage(usage, result.usage);
        if (
          result.status === "error" ||
          !task.outputSchema ||
          !this.config.outputValidator
        ) {
          return { ...result, usage };
        }
        const checked = await this.config.outputValidator.validate(
          result.output,
          task.outputSchema.schema,
        );
        const normalized = normalizeValidation(checked, result.output);
        if (normalized.success) {
          return {
            ...result,
            output: normalized.value,
            usage,
            metadata: {
              ...(result.metadata ?? {}),
              validationAttempts: attempt,
            },
          };
        }
        validationIssues = normalized.issues;
        rejectedOutput = result.output;
        if (attempt < attempts) {
          progress(context, {
            kind: "validation",
            message: `Artifact validation retry ${attempt}/${attempts - 1}`,
          });
          continue;
        }
        return {
          taskId: task.taskId,
          status: "error",
          error: serializeError(
            new Error(
              `Structured output failed authoritative validation after ${attempts} attempts: ${validationIssues.join("; ")}`,
            ),
          ),
          usage,
        };
      } catch (error) {
        if (
          context.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          throw abortError(context.signal?.reason);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (isCreditLimitMessage(message)) {
          const recovery = this.config.creditRecovery;
          const resolved = recovery?.resolver
            ? await recovery.resolver(message)
            : await resolveCreditReset({
                message,
                now: recovery?.now?.(),
                timeZone: recovery?.timeZone,
                safetyBufferSeconds: recovery?.safetyBufferSeconds,
                openRouterApiKey: recovery?.openRouterApiKey,
                openRouterModel: recovery?.openRouterModel,
              });
          throw new CreditBlockedError(
            resolved.retryAt,
            message,
            resolved.source,
          );
        }
        if (
          task.outputSchema &&
          nativeStructuredOutput &&
          /Failed to provide valid structured output|error_max_structured_output_retries/i.test(
            message,
          ) &&
          attempt < attempts
        ) {
          nativeStructuredOutput = false;
          validationIssues = [
            "The previous native structured-output session exhausted its retries.",
            "Return every required field as raw JSON with the exact requested types.",
          ];
          progress(context, {
            kind: "validation",
            message:
              "Native structured output exhausted; retrying with validated raw JSON",
          });
          continue;
        }
        return {
          taskId: task.taskId,
          status: "error",
          error: serializeError(error),
          usage,
        };
      } finally {
        // No agent writes are canonical. Remove partial scripts/downloads on
        // success, validation retry, provider credit block, or cancellation.
        rmSync(workspace, { recursive: true, force: true });
      }
    }
    throw new Error("unreachable");
  }
}

/** Performs a real one-turn model request; success proves the setup token works. */
export async function validateClaudeSetupToken(
  input: ValidateClaudeSetupTokenInput,
): Promise<void> {
  const controller = new AbortController();
  const timeout =
    input.timeoutMs !== undefined
      ? setTimeout(() => controller.abort("connection validation timed out"), input.timeoutMs)
      : undefined;
  const executor = new ClaudeAgentExecutor({
    token: input.token,
    ...(input.model ? { model: input.model } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.queryFn ? { queryFn: input.queryFn } : {}),
    maxTurns: 1,
  });
  try {
    const result = await executor.execute(
      {
        taskId: "validate-claude-setup-token",
        kind: "connection.validate",
        input: "Reply with OK.",
        modelRequest: {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Reply with OK." }],
            },
          ],
        },
      },
      {
        runId: "connection-validation",
        nodePath: "connection-validation",
        signal: controller.signal,
      },
    );
    if (result.status === "error") {
      throw new Error(result.error.message);
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

