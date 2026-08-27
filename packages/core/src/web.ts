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
  readonly tool: "web_search" | "web_fetch";
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
}
