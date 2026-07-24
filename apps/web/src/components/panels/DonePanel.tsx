/** Stage 8 — Done: the receipt with per-stage duration bars. */
import type { RunSummaryView } from "@brainstorm-agentic/protocol";
import { formatDuration, STAGE_TITLES } from "../../format";

export function DoneBody({ summary }: { summary: RunSummaryView }) {
  const durations = summary.stageDurations;
  const max = Math.max(1, ...durations.map((d) => d.durationMs));
  const total =
    summary.totalDurationMs ?? durations.reduce((acc, d) => acc + d.durationMs, 0);
  return (
    <div>
      <p className="receipt-line">
        <strong>Total {formatDuration(total)}</strong>
      </p>
      <div className="duration-list">
        {durations.map((d) => (
          <div key={d.stage} className="duration-row">
            <span className="duration-label">{STAGE_TITLES[d.stage]}</span>
            <span className="duration-track">
              <span
                className="duration-fill"
                style={{ width: `${Math.max(1, (d.durationMs / max) * 100)}%` }}
              />
            </span>
            <span className="duration-ms">{formatDuration(d.durationMs)}</span>
          </div>
        ))}
      </div>
      <p className="dim small">
        {summary.agentTaskCount} agent task{summary.agentTaskCount === 1 ? "" : "s"}
      </p>
    </div>
  );
}
