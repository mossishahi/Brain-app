import assert from "node:assert/strict";
import test from "node:test";
import { artifactSchemas } from "@brainstorm-agentic/content";
import { factBadgeHash, factStandingRevision, factReportHash, factReviewVersion, type FactEntry, type FactUseApproval, type JournalEntry, type JsonObject, type JsonValue } from "@brainstorm-agentic/core";
import { COMMITTEE_SCORE_RULE, GameReviewLedger, LEGACY_COMMITTEE_SCORE_RULES, anonymizeRepairArgument, committeeFactView } from "../src/game-ledger.js";

const fact: FactEntry = { id: "F:1", status: "justified", kind: "math", claim: "The comparison requires its stated control.", conditions: "fixture conditions", method: "re-executed", evidence: "The deterministic check verifies the premise.", createdAt: 0, updatedAt: 0, history: [], requesters: [] };
const chain = [{ part1: "Claim", part2: "Ground", part3: "Consequence", part4: "Limit" }];
const panel = { members: ["member-1", "member-2", "member-3"].map((id) => ({ id })) };
const report = (q: number, justification = "The verified premise supports this assessment under its stated conditions [F:1].") => ({ q, justification });
const check = (factId = "F:1") => ({ factId, conditions: fact.conditions, supportsConclusion: true, reason: "The verified premise supports this conclusion under these conditions." });
type Label = "decisive" | "not-decisive" | "invalid";
function input(critiques: JsonObject, options: { points?: number; threshold?: number; rejected?: string[]; checks?: JsonObject[]; reason?: string;
  rule?: "committee-mean" | "chair-decisive"; leaveOneOut?: boolean; labels?: Record<string, Label> } = {}): JsonObject {
  return { critiques, chain, panel, initialPoints: options.points ?? 0, threshold: options.threshold ?? 0.5,
    ...(options.rule !== undefined ? { decisionRule: options.rule } : {}), ...(options.leaveOneOut !== undefined ? { leaveOneOut: options.leaveOneOut } : {}),
    chair: { reports: Object.fromEntries(Object.keys(critiques).map((id) => [id, { admissible: !options.rejected?.includes(id), reason: options.reason ?? "The argument addresses the reviewed scientific claim.",
      ...(options.labels?.[id] !== undefined ? { label: options.labels[id] } : {}), factChecks: options.checks ?? [check()] }])), reason: "The committee checked the premises and applicability of the submitted reports." } };
}
const rows = (settlement: JsonObject) => settlement.rows as JsonObject[];
const near = (actual: JsonValue | undefined, expected: number, message?: string) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, message ?? `${String(actual)} is not ${expected}`);
const journal = (settlement: JsonObject): JournalEntry => ({ key: `${settlement.settlementId}::result`, kind: "activity", value: settlement });

function approvedFixture() {
  const original: FactEntry = { ...fact, status: "disputed" };
  const target: FactEntry = { ...fact, id: "F:2", claim: "An appropriate control is necessary for the comparison.", conditions: "The comparison follows the fixture's assumptions." };
  const critique = report(0.9);
  const approval: FactUseApproval = { id: "approval-1", requesterTaskId: "r:chair-execute", reviewVersion: factReviewVersion(chain, 1),
    reportHash: factReportHash(critique), criticId: "member-1", citedBadgeId: original.id, citedBadgeHash: factBadgeHash(original),
    targetBadgeId: target.id, targetBadgeHash: factBadgeHash(target), targetStandingRevision: factStandingRevision(target),
    approved: true, reason: "Supreme checked the equivalent premise and its applicability to this exact submitted argument." };
  const params: JsonObject = { ...input({ "member-1": critique }, { checks: [{ ...check(), verifiedFactId: target.id, approvalId: approval.id, badgeHash: approval.citedBadgeHash }] }),
    factAccessMode: "supreme-mediated/v1", chairTaskId: approval.requesterTaskId };
  return { original, target, approval, params };
}

