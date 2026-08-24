/**
 * A stage's activity history as CSV — the feed's own rows, one line each, in
 * the same start order and with the same merged spans the feed shows. Built
 * from the sanitized wire shape, so nothing can land here that a connected
 * browser would not also be shown.
 */
import type { StageActivityEntry } from "@brainstorm-agentic/protocol";

const HEADER = [
  "time",
  "status",
  "kind",
  "role",
  "actor",
  "where",
  "message",
  "tool",
  "turn",
  "elapsed_ms",
  "tokens_in",
  "tokens_out",
  "capability",
  "detail_kind",
  "detail",
] as const;

/** RFC 4180: quote when the value carries a comma, a quote, or a newline. */
function cell(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The WHERE column as the feed prints it: `Seat 4 → step 5 > round 3`. */
function whereText(where: StageActivityEntry["where"]): string | undefined {
  if (where === undefined) return undefined;
  const parts: string[] = [];
  if (where.seat !== undefined) parts.push(where.seat);
  if (where.step !== undefined) parts.push(`step ${where.step}`);
  if (where.round !== undefined) parts.push(`round ${where.round}`);
  return parts.length > 0 ? parts.join(" > ") : undefined;
}

export function activityCsv(entries: readonly StageActivityEntry[]): string {
  const lines = [HEADER.join(",")];
  for (const entry of entries) {
    lines.push(
      [
        cell(new Date(entry.at).toISOString()),
        cell(entry.outcome),
        cell(entry.kind),
        cell(entry.role),
        cell(entry.actor),
        cell(whereText(entry.where)),
        cell(entry.message),
        cell(entry.toolName),
        cell(entry.turn),
        cell(entry.elapsedMs),
        cell(entry.usage?.inputTokens),
        cell(entry.usage?.outputTokens),
        cell(entry.capability),
        cell(entry.detail?.kind),
        cell(entry.detail?.value),
      ].join(","),
    );
  }
  // CRLF: RFC 4180's line ending, and what spreadsheet importers expect.
  return lines.join("\r\n") + "\r\n";
}
