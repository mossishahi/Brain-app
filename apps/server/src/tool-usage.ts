/**
 * Capability/tool usage aggregation over one job's event log.
 *
 * Two event families feed it:
 * - agent:progress "tool_end" events — one per completed tool call, covering
 *   host tools and provider-native server tools alike (executors emit both
 *   through the same channel); these may carry the call's operational detail
 *   (path/query/url/script) in data.detail, which this aggregate ignores —
 *   the per-activity dashboard rows render it instead;
 * - agent:progress "status" events carrying a `capabilityPlan` data payload —
 *   one per agent task, recording how the broker resolved each normalized
 *   operation (provider / host / unavailable).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ToolUsageReport } from "@brainstorm-agentic/protocol";

import { stageForPath } from "./stage-mapper.js";

type Counts = Record<string, number>;
type Matrix = Record<string, Counts>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bump(matrix: Matrix, row: string, column: string): void {
  const cells = (matrix[row] ??= {});
  cells[column] = (cells[column] ?? 0) + 1;
}

export function aggregateToolUsage(jobDir: string): ToolUsageReport {
  const totals: Counts = {};
  const failures: Counts = {};
  const byRole: Matrix = {};
  const byStage: Matrix = {};
  const capabilityResolution: Matrix = {};

  const path = join(jobDir, "events.jsonl");
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").split(/\r?\n/)
    : [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "agent:progress") continue;
    const progress = event.progress;
    if (!isRecord(progress)) continue;
    const role =
      typeof event.taskKind === "string"
        ? event.taskKind.replace(/^brainstorm\./, "")
        : "unknown";
    const stage =
      (typeof event.path === "string" ? stageForPath(event.path) : undefined) ??
      "other";

    if (progress.kind === "tool_end" && typeof progress.toolName === "string") {
      const tool = progress.toolName;
      totals[tool] = (totals[tool] ?? 0) + 1;
      // A refused or errored call is counted too — a call was made — but also
      // tallied apart, so "12 attachment reads" cannot stand for twelve reads
      // that were all denied.
      if (progress.failed === true) {
        failures[tool] = (failures[tool] ?? 0) + 1;
      }
      bump(byRole, role, tool);
      bump(byStage, stage, tool);
      continue;
    }

    if (progress.kind === "status" && isRecord(progress.data)) {
      const plan = progress.data.capabilityPlan;
      if (!Array.isArray(plan)) continue;
      for (const entry of plan) {
        if (!isRecord(entry)) continue;
        const operation = entry.operation;
        const source = entry.source;
        if (typeof operation !== "string" || typeof source !== "string") continue;
        bump(capabilityResolution, operation, source);
      }
    }
  }

  return { totals, failures, byRole, byStage, capabilityResolution };
}
