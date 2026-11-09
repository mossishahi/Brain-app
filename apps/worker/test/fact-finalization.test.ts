import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask, JsonObject } from "@brainstorm-agentic/core";
import { factFinalizationHash, finalizeFactOutputs } from "../src/fact-finalization.js";

test("finalization reuses outputs only at the exact repaired idea and evidence revision", async () => {
  let calls = 0;
  const ideas = { member: { output: "accepted" } };
  const initial = { bridge: { checked: true }, proposal: { result: "accepted" }, epoch: 4, ideasHash: factFinalizationHash(ideas) };
  assert.deepEqual(await finalizeFactOutputs({ initial, snapshot: async () => ({ epoch: 4, ideas }),
    drain: async () => {}, buildTask: () => { throw new Error("must not rebuild"); },
    execute: async () => { calls++; return {}; } }), { bridge: initial.bridge, proposal: initial.proposal });
  assert.equal(calls, 0);
});

test("a withdrawal during synthesis repairs and regenerates both outputs before completion", async () => {
  let epoch = 0;
  let ideas: JsonObject = { member: { output: "old" } };
  let needsRepair = false;
  const calls: string[] = [];
  const tasks: AgentTask[] = [];
  const result = await finalizeFactOutputs({
    snapshot: async () => ({ epoch, ideas }),
    drain: async () => { if (needsRepair) { ideas = { member: { output: "repaired and re-reviewed" } }; needsRepair = false; } },
    buildTask: ({ stage, revision, ideas: input, bridge }) => {
      const task: AgentTask = { taskId: `${stage}:${revision}`, kind: stage, input: { ideas: input, ...(bridge ? { bridge } : {}) } };
      tasks.push(task); return task;
    },
    execute: async (task, stage) => {
      calls.push(stage);
      if (calls.length === 2) { epoch++; needsRepair = true; }
      return { basis: (task.input as JsonObject).ideas! };
    },
  });
  assert.deepEqual(calls, ["bridge", "proposal", "bridge", "proposal"]);
  assert.notEqual(tasks[0]!.taskId, tasks[2]!.taskId);
  assert.deepEqual(result.proposal.basis, ideas);
  assert.deepEqual(result.bridge.basis, ideas);
});

test("an invalidated bridge is never supplied to synthesis, even with the same deletion epoch", async () => {
  let ideas: JsonObject = { member: { output: "old" } };
  const calls: string[] = [];
  await finalizeFactOutputs({ snapshot: async () => ({ epoch: 2, ideas }), drain: async () => {},
    buildTask: ({ stage, revision }) => ({ taskId: `${stage}:${revision}`, kind: stage, input: {} }),
    execute: async (_task, stage) => {
      calls.push(stage);
      if (calls.length === 1) ideas = { member: { output: "new revision" } };
      return {};
    } });
  assert.deepEqual(calls, ["bridge", "bridge", "proposal"]);
});

test("failed repairs prevent finalization and cancellation stops the recovery loop", async () => {
  const base = { snapshot: async () => ({ epoch: 0, ideas: {} }),
    buildTask: () => ({ taskId: "t", kind: "test", input: {} }), execute: async () => ({}) };
  await assert.rejects(finalizeFactOutputs({ ...base, drain: async () => { throw new Error("re-review blocked"); } }), /re-review blocked/);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(finalizeFactOutputs({ ...base, drain: async () => {}, signal: controller.signal }), /cancelled/);
});

test("finalization hashes are stable across object key order but distinguish array ordering", () => {
  assert.equal(factFinalizationHash({ a: 1, b: { x: 2, y: 3 } }), factFinalizationHash({ b: { y: 3, x: 2 }, a: 1 }));
  assert.notEqual(factFinalizationHash([1, 2]), factFinalizationHash([2, 1]));
});
