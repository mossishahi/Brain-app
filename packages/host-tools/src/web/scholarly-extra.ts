/**
 * Literature-retrieval backends added for the paper-based panel composition:
 *
 * - Europe PMC: `query` search over its REST API (keyless), with the date
 *   window, open-access filter and sort mapped into the query syntax.
 * - CORE: `q` search over the open-access full-text index (API v3; needs an
 *   API key, otherwise the backend reports itself as needing one).
 * - OpenCitations: references and citations by DOI (Index API v2; keyless,
 *   an access token is optional). It has no search.
 *
 * They serve the host's own literature retrieval: the agents' paper_search
 * tool does not offer them, no default route lists them, and none of them
 * runs a launch check, so adding them changes nothing an agent sees.
 */
import type { PaperDetailPart, PaperDetailsEntry, PaperRecord } from "@brainstorm-agentic/core";

import { asNumber, asString, record, requestJson, type ProviderFetch } from "./providers.js";
import { loggingFetch, runProbe } from "./probe.js";
import type {
  NormalizedPaperQuery,
  PaperBackend,
  PaperBackendAnswer,
  PaperIdentifier,
  PaperOption,
} from "./scholarly.js";
import { htmlToText } from "../web-search.js";

/** Abstracts from these indexes are kept up to this many characters. */
const EXTRA_ABSTRACT_MAX_CHARS = 4_000;

function plainText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = /[<&]/.test(value) ? htmlToText(value).text : value;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact === "" ? undefined : compact;
}

function cappedAbstract(value: string | undefined): string | undefined {
  const text = plainText(value);
  if (text === undefined) return undefined;
  return text.length > EXTRA_ABSTRACT_MAX_CHARS ? `${text.slice(0, EXTRA_ABSTRACT_MAX_CHARS - 1)}…` : text;
}

function yearFrom(value: unknown): number | undefined {
  const number = asNumber(value);
  if (number !== undefined && Number.isInteger(number)) return number;
  const text = asString(value);
  const match = text !== undefined ? /^(\d{4})/.exec(text) : null;
  return match ? Number(match[1]) : undefined;
}

function compactRecord<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    out[key] = entry;
  }
  return out as T;
}

function skip(option: PaperOption, reason: string): { option: PaperOption; reason: string } {
  return { option, reason };
}

/** A quoted phrase in Lucene-style syntax (Europe PMC, CORE). */
function phrase(term: string): string {
  return `"${term.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

/**
 * Free text made safe for a Lucene-style query: field separators, grouping
 * and operator characters become spaces, and quotes are kept only when they
 * pair up (a phrase stays a phrase).
 */
function luceneText(text: string): string {
  let clean = text.replace(/[:()[\]{}\\^~*?!/]/g, " ");
  if ((clean.match(/"/g) ?? []).length % 2 !== 0) clean = clean.replace(/"/g, " ");
  return clean.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------------ */
/* Europe PMC                                                                */
/* ------------------------------------------------------------------------ */

function europePmcRecord(entry: unknown): PaperRecord | undefined {
  const item = record(entry);
  const rawTitle = plainText(asString(item.title));
  if (rawTitle === undefined) return undefined;
  const title = rawTitle.replace(/\.$/, "").trim();
  const doi = asString(item.doi)?.toLowerCase();
  const source = asString(item.source) ?? "MED";
  const id = asString(item.id);
  const journal = record(record(record(item.journalInfo).journal));
  const authors = (asString(item.authorString) ?? "")
    .replace(/\.$/, "")
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const date = asString(item.firstPublicationDate);
  return compactRecord({
    title,
    url:
      doi !== undefined
        ? `https://doi.org/${doi}`
        : `https://europepmc.org/article/${source}/${id ?? ""}`,
    authors: authors.length > 0 ? authors.slice(0, 25) : undefined,
    year: yearFrom(item.pubYear) ?? yearFrom(date),
    date: date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    venue: asString(journal.title),
    doi,
    pmid: asString(item.pmid),
    pmcid: asString(item.pmcid)?.toUpperCase(),
    citations: asNumber(item.citedByCount),
    openAccess: asString(item.isOpenAccess) !== undefined ? asString(item.isOpenAccess) === "Y" : undefined,
    type: asString(item.pubType),
    abstract: cappedAbstract(asString(item.abstractText)),
    source: "europepmc",
  });
}

