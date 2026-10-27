import assert from "node:assert/strict";
import test from "node:test";
import { factBadgeHash, factReportHash, factReviewVersion, factStandingRevision, factSubmitContextOf, type FactEntry, type AgentTask } from "../src/index.js";

const entry: FactEntry = {
  id: "F:1", kind: "math", status: "justified", claim: "For x>=0, |x|=x.", conditions: "x is real and nonnegative",
  method: "judgement-only", evidence: "Substitute into the definition of absolute value.", createdAt: 1, updatedAt: 1,
  history: [{ at: 1, event: "issued", detail: "The stated sign selects the nonnegative branch." }], requesters: [],
};

test("badge hashes cover immutable verified content and issuance reason, never audit activity", () => {
  const hash = factBadgeHash(entry);
  assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  const relied: FactEntry = { ...entry, updatedAt: 2, badgeHash: hash, requesters: [{ taskId: "t", role: "critic", agent: "a" }], history: [...entry.history, { at: 2, event: "relied" }] };
  assert.equal(factBadgeHash(relied), hash);
  assert.equal(factStandingRevision(relied), factStandingRevision(entry));
  for (const change of [{ claim: "The absolute value equals x when x is nonnegative." }, { conditions: "x is positive" }, { evidence: "A different proof." }, { history: [{ at: 1, event: "issued" as const, detail: "A different issuance rationale." }] }]) {
    assert.notEqual(factBadgeHash({ ...entry, ...change }), hash);
  }
  const disputed: FactEntry = { ...entry, status: "disputed", history: [...entry.history, { at: 3, event: "disputed", detail: "An unresolved counterexample." }] };
  assert.equal(factBadgeHash(disputed), hash);
  assert.notEqual(factStandingRevision(disputed), factStandingRevision(entry));
});

test("Supreme approval context is derived from the actual committee task and exact submitted report", () => {
  const chain = [{ part1: "For x>=0, |x|=x." }];
  const report = { q: 0.1, justification: "The sign condition selects the stated branch [F:1]." };
  const task: AgentTask = { taskId: "run:seat/round/chair-execute", kind: "brainstorm.committee-chair", outputSchema: { name: "gameCommitteeDecision", schema: {} },
    input: { bindings: { chain, currentStep: 1, comments: { critic: report }, review: { chairTaskId: "forged" } } } };
  assert.deepEqual(factSubmitContextOf(task).review, { chairTaskId: task.taskId, reviewVersion: factReviewVersion(chain, 1), reports: { critic: { reportHash: factReportHash(report), justification: report.justification } } });
  assert.notEqual(factReportHash({ ...report, q: 0.2 }), factReportHash(report));
  assert.equal(factSubmitContextOf({ ...task, outputSchema: { name: "gameCritique", schema: {} } }).review, undefined);
  assert.equal(factSubmitContextOf({ ...task, input: { bindings: { chain, currentStep: 2, comments: { critic: report } } } }).review, undefined);
});
