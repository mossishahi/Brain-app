/**
 * Access contract for the HOST-OWNED web layer.
 *
 * Web search and web fetch are deliberately NOT provider-native anywhere in
 * this pipeline: a provider-side search is a black box (its query rewriting,
 * its index, its ranking, and what came back are all invisible to the host),
 * so the run's record cannot say what was searched or what was read. Every
 * agent on every backend therefore reaches the web through ONE host
 * implementation behind this interface — the same tools, the same providers,
 * the same limits — and every call is written to the run's own search log,
 * character for character, before the model reads the answer.
 *
 * Implementations: the WebAccessManager in @brainstorm-agentic/host-tools
 * (multi-provider, parallel, cached, logged). Offline runs wire none, and the
 * capability broker then reports web-search honestly as vacant.
 */
import type { JsonObject, JsonValue } from "./types/json.js";

/**
 * What KIND of question a search answers. The manager routes each kind to its
 * own provider chain, which is how institution-specific APIs (scholarly
 * indexes today; finance, patents, clinical registries tomorrow) plug in
 * without the tool surface changing.
 */
export type WebSearchKind = "general" | "scholarly" | "news";

export const WEB_SEARCH_KINDS: readonly WebSearchKind[] = [
  "general",
  "scholarly",
  "news",
];

/**
 * How the run's search coordinator schedules one call: the ROUTE picks the
 * provider list that answers it. "web" and "news" come from web_search and
 * news_search; the paper routes from paper_search (a known paper by its
 * title, or papers about a topic) and paper_details (lookup by identifier).
 */
export type WebSearchRoute = "web" | "news" | "paper-lookup" | "paper-topic" | "paper-details";

export interface WebSearchQuery {
  /** The query text, verbatim from the model. */
  readonly query: string;
  /** Routing class; absent means "general". */
  readonly kind?: WebSearchKind;
  /** Result ceiling after dedupe; the manager clamps it to its own bounds. */
  readonly maxResults?: number;
  /** Bias toward recent material where the backing provider supports it. */
  readonly recency?: "day" | "week" | "month" | "year";
  /** Restrict results to these registrable domains, where supported. */
  readonly domains?: readonly string[];
  /** 1-based results page, where the provider pages. */
  readonly page?: number;
  /**
   * Inclusive publication window, YYYY-MM-DD. Exact where the provider
   * filters by date; otherwise the nearest recency window is used and dated
   * results outside the window are dropped.
   */
  readonly dateFrom?: string;
  readonly dateTo?: string;
  /** Drop results from these registrable domains. */
  readonly excludeDomains?: readonly string[];
  /** Content language, ISO 639-1 (e.g. "en"). */
  readonly language?: string;
  /** Country for regional ranking, ISO 3166-1 alpha-2 (e.g. "DE"). */
  readonly country?: string;
  /** Restrict results to one file type (e.g. "pdf"). */
  readonly fileType?: string;
}

/** One search result, normalized across every provider. */
export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** ISO date (or year) when the provider reports one. */
  readonly published?: string;
  /** Which provider produced this hit (a chain may fail over). */
  readonly source: string;
  /** Provider-reported relevance, when one exists. Never invented. */
  readonly score?: number;
  /** Metasearch only: the engines that returned this hit. */
  readonly engines?: readonly string[];
  /** Scholarly enrichment, when the provider carries it. */
  readonly doi?: string;
  readonly authors?: readonly string[];
  readonly venue?: string;
  readonly year?: number;
  readonly citations?: number;
}

/**
 * One search engine that failed INSIDE a metasearch answer (SearXNG asks
 * several engines per query; a CAPTCHA or timeout at one of them is not a
 * failed search, but it is a narrower one, and the record must say so).
 */
export interface WebSearchEngineFailure {
  readonly engine: string;
  /** The upstream's own reason, verbatim: "CAPTCHA", "timeout", … */
  readonly reason: string;
}

