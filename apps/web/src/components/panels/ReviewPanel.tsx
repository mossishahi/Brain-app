/**
 * Stage 6 — Review: the progress matrix (member × chain step) above the
 * seat-paged walk inspector.
 *
 * The inspector is a three-level card system:
 *  - SEATS page horizontally (prev/next buttons; one seat's walk at a time);
 *  - STEPS stack vertically inside the visible seat, one card per
 *    chain-of-thought step;
 *  - ROUNDS sit inside each step card as a deck of sub-cards, newest on top,
 *    paged with prev/next buttons (never scrolled). The deck's base is the
 *    "Original thought" card — the step's first-pass text at full weight;
 *    every later card shows the text as that version left it, carried words
 *    dimmed and its own changes at full weight, plus a collapsed comments
 *    panel whose tags switch between the judge (default) and each commentor.
 *    A rewrite another walk position applied to this step is ITS OWN card in
 *    the deck, in chronological position, labeled "changed by step N", its
 *    changed words colored by direction (prospective dark blue, retroactive
 *    red); the originating round keeps only a one-line note naming the step
 *    it rewrote.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  CommentView,
  FirstPassStage,
  JudgeDecisionView,
  ReviewMemberView,
  ReviewRoundView,
  ReviewStage,
  ReviewStepView,
} from "@brainstorm-agentic/protocol";
import { prefersReducedMotion } from "../../format";
import {
  downloadTextFile,
  seatNumberOf,
  seatOutputToLatex,
  seatTexFileName,
} from "../../latex";
import { LATEX_STYLE } from "../../latex-style";
import { EvidenceBlock, TokenChip } from "../common";
import { BackIcon, CopyIcon, DownloadIcon, ForwardIcon } from "../Icons";
import { IdeaTabs } from "./FirstPassPanel";
import {
  computeSeatTimeline,
  deckEntries,
  reviewedBy,
  roundViewKey,
  type CrossRewriteView,
  type DiffSegment,
  type RoundComputedView,
  type SeatTimeline,
} from "./review-diff";

function redevCount(step: ReviewStepView): number {
  return step.rounds.filter((r) => r.revision !== undefined).length;
}

/** A step a dismissed seat will never finish: it stopped where it stood. */
function unreached(step: ReviewStepView): boolean {
  return step.outcome === "pending" || step.outcome === "under-review";
}

function cellClass(step: ReviewStepView, dismissed = false): string {
  // A dismissed seat is not working, so the step it stopped on must stop
  // pulsing: a blinking cell on a seat that has left says work is in flight
  // when none is. Everything it never finished is marked instead.
  if (dismissed && unreached(step)) return "cell-dismissed";
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
    member.dismissed !== undefined && unreached(step)
      ? "never reviewed — the seat was dismissed"
      : step.outcome === "force-passed"
        ? "force-passed at the round cap"
        : step.outcome === "passed" && k > 0
          ? `passed after ${k} redevelopment${k === 1 ? "" : "s"}`
          : step.outcome;
  return `${member.label}, step ${step.index}: ${outcome}`;
}

/**
 * What a step's rounds add up to, in words.
 *
 * A round only counts once it reached a verdict. Counting every RECORDED round
 * included one still gathering comments, so a step with three settled rounds and
 * a fourth in flight read "4 rounds" beside a deck of three — and a dismissed
 * seat's abandoned round read as progress that will never come.
 */
function settledRounds(step: ReviewStepView): number {
  return step.rounds.filter((round) => round.decision !== undefined).length;
}

/**
 * What is still happening to this step — and nothing about what already did.
 *
 * A count of rounds used to sit here, and it read as a contradiction however it
 * was computed: the deck holds one card per VERSION of the step, and the last
 * round of a position never writes one (it either passed or hit the cap), so a
 * step reviewed four times pages to "Round 3 / 3" and a header saying "4 rounds"
 * looks like a missing card. The two numbers count different things, and putting
 * them side by side invited exactly that comparison. How many times the step was
 * reviewed now rides the step title's hover, where nothing indexes against it,
 * and the deck's own numbering is the only count on screen.
 */
function roundsMeta(
  step: ReviewStepView,
  dismissed: boolean,
  crossCount: number,
): string {
  const settled = settledRounds(step);
  const pendingRound = step.rounds.length > settled;
  if (!pendingRound && !(crossCount > 0 && step.outcome === "under-review")) return "";
  return dismissed
    ? `round ${settled + 1} unfinished`
    : `round ${settled + 1} in progress`;
}

/** One phrase for what a seat is doing, shared by the pager chip and the popover. */
function seatStateLabel(member: ReviewMemberView): string {
  if (member.dismissed !== undefined) return "dismissed";
  if (member.error !== undefined) return "failed";
  if (member.progress !== undefined) return "under review";
  return walkComplete(member) ? "done with thinking" : "waiting";
}

