import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { userMessage } from "@brainstorm-agentic/core";
import {
  normalizeClaudeSetupToken,
  validateClaudeSetupToken,
} from "@brainstorm-agentic/executor-claude-agent";
import {
  validateCursorApiKey,
} from "@brainstorm-agentic/executor-cursor-agent";
import { discoverGeminiModels } from "@brainstorm-agentic/provider-gemini";
import { AnthropicMessagesProvider } from "@brainstorm-agentic/provider-anthropic";
import { ContentRegistryClient } from "@brainstorm-agentic/registry-client";
import {
  GPU_COMMAND_TAG,
  SLURM_COMMAND_TAG,
  type ClaudeAgentSettings,
  type GpuRunSettings,
  type GameReviewSettings,
  type LlmSettings,
  type StageModelSettings,
  type ModelCatalogSnapshot,
  type ServerSettings,
  type ServerSettingsUpdate,
  type WebSearchSettings,
} from "@brainstorm-agentic/protocol";
import {
  LOCAL_SEARXNG_ENGINES,
  paidRequestsInMonth,
  resolveGeneralProvider,
  type WebSearchRuntimeConfig,
  type WebSearchSecrets,
} from "@brainstorm-agentic/host-tools";

import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./files.js";
import { gpuProfileDigest, gpuProfileVerified, revokeGpuProfile, verifyGpuProfile } from "./gpu-verification.js";
import {
  panelCompositionOf,
  validatePanelComposition,
  type PanelCompositionSettings,
} from "./panel-composition.js";
import { readJsonCached } from "./read-cache.js";
import { localSearxngProxyEnvironment } from "./searxng-endpoint.js";
import {
  searxngDir,
  searxngLocalUrl,
  readSearxngState,
  type SearxngStateFile,
} from "./searxng-launcher.js";

/** Whether a new run can spend at least one request on the opted-in fallback. */
export function paidWebSearchFallbackAvailable(workspace: string, settings: ServerSettings): boolean {
  const fallback = settings.webSearch?.braveFallback;
  return fallback?.enabled === true &&
    settings.webSearch?.braveKeyConfigured === true &&
    (fallback.maxRequestsPerRun ?? 300) > 0 &&
    paidRequestsInMonth(workspace, "brave") < (fallback.maxRequestsPerMonth ?? 1000);
}

/** A local service failure and the search scope the configured alternatives retain. */
export function localWebSearchIssue(
  workspace: string,
  settings: ServerSettings,
  instanceId?: string,
): { readonly message: string; readonly detail: string; readonly blocking: boolean } | undefined {
  if (
    settings.llm.provider === "offline" ||
    settings.capabilityOverrides?.["web-search"] === false ||
    settings.webSearch?.provider !== "searxng-local" ||
    // Search handed to the agents' own tools needs no local service.
    settings.webSearch.mode === "agent"
  ) {
    return undefined;
  }
  let state: SearxngStateFile | undefined;
  let unreadable = false;
  try {
    state = readSearxngState(workspace, instanceId);
  } catch {
    unreadable = true;
  }
  if (!unreadable && searxngLocalUrl(workspace, instanceId) !== undefined) {
    return undefined;
  }
  const paidFallback = paidWebSearchFallbackAvailable(workspace, settings);
  const scholarly = settings.webSearch.scholarly !== false;
  const blocking = !paidFallback && !scholarly;
  const service = unreadable
    ? "Local SearXNG state cannot be read"
    : `Local SearXNG is ${state?.state ?? "not started"}`;
  const scope = paidFallback
    ? "general web searches use the configured paid Brave fallback"
    : scholarly
      ? "scholarly search remains available; general web search is unavailable"
      : "general web search is unavailable and no search alternative is enabled";
  return {
    message: `${service}; ${scope}`,
    blocking,
    detail: [
      blocking
        ? "web-search / web.search -> unavailable"
        : paidFallback
          ? "web-search / general search -> configured paid Brave fallback"
          : "web-search / scholarly search -> host paper tools; general web search -> unavailable",
      unreadable
        ? "Check the server's SearXNG state file and log."
        : state?.detail ?? "Wait for local SearXNG to start, or check the server's SearXNG log.",
    ].join("\n"),
  };
}

/** Admission fails only when the configured search tools have no alternative. */
export function localWebSearchUnavailable(
  workspace: string,
  settings: ServerSettings,
  instanceId?: string,
): ReturnType<typeof localWebSearchIssue> {
  const issue = localWebSearchIssue(workspace, settings, instanceId);
  return issue?.blocking ? issue : undefined;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
/**
 * THE deployment constant for the shared Brain Registry (MCP + static HTTP).
 * Users never configure this: cloning and installing the app is enough — the
 * webapp shows it read-only and PUT /api/settings ignores attempts to change
 * it. Developers change deployments here, or override one launch with
 * `--content-registry-url` / `BRAIN_CONTENT_REGISTRY_URL` (and
 * `--content-registry-main` to spawn a local registry process instead).
 */
export const DEFAULT_CONTENT_REGISTRY_URL =
  "https://167.172.170.154/mcp";
const CONNECTION_TIMEOUT_MS = 15_000;
// SDK validation starts a subprocess before its one-turn model request. Its
// cold-start budget must be independent of the direct HTTP-provider timeout.
const CLAUDE_SDK_CONNECTION_TIMEOUT_MS = 60_000;
export const DEFAULT_CLAUDE_AGENT_SETTINGS: ClaudeAgentSettings = {
  maxTurns: 100,
  effort: "high",
  thinking: "adaptive",
};

/** Keep the complete catalog on the job, but only selected models in the worker environment. */
export function runtimeModelCatalog(settings: ServerSettings): ModelCatalogSnapshot | undefined {
  const catalog = settings.llm.modelCatalog;
  if (!catalog) return undefined;
  const llm = settings.llm;
  const selected = new Set([
    llm.model ?? llm.modelsByRoute?.reasoning ?? (llm.provider === "cursor-agent" ? "auto" : llm.provider === "claude-agent" ? "sonnet" : ""),
    llm.agentSdk?.fallbackModel ?? "",
    ...Object.values(llm.modelsByRoute ?? {}),
    ...Object.values(llm.stageSettingsByProvider?.[llm.provider] ?? {}).map((stage) => stage.model ?? ""),
  ].filter(Boolean));
  // Alias/canonical rows can refer to each other; retain their complete connected set.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of catalog.models) {
      if (!selected.has(entry.id) && !entry.aliases?.some((alias) => selected.has(alias))) continue;
      for (const id of [entry.id, ...(entry.aliases ?? [])]) {
        if (!selected.has(id)) { selected.add(id); changed = true; }
      }
    }
  }
  return { ...catalog, models: catalog.models.filter((entry) => selected.has(entry.id)),
    ...(catalog.cursorModels ? { cursorModels: catalog.cursorModels.filter((entry) => selected.has(entry.id) || entry.aliases?.some((alias) => selected.has(alias))) } : {}) };
}

type StoredLlmSettings = Omit<
  LlmSettings,
  "apiKeyConfigured" | "setupTokenConfigured" | "cursorApiKeyConfigured" | "geminiApiKeyConfigured"
>;
type StoredCreditRecovery = Omit<
  ServerSettings["creditRecovery"],
  "openRouterKeyConfigured"
>;
/**
 * Telemetry as it is STORED: the enabled flag only. The ingest destination is
 * deployment-owned and recomputed from the registry origin on every read, so
 * persisting it could only go stale.
 */
type StoredTelemetry = Omit<
  NonNullable<ServerSettings["telemetry"]>,
  "ingestUrl"
>;
/** Web search as STORED: the configured flags are read off credentials.json. */
type StoredWebSearch = Omit<
  WebSearchSettings,
  | "tavilyKeyConfigured"
  | "braveKeyConfigured"
  | "semanticScholarKeyConfigured"
  | "openAlexKeyConfigured"
>;
type StoredServerSettings = Omit<
  ServerSettings,
  "llm" | "creditRecovery" | "telemetry" | "webSearch"
> & {
  readonly llm: StoredLlmSettings;
  readonly creditRecovery: StoredCreditRecovery;
  readonly telemetry?: StoredTelemetry;
  readonly webSearch?: StoredWebSearch;
  /** Panel composition overrides (spec v2 Section 0); stored only when non-empty. */
  readonly panelComposition?: PanelCompositionSettings;
  /** Tool availability policy (availability spec 2026-10-03); stored only when set. */
  readonly availability?: AvailabilitySettings;
};

/**
 * The availability section (contract Section A): whether degraded tools are
 * moved behind every available one in the derived per-purpose order (default
 * true; off = only flagged), and how often every tool is re-checked while the
 * server is up (minutes, default 30).
 */
export interface AvailabilitySettings {
  readonly demoteDegraded?: boolean;
  readonly periodicMinutes?: number;
}

export const DEFAULT_AVAILABILITY_PERIODIC_MINUTES = 30;

/** The availability policy in effect, defaults applied. */
export function availabilitySettingsOf(
  settings: ServerSettings,
): { readonly demoteDegraded: boolean; readonly periodicMinutes: number } {
  const section = settings.availability;
  return {
    demoteDegraded: section?.demoteDegraded !== false,
    periodicMinutes: section?.periodicMinutes ?? DEFAULT_AVAILABILITY_PERIODIC_MINUTES,
  };
}

/** `{}` is valid and means "the defaults". */
function validateAvailabilitySettings(value: unknown): AvailabilitySettings {
  const input = object(value, "availability");
  if (input.demoteDegraded !== undefined && typeof input.demoteDegraded !== "boolean") {
    throw new Error("availability.demoteDegraded must be a boolean");
  }
  const minutes = input.periodicMinutes;
  if (
    minutes !== undefined &&
    (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60)
  ) {
    throw new Error("availability.periodicMinutes must be an integer between 1 and 1440");
  }
  return {
    ...(input.demoteDegraded !== undefined ? { demoteDegraded: input.demoteDegraded } : {}),
    ...(minutes !== undefined ? { periodicMinutes: minutes } : {}),
  };
}

interface StoredCredentials {
  readonly anthropicApiKey?: string;
  readonly claudeSetupToken?: string;
  readonly cursorApiKey?: string;
  readonly geminiApiKey?: string;
  readonly openRouterApiKey?: string;
  readonly tavilyApiKey?: string;
  readonly braveApiKey?: string;
  readonly semanticScholarApiKey?: string;
  readonly openAlexApiKey?: string;
  /** CORE (core.ac.uk) API key for the panel composition's CORE source. */
  readonly coreApiKey?: string;
}