export interface WebSearchAnswer {
  readonly query: string;
  readonly kind: WebSearchKind;
  /** The provider that answered (after any failover). */
  readonly provider: string;
  readonly results: readonly WebSearchHit[];
  /** Total before the maxResults clamp, when the provider reports one. */
  readonly total?: number;
  /** True when the answer was served from the manager's cache. */
  readonly cached?: boolean;
  /**
   * Engines that failed inside this (metasearch) answer, with their causes.
   * Rides the answer itself — the model deserves to know its results came
   * from fewer sources — and therefore the log, verbatim.
   */
  readonly engineFailures?: readonly WebSearchEngineFailure[];
  /** The coordinator's route for this call. */
  readonly route?: WebSearchRoute;
  /** What the coordinator could not honour exactly, in plain words. */
  readonly notes?: readonly string[];
}

/* ------------------------------------------------------------------------ */
/* Papers: search, details, availability                                     */
/* ------------------------------------------------------------------------ */

/**
 * Scholarly indexes a search can name; "web" is the general web search.
 * "europepmc", "core" and "opencitations" serve the host's own literature
 * retrieval (the agents' paper_search tool does not offer them).
 */
export type PaperSource =
  | "arxiv"
  | "openalex"
  | "crossref"
  | "semantic-scholar"
  | "web"
  | "europepmc"
  | "core"
  | "opencitations";

export const PAPER_SOURCES: readonly PaperSource[] = [
  "arxiv",
  "openalex",
  "crossref",
  "semantic-scholar",
  "web",
  "europepmc",
  "core",
  "opencitations",
];

export type PaperSort = "relevance" | "newest" | "oldest" | "most-cited";

export const PAPER_SORTS: readonly PaperSort[] = ["relevance", "newest", "oldest", "most-cited"];

/** A provider-neutral publication type; each index maps it to its own vocabulary. */
export type PaperType =
  | "journal-article"
  | "conference-paper"
  | "preprint"
  | "review"
  | "book"
  | "book-chapter"
  | "dataset"
  | "thesis";

export const PAPER_TYPES: readonly PaperType[] = [
  "journal-article",
  "conference-paper",
  "preprint",
  "review",
  "book",
  "book-chapter",
  "dataset",
  "thesis",
];

export interface PaperSearchQuery {
  /** Topic, method, question, or a paper's title — verbatim from the model. */
  readonly query: string;
  /** "lookup": one known paper by its title; "topic": papers about something. */
  readonly mode?: "auto" | "topic" | "lookup";
  /** Words or quoted phrases that must all appear in the title. */
  readonly titleContains?: readonly string[];
  /** Words or quoted phrases that must all appear in the abstract. */
  readonly abstractContains?: readonly string[];
  readonly authors?: readonly string[];
  /** Inclusive publication window, YYYY-MM-DD. */
  readonly dateFrom?: string;
  readonly dateTo?: string;
  /** Search only these indexes; several are searched together and merged. */
  readonly sources?: readonly PaperSource[];
  /** arXiv subject classes, e.g. "cs.LG" (arXiv only). */
  readonly arxivCategories?: readonly string[];
  /** Semantic Scholar fields of study, e.g. "Computer Science". */
  readonly fieldsOfStudy?: readonly string[];
  readonly venues?: readonly string[];
  readonly types?: readonly PaperType[];
  readonly openAccessOnly?: boolean;
  readonly minCitations?: number;
  readonly sort?: PaperSort;
  readonly maxResults?: number;
  readonly page?: number;
  /** A query in one index's own syntax, passed through unchanged. */
  readonly native?: { readonly source: Exclude<PaperSource, "web">; readonly query: string };
}

