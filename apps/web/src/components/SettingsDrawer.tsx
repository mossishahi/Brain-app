/** The settings drawer behind the gear icon: Execution, Model, Confirmation. */
import { useEffect, useRef, useState } from "react";
import {
  GPU_COMMAND_TAG,
  GPU_TEMPLATE_EXAMPLE,
  SLURM_COMMAND_TAG,
} from "@brainstorm-agentic/protocol";
import type {
  RunnerKind,
  ServerSettings,
  ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";
import { errorMessage, getHealth, getSettings, postUpdateCheck, putSettings } from "../api";
import { TrashIcon, XIcon } from "./Icons";

type Provider = "anthropic" | "claude-agent" | "cursor-agent" | "offline";

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<ServerSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  /**
   * The manual path for anyone who pressed "Later" on the notification: a
   * fresh server-side release probe; when something newer exists the
   * lower-left card reappears (its snooze is cleared via the window event).
   */
  const checkForUpdates = async (): Promise<void> => {
    setCheckingUpdates(true);
    setUpdateStatus(null);
    try {
      const result = await postUpdateCheck();
      window.dispatchEvent(new Event("brain-check-updates"));
      setUpdateStatus(
        result.appUpdate
          ? "Update available — use the notification at the lower left to install it."
          : `You are on the latest version (v${result.version}).`,
      );
    } catch (error) {
      setUpdateStatus(errorMessage(error));
    } finally {
      setCheckingUpdates(false);
    }
  };

  const [runner, setRunner] = useState<RunnerKind>("slurm");
  const [template, setTemplate] = useState("");
  const [gpuTemplate, setGpuTemplate] = useState("");
  const [gpuTimeLimit, setGpuTimeLimit] = useState("60");
  const [updateCheck, setUpdateCheck] = useState<"off" | "notify">("notify");
  /** Deployment-owned registry facts, shown read-only (never editable). */
  const [registryInfo, setRegistryInfo] = useState<{
    url?: string;
    bundle?: string;
    serverVersion?: string;
    effectiveVersion?: string;
    pinnedVersion?: string;
    latestNotes?: string;
  } | null>(null);
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [cursorApiKey, setCursorApiKey] = useState("");
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
  const [resumeInterrupted, setResumeInterrupted] = useState(true);
  const [safetyBufferSeconds, setSafetyBufferSeconds] = useState("60");
  const [openRouterModel, setOpenRouterModel] = useState("openrouter/free");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [enabledHostTools, setEnabledHostTools] = useState<string[]>([
    "attachment_list",
    "attachment_read",
  ]);

  const drawerRef = useRef<HTMLDivElement>(null);

  /**
   * The two agent-SDK backends (Claude Agent SDK, Cursor SDK) share ONE
   * settings shape: the same turns/budget/effort/thinking/fallback controls
   * apply verbatim to whichever SDK is selected.
   */
  const isAgentSdk = provider === "claude-agent" || provider === "cursor-agent";

  useEffect(() => {
    let live = true;
    getSettings()
      .then((s) => {
        if (!live) return;
        setLoaded(s);
        setRunner(s.runner);
        setTemplate(s.slurmTemplate);
        setGpuTemplate(s.gpu?.template ?? "");
        setGpuTimeLimit(String(s.gpu?.timeLimitMinutes ?? 60));
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
        setResumeInterrupted(s.interruptedRecovery?.autoResume ?? true);
        setSafetyBufferSeconds(String(s.creditRecovery.safetyBufferSeconds));
        setOpenRouterModel(s.creditRecovery.openRouterModel);
        setUpdateCheck(s.updateCheck ?? "notify");
        if (s.hostTools?.enabledToolIds) {
          setEnabledHostTools([...s.hostTools.enabledToolIds]);
        }
      })
      .catch((e: unknown) => {
        if (live) setLoadError(errorMessage(e));
      });
    getHealth()
      .then((health) => {
        if (!live) return;
        setRegistryInfo({
          ...(health.contentRegistry.url ? { url: health.contentRegistry.url } : {}),
          ...(health.contentRegistry.bundle
            ? { bundle: health.contentRegistry.bundle }
            : {}),
          ...(health.contentRegistry.serverVersion
            ? { serverVersion: health.contentRegistry.serverVersion }
            : {}),
          ...(health.contentRegistry.effectiveVersion
            ? { effectiveVersion: health.contentRegistry.effectiveVersion }
            : {}),
          ...(health.contentRegistry.pinnedVersion
            ? { pinnedVersion: health.contentRegistry.pinnedVersion }
            : {}),
          ...(health.contentRegistry.latestNotes
            ? { latestNotes: health.contentRegistry.latestNotes }
            : {}),
        });
      })
      .catch(() => undefined);
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
      if (
        provider === "cursor-agent" &&
        cursorApiKey.trim() === "" &&
        !loaded?.llm.cursorApiKeyConfigured
      ) {
        throw new Error("Enter a Cursor API key before saving.");
      }
      const maxTurns = Number(agentMaxTurns);
      if (
        isAgentSdk &&
        (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 500)
      ) {
        throw new Error("Max turns must be an integer from 1 to 500.");
      }
      const maxBudgetUsd =
        agentMaxBudgetUsd.trim() === ""
          ? undefined
          : Number(agentMaxBudgetUsd);
      if (
        isAgentSdk &&
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
      const gpuConfigured = gpuTemplate.trim() !== "";
      if (gpuConfigured && !gpuTemplate.includes(GPU_COMMAND_TAG)) {
        throw new Error(
          `The GPU template must contain ${GPU_COMMAND_TAG} (or be empty to switch GPU runs off).`,
        );
      }
      const parsedGpuTimeLimit = Number.parseInt(gpuTimeLimit, 10);
      if (!Number.isInteger(parsedGpuTimeLimit) || parsedGpuTimeLimit < 1 || parsedGpuTimeLimit > 1440) {
        throw new Error("GPU time limit must be between 1 and 1440 minutes.");
      }
      // Configuring the template IS the setup: the gpu_run host tool follows
      // it into (or out of) the enabled set, visibly, so one panel is the
      // whole flow instead of a second hidden checkbox hunt.
      const toolIds = gpuConfigured
        ? enabledHostTools.includes("gpu_run")
          ? enabledHostTools
          : [...enabledHostTools, "gpu_run"]
        : enabledHostTools.filter((id) => id !== "gpu_run");
      if (toolIds !== enabledHostTools) setEnabledHostTools(toolIds);
      // contentRegistry is deployment-owned and deliberately not sent: the
      // server ignores it on PUT anyway.
      const update: ServerSettingsUpdate = {
        slurmTemplate: template,
        gpu: { template: gpuTemplate, timeLimitMinutes: parsedGpuTimeLimit },
        runner,
        updateCheck,
        llm: {
          provider,
          model: model.trim() ? model.trim() : undefined,
          ...(provider === "anthropic" && baseUrl.trim()
            ? { baseUrl: baseUrl.trim() }
            : {}),
          modelsByRoute: loaded?.llm.modelsByRoute,
          agentSdk: {
            maxTurns: isAgentSdk
              ? maxTurns
              : (loaded?.llm.agentSdk?.maxTurns ?? 100),
            effort: isAgentSdk
              ? agentEffort
              : (loaded?.llm.agentSdk?.effort ?? "high"),
            thinking: isAgentSdk
              ? agentThinking
              : (loaded?.llm.agentSdk?.thinking ?? "adaptive"),
            ...(isAgentSdk && maxBudgetUsd !== undefined
              ? { maxBudgetUsd }
              : loaded?.llm.agentSdk?.maxBudgetUsd !== undefined
                ? {
                    maxBudgetUsd:
                      loaded.llm.agentSdk.maxBudgetUsd,
                  }
                : {}),
            ...(isAgentSdk && agentFallbackModel.trim()
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
          ...(provider === "cursor-agent" && cursorApiKey.trim()
            ? { cursorApiKey: cursorApiKey.trim() }
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
        interruptedRecovery: {
          autoResume: resumeInterrupted,
        },
        hostTools: {
          enabledToolIds: toolIds,
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
      setCursorApiKey("");
      setOpenRouterApiKey("");
      setConnectionMessage(
        provider === "anthropic"
          ? `Connected to ${saved.llm.model} and saved.`
          : provider === "claude-agent"
            ? `Claude Agent SDK token verified${saved.llm.model ? ` with ${saved.llm.model}` : ""} and saved.`
            : provider === "cursor-agent"
              ? `Cursor API key verified${saved.llm.model ? ` with ${saved.llm.model}` : ""} and saved.`
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
          <div className="drawer-head-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !loaded}
              onClick={() => void save()}
            >
              {saving
                ? provider === "anthropic"
                  ? "Testing connection…"
                  : "Saving…"
                : "Save"}
            </button>
            <button type="button" className="ghost-btn" aria-label="close settings" onClick={onClose}>
              <XIcon />
            </button>
          </div>
        </div>

        {saveError && <p className="error-text">{saveError}</p>}
        {connectionMessage && <p className="success-text">{connectionMessage}</p>}

        {loadError ? (
          <p className="error-text">{loadError}</p>
        ) : !loaded ? (
          <p className="dim small">loading…</p>
        ) : (
          <>
            <section className="drawer-section drawer-updates">
              <div className="inline-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={checkingUpdates}
                  onClick={() => void checkForUpdates()}
                >
                  {checkingUpdates ? "Checking…" : "Check for updates"}
                </button>
                <div className="field" style={{ margin: 0 }}>
                  <select
                    id="settings-update-check"
                    aria-label="automatic update checks"
                    value={updateCheck}
                    onChange={(e) => setUpdateCheck(e.target.value as "off" | "notify")}
                  >
                    <option value="notify">notify automatically</option>
                    <option value="off">manual checks only</option>
                  </select>
                </div>
              </div>
              {updateStatus && <span className="field-note">{updateStatus}</span>}
            </section>

            <details className="drawer-section">
              <summary>Execution</summary>
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
            </details>

            <details className="drawer-section">
              <summary>
                GPU runs{gpuTemplate.trim() !== "" ? " · on" : " · off"}
              </summary>
              <div className="field">
                <label className="field-label" htmlFor="settings-gpu-template">
                  GPU job template
                </label>
                <textarea
                  id="settings-gpu-template"
                  className="mono"
                  rows={11}
                  value={gpuTemplate}
                  onChange={(e) => setGpuTemplate(e.target.value)}
                  placeholder={GPU_TEMPLATE_EXAMPLE}
                  spellCheck={false}
                />
                <span className="field-note">
                  Complete your cluster&apos;s GPU submission script (partition, GPUs,
                  environment setup) and put <code>{GPU_COMMAND_TAG}</code> where the
                  agent&apos;s script must run. The script an agent submits is spliced in
                  verbatim and its job log is returned to that agent unaltered; a failed
                  job goes back to the submitting agent as a bug report it can debug and
                  resubmit. Leave empty to keep GPU runs off. Only roles whose skills
                  declare the gpu-execution capability can submit.
                </span>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="settings-gpu-time-limit">
                  Time limit per job (minutes)
                </label>
                <input
                  id="settings-gpu-time-limit"
                  type="number"
                  min={1}
                  max={1440}
                  value={gpuTimeLimit}
                  onChange={(e) => setGpuTimeLimit(e.target.value)}
                />
                <span className="field-note">
                  Hard ceiling enforced at submission; an agent may request less, never more.
                </span>
              </div>
            </details>

            <details className="drawer-section">
              <summary>Brain Registry</summary>
              <div className="registry-info">
                <div className="registry-info-row">
                  <span className="registry-info-label">Endpoint</span>
                  <span className="registry-info-value">
                    {registryInfo?.url ?? loaded.contentRegistry.url}
                  </span>
                </div>
                <div className="registry-info-row">
                  <span className="registry-info-label">Skills bundle</span>
                  <span className="registry-info-value">
                    {registryInfo?.bundle ?? loaded.contentRegistry.bundle}
                    {registryInfo?.effectiveVersion
                      ? ` v${registryInfo.effectiveVersion}`
                      : ""}
                    {registryInfo?.pinnedVersion
                      ? " (pinned by the deployment)"
                      : registryInfo?.effectiveVersion
                        ? " (latest)"
                        : ""}
                  </span>
                </div>
                {registryInfo?.serverVersion && (
                  <div className="registry-info-row">
                    <span className="registry-info-label">Registry server</span>
                    <span className="registry-info-value">
                      v{registryInfo.serverVersion}
                    </span>
                  </div>
                )}
                {registryInfo?.latestNotes && (
                  <div className="registry-info-row">
                    <span className="registry-info-label">Release notes</span>
                    <span className="registry-info-value">
                      {registryInfo.latestNotes}
                    </span>
                  </div>
                )}
              </div>
              <span className="field-note">
                Configured by the deployment — nothing to set up here. Every
                new pipeline automatically fetches the latest published skills
                and records the exact version it used.
              </span>
            </details>

            <details className="drawer-section" open>
              <summary>Model connection</summary>
              <div className="field">
                <label className="field-label" htmlFor="settings-provider">
                  Provider
                </label>
                <select
                  id="settings-provider"
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value as Provider;
                    if (
                      (next === "claude-agent" || next === "cursor-agent") &&
                      next !== provider
                    ) {
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
                  <option value="cursor-agent">
                    Cursor SDK (API key)
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
              )}
              {provider === "cursor-agent" && (
                <div className="field">
                  <label className="field-label" htmlFor="settings-cursor-key">
                    Cursor API key
                  </label>
                  <input
                    id="settings-cursor-key"
                    type="password"
                    value={cursorApiKey}
                    autoComplete="new-password"
                    placeholder={
                      loaded.llm.cursorApiKeyConfigured
                        ? "Verified key saved — enter a new key to replace it"
                        : "cursor_…"
                    }
                    onChange={(e) => {
                      setCursorApiKey(e.target.value);
                      setConnectionMessage(null);
                      setSaveError(null);
                    }}
                  />
                  <span className="field-note">
                    Create a key at cursor.com/dashboard (Integrations → API keys, or a
                    team service account) and paste it here. The server tests it before
                    saving and never returns it to the browser.
                  </span>
                </div>
              )}
              {isAgentSdk && (
                <>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-agent-model">
                      Model <span className="dim">(optional)</span>
                    </label>
                    <input
                      id="settings-agent-model"
                      type="text"
                      value={model}
                      placeholder={
                        provider === "cursor-agent"
                          ? "auto (server picks; or composer-2.5 / claude-sonnet-5 …)"
                          : "Claude Code default (or sonnet / opus / haiku)"
                      }
                      onChange={(e) => {
                        setModel(e.target.value);
                        setConnectionMessage(null);
                        setSaveError(null);
                      }}
                    />
                    <span className="field-note">
                      Save performs a real one-turn Agent SDK request. Nothing is
                      persisted if the credential or model is rejected. The same
                      execution settings below apply to both agent SDKs, so
                      switching SDKs never changes how tasks run.
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
            </details>

            <details className="drawer-section">
              <summary>Panel confirmation</summary>
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
            </details>

            <details className="drawer-section">
              <summary>Capabilities &amp; host tools</summary>
              <span className="field-note" style={{ marginBottom: "0.5rem", display: "block" }}>
                Tools that run on your machine. Uncheck to disable a capability for all pipeline roles.
              </span>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={enabledHostTools.includes("attachment_list") && enabledHostTools.includes("attachment_read")}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setEnabledHostTools((prev) => [...new Set([...prev, "attachment_list", "attachment_read", "attachment_search"])]);
                    } else {
                      setEnabledHostTools((prev) => prev.filter((id) => id !== "attachment_list" && id !== "attachment_read" && id !== "attachment_search"));
                    }
                  }}
                />
                Attachment access (list, read, and search submission files)
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
                />
                Code execution (host scratch workspace; providers with native
                execution keep using it)
              </label>
            </details>

            <details className="drawer-section">
              <summary>Recovery</summary>
              <h3 className="drawer-subhead">Interrupted jobs</h3>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={resumeInterrupted}
                  onChange={(e) => setResumeInterrupted(e.target.checked)}
                />
                Resume interrupted jobs automatically from their last
                checkpoint
              </label>
              <span className="field-note">
                Covers SLURM timeouts, node failures, and power cuts: the
                scheduler resubmits the run and it continues from where it
                stopped. Auto-resume pauses after repeated attempts without
                progress; the job card then offers a manual resume.
              </span>
              <h3 className="drawer-subhead">Credit recovery</h3>
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
            </details>

            <details className="drawer-section">
              <summary>Trash</summary>
              <a
                className="btn drawer-trash-link"
                href="#/trash"
                onClick={onClose}
              >
                <TrashIcon size={14} />
                View trashed jobs
              </a>
              <span className="field-note">
                Stopped jobs moved to trash leave the job list but stay
                readable.
              </span>
            </details>
          </>
        )}
      </div>
    </>
  );
}
