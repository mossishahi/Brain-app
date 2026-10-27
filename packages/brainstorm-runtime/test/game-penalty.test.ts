import assert from "node:assert/strict";
import test from "node:test";
import { artifactSchemas, GAME_SCORE_FLOOR, gameSettlementV3Schema } from "@brainstorm-agentic/content";
import { factBadgeHash, factStandingRevision, factReportHash, factReviewVersion, type FactEntry, type FactUseApproval, type JournalEntry, type JsonObject, type JsonValue } from "@brainstorm-agentic/core";
import { GameReviewLedger, factIdsInValue } from "../src/game-ledger.js";

/**
 * Invented-badge penalty (spec/invented-badge.md section 7, T1-T10), through the
 * real settle(), commit() and settlement schema. A critic whose justification
 * cites a badge [F:n] never issued in the run's fact table, other than one
 * quoted in the reviewed chain or in its task input, is rejected and records
 * GAME_SCORE_FLOOR (-175) once, outside y, the labels, the repair arguments and
 * every peer mean. `inventedBadgePenalty` and `badgeSourceIds` are what the
 * compiler binds when the run enables params.gameInventedBadgePenalty in a
 * bundle with a fact table.
 */
type Rule = "committee-mean" | "chair-decisive";
type Label = "decisive" | "not-decisive" | "invalid";
type Gate = "on" | "off" | "absent";
interface Critic { readonly q: number; readonly justification?: string; readonly admissible?: boolean; readonly label?: Label; readonly checks?: readonly string[] }
interface Round { readonly gate?: Gate; readonly rule?: Rule; readonly points?: number; readonly chain?: JsonValue; readonly badgeSourceIds?: readonly string[]; readonly panel?: readonly string[] }

const fact: FactEntry = { id: "F:1", status: "justified", kind: "math", claim: "The comparison requires its stated control.", conditions: "fixture conditions", method: "re-executed", evidence: "The deterministic check verifies the premise.", createdAt: 0, updatedAt: 0, history: [], requesters: [] };
const chain = [{ part1: "Claim", part2: "Ground", part3: "Consequence", part4: "Limit" }];
const CHAIR_REASON = "The argument addresses the reviewed scientific claim.";
const HOST_TEXT = "invented badge F:999 never issued in this run's fact table; penalty -175";
const DIRECT = "Under the stated assumptions the displayed inference can be checked directly.";
const panelOf = (ids: readonly string[]) => ({ members: ids.map((id) => ({ id })) });
const rows = (settlement: JsonObject) => settlement.rows as JsonObject[];
const row = (settlement: JsonObject, id: string) => rows(settlement).find((entry) => entry.criticId === id)!;
const journal = (settlement: JsonObject): JournalEntry => ({ key: `${settlement.settlementId}::result`, kind: "activity", value: settlement });
const check = (factId: string) => ({ factId, conditions: fact.conditions, supportsConclusion: true, reason: "The verified premise supports this conclusion under these conditions." });
const offender = (q: number, change: Partial<Critic> = {}): Critic => ({ q, justification: "The cited result settles the comparison [F:999].", checks: ["F:999"], ...change });
const without = (value: JsonObject, ...keys: readonly string[]): JsonObject => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as JsonObject;
const editRow = (settlement: JsonObject, criticId: string, edit: (entry: JsonObject) => JsonObject): JsonObject =>
  ({ ...settlement, rows: rows(settlement).map((entry) => (entry.criticId === criticId ? edit(structuredClone(entry)) : entry)) });

function roundInput(critics: Record<string, Critic>, round: Round = {}): JsonObject {
  const gate = round.gate ?? "on";
  return {
    critiques: Object.fromEntries(Object.entries(critics).map(([id, critic]) => [id, { q: critic.q, justification: critic.justification ?? DIRECT }])),
    chain: round.chain ?? chain, panel: panelOf(round.panel ?? Object.keys(critics)), initialPoints: round.points ?? 300, threshold: 0.5,
    decisionRule: round.rule ?? "chair-decisive", leaveOneOut: true,
    ...(gate === "on" ? { inventedBadgePenalty: true, badgeSourceIds: [...(round.badgeSourceIds ?? [])] } : gate === "off" ? { inventedBadgePenalty: false } : {}),
    chair: {
      reports: Object.fromEntries(Object.entries(critics).map(([id, critic]) => [id, { admissible: critic.admissible ?? true, reason: CHAIR_REASON,
        label: critic.label ?? (critic.q >= 0.5 ? "decisive" : "not-decisive"), factChecks: (critic.checks ?? []).map(check) }])),
      reason: "The committee checked the premises and applicability of the submitted reports.",
    },
  };
}

function settle(input: JsonObject, facts: readonly FactEntry[] = [fact], ledger = new GameReviewLedger(), settlementId = "r:1"): JsonObject {
  const settled = ledger.settle("r", settlementId, input, facts);
  const parsed = artifactSchemas.gameSettlement.safeParse(settled);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  return settled;
}

