import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FactEntryView, JobDetail } from "@brainstorm-agentic/protocol";
import { factCallUsage, readFactTableView } from "../src/fact-table-view.js";
import { JobManager } from "../src/job-manager.js";

const fact = (id = "F:1", status: FactEntryView["status"] = "justified") => ({
  id, status, badgeHash: `sha256:${"a".repeat(64)}`, kind: "math", claim: "For x>=0, |x|=x.", conditions: "x is a nonnegative real number",
  method: "judgement-only", evidence: "Substituting into the nonnegative branch gives the identity.", createdAt: 1, updatedAt: 2,
  history: [{ at: 1, event: "issued", detail: "The sign condition selects the stated branch." }, { at: 2, event: "upheld", by: "S:2", detail: "The original conditions still hold." }],
  requesters: [{ taskId: "private-task", role: "critic", agent: "private-member" }],
});
const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

test("the human fact table projects latest committed shared entries, excluding private snapshots and audit records", () => {
  const session = mkdtempSync(join(tmpdir(), "fact-view-"));
  try {
    writeFileSync(join(session, "facts.jsonl"), [
      line({ type: "entry", entry: fact("F:10") }),
      line({ type: "entry", entry: fact("F:2") }),
      line({ type: "transaction", records: [{ type: "entry", entry: { ...fact("F:2", "revoked"), supersededBy: "F:10" } }, { type: "submission", id: "S:3" }] }),
      line({ type: "view-commit", entries: [fact("F:10", "disputed")], view: { key: "private", entries: [fact("F:10"), fact("F:99")] } }),
      line({ type: "badge-revision", entry: fact("F:10") }),
      line({ type: "approval", approval: { approved: true, targetBadgeId: "F:10" } }),
      line({ type: "transaction", records: [{ type: "entry", entry: fact("F:2") }, null] }),
      line({ type: "view-commit", entries: [fact("F:10"), { id: "invalid" }] }),
      line({ type: "entry", entry: { ...fact("F:2"), status: "broken" } }),
      "not valid json\n",
    ].join(""));
    const view = readFactTableView(session)!;
    assert.deepEqual(view.entries.map((entry) => [entry.id, entry.status]), [["F:2", "revoked"], ["F:10", "disputed"]]);
    assert.equal(view.entries[0]!.supersededBy, "F:10");
    assert.equal(view.entries[0]!.reason, "The sign condition selects the stated branch.");
    assert.equal(view.entries[0]!.badgeHash, `sha256:${"a".repeat(64)}`);
    assert.equal(view.entries[0]!.history[1]!.detail, "The original conditions still hold.");
    assert.equal(view.entries[0]!.evidence, fact().evidence);
    assert.doesNotMatch(JSON.stringify(view), /requesters|F:99/);
    assert.equal(view.entries[0]!.uses![0]!.agentId, "private-member", "the shared requester audit can now identify its human-facing interaction");
    assert.equal(view.entries[0]!.uses![0]!.kind, "recorded");
    assert.equal(view.entries[0]!.uses![0]!.purpose, undefined, "a published private view does not invent its missing purpose");
  } finally { rmSync(session, { recursive: true, force: true }); }
});

test("an incomplete transaction stays invisible until its newline commits all shared changes", () => {
  const session = mkdtempSync(join(tmpdir(), "fact-view-"));
  try {
    const path = join(session, "facts.jsonl");
    writeFileSync(path, line({ type: "entry", entry: fact() }));
    assert.equal(readFactTableView(session)!.entries[0]!.status, "justified");
    const transaction = { type: "transaction", records: [{ type: "entry", entry: fact("F:1", "refuted") }, { type: "entry", entry: fact("F:2") }] };
    appendFileSync(path, JSON.stringify(transaction));
    assert.deepEqual(readFactTableView(session)!.entries.map((entry) => [entry.id, entry.status]), [["F:1", "justified"]]);
    appendFileSync(path, "\n");
    assert.deepEqual(readFactTableView(session)!.entries.map((entry) => [entry.id, entry.status]), [["F:1", "refuted"], ["F:2", "justified"]]);
    // The worker poisons a crashed tail before appending again. A syntactically
    // complete but uncommitted record must never be resurrected by that append.
    appendFileSync(path, JSON.stringify({ type: "entry", entry: fact("F:1") }));
    assert.equal(readFactTableView(session)!.entries[0]!.status, "refuted");
    appendFileSync(path, `!\n${line({ type: "entry", entry: fact("F:3") })}`);
    assert.equal(readFactTableView(session)!.entries[0]!.status, "refuted");
    assert.equal(readFactTableView(session)!.entries.length, 3);
  } finally { rmSync(session, { recursive: true, force: true }); }
});

