import assert from "node:assert/strict";
import test from "node:test";

import {
  gameChairDecisionSchema,
  gameCommitteeDecisionSchema,
  gameCritiqueSchema,
  gameSettlementSchema,
  gameSettlementV2Schema,
  gameSettlementV3Schema,
  factConsultationSchema,
  factTableCatalogSchema,
  stableGameMean,
  validateBundle,
  type GameChairDecision,
  type GameCommitteeDecision,
  type GameSettlementV1,
  type GameSettlementV2,
  type GameSettlementV3,
  type JudgeIssueParts,
} from "../src/index.js";
import { findActivity, findAgent, findNode, freshBundle } from "./helpers.js";

test("Supreme mediation catalog and consultation schema reject incomplete or invented control shapes", () => {
  // A schema unit fixture must also run against historical bundles which have
  // no fact-table catalog, independently of the shipped-content integration tests.
  const legacy = {
    version: "0.1.0",
    verifier: { skill: "supreme_judge", route: "reasoning", output: "factVerdict" },
    cases: {
      justified: "An existing badge covers the claim.", "justified-new": "Verified with a new badge.",
      narrowed: "Verified under narrower conditions.", conflict: "Conflicts with a standing entry.",
      refuted: "Evidence refutes the claim.", unverified: "Verification could not be completed.",
      "not-a-fact": "No independent substantive factual assertion needs verification.",
    },
    methods: { "re-executed": "Run the computation.", "source-quoted": "Read the original source.", "record-match": "Check the run record.", "judgement-only": "Inspect the argument.", none: "No verification completed." },
    resolutions: { "incumbent-stands": "Existing claim stands.", "incumbent-revoked": "Existing claim is revoked.", "both-narrowed": "Both claims need narrower conditions.", disputed: "The conflict remains unresolved." },
    limits: { submissionsPerTask: 6, relatedFacts: 8, lookupResults: 5, verificationMinutes: 30 },
  };
  const consultation = { skill: "supreme_judge_consult", route: "reasoning", output: "factConsultation" };
  assert.equal(factTableCatalogSchema.safeParse(legacy).success, true);
  assert.equal(factTableCatalogSchema.safeParse({ ...legacy, accessMode: "supreme-mediated/v1", consultation }).success, true);
  assert.equal(factTableCatalogSchema.safeParse({ ...legacy, accessMode: "supreme-mediated/v1" }).success, false);
  assert.equal(factTableCatalogSchema.safeParse({ ...legacy, consultation }).success, false);
  const result = { answer: "This premise covers the requested claim.", matches: [{ factId: "F:1", relation: "equivalent", reason: "Both statements express the same conditional result." }], approval: { approved: true, targetFactId: "F:1", reason: "The premise supports this specific submitted argument." } };
  assert.equal(factConsultationSchema.safeParse(result).success, true);
  assert.equal(factConsultationSchema.safeParse({ ...result, matches: [result.matches[0], result.matches[0]] }).success, false);
  assert.equal(factConsultationSchema.safeParse({ ...result, approval: { approved: true, reason: "No actual target." } }).success, false);
  assert.equal(factConsultationSchema.safeParse({ ...result, matches: [{ ...result.matches[0], relation: "same-hash" }] }).success, false);
  assert.equal(factConsultationSchema.safeParse({ ...result, rawTable: [] }).success, false);
});

test("mediated catalog checks the consultation role's exact host bindings and prevents recursive capabilities", () => {
  const bundle = freshBundle();
  if (bundle.factTable?.accessMode !== "supreme-mediated/v1") return;
  const consultation = bundle.factTable.consultation!;
  const skill = bundle.skills[consultation.skill]!;
  assert.deepEqual(validateBundle(bundle), []);
  skill.meta.capabilities.push("fact-table");
  assert.ok(validateBundle(bundle).some((issue) => issue.code === "FACT_VERIFIER_RECURSION" && issue.path.includes("consultation")));
  skill.meta.capabilities.pop();
  skill.meta.vars.push("rawPeerReports");
  assert.ok(validateBundle(bundle).some((issue) => issue.code === "UNBOUND_VAR" && issue.path.includes("consultation")));
});

const none = {
  kind: "none" as const,
  code: "", result: "", derivation: "", citation: "", locator: "", shows: "",
};

