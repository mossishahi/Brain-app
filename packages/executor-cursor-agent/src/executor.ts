/**
 * Cursor SDK executor: runs one semantic agent task through `@cursor/sdk`
 * local agents, authenticated with a Cursor API key.
 *
 * This is the Cursor sibling of @brainstorm-agentic/executor-claude-agent and
 * deliberately mirrors it mechanism for mechanism, because the two backends
 * share ONE settings shape (`llm.agentSdk`: maxTurns, effort, thinking,
 * budget, fallback model) and must behave the same way around the model:
 *
 * - per-attempt disposable task workspaces (no attempt sees another's files);
 * - the stepwise chain tool (`submit_step`) as an in-process custom tool;
 * - structured output via an in-process `submit_result` tool whose input
 *   schema is the task's (narrowed) JSON schema, with validated raw-JSON
 *   salvage as the fallback transport;
 * - the same authoritative post-generation validation loop with corrective
 *   feedback in a fresh session per attempt;
 * - the same credit-block conversion, bounded crash retries, and sanitized
 *   operational progress (never chain-of-thought, prompts, or tool outputs).
 *
 * Effort and thinking map onto Cursor's server-declared per-model parameters
 * (`Cursor.models.list()` definitions), so the SAME settings drive both SDKs
 * and a model asked for through either one runs with equivalent reasoning
 * configuration. Parameters a model does not declare are skipped — exactly
 * like the Claude Agent SDK ignoring effort on models without it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CreditBlockedError,
  addUsage,
  emptyUsage,
  serializeError,
  systemPromptSegments,
  textContent,
  toolCallDetail,
  type AgentExecutionContext,
  type AgentExecutor,
  type AgentProgress,
  type AgentResult,
  type AgentTask,
  type JsonObject,
  type JsonValue,
  type ModelMessage,
  type SystemPrompt,
  type TaxonomyAccess,
  type TokenUsage,
} from "@brainstorm-agentic/core";
import {
  isCreditLimitMessage,
  resolveCreditReset,
  type CreditResetResolution,
} from "@brainstorm-agentic/credit-recovery";
import {
  attachmentTools,
  gpuRunTools,
  ATTACHMENT_LIST_MANIFEST,
  ATTACHMENT_SEARCH_MANIFEST,
  GPU_RUN_MANIFEST,
  type GpuRunConfig,
} from "@brainstorm-agentic/host-tools";

type UnknownRecord = Record<string, unknown>;

/* ------------------------------------------------------------------------ */
/* Structural views of the @cursor/sdk surface this executor drives.         */
/* Declared locally (rather than imported as types) so the SDK module is     */
/* loaded ONLY when the cursor-agent provider actually executes, and so      */
/* tests can drive the executor with plain fakes.                            */
/* ------------------------------------------------------------------------ */

export interface CursorSdkRunResult {
  readonly id?: string;
  readonly status: "finished" | "error" | "cancelled";
  readonly result?: string;
  readonly error?: { readonly message: string; readonly code?: string };
  readonly durationMs?: number;
  readonly usage?: CursorSdkTokenUsage;
}

/**
 * Token usage as the Cursor SDK reports it. `inputTokens` is the WHOLE
 * prompt context: the cache reads and cache writes are counted INSIDE it,
 * with `cacheReadTokens`/`cacheWriteTokens` restating those two subsets.
 * `totalTokens` re-adds the cache fields on top of `inputTokens`, so it
 * double-counts them. Verified against provider billing exports: on every
 * request of a 576-request run, inputTokens == (uncached input) +
 * (cache write) + (cache read). coreUsage() normalizes this shape to the
 * core contract, where the three input parts are disjoint.
 */
export interface CursorSdkTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly reasoningTokens?: number;
}

export interface CursorSdkRun {
  readonly id?: string;
  stream(): AsyncGenerator<UnknownRecord, void> | AsyncIterable<UnknownRecord>;
  wait(): Promise<CursorSdkRunResult>;
  supports?(operation: string): boolean;
  cancel?(): Promise<void>;
}

export interface CursorSdkAgent {
  readonly agentId?: string;
  send(message: string): Promise<CursorSdkRun>;
  close?(): void;
  getUsage?(): Promise<{ readonly cost?: { readonly chargedCents: number } }>;
  [Symbol.asyncDispose]?(): Promise<void>;
}

/** One in-process callback tool, in the SDK's customTools shape. */
export interface CursorSdkCustomTool {
  readonly description?: string;
  readonly inputSchema?: JsonObject;
  execute(
    args: JsonObject,
    context: { readonly toolCallId?: string },
  ): unknown | Promise<unknown>;
}

/** The subset of Agent.create options this executor supplies. */
export interface CursorSdkAgentOptions {
  readonly apiKey: string;
  readonly model: { readonly id: string; readonly params?: readonly { id: string; value: string }[] };
  readonly tools: readonly string[];
  readonly name?: string;
  readonly local: {
    readonly cwd: string;
    readonly dirs?: readonly string[];
    readonly settingSources: readonly string[];
    readonly customTools?: Readonly<Record<string, CursorSdkCustomTool>>;
  };
}

export type CursorAgentFactory = (
  options: CursorSdkAgentOptions,
) => Promise<CursorSdkAgent>;

/** One entry of `Cursor.models.list()`, reduced to what the mapper reads. */
export interface CursorModelListEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
  readonly parameters?: readonly {
    readonly id: string;
    readonly displayName?: string;
    readonly values: readonly { readonly value: string; readonly displayName?: string }[];
  }[];
}

export type CursorModelLister = () => Promise<readonly CursorModelListEntry[]>;

/**
 * The account's live model catalog, for consumers beyond the executor (the
 * server's model picker serves it so users choose from what their key can
 * actually run — every Sonnet/Opus version, GPT, Composer, … — instead of a
 * hardcoded list).
 */
export async function listCursorModels(
  apiKey: string,
): Promise<readonly CursorModelListEntry[]> {
  return defaultListModels(apiKey);
}

/* ------------------------------------------------------------------------ */

export type CursorAgentValidationResult =
  | boolean
  | {
      readonly success: boolean;
      readonly value?: JsonValue;
      readonly issues?: readonly (string | { readonly message?: string })[];
    };

export interface CursorAgentOutputValidator {
  validate(
    value: JsonValue,
    schema: JsonObject,
    /**
     * The task the value answers, so a validator can check what the schema
     * alone cannot — a patch's coherence against the version it revises
     * (AgentTask.revisionBase) — while a retry is still possible.
     */
    task?: AgentTask,
  ): CursorAgentValidationResult | Promise<CursorAgentValidationResult>;
}

export interface CursorAgentExecutorConfig {
  /** Cursor API key (cursor.com/dashboard → Integrations, or a service account). */
  readonly apiKey: string;
  /** Cursor model id/alias. Omit to let the server pick (`auto`). */
  readonly model?: string;
  readonly cwd?: string;
  /** Job-owned attachment directories the built-in read/grep/glob/ls may access. */
  readonly attachmentRoots?: readonly string[];
  /**
   * Shared-taxonomy access. The Cursor SDK has no built-in taxonomy tool, so
   * the read tools are delivered as in-process custom tools to any task whose
   * skill declares the `taxonomy-access` capability.
   */
  readonly taxonomy?: TaxonomyAccess;
  /**
   * GPU run setup. No Cursor built-in submits cluster jobs, so the gpu_run
   * host tool is bridged in-process when the deployment set it up.
   */
  readonly gpuRun?: GpuRunConfig;
  /**
   * Maximum model turns per task, enforced by this executor: the SDK
   * declares no turn ceiling of its own, so the run is cancelled when the
   * count is exceeded — the shared "every loop is bounded" invariant.
   */
  readonly maxTurns?: number;
  /**
   * USD ceiling per task, enforced BETWEEN attempts: Cursor reports billed
   * cost after the fact (eventually consistent), so a retry is refused once
   * the recorded spend reaches the ceiling. It cannot stop a single
   * overlong run mid-flight the way the Claude Agent SDK's native budget
   * does.
   */
  readonly maxBudgetUsd?: number;
  /** Reasoning effort; mapped onto the model's declared effort parameter. */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Adaptive reasoning or no extended thinking; mapped like effort. */
  readonly thinking?: "adaptive" | "disabled";
  /** Model used when the primary model is refused at agent creation. */
  readonly fallbackModel?: string;
  /** Authoritative post-generation validator (constraints JSON Schema cannot express). */
  readonly outputValidator?: CursorAgentOutputValidator;
  /** Full attempts for post-generation validation. Default 3. */
  readonly maxValidationAttempts?: number;
  /**
   * Minimum quiet time before a content-free "model working" heartbeat is
   * reported during long turns. Default 20000 ms; 0 reports on every event
   * (tests only).
   */
  readonly progressHeartbeatMs?: number;
  /**
   * Stall watchdog: when the SDK stream produces NOTHING for this long, the
   * attempt is cancelled locally and restarted through the bounded
   * infrastructure-retry path. Exists because a NAT can silently drop the
   * long-lived upstream connection (Azure's idle timeout is ~4 minutes):
   * the SDK's next write lands in a black hole and the kernel retransmits
   * for ~15 minutes before anything errors — observed in production as a
   * run frozen mid-turn with bytes stuck in Send-Q. A healthy turn streams
   * deltas continuously, so minutes of TOTAL silence is a dead connection,
   * not a thinking model. Default 6 minutes; 0 disables.
   */
  readonly stallTimeoutMs?: number;
  /**
   * Base wait before restarting after an upstream resource_exhausted
   * (scaled by the retry number: 1x, then 2x). A quota window needs time
   * to refill, so restarting immediately re-hits the same empty window.
   * Default 30 seconds; tests set it low.
   */
  readonly quotaRetryDelayMs?: number;
  readonly creditRecovery?: {
    readonly safetyBufferSeconds?: number;
    readonly openRouterApiKey?: string;
    readonly openRouterModel?: string;
    readonly timeZone?: string;
    readonly now?: () => Date;
    readonly resolver?: (message: string) => Promise<CreditResetResolution>;
  };
  /** Parent for per-attempt disposable workspaces. Defaults under os.tmpdir(). */
  readonly taskWorkspaceRoot?: string;
  /** Test seam: replaces `Agent.create`. Production callers omit this. */
  readonly agentFactory?: CursorAgentFactory;
  /** Test seam / catalog override: replaces `Cursor.models.list`. */
  readonly listModels?: CursorModelLister;
}

