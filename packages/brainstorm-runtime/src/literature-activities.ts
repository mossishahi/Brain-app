/**
 * The paper-based panel composition's activities (spec v2):
 *
 * - `literature.retrieve` — Steps 1-5: the needs, the query plan per route
 *   and round, federated retrieval through the host web layer (one source per
 *   call, a per-run budget, a probe that marks a rate-limiting source
 *   unavailable), the same-paper merge with reciprocal-rank fusion, and the
 *   placement of every eligible paper into the taxonomy with its similarity
 *   to every need. Not reproducible across time (the sources change); given
 *   the call cache, a rerun is identical.
 * - `literature.noScreen` — the empty screen when the relevance screen is off.
 * - `panel.compose` — Steps 6-11 over the literature (see panel-compose.ts).
 * - `panel.seat` — the first k seats as the existing panel artifact.
 *
 * Without web access the retrieval returns an empty record noting it;
 * without a neural encoder it falls back to hash-ngram-v1 and records it.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  EncodeMode,
  EncoderManifest,
  EncoderProvider,
  JsonObject,
  JsonValue,
  NodeTextsAccess,
  NodeVectorIndex,
  PaperDetailsAnswer,
  PaperDetailsQuery,
  PaperRecord,
  PaperSearchAnswer,
  PaperSearchQuery,
  PaperSource,
  TaxonomyAccess,
  TextEncoder,
  WebAccess,
  WebAccessCallContext,
} from "@brainstorm-agentic/core";
import { EMBEDDER_DIM, EMBEDDER_ID, EMBEDDER_MANIFEST, embedText } from "@brainstorm-agentic/core";

import type { DeterministicActivityContext, DeterministicActivityHandler } from "./compiler.js";
import {
  compareText,
  composeInputFromLiterature,
  composePanelEvidence,
  linearQuantile,
  marginWeights,
  panelCompositionParams,
  round6,
  seatPanel,
  topicHierarchy,
  type ComposeInput,
  type PanelCompositionParams,
  type TopicHierarchy,
} from "./panel-compose.js";

/* ------------------------------------------------------------------------ */
/* Dependencies                                                              */
/* ------------------------------------------------------------------------ */

export interface LiteratureActivityDeps {
  /** The host web layer (paper_search / paper_details); absent = no web access. */
  readonly web?: WebAccess;
  /** The shared taxonomy: hierarchy, revision and topic names. */
  readonly taxonomy?: TaxonomyAccess;
  /** Neural encoders and node vectors; absent = the hash-ngram-v1 fallback. */
  readonly encoders?: EncoderProvider;
  /** The bundle's node texts (catalog/taxonomy-texts.json). */
  readonly nodeTexts?: NodeTextsAccess;
  /** Directory for the per-call retrieval cache (absent = in memory only). */
  readonly cacheDir?: string;
  /** Clock (ms), for the cache's lifetime. */
  readonly now?: () => number;
  /**
   * Key-gated sources whose host key is configured ("openalex", "core",
   * "semantic-scholar"). OpenAlex is never called without its key, so an
   * absent set means OpenAlex needs one.
   */
  readonly keyedSources?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------------ */
/* hash-ngram-v1 fallback encoder                                            */
/* ------------------------------------------------------------------------ */

export const HASH_NGRAM_ENCODER_ID = EMBEDDER_ID;

const HASH_MANIFEST: EncoderManifest = {
  id: EMBEDDER_ID,
  dim: EMBEDDER_DIM,
  version: EMBEDDER_MANIFEST.version,
  models: {},
  pooling: "mean",
  docFormat: "{title}. {body}",
  queryFormat: "{text}",
  verification: [],
};

/** The dependency-free hash-ngram-v1 embedder as a TextEncoder (both modes embed the text as given). */
export function hashNgramTextEncoder(): TextEncoder {
  return {
    manifest: HASH_MANIFEST,
    async embed(texts: readonly string[], _mode: EncodeMode, signal?: AbortSignal): Promise<Float32Array[]> {
      signal?.throwIfAborted();
      return texts.map((text) => Float32Array.from(embedText([{ text, weight: 1 }])));
    },
  };
}

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Node vectors computed from node texts with any encoder (documents, as given). */
export async function computeNodeIndex(
  encoder: TextEncoder,
  taxonomyRevision: number,
  texts: ReadonlyArray<{ id: string; text: string }>,
): Promise<NodeVectorIndex> {
  const dim = encoder.manifest.dim;
  const vectors = new Float32Array(texts.length * dim);
  const batch = 256;
  for (let start = 0; start < texts.length; start += batch) {
    const slice = texts.slice(start, start + batch);
    const embedded = await encoder.embed(slice.map((entry) => entry.text), "doc");
    embedded.forEach((vector, offset) => vectors.set(vector.subarray(0, dim), (start + offset) * dim));
  }
  return {
    encoderId: encoder.manifest.id,
    taxonomyRevision,
    nodeTextsSha256: sha256(JSON.stringify(texts.map((entry) => [entry.id, entry.text]))),
    vectorsSha256: sha256(new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength)),
    ids: texts.map((entry) => entry.id),
    dim,
    vectors,
  };
}

/** An EncoderProvider offering only hash-ngram-v1 (the worker's fallback without the encoder package). */
export function hashNgramEncoderProvider(): EncoderProvider {
  const encoder = hashNgramTextEncoder();
  const indexes = new Map<string, Promise<NodeVectorIndex>>();
  return {
    async encoder(id: string) {
      return id === EMBEDDER_ID
        ? encoder
        : { unavailable: `encoder "${id}" is not installed on this host (only ${EMBEDDER_ID} is)` };
    },
    nodeIndex(enc, taxonomyRevision, texts) {
      const key = `${enc.manifest.id}\u0000${taxonomyRevision}\u0000${sha256(JSON.stringify(texts.map((entry) => [entry.id, entry.text])))}`;
      let pending = indexes.get(key);
      if (pending === undefined) {
        pending = computeNodeIndex(enc, taxonomyRevision, texts);
        indexes.set(key, pending);
      }
      return pending;
    },
  };
}

/** A document as the encoder expects it: docFormat with {title} and {body} filled in. */
export function formatDocument(manifest: Pick<EncoderManifest, "docFormat">, title: string, body: string): string {
  const template = /\{(title|body)\}/.test(manifest.docFormat) ? manifest.docFormat : "{title}. {body}";
  return template
    .replace(/\{(title|body)\}/g, (_match, key: string) => (key === "title" ? title : body))
    .trim();
}

/* ------------------------------------------------------------------------ */
/* Step 1: needs                                                             */
/* ------------------------------------------------------------------------ */

export interface LiteratureNeed {
  readonly id: number;
  readonly kind: "core" | "facet" | "formulation" | "equivalent";
  readonly name: string;
  readonly text: string;
  readonly weight: number;
  readonly mode: EncodeMode;
}

/** A retrieval item: a need, or a weight-0 entry that only feeds retrieval (id null). */
export interface RetrievalItem extends Omit<LiteratureNeed, "id"> {
  readonly id: number | null;
  /** The statement-route text of the item (abstract, statement, formulation). */
  readonly statement?: string;
  /** Facet aliases (classifier v2). */
  readonly aliases?: readonly string[];
}

