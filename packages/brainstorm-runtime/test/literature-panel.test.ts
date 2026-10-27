/**
 * The paper-based panel composition (spec v2): retrieval helpers (needs,
 * query plan per route and per source syntax, same-paper merge, RRF, kNN,
 * the rounds stop rule), placement and evidence weights, candidates and
 * affinities, the lazy greedy with caps, rescue and tie-breaks, k* and k_cov,
 * seating, the activities end to end over a fake web layer, and the parity
 * of panel.compose with the Python prototype's fixtures when present.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { artifactSchemas, embeddingInputSchema } from "@brainstorm-agentic/content";
import type {
  JsonObject,
  JsonValue,
  NodeVectorIndex,
  PaperDetailsAnswer,
  PaperDetailsQuery,
  PaperRecord,
  PaperSearchAnswer,
  PaperSearchQuery,
  TaxonomyAccess,
  TaxonomyEmbeddings,
  WebAccess,
} from "@brainstorm-agentic/core";

import { applyNeedsEdit } from "../src/gates.js";
import {
  buildNeeds,
  candidatePhrases,
  embeddingInputOf,
  facetPairs,
  feedbackTerms,
  hashNgramEncoderProvider,
  initialSourceStates,
  isBlockingFailure,
  knnTopics,
  literatureActivities,
  mergeLiteratureRecords,
  paperDecisions,
  placeVector,
  planSeedQueries,
  QueryPlan,
  recordFromPaper,
  sourceRequest,
  stopAfterRound,
  type LiteratureRecord,
} from "../src/literature-activities.js";
import {
  composeInputFromLiterature,
  composePanelEvidence,
  kStarOf,
  lazyGreedy,
  marginWeights,
  needEvidence,
  PANEL_COMPOSITION_DEFAULTS,
  panelCompositionParams,
  pythonCanonicalJson,
  pythonFloat,
  round6,
  seatPanel,
  topicHierarchy,
  type ComposeInput,
  type ComposePaper,
} from "../src/panel-compose.js";

const params = panelCompositionParams({});

/* ---------------------------------------------------------------- helpers */

function record(partial: Partial<LiteratureRecord> & { source: string; query: string; rank: number; title: string }): LiteratureRecord {
  return { round: 1, route: "facet", ...partial };
}

const NODES = [
  { id: "D1", name: "Physical Sciences", level: "domain" as const },
  { id: "F1", name: "Computer Science", level: "field" as const, parent: "D1" },
  { id: "F2", name: "Mathematics", level: "field" as const, parent: "D1" },
  { id: "S1", name: "Artificial Intelligence", level: "subfield" as const, parent: "F1" },
  { id: "S2", name: "Signal Processing", level: "subfield" as const, parent: "F1" },
  { id: "S3", name: "Statistics and Probability", level: "subfield" as const, parent: "F2" },
  { id: "T1", name: "Graph Neural Networks", level: "topic" as const, parent: "S1" },
  { id: "T2", name: "Belief Propagation", level: "topic" as const, parent: "S2" },
  { id: "T3", name: "Gaussian Processes", level: "topic" as const, parent: "S3" },
  { id: "T4", name: "Random Graphs", level: "topic" as const, parent: "S3" },
];
const hierarchy = topicHierarchy(NODES);

function paper(pid: string, needSims: number[], placement: Array<[string, number]>, extra: Partial<ComposePaper> = {}): ComposePaper {
  return {
    pid,
    cid: `doi:10.1/${pid.toLowerCase()}`,
    rrf: 0.01,
    sources: ["arxiv"],
    hits: [{ source: "arxiv", query: "q1", rank: 1 }],
    placement: placement.map(([topic, pi]) => ({ topic, sim: 0.5, pi })),
    needSims,
    weak: false,
    ...extra,
  };
}

function composeInput(papers: ComposePaper[], needs = [
  { id: 0, kind: "core", name: "core", weight: 1 },
  { id: 1, kind: "facet", name: "message passing", weight: 0.9 },
  { id: 2, kind: "facet", name: "gaussian distributions", weight: 0.6 },
]): ComposeInput {
  return { needs, queryOwn: new Map([["q1", 1]]), papers, failedSources: [], screenedOut: 0 };
}

/* ------------------------------------------------------- needs and plan */

const EI = {
  title: "Message passing over Gaussian node distributions with Bernoulli edges",
  abstract:
    "We study message passing on graphs whose nodes carry multivariate Gaussian distributions and whose adjacency entries are Bernoulli variables, so that new graphs with new features and connections can be generated for a purpose.",
  facets: [
    { name: "message passing", statement: "Message passing propagates information between neighbouring nodes of a graph.", relevance: 1, aliases: ["belief propagation", "Message Passing"] },
    { name: "gaussian distributions", statement: "Multivariate Gaussian distributions describe uncertain node features by a mean and a covariance.", relevance: 0.8 },
    { name: "random graph models", statement: "Random graph models assign probabilities to edges, for example independent Bernoulli variables.", relevance: 0.5 },
  ],
  problemFormulation:
    "Given a graph whose node states are multivariate Gaussian distributions and whose edges are independent Bernoulli variables, define an update that maps these distributions to new ones and samples graphs with prescribed properties.",
  equivalentProblems: [
    { field: "signal processing", name: "Gaussian belief propagation", statement: "Gaussian belief propagation computes marginals of a Gaussian graphical model by local message updates.", confidence: 0.8 },
  ],
  keyTerms: ["adj_matrix"],
};

