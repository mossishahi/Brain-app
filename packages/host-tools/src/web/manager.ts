/**
 * WebAccessManager: the ONE manager every web call in a run goes through.
 *
 * Whatever backend executes an agent — the Anthropic tool loop, the Claude
 * Agent SDK, the Cursor SDK — its web_search and web_fetch tools call this
 * object, so the whole pipeline's web traffic is:
 *
 * - ROUTED: each query kind (general / scholarly / news) has its own ordered
 *   provider chain; a failing provider fails over to the next, and the log
 *   names both the failure and who finally answered.
 * - PARALLEL, BOUNDED: any number of agents may search at once; a global
 *   semaphore caps simultaneous upstream calls, each provider has its own
 *   cap, and providers with politeness floors (arXiv, Semantic Scholar) are
 *   paced to them.
 * - COALESCED: identical questions in flight at the same moment share one
 *   upstream call; each caller still gets its own log row, naming the row it
 *   joined.
 * - CACHED (optional): answered keywords are re-served within a TTL; hits
 *   are logged as hits, so the record never loses a row to the cache.
 * - LOGGED, verbatim: every call writes one WebAccessLogRecord carrying the
 *   exact request and the exact payload the model received — character for
 *   character — plus provider, timing, and failure detail. The sink must
 *   never throw and never blocks a call.
 *
 * The manager carries NO model knowledge and no run state: it is
 * infrastructure the wiring builds once per worker process and hands to
 * every executor as the core WebAccess contract.
 */
import { randomUUID } from "node:crypto";

import type {
  JsonObject,
  WebAccess,
  WebAccessCallContext,
  WebAccessLogRecord,
  WebAccessLogSink,
  WebFetchAnswer,
  WebFetchQuery,
  WebSearchAnswer,
  WebSearchHit,
  WebSearchKind,
  WebSearchQuery,
} from "@brainstorm-agentic/core";
import { WEB_SEARCH_KINDS } from "@brainstorm-agentic/core";

import { performWebFetch, type WebFetchOptions } from "../web-search.js";
import type { WebSearchCache } from "./cache.js";
import {
  ProviderRequestError,
  type ProviderAnswer,
  type WebSearchProvider,
} from "./providers.js";

/** A search that could not be answered; `message` is what the model hears. */
export class WebAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAccessError";
  }
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;
/** Bounded backoff for one retry of a retryable provider failure. */
const RETRY_BASE_DELAY_MS = 750;
const MAX_RETRY_AFTER_MS = 15_000;

/** Plain counting semaphore; FIFO so no caller starves. */
class Semaphore {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.inFlight += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

/** Serializes calls to one provider and enforces its politeness floor. */
class ProviderGate {
  private readonly semaphore: Semaphore;
  private pacer: Promise<void> = Promise.resolve();