const issue: JudgeIssueParts = {
  step: 1,
  part: "part2",
  point: "The reported denominator is zero under the stated assumptions.",
  basis: "verified",
  evidence: { ...none, kind: "math", derivation: "The stated assumption x=0 makes x squared equal zero." },
  suggestion: "Handle the zero denominator before dividing.",
  mustAddress: true,
};

test("game critics return exactly a finite probability and justification", () => {
  for (const q of [0, 0.125, 1]) {
    assert.deepEqual(gameCritiqueSchema.parse({ q, justification: "The stated assumption is supported." }), {
      q, justification: "The stated assumption is supported.",
    });
  }
  for (const q of [-0.01, 1.01, NaN, Infinity, "0.8", null]) {
    assert.equal(gameCritiqueSchema.safeParse({ q, justification: "A scientific argument." }).success, false);
  }
  for (const extra of [{ verdict: "Pass" }, { score: 25 }, { evidence: none }]) {
    assert.equal(gameCritiqueSchema.safeParse({ q: 0.1, justification: "The argument holds.", ...extra }).success, false);
  }
  assert.equal(gameCritiqueSchema.safeParse({ q: 0.1 }).success, false);
  assert.equal(gameCritiqueSchema.safeParse({ q: 0.1, justification: "" }).success, false);
});

test("chair labels distinguish a supported consensus from no admitted reports", () => {
  const rejected: GameChairDecision = {
    reports: { a: { admissible: false, reason: "The citation names an unrelated paper." } },
    y: null, reason: "No admissible argument remains to establish a consensus.", issues: [],
  };
  assert.equal(gameChairDecisionSchema.safeParse(rejected).success, true);
  assert.equal(gameChairDecisionSchema.safeParse({ ...rejected, y: 0 }).success, false);
  assert.equal(gameChairDecisionSchema.safeParse({ ...rejected, y: 1, issues: [issue] }).success, false);

  const admitted = { ...rejected, reports: { a: { admissible: true, reason: "The support is relevant." } } };
  assert.equal(gameChairDecisionSchema.safeParse(admitted).success, false);
  assert.equal(gameChairDecisionSchema.safeParse({ ...admitted, y: 0 }).success, true);
  assert.equal(gameChairDecisionSchema.safeParse({ ...admitted, y: 0, issues: [issue] }).success, false);
  assert.equal(gameChairDecisionSchema.safeParse({ ...admitted, y: 1 }).success, false);
  assert.equal(gameChairDecisionSchema.safeParse({ ...admitted, y: 1, issues: [{ ...issue, mustAddress: false }] }).success, false);
  assert.equal(gameChairDecisionSchema.safeParse({ ...admitted, y: 1, issues: [issue] }).success, true);
});

function unresolved(): GameSettlementV1 {
  return {
    ruleVersion: "brier-peer/v1", version: "chain-version", y: null,
    status: "no-valid-reports", admittedCount: 0,
    rows: [{
      criticId: "a", q: 0.9, admissible: false, reason: "The support does not address the step.",
      brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null,
    }],
    decision: { verdict: "Interrupt", reason: "No admissible argument remains.", suggestion: "", evidence: none, issues: [] },
  };
}

test("score artifacts never assign rejection penalties or disguise an unresolved round as a pass", () => {
  const settlement = unresolved();
  assert.equal(gameSettlementSchema.safeParse(settlement).success, true);
  assert.equal(gameSettlementSchema.safeParse({ ...settlement, rows: [{ ...settlement.rows[0], score: -175 }] }).success, false);
  assert.equal(gameSettlementSchema.safeParse({ ...settlement, decision: { ...settlement.decision, verdict: "Pass" } }).success, false);
  assert.equal(gameSettlementSchema.safeParse({ ...settlement, admittedCount: 1 }).success, false);
  assert.equal(gameSettlementSchema.safeParse({ ...settlement, rows: [...settlement.rows, ...settlement.rows] }).success, false);
});

test("one admitted report has its base score and no fictitious peer average", () => {
  const settlement: GameSettlementV1 = {
    ...unresolved(), y: 0, status: "settled", admittedCount: 1,
    rows: [{ criticId: "a", q: 0.1, admissible: true, reason: "The justification is relevant.", brierLoss: 0.01, baseScore: 24, peerMeanBaseScore: null, score: 24 }],
    decision: { verdict: "Pass", reason: "The admissible argument finds no major flaw.", suggestion: "", evidence: none, issues: [] },
  };
  assert.equal(gameSettlementSchema.safeParse(settlement).success, true);
  assert.equal(gameSettlementSchema.safeParse({ ...settlement, rows: [{ ...settlement.rows[0], peerMeanBaseScore: 24 }] }).success, false);
});

