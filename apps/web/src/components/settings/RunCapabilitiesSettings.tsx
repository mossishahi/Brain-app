import { useEffect, useState } from "react";
import type { CapabilityOptionsResponse } from "@brainstorm-agentic/protocol";
import { errorMessage, getCapabilityOptions } from "../../api";
import { resetCapabilityDraft, setCapabilityOverride, useCapabilityDraft } from "../../features/composer/capability-draft";
import { SettingsToggle } from "./SettingsToggle";
import "./research-controls.css";

const capabilityLabel = (id: string) => id.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

/** This is a submission preference, separate from deployment-wide host tools. */
export function RunCapabilitiesSettings() {
  const draft = useCapabilityDraft();
  const [options, setOptions] = useState<CapabilityOptionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void getCapabilityOptions().then((value) => {
      if (live) setOptions(value);
    }, (reason: unknown) => {
      if (live) setError(errorMessage(reason));
    });
    return () => { live = false; };
  }, [attempt]);

  return <div className="settings-research-controls">
    <p className="field-note">Choices apply to new research started in this tab and stay selected until you change them. Switching a capability off also disables its provider-native equivalents. Enabling it follows your configured tools and providers.</p>
    {error && <div className="inline-actions"><p className="error-text" role="alert">{error}</p><button type="button" className="btn btn-small" onClick={() => setAttempt((value) => value + 1)}>Retry capabilities</button></div>}
    {!options && !error && <p className="field-note" role="status">Loading capabilities…</p>}
    {options?.capabilities.map((capability) => <SettingsToggle
      key={capability.id}
      label={`${capabilityLabel(capability.id)}${capability.locked ? " (always on)" : ""}`}
      description={capability.description}
      checked={capability.locked || draft[capability.id] !== false}
      disabled={capability.locked}
      onCheckedChange={(enabled) => setCapabilityOverride(capability.id, enabled)}
    />)}
    {options && <div className="inline-actions"><button type="button" className="btn btn-small" disabled={!Object.values(draft).includes(false)} onClick={resetCapabilityDraft}>Enable all</button></div>}
  </div>;
}
