/** Shared UI primitives used across panels: dots, clamps, chips, evidence. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getStageActivity,
  getThoughts,
  promptRecordUrl,
  stageActivityCsvUrl,
  thoughtsFileUrl,
} from "../api";
import { BrainIcon } from "./Icons";
import { revealStep } from "./live-threads";
import type { CSSProperties, ReactNode } from "react";
import type {
  ActivityDetailView,
  CotStepPart,
  CotStepView,
  EvidenceView,
  PanelMemberView,
  StageActivityEntry,
  TokenUsageView,
  Verdict,
} from "@brainstorm-agentic/protocol";
import { stepTextBlocks } from "../steps";
import { formatDuration } from "../format";
import type { DotState } from "../format";

/** 1234 -> "1.2k", 1230000 -> "1.2M": token counts at chip scale. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return String(count);
}

/**
 * A compact "tokens in / out" chip. The title carries the exact numbers and
 * the cache/reasoning split, so hovering answers what the rounding hides.
 */
export function TokenChip({ usage }: { usage: TokenUsageView }) {
  const parts = [
    `input ${usage.inputTokens.toLocaleString()}`,
    `output ${usage.outputTokens.toLocaleString()}`,
    ...(usage.cacheReadInputTokens !== undefined
      ? [`cache read ${usage.cacheReadInputTokens.toLocaleString()}`]
      : []),
    ...(usage.cacheWriteInputTokens !== undefined
      ? [`cache write ${usage.cacheWriteInputTokens.toLocaleString()}`]
      : []),
    ...(usage.reasoningTokens !== undefined
      ? [`reasoning ${usage.reasoningTokens.toLocaleString()}`]
      : []),
  ];
  return (
    <span className="token-chip" title={`tokens: ${parts.join(" · ")}`}>
      {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
    </span>
  );
}

export function Dot({ state }: { state: DotState }) {
  return <span className={`dot dot-${state.tone}${state.pulse ? " pulse" : ""}`} aria-hidden />;
}

/** Text clamped to `lines` lines with a "more"/"less" toggle when it overflows. */
export function Clamp({ text, lines = 4 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, open, lines]);

  const style: CSSProperties | undefined = open ? undefined : { WebkitLineClamp: lines };
  return (
    <div>
      <div ref={ref} className={open ? undefined : "clamp"} style={style}>
        {text}
      </div>
      {(overflowing || open) && (
        <button type="button" className="more-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "less" : "more"}
        </button>
      )}
    </div>
  );
}

/** One block of a rendered step: the body already built by the caller. */
export interface StepBlock {
  /** Which part this block is; absent when the step is one string. */
  readonly part?: CotStepPart;
  readonly body: ReactNode;
}

/**
 * A step's blocks with one treatment applied to every block's text — the
 * common case, where the caller draws each block the same way.
 */
export function textStepBlocks(
  step: CotStepView,
  render: (text: string) => ReactNode,
): readonly StepBlock[] {
  return stepTextBlocks(step).map((block) => ({
    ...(block.part !== undefined ? { part: block.part } : {}),
    body: render(block.text),
  }));
}

/**
 * A chain step's body, in the shape the run recorded it: four labelled blocks
 * when the step was written in parts, one unlabelled block when it was written
 * as a single string.
 *
 * The label is a LOCATOR, nothing more — the parts carry no assigned meaning —
 * so it stays at label size and label colour and never competes with the words
 * it names. The callers differ in what a block CONTAINS (clamped prose in the
 * first pass, diff spans in the review deck), so the body is theirs and only
 * the frame is shared: one definition of what four parts look like.
 */
