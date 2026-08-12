import type { SerializedError } from "../errors.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import type { JournalEntry } from "./journal.js";

export type RunStatus =
  | "running"
  | "suspended"
  | "credit_blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface CreditBlock {
  /**
   * Epoch ms when an automatic resume may be submitted; absent when the
   * provider message carried no reset time (e.g. a top-up is needed) and the
   * block must be claimed manually instead of by the scheduler.
   */
  readonly retryAt?: number;
  readonly providerMessage: string;
  readonly source: "deterministic" | "openrouter" | "manual";
}

/** A human gate the run is blocked on. */
export interface PendingGate {
  /** Host-facing identifier used to address the gate in resume(). */
  readonly gateKey: string;
  /** Journal key the response will be recorded under. */
  readonly journalKey: string;
  /** Execution path of the gate node. */
  readonly path: string;
  readonly prompt?: string;
  readonly metadata?: JsonObject;
}

/**
 * The journal layout this build writes.
 *
 * - 1 (implicit, absent field): every activity's return value is journaled —
 *   including the state-fold activities, whose value is a full copy of the
 *   run state. Journals grew as nodes × state size and eventually crossed
 *   the engine's maximum string length.
 * - 2: deterministic folds are never journaled (they re-run on replay);
 *   the journal carries only real outputs — agent results, activity handler
 *   outputs, gate answers, condition verdicts, collections.
 *
 * Loaders that understand only format 1 must not replay a format-2 journal;
 * hosts migrate old journals forward before resuming (never backward).
 */
export const JOURNAL_FORMAT = 2;

/**
 * Full persisted state of a run: input plus the effect journal. Scope and
 * interpreter position are intentionally NOT persisted; they are rebuilt by
 * deterministic replay of the workflow definition against the journal.
 */
export interface WorkflowCheckpoint {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion?: string;
  readonly status: RunStatus;
  readonly input?: JsonObject;
  /** Journal layout version; absent means 1 (pre-fold journals). */
  readonly journalFormat?: number;
  readonly journal: readonly JournalEntry[];
  readonly pendingGates: readonly PendingGate[];
  readonly creditBlock?: CreditBlock;
  readonly output?: JsonValue;
  readonly error?: SerializedError;
  /** Monotonic save counter (deterministic ordering independent of clock). */
  readonly seq: number;
  readonly updatedAt: number;
}

export interface CheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  load(runId: string): Promise<WorkflowCheckpoint | undefined>;
  delete(runId: string): Promise<void>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, WorkflowCheckpoint>();

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    // structuredClone guards against callers mutating shared references.
    this.checkpoints.set(checkpoint.runId, structuredClone(checkpoint));
  }

  async load(runId: string): Promise<WorkflowCheckpoint | undefined> {
    const checkpoint = this.checkpoints.get(runId);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  async delete(runId: string): Promise<void> {
    this.checkpoints.delete(runId);
  }

  /** Test/debug helper. */
  size(): number {
    return this.checkpoints.size;
  }
}
