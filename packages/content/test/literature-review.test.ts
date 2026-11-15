import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  artifactSchemas,
  literatureReviewV1Schema,
  readContentBundle,
  skillMetaSchema,
  validateBundle,
  validateResolvedRole,
  type LiteratureReviewV1,
} from "../src/index.js";
import { freshBundle } from "./helpers.js";

function review(): LiteratureReviewV1 {
  return {
    schemaVersion: "literature-review/v1",
    scope: {
      question: "Which inspected methods address the original dimensionality requirement?",
      inputRequirements: [{ id: "input/requested/1", text: "Preserve thin geometric directions." }],
      vantage: "Spectral geometry; original input and explicit requested outputs.",
    },
    search: {
      queries: [{ query: "repeated eigendirections manifold learning", source: "scholarly index", evidenceRefIds: [] }],
      coverage: "A targeted comparison with the closest identified method.",
      limitations: [],
    },
    works: [{
      id: "closest-method",
      source: {
        title: "A retrieved method", authors: ["A. Researcher"], year: 2024,
        venue: "Research journal", url: "https://example.org/paper", doi: null, version: "sha256-source-version",
      },
      inspected: {
        level: "sections",
        evidence: [{ documentId: "doc-source", receiptId: "receipt-task", segmentId: "section-3-paragraph-2", locator: "Section 3, paragraph 2" }],
        accessLimitations: [],
      },
      method: "The inspected section tests whether a new coordinate repeats previous directions.",
      results: "The source demonstrates the test on an elongated rectangular example.",
      conditions: ["The inspected experiment uses a rectangular domain."],
      limitations: ["The section does not establish performance for every curved manifold."],
      relevance: [{ requirementId: "input/requested/1", relationship: "partially-addresses", justification: "Rejecting repeated directions targets the requested thin-direction loss, but does not itself certify general geometry preservation." }],
      intendedUse: ["Baseline under matched graph construction and sampling."],
      uncertainties: [],
    }],
    synthesis: { closestWorkIds: ["closest-method"], assessment: "partially-solved", findings: "A direct baseline exists within the inspected conditions.", gaps: ["Generalization beyond the inspected setting remains unestablished."], comparisons: ["Compare at matched sample size and coordinate count."] },
    status: "complete",
    statusReason: "The targeted source assessment is recorded with its limitations.",
  };
}

test("versioned literature review requires per-work original-input relevance and exact evidence identifiers", () => {
  assert.ok(literatureReviewV1Schema.safeParse(review()).success);
  for (const field of ["documentId", "receiptId", "segmentId", "locator"] as const) {
    const bad = review(); bad.works[0]!.inspected.evidence[0]![field] = "";
    assert.equal(literatureReviewV1Schema.safeParse(bad).success, false, field);
  }
  const missing = review(); missing.works[0]!.relevance = [];
  assert.equal(literatureReviewV1Schema.safeParse(missing).success, false);
  const invented = review(); invented.works[0]!.relevance[0]!.requirementId = "invented-requirement";
  assert.equal(literatureReviewV1Schema.safeParse(invented).success, false);
  const empty = review(); empty.works[0]!.relevance[0]!.justification = "";
  assert.equal(literatureReviewV1Schema.safeParse(empty).success, false);
});

test("review distinguishes inspected passages from metadata and declares missing access honestly", () => {
  const noEvidence = review(); noEvidence.works[0]!.inspected.evidence = [];
  assert.equal(literatureReviewV1Schema.safeParse(noEvidence).success, false);
  const noVersion = review(); noVersion.works[0]!.source.version = null;
  assert.equal(literatureReviewV1Schema.safeParse(noVersion).success, false);
  const abstract = review();
  abstract.works[0]!.inspected = { level: "abstract", evidence: [], accessLimitations: ["Only the abstract was accessible; method assumptions remain unknown."] };
  abstract.works[0]!.source.version = null;
  abstract.works[0]!.method = "The abstract names the approach but does not establish its construction.";
  abstract.works[0]!.uncertainties = ["Method details and proof conditions were not accessible."];
  abstract.status = "incomplete";
  assert.ok(literatureReviewV1Schema.safeParse(abstract).success);
  abstract.works[0]!.inspected.accessLimitations = [];
  assert.equal(literatureReviewV1Schema.safeParse(abstract).success, false);
});

