import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gameChairView, gameLedgerFromJournal, gameReviewConfiguration, gameReviewEnabled, gameSettlementView } from "../src/game-review.js";
import { workflowParamsJson } from "../src/panel-composition.js";
import { defaultServerSettings, SettingsStore } from "../src/settings.js";
import { agentIdentity, buildJobDetail, reviewPhaseForPath } from "../src/stage-mapper.js";
import { LIVE_NODE_SKILLS } from "../src/job-manager.js";

test("gamified preference defaults off, survives unrelated saves, and rejects non-booleans", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "game-settings-"));
  try {
    const store = new SettingsStore(workspace);
    assert.equal(store.get().gamifiedReview, false);
    assert.deepEqual(store.get().gameReview, { threshold: 0.5, decisionRule: "chair-decisive", leaveOneOut: true });
    await store.put({ llm: { provider: "offline" }, gamifiedReview: true });
    await store.put({ review: { maxRounds: 2 } });
    assert.equal(new SettingsStore(workspace).get().gamifiedReview, true);
    await assert.rejects(store.put({ gamifiedReview: "true" }), /gamifiedReview must be a boolean/);
    await assert.rejects(store.put({ gamifiedReview: null }), /gamifiedReview must be a boolean/);
    await store.put({ gamifiedReview: false });
    assert.equal(store.get().gamifiedReview, false);
    assert.equal(store.get().review?.maxRounds, 2);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("game threshold and starting points validate, persist and explicitly restore automatic points", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "game-policy-"));
  try {
    const store = new SettingsStore(workspace);
    await store.put({ llm: { provider: "offline" }, gameReview: { threshold: 0.25, initialPoints: 0 } });
    await store.put({ gamifiedReview: true, review: { maxRounds: 2 } });
    assert.deepEqual(new SettingsStore(workspace).get().gameReview, { threshold: 0.25, initialPoints: 0, decisionRule: "chair-decisive", leaveOneOut: true });
    for (const threshold of [-0.01, 1.01, NaN, Infinity, "0.5", null]) {
      await assert.rejects(store.put({ gameReview: { threshold } }), /gameReview.threshold/);
    }
    for (const initialPoints of [-1, NaN, Infinity, "100", null]) {
      await assert.rejects(store.put({ gameReview: { threshold: 0.5, initialPoints } }), /gameReview.initialPoints/);
    }
    await store.put({ gameReview: { threshold: 1 } });
    assert.deepEqual(store.get().gameReview, { threshold: 1, decisionRule: "chair-decisive", leaveOneOut: true });
    await store.put({ gamifiedReview: false });
    assert.deepEqual(store.get().gameReview, { threshold: 1, decisionRule: "chair-decisive", leaveOneOut: true });
    await store.put({ gameReview: { threshold: 0 } });
    assert.deepEqual(store.get().gameReview, { threshold: 0, decisionRule: "chair-decisive", leaveOneOut: true });
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("decision rule and leave-one-out validate, default to chair-decisive and true, and persist", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "game-rule-"));
  try {
    const store = new SettingsStore(workspace);
    await store.put({ llm: { provider: "offline" }, gameReview: { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false } });
    assert.deepEqual(new SettingsStore(workspace).get().gameReview, { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false });
    for (const decisionRule of ["mean", "", 1, null, true]) {
      await assert.rejects(store.put({ gameReview: { threshold: 0.5, decisionRule } }), /gameReview.decisionRule must be "committee-mean" or "chair-decisive"/);
    }
    for (const leaveOneOut of ["true", 1, null, "false"]) {
      await assert.rejects(store.put({ gameReview: { threshold: 0.5, leaveOneOut } }), /gameReview.leaveOneOut must be a boolean/);
    }
    assert.deepEqual(store.get().gameReview, { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false });
    // The section is a replacement policy: an omitted field restores its spec default.
    await store.put({ gameReview: { threshold: 0.5, leaveOneOut: false } });
    assert.deepEqual(store.get().gameReview, { threshold: 0.5, decisionRule: "chair-decisive", leaveOneOut: false });
    await store.put({ gameReview: { threshold: 0.5, decisionRule: "committee-mean" } });
    assert.deepEqual(store.get().gameReview, { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: true });
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("game mode shares composition transport without changing off-mode old-bundle inputs", () => {
  const settings = defaultServerSettings();
  assert.equal(workflowParamsJson(settings), undefined);
  assert.deepEqual(JSON.parse(workflowParamsJson({ ...settings, gamifiedReview: true })!), { gamifiedReview: true, gameDecisionRule: "chair-decisive", gameDecisionThreshold: 0.5, gameInitialPoints: -1, gameLeaveOneOut: true });
  const composition = { ...settings, panelComposition: { params: { maxCalls: 200 } } };
  assert.deepEqual(JSON.parse(workflowParamsJson({ ...composition, gamifiedReview: true, gameReview: { threshold: 0.25, initialPoints: 0 } })!), { gamifiedReview: true, gameDecisionRule: "chair-decisive", gameDecisionThreshold: 0.25, gameInitialPoints: 0, gameLeaveOneOut: true, maxCalls: 200 });
  assert.deepEqual(JSON.parse(workflowParamsJson({ ...composition, gamifiedReview: true, gameReview: { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false } })!), { gamifiedReview: true, gameDecisionRule: "committee-mean", gameDecisionThreshold: 0.5, gameInitialPoints: -1, gameLeaveOneOut: false, maxCalls: 200 });
  assert.deepEqual(JSON.parse(workflowParamsJson({ ...composition, gamifiedReview: false, gameReview: { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false } })!), { maxCalls: 200 });
});

test("run policy is frozen before startup and follows checkpoint params after resume", () => {
  const snapshot = { gameReview: { threshold: 0.25, initialPoints: 0 } };
  // An unstarted run without the v3 fields takes the spec defaults; a started run follows its checkpoint,
  // and a checkpoint without the v3 params ran under a bundle without them: the legacy mean rule.
  assert.deepEqual(gameReviewConfiguration(undefined, snapshot), { ...snapshot.gameReview, decisionRule: "chair-decisive", leaveOneOut: true });
  assert.deepEqual(gameReviewConfiguration(undefined, { gameReview: { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false } }), { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false });
  assert.deepEqual(gameReviewConfiguration({ input: {} }, snapshot), { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false });
  assert.deepEqual(gameReviewConfiguration({ input: { __brainstormState: { params: { gameDecisionThreshold: 0.8, gameInitialPoints: -1 } } } }, snapshot), { threshold: 0.8, decisionRule: "committee-mean", leaveOneOut: false });
  assert.deepEqual(gameReviewConfiguration({ input: { __brainstormState: { params: { gameDecisionThreshold: 0, gameInitialPoints: 600 } } } }, snapshot), { threshold: 0, initialPoints: 600, decisionRule: "committee-mean", leaveOneOut: false });
  const v3 = { gameDecisionThreshold: 0.5, gameInitialPoints: -1, gameDecisionRule: "chair-decisive", gameLeaveOneOut: true };
  assert.deepEqual(gameReviewConfiguration({ input: { __brainstormState: { params: v3 } } }, { gameReview: { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false } }), { threshold: 0.5, decisionRule: "chair-decisive", leaveOneOut: true });
  assert.deepEqual(gameReviewConfiguration({ input: { __brainstormState: { params: { ...v3, gameDecisionRule: "committee-mean", gameLeaveOneOut: false } } } }, snapshot), { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false });
  assert.deepEqual(gameReviewConfiguration({ input: { __brainstormState: { params: { ...v3, gameDecisionRule: "majority", gameLeaveOneOut: "yes" } } } }, snapshot), { threshold: 0.5, decisionRule: "committee-mean", leaveOneOut: false });
});

test("per-run mode never inherits a newer setting once a legacy checkpoint exists", () => {
  assert.equal(gameReviewEnabled(undefined, undefined), false);
  assert.equal(gameReviewEnabled(undefined, { gamifiedReview: true }), true);
  assert.equal(gameReviewEnabled({ input: {} }, { gamifiedReview: true }), false);
  assert.equal(gameReviewEnabled({ input: { __brainstormState: { params: { gamifiedReview: true } } } }, { gamifiedReview: false }), true);
  assert.equal(gameReviewEnabled({ input: { __brainstormState: { params: { gamifiedReview: false } } } }, { gamifiedReview: true }), false);
});

test("game live paths use the same role and seat labels as recorded reports", () => {
  const panel = [{ id: "a", department: "A", umbrella: "A", subfields: [] }, { id: "b", department: "B", umbrella: "B", subfields: [] }];
  const prefix = "root/review-members/review-members-fanout/member[0]/cotStep[0]/loop/iter[0]";
  const critic = agentIdentity(`${prefix}/commentor[0]/game-comment-step-execute`, `brainstorm.${LIVE_NODE_SKILLS["game-comment-step"]}`, panel);
  assert.equal(critic.role, "Commenter");
  assert.equal(critic.actorId, "b");
  const chair = agentIdentity(`${prefix}/chair-step-execute`, `brainstorm.${LIVE_NODE_SKILLS["chair-step"]}`, panel);
  assert.equal(chair.role, "Committee chair");
  assert.equal(chair.seatId, "a");
  assert.equal(LIVE_NODE_SKILLS["game-comment-step-bridge"], "game-interdisciplinary-commentor");
  const reviser = agentIdentity(`${prefix}/game-redevelop-idea-execute`, `brainstorm.${LIVE_NODE_SKILLS["game-redevelop-idea"]}`, panel);
  assert.equal(reviser.role, "Redeveloper");
  assert.equal(reviser.actorId, "a");
});

test("active game containers and agent leaves retain their review phases", () => {
  const prefix = "root/review-members/member[0]/cotStep[0]/game-review-round/iter[0]/game-review-round-body";
  for (const node of ["gather-game-comments", "gather-game-comments/gather-game-comments-fanout/commentor[0]", "game-comment-step-execute", "game-comment-step-bridge-execute", "gather-comments", "comment-step-execute"]) {
    assert.equal(reviewPhaseForPath(`${prefix}/${node}`), "commenting", node);
  }
  for (const node of ["chair-step", "chair-step-execute", "game-settle", "game-settle-run", "judge-step-execute"]) {
    assert.equal(reviewPhaseForPath(`${prefix}/${node}`), "judging", node);
  }
  for (const node of ["game-redevelop-idea", "maybe-game-redevelop/then/game-redevelop-idea-execute", "redevelop-idea-execute"]) {
    assert.equal(reviewPhaseForPath(`${prefix}/${node}`), "redeveloping", node);
  }
  assert.equal(reviewPhaseForPath(prefix), undefined);
});

const chair = { reports: { b: { admissible: true, reason: "Specific report" } }, y: 1, reason: "A defect remains", issues: [] };
const settlement = {
  ruleVersion: "brier-peer/v1", version: "chain-v1", y: 1, status: "settled", admittedCount: 1,
  rows: [{ criticId: "b", q: 0.5, admissible: true, reason: "Specific report", brierLoss: 0.25, baseScore: 0, peerMeanBaseScore: null, score: 0 }],
  decision: { verdict: "Interrupt", reason: "A defect remains", issues: [] },
};

test("settlement projection preserves a scored zero and keeps rejected reports unscored", () => {
  assert.equal(gameSettlementView(settlement)?.rows[0]?.score, 0);
  assert.equal(gameSettlementView({ ...settlement, rows: [{ ...settlement.rows[0], admissible: false, score: -175 }] })?.rows[0]?.score, null);
  assert.equal(gameSettlementView({ ...settlement, rows: [{ ...settlement.rows[0], q: Infinity }] }), undefined);
});

const settlementV2 = {
  ...settlement, ruleVersion: "brier-peer/v2", meanQ: 0.5, threshold: 0.5,
  initialPoints: 0, ledgerSequence: 1, settlementId: "run/round1", criticIds: ["a", "b"],
  rows: [{ ...settlement.rows[0], balanceBefore: 0, balanceAfter: -25, excluded: true, score: -25 }],
  repairArguments: ["A possible major flaw"],
};

const settlementV3 = {
  ...settlementV2, ruleVersion: "brier-peer/v3", decisionRule: "chair-decisive", leaveOneOut: true, meanQ: 0.55, admittedCount: 2, criticIds: ["a", "b", "c"],
  rows: [
    { ...settlementV2.rows[0], q: 0.95, label: "decisive", scoringLabel: 1, brierLoss: 0.0025, baseScore: 24.75, peerMeanBaseScore: -56, score: 105.5, balanceBefore: 300, balanceAfter: 405.5, excluded: false },
    { criticId: "c", q: 0.1, admissible: true, reason: "Supported", label: "not-decisive", scoringLabel: 1, brierLoss: 0.81, baseScore: -56, peerMeanBaseScore: 24.75, score: -136.75, balanceBefore: 300, balanceAfter: 163.25, excluded: false },
    { criticId: "d", q: 0.4, admissible: false, reason: "Unsupported premise", label: "decisive", scoringLabel: 1, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null, balanceBefore: 300, balanceAfter: 300, excluded: false },
  ],
};

test("v3 projections carry the rule, chair labels and scoring labels; rejected reports keep none", () => {
  const committee = gameChairView({ reports: { b: { admissible: true, reason: "Holds", label: "decisive" }, c: { admissible: true, reason: "Style", label: "not-decisive" }, d: { admissible: false, reason: "Unsupported", label: "invalid" } }, reason: "Labelled", issues: [] }, []);
  assert.equal(committee?.reports.b?.label, "decisive");
  assert.equal(committee?.reports.c?.label, "not-decisive");
  assert.equal(committee?.reports.d?.label, "invalid");
  assert.equal(gameChairView({ reports: { b: { admissible: true, reason: "Holds", label: "major" } }, reason: "Labelled", issues: [] }, []), undefined);
  assert.equal(gameChairView({ reports: { b: { admissible: true, reason: "Holds" } }, reason: "No label" }, [])?.reports.b?.label, undefined);
  const view = gameSettlementView(settlementV3);
  assert.equal(view?.decisionRule, "chair-decisive");
  assert.equal(view?.leaveOneOut, true);
  assert.equal(view?.meanQ, 0.55);
  assert.deepEqual(view?.rows.map(row => [row.criticId, row.label, row.scoringLabel, row.score]), [["b", "decisive", 1, 105.5], ["c", "not-decisive", 1, -136.75], ["d", null, null, null]]);
  assert.equal(view?.rows[0]?.balanceAfter, 405.5);
  const leaveOneOut = gameSettlementView({ ...settlementV3, decisionRule: "committee-mean", leaveOneOut: true, rows: [{ ...settlementV3.rows[0], label: null, scoringLabel: null, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null, balanceAfter: 300 }] });
  assert.deepEqual(leaveOneOut?.rows.map(row => [row.label, row.scoringLabel, row.score]), [[null, null, null]], "a lone admitted critic is unscored under leave-one-out");
  assert.equal(leaveOneOut?.decisionRule, "committee-mean");
  assert.equal(gameSettlementView({ ...settlementV3, decisionRule: "majority" }), undefined);
  assert.equal(gameSettlementView({ ...settlementV3, leaveOneOut: "yes" }), undefined);
  assert.equal(gameSettlementView({ ...settlementV3, rows: [{ ...settlementV3.rows[0], label: "major" }] }), undefined);
  assert.equal(gameSettlementView({ ...settlementV3, rows: [{ ...settlementV3.rows[0], scoringLabel: 2 }] }), undefined);
  assert.equal(gameSettlementView({ ...settlementV3, rows: [{ ...settlementV3.rows[0], balanceAfter: NaN }] }), undefined, "v3 keeps the v2 balance checks");
  // v2 journals never grow v3 fields in projection.
  assert.equal("decisionRule" in gameSettlementView(settlementV2)!, false);
  assert.equal("label" in gameSettlementView(settlementV2)!.rows[0]!, false);
});

test("v3 invented-badge penalty rows project the floor score and their badges; other rejected rows stay unscored", () => {
  const rejected = { ...settlementV3.rows[2], score: -175, balanceAfter: 125 };
  const penaltyRow = { ...rejected, label: null, scoringLabel: null, penalty: "invented-badge", inventedBadges: ["F:7", "F:9"],
    reason: "Unsupported premise. Host verification: invented badges F:7, F:9 never issued in this run's fact table; penalty -175." };
  const penalised = { ...settlementV3, inventedBadgePenalty: true, rows: [settlementV3.rows[0], settlementV3.rows[1], penaltyRow] };
  const view = gameSettlementView(penalised);
  assert.equal(view?.inventedBadgePenalty, true);
  assert.deepEqual(view?.rows.map(row => [row.criticId, row.admissible, row.score]), [["b", true, 105.5], ["c", true, -136.75], ["d", false, -175]]);
  assert.deepEqual(view?.rows[2], { criticId: "d", q: 0.4, admissible: false, reason: penaltyRow.reason, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: -175,
    balanceBefore: 300, balanceAfter: 125, excluded: false, label: null, scoringLabel: null, penalty: "invented-badge", inventedBadges: ["F:7", "F:9"] });
  assert.equal("penalty" in view!.rows[0]!, false, "scored rows carry no penalty fields");
  // The same rejected report without the penalty fields still projects a null score.
  const plain = gameSettlementView({ ...penalised, rows: [rejected] });
  assert.equal(plain?.rows[0]?.score, null);
  assert.equal("penalty" in plain!.rows[0]!, false);
  assert.equal("inventedBadges" in plain!.rows[0]!, false);
  assert.equal("inventedBadgePenalty" in gameSettlementView(settlementV3)!, false, "gate off: the settlement carries no flag");
  // Rule versions before v3 never project a penalty.
  const v2 = gameSettlementView({ ...settlementV2, rows: [{ ...settlementV2.rows[0], admissible: false, score: -175, penalty: "invented-badge", inventedBadges: ["F:7"] }] });
  assert.equal(v2?.rows[0]?.score, null);
  assert.equal("penalty" in v2!.rows[0]!, false);
  // A malformed penalty row invalidates the settlement.
  for (const bad of [
    { penalty: "invented-badge" }, { inventedBadges: ["F:7"] }, { penalty: "integrity", inventedBadges: ["F:7"] },
    { penalty: "invented-badge", inventedBadges: [] }, { penalty: "invented-badge", inventedBadges: ["F:0"] }, { penalty: "invented-badge", inventedBadges: ["[F:7]"] },
    { penalty: "invented-badge", inventedBadges: ["F:7"], score: -174 }, { penalty: "invented-badge", inventedBadges: ["F:7"], score: null },
    { penalty: "invented-badge", inventedBadges: ["F:7"], admissible: true },
  ]) assert.equal(gameSettlementView({ ...penalised, rows: [{ ...rejected, ...bad }] }), undefined, JSON.stringify(bad));
  // Balances still come from balanceAfter.
  const ledger = gameLedgerFromJournal([{ kind: "activity", key: "root/round1/game-settle-run::result", value: penalised }]);
  assert.deepEqual(ledger?.critics.find(critic => critic.criticId === "d"), { criticId: "d", balance: 125, excluded: false, eligible: true });
});

test("ledger projection reads v3 dispatch receipts and settlements like v2", () => {
  const dispatch = { kind: "activity", key: "root/game-comment-step-dispatch::result", value: { kind: "gameCriticDispatch", ruleVersion: "brier-peer/v3", criticId: "b", criticIds: ["a", "b", "c"], initialPoints: 300, balance: 300, excluded: false, eligible: true, ledgerSequence: 0 } };
  const settle = { kind: "activity", key: "root/round1/game-settle-run::result", value: settlementV3 };
  const view = gameLedgerFromJournal([settle, dispatch]);
  assert.equal(view?.initialPoints, 300);
  assert.equal(view?.ledgerSequence, 1);
  assert.deepEqual(view?.critics.find(critic => critic.criticId === "b"), { criticId: "b", balance: 405.5, excluded: false, eligible: true });
  assert.deepEqual(view?.critics.find(critic => critic.criticId === "c"), { criticId: "c", balance: 163.25, excluded: false, eligible: true });
  assert.equal(gameLedgerFromJournal([{ ...dispatch, value: { ...dispatch.value, ruleVersion: "brier-peer/v4" } }]), undefined, "unknown rule versions never manufacture balances");
});

test("committee chair supplies checks without a label; host settlement carries mean and balances", () => {
  const committee = gameChairView({ reports: { b: { admissible: true, reason: "Specific", factChecks: [{ factId: "F:7", verifiedFactId: "F:9", badgeHash: `sha256:${"a".repeat(64)}`, approvalId: "A:test", conditions: "n > 0", supportsConclusion: true, reason: "Matches this scope" }] } }, reason: "Sanity checks complete" }, []);
  assert.equal(committee?.y, undefined);
  assert.equal(committee?.reports.b?.factChecks?.[0]?.conditions, "n > 0");
  assert.equal(committee?.reports.b?.factChecks?.[0]?.verifiedFactId, "F:9");
  assert.equal(committee?.reports.b?.factChecks?.[0]?.badgeHash, `sha256:${"a".repeat(64)}`);
  assert.equal(committee?.reports.b?.factChecks?.[0]?.approvalId, "A:test");
  const view = gameSettlementView(settlementV2);
  assert.equal(view?.meanQ, 0.5);
  assert.equal(view?.threshold, 0.5);
  assert.equal(view?.rows[0]?.balanceAfter, -25);
  assert.equal(view?.rows[0]?.excluded, true);
  assert.equal(gameSettlementView({ ...settlementV2, rows: [{ ...settlementV2.rows[0], balanceAfter: NaN }] }), undefined);
});

test("ledger projection starts from confirmed roster and orders durable commits before latching exclusion", () => {
  const dispatch = { kind: "activity", key: "root/game-comment-step-dispatch::result", value: { kind: "gameCriticDispatch", ruleVersion: "brier-peer/v2", criticId: "b", criticIds: ["a", "b"], initialPoints: 0, balance: 0, excluded: false, eligible: true, ledgerSequence: 0 } };
  const initial = gameLedgerFromJournal([dispatch]);
  assert.deepEqual(initial?.critics.map(critic => [critic.criticId, critic.balance, critic.eligible]), [["a", 0, true], ["b", 0, true]]);
  const confirmed = gameLedgerFromJournal([{ ...dispatch, value: { ...dispatch.value, criticIds: ["a", "b", "c", "custom"], initialPoints: 400, balance: 400 } }]);
  assert.equal(confirmed?.initialPoints, 400);
  assert.equal(confirmed?.critics.find(critic => critic.criticId === "custom")?.balance, 400);
  const first = { kind: "activity", key: "root/round1/game-settle-run::result", value: settlementV2 };
  const second = { kind: "activity", key: "root/round2/game-settle-run::result", value: { ...settlementV2, ledgerSequence: 2, settlementId: "run/round2", rows: [{ ...settlementV2.rows[0], balanceBefore: -25, balanceAfter: 5, score: 30, excluded: true }] } };
  const view = gameLedgerFromJournal([second, dispatch, first]);
  assert.equal(view?.ledgerSequence, 2);
  assert.deepEqual(view?.critics.find(critic => critic.criticId === "b"), { criticId: "b", balance: 5, excluded: true, eligible: false });
  assert.equal(gameLedgerFromJournal([{ ...first, value: settlement }]), undefined, "v1 scores never manufacture retirement balances");
});

test("real game journal paths project reports, chair and zero scores; the cap stays unresolved", () => {
  const workspace = mkdtempSync(join(tmpdir(), "game-mapper-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir);
    const prefix = "brainstorm-root/review-members/review-members-fanout/member[0]/cotStep[0]/game-review-round/iter[0]/game-review-round-body";
    const journal = [
      { key: `${prefix}/gather-game-comments/fanout/commentor[0]/else/game-comment-step-execute::result`, kind: "agent", value: { status: "ok", output: { q: 0.5, justification: "A possible defect" } } },
      { key: `${prefix}/chair-step/chair-step-execute::result`, kind: "agent", value: { status: "ok", output: chair } },
      { key: `${prefix}/game-settle/game-settle-run::result`, kind: "activity", value: settlement },
    ];
    writeFileSync(join(sessionDir, "checkpoint.json"), JSON.stringify({ runId: "j", workflowId: "brainstorm", status: "completed", input: { __brainstormState: { params: { gamifiedReview: true, maxReviewRounds: 1 } } }, journal, pendingGates: [], seq: 1, updatedAt: 1 }));
    writeFileSync(join(sessionDir, "artifacts", "index.json"), JSON.stringify({ refs: [{ id: "panel", metadata: { schema: "panel", path: "panel" } }, { id: "idea", metadata: { schema: "brainIdeaParts", path: "ideas.a" } }] }));
    writeFileSync(join(sessionDir, "artifacts", "panel"), JSON.stringify({ members: [{ id: "a", department: "A", umbrella: "A", subfields: [] }, { id: "b", department: "B", umbrella: "B", subfields: [] }] }));
    const originalStep = { part1: "A chain step", part2: "Assumption", part3: "Calculation", part4: "Conclusion" };
    writeFileSync(join(sessionDir, "artifacts", "idea"), JSON.stringify({ cot: [originalStep], output: { type: "research idea", paper: { abstract: ["Summary."], introduction: ["Context."], method: ["Method."], discussion: ["Discussion."], conclusion: ["Conclusion."] } }, novelty: "", literature: [] }));
    const detail = buildJobDetail({ record: { jobId: "j", topic: "topic", runner: "local", status: "completed", createdAt: 1, updatedAt: 1 }, status: "completed", sessionDir, jobDir, settings: defaultServerSettings() });
    const review = detail.stages.find((stage) => stage.id === "review-members");
    assert.ok(review?.id === "review-members");
    assert.equal(detail.gamifiedReview, true);
    assert.equal(review.gamifiedReview, true);
    const step = review.members[0]?.steps[0];
    assert.ok(step);
    assert.equal(step.outcome, "unresolved");
    assert.equal(step.rounds[0]?.gameCritiques?.[0]?.criticId, "b");
    assert.equal(step.rounds[0]?.gameChair?.reason, "A defect remains");
    assert.equal(step.rounds[0]?.gameSettlement?.rows[0]?.score, 0);
    assert.deepEqual(step.rounds[0]?.comments, []);

    // With another round available, the game-specific revision node replays
    // through the same patch merger and updates the live phase and final text.
    const rewritten = { ...originalStep, part1: "The repaired chain step" };
    const revision = { key: `${prefix}/maybe-game-redevelop/then/game-redevelop-idea-execute::result`, kind: "agent", value: { status: "ok", output: { steps: [{ index: 1, ...rewritten }], outputPatch: {} } } };
    writeFileSync(join(sessionDir, "checkpoint.json"), JSON.stringify({ runId: "j", workflowId: "brainstorm", status: "running", input: { __brainstormState: { params: { gamifiedReview: true, maxReviewRounds: 2 } } }, journal: [...journal, revision], pendingGates: [], seq: 2, updatedAt: 2 }));
    writeFileSync(join(jobDir, "events.jsonl"), `${JSON.stringify({ type: "node:started", seq: 1, at: 2, path: `${prefix}/maybe-game-redevelop/then/game-redevelop-idea-execute`, kind: "agent" })}\n`);
    const revisedDetail = buildJobDetail({ record: { jobId: "j", topic: "topic", runner: "local", status: "running", createdAt: 1, updatedAt: 2 }, status: "running", sessionDir, jobDir, settings: defaultServerSettings() });
    const revisedStage = revisedDetail.stages.find((stage) => stage.id === "review-members");
    assert.ok(revisedStage?.id === "review-members");
    assert.deepEqual(revisedStage.members[0]?.finalIdea?.cot[0], rewritten);
    assert.equal(revisedStage.members[0]?.revisionCount, 1);
    assert.equal(revisedStage.members[0]?.progress?.phase, "redeveloping");
    assert.deepEqual(revisedStage.members[0]?.steps[0]?.rounds[0]?.revision?.touchedSteps, [1]);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("v3 deleted-badge penalty rows project the floor score and their badges, alone or beside invented ones", () => {
  const rejected = { ...settlementV3.rows[2], score: -175, balanceAfter: 125, label: null, scoringLabel: null };
  const deletedRow = { ...rejected, penalty: "deleted-badge", deletedBadges: ["F:11", "F:9"],
    reason: "Unsupported premise. Host verification: deleted badges F:11, F:9 cited after their deletion from this run's fact table; penalty -175." };
  const bothRow = { ...rejected, criticId: "e", penalty: "invented-badge", inventedBadges: ["F:7"], deletedBadges: ["F:9"],
    reason: "Unsupported premise. Host verification: invented badge F:7 never issued in this run's fact table; deleted badge F:9 cited after its deletion from this run's fact table; penalty -175." };
  const penalised = { ...settlementV3, inventedBadgePenalty: true, deletedBadgePenalty: true, criticIds: ["a", "b", "c", "d", "e"], rows: [settlementV3.rows[0], deletedRow, bothRow] };
  const view = gameSettlementView(penalised);
  assert.equal(view?.deletedBadgePenalty, true);
  assert.equal(view?.inventedBadgePenalty, true);
  assert.deepEqual(view?.rows[1], { criticId: "d", q: 0.4, admissible: false, reason: deletedRow.reason, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: -175,
    balanceBefore: 300, balanceAfter: 125, excluded: false, label: null, scoringLabel: null, penalty: "deleted-badge", deletedBadges: ["F:11", "F:9"] });
  assert.equal("inventedBadges" in view!.rows[1]!, false);
  assert.deepEqual([view?.rows[2]?.penalty, view?.rows[2]?.inventedBadges, view?.rows[2]?.deletedBadges], ["invented-badge", ["F:7"], ["F:9"]]);
  assert.equal("deletedBadgePenalty" in gameSettlementView({ ...settlementV3, inventedBadgePenalty: true })!, false, "a settlement without fact updates carries no flag");
  // The deleted-badge penalty requires a settlement that enables it, and the row rules of the v3 schema.
  assert.equal(gameSettlementView({ ...penalised, deletedBadgePenalty: undefined }), undefined);
  for (const bad of [
    { penalty: "deleted-badge" }, { deletedBadges: ["F:9"] }, { penalty: "deleted-badge", deletedBadges: [] },
    { penalty: "deleted-badge", deletedBadges: ["F:0"] }, { penalty: "deleted-badge", deletedBadges: ["F:9"], inventedBadges: ["F:7"] },
    { penalty: "invented-badge", inventedBadges: ["F:7"], deletedBadges: ["[F:9]"] },
    { penalty: "deleted-badge", deletedBadges: ["F:9"], score: -174 }, { penalty: "deleted-badge", deletedBadges: ["F:9"], score: null },
    { penalty: "deleted-badge", deletedBadges: ["F:9"], admissible: true },
  ]) assert.equal(gameSettlementView({ ...penalised, rows: [{ ...rejected, ...bad }] }), undefined, JSON.stringify(bad));
  // Rule versions before v3 never project the penalty or the flag.
  const v2 = gameSettlementView({ ...settlementV2, deletedBadgePenalty: true, rows: [{ ...settlementV2.rows[0], admissible: false, score: -175, penalty: "deleted-badge", deletedBadges: ["F:9"] }] });
  assert.equal(v2?.rows[0]?.score, null);
  assert.equal("penalty" in v2!.rows[0]!, false);
  assert.equal("deletedBadgePenalty" in v2!, false);
});

test("fact-update merges, late merges and re-assessments project revised and withdrawn reports and re-assessed rounds", () => {
  const workspace = mkdtempSync(join(tmpdir(), "game-mapper-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir);
    const seat = "brainstorm-root/review-members/review-members-fanout/member[0]/review-steps/cotStep[0]";
    const game = `${seat}/game-review-round/game-review-round-loop/iter[0]/game-review-round-iteration/game-review-round-body`;
    const standard = "brainstorm-root/review-members/review-members-fanout/member[1]/review-steps/cotStep[0]/review-round/review-round-loop/iter[0]/review-round-iteration/review-round-body";
    const agent = (key: string, output: unknown) => ({ key, kind: "agent", value: { status: "ok", output } });
    const merge = (key: string, value: unknown) => ({ key, kind: "activity", value });
    const firstChair = { reports: { b: { admissible: true, reason: "Holds", label: "decisive" }, c: { admissible: true, reason: "Style only", label: "not-decisive" } }, reason: "First assessment of both reports", issues: [] };
    const secondChair = { reports: { b: { admissible: true, reason: "The revision still holds", label: "decisive" } }, reason: "Re-assessed after the withdrawal", issues: [] };
    const settlementOfB = { ...settlementV3, criticIds: ["a", "b", "c"], admittedCount: 1, rows: [{ ...settlementV3.rows[0], criticId: "b", q: 0.7 }] };
    const comment = (reason: string) => ({ verdict: "Interrupt", step: 1, reason, suggestion: "", evidence: { kind: "none", code: "", result: "", derivation: "", citation: "", locator: "", shows: "" } });
    const judge = (verdict: string, reason: string) => ({ verdict, reason, issues: verdict === "Pass" ? [] : [{ step: 1, point: "A gap", basis: "authority", mustAddress: true }], assessment: [{ commentorId: "a", basis: "authority" }, { commentorId: "c", basis: "authority" }] });
    const journal = [
      merge(`${game}/game-apply-fact-updates/game-apply-fact-updates-run::result`, { merged: [], discarded: [] }),
      agent(`${game}/gather-game-comments/fanout/commentor[0]/else/game-comment-step-execute::result`, { q: 0.8, justification: "Relies on [F:1] for the bound." }),
      agent(`${game}/gather-game-comments/fanout/commentor[1]/else/game-comment-step-execute::result`, { q: 0.3, justification: "Cites [F:1] as support." }),
      merge(`${game}/game-apply-report-updates/game-apply-report-updates-run::result`, { merged: [{ key: "game-report:a:1:1:b", taskId: "fact-update:game-report:a:1:1:b:1", notices: ["N:1"],
        output: { decision: "revised", reason: "Rebuilt without F:1.", report: { q: 0.7, justification: "The bound fails without the deleted badge." } }, epoch: 1 }], discarded: [] }),
      agent(`${game}/chair-step/chair-step-execute::result`, firstChair),
      merge(`${game}/game-apply-late-report-updates/game-apply-late-report-updates-run::result`, { merged: [{ key: "game-report:a:1:1:c", taskId: "fact-update:game-report:a:1:1:c:1", notices: ["N:1", "N:2"],
        output: { decision: "withdrawn", reason: "The report rested on F:1." } }], discarded: [], reassess: true }),
      agent(`${game}/maybe-game-chair-reassess/then/game-chair-reassess-execute::result`, secondChair),
      merge(`${game}/game-settle/game-settle-run::result`, settlementOfB),
      // Standard review of seat b: a comment the judge had is withdrawn, another revised, and the judge decides again.
      agent(`${standard}/gather-comments/gather-comments-fanout/commentor[0]/dispatch-comment/else/comment-step-execute::result`, comment("Step 1 cites [F:1] as support for the bound.")),
      agent(`${standard}/gather-comments/gather-comments-fanout/commentor[1]/dispatch-comment/else/comment-step-execute::result`, comment("Step 1 rests on [F:1] without checking it.")),
      merge(`${standard}/apply-comment-updates/apply-comment-updates-run::result`, { merged: [], discarded: [] }),
      agent(`${standard}/judge-step/judge-step-execute::result`, judge("Interrupt", "Both comments hold.")),
      merge(`${standard}/apply-late-comment-updates/apply-late-comment-updates-run::result`, { merged: [
        { key: "comment:b:1:1:a", taskId: "fact-update:comment:b:1:1:a:1", notices: ["N:1"], output: { decision: "withdrawn", reason: "The comment rested on F:1." } },
        { key: "comment:b:1:1:c", taskId: "fact-update:comment:b:1:1:c:1", notices: ["N:2"], output: { decision: "revised", reason: "Rebuilt.", comment: comment("Step 1 still needs its own bound.") } },
      ], discarded: [], reassess: true }),
      agent(`${standard}/maybe-judge-reassess/then/judge-reassess-execute::result`, judge("Pass", "Nothing decisive is left.")),
    ];
    writeFileSync(join(sessionDir, "checkpoint.json"), JSON.stringify({ runId: "j", workflowId: "brainstorm", status: "completed", input: { __brainstormState: { params: { gamifiedReview: true, maxReviewRounds: 2 } } }, journal, pendingGates: [], seq: 1, updatedAt: 1 }));
    writeFileSync(join(sessionDir, "fact-updates.jsonl"), [
      { type: "notice", id: "N:1", seq: 1, at: 10, deleted: "F:1", replacedBy: "F:5", notice: {}, subscribers: [] },
      { type: "notice", id: "N:2", seq: 2, at: 20, deleted: "F:2", notice: {}, subscribers: [] },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    writeFileSync(join(sessionDir, "artifacts", "index.json"), JSON.stringify({ refs: [{ id: "panel", metadata: { schema: "panel", path: "panel" } }, { id: "idea-a", metadata: { schema: "brainIdeaParts", path: "ideas.a" } }, { id: "idea-b", metadata: { schema: "brainIdeaParts", path: "ideas.b" } }] }));
    writeFileSync(join(sessionDir, "artifacts", "panel"), JSON.stringify({ members: ["a", "b", "c"].map((id) => ({ id, department: id, umbrella: id, subfields: [] })) }));
    const idea = JSON.stringify({ cot: [{ part1: "A chain step", part2: "Assumption", part3: "Calculation", part4: "Conclusion" }], output: { type: "research idea", paper: { abstract: ["Summary."], introduction: ["Context."], method: ["Method."], discussion: ["Discussion."], conclusion: ["Conclusion."] } }, novelty: "", literature: [] });
    writeFileSync(join(sessionDir, "artifacts", "idea-a"), idea);
    writeFileSync(join(sessionDir, "artifacts", "idea-b"), idea);
    const detail = buildJobDetail({ record: { jobId: "j", topic: "topic", runner: "local", status: "completed", createdAt: 1, updatedAt: 1 }, status: "completed", sessionDir, jobDir, settings: defaultServerSettings() });
    const review = detail.stages.find((stage) => stage.id === "review-members");
    assert.ok(review?.id === "review-members");
    const gameRound = review.members[0]?.steps[0]?.rounds[0];
    assert.ok(gameRound);
    assert.deepEqual(gameRound.gameCritiques?.map((report) => [report.criticId, report.q, report.revisedAfterFactUpdate]), [["b", 0.7, true], ["c", 0.3, undefined]]);
    assert.equal(gameRound.gameCritiques?.[0]?.justification, "The bound fails without the deleted badge.");
    assert.deepEqual(gameRound.withdrawnAfterFactUpdate, [{ criticId: "c", deleted: ["F:1", "F:2"] }]);
    assert.equal(gameRound.reassessed, true);
    assert.equal(gameRound.gameChair?.reason, "Re-assessed after the withdrawal");
    assert.equal(gameRound.firstAssessment?.gameChair?.reason, "First assessment of both reports");
    assert.deepEqual(gameRound.gameSettlement?.rows.map((row) => row.criticId), ["b"], "a withdrawn report is not settled");
    const standardRound = review.members[1]?.steps[0]?.rounds[0];
    assert.ok(standardRound);
    assert.deepEqual(standardRound.comments.map((entry) => [entry.commentorId, entry.reason, entry.revisedAfterFactUpdate]), [
      ["a", "Step 1 cites [F:1] as support for the bound.", undefined], ["c", "Step 1 still needs its own bound.", true]]);
    assert.deepEqual(standardRound.withdrawnAfterFactUpdate, [{ criticId: "a", deleted: ["F:1"] }]);
    assert.equal(standardRound.reassessed, true);
    assert.equal(standardRound.decision?.verdict, "Pass");
    assert.equal(standardRound.firstAssessment?.decision?.verdict, "Interrupt");
    assert.equal(review.members[1]?.steps[0]?.outcome, "passed", "the outcome follows the re-assessment");
    assert.equal("revisedAfterFactUpdate" in gameRound.gameCritiques![1]!, false, "an untouched report carries no flag");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("fact-update merge nodes and re-assessments have review phases, call names and live roles", () => {
  const prefix = "root/review-members/member[0]/cotStep[0]/game-review-round/iter[0]/game-review-round-body";
  for (const node of ["game-apply-report-updates", "game-apply-report-updates/game-apply-report-updates-run", "game-apply-late-report-updates", "maybe-game-chair-reassess",
    "maybe-game-chair-reassess/then/game-chair-reassess-execute", "apply-comment-updates", "apply-late-comment-updates/apply-late-comment-updates-run", "maybe-judge-reassess/then/judge-reassess-execute"]) {
    assert.equal(reviewPhaseForPath(`${prefix}/${node}`), "judging", node);
  }
  for (const node of ["game-apply-fact-updates", "game-apply-fact-updates/game-apply-fact-updates-run", "apply-fact-updates", "apply-fact-updates/apply-fact-updates-apply"]) {
    assert.equal(reviewPhaseForPath(`${prefix}/${node}`), "commenting", node);
  }
  assert.equal(reviewPhaseForPath("root/apply-fact-updates-after-review/apply-fact-updates-after-review-run"), undefined);
  assert.equal(LIVE_NODE_SKILLS["game-chair-reassess"], "committee-chair");
  assert.equal(LIVE_NODE_SKILLS["judge-reassess"], "judge");
  const panel = [{ id: "a", department: "A", umbrella: "A", subfields: [] }, { id: "b", department: "B", umbrella: "B", subfields: [] }];
  const chair = agentIdentity(`${prefix}/maybe-game-chair-reassess/then/game-chair-reassess-execute`, `brainstorm.${LIVE_NODE_SKILLS["game-chair-reassess"]}`, panel);
  assert.equal(chair.role, "Committee chair");
  assert.equal(chair.seatId, "a");
});