test("Supreme receipts permit semantic reformulation and replay without consulting or re-scoring", () => {
  const { original, target, approval, params } = approvedFixture();
  assert.notEqual(approval.citedBadgeHash, approval.targetBadgeHash);
  const ledger = new GameReviewLedger();
  const settled = ledger.settle("r", "r1", params, [original, target], { facts: [original, target], approvals: [approval] });
  assert.equal(settled.y, 1); assert.equal(rows(settled)[0]!.admissible, true);
  assert.match(String(rows(settled)[0]!.reason), /Supreme checked the equivalent premise/);
  assert.match(String((settled.repairArguments as string[])[0]), /\[F:2\]/);
  ledger.commit("r", settled);
  assert.deepEqual(ledger.settle("r", "r1", params, [], { facts: [], approvals: [] }), settled);
  const restored = new GameReviewLedger(); restored.hydrate("r", [journal(settled)]);
  assert.deepEqual(restored.dispatch("r", "after", "member-1", panel, 0), ledger.dispatch("r", "after", "member-1", panel, 0));
});

test("missing, denied, foreign, or stale Supreme receipts cannot admit a cited premise", () => {
  const variants: readonly Partial<FactUseApproval>[] = [
    { approved: false, reason: "The cited premise does not establish this conclusion." },
    { requesterTaskId: "different-chair" }, { reviewVersion: "different-version" }, { reportHash: "different-report" },
    { criticId: "member-2" }, { citedBadgeId: "F:999" }, { citedBadgeHash: `sha256:${"0".repeat(64)}` },
    { targetBadgeHash: `sha256:${"0".repeat(64)}` }, { targetStandingRevision: "stale-standing" },
  ];
  for (const change of [undefined, ...variants]) {
    const { original, target, approval, params } = approvedFixture();
    const settled = new GameReviewLedger().settle("r", "r1", params, [original, target], { facts: [original, target], approvals: change === undefined ? [] : [{ ...approval, ...change }] });
    assert.equal(settled.y, null, JSON.stringify(change)); assert.equal(rows(settled)[0]!.score, null);
  }
  for (const variant of ["original-revoked", "target-revoked", "target-content", "target-standing", "wrong-echo-hash"] as const) {
    const { original, target, approval, params } = approvedFixture();
    const facts: FactEntry[] = [{ ...original, ...(variant === "original-revoked" ? { status: "revoked" as const } : {}) },
      { ...target, ...(variant === "target-revoked" ? { status: "revoked" as const } : {}), ...(variant === "target-content" ? { conditions: "Only a different experiment." } : {}),
        ...(variant === "target-standing" ? { history: [{ at: 2, event: "upheld" as const, detail: "A new standing revision." }] } : {}) }];
    if (variant === "wrong-echo-hash") {
      const assessment = ((params.chair as JsonObject).reports as JsonObject)["member-1"] as Record<string, JsonValue>;
      assessment.factChecks = [{ ...check(), approvalId: approval.id, badgeHash: approval.targetBadgeHash }];
    }
    const settled = new GameReviewLedger().settle("r", "r1", params, facts, { facts, approvals: [approval] });
    assert.equal(settled.y, null, variant); assert.equal(rows(settled)[0]!.score, null);
  }
});

test("mediated direct reasoning requires no dummy approval but cited grouped fake badges still fail", () => {
  const direct = { ...input({ "member-1": report(0.1, "Under x>=0 the displayed conditional identity follows from its definition.") }, { checks: [] }), factAccessMode: "supreme-mediated/v1", chairTaskId: "r:chair" };
  assert.equal(new GameReviewLedger().settle("r", "r1", direct, [], { facts: [], approvals: [] }).y, 0);
  const { original, target, approval, params } = approvedFixture();
  const changed: JsonObject = { ...params, critiques: { "member-1": report(0.9, "The premise uses [F:1, F:999].") } };
  const settled = new GameReviewLedger().settle("r", "r1", changed, [original, target], { facts: [original, target], approvals: [approval] });
  assert.equal(settled.y, null); assert.equal(rows(settled)[0]!.score, null);
});