test("the optional game branch preserves the existing review branch and final rapporteur", () => {
  const bundle = freshBundle();
  const workflow = bundle.workflows.brainstorm!;
  if (workflow.params.gamifiedReview === undefined) return; // Older pinned bundles remain supported.
  const committee = workflow.params.gameDecisionThreshold !== undefined;
  assert.equal(workflow.params.gamifiedReview.default, false);
  assert.deepEqual(validateBundle(bundle), []);
  const dispatch = findNode(workflow.root, "dispatch-review-strategy");
  assert.equal(dispatch.kind, "condition");
  if (dispatch.kind !== "condition") return;
  assert.deepEqual(dispatch.if, { ref: "params.gamifiedReview", equals: true });
  assert.equal(dispatch.else?.id, "review-round");
  assert.equal(findAgent(dispatch.else!, "comment-step").output.schema, "commentParts");
  assert.equal(findAgent(dispatch.else!, "judge-step").fastPassUnanimous, true);
  assert.equal(findAgent(workflow.root, "synthesize-proposal").skill, "chair");
  assert.equal(findAgent(workflow.root, "synthesize-proposal").output.schema, "finalProposal");

  for (const id of ["game-comment-step", "game-comment-step-bridge"]) {
    const critic = findAgent(dispatch.then, id);
    assert.equal(critic.output.schema, "gameCritique");
    for (const key of ["history", "comments", "scores", "verdictOptions", "verdictCatalog"]) {
      assert.equal(critic.bind?.[key], undefined, `${id} must not receive ${key}`);
    }
    assert.deepEqual(critic.bind?.chain, { ref: "ideas[member.id].cot", through: "stepIndex" });
    assert.ok(bundle.skills[critic.skill]!.meta.capabilities.includes("fact-table"));
    assert.equal(critic.thinkerNotes, undefined, "thinker repair notes may disclose earlier reviewers' feedback");
    assert.equal(bundle.skills[critic.skill]!.meta.capabilities.includes("notes-access"), false);
  }
  const chair = findAgent(dispatch.then, "chair-step");
  assert.equal(chair.output.schema, committee ? "gameCommitteeDecision" : "gameChairDecision");
  assert.equal(chair.skill, committee ? "committee-chair" : "review-chair");
  assert.notEqual(chair.fastPassUnanimous, true);
  assert.equal(findActivity(dispatch.then, "game-settle").handler, committee ? "review.committeeSettle" : "review.gameSettle");
  const guard = findNode(dispatch.then, "maybe-game-redevelop");
  assert.equal(guard.kind, "condition");
  if (guard.kind === "condition") {
    assert.deepEqual(guard.if, { all: [
      { ref: committee ? "reviews[member.id].current.gameSettlement.y" : "reviews[member.id].current.gameChair.y", equals: 1 },
      { ref: "reviews[member.id].finalRound", notEquals: true },
    ] });
  }
});

const factCheck = { factId: "F:1", conditions: "x is nonzero", supportsConclusion: true, reason: "Division is defined under the stated condition." };

test("committee admission records factual support without granting the model a label", () => {
  const assessment: GameCommitteeDecision = {
    reports: { a: { admissible: true, reason: "The premise supports the inference.", factChecks: [factCheck] } },
    reason: "The cited premise applies to the current reasoning.",
  };
  assert.equal(gameCommitteeDecisionSchema.safeParse(assessment).success, true);
  assert.equal(gameCommitteeDecisionSchema.safeParse({ ...assessment, reports: { a: { ...assessment.reports.a, factChecks: [{ ...factCheck, verifiedFactId: "F:2" }] } } }).success, true);
  for (const extra of [{ y: 0 }, { meanQ: 0.2 }, { threshold: 0.5 }, { issues: [] }]) {
    assert.equal(gameCommitteeDecisionSchema.safeParse({ ...assessment, ...extra }).success, false);
  }
  for (const checks of [[{ ...factCheck, factId: "[F:1]" }], [{ ...factCheck, factId: "F:0" }], [{ ...factCheck, verifiedFactId: "F:0" }], [{ ...factCheck, conditions: "" }], [{ ...factCheck, supportsConclusion: false }], [factCheck, factCheck]]) {
    assert.equal(gameCommitteeDecisionSchema.safeParse({ ...assessment, reports: { a: { ...assessment.reports.a, factChecks: checks } } }).success, false);
  }
  assert.equal(gameCommitteeDecisionSchema.safeParse({ reports: { a: { admissible: false, reason: "The reported empirical improvement has no supporting measurement.", factChecks: [] } }, reason: "No supported argument remains." }).success, true);
});