interface EmbeddingInputView {
  readonly title: string;
  readonly abstract: string;
  readonly facets: ReadonlyArray<{ readonly name: string; readonly statement: string; readonly relevance: number; readonly aliases?: readonly string[] }>;
  readonly problemFormulation?: string;
  readonly equivalentProblems?: ReadonlyArray<{ readonly field: string; readonly name: string; readonly statement: string; readonly confidence: number }>;
  readonly keyTerms?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asList(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function str(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/** The classifier's embeddingInput, read defensively (v1 and v2 outputs). */
export function embeddingInputOf(classification: JsonValue | undefined): EmbeddingInputView {
  const source = isRecord(classification) && isRecord(classification.embeddingInput)
    ? classification.embeddingInput
    : isRecord(classification)
      ? classification
      : {};
  const facets = asList(source.facets).filter(isRecord).map((facet) => ({
    name: str(facet.name),
    statement: str(facet.statement),
    relevance: typeof facet.relevance === "number" ? facet.relevance : 0,
    ...(Array.isArray(facet.aliases) ? { aliases: facet.aliases.filter((alias): alias is string => typeof alias === "string") } : {}),
  }));
  const equivalents = asList(source.equivalentProblems).filter(isRecord).map((entry) => ({
    field: str(entry.field),
    name: str(entry.name),
    statement: str(entry.statement),
    confidence: typeof entry.confidence === "number" ? entry.confidence : 0,
  }));
  return {
    title: str(source.title),
    abstract: str(source.abstract),
    facets,
    ...(typeof source.problemFormulation === "string" ? { problemFormulation: source.problemFormulation } : {}),
    ...(equivalents.length > 0 ? { equivalentProblems: equivalents } : {}),
    ...(Array.isArray(source.keyTerms) ? { keyTerms: source.keyTerms.filter((term): term is string => typeof term === "string") } : {}),
  };
}

/**
 * F = core (coreWeight) + facets (relevance) + formulation
 * (formulationWeight, when present and > 0) + equivalent problems
 * (equivalentProblemWeight x confidence, when > 0). Weight-0 entries are not
 * needs but stay retrieval items (routes B and C).
 */
export function buildNeeds(
  ei: EmbeddingInputView,
  params: PanelCompositionParams,
): { readonly needs: readonly LiteratureNeed[]; readonly items: readonly RetrievalItem[]; readonly W: number } {
  const items: RetrievalItem[] = [];
  let next = 0;
  const add = (item: Omit<RetrievalItem, "id">, isNeed: boolean): void => {
    items.push({ ...item, id: isNeed ? next++ : null });
  };
  add({ kind: "core", name: "core", text: `${ei.title}. ${ei.abstract}`, weight: params.coreWeight, mode: "doc", statement: ei.abstract }, true);
  for (const facet of ei.facets) {
    add(
      {
        kind: "facet",
        name: facet.name,
        text: `${facet.name}: ${facet.statement}`,
        weight: facet.relevance,
        mode: "query",
        statement: facet.statement,
        ...(facet.aliases !== undefined ? { aliases: facet.aliases } : {}),
      },
      true,
    );
  }
  if (ei.problemFormulation !== undefined && ei.problemFormulation.trim() !== "") {
    const weight = params.formulationWeight;
    add(
      { kind: "formulation", name: "problem formulation", text: ei.problemFormulation, weight: weight > 0 ? weight : 0, mode: "doc", statement: ei.problemFormulation },
      weight > 0,
    );
  }
  for (const entry of ei.equivalentProblems ?? []) {
    const weight = params.equivalentProblemWeight * entry.confidence;
    add(
      { kind: "equivalent", name: entry.name, text: `${entry.name}: ${entry.statement}`, weight: weight > 0 ? weight : 0, mode: "query", statement: entry.statement },
      weight > 0,
    );
  }
  const needs = items.filter((item): item is RetrievalItem & { id: number } => item.id !== null).map((item) => ({
    id: item.id,
    kind: item.kind,
    name: item.name,
    text: item.text,
    weight: item.weight,
    mode: item.mode,
  }));
  let W = 0;
  for (const need of needs) W += need.weight;
  return { needs, items, W };
}

/* ------------------------------------------------------------------------ */
/* Sources                                                                   */
/* ------------------------------------------------------------------------ */

/** Search sources in their canonical order. */
export const LITERATURE_SEARCH_SOURCES = ["arxiv", "crossref", "semantic-scholar", "openalex", "europepmc", "core"] as const;
/** Sources that accept long statement queries (route B). */
export const SEMANTIC_SOURCES: ReadonlySet<string> = new Set(["semantic-scholar", "openalex", "core"]);
/** Citation-capable sources (route D), in the order they are asked. */
export const CITATION_SOURCES = ["openalex", "semantic-scholar", "opencitations"] as const;
/** Sources that resolve a missing abstract by id. */
export const ABSTRACT_SOURCES = ["semantic-scholar", "openalex", "crossref", "arxiv"] as const;

const SOURCE_PARAM: Readonly<Record<string, keyof PanelCompositionParams>> = {
  arxiv: "sourceArxiv",
  crossref: "sourceCrossref",
  "semantic-scholar": "sourceSemanticScholar",
  openalex: "sourceOpenAlex",
  europepmc: "sourceEuropePmc",
  core: "sourceCore",
  opencitations: "sourceOpenCitations",
};

export type SourceState = "available" | "needs-key" | "unavailable" | "disabled";

export interface SourceEntry {
  readonly id: string;
  state: SourceState;
  detail?: string;
}

/**
 * Each source's state at the start of a run: disabled by its param, needs-key
 * without its host key (OpenAlex is never called keyless), unavailable when
 * the deployment does not configure it; otherwise available until its first
 * call fails with 429/401/403.
 */
export function initialSourceStates(
  params: PanelCompositionParams,
  web: WebAccess | undefined,
  keyedSources: ReadonlySet<string> | undefined,
): SourceEntry[] {
  const status = new Map((web?.status?.() ?? []).map((entry) => [entry.id, entry]));
  return [...LITERATURE_SEARCH_SOURCES, "opencitations"].map((id) => {
    if (params[SOURCE_PARAM[id]!] !== true) return { id, state: "disabled" as SourceState };
    if (web === undefined || web.searchPapers === undefined) {
      return { id, state: "unavailable" as SourceState, detail: "no web access" };
    }
    const current = status.get(id);
    if (web.status !== undefined && current === undefined) {
      return { id, state: "unavailable" as SourceState, detail: "not configured on this deployment" };
    }
    if (id === "openalex" && keyedSources?.has("openalex") !== true) {
      return { id, state: "needs-key" as SourceState, detail: "OpenAlex is never called without an API key" };
    }
    if (current?.state === "needs-key" || current?.state === "not-configured") {
      return { id, state: "needs-key" as SourceState, ...(current.detail !== undefined ? { detail: current.detail } : {}) };
    }
    return { id, state: "available" as SourceState };
  });
}

/** True for a failure that marks a source unavailable for the rest of the run. */
export function isBlockingFailure(message: string): boolean {
  return /\bHTTP (429|401|403)\b/.test(message);
}

/* ------------------------------------------------------------------------ */
/* Step 2: query plan                                                        */
/* ------------------------------------------------------------------------ */

export type LiteratureRoute =
  | "title"
  | "facet"
  | "alias"
  | "pair"
  | "statement"
  | "equivalent"
  | "knn"
  | "citation"
  | "feedback"
  | "keyterm";

export interface PlannedQuery {
  readonly id: string;
  readonly text: string;
  readonly route: LiteratureRoute;
  readonly round: number;
  readonly own: number | null;
  readonly sources: readonly string[];
  /** Pair queries: the two names (arXiv ANDs them as phrases). */
  readonly pair?: readonly [string, string];
}

/** Lower-cased, whitespace-collapsed: the dedupe form of a query. */
export function normalizeQuery(text: string): string {
  return text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** The query registry of one run: ids in plan order, duplicates dropped. */
export class QueryPlan {
  readonly queries: PlannedQuery[] = [];
  private readonly seen = new Set<string>();

  has(text: string): boolean {
    return this.seen.has(normalizeQuery(text));
  }

  /** True when the phrase is a used query or a word-bounded part of one. */
  covers(phrase: string): boolean {
    const key = normalizeQuery(phrase);
    if (this.seen.has(key)) return true;
    for (const used of this.seen) if (` ${used} `.includes(` ${key} `)) return true;
    return false;
  }

  add(entry: Omit<PlannedQuery, "id">): PlannedQuery | undefined {
    const text = entry.text.split(/\s+/).filter(Boolean).join(" ");
    const key = normalizeQuery(text);
    if (key === "" || this.seen.has(key)) return undefined;
    this.seen.add(key);
    const query: PlannedQuery = { ...entry, text, id: `q${this.queries.length + 1}` };
    this.queries.push(query);
    return query;
  }
}

/** Facet pairs for route F: off, central (v1 rule) or all (ranked by r_i r_j). */
export function facetPairs(
  facets: ReadonlyArray<{ readonly name: string; readonly relevance: number; readonly need: number }>,
  mode: string,
  maxPairs: number,
): Array<{ readonly a: number; readonly b: number; readonly own: number }> {
  if (mode === "off" || facets.length < 2) return [];
  if (mode === "central") {
    return facets.map((_, i) => {
      const partner = i === 0 ? 1 : 0;
      return { a: i, b: partner, own: facets[i]!.need };
    });
  }
  const pairs: Array<{ a: number; b: number; own: number; score: number }> = [];
  for (let i = 0; i < facets.length; i += 1) {
    for (let j = i + 1; j < facets.length; j += 1) {
      const fi = facets[i]!;
      const fj = facets[j]!;
      // The pair's own need is its first (more central) facet.
      pairs.push({ a: i, b: j, own: fi.need, score: fi.relevance * fj.relevance });
    }
  }
  pairs.sort((x, y) => (x.score !== y.score ? y.score - x.score : x.a !== y.a ? x.a - y.a : x.b - y.b));
  return pairs.slice(0, Math.max(0, maxPairs)).map(({ a, b, own }) => ({ a, b, own }));
}

/**
 * Round 1 (seed) queries in route order, built without any retrieval: title,
 * facet names, aliases, pairs, equivalent-problem names, key terms, then the
 * statement queries (route B, semantic-capable sources only). Route C
 * (kNN) is appended by the caller, which holds the encoder.
 */
export function planSeedQueries(
  plan: QueryPlan,
  ei: EmbeddingInputView,
  items: readonly RetrievalItem[],
  params: PanelCompositionParams,
  searchSources: readonly string[],
): void {
  const semantic = searchSources.filter((source) => SEMANTIC_SOURCES.has(source));
  const facetItems = items.filter((item) => item.kind === "facet");
  const facetNeed = (index: number): number | null => facetItems[index]?.id ?? null;
  if (params.routeTitle) plan.add({ text: ei.title, route: "title", round: 1, own: 0, sources: searchSources });
  if (params.routeFacetNames) {
    ei.facets.forEach((facet, index) =>
      plan.add({ text: facet.name, route: "facet", round: 1, own: facetNeed(index), sources: searchSources }),
    );
  }
  if (params.routeFacetAliases) {
    ei.facets.forEach((facet, index) => {
      for (const alias of facet.aliases ?? []) {
        plan.add({ text: alias, route: "alias", round: 1, own: facetNeed(index), sources: searchSources });
      }
    });
  }
  const pairs = facetPairs(
    ei.facets.map((facet, index) => ({ name: facet.name, relevance: facet.relevance, need: facetNeed(index) ?? 0 })),
    params.routePairs,
    params.maxPairQueries,
  );
  for (const pair of pairs) {
    const a = ei.facets[pair.a]!.name;
    const b = ei.facets[pair.b]!.name;
    plan.add({ text: `${a} ${b}`, route: "pair", round: 1, own: pair.own, sources: searchSources, pair: [a, b] });
  }
  if (params.routeEquivalents) {
    const equivalents = items.filter((item) => item.kind === "equivalent");
    for (const item of equivalents) {
      plan.add({ text: item.name, route: "equivalent", round: 1, own: item.id, sources: searchSources });
    }
  }
  if (params.routeKeyTerms) {
    for (const term of ei.keyTerms ?? []) plan.add({ text: term, route: "keyterm", round: 1, own: null, sources: searchSources });
  }
  if (params.routeStatements && semantic.length > 0) {
    for (const item of items) {
      const statement = item.kind === "core" ? ei.abstract : item.statement;
      if (statement === undefined || statement.trim() === "") continue;
      plan.add({ text: statement, route: "statement", round: 1, own: item.id, sources: semantic });
    }
  }
}

/** One quoted arXiv term: a phrase for several words, the bare word otherwise. */
function arxivAll(text: string): string {
  const clean = text.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
  return /\s/.test(clean) ? `all:"${clean}"` : `all:${clean}`;
}

/** Routes whose query is a name (a phrase where the source supports phrases). */
const NAME_ROUTES: ReadonlySet<LiteratureRoute> = new Set(["facet", "alias", "equivalent", "knn", "keyterm", "feedback"]);

/**
 * The paper_search request of one (query, source) call in that source's own
 * syntax (spec v2, Step 2): arXiv phrases (an AND of two phrases for pairs),
 * Crossref query.bibliographic, Semantic Scholar without hyphens, plain text
 * elsewhere.
 */
export function sourceRequest(
  query: PlannedQuery,
  source: string,
  params: PanelCompositionParams,
  page = 1,
  maxResults = Math.min(25, params.resultsPerCall),
): PaperSearchQuery {
  const base = {
    mode: "topic" as const,
    sources: [source as PaperSource],
    sort: "relevance" as const,
    maxResults,
    ...(page > 1 ? { page } : {}),
    ...(params.yearFrom > 0 ? { dateFrom: String(Math.trunc(params.yearFrom)) } : {}),
  };
  if (source === "arxiv") {
    if (query.route === "pair" && query.pair !== undefined) {
      return { ...base, query: "", native: { source: "arxiv", query: `${arxivAll(query.pair[0])} AND ${arxivAll(query.pair[1])}` } };
    }
    if (NAME_ROUTES.has(query.route)) {
      return { ...base, query: "", native: { source: "arxiv", query: arxivAll(query.text) } };
    }
    return { ...base, query: query.text };
  }
  if (source === "crossref") {
    return {
      ...base,
      query: "",
      native: { source: "crossref", query: new URLSearchParams({ "query.bibliographic": query.text }).toString() },
    };
  }
  if (source === "semantic-scholar") return { ...base, query: query.text.replace(/-/g, " ") };
  if (source === "europepmc" || source === "core") {
    // Lucene-style indexes: a quoted phrase for a name, an AND of two
    // phrases for a pair (sent as native syntax, which passes unchanged).
    const quoted = (text: string): string => {
      const clean = text.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
      return /\s/.test(clean) ? `"${clean}"` : clean;
    };
    if (query.route === "pair" && query.pair !== undefined) {
      return { ...base, query: "", native: { source: source as Exclude<PaperSource, "web">, query: `${quoted(query.pair[0])} AND ${quoted(query.pair[1])}` } };
    }
    if (NAME_ROUTES.has(query.route) && /\s/.test(query.text.trim())) {
      return { ...base, query: "", native: { source: source as Exclude<PaperSource, "web">, query: quoted(query.text) } };
    }
  }
  return { ...base, query: query.text };
}

/* ------------------------------------------------------------------------ */
/* Steps 3-4: records and the same-paper merge                               */
/* ------------------------------------------------------------------------ */

/** One ranked record of one call. */
export interface LiteratureRecord {
  readonly source: string;
  readonly query: string;
  readonly rank: number;
  readonly round: number;
  readonly route: LiteratureRoute;
  readonly title: string;
  readonly abstract?: string;
  readonly year?: number;
  readonly venue?: string;
  readonly type?: string;
  readonly doi?: string;
  readonly arxivId?: string;
  readonly pmid?: string;
  readonly s2Id?: string;
  readonly oaId?: string;
  readonly coreId?: string;
}

/** Crossref types that are not papers (peer reviews, components, containers...). */
export const CROSSREF_NON_PAPER_TYPES: ReadonlySet<string> = new Set([
  "peer-review",
  "component",
  "other",
  "grant",
  "journal",
  "journal-issue",
  "journal-volume",
  "proceedings",
  "proceedings-series",
  "book-series",
  "book-set",
  "report-series",
  "standard-series",
  "database",
]);

/** A record the normalisation drops from the merge (a Crossref non-paper). */
export function isNonPaperRecord(record: LiteratureRecord): boolean {
  return record.source === "crossref" && record.type !== undefined && CROSSREF_NON_PAPER_TYPES.has(record.type);
}

/** ASCII-folded, lower-case letters and digits, single-spaced. */
export function normalizeLiteratureTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** DOI without resolver prefix, lower-cased. */
export function normalizeDoi(doi: string | undefined): string | undefined {
  if (doi === undefined) return undefined;
  const clean = doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
  return clean === "" ? undefined : clean;
}

/** arXiv id without version. */
export function normalizeArxivId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const clean = id.trim().replace(/^arxiv:\s*/i, "").replace(/v\d+$/, "");
  return clean === "" ? undefined : clean;
}

/** A host PaperRecord as a literature record of one call. */
export function recordFromPaper(
  paper: PaperRecord,
  call: { readonly source: string; readonly query: string; readonly rank: number; readonly round: number; readonly route: LiteratureRoute },
): LiteratureRecord {
  let doi = normalizeDoi(paper.doi);
  let arxivId = normalizeArxivId(paper.arxivId);
  const arxivDoi = doi !== undefined ? /^10\.48550\/arxiv\.(.+)$/.exec(doi) : null;
  if (arxivDoi) {
    arxivId = arxivId ?? normalizeArxivId(arxivDoi[1]!);
    doi = undefined;
  }
  const abstract = paper.abstract?.replace(/\s+/g, " ").trim();
  return {
    ...call,
    title: paper.title.replace(/\s+/g, " ").trim(),
    ...(abstract !== undefined && abstract !== "" ? { abstract } : {}),
    ...(typeof paper.year === "number" ? { year: paper.year } : {}),
    ...(paper.venue !== undefined && paper.venue !== "" ? { venue: paper.venue } : {}),
    ...(paper.type !== undefined ? { type: paper.type } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(arxivId !== undefined ? { arxivId } : {}),
    ...(paper.pmid !== undefined ? { pmid: paper.pmid } : {}),
    ...(paper.semanticScholarId !== undefined ? { s2Id: paper.semanticScholarId } : {}),
    ...(paper.openAlexId !== undefined ? { oaId: paper.openAlexId } : {}),
    ...(paper.coreId !== undefined ? { coreId: paper.coreId } : {}),
  };
}

export interface MergedPaper {
  readonly cid: string;
  readonly title: string;
  readonly year?: number;
  readonly venue?: string;
  readonly ids: { doi?: string; arxivId?: string; pmid?: string; s2Id?: string; oaId?: string; coreId?: string };
  readonly sources: readonly string[];
  readonly routes: readonly string[];
  readonly rounds: readonly number[];
  readonly hits: ReadonlyArray<{ readonly source: string; readonly query: string; readonly rank: number }>;
  readonly rrf: number;
  readonly abstract?: string;
  readonly abstractChars: number;
  /** A Crossref non-paper group (decision excluded:type). */
  readonly nonPaper: boolean;
}

const ID_FIELDS = ["doi", "arxivId", "pmid", "s2Id", "oaId", "coreId"] as const;

/**
 * Same-paper merge (spec Step 4): records sharing any identifier — DOI
 * (an arXiv DOI counts as its arXiv id), arXiv id without version, PMID,
 * Semantic Scholar, OpenAlex or CORE id — or an equal normalised title
 * (15+ characters) with years at most 1 apart are one paper (union-find,
 * the smaller record index as root). Crossref non-paper records never merge
 * with papers. RRF counts at most the best rank per (query, source).
 * Papers are returned in (RRF desc, canonical id) order.
 */
export function mergeLiteratureRecords(records: readonly LiteratureRecord[]): MergedPaper[] {
  const parent = records.map((_, index) => index);
  const find = (x: number): number => {
    let node = x;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]!]!;
      node = parent[node]!;
    }
    return node;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  // Two namespaces: papers, and dropped non-paper records (merged only among themselves).
  const keyed = new Map<string, number>();
  const key = (name: string, index: number): void => {
    const existing = keyed.get(name);
    if (existing === undefined) keyed.set(name, index);
    else union(existing, index);
  };
  const byTitle = new Map<string, number[]>();
  records.forEach((record, index) => {
    const space = isNonPaperRecord(record) ? "x:" : "";
    if (record.doi !== undefined) key(`${space}doi:${record.doi}`, index);
    if (record.arxivId !== undefined) key(`${space}arxiv:${record.arxivId.toLowerCase()}`, index);
    if (record.pmid !== undefined) key(`${space}pmid:${record.pmid}`, index);
    if (record.s2Id !== undefined) key(`${space}s2:${record.s2Id}`, index);
    if (record.oaId !== undefined) key(`${space}oa:${record.oaId}`, index);
    if (record.coreId !== undefined) key(`${space}core:${record.coreId}`, index);
  });
  records.forEach((record, index) => {
    if (isNonPaperRecord(record)) return;
    const title = normalizeLiteratureTitle(record.title);
    if (title.length < 15) return;
    const earlier = byTitle.get(title) ?? [];
    for (const other of earlier) {
      const year = record.year;
      const otherYear = records[other]!.year;
      if (year === undefined || otherYear === undefined || Math.abs(year - otherYear) <= 1) union(other, index);
    }
    earlier.push(index);
    byTitle.set(title, earlier);
  });
  const groups = new Map<number, number[]>();
  records.forEach((_, index) => {
    const root = find(index);
    const members = groups.get(root) ?? [];
    members.push(index);
    groups.set(root, members);
  });
  const roots = [...groups.keys()].sort((a, b) => a - b);
  const merged: MergedPaper[] = roots.map((root) => {
    const group = groups.get(root)!.map((index) => records[index]!);
    const ids: Record<string, string> = {};
    const distinct: Record<string, number> = {};
    for (const field of ID_FIELDS) {
      const values = [...new Set(group.map((record) => record[field]).filter((value): value is string => value !== undefined))].sort(compareText);
      if (values.length > 0) {
        ids[field] = values[0]!;
        distinct[field] = values.length;
      }
    }
    const single = (field: (typeof ID_FIELDS)[number]): string | undefined => (distinct[field] === 1 ? ids[field] : undefined);
    const firstTitle = group[0]!.title;
    let title = firstTitle;
    for (const record of group) if (record.title.length > title.length) title = record.title;
    const cid =
      single("doi") !== undefined
        ? `doi:${single("doi")}`
        : single("arxivId") !== undefined
          ? `arxiv:${single("arxivId")}`
          : single("s2Id") !== undefined
            ? `s2:${single("s2Id")}`
            : single("oaId") !== undefined
              ? `oa:${single("oaId")}`
              : single("coreId") !== undefined
                ? `core:${single("coreId")}`
                : `title:${normalizeLiteratureTitle(firstTitle).slice(0, 60)}`;
    const best = new Map<string, { source: string; query: string; rank: number }>();
    for (const record of group) {
      const hitKey = `${record.query}\u0000${record.source}`;
      const current = best.get(hitKey);
      if (current === undefined) best.set(hitKey, { source: record.source, query: record.query, rank: record.rank });
      else if (record.rank < current.rank) current.rank = record.rank;
    }
    const hits = [...best.values()];
    let rrf = 0;
    for (const hit of hits) rrf += 1 / (60 + hit.rank);
    let abstract: string | undefined;
    for (const record of group) {
      if (record.abstract !== undefined && (abstract === undefined || record.abstract.length > abstract.length)) abstract = record.abstract;
    }
    const years = group.map((record) => record.year).filter((year): year is number => year !== undefined);
    const venue =
      group.find((record) => record.venue !== undefined && record.venue !== "arXiv")?.venue ??
      (group.some((record) => record.venue === "arXiv") ? "arXiv" : undefined);
    return {
      cid,
      title,
      ...(years.length > 0 ? { year: Math.min(...years) } : {}),
      ...(venue !== undefined ? { venue } : {}),
      ids,
      sources: [...new Set(group.map((record) => record.source))].sort(compareText),
      routes: [...new Set(group.map((record) => record.route))].sort(compareText),
      rounds: [...new Set(group.map((record) => record.round))].sort((a, b) => a - b),
      hits,
      rrf: round6(rrf),
      ...(abstract !== undefined ? { abstract } : {}),
      abstractChars: abstract?.length ?? 0,
      nonPaper: group.every(isNonPaperRecord),
    };
  });
  // Stable: equal (rrf, cid) keep the group order.
  return merged.sort((a, b) => (a.rrf !== b.rrf ? b.rrf - a.rrf : compareText(a.cid, b.cid)));
}

export type PaperDecision =
  | "eligible"
  | "excluded:no-abstract"
  | "excluded:short-abstract"
  | "excluded:cap"
  | "excluded:type";

/** Eligibility in fused-rank order: an abstract of minAbstractChars, at most maxPapers. */
export function paperDecisions(papers: readonly MergedPaper[], minAbstractChars: number, maxPapers: number): PaperDecision[] {
  let eligible = 0;
  return papers.map((paper) => {
    if (paper.nonPaper) return "excluded:type";
    if (paper.abstract === undefined) return "excluded:no-abstract";
    if (paper.abstractChars < minAbstractChars) return "excluded:short-abstract";
    eligible += 1;
    return eligible <= maxPapers ? "eligible" : "excluded:cap";
  });
}

/* ------------------------------------------------------------------------ */
/* Step 5: placement; route C (kNN)                                          */
/* ------------------------------------------------------------------------ */

function dot(vectors: Float32Array, row: number, dim: number, query: Float32Array): number {
  let total = 0;
  const offset = row * dim;
  for (let i = 0; i < dim; i += 1) total += vectors[offset + i]! * query[i]!;
  return total;
}

/** Rounded similarities of one vector to every node, in node order. */
export function nodeSimilarities(index: NodeVectorIndex, vector: Float32Array): number[] {
  const out = new Array<number>(index.ids.length);
  for (let row = 0; row < index.ids.length; row += 1) out[row] = round6(dot(index.vectors, row, index.dim, vector));
  return out;
}

/** The `count` best rows by (similarity desc, node order). */
export function topRows(similarities: readonly number[], count: number): number[] {
  const best: number[] = [];
  for (let row = 0; row < similarities.length; row += 1) {
    const value = similarities[row]!;
    if (best.length === count && value <= similarities[best[best.length - 1]!]!) continue;
    let at = best.length;
    while (at > 0 && similarities[best[at - 1]!]! < value) at -= 1;
    best.splice(at, 0, row);
    if (best.length > count) best.pop();
  }
  return best;
}

export interface Placement {
  readonly placement: ReadonlyArray<{ readonly topic: string; readonly sim: number; readonly pi: number }>;
  readonly nextSim: number;
  readonly best: number;
}

/**
 * Step 5: the m most similar topics with margin weights against the
 * (m+1)-th similarity (uniform when every margin is 0).
 */
export function placeVector(index: NodeVectorIndex, vector: Float32Array, m: number): Placement {
  const similarities = nodeSimilarities(index, vector);
  const rows = topRows(similarities, m + 1);
  const top = rows.slice(0, m);
  const next = rows.length > m ? similarities[rows[m]!]! : 0;
  const pi = marginWeights(top.map((row) => similarities[row]!), next);
  return {
    placement: top.map((row, k) => ({ topic: index.ids[row]!, sim: similarities[row]!, pi: round6(pi[k]!) })),
    nextSim: next,
    best: top.length > 0 ? similarities[top[0]!]! : 0,
  };
}

/**
 * Route C: the knnK nearest topics of every retrieval item (and, with
 * knnHopK, the nearest topics of each topic found), ranked by the best
 * cosine x max(w, 0.25) over the items; the own need is that item's (null
 * for a weight-0 item).
 */
export function knnTopics(
  index: NodeVectorIndex,
  itemVectors: ReadonlyArray<{ readonly id: number | null; readonly weight: number; readonly vector: Float32Array }>,
  params: Pick<PanelCompositionParams, "knnK" | "knnHopK" | "knnMaxQueries">,
): Array<{ readonly row: number; readonly score: number; readonly own: number | null }> {
  const found = new Set<number>();
  const itemSims = itemVectors.map((item) => nodeSimilarities(index, item.vector));
  itemSims.forEach((sims) => {
    for (const row of topRows(sims, Math.max(0, params.knnK))) found.add(row);
  });
  if (params.knnHopK > 0) {
    for (const row of [...found].sort((a, b) => a - b)) {
      const vector = index.vectors.subarray(row * index.dim, (row + 1) * index.dim);
      const sims = nodeSimilarities(index, vector);
      sims[row] = Number.NEGATIVE_INFINITY;
      for (const hop of topRows(sims, params.knnHopK)) found.add(hop);
    }
  }
  const scored = [...found].map((row) => {
    let score = Number.NEGATIVE_INFINITY;
    let own: number | null = null;
    for (let position = 0; position < itemVectors.length; position += 1) {
      const item = itemVectors[position]!;
      const value = itemSims[position]![row]! * Math.max(item.weight, 0.25);
      if (value > score) {
        score = value;
        own = item.id;
      }
    }
    return { row, score: round6(score), own };
  });
  scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.row - b.row));
  return scored.slice(0, Math.max(0, params.knnMaxQueries));
}

