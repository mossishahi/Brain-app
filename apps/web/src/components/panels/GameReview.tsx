import type { GameCritiqueView, ReviewRoundView, ReviewStage } from "@brainstorm-agentic/protocol";
import { downloadTextFile } from "../../latex";
import { TokenChip } from "../common";
import { deletedBadgePenaltyEnabled, FIRST_ASSESSMENT_LABEL, gameAdmission, gameChairLabel, gameDecisionText, gameFeedbackHistory, gameFeedbackText, gameLabel, gameRejectionText, gameReportLabelText, gameRoundText, gameRuleText, gameScoreTotals, inventedBadgePenaltyEnabled, inventedBadgeText, REASSESSED_BADGE, reassessedText, scoreText, scoringLabelText, WITHDRAWN_BADGE, withdrawnBadges, withdrawnText } from "./game-review-model";
import "./game-review.css";

export function GameReport({ report, round }: { report: GameCritiqueView; round: ReviewRoundView }) {
  const row = round.gameSettlement?.rows.find((candidate) => candidate.criticId === report.criticId);
  const admission = gameAdmission(round, report.criticId);
  const checks = round.gameChair?.reports[report.criticId]?.factChecks;
  const chairLabel = gameChairLabel(round, report.criticId);
  const penalty = row ? inventedBadgeText(row) : "";
  // A report its critic withdrew after a fact-table deletion is neither assessed again nor settled.
  const withdrawn = withdrawnBadges(round, report.criticId);
  if (withdrawn !== undefined) return <div>
    <p><strong>q = {report.q}</strong> · Probability of a major flaw that could prevent a correct final solution</p>
    <p className="game-review-prose">{report.justification}</p>
    <p><span className="badge">{WITHDRAWN_BADGE}</span>{withdrawn.length > 0 && <> {withdrawnText(withdrawn)}</>}</p>
    {report.usage && <TokenChip usage={report.usage} />}
  </div>;
  return <div>
    <p><strong>q = {report.q}</strong> · Probability of a major flaw that could prevent a correct final solution</p>
    <p className="game-review-prose">{report.justification}</p>
    <p>{admission ? `${admission.admissible ? "Admissible" : "Rejected"}: ${admission.reason}` : "Admissibility pending"}</p>
    {chairLabel !== undefined && <p>Chair label: <strong>{gameReportLabelText(chairLabel)}</strong>{row?.scoringLabel !== undefined && <> · Scored against: <strong>{scoringLabelText(row.scoringLabel)}</strong></>}</p>}
    {checks && checks.length > 0 && <ul>{checks.map((check, index) => <li key={index}><strong>{check.factId}</strong>{check.verifiedFactId && <> (verified support: {check.verifiedFactId})</>} · Conditions: {check.conditions} · {check.supportsConclusion ? "Supports conclusion" : "Does not support conclusion"}. {check.reason}</li>)}</ul>}
    {row ? <>
      {penalty !== "" && <p>{penalty}</p>}
      <p>Loss: {scoreText(row.brierLoss)} · Base S: {scoreText(row.baseScore)} · Peer mean: {row.admissible && round.gameSettlement?.admittedCount === 1 ? "not applicable (single report)" : scoreText(row.peerMeanBaseScore)} · Final R: {scoreText(row.score)}</p>
      {row.balanceAfter !== undefined && <p>Balance: {scoreText(row.balanceBefore)} → <strong>{scoreText(row.balanceAfter)}</strong> · {row.excluded ? "Excluded from future critic work; own solution continues" : "Eligible for future critic work"}</p>}
    </> : <p className="dim">Scores pending</p>}
    {report.usage && <TokenChip usage={report.usage} />}
  </div>;
}

