/**
 * Pure helpers behind the coordinator's paper routes (paper_search,
 * paper_details): option normalization, lookup-vs-topic classification,
 * web-hit conversion, multi-index merging, and log redaction for providers
 * whose terms forbid keeping results.
 */
import { createHash } from "node:crypto";

import type {
  PaperRecord,
  PaperSearchQuery,
  PaperSort,
  PaperSource,
  PaperType,
  WebSearchAnswer,
  WebSearchHit,
} from "@brainstorm-agentic/core";
import { PAPER_SORTS, PAPER_SOURCES, PAPER_TYPES } from "@brainstorm-agentic/core";

import {
  identifierFromUrl,
  normalizeTitle,
  type NormalizedPaperQuery,
  type PaperOption,
} from "./scholarly.js";

export const PAPER_MAX_RESULTS = 25;
export const PAPER_DEFAULT_RESULTS = 10;
export const PAPER_MAX_PAGE = 10;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY or YYYY-MM-DD date as a day; `end` picks Dec 31 for a bare year. */
export function dayOf(value: string | undefined, end: boolean): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (/^\d{4}$/.test(text)) return end ? `${text}-12-31` : `${text}-01-01`;
  if (/^\d{4}-\d{2}$/.test(text)) {
    if (!end) return `${text}-01`;
    const [year, month] = text.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${text}-${String(last).padStart(2, "0")}`;
  }
  return DAY.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00Z`)) ? text : undefined;
}

/**
 * Whether a free-text paper query is a known paper's TITLE (lookup) rather
 * than a topic: quoted, or title-cased with enough words, or a "Title: Sub"
 * pattern. Agents can always say so explicitly with mode.
 */
export function classifyPaperMode(query: string): "lookup" | "topic" {
  const text = query.trim();
  if (/^".+"$/.test(text)) return "lookup";
  if (/[?]|\b(AND|OR|NOT)\b/.test(text)) return "topic";
  const words = text.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
  if (words.length < 4) return "topic";
  const minor = new Set([
    "a", "an", "the", "of", "for", "and", "or", "in", "on", "to", "with", "via", "by",
    "from", "at", "as", "is", "are", "its", "into", "over", "under", "without", "using",
  ]);
  const content = words.filter((word) => !minor.has(word.toLowerCase()));
  if (content.length === 0) return "topic";
  const capitalized = content.filter((word) => /^[A-Z0-9]/.test(word)).length;
  if (/^[^:]{3,}:\s+\S/.test(text) && capitalized / content.length >= 0.4) return "lookup";
  return capitalized / content.length >= 0.7 ? "lookup" : "topic";
}

/** True when any option narrows beyond plain relevance search. */
export function hasStructuredOptions(query: NormalizedPaperQuery): boolean {
  return (
    query.titleContains.length > 0 ||
    query.abstractContains.length > 0 ||
    query.authors.length > 0 ||
    query.dateFrom !== undefined ||
    query.dateTo !== undefined ||
    query.arxivCategories.length > 0 ||
    query.fieldsOfStudy.length > 0 ||
    query.venues.length > 0 ||
    query.types.length > 0 ||
    query.openAccessOnly ||
    query.minCitations !== undefined ||
    query.sort !== "relevance"
  );
}

/** The options the agent actually set, by tool-parameter name. */
export function requestedOptions(query: NormalizedPaperQuery, native: boolean): PaperOption[] {
  const out: PaperOption[] = [];
  if (query.query.trim() !== "") out.push("query");
  if (query.titleContains.length > 0) out.push("title_contains");
  if (query.abstractContains.length > 0) out.push("abstract_contains");
  if (query.authors.length > 0) out.push("authors");
  if (query.dateFrom !== undefined || query.dateTo !== undefined) out.push("date_range");
  if (query.arxivCategories.length > 0) out.push("arxiv_categories");
  if (query.fieldsOfStudy.length > 0) out.push("fields_of_study");
  if (query.venues.length > 0) out.push("venues");
  if (query.types.length > 0) out.push("types");
  if (query.openAccessOnly) out.push("open_access_only");
  if (query.minCitations !== undefined) out.push("min_citations");
  if (query.sort !== "relevance") out.push("sort");
  if (query.page > 1) out.push("page");
  if (native) out.push("native_query");
  return out;
}

export interface NormalizedPaperRequest {
  readonly query: NormalizedPaperQuery;
  readonly sources?: readonly PaperSource[];
  readonly native?: { readonly source: Exclude<PaperSource, "web">; readonly query: string };
}