test("T1 an invented badge records exactly -175; every other row, y, meanQ, admittedCount and repairArguments match the gate-off round", () => {
  assert.equal(GAME_SCORE_FLOOR, 2 * -75 - 25);
  for (const rule of ["chair-decisive", "committee-mean"] as const) {
    const critics: Record<string, Critic> = {
      a: { q: 0.9, justification: "The missing control breaks the comparison [F:1].", checks: ["F:1"] },
      b: { q: 0.2 },
      c: offender(0.95),
    };
    const on = settle(roundInput(critics, { rule }));
    const off = settle(roundInput(critics, { rule, gate: "absent" }));
    const penalised = row(on, "c");
    assert.equal(penalised.score, -175, rule);
    assert.deepEqual([penalised.balanceBefore, penalised.balanceAfter, penalised.excluded], [300, 125, false]);
    assert.deepEqual([penalised.admissible, penalised.label, penalised.scoringLabel, penalised.brierLoss, penalised.baseScore, penalised.peerMeanBaseScore], [false, null, null, null, null, null]);
    assert.equal(penalised.penalty, "invented-badge"); assert.deepEqual(penalised.inventedBadges, ["F:999"]);
    assert.equal(on.inventedBadgePenalty, true);
    assert.equal(rows(on).filter((entry) => entry.score === GAME_SCORE_FLOOR).length, 1);
    for (const id of ["a", "b"]) assert.deepEqual(row(on, id), row(off, id), `${rule}: ${id}`);
    for (const key of ["y", "meanQ", "admittedCount", "repairArguments", "status"]) assert.deepEqual(on[key], off[key], `${rule}: ${key}`);
    assert.equal((on.decision as JsonObject).verdict, (off.decision as JsonObject).verdict);
    assert.deepEqual([row(off, "c").admissible, row(off, "c").score, row(off, "c").balanceAfter], [false, null, 300], "with the gate off the report is merely rejected");
  }
});

test("T2 ids quoted in the reviewed chain or the critic's task input are exempt; an unbracketed mention is no citation", () => {
  const quoted = [{ part1: "The prior table entry [F:42] states the claim.", part2: "Ground", part3: "Consequence", part4: "Limit" }];
  const settled = settle(roundInput({
    a: { q: 0.2 },
    fromChain: { q: 0.9, justification: "The chain's premise [F:42] does not hold here.", checks: ["F:42"] },
    fromInput: { q: 0.9, justification: "The task input's result [F:43] does not hold here.", checks: ["F:43"] },
    plain: { q: 0.3, justification: "F:44 is mentioned without brackets, so the report cites no badge." },
    mixed: { q: 0.9, justification: "Both [F:42; F:45] apply.", checks: ["F:42", "F:45"] },
  }, { chain: quoted, badgeSourceIds: ["F:43"] }));
  for (const id of ["fromChain", "fromInput"]) {
    const exempt = row(settled, id);
    assert.deepEqual([exempt.admissible, exempt.score, exempt.balanceAfter], [false, null, 300], id);
    assert.equal(Object.hasOwn(exempt, "penalty"), false); assert.equal(Object.hasOwn(exempt, "inventedBadges"), false);
    assert.equal(exempt.reason, `${CHAIR_REASON} Host verification: ${id === "fromChain" ? "F:42" : "F:43"} is not a currently justified table entry.`);
  }
  assert.equal(row(settled, "plain").admissible, true); assert.equal(Object.hasOwn(row(settled, "plain"), "penalty"), false);
  assert.deepEqual([row(settled, "mixed").score, row(settled, "mixed").inventedBadges], [-175, ["F:45"]]);
  assert.equal(row(settled, "mixed").reason, `${CHAIR_REASON} Host verification: F:42 is not a currently justified table entry; invented badge F:45 never issued in this run's fact table; penalty -175.`,
    "the exempt id keeps its error; the invented id adds none");
  // One helper walks every string value, recursively; object keys are not scanned.
  assert.deepEqual(factIdsInValue({ "[F:5]": "an object key is not scanned", nested: [{ text: "see [F:3, F:12]" }, "[F:3]", 7, null, true], plain: "F:6" }), ["F:12", "F:3"]);
  assert.deepEqual(factIdsInValue(quoted), ["F:42"]);
  assert.deepEqual(factIdsInValue(undefined), []);
});

