/**
 * Stage 6 — Review: the progress matrix (member × chain step) above the
 * per-step round sub-panels. Every reviewed step renders as a collapsible
 * sub-panel (rounds nested inside as their own folds) — nothing is hidden
 * behind the board; a matrix cell is a shortcut that toggles its step panel
 * and scrolls to it.
 */
import { useCallback, useRef, useState } from "react";
import type {
  CommentView,
  JudgeDecisionView,
  ReviewMemberView,
  ReviewRoundView,
  ReviewStage,
  ReviewStepView,
} from "@brainstorm-agentic/protocol";
import { prefersReducedMotion } from "../../format";
import { EvidenceBlock, VerdictChip } from "../common";
import { IdeaTabs } from "./FirstPassPanel";

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

/** A step earns a sub-panel once the review walk has reached it. */
function reviewable(step: ReviewStepView): boolean {
  return step.rounds.length > 0 || step.outcome === "under-review";
}

function stepKey(memberId: string, stepIndex: number): string {
  return `${memberId}:${stepIndex}`;
}

function roundKey(memberId: string, stepIndex: number, round: number): string {
  return `${memberId}:${stepIndex}:${round}`;
}

function finalKey(memberId: string): string {
  return `${memberId}:final`;
}

/** Every step of the member's walk has passed (or force-passed at the cap). */
function walkComplete(member: ReviewMemberView): boolean {
  return (
    member.steps.length > 0 &&
    member.steps.every(
      (step) => step.outcome === "passed" || step.outcome === "force-passed",
    )
  );
}

function StepOutcomeChip({ step }: { step: ReviewStepView }) {
  switch (step.outcome) {
    case "under-review":
      return <span className="step-chip step-chip-active">under review</span>;
    case "passed":
      return <span className="step-chip step-chip-ok">passed</span>;
    case "force-passed":
      return (
        <span className="step-chip step-chip-warn" title="force-passed at the round cap">
          force-passed
        </span>
      );
    case "pending":
      return null;
  }
}

/** One reviewer's comment as a stacked, collapsible inner panel (open by default). */
function CommentFold({ comment: c }: { comment: CommentView }) {
  return (
    <details className="review-fold" open>
      <summary className="review-fold-head">
        <span className="review-fold-name">{c.commentorLabel}</span>
        <VerdictChip verdict={c.verdict} />
        {c.step !== undefined && <span className="badge">step {c.step}</span>}
      </summary>
      <div className="review-fold-body">
        <div>
          <span className="detail-label">reason</span>
          <div>{c.reason}</div>
        </div>
        {c.suggestion !== undefined && (
          <div>
            <span className="detail-label">suggestion</span>
            <div>{c.suggestion}</div>
          </div>
        )}
        {c.evidence && <EvidenceBlock evidence={c.evidence} />}
      </div>
    </details>
  );
}

function JudgeFold({
  decision,
  labelOf,
}: {
  decision: JudgeDecisionView;
  labelOf: (commentorId: string) => string;
}) {
  return (
    <details className="review-fold review-fold-judge" open>
      <summary className="review-fold-head">
        <span className="review-fold-name">
          <strong>Judge</strong>
        </span>
        <VerdictChip verdict={decision.verdict} />
      </summary>
      <div className="review-fold-body">
        <div>{decision.reason}</div>
        {decision.suggestion !== undefined && (
          <div>
            <span className="detail-label">suggestion</span>
            <div>{decision.suggestion}</div>
          </div>
        )}
        {decision.issues !== undefined && decision.issues.length > 0 && (
          <div>
            <span className="detail-label">confirmed issues</span>
            {decision.issues.map((issue, index) => (
              <div key={index} className="comment-detail">
                <div className="assessment-row">
                  <span className="badge">step {issue.step}</span>
                  <span className={`badge${issue.basis === "verified" ? " badge-accent" : ""}`}>
                    {issue.basis}
                  </span>
                  {issue.mustAddress && <span className="badge">must address</span>}
                </div>
                <div>{issue.point}</div>
                {issue.suggestion !== undefined && <div className="dim small">{issue.suggestion}</div>}
                {issue.evidence && <EvidenceBlock evidence={issue.evidence} />}
              </div>
            ))}
          </div>
        )}
        {Object.keys(decision.assessment).length > 0 && (
          <div className="assessment-row">
            {Object.entries(decision.assessment).map(([commentorId, kind]) => (
              <span
                key={commentorId}
                className={`badge${kind === "verified" ? " badge-accent" : ""}`}
              >
                {labelOf(commentorId)} · {kind}
              </span>
            ))}
          </div>
        )}
        {decision.evidence && <EvidenceBlock evidence={decision.evidence} />}
      </div>
    </details>
  );
}

