/**
 * The fact-update spawner (spec/fact-updates.md section 6 with decisions D4,
 * D10, D11, D14; section 10 tests 26-31): tasks start at once and in
 * parallel, are journaled before they run, supersede an unmerged task of the
 * same subscriber, are re-run on resume at their merge point, and stop at the
 * run's close and at a round's late merge. A cancelled or failed run aborts
 * its running tasks, which run again on resume (decision D16). The runtime's subscriber index is
 * the real one; the task builder, the table and the executor are stand-ins.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FactUpdateIndex,
  chainBase,
  reportBase,
  reportSubscriberKey,
  type CompiledContentWorkflow,
  type FactMergeRequest,
  type FactReconsiderationTaskRequest,
} from "@brainstorm-agentic/brainstorm-runtime";
import {
  WindDownSignal,
  WorkflowCancelledError,
  type AgentExecutionContext,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type FactDeletion,
  type FactEntry,
  type FactUpdateEvent,
  type JsonObject,
  type JsonValue,
} from "@brainstorm-agentic/core";

import { FactUpdateSpawner, type FactUpdateTable } from "../src/fact-updates.js";

const RUN = "run-1";
const SIGNAL = new AbortController().signal;
const step = (text: string) => ({ part1: `${text}, first part.`, part2: `${text}, second part.`, part3: `${text}, third part.`, part4: `${text}, fourth part.` });
/** A seat's idea whose step 1 cites `ids`. */
const ideaCiting = (...ids: readonly string[]): JsonObject => ({
  output: { type: "research idea", paper: { abstract: ["A."], introduction: ["I."], method: ["M."], discussion: ["D."], conclusion: ["C."] } },
  cot: [{ ...step("One"), part2: `It holds ${ids.map((id) => `[${id}]`).join(" and ")}.` }, step("Two"), step("Three")],
});
const REPORT_KEY = reportSubscriberKey("game-report", "member-1", 2, 1, "member-2");
const COMMENT_KEY = reportSubscriberKey("comment", "member-1", 2, 1, "member-3");
const report = (ids: readonly string[]): JsonObject => ({ q: 0.3, justification: `The step is unsupported ${ids.map((id) => `[${id}]`).join(" ")}.` });

function entry(id: string, claim: string): FactEntry {
  return {
    id, status: "justified", kind: "math", claim, conditions: "none", method: "judgement-only", evidence: "A proof.",
    createdAt: 1, updatedAt: 1, history: [{ at: 1, event: "issued", by: "S:1", detail: `Issued ${id}.` }],
    requesters: [{ taskId: "t-0", role: "brain", agent: "member-9", seat: "member-9" }],
  };
}

/** The shared table as the spawner reads it; `remove` records one deletion and returns its event. */
class Table implements FactUpdateTable {
  epoch = 0;
  readonly list: FactDeletion[] = [];
  readonly events: FactUpdateEvent[] = [];
  async deletionEpoch(): Promise<number> {
    return this.epoch;
  }
  async deletions(): Promise<readonly FactDeletion[]> {
    return this.list;
  }
  async updateEvents(): Promise<readonly FactUpdateEvent[]> {
    return this.events;
  }
  remove(id: string, replacedBy?: string): FactUpdateEvent {
    this.epoch += 1;
    const deletion: FactDeletion = { id, seq: this.epoch, at: 1_000 + this.epoch, ...(replacedBy !== undefined ? { replacedBy } : {}) };
    this.list.push(deletion);
    const event: FactUpdateEvent = {
      deletion,
      entry: entry(id, `The claim of ${id}.`),
      reason: `The ruling on ${id}.`,
      ...(replacedBy !== undefined ? { replacement: entry(replacedBy, `The claim of ${replacedBy}.`) } : {}),
      submission: `S:${10 + this.epoch}`,
    };
    this.events.push(event);
    return event;
  }
}

interface Held {
  readonly task: AgentTask;
  readonly context: AgentExecutionContext;
  finish(output: JsonValue): void;
  fail(message: string): void;
}

/** An executor whose tasks stay open until the test ends each one. */
class HeldExecutor implements AgentExecutor {
  readonly started: Held[] = [];
  async execute(task: AgentTask, context: AgentExecutionContext): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve) => {
      this.started.push({
        task,
        context,
        finish: (output) => resolve({ taskId: task.taskId, status: "ok", output, usage: { inputTokens: 100, outputTokens: 10 } }),
        fail: (message) => resolve({ taskId: task.taskId, status: "error", error: { name: "TaskError", message } }),
      });
    });
  }
  byKey(key: string): Held[] {
    return this.started.filter((held) => held.context.nodePath === `fact-updates/${key}`);
  }
}

