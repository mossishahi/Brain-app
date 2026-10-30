/**
 * Schemas of the paper-based panel composition: the classifier v2 fields of
 * the embedding input (aliases, kind, problem formulation, equivalent
 * problems, key terms), the literature / literatureScreen / panelEvidence
 * records (checked against the Python prototype's records when present), and
 * the optional catalog/taxonomy-texts.json of a bundle.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  ContentValidationError,
  artifactSchemas,
  embeddingFacetSchema,
  embeddingInputSchema,
  literatureScreenSchema,
  literatureSchema,
  panelEvidenceSchema,
  readContentBundle,
  taskClassificationSchema,
} from "../src/index.js";
import { registryContentDir } from "./helpers.js";

const statement = (concept: string) =>
  `${concept} is a self-contained concept whose definition stands without any context at all.`;

const facets = [
  { name: "message passing", statement: statement("Message passing"), relevance: 1 },
  { name: "Gaussian distributions", statement: statement("A Gaussian distribution"), relevance: 0.8 },
  { name: "random graph models", statement: statement("A random graph model"), relevance: 0.5 },
];

const base = {
  title: "Gaussian message passing on random graphs",
  abstract:
    "We study message passing for Gaussian graphical models whose structure is a random graph. " +
    "The problem is to infer marginal means and variances exactly or approximately. " +
    "Convergence depends on the spectral properties of the graph and on walk-summability.",
  facets,
};

test("classifier JSON schema delivers the existing embedding length ceilings to providers", () => {
  type NativeSchema = { properties?: Record<string, NativeSchema>; items?: NativeSchema; maxLength?: number };
  // Use the runtime converter's settings: arbitrary refinements are omitted,
  // so a validation-only length check would silently disappear on this path.
  const schema = z.toJSONSchema(taskClassificationSchema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
  }) as NativeSchema;
  const embedding = schema.properties!.embeddingInput.properties!;
  const facet = embedding.facets.items!.properties!;
  assert.equal(embedding.title.maxLength, 200);
  assert.equal(embedding.abstract.maxLength, 2500);
  assert.equal(embedding.problemFormulation.maxLength, 1500);
  assert.equal(facet.name.maxLength, 80);
  assert.equal(facet.statement.maxLength, 600);
});

test("embedding length ceilings keep their boundaries, messages, and semantic refinements", () => {
  assert.ok(taskClassificationSchema.safeParse({
    primary: { type: "research idea", reason: "The submission proposes a new inference method." },
    alternative: { type: "research question", reason: "The submission also asks whether convergence holds." },
    cotSteps: 4,
    requestedOutputs: [],
    embeddingInput: base,
  }).success);

  const cases = [
    { field: "title", max: 200,
      message: "embedding title must stay title-length (at most 200 characters)",
      replace: (value: string) => ({ ...base, title: value }) },
    { field: "abstract", max: 2500,
      message: "embedding abstract is runaway output; keep it to 3-6 sentences",
      replace: (value: string) => ({ ...base, abstract: value }) },
    { field: "problemFormulation", max: 1500,
      message: "problem formulation is runaway output; keep it to at most 1,500 characters",
      replace: (value: string) => ({ ...base, problemFormulation: value }) },
    { field: "facet name", max: 80,
      message: "facet name must stay a short term of art (at most 80 characters)",
      replace: (value: string) => ({ ...base, facets: [{ ...facets[0], name: value }, ...facets.slice(1)] }) },
    { field: "facet statement", max: 600,
      message: "facet statement is runaway output; keep it to 1-2 sentences",
      replace: (value: string) => ({ ...base, facets: [{ ...facets[0], statement: value }, ...facets.slice(1)] }) },
  ];
  for (const { field, max, message, replace } of cases) {
    const text = "A meaningful concept ".repeat(Math.ceil((max + 1) / 21));
    assert.ok(embeddingInputSchema.safeParse(replace(text.slice(0, max))).success, `${field} accepts its ceiling`);
    const over = embeddingInputSchema.safeParse(replace(text.slice(0, max + 1)));
    assert.equal(over.success, false, `${field} rejects one character beyond its ceiling`);
    if (!over.success) assert.ok(over.error.issues.some((issue) => issue.message === message), field);
  }
  assert.equal(embeddingInputSchema.safeParse({ ...base, title: "placeholder" }).success, false);
  assert.equal(embeddingInputSchema.safeParse({ ...base, title: "A title\non two lines" }).success, false);
  assert.equal(embeddingInputSchema.safeParse({ ...base, abstract: `${base.abstract}\n\n${base.abstract}` }).success, false);
  assert.equal(embeddingFacetSchema.safeParse({ ...facets[0], name: "two\nlines" }).success, false);
  assert.equal(embeddingFacetSchema.safeParse({ ...facets[0], statement: `${facets[0].statement}\n\n${facets[0].statement}` }).success, false);
});

test("embedding facets accept the optional classifier v2 aliases and kind; v1 facets stay valid", () => {
  assert.ok(embeddingFacetSchema.safeParse(facets[0]).success, "a v1 facet");
  const v2 = { ...facets[0], aliases: ["belief propagation", "sum-product algorithm"], kind: "method" };
  assert.ok(embeddingFacetSchema.safeParse(v2).success);
  const messages = (value: unknown) => {
    const result = embeddingFacetSchema.safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };
  assert.match(messages({ ...facets[0], aliases: ["Message Passing"] }).join("\n"), /repeats the facet name/);
  assert.match(messages({ ...facets[0], aliases: ["belief propagation", "Belief Propagation "] }).join("\n"), /duplicate alias/);
  assert.ok(messages({ ...facets[0], aliases: ["a1x", "a2x", "a3x", "a4x", "a5x", "a6x"] }).length > 0, "at most five aliases");
  assert.ok(messages({ ...facets[0], aliases: ["ab"] }).length > 0, "an alias has at least 3 characters");
  assert.ok(messages({ ...facets[0], aliases: ["two\nlines"] }).length > 0, "an alias is one line");
  assert.ok(messages({ ...facets[0], kind: "technique" }).length > 0, "kind is one of the five");
});

test("the embedding input accepts the optional formulation, equivalent problems and key terms", () => {
  assert.ok(embeddingInputSchema.safeParse(base).success, "a v1 embedding input");
  const formulation =
    "Given a sparse symmetric positive definite precision matrix whose sparsity pattern is a random graph, " +
    "compute the diagonal of its inverse and the solution of one linear system by local iterative updates.";
  const v2 = {
    ...base,
    problemFormulation: formulation,
    equivalentProblems: [
      {
        field: "Numerical linear algebra",
        name: "Gaussian belief propagation",
        statement: "Solving sparse linear systems by distributed iterations equivalent to Gaussian belief propagation.",
        confidence: 0.8,
      },
    ],
    keyTerms: ["walk-summability", "GaBP"],
  };
  assert.ok(embeddingInputSchema.safeParse(v2).success, JSON.stringify(embeddingInputSchema.safeParse(v2).error?.issues));
  const fails = (value: unknown) => !embeddingInputSchema.safeParse(value).success;
  assert.ok(fails({ ...v2, problemFormulation: "Too short." }), "formulation of 150+ characters");
  assert.ok(fails({ ...v2, problemFormulation: `${formulation}\n\n${formulation}` }), "formulation is one paragraph");
  assert.ok(fails({ ...v2, problemFormulation: formulation.repeat(10) }), "formulation of at most 1,500 characters");
  assert.ok(fails({ ...v2, equivalentProblems: [{ ...v2.equivalentProblems[0], confidence: 1.2 }] }), "confidence within [0, 1]");
  assert.ok(fails({ ...v2, equivalentProblems: [{ ...v2.equivalentProblems[0], extra: true }] }), "equivalent problems are strict");
  assert.ok(fails({ ...v2, equivalentProblems: Array(6).fill(v2.equivalentProblems[0]) }), "at most five equivalent problems");
  assert.ok(fails({ ...v2, keyTerms: Array(13).fill("term") }), "at most twelve key terms");
  assert.ok(fails({ ...v2, keyTerms: ["x"] }), "a key term has at least 2 characters");
});

test("the three new records are registered artifact schemas", () => {
  assert.equal(artifactSchemas.literature, literatureSchema);
  assert.equal(artifactSchemas.literatureScreen, literatureScreenSchema);
  assert.equal(artifactSchemas.panelEvidence, panelEvidenceSchema);
  assert.ok(literatureScreenSchema.safeParse({ decisions: [], skipped: "relevance screen off" }).success);
  assert.ok(!literatureScreenSchema.safeParse({ decisions: [{ pid: "P0001", onTopic: true, reason: "x".repeat(201) }] }).success);
});

const fixtureRoot = fileURLToPath(new URL("../../../brainstorm-runtime/test/fixtures/panel-parity/", import.meta.url));
const fixtureRuns = existsSync(fixtureRoot)
  ? readdirSync(fixtureRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  : [];

test(
  "the Python prototype's literature, screen and panelEvidence records parse against the schemas",
  { skip: fixtureRuns.length === 0 ? "pending: no prototype records in the runtime's fixtures" : false },
  () => {
    for (const run of fixtureRuns) {
      const dir = join(fixtureRoot, run);
      const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
      const check = (schema: typeof literatureSchema | typeof panelEvidenceSchema | typeof literatureScreenSchema, name: string) => {
        const result = schema.safeParse(read(name));
        assert.ok(result.success, `${run}/${name}: ${JSON.stringify(result.error?.issues.slice(0, 5))}`);
      };
      if (existsSync(join(dir, "literature.json"))) check(literatureSchema, "literature.json");
      if (existsSync(join(dir, "literatureScreen.json"))) check(literatureScreenSchema, "literatureScreen.json");
      check(panelEvidenceSchema, "panelEvidence.json");
    }
  },
);

const sourceContentDir = fileURLToPath(new URL("../../../../../brain/content-src/brainstorm/", import.meta.url));
const TEXTS = join("catalog", "taxonomy-texts.json");

test("catalog/taxonomy-texts.json is optional: loaded when the bundle carries it, absent otherwise", () => {
  const dir = registryContentDir();
  const bundle = readContentBundle(dir);
  if (existsSync(join(dir, TEXTS))) {
    assert.ok(bundle.taxonomyTexts);
    assert.ok(bundle.taxonomyTexts.entries.length > 0);
    assert.match(bundle.taxonomyTexts.sha256, /^[0-9a-f]{64}$/);
  } else {
    assert.equal(bundle.taxonomyTexts, undefined);
    assert.ok(!("taxonomyTexts" in bundle));
  }
});

test(
  "a malformed catalog/taxonomy-texts.json is a structural issue",
  { skip: existsSync(join(sourceContentDir, "workflows")) ? false : "the brain source tree is not next to this checkout" },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "taxonomy-texts-"));
    try {
      cpSync(sourceContentDir, scratch, { recursive: true });
      writeFileSync(join(scratch, TEXTS), JSON.stringify({ version: 1, entries: [{ id: "T1" }] }));
      assert.throws(
        () => readContentBundle(scratch),
        (error: unknown) =>
          error instanceof ContentValidationError &&
          error.issues.some((issue) => issue.path.includes("taxonomy-texts.json")),
      );
      writeFileSync(join(scratch, TEXTS), "{not json");
      assert.throws(() => readContentBundle(scratch), /not valid JSON/);
      rmSync(join(scratch, TEXTS));
      assert.equal(readContentBundle(scratch).taxonomyTexts, undefined);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
