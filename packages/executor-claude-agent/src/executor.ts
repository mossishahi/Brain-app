import {
  createSdkMcpServer,
  query as sdkQuery,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  CreditBlockedError,
  addUsage,
  emptyUsage,
  serializeError,
  systemPromptBoundary,
  systemPromptSegments,
  textContent,
  toolCallDetail,
  type AgentExecutionContext,
  type AgentProgress,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type JsonObject,
  type JsonValue,
  type ModelMessage,
  type SystemPrompt,
  type TaxonomyAccess,
  type TokenUsage,
  type ToolCallDetail,
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
  /**
   * Shared-taxonomy access. The Claude Agent SDK has no built-in taxonomy
   * tool, so when this is set the taxonomy_tree / taxonomy_resolve READ tools
   * are delivered as in-process MCP tools (like the stepwise chain tool) to
   * any task whose skill declares the `taxonomy-access` capability — without
   * it the placer is toolless and cannot satisfy taxonomy-access.
   */
  readonly taxonomy?: TaxonomyAccess;
  /**
   * GPU run setup (deployment-owner template plus time ceiling). The Agent
   * SDK has no built-in cluster submission, so when this is set the gpu_run
   * tool is delivered as an in-process MCP tool to any task whose skill
   * declares the `gpu-execution` capability.
   */
  readonly gpuRun?: GpuRunConfig;
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
  /**
   * Session inactivity watchdog: when NO SDK message arrives for this long —
   * and no in-process MCP tool call is running (a gpu_run may legitimately
   * wait on the cluster queue for an hour) — the session is treated as hung
   * and restarted in a fresh session, exactly like a crashed subprocess.
   * A healthy session cannot be this quiet: partial messages stream during
   * generation and every tool call produces messages, so a long silent gap
   * means a wedged subprocess or a dead network connection that no socket
   * timeout will ever clear. 0 disables. Default 15 minutes.
   */
  readonly stallTimeoutMs?: number;
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
    /**
     * The task the value answers, so a validator can check what the schema
     * alone cannot — a patch's coherence against the version it revises
     * (AgentTask.revisionBase) — while a retry is still possible.
     */
    task?: AgentTask,
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

/** Route trait that turns on reasoning-trace capture for a task. */
const TRACE_TRAIT = "extended-reasoning";
/**
 * How many times one task restarts after its Claude Code subprocess dies
 * (nonzero exit, kill signal, or spawn failure) before the failure is real.
 * Separate from validation attempts: a crashed session produced no output
 * to validate.
 */
const MAX_CRASH_RETRIES = 2;

/** Default session inactivity ceiling; see ClaudeAgentExecutorConfig.stallTimeoutMs. */
const DEFAULT_SESSION_STALL_MS = 15 * 60_000;

/** How long the stall path waits for query.interrupt() before giving up on it. */
const STALL_INTERRUPT_GRACE_MS = 5_000;

/** A session that produced no SDK message within the inactivity ceiling. */
export class SessionStalledError extends Error {
  constructor(readonly quietMs: number) {
    super(
      `Claude Code session stalled: no output for ${Math.round(quietMs / 1000)}s — ` +
        "the subprocess or its network connection is hung",
    );
    this.name = "SessionStalledError";
  }
}

/**
 * Inactivity watchdog for one SDK session. `touch()` restarts the countdown
 * (called on every SDK message); `hold()`/`release()` suspend it while an
 * in-process MCP tool runs, because a tool that legitimately blocks (gpu_run
 * waiting on the cluster queue) produces no SDK messages while it works.
 * On expiry the `expiry` promise rejects with SessionStalledError; racing it
 * against the stream's next() turns a silent forever-hang into an error the
 * executor's crash-restart machinery already knows how to retry.
 */
class SessionWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private holds = 0;
  private expire!: (error: SessionStalledError) => void;
  readonly expiry: Promise<never>;

  constructor(private readonly ms: number) {
    this.expiry = new Promise<never>((_resolve, reject) => {
      this.expire = reject;
    });
    // The expiry of a healthy session is never observed; that must not
    // surface as an unhandled rejection when the race has already settled.
    this.expiry.catch(() => undefined);
  }

  touch(): void {
    if (this.ms <= 0 || this.holds > 0) return;
    clearTimeout(this.timer);
    // Deliberately NOT unref'd: when the SDK stream wedges, this timer can be
    // the only live handle, and an unref'd watchdog lets the process die (or
    // never fire) instead of reporting the stall — the exact failure the
    // Cursor path's watchdog shipped with and had to fix. stop() clears it,
    // so a healthy completion is never held open.
    this.timer = setTimeout(() => this.expire(new SessionStalledError(this.ms)), this.ms);
  }

  private hold(): void {
    this.holds += 1;
    clearTimeout(this.timer);
  }

  private release(): void {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds === 0) this.touch();
  }

  /** Wraps an in-process MCP tool handler so its runtime never counts as silence. */
  held<A, R>(handler: (args: A) => Promise<R>): (args: A) => Promise<R> {
    return async (args: A) => {
      this.hold();
      try {
        return await handler(args);
      } finally {
        this.release();
      }
    };
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
/** In-process MCP server name carrying the stepwise chain tool. */
const STEPWISE_SERVER = "steps";

/** Stepwise delivery contract mirrored from AgentTask.metadata.stepwise. */
interface StepwiseSpec {
  readonly tool: string;
  readonly field: string;
  readonly count: number;
  /**
   * Sparse delivery: only the positions being changed are submitted, and the
   * host carries the rest from the version under revision. Collected as
   * `{index, text}` records rather than a flat list.
   */
  readonly sparse?: boolean;
  readonly inject?: JsonObject;
}

interface StepwiseStep {
  readonly index: number;
  readonly text: string;
  readonly turn: number;
}

/** Per-attempt trace state: thinking segments plus recorded chain steps. */
interface TraceCapture {
  readonly wantsTrace: boolean;
  readonly thinking: { turn: number; text: string }[];
  readonly stepwise?: {
    readonly spec: StepwiseSpec;
    readonly steps: StepwiseStep[];
  };
  turn: number;
}

function routeTraits(task: AgentTask): readonly string[] {
  const input = record(task.input);
  return Array.isArray(input.routeTraits)
    ? input.routeTraits.filter(
        (trait): trait is string => typeof trait === "string",
      )
    : [];
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

/** Full tool name Claude Code assigns to an SDK MCP server tool. */
function stepwiseSdkToolName(spec: StepwiseSpec): string {
  return `mcp__${STEPWISE_SERVER}__${spec.tool}`;
}

function stepwiseRefusal(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * In-process MCP server exposing the stepwise chain tool. The handler
 * records ordered steps into the attempt's capture state; the executor
 * injects them into the structured output before authoritative validation.
 */
function stepwiseServer(
  spec: StepwiseSpec,
  capture: TraceCapture,
  watchdog: SessionWatchdog,
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: STEPWISE_SERVER,
    version: "1.0.0",
    tools: [
      sdkTool(
        spec.tool,
        spec.sparse
          ? `Submit one REWRITTEN step of the ${spec.count}-step chain. Call this tool once per ` +
            `step you are changing, in ascending order of index (1 through ${spec.count}), each ` +
            `call carrying exactly one paragraph. Submit only the steps you rewrite: every step ` +
            `you do not submit is carried over unchanged, word for word. At least one step must ` +
            `be submitted before the final structured answer.`
          : `Submit one step of your ${spec.count}-step chain. Call this tool once per step, ` +
            `strictly in order (index 1 through ${spec.count}), each call carrying exactly one ` +
            `paragraph. All ${spec.count} steps must be submitted before the final structured answer.`,
        {
          index: z.number().int().min(1).max(spec.count),
          text: z.string().min(1),
        },
        watchdog.held(async (args) => {
          const steps = capture.stepwise!.steps;
          if (args.text.trim().length === 0) {
            return stepwiseRefusal(
              "text must carry the step as one non-empty paragraph.",
            );
          }
          if (spec.sparse === true) {
            // Any subset, strictly ascending, each position once — the host
            // applies them positionally to the version under revision.
            const last = steps[steps.length - 1];
            if (last !== undefined && args.index <= last.index) {
              return stepwiseRefusal(
                `Rewritten steps must be submitted in ascending order; step ${last.index} is already submitted.`,
              );
            }
            steps.push({ index: args.index, text: args.text, turn: capture.turn });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    recorded: args.index,
                    rewritten: steps.length,
                  }),
                },
              ],
            };
          }
          const expected = steps.length + 1;
          if (expected > spec.count) {
            return stepwiseRefusal(
              `All ${spec.count} steps are already submitted; return the final structured answer now.`,
            );
          }
          if (args.index !== expected) {
            return stepwiseRefusal(
              `Steps must be submitted strictly in order; expected index ${expected} next.`,
            );
          }
          steps.push({ index: expected, text: args.text, turn: capture.turn });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  recorded: expected,
                  remaining: spec.count - expected,
                }),
              },
            ],
          };
        }),
      ),
    ],
  });
}

