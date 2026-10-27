import assert from "node:assert/strict";
import test from "node:test";

import { artifactSchemas, type VerdictsCatalog, type WorkflowDefinition } from "@brainstorm-agentic/content";
import { Scope, type AgentTask, type JsonObject } from "@brainstorm-agentic/core";

import { ContentArtifactOutputValidator } from "../src/agent-adapter.js";
import { GameReviewLedger } from "../src/game-ledger.js";
import { gameReviewVersion, settleGameReview } from "../src/game-review.js";
import { artifactSchemaToJsonSchema } from "../src/json-schema.js";
import { createInitialState, finishReviewRound, initializeReview } from "../src/state.js";

const chain = [{ part1: "Claim", part2: "Ground", part3: "Consequence", part4: "Limit" }];
const report = (q: number) => ({ q, justification: "The stated assumptions support this judgment." });
const admission = (admissible: boolean) => ({ admissible, reason: "The report addresses the reviewed step." });
const issue = {
  step: 1, part: "part2", point: "The comparison lacks the control required by its conclusion.",
  basis: "authority", evidence: { kind: "none" }, suggestion: "Supply the missing control.", mustAddress: true,
};

test("settlement scores the admitted cohort only, deterministically across arrival orders", () => {
  const chair = { reports: { a: admission(true), b: admission(true), c: admission(false) }, y: 0, reason: "No decisive flaw survives reconciliation.", issues: [] };
  const first = settleGameReview({ critiques: { a: report(0), b: report(0.5), c: report(1) }, chair, chain });
  const second = settleGameReview({ critiques: { c: report(1), b: report(0.5), a: report(0) }, chair, chain });
  assert.deepEqual(first, second);
  assert.equal(artifactSchemas.gameSettlement.safeParse(first).success, true);
  assert.deepEqual((first.rows as JsonObject[]).map(({ criticId, baseScore, peerMeanBaseScore, score }) => ({ criticId, baseScore, peerMeanBaseScore, score })), [
    { criticId: "a", baseScore: 25, peerMeanBaseScore: 0, score: 50 },
    { criticId: "b", baseScore: 0, peerMeanBaseScore: 25, score: -25 },
    { criticId: "c", baseScore: null, peerMeanBaseScore: null, score: null },
  ]);
});

test("one admitted report uses S; zero admitted reports preserve an unresolved null label", () => {
  const single = settleGameReview({ critiques: { a: report(0), b: report(1) }, chair: {
    reports: { a: admission(true), b: admission(false) }, y: 1, reason: "The accepted report identifies a decisive flaw.", issues: [issue],
  }, chain });
  assert.equal((single.rows as JsonObject[])[0]!.score, -75);
  assert.equal((single.rows as JsonObject[])[0]!.peerMeanBaseScore, null);
  const cohorts: JsonObject[] = [{}, { a: report(0.9) }];
  for (const critiques of cohorts) {
    const empty = settleGameReview({ critiques, chair: {
      reports: Object.fromEntries(Object.keys(critiques).map((id) => [id, admission(false)])),
      y: null, reason: "No admissible reports remain for reconciliation.", issues: [],
    }, chain });
    assert.equal(empty.y, null);
    assert.equal(empty.status, "no-valid-reports");
    assert.equal((empty.decision as JsonObject).verdict, "Interrupt");
    assert.ok((empty.rows as JsonObject[]).every((row) => row.score === null));
    assert.equal(artifactSchemas.gameSettlement.safeParse(empty).success, true);
  }
});

