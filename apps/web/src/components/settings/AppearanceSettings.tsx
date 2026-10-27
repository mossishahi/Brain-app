import { backgroundOptions, setAppearance, useAppearance } from "../../backgrounds";
import { SettingsToggle } from "./SettingsToggle";

export function AppearanceSettings() {
  const appearance = useAppearance();
  return <section className="settings-section">
    <div className="settings-section-content">
      <div className="field">
        <label className="field-label" htmlFor="settings-theme">Theme</label>
        <select id="settings-theme" value={appearance.theme} onChange={(event) => setAppearance({ theme: event.target.value as "system" | "light" | "dark" })}>
          <option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="settings-animation-quality">Animation quality</label>
        <select id="settings-animation-quality" value={appearance.quality} onChange={(event) => setAppearance({ quality: event.target.value as "low" | "balanced" })}>
          <option value="balanced">Balanced</option><option value="low">Low power</option>
        </select>
      </div>
      <fieldset className="settings-background-choices">
        <legend>Background</legend>
        {backgroundOptions.map((option) => <label key={option.id} className={`settings-background-option settings-background-${option.id}`}>
          <input type="radio" name="workspace-background" value={option.id} checked={appearance.background === option.id} onChange={() => setAppearance({ background: option.id })} />
          <span><strong>{option.label}</strong><small>{option.description}</small></span>
        </label>)}
      </fieldset>
      <SettingsToggle label="Animate the background" checked={appearance.motion} onCheckedChange={(motion) => setAppearance({ motion })} />
      <p className="field-note">{appearance.reducedMotion ? "Your device requests reduced motion, so the background remains still." : "Animation pauses while this tab is hidden. Your research continues."}</p>
      {!appearance.persisted && <p className="error-text" role="status">These preferences work in this tab, but your browser could not save them for next time.</p>}
      <p className="field-note">Appearance preferences apply to this browser.</p>
    </div>
  </section>;
}