/** One review round as a collapsible sub-panel of its step. */
function RoundFold({
  round,
  open,
  onToggle,
}: {
  round: ReviewRoundView;
  open: boolean;
  onToggle: () => void;
}) {
  const labelOf = (commentorId: string): string =>
    round.comments.find((c) => c.commentorId === commentorId)?.commentorLabel ?? commentorId;
  const revision = round.revision;
  return (
    <details className="review-fold review-round" open={open}>
      <summary
        className="review-fold-head"
        onClick={(event) => {
          event.preventDefault();
          onToggle();
        }}
      >
        <span className="review-fold-name">Round {round.round}</span>
        {round.decision && <VerdictChip verdict={round.decision.verdict} />}
        {revision && <span className="badge">redeveloped</span>}
      </summary>
      {open && (
        <div className="review-fold-body">
          {round.cot !== undefined && (
            <div className="round-cot">
              <span className="detail-label">
                chain-of-thought step under review{round.round > 1 ? " (as revised)" : ""}
              </span>
              <div>{round.cot}</div>
            </div>
          )}
          {round.comments.map((c) => (
            <CommentFold key={c.commentorId} comment={c} />
          ))}
          {round.decision && <JudgeFold decision={round.decision} labelOf={labelOf} />}
          {revision && (
            <div className="redev-bar">
              {revision.touchedSteps.length === 0
                ? "Re-developed — no step text changed"
                : `Re-developed — step${revision.touchedSteps.length === 1 ? "" : "s"} ${revision.touchedSteps.join(", ")} rewritten, the rest carried verbatim`}
            </div>
          )}
        </div>
      )}
    </details>
  );
}

