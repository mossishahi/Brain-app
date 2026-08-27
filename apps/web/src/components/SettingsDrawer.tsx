/**
 * The settings drawer behind the gear icon.
 *
 * Every section saves ON ITS OWN. There is no drawer-wide Save button, because
 * one existed and made every edit look like a credential change: changing the
 * review-round budget re-sent the whole document, the server re-tested the
 * Claude token to persist it, and seconds later the drawer announced "token
 * verified" as though that had been the edit.
 *
 * So: a control that carries no risk saves as you leave it (selects and
 * checkboxes at once, typed values shortly after you stop typing), and each one
 * reports back in its own section. A credential is the exception — it costs a
 * real request to the provider — so it keeps an explicit Save beside the input
 * that spins while the connection is tested and settles into a check.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
import { prefersReducedMotion } from "../format";
import { ChevronIcon, TrashIcon, XIcon } from "./Icons";

type Provider = "anthropic" | "claude-agent" | "cursor-agent" | "offline";

/**
 * The sections of an update, non-optional. Every field of ServerSettingsUpdate
 * is optional (absent = keep stored), so a payload has to be built through
 * these to keep its own required fields — a spread of the optional type would
 * quietly drop `provider`.
 */
type LlmPatch = NonNullable<ServerSettingsUpdate["llm"]>;
type AgentSdkPatch = NonNullable<LlmPatch["agentSdk"]>;
type CreditRecoveryPatch = NonNullable<ServerSettingsUpdate["creditRecovery"]>;

const SECTION_IDS = [
  "updates",
  "execution",
  "gpu",
  "model",
  "credential",
  "confirmation",
  "review",
  "panel",
  "tools",
  "webSearch",
  "recovery",
] as const;
type SectionId = (typeof SECTION_IDS)[number];

type SaveState = "idle" | "saving" | "saved" | "error";

/** How long a settled check stays before it fades back to nothing. */
const SAVED_LINGER_MS = 2000;
/** Quiet time after the last keystroke before a typed value is saved. */
const TYPING_SETTLE_MS = 700;
/** Must match the drawer's CSS transition; the drawer unmounts after it. */
const CLOSE_ANIMATION_MS = 200;

/**
 * The per-section indicator: a spinning ring while the save is in flight, a
 * green check once it lands, the reason if it was refused.
 */
function SaveStatus({ state, error }: { state?: SaveState; error?: string }) {
  if (state === "saving") {
    return (
      <span className="save-status" role="status" aria-label="saving">
        <span className="save-spinner" aria-hidden />
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="save-status save-status-ok" role="status">
        <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
          <path
            d="m3.5 8.5 3 3 6-6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="save-status-text">saved</span>
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="save-status save-status-bad" role="alert">
        {error ?? "not saved"}
      </span>
    );
  }
  return null;
}

/**
 * One foldable section. Native <details> cannot animate its height, so the fold
 * is a grid row that goes from 0fr to 1fr — the same mechanism the job cards
 * expand with.
 */
