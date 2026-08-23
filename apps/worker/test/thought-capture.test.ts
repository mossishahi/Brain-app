import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryArtifactStore,
  type AgentResult,
  type AgentTask,
  type JsonObject,
} from "@brainstorm-agentic/core";

import { OfflineBrainstormExecutor } from "../src/offline-executor.js";
import { ThinkingArtifactAgentExecutor } from "../src/wiring.js";

function task(role: string, schemaName: string, bindings: JsonObject): AgentTask {
  return {
    taskId: `capture-${role}`,
    kind: role,
    agentId: "member-1",
    input: { role, bindings },
    outputSchema: { name: schemaName, schema: {} },
  };
}

const context = { runId: "run-1", nodePath: "root/first-pass/member[0]/develop-idea-execute" };

// ---------------------------------------------------------------------------
// the offline executor's synthetic trace
// ---------------------------------------------------------------------------

test("the offline first pass records a trace in the shape the real backends capture", async () => {
  const result = await new OfflineBrainstormExecutor().execute(
    task("brain", "brainIdeaParts", { input: {} }),
  );
  assert.ok(result.status === "ok");
  const metadata = result.metadata as JsonObject;
  const segments = metadata.thinkingSegments as JsonObject[];
  const turns = metadata.stepTurns as JsonObject[];
  assert.equal(segments.length, 3, "one synthetic segment per chain step");
  assert.deepEqual(
    turns.map((entry) => entry.index),
    [1, 2, 3],
  );
});

test("the offline patch reviser records a trace for exactly the step it rewrites", async () => {
  const result = await new OfflineBrainstormExecutor().execute(
    task("redeveloper", "redevelopmentPatchParts", { currentStep: 2, input: {} }),
  );
  assert.ok(result.status === "ok");
  const metadata = result.metadata as JsonObject;
  assert.deepEqual(
    (metadata.stepTurns as JsonObject[]).map((entry) => entry.index),
    [2],
  );
});

// ---------------------------------------------------------------------------
// the wrapper: raw trace to the artifact, sliced thoughts to the journal
// ---------------------------------------------------------------------------

function fakeInner(result: AgentResult) {
  return { execute: async () => result };
}

test("the wrapper strips the raw trace, keeps the per-step slices, and files the artifact", async () => {
  const artifacts = new InMemoryArtifactStore();
  const executor = new ThinkingArtifactAgentExecutor(
    fakeInner({
      taskId: "capture-brain",
      status: "ok",
      output: { anything: true },
      metadata: {
        providerId: "offline",
        thinkingSegments: [
          { turn: 1, text: "thinking behind step one" },
          { turn: 2, text: "thinking behind step two" },
        ],
        stepTurns: [
          { index: 1, turn: 1 },
          { index: 2, turn: 2 },
        ],
      },
    }),
    artifacts,
  );
  const result = await executor.execute(task("brain", "brainIdeaParts", {}), context);
  assert.ok(result.status === "ok");
  const metadata = result.metadata as JsonObject;

  // The raw segments never reach the journaled result — checkpoints stay
  // bounded — while the SLICED projection does: it is what the runtime folds
  // into the run's `thoughts` state, and state must rebuild from the journal
  // alone.
  assert.equal(metadata.thinkingSegments, undefined);
  assert.equal(metadata.stepTurns, undefined);
  assert.equal(metadata.providerId, "offline", "unrelated metadata rides through");
  assert.deepEqual(metadata.stepThoughts, [
    { step: 1, text: "thinking behind step one" },
    { step: 2, text: "thinking behind step two" },
  ]);

  // The full trace keeps living in the per-task artifact, untruncated.
  const stored = await artifacts.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.metadata?.kind, "thinking");
  const payload = JSON.parse((await artifacts.get(stored[0]!.id))!.data) as JsonObject;
  assert.equal((payload.segments as unknown[]).length, 2);
});

test("a result without a trace passes through the wrapper untouched", async () => {
  const artifacts = new InMemoryArtifactStore();
  const executor = new ThinkingArtifactAgentExecutor(
    fakeInner({
      taskId: "capture-judge",
      status: "ok",
      output: { verdict: "Pass" },
      metadata: { providerId: "offline" },
    }),
    artifacts,
  );
  const result = await executor.execute(task("judge", "judgeDecisionParts", {}), context);
  assert.ok(result.status === "ok");
  assert.deepEqual(result.metadata, { providerId: "offline" });
  assert.equal((await artifacts.list()).length, 0, "no artifact for no trace");
});

test("wrapped end to end, the offline first pass journals ready-to-fold slices", async () => {
  const artifacts = new InMemoryArtifactStore();
  const executor = new ThinkingArtifactAgentExecutor(
    new OfflineBrainstormExecutor(),
    artifacts,
  );
  const result = await executor.execute(
    task("brain", "brainIdeaParts", { input: {} }),
    context,
  );
  assert.ok(result.status === "ok");
  const slices = (result.metadata as JsonObject).stepThoughts as JsonObject[];
  assert.deepEqual(
    slices.map((slice) => slice.step),
    [1, 2, 3],
  );
  for (const slice of slices) {
    assert.ok(
      (slice.text as string).includes("offline deterministic thoughts"),
      "each step carries its own synthetic slice",
    );
  }
});
