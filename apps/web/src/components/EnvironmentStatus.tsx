/**
 * The environment status icons next to the Brain Registry indicator: model
 * connection, internet, code workspace, and — only when the runner is SLURM —
 * the scheduler. Icons are hidden entirely when their check is not required
 * ("skipped"); hovering or clicking opens a popover with the outcome, the technical
 * detail, the (LLM-generated) fix advice, and re-run / diagnose actions.
 */
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { useNavigationDismiss } from "../shell/useNavigationDismiss";
import type {
  ReadinessCheck,
  ReadinessCheckId,
  ReadinessReport,
} from "@brainstorm-agentic/protocol";
import { GlobeIcon, PlugIcon, QueueIcon, SparkIcon, TerminalIcon } from "./Icons";
import { ToolsAndProviders } from "./settings/ToolsAndProviders";
import { GpuSetupControl } from "../features/gpu/GpuSetup";
import "./secondary-surfaces.css";

const ICONS: Partial<Record<ReadinessCheckId, ReactNode>> = {
  llm: <SparkIcon size={15} />,
  capabilities: <PlugIcon size={15} />,
  internet: <GlobeIcon size={15} />,
  code: <TerminalIcon size={15} />,
  slurm: <QueueIcon size={15} />,
};

/** The registry has its own brain icon; the strip renders the other checks. */
const STRIP_ORDER: readonly ReadinessCheckId[] = [
  "llm",
  "capabilities",
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
  showToolChecks = true,
}: {
  readonly readiness: ReadinessReport | null;
  readonly onRecheck: (checks?: readonly ReadinessCheckId[]) => void;
  readonly onDiagnose: (check: ReadinessCheckId) => void;
  readonly onOpenSettings: () => void;
  readonly showToolChecks?: boolean;
}) {
  const [openCheck, setOpenCheck] = useState<ReadinessCheckId | null>(null);
  useNavigationDismiss(() => setOpenCheck(null));

  const visible = (readiness?.checks ?? []).filter(
    (check) => check.state !== "skipped" && ICONS[check.id] !== undefined
      && (showToolChecks || !["capabilities", "code", "internet"].includes(check.id)),
  );
  const ordered = STRIP_ORDER.flatMap((id) => {
    const check = visible.find((candidate) => candidate.id === id);
    return check ? [check] : [];
  });
  return (
    <div className="env-status">
      {!ordered.some(check => check.id === "llm") && <GpuSetupControl compact />}
      {ordered.map((check) => {
        const open = check;
        return <Fragment key={check.id}><Popover.Root
          open={openCheck === check.id}
          onOpenChange={(next) => setOpenCheck((current) => next ? check.id : current === check.id ? null : current)}
        >
        <Popover.Trigger
          openOnHover
          delay={160}
          closeDelay={240}
          type="button"
          className={`env-icon ${stateClass(check)}${openCheck === check.id ? " env-icon-open" : ""}`}
          aria-label={`${check.label}: ${stateWord(check)}${check.message ? ` — ${check.message}` : ""}`}
          data-tooltip={`${check.label} · ${stateWord(check)}${check.message ? ` — ${check.message}` : ""}`}
        >
          {ICONS[check.id]}
        </Popover.Trigger>
        <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={10} collisionPadding={12} className="canvas-env-positioner">
        <Popover.Popup className="env-popover canvas-env-popover" aria-label={`${open.label} check`}>
          <div className="env-popover-head">
            <span className={`env-state-dot ${stateClass(open)}`} aria-hidden />
            <span className="env-popover-title">{open.label}</span>
            <span className="env-popover-state">{stateWord(open)}</span>
            <Popover.Close className="canvas-env-close" aria-label="Close environment check">×</Popover.Close>
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
        </Popover.Popup>
        </Popover.Positioner>
        </Popover.Portal>
        </Popover.Root>{check.id === "llm" && <GpuSetupControl compact />}</Fragment>;
      })}
      {showToolChecks && <ToolsAndProviders compact />}
    </div>
  );
}