/** In-process MCP server name carrying the shared-taxonomy read tools. */
const TAXONOMY_SERVER = "taxonomy";

/** Full Claude Code tool names for the in-process taxonomy MCP server. */
function taxonomySdkToolNames(): readonly string[] {
  return [
    `mcp__${TAXONOMY_SERVER}__taxonomy_tree`,
    `mcp__${TAXONOMY_SERVER}__taxonomy_resolve`,
  ];
}

/**
 * True when the task may use the capability: the broker plan is the
 * authority when present (a per-run disable resolves every operation
 * "unavailable", so plan-aware gating removes the backing tools too);
 * tasks without a plan fall back to the declared capability list.
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

/** True when the task's skill declared the taxonomy-access capability. */
function taskUsesTaxonomy(task: AgentTask): boolean {
  return taskUsesCapability(task, "taxonomy-access");
}

/**
 * In-process MCP server exposing the shared-taxonomy READ tools
 * (taxonomy_tree / taxonomy_resolve) backed by the injected TaxonomyAccess.
 * The Claude Agent SDK ships no taxonomy built-in, so — exactly like the
 * stepwise chain tool — these run in this process and call the shared store.
 * Reads only: recording placement decisions stays a deterministic runtime
 * step (taxonomy.suggest), never an agent tool.
 */
