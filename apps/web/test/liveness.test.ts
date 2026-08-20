import assert from "node:assert/strict";
import test from "node:test";

import type { JobStatus } from "@brainstorm-agentic/protocol";
import {
  liveEntriesWhileLive,
  livenessAttrs,
  runIsLive,
} from "../src/liveness.js";

/**
 * A Record, not a list: TypeScript refuses to compile this file when a new
 * JobStatus appears, so nobody can add a status without deciding whether a run
 * in it may animate.
 */
const EXPECTED: Record<JobStatus, boolean> = {
  running: true,
  queued: false,
  paused: false,
  suspended: false,
  "credit-blocked": false,
  orphaned: false,
  completed: false,
  failed: false,
  cancelled: false,
};

test("a run is live only while something is executing", () => {
  for (const [status, live] of Object.entries(EXPECTED)) {
    assert.equal(
      runIsLive(status as JobStatus),
      live,
      `${status} should be ${live ? "live" : "still"}`,
    );
  }
});

test("pausing stills the run, resuming moves it again", () => {
  // The whole feature in one line: the same run, before and after each press.
  assert.equal(runIsLive("running"), true);
  assert.equal(runIsLive("paused"), false);
  assert.equal(runIsLive("running"), true);
});

test("the attribute carries the decision to the stylesheet", () => {
  assert.deepEqual(livenessAttrs("running"), { "data-run-live": "true" });
  assert.deepEqual(livenessAttrs("paused"), { "data-run-live": "false" });
  assert.deepEqual(livenessAttrs("completed"), { "data-run-live": "false" });
});

test("streamed text is dropped the moment the run stops moving", () => {
  const entries = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(liveEntriesWhileLive("running", entries), entries);
  assert.deepEqual(liveEntriesWhileLive("paused", entries), []);
  assert.deepEqual(liveEntriesWhileLive("cancelled", entries), []);
});