export interface ValidateCursorApiKeyInput {
  readonly apiKey: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly agentFactory?: CursorAgentFactory;
  readonly listModels?: CursorModelLister;
  readonly timeoutMs?: number;
}

/**
 * Capability id -> Cursor public built-in tool names. The vocabulary is the
 * SDK's `tools` option (the same names its tool_call stream events carry).
 */
const CAPABILITY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "web-search": ["webSearch", "webFetch"],
  "code-execution": ["shell"],
  "attachment-access": ["read", "grep", "glob", "ls"],
};

const LOGICAL_TOOLS: Readonly<Record<string, readonly string[]>> = {
  ...CAPABILITY_TOOLS,
};

/** Built-in names a task may address directly through its tools list. */
const KNOWN_BUILTIN_TOOLS = [
  "read",
  "grep",
  "glob",
  "ls",
  "shell",
  "webSearch",
  "webFetch",
] as const;

/** Route trait that turns on reasoning-trace capture for a task. */
const TRACE_TRAIT = "extended-reasoning";
/**
 * How many times one task restarts after an infrastructure failure the SDK
 * marks retryable (a crashed local runtime, a transport drop) before the
 * failure is real. Separate from validation attempts: a crashed session
 * produced no output to validate.
 */
const MAX_CRASH_RETRIES = 2;

/** Base wait before a resource_exhausted restart (see quotaRetryDelayMs). */
const DEFAULT_QUOTA_RETRY_DELAY_MS = 30_000;

/**
 * How long a run parks when the upstream quota is still empty after the quick
 * retries. Long enough that a refill window has plausibly passed, short enough
 * that a run is not idle for hours; the server resumes it when it comes due,
 * and parks it again if the wall is still there.
 */
const QUOTA_BLOCK_RETRY_MS = 10 * 60_000;

/**
 * How many times one session is asked to hand over its result before the
 * attempt is abandoned.
 *
 * The agent's loop ends when the model stops calling tools, so a model that
 * closes its turn describing what it will do next — "Now let me run my own
 * verification…" — ends the run having submitted nothing. Everything it has
 * worked out is still in that session, so the cheap and accurate move is to ask
 * it to finish rather than discard the session and re-buy the work. Two refusals
 * is a stuck model, and the fresh-session ladder handles that.
 */
const MAX_RESULT_NUDGES = 2;

/** The structured-output transport tool (in-process; input = the task schema). */
const RESULT_TOOL = "submit_result";

/** Stepwise delivery contract mirrored from AgentTask.metadata.stepwise. */
interface StepwiseSpec {
  readonly tool: string;
  readonly field: string;
  readonly count: number;
  readonly sparse?: boolean;
  readonly inject?: JsonObject;
}

interface StepwiseStep {
  readonly index: number;
  readonly text: string;
  readonly turn: number;
}

/** Per-attempt capture state: thinking, chain steps, and the submitted result. */
interface AttemptCapture {
  readonly wantsTrace: boolean;
  readonly thinking: { turn: number; text: string }[];
  readonly stepwise?: {
    readonly spec: StepwiseSpec;
    readonly steps: StepwiseStep[];
  };
  /** The payload of the LAST submit_result call, when the tool exists. */
  submittedResult?: JsonValue;
  turn: number;
  /**
   * The attempt's usage as captured so far. Mirrors executeAttempt's local
   * accumulator so an attempt that THROWS — a parse failure or turn-cap
   * cancel (both after the stream completed), a crash or stall (after part
   * of it) — still hands the tokens it spent to the retry ladder instead of
   * discarding them with the exception. Cleared by the caller once the
   * attempt returns a result (the result then owns the numbers).
   */
  usage?: TokenUsage;
}

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : {};
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
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
    typeof reason === "string" ? reason : "Cursor SDK task cancelled",
  );
  error.name = "AbortError";
  return error;
}

function assertApiKey(apiKey: string): void {
  if (apiKey.trim() === "") {
    throw new Error("Cursor API key must not be empty");
  }
}

function assertConfig(config: CursorAgentExecutorConfig): void {
  assertApiKey(config.apiKey);
  if (
    config.maxTurns !== undefined &&
    (!Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1)
  ) {
    throw new Error("Cursor SDK maxTurns must be a positive integer");
  }
  if (
    config.maxBudgetUsd !== undefined &&
    (!Number.isFinite(config.maxBudgetUsd) || config.maxBudgetUsd <= 0)
  ) {
    throw new Error("Cursor SDK maxBudgetUsd must be positive");
  }
  if (
    config.maxValidationAttempts !== undefined &&
    (!Number.isSafeInteger(config.maxValidationAttempts) ||
      config.maxValidationAttempts < 1)
  ) {
    throw new Error("Cursor SDK maxValidationAttempts must be a positive integer");
  }
  if (
    config.progressHeartbeatMs !== undefined &&
    (!Number.isFinite(config.progressHeartbeatMs) ||
      config.progressHeartbeatMs < 0)
  ) {
    throw new Error("Cursor SDK progressHeartbeatMs must be zero or positive");
  }
}

function stepwiseSpecOf(task: AgentTask): StepwiseSpec | undefined {
  const raw = task.metadata?.stepwise;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as { readonly [key: string]: JsonValue };
  const { tool, field, count, sparse, inject } = value;
  if (typeof tool !== "string" || tool.length === 0) return undefined;
  if (typeof field !== "string" || field.length === 0) return undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    return undefined;
  }
  return {
    tool,
    field,
    count,
    ...(sparse === true ? { sparse: true } : {}),
    ...(typeof inject === "object" && inject !== null && !Array.isArray(inject)
      ? { inject: inject as JsonObject }
      : {}),
  };
}

function routeTraits(task: AgentTask): readonly string[] {
  const input = record(task.input);
  return Array.isArray(input.routeTraits)
    ? input.routeTraits.filter(
        (trait): trait is string => typeof trait === "string",
      )
    : [];
}

/**
 * True when the task may use the capability: the broker plan is the
 * authority when present; tasks without a plan fall back to the declared
 * capability list. Identical to the Claude Agent SDK executor's rule.
 */
function taskUsesCapability(task: AgentTask, capabilityId: string): boolean {
  if (task.capabilityPlan) {
    return task.capabilityPlan.operations.some(
      (operation) =>
        operation.capabilityId === capabilityId &&
        operation.source !== "unavailable",
    );
  }
  return (
    Array.isArray(task.allowedCapabilities) &&
    task.allowedCapabilities.includes(capabilityId)
  );
}

function taskWorkspace(
  config: CursorAgentExecutorConfig,
  task: AgentTask,
  context: AgentExecutionContext,
  attempt: number,
): string {
  const root =
    config.taskWorkspaceRoot ?? join(tmpdir(), "brainstorm-agentic-agent-tasks");
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
  return rendered === "" ? "Complete the task described in the instructions." : rendered;
}

/**
 * The Cursor SDK offers no system-prompt option, so the compiled role
 * instructions lead the prompt as one clearly-marked block. The SDK's own
 * cross-session prefix caching sees the same leading bytes on every call a
 * role makes, so the cacheable boundary the segments declare still holds in
 * spirit; nothing is reordered or trimmed.
 */
function instructionBlock(system: SystemPrompt | undefined): string {
  if (system === undefined) return "";
  const segments = systemPromptSegments(system);
  if (segments.length === 0) return "";
  return `# Instructions\n\n${segments.map((segment) => segment.text).join("\n\n")}\n\n---\n\n`;
}

/**
 * Cursor custom tools reject unions at the input-schema top level exactly
 * like Claude Code's structured-output tool, and the shared converter emits
 * a draft-2020-12 `$schema` the tool layer does not preload. Same treatment
 * as the Claude executor's schema adapter: strip `$schema`, and flatten a
 * top-level object union into one object (common fields required,
 * branch-only fields optional, string const discriminators as enums). The
 * authoritative Zod validation still enforces branch-specific requirements
 * after generation.
 */