function taxonomyServer(
  taxonomy: TaxonomyAccess,
  watchdog: SessionWatchdog,
): ReturnType<typeof createSdkMcpServer> {
  const errorResult = (error: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      },
    ],
    isError: true as const,
  });
  return createSdkMcpServer({
    name: TAXONOMY_SERVER,
    version: "1.0.0",
    tools: [
      sdkTool(
        "taxonomy_tree",
        "Fetch the complete CURRENT shared scientific taxonomy as a names-only " +
          "indented outline (no indent = domain, one = field, two = subfield, " +
          "three = topic), stamped with the live revision it was read at. " +
          "Optionally pass `root` (an exact node name) to fetch one branch. " +
          "Read it in full before deciding any placement.",
        { root: z.string().optional() },
        watchdog.held(async (args) => {
          try {
            const root =
              typeof args.root === "string" && args.root.trim() !== ""
                ? args.root
                : undefined;
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(await taxonomy.tree(root)) },
              ],
            };
          } catch (error) {
            return errorResult(error);
          }
        }),
      ),
      sdkTool(
        "taxonomy_resolve",
        "Resolve one field name against the shared taxonomy at its latest " +
          "revision. Returns the exact position when the name (or a curated " +
          "alias) exists, otherwise NA with candidate node names. Use it to " +
          "check whether a field you are about to place already exists under " +
          "another spelling.",
        {
          query: z.string().min(1),
          optionLimit: z.number().int().min(1).max(100).optional(),
        },
        watchdog.held(async (args) => {
          try {
            const result = await taxonomy.resolve(
              args.query,
              typeof args.optionLimit === "number" ? args.optionLimit : undefined,
            );
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (error) {
            return errorResult(error);
          }
        }),
      ),
    ],
  });
}

/** In-process MCP server name carrying the deterministic attachment tools. */
const ATTACHMENTS_SERVER = "attachments";

/** Full Claude Code tool names for the in-process attachments MCP server. */
function attachmentsSdkToolNames(): readonly string[] {
  return [
    `mcp__${ATTACHMENTS_SERVER}__attachment_list`,
    `mcp__${ATTACHMENTS_SERVER}__attachment_search`,
  ];
}

/**
 * In-process MCP server exposing the deterministic attachment tools over the
 * job's ingested roots: `attachment_list` (inventory, flat or tree) and
 * `attachment_search` (one-call grep across every text attachment). Reading
 * file CONTENT stays on Claude Code's built-in Read — it natively renders
 * PDFs and images, which this transport cannot — but enumerating and locating
 * are deterministic host work, so they run here instead of burning model
 * turns on shell loops.
 */
function attachmentsServer(
  roots: readonly string[],
  watchdog: SessionWatchdog,
): ReturnType<typeof createSdkMcpServer> {
  const tools = new Map(
    attachmentTools(roots).map((tool) => [tool.definition.name, tool]),
  );
  const call = async (name: string, args: unknown) => {
    const tool = tools.get(name);
    if (!tool) {
      return {
        content: [
          { type: "text" as const, text: `tool "${name}" is not available` },
        ],
        isError: true as const,
      };
    }
    try {
      const result = await tool.execute(args as JsonValue, {
        runId: "claude-agent-sdk",
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof result.output === "string"
                ? result.output
                : JSON.stringify(result.output),
          },
        ],
        ...(result.isError === true ? { isError: true as const } : {}),
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true as const,
      };
    }
  };
  return createSdkMcpServer({
    name: ATTACHMENTS_SERVER,
    version: "1.0.0",
    tools: [
      sdkTool(
        "attachment_list",
        ATTACHMENT_LIST_MANIFEST.definition.description ?? "",
        {
          prefix: z.string().optional(),
          shape: z.enum(["flat", "tree"]).optional(),
        },
        watchdog.held(async (args) => call("attachment_list", args)),
      ),
      sdkTool(
        "attachment_search",
        ATTACHMENT_SEARCH_MANIFEST.definition.description ?? "",
        {
          query: z.string().min(1),
          regex: z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          prefix: z.string().optional(),
          filesOnly: z.boolean().optional(),
          maxResults: z.number().int().min(1).max(500).optional(),
        },
        watchdog.held(async (args) => call("attachment_search", args)),
      ),
    ],
  });
}

