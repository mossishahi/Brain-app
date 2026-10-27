/**
 * Per-run workflow-param overrides read from the environment
 * (BRAINSTORM_AGENTIC_WORKFLOW_PARAMS plus the two legacy variables).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { workflowParamsFromEnv } from "../src/workflow-params.js";

const declared = {
  panelSize: { default: 6, min: 1, max: 12 },
  maxReviewRounds: { default: 3, min: 1, max: 10 },
  routePairs: { default: "all" },
  routeKnn: { default: true },
  minNewShare: { default: 0.1, min: 0, max: 1 },
};

function read(env: Record<string, string>) {
  const lines: string[] = [];
  const params = workflowParamsFromEnv(env, declared, (line) => lines.push(line));
  return { params, lines };
}

test("declared overrides of the right type and range are kept", () => {
  const { params, lines } = read({
    BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ routePairs: "central", routeKnn: false, minNewShare: 0.25, panelSize: 4 }),
  });
  assert.deepEqual(params, { routePairs: "central", routeKnn: false, minNewShare: 0.25, panelSize: 4 });
  assert.deepEqual(lines, []);
});

test("undeclared, mistyped and out-of-range values are dropped, each with a log line", () => {
  const { params, lines } = read({
    BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({
      unknownParam: 1,
      routeKnn: "yes",
      routePairs: null,
      minNewShare: 1.5,
      panelSize: 0,
      maxReviewRounds: 2,
    }),
  });
  assert.deepEqual(params, { maxReviewRounds: 2 });
  assert.equal(lines.length, 5);
  assert.match(lines.join("\n"), /"unknownParam": the pinned workflow does not declare it/);
  assert.match(lines.join("\n"), /"routeKnn": expected a boolean, got string/);
  assert.match(lines.join("\n"), /"routePairs": expected a string, got null/);
  assert.match(lines.join("\n"), /"minNewShare"=1.5: above its maximum 1/);
  assert.match(lines.join("\n"), /"panelSize"=0: below its minimum 1/);
});

test("a value that is not a JSON object is ignored as a whole", () => {
  for (const raw of ["{not json", "[1, 2]", "42", "null"]) {
    const { params, lines } = read({ BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: raw });
    assert.equal(params, undefined, raw);
    assert.equal(lines.length, 1, raw);
    assert.match(lines[0]!, /ignoring BRAINSTORM_AGENTIC_WORKFLOW_PARAMS/);
  }
  const prototypePollution = read({ BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: '{"toString": 1, "__proto__": 2}' });
  assert.equal(prototypePollution.params, undefined);
  assert.equal(prototypePollution.lines.length, 2);
});

test("the legacy panel-size and review-round variables keep working and win over the JSON", () => {
  const { params, lines } = read({
    BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ panelSize: 4, maxReviewRounds: 2 }),
    BRAINSTORM_AGENTIC_PANEL_SIZE: "7",
    BRAINSTORM_AGENTIC_MAX_REVIEW_ROUNDS: " 5 ",
  });
  assert.deepEqual(params, { panelSize: 7, maxReviewRounds: 5 });
  assert.deepEqual(lines, []);
  const invalid = read({ BRAINSTORM_AGENTIC_PANEL_SIZE: "2.5", BRAINSTORM_AGENTIC_MAX_REVIEW_ROUNDS: "0" });
  assert.equal(invalid.params, undefined);
  assert.equal(invalid.lines.length, 2);
});

test("nothing set means no overrides", () => {
  assert.deepEqual(read({}), { params: undefined, lines: [] });
  assert.deepEqual(read({ BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: "  " }), { params: undefined, lines: [] });
});

test("gamified review cannot silently fall back to standard review on an older bundle", () => {
  assert.throws(
    () => read({ BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: '{"gamifiedReview":true}' }),
    /Gamified review is not supported by the pinned Brain bundle/,
  );
  assert.deepEqual(
    read({ BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: '{"gamifiedReview":false}' }),
    { params: undefined, lines: [] },
  );
});

test("game mode and other overrides are preserved together on a supporting bundle", () => {
  for (const gamifiedReview of [false, true]) {
    const params = workflowParamsFromEnv(
      { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ gamifiedReview, panelSize: 4 }) },
      { ...declared, gamifiedReview: { default: false } },
    );
    assert.deepEqual(params, { gamifiedReview, panelSize: 4 });
  }
});

test("a mistyped game selection is an error instead of an implicit mode change", () => {
  for (const gamifiedReview of ["false", "true", 1, null]) {
    assert.throws(
      () => workflowParamsFromEnv(
        { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ gamifiedReview }) },
        { ...declared, gamifiedReview: { default: false } },
      ),
      /gamifiedReview must be a boolean/,
    );
  }
});

const committeeDeclared = {
  ...declared,
  gamifiedReview: { default: false },
  gameDecisionThreshold: { default: 0.5, min: 0, max: 1 },
  gameInitialPoints: { default: -1, min: -1 },
};

test("committee settings survive alongside other overrides, including zero starting points", () => {
  for (const gameInitialPoints of [-1, 0, 250.5]) {
    const overrides = { gamifiedReview: true, gameDecisionThreshold: 0.25, gameInitialPoints, panelSize: 4 };
    assert.deepEqual(workflowParamsFromEnv(
      { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify(overrides) }, committeeDeclared,
    ), overrides);
  }
});

test("committee controls cannot be silently dropped by an older game bundle", () => {
  for (const [name, value] of [["gameDecisionThreshold", 0.25], ["gameInitialPoints", 400]] as const) {
    assert.throws(() => workflowParamsFromEnv(
      { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ gamifiedReview: true, [name]: value }) },
      { ...declared, gamifiedReview: { default: false } },
    ), new RegExp(`does not support ${name}`));
  }
});

test("invalid committee decisions and balances are errors, never substituted defaults", () => {
  const invalid: Record<string, unknown[]> = {
    gameDecisionThreshold: [-0.1, 1.1, "0.5", null],
    gameInitialPoints: [-2, -0.5, "100", null],
  };
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) assert.throws(() => workflowParamsFromEnv(
      { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ [name]: value }) }, committeeDeclared,
    ), new RegExp(`${name} must be`));
  }
  assert.throws(() => workflowParamsFromEnv(
    { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: '{"gameInitialPoints":1e400}' }, committeeDeclared,
  ), /gameInitialPoints must be/);
});

const scoringV3Declared = {
  ...committeeDeclared,
  gameDecisionRule: { default: "chair-decisive" },
  gameLeaveOneOut: { default: true },
};

test("decision rule and leave-one-out are forwarded on a scoring v3 bundle", () => {
  for (const [gameDecisionRule, gameLeaveOneOut] of [["chair-decisive", true], ["committee-mean", true], ["committee-mean", false], ["chair-decisive", false]] as const) {
    const overrides = { gamifiedReview: true, gameDecisionThreshold: 0.5, gameInitialPoints: -1, gameDecisionRule, gameLeaveOneOut, panelSize: 4 };
    assert.deepEqual(workflowParamsFromEnv(
      { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify(overrides) }, scoringV3Declared,
    ), overrides);
  }
});

test("a bundle without the scoring v3 params accepts only the legacy rule values", () => {
  const legacy = { gamifiedReview: true, gameDecisionThreshold: 0.5, gameInitialPoints: -1, gameDecisionRule: "committee-mean", gameLeaveOneOut: false };
  const lines: string[] = [];
  assert.deepEqual(workflowParamsFromEnv(
    { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify(legacy) }, committeeDeclared, (line) => lines.push(line),
  ), { gamifiedReview: true, gameDecisionThreshold: 0.5, gameInitialPoints: -1 });
  assert.deepEqual(lines, [], "the legacy values are accepted silently, not dropped with a warning");
  assert.throws(() => workflowParamsFromEnv(
    { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ ...legacy, gameDecisionRule: "chair-decisive" }) }, committeeDeclared,
  ), /pinned Brain bundle does not support gameDecisionRule/);
  assert.throws(() => workflowParamsFromEnv(
    { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ ...legacy, gameLeaveOneOut: true }) }, committeeDeclared,
  ), /pinned Brain bundle does not support gameLeaveOneOut/);
  // Even without the game switched on the names stay strict: no silent rule change.
  assert.throws(() => workflowParamsFromEnv(
    { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ gameDecisionRule: "chair-decisive" }) }, declared,
  ), /pinned Brain bundle does not support gameDecisionRule/);
});

test("invalid rule and leave-one-out values are errors on every bundle", () => {
  for (const bundle of [declared, committeeDeclared, scoringV3Declared]) {
    for (const gameDecisionRule of ["majority", "", 1, null, true]) {
      assert.throws(() => workflowParamsFromEnv(
        { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ gameDecisionRule }) }, bundle,
      ), /gameDecisionRule must be "committee-mean" or "chair-decisive"/);
    }
    for (const gameLeaveOneOut of ["true", "false", 1, 0, null]) {
      assert.throws(() => workflowParamsFromEnv(
        { BRAINSTORM_AGENTIC_WORKFLOW_PARAMS: JSON.stringify({ gameLeaveOneOut }) }, bundle,
      ), /gameLeaveOneOut must be a boolean/);
    }
  }
});
