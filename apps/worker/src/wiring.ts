/**
 * Deployment wiring: turns configuration (environment/flags) into a ready
 * BrainstormRuntime. Providers are chosen here — never in content or core.
 */
import { readFileSync } from "node:fs";

import {
  ToolLoopAgentExecutor,
  type AgentTaskModelAdapter,
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
  nativeOffersFor,
  CreditBlockedError,
  InMemoryToolRegistry,
  isCreditBlocked,
  RateCoordinator,
  type AgentExecutionContext,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type ArtifactStore,
  type CheckpointStore,
  type JsonObject,
  type JsonValue,
  type ModelRequest,
  type ModelResponse,
  type ProviderNativeOffer,
  type RunEventListener,
  type TaxonomyAccess,
} from "@brainstorm-agentic/core";
import {
  isCreditLimitMessage,
  resolveCreditReset,
} from "@brainstorm-agentic/credit-recovery";
import type { LivePreviewSink } from "@brainstorm-agentic/core";
import type { ContentBundle, LoadedInputTypes } from "@brainstorm-agentic/content";
import { ClaudeAgentExecutor } from "@brainstorm-agentic/executor-claude-agent";
import { CursorAgentExecutor } from "@brainstorm-agentic/executor-cursor-agent";
import { AnthropicMessagesProvider } from "@brainstorm-agentic/provider-anthropic";

import { attachmentTools, ATTACHMENT_TOOL_NAMES } from "./attachment-tools.js";
import {
  launchIntervalFor,
  StaggeredLaunchAgentExecutor,
} from "./launch-stagger.js";
import {
  ALL_HOST_TOOL_MANIFESTS,
  ATTACHMENT_MANIFESTS,
  GPU_RUN_MANIFESTS,
  TAXONOMY_MANIFESTS,
  TAXONOMY_TOOL_NAMES,
  codeExecutionTools,
  createHostToolRegistry,
  gpuRunTools,
  taxonomyTools,
  webFetchTools,
  type CodeRuntimeEnvironment,
  type GpuRunConfig,
} from "@brainstorm-agentic/host-tools";
import { OfflineBrainstormExecutor } from "./offline-executor.js";
import type { PromptSink } from "./prompt-capture.js";
import { sliceThoughtsBySteps } from "./thought-slices.js";

