import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_FACETS,
  needRows,
  needsGateAnswer,
  removeAlias,
  removeEquivalent,
  removeFacet,
  setConfidence,
  setRelevance,
  totalWeight,
  type NeedsInput,
} from "../src/components/panels/needs-model.js";

const input: NeedsInput = {
  title: "Message passing over Gaussian node distributions",
  abstract: "An abstract.",
  facets: [
    { name: "message passing", statement: "S", relevance: 0.95, aliases: ["belief propagation", "sum-product"] },
    { name: "graph generation", statement: "G", relevance: 0.9 },
    { name: "random graph models", statement: "R", relevance: 0.7 },
    { name: "variational inference", statement: "V", relevance: 0.6 },
  ],
  problemFormulation: "Given a graph whose node states are Gaussian ...",
  equivalentProblems: [
    { field: "signal processing", name: "Gaussian belief propagation", statement: "E", confidence: 0.8 },
  ],
};

const weights = { coreWeight: 1, formulationWeight: 0.5, equivalentProblemWeight: 0.5 };

test("needs follow spec v2 Section 2: core, facets, formulation, equivalents x factor", () => {
  const rows = needRows(input, weights);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.weight, row.retrievalOnly]),
    [
      ["core", 1, false],
      ["facet", 0.95, false],
      ["facet", 0.9, false],
      ["facet", 0.7, false],
      ["facet", 0.6, false],
      ["formulation", 0.5, false],
      ["equivalent", 0.4, false],
    ],
  );
  assert.equal(Number(totalWeight(rows).toFixed(6)), 5.05);
  const retrievalOnly = needRows(input, { ...weights, equivalentProblemWeight: 0, formulationWeight: 0 });
  assert.deepEqual(retrievalOnly.filter((row) => row.retrievalOnly).map((row) => row.kind), ["formulation", "equivalent"]);
});

test("the edits stay within editRule needs: removals, re-weighting within [0,1], >= 3 facets", () => {
  let edited = removeFacet(input, 1);
  assert.deepEqual(edited.facets.map((facet) => facet.name), ["message passing", "random graph models", "variational inference"]);
  assert.equal(edited.facets.length, MIN_FACETS);
  assert.equal(removeFacet(edited, 0), edited, "a fourth removal below 3 facets is refused");
  edited = removeAlias(edited, 0, "belief propagation");
  assert.deepEqual(edited.facets[0]!.aliases, ["sum-product"]);
  edited = setRelevance(edited, 1, 1.4);
  assert.equal(edited.facets[1]!.relevance, 1);
  edited = setRelevance(edited, 1, -2);
  assert.equal(edited.facets[1]!.relevance, 0);
  edited = setConfidence(edited, 0, 0.25);
  assert.equal(edited.equivalentProblems![0]!.confidence, 0.25);
  edited = removeEquivalent(edited, 0);
  assert.deepEqual(edited.equivalentProblems, []);
  assert.equal(edited.title, input.title);
  assert.equal(input.facets.length, 4, "the original is never mutated");
});

test("an unchanged reading approves; any edit sends the full edited input", () => {
  assert.deepEqual(needsGateAnswer("confirm-needs", input, input), { gateKey: "confirm-needs", action: "approve" });
  const edited = setRelevance(input, 0, 0.5);
  assert.deepEqual(needsGateAnswer("confirm-needs", input, edited), {
    gateKey: "confirm-needs",
    action: "edit",
    embeddingInput: edited,
  });
});