/** One paper, normalized across indexes: only what the index reported. */
export interface PaperRecord {
  readonly title: string;
  readonly url: string;
  readonly authors?: readonly string[];
  readonly year?: number;
  /** Publication (or first-submission) date, ISO. */
  readonly date?: string;
  readonly venue?: string;
  readonly doi?: string;
  readonly arxivId?: string;
  readonly pmid?: string;
  readonly pmcid?: string;
  readonly semanticScholarId?: string;
  readonly openAlexId?: string;
  /** CORE work id (core.ac.uk). */
  readonly coreId?: string;
  readonly pdfUrl?: string;
  readonly openAccess?: boolean;
  readonly citations?: number;
  /** The index's own type label, verbatim. */
  readonly type?: string;
  readonly categories?: readonly string[];
  /** The abstract (possibly shortened); for a web hit, its snippet. */
  readonly abstract?: string;
  /** The index (or web provider) that produced this record. */
  readonly source: string;
}

export interface PaperSearchAnswer {
  readonly query: string;
  readonly mode: "topic" | "lookup";
  readonly route: WebSearchRoute;
  /** The index(es) whose records are listed, in the order they answered. */
  readonly providers: readonly string[];
  readonly papers: readonly PaperRecord[];
  readonly total?: number;
  readonly cached?: boolean;
  /** Per index: the requested options it applied. */
  readonly applied?: Readonly<Record<string, readonly string[]>>;
  /** Requested options no answering index could apply, with the reason. */
  readonly notApplied?: readonly string[];
  readonly notes?: readonly string[];
  readonly engineFailures?: readonly WebSearchEngineFailure[];
}

export type PaperDetailPart = "abstract" | "references" | "citations" | "related";

export const PAPER_DETAIL_PARTS: readonly PaperDetailPart[] = [
  "abstract",
  "references",
  "citations",
  "related",
];

export interface PaperDetailsQuery {
  /** DOIs, arXiv IDs, PMID:/PMCID:, Semantic Scholar or OpenAlex IDs, or doi.org/arxiv.org URLs. */
  readonly ids: readonly string[];
  readonly include?: readonly PaperDetailPart[];
  /** Ceiling per list (references, citations, related). */
  readonly limit?: number;
  /**
   * Resolve through exactly these indexes, in this order (the host's own
   * literature retrieval). Absent: the deployment's paper-details route.
   */
  readonly sources?: readonly Exclude<PaperSource, "web">[];
}

export interface PaperDetailsEntry extends PaperRecord {
  /** The identifier exactly as the model gave it. */
  readonly requested: string;
  readonly references?: readonly PaperRecord[];
  readonly citedBy?: readonly PaperRecord[];
  readonly related?: readonly PaperRecord[];
}

export interface PaperDetailsAnswer {
  readonly papers: readonly PaperDetailsEntry[];
  /** Requested identifiers no index could resolve. */
  readonly notFound: readonly string[];
  readonly providers: readonly string[];
  readonly cached?: boolean;
  readonly notes?: readonly string[];
}

/** What the launch check (or live traffic) concluded about one source. */
export type WebSourceState =
  | "available"
  | "degraded"
  | "blocked"
  | "unreachable"
  | "needs-key"
  | "not-configured"
  | "unchecked";

export interface WebSourceStatus {
  readonly id: string;
  readonly state: WebSourceState;
  readonly detail?: string;
  /** Epoch ms of the last check. */
  readonly checkedAt?: number;
  /** Epoch ms until which a blocked source stays in cool-down. */
  readonly until?: number;
  /** For a metasearch provider: the state of each engine. */
  readonly engines?: readonly WebSourceStatus[];
}

export interface WebFetchQuery {
  /** Public http(s) URL, verbatim from the model. */
  readonly url: string;
  /** Ceiling on returned characters; the fetcher clamps it to its bounds. */
  readonly maxChars?: number;
}

/** The readable rendition of one fetched page, as delivered to the model. */
export interface WebFetchAnswer {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  /** The exact text handed to the model (post-truncation). */
  readonly text: string;
  readonly truncated: boolean;
  readonly fetchedBytes: number;
}

/**
 * Who is asking, for the unified log. Everything optional: a probe or a test
 * has no run behind it, and the log then records the call without attribution.
 */