export function ReviewBody({ stage }: { stage: ReviewStage }) {
  const cursor = stage.cursor;
  // Fold state: user choices override the defaults (the step under review
  // opens itself and follows the walk; finished steps start collapsed;
  // rounds inside an open step start open).
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const stepRefs = useRef(new Map<string, HTMLElement | null>());

  const setFold = useCallback((key: string, open: boolean) => {
    setFolds((prev) => {
      const next = new Map(prev);
      next.set(key, open);
      return next;
    });
  }, []);

  const stepOpen = (member: ReviewMemberView, step: ReviewStepView): boolean =>
    folds.get(stepKey(member.memberId, step.index)) ?? step.outcome === "under-review";
  const roundOpen = (member: ReviewMemberView, step: ReviewStepView, round: number): boolean =>
    folds.get(roundKey(member.memberId, step.index, round)) ?? true;

  const onCellClick = (member: ReviewMemberView, step: ReviewStepView): void => {
    const key = stepKey(member.memberId, step.index);
    const opening = !stepOpen(member, step);
    setFold(key, opening);
    if (opening) {
      // After the fold expands, bring the step panel into view.
      requestAnimationFrame(() => {
        stepRefs.current.get(key)?.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "nearest",
        });
      });
    }
  };

  const sections = stage.members
    .map((member) => ({ member, steps: member.steps.filter(reviewable) }))
    .filter(({ steps }) => steps.length > 0);

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
            <span
              className="matrix-label"
              title={
                member.department && member.umbrella
                  ? `${member.label} — ${member.department} / ${member.umbrella}`
                  : member.label
              }
            >
              {member.label}
            </span>
            <div className="cells">
              {member.steps.map((step) => {
                const k = redevCount(step);
                const active = reviewable(step);
                const isOpen = active && stepOpen(member, step);
                return (
                  <button
                    key={step.index}
                    type="button"
                    className={`cell ${cellClass(step)}${isOpen ? " cell-selected" : ""}`}
                    aria-label={cellLabel(member, step)}
                    aria-expanded={active ? isOpen : undefined}
                    disabled={!active}
                    onClick={() => onCellClick(member, step)}
                  >
                    {k > 0 && <span className="cell-redev">×{k}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="matrix-caption">
        cell = one chain step · colors = how it passed · click a cell to fold its step open or
        closed
      </p>
      {sections.length === 0 ? (
        <p className="dim small">no review rounds recorded yet</p>
      ) : (
        <div className="review-steps">
          {sections.map(({ member, steps }) => (
            <div key={member.memberId} className="review-member">
              <div className="review-member-head">
                {member.label}
                {member.umbrella && (
                  <span className="review-member-sub">
                    {" — "}
                    {member.department ? `${member.department} / ` : ""}
                    {member.umbrella}
                  </span>
                )}
              </div>
              {steps.map((step) => {
                const key = stepKey(member.memberId, step.index);
                const open = stepOpen(member, step);
                const k = redevCount(step);
                return (
                  <details
                    key={key}
                    className="review-fold review-step"
                    open={open}
                    ref={(el) => {
                      stepRefs.current.set(key, el);
                    }}
                  >
                    <summary
                      className="review-fold-head"
                      onClick={(event) => {
                        event.preventDefault();
                        setFold(key, !open);
                      }}
                    >
                      <span className="review-fold-name">Step {step.index}</span>
                      <StepOutcomeChip step={step} />
                      <span className="review-step-meta">
                        {step.rounds.length === 0
                          ? "round 1 in progress"
                          : `${step.rounds.length} round${step.rounds.length === 1 ? "" : "s"}`}
                      </span>
                      {k > 0 && <span className="badge">×{k} redeveloped</span>}
                    </summary>
                    {open && (
                      <div className="review-fold-body">
                        {step.rounds.length === 0 ? (
                          <p className="dim small">no completed review rounds for this step yet</p>
                        ) : (
                          // Chronological: round 1 first, later rounds beneath it.
                          [...step.rounds]
                            .sort((a, b) => a.round - b.round)
                            .map((round) => (
                              <RoundFold
                                key={round.round}
                                round={round}
                                open={roundOpen(member, step, round.round)}
                                onToggle={() =>
                                  setFold(
                                    roundKey(member.memberId, step.index, round.round),
                                    !roundOpen(member, step, round.round),
                                  )
                                }
                              />
                            ))
                        )}
                      </div>
                    )}
                  </details>
                );
              })}
              {member.finalIdea && (() => {
                // The member's output as the review leaves it: the FINAL
                // version once every step passed; the current version under
                // review until then. Also saved as a readable copy under the
                // session's final/ directory.
                const finalized = walkComplete(member);
                const key = finalKey(member.memberId);
                const open = folds.get(key) ?? finalized;
                const revisions = member.revisionCount ?? 0;
                return (
                  <details className="review-fold review-final" open={open}>
                    <summary
                      className="review-fold-head"
                      onClick={(event) => {
                        event.preventDefault();
                        setFold(key, !open);
                      }}
                    >
                      <span className="review-fold-name">
                        <strong>{finalized ? "Final output" : "Output under review"}</strong>
                      </span>
                      {finalized ? (
                        <span className="step-chip step-chip-ok">final version</span>
                      ) : (
                        <span className="step-chip step-chip-active">in progress</span>
                      )}
                      <span className="review-step-meta">
                        {revisions > 0
                          ? `revised ×${revisions} during review`
                          : "unchanged from the first pass"}
                      </span>
                    </summary>
                    {open && (
                      <div className="review-fold-body">
                        <IdeaTabs idea={member.finalIdea} />
                      </div>
                    )}
                  </details>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
