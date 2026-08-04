/**
 * Stamped file caches for the dashboard's read path.
 *
 * The job detail is rebuilt from workspace files on every request and on
 * every SSE tick; on an HPC deployment those files live on a network
 * filesystem and grow to many megabytes during a run (the checkpoint's
 * journal, the event log, dozens of artifact payloads). Re-reading and
 * re-parsing them per call saturates the event loop and every other request
 * — including the webapp's static assets — queues behind it.
 *
 * Every cache here is keyed by a cheap stat stamp (`mtimeMs:size`), so an
 * unchanged file costs one stat instead of a read+parse, and a changed file
 * is re-read exactly once across all concurrent consumers. The event log is
 * additionally read INCREMENTALLY: it is append-only JSONL, so only the
 * bytes past the last consumed offset are read and parsed.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

import { readJsonFile } from "./files.js";

/** `mtimeMs:size` of a path, or undefined when it does not exist. */
export function statStamp(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return undefined;
  }
}

interface JsonEntry {
  stamp: string;
  value: unknown;
}

/**
 * Bounded insertion-order eviction: plenty for one server (a handful of
 * live jobs × their checkpoint/index/pin files + artifact payloads).
 */
const MAX_JSON_ENTRIES = 2048;
const jsonCache = new Map<string, JsonEntry>();

/**
 * Read + parse one JSON file, cached by stat stamp. Artifact payloads are
 * immutable once written, and rewritten files (checkpoint.json, job.json,
 * settings.json — all atomic temp+rename writes) change their stamp, so
 * staleness is structurally impossible short of a same-millisecond,
 * same-size in-place overwrite, which the atomic-write discipline rules
 * out.
 */
export function readJsonCached<T>(path: string): T | undefined {
  const stamp = statStamp(path);
  if (stamp === undefined) {
    jsonCache.delete(path);
    return undefined;
  }
  const cached = jsonCache.get(path);
  if (cached && cached.stamp === stamp) {
    // Refresh insertion order so hot entries survive eviction.
    jsonCache.delete(path);
    jsonCache.set(path, cached);
    return cached.value as T;
  }
  let value: T | undefined;
  try {
    value = readJsonFile<T>(path);
  } catch {
    value = undefined;
  }
  if (value === undefined) {
    jsonCache.delete(path);
    return undefined;
  }
  jsonCache.set(path, { stamp, value });
  if (jsonCache.size > MAX_JSON_ENTRIES) {
    const oldest = jsonCache.keys().next().value;
    if (oldest !== undefined) jsonCache.delete(oldest);
  }
  return value;
}

interface JsonlEntry {
  /** Bytes consumed so far (always ends on a line boundary). */
  offset: number;
  /** Size observed at the last read, to skip work when unchanged. */
  size: number;
  items: unknown[];
}

const jsonlCache = new Map<string, JsonlEntry>();
const MAX_JSONL_ENTRIES = 64;

function parseLines(text: string, into: unknown[]): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      into.push(JSON.parse(line));
    } catch {
      // A malformed line (interrupted writer) is skipped, like before.
    }
  }
}

/**
 * Read an append-only JSONL file incrementally: parsed entries are cached
 * and only the appended tail is read on growth. A shrink (rotation, manual
 * truncation) resets and re-reads from the start. The final PARTIAL line —
 * a writer mid-append — is left unconsumed until its newline lands.
 */
export function readJsonlCached(path: string): readonly unknown[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    jsonlCache.delete(path);
    return [];
  }
  let entry = jsonlCache.get(path);
  if (entry && size < entry.offset) entry = undefined; // truncated/rotated
  if (entry && size === entry.size) return entry.items;
  if (!entry) {
    entry = { offset: 0, size: 0, items: [] };
    jsonlCache.set(path, entry);
    if (jsonlCache.size > MAX_JSONL_ENTRIES) {
      const oldest = jsonlCache.keys().next().value;
      if (oldest !== undefined && oldest !== path) jsonlCache.delete(oldest);
    }
  }
  if (size > entry.offset) {
    try {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(size - entry.offset);
        const read = readSync(fd, buffer, 0, buffer.length, entry.offset);
        const text = buffer.subarray(0, read).toString("utf8");
        // Consume only complete lines; keep a trailing partial for later.
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline >= 0) {
          parseLines(text.slice(0, lastNewline + 1), entry.items);
          entry.offset += Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // Unreadable tail: serve what is parsed; retried on the next call.
    }
  }
  entry.size = size;
  return entry.items;
}
