/**
 * Server-side reader of the run's unified web log (`searches.jsonl`, written
 * by the worker's WebAccessManager — see the worker's search-log.ts).
 *
 * Two views of the same file:
 * - the TABLE (`GET /api/jobs/:id/searches`): one compact row per call —
 *   who searched what, through which provider, what came of it — plus a CSV
 *   rendition for download. This is the unified cross-pipeline search table.
 * - the RAW LOG (`GET /api/jobs/:id/searches.jsonl`): the verbatim records,
 *   every character of every request and delivered payload, as a download.
 *
 * A torn trailing line (the worker batches appends) is skipped, never an
 * error; the next read sees it whole.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEARCH_LOG_FILE = "searches.jsonl";

export function searchLogPath(sessionDir: string): string {
  return join(sessionDir, SEARCH_LOG_FILE);
}

/** One parsed record, structurally checked just enough to build a row. */
interface ParsedRecord {
  readonly id?: unknown;
  readonly at?: unknown;
  readonly tool?: unknown;
  readonly outcome?: unknown;
  readonly request?: { readonly [key: string]: unknown };
  readonly response?: unknown;
  readonly provider?: unknown;
  readonly failedProviders?: unknown;
  readonly error?: unknown;
  readonly elapsedMs?: unknown;
  readonly coalescedWith?: unknown;
  readonly cacheKey?: unknown;
  readonly taskId?: unknown;
  readonly agentId?: unknown;
  readonly nodePath?: unknown;
  readonly route?: unknown;
  readonly redacted?: unknown;
  readonly costUsd?: unknown;
}

/** Every tool the web layer logs (web_check: the launch availability check). */
const LOGGED_TOOLS = [
  "web_search",
  "news_search",
  "paper_search",
  "paper_details",
  "web_fetch",
  "web_check",
] as const;
export type SearchLogTool = (typeof LOGGED_TOOLS)[number];

/** One row of the unified search table. */
export interface SearchTableRow {
  readonly id: string;
  readonly at: number;
  readonly tool: SearchLogTool;
  readonly outcome: "ok" | "cached" | "coalesced" | "error";
  /** The query searched, the identifiers looked up, or the URL fetched. */
  readonly subject: string;
  readonly kind?: string;
  readonly provider?: string;
  /**
   * Results (searches), papers (paper tools), delivered characters (fetch),
   * or sources checked (web_check).
   */
  readonly resultCount?: number;
  /** The coordinator's route: web, news, paper-lookup, paper-topic, paper-details. */
  readonly route?: string;
  /** Metered cost in USD (the paid fallback only). */
  readonly costUsd?: number;
  /** The provider's terms forbid keeping results: only URL hashes were logged. */
  readonly redacted?: boolean;
  readonly elapsedMs: number;
  readonly error?: string;
  /**
   * Every named failure this call saw, even when it still succeeded: the
   * providers that failed before one answered ("openalex: HTTP 429") and
   * the engines that failed INSIDE a metasearch answer ("google: CAPTCHA").
   */
  readonly failures?: string;
  readonly cacheKey?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly nodePath?: string;
}

/** One failure cause and how often the run saw it. */
export interface SearchFailureCount {
  readonly cause: string;
  readonly count: number;
}

