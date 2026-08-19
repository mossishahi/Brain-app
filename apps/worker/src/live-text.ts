/**
 * The transport for an agent's LIVE TEXT: what a model is saying while a reader
 * waits, so a task that runs for minutes shows a thread to read instead of the
 * word "thinking".
 *
 * WHAT THIS IS NOT: the chain of thought. It is never journalled, never an
 * artifact, never in the event log, and nothing reads it back — the thread is
 * discarded the moment the task's real output exists, which is the only thing the
 * run is built from. The file below is a pipe with a floor under it, not a
 * record.
 *
 * WHY ONE APPEND-ONLY FILE, and not a file per task: the server and the worker
 * are separate SLURM jobs that share only a filesystem, and a review fan-out can
 * have dozens of tasks in flight at once. One file per task means dozens of stats
 * per dashboard tick on a network filesystem; one shared file means the server
 * reads the appended bytes exactly the way it already tails the event log, and
 * the fragments for every task arrive interleaved in one read. The cost of the
 * write side is bounded the same way: fragments accumulate in memory and are
 * appended on a timer, so a hundred deltas a second become one write.
 */
import { appendFile, writeFile } from "node:fs/promises";

/** One line of the transport: fragments for a task, or that task's end. */
export interface LiveTextRecord {
  /** Execution path of the task, which is how every other channel names it. */
  readonly p: string;
  /** Appended fragment. Absent on an end record. */
  readonly t?: string;
  /** Present when the task is over and its thread must be dropped. */
  readonly done?: true;
}

/**
 * How often accumulated fragments are written. The reader's own cadence is about
 * a second, so writing faster would buy nothing and cost a filesystem operation
 * per fragment.
 */
const FLUSH_MS = 1_000;

/**
 * A task's thread is dropped this long after its last fragment even if no end
 * record arrives — a worker killed mid-task writes no end record, and a thread
 * that lingers forever would show a dead agent as talking.
 */
export const LIVE_TEXT_STALE_MS = 120_000;

export interface LiveTextLog {
  /** Appends a fragment to a task's thread. */
  note(path: string, text: string): void;
  /** Ends a task's thread: the reader drops it. */
  end(path: string): void;
  /** Writes whatever is buffered and stops the timer. */
  close(): Promise<void>;
}

/** A log that discards everything, for hosts that show no live text. */
export function noLiveText(): LiveTextLog {
  return { note: () => {}, end: () => {}, close: () => Promise.resolve() };
}

export function createLiveTextLog(file: string): LiveTextLog {
  let pending = new Map<string, string>();
  const ended: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let failed = false;
  // A fresh process starts a fresh thread: the previous attempt's fragments
  // describe work that is no longer running, and its tasks either finished or
  // will be replayed from the journal.
  chain = writeFile(file, "", "utf8").catch(() => {
    failed = true;
  });

  const flush = (): void => {
    if (failed || (pending.size === 0 && ended.length === 0)) return;
    const lines: string[] = [];
    for (const [p, t] of pending) lines.push(JSON.stringify({ p, t } satisfies LiveTextRecord));
    for (const p of ended) lines.push(JSON.stringify({ p, done: true } satisfies LiveTextRecord));
    pending = new Map();
    ended.length = 0;
    chain = chain.then(async () => {
      try {
        await appendFile(file, lines.join("\n") + "\n", "utf8");
      } catch {
        // Live text is the one channel allowed to fail silently: it exists so a
        // reader has something to watch, and a filesystem blip must not touch
        // the run. One failure stops the writer for good rather than retrying
        // into a wall.
        failed = true;
      }
    });
  };

  const arm = (): void => {
    if (timer !== undefined || failed) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, FLUSH_MS);
    // Never hold the process open for a fragment nobody is waiting for.
    timer.unref();
  };

  return {
    note(path, text) {
      if (failed || text.length === 0) return;
      pending.set(path, (pending.get(path) ?? "") + text);
      arm();
    },
    end(path) {
      if (failed) return;
      pending.delete(path);
      ended.push(path);
      arm();
    },
    async close() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      flush();
      await chain;
    },
  };
}
