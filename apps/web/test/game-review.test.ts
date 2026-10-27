import assert from "node:assert/strict";
import test from "node:test";
import type { GameScoreRowView, GameSettlementView, ReviewMemberView, ReviewRoundView } from "@brainstorm-agentic/protocol";
import { deletedBadgePenaltyEnabled, FIRST_ASSESSMENT_LABEL, gameAdmission, gameChairLabel, gameDecisionText, gameFeedbackHistory, gameFeedbackText, gameLabel, gameRejectionText, gameReportLabelText, gameRoundText, gameRuleText, gameScoreTotals, inventedBadgePenaltyEnabled, inventedBadgeText, REASSESSED_BADGE, reassessedText, scoreRowText, scoreText, scoringLabelText, WITHDRAWN_BADGE, withdrawnBadges, withdrawnText } from "../src/components/panels/game-review-model.js";
import { buildCommittee } from "../src/components/committee/round-table-model.js";
import { seatTimeline, timelineSignature } from "../src/components/panels/review-diff.js";

const pending: ReviewRoundView = { round: 1, comments: [], cot: "Stable chain", gameCritiques: [{ criticId: "b", criticLabel: "Seat 2", q: 0.5, justification: "A specific concern" }] };
const settlement: GameSettlementView = {
  ruleVersion: "brier-peer/v1", version: "v1", y: 1, status: "settled", admittedCount: 1,
  rows: [{ criticId: "b", q: 0.5, admissible: true, reason: "Specific concern", brierLoss: 0.25, baseScore: 0, peerMeanBaseScore: null, score: 0 }],
};
const settled: ReviewRoundView = { ...pending,
  gameChair: { reports: { b: { admissible: true, reason: "Specific concern" } }, y: 1, reason: "Defect upheld", issues: [] },
  gameSettlement: settlement,
};

test("chair labels distinguish major flaws and unresolved labels", () => {
  assert.equal(gameLabel(1), "major flaw identified (y=1)");
  assert.equal(gameLabel(0), "no major flaw identified (y=0)");
  assert.equal(gameLabel(null), "unresolved");
});
function members(rounds: readonly ReviewRoundView[]): ReviewMemberView[] {
  return [{ memberId: "a", label: "Seat 1", steps: [{ index: 1, outcome: "under-review", rounds }] }, { memberId: "b", label: "Seat 2", steps: [] }];
}

test("scoreboard distinguishes waiting, rejected, scored zero and no participation", () => {
  const waiting = gameScoreTotals(members([pending]));
  assert.equal(waiting[1]?.pending, 1);
  assert.equal(waiting[1]?.total, null);
  const zero = gameScoreTotals(members([settled]));
  assert.equal(zero[1]?.total, 0);
  assert.equal(zero[1]?.scored, 1);
  assert.equal(zero[1]?.admitted, 1);
  assert.equal(zero[0]?.total, null);
  const rejected: ReviewRoundView = { ...pending, gameSettlement: { ...settlement, admittedCount: 0, y: null, status: "no-valid-reports", rows: [{ ...settlement.rows[0]!, admissible: false, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null }] } };
  const totals = gameScoreTotals(members([settled, { ...rejected, round: 2 }, { ...pending, round: 3 }]));
  assert.deepEqual(totals[1], { criticId: "b", label: "Seat 2", admitted: 1, rejected: 1, pending: 1, scored: 1, total: 0 });
  assert.equal(scoreText(0), "0.000");
  assert.equal(scoreText(null), "unscored");
});

test("exports include justification, admission, chair label and every raw score component", () => {
  const text = gameRoundText(settled);
  for (const value of ["q=0.5", "A specific concern", "admissible", "y=1", "loss=0.25", "base S=0", "peer mean=unscored", "final R=0", "brier-peer/v1", "version v1"]) assert.ok(text.includes(value), value);
  assert.ok(gameRoundText(pending).includes("Scores pending"));
});

test("SSE score arrival invalidates retained timeline round objects with unchanged chain text", () => {
  const before = members([pending])[0]!;
  const after = members([settled])[0]!;
  assert.notEqual(timelineSignature(before), timelineSignature(after));
  assert.notEqual(seatTimeline(before), seatTimeline(after));
});