/** Upstream keywords of a node text ("... Keywords: a; b; c"). */
export function nodeKeywords(text: string | undefined, count: number): string[] {
  if (text === undefined || count <= 0) return [];
  const match = /Keywords:\s*(.+)$/s.exec(text);
  if (!match) return [];
  return match[1]!
    .split(";")
    .map((keyword) => keyword.replace(/\.$/, "").trim())
    .filter((keyword) => keyword !== "")
    .slice(0, count);
}

/* ------------------------------------------------------------------------ */
/* Route E: pseudo-relevance feedback                                        */
/* ------------------------------------------------------------------------ */

const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a about above across after again against all almost also although always among an and another any are around as at " +
    "based be because been before being below between both but by can could did do does doing done down due during each " +
    "either else enough even every for from further given had has have having here how however if in into is it its itself " +
    "just least less like many may might more most much must near need new no non nor not novel now of off often on once " +
    "one only onto or other others our out over own paper per propose proposed provide provides rather results same several " +
    "shall should show shows since so some such than that the their them then there these they this those though through " +
    "thus to too toward towards two under until up upon us use used uses using very via was we well were what when where " +
    "whether which while who whose why will with within without would yet approach approaches method methods study studies " +
    "work works present presents demonstrate demonstrates first second three different various existing important"
  ).split(" "),
);

