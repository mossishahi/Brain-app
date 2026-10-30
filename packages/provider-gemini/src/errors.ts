export type GeminiErrorCategory = "aborted" | "authentication" | "permission" | "rate_limit" | "timeout" | "validation" | "network" | "server" | "unknown";

export class GeminiProviderError extends Error {
  readonly provider = "gemini";
  constructor(message: string, readonly category: GeminiErrorCategory, readonly transient: boolean,
    readonly status?: number, readonly retryAfterMs?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = category === "aborted" ? "AbortError" : "GeminiProviderError";
  }
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GeminiProviderError("Gemini request was cancelled.", "aborted", false);
}

/** Also settles promptly for an injected or older SDK that ignores its signal. */
export async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) void pending.catch(() => {});
  throwIfAborted(signal);
  if (!signal) return pending;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new GeminiProviderError("Gemini request was cancelled.", "aborted", false));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function retryDelay(value: Record<string, unknown>): number | undefined {
  const headers = value.headers;
  const get = record(headers).get;
  const raw = typeof get === "function" ? get.call(headers, "retry-after") : record(headers)["retry-after"];
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  // ApiError.message contains the service JSON, including google.rpc.RetryInfo.
  let body = value;
  if (typeof value.message === "string") {
    try { body = record(JSON.parse(value.message)); } catch { /* Not a JSON response. */ }
  }
  const details = record(body.error).details ?? body.details;
  if (Array.isArray(details)) for (const detail of details) {
    const delay = record(detail).retryDelay;
    if (typeof delay === "string" && /^\d+(?:\.\d+)?s$/.test(delay)) return Number(delay.slice(0, -1)) * 1000;
  }
  return undefined;
}

export function classifyGeminiError(error: unknown, signal?: AbortSignal): GeminiProviderError {
  if (signal?.aborted) return new GeminiProviderError("Gemini request was cancelled.", "aborted", false);
  if (error instanceof GeminiProviderError) return error;
  const value = record(error);
  if (value.name === "AbortError" || value.code === "ABORT_ERR") return new GeminiProviderError("Gemini request was cancelled.", "aborted", false);
  const status = typeof value.status === "number" ? value.status : typeof value.statusCode === "number" ? value.statusCode : undefined;
  const invalidKey = typeof value.message === "string" && /\bAPI_KEY_(?:INVALID|EXPIRED)\b/.test(value.message);
  const category: GeminiErrorCategory = status === 401 || invalidKey ? "authentication" : status === 403 ? "permission" : status === 429 ? "rate_limit" :
    status === 408 || value.name === "TimeoutError" || value.code === "ETIMEDOUT" ? "timeout" :
    status !== undefined && status >= 500 ? "server" : status !== undefined && status >= 400 && status < 500 ? "validation" :
    value.name === "TypeError" || ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(String(value.code)) ? "network" : "unknown";
  // Do not propagate raw SDK messages: gateways can echo headers, URLs or prompts.
  return new GeminiProviderError(`Gemini request failed (${category}${status === undefined ? "" : `, HTTP ${status}`}).`,
    category, ["rate_limit", "timeout", "server", "network"].includes(category), status, retryDelay(value));
}