  constructor(
    concurrency: number,
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number,
  ) {
    this.semaphore = new Semaphore(concurrency);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.semaphore.acquire();
    try {
      if (this.minIntervalMs > 0) {
        // Chain a pacing slot: each caller waits for the previous caller's
        // interval to elapse before dispatching, so bursts spread out to the
        // provider's floor without blocking unrelated providers.
        let openSlot!: () => void;
        const slot = new Promise<void>((resolve) => {
          openSlot = resolve;
        });
        const gate = this.pacer;
        this.pacer = this.pacer.then(() => slot);
        await gate;
        const started = this.now();
        try {
          return await work();
        } finally {
          const elapsed = this.now() - started;
          const wait = Math.max(0, this.minIntervalMs - elapsed);
          if (wait > 0) void this.sleep(wait).then(openSlot);
          else openSlot();
        }
      }
      return await work();
    } finally {
      release();
    }
  }
}

export interface WebAccessManagerOptions {
  /** Every provider the deployment configured, by construction. */
  readonly providers: readonly WebSearchProvider[];
  /**
   * Ordered provider ids per kind. A kind with no chain (or an empty one)
   * answers with an explicit configuration error rather than guessing.
   */
  readonly chains: Partial<Record<WebSearchKind, readonly string[]>>;
  /** Where every call's record goes. Must never throw. */
  readonly log?: WebAccessLogSink;
  /** Simultaneous upstream calls across all providers. Default 8. */
  readonly maxConcurrent?: number;
  /** Simultaneous calls to ONE provider. Default 4. */
  readonly maxPerProvider?: number;
  /** Optional keyword cache; absent = every search goes upstream. */
  readonly cache?: WebSearchCache;
  /** Options for the wrapped hardened fetch (proxy/test seams). */
  readonly fetchOptions?: WebFetchOptions;
  /** Test seams. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The stable cache/coalescing key for one normalized search question. */
export function searchCacheKey(query: {
  readonly kind: WebSearchKind;
  readonly query: string;
  readonly maxResults: number;
  readonly recency?: string;
  readonly domains?: readonly string[];
}): string {
  const domains = [...(query.domains ?? [])].map((domain) => domain.toLowerCase()).sort();
  return JSON.stringify([
    query.kind,
    query.query.replace(/\s+/g, " ").trim().toLowerCase(),
    query.maxResults,
    query.recency ?? "",
    domains,
  ]);
}

/** URL normalized for result dedupe: case-folded host, no hash, no tracking. */
function dedupeKey(hit: WebSearchHit): string {
  if (hit.doi !== undefined) return `doi:${hit.doi.toLowerCase()}`;
  try {
    const url = new URL(hit.url);
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (name.startsWith("utm_")) url.searchParams.delete(name);
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/+$/, "");
  } catch {
    return hit.url;
  }
}

export class WebAccessManager implements WebAccess {
  private readonly providersById: ReadonlyMap<string, WebSearchProvider>;
  private readonly chains: Partial<Record<WebSearchKind, readonly string[]>>;
  private readonly log: WebAccessLogSink;
  private readonly global: Semaphore;
  private readonly gates: ReadonlyMap<string, ProviderGate>;
  private readonly cache: WebSearchCache | undefined;
  private readonly fetchOptions: WebFetchOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Identical in-flight questions share one upstream call. */
  private readonly inFlight = new Map<
    string,
    { readonly recordId: string; readonly promise: Promise<WebSearchAnswer> }
  >();
  private sequence = 0;
  private readonly instance = randomUUID().slice(0, 8);

  constructor(options: WebAccessManagerOptions) {
    this.providersById = new Map(options.providers.map((provider) => [provider.id, provider]));
    for (const [kind, chain] of Object.entries(options.chains)) {
      for (const id of chain ?? []) {
        if (!this.providersById.has(id)) {
          throw new Error(`web search chain for "${kind}" names unknown provider "${id}"`);
        }
      }
    }
    this.chains = options.chains;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.global = new Semaphore(options.maxConcurrent ?? 8);
    this.gates = new Map(
      options.providers.map((provider) => [
        provider.id,
        new ProviderGate(
          options.maxPerProvider ?? 4,
          provider.minIntervalMs ?? 0,
          this.sleep,
          this.now,
        ),
      ]),
    );
    this.cache = options.cache;
    this.fetchOptions = options.fetchOptions ?? {};
  }

  backedKinds(): readonly WebSearchKind[] {
    return WEB_SEARCH_KINDS.filter((kind) => (this.chains[kind]?.length ?? 0) > 0);
  }

  private nextRecordId(): string {
    this.sequence += 1;
    return `web-${this.instance}-${this.sequence}`;
  }

  private emit(record: WebAccessLogRecord): void {
    try {
      this.log(record);
    } catch {
      // The log is observability; a failing sink must never fail a call.
    }
  }

