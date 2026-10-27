/**
 * Scholarly backends for paper_search and paper_details.
 *
 * Each backend maps the provider-neutral paper options onto ONE index's own
 * parameters, applies what that index can apply, and REPORTS what it applied,
 * so the agent learns exactly which of its filters held where:
 *
 * - arXiv: field prefixes (ti:, abs:, au:, cat:), boolean operators and the
 *   submittedDate range in `search_query`; relevance or date sorting.
 * - OpenAlex: `search` plus `filter` (title.search, abstract.search,
 *   raw_author_name.search, publication dates, type, open access, citation
 *   counts); sort by relevance, date or citations. Needs an API key.
 * - Crossref: query.bibliographic / query.author / query.container-title
 *   plus filters (publication dates, type); sort by relevance, date or
 *   citations. A contact email joins the polite pool.
 * - Semantic Scholar: relevance search with year/date, fields of study,
 *   venue, publication types, open-access and citation filters; title match
 *   for known papers; bulk search for date/citation sorting and boolean
 *   queries; batch lookup, references, citations and recommendations.
 *
 * Anything an index cannot apply at the source is enforced afterwards on the
 * normalized records where the record carries the fact (title words,
 * authors, dates, types, citation counts); otherwise it is reported as not
 * applied. Nothing is ever silently dropped.
 */
import type {
  PaperDetailPart,
  PaperDetailsEntry,
  PaperRecord,
  PaperSearchQuery,
  PaperSort,
  PaperType,
  WebSourceStatus,
} from "@brainstorm-agentic/core";

import {
  abstractFromInvertedIndex,
  asNumber,
  asString,
  cleanSnippet,
  record,
  requestJson,
  requestText,
  ProviderRequestError,
  type ProviderFetch,
} from "./providers.js";
import {
  ARXIV_PROBE_TIMEOUT_MS,
  loggingFetch,
  probeStateFromError,
  runProbe,
  type WebSourceStatusWithLog,
} from "./probe.js";
import { htmlToText } from "../web-search.js";

export type PaperBackendId =
  | "arxiv"
  | "openalex"
  | "crossref"
  | "semantic-scholar"
  | "europepmc"
  | "core"
  | "opencitations";

/** The paper options, normalized: dates are YYYY-MM-DD, counts are bounded. */
export interface NormalizedPaperQuery {
  readonly query: string;
  readonly mode: "topic" | "lookup";
  readonly titleContains: readonly string[];
  readonly abstractContains: readonly string[];
  readonly authors: readonly string[];
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly arxivCategories: readonly string[];
  readonly fieldsOfStudy: readonly string[];
  readonly venues: readonly string[];
  readonly types: readonly PaperType[];
  readonly openAccessOnly: boolean;
  readonly minCitations?: number;
  readonly sort: PaperSort;
  readonly maxResults: number;
  readonly page: number;
  /** A query in THIS backend's own syntax, when the agent supplied one. */
  readonly native?: string;
}

/** Option names as the agent sees them (tool parameter names). */
export type PaperOption =
  | "query"
  | "title_contains"
  | "abstract_contains"
  | "authors"
  | "date_range"
  | "arxiv_categories"
  | "fields_of_study"
  | "venues"
  | "types"
  | "open_access_only"
  | "min_citations"
  | "sort"
  | "page"
  | "native_query";

export interface PaperBackendAnswer {
  readonly papers: readonly PaperRecord[];
  readonly total?: number;
  /** Options the index applied at the source. */
  readonly applied: readonly PaperOption[];
  /** Options the index cannot apply, with the reason. */
  readonly unsupported: readonly { readonly option: PaperOption; readonly reason: string }[];
}

/** One identifier from paper_details, classified. */
export interface PaperIdentifier {
  /** Exactly as the model gave it. */
  readonly raw: string;
  readonly kind: "doi" | "arxiv" | "pmid" | "pmcid" | "s2" | "corpus" | "openalex";
  /** The canonical value (DOI lower-cased, arXiv without version, ...). */
  readonly value: string;
}

