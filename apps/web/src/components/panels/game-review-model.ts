import type { GameCritiqueView, GameDecisionRule, GameLedgerView, GameReportLabel, GameScoreRowView, ReviewMemberView, ReviewRoundView } from "@brainstorm-agentic/protocol";

export function scoreText(value: number | null | undefined): string {
  return value === undefined || value === null ? "unscored" : value.toFixed(3);
}

export function gameLabel(y: 0 | 1 | null): string {
  return y === null ? "unresolved" : y === 1 ? "major flaw identified (y=1)" : "no major flaw identified (y=0)";
}

/** The decision rule a run or settlement recorded; absent on records written before scoring v3 (the mean rule). */
export function gameRuleText(decisionRule: GameDecisionRule | undefined, leaveOneOut?: boolean): string {
  if (decisionRule === "chair-decisive") return "chair decisive: any admitted decisive argument blocks";
  if (decisionRule === "committee-mean") return `committee mean against the threshold${leaveOneOut ? "; leave-one-out scoring" : ""}`;
  return "committee mean against the threshold";
}

export function gameReportLabelText(label: GameReportLabel | null | undefined): string {
  return label === undefined ? "" : label === null ? "no chair label" : label === "not-decisive" ? "not decisive" : label;
}

/** The label a row was scored against: y, or the leave-one-out label of the other admitted reports. */
export function scoringLabelText(scoringLabel: 0 | 1 | null | undefined): string {
  return scoringLabel === undefined ? "" : scoringLabel === null ? "unscored" : `y=${scoringLabel}`;
}

/**
 * Scoring v3 badge penalty: the cited badges never issued in the run's fact
 * table, and those deleted from it before the report was requested, with the
 * recorded score; "" for every other row.
 */
export function inventedBadgeText(row: GameScoreRowView): string {
  const badges = row.penalty === "invented-badge" ? row.inventedBadges ?? [] : [];
  const deleted = row.penalty !== undefined ? row.deletedBadges ?? [] : [];
  const list = (ids: readonly string[]): string => ids.map(id => `[${id}]`).join(" ");
  if (deleted.length === 0) return badges.length === 0 ? "" : `Invented badge${badges.length === 1 ? "" : "s"} ${list(badges)}: ${scoreText(row.score)}`;
  const deletedText = `badge${deleted.length === 1 ? "" : "s"} ${list(deleted)}: ${scoreText(row.score)}`;
  return badges.length === 0 ? `Deleted ${deletedText}` : `Invented badge${badges.length === 1 ? "" : "s"} ${list(badges)}; deleted ${deletedText}`;
}

export function scoreRowText(row: GameScoreRowView): string {
  const raw = (value: number | null): string => value === null ? "unscored" : String(value);
  const penalty = inventedBadgeText(row);
  return `${row.criticId}: q=${row.q}; ${row.admissible ? "admissible" : "rejected"}; loss=${raw(row.brierLoss)}; base S=${raw(row.baseScore)}; peer mean=${raw(row.peerMeanBaseScore)}; final R=${raw(row.score)}; ${row.reason}${row.balanceAfter !== undefined ? `; balance before=${row.balanceBefore}; balance after=${row.balanceAfter}; ${row.excluded ? "excluded from future critic work" : "eligible for future critic work"}` : ""}${row.label !== undefined ? `; chair label=${gameReportLabelText(row.label)}` : ""}${row.scoringLabel !== undefined ? `; scored against=${scoringLabelText(row.scoringLabel)}` : ""}${penalty ? `; ${penalty}` : ""}`;
}

/** The lowercase badge on a report or comment its critic withdrew after a fact-table deletion. */
export const WITHDRAWN_BADGE = "withdrawn";
/** The lowercase badge on a round the chair or judge assessed again after a fact-table update. */
export const REASSESSED_BADGE = "re-assessed";
/** The label of a re-assessed round's first assessment. */
export const FIRST_ASSESSMENT_LABEL = "first assessment";
/** The badge on a step a fact-table update changed after the walk passed it. */
export const REVISED_AFTER_REVIEW_BADGE = "revised after review";

