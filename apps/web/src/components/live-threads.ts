/**
 * The live text a page is holding: what each model is saying right now, in the
 * places that would otherwise say "thinking".
 *
 * NOT the chain of thought. Frames carry only what was written since the last
 * one, so this appends; a thread is DELETED the moment its task's real output
 * exists, because from then on the page shows the output and this was only ever
 * the wait. Nothing here is persisted or cached with the job.
 *
 * A pure module so it can be tested on its own — the accumulation is the part
 * that would silently break (a lost append reads as a model that stopped
 * talking).
 */
import type { LiveTextEntry } from "@brainstorm-agentic/protocol";

/** One task's live thread as the page holds it, with who is talking. */
export interface LiveThread {
  readonly text: string;
  readonly role?: string;
  readonly actor?: string;
  /** The talking agent's seat id, when it is a seat; how a card is matched. */
  readonly actorId?: string;
  /** The seat whose chain is being worked on. */
  readonly seatId?: string;
  readonly where?: LiveTextEntry["where"];
}

/**
 * Applies one live frame. An `append` carries only what is new; a whole `text`
 * replaces (a first frame, or a repair after a truncation); `ended` deletes.
 * An empty frame returns the same map, so React re-renders nothing.
 */
export function applyLiveEntries(
  previous: ReadonlyMap<string, LiveThread>,
  entries: readonly LiveTextEntry[],
): ReadonlyMap<string, LiveThread> {
  if (entries.length === 0) return previous;
  const next = new Map(previous);
  for (const entry of entries) {
    if (entry.ended === true) {
      next.delete(entry.id);
      continue;
    }
    const existing = next.get(entry.id);
    const text =
      entry.text !== undefined
        ? entry.text
        : `${existing?.text ?? ""}${entry.append ?? ""}`;
    next.set(entry.id, {
      text,
      ...(entry.role !== undefined ? { role: entry.role } : {}),
      ...(entry.actor !== undefined ? { actor: entry.actor } : {}),
      ...(entry.actorId !== undefined ? { actorId: entry.actorId } : {}),
      ...(entry.seatId !== undefined ? { seatId: entry.seatId } : {}),
      ...(entry.where !== undefined ? { where: entry.where } : {}),
    });
  }
  return next;
}

/**
 * How long the display takes to catch up with text it has been handed. Frames
 * arrive about once a second; catching up over rather less than that keeps the
 * words flowing continuously without ever falling behind the model.
 */
export const REVEAL_CATCH_UP_MS = 700;

/**
 * The most the display may trail the model by: roughly four seconds of writing.
 *
 * Catch-up is proportional to the backlog, which approaches zero asymptotically
 * — so without a bound, a reader who was handed a large block (a tab that was in
 * a background window, where animation frames stop) would watch it type itself
 * out for many seconds after the model had moved on. Past this, the display skips
 * ahead and paces from there: the words are there to read either way, and the
 * point of the thread is what is happening NOW.
 */
export const MAX_REVEAL_LAG_CHARS = 1_200;

/**
 * How many characters may be shown next, given how many are shown now.
 *
 * The transport delivers about a second of writing at a time, and appending it
 * whole makes a thread land in visible jumps — several lines at once, then
 * nothing at all. This paces the reveal instead: the backlog is spread over
 * REVEAL_CATCH_UP_MS, so a frame's worth of words arrives as writing rather than
 * as delivery, and a bigger backlog is revealed faster rather than later.
 *
 * Never returns less than `current` (a thread does not rewind) and never more
 * than `target` (it does not invent). The one-character floor keeps a nearly
 * caught-up thread from stalling a character short of the words it has.
 */
export function revealStep(current: number, target: number, elapsedMs: number): number {
  if (current >= target) return target;
  const from = Math.max(current, target - MAX_REVEAL_LAG_CHARS);
  const perMs = Math.max((target - from) / REVEAL_CATCH_UP_MS, 0.03);
  return Math.min(target, from + Math.max(1, Math.round(perMs * Math.max(elapsedMs, 0))));
}