test("committee links show report admission rather than assigning critics invented verdicts", () => {
  const waiting = buildCommittee([], members([pending]));
  assert.equal(waiting.edges[0]?.verdict, "Reported");
  const admitted = buildCommittee([], members([settled]));
  assert.equal(admitted.edges[0]?.verdict, "Admitted");
  assert.equal(admitted.edges[0]?.sourceId, "b");
  assert.equal(admitted.edges[0]?.targetId, "a");
  const rejected = buildCommittee([], members([{ ...settled, gameSettlement: { ...settlement, rows: [{ ...settlement.rows[0]!, admissible: false, reason: "Off topic", score: null }] } }]));
  assert.equal(rejected.edges[0]?.verdict, "Rejected");
});

test("v2 views use the host mean, threshold and effective badge admission", () => {
  const round: ReviewRoundView = { ...settled, gameChair: { reports: { b: { admissible: true, reason: "Looks relevant", factChecks: [{ factId: "F:1", verifiedFactId: "F:2", conditions: "n > 0", supportsConclusion: true, reason: "Supports claim" }] } }, reason: "Checked", issues: [] }, gameSettlement: {
    ...settlement, ruleVersion: "brier-peer/v2", meanQ: null, threshold: 0.5, y: null, admittedCount: 0, status: "no-valid-reports", initialPoints: 200, ledgerSequence: 1,
    rows: [{ ...settlement.rows[0]!, admissible: false, reason: "Fact F:1 was retracted", score: null, balanceBefore: 200, balanceAfter: 200, excluded: false }],
  } };
  assert.equal(gameAdmission(round, "b")?.admissible, false);
  assert.equal(gameAdmission(round, "b")?.reason, "Fact F:1 was retracted");
  assert.match(gameDecisionText(round), /No admitted reports; unresolved/);
  assert.match(gameRoundText(round), /conditions=n > 0/);
  assert.match(gameRoundText(round), /verified support=F:2/);
  assert.match(gameRoundText(round), /balance after=200/);
  assert.equal(buildCommittee([], members([round])).edges[0]?.verdict, "Rejected");
  const boundary = { ...round, gameSettlement: { ...round.gameSettlement!, meanQ: 0.5, y: 1 as const } };
  assert.match(gameDecisionText(boundary), /mean >= threshold/);
});

test("scoreboard uses durable balances, keeps zero eligible and separates own feedback histories", () => {
  const ledger = { initialPoints: 0, ledgerSequence: 2, critics: [
    { criticId: "a", balance: 0, excluded: false, eligible: true },
    { criticId: "b", balance: 5, excluded: true, eligible: false },
  ] };
  const roster = members([settled, { ...pending, round: 2 }]);
  const totals = gameScoreTotals(roster, ledger);
  assert.equal(totals[0]?.balance, 0);
  assert.equal(totals[0]?.eligible, true);
  assert.equal(totals[1]?.balance, 5);
  assert.equal(totals[1]?.excluded, true, "a recovered balance does not undo latched exclusion");
  assert.equal(gameFeedbackHistory(roster, "a").length, 0);
  const own = gameFeedbackHistory(roster, "b");
  assert.equal(own.length, 2);
  assert.ok(own.every(feedback => feedback.report?.criticId === "b"));
  assert.match(gameFeedbackText(own[0]!), /A specific concern/);
});

