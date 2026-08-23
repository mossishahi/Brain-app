import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_THOUGHT_SLICE_CHARS,
  sliceThoughtsBySteps,
} from "../src/thought-slices.js";

// ---------------------------------------------------------------------------
// The chunk boundaries are the model's own submit_step calls: step k's slice
// is every thinking segment after the previous submitted step's turn, up to
// and including step k's own turn.
// ---------------------------------------------------------------------------

test("each step takes the segments between the previous submission and its own", () => {
  const slices = sliceThoughtsBySteps(
    [
      { turn: 1, text: "planning the whole treatment" },
      { turn: 2, text: "working out the first claim" },
      { turn: 3, text: "checking the second claim" },
      { turn: 4, text: "settling the third claim" },
    ],
    [
      { index: 1, turn: 2 },
      { index: 2, turn: 3 },
      { index: 3, turn: 4 },
    ],
  );
  assert.deepEqual(slices, [
    // The preamble — the plan, per the thought-anchors picture the most
    // load-bearing part — belongs to the first step.
    { step: 1, text: "planning the whole treatment\n\nworking out the first claim" },
    { step: 2, text: "checking the second claim" },
    { step: 3, text: "settling the third claim" },
  ]);
});

test("steps submitted in one turn share that turn's segments", () => {
  const slices = sliceThoughtsBySteps(
    [{ turn: 2, text: "thinking that produced both steps at once" }],
    [
      { index: 1, turn: 2 },
      { index: 2, turn: 2 },
    ],
  );
  assert.equal(slices[0]!.text, "thinking that produced both steps at once");
  // Attributing a shared turn any more finely would be invention, so the
  // sibling reads the same segments rather than "thought about nothing".
  assert.equal(slices[1]!.text, slices[0]!.text);
});

test("segments after the last submitted step belong to no step", () => {
  const slices = sliceThoughtsBySteps(
    [
      { turn: 1, text: "the step's thinking" },
      { turn: 5, text: "composing the result body" },
    ],
    [{ index: 1, turn: 1 }],
  );
  assert.deepEqual(slices, [{ step: 1, text: "the step's thinking" }]);
});

test("a sparse patch slices between its own submissions, whatever steps it names", () => {
  // A redevelopment submits only the steps it rewrote — here 2 and 5 — and
  // the reviser's thinking between those submissions belongs to the LATER one.
  const slices = sliceThoughtsBySteps(
    [
      { turn: 1, text: "reading the confirmed issues" },
      { turn: 3, text: "repairing the later step" },
    ],
    [
      { index: 2, turn: 2 },
      { index: 5, turn: 4 },
    ],
  );
  assert.deepEqual(slices, [
    { step: 2, text: "reading the confirmed issues" },
    { step: 5, text: "repairing the later step" },
  ]);
});

test("no recorded thinking yields empty slices, never an error", () => {
  const slices = sliceThoughtsBySteps(undefined, [
    { index: 1, turn: 1 },
    { index: 2, turn: 2 },
  ]);
  assert.deepEqual(slices, [
    { step: 1, text: "" },
    { step: 2, text: "" },
  ]);
});

test("no submitted steps yields no slices at all", () => {
  assert.deepEqual(sliceThoughtsBySteps([{ turn: 1, text: "orphan thinking" }], []), []);
  assert.deepEqual(sliceThoughtsBySteps([{ turn: 1, text: "orphan thinking" }], undefined), []);
});

test("slices come back in step order even when submission order differed", () => {
  const slices = sliceThoughtsBySteps(
    [
      { turn: 1, text: "first submission's thinking" },
      { turn: 2, text: "second submission's thinking" },
    ],
    [
      // A hand-assembled record may list them out of order; the turn decides
      // the slicing, the step number decides the output order.
      { index: 4, turn: 1 },
      { index: 2, turn: 2 },
    ],
  );
  assert.deepEqual(
    slices.map((slice) => slice.step),
    [2, 4],
  );
  assert.equal(slices[1]!.text, "first submission's thinking");
  assert.equal(slices[0]!.text, "second submission's thinking");
});

test("a pathological trace is capped, with the cut named", () => {
  const slices = sliceThoughtsBySteps(
    [{ turn: 1, text: "x".repeat(MAX_THOUGHT_SLICE_CHARS + 5_000) }],
    [{ index: 1, turn: 1 }],
  );
  const text = slices[0]!.text;
  assert.ok(text.length < MAX_THOUGHT_SLICE_CHARS + 100, "the journal copy is bounded");
  assert.ok(text.endsWith("[thoughts truncated]"), "the cut is named, never silent");
});

test("malformed segments and step turns contribute nothing", () => {
  const slices = sliceThoughtsBySteps(
    [
      { turn: 1, text: "kept" },
      { turn: "2", text: "dropped: turn is not a number" },
      { text: "dropped: no turn" },
      null,
      { turn: 1, text: "" },
    ],
    [{ index: 1, turn: 1 }, { index: "2", turn: 2 }, "not an object"],
  );
  assert.deepEqual(slices, [{ step: 1, text: "kept" }]);
});