export interface AnthropicConnectionInput {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

export type AnthropicConnectionValidator = (
  input: AnthropicConnectionInput,
) => Promise<void>;

export interface ClaudeAgentConnectionInput {
  readonly token: string;
  readonly model?: string;
}

export type ClaudeAgentConnectionValidator = (
  input: ClaudeAgentConnectionInput,
) => Promise<void>;

export interface CursorAgentConnectionInput {
  readonly apiKey: string;
  readonly model?: string;
}

export type CursorAgentConnectionValidator = (
  input: CursorAgentConnectionInput,
) => Promise<void>;

export interface GeminiConnectionInput {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}
export type GeminiConnectionValidator = (input: GeminiConnectionInput) => Promise<void>;

export interface WebSearchConnectionInput {
  readonly provider: "tavily" | "brave" | "searxng";
  readonly apiKey?: string;
  readonly searxngBaseUrl?: string;
}

export type WebSearchConnectionValidator = (
  input: WebSearchConnectionInput,
) => Promise<void>;

export interface SettingsStoreOptions {
  /** The local search instance owned by this app listener. */
  readonly searxngInstanceId?: string;
  /** Applied only when creating a new workspace, before provider onboarding. */
  readonly defaultRunner?: "local" | "slurm";
  readonly validateAnthropic?: AnthropicConnectionValidator;
  readonly validateClaudeAgent?: ClaudeAgentConnectionValidator;
  readonly validateCursorAgent?: CursorAgentConnectionValidator;
  readonly validateGemini?: GeminiConnectionValidator;
  readonly validateOpenRouter?: (
    apiKey: string,
    model: string,
  ) => Promise<void>;
  /** Verifies a search provider with one real one-result query. */
  readonly validateWebSearch?: WebSearchConnectionValidator;
  /** The deployment's registry endpoint (launch-time CLI/env override). */
  readonly defaultContentRegistryUrl?: string;
}

export const DEFAULT_SLURM_TEMPLATE = `#!/usr/bin/env bash
#SBATCH --job-name=brain
#SBATCH --time=01:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --output=logs/slurm-%j.out

set -euo pipefail
${SLURM_COMMAND_TAG}
`;

/**
 * The ingest origin derived from the content-registry endpoint: same host,
 * same TLS, one thing to deploy and keep in sync. Empty when no registry is
 * configured, which disables sending.
 */
export function ingestUrlFor(contentRegistryUrl: string | undefined): string {
  if (!contentRegistryUrl) return "";
  try {
    const url = new URL(contentRegistryUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export function defaultServerSettings(
  contentRegistryUrl = DEFAULT_CONTENT_REGISTRY_URL,
): ServerSettings {
  return {
    runner: "slurm",
    panelConfirmation: "manual",
    // An unattended run keeps moving by default; the submitter may switch the
    // countdown off and make every gate wait for a human instead.
    gateAutoApprove: true,
    gamifiedReview: false,
    gameReview: { threshold: 0.5, decisionRule: "chair-decisive", leaveOneOut: true },
    contentRegistry: {
      url: contentRegistryUrl,
      bundle: "brainstorm",
    },
    creditRecovery: {
      autoResume: true,
      safetyBufferSeconds: 60,
      openRouterModel: "openrouter/free",
      openRouterKeyConfigured: false,
    },
    telemetry: {
      enabled: true,
      // The deployment's own registry origin also receives ingest, so there is
      // no second endpoint to configure or keep in sync.
      ingestUrl: ingestUrlFor(contentRegistryUrl),
    },
    interruptedRecovery: {
      autoResume: true,
    },
    llm: {
      provider: "anthropic",
      model: DEFAULT_ANTHROPIC_MODEL,
      agentSdk: DEFAULT_CLAUDE_AGENT_SETTINGS,
      apiKeyConfigured: false,
    },
    hostTools: {
      // Low-risk reads enabled by default (mirrors the manifests'
      // defaultEnabled). The taxonomy tools power the decompose stage's
      // placer; without them taxonomy-access resolves as unavailable.
      enabledToolIds: [
        "attachment_list",
        "attachment_read",
        "attachment_search",
        "taxonomy_tree",
        "taxonomy_resolve",
      ],
    },
    // The host-owned web layer: the scholarly chain is keyless and ON by
    // default (it is what this pipeline's searches mostly are), the general
    // provider waits for the deployment owner to pick one and paste a key,
    // and the cross-run keyword cache is an explicit opt-in.
    webSearch: {
      provider: "none",
      scholarly: true,
      cacheEnabled: false,
    },
    slurmTemplate: DEFAULT_SLURM_TEMPLATE,
    // GPU runs are OFF until the deployment owner completes the template.
    gpu: { template: "", timeLimitMinutes: 60 },
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalNonEmptyString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function validateGameReviewSettings(value: unknown): GameReviewSettings {
  const section: Record<string, unknown> = value === undefined ? {} : object(value, "gameReview");
  const threshold = section.threshold === undefined ? 0.5 : section.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("gameReview.threshold must be a number from 0 to 1");
  }
  const initialPoints = section.initialPoints;
  if (initialPoints !== undefined && (typeof initialPoints !== "number" || !Number.isFinite(initialPoints) || initialPoints < 0)) {
    throw new Error("gameReview.initialPoints must be a finite nonnegative number, or omitted for automatic points");
  }
  const decisionRule = section.decisionRule === undefined ? "chair-decisive" : section.decisionRule;
  if (decisionRule !== "committee-mean" && decisionRule !== "chair-decisive") {
    throw new Error("gameReview.decisionRule must be \"committee-mean\" or \"chair-decisive\"");
  }
  const leaveOneOut = section.leaveOneOut === undefined ? true : section.leaveOneOut;
  if (typeof leaveOneOut !== "boolean") {
    throw new Error("gameReview.leaveOneOut must be a boolean");
  }
  return { threshold, ...(initialPoints !== undefined ? { initialPoints: initialPoints as number } : {}), decisionRule, leaveOneOut };
}

function validateCommonSettings(value: unknown): {
  readonly slurmTemplate: string;
  readonly gpu?: GpuRunSettings;
  readonly runner: "slurm" | "local";
  readonly panelConfirmation: "manual" | "auto";
  readonly gateAutoApprove: boolean;
  readonly gamifiedReview: boolean;
  readonly gameReview: GameReviewSettings;
  readonly review?: { readonly maxRounds?: number };
  readonly panel?: { readonly size?: number; readonly interdisciplinarySeat?: boolean };
  readonly llm: Record<string, unknown>;
  readonly creditRecovery: Record<string, unknown>;
  readonly interruptedRecovery?: Record<string, unknown>;
  readonly contentRegistry: Record<string, unknown>;
  readonly hostTools?: Record<string, unknown>;
  readonly webSearch?: Record<string, unknown>;
  readonly updateCheck?: "off" | "notify";
  readonly telemetry?: Record<string, unknown>;
  readonly panelComposition?: PanelCompositionSettings;
  readonly availability?: AvailabilitySettings;
} {
  const input = object(value, "settings");
  const template = input.slurmTemplate;
  if (typeof template !== "string" || !template.includes(SLURM_COMMAND_TAG)) {
    throw new Error(`slurmTemplate must contain ${SLURM_COMMAND_TAG}`);
  }
  const gpu = input.gpu !== undefined ? validateGpuSettings(input.gpu) : undefined;
  const review =
    input.review !== undefined ? validateReviewSettings(input.review) : undefined;
  const panel =
    input.panel !== undefined ? validatePanelSettings(input.panel) : undefined;
  const panelComposition =
    input.panelComposition !== undefined
      ? validatePanelComposition(input.panelComposition)
      : undefined;
  const availability =
    input.availability !== undefined
      ? validateAvailabilitySettings(input.availability)
      : undefined;
  if (input.runner !== "slurm" && input.runner !== "local") {
    throw new Error('runner must be "slurm" or "local"');
  }
  if (
    input.panelConfirmation !== "manual" &&
    input.panelConfirmation !== "auto"
  ) {
    throw new Error('panelConfirmation must be "manual" or "auto"');
  }
  if (
    input.gateAutoApprove !== undefined &&
    typeof input.gateAutoApprove !== "boolean"
  ) {
    throw new Error("gateAutoApprove must be a boolean");
  }
  // Absent in a settings file written before the switch existed = the behavior
  // that file ran under, which was always to count down and approve.
  const gateAutoApprove = input.gateAutoApprove !== false;
  if (input.gamifiedReview !== undefined && typeof input.gamifiedReview !== "boolean") {
    throw new Error("gamifiedReview must be a boolean");
  }
  const gamifiedReview = input.gamifiedReview === true;
  const gameReview = validateGameReviewSettings(input.gameReview);
  const llm = object(input.llm, "llm");
  const creditRecovery =
    input.creditRecovery === undefined
      ? {
          autoResume: true,
          safetyBufferSeconds: 60,
          openRouterModel: "openrouter/free",
        }
      : object(input.creditRecovery, "creditRecovery");
  const contentRegistry =
    input.contentRegistry === undefined
      ? {
          url: DEFAULT_CONTENT_REGISTRY_URL,
          bundle: "brainstorm",
        }
      : object(input.contentRegistry, "contentRegistry");
  if (
    llm.provider !== "anthropic" &&
    llm.provider !== "claude-agent" &&
    llm.provider !== "cursor-agent" &&
    llm.provider !== "gemini" &&
    llm.provider !== "offline"
  ) {
    throw new Error(
      'llm.provider must be "anthropic", "claude-agent", "cursor-agent", "gemini", or "offline"',
    );
  }
  const hostTools =
    input.hostTools !== undefined
      ? object(input.hostTools, "hostTools")
      : undefined;
  const webSearch =
    input.webSearch !== undefined
      ? object(input.webSearch, "webSearch")
      : undefined;
  const interruptedRecovery =
    input.interruptedRecovery !== undefined
      ? object(input.interruptedRecovery, "interruptedRecovery")
      : undefined;
  const telemetry =
    input.telemetry !== undefined ? object(input.telemetry, "telemetry") : undefined;
  if (telemetry !== undefined && typeof telemetry.enabled !== "boolean") {
    throw new Error("telemetry.enabled must be a boolean");
  }
  const updateCheck = input.updateCheck;
  if (
    updateCheck !== undefined &&
    updateCheck !== "off" &&
    updateCheck !== "notify"
  ) {
    throw new Error('updateCheck must be "off" or "notify"');
  }
  return {
    slurmTemplate: template,
    ...(gpu !== undefined ? { gpu } : {}),
    runner: input.runner,
    panelConfirmation: input.panelConfirmation,
    gateAutoApprove,
    gamifiedReview,
    gameReview,
    ...(review !== undefined ? { review } : {}),
    ...(panel !== undefined ? { panel } : {}),
    llm,
    creditRecovery,
    ...(interruptedRecovery !== undefined ? { interruptedRecovery } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    contentRegistry,
    hostTools,
    ...(webSearch !== undefined ? { webSearch } : {}),
    ...(updateCheck !== undefined ? { updateCheck } : {}),
    ...(panelComposition !== undefined ? { panelComposition } : {}),
    ...(availability !== undefined ? { availability } : {}),
  };
}

/**
 * Mirrors the shipped workflow's declared maxReviewRounds range so a bad
 * value fails at save time, in the drawer. The pinned bundle re-validates
 * authoritatively when a run starts, so a future bundle with a narrower
 * range still has the final say.
 */
const REVIEW_ROUNDS_BOUNDS = { min: 1, max: 10 } as const;

/** `{}` is valid and means "follow the bundle's default". */
function validateReviewSettings(value: unknown): { maxRounds?: number } {
  const input = object(value, "review");
  const maxRounds = input.maxRounds;
  if (maxRounds === undefined) return {};
  if (
    typeof maxRounds !== "number" ||
    !Number.isInteger(maxRounds) ||
    maxRounds < REVIEW_ROUNDS_BOUNDS.min ||
    maxRounds > REVIEW_ROUNDS_BOUNDS.max
  ) {
    throw new Error(
      `review.maxRounds must be an integer between ${REVIEW_ROUNDS_BOUNDS.min} and ${REVIEW_ROUNDS_BOUNDS.max}`,
    );
  }
  return { maxRounds };
}

/**
 * Mirrors the shipped workflow's declared panelSize range, exactly like the
 * review-rounds bounds above: a bad value fails at save time in the drawer,
 * and the pinned bundle re-validates authoritatively when a run starts.
 */
const PANEL_SIZE_BOUNDS = { min: 2, max: 12 } as const;

/** `{}` is valid and means "bundle default size, interdisciplinary seat on". */
function validatePanelSettings(value: unknown): {
  size?: number;
  interdisciplinarySeat?: boolean;
} {
  const input = object(value, "panel");
  const out: { size?: number; interdisciplinarySeat?: boolean } = {};
  if (input.size !== undefined) {
    if (
      typeof input.size !== "number" ||
      !Number.isInteger(input.size) ||
      input.size < PANEL_SIZE_BOUNDS.min ||
      input.size > PANEL_SIZE_BOUNDS.max
    ) {
      throw new Error(
        `panel.size must be an integer between ${PANEL_SIZE_BOUNDS.min} and ${PANEL_SIZE_BOUNDS.max}`,
      );
    }
    out.size = input.size;
  }
  if (input.interdisciplinarySeat !== undefined) {
    if (typeof input.interdisciplinarySeat !== "boolean") {
      throw new Error("panel.interdisciplinarySeat must be a boolean");
    }
    out.interdisciplinarySeat = input.interdisciplinarySeat;
  }
  return out;
}

/** One GPU job's runtime ceiling can be at most a day. */
const MAX_GPU_TIME_LIMIT_MINUTES = 1_440;

/**
 * The GPU section is valid when EITHER the template is empty (GPU runs off;
 * the limit is kept for when the user completes the template later) OR the
 * template carries the agent-command tag.
 */
function validateGpuSettings(value: unknown): GpuRunSettings {
  const input = object(value, "gpu");
  const template = input.template;
  if (typeof template !== "string") {
    throw new Error("gpu.template must be a string");
  }
  if (template.trim() !== "" && !template.includes(GPU_COMMAND_TAG)) {
    throw new Error(`gpu.template must contain ${GPU_COMMAND_TAG} (or be empty to switch GPU runs off)`);
  }
  const limit = input.timeLimitMinutes ?? 60;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_GPU_TIME_LIMIT_MINUTES
  ) {
    throw new Error(
      `gpu.timeLimitMinutes must be an integer between 1 and ${MAX_GPU_TIME_LIMIT_MINUTES}`,
    );
  }
  return { template, timeLimitMinutes: limit };
}

function validateInterruptedRecovery(
  value: Record<string, unknown> | undefined,
): { autoResume: boolean } {
  if (value === undefined) return { autoResume: true };
  if (typeof value.autoResume !== "boolean") {
    throw new Error("interruptedRecovery.autoResume must be a boolean");
  }
  return { autoResume: value.autoResume };
}

function validateContentRegistry(
  value: Record<string, unknown>,
): ServerSettings["contentRegistry"] {
  const urlText = optionalNonEmptyString(
    value.url,
    "contentRegistry.url",
  );
  if (!urlText) throw new Error("contentRegistry.url is required");
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new Error("contentRegistry.url must be a valid URL");
  }
  const localHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error(
      "contentRegistry.url must use HTTPS (HTTP is allowed only for loopback development)",
    );
  }
  const bundle = optionalNonEmptyString(
    value.bundle,
    "contentRegistry.bundle",
  );
  if (!bundle || !/^[A-Za-z0-9._-]+$/.test(bundle)) {
    throw new Error("contentRegistry.bundle must be a safe identifier");
  }
  const version = optionalNonEmptyString(
    value.version,
    "contentRegistry.version",
  );
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("contentRegistry.version must be semantic version x.y.z");
  }
  const updatePolicy = value.updatePolicy;
  if (
    updatePolicy !== undefined &&
    updatePolicy !== "auto" &&
    updatePolicy !== "notify"
  ) {
    throw new Error('contentRegistry.updatePolicy must be "auto" or "notify"');
  }
  return {
    url: parsed.toString(),
    bundle,
    ...(version ? { version } : {}),
    ...(updatePolicy !== undefined ? { updatePolicy } : {}),
  };
}

function validateCreditRecovery(
  value: Record<string, unknown>,
): StoredCreditRecovery {
  if (typeof value.autoResume !== "boolean") {
    throw new Error("creditRecovery.autoResume must be a boolean");
  }
  if (
    typeof value.safetyBufferSeconds !== "number" ||
    !Number.isSafeInteger(value.safetyBufferSeconds) ||
    value.safetyBufferSeconds < 0 ||
    value.safetyBufferSeconds > 3600
  ) {
    throw new Error(
      "creditRecovery.safetyBufferSeconds must be an integer from 0 to 3600",
    );
  }
  const openRouterModel = optionalNonEmptyString(
    value.openRouterModel,
    "creditRecovery.openRouterModel",
  );
  if (!openRouterModel) {
    throw new Error("creditRecovery.openRouterModel is required");
  }
  return {
    autoResume: value.autoResume,
    safetyBufferSeconds: value.safetyBufferSeconds,
    openRouterModel,
  };
}

function validateModelsByRoute(
  value: unknown,
): Record<string, string> | undefined {
  let modelsByRoute: Record<string, string> | undefined;
  if (value !== undefined) {
    const routes = object(value, "llm.modelsByRoute");
    modelsByRoute = {};
    for (const [route, model] of Object.entries(routes)) {
      if (typeof model !== "string" || model.trim() === "") {
        throw new Error(`llm.modelsByRoute.${route} must be a non-empty string`);
      }
      modelsByRoute[route] = model.trim();
    }
  }
  return modelsByRoute;
}

function validateTranscript(value: unknown, field: string): LlmSettings["transcript"] {
  if (value !== undefined && value !== "if-available" && value !== "off") throw new Error(`${field} must be if-available or off`);
  return value;
}

export function validateStageSettings(value: unknown): Record<string, StageModelSettings> {
  const input = object(value, "stageSettings");
  const stages: Record<string, StageModelSettings> = {};
  for (const [id, raw] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id)) throw new Error("stageSettings keys must be workflow stage ids");
    const entry = object(raw, `stageSettings.${id}`);
    const model = optionalNonEmptyString(entry.model, `stageSettings.${id}.model`);
    const effort = entry.effort;
    if (effort !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(String(effort))) {
      throw new Error(`stageSettings.${id}.effort must be minimal, low, medium, high, xhigh, or max`);
    }
    const transcript = validateTranscript(entry.transcript, `stageSettings.${id}.transcript`);
    const thinking = entry.thinking;
    if (thinking !== undefined && thinking !== "adaptive" && thinking !== "disabled") {
      throw new Error(`stageSettings.${id}.thinking must be adaptive or disabled`);
    }
    if (model !== undefined || effort !== undefined || thinking !== undefined || transcript !== undefined) {
      stages[id] = { ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort: effort as StageModelSettings["effort"] } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(transcript !== undefined ? { transcript } : {}) };
    }
  }
  return stages;
}

