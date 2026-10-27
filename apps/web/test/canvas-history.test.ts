import assert from "node:assert/strict";
import test from "node:test";
import type { JobSummary } from "@brainstorm-agentic/protocol";
import { historyMatches, historyPage, sameJobSummary } from "../src/features/composer/history.js";

const job = (id: string, topic: string): JobSummary => ({ jobId: id, topic, status: "completed", runner: "local", createdAt: 1, updatedAt: 1 });

test("a large history renders at most fifty records and can reach its last result", () => {
  const items = Array.from({ length: 100_003 }, (_, index) => index);
  assert.equal(historyPage(items, 0).items.length, 50);
  const last = historyPage(items, 99_999);
  assert.deepEqual(last.items, [100_000, 100_001, 100_002]);
  assert.equal(last.end, 100_003);
  assert.equal(last.start, 100_001);
  assert.equal(historyPage(items, -4).page, 0);
});

test("removing the last page clamps the selection without losing earlier records", () => {
  const first = historyPage(Array.from({ length: 51 }, (_, index) => index), 1);
  assert.deepEqual(first.items, [50]);
  const removed = historyPage(Array.from({ length: 50 }, (_, index) => index), first.page);
  assert.equal(removed.page, 0);
  assert.equal(removed.items.length, 50);
  assert.deepEqual(historyPage([], 5), { items: [], page: 0, pages: 0, start: 0, end: 0 });
});

test("search finds original prompts, generated titles and ids with all query terms", () => {
  const first = { ...job("run-123", "Review molecular evidence"), title: "A reliability study" };
  const second = job("run-456", "Plan a benchmark");
  assert.deepEqual(historyMatches([first, second], "RELIABILITY molecular"), [first]);
  assert.deepEqual(historyMatches([first, second], "456"), [second]);
  assert.deepEqual(historyMatches([first, second], "benchmark evidence"), []);
});

test("memoization preserves changes to progress and redo attachments", () => {
  const first = job("run-1", "A question");
  assert.equal(sameJobSummary(first, { ...first }), true);
  assert.equal(sameJobSummary(first, { ...first, attachments: ["/new/file.pdf"] }), false);
  assert.equal(sameJobSummary(first, { ...first, progress: { completedStages: 1, totalStages: 9 } }), false);
});
