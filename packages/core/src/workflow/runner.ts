/**
 * Checkpoint-aware workflow runner.
 *
 * Persistence model: the runner journals every effect (activity results,
 * agent results, condition verdicts, resolved collections, gate responses)
 * under deterministic keys derived from each node's execution path, and
 * checkpoints the journal after every new entry. Interpreter position and
 * scopes are never persisted; `resume` simply re-interprets the workflow
 * definition and replays journaled effects, which deterministically rebuilds
 * control flow and scope state up to the point where new work (or a still
 * unanswered human gate) begins.
 */
import type { AgentExecutor } from "../agent/contracts.js";
import type { SerializedError } from "../errors.js";
import {
  WorkflowCancelledError,
  WorkflowConfigError,
  isCancellation,
  isCreditBlocked,
  serializeError,
} from "../errors.js";
import type { ArtifactStore } from "../store/artifacts.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import type { WorkflowDefinition, WorkflowNode } from "./ast.js";
import type {
  CheckpointStore,
  CreditBlock,
  PendingGate,
  RunStatus,
  WorkflowCheckpoint,
} from "./checkpoint.js";
import { InMemoryCheckpointStore } from "./checkpoint.js";
import type { RunEvent, RunEventBody, RunEventListener } from "./events.js";
import type { JournalEntryKind } from "./journal.js";
import { RunJournal } from "./journal.js";
import { createBuiltinExecutorRegistry } from "./nodes.js";
import type { EffectResult, NodeExecutionContext, NodeExecutorRegistry } from "./registry.js";
import { Scope } from "./scope.js";
import { SuspendSignal, TerminalSignal } from "./signals.js";
import { WorkflowFunctions } from "./functions.js";

export interface WorkflowRunnerOptions {
  /** Named host functions referenced by workflow nodes. */
  readonly functions?: WorkflowFunctions;
  /** Node executor dispatch table; defaults to the builtin kinds. */
  readonly executors?: NodeExecutorRegistry;
  /** Where checkpoints are persisted; defaults to a fresh in-memory store. */
  readonly checkpoints?: CheckpointStore;
  readonly artifacts?: ArtifactStore;
  /** Required only when the workflow contains agent nodes. */
  readonly agentExecutor?: AgentExecutor;
  readonly onEvent?: RunEventListener;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

export interface RunOptions {
  readonly runId?: string;
  /** Initial variables of the root scope. Persisted into the checkpoint. */
  readonly input?: JsonObject;
  readonly signal?: AbortSignal;
  readonly onEvent?: RunEventListener;
}

/** Human gate answers, keyed by gateKey of a pending gate. */
export type GateResponses = { readonly [gateKey: string]: JsonValue };

export interface ResumeOptions {
  readonly responses?: GateResponses;
  readonly signal?: AbortSignal;
  readonly onEvent?: RunEventListener;
}

export type RunResult =
  | { readonly status: "completed"; readonly runId: string; readonly output?: JsonValue }
  | { readonly status: "suspended"; readonly runId: string; readonly pendingGates: readonly PendingGate[] }
  | {
      readonly status: "credit_blocked";
      readonly runId: string;
      /** Absent when the block awaits a manual resume (no reset time known). */
      readonly retryAt?: number;
      readonly providerMessage: string;
      readonly source: "deterministic" | "openrouter" | "manual";
    }
  | { readonly status: "failed"; readonly runId: string; readonly error: SerializedError }
  | { readonly status: "cancelled"; readonly runId: string };

let runIdCounter = 0;

function generateRunId(now: () => number): string {
  runIdCounter += 1;
  return `run-${now().toString(36)}-${runIdCounter.toString(36)}`;
}

function journalKeyFor(path: string, slot: string): string {
  return `${path}::${slot}`;
}

export class WorkflowRunner {
  private readonly functions: WorkflowFunctions;
  private readonly executors: NodeExecutorRegistry;
  private readonly checkpoints: CheckpointStore;
  private readonly artifacts: ArtifactStore | undefined;
  private readonly agentExecutor: AgentExecutor | undefined;
  private readonly listeners: RunEventListener[] = [];
  private readonly now: () => number;