const SCHEMA_OF: Record<string, string> = { chain: "chainReconsiderationParts", "game-report": "gameReportReconsideration", comment: "commentReconsideration" };
const UNCHANGED_CHAIN = { decision: "unchanged", reason: "Nothing in the chain rests on the deleted badge.", steps: [] };
const UNCHANGED = { decision: "unchanged", reason: "The report does not rest on the deleted badge." };

/** The compiled workflow's side: the real index, and a builder that records what each task was asked. */
function compiledWith(index: FactUpdateIndex) {
  const requests: FactReconsiderationTaskRequest[] = [];
  const compiled: Pick<CompiledContentWorkflow, "factUpdateIndex" | "factReconsiderationTask"> = {
    factUpdateIndex: index,
    factReconsiderationTask: async (request) => {
      requests.push(request);
      const kind = request.key.split(":")[0]!;
      const base = kind === "chain"
        ? chainBase(index.idea(request.runId, request.key.split(":")[1]!)!)
        : reportBase(index.report(request.runId, request.key)!.report);
      return {
        task: { taskId: request.taskId, kind: `brainstorm.reconsider-${kind}`, input: { bindings: { factUpdates: request.notices as unknown as JsonValue } },
          outputSchema: { name: SCHEMA_OF[kind]!, schema: {} } },
        base,
      };
    },
  };
  return { compiled, requests };
}

function journalPath(): string {
  const directory = join(mkdtempSync(join(tmpdir(), "fact-updates-")), RUN);
  mkdirSync(directory, { recursive: true });
  return join(directory, "fact-updates.jsonl");
}

function journal(path: string): JsonObject[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as JsonObject);
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 5_000 && !condition(); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "the condition never held");
}

function fixture(options: { readonly windDown?: { readonly at: number; readonly reason: string }; readonly path?: string } = {}) {
  const index = new FactUpdateIndex();
  const table = new Table();
  const executor = new HeldExecutor();
  const { compiled, requests } = compiledWith(index);
  const path = options.path ?? journalPath();
  const spawner = new FactUpdateSpawner({ runId: RUN, journalPath: path, table, compiled, executor,
    ...(options.windDown !== undefined ? { windDown: options.windDown } : {}) });
  return { index, table, executor, requests, path, spawner };
}

const request = (point: FactMergeRequest["point"], extra: Partial<FactMergeRequest> = {}): FactMergeRequest =>
  ({ runId: RUN, nodePath: `root/${point}`, point, signal: SIGNAL, ...extra });
const ROUND = { seat: "member-1", step: 2, round: 1 } as const;

/** The index of a round in flight: member-1's chain and two unsettled reports cite F:7. */
function seedRound(index: FactUpdateIndex): void {
  index.setIdea(RUN, "member-1", ideaCiting("F:7"));
  const prefix = (ideaCiting("F:7").cot as JsonValue[]).slice(0, 2);
  index.openReport(RUN, { key: REPORT_KEY, kind: "game-report", seat: "member-1", step: 2, round: 1, critic: "member-2", report: report(["F:7"]), prefix, epoch: 0 });
  index.openReport(RUN, { key: COMMENT_KEY, kind: "comment", seat: "member-1", step: 2, round: 1, critic: "member-3", report: report(["F:7"]), prefix, allowedVerdicts: ["Pass", "Build"] });
}

