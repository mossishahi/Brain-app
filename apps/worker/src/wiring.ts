/**
 * Deployment wiring: turns configuration (environment/flags) into a ready
 * BrainstormRuntime. Providers are chosen here — never in content or core.
 */
import {
  ToolLoopAgentExecutor,
  type ModelRoute,
  type ModelRouteResolver,
} from "@brainstorm-agentic/agent-runtime";
import {
  BrainstormAgentTaskAdapter,
  BrainstormRuntime,
  ContentArtifactOutputValidator,
  StaticBrainstormRouteResolver,
  StaticCapabilityToolResolver,
  type ResolvedBrainstormRoute,
} from "@brainstorm-agentic/brainstorm-runtime";
import {
  InMemoryToolRegistry,
  type AgentExecutor,
  type AgentTask,
  type ArtifactStore,
  type CheckpointStore,
  type RunEventListener,
} from "@brainstorm-agentic/core";
import type { ContentBundle } from "@brainstorm-agentic/content";
import { ClaudeAgentExecutor } from "@brainstorm-agentic/executor-claude-agent";
import { AnthropicMessagesProvider } from "@brainstorm-agentic/provider-anthropic";

import { attachmentTools, ATTACHMENT_TOOL_NAMES } from "./attachment-tools.js";
import {
  ALL_HOST_TOOL_MANIFESTS,
  ATTACHMENT_MANIFESTS,
  createHostToolRegistry,
} from "@brainstorm-agentic/host-tools";
import { OfflineBrainstormExecutor } from "./offline-executor.js";

export interface ProviderConfig {
  /** Developer API, Claude Agent SDK setup-token, or deterministic offline. */
  readonly provider: "anthropic" | "claude-agent" | "offline";
  /** Model id per logical content route (reasoning/writing/balanced). */
  readonly models?: Readonly<Record<string, string>>;
  /** Fallback model id when a route has no explicit entry. */
  readonly defaultModel?: string;
  readonly apiKey?: string;
  readonly setupToken?: string;
  readonly agentSdk?: {
    readonly maxTurns?: number;
    readonly maxBudgetUsd?: number;
    readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
    readonly thinking?: "adaptive" | "disabled";
    readonly fallbackModel?: string;
  };
  readonly creditRecovery?: {
    readonly safetyBufferSeconds?: number;
    readonly openRouterApiKey?: string;
    readonly openRouterModel?: string;
    readonly timeZone?: string;
  };
  readonly baseURL?: string;
  readonly maxOutputTokens?: number;
  /** User-enabled host tool IDs from settings. */
  readonly enabledHostToolIds?: readonly string[];
}

export interface RuntimeWiringOptions {
  readonly providerConfig: ProviderConfig;
  readonly checkpoints: CheckpointStore;
  readonly artifacts: ArtifactStore;
  readonly autoApproveGates: boolean;
  /** Ingested attachment store roots; scoped file tools are exposed when set. */
  readonly attachmentRoots?: readonly string[];
  readonly bundle: ContentBundle;
  readonly onEvent?: RunEventListener;
}

/** Reads the model id the brainstorm compiler resolved into the task description. */
class TaskDescribedRouteResolver implements ModelRouteResolver {
  constructor(private readonly fallbackModelId: string) {}

  resolve(task: AgentTask): ModelRoute {
    const modelId = task.modelRequest?.modelId ?? this.fallbackModelId;
    return { modelId };
  }
}

export function buildAgentExecutor(
  config: ProviderConfig,
  attachmentRoots: readonly string[] = [],
): AgentExecutor {
  if (config.provider === "offline") {
    return new OfflineBrainstormExecutor();
  }
  if (config.provider === "claude-agent") {
    if (!config.setupToken) {
      throw new Error(
        "Claude Agent SDK wiring needs a verified setup token.",
      );
    }
    const model = config.defaultModel ?? config.models?.reasoning;
    return new ClaudeAgentExecutor({
      token: config.setupToken,
      ...(attachmentRoots.length > 0
        ? { attachmentRoots: [...attachmentRoots] }
        : {}),
      outputValidator: new ContentArtifactOutputValidator(),
      maxValidationAttempts: 3,
      ...(model ? { model } : {}),
      ...(config.agentSdk?.maxTurns !== undefined
        ? { maxTurns: config.agentSdk.maxTurns }
        : {}),
      ...(config.agentSdk?.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: config.agentSdk.maxBudgetUsd }
        : {}),
      ...(config.agentSdk?.effort
        ? { effort: config.agentSdk.effort }
        : {}),
      ...(config.agentSdk?.thinking
        ? { thinking: config.agentSdk.thinking }
        : {}),
      ...(config.agentSdk?.fallbackModel
        ? { fallbackModel: config.agentSdk.fallbackModel }
        : {}),
      ...(config.creditRecovery
        ? { creditRecovery: config.creditRecovery }
        : {}),
    });
  }
  const defaultModel = config.defaultModel ?? config.models?.reasoning;
  if (!defaultModel) {
    throw new Error(
      "Anthropic wiring needs a model id: set BRAINSTORM_AGENTIC_MODEL (or per-route models) in the environment.",
    );
  }
  const provider = new AnthropicMessagesProvider({
    model: defaultModel,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxTokens: config.maxOutputTokens } : {}),
  });
  const registry = new InMemoryToolRegistry();
  if (attachmentRoots.length > 0) {
    for (const tool of attachmentTools(attachmentRoots)) registry.register(tool);
  }
  return new ToolLoopAgentExecutor({
    provider,
    tools: registry,
    modelRouteResolver: new TaskDescribedRouteResolver(defaultModel),
    taskAdapter: new BrainstormAgentTaskAdapter(),
    outputValidator: new ContentArtifactOutputValidator(),
  });
}