export function GameChair({ round, labelOf }: { round: ReviewRoundView; labelOf: (id: string) => string }) {
  const chair = round.gameChair;
  if (!chair) return <p className="dim">The committee chair assessment is pending.</p>;
  const settlement = round.gameSettlement;
  const label = settlement?.y ?? (settlement ? null : chair.y);
  return <div>
    <p><strong>Committee decision: {label === undefined ? "pending" : gameLabel(label)}</strong></p>
    <p>{gameDecisionText(round)}</p>
    <p className="game-review-prose"><strong>Committee chair:</strong> {chair.reason}</p>
    {round.reassessed && <p className="small"><span className="badge">{REASSESSED_BADGE}</span> {reassessedText(true)}</p>}
    <ul>{Object.entries(chair.reports).map(([id, report]) => {
      const admission = gameAdmission(round, id)!;
      const chairLabel = gameChairLabel(round, id);
      return <li key={id}><strong>{labelOf(id)} — {admission.admissible ? "admissible" : "rejected"}{chairLabel !== undefined ? ` · ${gameReportLabelText(chairLabel)}` : ""}:</strong> {admission.reason}
        {report.factChecks && report.factChecks.length > 0 && <ul>{report.factChecks.map((check, index) => <li key={index}>{check.factId}{check.verifiedFactId && <> (verified support: {check.verifiedFactId})</>} · Conditions: {check.conditions} · {check.supportsConclusion ? "Supports conclusion" : "Does not support conclusion"}. {check.reason}</li>)}</ul>}
      </li>;
    })}</ul>
    {settlement?.repairArguments && settlement.repairArguments.length > 0 && <><strong>Arguments for repair</strong><ul>{settlement.repairArguments.map((argument, index) => <li key={index}>{argument}</li>)}</ul></>}
    {chair.issues.length > 0 && <><strong>Recorded issues to address</strong><ul>{chair.issues.map((issue, index) => <li key={index}>Step {issue.step}{issue.part ? ` · ${issue.part}` : ""}: {issue.point}{issue.suggestion ? ` ${issue.suggestion}` : ""}</li>)}</ul></>}
    <p className="dim small">{settlement ? `${settlement.admittedCount} admitted report(s) · ${settlement.status} · ${settlement.ruleVersion}${settlement.decisionRule !== undefined ? ` · rule: ${gameRuleText(settlement.decisionRule, settlement.leaveOneOut)}` : ""}` : "Host label and score settlement pending"}</p>
    {round.firstAssessment?.gameChair && <details><summary>{FIRST_ASSESSMENT_LABEL}</summary>
      <p className="game-review-prose"><strong>Committee chair:</strong> {round.firstAssessment.gameChair.reason}</p>
      <ul>{Object.entries(round.firstAssessment.gameChair.reports).map(([id, report]) => <li key={id}><strong>{labelOf(id)} — {report.admissible ? "admissible" : "rejected"}{report.label !== undefined ? ` · ${gameReportLabelText(report.label)}` : ""}:</strong> {report.reason}</li>)}</ul>
    </details>}
  </div>;
}