test("26 one deletion with three subscribers journals its notice and starts three tasks before any finishes", async () => {
  const { index, table, executor, requests, path, spawner } = fixture();
  seedRound(index);
  spawner.onDeletion(table.remove("F:7", "F:12"));
  await until(() => executor.started.length === 3);
  assert.deepEqual(journal(path).map((line) => line.type), ["notice", "task", "task", "task"], "every task line precedes any result");
  const [notice] = journal(path);
  assert.deepEqual(notice!.subscribers, ["chain:member-1", REPORT_KEY, COMMENT_KEY, "none:brain:member-9"],
    "F:7's submitter, member-9's brain, has no revisable output: listed, no task");
  assert.deepEqual([notice!.id, notice!.seq, notice!.deleted, notice!.replacedBy], ["N:1", 1, "F:7", "F:12"]);
  assert.deepEqual(notice!.notice, {
    notice: "N:1", deleted: "F:7", claim: "The claim of F:7.", conditions: "none", reason: "The ruling on F:7.",
    replacement: { id: "F:12", status: "justified", claim: "The claim of F:12.", conditions: "none", reason: "Issued F:12." },
  });
  assert.deepEqual(requests.map((built) => [built.key, built.taskId, built.notices.map((item) => item.citedAt ?? null)]), [
    ["chain:member-1", "fact-update:chain:member-1:1", [[1]]],
    [REPORT_KEY, `fact-update:${REPORT_KEY}:1`, [[1]]],
    [COMMENT_KEY, `fact-update:${COMMENT_KEY}:1`, [[1]]],
  ]);
  assert.deepEqual(executor.started.map((held) => [held.context.runId, held.context.nodePath]), [
    [RUN, "fact-updates/chain:member-1"], [RUN, `fact-updates/${REPORT_KEY}`], [RUN, `fact-updates/${COMMENT_KEY}`],
  ]);
  executor.byKey("chain:member-1")[0]!.finish(UNCHANGED_CHAIN);
  executor.byKey(REPORT_KEY)[0]!.finish(UNCHANGED);
  executor.byKey(COMMENT_KEY)[0]!.finish(UNCHANGED);
  await until(() => journal(path).length === 7);
  const results = journal(path).slice(4);
  assert.deepEqual(results.map((line) => [line.type, line.status]), [["result", "ok"], ["result", "ok"], ["result", "ok"]]);
  assert.deepEqual(results[0]!.usage, { inputTokens: 100, outputTokens: 10 }, "a result line carries the task's usage (D8)");
  const task = journal(path)[1]!;
  assert.deepEqual([task.key, task.notices, task.epoch, task.base], ["chain:member-1", ["N:1"], 1, chainBase(ideaCiting("F:7"))]);
});

test("27 the merge points take their tasks; a resume re-runs only an unfinished, unsuperseded task, at its merge point [D10]", async () => {
  const first = fixture();
  seedRound(first.index);
  first.index.withdrawReport(RUN, COMMENT_KEY);
  first.spawner.onDeletion(first.table.remove("F:7"));
  await until(() => first.executor.started.length === 2);
  first.executor.byKey(REPORT_KEY)[0]!.finish({ decision: "revised", reason: "Rebuilt without F:7.", report: report([]) });
  await until(() => journal(first.path).some((line) => line.type === "result"));
  // The worker stops here: the chain task never finished.
  const index = new FactUpdateIndex();
  seedRound(index);
  index.withdrawReport(RUN, COMMENT_KEY);
  const executor = new HeldExecutor();
  const { compiled } = compiledWith(index);
  const resumed = new FactUpdateSpawner({ runId: RUN, journalPath: first.path, table: first.table, compiled, executor });
  const reports = await resumed.merge(request("game-reports", ROUND));
  assert.equal(executor.started.length, 0, "a journaled result is merged, never re-run");
  assert.deepEqual(reports, {
    merged: [{ key: REPORT_KEY, taskId: `fact-update:${REPORT_KEY}:1`, notices: ["N:1"],
      output: { decision: "revised", reason: "Rebuilt without F:7.", report: report([]) }, epoch: 1 }],
    discarded: [],
  });
  const pending = resumed.merge(request("chain", { seat: "member-1" }));
  await until(() => executor.started.length === 1);
  assert.equal(executor.started[0]!.task.taskId, "fact-update:chain:member-1:2");
  executor.started[0]!.finish(UNCHANGED_CHAIN);
  const chain = await pending;
  assert.deepEqual(chain.merged, [{ key: "chain:member-1", taskId: "fact-update:chain:member-1:2", notices: ["N:1"], output: UNCHANGED_CHAIN }]);
  assert.deepEqual(chain.discarded, [{ key: "chain:member-1", taskId: "fact-update:chain:member-1:1", notices: ["N:1"], reason: "superseded" }]);
  assert.deepEqual(journal(first.path).map((line) => [line.type, line.taskId ?? line.taskIds ?? line.id ?? null]), [
    ["notice", "N:1"],
    ["task", "fact-update:chain:member-1:1"],
    ["task", `fact-update:${REPORT_KEY}:1`],
    ["result", `fact-update:${REPORT_KEY}:1`],
    ["supersede", ["fact-update:chain:member-1:1"]],
    ["task", "fact-update:chain:member-1:2"],
    ["result", "fact-update:chain:member-1:2"],
  ]);
});

