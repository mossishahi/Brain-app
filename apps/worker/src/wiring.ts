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
  StaticCapabilityToolResolver,
  taxonomyActivities,
  type BrainstormRouteResolver,
  type ResolvedBrainstormRoute,
  type SkillResolver,
} from "@brainstorm-agentic/brainstorm-runtime";
import {
  ANTHROPIC_ADAPTER,
  CLAUDE_AGENT_ADAPTER,
  CreditBlockedError,
  InMemoryToolRegistry,
  isCreditBlocked,
  type AgentExecutionContext,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type ArtifactStore,
  type CheckpointStore,
  type JsonObject,
  type JsonValue,
  type ProviderNativeOffer,
  type RunEventListener,
  type TaxonomyAccess,
} from "@brainstorm-agentic/core";
import {
  isCreditLimitMessage,
  resolveCreditReset,
} from "@brainstorm-agentic/credit-recovery";
import type { ContentBundle, LoadedInputTypes } from "@brainstorm-agentic/content";
import { ClaudeAgentExecutor } from "@brainstorm-agentic/executor-claude-agent";
import { AnthropicMessagesProvider } from "@brainstorm-agentic/provider-anthropic";

import { attachmentTools, ATTACHMENT_TOOL_NAMES } from "./attachment-tools.js";
import {
  launchIntervalFor,
  StaggeredLaunchAgentExecutor,
} from "./launch-stagger.js";
import {
  ALL_HOST_TOOL_MANIFESTS,
  ATTACHMENT_MANIFESTS,
  TAXONOMY_MANIFESTS,
  TAXONOMY_TOOL_NAMES,
  codeExecutionTools,
  createHostToolRegistry,
  taxonomyTools,
  webFetchTools,
  type CodeRuntimeEnvironment,
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
  /** Capability ids the user disabled for THIS run (per-submission override). */
  readonly disabledCapabilities?: readonly string[];
  /**
   * Minimum ms between two agent-task launches (0 disables the stagger).
   * Deployment tuning via BRAINSTORM_AGENTIC_AGENT_LAUNCH_INTERVAL_MS;
   * defaults to 10s on network-backed providers and 0 offline.
   */
  readonly launchIntervalMs?: number;
}