function mediatedFixture(critique: { readonly q: number; readonly justification: string } = { q: 0.9, justification: "The verified premise supports this assessment under its stated conditions [F:1]." }) {
  const original: FactEntry = { ...fact, status: "disputed" };
  const target: FactEntry = { ...fact, id: "F:2", claim: "An appropriate control is necessary for the comparison.", conditions: "The comparison follows the fixture's assumptions." };
  const approval: FactUseApproval = { id: "approval-1", requesterTaskId: "r:chair-execute", reviewVersion: factReviewVersion(chain, 1),
    reportHash: factReportHash(critique), criticId: "member-1", citedBadgeId: original.id, citedBadgeHash: factBadgeHash(original),
    targetBadgeId: target.id, targetBadgeHash: factBadgeHash(target), targetStandingRevision: factStandingRevision(target),
    approved: true, reason: "Supreme checked the equivalent premise and its applicability to this exact submitted argument." };
  const params: JsonObject = {
    critiques: { "member-1": critique, "member-2": { q: 0.1, justification: DIRECT } }, chain, panel: panelOf(["member-1", "member-2"]), initialPoints: 300, threshold: 0.5,
    decisionRule: "chair-decisive", leaveOneOut: true, inventedBadgePenalty: true, badgeSourceIds: [], factAccessMode: "supreme-mediated/v1", chairTaskId: approval.requesterTaskId,
    chair: { reports: {
      "member-1": { admissible: true, reason: CHAIR_REASON, label: "decisive", factChecks: [{ ...check("F:1"), verifiedFactId: target.id, approvalId: approval.id, badgeHash: approval.citedBadgeHash }] },
      "member-2": { admissible: true, reason: CHAIR_REASON, label: "not-decisive", factChecks: [] },
    }, reason: "The committee checked the premises and applicability of the submitted reports." },
  };
  return { original, target, approval, params };
}

test("T3 a cited badge issued in any status, or a missing, denied or mismatched Supreme approval, is rejected without a penalty", () => {
  for (const status of ["refuted", "revoked", "disputed"] as const) {
    const settled = settle(roundInput({ a: { q: 0.2 }, b: { q: 0.9, justification: "The table entry [F:7] decides it.", checks: ["F:7"] } }), [fact, { ...fact, id: "F:7", status }]);
    const b = row(settled, "b");
    assert.deepEqual([b.admissible, b.score, b.balanceAfter, Object.hasOwn(b, "penalty")], [false, null, 300, false], status);
    assert.equal(b.reason, `${CHAIR_REASON} Host verification: F:7 is not a currently justified table entry.`);
  }
  const approved = mediatedFixture();
  const admitted = new GameReviewLedger().settle("r", "r:1", approved.params, [approved.original, approved.target], { facts: [approved.original, approved.target], approvals: [approved.approval] });
  assert.equal(artifactSchemas.gameSettlement.safeParse(admitted).success, true);
  assert.equal(row(admitted, "member-1").admissible, true, "the approved receipt admits the report");
  const variants: readonly (readonly FactUseApproval[])[] = [
    [],
    [{ ...approved.approval, approved: false, reason: "The cited premise does not establish this conclusion." }],
    [{ ...approved.approval, criticId: "member-2" }],
  ];
  for (const approvals of variants) {
    const { original, target, params } = mediatedFixture();
    const settled = new GameReviewLedger().settle("r", "r:1", params, [original, target], { facts: [original, target], approvals: [...approvals] });
    assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
    const entry = row(settled, "member-1");
    assert.deepEqual([entry.admissible, entry.score, entry.balanceAfter, Object.hasOwn(entry, "penalty")], [false, null, 300, false], JSON.stringify(approvals));
    assert.doesNotMatch(String(entry.reason), /invented badge/);
    assert.equal(settled.inventedBadgePenalty, true);
  }
  // In the same mediated round, a cited id the table never issued is still invented.
  const grouped = mediatedFixture({ q: 0.9, justification: "The premise uses [F:1, F:999]." });
  const settled = new GameReviewLedger().settle("r", "r:1", grouped.params, [grouped.original, grouped.target], { facts: [grouped.original, grouped.target], approvals: [grouped.approval] });
  assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
  assert.deepEqual([row(settled, "member-1").score, row(settled, "member-1").inventedBadges], [-175, ["F:999"]]);
  assert.equal(row(settled, "member-1").reason, `${CHAIR_REASON} Host verification: ${HOST_TEXT}.`, "the approved badge adds no error and the invented one is not checked");
});

test("T4 several invented badges record one -175 and list every invented id", () => {
  const settled = settle(roundInput({ a: { q: 0.2 }, b: { q: 0.9, justification: "Results [F:9] and [F:12; F:7] decide it, with [F:1] and again [F:9].", checks: ["F:1", "F:7", "F:9", "F:12"] } }));
  const b = row(settled, "b");
  assert.deepEqual([b.score, b.balanceBefore, b.balanceAfter], [-175, 300, 125]);
  assert.deepEqual(b.inventedBadges, ["F:12", "F:7", "F:9"]);
  assert.equal(b.reason, `${CHAIR_REASON} Host verification: invented badges F:12, F:7, F:9 never issued in this run's fact table; penalty -175.`);
  assert.equal(rows(settled).filter((entry) => entry.score === GAME_SCORE_FLOOR).length, 1);
});

