import assert from "node:assert/strict";
import test from "node:test";

import type {
  CotStepView,
  ReviewMemberView,
  ReviewRoundView,
  ReviewStepView,
} from "@brainstorm-agentic/protocol";

import {
  computeSeatTimeline,
  crossEntryKey,
  deckEntries,
  diffWords,
  reviewedBy,
  roundViewKey,
  seatTimeline,
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

  // A card is a VERSION. Rounds 1 and 2 each rewrote the step, so each wrote
  // one; round 3 passed without rewriting, so it wrote none and gets no card
  // — its review rides the version it actually read.
  assert.deepEqual(
    deck.map((entry) => entry.kind),
    ["original", "round", "round"],
  );
  assert.ok(
    !deck.some((entry) => entry.kind === "round" && entry.round.round === 3),
    "a round that wrote no new version has no card repeating the previous text",
  );

  // The whole point: round 1 reviewed the ORIGINAL, so its comments belong to
  // the base card — not to the card showing what round 1 then wrote in reply.
  assert.equal(reviewedBy(deck, 0)?.round, 1, "the original was reviewed by round 1");
  assert.equal(reviewedBy(deck, 1)?.round, 2, "round 1's output was reviewed by round 2");
  assert.equal(
    reviewedBy(deck, 2)?.round,
    3,
    "the standing version carries the review that closed the position",
  );
});

test("every round's review is shown exactly once, on some card", () => {
  // Dropping cards must not drop reviews: each round read some version, and
  // that version's card is where its comments belong.
  const step = threeRoundStep();
  const timeline = computeSeatTimeline(seat([step]), ["v0 original"]);
  const deck = deckEntries(step, timeline);
  const shown = deck
    .map((_, index) => reviewedBy(deck, index)?.round)
    .filter((n): n is number => n !== undefined);
  assert.deepEqual(shown, [1, 2, 3], "each round appears once, in order");
});

