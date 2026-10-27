import { useEffect, useId, useState } from "react";
import type { ModelOptionsResponse, ServerSettings } from "@brainstorm-agentic/protocol";
import { errorMessage, getModelOptions, putModelsByRoute } from "../../api";
import "./research-controls.css";

const taskLabel = (id: string) => id.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

/** Uses the route-only endpoint, leaving provider and credential drafts alone. */
export function TaskModelsSettings({ settings }: { settings: ServerSettings }) {
  const prefix = useId();
  const [options, setOptions] = useState<ModelOptionsResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setOptions(null);
    setLoadError(null);
    setSaveError(null);
    setSaved(false);
    void getModelOptions().then((value) => {
      if (!live) return;
      setOptions(value);
      setDraft({ ...value.modelsByRoute });
    }, (reason: unknown) => {
      if (live) setLoadError(errorMessage(reason));
    });
    return () => { live = false; };
  }, [settings.llm.provider, settings.llm.model, attempt]);

  const dirty = options !== null && [...new Set([...Object.keys(draft), ...Object.keys(options.modelsByRoute)])]
    .some((id) => (draft[id] ?? "") !== (options.modelsByRoute[id] ?? ""));

  async function save() {
    if (!options || saving || !dirty) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const updated = await putModelsByRoute({ modelsByRoute: draft });
      const modelsByRoute = updated.llm.modelsByRoute ?? {};
      setOptions((current) => current ? { ...current, modelsByRoute } : current);
      setDraft({ ...modelsByRoute });
      setSaved(true);
    } catch (reason) {
      setSaveError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-research-controls">
    <p className="field-note">Choose defaults for future research. Existing runs keep their saved models. Save model choices here; provider and connection settings stay separate.</p>
    {loadError && <div className="inline-actions"><p className="error-text" role="alert">{loadError}</p><button type="button" className="btn btn-small" onClick={() => setAttempt((value) => value + 1)}>Retry models</button></div>}
    {!options && !loadError && <p className="field-note" role="status">Loading models…</p>}
    {options?.provider === "offline" && <p className="field-note">The offline provider is deterministic; model selection does not apply.</p>}
    {options && options.provider !== "offline" && <>
      <div className="field-grid-two">
        {options.taskTypes.map((task) => {
          const selected = draft[task.id] ?? "";
          return <div className="field" key={task.id}>
            <label className="field-label" htmlFor={`${prefix}-${task.id}`}>{taskLabel(task.id)}</label>
            <select
              id={`${prefix}-${task.id}`}
              value={selected}
              disabled={saving}
              aria-describedby={`${prefix}-${task.id}-description`}
              onChange={(event) => {
                setDraft((current) => ({ ...current, [task.id]: event.target.value }));
                setSaved(false);
                setSaveError(null);
              }}
            >
              <option value="">Default{options.defaultModel ? ` (${options.defaultModel})` : ""}</option>
              {selected && !options.models.some((model) => model.id === selected) && <option value={selected}>{selected}</option>}
              {options.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
            <span className="field-note" id={`${prefix}-${task.id}-description`}>{task.description}</span>
          </div>;
        })}
      </div>
      {saveError && <p className="error-text" role="alert">{saveError}</p>}
      <div className="inline-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={saving || !dirty} onClick={() => void save()}>{saving ? "Saving models…" : "Save models"}</button>
        <button type="button" className="btn btn-small" disabled={saving || !dirty} onClick={() => { setDraft({ ...options.modelsByRoute }); setSaveError(null); setSaved(false); }}>Cancel changes</button>
        {saved && <span className="settings-save-status settings-save-ok" role="status">Models saved</span>}
      </div>
    </>}
  </div>;
}