test("missing, empty, legacy, and temporarily unreadable fact journals remain distinct", () => {
  const session = mkdtempSync(join(tmpdir(), "fact-view-"));
  try {
    const path = join(session, "facts.jsonl");
    assert.equal(readFactTableView(session), undefined);
    writeFileSync(path, "");
    assert.deepEqual(readFactTableView(session), { entries: [] });
    const { badgeHash: _hash, ...legacy } = fact();
    appendFileSync(path, line({ type: "entry", entry: legacy }));
    const good = readFactTableView(session)!;
    assert.equal(good.entries[0]!.badgeHash, undefined);
    renameSync(path, `${path}.saved`); mkdirSync(path);
    const failed = readFactTableView(session)!;
    assert.equal(failed.error, "The fact table journal could not be read.");
    assert.deepEqual(failed.entries, good.entries);
    rmSync(path, { recursive: true }); renameSync(`${path}.saved`, path);
    assert.deepEqual(readFactTableView(session), good);
  } finally { rmSync(session, { recursive: true, force: true }); }
});

function done(detail: JobDetail) {
  const stage = detail.stages.find((stage) => stage.id === "done");
  assert.ok(stage?.id === "done");
  return stage;
}

test("the Done stage detail cache refreshes when only the shared fact journal changes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fact-detail-"));
  try {
    const jobId = "fact-view-completed";
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const session = join(workspace, "workspace", "sessions", jobId);
    mkdirSync(jobDir, { recursive: true }); mkdirSync(session, { recursive: true });
    writeFileSync(join(jobDir, "job.json"), JSON.stringify({ jobId, topic: "A conditional identity", status: "completed", runner: "local", createdAt: 1, updatedAt: 2 }));
    writeFileSync(join(session, "checkpoint.json"), JSON.stringify({ runId: jobId, workflowId: "brainstorm", status: "completed", input: {}, journal: [], pendingGates: [], seq: 1, updatedAt: 2 }));
    writeFileSync(join(jobDir, "events.jsonl"), line({ type: "agent:progress", seq: 1, at: 1, path: "brainstorm-root/process-input", progress: { kind: "model", message: "Checked the submitted identity." } }));
    const manager = new JobManager({ workspace });
    const before = await manager.detail(jobId);
    assert.equal(done(before).factTable, undefined);
    assert.equal(await manager.detail(jobId), before, "an unchanged detail is cached");
    const path = join(session, "facts.jsonl");
    writeFileSync(path, "");
    assert.deepEqual(done(await manager.detail(jobId)).factTable, { entries: [] });
    appendFileSync(path, line({ type: "entry", entry: fact() }));
    const recorded = await manager.detail(jobId);
    assert.equal(done(recorded).factTable!.entries[0]!.status, "justified");
    assert.equal(await manager.detail(jobId), recorded);
    appendFileSync(path, line({ type: "view-commit", entries: [fact("F:1", "disputed")] }));
    const changed = await manager.detail(jobId);
    assert.notEqual(changed, recorded);
    assert.equal(done(changed).factTable!.entries[0]!.status, "disputed");
    assert.equal(done(recorded).factTable!.entries[0]!.status, "justified", "previous responses remain immutable");
    const activity = await manager.stageActivity(jobId, "process-input");
    assert.ok(activity.length > 0, "the fixture has a recorded stage history");
    renameSync(path, `${path}.saved`); mkdirSync(path);
    const failed = await manager.detail(jobId);
    assert.ok(done(failed).factTable?.error);
    assert.deepEqual(await manager.stageActivity(jobId, "process-input"), activity, "a fact read error does not hide the stage's companion history");
    const retried = await manager.detail(jobId);
    assert.notEqual(retried, failed, "read errors are retried even when file metadata is unchanged");
    rmSync(path, { recursive: true }); renameSync(`${path}.saved`, path);
    const recovered = await manager.detail(jobId);
    assert.equal(done(recovered).factTable?.error, undefined);
    assert.equal(await manager.detail(jobId), recovered, "successful reads restore normal caching");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a deleted badge leaves the table with its uses and history; only its id, time and replacement remain", () => {
  const session = mkdtempSync(join(tmpdir(), "fact-view-"));
  try {
    const deletedClaim = "The deleted claim must never reach the view.";
    writeFileSync(join(session, "facts.jsonl"), [
      line({ type: "entry", entry: { ...fact("F:1"), claim: deletedClaim } }),
      line({ type: "entry", entry: fact("F:2") }),
      line({ type: "transaction", records: [
        { type: "entry", entry: fact("F:3") },
        { type: "submission", id: "S:3", requester: { taskId: "job:brainstorm-root/review-members/x", role: "commentor", agent: "member-4" }, case: "justified-new", badge: "F:3", conflicts: [{ id: "F:1", resolution: "incumbent-revoked" }] },
        { type: "deletion", id: "F:1", seq: 1, at: 50, replacedBy: "F:3" },
      ] }),
      // A later snapshot or view commit of a deleted id never brings it back.
      line({ type: "entry", entry: { ...fact("F:1"), claim: deletedClaim } }),
      line({ type: "view-commit", entries: [{ ...fact("F:1", "disputed"), claim: deletedClaim }] }),
      line({ type: "deletion", id: "F:2", seq: 2, at: 60 }),
      line({ type: "deletion", id: "invalid", seq: 3, at: 70 }),
    ].join(""));
    const view = readFactTableView(session)!;
    assert.deepEqual(view.entries.map((entry) => entry.id), ["F:3"]);
    assert.deepEqual(view.deleted, [{ id: "F:1", at: 50, replacedBy: "F:3" }, { id: "F:2", at: 60 }]);
    assert.equal(view.updates, undefined, "no fact-update journal, no updates");
    assert.doesNotMatch(JSON.stringify(view), new RegExp(deletedClaim));
  } finally { rmSync(session, { recursive: true, force: true }); }
});

