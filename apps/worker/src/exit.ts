/**
 * Making a finished worker exit, whatever handles it is still holding.
 *
 * The fatal path in main.ts has always exited decisively, for the reason its own
 * comment gives: an alive-but-dead worker is the one state the server cannot
 * tell apart from a healthy one. A run that finished NORMALLY had no such rule,
 * and a run that failed as a RESULT (a task error, not a thrown one) finishes
 * normally.
 *
 * A live run proved what that costs. The run failed, the worker wrote
 * `run:failed`, printed its outcome — and then sat in the event loop for
 * thirteen hours holding a child process's pipes. Its SLURM job therefore
 * stayed RUNNING, so the server, whose liveness verdict for a scheduler-hosted
 * run is the scheduler's own answer, reported a dead run as working; and the
 * resume the submitter then ordered started a SECOND worker over the same
 * workspace while the first still held it.
 */

/**
 * How long a finished worker may take to drain on its own before it is made to
 * exit. Long enough for stdout on a network filesystem, the telemetry record and
 * the event-log flush — all of which the command already awaited — and nothing
 * like long enough to matter against a job whose walltime is measured in hours.
 */
export const EXIT_GRACE_MS = 20_000;

export interface FinishedExitDeps {
  readonly exit: (code: number) => void;
  readonly log: (message: string) => void;
  readonly graceMs?: number;
}

/**
 * Arms the exit. Returns the timer so a caller (and a test) can see that it is
 * UNREF'D: the watchdog must never hold the loop open itself, or it would delay
 * every healthy worker by the grace period. Unref'd, it fires only if the
 * process is somehow still alive when the grace runs out — and then names the
 * handles that held it, so the next cause of a hang does not need a debugger.
 */
export function scheduleFinishedExit(deps: Partial<FinishedExitDeps> = {}): NodeJS.Timeout {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.error(message));
  const graceMs = deps.graceMs ?? EXIT_GRACE_MS;
  const timer = setTimeout(() => {
    // Read the code at FIRE time: the command sets it while finishing. It is
    // typed as string|number because a string is legal to assign; the worker
    // only ever sets numbers, and a non-numeric one still exits non-zero.
    const raw = process.exitCode ?? 0;
    const code = typeof raw === "number" ? raw : Number(raw) || 1;
    const held =
      typeof process.getActiveResourcesInfo === "function"
        ? [...new Set(process.getActiveResourcesInfo())].sort().join(", ")
        : "unknown";
    log(
      `[worker] the command finished ${graceMs / 1000}s ago and the process is ` +
        `still alive; exiting with code ${code}. Handles still open: ${held || "none"}`,
    );
    exit(code);
  }, graceMs);
  timer.unref();
  return timer;
}
