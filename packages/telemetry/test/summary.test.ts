import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonObject } from "@brainstorm-agentic/core";

import { deriveRunSummary } from "../src/summary.js";

const reviewBase =
  "brainstorm-root/review-members/review-members-fanout";

function judgeEntry(
  member: number,
  step: number,
  round: number,
  verdict: string,
  issues: JsonObject[] = [],
): JsonObject {
  return {
    key:
      `${reviewBase}/member[${member}]/review-members-branch/review-steps/cotStep[${step}]/` +
      `review-round/review-round-loop/iter[${round}]/review-round-iteration/review-round-body/` +
      "judge-step/judge-step-execute::result",
    kind: "agent",
    value: { taskId: `t-${member}-${step}-${round}`, status: "ok", output: { verdict, issues } },
  };
}

function redevelopEntry(member: number, step: number, round: number): JsonObject {
  return {
    key:
      `${reviewBase}/member[${member}]/review-members-branch/review-steps/cotStep[${step}]/` +
      `review-round/review-round-loop/iter[${round}]/review-round-iteration/review-round-body/` +
      "maybe-redevelop/then/redevelop-idea/redevelop-idea-execute::result",
    kind: "agent",
    value: { taskId: `r-${member}-${step}-${round}`, status: "ok", output: { steps: ["s1"] } },
  };
}

/**
 * A format-2 journal carries no run state; the summary must derive its
 * classification, panel, taxonomy, and review facts from the recorded
 * outputs instead.
 */
test("run summary facts derive from a format-2 journal (no state)", () => {
  const journal: JsonObject[] = [
    {
      key: "brainstorm-root/apply-classification/apply-classification-run::result",
      kind: "activity",
      value: {
        type: "research idea",
        cotSteps: 3,
        requestedOutputs: [{ title: "Risks", ask: "List the risks of the mechanism." }],
      },
    },
    {
      key: "brainstorm-root/confirm-classification/confirm-classification-wait::response",
      kind: "gate",
      value: { action: "approve" },
    },
    {
      key: "brainstorm-root/weave-panel/weave-panel-run::result",
      kind: "activity",
      value: {
        members: [
          { id: "member-1", umbrella: "Quantum Optics" },
          { id: "member-2", umbrella: "Machine Learning" },
          { id: "member-3", umbrella: "between the fields", seat: "interdisciplinary" },
        ],
      },
    },
    {
      key: "brainstorm-root/match-taxonomy/match-taxonomy-run::result",
      kind: "activity",
      value: {
        revision: 7,
        members: [
          { term: "quantum optics", matched: true, match: { id: "S:qo", matchedOn: "name" } },
          { term: "odd field", matched: false },
        ],
        unmatched: [{ term: "odd field" }],
      },
    },
    {
      key: "brainstorm-root/submit-decisions/submit-decisions-run::result",
      kind: "activity",
      value: { queued: 2 },
    },
    // Seat 0, step 0: Build in round 0, redeveloped, Pass in round 1.
    judgeEntry(0, 0, 0, "Build", [{ mustAddress: true, basis: "verified" }]),
    redevelopEntry(0, 0, 0),
    judgeEntry(0, 0, 1, "Pass"),
    // Seat 1, step 0: Pass in round 0.
    judgeEntry(1, 0, 0, "Pass"),
  ];
  const summary = deriveRunSummary({
    status: "completed",
    events: [],
    journal,
  });

  assert.deepEqual(summary.classification, {
    type: "research idea",
    cotSteps: 3,
    requestedOutputs: 1,
    gateAction: "approve",
  });
  assert.deepEqual(summary.panel, {
    seats: 3,
    distinctFields: 3,
    hasInterdisciplinarySeat: true,
    removedSeats: 0,
    customSeats: 0,
  });
  assert.equal(summary.taxonomy?.revision, 7);
  assert.deepEqual(summary.taxonomy?.resolvedNodeIds, ["S:qo"]);
  assert.deepEqual(summary.taxonomy?.matchedOn, { name: 1 });
  assert.equal(summary.taxonomy?.unmatched, 1);
  assert.equal(summary.taxonomy?.suggested, 2);
  assert.deepEqual(summary.review, {
    stepsPassed: 2,
    stepsForcePassed: 0,
    roundsHistogram: { "1": 1, "2": 1 },
    verdicts: { Build: 1, Pass: 2 },
    mustAddressIssues: 1,
    verifiedIssues: 1,
    authorityIssues: 0,
    redevelopments: 1,
  });
});

