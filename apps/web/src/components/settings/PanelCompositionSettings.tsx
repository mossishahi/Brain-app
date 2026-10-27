/**
 * Settings drawer, Research → Panel composition: overrides for every param of
 * the paper-based panel composition (spec v2 Section 0) with the pinned
 * bundle's defaults shown, the CORE API key (stored with the other scholarly
 * keys), and which text encoders this host can run.
 *
 * Only values that differ from the bundle's defaults are saved; new runs carry
 * them to the worker as BRAINSTORM_AGENTIC_WORKFLOW_PARAMS.
 */
import { useCallback, useEffect, useState } from "react";
import type { ServerSettings, ServerSettingsUpdate } from "@brainstorm-agentic/protocol";
import { errorMessage, getEncoderReadiness, getPanelComposition } from "../../api";
import { SettingsToggle } from "./SettingsToggle";
import {
  effectiveValue,
  nextOverrides,
  parseParamInput,
  type EncoderReadinessView,
  type PanelCompositionView,
  type PanelParamValue,
  type PanelParamView,
} from "./panel-composition-model";

/** The settings update this section sends (fields the protocol does not declare yet). */
type CompositionPatch = ServerSettingsUpdate & {
  readonly panelComposition?: { readonly params: Readonly<Record<string, PanelParamValue>> };
  readonly webSearch?: NonNullable<ServerSettingsUpdate["webSearch"]> & {
    readonly coreApiKey?: string;
    readonly clearCoreApiKey?: boolean;
  };
};

function defaultNote(param: PanelParamView, bundleVersion?: string): string {
  const shown = String(param.effectiveDefault);
  if (param.declared === true) return `bundle default: ${shown}`;
  if (param.declared === false) {
    return `spec default: ${shown} — not declared by the pinned bundle${bundleVersion ? ` ${bundleVersion}` : ""}, so a run ignores an override`;
  }
  return `spec default: ${shown} (the registry could not be read)`;
}

function keyNote(param: PanelParamView, settings: ServerSettings | null, coreKey: boolean): string | undefined {
  if (param.key === undefined || param.key === "none") return undefined;
  const web = settings?.webSearch;
  const configured =
    param.name === "sourceCore"
      ? coreKey
      : param.name === "sourceOpenAlex"
        ? web?.openAlexKeyConfigured === true
        : param.name === "sourceSemanticScholar"
          ? web?.semanticScholarKeyConfigured === true
          : undefined;
  const need = param.key === "required" ? "needs an API key" : "API key optional";
  if (configured === undefined) return need;
  return `${need} — ${configured ? "key configured" : "no key: the source is recorded as needs-key for the run"}`;
}

function ParamControl({
  param,
  disabled,
  onCommit,
}: {
  param: PanelParamView;
  disabled: boolean;
  onCommit: (value: PanelParamValue | undefined) => void;
}) {
  const current = effectiveValue(param);
  const [draft, setDraft] = useState(String(current));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(String(current));
    setError(null);
  }, [current]);
  if (param.type === "bool") {
    return (
      <SettingsToggle
        label={param.name}
        checked={current === true}
        disabled={disabled}
        description={param.description || undefined}
        onCheckedChange={(next) => onCommit(next)}
      />
    );
  }
  if (param.values) {
    return (
      <label className="field">
        <span className="field-label">{param.name}</span>
        <select
          value={String(current)}
          disabled={disabled}
          onChange={(event) => onCommit(event.target.value)}
        >
          {param.values.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {param.description && <span className="field-note">{param.description}</span>}
      </label>
    );
  }
  const commit = () => {
    if (draft.trim() === String(current)) return;
    const parsed = parseParamInput(param, draft);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onCommit(parsed.value);
  };
  return (
    <label className="field">
      <span className="field-label">{param.name}</span>
      <input
        type={param.type === "string" ? "text" : "number"}
        value={draft}
        disabled={disabled}
        {...(param.type !== "string"
          ? {
              ...(param.min !== undefined ? { min: param.min } : {}),
              ...(param.max !== undefined ? { max: param.max } : {}),
              step: param.type === "int" ? 1 : "any",
            }
          : {})}
        {...(param.name === "encoder" ? { list: "panel-composition-encoders" } : {})}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {param.description && <span className="field-note">{param.description}</span>}
      {error && <span className="error-text">{error}</span>}
    </label>
  );
}