test("needs: core, facets, the formulation at formulationWeight; a weight-0 equivalent problem only feeds retrieval", () => {
  const { needs, items, W } = buildNeeds(embeddingInputOf({ embeddingInput: EI } as unknown as JsonValue), params);
  assert.deepEqual(needs.map((need) => [need.id, need.kind, need.weight, need.mode]), [
    [0, "core", 1, "doc"],
    [1, "facet", 1, "query"],
    [2, "facet", 0.8, "query"],
    [3, "facet", 0.5, "query"],
    [4, "formulation", 0.5, "doc"],
  ]);
  assert.equal(needs[1]!.text, `message passing: ${EI.facets[0]!.statement}`);
  assert.equal(needs[0]!.text, `${EI.title}. ${EI.abstract}`);
  const equivalent = items.find((item) => item.kind === "equivalent")!;
  assert.equal(equivalent.id, null, "equivalentProblemWeight 0: retrieval only");
  assert.equal(round6(W), 3.8);
  const weighted = buildNeeds(embeddingInputOf({ embeddingInput: EI } as unknown as JsonValue), { ...params, equivalentProblemWeight: 0.5, formulationWeight: 0 });
  assert.deepEqual(weighted.needs.map((need) => [need.kind, need.weight]).slice(4), [["equivalent", 0.4]]);
  assert.equal(weighted.items.find((item) => item.kind === "formulation")!.id, null);
});

test("query plan: routes in order, aliases deduped, pairs ranked by r_i r_j, statements to semantic sources only", () => {
  const ei = embeddingInputOf({ embeddingInput: EI } as unknown as JsonValue);
  const { items } = buildNeeds(ei, params);
  const plan = new QueryPlan();
  planSeedQueries(plan, ei, items, { ...params, routeKeyTerms: true }, ["arxiv", "crossref", "semantic-scholar"]);
  const routes = plan.queries.map((query) => query.route);
  assert.deepEqual([...new Set(routes)], ["title", "facet", "alias", "pair", "equivalent", "keyterm", "statement"]);
  // "Message Passing" (an alias equal to the facet name modulo case) is a duplicate query.
  assert.deepEqual(plan.queries.filter((query) => query.route === "alias").map((query) => query.text), ["belief propagation"]);
  assert.deepEqual(
    plan.queries.filter((query) => query.route === "pair").map((query) => [query.text, query.own]),
    [
      ["message passing gaussian distributions", 1],
      ["message passing random graph models", 1],
      ["gaussian distributions random graph models", 2],
    ],
  );
  for (const query of plan.queries.filter((entry) => entry.route === "statement")) {
    assert.deepEqual(query.sources, ["semantic-scholar"]);
  }
  assert.equal(plan.queries.find((query) => query.route === "equivalent")!.own, null);
  assert.equal(plan.queries[0]!.id, "q1");
  assert.ok(plan.covers("passing"), "a phrase contained in a used query is covered");
  assert.ok(plan.covers("bernoulli edges"), "the title query contains it");
  assert.ok(!plan.covers("walk summability"));
});

test("facet pairs: off, the v1 central rule, and all pairs capped at maxPairQueries", () => {
  const facets = [
    { name: "a", relevance: 0.5, need: 1 },
    { name: "b", relevance: 1, need: 2 },
    { name: "c", relevance: 0.9, need: 3 },
  ];
  assert.deepEqual(facetPairs(facets, "off", 15), []);
  assert.deepEqual(facetPairs(facets, "central", 15), [
    { a: 0, b: 1, own: 1 },
    { a: 1, b: 0, own: 2 },
    { a: 2, b: 0, own: 3 },
  ]);
  assert.deepEqual(facetPairs(facets, "all", 2), [
    { a: 1, b: 2, own: 2 },
    { a: 0, b: 1, own: 1 },
  ]);
});

test("per-source syntax: arXiv phrases and AND pairs, Crossref query.bibliographic, Semantic Scholar without hyphens", () => {
  const base = { round: 1, own: 1, sources: ["arxiv"] };
  const facet = { ...base, id: "q2", text: "belief propagation", route: "facet" as const };
  const pair = { ...base, id: "q3", text: "message passing graph-based models", route: "pair" as const, pair: ["message passing", "graph-based models"] as [string, string] };
  const title = { ...base, id: "q1", text: "A title of three", route: "title" as const };
  assert.deepEqual(sourceRequest(facet, "arxiv", params).native, { source: "arxiv", query: 'all:"belief propagation"' });
  assert.equal(sourceRequest(facet, "arxiv", params).query, "");
  assert.deepEqual(sourceRequest(pair, "arxiv", params).native, {
    source: "arxiv",
    query: 'all:"message passing" AND all:"graph-based models"',
  });
  assert.equal(sourceRequest(title, "arxiv", params).query, "A title of three");
  assert.deepEqual(sourceRequest(facet, "crossref", params).native, { source: "crossref", query: "query.bibliographic=belief+propagation" });
  assert.equal(sourceRequest(pair, "semantic-scholar", params).query, "message passing graph based models");
  assert.equal(sourceRequest(facet, "openalex", params).query, "belief propagation");
  assert.deepEqual(sourceRequest(pair, "europepmc", params).native, { source: "europepmc", query: '"message passing" AND "graph-based models"' });
  const request = sourceRequest(facet, "semantic-scholar", { ...params, yearFrom: 2015 }, 2, 10);
  assert.deepEqual(
    { sources: request.sources, mode: request.mode, sort: request.sort, maxResults: request.maxResults, page: request.page, dateFrom: request.dateFrom },
    { sources: ["semantic-scholar"], mode: "topic", sort: "relevance", maxResults: 10, page: 2, dateFrom: "2015" },
  );
});

test("source states: disabled by param, OpenAlex never keyless, CORE needs-key from the manager, a 429 probe blocks", () => {
  const web: WebAccess = {
    search: async () => { throw new Error("unused"); },
    fetch: async () => { throw new Error("unused"); },
    backedKinds: () => [],
    searchPapers: async () => { throw new Error("unused"); },
    status: () => [
      { id: "arxiv", state: "unchecked" },
      { id: "crossref", state: "available" },
      { id: "semantic-scholar", state: "available" },
      { id: "openalex", state: "available" },
      { id: "europepmc", state: "unchecked" },
      { id: "core", state: "needs-key", detail: "CORE needs an API key" },
      { id: "opencitations", state: "unchecked" },
    ],
  };
  const states = Object.fromEntries(initialSourceStates({ ...params, sourceCrossref: false }, web, undefined).map((entry) => [entry.id, entry.state]));
  assert.deepEqual(states, {
    arxiv: "available",
    crossref: "disabled",
    "semantic-scholar": "available",
    openalex: "needs-key",
    europepmc: "disabled",
    core: "needs-key",
    opencitations: "available",
  });
  assert.equal(initialSourceStates(params, web, new Set(["openalex"])).find((entry) => entry.id === "openalex")!.state, "available");
  assert.ok(isBlockingFailure("paper search failed — semantic-scholar: semantic-scholar answered HTTP 429"));
  assert.ok(isBlockingFailure("core refused the API key (HTTP 401) — check it in Settings"));
  assert.ok(!isBlockingFailure("crossref answered HTTP 500"));
});