/** The gate's shrink answer trims the recorded panel, like the state did. */
test("role spend counts every attempt, and old runs still fall back to the journal", () => {
  // A retried task spends real tokens on the attempt that failed, and that
  // attempt is never journaled. Summing the journal alone under-reported it
  // and disagreed with the dashboard's figure for the same run.
  const retried = deriveRunSummary({
    status: "completed",
    events: [
      { type: "agent:started", taskId: "t-1", taskKind: "brainstorm.judge", at: 0 },
      {
        type: "agent:completed",
        taskId: "t-1",
        taskKind: "brainstorm.judge",
        status: "error",
        at: 10,
        usage: { inputTokens: 700, outputTokens: 30 },
      },
      {
        type: "agent:completed",
        taskId: "t-1",
        taskKind: "brainstorm.judge",
        status: "ok",
        at: 20,
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 5000 },
      },
    ] as unknown as JsonObject[],
    journal: [
      {
        key: "root/judge-step/judge-step-execute::result",
        kind: "agent",
        value: {
          taskId: "t-1",
          status: "ok",
          usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 5000 },
        },
      },
    ] as unknown as JsonObject[],
  });
  const judge = retried.roles.find((role) => role.role === "brainstorm.judge");
  assert.ok(judge);
  assert.equal(judge.inputTokens, 1700, "the failed attempt's input tokens are real spend");
  assert.equal(judge.outputTokens, 130);
  assert.equal(judge.cacheReadTokens, 5000, "the journaled attempt is not counted twice");

  // A run recorded before completion events carried usage has only the
  // journal to go on, and must still report what it spent.
  const legacy = deriveRunSummary({
    status: "completed",
    events: [
      { type: "agent:started", taskId: "t-9", taskKind: "brainstorm.brain", at: 0 },
      { type: "agent:completed", taskId: "t-9", taskKind: "brainstorm.brain", status: "ok", at: 5 },
    ] as unknown as JsonObject[],
    journal: [
      {
        key: "root/develop-idea/develop-idea-execute::result",
        kind: "agent",
        value: { taskId: "t-9", status: "ok", usage: { inputTokens: 42, outputTokens: 7 } },
      },
    ] as unknown as JsonObject[],
  });
  const brain = legacy.roles.find((role) => role.role === "brainstorm.brain");
  assert.equal(brain?.inputTokens, 42, "the journal still backs pre-event runs");
  assert.equal(brain?.outputTokens, 7);
});

test("a shrunk panel gate is applied to the journal-sourced panel fact", () => {
  const journal: JsonObject[] = [
    {
      key: "brainstorm-root/select-panel/select-panel-run::result",
      kind: "activity",
      value: {
        members: [
          { id: "member-1", umbrella: "Quantum Optics" },
          { id: "member-2", umbrella: "Machine Learning" },
          { id: "member-3", umbrella: "Systems Biology" },
        ],
      },
    },
    {
      key: "brainstorm-root/confirm-panel/confirm-panel-wait::response",
      kind: "gate",
      value: {
        action: "shrink",
        members: ["member-1", "member-3"],
        addedMembers: [{ department: "CS", umbrella: "Robotics", subfields: ["SLAM"] }],
      },
    },
  ];
  const summary = deriveRunSummary({ status: "completed", events: [], journal });
  assert.deepEqual(summary.panel, {
    seats: 3,
    distinctFields: 3,
    hasInterdisciplinarySeat: false,
    removedSeats: 0,
    customSeats: 1,
  });
});