  constructor(options: WorkflowRunnerOptions = {}) {
    this.functions = options.functions ?? new WorkflowFunctions();
    this.executors = options.executors ?? createBuiltinExecutorRegistry();
    this.checkpoints = options.checkpoints ?? new InMemoryCheckpointStore();
    this.artifacts = options.artifacts;
    this.agentExecutor = options.agentExecutor;
    this.now = options.now ?? (() => Date.now());
    if (options.onEvent) this.listeners.push(options.onEvent);
  }

  /** Subscribes to run events; returns an unsubscribe function. */
  onEvent(listener: RunEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** Starts a fresh run. Fails if a checkpoint already exists for runId. */
  async run(definition: WorkflowDefinition, options: RunOptions = {}): Promise<RunResult> {
    const runId = options.runId ?? generateRunId(this.now);
    const existing = await this.checkpoints.load(runId);
    if (existing) {
      throw new WorkflowConfigError(`run "${runId}" already has a checkpoint; use resume() instead`);
    }
    const execution = new RunExecution({
      definition,
      runId,
      input: options.input,
      journal: new RunJournal(),
      resumed: false,
      initialCheckpointSeq: 0,
      signal: options.signal,
      listeners: this.mergedListeners(options.onEvent),
      executors: this.executors,
      functions: this.functions,
      checkpoints: this.checkpoints,
      artifacts: this.artifacts,
      agentExecutor: this.agentExecutor,
      now: this.now,
    });
    return execution.execute();
  }

  /**
   * Resumes a run from its persisted checkpoint, optionally answering
   * pending human gates. Suspended, cancelled, credit-blocked, crashed
   * ("running"), and FAILED checkpoints are all resumable: failures are
   * never journaled, so replaying a failed run re-executes exactly the
   * task that failed (a transient provider or subprocess error costs one
   * retry, never the run's completed work). Only completed runs refuse —
   * their result already stands. A run that failed at a terminal node with
   * outcome "failure" deterministically reaches the same terminal again.
   */
  async resume(definition: WorkflowDefinition, runId: string, options: ResumeOptions = {}): Promise<RunResult> {
    const checkpoint = await this.checkpoints.load(runId);
    if (!checkpoint) {
      throw new WorkflowConfigError(`no checkpoint found for run "${runId}"`);
    }
    if (checkpoint.status === "completed") {
      throw new WorkflowConfigError(`run "${runId}" already finished with status "${checkpoint.status}"`);
    }
    if (checkpoint.workflowId !== definition.id) {
      throw new WorkflowConfigError(
        `checkpoint for run "${runId}" belongs to workflow "${checkpoint.workflowId}", not "${definition.id}"`,
      );
    }
    const journal = RunJournal.fromEntries(checkpoint.journal);
    for (const [gateKey, value] of Object.entries(options.responses ?? {})) {
      const gate = checkpoint.pendingGates.find((candidate) => candidate.gateKey === gateKey);
      if (!gate) {
        throw new WorkflowConfigError(`run "${runId}" has no pending gate "${gateKey}"`);
      }
      journal.record({ key: gate.journalKey, kind: "gate", value });
    }
    const execution = new RunExecution({
      definition,
      runId,
      input: checkpoint.input,
      journal,
      resumed: true,
      initialCheckpointSeq: checkpoint.seq,
      signal: options.signal,
      listeners: this.mergedListeners(options.onEvent),
      executors: this.executors,
      functions: this.functions,
      checkpoints: this.checkpoints,
      artifacts: this.artifacts,
      agentExecutor: this.agentExecutor,
      now: this.now,
    });
    return execution.execute();
  }

  private mergedListeners(extra?: RunEventListener): readonly RunEventListener[] {
    return extra ? [...this.listeners, extra] : [...this.listeners];
  }
}

interface ExecutionConfig {
  readonly definition: WorkflowDefinition;
  readonly runId: string;
  readonly input: JsonObject | undefined;
  readonly journal: RunJournal;
  readonly resumed: boolean;
  readonly initialCheckpointSeq: number;
  readonly signal: AbortSignal | undefined;
  readonly listeners: readonly RunEventListener[];
  readonly executors: NodeExecutorRegistry;
  readonly functions: WorkflowFunctions;
  readonly checkpoints: CheckpointStore;
  readonly artifacts: ArtifactStore | undefined;
  readonly agentExecutor: AgentExecutor | undefined;
  readonly now: () => number;
}

interface CheckpointExtras {
  readonly pendingGates?: readonly PendingGate[];
  readonly output?: JsonValue;
  readonly error?: SerializedError;
  readonly creditBlock?: CreditBlock;
}

/** Single run/resume attempt. Not reused across invocations. */
class RunExecution {
  private readonly signal: AbortSignal;
  private eventSeq = 0;
  private checkpointSeq: number;
  /** The physical write currently in flight; always settles, never rejects. */
  private saveWrite: Promise<void> | undefined;
  /** The one flush queued behind it, shared by every coalesced requester. */
  private saveFlush: Promise<void> | undefined;
  /** The latest requested lifecycle state — what the next flush writes. */
  private savePending: { status: RunStatus; extras: CheckpointExtras } | undefined;

