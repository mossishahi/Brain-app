import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { userMessage } from "@brainstorm-agentic/core";
import {
  validateClaudeSetupToken,
} from "@brainstorm-agentic/executor-claude-agent";
import {
  validateCursorApiKey,
} from "@brainstorm-agentic/executor-cursor-agent";
import { AnthropicMessagesProvider } from "@brainstorm-agentic/provider-anthropic";
import { ContentRegistryClient } from "@brainstorm-agentic/registry-client";
import {
  GPU_COMMAND_TAG,
  SLURM_COMMAND_TAG,
  type ClaudeAgentSettings,
  type GpuRunSettings,
  type LlmSettings,
  type ServerSettings,
  type ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";

import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./files.js";
import { readJsonCached } from "./read-cache.js";

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
export const DEFAULT_CLAUDE_AGENT_SETTINGS: ClaudeAgentSettings = {
  maxTurns: 100,
  effort: "high",
  thinking: "adaptive",
};

type StoredLlmSettings = Omit<
  LlmSettings,
  "apiKeyConfigured" | "setupTokenConfigured"
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
type StoredServerSettings = Omit<
  ServerSettings,
  "llm" | "creditRecovery" | "telemetry"
> & {
  readonly llm: StoredLlmSettings;
  readonly creditRecovery: StoredCreditRecovery;
  readonly telemetry?: StoredTelemetry;
};

interface StoredCredentials {
  readonly anthropicApiKey?: string;
  readonly claudeSetupToken?: string;
  readonly cursorApiKey?: string;
  readonly openRouterApiKey?: string;
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

export interface SettingsStoreOptions {
  readonly validateAnthropic?: AnthropicConnectionValidator;
  readonly validateClaudeAgent?: ClaudeAgentConnectionValidator;
  readonly validateCursorAgent?: CursorAgentConnectionValidator;
  readonly validateOpenRouter?: (
    apiKey: string,
    model: string,
  ) => Promise<void>;
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

function validateCommonSettings(value: unknown): {
  readonly slurmTemplate: string;
  readonly gpu?: GpuRunSettings;
  readonly runner: "slurm" | "local";
  readonly panelConfirmation: "manual" | "auto";
  readonly gateAutoApprove: boolean;
  readonly review?: { readonly maxRounds?: number };
  readonly panel?: { readonly size?: number; readonly interdisciplinarySeat?: boolean };
  readonly llm: Record<string, unknown>;
  readonly creditRecovery: Record<string, unknown>;
  readonly interruptedRecovery?: Record<string, unknown>;
  readonly contentRegistry: Record<string, unknown>;
  readonly hostTools?: Record<string, unknown>;
  readonly updateCheck?: "off" | "notify";
  readonly telemetry?: Record<string, unknown>;
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
    llm.provider !== "offline"
  ) {
    throw new Error(
      'llm.provider must be "anthropic", "claude-agent", "cursor-agent", or "offline"',
    );
  }
  const hostTools =
    input.hostTools !== undefined
      ? object(input.hostTools, "hostTools")
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
    ...(review !== undefined ? { review } : {}),
    ...(panel !== undefined ? { panel } : {}),
    llm,
    creditRecovery,
    ...(interruptedRecovery !== undefined ? { interruptedRecovery } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    contentRegistry,
    hostTools,
    ...(updateCheck !== undefined ? { updateCheck } : {}),
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
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh" &&
    effort !== "max"
  ) {
    throw new Error(
      'llm.agentSdk.effort must be "low", "medium", "high", "xhigh", or "max"',
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
    | "offline";
  const model =
    optionalNonEmptyString(common.llm.model, "llm.model") ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : undefined);
  const baseUrl = optionalNonEmptyString(common.llm.baseUrl, "llm.baseUrl");
  const modelsByRoute = validateModelsByRoute(common.llm.modelsByRoute);
  const agentSdk = validateClaudeAgentSettings(common.llm.agentSdk);
  const creditRecovery = validateCreditRecovery(common.creditRecovery);
  const interruptedRecovery = validateInterruptedRecovery(common.interruptedRecovery);
  const contentRegistry = validateContentRegistry(common.contentRegistry);
  const hostTools = validateHostTools(common.hostTools);
  return {
    slurmTemplate: common.slurmTemplate,
    ...(common.gpu !== undefined ? { gpu: common.gpu } : {}),
    runner: common.runner,
    panelConfirmation: common.panelConfirmation,
    gateAutoApprove: common.gateAutoApprove,
    // Stored only when it actually overrides; `{}` normalizes to absent.
    ...(common.review?.maxRounds !== undefined
      ? { review: { maxRounds: common.review.maxRounds } }
      : {}),
    ...(common.panel !== undefined && Object.keys(common.panel).length > 0
      ? { panel: common.panel }
      : {}),
    contentRegistry,
    creditRecovery,
    interruptedRecovery,
    llm: {
      provider,
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(modelsByRoute !== undefined ? { modelsByRoute } : {}),
      agentSdk,
    },
    ...(hostTools !== undefined ? { hostTools } : {}),
    ...(common.updateCheck !== undefined ? { updateCheck: common.updateCheck } : {}),
    // Only the enabled flag is the user's; get() recomputes the deployment-owned
    // ingest URL on every read, so storing it would go stale.
    ...(common.telemetry !== undefined
      ? { telemetry: { enabled: common.telemetry.enabled === true } }
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
  readonly clearApiKey: boolean;
  readonly clearSetupToken: boolean;
  readonly clearCursorApiKey: boolean;
  readonly submittedOpenRouterApiKey?: string;
  readonly clearOpenRouterApiKey: boolean;
  /**
   * As submitted, so put() can tell the three cases apart: absent = keep
   * the stored policy, `{}` = back to the bundle default, `{maxRounds}` =
   * override. Deliberately not part of `settings` (a spread would erase
   * the distinction).
   */
  readonly review?: { readonly maxRounds?: number };
  /** Same three-way meaning as `review`, for the panel policy. */
  readonly panel?: { readonly size?: number; readonly interdisciplinarySeat?: boolean };
}

function validateSettingsUpdate(value: unknown): ValidatedUpdate {
  const common = validateCommonSettings(value);
  const provider = common.llm.provider as
    | "anthropic"
    | "claude-agent"
    | "cursor-agent"
    | "offline";
  const model = optionalNonEmptyString(common.llm.model, "llm.model");
  if (provider === "anthropic" && model === undefined) {
    throw new Error("llm.model is required for Anthropic");
  }
  const baseUrl = optionalNonEmptyString(common.llm.baseUrl, "llm.baseUrl");
  const submittedApiKey = optionalNonEmptyString(
    common.llm.apiKey,
    "llm.apiKey",
  );
  const submittedSetupToken = optionalNonEmptyString(
    common.llm.setupToken,
    "llm.setupToken",
  );
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
    throw new Error("llm.baseUrl is only supported by the developer API");
  }
  const modelsByRoute = validateModelsByRoute(common.llm.modelsByRoute);
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
  return {
    settings: {
      slurmTemplate: common.slurmTemplate,
      ...(common.gpu !== undefined ? { gpu: common.gpu } : {}),
      runner: common.runner,
      panelConfirmation: common.panelConfirmation,
      gateAutoApprove: common.gateAutoApprove,
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
        agentSdk,
      },
      ...(hostTools !== undefined ? { hostTools } : {}),
    },
    ...(submittedApiKey !== undefined ? { submittedApiKey } : {}),
    ...(submittedSetupToken !== undefined ? { submittedSetupToken } : {}),
    ...(submittedCursorApiKey !== undefined ? { submittedCursorApiKey } : {}),
    clearApiKey,
    clearSetupToken,
    clearCursorApiKey,
    ...(submittedOpenRouterApiKey !== undefined
      ? { submittedOpenRouterApiKey }
      : {}),
    clearOpenRouterApiKey:
      common.creditRecovery.clearOpenRouterApiKey === true,
    ...(common.review !== undefined ? { review: common.review } : {}),
    ...(common.panel !== undefined ? { panel: common.panel } : {}),
  };
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
      token: input.token,
      ...(input.model !== undefined ? { model: input.model } : {}),
      timeoutMs: CONNECTION_TIMEOUT_MS,
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
  private readonly openRouterValidator: (
    apiKey: string,
    model: string,
  ) => Promise<void>;

  constructor(
    readonly workspace: string,
    options: SettingsStoreOptions = {},
  ) {
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
    this.openRouterValidator =
      options.validateOpenRouter ?? validateOpenRouterConnection;
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
            defaultServerSettings(this.deploymentRegistryUrl),
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
    return typeof token === "string" && token.length > 0 ? token : undefined;
  }

  getCursorApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(
      this.credentialsPath,
    )?.cursorApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getOpenRouterApiKey(): string | undefined {
    const key = readJsonCached<StoredCredentials>(
      this.credentialsPath,
    )?.openRouterApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  executionEnvironment(
    base: NodeJS.ProcessEnv,
    settings: ServerSettings = this.get(),
  ): NodeJS.ProcessEnv {
    const env = { ...base };
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
    // GPU run setup travels to the worker only when it is actually
    // configured; the worker gates the tool on this AND the enabled ids.
    if (settings.gpu !== undefined && settings.gpu.template.trim() !== "") {
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
    // Lossless JSON form of the per-route map; the worker prefers it over
    // the mangled legacy variables above.
    const modelsByRoute = settings.llm.modelsByRoute ?? {};
    if (Object.keys(modelsByRoute).length > 0) {
      env.BRAINSTORM_AGENTIC_MODELS_BY_ROUTE = JSON.stringify(modelsByRoute);
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
    const section = (name: "llm" | "creditRecovery" | "hostTools" | "gpu"): unknown => {
      if (patch[name] === undefined) return (stored as Record<string, unknown>)[name];
      return {
        ...object((stored as Record<string, unknown>)[name] ?? {}, name),
        ...object(patch[name], name),
      };
    };
    const merged: Record<string, unknown> = {
      slurmTemplate: patch.slurmTemplate ?? stored.slurmTemplate,
      runner: patch.runner ?? stored.runner,
      panelConfirmation: patch.panelConfirmation ?? stored.panelConfirmation,
      gateAutoApprove: patch.gateAutoApprove ?? stored.gateAutoApprove,
      updateCheck: patch.updateCheck ?? stored.updateCheck,
      llm: section("llm"),
      creditRecovery: section("creditRecovery"),
      hostTools: section("hostTools"),
      gpu: section("gpu"),
      interruptedRecovery: patch.interruptedRecovery ?? stored.interruptedRecovery,
      // `review` keeps its own three-way meaning: absent = keep the stored
      // policy, `{}` = follow the bundle default again, `{maxRounds}` = override.
      review: patch.review !== undefined ? patch.review : stored.review,
      // `panel` carries the same three-way meaning as `review`.
      panel: patch.panel !== undefined ? patch.panel : stored.panel,
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
  putModelsByRoute(value: unknown): ServerSettings {
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

  async put(value: unknown): Promise<ServerSettings> {
    const run = this.writeQueue.then(
      () => this.putExclusive(value),
      () => this.putExclusive(value),
    );
    // The queue must not reject for the next waiter, but the caller still must
    // see its own failure.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async putExclusive(value: unknown): Promise<ServerSettings> {
    const update = validateSettingsUpdate(this.mergeOverStored(value));
    const currentSettings = this.get();
    const currentKey = this.getAnthropicApiKey();
    const currentSetupToken = this.getClaudeSetupToken();
    const currentCursorKey = this.getCursorApiKey();
    const currentOpenRouterKey = this.getOpenRouterApiKey();
    const candidateKey = update.submittedApiKey ?? currentKey;
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

    // Persist only after every validation (including the real provider call)
    // succeeded. Secrets are never written to settings.json. An update that
    // omitted interruptedRecovery keeps the currently stored policy, and the
    // deployment-owned contentRegistry is always carried forward unchanged —
    // whatever an update submitted for it is ignored.
    const storedRegistry = validateStoredSettings(
      readJsonFile<unknown>(this.path),
    ).contentRegistry;
    const carriedGpu = update.settings.gpu ?? currentSettings.gpu;
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
    });
    const previousCredentials =
      readJsonFile<StoredCredentials>(this.credentialsPath) ?? {};
    const nextCredentials: {
      anthropicApiKey?: string;
      claudeSetupToken?: string;
      cursorApiKey?: string;
      openRouterApiKey?: string;
    } = { ...previousCredentials };
    if (update.clearApiKey) delete nextCredentials.anthropicApiKey;
    if (update.clearSetupToken) delete nextCredentials.claudeSetupToken;
    if (update.clearCursorApiKey) delete nextCredentials.cursorApiKey;
    if (update.clearOpenRouterApiKey) {
      delete nextCredentials.openRouterApiKey;
    }
    if (update.submittedApiKey !== undefined) {
      nextCredentials.anthropicApiKey = update.submittedApiKey;
    }
    if (update.submittedSetupToken !== undefined) {
      nextCredentials.claudeSetupToken = update.submittedSetupToken;
    }
    if (update.submittedCursorApiKey !== undefined) {
      nextCredentials.cursorApiKey = update.submittedCursorApiKey;
    }
    if (update.submittedOpenRouterApiKey !== undefined) {
      nextCredentials.openRouterApiKey =
        update.submittedOpenRouterApiKey;
    } else if (currentOpenRouterKey && !update.clearOpenRouterApiKey) {
      // Guarded on the clear flag: without that guard this restored the key the
      // clear above had just deleted (currentOpenRouterKey is read before it),
      // so a user could never actually remove their OpenRouter key.
      nextCredentials.openRouterApiKey ??= currentOpenRouterKey;
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
