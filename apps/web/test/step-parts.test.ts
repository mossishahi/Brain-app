import assert from "node:assert/strict";
import test from "node:test";

import type {
  CotStepPartsView,
  CotStepView,
  ReviewMemberView,
  ReviewRoundView,
  ReviewStepView,
} from "@brainstorm-agentic/protocol";

import { partLabel, stepPlainText, stepTextBlocks } from "../src/steps.js";
import {
  computeSeatTimeline,
  deckEntries,
  diffStep,
  roundViewKey,
  seatTimeline,
} from "../src/components/panels/review-diff.js";

function parts(
  part1: string,
  part2 = "",
  part3 = "",
  part4 = "",
): CotStepPartsView {
  return { part1, part2, part3, part4 };
}

function round(
  n: number,
  cot: CotStepView,
  options: {
    readonly verdict?: "Pass" | "Build" | "Interrupt";
    readonly rewrote?: { readonly index: number; readonly text: CotStepView }[];
  } = {},
): ReviewRoundView {
  const touched = (options.rewrote ?? []).map((entry) => entry.index);
  return {
    round: n,
    cot,
    comments: [],
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

function seat(memberId: string, steps: ReviewStepView[]): ReviewMemberView {
  return { memberId, label: "Seat 1", steps };
}

test("a step recorded as one string still renders as one unlabelled block", () => {
  // Every run started before the chain had parts recorded a step this way, and
  // a job pins its bundle for life — so this shape has to keep working forever.
  assert.deepEqual(stepTextBlocks("one whole step"), [{ text: "one whole step" }]);
});

test("a part-aware step renders as four labelled blocks, in order", () => {
  const blocks = stepTextBlocks(parts("first", "second", "third", "fourth"));
  assert.deepEqual(
    blocks.map((block) => [block.part, block.text]),
    [
      ["part1", "first"],
      ["part2", "second"],
      ["part3", "third"],
      ["part4", "fourth"],
    ],
  );
  assert.equal(partLabel("part3"), "part 3", "the number is the whole label");
});

test("an all-empty four-part step is still four blocks", () => {
  // A step is never pruned away, and the empty-string case is legal in the
  // schema — falling back to the string branch here would render nothing at
  // all where the reader must see four empty boxes.
  const blocks = stepTextBlocks(parts("", "", "", ""));
  assert.equal(blocks.length, 4);
  assert.deepEqual(
    blocks.map((block) => block.text),
    ["", "", "", ""],
  );
});

test("the diff aligns part1 to part1, never to the whole step", () => {
  // The point of the per-part diff: the same sentence moved from part1 into
  // part2 is a change in BOTH places. Diffing the four parts as one string
  // would find every word carried and dim the move out of existence.
  const before = parts("the bound holds", "", "", "");
  const after = parts("", "the bound holds", "", "");
  const blocks = diffStep(before, after);
  assert.deepEqual(
    blocks.map((block) => block.part),
    ["part1", "part2", "part3", "part4"],
  );
  assert.ok(
    blocks[1]!.segments.every((segment) => segment.changed),
    "the words are new where they landed",
  );
});

test("a rewrite of one part leaves the other three carried", () => {
  const before = parts("kept as written", "the bound holds here", "third", "fourth");
  const after = parts("kept as written", "the bound fails here", "third", "fourth");
  const blocks = diffStep(before, after);
  for (const index of [0, 2, 3]) {
    assert.ok(
      blocks[index]!.segments.every((segment) => !segment.changed),
      `part${index + 1} was not touched and renders dimmed`,
    );
  }
  const second = blocks[1]!.segments;
  assert.equal(
    second.map((segment) => segment.text).join(""),
    "the bound fails here",
    "the block reassembles its part exactly, spacing included",
  );
  assert.ok(
    second.some((segment) => segment.changed && segment.text.includes("fails")),
    "the replaced word is marked changed",
  );
  assert.ok(
    second.some((segment) => !segment.changed && segment.text.includes("bound")),
    "and the words around it are not",
  );
});

test("a long part keeps its highlighting — there is no token ceiling", () => {
  // The same guarantee the whole-step diff carries: a version's length never
  // costs it its dimming, and a part grows with every redevelopment.
  const words = (count: number, edits: readonly number[]): string => {
    const out: string[] = [];
    for (let k = 0; k < count; k += 1) {
      out.push(edits.includes(k) ? `replacement${k}` : `word${k % 400}`);
      if (k % 9 === 8) out[out.length - 1] += ";";
    }
    return out.join(" ");
  };
  const blocks = diffStep(parts(words(1600, [])), parts(words(1600, [700, 701])));
  const changed = blocks[0]!.segments
    .filter((segment) => segment.changed)
    .flatMap((segment) => segment.text.trim().split(/\s+/))
    .filter(Boolean);
  assert.ok(changed.length < 20, `only the edits are marked (was ${changed.length})`);
  assert.ok(changed.some((word) => word.includes("replacement700")));
});

test("a round card of a part-aware walk carries one block per part", () => {
  const step: ReviewStepView = {
    index: 1,
    outcome: "passed",
    rounds: [
      round(1, parts("opening", "the bound holds here", "", ""), {
        verdict: "Build",
        rewrote: [{ index: 1, text: parts("opening", "the bound fails here", "", "") }],
      }),
      round(2, parts("opening", "the bound fails here", "", ""), { verdict: "Pass" }),
    ],
  };
  const timeline = computeSeatTimeline(seat("member-parts", [step]), [
    parts("opening", "the bound holds here", "", ""),
  ]);
  const computed = timeline.rounds.get(roundViewKey(1, 1));
  assert.deepEqual(
    computed?.blocks.map((block) => block.part),
    ["part1", "part2", "part3", "part4"],
  );
  assert.ok(
    computed?.blocks[0]!.segments.every((segment) => !segment.changed),
    "the untouched part is dimmed on the card the redevelopment wrote",
  );
  assert.ok(
    computed?.blocks[1]!.segments.some((segment) => segment.changed),
    "and the rewritten part carries the full weight",
  );

  // The base card is the first-pass step itself, in the shape it was recorded.
  const deck = deckEntries(step, timeline);
  const base = deck[0];
  assert.equal(base?.kind, "original");
  assert.deepEqual(
    base?.kind === "original" ? stepTextBlocks(base.text).map((b) => b.part) : [],
    ["part1", "part2", "part3", "part4"],
  );
});

test("a round that rewrote nothing renders every part carried", () => {
  const step: ReviewStepView = {
    index: 1,
    outcome: "passed",
    rounds: [
      round(1, parts("a", "b", "c", "d"), {
        verdict: "Build",
        rewrote: [{ index: 2, text: parts("elsewhere") }],
      }),
    ],
  };
  const timeline = computeSeatTimeline(seat("member-unchanged", [step]), [
    parts("a", "b", "c", "d"),
    parts("two"),
  ]);
  const computed = timeline.rounds.get(roundViewKey(1, 1));
  assert.deepEqual(
    computed?.blocks.map((block) => block.part),
    ["part1", "part2", "part3", "part4"],
  );
  assert.ok(
    computed?.blocks.every((block) =>
      block.segments.every((segment) => !segment.changed),
    ),
    "nothing changed this round, so nothing carries full weight",
  );
});

test("words moved between parts invalidate the seat's timeline", () => {
  // The signature is taken part by part: moving the same words from part1 into
  // part2 leaves their concatenation identical, and the deck would otherwise
  // keep serving diffs computed against the version before the move.
  const step = (text: CotStepView): ReviewStepView => ({
    index: 1,
    outcome: "passed",
    rounds: [round(1, parts("v0"), { verdict: "Build", rewrote: [{ index: 1, text }] })],
  });
  const first = seatTimeline(seat("member-moved", [step(parts("the bound holds", ""))]), [
    parts("v0"),
  ]);
  assert.notEqual(
    seatTimeline(seat("member-moved", [step(parts("", "the bound holds"))]), [parts("v0")]),
    first,
  );
});

test("a step is copied as prose, its parts as paragraphs", () => {
  // A pasted bug report has no card under it, so the part boundaries survive
  // as paragraph breaks and nothing else.
  assert.equal(stepPlainText(parts("first", "second", "", "")), "first\n\nsecond");
  assert.equal(stepPlainText("one whole step"), "one whole step");
});
