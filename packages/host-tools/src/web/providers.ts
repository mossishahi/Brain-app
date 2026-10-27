/**
 * Search providers behind the unified web layer.
 *
 * Every provider maps ONE upstream API onto the normalized WebSearchHit
 * shape and carries no policy of its own: routing, concurrency, retries,
 * caching, and logging all live in the WebAccessManager. Providers come in
 * two families:
 *
 * - GENERAL web: Tavily (agent-first search API), Brave (independent
 *   index), SearXNG (self-hosted metasearch, keyless). The deployment's
 *   provider list per route decides the order (by default the app-launched
 *   SearXNG first and the paid Brave API as the last resort); the manager
 *   routes web, news and web-backed paper queries through that list.
 * - SCHOLARLY: OpenAlex, Crossref, arXiv, Semantic Scholar — the standard
 *   open scholarly indexes. All work without keys (keys raise rate limits),
 *   so scholarly search works on a fresh install, which is what this
 *   pipeline mostly asks for. Every hit carries a resolvable URL or DOI,
 *   which is exactly the citation contract the capability catalog demands.
 *
 * Provider endpoints are DEPLOYMENT-chosen (unlike web_fetch's model-chosen
 * URLs), so no public-address guard applies here — a self-hosted SearXNG on
 * a private address is legitimate. Requests still ride the process's proxy
 * dispatcher when one is configured.
 */
import type {
  WebSearchEngineFailure,
  WebSearchHit,
  WebSearchKind,
  WebSearchRoute,
} from "@brainstorm-agentic/core";

import { htmlToText } from "../web-search.js";
import { loggingFetch, withSearchProbe, type WebSourceStatusWithLog } from "./probe.js";

