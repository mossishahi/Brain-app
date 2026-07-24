/**
 * Internal control-flow signals. These are thrown to unwind the interpreter
 * stack and are handled by the runner (and by parallel/forEach executors when
 * combining branch outcomes); they never escape WorkflowRunner.run/resume.
 */
import type { JsonValue } from "../types/json.js";
import type { PendingGate } from "./checkpoint.js";

/** Raised by humanGate nodes that have no journaled response yet. */
export class SuspendSignal extends Error {
  constructor(readonly pendingGates: readonly PendingGate[]) {
    super(`workflow suspended on ${pendingGates.length} human gate(s)`);
    this.name = "SuspendSignal";
  }
}

/** Raised by terminal nodes to end the whole run from any nesting depth. */
export class TerminalSignal extends Error {
  constructor(
    readonly outcome: "success" | "failure",
    readonly output: JsonValue | undefined,
    readonly reason: string | undefined,
  ) {
    super(`workflow terminated with outcome "${outcome}"${reason ? `: ${reason}` : ""}`);
    this.name = "TerminalSignal";
  }
}
