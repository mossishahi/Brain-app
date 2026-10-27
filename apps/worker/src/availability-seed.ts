/**
 * The worker's side of the tool availability service (availability spec,
 * Sections 3e and 5; contract C). At start a run reads the server's table at
 * the server-supplied instance path (or `<workspace>/availability.json` for
 * standalone workers) when it is younger than 30 minutes, seeds
 * its web manager with the table's web-source statuses (a fresh available or
 * degraded status stands in for that source's launch probe) and takes the
 * derived per-purpose orders as its route lists. The run's own live status
 * changes (a 429 demotion, a block, a recovery, a launch-check outcome) are
 * appended to `<workspace>/availability-events.jsonl` as
 * `{at, runId, status}` lines — append-only and best effort: a failing
 * append is announced once and never fails the run.
 */
import { appendFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { WebSearchRoute, WebSourceState, WebSourceStatus } from "@brainstorm-agentic/core";

export const AVAILABILITY_FILE = "availability.json";
export const AVAILABILITY_EVENTS_FILE = "availability-events.jsonl";
/** A table older than this is ignored: the run probes for itself. */
export const AVAILABILITY_MAX_AGE_MS = 30 * 60_000;

/** The purposes that are web-layer routes (citation-hop and embedding are not). */
const WEB_ROUTES: ReadonlySet<string> = new Set<WebSearchRoute>(["web", "news", "paper-lookup", "paper-topic", "paper-details"]);

export interface AvailabilitySeed {
  /** The table's updatedAt (epoch ms). */
  readonly updatedAt: number;
  /** Web-source statuses (tool groups "search" and "papers"), as the web manager takes them. */
  readonly seededStatuses: readonly WebSourceStatus[];
  /** The derived effective order of every web-layer purpose the table carries. */
  readonly routeOrders: Partial<Record<WebSearchRoute, readonly string[]>>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** protocol ToolState -> core WebSourceState ("disabled" is the web layer's "not-configured"). */
function sourceStateOf(state: unknown): WebSourceState | undefined {
  switch (state) {
    case "available":
    case "degraded":
    case "blocked":
    case "unreachable":
    case "needs-key":
    case "unchecked":
      return state;
    case "disabled":
      return "not-configured";
    default:
      return undefined;
  }
}

/** One ToolAvailability row as a WebSourceStatus; children become engines. */
function sourceStatusOf(tool: Record<string, unknown>): WebSourceStatus | undefined {
  if (typeof tool.id !== "string" || tool.id === "") return undefined;
  const state = sourceStateOf(tool.state);
  if (state === undefined) return undefined;
  const engines = (Array.isArray(tool.children) ? tool.children : []).flatMap((child) => {
    const status = sourceStatusOf(asRecord(child));
    return status !== undefined ? [status] : [];
  });
  return {
    id: tool.id,
    state,
    ...(typeof tool.detail === "string" ? { detail: tool.detail } : {}),
    ...(typeof tool.checkedAt === "number" ? { checkedAt: tool.checkedAt } : {}),
    ...(typeof tool.until === "number" ? { until: tool.until } : {}),
    ...(engines.length > 0 ? { engines } : {}),
  };
}

/**
 * Parses an availability.json (protocol AvailabilityReport, version 1).
 * Undefined when the text is not such a report or the report is older than
 * `maxAgeMs` at `now`.
 */
export function parseAvailabilitySeed(text: string, now: number, maxAgeMs = AVAILABILITY_MAX_AGE_MS): AvailabilitySeed | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const report = asRecord(parsed);
  if (report.version !== 1 || typeof report.updatedAt !== "number") return undefined;
  if (now - report.updatedAt > maxAgeMs) return undefined;
  const seededStatuses = (Array.isArray(report.tools) ? report.tools : []).flatMap((entry) => {
    const tool = asRecord(entry);
    if (tool.group !== undefined && tool.group !== "search" && tool.group !== "papers") return [];
    const status = sourceStatusOf(tool);
    return status !== undefined ? [status] : [];
  });
  const routeOrders: Partial<Record<WebSearchRoute, readonly string[]>> = {};
  for (const entry of Array.isArray(report.purposes) ? report.purposes : []) {
    const purpose = asRecord(entry);
    if (typeof purpose.purpose !== "string" || !WEB_ROUTES.has(purpose.purpose)) continue;
    if (!Array.isArray(purpose.effective) || !purpose.effective.every((id) => typeof id === "string")) continue;
    routeOrders[purpose.purpose as WebSearchRoute] = [...(purpose.effective as string[])];
  }
  return { updatedAt: report.updatedAt, seededStatuses, routeOrders };
}

/**
 * Reads the server-selected file, or the legacy workspace file for standalone
 * workers. An absent/unreadable/malformed/stale explicit file means no seed;
 * it never falls back to another server's shared workspace record.
 */
export function readAvailabilitySeed(
  workspaceRoot: string,
  now: number = Date.now(),
  maxAgeMs = AVAILABILITY_MAX_AGE_MS,
  filePath = join(workspaceRoot, AVAILABILITY_FILE),
): AvailabilitySeed | undefined {
  try {
    return parseAvailabilitySeed(readFileSync(filePath, "utf8"), now, maxAgeMs);
  } catch {
    return undefined;
  }
}

/** Async variant of readAvailabilitySeed. */
export async function loadAvailabilitySeed(
  workspaceRoot: string,
  now: number = Date.now(),
  maxAgeMs = AVAILABILITY_MAX_AGE_MS,
  filePath = join(workspaceRoot, AVAILABILITY_FILE),
): Promise<AvailabilitySeed | undefined> {
  try {
    return parseAvailabilitySeed(await readFile(filePath, "utf8"), now, maxAgeMs);
  } catch {
    return undefined;
  }
}

/** One line of `<workspace>/availability-events.jsonl`. */
export interface AvailabilityEvent {
  readonly at: number;
  readonly runId: string;
  readonly status: WebSourceStatus;
}

/**
 * A status-change listener that appends `{at, runId, status}` lines to
 * `<workspace>/availability-events.jsonl`, in order, without blocking the
 * caller. Best effort: the first failing append is announced through `log`,
 * later ones are silent, and the returned `flush` resolves once every queued
 * line has been written or failed.
 */
export function availabilityEventWriter(
  workspaceRoot: string,
  runId: string,
  options: { readonly now?: () => number; readonly log?: (line: string) => void } = {},
): ((status: WebSourceStatus) => void) & { readonly flush: () => Promise<void>; readonly path: string } {
  const path = join(workspaceRoot, AVAILABILITY_EVENTS_FILE);
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.error(line));
  let warned = false;
  let queue: Promise<void> = Promise.resolve();
  const write = (status: WebSourceStatus): void => {
    const event: AvailabilityEvent = { at: now(), runId, status };
    const line = `${JSON.stringify(event)}\n`;
    queue = queue
      .then(() => appendFile(path, line))
      .catch((error: unknown) => {
        if (warned) return;
        warned = true;
        log(`[availability] could not append to ${path}: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  return Object.assign(write, { flush: () => queue, path });
}
