import { useEffect, useId, useRef, useState } from 'react';
import type { ClaudeAgentEffort, ModelOptionsResponse, ServerSettings } from '@brainstorm-agentic/protocol';
import { errorMessage, putStageModels, refreshModelOptions, useModelOptions } from '../../api';
import { LegacyTaskModelsSettings } from './LegacyTaskModelsSettings';
import { changeStageModel, findModel, inheritedStageModel, inheritedThinkingLabel, sameStageSettings, updateStage, type StageSettingsMap } from './stage-models-model';
import './research-controls.css';

export function TaskModelsSettings({ settings, onDirtyChange }: { settings: ServerSettings; onDirtyChange?: (dirty: boolean) => void }) {
  const snapshot = useModelOptions();
  const options = snapshot.value;
  // A connection can change in the toolbar or another window. Retain each
  // visited provider's editor until the drawer closes, including while its
  // catalog is being refreshed, so switching providers cannot erase a draft.
  const editors = useRef(new Map<string, { options: ModelOptionsResponse; settings: ServerSettings }>());
  const dirtyProviders = useRef(new Set<string>());
  if (options?.provider === settings.llm.provider) editors.current.set(options.provider, { options, settings });
  const current = editors.current.get(settings.llm.provider);
  const updateDirty = (provider: string, dirty: boolean) => {
    if (dirty) dirtyProviders.current.add(provider); else dirtyProviders.current.delete(provider);
    onDirtyChange?.(dirtyProviders.current.size > 0);
  };
  return <>
    {!current && <div className="settings-research-controls">
      {snapshot.error ? <><p className="error-text" role="alert">{errorMessage(snapshot.error)}</p><button type="button" className="btn btn-small" onClick={() => { void refreshModelOptions().catch(() => undefined); }}>Retry models</button></>
        : <p className="field-note" role="status">Loading models…</p>}
    </div>}
    {current && snapshot.error && <p className="field-note" role="status">Model information could not be refreshed. Your saved choices are still available. <button type="button" className="btn btn-small" onClick={() => { void refreshModelOptions().catch(() => undefined); }}>Retry models</button></p>}
    {[...editors.current].map(([provider, entry]) => <div key={provider} hidden={provider !== settings.llm.provider}>
      {provider === 'offline' ? <p className="field-note">The offline provider is deterministic; model selection does not apply.</p>
        : entry.options.stages ? <StageModelsSettings options={entry.options} onDirtyChange={dirty => updateDirty(provider, dirty)} />
          : <LegacyTaskModelsSettings settings={entry.settings} onDirtyChange={dirty => updateDirty(provider, dirty)} />}
    </div>)}
  </>;
}

