/** JSON-safe error snapshot used in results, events, and checkpoints. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

/** Base class for workflow runtime failures. */
export class WorkflowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid workflow definition, registration, or runner usage. */
export class WorkflowConfigError extends WorkflowError {}

/** Raised when a repeatUntil node is configured with onMaxIterations: "fail". */
export class MaxIterationsExceededError extends WorkflowError {
  constructor(
    readonly nodePath: string,
    readonly maxIterations: number,
  ) {
    super(`repeatUntil at "${nodePath}" exhausted maxIterations=${maxIterations} without satisfying its condition`);
  }
}

/** Raised by the agent node executor when an AgentExecutor reports failure. */
export class AgentTaskFailedError extends WorkflowError {
  constructor(
    readonly taskId: string,
    readonly taskError: SerializedError,
  ) {
    super(`agent task "${taskId}" failed: ${taskError.message}`);
  }
}

/** Deferred execution when a provider reports a known credit/session limit. */
export class CreditBlockedError extends Error {
  readonly name = "CreditBlockedError";

  constructor(
    /**
     * Epoch ms when an automatic resume may be submitted. Undefined when the
     * provider message carries no reset time (e.g. a developer-API "credit
     * balance is too low", which only a top-up clears): the block must then
     * be claimed manually instead of by the scheduler.
     */
    readonly retryAt: number | undefined,
    readonly providerMessage: string,
    readonly source: "deterministic" | "openrouter" | "manual",
  ) {
    super(
      retryAt !== undefined
        ? `Provider credit blocked until ${new Date(retryAt).toISOString()}: ${providerMessage}`
        : `Provider credit blocked until manually resumed: ${providerMessage}`,
    );
  }
}

export function isCreditBlocked(error: unknown): error is CreditBlockedError {
  if (error instanceof CreditBlockedError) return true;
  if (!(error instanceof Error) || error.name !== "CreditBlockedError") {
    return false;
  }
  const candidate = error as Partial<CreditBlockedError>;
  return (
    typeof candidate.providerMessage === "string" &&
    (typeof candidate.retryAt === "number" || candidate.retryAt === undefined)
  );
}

/** Cooperative cancellation. Also thrown by the runner when its AbortSignal fires. */
export class WorkflowCancelledError extends Error {
  constructor(message = "workflow run was cancelled") {
    super(message);
    this.name = "WorkflowCancelledError";
  }
}

/** Recognizes both core cancellation errors and standard AbortError instances. */
export function isCancellation(error: unknown): boolean {
  if (error instanceof WorkflowCancelledError) return true;
  return error instanceof Error && error.name === "AbortError";
}
