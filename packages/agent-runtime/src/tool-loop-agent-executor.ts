import type {
  AgentExecutionContext,
  AgentExecutor,
  AgentResult,
  AgentTask,
  CoreToolRegistry,
  JsonObject,
  JsonValue,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  TokenUsage,
  Tool,
  ToolDefinition,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
} from "./core-adapter.js";
import {
  addUsage,
  emptyUsage,
  isCancellation,
  satisfiesRequirements,
  serializeError,
  textBlock,
  toolCallDetail,
  toolUseBlocks,
} from "./core-adapter.js";
import {
  canonicalJsonStringify,
  DeterministicJsonTaskAdapter,
  type AgentTaskModelAdapter,
  type ModelRoute,
  type ModelRouteResolver,
} from "./agent-task-adapter.js";
import {
  AgentCancelledError,
  AgentRuntimeError,
  isAbortError,
  MaxTurnsExceededError,
  OutputValidationError,
  throwIfAborted,
} from "./errors.js";
import { ToolRegistry } from "./tool-registry.js";

export type OutputValidationResult<T extends JsonValue = JsonValue> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly issues: readonly string[] };

export interface OutputValidator<T extends JsonValue = JsonValue> {
  validate(
    value: JsonValue,
    schema: JsonObject,
    /**
     * The task the value answers. Supplied so a validator can check what the
     * schema alone cannot — a patch's coherence against the version it
     * revises (AgentTask.revisionBase) — while a retry is still possible.
     */
    task?: AgentTask,
  ):
    | boolean
    | OutputValidationResult<T>
    | Promise<boolean | OutputValidationResult<T>>;
}

export interface RetryPolicy {
  readonly maxTransientRetries?: number;
  /**
   * Separate, larger budget for rate-limit rejections (429s): a token
   * window lasts up to a minute, so waiting it out is deferred work, not a
   * failure. Each wait honors the provider's declared retry-after when the
   * error carries one (`retryAfterMs`).
   */
  readonly maxRateLimitRetries?: number;
  readonly maxValidationRetries?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly backoffMultiplier?: number;
  readonly isTransient?: (error: unknown) => boolean;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface ToolLoopAgentExecutorOptions<
  TOutput extends JsonValue = JsonValue,
> {
  readonly provider: ModelProvider;
  readonly tools: CoreToolRegistry;
  readonly modelRouteResolver: ModelRouteResolver;
  readonly taskAdapter?: AgentTaskModelAdapter;
  readonly outputValidator?: OutputValidator<TOutput>;
  readonly maxTurns?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly parallelToolCalls?: boolean;
  /**
   * Optional policy for registries other than this package's ToolRegistry.
   * Parallel execution remains disabled unless a tool is explicitly approved.
   */
  readonly isParallelSafe?: (tool: Tool) => boolean;
  readonly retry?: RetryPolicy;
  /**
   * Observability window onto the provider's request coordinator: when the
   * shared dispatch queue is paused (one task's 429 pauses everyone), the
   * executor narrates the wait as a status progress event instead of
   * leaving the activity feed silent. Purely informational — the provider
   * itself enforces the pause.
   */
  readonly dispatchGate?: {
    readonly blockedUntil: number;
    readonly blockReason: string;
  };
}

interface ExecutionState {
  usage: TokenUsage;
}

interface NormalizedValidation<T extends JsonValue> {
  readonly valid: boolean;
  readonly value?: T;
  readonly issues: readonly string[];
}

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 32;
const DEFAULT_TRANSIENT_RETRIES = 2;
const DEFAULT_RATE_LIMIT_RETRIES = 8;
/** A rate-limit wait never exceeds one full budget window. */
const RATE_LIMIT_MAX_DELAY_MS = 60_000;
const DEFAULT_VALIDATION_RETRIES = 1;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentRuntimeError(
      "Execution limits must be positive integers.",
      "INVALID_EXECUTOR_OPTIONS",
    );
  }
  return value;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentRuntimeError(
      "Retry limits must be non-negative integers.",
      "INVALID_EXECUTOR_OPTIONS",
    );
  }
  return value;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new AgentRuntimeError(
      "Retry delays must be finite non-negative numbers.",
      "INVALID_EXECUTOR_OPTIONS",
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorProperties(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};
}

