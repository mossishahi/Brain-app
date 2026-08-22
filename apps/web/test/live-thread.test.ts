import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { LiveTextEntry } from "@brainstorm-agentic/protocol";

import {
  MAX_REVEAL_LAG_CHARS,
  applyLiveEntries,
  liveDestinations,
  pendingReviewers,
  revealStep,
  type LiveThread,
} from "../src/components/live-threads.js";

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

/* ------------------------------------------------- the pace of the reveal */

test("text is revealed as writing, not in the chunks it arrives in", () => {
  // The complaint this answers: a frame delivers about a second of writing at
  // once, and appending it whole makes the thread land in visible jumps —
  // several lines, then nothing. Paced, one frame's backlog takes many steps.
  const target = 200;
  let shown = 0;
  let steps = 0;
  while (shown < target && steps < 500) {
    shown = revealStep(shown, target, 16); // one animation frame
    steps += 1;
  }
  assert.equal(shown, target, "it does arrive, in full");
  assert.ok(steps > 8, `a frame's words take many steps to appear, not one (took ${steps})`);
});

test("a bigger backlog is revealed faster, and the display never trails far", () => {
  // Falling behind must not compound. Catch-up is proportional, which alone
  // approaches zero asymptotically — so a reader handed a large block (a tab in
  // a background window, where animation frames stop) would otherwise watch it
  // type for many seconds after the model had moved on.
  assert.ok(
    revealStep(0, 10_000, 16) > revealStep(0, 100, 16) * 10,
    "ten times the backlog reveals far more per frame",
  );
  assert.ok(
    revealStep(0, 50_000, 16) >= 50_000 - MAX_REVEAL_LAG_CHARS,
    "and a backlog past the lag bound is skipped to within it in one step",
  );
  // From the bound, the rest is paced: still many steps, still bounded time.
  let shown = 50_000 - MAX_REVEAL_LAG_CHARS;
  let elapsed = 0;
  let steps = 0;
  while (shown < 50_000 && elapsed < 10_000) {
    shown = revealStep(shown, 50_000, 16);
    elapsed += 16;
    steps += 1;
  }
  assert.equal(shown, 50_000, "it does arrive");
  assert.ok(steps > 8, "as writing, not in one jump");
  assert.ok(elapsed < 4_000, `and within a few seconds (took ${elapsed}ms)`);
});

test("a thread never rewinds, never overshoots, and never stalls", () => {
  assert.equal(revealStep(50, 50, 16), 50, "caught up stays caught up");
  assert.equal(revealStep(80, 50, 16), 50, "a shorter target is honoured, not overshot");
  assert.equal(revealStep(0, 3, 1_000), 3, "a long frame cannot exceed what exists");
  assert.equal(revealStep(9, 10, 1), 10, "one character left still lands, whatever the maths");
  assert.equal(revealStep(0, 100, 0), 1, "a zero-length frame still moves by one");
  assert.ok(revealStep(0, 100, -5) >= 1, "a clock that went backwards does not");
});

/* --------------------------------------------- where live text is allowed to go */

test("live text goes to the place its own output will take, never a new one", () => {
  // The rule, stated as a test: a redeveloper is writing the step's NEXT
  // version, so its words belong in the next card of the deck; a commenter or
  // judge is writing a comment or a judgement, so theirs belong in the panel
  // where those land. A box of its own would put the work on screen twice.
  const threads = [
    { text: "rewriting", role: "Redeveloper", actor: "Seat 4", where: { step: 7 } },
    { text: "commenting", role: "Commenter", actor: "Seat 2", where: { step: 7 } },
    { text: "judging", role: "Judge", where: { step: 7 } },
  ];
  const here = liveDestinations(threads, 7);
  assert.equal(here.writingNextVersion?.actor, "Seat 4", "the redeveloper writes the next card");
  assert.deepEqual(
    here.reviewers.map((t) => t.role),
    ["Commenter", "Judge"],
    "everyone else is writing into the review panel",
  );
});

test("a step only shows the threads that belong to it", () => {
  const threads = [
    { text: "on step 7", role: "Redeveloper", actor: "Seat 4", where: { step: 7 } },
    { text: "on step 6", role: "Commenter", actor: "Seat 2", where: { step: 6 } },
    { text: "no step recorded", role: "Commenter", actor: "Seat 3" },
  ];
  const six = liveDestinations(threads, 6);
  assert.equal(six.writingNextVersion, undefined, "step 7's redeveloper is not step 6's");
  assert.deepEqual(
    six.reviewers.map((t) => t.actor),
    ["Seat 2", "Seat 3"],
    "a thread with no step recorded is shown rather than dropped",
  );
});

test("a landed comment replaces its author's live thread, one reviewer at a time", () => {
  // A round's comments land one at a time, so the rule applies per reviewer:
  // the moment Seat 1's comment exists, its thread has nothing left to say.
  const threads = [
    { text: "…", role: "Commenter", actor: "Seat 1" },
    { text: "…", role: "Commenter", actor: "Seat 2" },
    { text: "…", role: "Judge" },
  ];
  assert.deepEqual(
    pendingReviewers(["Seat 1"], threads).map((t) => t.actor),
    ["Seat 2"],
    "the landed author drops out; the judge is handled by its own tab",
  );
  assert.deepEqual(
    pendingReviewers(["Seat 1", "Seat 2"], threads).map((t) => t.actor),
    [],
    "and when every comment has landed, no thread is left",
  );
});

/* -------------------- the gathering phase: reviewers writing, nothing landed */

const source = (relative: string): string =>
  readFileSync(new URL(`../../src/${relative}`, import.meta.url), "utf8");

test("a step's pending card renders the panel of reviewers writing about it", () => {
  // The regression this pins: a round view is born with its FIRST landed
  // comment, and a comment that verifies its claims takes minutes — so through
  // a position's whole opening commenting phase the step's deck is empty. The
  // pending card used to render the note and the step text and drop the live
  // reviewer threads on the floor: the reader saw "commentors are working"
  // for minutes while six reviewers' words existed and went nowhere.
  const code = source("components/panels/ReviewPanel.tsx");
  assert.match(
    code,
    /round-card-pending[\s\S]{0,1600}?<CommentsPanel/,
    "the empty-deck pending card must render the comments panel holding the live reviewers",
  );
});

test("the panel being written right now opens by itself", () => {
  const code = source("components/panels/ReviewPanel.tsx");
  assert.match(
    code,
    /commentState\.open\(gatheringKey, true\)/,
    "the gathering panel starts open — folded it is names and dots, and there is nothing else on the card",
  );
  assert.match(
    code,
    /review\?\.decision === undefined && liveHere\.length > 0/,
    "a version's fold keeps the open default for as long as its review is being written",
  );
  assert.match(
    code,
    /liveTag\(liveReviewers\[0\]!\)/,
    "and the first view is whoever is writing, while nothing has landed and the judge is silent",
  );
});