/* ------------------------------------------------------------------ merge */

test("same-paper merge: DOI, arXiv DOI mapping, title + year within 1, Crossref non-papers kept apart", () => {
  const records: LiteratureRecord[] = [
    record({ source: "semantic-scholar", query: "q1", rank: 1, title: "Gaussian Belief Propagation Solvers", doi: "10.1000/ABC".toLowerCase(), year: 2019 }),
    record({ source: "crossref", query: "q1", rank: 4, title: "Gaussian belief propagation solvers.", doi: "10.1000/abc", year: 2020, type: "journal-article" }),
    recordFromPaper(
      { title: "Variational graph generation", url: "x", doi: "10.48550/arXiv.2101.00001", source: "crossref" } as PaperRecord,
      { source: "crossref", query: "q2", rank: 2, round: 1, route: "facet" },
    ),
    record({ source: "arxiv", query: "q2", rank: 1, title: "Variational Graph Generation", arxivId: "2101.00001", year: 2021 }),
    record({ source: "arxiv", query: "q3", rank: 3, title: "Stochastic block models revisited", year: 2010 }),
    record({ source: "semantic-scholar", query: "q3", rank: 5, title: "Stochastic Block Models Revisited", year: 2011 }),
    record({ source: "crossref", query: "q3", rank: 6, title: "Stochastic block models revisited", year: 2014 }),
    record({ source: "crossref", query: "q1", rank: 2, title: "Gaussian belief propagation solvers", doi: "10.1000/abc.r1", type: "peer-review", year: 2020 }),
  ];
  assert.equal(records[2]!.doi, undefined, "an arXiv DOI becomes the arXiv id");
  assert.equal(records[2]!.arxivId, "2101.00001");
  const merged = mergeLiteratureRecords(records);
  const byTitle = (prefix: string) => merged.filter((paper) => paper.title.toLowerCase().startsWith(prefix));
  const gbp = byTitle("gaussian belief");
  assert.equal(gbp.length, 2, "the Crossref peer review stays a separate (excluded) record");
  assert.deepEqual(gbp.find((paper) => !paper.nonPaper)!.sources, ["crossref", "semantic-scholar"]);
  assert.equal(gbp.find((paper) => paper.nonPaper)!.cid, "doi:10.1000/abc.r1");
  const vgg = byTitle("variational");
  assert.equal(vgg.length, 1);
  assert.equal(vgg[0]!.cid, "arxiv:2101.00001");
  const sbm = byTitle("stochastic");
  assert.equal(sbm.length, 2, "2010 and 2011 merge; 2014 is more than a year away");
  assert.deepEqual(sbm.map((paper) => paper.hits.length).sort(), [1, 2]);
  const decisions = paperDecisions(merged, 10, 1000);
  assert.equal(decisions[merged.indexOf(gbp.find((paper) => paper.nonPaper)!)], "excluded:type");
});

