import assert from "node:assert/strict";
import test from "node:test";

import { taskClassificationSchema } from "@brainstorm-agentic/content";
import type { JsonObject, JsonValue } from "@brainstorm-agentic/core";
import { assertClassifierOutput, classificationArgumentSteps, classifierTaskSchema } from "../src/classifier-contract.js";
import { artifactSchemaToJsonSchema } from "../src/json-schema.js";
import { applyNeedsEdit } from "../src/gates.js";

const embedding: JsonObject = {
  title: "Gaussian message passing on random graphs",
  abstract: "We study message passing for Gaussian graphical models whose structure is a random graph. " +
    "The problem is to infer marginal means and variances exactly or approximately. " +
    "Convergence depends on the spectral properties of the graph and on walk-summability.",
  facets: ["message passing", "Gaussian distributions", "random graph models"].map((name) => ({
    name, statement: `${name} is a self-contained concept whose definition stands without any additional context.`, relevance: 0.8,
    aliases: [`alternative ${name}`],
  })),
  problemFormulation: "Given a random graph whose node states are Gaussian distributions, determine marginal means and variances through local messages while preserving the dependence encoded by the graph structure.",
  equivalentProblems: [{ name: "Gaussian belief propagation", statement: "Estimate marginal Gaussian distributions using messages exchanged between neighboring vertices of a graph." }],
};
const output: JsonObject = {
  primary: { type: "research idea", reason: "The submission proposes a new inference mechanism." },
  alternative: { type: "research question", reason: "The submission asks whether convergence can be obtained." },
  requestedOutputs: [], embeddingInput: embedding,
};
const schema = artifactSchemaToJsonSchema(taskClassificationSchema, "taskClassification");
const idle = { routeKeyTerms: false, equivalentProblemWeight: 0 };
const active = { routeKeyTerms: true, equivalentProblemWeight: 0.5 };
const object = (value: JsonValue | undefined): JsonObject => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
};
const property = (value: JsonObject, key: string): JsonObject => object(object(value.properties)[key]);

test("new classifier schemas omit inactive outputs and retain the actual retrieval descriptions", () => {
  const result = classifierTaskSchema(schema, idle);
  const root = object(result.properties);
  const input = property(result, "embeddingInput");
  const facet = object(property(input, "facets").items);
  const equivalent = object(property(input, "equivalentProblems").items);
  assert.equal(root.cotSteps, undefined);
  assert.equal(object(facet.properties).kind, undefined);
  assert.equal(object(equivalent.properties).field, undefined);
  assert.equal(object(equivalent.properties).confidence, undefined);
  assert.equal(object(input.properties).keyTerms, undefined);
  for (const name of ["name", "statement"]) assert.ok(object(equivalent.properties)[name]);
  assert.ok(object(input.properties).problemFormulation);
  assert.ok(object(facet.properties).aliases);
  for (const objectSchema of [result, input, facet, equivalent]) assert.equal(objectSchema.additionalProperties, false);
  assert.ok(object(schema.properties).cotSteps, "narrowing never mutates the reusable artifact schema");
  assert.ok(taskClassificationSchema.safeParse(output).success);
  assert.doesNotThrow(() => assertClassifierOutput(output, idle));
});

test("enabled retrieval routes require key terms and scoring requires each equivalent's confidence", () => {
  const result = classifierTaskSchema(schema, active);
  const input = property(result, "embeddingInput");
  const equivalent = object(property(input, "equivalentProblems").items);
  assert.ok((input.required as JsonValue[]).includes("keyTerms"));
  assert.ok((equivalent.required as JsonValue[]).includes("confidence"));
  const scored = { ...output, embeddingInput: { ...embedding, keyTerms: [], equivalentProblems: [{ ...object((embedding.equivalentProblems as JsonValue[])[0]), confidence: 0.8 }] } };
  assert.ok(taskClassificationSchema.safeParse(scored).success);
  assert.doesNotThrow(() => assertClassifierOutput(scored, active));
  assert.throws(() => assertClassifierOutput(output, active), /must include keyTerms/);
  assert.throws(() => assertClassifierOutput({ ...output, embeddingInput: { ...embedding, keyTerms: [] } }, active), /must include equivalent confidence/);
  // Each route switches independently; positive weight must not implicitly enable key terms.
  const weighted = classifierTaskSchema(schema, { ...idle, equivalentProblemWeight: 1 });
  assert.equal(object(property(weighted, "embeddingInput").properties).keyTerms, undefined);
  assert.throws(() => assertClassifierOutput({ ...output, embeddingInput: { ...embedding, keyTerms: [] } }, { ...active, equivalentProblemWeight: 0.001 }), /must include equivalent confidence/);
});