export interface PaperBackend {
  readonly id: PaperBackendId;
  /** Politeness floor between two requests, ms. */
  readonly minIntervalMs?: number;
  /** Requests this upstream may have in flight at once; absent = the run's per-source bound. */
  readonly maxConcurrent?: number;
  /** Whether the backend can run at all (e.g. OpenAlex needs a key). */
  readonly ready: { readonly ok: true } | { readonly ok: false; readonly reason: string };
  search(query: NormalizedPaperQuery, signal?: AbortSignal): Promise<PaperBackendAnswer>;
  /** Resolves identifiers this backend understands; others are skipped. */
  details?(
    ids: readonly PaperIdentifier[],
    parts: ReadonlySet<PaperDetailPart>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, PaperDetailsEntry>>;
  /** One known-answer request for the launch check, with the log lines it produced. */
  check?(signal?: AbortSignal): Promise<WebSourceStatusWithLog>;
}

/* ------------------------------------------------------------------------ */
/* Identifiers, titles, and record helpers                                   */
/* ------------------------------------------------------------------------ */

const NEW_ARXIV = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const OLD_ARXIV = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;

/** Classifies one paper_details identifier; undefined when unrecognized. */
export function parsePaperIdentifier(raw: string): PaperIdentifier | undefined {
  let text = raw.trim();
  if (text === "") return undefined;
  const urlMatch = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(text);
  if (urlMatch) text = decodeURIComponent(urlMatch[1]!);
  const arxivUrl = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?\/?(?:[?#].*)?$/i.exec(text);
  if (arxivUrl) text = `arXiv:${arxivUrl[1]!}`;
  const pubmedUrl = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i.exec(text);
  if (pubmedUrl) text = `PMID:${pubmedUrl[1]!}`;
  const openalexUrl = /^https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?(W\d+)/i.exec(text);
  if (openalexUrl) text = openalexUrl[1]!;
  const s2Url = /^https?:\/\/(?:www\.)?semanticscholar\.org\/paper\/(?:[^/]+\/)?([0-9a-f]{40})/i.exec(text);
  if (s2Url) text = s2Url[1]!;

  const doi = /^(?:doi:\s*)?(10\.\d{4,9}\/\S+)$/i.exec(text);
  if (doi) return { raw, kind: "doi", value: doi[1]!.replace(/[.,;]+$/, "").toLowerCase() };
  const arxiv = /^(?:arxiv:\s*)?(.+)$/i.exec(text);
  if (arxiv) {
    const candidate = arxiv[1]!.trim();
    const modern = NEW_ARXIV.exec(candidate);
    if (modern) return { raw, kind: "arxiv", value: modern[1]! };
    const legacy = OLD_ARXIV.exec(candidate);
    if (legacy) return { raw, kind: "arxiv", value: legacy[1]! };
  }
  const pmid = /^pmid:\s*(\d+)$/i.exec(text);
  if (pmid) return { raw, kind: "pmid", value: pmid[1]! };
  const pmcid = /^(?:pmcid:\s*)?(pmc\d+)$/i.exec(text);
  if (pmcid) return { raw, kind: "pmcid", value: pmcid[1]!.toUpperCase() };
  const corpus = /^corpusid:\s*(\d+)$/i.exec(text);
  if (corpus) return { raw, kind: "corpus", value: corpus[1]! };
  if (/^[0-9a-f]{40}$/i.test(text)) return { raw, kind: "s2", value: text.toLowerCase() };
  if (/^W\d+$/i.test(text)) return { raw, kind: "openalex", value: text.toUpperCase() };
  return undefined;
}

/** Identifiers found inside a web hit's URL (doi.org, arxiv.org, PubMed...). */
export function identifierFromUrl(url: string): PaperIdentifier | undefined {
  const doiInPath = /\/(10\.\d{4,9}\/[^?#\s]+)/.exec(url);
  if (/doi\.org\//i.test(url) && doiInPath) {
    return parsePaperIdentifier(decodeURIComponent(doiInPath[1]!));
  }
  if (/arxiv\.org\/(abs|pdf)\//i.test(url)) return parsePaperIdentifier(url.replace(/\.pdf$/i, ""));
  if (/pubmed\.ncbi\.nlm\.nih\.gov\/\d+/i.test(url)) return parsePaperIdentifier(url);
  if (/openalex\.org\/W\d+/i.test(url)) return parsePaperIdentifier(url);
  const pmc = /ncbi\.nlm\.nih\.gov\/pmc\/articles\/(PMC\d+)/i.exec(url);
  if (pmc) return parsePaperIdentifier(pmc[1]!);
  if (doiInPath && /\b(dl\.acm\.org|onlinelibrary\.wiley\.com|tandfonline\.com|journals\.sagepub\.com|pubs\.acs\.org|link\.springer\.com|sciencedirect\.com\/science\/article\/pii)\b/i.test(url)) {
    return parsePaperIdentifier(decodeURIComponent(doiInPath[1]!));
  }
  return undefined;
}

/** Lower-case letters and digits, single-spaced: the comparison form of a title. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether a record's title is the paper a lookup asked for. */
export function titleMatches(wanted: string, candidate: string): boolean {
  const a = normalizeTitle(wanted);
  const b = normalizeTitle(candidate);
  if (a === "" || b === "") return false;
  if (a === b) return true;
  if (a.length >= 20 && (b.startsWith(a) || a.startsWith(b))) return true;
  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  const jaccard = shared / (wordsA.size + wordsB.size - shared);
  return jaccard >= 0.8;
}

/** Splits a words-or-phrases option into terms; quoted phrases stay whole. */
export function termsOf(values: readonly string[]): string[] {
  const terms: string[] = [];
  for (const value of values) {
    const pattern = /"([^"]+)"|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const term = (match[1] ?? match[2] ?? "").trim();
      if (term !== "") terms.push(term);
    }
  }
  return terms;
}

function containsAll(text: string | undefined, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  if (text === undefined) return false;
  const hay = ` ${normalizeTitle(text)} `;
  return terms.every((term) => hay.includes(` ${normalizeTitle(term)} `));
}

function authorMatches(authors: readonly string[] | undefined, wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true;
  if (authors === undefined || authors.length === 0) return false;
  const have = authors.map((name) => normalizeTitle(name));
  return wanted.every((name) => {
    const parts = normalizeTitle(name).split(" ").filter((part) => part.length > 1);
    const last = parts[parts.length - 1] ?? "";
    return have.some((author) => author.split(" ").includes(last));
  });
}

/**
 * Enforces on normalized records whatever a backend could not apply at the
 * source, when the records carry the fact. Returns the options it enforced.
 */
export function enforceOnRecords(
  papers: readonly PaperRecord[],
  query: NormalizedPaperQuery,
  appliedAtSource: ReadonlySet<PaperOption>,
): { readonly papers: PaperRecord[]; readonly enforced: PaperOption[] } {
  const enforced: PaperOption[] = [];
  let kept = [...papers];
  if (query.titleContains.length > 0 && !appliedAtSource.has("title_contains")) {
    const terms = termsOf(query.titleContains);
    kept = kept.filter((paper) => containsAll(paper.title, terms));
    enforced.push("title_contains");
  }
  if (query.abstractContains.length > 0 && !appliedAtSource.has("abstract_contains")) {
    const terms = termsOf(query.abstractContains);
    kept = kept.filter((paper) => containsAll(paper.abstract, terms));
    enforced.push("abstract_contains");
  }
  if (query.authors.length > 0 && !appliedAtSource.has("authors")) {
    kept = kept.filter((paper) => authorMatches(paper.authors, query.authors));
    enforced.push("authors");
  }
  if ((query.dateFrom !== undefined || query.dateTo !== undefined) && !appliedAtSource.has("date_range")) {
    kept = kept.filter((paper) => {
      const exact =
        paper.date !== undefined && /^\d{4}-\d{2}-\d{2}/.test(paper.date) ? paper.date.slice(0, 10) : undefined;
      if (exact !== undefined) {
        if (query.dateFrom !== undefined && exact < query.dateFrom) return false;
        if (query.dateTo !== undefined && exact > query.dateTo) return false;
        return true;
      }
      const year = paper.year ?? yearOf(paper.date);
      if (year === undefined) return false;
      if (query.dateFrom !== undefined && year < Number(query.dateFrom.slice(0, 4))) return false;
      if (query.dateTo !== undefined && year > Number(query.dateTo.slice(0, 4))) return false;
      return true;
    });
    enforced.push("date_range");
  }
  if (query.minCitations !== undefined && !appliedAtSource.has("min_citations")) {
    kept = kept.filter((paper) => (paper.citations ?? -1) >= query.minCitations!);
    enforced.push("min_citations");
  }
  if (query.openAccessOnly && !appliedAtSource.has("open_access_only")) {
    kept = kept.filter((paper) => paper.openAccess === true || paper.pdfUrl !== undefined);
    enforced.push("open_access_only");
  }
  return { papers: kept, enforced };
}

function shortAbstract(value: string | undefined, maxChars = 900): string | undefined {
  if (value === undefined) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact === "") return undefined;
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function yearOf(date: string | undefined): number | undefined {
  const match = date !== undefined ? /^(\d{4})/.exec(date) : null;
  return match ? Number(match[1]) : undefined;
}

function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    out[key] = entry;
  }
  return out as T;
}

function unsupported(option: PaperOption, reason: string): { option: PaperOption; reason: string } {
  return { option, reason };
}

/* ------------------------------------------------------------------------ */
/* Atom helpers (arXiv)                                                      */
/* ------------------------------------------------------------------------ */

function xmlInner(fragment: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(fragment);
  if (!match) return undefined;
  return htmlToText(match[1]!).text.replace(/\s+/g, " ").trim() || undefined;
}

function xmlAttrs(fragment: string, tag: string, attribute: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)/?>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment)) !== null) {
    const attr = new RegExp(`\\b${attribute}="([^"]*)"`, "i").exec(match[1]!);
    if (attr) out.push(attr[1]!);
  }
  return out;
}

function arxivLinks(fragment: string): { pdf?: string } {
  const pattern = /<link\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment)) !== null) {
    const attrs = match[1]!;
    if (/\btitle="pdf"/i.test(attrs)) {
      const href = /\bhref="([^"]+)"/i.exec(attrs);
      if (href) return { pdf: href[1]!.replace(/^http:/, "https:") };
    }
  }
  return {};
}