test("committee reports carry the chair's decisiveness label as one of three words, or none for pinned legacy outputs", () => {
  const report = { admissible: true, reason: "The premise supports the inference.", factChecks: [factCheck] };
  for (const label of ["decisive", "not-decisive", "invalid"]) {
    const parsed = gameCommitteeDecisionSchema.parse({ reports: { a: { ...report, label } }, reason: "Labelled." });
    assert.equal(parsed.reports.a!.label, label);
  }
  assert.equal(gameCommitteeDecisionSchema.parse({ reports: { a: report }, reason: "Unlabelled legacy output." }).reports.a!.label, undefined);
  for (const label of ["Decisive", "major", "", null, true, 1]) {
    assert.equal(gameCommitteeDecisionSchema.safeParse({ reports: { a: { ...report, label } }, reason: "Mislabelled." }).success, false, String(label));
  }
  assert.equal(gameCommitteeDecisionSchema.safeParse({ reports: { a: { ...report, label: "invalid" } }, y: 0, reason: "The chair still never writes y." }).success, false);
});

test("committee permits explained direct reasoning without badges while retaining semantic rejections", () => {
  const assessment = {
    reports: {
      low: { admissible: true, reason: "The conditional identity follows directly by substituting the stated nonnegative value; no independent empirical premise is asserted.", factChecks: [] },
      high: { admissible: true, reason: "Substituting x=-1 directly refutes the claim for all real x; the counterexample is fully shown and needs no lookup.", factChecks: [] },
      unsupported: { admissible: false, reason: "The claimed performance advantage is a separate unsupported empirical premise.", factChecks: [] },
    },
    reason: "The displayed reasoning is supported; the unmeasured performance claim is not.",
  };
  assert.equal(gameCommitteeDecisionSchema.safeParse(assessment).success, true);
  assert.equal(gameCommitteeDecisionSchema.safeParse({ ...assessment, reports: { low: { ...assessment.reports.low, reason: "" } } }).success, false);
});

function committeeSettlement(): GameSettlementV2 {
  return {
    ruleVersion: "brier-peer/v2", version: "chain-version", settlementId: "settlement-1", ledgerSequence: 1,
    criticIds: ["a", "b", "thinker"], initialPoints: 100, meanQ: 0.5, threshold: 0.5, y: 1, status: "settled", admittedCount: 2,
    rows: [
      { criticId: "a", q: 0.9, admissible: true, reason: "The checked premise supports a major flaw.", brierLoss: 0.01, baseScore: 24, peerMeanBaseScore: -56, score: 104, balanceBefore: 100, balanceAfter: 204, excluded: false },
      { criticId: "b", q: 0.1, admissible: true, reason: "The checked premise supports a low probability.", brierLoss: 0.81, baseScore: -56, peerMeanBaseScore: 24, score: -136, balanceBefore: 100, balanceAfter: -36, excluded: true },
    ],
    repairArguments: ["The denominator becomes zero under the stated assumption [F:1]."],
    decision: { verdict: "Interrupt", reason: "Mean 0.5 reaches the threshold 0.5.", suggestion: "", evidence: none, issues: [] },
  };
}

test("committee settlement preserves the inclusive mean threshold and exact score arithmetic", () => {
  const settlement = committeeSettlement();
  assert.equal(gameSettlementSchema.safeParse(settlement).success, true);
  for (const change of [{ meanQ: 0.9 }, { y: 0 }, { admittedCount: 1 }, { threshold: 1.01 }, { ledgerSequence: 0 }, { criticIds: ["a", "a", "b"] }, { repairArguments: [] }]) {
    assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, ...change }).success, false);
  }
  for (const change of [{ brierLoss: 0.2 }, { baseScore: 23 }, { peerMeanBaseScore: -55 }, { score: 103 }, { balanceAfter: 203 }]) {
    assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, rows: [{ ...settlement.rows[0], ...change }, settlement.rows[1]] }).success, false);
  }
  assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, rows: [settlement.rows[0], { ...settlement.rows[1], excluded: false }] }).success, false);
  assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, decision: { ...settlement.decision, issues: [issue] } }).success, false);
});