  constructor(private readonly cfg: ExecutionConfig) {
    this.signal = cfg.signal ?? new AbortController().signal;
    this.checkpointSeq = cfg.initialCheckpointSeq;
  }

  async execute(): Promise<RunResult> {
    const { definition, runId } = this.cfg;
    this.emit({ type: "run:started", workflowId: definition.id, resumed: this.cfg.resumed });
    try {
      await this.saveCheckpoint("running");
      const rootScope = Scope.root(this.cfg.input);
      const rootSegment = definition.root.id ?? "root";
      const output = await this.executeNode(definition.root, rootSegment, rootScope);
      return await this.complete(output);
    } catch (error) {
      if (error instanceof TerminalSignal) {
        if (error.outcome === "success") return await this.complete(error.output);
        return await this.fail({
          name: "WorkflowTerminatedError",
          message: error.reason ?? 'workflow reached a terminal node with outcome "failure"',
        });
      }
      if (error instanceof SuspendSignal) {
        await this.saveCheckpoint("suspended", { pendingGates: error.pendingGates });
        this.emit({ type: "run:suspended", pendingGates: error.pendingGates });
        return { status: "suspended", runId, pendingGates: error.pendingGates };
      }
      if (isCreditBlocked(error)) {
        const creditBlock: CreditBlock = {
          ...(error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
          providerMessage: error.providerMessage,
          source: error.source,
        };
        await this.saveCheckpoint("credit_blocked", { creditBlock });
        this.emit({ type: "run:credit_blocked", ...creditBlock });
        return {
          status: "credit_blocked",
          runId,
          ...creditBlock,
        };
      }
      if (isCancellation(error)) {
        await this.saveCheckpoint("cancelled");
        this.emit({ type: "run:cancelled" });
        return { status: "cancelled", runId };
      }
      return await this.fail(serializeError(error));
    }
  }

  private async complete(output: JsonValue | undefined): Promise<RunResult> {
    await this.saveCheckpoint("completed", output !== undefined ? { output } : {});
    this.emit({ type: "run:completed", ...(output !== undefined ? { output } : {}) });
    return { status: "completed", runId: this.cfg.runId, ...(output !== undefined ? { output } : {}) };
  }

  private async fail(error: SerializedError): Promise<RunResult> {
    await this.saveCheckpoint("failed", { error });
    this.emit({ type: "run:failed", error });
    return { status: "failed", runId: this.cfg.runId, error };
  }

  private async executeNode(node: WorkflowNode, path: string, scope: Scope): Promise<JsonValue | undefined> {
    if (this.signal.aborted) throw new WorkflowCancelledError();
    const executor = this.cfg.executors.get(node.kind);
    this.emit({ type: "node:started", path, kind: node.kind });
    try {
      const value = await executor(node, this.createContext(path, scope));
      this.emit({ type: "node:completed", path, kind: node.kind });
      return value;
    } catch (error) {
      // Suspension, termination, and cancellation are control flow, not node failures.
      if (
        error instanceof SuspendSignal ||
        error instanceof TerminalSignal ||
        isCancellation(error) ||
        isCreditBlocked(error)
      ) {
        throw error;
      }
      this.emit({ type: "node:failed", path, kind: node.kind, error: serializeError(error) });
      throw error;
    }
  }

  private createContext(path: string, scope: Scope): NodeExecutionContext {
    return {
      runId: this.cfg.runId,
      path,
      scope,
      signal: this.signal,
      functions: this.cfg.functions,
      artifacts: this.cfg.artifacts,
      agentExecutor: this.cfg.agentExecutor,
      child: (node, segment, childScope) => this.executeNode(node, `${path}/${segment}`, childScope ?? scope),
      effect: (slot, kind, produce) => this.effect(path, slot, kind, produce),
      journalKey: (slot) => journalKeyFor(path, slot),
      lookupEffect: (slot) => this.cfg.journal.lookup(journalKeyFor(path, slot)),
      emit: (body) => this.emit(body),
      fnContext: () => ({
        runId: this.cfg.runId,
        nodePath: path,
        signal: this.signal,
        ...(this.cfg.artifacts ? { artifacts: this.cfg.artifacts } : {}),
      }),
    };
  }

  private async effect(
    path: string,
    slot: string,
    kind: JournalEntryKind,
    produce: () => JsonValue | undefined | Promise<JsonValue | undefined>,
  ): Promise<EffectResult> {
    const key = journalKeyFor(path, slot);
    const found = this.cfg.journal.lookup(key);
    if (found.hit) {
      this.emit({ type: "effect:recorded", path, slot, journalKind: kind, replayed: true });
      return { value: found.value, replayed: true };
    }
    if (this.signal.aborted) throw new WorkflowCancelledError();
    const value = await this.raceAbort(produce());
    this.cfg.journal.record({ key, kind, ...(value !== undefined ? { value } : {}) });
    this.emit({ type: "effect:recorded", path, slot, journalKind: kind, replayed: false });
    await this.saveCheckpoint("running");
    return { value, replayed: false };
  }

  /** Settles as cancelled the moment the signal aborts, even if work hangs. */
  private raceAbort<T>(work: Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.signal.aborted) {
        reject(new WorkflowCancelledError());
        return;
      }
      const onAbort = (): void => reject(new WorkflowCancelledError());
      this.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(work).then(
        (value) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          this.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private emit(body: RunEventBody): void {
    const event = { ...body, runId: this.cfg.runId, seq: this.eventSeq++, at: this.cfg.now() } as RunEvent;
    for (const listener of this.cfg.listeners) listener(event);
  }

  /**
   * Requests a checkpoint write. Writes COALESCE: at most one write is in
   * flight and at most one flush is queued behind it, so a burst of requests
   * (parallel branches each recording an effect) collapses into a single
   * follow-up write instead of queueing one full-journal serialization per
   * request on a shared filesystem. Latest request wins, with durability
   * identical to writing every request in order: requests arrive in
   * lifecycle order, the journal is re-read when the write is built, so the
   * surviving write carries every coalesced requester's entries and at least
   * as much state as each requester saw — and the previous regime's
   * intermediate writes were overwritten by the last one anyway. A caller's
   * promise settles only once the write carrying its request is durable.
   */
  private saveCheckpoint(status: RunStatus, extras: CheckpointExtras = {}): Promise<void> {
    this.savePending = { status, extras };
    this.saveFlush ??= this.flushCheckpoint();
    return this.saveFlush;
  }

  private async flushCheckpoint(): Promise<void> {
    // Also yields once when idle, so saveFlush is assigned before it clears.
    await this.saveWrite;
    const { status, extras } = this.savePending!;
    this.savePending = undefined;
    // Cleared before writing: requests landing mid-write queue the next flush.
    this.saveFlush = undefined;
    const write = this.writeCheckpoint(status, extras);
    this.saveWrite = write.then(
      () => {
        this.saveWrite = undefined;
      },
      () => {
        this.saveWrite = undefined;
      },
    );
    await write;
  }

  private async writeCheckpoint(status: RunStatus, extras: CheckpointExtras): Promise<void> {
    const checkpoint: WorkflowCheckpoint = {
      runId: this.cfg.runId,
      workflowId: this.cfg.definition.id,
      ...(this.cfg.definition.version !== undefined ? { workflowVersion: this.cfg.definition.version } : {}),
      status,
      ...(this.cfg.input !== undefined ? { input: this.cfg.input } : {}),
      journal: this.cfg.journal.toEntries(),
      pendingGates: extras.pendingGates ?? [],
      ...(extras.creditBlock !== undefined
        ? { creditBlock: extras.creditBlock }
        : {}),
      ...(extras.output !== undefined ? { output: extras.output } : {}),
      ...(extras.error !== undefined ? { error: extras.error } : {}),
      seq: ++this.checkpointSeq,
      updatedAt: this.cfg.now(),
    };
    await this.cfg.checkpoints.save(checkpoint);
    this.emit({ type: "checkpoint:saved", status });
  }
}