function Section({
  title,
  summary,
  defaultOpen = false,
  state,
  error,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  state?: SaveState;
  error?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`drawer-section${open ? " drawer-section-open" : ""}`}>
      <button
        type="button"
        className="drawer-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="drawer-summary-chevron" aria-hidden>
          <ChevronIcon />
        </span>
        <span className="drawer-summary-title">{title}</span>
        {summary && <span className="dim small">{summary}</span>}
        <SaveStatus state={state} error={error} />
      </button>
      <div className="drawer-fold">
        <div className="drawer-fold-inner">{children}</div>
      </div>
    </section>
  );
}

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<ServerSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const [saveState, setSaveState] = useState<Partial<Record<SectionId, SaveState>>>({});
  const [saveError, setSaveError] = useState<Partial<Record<SectionId, string>>>({});
  /**
   * Per section, which save is the newest. A superseded response must not
   * overwrite a newer one's outcome — the user kept typing while it was away.
   */
  const seq = useRef<Partial<Record<SectionId, number>>>({});
  /** Debounced saves not yet sent, so closing the drawer can flush them. */
  const pending = useRef<Partial<Record<SectionId, { timer: number; build: () => ServerSettingsUpdate | null }>>>({});

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
  const [agentThinking, setAgentThinking] = useState<"adaptive" | "disabled">(
    "adaptive",
  );
  const [agentFallbackModel, setAgentFallbackModel] = useState("");
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"manual" | "auto">("manual");
  const [gateAutoApprove, setGateAutoApprove] = useState(true);
  /** "" = follow the bundle's default; otherwise the override as a string. */
  const [reviewMaxRounds, setReviewMaxRounds] = useState<string>("");
  /** "" = follow the bundle's default; otherwise the seat count as a string. */
  const [panelSize, setPanelSize] = useState<string>("");
  const [interdisciplinarySeat, setInterdisciplinarySeat] = useState(true);
  const [autoResume, setAutoResume] = useState(true);
  const [resumeInterrupted, setResumeInterrupted] = useState(true);
  const [safetyBufferSeconds, setSafetyBufferSeconds] = useState("60");
  const [openRouterModel, setOpenRouterModel] = useState("openrouter/free");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [enabledHostTools, setEnabledHostTools] = useState<string[]>([
    "attachment_list",
    "attachment_read",
  ]);
  /** The host-owned web layer: provider, scholarly chain, cache, and keys. */
  const [webProvider, setWebProvider] = useState<
    "none" | "tavily" | "brave" | "searxng" | "searxng-local"
  >("none");
  const [searxngBaseUrl, setSearxngBaseUrl] = useState("");
  const [webScholarly, setWebScholarly] = useState(true);
  const [webCacheEnabled, setWebCacheEnabled] = useState(false);
  const [webContactEmail, setWebContactEmail] = useState("");
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [braveApiKey, setBraveApiKey] = useState("");

  const drawerRef = useRef<HTMLDivElement>(null);

  /**
   * The two agent-SDK backends (Claude Agent SDK, Cursor SDK) share ONE
   * settings shape: the same turns/budget/effort/thinking/fallback controls
   * apply verbatim to whichever SDK is selected.
   */
  const isAgentSdk = provider === "claude-agent" || provider === "cursor-agent";

  /**
   * Sends one section's patch. Absent sections keep their stored value, so a
   * section save can never disturb another's settings — that is the whole point
   * of the patch shape on the wire.
   */
  const save = useCallback(
    async (section: SectionId, patch: ServerSettingsUpdate): Promise<ServerSettings | undefined> => {
      const mine = (seq.current[section] ?? 0) + 1;
      seq.current[section] = mine;
      setSaveState((s) => ({ ...s, [section]: "saving" }));
      setSaveError((e) => ({ ...e, [section]: undefined }));
      try {
        const saved = await putSettings(patch);
        if (seq.current[section] !== mine) return saved;
        setLoaded(saved);
        // Landing and the composer both read the whole settings object off this
        // event, so every section save must broadcast the COMPLETE settings.
        window.dispatchEvent(
          new CustomEvent("brain-settings-updated", { detail: saved }),
        );
        setSaveState((s) => ({ ...s, [section]: "saved" }));
        window.setTimeout(() => {
          setSaveState((s) =>
            seq.current[section] === mine ? { ...s, [section]: "idle" } : s,
          );
        }, SAVED_LINGER_MS);
        return saved;
      } catch (error) {
        if (seq.current[section] !== mine) return undefined;
        setSaveError((e) => ({ ...e, [section]: errorMessage(error) }));
        setSaveState((s) => ({ ...s, [section]: "error" }));
        return undefined;
      }
    },
    [],
  );

  /** Reports a client-side refusal in the section's own indicator. */
  const reject = useCallback((section: SectionId, message: string) => {
    seq.current[section] = (seq.current[section] ?? 0) + 1;
    setSaveError((e) => ({ ...e, [section]: message }));
    setSaveState((s) => ({ ...s, [section]: "error" }));
  }, []);

  /**
   * Saves after the user stops typing. `build` returns null when the current
   * value is not worth sending yet (a half-typed template has no command tag),
   * which leaves the previous value stored rather than failing on every keystroke.
   */
  const saveSoon = useCallback(
    (section: SectionId, build: () => ServerSettingsUpdate | null) => {
      const slot = pending.current[section];
      if (slot) window.clearTimeout(slot.timer);
      const timer = window.setTimeout(() => {
        delete pending.current[section];
        const patch = build();
        if (patch) void save(section, patch);
      }, TYPING_SETTLE_MS);
      pending.current[section] = { timer, build };
    },
    [save],
  );

  /** Sends every debounced edit now — the drawer is closing. */
  const flushPending = useCallback(() => {
    for (const [section, slot] of Object.entries(pending.current)) {
      if (!slot) continue;
      window.clearTimeout(slot.timer);
      const patch = slot.build();
      if (patch) void save(section as SectionId, patch);
    }
    pending.current = {};
  }, [save]);

  const requestClose = useCallback(() => {
    flushPending();
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setClosing(true);
    window.setTimeout(onClose, CLOSE_ANIMATION_MS);
  }, [flushPending, onClose]);

  const checkForUpdates = async (): Promise<void> => {
    setCheckingUpdates(true);
    setUpdateStatus(null);
    try {
      const result = await postUpdateCheck();
      window.dispatchEvent(new Event("brain-check-updates"));
      setUpdateStatus(
        result.appUpdate
          ? "Update available — use the notification at the lower left to install it."
          : result.selfUpdateEnabled === false
            ? `Update checks are switched off on this deployment (launched with --no-self-update), so nothing was checked — v${result.version} is running, but a newer release may exist. Update it the way it was installed.`
            : `You are on the latest version (v${result.version}).`,
      );
    } catch (error) {
      setUpdateStatus(errorMessage(error));
    } finally {
      setCheckingUpdates(false);
    }
  };

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
        setGateAutoApprove(s.gateAutoApprove !== false);
        setReviewMaxRounds(
          s.review?.maxRounds !== undefined ? String(s.review.maxRounds) : "",
        );
        setPanelSize(s.panel?.size !== undefined ? String(s.panel.size) : "");
        setInterdisciplinarySeat(s.panel?.interdisciplinarySeat !== false);
        setAutoResume(s.creditRecovery.autoResume);
        setResumeInterrupted(s.interruptedRecovery?.autoResume ?? true);
        setSafetyBufferSeconds(String(s.creditRecovery.safetyBufferSeconds));
        setOpenRouterModel(s.creditRecovery.openRouterModel);
        setUpdateCheck(s.updateCheck ?? "notify");
        if (s.hostTools?.enabledToolIds) {
          setEnabledHostTools([...s.hostTools.enabledToolIds]);
        }
        setWebProvider(s.webSearch?.provider ?? "none");
        setSearxngBaseUrl(s.webSearch?.searxngBaseUrl ?? "");
        setWebScholarly(s.webSearch?.scholarly !== false);
        setWebCacheEnabled(s.webSearch?.cacheEnabled === true);
        setWebContactEmail(s.webSearch?.contactEmail ?? "");
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
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    drawerRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Anything still debounced when the component goes away must not be lost.
  useEffect(() => flushPending, [flushPending]);

  /* ------------------------------------------------------ section payloads */

  /**
   * The model connection as the drawer currently shows it, WITHOUT any secret.
   * Secrets travel only through their own Save button, so changing the model
   * never submits a half-typed key sitting in the field next to it.
   *
   * `modelsByRoute` is deliberately omitted: the composer's per-task-type picker
   * writes the same field through its own endpoint, and re-sending a copy
   * captured when this drawer opened would silently revert its edits.
   */
  const agentSdkPatch = (): AgentSdkPatch => ({
    maxTurns: Number(agentMaxTurns),
    effort: agentEffort,
    thinking: agentThinking,
    ...(agentMaxBudgetUsd.trim() !== ""
      ? { maxBudgetUsd: Number(agentMaxBudgetUsd) }
      : {}),
    ...(agentFallbackModel.trim()
      ? { fallbackModel: agentFallbackModel.trim() }
      : {}),
  });

  const llmPatch = (): LlmPatch => ({
    provider,
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(provider === "anthropic" && baseUrl.trim()
      ? { baseUrl: baseUrl.trim() }
      : {}),
    agentSdk: agentSdkPatch(),
  });

  /** Validates the shared agent-SDK knobs; null means "do not send". */
  const agentSdkValid = (): boolean => {
    const turns = Number(agentMaxTurns);
    if (!Number.isSafeInteger(turns) || turns < 1 || turns > 500) {
      reject("model", "Max turns must be an integer from 1 to 500.");
      return false;
    }
    if (agentMaxBudgetUsd.trim() !== "") {
      const budget = Number(agentMaxBudgetUsd);
      if (!Number.isFinite(budget) || budget <= 0) {
        reject("model", "Max budget must be a positive USD amount.");
        return false;
      }
    }
    return true;
  };

  const saveModelSection = () => {
    if (!agentSdkValid()) return;
    void save("model", { llm: llmPatch() });
  };

  /**
   * The GPU template IS the on/off switch for the gpu_run tool, so the template
   * and the enabled-tool list are one payload: saved apart, an emptied template
   * could leave an enabled tool with nothing behind it.
   */
  const gpuPatch = (): ServerSettingsUpdate | null => {
    const configured = gpuTemplate.trim() !== "";
    if (configured && !gpuTemplate.includes(GPU_COMMAND_TAG)) {
      reject("gpu", `The template must contain ${GPU_COMMAND_TAG}.`);
      return null;
    }
    const minutes = Number.parseInt(gpuTimeLimit, 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      reject("gpu", "Time limit must be between 1 and 1440 minutes.");
      return null;
    }
    const toolIds = configured
      ? [...new Set([...enabledHostTools, "gpu_run"])]
      : enabledHostTools.filter((id) => id !== "gpu_run");
    return {
      gpu: { template: gpuTemplate, timeLimitMinutes: minutes },
      hostTools: { enabledToolIds: toolIds },
    };
  };

  const saveTools = (toolIds: readonly string[]) => {
    setEnabledHostTools([...toolIds]);
    void save("tools", { hostTools: { enabledToolIds: [...toolIds] } }).then(
      (saved) => {
        // The server enables attachment_search alongside attachment_read, so the
        // stored list can differ from the one submitted; follow it.
        if (saved?.hostTools?.enabledToolIds) {
          setEnabledHostTools([...saved.hostTools.enabledToolIds]);
        }
      },
    );
  };

  /** The recovery section as shown, without the OpenRouter key. */
  const creditRecoveryPatch = (): CreditRecoveryPatch | null => {
    const buffer = Number(safetyBufferSeconds);
    if (!Number.isSafeInteger(buffer) || buffer < 0 || buffer > 3600) {
      reject("recovery", "Safety buffer must be 0 to 3600 seconds.");
      return null;
    }
    if (openRouterModel.trim() === "") {
      reject("recovery", "OpenRouter model must not be empty.");
      return null;
    }
    return {
      autoResume,
      safetyBufferSeconds: buffer,
      openRouterModel: openRouterModel.trim(),
    };
  };

  const recoveryPatch = (): ServerSettingsUpdate | null => {
    const creditRecovery = creditRecoveryPatch();
    if (!creditRecovery) return null;
    return {
      interruptedRecovery: { autoResume: resumeInterrupted },
      creditRecovery,
    };
  };

  /** Saves one credential: the only payload that carries a secret. */
  const saveCredential = async (): Promise<void> => {
    const secret =
      provider === "anthropic"
        ? { apiKey: apiKey.trim() }
        : provider === "claude-agent"
          ? { setupToken: setupToken.trim() }
          : { cursorApiKey: cursorApiKey.trim() };
    if (Object.values(secret)[0] === "") return;
    if (!agentSdkValid()) return;
    setConnectionMessage(null);
    const saved = await save("credential", { llm: { ...llmPatch(), ...secret } });
    if (!saved) return;
    setApiKey("");
    setSetupToken("");
    setCursorApiKey("");
    setConnectionMessage(
      provider === "anthropic"
        ? `Connected to ${saved.llm.model}.`
        : provider === "claude-agent"
          ? `Claude Agent SDK token verified${saved.llm.model ? ` with ${saved.llm.model}` : ""}.`
          : `Cursor API key verified${saved.llm.model ? ` with ${saved.llm.model}` : ""}.`,
    );
  };

  const secretValue =
    provider === "anthropic"
      ? apiKey
      : provider === "claude-agent"
        ? setupToken
        : cursorApiKey;

  /** Save button next to a credential input: spins, then settles into a check. */
  const CredentialSave = () => (
    <div className="credential-actions">
      <button
        type="button"
        className="btn btn-primary btn-small"
        disabled={secretValue.trim() === "" || saveState.credential === "saving"}
        onClick={() => void saveCredential()}
      >
        {saveState.credential === "saving" ? "Verifying…" : "Save"}
      </button>
      <SaveStatus state={saveState.credential} error={saveError.credential} />
    </div>
  );

  return (
    <>
      <div
        className={`drawer-overlay${closing ? " drawer-overlay-closing" : ""}`}
        onClick={requestClose}
        aria-hidden
      />
      <div
        className={`drawer${closing ? " drawer-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="settings"
        ref={drawerRef}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <h2>Settings</h2>
          <div className="drawer-head-actions">
            <span className="dim small">changes save as you make them</span>
            <button
              type="button"
              className="ghost-btn"
              aria-label="close settings"
              onClick={requestClose}
            >
              <XIcon />
            </button>
          </div>
        </div>

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
                    onChange={(e) => {
                      const next = e.target.value as "off" | "notify";
                      setUpdateCheck(next);
                      void save("updates", { updateCheck: next });
                    }}
                  >
                    <option value="notify">notify automatically</option>
                    <option value="off">manual checks only</option>
                  </select>
                </div>
                <SaveStatus state={saveState.updates} error={saveError.updates} />
              </div>
              {updateStatus && <span className="field-note">{updateStatus}</span>}
            </section>

            <Section
              title="Execution"
              state={saveState.execution}
              error={saveError.execution}
            >
              <div className="field">
                <label className="field-label" htmlFor="settings-runner">
                  Runner
                </label>
                <select
                  id="settings-runner"
                  value={runner}
                  onChange={(e) => {
                    const next = e.target.value as RunnerKind;
                    setRunner(next);
                    void save("execution", { runner: next });
                  }}
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
                  onBlur={() => {
                    if (template === loaded.slurmTemplate) return;
                    if (!template.includes(SLURM_COMMAND_TAG)) {
                      reject("execution", `The template must contain ${SLURM_COMMAND_TAG}.`);
                      return;
                    }
                    void save("execution", { slurmTemplate: template });
                  }}
                  spellCheck={false}
                />
                <span className="field-note">
                  Put <code>{SLURM_COMMAND_TAG}</code> where the orchestration command
                  must run. Saved when you click away from the box.
                </span>
              </div>
            </Section>

            <Section
              title="GPU runs"
              summary={gpuTemplate.trim() !== "" ? "on" : "off"}
              state={saveState.gpu}
              error={saveError.gpu}
            >
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
                  onBlur={() => {
                    if (gpuTemplate === (loaded.gpu?.template ?? "")) return;
                    const patch = gpuPatch();
                    if (patch) void save("gpu", patch);
                  }}
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
                  onChange={(e) => {
                    setGpuTimeLimit(e.target.value);
                    saveSoon("gpu", gpuPatch);
                  }}
                />
                <span className="field-note">
                  Hard ceiling enforced at submission; an agent may request less, never more.
                </span>
              </div>
            </Section>

            <Section title="Brain Registry">
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
            </Section>

            <Section
              title="Model connection"
              defaultOpen
              state={saveState.model}
              error={saveError.model}
            >
              <div className="field">
                <label className="field-label" htmlFor="settings-provider">
                  Provider
                </label>
                <select
                  id="settings-provider"
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value as Provider;
                    let nextModel = model;
                    if (
                      (next === "claude-agent" || next === "cursor-agent") &&
                      next !== provider
                    ) {
                      nextModel = "";
                      setModel("");
                      setBaseUrl("");
                    } else if (
                      next === "anthropic" &&
                      provider !== "anthropic" &&
                      model.trim() === ""
                    ) {
                      nextModel = "claude-sonnet-5";
                      setModel(nextModel);
                    }
                    setProvider(next);
                    setConnectionMessage(null);
                    // Switching to a provider whose credential is already
                    // verified applies immediately; one that still needs a key
                    // is refused here and saves with the key below.
                    void save("model", {
                      llm: {
                        provider: next,
                        ...(nextModel.trim() ? { model: nextModel.trim() } : {}),
                        agentSdk: agentSdkPatch(),
                      },
                    });
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
                    <div className="field-with-action">
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
                        }}
                      />
                      <CredentialSave />
                    </div>
                    <span className="field-note">
                      {loaded.llm.apiKeyConfigured
                        ? "A verified key is configured. It is never returned to this page."
                        : "Saving tests the key with Anthropic first; nothing is stored if it fails."}
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
                        saveSoon("model", () =>
                          e.target.value.trim() === "" ? null : { llm: llmPatch() },
                        );
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
                      }}
                      onBlur={() => {
                        if (baseUrl.trim() === (loaded.llm.baseUrl ?? "")) return;
                        saveModelSection();
                      }}
                    />
                    <span className="field-note">
                      Changing the model or base URL re-tests the connection with the
                      stored key; nothing is persisted if it fails.
                    </span>
                  </div>
                </>
              )}
              {provider === "claude-agent" && (
                <div className="field">
                  <label className="field-label" htmlFor="settings-setup-token">
                    Setup token
                  </label>
                  <div className="field-with-action">
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
                      }}
                    />
                    <CredentialSave />
                  </div>
                  <span className="field-note">
                    Run <code>claude setup-token</code> in a terminal, complete the
                    browser flow, and paste the printed token here. Saving tests it
                    and never returns it to the browser.
                  </span>
                </div>
              )}
              {provider === "cursor-agent" && (
                <div className="field">
                  <label className="field-label" htmlFor="settings-cursor-key">
                    Cursor API key
                  </label>
                  <div className="field-with-action">
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
                      }}
                    />
                    <CredentialSave />
                  </div>
                  <span className="field-note">
                    Create a key at cursor.com/dashboard (Integrations → API keys, or a
                    team service account) and paste it here. Saving tests it and never
                    returns it to the browser.
                  </span>
                </div>
              )}
              {connectionMessage && (
                <p className="success-text">{connectionMessage}</p>
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
                      }}
                      onBlur={() => {
                        if (model.trim() === (loaded.llm.model ?? "")) return;
                        saveModelSection();
                      }}
                    />
                    <span className="field-note">
                      Changing the model performs a real one-turn Agent SDK request.
                      The same execution settings below apply to both agent SDKs, so
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
                        onChange={(e) => {
                          setAgentMaxTurns(e.target.value);
                          saveSoon("model", () => ({ llm: llmPatch() }));
                        }}
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
                        onChange={(e) => {
                          setAgentMaxBudgetUsd(e.target.value);
                          saveSoon("model", () => ({ llm: llmPatch() }));
                        }}
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
                        onChange={(e) => {
                          setAgentEffort(
                            e.target.value as "low" | "medium" | "high" | "xhigh" | "max",
                          );
                          void save("model", {
                            llm: {
                              ...llmPatch(),
                              agentSdk: {
                                ...agentSdkPatch(),
                                effort: e.target.value as
                                  | "low"
                                  | "medium"
                                  | "high"
                                  | "xhigh"
                                  | "max",
                              },
                            },
                          });
                        }}
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
                        onChange={(e) => {
                          const next = e.target.value as "adaptive" | "disabled";
                          setAgentThinking(next);
                          void save("model", {
                            llm: {
                              ...llmPatch(),
                              agentSdk: { ...agentSdkPatch(), thinking: next },
                            },
                          });
                        }}
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
                      onChange={(e) => {
                        setAgentFallbackModel(e.target.value);
                        saveSoon("model", () => ({ llm: llmPatch() }));
                      }}
                    />
                  </div>
                </>
              )}
            </Section>

            <Section
              title="Panel confirmation"
              state={saveState.confirmation}
              error={saveError.confirmation}
            >
              <label className="radio-row">
                <input
                  type="radio"
                  name="panel-confirmation"
                  checked={confirmation === "manual"}
                  onChange={() => {
                    setConfirmation("manual");
                    void save("confirmation", { panelConfirmation: "manual" });
                  }}
                />
                Ask me on the dashboard
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="panel-confirmation"
                  checked={confirmation === "auto"}
                  onChange={() => {
                    setConfirmation("auto");
                    void save("confirmation", { panelConfirmation: "auto" });
                  }}
                />
                Approve automatically
              </label>
              {confirmation === "auto" && !gateAutoApprove && (
                <span className="field-note">
                  Waiting for you wins while the countdown below is off: new runs
                  will still stop and ask. This choice takes effect again as soon
                  as you switch it back on.
                </span>
              )}
              <h3 className="drawer-subhead">If I do not answer</h3>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={gateAutoApprove}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setGateAutoApprove(next);
                    void save("confirmation", { gateAutoApprove: next });
                  }}
                />
                Continue on my behalf after a short countdown
              </label>
              <span className="field-note">
                Both places a run asks for you — the reading of your submission and
                the panel — count down about 30 seconds and then proceed with what
                the pipeline proposed, so an unattended run never stalls. Switch this
                off and every gate waits for you instead, however long that takes.
                <strong> This applies immediately to runs already in progress</strong>,
                including a run that has passed the first gate and not yet reached the
                second; any countdown already on screen stops at once.
              </span>
            </Section>

            <Section
              title="Review rounds"
              state={saveState.review}
              error={saveError.review}
            >
              <div className="field">
                <label className="field-label" htmlFor="settings-review-rounds">
                  Rounds one chain step may take
                </label>
                <select
                  id="settings-review-rounds"
                  value={reviewMaxRounds}
                  onChange={(e) => {
                    const next = e.target.value;
                    setReviewMaxRounds(next);
                    void save("review", {
                      review: next === "" ? {} : { maxRounds: Number(next) },
                    });
                  }}
                >
                  <option value="">Bundle default</option>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>
                      {n} round{n === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
                <span className="field-note">
                  The first review plus up to N−1 revisions per chain step. Applies
                  to every NEW run (running and finished runs keep the budget they
                  started with). Higher values review more strictly and spend more;
                  &quot;Bundle default&quot; follows the published workflow.
                </span>
              </div>
            </Section>

            <Section
              title="Panel"
              state={saveState.panel}
              error={saveError.panel}
            >
              <div className="field">
                <label className="field-label" htmlFor="settings-panel-size">
                  Seats on the review panel
                </label>
                <select
                  id="settings-panel-size"
                  value={panelSize}
                  onChange={(e) => {
                    const next = e.target.value;
                    setPanelSize(next);
                    void save("panel", {
                      panel: {
                        ...(next !== "" ? { size: Number(next) } : {}),
                        ...(interdisciplinarySeat === false
                          ? { interdisciplinarySeat: false }
                          : {}),
                      },
                    });
                  }}
                >
                  <option value="">Bundle default</option>
                  {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={String(n)}>
                      {n} seats
                    </option>
                  ))}
                </select>
                <span className="field-note">
                  How many expert seats the panel selection may produce. Applies to
                  every NEW run (running runs keep the panel they started with).
                  More seats read the submission from more fields and spend more.
                </span>
              </div>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={interdisciplinarySeat}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setInterdisciplinarySeat(next);
                    void save("panel", {
                      panel: {
                        ...(panelSize !== "" ? { size: Number(panelSize) } : {}),
                        ...(next === false ? { interdisciplinarySeat: false } : {}),
                      },
                    });
                  }}
                />
                <span>Interdisciplinary seat</span>
              </label>
              <span className="field-note">
                One extra woven seat whose expertise is the space between the
                selected fields. It develops, is reviewed, and redevelops like
                every other member. Applies to every NEW run.
              </span>
            </Section>

            <Section
              title="Capabilities & host tools"
              state={saveState.tools}
              error={saveError.tools}
            >
              <span className="field-note" style={{ marginBottom: "0.5rem", display: "block" }}>
                Tools that run on your machine. Uncheck to disable a capability for all pipeline roles.
              </span>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={
                    enabledHostTools.includes("attachment_list") &&
                    enabledHostTools.includes("attachment_read")
                  }
                  onChange={(e) =>
                    saveTools(
                      e.target.checked
                        ? [
                            ...new Set([
                              ...enabledHostTools,
                              "attachment_list",
                              "attachment_read",
                              "attachment_search",
                            ]),
                          ]
                        : enabledHostTools.filter(
                            (id) =>
                              id !== "attachment_list" &&
                              id !== "attachment_read" &&
                              id !== "attachment_search",
                          ),
                    )
                  }
                />
                Attachment access (list, read, and search submission files)
              </label>
              <span className="field-note" style={{ display: "block" }}>
                Web search and web fetch always run through the app's own
                unified search pipeline — never a model provider's built-in
                search — and are configured in the Web search section below.
              </span>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={enabledHostTools.includes("code_execute")}
                  onChange={(e) =>
                    saveTools(
                      e.target.checked
                        ? [...new Set([...enabledHostTools, "code_execute"])]
                        : enabledHostTools.filter((id) => id !== "code_execute"),
                    )
                  }
                />
                Code execution (host scratch workspace; providers with native
                execution keep using it)
              </label>
            </Section>

            <Section
              title="Web search"
              state={saveState.webSearch}
              error={saveError.webSearch}
            >
              <span className="field-note" style={{ display: "block", marginBottom: "0.5rem" }}>
                Every agent's web search runs through the app's own pipeline:
                one manager routes each query to the providers below, runs
                searches in parallel, and writes every request and answer —
                verbatim — to the run's search log. Model providers' built-in
                search is never used.
              </span>
              <div className="field">
                <label className="field-label" htmlFor="settings-web-provider">
                  General web search provider
                </label>
                <select
                  id="settings-web-provider"
                  value={webProvider}
                  onChange={(e) => {
                    const next = e.target.value as
                      | "none"
                      | "tavily"
                      | "brave"
                      | "searxng"
                      | "searxng-local";
                    setWebProvider(next);
                    // Selecting a keyed provider is completed by its Save
                    // button below; only keyless selections save on change.
                    if (
                      next === "none" ||
                      next === "searxng-local" ||
                      (next === "tavily" && loaded?.webSearch?.tavilyKeyConfigured) ||
                      (next === "brave" && loaded?.webSearch?.braveKeyConfigured)
                    ) {
                      void save("webSearch", {
                        webSearch: {
                          provider: next,
                          ...(searxngBaseUrl.trim() !== ""
                            ? { searxngBaseUrl: searxngBaseUrl.trim() }
                            : {}),
                          scholarly: webScholarly,
                          cacheEnabled: webCacheEnabled,
                          ...(webContactEmail.trim() !== ""
                            ? { contactEmail: webContactEmail.trim() }
                            : {}),
                        },
                      });
                    }
                  }}
                >
                  <option value="none">None (scholarly indexes only)</option>
                  <option value="searxng-local">
                    SearXNG — launched by the app on this machine (keyless)
                  </option>
                  <option value="tavily">Tavily (agent search API)</option>
                  <option value="brave">Brave Search API</option>
                  <option value="searxng">SearXNG (your own instance)</option>
                </select>
                <span className="field-note">
                  Answers "general" and "news" queries. Scholarly queries
                  (papers, citations) use the keyless scholarly indexes below
                  either way.
                </span>
              </div>
              {webProvider === "searxng-local" && (
                <span className="field-note" style={{ display: "block" }}>
                  The app starts and supervises a private SearXNG search
                  service on this deployment's own machine (needs Docker,
                  Podman, or Apptainer). No key, and no query ever passes a
                  third-party search API. The first start downloads the search
                  image and can take a few minutes; the Agent capabilities
                  readiness check turns green once it is up.
                </span>
              )}
              {webProvider === "tavily" && (
                <div className="field">
                  <label className="field-label" htmlFor="settings-tavily-key">
                    Tavily API key
                  </label>
                  <div className="field-with-action">
                    <input
                      id="settings-tavily-key"
                      type="password"
                      value={tavilyApiKey}
                      autoComplete="new-password"
                      placeholder={
                        loaded.webSearch?.tavilyKeyConfigured
                          ? "Verified key saved — enter a new key to replace it"
                          : "tvly-… from app.tavily.com"
                      }
                      onChange={(e) => setTavilyApiKey(e.target.value)}
                    />
                    <div className="credential-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        disabled={
                          tavilyApiKey.trim() === "" ||
                          saveState.webSearch === "saving"
                        }
                        onClick={() => {
                          void save("webSearch", {
                            webSearch: {
                              provider: "tavily",
                              scholarly: webScholarly,
                              cacheEnabled: webCacheEnabled,
                              ...(webContactEmail.trim() !== ""
                                ? { contactEmail: webContactEmail.trim() }
                                : {}),
                              tavilyApiKey: tavilyApiKey.trim(),
                            },
                          }).then((saved) => {
                            if (saved) setTavilyApiKey("");
                          });
                        }}
                      >
                        {saveState.webSearch === "saving" ? "Verifying…" : "Save"}
                      </button>
                    </div>
                  </div>
                  <span className="field-note">
                    Verified with one real search before saving; never returned
                    to the browser.
                  </span>
                </div>
              )}
              {webProvider === "brave" && (
                <div className="field">
                  <label className="field-label" htmlFor="settings-brave-key">
                    Brave Search API key
                  </label>
                  <div className="field-with-action">
                    <input
                      id="settings-brave-key"
                      type="password"
                      value={braveApiKey}
                      autoComplete="new-password"
                      placeholder={
                        loaded.webSearch?.braveKeyConfigured
                          ? "Verified key saved — enter a new key to replace it"
                          : "From api-dashboard.search.brave.com"
                      }
                      onChange={(e) => setBraveApiKey(e.target.value)}
                    />
                    <div className="credential-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        disabled={
                          braveApiKey.trim() === "" ||
                          saveState.webSearch === "saving"
                        }
                        onClick={() => {
                          void save("webSearch", {
                            webSearch: {
                              provider: "brave",
                              scholarly: webScholarly,
                              cacheEnabled: webCacheEnabled,
                              ...(webContactEmail.trim() !== ""
                                ? { contactEmail: webContactEmail.trim() }
                                : {}),
                              braveApiKey: braveApiKey.trim(),
                            },
                          }).then((saved) => {
                            if (saved) setBraveApiKey("");
                          });
                        }}
                      >
                        {saveState.webSearch === "saving" ? "Verifying…" : "Save"}
                      </button>
                    </div>
                  </div>
                  <span className="field-note">
                    Verified with one real search before saving; never returned
                    to the browser.
                  </span>
                </div>
              )}
              {webProvider === "searxng" && (
                <div className="field">
                  <label className="field-label" htmlFor="settings-searxng-url">
                    SearXNG base URL
                  </label>
                  <div className="field-with-action">
                    <input
                      id="settings-searxng-url"
                      type="text"
                      value={searxngBaseUrl}
                      placeholder="https://searx.example.org"
                      onChange={(e) => setSearxngBaseUrl(e.target.value)}
                    />
                    <div className="credential-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        disabled={
                          searxngBaseUrl.trim() === "" ||
                          saveState.webSearch === "saving"
                        }
                        onClick={() => {
                          void save("webSearch", {
                            webSearch: {
                              provider: "searxng",
                              searxngBaseUrl: searxngBaseUrl.trim(),
                              scholarly: webScholarly,
                              cacheEnabled: webCacheEnabled,
                              ...(webContactEmail.trim() !== ""
                                ? { contactEmail: webContactEmail.trim() }
                                : {}),
                            },
                          });
                        }}
                      >
                        {saveState.webSearch === "saving" ? "Verifying…" : "Save"}
                      </button>
                    </div>
                  </div>
                  <span className="field-note">
                    Your self-hosted instance, keyless. Verified with one real
                    search before saving.
                  </span>
                </div>
              )}
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={webScholarly}
                  onChange={(e) => {
                    setWebScholarly(e.target.checked);
                    void save("webSearch", {
                      webSearch: {
                        provider: webProvider,
                        ...(searxngBaseUrl.trim() !== ""
                          ? { searxngBaseUrl: searxngBaseUrl.trim() }
                          : {}),
                        scholarly: e.target.checked,
                        cacheEnabled: webCacheEnabled,
                        ...(webContactEmail.trim() !== ""
                          ? { contactEmail: webContactEmail.trim() }
                          : {}),
                      },
                    });
                  }}
                />
                Scholarly indexes (OpenAlex, Crossref, arXiv, Semantic Scholar)
              </label>
              <span className="field-note">
                Keyless and on by default — paper and citation searches answer
                from these with DOIs, authors, venues, and citation counts.
              </span>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={webCacheEnabled}
                  onChange={(e) => {
                    setWebCacheEnabled(e.target.checked);
                    void save("webSearch", {
                      webSearch: {
                        provider: webProvider,
                        ...(searxngBaseUrl.trim() !== ""
                          ? { searxngBaseUrl: searxngBaseUrl.trim() }
                          : {}),
                        scholarly: webScholarly,
                        cacheEnabled: e.target.checked,
                        ...(webContactEmail.trim() !== ""
                          ? { contactEmail: webContactEmail.trim() }
                          : {}),
                      },
                    });
                  }}
                />
                Cache keyword results across runs (24h)
              </label>
              <span className="field-note">
                The same keyword asked twice — by two seats or two runs — costs
                one upstream call. Cache hits still appear in the search log.
              </span>
              <div className="field">
                <label className="field-label" htmlFor="settings-web-contact">
                  Contact email <span className="dim">(optional)</span>
                </label>
                <input
                  id="settings-web-contact"
                  type="text"
                  value={webContactEmail}
                  placeholder="you@example.org — polite-pool contact for OpenAlex/Crossref"
                  onChange={(e) => {
                    setWebContactEmail(e.target.value);
                    saveSoon("webSearch", () => {
                      const email = webContactEmail;
                      void email;
                      const trimmed = e.target.value.trim();
                      if (trimmed !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
                        return null;
                      }
                      return {
                        webSearch: {
                          provider: webProvider,
                          ...(searxngBaseUrl.trim() !== ""
                            ? { searxngBaseUrl: searxngBaseUrl.trim() }
                            : {}),
                          scholarly: webScholarly,
                          cacheEnabled: webCacheEnabled,
                          ...(trimmed !== "" ? { contactEmail: trimmed } : {}),
                        },
                      };
                    });
                  }}
                />
                <span className="field-note">
                  Shared with the scholarly indexes' polite pools for faster,
                  more reliable answers. Never required.
                </span>
              </div>
            </Section>

            <Section
              title="Recovery"
              state={saveState.recovery}
              error={saveError.recovery}
            >
              <h3 className="drawer-subhead">Interrupted jobs</h3>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={resumeInterrupted}
                  onChange={(e) => {
                    setResumeInterrupted(e.target.checked);
                    void save("recovery", {
                      interruptedRecovery: { autoResume: e.target.checked },
                    });
                  }}
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
                  onChange={(e) => {
                    setAutoResume(e.target.checked);
                    const creditRecovery = creditRecoveryPatch();
                    if (creditRecovery) {
                      void save("recovery", {
                        interruptedRecovery: { autoResume: resumeInterrupted },
                        creditRecovery: {
                          ...creditRecovery,
                          autoResume: e.target.checked,
                        },
                      });
                    }
                  }}
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
                    onChange={(e) => {
                      setSafetyBufferSeconds(e.target.value);
                      saveSoon("recovery", recoveryPatch);
                    }}
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
                    onChange={(e) => {
                      setOpenRouterModel(e.target.value);
                      saveSoon("recovery", recoveryPatch);
                    }}
                  />
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="settings-openrouter-key">
                  OpenRouter API key <span className="dim">(optional)</span>
                </label>
                <div className="field-with-action">
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
                  <div className="credential-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-small"
                      disabled={
                        openRouterApiKey.trim() === "" ||
                        saveState.recovery === "saving"
                      }
                      onClick={() => {
                        const creditRecovery = creditRecoveryPatch();
                        if (!creditRecovery) return;
                        void save("recovery", {
                          interruptedRecovery: { autoResume: resumeInterrupted },
                          creditRecovery: {
                            ...creditRecovery,
                            openRouterApiKey: openRouterApiKey.trim(),
                          },
                        }).then((saved) => {
                          if (saved) setOpenRouterApiKey("");
                        });
                      }}
                    >
                      {saveState.recovery === "saving" ? "Verifying…" : "Save"}
                    </button>
                  </div>
                </div>
                <span className="field-note">
                  Known Claude reset messages are parsed locally first. Unknown formats can be
                  sent with current time and timezone to <code>openrouter/free</code>. The key is
                  verified before saving and never returned to the browser.
                </span>
              </div>
            </Section>

            <Section title="Trash">
              <a
                className="btn drawer-trash-link"
                href="#/trash"
                onClick={requestClose}
              >
                <TrashIcon size={14} />
                View trashed jobs
              </a>
              <span className="field-note">
                Stopped jobs moved to trash leave the job list but stay
                readable.
              </span>
            </Section>
          </>
        )}
      </div>
    </>
  );
}