export function cursorOutputSchema(schema: JsonObject): JsonObject {
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
          ? new Set(
              branch.required.filter(
                (item): item is string => typeof item === "string",
              ),
            )
          : new Set<string>(),
      )
      .reduce<string[]>(
        (common, current) => common.filter((name) => current.has(name)),
        [...((branches[0]?.required as string[] | undefined) ?? [])],
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

/**
 * Best-effort extraction of one JSON value from the model's final TEXT
 * message (the fallback transport when the submit_result tool was not
 * called). Strictly parsed and JSON-safety-checked: salvage can never invent
 * structure, only find the object that is already there. Kept byte-identical
 * to the Claude executor's salvage so both SDK paths accept the same texts.
 */
export function salvageJsonText(text: string): JsonValue | undefined {
  const candidates: string[] = [];
  const trimmed = text.trim();
  candidates.push(trimmed);
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isJsonValue(parsed)) return parsed;
    } catch {
      // Try the next candidate shape.
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------------ */
/* Model parameter mapping (effort / thinking parity with the Claude path).  */
/* ------------------------------------------------------------------------ */

function normalizeParamText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Preference ladders: the first offered value wins, so a model without
 * "xhigh" degrades to "high" instead of silently dropping the setting, and
 * "max" prefers the strongest offered tier.
 */
const EFFORT_LADDER: Readonly<Record<string, readonly string[]>> = {
  low: ["low", "minimal"],
  medium: ["medium", "standard", "default"],
  high: ["high"],
  xhigh: ["xhigh", "extrahigh", "veryhigh", "high"],
  max: ["max", "maximum", "xhigh", "extrahigh", "high"],
};

const THINKING_OFF_VALUES = ["off", "disabled", "none", "no", "false"];
const THINKING_ON_VALUES = ["adaptive", "auto", "on", "enabled", "true", "thinking"];

/**
 * Maps the shared agent-SDK settings (effort, thinking) onto the selected
 * model's server-declared parameters. Everything is matched against the
 * catalog `Cursor.models.list()` serves: a parameter the model does not
 * declare is skipped, and a value the parameter does not offer degrades
 * along the ladder — the same "apply what the model supports" contract the
 * Claude Agent SDK follows for these settings.
 *
 * Live catalog shapes (probed): Claude-family models declare
 * `effort: low…max` and `thinking: false|true`; GPT/Kimi/GLM-family models
 * carry the effort knob under a parameter literally named `reasoning`
 * (`none…max` / `extra-high`); Gemini/Grok declare `effort` only.
 */
export function resolveModelParams(
  entry: CursorModelListEntry | undefined,
  effort: CursorAgentExecutorConfig["effort"],
  thinking: CursorAgentExecutorConfig["thinking"],
): readonly { id: string; value: string }[] {
  if (!entry?.parameters) return [];
  const params: { id: string; value: string }[] = [];
  const pick = (
    definition: NonNullable<CursorModelListEntry["parameters"]>[number],
    wanted: readonly string[],
  ): string | undefined => {
    const byNormalized = new Map(
      definition.values.map((option) => [normalizeParamText(option.value), option.value]),
    );
    for (const candidate of wanted) {
      const hit = byNormalized.get(candidate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const labelOf = (
    definition: NonNullable<CursorModelListEntry["parameters"]>[number],
  ): string => normalizeParamText(`${definition.id} ${definition.displayName ?? ""}`);
  const thinkingDefinition = entry.parameters.find((definition) =>
    labelOf(definition).includes("thinking"),
  );
  const effortDefinition = entry.parameters.find(
    (definition) =>
      definition !== thinkingDefinition &&
      (labelOf(definition).includes("effort") ||
        labelOf(definition).includes("reasoning")),
  );
  if (thinking !== undefined && thinkingDefinition !== undefined) {
    // "adaptive" pins the on/true tier when the model offers one (the
    // boolean `thinking` parameter of Claude-family models); otherwise the
    // model's own default stands. "disabled" pins the off tier.
    const value = pick(
      thinkingDefinition,
      thinking === "disabled" ? THINKING_OFF_VALUES : THINKING_ON_VALUES,
    );
    if (value !== undefined) params.push({ id: thinkingDefinition.id, value });
  }
  if (effort !== undefined && effortDefinition !== undefined) {
    // GPT/Kimi/GLM-family models fold BOTH knobs into one `reasoning`
    // parameter. An explicit "no extended thinking" wins over effort there:
    // reasoning "none" IS thinking off for those models.
    const wantsOff =
      thinking === "disabled" && thinkingDefinition === undefined;
    const value = wantsOff
      ? (pick(effortDefinition, THINKING_OFF_VALUES) ??
        pick(effortDefinition, EFFORT_LADDER[effort] ?? []))
      : pick(effortDefinition, EFFORT_LADDER[effort] ?? []);
    if (value !== undefined) params.push({ id: effortDefinition.id, value });
  }
  return params;
}

/** Finds a catalog entry by exact id or declared alias. */
export function findModelEntry(
  catalog: readonly CursorModelListEntry[],
  modelId: string,
): CursorModelListEntry | undefined {
  return (
    catalog.find((entry) => entry.id === modelId) ??
    catalog.find((entry) => entry.aliases?.includes(modelId))
  );
}

/* ------------------------------------------------------------------------ */
/* Progress reporting                                                        */
/* ------------------------------------------------------------------------ */

function progress(context: AgentExecutionContext, value: AgentProgress): void {
  context.reportProgress?.(value);
}

function shortText(value: unknown, limit = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact === "") return undefined;
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function toolMessage(name: string, input: unknown): string {
  const args = record(input);
  switch (name) {
    case "webSearch": {
      const query = shortText(args.query ?? args.search);
      return query ? `Searching the web — ${query}` : "Searching the web";
    }
    case "webFetch": {
      const url = shortText(args.url);
      return url ? `Fetching a source — ${url}` : "Fetching a source";
    }
    case "read": {
      const path = shortText(args.path ?? args.file_path);
      return path ? `Reading an input file — ${path}` : "Reading an input file";
    }
    case "glob": {
      const pattern = shortText(args.pattern ?? args.glob_pattern);
      return pattern
        ? `Discovering relevant files — ${pattern}`
        : "Discovering relevant files";
    }
    case "grep": {
      const pattern = shortText(args.pattern ?? args.query);
      return pattern
        ? `Searching within files — ${pattern}`
        : "Searching within files";
    }
    case "ls":
      return "Listing files";
    case "shell":
      return "Running a verification command";
    case "attachment_list":
      return "Listing the attachment inventory";
    case "attachment_search": {
      const query = shortText(args.query);
      return query ? `Searching the attachments — ${query}` : "Searching the attachments";
    }
    case "taxonomy_tree":
      return "Reading the shared taxonomy";
    case "taxonomy_resolve": {
      const query = shortText(args.query);
      return query ? `Resolving a field — ${query}` : "Resolving a field";
    }
    case "gpu_run": {
      const jobName = shortText(args.job_name);
      return jobName ? `Running a GPU job — ${jobName}` : "Running a GPU job";
    }
    case RESULT_TOOL:
      return "Submitting the structured output";
    default:
      return `Using ${name}`;
  }
}

const TOOL_END_LABELS: Readonly<Record<string, string>> = {
  webSearch: "Web search",
  webFetch: "Source fetch",
  read: "File read",
  glob: "File discovery",
  grep: "File search",
  ls: "File listing",
  shell: "Verification command",
  attachment_list: "Attachment inventory",
  attachment_search: "Attachment search",
  taxonomy_tree: "Taxonomy read",
  taxonomy_resolve: "Taxonomy lookup",
  gpu_run: "GPU job",
  [RESULT_TOOL]: "Structured output",
};

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

interface SdkProgressState {
  readonly heartbeatMs: number;
  /** call_id -> start bookkeeping for tool_end durations and detail. */
  readonly pendingTools: Map<
    string,
    { name: string; startedAt: number; detail?: ReturnType<typeof toolCallDetail> }
  >;
  lastEmitAt: number;
}

function newProgressState(config: CursorAgentExecutorConfig): SdkProgressState {
  return {
    heartbeatMs: config.progressHeartbeatMs ?? 20_000,
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
 * Translates SDK stream messages into throttled, content-free progress:
 * tool lifecycle with operational detail, thinking/writing heartbeats, and
 * status lines. Message content is never read beyond types and tool inputs.
 */
function reportSdkMessage(
  message: UnknownRecord,
  context: AgentExecutionContext,
  state: SdkProgressState,
): void {
  const now = Date.now();
  if (message.type === "system" && message.subtype === "init") {
    const model = record(message.model);
    emit(state, context, {
      kind: "status",
      message:
        typeof model.id === "string"
          ? `Agent initialized with ${model.id}`
          : "Agent initialized",
    });
    return;
  }
  if (message.type === "tool_call" && typeof message.name === "string") {
    // Custom in-process tools surface in the stream under the generic name
    // "mcp"; their wrappers already report start/end under their REAL names
    // (submit_step, taxonomy_resolve, …), so the stream event would be a
    // duplicate, anonymous activity row.
    if (message.name === "mcp") return;
    const callId = typeof message.call_id === "string" ? message.call_id : message.name;
    if (message.status === "running") {
      if (state.pendingTools.has(callId)) return; // repeated running updates
      const detail = toolCallDetail(
        message.name,
        isJsonValue(message.args) ? message.args : undefined,
      );
      state.pendingTools.set(callId, {
        name: message.name,
        startedAt: now,
        ...(detail ? { detail } : {}),
      });
      emit(state, context, {
        kind: "tool_start",
        toolName: message.name,
        message: toolMessage(message.name, message.args),
        ...(detail ? { data: { detail: { ...detail } } } : {}),
      });
      return;
    }
    if (message.status === "completed" || message.status === "error") {
      const pending = state.pendingTools.get(callId);
      state.pendingTools.delete(callId);
      const startedAt = pending?.startedAt ?? now;
      const elapsedMs = now - startedAt;
      const name = pending?.name ?? message.name;
      const label = TOOL_END_LABELS[name] ?? name;
      const outcome = message.status === "error" ? "failed" : "finished";
      const remaining = state.pendingTools.size;
      emit(state, context, {
        kind: "tool_end",
        toolName: name,
        elapsedMs,
        // Countable, not merely readable: see AgentProgress.failed.
        ...(message.status === "error" ? { failed: true } : {}),
        message:
          `${label} ${outcome} · ${formatElapsed(elapsedMs)}` +
          (remaining > 0
            ? ` · ${remaining} tool${remaining === 1 ? "" : "s"} still running`
            : ""),
        ...(pending?.detail ? { data: { detail: { ...pending.detail } } } : {}),
      });
    }
    return;
  }
  if (message.type === "thinking") {
    if (now - state.lastEmitAt < state.heartbeatMs) return;
    emit(state, context, { kind: "model", message: "Model reasoning" });
    return;
  }
  if (message.type === "assistant") {
    if (now - state.lastEmitAt < state.heartbeatMs) return;
    emit(state, context, { kind: "model", message: "Composing the response" });
    return;
  }
  if (message.type === "status" && typeof message.status === "string") {
    if (message.status === "RUNNING" || message.status === "CREATING") return;
    emit(state, context, {
      kind: "status",
      message: `Agent ${message.status.toLowerCase()}`,
    });
  }
}

/* ------------------------------------------------------------------------ */
/* In-process custom tools                                                   */
/* ------------------------------------------------------------------------ */

type CustomToolMap = Record<string, CursorSdkCustomTool>;

function toolError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wraps a custom tool's execute so its lifecycle reaches the activity feed
 * with the same shape built-in tools get from the stream. Content-transport
 * tools (submit_step, submit_result) are excluded from the detail channel by
 * toolCallDetail itself.
 */
function reported(
  name: string,
  context: AgentExecutionContext,
  execute: (args: JsonObject) => unknown | Promise<unknown>,
): CursorSdkCustomTool["execute"] {
  return async (args) => {
    const startedAt = Date.now();
    const detail = toolCallDetail(name, isJsonValue(args) ? args : undefined);
    progress(context, {
      kind: "tool_start",
      toolName: name,
      message: toolMessage(name, args),
      ...(detail ? { data: { detail: { ...detail } } } : {}),
    });
    let failed = false;
    try {
      const result = await execute(args);
      failed =
        typeof result === "object" &&
        result !== null &&
        (result as { isError?: unknown }).isError === true;
      return result;
    } catch (error) {
      failed = true;
      return toolError(error instanceof Error ? error.message : String(error));
    } finally {
      const elapsedMs = Date.now() - startedAt;
      progress(context, {
        kind: "tool_end",
        toolName: name,
        elapsedMs,
        ...(failed ? { failed: true } : {}),
        message: `${TOOL_END_LABELS[name] ?? name} ${failed ? "failed" : "finished"} · ${formatElapsed(elapsedMs)}`,
        ...(detail ? { data: { detail: { ...detail } } } : {}),
      });
    }
  };
}

/** The stepwise chain tool, with the exact ordering contract of the Claude path. */
function stepwiseTool(
  spec: StepwiseSpec,
  capture: AttemptCapture,
  context: AgentExecutionContext,
): CursorSdkCustomTool {
  return {
    description: spec.sparse
      ? `Submit one REWRITTEN step of the ${spec.count}-step chain. Call this tool once per ` +
        `step you are changing, in ascending order of index (1 through ${spec.count}), each ` +
        `call carrying exactly one paragraph. Submit only the steps you rewrite: every step ` +
        `you do not submit is carried over unchanged, word for word. At least one step must ` +
        `be submitted before the final structured answer.`
      : `Submit one step of your ${spec.count}-step chain. Call this tool once per step, ` +
        `strictly in order (index 1 through ${spec.count}), each call carrying exactly one ` +
        `paragraph. All ${spec.count} steps must be submitted before the final structured answer.`,
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 1, maximum: spec.count },
        text: { type: "string", minLength: 1 },
      },
      required: ["index", "text"],
      additionalProperties: false,
    },
    execute: reported(spec.tool, context, (args) => {
      const index = args.index;
      const text = args.text;
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 1 ||
        index > spec.count
      ) {
        return toolError(`index must be an integer from 1 to ${spec.count}.`);
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        return toolError("text must carry the step as one non-empty paragraph.");
      }
      const steps = capture.stepwise!.steps;
      if (spec.sparse === true) {
        const last = steps[steps.length - 1];
        if (last !== undefined && index <= last.index) {
          return toolError(
            `Rewritten steps must be submitted in ascending order; step ${last.index} is already submitted.`,
          );
        }
        steps.push({ index, text, turn: capture.turn });
        return { ok: true, recorded: index, rewritten: steps.length };
      }
      const expected = steps.length + 1;
      if (expected > spec.count) {
        return toolError(
          `All ${spec.count} steps are already submitted; return the final structured answer now.`,
        );
      }
      if (index !== expected) {
        return toolError(
          `Steps must be submitted strictly in order; expected index ${expected} next.`,
        );
      }
      steps.push({ index: expected, text, turn: capture.turn });
      return { ok: true, recorded: expected, remaining: spec.count - expected };
    }),
  };
}

/**
 * The structured-output transport: one in-process tool whose input schema IS
 * the task's (narrowed) JSON schema, so Cursor's constrained tool-calling
 * plays the role Claude Code's StructuredOutput tool plays. The recorded
 * payload is authoritative; a repeated call replaces the previous submission
 * (the LAST answer is the answer, mirroring a re-emitted final message).
 */
function resultTool(
  schema: JsonObject,
  capture: AttemptCapture,
  context: AgentExecutionContext,
): CursorSdkCustomTool {
  return {
    description:
      "Submit your final structured answer as this tool's arguments — one call, the complete " +
      "JSON object satisfying the schema. The submission is FINAL and recorded verbatim as " +
      "your answer. Never submit placeholder, trial, or test values.",
    inputSchema: cursorOutputSchema(schema),
    execute: reported(RESULT_TOOL, context, (args) => {
      if (!isJsonValue(args)) {
        return toolError("the submitted result must be a JSON object");
      }
      capture.submittedResult = structuredClone(args);
      return { ok: true, recorded: true };
    }),
  };
}

/** Shared-taxonomy READ tools (reads only, like every executor path). */
function taxonomyCustomTools(
  taxonomy: TaxonomyAccess,
  context: AgentExecutionContext,
): CustomToolMap {
  return {
    taxonomy_tree: {
      description:
        "Fetch the complete CURRENT shared scientific taxonomy as a names-only " +
        "indented outline (no indent = domain, one = field, two = subfield, " +
        "three = topic), stamped with the live revision it was read at. " +
        "Optionally pass `root` (an exact node name) to fetch one branch. " +
        "Read it in full before deciding any placement.",
      inputSchema: {
        type: "object",
        properties: { root: { type: "string" } },
        additionalProperties: false,
      },
      execute: reported("taxonomy_tree", context, async (args) => {
        const root =
          typeof args.root === "string" && args.root.trim() !== ""
            ? args.root
            : undefined;
        return (await taxonomy.tree(root)) as unknown as JsonValue;
      }),
    },
    taxonomy_resolve: {
      description:
        "Resolve one field name against the shared taxonomy at its latest " +
        "revision. Returns the exact position when the name (or a curated " +
        "alias) exists, otherwise NA with candidate node names. Use it to " +
        "check whether a field you are about to place already exists under " +
        "another spelling.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          optionLimit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: reported("taxonomy_resolve", context, async (args) => {
        if (typeof args.query !== "string" || args.query.trim() === "") {
          return toolError("taxonomy_resolve requires a non-empty query string");
        }
        return (await taxonomy.resolve(
          args.query,
          typeof args.optionLimit === "number" ? args.optionLimit : undefined,
        )) as unknown as JsonValue;
      }),
    },
  };
}