/** 2-4-word phrases of non-stop-words, lower-cased, never across punctuation. */
export function candidatePhrases(text: string): Set<string> {
  const phrases = new Set<string>();
  for (const chunk of text.toLowerCase().split(/[.,;:!?()[\]{}"'\u2013\u2014]+/)) {
    const words = chunk.match(/[a-z][a-z0-9-]*[a-z0-9]|[a-z]/g) ?? [];
    for (let start = 0; start < words.length; start += 1) {
      for (let n = 2; n <= 4 && start + n <= words.length; n += 1) {
        const span = words.slice(start, start + n);
        if (span.some((word) => STOP_WORDS.has(word) || word.length < 2)) break;
        phrases.add(span.join(" "));
      }
    }
  }
  return phrases;
}

/**
 * Route E terms of one need: phrases of its seed papers scored by
 * (document frequency in the seeds) x log(N_all / df_all), excluding phrases
 * already used as queries or contained in one; ties by the phrase.
 */
export function feedbackTerms(
  seeds: readonly string[],
  corpus: readonly string[],
  count: number,
  covered: (phrase: string) => boolean,
): string[] {
  if (count <= 0 || seeds.length === 0 || corpus.length === 0) return [];
  const corpusPhrases = corpus.map(candidatePhrases);
  const dfAll = new Map<string, number>();
  for (const phrases of corpusPhrases) for (const phrase of phrases) dfAll.set(phrase, (dfAll.get(phrase) ?? 0) + 1);
  const dfSeeds = new Map<string, number>();
  for (const seed of seeds) for (const phrase of candidatePhrases(seed)) dfSeeds.set(phrase, (dfSeeds.get(phrase) ?? 0) + 1);
  const scored = [...dfSeeds].map(([phrase, df]) => ({
    phrase,
    score: df * Math.log(corpus.length / Math.max(1, dfAll.get(phrase) ?? 1)),
  }));
  scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : compareText(a.phrase, b.phrase)));
  const out: string[] = [];
  for (const entry of scored) {
    if (out.length >= count) break;
    if (entry.score <= 0 || covered(entry.phrase)) continue;
    out.push(entry.phrase);
  }
  return out;
}