export function europePmcBackend(options: {
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
} = {}): PaperBackend {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://www.ebi.ac.uk/europepmc/webservices/rest").replace(/\/+$/, "");
  return {
    id: "europepmc",
    minIntervalMs: 250,
    maxConcurrent: 2,
    ready: { ok: true },
    async search(query: NormalizedPaperQuery, signal?: AbortSignal): Promise<PaperBackendAnswer> {
      const applied: PaperOption[] = [];
      const skipped: { option: PaperOption; reason: string }[] = [];
      const clauses: string[] = [];
      if (query.native !== undefined) {
        clauses.push(`(${query.native})`);
        applied.push("native_query");
      }
      const text = query.query.trim();
      if (text !== "") {
        clauses.push(query.mode === "lookup" ? `TITLE:${phrase(text)}` : `(${luceneText(text) || phrase(text)})`);
        applied.push("query");
      }
      for (const term of query.titleContains) clauses.push(`TITLE:${phrase(term)}`);
      if (query.titleContains.length > 0) applied.push("title_contains");
      for (const term of query.abstractContains) clauses.push(`ABSTRACT:${phrase(term)}`);
      if (query.abstractContains.length > 0) applied.push("abstract_contains");
      for (const name of query.authors) clauses.push(`AUTH:${phrase(name)}`);
      if (query.authors.length > 0) applied.push("authors");
      if (query.dateFrom !== undefined || query.dateTo !== undefined) {
        clauses.push(`FIRST_PDATE:[${query.dateFrom ?? "1000-01-01"} TO ${query.dateTo ?? "3000-12-31"}]`);
        applied.push("date_range");
      }
      if (query.openAccessOnly) {
        clauses.push("OPEN_ACCESS:y");
        applied.push("open_access_only");
      }
      if (query.arxivCategories.length > 0) skipped.push(skip("arxiv_categories", "Europe PMC does not index arXiv categories"));
      if (query.fieldsOfStudy.length > 0) skipped.push(skip("fields_of_study", "Europe PMC has no field-of-study filter"));
      if (query.venues.length > 0) skipped.push(skip("venues", "venues are not mapped for Europe PMC"));
      if (query.types.length > 0) skipped.push(skip("types", "publication types are not mapped for Europe PMC"));
      if (query.minCitations !== undefined) skipped.push(skip("min_citations", "Europe PMC has no citation-count filter"));
      if (query.page > 1) skipped.push(skip("page", "Europe PMC pages by cursor; only the first page is served"));
      if (clauses.length === 0) {
        return { papers: [], applied, unsupported: [skip("query", "an empty Europe PMC query")] };
      }
      const params = new URLSearchParams({
        query: clauses.join(" AND "),
        format: "json",
        resultType: "core",
        pageSize: String(query.maxResults),
      });
      if (query.sort === "newest") params.set("sort", "P_PDATE_D desc");
      else if (query.sort === "oldest") params.set("sort", "P_PDATE_D asc");
      else if (query.sort === "most-cited") params.set("sort", "CITED desc");
      applied.push("sort");
      const parsed = record(
        await requestJson(
          fetchImpl,
          "europepmc",
          `${base}/search?${params.toString()}`,
          { method: "GET", headers: { accept: "application/json" } },
          signal,
        ),
      );
      const rows = record(parsed.resultList).result;
      const papers = (Array.isArray(rows) ? rows : []).flatMap((row) => {
        const paper = europePmcRecord(row);
        return paper !== undefined ? [paper] : [];
      });
      const total = asNumber(parsed.hitCount);
      return { papers, ...(total !== undefined ? { total } : {}), applied, unsupported: skipped };
    },
    async check(signal) {
      return runProbe(
        "europepmc",
        { ...(signal !== undefined ? { signal } : {}), request: "search?query=DOI:10.1038/nature14539 (Deep learning)" },
        async (probe) => {
          const params = new URLSearchParams({
            query: "DOI:10.1038/nature14539",
            format: "json",
            resultType: "lite",
            pageSize: "1",
          });
          const parsed = record(
            await requestJson(
              fetchImpl,
              "europepmc",
              `${base}/search?${params.toString()}`,
              { method: "GET", headers: { accept: "application/json" } },
              probe,
            ),
          );
          const rows = record(parsed.resultList).result;
          const titles = (Array.isArray(rows) ? rows : []).map((row) => asString(record(row).title) ?? "");
          const ok = titles.some((title) => /deep learning/i.test(title));
          return {
            ok,
            summary: `${titles.length} results, known title found`,
            ...(ok ? {} : { detail: "answered without the known paper" }),
          };
        },
      );
    },
  };
}

