/**
 * The server's side of an agent's LIVE TEXT: what a model is saying while a
 * reader waits, held only until the task's real output exists.
 *
 * WHAT THIS IS NOT: a transcript. Nothing here is persisted, nothing is read
 * back, no view is derived from it, and a finished task's thread is deleted
 * rather than archived — the run is built from task OUTPUTS, which travel the
 * ordinary way. This holds live threads in memory for as long as they are live
 * and forgets them.
 *
 * HOW IT REACHES THE BROWSER, and why it costs one request of nobody: the worker
 * appends fragments to one file per run; this tails the appended bytes the same
 * way the event log is tailed, and the dashboard's existing SSE frame carries the
 * DELTA per connection. A reader watching a fan-out of forty tasks makes no
 * requests at all, and the frame carries only what was said since the last one.
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";

/** One task's live thread, as the reader holds it. */
interface LiveThread {
  text: string;
  updatedAt: number;
}

export interface LiveTextDelta {
  /** Execution path of the task, which is how every channel names it. */
  readonly path: string;
  /** Characters written since this reader's last frame. */
  readonly append?: string;
  /** The whole thread — a reader's first frame for it, or after a truncation. */
  readonly text?: string;
  /** The task's output exists (or it died): drop the thread. */
  readonly ended?: true;
}

/**
 * A thread with no fragment for this long is dropped even without an end
 * record: a worker killed mid-task writes none, and a thread left standing shows
 * a dead agent as talking.
 */
const STALE_MS = 120_000;

/** Cap per thread. Far above a real task's output, and not a policy — a floor. */
const MAX_THREAD_CHARS = 400_000;

export class LiveTextStore {
  private readonly threads = new Map<string, LiveThread>();
  private offset = 0;
  private size = 0;
  private partial = "";

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Reads whatever the worker has appended since the last call. Cheap when
   * nothing changed: one stat.
   */
  poll(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    // A fresh worker truncates the file: its predecessor's threads describe work
    // that is no longer running.
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
      for (const path of this.threads.keys()) this.markEnded(path);
    }
    if (size !== this.size) this.size = size;
    if (size > this.offset) this.consume(size);
    this.expire();
  }

  private consume(size: number): void {
    let text: string;
    try {
      const fd = openSync(this.file, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        const read = readSync(fd, buffer, 0, buffer.length, this.offset);
        text = buffer.subarray(0, read).toString("utf8");
        this.offset += Buffer.byteLength(text, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    const lines = (this.partial + text).split("\n");
    // A writer mid-append leaves the last line incomplete; keep it for later.
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let record: { p?: unknown; t?: unknown; done?: unknown };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      if (typeof record.p !== "string") continue;
      if (record.done === true) {
        this.markEnded(record.p);
        continue;
      }
      if (typeof record.t !== "string" || record.t.length === 0) continue;
      const thread = this.threads.get(record.p);
      if (thread === undefined) {
        this.threads.set(record.p, {
          text: record.t.slice(-MAX_THREAD_CHARS),
          updatedAt: this.now(),
        });
      } else {
        thread.text = (thread.text + record.t).slice(-MAX_THREAD_CHARS);
        thread.updatedAt = this.now();
      }
    }
  }

  private markEnded(path: string): void {
    this.threads.delete(path);
  }

  private expire(): void {
    const cutoff = this.now() - STALE_MS;
    for (const [path, thread] of this.threads) {
      if (thread.updatedAt < cutoff) this.markEnded(path);
    }
  }

  /**
   * What one reader has not seen yet, and nothing else.
   *
   * `seen` is that reader's own position in each thread — how many characters it
   * has already been sent — and it is UPDATED here, so a frame carries only the
   * characters written since the last one. A thread the reader knows about that
   * no longer exists is reported ended, which is how a task's output replacing
   * its live text reaches the page.
   *
   * At a model's real pace (a few hundred characters a second) a frame carries a
   * kilobyte or so per talking task, whatever the thread has grown to.
   */
  deltas(seen: Map<string, number>): readonly LiveTextDelta[] {
    const out: LiveTextDelta[] = [];
    for (const [path, thread] of this.threads) {
      const already = seen.get(path) ?? 0;
      if (already === thread.text.length) continue;
      if (already > thread.text.length) {
        // The thread was truncated at its floor: resend it whole rather than
        // splicing a reader into the middle of a sentence.
        out.push({ path, text: thread.text });
      } else {
        out.push({ path, append: thread.text.slice(already) });
      }
      seen.set(path, thread.text.length);
    }
    for (const path of [...seen.keys()]) {
      if (this.threads.has(path)) continue;
      out.push({ path, ended: true });
      seen.delete(path);
    }
    return out;
  }

  /** How many threads are live right now. */
  get liveCount(): number {
    return this.threads.size;
  }
}
