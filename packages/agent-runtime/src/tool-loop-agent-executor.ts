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
  ):
    | boolean
    | OutputValidationResult<T>
    | Promise<boolean | OutputValidationResult<T>>;
}

export interface RetryPolicy {
  readonly maxTransientRetries?: number;
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
  readonly #maxTransientRetries: number;
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
    this.#maxTransientRetries = nonNegativeInteger(
      options.retry?.maxTransientRetries,
      DEFAULT_TRANSIENT_RETRIES,
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

    const allowedToolNames = task.tools ?? [];
    const toolDefinitions = this.#tools.definitions(allowedToolNames);
    const allowedTools = new Set(allowedToolNames);
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

    let validationRetries = 0;
    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
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
      if (schema === undefined) {
        return this.#successResult(
          task,
          response,
          output,
          state.usage,
          turn,
          validationRetries,
        );
      }

      const validation = await this.#validateOutput(output, schema);
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

    throw new MaxTurnsExceededError(this.#maxTurns);
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
  ): AgentResult {
    return {
      taskId: task.taskId,
      status: "ok",
      output,
      usage,
      metadata: {
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
    for (;;) {
      throwIfAborted(context.signal);
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
  ): Promise<NormalizedValidation<TOutput>> {
    try {
      const result = await this.#validator!.validate(output, schema);
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
          await this.#executeOneTool(call, allowed, seenIds, task, context),
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

    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      return failureToolResult(
        call,
        `Tool \`${call.name}\` is not registered.`,
      );
    }

    const startedAt = Date.now();
    const hint = toolCallHint(call.input);
    context.reportProgress?.({
      kind: "tool_start",
      toolName: call.name,
      message: `Running ${call.name}${hint ? ` — ${hint}` : ""}`,
    });
    try {
      const result = await tool.execute(call.input, {
        runId: context.runId,
        taskId: task.taskId,
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      context.reportProgress?.({
        kind: "tool_end",
        toolName: call.name,
        elapsedMs: Date.now() - startedAt,
        message: `${call.name} completed${hint ? ` — ${hint}` : ""}`,
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
        message: `${call.name} failed`,
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