test("v3 views show the decision rule, each report's chair label and the label it was scored against", () => {
  const v3: GameSettlementView = {
    ...settlement, ruleVersion: "brier-peer/v3", decisionRule: "chair-decisive", leaveOneOut: true, y: 1, meanQ: 0.35, threshold: 0.5, admittedCount: 2, initialPoints: 300, ledgerSequence: 1,
    rows: [
      { criticId: "b", q: 0.95, admissible: true, reason: "Holds", label: "decisive", scoringLabel: 1, brierLoss: 0.0025, baseScore: 24.75, peerMeanBaseScore: -56, score: 105.5, balanceBefore: 300, balanceAfter: 405.5, excluded: false },
      { criticId: "c", q: 0.1, admissible: true, reason: "Style", label: "not-decisive", scoringLabel: 1, brierLoss: 0.81, baseScore: -56, peerMeanBaseScore: 24.75, score: -136.75, balanceBefore: 300, balanceAfter: 163.25, excluded: false },
      { criticId: "d", q: 0.4, admissible: false, reason: "Unsupported", label: null, scoringLabel: null, brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null, balanceBefore: 300, balanceAfter: 300, excluded: false },
    ],
  };
  const round: ReviewRoundView = { ...pending, gameChair: { reports: { b: { admissible: true, reason: "Holds", label: "decisive" }, c: { admissible: true, reason: "Style", label: "not-decisive" }, d: { admissible: true, reason: "Chair admitted", label: "invalid" } }, reason: "Labelled", issues: [] }, gameSettlement: v3 };
  assert.equal(gameRuleText("chair-decisive"), "chair decisive: any admitted decisive argument blocks");
  assert.equal(gameRuleText("committee-mean", true), "committee mean against the threshold; leave-one-out scoring");
  assert.equal(gameRuleText("committee-mean", false), "committee mean against the threshold");
  assert.equal(gameRuleText(undefined), "committee mean against the threshold");
  assert.match(gameDecisionText(round), /An admitted argument is decisive → major flaw identified \(y=1\)\. Rule: chair decisive/);
  assert.match(gameDecisionText(round), /Mean admitted q: 0.35 \(recorded; decides nothing\)/);
  assert.equal(gameChairLabel(round, "b"), "decisive");
  assert.equal(gameChairLabel(round, "d"), null, "the settled row wins over the chair's own label for a report the host rejected");
  assert.equal(gameChairLabel({ ...round, gameSettlement: undefined }, "d"), "invalid", "before settlement the chair's own label shows");
  assert.equal(gameChairLabel(settled, "b"), undefined, "pre-v3 rounds carry no label");
  assert.equal(gameReportLabelText("not-decisive"), "not decisive");
  assert.equal(gameReportLabelText(null), "no chair label");
  assert.equal(scoringLabelText(1), "y=1");
  assert.equal(scoringLabelText(null), "unscored");
  assert.match(scoreRowText(v3.rows[0]!), /chair label=decisive; scored against=y=1/);
  assert.match(scoreRowText(v3.rows[2]!), /chair label=no chair label; scored against=unscored/);
  assert.doesNotMatch(scoreRowText(settlement.rows[0]!), /chair label/);
  const text = gameRoundText(round);
  for (const value of ["b: admissible — Holds — chair label: decisive", "d: rejected — Unsupported — chair label: no chair label", "brier-peer/v3"]) assert.ok(text.includes(value), value);
  const mean: ReviewRoundView = { ...round, gameSettlement: { ...v3, decisionRule: "committee-mean", leaveOneOut: true, y: 1, meanQ: 0.525 } };
  assert.match(gameDecisionText(mean), /Mean admitted q: 0.525; threshold: 0.5; mean >= threshold → major flaw identified \(y=1\)\. Rule: committee mean against the threshold; leave-one-out scoring\./);
  const unresolved: ReviewRoundView = { ...round, gameSettlement: { ...v3, y: null, meanQ: null, status: "no-valid-reports", admittedCount: 0, rows: [] } };
  assert.equal(gameDecisionText(unresolved), "No admitted reports; unresolved. Rule: chair decisive: any admitted decisive argument blocks.");
  assert.equal(gameScoreTotals(members([round]))[1]?.total, 105.5);
});

test("an invented-badge penalty row shows the cited badges and the floor score in its text, the round export and the feedback history", () => {
  const penalty: GameScoreRowView = { criticId: "b", q: 0.5, admissible: false, reason: "Holds. Host verification: invented badge F:7 never issued in this run's fact table; penalty -175.", brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: -175, balanceBefore: 300, balanceAfter: 125, excluded: false, label: null, scoringLabel: null, penalty: "invented-badge", inventedBadges: ["F:7"] };
  assert.equal(inventedBadgeText(penalty), "Invented badge [F:7]: -175.000");
  assert.equal(inventedBadgeText({ ...penalty, inventedBadges: ["F:7", "F:9"] }), "Invented badges [F:7] [F:9]: -175.000");
  assert.equal(inventedBadgeText(settlement.rows[0]!), "", "rows without the penalty show nothing");
  assert.equal(scoreRowText(penalty), "b: q=0.5; rejected; loss=unscored; base S=unscored; peer mean=unscored; final R=-175; Holds. Host verification: invented badge F:7 never issued in this run's fact table; penalty -175.; balance before=300; balance after=125; eligible for future critic work; chair label=no chair label; scored against=unscored; Invented badge [F:7]: -175.000");
  assert.doesNotMatch(scoreRowText(settlement.rows[0]!), /Invented badge/);
  const round: ReviewRoundView = { ...pending, gameChair: { reports: { b: { admissible: true, reason: "Holds", label: "decisive" } }, reason: "Labelled", issues: [] },
    gameSettlement: { ...settlement, ruleVersion: "brier-peer/v3", decisionRule: "chair-decisive", leaveOneOut: true, y: null, meanQ: null, threshold: 0.5, status: "no-valid-reports", admittedCount: 0, initialPoints: 300, ledgerSequence: 1, inventedBadgePenalty: true, rows: [penalty] } };
  assert.equal(gameAdmission(round, "b")?.admissible, false, "the host rejects a report the chair admitted");
  assert.ok(gameRoundText(round).includes("Invented badge [F:7]: -175.000"));
  const history = gameFeedbackHistory(members([round]), "b");
  assert.equal(history.length, 1);
  assert.ok(gameFeedbackText(history[0]!).includes("Invented badge [F:7]: -175.000"));
});

