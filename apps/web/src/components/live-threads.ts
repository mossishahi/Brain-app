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