/**
 * Rounds 2+: stop when a round adds fewer than minNewShare new eligible
 * papers, as a share of all eligible papers after the round (the
 * prototype's reading).
 */
export function stopAfterRound(newEligible: number, eligibleAfter: number, minNewShare: number): boolean {
  if (eligibleAfter <= 0) return true;
  return newEligible / eligibleAfter < minNewShare;
}

/* ------------------------------------------------------------------------ */
/* Call cache                                                                */
/* ------------------------------------------------------------------------ */

const SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DETAILS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-call cache: memory, plus one JSON file per call under cacheDir when given. */
class CallCache {
  private readonly memory = new Map<string, JsonValue>();

  constructor(
    private readonly dir: string | undefined,
    private readonly now: () => number,
  ) {}

  private path(key: string): string | undefined {
    return this.dir === undefined ? undefined : join(this.dir, `${sha256(key)}.json`);
  }

  async get(key: string, ttlMs: number): Promise<JsonValue | undefined> {
    const hit = this.memory.get(key);
    if (hit !== undefined) return hit;
    const path = this.path(key);
    if (path === undefined) return undefined;
    try {
      const stored = JSON.parse(await readFile(path, "utf8")) as { at?: number; key?: string; value?: JsonValue };
      if (stored.key !== key || typeof stored.at !== "number" || this.now() - stored.at > ttlMs || stored.value === undefined) {
        return undefined;
      }
      this.memory.set(key, stored.value);
      return stored.value;
    } catch {
      return undefined;
    }
  }

  async put(key: string, value: JsonValue): Promise<void> {
    this.memory.set(key, value);
    const path = this.path(key);
    if (path === undefined) return;
    try {
      await mkdir(this.dir!, { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ at: this.now(), key, value }));
      await rename(temporary, path);
    } catch {
      // a lost cache entry costs a repeat call, nothing else
    }
  }
}

/* ------------------------------------------------------------------------ */
/* literature.retrieve                                                       */
/* ------------------------------------------------------------------------ */

interface CallRecord {
  readonly source: string;
  readonly query: string;
  readonly ok: boolean;
  readonly outcome: "ok" | "cached" | "error";
  readonly n: number;
  readonly nAbstract: number;
  readonly error?: string;
}

interface TopicSpace {
  readonly index: NodeVectorIndex;
  readonly hierarchy: TopicHierarchy | undefined;
  readonly textById: ReadonlyMap<string, string>;
  readonly nameById: ReadonlyMap<string, string>;
}

/** Everything one retrieval run accumulates. */
class RetrievalRun {
  readonly calls: CallRecord[] = [];
  records: LiteratureRecord[] = [];
  callsUsed = 0;
  budgetExhausted = false;
  readonly notes: string[] = [];
  private readonly probed = new Set<string>();

  constructor(
    readonly params: PanelCompositionParams,
    readonly web: WebAccess,
    readonly sources: SourceEntry[],
    private readonly cache: CallCache,
    private readonly context: WebAccessCallContext,
  ) {}

  available(source: string): boolean {
    return this.sources.find((entry) => entry.id === source)?.state === "available";
  }

  private markFailure(source: string, message: string): void {
    const first = !this.probed.has(source);
    this.probed.add(source);
    if (first && isBlockingFailure(message)) {
      const entry = this.sources.find((candidate) => candidate.id === source);
      if (entry !== undefined && entry.state === "available") {
        entry.state = "unavailable";
        entry.detail = `first call failed: ${message.slice(0, 200)}`;
      }
    }
  }

  private take(count: number): number {
    const remaining = Math.max(0, this.params.maxCalls - this.callsUsed);
    if (count > remaining) this.budgetExhausted = true;
    return Math.min(count, remaining);
  }

