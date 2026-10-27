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
 * - COORDINATED across the run's agents: every search of every agent passes
 *   one run-wide slot pool served round-robin per agent; SearXNG never fans
 *   out (the engine pool names one or two engines per call, each under its
 *   own rate limit, daily cap and cool-down); metered providers spend from a
 *   per-run budget; and a launch check marks each source available, needing
 *   a key, blocked or unreachable, so a dead source is skipped rather than
 *   retried by every agent in turn.
 * - ROUTED BY QUESTION: web, news, a known paper by title, papers on a topic,
 *   and details by identifier each have their own provider list; paper
 *   routes apply every filter an index supports at the source, enforce the
 *   rest on the records, and say which filters held where.
 * - TERMS-AWARE: a provider whose terms forbid keeping results (Brave) is
 *   cached in memory for this run only and logged as a count plus one
 *   SHA-256 per URL instead of verbatim.
 *
 * The manager carries NO model knowledge: it is infrastructure the wiring
 * builds once per worker process and hands to every executor as the core
 * WebAccess contract.
 */
import { randomUUID } from "node:crypto";

import type {
  JsonObject,
  JsonValue,
  PaperDetailPart,
  PaperDetailsAnswer,
  PaperDetailsEntry,
  PaperDetailsQuery,
  PaperRecord,
  PaperSearchAnswer,
  PaperSearchQuery,
  WebAccess,
  WebAccessCallContext,
  WebAccessLogRecord,
  WebAccessLogSink,
  WebFetchAnswer,
  WebFetchQuery,
  WebSearchAnswer,
  WebSearchEngineFailure,
  WebSearchHit,
  WebSearchKind,
  WebSearchQuery,
  WebSearchRoute,
  WebSourceStatus,
} from "@brainstorm-agentic/core";
import { PAPER_DETAIL_PARTS, WEB_SEARCH_KINDS } from "@brainstorm-agentic/core";

import { performWebFetch, type WebFetchOptions } from "../web-search.js";
import { MemoryCache, MemoryWebSearchCache, type WebSearchCache } from "./cache.js";
import { DEFAULT_ENGINE_CANARIES, EnginePool, type EngineRoute } from "./engines.js";
import {
  hasStructuredOptions,
  mergePaperLists,
  normalizePaperQuery,
  recordFromHit,
  redactedWebAnswer,
  redactPapers,
  requestedOptions,
  type NormalizedPaperRequest,
} from "./papers.js";
import { ProviderRequestError, type WebSearchProvider } from "./providers.js";
import type { ProbeLogLine, WebSourceStatusWithLog } from "./probe.js";
import { FairGate } from "./scheduler.js";
import {
  enforceOnRecords,
  parsePaperIdentifier,
  titleMatches,
  type NormalizedPaperQuery,
  type PaperBackend,
  type PaperIdentifier,
  type PaperOption,
} from "./scholarly.js";

/** A search that could not be answered; `message` is what the model hears. */
export class WebAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAccessError";
  }
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 20;
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
  /**
   * Provider (and paper-index) ids per ROUTE, in order. A route without a
   * list falls back to its kind's chain (web: general, news: news) or, for
   * the paper routes, to the defaults. Paper routes may also name
   * "searxng:science" (SearXNG's arXiv and EuropePMC engines).
   */
  readonly routes?: Partial<Record<WebSearchRoute, readonly string[]>>;
  /** Scholarly indexes behind paper_search and paper_details. */
  readonly paperBackends?: readonly PaperBackend[];
  /** SearXNG engine scheduling; absent = SearXNG picks its engines itself. */
  readonly engines?: EnginePool;
  /** Requests a metered provider may make in this run, by provider id. */
  readonly budgets?: Readonly<Record<string, number>>;
  /** Requests already spent in this run (a resumed run's earlier calls). */
  readonly spent?: Readonly<Record<string, number>>;
  /**
   * Called once per billed request of a paid provider — every answered
   * request, empty or not (the host's local usage ledger).
   */
  readonly onSpend?: (providerId: string) => void;
  /** Per-route caches, each with its own lifetime; absent = `cache`. */
  readonly routeCaches?: Partial<Record<WebSearchRoute, WebSearchCache>>;
  readonly paperCache?: WebSearchCache<PaperSearchAnswer>;
  readonly detailsCache?: WebSearchCache<PaperDetailsAnswer>;
  /** Searches one task may make (a runaway guard); absent = unlimited. */
  readonly maxSearchesPerTask?: number;
  /**
   * Source statuses known before this run (the server's availability table).
   * They apply from construction; a seeded available/degraded status younger
   * than ten minutes makes `startChecks` skip that source's probe. Statuses
   * of sources this manager does not configure are ignored.
   */
  readonly seededStatuses?: readonly WebSourceStatus[];
  /**
   * Fired on every status change: launch-check outcomes, a live 429/503
   * demotion, a block after three in a row, and a recovery. Must not throw.
   */
  readonly onStatusChange?: (status: WebSourceStatus) => void;
  /**
   * The derived effective order per route (the availability service's
   * table). A route named here replaces its `routes` list; the others keep
   * the configured lists.
   */
  readonly routeOrders?: Partial<Record<WebSearchRoute, readonly string[]>>;
}