/* ------------------------------------------------------------------------ */
/* CORE                                                                      */
/* ------------------------------------------------------------------------ */

function coreRecord(entry: unknown): PaperRecord | undefined {
  const item = record(entry);
  const title = plainText(asString(item.title));
  if (title === undefined) return undefined;
  const id = asNumber(item.id) !== undefined ? String(asNumber(item.id)) : asString(item.id);
  const doi = asString(item.doi)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
  const arxivId = asString(item.arxivId)?.replace(/v\d+$/, "");
  const authors = (Array.isArray(item.authors) ? item.authors : []).flatMap((author) => {
    const name = asString(record(author).name);
    return name !== undefined ? [name] : [];
  });
  const journals = Array.isArray(item.journals) ? item.journals : [];
  const date = asString(item.publishedDate);
  const pdfUrl = asString(item.downloadUrl);
  return compactRecord({
    title,
    url:
      doi !== undefined
        ? `https://doi.org/${doi}`
        : id !== undefined
          ? `https://core.ac.uk/works/${id}`
          : (pdfUrl ?? "https://core.ac.uk/"),
    authors: authors.length > 0 ? authors.slice(0, 25) : undefined,
    year: yearFrom(item.yearPublished) ?? yearFrom(date),
    date: date !== undefined && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : undefined,
    venue: asString(record(journals[0]).title) ?? asString(item.publisher),
    doi,
    arxivId,
    pmid: asString(item.pubmedId),
    coreId: id,
    pdfUrl,
    openAccess: true,
    citations: asNumber(item.citationCount),
    type: asString(item.documentType),
    abstract: cappedAbstract(asString(item.abstract)),
    source: "core",
  });
}