function strings(values: readonly string[] | undefined, max = 20): string[] {
  return (values ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .slice(0, max);
}

/**
 * Validates and normalizes a paper search. Throws with a message the model
 * can act on when an option is malformed; never guesses a date.
 */
export function normalizePaperQuery(query: PaperSearchQuery): NormalizedPaperRequest {
  const text = typeof query.query === "string" ? query.query.trim() : "";
  if (text === "" && query.native === undefined) {
    throw new Error("query must be a non-empty string (or give native_query).");
  }
  const dateFrom = query.dateFrom !== undefined ? dayOf(query.dateFrom, false) : undefined;
  const dateTo = query.dateTo !== undefined ? dayOf(query.dateTo, true) : undefined;
  if (query.dateFrom !== undefined && dateFrom === undefined) {
    throw new Error(`date_from "${query.dateFrom}" is not a date: use YYYY or YYYY-MM-DD.`);
  }
  if (query.dateTo !== undefined && dateTo === undefined) {
    throw new Error(`date_to "${query.dateTo}" is not a date: use YYYY or YYYY-MM-DD.`);
  }
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
    throw new Error(`the date window is empty: ${dateFrom} is after ${dateTo}.`);
  }
  const sort: PaperSort = (PAPER_SORTS as readonly string[]).includes(query.sort ?? "")
    ? (query.sort as PaperSort)
    : "relevance";
  const types = (query.types ?? []).filter((type): type is PaperType =>
    (PAPER_TYPES as readonly string[]).includes(type),
  );
  const sources = (query.sources ?? []).filter((source): source is PaperSource =>
    (PAPER_SOURCES as readonly string[]).includes(source),
  );
  const maxResults = Math.min(
    PAPER_MAX_RESULTS,
    Math.max(1, Math.trunc(query.maxResults ?? PAPER_DEFAULT_RESULTS)),
  );
  const page = Math.min(PAPER_MAX_PAGE, Math.max(1, Math.trunc(query.page ?? 1)));
  const mode =
    query.mode === "lookup" || query.mode === "topic"
      ? query.mode
      : classifyPaperMode(text);
  const normalized: NormalizedPaperQuery = {
    query: text.replace(/^"(.+)"$/, "$1"),
    mode,
    titleContains: strings(query.titleContains),
    abstractContains: strings(query.abstractContains),
    authors: strings(query.authors, 10),
    ...(dateFrom !== undefined ? { dateFrom } : {}),
    ...(dateTo !== undefined ? { dateTo } : {}),
    arxivCategories: strings(query.arxivCategories),
    fieldsOfStudy: strings(query.fieldsOfStudy),
    venues: strings(query.venues, 10),
    types,
    openAccessOnly: query.openAccessOnly === true,
    ...(typeof query.minCitations === "number" && query.minCitations > 0
      ? { minCitations: Math.trunc(query.minCitations) }
      : {}),
    sort,
    maxResults,
    page,
  };
  return {
    query: normalized,
    ...(sources.length > 0 ? { sources } : {}),
    ...(query.native !== undefined && typeof query.native.query === "string" && query.native.query.trim() !== ""
      ? { native: { source: query.native.source, query: query.native.query.trim() } }
      : {}),
  };
}

/** A stable identity for merging the same paper across indexes. */
export function paperKey(paper: PaperRecord): string {
  if (paper.doi !== undefined) return `doi:${paper.doi.toLowerCase()}`;
  if (paper.arxivId !== undefined) return `arxiv:${paper.arxivId.toLowerCase()}`;
  if (paper.pmid !== undefined) return `pmid:${paper.pmid}`;
  if (paper.semanticScholarId !== undefined) return `s2:${paper.semanticScholarId}`;
  if (paper.openAlexId !== undefined) return `oa:${paper.openAlexId}`;
  return `title:${normalizeTitle(paper.title)}`;
}

/**
 * Merges ranked lists from several indexes: interleaved by rank (one from
 * each list in turn), duplicates dropped, the first record of a paper kept.
 */
export function mergePaperLists(lists: readonly (readonly PaperRecord[])[], max: number): PaperRecord[] {
  const seen = new Set<string>();
  const out: PaperRecord[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let rank = 0; rank < longest && out.length < max; rank += 1) {
    for (const list of lists) {
      const paper = list[rank];
      if (paper === undefined) continue;
      const key = paperKey(paper);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(paper);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** A web hit as a paper record (before any metadata resolution). */
export function recordFromHit(hit: WebSearchHit): PaperRecord {
  const id = identifierFromUrl(hit.url);
  return {
    title: hit.title,
    url: hit.url,
    ...(hit.authors !== undefined ? { authors: hit.authors } : {}),
    ...(hit.year !== undefined ? { year: hit.year } : {}),
    ...(hit.published !== undefined && /^\d{4}-\d{2}-\d{2}/.test(hit.published)
      ? { date: hit.published.slice(0, 10) }
      : {}),
    ...(hit.venue !== undefined ? { venue: hit.venue } : {}),
    ...(hit.doi !== undefined
      ? { doi: hit.doi.toLowerCase() }
      : id?.kind === "doi"
        ? { doi: id.value }
        : {}),
    ...(id?.kind === "arxiv" ? { arxivId: id.value } : {}),
    ...(id?.kind === "pmid" ? { pmid: id.value } : {}),
    ...(id?.kind === "pmcid" ? { pmcid: id.value } : {}),
    ...(hit.citations !== undefined ? { citations: hit.citations } : {}),
    ...(hit.snippet !== "" ? { abstract: hit.snippet } : {}),
    source: hit.source,
  };
}

/** SHA-256 of a URL: lets a later audit match a citation without keeping the result. */
export function urlHash(url: string): string {
  return createHash("sha256").update(url.trim()).digest("hex");
}

/**
 * What the log keeps of an answer from a provider whose terms forbid storing
 * results: the result count and one hash per URL, nothing else.
 */
export function redactedWebAnswer(answer: WebSearchAnswer): Record<string, unknown> {
  return {
    query: answer.query,
    kind: answer.kind,
    provider: answer.provider,
    redacted: true,
    resultCount: answer.results.length,
    urlSha256: answer.results.map((hit) => urlHash(hit.url)),
    ...(answer.route !== undefined ? { route: answer.route } : {}),
  };
}

/** The same redaction for paper records from such a provider. */
export function redactPapers(papers: readonly PaperRecord[], sources: ReadonlySet<string>): unknown[] {
  return papers.map((paper) =>
    sources.has(paper.source)
      ? { redacted: true, source: paper.source, urlSha256: urlHash(paper.url) }
      : paper,
  );
}