test("admitted direct reasoning with no badges receives normal low-q and high-q settlement and replay", () => {
  for (const q of [0.1, 0.9]) {
    const justification = q < 0.5
      ? "Under the stated x>=0 assumption, the definition of absolute value gives |x|=x; the displayed conditional inference is valid."
      : "The claimed identity |x|=x for every real x fails at x=-1: the left side is 1 and the right side is -1. Restrict x to nonnegative values.";
    const reason = "The argument is a directly inspectable conditional derivation or counterexample, with no separate unsupported factual claim.";
    const ledger = new GameReviewLedger();
    const settled = ledger.settle("direct", "direct-1", input({ "member-1": report(q, justification) }, { checks: [], reason }), []);
    assert.equal(settled.y, q < 0.5 ? 0 : 1); assert.equal(settled.admittedCount, 1);
    assert.equal(rows(settled)[0]!.admissible, true); assert.equal(rows(settled)[0]!.reason, reason);
    assert.ok(Math.abs(Number(rows(settled)[0]!.score) - 24) < 1e-12);
    assert.deepEqual(settled.repairArguments, q < 0.5 ? [] : [justification]);
    ledger.commit("direct", settled);
    const snapshot = ledger.dispatch("direct", "next", "member-1", panel, 0);
    ledger.commit("direct", settled);
    assert.deepEqual(ledger.dispatch("direct", "next", "member-1", panel, 0), snapshot);
    const replay = new GameReviewLedger(); replay.hydrate("direct", [journal(settled)]);
    assert.deepEqual(replay.dispatch("direct", "next", "member-1", panel, 0), snapshot);
  }
});

test("a rejected unsupported extra claim stays unscored with zero badges or one genuine badge", () => {
  for (const hasBadge of [false, true]) {
    const reason = "The report adds an unmeasured performance claim that does not follow from its conditional reasoning or cited premise.";
    const params = input({ "member-1": report(0.9, `The method is guaranteed to improve accuracy by 20%.${hasBadge ? " The stated control exists [F:1]." : ""}`) },
      { points: 100, rejected: ["member-1"], checks: hasBadge ? [check()] : [], reason });
    const settled = new GameReviewLedger().settle("r", "r1", params, hasBadge ? [fact] : []);
    assert.equal(settled.y, null); assert.equal(settled.admittedCount, 0);
    assert.equal(rows(settled)[0]!.admissible, false); assert.equal(rows(settled)[0]!.reason, reason);
    assert.equal(rows(settled)[0]!.score, null); assert.equal(rows(settled)[0]!.balanceAfter, 100);
    assert.deepEqual(settled.repairArguments, []);
  }
});

test("calling a report direct reasoning does not bypass its cited badge coverage", () => {
  for (const cited of ["F:1", "F:999"]) {
    const params = input({ "member-1": report(0.1, `This is described as direct reasoning but relies on the premise [${cited}].`) }, { checks: [] });
    const settled = new GameReviewLedger().settle("r", "r1", params, [fact]);
    assert.equal(settled.y, null); assert.equal(rows(settled)[0]!.admissible, false);
    assert.match(String(rows(settled)[0]!.reason), /fact checks must cover exactly/);
  }
});

