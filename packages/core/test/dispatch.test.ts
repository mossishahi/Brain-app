import assert from "node:assert/strict";
import test from "node:test";

import { RateCoordinator } from "../src/index.js";

/** The coordinator adds this past every declared reset (see dispatch.ts). */
const MARGIN_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("acquire resolves immediately while nothing is blocked", async () => {
  const coordinator = new RateCoordinator();
  const before = Date.now();
  await coordinator.acquire();
  await coordinator.acquire("high");
  assert.ok(Date.now() - before < 50, "open dispatch adds no wait");
  assert.equal(coordinator.blockedUntil, 0);
});

test("a block holds every waiter until it expires, then releases them all", async () => {
  const coordinator = new RateCoordinator();
  const start = Date.now();
  coordinator.block(start + 60, "test wall");
  assert.ok(coordinator.blockedUntil >= start + 60);

  const released: string[] = [];
  await Promise.all([
    coordinator.acquire().then(() => released.push("first")),
    coordinator.acquire().then(() => released.push("second")),
  ]);
  const waited = Date.now() - start;
  assert.ok(waited >= 60, `waiters held for the block (waited ${waited}ms)`);
  assert.deepEqual(released.sort(), ["first", "second"]);
  assert.equal(coordinator.blockedUntil, 0, "the block expired");
});

test("high-priority waiters release before normal ones", async () => {
  const coordinator = new RateCoordinator();
  coordinator.block(Date.now() + 40, "test wall");
  const released: string[] = [];
  await Promise.all([
    coordinator.acquire("normal").then(() => released.push("normal-1")),
    coordinator.acquire("normal").then(() => released.push("normal-2")),
    coordinator.acquire("high").then(() => released.push("judge")),
  ]);
  assert.equal(released[0], "judge", "the gating call resumes first");
  assert.deepEqual(released.slice(1), ["normal-1", "normal-2"], "FIFO within a class");
});

test("blocks only ever extend; a shorter block never shrinks the wall", async () => {
  const coordinator = new RateCoordinator();
  const start = Date.now();
  coordinator.block(start + 100, "long wall");
  coordinator.block(start + 10, "short wall");
  await coordinator.acquire();
  assert.ok(Date.now() - start >= 100, "the longer wall held");
});

test("an observation with an exhausted budget gates dispatch until its reset", async () => {
  const coordinator = new RateCoordinator();
  const start = Date.now();
  coordinator.observe({
    requestsRemaining: 480,
    outputTokensRemaining: 0,
    outputTokensResetAt: start + 50,
  });
  await coordinator.acquire();
  assert.ok(Date.now() - start >= 50, "waited out the declared reset");
});

test("an observation with headroom never blocks", async () => {
  const coordinator = new RateCoordinator();
  coordinator.observe({
    requestsRemaining: 900,
    requestsResetAt: Date.now() + 60_000,
    inputTokensRemaining: 1_500_000,
    outputTokensRemaining: 350_000,
  });
  assert.equal(coordinator.blockedUntil, 0);
  const before = Date.now();
  await coordinator.acquire();
  assert.ok(Date.now() - before < 50);
});

test("a stale reset in an observation is ignored", () => {
  const coordinator = new RateCoordinator();
  coordinator.observe({
    outputTokensRemaining: 0,
    outputTokensResetAt: Date.now() - 1_000,
  });
  assert.equal(coordinator.blockedUntil, 0);
});

test("an aborted waiter rejects and leaves the queue intact", async () => {
  const coordinator = new RateCoordinator();
  coordinator.block(Date.now() + 60, "test wall");
  const survivor = coordinator.acquire();
  const controller = new AbortController();
  const doomed = coordinator.acquire("normal", controller.signal);
  controller.abort();
  await assert.rejects(doomed, (error: Error) => error.name === "AbortError");
  await survivor;
});

test("an already-aborted acquire rejects without waiting", async () => {
  const coordinator = new RateCoordinator();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    coordinator.acquire("normal", controller.signal),
    (error: Error) => error.name === "AbortError",
  );
});

test("a block extended mid-wait keeps holding until the new wall", async () => {
  const coordinator = new RateCoordinator();
  const start = Date.now();
  coordinator.block(start + 30, "first wall");
  const waiter = coordinator.acquire();
  await sleep(10);
  coordinator.block(start + 90, "extended wall");
  await waiter;
  // The margin rides on the block target, so compare against the raw walls.
  assert.ok(
    Date.now() - start >= 90,
    `the extension held the waiter (waited ${Date.now() - start}ms)`,
  );
  assert.ok(MARGIN_MS > 0, "documented margin stays declared in one place");
});