export interface SearchTable {
  readonly entries: readonly SearchTableRow[];
  readonly total: number;
  /**
   * Every failure cause across the run, counted: failed calls by their
   * error, failed-over providers by their message, and metasearch engines
   * by their reason. This is the one place to see "google is CAPTCHA-blocked
   * on this deployment" without reading rows.
   */
  readonly failureSummary: readonly SearchFailureCount[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Reads the raw log text, or undefined when no call was ever made. */
export function readSearchLogText(sessionDir: string): string | undefined {
  try {
    return readFileSync(searchLogPath(sessionDir), "utf8");
  } catch {
    return undefined;
  }
}

/** The call's subject: what was searched, looked up, or fetched. */
function subjectOf(tool: SearchLogTool, request: { readonly [key: string]: unknown }): string {
  if (tool === "web_fetch") return str(request.url) ?? "";
  if (tool === "web_check") return "launch check";
  if (tool === "paper_details") {
    return Array.isArray(request.ids)
      ? request.ids.filter((id): id is string => typeof id === "string").join(", ")
      : "";
  }
  if (tool === "paper_search" && str(request.query) === undefined) {
    const native = request.native;
    return typeof native === "object" && native !== null
      ? (str((native as { query?: unknown }).query) ?? "")
      : "";
  }
  return str(request.query) ?? "";
}

/** How much the call delivered, per tool (see SearchTableRow.resultCount). */
function countOf(tool: SearchLogTool, response: unknown): number | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  if (Array.isArray(response)) return tool === "web_check" ? response.length : undefined;
  const record = response as { readonly [key: string]: unknown };
  if (tool === "web_fetch") return typeof record.text === "string" ? record.text.length : undefined;
  if (tool === "paper_search" || tool === "paper_details") {
    return Array.isArray(record.papers) ? record.papers.length : undefined;
  }
  if (Array.isArray(record.results)) return record.results.length;
  return typeof record.resultCount === "number" ? record.resultCount : undefined;
}

/** The named failures one record carries, as "who: why" strings. */
function failuresOf(parsed: ParsedRecord): string[] {
  const causes: string[] = [];
  if (Array.isArray(parsed.failedProviders)) {
    for (const entry of parsed.failedProviders) {
      if (typeof entry !== "object" || entry === null) continue;
      const provider = str((entry as { provider?: unknown }).provider);
      const error = str((entry as { error?: unknown }).error);
      if (provider !== undefined) causes.push(`${provider}: ${error ?? "failed"}`);
    }
  }
  const response = parsed.response;
  if (typeof response === "object" && response !== null) {
    const engineFailures = (response as { engineFailures?: unknown }).engineFailures;
    if (Array.isArray(engineFailures)) {
      for (const entry of engineFailures) {
        if (typeof entry !== "object" || entry === null) continue;
        const engine = str((entry as { engine?: unknown }).engine);
        const reason = str((entry as { reason?: unknown }).reason);
        if (engine !== undefined) causes.push(`${engine}: ${reason ?? "unresponsive"}`);
      }
    }
  }
  return causes;
}

export function readSearchTable(sessionDir: string): SearchTable {
  const raw = readSearchLogText(sessionDir);
  if (raw === undefined) return { entries: [], total: 0, failureSummary: [] };
  const entries: SearchTableRow[] = [];
  const failureCounts = new Map<string, number>();
  const countFailure = (cause: string): void => {
    failureCounts.set(cause, (failureCounts.get(cause) ?? 0) + 1);
  };
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: ParsedRecord;
    try {
      parsed = JSON.parse(line) as ParsedRecord;
    } catch {
      continue; // a torn trailing line is not worth failing the table over
    }
    const id = str(parsed.id);
    const tool = parsed.tool;
    const outcome = parsed.outcome;
    if (
      id === undefined ||
      typeof tool !== "string" ||
      !(LOGGED_TOOLS as readonly string[]).includes(tool) ||
      (outcome !== "ok" && outcome !== "cached" && outcome !== "coalesced" && outcome !== "error")
    ) {
      continue;
    }
    const loggedTool = tool as SearchLogTool;
    const request = parsed.request ?? {};
    const subject = subjectOf(loggedTool, request);
    const resultCount = countOf(loggedTool, parsed.response);
    const failures = failuresOf(parsed);
    for (const cause of failures) countFailure(cause);
    const error = str(parsed.error);
    if (outcome === "error") {
      countFailure(`${tool} failed: ${error ?? "unknown cause"}`);
    }
    entries.push({
      id,
      at: typeof parsed.at === "number" ? parsed.at : 0,
      tool: loggedTool,
      outcome,
      subject,
      ...(str(request.kind) !== undefined ? { kind: str(request.kind) } : {}),
      ...(str(parsed.provider) !== undefined ? { provider: str(parsed.provider) } : {}),
      ...(resultCount !== undefined ? { resultCount } : {}),
      elapsedMs: typeof parsed.elapsedMs === "number" ? parsed.elapsedMs : 0,
      ...(error !== undefined ? { error } : {}),
      ...(failures.length > 0 ? { failures: failures.join(" · ") } : {}),
      ...(str(parsed.cacheKey) !== undefined ? { cacheKey: str(parsed.cacheKey) } : {}),
      ...(str(parsed.taskId) !== undefined ? { taskId: str(parsed.taskId) } : {}),
      ...(str(parsed.agentId) !== undefined ? { agentId: str(parsed.agentId) } : {}),
      ...(str(parsed.nodePath) !== undefined ? { nodePath: str(parsed.nodePath) } : {}),
      ...(str(parsed.route) !== undefined ? { route: str(parsed.route) } : {}),
      ...(typeof parsed.costUsd === "number" ? { costUsd: parsed.costUsd } : {}),
      ...(parsed.redacted === true ? { redacted: true } : {}),
    });
  }
  const failureSummary = [...failureCounts.entries()]
    .map(([cause, count]): SearchFailureCount => ({ cause, count }))
    .sort((left, right) => right.count - left.count || left.cause.localeCompare(right.cause));
  return { entries, total: entries.length, failureSummary };
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The same table as CSV, one row per call, for spreadsheet analysis. */
export function searchTableCsv(table: SearchTable): string {
  const header = [
    "time",
    "tool",
    "outcome",
    "kind",
    "provider",
    "subject",
    "results",
    "elapsed_ms",
    "agent",
    "task",
    "node_path",
    "cache_key",
    "error",
    "failures",
    "route",
    "cost_usd",
  ].join(",");
  const rows = table.entries.map((row) =>
    [
      csvCell(row.at > 0 ? new Date(row.at).toISOString() : ""),
      csvCell(row.tool),
      csvCell(row.outcome),
      csvCell(row.kind),
      csvCell(row.provider),
      csvCell(row.subject),
      csvCell(row.resultCount),
      csvCell(row.elapsedMs),
      csvCell(row.agentId),
      csvCell(row.taskId),
      csvCell(row.nodePath),
      csvCell(row.cacheKey),
      csvCell(row.error),
      csvCell(row.failures),
      csvCell(row.route),
      csvCell(row.costUsd),
    ].join(","),
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}
