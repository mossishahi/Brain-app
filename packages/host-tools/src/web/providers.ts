/**
 * Search providers behind the unified web layer.
 *
 * Every provider maps ONE upstream API onto the normalized WebSearchHit
 * shape and carries no policy of its own: routing, concurrency, retries,
 * caching, and logging all live in the WebAccessManager. Providers come in
 * two families:
 *
 * - GENERAL web: Tavily (agent-first search API), Brave (independent
 *   index), SearXNG (self-hosted metasearch, keyless). Exactly one is
 *   selected by deployment settings; the manager routes "general" and
 *   "news" queries to it.
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
} from "@brainstorm-agentic/core";

import { htmlToText } from "../web-search.js";

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
  readonly domains?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ProviderAnswer {
  readonly hits: readonly WebSearchHit[];
  /** Total matches upstream reports, when it reports one. */
  readonly total?: number;
  /** Engines that failed inside a metasearch answer, with their causes. */
  readonly engineFailures?: readonly WebSearchEngineFailure[];
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
  search(request: ProviderSearchRequest): Promise<ProviderAnswer>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Compact whitespace and strip any markup a snippet arrived with. */
function cleanSnippet(value: unknown, maxChars = 600): string {
  const raw = asString(value);
  if (raw === undefined) return "";
  const text = /[<&]/.test(raw) ? htmlToText(raw).text : raw;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

async function requestJson(
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

async function requestText(
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
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ProviderRequestError(
      `${provider} answered HTTP ${response.status}`,
      true,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
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
/* General web: Tavily                                                       */
/* ------------------------------------------------------------------------ */

export function tavilyProvider(options: {
  readonly apiKey: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
}): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as ProviderFetch);
  const base = (options.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "");
  return {
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
  };
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

export function braveProvider(options: {
  readonly apiKey: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
}): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as ProviderFetch);
  const base = (options.baseUrl ?? "https://api.search.brave.com").replace(/\/+$/, "");
  return {
    id: "brave",
    kinds: ["general", "news"],
    // Free/base Brave plans allow one request per second.
    minIntervalMs: 1_100,
    async search(request) {
      const url = new URL(`${base}/res/v1/web/search`);
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(request.maxResults));
      if (request.recency !== undefined) {
        url.searchParams.set("freshness", BRAVE_FRESHNESS[request.recency]!);
      }
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
      const sections =
        request.kind === "news"
          ? [record(parsed.news).results, record(parsed.web).results]
          : [record(parsed.web).results, record(parsed.news).results];
      const entries = sections.flatMap((section) => (Array.isArray(section) ? section : []));
      return {
        hits: entries.flatMap((entry): WebSearchHit[] => {
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
        }),
      };
    },
  };
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

export function searxngProvider(options: {
  readonly baseUrl: string;
  readonly fetchImpl?: ProviderFetch;
}): WebSearchProvider {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as ProviderFetch);
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    id: "searxng",
    kinds: ["general", "news"],
    async search(request) {
      const url = new URL(`${base}/search`);
      url.searchParams.set("q", request.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("categories", request.kind === "news" ? "news" : "general");
      if (request.recency !== undefined) url.searchParams.set("time_range", request.recency);
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
      return {
        ...(engineFailures.length > 0 ? { engineFailures } : {}),
        hits: results.slice(0, request.maxResults * 2).flatMap((entry): WebSearchHit[] => {
          const item = record(entry);
          const url = asString(item.url);
          if (url === undefined) return [];
          return [{
            title: asString(item.title) ?? url,
            url,
            snippet: cleanSnippet(item.content),
            source: "searxng",
            ...(asNumber(item.score) !== undefined ? { score: asNumber(item.score) } : {}),
            ...(asString(item.publishedDate) !== undefined
              ? { published: asString(item.publishedDate) }
              : {}),
          }];
        }),
      };
    },
  };
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
  return {
    id: "crossref",
    kinds: ["scholarly"],
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
    // arXiv asks for no more than one request every three seconds.
    minIntervalMs: 3_100,
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
