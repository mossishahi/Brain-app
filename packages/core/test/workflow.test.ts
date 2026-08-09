import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutor,
  AgentTask,
  CheckpointStore,
  JsonArray,
  JsonValue,
  WorkflowCheckpoint,
  WorkflowNode,
} from "../src/index.js";
import {
  CreditBlockedError,
  InMemoryCheckpointStore,
  WorkflowFunctions,
  WorkflowRunner,
  activity,
  agent,
  createBuiltinExecutorRegistry,
  forEach,
  parallel,
  reduce,
  repeatUntil,
  sequence,
  terminal,
  workflow,
} from "../src/index.js";

test("nested member -> step -> round semantics", async () => {
  const log: string[] = [];
  const functions = new WorkflowFunctions()
    .registerCollection("members", (scope) => scope.get("members") as JsonArray)
    .registerCondition("twoRounds", (scope) => (scope.get("round") as number) >= 1)
    .registerActivity("draft", (_input, scope) => {
      const member = scope.get("member") as string;
      const round = scope.get("round") as number;
      log.push(`r${round}:${member}:draft`);
      return `${member}:r${round}`;
    })
    .registerActivity("refine", (_input, scope) => {
      const member = scope.get("member") as string;
      const round = scope.get("round") as number;
      log.push(`r${round}:${member}:refine`);
      // Reads the draft step's result from the member's isolated frame.
      return `${scope.get("draftText")}:refined`;
    })
    .registerActivity("appendRound", (_input, scope) => {
      const previous = (scope.get("rounds") as JsonArray | undefined) ?? [];
      return [...previous, scope.get("roundResults") as JsonValue];
    })
    .registerSelector("roundsOut", (scope) => scope.get("rounds"));

  const definition = workflow(
    "brainstorm",
    sequence(
      [
        repeatUntil({
          id: "roundLoop",
          condition: "twoRounds",
          maxIterations: 5,
          iterationVar: "round",
          // Last body result (the accumulated rounds array) flows out of the
          // loop frame into the enclosing scope under "rounds".
          resultKey: "rounds",
          body: sequence(
            [
              forEach({
                id: "panel",
                itemsFrom: "members",
                itemVar: "member",
                indexVar: "memberIndex",
                concurrency: 2,
                resultKey: "roundResults",
                body: sequence(
                  [
                    activity("draft", { id: "draft", resultKey: "draftText" }),
                    activity("refine", { id: "refine" }),
                  ],
                  { id: "steps" },
                ),
              }),
              activity("appendRound", { id: "collect", resultKey: "rounds" }),
            ],
            { id: "roundBody" },
          ),
        }),
        terminal("success", { id: "done", outputFrom: "roundsOut" }),
      ],
      { id: "main" },
    ),
  );

  const runner = new WorkflowRunner({ functions });
  const result = await runner.run(definition, { input: { members: ["alice", "bob", "carol"] } });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" && result.output, [
    ["alice:r0:refined", "bob:r0:refined", "carol:r0:refined"],
    ["alice:r1:refined", "bob:r1:refined", "carol:r1:refined"],
  ]);

  // 2 rounds x 3 members x 2 steps.
  assert.equal(log.length, 12);
  // Step semantics: each member drafts before it refines, in every round.
  for (const round of [0, 1]) {
    for (const member of ["alice", "bob", "carol"]) {
      const draftIndex = log.indexOf(`r${round}:${member}:draft`);
      const refineIndex = log.indexOf(`r${round}:${member}:refine`);
      assert.ok(draftIndex >= 0 && refineIndex >= 0, `missing steps for r${round}:${member}`);
      assert.ok(draftIndex < refineIndex, `r${round}:${member} refined before drafting`);
    }
  }
  // Round semantics: all round-0 work finishes before any round-1 work starts.
  const lastRound0 = Math.max(...log.map((entry, index) => (entry.startsWith("r0:") ? index : -1)));
  const firstRound1 = Math.min(
    ...log.map((entry, index) => (entry.startsWith("r1:") ? index : Number.POSITIVE_INFINITY)),
  );
  assert.ok(lastRound0 < firstRound1, "round 1 started before round 0 completed");
});

test("repeatUntil enforces maxIterations with onMaxIterations: fail", async () => {
  let bodyRuns = 0;
  const functions = new WorkflowFunctions()
    .registerCondition("never", () => false)
    .registerActivity("step", () => {
      bodyRuns += 1;
      return bodyRuns;
    });

  const definition = workflow(
    "boundedLoop",
    repeatUntil({
      id: "loop",
      condition: "never",
      maxIterations: 3,
      body: activity("step", { id: "step" }),
    }),
  );

  const result = await new WorkflowRunner({ functions }).run(definition);
  assert.equal(result.status, "failed");
  assert.ok(result.status === "failed" && result.error.name === "MaxIterationsExceededError");
  assert.match(result.status === "failed" ? result.error.message : "", /maxIterations=3/);
  assert.equal(bodyRuns, 3);
});

