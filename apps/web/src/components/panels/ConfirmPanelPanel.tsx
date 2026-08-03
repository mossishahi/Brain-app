/** Stage 4 — Confirm panel: the human gate (pending action card / decided line). */
import { useEffect, useRef, useState } from "react";
import type {
  ConfirmPanelStage,
  CustomSeatRequest,
  GateAnswerRequest,
  PanelMemberView,
  PendingGateView,
} from "@brainstorm-agentic/protocol";
import { PANEL_EDIT_LIMITS } from "@brainstorm-agentic/protocol";
import { errorMessage } from "../../api";
import { formatClock } from "../../format";
import { SeatCard } from "../common";

/**
 * The auto-approve countdown: a thin warn-colored bar filling toward the
 * deadline, with a pause control. Any click inside the gate card (captured
 * by the card container) or on the pause button holds it permanently.
 * Shared with the classification gate card (ProcessInputPanel).
 */
export function AutoApproveBar({
  deadlineAt,
  totalMs,
  onPause,
}: {
  deadlineAt: number;
  totalMs: number;
  onPause: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, []);
  const remainingMs = Math.max(0, deadlineAt - now);
  const progress = Math.min(100, Math.max(0, 100 * (1 - remainingMs / totalMs)));
  return (
    <div className="gate-countdown" role="timer" aria-live="off">
      <div className="gate-countdown-track" aria-hidden>
        <div className="gate-countdown-fill" style={{ width: `${progress}%` }} />
      </div>
      <span className="gate-countdown-text">
        auto-approves in {Math.ceil(remainingMs / 1000)}s — click anywhere to pause
      </span>
      <button
        type="button"
        className="gate-countdown-pause"
        aria-label="pause auto-approve"
        title="Pause auto-approve and take your time"
        onClick={onPause}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="1" y="1" width="3" height="8" rx="1" fill="currentColor" />
          <rect x="6" y="1" width="3" height="8" rx="1" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

/** The builder for one user-defined seat: department, field, 1-3 subfields. */
function CustomSeatBuilder({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (seat: CustomSeatRequest) => void;
}) {
  const [department, setDepartment] = useState("");
  const [field, setField] = useState("");
  const [subfields, setSubfields] = useState<string[]>([]);

  const trimmedSubfields = subfields
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const valid =
    department.trim().length > 0 &&
    field.trim().length > 0 &&
    trimmedSubfields.length >= PANEL_EDIT_LIMITS.minSubfields &&
    trimmedSubfields.length <= PANEL_EDIT_LIMITS.maxSubfields;

  const add = () => {
    if (!valid || disabled) return;
    onAdd({
      department: department.trim(),
      umbrella: field.trim(),
      subfields: trimmedSubfields,
    });
    setDepartment("");
    setField("");
    setSubfields([]);
  };

  return (
    <div className="seat-card seat-ghost">
      <div className="seat-head">
        <span className="seat-no">Add your own seat</span>
      </div>
      <input
        type="text"
        className="ghost-input ghost-dept"
        placeholder="Department"
        aria-label="custom seat department"
        value={department}
        onChange={(event) => setDepartment(event.target.value)}
      />
      <input
        type="text"
        className="ghost-input ghost-field"
        placeholder="Field"
        aria-label="custom seat field"
        value={field}
        onChange={(event) => setField(event.target.value)}
      />
      <div className="ghost-subfields">
        {subfields.map((value, index) => (
          <div className="ghost-subfield-row" key={index}>
            <input
              type="text"
              className="ghost-input"
              placeholder={`Subfield ${index + 1}`}
              aria-label={`custom seat subfield ${index + 1}`}
              value={value}
              onChange={(event) =>
                setSubfields((current) =>
                  current.map((entry, i) => (i === index ? event.target.value : entry)),
                )
              }
            />
            <button
              type="button"
              className="ghost-subfield-remove"
              aria-label={`remove subfield ${index + 1}`}
              onClick={() =>
                setSubfields((current) => current.filter((_, i) => i !== index))
              }
            >
              ×
            </button>
          </div>
        ))}
        {subfields.length < PANEL_EDIT_LIMITS.maxSubfields && (
          <button
            type="button"
            className="ghost-add-subfield"
            aria-label="add a subfield"
            title={`Add a subfield (${PANEL_EDIT_LIMITS.minSubfields}-${PANEL_EDIT_LIMITS.maxSubfields})`}
            onClick={() => setSubfields((current) => [...current, ""])}
          >
            <span aria-hidden>+</span>
          </button>
        )}
      </div>
      <button
        type="button"
        className="btn btn-small"
        disabled={!valid || disabled}
        onClick={add}
      >
        Add seat
      </button>
      <span className="ghost-hint">
        {PANEL_EDIT_LIMITS.minSubfields}–{PANEL_EDIT_LIMITS.maxSubfields} subfields
      </span>
    </div>
  );
}

export function GateCard({
  pendingGate,
  fallbackMembers,
  onAnswer,
  onHold,
}: {
  pendingGate?: PendingGateView;
  fallbackMembers?: readonly PanelMemberView[];
  onAnswer: (req: GateAnswerRequest) => Promise<void>;
  onHold?: () => void;
}) {
  const members = pendingGate?.members ?? fallbackMembers ?? [];
  const gateKey = pendingGate?.gateKey;
  const idsKey = members.map((m) => m.id).join("|");

  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(members.map((m) => m.id)),
  );
  const [addedSeats, setAddedSeats] = useState<readonly CustomSeatRequest[]>([]);
  const [phase, setPhase] = useState<"idle" | "busy" | "resuming">("idle");
  const [error, setError] = useState<string | null>(null);
  const holdRequested = useRef(false);

  useEffect(() => {
    setChecked(new Set(idsKey ? idsKey.split("|") : []));
    setAddedSeats([]);
    setPhase("idle");
    setError(null);
    holdRequested.current = false;
  }, [gateKey, idsKey]);

  const autoApprove = pendingGate?.autoApprove;
  const countdownActive = autoApprove !== undefined && !autoApprove.held;
  const maybeHold = () => {
    if (!countdownActive || holdRequested.current) return;
    holdRequested.current = true;
    onHold?.();
  };

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const kept = members.filter((m) => checked.has(m.id));
  const total = kept.length + addedSeats.length;
  // The checkboxes ARE the decision: removing a seat turns the single submit
  // action into a shrink. A separate always-enabled "approve" button used to
  // silently discard the selection — the seats stayed unchecked on screen but
  // the full panel ran.
  const shrinking = members.length > 0 && kept.length < members.length;
  const tooFew = total < PANEL_EDIT_LIMITS.minMembers;
  const full = total >= PANEL_EDIT_LIMITS.maxMembers;

  const answer = async () => {
    if (!gateKey || tooFew) return;
    setPhase("busy");
    setError(null);
    const req: GateAnswerRequest = {
      gateKey,
      ...(shrinking
        ? { action: "shrink" as const, members: kept.map((m) => m.id) }
        : { action: "approve" as const }),
      ...(addedSeats.length > 0 ? { addedMembers: addedSeats } : {}),
    };
    try {
      await onAnswer(req);
      setPhase("resuming");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("idle");
    }
  };

  const buttonLabel =
    (shrinking
      ? `Continue with ${kept.length} of ${members.length} seats`
      : "Approve panel") +
    (addedSeats.length > 0 ? ` + ${addedSeats.length} custom` : "");

  return (
    // Any interaction inside the confirmation card pauses the countdown: the
    // user is present and deciding.
    <div className="gate-card" onPointerDownCapture={maybeHold}>
      {countdownActive && (
        <AutoApproveBar
          deadlineAt={autoApprove.deadlineAt}
          totalMs={autoApprove.totalMs}
          onPause={maybeHold}
        />
      )}
      {autoApprove?.held && (
        <p className="gate-held dim small">
          auto-approve paused — take your time
        </p>
      )}
      <p className="gate-title">
        {pendingGate?.prompt ?? "The panel is waiting for your confirmation."}
      </p>
      {members.length > 0 ? (
        <div className="seat-grid">
          {members.map((member, i) => (
            <SeatCard
              key={member.id}
              seat={i + 1}
              member={member}
              checkbox={{ checked: checked.has(member.id), onToggle: () => toggle(member.id) }}
            />
          ))}
          {addedSeats.map((seat, index) => (
            <div className="seat-card seat-custom" key={`custom-${index}`}>
              <div className="seat-head">
                <span className="seat-no">Custom seat</span>
                <button
                  type="button"
                  className="ghost-subfield-remove"
                  aria-label={`remove custom seat ${seat.umbrella}`}
                  onClick={() =>
                    setAddedSeats((current) => current.filter((_, i) => i !== index))
                  }
                >
                  ×
                </button>
              </div>
              <span className="seat-dept">{seat.department}</span>
              <span className="seat-umbrella">{seat.umbrella}</span>
              <div className="tag-row">
                {seat.subfields.map((subfield) => (
                  <span key={subfield} className="tag">
                    {subfield}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <CustomSeatBuilder
            disabled={phase !== "idle" || full}
            onAdd={(seat) => setAddedSeats((current) => [...current, seat])}
          />
        </div>
      ) : (
        <p className="dim small">panel details unavailable</p>
      )}
      {phase === "resuming" ? (
        <p className="dim small">resuming…</p>
      ) : (
        <div className="gate-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={phase !== "idle" || !gateKey || tooFew}
            onClick={() => void answer()}
          >
            {buttonLabel}
          </button>
          {tooFew && (
            <p className="dim small">
              A panel needs at least {PANEL_EDIT_LIMITS.minMembers} seats —
              re-check members or add custom ones.
            </p>
          )}
          {full && (
            <p className="dim small">
              The panel is at its {PANEL_EDIT_LIMITS.maxMembers}-seat maximum.
            </p>
          )}
        </div>
      )}
      {!gateKey && <p className="dim small">gate details unavailable</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

export function GateDecided({
  gate,
  panel,
}: {
  gate: ConfirmPanelStage["gate"];
  panel?: readonly PanelMemberView[];
}) {
  const removed = gate.removedMemberIds ?? [];
  const addedCount = gate.addedMemberIds?.length ?? 0;
  let text: string;
  switch (gate.state) {
    case "approved":
      text = "Approved as seated";
      break;
    case "auto-approved":
      text = "Approved automatically (settings)";
      break;
    case "shrunk": {
      const labels = removed.map((id) => panel?.find((m) => m.id === id)?.umbrella ?? id);
      const keptCount = panel ? panel.length - removed.length : undefined;
      text = `Shrunk to ${keptCount ?? "fewer"} members (removed: ${labels.join(", ")})`;
      break;
    }
    default:
      text = gate.state;
  }
  if (addedCount > 0) {
    text += ` · added ${addedCount} custom seat${addedCount === 1 ? "" : "s"}`;
  }
  return (
    <p className="gate-decided">
      {text}
      {gate.decidedAt !== undefined && ` · ${formatClock(gate.decidedAt)}`}
    </p>
  );
}
