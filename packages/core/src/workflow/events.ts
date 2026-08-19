import type { SerializedError } from "../errors.js";
import type { AgentProgress } from "../agent/contracts.js";
import type { JsonValue } from "../types/json.js";
import type { TokenUsage } from "../model/response.js";
import type { PendingGate, RunStatus } from "./checkpoint.js";

/** Fields the runner stamps onto every event. */
export interface RunEventMeta {
  readonly runId: string;
  /** Monotonic per-run sequence number. */
  readonly seq: number;
  /** Timestamp from the runner's (injectable) clock. */
  readonly at: number;
}

export type RunEventBody =
  | { readonly type: "run:started"; readonly workflowId: string; readonly resumed: boolean }
  | { readonly type: "run:completed"; readonly output?: JsonValue }
  | { readonly type: "run:failed"; readonly error: SerializedError }
  | { readonly type: "run:suspended"; readonly pendingGates: readonly PendingGate[] }
  | { readonly type: "run:cancelled" }
  | {
      /**
       * The host asked the run to stop starting work before its allocation ran
       * out; the checkpoint is resumable and nothing was in flight. Recorded so
       * a handover is visible in the log as a handover, not as a gap.
       */
      readonly type: "run:wound_down";
      readonly deadline: number;
      readonly reason: string;
    }
  | {
      readonly type: "run:credit_blocked";
      /** Absent when the block awaits a manual resume (no reset time known). */
      readonly retryAt?: number;
      readonly providerMessage: string;
      readonly source: "deterministic" | "openrouter" | "manual";
    }
  | { readonly type: "node:started"; readonly path: string; readonly kind: string }
  | { readonly type: "node:completed"; readonly path: string; readonly kind: string }
  | { readonly type: "node:failed"; readonly path: string; readonly kind: string; readonly error: SerializedError }
  | {
      readonly type: "effect:recorded";
      readonly path: string;
      readonly slot: string;
      readonly journalKind: string;
      /** True when the value came from the journal instead of executing. */
      readonly replayed: boolean;
    }
  | { readonly type: "agent:started"; readonly path: string; readonly taskId: string; readonly taskKind: string }
  | {
      readonly type: "agent:completed";
      readonly path: string;
      readonly taskId: string;
      readonly taskKind: string;
      readonly status: "ok" | "error";
      /**
       * The attempt's token spend, straight off the AgentResult. On the
       * event (not only in the journal) so FAILED attempts' spend is
       * recorded too — failures are never journaled.
       */
      readonly usage?: TokenUsage;
    }
  | {
      readonly type: "agent:progress";
      readonly path: string;
      readonly taskId: string;
      readonly taskKind: string;
      readonly progress: AgentProgress;
    }
  | { readonly type: "gate:pending"; readonly path: string; readonly gateKey: string; readonly prompt?: string }
  | { readonly type: "gate:resolved"; readonly path: string; readonly gateKey: string }
  | { readonly type: "checkpoint:saved"; readonly status: RunStatus };

export type RunEvent = RunEventBody & RunEventMeta;

export type RunEventListener = (event: RunEvent) => void;
