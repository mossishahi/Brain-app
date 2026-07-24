export class AgentRuntimeError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}

export class AgentCancelledError extends AgentRuntimeError {
  public constructor(reason?: unknown) {
    super("Agent execution was cancelled.", "AGENT_CANCELLED", {
      cause: reason,
    });
    // Core recognizes standard AbortError instances as cooperative
    // cancellation and keeps them distinct from task failures.
    this.name = "AbortError";
  }
}

export class ToolRegistrationError extends AgentRuntimeError {
  public constructor(message: string) {
    super(message, "TOOL_REGISTRATION");
    this.name = "ToolRegistrationError";
  }
}

export class MaxTurnsExceededError extends AgentRuntimeError {
  public constructor(maxTurns: number) {
    super(
      `Agent did not produce a valid final response within ${maxTurns} turns.`,
      "MAX_TURNS_EXCEEDED",
    );
    this.name = "MaxTurnsExceededError";
  }
}

export class OutputValidationError extends AgentRuntimeError {
  public constructor(
    public readonly issues: readonly string[],
    options?: ErrorOptions,
  ) {
    super(
      `Agent output failed validation: ${issues.join("; ")}`,
      "OUTPUT_VALIDATION",
      options,
    );
    this.name = "OutputValidationError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AgentCancelledError(signal.reason);
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AgentCancelledError) {
    return true;
  }

  if (error !== null && typeof error === "object") {
    const candidate = error as { name?: unknown; code?: unknown };
    return (
      candidate.name === "AbortError" ||
      candidate.code === "ABORT_ERR" ||
      candidate.code === "AGENT_CANCELLED"
    );
  }

  return false;
}
