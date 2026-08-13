import assert from "node:assert/strict";
import test from "node:test";

import type { VerdictsCatalog } from "@brainstorm-agentic/content";
import { Scope, type JsonObject, type JsonValue } from "@brainstorm-agentic/core";

import { applyRedevelopment, initializeReview, prepareReviewRound } from "../src/index.js";

const VERDICTS = {
  version: "0.2.0",
  verdicts: {
    Pass: { description: "no demonstrable flaw stands", requires: ["verdict"] },
    Build: { description: "a necessary gap", requires: ["verdict"] },
    Interrupt: { description: "a demonstrated flaw", requires: ["verdict"] },
  },
  sequencing: {
    noImmediateRepeat: ["Build"],
    advanceOn: "Pass",
    redevelopOn: ["Build", "Interrupt"],
  },
} as unknown as VerdictsCatalog;

function issue(step: number, point: string, mustAddress = true): JsonObject {
  return {
    step,
    point,
    basis: "verified",
    evidenceKind: "math",
    mustAddress,
    suggestion: `Repair for: ${point}`,
  };
}

/**
 * One seat's ledger part-way through a six-step walk: step 1 passed on sight,
 * step 2 took a Build and a revision before passing, step 3 exhausted the
 * round budget with its objections still standing.
 */
function ledger(): JsonValue[] {
  return [
    { step: 1, round: 1, verdict: "Pass", reason: "Checked the opening bound; it holds.", issues: [] },
    {
      step: 2,
      round: 1,
      verdict: "Build",
      reason: "The comparison needs its control stated.",
      issues: [issue(2, "The step relies on an uncontrolled comparison it never justifies.")],
      touched: [2],
      untouched: [1, 3, 4, 5, 6],
    },
    {
      step: 2,
      round: 2,
      verdict: "Pass",
      reason: "The revision states the control the earlier round required.",
      issues: [],
    },
    {
      step: 3,
      round: 1,
      verdict: "Interrupt",
      reason: "The derivation drops a term.",
      issues: [issue(3, "Expanding the product drops the cross term.")],
      touched: [3],
      untouched: [1, 2, 4, 5, 6],
    },
    {
      step: 3,
      round: 2,
      verdict: "Interrupt",
      reason: "The repair moved the error rather than fixing it.",
      issues: [
        issue(3, "Expanding the product drops the cross term."),
        issue(2, "The revised step now contradicts the control stated at step 2."),
      ],
    },
  ];
}

function stateWith(entries: readonly JsonValue[]): JsonObject {
  return {
    params: { maxReviewRounds: 4 },
    ideas: {},
    reviews: {},
    reviewLog: { "member-1": [...entries] },
  };
}

function walkScope(stepIndex: number): Scope {
  const scope = Scope.root();
  scope.set("member", { id: "member-1" });
  scope.set("stepIndex", stepIndex);
  return scope;
}

function recordOf(state: JsonObject): JsonObject {
  const reviews = state.reviews as JsonObject;
  const seat = reviews["member-1"] as JsonObject;
  return seat.record as JsonObject;
}

test("closed positions collapse; the working position stays verbatim", () => {
  const next = initializeReview(stateWith(ledger()), walkScope(4), VERDICTS);
  const record = recordOf(next);

  // A position that passed on sight needs no prose at all.
  assert.deepEqual(record.clean, [1]);

  const settled = record.settled as JsonObject[];
  assert.deepEqual(settled.map((entry) => entry.step), [2, 3]);
  assert.deepEqual(settled[0], {
    step: 2,
    rounds: 2,
    outcome: "passed",
    objections: ["The step relies on an uncontrolled comparison it never justifies."],
    revised: [2],
    closingReason: "The revision states the control the earlier round required.",
  });
  assert.equal(settled[1]!.outcome, "force-passed", "a capped position is not a passed one");
  assert.deepEqual(
    settled[1]!.objections,
    [
      "Expanding the product drops the cross term.",
      "The revised step now contradicts the control stated at step 2.",
    ],
    "an objection raised in several rounds is named once",
  );

  // The one thing the flat ledger left every reader to infer: what is still
  // unanswered. A force-passed position's LAST round is unresolved by
  // construction, so its issues ride in full — evidence and all.
  const standing = record.standing as JsonObject[];
  assert.equal(standing.length, 2);
  assert.deepEqual(standing.map((entry) => entry.step), [3, 2]);
  assert.equal(standing[0]!.evidenceKind, "math");
  assert.equal(standing[0]!.mustAddress, true);

  // Nothing has happened at the current position yet.
  assert.deepEqual(record.rounds, []);
});