function StageModelsSettings({ options, onDirtyChange }: { options: ModelOptionsResponse; onDirtyChange?: (dirty: boolean) => void }) {
  const prefix = useId();
  const [baseline, setBaseline] = useState<StageSettingsMap>(options.stageSettings ?? {});
  const [draft, setDraft] = useState<StageSettingsMap>(options.stageSettings ?? {});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const live = useRef(true);
  const previousSettings = useRef(options.stageSettings);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const dirty = !sameStageSettings(draft, baseline);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    // Background settings refreshes must not discard a stage draft.
    if (previousSettings.current === options.stageSettings) return;
    previousSettings.current = options.stageSettings;
    setBaseline(options.stageSettings ?? {});
    if (!saving && !dirty) setDraft(options.stageSettings ?? {});
  }, [options.stageSettings, dirty, saving]);
  function change(next: StageSettingsMap) { setDraft(next); setSaved(false); setSaveError(null); }
  async function save() {
    if (saving || !dirty) return;
    setSaving(true); setSaved(false); setSaveError(null);
    try {
      const updated = await putStageModels({ provider: options.provider, stageSettings: draft });
      if (!live.current) return;
      const next = updated.llm.stageSettingsByProvider?.[options.provider] ?? {};
      setBaseline(next); setDraft(next); setSaved(true);
    } catch (error) { if (live.current) setSaveError(errorMessage(error)); }
    finally { if (live.current) setSaving(false); }
  }
  return <div className="settings-research-controls">
    <p className="field-note">Choose a model, thinking mode, and reasoning effort for each pipeline stage. Defaults follow your model connection settings where supported. Choices are saved separately for each provider and apply to new research; existing runs keep their saved settings.</p>
    {!!options.stages?.length && <p className="field-note">{options.stages.length} pipeline stages. Available options depend on the selected model.</p>}
    {(options.catalog?.stale || options.catalog?.source === 'fallback') && <p className="field-note">Using saved model information. Controls are available where the model’s capabilities are known.</p>}
    {options.stages?.length === 0 && <p className="field-note" role="status">Workflow stages are unavailable. They will be checked at the next research launch.</p>}
    {saveError && <p className="error-text" role="alert">{saveError}</p>}
    <div className="inline-actions settings-stage-model-actions">
      <button type="button" className="btn btn-primary btn-small" disabled={saving || !dirty} onClick={() => void save()}>{saving ? 'Saving models…' : 'Save models'}</button>
      <button type="button" className="btn btn-small" disabled={saving || !dirty} onClick={() => change(baseline)}>Cancel changes</button>
      {saved && <span className="settings-save-status settings-save-ok" role="status">Models saved</span>}
    </div>
    <div className="settings-stage-models">
      {options.stages?.map(stage => {
        const selected = draft[stage.id] ?? {};
        const inherited = inheritedStageModel(options, stage);
        const capabilities = findModel(options.models, selected.model || inherited)?.capabilities;
        const effortLevels = capabilities?.effortLevels ?? [];
        const inheritedEffort = options.defaults?.effort;
        const defaultEffort = inheritedEffort && effortLevels.includes(inheritedEffort) ? inheritedEffort : undefined;
        const adaptive = capabilities?.adaptiveThinking === true;
        const canDisable = capabilities?.thinkingCanBeDisabled === true;
        const unconfirmedThinking = selected.thinking === 'adaptive' ? !adaptive : selected.thinking === 'disabled' && !canDisable;
        const modelId = `${prefix}-${stage.id}`;
        return <section className="settings-stage-model" key={stage.id} aria-labelledby={`${modelId}-title`}>
          <div className="settings-stage-model-heading">
            <div><h4 id={`${modelId}-title`}>{stage.label}</h4><p className="field-note" id={`${modelId}-description`}>{stage.description}</p></div>
            <button type="button" className="btn btn-small" aria-label={`Reset ${stage.label} to defaults`} disabled={saving || !draft[stage.id]} onClick={() => change(updateStage(draft, stage.id, {}))}>Use defaults</button>
          </div>
          <div className="settings-stage-model-fields">
            <div className="field">
              <label className="field-label" htmlFor={modelId}>Model</label>
              <select id={modelId} aria-label={`${stage.label} model`} aria-describedby={`${modelId}-description`} value={selected.model ?? ''} disabled={saving} onChange={event => change(changeStageModel(draft, stage, event.target.value, options))}>
                <option value="">Default{inherited ? ` (${findModel(options.models, inherited)?.label ?? inherited})` : ''}</option>
                {selected.model && !options.models.some(model => model.id === selected.model) && <option value={selected.model}>{selected.model} (saved)</option>}
                {options.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${modelId}-thinking`}>Thinking mode</label>
              <select id={`${modelId}-thinking`} aria-label={`${stage.label} thinking mode`} value={selected.thinking ?? ''} disabled={saving || (!adaptive && !canDisable && !selected.thinking)}
                onChange={event => change(updateStage(draft, stage.id, { ...selected, thinking: (event.target.value as 'adaptive' | 'disabled') || undefined }))}>
                <option value="">Default ({inheritedThinkingLabel(options, selected.model || inherited)})</option>
                {adaptive && <option value="adaptive">Adaptive</option>}
                {canDisable && <option value="disabled">Disabled</option>}
                {unconfirmedThinking && <option disabled value={selected.thinking}>{selected.thinking === 'adaptive' ? 'Adaptive' : 'Disabled'} (saved; unavailable)</option>}
              </select>
              {capabilities?.thinkingCanBeDisabled === false && adaptive && <p className="field-note">This model requires adaptive thinking.</p>}
              {adaptive && capabilities?.thinkingCanBeDisabled === undefined && <p className="field-note">The provider has not reported whether thinking can be disabled.</p>}
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${modelId}-effort`}>Reasoning effort</label>
              <select id={`${modelId}-effort`} aria-label={`${stage.label} reasoning effort`} value={selected.effort ?? ''} disabled={saving || (!effortLevels.length && !selected.effort)} onChange={event => change(updateStage(draft, stage.id, { ...selected, effort: (event.target.value as ClaudeAgentEffort) || undefined }))}>
                <option value="">{effortLevels.length ? `Default${defaultEffort ? ` (${defaultEffort})` : ' (model decides)'}` : capabilities ? 'Model controlled' : 'Capabilities unavailable'}</option>
                {selected.effort && !effortLevels.includes(selected.effort) && <option disabled value={selected.effort}>{selected.effort} (saved; unavailable)</option>}
                {effortLevels.map(effort => <option key={effort} value={effort}>{effort === 'xhigh' ? 'Extra high' : effort[0]!.toUpperCase() + effort.slice(1)}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${modelId}-transcript`}>Thinking transcript</label>
            <select id={`${modelId}-transcript`} aria-label={`${stage.label} thinking transcript`} value={selected.transcript ?? ''} disabled={saving}
              onChange={event => change(updateStage(draft, stage.id, { ...selected, transcript: (event.target.value as 'if-available' | 'off') || undefined }))}>
              <option value="">Default ({options.defaults?.transcript === 'off' ? 'off' : 'when available'})</option>
              <option value="if-available">Record when available</option>
              <option value="off">Off</option>
            </select>
            <p className="field-note">Optional provider-supplied summaries. Recording is separate from thinking mode and effort. Reviewable argument steps are always kept.</p>
          </div>
          {unconfirmedThinking && <p className="field-note">The saved thinking override is not confirmed as supported by this model. Use the default or choose another model.</p>}
          {!capabilities && <p className="field-note">Reasoning controls are unavailable until this model’s capabilities are known.</p>}
        </section>;
      })}
    </div>

  </div>;
}