/* ----------------------------------- the stages that run before a panel exists */

/**
 * The roles each early stage runs, in the order it runs them.
 *
 * These stages are the reason the lists exist at all: they have no seat, no
 * step and no round, so a thread there cannot be addressed the way a first-pass
 * or review thread is. What it does have is a ROLE, and each stage's roles are
 * a closed set — the workflow names them — so a panel asks for its own.
 */
export const PROCESS_INPUT_ROLES: readonly string[] = [
  "Processor",
  "Classifier",
  "Annotator",
];
export const DECOMPOSE_ROLES: readonly string[] = ["Pool builder", "Placer"];

/**
 * The live threads of tasks that have NO seat, keyed by role.
 *
 * A seat is what every other selector matches on, and the stages before the
 * panel is seated have none — which is exactly why their threads reached the
 * browser and were dropped on the floor. `seatId` is the test rather than the
 * stage, because the server sets it from the execution path and a role is only
 * ever a label.
 */
export function seatlessLiveByRole(
  live: ReadonlyMap<string, LiveThread>,
): ReadonlyMap<string, LiveThread> {
  const out = new Map<string, LiveThread>();
  for (const thread of live.values()) {
    if (thread.seatId !== undefined || thread.role === undefined) continue;
    out.set(thread.role, thread);
  }
  return out;
}

/** One seatless thread with the role that has to be shown beside it. */
export interface RoleThread {
  readonly role: string;
  readonly text: string;
}

/**
 * The threads a stage should show, in the stage's own role order.
 *
 * The order matters because these roles run in SEQUENCE, so a reader watching
 * the stage reads down the same way the run works down. A thread with nothing
 * in it yet is left out: an empty labelled box says a task is silent when it
 * has simply not started.
 */
export function liveForRoles(
  byRole: ReadonlyMap<string, LiveThread>,
  roles: readonly string[],
): readonly RoleThread[] {
  const out: RoleThread[] = [];
  for (const role of roles) {
    const thread = byRole.get(role);
    if (thread === undefined || thread.text.trim().length === 0) continue;
    out.push({ role, text: thread.text });
  }
  return out;
}

/** One live thread as a review card needs it. */
export interface LiveReviewThread {
  readonly text: string;
  readonly role?: string;
  readonly actor?: string;
  readonly where?: { readonly seat?: string; readonly step?: number; readonly round?: number };
}

/**
 * Where a step's live threads belong.
 *
 * THE RULE: live text never gets a place of its own — it occupies the place of
 * the output it is producing, and is replaced by that output when it lands. A
 * redeveloper is writing the step's NEXT version, so its words belong in the
 * next card of the deck; a commenter or a judge is writing a comment or a
 * judgement, so theirs belong in the panel where those appear, under the same
 * name. Anything else puts a second copy of the work on screen, in a box that
 * has to be mentally matched to the thing it will become.
 */
export function liveDestinations(
  threads: readonly LiveReviewThread[],
  step: number,
): {
  readonly writingNextVersion: LiveReviewThread | undefined;
  readonly reviewers: readonly LiveReviewThread[];
} {
  const here = threads.filter(
    (thread) => thread.where?.step === undefined || thread.where.step === step,
  );
  return {
    writingNextVersion: here.find((thread) => thread.role === "Redeveloper"),
    reviewers: here.filter((thread) => thread.role !== "Redeveloper"),
  };
}

/**
 * The reviewers whose live text still has something to say: the ones whose
 * comment has NOT landed. Once it has, the comment is the thing to read and the
 * thread is gone — the same rule as everywhere else, applied per reviewer
 * rather than per card, because a round's comments land one at a time.
 */
export function pendingReviewers(
  landedLabels: readonly string[],
  threads: readonly LiveReviewThread[],
): readonly LiveReviewThread[] {
  const landed = new Set(landedLabels);
  return threads.filter(
    (thread) =>
      thread.role !== "Judge" && thread.actor !== undefined && !landed.has(thread.actor),
  );
}