/** One term or phrase in arXiv query syntax. */
function arxivTerm(term: string): string {
  const clean = term.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

function arxivDay(date: string, end: boolean): string {
  return `${date.replace(/-/g, "")}${end ? "2359" : "0000"}`;
}

/* ------------------------------------------------------------------------ */
/* arXiv                                                                     */
/* ------------------------------------------------------------------------ */

function arxivRecord(entry: string): PaperRecord | undefined {
  const title = xmlInner(entry, "title");
  const idUrl = xmlInner(entry, "id");
  if (title === undefined || idUrl === undefined) return undefined;
  const idMatch = /arxiv\.org\/abs\/(.+?)(v\d+)?$/i.exec(idUrl);
  const arxivId = idMatch ? idMatch[1]! : undefined;
  const authors = (entry.match(/<author>[\s\S]*?<\/author>/gi) ?? []).flatMap((block) => {
    const name = xmlInner(block, "name");
    return name !== undefined ? [name] : [];
  });
  const published = xmlInner(entry, "published");
  const doi = xmlInner(entry, "arxiv:doi");
  const journal = xmlInner(entry, "arxiv:journal_ref");
  const categories = xmlAttrs(entry, "category", "term");
  const primary = xmlAttrs(entry, "arxiv:primary_category", "term")[0];
  const orderedCategories = primary !== undefined
    ? [primary, ...categories.filter((category) => category !== primary)]
    : categories;
  return compact({
    title,
    url: arxivId !== undefined ? `https://arxiv.org/abs/${arxivId}` : idUrl,
    authors: authors.length > 0 ? authors : undefined,
    year: yearOf(published),
    date: published?.slice(0, 10),
    venue: journal ?? "arXiv",
    doi: doi?.toLowerCase(),
    arxivId,
    pdfUrl: arxivLinks(entry).pdf ?? (arxivId !== undefined ? `https://arxiv.org/pdf/${arxivId}` : undefined),
    openAccess: true,
    type: "preprint",
    categories: orderedCategories.length > 0 ? orderedCategories : undefined,
    abstract: shortAbstract(xmlInner(entry, "summary")),
    source: "arxiv",
  });
}

export function arxivBackend(options: {
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
} = {}): PaperBackend {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://export.arxiv.org").replace(/\/+$/, "");
  const fetchFeed = async (params: URLSearchParams, signal?: AbortSignal) => {
    const body = await requestText(
      fetchImpl,
      "arxiv",
      `${base}/api/query?${params.toString()}`,
      { method: "GET", headers: { accept: "application/atom+xml" } },
      signal,
    );
    const entries = body.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    // A refused query comes back as a feed whose one entry is an error
    // (its id under /api/errors): a refusal, never a paper.
    for (const entry of entries) {
      if (/\/api\/errors/.test(xmlInner(entry, "id") ?? "")) {
        throw new ProviderRequestError(`arXiv refused the query: ${xmlInner(entry, "summary") ?? "error"}`, false);
      }
    }
    const totalText = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i.exec(body);
    return {
      papers: entries.flatMap((entry) => {
        const paper = arxivRecord(entry);
        return paper !== undefined ? [paper] : [];
      }),
      ...(totalText ? { total: Number(totalText[1]) } : {}),
    };
  };
  return {
    id: "arxiv",
    // arXiv's terms: one request every three seconds, over one connection.
    minIntervalMs: 3_100,
    maxConcurrent: 1,
    ready: { ok: true },
    async search(query, signal) {
      const applied: PaperOption[] = [];
      const skipped: { option: PaperOption; reason: string }[] = [];
      if (query.types.length > 0 && !query.types.includes("preprint")) {
        return {
          papers: [],
          applied,
          unsupported: [unsupported("types", "arXiv holds preprints only")],
        };
      }
      const clauses: string[] = [];
      if (query.native !== undefined) {
        clauses.push(`(${query.native})`);
        applied.push("native_query");
      }
      const words = termsOf([query.query]);
      if (words.length > 0) {
        clauses.push(
          query.mode === "lookup"
            ? `ti:${arxivTerm(query.query)}`
            : `(${words.map((word) => `all:${arxivTerm(word)}`).join(" OR ")})`,
        );
        applied.push("query");
      }
      for (const term of termsOf(query.titleContains)) clauses.push(`ti:${arxivTerm(term)}`);
      if (query.titleContains.length > 0) applied.push("title_contains");
      for (const term of termsOf(query.abstractContains)) clauses.push(`abs:${arxivTerm(term)}`);
      if (query.abstractContains.length > 0) applied.push("abstract_contains");
      for (const name of query.authors) {
        const parts = normalizeTitle(name).split(" ").filter((part) => part !== "");
        const last = parts[parts.length - 1];
        if (last !== undefined) clauses.push(`au:${arxivTerm(last)}`);
      }
      if (query.arxivCategories.length > 0) {
        clauses.push(`(${query.arxivCategories.map((category) => `cat:${category.trim()}`).join(" OR ")})`);
        applied.push("arxiv_categories");
      }
      if (query.dateFrom !== undefined || query.dateTo !== undefined) {
        clauses.push(
          `submittedDate:[${arxivDay(query.dateFrom ?? "1991-01-01", false)} TO ${arxivDay(query.dateTo ?? new Date().toISOString().slice(0, 10), true)}]`,
        );
        applied.push("date_range");
      }
      if (query.fieldsOfStudy.length > 0) {
        skipped.push(unsupported("fields_of_study", "arXiv classifies by arxiv_categories instead"));
      }
      if (query.venues.length > 0) skipped.push(unsupported("venues", "arXiv has no venue filter"));
      if (query.minCitations !== undefined) {
        skipped.push(unsupported("min_citations", "arXiv reports no citation counts"));
      }
      if (query.openAccessOnly) applied.push("open_access_only");
      if (query.types.length > 0) applied.push("types");
      if (clauses.length === 0) {
        return { papers: [], applied, unsupported: [unsupported("query", "an empty arXiv query")] };
      }
      const params = new URLSearchParams();
      params.set("search_query", clauses.join(" AND "));
      params.set("start", String((query.page - 1) * query.maxResults));
      params.set("max_results", String(query.maxResults));
      if (query.sort === "newest" || query.sort === "oldest") {
        params.set("sortBy", "submittedDate");
        params.set("sortOrder", query.sort === "newest" ? "descending" : "ascending");
        applied.push("sort");
      } else {
        params.set("sortBy", "relevance");
        params.set("sortOrder", "descending");
        if (query.sort === "most-cited") {
          skipped.push(unsupported("sort", "arXiv cannot sort by citations; sorted by relevance"));
        } else {
          applied.push("sort");
        }
      }
      if (query.page > 1) applied.push("page");
      const answer = await fetchFeed(params, signal);
      return { ...answer, applied, unsupported: skipped };
    },
    async details(ids, _parts, _limit, signal) {
      const wanted = ids.filter((id) => id.kind === "arxiv");
      const found = new Map<string, PaperDetailsEntry>();
      if (wanted.length === 0) return found;
      const params = new URLSearchParams();
      params.set("id_list", wanted.map((id) => id.value).join(","));
      params.set("max_results", String(wanted.length));
      const answer = await fetchFeed(params, signal);
      for (const paper of answer.papers) {
        const match = wanted.find((id) => id.value === paper.arxivId);
        if (match !== undefined) found.set(match.raw, { ...paper, requested: match.raw });
      }
      return found;
    },
    async check(signal) {
      return runProbe(
        "arxiv",
        { ...(signal !== undefined ? { signal } : {}), timeoutMs: ARXIV_PROBE_TIMEOUT_MS, request: "id_list=1706.03762 (Attention Is All You Need)" },
        async (probe) => {
          const params = new URLSearchParams({ id_list: "1706.03762", max_results: "1" });
          const answer = await fetchFeed(params, probe);
          const ok = answer.papers.some((paper) => titleMatches("Attention Is All You Need", paper.title));
          return {
            ok,
            summary: `${answer.papers.length} entries, known title found`,
            ...(ok ? {} : { detail: "answered without the known paper" }),
          };
        },
      );
    },
  };
}

/** Maps a check's failure onto a source state. */
export function statusFromError(id: string, error: unknown, checkedAt: number): WebSourceStatus {
  // Spec Section 2: 429/503 on a probe is degraded (throttled, not dead);
  // 403 / CAPTCHA is blocked; a refused key needs one.
  return probeStateFromError(id, error, checkedAt);
}

/* ------------------------------------------------------------------------ */
/* OpenAlex                                                                  */
/* ------------------------------------------------------------------------ */

const OPENALEX_TYPES: Readonly<Record<PaperType, readonly string[]>> = {
  "journal-article": ["article"],
  "conference-paper": ["article"],
  preprint: ["preprint"],
  review: ["review"],
  book: ["book"],
  "book-chapter": ["book-chapter"],
  dataset: ["dataset"],
  thesis: ["dissertation"],
};

const OPENALEX_SELECT = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "publication_date",
  "type",
  "cited_by_count",
  "authorships",
  "primary_location",
  "best_oa_location",
  "open_access",
  "ids",
  "abstract_inverted_index",
].join(",");

