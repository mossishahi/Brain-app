export type AnthropicErrorCategory =
  | "aborted"
  | "authentication"
  | "permission"
  | "rate_limit"
  | "timeout"
  | "validation"
  | "network"
  | "server"
  | "unknown";

export class AnthropicProviderError extends Error {
  public readonly provider = "anthropic";

  public constructor(
    message: string,
    public readonly category: AnthropicErrorCategory,
    public readonly transient: boolean,
    public readonly status?: number,
    public readonly code?: string,
    public readonly requestId?: string,
    /**
     * The wait the provider itself declared (a rate-limit response's
     * retry-after), in milliseconds. Retry layers sleep at least this long
     * instead of probing the wall with their own backoff guesses.
     */
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = category === "aborted" ? "AbortError" : "AnthropicProviderError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringProperty(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") {
      return value[key] as string;
    }
  }
  return undefined;
}

function numericProperty(
  value: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    if (typeof value[key] === "number") {
      return value[key] as number;
    }
  }
  return undefined;
}

/**
 * One header's value, whatever shape the SDK handed us: a fetch Headers
 * instance (get()) or a plain record (either case).
 */
function headerValue(headers: unknown, name: string): string | undefined {
  if (headers !== null && typeof headers === "object") {
    const getter = (headers as { get?: (key: string) => unknown }).get;
    if (typeof getter === "function") {
      const found = getter.call(headers, name);
      return typeof found === "string" ? found : undefined;
    }
    const record = headers as Record<string, unknown>;
    const found = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
    return typeof found === "string" ? found : undefined;
  }
  return undefined;
}

/** retry-after as milliseconds: delta seconds, or an HTTP date. */
function retryAfterMsFrom(headers: unknown): number | undefined {
  const raw = headerValue(headers, "retry-after");
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim()) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const wait = at - Date.now();
  return wait > 0 ? wait : undefined;
}

function classifyStatus(status: number | undefined): {
  category: AnthropicErrorCategory;
  transient: boolean;
} | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (status === 401) {
    return { category: "authentication", transient: false };
  }
  if (status === 403) {
    return { category: "permission", transient: false };
  }
  if (status === 408) {
    return { category: "timeout", transient: true };
  }
  if (status === 409 || status === 425 || status === 429) {
    return {
      category: status === 429 ? "rate_limit" : "server",
      transient: true,
    };
  }
  if (status >= 500) {
    return { category: "server", transient: true };
  }
  if (status === 400 || status === 404 || status === 422) {
    return { category: "validation", transient: false };
  }
  return { category: "unknown", transient: false };
}

export function classifyAnthropicError(
  error: unknown,
  signal?: AbortSignal,
): AnthropicProviderError {
  if (error instanceof AnthropicProviderError) {
    return error;
  }

  const value = asRecord(error);
  const name = stringProperty(value, "name");
  const status = numericProperty(value, "status", "statusCode");
  const code = stringProperty(value, "code", "errorCode");
  const headers = asRecord(value.headers);
  const retryAfterMs = retryAfterMsFrom(value.headers);
  const requestId =
    stringProperty(value, "requestId", "request_id") ??
    stringProperty(headers, "request-id", "x-request-id");
  const message =
    error instanceof Error
      ? error.message
      : stringProperty(value, "message") ?? "Anthropic request failed.";

  if (
    signal?.aborted ||
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    code === "ERR_ABORTED"
  ) {
    return new AnthropicProviderError(
      "Anthropic request was cancelled.",
      "aborted",
      false,
      status,
      code,
      requestId,
      undefined,
      { cause: error },
    );
  }

  const byStatus = classifyStatus(status);
  if (byStatus !== undefined) {
    return new AnthropicProviderError(
      message,
      byStatus.category,
      byStatus.transient,
      status,
      code,
      requestId,
      retryAfterMs,
      { cause: error },
    );
  }

  if (
    name === "APIConnectionTimeoutError" ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT"
  ) {
    return new AnthropicProviderError(
      message,
      "timeout",
      true,
      status,
      code,
      requestId,
      undefined,
      { cause: error },
    );
  }
  if (
    name === "APIConnectionError" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN"
  ) {
    return new AnthropicProviderError(
      message,
      "network",
      true,
      status,
      code,
      requestId,
      undefined,
      { cause: error },
    );
  }

  return new AnthropicProviderError(
    message,
    "unknown",
    false,
    status,
    code,
    requestId,
    undefined,
    { cause: error },
  );
}