/**
 * Deterministic attachment tools over the job's ingested roots. Reading file
 * CONTENT stays on Cursor's built-in read tool; enumerating and locating are
 * deterministic host work, exactly as on the Claude path.
 */
function attachmentCustomTools(
  roots: readonly string[],
  context: AgentExecutionContext,
): CustomToolMap {
  const tools = new Map(
    attachmentTools(roots).map((tool) => [tool.definition.name, tool]),
  );
  const call = async (name: string, args: JsonObject): Promise<unknown> => {
    const tool = tools.get(name);
    if (!tool) return toolError(`tool "${name}" is not available`);
    const result = await tool.execute(args as JsonValue, { runId: "cursor-agent-sdk" });
    if (result.isError === true) {
      return toolError(
        typeof result.output === "string" ? result.output : JSON.stringify(result.output),
      );
    }
    return result.output;
  };
  return {
    attachment_list: {
      description: ATTACHMENT_LIST_MANIFEST.definition.description ?? "",
      inputSchema: {
        type: "object",
        properties: {
          prefix: { type: "string" },
          shape: { type: "string", enum: ["flat", "tree"] },
        },
        additionalProperties: false,
      },
      execute: reported("attachment_list", context, (args) =>
        call("attachment_list", args),
      ),
    },
    attachment_search: {
      description: ATTACHMENT_SEARCH_MANIFEST.definition.description ?? "",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          regex: { type: "boolean" },
          caseSensitive: { type: "boolean" },
          prefix: { type: "string" },
          filesOnly: { type: "boolean" },
          maxResults: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: reported("attachment_search", context, (args) =>
        call("attachment_search", args),
      ),
    },
  };
}

