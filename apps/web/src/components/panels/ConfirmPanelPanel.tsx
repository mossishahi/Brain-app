/** Stage 4 — Confirm panel: the human gate (pending action card / decided line). */
import { useEffect, useState } from "react";
import type {
  ConfirmPanelStage,
  GateAnswerRequest,
  PanelMemberView,
  PendingGateView,
} from "@brainstorm-agentic/protocol";
import { errorMessage } from "../../api";
import { formatClock } from "../../format";
import { SeatCard } from "../common";

export function GateCard({
  pendingGate,
  fallbackMembers,
  onAnswer,
}: {
  pendingGate?: PendingGateView;
  fallbackMembers?: readonly PanelMemberView[];
  onAnswer: (req: GateAnswerRequest) => Promise<void>;
}) {
  const members = pendingGate?.members ?? fallbackMembers ?? [];
  const gateKey = pendingGate?.gateKey;
  const idsKey = members.map((m) => m.id).join("|");

  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(members.map((m) => m.id)),
  );
  const [phase, setPhase] = useState<"idle" | "busy" | "resuming">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChecked(new Set(idsKey ? idsKey.split("|") : []));
    setPhase("idle");
    setError(null);
  }, [gateKey, idsKey]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const kept = members.filter((m) => checked.has(m.id));
  const canShrink = kept.length >= 2 && kept.length < members.length;

  const answer = async (action: "approve" | "shrink") => {
    if (!gateKey) return;
    setPhase("busy");
    setError(null);
    const req: GateAnswerRequest =
      action === "shrink"
        ? { gateKey, action, members: kept.map((m) => m.id) }
        : { gateKey, action };
    try {
      await onAnswer(req);
      setPhase("resuming");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("idle");
    }
  };

  return (
    <div className="gate-card">
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
            disabled={phase !== "idle" || !gateKey}
            onClick={() => void answer("approve")}
          >
            Approve panel
          </button>
          <button
            type="button"
            className="btn"
            disabled={phase !== "idle" || !gateKey || !canShrink}
            onClick={() => void answer("shrink")}
          >
            Continue with selected
          </button>
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
  return (
    <p className="gate-decided">
      {text}
      {gate.decidedAt !== undefined && ` · ${formatClock(gate.decidedAt)}`}
    </p>
  );
}