test("repeatUntil with onMaxIterations: continue stops cleanly at the bound", async () => {
  let bodyRuns = 0;
  const functions = new WorkflowFunctions()
    .registerCondition("never", () => false)
    .registerActivity("step", () => {
      bodyRuns += 1;
      return `run-${bodyRuns}`;
    });

  const definition = workflow(
    "boundedLoopContinue",
    repeatUntil({
      id: "loop",
      condition: "never",
      maxIterations: 3,
      onMaxIterations: "continue",
      body: activity("step", { id: "step" }),
    }),
  );

  const result = await new WorkflowRunner({ functions }).run(definition);
  assert.equal(result.status, "completed");
  assert.equal(result.status === "completed" && result.output, "run-3");
  assert.equal(bodyRuns, 3);
});

test("parallel fanout respects the concurrency bound and preserves branch order", async () => {
  let active = 0;
  let maxActive = 0;
  const functions = new WorkflowFunctions().registerActivity("work", async (input) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return input ?? null;
  });

  const definition = workflow(
    "fanout",
    parallel(
      [0, 1, 2, 3, 4, 5].map((index) => activity("work", { id: `w${index}`, input: index })),
      { id: "burst", concurrency: 2 },
    ),
  );

  const result = await new WorkflowRunner({ functions }).run(definition);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" && result.output, [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2, `expected exactly 2 branches in flight, saw ${maxActive}`);
});

test("unbounded parallel truly fans out (all branches start before any finishes)", async () => {
  let started = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const functions = new WorkflowFunctions().registerActivity("meet", async (input) => {
    started += 1;
    if (started === 3) release();
    await barrier; // deadlocks unless all three branches run concurrently
    return input ?? null;
  });

  const definition = workflow(
    "barrier",
    parallel([
      activity("meet", { id: "a", input: "a" }),
      activity("meet", { id: "b", input: "b" }),
      activity("meet", { id: "c", input: "c" }),
    ]),
  );

  const result = await new WorkflowRunner({ functions }).run(definition);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" && result.output, ["a", "b", "c"]);
});

test("checkpoint writes coalesce under parallel bursts, latest wins with the full journal", async () => {
  // A store whose writes block until released: while one write is on its way
  // to disk, a burst of branch saves must collapse into one follow-up write
  // instead of queueing a full-journal serialization per branch.
  const written: WorkflowCheckpoint[] = [];
  const pendingWrites: Array<() => void> = [];
  let gated = false;
  let onWrite: (() => void) | undefined;
  const checkpoints: CheckpointStore = {
    async save(checkpoint) {
      written.push(structuredClone(checkpoint));
      onWrite?.();
      if (gated) {
        await new Promise<void>((release) => pendingWrites.push(release));
      }
    },
    async load() {
      return undefined;
    },
    async delete() {},
  };

  let startedBranches = 0;
  let releaseBranches!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBranches = resolve;
  });
  const functions = new WorkflowFunctions().registerActivity("burst", async (input) => {
    // The initial "running" write has already landed by the time branches
    // run, so gating from here targets exactly the branch-save burst.
    gated = true;
    startedBranches += 1;
    if (startedBranches === 3) releaseBranches();
    await barrier; // all three branches record their effects together
    return input ?? null;
  });

  const definition = workflow(
    "coalesce",
    parallel([
      activity("burst", { id: "a", input: "a" }),
      activity("burst", { id: "b", input: "b" }),
      activity("burst", { id: "c", input: "c" }),
    ]),
  );

  const secondWrite = new Promise<void>((resolve) => {
    onWrite = () => {
      if (written.length === 2) resolve();
    };
  });
  const running = new WorkflowRunner({ functions, checkpoints }).run(definition);
  await secondWrite; // the first branch save is now in flight — and blocked
  // Let the remaining branches file their save requests against it.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  gated = false;
  for (const release of pendingWrites.splice(0)) release();
  const result = await running;

  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" && result.output, ["a", "b", "c"]);

  // Uncoalesced, this run writes 5 checkpoints: running, one per branch,
  // completed. The burst behind the blocked write must collapse.
  assert.ok(
    written.length <= 4,
    `expected the branch saves to coalesce, saw ${written.length} writes`,
  );
  // Durability equivalence: the last write is the terminal one and carries
  // every branch's journal entry; sequence and journal only ever grow.
  const last = written.at(-1)!;
  assert.equal(last.status, "completed");
  const values = last.journal.map((entry) => entry.value);
  for (const value of ["a", "b", "c"]) {
    assert.ok(values.includes(value), `journal on disk is missing branch "${value}"`);
  }
  for (let i = 1; i < written.length; i += 1) {
    assert.ok(written[i]!.seq > written[i - 1]!.seq, "checkpoint seq stays monotonic");
    assert.ok(
      written[i]!.journal.length >= written[i - 1]!.journal.length,
      "a later write never carries less journal than an earlier one",
    );
  }
});