test("T5 a round with no admitted report still records the offender's penalty", () => {
  const rounds: readonly Record<string, Critic>[] = [{ a: offender(0.9) }, { a: offender(0.9), b: { q: 0.4, admissible: false } }];
  for (const critics of rounds) {
    const settled = settle(roundInput(critics));
    assert.deepEqual([settled.y, settled.status, settled.admittedCount, settled.meanQ, settled.repairArguments], [null, "no-valid-reports", 0, null, []]);
    assert.deepEqual([row(settled, "a").score, row(settled, "a").balanceAfter], [-175, 125]);
    if (critics.b !== undefined) assert.deepEqual([row(settled, "b").score, row(settled, "b").balanceAfter], [null, 300]);
    assert.equal((settled.decision as JsonObject).verdict, "Interrupt");
  }
});

test("T6 the penalty can take a balance below zero, which latches exclusion from further dispatch", () => {
  const ledger = new GameReviewLedger();
  const first = settle(roundInput({ a: { q: 0.2 }, b: offender(0.9) }, { points: 100 }), [fact], ledger, "r:1");
  assert.deepEqual([row(first, "b").balanceBefore, row(first, "b").balanceAfter, row(first, "b").excluded], [100, -75, true]);
  ledger.commit("r", first);
  assert.equal(ledger.isExcluded("r", "b"), true); assert.equal(ledger.isExcluded("r", "a"), false);
  const dispatch = ledger.dispatch("r", "r:dispatch-b", "b", panelOf(["a", "b"]), 100);
  assert.deepEqual([dispatch.balance, dispatch.excluded, dispatch.eligible], [-75, true, false]);
  const history = dispatch.history as JsonObject[];
  assert.equal(history.length, 1);
  assert.deepEqual([history[0]!.score, history[0]!.penalty, history[0]!.inventedBadges, history[0]!.admissible, history[0]!.label, history[0]!.balanceAfter, history[0]!.excluded],
    [-175, "invented-badge", ["F:999"], false, null, -75, true]);
  const second = settle(roundInput({ a: { q: 0.2 } }, { points: 100, panel: ["a", "b"] }), [fact], ledger, "r:2");
  ledger.commit("r", second);
  assert.equal(ledger.dispatch("r", "r:dispatch-b2", "b", panelOf(["a", "b"]), 100).eligible, false, "the latch holds");
  const zero = settle(roundInput({ a: { q: 0.2 }, b: offender(0.9) }, { points: 175 }));
  assert.deepEqual([row(zero, "b").balanceAfter, row(zero, "b").excluded], [0, false], "a balance of exactly zero stays eligible");
});

test("T7 commit replays penalty rows exactly on a fresh ledger; a tampered balanceAfter or penalty field is rejected", () => {
  // 175 + 2^-45 is the next double above 175: the exact floor arithmetic
  // leaves 2^-45, which the roundoff band of scored rows would snap to zero.
  const points = 175 + 2 ** -45;
  const panel = panelOf(["a", "b", "c"]);
  const ledger = new GameReviewLedger();
  const settled = [
    roundInput({ a: { q: 0.2 }, b: offender(0.9), c: { q: 0.8 } }, { points }),
    roundInput({ a: { q: 0.6 }, b: { q: 0.1 }, c: { q: 0.7, justification: "Two results [F:998] and [F:997] decide it.", checks: ["F:997", "F:998"] } }, { points }),
  ].map((input, index) => {
    const value = settle(input, [fact], ledger, `r:${index + 1}`);
    ledger.commit("r", value);
    return value;
  });
  assert.deepEqual([row(settled[0]!, "b").balanceAfter, row(settled[0]!, "b").excluded], [2 ** -45, false]);
  assert.equal(row(settled[1]!, "c").balanceBefore, row(settled[0]!, "c").balanceAfter);
  assert.equal(row(settled[1]!, "c").balanceAfter, Number(row(settled[0]!, "c").balanceAfter) + GAME_SCORE_FLOOR);
  const restored = new GameReviewLedger();
  restored.hydrate("r", settled.map(journal).reverse());
  for (const id of ["a", "b", "c"]) assert.deepEqual(restored.dispatch("r", "r:final", id, panel, points), ledger.dispatch("r", "r:final", id, panel, points), id);
  const history = ledger.dispatch("r", "r:final", "c", panel, points).history as JsonObject[];
  assert.deepEqual(history.map((entry) => [Object.hasOwn(entry, "penalty"), entry.inventedBadges ?? null]), [[false, null], [true, ["F:997", "F:998"]]]);
  const tampered = (edit: (settlement: JsonObject) => JsonObject) => () => new GameReviewLedger().hydrate("r", [journal(edit(structuredClone(settled[0]!)))]);
  // Within the schema's relative tolerance, so only commit's exact arithmetic catches it.
  assert.equal(artifactSchemas.gameSettlement.safeParse(editRow(settled[0]!, "b", (entry) => ({ ...entry, balanceAfter: 0 }))).success, true);
  assert.throws(tampered((value) => editRow(value, "b", (entry) => ({ ...entry, balanceAfter: 0 }))), /inconsistent/);
  assert.throws(tampered((value) => editRow(value, "b", (entry) => ({ ...entry, balanceAfter: Number(entry.balanceAfter) + 1 }))));
  assert.throws(tampered((value) => editRow(value, "b", (entry) => without(entry, "penalty"))));
  assert.throws(tampered((value) => editRow(value, "b", (entry) => without(entry, "penalty", "inventedBadges"))));
  assert.throws(tampered((value) => editRow(value, "b", (entry) => ({ ...entry, score: -174, balanceAfter: Number(entry.balanceBefore) - 174 }))));
  assert.throws(tampered((value) => without(value, "inventedBadgePenalty")));
  assert.doesNotThrow(tampered((value) => value));
});

