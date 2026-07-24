/** Shared UI primitives used across panels: dots, clamps, chips, evidence. */
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  EvidenceView,
  PanelMemberView,
  StageActivityEntry,
  Verdict,
} from "@brainstorm-agentic/protocol";
import type { DotState } from "../format";

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
  const visible = entries.slice(-20);
  if (visible.length === 0) return null;
  const lastAt = visible[visible.length - 1]!.at;
  const quietMs = active && now !== undefined ? now - lastAt : 0;
  return (
    <div className="activity-feed" aria-live={active ? "polite" : "off"}>
      <div className="activity-head">
        <span>Activity</span>
        <span className="dim">{entries.length} events</span>
      </div>
      <ol className="activity-list">
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

function maybeLink(locator: string) {
  if (/^https?:\/\//i.test(locator)) {
    return (
      <a className="evidence-locator" href={locator} target="_blank" rel="noreferrer">
        {locator}
      </a>
    );
  }
  return <span className="evidence-locator">{locator}</span>;
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
          {maybeLink(evidence.locator)}
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