export interface WebAccessCallContext {
  readonly signal?: AbortSignal;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly nodePath?: string;
}

/**
 * One row of the unified web log (`searches.jsonl`): the FULL record of one
 * web_search or web_fetch call — the verbatim request, the verbatim payload
 * the model received, and the operational facts around it. This is the
 * fidelity contract: what the model asked and what it heard back are logged
 * character for character. (A fetch's raw HTML is transport, not what the
 * model heard; the record carries the delivered text plus the byte count.)
 *
 * The record is append-only observability, never load-bearing: nothing reads
 * it back into the run, and a failed append never fails a call.
 */
export interface WebAccessLogRecord {
  /** Unique within the run; rows and future tables key on it. */
  readonly id: string;
  /** Epoch ms when the call entered the manager. */
  readonly at: number;
  readonly tool:
    | "web_search"
    | "news_search"
    | "paper_search"
    | "paper_details"
    | "web_fetch"
    | "web_check";
  /**
   * How the call was answered:
   * - "ok"        — a provider answered;
   * - "cached"    — served from the manager's cache, no network;
   * - "coalesced" — joined an identical in-flight call (names it);
   * - "error"     — every lane failed; `error` says why.
   */
  readonly outcome: "ok" | "cached" | "coalesced" | "error";
  /** The tool input, verbatim. */
  readonly request: JsonObject;
  /** The exact payload delivered to the model (or absent on error). */
  readonly response?: JsonValue;
  /** The provider that answered, after any failover. */
  readonly provider?: string;
  /** Providers tried and failed before the answer (or before giving up). */
  readonly failedProviders?: readonly { readonly provider: string; readonly error: string }[];
  readonly error?: string;
  readonly elapsedMs: number;
  /** The record whose in-flight call this one joined (outcome "coalesced"). */
  readonly coalescedWith?: string;
  /** The manager's cache key for this call, for cross-run correlation. */
  readonly cacheKey?: string;
  /** The coordinator's route for a search call. */
  readonly route?: WebSearchRoute;
  /** Metasearch calls: the engines the coordinator asked. */
  readonly engines?: readonly string[];
  /**
   * True when the answering provider's terms forbid keeping its results:
   * `response` then holds only the result count and one SHA-256 per URL.
   */
  readonly redacted?: boolean;
  /** Metered cost of this call in USD (paid providers only). */
  readonly costUsd?: number;
  /** Attribution, when the caller supplied one. */
  readonly taskId?: string;
  readonly agentId?: string;
  readonly nodePath?: string;
}

/** Where the manager writes its records. Must never throw. */
export type WebAccessLogSink = (record: WebAccessLogRecord) => void;

/**
 * The one interface every execution backend receives. Both SDK executors
 * bridge it as in-process tools, and the Messages-path registry wraps it as
 * ordinary host tools — so the model-facing surface is identical everywhere.
 */
export interface WebAccess {
  search(query: WebSearchQuery, context?: WebAccessCallContext): Promise<WebSearchAnswer>;
  fetch(query: WebFetchQuery, context?: WebAccessCallContext): Promise<WebFetchAnswer>;
  /**
   * Which kinds have at least one configured provider behind them, for
   * honest tool descriptions and readiness reporting. Fetch needs no
   * provider — outbound HTTP is its own backing.
   */
  backedKinds(): readonly WebSearchKind[];
  /** Papers by title or topic, over the scholarly indexes (and the web). */
  searchPapers?(query: PaperSearchQuery, context?: WebAccessCallContext): Promise<PaperSearchAnswer>;
  /** Metadata, and optionally references, citations and related papers, by identifier. */
  paperDetails?(query: PaperDetailsQuery, context?: WebAccessCallContext): Promise<PaperDetailsAnswer>;
  /** The current availability of every configured source, for tools and readiness. */
  status?(): readonly WebSourceStatus[];
  /** Whether a scholarly index backs paper_search and paper_details. */
  backsPapers?(): boolean;
}