test("T8 with the gate absent or false the settlement is today's v3 output", () => {
  const critics: Record<string, Critic> = { a: { q: 0.2 }, b: offender(0.9) };
  const absent = settle(roundInput(critics, { gate: "absent" }));
  const off = settle(roundInput(critics, { gate: "off" }));
  assert.deepEqual(off, absent);
  assert.deepEqual(Object.keys(absent), ["ruleVersion", "settlementId", "ledgerSequence", "version", "criticIds", "initialPoints", "decisionRule", "leaveOneOut", "meanQ", "threshold", "y", "status", "admittedCount", "rows", "repairArguments", "decision"]);
  for (const entry of rows(absent)) assert.deepEqual(Object.keys(entry), ["criticId", "q", "admissible", "reason", "label", "scoringLabel", "brierLoss", "baseScore", "peerMeanBaseScore", "score", "balanceBefore", "balanceAfter", "excluded"]);
  const b = row(absent, "b");
  assert.deepEqual([b.admissible, b.score, b.balanceAfter], [false, null, 300]);
  assert.equal(b.reason, `${CHAIR_REASON} Host verification: F:999 is not a currently justified table entry.`);
  assert.deepEqual(row(settle(roundInput(critics)), "a"), row(absent, "a"));
});

test("T9 the schema rejects a penalty row with another score, admitted, without inventedBadges, or outside a penalty settlement", () => {
  const settled = settle(roundInput({ a: { q: 0.2 }, b: offender(0.9) }));
  const index = rows(settled).findIndex((entry) => entry.criticId === "b");
  const paths = (value: JsonObject): string[] => {
    const parsed = gameSettlementV3Schema.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.map(String).join("."));
  };
  assert.deepEqual(paths(settled), []);
  assert.ok(paths(editRow(settled, "b", (entry) => ({ ...entry, score: -174, balanceAfter: Number(entry.balanceBefore) - 174 }))).includes(`rows.${index}.score`));
  assert.ok(paths(editRow(settled, "b", (entry) => ({ ...entry, admissible: true }))).includes(`rows.${index}`));
  assert.ok(paths(editRow(settled, "b", (entry) => without(entry, "inventedBadges"))).includes(`rows.${index}.penalty`));
  assert.ok(paths(without(settled, "inventedBadgePenalty")).includes(`rows.${index}.penalty`));
  assert.equal(artifactSchemas.gameSettlement.safeParse(without(settled, "inventedBadgePenalty")).success, false);
  for (const inventedBadges of [[], ["F:999", "F:999"], ["F:999", "F:12"], ["F:0"], ["999"]]) {
    assert.notDeepEqual(paths(editRow(settled, "b", (entry) => ({ ...entry, inventedBadges }))), [], JSON.stringify(inventedBadges));
  }
  const changes: readonly JsonObject[] = [{ penalty: "other" }, { label: "decisive" }, { scoringLabel: 0 }, { brierLoss: 0 }, { baseScore: -75 }, { peerMeanBaseScore: 25 }];
  for (const change of changes) assert.notDeepEqual(paths(editRow(settled, "b", (entry) => ({ ...entry, ...change }))), [], JSON.stringify(change));
  assert.notDeepEqual(paths(editRow(settled, "a", (entry) => ({ ...entry, penalty: "invented-badge" }))), [], "an admitted row cannot carry a penalty");
});