  /** One search call through the cache. */
  private async search(request: PaperSearchQuery): Promise<{ ok: boolean; outcome: "ok" | "cached" | "error"; papers: readonly PaperRecord[]; error?: string }> {
    const key = JSON.stringify(["search", request]);
    const cached = await this.cache.get(key, SEARCH_TTL_MS);
    if (isRecord(cached) && Array.isArray(cached.papers)) {
      return { ok: true, outcome: "cached", papers: cached.papers as unknown as PaperRecord[] };
    }
    try {
      const answer: PaperSearchAnswer = await this.web.searchPapers!(request, this.context);
      await this.cache.put(key, { papers: answer.papers as unknown as JsonValue });
      return { ok: true, outcome: answer.cached === true ? "cached" : "ok", papers: answer.papers };
    } catch (error) {
      return { ok: false, outcome: "error", papers: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** One details call through the cache. */
  async details(request: PaperDetailsQuery): Promise<{ ok: boolean; outcome: "ok" | "cached" | "error"; answer?: PaperDetailsAnswer; error?: string }> {
    const key = JSON.stringify(["details", request]);
    const cached = await this.cache.get(key, DETAILS_TTL_MS);
    if (isRecord(cached) && Array.isArray(cached.papers)) {
      return { ok: true, outcome: "cached", answer: cached as unknown as PaperDetailsAnswer };
    }
    if (this.web.paperDetails === undefined) return { ok: false, outcome: "error", error: "paper details are not served on this deployment" };
    try {
      const answer = await this.web.paperDetails(request, this.context);
      await this.cache.put(key, answer as unknown as JsonValue);
      return { ok: true, outcome: answer.cached === true ? "cached" : "ok", answer };
    } catch (error) {
      return { ok: false, outcome: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Counts one details call against the budget; false when none is left. */
  claimDetailsCall(): boolean {
    if (this.take(1) < 1) return false;
    this.callsUsed += 1;
    return true;
  }

  recordCall(call: CallRecord): void {
    this.calls.push(call);
    if (!call.ok && call.error !== undefined && !call.source.includes("+")) this.markFailure(call.source, call.error);
    else this.probed.add(call.source);
  }

  /**
   * Issues every (query, source, page) call of a batch: the budget is
   * allocated in plan order before anything runs (so which calls fit never
   * depends on timing), sources run in parallel and each source's calls in
   * order, and the records are appended in plan order.
   */
  async searchBatch(queries: readonly PlannedQuery[]): Promise<number> {
    const pages = Math.max(1, Math.ceil(this.params.resultsPerCall / 25));
    const planned: Array<{ query: PlannedQuery; source: string; page: number; size: number }> = [];
    for (const query of queries) {
      for (const source of query.sources) {
        if (!this.available(source)) continue;
        for (let page = 1; page <= pages; page += 1) {
          const size = Math.min(25, this.params.resultsPerCall - (page - 1) * 25);
          if (size > 0) planned.push({ query, source, page, size });
        }
      }
    }
    const allowed = planned.slice(0, this.take(planned.length));
    const results = new Array<{ call: CallRecord; records: LiteratureRecord[] } | undefined>(allowed.length);
    const bySource = new Map<string, number[]>();
    allowed.forEach((entry, position) => {
      const list = bySource.get(entry.source) ?? [];
      list.push(position);
      bySource.set(entry.source, list);
    });
    let issued = 0;
    await Promise.all(
      [...bySource.entries()].map(async ([source, positions]) => {
        for (const position of positions) {
          if (!this.available(source)) continue;
          const entry = allowed[position]!;
          const request = sourceRequest(entry.query, source, this.params, entry.page, entry.size);
          this.callsUsed += 1;
          issued += 1;
          const outcome = await this.search(request);
          const offset = (entry.page - 1) * 25;
          const records = outcome.papers.map((paper, rank) =>
            recordFromPaper(paper, {
              source,
              query: entry.query.id,
              rank: offset + rank + 1,
              round: entry.query.round,
              route: entry.query.route,
            }),
          );
          const call: CallRecord = {
            source,
            query: entry.query.id,
            ok: outcome.ok,
            outcome: outcome.outcome,
            n: outcome.papers.length,
            nAbstract: outcome.papers.filter((paper) => paper.abstract !== undefined && paper.abstract.trim() !== "").length,
            ...(outcome.error !== undefined ? { error: outcome.error.slice(0, 500) } : {}),
          };
          // The probe: a source's first call decides whether it stays in the run.
          if (!outcome.ok) this.markFailure(source, outcome.error ?? "");
          else this.probed.add(source);
          results[position] = { call, records };
        }
      }),
    );
    for (const result of results) {
      if (result === undefined) continue;
      this.calls.push(result.call);
      this.records.push(...result.records);
    }
    return issued;
  }
}

function embeddingText(paper: { title: string; abstract?: string }, manifest: EncoderManifest): string {
  return formatDocument(manifest, paper.title, paper.abstract ?? "");
}

/** The run's encoder: the named one, else hash-ngram-v1 (recorded). */
async function resolveEncoder(
  provider: EncoderProvider,
  id: string,
  notes: string[],
): Promise<TextEncoder> {
  try {
    const named = await provider.encoder(id);
    if (!("unavailable" in named)) return named;
    notes.push(`encoder "${id}" unavailable (${named.unavailable}); fell back to ${EMBEDDER_ID}`);
  } catch (error) {
    notes.push(`encoder "${id}" failed (${error instanceof Error ? error.message : String(error)}); fell back to ${EMBEDDER_ID}`);
  }
  if (id !== EMBEDDER_ID) {
    try {
      const fallback = await provider.encoder(EMBEDDER_ID);
      if (!("unavailable" in fallback)) return fallback;
    } catch {
      // the built-in adapter below
    }
  }
  return hashNgramTextEncoder();
}

/** The topic vector space of a run: node texts (bundle) over the taxonomy's topics. */
async function topicSpace(
  deps: LiteratureActivityDeps,
  provider: EncoderProvider,
  encoder: TextEncoder,
  notes: string[],
): Promise<{ readonly space?: TopicSpace; readonly revision: number; readonly textsSha256: string }> {
  let nodes: ReadonlyArray<{ id: string; name: string; level: string; parent?: string }> | undefined;
  let revision = 0;
  try {
    const served = deps.taxonomy?.embeddings !== undefined ? await deps.taxonomy.embeddings() : undefined;
    if (served !== undefined) {
      nodes = served.nodes;
      revision = served.revision;
    }
  } catch (error) {
    notes.push(`taxonomy hierarchy unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let texts: { readonly sha256: string; readonly entries: ReadonlyArray<{ readonly id: string; readonly text: string }> } | undefined;
  try {
    texts = deps.nodeTexts !== undefined ? await deps.nodeTexts.texts() : undefined;
  } catch (error) {
    notes.push(`node texts unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const textById = new Map((texts?.entries ?? []).map((entry) => [entry.id, entry.text]));
  const nameById = new Map<string, string>();
  for (const node of nodes ?? []) nameById.set(node.id, node.name);
  let entries: Array<{ id: string; text: string }>;
  if (nodes !== undefined) {
    const topics = nodes.filter((node) => node.level === "topic");
    const topicIds = new Set(topics.map((node) => node.id));
    entries = (texts?.entries ?? []).filter((entry) => topicIds.has(entry.id)).map((entry) => ({ id: entry.id, text: entry.text }));
    const covered = new Set(entries.map((entry) => entry.id));
    const missing = topics.filter((node) => !covered.has(node.id));
    if (missing.length > 0 && texts !== undefined) {
      notes.push(`${missing.length} taxonomy topic(s) have no node text and are embedded by name`);
    }
    if (texts === undefined) notes.push("the bundle carries no node texts: topics are embedded by name");
    entries.push(...missing.map((node) => ({ id: node.id, text: node.name })));
  } else if (texts !== undefined) {
    notes.push("no taxonomy hierarchy: placement uses the node texts alone");
    entries = texts.entries.map((entry) => ({ id: entry.id, text: entry.text }));
    for (const entry of entries) {
      const cut = entry.text.indexOf(". ");
      nameById.set(entry.id, cut < 0 ? entry.text : entry.text.slice(0, cut));
    }
  } else {
    notes.push("neither a taxonomy nor node texts: no placement and no kNN route");
    return { revision, textsSha256: "" };
  }
  try {
    const index = await provider.nodeIndex(encoder, revision, entries);
    return {
      space: { index, hierarchy: nodes !== undefined ? topicHierarchy(nodes) : undefined, textById, nameById },
      revision,
      textsSha256: texts?.sha256 ?? index.nodeTextsSha256,
    };
  } catch (error) {
    notes.push(`node vectors unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { revision, textsSha256: texts?.sha256 ?? "" };
  }
}

interface PaperState {
  readonly merged: MergedPaper;
  readonly pid: string;
  readonly decision: PaperDecision;
  readonly placement?: Placement;
  readonly needSims?: readonly number[];
}

/** An empty literature record (no web access, nothing retrievable). */
function emptyLiterature(
  needs: readonly LiteratureNeed[],
  W: number,
  encoder: JsonObject,
  sources: readonly SourceEntry[],
  notes: readonly string[],
): JsonObject {
  return {
    version: 1,
    needs: needs as unknown as JsonValue,
    W: round6(W),
    encoder,
    sources: sources.map((entry) => ({ id: entry.id, state: entry.state, ...(entry.detail !== undefined ? { detail: entry.detail } : {}) })),
    queries: [],
    calls: [],
    rounds: [],
    papers: [],
    screenItems: [],
    flags: { hubs: [], budgetExhausted: false, notes: [...notes] },
  };
}

async function retrieveLiterature(
  deps: LiteratureActivityDeps,
  input: JsonObject,
  context: DeterministicActivityContext,
): Promise<JsonObject> {
  const params = panelCompositionParams(input.config);
  const ei = embeddingInputOf(input.classification);
  const { needs, items, W } = buildNeeds(ei, params);
  const notes: string[] = [];
  const sources = initialSourceStates(params, deps.web, deps.keyedSources);
  const provider = deps.encoders ?? hashNgramEncoderProvider();
  const encoder = await resolveEncoder(provider, params.encoder, notes);
  const { space, revision, textsSha256 } = await topicSpace(deps, provider, encoder, notes);
  const encoderRecord: JsonObject = {
    id: encoder.manifest.id,
    dim: encoder.manifest.dim,
    models: { ...encoder.manifest.models },
    nodeVectorsSha256: space?.index.vectorsSha256 ?? "",
    nodeTextsSha256: textsSha256,
    taxonomyRevision: revision,
  };
  const web = deps.web;
  if (web === undefined || web.searchPapers === undefined) {
    return emptyLiterature(needs, W, encoderRecord, sources, ["no web access", ...notes]);
  }
  const run = new RetrievalRun(
    params,
    web,
    sources,
    new CallCache(deps.cacheDir, deps.now ?? Date.now),
    { signal: context.signal, nodePath: context.nodePath, agentId: "literature.retrieve" },
  );
  const plan = new QueryPlan();
  const searchSources = (): string[] => LITERATURE_SEARCH_SOURCES.filter((source) => run.available(source));

  // ---- embeddings (papers cached by their document text)
  const vectorCache = new Map<string, Float32Array>();
  const embedDocuments = async (texts: readonly string[]): Promise<void> => {
    const missing = [...new Set(texts.filter((text) => !vectorCache.has(text)))];
    if (missing.length === 0) return;
    const vectors = await encoder.embed(missing, "doc", context.signal);
    missing.forEach((text, index) => vectorCache.set(text, vectors[index]!));
  };
  const itemVectors: Array<{ id: number | null; weight: number; vector: Float32Array }> = [];
  {
    const docItems = items.filter((item) => item.mode === "doc");
    const queryItems = items.filter((item) => item.mode === "query");
    const docVectors = docItems.length > 0 ? await encoder.embed(docItems.map((item) => item.text), "doc", context.signal) : [];
    const queryVectors = queryItems.length > 0 ? await encoder.embed(queryItems.map((item) => item.text), "query", context.signal) : [];
    const byItem = new Map<RetrievalItem, Float32Array>();
    docItems.forEach((item, index) => byItem.set(item, docVectors[index]!));
    queryItems.forEach((item, index) => byItem.set(item, queryVectors[index]!));
    for (const item of items) itemVectors.push({ id: item.id, weight: item.weight, vector: byItem.get(item)! });
  }
  const needVectors = itemVectors.filter((item) => item.id !== null);

  // ---- merge, eligibility, placement of the records so far
  let papers: PaperState[] = [];
  const placementCache = new Map<string, Placement>();
  const settle = async (): Promise<void> => {
    const merged = mergeLiteratureRecords(run.records);
    const decisions = paperDecisions(merged, params.minAbstractChars, params.maxPapers);
    const eligibleTexts = merged
      .filter((_, index) => decisions[index] === "eligible")
      .map((paper) => embeddingText(paper, encoder.manifest));
    await embedDocuments(eligibleTexts);
    papers = merged.map((paper, index) => {
      const decision = decisions[index]!;
      const base = { merged: paper, pid: `P${String(index + 1).padStart(4, "0")}`, decision };
      if (decision !== "eligible") return base;
      const text = embeddingText(paper, encoder.manifest);
      const vector = vectorCache.get(text)!;
      let placement: Placement | undefined;
      if (space !== undefined) {
        placement = placementCache.get(text);
        if (placement === undefined) {
          placement = placeVector(space.index, vector, Math.max(1, params.topicsPerPaper));
          placementCache.set(text, placement);
        }
      }
      const needSims = needVectors.map((need) => {
        let total = 0;
        for (let i = 0; i < vector.length; i += 1) total += vector[i]! * need.vector[i]!;
        return round6(total);
      });
      return { ...base, ...(placement !== undefined ? { placement } : {}), needSims };
    });
  };
  const eligibleCount = (): number => papers.filter((paper) => paper.decision === "eligible").length;

  // ---- round 1 (seed)
  planSeedQueries(plan, ei, items, params, searchSources());
  if (params.routeKnn && space !== undefined) {
    for (const topic of knnTopics(space.index, itemVectors, params)) {
      const id = space.index.ids[topic.row]!;
      const text = space.textById.get(id);
      const name = space.nameById.get(id) ?? (text !== undefined ? text.split(". ")[0]! : id);
      plan.add({ text: name, route: "knn", round: 1, own: topic.own, sources: searchSources() });
      for (const keyword of nodeKeywords(text, params.knnKeywords)) {
        plan.add({ text: keyword, route: "knn", round: 1, own: topic.own, sources: searchSources() });
      }
    }
  } else if (params.routeKnn) {
    notes.push("route C (kNN) skipped: no topic vectors");
  }
  const rounds: Array<{ round: number; calls: number; newPapers: number; newEligible: number }> = [];
  const callsAt = (): number => run.callsUsed;
  {
    const before = callsAt();
    await run.searchBatch(plan.queries.filter((query) => query.round === 1));
    await settle();
    rounds.push({ round: 1, calls: callsAt() - before, newPapers: papers.length, newEligible: eligibleCount() });
  }

  // ---- rounds 2+ (expansion: route D citations, route E feedback)
  for (let round = 2; round <= Math.max(1, Math.min(3, params.maxRounds)); round += 1) {
    if (run.callsUsed >= params.maxCalls) {
      run.budgetExhausted = true;
      break;
    }
    const before = callsAt();
    const papersBefore = papers.length;
    const eligibleBefore = eligibleCount();
    const composeInput = composeInputFromLiterature(snapshotLiterature(needs, W, plan, run, papers, space), undefined);
    const evidence = needs.map((_, f) => needEvidenceOrder(composeInput, f));
    // Route D: the citationSeeds papers of highest evidence mass EM(d) = sum_f w_f omega(d, f).
    if (params.routeCitations) {
      const citeSources = CITATION_SOURCES.filter((source) => run.available(source));
      const mass = new Map<number, number>();
      const omegaEvidence = needs.map((_, f) => omegaFor(composeInput, f, params.papersPerNeed));
      omegaEvidence.forEach((entry, f) => {
        entry.top.forEach((index, k) => mass.set(index, (mass.get(index) ?? 0) + needs[f]!.weight * entry.omega[k]!));
      });
      const seeds = [...mass.entries()]
        .sort((a, b) => {
          if (a[1] !== b[1]) return b[1] - a[1];
          const pa = composeInput.papers[a[0]]!;
          const pb = composeInput.papers[b[0]]!;
          return pa.rrf !== pb.rrf ? pb.rrf - pa.rrf : compareText(pa.cid, pb.cid);
        })
        .slice(0, Math.max(0, params.citationSeeds))
        .map(([index]) => composeInput.papers[index]!);
      const include: Array<"references" | "citations"> =
        params.citationDirections === "references" ? ["references"] : params.citationDirections === "citations" ? ["citations"] : ["references", "citations"];
      for (const seed of seeds) {
        if (citeSources.length === 0) break;
        const state = papers.find((paper) => paper.pid === seed.pid)!;
        const ids = state.merged.ids;
        const requested = ids.doi ?? (ids.arxivId !== undefined ? `arXiv:${ids.arxivId}` : ids.s2Id ?? ids.oaId);
        if (requested === undefined) continue;
        const query = plan.add({
          text: `${include.join(" and ")} of ${state.merged.cid}`,
          route: "citation",
          round,
          own: null,
          sources: citeSources,
        });
        if (query === undefined) continue;
        for (const source of citeSources) {
          if (!run.available(source)) continue;
          if (source === "opencitations" && ids.doi === undefined) continue;
          if (!run.claimDetailsCall()) break;
          const outcome = await run.details({
            ids: [source === "opencitations" ? ids.doi! : requested],
            include,
            limit: Math.max(1, params.citationLimit),
            sources: [source as Exclude<PaperSource, "web">],
          });
          const entry = outcome.answer?.papers[0];
          const lists = [...(entry?.references ?? []), ...(entry?.citedBy ?? [])];
          run.recordCall({
            source,
            query: query.id,
            ok: outcome.ok,
            outcome: outcome.outcome,
            n: lists.length,
            nAbstract: lists.filter((paper) => paper.abstract !== undefined && paper.abstract.trim() !== "").length,
            ...(outcome.error !== undefined ? { error: outcome.error.slice(0, 500) } : {}),
          });
          if (!outcome.ok || lists.length === 0) continue;
          (entry?.references ?? []).forEach((paper, rank) =>
            run.records.push(recordFromPaper(paper, { source, query: query.id, rank: rank + 1, round, route: "citation" })),
          );
          (entry?.citedBy ?? []).forEach((paper, rank) =>
            run.records.push(recordFromPaper(paper, { source, query: query.id, rank: rank + 1, round, route: "citation" })),
          );
          break;
        }
      }
      await resolveAbstracts(run, round);
    }
    // Route E: pseudo-relevance feedback phrases per need (at most 20 in total).
    if (params.routeFeedback) {
      const texts = composeInput.papers.map((paper) => {
        const state = papers.find((entry) => entry.pid === paper.pid)!;
        return `${state.merged.title}. ${state.merged.abstract ?? ""}`;
      });
      // Each need's feedbackTerms best phrases; the 20-phrase cap is applied
      // round-robin by rank across the needs.
      const perNeed = needs.map((_, f) => {
        const seeds = evidence[f]!.slice(0, Math.max(0, params.feedbackSeeds)).map((index) => texts[index]!);
        return feedbackTerms(seeds, texts, Math.max(0, params.feedbackTerms), (phrase) => plan.covers(phrase));
      });
      let total = 0;
      for (let rank = 0; rank < Math.max(0, params.feedbackTerms) && total < 20; rank += 1) {
        for (let f = 0; f < needs.length && total < 20; f += 1) {
          const term = perNeed[f]![rank];
          if (term === undefined) continue;
          if (plan.add({ text: term, route: "feedback", round, own: needs[f]!.id, sources: searchSources() }) !== undefined) total += 1;
        }
      }
      await run.searchBatch(plan.queries.filter((query) => query.round === round && query.route === "feedback"));
    }
    await settle();
    const newEligible = Math.max(0, eligibleCount() - eligibleBefore);
    rounds.push({ round, calls: callsAt() - before, newPapers: Math.max(0, papers.length - papersBefore), newEligible });
    if (stopAfterRound(newEligible, eligibleCount(), params.minNewShare)) break;
  }
  if (run.budgetExhausted) notes.push(`the call budget (maxCalls ${params.maxCalls}) was exhausted`);
  return snapshotLiterature(needs, W, plan, run, papers, space, { encoder: encoderRecord, rounds, notes, final: true, params });
}

/** Eligible-paper indices of need f in D_f order (similarity, fused rank, canonical id). */
function needEvidenceOrder(input: ReturnType<typeof composeInputFromLiterature>, f: number): number[] {
  return input.papers
    .map((_, index) => index)
    .sort((a, b) => {
      const pa = input.papers[a]!;
      const pb = input.papers[b]!;
      const sa = pa.needSims[f] ?? 0;
      const sb = pb.needSims[f] ?? 0;
      if (sa !== sb) return sb - sa;
      if (pa.rrf !== pb.rrf) return pb.rrf - pa.rrf;
      return compareText(pa.cid, pb.cid);
    });
}

/** D_f and its omega margin weights (as panel.compose computes them). */
function omegaFor(input: ReturnType<typeof composeInputFromLiterature>, f: number, K: number): { top: number[]; omega: number[] } {
  const order = needEvidenceOrder(input, f);
  const top = order.slice(0, K);
  if (input.papers.length > K) {
    const reference = input.papers[order[K]!]!.needSims[f] ?? 0;
    return { top, omega: marginWeights(top.map((index) => input.papers[index]!.needSims[f] ?? 0), reference) };
  }
  return { top, omega: top.map(() => 1 / Math.max(1, top.length)) };
}

/** Citation records without an abstract, resolved by id (batches of 20) before eligibility. */
async function resolveAbstracts(run: RetrievalRun, round: number): Promise<void> {
  const abstractSources = ABSTRACT_SOURCES.filter((source) => run.available(source));
  if (abstractSources.length === 0) return;
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const record of run.records) {
    if (record.round !== round || record.route !== "citation" || record.abstract !== undefined) continue;
    const id = record.doi ?? (record.arxivId !== undefined ? `arXiv:${record.arxivId}` : record.s2Id);
    if (id === undefined || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    wanted.push(id);
  }
  const resolved = new Map<string, PaperRecord>();
  for (let start = 0; start < wanted.length; start += 20) {
    if (!run.claimDetailsCall()) break;
    const batch = wanted.slice(start, start + 20);
    const outcome = await run.details({
      ids: batch,
      include: ["abstract"],
      sources: abstractSources as Array<Exclude<PaperSource, "web">>,
    });
    const found = outcome.answer?.papers ?? [];
    const answered = (outcome.answer?.providers ?? abstractSources).join("+") || abstractSources.join("+");
    run.recordCall({
      source: answered,
      query: `resolve:r${round}:${answered}:${start / 20 + 1}`,
      ok: outcome.ok,
      outcome: outcome.outcome,
      n: found.length,
      nAbstract: found.filter((paper) => paper.abstract !== undefined).length,
      ...(outcome.error !== undefined ? { error: outcome.error.slice(0, 500) } : {}),
    });
    for (const entry of found) resolved.set(entry.requested.toLowerCase(), entry);
  }
  if (resolved.size === 0) return;
  run.records = run.records.map((record) => {
    if (record.round !== round || record.route !== "citation" || record.abstract !== undefined) return record;
    const id = record.doi ?? (record.arxivId !== undefined ? `arXiv:${record.arxivId}` : record.s2Id);
    const entry = id !== undefined ? resolved.get(id.toLowerCase()) : undefined;
    if (entry === undefined) return record;
    const enriched = recordFromPaper(
      { ...entry, title: record.title !== "" ? record.title : entry.title },
      { source: record.source, query: record.query, rank: record.rank, round: record.round, route: record.route },
    );
    return {
      ...enriched,
      ...(record.doi !== undefined ? { doi: record.doi } : {}),
      ...(record.arxivId !== undefined ? { arxivId: record.arxivId } : {}),
    };
  });
}

/** The literature artifact of the run's current state. */
function snapshotLiterature(
  needs: readonly LiteratureNeed[],
  W: number,
  plan: QueryPlan,
  run: RetrievalRun,
  papers: readonly PaperState[],
  space: TopicSpace | undefined,
  final?: {
    readonly encoder: JsonObject;
    readonly rounds: ReadonlyArray<{ round: number; calls: number; newPapers: number; newEligible: number }>;
    readonly notes: readonly string[];
    readonly final: true;
    readonly params: PanelCompositionParams;
  },
): JsonObject {
  const eligible = papers.filter((paper) => paper.decision === "eligible");
  let weakCut: number | undefined;
  const hubs: Array<{ topic: string; share: number }> = [];
  if (final !== undefined && space !== undefined && eligible.length > 0) {
    weakCut = linearQuantile(eligible.map((paper) => paper.placement?.best ?? 0), final.params.weakPlacementQuantile);
    const counts = new Map<string, number>();
    for (const paper of eligible) {
      for (const place of paper.placement?.placement ?? []) if (place.pi > 0) counts.set(place.topic, (counts.get(place.topic) ?? 0) + 1);
    }
    for (const [topic, count] of counts) {
      if (count / eligible.length > final.params.hubShare) hubs.push({ topic, share: round6(count / eligible.length) });
    }
  }
  const outPapers = papers.map((paper) => {
    const merged = paper.merged;
    const eligibleEntry = paper.decision === "eligible";
    return {
      pid: paper.pid,
      cid: merged.cid,
      title: merged.title,
      ...(merged.year !== undefined ? { year: merged.year } : {}),
      ...(merged.venue !== undefined ? { venue: merged.venue } : {}),
      ids: { ...merged.ids },
      sources: [...merged.sources],
      routes: [...merged.routes],
      rounds: [...merged.rounds],
      hits: merged.hits.map((hit) => ({ source: hit.source, query: hit.query, rank: hit.rank })),
      rrf: merged.rrf,
      ...(merged.abstract !== undefined ? { abstract: merged.abstract } : {}),
      abstractChars: merged.abstractChars,
      decision: paper.decision,
      ...(eligibleEntry && paper.placement !== undefined
        ? {
            placement: paper.placement.placement.map((place) => ({ topic: place.topic, sim: place.sim, pi: place.pi })),
            nextSim: round6(paper.placement.nextSim),
          }
        : {}),
      ...(eligibleEntry && paper.needSims !== undefined ? { needSims: [...paper.needSims] } : {}),
      ...(eligibleEntry && weakCut !== undefined && paper.placement !== undefined ? { weak: paper.placement.best <= weakCut } : {}),
    };
  });
  return {
    version: 1,
    needs: needs.map((need) => ({ ...need, weight: round6(need.weight) })) as unknown as JsonValue,
    W: round6(W),
    encoder: final?.encoder ?? { id: "", dim: 0, models: {}, nodeVectorsSha256: "", nodeTextsSha256: "", taxonomyRevision: 0 },
    sources: run.sources.map((entry) => ({ id: entry.id, state: entry.state, ...(entry.detail !== undefined ? { detail: entry.detail } : {}) })),
    queries: plan.queries.map((query) => ({
      id: query.id,
      text: query.text,
      route: query.route,
      round: query.round,
      own: query.own,
      sources: [...query.sources],
    })),
    calls: run.calls.map((call) => ({ ...call })) as unknown as JsonValue,
    rounds: (final?.rounds ?? []).map((entry) => ({ ...entry })),
    papers: outPapers as unknown as JsonValue,
    screenItems: eligible.map((paper) => ({
      pid: paper.pid,
      title: paper.merged.title,
      abstract: (paper.merged.abstract ?? "").slice(0, 600),
    })),
    flags: {
      ...(weakCut !== undefined ? { weakCut: round6(weakCut) } : {}),
      hubs,
      budgetExhausted: run.budgetExhausted,
      notes: [...(final?.notes ?? [])],
    },
  };
}

/* ------------------------------------------------------------------------ */
/* panel.compose, panel.seat, literature.noScreen                            */
/* ------------------------------------------------------------------------ */

/** A hierarchy with every topic under one placeholder subfield (no taxonomy wired). */
function placeholderHierarchy(nameById: ReadonlyMap<string, string>): TopicHierarchy {
  const subfield = { id: "unclassified", name: "Unclassified subfield", field: { id: "unclassified-field", name: "Unclassified field" } };
  return {
    subfield: (id) => (id === subfield.id ? subfield : undefined),
    topic: (id) => ({
      id,
      name: nameById.get(id) ?? id,
      subfield: { id: subfield.id, name: subfield.name },
      field: subfield.field,
    }),
  };
}

/**
 * The label-only shares of the no-evidence fallback: per need, the margin
 * weights of its 5 nearest topics against the 6th.
 */
async function labelOnlyShares(
  deps: LiteratureActivityDeps,
  literature: JsonObject,
  notes: string[],
): Promise<Array<Array<{ topic: string; pi: number }>> | undefined> {
  const provider = deps.encoders ?? hashNgramEncoderProvider();
  const encoderId = isRecord(literature.encoder) && typeof literature.encoder.id === "string" && literature.encoder.id !== ""
    ? literature.encoder.id
    : EMBEDDER_ID;
  const encoder = await resolveEncoder(provider, encoderId, notes);
  const { space } = await topicSpace(deps, provider, encoder, notes);
  if (space === undefined) return undefined;
  const needs = asList(literature.needs).filter(isRecord);
  const out: Array<Array<{ topic: string; pi: number }>> = [];
  for (const need of needs) {
    const mode: EncodeMode = need.mode === "doc" ? "doc" : "query";
    const [vector] = await encoder.embed([str(need.text)], mode);
    const sims = nodeSimilarities(space.index, vector!);
    const rows = topRows(sims, 6);
    const top = rows.slice(0, 5);
    const weights = marginWeights(top.map((row) => sims[row]!), rows.length > 5 ? sims[rows[5]!]! : 0);
    out.push(top.map((row, k) => ({ topic: space.index.ids[row]!, pi: weights[k]! })));
  }
  return out;
}

/**
 * The deterministic activities of the paper-based panel composition.
 * Register them next to the taxonomy activities; the old handlers stay
 * registered for pinned runs.
 */
export function literatureActivities(
  deps: LiteratureActivityDeps = {},
): Record<string, DeterministicActivityHandler> {
  let hierarchy: Promise<{ readonly hierarchy: TopicHierarchy; readonly note?: string }> | undefined;
  const loadHierarchy = () => {
    hierarchy ??= (async () => {
      const served = deps.taxonomy?.embeddings !== undefined ? await deps.taxonomy.embeddings().catch(() => undefined) : undefined;
      if (served !== undefined) return { hierarchy: topicHierarchy(served.nodes) };
      const texts = deps.nodeTexts !== undefined ? await deps.nodeTexts.texts().catch(() => undefined) : undefined;
      const names = new Map<string, string>();
      for (const entry of texts?.entries ?? []) {
        const cut = entry.text.indexOf(". ");
        names.set(entry.id, cut < 0 ? entry.text : entry.text.slice(0, cut));
      }
      return { hierarchy: placeholderHierarchy(names), note: "no taxonomy hierarchy: every topic seat sits under a placeholder subfield" };
    })();
    return hierarchy;
  };

  const retrieve: DeterministicActivityHandler = (input, context) => retrieveLiterature(deps, input, context);

  const noScreen: DeterministicActivityHandler = () => ({ decisions: [], skipped: "relevance screen off" });

  const compose: DeterministicActivityHandler = async (input) => {
    const literature = isRecord(input.literature) ? (input.literature as JsonObject) : undefined;
    if (literature === undefined) throw new Error("panel.compose needs the literature record");
    const screen = isRecord(input.screen) ? (input.screen as JsonObject) : undefined;
    const params = panelCompositionParams(input.config);
    const loaded = await loadHierarchy();
    const base = composeInputFromLiterature(literature, screen);
    const notes: string[] = loaded.note !== undefined ? [loaded.note] : [];
    let composeInput: ComposeInput = base;
    if (base.papers.length === 0) {
      const shares = await labelOnlyShares(deps, literature, notes);
      if (shares !== undefined) composeInput = { ...composeInput, labelShares: shares };
    }
    const evidence = composePanelEvidence(composeInput, params, loaded.hierarchy);
    if (notes.length === 0) return evidence;
    const flags = isRecord(evidence.flags) ? evidence.flags : {};
    const existing = Array.isArray(flags.notes) ? flags.notes : [];
    return { ...evidence, flags: { ...flags, notes: [...notes, ...existing] } };
  };

  const seat: DeterministicActivityHandler = (input) => {
    const evidence = isRecord(input.evidence) ? (input.evidence as JsonObject) : undefined;
    if (evidence === undefined) throw new Error("panel.seat needs the panel evidence record");
    const panelSize = typeof input.panelSize === "number" ? input.panelSize : 6;
    const mode = typeof input.panelSizeMode === "string" ? input.panelSizeMode : "auto";
    return seatPanel(evidence, panelSize, mode);
  };

  return {
    "literature.retrieve": retrieve,
    "literature.noScreen": noScreen,
    "panel.compose": compose,
    "panel.seat": seat,
  };
}

