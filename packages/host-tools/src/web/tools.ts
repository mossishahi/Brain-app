/**
 * The unified web tools over one WebAccess.
 *
 * These are the ONLY model-facing web tools in the pipeline: the Messages
 * path registers them in its tool registry, and both agent-SDK executors
 * bridge the same specs as in-process tools — so an agent sees the
 * identical search surface whichever backend runs it, and every call lands
 * in the same manager (and therefore the same log and the same per-run
 * coordination of every agent's searches).
 *
 * `webToolSpecs` is the single source: one definition (from the manifests)
 * and one `run` per tool. Executors convert the JSON Schema to their SDK's
 * format; nothing here is restated per backend. A tool is offered only
 * when something on this deployment can answer it.
 */
import {
  PAPER_DETAIL_PARTS,
  PAPER_SORTS,
  PAPER_TYPES,
  type HostToolManifest,
  type JsonValue,
  type PaperDetailPart,
  type PaperDetailsQuery,
  type PaperSearchQuery,
  type PaperSort,
  type PaperSource,
  type PaperType,
  type Tool,
  type ToolResult,
  type WebAccess,
  type WebAccessCallContext,
  type WebFetchQuery,
  type WebSearchKind,
  type WebSearchQuery,
} from "@brainstorm-agentic/core";

import {
  FIELDS_OF_STUDY,
  NEWS_SEARCH_MANIFEST,
  PAPER_DETAILS_MANIFEST,
  PAPER_SEARCH_MANIFEST,
  WEB_FETCH_MANIFEST,
  WEB_SEARCH_MANIFEST,
} from "../web-search.js";
import { WebAccessError } from "./manager.js";

export const WEB_ACCESS_TOOL_NAMES = [
  "web_search",
  "web_fetch",
  "news_search",
  "paper_search",
  "paper_details",
] as const;

export type WebAccessToolName = (typeof WEB_ACCESS_TOOL_NAMES)[number];

function inputRecord(value: JsonValue): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function refusal(message: string): ToolResult {
  return { output: message, isError: true };
}

/** An input the model can correct: the message says how. */
function invalid(message: string): never {
  throw new WebAccessError(message);
}

