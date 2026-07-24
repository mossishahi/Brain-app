import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject, RunEvent } from "../src/index.js";
import {
  InMemoryCheckpointStore,
  WorkflowFunctions,
  WorkflowRunner,
  activity,
  condition,
  humanGate,
  parallel,
  sequence,
  terminal,
  workflow,
} from "../src/index.js";

function gatedDefinition() {
  return workflow(
    "gated",
    sequence(
      [
        activity("prepare", { id: "prep", resultKey: "prep" }),
        humanGate({ id: "approvalGate", gateKey: "approval", prompt: "Approve the draft?", resultKey: "approval" }),
        condition(
          "approved",
          terminal("success", { id: "ok", outputFrom: "summary" }),
          terminal("failure", { id: "no", reason: "reviewer rejected the draft" }),
          { id: "verdict" },
        ),
      ],
      { id: "main" },
    ),
  );
}

test("humanGate suspends the run, persists a checkpoint, and resume replays without re-executing effects", async () => {
  const checkpoints = new InMemoryCheckpointStore();
  let prepareRuns = 0;
  const buildFunctions = () =>
    new WorkflowFunctions()
      .registerActivity("prepare", () => {
        prepareRuns += 1;
        return "prepared";
      })
      .registerCondition("approved", (scope) => (scope.get("approval") as JsonObject).approved === true)
      .registerSelector("summary", (scope) => ({
        prep: scope.get("prep") as string,
        approval: scope.get("approval") as JsonObject,
      }));

  const events: RunEvent[] = [];
  const runnerA = new WorkflowRunner({
    functions: buildFunctions(),
    checkpoints,
    onEvent: (event) => events.push(event),
  });

  const first = await runnerA.run(gatedDefinition(), { runId: "run-gated" });
  assert.equal(first.status, "suspended");
  if (first.status !== "suspended") throw new Error("unreachable");
  assert.equal(first.pendingGates.length, 1);
  assert.equal(first.pendingGates[0]!.gateKey, "approval");
  assert.equal(first.pendingGates[0]!.prompt, "Approve the draft?");
  assert.equal(prepareRuns, 1);

  const suspended = await checkpoints.load("run-gated");
  assert.equal(suspended?.status, "suspended");
  assert.equal(suspended?.pendingGates.length, 1);
  assert.ok(events.some((event) => event.type === "gate:pending"));
  assert.ok(events.some((event) => event.type === "run:suspended"));

  // Fresh runner over the same store simulates recovery in a new process.
  const runnerB = new WorkflowRunner({ functions: buildFunctions(), checkpoints });
  const second = await runnerB.resume(gatedDefinition(), "run-gated", {
    responses: { approval: { approved: true, note: "ship it" } },
  });
  assert.equal(second.status, "completed");
  assert.deepEqual(second.status === "completed" && second.output, {
    prep: "prepared",
    approval: { approved: true, note: "ship it" },
  });
  // The prepare activity was replayed from the journal, not re-executed.
  assert.equal(prepareRuns, 1);
  const final = await checkpoints.load("run-gated");
  assert.equal(final?.status, "completed");
});

test("resume can reject through the gate and take the failure branch", async () => {
  const checkpoints = new InMemoryCheckpointStore();
  const functions = new WorkflowFunctions()
    .registerActivity("prepare", () => "prepared")
    .registerCondition("approved", (scope) => (scope.get("approval") as JsonObject).approved === true)
    .registerSelector("summary", (scope) => scope.get("prep"));
  const runner = new WorkflowRunner({ functions, checkpoints });

  const first = await runner.run(gatedDefinition(), { runId: "run-rejected" });
  assert.equal(first.status, "suspended");
  const second = await runner.resume(gatedDefinition(), "run-rejected", {
    responses: { approval: { approved: false } },
  });
  assert.equal(second.status, "failed");
  assert.match(second.status === "failed" ? second.error.message : "", /reviewer rejected/);
});