export interface RuntimeWiringOptions {
  readonly providerConfig: ProviderConfig;
  readonly checkpoints: CheckpointStore;
  readonly artifacts: ArtifactStore;
  readonly autoApproveGates: boolean;
  /** Ingested attachment store roots; scoped file tools are exposed when set. */
  readonly attachmentRoots?: readonly string[];
  /**
   * Shared-taxonomy access (registry-backed in production, local seed as
   * fallback). Powers the deterministic taxonomy activities and the placer's
   * taxonomy-access capability tools.
   */
  readonly taxonomy?: TaxonomyAccess;
  /**
   * Prepared code scratch workspace; the host code_execute tool registers
   * over it. Providers with native code execution keep preferring it (the
   * broker resolves provider-first) — the host tool is the fallback for
   * providers without one.
   */
  readonly codeEnvironment?: CodeRuntimeEnvironment;
  readonly bundle: ContentBundle;
  readonly skillResolver?: SkillResolver;
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
  inputTypes?: LoadedInputTypes,
  taxonomy?: TaxonomyAccess,
  codeEnvironment?: CodeRuntimeEnvironment,
): AgentExecutor {
  if (config.provider === "offline") {
    return new OfflineBrainstormExecutor({ ...(inputTypes ? { inputTypes } : {}) });
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
      // The Agent SDK has no built-in taxonomy tool, so the shared-taxonomy
      // read tools reach the placer only when we hand the executor the same
      // TaxonomyAccess the deterministic activities use.
      ...(taxonomy ? { taxonomy } : {}),
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
  if (taxonomy) {
    for (const tool of taxonomyTools(taxonomy)) registry.register(tool);
  }
  if (codeEnvironment) {
    for (const tool of codeExecutionTools(codeEnvironment)) registry.register(tool);
  }
  // Registered unconditionally (it needs no backing store), but the model is
  // only offered it when the capability plan selects it — with a provider
  // that offers native web tools, the broker prefers those.
  for (const tool of webFetchTools()) registry.register(tool);
  return new ToolLoopAgentExecutor({
    provider,
    tools: registry,
    modelRouteResolver: new TaskDescribedRouteResolver(defaultModel),
    taskAdapter: new BrainstormAgentTaskAdapter(),
    outputValidator: new ContentArtifactOutputValidator(),
  });
}

/**
 * Logical content route -> concrete model id, as pure deployment config. The
 * resolver is dynamic over route names, so new task types published by the
 * bundle work without code changes. Routes carrying the "extended-reasoning"
 * trait additionally get the Messages-API thinking configuration; it is
 * constant per route across a run, which keeps prompt-cache prefixes stable.
 */
function contentRouteResolver(config: ProviderConfig): BrainstormRouteResolver {
  const models = config.models ?? {};
  const fallback = config.defaultModel ?? models.reasoning ?? "";
  return {
    resolve(request): ResolvedBrainstormRoute {
      if (config.provider === "offline") return {};
      const modelId = models[request.logicalRoute] ?? fallback;
      const thinking =
        config.provider === "anthropic" &&
        request.traits.includes("extended-reasoning")
          ? {
              providerOptions: {
                anthropic: {
                  thinking: { type: "adaptive", display: "summarized" },
                },
              },
            }
          : {};
      return {
        providerId:
          config.provider === "claude-agent" ? "claude-agent" : "anthropic",
        ...(modelId ? { modelId } : {}),
        ...thinking,
      };
    },
  };
}

/**
 * Converts provider credit/limit failures into the typed CreditBlockedError
 * so the runner checkpoints `credit_blocked` (auto-resumed at the parsed
 * reset time, or claimed manually when the message names none — e.g. the
 * developer API's "credit balance is too low", which only a top-up clears).
 * The Claude Agent executor raises the typed error itself; this wrapper
 * covers the Messages API path, where the tool loop reports provider errors
 * as plain task failures.
 */
export class CreditBlockDetectingAgentExecutor implements AgentExecutor {
  constructor(
    private readonly inner: AgentExecutor,
    private readonly recovery?: ProviderConfig["creditRecovery"],
  ) {}

  async execute(
    task: AgentTask,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    let result: AgentResult;
    try {
      result = await this.inner.execute(task, context);
    } catch (error) {
      if (isCreditBlocked(error)) throw error;
      const blocked = await this.creditBlockFrom(error);
      if (blocked) throw blocked;
      throw error;
    }
    if (result.status === "error") {
      const blocked = await this.creditBlockFrom(result.error.message);
      if (blocked) throw blocked;
    }
    return result;
  }

  private async creditBlockFrom(
    reason: unknown,
  ): Promise<CreditBlockedError | undefined> {
    const message =
      typeof reason === "string"
        ? reason
        : reason instanceof Error
          ? reason.message
          : String(reason);
    if (!isCreditLimitMessage(message)) return undefined;
    try {
      const resolved = await resolveCreditReset({
        message,
        timeZone: this.recovery?.timeZone,
        safetyBufferSeconds: this.recovery?.safetyBufferSeconds,
        openRouterApiKey: this.recovery?.openRouterApiKey,
        openRouterModel: this.recovery?.openRouterModel,
      });
      return new CreditBlockedError(resolved.retryAt, message, resolved.source);
    } catch {
      // No reset time in the message: block for a manual resume (top-up).
      return new CreditBlockedError(undefined, message, "manual");
    }
  }
}

/**
 * Persists reasoning-trace capture (thinking segments and stepwise chain
 * turns) as a per-task artifact, then strips it from the journaled result so
 * checkpoints stay lean. Traces reach the job owner through the artifact
 * store only — never events.jsonl, task feedback, or reviewer context.
 */
class ThinkingArtifactAgentExecutor implements AgentExecutor {
  constructor(
    private readonly inner: AgentExecutor,
    private readonly artifacts: ArtifactStore,
  ) {}

  async execute(
    task: AgentTask,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    const result = await this.inner.execute(task, context);
    if (result.status !== "ok" || result.metadata === undefined) {
      return result;
    }
    const { thinkingSegments, stepTurns, ...metadata } = result.metadata as {
      readonly thinkingSegments?: JsonValue;
      readonly stepTurns?: JsonValue;
      readonly [key: string]: JsonValue | undefined;
    };
    if (thinkingSegments === undefined && stepTurns === undefined) {
      return result;
    }
    try {
      await this.artifacts.put({
        name: `${context.runId}/${context.nodePath}.thinking.json`,
        data: JSON.stringify({
          taskId: task.taskId,
          nodePath: context.nodePath,
          segments: thinkingSegments ?? [],
          stepTurns: stepTurns ?? [],
        }),
        contentType: "application/json",
        metadata: {
          kind: "thinking",
          nodePath: context.nodePath,
          taskId: task.taskId,
        },
      });
    } catch {
      // Trace capture must never fail the task itself.
    }
    return { ...result, metadata: metadata as JsonObject };
  }
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
  // Taxonomy reads are provider-neutral registered tools (Messages API path).
  const anthropicTaxonomyTools =
    options.providerConfig.provider === "anthropic" && options.taxonomy
      ? [...TAXONOMY_TOOL_NAMES]
      : [];

  // Determine enabled host tools from config or defaults
  const enabledHostToolIds = new Set<string>(
    options.providerConfig.enabledHostToolIds ??
      [...ATTACHMENT_MANIFESTS, ...TAXONOMY_MANIFESTS]
        .filter((m) => m.defaultEnabled)
        .map((m) => m.toolId),
  );
  // The taxonomy read tools are a deployment resource the decompose stage
  // (pool -> match -> place) requires, not a user preference: whenever a
  // shared taxonomy is wired, enable them so the capability broker resolves
  // taxonomy-access; when NO taxonomy is wired, remove them so the broker's
  // verdict stays truthful (an "available" capability with no backing
  // implementation is exactly the silent degradation the required-capability
  // guard exists to catch — the placer then fails loud instead).
  for (const manifest of TAXONOMY_MANIFESTS) {
    if (options.taxonomy) enabledHostToolIds.add(manifest.toolId);
    else enabledHostToolIds.delete(manifest.toolId);
  }
  // Same truthfulness rule for the attachment tools: a run with no ingested
  // attachment store has nothing for them to read, so the broker must resolve
  // attachment-access unavailable (whenUnavailable prose) instead of offering
  // tools that can only refuse.
  if (attachmentRoots.length === 0) {
    for (const manifest of ATTACHMENT_MANIFESTS) {
      enabledHostToolIds.delete(manifest.toolId);
    }
  }

  // Per-run capability disables from the submission. taxonomy-access is
  // deliberately exempt: it is runtime infrastructure (the placer hard-requires
  // it), not a user-facing ability of the panel.
  const disabledCapabilityIds = new Set(
    (options.providerConfig.disabledCapabilities ?? []).filter(
      (capabilityId) => capabilityId !== "taxonomy-access",
    ),
  );

  // Provider-native operation offers for the capability broker: web search,
  // web fetch, and code execution run natively on both provider paths (as
  // Anthropic server tools, or as Claude Code's own built-ins). Offline runs
  // offer nothing and fall back to the capability catalog's honesty rules.
  const providerOffers: readonly ProviderNativeOffer[] =
    options.providerConfig.provider === "anthropic"
      ? ANTHROPIC_ADAPTER.staticOffers
      : options.providerConfig.provider === "claude-agent"
        ? CLAUDE_AGENT_ADAPTER.staticOffers
        : [];

  const executorStack = new ThinkingArtifactAgentExecutor(
    new CreditBlockDetectingAgentExecutor(
      buildAgentExecutor(
        options.providerConfig,
        attachmentRoots,
        options.bundle.catalogs.inputTypes,
        options.taxonomy,
        options.codeEnvironment,
      ),
      options.providerConfig.creditRecovery,
    ),
    options.artifacts,
  );
  // Outermost by design: the stagger gates the moment a task ENTERS
  // execution, so a parallel wave (first pass, a review round's
  // commentors) launches one agent per interval instead of all at once.
  const launchIntervalMs = launchIntervalFor(options.providerConfig);
  const agentExecutor =
    launchIntervalMs > 0
      ? new StaggeredLaunchAgentExecutor(executorStack, {
          intervalMs: launchIntervalMs,
        })
      : executorStack;

  return new BrainstormRuntime({
    agentExecutor,
    bundle: options.bundle,
    skillResolver: options.skillResolver,
    routeResolver: contentRouteResolver(options.providerConfig),
    // The deterministic taxonomy activities (match/suggest/bridge) run over
    // the same shared-taxonomy access the placer's tools read from.
    ...(options.taxonomy ? { activities: taxonomyActivities(options.taxonomy) } : {}),
    // Legacy capability tool resolver (kept for backward compatibility)
    capabilityTools: new StaticCapabilityToolResolver({
      "web-search": [],
      "code-execution": [],
      "attachment-access": anthropicAttachmentTools,
      "taxonomy-access": anthropicTaxonomyTools,
    }),
    // Capability broker inputs
    providerOffers,
    hostTools: ALL_HOST_TOOL_MANIFESTS,
    enabledHostToolIds,
    disabledCapabilityIds,
    humanGateMode: options.autoApproveGates ? "autoApproveSkippable" : "manual",
    checkpoints: options.checkpoints,
    artifacts: options.artifacts,
    onEvent: options.onEvent,
  });
}

/**
 * Per-route models arrive as one JSON env variable (lossless for any route
 * name a bundle may declare); the three legacy per-route variables remain
 * readable so older submit scripts keep resuming.
 */
/**
 * The per-route model ids this run will actually execute with.
 *
 * Exported because the telemetry path needs the SAME answer: a second parser
 * (which existed, and validated differently) could report a configuration the
 * executor never used, quietly poisoning any comparison across models.
 */
export function modelsByRouteFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const models: Record<string, string> = {};
  for (const routeName of ["reasoning", "writing", "balanced"] as const) {
    const value = env[`BRAINSTORM_AGENTIC_MODEL_${routeName.toUpperCase()}`]?.trim();
    if (value) models[routeName] = value;
  }
  const json = env.BRAINSTORM_AGENTIC_MODELS_BY_ROUTE?.trim();
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [route, model] of Object.entries(parsed)) {
          if (typeof model === "string" && model.trim().length > 0) {
            models[route] = model.trim();
          }
        }
      }
    } catch (error) {
      // Silently ignoring this meant every task ran on the default model while
      // the user believed their per-route choices were in effect — a cost and
      // quality change with no signal anywhere. The server writes this variable
      // itself, so a parse failure is a real defect, not user error.
      console.error(
        `[config] BRAINSTORM_AGENTIC_MODELS_BY_ROUTE could not be parsed, so per-route ` +
          `model selection is being IGNORED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return models;
}

/**
 * Explicit launch-interval override, when the environment carries a valid
 * one. Invalid or empty values are ignored (the provider default applies)
 * rather than silently disabling the stagger: Number("") is 0, and an
 * empty export must not mean "launch everything at once".
 */
function launchIntervalFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.BRAINSTORM_AGENTIC_AGENT_LAUNCH_INTERVAL_MS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function providerConfigFromEnv(env: NodeJS.ProcessEnv, offline: boolean): ProviderConfig {
  const launchIntervalMs = launchIntervalFromEnv(env);
  if (offline) {
    return {
      provider: "offline",
      ...(launchIntervalMs !== undefined ? { launchIntervalMs } : {}),
    };
  }
  const selectedProvider =
    env.BRAINSTORM_AGENTIC_PROVIDER === "claude-agent"
      ? "claude-agent"
      : "anthropic";
  const defaultModel = env.BRAINSTORM_AGENTIC_MODEL?.trim();
  const models = modelsByRouteFromEnv(env);
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
    ...(env.BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES
      ? {
          disabledCapabilities: env.BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES.split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        }
      : {}),
    ...(launchIntervalMs !== undefined ? { launchIntervalMs } : {}),
  };
}