test("the scoreboard counts an invented-badge penalty as rejected, adds its -175 to Total R and names it in the rejection sentence", () => {
  const penalty: GameScoreRowView = { criticId: "b", q: 0.5, admissible: false, reason: "Holds. Host verification: invented badge F:7 never issued in this run's fact table; penalty -175.", brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: -175, balanceBefore: 300, balanceAfter: 125, excluded: false, label: null, scoringLabel: null, penalty: "invented-badge", inventedBadges: ["F:7"] };
  const v3: GameSettlementView = { ...settlement, ruleVersion: "brier-peer/v3", decisionRule: "chair-decisive", leaveOneOut: true, y: null, meanQ: null, threshold: 0.5, status: "no-valid-reports", admittedCount: 0, initialPoints: 300, ledgerSequence: 1, inventedBadgePenalty: true, rows: [penalty] };
  const penalised: ReviewRoundView = { ...pending, gameSettlement: v3 };
  assert.deepEqual(gameScoreTotals(members([penalised]))[1], { criticId: "b", label: "Seat 2", admitted: 0, rejected: 1, pending: 0, scored: 0, total: -175 }, "a critic whose only report was penalised");
  assert.equal(scoreText(gameScoreTotals(members([penalised]))[1]?.total), "-175.000");
  assert.deepEqual(gameScoreTotals(members([settled, { ...penalised, round: 2 }]))[1], { criticId: "b", label: "Seat 2", admitted: 1, rejected: 1, pending: 0, scored: 1, total: -175 }, "a scored zero plus a penalty");
  const ledger = { initialPoints: 300, ledgerSequence: 1, critics: [{ criticId: "b", balance: 125, excluded: false, eligible: true }] };
  const withBalance = gameScoreTotals(members([penalised]), ledger)[1]!;
  assert.equal(ledger.initialPoints + withBalance.total!, withBalance.balance, "starting points + Total R = balance");
  const plain: ReviewRoundView = { ...penalised, gameSettlement: { ...v3, rows: [{ criticId: "b", q: 0.5, admissible: false, reason: "Off topic", brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: null, balanceBefore: 300, balanceAfter: 300, excluded: false, label: null, scoringLabel: null }] } };
  assert.deepEqual(gameScoreTotals(members([plain]))[1], { criticId: "b", label: "Seat 2", admitted: 0, rejected: 1, pending: 0, scored: 0, total: null }, "neither a scored row nor a penalty row: unscored");
  assert.equal(inventedBadgePenaltyEnabled(members([penalised])), true);
  assert.equal(inventedBadgePenaltyEnabled(members([settled, { ...pending, round: 2 }])), false, "no settled round carries the flag");
  assert.equal(inventedBadgePenaltyEnabled(members([{ ...penalised, gameSettlement: { ...v3, inventedBadgePenalty: undefined } }])), false);
  assert.equal(gameRejectionText(true), "Rejected reports are unscored, except that a report citing a badge never issued in this run's fact table records -175.");
  assert.equal(gameRejectionText(false), "Rejected reports are unscored.");
});