test("committee uses admitted arithmetic mean, inclusive threshold, and unchanged peer Brier scores", () => {
  const ledger = new GameReviewLedger();
  const settled = ledger.settle("r", "round-1", input({ "member-1": report(0), "member-2": report(1), "member-3": report(0) }, { rejected: ["member-3"] }), [fact]);
  assert.equal(settled.meanQ, 0.5); assert.equal(settled.y, 1);
  assert.match(String((settled.decision as JsonObject).reason), /Blocked: 2 admitted reports have mean q=0.5, >= threshold 0.5; y=1/);
  assert.deepEqual(rows(settled).map((row) => [row.criticId, row.score]), [["member-1", -175], ["member-2", 125], ["member-3", null]]);
  assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
  const single = ledger.settle("single", "single-1", input({ "member-1": report(0.1) }), [fact]);
  assert.equal(rows(single)[0]!.score, 24); assert.equal(rows(single)[0]!.peerMeanBaseScore, null);
});

test("inputs without a decision rule settle as the legacy committee mean under the v3 record shape", () => {
  const ledger = new GameReviewLedger();
  const settled = ledger.settle("r", "round-1", input({ "member-1": report(0.2), "member-2": report(0.8), "member-3": report(0.9) }, { rejected: ["member-3"], labels: { "member-1": "not-decisive", "member-2": "decisive", "member-3": "decisive" } }), [fact]);
  assert.equal(COMMITTEE_SCORE_RULE, "brier-peer/v3"); assert.deepEqual([...LEGACY_COMMITTEE_SCORE_RULES], ["brier-peer/v2"]);
  assert.equal(settled.ruleVersion, "brier-peer/v3"); assert.equal(settled.decisionRule, "committee-mean"); assert.equal(settled.leaveOneOut, false);
  assert.equal(settled.y, 1);
  assert.deepEqual(rows(settled).map((row) => [row.criticId, row.label, row.scoringLabel]), [["member-1", "not-decisive", 1], ["member-2", "decisive", 1], ["member-3", null, null]]);
  near(rows(settled)[0]!.score, -99); near(rows(settled)[1]!.score, 81); assert.equal(rows(settled)[2]!.score, null);
  assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
  const explicit = new GameReviewLedger().settle("r", "round-1", { ...input({ "member-1": report(0.2), "member-2": report(0.8), "member-3": report(0.9) }, { rejected: ["member-3"], labels: { "member-1": "not-decisive", "member-2": "decisive", "member-3": "decisive" } }), decisionRule: "committee-mean", leaveOneOut: false }, [fact]);
  assert.deepEqual(explicit, settled);
  const unlabelled = new GameReviewLedger().settle("r", "round-1", input({ "member-1": report(0.2), "member-2": report(0.8) }), [fact]);
  assert.deepEqual(rows(unlabelled).map((row) => [row.label, row.scoringLabel]), [[null, 1], [null, 1]]);
  assert.equal(artifactSchemas.gameSettlement.safeParse(unlabelled).success, true);
  assert.throws(() => new GameReviewLedger().settle("r", "r1", input({ "member-1": report(0.2) }, { rule: "majority" as never }), [fact]), /committee-mean or chair-decisive/);
  assert.throws(() => new GameReviewLedger().settle("r", "r1", { ...input({ "member-1": report(0.2) }), leaveOneOut: "yes" }, [fact]), /leave-one-out scoring must be boolean/);
});

