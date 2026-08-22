/**
 * The transport for a PROMPT RECORD: exactly what this worker handed a model on
 * one call, so a reader who clicks the row for that call can read the request
 * behind it instead of guessing what the agent was asked.
 *
 * WHAT THIS IS NOT: part of the run. A prompt is never journalled, never an
 * artifact, never in events.jsonl and never in the telemetry summary — those
 * channels are sanitized, replayed and kept, and a prompt is none of those
 * things. The file below is a pipe with a floor under it, read only when a
 * reader asks for one record by id.
 *
 * WHY ONE APPEND-ONLY FILE, and why it batches: the server and the worker are
 * separate SLURM jobs that share only a filesystem, exactly as with live text
 * (see live-text.ts), so the file IS the channel. Records accumulate in memory
 * and are appended on a timer, so a review fan-out that starts a dozen agents
 * in the same second costs one write rather than a dozen.
 *
 * TWO deliberate differences from live text:
 *
 *  - A fresh worker APPENDS instead of truncating. A resumed run replays its
 *    finished tasks from the journal rather than re-issuing their prompts, so
 *    the earlier attempt's records are the ONLY copy of those calls; truncating
 *    would leave every row from before the resume pointing at nothing.
 *  - A failure is announced. Live text may die in silence because a reader who
 *    loses the thread loses only the wait. Here a lost record breaks the
 *    one-row-one-file invariant — the row still offers a download that can no
 *    longer be served — so the operator gets one loud line saying why, even
 *    though the run itself carries on: this is transport, and transport must
 *    never fail a run that is otherwise producing real work.
 *
 * Every write is DEADLINE-BOUNDED through the shared helper. These files live on
 * the same wedge-prone shared mounts as the checkpoints, and a write that blocks
 * in the kernel forever would hold the flush chain — and therefore close() —
 * open for the rest of the job. A bounded write fails loudly instead.
 */
import { appendFile } from "node:fs/promises";

import type { PromptRecord } from "@brainstorm-agentic/core";

import { DEFAULT_FS_DEADLINE_MS, withFsDeadline } from "./fs-stores.js";

/**
 * Where a hand-off's prompt record goes. Shaped exactly like
 * AgentExecutionContext.reportPrompt so the wiring can hand this straight to an
 * executor without an adapter in between.
 */
export type PromptSink = (record: PromptRecord) => void;

/**
 * How often accumulated records are written. Matches the live-text cadence for
 * the same reason: the reader's own poll is about a second, so writing sooner
 * buys nothing and costs a filesystem operation per record.
 */
const FLUSH_MS = 1_000;

export interface PromptLog {
  /** Records one hand-off to a model. */
  note(record: PromptRecord): void;
  /** Writes whatever is buffered and stops the timer. */
  close(): Promise<void>;
}

/** A log that discards everything, for hosts nobody can download a record from. */
export function noPromptCapture(): PromptLog {
  return { note: () => {}, close: () => Promise.resolve() };
}

export interface PromptLogOptions {
  /** Ceiling for one append, in ms. 0 disables the deadline. */
  readonly deadlineMs?: number;
  /** Test seam: the only filesystem operation this transport performs. */
  readonly append?: (path: string, data: string, encoding: "utf8") => Promise<void>;
}

export function createPromptLog(file: string, options: PromptLogOptions = {}): PromptLog {
  const deadlineMs = options.deadlineMs ?? DEFAULT_FS_DEADLINE_MS;
  const append = options.append ?? appendFile;
  let pending: PromptRecord[] = [];
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let failed = false;

  const flush = (): void => {
    if (failed || pending.length === 0) return;
    // One record per line holds however long a prompt is: JSON.stringify escapes
    // the newlines inside a section body, so a whole multi-turn transcript still
    // occupies exactly one line of the file.
    const lines = pending.map((record) => JSON.stringify(record));
    pending = [];
    chain = chain.then(async () => {
      try {
        await withFsDeadline(
          append(file, lines.join("\n") + "\n", "utf8"),
          deadlineMs,
          `appending to ${file}`,
        );
      } catch (error) {
        // One failure stops the writer for good rather than retrying into a
        // wall — but it says so, because from here on every model row offers a
        // download that cannot be served, and that looks like a bug in the row.
        failed = true;
        console.error(
          `[worker] prompt capture stopped (${file}): ${
            error instanceof Error ? error.message : String(error)
          } — model rows for the rest of this run will have no record to download`,
        );
      }
    });
  };

  const arm = (): void => {
    if (timer !== undefined || failed) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, FLUSH_MS);
    // Never hold the process open for a record nobody is waiting for.
    timer.unref();
  };

  return {
    note(record) {
      if (failed) return;
      pending.push(record);
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