test("a deleted-badge penalty names its badges in the label, counts in Total R and in the rejection sentence", () => {
  const base: GameScoreRowView = { criticId: "b", q: 0.5, admissible: false, reason: "Holds. Host verification: deleted badge F:9 cited after its deletion from this run's fact table; penalty -175.", brierLoss: null, baseScore: null, peerMeanBaseScore: null, score: -175, balanceBefore: 300, balanceAfter: 125, excluded: false, label: null, scoringLabel: null, penalty: "deleted-badge", deletedBadges: ["F:9"] };
  assert.equal(inventedBadgeText(base), "Deleted badge [F:9]: -175.000");
  assert.equal(inventedBadgeText({ ...base, deletedBadges: ["F:11", "F:9"] }), "Deleted badges [F:11] [F:9]: -175.000");
  assert.equal(inventedBadgeText({ ...base, penalty: "invented-badge", inventedBadges: ["F:7"] }), "Invented badge [F:7]; deleted badge [F:9]: -175.000");
  assert.equal(inventedBadgeText({ ...base, penalty: "invented-badge", inventedBadges: ["F:7", "F:8"], deletedBadges: ["F:11", "F:9"] }), "Invented badges [F:7] [F:8]; deleted badges [F:11] [F:9]: -175.000");
  assert.equal(inventedBadgeText({ ...base, penalty: "invented-badge", inventedBadges: ["F:7"], deletedBadges: undefined }), "Invented badge [F:7]: -175.000", "rows without deleted badges keep today's text");
  assert.match(scoreRowText(base), /; Deleted badge \[F:9\]: -175\.000$/);
  const v3: GameSettlementView = { ...settlement, ruleVersion: "brier-peer/v3", decisionRule: "chair-decisive", leaveOneOut: true, y: null, meanQ: null, threshold: 0.5, status: "no-valid-reports", admittedCount: 0, initialPoints: 300, ledgerSequence: 1, inventedBadgePenalty: true, deletedBadgePenalty: true, rows: [base] };
  const penalised: ReviewRoundView = { ...pending, gameSettlement: v3 };
  assert.deepEqual(gameScoreTotals(members([penalised]))[1], { criticId: "b", label: "Seat 2", admitted: 0, rejected: 1, pending: 0, scored: 0, total: -175 });
  assert.equal(deletedBadgePenaltyEnabled(members([penalised])), true);
  assert.equal(deletedBadgePenaltyEnabled(members([settled])), false);
  assert.equal(gameRejectionText(true, true), "Rejected reports are unscored, except that a report citing a badge never issued in this run's fact table, or one deleted before the report was requested, records -175.");
  assert.equal(gameRejectionText(false, true), gameRejectionText(true, true));
  assert.equal(gameRejectionText(true), "Rejected reports are unscored, except that a report citing a badge never issued in this run's fact table records -175.");
  assert.equal(gameRejectionText(false), "Rejected reports are unscored.");
});

test("a withdrawn report and a re-assessed round are labelled, and a withdrawn report is never pending", () => {
  const round: ReviewRoundView = { ...settled, round: 1,
    gameCritiques: [{ criticId: "b", criticLabel: "Seat 2", q: 0.5, justification: "A specific concern" }, { criticId: "c", criticLabel: "Seat 3", q: 0.2, justification: "Cites [F:7]." }],
    withdrawnAfterFactUpdate: [{ criticId: "c", deleted: ["F:7"] }], reassessed: true,
    firstAssessment: { gameChair: { reports: { b: { admissible: true, reason: "Specific concern" }, c: { admissible: true, reason: "Cites a badge" } }, reason: "First look", issues: [] } } };
  assert.deepEqual(withdrawnBadges(round, "c"), ["F:7"]);
  assert.equal(withdrawnBadges(round, "b"), undefined);
  assert.equal(withdrawnText(["F:7"]), "Withdrawn by its critic after F:7 was deleted from the fact table.");
  assert.equal(withdrawnText(["F:7", "F:9"]), "Withdrawn by its critic after F:7 and F:9 were deleted from the fact table.");
  assert.equal(withdrawnText([]), "");
  assert.equal(reassessedText(true), "The chair assessed this round again after a report it already had was revised or withdrawn following a fact-table update.");
  assert.equal(reassessedText(false), "The judge decided this round again after a comment it already had was revised or withdrawn following a fact-table update.");
  assert.deepEqual([WITHDRAWN_BADGE, REASSESSED_BADGE, FIRST_ASSESSMENT_LABEL], ["withdrawn", "re-assessed", "first assessment"]);
  const roster: ReviewMemberView[] = [{ memberId: "a", label: "Seat 1", steps: [{ index: 1, outcome: "under-review", rounds: [round] }] }, { memberId: "b", label: "Seat 2", steps: [] }, { memberId: "c", label: "Seat 3", steps: [] }];
  assert.deepEqual(gameScoreTotals(roster).find(total => total.criticId === "c"), { criticId: "c", label: "Seat 3", admitted: 0, rejected: 0, pending: 0, scored: 0, total: null });
  const text = gameRoundText(round);
  assert.ok(text.includes("Cites [F:7].\nWithdrawn by its critic after F:7 was deleted from the fact table."), text);
  assert.ok(text.includes(reassessedText(true)));
  assert.ok(text.includes("first assessment — Committee chair: First look"));
  const feedback = gameFeedbackHistory(roster, "c");
  assert.equal(feedback.length, 1);
  assert.ok(gameFeedbackText(feedback[0]!).endsWith("Withdrawn by its critic after F:7 was deleted from the fact table."));
  assert.doesNotMatch(gameFeedbackText(feedback[0]!), /Scores pending/);
});