/** In-process MCP server name carrying the GPU submission tool. */
const GPU_SERVER = "gpu";

/** Full Claude Code tool name for the in-process GPU MCP server. */
function gpuSdkToolNames(): readonly string[] {
  return [`mcp__${GPU_SERVER}__gpu_run`];
}

/** True when the task's skill declared the gpu-execution capability. */
function taskUsesGpu(task: AgentTask): boolean {
  return taskUsesCapability(task, "gpu-execution");
}

/**
 * In-process MCP server exposing the gpu_run host tool: the agent's script
 * is spliced verbatim into the deployment owner's submission template and
 * the job's log comes back exactly as the script printed it. Failures carry
 * the bug-report-to-the-submitter contract (debug, fix, resubmit), which
 * the host tool itself formats — this bridge only transports it.
 */
function gpuServer(
  config: GpuRunConfig,
  watchdog: SessionWatchdog,
): ReturnType<typeof createSdkMcpServer> {
  const [tool] = gpuRunTools(config);
  return createSdkMcpServer({
    name: GPU_SERVER,
    version: "1.0.0",
    tools: [
      sdkTool(
        "gpu_run",
        GPU_RUN_MANIFEST.definition.description ?? "",
        {
          script: z.string().min(1),
          time_limit_minutes: z.number().int().min(1).optional(),
          job_name: z.string().optional(),
        },
        // The hold matters most here: a queued cluster job legitimately
        // produces no SDK messages for up to its whole time ceiling.
        watchdog.held(async (args) => {
          try {
            const result = await tool!.execute(args as JsonValue, {
              runId: "claude-agent-sdk",
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    typeof result.output === "string"
                      ? result.output
                      : JSON.stringify(result.output),
                },
              ],
              ...(result.isError === true ? { isError: true as const } : {}),
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              isError: true as const,
            };
          }
        }),
      ),
    ],
  });
}

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

/**
 * Every task runs in a fresh session, so the only caching available is the
 * SDK's cross-session prefix cache. The boundary marker declares where the
 * stable instructions end; without it a custom prompt is one opaque block and
 * nothing can be reused between the panel's many near-identical calls.
 */
