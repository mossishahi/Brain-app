/** Stage 3 — Panel selection: seat cards; selection history is never rewritten. */
import type { SelectPanelStage } from "@brainstorm-agentic/protocol";
import { SeatCard } from "../common";

export function SelectPanelBody({
  stage,
  removedIds,
}: {
  stage: SelectPanelStage;
  removedIds: ReadonlySet<string>;
}) {
  const panel = stage.panel ?? [];
  return (
    <div>
      {/* Wide cards, one per row: a seat's identity is a few short lines,
          and the wrapped grid read as a mosaic rather than a roster. */}
      <div className="seat-grid seat-stack">
        {panel.map((member, i) => (
          <SeatCard key={member.id} seat={i + 1} member={member} removed={removedIds.has(member.id)} />
        ))}
      </div>
      <p className="footnote">
        {stage.leavesAvailable !== undefined
          ? `Selected round-robin from ${stage.leavesAvailable} umbrella leaves, capped at ${panel.length} seats.`
          : `Selected round-robin from the umbrella leaves, capped at ${panel.length} seats.`}
      </p>
    </div>
  );
}