/**
 * The seat's own control, reached by hovering (or focusing) its name in the
 * matrix — the one place every seat is visible at once, so stopping one reads as
 * an act on the panel rather than a button buried in a card.
 *
 * The popover is position:fixed and a DOM CHILD of the name, so moving the
 * pointer from the name into the popover keeps it open (the matrix scrolls, and
 * an anchored child would be clipped). It asks before acting: a dismissal cannot
 * be undone, and the question says what it costs.
 */
function SeatStopPopover({
  member,
  seatState,
  expertise,
  onDismiss,
}: {
  member: ReviewMemberView;
  seatState: string;
  expertise: string;
  onDismiss: (memberId: string) => Promise<void>;
}) {
  const [pop, setPop] = useState<CSSProperties | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = (target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    setPop({
      left: Math.max(8, rect.left),
      ...(rect.bottom + 200 > window.innerHeight
        ? { bottom: window.innerHeight - rect.top - 2 }
        : { top: rect.bottom - 2 }),
    });
  };
  const close = (): void => {
    // A half-answered question must not persist into the next hover.
    if (busy) return;
    setPop(null);
    setConfirming(false);
    setError(null);
  };
  return (
    <span
      className="seat-stop"
      onMouseEnter={(event) => open(event.currentTarget)}
      onMouseLeave={close}
      onFocus={(event) => open(event.currentTarget)}
      onBlur={close}
      tabIndex={0}
    >
      {member.label}
      {pop && (
        <span className="seat-stop-pop" style={pop} role="dialog">
          <span className="seat-stop-head">
            <span className="seat-stop-name">{member.label}</span>
            <span className="dim">{seatState}</span>
          </span>
          {expertise !== "" && <span className="dim">{expertise}</span>}
          {member.dismissed !== undefined ? (
            <span className="dim">
              Dismissed. What it recorded before then is kept below.
            </span>
          ) : confirming ? (
            <>
              <span>
                Stop {member.label}? It contributes and reviews nothing further
                for the rest of the run, and work in flight on the other seats
                restarts from the last checkpoint.
              </span>
              {error !== null && <span className="error-text">{error}</span>}
              <span className="inline-actions">
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void onDismiss(member.memberId)
                      .then(() => {
                        setConfirming(false);
                        setPop(null);
                      })
                      .catch((e: unknown) =>
                        setError(e instanceof Error ? e.message : String(e)),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy ? "Stopping…" : "Yes, stop it"}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  No
                </button>
              </span>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setConfirming(true)}
            >
              Stop this seat
            </button>
          )}
        </span>
      )}
    </span>
  );
}

