/**
 * Capability & tool usage: which tools (host and provider-native) each role
 * actually called, per dashboard stage, plus how the broker resolved every
 * declared capability operation — surfacing at a glance when a capability
 * silently ran in "unavailable" honesty mode.
 */
import { useEffect, useRef, useState } from "react";
import type { ToolUsageReport } from "@brainstorm-agentic/protocol";
import { errorMessage, getToolUsage } from "../../api";

/** Minimum ms between refetches while job snapshots stream in. */
const REFRESH_MIN_MS = 5_000;

function columns(matrix: Readonly<Record<string, Readonly<Record<string, number>>>>): string[] {
  const names = new Set<string>();
  for (const cells of Object.values(matrix)) {
    for (const name of Object.keys(cells)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function UsageMatrix({
  title,
  matrix,
}: {
  title: string;
  matrix: Readonly<Record<string, Readonly<Record<string, number>>>>;
}) {
  const tools = columns(matrix);
  const rows = Object.keys(matrix).sort((a, b) => a.localeCompare(b));
  if (rows.length === 0) return null;
  return (
    <div>
      <span className="detail-label">{title}</span>
      <table className="paper-table">
        <thead>
          <tr>
            <th />
            {tools.map((tool) => (
              <th key={tool}>{tool}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <td>{row}</td>
              {tools.map((tool) => (
                <td key={tool}>{matrix[row]?.[tool] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ToolUsagePanel({
  jobId,
  updatedAt,
  active,
}: {
  jobId: string;
  updatedAt: number;
  /** True while the job is running: keeps the report polling during long tasks. */
  active: boolean;
}) {
  const [report, setReport] = useState<ToolUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastFetch = useRef(0);

  useEffect(() => {
    let live = true;
    const fetchNow = (force: boolean) => {
      if (!force && Date.now() - lastFetch.current < REFRESH_MIN_MS) return;
      lastFetch.current = Date.now();
      getToolUsage(jobId)
        .then((usage) => {
          if (!live) return;
          setReport(usage);
          setError(null);
        })
        .catch((e: unknown) => {
          if (live) setError(errorMessage(e));
        });
    };
    fetchNow(report === null);
    // updatedAt only advances on status transitions and checkpoint saves; a
    // minutes-long agent task streams tool events without moving either, so
    // while the job runs the panel polls on its own clock instead of waiting
    // for a snapshot bump that may never come.
    const timer = active ? setInterval(() => fetchNow(false), REFRESH_MIN_MS) : undefined;
    return () => {
      live = false;
      if (timer !== undefined) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch keyed on job progress
  }, [jobId, updatedAt, active]);

  if (error) return <p className="dim small">tool usage unavailable: {error}</p>;
  if (!report) return null;

  const totalCalls = Object.values(report.totals).reduce((sum, count) => sum + count, 0);
  const unavailable = Object.entries(report.capabilityResolution)
    .filter(([, sources]) => (sources.unavailable ?? 0) > 0)
    .map(([operation, sources]) => ({ operation, tasks: sources.unavailable ?? 0 }));

  return (
    <div className="tool-usage">
      {unavailable.length > 0 && (
        <p className="dim small">
          resolved as unavailable:{" "}
          {unavailable
            .map((entry) => `${entry.operation} (${entry.tasks} tasks)`)
            .join(", ")}{" "}
          — those agents were instructed not to fabricate the missing capability
        </p>
      )}
      {totalCalls === 0 ? (
        <p className="dim small">no tool calls recorded yet</p>
      ) : (
        <>
          <UsageMatrix title="calls by role" matrix={report.byRole} />
          <UsageMatrix title="calls by stage" matrix={report.byStage} />
        </>
      )}
      <UsageMatrix title="capability resolution (tasks)" matrix={report.capabilityResolution} />
    </div>
  );
}