test("empty and limited reviews cannot claim that missing evidence establishes an open problem", () => {
  const empty = review(); empty.works = []; empty.synthesis.closestWorkIds = [];
  empty.synthesis.assessment = "undetermined"; empty.status = "incomplete";
  empty.statusReason = "No accessible source could be inspected.";
  assert.ok(literatureReviewV1Schema.safeParse(empty).success);
  empty.status = "no-relevant-works";
  assert.ok(literatureReviewV1Schema.safeParse(empty).success);
  empty.synthesis.assessment = "open";
  assert.equal(literatureReviewV1Schema.safeParse(empty).success, false);
  const falseEmpty = review(); falseEmpty.status = "no-relevant-works";
  assert.equal(literatureReviewV1Schema.safeParse(falseEmpty).success, false);
});

test("reviews reject duplicate identities, dangling closest-work references and host ownership impersonation", () => {
  const duplicate = review(); duplicate.works.push(structuredClone(duplicate.works[0]!));
  assert.equal(literatureReviewV1Schema.safeParse(duplicate).success, false);
  const dangling = review(); dangling.synthesis.closestWorkIds = ["not-collected"];
  assert.equal(literatureReviewV1Schema.safeParse(dangling).success, false);
  assert.equal(literatureReviewV1Schema.safeParse({ ...review(), owner: { agentId: "other-seat" } }).success, false);
  const schema = z.toJSONSchema(artifactSchemas.literatureReviewV1, { target: "draft-2020-12", io: "output", unrepresentable: "any" });
  assert.equal(schema.type, "object");
});

test("technique deliverables are opt-in and do not mutate pinned role result contracts", () => {
  const old = freshBundle();
  assert.deepEqual(validateBundle(old), []);
  const role = old.skills.brain!;
  const technique = old.skills["literature-review"]!;
  const output = role.meta.output;
  technique.meta.deliverables = ["literatureReviewV1"];
  role.meta.requiredDeliverables = ["literatureReviewV1"];
  assert.deepEqual(validateBundle(old), []);
  assert.equal(role.meta.output, output);
  assert.equal(literatureReviewV1Schema.safeParse({ literature: [] }).success, false);
  technique.meta.deliverables = ["unknownReview"];
  assert.ok(validateBundle(old).some((issue) => issue.code === "MISSING_SCHEMA"));
  assert.ok(validateBundle(old).some((issue) => issue.code === "MISSING_DELIVERABLE"));
  const resolved = role.meta.techniques.map((name) => old.skills[name]!);
  assert.ok(validateResolvedRole(role, resolved, old.capabilities).some((issue) => issue.code === "MISSING_DELIVERABLE"));
  assert.equal(skillMetaSchema.safeParse({ name: "review", kind: "technique", description: "review", requiredDeliverables: ["literatureReviewV1"] }).success, false);
});

test("editable bundle requires first-pass reviews and exposes the same scoped contract to later source readers", () => {
  const source = fileURLToPath(new URL("../../../../../Brain/content-src/brainstorm/", import.meta.url));
  const bundle = readContentBundle(source);
  assert.deepEqual(validateBundle(bundle), []);
  assert.deepEqual(bundle.skills["literature-review"]!.meta.deliverables, ["literatureReviewV1"]);
  assert.deepEqual(bundle.skills["literature-review"]!.meta.vars, []);
  assert.deepEqual(bundle.skills.brain!.meta.requiredDeliverables, ["literatureReviewV1"]);
  for (const name of ["commentor", "interdisciplinary-commentor", "game-commentor", "game-interdisciplinary-commentor", "reconsider-comment", "reconsider-game-report", "redeveloper", "game-redeveloper", "reconsider-chain", "integrator", "supreme_judge", "judge", "committee-chair"]) {
    assert.ok(bundle.skills[name]!.meta.techniques.includes("literature-review"), name);
    assert.equal(bundle.skills[name]!.meta.requiredDeliverables, undefined, `${name} uses the contract conditionally`);
  }
  assert.ok(bundle.capabilities.capabilities["web-search"]!.operations.includes("web.paper.read"));
});
