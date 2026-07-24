/** The settings drawer behind the gear icon: Execution, Model, Confirmation. */
import { useEffect, useRef, useState } from "react";
import { SLURM_COMMAND_TAG } from "@brainstorm-agentic/protocol";
import type {
  RunnerKind,
  ServerSettings,
  ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";
import { errorMessage, getSettings, putSettings } from "../api";
import { XIcon } from "./Icons";

type Provider = "anthropic" | "claude-agent" | "offline";

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<ServerSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [runner, setRunner] = useState<RunnerKind>("slurm");
  const [template, setTemplate] = useState("");
  const [registryUrl, setRegistryUrl] = useState("");
  const [registryBundle, setRegistryBundle] = useState("brainstorm");
  const [registryVersion, setRegistryVersion] = useState("");
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [agentMaxTurns, setAgentMaxTurns] = useState("100");
  const [agentMaxBudgetUsd, setAgentMaxBudgetUsd] = useState("");
  const [agentEffort, setAgentEffort] = useState<
    "low" | "medium" | "high" | "xhigh" | "max"
  >("high");
  const [agentThinking, setAgentThinking] = useState<
    "adaptive" | "disabled"
  >("adaptive");
  const [agentFallbackModel, setAgentFallbackModel] = useState("");
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"manual" | "auto">("manual");
  const [autoResume, setAutoResume] = useState(true);
  const [safetyBufferSeconds, setSafetyBufferSeconds] = useState("60");
  const [openRouterModel, setOpenRouterModel] = useState("openrouter/free");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [enabledHostTools, setEnabledHostTools] = useState<string[]>([
    "attachment_list",
    "attachment_read",
  ]);

  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getSettings()
      .then((s) => {
        if (!live) return;
        setLoaded(s);
        setRunner(s.runner);
        setTemplate(s.slurmTemplate);
        setRegistryUrl(s.contentRegistry.url);
        setRegistryBundle(s.contentRegistry.bundle);
        setRegistryVersion(s.contentRegistry.version ?? "");
        setProvider(s.llm.provider);
        setModel(s.llm.model ?? "");
        setBaseUrl(s.llm.baseUrl ?? "");
        setAgentMaxTurns(String(s.llm.agentSdk?.maxTurns ?? 100));
        setAgentMaxBudgetUsd(
          s.llm.agentSdk?.maxBudgetUsd !== undefined
            ? String(s.llm.agentSdk.maxBudgetUsd)
            : "",
        );
        setAgentEffort(s.llm.agentSdk?.effort ?? "high");
        setAgentThinking(s.llm.agentSdk?.thinking ?? "adaptive");
        setAgentFallbackModel(s.llm.agentSdk?.fallbackModel ?? "");
        setConfirmation(s.panelConfirmation);
        setAutoResume(s.creditRecovery.autoResume);
        setSafetyBufferSeconds(String(s.creditRecovery.safetyBufferSeconds));
        setOpenRouterModel(s.creditRecovery.openRouterModel);
        if (s.hostTools?.enabledToolIds) {
          setEnabledHostTools([...s.hostTools.enabledToolIds]);
        }
      })
      .catch((e: unknown) => {
        if (live) setLoadError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    drawerRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setConnectionMessage(null);
    try {
      if (provider === "anthropic" && model.trim() === "") {
        throw new Error("Choose an Anthropic model before saving.");
      }
      if (
        provider === "anthropic" &&
        apiKey.trim() === "" &&
        !loaded?.llm.apiKeyConfigured
      ) {
        throw new Error("Enter an Anthropic API key before saving.");
      }
      if (
        provider === "claude-agent" &&
        setupToken.trim() === "" &&
        !loaded?.llm.setupTokenConfigured
      ) {
        throw new Error(
          "Enter the token printed by `claude setup-token` before saving.",
        );
      }
      const maxTurns = Number(agentMaxTurns);
      if (
        provider === "claude-agent" &&
        (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 500)
      ) {
        throw new Error("Max turns must be an integer from 1 to 500.");
      }
      const maxBudgetUsd =
        agentMaxBudgetUsd.trim() === ""
          ? undefined
          : Number(agentMaxBudgetUsd);
      if (
        provider === "claude-agent" &&
        maxBudgetUsd !== undefined &&
        (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)
      ) {
        throw new Error("Max budget must be a positive USD amount.");
      }
      const parsedSafetyBuffer = Number(safetyBufferSeconds);
      if (
        !Number.isSafeInteger(parsedSafetyBuffer) ||
        parsedSafetyBuffer < 0 ||
        parsedSafetyBuffer > 3600
      ) {
        throw new Error(
          "Credit recovery safety buffer must be an integer from 0 to 3600 seconds.",
        );
      }
      if (openRouterModel.trim() === "") {
        throw new Error("OpenRouter model must not be empty.");
      }
      if (registryUrl.trim() === "") {
        throw new Error("Brain Registry URL must not be empty.");
      }
      if (registryBundle.trim() === "") {
        throw new Error("Brain Registry bundle must not be empty.");
      }
      const update: ServerSettingsUpdate = {
        slurmTemplate: template,
        runner,
        contentRegistry: {
          url: registryUrl.trim(),
          bundle: registryBundle.trim(),
          ...(registryVersion.trim()
            ? { version: registryVersion.trim() }
            : {}),
        },
        llm: {
          provider,
          model: model.trim() ? model.trim() : undefined,
          ...(provider === "anthropic" && baseUrl.trim()
            ? { baseUrl: baseUrl.trim() }
            : {}),
          modelsByRoute: loaded?.llm.modelsByRoute,
          agentSdk: {
            maxTurns:
              provider === "claude-agent"
                ? maxTurns
                : (loaded?.llm.agentSdk?.maxTurns ?? 100),
            effort:
              provider === "claude-agent"
                ? agentEffort
                : (loaded?.llm.agentSdk?.effort ?? "high"),
            thinking:
              provider === "claude-agent"
                ? agentThinking
                : (loaded?.llm.agentSdk?.thinking ?? "adaptive"),
            ...(provider === "claude-agent" &&
            maxBudgetUsd !== undefined
              ? { maxBudgetUsd }
              : loaded?.llm.agentSdk?.maxBudgetUsd !== undefined
                ? {
                    maxBudgetUsd:
                      loaded.llm.agentSdk.maxBudgetUsd,
                  }
                : {}),
            ...(provider === "claude-agent" &&
            agentFallbackModel.trim()
              ? { fallbackModel: agentFallbackModel.trim() }
              : loaded?.llm.agentSdk?.fallbackModel
                ? {
                    fallbackModel:
                      loaded.llm.agentSdk.fallbackModel,
                  }
                : {}),
          },
          ...(provider === "anthropic" && apiKey.trim()
            ? { apiKey: apiKey.trim() }
            : {}),
          ...(provider === "claude-agent" && setupToken.trim()
            ? { setupToken: setupToken.trim() }
            : {}),
        },
        panelConfirmation: confirmation,
        creditRecovery: {
          autoResume,
          safetyBufferSeconds: parsedSafetyBuffer,
          openRouterModel: openRouterModel.trim(),
          ...(openRouterApiKey.trim()
            ? { openRouterApiKey: openRouterApiKey.trim() }
            : {}),
        },
        hostTools: {
          enabledToolIds: enabledHostTools,
        },
      };
      const saved = await putSettings(update);
      setLoaded(saved);
      window.dispatchEvent(
        new CustomEvent("brain-settings-updated", {
          detail: saved,
        }),
      );
      setApiKey("");
      setSetupToken("");
      setOpenRouterApiKey("");
      setConnectionMessage(
        provider === "anthropic"
          ? `Connected to ${saved.llm.model} and saved.`
          : provider === "claude-agent"
            ? `Claude Agent SDK token verified${saved.llm.model ? ` with ${saved.llm.model}` : ""} and saved.`
          : "Settings saved.",
      );
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} aria-hidden />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="settings"
        ref={drawerRef}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <h2>Settings</h2>
          <button type="button" className="ghost-btn" aria-label="close settings" onClick={onClose}>
            <XIcon />
          </button>
        </div>

        {loadError ? (
          <p className="error-text">{loadError}</p>
        ) : !loaded ? (
          <p className="dim small">loading…</p>
        ) : (
          <>
            <section className="drawer-section">
              <h3>Execution</h3>
              <div className="field">
                <label className="field-label" htmlFor="settings-runner">
                  Runner
                </label>
                <select
                  id="settings-runner"
                  value={runner}
                  onChange={(e) => setRunner(e.target.value as RunnerKind)}
                >
                  <option value="slurm">slurm</option>
                  <option value="local">local</option>
                </select>
                {runner === "local" && (
                  <span className="field-note">runs on this machine, for development</span>
                )}
              </div>
              <div className="field">
                <label className="field-label" htmlFor="settings-template">
                  SLURM template
                </label>
                <textarea
                  id="settings-template"
                  className="mono"
                  rows={12}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  spellCheck={false}
                />
                <span className="field-note">
                  Put <code>{SLURM_COMMAND_TAG}</code> where the orchestration command must run.
                </span>
              </div>
            </section>

            <section className="drawer-section">
              <h3>Brain Registry</h3>
              <div className="field">
                <label className="field-label" htmlFor="settings-registry-url">
                  MCP endpoint
                </label>
                <input
                  id="settings-registry-url"
                  type="url"
                  value={registryUrl}
                  onChange={(e) => setRegistryUrl(e.target.value)}
                  placeholder="https://167.172.170.154/mcp"
                />
                <span className="field-note">
                  The worker pins a version and fetches each skill only when its stage is reached.
                </span>
              </div>
              <div className="field-grid-two">
                <div className="field">
                  <label className="field-label" htmlFor="settings-registry-bundle">
                    Bundle
                  </label>
                  <input
                    id="settings-registry-bundle"
                    type="text"
                    value={registryBundle}
                    onChange={(e) => setRegistryBundle(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="settings-registry-version">
                    Version override
                  </label>
                  <input
                    id="settings-registry-version"
                    type="text"
                    value={registryVersion}
                    onChange={(e) => setRegistryVersion(e.target.value)}
                    placeholder="latest"
                  />
                </div>
              </div>
            </section>

            <section className="drawer-section">
              <h3>Model connection</h3>
              <div className="field">
                <label className="field-label" htmlFor="settings-provider">
                  Provider
                </label>
                <select
                  id="settings-provider"
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value as Provider;
                    if (next === "claude-agent" && provider !== "claude-agent") {
                      setModel("");
                      setBaseUrl("");
                    } else if (
                      next === "anthropic" &&
                      provider !== "anthropic" &&
                      model.trim() === ""
                    ) {
                      setModel("claude-sonnet-5");
                    }
                    setProvider(next);
                    setConnectionMessage(null);
                    setSaveError(null);
                  }}
                >
                  <option value="anthropic">
                    Anthropic API (developer key)
                  </option>
                  <option value="claude-agent">
                    Claude Agent SDK (setup token)
                  </option>
                  <option value="offline">Offline (deterministic, no key)</option>
                </select>
              </div>
              {provider === "anthropic" && (
                <>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-api-key">
                      API key
                    </label>
                    <input
                      id="settings-api-key"
                      type="password"
                      value={apiKey}
                      autoComplete="new-password"
                      placeholder={
                        loaded.llm.apiKeyConfigured
                          ? "Verified key saved — enter a new key to replace it"
                          : "sk-ant-…"
                      }
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setConnectionMessage(null);
                        setSaveError(null);
                      }}
                    />
                    <span className="field-note">
                      {loaded.llm.apiKeyConfigured
                        ? "A verified key is configured. It is never returned to this page."
                        : "The key is tested with Anthropic before it is stored."}
                    </span>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-model">
                      Model
                    </label>
                    <input
                      id="settings-model"
                      type="text"
                      value={model}
                      placeholder="claude-sonnet-5"
                      onChange={(e) => {
                        setModel(e.target.value);
                        setConnectionMessage(null);
                        setSaveError(null);
                      }}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-base-url">
                      Base URL <span className="dim">(optional)</span>
                    </label>
                    <input
                      id="settings-base-url"
                      type="url"
                      value={baseUrl}
                      placeholder="Anthropic default"
                      onChange={(e) => {
                        setBaseUrl(e.target.value);
                        setConnectionMessage(null);
                        setSaveError(null);
                      }}
                    />
                    <span className="field-note">
                      Save performs a small live request with this key and model. Nothing is
                      persisted if the connection fails.
                    </span>
                  </div>
                </>
              )}
              {provider === "claude-agent" && (
                <>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-setup-token">
                      Setup token
                    </label>
                    <input
                      id="settings-setup-token"
                      type="password"
                      value={setupToken}
                      autoComplete="new-password"
                      placeholder={
                        loaded.llm.setupTokenConfigured
                          ? "Verified token saved — enter a new token to replace it"
                          : "Run `claude setup-token`, then paste its token"
                      }
                      onChange={(e) => {
                        setSetupToken(e.target.value);
                        setConnectionMessage(null);
                        setSaveError(null);
                      }}
                    />
                    <span className="field-note">
                      Run <code>claude setup-token</code> in a terminal, complete the
                      browser flow, and paste the printed token here. The server tests it
                      before saving and never returns it to the browser.
                    </span>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-agent-model">
                      Model <span className="dim">(optional)</span>
                    </label>
                    <input
                      id="settings-agent-model"
                      type="text"
                      value={model}
                      placeholder="Claude Code default (or sonnet / opus / haiku)"
                      onChange={(e) => {
                        setModel(e.target.value);
                        setConnectionMessage(null);
                        setSaveError(null);
                      }}
                    />
                    <span className="field-note">
                      Save performs a real one-turn Agent SDK request. Nothing is
                      persisted if the token or model is rejected.
                    </span>
                  </div>
                  <div className="field-grid-two">
                    <div className="field">
                      <label className="field-label" htmlFor="settings-agent-turns">
                        Max turns per task
                      </label>
                      <input
                        id="settings-agent-turns"
                        type="number"
                        min={1}
                        max={500}
                        step={1}
                        value={agentMaxTurns}
                        onChange={(e) => setAgentMaxTurns(e.target.value)}
                      />
                      <span className="field-note">
                        Decomposition may need dozens of search round-trips.
                      </span>
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="settings-agent-budget">
                        Max USD per task <span className="dim">(optional)</span>
                      </label>
                      <input
                        id="settings-agent-budget"
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={agentMaxBudgetUsd}
                        placeholder="No explicit cap"
                        onChange={(e) => setAgentMaxBudgetUsd(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="field-grid-two">
                    <div className="field">
                      <label className="field-label" htmlFor="settings-agent-effort">
                        Reasoning effort
                      </label>
                      <select
                        id="settings-agent-effort"
                        value={agentEffort}
                        onChange={(e) =>
                          setAgentEffort(
                            e.target.value as
                              | "low"
                              | "medium"
                              | "high"
                              | "xhigh"
                              | "max",
                          )
                        }
                      >
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="xhigh">xhigh</option>
                        <option value="max">max</option>
                      </select>
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="settings-agent-thinking">
                        Extended thinking
                      </label>
                      <select
                        id="settings-agent-thinking"
                        value={agentThinking}
                        onChange={(e) =>
                          setAgentThinking(
                            e.target.value as "adaptive" | "disabled",
                          )
                        }
                      >
                        <option value="adaptive">adaptive</option>
                        <option value="disabled">disabled</option>
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-agent-fallback">
                      Fallback model <span className="dim">(optional)</span>
                    </label>
                    <input
                      id="settings-agent-fallback"
                      type="text"
                      value={agentFallbackModel}
                      placeholder="e.g. sonnet"
                      onChange={(e) => setAgentFallbackModel(e.target.value)}
                    />
                  </div>
                </>
              )}
            </section>

            <section className="drawer-section">
              <h3>Panel confirmation</h3>
              <label className="radio-row">
                <input
                  type="radio"
                  name="panel-confirmation"
                  checked={confirmation === "manual"}
                  onChange={() => setConfirmation("manual")}
                />
                Ask me on the dashboard
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="panel-confirmation"
                  checked={confirmation === "auto"}
                  onChange={() => setConfirmation("auto")}
                />
                Approve automatically
              </label>
            </section>

            <section className="drawer-section">
              <h3>Host tools</h3>
              <span className="field-note" style={{ marginBottom: "0.5rem", display: "block" }}>
                Tools that run on your machine. Uncheck to disable a capability for all pipeline roles.
              </span>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={enabledHostTools.includes("attachment_list") && enabledHostTools.includes("attachment_read")}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setEnabledHostTools((prev) => [...new Set([...prev, "attachment_list", "attachment_read"])]);
                    } else {
                      setEnabledHostTools((prev) => prev.filter((id) => id !== "attachment_list" && id !== "attachment_read"));
                    }
                  }}
                />
                Attachment access (read submission files)
              </label>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={enabledHostTools.includes("web_search") && enabledHostTools.includes("web_fetch")}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setEnabledHostTools((prev) => [...new Set([...prev, "web_search", "web_fetch"])]);
                    } else {
                      setEnabledHostTools((prev) => prev.filter((id) => id !== "web_search" && id !== "web_fetch"));
                    }
                  }}
                  disabled
                />
                Web search (not yet implemented)
              </label>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={enabledHostTools.includes("code_execute")}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setEnabledHostTools((prev) => [...new Set([...prev, "code_execute"])]);
                    } else {
                      setEnabledHostTools((prev) => prev.filter((id) => id !== "code_execute"));
                    }
                  }}
                  disabled
                />
                Code execution (not yet implemented)
              </label>
            </section>

            <section className="drawer-section">
              <h3>Credit recovery</h3>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={autoResume}
                  onChange={(e) => setAutoResume(e.target.checked)}
                />
                Resume automatically after provider credit resets
              </label>
              <div className="field-grid-two">
                <div className="field">
                  <label className="field-label" htmlFor="settings-credit-buffer">
                    Safety buffer (seconds)
                  </label>
                  <input
                    id="settings-credit-buffer"
                    type="number"
                    min={0}
                    max={3600}
                    step={1}
                    value={safetyBufferSeconds}
                    onChange={(e) => setSafetyBufferSeconds(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="settings-openrouter-model">
                    OpenRouter parser model
                  </label>
                  <input
                    id="settings-openrouter-model"
                    type="text"
                    value={openRouterModel}
                    onChange={(e) => setOpenRouterModel(e.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="settings-openrouter-key">
                  OpenRouter API key <span className="dim">(optional)</span>
                </label>
                <input
                  id="settings-openrouter-key"
                  type="password"
                  value={openRouterApiKey}
                  autoComplete="new-password"
                  placeholder={
                    loaded.creditRecovery.openRouterKeyConfigured
                      ? "Verified key saved — enter a new key to replace it"
                      : "Required only for reset messages the deterministic parser cannot read"
                  }
                  onChange={(e) => setOpenRouterApiKey(e.target.value)}
                />
                <span className="field-note">
                  Known Claude reset messages are parsed locally first. Unknown formats can be
                  sent with current time and timezone to <code>openrouter/free</code>. The key is
                  verified before saving and never returned to the browser.
                </span>
              </div>
            </section>

            {saveError && <p className="error-text">{saveError}</p>}
            {connectionMessage && (
              <p className="success-text">{connectionMessage}</p>
            )}

            <div className="drawer-footer">
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving
                  ? provider === "anthropic"
                    ? "Testing connection…"
                    : "Saving…"
                  : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