test("chair-decisive blocks on a decisive admitted label, scores every admitted report against y, and repairs only decisive arguments", () => {
  const ledger = new GameReviewLedger();
  const critiques = { "member-1": report(0.95, "The specialist argument identifies the missing control [F:1]."), "member-2": report(0.1, "The generalist argument sees no flaw [F:1]."), "member-3": report(0.9, "The rejected argument cites [F:1].") };
  const settled = ledger.settle("r", "r1", input(critiques, { rule: "chair-decisive", leaveOneOut: true, rejected: ["member-3"], labels: { "member-1": "decisive", "member-2": "not-decisive", "member-3": "decisive" } }), [fact]);
  assert.equal(settled.decisionRule, "chair-decisive"); assert.equal(settled.leaveOneOut, true);
  near(settled.meanQ, 0.525); assert.equal(settled.y, 1); assert.equal(settled.status, "settled");
  assert.match(String((settled.decision as JsonObject).reason), /^Blocked by a decisive argument: 1 of 2 admitted reports is labelled decisive/);
  assert.deepEqual(rows(settled).map((row) => [row.criticId, row.label, row.scoringLabel]), [["member-1", "decisive", 1], ["member-2", "not-decisive", 1], ["member-3", null, null]]);
  near(rows(settled)[0]!.score, 105.5); near(rows(settled)[1]!.score, -136.75);
  assert.deepEqual(settled.repairArguments, ["The specialist argument identifies the missing control [F:1]."]);
  assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
  // Under the mean rule the same reports pass: the specialist seat is overruled.
  const mean = new GameReviewLedger().settle("r", "r1", input(critiques, { rule: "committee-mean", rejected: ["member-3"], labels: { "member-1": "decisive", "member-2": "not-decisive", "member-3": "decisive" } }), [fact]);
  assert.equal(mean.y, 1); assert.equal(new GameReviewLedger().settle("r", "r1", input(critiques, { rule: "committee-mean", threshold: 0.6, rejected: ["member-3"], labels: { "member-1": "decisive", "member-2": "not-decisive", "member-3": "decisive" } }), [fact]).y, 0);
  // No decisive admitted label passes, whatever the admitted probabilities say.
  const pass = new GameReviewLedger().settle("r", "r1", input({ "member-1": report(0.9), "member-2": report(0.8) }, { rule: "chair-decisive", labels: { "member-1": "invalid", "member-2": "not-decisive" } }), [fact]);
  assert.equal(pass.y, 0); near(pass.meanQ, 0.85); assert.deepEqual(pass.repairArguments, []);
  assert.match(String((pass.decision as JsonObject).reason), /^Pass: no admitted argument is decisive/);
  assert.ok(rows(pass).every((row) => row.scoringLabel === 0 && Number(row.score) < 0));
  assert.equal(artifactSchemas.gameSettlement.safeParse(pass).success, true);
  // A host-rejected report's label is ignored and recorded as null, so it never decides y.
  const overridden = new GameReviewLedger().settle("r", "r1", input({ "member-1": report(0.9, "The premise is supported [F:1, F:999]."), "member-2": report(0.2) }, { rule: "chair-decisive", labels: { "member-1": "decisive", "member-2": "not-decisive" } }), [fact]);
  assert.equal(rows(overridden)[0]!.admissible, false); assert.equal(rows(overridden)[0]!.label, null); assert.equal(overridden.y, 0);
  // The rule needs the chair's label on every admitted report.
  assert.throws(() => new GameReviewLedger().settle("r", "r1", input({ "member-1": report(0.9), "member-2": report(0.2) }, { rule: "chair-decisive", labels: { "member-1": "decisive" } }), [fact]), /label on every admitted report/);
  const empty = new GameReviewLedger().settle("r", "r1", input({ "member-1": report(0.9) }, { rule: "chair-decisive", rejected: ["member-1"], labels: { "member-1": "decisive" } }), [fact]);
  assert.equal(empty.y, null); assert.equal(empty.status, "no-valid-reports");
  assert.equal(artifactSchemas.gameSettlement.safeParse(empty).success, true);
});

