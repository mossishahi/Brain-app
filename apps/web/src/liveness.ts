/**
 * One answer to "is this run moving right now?", for every part of the UI that
 * animates to say it is.
 *
 * A blinking grid cell, a pulsing dot, a shimmering strip, a live thread —
 * each is a claim that work is in flight. Pausing a run makes every one of
 * those claims false at once, and yet nothing inside the snapshot changes to
 * say so: a step that was "under review" when the pause landed is still
 * "under review" afterwards, because that is exactly where the run resumes.
 * The same is true of a stopped, failed or finished run.
 *
 * So liveness cannot be read off a step, a stage, or a seat — each of them
 * describes where the work STANDS, not whether it moves. It is a property of
 * the run, it is decided here, and it reaches the screen as one attribute on
 * the element that scopes the run (see `livenessAttrs`), which the stylesheet
 * hangs every in-flight animation off.
 */
import { jobIsExecuting, type JobStatus } from "@brainstorm-agentic/protocol";

/**
 * True only while something is actually executing. Every other status —
 * paused, waiting for a human, out of credit, queued behind the scheduler,
 * interrupted, or over — means no agent is thinking, so nothing on screen may
 * imply that one is.
 */
export const runIsLive: (status: JobStatus) => boolean = jobIsExecuting;

/**
 * True while the SERVER is still minding this run on its own — the statuses
 * whose pending gates it will auto-approve (JobManager.autoApproveDueGates).
 * Narrower than "executing" in one direction and wider in the other: a
 * suspended run runs no agent and still gets its countdown honoured, and a
 * paused one is skipped entirely, so its card must stop promising a deadline
 * that nothing will act on.
 */
export function runIsAttended(status: JobStatus): boolean {
  return status === "queued" || status === "running" || status === "suspended";
}

/**
 * Spread onto the element that scopes a run — the dashboard root, a job card.
 * Everything animated below it stills when this reads "false", so a new
 * blinking thing inherits the behaviour instead of having to remember it.
 */
export function livenessAttrs(status: JobStatus): {
  readonly "data-run-live": "true" | "false";
} {
  return { "data-run-live": runIsLive(status) ? "true" : "false" };
}

/**
 * Streamed model text is liveness in data form: it exists only while an agent
 * is mid-thought. A paused run's threads are the last words of a worker that
 * no longer exists, so they are dropped rather than left standing — the place
 * they occupied belongs to the output that will replace them on the resume.
 */
export function liveEntriesWhileLive<T>(
  status: JobStatus,
  entries: readonly T[],
): readonly T[] {
  return runIsLive(status) ? entries : [];
}