/** "F:7", "F:7 and F:9", "F:7, F:9 and F:11". */
function badgeList(ids: readonly string[]): string {
  return ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

/** The deleted badges a withdrawn report or comment answered; undefined when its critic did not withdraw it. */
export function withdrawnBadges(round: ReviewRoundView, criticId: string): readonly string[] | undefined {
  return round.withdrawnAfterFactUpdate?.find(item => item.criticId === criticId)?.deleted;
}

/** The note on a report or comment its critic withdrew; "" when the deleted badges are not known. */
export function withdrawnText(deleted: readonly string[]): string {
  return deleted.length === 0 ? "" : `Withdrawn by its critic after ${badgeList(deleted)} ${deleted.length === 1 ? "was" : "were"} deleted from the fact table.`;
}

/** The note on a round the committee chair (game) or the judge (standard review) assessed again. */
export function reassessedText(game: boolean): string {
  return game
    ? "The chair assessed this round again after a report it already had was revised or withdrawn following a fact-table update."
    : "The judge decided this round again after a comment it already had was revised or withdrawn following a fact-table update.";
}

/** The note on a step revised after review: one clause per notice the rewrite answered. */
export function revisedAfterReviewText(marks: readonly { readonly deleted: string; readonly replacedBy?: string }[]): string {
  const clauses = marks.map(mark => mark.replacedBy !== undefined ? `${mark.deleted} was deleted and replaced by ${mark.replacedBy}` : `${mark.deleted} was deleted`);
  return `A fact-table update changed this step after the walk passed it (${clauses.join("; ")}); it was not reviewed again.`;
}

/** Host validation can reject a report the committee chair initially admitted. */
export function gameAdmission(round: ReviewRoundView, criticId: string) {
  const row = round.gameSettlement?.rows.find(candidate => candidate.criticId === criticId);
  return row ?? round.gameChair?.reports[criticId];
}

/** The chair's decisiveness label for one report: the settled row's, else the chair's own output; undefined before scoring v3. */
export function gameChairLabel(round: ReviewRoundView, criticId: string): GameReportLabel | null | undefined {
  const row = round.gameSettlement?.rows.find(candidate => candidate.criticId === criticId);
  return row?.label !== undefined ? row.label : round.gameChair?.reports[criticId]?.label;
}

export function gameDecisionText(round: ReviewRoundView): string {
  const settlement = round.gameSettlement;
  if (settlement?.decisionRule === "chair-decisive") {
    return settlement.y === null ? `No admitted reports; unresolved. Rule: ${gameRuleText(settlement.decisionRule)}.`
      : `${settlement.y === 1 ? "An admitted argument is decisive" : "No admitted argument is decisive"} → ${gameLabel(settlement.y)}. Rule: ${gameRuleText(settlement.decisionRule)}. Mean admitted q: ${settlement.meanQ} (recorded; decides nothing).`;
  }
  if (settlement?.threshold !== undefined) {
    const rule = settlement.decisionRule === undefined ? "" : ` Rule: ${gameRuleText(settlement.decisionRule, settlement.leaveOneOut)}.`;
    return settlement.meanQ === null ? `No admitted reports; unresolved. Threshold: ${settlement.threshold}.${rule}`
      : `Mean admitted q: ${settlement.meanQ}; threshold: ${settlement.threshold}; mean ${settlement.y === 1 ? ">=" : "<"} threshold → ${gameLabel(settlement.y)}.${rule}`;
  }
  if (settlement) return `Recorded v1 label: ${gameLabel(settlement.y)}`;
  if (round.gameChair?.y !== undefined) return `Recorded chair label: ${gameLabel(round.gameChair.y)}`;
  return "Host decision pending";
}

export function gameRoundText(round: ReviewRoundView): string {
  const chair = round.gameChair;
  const settlement = round.gameSettlement;
  return [
    `Gamified review — round ${round.round}`,
    ...(round.gameCritiques ?? []).map((report) => {
      const withdrawn = withdrawnBadges(round, report.criticId);
      return `${report.criticLabel} (${report.criticId}): q=${report.q}\n${report.justification}${withdrawn !== undefined ? `\n${withdrawnText(withdrawn) || WITHDRAWN_BADGE}` : ""}`;
    }),
    chair ? `Committee chair: ${chair.reason}` : "Committee chair assessment pending",
    ...(round.reassessed ? [reassessedText(true)] : []),
    ...(round.firstAssessment?.gameChair ? [`${FIRST_ASSESSMENT_LABEL} — Committee chair: ${round.firstAssessment.gameChair.reason}`] : []),
    gameDecisionText(round),
    ...Object.entries(chair?.reports ?? {}).flatMap(([id, report]) => {
      const admission = gameAdmission(round, id)!;
      const label = gameChairLabel(round, id);
      return [`${id}: ${admission.admissible ? "admissible" : "rejected"} — ${admission.reason}${label !== undefined ? ` — chair label: ${gameReportLabelText(label)}` : ""}`,
        ...(report.factChecks ?? []).map(check => `${id}: ${check.factId}${check.verifiedFactId ? `; verified support=${check.verifiedFactId}` : ""}; conditions=${check.conditions}; supports conclusion=${check.supportsConclusion}; ${check.reason}`)];
    }),
    ...(chair?.issues ?? []).map((issue) => `Step ${issue.step}${issue.part ? ` ${issue.part}` : ""}: ${issue.point}`),
    settlement ? `Settlement ${settlement.ruleVersion}; version ${settlement.version}; ${settlement.status}; ${gameLabel(settlement.y)}${settlement.ledgerSequence !== undefined ? `; sequence=${settlement.ledgerSequence}; initial points=${settlement.initialPoints}` : ""}` : "Scores pending",
    ...(settlement?.repairArguments ?? []).map(argument => `Repair argument: ${argument}`),
    ...(settlement?.rows ?? []).map(scoreRowText),
  ].join("\n");
}

export interface GameScoreTotal {
  readonly criticId: string;
  readonly label: string;
  readonly admitted: number;
  readonly rejected: number;
  readonly pending: number;
  readonly scored: number;
  readonly total: number | null;
  readonly balance?: number;
  readonly eligible?: boolean;
  readonly excluded?: boolean;
}

/** True when any settled round of the stage carries the scoring v3 invented-badge penalty flag. */
export function inventedBadgePenaltyEnabled(members: readonly ReviewMemberView[]): boolean {
  return members.some(member => member.steps.some(step => step.rounds.some(round => round.gameSettlement?.inventedBadgePenalty === true)));
}

/** True when any settled round of the stage carries the deleted-badge penalty flag (fact updates). */
export function deletedBadgePenaltyEnabled(members: readonly ReviewMemberView[]): boolean {
  return members.some(member => member.steps.some(step => step.rounds.some(round => round.gameSettlement?.deletedBadgePenalty === true)));
}

/** The scoreboard's sentence on rejected reports, in the visible note and the export (addendum 2026-10-12 D2; fact-update design 11.13). */
export function gameRejectionText(inventedBadgePenalty: boolean, deletedBadgePenalty = false): string {
  if (deletedBadgePenalty) return "Rejected reports are unscored, except that a report citing a badge never issued in this run's fact table, or one deleted before the report was requested, records -175.";
  return inventedBadgePenalty ? "Rejected reports are unscored, except that a report citing a badge never issued in this run's fact table records -175." : "Rejected reports are unscored.";
}

/** Totals describe participation as well as reward; unscored is never a zero. */
export function gameScoreTotals(members: readonly ReviewMemberView[], ledger?: GameLedgerView): GameScoreTotal[] {
  const totals = new Map<string, { criticId: string; label: string; admitted: number; rejected: number; pending: number; scored: number; total: number | null }>();
  for (const member of members) totals.set(member.memberId, { criticId: member.memberId, label: member.label, admitted: 0, rejected: 0, pending: 0, scored: 0, total: null });
  for (const member of members) for (const step of member.steps) for (const round of step.rounds) {
    const rows = new Map(round.gameSettlement?.rows.map((row) => [row.criticId, row]) ?? []);
    const ids = new Set([...(round.gameCritiques ?? []).map((report) => report.criticId), ...rows.keys()]);
    for (const criticId of ids) {
      const total = totals.get(criticId) ?? { criticId, label: criticId, admitted: 0, rejected: 0, pending: 0, scored: 0, total: null };
      totals.set(criticId, total);
      const row = rows.get(criticId);
      // A report withdrawn after a fact-table deletion is never settled: it is not pending.
      if (!row && withdrawnBadges(round, criticId) !== undefined) continue;
      if (!row) { total.pending++; continue; }
      // A scoring v3 invented-badge or deleted-badge penalty stays Rejected, not Scored, but its -175 enters Total R: starting points + Total R = balance.
      if (!row.admissible) { total.rejected++; if ((row.penalty === "invented-badge" || row.penalty === "deleted-badge") && row.score !== null) total.total = (total.total ?? 0) + row.score; continue; }
      total.admitted++;
      if (row.score === null) { total.pending++; continue; }
      total.scored++;
      total.total = (total.total ?? 0) + row.score;
    }
  }
  const balances = new Map(ledger?.critics.map(critic => [critic.criticId, critic]) ?? []);
  for (const critic of ledger?.critics ?? []) if (!totals.has(critic.criticId)) totals.set(critic.criticId, { criticId: critic.criticId, label: critic.criticId, admitted: 0, rejected: 0, pending: 0, scored: 0, total: null });
  return [...totals.values()].map(total => {
    const balance = balances.get(total.criticId);
    return { ...total, ...(balance ? { balance: balance.balance, eligible: balance.eligible, excluded: balance.excluded } : {}) };
  });
}

export interface GameFeedback {
  readonly targetId: string;
  readonly targetLabel: string;
  readonly step: number;
  readonly round: ReviewRoundView;
  readonly report?: GameCritiqueView;
  readonly scoreRow?: GameScoreRowView;
}

/** Each history contains that critic's own reports and feedback only. */
export function gameFeedbackHistory(members: readonly ReviewMemberView[], criticId: string): GameFeedback[] {
  return members.flatMap(member => member.steps.flatMap(step => step.rounds.flatMap(round => {
    const report = round.gameCritiques?.find(item => item.criticId === criticId);
    const scoreRow = round.gameSettlement?.rows.find(item => item.criticId === criticId);
    return report || scoreRow ? [{ targetId: member.memberId, targetLabel: member.label, step: step.index, round, ...(report ? { report } : {}), ...(scoreRow ? { scoreRow } : {}) }] : [];
  }))).sort((a, b) => (a.round.gameSettlement?.ledgerSequence ?? Infinity) - (b.round.gameSettlement?.ledgerSequence ?? Infinity));
}

export function gameFeedbackText(feedback: GameFeedback): string {
  const { report, scoreRow, round } = feedback;
  const withdrawn = report ? withdrawnBadges(round, report.criticId) : undefined;
  return [`${feedback.targetLabel}: step ${feedback.step}, round ${round.round}`,
    ...(report ? [`q=${report.q}\n${report.justification}`] : []),
    gameDecisionText(round),
    scoreRow ? scoreRowText(scoreRow) : withdrawn !== undefined ? withdrawnText(withdrawn) || WITHDRAWN_BADGE : "Scores pending",
  ].join("\n");
}
