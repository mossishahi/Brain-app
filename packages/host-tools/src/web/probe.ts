/**
 * Probe support shared by every source check (availability spec, Section 2):
 * one known-answer request with a timeout (8 s; arXiv 15 s), its outcome
 * mapped onto a source state, and the ordered log lines produced while
 * probing — request summary with secrets redacted, response status, counts,
 * timing, error text. The log never contains a key or token.
 *
 * The request log is collected without threading a logger through every
 * backend: a backend wraps its fetch with `loggingFetch`, and a check runs
 * its request inside `runProbe`, which installs a ProbeLog for the duration
 * of that call (AsyncLocalStorage). Outside a probe the wrapped fetch is a
 * pass-through, so live calls are unchanged.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { WebSourceStatus } from "@brainstorm-agentic/core";

import type { ProviderFetch, WebSearchProvider } from "./providers.js";

/** protocol's ToolProbeLogLine, restated (host-tools does not depend on protocol). */
export interface ProbeLogLine {
  readonly at: number;
  readonly level: "info" | "warn" | "error";
  readonly text: string;
}

/** A source status with the probe's log and latency, when a probe produced it. */
export interface WebSourceStatusWithLog extends WebSourceStatus {
  readonly log?: readonly ProbeLogLine[];
  readonly latencyMs?: number;
}

/** Probe timeouts: 8 s, arXiv 15 s (its API answers slowly). */
export const PROBE_TIMEOUT_MS = 8_000;
export const ARXIV_PROBE_TIMEOUT_MS = 15_000;

/** Query parameters that carry credentials: their values never reach a log. */
const SECRET_PARAMS = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|authorization|secret|password|mailto)$/i;

/** The URL with credential-bearing query values replaced by "<redacted>". */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_PARAMS.test(name)) parsed.searchParams.set(name, "<redacted>");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|mailto)=)[^&#]*/gi, "$1<redacted>");
  }
}

/** `text` with every given secret value replaced by "<redacted>". */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.trim() === "") continue;
    out = out.split(secret).join("<redacted>");
  }
  return out;
}

/** The ordered log of one probe. Every line passes through secret redaction. */
export class ProbeLog {
  readonly lines: ProbeLogLine[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly secrets: readonly (string | undefined)[] = [],
  ) {}

  note(level: ProbeLogLine["level"], text: string): void {
    this.lines.push({ at: this.now(), level, text: redactSecrets(text, this.secrets) });
  }

  info(text: string): void {
    this.note("info", text);
  }

  warn(text: string): void {
    this.note("warn", text);
  }

  error(text: string): void {
    this.note("error", text);
  }
}

const currentProbe = new AsyncLocalStorage<ProbeLog>();

/** Runs `work` with `log` receiving every request made through a `loggingFetch`. */
export function withProbeLog<T>(log: ProbeLog, work: () => Promise<T>): Promise<T> {
  return currentProbe.run(log, work);
}

/**
 * A fetch that, inside `withProbeLog`, logs each request (method and
 * redacted URL; never headers or bodies) and each response (status, timing)
 * or failure. Outside a probe it is a pass-through.
 */