/** The stable cache/coalescing key for one normalized search question. */
export function searchCacheKey(query: {
  readonly kind: WebSearchKind;
  readonly query: string;
  readonly maxResults: number;
  readonly recency?: string;
  readonly domains?: readonly string[];
  readonly page?: number;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly excludeDomains?: readonly string[];
  readonly language?: string;
  readonly country?: string;
  readonly fileType?: string;
}): string {
  const domains = [...(query.domains ?? [])].map((domain) => domain.toLowerCase()).sort();
  const base = [
    query.kind,
    query.query.replace(/\s+/g, " ").trim().toLowerCase(),
    query.maxResults,
    query.recency ?? "",
    domains,
  ];
  // Options added later ride a trailing object only when set, so the key
  // of a plain question is unchanged (existing disk-cache entries still hit).
  const extra: Record<string, unknown> = {
    ...(query.page !== undefined && query.page > 1 ? { page: query.page } : {}),
    ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
    ...(query.dateTo !== undefined ? { dateTo: query.dateTo } : {}),
    ...(query.excludeDomains !== undefined && query.excludeDomains.length > 0
      ? { excludeDomains: [...query.excludeDomains].map((domain) => domain.toLowerCase()).sort() }
      : {}),
    ...(query.language !== undefined ? { language: query.language.toLowerCase() } : {}),
    ...(query.country !== undefined ? { country: query.country.toUpperCase() } : {}),
    ...(query.fileType !== undefined ? { fileType: query.fileType.toLowerCase() } : {}),
  };
  return JSON.stringify(Object.keys(extra).length > 0 ? [...base, extra] : base);
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

/** Default provider lists for the paper routes (the "SearXNG first" preset). */
export const DEFAULT_PAPER_ROUTES: Readonly<Record<"paper-lookup" | "paper-topic" | "paper-details", readonly string[]>> = {
  "paper-lookup": ["searxng", "openalex", "crossref", "semantic-scholar", "arxiv", "brave"],
  "paper-topic": ["searxng", "openalex", "semantic-scholar", "searxng:science", "brave"],
  "paper-details": ["openalex", "crossref", "arxiv", "semantic-scholar"],
};

/** Which identifier kinds each index can resolve. */
const DETAIL_KINDS: Readonly<Record<string, ReadonlySet<PaperIdentifier["kind"]>>> = {
  openalex: new Set(["doi", "openalex", "pmid", "pmcid"]),
  crossref: new Set(["doi"]),
  arxiv: new Set(["arxiv"]),
  "semantic-scholar": new Set(["doi", "arxiv", "pmid", "pmcid", "s2", "corpus"]),
  opencitations: new Set(["doi"]),
};

/** Which detail parts each index can add. */
const DETAIL_PARTS: Readonly<Record<string, ReadonlySet<PaperDetailPart>>> = {
  openalex: new Set(["abstract", "references", "citations", "related"]),
  crossref: new Set(["abstract", "references"]),
  arxiv: new Set(["abstract"]),
  "semantic-scholar": new Set(["abstract", "references", "citations", "related"]),
  opencitations: new Set(["references", "citations"]),
};

/** How long a source found unreachable or blocked at the check is skipped. */
const CHECK_COOLDOWN_MS = 10 * 60_000;
/** Live 429/503 answers in a row that turn a degraded source into a blocked one. */
const LIVE_BLOCK_STREAK = 3;

type PaperOutcome =
  | {
      readonly ok: true;
      readonly provider: string;
      readonly papers: readonly PaperRecord[];
      readonly total?: number;
      readonly applied: readonly PaperOption[];
      readonly unsupported: readonly { readonly option: PaperOption; readonly reason: string }[];
      readonly notes: readonly string[];
      readonly engineFailures?: readonly WebSearchEngineFailure[];
      readonly noStore: boolean;
    }
  | { readonly ok: false; readonly provider: string; readonly error: string };

function agentKeyOf(context: WebAccessCallContext): string {
  return context.agentId ?? context.taskId ?? "run";
}

function attributionOf(context: WebAccessCallContext): Partial<WebAccessLogRecord> {
  return {
    ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
    ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    ...(context.nodePath !== undefined ? { nodePath: context.nodePath } : {}),
  };
}

export class WebAccessManager implements WebAccess {
  private readonly providersById: ReadonlyMap<string, WebSearchProvider>;
  private readonly chains: Partial<Record<WebSearchKind, readonly string[]>>;
  private readonly routes: Partial<Record<WebSearchRoute, readonly string[]>>;
  private readonly log: WebAccessLogSink;
  /** The run-wide bound on upstream calls, served round-robin across agents. */
  private readonly global: FairGate;
  private readonly gates: ReadonlyMap<string, ProviderGate>;
  private readonly cache: WebSearchCache | undefined;
  private readonly routeCaches: Partial<Record<WebSearchRoute, WebSearchCache>>;
  /** Answers from providers whose terms forbid keeping results: this run only. */
  private readonly transient = new MemoryWebSearchCache(7 * 24 * 60 * 60_000);
  private readonly transientPapers = new MemoryCache<PaperSearchAnswer>(7 * 24 * 60 * 60_000);
  private readonly paperCache: WebSearchCache<PaperSearchAnswer> | undefined;
  private readonly detailsCache: WebSearchCache<PaperDetailsAnswer> | undefined;
  private readonly fetchOptions: WebFetchOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly engines: EnginePool | undefined;
  private readonly paperBackends: ReadonlyMap<string, PaperBackend>;
  private readonly budgets: Readonly<Record<string, number>>;
  private readonly spent = new Map<string, number>();
  private readonly onSpend: ((providerId: string) => void) | undefined;
  private readonly perTask = new Map<string, number>();
  private readonly maxSearchesPerTask: number | undefined;
  private readonly statuses = new Map<string, WebSourceStatus>();
  private checks: Promise<readonly WebSourceStatus[]> | undefined;
  private readonly onStatusChange: ((status: WebSourceStatus) => void) | undefined;
  /** Sources whose seeded status is fresh enough to stand in for the launch check. */
  private readonly seeded = new Set<string>();
  /** Consecutive live 429/503 answers per source (reset by an answer). */
  private readonly liveFailures = new Map<string, number>();
  /** Sources degraded by live traffic (as opposed to a probe): recover on the next answer. */
  private readonly liveDegraded = new Set<string>();
  /** The launch check's log lines per SearXNG engine (the engine pool keeps no log). */
  private readonly engineLogs = new Map<string, readonly ProbeLogLine[]>();
  /** Identical in-flight questions share one upstream call. */
  private readonly inFlight = new Map<
    string,
    { readonly recordId: string; readonly promise: Promise<WebSearchAnswer> }
  >();
  private readonly paperInFlight = new Map<
    string,
    { readonly recordId: string; readonly promise: Promise<PaperSearchAnswer> }
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
    this.routes = { ...(options.routes ?? {}) };
    for (const [route, order] of Object.entries(options.routeOrders ?? {}) as [WebSearchRoute, readonly string[] | undefined][]) {
      if (order !== undefined) this.routes[route] = order;
    }
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.onStatusChange = options.onStatusChange;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.global = new FairGate(options.maxConcurrent ?? 8);
    this.paperBackends = new Map((options.paperBackends ?? []).map((backend) => [backend.id, backend]));
    // One gate per upstream. A legacy scholarly provider and the paper index
    // of the same source call the same service, so they share ONE gate,
    // paced by the stricter of the two (fewest in flight, longest spacing).
    const pacing = new Map<string, { concurrency: number; intervalMs: number }>();
    const pace = (id: string, maxConcurrent: number | undefined, minIntervalMs: number | undefined): void => {
      const current = pacing.get(id);
      const concurrency = Math.max(1, Math.trunc(maxConcurrent ?? options.maxPerProvider ?? 4));
      pacing.set(id, {
        concurrency: Math.min(current?.concurrency ?? concurrency, concurrency),
        intervalMs: Math.max(current?.intervalMs ?? 0, minIntervalMs ?? 0),
      });
    };
    for (const provider of options.providers) pace(provider.id, provider.maxConcurrent, provider.minIntervalMs);
    for (const backend of this.paperBackends.values()) pace(backend.id, backend.maxConcurrent, backend.minIntervalMs);
    const gates = new Map<string, ProviderGate>();
    for (const [id, { concurrency, intervalMs }] of pacing) {
      gates.set(id, new ProviderGate(concurrency, intervalMs, this.sleep, this.now));
    }
    this.gates = gates;
    this.cache = options.cache;
    this.routeCaches = options.routeCaches ?? {};
    this.paperCache = options.paperCache;
    this.detailsCache = options.detailsCache;
    this.fetchOptions = options.fetchOptions ?? {};
    this.engines = options.engines;
    this.budgets = options.budgets ?? {};
    for (const [id, used] of Object.entries(options.spent ?? {})) this.spent.set(id, used);
    this.onSpend = options.onSpend;
    this.maxSearchesPerTask = options.maxSearchesPerTask;
    for (const status of options.seededStatuses ?? []) {
      if (!this.providersById.has(status.id) && !this.paperBackends.has(status.id)) continue;
      if (status.state === "unchecked") continue;
      const { engines, ...own } = status;
      if (status.id === "searxng" && engines !== undefined) this.engines?.seed(engines);
      this.statuses.set(status.id, own);
      const fresh = status.checkedAt !== undefined && this.now() - status.checkedAt < CHECK_COOLDOWN_MS;
      if (fresh && (status.state === "available" || status.state === "degraded")) this.seeded.add(status.id);
    }
  }

  backedKinds(): readonly WebSearchKind[] {
    // Only entries with something configured behind them count: a preset
    // route may name a source (the paid fallback) this deployment lacks.
    const backed = (entries: readonly string[] | undefined): boolean =>
      (entries ?? []).some((entry) => this.configured(entry));
    return WEB_SEARCH_KINDS.filter(
      (kind) =>
        backed(this.chains[kind]) ||
        (kind === "general" && backed(this.routes.web)) ||
        (kind === "news" && backed(this.routes.news)) ||
        (kind === "scholarly" && this.paperBackends.size > 0),
    );
  }

  /** Whether paper_search / paper_details have anything behind them. */
  backsPapers(): boolean {
    return this.paperBackends.size > 0;
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

  /** Records a source's status and tells the listener when it changed. */
  private setStatus(id: string, status: WebSourceStatusWithLog): void {
    const previous = this.statuses.get(id);
    this.statuses.set(id, status);
    if (
      previous !== undefined &&
      previous.state === status.state &&
      previous.detail === status.detail &&
      previous.until === status.until &&
      previous.checkedAt === status.checkedAt
    ) {
      return;
    }
    try {
      this.onStatusChange?.(status);
    } catch {
      // The listener is observability; it must never fail a call.
    }
  }

  /** A skip reason when the launch check (or live traffic) ruled a source out. */
  private skipReason(id: string): string | undefined {
    const status = this.statuses.get(id);
    if (status === undefined) return undefined;
    if (status.state === "needs-key" || status.state === "not-configured") {
      return status.detail ?? status.state;
    }
    if (status.state === "unreachable" || status.state === "blocked") {
      const until = status.until ?? (status.checkedAt ?? 0) + CHECK_COOLDOWN_MS;
      if (this.now() < until) return `${status.state} at the last check${status.detail ? ` (${status.detail})` : ""}`;
    }
    return undefined;
  }

  private markAnswered(id: string): void {
    this.liveFailures.delete(id);
    const status = this.statuses.get(id);
    if (status === undefined) return;
    if (status.state !== "available" && status.state !== "degraded") {
      this.setStatus(id, { ...status, state: "available", checkedAt: this.now() });
    } else if (status.state === "degraded" && this.liveDegraded.has(id)) {
      // Recovery from a live 429/503 demotion.
      this.liveDegraded.delete(id);
      const { until: _until, detail: _detail, ...rest } = status;
      this.setStatus(id, { ...rest, state: "available", detail: "recovered", checkedAt: this.now() });
    }
  }

  /**
   * A route's sources for a live call: sources demoted by live 429/503
   * answers go behind the rest for their cool-down, in their relative order.
   */
  private liveOrder(entries: readonly string[]): readonly string[] {
    const demoted = (id: string): boolean => {
      if (!this.liveDegraded.has(id)) return false;
      const status = this.statuses.get(id);
      return status?.state === "degraded" && this.now() < (status.until ?? 0);
    };
    if (!entries.some(demoted)) return entries;
    return [...entries.filter((id) => !demoted(id)), ...entries.filter(demoted)];
  }

  /** Counts one billed request and tells the usage ledger. */
  private noteSpend(providerId: string): void {
    this.spent.set(providerId, (this.spent.get(providerId) ?? 0) + 1);
    try {
      this.onSpend?.(providerId);
    } catch {
      // The ledger is bookkeeping; it must never fail a search.
    }
  }

  private budgetLeft(id: string): number | undefined {
    const budget = this.budgets[id];
    return budget === undefined ? undefined : budget - (this.spent.get(id) ?? 0);
  }

  /** Counts one search against its task; the refusal text when over the limit. */
  private overTaskLimit(context: WebAccessCallContext): string | undefined {
    if (this.maxSearchesPerTask === undefined || context.taskId === undefined) return undefined;
    const used = (this.perTask.get(context.taskId) ?? 0) + 1;
    this.perTask.set(context.taskId, used);
    return used > this.maxSearchesPerTask
      ? `this task has used its ${this.maxSearchesPerTask} searches; continue with what you have found.`
      : undefined;
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
    const route: WebSearchRoute = kind === "news" ? "news" : kind === "scholarly" ? "paper-topic" : "web";
    const tool: WebAccessLogRecord["tool"] = kind === "news" ? "news_search" : "web_search";
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
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo !== undefined ? { dateTo: query.dateTo } : {}),
      ...(query.excludeDomains !== undefined ? { excludeDomains: [...query.excludeDomains] } : {}),
      ...(query.language !== undefined ? { language: query.language } : {}),
      ...(query.country !== undefined ? { country: query.country } : {}),
      ...(query.fileType !== undefined ? { fileType: query.fileType } : {}),
    };
    const attribution = attributionOf(context);
    const finishError = (message: string): never => {
      this.emit({
        id: recordId,
        at: startedAt,
        tool,
        outcome: "error",
        request: requestVerbatim,
        error: message,
        elapsedMs: this.now() - startedAt,
        route,
        ...attribution,
      });
      throw new WebAccessError(message);
    };

    if (typeof query.query !== "string" || query.query.trim() === "") {
      return finishError("query must be a non-empty string.");
    }
    const chain =
      kind === "scholarly"
        ? this.chains.scholarly ?? []
        : this.routes[route] ?? this.chains[kind] ?? [];
    if (chain.length === 0) {
      const toolFor: Readonly<Record<WebSearchKind, string>> = {
        general: "web_search",
        news: "news_search",
        scholarly: "paper_search",
      };
      const alternatives = this.backedKinds()
        .filter((backed) => backed !== kind)
        .map((backed) => toolFor[backed]);
      return finishError(
        `${toolFor[kind]} has no source configured on this deployment` +
          (alternatives.length > 0
            ? ` — use ${alternatives.join(" or ")} instead, or configure a source in Settings.`
            : " — configure a search source in Settings."),
      );
    }
    const limited = this.overTaskLimit(context);
    if (limited !== undefined) return finishError(limited);

    const key = searchCacheKey({
      kind,
      query: query.query,
      maxResults,
      ...(query.recency !== undefined ? { recency: query.recency } : {}),
      ...(query.domains !== undefined ? { domains: query.domains } : {}),
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo !== undefined ? { dateTo: query.dateTo } : {}),
      ...(query.excludeDomains !== undefined ? { excludeDomains: query.excludeDomains } : {}),
      ...(query.language !== undefined ? { language: query.language } : {}),
      ...(query.country !== undefined ? { country: query.country } : {}),
      ...(query.fileType !== undefined ? { fileType: query.fileType } : {}),
    });

    // Cache first: a hit costs no slot and no network, and still logs. The
    // run's transient cache (providers whose terms forbid keeping results)
    // is consulted before the shared one.
    const shared = this.routeCaches[route] ?? this.cache;
    for (const cache of [this.transient as WebSearchCache, shared]) {
      if (cache === undefined) continue;
      let cached: WebSearchAnswer | undefined;
      try {
        cached = await cache.get(key);
      } catch {
        cached = undefined; // an unreadable cache is a miss, never an error
      }
      if (cached !== undefined) {
        const answer: WebSearchAnswer = { ...cached, cached: true };
        const noStore = this.providersById.get(answer.provider)?.noStore === true;
        this.emit({
          id: recordId,
          at: startedAt,
          tool,
          outcome: "cached",
          request: requestVerbatim,
          response: (noStore ? redactedWebAnswer(answer) : answer) as unknown as JsonObject,
          provider: answer.provider,
          elapsedMs: this.now() - startedAt,
          cacheKey: key,
          route,
          ...(noStore ? { redacted: true } : {}),
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
        const noStore = this.providersById.get(answer.provider)?.noStore === true;
        this.emit({
          id: recordId,
          at: startedAt,
          tool,
          outcome: "coalesced",
          request: requestVerbatim,
          response: (noStore ? redactedWebAnswer(answer) : answer) as unknown as JsonObject,
          provider: answer.provider,
          elapsedMs: this.now() - startedAt,
          coalescedWith: running.recordId,
          cacheKey: key,
          route,
          ...(noStore ? { redacted: true } : {}),
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
      route,
      tool,
      query: query.query,
      maxResults,
      options: query,
      signal: context.signal,
      agentKey: agentKeyOf(context),
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

  /**
   * One provider call on behalf of an agent: the run-wide fair slot, the
   * provider's own pacing gate, and one bounded retry for retryable failures
   * (429, 5xx, network). Resolves undefined (with the failure recorded) when
   * the provider could not answer.
   */
  private async callProvider<T>(
    providerId: string,
    agentKey: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
    failures: { provider: string; error: string }[],
  ): Promise<T | undefined> {
    const gate = this.gates.get(providerId)!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const releaseGlobal = await this.global.acquire(agentKey, signal);
      try {
        return await gate.run(work);
      } catch (error) {
        if (signal?.aborted) throw error;
        const retryable = error instanceof ProviderRequestError && error.retryable;
        const message = error instanceof Error ? error.message : String(error);
        if (retryable && attempt === 0) {
          const declared =
            error instanceof ProviderRequestError && error.retryAfterSeconds !== undefined
              ? error.retryAfterSeconds * 1000
              : undefined;
          releaseGlobal();
          await this.sleep(Math.min(declared ?? RETRY_BASE_DELAY_MS, MAX_RETRY_AFTER_MS));
          continue;
        }
        failures.push({ provider: providerId, error: message });
        this.noteFailure(providerId, message);
        return undefined;
      } finally {
        releaseGlobal();
      }
    }
    return undefined;
  }

  /**
   * A 429 or 503 that survived its retry demotes the source for every agent
   * of the run: degraded for ten minutes (tried after the sources that
   * answer), and after three in a row blocked — OpenAlex until its daily
   * budget resets (midnight UTC), anything else for ten minutes — instead of
   * each agent rediscovering the limit.
   */
  private noteFailure(providerId: string, message: string): void {
    const match = /HTTP (429|503)\b/.exec(message);
    if (match === null) return;
    const code = match[1]!;
    const now = this.now();
    const streak = (this.liveFailures.get(providerId) ?? 0) + 1;
    this.liveFailures.set(providerId, streak);
    const budget = providerId === "openalex" && code === "429";
    if (streak >= LIVE_BLOCK_STREAK) {
      const midnight = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1,
      );
      this.liveDegraded.delete(providerId);
      this.setStatus(providerId, {
        id: providerId,
        state: "blocked",
        detail: budget
          ? `daily budget used up (HTTP 429, ${streak} in a row); resets at midnight UTC`
          : `HTTP ${code} ${streak} times in a row`,
        checkedAt: now,
        until: budget ? midnight : now + CHECK_COOLDOWN_MS,
      });
      return;
    }
    this.liveDegraded.add(providerId);
    this.setStatus(providerId, {
      id: providerId,
      state: "degraded",
      detail: code === "429" ? "rate limit reached (HTTP 429)" : "temporarily unavailable (HTTP 503)",
      checkedAt: now,
      until: now + CHECK_COOLDOWN_MS,
    });
  }

  /** Engines for one metasearch call, or the reason there are none. */
  private async enginesFor(
    provider: WebSearchProvider,
    route: EngineRoute,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly engines?: readonly string[] } | { readonly unavailable: string }> {
    if (provider.metasearch !== true || this.engines === undefined || !this.engines.serves(route)) {
      return {};
    }
    const picked = await this.engines.acquire(route, signal);
    return "unavailable" in picked ? { unavailable: picked.unavailable } : { engines: picked.engines };
  }

  private async searchUpstream(input: {
    readonly chain: readonly string[];
    readonly kind: WebSearchKind;
    readonly route: WebSearchRoute;
    readonly tool: WebAccessLogRecord["tool"];
    readonly query: string;
    readonly maxResults: number;
    readonly options: WebSearchQuery;
    readonly signal?: AbortSignal;
    readonly agentKey: string;
    readonly recordId: string;
    readonly startedAt: number;
    readonly requestVerbatim: JsonObject;
    readonly attribution: Partial<WebAccessLogRecord>;
    readonly cacheKey: string;
  }): Promise<WebSearchAnswer> {
    const failures: { provider: string; error: string }[] = [];
    const chain = this.liveOrder(input.chain);
    for (const [position, providerId] of chain.entries()) {
      const provider = this.providersById.get(providerId);
      if (provider === undefined) {
        failures.push({ provider: providerId, error: "not configured on this deployment" });
        continue;
      }
      const last = position === chain.length - 1;
      const skip = this.skipReason(providerId);
      if (skip !== undefined) {
        failures.push({ provider: providerId, error: skip });
        continue;
      }
      const left = this.budgetLeft(providerId);
      if (left !== undefined && left <= 0) {
        failures.push({
          provider: providerId,
          error: `paid fallback budget used up (${this.budgets[providerId]} requests in this run)`,
        });
        continue;
      }
      const picked = await this.enginesFor(provider, input.route, input.signal);
      if ("unavailable" in picked) {
        failures.push({ provider: providerId, error: picked.unavailable });
        continue;
      }
      const engines = picked.engines;
      const options = input.options;
      const answer = await this.callProvider(
        providerId,
        input.agentKey,
        input.signal,
        () =>
          provider.search({
            query: input.query,
            kind: input.kind,
            maxResults: input.maxResults,
            route: input.route,
            ...(options.recency !== undefined ? { recency: options.recency } : {}),
            ...(options.domains !== undefined ? { domains: options.domains } : {}),
            ...(options.page !== undefined ? { page: options.page } : {}),
            ...(options.dateFrom !== undefined ? { dateFrom: options.dateFrom } : {}),
            ...(options.dateTo !== undefined ? { dateTo: options.dateTo } : {}),
            ...(options.excludeDomains !== undefined ? { excludeDomains: options.excludeDomains } : {}),
            ...(options.language !== undefined ? { language: options.language } : {}),
            ...(options.country !== undefined ? { country: options.country } : {}),
            ...(options.fileType !== undefined ? { fileType: options.fileType } : {}),
            ...(engines !== undefined ? { engines } : {}),
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          }),
        failures,
      );
      if (answer === undefined) continue;
      this.markAnswered(providerId);
      if (engines !== undefined && this.engines !== undefined) {
        this.engines.report(
          EnginePool.outcomes(engines, answer.hits.map((hit) => hit.engines), answer.engineFailures ?? []),
        );
      }
      // Billed as soon as it answered — an empty page costs the same.
      if (left !== undefined || provider.costPerRequestUsd !== undefined) this.noteSpend(providerId);

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
      // An empty answer is not an answer while another provider remains —
      // and never when every engine SearXNG asked failed inside it.
      if (results.length === 0) {
        const engineFailures = answer.engineFailures ?? [];
        const everyEngineFailed =
          engines !== undefined &&
          engines.length > 0 &&
          engines.every((engine) => engineFailures.some((failure) => failure.engine === engine));
        if (everyEngineFailed || !last) {
          failures.push({
            provider: providerId,
            error: everyEngineFailed
              ? `every engine failed (${engineFailures.map((failure) => `${failure.engine}: ${failure.reason}`).join(", ")})`
              : "no results",
          });
          continue;
        }
      }
      const delivered: WebSearchAnswer = {
        query: input.query,
        kind: input.kind,
        provider: providerId,
        results,
        route: input.route,
        ...(answer.total !== undefined ? { total: answer.total } : {}),
        // A metasearch answer names the engines that failed inside it, so a
        // CAPTCHA-blocked engine is a recorded cause, never thinner results.
        ...(answer.engineFailures !== undefined && answer.engineFailures.length > 0
          ? { engineFailures: answer.engineFailures }
          : {}),
        ...(answer.notes !== undefined && answer.notes.length > 0 ? { notes: answer.notes } : {}),
      };
      const noStore = provider.noStore === true;
      const cache = noStore ? (this.transient as WebSearchCache) : this.routeCaches[input.route] ?? this.cache;
      if (cache) {
        try {
          await cache.put(input.cacheKey, delivered);
        } catch {
          // A cache that cannot store loses nothing but the reuse.
        }
      }
      this.emit({
        id: input.recordId,
        at: input.startedAt,
        tool: input.tool,
        outcome: "ok",
        request: input.requestVerbatim,
        response: (noStore ? redactedWebAnswer(delivered) : delivered) as unknown as JsonObject,
        provider: providerId,
        ...(failures.length > 0 ? { failedProviders: [...failures] } : {}),
        elapsedMs: this.now() - input.startedAt,
        cacheKey: input.cacheKey,
        route: input.route,
        ...(engines !== undefined ? { engines: [...engines] } : {}),
        ...(noStore ? { redacted: true } : {}),
        ...(provider.costPerRequestUsd !== undefined ? { costUsd: provider.costPerRequestUsd } : {}),
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
      tool: input.tool,
      outcome: "error",
      request: input.requestVerbatim,
      ...(failures.length > 0 ? { failedProviders: [...failures] } : {}),
      error: summary,
      elapsedMs: this.now() - input.startedAt,
      cacheKey: input.cacheKey,
      route: input.route,
      ...input.attribution,
    });
    throw new WebAccessError(`web search failed — ${summary}`);
  }

  /* ---------------------------------------------------------------------- */
  /* Papers                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Is this entry of a paper route configured (a provider or an index)? */
  private configured(entry: string): boolean {
    if (entry === "searxng:science") return this.providersById.has("searxng") && (this.engines?.serves("paper-science") ?? false);
    return this.providersById.has(entry) || this.paperBackends.has(entry);
  }

  /** The ordered sources one paper search tries, and whether all run at once. */
  private paperPlan(
    request: NormalizedPaperRequest,
    route: "paper-lookup" | "paper-topic",
  ): { readonly entries: readonly string[]; readonly fanout: boolean } {
    const query = request.query;
    if (request.native !== undefined) {
      return { entries: this.configured(request.native.source) ? [request.native.source] : [], fanout: false };
    }
    const list = this.routes[route] ?? DEFAULT_PAPER_ROUTES[route];
    if (request.sources !== undefined) {
      const webEntries = list.filter((entry) => !this.paperBackends.has(entry));
      const entries = [
        ...new Set(request.sources.flatMap((source) => (source === "web" ? webEntries : [source]))),
      ].filter((entry) => this.configured(entry));
      const onlyWeb = request.sources.length === 1 && request.sources[0] === "web";
      return { entries: this.liveOrder(entries), fanout: !onlyWeb && entries.length > 1 };
    }
    // Filters only the scholarly indexes can apply: leave the web out.
    let entries = hasStructuredOptions(query)
      ? list.filter((entry) => this.paperBackends.has(entry))
      : [...list];
    if (hasStructuredOptions(query) && entries.length === 0) {
      entries = ["openalex", "semantic-scholar", "crossref", "arxiv"];
    }
    if (query.fieldsOfStudy.length > 0) {
      entries = ["semantic-scholar", ...entries.filter((entry) => entry !== "semantic-scholar")];
    }
    if (query.arxivCategories.length > 0) {
      entries = ["arxiv", ...entries.filter((entry) => entry !== "arxiv")];
    }
    return { entries: this.liveOrder(entries.filter((entry) => this.configured(entry))), fanout: false };
  }

  async searchPapers(
    query: PaperSearchQuery,
    context: WebAccessCallContext = {},
  ): Promise<PaperSearchAnswer> {
    const startedAt = this.now();
    const recordId = this.nextRecordId();
    const requestVerbatim = structuredClone(query) as unknown as JsonObject;
    const attribution = attributionOf(context);
    let route: WebSearchRoute = "paper-topic";
    const fail = (message: string): never => {
      this.emit({
        id: recordId,
        at: startedAt,
        tool: "paper_search",
        outcome: "error",
        request: requestVerbatim,
        error: message,
        elapsedMs: this.now() - startedAt,
        route,
        ...attribution,
      });
      throw new WebAccessError(message);
    };
    let request: NormalizedPaperRequest;
    try {
      request = normalizePaperQuery(query);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    route = request.query.mode === "lookup" ? "paper-lookup" : "paper-topic";
    const plan = this.paperPlan(request, route as "paper-lookup" | "paper-topic");
    if (plan.entries.length === 0) {
      return fail(
        request.native !== undefined
          ? `native_query names "${request.native.source}", which is not configured on this deployment.`
          : "no paper source is configured on this deployment — configure scholarly search in Settings.",
      );
    }
    const limited = this.overTaskLimit(context);
    if (limited !== undefined) return fail(limited);
    const key = JSON.stringify(["papers", route, request, plan]);
    for (const cache of [this.transientPapers as WebSearchCache<PaperSearchAnswer>, this.paperCache]) {
      if (cache === undefined) continue;
      let cached: PaperSearchAnswer | undefined;
      try {
        cached = await cache.get(key);
      } catch {
        cached = undefined;
      }
      if (cached !== undefined) {
        const answer: PaperSearchAnswer = { ...cached, cached: true };
        this.emitPapers(recordId, startedAt, requestVerbatim, answer, "cached", attribution, key, []);
        return answer;
      }
    }
    const running = this.paperInFlight.get(key);
    if (running !== undefined) {
      try {
        const answer = await running.promise;
        this.emitPapers(recordId, startedAt, requestVerbatim, answer, "coalesced", attribution, key, [], running.recordId);
        return answer;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    }
    const attempt = (async () => {
      const failures: { provider: string; error: string }[] = [];
      const outcomes: PaperOutcome[] = [];
      const agentKey = agentKeyOf(context);
      let fallback: (PaperOutcome & { ok: true }) | undefined;
      if (plan.fanout) {
        outcomes.push(
          ...(await Promise.all(
            plan.entries.map((entry) => this.paperFromEntry(entry, request, route, agentKey, context.signal)),
          )),
        );
        for (const outcome of outcomes) if (!outcome.ok) failures.push({ provider: outcome.provider, error: outcome.error });
      } else {
        for (const [position, entry] of plan.entries.entries()) {
          const outcome = await this.paperFromEntry(entry, request, route, agentKey, context.signal);
          if (!outcome.ok) {
            failures.push({ provider: outcome.provider, error: outcome.error });
            continue;
          }
          const last = position === plan.entries.length - 1;
          if (request.query.mode === "lookup" && !outcome.papers.some((paper) => titleMatches(request.query.query, paper.title))) {
            failures.push({ provider: outcome.provider, error: "no result matches the title" });
            if (outcome.papers.length > 0 && fallback === undefined) fallback = outcome;
            continue;
          }
          if (outcome.papers.length === 0 && !last) {
            failures.push({ provider: outcome.provider, error: "no results" });
            continue;
          }
          outcomes.push(outcome);
          break;
        }
        if (outcomes.length === 0 && fallback !== undefined) outcomes.push(fallback);
      }
      const answered = outcomes.filter((outcome): outcome is PaperOutcome & { ok: true } => outcome.ok);
      if (answered.length === 0) {
        const summary = failures.map((failure) => `${failure.provider}: ${failure.error}`).join("; ") || "no source answered";
        this.emit({
          id: recordId,
          at: startedAt,
          tool: "paper_search",
          outcome: "error",
          request: requestVerbatim,
          failedProviders: [...failures],
          error: summary,
          elapsedMs: this.now() - startedAt,
          cacheKey: key,
          route,
          ...attribution,
        });
        // Every named index is rate-limiting or cooling down: say what helps.
        const limited =
          failures.length > 0 &&
          failures.every((failure) => /HTTP 429|blocked|cooling down|budget/i.test(failure.error));
        const hint =
          request.sources !== undefined
            ? limited
              ? " — those indexes are rate-limiting this deployment: retry in a few minutes, or leave sources unset so another index can answer (OpenAlex and Semantic Scholar also hold arXiv e-prints)."
              : " — retry later, or leave sources unset so another index can answer (OpenAlex and Semantic Scholar also hold arXiv e-prints)."
            : limited
              ? " — the indexes are rate-limiting this deployment: retry in a few minutes."
              : "";
        throw new WebAccessError(`paper search failed — ${summary}${hint}`);
      }
      const papers = mergePaperLists(answered.map((outcome) => outcome.papers), request.query.maxResults);
      const requested = requestedOptions(request.query, request.native !== undefined);
      const applied: Record<string, readonly PaperOption[]> = {};
      const heldSomewhere = new Set<PaperOption>();
      for (const outcome of answered) {
        applied[outcome.provider] = outcome.applied.filter((option) => requested.includes(option));
        for (const option of outcome.applied) heldSomewhere.add(option);
      }
      const reasons = new Map<PaperOption, string>();
      for (const outcome of answered) {
        for (const entry of outcome.unsupported) if (!reasons.has(entry.option)) reasons.set(entry.option, `${outcome.provider}: ${entry.reason}`);
      }
      const notApplied = requested
        .filter((option) => !heldSomewhere.has(option))
        .map((option) => `${option} — ${reasons.get(option) ?? "not supported by the answering source"}`);
      const notes = [
        ...new Set(answered.flatMap((outcome) => outcome.notes)),
        ...(fallback !== undefined && answered.includes(fallback)
          ? ["No source returned a paper with exactly this title; the closest results are listed."]
          : []),
      ];
      const engineFailures = answered.flatMap((outcome) => outcome.engineFailures ?? []);
      const total = answered.length === 1 ? answered[0]!.total : undefined;
      const answer: PaperSearchAnswer = {
        query: request.query.query,
        mode: request.query.mode,
        route,
        providers: answered.map((outcome) => outcome.provider),
        papers,
        ...(total !== undefined ? { total } : {}),
        applied,
        ...(notApplied.length > 0 ? { notApplied } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        ...(engineFailures.length > 0 ? { engineFailures } : {}),
      };
      const noStoreSources = new Set(answered.filter((outcome) => outcome.noStore).map((outcome) => outcome.provider));
      const cache = noStoreSources.size > 0 ? (this.transientPapers as WebSearchCache<PaperSearchAnswer>) : this.paperCache;
      if (cache !== undefined) {
        try {
          await cache.put(key, answer);
        } catch {
          // reuse lost, nothing else
        }
      }
      this.emitPapers(recordId, startedAt, requestVerbatim, answer, "ok", attribution, key, failures);
      return answer;
    })();
    this.paperInFlight.set(key, { recordId, promise: attempt });
    try {
      return await attempt;
    } finally {
      this.paperInFlight.delete(key);
    }
  }

  private emitPapers(
    recordId: string,
    startedAt: number,
    request: JsonObject,
    answer: PaperSearchAnswer,
    outcome: "ok" | "cached" | "coalesced",
    attribution: Partial<WebAccessLogRecord>,
    cacheKey: string,
    failures: readonly { provider: string; error: string }[],
    coalescedWith?: string,
  ): void {
    const noStore = new Set(
      answer.providers.filter((provider) => this.providersById.get(provider)?.noStore === true),
    );
    const cost = answer.providers.reduce(
      (sum, provider) => sum + (outcome === "ok" ? this.providersById.get(provider)?.costPerRequestUsd ?? 0 : 0),
      0,
    );
    this.emit({
      id: recordId,
      at: startedAt,
      tool: "paper_search",
      outcome,
      request,
      response: (noStore.size > 0
        ? { ...answer, papers: redactPapers(answer.papers, noStore) }
        : answer) as unknown as JsonObject,
      provider: answer.providers.join("+"),
      ...(failures.length > 0 ? { failedProviders: [...failures] } : {}),
      elapsedMs: this.now() - startedAt,
      cacheKey,
      route: answer.route,
      ...(noStore.size > 0 ? { redacted: true } : {}),
      ...(cost > 0 ? { costUsd: cost } : {}),
      ...(coalescedWith !== undefined ? { coalescedWith } : {}),
      ...attribution,
    });
  }

  /** One source's answer to a paper search, never throwing for its failures. */
  private async paperFromEntry(
    entry: string,
    request: NormalizedPaperRequest,
    route: WebSearchRoute,
    agentKey: string,
    signal: AbortSignal | undefined,
  ): Promise<PaperOutcome> {
    const query = request.query;
    const failures: { provider: string; error: string }[] = [];
    const backend = this.paperBackends.get(entry);
    if (backend !== undefined) {
      if (!backend.ready.ok) return { ok: false, provider: entry, error: backend.ready.reason };
      const skip = this.skipReason(entry);
      if (skip !== undefined) return { ok: false, provider: entry, error: skip };
      const own: NormalizedPaperQuery =
        request.native !== undefined && request.native.source === entry
          ? { ...query, native: request.native.query }
          : query;
      const answer = await this.callProvider(entry, agentKey, signal, () => backend.search(own, signal), failures);
      if (answer === undefined) {
        return { ok: false, provider: entry, error: failures[0]?.error ?? "no answer" };
      }
      this.markAnswered(entry);
      const enforced = enforceOnRecords(answer.papers, query, new Set(answer.applied));
      return {
        ok: true,
        provider: entry,
        papers: enforced.papers.slice(0, query.maxResults),
        ...(answer.total !== undefined ? { total: answer.total } : {}),
        applied: [...new Set([...answer.applied, ...enforced.enforced])],
        unsupported: answer.unsupported,
        notes: [],
        noStore: false,
      };
    }
    // A web provider on a paper route: search, then resolve identifiers.
    const providerId = entry === "searxng:science" ? "searxng" : entry;
    const provider = this.providersById.get(providerId);
    if (provider === undefined) return { ok: false, provider: entry, error: "not configured on this deployment" };
    const skip = this.skipReason(providerId);
    if (skip !== undefined) return { ok: false, provider: entry, error: skip };
    const left = this.budgetLeft(providerId);
    if (left !== undefined && left <= 0) {
      return { ok: false, provider: entry, error: `paid fallback budget used up (${this.budgets[providerId]} requests in this run)` };
    }
    const engineRoute: EngineRoute = entry === "searxng:science" ? "paper-science" : route;
    const picked = await this.enginesFor(provider, engineRoute, signal);
    if ("unavailable" in picked) return { ok: false, provider: entry, error: picked.unavailable };
    const engines = picked.engines;
    const answer = await this.callProvider(
      providerId,
      agentKey,
      signal,
      () =>
        provider.search({
          query: query.query,
          kind: "general",
          maxResults: Math.min(20, query.maxResults * 2),
          route,
          ...(query.page > 1 ? { page: query.page } : {}),
          ...(engines !== undefined ? { engines } : {}),
          ...(signal !== undefined ? { signal } : {}),
        }),
      failures,
    );
    if (answer === undefined) return { ok: false, provider: entry, error: failures[0]?.error ?? "no answer" };
    this.markAnswered(providerId);
    if (engines !== undefined && this.engines !== undefined) {
      this.engines.report(
        EnginePool.outcomes(engines, answer.hits.map((hit) => hit.engines), answer.engineFailures ?? []),
      );
    }
    if (left !== undefined || provider.costPerRequestUsd !== undefined) this.noteSpend(providerId);
    const records = answer.hits.map(recordFromHit);
    // Resolve DOIs / arXiv IDs the hits carry into full index records.
    const ids = [...new Map(
      records.flatMap((paper) => {
        const id =
          paper.doi !== undefined
            ? parsePaperIdentifier(paper.doi)
            : paper.arxivId !== undefined
              ? parsePaperIdentifier(`arXiv:${paper.arxivId}`)
              : paper.pmid !== undefined
                ? parsePaperIdentifier(`PMID:${paper.pmid}`)
                : undefined;
        return id !== undefined ? [[id.raw, id] as const] : [];
      }),
    ).values()].slice(0, 20);
    const resolved = ids.length > 0
      ? await this.resolveIds(ids, new Set<PaperDetailPart>(["abstract"]), 0, agentKey, signal)
      : { found: new Map<string, PaperDetailsEntry>(), providers: [] as string[] };
    const merged = records.map((paper): PaperRecord => {
      const raw =
        paper.doi ?? (paper.arxivId !== undefined ? `arXiv:${paper.arxivId}` : paper.pmid !== undefined ? `PMID:${paper.pmid}` : undefined);
      const found = raw !== undefined ? resolved.found.get(raw) : undefined;
      if (found === undefined) return paper;
      const { requested: _requested, references: _r, citedBy: _c, related: _l, ...base } = found;
      return base;
    });
    const enforced = enforceOnRecords(merged, query, new Set<PaperOption>(["query"]));
    const unsupported: { option: PaperOption; reason: string }[] = [];
    for (const option of requestedOptions(query, false)) {
      if (option === "query" || enforced.enforced.includes(option)) continue;
      unsupported.push({ option, reason: `the web search (${providerId}) cannot apply ${option}` });
    }
    const notes = [
      ...(answer.notes ?? []),
      ...(resolved.providers.length > 0
        ? [`Metadata for web results with a DOI or arXiv ID came from ${resolved.providers.join(", ")}.`]
        : []),
    ];
    return {
      ok: true,
      provider: entry,
      papers: enforced.papers.slice(0, query.maxResults),
      applied: ["query", ...enforced.enforced],
      unsupported,
      notes,
      ...(answer.engineFailures !== undefined && answer.engineFailures.length > 0
        ? { engineFailures: answer.engineFailures }
        : {}),
      noStore: provider.noStore === true,
    };
  }

  /**
   * Resolves identifiers through the details list (OpenAlex, Crossref,
   * arXiv, Semantic Scholar by default): each index gets the identifiers it
   * understands that are still unresolved, or resolved but missing a
   * requested part it can add.
   */
  private async resolveIds(
    ids: readonly PaperIdentifier[],
    parts: ReadonlySet<PaperDetailPart>,
    limit: number,
    agentKey: string,
    signal: AbortSignal | undefined,
    sources?: readonly string[],
  ): Promise<{ readonly found: Map<string, PaperDetailsEntry>; readonly providers: string[] }> {
    const found = new Map<string, PaperDetailsEntry>();
    const providers: string[] = [];
    const listParts = [...parts].filter((part) => part !== "abstract");
    const missingParts = (entry: PaperDetailsEntry | undefined): PaperDetailPart[] =>
      entry === undefined
        ? listParts
        : listParts.filter(
            (part) =>
              (part === "references" && entry.references === undefined) ||
              (part === "citations" && entry.citedBy === undefined) ||
              (part === "related" && entry.related === undefined),
          );
    const order = this.liveOrder(sources ?? this.routes["paper-details"] ?? DEFAULT_PAPER_ROUTES["paper-details"]);
    for (const id of order) {
      const backend = this.paperBackends.get(id);
      if (backend?.details === undefined || !backend.ready.ok || this.skipReason(id) !== undefined) continue;
      const kinds = DETAIL_KINDS[id] ?? new Set();
      const canAdd = DETAIL_PARTS[id] ?? new Set();
      const wanted = ids.filter((identifier) => {
        if (!kinds.has(identifier.kind)) return false;
        const current = found.get(identifier.raw);
        if (current === undefined) return true;
        return missingParts(current).some((part) => canAdd.has(part));
      });
      if (wanted.length === 0) continue;
      const failures: { provider: string; error: string }[] = [];
      const answer = await this.callProvider(
        id,
        agentKey,
        signal,
        () => backend.details!(wanted, new Set(listParts.filter((part) => canAdd.has(part))), limit, signal),
        failures,
      );
      if (answer === undefined) continue;
      this.markAnswered(id);
      if (answer.size > 0) providers.push(id);
      for (const [raw, entry] of answer) {
        const current = found.get(raw);
        if (current === undefined) {
          found.set(raw, entry);
          continue;
        }
        found.set(raw, {
          ...current,
          ...(current.references === undefined && entry.references !== undefined ? { references: entry.references } : {}),
          ...(current.citedBy === undefined && entry.citedBy !== undefined ? { citedBy: entry.citedBy } : {}),
          ...(current.related === undefined && entry.related !== undefined ? { related: entry.related } : {}),
          ...(current.abstract === undefined && entry.abstract !== undefined ? { abstract: entry.abstract } : {}),
        });
      }
      if (ids.every((identifier) => found.has(identifier.raw) && missingParts(found.get(identifier.raw)).length === 0)) break;
    }
    return { found, providers };
  }

  async paperDetails(
    query: PaperDetailsQuery,
    context: WebAccessCallContext = {},
  ): Promise<PaperDetailsAnswer> {
    const startedAt = this.now();
    const recordId = this.nextRecordId();
    const requestVerbatim = structuredClone(query) as unknown as JsonObject;
    const attribution = attributionOf(context);
    const fail = (message: string): never => {
      this.emit({
        id: recordId,
        at: startedAt,
        tool: "paper_details",
        outcome: "error",
        request: requestVerbatim,
        error: message,
        elapsedMs: this.now() - startedAt,
        route: "paper-details",
        ...attribution,
      });
      throw new WebAccessError(message);
    };
    const rawIds = (Array.isArray(query.ids) ? query.ids : [])
      .filter((id): id is string => typeof id === "string" && id.trim() !== "")
      .slice(0, 20);
    if (rawIds.length === 0) return fail("ids must list at least one DOI, arXiv ID, PMID, PMCID, Semantic Scholar or OpenAlex ID.");
    if (this.paperBackends.size === 0) return fail("no scholarly index is configured on this deployment.");
    const parts = new Set<PaperDetailPart>(
      (query.include ?? ["abstract"]).filter((part): part is PaperDetailPart =>
        (PAPER_DETAIL_PARTS as readonly string[]).includes(part),
      ),
    );
    const limit = Math.min(50, Math.max(1, Math.trunc(query.limit ?? 20)));
    const limited = this.overTaskLimit(context);
    if (limited !== undefined) return fail(limited);
    const parsed = rawIds.map((raw) => ({ raw, id: parsePaperIdentifier(raw) }));
    // An explicit index list (the host's literature retrieval) replaces the
    // route for this call; without one the key and the order are unchanged.
    const sources = Array.isArray(query.sources)
      ? [...new Set(query.sources.filter((source): source is string => typeof source === "string"))]
      : undefined;
    const key = JSON.stringify(["details", rawIds, [...parts].sort(), limit, ...(sources !== undefined ? [sources] : [])]);
    if (this.detailsCache !== undefined) {
      try {
        const cached = await this.detailsCache.get(key);
        if (cached !== undefined) {
          const answer: PaperDetailsAnswer = { ...cached, cached: true };
          this.emit({
            id: recordId,
            at: startedAt,
            tool: "paper_details",
            outcome: "cached",
            request: requestVerbatim,
            response: answer as unknown as JsonObject,
            provider: answer.providers.join("+"),
            elapsedMs: this.now() - startedAt,
            cacheKey: key,
            route: "paper-details",
            ...attribution,
          });
          return answer;
        }
      } catch {
        // a miss
      }
    }
    const ids = parsed.flatMap((entry) => (entry.id !== undefined ? [entry.id] : []));
    const resolved = await this.resolveIds(ids, parts, limit, agentKeyOf(context), context.signal, sources);
    const papers: PaperDetailsEntry[] = [];
    const notFound: string[] = [];
    for (const entry of parsed) {
      const found = entry.id !== undefined ? resolved.found.get(entry.id.raw) : undefined;
      if (found === undefined) {
        notFound.push(entry.raw);
        continue;
      }
      if (!parts.has("abstract")) {
        const { abstract: _abstract, ...rest } = found;
        papers.push(rest);
      } else {
        papers.push(found);
      }
    }
    const unrecognized = parsed.filter((entry) => entry.id === undefined).map((entry) => entry.raw);
    const notes = [
      ...(unrecognized.length > 0
        ? [`Not recognized as a paper identifier: ${unrecognized.join(", ")}. Use a DOI, arXiv ID, PMID:, PMCID, Semantic Scholar or OpenAlex ID.`]
        : []),
      ...(() => {
        // Name exactly the lists that stayed empty, and for which papers.
        const missing = papers.flatMap((paper) => {
          const lists = [
            ...(parts.has("references") && paper.references === undefined ? ["references"] : []),
            ...(parts.has("citations") && paper.citedBy === undefined ? ["citations"] : []),
            ...(parts.has("related") && paper.related === undefined ? ["related"] : []),
          ];
          return lists.length > 0 ? [`${paper.requested}: ${lists.join(", ")}`] : [];
        });
        return missing.length > 0
          ? [`Not available from any index that answered (references, citations and related papers come from OpenAlex or Semantic Scholar; arXiv has none): ${missing.join("; ")}.`]
          : [];
      })(),
    ];
    const answer: PaperDetailsAnswer = {
      papers,
      notFound,
      providers: resolved.providers,
      ...(notes.length > 0 ? { notes } : {}),
    };
    if (papers.length === 0 && notFound.length > 0 && resolved.providers.length === 0) {
      const statuses = [...this.paperBackends.keys()].map((id) => `${id}: ${this.skipReason(id) ?? (this.paperBackends.get(id)!.ready.ok ? "no match" : (this.paperBackends.get(id)!.ready as { reason: string }).reason)}`);
      return fail(`no index could resolve ${notFound.join(", ")} — ${statuses.join("; ")}`);
    }
    if (this.detailsCache !== undefined) {
      try {
        await this.detailsCache.put(key, answer);
      } catch {
        // reuse lost, nothing else
      }
    }
    this.emit({
      id: recordId,
      at: startedAt,
      tool: "paper_details",
      outcome: "ok",
      request: requestVerbatim,
      response: answer as unknown as JsonObject,
      provider: resolved.providers.join("+"),
      elapsedMs: this.now() - startedAt,
      cacheKey: key,
      route: "paper-details",
      ...attribution,
    });
    return answer;
  }

  /* ---------------------------------------------------------------------- */
  /* Availability                                                            */
  /* ---------------------------------------------------------------------- */

  status(): readonly WebSourceStatus[] {
    const ids = new Set([...this.providersById.keys(), ...this.paperBackends.keys()]);
    return [...ids].map((id) => {
      const backend = this.paperBackends.get(id);
      let status: WebSourceStatus =
        this.statuses.get(id) ??
        (backend !== undefined && !backend.ready.ok
          ? { id, state: "needs-key", detail: backend.ready.reason }
          : { id, state: "unchecked" });
      if (id === "searxng" && this.engines !== undefined) {
        const engines = this.engines.status().map((engine): WebSourceStatusWithLog => {
          const log = this.engineLogs.get(engine.id);
          return log !== undefined ? { ...engine, log } : engine;
        });
        status = { ...status, engines };
      }
      const budget = this.budgets[id];
      if (budget !== undefined) {
        const used = `${this.spent.get(id) ?? 0} of ${budget} paid requests used in this run`;
        status = { ...status, detail: status.detail !== undefined ? `${status.detail}; ${used}` : used };
      }
      return status;
    });
  }

  /**
   * The launch check, once per manager: one known-answer request per source
   * (and two per SearXNG engine), all sources in parallel, each through its
   * own rate limit. Sources found needing a key are skipped for the run;
   * unreachable or blocked ones are skipped for ten minutes, then retried.
   * A source whose seeded status (`seededStatuses`) is available or degraded
   * and younger than ten minutes is not probed again.
   */
  startChecks(signal?: AbortSignal): Promise<readonly WebSourceStatus[]> {
    this.checks ??= this.runChecks(signal);
    return this.checks;
  }

  private async runChecks(signal?: AbortSignal): Promise<readonly WebSourceStatus[]> {
    const startedAt = this.now();
    const recordId = this.nextRecordId();
    const tasks: Promise<void>[] = [];
    for (const provider of this.providersById.values()) {
      // A fresh seeded status (the server's probe) stands in for the launch check.
      if (this.seeded.has(provider.id)) continue;
      if (provider.metasearch === true && this.engines !== undefined) {
        const engines = this.engines;
        const gate = this.gates.get(provider.id)!;
        tasks.push(
          (async () => {
            const startedAt = this.now();
            const logs = new Map<string, ProbeLogLine[]>();
            const note = (engine: string, level: ProbeLogLine["level"], text: string): void => {
              const lines = logs.get(engine) ?? [];
              lines.push({ at: this.now(), level, text });
              logs.set(engine, lines);
            };
            const table = await engines.check(
              DEFAULT_ENGINE_CANARIES,
              async (engine, canary, innerSignal) => {
                const asked = this.now();
                note(engine, "info", `probe ${engine}: "${canary.query}" (${canary.route})`);
                try {
                  const answer = await gate.run(() =>
                    provider.search({
                      query: canary.query,
                      kind: canary.route === "news" ? "news" : "general",
                      maxResults: 5,
                      engines: [engine],
                      route: canary.route === "paper-science" ? "paper-topic" : canary.route,
                      ...(innerSignal !== undefined ? { signal: innerSignal } : {}),
                    }),
                  );
                  const failure = answer.engineFailures?.find((entry) => entry.engine === engine)?.reason;
                  note(
                    engine,
                    failure !== undefined ? "warn" : "info",
                    `${answer.hits.length} hits in ${this.now() - asked} ms${failure !== undefined ? `; engine failure: ${failure}` : ""}`,
                  );
                  return {
                    urls: answer.hits.map((hit) => hit.url),
                    ...(failure !== undefined && answer.hits.length === 0 ? { failure } : {}),
                  };
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  note(engine, "error", `failed after ${this.now() - asked} ms: ${message}`);
                  return { urls: [], failure: message };
                }
              },
              signal,
            );
            for (const [engine, lines] of logs) this.engineLogs.set(engine, lines);
            const usable = table.filter((entry) => entry.state === "available" || entry.state === "degraded").length;
            const summary = `${usable} of ${table.length} engines usable`;
            this.setStatus(provider.id, {
              id: provider.id,
              state: usable > 0 ? "available" : "unreachable",
              detail: summary,
              checkedAt: this.now(),
              log: [
                { at: startedAt, level: "info", text: `probe searxng: ${table.length} engines, two known-answer queries each` },
                ...table.map((entry): ProbeLogLine => ({
                  at: this.now(),
                  level: entry.state === "available" ? "info" : entry.state === "degraded" ? "warn" : "error",
                  text: `${entry.id}: ${entry.state}${entry.detail !== undefined ? ` (${entry.detail})` : ""}`,
                })),
                { at: this.now(), level: usable > 0 ? "info" : "error", text: `${summary}; ${this.now() - startedAt} ms` },
              ],
            });
          })(),
        );
      } else if (provider.check !== undefined) {
        const check = provider.check.bind(provider);
        tasks.push(
          check(signal).then(
            (status) => {
              this.setStatus(provider.id, status);
            },
            (error: unknown) => {
              this.setStatus(provider.id, {
                id: provider.id,
                state: "unreachable",
                detail: error instanceof Error ? error.message : String(error),
                checkedAt: this.now(),
              });
            },
          ),
        );
      }
    }
    for (const backend of this.paperBackends.values()) {
      if (!backend.ready.ok) {
        this.setStatus(backend.id, { id: backend.id, state: "needs-key", detail: backend.ready.reason, checkedAt: this.now() });
        continue;
      }
      if (this.seeded.has(backend.id)) continue;
      if (backend.check === undefined) continue;
      const check = backend.check.bind(backend);
      const gate = this.gates.get(backend.id)!;
      tasks.push(
        gate.run(() => check(signal)).then(
          (status) => {
            this.setStatus(backend.id, status);
          },
          (error: unknown) => {
            this.setStatus(backend.id, {
              id: backend.id,
              state: "unreachable",
              detail: error instanceof Error ? error.message : String(error),
              checkedAt: this.now(),
            });
          },
        ),
      );
    }
    await Promise.all(tasks);
    const table = this.status();
    this.emit({
      id: recordId,
      at: startedAt,
      tool: "web_check",
      outcome: "ok",
      request: { check: "launch" },
      response: table as unknown as JsonValue,
      elapsedMs: this.now() - startedAt,
    });
    return table;
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
    const attribution = attributionOf(context);
    const releaseGlobal = await this.global.acquire(agentKeyOf(context), context.signal);
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
