import assert from "node:assert/strict";
import test from "node:test";

import { artifactSchemas } from "@brainstorm-agentic/content";

import {
  ContentArtifactOutputValidator,
  enumPathTemplates,
  placeholderContentIssues,
} from "../src/agent-adapter.js";
import { artifactSchemaToJsonSchema } from "../src/json-schema.js";

test("the probe payloads seen in the field are rejected, field by field", () => {
  // Verbatim from a real run: a commentor fighting the schema submitted
  // filler that passed shape validation and was recorded as a verdict.
  const issues = placeholderContentIssues({
    verdict: "Interrupt",
    reason:
      "Test minimal reason string for schema debug purpose only length check now.",
    suggestion: "Test minimal suggestion string length twenty.",
    reference: { file: "abc", quote: "abc", shows: "abc" },
  });
  assert.ok(issues.length >= 4, "every filler field is named");
  assert.ok(issues.some((issue) => issue.includes("artifact.reason")));
  assert.ok(issues.some((issue) => issue.includes("artifact.reference.file")));
  assert.ok(issues.some((issue) => issue.includes("recorded verbatim")));
});

test("throwaway exact values are rejected wherever they appear", () => {
  for (const value of ["abc", "TODO", "n/a", "xxx", "placeholder", "..."]) {
    assert.equal(
      placeholderContentIssues({ text: value }).length,
      1,
      `"${value}" must be rejected`,
    );
  }
  assert.ok(
    placeholderContentIssues({ list: ["fine content", "tbd"] })[0]!.includes(
      "artifact.list[1]",
    ),
  );
});

// Verbatim from a real run (bsa_20260810-134241_5ddb72): the pool-builder's
// scholars carried profile: "ok" — the CORRECT member of the schema's own
// enum (ok | ambiguous | no_profile) — and the guard rejected every one as
// placeholder text, so a correct artifact could never pass validation and
// the run died mid-decompose after all retries.
test("enum members like a resolved profile's \"ok\" pass the guard (field-observed crash)", () => {
  const jsonSchema = artifactSchemaToJsonSchema(artifactSchemas.pool, "pool");
  const templates = enumPathTemplates(jsonSchema);
  assert.ok(
    templates.has("artifact.grounding.scholars[*].profile"),
    "the delivered schema names the profile enum path",
  );

  const pool = {
    members: [
      {
        term: "graph representation learning",
        count: 3,
        relevance: 0.8,
        variants: ["graph representation learning"],
        origins: [
          {
            name: "Jane Studer",
            paper: "Structure-preserving graph embeddings",
            stated: "graph representation learning",
          },
        ],
      },
    ],
    grounding: {
      papers: [{ title: "Structure-preserving graph embeddings" }],
      scholars: [
        {
          name: "Jane Studer",
          affiliation: "ETH Zurich",
          url: "https://example.org/jane-studer",
          profile: "ok",
          interests: ["graph representation learning"],
        },
        { name: "Ken Adams", affiliation: "", url: "", profile: "no_profile", interests: [] },
      ],
    },
  };
  const result = new ContentArtifactOutputValidator().validate(pool, jsonSchema);
  assert.equal(
    result.success,
    true,
    `a correct pool must validate: ${JSON.stringify("issues" in result ? result.issues : [])}`,
  );
});

test("the enum exemption is path-precise: \"ok\" outside an enum field still fails", () => {
  const jsonSchema = artifactSchemaToJsonSchema(artifactSchemas.pool, "pool");
  const pool = {
    members: [
      {
        term: "graph representation learning",
        count: 1,
        relevance: 0.5,
        variants: ["graph representation learning"],
        origins: [{ name: "ok", paper: "Some real paper title", stated: "graph learning" }],
      },
    ],
  };
  const result = new ContentArtifactOutputValidator().validate(pool, jsonSchema);
  assert.equal(result.success, false);
  assert.ok(
    !result.success &&
      result.issues.some((issue) => issue.includes("artifact.members[0].origins[0].name")),
    "the non-enum field is still rejected by exact path",
  );
});

test("the NA file label is schema vocabulary, not a placeholder", () => {
  const jsonSchema = artifactSchemaToJsonSchema(
    artifactSchemas.processorOutput,
    "processorOutput",
  );
  const templates = enumPathTemplates(jsonSchema);
  assert.ok(templates.has("artifact.files[*].label"));
  assert.deepEqual(
    placeholderContentIssues(
      { files: [{ path: "package-lock.json", label: "NA", note: "" }] },
      "artifact",
      templates,
    ),
    [],
  );
  // The exemption never leaks to neighboring free-text fields.
  assert.ok(
    placeholderContentIssues(
      { files: [{ path: "model.py", label: "code", note: "na" }] },
      "artifact",
      templates,
    )[0]!.includes("artifact.files[0].note"),
  );
});

test("real scientific prose never trips the guard", () => {
  const artifact = {
    verdict: "Interrupt",
    reason:
      "The claimed invariance does not hold: a two-sided statistical test on the " +
      "reported residuals (Welch's t, n=48) rejects equality at p<0.01, and the " +
      "manuscript's own ablation table contradicts the isotropy assumption.",
    suggestion:
      "Re-derive the bound with the anisotropic covariance and test the corrected " +
      "estimator on the held-out split before asserting invariance in step 2.",
    reference: {
      file: "training/iso.py",
      quote: "loss = self.lambda_iso * torch.var(z, dim=0).mean()",
      shows: "the isotropy penalty averages variance across dimensions, not pairs",
    },
    keywords: ["isotropy", "ablation", "hypothesis testing"],
    confidence: 4,
    ok: true,
  };
  assert.deepEqual(placeholderContentIssues(artifact), []);
});