test("leave-one-out scores each report against the other admitted reports and leaves a lone admitted critic unscored", () => {
  const ledger = new GameReviewLedger();
  const settled = ledger.settle("r", "r1", input({ "member-1": report(0.9), "member-2": report(0), "member-3": report(0.4) }, { rule: "committee-mean", leaveOneOut: true, points: 100 }), [fact]);
  assert.equal(settled.y, 0); near(settled.meanQ, 1.3 / 3);
  assert.match(String((settled.decision as JsonObject).reason), /^Pass: 3 admitted reports have mean q=0\.4333+\d*, < threshold 0\.5; y=0\. Each report is scored against the label of the other admitted reports\. Committee assessment:/);
  // member-1 is scored against the others' mean 0.2 (label 0); member-2 against 0.65 (label 1); member-3 against 0.45 (label 0).
  assert.deepEqual(rows(settled).map((row) => [row.criticId, row.scoringLabel]), [["member-1", 0], ["member-2", 1], ["member-3", 0]]);
  near(rows(settled)[0]!.baseScore, -56); near(rows(settled)[1]!.baseScore, -75); near(rows(settled)[2]!.baseScore, 9);
  near(rows(settled)[0]!.peerMeanBaseScore, -33); near(rows(settled)[0]!.score, -79);
  near(rows(settled)[1]!.score, -126.5); near(rows(settled)[2]!.score, 83.5);
  assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
  ledger.commit("r", settled);
  const lone = ledger.settle("r", "r2", input({ "member-2": report(0.3), "member-3": report(1) }, { rule: "committee-mean", leaveOneOut: true, points: 100, rejected: ["member-2"] }), [fact]);
  assert.equal(lone.y, 1); assert.equal(lone.status, "settled"); assert.equal(lone.admittedCount, 1);
  const own = rows(lone)[1]!;
  assert.equal(own.criticId, "member-3"); assert.equal(own.admissible, true); assert.equal(own.scoringLabel, null);
  assert.deepEqual([own.brierLoss, own.baseScore, own.peerMeanBaseScore, own.score], [null, null, null, null]);
  assert.equal(own.balanceAfter, own.balanceBefore); near(own.balanceAfter, 183.5); assert.equal(own.excluded, false);
  assert.deepEqual(lone.repairArguments, ["The verified premise supports this assessment under its stated conditions [F:1]."]);
  assert.equal(artifactSchemas.gameSettlement.safeParse(lone).success, true);
  ledger.commit("r", lone);
  const history = ledger.dispatch("r", "d", "member-3", panel, 100).history as JsonObject[];
  assert.deepEqual(history.map((entry) => [entry.y, entry.label, entry.scoringLabel, entry.score === null ? null : Math.round(Number(entry.score) * 1e6) / 1e6]), [[0, null, 0, 83.5], [1, null, null, null]]);
  near(history[0]!.balanceAfter, 183.5); near(history[1]!.balanceAfter, 183.5);
  const scoredLone = new GameReviewLedger().settle("r", "r2", input({ "member-2": report(1) }, { rule: "chair-decisive", leaveOneOut: true, labels: { "member-2": "decisive" } }), [fact]);
  assert.equal(rows(scoredLone)[0]!.scoringLabel, 1); assert.equal(rows(scoredLone)[0]!.score, 25);
  const twoWithoutLeaveOneOut = new GameReviewLedger().settle("r", "r2", input({ "member-2": report(1), "member-3": report(0.3) }, { rule: "committee-mean", leaveOneOut: false, rejected: ["member-3"] }), [fact]);
  assert.equal(rows(twoWithoutLeaveOneOut)[0]!.score, 25);
});

test("identical .2 reports exactly at a .2 threshold are blocked without floating-point drift", () => {
  const ledger = new GameReviewLedger();
  const ids = Array.from({ length: 6 }, (_, index) => `member-${index + 1}`);
  const params = { ...input(Object.fromEntries(ids.map((id) => [id, report(0.2)])), { threshold: 0.2 }), panel: { members: ids.map((id) => ({ id })) } };
  const settled = ledger.settle("r", "r1", params, [fact]);
  assert.equal(settled.meanQ, 0.2); assert.equal(settled.y, 1);
  assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
});