test("identical probabilities exactly at a configured threshold stay on its inclusive boundary", () => {
  assert.equal(stableGameMean([]), null);
  assert.equal(stableGameMean([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]), 0.2);
  const settlement: GameSettlementV2 = {
    ...committeeSettlement(), meanQ: 0.2, threshold: 0.2, admittedCount: 6,
    criticIds: ["a", "b", "c", "d", "e", "f", "thinker"],
    rows: ["a", "b", "c", "d", "e", "f"].map((criticId) => ({
      criticId, q: 0.2, admissible: true, reason: "The supported assessment reaches the threshold.",
      brierLoss: 0.64, baseScore: -39, peerMeanBaseScore: -39, score: -39,
      balanceBefore: 100, balanceAfter: 61, excluded: false,
    })),
  };
  assert.equal(gameSettlementV2Schema.safeParse(settlement).success, true);
  assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, y: 0 }).success, false);
});

test("a committee with no admitted reports has no label, scores, repair arguments, or balance change", () => {
  const settlement: GameSettlementV2 = {
    ...committeeSettlement(), meanQ: null, y: null, status: "no-valid-reports", admittedCount: 0, repairArguments: [],
    rows: committeeSettlement().rows.map((row) => ({ ...row, admissible: false, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null, balanceAfter: row.balanceBefore, excluded: false })),
  };
  assert.equal(gameSettlementV2Schema.safeParse(settlement).success, true);
  assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, rows: [{ ...settlement.rows[0], balanceAfter: 99 }, settlement.rows[1]] }).success, false);
  assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, rows: [{ ...settlement.rows[0], score: -175 }, settlement.rows[1]] }).success, false);
  assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, y: 0 }).success, false);
});

test("a lone committee critic receives the base score and zero balance remains active", () => {
  const settlement: GameSettlementV2 = {
    ...committeeSettlement(), meanQ: 0.5, admittedCount: 1, initialPoints: 0,
    rows: [{ criticId: "a", q: 0.5, admissible: true, reason: "The premise establishes uncertainty.", brierLoss: 0.25, baseScore: 0, peerMeanBaseScore: null, score: 0, balanceBefore: 0, balanceAfter: 0, excluded: false }],
  };
  assert.equal(gameSettlementV2Schema.safeParse(settlement).success, true);
  assert.equal(gameSettlementV2Schema.safeParse({ ...settlement, rows: [{ ...settlement.rows[0], peerMeanBaseScore: 0 }] }).success, false);
});

test("committee workflow keeps private feedback and factual state host-owned and limits repair inputs", () => {
  const bundle = freshBundle();
  const workflow = bundle.workflows.brainstorm!;
  if (workflow.params.gameDecisionThreshold === undefined) return;
  assert.deepEqual(workflow.params.gameDecisionThreshold, { description: workflow.params.gameDecisionThreshold.description, default: 0.5, min: 0, max: 1 });
  assert.equal(workflow.params.gameInitialPoints?.default, -1);
  const critic = findAgent(workflow.root, "game-comment-step");
  const chair = findAgent(workflow.root, "chair-step");
  assert.ok(bundle.skills[critic.skill]!.meta.payload.includes("criticState"));
  assert.equal(bundle.skills[chair.skill]!.meta.payload.includes("verifiedFacts"), bundle.factTable?.accessMode !== "supreme-mediated/v1");
  assert.equal(critic.bind?.criticState, undefined);
  assert.equal(chair.bind?.verifiedFacts, undefined);
  const repair = findAgent(workflow.root, "game-redevelop-idea");
  assert.equal(repair.skill, "game-redeveloper");
  assert.equal(repair.bind?.repairArguments, "reviews[member.id].current.gameSettlement.repairArguments");
  for (const key of ["feedback", "history", "comments", "scores", "criticState"]) assert.equal(repair.bind?.[key], undefined);
  assert.deepEqual(validateBundle(bundle), []);
  critic.bind!.criticState = "reviews";
  chair.bind!.verifiedFacts = "reviews";
  assert.equal(validateBundle(bundle).filter((issue) => issue.code === "UNKNOWN_BINDING" && /host payload/.test(issue.message)).length, 2);
});

