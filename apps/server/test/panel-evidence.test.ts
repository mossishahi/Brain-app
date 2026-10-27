import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNeedsGateView,
  buildPanelEvidenceView,
  needsEditViolation,
  paperUrl,
} from "../src/panel-evidence.js";

/** A panelEvidence record shaped as contract E specifies (values rounded to 6 dp). */
const evidence = {
  version: 1,
  params: { criticalWeight: 0.5, criticalCoverage: 0.75, panelSize: 6, panelSizeMode: "auto" },
  evidence: [
    { need: 0, ownShare: 0.4, thin: false, sK1: 0.71, papers: [{ pid: "P1", sim: 0.8, omega: 0.3 }], topTopics: [] },
    { need: 1, ownShare: 0.3, thin: false, sK1: 0.66, papers: [], topTopics: [] },
    { need: 2, ownShare: 0.1, thin: true, sK1: null, papers: [], topTopics: [] },
  ],
  candidates: [
    { cand: "T1", kind: "topic", name: "Graph Neural Networks", subfield: "S1702", field: "F17", support: 9, a: [0.8, 0.6, 0], P: [0.5, 0.4, 0], M: 0.4 },
    { cand: "T2", kind: "topic", name: "Belief Propagation", subfield: "S1712", field: "F17", support: 4, a: [0.2, 0.1, 0.7], P: [0.1, 0.1, 0.6], M: 0.2 },
    { cand: "A:2", kind: "anchor", name: "random graph models", subfield: "S2604", field: "F26", support: 0, a: [0, 0, 0.6], P: [0, 0, 0], M: 0, anchorNeed: 2 },
  ],
  greedy: {
    trace: [
      { k: 1, cand: "T1", gain: 1.29, F: 1.29, Fnorm: 0.573333, coverage: [0.8, 0.6, 0], runnerUp: "Belief Propagation", runnerUpGain: 0.5, contrib: { "0": 0.8 } },
      { k: 2, cand: "T2", gain: 0.405, F: 1.695, Fnorm: 0.753333, coverage: [0.84, 0.64, 0.7], contrib: { "2": 0.35 } },
      { k: 3, cand: "A:2", gain: 0.09, F: 1.785, Fnorm: 0.793333, coverage: [0.84, 0.64, 0.88], contrib: { "2": 0.09 } },
    ],
    droppedByCap: [{ cand: "T2", why: "field cap", atK: 3, gain: 0.01 }],
    rescued: ["A:2"],
    kStar: 2,
    kCov: null,
    epsW: 0.1125,
  },
  seats: [
    { id: "member-1", department: "Computer Science", umbrella: "Artificial Intelligence", subfields: ["Graph Neural Networks"], kind: "topic", cand: "T1", covers: ["core", "message passing"], exemplars: [{ pid: "P1", score: 0.2 }, { pid: "P2", score: 0.1 }], inKStar: true },
    { id: "member-2", department: "Computer Science", umbrella: "Signal Processing", subfields: ["Belief Propagation"], kind: "topic", cand: "T2", covers: ["random graphs"], exemplars: [{ pid: "P3", score: 0.15 }], inKStar: true },
    { id: "member-3", department: "Mathematics", umbrella: "random graph models", subfields: ["random graph models"], kind: "anchor", cand: "A:2", covers: ["random graphs"], exemplars: [], inKStar: false },
  ],
  flags: { sourceShare: { arxiv: 0.7, crossref: 0.3 }, sourceAlarm: ["arxiv"], thinNeeds: ["random graph models"], anchoredSeats: ["member-3"], failedSources: ["semantic-scholar"], screenedOut: 2, weakPlacements: 4 },
  determinismSha256: "ab".repeat(32),
};

const literature = {
  version: 1,
  needs: [
    { id: 0, kind: "core", name: "core", text: "Gaussian message passing.", weight: 1, mode: "doc" },
    { id: 1, kind: "facet", name: "message passing", text: "message passing: ...", weight: 0.95, mode: "query" },
    { id: 2, kind: "facet", name: "random graph models", text: "random graph models: ...", weight: 0.3, mode: "query" },
  ],
  W: 2.25,
  sources: [
    { id: "arxiv", state: "available" },
    { id: "openalex", state: "needs-key" },
    { id: "semantic-scholar", state: "unavailable", detail: "HTTP 429 on the first call" },
  ],
  papers: [
    { pid: "P1", cid: "c1", title: "Gaussian Belief Propagation", year: 2019, ids: { doi: "10.1000/gbp", arxivId: "1901.0001" } },
    { pid: "P2", cid: "c2", title: "Message Passing Neural Networks", ids: { arxivId: "1704.01212" } },
    { pid: "P3", cid: "c3", title: "Approximate Message Passing", year: 2010, ids: { s2Id: "abc123" } },
  ],
  flags: { hubs: [{ topic: "T9", share: 0.55 }], budgetExhausted: true, notes: ["route C used hash-ngram-v1"] },
};