test("the current position's rounds ride verbatim, wherever their issues point", () => {
  const entries = [
    ...ledger(),
    {
      step: 4,
      round: 1,
      verdict: "Build",
      reason: "This step needs the earlier assumption restated.",
      issues: [issue(2, "Step 2's control is never carried into this step.")],
      touched: [4],
      untouched: [1, 2, 3, 5, 6],
    },
  ];
  const record = recordOf(
    prepareReviewRound(stateWith(entries), walkScope(4), VERDICTS),
  );

  assert.deepEqual(
    record.rounds,
    [entries[entries.length - 1]],
    "this position's round keeps every field, including its change-set",
  );
  // An issue raised HERE about an earlier step belongs to this position's
  // open business, never to the closed record of the step it points at.
  const settled = record.settled as JsonObject[];
  assert.deepEqual(settled.map((entry) => entry.step), [2, 3]);
  assert.ok(
    !JSON.stringify(settled).includes("never carried into this step"),
    "a live objection is not filed as closed business",
  );
});

test("no objection is ever dropped: every recorded point stays reachable", () => {
  const entries = [
    ...ledger(),
    {
      step: 4,
      round: 1,
      verdict: "Build",
      reason: "Restate the assumption.",
      issues: [issue(2, "Step 2's control is never carried into this step.")],
    },
  ];
  const record = recordOf(
    prepareReviewRound(stateWith(entries), walkScope(4), VERDICTS),
  );
  const projected = JSON.stringify(record);
  for (const raw of entries) {
    for (const item of (raw as JsonObject).issues as JsonObject[]) {
      assert.ok(
        projected.includes(item.point as string),
        `the projection still names: ${String(item.point)}`,
      );
    }
  }
});

/** A member mid-review: a three-step chain and a developed paper. */
function ideaState(): JsonObject {
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
        cot: ["step one", "step two", "step three"],
        novelty: "the original novelty claim",
        literature: [{ title: "A prior work", authors: ["Author"], relation: "closest" }],
      },
    },
    reviews: { "member-1": { current: { comments: {} } } },
    reviewLog: {},
  };
}

test("a patched revision lands exactly as a re-emitted one would", () => {
  const patched = applyRedevelopment(
    ideaState(),
    walkScope(2),
    {
      steps: [{ index: 2, text: "repaired step two" }],
      outputPatch: { paper: { method: ["m1 revised", "m2 revised", "m3 revised"] } },
    },
    "redevelop-idea",
    "patch",
  );
  const idea = (patched.ideas as JsonObject)["member-1"] as JsonObject;

  assert.deepEqual(idea.cot, ["step one", "repaired step two", "step three"]);
  const paper = (idea.output as JsonObject).paper as JsonObject;
  assert.deepEqual(paper.method, ["m1 revised", "m2 revised", "m3 revised"]);
  assert.deepEqual(paper.abstract, ["a1", "a2", "a3"], "unpatched sections stand");
  assert.equal(idea.novelty, "the original novelty claim", "novelty stands until moved");
  assert.ok(idea.literature, "the grounding record rides through, as it always did");

  // The change-set is the runtime's own comparison, not the model's report —
  // and with the host carrying untouched steps, it cannot be polluted by a
  // paraphrase the reviser never meant to make.
  const current = ((patched.reviews as JsonObject)["member-1"] as JsonObject)
    .current as JsonObject;
  assert.deepEqual(current.touched, [2]);
  assert.deepEqual(current.untouched, [1, 3]);
});

test("a patch that re-submits identical text counts as untouched, like a verbatim copy", () => {
  const patched = applyRedevelopment(
    ideaState(),
    walkScope(2),
    { steps: [{ index: 2, text: "step two" }] },
    "redevelop-idea",
    "patch",
  );
  const current = ((patched.reviews as JsonObject)["member-1"] as JsonObject)
    .current as JsonObject;
  assert.deepEqual(current.touched, [], "text that did not change did not change");
  assert.deepEqual(current.untouched, [1, 2, 3]);
});

test("a patch that does not fit the version it revises fails the task, never the record", () => {
  assert.throws(
    () =>
      applyRedevelopment(
        ideaState(),
        walkScope(2),
        { steps: [{ index: 7, text: "beyond the chain" }] },
        "redevelop-idea",
        "patch",
      ),
    /does not fit the version it revises/,
  );
});

test("the first position of a walk sees an empty record, and the legacy ledger is untouched", () => {
  const first = initializeReview(stateWith([]), walkScope(1), VERDICTS);
  assert.deepEqual(recordOf(first), {
    clean: [],
    settled: [],
    standing: [],
    rounds: [],
  });

  // Bundles published before the scoped record bind the flat ledger, so it
  // keeps being written exactly as it was — an old pinned run resumes
  // unchanged under this runtime.
  const entries = ledger();
  const later = initializeReview(stateWith(entries), walkScope(4), VERDICTS);
  const seat = (later.reviews as JsonObject)["member-1"] as JsonObject;
  assert.deepEqual(seat.history, entries);
});