test("artifact collection inputs reject a different map under the same state root", () => {
  const bundle = freshBundle();
  const workflow = bundle.workflows.brainstorm!;
  if (workflow.params.gamifiedReview === undefined) return;
  const settle = findActivity(workflow.root, "game-settle");
  settle.bind.critiques = "reviews[member.id].current.comments";
  assert.ok(validateBundle(bundle).some((issue) => issue.code === "ACTIVITY_INPUT_TYPE_MISMATCH"));
});

function labelledSettlement(decisionRule: "committee-mean" | "chair-decisive", leaveOneOut: boolean): GameSettlementV3 {
  // a: q=0.95 decisive, b: q=0 not-decisive, c: rejected; mean 0.475 < threshold 0.5, so only the chair label blocks.
  // Peer-adjusted R = 2S - mean(other S) over the two scored rows.
  const chair = decisionRule === "chair-decisive";
  const y = chair ? 1 : 0;
  const against = (others: number): 0 | 1 => (chair ? 1 : leaveOneOut ? (others >= 0.5 ? 1 : 0) : y);
  const labels = { a: against(0), b: against(0.95) };
  const base = { a: 25 - 100 * (0.95 - labels.a) ** 2, b: 25 - 100 * (0 - labels.b) ** 2 };
  const score = { a: 2 * base.a - base.b, b: 2 * base.b - base.a };
  return {
    ruleVersion: "brier-peer/v3", version: "chain-version", settlementId: "settlement-1", ledgerSequence: 1,
    criticIds: ["a", "b", "c", "thinker"], initialPoints: 100, decisionRule, leaveOneOut, meanQ: 0.475, threshold: 0.5, y, status: "settled", admittedCount: 2,
    rows: [
      { criticId: "a", q: 0.95, admissible: true, reason: "The specialist argument holds and is decisive.", label: "decisive", scoringLabel: labels.a, brierLoss: (0.95 - labels.a) ** 2, baseScore: base.a, peerMeanBaseScore: base.b, score: score.a, balanceBefore: 100, balanceAfter: 100 + score.a, excluded: 100 + score.a < 0 },
      { criticId: "b", q: 0, admissible: true, reason: "The generalist argument holds but changes nothing.", label: "not-decisive", scoringLabel: labels.b, brierLoss: (0 - labels.b) ** 2, baseScore: base.b, peerMeanBaseScore: base.a, score: score.b, balanceBefore: 100, balanceAfter: 100 + score.b, excluded: 100 + score.b < 0 },
      { criticId: "c", q: 0.9, admissible: false, reason: "The cited badge is not in the table.", label: null, scoringLabel: null, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null, balanceBefore: 100, balanceAfter: 100, excluded: false },
    ],
    repairArguments: y === 1 ? ["The specialist argument identifies the missing control [F:1]."] : [],
    decision: { verdict: y === 1 ? "Interrupt" : "Pass", reason: y === 1 ? "Blocked by a decisive argument." : "Pass: no admitted argument reaches the threshold.", suggestion: "", evidence: none, issues: [] },
  };
}