export function coreBackend(options: {
  readonly apiKey?: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
} = {}): PaperBackend {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://api.core.ac.uk/v3").replace(/\/+$/, "");
  const key = options.apiKey !== undefined && options.apiKey.trim() !== "" ? options.apiKey.trim() : undefined;
  return {
    id: "core",
    // The registered free tier allows a few requests per minute.
    minIntervalMs: 6_000,
    maxConcurrent: 1,
    ready: key !== undefined ? { ok: true } : { ok: false, reason: "CORE needs an API key (coreApiKey in Settings)" },
    async search(query: NormalizedPaperQuery, signal?: AbortSignal): Promise<PaperBackendAnswer> {
      if (key === undefined) {
        return { papers: [], applied: [], unsupported: [skip("query", "CORE needs an API key")] };
      }
      const applied: PaperOption[] = [];
      const skipped: { option: PaperOption; reason: string }[] = [];
      const clauses: string[] = [];
      if (query.native !== undefined) {
        clauses.push(`(${query.native})`);
        applied.push("native_query");
      }
      const text = query.query.trim();
      if (text !== "") {
        clauses.push(query.mode === "lookup" ? `title:${phrase(text)}` : `(${luceneText(text) || phrase(text)})`);
        applied.push("query");
      }
      for (const term of query.titleContains) clauses.push(`title:${phrase(term)}`);
      if (query.titleContains.length > 0) applied.push("title_contains");
      for (const term of query.abstractContains) clauses.push(`abstract:${phrase(term)}`);
      if (query.abstractContains.length > 0) applied.push("abstract_contains");
      for (const name of query.authors) clauses.push(`authors:${phrase(name)}`);
      if (query.authors.length > 0) applied.push("authors");
      if (query.dateFrom !== undefined) clauses.push(`yearPublished>=${query.dateFrom.slice(0, 4)}`);
      if (query.dateTo !== undefined) clauses.push(`yearPublished<=${query.dateTo.slice(0, 4)}`);
      if (query.dateFrom !== undefined || query.dateTo !== undefined) applied.push("date_range");
      if (query.openAccessOnly) applied.push("open_access_only");
      if (query.sort !== "relevance") skipped.push(skip("sort", "only relevance order is mapped for CORE"));
      if (query.arxivCategories.length > 0) skipped.push(skip("arxiv_categories", "CORE does not index arXiv categories"));
      if (query.fieldsOfStudy.length > 0) skipped.push(skip("fields_of_study", "CORE has no field-of-study filter"));
      if (query.venues.length > 0) skipped.push(skip("venues", "venues are not mapped for CORE"));
      if (query.types.length > 0) skipped.push(skip("types", "publication types are not mapped for CORE"));
      if (query.minCitations !== undefined) skipped.push(skip("min_citations", "CORE has no citation-count filter"));
      if (clauses.length === 0) {
        return { papers: [], applied, unsupported: [skip("query", "an empty CORE query")] };
      }
      const params = new URLSearchParams({
        q: clauses.join(" AND "),
        limit: String(query.maxResults),
        offset: String((query.page - 1) * query.maxResults),
      });
      if (query.page > 1) applied.push("page");
      const parsed = record(
        await requestJson(
          fetchImpl,
          "core",
          `${base}/search/works?${params.toString()}`,
          { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${key}` } },
          signal,
          30_000,
        ),
      );
      const rows = Array.isArray(parsed.results) ? parsed.results : [];
      const papers = rows.flatMap((row) => {
        const paper = coreRecord(row);
        return paper !== undefined ? [paper] : [];
      });
      const total = asNumber(parsed.totalHits);
      return { papers, ...(total !== undefined ? { total } : {}), applied, unsupported: skipped };
    },
    async check(signal) {
      if (key === undefined) {
        const checkedAt = Date.now();
        return {
          id: "core",
          state: "needs-key",
          detail: "CORE needs an API key (coreApiKey in Settings)",
          checkedAt,
          log: [{ at: checkedAt, level: "warn" as const, text: "no CORE API key: not probed" }],
        };
      }
      return runProbe(
        "core",
        { ...(signal !== undefined ? { signal } : {}), secrets: [key], request: 'search/works?q=doi:"10.1038/nature14539" (Deep learning)' },
        async (probe) => {
          const params = new URLSearchParams({ q: 'doi:"10.1038/nature14539"', limit: "1" });
          const parsed = record(
            await requestJson(
              fetchImpl,
              "core",
              `${base}/search/works?${params.toString()}`,
              { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${key}` } },
              probe,
            ),
          );
          const rows = Array.isArray(parsed.results) ? parsed.results : [];
          const titles = rows.map((row) => asString(record(row).title) ?? "");
          const ok = titles.some((title) => /deep learning/i.test(title));
          return {
            ok,
            summary: `${titles.length} results, known title found`,
            ...(ok ? {} : { detail: "answered without the known paper" }),
          };
        },
      );
    },
  };
}

/* ------------------------------------------------------------------------ */
/* OpenCitations                                                             */
/* ------------------------------------------------------------------------ */