test("fact updates list each notice's subscribers and reconsideration states, never the notice text", () => {
  const session = mkdtempSync(join(tmpdir(), "fact-view-"));
  try {
    writeFileSync(join(session, "facts.jsonl"), [
      line({ type: "entry", entry: fact("F:3") }),
      line({ type: "deletion", id: "F:1", seq: 1, at: 50, replacedBy: "F:3" }),
      line({ type: "deletion", id: "F:2", seq: 2, at: 60 }),
      line({ type: "deletion", id: "F:4", seq: 3, at: 70 }),
    ].join(""));
    const secret = { claim: "A secret deleted claim.", conditions: "Secret conditions.", reason: "A secret reason for the deletion." };
    const task = (key: string, attempt: number, notices: string[]) => ({ type: "task", key, taskId: `fact-update:${key}:${attempt}`, notices, epoch: 1, base: {}, at: 52 });
    const result = (key: string, attempt: number, output: unknown) => ({ type: "result", taskId: `fact-update:${key}:${attempt}`, status: "ok", output, usage: { inputTokens: 10, outputTokens: 1 }, at: 53 });
    writeFileSync(join(session, "fact-updates.jsonl"), [
      line({ type: "notice", id: "N:1", seq: 1, at: 51, deleted: "F:1", replacedBy: "F:3", notice: { notice: "N:1", deleted: "F:1", ...secret },
        subscribers: ["chain:member-2", "game-report:member-1:3:1:member-4", "comment:member-1:2:1:member-3", "chain:member-5", "none:supreme_judge:supreme_judge"] }),
      line(task("chain:member-2", 1, ["N:1"])),
      line(task("game-report:member-1:3:1:member-4", 1, ["N:1"])),
      line(task("comment:member-1:2:1:member-3", 1, ["N:1"])),
      line(task("chain:member-5", 1, ["N:1"])),
      line(result("game-report:member-1:3:1:member-4", 1, { decision: "withdrawn", reason: "The report rested on F:1." })),
      line(result("comment:member-1:2:1:member-3", 1, { decision: "revised", reason: "Rebuilt.", comment: {} })),
      line(result("chain:member-5", 1, { decision: "unchanged", reason: "The chain never relied on F:1.", steps: [] })),
      line({ type: "notice", id: "N:2", seq: 2, at: 61, deleted: "F:2", notice: { notice: "N:2", deleted: "F:2", ...secret },
        subscribers: ["chain:member-2", "comment:member-1:2:1:member-6", "game-report:member-3:1:2:member-1"] }),
      // The unmerged chain task is superseded by one task covering both notices.
      line({ type: "supersede", keys: ["chain:member-2"], taskIds: ["fact-update:chain:member-2:1"], at: 62 }),
      line(task("chain:member-2", 2, ["N:1", "N:2"])),
      line(task("comment:member-1:2:1:member-6", 1, ["N:2"])),
      line(task("game-report:member-3:1:2:member-1", 1, ["N:2"])),
      line(result("chain:member-2", 2, { decision: "revised", reason: "Rebuilt step 2.", steps: [] })),
      line({ type: "result", taskId: "fact-update:comment:member-1:2:1:member-6:1", status: "error", error: "provider failed", at: 63 }),
      line({ type: "closed", at: 64 }),
      line({ type: "notice", id: "N:3", seq: 3, at: 71, deleted: "F:4", notice: { notice: "N:3", deleted: "F:4", ...secret }, subscribers: ["chain:member-2"] }),
    ].join(""));
    // The merge before the judge discarded the comment revision: the comment had changed.
    const journal = [{ key: "brainstorm-root/review-members/review-members-fanout/member[0]/review-steps/cotStep[1]/review-round-loop/iter[0]/review-round-body/apply-comment-updates/apply-comment-updates-run::result",
      kind: "activity" as const, value: { merged: [], discarded: [{ key: "comment:member-1:2:1:member-3", taskId: "fact-update:comment:member-1:2:1:member-3:1", notices: ["N:1"], reason: "report-changed" }] } }];
    const view = readFactTableView(session, { journal })!;
    assert.deepEqual(view.deleted?.map((deletion) => deletion.id), ["F:1", "F:2", "F:4"]);
    assert.deepEqual(view.updates, [
      { notice: "N:1", deleted: "F:1", replacedBy: "F:3", at: 51, subscribers: [
        { key: "chain:member-2", kind: "chain", agentId: "member-2", seatId: "member-2", state: "applied" },
        { key: "game-report:member-1:3:1:member-4", kind: "game-report", agentId: "member-4", seatId: "member-1", step: 3, round: 1, state: "withdrawn" },
        { key: "comment:member-1:2:1:member-3", kind: "comment", agentId: "member-3", seatId: "member-1", step: 2, round: 1, state: "discarded" },
        { key: "chain:member-5", kind: "chain", agentId: "member-5", seatId: "member-5", state: "unchanged" },
        { key: "none:supreme_judge:supreme_judge", kind: "none", agentId: "supreme_judge", state: "no-task" },
      ] },
      { notice: "N:2", deleted: "F:2", at: 61, subscribers: [
        { key: "chain:member-2", kind: "chain", agentId: "member-2", seatId: "member-2", state: "applied" },
        { key: "comment:member-1:2:1:member-6", kind: "comment", agentId: "member-6", seatId: "member-1", step: 2, round: 1, state: "failed" },
        { key: "game-report:member-3:1:2:member-1", kind: "game-report", agentId: "member-1", seatId: "member-3", step: 1, round: 2, state: "running" },
      ] },
      { notice: "N:3", deleted: "F:4", at: 71, subscribers: [
        { key: "chain:member-2", kind: "chain", agentId: "member-2", seatId: "member-2", state: "no-task" },
      ] },
    ]);
    assert.doesNotMatch(JSON.stringify(view), /secret/i, "no claim, condition or reason of a deleted badge reaches the view");
    // Each reconsideration task's spend is a fact-table model call of the review.
    assert.deepEqual(factCallUsage(session).map((call) => call.taskId).sort(), [
      "fact-update:chain:member-2:2", "fact-update:chain:member-5:1",
      "fact-update:comment:member-1:2:1:member-3:1", "fact-update:game-report:member-1:3:1:member-4:1",
    ]);
  } finally { rmSync(session, { recursive: true, force: true }); }
});