test("write-time enforcement rejects inactive fields even if a provider ignores its schema", () => {
  const equivalent = object((embedding.equivalentProblems as JsonValue[])[0]);
  for (const [changed, pattern] of [
    [{ ...output, cotSteps: 4 }, /must not choose cotSteps/],
    [{ ...output, embeddingInput: { ...embedding, keyTerms: [] } }, /must omit keyTerms/],
    [{ ...output, embeddingInput: { ...embedding, facets: (embedding.facets as JsonValue[]).map((facet) => ({ ...object(facet), kind: "method" })) } }, /facet.kind/],
    [{ ...output, embeddingInput: { ...embedding, equivalentProblems: [{ ...equivalent, field: "statistics" }] } }, /equivalent.field/],
    [{ ...output, embeddingInput: { ...embedding, equivalentProblems: [{ ...equivalent, confidence: 0.8 }] } }, /must omit equivalent confidence/],
  ] as const) assert.throws(() => assertClassifierOutput(changed, idle), pattern);
});

test("legacy pinned classifier tasks retain required step count and equivalent metadata", () => {
  const result = classifierTaskSchema(schema, {});
  const equivalent = object(property(property(result, "embeddingInput"), "equivalentProblems").items);
  assert.ok((result.required as JsonValue[]).includes("cotSteps"));
  assert.ok((equivalent.required as JsonValue[]).includes("field"));
  assert.ok((equivalent.required as JsonValue[]).includes("confidence"));
  const legacy: JsonObject = { ...output, cotSteps: 4, embeddingInput: { ...embedding, keyTerms: ["message passing"], equivalentProblems: [
    { ...object((embedding.equivalentProblems as JsonValue[])[0]), field: "statistics", confidence: 0.9 },
  ] } };
  assert.ok(taskClassificationSchema.safeParse(legacy).success);
  assert.doesNotThrow(() => assertClassifierOutput(legacy, {}));
  assert.throws(() => assertClassifierOutput(output, {}), /must include cotSteps/);
  assert.throws(() => assertClassifierOutput({ ...output, cotSteps: 4 }, {}), /must include equivalent field and confidence/);
});

test("partial or invalid classifier routing bindings fail before a model call", () => {
  const invalidBindings: JsonObject[] = [{ routeKeyTerms: false }, { equivalentProblemWeight: 0 },
    { ...idle, routeKeyTerms: "false" }, { ...idle, equivalentProblemWeight: -1 },
    { ...idle, equivalentProblemWeight: Number.NaN }];
  for (const invalid of invalidBindings) {
    assert.throws(() => classifierTaskSchema(schema, invalid), /classifier requires/);
    assert.throws(() => assertClassifierOutput(output, invalid), /classifier requires/);
  }
});

test("argument steps use configured counts and only fall back for a legacy workflow", () => {
  assert.equal(classificationArgumentSteps({ argumentSteps: 7 }, { cotSteps: 3 }), 7);
  assert.equal(classificationArgumentSteps({}, { cotSteps: 4 }), 4);
  assert.throws(() => classificationArgumentSteps({}, {}), /requires argumentSteps/);
  for (const invalid of [0, 2, 10, 3.5, "6", null]) {
    assert.throws(() => classificationArgumentSteps({ argumentSteps: invalid }, { cotSteps: 4 }), /requires argumentSteps/);
  }
});

test("needs editing preserves omitted metadata and cannot introduce an inactive confidence", () => {
  const original = structuredClone(embedding);
  assert.deepEqual(applyNeedsEdit(original, original, "confirm-needs"), original);
  const edited = { ...original, facets: (original.facets as JsonValue[]).map((facet) => ({ ...object(facet), relevance: 0.5 })) };
  assert.deepEqual(applyNeedsEdit(original, edited, "confirm-needs"), edited);
  assert.throws(() => applyNeedsEdit(original, { ...original, equivalentProblems: [{
    ...object((original.equivalentProblems as JsonValue[])[0]), confidence: 0.5,
  }] }, "confirm-needs"), /has no confidence to edit/);
});
