import { useCallback, useState } from "react";

import type { DiagnosticPreview } from "@brainstorm-agentic/protocol";

import { errorMessage, previewDiagnostics, sendDiagnostics } from "../api";

/**
 * Sending a diagnostic report, as a deliberate two-step action.
 *
 * A report describes a run so a failure can be traced. It is NOT covered by the
 * telemetry setting and is never sent automatically, because unlike usage
 * counts it comes from the run's own logs: turning on anonymous usage reporting
 * must not imply agreement to send anything about your actual work.
 *
 * The first click only fetches a description — nothing leaves the machine.
 * Sending needs a second, separate click, made after seeing exactly what is
 * included and what is held back. A confirmation that appears before the user
 * can see what they are confirming is not consent.
 */
export function SendDiagnostics({ jobId }: { jobId: string }) {
  const [preview, setPreview] = useState<DiagnosticPreview | undefined>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await previewDiagnostics(jobId));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [jobId]);

  const send = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      await sendDiagnostics(jobId);
      setSent(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [jobId]);

  if (sent) {
    return <p className="diag-sent">Report sent — thank you, this helps trace the problem.</p>;
  }

  if (!preview) {
    return (
      <div className="diag-start">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void load()}>
          {busy ? "Preparing…" : "Send a diagnostic report"}
        </button>
        {error !== undefined && <span className="diag-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="diag-preview" role="group" aria-label="diagnostic report contents">
      <p className="diag-lead">
        Nothing has been sent yet. This is exactly what the report would contain:
      </p>
      <ul className="diag-list">
        {preview.components.map((component) => (
          <li key={component.id}>
            <span className="diag-what">{component.description}</span>
            <span className="diag-size">{formatBytes(component.bytes)}</span>
            {component.mayContainYourContent && (
              <span className="diag-flag" title="This part can include things you wrote or referenced">
                may include your content
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="diag-lead">Not included:</p>
      <ul className="diag-list diag-excluded">
        {preview.excluded.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="diag-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || !preview.canSend}
          onClick={() => void send()}
        >
          {busy ? "Sending…" : `Send ${formatBytes(preview.totalBytes)}`}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => setPreview(undefined)}
        >
          Cancel
        </button>
      </div>
      {!preview.canSend && (
        <p className="diag-error">
          No destination is configured, so there is nowhere to send this. Set a diagnostics
          endpoint in Settings first.
        </p>
      )}
      {error !== undefined && <span className="diag-error">{error}</span>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