test("agent nodes build tasks by name and route them through the AgentExecutor", async () => {
  const seenTasks: AgentTask[] = [];
  const agentExecutor: AgentExecutor = {
    async execute(task, context) {
      seenTasks.push(task);
      context.reportProgress?.({
        kind: "tool_start",
        toolName: "WebSearch",
        message: "Searching the web",
      });
      return {
        taskId: task.taskId,
        status: "ok",
        output: { echoed: task.input },
        usage: { inputTokens: 3, outputTokens: 5 },
      };
    },
  };
  const functions = new WorkflowFunctions().registerTaskBuilder("makeTask", (scope, params) => ({
    kind: "echo",
    agentId: "panelist-1",
    input: { topic: scope.get("topic") as JsonValue, params: params ?? null },
  }));

  const definition = workflow("agentic", agent("makeTask", { id: "echoAgent", params: { style: "brief" } }));
  const eventTypes: string[] = [];
  const runner = new WorkflowRunner({ functions, agentExecutor, onEvent: (event) => eventTypes.push(event.type) });
  const result = await runner.run(definition, { input: { topic: "fusion" } });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" && result.output, {
    echoed: { topic: "fusion", params: { style: "brief" } },
  });
  assert.equal(seenTasks.length, 1);
  assert.equal(seenTasks[0]!.kind, "echo");
  assert.ok(seenTasks[0]!.taskId.includes("echoAgent"));
  assert.ok(eventTypes.includes("agent:started"));
  assert.ok(eventTypes.includes("agent:progress"));
  assert.ok(eventTypes.includes("agent:completed"));
});

test("credit-blocked agents checkpoint and resume without journaling partial output", async () => {
  const checkpoints = new InMemoryCheckpointStore();
  const functions = new WorkflowFunctions().registerTaskBuilder("creditTask", () => ({
    kind: "credit.test",
    input: {},
  }));
  let blocked = true;
  const executor: AgentExecutor = {
    async execute(task) {
      if (blocked) {
        throw new CreditBlockedError(
          Date.parse("2026-07-22T15:31:00.000Z"),
          "session limit resets 5:30pm",
          "deterministic",
        );
      }
      return { taskId: task.taskId, status: "ok", output: { resumed: true } };
    },
  };
  const definition = workflow("credit", agent("creditTask", { id: "work" }));
  const runner = new WorkflowRunner({ functions, agentExecutor: executor, checkpoints });
  const first = await runner.run(definition, { runId: "credit-run" });
  assert.equal(first.status, "credit_blocked");
  const checkpoint = await checkpoints.load("credit-run");
  assert.equal(checkpoint?.status, "credit_blocked");
  assert.equal(checkpoint?.journal.length, 0);
  assert.equal(
    checkpoint?.creditBlock?.retryAt,
    Date.parse("2026-07-22T15:31:00.000Z"),
  );

  blocked = false;
  const resumed = await runner.resume(definition, "credit-run");
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.status === "completed" && resumed.output, {
    resumed: true,
  });
});

test("custom node kinds can be registered on the executor registry", async () => {
  const executors = createBuiltinExecutorRegistry().register("echo", async (node) => {
    return (node as WorkflowNode & { readonly value: JsonValue }).value;
  });
  const definition = workflow("custom", { kind: "echo", id: "e1", value: 42 } as WorkflowNode);
  const result = await new WorkflowRunner({ executors }).run(definition);
  assert.equal(result.status, "completed");
  assert.equal(result.status === "completed" && result.output, 42);
});

test("running with an existing runId is rejected; checkpoints accumulate journal entries", async () => {
  const checkpoints = new InMemoryCheckpointStore();
  const functions = new WorkflowFunctions().registerActivity("noop", () => "ok");
  const definition = workflow("dupes", activity("noop", { id: "n" }));
  const runner = new WorkflowRunner({ functions, checkpoints });
  const result = await runner.run(definition, { runId: "fixed-id" });
  assert.equal(result.status, "completed");
  await assert.rejects(() => runner.run(definition, { runId: "fixed-id" }), /already has a checkpoint/);
  const saved = await checkpoints.load("fixed-id");
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.journal.length, 1);
});

test("reduce threads an accumulator sequentially and supports one-based indices", async () => {
  const visited: number[] = [];
  const functions = new WorkflowFunctions()
    .registerCollection("numbers", () => [2, 3, 5])
    .registerSelector("zero", () => 0)
    .registerSelector("nextTotal", (scope) => scope.get("total"))
    .registerActivity("add", (_input, scope) => {
      const index = scope.get("position") as number;
      visited.push(index);
      return (scope.get("total") as number) + (scope.get("number") as number);
    });
  const definition = workflow(
    "fold",
    reduce({
      id: "sum",
      itemsFrom: "numbers",
      itemVar: "number",
      indexVar: "position",
      indexBase: 1,
      accumulatorVar: "total",
      initialFrom: "zero",
      body: activity("add", { id: "add", resultKey: "total" }),
      nextFrom: "nextTotal",
      resultKey: "sum",
    }),
  );

  const result = await new WorkflowRunner({ functions }).run(definition);
  assert.equal(result.status, "completed");
  assert.equal(result.status === "completed" && result.output, 10);
  assert.deepEqual(visited, [1, 2, 3]);
});
