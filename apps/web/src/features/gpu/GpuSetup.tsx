import { useEffect, useId, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { LuCpu, LuClock3, LuX } from 'react-icons/lu';
import type { GpuSetupDraft, GpuSetupReport } from '@brainstorm-agentic/protocol';
import { approveGpuProbe, cancelGpuProbe, discoverGpu, errorMessage, saveGpuDraft } from '../../api';
import { useNavigationDismiss } from '../../shell/useNavigationDismiss';
import { changeGpuField, gpuFields, gpuOptions, gpuParameters, gpuStatus, gpuTimeMaximum, type GpuFields } from './gpu-model';
import { mutateGpuSetup, refreshGpuSetup, useGpuSetup } from './gpu-store';
import './gpu-setup.css';

function Progress({ report }: { report: GpuSetupReport }) {
  return <div className="gpu-progress"><progress aria-label="GPU setup progress" max={100} value={Math.max(0, Math.min(100, report.progress.percent))} /><span role="status">{report.progress.message}</span></div>;
}

function DraftEditor({ report, pending, onDirtyChange }: { report: GpuSetupReport; pending: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const draft = report.draft!;
  const [base, setBase] = useState<GpuSetupDraft>(draft);
  const [fields, setFields] = useState<GpuFields>(() => gpuFields(draft.parameters));
  const [error, setError] = useState<string | null>(null);
  const prefix = useId();
  const dirty = JSON.stringify(fields) !== JSON.stringify(gpuFields(base.parameters));
  const stale = base.id !== draft.id || base.revision !== draft.revision;
  const busy = pending || report.phase === 'discovering' || report.phase === 'probing' || report.cleanupRequired === true;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty && stale) { setBase(draft); setFields(gpuFields(draft.parameters)); }
  }, [draft, dirty, stale]);
  const options = gpuOptions(report.discovery, fields);
  const reservationRequired = report.discovery?.qos.find(item => item.name === fields.qos)?.requiresReservation === true;
  const update = (name: keyof GpuFields, value: string) => { setFields(current => changeGpuField(current, name, value, report.discovery)); setError(null); };
  const reset = () => { setBase(draft); setFields(gpuFields(draft.parameters)); setError(null); };
  async function save() {
    setError(null);
    try {
      const parameters = gpuParameters(fields, report.discovery);
      const next = await mutateGpuSetup(() => saveGpuDraft({ draftId: base.id, revision: base.revision, parameters }));
      if (next?.draft) { setBase(next.draft); setFields(gpuFields(next.draft.parameters)); }
    } catch (failure) { setError(errorMessage(failure)); }
  }
  const select = (name: 'partition' | 'account' | 'qos' | 'gpuType', label: string, values: readonly string[], emptyLabel?: string) => <div className="gpu-field">
    <label htmlFor={`${prefix}-${name}`}>{label}</label>
    <select id={`${prefix}-${name}`} value={fields[name]} onChange={event => update(name, event.target.value)} disabled={busy || (!values.length && name !== 'gpuType')}>
      {(emptyLabel || !values.length || !fields[name]) && <option value="">{emptyLabel ?? 'Select an option'}</option>}
      {fields[name] && !values.includes(fields[name]) && <option value={fields[name]} disabled>{fields[name]} (unavailable)</option>}
      {values.map(value => <option key={value} value={value}>{value}</option>)}
    </select>
  </div>;
  const numberFields = [
    ['gpus', 'GPU count', 1, 64], ['cpus', 'CPUs', 1, 1024], ['memoryGb', 'Memory (GB)', 1, 65536],
    ['timeLimitMinutes', 'Time limit (minutes)', 1, gpuTimeMaximum(fields, report.discovery)], ['nice', 'Nice value', 0, 2147483645],
  ] as const;
  return <div className="gpu-draft">
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="gpu-fields">
        {select('partition', 'Partition', report.discovery?.partitions.map(item => item.name) ?? [])}
        {select('account', 'Account', options.accounts, options.accounts.length ? undefined : 'Scheduler default')}
        {select('qos', 'QOS', options.qos, options.qos.length ? undefined : 'Scheduler default')}
        {select('gpuType', 'GPU type', options.gpuTypes, 'Any available type')}
        {numberFields.map(([name, label, min, max]) => <div className="gpu-field" key={name}><label htmlFor={`${prefix}-${name}`}>{label}</label><input id={`${prefix}-${name}`} type="number" step="1" min={min} max={max} value={fields[name]} onChange={event => update(name, event.target.value)} disabled={busy} /></div>)}
        <div className="gpu-field"><label htmlFor={`${prefix}-reservation`}>Reservation{reservationRequired ? ' (required)' : ' (optional)'}</label><input id={`${prefix}-reservation`} value={fields.reservation} onChange={event => update('reservation', event.target.value)} required={reservationRequired} disabled={busy} /></div>
      </div>
      <div className="gpu-field"><label htmlFor={`${prefix}-prelude`}>Environment setup</label><textarea id={`${prefix}-prelude`} rows={5} value={fields.prelude} onChange={event => update('prelude', event.target.value)} disabled={busy} spellCheck={false} placeholder="For example: source /path/to/conda.sh, then conda activate your-env" /><small>These commands run before both the probe and future GPU scripts. Include your module or environment activation here.</small></div>
      <p className="gpu-note">Future jobs may run for up to the chosen time limit; the discovery limits allow at most {gpuTimeMaximum(fields, report.discovery)} minutes. The probe itself is capped at two minutes.</p>
      {options.partition?.warnings?.map((warning, index) => <p className="gpu-note" key={index}>{warning}</p>)}
      {error && <p className="gpu-error" role="alert">{error}</p>}
      {stale && dirty && <p className="gpu-error" role="alert">The server has a newer draft. Your edits are retained; load the latest draft before reviewing it.</p>}
      <div className="gpu-actions"><button type="submit" className="btn btn-small" disabled={busy || !dirty || stale}>Save draft and update preview</button>{dirty && <button type="button" className="btn btn-small" disabled={busy} onClick={reset}>{stale ? 'Load latest draft' : 'Discard edits'}</button>}</div>
      {dirty && <p className="gpu-note" role="status">Unsaved changes. Save to generate the script for review. Saving a changed draft disables GPU execution until a new probe succeeds.</p>}
    </form>
    {draft.notes.length > 0 && <ul className="gpu-notes">{draft.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    <div className="gpu-script"><h3>Probe script for approval</h3><p className="gpu-note">Revision {draft.revision}. {dirty ? 'This is the saved script; your unsaved edits are not included.' : 'This exact script will be submitted when you approve.'}</p><pre tabIndex={0} aria-label="Probe script for approval"><code>{draft.probeScript}</code></pre></div>
    <details className="gpu-script"><summary>Future GPU job template</summary><pre tabIndex={0}><code>{draft.template}</code></pre></details>
    {report.phase !== 'ready' && report.phase !== 'unsupported' && !busy && <div className="gpu-approval">
      <p>Approval submits one probe job using the script above. It checks the CUDA driver and a GPU memory transfer using Python 3 and nvidia-smi, installs nothing, and does not test framework compatibility. A successful probe enables GPU execution for agent roles allowed to use it.</p>
      <button type="button" className="btn gpu-approve" disabled={dirty || stale || pending} onClick={() => { void mutateGpuSetup(() => approveGpuProbe({ draftId: draft.id, revision: draft.revision, reviewToken: draft.reviewToken, approved: true })); }}>Approve and run probe</button>
    </div>}
  </div>;
}

export function GpuSetupControl({ compact = false }: { compact?: boolean }) {
  const state = useGpuSetup();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const report = state.report;
  const status = gpuStatus(report);
  const busy = report?.phase === 'discovering' || report?.phase === 'probing';
  const requestClose = () => { if (dirty) setCloseWarning(true); else setOpen(false); };
  useNavigationDismiss(() => { if (open) requestClose(); });
  return <Dialog.Root open={open} onOpenChange={next => { if (next) { setCloseWarning(false); setOpen(true); } else requestClose(); }}>
    <Dialog.Trigger type="button" className={compact ? `env-icon gpu-icon state-${status.tone}` : 'btn btn-small'} aria-label={compact ? `GPU setup: ${status.label}` : undefined} title={compact ? `GPU setup · ${status.label}` : undefined}>
      {compact ? <><LuCpu aria-hidden="true" />{report?.phase === 'draft' && <LuClock3 className="gpu-pending-mark" aria-hidden="true" />}{busy && <span className="gpu-icon-progress" aria-hidden="true" />}</> : 'Configure GPU execution…'}
    </Dialog.Trigger>
    <Dialog.Portal><Dialog.Backdrop className="gpu-backdrop" /><Dialog.Popup className="gpu-dialog">
      <header className="gpu-dialog-header"><div><Dialog.Title>GPU execution</Dialog.Title><span className={`gpu-status state-${status.tone}`}>{status.label}</span></div><button type="button" className="gpu-close" aria-label="Close GPU setup" onClick={requestClose}><LuX /></button></header>
      <Dialog.Description className="gpu-description">GPU setup is optional. Discovery inspects the host and prepares a draft; a GPU job runs only after you approve its probe script.</Dialog.Description>
      <div className="gpu-dialog-body">
        {state.error && <div className="gpu-error" role="alert">{state.error}<button type="button" className="btn btn-small" onClick={() => void refreshGpuSetup()}>Refresh GPU status</button></div>}
        {state.loading && !report && <p role="status">Loading GPU setup…</p>}
        {report && <>
          {(busy || report.phase === 'unconfigured') && <Progress report={report} />}
          {report.error && <p className="gpu-error" role="alert">{report.error}</p>}
          {report.discovery && <><dl className="gpu-host"><dt>Host</dt><dd>{report.discovery.hostname}</dd><dt>Architecture</dt><dd>{report.discovery.architecture} · {report.discovery.platform}</dd><dt>Job management</dt><dd>{report.discovery.scheduler}{report.discovery.cluster ? ` · ${report.discovery.cluster}` : ''}</dd></dl>{report.discovery.warnings.map((warning, index) => <p className="gpu-note" key={index}>{warning}</p>)}</>}
          {report.phase === 'ready' && <p className="gpu-success" role="status">The approved probe succeeded. GPU execution is available to permitted agent roles.</p>}
          {report.probe && <section className="gpu-probe" aria-label="GPU probe status"><h3>Probe {report.probe.jobId ? `job ${report.probe.jobId}` : ''}</h3><p role="status">{report.probe.state}</p>{report.probe.log && <details open={report.phase === 'failed'}><summary>Probe output</summary><pre><code>{report.probe.log}</code></pre></details>}{(report.phase === 'probing' || report.cleanupRequired) && <button type="button" className="btn btn-small" disabled={state.pending} onClick={() => void mutateGpuSetup(cancelGpuProbe)}>{report.cleanupRequired ? 'Retry cancellation' : 'Cancel probe'}</button>}{report.cleanupRequired && <p className="gpu-error">The previous job still needs cancellation. Complete cancellation before changing setup or starting another probe.</p>}</section>}
          {report.draft && <DraftEditor report={report} pending={state.pending} onDirtyChange={setDirty} />}
          {!busy && <div className="gpu-actions"><button type="button" className="btn btn-small" disabled={state.pending || dirty || report.cleanupRequired} onClick={() => void mutateGpuSetup(discoverGpu)}>{report.discovery ? 'Discover host again' : 'Discover GPU setup'}</button>{report.discovery && <small>Inspecting again prepares a new draft for approval.</small>}</div>}
          {report.discovery && <details className="gpu-evidence"><summary>Discovery details</summary>{report.discovery.evidence.map((item, index) => <pre key={index}><code>{`$ ${item.command}\n${item.stdout}${item.stderr ? `\n${item.stderr}` : ''}\nExit code: ${item.exitCode}`}</code></pre>)}</details>}
        </>}
      </div>
      <footer className="gpu-dialog-footer">{closeWarning ? <><p role="alert">You have unsaved GPU settings.</p><button type="button" className="btn btn-small" onClick={() => setCloseWarning(false)}>Keep editing</button><button type="button" className="btn btn-small" onClick={() => { setDirty(false); setCloseWarning(false); setOpen(false); }}>Discard edits and close</button></> : <button type="button" className="btn btn-small" onClick={requestClose}>Done</button>}</footer>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
