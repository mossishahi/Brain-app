import assert from "node:assert/strict";
import test from "node:test";

import { placeholderContentIssues } from "../src/agent-adapter.js";

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