test("score observations stay attached to the pre-repair version and cap never flips y", () => {
  const settlement = settleGameReview({ critiques: { a: report(1) }, chair: {
    reports: { a: admission(true) }, y: 1, reason: "The decisive flaw remains unresolved.", issues: [issue],
  }, chain });
  assert.equal(settlement.version, gameReviewVersion(chain, 1));
  assert.notEqual(settlement.version, gameReviewVersion([{ ...chain[0], part2: "Repaired ground" }], 1));
  const scope = Scope.root(); scope.set("member", { id: "thinker" }); scope.set("stepIndex", 1);
  const result = finishReviewRound({ reviews: { thinker: { round: 2, finalRound: true, current: { gameSettlement: settlement, decision: settlement.decision! } } }, reviewLog: {} }, scope);
  const row = ((result.reviewLog as JsonObject).thinker as JsonObject[])[0]!;
  assert.equal(row.gameStatus, "unresolved");
  assert.equal((row.gameSettlement as JsonObject).y, 1);
});

test("chair identities and future-step issues produce retryable validation failures", () => {
  const validator = new ContentArtifactOutputValidator();
  const schema = artifactSchemaToJsonSchema(artifactSchemas.gameChairDecision, "gameChairDecision");
  const task = { input: { bindings: { comments: { a: report(0) }, currentStep: 1 } } } as unknown as AgentTask;
  const chair = { reports: { wrong: admission(true) }, y: 0, reason: "No decisive flaw survives reconciliation.", issues: [] };
  assert.equal(validator.validate(chair, schema, task).success, false);
  assert.throws(() => settleGameReview({ critiques: { a: report(0) }, chair, chain }), /critic IDs/);
  const future = { ...chair, reports: { a: admission(true) }, y: 1, issues: [{ ...issue, step: 2 }] };
  assert.equal(validator.validate(future, schema, task).success, false);
  assert.throws(() => settleGameReview({ critiques: { a: report(0) }, chair: future, chain }), /reviewed chain/);
  assert.equal(validator.validate({ ...chair, reports: { a: admission(true) } }, schema, task).success, true);
});

test("workflow boolean overrides reject strings and null instead of silently changing strategy", () => {
  const workflow = { params: { gamifiedReview: { default: false } } } as unknown as WorkflowDefinition;
  assert.equal((createInitialState(workflow, {}).params as JsonObject).gamifiedReview, false);
  assert.equal((createInitialState(workflow, {}, { gamifiedReview: true }).params as JsonObject).gamifiedReview, true);
  for (const value of ["true", "false", 1, null]) {
    assert.throws(() => createInitialState(workflow, {}, { gamifiedReview: value }), /must be boolean/);
  }
});

test("committee numeric overrides fail before work and preserve zero and automatic points", () => {
  const workflow = { params: { gameDecisionThreshold: { default: 0.5, min: 0, max: 1 }, gameInitialPoints: { default: -1, min: -1 } } } as unknown as WorkflowDefinition;
  for (const gameInitialPoints of [-1, 0, 0.5, 100]) {
    assert.equal((createInitialState(workflow, {}, { gameInitialPoints }).params as JsonObject).gameInitialPoints, gameInitialPoints);
  }
  for (const gameInitialPoints of [-0.5, -2, Number.POSITIVE_INFINITY, "100", null]) {
    assert.throws(() => createInitialState(workflow, {}, { gameInitialPoints }), /gameInitialPoints/);
  }
  for (const gameDecisionThreshold of [-0.01, 1.01, Number.NaN, "0.5", null]) {
    assert.throws(() => createInitialState(workflow, {}, { gameDecisionThreshold }), /gameDecisionThreshold/);
  }
});

