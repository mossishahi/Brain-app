import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LiteratureReviewView } from "@brainstorm-agentic/protocol";
import { literatureForResult, submittedLiteratureReviews } from "../src/literature-review-view.js";
import { buildRunTrace } from "../src/trace-export.js";

function review(id: string, taskId: string): LiteratureReviewView {
  return { reviewId: id, revision: 1, state: "submitted", owner: { runId: "run", taskId, nodePath: `brainstorm-root/first-pass/${taskId}`, role: taskId },
    inputRevision: "input-v1", inputRequirements: [{ id: "R1", text: "Review previous methods" }], createdAt: 1, updatedAt: 1,
    review: { schemaVersion: "literature-review/v1", scope: { question: "What methods address the request?", inputRequirements: [{ id: "R1", text: "Review previous methods" }], vantage: "Method assessment" },
      search: { queries: [], coverage: "No source could be accessed", limitations: ["Network unavailable"] }, works: [],
      synthesis: { closestWorkIds: [], assessment: "undetermined", findings: "Cannot conclude without access", gaps: [], comparisons: [] },
      status: "incomplete", statusReason: "Network unavailable" } };
}

test("latest submitted review wins without promoting a later unfinished draft", () => {
  const first = review("r1", "thinker");
  const second = { ...first, revision: 2, updatedAt: 2 };
  const values = [first, second, { ...second, revision: 3, state: "draft", review: { scope: {} } }];
  const mapped = submittedLiteratureReviews(values.map((value) => ({ ref: { metadata: { kind: "literature-review" } }, value })));
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]?.revision, 2);
  assert.equal(mapped[0]?.review.status, "incomplete");
});

test("a result cannot borrow another agent's review by listing its ID", () => {
  const thinker = review("thinker-review", "thinker");
  const critic = review("critic-review", "critic");
  assert.deepEqual(literatureForResult([thinker, critic], { taskId: "thinker", metadata: { literatureReviewIds: ["thinker-review", "critic-review"] } }), [thinker]);
  assert.deepEqual(literatureForResult([thinker, critic], { taskId: "critic" }), [critic]);
  assert.deepEqual(literatureForResult([thinker, critic], {}), []);
  assert.deepEqual(submittedLiteratureReviews([]), []);
});

test("trace export preserves agent attribution, incomplete results and unfinished drafts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "literature-trace-"));
  try {
    const sessionDir = join(dir, "session"); const jobDir = join(dir, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true }); mkdirSync(jobDir);
    writeFileSync(join(sessionDir, "checkpoint.json"), JSON.stringify({ journal: [], status: "running" }));
    const records = [review("same-source-thinker", "thinker"), review("same-source-critic", "critic"), { ...review("draft", "critic"), state: "draft", review: {} }];
    writeFileSync(join(sessionDir, "artifacts", "index.json"), JSON.stringify({ refs: records.map((_, index) => ({ id: `a${index}`, metadata: { kind: "literature-review" } })) }));
    records.forEach((value, index) => writeFileSync(join(sessionDir, "artifacts", `a${index}`), JSON.stringify(value)));
    const files = (await buildRunTrace({ runId: "run", sessionDir, jobDir }))!;
    const literature = files.filter((file) => file.path.startsWith("literature/"));
    assert.equal(literature.length, 3);
    assert.equal(new Set(literature.map((file) => file.path)).size, 3);
    assert.deepEqual(literature.map((file) => JSON.parse(file.data.toString()).owner.taskId).sort(), ["critic", "critic", "thinker"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
