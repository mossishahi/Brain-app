import { createContext, useContext, type ReactNode } from "react";
import type { SaveState, SettingsCategory } from "./catalog";

export const SettingsCategoryContext = createContext<SettingsCategory>("connections");

export function SaveStatus({ state, error }: { state?: SaveState; error?: string }) {
  if (state === "saving") return <span className="settings-save-status" role="status"><span className="save-spinner" aria-hidden /> Saving…</span>;
  if (state === "saved") return <span className="settings-save-status settings-save-ok" role="status">✓ Saved</span>;
  if (state === "error") return <span className="settings-save-status settings-save-error" role="alert">{error ?? "Not saved"}</span>;
  return null;
}

/** Inactive forms never mount, while their drafts remain owned by the dialog. */
export function SettingsSection({ category, title, summary, state, error, children }: {
  category: SettingsCategory; title: string; summary?: string;
  state?: SaveState; error?: string; children: ReactNode;
}) {
  const active = useContext(SettingsCategoryContext);
  if (active !== category) return null;
  return <section className="settings-section">
    <div className="settings-section-heading"><h3>{title}</h3>{summary && <span className="settings-section-summary">{summary}</span>}<SaveStatus state={state} error={error} /></div>
    <div className="settings-section-content">{children}</div>
  </section>;
}