/** A step has something to inspect once the review walk has reached it. */
function reviewable(step: ReviewStepView): boolean {
  return step.rounds.length > 0 || step.outcome === "under-review";
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

/* The step's outcome is carried by the COLOR of its "Step X" title. */
function stepTitleClass(step: ReviewStepView): string {
  switch (step.outcome) {
    case "under-review":
      return "step-title-active";
    case "passed":
      return "step-title-ok";
    case "force-passed":
      return "step-title-warn";
    case "pending":
      return "step-title-dim";
  }
}

function stepOutcomeHint(step: ReviewStepView): string {
  const outcome =
    step.outcome === "force-passed" ? "force-passed at the round cap" : step.outcome;
  // The review count belongs here rather than beside the deck: the last round of
  // a position writes no new version, so this number is legitimately larger than
  // the number of cards and must not sit next to them.
  const settled = settledRounds(step);
  if (settled === 0) return outcome;
  return `${outcome} · reviewed ${settled} time${settled === 1 ? "" : "s"}`;
}

/**
 * Copies text for pasting into a bug report. The async clipboard API needs a
 * secure context and can be denied outright; the hidden-textarea copy still
 * works on a real click, and a bug-report affordance must not fail silently.
 */
async function copyForBugReport(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copy-to-clipboard ghost button with the app's transient "copied" state. */
function CopyButton({ text, label }: { text: () => string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost-btn copy-btn"
      aria-label={label}
      title={label}
      onClick={() => {
        void copyForBugReport(text()).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <span className="small">copied</span> : <CopyIcon />}
    </button>
  );
}

function segmentSpans(segments: readonly DiffSegment[], changedClass: string) {
  return segments.map((segment, index) => (
    <span key={index} className={segment.changed ? changedClass : "diff-keep"}>
      {index > 0 ? " " : ""}
      {segment.text}
    </span>
  ));
}

/** The judge's decision, rendered flat inside the comments panel. */
function JudgeContent({
  decision,
  labelOf,
}: {
  decision: JudgeDecisionView;
  labelOf: (commentorId: string) => string;
}) {
  // No verdict chip here: the colored name on the summary row IS the verdict.
  return (
    <div className="comment-content">
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
              {issue.suggestion !== undefined && (
                <div className="dim small">{issue.suggestion}</div>
              )}
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
  );
}

function CommentContent({ comment }: { comment: CommentView }) {
  // No verdict chip here: the colored name on the summary row IS the verdict.
  return (
    <div className="comment-content">
      {(comment.step !== undefined || comment.usage !== undefined) && (
        <div className="assessment-row">
          {comment.step !== undefined && (
            <span className="badge">step {comment.step}</span>
          )}
          {comment.usage && <TokenChip usage={comment.usage} />}
        </div>
      )}
      <div>
        <span className="detail-label">reason</span>
        <div>{comment.reason}</div>
      </div>
      {comment.suggestion !== undefined && comment.suggestion !== "" && (
        <div>
          <span className="detail-label">suggestion</span>
          <div>{comment.suggestion}</div>
        </div>
      )}
      {comment.evidence && <EvidenceBlock evidence={comment.evidence} />}
    </div>
  );
}

function commentCopyText(selected: "judge" | string, round: ReviewRoundView): string {
  if (selected === "judge") {
    const d = round.decision;
    if (!d) return `round ${round.round}: judgement in progress`;
    const issues = (d.issues ?? [])
      .map(
        (issue, i) =>
          `${i + 1}. [step ${issue.step}] (${issue.basis}${issue.mustAddress ? ", must address" : ""}) ${issue.point}`,
      )
      .join("\n");
    return [
      `Judge — round ${round.round}: ${d.verdict}`,
      d.reason,
      ...(issues ? [`Issues:\n${issues}`] : []),
    ].join("\n");
  }
  const c = round.comments.find((entry) => entry.commentorId === selected);
  if (!c) return "";
  return [
    `${c.commentorLabel} — round ${round.round}: ${c.verdict}${c.step !== undefined ? ` (step ${c.step})` : ""}`,
    c.reason,
    ...(c.suggestion ? [`Suggestion: ${c.suggestion}`] : []),
  ].join("\n");
}

/**
 * The collapsed-by-default comments panel under a round's text. Tags switch
 * between the judge (default) and each commentor; the copy button copies the
 * selected view for pasting into a bug report.
 */
/** The reviewer's name colored by its verdict — the color IS the status. */
function verdictClass(verdict: string | undefined): string {
  switch (verdict) {
    case "Pass":
      return "reviewer-name-ok";
    case "Build":
      return "reviewer-name-warn";
    case "Interrupt":
      return "reviewer-name-bad";
    default:
      return "reviewer-name-dim";
  }
}

function CommentsPanel({
  round,
  open,
  onToggle,
  selected,
  onSelect,
}: {
  /**
   * The round that reviewed the version this card shows — the round AFTER
   * the one that produced it. A round comments on the text it was handed and
   * only then redevelops, so pairing a card with its OWN round's comments
   * showed every reviewer against a version written in reply to them.
   */
  round: ReviewRoundView;
  open: boolean;
  onToggle: () => void;
  selected: string;
  onSelect: (tag: string) => void;
}) {
  const labelOf = (commentorId: string): string =>
    round.comments.find((c) => c.commentorId === commentorId)?.commentorLabel ?? commentorId;
  const active = selected === "judge" || round.comments.some((c) => c.commentorId === selected)
    ? selected
    : "judge";
  // Selecting a name shows that reviewer — opening the panel if it was folded.
  const pick = (tag: string): void => {
    onSelect(tag);
    if (!open) onToggle();
  };
  return (
    <details className="review-fold comments-panel" open={open}>
      <summary
        className="review-fold-head"
        onClick={(event) => {
          event.preventDefault();
          // The reviewer names inside the summary are their own controls;
          // only a click on the row itself folds the panel.
          if ((event.target as HTMLElement).closest("button")) return;
          onToggle();
        }}
      >
        <span className="review-fold-name">
          Comments & judgement
          <span className="dim"> · round {round.round}</span>
        </span>
        <span className="reviewer-names" role="tablist" aria-label="reviewer">
          <button
            type="button"
            role="tab"
            aria-selected={open && active === "judge"}
            className={`reviewer-name ${verdictClass(round.decision?.verdict)}${
              open && active === "judge" ? " reviewer-name-selected" : ""
            }`}
            onClick={() => pick("judge")}
          >
            Judge
          </button>
          {round.comments.map((comment) => (
            <button
              key={comment.commentorId}
              type="button"
              role="tab"
              aria-selected={open && active === comment.commentorId}
              className={`reviewer-name ${verdictClass(comment.verdict)}${
                open && active === comment.commentorId ? " reviewer-name-selected" : ""
              }`}
              onClick={() => pick(comment.commentorId)}
            >
              {comment.commentorLabel}
            </button>
          ))}
        </span>
        <span className="round-card-actions">
          <CopyButton
            label="copy this view for a bug report"
            text={() => commentCopyText(active, round)}
          />
        </span>
      </summary>
      {open && (
        <div className="review-fold-body">
          {active === "judge" ? (
            round.decision ? (
              <JudgeContent decision={round.decision} labelOf={labelOf} />
            ) : (
              <p className="dim small">judgement in progress — comments land first</p>
            )
          ) : (
            (() => {
              const comment = round.comments.find((c) => c.commentorId === active);
              return comment ? <CommentContent comment={comment} /> : null;
            })()
          )}
        </div>
      )}
    </details>
  );
}

function bugReportText(
  member: ReviewMemberView,
  step: ReviewStepView,
  computed: RoundComputedView | undefined,
): string {
  const head = `${member.label}${member.umbrella ? ` (${member.umbrella})` : ""} — step ${step.index}`;
  if (!computed) return `${head}: not yet reviewed`;
  const round = computed.round;
  const lines = [
    `${head}, round ${round.round}`,
    `verdict: ${round.decision?.verdict ?? "in progress"}`,
  ];
  const issues = round.decision?.issues ?? [];
  if (issues.length > 0) {
    lines.push("issues:");
    for (const [i, issue] of issues.entries()) {
      lines.push(
        `${i + 1}. [step ${issue.step}] (${issue.basis}${issue.mustAddress ? ", must address" : ""}) ${issue.point}`,
      );
    }
  }
  if (computed.outText !== undefined) {
    lines.push(`step text out of round ${round.round}:`, computed.outText);
  }
  for (const change of computed.crossChanges) {
    lines.push(`also rewrote step ${change.index}:`, change.after);
  }
  return lines.join("\n");
}


/**
 * What a step with no recorded round yet is actually doing.
 *
 * A step's rounds only appear once results are recorded, so a position whose
 * commentors are already running looked identical to one nothing had reached
 * — the seat read as idle while six reviewers were mid-flight on it. The
 * seat's live position says otherwise, so it is what the card reports.
 */
function pendingNote(member: ReviewMemberView, step: ReviewStepView): string {
  const at = member.progress;
  if (at?.step === step.index) {
    const doing =
      at.phase === "judging"
        ? "the judge is ruling"
        : at.phase === "redeveloping"
          ? "the member is redeveloping"
          : "commentors are working";
    return `round ${at.round} in progress — ${doing}`;
  }
  if (step.outcome === "under-review") {
    return "round 1 in progress — comments are being gathered";
  }
  return "not yet reviewed";
}

function originalReportText(
  member: ReviewMemberView,
  step: ReviewStepView,
  text: string,
): string {
  return [
    `${member.label}${member.umbrella ? ` (${member.umbrella})` : ""} — step ${step.index}`,
    "original thought (first pass, before any review)",
    text,
  ].join("\n");
}

/**
 * Whether a rewrite of `affectedStep` looked FORWARD: an earlier walk
 * position's review changed a later step (prospective, dark blue). The
 * opposite — a later position reaching back — is retroactive (red).
 */
function isProspective(cross: CrossRewriteView, affectedStep: number): boolean {
  return cross.byStep < affectedStep;
}

function crossOriginText(cross: CrossRewriteView, affectedStep: number): string {
  return (
    `${isProspective(cross, affectedStep) ? "prospective" : "retroactive"} rewrite ` +
    `during step ${cross.byStep} · round ${cross.byRound} — not by this step's own review`
  );
}

function crossReportText(
  member: ReviewMemberView,
  step: ReviewStepView,
  cross: CrossRewriteView,
): string {
  return [
    `${member.label}${member.umbrella ? ` (${member.umbrella})` : ""} — step ${step.index}`,
    crossOriginText(cross, step.index),
    cross.after,
  ].join("\n");
}

/**
 * The round deck inside one step card: newest entry on top, older ones
 * behind it, paged with buttons. The visible card's text is never clamped or
 * scrolled — the card takes the height of the full text. Cross-step rewrites
 * are their own cards, labeled with the walk position that caused them; the
 * step's own "Round k / K" numbering never shifts around them.
 */
function RoundDeck({
  member,
  step,
  timeline,
  selectedEntry,
  onSelectEntry,
  commentState,
}: {
  member: ReviewMemberView;
  step: ReviewStepView;
  timeline: SeatTimeline;
  selectedEntry: string | undefined;
  onSelectEntry: (key: string) => void;
  commentState: {
    open: (key: string) => boolean;
    toggle: (key: string) => void;
    tag: (key: string) => string;
    select: (key: string, tag: string) => void;
  };
}) {
  const deck = deckEntries(step, timeline);
  if (deck.length === 0) {
    const text = timeline.chain.get(step.index);
    return (
      <div className="round-card round-card-pending">
        <p className="dim small">{pendingNote(member, step)}</p>
        {text !== undefined && <p className="round-text diff-keep-block">{text}</p>}
      </div>
    );
  }
  // Newest on top: the default card is the deck's last (most recent) entry —
  // the step's standing text, whichever review wrote it.
  const selectedIndex =
    selectedEntry !== undefined
      ? deck.findIndex((entry) => entry.key === selectedEntry)
      : -1;
  const position = selectedIndex >= 0 ? selectedIndex : deck.length - 1;
  const entry = deck[position]!;
  // The review performed ON this version — see reviewedBy.
  const review = reviewedBy(deck, position);
  const reviewFold = (key: string): ReactNode =>
    review === undefined ? undefined : (
      <CommentsPanel
        round={review}
        open={commentState.open(key)}
        onToggle={() => commentState.toggle(key)}
        selected={commentState.tag(key)}
        onSelect={(tag) => commentState.select(key, tag)}
      />
    );
  const newest = position === deck.length - 1;
  const versionMeta = newest ? undefined : "an earlier version";
  // The pager arrows hug the card title — exactly the seat pager's pattern —
  // so paging a step's history reads the same as paging seats.
  const olderButton = (
    <button
      type="button"
      className="ghost-btn"
      aria-label="older version of this step"
      disabled={position === 0}
      onClick={() => onSelectEntry(deck[position - 1]!.key)}
    >
      <BackIcon size={16} />
    </button>
  );
  const newerButton = (
    <button
      type="button"
      className="ghost-btn"
      aria-label="newer version of this step"
      disabled={newest}
      onClick={() => onSelectEntry(deck[position + 1]!.key)}
    >
      <ForwardIcon size={16} />
    </button>
  );

  if (entry.kind === "original") {
    // The base every later version is measured against: the step's
    // first-pass text, the one card whose whole body renders at full
    // weight — from here on, full-weight words always mean "this card
    // changed them".
    return (
      <div className="round-card" key={entry.key}>
        <div className="round-card-head">
          {olderButton}
          <span
            className="review-fold-name"
            title="the first-pass text, before any review touched it"
          >
            Original thought
          </span>
          {newerButton}
          {deck.length > 1 && <span className="review-step-meta">{versionMeta}</span>}
          <span className="round-card-actions">
            <CopyButton
              label="copy the original thought"
              text={() => originalReportText(member, step, entry.text)}
            />
          </span>
        </div>
        <p className="round-text">{entry.text}</p>
        {reviewFold(`${member.memberId}:${step.index}:${entry.key}`)}
      </div>
    );
  }

  if (entry.kind === "cross") {
    // A rewrite another walk position applied to this step: its own card,
    // labeled by origin. The DIRECTION carries the color (plain text, color
    // only): dark blue when an earlier position's review changed this later
    // step (prospective), red when a later position reached back
    // (retroactive).
    const prospective = isProspective(entry.cross, step.index);
    return (
      <div className="round-card" key={entry.key}>
        <div className="round-card-head">
          {olderButton}
          <span
            className={`review-fold-name ${
              prospective ? "cross-origin-prospective" : "cross-origin-retroactive"
            }`}
            title={crossOriginText(entry.cross, step.index)}
          >
            changed by step {entry.cross.byStep}
          </span>
          {newerButton}
          {deck.length > 1 && <span className="review-step-meta">{versionMeta}</span>}
          <span className="round-card-actions">
            <CopyButton
              label="copy this rewrite for a bug report"
              text={() => crossReportText(member, step, entry.cross)}
            />
          </span>
        </div>
        <p className="round-text">
          {segmentSpans(entry.cross.segments, prospective ? "diff-blue" : "diff-red")}
        </p>
        {reviewFold(`${member.memberId}:${step.index}:${entry.key}`)}
      </div>
    );
  }

  const round = entry.round;
  // The highest round number IN THE DECK, not the highest that occurred: a round
  // that rewrote nothing has no card of its own (its verdict sits under the
  // version it read), so counting to it promised a card the pager cannot reach —
  // "Round 3 / 4" with the next arrow disabled.
  const latest = deck.reduce(
    (max, e) => (e.kind === "round" ? Math.max(max, e.round.round) : max),
    0,
  );
  const computed = timeline.rounds.get(roundViewKey(step.index, round.round));
  const commentKey = `${member.memberId}:${step.index}:${entry.key}`;
  return (
    <div className="round-card" key={entry.key}>
      <div className="round-card-head">
        {olderButton}
        <span className="review-fold-name">
          Round{" "}
          <span
            className="round-num-active"
            title="the text this round left standing; its own verdict sits with the review of the version before it"
          >
            {round.round}
          </span>
          <span className="dim"> / {latest}</span>
        </span>
        {newerButton}
        {/* Whether THIS version was sent back — a fact about the review shown
            on this card, not about the round that wrote the text. */}
        {review?.revision && <span className="badge badge-warn">redeveloped</span>}
        {deck.length > 1 && (
          <span className="review-step-meta">
            {[
              ...(!computed?.ownRewrite ? ["unchanged from the previous version"] : []),
              ...(versionMeta !== undefined ? [versionMeta] : []),
            ].join(" · ")}
          </span>
        )}
        <span className="round-card-actions">
          <CopyButton
            label="copy this round for a bug report"
            text={() => bugReportText(member, step, computed)}
          />
        </span>
      </div>
      {computed?.outText !== undefined && (
        <p className="round-text">{segmentSpans(computed.segments, "diff-new")}</p>
      )}
      {computed !== undefined && computed.crossChanges.length > 0 && (
        <div className="round-cross-note">
          {computed.crossChanges.map((change) => (
            <span
              key={change.index}
              // Same color language as the affected step's card: blue when
              // this round rewrote a LATER step (prospective), red when it
              // reached back to an earlier one (retroactive).
              className={`detail-label ${
                change.index > step.index
                  ? "detail-label-prospective"
                  : "detail-label-bad"
              }`}
            >
              also rewrote step {change.index} this round
              <span className="dim"> — see step {change.index}</span>
            </span>
          ))}
        </div>
      )}
      {reviewFold(commentKey)}
    </div>
  );
}

/**
 * The review stage renders as TWO detached panels with the page background
 * visible between them: the progress grid rides inside the stage frame (the
 * `frame` callback wraps it, so the stage header/activity stay with the
 * grid), and the walk inspector sits below in its own panel. Both share one
 * component so a grid-cell click can drive the inspector's seat.
 */
export function ReviewStagePanels({
  stage,
  firstPass,
  frame,
  expanded,
  topic,
  onDismiss,
}: {
  stage: ReviewStage;
  firstPass?: FirstPassStage;
  /** Wraps the grid panel in the stage frame (header, fold, activity). */
  frame: (gridPanel: ReactNode) => ReactNode;
  /** The stage frame's fold state — the walk panel folds with it. */
  expanded: boolean;
  /** The run's submission topic; titles the seat's LaTeX export. */
  topic?: string;
  /** Absent on a finished or trashed run: there is nothing left to dismiss. */
  onDismiss?: (memberId: string) => Promise<void>;
}) {
  // No global cursor: each seat carries its own progress, so several seats can
  // be under review at once.
  const activeSeats = stage.members.filter((member) => member.progress !== undefined);
  // Seats still in the review. A dismissed seat is not one of them, so counting
  // it here would say "member 1/3" of a panel that now has two — the same
  // mismatch between a total and what is actually happening that the round
  // labels had.
  const reviewing = stage.members.filter((member) => member.dismissed === undefined);
  const cursor =
    activeSeats.length === 1
      ? {
          member: reviewing.indexOf(activeSeats[0]!) + 1,
          memberCount: reviewing.length,
          step: activeSeats[0]!.progress!.step,
          stepCount: activeSeats[0]!.progress!.stepCount,
          round: activeSeats[0]!.progress!.round,
          maxRounds: stage.maxRounds,
        }
      : undefined;

  // The seat pager follows the lone active seat until the reader pins one.
  const [pinnedSeat, setPinnedSeat] = useState<string | undefined>(undefined);
  // Deck position per step (an entry key — a round or a cross rewrite);
  // comments fold + selected tag per round. All fold state is controlled:
  // live snapshots re-render this panel continuously, so an uncontrolled
  // <details> would snap back on every SSE tick.
  const [roundChoices, setRoundChoices] = useState<ReadonlyMap<string, string>>(new Map());
  const [commentOpen, setCommentOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [commentTags, setCommentTags] = useState<ReadonlyMap<string, string>>(new Map());
  const [finalOpen, setFinalOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const stepRefs = useRef(new Map<string, HTMLElement | null>());

  const members = stage.members;
  const pinnedIndex = members.findIndex((m) => m.memberId === pinnedSeat);
  const seatIndex =
    pinnedIndex >= 0
      ? pinnedIndex
      : activeSeats.length === 1
        ? members.indexOf(activeSeats[0]!)
        : 0;
  const seat = members[seatIndex];

  const selectSeat = useCallback(
    (memberId: string) => setPinnedSeat(memberId),
    [],
  );

  // A grid-cell click on ANOTHER seat must wait for that seat's cards to
  // mount before it can scroll to the step; the effect below fires after the
  // commit and performs the deferred scroll exactly once.
  const pendingScroll = useRef<string | undefined>(undefined);
  const scrollToStep = (key: string): void => {
    stepRefs.current.get(key)?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
    });
  };
  const onCellClick = (member: ReviewMemberView, step: ReviewStepView): void => {
    const key = `${member.memberId}:${step.index}`;
    if (seat?.memberId === member.memberId) {
      scrollToStep(key);
      return;
    }
    pendingScroll.current = key;
    selectSeat(member.memberId);
  };
  useEffect(() => {
    const key = pendingScroll.current;
    if (key === undefined || stepRefs.current.get(key) == null) return;
    pendingScroll.current = undefined;
    scrollToStep(key);
  });

  const commentState = {
    open: (key: string) => commentOpen.get(key) ?? false,
    toggle: (key: string) =>
      setCommentOpen((prev) => {
        const next = new Map(prev);
        next.set(key, !(prev.get(key) ?? false));
        return next;
      }),
    tag: (key: string) => commentTags.get(key) ?? "judge",
    select: (key: string, tag: string) =>
      setCommentTags((prev) => {
        const next = new Map(prev);
        next.set(key, tag);
        return next;
      }),
  };

  const firstPassMember = (memberId: string) =>
    firstPass?.members.find((member) => member.memberId === memberId);
  const firstPassCot = (memberId: string): readonly string[] | undefined =>
    firstPassMember(memberId)?.idea?.cot;
  // The seat's full expertise, biggest granularity first: department, then
  // umbrella, then the subfields (which only the first-pass view carries).
  const expertiseOf = (member: ReviewMemberView): string =>
    [
      [member.department, member.umbrella].filter(Boolean).join(" / "),
      ...(firstPassMember(member.memberId)?.subfields ?? []),
    ]
      .filter((part) => part !== "")
      .join(" · ");

  const anyReviewed = members.some((member) => member.steps.some(reviewable));

  const gridPanel = (
    <div>
      {stage.status === "active" && cursor && (
        <p className="cursor-line">
          Reviewing member {cursor.member}/{cursor.memberCount} · step {cursor.step}/
          {cursor.stepCount} · round {cursor.round} of ≤{cursor.maxRounds}
        </p>
      )}
      <div className="matrix">
        {members.map((member) => {
          const expertise = expertiseOf(member);
          return (
            <div key={member.memberId} className="matrix-row">
              <span
                className={`matrix-label${
                  member.dismissed !== undefined
                    ? " matrix-label-dismissed"
                    : member.error !== undefined
                      ? " matrix-label-bad"
                      : ""
                }`}
                title={
                  member.dismissed !== undefined
                    ? `${member.label} was dismissed — what it recorded before then is kept`
                    : member.error !== undefined
                      ? `${member.label} failed: ${member.error}`
                      : expertise || member.label
                }
              >
                {/* The seat's name IS the control: hovering it opens the seat's
                    own popover, which is where a seat can be stopped. */}
                {onDismiss ? (
                  <SeatStopPopover
                    member={member}
                    seatState={seatStateLabel(member)}
                    expertise={expertise}
                    onDismiss={onDismiss}
                  />
                ) : (
                  member.label
                )}
              </span>
              <div className="cells">
                {member.steps.map((step) => {
                  const k = redevCount(step);
                  const active = reviewable(step);
                  const isShown = seat?.memberId === member.memberId;
                  const stopped = member.dismissed !== undefined && unreached(step);
                  return (
                    <button
                      key={step.index}
                      type="button"
                      className={`cell ${cellClass(step, member.dismissed !== undefined)}${isShown ? " cell-selected" : ""}`}
                      aria-label={cellLabel(member, step)}
                      disabled={!active}
                      onClick={() => onCellClick(member, step)}
                    >
                      {stopped ? (
                        <span className="cell-stopped" aria-hidden>
                          ×
                        </span>
                      ) : (
                        k > 0 && <span className="cell-redev">×{k}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {expertise !== "" && (
                <span className="matrix-expertise marquee" title={expertise}>
                  <span className="marquee-inner">{expertise}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="matrix-caption">
        cell = one chain step · colors = how it passed · click a cell to open that seat's walk
      </p>
      {!anyReviewed && <p className="dim small">no review rounds recorded yet</p>}
    </div>
  );

  const walkPanel =
    !anyReviewed || seat === undefined ? null : (
      <section className="stage review-walk-panel">
        <div className="seat-walk">
          <div className="seat-pager">
            {/* The pager arrows hug the seat title; the seat's expertise
                (biggest granularity first) balances the right side. */}
            <button
              type="button"
              className="ghost-btn"
              aria-label="previous seat"
              disabled={seatIndex === 0}
              onClick={() => selectSeat(members[seatIndex - 1]!.memberId)}
            >
              <BackIcon size={16} />
            </button>
            <span className="seat-pager-label">
              {seat.label}
              <span className="dim"> / {members.length}</span>
            </span>
            <button
              type="button"
              className="ghost-btn"
              aria-label="next seat"
              disabled={seatIndex === members.length - 1}
              onClick={() => selectSeat(members[seatIndex + 1]!.memberId)}
            >
              <ForwardIcon size={16} />
            </button>
            {seat.dismissed !== undefined ? (
              <span className="step-chip step-chip-dim">dismissed</span>
            ) : seat.error !== undefined ? (
              <span className="step-chip step-chip-bad">failed</span>
            ) : seat.progress !== undefined ? (
              <span className="step-chip step-chip-active">under review</span>
            ) : walkComplete(seat) ? (
              <span className="step-chip step-chip-ok">done with thinking</span>
            ) : null}
            <span className="seat-pager-expertise marquee" title={expertiseOf(seat)}>
              <span className="marquee-inner">{expertiseOf(seat)}</span>
            </span>
          </div>
          {seat.error !== undefined && (
            <div className="stage-error">
              This seat&apos;s walk failed and is waiting for a retry; the other
              seats keep reviewing. {seat.error}
            </div>
          )}
          {(() => {
            const timeline = computeSeatTimeline(seat, firstPassCot(seat.memberId));
            return (
              <div className="review-cards">
                {seat.steps.map((step) => {
                  const stepRefKey = `${seat.memberId}:${step.index}`;
                  const crossCount = (timeline.crossRewrites.get(step.index) ?? []).length;
                  const choiceKey = stepRefKey;
                  const k = redevCount(step);
                  return (
                    <section
                      key={step.index}
                      className="review-card"
                      ref={(el) => {
                        stepRefs.current.set(stepRefKey, el);
                      }}
                    >
                      <div className="review-card-head">
                        <span
                          className={`review-card-title ${stepTitleClass(step)}`}
                          title={stepOutcomeHint(step)}
                        >
                          Step {step.index}
                          <span className="dim"> / {seat.steps.length}</span>
                        </span>
                        {k > 0 && <span className="badge">×{k} redeveloped</span>}
                        <span className="review-step-meta">
                          {roundsMeta(step, seat.dismissed !== undefined, crossCount)}
                        </span>
                      </div>
                      <RoundDeck
                        member={seat}
                        step={step}
                        timeline={timeline}
                        selectedEntry={roundChoices.get(choiceKey)}
                        onSelectEntry={(key) =>
                          setRoundChoices((prev) => {
                            const next = new Map(prev);
                            next.set(choiceKey, key);
                            return next;
                          })
                        }
                        commentState={commentState}
                      />
                    </section>
                  );
                })}
                {seat.finalIdea &&
                  (() => {
                    // The member's output as the review left it: the FINAL
                    // version once every step passed; the current version
                    // under review until then. Also saved as a readable copy
                    // under the session's final/ directory.
                    const finalized = walkComplete(seat);
                    const revisions = seat.revisionCount ?? 0;
                    const open = finalOpen.get(seat.memberId) ?? finalized;
                    return (
                      <details className="review-fold review-final" open={open}>
                        <summary
                          className="review-fold-head"
                          onClick={(event) => {
                            event.preventDefault();
                            setFinalOpen((prev) => {
                              const next = new Map(prev);
                              next.set(seat.memberId, !open);
                              return next;
                            });
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
                          {finalized &&
                            (() => {
                              const fileName = seatTexFileName(
                                seatNumberOf(seat.label, seatIndex),
                              );
                              return (
                                <button
                                  type="button"
                                  className="ghost-btn copy-btn review-download-btn"
                                  aria-label={`download ${fileName} — this seat's final output as LaTeX`}
                                  title={`Download ${fileName} (LaTeX, latex_style)`}
                                  onClick={(event) => {
                                    // A click inside <summary> would also toggle the fold.
                                    event.preventDefault();
                                    event.stopPropagation();
                                    downloadTextFile(
                                      fileName,
                                      seatOutputToLatex(
                                        {
                                          idea: seat.finalIdea!,
                                          seatNumber: seatNumberOf(seat.label, seatIndex),
                                          topic: topic ?? seat.label,
                                          ...(seat.department !== undefined
                                            ? { department: seat.department }
                                            : {}),
                                          ...(seat.umbrella !== undefined
                                            ? { umbrella: seat.umbrella }
                                            : {}),
                                          ...(firstPassMember(seat.memberId)?.subfields !==
                                          undefined
                                            ? {
                                                subfields: firstPassMember(seat.memberId)!
                                                  .subfields,
                                              }
                                            : {}),
                                          ...(seat.revisionCount !== undefined
                                            ? { revisionCount: seat.revisionCount }
                                            : {}),
                                        },
                                        LATEX_STYLE,
                                      ),
                                    );
                                  }}
                                >
                                  <DownloadIcon />
                                </button>
                              );
                            })()}
                        </summary>
                        <div className="review-fold-body">
                          <IdeaTabs idea={seat.finalIdea} />
                        </div>
                      </details>
                    );
                  })()}
              </div>
            );
          })()}
        </div>
      </section>
    );

  return (
    <div className="review-split">
      {frame(gridPanel)}
      {expanded && walkPanel}
    </div>
  );
}