test("automatic initial points use confirmed panel size; zero is explicit and zero balance is eligible", () => {
  const ledger = new GameReviewLedger();
  assert.equal(ledger.dispatch("auto", "d1", "member-1", panel, -1).balance, 300);
  assert.equal(ledger.dispatch("zero", "d1", "member-1", panel, 0).balance, 0);
  const settled = ledger.settle("zero", "r1", input({ "member-1": report(0.5) }), [fact]);
  ledger.commit("zero", settled);
  assert.equal(rows(settled)[0]!.score, 0);
  assert.equal(ledger.dispatch("zero", "d2", "member-1", panel, 0).eligible, true);
});

test("balance cancellation normalizes machine roundoff without forgiving a real small deficit", () => {
  for (const points of [6, 6 - 1e-10]) {
    const ledger = new GameReviewLedger();
    const settled = ledger.settle("r", "r1", input({ "member-1": report(0.4), "member-2": report(0.1) }, { points }), [fact]);
    const first = rows(settled)[0]!;
    assert.equal(settled.y, 0);
    assert.ok(Number(first.score) < -6, "the fixture reaches the floating-point cancellation boundary");
    if (points === 6) {
      assert.equal(first.balanceAfter, 0); assert.equal(first.excluded, false);
    } else {
      assert.ok(Number(first.balanceAfter) < -0.9e-10); assert.equal(first.excluded, true);
    }
    ledger.commit("r", settled);
    const snapshot = ledger.dispatch("r", "next", "member-1", panel, points);
    assert.equal(snapshot.eligible, points === 6);
    ledger.commit("r", settled);
    assert.deepEqual(ledger.dispatch("r", "next", "member-1", panel, points), snapshot);
    const replay = new GameReviewLedger(); replay.hydrate("r", [journal(settled)]);
    assert.deepEqual(replay.dispatch("r", "next", "member-1", panel, points), snapshot);
  }
});

test("negative balances latch exclusion, completed inflight reports still score, replay never debits twice", () => {
  const ledger = new GameReviewLedger();
  const first = ledger.settle("r", "r1", input({ "member-1": report(0.4), "member-2": report(0.6) }), [fact]);
  ledger.commit("r", first);
  assert.equal(ledger.dispatch("r", "after1", "member-1", panel, 0).eligible, false);
  const second = ledger.settle("r", "r2", input({ "member-1": report(1) }), [fact]); ledger.commit("r", second);
  const third = ledger.settle("r", "r3", input({ "member-1": report(1) }), [fact]); ledger.commit("r", third);
  const after = ledger.dispatch("r", "after3", "member-1", panel, 0);
  assert.ok(Number(after.balance) > 0); assert.equal(after.excluded, true); assert.equal(after.eligible, false);
  ledger.commit("r", third);
  assert.deepEqual(ledger.dispatch("r", "after3", "member-1", panel, 0), after);
  const replay = new GameReviewLedger(); replay.hydrate("r", [journal(third), journal(first), journal(second)]);
  assert.deepEqual(replay.dispatch("r", "after3", "member-1", panel, 0), after);
  assert.equal((after.history as JsonObject[]).length, 3);
  assert.ok((after.history as JsonObject[]).every((entry) => !Object.hasOwn(entry, "rows") && !Object.hasOwn(entry, "peerMeanBaseScore")));
  assert.equal((replay.dispatch("r", "own2", "member-2", panel, 0).history as JsonObject[]).length, 1);
});

test("invalid or grouped fake badges, stale conditions, and revoked premises are unscored", () => {
  for (const variant of ["missing", "grouped", "conditions", "revoked"] as const) {
    const ledger = new GameReviewLedger();
    const params = input({ "member-1": report(1, variant === "grouped" ? "The premise is supported [F:1, F:999]." : "The premise is supported [F:1].") });
    const assessment = ((params.chair as JsonObject).reports as JsonObject)["member-1"] as Record<string, JsonValue>;
    if (variant === "grouped") assessment.factChecks = [check(), check("F:999")];
    const facts = variant === "missing" ? [] : [{ ...fact, ...(variant === "conditions" ? { conditions: "changed conditions" } : {}), ...(variant === "revoked" ? { status: "revoked" as const } : {}) }];
    const settled = ledger.settle("r", "r1", params, facts);
    assert.equal(settled.y, null, variant); assert.equal(settled.meanQ, null, variant);
    assert.equal(rows(settled)[0]!.score, null); assert.equal(rows(settled)[0]!.balanceAfter, 0);
    assert.equal(settled.status, "no-valid-reports");
    assert.match(String((settled.decision as JsonObject).reason), /Unresolved: no reports were admitted/);
    assert.match(String((settled.decision as JsonObject).reason), /Host admission overrides/);
  }
});