function textOf(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function intOf(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** A string list (a bare string counts as one entry), trimmed and capped. */
function listOf(value: JsonValue | undefined, max: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return list.length > 0 ? list.slice(0, max) : undefined;
}

const RECENCIES = ["day", "week", "month", "year"] as const;
type Recency = (typeof RECENCIES)[number];

function dayOf(name: string, value: JsonValue | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`))) {
    return invalid(`${name} must be a day written YYYY-MM-DD, got ${JSON.stringify(value)}.`);
  }
  return text;
}

/**
 * The web_search / news_search input. Out-of-range values the schema
 * already states are clamped by the manager; malformed ones are refused
 * with the correction, never silently dropped.
 */
export function parseWebSearchInput(input: JsonValue, kind?: WebSearchKind): WebSearchQuery {
  const args = inputRecord(input);
  const query = textOf(args.query);
  if (query === undefined) return invalid("query must be a non-empty string.");
  // An older caller's kind is honoured; the tools themselves fix it.
  const legacyKind =
    args.kind === "general" || args.kind === "scholarly" || args.kind === "news" ? args.kind : undefined;
  const effectiveKind = kind ?? legacyKind;
  let recency: Recency | undefined;
  if (args.recency !== undefined && args.recency !== null) {
    if (!(RECENCIES as readonly JsonValue[]).includes(args.recency)) {
      return invalid(`recency must be one of ${RECENCIES.join(", ")}.`);
    }
    recency = args.recency as Recency;
  }
  const dateFrom = dayOf("date_from", args.date_from);
  const dateTo = dayOf("date_to", args.date_to);
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
    return invalid(`the date range is empty: date_from ${dateFrom} is after date_to ${dateTo}.`);
  }
  const include = listOf(args.include_domains ?? args.domains, 10);
  const exclude = listOf(args.exclude_domains, 10);
  const languageText = textOf(args.language);
  if (languageText !== undefined && !/^[a-z]{2,3}(-[a-z]{2})?$/i.test(languageText)) {
    return invalid(`language must be an ISO 639-1 code such as "en", got "${languageText}".`);
  }
  const countryText = textOf(args.country);
  if (countryText !== undefined && !/^[a-z]{2}$/i.test(countryText)) {
    return invalid(`country must be an ISO 3166-1 alpha-2 code such as "DE", got "${countryText}".`);
  }
  const fileText = kind === "news" ? undefined : textOf(args.file_type)?.replace(/^\./, "");
  if (fileText !== undefined && !/^[a-z0-9]{1,8}$/i.test(fileText)) {
    return invalid(`file_type must be a file extension such as "pdf", got "${fileText}".`);
  }
  const page = intOf(args.page);
  const maxResults = intOf(args.max_results);
  return {
    query,
    ...(effectiveKind !== undefined ? { kind: effectiveKind } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(page !== undefined && page > 1 ? { page: Math.min(5, page) } : {}),
    ...(recency !== undefined ? { recency } : {}),
    ...(dateFrom !== undefined ? { dateFrom } : {}),
    ...(dateTo !== undefined ? { dateTo } : {}),
    ...(include !== undefined ? { domains: include } : {}),
    ...(exclude !== undefined ? { excludeDomains: exclude } : {}),
    ...(languageText !== undefined
      ? { language: languageText.replace(/^([a-z]+)/i, (primary) => primary.toLowerCase()) }
      : {}),
    ...(countryText !== undefined ? { country: countryText.toUpperCase() } : {}),
    ...(fileText !== undefined ? { fileType: fileText.toLowerCase() } : {}),
  };
}

const TOOL_SOURCES: Readonly<Record<string, PaperSource>> = {
  arxiv: "arxiv",
  openalex: "openalex",
  crossref: "crossref",
  semantic_scholar: "semantic-scholar",
  "semantic-scholar": "semantic-scholar",
  semanticscholar: "semantic-scholar",
  web: "web",
};

function sourceOf(name: string, value: string): PaperSource {
  const source = TOOL_SOURCES[value.toLowerCase()];
  if (source === undefined) {
    return invalid(`${name}: unknown source "${value}"; use arxiv, openalex, crossref, semantic_scholar or web.`);
  }
  return source;
}

/** The day N whole years before today (UTC). */
function yearsAgo(years: number, now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

/**
 * The paper_search input. Tool names use underscores (most_cited,
 * journal_article, semantic_scholar); the core vocabulary uses hyphens.
 * Dates may be given as years, days, or "the last N years".
 */
export function parsePaperSearchInput(input: JsonValue, now: Date = new Date()): PaperSearchQuery {
  const args = inputRecord(input);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  let mode: PaperSearchQuery["mode"];
  if (args.mode !== undefined && args.mode !== null) {
    if (args.mode !== "auto" && args.mode !== "topic" && args.mode !== "lookup") {
      return invalid('mode must be "auto", "topic" or "lookup".');
    }
    mode = args.mode;
  }
  const yearFrom = intOf(args.year_from);
  const yearTo = intOf(args.year_to);
  const lastYears = intOf(args.last_years);
  if (lastYears !== undefined && lastYears < 1) return invalid("last_years must be at least 1.");
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    return invalid(`the year range is empty: year_from ${yearFrom} is after year_to ${yearTo}.`);
  }
  // date_from wins; otherwise the later of year_from and last_years.
  const fromCandidates = [
    ...(yearFrom !== undefined ? [`${yearFrom}-01-01`] : []),
    ...(lastYears !== undefined ? [yearsAgo(lastYears, now)] : []),
  ].sort();
  const dateFrom = textOf(args.date_from) ?? fromCandidates[fromCandidates.length - 1];
  const dateTo = textOf(args.date_to) ?? (yearTo !== undefined ? String(yearTo) : undefined);

  const sources = listOf(args.sources, 5)?.map((value) => sourceOf("sources", value));
  const fields = listOf(args.fields_of_study, 10)?.map((value) => {
    const match = FIELDS_OF_STUDY.find((field) => field.toLowerCase() === value.toLowerCase());
    return match ?? invalid(`fields_of_study: "${value}" is not a Semantic Scholar field; use one of ${FIELDS_OF_STUDY.join(", ")}.`);
  });
  const types = listOf(args.types, 8)?.map((value) => {
    const type = value.toLowerCase().replace(/_/g, "-");
    return (PAPER_TYPES as readonly string[]).includes(type)
      ? (type as PaperType)
      : invalid(`types: unknown type "${value}"; use ${PAPER_TYPES.map((entry) => entry.replace(/-/g, "_")).join(", ")}.`);
  });
  let sort: PaperSort | undefined;
  if (args.sort !== undefined && args.sort !== null) {
    const value = typeof args.sort === "string" ? args.sort.toLowerCase().replace(/_/g, "-") : "";
    if (!(PAPER_SORTS as readonly string[]).includes(value)) {
      return invalid('sort must be "relevance", "newest", "oldest" or "most_cited".');
    }
    sort = value as PaperSort;
  }
  const minCitations = intOf(args.min_citations);
  let native: PaperSearchQuery["native"];
  if (args.native_query !== undefined && args.native_query !== null) {
    const nativeArgs = inputRecord(args.native_query);
    const nativeSource = sourceOf("native_query.source", typeof nativeArgs.source === "string" ? nativeArgs.source : "");
    if (nativeSource === "web") return invalid("native_query.source must be arxiv, openalex, crossref or semantic_scholar.");
    const nativeText = textOf(nativeArgs.query);
    if (nativeText === undefined) return invalid("native_query.query must be a non-empty string.");
    native = { source: nativeSource, query: nativeText };
  }
  if (query === "" && native === undefined) {
    return invalid("query must be a non-empty string (or give native_query).");
  }
  const titleContains = listOf(args.title_contains, 10);
  const abstractContains = listOf(args.abstract_contains, 10);
  const authors = listOf(args.authors, 10);
  const categories = listOf(args.arxiv_categories, 10);
  const venues = listOf(args.venues, 10);
  const maxResults = intOf(args.max_results);
  const page = intOf(args.page);
  return {
    query,
    ...(mode !== undefined ? { mode } : {}),
    ...(titleContains !== undefined ? { titleContains } : {}),
    ...(abstractContains !== undefined ? { abstractContains } : {}),
    ...(authors !== undefined ? { authors } : {}),
    ...(dateFrom !== undefined ? { dateFrom } : {}),
    ...(dateTo !== undefined ? { dateTo } : {}),
    ...(sources !== undefined ? { sources: [...new Set(sources)] } : {}),
    ...(categories !== undefined ? { arxivCategories: categories } : {}),
    ...(fields !== undefined ? { fieldsOfStudy: fields } : {}),
    ...(venues !== undefined ? { venues } : {}),
    ...(types !== undefined ? { types } : {}),
    ...(args.open_access_only === true ? { openAccessOnly: true } : {}),
    ...(minCitations !== undefined && minCitations > 0 ? { minCitations } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(native !== undefined ? { native } : {}),
  };
}

/** The paper_details input. */
export function parsePaperDetailsInput(input: JsonValue): PaperDetailsQuery {
  const args = inputRecord(input);
  const ids = listOf(args.ids, 20);
  if (ids === undefined) {
    return invalid("ids must list at least one DOI, arXiv ID, PMID, PMCID, Semantic Scholar or OpenAlex ID.");
  }
  const include = listOf(args.include, 4)?.map((value) => {
    const part = value.toLowerCase();
    return (PAPER_DETAIL_PARTS as readonly string[]).includes(part)
      ? (part as PaperDetailPart)
      : invalid(`include: unknown part "${value}"; use ${PAPER_DETAIL_PARTS.join(", ")}.`);
  });
  const limit = intOf(args.limit);
  return {
    ids,
    ...(include !== undefined ? { include: [...new Set(include)] } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/** The web_fetch input. */
export function parseWebFetchInput(input: JsonValue): WebFetchQuery {
  const args = inputRecord(input);
  const url = textOf(args.url);
  if (url === undefined) return invalid("url must be a non-empty string.");
  const maxChars = intOf(args.max_chars);
  return { url, ...(maxChars !== undefined ? { maxChars } : {}) };
}

/** One model-facing web tool: its definition and how to run a call. */
export interface WebToolSpec {
  readonly name: WebAccessToolName;
  readonly definition: HostToolManifest["definition"];
  /**
   * Runs one call. Resolves to the model-facing answer; an input or a
   * refusal the model should hear rejects with WebAccessError.
   */
  run(input: JsonValue, context?: WebAccessCallContext): Promise<unknown>;
}

/**
 * The web tools this WebAccess can actually answer, in a stable order:
 * web_search and news_search need a provider behind their route,
 * paper_search needs a scholarly index or a web provider, paper_details a
 * scholarly index; web_fetch needs nothing.
 */
export function webToolSpecs(web: WebAccess): readonly WebToolSpec[] {
  const kinds = web.backedKinds();
  const indexes = web.backsPapers?.() ?? kinds.includes("scholarly");
  const specs: WebToolSpec[] = [];
  if (kinds.includes("general")) {
    specs.push({
      name: "web_search",
      definition: WEB_SEARCH_MANIFEST.definition,
      async run(input, context) {
        return web.search(parseWebSearchInput(input), context);
      },
    });
  }
  specs.push({
    name: "web_fetch",
    definition: WEB_FETCH_MANIFEST.definition,
    async run(input, context) {
      return web.fetch(parseWebFetchInput(input), context);
    },
  });
  if (kinds.includes("news")) {
    specs.push({
      name: "news_search",
      definition: NEWS_SEARCH_MANIFEST.definition,
      async run(input, context) {
        return web.search(parseWebSearchInput(input, "news"), context);
      },
    });
  }
  const searchPapers = web.searchPapers?.bind(web);
  if (searchPapers !== undefined && (indexes || kinds.includes("general"))) {
    specs.push({
      name: "paper_search",
      definition: PAPER_SEARCH_MANIFEST.definition,
      async run(input, context) {
        return searchPapers(parsePaperSearchInput(input), context);
      },
    });
  }
  const paperDetails = web.paperDetails?.bind(web);
  if (paperDetails !== undefined && indexes) {
    specs.push({
      name: "paper_details",
      definition: PAPER_DETAILS_MANIFEST.definition,
      async run(input, context) {
        return paperDetails(parsePaperDetailsInput(input), context);
      },
    });
  }
  return specs;
}

/** The names webToolSpecs offers over this WebAccess. */
export function webToolNames(web: WebAccess): readonly WebAccessToolName[] {
  return webToolSpecs(web).map((spec) => spec.name);
}

/**
 * The web tools as registry Tools over a WebAccess. `attribution` (task,
 * agent, node path) is supplied per registration site where known.
 */
export function webAccessTools(
  web: WebAccess,
  attribution: Omit<WebAccessCallContext, "signal"> = {},
): readonly Tool[] {
  return webToolSpecs(web).map(
    (spec): Tool => ({
      definition: spec.definition,
      async execute(input, context): Promise<ToolResult> {
        try {
          const answer = await spec.run(input, { ...attribution, signal: context.signal });
          return { output: answer as JsonValue };
        } catch (error) {
          if (context.signal?.aborted) throw error;
          if (error instanceof WebAccessError) return refusal(error.message);
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  );
}
