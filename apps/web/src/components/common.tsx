/** Shared UI primitives used across panels: dots, clamps, chips, evidence. */
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  ActivityDetailView,
  EvidenceView,
  PanelMemberView,
  StageActivityEntry,
  TokenUsageView,
  Verdict,
} from "@brainstorm-agentic/protocol";
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

export function ActivityFeed({
  entries,
  active,
  now,
}: {
  entries: readonly StageActivityEntry[];
  active: boolean;
  /** Current time for the quiet-period ticker; omit to disable it. */
  now?: number;
}) {
  // Render the full server-provided window (capped server-side): trimming to
  // a client tail dropped the capability rows once a run's closing heartbeats
  // outnumbered them. The list scrolls; keep it pinned to the newest entry
  // unless the reader has scrolled back through the history.
  const visible = entries;
  const listRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight;
  }, [entries.length]);
  if (visible.length === 0) return null;
  const lastAt = visible[visible.length - 1]!.at;
  const quietMs = active && now !== undefined ? now - lastAt : 0;
  return (
    <div className="activity-feed" aria-live={active ? "polite" : "off"}>
      <div className="activity-head">
        <span>Activity</span>
        <span className="dim">{entries.length} events</span>
      </div>
      <ol
        className="activity-list"
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          pinnedRef.current =
            list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        }}
      >
        {visible.map((entry) => (
          <li key={entry.id} className={`activity-entry activity-${entry.kind}`}>
            <time dateTime={new Date(entry.at).toISOString()}>
              {new Date(entry.at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
            <span className="activity-marker" aria-hidden />
            <span className="activity-message">{entry.message}</span>
            {entry.turn !== undefined && (
              <span className="activity-meta">turn {entry.turn}</span>
            )}
            {entry.elapsedMs !== undefined && (
              <span className="activity-meta">
                {(entry.elapsedMs / 1000).toFixed(0)}s
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
          </li>
        ))}
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
  return <div className={`seat-card${removed ? " seat-removed" : ""}`}>{body}</div>;
}
