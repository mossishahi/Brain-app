/**
 * The centered settings workspace behind the gear icon.
 *
 * Every section saves ON ITS OWN. There is no dialog-wide Save button, because
 * one existed and made every edit look like a credential change: changing the
 * review-round budget re-sent the whole document, the server re-tested the
 * Claude token to persist it, and seconds later the dialog announced "token
 * verified" as though that had been the edit.
 *
 * So: a control that carries no risk saves as you leave it (selects and
 * switches at once, typed values shortly after you stop typing), and each one
 * reports back in its own section. A credential is the exception — it costs a
 * real request to the provider — so it keeps an explicit Save beside the input
 * that spins while the connection is tested and settles into a check.
 */
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { LuKeyRound, LuWorkflow, LuFlaskConical, LuGlobe, LuCpu, LuRotateCcw, LuDownload, LuPalette } from "react-icons/lu";
import {
  SLURM_COMMAND_TAG,
} from "@brainstorm-agentic/protocol";
import type {
  RunnerKind,
  ServerSettings,
  ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";
import { errorMessage, getHealth, getSettings, postUpdateCheck, useModelOptions } from "../api";
import { TrashIcon, XIcon } from "./Icons";
import { categorySections, settingsCategories, settingsCategory, type SettingsCategory } from "./settings/catalog";
import { SettingsCategoryContext, SettingsSection as Section, SaveStatus } from "./settings/SettingsSection";
import { useSettingsSaves } from "./settings/useSettingsSaves";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { PanelCompositionSettings } from "./settings/PanelCompositionSettings";
import { ToolsAndProviders } from "./settings/ToolsAndProviders";
import { SettingsToggle } from "./settings/SettingsToggle";
import { RunCapabilitiesSettings } from "./settings/RunCapabilitiesSettings";
import { TaskModelsSettings } from "./settings/TaskModelsSettings";
import { findModel } from "./settings/stage-models-model";
import { GpuSetupControl } from "../features/gpu/GpuSetup";
import { ToolReadinessSettings } from "./settings/ToolReadinessSettings";
import { approvalPreferenceDescription, askBeforeApprovalLabel } from "./settings/approval-preference";
import "./settings/settings.css";
export type { SettingsCategory } from "./settings/catalog";

const categoryIcons = { connections: LuKeyRound, stageModels: LuWorkflow, research: LuFlaskConical, tools: LuGlobe, execution: LuCpu, recovery: LuRotateCcw, updates: LuDownload, appearance: LuPalette };

type Provider = "anthropic" | "claude-agent" | "cursor-agent" | "gemini" | "offline";
const providerLabels: Record<Provider, string> = { anthropic: "Anthropic API", "claude-agent": "Claude Agent SDK", "cursor-agent": "Cursor SDK", gemini: "Gemini API", offline: "Offline" };

/**
 * The sections of an update, non-optional. Every field of ServerSettingsUpdate
 * is optional (absent = keep stored), so a payload has to be built through
 * these to keep its own required fields — a spread of the optional type would
 * quietly drop `provider`.
 */
type LlmPatch = NonNullable<ServerSettingsUpdate["llm"]>;
type AgentSdkPatch = NonNullable<LlmPatch["agentSdk"]>;
type CreditRecoveryPatch = NonNullable<ServerSettingsUpdate["creditRecovery"]>;

export function SettingsDrawer({ onClose, initialSection }: { onClose: () => void; initialSection?: string }) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(() => settingsCategory(initialSection));
  const [dialogOpen, setDialogOpen] = useState(true);
  const [closing, setClosing] = useState(false);
  const [closeWarning, setCloseWarning] = useState<string | null>(null);
  const closeRequested = useRef(false);
  const draftPresent = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const [loaded, setLoaded] = useState<ServerSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const { save, reject, reset, saveSoon, flushPending, saveState, saveError, builders } = useSettingsSaves((settings) => {
    setLoaded(settings);
  });

  const [runner, setRunner] = useState<RunnerKind>("slurm");
  const [template, setTemplate] = useState("");
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
  const modelOptions = useModelOptions().value;
  const defaultCapabilities = modelOptions?.provider === provider
    ? findModel(modelOptions.models, model || modelOptions.defaults?.model || modelOptions.defaultModel)?.capabilities : undefined;
  const [apiKey, setApiKey] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [cursorApiKey, setCursorApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [transcript, setTranscript] = useState<"if-available" | "off" | undefined>();
  const [baseUrl, setBaseUrl] = useState("");
  const [agentMaxTurns, setAgentMaxTurns] = useState("100");
  const [agentMaxBudgetUsd, setAgentMaxBudgetUsd] = useState("");
  const [agentEffort, setAgentEffort] = useState<
    "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >("high");
  const [agentThinking, setAgentThinking] = useState<"adaptive" | "disabled">(
    "adaptive",
  );
  const [agentFallbackModel, setAgentFallbackModel] = useState("");
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const credentialContext = useRef(0);
  const credentialAttempt = useRef<number | null>(null);
  const [confirmation, setConfirmation] = useState<"manual" | "auto">("manual");
  const [gateAutoApprove, setGateAutoApprove] = useState(true);
  /** "" = follow the bundle's default; otherwise the override as a string. */
  const [reviewMaxRounds, setReviewMaxRounds] = useState<string>("");
  const [gamifiedReview, setGamifiedReview] = useState(false);
  const [gameThreshold, setGameThreshold] = useState("0.5");
  const [gamePointsMode, setGamePointsMode] = useState<"auto" | "custom">("auto");
  const [gameInitialPoints, setGameInitialPoints] = useState("100");
  const [gameDecisionRule, setGameDecisionRule] = useState<"committee-mean" | "chair-decisive">("chair-decisive");
  const [gameLeaveOneOut, setGameLeaveOneOut] = useState(true);
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
  /** Who searches: the app's coordinated tools, or each agent's own. */
  const [webMode, setWebMode] = useState<"host" | "agent">("host");
  /** The paid Brave Search API as the last source on every route. */
  const [braveFallbackEnabled, setBraveFallbackEnabled] = useState(false);
  const [braveMaxPerRun, setBraveMaxPerRun] = useState("300");
  const [braveMaxPerMonth, setBraveMaxPerMonth] = useState("1000");
  /** The fallback as the settings API takes it (caps parsed, blanks omitted). */
  const braveFallbackSettings = (
    enabled: boolean,
    perRun: string = braveMaxPerRun,
    perMonth: string = braveMaxPerMonth,
  ) => {
    const cap = (text: string): number | undefined => {
      const value = Number(text.trim());
      return text.trim() !== "" && Number.isInteger(value) && value >= 0 ? value : undefined;
    };
    const run = cap(perRun);
    const month = cap(perMonth);
    return {
      enabled,
      ...(run !== undefined ? { maxRequestsPerRun: run } : {}),
      ...(month !== undefined ? { maxRequestsPerMonth: month } : {}),
    };
  };

  /**
   * The two agent-SDK backends (Claude Agent SDK, Cursor SDK) share ONE
   * settings shape: the same turns/budget/effort/thinking/fallback controls
   * apply verbatim to whichever SDK is selected.
   */
  const isAgentSdk = provider === "claude-agent" || provider === "cursor-agent";
  const clearConnectionFeedback = () => {
    credentialContext.current += 1;
    reset("credential");
    reset("model");
    setConnectionMessage(null);
  };
  const canAutoSaveProvider = (candidate = provider) => candidate === "offline" || (candidate === "anthropic"
    ? loaded?.llm.apiKeyConfigured === true && apiKey.trim() === ""
    : candidate === "claude-agent"
      ? loaded?.llm.setupTokenConfigured === true && setupToken.trim() === ""
      : candidate === "gemini" ? loaded?.llm.geminiApiKeyConfigured === true && geminiApiKey.trim() === ""
        : loaded?.llm.cursorApiKeyConfigured === true && cursorApiKey.trim() === "");

  const requestClose = async (discardDrafts = false) => {
    if (closeRequested.current) return;
    closeRequested.current = true;
    setClosing(true);
    // Blur commits editors that intentionally save only after editing finishes.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    const allSaved = await flushPending();
    // Let successful saves update the draft comparison before asking to discard.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (!discardDrafts && (draftPresent.current || !allSaved)) {
      setCloseWarning(draftPresent.current
        ? "You have connection details that have not been saved. Keep editing to save them, or discard the draft."
        : "Some changes could not be saved. Keep editing to correct them, or close with the previous saved values.");
      setClosing(false);
      closeRequested.current = false;
      window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".settings-close-warning button")?.focus());
      return;
    }
    setDialogOpen(false);
  };

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
        setProvider(s.llm.provider);
        setTranscript(s.llm.transcript);
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
        setGamifiedReview(s.gamifiedReview === true);
        setGameThreshold(String(s.gameReview?.threshold ?? 0.5));
        setGamePointsMode(s.gameReview?.initialPoints === undefined ? "auto" : "custom");
        setGameInitialPoints(String(s.gameReview?.initialPoints ?? 100));
        setGameDecisionRule(s.gameReview?.decisionRule ?? "chair-decisive");
        setGameLeaveOneOut(s.gameReview?.leaveOneOut !== false);
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
        setWebMode(s.webSearch?.mode ?? "host");
        setBraveFallbackEnabled(s.webSearch?.braveFallback?.enabled === true);
        setBraveMaxPerRun(String(s.webSearch?.braveFallback?.maxRequestsPerRun ?? 300));
        setBraveMaxPerMonth(String(s.webSearch?.braveFallback?.maxRequestsPerMonth ?? 1000));
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

  /* ------------------------------------------------------ section payloads */

  const saveGameReview = (thresholdText = gameThreshold, pointsMode = gamePointsMode, pointsText = gameInitialPoints, decisionRule = gameDecisionRule, leaveOneOut = gameLeaveOneOut) => {
    const threshold = Number(thresholdText);
    const initialPoints = Number(pointsText);
    if (!thresholdText.trim() || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      reject("review", "The decision threshold must be between 0 and 1.");
      return;
    }
    if (pointsMode === "custom" && (!pointsText.trim() || !Number.isFinite(initialPoints) || initialPoints < 0)) {
      reject("review", "Starting points must be a nonnegative number.");
      return;
    }
    void save("review", { gameReview: { threshold, ...(pointsMode === "custom" ? { initialPoints } : {}), decisionRule, leaveOneOut } });
  };

  /**
   * The model connection as the drawer currently shows it, WITHOUT any secret.
   * Secrets travel only through their own Save button, so changing the model
   * never submits a half-typed key sitting in the field next to it.
   *
   * `modelsByRoute` is deliberately omitted: the task-model settings
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
    ...(transcript !== undefined ? { transcript } : {}),
    ...((provider === "anthropic" || provider === "gemini") && baseUrl.trim()
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
    if (!canAutoSaveProvider()) return;
    if (!agentSdkValid()) return;
    void save("model", { llm: llmPatch() });
  };

  const saveTools = (toolIds: readonly string[]) => {
    // GPU approval can change the server's allow-list while this dialog is
    // open. Apply only the user's toggle against fresh settings in the queue.
    const added = toolIds.filter(id => !enabledHostTools.includes(id));
    const removed = new Set(enabledHostTools.filter(id => !toolIds.includes(id)));
    setEnabledHostTools([...toolIds]);
    void save("tools", current => ({ hostTools: { enabledToolIds: [...new Set([...(current.hostTools?.enabledToolIds ?? []).filter(id => !removed.has(id)), ...added])] } })).then(
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

  // Builders read this render's complete draft, never the previous keystroke.
  builders.current = {
    recovery: recoveryPatch,
    model: () => {
      if (!canAutoSaveProvider()) return null;
      if (!agentSdkValid()) return null;
      if ((provider === "anthropic" || provider === "gemini") && model.trim() === "") {
        reject("model", "Enter a model name.");
        return null;
      }
      return { llm: llmPatch() };
    },
    webSearch: () => {
      const contactEmail = webContactEmail.trim();
      if (contactEmail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
        reject("webSearch", "Enter a valid contact email, or leave it empty.");
        return null;
      }
      return { webSearch: { provider: webProvider, contactEmail } };
    },
  };
  draftPresent.current = [apiKey, setupToken, cursorApiKey, geminiApiKey, tavilyApiKey, braveApiKey, openRouterApiKey].some((value) => value.trim() !== "")
    || (loaded !== null && provider !== loaded.llm.provider)
    || (loaded !== null && webProvider !== (loaded.webSearch?.provider ?? "none"))
    || (webProvider === "searxng" && (searxngBaseUrl.trim() !== (loaded?.webSearch?.searxngBaseUrl ?? "") || webProvider !== loaded?.webSearch?.provider));

  /** Saves one credential: the only payload that carries a secret. */
  const saveCredential = async (): Promise<void> => {
    if (credentialAttempt.current === credentialContext.current) return;
    const secret =
      provider === "anthropic"
        ? { apiKey: apiKey.trim() }
        : provider === "claude-agent"
          ? { setupToken: setupToken.replace(/\s+/g, "") }
          : provider === "gemini" ? { geminiApiKey: geminiApiKey.trim() } : { cursorApiKey: cursorApiKey.trim() };
    if (Object.values(secret)[0] === "") return;
    if (!agentSdkValid()) return;
    const context = credentialContext.current;
    credentialAttempt.current = context;
    reset("model");
    setConnectionMessage(null);
    const saved = await save("credential", { llm: { ...llmPatch(), ...secret } });
    if (credentialAttempt.current === context) credentialAttempt.current = null;
    if (!saved || credentialContext.current !== context) return;
    reset("model");
    // A provider switch or new draft during verification must not erase it.
    if (provider === "anthropic") setApiKey((current) => current === apiKey ? "" : current);
    if (provider === "claude-agent") setSetupToken((current) => current === setupToken ? "" : current);
    if (provider === "gemini") setGeminiApiKey((current) => current === geminiApiKey ? "" : current);
    if (provider === "cursor-agent") setCursorApiKey((current) => current === cursorApiKey ? "" : current);
    setConnectionMessage(
      provider === "anthropic"
        ? `Connected to ${saved.llm.model}.`
        : provider === "claude-agent"
          ? `Claude Agent SDK token verified${saved.llm.model ? ` with ${saved.llm.model}` : ""}.`
          : provider === "gemini" ? `Gemini model access verified${saved.llm.model ? ` with ${saved.llm.model}` : ""}.` : `Cursor API key verified${saved.llm.model ? ` with ${saved.llm.model}` : ""}.`,
    );
  };

  const secretValue =
    provider === "anthropic"
      ? apiKey
      : provider === "claude-agent"
        ? setupToken
        : provider === "gemini" ? geminiApiKey : cursorApiKey;

  /** Save button next to a credential input: spins, then settles into a check. */
  const credentialActions = (
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

  const category = settingsCategories.find((item) => item.id === activeCategory)!;
  return (
    <Dialog.Root open={dialogOpen} onOpenChange={(open) => { if (!open) void requestClose(); }} onOpenChangeComplete={(open) => { if (!open) { onClose(); afterClose.current?.(); } }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="settings-backdrop" />
        <Dialog.Popup className="settings-dialog" initialFocus={() => document.getElementById(`settings-category-${activeCategory}`)} finalFocus={() => document.getElementById("canvas-settings-trigger") ?? true}>
          <header className="settings-header">
            <div><Dialog.Title>Settings</Dialog.Title><Dialog.Description>Keep your workspace close.</Dialog.Description></div>
            <Dialog.Close className="settings-close" aria-label="Close settings"><XIcon /></Dialog.Close>
          </header>
          <div className="settings-layout">
            <nav className="settings-navigation" aria-label="Settings categories">
              {settingsCategories.map((item) => {
                const Icon = categoryIcons[item.id];
                const hasError = categorySections[item.id].some((section) => saveState[section] === "error");
                const saving = categorySections[item.id].some((section) => saveState[section] === "saving");
                return <button key={item.id} id={`settings-category-${item.id}`} type="button" aria-current={item.id === activeCategory ? "page" : undefined} className="settings-category" onClick={() => { setActiveCategory(item.id); afterClose.current = null; setCloseWarning(null); contentRef.current?.scrollTo({ top: 0 }); }}>
                  <Icon aria-hidden /><span>{item.label}</span>{hasError ? <span className="settings-category-error" aria-label="Changes not saved">!</span> : saving ? <span className="save-spinner" aria-label="Saving" /> : null}
                </button>;
              })}
            </nav>
            <div className="settings-content" ref={contentRef} aria-label={category.label}>
              <div className="settings-category-heading"><h2>{category.label}</h2><p>{category.description}</p></div>
              <SettingsCategoryContext.Provider value={activeCategory}>
                {activeCategory === "appearance" ? <AppearanceSettings /> : loadError ? <p className="error-text" role="alert">{loadError}</p> : !loaded ? <p className="dim" role="status">Loading settings…</p> : <>
            <Section category="updates" title="Application updates" state={saveState.updates} error={saveError.updates}>

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
              </div>
              {updateStatus && <span className="field-note" role="status">{updateStatus}</span>}
            </Section>

            <Section
              category="execution"
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
                  rows={7}
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

            <Section category="execution" title="GPU runs">
              <p className="field-note">Discover the host, choose GPU resources, and approve the exact probe script. GPU setup is optional; saving a new draft requires another approved probe before GPU execution is enabled.</p>
              <GpuSetupControl />
            </Section>

            <Section category="updates" title="Brain Registry">
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
              category="connections"
              title="Model connection"
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
                      (next === "anthropic" || next === "gemini") &&
                      next !== provider
                    ) {
                      nextModel = next === "gemini" ? "gemini-3.8-flash" : "claude-sonnet-5";
                      setModel(nextModel);
                      setBaseUrl("");
                    }
                    setProvider(next);
                    clearConnectionFeedback();
                    // Switching to a provider whose credential is already
                    // verified applies immediately. A new/replacement secret
                    // stays a draft until its explicit Save action.
                    if (!canAutoSaveProvider(next)) return;
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
                  <option value="gemini">Gemini API (Google developer key)</option>
                  <option value="offline">Offline (deterministic, no key)</option>
                </select>
                {provider !== loaded.llm.provider && <span className="field-note" role="status">Active provider: {providerLabels[loaded.llm.provider]}. {providerLabels[provider]} is selected for setup and becomes active after verification succeeds.</span>}
              </div>
              {(provider === "anthropic" || provider === "gemini") && (
                <>
                  <div className="field">
                    <label className="field-label" htmlFor="settings-api-key">
                      API key
                    </label>
                    <div className="field-with-action">
                      <input
                        id="settings-api-key"
                        type="password"
                        value={provider === "gemini" ? geminiApiKey : apiKey}
                        autoComplete="new-password"
                        placeholder={
                          (provider === "gemini" ? loaded.llm.geminiApiKeyConfigured : loaded.llm.apiKeyConfigured)
                            ? "Verified key saved — enter a new key to replace it"
                            : provider === "gemini" ? "paste the Gemini API key…" : "sk-ant-…"
                        }
                        onChange={(e) => {
                          if (provider === "gemini") setGeminiApiKey(e.target.value); else setApiKey(e.target.value);
                          clearConnectionFeedback();
                        }}
                      />
                      {credentialActions}
                    </div>
                    <span className="field-note">
                      {(provider === "gemini" ? loaded.llm.geminiApiKeyConfigured : loaded.llm.apiKeyConfigured)
                        ? "A verified key is configured. It is never returned to this page."
                        : provider === "gemini" ? "Get a key from Google AI Studio. Saving checks model access without generating a response; nothing is stored if verification fails." : "Saving tests the key with Anthropic first; nothing is stored if it fails."}
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
                      placeholder={provider === "gemini" ? "gemini-3.8-flash" : "claude-sonnet-5"}
                      onChange={(e) => {
                        setModel(e.target.value);
                        clearConnectionFeedback();
                        saveSoon("model");
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
                      placeholder={provider === "gemini" ? "Google Gemini default" : "Anthropic default"}
                      onChange={(e) => {
                        setBaseUrl(e.target.value);
                        clearConnectionFeedback();
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
                        clearConnectionFeedback();
                      }}
                    />
                    {credentialActions}
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
                        clearConnectionFeedback();
                      }}
                    />
                    {credentialActions}
                  </div>
                  <span className="field-note">
                    Create a key at cursor.com/dashboard (Integrations → API keys, or a
                    team service account) and paste it here. Saving tests it and never
                    returns it to the browser.
                  </span>
                </div>
              )}
              {provider !== "offline" && <SettingsToggle label="Record thinking transcripts when available" checked={transcript !== "off"}
                onCheckedChange={(checked) => {
                  const next = checked ? "if-available" : "off";
                  setTranscript(next);
                  if (canAutoSaveProvider()) void save("model", { llm: { provider, transcript: next } });
                }} description="Optional provider-supplied summaries. Reasoning effort and reviewable argument steps are unchanged. Individual stages can override this default." />}
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
                        clearConnectionFeedback();
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
                          saveSoon("model");
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
                          saveSoon("model");
                        }}
                      />
                    </div>
                  </div>
                  <div className="field-grid-two">
                    <div className="field">
                      <label className="field-label" htmlFor="settings-agent-effort">
                        Default reasoning effort
                      </label>
                      <select
                        id="settings-agent-effort"
                        value={agentEffort}
                        disabled={!defaultCapabilities?.effortLevels.length}
                        onChange={(e) => {
                          setAgentEffort(
                            e.target.value as "low" | "medium" | "high" | "xhigh" | "max",
                          );
                          if (!canAutoSaveProvider()) return;
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
                        {!defaultCapabilities?.effortLevels.includes(agentEffort) && <option value={agentEffort} disabled>{agentEffort} (saved; unavailable for this model)</option>}
                        {defaultCapabilities?.effortLevels.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                      </select>
                      {!defaultCapabilities && <span className="field-note">This model’s reasoning capabilities are not available.</span>}
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="settings-agent-thinking">
                        Default adaptive thinking
                      </label>
                      <select
                        id="settings-agent-thinking"
                        value={agentThinking}
                        disabled={!defaultCapabilities?.adaptiveThinking || defaultCapabilities.thinkingCanBeDisabled !== true}
                        onChange={(e) => {
                          const next = e.target.value as "adaptive" | "disabled";
                          setAgentThinking(next);
                          if (!canAutoSaveProvider()) return;
                          void save("model", {
                            llm: {
                              ...llmPatch(),
                              agentSdk: { ...agentSdkPatch(), thinking: next },
                            },
                          });
                        }}
                      >
                        {(defaultCapabilities?.adaptiveThinking || agentThinking === 'adaptive') && <option value="adaptive" disabled={!defaultCapabilities?.adaptiveThinking}>adaptive</option>}
                        {(defaultCapabilities?.thinkingCanBeDisabled === true || agentThinking === 'disabled') && <option value="disabled" disabled={defaultCapabilities?.thinkingCanBeDisabled !== true}>disabled</option>}
                      </select>
                      {defaultCapabilities?.adaptiveThinking && defaultCapabilities.thinkingCanBeDisabled !== true && <span className="field-note">This model manages thinking automatically.</span>}
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
                        saveSoon("model");
                      }}
                    />
                  </div>
                </>
              )}
            </Section>

            <Section category="stageModels" title="Models by workflow stage" summary={`Provider: ${providerLabels[loaded.llm.provider]}`}>
              {activeCategory === "stageModels" && <TaskModelsSettings settings={loaded} />}
            </Section>

            <Section
              category="research"
              title="Panel confirmation"
              state={saveState.confirmation}
              error={saveError.confirmation}
            >
              <SettingsToggle
                label={askBeforeApprovalLabel}
                checked={confirmation === "manual"}
                description={approvalPreferenceDescription(confirmation, gateAutoApprove)}
                onCheckedChange={(ask) => {
                  const next = ask ? "manual" : "auto";
                  setConfirmation(next);
                  void save("confirmation", { panelConfirmation: next });
                }}
              />
              <h3 className="settings-subheading">If I do not answer</h3>
              <SettingsToggle
                  label="Continue after countdown"
                  checked={gateAutoApprove}
                  onCheckedChange={(next) => {
                    setGateAutoApprove(next);
                    void save("confirmation", { gateAutoApprove: next });
                  }}
              />
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
              category="research"
              title="Review"
              state={saveState.review}
              error={saveError.review}
            >
              <SettingsToggle
                label="Gamified review"
                checked={gamifiedReview}
                onCheckedChange={(next) => {
                  setGamifiedReview(next);
                  void save("review", { gamifiedReview: next });
                }}
              />
              <span className="field-note">
                New runs use probability reports and a committee chair's admissibility checks.
                The decision rule below determines the committee's label. Scores update each
                reviewer's balance; a balance below zero permanently stops future critic
                work in that run. Their own solution continues. Rejected reports are unscored, except that, when the content bundle enables it, a report citing a badge never issued in the run's fact table, or one deleted before the report was requested, records -175.
                Existing runs keep their original mode, threshold, and starting points.
                Requires a content bundle that supports gamified review.
              </span>
              <div className="field">
                <label className="field-label" htmlFor="settings-game-threshold">Game decision threshold</label>
                <input id="settings-game-threshold" type="number" min="0" max="1" step="any" value={gameThreshold}
                  disabled={!gamifiedReview} onChange={event => setGameThreshold(event.target.value)}
                  onBlur={() => saveGameReview()} />
                <span className="field-note">Under the committee-mean rule, a mean admitted probability at or above this threshold marks a major flaw. Lower is stricter. Under the chair-decisive rule the mean is recorded but decides nothing. No admitted reports leaves the round unresolved.</span>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="settings-game-decision-rule">Decision rule</label>
                <select id="settings-game-decision-rule" value={gameDecisionRule} disabled={!gamifiedReview} onChange={event => {
                  const rule = event.target.value as "committee-mean" | "chair-decisive";
                  setGameDecisionRule(rule);
                  saveGameReview(gameThreshold, gamePointsMode, gameInitialPoints, rule);
                }}><option value="chair-decisive">Chair decisive · any admitted decisive argument blocks</option><option value="committee-mean">Committee mean · mean admitted probability against the threshold</option></select>
                <span className="field-note">Chair decisive: the committee chair labels each admitted argument decisive, not decisive or invalid; the step is blocked when any admitted argument is decisive, and every critic is scored against that label. Committee mean: the legacy rule; the mean admitted probability against the threshold decides.</span>
              </div>
              <SettingsToggle
                label="Leave-one-out scoring"
                checked={gameLeaveOneOut}
                disabled={!gamifiedReview || gameDecisionRule === "chair-decisive"}
                description={gameDecisionRule === "chair-decisive"
                  ? "not applicable: the chair label does not depend on the critics' numbers"
                  : "Under committee mean, each critic is scored against the label the other admitted reports produce. A lone admitted report is unscored."}
                onCheckedChange={(next) => {
                  setGameLeaveOneOut(next);
                  saveGameReview(gameThreshold, gamePointsMode, gameInitialPoints, gameDecisionRule, next);
                }}
              />
              <div className="field">
                <label className="field-label" htmlFor="settings-game-points-mode">Reviewer starting points</label>
                <select id="settings-game-points-mode" value={gamePointsMode} disabled={!gamifiedReview} onChange={event => {
                  const mode = event.target.value as "auto" | "custom";
                  setGamePointsMode(mode);
                  saveGameReview(gameThreshold, mode);
                }}><option value="auto">Automatic · 100 × confirmed panel size</option><option value="custom">Custom points per reviewer</option></select>
                {gamePointsMode === "custom" && <>
                  <label className="field-label" htmlFor="settings-game-initial-points">Starting points per reviewer</label>
                  <input id="settings-game-initial-points" type="number" min="0" step="any" value={gameInitialPoints}
                    disabled={!gamifiedReview} onChange={event => setGameInitialPoints(event.target.value)}
                    onBlur={() => saveGameReview()} />
                </>}
                <span className="field-note">Automatic points use the actual confirmed panel, including added seats. A balance of exactly zero remains eligible; exclusion starts below zero.</span>
              </div>
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
              category="research"
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
              <SettingsToggle
                  label="Interdisciplinary seat"
                  checked={interdisciplinarySeat}
                  onCheckedChange={(next) => {
                    setInterdisciplinarySeat(next);
                    void save("panel", {
                      panel: {
                        ...(panelSize !== "" ? { size: Number(panelSize) } : {}),
                        ...(next === false ? { interdisciplinarySeat: false } : {}),
                      },
                    });
                  }}
              />
              <span className="field-note">
                One extra woven seat whose expertise is the space between the
                selected fields. It develops, is reviewed, and redevelops like
                every other member. Applies to every NEW run.
              </span>
            </Section>

            <Section
              category="research"
              title="Panel composition"
              state={saveState.panelComposition}
              error={saveError.panelComposition}
            >
              <PanelCompositionSettings
                loaded={loaded}
                onSave={(patch) => save("panelComposition", patch)}
              />
            </Section>

            <Section category="tools" title="Research capabilities">
              {activeCategory === "tools" && <RunCapabilitiesSettings />}
            </Section>

            <Section category="tools" title="Environment checks">
              {activeCategory === "tools" && <ToolReadinessSettings />}
            </Section>

            <Section
              category="tools"
              title="Capabilities & host tools"
              state={saveState.tools}
              error={saveError.tools}
            >
              <span className="field-note" style={{ marginBottom: "0.5rem", display: "block" }}>
                Tools that run on your machine. Switch off a capability to disable it for all pipeline roles.
              </span>
              <SettingsToggle
                  label="Attachment access (list, read, and search submission files)"
                  checked={
                    enabledHostTools.includes("attachment_list") &&
                    enabledHostTools.includes("attachment_read")
                  }
                  onCheckedChange={(checked) =>
                    saveTools(
                      checked
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
              <span className="field-note" style={{ display: "block" }}>
                Choose the app's coordinated search tools or each agent's
                built-in search in the Web search section below.
              </span>
              <SettingsToggle
                  label="Code execution (host scratch workspace; providers with native execution keep using it)"
                  checked={enabledHostTools.includes("code_execute")}
                  onCheckedChange={(checked) =>
                    saveTools(
                      checked
                        ? [...new Set([...enabledHostTools, "code_execute"])]
                        : enabledHostTools.filter((id) => id !== "code_execute"),
                    )
                  }
              />
            </Section>

            <Section
              category="tools"
              title="Web search"
              state={saveState.webSearch}
              error={saveError.webSearch}
            >
              <span className="field-note" style={{ display: "block", marginBottom: "0.5rem" }}>
                By default every agent searches through the app's own tools —
                web, news, paper search and paper lookup: one coordinator per
                run sends each kind of query to the sources below in order,
                paces them across all agents, and writes every request and
                answer to the run's search log. You can instead let each agent
                use its model backend's built-in search.
              </span>
              <div className="field">
                <label className="field-label" htmlFor="settings-web-mode">
                  Search tools
                </label>
                <select
                  id="settings-web-mode"
                  value={webMode}
                  onChange={(e) => {
                    const next = e.target.value as "host" | "agent";
                    setWebMode(next);
                    void save("webSearch", {
                      webSearch: { provider: webProvider, mode: next },
                    });
                  }}
                >
                  <option value="host">The app's search tools (coordinated and logged)</option>
                  <option value="agent">Each agent's own built-in search</option>
                </select>
                {webMode === "agent" && (
                  <span className="field-note">
                    Agents use Claude's WebSearch and WebFetch, Cursor's web
                    tools, or the Anthropic API's web search (with the app's
                    plain page fetch). Runs then keep no search log, and the
                    settings below do not apply.
                  </span>
                )}
              </div>
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
                            if (saved) setTavilyApiKey((current) => current === tavilyApiKey ? "" : current);
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
                            if (saved) setBraveApiKey((current) => current === braveApiKey ? "" : current);
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
              <SettingsToggle
                  label="Paid fallback: Brave Search API when the free sources fail"
                  checked={braveFallbackEnabled}
                  onCheckedChange={(checked) => {
                    setBraveFallbackEnabled(checked);
                    void save("webSearch", {
                      webSearch: {
                        provider: webProvider,
                        braveFallback: braveFallbackSettings(checked),
                      },
                    });
                  }}
              />
              <span className="field-note">
                Asked last on every route, only after SearXNG and the scholarly
                indexes failed or found nothing. Brave bills about $5 per 1,000
                requests from prepaid credits (api-dashboard.search.brave.com);
                requests are capped per run and per month and counted on this
                machine. Per Brave's terms its results are kept only in memory
                during a run, and the search log stores a hash of each URL.
              </span>
              {braveFallbackEnabled && (
                <div className="field">
                  <label className="field-label" htmlFor="settings-brave-per-run">
                    Paid requests per run / per month
                  </label>
                  <div className="field-with-action">
                    <input
                      id="settings-brave-per-run"
                      type="number"
                      min={0}
                      value={braveMaxPerRun}
                      onChange={(e) => setBraveMaxPerRun(e.target.value)}
                      onBlur={(e) => {
                        void save("webSearch", {
                          webSearch: {
                            provider: webProvider,
                            braveFallback: braveFallbackSettings(true, e.target.value, braveMaxPerMonth),
                          },
                        });
                      }}
                    />
                    <input
                      id="settings-brave-per-month"
                      aria-label="Paid requests per month"
                      type="number"
                      min={0}
                      value={braveMaxPerMonth}
                      onChange={(e) => setBraveMaxPerMonth(e.target.value)}
                      onBlur={(e) => {
                        void save("webSearch", {
                          webSearch: {
                            provider: webProvider,
                            braveFallback: braveFallbackSettings(true, braveMaxPerRun, e.target.value),
                          },
                        });
                      }}
                    />
                  </div>
                </div>
              )}
              {braveFallbackEnabled && webProvider !== "brave" && (
                <div className="field">
                  <label className="field-label" htmlFor="settings-brave-fallback-key">
                    Brave Search API key
                  </label>
                  <div className="field-with-action">
                    <input
                      id="settings-brave-fallback-key"
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
                              provider: webProvider,
                              braveFallback: braveFallbackSettings(true),
                              braveApiKey: braveApiKey.trim(),
                            },
                          }).then((saved) => {
                            if (saved) setBraveApiKey((current) => current === braveApiKey ? "" : current);
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
              <SettingsToggle
                  label="Scholarly indexes (OpenAlex, Crossref, arXiv, Semantic Scholar)"
                  checked={webScholarly}
                  onCheckedChange={(checked) => {
                    setWebScholarly(checked);
                    void save("webSearch", {
                      webSearch: {
                        provider: webProvider,
                        ...(searxngBaseUrl.trim() !== ""
                          ? { searxngBaseUrl: searxngBaseUrl.trim() }
                          : {}),
                        scholarly: checked,
                        cacheEnabled: webCacheEnabled,
                        ...(webContactEmail.trim() !== ""
                          ? { contactEmail: webContactEmail.trim() }
                          : {}),
                      },
                    });
                  }}
              />
              <span className="field-note">
                Keyless and on by default — paper and citation searches answer
                from these with DOIs, authors, venues, and citation counts.
              </span>
              <SettingsToggle
                  label="Cache keyword results across runs (24h)"
                  checked={webCacheEnabled}
                  onCheckedChange={(checked) => {
                    setWebCacheEnabled(checked);
                    void save("webSearch", {
                      webSearch: {
                        provider: webProvider,
                        ...(searxngBaseUrl.trim() !== ""
                          ? { searxngBaseUrl: searxngBaseUrl.trim() }
                          : {}),
                        scholarly: webScholarly,
                        cacheEnabled: checked,
                        ...(webContactEmail.trim() !== ""
                          ? { contactEmail: webContactEmail.trim() }
                          : {}),
                      },
                    });
                  }}
              />
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
                    saveSoon("webSearch");
                  }}
                />
                <span className="field-note">
                  Shared with the scholarly indexes' polite pools for faster,
                  more reliable answers. Never required.
                </span>
              </div>
            </Section>

            <Section
              category="tools"
              title="Tools and providers"
              state={saveState.availability}
              error={saveError.availability}
            >
              <ToolsAndProviders onSave={(patch) => save("availability", patch)} />
            </Section>

            <Section
              category="recovery"
              title="Recovery"
              state={saveState.recovery}
              error={saveError.recovery}
            >
              <h3 className="settings-subheading">Interrupted jobs</h3>
              <SettingsToggle
                  label="Resume interrupted jobs automatically from their last checkpoint"
                  checked={resumeInterrupted}
                  onCheckedChange={(checked) => {
                    setResumeInterrupted(checked);
                    void save("recovery", {
                      interruptedRecovery: { autoResume: checked },
                    });
                  }}
              />
              <span className="field-note">
                Covers SLURM timeouts, node failures, and power cuts: the
                scheduler resubmits the run and it continues from where it
                stopped. Auto-resume pauses after repeated attempts without
                progress; the job card then offers a manual resume.
              </span>
              <h3 className="settings-subheading">Credit recovery</h3>
              <SettingsToggle
                  label="Resume automatically after provider credit resets"
                  checked={autoResume}
                  onCheckedChange={(checked) => {
                    setAutoResume(checked);
                    const creditRecovery = creditRecoveryPatch();
                    if (creditRecovery) {
                      void save("recovery", {
                        interruptedRecovery: { autoResume: resumeInterrupted },
                        creditRecovery: {
                          ...creditRecovery,
                          autoResume: checked,
                        },
                      });
                    }
                  }}
              />
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
                      saveSoon("recovery");
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
                      saveSoon("recovery");
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
                          if (saved) setOpenRouterApiKey((current) => current === openRouterApiKey ? "" : current);
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

            <Section category="recovery" title="Trash">
              <a
                className="btn settings-trash-link"
                href="#/trash"
                onClick={(event) => { event.preventDefault(); afterClose.current = () => { location.hash = "/trash"; }; void requestClose(); }}
              >
                <TrashIcon size={14} />
                View trashed jobs
              </a>
              <span className="field-note">
                Stopped jobs moved to trash leave the job list but stay
                readable.
              </span>
            </Section>
                </>}
              </SettingsCategoryContext.Provider>
            </div>
          </div>
          <footer className="settings-footer">
            {closeWarning ? <div className="settings-close-warning" role="alert"><p>{closeWarning}</p><div><button type="button" className="btn" onClick={() => { afterClose.current = null; setCloseWarning(null); }}>Keep editing</button><button type="button" className="btn" disabled={closing} onClick={() => void requestClose(true)}>Discard unsaved changes</button></div></div> : <><span>Most changes save automatically. Credentials and stage models need Save.</span><button type="button" className="btn" disabled={closing} onClick={() => void requestClose()}>{closing ? "Saving…" : "Done"}</button></>}
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