test("RRF counts one (best) rank per (query, source)", () => {
  const merged = mergeLiteratureRecords([
    record({ source: "arxiv", query: "q1", rank: 7, title: "One paper title for the test", doi: "10.1/x" }),
    record({ source: "arxiv", query: "q1", rank: 3, title: "One paper title for the test", doi: "10.1/x" }),
    record({ source: "crossref", query: "q1", rank: 10, title: "One paper title for the test", doi: "10.1/x" }),
    record({ source: "arxiv", query: "q2", rank: 1, title: "One paper title for the test", doi: "10.1/x" }),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.hits, [
    { source: "arxiv", query: "q1", rank: 3 },
    { source: "crossref", query: "q1", rank: 10 },
    { source: "arxiv", query: "q2", rank: 1 },
  ]);
  assert.equal(merged[0]!.rrf, round6(1 / 63 + 1 / 70 + 1 / 61));
});

test("eligibility: no abstract, short abstract, the RRF cap", () => {
  const long = "x".repeat(250);
  const merged = mergeLiteratureRecords([
    record({ source: "arxiv", query: "q1", rank: 1, title: "First paper with a long title", doi: "10.1/a", abstract: long }),
    record({ source: "arxiv", query: "q1", rank: 2, title: "Second paper with a long title", doi: "10.1/b", abstract: long }),
    record({ source: "arxiv", query: "q1", rank: 3, title: "Third paper with a long title", doi: "10.1/c", abstract: "short" }),
    record({ source: "arxiv", query: "q1", rank: 4, title: "Fourth paper with a long title", doi: "10.1/d" }),
  ]);
  assert.deepEqual(paperDecisions(merged, 200, 1), ["eligible", "excluded:cap", "excluded:short-abstract", "excluded:no-abstract"]);
});

/* -------------------------------------------------- vectors: kNN, placement */

function index(ids: string[], rows: number[][]): NodeVectorIndex {
  const dim = rows[0]!.length;
  const vectors = new Float32Array(ids.length * dim);
  rows.forEach((row, i) => {
    const norm = Math.hypot(...row);
    row.forEach((value, j) => (vectors[i * dim + j] = value / norm));
  });
  return { encoderId: "toy", taxonomyRevision: 1, nodeTextsSha256: "", vectorsSha256: "", ids, dim, vectors };
}

function unit(values: number[]): Float32Array {
  const norm = Math.hypot(...values);
  return Float32Array.from(values.map((value) => value / norm));
}

const TOY = index(["T1", "T2", "T3", "T4"], [
  [1, 0, 0],
  [0.8, 0.6, 0],
  [0, 1, 0],
  [0, 0, 1],
]);

test("route C: knnK nearest topics per item, the hop, ranking by cosine x max(w, 0.25), own need, the cap", () => {
  const items = [
    { id: 0, weight: 1, vector: unit([1, 0.05, 0]) },
    { id: null, weight: 0, vector: unit([0, 0.1, 1]) },
  ];
  const found = knnTopics(TOY, items, { knnK: 1, knnHopK: 0, knnMaxQueries: 20 });
  assert.deepEqual(found.map((entry) => [TOY.ids[entry.row], entry.own]), [["T1", 0], ["T4", null]]);
  assert.ok(found[1]!.score < 0.26, "a weight-0 item scores at 0.25 x cosine");
  // One hop from each topic found by an item (not from the hop's own finds):
  // T1's nearest other topic is T2; T4 is orthogonal to every other topic,
  // so its hop lands on the lowest row (T1, already found) and T3 stays out.
  const hopped = knnTopics(TOY, items, { knnK: 1, knnHopK: 1, knnMaxQueries: 20 });
  assert.deepEqual(hopped.map((entry) => TOY.ids[entry.row]).sort(), ["T1", "T2", "T4"]);
  assert.equal(knnTopics(TOY, items, { knnK: 2, knnHopK: 0, knnMaxQueries: 1 }).length, 1);
});

test("placement: margin weights against the (m+1)-th similarity, uniform when every margin is 0", () => {
  const placed = placeVector(TOY, unit([1, 0.2, 0]), 2);
  assert.deepEqual(placed.placement.map((entry) => entry.topic), ["T1", "T2"]);
  const sims = placed.placement.map((entry) => entry.sim);
  const expected = marginWeights(sims, placed.nextSim);
  assert.deepEqual(placed.placement.map((entry) => entry.pi), expected.map(round6));
  assert.equal(round6(expected.reduce((sum, value) => sum + value, 0)), 1);
  assert.deepEqual(marginWeights([0.5, 0.5, 0.5], 0.5), [1 / 3, 1 / 3, 1 / 3]);
});

/* ---------------------------------------------------------------- evidence */

test("evidence: D_f by similarity (ties to the higher RRF, then the id), omega margins, P(t|f), own share", () => {
  const papers = [
    paper("P0001", [0.9, 0.5, 0.1], [["T1", 0.7], ["T2", 0.3]]),
    paper("P0002", [0.8, 0.5, 0.2], [["T2", 1]], { rrf: 0.02, hits: [{ source: "arxiv", query: "q9", rank: 1 }] }),
    paper("P0003", [0.8, 0.4, 0.3], [["T3", 1]], { rrf: 0.02, cid: "doi:10.1/a-first" }),
    paper("P0004", [0.5, 0.3, 0.9], [["T4", 1]]),
  ];
  const input = composeInput(papers);
  const ev = needEvidence(input, 0, 2, 0.25);
  assert.deepEqual(ev.top, [0, 2], "P0003 beats P0002 on the canonical id at equal similarity and RRF");
  assert.equal(ev.sK1, 0.8);
  const margins = [0.9 - 0.8, 0.8 - 0.8];
  assert.deepEqual(ev.omega, [margins[0]! / (margins[0]! + margins[1]!), 0]);
  assert.deepEqual([...ev.shares], [["T1", 0.7], ["T2", 0.3], ["T3", 0]]);
  assert.equal(ev.ownShare, 0, "no D_f paper was found by a query owned by the core");
  assert.equal(ev.thin, true);
  const all = needEvidence(input, 1, 10, 0.25);
  assert.equal(all.sK1, null);
  assert.deepEqual(all.omega, [0.25, 0.25, 0.25, 0.25]);
  assert.equal(all.ownShare, 0.75);
  assert.equal(all.thin, false);
});

/* ------------------------------------------- candidates, greedy, size, seats */

function mkCandidate(cand: string, subfield: string, field: string, a: number[], M: number, kind: "topic" | "anchor" = "topic") {
  return { cand, kind, name: cand, subfield, subfieldName: subfield, field, fieldName: field, support: 2, a, P: a, M };
}

test("lazy greedy: largest gain first, ties by M then topic before anchor then id, caps drop for good, runner-up recorded", () => {
  const needs = [
    { id: 0, kind: "core", name: "core", weight: 1 },
    { id: 1, kind: "facet", name: "f1", weight: 1 },
  ];
  const candidates = [
    mkCandidate("T9", "S1", "F1", [0.8, 0], 0.3),
    mkCandidate("T8", "S1", "F1", [0.8, 0], 0.3),
    mkCandidate("anchor:1", "S2", "F1", [0, 0.8], 0.3, "anchor"),
    mkCandidate("T7", "S3", "F2", [0, 0.8], 0.3),
    mkCandidate("T6", "S3", "F2", [0.4, 0.4], 0.5),
  ];
  const result = lazyGreedy(candidates, needs, { kMax: 4, subfieldCap: 0, fieldCap: 1 });
  // Round 1: T6/T7/T8/T9/anchor tie at 0.8; T6 (M 0.5) wins on M.
  assert.deepEqual(result.order.map((i) => candidates[i]!.cand), ["T6", "T8"]);
  assert.equal(result.picks[0]!.gain, 0.8);
  assert.equal(candidates[result.picks[0]!.runnerUp!]!.cand, "T7", "runner-up: equal gain, equal M, topic before anchor, smaller id among T7/T8/T9");
  assert.deepEqual(result.picks[0]!.contrib, [[0, 0.4], [1, 0.4]]);
  const dropped = result.dropped.map((entry) => [candidates[entry.index]!.cand, entry.why, entry.atK]);
  assert.ok(dropped.some(([cand, why]) => cand === "T7" && why === "field cap"));
  assert.ok(dropped.some(([cand, why]) => cand === "anchor:1" && why === "field cap"));
  const capped = lazyGreedy(candidates, needs, { kMax: 4, subfieldCap: 1, fieldCap: 4 });
  assert.ok(capped.dropped.some((entry) => candidates[entry.index]!.cand === "T9" && entry.why === "subfield cap"));
});

test("k*: the first k >= 2 whose next gain is below eps W; k_cov on the critical needs", () => {
  assert.equal(kStarOf([1, 0.5, 0.1, 0.01], 0.2), 2);
  assert.equal(kStarOf([1, 0.5, 0.3, 0.01], 0.2), 3);
  assert.equal(kStarOf([1], 0.2), 2);
  assert.equal(kStarOf([1, 0.9, 0.8], 0.2), 3);
});

test("panel.compose: candidates and affinities, anchors, rescue of an uncovered critical facet, k* and k_cov, seats and flags", () => {
  // Three needs; need 2 (a critical facet) is covered by no topic and gets an anchor.
  const papers = [
    paper("P0001", [0.9, 0.9, 0.1], [["T1", 1]]),
    paper("P0002", [0.85, 0.8, 0.12], [["T1", 0.6], ["T2", 0.4]]),
    paper("P0003", [0.8, 0.7, 0.13], [["T2", 1]]),
    paper("P0004", [0.7, 0.6, 0.14], [["T3", 0.5], ["T4", 0.5]]),
    paper("P0005", [0.6, 0.5, 0.15], [["T3", 0.5], ["T4", 0.5]]),
  ];
  const input = composeInput(papers);
  const evidence = composePanelEvidence(input, { ...params, papersPerNeed: 3, panelSize: 4 }, hierarchy);
  const parsed = artifactSchemas.panelEvidence.safeParse(evidence);
  assert.ok(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues.slice(0, 3)));
  const candidates = evidence.candidates as unknown as Array<{ cand: string; a: number[]; P: number[]; kind: string; anchorNeed?: number }>;
  for (const candidate of candidates.filter((entry) => entry.kind === "topic")) {
    candidate.P.forEach((share, f) => assert.ok(Math.abs(candidate.a[f]! - 0.8 * Math.min(1, share / 0.3)) < 1e-5));
  }
  assert.deepEqual(candidates.map((entry) => entry.cand), [...candidates.filter((entry) => entry.kind === "topic").map((entry) => entry.cand).sort(), ...candidates.filter((entry) => entry.kind === "anchor").map((entry) => entry.cand)]);
  const greedy = evidence.greedy as unknown as { kStar: number; kCov: number | null; rescued: string[]; trace: Array<{ cand: string; gain: number }> };
  const seats = evidence.seats as unknown as Array<{ cand: string; kind: string; inKStar: boolean; department: string; umbrella: string; subfields: string[] }>;
  assert.ok(seats.length >= 2 && seats.length <= 4);
  assert.equal(seats.filter((seat) => seat.inKStar).length, Math.min(greedy.kStar, seats.length));
  for (const seat of seats.filter((entry) => entry.kind === "topic")) {
    const node = NODES.find((entry) => entry.id === seat.cand)!;
    assert.deepEqual(seat.subfields, [node.name]);
  }
  const again = composePanelEvidence(input, { ...params, papersPerNeed: 3, panelSize: 4 }, hierarchy);
  assert.equal(again.determinismSha256, evidence.determinismSha256, "deterministic");
  const flags = evidence.flags as unknown as { sourceShare: Record<string, number>; thinNeeds: string[] };
  assert.deepEqual(flags.sourceShare, { arxiv: 1 });
});