test("v3 settlements recompute y, the scoring label, and the scores under the recorded rule", () => {
  for (const [rule, leaveOneOut] of [["committee-mean", false], ["committee-mean", true], ["chair-decisive", false], ["chair-decisive", true]] as const) {
    const settlement = labelledSettlement(rule, leaveOneOut);
    assert.equal(gameSettlementV3Schema.safeParse(settlement).success, true, `${rule}/${leaveOneOut}`);
    assert.equal(gameSettlementSchema.safeParse(settlement).success, true);
    assert.equal(gameSettlementV3Schema.safeParse({ ...settlement, y: settlement.y === 1 ? 0 : 1, decision: { ...settlement.decision, verdict: settlement.y === 1 ? "Pass" : "Interrupt" }, repairArguments: settlement.y === 1 ? [] : ["An argument."] }).success, false, "y follows the rule");
    assert.equal(gameSettlementV3Schema.safeParse({ ...settlement, rows: [{ ...settlement.rows[0]!, scoringLabel: settlement.rows[0]!.scoringLabel === 1 ? 0 : 1 }, settlement.rows[1]!, settlement.rows[2]!] }).success, false, "the scoring label is recomputed");
    assert.equal(gameSettlementV3Schema.safeParse({ ...settlement, rows: [{ ...settlement.rows[0]!, score: settlement.rows[0]!.score! + 1 }, settlement.rows[1]!, settlement.rows[2]!] }).success, false, "scores are recomputed");
    assert.equal(gameSettlementV3Schema.safeParse({ ...settlement, rows: [settlement.rows[0]!, settlement.rows[1]!, { ...settlement.rows[2]!, label: "decisive" }] }).success, false, "a rejected report carries no label");
    assert.equal(gameSettlementV3Schema.safeParse({ ...settlement, decision: { ...settlement.decision, issues: [issue] } }).success, false);
    assert.equal(gameSettlementV2Schema.safeParse(settlement).success, false);
  }
  // The chair label decides y whatever the mean says; the mean rule ignores the labels.
  assert.equal(labelledSettlement("chair-decisive", false).y, 1); assert.equal(labelledSettlement("committee-mean", false).y, 0);
  const chair = labelledSettlement("chair-decisive", false);
  assert.equal(gameSettlementV3Schema.safeParse({ ...chair, rows: [{ ...chair.rows[0]!, label: "not-decisive" }, chair.rows[1]!, chair.rows[2]!] }).success, false, "no decisive admitted report means y=0");
  assert.equal(gameSettlementV3Schema.safeParse({ ...chair, rows: [{ ...chair.rows[0]!, label: null }, chair.rows[1]!, chair.rows[2]!] }).success, false, "chair-decisive needs every admitted report labelled");
  assert.equal(gameSettlementV3Schema.safeParse({ ...chair, repairArguments: [] }).success, false);
  const mean = labelledSettlement("committee-mean", true);
  assert.deepEqual(mean.rows.map((row) => row.scoringLabel), [0, 1, null]);
  assert.equal(gameSettlementV3Schema.safeParse({ ...mean, rows: [{ ...mean.rows[0]!, label: "invalid" }, mean.rows[1]!, mean.rows[2]!] }).success, true, "labels are recorded but do not decide under the mean rule");
});

test("a lone admitted report is unscored under leave-one-out and scored otherwise", () => {
  const lone = (decisionRule: "committee-mean" | "chair-decisive", leaveOneOut: boolean, scored: boolean): GameSettlementV3 => ({
    ...labelledSettlement(decisionRule, leaveOneOut), meanQ: 0.95, y: 1, admittedCount: 1,
    rows: [
      { criticId: "a", q: 0.95, admissible: true, reason: "The specialist argument holds and is decisive.", label: "decisive", scoringLabel: scored ? 1 : null,
        brierLoss: scored ? 0.0025 : null, baseScore: scored ? 24.75 : null, peerMeanBaseScore: null, score: scored ? 24.75 : null, balanceBefore: 100, balanceAfter: scored ? 124.75 : 100, excluded: false },
      { criticId: "b", q: 0, admissible: false, reason: "The cited badge is not in the table.", label: null, scoringLabel: null, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null, balanceBefore: 100, balanceAfter: 100, excluded: false },
    ],
    repairArguments: ["The specialist argument identifies the missing control [F:1]."],
    decision: { verdict: "Interrupt", reason: "Blocked.", suggestion: "", evidence: none, issues: [] },
  });
  assert.equal(gameSettlementV3Schema.safeParse(lone("committee-mean", true, false)).success, true);
  assert.equal(gameSettlementV3Schema.safeParse(lone("committee-mean", true, true)).success, false);
  assert.equal(gameSettlementV3Schema.safeParse(lone("committee-mean", false, true)).success, true);
  assert.equal(gameSettlementV3Schema.safeParse(lone("committee-mean", false, false)).success, false);
  assert.equal(gameSettlementV3Schema.safeParse(lone("chair-decisive", true, true)).success, true);
  assert.equal(gameSettlementV3Schema.safeParse(lone("chair-decisive", true, false)).success, false);
  assert.equal(gameSettlementV3Schema.safeParse({ ...lone("committee-mean", true, false), rows: [{ ...lone("committee-mean", true, false).rows[0]!, balanceAfter: 99 }, lone("committee-mean", true, false).rows[1]!] }).success, false);
});
