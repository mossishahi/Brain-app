/**
 * Search-result cache behind the WebAccessManager.
 *
 * The cache is keyed on the NORMALIZED question (kind + query + bounds), so
 * the same keyword asked by two seats — or two runs — costs one upstream
 * call. It is deliberately an interface with two small implementations:
 *
 * - MemoryWebSearchCache: per-process, always safe, capped.
 * - FsWebSearchCache: one JSON file per key under a workspace directory, so
 *   a keyword's answer survives the worker process and is shared by every
 *   run on the deployment.
 *
 * Cache hits are still LOGGED by the manager (outcome "cached"), so the
 * unified search table never loses a row to the cache. Entries expire by
 * TTL; a stale or unreadable entry reads as a miss, never as an error.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { WebSearchAnswer } from "@brainstorm-agentic/core";

export interface WebSearchCache {
  get(key: string): Promise<WebSearchAnswer | undefined>;
  put(key: string, answer: WebSearchAnswer): Promise<void>;
}

interface CacheEntry {
  readonly storedAt: number;
  readonly answer: WebSearchAnswer;
}

export class MemoryWebSearchCache implements WebSearchCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(key: string): Promise<WebSearchAnswer | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency so the eviction below drops the coldest key.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.answer);
  }

  async put(key: string, answer: WebSearchAnswer): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      const coldest = this.entries.keys().next();
      if (!coldest.done) this.entries.delete(coldest.value);
    }
    this.entries.set(key, { storedAt: this.now(), answer: structuredClone(answer) });
  }
}

/**
 * Disk-backed cache: `<dir>/<sha256(key)>.json`, atomic writes, TTL on read.
 * Failures degrade to a miss (get) or are swallowed (put) — the cache is an
 * optimization and must never fail a search that could have gone upstream.
 */
export class FsWebSearchCache implements WebSearchCache {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  async get(key: string): Promise<WebSearchAnswer | undefined> {
    const path = this.pathFor(key);
    let entry: CacheEntry;
    try {
      entry = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
    } catch {
      return undefined;
    }
    if (
      typeof entry?.storedAt !== "number" ||
      entry.answer === undefined ||
      this.now() - entry.storedAt > this.ttlMs
    ) {
      void unlink(path).catch(() => undefined);
      return undefined;
    }
    return entry.answer;
  }

  async put(key: string, answer: WebSearchAnswer): Promise<void> {
    const path = this.pathFor(key);
    const staging = `${path}.tmp-${process.pid}`;
    try {
      await writeFile(
        staging,
        `${JSON.stringify({ storedAt: this.now(), answer } satisfies CacheEntry)}\n`,
        "utf8",
      );
      await rename(staging, path);
    } catch {
      void unlink(staging).catch(() => undefined);
    }
  }
}

/** Memory in front of disk: hot keys never touch the filesystem twice. */
export class LayeredWebSearchCache implements WebSearchCache {
  constructor(
    private readonly front: WebSearchCache,
    private readonly back: WebSearchCache,
  ) {}

  async get(key: string): Promise<WebSearchAnswer | undefined> {
    const hot = await this.front.get(key);
    if (hot !== undefined) return hot;
    const cold = await this.back.get(key);
    if (cold !== undefined) await this.front.put(key, cold);
    return cold;
  }

  async put(key: string, answer: WebSearchAnswer): Promise<void> {
    await Promise.all([this.front.put(key, answer), this.back.put(key, answer)]);
  }
}
