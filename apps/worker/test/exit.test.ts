import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_GRACE_MS, scheduleFinishedExit } from "../src/exit.js";

test("the finished-exit watchdog never holds the loop open itself", () => {
  // If it were ref'd, every healthy worker would sit out the whole grace
  // period before exiting — which is the opposite of the point.
  const timer = scheduleFinishedExit({ exit: () => {}, log: () => {}, graceMs: 60_000 });
  assert.equal(timer.hasRef(), false);
  clearTimeout(timer);
});

test("a worker still alive after the grace period is made to exit with its own code", async () => {
  // The live failure this exists for: the run failed as a RESULT, the command
  // set exitCode 1 and returned, and an abandoned child pipe kept the process
  // alive for thirteen hours — long enough for its SLURM job to look healthy
  // and for a second worker to be started over the same workspace.
  const previous = process.exitCode;
  process.exitCode = 1;
  const held = setInterval(() => {}, 1_000); // stands in for the leaked handle
  try {
    const codes: number[] = [];
    const lines: string[] = [];
    scheduleFinishedExit({
      exit: (code) => codes.push(code),
      log: (message) => lines.push(message),
      graceMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(codes, [1], "it exited with the code the run had set");
    assert.match(
      lines[0] ?? "",
      /still alive; exiting with code 1\. Handles still open: .+/,
      "and named what was holding it, so the next hang needs no debugger",
    );
  } finally {
    clearInterval(held);
    process.exitCode = previous;
  }
});

test("the grace period is generous against a walltime but not against a run", () => {
  assert.ok(EXIT_GRACE_MS >= 10_000, "long enough to drain a network filesystem");
  assert.ok(EXIT_GRACE_MS <= 60_000, "short enough that a dead worker is noticed");
});