test("rescue: a critical facet below anchorThreshold at k* gets its anchored seat right after k*, k* grows by one", () => {
  // Need 2 ("gaussian distributions", a critical facet) has evidence only in
  // T3/T4, each placed by one evidence paper (below minSupport): no topic
  // candidate covers it, and with anchors off nothing anchors it at Step 7.
  const papers = [
    paper("P0001", [0.9, 0.9, 0.1], [["T1", 1]]),
    paper("P0002", [0.88, 0.85, 0.1], [["T1", 1]]),
    paper("P0003", [0.2, 0.2, 0.95], [["T3", 1]]),
    paper("P0004", [0.1, 0.1, 0.94], [["T4", 1]]),
  ];
  const input = composeInput(papers);
  const config = { ...params, papersPerNeed: 2, panelSize: 4, anchors: false };
  const evidence = composePanelEvidence(input, config, hierarchy) as unknown as {
    greedy: { kStar: number; rescued: string[]; trace: Array<{ k: number; cand: string }> };
    seats: Array<{ cand: string; kind: string; department: string; umbrella: string; subfields: string[]; inKStar: boolean }>;
    candidates: Array<{ cand: string; kind: string; P: number[] }>;
  };
  assert.deepEqual(evidence.greedy.rescued, ["anchor:2"]);
  assert.deepEqual(evidence.seats.map((seat) => seat.cand), ["T1", "anchor:2"]);
  assert.equal(evidence.greedy.kStar, 2);
  assert.deepEqual(evidence.greedy.trace.map((entry) => [entry.k, entry.cand]), [[1, "T1"], [2, "anchor:2"]]);
  const anchored = evidence.seats[1]!;
  assert.deepEqual(
    [anchored.kind, anchored.department, anchored.umbrella, anchored.subfields, anchored.inKStar],
    ["anchor", "Mathematics", "Statistics and Probability", ["gaussian distributions"], true],
  );
  assert.deepEqual(evidence.candidates.find((candidate) => candidate.cand === "anchor:2")!.P, []);
  const off = composePanelEvidence(input, { ...config, rescueUncoveredNeeds: false }, hierarchy) as unknown as typeof evidence;
  assert.deepEqual(off.greedy.rescued, []);
  assert.deepEqual(off.seats.map((seat) => seat.cand), ["T1"]);
});