test("parallel gates merge into one suspension and can be answered incrementally", async () => {
  const checkpoints = new InMemoryCheckpointStore();
  const definition = workflow(
    "twoGates",
    parallel(
      [
        humanGate({ id: "gateA", gateKey: "a", prompt: "A?" }),
        humanGate({ id: "gateB", gateKey: "b", prompt: "B?" }),
      ],
      { id: "gates" },
    ),
  );
  const runner = new WorkflowRunner({ checkpoints });

  const first = await runner.run(definition, { runId: "run-two-gates" });
  assert.equal(first.status, "suspended");
  if (first.status !== "suspended") throw new Error("unreachable");
  assert.deepEqual(
    first.pendingGates.map((gate) => gate.gateKey),
    ["a", "b"],
  );

  const second = await runner.resume(definition, "run-two-gates", { responses: { a: "yes" } });
  assert.equal(second.status, "suspended");
  if (second.status !== "suspended") throw new Error("unreachable");
  assert.deepEqual(
    second.pendingGates.map((gate) => gate.gateKey),
    ["b"],
  );

  const third = await runner.resume(definition, "run-two-gates", { responses: { b: "also yes" } });
  assert.equal(third.status, "completed");
  assert.deepEqual(third.status === "completed" && third.output, ["yes", "also yes"]);
});

test("answering an unknown gate is rejected", async () => {
  const checkpoints = new InMemoryCheckpointStore();
  const definition = workflow("oneGate", humanGate({ id: "g", gateKey: "real" }));
  const runner = new WorkflowRunner({ checkpoints });
  const first = await runner.run(definition, { runId: "run-unknown-gate" });
  assert.equal(first.status, "suspended");
  await assert.rejects(
    () => runner.resume(definition, "run-unknown-gate", { responses: { bogus: 1 } }),
    /no pending gate "bogus"/,
  );
});

test("aborting the signal cancels the run; resume continues past the recorded prefix", async () => {
  const checkpoints = new InMemoryCheckpointStore();
  let fastRuns = 0;
  let blockMode: "hang" | "instant" = "hang";
  let blockedStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    blockedStarted = resolve;
  });
  const functions = new WorkflowFunctions()
    .registerActivity("fast", () => {
      fastRuns += 1;
      return "fast-done";
    })
    .registerActivity("slow", async () => {
      if (blockMode === "instant") return "slow-done";
      blockedStarted();
      return await new Promise<never>(() => {}); // hangs until the runner aborts
    });

  const definition = workflow(
    "cancellable",
    sequence(
      [
        activity("fast", { id: "first", resultKey: "a" }),
        activity("slow", { id: "second", resultKey: "b" }),
        terminal("success", { id: "end", output: "all-done" }),
      ],
      { id: "main" },
    ),
  );

  const controller = new AbortController();
  const events: string[] = [];
  const runner = new WorkflowRunner({ functions, checkpoints, onEvent: (event) => events.push(event.type) });
  const runPromise = runner.run(definition, { runId: "run-cancel", signal: controller.signal });
  await started;
  controller.abort();

  const result = await runPromise;
  assert.equal(result.status, "cancelled");
  assert.ok(events.includes("run:cancelled"));
  assert.equal(fastRuns, 1);

  const checkpoint = await checkpoints.load("run-cancel");
  assert.equal(checkpoint?.status, "cancelled");
  assert.ok(checkpoint!.journal.some((entry) => entry.key.includes("first")));
  assert.ok(!checkpoint!.journal.some((entry) => entry.key.includes("second")));

  // Resume after cancellation: the journaled prefix replays, new work runs.
  blockMode = "instant";
  const resumed = await runner.resume(definition, "run-cancel");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.status === "completed" && resumed.output, "all-done");
  assert.equal(fastRuns, 1, "fast activity must be replayed from the journal, not re-executed");
});

test("a pre-aborted signal cancels before any node executes", async () => {
  let runs = 0;
  const functions = new WorkflowFunctions().registerActivity("never", () => {
    runs += 1;
    return null;
  });
  const definition = workflow("preAborted", activity("never", { id: "n" }));
  const controller = new AbortController();
  controller.abort();
  const result = await new WorkflowRunner({ functions }).run(definition, { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(runs, 0);
});
