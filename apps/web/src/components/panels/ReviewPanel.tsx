/** Stage 6 — Review: the progress matrix (member × chain step) plus a round inspector. */
import { useState } from "react";
import type {
  CommentView,
  ReviewMemberView,
  ReviewRoundView,
  ReviewStage,
  ReviewStepView,
} from "@brainstorm-agentic/protocol";
import { EvidenceBlock, VerdictChip } from "../common";

function redevCount(step: ReviewStepView): number {
  return step.rounds.filter((r) => r.revision !== undefined).length;
}

function cellClass(step: ReviewStepView): string {
  switch (step.outcome) {
    case "under-review":
      return "cell-under-review pulse";
    case "passed":
      return "cell-passed";
    case "force-passed":
      return "cell-force-passed";
    case "pending":
      return "";
  }
}

function cellLabel(member: ReviewMemberView, step: ReviewStepView): string {
  const k = redevCount(step);
  const outcome =
    step.outcome === "force-passed"
      ? "force-passed at the round cap"
      : step.outcome === "passed" && k > 0
        ? `passed after ${k} redevelopment${k === 1 ? "" : "s"}`
        : step.outcome;
  return `${member.label}, step ${step.index}: ${outcome}`;
}

function CommentChipRow({ comments }: { comments: readonly CommentView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const openComment = open !== null ? comments.find((c) => c.commentorId === open) : undefined;
  return (
    <>
      <div className="comment-chip-row">
        {comments.map((c) => (
          <button
            key={c.commentorId}
            type="button"
            className={`comment-chip${open === c.commentorId ? " open" : ""}`}
            aria-expanded={open === c.commentorId}
            onClick={() => setOpen((prev) => (prev === c.commentorId ? null : c.commentorId))}
          >
            <span>{c.commentorLabel}</span>
            <VerdictChip verdict={c.verdict} />
          </button>
        ))}
      </div>
      {openComment && (
        <div className="comment-detail">
          <div>
            <span className="detail-label">reason</span>
            <div>{openComment.reason}</div>
          </div>
          {openComment.suggestion !== undefined && (
            <div>
              <span className="detail-label">suggestion</span>
              <div>{openComment.suggestion}</div>
            </div>
          )}
          {openComment.evidence && <EvidenceBlock evidence={openComment.evidence} />}
        </div>
      )}
    </>
  );
}

function RoundBlock({ round }: { round: ReviewRoundView }) {
  const labelOf = (commentorId: string): string =>
    round.comments.find((c) => c.commentorId === commentorId)?.commentorLabel ?? commentorId;
  const revision = round.revision;
  return (
    <div className="round-block">
      <span className="round-head">Round {round.round}</span>
      <CommentChipRow comments={round.comments} />
      {round.decision && (
        <div className="judge-card">
          <div className="judge-head">
            <strong>Judge</strong>
            <VerdictChip verdict={round.decision.verdict} />
          </div>
          <div>{round.decision.reason}</div>
          {round.decision.suggestion !== undefined && (
            <div>
              <span className="detail-label">suggestion</span>
              <div>{round.decision.suggestion}</div>
            </div>
          )}
          {Object.keys(round.decision.assessment).length > 0 && (
            <div className="assessment-row">
              {Object.entries(round.decision.assessment).map(([commentorId, kind]) => (
                <span
                  key={commentorId}
                  className={`badge${kind === "verified" ? " badge-accent" : ""}`}
                >
                  {labelOf(commentorId)} · {kind}
                </span>
              ))}
            </div>
          )}
          {round.decision.evidence && <EvidenceBlock evidence={round.decision.evidence} />}
        </div>
      )}
      {revision && (
        <div className="redev-bar">
          Re-developed from step {revision.fromStep} —{" "}
          {revision.fromStep > 1 ? `steps 1..${revision.fromStep - 1} frozen` : "no earlier steps frozen"}{" "}
          · {revision.revisedStepCount} step{revision.revisedStepCount === 1 ? "" : "s"} replaced
        </div>
      )}
    </div>
  );
}

export function ReviewBody({ stage }: { stage: ReviewStage }) {
  const [sel, setSel] = useState<{ memberId: string; step: number } | null>(null);
  const cursor = stage.cursor;

  const selMember = sel ? stage.members.find((m) => m.memberId === sel.memberId) : undefined;
  const selStep = selMember?.steps.find((s) => s.index === sel?.step);

  return (
    <div>
      {stage.status === "active" && cursor && (
        <p className="cursor-line">
          Reviewing member {cursor.member}/{cursor.memberCount} · step {cursor.step}/
          {cursor.stepCount} · round {cursor.round} of ≤{cursor.maxRounds}
        </p>
      )}
      <div className="matrix">
        {stage.members.map((member) => (
          <div key={member.memberId} className="matrix-row">
            <span className="matrix-label" title={member.label}>
              {member.label}
            </span>
            <div className="cells">
              {member.steps.map((step) => {
                const k = redevCount(step);
                const isSel = sel?.memberId === member.memberId && sel.step === step.index;
                return (
                  <button
                    key={step.index}
                    type="button"
                    className={`cell ${cellClass(step)}${isSel ? " cell-selected" : ""}`}
                    aria-label={cellLabel(member, step)}
                    onClick={() =>
                      setSel(isSel ? null : { memberId: member.memberId, step: step.index })
                    }
                  >
                    {k > 0 && <span className="cell-redev">×{k}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="matrix-caption">cell = one chain step · colors = how it passed</p>
      {selMember && selStep && (
        <div className="round-inspector">
          <div className="inspector-head">
            <span className="inspector-title">
              {selMember.label} · step {selStep.index}
            </span>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setSel(null)}>
              close
            </button>
          </div>
          {selStep.rounds.length === 0 ? (
            <p className="dim small">no review rounds recorded for this step yet</p>
          ) : (
            [...selStep.rounds]
              .sort((a, b) => b.round - a.round)
              .map((round) => <RoundBlock key={round.round} round={round} />)
          )}
        </div>
      )}
    </div>
  );
}