test("T10 the host overrides a chair-admitted offending report; its reason lists only the errors about other badges, then the exact host text", () => {
  const settled = settle(roundInput({ a: { q: 0.2 }, b: offender(0.9) }));
  const b = row(settled, "b");
  assert.equal(b.admissible, false);
  assert.equal(b.reason, `${CHAIR_REASON} Host verification: ${HOST_TEXT}.`);
  assert.ok(String((settled.decision as JsonObject).reason).includes(` Host admission overrides: b: ${String(b.reason)}`));
  const rejected = row(settle(roundInput({ a: { q: 0.2 }, b: offender(0.9, { admissible: false }) })), "b");
  assert.deepEqual([rejected.score, rejected.reason], [-175, `${CHAIR_REASON} Host verification: ${HOST_TEXT}.`], "whatever the chair decided");
  const unchecked = row(settle(roundInput({ a: { q: 0.2 }, b: offender(0.9, { checks: [] }) })), "b");
  assert.equal(unchecked.reason, `${CHAIR_REASON} Host verification: ${HOST_TEXT}.`, "coverage ignores the invented id");
  // Errors about a real badge in the same report stay, in order, before the host text.
  const refuted = [fact, { ...fact, id: "F:7", status: "refuted" as const }];
  const realError = offender(0.9, { justification: "The refuted entry [F:7] and the result [F:999] settle it.", checks: ["F:7", "F:999"] });
  assert.equal(row(settle(roundInput({ a: { q: 0.2 }, b: realError }), refuted), "b").reason,
    `${CHAIR_REASON} Host verification: F:7 is not a currently justified table entry; ${HOST_TEXT}.`);
  const uncovered = offender(0.9, { justification: "The control [F:1] and the result [F:999] settle it.", checks: ["F:999"] });
  assert.equal(row(settle(roundInput({ a: { q: 0.2 }, b: uncovered })), "b").reason,
    `${CHAIR_REASON} Host verification: fact checks must cover exactly the cited supporting badges; F:1 conditions do not match the verified fact; F:1 does not support the report's conclusion under those conditions; ${HOST_TEXT}.`,
    "the chair's check of the invented id does not cover the real one");
  // With the gate off the same reports keep today's errors, including those about the never-issued id.
  assert.equal(row(settle(roundInput({ a: { q: 0.2 }, b: realError }, { gate: "absent" }), refuted), "b").reason,
    `${CHAIR_REASON} Host verification: F:7 is not a currently justified table entry; F:999 is not a currently justified table entry.`);
  assert.equal(row(settle(roundInput({ a: { q: 0.2 }, b: uncovered }, { gate: "off" })), "b").reason,
    `${CHAIR_REASON} Host verification: fact checks must cover exactly the cited supporting badges; F:1 conditions do not match the verified fact; F:1 does not support the report's conclusion under those conditions; F:999 is not a currently justified table entry.`);
});

// ---------------------------------------------------------------------------
// Fact updates (spec/fact-updates.md section 7 and decisions D4, D12; section
// 10 tests 9-16). With the control's `updates`, review.committeeSettle is
// bound the run's deletions (id and deletion sequence), each report's request
// epoch and, with the invented-badge penalty on, the fine for a badge deleted
// before the report was requested.
// ---------------------------------------------------------------------------

const DELETED_TEXT = "deleted badge F:7 cited after its deletion from this run's fact table; penalty -175";
const CITES_F7: Critic = { q: 0.9, justification: "The deleted result decides the comparison [F:7].", checks: ["F:7"] };

/** What the compiler binds and the settle handler adds with fact updates (design 6.6). */
function withUpdates(
  input: JsonObject,
  deletions: readonly { readonly id: string; readonly seq: number }[],
  reportEpochs: Readonly<Record<string, number>>,
  fine: boolean = input.inventedBadgePenalty === true,
): JsonObject {
  return {
    ...input,
    deletions: deletions.map((deletion) => ({ ...deletion, at: 5_000 })),
    reportEpochs: { ...reportEpochs },
    badgeSourceIds: input.badgeSourceIds ?? [],
    ...(fine ? { deletionPenalty: true } : {}),
  };
}

test("F9 a badge deleted before the report was requested, cited as support, records -175 with the exact reason", () => {
  // F:7 is deletion 1; both reports were requested at epoch 1, after it.
  const settled = settle(withUpdates(roundInput({ a: { q: 0.2 }, b: CITES_F7 }), [{ id: "F:7", seq: 1 }], { a: 1, b: 1 }));
  const b = row(settled, "b");
  assert.deepEqual([b.admissible, b.label, b.scoringLabel, b.score, b.balanceBefore, b.balanceAfter], [false, null, null, -175, 300, 125]);
  assert.equal(b.penalty, "deleted-badge");
  assert.deepEqual(b.deletedBadges, ["F:7"]);
  assert.equal(Object.hasOwn(b, "inventedBadges"), false);
  assert.equal(b.reason, `${CHAIR_REASON} Host verification: ${DELETED_TEXT}.`);
  assert.equal(settled.deletedBadgePenalty, true);
  assert.equal(row(settled, "a").admissible, true);
  // The chair's check of the deleted id is not required: coverage ignores it.
  const unchecked = row(settle(withUpdates(roundInput({ a: { q: 0.2 }, b: { ...CITES_F7, checks: [] } }), [{ id: "F:7", seq: 1 }], { a: 1, b: 1 })), "b");
  assert.equal(unchecked.reason, `${CHAIR_REASON} Host verification: ${DELETED_TEXT}.`);
});