test("28 a second deletion supersedes an unmerged task; only the new result merges", async () => {
  const { index, table, executor, path, spawner } = fixture();
  index.setIdea(RUN, "member-1", ideaCiting("F:7", "F:9"));
  spawner.onDeletion(table.remove("F:7"));
  await until(() => executor.started.length === 1);
  spawner.onDeletion(table.remove("F:9"));
  await until(() => executor.started.length === 2);
  assert.deepEqual(journal(path).map((line) => line.type), ["notice", "task", "notice", "supersede", "task"]);
  assert.deepEqual(journal(path)[4]!.notices, ["N:1", "N:2"], "one task covers every unmerged notice of the key");
  executor.started[1]!.finish({ decision: "revised", reason: "Both deleted badges are gone.", steps: [{ index: 1, ...step("One rebuilt") }] });
  executor.started[0]!.finish(UNCHANGED_CHAIN);
  const merged = await spawner.merge(request("chain", { seat: "member-1" }));
  assert.deepEqual((merged.merged as JsonObject[]).map((item) => [item.taskId, item.notices]), [["fact-update:chain:member-1:2", ["N:1", "N:2"]]]);
  assert.deepEqual(merged.discarded, [{ key: "chain:member-1", taskId: "fact-update:chain:member-1:1", notices: ["N:1"], reason: "superseded" }]);
});

test("20 the base check: a rewritten step the round's repair changed meanwhile gets exactly one re-run, whose result merges", async () => {
  const { index, table, executor, spawner } = fixture();
  index.setIdea(RUN, "member-1", ideaCiting("F:7"));
  spawner.onDeletion(table.remove("F:7"));
  await until(() => executor.started.length === 1);
  const rewrite = { decision: "revised", reason: "Step 1 no longer rests on F:7.", steps: [{ index: 1, ...step("One rebuilt") }] };
  executor.started[0]!.finish(rewrite);
  // The round's repair rewrites step 1 while the task runs.
  index.setIdea(RUN, "member-1", { ...ideaCiting("F:7"), cot: [{ ...step("One repaired"), part2: "Still [F:7]." }, step("Two"), step("Three")] });
  const pending = spawner.merge(request("chain", { seat: "member-1" }));
  await until(() => executor.started.length === 2);
  assert.equal(executor.started[1]!.task.taskId, "fact-update:chain:member-1:2");
  executor.started[1]!.finish(rewrite);
  const merged = await pending;
  assert.deepEqual((merged.merged as JsonObject[]).map((item) => item.taskId), ["fact-update:chain:member-1:2"]);
  assert.equal(executor.started.length, 2, "one re-run only");
});

test("21 a report or comment that changed since its task began is discarded at the merge", async () => {
  const { index, table, executor, spawner } = fixture();
  seedRound(index);
  index.setIdea(RUN, "member-1", ideaCiting("F:1"));
  spawner.onDeletion(table.remove("F:7"));
  await until(() => executor.started.length === 2);
  executor.byKey(REPORT_KEY)[0]!.finish(UNCHANGED);
  executor.byKey(COMMENT_KEY)[0]!.finish(UNCHANGED);
  index.reviseReport(RUN, REPORT_KEY, report(["F:1"]));
  const reports = await spawner.merge(request("game-reports", ROUND));
  assert.deepEqual(reports, { merged: [], discarded: [{ key: REPORT_KEY, taskId: `fact-update:${REPORT_KEY}:1`, notices: ["N:1"], reason: "report-changed" }] });
  const comments = await spawner.merge(request("comments", ROUND));
  assert.deepEqual((comments.merged as JsonObject[]).map((item) => item.key), [COMMENT_KEY]);
});

test("29 an output stored live that cites a deleted badge gets a task; a report requested after the deletion does not", async () => {
  const { index, table, executor, path, spawner } = fixture();
  index.setIdea(RUN, "member-1", ideaCiting("F:1"));
  spawner.onDeletion(table.remove("F:7"));
  await until(() => journal(path).length === 1);
  assert.deepEqual(journal(path)[0]!.subscribers, ["none:brain:member-9"]);
  // member-1's redevelopment, which started before the deletion, stores a chain that cites F:7.
  index.setIdea(RUN, "member-1", ideaCiting("F:7"));
  spawner.stored({ runId: RUN, key: "chain:member-1" });
  await until(() => executor.started.length === 1);
  assert.equal(executor.started[0]!.task.taskId, "fact-update:chain:member-1:1");
  // A report requested at the deletion's epoch saw a table without F:7: settlement decides it, no task.
  index.openReport(RUN, { key: REPORT_KEY, kind: "game-report", seat: "member-1", step: 2, round: 1, critic: "member-2", report: report(["F:7"]),
    prefix: (ideaCiting("F:7").cot as JsonValue[]).slice(0, 2), epoch: 1 });
  spawner.stored({ runId: RUN, key: REPORT_KEY });
  await spawner.merge(request("game-reports", ROUND));
  assert.equal(executor.started.length, 1);
});

