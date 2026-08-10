import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutionContext,
  AgentExecutor,
  AgentProgress,
  AgentResult,
  AgentTask,
} from "@brainstorm-agentic/core";

import {
  DEFAULT_LAUNCH_INTERVAL_MS,
  launchIntervalFor,
  StaggeredLaunchAgentExecutor,
} from "../src/launch-stagger.js";

function task(id: string): AgentTask {
  return { taskId: id, kind: "brainstorm.brain", input: { role: "brain" } };
}

const context: AgentExecutionContext = {
  runId: "run-1",
  nodePath: "root/first-pass",
};

/**
 * Virtual time for deterministic assertions. Concurrent sleeps behave like
 * real concurrent timers: each records its absolute target when it starts,
 * and `runAll` fires them in target order, advancing the clock and letting
 * every awaiter resume while the clock shows ITS wake-up time.
 */
class VirtualClock {
  time = 0;
  readonly sleeps: number[] = [];
  private readonly pending: { target: number; resolve: () => void }[] = [];

  now = (): number => this.time;

  sleep = (delayMs: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      return Promise.reject(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );
    }
    this.sleeps.push(delayMs);
    return new Promise((resolve) => {
      this.pending.push({ target: this.time + delayMs, resolve });
    });
  };

  async runAll(): Promise<void> {
    while (this.pending.length > 0) {
      this.pending.sort((a, b) => a.target - b.target);
      const next = this.pending.shift()!;
      this.time = Math.max(this.time, next.target);
      next.resolve();
      // Let the resumed awaiter finish its work before the clock moves on.
      await new Promise((settle) => setImmediate(settle));
    }
  }
}

/** Inner executor that records the virtual launch time of every task. */
function recording(clock: VirtualClock): {
  executor: AgentExecutor;
  launches: { taskId: string; at: number }[];
} {
  const launches: { taskId: string; at: number }[] = [];
  return {
    launches,
    executor: {
      execute: async (started: AgentTask): Promise<AgentResult> => {
        launches.push({ taskId: started.taskId, at: clock.now() });
        return { taskId: started.taskId, status: "ok", output: null };
      },
    },
  };
}

test("a concurrent wave launches one agent per interval, in arrival order", async () => {
  const clock = new VirtualClock();
  const { executor, launches } = recording(clock);
  const staggered = new StaggeredLaunchAgentExecutor(executor, {
    intervalMs: 10_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  const wave = Promise.all([
    staggered.execute(task("member-1"), context),
    staggered.execute(task("member-2"), context),
    staggered.execute(task("member-3"), context),
  ]);
  await clock.runAll();
  await wave;

  assert.deepEqual(launches, [
    { taskId: "member-1", at: 0 },
    { taskId: "member-2", at: 10_000 },
    { taskId: "member-3", at: 20_000 },
  ]);
});

test("the backlog cap bounds a large parallel wave's tail", async () => {
  // The parallel review fans out ~150 near-simultaneous tasks; uncapped 10s
  // spacing made the tail wait 20+ minutes (observed in production as agents
  // "waiting for 5 minutes"). Past the cap, launches proceed together and
  // the request coordinator paces the actual wire traffic.
  const clock = new VirtualClock();
  const { executor, launches } = recording(clock);
  const staggered = new StaggeredLaunchAgentExecutor(executor, {
    intervalMs: 10_000,
    maxBacklogMs: 120_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  const wave = Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      staggered.execute(task(`member-${index + 1}`), context),
    ),
  );
  await clock.runAll();
  await wave;

  // The cold ramp is still smoothed: the first twelve launches space at 10s.
  for (let index = 0; index < 12; index += 1) {
    assert.equal(launches[index]!.at, index * 10_000);
  }
  // Everything past the cap launches AT the cap, never serialized beyond it.
  const tail = launches.slice(12);
  assert.equal(tail.length, 28);
  assert.ok(tail.every((launch) => launch.at === 120_000));
});

test("a lone task after a quiet stretch launches immediately", async () => {
  const clock = new VirtualClock();
  const { executor, launches } = recording(clock);
  const staggered = new StaggeredLaunchAgentExecutor(executor, {
    intervalMs: 10_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  await staggered.execute(task("first"), context);
  // The pipeline is between waves: far more than one interval passes.
  clock.time = 60_000;
  await staggered.execute(task("later"), context);

  assert.deepEqual(launches, [
    { taskId: "first", at: 0 },
    { taskId: "later", at: 60_000 },
  ]);
  assert.deepEqual(clock.sleeps, [], "no launch ever had to wait");
});

test("waiting tasks report a status progress event; immediate ones stay silent", async () => {
  const clock = new VirtualClock();
  const { executor } = recording(clock);
  const staggered = new StaggeredLaunchAgentExecutor(executor, {
    intervalMs: 10_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  const progress: AgentProgress[] = [];
  const reporting: AgentExecutionContext = {
    ...context,
    reportProgress: (update) => progress.push(update),
  };

  const wave = Promise.all([
    staggered.execute(task("member-1"), reporting),
    staggered.execute(task("member-2"), reporting),
  ]);
  await clock.runAll();
  await wave;

  assert.equal(progress.length, 1, "only the delayed launch reports");
  assert.equal(progress[0]!.kind, "status");
  assert.match(progress[0]!.message, /Launch staggered: starting in 10s/);
});

test("an aborted task never takes a slot's wait and never reaches the inner executor", async () => {
  const clock = new VirtualClock();
  const { executor, launches } = recording(clock);
  const staggered = new StaggeredLaunchAgentExecutor(executor, {
    intervalMs: 10_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    staggered.execute(task("cancelled"), { ...context, signal: controller.signal }),
    (error: Error) => error.name === "AbortError",
  );
  assert.deepEqual(launches, []);
});

test("an abort during the wait cancels the launch instead of running it", async () => {
  const clock = new VirtualClock();
  const { executor, launches } = recording(clock);
  const staggered = new StaggeredLaunchAgentExecutor(executor, {
    intervalMs: 10_000,
    now: clock.now,
    // The wait itself is interrupted, exactly like the real abortable sleep.
    sleep: () =>
      Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
  });

  const first = staggered.execute(task("member-1"), context);
  await assert.rejects(
    staggered.execute(task("member-2"), context),
    (error: Error) => error.name === "AbortError",
  );
  await first;
  assert.deepEqual(launches, [{ taskId: "member-1", at: 0 }]);
});

test("rejects a negative or non-finite interval", () => {
  const { executor } = recording(new VirtualClock());
  assert.throws(() => new StaggeredLaunchAgentExecutor(executor, { intervalMs: -1 }));
  assert.throws(
    () => new StaggeredLaunchAgentExecutor(executor, { intervalMs: Number.NaN }),
  );
});

test("launch intervals default per provider and an explicit value always wins", () => {
  assert.equal(
    launchIntervalFor({ provider: "anthropic" }),
    DEFAULT_LAUNCH_INTERVAL_MS,
  );
  assert.equal(
    launchIntervalFor({ provider: "claude-agent" }),
    DEFAULT_LAUNCH_INTERVAL_MS,
  );
  assert.equal(launchIntervalFor({ provider: "offline" }), 0);
  assert.equal(
    launchIntervalFor({ provider: "anthropic", launchIntervalMs: 0 }),
    0,
    "an explicit zero disables the stagger",
  );
  assert.equal(
    launchIntervalFor({ provider: "offline", launchIntervalMs: 5_000 }),
    5_000,
    "an explicit interval applies even offline",
  );
});