test("panel.seat: k* in auto mode, panelSize in fixed mode, never fewer than 2 nor more than the seats", () => {
  const seat = (id: string, focus: string) => ({ id, department: "Computer Science", umbrella: "Artificial Intelligence", subfields: [focus] });
  const evidence = {
    greedy: { kStar: 3 },
    seats: [seat("member-1", "a"), seat("member-2", "b"), seat("member-3", "c"), seat("member-4", "d"), seat("member-5", "e")],
  } as unknown as JsonObject;
  const ids = (panel: JsonObject) => (panel.members as unknown as Array<{ id: string }>).map((member) => member.id);
  assert.deepEqual(ids(seatPanel(evidence, 6, "auto")), ["member-1", "member-2", "member-3"]);
  assert.deepEqual(ids(seatPanel(evidence, 4, "fixed")), ["member-1", "member-2", "member-3", "member-4"]);
  assert.deepEqual(ids(seatPanel(evidence, 12, "fixed")).length, 5);
  assert.deepEqual(ids(seatPanel({ ...evidence, greedy: { kStar: 1 } } as JsonObject, 6, "auto")).length, 2);
  const duplicate = { greedy: { kStar: 2 }, seats: [seat("member-1", "a"), seat("member-2", "a"), seat("member-3", "c")] } as unknown as JsonObject;
  assert.deepEqual(ids(seatPanel(duplicate, 6, "auto")), ["member-1", "member-3"]);
  assert.ok(artifactSchemas.panel.safeParse(seatPanel(evidence, 6, "auto")).success);
});

test("rounding and the determinism hash follow Python: round-half-even ties, repr floats, sorted compact JSON", () => {
  assert.equal(round6(0.0078125), 0.007812);
  // 0.0078135 is stored just below the tie, so Python gives 0.007813.
  assert.equal(round6(0.0078135), 0.007813);
  assert.equal(round6(0.0234375), 0.023438);
  assert.equal(round6(1 / 3), 0.333333);
  assert.equal(pythonFloat(1), "1.0");
  assert.equal(pythonFloat(0.5), "0.5");
  assert.equal(pythonFloat(0.0001), "0.0001");
  assert.equal(pythonFloat(0.00001), "1e-05");
  assert.equal(pythonFloat(0.000012), "1.2e-05");
  assert.equal(pythonFloat(1e16), "1e+16");
  assert.equal(pythonFloat(123456.5), "123456.5");
  assert.equal(pythonCanonicalJson({ k: 2, b: [1, 0.25], a: "x" }, new Set(["k"])), '{"a":"x","b":[1.0,0.25],"k":2}');
});

/* ------------------------------------------------------ feedback and rounds */

test("route E: phrases from the seeds scored df_seeds x log(N/df_all), used queries excluded", () => {
  assert.ok(candidatePhrases("Gaussian belief propagation converges. On graphs").has("gaussian belief propagation"));
  assert.ok(!candidatePhrases("propagation of beliefs").has("propagation of"));
  const seeds = ["Gaussian belief propagation on loopy graphs", "Loopy graphs and Gaussian belief propagation"];
  const corpus = [...seeds, "Graph neural networks for molecules", "Random graphs and loopy graphs"];
  const terms = feedbackTerms(seeds, corpus, 3, (phrase) => phrase === "belief propagation");
  assert.equal(terms[0], "gaussian belief", "df 2 in the seeds, df 2 overall");
  assert.ok(!terms.includes("belief propagation"));
});

test("rounds stop when a round adds fewer than minNewShare new eligible papers (share of all eligible after the round)", () => {
  assert.equal(stopAfterRound(5, 105, 0.1), true);
  assert.equal(stopAfterRound(11, 110, 0.1), false);
  assert.equal(stopAfterRound(10, 110, 0.1), true);
  assert.equal(stopAfterRound(0, 0, 0.1), true);
});

/* ------------------------------------------------------- activities end to end */

class FakeTaxonomy implements TaxonomyAccess {
  async resolve(): Promise<never> {
    throw new Error("unused");
  }
  async tree(): Promise<never> {
    throw new Error("unused");
  }
  async suggest(): Promise<never> {
    throw new Error("unused");
  }
  async embeddings(): Promise<TaxonomyEmbeddings> {
    return {
      revision: 3,
      embedder: { id: "hash-ngram-v1", dim: 256, version: 1, thresholds: {} as never, nodeTemplate: "", queryTemplate: "", verification: [] },
      nodes: NODES,
      vectors: [],
    };
  }
}

function fakeWeb(calls: PaperSearchQuery[], options: { blocked?: string } = {}): WebAccess {
  const corpus: Record<string, PaperRecord[]> = {};
  const abstract = (topic: string) =>
    `This paper studies ${topic} with graphs whose nodes carry Gaussian distributions and whose edges are Bernoulli variables; it derives message updates, analyses convergence and evaluates graph generation on benchmark data sets in detail.`;
  return {
    search: async () => { throw new Error("unused"); },
    fetch: async () => { throw new Error("unused"); },
    backedKinds: () => ["scholarly"],
    status: () => ["arxiv", "crossref", "semantic-scholar", "openalex", "europepmc", "core", "opencitations"].map((id) => ({ id, state: id === "core" ? ("needs-key" as const) : ("unchecked" as const) })),
    async searchPapers(query: PaperSearchQuery): Promise<PaperSearchAnswer> {
      calls.push(query);
      const source = query.sources![0]!;
      if (source === options.blocked) throw new Error(`paper search failed — ${source}: ${source} answered HTTP 429`);
      const text = query.query !== "" ? query.query : (query.native?.query ?? "");
      const key = `${source}:${text}`;
      corpus[key] ??= [0, 1, 2].map((n) => ({
        title: `${text.replace(/[^a-z ]/gi, "")} study ${n}`,
        url: `https://example.org/${n}`,
        doi: `10.5555/${(text.replace(/[^a-z]/gi, "").slice(0, 12) + n).toLowerCase()}`,
        year: 2020,
        abstract: abstract(text),
        source,
      }));
      return { query: text, mode: "topic", route: "paper-topic", providers: [source], papers: corpus[key]! };
    },
    async paperDetails(query: PaperDetailsQuery): Promise<PaperDetailsAnswer> {
      return {
        papers: query.ids.map((id) => ({
          requested: id,
          title: "seed",
          url: "x",
          source: query.sources?.[0] ?? "semantic-scholar",
          references: [{ title: "A cited classic on loopy belief propagation", url: "y", doi: "10.7777/classic", source: "semantic-scholar", abstract: abstract("loopy belief propagation") }],
        })),
        notFound: [],
        providers: [query.sources?.[0] ?? "semantic-scholar"],
      };
    },
  };
}