test("a revocation in a private review reaches the shared table as disputed, with no deletion", () => {
  const session = mkdtempSync(join(tmpdir(), "fact-view-"));
  try {
    const detail = "Revoked in a private review; pending a ruling against the shared table's combined evidence.";
    const disputed = { ...fact("F:1", "disputed"), updatedAt: 5, history: [...fact().history, { at: 5, event: "disputed", detail }] };
    writeFileSync(join(session, "facts.jsonl"), [
      line({ type: "entry", entry: fact("F:1") }),
      line({ type: "view-commit", entries: [disputed, fact("F:40", "disputed")], view: { key: "private", entries: [fact("F:40")] } }),
    ].join(""));
    // The private journal records its own deletion; the shared view never reads it.
    const group = join(session, "fact-views", "group-hash");
    mkdirSync(group, { recursive: true });
    writeFileSync(join(group, "task-hash.jsonl"), [
      line({ type: "entry", entry: fact("F:1") }),
      line({ type: "transaction", records: [{ type: "entry", entry: fact("F:40") }, { type: "deletion", id: "F:1", seq: 1, at: 4, replacedBy: "F:40" }] }),
    ].join(""));
    const view = readFactTableView(session)!;
    assert.deepEqual(view.entries.map((entry) => [entry.id, entry.status]), [["F:1", "disputed"], ["F:40", "disputed"]]);
    assert.equal(view.entries[0]!.history.at(-1)?.detail, detail);
    assert.equal(view.deleted, undefined);
    assert.equal(view.updates, undefined);
  } finally { rmSync(session, { recursive: true, force: true }); }
});