test("F10 a badge deleted after the report was requested rejects it without a fine, with the exact host error", () => {
  const settled = settle(withUpdates(roundInput({ a: { q: 0.2 }, b: CITES_F7 }), [{ id: "F:7", seq: 1 }], { a: 0, b: 0 }));
  const b = row(settled, "b");
  assert.deepEqual([b.admissible, b.score, b.balanceAfter, Object.hasOwn(b, "penalty"), Object.hasOwn(b, "deletedBadges")], [false, null, 300, false, false]);
  assert.equal(b.reason, `${CHAIR_REASON} Host verification: F:7 was deleted from this run's fact table after this report was requested.`);
  // Without the fine, a badge deleted before the request is rejected the same way, with its own error.
  const unfined = row(settle(withUpdates(roundInput({ a: { q: 0.2 }, b: CITES_F7 }, { gate: "absent" }), [{ id: "F:7", seq: 1 }], { a: 1, b: 1 })), "b");
  assert.deepEqual([unfined.admissible, unfined.score, unfined.balanceAfter, Object.hasOwn(unfined, "penalty")], [false, null, 300, false]);
  assert.equal(unfined.reason, `${CHAIR_REASON} Host verification: F:7 was deleted from this run's fact table before this report was requested.`);
});

test("F11 a deleted id quoted from the reviewed chain or the task input is admissible with no fact check", () => {
  const quoting: Critic = { q: 0.9, justification: "The step quotes [F:7]; the argument stands on its own derivation." };
  const quotedChain = [{ ...chain[0]!, part2: "Ground, as [F:7] once stated" }];
  for (const checks of [[], ["F:7"]] as const) {
    for (const round of [{ chain: quotedChain }, { badgeSourceIds: ["F:7"] }] as const) {
      const settled = settle(withUpdates(roundInput({ a: { q: 0.2 }, b: { ...quoting, checks } }, round), [{ id: "F:7", seq: 1 }], { a: 1, b: 1 }));
      const b = row(settled, "b");
      assert.deepEqual([b.admissible, b.reason, Object.hasOwn(b, "penalty")], [true, CHAIR_REASON, false], JSON.stringify({ checks, round }));
      assert.equal(typeof b.score, "number");
    }
  }
});

test("F12 an invented and a deleted-before badge in one report record one -175, both lists, and the combined text", () => {
  const both: Critic = { q: 0.9, justification: "The results [F:7] and [F:999] decide it.", checks: ["F:7", "F:999"] };
  const settled = settle(withUpdates(roundInput({ a: { q: 0.2 }, b: both }), [{ id: "F:7", seq: 1 }], { a: 1, b: 1 }));
  const b = row(settled, "b");
  assert.deepEqual([b.score, b.balanceAfter, b.penalty, b.inventedBadges, b.deletedBadges], [-175, 125, "invented-badge", ["F:999"], ["F:7"]]);
  assert.equal(b.reason, `${CHAIR_REASON} Host verification: invented badge F:999 never issued in this run's fact table; ${DELETED_TEXT}.`);
  assert.equal(rows(settled).filter((entry) => entry.score === GAME_SCORE_FLOOR).length, 1);
});

test("F13 with no deletion, or with the gate absent, the settlement is today's v3 output", () => {
  const critics: Record<string, Critic> = { a: { q: 0.2 }, b: offender(0.9), c: { q: 0.7, justification: "The control breaks it [F:1].", checks: ["F:1"] } };
  for (const gate of ["on", "off", "absent"] as const) {
    const today = settle(roundInput(critics, { gate }));
    assert.deepEqual(settle({ ...roundInput(critics, { gate }), deletions: [], reportEpochs: {} }), today, gate);
  }
  const absent = settle(withUpdates(roundInput({ a: { q: 0.2 }, b: CITES_F7 }, { gate: "absent" }), [{ id: "F:7", seq: 1 }], { a: 1, b: 1 }));
  assert.deepEqual(Object.keys(absent), ["ruleVersion", "settlementId", "ledgerSequence", "version", "criticIds", "initialPoints", "decisionRule", "leaveOneOut", "meanQ", "threshold", "y", "status", "admittedCount", "rows", "repairArguments", "decision"]);
  for (const entry of rows(absent)) assert.deepEqual(Object.keys(entry), ["criticId", "q", "admissible", "reason", "label", "scoringLabel", "brierLoss", "baseScore", "peerMeanBaseScore", "score", "balanceBefore", "balanceAfter", "excluded"]);
});

