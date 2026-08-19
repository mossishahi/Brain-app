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

/**
 * Raised when the host the run lives in is about to run out of time.
 *
 * A scheduler-hosted run is killed the moment its allocation ends, mid-task,
 * and everything not yet journaled is bought again on the resume. This signal is
 * the alternative: past a deadline the host passes in, no NEW agent task starts,
 * and the run unwinds as CONTROL FLOW rather than as a failure.
 *
 * What makes it cheap is where the fan-out combines its branches: every branch
 * is settled before the outcome is decided, so the tasks already in flight run
 * to completion and journal, and only work that had not started is skipped. The
 * checkpoint the runner then writes is an ordinary `running` one — exactly what
 * an interrupted run leaves behind — so the host's existing resume path
 * continues it with nothing re-bought and no new state to understand.
 */
export class WindDownSignal extends Error {
  constructor(
    /** Epoch ms the host asked the run to stop starting work by. */
    readonly deadline: number,
    /** What the host said it was: a walltime, mostly. */
    readonly reason: string,
  ) {
    super(`workflow wound down before ${new Date(deadline).toISOString()}: ${reason}`);
    this.name = "WindDownSignal";
  }
}
