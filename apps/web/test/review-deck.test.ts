import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReviewMemberView,
  ReviewRoundView,
  ReviewStepView,
} from "@brainstorm-agentic/protocol";

import {
  computeSeatTimeline,
  deckEntries,
  diffWords,
  reviewedBy,
  roundViewKey,
} from "../src/components/panels/review-diff.js";

function round(
  n: number,
  cot: string,
  options: {
    readonly verdict?: "Pass" | "Build" | "Interrupt";
    readonly rewrote?: { readonly index: number; readonly text: string }[];
  } = {},
): ReviewRoundView {
  const touched = (options.rewrote ?? []).map((entry) => entry.index);
  return {
    round: n,
    cot,
    comments: [
      {
        commentorId: `c-${n}`,
        commentorLabel: `Seat ${n}`,
        verdict: options.verdict ?? "Pass",
        reason: `reason recorded in round ${n}`,
      },
    ],
    ...(options.verdict
      ? {
          decision: {
            verdict: options.verdict,
            reason: `judgement of round ${n}`,
            assessment: {},
          },
        }
      : {}),
    ...(options.rewrote
      ? { revision: { touchedSteps: touched, rewritten: options.rewrote } }
      : {}),
  };
}

function seat(steps: ReviewStepView[]): ReviewMemberView {
  return { memberId: "member-1", label: "Seat 1", steps };
}

/**
 * A walk position that took three rounds: two repairs, then a pass. Round k
 * comments on the text it was HANDED and only then redevelops, so each
 * round's `cot` is the version the previous round left standing.
 */
function threeRoundStep(): ReviewStepView {
  return {
    index: 1,
    outcome: "passed",
    rounds: [
      round(1, "v0 original", {
        verdict: "Build",
        rewrote: [{ index: 1, text: "v1 after first repair" }],
      }),
      round(2, "v1 after first repair", {
        verdict: "Interrupt",
        rewrote: [{ index: 1, text: "v2 after second repair" }],
      }),
      round(3, "v2 after second repair", { verdict: "Pass" }),
    ],
  };
}

test("a round's comments belong to the card showing the text it was handed", () => {
  const step = threeRoundStep();
  const member = seat([step]);
  const timeline = computeSeatTimeline(member, ["v0 original"]);
  const deck = deckEntries(step, timeline);

  // Original thought, then one card per round.
  assert.deepEqual(
    deck.map((entry) => entry.kind),
    ["original", "round", "round", "round"],
  );

  // The whole point: round 1 reviewed the ORIGINAL, so its comments belong to
  // the base card — not to the card showing what round 1 then wrote in reply.
  assert.equal(reviewedBy(deck, 0)?.round, 1, "the original was reviewed by round 1");
  assert.equal(reviewedBy(deck, 1)?.round, 2, "round 1's output was reviewed by round 2");
  assert.equal(reviewedBy(deck, 2)?.round, 3, "round 2's output was reviewed by round 3");
  assert.equal(
    reviewedBy(deck, 3),
    undefined,
    "the version the walk left standing has not been reviewed by anything",
  );
});

test("every card's review is the one that read that card's own text", () => {
  // Stated as the invariant rather than as positions: whatever card index we
  // ask about, the review attached to it must have been recorded against the
  // exact text that card displays.
  const step = threeRoundStep();
  const member = seat([step]);
  const timeline = computeSeatTimeline(member, ["v0 original"]);
  const deck = deckEntries(step, timeline);

  const textOf = (index: number): string | undefined => {
    const entry = deck[index]!;
    if (entry.kind === "original") return entry.text;
    if (entry.kind === "round") {
      return timeline.rounds.get(roundViewKey(step.index, entry.round.round))?.outText;
    }
    return undefined;
  };

  for (let i = 0; i < deck.length; i += 1) {
    const review = reviewedBy(deck, i);
    if (review === undefined) continue;
    assert.equal(
      review.cot,
      textOf(i),
      `card ${i}'s review was recorded against the text that card shows`,
    );
  }
});

test("a step nobody has reviewed yet has no deck at all", () => {
  const step: ReviewStepView = { index: 2, outcome: "pending", rounds: [] };
  const timeline = computeSeatTimeline(seat([step]), ["only text"]);
  assert.deepEqual(deckEntries(step, timeline), []);
});

test("word diff marks only what the later version changed", () => {
  const segments = diffWords("the bound holds here", "the bound fails here");
  // Each segment is one space-joined RUN of same-status words; the single
  // space between runs is re-inserted by the renderer, so reassembling the
  // sentence joins on a space rather than concatenating.
  assert.equal(segments.map((s) => s.text).join(" "), "the bound fails here");
  assert.ok(
    segments.some((s) => s.changed && s.text.includes("fails")),
    "the replaced word is marked changed",
  );
  assert.ok(
    segments.some((s) => !s.changed && s.text.includes("bound")),
    "carried words are not",
  );
});