test("verifications and consultations of the shared and private journals count for the task that requested them", () => {
  const session = mkdtempSync(join(tmpdir(), "fact-view-"));
  try {
    const critic = "job:brainstorm-root/review-members/review-members-fanout/member[0]/review-steps/cotStep[0]/game-review-round/iter[0]/game-review-round-body/gather-game-comments/fanout/commentor[0]/else/game-comment-step-execute";
    const thinker = "job:brainstorm-root/first-pass/first-pass-fanout/member[0]/develop-idea/develop-idea-execute";
    const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 1 });
    writeFileSync(join(session, "facts.jsonl"), [
      // The submit scan is recorded with the verification as its requester, before the submission line.
      line({ type: "consultation", at: 1, requester: { taskId: "fact-verification:S:1", role: "supreme_judge", agent: "supreme_judge" }, request: { mode: "submit" }, answer: "", matches: [], taskIds: ["fact-consultation:a"], usage: usage(7) }),
      line({ type: "transaction", records: [{ type: "entry", entry: fact("F:1") }, { type: "submission", id: "S:1", requester: { taskId: thinker, role: "brain", agent: "member-1" }, case: "justified-new", badge: "F:1", conflicts: [], verifierTaskId: "fact-verification:S:1", usage: usage(100) }] }),
      line({ type: "consultation", at: 2, requester: { taskId: critic, role: "game-commentor", agent: "member-2" }, request: { mode: "lookup" }, answer: "", matches: [], taskIds: ["fact-consultation:b"], usage: usage(20) }),
      line({ type: "consultation", at: 3, requester: { taskId: critic, role: "game-commentor", agent: "member-2" }, request: { mode: "status" }, answer: "", matches: [], taskIds: [] }),
      line({ type: "submission", id: "S:2", requester: { taskId: critic, role: "game-commentor", agent: "member-2" }, case: "unverified", conflicts: [], refusal: "no verifier" }),
    ].join(""));
    const group = join(session, "fact-views", "group-hash");
    mkdirSync(group, { recursive: true });
    writeFileSync(join(group, "task-hash.jsonl"), [
      line({ type: "entry", entry: fact("F:1") }),
      line({ type: "consultation", at: 4, requester: { taskId: critic, role: "game-commentor", agent: "member-2" }, request: { mode: "lookup" }, answer: "", matches: [], taskIds: ["fact-consultation:c"], usage: usage(300) }),
      line({ type: "submission", id: "S:40", requester: { taskId: critic, role: "game-commentor", agent: "member-2" }, case: "justified-new", badge: "F:40", conflicts: [], verifierTaskId: "fact-verification:S:40", usage: usage(4000) }),
      // A partial last line is a write in progress.
      JSON.stringify({ type: "consultation", at: 5, requester: { taskId: critic }, usage: usage(50000) }),
    ].join(""));
    writeFileSync(join(session, "fact-updates.jsonl"), [
      line({ type: "task", key: "chain:member-1", taskId: "fact-update:chain:member-1:1", notices: ["N:1"], epoch: 1, base: {}, at: 6 }),
      line({ type: "result", taskId: "fact-update:chain:member-1:1", status: "ok", output: { decision: "unchanged", reason: "r", steps: [] }, usage: usage(60000), at: 7 }),
    ].join(""));
    const calls = factCallUsage(session);
    assert.deepEqual(calls.map((call) => [call.taskId, call.usage.inputTokens]), [
      [thinker, 7], [thinker, 100], [critic, 20], [critic, 300], [critic, 4000], ["fact-update:chain:member-1:1", 60000],
    ]);
  } finally { rmSync(session, { recursive: true, force: true }); }
});