test("F14 commit replays deleted-badge rows exactly; tampered rows and settlements are rejected", () => {
  const panel = panelOf(["a", "b"]);
  const ledger = new GameReviewLedger();
  const value = settle(withUpdates(roundInput({ a: { q: 0.2 }, b: CITES_F7 }), [{ id: "F:7", seq: 1 }], { a: 1, b: 1 }), [fact], ledger, "r:1");
  ledger.commit("r", value);
  const restored = new GameReviewLedger();
  restored.hydrate("r", [journal(value)]);
  for (const id of ["a", "b"]) assert.deepEqual(restored.dispatch("r", "r:final", id, panel, 300), ledger.dispatch("r", "r:final", id, panel, 300), id);
  const history = ledger.dispatch("r", "r:final", "b", panel, 300).history as JsonObject[];
  assert.deepEqual(history.map((entry) => [entry.penalty ?? null, entry.deletedBadges ?? null]), [["deleted-badge", ["F:7"]]]);
  const tampered = (edit: (settlement: JsonObject) => JsonObject) => () => new GameReviewLedger().hydrate("r", [journal(edit(structuredClone(value)))]);
  assert.throws(tampered((settlement) => editRow(settlement, "b", (entry) => without(entry, "deletedBadges"))));
  assert.throws(tampered((settlement) => editRow(settlement, "b", (entry) => without(entry, "penalty", "deletedBadges"))));
  assert.throws(tampered((settlement) => editRow(settlement, "b", (entry) => ({ ...entry, balanceAfter: Number(entry.balanceAfter) + 1 }))));
  assert.throws(tampered((settlement) => without(settlement, "deletedBadgePenalty")));
  assert.doesNotThrow(tampered((settlement) => settlement));
  assert.equal(gameSettlementV3Schema.safeParse(editRow(value, "b", (entry) => without(entry, "deletedBadges"))).success, false);
  assert.equal(gameSettlementV3Schema.safeParse(without(value, "deletedBadgePenalty")).success, false);
});

test("F15 a withdrawn report has no row; an unchanged report with the chair is rejected without a fine; a revision takes its task's epoch", () => {
  // a's report was withdrawn after F:7's deletion (seq 1): the late merge removed it from the round.
  // b was with the chair (requested at epoch 0) and came back unchanged; c was revised at epoch 1.
  const revised: Critic = { q: 0.8, justification: "The missing control breaks the comparison [F:1].", checks: ["F:1"] };
  const ledger = new GameReviewLedger();
  const settled = settle(withUpdates(roundInput({ b: CITES_F7, c: revised }, { panel: ["a", "b", "c"] }), [{ id: "F:7", seq: 1 }], { b: 0, c: 1 }), [fact], ledger);
  assert.deepEqual(rows(settled).map((entry) => entry.criticId), ["b", "c"]);
  const b = row(settled, "b");
  assert.deepEqual([b.admissible, b.score, b.balanceAfter, Object.hasOwn(b, "penalty")], [false, null, 300, false]);
  assert.equal(b.reason, `${CHAIR_REASON} Host verification: F:7 was deleted from this run's fact table after this report was requested.`);
  assert.equal(row(settled, "c").admissible, true);
  ledger.commit("r", settled);
  const panel = panelOf(["a", "b", "c"]);
  assert.equal(ledger.dispatch("r", "r:next", "a", panel, 300).balance, 300, "the withdrawn report leaves its critic's balance unchanged");
  // A revision that still cites F:7 is classed with its task's epoch: requested after the deletion, it is fined.
  const stillCiting = row(settle(withUpdates(roundInput({ b: CITES_F7, c: CITES_F7 }, { panel: ["a", "b", "c"] }), [{ id: "F:7", seq: 1 }], { b: 0, c: 1 })), "c");
  assert.deepEqual([stillCiting.score, stillCiting.penalty], [-175, "deleted-badge"]);
});

test("F16 a receipt from an earlier chair task of the same round is accepted; one from another round's chair is not", () => {
  const settleWith = (params: JsonObject) => {
    const fixture = mediatedFixture();
    const facts = [fixture.original, fixture.target];
    const settled = new GameReviewLedger().settle("r", "r:1", { ...fixture.params, ...params }, facts, { facts, approvals: [fixture.approval] });
    assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
    return row(settled, "member-1");
  };
  const earlier = mediatedFixture().approval.requesterTaskId;
  const reassessment = "r:chair-reassess-execute";
  assert.equal(settleWith({ chairTaskId: reassessment, chairTaskIds: [earlier, reassessment] }).admissible, true);
  const mismatched: JsonObject[] = [
    { chairTaskId: reassessment, chairTaskIds: ["r:previous-round-chair-execute", reassessment] },
    { chairTaskId: reassessment },
  ];
  for (const params of mismatched) {
    const entry = settleWith(params);
    assert.deepEqual([entry.admissible, entry.score], [false, null], JSON.stringify(params));
    assert.equal(entry.reason, `${CHAIR_REASON} Host verification: F:1 Supreme approval belongs to a different report, review, or badge.`);
  }
});
