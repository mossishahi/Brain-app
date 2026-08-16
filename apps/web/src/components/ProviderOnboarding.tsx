/**
 * First-run overlay: the server is up but no LLM provider is connected yet
 * (fresh workspace on an HPC host, or credentials were cleared). A centered
 * card asks for a Claude setup token or an Anthropic API key — with a short
 * note on where to get one — plus WHERE jobs should run (this machine or a
 * SLURM cluster; the deployment default is SLURM, so a laptop user must be
 * able to switch here or the SLURM readiness icon stays red with no obvious
 * way out). Saving verifies the credential through the existing settings
 * endpoint and dissolves. "Later" hides it for this browser session; the
 * offline provider is offered as an explicit way out. The runner choice is
 * persisted on every path — connect and offline alike.
 */
import { useMemo, useState } from "react";
import {
  DEFAULT_MODEL_CATALOG,
  type ServerSettings,
  type ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";
import { errorMessage, putSettings } from "../api";

type Provider = "claude-agent" | "anthropic" | "cursor-agent";

const DISMISS_KEY = "brain-onboarding-dismissed";

export function onboardingNeeded(settings: ServerSettings | null): boolean {
  if (!settings) return false;
  if (settings.llm.provider === "offline") return false;
  if (settings.llm.provider === "anthropic") {
    return settings.llm.apiKeyConfigured !== true;
  }
  if (settings.llm.provider === "cursor-agent") {
    return settings.llm.cursorApiKeyConfigured !== true;
  }
  return settings.llm.setupTokenConfigured !== true;
}

export function onboardingDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Session storage unavailable; the overlay simply returns on reload.
  }
}