/** The one HTTP seam every provider calls; tests inject their own. */
export type ProviderFetch = (
  url: string,
  init: {
    readonly method?: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ProviderSearchRequest {
  readonly query: string;
  readonly kind: WebSearchKind;
  readonly maxResults: number;
  readonly recency?: "day" | "week" | "month" | "year";
  /** Keep only results from these registrable domains. */
  readonly domains?: readonly string[];
  readonly signal?: AbortSignal;
  /** The coordinator's route; web-backed paper routes rank scholarly sites first. */
  readonly route?: WebSearchRoute;
  /** Metasearch only: the exact engines to ask (chosen by the coordinator). */
  readonly engines?: readonly string[];
  /** 1-based results page. */
  readonly page?: number;
  /** Inclusive publication window, YYYY-MM-DD. */
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly excludeDomains?: readonly string[];
  /** ISO 639-1 content language. */
  readonly language?: string;
  /** ISO 3166-1 alpha-2 country. */
  readonly country?: string;
  readonly fileType?: string;
}

export interface ProviderAnswer {
  readonly hits: readonly WebSearchHit[];
  /** Total matches upstream reports, when it reports one. */
  readonly total?: number;
  /** Engines that failed inside a metasearch answer, with their causes. */
  readonly engineFailures?: readonly WebSearchEngineFailure[];
  /** Options the provider could only approximate, in plain words. */
  readonly notes?: readonly string[];
}

/** A retryable upstream failure (429/5xx/network); the manager backs off once. */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Seconds the upstream asked us to wait, when it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export interface WebSearchProvider {
  /** Stable id, used in settings, logs, and hit sources. */
  readonly id: string;
  /** The kinds this provider can answer. */
  readonly kinds: readonly WebSearchKind[];
  /** Politeness floor between two requests to this upstream, in ms. */
  readonly minIntervalMs?: number;
  /** Requests this upstream may have in flight at once; absent = the run's per-source bound. */
  readonly maxConcurrent?: number;
  /** The routes this provider can answer; absent = derived from `kinds`. */
  readonly routes?: readonly WebSearchRoute[];
  /** A metasearch provider: the coordinator names its engines per call. */
  readonly metasearch?: boolean;
  /**
   * The provider's terms forbid keeping its results: the manager caches them
   * in memory only and writes a redacted log record.
   */
  readonly noStore?: boolean;
  /** Metered price per successful request, USD (paid providers). */
  readonly costPerRequestUsd?: number;
  search(request: ProviderSearchRequest): Promise<ProviderAnswer>;
  /** One cheap known-answer request for the launch check, with the log lines it produced. */
  check?(signal?: AbortSignal): Promise<WebSourceStatusWithLog>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Compact whitespace and strip any markup a snippet arrived with. */
export function cleanSnippet(value: unknown, maxChars = 600): string {
  const raw = asString(value);
  if (raw === undefined) return "";
  const text = /[<&]/.test(raw) ? htmlToText(raw).text : raw;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

export async function requestJson(
  fetchImpl: ProviderFetch,
  provider: string,
  url: string,
  init: Parameters<ProviderFetch>[1],
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const text = await requestText(fetchImpl, provider, url, init, signal, timeoutMs);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderRequestError(`${provider} returned non-JSON content`, false);
  }
}

export async function requestText(
  fetchImpl: ProviderFetch,
  provider: string,
  url: string,
  init: Parameters<ProviderFetch>[1],
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Awaited<ReturnType<ProviderFetch>>;
  try {
    response = await fetchImpl(url, { ...init, signal: combined });
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderRequestError(
      timeout.aborted
        ? `${provider} timed out after ${Math.round(timeoutMs / 1000)}s`
        : `${provider} request failed: ${message}`,
      true,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    // Retry-After, else the first window of an X-RateLimit-Reset list
    // ("1, 1419704": seconds until the per-second window resets).
    const declared =
      response.headers.get("retry-after") ??
      response.headers.get("x-ratelimit-reset")?.split(",")[0] ??
      null;
    const retryAfter = Number(declared?.trim());
    throw new ProviderRequestError(
      `${provider} answered HTTP ${response.status}`,
      true,
      declared !== null && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderRequestError(
      `${provider} refused the API key (HTTP ${response.status}) — check it in Settings`,
      false,
    );
  }
  if (response.status >= 400) {
    throw new ProviderRequestError(`${provider} answered HTTP ${response.status}`, false);
  }
  return response.text();
}

/* ------------------------------------------------------------------------ */
/* Shared request shaping and result filtering                               */
/* ------------------------------------------------------------------------ */

function cleanDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function hostMatches(url: string, domains: readonly string[]): boolean {
  const host = hostOf(url);
  if (host === undefined) return false;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * The query with search operators for domain and file-type options. Every
 * engine SearXNG uses for the web, and Brave, understand site:, -site: and
 * filetype:; results are still filtered afterwards, so an engine that
 * ignores an operator cannot leak a result the agent excluded.
 */
export function withOperators(
  query: string,
  request: {
    readonly domains?: readonly string[];
    readonly excludeDomains?: readonly string[];
    readonly fileType?: string;
  },
): string {
  const parts = [query.trim()];
  const include = (request.domains ?? []).map(cleanDomain).filter((domain) => domain !== "");
  if (include.length === 1) parts.push(`site:${include[0]}`);
  else if (include.length > 1) parts.push(`(${include.map((domain) => `site:${domain}`).join(" OR ")})`);
  for (const domain of (request.excludeDomains ?? []).map(cleanDomain)) {
    if (domain !== "") parts.push(`-site:${domain}`);
  }
  if (request.fileType !== undefined && request.fileType.trim() !== "") {
    parts.push(`filetype:${request.fileType.trim().replace(/^\./, "").toLowerCase()}`);
  }
  return parts.join(" ");
}

/** The YYYY-MM-DD day of an ISO-like date, or undefined (relative ages, junk). */
export function isoDay(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

/**
 * The smallest recency window that still contains [dateFrom, today], for
 * engines that filter by window only. Undefined when no window fits
 * (older than a year): dated results are then checked one by one.
 */
export function recencyForWindow(
  dateFrom: string | undefined,
  now: number,
): "day" | "week" | "month" | "year" | undefined {
  if (dateFrom === undefined) return undefined;
  const from = Date.parse(`${dateFrom}T00:00:00Z`);
  if (!Number.isFinite(from)) return undefined;
  const days = (now - from) / 86_400_000;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 366) return "year";
  return undefined;
}

/**
 * Enforces the domain and date options on normalized hits, whatever the
 * upstream did with them, and says what could not be checked.
 */
export function filterHits(
  hits: readonly WebSearchHit[],
  request: Pick<ProviderSearchRequest, "domains" | "excludeDomains" | "dateFrom" | "dateTo">,
): { readonly hits: WebSearchHit[]; readonly notes: string[] } {
  const notes: string[] = [];
  const include = (request.domains ?? []).map(cleanDomain).filter((domain) => domain !== "");
  const exclude = (request.excludeDomains ?? []).map(cleanDomain).filter((domain) => domain !== "");
  let kept = [...hits];
  if (include.length > 0) kept = kept.filter((hit) => hostMatches(hit.url, include));
  if (exclude.length > 0) kept = kept.filter((hit) => !hostMatches(hit.url, exclude));
  if (request.dateFrom !== undefined || request.dateTo !== undefined) {
    let undated = 0;
    kept = kept.filter((hit) => {
      const day = isoDay(hit.published) ?? (hit.year !== undefined ? `${hit.year}-07-01` : undefined);
      if (day === undefined) {
        undated += 1;
        return true;
      }
      if (request.dateFrom !== undefined && day < request.dateFrom) return false;
      if (request.dateTo !== undefined && day > request.dateTo) return false;
      return true;
    });
    if (undated > 0) {
      notes.push(
        `${undated} result(s) carry no publication date, so the date window could not be checked for them.`,
      );
    }
  }
  return { hits: kept, notes };
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry) => {
    const text = asString(entry);
    return text !== undefined ? [text] : [];
  });
  return items.length > 0 ? items : undefined;
}

/* ------------------------------------------------------------------------ */
/* General web: Tavily                                                       */
/* ------------------------------------------------------------------------ */

export function tavilyProvider(options: {
  readonly apiKey: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
}): WebSearchProvider {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "");
  return withSearchProbe({
    id: "tavily",
    kinds: ["general", "news"],
    async search(request) {
      const body = {
        query: request.query,
        max_results: request.maxResults,
        search_depth: "advanced",
        ...(request.kind === "news" ? { topic: "news" } : { topic: "general" }),
        ...(request.recency !== undefined ? { time_range: request.recency } : {}),
        ...(request.domains !== undefined && request.domains.length > 0
          ? { include_domains: [...request.domains] }
          : {}),
      };
      const parsed = record(
        await requestJson(
          fetchImpl,
          "tavily",
          `${base}/search`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify(body),
          },
          request.signal,
        ),
      );
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      return {
        hits: results.flatMap((entry): WebSearchHit[] => {
          const item = record(entry);
          const url = asString(item.url);
          if (url === undefined) return [];
          return [{
            title: asString(item.title) ?? url,
            url,
            snippet: cleanSnippet(item.content),
            source: "tavily",
            ...(asNumber(item.score) !== undefined ? { score: asNumber(item.score) } : {}),
            ...(asString(item.published_date) !== undefined
              ? { published: asString(item.published_date) }
              : {}),
          }];
        }),
      };
    },
  }, { secrets: [options.apiKey] });
}

/* ------------------------------------------------------------------------ */
/* General web: Brave                                                        */
/* ------------------------------------------------------------------------ */

/** Brave freshness codes for the shared recency vocabulary. */
const BRAVE_FRESHNESS: Readonly<Record<string, string>> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

/** What one successful Brave Search request costs on the Search plan, USD. */
export const BRAVE_COST_PER_REQUEST_USD = 0.005;

/**
 * Brave Goggles re-rank results; on web-backed paper searches these rules
 * move scholarly sources up without dropping anything else.
 */
const SCHOLARLY_GOGGLE_RULES: readonly string[] = [
  "$boost=3,site=arxiv.org",
  "$boost=3,site=doi.org",
  "$boost=3,site=openreview.net",
  "$boost=3,site=aclanthology.org",
  "$boost=3,site=semanticscholar.org",
  "$boost=3,site=ncbi.nlm.nih.gov",
  "$boost=3,site=europepmc.org",
  "$boost=2,site=biorxiv.org",
  "$boost=2,site=medrxiv.org",
  "$boost=2,site=proceedings.neurips.cc",
  "$boost=2,site=proceedings.mlr.press",
  "$boost=2,site=jmlr.org",
  "$boost=2,site=dl.acm.org",
  "$boost=2,site=ieeexplore.ieee.org",
  "$boost=2,site=link.springer.com",
  "$boost=2,site=nature.com",
  "$boost=2,site=sciencedirect.com",
  "$downrank=3,site=medium.com",
  "$downrank=3,site=quora.com",
  "$discard,site=pinterest.com",
];

function braveFreshness(request: ProviderSearchRequest): string | undefined {
  if (request.dateFrom !== undefined || request.dateTo !== undefined) {
    const from = request.dateFrom ?? "1970-01-01";
    const to = request.dateTo ?? new Date().toISOString().slice(0, 10);
    return `${from}to${to}`;
  }
  return request.recency !== undefined ? BRAVE_FRESHNESS[request.recency] : undefined;
}

function braveGoggles(request: ProviderSearchRequest): string | undefined {
  const rules: string[] = [];
  if (request.route === "paper-lookup" || request.route === "paper-topic") {
    rules.push(...SCHOLARLY_GOGGLE_RULES);
  }
  for (const domain of (request.excludeDomains ?? []).map(cleanDomain)) {
    if (domain !== "") rules.push(`$discard,site=${domain}`);
  }
  return rules.length > 0 ? rules.join("\n") : undefined;
}

export function braveProvider(options: {
  readonly apiKey: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
}): WebSearchProvider {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://api.search.brave.com").replace(/\/+$/, "");
  return withSearchProbe({
    id: "brave",
    kinds: ["general", "news"],
    routes: ["web", "news", "paper-lookup", "paper-topic"],
    // The Search plan allows 50 requests per second; one per second is
    // ample for a last-resort fallback and keeps a runaway loop cheap.
    minIntervalMs: 1_100,
    // Brave's terms allow only transient storage of results: memory-only
    // cache, redacted log record.
    noStore: true,
    costPerRequestUsd: BRAVE_COST_PER_REQUEST_USD,
    async search(request) {
      const news = request.kind === "news" || request.route === "news";
      const url = new URL(`${base}/res/v1/${news ? "news" : "web"}/search`);
      // q may hold 600 characters on Web, 400 on News.
      url.searchParams.set("q", withOperators(request.query, request).slice(0, news ? 400 : 600));
      url.searchParams.set("count", String(Math.min(20, Math.max(1, request.maxResults))));
      // The query is used as written (spellcheck would silently replace it),
      // snippets come without highlight markers, and both endpoints use the
      // same safe-search level (News would otherwise default to strict).
      url.searchParams.set("spellcheck", "false");
      url.searchParams.set("text_decorations", "false");
      url.searchParams.set("safesearch", "moderate");
      if (request.page !== undefined && request.page > 1) {
        url.searchParams.set("offset", String(Math.min(9, request.page - 1)));
      }
      const freshness = braveFreshness(request);
      if (freshness !== undefined) url.searchParams.set("freshness", freshness);
      if (request.country !== undefined) {
        url.searchParams.set("country", request.country.toUpperCase());
      }
      if (request.language !== undefined) {
        url.searchParams.set("search_lang", request.language.toLowerCase());
      }
      const goggles = braveGoggles(request);
      if (goggles !== undefined) url.searchParams.set("goggles", goggles);
      const parsed = record(
        await requestJson(
          fetchImpl,
          "brave",
          url.toString(),
          {
            method: "GET",
            headers: {
              accept: "application/json",
              "x-subscription-token": options.apiKey,
            },
          },
          request.signal,
        ),
      );
      // The News endpoint answers with a top-level results list; the Web
      // endpoint with web/news sections, read in the order the kind wants.
      const sections = news
        ? [parsed.results, record(parsed.news).results, record(parsed.web).results]
        : [record(parsed.web).results, record(parsed.news).results];
      const entries = sections.flatMap((section) => (Array.isArray(section) ? section : []));
      const hits = entries.flatMap((entry): WebSearchHit[] => {
        const item = record(entry);
        const url = asString(item.url);
        if (url === undefined) return [];
        return [{
          title: asString(item.title) ?? url,
          url,
          snippet: cleanSnippet(item.description),
          source: "brave",
          ...(asString(item.page_age) !== undefined
            ? { published: asString(item.page_age) }
            : asString(item.age) !== undefined
              ? { published: asString(item.age) }
              : {}),
        }];
      });
      const filtered = filterHits(hits, request);
      return {
        hits: filtered.hits,
        ...(filtered.notes.length > 0 ? { notes: filtered.notes } : {}),
      };
    },
  }, { secrets: [options.apiKey] });
}

/* ------------------------------------------------------------------------ */
/* General web: SearXNG (self-hosted metasearch, keyless)                    */
/* ------------------------------------------------------------------------ */

/**
 * SearXNG's `unresponsive_engines`: an array of `[engine, reason]` pairs
 * (newer builds may append extra elements). This is where a CAPTCHA at one
 * engine becomes a NAMED fact instead of silently thinner results.
 */
function parseEngineFailures(value: unknown): WebSearchEngineFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): WebSearchEngineFailure[] => {
    if (!Array.isArray(entry)) return [];
    const engine = asString(entry[0]);
    if (engine === undefined) return [];
    return [{ engine, reason: asString(entry[1]) ?? "unresponsive" }];
  });
}