function validateStageSettingsByProvider(value: unknown): LlmSettings["stageSettingsByProvider"] {
  if (value === undefined) return undefined;
  const result: NonNullable<LlmSettings["stageSettingsByProvider"]> = {};
  for (const [provider, stages] of Object.entries(object(value, "llm.stageSettingsByProvider"))) {
    if (!["anthropic", "claude-agent", "cursor-agent", "gemini", "offline"].includes(provider)) throw new Error("unknown stage settings provider");
    result[provider as LlmSettings["provider"]] = validateStageSettings(stages);
  }
  return result;
}

function validateClaudeAgentSettings(value: unknown): ClaudeAgentSettings {
  if (value === undefined) return { ...DEFAULT_CLAUDE_AGENT_SETTINGS };
  const input = object(value, "llm.agentSdk");
  const maxTurns = input.maxTurns;
  if (
    typeof maxTurns !== "number" ||
    !Number.isSafeInteger(maxTurns) ||
    maxTurns < 1 ||
    maxTurns > 500
  ) {
    throw new Error("llm.agentSdk.maxTurns must be an integer from 1 to 500");
  }
  const effort = input.effort;
  if (
    effort !== "minimal" &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh" &&
    effort !== "max"
  ) {
    throw new Error(
      'llm.agentSdk.effort must be "minimal", "low", "medium", "high", "xhigh", or "max"',
    );
  }
  const thinking = input.thinking;
  if (thinking !== "adaptive" && thinking !== "disabled") {
    throw new Error(
      'llm.agentSdk.thinking must be "adaptive" or "disabled"',
    );
  }
  let maxBudgetUsd: number | undefined;
  if (input.maxBudgetUsd !== undefined && input.maxBudgetUsd !== "") {
    if (
      typeof input.maxBudgetUsd !== "number" ||
      !Number.isFinite(input.maxBudgetUsd) ||
      input.maxBudgetUsd <= 0
    ) {
      throw new Error("llm.agentSdk.maxBudgetUsd must be a positive number");
    }
    maxBudgetUsd = input.maxBudgetUsd;
  }
  const fallbackModel = optionalNonEmptyString(
    input.fallbackModel,
    "llm.agentSdk.fallbackModel",
  );
  return {
    maxTurns,
    effort,
    thinking,
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
  };
}

/**
 * The web-search section as stored (no keys, no configured flags). Absent =
 * the default: no general provider, scholarly on, cache off — which is also
 * what every settings file written before the section existed means.
 */
function validateWebSearchSettings(
  value: Record<string, unknown> | undefined,
): StoredWebSearch {
  if (value === undefined) {
    return { provider: "none", scholarly: true, cacheEnabled: false };
  }
  const provider = value.provider;
  if (
    provider !== "none" &&
    provider !== "tavily" &&
    provider !== "brave" &&
    provider !== "searxng" &&
    provider !== "searxng-local"
  ) {
    throw new Error(
      'webSearch.provider must be "none", "tavily", "brave", "searxng", or "searxng-local"',
    );
  }
  const searxngBaseUrl = optionalNonEmptyString(
    value.searxngBaseUrl,
    "webSearch.searxngBaseUrl",
  );
  if (searxngBaseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(searxngBaseUrl);
    } catch {
      throw new Error("webSearch.searxngBaseUrl must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("webSearch.searxngBaseUrl must be an http(s) URL");
    }
  }
  if (provider === "searxng" && searxngBaseUrl === undefined) {
    throw new Error("webSearch.searxngBaseUrl is required when SearXNG is selected");
  }
  if (value.scholarly !== undefined && typeof value.scholarly !== "boolean") {
    throw new Error("webSearch.scholarly must be a boolean");
  }
  if (value.cacheEnabled !== undefined && typeof value.cacheEnabled !== "boolean") {
    throw new Error("webSearch.cacheEnabled must be a boolean");
  }
  const ttl = value.cacheTtlHours;
  if (
    ttl !== undefined &&
    (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 30)
  ) {
    throw new Error("webSearch.cacheTtlHours must be an integer between 1 and 720");
  }
  const contactEmail = optionalNonEmptyString(
    value.contactEmail,
    "webSearch.contactEmail",
  );
  if (contactEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new Error("webSearch.contactEmail must be an email address");
  }
  const mode = value.mode;
  if (mode !== undefined && mode !== "host" && mode !== "agent") {
    throw new Error('webSearch.mode must be "host" or "agent"');
  }
  const routePreset = value.routePreset;
  if (routePreset !== undefined && routePreset !== "searxng-first" && routePreset !== "api-first") {
    throw new Error('webSearch.routePreset must be "searxng-first" or "api-first"');
  }
  let braveFallback: StoredWebSearch["braveFallback"];
  if (value.braveFallback !== undefined) {
    const fallback = value.braveFallback;
    if (typeof fallback !== "object" || fallback === null || Array.isArray(fallback)) {
      throw new Error("webSearch.braveFallback must be an object");
    }
    const entry = fallback as Record<string, unknown>;
    if (typeof entry.enabled !== "boolean") {
      throw new Error("webSearch.braveFallback.enabled must be a boolean");
    }
    const cap = (name: "maxRequestsPerRun" | "maxRequestsPerMonth", max: number): number | undefined => {
      const raw = entry[name];
      if (raw === undefined) return undefined;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > max) {
        throw new Error(`webSearch.braveFallback.${name} must be an integer between 0 and ${max}`);
      }
      return raw;
    };
    const perRun = cap("maxRequestsPerRun", 10_000);
    const perMonth = cap("maxRequestsPerMonth", 1_000_000);
    braveFallback = {
      enabled: entry.enabled,
      ...(perRun !== undefined ? { maxRequestsPerRun: perRun } : {}),
      ...(perMonth !== undefined ? { maxRequestsPerMonth: perMonth } : {}),
    };
  }
  return {
    provider,
    ...(searxngBaseUrl !== undefined ? { searxngBaseUrl } : {}),
    scholarly: value.scholarly !== false,
    cacheEnabled: value.cacheEnabled === true,
    ...(ttl !== undefined ? { cacheTtlHours: ttl } : {}),
    ...(contactEmail !== undefined ? { contactEmail } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(braveFallback !== undefined ? { braveFallback } : {}),
    ...(routePreset !== undefined ? { routePreset } : {}),
  };
}