export function PanelCompositionSettings({
  loaded,
  onSave,
}: {
  loaded: ServerSettings | null;
  onSave: (patch: ServerSettingsUpdate) => Promise<ServerSettings | undefined>;
}) {
  const [view, setView] = useState<PanelCompositionView | null>(null);
  const [encoders, setEncoders] = useState<EncoderReadinessView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [coreKey, setCoreKey] = useState("");

  const reload = useCallback(() => {
    getPanelComposition().then(
      (next) => {
        setView(next);
        setLoadError(null);
      },
      (error: unknown) => setLoadError(errorMessage(error)),
    );
    getEncoderReadiness().then(setEncoders, () => setEncoders(null));
  }, []);
  useEffect(() => reload(), [reload]);

  const send = async (patch: CompositionPatch) => {
    setBusy(true);
    try {
      await onSave(patch);
    } finally {
      setBusy(false);
      reload();
    }
  };

  const commit = (name: string, value: PanelParamValue | undefined) => {
    if (!view) return;
    void send({ panelComposition: { params: nextOverrides(view.params, name, value) } });
  };

  if (loadError) return <p className="error-text">{loadError}</p>;
  if (!view) return <p className="dim small">loading the panel composition params…</p>;
  const overrides = view.params.filter((param) => param.override !== undefined);
  const webProvider = loaded?.webSearch?.provider ?? "none";
  return (
    <div className="panel-composition-settings">
      <span className="field-note">
        How the paper-based panel composition retrieves literature and seats the panel. Each value
        shows the default of the pinned bundle
        {view.bundle ? ` (${view.bundle.id} ${view.bundle.version})` : ""}; only values that differ
        from it are saved, and they apply to every NEW run. The Panel section's seat count, when
        set, wins over panelSize here.
      </span>
      {overrides.length > 0 && (
        <div className="fact-row">
          <span className="small">
            {overrides.length} override{overrides.length === 1 ? "" : "s"}:{" "}
            {overrides.map((param) => `${param.name} = ${String(param.override)}`).join(", ")}
          </span>
          <button
            type="button"
            className="btn btn-small"
            disabled={busy}
            onClick={() => void send({ panelComposition: { params: {} } })}
          >
            Reset all to defaults
          </button>
        </div>
      )}
      <datalist id="panel-composition-encoders">
        <option value="specter2" />
        <option value="bge-base-en-v1.5" />
        <option value="hash-ngram-v1" />
        <option value="openrouter:" />
      </datalist>
      {view.groups.map((group) => (
        <div className="panel-composition-group" key={group.id}>
          <h4 className="settings-subheading">{group.title}</h4>
          {view.params
            .filter((param) => param.group === group.id)
            .map((param) => {
              const key = keyNote(param, loaded, view.coreKeyConfigured);
              return (
                <div className="panel-composition-param" key={param.name}>
                  <ParamControl
                    param={param}
                    disabled={busy}
                    onCommit={(value) => commit(param.name, value)}
                  />
                  <span className="field-note">
                    {defaultNote(param, view.bundle?.version)}
                    {param.override !== undefined ? ` · override: ${String(param.override)}` : ""}
                    {key ? ` · ${key}` : ""}
                  </span>
                  {param.override !== undefined && (
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => commit(param.name, undefined)}
                    >
                      Use default
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      ))}
      <h4 className="settings-subheading">CORE API key</h4>
      <div className="field">
        <input
          type="password"
          autoComplete="off"
          aria-label="CORE API key"
          placeholder={view.coreKeyConfigured ? "configured — type to replace" : "CORE API key (core.ac.uk)"}
          value={coreKey}
          disabled={busy}
          onChange={(event) => setCoreKey(event.target.value)}
        />
        <span className="field-note">
          Stored with the other scholarly keys, never in settings.json. Without it the CORE source
          is recorded as needs-key for each run. Not verified with a live request.
        </span>
        <div className="fact-row">
          <button
            type="button"
            className="btn btn-small"
            disabled={busy || coreKey.trim() === ""}
            onClick={() => {
              const value = coreKey.trim();
              void send({ webSearch: { provider: webProvider, coreApiKey: value } }).then(() =>
                setCoreKey((current) => (current.trim() === value ? "" : current)),
              );
            }}
          >
            Save key
          </button>
          {view.coreKeyConfigured && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => void send({ webSearch: { provider: webProvider, clearCoreApiKey: true } })}
            >
              Remove key
            </button>
          )}
        </div>
      </div>
      <h4 className="settings-subheading">Text encoders on this host</h4>
      {encoders ? (
        <ul className="panel-composition-encoders">
          {encoders.encoders.map((encoder) => (
            <li key={encoder.id} className={encoder.available ? undefined : "dim"}>
              {encoder.available ? "✓" : "✗"} {encoder.id}
              {encoder.id === encoders.selected ? " (selected)" : ""} — {encoder.detail}
            </li>
          ))}
          {!encoders.selectedAvailable && (
            <li className="error-text">
              The selected encoder ({encoders.selected}) is not available here; runs fall back to{" "}
              {encoders.fallback} and record it.
            </li>
          )}
        </ul>
      ) : (
        <p className="dim small">encoder availability unavailable</p>
      )}
    </div>
  );
}