/** Logical content route -> concrete model id, as pure deployment config. */
function contentRouteResolver(config: ProviderConfig): StaticBrainstormRouteResolver {
  const models = config.models ?? {};
  const fallback = config.defaultModel ?? models.reasoning ?? "";
  const route = (name: string): ResolvedBrainstormRoute =>
    config.provider === "offline"
      ? {}
      : {
          providerId:
            config.provider === "claude-agent"
              ? "claude-agent"
              : "anthropic",
          ...((models[name] ?? fallback)
            ? { modelId: models[name] ?? fallback }
            : {}),
        };
  return new StaticBrainstormRouteResolver({
    reasoning: route("reasoning"),
    writing: route("writing"),
    balanced: route("balanced"),
  });
}

export function buildRuntime(options: RuntimeWiringOptions): BrainstormRuntime {
  const attachmentRoots = options.attachmentRoots ?? [];
  // The Claude Agent SDK path serves attachment access through Claude Code's
  // own Read/Glob/Grep (mapped inside the executor from allowedCapabilities);
  // the Messages API path serves it through the registered attachment tools.
  const anthropicAttachmentTools =
    options.providerConfig.provider === "anthropic" && attachmentRoots.length > 0
      ? [...ATTACHMENT_TOOL_NAMES]
      : [];

  // Determine enabled host tools from config or defaults
  const enabledHostToolIds = new Set<string>(
    options.providerConfig.enabledHostToolIds ??
      ATTACHMENT_MANIFESTS
        .filter((m) => m.defaultEnabled)
        .map((m) => m.toolId),
  );

  return new BrainstormRuntime({
    agentExecutor: buildAgentExecutor(options.providerConfig, attachmentRoots),
    bundle: options.bundle,
    routeResolver: contentRouteResolver(options.providerConfig),
    // Legacy capability tool resolver (kept for backward compatibility)
    capabilityTools: new StaticCapabilityToolResolver({
      "web-search": [],
      "code-execution": [],
      "attachment-access": anthropicAttachmentTools,
    }),
    // Capability broker inputs
    providerOffers: [],
    hostTools: ALL_HOST_TOOL_MANIFESTS,
    enabledHostToolIds,
    humanGateMode: options.autoApproveGates ? "autoApproveSkippable" : "manual",
    checkpoints: options.checkpoints,
    artifacts: options.artifacts,
    onEvent: options.onEvent,
  });
}

export function providerConfigFromEnv(env: NodeJS.ProcessEnv, offline: boolean): ProviderConfig {
  if (offline) return { provider: "offline" };
  const selectedProvider =
    env.BRAINSTORM_AGENTIC_PROVIDER === "claude-agent"
      ? "claude-agent"
      : "anthropic";
  const defaultModel = env.BRAINSTORM_AGENTIC_MODEL?.trim();
  const models: Record<string, string> = {};
  for (const routeName of ["reasoning", "writing", "balanced"] as const) {
    const value = env[`BRAINSTORM_AGENTIC_MODEL_${routeName.toUpperCase()}`]?.trim();
    if (value) models[routeName] = value;
  }
  const maxTurns = Number(env.BRAINSTORM_AGENTIC_AGENT_MAX_TURNS);
  const maxBudgetUsd = Number(
    env.BRAINSTORM_AGENTIC_AGENT_MAX_BUDGET_USD,
  );
  const effort = env.BRAINSTORM_AGENTIC_AGENT_EFFORT;
  const thinking = env.BRAINSTORM_AGENTIC_AGENT_THINKING;
  const agentSdk: NonNullable<ProviderConfig["agentSdk"]> = {
    ...(Number.isSafeInteger(maxTurns) && maxTurns > 0 ? { maxTurns } : {}),
    ...(Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0
      ? { maxBudgetUsd }
      : {}),
    ...(effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
      ? { effort }
      : {}),
    ...(thinking === "adaptive" || thinking === "disabled"
      ? { thinking }
      : {}),
    ...(env.BRAINSTORM_AGENTIC_AGENT_FALLBACK_MODEL
      ? {
          fallbackModel:
            env.BRAINSTORM_AGENTIC_AGENT_FALLBACK_MODEL,
        }
      : {}),
  };
  const safetyBufferSeconds = Number(
    env.BRAINSTORM_AGENTIC_CREDIT_SAFETY_BUFFER_SECONDS,
  );
  const creditRecovery: NonNullable<ProviderConfig["creditRecovery"]> = {
    ...(Number.isFinite(safetyBufferSeconds) && safetyBufferSeconds >= 0
      ? { safetyBufferSeconds }
      : {}),
    ...(env.OPENROUTER_API_KEY
      ? { openRouterApiKey: env.OPENROUTER_API_KEY }
      : {}),
    ...(env.BRAINSTORM_AGENTIC_OPENROUTER_MODEL
      ? { openRouterModel: env.BRAINSTORM_AGENTIC_OPENROUTER_MODEL }
      : {}),
    ...(env.TZ ? { timeZone: env.TZ } : {}),
  };
  return {
    provider: selectedProvider,
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
    ...(env.CLAUDE_CODE_OAUTH_TOKEN
      ? { setupToken: env.CLAUDE_CODE_OAUTH_TOKEN }
      : {}),
    ...(Object.keys(agentSdk).length > 0 ? { agentSdk } : {}),
    ...(Object.keys(creditRecovery).length > 0
      ? { creditRecovery }
      : {}),
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    ...(env.BRAINSTORM_AGENTIC_HOST_TOOLS
      ? { enabledHostToolIds: env.BRAINSTORM_AGENTIC_HOST_TOOLS.split(",").filter(Boolean) }
      : {}),
  };
}