function validateHostTools(
  value: Record<string, unknown> | undefined,
): { enabledToolIds: readonly string[] } | undefined {
  if (!value) return undefined;
  const ids = value.enabledToolIds;
  if (!Array.isArray(ids)) {
    throw new Error("hostTools.enabledToolIds must be an array");
  }
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("hostTools.enabledToolIds entries must be non-empty strings");
    }
  }
  const enabledToolIds = [...(ids as string[])];
  // Migration: attachment_search shipped after deployments persisted their
  // enabled list. It is the same risk class as attachment_read (a scoped
  // read), so a store that allows reads gains search rather than having the
  // whole attachment-access capability degrade to "unavailable" because one
  // new operation resolves nowhere.
  if (
    enabledToolIds.includes("attachment_read") &&
    !enabledToolIds.includes("attachment_search")
  ) {
    enabledToolIds.push("attachment_search");
  }
  return { enabledToolIds };
}

function validateStoredSettings(value: unknown): StoredServerSettings {
  const common = validateCommonSettings(value);
  const provider = common.llm.provider as
    | "anthropic"
    | "claude-agent"
    | "cursor-agent"
    | "gemini"
    | "offline";
  const model =
    optionalNonEmptyString(common.llm.model, "llm.model") ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : provider === "gemini" ? "gemini-3.8-flash" : undefined);
  const baseUrl = optionalNonEmptyString(common.llm.baseUrl, "llm.baseUrl");
  const modelsByRoute = validateModelsByRoute(common.llm.modelsByRoute);
  const stageSettingsByProvider = validateStageSettingsByProvider(common.llm.stageSettingsByProvider);
  const transcript = validateTranscript(common.llm.transcript, "llm.transcript");
  const agentSdk = validateClaudeAgentSettings(common.llm.agentSdk);
  const creditRecovery = validateCreditRecovery(common.creditRecovery);
  const interruptedRecovery = validateInterruptedRecovery(common.interruptedRecovery);
  const contentRegistry = validateContentRegistry(common.contentRegistry);
  const hostTools = validateHostTools(common.hostTools);
  const webSearch = validateWebSearchSettings(common.webSearch);
  return {
    slurmTemplate: common.slurmTemplate,
    ...(common.gpu !== undefined ? { gpu: common.gpu } : {}),
    runner: common.runner,
    panelConfirmation: common.panelConfirmation,
    gateAutoApprove: common.gateAutoApprove,
    gamifiedReview: common.gamifiedReview,
    gameReview: common.gameReview,
    // Stored only when it actually overrides; `{}` normalizes to absent.
    ...(common.review?.maxRounds !== undefined
      ? { review: { maxRounds: common.review.maxRounds } }
      : {}),
    ...(common.panel !== undefined && Object.keys(common.panel).length > 0
      ? { panel: common.panel }
      : {}),
    ...(common.panelComposition !== undefined &&
    Object.keys(common.panelComposition.params).length > 0
      ? { panelComposition: common.panelComposition }
      : {}),
    contentRegistry,
    creditRecovery,
    interruptedRecovery,
    llm: {
      provider,
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(modelsByRoute !== undefined ? { modelsByRoute } : {}),
      ...(stageSettingsByProvider !== undefined ? { stageSettingsByProvider } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
      agentSdk,
    },
    ...(hostTools !== undefined ? { hostTools } : {}),
    webSearch,
    ...(common.updateCheck !== undefined ? { updateCheck: common.updateCheck } : {}),
    // Only the enabled flag is the user's; get() recomputes the deployment-owned
    // ingest URL on every read, so storing it would go stale.
    ...(common.telemetry !== undefined
      ? { telemetry: { enabled: common.telemetry.enabled === true } }
      : {}),
    // Stored only when it sets something; `{}` normalizes to absent.
    ...(common.availability !== undefined && Object.keys(common.availability).length > 0
      ? { availability: common.availability }
      : {}),
  };
}

interface ValidatedUpdate {
  /**
   * Everything the user may change. `contentRegistry` is deliberately
   * absent: the registry endpoint is deployment-owned, so put() carries the
   * stored value forward regardless of what an update submits.
   */
  readonly settings: Omit<StoredServerSettings, "contentRegistry">;
  readonly submittedApiKey?: string;
  readonly submittedSetupToken?: string;
  readonly submittedCursorApiKey?: string;
  readonly submittedGeminiApiKey?: string;
  readonly clearApiKey: boolean;
  readonly clearSetupToken: boolean;
  readonly clearCursorApiKey: boolean;
  readonly clearGeminiApiKey: boolean;
  readonly submittedOpenRouterApiKey?: string;
  readonly clearOpenRouterApiKey: boolean;
  /** Write-only web-search provider keys, verified before they are stored. */
  readonly submittedTavilyApiKey?: string;
  readonly clearTavilyApiKey: boolean;
  readonly submittedBraveApiKey?: string;
  readonly clearBraveApiKey: boolean;
  readonly submittedSemanticScholarApiKey?: string;
  readonly clearSemanticScholarApiKey: boolean;
  readonly submittedOpenAlexApiKey?: string;
  readonly clearOpenAlexApiKey: boolean;
  readonly submittedCoreApiKey?: string;
  readonly clearCoreApiKey: boolean;
  /**
   * As submitted, so put() can tell the three cases apart: absent = keep
   * the stored policy, `{}` = back to the bundle default, `{maxRounds}` =
   * override. Deliberately not part of `settings` (a spread would erase
   * the distinction).
   */
  readonly review?: { readonly maxRounds?: number };
  /** Same three-way meaning as `review`, for the panel policy. */
  readonly panel?: { readonly size?: number; readonly interdisciplinarySeat?: boolean };
  /** Same three-way meaning, for the panel composition overrides. */
  readonly panelComposition?: PanelCompositionSettings;
}

