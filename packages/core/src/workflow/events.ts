import type { SerializedError } from "../errors.js";
import type { AgentProgress } from "../agent/contracts.js";
import type { JsonValue } from "../types/json.js";
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
      readonly type: "run:credit_blocked";
      readonly retryAt: number;
      readonly providerMessage: string;
      readonly source: "deterministic" | "openrouter";
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