/** The gpu_run host tool bridged in-process (bug-report-to-submitter contract). */
function gpuCustomTools(
  config: GpuRunConfig,
  context: AgentExecutionContext,
): CustomToolMap {
  const [tool] = gpuRunTools(config);
  return {
    gpu_run: {
      description: GPU_RUN_MANIFEST.definition.description ?? "",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string", minLength: 1 },
          time_limit_minutes: { type: "integer", minimum: 1 },
          job_name: { type: "string" },
        },
        required: ["script"],
        additionalProperties: false,
      },
      execute: reported("gpu_run", context, async (args) => {
        const result = await tool!.execute(args as JsonValue, {
          runId: "cursor-agent-sdk",
        });
        if (result.isError === true) {
          return toolError(
            typeof result.output === "string"
              ? result.output
              : JSON.stringify(result.output),
          );
        }
        return result.output;
      }),
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Built-in tool selection                                                   */
/* ------------------------------------------------------------------------ */

function allowedBuiltinTools(task: AgentTask): string[] {
  const tools = new Set<string>();
  if (task.capabilityPlan) {
    for (const op of task.capabilityPlan.operations) {
      if (op.source === "unavailable") continue;
      const capTools = CAPABILITY_TOOLS[op.capabilityId];
      if (capTools) for (const name of capTools) tools.add(name);
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

/* ------------------------------------------------------------------------ */
/* Usage mapping                                                             */
/* ------------------------------------------------------------------------ */

function coreUsage(value: CursorSdkTokenUsage | undefined): TokenUsage {
  if (!value) return emptyUsage();
  const rawInput = typeof value.inputTokens === "number" ? value.inputTokens : 0;
  const outputTokens = typeof value.outputTokens === "number" ? value.outputTokens : 0;
  const cacheRead =
    typeof value.cacheReadTokens === "number" ? value.cacheReadTokens : undefined;
  const cacheWrite =
    typeof value.cacheWriteTokens === "number" ? value.cacheWriteTokens : undefined;
  // Normalize to the core contract, which every other backend follows
  // (the Anthropic Messages and Claude Agent mappings both take the API's
  // cache-EXCLUSIVE input_tokens): the SDK counts cache reads and writes
  // inside inputTokens, so they are subtracted back out here, leaving the
  // three input parts disjoint. The SDK's totalTokens is ignored for the
  // same reason — it re-adds the cache fields inputTokens already carried,
  // which inflated recorded totals to ~1.8x what the provider billed.
  const inputTokens = Math.max(0, rawInput - (cacheRead ?? 0) - (cacheWrite ?? 0));
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
    ...(typeof value.reasoningTokens === "number"
      ? { reasoningTokens: value.reasoningTokens }
      : {}),
  };
}

/**
 * The best estimate from two partial views of one attempt's usage: the sum
 * of the streamed `usage` messages, and the terminal result's cumulative
 * report. Some runtimes omit one or the other, and either can miss the tail
 * of a session (observed against provider billing: a final API call absent
 * from both). Component-wise max never double-counts and never drops the
 * larger view of a component; totalTokens is recomputed from the disjoint
 * parts, matching coreUsage().
 */
function mergeUsageEstimates(a: TokenUsage, b: TokenUsage): TokenUsage {
  const opt = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : Math.max(x ?? 0, y ?? 0);
  const inputTokens = Math.max(a.inputTokens, b.inputTokens);
  const outputTokens = Math.max(a.outputTokens, b.outputTokens);
  const cacheRead = opt(a.cacheReadInputTokens, b.cacheReadInputTokens);
  const cacheWrite = opt(a.cacheWriteInputTokens, b.cacheWriteInputTokens);
  const reasoning = opt(a.reasoningTokens, b.reasoningTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/* ------------------------------------------------------------------------ */
/* Error classification                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Whether an error thrown by the SDK is transient infrastructure worth a
 * bounded in-place restart (a crashed local runtime, a dropped transport, a
 * retryable backend hiccup) — the Cursor analogue of a crashed Claude Code
 * subprocess. The SDK stamps `isRetryable` on its error objects.
 */
function isRetryableInfrastructure(error: unknown): boolean {
  const value = record(error);
  if (value.isRetryable === true) return true;
  if (isResourceExhausted(error)) return true;
  if (isTransientAuth(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /local runtime (?:crashed|exited|terminated)|transport (?:closed|error)|ECONNRESET|socket hang up/i.test(
    message,
  );
}

/**
 * A 401 from the Cursor backend mid-run.
 *
 * Treated as infrastructure, not as a verdict on the credential, because that is
 * what the evidence says: one overnight run took four of these HOURS apart
 * ("Authentication error If you are logged in, try logging out and back in.")
 * while authenticating successfully before and after each one, and each killed a
 * redeveloper task and with it the whole run. A token exchange that fails and
 * then works again is a hiccup; a revoked key fails every attempt and still
 * surfaces, because the restarts are bounded and the message below names the fix.
 *
 * Recognized structurally where the SDK gives us structure — it raises a typed
 * `AuthenticationError` carrying `status: 401` — and by message otherwise, since
 * errors reach us wrapped and re-serialized across process boundaries.
 */
function isTransientAuth(error: unknown): boolean {
  const value = record(error);
  if (value.status === 401) return true;
  if (typeof value.name === "string" && value.name === "AuthenticationError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /authentication error|unauthenticated|not logged in|logging out and back in/i.test(
    message,
  );
}

/**
 * Upstream quota/rate exhaustion ("[resource_exhausted] Error"). Transient
 * by nature — the window refills — but unlike a crash it needs TIME, not a
 * fresh session: an immediate restart re-hits the same empty window, which
 * is exactly how an overnight run turned one 07:08 quota dip into a failed
 * task. Classified retryable, with a bounded wait before the restart.
 */
function isResourceExhausted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /resource_exhausted/i.test(message);
}

/** Signal-aware pause for the quota-retry wait; aborts reject immediately. */
function delayForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------------ */
/* One attempt                                                               */
/* ------------------------------------------------------------------------ */

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

async function defaultAgentFactory(
  options: CursorSdkAgentOptions,
): Promise<CursorSdkAgent> {
  const sdk = (await import("@cursor/sdk")) as unknown as {
    Agent: { create(options: unknown): Promise<CursorSdkAgent> };
  };
  return sdk.Agent.create(options);
}

async function defaultListModels(apiKey: string): Promise<readonly CursorModelListEntry[]> {
  const sdk = (await import("@cursor/sdk")) as unknown as {
    Cursor: {
      models: { list(options?: { apiKey?: string }): Promise<readonly CursorModelListEntry[]> };
    };
  };
  return sdk.Cursor.models.list({ apiKey });
}

interface AttemptOutcome {
  readonly result: AgentResult;
  readonly turns: number;
  /** Billed USD for this attempt's agent, when the backend reported it yet. */
  readonly costUsd?: number;
}

async function executeAttempt(
  config: CursorAgentExecutorConfig,
  task: AgentTask,
  context: AgentExecutionContext,
  capture: AttemptCapture,
  workspace: string,
  modelSelection: CursorSdkAgentOptions["model"],
  validationIssues: readonly string[],
  nativeStructuredOutput: boolean,
  rejectedOutput: JsonValue | undefined,
): Promise<AttemptOutcome> {
  assertApiKey(config.apiKey);
  if (context.signal?.aborted) throw abortError(context.signal.reason);
  if (!task.modelRequest) {
    throw new Error(`Agent task "${task.taskId}" has no model request`);
  }

  const wantsTaxonomy = config.taxonomy !== undefined && taskUsesCapability(task, "taxonomy-access");
  const wantsAttachments =
    (config.attachmentRoots?.length ?? 0) > 0 &&
    taskUsesCapability(task, "attachment-access");
  const wantsGpu = config.gpuRun !== undefined && taskUsesCapability(task, "gpu-execution");

  const customTools: CustomToolMap = {
    ...(capture.stepwise !== undefined
      ? { [capture.stepwise.spec.tool]: stepwiseTool(capture.stepwise.spec, capture, context) }
      : {}),
    ...(task.outputSchema && nativeStructuredOutput
      ? { [RESULT_TOOL]: resultTool(task.outputSchema.schema, capture, context) }
      : {}),
    ...(wantsTaxonomy ? taxonomyCustomTools(config.taxonomy!, context) : {}),
    ...(wantsAttachments ? attachmentCustomTools(config.attachmentRoots!, context) : {}),
    ...(wantsGpu ? gpuCustomTools(config.gpuRun!, context) : {}),
  };
  const hasCustomTools = Object.keys(customTools).length > 0;
  const builtinTools = allowedBuiltinTools(task);
  // Exact allowlist semantics: only the listed tools are offered, so
  // everything outside the task's capabilities (edit/write/task/todo tools)
  // is off — the same posture as the Claude path's disallowedTools. "mcp"
  // is the capability group that carries the in-process custom tools.
  const tools = [...builtinTools, ...(hasCustomTools ? ["mcp"] : [])];

  const promptParts: string[] = [
    instructionBlock(task.modelRequest.system) + messagePrompt(task.modelRequest.messages),
    ...(task.outputSchema && nativeStructuredOutput
      ? [
          "",
          `When your work is complete, submit your final structured answer by calling the ${RESULT_TOOL} tool ` +
            "exactly once with the COMPLETE JSON object as its arguments — never as plain text.",
          "Your structured output submission is FINAL and recorded verbatim as your answer.",
          'Never submit placeholder, trial, or test values (such as "test" or "ok") to probe the output tool.',
        ]
      : []),
    ...(wantsAttachments
      ? [
          "",
          "File access is limited to this run's task workspace and ingested attachments; never " +
            "read or write anything else on this machine. Enumerating and locating attachment " +
            "content is deterministic host work: use the attachment_list tool for the inventory " +
            "and the attachment_search tool to find where something is mentioned across every " +
            "attached file in one call. Do not re-derive these with shell loops " +
            "(`for f in ...; do cat/sed ...`) or by reading files one by one to look for a term — " +
            "read a file's content only once you know you need that file, and reserve script " +
            "execution for actual computation.",
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
          "Structured-output tool transport is unavailable for this attempt.",
          "End with ONLY the complete raw JSON object as your final message. Do not use Markdown fences or commentary.",
        ]
      : []),
  ];

  const factory = config.agentFactory ?? defaultAgentFactory;
  const agent = await factory({
    apiKey: config.apiKey,
    model: modelSelection,
    tools,
    name: task.kind,
    local: {
      cwd: workspace,
      // Attachment roots join the workspace folders so the built-in
      // read/grep/glob/ls tools can reach the job's ingested files.
      ...(config.attachmentRoots?.length
        ? { dirs: [...config.attachmentRoots] }
        : {}),
      // Inline configuration only: a service must never inherit the host
      // user's ambient Cursor rules, skills, or MCP servers.
      settingSources: [],
      ...(hasCustomTools ? { customTools } : {}),
    },
  });

  const maxTurns = config.maxTurns ?? 100;
  let run: CursorSdkRun | undefined;
  let cancelled: "signal" | "turns" | "stall" | undefined;
  const cancelRun = (why: "signal" | "turns" | "stall"): void => {
    cancelled ??= why;
    if (run && (run.supports?.("cancel") ?? true)) {
      void run.cancel?.().catch(() => undefined);
    }
  };
  const onAbort = (): void => cancelRun("signal");
  context.signal?.addEventListener("abort", onAbort, { once: true });

  // The stall watchdog: cancel locally when the stream goes silent for the
  // configured window, and REJECT the awaits that a dead connection can
  // wedge (send, wait) so the attempt always reaches the retry path. The
  // stall error is marked retryable, which routes it into the bounded
  // infrastructure-restart lane rather than failing the task.
  const stallMs = config.stallTimeoutMs ?? 6 * 60_000;
  let lastStreamActivityAt = Date.now();
  let stallTimer: NodeJS.Timeout | undefined;
  let stallArmedAt = 0;
  let rejectOnStall: ((error: Error) => void) | undefined;
  const stallSignal = new Promise<never>((_, reject) => {
    rejectOnStall = reject;
  });
  // A raced-out promise must never surface as an unhandled rejection.
  stallSignal.catch(() => undefined);
  const stallError = (): Error =>
    Object.assign(
      new Error(
        `Cursor SDK stream produced no activity for ${Math.round(
          (Date.now() - lastStreamActivityAt) / 1000,
        )}s — a half-dead upstream connection (NAT idle drop); restarting the task`,
      ),
      { isRetryable: true },
    );
  // One REFERENCED deadline timer, re-armed on stream activity and cleared
  // in the finally below. Referenced deliberately: in a fully wedged state
  // this timer can be the only live handle, and an unref'd watchdog lets
  // the event loop drain mid-race instead of firing (caught by CI). It
  // cannot outlive the attempt — cleanup always clears it.
  const armStallTimer = (delayMs: number = stallMs): void => {
    if (stallMs <= 0 || cancelled !== undefined) return;
    const now = Date.now();
    // Re-arming per streamed fragment would churn a timer per delta; a
    // 1-second arming granularity costs at most that much deadline drift.
    if (stallTimer !== undefined && now - stallArmedAt < 1_000) return;
    stallArmedAt = now;
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (cancelled !== undefined) return;
      const quietForMs = Date.now() - lastStreamActivityAt;
      if (quietForMs <= stallMs) {
        // Activity arrived since the last (throttled) re-arm. Sleep only the
        // REMAINDER of the quiet window — re-arming for a full window here
        // would let detection latency drift toward 2x stallMs when the wedge
        // begins right after a re-arm (observed in production: a 6-minute
        // watchdog firing ~12 minutes after the last delta).
        stallTimer = undefined;
        stallArmedAt = 0; // bypass the arming throttle for this re-arm
        armStallTimer(stallMs - quietForMs + 50);
        return;
      }
      cancelRun("stall");
      rejectOnStall?.(stallError());
    }, delayMs);
  };
  armStallTimer();
  try {
    const progressState = newProgressState(config);
    // Turn accounting. The stream is FRAGMENTS: one model turn arrives as
    // many `assistant` and `thinking` delta messages (a single probed turn
    // carried 8 and 14 of them), so counting those exploded a one-minute
    // task into "100 turns" and cancelled it. The real round markers are
    // `tool_call` starts (one per tool round — each is a model API
    // round-trip) and `usage` (one per completed send), which together
    // approximate the same "tool/API round-trips" the shared maxTurns
    // setting means on the Claude Agent SDK.
    //
    // Declared out here because a session may take more than one send (see
    // the result nudge below): turns and usage accumulate across all of them,
    // so a follow-up can never slip past the configured ceiling.
    let toolRounds = 0;
    const countedToolCalls = new Set<string>();
    let usageTurns = 0;
    let usage = emptyUsage();
    /** Whether the current thinking block is still streaming deltas. */
    let thinkingOpen = false;
    const enforceTurnCap = (): void => {
      if (toolRounds + usageTurns > maxTurns && cancelled === undefined) {
        cancelRun("turns");
      }
    };

    /** Sends one turn and drains its stream, returning the terminal result. */
    const sendAndConsume = async (prompt: string): Promise<CursorSdkRunResult> => {
      run = await Promise.race([agent.send(prompt), stallSignal]);
      if (context.signal?.aborted) cancelRun("signal");
      // Manual iteration so the stall signal can interrupt a read blocked on
      // a dead connection: run.cancel() cannot be relied on to end a
      // generator whose upstream socket is a black hole.
      const stream = run.stream();
      const iterator = (
        stream as AsyncIterable<UnknownRecord>
      )[Symbol.asyncIterator]();
      while (true) {
        const step = await Promise.race([iterator.next(), stallSignal]);
        if (step.done === true) break;
        const rawMessage = step.value;
        lastStreamActivityAt = Date.now();
        armStallTimer();
        const message = record(rawMessage);
        if (message.type === "tool_call" && message.status === "running") {
          const callId =
            typeof message.call_id === "string"
              ? message.call_id
              : `round-${toolRounds}`;
          if (!countedToolCalls.has(callId)) {
            countedToolCalls.add(callId);
            toolRounds += 1;
            enforceTurnCap();
          }
        }
        if (message.type === "usage") {
          usageTurns += 1;
          usage = addUsage(usage, coreUsage(message.usage as CursorSdkTokenUsage));
          capture.usage = usage;
          enforceTurnCap();
        }
        capture.turn = toolRounds + usageTurns + 1;
        if (message.type === "thinking") {
          // Thinking arrives as DELTAS; an empty delta separates blocks.
          // Consecutive fragments concatenate into one trace segment so the
          // captured reasoning summary reads as prose, not confetti.
          const text = typeof message.text === "string" ? message.text : "";
          // Live text gets every delta, whether or not this route captures a
          // trace: a reader watching a task that runs for minutes reads along
          // with it. The host owns the thread — appending the fragments, then
          // discarding them when the output lands — so nothing accumulates here.
          if (text.length > 0) context.reportLive?.(text);
          if (text.length === 0) {
            thinkingOpen = false;
          } else if (capture.wantsTrace) {
            const last = capture.thinking[capture.thinking.length - 1];
            if (thinkingOpen && last !== undefined) {
              last.text += text;
            } else {
              capture.thinking.push({ turn: capture.turn, text });
              thinkingOpen = true;
            }
          }
        } else {
          thinkingOpen = false;
        }
        reportSdkMessage(message, context, progressState);
      }
      const result = await Promise.race([run.wait(), stallSignal]);
      if (result.usage) {
        // The terminal result's usage is cumulative when reported, and some
        // runtimes emit only it (or only the streamed messages, or miss a
        // session's tail in both): take the component-wise best estimate.
        // Merged BEFORE the throw checks below, so a cancelled or errored run
        // that still reported usage hands its spend to the retry ladder
        // through the capture instead of losing it with the exception.
        usage = mergeUsageEstimates(usage, coreUsage(result.usage));
        capture.usage = usage;
      }
      // Asserted per SEND, not once per attempt: a stall or a turn-ceiling
      // cancel during a follow-up must surface as itself. Reported as "no
      // structured JSON" it would send the ladder down the wrong lane and
      // describe a wedged connection as a model that answered badly.
      if (cancelled === "signal" || context.signal?.aborted) {
        throw abortError(context.signal?.reason);
      }
      if (cancelled === "stall") {
        throw stallError();
      }
      if (cancelled === "turns") {
        throw new Error(
          `Cursor SDK task exceeded the configured maximum of ${maxTurns} turns and was cancelled`,
        );
      }
      if (result.status === "cancelled") {
        throw abortError();
      }
      if (result.status === "error") {
        throw new Error(
          result.error?.message ?? "Cursor SDK run ended with an error",
        );
      }
      return result;
    };

    let finalResult = await sendAndConsume(promptParts.join("\n"));
    let turns = toolRounds + usageTurns;

    /**
     * The result this send produced, or undefined when the session ended
     * without one.
     */
    const resultOf = (result: CursorSdkRunResult): JsonValue | undefined => {
      if (capture.submittedResult !== undefined) return capture.submittedResult;
      const text = typeof result.result === "string" ? result.result : "";
      return salvageJsonText(text);
    };

    let output: JsonValue | undefined;
    if (task.outputSchema !== undefined) {
      output = resultOf(finalResult);
      /**
       * The agent's loop ends when the model stops calling tools, so a model
       * that finishes its turn narrating its next move — "Now let me run my own
       * verification…" — ends the run successfully having submitted nothing.
       * Its work is all still there in the session, so ASK IT to finish: the
       * alternative (and what happened before) is to throw the session away and
       * re-buy a redevelopment's literature review from scratch on the next
       * attempt, which can fail the same way and take the run down with it.
       *
       * Bounded, and the turn ceiling still applies across sends: a model that
       * ignores two explicit requests is genuinely stuck, and the fresh-session
       * ladder below is the right answer then.
       */
      for (
        let nudge = 0;
        output === undefined && nudge < MAX_RESULT_NUDGES;
        nudge += 1
      ) {
        progress(context, {
          kind: "retry",
          message: `Session ended without a result; asking for it (${nudge + 1}/${MAX_RESULT_NUDGES})`,
          turn: turns,
        });
        finalResult = await sendAndConsume(
          nativeStructuredOutput
            ? "You ended your turn without submitting a result. Do not start new work and do not " +
                "explain: call the submit_result tool now with the complete result for the task above."
            : "You ended your turn without producing a result. Do not start new work and do not " +
                "explain: reply with ONLY the complete raw JSON object for the task above.",
        );
        turns = toolRounds + usageTurns;
        output = resultOf(finalResult);
      }
      if (output === undefined) {
        const text = typeof finalResult.result === "string" ? finalResult.result : "";
        const head = text.slice(0, 400).replace(/\s+/g, " ");
        const tail = text.length > 700 ? text.slice(-200).replace(/\s+/g, " ") : "";
        throw new Error(
          `Cursor SDK did not return valid structured JSON (final message: ${text.length} chars). ` +
            `Head: ${head}${tail ? ` … Tail: ${tail}` : ""}`,
        );
      }
    } else {
      output = typeof finalResult.result === "string" ? finalResult.result : "";
    }

    progress(context, {
      kind: "validation",
      message: task.outputSchema
        ? "Structured output received; validating artifact"
        : "Agent output received",
      turn: turns,
    });
    // Billed cost is server-derived and eventually consistent; read it once
    // per attempt (never load-bearing — the budget check treats an absent
    // figure as "not yet reported").
    let costUsd: number | undefined;
    try {
      const reported = await agent.getUsage?.();
      const cents = reported?.cost?.chargedCents;
      if (typeof cents === "number" && Number.isFinite(cents) && cents >= 0) {
        costUsd = cents / 100;
      }
    } catch {
      // Cost reporting must never affect the task outcome.
    }
    const metadata: JsonObject = {
      executor: "cursor-agent-sdk",
      ...(typeof agent.agentId === "string" ? { agentId: agent.agentId } : {}),
      ...(typeof run?.id === "string" ? { runId: run.id } : {}),
      turns,
      ...(typeof finalResult.durationMs === "number"
        ? { durationMs: finalResult.durationMs }
        : {}),
      ...(costUsd !== undefined ? { totalCostUsd: costUsd } : {}),
    };
    return {
      // Defined by construction: the schema branch throws above when no result
      // could be obtained, and the schemaless branch always assigns a string.
      result: { taskId: task.taskId, status: "ok", output: output as JsonValue, usage, metadata },
      turns,
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  } finally {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    context.signal?.removeEventListener("abort", onAbort);
    try {
      await agent[Symbol.asyncDispose]?.();
    } catch {
      // Disposal is cleanup; it must never mask the task outcome.
    }
    if (!agent[Symbol.asyncDispose]) agent.close?.();
  }
}

/* ------------------------------------------------------------------------ */
/* Executor                                                                  */
/* ------------------------------------------------------------------------ */

function normalizeValidation(
  result: CursorAgentValidationResult,
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
    typeof issue === "string" ? issue : issue.message ?? "Output validation failed",
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

export class CursorAgentExecutor implements AgentExecutor {
  private readonly config: CursorAgentExecutorConfig;
  /** One models.list() per executor; a failed fetch quietly means "no params". */
  private catalogPromise: Promise<readonly CursorModelListEntry[]> | undefined;

  constructor(config: CursorAgentExecutorConfig) {
    assertConfig(config);
    this.config = config;
  }

  private catalog(): Promise<readonly CursorModelListEntry[]> {
    this.catalogPromise ??= (
      this.config.listModels?.() ?? defaultListModels(this.config.apiKey)
    ).catch(() => [] as readonly CursorModelListEntry[]);
    return this.catalogPromise;
  }

  /**
   * The model selection one task runs with: the compiler-resolved model id
   * (per-route settings) or the configured default, with the shared effort
   * and thinking settings mapped onto the model's declared parameters.
   */
  private async modelSelection(
    task: AgentTask,
    modelOverride?: string,
  ): Promise<CursorSdkAgentOptions["model"]> {
    const id =
      modelOverride ?? task.modelRequest?.modelId ?? this.config.model ?? "auto";
    const entry = findModelEntry(await this.catalog(), id);
    const params = resolveModelParams(entry, this.config.effort, this.config.thinking);
    return { id, ...(params.length > 0 ? { params: [...params] } : {}) };
  }

  async execute(
    task: AgentTask,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    const attempts = this.config.maxValidationAttempts ?? 3;
    const stepwise = stepwiseSpecOf(task);
    if (task.capabilityPlan !== undefined) {
      progress(context, {
        kind: "status",
        message: "Capability plan resolved",
        data: {
          capabilityPlan: task.capabilityPlan.operations.map((operation) => ({
            operation: operation.operationId,
            capability: operation.capabilityId,
            source: operation.source,
            tools: [...operation.toolNames],
          })),
        },
      });
    }
    const wantsTrace =
      routeTraits(task).includes(TRACE_TRAIT) && this.config.thinking !== "disabled";
    let validationIssues: string[] = [];
    let rejectedOutput: JsonValue | undefined;
    let usage = emptyUsage();
    let nativeStructuredOutput = true;
    let crashRetries = 0;
    let usedFallbackModel = false;
    let spentUsd = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // Budget is enforced BETWEEN attempts (billed cost is reported after
      // the fact): once the recorded spend reaches the ceiling, no further
      // attempt starts. The Claude SDK enforces the same setting natively
      // mid-run; this is the closest bound Cursor's reporting allows.
      if (
        this.config.maxBudgetUsd !== undefined &&
        attempt > 1 &&
        spentUsd >= this.config.maxBudgetUsd
      ) {
        return {
          taskId: task.taskId,
          status: "error",
          error: serializeError(
            new Error(
              `Cursor SDK task reached its ${this.config.maxBudgetUsd.toFixed(2)} USD budget ` +
                `after ${attempt - 1} attempt(s); not retrying`,
            ),
          ),
          usage,
        };
      }
      const workspace = taskWorkspace(this.config, task, context, attempt);
      const capture: AttemptCapture = {
        wantsTrace,
        thinking: [],
        ...(stepwise !== undefined ? { stepwise: { spec: stepwise, steps: [] } } : {}),
        turn: 0,
      };
      try {
        const selection = await this.modelSelection(
          task,
          usedFallbackModel ? this.config.fallbackModel : undefined,
        );
        const { result, costUsd } = await executeAttempt(
          { ...this.config, cwd: workspace },
          task,
          context,
          capture,
          workspace,
          selection,
          validationIssues,
          nativeStructuredOutput,
          rejectedOutput,
        );
        // The attempt returned: result.usage owns its numbers now, so the
        // in-flight capture must not be harvested again by the catch below
        // (a later throw in validation would otherwise double-count).
        capture.usage = undefined;
        if (costUsd !== undefined) spentUsd += costUsd;
        if (result.usage) usage = addUsage(usage, result.usage);
        if (result.status === "error") {
          return { ...result, usage };
        }
        let output = result.output;
        if (stepwise !== undefined) {
          const steps = capture.stepwise!.steps;
          const delivered =
            stepwise.sparse === true ? steps.length >= 1 : steps.length === stepwise.count;
          if (!delivered) {
            validationIssues = [
              stepwise.sparse === true
                ? `At least one rewritten step must be submitted through the ${stepwise.tool} ` +
                  `tool before the final answer; none were received. Submit every step your ` +
                  `repair changes, then return the final answer.`
                : `Exactly ${stepwise.count} steps must be submitted through the ${stepwise.tool} ` +
                  `tool before the final answer; ${steps.length} were received. Submit every step ` +
                  `in order, then return the complete final answer.`,
            ];
            rejectedOutput = result.output;
            if (attempt < attempts) {
              progress(context, {
                kind: "validation",
                message: `Stepwise delivery retry ${attempt}/${attempts - 1}`,
              });
              continue;
            }
            return {
              taskId: task.taskId,
              status: "error",
              error: serializeError(
                new Error(
                  `Stepwise chain delivery failed after ${attempts} attempts: ${validationIssues.join("; ")}`,
                ),
              ),
              usage,
            };
          }
          if (typeof output === "object" && output !== null && !Array.isArray(output)) {
            output = {
              ...(output as JsonObject),
              [stepwise.field]:
                stepwise.sparse === true
                  ? steps.map((step) => ({ index: step.index, text: step.text }))
                  : steps.map((step) => step.text),
              ...(stepwise.inject ?? {}),
            };
          }
        }
        const traceMetadata: JsonObject = {
          ...(capture.thinking.length > 0
            ? { thinkingSegments: capture.thinking as unknown as JsonValue }
            : {}),
          ...(capture.stepwise !== undefined && capture.stepwise.steps.length > 0
            ? {
                stepTurns: capture.stepwise.steps.map(({ index, turn }) => ({
                  index,
                  turn,
                })) as unknown as JsonValue,
              }
            : {}),
        };
        const succeeded = {
          ...result,
          output,
          usage,
          metadata: { ...(result.metadata ?? {}), ...traceMetadata },
        };
        if (!task.outputSchema || !this.config.outputValidator) {
          return succeeded;
        }
        const checked = await this.config.outputValidator.validate(
          succeeded.output,
          task.outputSchema.schema,
          task,
        );
        const normalized = normalizeValidation(checked, succeeded.output);
        if (normalized.success) {
          return {
            ...succeeded,
            output: normalized.value,
            metadata: { ...succeeded.metadata, validationAttempts: attempt },
          };
        }
        validationIssues = normalized.issues;
        rejectedOutput = succeeded.output;
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
        // An attempt that THROWS still spent tokens — a parse failure or a
        // turn-cap cancel happens after the whole stream was consumed, a
        // crash or stall after part of it. The capture carries what was
        // seen; fold it in so retries and final failures account for every
        // session the provider billed instead of discarding it with the
        // exception. (Verified against a provider billing export: thrown
        // attempts were ~4% of a real run's billed tokens.)
        if (capture.usage !== undefined) {
          usage = addUsage(usage, capture.usage);
          capture.usage = undefined;
        }
        if (
          context.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          throw abortError(context.signal?.reason);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (isCreditLimitMessage(message)) {
          const recovery = this.config.creditRecovery;
          let resolved: CreditResetResolution | undefined;
          try {
            resolved = recovery?.resolver
              ? await recovery.resolver(message)
              : await resolveCreditReset({
                  message,
                  now: recovery?.now?.(),
                  timeZone: recovery?.timeZone,
                  safetyBufferSeconds: recovery?.safetyBufferSeconds,
                  openRouterApiKey: recovery?.openRouterApiKey,
                  openRouterModel: recovery?.openRouterModel,
                });
          } catch {
            resolved = undefined;
          }
          throw resolved !== undefined
            ? new CreditBlockedError(resolved.retryAt, message, resolved.source)
            : new CreditBlockedError(undefined, message, "manual");
        }
        // The primary model was refused at agent creation (unknown id, no
        // access): one switch to the configured fallback model, mirroring
        // the Claude SDK's fallbackModel behavior. Consumes no attempts.
        if (
          !usedFallbackModel &&
          this.config.fallbackModel !== undefined &&
          /model|invalid.*selection/i.test(message) &&
          /not (?:found|available|recognized)|invalid|no access|unknown/i.test(message)
        ) {
          usedFallbackModel = true;
          attempt -= 1;
          progress(context, {
            kind: "retry",
            message: `Model unavailable; retrying with fallback model ${this.config.fallbackModel}`,
          });
          continue;
        }
        // Structured-output failures spend a validation attempt on a fresh
        // session with corrective feedback, falling back to validated raw
        // JSON — the same ladder as the Claude path.
        if (
          task.outputSchema &&
          /did not return valid structured JSON/.test(message) &&
          attempt < attempts
        ) {
          nativeStructuredOutput = false;
          validationIssues = [
            "The previous session ended without calling the structured-output tool and its final message was not parseable JSON.",
            "Respond with ONLY the complete raw JSON object — no prose before or after, no Markdown fences, every string (especially LaTeX and code) properly escaped.",
          ];
          rejectedOutput = undefined;
          progress(context, {
            kind: "validation",
            message: "Structured output missing; retrying in a fresh session",
          });
          continue;
        }
        // Transient infrastructure (crashed local runtime, dropped
        // transport, retryable backend error, exhausted upstream quota):
        // bounded restarts in a fresh session and sandbox, consuming no
        // validation attempts.
        if (isRetryableInfrastructure(error) && crashRetries < MAX_CRASH_RETRIES) {
          crashRetries += 1;
          attempt -= 1;
          // Two kinds of transient need TIME rather than a fresh session: an
          // empty quota window has to refill, and a failed token exchange has
          // to be retried after the backend settles. A crash needs neither.
          const waitMs =
            isResourceExhausted(error) || isTransientAuth(error)
              ? (this.config.quotaRetryDelayMs ?? DEFAULT_QUOTA_RETRY_DELAY_MS) * crashRetries
              : 0;
          progress(context, {
            kind: "retry",
            message:
              isResourceExhausted(error)
                ? `Cursor backend reports resource_exhausted; waiting ${Math.round(waitMs / 1000)}s, then retry ${crashRetries}/${MAX_CRASH_RETRIES}`
                : isTransientAuth(error)
                  ? `Cursor backend refused the credential; waiting ${Math.round(waitMs / 1000)}s, then retry ${crashRetries}/${MAX_CRASH_RETRIES}`
                  : `Cursor SDK infrastructure error; restarting the task, retry ${crashRetries}/${MAX_CRASH_RETRIES}`,
          });
          if (waitMs > 0) await delayForRetry(waitMs, context.signal);
          continue;
        }
        // An exhausted quota that outlived the quick retries is a WALL, not a
        // defect: the window refills on the provider's clock, which is minutes
        // to hours away, and the two waits above bought at most 90 seconds.
        // Parking the run is what this codebase already does with a provider
        // limit — the checkpoint records `credit_blocked`, the scheduler claims
        // it once when it comes due, and the dashboard shows the countdown — so
        // an overnight quota dip costs a pause instead of the whole run.
        if (isResourceExhausted(error)) {
          throw new CreditBlockedError(
            Date.now() + QUOTA_BLOCK_RETRY_MS,
            message,
            "deterministic",
          );
        }
        // A credential the backend refused through every bounded retry needs a
        // person, so the failure says which person and what to do.
        if (isTransientAuth(error)) {
          return {
            taskId: task.taskId,
            status: "error",
            error: serializeError(
              new Error(
                `${message} — the Cursor backend refused this run's credential on every ` +
                  `attempt; re-enter the Cursor API key in Settings, then retry this run ` +
                  `from its checkpoint.`,
              ),
            ),
            usage,
          };
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

/** Performs a real one-turn model request; success proves the API key works. */
export async function validateCursorApiKey(
  input: ValidateCursorApiKeyInput,
): Promise<void> {
  const controller = new AbortController();
  const timeout =
    input.timeoutMs !== undefined
      ? setTimeout(
          () => controller.abort("connection validation timed out"),
          input.timeoutMs,
        )
      : undefined;
  const executor = new CursorAgentExecutor({
    apiKey: input.apiKey,
    ...(input.model ? { model: input.model } : {}),
    ...(input.agentFactory ? { agentFactory: input.agentFactory } : {}),
    ...(input.listModels ? { listModels: input.listModels } : {}),
    ...(input.cwd ? { taskWorkspaceRoot: input.cwd } : {}),
    maxTurns: 4,
  });
  try {
    const result = await executor.execute(
      {
        taskId: "validate-cursor-api-key",
        kind: "connection.validate",
        input: "Reply with OK.",
        modelRequest: {
          messages: [
            { role: "user", content: [{ type: "text", text: "Reply with OK." }] },
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