/**
 * SearXNG parses special tokens ANYWHERE in q: a resolvable "!bang"
 * overrides the engines parameter (the fan-out the coordinator prevents),
 * ":xx" sets the language, "<N" the timeout. They are neutralized so the
 * query means what the agent wrote and the engine list holds.
 */
export function neutralizeSearxngTokens(query: string): string {
  return query
    .split(/\s+/)
    .map((token) =>
      /^!{1,2}\S/.test(token)
        ? token.replace(/^!+/, "")
        : /^:[a-zA-Z_-]+$/.test(token)
          ? token.slice(1)
          : /^<\d+$/.test(token)
            ? token.slice(1)
            : token,
    )
    .filter((token) => token !== "")
    .join(" ");
}

export function searxngProvider(options: {
  readonly baseUrl: string;
  readonly fetchImpl?: ProviderFetch;
}): WebSearchProvider {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = options.baseUrl.replace(/\/+$/, "");
  return withSearchProbe({
    id: "searxng",
    kinds: ["general", "news"],
    routes: ["web", "news", "paper-lookup", "paper-topic"],
    metasearch: true,
    async search(request) {
      const url = new URL(`${base}/search`);
      url.searchParams.set("q", withOperators(neutralizeSearxngTokens(request.query), request));
      url.searchParams.set("format", "json");
      // An explicit engine list, or a category — never both: SearXNG ADDS
      // every engine of a named category to an explicit list, which is the
      // fan-out the coordinator exists to prevent.
      if (request.engines !== undefined && request.engines.length > 0) {
        url.searchParams.set("engines", request.engines.join(","));
      } else {
        url.searchParams.set(
          "categories",
          request.kind === "news" || request.route === "news" ? "news" : "general",
        );
      }
      const notes: string[] = [];
      const window = request.recency ?? recencyForWindow(request.dateFrom, Date.now());
      if (window !== undefined) url.searchParams.set("time_range", window);
      if (request.recency === undefined && (request.dateFrom !== undefined || request.dateTo !== undefined)) {
        notes.push(
          window !== undefined
            ? `SearXNG filters by recency window only: the "${window}" window was used and dated results outside the requested dates were dropped.`
            : "SearXNG has no window this long: only dated results were checked against the requested dates.",
        );
      }
      if (request.page !== undefined && request.page > 1) {
        url.searchParams.set("pageno", String(request.page));
      }
      if (request.language !== undefined) url.searchParams.set("language", request.language);
      const parsed = record(
        await requestJson(
          fetchImpl,
          "searxng",
          url.toString(),
          { method: "GET", headers: { accept: "application/json" } },
          request.signal,
        ),
      );
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const engineFailures = parseEngineFailures(parsed.unresponsive_engines);
      const hits = results.slice(0, request.maxResults * 2).flatMap((entry): WebSearchHit[] => {
        const item = record(entry);
        const url = asString(item.url);
        if (url === undefined) return [];
        const engines = asStringArray(item.engines) ?? (asString(item.engine) !== undefined ? [asString(item.engine)!] : undefined);
        return [{
          title: asString(item.title) ?? url,
          url,
          snippet: cleanSnippet(item.content),
          source: "searxng",
          ...(asNumber(item.score) !== undefined ? { score: asNumber(item.score) } : {}),
          ...(engines !== undefined ? { engines } : {}),
          ...(asString(item.publishedDate) !== undefined
            ? { published: asString(item.publishedDate) }
            : {}),
          ...(asString(item.doi) !== undefined ? { doi: asString(item.doi) } : {}),
        }];
      });
      if (request.engines !== undefined && request.engines.length > 0) {
        const asked = new Set(request.engines);
        const unexpected = [...new Set(hits.flatMap((hit) => hit.engines ?? []))].filter(
          (engine) => !asked.has(engine),
        );
        if (unexpected.length > 0) {
          notes.push(
            `SearXNG answered with engines that were not requested (${unexpected.join(", ")}): ` +
              "a requested engine is probably not enabled in the instance's settings.",
          );
        }
      }
      const filtered = filterHits(hits, request);
      notes.push(...filtered.notes);
      return {
        ...(engineFailures.length > 0 ? { engineFailures } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        hits: filtered.hits,
      };
    },
  });
}

/* ------------------------------------------------------------------------ */
/* Scholarly: OpenAlex                                                       */
/* ------------------------------------------------------------------------ */

/** Rebuilds readable abstract text from OpenAlex's inverted index, bounded. */
export function abstractFromInvertedIndex(value: unknown, maxWords = 80): string {
  const index = record(value);
  const positions: { word: string; at: number }[] = [];
  for (const [word, places] of Object.entries(index)) {
    if (!Array.isArray(places)) continue;
    for (const place of places) {
      if (typeof place === "number") positions.push({ word, at: place });
    }
  }
  if (positions.length === 0) return "";
  positions.sort((a, b) => a.at - b.at);
  const words = positions.slice(0, maxWords).map((entry) => entry.word);
  return words.join(" ") + (positions.length > maxWords ? "…" : "");
}

export function openAlexProvider(options: {
  readonly fetchImpl?: ProviderFetch;
  readonly apiKey?: string;
  /** Polite-pool contact; rides as `mailto` when set. */
  readonly contactEmail?: string;
  readonly baseUrl?: string;
} = {}): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as ProviderFetch);
  const base = (options.baseUrl ?? "https://api.openalex.org").replace(/\/+$/, "");
  return {
    id: "openalex",
    kinds: ["scholarly"],
    async search(request) {
      const url = new URL(`${base}/works`);
      url.searchParams.set("search", request.query);
      url.searchParams.set("per-page", String(request.maxResults));
      if (options.apiKey !== undefined) url.searchParams.set("api_key", options.apiKey);
      if (options.contactEmail !== undefined) url.searchParams.set("mailto", options.contactEmail);
      const parsed = record(
        await requestJson(
          fetchImpl,
          "openalex",
          url.toString(),
          { method: "GET", headers: { accept: "application/json" } },
          request.signal,
        ),
      );
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const total = asNumber(record(parsed.meta).count);
      return {
        ...(total !== undefined ? { total } : {}),
        hits: results.flatMap((entry): WebSearchHit[] => {
          const item = record(entry);
          const doi = asString(item.doi);
          const landing = asString(record(record(item.primary_location).source).display_name);
          const landingUrl = asString(record(item.primary_location).landing_page_url);
          const url = doi ?? landingUrl ?? asString(item.id);
          const title = asString(item.display_name);
          if (url === undefined || title === undefined) return [];
          const authors = (Array.isArray(item.authorships) ? item.authorships : []).flatMap(
            (authorship) => {
              const name = asString(record(record(authorship).author).display_name);
              return name !== undefined ? [name] : [];
            },
          );
          return [{
            title,
            url,
            snippet: cleanSnippet(abstractFromInvertedIndex(item.abstract_inverted_index)),
            source: "openalex",
            ...(doi !== undefined ? { doi: doi.replace(/^https:\/\/doi\.org\//, "") } : {}),
            ...(authors.length > 0 ? { authors: authors.slice(0, 8) } : {}),
            ...(landing !== undefined ? { venue: landing } : {}),
            ...(asNumber(item.publication_year) !== undefined
              ? { year: asNumber(item.publication_year) }
              : {}),
            ...(asNumber(item.cited_by_count) !== undefined
              ? { citations: asNumber(item.cited_by_count) }
              : {}),
          }];
        }),
      };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Scholarly: Crossref                                                       */
/* ------------------------------------------------------------------------ */

export function crossrefProvider(options: {
  readonly fetchImpl?: ProviderFetch;
  readonly contactEmail?: string;
  readonly baseUrl?: string;
} = {}): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as ProviderFetch);
  const base = (options.baseUrl ?? "https://api.crossref.org").replace(/\/+$/, "");
  const polite = options.contactEmail !== undefined && options.contactEmail.trim() !== "";
  return {
    id: "crossref",
    kinds: ["scholarly"],
    // The same limits as the Crossref paper index (they share one gate).
    minIntervalMs: polite ? 350 : 1_050,
    maxConcurrent: polite ? 3 : 1,
    async search(request) {
      const url = new URL(`${base}/works`);
      url.searchParams.set("query", request.query);
      url.searchParams.set("rows", String(request.maxResults));
      if (options.contactEmail !== undefined) url.searchParams.set("mailto", options.contactEmail);
      const parsed = record(
        await requestJson(
          fetchImpl,
          "crossref",
          url.toString(),
          { method: "GET", headers: { accept: "application/json" } },
          request.signal,
        ),
      );
      const message = record(parsed.message);
      const items = Array.isArray(message.items) ? message.items : [];
      const total = asNumber(message["total-results"]);
      return {
        ...(total !== undefined ? { total } : {}),
        hits: items.flatMap((entry): WebSearchHit[] => {
          const item = record(entry);
          const doi = asString(item.DOI);
          const title = Array.isArray(item.title) ? asString(item.title[0]) : asString(item.title);
          const url = asString(item.URL) ?? (doi !== undefined ? `https://doi.org/${doi}` : undefined);
          if (title === undefined || url === undefined) return [];
          const authors = (Array.isArray(item.author) ? item.author : []).flatMap((author) => {
            const person = record(author);
            const name = [asString(person.given), asString(person.family)]
              .filter((part): part is string => part !== undefined)
              .join(" ");
            return name !== "" ? [name] : [];
          });
          const issued = record(item.issued)["date-parts"];
          const year =
            Array.isArray(issued) && Array.isArray(issued[0]) ? asNumber(issued[0][0]) : undefined;
          const venue = Array.isArray(item["container-title"])
            ? asString(item["container-title"][0])
            : undefined;
          return [{
            title,
            url,
            snippet: cleanSnippet(item.abstract),
            source: "crossref",
            ...(doi !== undefined ? { doi } : {}),
            ...(authors.length > 0 ? { authors: authors.slice(0, 8) } : {}),
            ...(venue !== undefined ? { venue } : {}),
            ...(year !== undefined ? { year } : {}),
            ...(asNumber(item["is-referenced-by-count"]) !== undefined
              ? { citations: asNumber(item["is-referenced-by-count"]) }
              : {}),
          }];
        }),
      };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Scholarly: arXiv                                                          */
/* ------------------------------------------------------------------------ */

/** Extracts the text of the first `<tag>…</tag>` inside an XML fragment. */
function xmlText(fragment: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(fragment);
  if (!match) return undefined;
  return htmlToText(match[1]!).text.replace(/\s+/g, " ").trim() || undefined;
}

export function arxivProvider(options: {
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
} = {}): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as ProviderFetch);
  const base = (options.baseUrl ?? "https://export.arxiv.org").replace(/\/+$/, "");
  return {
    id: "arxiv",
    kinds: ["scholarly"],
    // arXiv's terms: one request every three seconds, over one connection.
    minIntervalMs: 3_100,
    maxConcurrent: 1,
    async search(request) {
      const url = new URL(`${base}/api/query`);
      url.searchParams.set("search_query", `all:${request.query}`);
      url.searchParams.set("max_results", String(request.maxResults));
      url.searchParams.set("sortBy", "relevance");
      const body = await requestText(
        fetchImpl,
        "arxiv",
        url.toString(),
        { method: "GET", headers: { accept: "application/atom+xml" } },
        request.signal,
      );
      const entries = body.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
      // A refused query comes back as a feed whose one entry is an error.
      for (const entry of entries) {
        if (/\/api\/errors/.test(xmlText(entry, "id") ?? "")) {
          throw new ProviderRequestError(`arXiv refused the query: ${xmlText(entry, "summary") ?? "error"}`, false);
        }
      }
      return {
        hits: entries.flatMap((entry): WebSearchHit[] => {
          const title = xmlText(entry, "title");
          const link = xmlText(entry, "id");
          if (title === undefined || link === undefined) return [];
          const authors = (entry.match(/<name>[\s\S]*?<\/name>/g) ?? []).flatMap((name) => {
            const text = xmlText(name, "name");
            return text !== undefined ? [text] : [];
          });
          const published = xmlText(entry, "published");
          return [{
            title,
            url: link,
            snippet: cleanSnippet(xmlText(entry, "summary")),
            source: "arxiv",
            venue: "arXiv",
            ...(authors.length > 0 ? { authors: authors.slice(0, 8) } : {}),
            ...(published !== undefined ? { published } : {}),
            ...(published !== undefined && /^\d{4}/.test(published)
              ? { year: Number(published.slice(0, 4)) }
              : {}),
          }];
        }),
      };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Scholarly: Semantic Scholar                                               */
/* ------------------------------------------------------------------------ */

export function semanticScholarProvider(options: {
  readonly fetchImpl?: ProviderFetch;
  readonly apiKey?: string;
  readonly baseUrl?: string;
} = {}): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as ProviderFetch);
  const base = (options.baseUrl ?? "https://api.semanticscholar.org").replace(/\/+$/, "");
  return {
    id: "semantic-scholar",
    // Keyless requests share one pool with every anonymous user; a keyed
    // account is 1 req/s. Either way the polite floor is about a second.
    minIntervalMs: 1_100,
    kinds: ["scholarly"],
    async search(request) {
      const url = new URL(`${base}/graph/v1/paper/search`);
      url.searchParams.set("query", request.query);
      url.searchParams.set("limit", String(request.maxResults));
      url.searchParams.set(
        "fields",
        "title,abstract,url,year,venue,externalIds,citationCount,authors",
      );
      const parsed = record(
        await requestJson(
          fetchImpl,
          "semantic-scholar",
          url.toString(),
          {
            method: "GET",
            headers: {
              accept: "application/json",
              ...(options.apiKey !== undefined ? { "x-api-key": options.apiKey } : {}),
            },
          },
          request.signal,
        ),
      );
      const data = Array.isArray(parsed.data) ? parsed.data : [];
      const total = asNumber(parsed.total);
      return {
        ...(total !== undefined ? { total } : {}),
        hits: data.flatMap((entry): WebSearchHit[] => {
          const item = record(entry);
          const title = asString(item.title);
          const doi = asString(record(item.externalIds).DOI);
          const url =
            asString(item.url) ?? (doi !== undefined ? `https://doi.org/${doi}` : undefined);
          if (title === undefined || url === undefined) return [];
          const authors = (Array.isArray(item.authors) ? item.authors : []).flatMap((author) => {
            const name = asString(record(author).name);
            return name !== undefined ? [name] : [];
          });
          return [{
            title,
            url,
            snippet: cleanSnippet(item.abstract),
            source: "semantic-scholar",
            ...(doi !== undefined ? { doi } : {}),
            ...(authors.length > 0 ? { authors: authors.slice(0, 8) } : {}),
            ...(asString(item.venue) !== undefined ? { venue: asString(item.venue) } : {}),
            ...(asNumber(item.year) !== undefined ? { year: asNumber(item.year) } : {}),
            ...(asNumber(item.citationCount) !== undefined
              ? { citations: asNumber(item.citationCount) }
              : {}),
          }];
        }),
      };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Offline: deterministic, for tests and --offline wiring checks             */
/* ------------------------------------------------------------------------ */

/** FNV-1a, for stable offline fixtures per query. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function offlineSearchProvider(): WebSearchProvider {
  return {
    id: "offline",
    kinds: ["general", "scholarly", "news"],
    async search(request) {
      const seed = fnv1a(`${request.kind}|${request.query}`);
      const count = Math.min(request.maxResults, 3);
      return {
        total: count,
        hits: Array.from({ length: count }, (_, index): WebSearchHit => ({
          title: `Deterministic result ${index + 1} for "${request.query}"`,
          url: `https://offline.invalid/${request.kind}/${seed.toString(16)}/${index + 1}`,
          snippet:
            `Offline fixture ${seed.toString(16)}-${index + 1}: no network was consulted; ` +
            "this result exists so the search pipeline stays testable end to end.",
          source: "offline",
        })),
      };
    },
  };
}
