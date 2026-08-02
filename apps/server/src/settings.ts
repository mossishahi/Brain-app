import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { userMessage } from "@brainstorm-agentic/core";
import {
  validateClaudeSetupToken,
} from "@brainstorm-agentic/executor-claude-agent";
import { AnthropicMessagesProvider } from "@brainstorm-agentic/provider-anthropic";
import { ContentRegistryClient } from "@brainstorm-agentic/registry-client";
import {
  SLURM_COMMAND_TAG,
  type ClaudeAgentSettings,
  type LlmSettings,
  type ServerSettings,
  type ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";

import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./files.js";

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
type StoredServerSettings = Omit<
  ServerSettings,
  "llm" | "creditRecovery"
> & {
  readonly llm: StoredLlmSettings;
  readonly creditRecovery: StoredCreditRecovery;
};

interface StoredCredentials {
  readonly anthropicApiKey?: string;
  readonly claudeSetupToken?: string;
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

export interface SettingsStoreOptions {
  readonly validateAnthropic?: AnthropicConnectionValidator;
  readonly validateClaudeAgent?: ClaudeAgentConnectionValidator;
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

export function defaultServerSettings(
  contentRegistryUrl = DEFAULT_CONTENT_REGISTRY_URL,
): ServerSettings {
  return {
    runner: "slurm",
    panelConfirmation: "manual",
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
      enabledToolIds: ["attachment_list", "attachment_read"],
    },
    slurmTemplate: DEFAULT_SLURM_TEMPLATE,
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
  readonly runner: "slurm" | "local";
  readonly panelConfirmation: "manual" | "auto";
  readonly llm: Record<string, unknown>;
  readonly creditRecovery: Record<string, unknown>;
  readonly interruptedRecovery?: Record<string, unknown>;
  readonly contentRegistry: Record<string, unknown>;
  readonly hostTools?: Record<string, unknown>;
  readonly updateCheck?: "off" | "notify";
} {
  const input = object(value, "settings");
  const template = input.slurmTemplate;
  if (typeof template !== "string" || !template.includes(SLURM_COMMAND_TAG)) {
    throw new Error(`slurmTemplate must contain ${SLURM_COMMAND_TAG}`);
  }
  if (input.runner !== "slurm" && input.runner !== "local") {
    throw new Error('runner must be "slurm" or "local"');
  }
  if (
    input.panelConfirmation !== "manual" &&
    input.panelConfirmation !== "auto"
  ) {
    throw new Error('panelConfirmation must be "manual" or "auto"');
  }
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
    llm.provider !== "offline"
  ) {
    throw new Error(
      'llm.provider must be "anthropic", "claude-agent", or "offline"',
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
    runner: input.runner,
    panelConfirmation: input.panelConfirmation,
    llm,
    creditRecovery,
    ...(interruptedRecovery !== undefined ? { interruptedRecovery } : {}),
    contentRegistry,
    hostTools,
    ...(updateCheck !== undefined ? { updateCheck } : {}),
  };
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
  return { enabledToolIds: ids as string[] };
}

function validateStoredSettings(value: unknown): StoredServerSettings {
  const common = validateCommonSettings(value);
  const provider = common.llm.provider as
    | "anthropic"
    | "claude-agent"
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
    runner: common.runner,
    panelConfirmation: common.panelConfirmation,
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
  readonly clearApiKey: boolean;
  readonly clearSetupToken: boolean;
  readonly submittedOpenRouterApiKey?: string;
  readonly clearOpenRouterApiKey: boolean;
}

function validateSettingsUpdate(value: unknown): ValidatedUpdate {
  const common = validateCommonSettings(value);
  const provider = common.llm.provider as
    | "anthropic"
    | "claude-agent"
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
  if (provider !== "anthropic" && submittedApiKey !== undefined) {
    throw new Error("select Anthropic before setting an API key");
  }
  if (provider !== "claude-agent" && submittedSetupToken !== undefined) {
    throw new Error(
      "select Claude Agent SDK before setting a setup token",
    );
  }
  if (provider === "anthropic" && clearApiKey) {
    throw new Error("cannot clear the API key while Anthropic is selected");
  }
  if (provider === "claude-agent" && clearSetupToken) {
    throw new Error(
      "cannot clear the setup token while Claude Agent SDK is selected",
    );
  }
  if (provider === "claude-agent" && baseUrl !== undefined) {
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
      runner: common.runner,
      panelConfirmation: common.panelConfirmation,
      ...(common.updateCheck !== undefined ? { updateCheck: common.updateCheck } : {}),
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
    clearApiKey,
    clearSetupToken,
    ...(submittedOpenRouterApiKey !== undefined
      ? { submittedOpenRouterApiKey }
      : {}),
    clearOpenRouterApiKey:
      common.creditRecovery.clearOpenRouterApiKey === true,
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
    const settings = validateStoredSettings(readJsonFile<unknown>(this.path));
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
      },
      creditRecovery: {
        ...settings.creditRecovery,
        openRouterKeyConfigured:
          this.getOpenRouterApiKey() !== undefined,
      },
    };
  }

  getAnthropicApiKey(): string | undefined {
    const key = readJsonFile<StoredCredentials>(
      this.credentialsPath,
    )?.anthropicApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  getClaudeSetupToken(): string | undefined {
    const token = readJsonFile<StoredCredentials>(
      this.credentialsPath,
    )?.claudeSetupToken;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  }

  getOpenRouterApiKey(): string | undefined {
    const key = readJsonFile<StoredCredentials>(
      this.credentialsPath,
    )?.openRouterApiKey;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  }

  executionEnvironment(
    base: NodeJS.ProcessEnv,
    settings: ServerSettings = this.get(),
  ): NodeJS.ProcessEnv {
    const env = { ...base };
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
      const recovery =
        settings.creditRecovery ?? this.get().creditRecovery;
      env.BRAINSTORM_AGENTIC_CREDIT_SAFETY_BUFFER_SECONDS = String(
        recovery.safetyBufferSeconds,
      );
      env.BRAINSTORM_AGENTIC_OPENROUTER_MODEL =
        recovery.openRouterModel;
      const openRouterKey = this.getOpenRouterApiKey();
      if (openRouterKey) env.OPENROUTER_API_KEY = openRouterKey;
    } else {
      return env;
    }
    if (settings.llm.model) {
      env.BRAINSTORM_AGENTIC_MODEL = settings.llm.model;
    }
    // Pass enabled host tool IDs to the CLI runner
    if (settings.hostTools?.enabledToolIds) {
      env.BRAINSTORM_AGENTIC_HOST_TOOLS = settings.hostTools.enabledToolIds.join(",");
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

  async put(value: unknown): Promise<ServerSettings> {
    const update = validateSettingsUpdate(value as ServerSettingsUpdate);
    const currentSettings = this.get();
    const currentKey = this.getAnthropicApiKey();
    const currentSetupToken = this.getClaudeSetupToken();
    const currentOpenRouterKey = this.getOpenRouterApiKey();
    const candidateKey = update.submittedApiKey ?? currentKey;
    const candidateSetupToken =
      update.submittedSetupToken ?? currentSetupToken;
    if (update.settings.llm.provider === "anthropic") {
      if (!candidateKey) {
        throw new Error("An Anthropic API key is required");
      }
      await this.connectionValidator({
        apiKey: candidateKey,
        model: update.settings.llm.model!,
        ...(update.settings.llm.baseUrl !== undefined
          ? { baseUrl: update.settings.llm.baseUrl }
          : {}),
      });
    }
    if (update.settings.llm.provider === "claude-agent") {
      if (!candidateSetupToken) {
        throw new Error("A Claude setup token is required");
      }
      await this.claudeAgentValidator({
        token: candidateSetupToken,
        ...(update.settings.llm.model !== undefined
          ? { model: update.settings.llm.model }
          : {}),
      });
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
    atomicWriteJson(this.path, {
      ...update.settings,
      contentRegistry: { ...storedRegistry, url: this.deploymentRegistryUrl },
      interruptedRecovery:
        update.settings.interruptedRecovery ??
        currentSettings.interruptedRecovery ?? { autoResume: true },
    });
    const previousCredentials =
      readJsonFile<StoredCredentials>(this.credentialsPath) ?? {};
    const nextCredentials: {
      anthropicApiKey?: string;
      claudeSetupToken?: string;
      openRouterApiKey?: string;
    } = { ...previousCredentials };
    if (update.clearApiKey) delete nextCredentials.anthropicApiKey;
    if (update.clearSetupToken) delete nextCredentials.claudeSetupToken;
    if (update.clearOpenRouterApiKey) {
      delete nextCredentials.openRouterApiKey;
    }
    if (update.submittedApiKey !== undefined) {
      nextCredentials.anthropicApiKey = update.submittedApiKey;
    }
    if (update.submittedSetupToken !== undefined) {
      nextCredentials.claudeSetupToken = update.submittedSetupToken;
    }
    if (update.submittedOpenRouterApiKey !== undefined) {
      nextCredentials.openRouterApiKey =
        update.submittedOpenRouterApiKey;
    } else if (currentOpenRouterKey) {
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
