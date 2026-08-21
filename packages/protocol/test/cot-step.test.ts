import assert from "node:assert/strict";
import test from "node:test";

import {
  COT_STEP_PARTS,
  isCotStepParts,
  type BrainIdeaView,
  type CommentView,
  type CotStepView,
  type JudgeDecisionView,
  type ReviewRoundView,
} from "../src/index.js";

const idea = (cot: readonly CotStepView[]): BrainIdeaView => ({
  type: "Research paper",
  shape: "paper",
  paper: {
    abstract: "a",
    introduction: "i",
    method: "m",
    discussion: "d",
    conclusion: "c",
  },
  cot,
});

test("a chain of strings and a chain of parts are both a BrainIdeaView", () => {
  // The whole point of the union: a run pins its bundle for life, so a chain
  // written before the parts schemas existed keeps arriving at every later
  // reader. Both must typecheck and both must project.
  const legacy = idea(["step one", "step two", "step three"]);
  const parts = idea([
    { part1: "a", part2: "b", part3: "c", part4: "d" },
    { part1: "e", part2: "f", part3: "g", part4: "h" },
  ]);
  assert.equal(legacy.cot.length, 3);
  assert.equal(parts.cot.length, 2);
});

test("the guard reads the recorded shape, not the app version", () => {
  assert.equal(isCotStepParts("step one"), false);
  assert.equal(isCotStepParts(""), false, "an empty legacy step is still a string step");
  assert.equal(isCotStepParts({ part1: "a", part2: "b", part3: "c", part4: "d" }), true);
  // Every part empty is still the parts shape: a step is never pruned away, so
  // a reader that fell back to the string branch here would render nothing at
  // all instead of four empty blocks.
  assert.equal(isCotStepParts({ part1: "", part2: "", part3: "", part4: "" }), true);
});

test("the part keys are the render order, and there are exactly four forever", () => {
  assert.deepEqual([...COT_STEP_PARTS], ["part1", "part2", "part3", "part4"]);
});

test("a round carries either step shape, and a rewrite replaces the whole step", () => {
  const legacy: ReviewRoundView = { round: 1, cot: "step one", comments: [] };
  const parts: ReviewRoundView = {
    round: 1,
    cot: { part1: "a", part2: "b", part3: "c", part4: "d" },
    comments: [],
    revision: {
      touchedSteps: [2],
      // A rewrite replaces a whole step, so all four parts ride here even when
      // only one of them changed.
      rewritten: [{ index: 2, text: { part1: "A", part2: "b", part3: "c", part4: "d" } }],
    },
  };
  assert.equal(isCotStepParts(legacy.cot ?? ""), false);
  assert.equal(isCotStepParts(parts.cot ?? ""), true);
  assert.equal(parts.revision?.rewritten?.length, 1);
});

test("a review carries a scalar step OR per-part flaws, and never needs both", () => {
  // The legacy comment pins one step and nothing finer; the part-aware one has
  // no top-level step at all, because each flaw entry carries its own.
  const legacy: CommentView = {
    commentorId: "m2",
    commentorLabel: "Seat 2",
    verdict: "Build",
    step: 2,
    reason: "the derivation skips a case",
  };
  const parts: CommentView = {
    commentorId: "m2",
    commentorLabel: "Seat 2",
    verdict: "Build",
    reason: "the derivation skips a case",
    // The empties are stripped before the record is written, so absent keys
    // are the normal case rather than the exception.
    flaws: [{ step: 2, part3: "the n = 0 case is not covered" }],
  };
  assert.equal(legacy.flaws, undefined);
  assert.equal(parts.step, undefined);
  assert.equal(parts.flaws?.[0]?.part1, undefined);
  assert.equal(parts.flaws?.[0]?.part3, "the n = 0 case is not covered");
});

test("a reviewer that found nothing carries an empty flaw list, not a missing one", () => {
  // Absent means "this run does not record parts"; empty means "this reviewer
  // was shown parts and upheld nothing". A reader that conflates them reports a
  // clean Pass as an unrendered run.
  const decision: JudgeDecisionView = {
    verdict: "Pass",
    reason: "every raised point is already addressed",
    flaws: [],
    issues: [],
    assessment: { m2: "verified" },
  };
  assert.deepEqual(decision.flaws, []);
});

test("a judge issue locates itself to a part when the run records parts", () => {
  const decision: JudgeDecisionView = {
    verdict: "Build",
    reason: "one confirmed gap",
    issues: [
      { step: 2, part: "part3", point: "the n = 0 case is not covered", basis: "verified", mustAddress: true },
      // No part: an issue from a run whose chain was one string per step.
      { step: 2, point: "the n = 0 case is not covered", basis: "authority", mustAddress: false },
    ],
    assessment: { m2: "verified" },
  };
  assert.equal(decision.issues?.[0]?.part, "part3");
  assert.equal(decision.issues?.[1]?.part, undefined);
});
