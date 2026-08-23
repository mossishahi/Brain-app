import assert from "node:assert/strict";
import test from "node:test";

import { Scope, type JsonObject } from "@brainstorm-agentic/core";

import { applyRedevelopment, applyThoughts } from "../src/index.js";

// ---------------------------------------------------------------------------
// applyThoughts: the thinking behind each step, folded into the run state
// ---------------------------------------------------------------------------

/** A run mid-flight: a three-step chain for one seat, thoughts not yet written. */
function baseState(): JsonObject {
  return {
    params: { maxReviewRounds: 4 },
    input: { cotSteps: 3, type: "research idea" },
    ideas: {
      "member-1": {
        output: {
          type: "research idea",
          paper: {
            abstract: ["a1", "a2", "a3"],
            introduction: ["i1", "i2", "i3"],
            method: ["m1", "m2", "m3"],
            discussion: ["d1", "d2", "d3"],
            conclusion: ["c1"],
          },
        },
        cot: ["step one text", "step two text", "step three text"],
      },
    },
    reviews: { "member-1": { current: { comments: {} } } },
    reviewLog: {},
    thoughts: {},
  };
}

function memberScope(stepIndex?: number): Scope {
  const scope = Scope.root();
  scope.set("member", { id: "member-1" });
  if (stepIndex !== undefined) scope.set("stepIndex", stepIndex);
  return scope;
}

function thoughtsOf(state: JsonObject): readonly string[] {
  return (state.thoughts as JsonObject)["member-1"] as string[];
}

test("a first pass fills the whole array, empty where nothing was recorded", () => {
  const next = applyThoughts(
    baseState(),
    memberScope(),
    {
      stepThoughts: [
        { step: 1, text: "weighing the framing of step one" },
        { step: 3, text: "settling the claim of step three" },
      ],
    },
    "develop",
  );
  assert.deepEqual(thoughtsOf(next), [
    "weighing the framing of step one",
    "",
    "settling the claim of step three",
  ]);
});

test("a first pass with no captured trace still writes the array, all empty", () => {
  // Providers may withhold the channel entirely (offline, display omitted):
  // the array must exist so a bundle that binds thoughts always resolves.
  const next = applyThoughts(baseState(), memberScope(), null, "develop");
  assert.deepEqual(thoughtsOf(next), ["", "", ""]);
});

test("a redevelopment replaces exactly the touched steps' thoughts", () => {
  const developed = applyThoughts(
    baseState(),
    memberScope(),
    {
      stepThoughts: [
        { step: 1, text: "first-pass thoughts for step one" },
        { step: 2, text: "first-pass thoughts for step two" },
        { step: 3, text: "first-pass thoughts for step three" },
      ],
    },
    "develop",
  );
  // The applied patch rewrites step 2; applyRedevelopment stashes the
  // change-set the thoughts fold then reads — the same order the compiler's
  // store fold runs the two in.
  const patched = applyRedevelopment(
    developed,
    memberScope(2),
    { steps: [{ index: 2, text: "step two, repaired" }] },
    "redevelop-idea",
    "patch",
  );
  const next = applyThoughts(
    patched,
    memberScope(2),
    { stepThoughts: [{ step: 2, text: "the reviser's thinking behind the repair" }] },
    "redevelop",
  );
  assert.deepEqual(thoughtsOf(next), [
    "first-pass thoughts for step one",
    "the reviser's thinking behind the repair",
    "first-pass thoughts for step three",
  ]);
});

test("a touched step whose reviser recorded nothing goes empty, never stale", () => {
  const developed = applyThoughts(
    baseState(),
    memberScope(),
    { stepThoughts: [{ step: 2, text: "thoughts about text that is about to change" }] },
    "develop",
  );
  const patched = applyRedevelopment(
    developed,
    memberScope(2),
    { steps: [{ index: 2, text: "step two, repaired" }] },
    "redevelop-idea",
    "patch",
  );
  // The old thoughts describe text that no longer exists; keeping them would
  // hand reviewers notes about a step nobody wrote.
  const next = applyThoughts(patched, memberScope(2), null, "redevelop");
  assert.equal(thoughtsOf(next)[1], "");
  assert.equal(thoughtsOf(next)[0], "", "untouched steps keep their entries");
});

test("a patch that changed nothing leaves every step's thoughts standing", () => {
  const developed = applyThoughts(
    baseState(),
    memberScope(),
    { stepThoughts: [{ step: 1, text: "original thinking" }] },
    "develop",
  );
  const patched = applyRedevelopment(
    developed,
    memberScope(1),
    { steps: [{ index: 1, text: "step one text" }] },
    "redevelop-idea",
    "patch",
  );
  const next = applyThoughts(
    patched,
    memberScope(1),
    { stepThoughts: [{ step: 1, text: "the reviser thought, but rewrote nothing" }] },
    "redevelop",
  );
  // touched is empty, so the original author still owns the step's thoughts.
  assert.equal(thoughtsOf(next)[0], "original thinking");
});

test("a scope with no member resolves to no write at all", () => {
  const state = baseState();
  const next = applyThoughts(state, Scope.root(), { stepThoughts: [] }, "develop");
  assert.deepEqual(next, state);
});

test("the fold is deterministic: replaying the same inputs rebuilds the same array", () => {
  const metadata = {
    stepThoughts: [
      { step: 1, text: "one" },
      { step: 2, text: "two" },
    ],
  };
  const first = applyThoughts(baseState(), memberScope(), metadata, "develop");
  const second = applyThoughts(baseState(), memberScope(), metadata, "develop");
  assert.deepEqual(first, second);
});
