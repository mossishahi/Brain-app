import {
  type ContentBundle,
  type WorkflowDefinition as ContentWorkflowDefinition,
} from "@brainstorm-agentic/content";
import {
  InMemoryArtifactStore,
  InMemoryCheckpointStore,
  WorkflowRunner,
  createBuiltinExecutorRegistry,
  type AgentExecutor,
  type ArtifactStore,
  type CheckpointStore,
  type CheckpointWriteRetryPolicy,
  type GateResponses,
  type HostToolManifest,
  type JsonValue,
  type NodeExecutorRegistry,
  type ProviderNativeOffer,
  type RunEventListener,
  type RunResult,
  type ScopeReader,
} from "@brainstorm-agentic/core";

import {
  compileContentWorkflow,
  type CompiledContentWorkflow,
  type DeterministicActivityHandler,
  type SkillResolver,
} from "./compiler.js";
import type { HumanGateMode } from "./gates.js";
import { MigratingCheckpointStore } from "./journal-migrate.js";
import type { BrainstormRouteResolver, CapabilityToolResolver } from "./routes.js";

export interface BrainstormRuntimeOptions {
  readonly agentExecutor: AgentExecutor;
  /** Host-fetched, hash-verified, and validated registry bundle. */
  readonly bundle: ContentBundle;
  readonly skillResolver?: SkillResolver;
  readonly workflow?: string | ContentWorkflowDefinition;
  readonly routeResolver?: BrainstormRouteResolver;
  readonly capabilityTools?: CapabilityToolResolver;
  readonly activities?: Readonly<Record<string, DeterministicActivityHandler>>;
  readonly humanGateMode?: HumanGateMode;
  readonly checkpoints?: CheckpointStore;
  readonly artifacts?: ArtifactStore;
  readonly onEvent?: RunEventListener;
  readonly now?: () => number;
  /** Provider-native operation offers for the capability broker. */
  readonly providerOffers?: readonly ProviderNativeOffer[];
  /** All installed host tools for the capability broker. */
  readonly hostTools?: readonly HostToolManifest[];
  /** User-enabled host tool IDs for the capability broker. */
  readonly enabledHostToolIds?: ReadonlySet<string>;
  /** Capability ids the user disabled for THIS run (per-submission override). */
  readonly disabledCapabilityIds?: ReadonlySet<string>;
  /** Journal layout to compile for; see CompileContentWorkflowOptions. */
  readonly journalFormat?: 1 | 2;
  /** Retry ladder for failed checkpoint writes (shared-filesystem blips). */
  readonly checkpointWriteRetry?: CheckpointWriteRetryPolicy;
  /**
   * Panel members the submitter dismissed mid-run. The server accumulates the
   * list on the job record and re-supplies it on every resume, so a dismissal
   * is permanent and each replay reaches the same decisions.
   */
  readonly dismissedMembers?: readonly string[];
}

export interface StartBrainstormOptions {
  readonly submission: JsonValue;
  readonly params?: Readonly<Record<string, JsonValue>>;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: RunEventListener;
}

export interface ResumeBrainstormOptions {
  readonly responses?: GateResponses;
  readonly signal?: AbortSignal;
  readonly onEvent?: RunEventListener;
}

/**
 * The node-executor table a run with dismissed seats needs, or undefined when
 * nothing is dismissed (then the runner uses the builtin table untouched).
 *
 * The `agent` kind is overridden rather than wrapped in a guard NODE on
 * purpose: journal keys are execution paths, so an extra node would move every
 * key beneath it and a resumed run would miss — and re-buy — its own completed
 * work. Skipping inside the executor records no journal entry at all, which is
 * indistinguishable from never having reached the node, so the seat's history
 * stays exactly as the dismissal found it.
 */
function dismissalExecutors(
  isAgentDismissed: ((nodeId: string, scope: ScopeReader) => boolean) | undefined,
): NodeExecutorRegistry | undefined {
  if (isAgentDismissed === undefined) return undefined;
  const executors = createBuiltinExecutorRegistry();
  const runAgent = executors.get("agent");
  executors.register(
    "agent",
    async (node, context) => {
      const id = node.id;
      if (id !== undefined && isAgentDismissed(id, context.scope)) return undefined;
      return runAgent(node, context);
    },
    { override: true },
  );
  return executors;
}

/**
 * High-level executable integration of a host-validated registry bundle, core
 * workflow semantics, and an injected provider-neutral AgentExecutor.
 */
export class BrainstormRuntime {
  readonly compiled: CompiledContentWorkflow;
  readonly checkpoints: CheckpointStore;
  readonly artifacts: ArtifactStore;
  private readonly runner: WorkflowRunner;

  constructor(options: BrainstormRuntimeOptions) {
    this.compiled = compileContentWorkflow({
      bundle: options.bundle,
      workflow: options.workflow,
      routeResolver: options.routeResolver,
      capabilityTools: options.capabilityTools,
      activities: options.activities,
      humanGateMode: options.humanGateMode,
      providerOffers: options.providerOffers,
      hostTools: options.hostTools,
      enabledHostToolIds: options.enabledHostToolIds,
      disabledCapabilityIds: options.disabledCapabilityIds,
      skillResolver: options.skillResolver,
      journalFormat: options.journalFormat,
      ...(options.dismissedMembers !== undefined
        ? { dismissedMembers: options.dismissedMembers }
        : {}),
    });
    const checkpoints = options.checkpoints ?? new InMemoryCheckpointStore();
    // Loads migrate pre-fold (format-1) journals forward against this run's
    // own pinned workflow, so every old run stays resumable. A runtime
    // explicitly compiled FOR format 1 must replay format-1 journals as-is.
    this.checkpoints =
      (options.journalFormat ?? 2) === 1
        ? checkpoints
        : new MigratingCheckpointStore(checkpoints, this.compiled.content);
    this.artifacts = options.artifacts ?? new InMemoryArtifactStore();
    const executors = dismissalExecutors(this.compiled.isAgentDismissed);
    this.runner = new WorkflowRunner({
      functions: this.compiled.functions,
      checkpoints: this.checkpoints,
      artifacts: this.artifacts,
      agentExecutor: options.agentExecutor,
      ...(executors !== undefined ? { executors } : {}),
      onEvent: options.onEvent,
      now: options.now,
      // The checkpoint stamp must match the layout the compiler emitted.
      journalFormat: options.journalFormat ?? 2,
      ...(options.checkpointWriteRetry !== undefined
        ? { checkpointWriteRetry: options.checkpointWriteRetry }
        : {}),
    });
  }

  run(options: StartBrainstormOptions): Promise<RunResult> {
    return this.runner.run(this.compiled.definition, {
      runId: options.runId,
      input: this.compiled.createInput(options.submission, options.params),
      signal: options.signal,
      onEvent: options.onEvent,
    });
  }

  resume(runId: string, options: ResumeBrainstormOptions = {}): Promise<RunResult> {
    return this.runner.resume(this.compiled.definition, runId, {
      responses: options.responses,
      signal: options.signal,
      onEvent: options.onEvent,
    });
  }
}

export function createBrainstormRuntime(options: BrainstormRuntimeOptions): BrainstormRuntime {
  return new BrainstormRuntime(options);
}