test("every card's review is the one that read that card's own text", () => {
  // Stated as the invariant rather than as positions: whatever card index we
  // ask about, the review attached to it must have been recorded against the
  // exact text that card displays.
  const step = threeRoundStep();
  const member = seat([step]);
  const timeline = computeSeatTimeline(member, ["v0 original"]);
  const deck = deckEntries(step, timeline);

  // The step shape is the union now: this walk records strings, and the
  // assertion below is unchanged — only the annotation had to widen with it.
  const textOf = (index: number): CotStepView | undefined => {
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
  // Each segment is an exact SLICE of the later version, so concatenating
  // every segment reproduces it — the renderer rebuilds no whitespace.
  assert.equal(segments.map((s) => s.text).join(""), "the bound fails here");
  assert.ok(
    segments.some((s) => s.changed && s.text.includes("fails")),
    "the replaced word is marked changed",
  );
  assert.ok(
    segments.some((s) => !s.changed && s.text.includes("bound")),
    "carried words are not",
  );
});

/** A step text of `words` tokens, with `edits` of them replaced. */
function longText(words: number, edits: readonly number[]): string {
  const out: string[] = [];
  for (let k = 0; k < words; k += 1) {
    out.push(edits.includes(k) ? `replacement${k}` : `word${k % 400}`);
    // Clause punctuation every ninth token, so the anchored fallback has the
    // breaks real prose gives it.
    if (k % 9 === 8) out[out.length - 1] += ";";
  }
  return out.join(" ");
}

function changedFraction(segments: readonly { text: string; changed: boolean }[]): number {
  const count = (only: boolean): number =>
    segments
      .filter((s) => s.changed === only)
      .reduce((n, s) => n + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
  return count(true) / (count(true) + count(false));
}

test("a long version's changes are marked, not the whole card", () => {
  // The reported bug: a step's text grows with every redevelopment, and past a
  // flat token ceiling the diff gave up and marked EVERY word changed — which
  // renders as a card with no dimming at all, i.e. no diff. These are the
  // sizes late rounds actually reach.
  const before = longText(1600, []);
  const after = longText(1600, [500, 501, 900]);
  const segments = diffWords(before, after);
  assert.equal(segments.map((s) => s.text).join(""), after, "the text is reproduced exactly");
  assert.ok(
    changedFraction(segments) < 0.05,
    `only the edits are marked changed, not the card (was ${changedFraction(segments)})`,
  );
  assert.ok(
    segments.some((s) => s.changed && s.text.includes("replacement500")),
    "the replaced words are the ones marked",
  );
});

test("versions too large to align word by word still diff by clause", () => {
  // Past the exact LCS budget the anchored fallback takes over: clauses match
  // first, then each gap between two matched clauses is diffed on its own.
  const before = `opening ${longText(2400, [])} closing`;
  const after = `different ${longText(2400, [1200, 1201])} ending`;
  const segments = diffWords(before, after);
  assert.equal(segments.map((s) => s.text).join(""), after, "the text is reproduced exactly");
  assert.ok(
    changedFraction(segments) < 0.05,
    `the fallback still marks only what changed (was ${changedFraction(segments)})`,
  );
  assert.ok(
    segments.some((s) => s.changed && s.text.includes("replacement1200")),
    "including an edit in the middle of the range",
  );
});

test("a version's own spacing survives the diff", () => {
  const before = "one two\nthree  four";
  const after = "one TWO\nthree  four";
  const segments = diffWords(before, after);
  assert.equal(segments.map((s) => s.text).join(""), after);
});

test("a seat's timeline is reused until its recorded text changes", () => {
  // The panel re-renders on every progress event of a live run; recomputing
  // the timeline each time would discard the diffs already computed for the
  // cards on screen.
  const first = seatTimeline(seat([threeRoundStep()]), ["v0 original"]);
  assert.equal(
    seatTimeline(seat([threeRoundStep()]), ["v0 original"]),
    first,
    "an unchanged seat gets the same timeline back",
  );

  const withFourth: ReviewStepView = {
    ...threeRoundStep(),
    rounds: [
      ...threeRoundStep().rounds.slice(0, 2),
      round(3, "v2 after second repair", {
        verdict: "Build",
        rewrote: [{ index: 1, text: "v3 after a third repair" }],
      }),
    ],
  };
  assert.notEqual(
    seatTimeline(seat([withFourth]), ["v0 original"]),
    first,
    "a round that landed invalidates it",
  );
});

test("a rewrite that preserves length still invalidates the timeline", () => {
  // A fingerprint of the text, not its length: same shape, same lengths, one
  // different word.
  const step = (text: string): ReviewStepView => ({
    index: 1,
    outcome: "passed",
    rounds: [round(1, "v0 original", { verdict: "Build", rewrote: [{ index: 1, text }] })],
  });
  const before = seatTimeline(
    { memberId: "member-len", label: "Seat 9", steps: [step("aaaa bbbb")] },
    ["v0 original"],
  );
  assert.notEqual(
    seatTimeline(
      { memberId: "member-len", label: "Seat 9", steps: [step("aaaa cccc")] },
      ["v0 original"],
    ),
    before,
  );
});

test("the origin card's link names a card the affected step actually has", () => {
  // The one-line note on the round that caused a rewrite links into the
  // AFFECTED step's deck. If the two sides ever built that key differently the
  // link would silently open nothing, so the key has one definition and this
  // is the assertion that it lands.
  const stepOne: ReviewStepView = {
    index: 1,
    outcome: "passed",
    rounds: [
      round(1, "step one v0", {
        verdict: "Build",
        rewrote: [
          { index: 1, text: "step one v1" },
          { index: 2, text: "step two, rewritten from position 1" },
        ],
      }),
    ],
  };
  const stepTwo: ReviewStepView = { index: 2, outcome: "pending", rounds: [] };
  const timeline = computeSeatTimeline(
    { memberId: "member-jump", label: "Seat 2", steps: [stepOne, stepTwo] },
    ["step one v0", "step two v0"],
  );

  const origin = timeline.rounds.get(roundViewKey(1, 1));
  assert.deepEqual(
    origin?.crossChanges.map((change) => change.index),
    [2],
    "the round records the rewrite it applied to the other step",
  );
  const target = crossEntryKey(1, 1);
  assert.ok(
    deckEntries(stepTwo, timeline).some((entry) => entry.key === target),
    `step 2's deck has the card the link opens (${target})`,
  );
});

test("every version is a round, whoever wrote it, numbered in order", () => {
  // The complaint this answers: a step whose deck already showed three
  // prospective edits had a header reading "round 1 in progress", because only
  // the review loop's own iterations were counted. An edit is an edit.
  const stepOne: ReviewStepView = {
    index: 1,
    outcome: "passed",
    rounds: [
      // Position 1 rewrites step 2 twice before step 2's review ever opens.
      round(1, "one v0", {
        verdict: "Build",
        rewrote: [
          { index: 1, text: "one v1" },
          { index: 2, text: "two, edited from position 1" },
        ],
      }),
      round(2, "one v1", {
        verdict: "Build",
        rewrote: [
          { index: 1, text: "one v2" },
          { index: 2, text: "two, edited again from position 1" },
        ],
      }),
      round(3, "one v2", { verdict: "Pass" }),
    ],
  };
  const stepTwo: ReviewStepView = {
    index: 2,
    outcome: "passed",
    rounds: [
      round(1, "two, edited again from position 1", {
        verdict: "Build",
        rewrote: [{ index: 2, text: "two, after its own first review" }],
      }),
      round(2, "two, after its own first review", { verdict: "Pass" }),
    ],
  };
  const member = { memberId: "member-1", label: "Seat 1", steps: [stepOne, stepTwo] };
  const timeline = computeSeatTimeline(member, ["one v0", "two v0"]);

  const deck = deckEntries(stepTwo, timeline);
  // Two prospective edits, then the step's own first review — which is therefore
  // the THIRD edit of this step, not the first.
  assert.deepEqual(
    deck.map((entry) => [entry.kind, entry.editRound]),
    [
      ["original", undefined],
      ["cross", 1],
      ["cross", 2],
      ["round", 3],
    ],
    "the base card is not an edit; every version after it is a numbered round",
  );

  // And the step that WAS the editor numbers its own versions the same way.
  assert.deepEqual(
    deckEntries(stepOne, timeline).map((entry) => [entry.kind, entry.editRound]),
    [
      ["original", undefined],
      ["round", 1],
      ["round", 2],
    ],
  );
});

test("a round that rewrote nothing takes no number", () => {
  // It is another review of the card before it, not a new version — and a
  // numbered card the pager cannot justify is what made "Round 3 / 4" wrong.
  const step: ReviewStepView = {
    index: 1,
    outcome: "passed",
    rounds: [
      round(1, "v0", { verdict: "Build", rewrote: [{ index: 1, text: "v1" }] }),
      // Round 2 reviews v1 and rewrites a DIFFERENT step, so it writes no
      // version here; round 3 then reads v1 again.
      round(2, "v1", { verdict: "Build", rewrote: [{ index: 9, text: "elsewhere" }] }),
      round(3, "v1", { verdict: "Pass" }),
    ],
  };
  const timeline = computeSeatTimeline(seat([step]), ["v0"]);
  const deck = deckEntries(step, timeline);
  assert.deepEqual(
    deck.map((entry) => [entry.kind, entry.editRound]),
    [
      ["original", undefined],
      ["round", 1],
      ["round", undefined],
    ],
  );
  // Every round's review is still shown exactly once — the unnumbered card is
  // carrying one.
  const shown = deck
    .map((_, index) => reviewedBy(deck, index)?.round)
    .filter((n): n is number => n !== undefined);
  assert.deepEqual(shown, [1, 2, 3]);
});