function validateSettingsUpdate(value: unknown): ValidatedUpdate {
  const common = validateCommonSettings(value);
  const provider = common.llm.provider as
    | "anthropic"
    | "claude-agent"
    | "cursor-agent"
    | "gemini"
    | "offline";
  const model = optionalNonEmptyString(common.llm.model, "llm.model");
  if ((provider === "anthropic" || provider === "gemini") && model === undefined) {
    throw new Error(`llm.model is required for ${provider === "gemini" ? "Gemini" : "Anthropic"}`);
  }
  const baseUrl = optionalNonEmptyString(common.llm.baseUrl, "llm.baseUrl");
  const submittedApiKey = optionalNonEmptyString(
    common.llm.apiKey,
    "llm.apiKey",
  );
  const rawSetupToken = optionalNonEmptyString(
    common.llm.setupToken,
    "llm.setupToken",
  );
  const submittedSetupToken = rawSetupToken === undefined
    ? undefined
    : normalizeClaudeSetupToken(rawSetupToken);
  const submittedCursorApiKey = optionalNonEmptyString(
    common.llm.cursorApiKey,
    "llm.cursorApiKey",
  );
  if (
    common.llm.clearApiKey !== undefined &&
    typeof common.llm.clearApiKey !== "boolean"
  ) {
    throw new Error("llm.clearApiKey must be a boolean");
  }
  const clearApiKey = common.llm.clearApiKey === true;
  if (
    common.llm.clearSetupToken !== undefined &&
    typeof common.llm.clearSetupToken !== "boolean"
  ) {
    throw new Error("llm.clearSetupToken must be a boolean");
  }
  const clearSetupToken = common.llm.clearSetupToken === true;
  if (
    common.llm.clearCursorApiKey !== undefined &&
    typeof common.llm.clearCursorApiKey !== "boolean"
  ) {
    throw new Error("llm.clearCursorApiKey must be a boolean");
  }
  const clearCursorApiKey = common.llm.clearCursorApiKey === true;
  const submittedGeminiApiKey = optionalNonEmptyString(common.llm.geminiApiKey, "llm.geminiApiKey");
  if (common.llm.clearGeminiApiKey !== undefined && typeof common.llm.clearGeminiApiKey !== "boolean") throw new Error("llm.clearGeminiApiKey must be a boolean");
  const clearGeminiApiKey = common.llm.clearGeminiApiKey === true;
  if (provider !== "gemini" && submittedGeminiApiKey !== undefined) throw new Error("select Gemini before setting a Gemini API key");
  if (provider === "gemini" && clearGeminiApiKey) throw new Error("cannot clear the Gemini API key while Gemini is selected");
  if (provider !== "anthropic" && submittedApiKey !== undefined) {
    throw new Error("select Anthropic before setting an API key");
  }
  if (provider !== "claude-agent" && submittedSetupToken !== undefined) {
    throw new Error(
      "select Claude Agent SDK before setting a setup token",
    );
  }
  if (provider !== "cursor-agent" && submittedCursorApiKey !== undefined) {
    throw new Error("select Cursor SDK before setting a Cursor API key");
  }
  if (provider === "anthropic" && clearApiKey) {
    throw new Error("cannot clear the API key while Anthropic is selected");
  }
  if (provider === "claude-agent" && clearSetupToken) {
    throw new Error(
      "cannot clear the setup token while Claude Agent SDK is selected",
    );
  }
  if (provider === "cursor-agent" && clearCursorApiKey) {
    throw new Error(
      "cannot clear the Cursor API key while Cursor SDK is selected",
    );
  }
  if (
    (provider === "claude-agent" || provider === "cursor-agent") &&
    baseUrl !== undefined
  ) {
    throw new Error("llm.baseUrl is only supported by developer APIs");
  }
  const modelsByRoute = validateModelsByRoute(common.llm.modelsByRoute);
  const stageSettingsByProvider = validateStageSettingsByProvider(common.llm.stageSettingsByProvider);
  // New Gemini connections make the checked recording preference explicit.
  // Other providers and stored job snapshots retain their legacy defaults.
  const transcript = validateTranscript(common.llm.transcript, "llm.transcript")
    ?? (provider === "gemini" ? "if-available" : undefined);
  const agentSdk = validateClaudeAgentSettings(common.llm.agentSdk);
  const creditRecovery = validateCreditRecovery(common.creditRecovery);
  // Absent in an update = keep the currently stored policy (merged in put()).
  const interruptedRecovery =
    common.interruptedRecovery !== undefined
      ? validateInterruptedRecovery(common.interruptedRecovery)
      : undefined;
  const submittedOpenRouterApiKey = optionalNonEmptyString(
    common.creditRecovery.openRouterApiKey,
    "creditRecovery.openRouterApiKey",
  );
  if (
    common.creditRecovery.clearOpenRouterApiKey !== undefined &&
    typeof common.creditRecovery.clearOpenRouterApiKey !== "boolean"
  ) {
    throw new Error(
      "creditRecovery.clearOpenRouterApiKey must be a boolean",
    );
  }
  const hostTools = validateHostTools(common.hostTools);
  const webSearch = validateWebSearchSettings(common.webSearch);
  // The write-only web-search keys ride the same section as its settings;
  // they are extracted here and never reach the stored document.
  const webSection = common.webSearch ?? {};
  const submittedTavilyApiKey = optionalNonEmptyString(
    webSection.tavilyApiKey,
    "webSearch.tavilyApiKey",
  );
  const submittedBraveApiKey = optionalNonEmptyString(
    webSection.braveApiKey,
    "webSearch.braveApiKey",
  );
  const submittedSemanticScholarApiKey = optionalNonEmptyString(
    webSection.semanticScholarApiKey,
    "webSearch.semanticScholarApiKey",
  );
  const submittedOpenAlexApiKey = optionalNonEmptyString(
    webSection.openAlexApiKey,
    "webSearch.openAlexApiKey",
  );
  const submittedCoreApiKey = optionalNonEmptyString(
    webSection.coreApiKey,
    "webSearch.coreApiKey",
  );
  for (const flag of [
    "clearTavilyApiKey",
    "clearBraveApiKey",
    "clearSemanticScholarApiKey",
    "clearOpenAlexApiKey",
    "clearCoreApiKey",
  ] as const) {
    if (webSection[flag] !== undefined && typeof webSection[flag] !== "boolean") {
      throw new Error(`webSearch.${flag} must be a boolean`);
    }
  }
  return {
    settings: {
      slurmTemplate: common.slurmTemplate,
      ...(common.gpu !== undefined ? { gpu: common.gpu } : {}),
      runner: common.runner,
      panelConfirmation: common.panelConfirmation,
      gateAutoApprove: common.gateAutoApprove,
      gamifiedReview: common.gamifiedReview,
      gameReview: common.gameReview,
      ...(common.updateCheck !== undefined ? { updateCheck: common.updateCheck } : {}),
      // Opt-out has to survive the save that made it. This was validated and
      // then dropped from the persisted document, so switching telemetry off
      // appeared to work and was silently forgotten: get() resolved the absent
      // flag back to `true` on the next read, and the next run reported.
      ...(common.telemetry !== undefined
        ? { telemetry: { enabled: common.telemetry.enabled === true } }
        : {}),
      creditRecovery,
      ...(interruptedRecovery !== undefined ? { interruptedRecovery } : {}),
      llm: {
        provider,
        ...(model !== undefined ? { model } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(modelsByRoute !== undefined ? { modelsByRoute } : {}),
        ...(stageSettingsByProvider !== undefined ? { stageSettingsByProvider } : {}),
        ...(transcript !== undefined ? { transcript } : {}),
        agentSdk,
      },
      ...(hostTools !== undefined ? { hostTools } : {}),
      webSearch,
      ...(common.availability !== undefined && Object.keys(common.availability).length > 0
        ? { availability: common.availability }
        : {}),
    },
    ...(submittedApiKey !== undefined ? { submittedApiKey } : {}),
    ...(submittedSetupToken !== undefined ? { submittedSetupToken } : {}),
    ...(submittedCursorApiKey !== undefined ? { submittedCursorApiKey } : {}),
    ...(submittedGeminiApiKey !== undefined ? { submittedGeminiApiKey } : {}),
    clearApiKey,
    clearSetupToken,
    clearCursorApiKey,
    clearGeminiApiKey,
    ...(submittedOpenRouterApiKey !== undefined
      ? { submittedOpenRouterApiKey }
      : {}),
    clearOpenRouterApiKey:
      common.creditRecovery.clearOpenRouterApiKey === true,
    ...(submittedTavilyApiKey !== undefined ? { submittedTavilyApiKey } : {}),
    clearTavilyApiKey: webSection.clearTavilyApiKey === true,
    ...(submittedBraveApiKey !== undefined ? { submittedBraveApiKey } : {}),
    clearBraveApiKey: webSection.clearBraveApiKey === true,
    ...(submittedSemanticScholarApiKey !== undefined
      ? { submittedSemanticScholarApiKey }
      : {}),
    clearSemanticScholarApiKey: webSection.clearSemanticScholarApiKey === true,
    ...(submittedOpenAlexApiKey !== undefined ? { submittedOpenAlexApiKey } : {}),
    clearOpenAlexApiKey: webSection.clearOpenAlexApiKey === true,
    ...(submittedCoreApiKey !== undefined ? { submittedCoreApiKey } : {}),
    clearCoreApiKey: webSection.clearCoreApiKey === true,
    ...(common.review !== undefined ? { review: common.review } : {}),
    ...(common.panel !== undefined ? { panel: common.panel } : {}),
    ...(common.panelComposition !== undefined
      ? { panelComposition: common.panelComposition }
      : {}),
  };
}

/**
 * Verifies a general-search provider the way every other credential is
 * verified: with one real, tiny request through the same implementation a
 * run uses. A key that cannot answer "test" with one result is not stored.
 */
export async function validateWebSearchConnection(
  input: WebSearchConnectionInput,
): Promise<void> {
  const config: WebSearchRuntimeConfig = {
    general: input.provider,
    ...(input.searxngBaseUrl !== undefined
      ? { searxngBaseUrl: input.searxngBaseUrl }
      : {}),
  };
  const secrets: WebSearchSecrets = {
    ...(input.provider === "tavily" && input.apiKey !== undefined
      ? { tavilyApiKey: input.apiKey }
      : {}),
    ...(input.provider === "brave" && input.apiKey !== undefined
      ? { braveApiKey: input.apiKey }
      : {}),
  };
  const resolved = resolveGeneralProvider(config, secrets);
  if (resolved === undefined || "missing" in resolved) {
    throw new Error(
      resolved === undefined
        ? "no search provider selected"
        : resolved.missing,
    );
  }
  const timeout = AbortSignal.timeout(CONNECTION_TIMEOUT_MS);
  await resolved.provider.search({
    query: "connectivity check",
    kind: "general",
    maxResults: 1,
    signal: timeout,
  });
}

export async function validateAnthropicConnection(
  input: AnthropicConnectionInput,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    const provider = new AnthropicMessagesProvider({
      apiKey: input.apiKey,
      model: input.model,
      ...(input.baseUrl !== undefined ? { baseURL: input.baseUrl } : {}),
      maxTokens: 8,
    });
    await provider.complete(
      {
        modelId: input.model,
        messages: [userMessage("Reply with OK.")],
        maxOutputTokens: 8,
        temperature: 0,
      },
      { signal: controller.signal },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to Anthropic: ${message}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateClaudeAgentConnection(
  input: ClaudeAgentConnectionInput,
): Promise<void> {
  try {
    await validateClaudeSetupToken({
      token: normalizeClaudeSetupToken(input.token),
      ...(input.model !== undefined ? { model: input.model } : {}),
      timeoutMs: CLAUDE_SDK_CONNECTION_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect with the Claude setup token: ${message}`, {
      cause: error,
    });
  }
}

export async function validateCursorAgentConnection(
  input: CursorAgentConnectionInput,
): Promise<void> {
  try {
    await validateCursorApiKey({
      apiKey: input.apiKey,
      ...(input.model !== undefined ? { model: input.model } : {}),
      timeoutMs: CONNECTION_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect with the Cursor API key: ${message}`, {
      cause: error,
    });
  }
}

export async function validateOpenRouterConnection(
  apiKey: string,
  model: string,
): Promise<void> {
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-title": "Brainstorm Agentic Credit Recovery",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 4,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to OpenRouter: ${message}`, {
      cause: error,
    });
  }
}

/** Metadata-only validation: never purchases a generated response. */
export async function validateGeminiConnection(input: GeminiConnectionInput): Promise<void> {
  try {
    const models = await discoverGeminiModels({ apiKey: input.apiKey, ...(input.baseUrl ? { baseURL: input.baseUrl } : {}), signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS) });
    const id = input.model.replace(/^models\//, "");
    if (!models.some((model) => model.id.replace(/^models\//, "") === id)) throw new Error("model unavailable");
  } catch {
    // Provider errors can echo request details; credentials never enter a UI error.
    throw new Error("Could not verify the Gemini API key and model. Check the key, selected model, and this host’s connection to Google.");
  }
}

export async function validateContentRegistryConnection(
  url: string,
  bundle: string,
  version?: string,
): Promise<void> {
  const client = new ContentRegistryClient(url);
  try {
    await client.resolvePin(bundle, version);
  } catch (error) {
    throw new Error(
      `Could not connect to Brain Registry: ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

export class SettingsStore {
  readonly searxngInstanceId: string | undefined;
  private gpuRevision = 0;
  gpuProfileRevision(): number { return this.gpuRevision; }
  readonly path: string;
  readonly credentialsPath: string;
  /**
   * The registry endpoint this deployment runs against: the launch-time URL
   * (CLI/env override, or the built-in DEFAULT_CONTENT_REGISTRY_URL). It is
   * the single source of truth — stored files carrying an older URL are
   * overridden on read, and updates never change it.
   */
  private readonly deploymentRegistryUrl: string;
  private readonly connectionValidator: AnthropicConnectionValidator;
  private readonly claudeAgentValidator: ClaudeAgentConnectionValidator;
  private readonly cursorAgentValidator: CursorAgentConnectionValidator;
  private readonly geminiValidator: GeminiConnectionValidator;
  private readonly openRouterValidator: (
    apiKey: string,
    model: string,
  ) => Promise<void>;
  private readonly webSearchValidator: WebSearchConnectionValidator;

  constructor(
    readonly workspace: string,
    options: SettingsStoreOptions = {},
  ) {
    this.searxngInstanceId = options.searxngInstanceId;
    this.path = join(workspace, "settings.json");
    this.credentialsPath = join(workspace, "credentials.json");
    this.deploymentRegistryUrl =
      options.defaultContentRegistryUrl ?? DEFAULT_CONTENT_REGISTRY_URL;
    this.connectionValidator =
      options.validateAnthropic ?? validateAnthropicConnection;
    this.claudeAgentValidator =
      options.validateClaudeAgent ?? validateClaudeAgentConnection;
    this.cursorAgentValidator =
      options.validateCursorAgent ?? validateCursorAgentConnection;
    this.geminiValidator = options.validateGemini ?? validateGeminiConnection;
    this.openRouterValidator =
      options.validateOpenRouter ?? validateOpenRouterConnection;
    this.webSearchValidator =
      options.validateWebSearch ?? validateWebSearchConnection;
    mkdirSync(join(workspace, "workspace", "jobs"), { recursive: true });
    mkdirSync(join(workspace, "workspace", "sessions"), { recursive: true });
    const stored = readJsonFile<unknown>(this.path);
    const storedWithRegistry =
      stored !== undefined &&
      typeof stored === "object" &&
      stored !== null &&
      !Array.isArray(stored) &&
      !("contentRegistry" in stored)
        ? {
            ...stored,
            contentRegistry: {
              url: this.deploymentRegistryUrl,
              bundle: "brainstorm",
            },
          }
        : stored;
    atomicWriteJson(
      this.path,
      stored === undefined
        ? validateStoredSettings(
            { ...defaultServerSettings(this.deploymentRegistryUrl), runner: options.defaultRunner ?? "slurm" },
          )
        : validateStoredSettings(storedWithRegistry),
    );
  }

  get(): ServerSettings {
    // Hot path: read per request/SSE tick; the stamped cache makes an
    // unchanged settings file cost one stat instead of a read+parse.
    const settings = validateStoredSettings(readJsonCached<unknown>(this.path));
    return {
      ...settings,
      // The deployment's registry endpoint always wins over anything stored
      // (e.g. a workspace created under an older deployment).
      contentRegistry: {
        ...settings.contentRegistry,
        url: this.deploymentRegistryUrl,
      },
      llm: {
        ...settings.llm,
        apiKeyConfigured: this.getAnthropicApiKey() !== undefined,
        setupTokenConfigured: this.getClaudeSetupToken() !== undefined,
        cursorApiKeyConfigured: this.getCursorApiKey() !== undefined,
        geminiApiKeyConfigured: this.getGeminiApiKey() !== undefined,
      },
      creditRecovery: {
        ...settings.creditRecovery,
        openRouterKeyConfigured:
          this.getOpenRouterApiKey() !== undefined,
      },
      // The ingest destination is deployment-owned like the registry origin
      // it derives from, so it is recomputed on every read: a settings file
      // written before telemetry existed (or one whose update dropped the
      // URL) can never strand the diagnostics button on "no destination".
      // Only the enabled flag is the user's.
      telemetry: {
        enabled: settings.telemetry?.enabled ?? true,
        ingestUrl: ingestUrlFor(this.deploymentRegistryUrl),
      },
      webSearch: {
        ...(settings.webSearch ?? {
          provider: "none",
          scholarly: true,
          cacheEnabled: false,
        }),
        tavilyKeyConfigured: this.getTavilyApiKey() !== undefined,
        braveKeyConfigured: this.getBraveApiKey() !== undefined,
        semanticScholarKeyConfigured:
          this.getSemanticScholarApiKey() !== undefined,
        openAlexKeyConfigured: this.getOpenAlexApiKey() !== undefined,
        // Not a protocol field yet: present only once a CORE key is stored.
        ...(this.getCoreApiKey() !== undefined ? { coreKeyConfigured: true } : {}),
      },
    };
  }

  getAnthropicApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(
      this.credentialsPath,
    )?.anthropicApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getClaudeSetupToken(): string | undefined {
    const token = readJsonCached<StoredCredentials>(
      this.credentialsPath,
    )?.claudeSetupToken;
    if (typeof token !== "string") return undefined;
    return normalizeClaudeSetupToken(token) || undefined;
  }

  getCursorApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(
      this.credentialsPath,
    )?.cursorApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getGeminiApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(this.credentialsPath)?.geminiApiKey;
    return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
  }

  getOpenRouterApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(
      this.credentialsPath,
    )?.openRouterApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getTavilyApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(this.credentialsPath)?.tavilyApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getBraveApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(this.credentialsPath)?.braveApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getSemanticScholarApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(
      this.credentialsPath,
    )?.semanticScholarApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getOpenAlexApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(this.credentialsPath)?.openAlexApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getCoreApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(this.credentialsPath)?.coreApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  /**
   * The web-search runtime config a run executes with, derived from settings
   * — the SAME shape the worker parses out of BRAINSTORM_AGENTIC_WEB_SEARCH,
   * and the same one the readiness probe models, so the promise made before
   * a job exists cannot drift from what the run does. Secrets never appear
   * here; they travel the credential channels.
   */
  webSearchRuntimeConfig(settings: ServerSettings = this.get()): WebSearchRuntimeConfig {
    this.assertWebSearchReady(settings);
    const stored = settings.webSearch ?? {
      provider: "none" as const,
      scholarly: true,
      cacheEnabled: false,
    };
    // Search handed to the agents' own tools: the worker builds no web
    // layer, so nothing else here applies.
    if (stored.mode === "agent") return { mode: "agent" };
    // The paid fallback, capped per run and by what this month's allowance
    // still permits (counted in the local usage ledger).
    const fallback = stored.braveFallback;
    const braveFallback =
      fallback?.enabled === true && this.getBraveApiKey() !== undefined
        ? {
            enabled: true,
            maxRequestsPerRun: fallback.maxRequestsPerRun ?? 300,
            remainingThisMonth: Math.max(
              0,
              (fallback.maxRequestsPerMonth ?? 1000) - paidRequestsInMonth(this.workspace, "brave"),
            ),
          }
        : undefined;
    // The app-launched local instance: the worker only ever sees "searxng
    // at this URL" — where the URL comes from the launcher's state file in
    // this app instance. If unavailable, the already configured scholarly
    // tools / paid fallback remain usable; readiness reports the reduced
    // scope instead of silently promising general search.
    const localUrl =
      stored.provider === "searxng-local"
        ? searxngLocalUrl(this.workspace, this.searxngInstanceId)
        : undefined;
    const general =
      stored.provider === "searxng-local"
        ? localUrl !== undefined
          ? ("searxng" as const)
          : undefined
        : stored.provider !== "none"
          ? stored.provider
          : undefined;
    const searxngBaseUrl = localUrl ?? stored.searxngBaseUrl;
    return {
      ...(general !== undefined ? { general } : {}),
      ...(general === "searxng" && searxngBaseUrl !== undefined
        ? { searxngBaseUrl }
        : {}),
      scholarly: stored.scholarly,
      ...(stored.cacheEnabled
        ? {
            cache: {
              enabled: true,
              ...(stored.cacheTtlHours !== undefined
                ? { ttlHours: stored.cacheTtlHours }
                : {}),
            },
          }
        : {}),
      ...(stored.contactEmail !== undefined
        ? { contactEmail: stored.contactEmail }
        : {}),
      ...(braveFallback !== undefined ? { braveFallback } : {}),
      ...(stored.routePreset !== undefined ? { routePreset: stored.routePreset } : {}),
      // The launched instance runs exactly these engines (the launcher
      // renders them), so the coordinator can schedule them by name.
      ...(stored.provider === "searxng-local" && general === "searxng"
        ? { searxngEngines: { byRoute: LOCAL_SEARXNG_ENGINES } }
        : {}),
    };
  }

  /** Also guards direct submissions and resumes after a readiness snapshot. */
  assertWebSearchReady(settings: ServerSettings = this.get()): void {
    const unavailable = localWebSearchUnavailable(this.workspace, settings, this.searxngInstanceId);
    if (unavailable) {
      throw new Error(`${unavailable.message}\n${unavailable.detail}`);
    }
  }

  /** The web-search secrets currently configured (for probes; never logged). */
  webSearchSecrets(): WebSearchSecrets {
    const tavily = this.getTavilyApiKey();
    const brave = this.getBraveApiKey();
    const semanticScholar = this.getSemanticScholarApiKey();
    const openAlex = this.getOpenAlexApiKey();
    return {
      ...(tavily !== undefined ? { tavilyApiKey: tavily } : {}),
      ...(brave !== undefined ? { braveApiKey: brave } : {}),
      ...(semanticScholar !== undefined
        ? { semanticScholarApiKey: semanticScholar }
        : {}),
      ...(openAlex !== undefined ? { openAlexApiKey: openAlex } : {}),
    };
  }

  executionEnvironment(
    base: NodeJS.ProcessEnv,
    settings: ServerSettings = this.get(),
  ): NodeJS.ProcessEnv {
    const env = { ...base };
    // Always replace inherited launch policy, including empty maps on legacy jobs.
    env.BRAINSTORM_AGENTIC_STAGE_SETTINGS = JSON.stringify(settings.llm.stageSettingsByProvider?.[settings.llm.provider] ?? {});
    // An empty map is authoritative too: otherwise a cleared route selection
    // can leak back in from the server or scheduler's inherited environment.
    env.BRAINSTORM_AGENTIC_MODELS_BY_ROUTE = JSON.stringify(settings.llm.modelsByRoute ?? {});
    delete env.BRAINSTORM_AGENTIC_TRANSCRIPT;
    if (settings.llm.transcript !== undefined) env.BRAINSTORM_AGENTIC_TRANSCRIPT = settings.llm.transcript;
    delete env.BRAINSTORM_AGENTIC_MODEL_CATALOG;
    const catalog = runtimeModelCatalog(settings);
    if (catalog !== undefined) {
      env.BRAINSTORM_AGENTIC_MODEL_CATALOG = JSON.stringify(catalog);
    }
    // A worker must seed routing from this app's health checks, never a
    // sibling server's snapshot from the shared workspace or parent shell.
    delete env.BRAINSTORM_AGENTIC_AVAILABILITY_PATH;
    if (this.searxngInstanceId !== undefined) {
      env.BRAINSTORM_AGENTIC_AVAILABILITY_PATH = join(
        searxngDir(this.workspace, this.searxngInstanceId),
        "availability.json",
      );
    }
    // Inherited or manually edited templates cannot bypass onboarding approval.
    delete env.BRAINSTORM_AGENTIC_GPU_RUN;
    // Per-run capability disables ride the execution-settings snapshot.
    // Emitted before the provider branch so every provider — including
    // offline's early return — carries them to the worker's broker.
    const disabledCapabilities = Object.entries(
      settings.capabilityOverrides ?? {},
    )
      .filter(([, enabled]) => enabled === false)
      .map(([capabilityId]) => capabilityId);
    if (disabledCapabilities.length > 0) {
      env.BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES =
        disabledCapabilities.join(",");
    }
    // Opting out means no record is produced at all, rather than one written and
    // then withheld — so the WORKER has to know. Without this the flag only
    // stopped the server from sending, and every run still wrote its summary
    // into the spool, where it sat undrained.
    if (settings.telemetry?.enabled === false) {
      env.BRAINSTORM_AGENTIC_TELEMETRY = "off";
    }
    if (settings.llm.provider === "anthropic") {
      const apiKey = this.getAnthropicApiKey();
      if (!apiKey) {
        throw new Error(
          "Anthropic is selected but no verified API key is configured",
        );
      }
      env.BRAINSTORM_AGENTIC_PROVIDER = "anthropic";
      env.ANTHROPIC_API_KEY = apiKey;
      if (settings.llm.baseUrl) {
        env.ANTHROPIC_BASE_URL = settings.llm.baseUrl;
      }
      // New launches resolve these defaults against their provider catalog.
      // Older API job snapshots keep their original execution behavior.
      if (catalog !== undefined) {
        const agent = settings.llm.agentSdk ?? DEFAULT_CLAUDE_AGENT_SETTINGS;
        env.BRAINSTORM_AGENTIC_AGENT_EFFORT = agent.effort;
        env.BRAINSTORM_AGENTIC_AGENT_THINKING = agent.thinking;
      }
    } else if (settings.llm.provider === "gemini") {
      const key = this.getGeminiApiKey();
      if (!key) throw new Error("Gemini is selected but no verified API key is configured");
      env.BRAINSTORM_AGENTIC_PROVIDER = "gemini";
      env.GEMINI_API_KEY = key;
      delete env.GEMINI_BASE_URL;
      if (settings.llm.baseUrl) env.GEMINI_BASE_URL = settings.llm.baseUrl;
      // A developer API key must never be silently routed to Vertex AI.
      delete env.GOOGLE_GENAI_USE_VERTEXAI;
      delete env.GOOGLE_API_KEY;
      if (catalog !== undefined) {
        const agent = settings.llm.agentSdk ?? DEFAULT_CLAUDE_AGENT_SETTINGS;
        env.BRAINSTORM_AGENTIC_AGENT_EFFORT = agent.effort;
        env.BRAINSTORM_AGENTIC_AGENT_THINKING = agent.thinking;
      }
    } else if (settings.llm.provider === "claude-agent") {
      const token = this.getClaudeSetupToken();
      if (!token) {
        throw new Error(
          "Claude Agent SDK is selected but no verified setup token is configured",
        );
      }
      env.BRAINSTORM_AGENTIC_PROVIDER = "claude-agent";
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      // Avoid the Agent SDK silently choosing an inherited developer API key.
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      const agent = settings.llm.agentSdk ?? DEFAULT_CLAUDE_AGENT_SETTINGS;
      env.BRAINSTORM_AGENTIC_AGENT_MAX_TURNS = String(agent.maxTurns);
      env.BRAINSTORM_AGENTIC_AGENT_EFFORT = agent.effort;
      env.BRAINSTORM_AGENTIC_AGENT_THINKING = agent.thinking;
      if (agent.maxBudgetUsd !== undefined) {
        env.BRAINSTORM_AGENTIC_AGENT_MAX_BUDGET_USD = String(
          agent.maxBudgetUsd,
        );
      }
      if (agent.fallbackModel) {
        env.BRAINSTORM_AGENTIC_AGENT_FALLBACK_MODEL = agent.fallbackModel;
      }
    } else if (settings.llm.provider === "cursor-agent") {
      const cursorKey = this.getCursorApiKey();
      if (!cursorKey) {
        throw new Error(
          "Cursor SDK is selected but no verified API key is configured",
        );
      }
      env.BRAINSTORM_AGENTIC_PROVIDER = "cursor-agent";
      env.CURSOR_API_KEY = cursorKey;
      // The SAME agent-SDK settings travel to the worker under the SAME
      // variables the claude-agent path uses — one settings shape, two SDKs.
      const agent = settings.llm.agentSdk ?? DEFAULT_CLAUDE_AGENT_SETTINGS;
      env.BRAINSTORM_AGENTIC_AGENT_MAX_TURNS = String(agent.maxTurns);
      env.BRAINSTORM_AGENTIC_AGENT_EFFORT = agent.effort;
      env.BRAINSTORM_AGENTIC_AGENT_THINKING = agent.thinking;
      if (agent.maxBudgetUsd !== undefined) {
        env.BRAINSTORM_AGENTIC_AGENT_MAX_BUDGET_USD = String(
          agent.maxBudgetUsd,
        );
      }
      if (agent.fallbackModel) {
        env.BRAINSTORM_AGENTIC_AGENT_FALLBACK_MODEL = agent.fallbackModel;
      }
    } else {
      return env;
    }
    // Credit-recovery settings travel to BOTH online providers: the worker
    // parses them provider-agnostically, and the Messages-API path needs them
    // just as much as the Agent SDK path — its CreditBlockDetectingAgentExecutor
    // is what upgrades a provider credit failure into a schedulable
    // credit_blocked checkpoint, optionally using OpenRouter to parse the
    // reset time out of the provider's message.
    const recovery = settings.creditRecovery ?? this.get().creditRecovery;
    env.BRAINSTORM_AGENTIC_CREDIT_SAFETY_BUFFER_SECONDS = String(
      recovery.safetyBufferSeconds,
    );
    env.BRAINSTORM_AGENTIC_OPENROUTER_MODEL = recovery.openRouterModel;
    const openRouterKey = this.getOpenRouterApiKey();
    if (openRouterKey) env.OPENROUTER_API_KEY = openRouterKey;
    if (settings.llm.model) {
      env.BRAINSTORM_AGENTIC_MODEL = settings.llm.model;
    }
    // Pass enabled host tool IDs to the CLI runner
    if (settings.hostTools?.enabledToolIds) {
      env.BRAINSTORM_AGENTIC_HOST_TOOLS = settings.hostTools.enabledToolIds.join(",");
    }
    // The host-owned web layer: the JSON config (never secrets) plus each
    // configured provider key on its own variable, exactly like the LLM
    // credentials. The worker builds ONE WebAccessManager from these.
    const webSearchConfig = this.webSearchRuntimeConfig(settings);
    env.BRAINSTORM_AGENTIC_WEB_SEARCH = JSON.stringify(webSearchConfig);
    if (
      settings.webSearch?.provider === "searxng-local" &&
      webSearchConfig.searxngBaseUrl !== undefined
    ) {
      Object.assign(
        env,
        localSearxngProxyEnvironment(webSearchConfig.searxngBaseUrl, env),
      );
    }
    const tavilyKey = this.getTavilyApiKey();
    if (tavilyKey) env.TAVILY_API_KEY = tavilyKey;
    const braveKey = this.getBraveApiKey();
    if (braveKey) env.BRAVE_SEARCH_API_KEY = braveKey;
    const semanticScholarKey = this.getSemanticScholarApiKey();
    if (semanticScholarKey) env.SEMANTIC_SCHOLAR_API_KEY = semanticScholarKey;
    const openAlexKey = this.getOpenAlexApiKey();
    if (openAlexKey) env.OPENALEX_API_KEY = openAlexKey;
    const coreKey = this.getCoreApiKey();
    if (coreKey) env.CORE_API_KEY = coreKey;
    // GPU run setup travels to the worker only when it is actually
    // configured; the worker gates the tool on this AND the enabled ids.
    if (settings.gpu !== undefined && gpuProfileVerified(this.workspace, settings.gpu)) {
      env.BRAINSTORM_AGENTIC_GPU_RUN = JSON.stringify({
        template: settings.gpu.template,
        timeLimitMinutes: settings.gpu.timeLimitMinutes,
      });
    }
    for (const [route, model] of Object.entries(
      settings.llm.modelsByRoute ?? {},
    )) {
      const name = `BRAINSTORM_AGENTIC_MODEL_${route
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_")}`;
      env[name] = model;
    }
    return env;
  }

  /**
   * Overlays a PATCH onto the stored settings so validation always sees a
   * complete document.
   *
   * This is what lets one panel of the settings drawer save on its own. The
   * validator's omission rules are unforgiving by design — an absent `llm`,
   * `hostTools`, `updateCheck` or `creditRecovery` RESETS rather than keeps —
   * so a narrow payload sent straight into it would quietly wipe whatever the
   * user was not editing. Merging first means those rules never see an omission
   * at all, and the one validation path stays the only one.
   *
   * Sections are merged one level deep and no further: the leaves are flat
   * values, and a deeper merge would make it impossible to say what a submitted
   * object means (`review: {}` clears the override — that is exactly the kind
   * of distinction a generic deep merge destroys).
   */
  private mergeOverStored(value: unknown): ServerSettingsUpdate {
    const patch = object(value, "settings update");
    // Deliberately the UNCACHED read that put() has always merged against.
    const stored = validateStoredSettings(readJsonFile<unknown>(this.path));
    const section = (
      name: "llm" | "creditRecovery" | "hostTools" | "gpu" | "webSearch" | "availability",
    ): unknown => {
      if (patch[name] === undefined) return (stored as Record<string, unknown>)[name];
      const submitted = object(patch[name], name);
      const merged = {
        ...object((stored as Record<string, unknown>)[name] ?? {}, name),
        ...submitted,
      };
      // Legacy route choices have no provider key. Inheriting them on a
      // provider change can send (for example) a Claude model ID to Gemini.
      // A map explicitly submitted with the new provider remains intentional;
      // provider-scoped stage settings stay available when switching back.
      if (name === "llm" && submitted.provider !== undefined &&
          submitted.provider !== stored.llm.provider && submitted.modelsByRoute === undefined) {
        delete merged.modelsByRoute;
      }
      return merged;
    };
    const merged: Record<string, unknown> = {
      slurmTemplate: patch.slurmTemplate ?? stored.slurmTemplate,
      runner: patch.runner ?? stored.runner,
      panelConfirmation: patch.panelConfirmation ?? stored.panelConfirmation,
      gateAutoApprove: patch.gateAutoApprove ?? stored.gateAutoApprove,
      gamifiedReview: patch.gamifiedReview !== undefined ? patch.gamifiedReview : stored.gamifiedReview,
      gameReview: patch.gameReview !== undefined ? patch.gameReview : stored.gameReview,
      updateCheck: patch.updateCheck ?? stored.updateCheck,
      llm: section("llm"),
      creditRecovery: section("creditRecovery"),
      hostTools: section("hostTools"),
      gpu: section("gpu"),
      webSearch: section("webSearch"),
      // The availability policy merges like the other flat sections: a save
      // of one toggle keeps the stored interval.
      availability: section("availability"),
      interruptedRecovery: patch.interruptedRecovery ?? stored.interruptedRecovery,
      // `review` keeps its own three-way meaning: absent = keep the stored
      // policy, `{}` = follow the bundle default again, `{maxRounds}` = override.
      review: patch.review !== undefined ? patch.review : stored.review,
      // `panel` carries the same three-way meaning as `review`.
      panel: patch.panel !== undefined ? patch.panel : stored.panel,
      // So do the panel composition overrides.
      panelComposition:
        patch.panelComposition !== undefined
          ? patch.panelComposition
          : stored.panelComposition,
      telemetry: patch.telemetry ?? stored.telemetry,
    };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    return merged as ServerSettingsUpdate;
  }

  /**
   * Focused per-task-type model update from the submission-box picker.
   * Unlike put(), this never touches credentials and performs no connection
   * re-verification; entries with an empty model string mean "use the
   * default model" and are dropped.
   */
  putModelsByRoute(value: unknown): Promise<ServerSettings> {
    return this.enqueueWrite(() => this.putModelsByRouteExclusive(value));
  }

  /** Discovery and launch snapshots share the write queue so account/settings cannot race. */
  snapshotForLaunch(prepare?: (settings: ServerSettings) => Promise<ServerSettings>): Promise<ServerSettings> {
    return this.enqueueWrite(() => prepare ? prepare(this.get()) : this.get());
  }

  putStageModels(
    value: unknown,
    validate: (settings: ServerSettings, stages: Readonly<Record<string, StageModelSettings>>) => void,
  ): Promise<ServerSettings> {
    return this.enqueueWrite(() => {
      const body = object(value, "stage model update");
      const settings = this.get();
      if (body.provider !== settings.llm.provider) throw new Error("The active provider changed. Reload settings before saving stage models.");
      const stages = validateStageSettings(body.stageSettings);
      validate(settings, stages);
      const stored = validateStoredSettings(readJsonFile<unknown>(this.path));
      atomicWriteJson(this.path, { ...stored, llm: { ...stored.llm, stageSettingsByProvider: {
        ...stored.llm.stageSettingsByProvider, [settings.llm.provider]: stages,
      } } });
      return this.get();
    });
  }

  private putModelsByRouteExclusive(value: unknown): ServerSettings {
    const body = object(value, "models-by-route update");
    const raw = object(body.modelsByRoute ?? {}, "modelsByRoute");
    const map: Record<string, string> = {};
    for (const [route, model] of Object.entries(raw)) {
      if (route.trim().length === 0) {
        throw new Error("modelsByRoute keys must be task-type names");
      }
      if (typeof model !== "string") {
        throw new Error(`modelsByRoute.${route} must be a string`);
      }
      const trimmed = model.trim();
      if (trimmed.length > 0) map[route] = trimmed;
    }
    const stored = validateStoredSettings(readJsonFile<unknown>(this.path));
    const llm: StoredLlmSettings = { ...stored.llm };
    if (Object.keys(map).length > 0) {
      (llm as { modelsByRoute?: Record<string, string> }).modelsByRoute = map;
    } else {
      delete (llm as { modelsByRoute?: Record<string, string> }).modelsByRoute;
    }
    atomicWriteJson(this.path, { ...stored, llm });
    return this.get();
  }

  /**
   * Serializes writes. Every write is read-modify-write over one JSON document,
   * and per-section saving means several can be in flight at once — two
   * concurrent saves that both read before either wrote would silently drop one
   * section's change. Queueing them costs nothing at this rate.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private enqueueWrite(
    write: () => ServerSettings | Promise<ServerSettings>,
  ): Promise<ServerSettings> {
    const run = this.writeQueue.then(
      write,
      write,
    );
    // The queue must not reject for the next waiter, but the caller still must
    // see its own failure.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  put(value: unknown): Promise<ServerSettings> {
    return this.enqueueWrite(() => this.putExclusive(value));
  }

  /** Called only by the approved probe service, serialized with ordinary edits. */
  installVerifiedGpu(gpu: GpuRunSettings, jobId: string, signal?: AbortSignal, expectedRevision?: number): Promise<ServerSettings> {
    return this.enqueueWrite(async () => {
      signal?.throwIfAborted();
      if (expectedRevision !== undefined && expectedRevision !== this.gpuRevision) throw new Error("GPU settings changed while the probe ran; review and probe the new profile");
      const enabled = new Set(this.get().hostTools?.enabledToolIds ?? []);
      enabled.add("gpu_run");
      const settings = await this.putExclusive({ gpu, hostTools: { enabledToolIds: [...enabled] } });
      signal?.throwIfAborted();
      verifyGpuProfile(this.workspace, gpu, jobId);
      return settings;
    });
  }

  private async putExclusive(value: unknown): Promise<ServerSettings> {
    const update = validateSettingsUpdate(this.mergeOverStored(value));
    const currentSettings = this.get();
    const currentKey = this.getAnthropicApiKey();
    const currentSetupToken = this.getClaudeSetupToken();
    const currentCursorKey = this.getCursorApiKey();
    const currentGeminiKey = this.getGeminiApiKey();
    const currentOpenRouterKey = this.getOpenRouterApiKey();
    const candidateKey = update.submittedApiKey ?? currentKey;
    const candidateGeminiKey = update.submittedGeminiApiKey ?? currentGeminiKey;
    const candidateSetupToken =
      update.submittedSetupToken ?? currentSetupToken;
    const candidateCursorKey =
      update.submittedCursorApiKey ?? currentCursorKey;
    /**
     * Whether this update actually changes the model connection. Verification
     * is a real request to the provider and costs seconds, so it runs when — and
     * only when — something it could disprove has changed: a freshly submitted
     * secret, or a different provider, model, or base URL.
     *
     * Verifying unconditionally is what made every unrelated save slow and
     * mislabelled: changing the review-round budget re-tested the Claude token
     * and then reported "token verified" as if that had been the edit.
     */
    const connectionChanged =
      update.submittedApiKey !== undefined ||
      update.submittedSetupToken !== undefined ||
      update.submittedCursorApiKey !== undefined ||
      update.submittedGeminiApiKey !== undefined ||
      update.settings.llm.provider !== currentSettings.llm.provider ||
      update.settings.llm.model !== currentSettings.llm.model ||
      update.settings.llm.baseUrl !== currentSettings.llm.baseUrl;
    if (update.settings.llm.provider === "anthropic") {
      // The credential REQUIREMENT is checked either way: selecting a provider
      // with nothing to authenticate as must fail loudly, verified or not.
      if (!candidateKey) {
        throw new Error("An Anthropic API key is required");
      }
      if (connectionChanged) {
        await this.connectionValidator({
          apiKey: candidateKey,
          model: update.settings.llm.model!,
          ...(update.settings.llm.baseUrl !== undefined
            ? { baseUrl: update.settings.llm.baseUrl }
            : {}),
        });
      }
    }
    if (update.settings.llm.provider === "gemini") {
      if (!candidateGeminiKey) throw new Error("A Gemini API key is required");
      if (connectionChanged) await this.geminiValidator({ apiKey: candidateGeminiKey, model: update.settings.llm.model!, ...(update.settings.llm.baseUrl ? { baseUrl: update.settings.llm.baseUrl } : {}) });
    }
    if (update.settings.llm.provider === "claude-agent") {
      if (!candidateSetupToken) {
        throw new Error("A Claude setup token is required");
      }
      if (connectionChanged) {
        await this.claudeAgentValidator({
          token: candidateSetupToken,
          ...(update.settings.llm.model !== undefined
            ? { model: update.settings.llm.model }
            : {}),
        });
      }
    }
    if (update.settings.llm.provider === "cursor-agent") {
      if (!candidateCursorKey) {
        throw new Error("A Cursor API key is required");
      }
      if (connectionChanged) {
        await this.cursorAgentValidator({
          apiKey: candidateCursorKey,
          ...(update.settings.llm.model !== undefined
            ? { model: update.settings.llm.model }
            : {}),
        });
      }
    }
    if (update.submittedOpenRouterApiKey !== undefined) {
      await this.openRouterValidator(
        update.submittedOpenRouterApiKey,
        update.settings.creditRecovery.openRouterModel,
      );
    }
    // The general-search connection is verified exactly like the LLM one:
    // when — and only when — something a real request could disprove has
    // changed (a newly submitted key, a different provider, a different
    // SearXNG base URL). The scholarly keys (Semantic Scholar, OpenAlex) are
    // optional rate-limit raisers over keyless services and are stored
    // without a live call.
    {
      const webSettings = update.settings.webSearch ?? {
        provider: "none" as const,
        scholarly: true,
        cacheEnabled: false,
      };
      const currentWeb = currentSettings.webSearch;
      const provider = webSettings.provider;
      // "searxng-local" is deliberately NOT verified here: its first start
      // may download and convert the search image for minutes, and a
      // settings save must never block that long. The launcher owns its
      // health — the save selects it, the server starts it in the
      // background, and the readiness panel reports its state.
      if (provider === "tavily" || provider === "brave" || provider === "searxng") {
        const submittedKey =
          provider === "tavily"
            ? update.submittedTavilyApiKey
            : provider === "brave"
              ? update.submittedBraveApiKey
              : undefined;
        const currentKey =
          provider === "tavily"
            ? this.getTavilyApiKey()
            : provider === "brave"
              ? this.getBraveApiKey()
              : undefined;
        const candidateWebKey = submittedKey ?? currentKey;
        if (provider !== "searxng" && candidateWebKey === undefined) {
          throw new Error(
            `A ${provider === "tavily" ? "Tavily" : "Brave Search"} API key is required`,
          );
        }
        const webConnectionChanged =
          submittedKey !== undefined ||
          provider !== (currentWeb?.provider ?? "none") ||
          webSettings.searxngBaseUrl !== currentWeb?.searxngBaseUrl;
        if (webConnectionChanged) {
          await this.webSearchValidator({
            provider,
            ...(candidateWebKey !== undefined ? { apiKey: candidateWebKey } : {}),
            ...(webSettings.searxngBaseUrl !== undefined
              ? { searxngBaseUrl: webSettings.searxngBaseUrl }
              : {}),
          });
        }
      }
      // The paid fallback's key, submitted without selecting Brave as the
      // provider, is verified the same way before it is stored.
      if (provider !== "brave" && update.submittedBraveApiKey !== undefined) {
        await this.webSearchValidator({ provider: "brave", apiKey: update.submittedBraveApiKey });
      }
    }

    // Persist only after every validation (including the real provider call)
    // succeeded. Secrets are never written to settings.json. An update that
    // omitted interruptedRecovery keeps the currently stored policy, and the
    // deployment-owned contentRegistry is always carried forward unchanged —
    // whatever an update submitted for it is ignored.
    const storedRegistry = validateStoredSettings(
      readJsonFile<unknown>(this.path),
    ).contentRegistry;
    const carriedGpu = update.settings.gpu ?? currentSettings.gpu;
    if (carriedGpu && (!currentSettings.gpu || gpuProfileDigest(carriedGpu) !== gpuProfileDigest(currentSettings.gpu))) {
      this.gpuRevision += 1;
      revokeGpuProfile(this.workspace);
    }
    // Review policy: absent in the update keeps the stored value; a
    // submitted `{}` clears the override (back to the bundle default).
    const carriedReview =
      update.review !== undefined
        ? update.review.maxRounds !== undefined
          ? { maxRounds: update.review.maxRounds }
          : undefined
        : currentSettings.review;
    // Panel policy: the same three-way meaning, over two fields — an update
    // that submitted `{}` clears both the size override and the seat toggle.
    const carriedPanel =
      update.panel !== undefined
        ? Object.keys(update.panel).length > 0
          ? update.panel
          : undefined
        : currentSettings.panel;
    // Panel composition overrides: the same three-way meaning; `{params: {}}`
    // (or `{}`) clears them all.
    const carriedComposition =
      update.panelComposition !== undefined
        ? Object.keys(update.panelComposition.params).length > 0
          ? update.panelComposition
          : undefined
        : panelCompositionOf(currentSettings);
    atomicWriteJson(this.path, {
      ...update.settings,
      contentRegistry: { ...storedRegistry, url: this.deploymentRegistryUrl },
      interruptedRecovery:
        update.settings.interruptedRecovery ??
        currentSettings.interruptedRecovery ?? { autoResume: true },
      // An update that omitted the GPU section keeps the stored setup.
      ...(carriedGpu !== undefined ? { gpu: carriedGpu } : {}),
      ...(carriedReview !== undefined ? { review: carriedReview } : {}),
      ...(carriedPanel !== undefined ? { panel: carriedPanel } : {}),
      ...(carriedComposition !== undefined ? { panelComposition: carriedComposition } : {}),
    });
    const previousCredentials =
      readJsonFile<StoredCredentials>(this.credentialsPath) ?? {};
    const nextCredentials: {
      anthropicApiKey?: string;
      claudeSetupToken?: string;
      cursorApiKey?: string;
      geminiApiKey?: string;
      openRouterApiKey?: string;
      tavilyApiKey?: string;
      braveApiKey?: string;
      semanticScholarApiKey?: string;
      openAlexApiKey?: string;
      coreApiKey?: string;
    } = { ...previousCredentials };
    if (update.clearApiKey) delete nextCredentials.anthropicApiKey;
    if (update.clearSetupToken) delete nextCredentials.claudeSetupToken;
    if (update.clearCursorApiKey) delete nextCredentials.cursorApiKey;
    if (update.clearGeminiApiKey) delete nextCredentials.geminiApiKey;
    if (update.clearOpenRouterApiKey) {
      delete nextCredentials.openRouterApiKey;
    }
    if (update.clearTavilyApiKey) delete nextCredentials.tavilyApiKey;
    if (update.clearBraveApiKey) delete nextCredentials.braveApiKey;
    if (update.clearSemanticScholarApiKey) {
      delete nextCredentials.semanticScholarApiKey;
    }
    if (update.clearOpenAlexApiKey) delete nextCredentials.openAlexApiKey;
    if (update.clearCoreApiKey) delete nextCredentials.coreApiKey;
    if (update.submittedApiKey !== undefined) {
      nextCredentials.anthropicApiKey = update.submittedApiKey;
    }
    if (update.submittedSetupToken !== undefined) {
      nextCredentials.claudeSetupToken = update.submittedSetupToken;
    }
    if (update.submittedCursorApiKey !== undefined) {
      nextCredentials.cursorApiKey = update.submittedCursorApiKey;
    }
    if (update.submittedGeminiApiKey !== undefined) nextCredentials.geminiApiKey = update.submittedGeminiApiKey;
    if (update.submittedOpenRouterApiKey !== undefined) {
      nextCredentials.openRouterApiKey =
        update.submittedOpenRouterApiKey;
    } else if (currentOpenRouterKey && !update.clearOpenRouterApiKey) {
      // Guarded on the clear flag: without that guard this restored the key the
      // clear above had just deleted (currentOpenRouterKey is read before it),
      // so a user could never actually remove their OpenRouter key.
      nextCredentials.openRouterApiKey ??= currentOpenRouterKey;
    }
    if (update.submittedTavilyApiKey !== undefined) {
      nextCredentials.tavilyApiKey = update.submittedTavilyApiKey;
    }
    if (update.submittedBraveApiKey !== undefined) {
      nextCredentials.braveApiKey = update.submittedBraveApiKey;
    }
    if (update.submittedSemanticScholarApiKey !== undefined) {
      nextCredentials.semanticScholarApiKey =
        update.submittedSemanticScholarApiKey;
    }
    if (update.submittedOpenAlexApiKey !== undefined) {
      nextCredentials.openAlexApiKey = update.submittedOpenAlexApiKey;
    }
    // Stored without a live call, like the other scholarly keys (no key was
    // available to verify against; not live-tested).
    if (update.submittedCoreApiKey !== undefined) {
      nextCredentials.coreApiKey = update.submittedCoreApiKey;
    }
    if (Object.keys(nextCredentials).length === 0) {
      if (existsSync(this.credentialsPath)) rmSync(this.credentialsPath);
    } else {
      atomicWriteFile(
        this.credentialsPath,
        `${JSON.stringify(nextCredentials satisfies StoredCredentials, null, 2)}\n`,
        0o600,
      );
      chmodSync(this.credentialsPath, 0o600);
    }
    return this.get();
  }
}