function sdkSystemPrompt(system: SystemPrompt): string | string[] {
  const segments = systemPromptSegments(system);
  if (segments.length === 0) return "";
  const boundary = systemPromptBoundary(segments);
  const texts = segments.map((segment) => segment.text);
  if (boundary === 0) return texts.join("\n\n");
  return [
    ...texts.slice(0, boundary),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ...texts.slice(boundary),
  ];
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
    case `mcp__${ATTACHMENTS_SERVER}__attachment_list`:
      return "Listing the attachment inventory";
    case `mcp__${ATTACHMENTS_SERVER}__attachment_search`: {
      const query = shortText(args.query);
      return query
        ? `Searching the attachments — ${query}`
        : "Searching the attachments";
    }
    case `mcp__${GPU_SERVER}__gpu_run`: {
      const jobName = shortText(args.job_name);
      return jobName
        ? `Running a GPU job — ${jobName}`
        : "Running a GPU job";
    }
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
  [`mcp__${ATTACHMENTS_SERVER}__attachment_list`]: "Attachment inventory",
  [`mcp__${ATTACHMENTS_SERVER}__attachment_search`]: "Attachment search",
  [`mcp__${GPU_SERVER}__gpu_run`]: "GPU job",
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
  /** tool_use_id -> start bookkeeping for tool_end durations and detail. */
  readonly pendingTools: Map<
    string,
    { name: string; startedAt: number; detail?: ToolCallDetail }
  >;
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
      // The call's operational detail (path read, query searched, command
      // run) rides the event for the dashboard's capability icons; the
      // structured-output and stepwise chain tools are excluded inside
      // toolCallDetail so artifact and reasoning content never leaks here.
      const detail = toolCallDetail(
        block.name,
        isJsonValue(block.input) ? block.input : undefined,
      );
      if (typeof block.id === "string") {
        state.pendingTools.set(block.id, {
          name: block.name,
          startedAt: Date.now(),
          ...(detail ? { detail } : {}),
        });
      }
      emit(state, context, {
        kind: "tool_start",
        toolName: block.name,
        message: toolMessage(block.name, block.input),
        ...(detail ? { data: { detail: { ...detail } } } : {}),
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
        ...(pending.detail ? { data: { detail: { ...pending.detail } } } : {}),
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

/**
 * Rides an attempt's already-billed usage on an error about to be thrown, so
 * the retry ladder can fold it into the task's accounting even though the
 * attempt produced no result: the SDK reports usage on its result message
 * even for non-success ends and for finals whose output does not parse.
 * The property never leaves the process — serializeError keeps only
 * name/message/stack — so nothing extra reaches checkpoints or events.
 */
function attachTaskUsage<T>(error: T, usage: TokenUsage): T {
  if (typeof error === "object" && error !== null) {
    (error as { taskUsage?: TokenUsage }).taskUsage = usage;
  }
  return error;
}

/** The usage a thrown attempt carried, when one was attached. */
function takeTaskUsage(error: unknown): TokenUsage | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const carried = (error as { taskUsage?: unknown }).taskUsage;
  if (
    typeof carried !== "object" ||
    carried === null ||
    typeof (carried as { inputTokens?: unknown }).inputTokens !== "number" ||
    typeof (carried as { outputTokens?: unknown }).outputTokens !== "number"
  ) {
    return undefined;
  }
  return carried as TokenUsage;
}

/**
 * Best-effort extraction of one JSON value from a model's final TEXT message
 * (the raw-JSON fallback path when native structured output is exhausted).
 * Models under that instruction still occasionally wrap the object in prose
 * or a Markdown fence; each candidate below is strictly parsed and
 * JSON-safety-checked, so salvage can never invent structure — it only finds
 * the object that is already there. Returns undefined when nothing parses.
 */
export function salvageJsonText(text: string): JsonValue | undefined {
  const candidates: string[] = [];
  const trimmed = text.trim();
  candidates.push(trimmed);
  // A fenced block anywhere in the message, not only as the entire message.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  // The outermost braced/bracketed span (prose before/after the object).
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
    const salvaged = salvageJsonText(text);
    if (salvaged === undefined) {
      // Keep the evidence: whether this was sloppy formatting, broken
      // escaping, or a message cut off at the output-token cap is exactly
      // what the error consumer needs to know — and by then the session is
      // gone. An unterminated JSON string in a long message is the
      // signature of truncation, which no retry can fix.
      const head = text.slice(0, 400).replace(/\s+/g, " ");
      const tail = text.length > 700 ? text.slice(-200).replace(/\s+/g, " ") : "";
      const truncated =
        /[{["]/.test(text) && text.length > 8_000 && !/[}\]"]\s*$/.test(text.trim());
      throw new Error(
        `Claude Agent SDK did not return valid structured JSON (final message: ${text.length} chars` +
          (truncated
            ? "; it ends mid-value, which points at the output-token cap rather than formatting"
            : "") +
          `). Head: ${head}${tail ? ` … Tail: ${tail}` : ""}`,
      );
    }
    return salvaged;
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
 * Absolute prefixes shell commands may always touch: interpreters, system
 * libraries, and scratch space. Everything else outside the run's own roots
 * is user territory the task has no business in.
 */
const SHELL_SYSTEM_PREFIXES = [
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/opt/",
  "/dev/",
  "/tmp/",
  "/private/tmp/",
  "/var/folders/",
  "/private/var/folders/",
  "/System/",
  "/Library/",
  "/Applications/",
  "/nix/",
  "/snap/",
] as const;

/**
 * Path-like tokens of a shell command: absolute paths, `~`/`$HOME`
 * expansions, all normalized (so `..` hops resolve before scoping). The
 * boundary class keeps URLs (`https://…` — double slash) and mid-word
 * slashes (`s/a/b/`, `$1/2`) out; regex literals like `'/ERROR/'` may still
 * match, which is why callers only act on tokens that EXIST on disk — a
 * nonexistent path cannot leak anything.
 */
function shellPathCandidates(
  command: string,
  taskRoot: string,
): readonly string[] {
  const out: string[] = [];
  const pattern =
    /(?:^|[\s"'`=(:;,|&<>])((?:~|\$HOME|\$\{HOME\})?\/(?!\/)[^\s"'`;:,|&<>)]*|\.\.\/[^\s"'`;:,|&<>)]*)/g;
  for (const match of command.matchAll(pattern)) {
    let token = match[1]!;
    if (token.startsWith("~")) token = homedir() + token.slice(1);
    else if (token.startsWith("${HOME}")) token = homedir() + token.slice(7);
    else if (token.startsWith("$HOME")) token = homedir() + token.slice(5);
    // `../…` hops resolve against the task workspace (the shell's cwd).
    out.push(isAbsolute(token) ? resolve(token) : resolve(taskRoot, token));
  }
  // Bare `~` / `$HOME` with no path after it (`ls $HOME`) is still a read of
  // the home directory; the path pattern above requires a slash, so catch
  // the standalone tokens separately.
  const bareHome = /(?:^|[\s"'`=(:;,|&<>])(~|\$HOME|\$\{HOME\})(?=$|[\s"'`;:,|&<>)])/g;
  if (bareHome.test(command)) out.push(homedir());
  return out;
}

/**
 * Claude Code's native tools are provider-specific and powerful. Scope them
 * to the disposable task workspace plus server-ingested attachment roots so
 * an attachment-aware role cannot read arbitrary host files:
 *
 * - Read/Glob/Grep: the supplied path must sit inside the roots.
 * - Bash: no existing file or directory outside the roots (plus system
 *   prefixes for interpreters and scratch space) may appear in the command —
 *   the `for f in …; do sed …` shell-loop that bypassed both the scope and
 *   the attachment access ledger. Text-level checks cannot bind a determined
 *   adversary, but they keep an honest model on the audited Read /
 *   attachment_search path, and the deny message tells it exactly where to
 *   go instead.
 */
function fileAccessHooks(
  config: ClaudeAgentExecutorConfig,
): UnknownRecord {
  const taskRoot = resolve(config.cwd ?? process.cwd());
  const roots = [
    taskRoot,
    ...(config.attachmentRoots ?? []).map((root) => resolve(root)),
  ];
  const deny = (reason: string): UnknownRecord => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  const readHook = async (input: unknown): Promise<UnknownRecord> => {
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
    return deny("File access is limited to this run's ingested attachments.");
  };
  const shellHook = async (input: unknown): Promise<UnknownRecord> => {
    const event = record(input);
    if (event.hook_event_name !== "PreToolUse") return { continue: true };
    if (event.tool_name !== "Bash") return { continue: true };
    const toolInput = record(event.tool_input);
    const command =
      typeof toolInput.command === "string" ? toolInput.command : "";
    for (const candidate of shellPathCandidates(command, taskRoot)) {
      if (roots.some((root) => insideDirectory(root, candidate))) continue;
      if (
        SHELL_SYSTEM_PREFIXES.some(
          (prefix) =>
            candidate.startsWith(prefix) || candidate === prefix.slice(0, -1),
        )
      ) {
        continue;
      }
      let exists = false;
      try {
        lstatSync(candidate);
        exists = true;
      } catch {
        // Nonexistent paths (including regex literals that merely look like
        // paths) cannot leak anything; let the command run.
      }
      if (!exists) continue;
      return deny(
        `Shell commands may only touch this run's task workspace and ingested attachments; "${candidate}" is outside them. ` +
          "Read attached files with the Read tool, locate content across attachments with the attachment_search tool, " +
          "list them with attachment_list, and run scripts from the workspace using relative paths and PATH-resolved interpreters.",
      );
    }
    return { continue: true };
  };
  return {
    PreToolUse: [
      {
        matcher: "Read|Glob|Grep",
        hooks: [readHook],
      },
      {
        matcher: "Bash",
        hooks: [shellHook],
      },
    ],
  };
}

function queryOptions(
  config: ClaudeAgentExecutorConfig,
  task: AgentTask,
  controller: AbortController,
  nativeStructuredOutput: boolean,
  capture: TraceCapture,
  watchdog: SessionWatchdog,
): UnknownRecord {
  const builtinTools = allowedTools(task);
  const wantsTaxonomy =
    config.taxonomy !== undefined && taskUsesTaxonomy(task);
  const wantsAttachments =
    (config.attachmentRoots?.length ?? 0) > 0 &&
    taskUsesCapability(task, "attachment-access");
  const wantsGpu = config.gpuRun !== undefined && taskUsesGpu(task);
  const tools = [
    ...builtinTools,
    ...(capture.stepwise !== undefined
      ? [stepwiseSdkToolName(capture.stepwise.spec)]
      : []),
    ...(wantsTaxonomy ? taxonomySdkToolNames() : []),
    ...(wantsAttachments ? attachmentsSdkToolNames() : []),
    ...(wantsGpu ? gpuSdkToolNames() : []),
  ];
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
    // The reasoning trace (a summary; the raw chain of thought is never
    // returned) is requested only for routes that capture it; other tasks
    // keep the faster omitted display.
    thinking:
      config.thinking === "disabled"
        ? { type: "disabled" }
        : {
            type: "adaptive",
            display: capture.wantsTrace ? "summarized" : "omitted",
          },
    cwd: config.cwd ?? process.cwd(),
    env: sdkEnvironment(config.token, config.env),
    hooks: fileAccessHooks(config),
  };
  const mcpServers: UnknownRecord = {
    ...(capture.stepwise !== undefined
      ? { [STEPWISE_SERVER]: stepwiseServer(capture.stepwise.spec, capture, watchdog) }
      : {}),
    ...(wantsTaxonomy
      ? { [TAXONOMY_SERVER]: taxonomyServer(config.taxonomy!, watchdog) }
      : {}),
    ...(wantsAttachments
      ? { [ATTACHMENTS_SERVER]: attachmentsServer(config.attachmentRoots!, watchdog) }
      : {}),
    ...(wantsGpu ? { [GPU_SERVER]: gpuServer(config.gpuRun!, watchdog) } : {}),
  };
  if (Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
  }
  if ((config.attachmentRoots?.length ?? 0) > 0) {
    options.additionalDirectories = [...config.attachmentRoots!];
  }
  const model = description?.modelId ?? config.model;
  if (model) options.model = model;
  if (description?.system) {
    options.systemPrompt = sdkSystemPrompt(description.system);
  }
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
  capture: TraceCapture,
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
    const wantsAttachments =
      (config.attachmentRoots?.length ?? 0) > 0 &&
      taskUsesCapability(task, "attachment-access");
    // The inactivity watchdog: without it, a wedged Claude Code subprocess
    // (or a dead network connection that no socket timeout ever clears)
    // leaves this loop awaiting the next message FOREVER — a silent hang
    // that writes no events and no checkpoints while the process stays
    // alive. Racing every next() against the watchdog turns that hang into
    // a SessionStalledError the crash-restart machinery retries.
    const watchdog = new SessionWatchdog(
      config.stallTimeoutMs ?? DEFAULT_SESSION_STALL_MS,
    );
    const stream = queryFn({
      prompt: [
        messagePrompt(task.modelRequest.messages),
        ...(task.outputSchema
          ? [
              "",
              "Your structured output submission is FINAL and recorded verbatim as your answer.",
              'Never submit placeholder, trial, or test values (such as "test" or "ok") to probe the output tool.',
            ]
          : []),
        ...(wantsAttachments
          ? [
              "",
              "Enumerating and locating attachment content is deterministic host work: use the " +
                "attachment_list tool for the inventory and the attachment_search tool to find " +
                "where something is mentioned across every attached file in one call. Do not " +
                "re-derive these with shell loops (`for f in ...; do cat/sed ...`) or by reading " +
                "files one by one to look for a term — read a file's content only once you know " +
                "you need that file, and reserve script execution for actual computation.",
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
      options: queryOptions(
        config,
        task,
        controller,
        nativeStructuredOutput,
        capture,
        watchdog,
      ),
    });
    const iterator = stream[Symbol.asyncIterator]();
    watchdog.touch();
    try {
      for (;;) {
        const step = iterator.next();
        // A stall abandons this promise mid-flight; its later settlement
        // (usually a rejection after the abort below) must not surface as
        // an unhandled rejection.
        void step.then(undefined, () => undefined);
        const settled = await Promise.race([step, watchdog.expiry]);
        if (settled.done === true) break;
        watchdog.touch();
        const current = record(settled.value);
        // Stream deltas are progress signals, not conversation turns.
        if (current.type !== "stream_event") messageCount += 1;
        capture.turn = messageCount;
        if (capture.wantsTrace && current.type === "assistant") {
          const content = record(current.message).content;
          if (Array.isArray(content)) {
            for (const candidate of content) {
              const block = record(candidate);
              if (
                block.type === "thinking" &&
                typeof block.thinking === "string" &&
                block.thinking.trim().length > 0
              ) {
                capture.thinking.push({
                  turn: messageCount,
                  text: block.thinking,
                });
              }
            }
          }
        }
        reportSdkMessage(current, context, progressState);
        if (current.type === "result") finalResult = current;
      }
    } catch (error) {
      if (error instanceof SessionStalledError) {
        // Best-effort release of the wedged subprocess before reporting:
        // a hung session may not answer the interrupt, so it is bounded
        // and its own failure is irrelevant next to the stall itself.
        let grace: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            stream.interrupt?.() ?? Promise.resolve(),
            new Promise<void>((resolve) => {
              // Ref'd for the same reason as the watchdog timer: it may be
              // the only handle standing between this wait and a dead loop.
              grace = setTimeout(resolve, STALL_INTERRUPT_GRACE_MS);
            }),
          ]);
        } catch {
          // The stall error below carries the real failure.
        } finally {
          clearTimeout(grace);
        }
        controller.abort(error.message);
      }
      throw error;
    } finally {
      watchdog.stop();
    }
    if (context.signal?.aborted || controller.signal.aborted) {
      throw abortError(context.signal?.reason);
    }
    if (!finalResult) {
      throw new Error("Claude Agent SDK ended without a result message");
    }
    // The result message carries the session's cumulative usage even when
    // the session did not succeed; from here on every throw rides it out,
    // so the retry ladder records what the failed attempt already spent.
    const queryUsage = usageFromResult(finalResult.usage);
    if (finalResult.subtype !== "success" || finalResult.is_error === true) {
      const errors = Array.isArray(finalResult.errors)
        ? finalResult.errors.map(String).join("; ")
        : `Claude Agent SDK ended with ${String(finalResult.subtype)}`;
      throw attachTaskUsage(new Error(errors), queryUsage);
    }
    let output: JsonValue;
    try {
      output = parseResultOutput(finalResult, task);
    } catch (error) {
      // An unparseable final message spends a validation attempt in a fresh
      // session; the tokens this one billed must not vanish with it.
      throw attachTaskUsage(error, queryUsage);
    }
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
      usage: queryUsage,
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
    const stepwise = stepwiseSpecOf(task);
    // One machine-readable record of how the broker resolved this task's
    // capabilities, mirroring the generic tool loop, so both executor paths
    // feed the same usage ledger.
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
      routeTraits(task).includes(TRACE_TRAIT) &&
      this.config.thinking !== "disabled";
    let validationIssues: string[] = [];
    let rejectedOutput: JsonValue | undefined;
    let usage = emptyUsage();
    let nativeStructuredOutput = true;
    let crashRetries = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const workspace = taskWorkspace(this.config, task, context, attempt);
      // Fresh per-attempt trace state: attempts run in fresh sessions, so
      // recorded steps and thinking segments must never leak across them.
      const capture: TraceCapture = {
        wantsTrace,
        thinking: [],
        ...(stepwise !== undefined
          ? { stepwise: { spec: stepwise, steps: [] } }
          : {}),
        turn: 0,
      };
      try {
        const result = await executeQuery(
          { ...this.config, cwd: workspace },
          task,
          context,
          capture,
          validationIssues,
          nativeStructuredOutput,
          rejectedOutput,
        );
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
          // The orchestrator assembles the reviewed chain from the recorded
          // tool calls; the model's JSON never carries it.
          if (
            typeof output === "object" &&
            output !== null &&
            !Array.isArray(output)
          ) {
            output = {
              ...(output as JsonObject),
              // Sparse delivery keeps each step's position: the host applies
              // them to the version being revised, and carries the rest.
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
          ...(capture.stepwise !== undefined &&
          capture.stepwise.steps.length > 0
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
            metadata: {
              ...succeeded.metadata,
              validationAttempts: attempt,
            },
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
        // A thrown attempt may still carry the usage its session already
        // billed (a non-success end, an unparseable final message); fold it
        // in so retries and final failures account for it.
        const lostUsage = takeTaskUsage(error);
        if (lostUsage !== undefined) usage = addUsage(usage, lostUsage);
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
            // The message names no reset time (e.g. "credit balance is too
            // low", which only a top-up clears): still a credit block, but
            // one the user must claim manually instead of the scheduler.
            resolved = undefined;
          }
          throw resolved !== undefined
            ? new CreditBlockedError(resolved.retryAt, message, resolved.source)
            : new CreditBlockedError(undefined, message, "manual");
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
        // The final message carried no structured output and no salvageable
        // JSON: a per-attempt output failure, not infrastructure. Spend a
        // validation attempt on a fresh session with corrective feedback
        // instead of sinking the task — and with it a stage that may have
        // been running for twenty minutes across a whole panel.
        if (
          task.outputSchema &&
          /did not return valid structured JSON|returned a non-JSON structured output/.test(
            message,
          ) &&
          attempt < attempts
        ) {
          nativeStructuredOutput = false;
          validationIssues = [
            "The previous session's final message was not parseable JSON.",
            "Respond with ONLY the complete raw JSON object — no prose before or after, no Markdown fences, every string (especially LaTeX and code) properly escaped.",
          ];
          rejectedOutput = undefined;
          progress(context, {
            kind: "validation",
            message:
              "Final message was not parseable JSON; retrying in a fresh session",
          });
          continue;
        }
        // A crashed or unspawnable Claude Code subprocess (it can die with an
        // empty stderr — the SDK's exit error then carries no reason at all)
        // is transient infrastructure, not a semantic task failure: retry a
        // bounded number of times in a fresh session and sandbox before
        // giving up, so one silent process death cannot sink a long run.
        // Crash retries consume no validation attempts.
        if (
          /Claude Code process (?:exited with code \d+|terminated by signal \w+)|Failed to spawn Claude Code process/.test(
            message,
          ) &&
          crashRetries < MAX_CRASH_RETRIES
        ) {
          crashRetries += 1;
          attempt -= 1;
          progress(context, {
            kind: "retry",
            message: `Claude Code process crashed; restarting the task, retry ${crashRetries}/${MAX_CRASH_RETRIES}`,
          });
          continue;
        }
        // A stalled session is the same class of failure as a crash — dead
        // infrastructure under a healthy task — detected by silence instead
        // of an exit. Same bounded fresh-session restarts, same budget; when
        // they run out, the task fails with the stall named as the cause.
        if (error instanceof SessionStalledError && crashRetries < MAX_CRASH_RETRIES) {
          crashRetries += 1;
          attempt -= 1;
          progress(context, {
            kind: "retry",
            message:
              `Claude Code session stalled (${Math.round(error.quietMs / 1000)}s without output); ` +
              `restarting in a fresh session, retry ${crashRetries}/${MAX_CRASH_RETRIES}`,
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

