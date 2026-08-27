/**
 * The transport for the run's UNIFIED WEB LOG: one JSON record per
 * web_search/web_fetch call, written by the WebAccessManager — the verbatim
 * request, the verbatim payload the model received, the provider that
 * answered, and the operational facts around it (timing, failovers, cache
 * and coalescing outcomes). `searches.jsonl` is the raw material of the
 * cross-run search table: every row already carries its task, agent, and
 * node-path attribution.
 *
 * Same transport discipline as the prompt log (see prompt-capture.ts), for
 * the same reasons:
 * - one append-only file per run, batched on a timer, deadline-bounded;
 * - a fresh worker APPENDS (a resume replays finished tasks from the journal
 *   rather than re-searching, so earlier records are the only copy);
 * - a failure is announced once and never fails the run — the log is
 *   observability, and a run producing real work must not die for it.
 */
import { appendFile } from "node:fs/promises";

import type { WebAccessLogRecord } from "@brainstorm-agentic/core";

import { DEFAULT_FS_DEADLINE_MS, withFsDeadline } from "./fs-stores.js";

/** Shaped exactly like WebAccessLogSink so wiring hands it straight over. */
export type SearchLogSink = (record: WebAccessLogRecord) => void;

/** Matches the live-text/prompt cadence; sooner buys nothing. */
const FLUSH_MS = 1_000;

export interface SearchLog {
  /** Records one web call. Never throws. */
  note(record: WebAccessLogRecord): void;
  /** Writes whatever is buffered and stops the timer. */
  close(): Promise<void>;
}

/** A log that discards everything, for hosts with nowhere to write. */
export function noSearchLog(): SearchLog {
  return { note: () => {}, close: () => Promise.resolve() };
}

export interface SearchLogOptions {
  /** Ceiling for one append, in ms. 0 disables the deadline. */
  readonly deadlineMs?: number;
  /** Test seam: the only filesystem operation this transport performs. */
  readonly append?: (path: string, data: string, encoding: "utf8") => Promise<void>;
}

export function createSearchLog(file: string, options: SearchLogOptions = {}): SearchLog {
  const deadlineMs = options.deadlineMs ?? DEFAULT_FS_DEADLINE_MS;
  const append = options.append ?? appendFile;
  let pending: WebAccessLogRecord[] = [];
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let failed = false;

  const flush = (): void => {
    if (failed || pending.length === 0) return;
    // One record per line however large the payload: JSON.stringify escapes
    // every newline inside a fetched page, so a whole article is one line.
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
        failed = true;
        console.error(
          `[worker] search log stopped (${file}): ${
            error instanceof Error ? error.message : String(error)
          } — web calls for the rest of this run will not be recorded`,
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