  async search(
    query: WebSearchQuery,
    context: WebAccessCallContext = {},
  ): Promise<WebSearchAnswer> {
    const startedAt = this.now();
    const recordId = this.nextRecordId();
    const kind: WebSearchKind =
      query.kind !== undefined && (WEB_SEARCH_KINDS as readonly string[]).includes(query.kind)
        ? query.kind
        : "general";
    const maxResults = Math.min(
      MAX_MAX_RESULTS,
      Math.max(1, Math.trunc(query.maxResults ?? DEFAULT_MAX_RESULTS)),
    );
    const requestVerbatim: JsonObject = {
      query: query.query,
      kind,
      maxResults,
      ...(query.recency !== undefined ? { recency: query.recency } : {}),
      ...(query.domains !== undefined ? { domains: [...query.domains] } : {}),
    };
    const attribution = {
      ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(context.nodePath !== undefined ? { nodePath: context.nodePath } : {}),
    };
    const finishError = (message: string): never => {
      this.emit({
        id: recordId,
        at: startedAt,
        tool: "web_search",
        outcome: "error",
        request: requestVerbatim,
        error: message,
        elapsedMs: this.now() - startedAt,
        ...attribution,
      });
      throw new WebAccessError(message);
    };

    if (typeof query.query !== "string" || query.query.trim() === "") {
      return finishError("query must be a non-empty string.");
    }
    const chain = this.chains[kind] ?? [];
    if (chain.length === 0) {
      const backed = this.backedKinds();
      return finishError(
        `no ${kind} search provider is configured on this deployment` +
          (backed.length > 0
            ? ` — retry with kind set to one of: ${backed.join(", ")}, or configure a ${kind} provider in Settings.`
            : " — configure a search provider in Settings."),
      );
    }

    const key = searchCacheKey({
      kind,
      query: query.query,
      maxResults,
      ...(query.recency !== undefined ? { recency: query.recency } : {}),
      ...(query.domains !== undefined ? { domains: query.domains } : {}),
    });

    // Cache first: a hit costs no slot and no network, and still logs.
    if (this.cache) {
      let cached: WebSearchAnswer | undefined;
      try {
        cached = await this.cache.get(key);
      } catch {
        cached = undefined; // an unreadable cache is a miss, never an error
      }
      if (cached !== undefined) {
        const answer: WebSearchAnswer = { ...cached, cached: true };
        this.emit({
          id: recordId,
          at: startedAt,
          tool: "web_search",
          outcome: "cached",
          request: requestVerbatim,
          response: answer as unknown as JsonObject,
          provider: answer.provider,
          elapsedMs: this.now() - startedAt,
          cacheKey: key,
          ...attribution,
        });
        return answer;
      }
    }

    // Coalesce identical questions already in flight: one upstream call,
    // one row per caller, the joiner's row naming the row it joined.
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      try {
        const answer = await running.promise;
        this.emit({
          id: recordId,
          at: startedAt,
          tool: "web_search",
          outcome: "coalesced",
          request: requestVerbatim,
          response: answer as unknown as JsonObject,
          provider: answer.provider,
          elapsedMs: this.now() - startedAt,
          coalescedWith: running.recordId,
          cacheKey: key,
          ...attribution,
        });
        return answer;
      } catch (error) {
        return finishError(error instanceof Error ? error.message : String(error));
      }
    }