export function ProviderOnboarding({
  settings,
  onSaved,
  onDismiss,
}: {
  readonly settings: ServerSettings;
  readonly onSaved: (updated: ServerSettings) => void;
  readonly onDismiss: () => void;
}) {
  const [provider, setProvider] = useState<Provider>(
    settings.llm.provider === "anthropic"
      ? "anthropic"
      : settings.llm.provider === "cursor-agent"
        ? "cursor-agent"
        : "claude-agent",
  );
  const [runner, setRunner] = useState<"slurm" | "local">(settings.runner);
  const [secret, setSecret] = useState("");
  const [model, setModel] = useState(
    settings.llm.provider === "anthropic" ? (settings.llm.model ?? "") : "",
  );
  const [saving, setSaving] = useState<"connect" | "offline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const anthropicModels = useMemo(
    () => DEFAULT_MODEL_CATALOG.anthropic ?? [],
    [],
  );

  // contentRegistry is deployment-owned and never sent; the server ignores it.
  const baseUpdate = (): ServerSettingsUpdate => ({
    slurmTemplate: settings.slurmTemplate,
    runner,
    panelConfirmation: settings.panelConfirmation,
    ...(settings.updateCheck !== undefined
      ? { updateCheck: settings.updateCheck }
      : {}),
    creditRecovery: {
      autoResume: settings.creditRecovery.autoResume,
      safetyBufferSeconds: settings.creditRecovery.safetyBufferSeconds,
      openRouterModel: settings.creditRecovery.openRouterModel,
    },
    ...(settings.interruptedRecovery !== undefined
      ? { interruptedRecovery: { ...settings.interruptedRecovery } }
      : {}),
    ...(settings.hostTools !== undefined
      ? { hostTools: { enabledToolIds: [...settings.hostTools.enabledToolIds] } }
      : {}),
    llm: { provider: settings.llm.provider },
  });

  const connect = async (): Promise<void> => {
    setError(null);
    if (secret.trim() === "") {
      setError(
        provider === "claude-agent"
          ? "Paste the token printed by `claude setup-token` first."
          : provider === "cursor-agent"
            ? "Paste a Cursor API key first."
            : "Paste an Anthropic API key first.",
      );
      return;
    }
    if (provider === "anthropic" && model.trim() === "") {
      setError("Choose the Anthropic model to use.");
      return;
    }
    setSaving("connect");
    try {
      const updated = await putSettings({
        ...baseUpdate(),
        llm:
          provider === "anthropic"
            ? {
                provider: "anthropic",
                model: model.trim(),
                apiKey: secret.trim(),
                ...(settings.llm.modelsByRoute
                  ? { modelsByRoute: settings.llm.modelsByRoute }
                  : {}),
              }
            : provider === "cursor-agent"
              ? {
                  provider: "cursor-agent",
                  cursorApiKey: secret.trim(),
                  // The agent-SDK execution settings are shared verbatim
                  // between the Claude and Cursor backends.
                  ...(settings.llm.agentSdk
                    ? { agentSdk: settings.llm.agentSdk }
                    : {}),
                  ...(settings.llm.modelsByRoute
                    ? { modelsByRoute: settings.llm.modelsByRoute }
                    : {}),
                }
              : {
                  provider: "claude-agent",
                  setupToken: secret.trim(),
                  ...(settings.llm.agentSdk
                    ? { agentSdk: settings.llm.agentSdk }
                    : {}),
                  ...(settings.llm.modelsByRoute
                    ? { modelsByRoute: settings.llm.modelsByRoute }
                    : {}),
                },
      });
      onSaved(updated);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(null);
    }
  };

  const useOffline = async (): Promise<void> => {
    setError(null);
    setSaving("offline");
    try {
      const updated = await putSettings({
        ...baseUpdate(),
        llm: { provider: "offline" },
      });
      onSaved(updated);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="onboard-overlay" role="dialog" aria-modal="true" aria-label="Connect a model">
      <div className="onboard-card">
        <h2 className="onboard-title">Connect a model</h2>
        <p className="onboard-lead">
          The pipeline needs an LLM before it can run. Connect one now — the
          credential is verified with one small request and stored only on
          this server.
        </p>

        <p className="onboard-section-label">Where do jobs run?</p>
        <div
          className="onboard-providers"
          role="radiogroup"
          aria-label="execution runner"
        >
          <button
            type="button"
            role="radio"
            aria-checked={runner === "local"}
            className={`onboard-provider${runner === "local" ? " selected" : ""}`}
            onClick={() => setRunner("local")}
          >
            <span className="onboard-provider-name">This machine</span>
            <span className="onboard-provider-hint">local processes</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={runner === "slurm"}
            className={`onboard-provider${runner === "slurm" ? " selected" : ""}`}
            onClick={() => setRunner("slurm")}
          >
            <span className="onboard-provider-name">SLURM cluster</span>
            <span className="onboard-provider-hint">submit via sbatch</span>
          </button>
        </div>
        <p className="onboard-note">
          {runner === "slurm" ? (
            <>
              Jobs are submitted with <code>sbatch</code>; the readiness strip
              gains a SLURM icon that probes the scheduler. The batch template
              is editable later in Settings.
            </>
          ) : (
            <>
              Jobs run as processes on this machine — no scheduler needed. You
              can switch to SLURM later in Settings.
            </>
          )}
        </p>

        <p className="onboard-section-label">Model provider</p>
        <div className="onboard-providers" role="radiogroup" aria-label="provider">
          <button
            type="button"
            role="radio"
            aria-checked={provider === "claude-agent"}
            className={`onboard-provider${provider === "claude-agent" ? " selected" : ""}`}
            onClick={() => {
              setProvider("claude-agent");
              setError(null);
            }}
          >
            <span className="onboard-provider-name">Claude setup token</span>
            <span className="onboard-provider-hint">Claude Agent SDK</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={provider === "anthropic"}
            className={`onboard-provider${provider === "anthropic" ? " selected" : ""}`}
            onClick={() => {
              setProvider("anthropic");
              setError(null);
            }}
          >
            <span className="onboard-provider-name">Anthropic API key</span>
            <span className="onboard-provider-hint">developer Messages API</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={provider === "cursor-agent"}
            className={`onboard-provider${provider === "cursor-agent" ? " selected" : ""}`}
            onClick={() => {
              setProvider("cursor-agent");
              setError(null);
            }}
          >
            <span className="onboard-provider-name">Cursor API key</span>
            <span className="onboard-provider-hint">Cursor SDK</span>
          </button>
        </div>

        <label className="onboard-field">
          <span>
            {provider === "claude-agent" ? "Setup token" : "API key"}
          </span>
          <input
            type="password"
            value={secret}
            placeholder={
              provider === "claude-agent"
                ? "paste the token…"
                : provider === "cursor-agent"
                  ? "cursor_…"
                  : "sk-ant-…"
            }
            autoFocus
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void connect();
            }}
          />
        </label>
        {provider === "anthropic" && (
          <label className="onboard-field">
            <span>Model</span>
            <input
              type="text"
              value={model}
              list="onboard-anthropic-models"
              placeholder="claude-sonnet-5"
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="onboard-anthropic-models">
              {anthropicModels.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </datalist>
          </label>
        )}
        <p className="onboard-note">
          {provider === "claude-agent" ? (
            <>
              Run <code>claude setup-token</code> in any terminal where Claude
              Code is signed in, then paste the printed token here.
            </>
          ) : provider === "cursor-agent" ? (
            <>
              Create a key at{" "}
              <a
                href="https://cursor.com/dashboard"
                target="_blank"
                rel="noreferrer"
              >
                cursor.com/dashboard
              </a>{" "}
              → Integrations → API keys, then paste it here.
            </>
          ) : (
            <>
              Create a key at{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
              >
                console.anthropic.com
              </a>{" "}
              → API Keys, then paste it here.
            </>
          )}
        </p>

        {error && <p className="error-text onboard-error">{error}</p>}

        <div className="onboard-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving !== null}
            onClick={() => void connect()}
          >
            {saving === "connect" ? "Verifying…" : "Connect"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={saving !== null}
            onClick={() => void useOffline()}
          >
            {saving === "offline" ? "Switching…" : "Use offline mode"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving !== null}
            onClick={() => {
              rememberDismissed();
              onDismiss();
            }}
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
