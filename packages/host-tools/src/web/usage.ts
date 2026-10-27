/**
 * The paid search fallback's local usage ledger.
 *
 * One JSON line per billed request, in
 * `<workspace>/web-usage/<provider>-<YYYY-MM>.jsonl` (UTC months). It stays
 * on this machine: the server reads a month's total to cap each new run
 * (the monthly budget), and a resumed run counts its own earlier requests
 * against its per-run budget. Unreadable lines are skipped, and a failed
 * write is reported, never thrown — the ledger is bookkeeping, not a gate
 * a search can fail on.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The UTC month of a moment, YYYY-MM. */
export function usageMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export function usageFile(workspaceRoot: string, provider: string, month: string): string {
  return join(workspaceRoot, "web-usage", `${provider}-${month}.jsonl`);
}

function entries(file: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

/** Billed requests of every run in the month of `now`. */
export function paidRequestsInMonth(workspaceRoot: string, provider: string, now: Date = new Date()): number {
  return entries(usageFile(workspaceRoot, provider, usageMonth(now))).length;
}

/** Billed requests one run already made (this month and the one before). */
export function paidRequestsOfRun(
  workspaceRoot: string,
  provider: string,
  runId: string,
  now: Date = new Date(),
): number {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [usageMonth(previous), usageMonth(now)].reduce(
    (sum, month) =>
      sum + entries(usageFile(workspaceRoot, provider, month)).filter((entry) => entry.runId === runId).length,
    0,
  );
}

/** Appends one billed request to its month's file. */
export function notePaidRequest(
  workspaceRoot: string,
  provider: string,
  runId: string,
  at: Date = new Date(),
): void {
  const file = usageFile(workspaceRoot, provider, usageMonth(at));
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: at.toISOString(), runId, provider })}\n`);
  } catch (error) {
    console.error(
      `[web] usage ledger not written (${file}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
