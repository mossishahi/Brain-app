import assert from "node:assert/strict";
import test from "node:test";

import type { LiveTextEntry } from "@brainstorm-agentic/protocol";

import { applyLiveEntries, type LiveThread } from "../src/components/live-threads.js";

const empty: ReadonlyMap<string, LiveThread> = new Map();

test("appends build one continuous thread the reader can follow", () => {
  // The whole reason this is not a rolling tail: the reader is meant to be able
  // to read what the model has been saying, as prose, from where they came in.
  let live = applyLiveEntries(empty, [{ id: "t1", append: "I am reading " }]);
  live = applyLiveEntries(live, [{ id: "t1", append: "step five " }]);
  live = applyLiveEntries(live, [{ id: "t1", append: "of seat four's chain." }]);
  assert.equal(live.get("t1")?.text, "I am reading step five of seat four's chain.");
});

test("a whole-text frame replaces, so a dropped frame repairs itself", () => {
  let live = applyLiveEntries(empty, [{ id: "t1", append: "corrupted by a gap" }]);
  live = applyLiveEntries(live, [{ id: "t1", text: "the whole thread, as the server has it" }]);
  assert.equal(live.get("t1")?.text, "the whole thread, as the server has it");
});

test("a thread is deleted when its task's output exists", () => {
  // Not archived, not greyed out: deleted. From that moment the page shows the
  // output, and this text was only ever the wait.
  let live = applyLiveEntries(empty, [
    { id: "t1", append: "thinking", actorId: "member-2", seatId: "member-4", role: "Commenter" },
  ]);
  assert.equal(live.size, 1);
  live = applyLiveEntries(live, [{ id: "t1", ended: true }]);
  assert.equal(live.size, 0);
  assert.equal(live.get("t1"), undefined);
});

test("who is talking travels with the thread, so a card can claim it", () => {
  const entry: LiveTextEntry = {
    id: "t1",
    append: "…",
    role: "Commenter",
    actor: "Seat 2",
    actorId: "member-2",
    seatId: "member-4",
    where: { seat: "Seat 4", step: 5, round: 3 },
  };
  const live = applyLiveEntries(empty, [entry]);
  assert.deepEqual(live.get("t1"), {
    text: "…",
    role: "Commenter",
    actor: "Seat 2",
    actorId: "member-2",
    seatId: "member-4",
    where: { seat: "Seat 4", step: 5, round: 3 },
  });
});

test("an empty frame changes nothing, identically", () => {
  const live = applyLiveEntries(empty, [{ id: "t1", append: "a" }]);
  assert.equal(applyLiveEntries(live, []), live, "the same map, so React re-renders nothing");
});