test("literatureActivities end to end: retrieval record, compose, seat — schemas hold, the probe blocks a 429 source", async () => {
  const calls: PaperSearchQuery[] = [];
  const activities = literatureActivities({
    web: fakeWeb(calls, { blocked: "crossref" }),
    taxonomy: new FakeTaxonomy(),
    encoders: hashNgramEncoderProvider(),
    nodeTexts: {
      texts: async () => ({
        sha256: "0".repeat(64),
        entries: NODES.filter((node) => node.level === "topic").map((node) => ({ id: node.id, text: `${node.name}. A research topic about ${node.name.toLowerCase()}.` })),
      }),
    },
    keyedSources: new Set(),
  });
  const context = { runId: "r1", nodePath: "retrieve-literature", signal: new AbortController().signal };
  const config = { ...PANEL_COMPOSITION_DEFAULTS, maxCalls: 60, encoder: "specter2" } as unknown as JsonValue;
  const literature = (await activities["literature.retrieve"]!({ classification: { embeddingInput: EI } as unknown as JsonValue, input: {}, config }, context)) as JsonObject;
  const parsed = artifactSchemas.literature.safeParse(literature);
  assert.ok(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues.slice(0, 3)));
  const sources = Object.fromEntries((literature.sources as unknown as Array<{ id: string; state: string }>).map((entry) => [entry.id, entry.state]));
  assert.equal(sources.crossref, "unavailable", "the first crossref call failed with 429");
  assert.equal(sources.openalex, "needs-key");
  assert.equal(sources.core, "needs-key");
  assert.equal(calls.filter((call) => call.sources?.[0] === "crossref").length, 1, "a blocked source is probed once");
  assert.equal(calls.filter((call) => call.sources?.[0] === "openalex").length, 0, "OpenAlex is never called keyless");
  const encoder = literature.encoder as unknown as { id: string; taxonomyRevision: number };
  assert.equal(encoder.id, "hash-ngram-v1", "specter2 is not installed here: the record names the fallback");
  assert.equal(encoder.taxonomyRevision, 3);
  const flags = literature.flags as unknown as { notes: string[]; budgetExhausted: boolean };
  assert.ok(flags.notes.some((note) => note.includes("fell back to hash-ngram-v1")));
  assert.ok((literature.calls as unknown as unknown[]).length <= 60, "the call budget holds");
  const papers = literature.papers as unknown as Array<{ decision: string; placement?: unknown[]; needSims?: number[]; rounds: number[] }>;
  const eligible = papers.filter((entry) => entry.decision === "eligible");
  assert.ok(eligible.length > 0);
  for (const entry of eligible) {
    assert.equal(entry.placement!.length, 3);
    assert.equal(entry.needSims!.length, (literature.needs as unknown[]).length);
  }
  const screen = await activities["literature.noScreen"]!({ literature }, context);
  assert.deepEqual(screen, { decisions: [], skipped: "relevance screen off" });
  const evidence = (await activities["panel.compose"]!({ literature, screen, config }, context)) as JsonObject;
  const evidenceParsed = artifactSchemas.panelEvidence.safeParse(evidence);
  assert.ok(evidenceParsed.success, JSON.stringify(evidenceParsed.success ? "" : evidenceParsed.error.issues.slice(0, 3)));
  const panel = await activities["panel.seat"]!({ evidence, panelSize: 6, panelSizeMode: "auto" }, context);
  assert.ok(artifactSchemas.panel.safeParse(panel).success);
  const again = (await activities["panel.compose"]!({ literature, screen, config }, context)) as JsonObject;
  assert.equal(again.determinismSha256, evidence.determinismSha256);
});

test("literature.retrieve without web access returns an empty record noting it; compose falls back to label-only shares", async () => {
  const activities = literatureActivities({ taxonomy: new FakeTaxonomy(), encoders: hashNgramEncoderProvider() });
  const context = { runId: "r1", nodePath: "n", signal: new AbortController().signal };
  const literature = (await activities["literature.retrieve"]!({ classification: { embeddingInput: EI } as unknown as JsonValue, input: {}, config: {} }, context)) as JsonObject;
  assert.ok(artifactSchemas.literature.safeParse(literature).success);
  assert.equal(((literature.flags as JsonObject).notes as string[])[0], "no web access");
  assert.deepEqual(literature.papers, []);
  const evidence = (await activities["panel.compose"]!({ literature, screen: { decisions: [] }, config: {} }, context)) as JsonObject;
  assert.ok(artifactSchemas.panelEvidence.safeParse(evidence).success);
  const notes = ((evidence.flags as JsonObject).notes ?? []) as string[];
  assert.ok(notes.some((note) => note.startsWith("no literature evidence")));
});

test("a screened-out paper leaves the evidence and is counted", () => {
  const literature = {
    needs: [{ id: 0, kind: "core", name: "core", text: "t", weight: 1, mode: "doc" }],
    queries: [],
    calls: [{ source: "arxiv", query: "q1", ok: false, outcome: "error", n: 0, nAbstract: 0 }],
    sources: [{ id: "semantic-scholar", state: "unavailable" }],
    papers: [
      { pid: "P0001", cid: "a", decision: "eligible", rrf: 0.1, sources: ["arxiv"], hits: [], placement: [{ topic: "T1", sim: 0.5, pi: 1 }], needSims: [0.5] },
      { pid: "P0002", cid: "b", decision: "eligible", rrf: 0.1, sources: ["arxiv"], hits: [], placement: [{ topic: "T1", sim: 0.5, pi: 1 }], needSims: [0.4] },
    ],
  } as unknown as JsonObject;
  const input = composeInputFromLiterature(literature, { decisions: [{ pid: "P0002", onTopic: false, reason: "off topic" }] } as unknown as JsonObject);
  assert.deepEqual(input.papers.map((entry) => entry.pid), ["P0001"]);
  assert.equal(input.screenedOut, 1);
  assert.deepEqual(input.failedSources, ["arxiv", "semantic-scholar"]);
});