test("decision-rule overrides accept only the two rules and a boolean leave-one-out flag", () => {
  const workflow = { params: { gameDecisionRule: { default: "chair-decisive" }, gameLeaveOneOut: { default: true } } } as unknown as WorkflowDefinition;
  const defaults = createInitialState(workflow, {}).params as JsonObject;
  assert.equal(defaults.gameDecisionRule, "chair-decisive"); assert.equal(defaults.gameLeaveOneOut, true);
  for (const gameDecisionRule of ["committee-mean", "chair-decisive"]) {
    assert.equal((createInitialState(workflow, {}, { gameDecisionRule }).params as JsonObject).gameDecisionRule, gameDecisionRule);
  }
  for (const gameDecisionRule of ["majority", "Chair-Decisive", "", 1, true, null]) {
    assert.throws(() => createInitialState(workflow, {}, { gameDecisionRule }), /gameDecisionRule/);
  }
  for (const gameLeaveOneOut of ["true", 0, null]) {
    assert.throws(() => createInitialState(workflow, {}, { gameLeaveOneOut }), /gameLeaveOneOut.*must be boolean/);
  }
  const legacy = { params: { gameDecisionThreshold: { default: 0.5, min: 0, max: 1 } } } as unknown as WorkflowDefinition;
  assert.throws(() => createInitialState(legacy, {}, { gameDecisionRule: "committee-mean" }), /unknown workflow param "gameDecisionRule"/);
});

test("finishReviewRound records the decision rule and chair labels beside the settlement, and tasks never see the labels", () => {
  const critiques = { a: { q: 0.95, justification: "The specialist argument identifies the missing control." }, b: { q: 0.1, justification: "The generalist argument sees no flaw." } };
  const settlement = new GameReviewLedger().settle("run", "run:settle", {
    critiques, chain, panel: { members: [{ id: "a" }, { id: "b" }, { id: "thinker" }] }, initialPoints: 0, threshold: 0.5, decisionRule: "chair-decisive", leaveOneOut: true,
    chair: { reports: { a: { admissible: true, reason: "The argument holds under its conditions.", label: "decisive", factChecks: [] }, b: { admissible: true, reason: "The argument holds but changes nothing.", label: "not-decisive", factChecks: [] } }, reason: "Both arguments are direct reasoning." },
  }, []);
  assert.equal(settlement.y, 1);
  const scope = Scope.root(); scope.set("member", { id: "thinker" }); scope.set("stepIndex", 1);
  const result = finishReviewRound({ reviews: { thinker: { round: 1, current: { gameSettlement: settlement, decision: settlement.decision! } } }, reviewLog: {} }, scope);
  const row = ((result.reviewLog as JsonObject).thinker as JsonObject[])[0]!;
  assert.equal(row.gameStatus, "continuing");
  assert.equal(row.gameDecisionRule, "chair-decisive"); assert.equal(row.gameLeaveOneOut, true);
  assert.deepEqual(row.gameLabels, { a: "decisive", b: "not-decisive" });
  const legacy = finishReviewRound({ reviews: { thinker: { round: 1, current: { gameSettlement: { ...settleGameReview({ critiques: { a: { q: 1, justification: "A flaw." } }, chair: { reports: { a: admission(true) }, y: 1, reason: "The decisive flaw remains unresolved.", issues: [issue] }, chain }) }, decision: { verdict: "Interrupt", reason: "r", issues: [] } } } }, reviewLog: {} }, scope);
  const legacyRow = ((legacy.reviewLog as JsonObject).thinker as JsonObject[])[0]!;
  for (const key of ["gameDecisionRule", "gameLeaveOneOut", "gameLabels"]) assert.equal(Object.hasOwn(legacyRow, key), false);
  const verdicts = { version: "0.2.0", verdicts: { Pass: { description: "no flaw", requires: ["verdict"] }, Interrupt: { description: "a flaw", requires: ["verdict"] } }, sequencing: { noImmediateRepeat: [], advanceOn: "Pass", redevelopOn: ["Interrupt"] } } as unknown as VerdictsCatalog;
  const seat = ((initializeReview({ ...result, params: { gamifiedReview: true } }, scope, verdicts).reviews as JsonObject).thinker as JsonObject);
  for (const handed of [...(seat.history as JsonObject[]), ...((seat.record as JsonObject).rounds as JsonObject[])]) {
    assert.equal(Object.hasOwn(handed, "gameSettlement"), false); assert.equal(Object.hasOwn(handed, "gameLabels"), false);
    assert.equal(handed.gameDecisionRule, "chair-decisive");
  }
});
