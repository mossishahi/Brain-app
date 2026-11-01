export type GeminiErrorCategory = "aborted" | "authentication" | "permission" | "rate_limit" | "quota_exhausted" | "timeout" | "validation" | "network" | "server" | "unknown";

export class GeminiProviderError extends Error {
  readonly provider = "gemini";
  constructor(message: string, readonly category: GeminiErrorCategory, readonly transient: boolean,
    readonly status?: number, readonly retryAfterMs?: number, options?: ErrorOptions, readonly retryAt?: number) {
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

function serviceDetails(value: Record<string, unknown>): readonly unknown[] {
  // ApiError.message contains the service JSON. Never expose that raw body.
  let body = value;
  if (typeof value.message === "string") {
    try { body = record(JSON.parse(value.message)); } catch { /* Not a JSON response. */ }
  }
  const details = record(body.error).details ?? body.details;
  return Array.isArray(details) ? details : [];
}

function retryInfoDelay(details: readonly unknown[]): number | undefined {
  for (const detail of details) {
    const info = record(detail);
    if (info["@type"] !== "type.googleapis.com/google.rpc.RetryInfo") continue;
    const delay = info.retryDelay;
    if (typeof delay !== "string" || !/^\d+(?:\.\d+)?s$/.test(delay)) continue;
    const milliseconds = Number(delay.slice(0, -1)) * 1000;
    if (Number.isFinite(milliseconds)) return milliseconds;
  }
  return undefined;
}

function retryDelay(value: Record<string, unknown>, details: readonly unknown[]): number | undefined {
  const headers = value.headers;
  const get = record(headers).get;
  const raw = typeof get === "function" ? get.call(headers, "retry-after") : record(headers)["retry-after"];
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n * 1000) && n >= 0) return n * 1000;
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return retryInfoDelay(details);
}

function dailyQuota(details: readonly unknown[]): { limit?: number; zero: boolean } | undefined {
  const violations = details.flatMap((detail) => {
    const quota = record(detail);
    return quota["@type"] === "type.googleapis.com/google.rpc.QuotaFailure" && Array.isArray(quota.violations)
      ? quota.violations.map(record).filter((violation) =>
        typeof violation.quotaId === "string" && /PerDay(?:Per|[-_]|$)/i.test(violation.quotaId)) : [];
  });
  if (violations.length === 0) return undefined;
  const limits = violations.map((violation) => {
    const raw = violation.quotaValue;
    const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }).filter((value): value is number => value !== undefined);
  return { ...(limits.length === 1 ? { limit: limits[0] } : {}), zero: limits.includes(0) };
}

export function classifyGeminiError(error: unknown, signal?: AbortSignal): GeminiProviderError {
  if (signal?.aborted) return new GeminiProviderError("Gemini request was cancelled.", "aborted", false);
  if (error instanceof GeminiProviderError) return error;
  const value = record(error);
  if (value.name === "AbortError" || value.code === "ABORT_ERR") return new GeminiProviderError("Gemini request was cancelled.", "aborted", false);
  const status = typeof value.status === "number" ? value.status : typeof value.statusCode === "number" ? value.statusCode : undefined;
  const invalidKey = typeof value.message === "string" && /\bAPI_KEY_(?:INVALID|EXPIRED)\b/.test(value.message);
  const details = serviceDetails(value);
  const quota = status === 429 ? dailyQuota(details) : undefined;
  const category: GeminiErrorCategory = status === 401 || invalidKey ? "authentication" : status === 403 ? "permission" : status === 429 ? quota ? "quota_exhausted" : "rate_limit" :
    status === 408 || value.name === "TimeoutError" || value.code === "ETIMEDOUT" ? "timeout" :
    status !== undefined && status >= 500 ? "server" : status !== undefined && status >= 400 && status < 500 ? "validation" :
    value.name === "TypeError" || ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(String(value.code)) ? "network" : "unknown";
  if (category === "quota_exhausted") {
    const delay = retryInfoDelay(details);
    // Only the provider's retry timing can schedule a resume. A zero allowance
    // needs an account change; a missing/invalid reset needs a manual retry.
    const candidate = delay === undefined || quota!.zero ? NaN : Math.ceil(Date.now() + delay + 1000);
    const retryAt = Number.isSafeInteger(candidate) && Number.isFinite(new Date(candidate).getTime()) ? candidate : undefined;
    const message = `Gemini daily API quota is exhausted${quota!.limit === undefined ? "" : ` (limit: ${quota!.limit})`}. ` +
      (retryAt === undefined ? "Automatic retry is unavailable; review the project's quota before retrying."
        : `Requests can resume after ${new Date(retryAt).toISOString()}.`);
    return new GeminiProviderError(message, category, false, status, delay, undefined, retryAt);
  }
  // Do not propagate raw SDK messages: gateways can echo headers, URLs or prompts.
  return new GeminiProviderError(`Gemini request failed (${category}${status === undefined ? "" : `, HTTP ${status}`}).`,
    category, ["rate_limit", "timeout", "server", "network"].includes(category), status, retryDelay(value, details));
}