test("the coverage view joins panelEvidence with the literature record", () => {
  const view = buildPanelEvidenceView(evidence, literature);
  assert.ok(view);
  assert.equal(view.kStar, 2);
  assert.equal(view.kCov, null);
  assert.equal(view.W, 2.25);
  assert.equal(view.panelSizeMode, "auto");
  assert.deepEqual(
    view.needs.map((need) => [need.index, need.name, need.weight, need.critical, need.thin]),
    [
      [0, "core", 1, true, false],
      [1, "message passing", 0.95, true, false],
      [2, "random graph models", 0.3, false, true],
    ],
  );
  assert.deepEqual(view.seats.map((seat) => [seat.order, seat.id, seat.cand, seat.inKStar, seat.rescued]), [
    [1, "member-1", "T1", true, false],
    [2, "member-2", "T2", true, false],
    [3, "member-3", "A:2", false, true],
  ]);
  assert.deepEqual(view.seats[0]!.a, [0.8, 0.6, 0]);
  assert.equal(view.seats[0]!.name, "Graph Neural Networks");
  assert.deepEqual(view.seats[0]!.exemplars, [
    { pid: "P1", score: 0.2, title: "Gaussian Belief Propagation", year: 2019, url: "https://doi.org/10.1000/gbp" },
    { pid: "P2", score: 0.1, title: "Message Passing Neural Networks", url: "https://arxiv.org/abs/1704.01212" },
  ]);
  assert.equal(view.seats[1]!.exemplars[0]!.url, "https://www.semanticscholar.org/paper/abc123");
  assert.deepEqual(view.curve.map((point) => [point.k, point.Fnorm, point.gain]), [
    [1, 0.573333, 1.29],
    [2, 0.753333, 0.405],
    [3, 0.793333, 0.09],
  ]);
  assert.equal(view.curve[0]!.runnerUp, "Belief Propagation");
  assert.deepEqual(view.droppedByCap, [
    { cand: "T2", name: "Belief Propagation", why: "field cap", atK: 3, gain: 0.01 },
  ]);
  assert.deepEqual(view.flags.sourceShare, { arxiv: 0.7, crossref: 0.3 });
  assert.deepEqual(view.flags.sourceAlarm, ["arxiv"]);
  assert.equal(view.flags.screenedOut, 2);
  assert.equal(view.flags.budgetExhausted, true);
  assert.deepEqual(view.flags.hubs, [{ topic: "T9", share: 0.55 }]);
  assert.deepEqual(view.flags.notes, ["route C used hash-ngram-v1"]);
  assert.deepEqual(
    view.flags.sources.map((source) => source.state),
    ["available", "needs-key", "unavailable"],
  );
  assert.equal(view.determinismSha256, "ab".repeat(32));
});

test("runs without a v1 panelEvidence record get no coverage view", () => {
  assert.equal(buildPanelEvidenceView(undefined, literature), undefined);
  assert.equal(buildPanelEvidenceView({ ...evidence, version: 2 }, literature), undefined);
  assert.equal(buildPanelEvidenceView("not an object", undefined), undefined);
});

test("without the literature record the view still renders from panelEvidence alone", () => {
  const view = buildPanelEvidenceView(evidence, undefined);
  assert.ok(view);
  assert.deepEqual(view.needs.map((need) => need.name), ["need 0", "need 1", "need 2"]);
  assert.equal(view.needs[2]!.thin, true);
  assert.deepEqual(view.seats[0]!.exemplars.map((paper) => paper.pid), ["P1", "P2"]);
  assert.equal(view.seats[0]!.exemplars[0]!.title, undefined);
});

test("paper links prefer the DOI, then arXiv, PubMed, Semantic Scholar, OpenAlex, CORE", () => {
  assert.equal(paperUrl({ doi: "https://doi.org/10.1/x", arxivId: "1" }), "https://doi.org/10.1/x");
  assert.equal(paperUrl({ arxivId: "arXiv:2101.00001" }), "https://arxiv.org/abs/2101.00001");
  assert.equal(paperUrl({ pmid: "123" }), "https://pubmed.ncbi.nlm.nih.gov/123/");
  assert.equal(paperUrl({ oaId: "W123" }), "https://openalex.org/W123");
  assert.equal(paperUrl({ coreId: "99" }), "https://core.ac.uk/works/99");
  assert.equal(paperUrl({}), undefined);
  assert.equal(paperUrl(undefined), undefined);
});

