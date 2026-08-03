/**
 * Stage 1 — Process input: the structured input, the file map, and (on
 * split-classification bundles) the classification record — the two offered
 * readings with the confirmation gate card while it is pending.
 */
import { useEffect, useRef, useState } from "react";
import type {
  AnnotatedFileView,
  ClassificationStageView,
  FilePartitionView,
  GateAnswerRequest,
  PendingGateView,
  ProcessorOutputView,
  RequestedOutputView,
} from "@brainstorm-agentic/protocol";
import { CLASSIFICATION_EDIT_LIMITS } from "@brainstorm-agentic/protocol";
import { errorMessage } from "../../api";
import { formatClock } from "../../format";
import { Clamp } from "../common";
import { AutoApproveBar } from "./ConfirmPanelPanel";

/** Last path segments so long snapshot paths stay scannable; full path on hover. */
function shortPath(path: string, segments = 3): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}

function FileTable({ files }: { files: readonly AnnotatedFileView[] }) {
  return (
    <table className="paper-table file-table">
      <thead>
        <tr>
          <th>File</th>
          <th>Label</th>
          <th>Relation</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr key={file.path}>
            <td className="file-path" title={file.path}>
              {shortPath(file.path)}
            </td>
            <td>
              <span className="tag">{file.label}</span>
            </td>
            <td>
              {file.note || "—"}
              {file.codeSummary && (
                <div className="dim small">{file.codeSummary}</div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Lists longer than this open collapsed; short maps stay visible at a glance. */
const COLLAPSE_FILES_ABOVE = 12;

/** The orchestrator's file partition: what later calls see vs what was dropped. */
function FilePartition({ files }: { files: FilePartitionView }) {
  const [showFiles, setShowFiles] = useState(
    files.useful.length <= COLLAPSE_FILES_ABOVE,
  );
  const [showIgnored, setShowIgnored] = useState(false);
  return (
    <div className="file-partition">
      <p className="section-label">
        Files sent to the panel ({files.useful.length})
      </p>
      {files.useful.length > 0 ? (
        <>
          <button
            type="button"
            className="more-btn"
            onClick={() => setShowFiles((v) => !v)}
          >
            {showFiles ? "hide" : "show"} the file map ({files.useful.length})
          </button>
          {showFiles && (
            <div className="file-scroll">
              <FileTable files={files.useful} />
            </div>
          )}
        </>
      ) : (
        <p className="dim small">no useful files — every file was labeled NA</p>
      )}
      {files.ignored.length > 0 && (
        <>
          <button
            type="button"
            className="more-btn"
            onClick={() => setShowIgnored((v) => !v)}
          >
            {showIgnored ? "hide" : "show"} ignored files ({files.ignored.length}
            , labeled NA — removed from all later model calls)
          </button>
          {showIgnored && (
            <div className="file-scroll">
              <ul className="ignored-list">
                {files.ignored.map((file) => (
                  <li key={file.path} title={file.path}>
                    <span className="file-path">{shortPath(file.path)}</span>
                    {file.note && <span className="dim small"> — {file.note}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One selectable reading of the submission (radio card with the reason). */
function TypeOptionCard({
  label,
  type,
  reason,
  selected,
  onSelect,
}: {
  label: string;
  type: string;
  reason: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label className={`seat-card${selected ? " seat-custom" : ""}`} style={{ cursor: "pointer" }}>
      <div className="seat-head">
        <input
          type="radio"
          name="classification-type"
          checked={selected}
          onChange={onSelect}
          aria-label={`read the submission as ${type}`}
        />
        <span className="seat-no">{label}</span>
      </div>
      <span className="seat-umbrella">{type}</span>
      <p className="dim small">{reason}</p>
    </label>
  );
}

/**
 * The pending classification gate: the two offered readings (plus every
 * other catalog type), the editable requested-output list, and the shared
 * auto-approve countdown with its pause control.
 */
export function ClassificationGateCard({
  pendingGate,
  onAnswer,
  onHold,
}: {
  pendingGate?: PendingGateView;
  onAnswer: (req: GateAnswerRequest) => Promise<void>;
  onHold?: () => void;
}) {
  const gateKey = pendingGate?.gateKey;
  const classification = pendingGate?.classification;
  const initialAsksKey = JSON.stringify(classification?.requestedOutputs ?? []);

  const [selectedType, setSelectedType] = useState(classification?.primary.type ?? "");
  const [asks, setAsks] = useState<readonly RequestedOutputView[]>(
    classification?.requestedOutputs ?? [],
  );
  const [newTitle, setNewTitle] = useState("");
  const [newAsk, setNewAsk] = useState("");
  const [phase, setPhase] = useState<"idle" | "busy" | "resuming">("idle");
  const [error, setError] = useState<string | null>(null);
  const holdRequested = useRef(false);

  useEffect(() => {
    setSelectedType(classification?.primary.type ?? "");
    setAsks(classification?.requestedOutputs ?? []);
    setNewTitle("");
    setNewAsk("");
    setPhase("idle");
    setError(null);
    holdRequested.current = false;
    // Reset exactly when a different gate (or classification) arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateKey, classification?.primary.type, initialAsksKey]);

  if (!classification) {
    return (
      <div className="gate-card">
        <p className="gate-title">
          {pendingGate?.prompt ?? "The classification is waiting for your confirmation."}
        </p>
        <p className="dim small">classification details unavailable</p>
      </div>
    );
  }

  const autoApprove = pendingGate?.autoApprove;
  const countdownActive = autoApprove !== undefined && !autoApprove.held;
  const maybeHold = () => {
    if (!countdownActive || holdRequested.current) return;
    holdRequested.current = true;
    onHold?.();
  };

  const otherTypes = classification.typeOptions.filter(
    (name) =>
      name !== classification.primary.type && name !== classification.alternative.type,
  );
  const typeChanged = selectedType !== classification.primary.type;
  const asksChanged = JSON.stringify(asks) !== initialAsksKey;

  const titleOk = newTitle.trim().length >= CLASSIFICATION_EDIT_LIMITS.minTitleChars;
  const askOk = newAsk.trim().length >= CLASSIFICATION_EDIT_LIMITS.minAskChars;
  const roomLeft = asks.length < CLASSIFICATION_EDIT_LIMITS.maxRequestedOutputs;
  const titleTaken = asks.some((entry) => entry.title === newTitle.trim());
  const canAddAsk = titleOk && askOk && roomLeft && !titleTaken;

  const addAsk = () => {
    if (!canAddAsk) return;
    setAsks((current) => [...current, { title: newTitle.trim(), ask: newAsk.trim() }]);
    setNewTitle("");
    setNewAsk("");
  };

  const answer = async () => {
    if (!gateKey) return;
    setPhase("busy");
    setError(null);
    const req: GateAnswerRequest =
      typeChanged || asksChanged
        ? {
            gateKey,
            action: "revise",
            ...(typeChanged ? { type: selectedType } : {}),
            ...(asksChanged ? { requestedOutputs: asks } : {}),
          }
        : { gateKey, action: "approve" };
    try {
      await onAnswer(req);
      setPhase("resuming");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("idle");
    }
  };

  const buttonLabel = typeChanged
    ? `Continue as "${selectedType}"`
    : asksChanged
      ? "Continue with edited asks"
      : "Confirm reading";

  return (
    // Any interaction inside the card pauses the countdown: the user is
    // present and deciding (same contract as the panel gate).
    <div className="gate-card" onPointerDownCapture={maybeHold}>
      {countdownActive && (
        <AutoApproveBar
          deadlineAt={autoApprove.deadlineAt}
          totalMs={autoApprove.totalMs}
          onPause={maybeHold}
        />
      )}
      {autoApprove?.held && (
        <p className="gate-held dim small">auto-approve paused — take your time</p>
      )}
      <p className="gate-title">
        {pendingGate?.prompt ??
          "Review how the submission was read before the panel is assembled."}
      </p>
      <div className="seat-grid">
        <TypeOptionCard
          label="Primary reading"
          type={classification.primary.type}
          reason={classification.primary.reason}
          selected={selectedType === classification.primary.type}
          onSelect={() => setSelectedType(classification.primary.type)}
        />
        <TypeOptionCard
          label="Alternative reading"
          type={classification.alternative.type}
          reason={classification.alternative.reason}
          selected={selectedType === classification.alternative.type}
          onSelect={() => setSelectedType(classification.alternative.type)}
        />
      </div>
      {otherTypes.length > 0 && (
        <div className="fact-row">
          <label className="dim small" htmlFor="classification-other-type">
            or another type:
          </label>
          <select
            id="classification-other-type"
            className="ghost-input"
            value={otherTypes.includes(selectedType) ? selectedType : ""}
            onChange={(event) => {
              if (event.target.value) setSelectedType(event.target.value);
            }}
          >
            <option value="">choose…</option>
            {otherTypes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="section-label">
        Requested outputs the panel must answer ({asks.length}/
        {CLASSIFICATION_EDIT_LIMITS.maxRequestedOutputs})
      </p>
      {asks.length > 0 ? (
        <ul className="assumptions">
          {asks.map((entry, index) => (
            <li key={entry.title}>
              <strong>{entry.title}</strong>
              <span className="dim"> — {entry.ask}</span>
              <button
                type="button"
                className="ghost-subfield-remove"
                aria-label={`remove requested output ${entry.title}`}
                onClick={() => setAsks((current) => current.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim small">none — the panel answers the type's standard deliverable</p>
      )}
      {roomLeft && (
        <div className="ghost-subfields">
          <div className="ghost-subfield-row">
            <input
              type="text"
              className="ghost-input"
              placeholder="Ask title"
              aria-label="new requested-output title"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
            />
            <input
              type="text"
              className="ghost-input"
              placeholder="What exactly must the response contain?"
              aria-label="new requested-output ask"
              value={newAsk}
              onChange={(event) => setNewAsk(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!canAddAsk || phase !== "idle"}
              onClick={addAsk}
            >
              Add ask
            </button>
          </div>
          {(newTitle.length > 0 || newAsk.length > 0) && !canAddAsk && (
            <p className="dim small">
              {titleTaken
                ? "titles must be unique"
                : `title needs ${CLASSIFICATION_EDIT_LIMITS.minTitleChars}+ chars, ask ${CLASSIFICATION_EDIT_LIMITS.minAskChars}+ chars`}
            </p>
          )}
        </div>
      )}
      {phase === "resuming" ? (
        <p className="dim small">resuming…</p>
      ) : (
        <div className="gate-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={phase !== "idle" || !gateKey}
            onClick={() => void answer()}
          >
            {buttonLabel}
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/** The classification record once the gate is no longer pending. */
export function ClassificationDecided({
  classification,
}: {
  classification: ClassificationStageView;
}) {
  const { gate } = classification;
  if (gate.state === "not-reached") return null;
  const chosen = gate.chosenType ?? classification.primary.type;
  const text =
    gate.state === "auto-approved"
      ? `Read as "${chosen}" (auto-approved)`
      : gate.state === "revised"
        ? `Revised to "${chosen}"`
        : `Confirmed as "${chosen}"`;
  return (
    <div className="classification-decided">
      <p className="gate-decided">
        {text}
        {gate.decidedAt !== undefined && ` · ${formatClock(gate.decidedAt)}`}
        <span className="dim small">
          {" "}
          (alternative was "
          {chosen === classification.alternative.type
            ? classification.primary.type
            : classification.alternative.type}
          ")
        </span>
      </p>
    </div>
  );
}

export function ProcessInputBody({
  output,
  files,
}: {
  output: ProcessorOutputView;
  files?: FilePartitionView;
}) {
  return (
    <div>
      <div className="fact-row">
        {/* What kind of submission this is; shapes the First pass primary tab.
            Absent while the run sits between preprocessing and classification. */}
        {output.type !== undefined ? (
          <span className="chip chip-accent">{output.type}</span>
        ) : (
          <span className="chip chip-dim">type: classifying…</span>
        )}
        {output.cotSteps !== undefined && (
          <span className="chip chip-dim">{output.cotSteps} chain steps</span>
        )}
      </div>
      <h3 className="artifact-title">{output.title}</h3>
      <blockquote className="question">{output.question}</blockquote>
      <Clamp text={output.context} />
      {output.requestedOutputs && output.requestedOutputs.length > 0 && (
        <>
          {/* Explicit deliverables the submitter asked for: every panel
              member's output must answer each one with a dedicated section. */}
          <p className="section-label">
            Requested outputs ({output.requestedOutputs.length})
          </p>
          <ul className="assumptions">
            {output.requestedOutputs.map((requested) => (
              <li key={requested.title}>
                <strong>{requested.title}</strong>
                <span className="dim"> — {requested.ask}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="section-label">Assumptions</p>
      {output.assumptions.length > 0 ? (
        <ul className="assumptions">
          {output.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : (
        <p className="dim small">no assumptions detected</p>
      )}
      {output.attachments.length > 0 && (
        <>
          <p className="section-label">Attachments</p>
          <div className="attachment-row">
            {output.attachments.map((att) => (
              <span key={att.name} className="chip chip-file" title={att.note}>
                <strong>{att.name}</strong>
                <span className="chip-note">{att.note}</span>
              </span>
            ))}
          </div>
        </>
      )}
      {files && <FilePartition files={files} />}
    </div>
  );
}