/* ---------------------------------------------------------------- editRule needs */

test("editRule needs: removals and weight changes only, no text added or rewritten, at least 3 facets", () => {
  const valid = { ...EI, facets: [{ ...EI.facets[0]!, aliases: ["belief propagation", "sum-product algorithm"] }, EI.facets[1]!, EI.facets[2]!] };
  assert.ok(embeddingInputSchema.safeParse(valid).success, "the fixture is a valid classifier v2 embeddingInput");
  const current = structuredClone(valid) as unknown as JsonObject;
  const facets = valid.facets;
  const ok = applyNeedsEdit(current, { ...valid, facets: [facets[0], { ...facets[1], relevance: 0.3 }, facets[2]], equivalentProblems: [] } as unknown as JsonValue, "confirm-needs");
  assert.equal(((ok.facets as unknown as Array<{ relevance: number }>)[1]!).relevance, 0.3);
  const aliasRemoved = applyNeedsEdit(current, { ...valid, facets: [{ ...facets[0], aliases: ["sum-product algorithm"] }, facets[1], facets[2]] } as unknown as JsonValue, "g");
  assert.deepEqual((aliasRemoved.facets as unknown as Array<{ aliases?: string[] }>)[0]!.aliases, ["sum-product algorithm"]);
  const EIv = valid;
  const reject = (edited: unknown, pattern: RegExp) =>
    assert.throws(() => applyNeedsEdit(current, edited as JsonValue, "g"), pattern);
  reject({ ...EIv, facets: [facets[0], facets[1]] }, /at least 3 facets/);
  reject({ ...EIv, facets: [facets[0], { ...facets[1], statement: "Rewritten statement of the facet, long enough to pass the schema." }, facets[2]] }, /may not change "statement"/);
  reject({ ...EIv, facets: [...facets, { name: "new facet", statement: "A new facet the classifier never produced at all.", relevance: 0.5 }] }, /not one of the classifier's facets/);
  reject({ ...EIv, facets: [{ ...facets[0], aliases: ["a new alias"] }, facets[1], facets[2]] }, /is not one of its aliases/);
  reject({ ...EIv, facets: [facets[0], { ...facets[1], relevance: 1.5 }, facets[2]] }, /within \[0, 1\]/);
  reject({ ...EIv, title: "A different title for the same submission" }, /may not change "title"/);
  reject({ ...EIv, equivalentProblems: [{ ...EIv.equivalentProblems[0], confidence: 2 }] }, /confidence within/);
  reject({ ...EIv, facets: [facets[1], facets[0], facets[2]] }, /out of order/);
});

/* ------------------------------------------------------------- prototype parity */

const fixtureRoot = new URL("../../test/fixtures/panel-parity/", import.meta.url);
const taxonomyPath = new URL("../../../../../brain/content-src/brainstorm/catalog/taxonomy.json", import.meta.url);
const parityRuns = existsSync(fixtureRoot)
  ? readdirSync(fixtureRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  : [];

if (parityRuns.length === 0) {
  test("parity with the Python prototype (compose2.py)", { skip: "pending: the prototype fixtures have not been delivered" }, () => {});
}
for (const run of parityRuns) {
  test(`parity with the Python prototype (compose2.py), run ${run}: greedy trace, seats, kStar, kCov, evidence, flags, hash`, () => {
    const taxonomy = JSON.parse(readFileSync(taxonomyPath, "utf8")) as { nodes: Array<{ id: string; name: string; level: string; parent?: string }> };
    const tax = topicHierarchy(taxonomy.nodes);
    const dir = new URL(`${run}/`, fixtureRoot);
    // A run that shares another run's literature names it in literature.ref.
    const refUrl = new URL("literature.ref", dir);
    const literatureUrl = existsSync(refUrl)
      ? new URL(readFileSync(refUrl, "utf8").trim(), dir)
      : new URL("literature.json", dir);
    const literature = JSON.parse(readFileSync(literatureUrl, "utf8")) as JsonObject;
    const expected = JSON.parse(readFileSync(new URL("panelEvidence.json", dir), "utf8")) as JsonObject;
    const screenUrl = new URL("literatureScreen.json", dir);
    const screen = existsSync(screenUrl) ? (JSON.parse(readFileSync(screenUrl, "utf8")) as JsonObject) : { decisions: [], skipped: "relevance screen off" };
    const config = panelCompositionParams(expected.params);
    const actual = composePanelEvidence(composeInputFromLiterature(literature, screen), config, tax);
    const pick = (record: JsonObject) => record.greedy as JsonObject;
    assert.deepEqual(pick(actual).trace, pick(expected).trace, `${run}: greedy trace`);
    assert.deepEqual(actual.seats, expected.seats, `${run}: seats`);
    assert.equal(pick(actual).kStar, pick(expected).kStar, `${run}: kStar`);
    assert.equal(pick(actual).kCov, pick(expected).kCov, `${run}: kCov`);
    assert.deepEqual(pick(actual).droppedByCap, pick(expected).droppedByCap, `${run}: dropped by cap`);
    assert.deepEqual(pick(actual).rescued, pick(expected).rescued, `${run}: rescued`);
    assert.deepEqual(actual.evidence, expected.evidence, `${run}: evidence`);
    assert.deepEqual(actual.candidates, expected.candidates, `${run}: candidates`);
    assert.deepEqual(actual.flags, expected.flags, `${run}: flags`);
    assert.equal(actual.determinismSha256, expected.determinismSha256, `${run}: determinism hash`);
  });
}
