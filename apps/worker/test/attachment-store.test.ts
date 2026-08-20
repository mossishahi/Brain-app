import assert from "node:assert/strict";
import test from "node:test";

import { manifestPathFor } from "../src/attachment-store.js";

const CONVENTIONAL = "/w/jobs/job-1/attachments/manifest.json";
const events = "/w/jobs/job-1/events.jsonl";
const onDisk = (...paths: string[]) => (path: string) => paths.includes(path);

test("what the launcher named is what the run reads", () => {
  assert.deepEqual(
    manifestPathFor("/elsewhere/manifest.json", events, onDisk(CONVENTIONAL)),
    { path: "/elsewhere/manifest.json", recovered: false },
    "an explicit store must never be second-guessed, even when another one is beside the events file",
  );
});

test("a forgetful launcher does not cost the run its files", () => {
  assert.deepEqual(
    manifestPathFor(undefined, events, onDisk(CONVENTIONAL)),
    { path: CONVENTIONAL, recovered: true },
  );
});

test("a run with no store of its own recovers nothing", () => {
  assert.equal(
    manifestPathFor(undefined, events, onDisk()),
    undefined,
    "a topic-only run has no attachments, and inventing a path would make the broker lie the other way",
  );
});

test("with nothing to go on, nothing is guessed", () => {
  assert.equal(manifestPathFor(undefined, undefined, onDisk(CONVENTIONAL)), undefined);
});