const embeddingInput = {
  title: "Message passing over Gaussian node distributions",
  abstract: "A".repeat(160),
  facets: [
    { name: "message passing", statement: "S".repeat(50), relevance: 0.95, aliases: ["belief propagation", "sum-product"], kind: "method" },
    { name: "graph generation", statement: "G".repeat(50), relevance: 0.9, kind: "problem" },
    { name: "random graph models", statement: "R".repeat(50), relevance: 0.7, aliases: ["Erdos-Renyi graphs"] },
    { name: "variational inference", statement: "V".repeat(50), relevance: 0.6 },
  ],
  problemFormulation: "F".repeat(200),
  equivalentProblems: [
    { field: "signal processing", name: "Gaussian belief propagation", statement: "E".repeat(50), confidence: 0.8 },
    { field: "statistics", name: "Gaussian graphical models", statement: "H".repeat(50), confidence: 0.5 },
  ],
  keyTerms: ["bernouli distributions"],
};

test("editRule needs accepts removals and re-weighting", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edited: any = structuredClone(embeddingInput);
  edited.facets.splice(1, 1);
  edited.facets[0]!.aliases = ["sum-product"];
  edited.facets[0]!.relevance = 0.5;
  edited.equivalentProblems.splice(0, 1);
  edited.equivalentProblems[0]!.confidence = 0;
  assert.equal(needsEditViolation(embeddingInput, edited), undefined);
  assert.equal(needsEditViolation(embeddingInput, structuredClone(embeddingInput)), undefined);
  const withoutEquivalents: Record<string, unknown> = structuredClone(embeddingInput);
  delete withoutEquivalents.equivalentProblems;
  assert.equal(needsEditViolation(embeddingInput, withoutEquivalents), undefined);
});

test("editRule needs refuses additions, rewrites, out-of-range weights and fewer than 3 facets", () => {
  const cases: [string, (input: any) => void, RegExp][] = [
    ["added facet", (input) => input.facets.push({ name: "new", statement: "N".repeat(50), relevance: 0.5 }), /not one of the classifier's facets/],
    ["rewritten statement", (input) => { input.facets[0].statement = "changed"; }, /statement cannot be rewritten/],
    ["rewritten title", (input) => { input.title = "Another title"; }, /title cannot be rewritten/],
    ["relevance above 1", (input) => { input.facets[0].relevance = 1.5; }, /within \[0, 1\]/],
    ["confidence below 0", (input) => { input.equivalentProblems[1].confidence = -0.1; }, /within \[0, 1\]/],
    ["two facets left", (input) => input.facets.splice(0, 2), /at least 3 facets/],
    ["reordered facets", (input) => input.facets.reverse(), /out of order/],
    ["added alias", (input) => input.facets[0].aliases.push("loopy BP"), /not one of the classifier's aliases/],
    ["added key", (input) => { input.extra = 1; }, /cannot be added/],
    ["removed key terms", (input) => { delete input.keyTerms; }, /keyTerms cannot be removed/],
    ["added equivalent", (input) => input.equivalentProblems.push({ field: "f", name: "n", statement: "s".repeat(50), confidence: 0.1 }), /equivalent problem/],
    ["rewritten equivalent", (input) => { input.equivalentProblems[0].statement = "x"; }, /statement cannot be rewritten/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const edited = structuredClone(embeddingInput);
    mutate(edited);
    const violation = needsEditViolation(embeddingInput, edited);
    assert.ok(violation !== undefined, `${label} must be refused`);
    assert.match(violation, pattern, label);
  }
  assert.match(needsEditViolation(undefined, embeddingInput)!, /no embeddingInput/);
  assert.match(needsEditViolation(embeddingInput, [])!, /must be an object/);
});

test("the needs gate view carries the run's weight params, defaulting to spec 0.1", () => {
  const view = buildNeedsGateView("confirm-needs", { embeddingInput }, { coreWeight: 0.9, formulationWeight: 0 });
  assert.ok(view);
  assert.deepEqual(view.weights, { coreWeight: 0.9, formulationWeight: 0, equivalentProblemWeight: 0 });
  assert.equal(view.embeddingInput.title, embeddingInput.title);
  assert.deepEqual(buildNeedsGateView("confirm-needs", { embeddingInput }, undefined)!.weights, {
    coreWeight: 1,
    formulationWeight: 0.5,
    equivalentProblemWeight: 0,
  });
  assert.equal(buildNeedsGateView("confirm-needs", { type: "x" }, {}), undefined);
});