function defaultTransientClassifier(error: unknown): boolean {
  const value = errorProperties(error);
  if (value.transient === true || value.retryable === true) {
    return true;
  }
  if (value.transient === false || value.retryable === false) {
    return false;
  }

  if (
    value.category === "network" ||
    value.category === "timeout" ||
    value.category === "rate_limit" ||
    value.category === "server"
  ) {
    return true;
  }
  if (
    value.category === "validation" ||
    value.category === "authentication" ||
    value.category === "permission"
  ) {
    return false;
  }

  const status = value.status ?? value.statusCode;
  if (typeof status === "number") {
    return (
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500
    );
  }
  return (
    value.code === "ETIMEDOUT" ||
    value.code === "ECONNRESET" ||
    value.code === "ECONNREFUSED" ||
    value.code === "EAI_AGAIN"
  );
}

async function abortableSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (delayMs === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AgentCancelledError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeValidation<T extends JsonValue>(
  result: boolean | OutputValidationResult<T>,
  originalValue: JsonValue,
): NormalizedValidation<T> {
  if (typeof result === "boolean") {
    return result
      ? { valid: true, value: originalValue as T, issues: [] }
      : {
          valid: false,
          issues: ["Output does not match the requested schema."],
        };
  }
  return result.success
    ? { valid: true, value: result.value, issues: [] }
    : { valid: false, issues: result.issues };
}

function validationFeedback(issues: readonly string[]): ModelMessage {
  return {
    role: "user",
    content: [
      textBlock(
        [
          "The previous answer did not match the required output schema.",
          ...issues.map((issue) => `- ${issue}`),
          "Return only a corrected answer that satisfies the schema.",
        ].join("\n"),
      ),
    ],
  };
}

function toolResultContent(output: JsonValue): readonly ReturnType<
  typeof textBlock
>[] {
  return [
    textBlock(
      typeof output === "string"
        ? output
        : canonicalJsonStringify(output),
    ),
  ];
}

function toolResultBlock(
  call: ToolUseBlock,
  result: ToolResult,
): ToolResultBlock {
  return {
    type: "tool_result",
    toolUseId: call.id,
    content:
      result.blocks !== undefined && result.blocks.length > 0
        ? result.blocks
        : toolResultContent(result.output),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

function failureToolResult(
  call: ToolUseBlock,
  message: string,
): ToolResultBlock {
  return toolResultBlock(call, { output: message, isError: true });
}

/**
 * A short, content-free hint of what a tool call targets (path, query, URL),
 * so progress events double as an access log of the files and sources agents
 * touch.
 */
function toolCallHint(input: JsonValue): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as { readonly [key: string]: JsonValue };
  for (const key of ["path", "file_path", "query", "url", "pattern", "prefix"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const text = value.trim();
      return text.length > 120 ? `${text.slice(0, 117)}…` : text;
    }
  }
  return undefined;
}

/**
 * Stepwise delivery contract read from AgentTask.metadata.stepwise: the model
 * must deliver `count` ordered items through the named virtual tool. The
 * executor records the calls and injects the collected texts into the final
 * structured output under `field` (plus any literal `inject` fields) before
 * output validation, so the chain the runtime reviews is assembled by the
 * orchestrator rather than self-reported inside the JSON answer.
 */
interface StepwiseSpec {
  readonly tool: string;
  readonly field: string;
  readonly count: number;
  /**
   * Sparse delivery: the model submits ONLY the positions it is changing,
   * ascending, and the host fills the rest from the version being revised.
   * The collected calls are injected as `{index, text}` records instead of a
   * flat list, so the host knows what was actually rewritten. Without this,
   * every position must be submitted and the field is the plain list.
   */
  readonly sparse?: boolean;
  readonly inject?: JsonObject;
}

interface StepwiseStep {
  readonly index: number;
  readonly text: string;
  readonly turn: number;
}

interface StepwiseSession {
  readonly spec: StepwiseSpec;
  readonly steps: StepwiseStep[];
  readonly turn: number;
}

function stepwiseSpec(task: AgentTask): StepwiseSpec | undefined {
  const raw = task.metadata?.stepwise;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as { readonly [key: string]: JsonValue };
  const { tool, field, count, sparse, inject } = record;
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

function stepwiseToolDefinition(spec: StepwiseSpec): ToolDefinition {
  return {
    name: spec.tool,
    description: spec.sparse
      ? `Submit one REWRITTEN step of the ${spec.count}-step chain. Call this tool once per step ` +
        `you are changing, in ascending order of index (1 through ${spec.count}), each call ` +
        `carrying exactly one paragraph. Submit only the steps you rewrite: every step you do ` +
        `not submit is carried over unchanged, word for word. At least one step must be ` +
        `submitted before the final structured answer.`
      : `Submit one step of your ${spec.count}-step chain. Call this tool once per step, strictly ` +
        `in order (index 1 through ${spec.count}), each call carrying exactly one paragraph. All ` +
        `${spec.count} steps must be submitted before the final structured answer.`,
    inputSchema: {
      type: "object",
      properties: {
        index: {
          type: "integer",
          minimum: 1,
          maximum: spec.count,
          description: spec.sparse
            ? "1-based position of the step being rewritten."
            : "1-based step position.",
        },
        text: {
          type: "string",
          minLength: 1,
          description: "The step: exactly one paragraph.",
        },
      },
      required: ["index", "text"],
      additionalProperties: false,
    },
  };
}

function recordStepwiseCall(
  call: ToolUseBlock,
  session: StepwiseSession,
): ToolResultBlock {
  const input =
    typeof call.input === "object" &&
    call.input !== null &&
    !Array.isArray(call.input)
      ? (call.input as { readonly [key: string]: JsonValue })
      : undefined;
  const last = session.steps[session.steps.length - 1];
  if (session.spec.sparse === true) {
    // Any subset, but strictly ascending and each position once: the host
    // applies them positionally, so an out-of-order or repeated index would
    // make the rewrite ambiguous.
    const index = input?.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 1 || index > session.spec.count) {
      return failureToolResult(
        call,
        `index must be a step position from 1 to ${session.spec.count}.`,
      );
    }
    if (last !== undefined && index <= last.index) {
      return failureToolResult(
        call,
        `Rewritten steps must be submitted in ascending order; step ${last.index} is already submitted.`,
      );
    }
    if (typeof input?.text !== "string" || input.text.trim().length === 0) {
      return failureToolResult(
        call,
        "text must carry the step as one non-empty paragraph.",
      );
    }
    session.steps.push({ index, text: input.text, turn: session.turn });
    return toolResultBlock(call, {
      output: { ok: true, recorded: index, rewritten: session.steps.length },
    });
  }
  const expected = session.steps.length + 1;
  if (expected > session.spec.count) {
    return failureToolResult(
      call,
      `All ${session.spec.count} steps are already submitted; return the final structured answer now.`,
    );
  }
  if (typeof input?.index !== "number" || input.index !== expected) {
    return failureToolResult(
      call,
      `Steps must be submitted strictly in order; expected index ${expected} next.`,
    );
  }
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    return failureToolResult(
      call,
      "text must carry the step as one non-empty paragraph.",
    );
  }
  session.steps.push({
    index: expected,
    text: input.text,
    turn: session.turn,
  });
  return toolResultBlock(call, {
    output: {
      ok: true,
      recorded: expected,
      remaining: session.spec.count - expected,
    },
  });
}

export class ToolLoopAgentExecutor<
  TOutput extends JsonValue = JsonValue,
> implements AgentExecutor {
  readonly #provider: ModelProvider;
  readonly #tools: CoreToolRegistry;
  readonly #routeResolver: ModelRouteResolver;
  readonly #taskAdapter: AgentTaskModelAdapter;
  readonly #validator?: OutputValidator<TOutput>;
  readonly #maxTurns: number;
  readonly #maxToolCallsPerTurn: number;
  readonly #parallelToolCalls: boolean;
  readonly #parallelSafety: (tool: Tool) => boolean;
  readonly #dispatchGate:
    | { readonly blockedUntil: number; readonly blockReason: string }
    | undefined;
  readonly #maxTransientRetries: number;
  readonly #maxRateLimitRetries: number;
  readonly #maxValidationRetries: number;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #backoffMultiplier: number;
  readonly #isTransient: (error: unknown) => boolean;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  public constructor(options: ToolLoopAgentExecutorOptions<TOutput>) {
    this.#provider = options.provider;
    this.#tools = options.tools;
    this.#routeResolver = options.modelRouteResolver;
    this.#taskAdapter =
      options.taskAdapter ?? new DeterministicJsonTaskAdapter();
    this.#validator = options.outputValidator;
    this.#maxTurns = positiveInteger(options.maxTurns, DEFAULT_MAX_TURNS);
    this.#maxToolCallsPerTurn = positiveInteger(
      options.maxToolCallsPerTurn,
      DEFAULT_MAX_TOOL_CALLS,
    );
    this.#parallelToolCalls = options.parallelToolCalls ?? true;
    this.#parallelSafety =
      options.isParallelSafe ??
      ((tool) =>
        options.tools instanceof ToolRegistry &&
        options.tools.isParallelSafe(tool.definition.name));
    this.#dispatchGate = options.dispatchGate;
    this.#maxTransientRetries = nonNegativeInteger(
      options.retry?.maxTransientRetries,
      DEFAULT_TRANSIENT_RETRIES,
    );
    this.#maxRateLimitRetries = nonNegativeInteger(
      options.retry?.maxRateLimitRetries,
      DEFAULT_RATE_LIMIT_RETRIES,
    );
    this.#maxValidationRetries = nonNegativeInteger(
      options.retry?.maxValidationRetries,
      DEFAULT_VALIDATION_RETRIES,
    );
    this.#initialDelayMs = finiteNonNegative(
      options.retry?.initialDelayMs,
      DEFAULT_INITIAL_DELAY_MS,
    );
    this.#maxDelayMs = finiteNonNegative(
      options.retry?.maxDelayMs,
      DEFAULT_MAX_DELAY_MS,
    );
    this.#backoffMultiplier = finiteNonNegative(
      options.retry?.backoffMultiplier,
      DEFAULT_BACKOFF_MULTIPLIER,
    );
    this.#isTransient =
      options.retry?.isTransient ?? defaultTransientClassifier;
    this.#sleep = options.retry?.sleep ?? abortableSleep;
  }

  public async execute(
    task: AgentTask,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    const state: ExecutionState = { usage: emptyUsage() };
    try {
      return await this.#executeTask(task, context, state);
    } catch (error) {
      if (isCancellation(error) || isAbortError(error)) {
        throw error;
      }
      if (context.signal?.aborted) {
        throw new AgentCancelledError(context.signal.reason ?? error);
      }
      return {
        taskId: task.taskId,
        status: "error",
        error: serializeError(error),
        usage: state.usage,
      };
    }
  }

  async #executeTask(
    task: AgentTask,
    context: AgentExecutionContext,
    state: ExecutionState,
  ): Promise<AgentResult> {
    throwIfAborted(context.signal);
    const route = await this.#routeResolver.resolve(task, context);
    throwIfAborted(context.signal);
    this.#validateRoute(route);

    if (task.requirements !== undefined) {
      const capabilities = await this.#provider.getCapabilities(route.modelId, {
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      if (
        capabilities === undefined ||
        !satisfiesRequirements(capabilities, task.requirements)
      ) {
        throw new AgentRuntimeError(
          `Model \`${route.modelId}\` does not satisfy task requirements.`,
          "MODEL_CAPABILITIES_UNSATISFIED",
        );
      }
    }

    const baseRequest = this.#taskAdapter.createRequest(task, context, route);
    if (baseRequest.modelId !== route.modelId) {
      throw new AgentRuntimeError(
        "Task adapter returned a model id different from the resolved route.",
        "INVALID_TASK_ADAPTER",
      );
    }

    const stepwise = stepwiseSpec(task);
    const steps: StepwiseStep[] = [];
    const thinkingSegments: { turn: number; text: string }[] = [];
    const allowedToolNames = task.tools ?? [];
    const registryDefinitions = this.#tools.definitions(allowedToolNames);
    const toolDefinitions =
      stepwise !== undefined
        ? [...registryDefinitions, stepwiseToolDefinition(stepwise)]
        : registryDefinitions;
    const allowedTools = new Set(
      stepwise !== undefined
        ? [...allowedToolNames, stepwise.tool]
        : allowedToolNames,
    );
    // A stepwise task needs at least one turn per step plus room for the
    // final answer and validation retries.
    const maxTurns =
      stepwise !== undefined
        ? Math.max(this.#maxTurns, stepwise.count * 2 + 4)
        : this.#maxTurns;
    const messages: ModelMessage[] = [...baseRequest.messages];
    const schema =
      baseRequest.responseFormat?.type === "jsonSchema"
        ? baseRequest.responseFormat.schema
        : undefined;
    if (schema !== undefined && this.#validator === undefined) {
      throw new AgentRuntimeError(
        "A validator is required for jsonSchema output.",
        "OUTPUT_VALIDATOR_REQUIRED",
      );
    }

    // One machine-readable record of how the broker resolved this task's
    // capabilities (provider-native / host tool / unavailable), so the event
    // log doubles as a per-role, per-node capability-usage ledger.
    if (task.capabilityPlan !== undefined) {
      context.reportProgress?.({
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

    let validationRetries = 0;
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      throwIfAborted(context.signal);
      context.reportProgress?.({
        kind: "model",
        turn,
        message: `Requesting model response · turn ${turn}`,
      });
      const request: ModelRequest = {
        ...baseRequest,
        messages: [...messages],
        tools: toolDefinitions,
      };
      const response = await this.#completeWithRetry(
        request,
        context,
        turn,
      );
      throwIfAborted(context.signal);
      state.usage = addUsage(state.usage, response.usage);
      messages.push({ role: "assistant", content: response.content });
      // Native reasoning traces (thinking blocks) are collected for artifact
      // capture; they never join the parsed output or progress events.
      for (const block of response.content) {
        if (block.type === "thinking" && block.text.trim().length > 0) {
          thinkingSegments.push({ turn, text: block.text });
          // This path does not stream, so the live thread grows a whole block at
          // a time instead of a fragment at a time — later than the SDK paths,
          // but the same thread and the same discard rule.
          context.reportLive?.(block.text);
        }
      }
      // Server tools ran inside the provider; surface each use as a tool
      // event so provider-native and host tools land in one usage ledger.
      // Providers that expose the call inputs (serverToolUseDetails) let the
      // event carry the operational detail — the query searched, the URL
      // fetched, the script executed — for the dashboard's capability icons.
      const serverToolDetails = response.metadata?.serverToolUseDetails;
      if (Array.isArray(serverToolDetails) && serverToolDetails.length > 0) {
        for (const entry of serverToolDetails) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
          const { name, input } = entry as { name?: JsonValue; input?: JsonValue };
          if (typeof name !== "string") continue;
          const detail = toolCallDetail(name, input);
          context.reportProgress?.({
            kind: "tool_end",
            toolName: name,
            turn,
            message: `${name} executed by the provider`,
            ...(detail ? { data: { detail: { ...detail } } } : {}),
          });
        }
      } else {
        const serverToolUses = response.metadata?.serverToolUses;
        if (Array.isArray(serverToolUses)) {
          for (const name of serverToolUses) {
            if (typeof name !== "string") continue;
            context.reportProgress?.({
              kind: "tool_end",
              toolName: name,
              turn,
              message: `${name} executed by the provider`,
            });
          }
        }
      }

      const calls = toolUseBlocks(response.content);
      if (calls.length > 0) {
        if (calls.length > this.#maxToolCallsPerTurn) {
          throw new AgentRuntimeError(
            `Model requested ${calls.length} tools; the per-turn limit is ${this.#maxToolCallsPerTurn}.`,
            "TOOL_CALL_LIMIT_EXCEEDED",
          );
        }
        const results = await this.#executeToolCalls(
          calls,
          allowedTools,
          task,
          context,
          stepwise !== undefined ? { spec: stepwise, steps, turn } : undefined,
        );
        messages.push({ role: "user", content: results });
        continue;
      }

      let output: JsonValue;
      try {
        output = this.#taskAdapter.responseToOutput(
          response,
          task,
          context,
          route,
        );
      } catch (error) {
        if (
          baseRequest.responseFormat === undefined ||
          baseRequest.responseFormat.type === "text"
        ) {
          throw error;
        }
        const issues = [errorMessage(error)];
        if (validationRetries >= this.#maxValidationRetries) {
          throw new OutputValidationError(issues, { cause: error });
        }
        validationRetries += 1;
        context.reportProgress?.({
          kind: "validation",
          turn,
          message: `Output format retry ${validationRetries}/${this.#maxValidationRetries}`,
        });
        messages.push(validationFeedback(issues));
        continue;
      }
      if (stepwise !== undefined) {
        const delivered =
          stepwise.sparse === true ? steps.length >= 1 : steps.length === stepwise.count;
        if (!delivered) {
          const issues = [
            stepwise.sparse === true
              ? `At least one rewritten step must be submitted through the ${stepwise.tool} tool ` +
                `before the final answer; none have been received. Submit every step your repair ` +
                `changes, then return the final answer again.`
              : `Exactly ${stepwise.count} steps must be submitted through the ${stepwise.tool} tool ` +
                `before the final answer; ${steps.length} have been received. Submit the missing ` +
                `steps in order, then return the complete final answer again.`,
          ];
          if (validationRetries >= this.#maxValidationRetries) {
            throw new OutputValidationError(issues);
          }
          validationRetries += 1;
          context.reportProgress?.({
            kind: "validation",
            turn,
            message: `Stepwise delivery retry ${validationRetries}/${this.#maxValidationRetries}`,
          });
          messages.push(validationFeedback(issues));
          continue;
        }
        // The orchestrator, not the model, assembles the reviewed chain: the
        // recorded steps (and any literal fields) are injected into the
        // output before validation.
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
      const traceExtras: JsonObject = {
        ...(thinkingSegments.length > 0
          ? { thinkingSegments: thinkingSegments as unknown as JsonValue }
          : {}),
        ...(stepwise !== undefined && steps.length > 0
          ? {
              stepTurns: steps.map(({ index, turn: stepTurn }) => ({
                index,
                turn: stepTurn,
              })) as unknown as JsonValue,
            }
          : {}),
      };
      if (schema === undefined) {
        return this.#successResult(
          task,
          response,
          output,
          state.usage,
          turn,
          validationRetries,
          traceExtras,
        );
      }

      const validation = await this.#validateOutput(output, schema, task);
      if (validation.valid) {
        context.reportProgress?.({
          kind: "validation",
          turn,
          message: "Structured output validated",
        });
        return this.#successResult(
          task,
          response,
          validation.value!,
          state.usage,
          turn,
          validationRetries,
          traceExtras,
        );
      }
      if (validationRetries >= this.#maxValidationRetries) {
        throw new OutputValidationError(validation.issues);
      }
      validationRetries += 1;
      context.reportProgress?.({
        kind: "validation",
        turn,
        message: `Artifact validation retry ${validationRetries}/${this.#maxValidationRetries}`,
      });
      messages.push(validationFeedback(validation.issues));
    }

    throw new MaxTurnsExceededError(maxTurns);
  }

  #validateRoute(route: ModelRoute): void {
    if (route.modelId.trim() === "") {
      throw new AgentRuntimeError(
        "Model route resolver returned an empty model id.",
        "INVALID_MODEL_ROUTE",
      );
    }
  }

  #successResult(
    task: AgentTask,
    response: ModelResponse,
    output: JsonValue,
    usage: TokenUsage,
    turns: number,
    validationRetries: number,
    extras: JsonObject = {},
  ): AgentResult {
    return {
      taskId: task.taskId,
      status: "ok",
      output,
      usage,
      metadata: {
        ...extras,
        providerId: response.providerId,
        modelId: response.modelId,
        turns,
        validationRetries,
      },
    };
  }

  async #completeWithRetry(
    request: ModelRequest,
    context: AgentExecutionContext,
    turn: number,
  ): Promise<ModelResponse> {
    let retries = 0;
    let rateLimitRetries = 0;
    for (;;) {
      throwIfAborted(context.signal);
      // A paused dispatch queue holds this call inside provider.complete
      // with no events of its own — narrate the wait so the activity feed
      // explains the quiet instead of implying a long model turn.
      const gate = this.#dispatchGate;
      if (gate !== undefined) {
        const pausedForMs = gate.blockedUntil - Date.now();
        if (pausedForMs > 1_000) {
          context.reportProgress?.({
            kind: "status",
            turn,
            message:
              `Dispatch paused (${gate.blockReason || "provider rate limit"}): ` +
              `resuming in ~${Math.max(1, Math.round(pausedForMs / 1000))}s — one task's ` +
              "rate-limit discovery pauses every pending request",
          });
        }
      }
      try {
        return await this.#provider.complete(request, {
          signal: context.signal,
        });
      } catch (error) {
        if (isCancellation(error) || isAbortError(error)) {
          throw error;
        }
        if (context.signal?.aborted) {
          throw new AgentCancelledError(context.signal.reason ?? error);
        }
        // Rate limits are deferred capacity, not flakiness: they get their
        // own larger budget, and each wait honors the provider's declared
        // retry-after (never exceeding one full budget window).
        const value = errorProperties(error);
        const rateLimited =
          value.category === "rate_limit" ||
          value.status === 429 ||
          value.statusCode === 429;
        if (rateLimited) {
          if (rateLimitRetries >= this.#maxRateLimitRetries) {
            throw error;
          }
          const declared =
            typeof value.retryAfterMs === "number" &&
            Number.isFinite(value.retryAfterMs) &&
            value.retryAfterMs > 0
              ? value.retryAfterMs
              : 0;
          const backoff = Math.min(
            this.#maxDelayMs,
            this.#initialDelayMs * this.#backoffMultiplier ** rateLimitRetries,
          );
          const delay = Math.min(
            RATE_LIMIT_MAX_DELAY_MS,
            Math.max(declared, backoff),
          );
          rateLimitRetries += 1;
          context.reportProgress?.({
            kind: "retry",
            turn,
            message:
              `Rate limited: retry ${rateLimitRetries}/${this.#maxRateLimitRetries} ` +
              `in ${Math.max(1, Math.round(delay / 1000))}s`,
          });
          await this.#sleep(delay, context.signal);
          throwIfAborted(context.signal);
          continue;
        }
        if (
          retries >= this.#maxTransientRetries ||
          !this.#isTransient(error)
        ) {
          throw error;
        }

        const delay = Math.min(
          this.#maxDelayMs,
          this.#initialDelayMs * this.#backoffMultiplier ** retries,
        );
        retries += 1;
        context.reportProgress?.({
          kind: "retry",
          turn,
          message: `Transient API retry ${retries}/${this.#maxTransientRetries} in ${delay}ms`,
        });
        await this.#sleep(delay, context.signal);
        throwIfAborted(context.signal);
      }
    }
  }

  async #validateOutput(
    output: JsonValue,
    schema: JsonObject,
    task: AgentTask,
  ): Promise<NormalizedValidation<TOutput>> {
    try {
      const result = await this.#validator!.validate(output, schema, task);
      return normalizeValidation(result, output);
    } catch (error) {
      return { valid: false, issues: [errorMessage(error)] };
    }
  }

  async #executeToolCalls(
    calls: readonly ToolUseBlock[],
    allowed: ReadonlySet<string>,
    task: AgentTask,
    context: AgentExecutionContext,
    stepwise?: StepwiseSession,
  ): Promise<readonly ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    const seenIds = new Set<string>();
    let index = 0;

    while (index < calls.length) {
      const call = calls[index]!;
      const tool = this.#tools.get(call.name);
      const canRunInParallel =
        this.#parallelToolCalls &&
        allowed.has(call.name) &&
        tool !== undefined &&
        this.#parallelSafety(tool);
      if (!canRunInParallel) {
        results.push(
          await this.#executeOneTool(
            call,
            allowed,
            seenIds,
            task,
            context,
            stepwise,
          ),
        );
        index += 1;
        continue;
      }

      const batch: ToolUseBlock[] = [];
      while (index < calls.length) {
        const candidate = calls[index]!;
        const candidateTool = this.#tools.get(candidate.name);
        if (
          !allowed.has(candidate.name) ||
          candidateTool === undefined ||
          !this.#parallelSafety(candidateTool)
        ) {
          break;
        }
        batch.push(candidate);
        index += 1;
      }
      results.push(
        ...(await Promise.all(
          batch.map((candidate) =>
            this.#executeOneTool(
              candidate,
              allowed,
              seenIds,
              task,
              context,
              stepwise,
            ),
          ),
        )),
      );
    }

    return results;
  }

  async #executeOneTool(
    call: ToolUseBlock,
    allowed: ReadonlySet<string>,
    seenIds: Set<string>,
    task: AgentTask,
    context: AgentExecutionContext,
    stepwise?: StepwiseSession,
  ): Promise<ToolResultBlock> {
    throwIfAborted(context.signal);
    if (seenIds.has(call.id)) {
      return failureToolResult(
        call,
        `Duplicate tool use id \`${call.id}\`.`,
      );
    }
    seenIds.add(call.id);
    if (!allowed.has(call.name)) {
      return failureToolResult(
        call,
        `Tool \`${call.name}\` is not permitted for this task.`,
      );
    }
    // The stepwise chain tool is virtual: recorded by the executor itself,
    // never dispatched to the host tool registry.
    if (stepwise !== undefined && call.name === stepwise.spec.tool) {
      const result = recordStepwiseCall(call, stepwise);
      context.reportProgress?.({
        kind: "tool_end",
        toolName: call.name,
        ...(result.isError === true ? { failed: true } : {}),
        message:
          result.isError === true
            ? `${call.name} rejected an out-of-order or empty step`
            : `Chain step ${stepwise.steps.length}/${stepwise.spec.count} recorded`,
      });
      return result;
    }

    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      return failureToolResult(
        call,
        `Tool \`${call.name}\` is not registered.`,
      );
    }

    const startedAt = Date.now();
    const hint = toolCallHint(call.input);
    // The structured counterpart of the message hint: the one input that
    // tells a reader what this call targeted, attached so the dashboard can
    // render per-activity capability detail. Content-bearing tools
    // (submit_step and kin) are excluded inside toolCallDetail.
    const detail = toolCallDetail(call.name, call.input);
    const detailData = detail ? { data: { detail: { ...detail } } } : {};
    context.reportProgress?.({
      kind: "tool_start",
      toolName: call.name,
      message: `Running ${call.name}${hint ? ` — ${hint}` : ""}`,
      ...detailData,
    });
    try {
      const result = await tool.execute(call.input, {
        runId: context.runId,
        taskId: task.taskId,
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      // A tool that answers isError has FAILED without throwing (a refused
      // path, a timed-out script); only a thrown error took the catch below.
      const refused = result.isError === true;
      context.reportProgress?.({
        kind: "tool_end",
        toolName: call.name,
        elapsedMs: Date.now() - startedAt,
        ...(refused ? { failed: true } : {}),
        message: `${call.name} ${refused ? "failed" : "completed"}${hint ? ` — ${hint}` : ""}`,
        ...detailData,
      });
      return toolResultBlock(call, result);
    } catch (error) {
      if (isCancellation(error) || isAbortError(error)) {
        throw error;
      }
      if (context.signal?.aborted) {
        throw new AgentCancelledError(context.signal.reason ?? error);
      }
      context.reportProgress?.({
        kind: "tool_end",
        toolName: call.name,
        elapsedMs: Date.now() - startedAt,
        failed: true,
        message: `${call.name} failed`,
        ...detailData,
      });
      return failureToolResult(call, errorMessage(error));
    }
  }
}

export function accumulateUsage(
  current: TokenUsage,
  addition: TokenUsage,
): TokenUsage {
  return addUsage(current, addition);
}