test("30 after the close before synthesis a deletion is journaled with its notice and starts no task [D6, D14]", async () => {
  const { index, table, executor, path, spawner } = fixture();
  index.setIdea(RUN, "member-1", ideaCiting("F:1"));
  const closed = await spawner.merge(request("close"));
  assert.deepEqual(closed, { merged: [], discarded: [] });
  index.closeRun(RUN);
  index.setIdea(RUN, "member-1", ideaCiting("F:7"));
  spawner.onDeletion(table.remove("F:7"));
  await until(() => journal(path).length === 2);
  assert.deepEqual(journal(path).map((line) => line.type), ["closed", "notice"]);
  assert.deepEqual(journal(path)[1]!.subscribers, []);
  spawner.stored({ runId: RUN, key: "chain:member-1" });
  assert.deepEqual(await spawner.merge(request("ideas")), { merged: [], discarded: [] });
  assert.equal(executor.started.length, 0);
});

test("31 a deletion while a report is with the chair starts its task at once; one after the round's late merge starts none [D4]", async () => {
  const { index, table, executor, path, spawner } = fixture();
  seedRound(index);
  index.withdrawReport(RUN, COMMENT_KEY);
  index.setIdea(RUN, "member-1", ideaCiting("F:1"));
  index.noteMerge(RUN, await spawner.merge(request("game-reports", ROUND)));
  index.passToChair(RUN, "game-report", "member-1", 2, 1);
  spawner.onDeletion(table.remove("F:7"));
  await until(() => executor.started.length === 1);
  assert.equal(executor.started[0]!.task.taskId, `fact-update:${REPORT_KEY}:1`);
  executor.started[0]!.finish({ decision: "withdrawn", reason: "The report rested on F:7 alone." });
  const late = await spawner.merge(request("late-game-reports", ROUND));
  assert.equal(late.reassess, true);
  assert.deepEqual((late.merged as JsonObject[]).map((item) => item.key), [REPORT_KEY]);
  index.noteMerge(RUN, late);
  index.closeRound(RUN, "game-report", "member-1", 2, 1);
  index.reviseReport(RUN, REPORT_KEY, report(["F:9"]));
  spawner.onDeletion(table.remove("F:9"));
  await until(() => journal(path).filter((line) => line.type === "notice").length === 2);
  assert.deepEqual(journal(path).filter((line) => line.type === "notice")[1]!.subscribers, ["none:brain:member-9"]);
  assert.equal(executor.started.length, 1);
  const quiet = await spawner.merge(request("late-game-reports", ROUND));
  assert.equal(quiet.reassess, false);
});

