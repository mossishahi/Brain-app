/**
 * The optional confirm-needs gate (spec v2 D2; contract D/K): reached only
 * when the run's askUserToConfirmNeeds param is true. It shows the needs the
 * literature retrieval will use, with their weights, and allows exactly the
 * edits editRule "needs" permits — removing facets (at least 3 stay), aliases
 * and equivalent problems, and changing relevance / confidence within [0,1].
 * The same auto-approve countdown as the panel gate applies.
 */
import { useEffect, useRef, useState } from "react";
import type { PendingGateView } from "@brainstorm-agentic/protocol";
import { errorMessage, getNeedsGate } from "../../api";
import { AutoApproveBar } from "./ConfirmPanelPanel";
import {
  MIN_FACETS,
  needRows,
  needsEdited,
  needsGateAnswer,
  removeAlias,
  removeEquivalent,
  removeFacet,
  setConfidence,
  setRelevance,
  totalWeight,
  type NeedsGateAnswer,
  type NeedsGateView,
  type NeedsInput,
} from "./needs-model";
import "./needs-gate.css";

function WeightInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  disabled: boolean;
}) {
  return (
    <input
      type="number"
      className="needs-weight-input"
      min={0}
      max={1}
      step={0.05}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (event.target.value !== "" && Number.isFinite(next)) onChange(next);
      }}
    />
  );
}

export function NeedsGateCard({
  jobId,
  pendingGate,
  onAnswer,
  onHold,
}: {
  jobId: string;
  pendingGate?: PendingGateView;
  onAnswer: (req: NeedsGateAnswer) => Promise<void>;
  onHold?: () => void;
}) {
  const gateKey = pendingGate?.gateKey;
  const [view, setView] = useState<NeedsGateView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edited, setEdited] = useState<NeedsInput | null>(null);
  const [phase, setPhase] = useState<"idle" | "busy" | "resuming">("idle");
  const [error, setError] = useState<string | null>(null);
  const holdRequested = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setEdited(null);
    setLoadError(null);
    setPhase("idle");
    setError(null);
    holdRequested.current = false;
    if (!gateKey) return;
    getNeedsGate(jobId).then(
      (next) => {
        if (cancelled) return;
        setView(next);
        setEdited(next.embeddingInput);
      },
      (e: unknown) => {
        if (!cancelled) setLoadError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [jobId, gateKey]);

  const autoApprove = pendingGate?.autoApprove;
  const countdownActive = autoApprove !== undefined && !autoApprove.held;
  const maybeHold = () => {
    if (!countdownActive || holdRequested.current) return;
    holdRequested.current = true;
    onHold?.();
  };

  const busy = phase !== "idle";
  const original = view?.embeddingInput;
  const current = edited ?? original;
  const changed = original !== undefined && current !== undefined && needsEdited(original, current);
  const rows = current && view ? needRows(current, view.weights) : [];

  const answer = async () => {
    if (!gateKey || !original || !current) return;
    setPhase("busy");
    setError(null);
    try {
      await onAnswer(needsGateAnswer(gateKey, original, current));
      setPhase("resuming");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("idle");
    }
  };

  return (
    <div className="gate-card needs-gate" onPointerDownCapture={maybeHold}>
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
        {pendingGate?.prompt ?? "Confirm the needs the literature search and the panel will cover."}
      </p>
      {loadError && <p className="error-text">{loadError}</p>}
      {!current || !view ? (
        !loadError && <p className="dim small">loading the needs…</p>
      ) : (
        <>
          <table className="needs-table">
            <thead>
              <tr>
                <th scope="col">need</th>
                <th scope="col">weight</th>
                <th scope="col" aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <span className="chip chip-dim">core</span> {current.title}
                </th>
                <td>{view.weights.coreWeight.toFixed(2)}</td>
                <td />
              </tr>
              {current.facets.map((facet, index) => (
                <tr key={facet.name}>
                  <th scope="row">
                    <span className="chip chip-dim">{facet.kind ?? "facet"}</span> {facet.name}
                    <span className="needs-statement dim small">{facet.statement}</span>
                    {facet.aliases && facet.aliases.length > 0 && (
                      <span className="tag-row">
                        {facet.aliases.map((alias) => (
                          <span key={alias} className="tag">
                            {alias}
                            <button
                              type="button"
                              className="ghost-subfield-remove"
                              aria-label={`remove alias ${alias} of ${facet.name}`}
                              disabled={busy}
                              onClick={() => setEdited(removeAlias(current, index, alias))}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </span>
                    )}
                  </th>
                  <td>
                    <WeightInput
                      label={`relevance of ${facet.name}`}
                      value={facet.relevance}
                      disabled={busy}
                      onChange={(next) => setEdited(setRelevance(current, index, next))}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label={`remove facet ${facet.name}`}
                      disabled={busy || current.facets.length <= MIN_FACETS}
                      title={
                        current.facets.length <= MIN_FACETS
                          ? `At least ${MIN_FACETS} facets must remain`
                          : "Remove this facet"
                      }
                      onClick={() => setEdited(removeFacet(current, index))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {typeof current.problemFormulation === "string" && current.problemFormulation.trim() !== "" && (
                <tr>
                  <th scope="row">
                    <span className="chip chip-dim">formulation</span> problem formulation
                    <span className="needs-statement dim small">{current.problemFormulation}</span>
                  </th>
                  <td>
                    {view.weights.formulationWeight.toFixed(2)}
                    {view.weights.formulationWeight <= 0 && <span className="dim small"> retrieval only</span>}
                  </td>
                  <td />
                </tr>
              )}
              {(current.equivalentProblems ?? []).map((problem, index) => {
                const weight = view.weights.equivalentProblemWeight * problem.confidence;
                return (
                  <tr key={`${problem.field}/${problem.name}`}>
                    <th scope="row">
                      <span className="chip chip-dim">equivalent</span> {problem.name}{" "}
                      <span className="dim">({problem.field})</span>
                      <span className="needs-statement dim small">{problem.statement}</span>
                    </th>
                    <td>
                      <WeightInput
                        label={`confidence of ${problem.name}`}
                        value={problem.confidence}
                        disabled={busy}
                        onChange={(next) => setEdited(setConfidence(current, index, next))}
                      />
                      <span className="dim small">
                        {" "}
                        → weight {weight.toFixed(2)}
                        {weight <= 0 ? " (retrieval only)" : ""}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`remove equivalent problem ${problem.name}`}
                        disabled={busy}
                        onClick={() => setEdited(removeEquivalent(current, index))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {current.keyTerms && current.keyTerms.length > 0 && (
            <p className="dim small">Your key terms: {current.keyTerms.join(", ")}</p>
          )}
          <p className="dim small">
            {rows.filter((row) => !row.retrievalOnly).length} needs · W = {totalWeight(rows).toFixed(2)}.
            Removing or re-weighting is all this gate allows; text is never rewritten.
          </p>
        </>
      )}
      {phase === "resuming" ? (
        <p className="dim small">resuming…</p>
      ) : (
        <div className="gate-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !gateKey || !current}
            onClick={() => void answer()}
          >
            {changed ? "Continue with edited needs" : "Confirm needs"}
          </button>
          {changed && original && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => setEdited(original)}
            >
              Undo edits
            </button>
          )}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