export function StepBlocks({ blocks }: { blocks: readonly StepBlock[] }) {
  const first = blocks[0];
  if (blocks.length === 1 && first?.part === undefined) return <>{first.body}</>;
  return (
    <div className="step-parts">
      {blocks.map((block, index) => (
        <div key={block.part ?? index} className="step-part">
          {/* A bullet, not a "part N" label: the parts carry no assigned
              meaning, and naming them dressed plain paragraphs as form
              fields. Reviewers still LOCATE a remark by part — that naming
              lives where remarks render (the flaws lines), not here. */}
          {block.part !== undefined && (
            <span className="step-part-bullet" aria-hidden>
              •
            </span>
          )}
          <div className="step-part-body">{block.body}</div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonLines() {
  return (
    <div className="skeleton" aria-hidden>
      <div className="skeleton-line" style={{ width: "82%" }} />
      <div className="skeleton-line" style={{ width: "64%" }} />
      <div className="skeleton-line" style={{ width: "40%" }} />
    </div>
  );
}

/** Quiet time on an active stage before the "still working" line appears. */
const STALE_AFTER_MS = 30_000;

function formatQuiet(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/* ------------------------------------------- per-activity capability icons */

/** 16px stroke glyphs, one per capability (globe when a fetch carries a URL). */
function CapabilityGlyph({
  capability,
  detailKind,
}: {
  capability: NonNullable<StageActivityEntry["capability"]>;
  detailKind?: ActivityDetailView["kind"];
}) {
  const common = {
    viewBox: "0 0 16 16",
    width: 14,
    height: 14,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (capability) {
    case "attachment-access":
      return (
        <svg {...common}>
          <path d="M4 1.5h5.2L12.5 5v9a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V2.3a.8.8 0 0 1 .8-.8Z" />
          <path d="M9 1.5V5h3.5" />
        </svg>
      );
    case "code-execution":
      return (
        <svg {...common}>
          <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1" />
          <path d="M4.5 6.2 6.8 8l-2.3 1.8M8.2 10.2h3.2" />
        </svg>
      );
    case "web-search":
      return detailKind === "url" ? (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M1.8 8h12.4M8 1.8c-4.4 3.6-4.4 8.8 0 12.4M8 1.8c4.4 3.6 4.4 8.8 0 12.4" />
        </svg>
      ) : (
        <svg {...common}>
          <circle cx="6.8" cy="6.8" r="4.2" />
          <path d="m10 10 4 4" />
        </svg>
      );
    case "taxonomy-access":
      return (
        <svg {...common}>
          <path d="M8 2.2v3.6M8 5.8 3.5 9.2M8 5.8l4.5 3.4" />
          <circle cx="8" cy="2.6" r="1.3" />
          <circle cx="3.5" cy="11" r="1.6" />
          <circle cx="12.5" cy="11" r="1.6" />
        </svg>
      );
  }
}

const DETAIL_LABEL: Record<ActivityDetailView["kind"], string> = {
  code: "executed script",
  query: "search query",
  url: "fetched source",
  path: "accessed file",
  text: "call target",
};

/** Max popover box: keep the flip decision in sync with the CSS ceiling. */
const POP_MAX_HEIGHT = 340;

/**
 * One capability icon with its hover detail. The popover is position:fixed
 * (the activity list scrolls, so an anchored child would be clipped) and is
 * a DOM child of the wrapper, so moving the pointer into it — to scroll a
 * long script — keeps it open.
 */
function CapabilityBadge({ entry }: { entry: StageActivityEntry }) {
  const [pop, setPop] = useState<CSSProperties | null>(null);
  if (!entry.capability) return null;
  const open = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const openUp = rect.bottom + POP_MAX_HEIGHT + 16 > window.innerHeight;
    setPop({
      right: Math.max(8, window.innerWidth - rect.right - 4),
      ...(openUp
        ? { bottom: window.innerHeight - rect.top - 2 }
        : { top: rect.bottom - 2 }),
    });
  };
  return (
    <span
      className="cap-badge"
      onMouseEnter={(event) => open(event.currentTarget)}
      onMouseLeave={() => setPop(null)}
      onFocus={(event) => open(event.currentTarget)}
      onBlur={() => setPop(null)}
      tabIndex={0}
      aria-label={
        entry.detail
          ? `${entry.capability}: ${DETAIL_LABEL[entry.detail.kind]}`
          : entry.capability
      }
    >
      <CapabilityGlyph
        capability={entry.capability}
        detailKind={entry.detail?.kind}
      />
      {pop && (
        <span className="cap-pop" style={pop} role="tooltip">
          <span className="cap-pop-head">
            <span className="cap-pop-tool">{entry.toolName ?? entry.capability}</span>
            <span className="dim">
              {entry.detail ? DETAIL_LABEL[entry.detail.kind] : "no call detail recorded"}
            </span>
          </span>
          {entry.detail &&
            (entry.detail.kind === "code" ? (
              <pre className="cap-pop-code">{entry.detail.value}</pre>
            ) : (
              <span className="cap-pop-text">{entry.detail.value}</span>
            ))}
        </span>
      )}
    </span>
  );
}

/**
 * Where a row happened: whose chain, which step, which round. The seat is the
 * one under REVIEW, which is not always the one working — a commenter's row
 * names itself in the actor column and the seat it is commenting on here.
 */
function Where({ where }: { where: NonNullable<StageActivityEntry["where"]> }) {
  return (
    <>
      {where.seat}
      {where.step !== undefined && (
        <>
          <span className="dim"> → step </span>
          {where.step}
        </>
      )}
      {where.round !== undefined && (
        <>
          <span className="dim"> {">"} round </span>
          {where.round}
        </>
      )}
    </>
  );
}

/**
 * What a role means, for the roles whose one-word label does not say it. The
 * label has to fit a narrow column; the hover is where the sentence goes.
 */
const ROLE_HINTS: Readonly<Record<string, string>> = {
  Thinker: "the seat developing its own chain",
  Commenter: "a seat reading another seat's chain",
  Bridge: "the interdisciplinary seat, commenting across the fields between the others",
  Judge: "rules on the round's comments; not a seat",
  Redeveloper: "the seat revising its own chain after a verdict",
  Integrator: "reads every seat's final version; not a seat",
  Chair: "writes the proposal from the integration; not a seat",
};

function roleTitle(role: string | undefined): string {
  if (role === undefined) return "no agent role recorded for this row";
  const hint = ROLE_HINTS[role];
  return hint === undefined ? role : `${role} — ${hint}`;
}

function whereTitle(where: StageActivityEntry["where"]): string {
  if (!where) return "outside the panel's walk — the stage itself is the place";
  const parts = [where.seat ?? "the panel"];
  if (where.step !== undefined) parts.push(`chain step ${where.step}`);
  if (where.round !== undefined) parts.push(`review round ${where.round}`);
  return `${parts.join(", ")} — the chain being worked on, which is not always the agent's own`;
}

/**
 * The cells of one activity row, in column order.
 *
 * Split out because an `llm_call` row is the same row inside an anchor: the
 * layout rules select the row's DIRECT children, so the element carrying
 * `.activity-entry` has to be the element holding these — the `<li>` normally,
 * the `<a>` when the row leads somewhere.
 */
function ActivityCells({
  entry,
  seated,
}: {
  entry: StageActivityEntry;
  /**
   * Whether THIS feed carries seat annotations at all. The WHO and WHERE
   * columns exist for the seated stages (first pass, review); a feed whose
   * rows never name a seat — process, decompose — would render two wide
   * columns of dashes, which reads as a gap, not as alignment. Decided per
   * FEED rather than per row, so within one feed the messages still line up.
   */
  seated: boolean;
}) {
  return (
    <>
      <time dateTime={new Date(entry.at).toISOString()}>
        {new Date(entry.at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </time>
      {/* WHAT, WHO, WHERE — fixed columns, so the messages beside them stay
          in one line down the feed even when a row has none of the three (a
          run-level event in a seated feed). An empty column renders a dim
          dash rather than nothing, because a blank gap next to filled
          neighbours reads as a rendering fault. */}
      <span className="activity-role" title={roleTitle(entry.role)}>
        {entry.role ?? "—"}
      </span>
      {seated && (
        <span
          className="activity-actor"
          title={
            entry.actor !== undefined
              ? `${entry.actor} is doing this`
              : "not a seat — the role alone says who is working"
          }
        >
          {entry.actor ?? "—"}
        </span>
      )}
      {seated && (
        <span className="activity-where" title={whereTitle(entry.where)}>
          {entry.where ? <Where where={entry.where} /> : "—"}
        </span>
      )}
      {/* HOW IT ENDED. An operation's start and finish are one row: the row
          appears when the work starts and this cell fills in when it ends.
          Empty (not a dash) elsewhere — most rows are not operations, and a
          column of dashes would drown the few words that matter. */}
      <span
        className={`activity-outcome${
          entry.outcome !== undefined ? ` is-${entry.outcome}` : ""
        }`}
        title={
          entry.outcome === "finished"
            ? "this operation finished"
            : entry.outcome === "failed"
              ? "this operation failed"
              : undefined
        }
      >
        {entry.outcome ?? ""}
      </span>
      <span className="activity-marker" aria-hidden />
      <span className="activity-message">{entry.message}</span>
      {entry.turn !== undefined && (
        <span className="activity-meta">turn {entry.turn}</span>
      )}
      {entry.elapsedMs !== undefined && (
        <span className="activity-meta">
          {/* Sub-minute spans keep the terse "3s"; an agent task's span is
              minutes and "1354s" is a puzzle, not a duration. */}
          {entry.elapsedMs < 60_000
            ? `${(entry.elapsedMs / 1000).toFixed(0)}s`
            : formatDuration(entry.elapsedMs)}
        </span>
      )}
      {entry.usage && (
        <span className="activity-meta">
          <TokenChip usage={entry.usage} />
        </span>
      )}
      {entry.capability && (
        <span className="activity-caps">
          <CapabilityBadge entry={entry} />
        </span>
      )}
    </>
  );
}

/** Every activity row is exactly this tall; the virtual window is arithmetic on it. */
const ACTIVITY_ROW_PX = 28;
/** Rows rendered beyond each visible edge, so fast scrolling meets no blank strip. */
const ACTIVITY_OVERSCAN = 12;
/** Scrollback page size. */
const ACTIVITY_PAGE = 200;
/** How close to the top edge (px) the reader gets before the next page loads. */
const ACTIVITY_FETCH_EDGE_PX = 200;
/** The list's CSS max-height, used as the viewport guess before first measure. */
const ACTIVITY_LIST_PX = 260;

/**
 * Everything one feed has accumulated. The server embeds a WINDOW of the
 * newest rows in every detail; this buffer is what keeps rows a reader
 * scrolled past from vanishing when the window slides on, and where fetched
 * scrollback pages land. `floor` is the row id from which the buffer is
 * known gap-free to the newest row — the join point every page fetch anchors
 * to. Rows BELOW the floor arrive only as late edits of old operations; one
 * we already hold is updated in place, one we never held is skipped (paging
 * delivers it in order when the reader gets there).
 */
interface ActivityBuffer {
  key: string;
  rows: Map<number, StageActivityEntry>;
  floor: number;
  newest: number;
  exhausted: boolean;
  loading: boolean;
  /** Rows the last page fetch added above the view, to keep it still. */
  prepended: number;
}

const emptyActivityBuffer = (key: string): ActivityBuffer => ({
  key,
  rows: new Map(),
  floor: Infinity,
  newest: -Infinity,
  exhausted: false,
  loading: false,
  prepended: 0,
});

export function ActivityFeed({
  entries,
  active,
  now,
  jobId,
  stageId,
  total,
  floor,
}: {
  entries: readonly StageActivityEntry[];
  active: boolean;
  /** Current time for the quiet-period ticker; omit to disable it. */
  now?: number;
  /**
   * The run these rows belong to, which is half of a captured prompt's address
   * and half of the scrollback/CSV endpoints' address. Omit and `llm_call`
   * rows render as ordinary rows — correct for any caller that is not showing
   * one run's feed.
   */
  jobId?: string;
  /** The stage the rows belong to; with jobId, enables scrollback and CSV. */
  stageId?: string;
  /** The stage's whole history length (StageBase.activityTotal). */
  total?: number;
  /** The id from which `entries` is gap-free (StageBase.activityFloor). */
  floor?: string;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  const bufferRef = useRef<ActivityBuffer>(emptyActivityBuffer(""));
  const [revision, setRevision] = useState(0);
  // Start the virtual window at the list's END: the feed opens pinned to the
  // newest row, and starting anywhere else would render a slice only to jump
  // away from it on the first layout pass.
  const [viewTop, setViewTop] = useState(() =>
    Math.max(0, entries.length * ACTIVITY_ROW_PX - ACTIVITY_LIST_PX),
  );
  const [viewHeight, setViewHeight] = useState(ACTIVITY_LIST_PX);

  const feedKey = `${jobId ?? ""}|${stageId ?? ""}`;
  const rows = useMemo(() => {
    if (bufferRef.current.key !== feedKey) {
      bufferRef.current = emptyActivityBuffer(feedKey);
    }
    const buffer = bufferRef.current;
    if (entries.length > 0) {
      const incomingFloor = Number(floor ?? entries[0]!.id);
      if (buffer.rows.size === 0 || incomingFloor <= buffer.newest) {
        // The window overlaps (or reaches below) what is buffered: one
        // gap-free range. A window of an OLDER build (floor above the newest
        // buffered row would mean rows fell between two refreshes) restarts
        // the buffer instead — scrolling up re-fetches history in order.
        buffer.floor = Math.min(buffer.floor, incomingFloor);
      } else {
        bufferRef.current = emptyActivityBuffer(feedKey);
        bufferRef.current.floor = incomingFloor;
      }
      const current = bufferRef.current;
      for (const entry of entries) {
        const id = Number(entry.id);
        if (id >= current.floor || current.rows.has(id)) {
          current.rows.set(id, entry);
          if (id > current.newest) current.newest = id;
        }
      }
    }
    return [...bufferRef.current.rows.values()].sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    // revision counts fetched pages, which land in the buffer, not in props.
  }, [entries, feedKey, floor, revision]);

  const hasMore =
    jobId !== undefined &&
    stageId !== undefined &&
    total !== undefined &&
    !bufferRef.current.exhausted &&
    rows.length < total;

  const loadOlder = () => {
    const buffer = bufferRef.current;
    if (buffer.loading || !hasMore || rows.length === 0) return;
    buffer.loading = true;
    getStageActivity(jobId!, stageId!, {
      before: String(buffer.floor),
      limit: ACTIVITY_PAGE,
    })
      .then((page) => {
        // The page is the id-ordered slice ending exactly at the floor, so
        // the union stays gap-free and the floor moves to the page's first
        // row. An empty or short page means the top of the log was reached.
        if (buffer !== bufferRef.current) return;
        for (const entry of page.entries) {
          buffer.rows.set(Number(entry.id), entry);
        }
        if (page.entries.length > 0) {
          buffer.floor = Math.min(buffer.floor, Number(page.entries[0]!.id));
          buffer.prepended += page.entries.length;
        }
        if (page.entries.length < ACTIVITY_PAGE) buffer.exhausted = true;
      })
      .catch(() => {
        // Transient (server restarting, network blip): the next scroll retries.
      })
      .finally(() => {
        buffer.loading = false;
        setRevision((value) => value + 1);
      });
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (list.clientHeight > 0 && list.clientHeight !== viewHeight) {
      setViewHeight(list.clientHeight);
    }
    const buffer = bufferRef.current;
    if (buffer.prepended > 0) {
      // A page arrived above the view: shift the scroll by exactly its height
      // so the row the reader was on does not move.
      list.scrollTop += buffer.prepended * ACTIVITY_ROW_PX;
      buffer.prepended = 0;
      setViewTop(list.scrollTop);
      return;
    }
    // Keep the feed pinned to the newest entry unless the reader has
    // scrolled back through the history.
    if (pinnedRef.current) {
      list.scrollTop = list.scrollHeight;
      setViewTop(list.scrollTop);
    }
  }, [rows.length, viewHeight]);

  // One decision for the whole feed: seat columns exist only where some row
  // actually names a seat or a walk position (see ActivityCells.seated).
  const seated = rows.some(
    (entry) => entry.actor !== undefined || entry.where !== undefined,
  );
  if (rows.length === 0) return null;
  const lastAt = rows[rows.length - 1]!.at;
  const quietMs = active && now !== undefined ? now - lastAt : 0;

  // Only the rows a reader can see (plus overscan) exist in the DOM; two
  // spacers stand in for the rest, so a feed of any length costs the browser
  // a couple dozen nodes. The arithmetic works because every row is exactly
  // ACTIVITY_ROW_PX tall (the stylesheet pins it).
  const first = Math.max(
    0,
    Math.floor(viewTop / ACTIVITY_ROW_PX) - ACTIVITY_OVERSCAN,
  );
  const last = Math.min(
    rows.length,
    Math.ceil((viewTop + viewHeight) / ACTIVITY_ROW_PX) + ACTIVITY_OVERSCAN,
  );

  return (
    <div className="activity-feed" aria-live={active ? "polite" : "off"}>
      <div className="activity-head">
        <span>Activity</span>
        <span className="activity-head-tools">
          <span className="dim">{total ?? rows.length} events</span>
          {jobId !== undefined && stageId !== undefined && (
            <a
              className="activity-download"
              href={stageActivityCsvUrl(jobId, stageId)}
              download
              title="download this stage's whole activity log as CSV"
              aria-label="download this stage's whole activity log as CSV"
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M3 13.5h10" />
              </svg>
            </a>
          )}
        </span>
      </div>
      <ol
        className="activity-list"
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          pinnedRef.current =
            list.scrollHeight - list.scrollTop - list.clientHeight < 40;
          setViewTop(list.scrollTop);
          if (list.scrollTop < ACTIVITY_FETCH_EDGE_PX) loadOlder();
        }}
      >
        {first > 0 && (
          <li
            className="activity-spacer"
            style={{ height: first * ACTIVITY_ROW_PX }}
            aria-hidden
          />
        )}
        {rows.slice(first, last).map((entry) => {
          const promptHref =
            entry.kind === "llm_call" && entry.promptId !== undefined && jobId !== undefined
              ? promptRecordUrl(jobId, entry.promptId)
              : undefined;
          const rowClass = `activity-entry activity-${entry.kind}${
            entry.outcome !== undefined ? ` outcome-${entry.outcome}` : ""
          }`;
          // An llm_call row is the ONLY row in the feed that goes anywhere: it
          // carries the exact request behind that call. A real anchor rather
          // than a handler, so the keyboard reaches it for free and the
          // download is the browser's, not ours — and the row itself is the
          // anchor, because the column rules above select direct children.
          return promptHref !== undefined ? (
            <li key={entry.id} className="activity-entry-link">
              <a
                className={rowClass}
                href={promptHref}
                download
                title="download exactly what was sent to the model for this call"
              >
                <ActivityCells entry={entry} seated={seated} />
              </a>
            </li>
          ) : (
            <li key={entry.id} className={rowClass}>
              <ActivityCells entry={entry} seated={seated} />
            </li>
          );
        })}
        {last < rows.length && (
          <li
            className="activity-spacer"
            style={{ height: (rows.length - last) * ACTIVITY_ROW_PX }}
            aria-hidden
          />
        )}
      </ol>
      {quietMs > STALE_AFTER_MS && (
        <div className="activity-stale">
          <span className="dot dot-accent pulse" aria-hidden />
          no new events for {formatQuiet(quietMs)} — a long model turn or tool
          call is in progress
        </div>
      )}
    </div>
  );
}

/**
 * Fetched thoughts, cached for the page's life: a recorded slice is
 * immutable (it lives in the run's journal), so a card hovered twice must
 * not fetch twice. Failures are NOT cached — a transient error retries on
 * the next hover.
 */
const thoughtsCache = new Map<string, string>();

/**
 * The literal a capped slice's text ends with (the worker stamps it at
 * capture time). Matched verbatim — journals already carry exactly this
 * string — so the popover can swap it for a working download link.
 */
const THOUGHTS_TRUNCATION_MARK = "… [thoughts truncated]";

/**
 * How much of the thoughts a PREVIEW shows. The full text is one click away
 * now, so the hover window stops being a reading surface for whole traces —
 * four paragraphs say what the thinking was about; the file carries the rest
 * (a whole-task preview otherwise pours hundreds of KB into a 280px window).
 */
const THOUGHTS_PREVIEW_PARAGRAPHS = 4;

/**
 * Downloads through a detached anchor, immune to the popover's own life
 * cycle: the rendered link sits inside a window that closes on blur and
 * whose text can be swept into a selection mid-click — a drag-select on a
 * link navigates nowhere, which shipped as "the download link does nothing".
 */
function saveFromUrl(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * The grey brain beside a card: hovering (or focusing) it opens a scrollable
 * window with the recorded thinking behind exactly what the card shows — the
 * same words the live thread streamed while it was being written, kept now
 * as the task's captured trace. Clicking it downloads the FULL text as a
 * file: the preview is the journal's capped slice, and a slice that was cut
 * ends in a download link instead of a dead "truncated" notice. Styled like
 * the live thread on purpose: this is working material, not an artifact,
 * and it must never read as the chain.
 */
export function ThoughtsButton({ jobId, refId }: { jobId: string; refId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | undefined>(() => thoughtsCache.get(refId));
  const [failed, setFailed] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const fileUrl = thoughtsFileUrl(jobId, refId);

  const show = () => {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
    setOpen(true);
    if (thoughtsCache.has(refId)) {
      setText(thoughtsCache.get(refId));
      return;
    }
    setFailed(false);
    void getThoughts(jobId, refId).then(
      (response) => {
        thoughtsCache.set(refId, response.text);
        setText(response.text);
      },
      () => setFailed(true),
    );
  };
  // A short grace on leave, so crossing the gap between the icon and the
  // window never snaps it shut mid-read.
  const hide = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 200);
  };

  // The preview: at most a few paragraphs, its tail made honest. Whether the
  // cut is ours (the paragraph cap) or the journal's (the capture-time
  // truncation mark), the tail is the link to the whole text instead of a
  // dead notice.
  const paragraphs = text?.split("\n\n");
  const capped =
    paragraphs !== undefined && paragraphs.length > THOUGHTS_PREVIEW_PARAGRAPHS;
  const marked = text !== undefined && text.endsWith(THOUGHTS_TRUNCATION_MARK);
  const truncated = capped || marked;
  const body = capped
    ? paragraphs.slice(0, THOUGHTS_PREVIEW_PARAGRAPHS).join("\n\n")
    : marked
      ? text.slice(0, -THOUGHTS_TRUNCATION_MARK.length)
      : text;

  return (
    <span
      className="thoughts-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      {/* An anchor, not a button: the click DOWNLOADS the full text (the
          browser's own download, nothing through this page's state), while
          hover and focus keep opening the preview. */}
      <a
        className="ghost-btn thoughts-btn"
        href={fileUrl}
        download
        aria-label="download the full thoughts behind this version — hover to preview"
        aria-expanded={open}
      >
        <BrainIcon />
      </a>
      {open && (
        <div className="thoughts-pop" role="note">
          <div className="thoughts-pop-head">
            thoughts behind this version — recorded while it was written, not
            part of the chain
          </div>
          <div className="thoughts-pop-body">
            {failed ? (
              <span className="dim">
                could not load the thoughts — hover again to retry
              </span>
            ) : body === undefined ? (
              <span className="dim">loading…</span>
            ) : body.length === 0 ? (
              <span className="dim">nothing was recorded for this version</span>
            ) : (
              <>
                {body}
                {truncated && (
                  <span className="thoughts-download-line dim">
                    {"… ["}
                    <a
                      href={fileUrl}
                      download
                      draggable={false}
                      // No focus steal, no selection start: a press that
                      // drifts a few pixels otherwise becomes a drag-select,
                      // and a drag-selected link click navigates nowhere.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.preventDefault();
                        saveFromUrl(fileUrl);
                      }}
                    >
                      download full version
                    </a>
                    {"]"}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  const cls =
    verdict === "Pass" ? "verdict-pass" : verdict === "Build" ? "verdict-build" : "verdict-interrupt";
  return <span className={`verdict ${cls}`}>{verdict}</span>;
}

/*
 * Reference locators arrive as free prose that often carries several URLs
 * plus commentary ("https://… (see also X, JMLR 2006, 'Title', https://…)").
 * Rendering that string as ONE link breaks the href and wraps mid-URL, so it
 * is split into segments: each URL becomes its own working link, with the
 * text before it carried as that link's description.
 */
type LocatorItem =
  | { readonly kind: "link"; readonly url: string; readonly label?: string }
  | { readonly kind: "note"; readonly text: string };

const LOCATOR_URL = /https?:\/\/[^\s<>"']+/g;

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

/** Strips sentence punctuation and unbalanced closers the prose glued onto a URL. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (last !== undefined && /[.,;:!?]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")" && count(url, "(") < count(url, ")")) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === "]" && count(url, "[") < count(url, "]")) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** Drops the connective punctuation left over once the URLs are cut out. */
function cleanNote(text: string): string {
  return text
    .replace(/^[\s([,;:.\u2013\u2014-]+/, "")
    .replace(/[\s)\],;:\u2013\u2014-]+$/, "")
    .trim();
}

export function splitLocator(locator: string): readonly LocatorItem[] {
  const items: LocatorItem[] = [];
  let cursor = 0;
  for (const match of locator.matchAll(LOCATOR_URL)) {
    const label = cleanNote(locator.slice(cursor, match.index));
    items.push({ kind: "link", url: trimUrl(match[0]), ...(label ? { label } : {}) });
    cursor = match.index + match[0].length;
  }
  const trailing = cleanNote(locator.slice(cursor));
  if (trailing) items.push({ kind: "note", text: trailing });
  return items;
}

function LocatorBlock({ locator }: { locator: string }) {
  const items = splitLocator(locator);
  if (items.length === 0) return null;
  const only = items.length === 1 ? items[0]! : undefined;
  if (only?.kind === "note") {
    return <span className="evidence-locator">{only.text}</span>;
  }
  if (only?.kind === "link" && only.label === undefined) {
    return (
      <a className="evidence-locator" href={only.url} target="_blank" rel="noreferrer">
        {only.url}
      </a>
    );
  }
  return (
    <ul className="locator-list">
      {items.map((item, index) =>
        item.kind === "link" ? (
          <li key={index}>
            {item.label !== undefined && <span className="locator-note">{item.label}</span>}
            <a className="evidence-locator" href={item.url} target="_blank" rel="noreferrer">
              {item.url}
            </a>
          </li>
        ) : (
          <li key={index}>
            <span className="locator-note">{item.text}</span>
          </li>
        ),
      )}
    </ul>
  );
}

/** Script evidence as a code block, math as a block, reference as a citation. */
export function EvidenceBlock({ evidence }: { evidence: EvidenceView }) {
  switch (evidence.kind) {
    case "script":
      return (
        <div>
          <span className="detail-label">script evidence</span>
          <pre className="code-block">
            <code>{evidence.code}</code>
          </pre>
          {evidence.result !== undefined && (
            <div className="evidence-result">→ {evidence.result}</div>
          )}
        </div>
      );
    case "math":
      return (
        <div>
          <span className="detail-label">math evidence</span>
          <div className="math-block">{evidence.derivation}</div>
        </div>
      );
    case "reference":
      return (
        <div>
          <span className="detail-label">reference</span>
          <div>{evidence.citation}</div>
          <LocatorBlock locator={evidence.locator} />
          <div className="evidence-shows">shows: {evidence.shows}</div>
        </div>
      );
  }
}

/** Panel seat card, shared by Panel selection and the Confirm gate. */
export function SeatCard({
  seat,
  member,
  removed = false,
  checkbox,
}: {
  seat: number;
  member: PanelMemberView;
  removed?: boolean;
  checkbox?: { checked: boolean; onToggle: () => void };
}) {
  const body = (
    <>
      <div className="seat-head">
        <span className="seat-no">Seat {seat}</span>
        {removed && <span className="chip chip-dim">removed at confirmation</span>}
        {member.dismissed && <span className="chip chip-dim">dismissed</span>}
        {checkbox && (
          <input
            type="checkbox"
            checked={checkbox.checked}
            onChange={checkbox.onToggle}
            aria-label={`keep seat ${seat} (${member.umbrella})`}
          />
        )}
      </div>
      <span className="seat-dept">{member.department}</span>
      <span className="seat-umbrella">{member.umbrella}</span>
      {member.subfields.length > 0 && (
        <div className="tag-row">
          {member.subfields.map((s) => (
            <span key={s} className="tag">
              {s}
            </span>
          ))}
        </div>
      )}
    </>
  );
  if (checkbox) {
    return (
      <label className={`seat-card seat-selectable${checkbox.checked ? "" : " seat-unchecked"}`}>
        {body}
      </label>
    );
  }
  // Dismissal and gate-removal read the same way at a glance (a seat that is no
  // longer taking part) but are distinct facts, so they carry distinct classes
  // and distinct chips.
  const state = removed ? " seat-removed" : member.dismissed ? " seat-dismissed" : "";
  return <div className={`seat-card${state}`}>{body}</div>;
}

/**
 * Dismiss control for one panel seat, with the inline confirm the rest of the
 * app uses for irreversible actions (the job card's cancel/trash, the
 * credit-block banner). Dismissal cannot be undone — the seat takes no further
 * part in the run — so it always asks first, and it says what the cost is:
 * stopping the worker means the other seats resume from the last checkpoint.
 */
export function DismissSeatButton({
  label,
  dismissed,
  onDismiss,
}: {
  label: string;
  dismissed: boolean;
  onDismiss: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dismissed) return <span className="chip chip-dim">dismissed</span>;
  if (!confirming) {
    return (
      <span className="seat-dismiss">
        {error && <span className="error-text">{error}</span>}
        <button
          type="button"
          className="ghost-btn btn-small"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Dismiss
        </button>
      </span>
    );
  }
  return (
    <span className="cancel-zone seat-dismiss">
      <span className="cancel-question">
        Dismiss {label}? It stops contributing and reviewing for the rest of the
        run; work in flight on the other seats restarts from the last checkpoint.
      </span>
      <button
        type="button"
        className="btn btn-danger btn-small"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void onDismiss()
            .then(() => setConfirming(false))
            .catch((e: unknown) =>
              setError(e instanceof Error ? e.message : String(e)),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Dismissing…" : "Yes, dismiss"}
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
  );
}

/**
 * Reveals text at a steady pace instead of in the chunks it arrives in.
 *
 * The pacing rule itself is `revealStep`, in the pure module beside this one.
 * Here it is only driven: a shown-length walks toward the real length every
 * frame, so what a reader sees is writing rather than delivery.
 *
 * Two cases are deliberately NOT paced: the first text this component ever sees
 * (a reader opening the page mid-task should not watch a minute of backlog type
 * itself out) and a replacement shorter than what is already shown (a repair
 * frame, which must land at once or the thread would read as corrupt).
 */
function useRevealed(text: string): string {
  const [shown, setShown] = useState(() => text.length);
  const target = useRef(text.length);
  target.current = text.length;
  useEffect(() => {
    let frame = 0;
    let previous = 0;
    const tick = (now: number): void => {
      const elapsed = previous === 0 ? 16 : Math.min(now - previous, 250);
      previous = now;
      setShown((current) =>
        // Identical state means React re-renders nothing, so an idle thread
        // costs a function call per frame and no more.
        current >= target.current ? current : revealStep(current, target.current, elapsed),
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  // A shorter text is a repair, not a rewind.
  return text.length < shown ? text : text.slice(0, shown);
}

/**
 * The words a model is producing right now, as a thread to read while waiting.
 *
 * NOT the chain of thought, and deliberately styled so it cannot be mistaken for
 * one: dim, monospaced, boxed, and labelled as live. It exists because a task
 * that runs for minutes used to show the word "thinking" and nothing else. When
 * the task's real output arrives this disappears and the output takes its place —
 * so nothing here is ever the record of anything.
 *
 * Pinned to the newest words unless the reader scrolls back to read.
 */
export function LiveThread({ text, label }: { text: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const shown = useRevealed(text);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box && pinned.current) box.scrollTop = box.scrollHeight;
  }, [shown]);
  if (text.trim().length === 0) return null;
  return (
    <div className="live-thread">
      <div className="live-thread-head">
        <span className="dot dot-accent pulse" aria-hidden />
        {/* "Seat 2 is thinking", the verb breathing on the shared soft-pulse —
            which already stops for prefers-reduced-motion and paused runs. */}
        <span>
          {label !== undefined && `${label} is `}
          <span className="pulse">thinking</span>
        </span>
      </div>
      <div
        className="live-thread-body"
        ref={ref}
        onScroll={(event) => {
          const box = event.currentTarget;
          pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        }}
      >
        {shown}
      </div>
    </div>
  );
}