    const attempt = this.searchUpstream({
      chain,
      kind,
      query: query.query,
      maxResults,
      recency: query.recency,
      domains: query.domains,
      signal: context.signal,
      recordId,
      startedAt,
      requestVerbatim,
      attribution,
      cacheKey: key,
    });
    this.inFlight.set(key, { recordId, promise: attempt });
    try {
      return await attempt;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async searchUpstream(input: {
    readonly chain: readonly string[];
    readonly kind: WebSearchKind;
    readonly query: string;
    readonly maxResults: number;
    readonly recency?: "day" | "week" | "month" | "year";
    readonly domains?: readonly string[];
    readonly signal?: AbortSignal;
    readonly recordId: string;
    readonly startedAt: number;
    readonly requestVerbatim: JsonObject;
    readonly attribution: Partial<WebAccessLogRecord>;
    readonly cacheKey: string;
  }): Promise<WebSearchAnswer> {
    const failures: { provider: string; error: string }[] = [];
    for (const providerId of input.chain) {
      const provider = this.providersById.get(providerId)!;
      const gate = this.gates.get(providerId)!;
      let answer: ProviderAnswer | undefined;
      // One bounded retry for retryable upstream failures (429, 5xx,
      // network); anything else moves straight to the next provider.
      for (let attempt = 0; attempt < 2 && answer === undefined; attempt += 1) {
        const releaseGlobal = await this.global.acquire();
        try {
          answer = await gate.run(() =>
            provider.search({
              query: input.query,
              kind: input.kind,
              maxResults: input.maxResults,
              ...(input.recency !== undefined ? { recency: input.recency } : {}),
              ...(input.domains !== undefined ? { domains: input.domains } : {}),
              ...(input.signal !== undefined ? { signal: input.signal } : {}),
            }),
          );
        } catch (error) {
          if (input.signal?.aborted) throw error;
          const retryable = error instanceof ProviderRequestError && error.retryable;
          const message = error instanceof Error ? error.message : String(error);
          if (retryable && attempt === 0) {
            const declared =
              error instanceof ProviderRequestError && error.retryAfterSeconds !== undefined
                ? error.retryAfterSeconds * 1000
                : undefined;
            await this.sleep(Math.min(declared ?? RETRY_BASE_DELAY_MS, MAX_RETRY_AFTER_MS));
            continue;
          }
          failures.push({ provider: providerId, error: message });
          break;
        } finally {
          releaseGlobal();
        }
      }
      if (answer === undefined) continue;

      // Dedupe (by DOI, then normalized URL) and clamp, preserving order.
      const seen = new Set<string>();
      const results: WebSearchHit[] = [];
      for (const hit of answer.hits) {
        const key = dedupeKey(hit);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(hit);
        if (results.length >= input.maxResults) break;
      }
      const delivered: WebSearchAnswer = {
        query: input.query,
        kind: input.kind,
        provider: providerId,
        results,
        ...(answer.total !== undefined ? { total: answer.total } : {}),
        // A metasearch answer names the engines that failed inside it, so a
        // CAPTCHA-blocked engine is a recorded cause, never thinner results.
        ...(answer.engineFailures !== undefined && answer.engineFailures.length > 0
          ? { engineFailures: answer.engineFailures }
          : {}),
      };
      if (this.cache) {
        try {
          await this.cache.put(input.cacheKey, delivered);
        } catch {
          // A cache that cannot store loses nothing but the reuse.
        }
      }
      this.emit({
        id: input.recordId,
        at: input.startedAt,
        tool: "web_search",
        outcome: "ok",
        request: input.requestVerbatim,
        response: delivered as unknown as JsonObject,
        provider: providerId,
        ...(failures.length > 0 ? { failedProviders: [...failures] } : {}),
        elapsedMs: this.now() - input.startedAt,
        cacheKey: input.cacheKey,
        ...input.attribution,
      });
      return delivered;
    }

    const summary =
      failures.length > 0
        ? failures.map((failure) => `${failure.provider}: ${failure.error}`).join("; ")
        : "no provider answered";
    this.emit({
      id: input.recordId,
      at: input.startedAt,
      tool: "web_search",
      outcome: "error",
      request: input.requestVerbatim,
      ...(failures.length > 0 ? { failedProviders: [...failures] } : {}),
      error: summary,
      elapsedMs: this.now() - input.startedAt,
      cacheKey: input.cacheKey,
      ...input.attribution,
    });
    throw new WebAccessError(`web search failed — ${summary}`);
  }

  async fetch(
    query: WebFetchQuery,
    context: WebAccessCallContext = {},
  ): Promise<WebFetchAnswer> {
    const startedAt = this.now();
    const recordId = this.nextRecordId();
    const requestVerbatim: JsonObject = {
      url: query.url,
      ...(query.maxChars !== undefined ? { maxChars: query.maxChars } : {}),
    };
    const attribution = {
      ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(context.nodePath !== undefined ? { nodePath: context.nodePath } : {}),
    };
    const releaseGlobal = await this.global.acquire();
    try {
      const outcome = await performWebFetch(
        {
          url: query.url,
          ...(query.maxChars !== undefined ? { maxChars: query.maxChars } : {}),
        },
        this.fetchOptions,
        context.signal,
      );
      if ("refusal" in outcome) {
        this.emit({
          id: recordId,
          at: startedAt,
          tool: "web_fetch",
          outcome: "error",
          request: requestVerbatim,
          // The refusal IS what the model hears back; carry it verbatim.
          response: outcome.refusal,
          error: outcome.refusal,
          elapsedMs: this.now() - startedAt,
          ...attribution,
        });
        throw new WebAccessError(outcome.refusal);
      }
      this.emit({
        id: recordId,
        at: startedAt,
        tool: "web_fetch",
        outcome: "ok",
        request: requestVerbatim,
        response: outcome.ok as unknown as JsonObject,
        elapsedMs: this.now() - startedAt,
        ...attribution,
      });
      return outcome.ok;
    } catch (error) {
      if (error instanceof WebAccessError) throw error;
      // External cancellation propagates after its row is written.
      this.emit({
        id: recordId,
        at: startedAt,
        tool: "web_fetch",
        outcome: "error",
        request: requestVerbatim,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: this.now() - startedAt,
        ...attribution,
      });
      throw error;
    } finally {
      releaseGlobal();
    }
  }
}