test("D16 a cancelled or failed run aborts its running tasks; a resume runs them again at their next merge point", { timeout: 30_000 }, async () => {
  const results = (path: string) => journal(path).filter((line) => line.type === "result")
    .map((line) => [line.taskId, line.status, line.error ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  // Cancelled: the chain task finished first; the two report tasks were running, and their executor ignores the signal.
  const first = fixture();
  seedRound(first.index);
  first.index.setIdea(RUN, "member-1", ideaCiting("F:7", "F:9"));
  const cancelled = new AbortController();
  first.spawner.bindRun(cancelled.signal);
  first.spawner.onDeletion(first.table.remove("F:7", "F:12"));
  await until(() => first.executor.started.length === 3);
  first.executor.byKey("chain:member-1")[0]!.finish(UNCHANGED_CHAIN);
  await until(() => results(first.path).length === 1);
  cancelled.abort(new WorkflowCancelledError());
  await until(() => results(first.path).length === 3);
  assert.deepEqual(results(first.path), [
    ["fact-update:chain:member-1:1", "ok", null],
    [`fact-update:${COMMENT_KEY}:1`, "error", "workflow run was cancelled"],
    [`fact-update:${REPORT_KEY}:1`, "error", "workflow run was cancelled"],
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  assert.ok([REPORT_KEY, COMMENT_KEY].every((key) => first.executor.byKey(key)[0]!.context.signal?.aborted === true),
    "the running tasks' executors see the abort");
  // A deletion after the stop journals its notice and task, and launches nothing.
  first.spawner.onDeletion(first.table.remove("F:9"));
  await until(() => journal(first.path).filter((line) => line.type === "task").length === 4);
  assert.equal(first.executor.started.length, 3);

  // A resumed process: the error results are not loaded; each task runs again at its merge point.
  const index = new FactUpdateIndex();
  seedRound(index);
  index.setIdea(RUN, "member-1", ideaCiting("F:7", "F:9"));
  const executor = new HeldExecutor();
  const { compiled } = compiledWith(index);
  const resumed = new FactUpdateSpawner({ runId: RUN, journalPath: first.path, table: first.table, compiled, executor });
  resumed.bindRun(new AbortController().signal);
  const reports = resumed.merge(request("game-reports", ROUND));
  await until(() => executor.started.length === 1);
  assert.equal(executor.started[0]!.task.taskId, `fact-update:${REPORT_KEY}:2`);
  executor.started[0]!.finish(UNCHANGED);
  assert.deepEqual((await reports).merged, [{ key: REPORT_KEY, taskId: `fact-update:${REPORT_KEY}:2`, notices: ["N:1"], output: UNCHANGED, epoch: 2 }]);
  const chain = resumed.merge(request("chain", { seat: "member-1" }));
  await until(() => executor.started.length === 2);
  assert.equal(executor.started[1]!.task.taskId, "fact-update:chain:member-1:3", "the task journaled after the stop runs now");
  executor.started[1]!.finish(UNCHANGED_CHAIN);
  assert.deepEqual(((await chain).merged as JsonObject[]).map((item) => [item.taskId, item.notices]), [["fact-update:chain:member-1:3", ["N:1", "N:2"]]]);

  // Failed, in the same process: binding the next invocation runs the stopped task again at its merge point.
  const same = fixture();
  same.index.setIdea(RUN, "member-1", ideaCiting("F:7"));
  const failed = new AbortController();
  same.spawner.bindRun(failed.signal);
  same.spawner.onDeletion(same.table.remove("F:7"));
  await until(() => same.executor.started.length === 1);
  failed.abort(new Error("the run failed at a merge point"));
  await until(() => results(same.path).length === 1);
  assert.deepEqual(results(same.path), [["fact-update:chain:member-1:1", "error", "the run failed at a merge point"]]);
  same.spawner.bindRun(new AbortController().signal);
  const again = same.spawner.merge(request("chain", { seat: "member-1" }));
  await until(() => same.executor.started.length === 2);
  assert.equal(same.executor.started[1]!.task.taskId, "fact-update:chain:member-1:2");
  same.executor.started[1]!.finish(UNCHANGED_CHAIN);
  assert.deepEqual(((await again).merged as JsonObject[]).map((item) => item.taskId), ["fact-update:chain:member-1:2"]);
});

test("a failed task fails its merge point; a journal that cannot be written stops the spawner; no task starts after the wind-down", async () => {
  const failing = fixture();
  failing.index.setIdea(RUN, "member-1", ideaCiting("F:7"));
  failing.spawner.onDeletion(failing.table.remove("F:7"));
  await until(() => failing.executor.started.length === 1);
  failing.executor.started[0]!.fail("the model refused");
  await assert.rejects(failing.spawner.merge(request("chain", { seat: "member-1" })),
    { message: "fact-update task fact-update:chain:member-1:1 failed: the model refused" });

  const path = journalPath();
  chmodSync(join(path, ".."), 0o500);
  const unwritable = fixture({ path });
  unwritable.index.setIdea(RUN, "member-1", ideaCiting("F:7"));
  unwritable.spawner.onDeletion(unwritable.table.remove("F:7"));
  await assert.rejects(unwritable.spawner.merge(request("chain", { seat: "member-1" })), /^Error: the fact-update journal could not be written: /);
  chmodSync(join(path, ".."), 0o700);

  const late = fixture({ windDown: { at: 0, reason: "the allocation ends" } });
  late.index.setIdea(RUN, "member-1", ideaCiting("F:7"));
  late.spawner.onDeletion(late.table.remove("F:7"));
  await assert.rejects(late.spawner.merge(request("chain", { seat: "member-1" })), (error: unknown) => error instanceof WindDownSignal);
  assert.equal(late.executor.started.length, 0);
});