/** An OpenAlex filter value: commas and pipes are syntax, so they go. */
function openAlexValue(value: string): string {
  return value.replace(/[,|:]/g, " ").replace(/\s+/g, " ").trim();
}

function openAlexRecord(entry: unknown): PaperRecord | undefined {
  const item = record(entry);
  const title = asString(item.display_name) ?? asString(item.title);
  const idUrl = asString(item.id);
  if (title === undefined || idUrl === undefined) return undefined;
  const doi = asString(item.doi)?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
  const primary = record(item.primary_location);
  const best = record(item.best_oa_location);
  const ids = record(item.ids);
  const authors = (Array.isArray(item.authorships) ? item.authorships : []).flatMap((authorship) => {
    const name = asString(record(record(authorship).author).display_name);
    return name !== undefined ? [name] : [];
  });
  const landing = asString(primary.landing_page_url);
  const arxivFromLanding = landing !== undefined ? /arxiv\.org\/abs\/([^v?#]+)/i.exec(landing)?.[1] : undefined;
  return compact({
    title,
    url: doi !== undefined ? `https://doi.org/${doi}` : landing ?? idUrl,
    authors: authors.length > 0 ? authors.slice(0, 25) : undefined,
    year: asNumber(item.publication_year),
    date: asString(item.publication_date),
    venue: asString(record(primary.source).display_name),
    doi,
    arxivId: arxivFromLanding,
    pmid: asString(ids.pmid)?.replace(/^.*\//, ""),
    pmcid: asString(ids.pmcid)?.replace(/^.*\//, "").toUpperCase(),
    openAlexId: idUrl.replace(/^.*\//, ""),
    pdfUrl: asString(best.pdf_url) ?? asString(primary.pdf_url),
    openAccess: typeof record(item.open_access).is_oa === "boolean" ? (record(item.open_access).is_oa as boolean) : undefined,
    citations: asNumber(item.cited_by_count),
    type: asString(item.type),
    abstract: shortAbstract(abstractFromInvertedIndex(item.abstract_inverted_index, 250)),
    source: "openalex",
  });
}

export function openAlexBackend(options: {
  readonly apiKey?: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
} = {}): PaperBackend {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://api.openalex.org").replace(/\/+$/, "");
  const key = options.apiKey !== undefined && options.apiKey.trim() !== "" ? options.apiKey.trim() : undefined;
  const works = async (params: URLSearchParams, signal?: AbortSignal) => {
    if (key !== undefined) params.set("api_key", key);
    const parsed = record(
      await requestJson(
        fetchImpl,
        "openalex",
        `${base}/works?${params.toString()}`,
        { method: "GET", headers: { accept: "application/json" } },
        signal,
      ),
    );
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return {
      raw: results,
      papers: results.flatMap((entry) => {
        const paper = openAlexRecord(entry);
        return paper !== undefined ? [paper] : [];
      }),
      total: asNumber(record(parsed.meta).count),
    };
  };
  const byIds = async (filterName: string, values: readonly string[], signal?: AbortSignal, extraSelect = "") => {
    const all: { raw: unknown[]; papers: PaperRecord[] } = { raw: [], papers: [] };
    for (let index = 0; index < values.length; index += 50) {
      const chunk = values.slice(index, index + 50);
      const params = new URLSearchParams();
      params.set("filter", `${filterName}:${chunk.join("|")}`);
      params.set("per_page", String(Math.min(200, chunk.length)));
      params.set("select", extraSelect === "" ? OPENALEX_SELECT : `${OPENALEX_SELECT},${extraSelect}`);
      const answer = await works(params, signal);
      all.raw.push(...answer.raw);
      all.papers.push(...answer.papers);
    }
    return all;
  };
  return {
    id: "openalex",
    // Keyless use works on a small daily budget (1,000 credits per IP, about
    // 100 keyword searches); a free key raises it tenfold. A 429 means the
    // day's budget is spent until midnight UTC.
    ready: { ok: true },
    async search(query, signal) {
      const applied: PaperOption[] = [];
      const skipped: { option: PaperOption; reason: string }[] = [];
      const filters: string[] = [];
      const params = new URLSearchParams();
      const text = query.query.trim();
      if (text !== "") {
        if (query.mode === "lookup") filters.push(`title.search:${openAlexValue(text)}`);
        else params.set("search", text);
        applied.push("query");
      }
      if (query.titleContains.length > 0) {
        filters.push(`title.search:${openAlexValue(termsOf(query.titleContains).join(" "))}`);
      }
      if (query.abstractContains.length > 0) {
        filters.push(`abstract.search:${openAlexValue(termsOf(query.abstractContains).join(" "))}`);
        // Many OpenAlex works carry no abstract text, so the index's own
        // match stands; re-checking would drop exactly those.
        applied.push("abstract_contains");
      }
      // A quoted name scopes the match to one byline.
      for (const name of query.authors) filters.push(`raw_author_name.search:"${openAlexValue(name).replace(/"/g, "")}"`);
      if (query.dateFrom !== undefined) filters.push(`from_publication_date:${query.dateFrom}`);
      if (query.dateTo !== undefined) filters.push(`to_publication_date:${query.dateTo}`);
      if (query.dateFrom !== undefined || query.dateTo !== undefined) applied.push("date_range");
      if (query.types.length > 0) {
        const mapped = [...new Set(query.types.flatMap((type) => OPENALEX_TYPES[type]))];
        filters.push(`type:${mapped.join("|")}`);
        applied.push("types");
        if (query.types.includes("conference-paper") || query.types.includes("journal-article")) {
          skipped.push(
            unsupported("types", "OpenAlex files journal and conference papers alike as \"article\""),
          );
        }
      }
      if (query.openAccessOnly) {
        filters.push("open_access.is_oa:true");
        applied.push("open_access_only");
      }
      if (query.minCitations !== undefined) {
        filters.push(`cited_by_count:>${Math.max(0, query.minCitations - 1)}`);
        applied.push("min_citations");
      }
      if (query.native !== undefined) {
        filters.push(query.native);
        applied.push("native_query");
      }
      if (query.arxivCategories.length > 0) {
        skipped.push(unsupported("arxiv_categories", "OpenAlex does not index arXiv categories"));
      }
      if (query.fieldsOfStudy.length > 0) {
        skipped.push(unsupported("fields_of_study", "OpenAlex uses its own topic ids; use native_query"));
      }
      if (query.venues.length > 0) {
        skipped.push(unsupported("venues", "OpenAlex filters venues by source id; use native_query"));
      }
      if (filters.length > 0) params.set("filter", filters.join(","));
      if (!params.has("search") && !params.has("filter")) {
        return { papers: [], applied, unsupported: [unsupported("query", "an empty OpenAlex query")] };
      }
      const sort =
        query.sort === "newest"
          ? "publication_date:desc"
          : query.sort === "oldest"
            ? "publication_date:asc"
            : query.sort === "most-cited"
              ? "cited_by_count:desc"
              : params.has("search")
                ? "relevance_score:desc"
                : undefined;
      if (sort !== undefined) params.set("sort", sort);
      applied.push("sort");
      params.set("per_page", String(query.maxResults));
      params.set("page", String(query.page));
      if (query.page > 1) applied.push("page");
      params.set("select", OPENALEX_SELECT);
      const answer = await works(params, signal);
      return {
        papers: answer.papers,
        ...(answer.total !== undefined ? { total: answer.total } : {}),
        applied,
        unsupported: skipped,
      };
    },
    async details(ids, parts, limit, signal) {
      const found = new Map<string, PaperDetailsEntry>();
      const extra = [
        parts.has("references") ? "referenced_works" : "",
        parts.has("related") ? "related_works" : "",
      ].filter((field) => field !== "").join(",");
      const rawByRequest = new Map<string, Record<string, unknown>>();
      const groups: {
        readonly filter: string;
        readonly ids: readonly PaperIdentifier[];
        readonly value: (id: PaperIdentifier) => string;
        readonly matches: (paper: PaperRecord, id: PaperIdentifier) => boolean;
      }[] = [
        { filter: "doi", ids: ids.filter((id) => id.kind === "doi"), value: (id) => `https://doi.org/${id.value}`, matches: (paper, id) => paper.doi === id.value },
        { filter: "ids.openalex", ids: ids.filter((id) => id.kind === "openalex"), value: (id) => id.value, matches: (paper, id) => paper.openAlexId === id.value },
        { filter: "ids.pmid", ids: ids.filter((id) => id.kind === "pmid"), value: (id) => id.value, matches: (paper, id) => paper.pmid === id.value },
        { filter: "ids.pmcid", ids: ids.filter((id) => id.kind === "pmcid"), value: (id) => id.value, matches: (paper, id) => paper.pmcid === id.value },
        // arXiv's DataCite DOIs (10.48550/arXiv.<id>): OpenAlex holds many
        // e-prints under them, which spares arXiv's own small allowance.
        { filter: "doi", ids: ids.filter((id) => id.kind === "arxiv"), value: (id) => `https://doi.org/10.48550/arxiv.${id.value.toLowerCase()}`, matches: (paper, id) => paper.doi === `10.48550/arxiv.${id.value.toLowerCase()}` },
      ];
      for (const group of groups) {
        if (group.ids.length === 0) continue;
        const answer = await byIds(group.filter, group.ids.map(group.value), signal, extra);
        answer.papers.forEach((paper, index) => {
          const id = group.ids.find((candidate) => group.matches(paper, candidate));
          if (id === undefined) return;
          found.set(id.raw, { ...paper, requested: id.raw });
          rawByRequest.set(id.raw, record(answer.raw[index]));
        });
      }
      // References, citations and related works, per resolved paper.
      for (const [requested, entry] of [...found]) {
        const raw = rawByRequest.get(requested) ?? {};
        const workIds = (value: unknown): string[] =>
          (Array.isArray(value) ? value : [])
            .flatMap((item) => (asString(item) !== undefined ? [asString(item)!.replace(/^.*\//, "")] : []))
            .slice(0, limit);
        let next: PaperDetailsEntry = entry;
        if (parts.has("references")) {
          const refs = workIds(raw.referenced_works);
          if (refs.length > 0) next = { ...next, references: (await byIds("ids.openalex", refs, signal)).papers };
        }
        if (parts.has("related")) {
          const related = workIds(raw.related_works);
          if (related.length > 0) next = { ...next, related: (await byIds("ids.openalex", related, signal)).papers };
        }
        if (parts.has("citations") && entry.openAlexId !== undefined) {
          const params = new URLSearchParams();
          params.set("filter", `cites:${entry.openAlexId}`);
          params.set("sort", "cited_by_count:desc");
          params.set("per_page", String(Math.min(200, limit)));
          params.set("select", OPENALEX_SELECT);
          next = { ...next, citedBy: (await works(params, signal)).papers };
        }
        found.set(requested, next);
      }
      return found;
    },
    async check(signal) {
      if (key === undefined) {
        // Spec Section 2: no OpenAlex call without a key — the probe makes
        // no request, so the run skips OpenAlex until a key is configured.
        const checkedAt = Date.now();
        return {
          id: "openalex",
          state: "needs-key",
          detail: "OpenAlex is not probed or called without an API key (openAlexApiKey in Settings)",
          checkedAt,
          log: [{ at: checkedAt, level: "warn" as const, text: "no OpenAlex API key: not probed" }],
        };
      }
      return runProbe(
        "openalex",
        { ...(signal !== undefined ? { signal } : {}), secrets: [key], request: "works?filter=doi:10.1038/nature14539 (Deep learning)" },
        async (probe) => {
          const answer = await byIds("doi", ["https://doi.org/10.1038/nature14539"], probe);
          const ok = answer.papers.some((paper) => /deep learning/i.test(paper.title));
          return {
            ok,
            summary: `${answer.papers.length} works, known title found`,
            ...(ok ? {} : { detail: "answered without the known paper" }),
          };
        },
      );
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Crossref                                                                  */
/* ------------------------------------------------------------------------ */

const CROSSREF_TYPES: Readonly<Record<PaperType, readonly string[]>> = {
  "journal-article": ["journal-article"],
  "conference-paper": ["proceedings-article"],
  preprint: ["posted-content"],
  review: [],
  book: ["book", "monograph", "edited-book"],
  "book-chapter": ["book-chapter"],
  dataset: ["dataset"],
  thesis: ["dissertation"],
};

const CROSSREF_SELECT = [
  "DOI",
  "title",
  "author",
  "issued",
  "published",
  "container-title",
  "type",
  "is-referenced-by-count",
  "abstract",
  "URL",
].join(",");

function crossrefDate(value: unknown): string | undefined {
  const parts = record(value)["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
  const [year, month, day] = (parts[0] as unknown[]).map((part) => asNumber(part));
  if (year === undefined) return undefined;
  if (month === undefined) return String(year);
  const pad = (n: number) => String(n).padStart(2, "0");
  return day === undefined ? `${year}-${pad(month)}` : `${year}-${pad(month)}-${pad(day)}`;
}

function crossrefRecord(entry: unknown): PaperRecord | undefined {
  const item = record(entry);
  const doi = asString(item.DOI)?.toLowerCase();
  const title = Array.isArray(item.title) ? asString(item.title[0]) : asString(item.title);
  if (title === undefined || doi === undefined) return undefined;
  const authors = (Array.isArray(item.author) ? item.author : []).flatMap((author) => {
    const person = record(author);
    const name = [asString(person.given), asString(person.family)]
      .filter((part): part is string => part !== undefined)
      .join(" ");
    return name !== "" ? [name] : asString(person.name) !== undefined ? [asString(person.name)!] : [];
  });
  const date = crossrefDate(item.published) ?? crossrefDate(item.issued);
  const abstract = asString(item.abstract);
  return compact({
    title: htmlToText(title).text.replace(/\s+/g, " ").trim() || title,
    url: `https://doi.org/${doi}`,
    authors: authors.length > 0 ? authors.slice(0, 25) : undefined,
    year: yearOf(date),
    date: date !== undefined && date.length === 10 ? date : undefined,
    venue: Array.isArray(item["container-title"]) ? asString(item["container-title"][0]) : undefined,
    doi,
    citations: asNumber(item["is-referenced-by-count"]),
    type: asString(item.type),
    abstract: shortAbstract(abstract !== undefined ? htmlToText(abstract).text : undefined),
    source: "crossref",
  });
}

export function crossrefBackend(options: {
  readonly contactEmail?: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
} = {}): PaperBackend {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://api.crossref.org").replace(/\/+$/, "");
  const mailto = options.contactEmail !== undefined && options.contactEmail.trim() !== ""
    ? options.contactEmail.trim()
    : undefined;
  const get = async (path: string, params: URLSearchParams, signal?: AbortSignal) => {
    if (mailto !== undefined) params.set("mailto", mailto);
    const query = params.toString();
    return record(
      await requestJson(
        fetchImpl,
        "crossref",
        `${base}${path}${query !== "" ? `?${query}` : ""}`,
        { method: "GET", headers: { accept: "application/json" } },
        signal,
      ),
    );
  };
  return {
    id: "crossref",
    // Since July 2026 list queries are limited to 1 request/s without a
    // contact address (3/s with one), and requests without one must not
    // overlap; single-DOI lookups have higher limits.
    minIntervalMs: mailto !== undefined ? 350 : 1_050,
    maxConcurrent: mailto !== undefined ? 3 : 1,
    ready: { ok: true },
    async search(query, signal) {
      const applied: PaperOption[] = [];
      const skipped: { option: PaperOption; reason: string }[] = [];
      const params = new URLSearchParams();
      const text = query.query.trim();
      if (text !== "") {
        params.set(query.mode === "lookup" ? "query.bibliographic" : "query", text);
        applied.push("query");
      }
      if (query.authors.length > 0) {
        params.set("query.author", query.authors.join(" "));
      }
      if (query.venues.length > 0) {
        params.set("query.container-title", query.venues.join(" "));
      }
      const filters: string[] = [];
      if (query.dateFrom !== undefined) filters.push(`from-pub-date:${query.dateFrom}`);
      if (query.dateTo !== undefined) filters.push(`until-pub-date:${query.dateTo}`);
      if (query.dateFrom !== undefined || query.dateTo !== undefined) applied.push("date_range");
      if (query.types.length > 0) {
        const mapped = [...new Set(query.types.flatMap((type) => CROSSREF_TYPES[type]))];
        for (const type of mapped) filters.push(`type:${type}`);
        if (mapped.length > 0) applied.push("types");
        if (query.types.includes("review")) {
          skipped.push(unsupported("types", "Crossref has no \"review\" type"));
        }
      }
      if (query.native !== undefined) {
        for (const [name, value] of new URLSearchParams(query.native)) {
          if (name === "filter") filters.push(value);
          else params.set(name, value);
        }
        applied.push("native_query");
      }
      if (filters.length > 0) params.set("filter", filters.join(","));
      if (query.openAccessOnly) {
        skipped.push(unsupported("open_access_only", "Crossref does not record open-access status"));
      }
      if (query.arxivCategories.length > 0) {
        skipped.push(unsupported("arxiv_categories", "Crossref does not index arXiv categories"));
      }
      if (query.fieldsOfStudy.length > 0) {
        skipped.push(unsupported("fields_of_study", "Crossref has no field-of-study filter"));
      }
      if (![...params.keys()].some((name) => name.startsWith("query")) && filters.length === 0) {
        return { papers: [], applied, unsupported: [unsupported("query", "an empty Crossref query")] };
      }
      if (query.sort === "newest" || query.sort === "oldest") {
        params.set("sort", "published");
        params.set("order", query.sort === "newest" ? "desc" : "asc");
      } else if (query.sort === "most-cited") {
        params.set("sort", "is-referenced-by-count");
        params.set("order", "desc");
      } else {
        params.set("sort", "relevance");
        params.set("order", "desc");
      }
      applied.push("sort");
      params.set("rows", String(query.maxResults));
      if (query.page > 1) {
        params.set("offset", String(Math.min(10_000 - query.maxResults, (query.page - 1) * query.maxResults)));
        applied.push("page");
      }
      params.set("select", CROSSREF_SELECT);
      const message = record((await get("/works", params, signal)).message);
      const items = Array.isArray(message.items) ? message.items : [];
      const total = asNumber(message["total-results"]);
      return {
        papers: items.flatMap((entry) => {
          const paper = crossrefRecord(entry);
          return paper !== undefined ? [paper] : [];
        }),
        ...(total !== undefined ? { total } : {}),
        applied,
        unsupported: skipped,
      };
    },
    async details(ids, parts, limit, signal) {
      const found = new Map<string, PaperDetailsEntry>();
      for (const id of ids.filter((candidate) => candidate.kind === "doi")) {
        try {
          const message = (await get(`/works/${encodeURIComponent(id.value)}`, new URLSearchParams(), signal)).message;
          const paper = crossrefRecord(message);
          if (paper === undefined) continue;
          let entry: PaperDetailsEntry = { ...paper, requested: id.raw };
          if (parts.has("references")) {
            const refs = (Array.isArray(record(message).reference) ? (record(message).reference as unknown[]) : [])
              .slice(0, limit)
              .flatMap((ref): PaperRecord[] => {
                const item = record(ref);
                const doi = asString(item.DOI)?.toLowerCase();
                if (doi === undefined) return [];
                const title = asString(item["article-title"]) ?? asString(item.unstructured) ?? doi;
                return [compact({
                  title,
                  url: `https://doi.org/${doi}`,
                  doi,
                  year: asNumber(Number(asString(item.year))),
                  venue: asString(item["journal-title"]),
                  source: "crossref",
                })];
              });
            if (refs.length > 0) entry = { ...entry, references: refs };
          }
          found.set(id.raw, entry);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof ProviderRequestError && /HTTP 404/.test(error.message)) continue;
          throw error;
        }
      }
      return found;
    },
    async check(signal) {
      return runProbe(
        "crossref",
        { ...(signal !== undefined ? { signal } : {}), request: "works/10.1038/nature14539 (Deep learning)" },
        async (probe) => {
          const message = (await get("/works/10.1038%2Fnature14539", new URLSearchParams(), probe)).message;
          const paper = crossrefRecord(message);
          const ok = paper !== undefined && /deep learning/i.test(paper.title);
          return {
            ok,
            summary: `1 work, known title found`,
            ...(ok ? {} : { detail: "answered without the known paper" }),
          };
        },
      );
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Semantic Scholar                                                          */
/* ------------------------------------------------------------------------ */

const S2_TYPES: Readonly<Record<PaperType, readonly string[]>> = {
  "journal-article": ["JournalArticle"],
  "conference-paper": ["Conference"],
  preprint: [],
  review: ["Review"],
  book: ["Book"],
  "book-chapter": ["BookSection"],
  dataset: ["Dataset"],
  thesis: [],
};

const S2_FIELDS = [
  "title",
  "abstract",
  "url",
  "year",
  "publicationDate",
  "venue",
  "journal",
  "externalIds",
  "citationCount",
  "authors",
  "isOpenAccess",
  "openAccessPdf",
  "fieldsOfStudy",
  "publicationTypes",
].join(",");

const S2_LIST_FIELDS = "title,url,year,venue,externalIds,citationCount,authors";

function s2Record(entry: unknown): PaperRecord | undefined {
  const item = record(entry);
  const title = asString(item.title);
  const paperId = asString(item.paperId);
  if (title === undefined) return undefined;
  const ids = record(item.externalIds);
  const doi = asString(ids.DOI)?.toLowerCase();
  const arxivId = asString(ids.ArXiv);
  const pmid = ids.PubMed !== undefined ? String(ids.PubMed) : undefined;
  const pmcidRaw = ids.PubMedCentral !== undefined ? String(ids.PubMedCentral) : undefined;
  const authors = (Array.isArray(item.authors) ? item.authors : []).flatMap((author) => {
    const name = asString(record(author).name);
    return name !== undefined ? [name] : [];
  });
  const fields = Array.isArray(item.fieldsOfStudy)
    ? item.fieldsOfStudy.flatMap((field) => (asString(field) !== undefined ? [asString(field)!] : []))
    : [];
  const types = Array.isArray(item.publicationTypes)
    ? item.publicationTypes.flatMap((type) => (asString(type) !== undefined ? [asString(type)!] : []))
    : [];
  const url =
    asString(item.url) ??
    (doi !== undefined ? `https://doi.org/${doi}` : paperId !== undefined ? `https://www.semanticscholar.org/paper/${paperId}` : undefined);
  if (url === undefined) return undefined;
  return compact({
    title,
    url,
    authors: authors.length > 0 ? authors.slice(0, 25) : undefined,
    year: asNumber(item.year),
    date: asString(item.publicationDate),
    venue: asString(item.venue) ?? asString(record(item.journal).name),
    doi,
    arxivId,
    pmid,
    pmcid: pmcidRaw !== undefined ? (pmcidRaw.toUpperCase().startsWith("PMC") ? pmcidRaw.toUpperCase() : `PMC${pmcidRaw}`) : undefined,
    semanticScholarId: paperId,
    pdfUrl: asString(record(item.openAccessPdf).url),
    openAccess: typeof item.isOpenAccess === "boolean" ? item.isOpenAccess : undefined,
    citations: asNumber(item.citationCount),
    type: types.length > 0 ? types.join(", ") : undefined,
    categories: fields.length > 0 ? fields : undefined,
    abstract: shortAbstract(asString(item.abstract)),
    source: "semantic-scholar",
  });
}

function s2Id(id: PaperIdentifier): string {
  switch (id.kind) {
    case "doi":
      return `DOI:${id.value}`;
    case "arxiv":
      return `ARXIV:${id.value}`;
    case "pmid":
      return `PMID:${id.value}`;
    case "pmcid":
      return `PMCID:${id.value.replace(/^PMC/i, "")}`;
    case "corpus":
      return `CorpusId:${id.value}`;
    case "s2":
      return id.value;
    case "openalex":
      return "";
  }
}

export function semanticScholarBackend(options: {
  readonly apiKey?: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
} = {}): PaperBackend {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://api.semanticscholar.org").replace(/\/+$/, "");
  const key = options.apiKey !== undefined && options.apiKey.trim() !== "" ? options.apiKey.trim() : undefined;
  const headers = { accept: "application/json", ...(key !== undefined ? { "x-api-key": key } : {}) };
  // openAccessPdf is a valueless flag: it is appended bare, never as "=".
  const get = async (path: string, params: URLSearchParams, signal?: AbortSignal) => {
    const flag = params.has("openAccessPdf");
    params.delete("openAccessPdf");
    const query = params.toString();
    return requestJson(
      fetchImpl,
      "semantic-scholar",
      `${base}${path}?${query}${flag ? `${query !== "" ? "&" : ""}openAccessPdf` : ""}`,
      { method: "GET", headers },
      signal,
    );
  };
  // Hyphenated terms match nothing in relevance and title search.
  const plain = (text: string) => text.replace(/(\w)-(?=\w)/g, "$1 ");
  const filterParams = (query: NormalizedPaperQuery, params: URLSearchParams, applied: PaperOption[]) => {
    if (query.dateFrom !== undefined || query.dateTo !== undefined) {
      params.set("publicationDateOrYear", `${query.dateFrom ?? ""}:${query.dateTo ?? ""}`);
      applied.push("date_range");
    }
    if (query.fieldsOfStudy.length > 0) {
      params.set("fieldsOfStudy", query.fieldsOfStudy.join(","));
      applied.push("fields_of_study");
    }
    if (query.venues.length > 0) {
      params.set("venue", query.venues.join(","));
      applied.push("venues");
    }
    const types = [...new Set(query.types.flatMap((type) => S2_TYPES[type]))];
    if (types.length > 0) {
      params.set("publicationTypes", types.join(","));
      applied.push("types");
    }
    if (query.openAccessOnly) {
      params.set("openAccessPdf", "");
      applied.push("open_access_only");
    }
    if (query.minCitations !== undefined) {
      params.set("minCitationCount", String(query.minCitations));
      applied.push("min_citations");
    }
  };
  return {
    id: "semantic-scholar",
    // Keyless requests share one pool with every anonymous user; a keyed
    // account is 1 req/s. Either way the polite floor is about a second.
    minIntervalMs: 1_100,
    ready: { ok: true },
    async search(query, signal) {
      const applied: PaperOption[] = [];
      const skipped: { option: PaperOption; reason: string }[] = [];
      if (query.arxivCategories.length > 0) {
        skipped.push(unsupported("arxiv_categories", "Semantic Scholar uses fields_of_study instead"));
      }
      if (query.types.includes("preprint") || query.types.includes("thesis")) {
        skipped.push(unsupported("types", "Semantic Scholar has no preprint or thesis type"));
      }
      // A known paper by its title: the title-match endpoint.
      if (query.mode === "lookup" && query.native === undefined && query.page === 1) {
        const params = new URLSearchParams({ query: plain(query.query), fields: S2_FIELDS });
        filterParams(query, params, applied);
        applied.push("query");
        try {
          const parsed = record(await get("/graph/v1/paper/search/match", params, signal));
          const data = Array.isArray(parsed.data) ? parsed.data : [];
          const papers = data.flatMap((entry) => {
            const paper = s2Record(entry);
            return paper !== undefined ? [paper] : [];
          });
          return { papers, applied, unsupported: skipped };
        } catch (error) {
          if (error instanceof ProviderRequestError && /HTTP 404/.test(error.message)) {
            return { papers: [], applied, unsupported: skipped };
          }
          throw error;
        }
      }
      // Date/citation ordering and boolean queries: the bulk endpoint.
      if (query.native !== undefined || (query.sort !== "relevance" && query.mode === "topic")) {
        const params = new URLSearchParams({ query: query.native ?? plain(query.query), fields: S2_FIELDS });
        if (query.native !== undefined) applied.push("native_query");
        else applied.push("query");
        filterParams(query, params, applied);
        if (query.sort === "newest") params.set("sort", "publicationDate:desc");
        else if (query.sort === "oldest") params.set("sort", "publicationDate:asc");
        else if (query.sort === "most-cited") params.set("sort", "citationCount:desc");
        if (query.sort !== "relevance") applied.push("sort");
        const parsed = record(await get("/graph/v1/paper/search/bulk", params, signal));
        const data = Array.isArray(parsed.data) ? parsed.data : [];
        const start = (query.page - 1) * query.maxResults;
        if (query.page > 1) applied.push("page");
        return {
          papers: data.slice(start, start + query.maxResults).flatMap((entry) => {
            const paper = s2Record(entry);
            return paper !== undefined ? [paper] : [];
          }),
          ...(asNumber(parsed.total) !== undefined ? { total: asNumber(parsed.total)! } : {}),
          applied,
          unsupported: skipped,
        };
      }
      const params = new URLSearchParams({
        query: plain(query.query),
        fields: S2_FIELDS,
        limit: String(query.maxResults),
        offset: String(Math.min(999 - query.maxResults, (query.page - 1) * query.maxResults)),
      });
      applied.push("query", "sort");
      if (query.page > 1) applied.push("page");
      filterParams(query, params, applied);
      const parsed = record(await get("/graph/v1/paper/search", params, signal));
      const data = Array.isArray(parsed.data) ? parsed.data : [];
      return {
        papers: data.flatMap((entry) => {
          const paper = s2Record(entry);
          return paper !== undefined ? [paper] : [];
        }),
        ...(asNumber(parsed.total) !== undefined ? { total: asNumber(parsed.total)! } : {}),
        applied,
        unsupported: skipped,
      };
    },
    async details(ids, parts, limit, signal) {
      const found = new Map<string, PaperDetailsEntry>();
      const usable = ids.filter((id) => s2Id(id) !== "");
      if (usable.length === 0) return found;
      for (let index = 0; index < usable.length; index += 100) {
        const chunk = usable.slice(index, index + 100);
        const parsed = await requestJson(
          fetchImpl,
          "semantic-scholar",
          `${base}/graph/v1/paper/batch?fields=${encodeURIComponent(S2_FIELDS)}`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ ids: chunk.map(s2Id) }),
          },
          signal,
        );
        const rows = Array.isArray(parsed) ? parsed : [];
        rows.forEach((row, position) => {
          const paper = row === null ? undefined : s2Record(row);
          const id = chunk[position];
          if (paper !== undefined && id !== undefined) found.set(id.raw, { ...paper, requested: id.raw });
        });
      }
      for (const [requested, entry] of [...found]) {
        const paperId = entry.semanticScholarId;
        if (paperId === undefined) continue;
        let next: PaperDetailsEntry = entry;
        const list = async (path: string, field: "citedPaper" | "citingPaper") => {
          const parsed = record(
            await get(path, new URLSearchParams({ fields: S2_LIST_FIELDS, limit: String(Math.min(1000, limit)) }), signal),
          );
          const data = Array.isArray(parsed.data) ? parsed.data : [];
          return data.flatMap((row) => {
            const paper = s2Record(record(row)[field]);
            return paper !== undefined ? [paper] : [];
          });
        };
        if (parts.has("references")) {
          next = { ...next, references: await list(`/graph/v1/paper/${paperId}/references`, "citedPaper") };
        }
        if (parts.has("citations")) {
          next = { ...next, citedBy: await list(`/graph/v1/paper/${paperId}/citations`, "citingPaper") };
        }
        if (parts.has("related")) {
          const parsed = record(
            await get(
              `/recommendations/v1/papers/forpaper/${paperId}`,
              new URLSearchParams({ fields: S2_LIST_FIELDS, limit: String(Math.min(500, limit)) }),
              signal,
            ),
          );
          const recommended = Array.isArray(parsed.recommendedPapers) ? parsed.recommendedPapers : [];
          next = {
            ...next,
            related: recommended.flatMap((row) => {
              const paper = s2Record(row);
              return paper !== undefined ? [paper] : [];
            }),
          };
        }
        found.set(requested, next);
      }
      return found;
    },
    async check(signal) {
      return runProbe(
        "semantic-scholar",
        {
          ...(signal !== undefined ? { signal } : {}),
          ...(key !== undefined ? { secrets: [key] } : {}),
          request: "graph/v1/paper/arXiv:1706.03762?fields=title (Attention Is All You Need)",
        },
        async (probe) => {
          // A record Semantic Scholar is known to hold (it has no entry for
          // some DOIs, e.g. 10.1038/nature14539).
          const parsed = record(
            await get("/graph/v1/paper/arXiv:1706.03762", new URLSearchParams({ fields: "title" }), probe),
          );
          const ok = /attention is all you need/i.test(asString(parsed.title) ?? "");
          return {
            ok,
            summary: "1 paper, known title found",
            ...(ok
              ? key === undefined
                ? { detail: "keyless (shared rate limit)" }
                : {}
              : { detail: "answered without the known paper" }),
          };
        },
      );
    },
  };
}