export interface ProviderConfig {
  /** Developer API, Claude Agent SDK, Cursor SDK, or deterministic offline. */
  readonly provider: "anthropic" | "claude-agent" | "cursor-agent" | "offline";
  /** Model id per logical content route (reasoning/writing/balanced). */
  readonly models?: Readonly<Record<string, string>>;
  /** Fallback model id when a route has no explicit entry. */
  readonly defaultModel?: string;
  readonly apiKey?: string;
  readonly setupToken?: string;
  readonly cursorApiKey?: string;
  readonly agentSdk?: {
    readonly maxTurns?: number;
    readonly maxBudgetUsd?: number;
    readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
    readonly thinking?: "adaptive" | "disabled";
    readonly fallbackModel?: string;
    /** Session inactivity ceiling (ms); 0 disables the stall watchdog. */
    readonly stallTimeoutMs?: number;
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
   * What is KNOWN about this run's attachment store, which the roots array
   * cannot say: an empty array means the same thing for a run that attached
   * nothing and for a run whose store this host could not open, and telling
   * those apart is the difference between a review that legitimately has no
   * files and 442 reviews that quietly stopped reading them.
   *
   * - "present": a store was named and opened.
   * - "declared-none": the submission declared it carries no files. An
   *   assertion by the party that owns the fact — never inferred here.
   * - "unusable": a store was named and could not be opened on this host.
   * - "undeclared": nobody said anything, which after the migration window is
   *   itself a defect (see the broker's "unwired").
   */
  readonly attachmentStore?: "present" | "declared-none" | "unusable" | "undeclared";
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
  /**
   * GPU run setup (the deployment owner's completed submission template).
   * No provider offers gpu.run natively, so the gpu_run host tool is the
   * only source; absent config resolves the capability unavailable.
   */
  readonly gpuRun?: GpuRunConfig;
  readonly bundle: ContentBundle;
  readonly skillResolver?: SkillResolver;
  readonly onEvent?: RunEventListener;
  /**
   * Panel members the submitter dismissed mid-run. Forwarded to the runtime,
   * which compiles the guards that stop a dismissed seat from thinking,
   * commenting, or being judged (see dismissal.ts).
   *
   * This option was MISSING here while both worker commands passed it in, and
   * a conditional spread (`...(list.length > 0 ? { dismissedMembers } : {})`)
   * is exempt from TypeScript's excess-property check — so every real
   * dismissal was dropped on the floor while the dashboard, the final
   * outputs, and every unit test (which build the runtime directly) said the
   * feature worked. Both call sites now assign through this type explicitly,
   * so the next option to arrive cannot be silently discarded.
   */
  readonly dismissedMembers?: readonly string[];
  /**
   * Where an agent's live text goes while its task runs (see
   * AgentExecutionContext.reportLive). Omitted on a host that shows none.
   */
  readonly onLivePreview?: LivePreviewSink;
  /**
   * Where a hand-off's prompt record goes (see
   * AgentExecutionContext.reportPrompt). Omitted on a host with nothing to
   * serve the records from, and then executors build none at all.
   */
  readonly onPrompt?: PromptSink;
}

/** Reads the model id the brainstorm compiler resolved into the task description. */
class TaskDescribedRouteResolver implements ModelRouteResolver {
  constructor(private readonly fallbackModelId: string) {}

  resolve(task: AgentTask): ModelRoute {
    const modelId = task.modelRequest?.modelId ?? this.fallbackModelId;
    return { modelId };
  }
}

/** Task kinds whose single call gates a whole review round. */
const HIGH_PRIORITY_TASK_KINDS: ReadonlySet<string> = new Set([
  "brainstorm.judge",
  "brainstorm.redeveloper",
]);

/**
 * Stamps each turn's dispatch priority into the request metadata, so the
 * provider-level request coordinator releases a round's gating call (the
 * judge's, the redeveloper's — one per seat, and the whole round waits on
 * it) ahead of other seats' comment floods when a rate-limit block lifts.
 */
export class DispatchPriorityTaskAdapter implements AgentTaskModelAdapter {
  constructor(private readonly inner: AgentTaskModelAdapter) {}

  createRequest(
    task: AgentTask,
    context: AgentExecutionContext,
    route: ModelRoute,
  ): ModelRequest {
    const request = this.inner.createRequest(task, context, route);
    return {
      ...request,
      metadata: {
        ...(request.metadata ?? {}),
        dispatchPriority: HIGH_PRIORITY_TASK_KINDS.has(task.kind)
          ? "high"
          : "normal",
      },
    };
  }

  responseToOutput(
    response: ModelResponse,
    task: AgentTask,
    context: AgentExecutionContext,
    route: ModelRoute,
  ): JsonValue {
    return this.inner.responseToOutput(response, task, context, route);
  }
}

export function buildAgentExecutor(
  config: ProviderConfig,
  attachmentRoots: readonly string[] = [],
  inputTypes?: LoadedInputTypes,
  taxonomy?: TaxonomyAccess,
  codeEnvironment?: CodeRuntimeEnvironment,
  gpuRun?: GpuRunConfig,
): AgentExecutor {
  if (config.provider === "offline") {
    return new OfflineBrainstormExecutor({ ...(inputTypes ? { inputTypes } : {}) });
  }
  if (config.provider === "cursor-agent") {
    if (!config.cursorApiKey) {
      throw new Error("Cursor SDK wiring needs a verified API key.");
    }
    const model = config.defaultModel ?? config.models?.reasoning;
    // The SAME agentSdk settings drive both agent-executor backends: turns,
    // effort, thinking, budget, and fallback model are read verbatim, so
    // switching SDKs changes the transport, never the knobs.
    return new CursorAgentExecutor({
      apiKey: config.cursorApiKey,
      ...(attachmentRoots.length > 0
        ? { attachmentRoots: [...attachmentRoots] }
        : {}),
      // The Cursor SDK has no built-in taxonomy tool, so the shared-taxonomy
      // read tools reach the placer as in-process custom tools.
      ...(taxonomy ? { taxonomy } : {}),
      // Same for GPU runs: no built-in submits cluster jobs.
      ...(gpuRun ? { gpuRun } : {}),
      outputValidator: new ContentArtifactOutputValidator(),
      maxValidationAttempts: 3,
      ...(model ? { model } : {}),
      ...(config.agentSdk?.maxTurns !== undefined
        ? { maxTurns: config.agentSdk.maxTurns }
        : {}),
      ...(config.agentSdk?.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: config.agentSdk.maxBudgetUsd }
        : {}),
      ...(config.agentSdk?.effort ? { effort: config.agentSdk.effort } : {}),
      ...(config.agentSdk?.thinking
        ? { thinking: config.agentSdk.thinking }
        : {}),
      ...(config.agentSdk?.fallbackModel
        ? { fallbackModel: config.agentSdk.fallbackModel }
        : {}),
      // One knob for both SDK backends: the same stall window governs the
      // Cursor and Claude Code watchdogs (each keeps its own default).
      ...(config.agentSdk?.stallTimeoutMs !== undefined
        ? { stallTimeoutMs: config.agentSdk.stallTimeoutMs }
        : {}),
      ...(config.creditRecovery
        ? { creditRecovery: config.creditRecovery }
        : {}),
    });
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
      // Same for GPU runs: no SDK built-in submits cluster jobs, so the
      // gpu_run tool is bridged in-process when the deployment set it up.
      ...(gpuRun ? { gpuRun } : {}),
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
      ...(config.agentSdk?.stallTimeoutMs !== undefined
        ? { stallTimeoutMs: config.agentSdk.stallTimeoutMs }
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
  // ONE request coordinator for the whole run: every task's every model
  // turn takes a dispatch slot from it, every response's rate-limit headers
  // feed it, and one 429 pauses all dispatch until the declared reset —
  // the provider's own timing declarations pace the run, never a user knob.
  const coordinator = new RateCoordinator();
  const provider = new AnthropicMessagesProvider({
    model: defaultModel,
    coordinator,
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
  if (gpuRun) {
    for (const tool of gpuRunTools(gpuRun)) registry.register(tool);
  }
  // Registered unconditionally (it needs no backing store), but the model is
  // only offered it when the capability plan selects it — with a provider
  // that offers native web tools, the broker prefers those.
  for (const tool of webFetchTools()) registry.register(tool);
  return new ToolLoopAgentExecutor({
    provider,
    tools: registry,
    modelRouteResolver: new TaskDescribedRouteResolver(defaultModel),
    taskAdapter: new DispatchPriorityTaskAdapter(new BrainstormAgentTaskAdapter()),
    outputValidator: new ContentArtifactOutputValidator(),
    // The coordinator pauses dispatch inside provider.complete; handing the
    // executor a window onto it lets the activity feed narrate those waits.
    dispatchGate: coordinator,
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
          config.provider === "claude-agent"
            ? "claude-agent"
            : config.provider === "cursor-agent"
              ? "cursor-agent"
              : "anthropic",
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
 *
 * One derived, bounded projection DOES stay in the journaled result:
 * `stepThoughts`, the trace cut into per-submitted-step slices (see
 * thought-slices.ts). It is the record the runtime folds into the run's
 * `thoughts` state so review tasks can bind the thinking behind each chain
 * step — and it must live in the journal, not the artifact, because run
 * state is rebuilt from the journal alone on every replay. The raw segments
 * still never reach the journal; the artifact keeps them whole.
 */
export class ThinkingArtifactAgentExecutor implements AgentExecutor {
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
    const stepThoughts = sliceThoughtsBySteps(thinkingSegments, stepTurns);
    return {
      ...result,
      metadata: {
        ...(metadata as JsonObject),
        ...(stepThoughts.length > 0
          ? { stepThoughts: stepThoughts as unknown as JsonValue }
          : {}),
      },
    };
  }
}

/**
 * Hands every executor below it the run's prompt sink, by adding
 * `reportPrompt` to the execution context on its way down.
 *
 * WHY here and not in the workflow runner, where `reportLive` is attached: live
 * text is addressed by execution path, so the runner — which owns the path —
 * has to be the one that builds that callback. A prompt record names itself and
 * needs nothing the runner knows, so the sink can reach the executor as a plain
 * decorator in the host that opened the file, and core stays unaware that this
 * deployment writes prompts to disk at all.
 */
export class PromptCapturingAgentExecutor implements AgentExecutor {
  constructor(
    private readonly inner: AgentExecutor,
    private readonly sink: PromptSink,
  ) {}

  execute(task: AgentTask, context: AgentExecutionContext): Promise<AgentResult> {
    // A copy, never a mutation: the runner owns the context object and reuses
    // it for the events it emits after the task returns. A context that already
    // carries a sink keeps it, so a test host wiring its own is never clobbered.
    return this.inner.execute(task, {
      ...context,
      reportPrompt: context.reportPrompt ?? this.sink,
    });
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
  // And for GPU runs: without a completed submission template there is
  // nothing to submit through, so the broker must resolve gpu-execution
  // unavailable (its whenUnavailable prose tells the agent GPU runs need
  // deployment-owner setup) instead of offering a tool that can only refuse.
  if (options.gpuRun === undefined) {
    for (const manifest of GPU_RUN_MANIFESTS) {
      enabledHostToolIds.delete(manifest.toolId);
    }
  }

  /**
   * What this host is willing to VOUCH for as legitimately empty.
   *
   * Every entry is a fact asserted by whoever owns it, never a conclusion drawn
   * from finding no tool — that inference is what let a broken deployment look
   * exactly like an ordinary run. Anything absent from this map and unresolved
   * is "unwired" to the broker, which is a defect a required capability will
   * refuse to run through. Taxonomy is deliberately NOT vouchable: it is
   * deployment infrastructure the placer hard-requires, so its absence must
   * stay loud.
   */
  const vacantCapabilities = new Map<string, string>();
  if (options.attachmentStore === "declared-none") {
    vacantCapabilities.set(
      "attachment-access",
      "This submission carries no attached files.",
    );
  }
  if (options.gpuRun === undefined) {
    vacantCapabilities.set(
      "gpu-execution",
      "This deployment configured no GPU submission template.",
    );
  }
  if (options.providerConfig.provider === "offline") {
    // --offline is an explicit choice made at launch, so it is an assertion in
    // exactly the way "no tool was found" is not.
    vacantCapabilities.set("web-search", "This run was launched offline: it has no network.");
    vacantCapabilities.set(
      "code-execution",
      "This run was launched offline: it has no interpreter.",
    );
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
  // The rule lives in core, beside the adapter descriptors, because the server's
  // readiness probe has to answer the same question before a job exists.
  const providerOffers = nativeOffersFor(options.providerConfig.provider, {
    attachmentRootsPresent: attachmentRoots.length > 0,
  });

  /**
   * The roots the EXECUTOR is given, which is a narrower question than which
   * roots exist. An executor that holds a root can reach it through the SDK's
   * shell as well as through its file tools, and the shell answers to
   * code-execution rather than to attachment-access — so a run whose submitter
   * switched attachment access off would still be one `cat` away from the files
   * for every task that may execute code, which is most of them. Withholding
   * the roots makes that disable mean what it says.
   */
  const executorAttachmentRoots = disabledCapabilityIds.has("attachment-access")
    ? []
    : attachmentRoots;

  const executorStack = new ThinkingArtifactAgentExecutor(
    new CreditBlockDetectingAgentExecutor(
      buildAgentExecutor(
        options.providerConfig,
        executorAttachmentRoots,
        options.bundle.catalogs.inputTypes,
        options.taxonomy,
        options.codeEnvironment,
        // Registration follows config presence; EXPOSURE stays with the
        // broker, which only offers gpu_run while it is in the enabled set.
        options.gpuRun !== undefined && enabledHostToolIds.has(GPU_RUN_MANIFESTS[0]!.toolId)
          ? options.gpuRun
          : undefined,
      ),
      options.providerConfig.creditRecovery,
    ),
    options.artifacts,
  );
  // Outermost by design: the stagger gates the moment a task ENTERS
  // execution, so a parallel wave (first pass, a review round's
  // commentors) launches one agent per interval instead of all at once.
  const launchIntervalMs = launchIntervalFor(options.providerConfig);
  const staggered =
    launchIntervalMs > 0
      ? new StaggeredLaunchAgentExecutor(executorStack, {
          intervalMs: launchIntervalMs,
        })
      : executorStack;
  // Above the stagger without taking its place: the sink rides the CONTEXT, so
  // it has to be attached before any executor that talks to a model sees it,
  // and this wrapper only decorates — the stagger remains the outermost thing
  // that DELAYS a task's entry into execution.
  const agentExecutor =
    options.onPrompt === undefined
      ? staggered
      : new PromptCapturingAgentExecutor(staggered, options.onPrompt);

  const runtime = new BrainstormRuntime({
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
    vacantCapabilities,
    humanGateMode: options.autoApproveGates ? "autoApproveSkippable" : "manual",
    checkpoints: options.checkpoints,
    artifacts: options.artifacts,
    onEvent: options.onEvent,
    ...(options.dismissedMembers !== undefined
      ? { dismissedMembers: options.dismissedMembers }
      : {}),
    ...(options.onLivePreview !== undefined
      ? { onLivePreview: options.onLivePreview }
      : {}),
  });
  // A dismissal that does not reach the compiler is a silent, expensive lie:
  // the seat keeps thinking and commenting, the dashboard shows it dismissed,
  // and the submitter pays for work they cancelled. That is exactly what
  // happened while this option went undeclared, so the seam now asserts
  // itself rather than trusting that the value arrived.
  if (
    (options.dismissedMembers?.length ?? 0) > 0 &&
    runtime.compiled.isAgentDismissed === undefined
  ) {
    throw new Error(
      "dismissed members were requested but the compiled workflow carries no " +
        "dismissal guards — refusing to run the full panel behind the " +
        "submitter's back",
    );
  }
  return runtime;
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

/**
 * Secrets from the owner-only credentials file, for submission channels
 * that cannot inject a scheduler environment (held pilots are queued long
 * before the run exists, with --export=NONE). The environment always wins;
 * the file only fills gaps. Unreadable/malformed files contribute nothing —
 * the run then fails with the normal missing-credential error.
 */
function credentialsFromFile(env: NodeJS.ProcessEnv): {
  anthropicApiKey?: string;
  claudeSetupToken?: string;
  cursorApiKey?: string;
  openRouterApiKey?: string;
} {
  const path = env.BRAINSTORM_AGENTIC_CREDENTIALS_FILE?.trim();
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      anthropicApiKey?: unknown;
      claudeSetupToken?: unknown;
      cursorApiKey?: unknown;
      openRouterApiKey?: unknown;
    };
    return {
      ...(typeof parsed.anthropicApiKey === "string" && parsed.anthropicApiKey
        ? { anthropicApiKey: parsed.anthropicApiKey }
        : {}),
      ...(typeof parsed.claudeSetupToken === "string" && parsed.claudeSetupToken
        ? { claudeSetupToken: parsed.claudeSetupToken }
        : {}),
      ...(typeof parsed.cursorApiKey === "string" && parsed.cursorApiKey
        ? { cursorApiKey: parsed.cursorApiKey }
        : {}),
      ...(typeof parsed.openRouterApiKey === "string" && parsed.openRouterApiKey
        ? { openRouterApiKey: parsed.openRouterApiKey }
        : {}),
    };
  } catch {
    return {};
  }
}

export function providerConfigFromEnv(env: NodeJS.ProcessEnv, offline: boolean): ProviderConfig {
  const launchIntervalMs = launchIntervalFromEnv(env);
  if (offline) {
    return {
      provider: "offline",
      ...(launchIntervalMs !== undefined ? { launchIntervalMs } : {}),
    };
  }
  const fileCredentials = credentialsFromFile(env);
  const selectedProvider =
    env.BRAINSTORM_AGENTIC_PROVIDER === "claude-agent"
      ? "claude-agent"
      : env.BRAINSTORM_AGENTIC_PROVIDER === "cursor-agent"
        ? "cursor-agent"
        : "anthropic";
  const defaultModel = env.BRAINSTORM_AGENTIC_MODEL?.trim();
  const models = modelsByRouteFromEnv(env);
  const maxTurns = Number(env.BRAINSTORM_AGENTIC_AGENT_MAX_TURNS);
  const maxBudgetUsd = Number(
    env.BRAINSTORM_AGENTIC_AGENT_MAX_BUDGET_USD,
  );
  const effort = env.BRAINSTORM_AGENTIC_AGENT_EFFORT;
  const thinking = env.BRAINSTORM_AGENTIC_AGENT_THINKING;
  // Deployment tuning for the session stall watchdog; 0 disables it.
  const stallTimeoutMs = Number(env.BRAINSTORM_AGENTIC_AGENT_STALL_TIMEOUT_MS);
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
    ...(Number.isSafeInteger(stallTimeoutMs) && stallTimeoutMs >= 0
      ? { stallTimeoutMs }
      : {}),
  };
  const safetyBufferSeconds = Number(
    env.BRAINSTORM_AGENTIC_CREDIT_SAFETY_BUFFER_SECONDS,
  );
  const creditRecovery: NonNullable<ProviderConfig["creditRecovery"]> = {
    ...(Number.isFinite(safetyBufferSeconds) && safetyBufferSeconds >= 0
      ? { safetyBufferSeconds }
      : {}),
    ...(env.OPENROUTER_API_KEY ?? fileCredentials.openRouterApiKey
      ? { openRouterApiKey: (env.OPENROUTER_API_KEY ?? fileCredentials.openRouterApiKey)! }
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
    ...(env.ANTHROPIC_API_KEY ?? fileCredentials.anthropicApiKey
      ? { apiKey: (env.ANTHROPIC_API_KEY ?? fileCredentials.anthropicApiKey)! }
      : {}),
    ...(env.CLAUDE_CODE_OAUTH_TOKEN ?? fileCredentials.claudeSetupToken
      ? { setupToken: (env.CLAUDE_CODE_OAUTH_TOKEN ?? fileCredentials.claudeSetupToken)! }
      : {}),
    ...(env.CURSOR_API_KEY ?? fileCredentials.cursorApiKey
      ? { cursorApiKey: (env.CURSOR_API_KEY ?? fileCredentials.cursorApiKey)! }
      : {}),
    ...(Object.keys(agentSdk).length > 0 ? { agentSdk } : {}),
    ...(Object.keys(creditRecovery).length > 0
      ? { creditRecovery }
      : {}),
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    // Present-but-empty is a DECISION, not a missing value: a user who turned
    // every host tool off sends "", and treating that as absent fell back to the
    // manifest defaults and silently switched the attachment and taxonomy reads
    // back on. Only a variable the server never wrote may take the defaults.
    ...(env.BRAINSTORM_AGENTIC_HOST_TOOLS !== undefined
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