test("only trusted identical reconciliation links replace private badges", () => {
  const original = { ...fact, status: "disputed" as const };
  const verified = { ...fact, id: "F:2" };
  for (const valid of [true, false]) {
    const params = input({ "member-1": report(1) });
    const assessment = ((params.chair as JsonObject).reports as JsonObject)["member-1"] as Record<string, JsonValue>;
    assessment.factChecks = [{ ...check(), verifiedFactId: "F:2" }];
    const settled = new GameReviewLedger().settle("r", "r1", params, [original, { ...verified, ...(valid ? {} : { claim: "The original claim was false." }) }]);
    assert.equal(settled.y, valid ? 1 : null);
    if (valid) { assert.match(String((settled.repairArguments as string[])[0]), /\[F:2\]/); assert.match(String(rows(settled)[0]!.reason), /F:1 -> F:2/); }
  }
  const view = committeeFactView({ "member-1": report(1) }, [original, verified]);
  assert.equal(view.length, 2); assert.ok(view.every((entry) => !Object.hasOwn(entry as object, "requesters")));
});

test("repair sees only admitted high-q arguments with explicit author identifiers removed", () => {
  const params = input({
    "member-1": report(0.9, "Author: Dr Fixture\nReviewer member-1: The high-q scientific argument uses [F:1]."),
    "member-2": report(0.3, "The low-q argument cites [F:1]."),
    "member-3": report(0.9, "The rejected argument cites [F:1]."),
  }, { rejected: ["member-3"] });
  const settled = new GameReviewLedger().settle("r", "r1", params, [fact]);
  assert.equal(settled.y, 1); assert.equal((settled.repairArguments as string[]).length, 1);
  const repair = (settled.repairArguments as string[])[0]!;
  assert.match(repair, /high-q scientific argument/); assert.doesNotMatch(repair, /member-[123]|Dr Fixture|Author:|Reviewer\s*:|low-q|rejected/);
  assert.equal(anonymizeRepairArgument("Reviewer: member-2 — denominator zero [F:1].\n", ["member-2"]), "denominator zero [F:1].");
});

test("dispatch waits for durable settlement commit; a failed commit stops later ledger work", async () => {
  const ledger = new GameReviewLedger();
  let release!: () => void;
  const saved = new Promise<void>((resolve) => { release = resolve; });
  const first = ledger.serialize("r", async () => {
    const settled = ledger.settle("r", "r1", input({ "member-1": report(0), "member-2": report(1) }), [fact]);
    await saved; ledger.commit("r", settled);
  });
  let dispatched = false;
  const second = ledger.serialize("r", async () => { dispatched = true; return ledger.dispatch("r", "next", "member-1", panel, 0); });
  await Promise.resolve(); assert.equal(dispatched, false);
  release(); await first; assert.equal((await second).eligible, false);
  await assert.rejects(ledger.serialize("failure", async () => { throw new Error("checkpoint save failed"); }), /checkpoint save failed/);
  await assert.rejects(ledger.serialize("failure", async () => ledger.dispatch("failure", "next", "member-1", panel, 0)), /checkpoint save failed/);
  ledger.hydrate("failure", []);
  assert.equal((await ledger.serialize("failure", async () => ledger.dispatch("failure", "next", "member-1", panel, 0))).eligible, true);
});