export function loggingFetch(fetchImpl: ProviderFetch): ProviderFetch {
  return async (url, init) => {
    const log = currentProbe.getStore();
    if (log === undefined) return fetchImpl(url, init);
    const started = Date.now();
    log.info(`${init.method ?? "GET"} ${redactUrl(url)}`);
    try {
      const response = await fetchImpl(url, init);
      log.note(response.status >= 400 ? "warn" : "info", `HTTP ${response.status} in ${Date.now() - started} ms`);
      return response;
    } catch (error) {
      log.error(`request failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
}

/**
 * Maps a probe's failure onto a source state (spec Section 2). `keyed` says
 * whether the request carried a credential: then a 403 means the key was
 * refused (needs-key); for a keyless request a 403 is a block.
 */
export function probeStateFromError(id: string, error: unknown, checkedAt: number, keyed = true): WebSourceStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401\b/.test(message) || (keyed && /API key/i.test(message))) {
    return { id, state: "needs-key", detail: message, checkedAt };
  }
  if (/HTTP 403\b|captcha|blocked/i.test(message)) return { id, state: "blocked", detail: message, checkedAt };
  // The service is up but throttled or briefly unavailable: degraded, not dead.
  if (/HTTP (429|503)\b/.test(message)) return { id, state: "degraded", detail: message, checkedAt };
  // The service answered; only the known record was missing.
  if (/HTTP 404\b/.test(message)) {
    return { id, state: "degraded", detail: `answered without the known record (${message})`, checkedAt };
  }
  return { id, state: "unreachable", detail: message, checkedAt };
}

export interface ProbeOptions {
  /** The caller's abort signal; the probe adds its own timeout. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Clock (ms) for checkedAt, latency and log timestamps. */
  readonly now?: () => number;
  /** Secret values that must never appear in the log. */
  readonly secrets?: readonly (string | undefined)[];
  /** One-line description of the request, for the first log line. */
  readonly request?: string;
}

/** What one known-answer request found. */
export interface ProbeFinding {
  readonly ok: boolean;
  /** For the log on success ("1 paper, known title found"). */
  readonly summary?: string;
  /** The status detail; on a miss, why the answer fell short. */
  readonly detail?: string;
}

/**
 * Runs one known-answer probe: logs the request, bounds it by the timeout,
 * maps the finding (or the failure) onto a status, and attaches the log and
 * the latency. Never throws.
 */
export async function runProbe(
  id: string,
  options: ProbeOptions,
  work: (signal: AbortSignal) => Promise<ProbeFinding>,
): Promise<WebSourceStatusWithLog> {
  const now = options.now ?? (() => Date.now());
  const log = new ProbeLog(now, options.secrets ?? []);
  const checkedAt = now();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeout]) : timeout;
  log.info(`probe ${id}: ${options.request ?? "known-answer request"} (timeout ${Math.round(timeoutMs / 1000)} s)`);
  try {
    const finding = await withProbeLog(log, () => work(signal));
    const latencyMs = now() - checkedAt;
    if (finding.ok) {
      log.info(`${finding.summary ?? "known answer found"}; ${latencyMs} ms`);
      return {
        id,
        state: "available",
        checkedAt,
        ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
        latencyMs,
        log: log.lines,
      };
    }
    const detail = finding.detail ?? "answered without the known answer";
    log.warn(`${detail}; ${latencyMs} ms`);
    return { id, state: "degraded", detail, checkedAt, latencyMs, log: log.lines };
  } catch (error) {
    const latencyMs = now() - checkedAt;
    const status: WebSourceStatus =
      timeout.aborted && options.signal?.aborted !== true
        ? { id, state: "unreachable", detail: `timed out after ${Math.round(timeoutMs / 1000)} s`, checkedAt }
        : probeStateFromError(id, error, checkedAt, (options.secrets ?? []).some((secret) => secret !== undefined && secret !== ""));
    log.error(`${status.state}: ${status.detail ?? "failed"}; ${latencyMs} ms`);
    return { ...status, latencyMs, log: log.lines };
  }
}

/** The known answer every general web provider is probed with. */
export const KNOWN_WEB_ANSWER = {
  query: "Attention Is All You Need Vaswani arXiv 1706.03762",
  expect: /arxiv\.org|semanticscholar\.org|neurips\.cc|nips\.cc|papers\.nips\.cc|wikipedia\.org/i,
} as const;

/**
 * Gives a general web provider a `check`: one known-answer search of five
 * results, available when one of the top hits is the known target, degraded
 * when it answered without it.
 */
export function withSearchProbe(
  provider: WebSearchProvider,
  options: { readonly secrets?: readonly (string | undefined)[]; readonly timeoutMs?: number } = {},
): WebSearchProvider {
  return {
    ...provider,
    async check(signal) {
      return runProbe(
        provider.id,
        {
          ...(signal !== undefined ? { signal } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
          request: `web search "${KNOWN_WEB_ANSWER.query}"`,
        },
        async (probe) => {
          const answer = await provider.search({
            query: KNOWN_WEB_ANSWER.query,
            kind: "general",
            maxResults: 5,
            route: "web",
            signal: probe,
          });
          const top = answer.hits.slice(0, 5);
          const ok = top.some((hit) => KNOWN_WEB_ANSWER.expect.test(hit.url));
          const failures = (answer.engineFailures ?? []).map((failure) => `${failure.engine}: ${failure.reason}`);
          return {
            ok,
            summary: `${answer.hits.length} hits, known target found${failures.length > 0 ? ` (engine failures: ${failures.join("; ")})` : ""}`,
            ...(ok
              ? {}
              : {
                  detail:
                    answer.hits.length === 0
                      ? `answered with no hits${failures.length > 0 ? ` (${failures.join("; ")})` : ""}`
                      : `answered ${answer.hits.length} hits without the known target`,
                }),
          };
        },
      );
    },
  };
}