test("the Done stage detail cache refreshes when only the fact-update journal changes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "fact-detail-"));
  try {
    const jobId = "fact-update-completed";
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const session = join(workspace, "workspace", "sessions", jobId);
    mkdirSync(jobDir, { recursive: true }); mkdirSync(session, { recursive: true });
    writeFileSync(join(jobDir, "job.json"), JSON.stringify({ jobId, topic: "A conditional identity", status: "completed", runner: "local", createdAt: 1, updatedAt: 2 }));
    writeFileSync(join(session, "checkpoint.json"), JSON.stringify({ runId: jobId, workflowId: "brainstorm", status: "completed", input: {}, journal: [], pendingGates: [], seq: 1, updatedAt: 2 }));
    writeFileSync(join(session, "facts.jsonl"), line({ type: "entry", entry: fact("F:2") }) + line({ type: "deletion", id: "F:1", seq: 1, at: 3, replacedBy: "F:2" }));
    const manager = new JobManager({ workspace });
    const before = await manager.detail(jobId);
    assert.deepEqual(done(before).factTable?.deleted, [{ id: "F:1", at: 3, replacedBy: "F:2" }]);
    assert.equal(done(before).factTable?.updates, undefined);
    assert.equal(await manager.detail(jobId), before, "an unchanged detail is cached");
    appendFileSync(join(session, "fact-updates.jsonl"), line({ type: "notice", id: "N:1", seq: 1, at: 4, deleted: "F:1", replacedBy: "F:2", notice: {}, subscribers: ["chain:member-1"] }));
    const noticed = await manager.detail(jobId);
    assert.notEqual(noticed, before);
    assert.deepEqual(done(noticed).factTable?.updates?.[0]?.subscribers.map((subscriber) => subscriber.state), ["running"]);
    appendFileSync(join(session, "fact-updates.jsonl"), line({ type: "task", key: "chain:member-1", taskId: "fact-update:chain:member-1:1", notices: ["N:1"], epoch: 1, base: {}, at: 5 }) +
      line({ type: "result", taskId: "fact-update:chain:member-1:1", status: "ok", output: { decision: "unchanged", reason: "r", steps: [] }, at: 6 }));
    assert.deepEqual(done(await manager.detail(jobId)).factTable?.updates?.[0]?.subscribers.map((subscriber) => subscriber.state), ["unchanged"]);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