export function GameScoreboard({ stage }: { stage: ReviewStage }) {
  const totals = gameScoreTotals(stage.members, stage.gameLedger);
  const hasBalances = stage.gameLedger !== undefined;
  const hasHistoricalScores = !hasBalances && stage.members.some(member => member.steps.some(step => step.rounds.some(round => round.gameSettlement?.ruleVersion === "brier-peer/v1")));
  const eligibility = (row: typeof totals[number]) => row.excluded ? "Excluded from future critic work" : row.eligible === true ? "Eligible" : row.eligible === false ? "Not eligible" : "Pending";
  const points = stage.gameLedger?.initialPoints ?? stage.gameReview?.initialPoints;
  const rule = stage.gameReview?.decisionRule;
  const ruleText = gameRuleText(rule, stage.gameReview?.leaveOneOut);
  const rejection = gameRejectionText(inventedBadgePenaltyEnabled(stage.members), deletedBadgePenaltyEnabled(stage.members));
  const exportText = () => [
    hasHistoricalScores ? "Historical v1 gamified review: recorded chair labels and observational scores; no running balance or automatic exclusion."
      : rule === "chair-decisive" ? "Gamified review: the committee chair labels each admitted argument; any admitted decisive argument blocks the step and every critic is scored against that label."
      : `Gamified review: the host labels the mean admitted probability using this run's threshold${rule === undefined ? "" : `; decision rule: ${ruleText}`}.`,
    "q is the probability of a major flaw that could prevent a correct final solution.",
    ...(hasHistoricalScores ? [] : [`Decision threshold: ${stage.gameReview?.threshold ?? "not recorded"}; starting points per reviewer: ${points ?? "automatic: 100 × actual confirmed panel size"}.`,
      "A balance below zero permanently excludes future critic work; the critic's own solution continues."]),
    `S = 25 - 100(q-y)^2; R = 2S - mean(other admitted S); one admitted report: R = S. ${rejection}`,
    ...totals.map((row) => `${row.label} (${row.criticId}): admitted=${row.admitted}; rejected=${row.rejected}; pending=${row.pending}; scored=${row.scored}; total R=${row.total ?? "unscored"}; balance=${row.balance ?? "not recorded"}; eligibility=${hasHistoricalScores ? "unchanged (v1)" : eligibility(row)}`),
    ...totals.map(row => `${row.label}: own feedback history\n${gameFeedbackHistory(stage.members, row.criticId).map(gameFeedbackText).join("\n\n") || "No reports yet."}`),
    ...stage.members.flatMap((member) => member.steps.flatMap((step) => step.rounds.map((round) => `${member.label} — step ${step.index}\n${gameRoundText(round)}`))),
  ].join("\n\n");
  return <section className="game-scoreboard" aria-label="Gamified review scores">
    <div className="game-scoreboard-heading"><strong>Gamified review · on for this run</strong><button type="button" className="ghost-btn" onClick={() => downloadTextFile("review-scores.txt", exportText(), "text/plain;charset=utf-8")}>Export scores and reports</button></div>
    {hasHistoricalScores ? <p className="dim small">Historical v1 scores used the recorded chair label and did not change reviewer eligibility.</p> : <>
      {rule !== undefined && <p className="small">Decision rule: <strong>{ruleText}</strong>.{rule === "committee-mean" && !stage.gameReview?.leaveOneOut ? " Each critic is scored against the committee's own label." : ""}</p>}
      <p className="small">Threshold: <strong>{stage.gameReview?.threshold ?? "pending"}</strong> · Starting points per reviewer: <strong>{points ?? "100 × confirmed panel size (pending)"}</strong>. {rule === "chair-decisive" ? "The mean admitted q is recorded but the chair label decides." : "Mean admitted q ≥ threshold marks a major flaw; lower thresholds are stricter."}</p>
      <p className="dim small">S = 25 − 100(q−y)²; R = 2S − mean(other admitted S). With one admitted report, R = S. Add R to the running balance. Below zero permanently stops future critic work; the reviewer's own solution continues. {rejection} This is an internal review signal.</p>
    </>}
    <div className="game-score-table-wrap"><table><thead><tr><th>Reviewer</th><th>Admitted</th><th>Rejected</th><th>Pending</th><th>Scored</th><th>Total R</th><th>Balance</th><th>Critic eligibility</th></tr></thead><tbody>{totals.map((row) => <tr key={row.criticId}><th>{row.label}</th><td>{row.admitted}</td><td>{row.rejected}</td><td>{row.pending}</td><td>{row.scored}</td><td>{scoreText(row.total)}</td><td>{row.balance === undefined ? hasHistoricalScores ? "not recorded" : "pending" : scoreText(row.balance)}</td><td>{hasHistoricalScores ? "unchanged (v1)" : eligibility(row)}</td></tr>)}</tbody></table></div>
    {totals.map(row => <details className="game-feedback" key={row.criticId}><summary>{row.label} · own feedback history</summary>
      {gameFeedbackHistory(stage.members, row.criticId).length === 0 ? <p className="dim">No reports yet.</p> : gameFeedbackHistory(stage.members, row.criticId).map((feedback, index) => <article key={index}>
        <strong>{feedback.targetLabel} · step {feedback.step} · round {feedback.round.round}</strong>
        <p className="small">{gameDecisionText(feedback.round)}</p>
        {feedback.report ? <GameReport report={feedback.report} round={feedback.round} /> : <><p>{feedback.scoreRow?.reason}</p>{feedback.scoreRow && inventedBadgeText(feedback.scoreRow) !== "" && <p>{inventedBadgeText(feedback.scoreRow)}</p>}</>}
      </article>)}
    </details>)}
  </section>;
}
