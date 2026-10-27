import { useEffect } from "react";
import type { ReadinessCheck, ReadinessCheckId } from "@brainstorm-agentic/protocol";
import { diagnoseOverviewReadiness, recheckOverviewReadiness, refreshOverviewReadiness, useOverviewReadiness } from "../../features/library/WorkspaceOverview";
import "./research-controls.css";

const checks: readonly ReadinessCheckId[] = ["capabilities", "code", "internet"];
const stateLabel: Record<ReadinessCheck["state"], string> = {
  ok: "Ready", failed: "Failed", checking: "Checking…", skipped: "Not required", unknown: "Not checked yet",
};

/** Shares the shell's event feed; this section never starts another poller. */
export function ToolReadinessSettings() {
  const readiness = useOverviewReadiness();
  useEffect(() => {
    if (!readiness.data) void refreshOverviewReadiness();
    // A failed request is retried explicitly, not in a render/request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ordered = checks.flatMap((id) => {
    const check = readiness.data?.checks.find((candidate) => candidate.id === id);
    return check ? [check] : [];
  });

  return <div className="settings-research-controls">
    <p className="field-note">Check capability access, code execution, and internet connectivity. Results update as checks complete.</p>
    {readiness.error && <div className="inline-actions"><p className="error-text" role="alert">{readiness.error}</p><button type="button" className="btn btn-small" disabled={readiness.loading} onClick={() => void refreshOverviewReadiness()}>Retry environment checks</button></div>}
    {!readiness.data && !readiness.error && <p className="field-note" role="status">Loading environment checks…</p>}
    {readiness.data && ordered.length === 0 && <p className="field-note">No tool checks have been reported yet.</p>}
    {ordered.map((check) => <article className="settings-tool-check" aria-label={`${check.label} check`} key={check.id}>
      <header className="settings-tool-check-heading"><h4>{check.label}</h4><span className={`settings-tool-check-state state-${check.state}`} role="status">{stateLabel[check.state]}</span></header>
      {check.message && <p className="field-note">{check.message}</p>}
      {check.detail && <details className="settings-tool-check-details"><summary>Technical details</summary><pre><code>{check.detail}</code></pre></details>}
      {check.state === "failed" && (check.advice || check.advising) && <div className="settings-tool-check-advice">
        <h5>{check.advising ? "Asking the model for a fix…" : "How to fix"}</h5>
        {check.advice && <p className="field-note">{check.advice}</p>}
      </div>}
      <div className="inline-actions">
        <button type="button" className="btn btn-small" disabled={check.state === "checking"} onClick={() => recheckOverviewReadiness([check.id])}>Re-run check</button>
        {check.state === "failed" && <button type="button" className="btn btn-small" disabled={check.advising === true} onClick={() => diagnoseOverviewReadiness(check.id)}>Ask AI for help</button>}
      </div>
    </article>)}
  </div>;
}
