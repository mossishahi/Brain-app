import { useEffect, useId, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { LuX } from 'react-icons/lu';
import type { HealthResponse, ModelOptionsResponse, ServerSettings } from '@brainstorm-agentic/protocol';
import { errorMessage, getHealth, getModelOptions, putModelsByRoute } from '../../api';
import { agentDefaults, type QuickValue } from './settings-commands';
import { changeQuickSetting, useQuickSettings } from './settings-store';
import './quick-editor.css';

export type QuickEditorId = 'model' | 'modelsByTask' | 'agentLimits' | 'searchLimits' | 'contactEmail' | 'recoveryBuffer' | 'appInfo';
type Field = { name: string; label: string; value: string; type?: 'number' | 'email' | 'text'; min?: number; max?: number; step?: string; hint?: string };
function specification(id: QuickEditorId, s: ServerSettings): { title: string; description: string; fields: Field[] } {
  const agent = { ...agentDefaults, ...s.llm.agentSdk };
  switch (id) {
    case 'model': return { title: 'Default model', description: 'Defaults for new research. Changing the model verifies the connection before saving.', fields: [{ name: 'model', label: 'Model', value: s.llm.model ?? '', hint: 'Type to find an available model, or enter a custom model ID.' }] };
    case 'modelsByTask': return { title: 'Models by task type', description: 'Defaults for new research. Existing runs keep their saved models.', fields: [] };
    case 'agentLimits': return { title: 'Task limits & fallback', description: 'Defaults for new research. These limits apply to each agent task.', fields: [
      { name: 'maxTurns', label: 'Maximum turns', type: 'number', min: 1, max: 500, step: '1', value: String(agent.maxTurns) },
      { name: 'maxBudgetUsd', label: 'Maximum USD per task', type: 'number', min: 0.01, step: '0.01', value: agent.maxBudgetUsd === undefined ? '' : String(agent.maxBudgetUsd), hint: 'Leave empty for no explicit cap.' },
      { name: 'fallbackModel', label: 'Fallback model', value: agent.fallbackModel ?? '', hint: 'Optional model ID for an overloaded or unavailable primary model.' },
    ] };
    case 'searchLimits': return { title: 'Paid search limits', description: 'Brave fallback request ceilings for new research. Changing limits does not enable paid fallback.', fields: [
      { name: 'perRun', label: 'Requests per run', type: 'number', min: 0, step: '1', value: String(s.webSearch?.braveFallback?.maxRequestsPerRun ?? 300) },
      { name: 'perMonth', label: 'Requests per month', type: 'number', min: 0, step: '1', value: String(s.webSearch?.braveFallback?.maxRequestsPerMonth ?? 1000) },
    ] };
    case 'contactEmail': return { title: 'Scholarly contact', description: 'Shared with scholarly indexes for their polite pools. Applies to new research.', fields: [{ name: 'contactEmail', label: 'Contact email', type: 'email', value: s.webSearch?.contactEmail ?? '', hint: 'Optional; leave empty to remove it.' }] };
    case 'recoveryBuffer': return { title: 'Recovery safety buffer', description: 'Extra time after a provider credit reset before automatic resume. Applies to existing blocked runs.', fields: [{ name: 'recoveryBuffer', label: 'Seconds', type: 'number', min: 0, max: 3600, step: '1', value: String(s.creditRecovery.safetyBufferSeconds) }] };
    case 'appInfo': return { title: 'App & registry information', description: 'Versions and connection details for this deployment.', fields: [] };
  }
}

export function QuickSettingsEditor({ id, settings, onClose }: { id: QuickEditorId; settings: ServerSettings; onClose: () => void }) {
  const spec = specification(id, settings);
  const prefix = useId();
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map(field => [field.name, field.value])));
  const [models, setModels] = useState<ModelOptionsResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const state = useQuickSettings();
  useEffect(() => {
    let live = true;
    if (id === 'model' || id === 'modelsByTask') {
      void getModelOptions().then(value => {
        if (!live) return;
        setModels(value);
        if (id === 'modelsByTask') setDraft({ ...value.modelsByRoute });
      }, error => { if (live) setLoadError(errorMessage(error)); });
    }
    if (id === 'appInfo') void getHealth().then(value => { if (live) setHealth(value); }, error => { if (live) setLoadError(errorMessage(error)); });
    return () => { live = false; };
  }, [id]);
  const update = (name: string, value: string) => setDraft(current => ({ ...current, [name]: value }));
  async function apply() {
    if (saving) return;
    setSaving(true); setSaveError(null);
    try {
      if (id === 'appInfo') return;
      if (id === 'modelsByTask') {
        if (!models) return;
        // The same endpoint and shared save queue used by the composer model picker.
        await putModelsByRoute({ modelsByRoute: draft });
        onClose(); return;
      }
      const value: QuickValue = id === 'agentLimits' || id === 'searchLimits' ? draft : draft[id] ?? '';
      if (await changeQuickSetting(id, value)) onClose();
    } catch (error) { setSaveError(errorMessage(error)); }
    finally { setSaving(false); }
  }
  const error = saveError ?? (id === 'appInfo' || id === 'modelsByTask' ? undefined : state.status[id]?.error);
  return <Popover.Root open onOpenChange={next => { if (!next && !saving) onClose(); }}>
    <Popover.Portal><Popover.Positioner anchor={() => document.getElementById('canvas-settings-trigger')} side="right" align="end" sideOffset={12} collisionPadding={12} className="quick-editor-positioner">
      <Popover.Popup className="quick-editor" aria-label={spec.title} finalFocus={() => document.getElementById('canvas-settings-trigger')}>
        <header><Popover.Title>{spec.title}</Popover.Title><button type="button" aria-label="Close editor" disabled={saving} onClick={onClose}><LuX /></button></header>
        <Popover.Description>{spec.description}</Popover.Description>
        <form onSubmit={event => { event.preventDefault(); void apply(); }}>
          <div className="quick-editor-body">
            {loadError && <p className="quick-editor-error" role="alert">{loadError}</p>}
            {spec.fields.map(field => <div className="quick-editor-field" key={field.name}>
              <label htmlFor={`${prefix}-${field.name}`}>{field.label}</label>
              <input id={`${prefix}-${field.name}`} type={field.type ?? 'text'} value={draft[field.name] ?? ''} onChange={event => update(field.name, event.target.value)} min={field.min} max={field.max} step={field.step} disabled={saving} list={id === 'model' ? `${prefix}-models` : undefined} autoComplete="off" />
              {field.hint && <small>{field.hint}</small>}
            </div>)}
            {id === 'model' && <datalist id={`${prefix}-models`}>{models?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>}
            {id === 'modelsByTask' && (!models ? !loadError && <p role="status">Loading models…</p> : models.taskTypes.map(task => <div className="quick-editor-field" key={task.id}>
              <label htmlFor={`${prefix}-${task.id}`}>{task.id}</label><select id={`${prefix}-${task.id}`} value={draft[task.id] ?? ''} onChange={event => update(task.id, event.target.value)} disabled={saving}>
                <option value="">Default{models.defaultModel ? ` (${models.defaultModel})` : ''}</option>
                {draft[task.id] && !models.models.some(model => model.id === draft[task.id]) && <option value={draft[task.id]}>{draft[task.id]}</option>}
                {models.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select><small>{task.description}</small>
            </div>))}
            {id === 'appInfo' && (!health ? !loadError && <p role="status">Loading versions…</p> : <>
              <dl className="quick-editor-details"><dt>App</dt><dd>{health.version}</dd><dt>Registry</dt><dd>{health.contentRegistry.url ?? settings.contentRegistry.url}</dd><dt>Bundle</dt><dd>{settings.contentRegistry.bundle}</dd><dt>Bundle version</dt><dd>{health.contentRegistry.effectiveVersion ?? settings.contentRegistry.version ?? 'Latest for new research'}</dd><dt>Registry server</dt><dd>{health.contentRegistry.serverVersion ?? 'Not reported'}</dd><dt>Version pin</dt><dd>{settings.contentRegistry.version ?? 'None'}</dd></dl>
              {(health.contentRegistry.latestNotes || health.appUpdate?.notes) && <details><summary>Release notes</summary><pre>{health.appUpdate?.notes ?? health.contentRegistry.latestNotes}</pre></details>}
            </>)}
            {error && <p className="quick-editor-error" role="alert">{error}</p>}
          </div>
          <footer><button type="button" disabled={saving} onClick={onClose}>{id === 'appInfo' ? 'Done' : 'Cancel'}</button>{id !== 'appInfo' && <button type="submit" className="quick-editor-apply" disabled={saving || (id === 'modelsByTask' && (!models || models.provider === 'offline'))}>{saving ? 'Saving…' : 'Apply'}</button>}</footer>
        </form>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
