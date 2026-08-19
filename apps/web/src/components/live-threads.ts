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