/** The identifiers of one side of an OpenCitations row ("omid:br/... doi:10... pmid:..."). */
function openCitationsRecord(value: unknown): PaperRecord | undefined {
  const ids = (asString(value) ?? "").split(/\s+/).filter((part) => part !== "");
  const pick = (prefix: string): string | undefined => {
    const hit = ids.find((part) => part.toLowerCase().startsWith(`${prefix}:`));
    return hit !== undefined ? hit.slice(prefix.length + 1) : undefined;
  };
  const doi = pick("doi")?.toLowerCase();
  if (doi === undefined) return undefined;
  const openAlexId = pick("openalex")?.toUpperCase();
  return compactRecord({
    title: "",
    url: `https://doi.org/${doi}`,
    doi,
    pmid: pick("pmid"),
    openAlexId,
    source: "opencitations",
  });
}

export function openCitationsBackend(options: {
  readonly accessToken?: string;
  readonly fetchImpl?: ProviderFetch;
  readonly baseUrl?: string;
} = {}): PaperBackend {
  const fetchImpl = loggingFetch(options.fetchImpl ?? (fetch as unknown as ProviderFetch));
  const base = (options.baseUrl ?? "https://api.opencitations.net/index/v2").replace(/\/+$/, "");
  const token =
    options.accessToken !== undefined && options.accessToken.trim() !== "" ? options.accessToken.trim() : undefined;
  const list = async (path: "references" | "citations", doi: string, side: "cited" | "citing", limit: number, signal?: AbortSignal) => {
    const parsed = await requestJson(
      fetchImpl,
      "opencitations",
      `${base}/${path}/doi:${encodeURIComponent(doi).replace(/%2F/gi, "/")}`,
      { method: "GET", headers: { accept: "application/json", ...(token !== undefined ? { authorization: token } : {}) } },
      signal,
    );
    const rows = Array.isArray(parsed) ? parsed : [];
    const seen = new Set<string>();
    const out: PaperRecord[] = [];
    for (const row of rows) {
      const paper = openCitationsRecord(record(row)[side]);
      if (paper === undefined || seen.has(paper.doi!)) continue;
      seen.add(paper.doi!);
      out.push(paper);
      if (out.length >= limit) break;
    }
    return out;
  };
  return {
    id: "opencitations",
    minIntervalMs: 350,
    maxConcurrent: 2,
    ready: { ok: true },
    async search(): Promise<PaperBackendAnswer> {
      return { papers: [], applied: [], unsupported: [skip("query", "OpenCitations serves references and citations only")] };
    },
    async details(
      ids: readonly PaperIdentifier[],
      parts: ReadonlySet<PaperDetailPart>,
      limit: number,
      signal?: AbortSignal,
    ): Promise<ReadonlyMap<string, PaperDetailsEntry>> {
      const found = new Map<string, PaperDetailsEntry>();
      for (const id of ids) {
        if (id.kind !== "doi") continue;
        let entry: PaperDetailsEntry = {
          requested: id.raw,
          title: "",
          url: `https://doi.org/${id.value}`,
          doi: id.value,
          source: "opencitations",
        };
        if (parts.has("references")) entry = { ...entry, references: await list("references", id.value, "cited", limit, signal) };
        if (parts.has("citations")) entry = { ...entry, citedBy: await list("citations", id.value, "citing", limit, signal) };
        found.set(id.raw, entry);
      }
      return found;
    },
    async check(signal) {
      return runProbe(
        "opencitations",
        {
          ...(signal !== undefined ? { signal } : {}),
          ...(token !== undefined ? { secrets: [token] } : {}),
          request: "references/doi:10.1038/nature14539 (Deep learning)",
        },
        async (probe) => {
          const references = await list("references", "10.1038/nature14539", "cited", 5, probe);
          const ok = references.length > 0;
          return {
            ok,
            summary: `${references.length} references of the known paper`,
            ...(ok ? {} : { detail: "answered without references for the known paper" }),
          };
        },
      );
    },
  };
}
