import {
  type ContentBundle,
  type WorkflowDefinition as ContentWorkflowDefinition,
} from "@brainstorm-agentic/content";
import {
  InMemoryArtifactStore,
  InMemoryCheckpointStore,
  WorkflowRunner,
  type AgentExecutor,
  type ArtifactStore,
  type CheckpointStore,
  type GateResponses,
  type HostToolManifest,
  type JsonValue,
  type ProviderNativeOffer,
  type RunEventListener,
  type RunResult,
} from "@brainstorm-agentic/core";

import {
  compileContentWorkflow,
  type CompiledContentWorkflow,
  type DeterministicActivityHandler,
} from "./compiler.js";
import type { HumanGateMode } from "./gates.js";
import type { BrainstormRouteResolver, CapabilityToolResolver } from "./routes.js";

export interface BrainstormRuntimeOptions {
  readonly agentExecutor: AgentExecutor;
  /** Host-fetched, hash-verified, and validated registry bundle. */
  readonly bundle: ContentBundle;
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
    });
    this.checkpoints = options.checkpoints ?? new InMemoryCheckpointStore();
    this.artifacts = options.artifacts ?? new InMemoryArtifactStore();
    this.runner = new WorkflowRunner({
      functions: this.compiled.functions,
      checkpoints: this.checkpoints,
      artifacts: this.artifacts,
      agentExecutor: options.agentExecutor,
      onEvent: options.onEvent,
      now: options.now,
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
