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
  WindDownSignal,
  type LivePreviewSink,
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
  /**
   * Where an agent's live text goes while a task runs — see
   * AgentExecutionContext.reportLive. Omitted on hosts that show none, and then
   * the executors produce none.
   */
  readonly onLivePreview?: LivePreviewSink;
  readonly now?: () => number;
  /** Provider-native operation offers for the capability broker. */
  readonly providerOffers?: readonly ProviderNativeOffer[];
  /** All installed host tools for the capability broker. */
  readonly hostTools?: readonly HostToolManifest[];
  /** User-enabled host tool IDs for the capability broker. */
  readonly enabledHostToolIds?: ReadonlySet<string>;
  /** Capabilities the host affirms are legitimately empty; see the broker. */
  readonly vacantCapabilities?: ReadonlyMap<string, string>;
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
  /**
   * When the host wants the run to stop starting work, and why.
   *
   * A scheduler kills its jobs at the allocation boundary, mid-task, and every
   * unjournaled call is bought again on the resume — on a review fan-out that is
   * the whole panel's round. Told when its host expires, the run instead lets
   * what is running finish, writes an ordinary resumable checkpoint, and exits
   * with nothing in flight.
   */
  readonly windDown?: { readonly at: number; readonly reason: string };
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
 * The node-executor table a run needs when something has to be withheld from an
 * agent node — a dismissed seat, or a host that is out of time. Undefined when
 * neither applies, and then the runner uses the builtin table untouched.
 *
 * The `agent` kind is overridden rather than wrapped in a guard NODE on
 * purpose: journal keys are execution paths, so an extra node would move every
 * key beneath it and a resumed run would miss — and re-buy — its own completed
 * work. Deciding inside the executor records no journal entry at all, which is
 * indistinguishable from never having reached the node, so the run's history
 * stays exactly as the guard found it.
 *
 * The two guards are deliberately different in kind. A dismissal returns
 * `undefined`: that seat has no work, ever again, and the run carries on without
 * it. A wind-down THROWS, because the run itself must stop — and it throws from
 * the one place that only work not yet started passes through, so the tasks
 * already in flight are left to finish and journal.
 */
function guardedExecutors(options: {
  readonly isAgentDismissed?: ((nodeId: string, scope: ScopeReader) => boolean) | undefined;
  readonly windDown?: { readonly at: number; readonly reason: string; readonly now: () => number };
}): NodeExecutorRegistry | undefined {
  const { isAgentDismissed, windDown } = options;
  if (isAgentDismissed === undefined && windDown === undefined) return undefined;
  const executors = createBuiltinExecutorRegistry();
  const runAgent = executors.get("agent");
  executors.register(
    "agent",
    async (node, context) => {
      const id = node.id;
      if (
        isAgentDismissed !== undefined &&
        id !== undefined &&
        isAgentDismissed(id, context.scope)
      ) {
        return undefined;
      }
      // Checked HERE, not once per run: a run that has been going for hours
      // crosses the deadline in the middle of a fan-out, and the question is
      // always about the next task rather than about the run as a whole.
      if (windDown !== undefined && windDown.now() >= windDown.at) {
        throw new WindDownSignal(windDown.at, windDown.reason);
      }
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
      vacantCapabilities: options.vacantCapabilities,
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
    const executors = guardedExecutors({
      isAgentDismissed: this.compiled.isAgentDismissed,
      ...(options.windDown !== undefined
        ? {
            windDown: {
              at: options.windDown.at,
              reason: options.windDown.reason,
              now: options.now ?? (() => Date.now()),
            },
          }
        : {}),
    });
    this.runner = new WorkflowRunner({
      functions: this.compiled.functions,
      checkpoints: this.checkpoints,
      artifacts: this.artifacts,
      agentExecutor: options.agentExecutor,
      ...(options.onLivePreview !== undefined
        ? { onLivePreview: options.onLivePreview }
        : {}),
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
