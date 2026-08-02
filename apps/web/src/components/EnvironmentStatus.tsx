/**
 * The environment status icons next to the Brain Registry indicator: model
 * connection, internet, code workspace, and — only when the runner is SLURM —
 * the scheduler. Icons are hidden entirely when their check is not required
 * ("skipped"); clicking one opens a popover with the outcome, the technical
 * detail, the (LLM-generated) fix advice, and re-run / diagnose actions.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ReadinessCheck,
  ReadinessCheckId,
  ReadinessReport,
} from "@brainstorm-agentic/protocol";
import { GlobeIcon, QueueIcon, SparkIcon, TerminalIcon } from "./Icons";

const ICONS: Partial<Record<ReadinessCheckId, ReactNode>> = {
  llm: <SparkIcon size={15} />,
  internet: <GlobeIcon size={15} />,
  code: <TerminalIcon size={15} />,
  slurm: <QueueIcon size={15} />,
};

/** The registry has its own brain icon; the strip renders the other checks. */
const STRIP_ORDER: readonly ReadinessCheckId[] = [
  "llm",
  "code",
  "internet",
  "slurm",
];

function stateClass(check: ReadinessCheck): string {
  switch (check.state) {
    case "ok":
      return "state-ok";
    case "failed":
      return "state-failed";
    case "checking":
      return "state-checking";
    default:
      return "state-unknown";
  }
}

function stateWord(check: ReadinessCheck): string {
  switch (check.state) {
    case "ok":
      return "ok";
    case "failed":
      return "failed";
    case "checking":
      return "checking…";
    default:
      return "not checked yet";
  }
}

export function EnvironmentStatus({
  readiness,
  onRecheck,
  onDiagnose,
  onOpenSettings,
}: {
  readonly readiness: ReadinessReport | null;
  readonly onRecheck: (checks?: readonly ReadinessCheckId[]) => void;
  readonly onDiagnose: (check: ReadinessCheckId) => void;
  readonly onOpenSettings: () => void;
}) {
  const [openCheck, setOpenCheck] = useState<ReadinessCheckId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openCheck === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenCheck(null);
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpenCheck(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openCheck]);

  if (!readiness) return null;
  const visible = readiness.checks.filter(
    (check) => check.state !== "skipped" && ICONS[check.id] !== undefined,
  );
  const ordered = STRIP_ORDER.flatMap((id) => {
    const check = visible.find((candidate) => candidate.id === id);
    return check ? [check] : [];
  });
  if (ordered.length === 0) return null;
  const open = openCheck
    ? (ordered.find((check) => check.id === openCheck) ?? null)
    : null;

  return (
    <div className="env-status" ref={rootRef}>
      {ordered.map((check) => (
        <button
          key={check.id}
          type="button"
          className={`env-icon ${stateClass(check)}${openCheck === check.id ? " env-icon-open" : ""}`}
          aria-label={`${check.label}: ${stateWord(check)}${check.message ? ` — ${check.message}` : ""}`}
          data-tooltip={`${check.label} · ${stateWord(check)}${check.message ? ` — ${check.message}` : ""}`}
          onClick={() =>
            setOpenCheck((current) => (current === check.id ? null : check.id))
          }
        >
          {ICONS[check.id]}
        </button>
      ))}
      {open && (
        <div className="env-popover" role="dialog" aria-label={`${open.label} check`}>
          <div className="env-popover-head">
            <span className={`env-state-dot ${stateClass(open)}`} aria-hidden />
            <span className="env-popover-title">{open.label}</span>
            <span className="env-popover-state">{stateWord(open)}</span>
          </div>
          {open.message && <p className="env-popover-message">{open.message}</p>}
          {open.detail && (
            <pre className="env-popover-detail">
              <code>{open.detail}</code>
            </pre>
          )}
          {open.state === "failed" && (open.advice || open.advising) && (
            <div className="env-popover-advice">
              <span className="detail-label">
                {open.advising ? "asking the model for a fix…" : "how to fix"}
              </span>
              {open.advice && <p>{open.advice}</p>}
            </div>
          )}
          <div className="env-popover-actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={open.state === "checking"}
              onClick={() => onRecheck([open.id])}
            >
              Re-run check
            </button>
            {open.state === "failed" && open.id !== "llm" && (
              <button
                type="button"
                className="btn btn-small"
                disabled={open.advising === true}
                onClick={() => onDiagnose(open.id)}
              >
                Ask AI for help
              </button>
            )}
            {open.id === "llm" && (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setOpenCheck(null);
                  onOpenSettings();
                }}
              >
                Open settings
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
