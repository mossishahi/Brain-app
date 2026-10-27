import { isFactId } from "@brainstorm-agentic/core";
import type { GameChairDecisionView, GameCritiqueView, GameDecisionRule, GameLedgerView, GameReportLabel, GameReviewSettings, GameSettlementView, GameScoreRowView, JudgeIssueView } from "@brainstorm-agentic/protocol";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableNumber = (value: unknown): value is number | null => value === null || finite(value);
const label = (value: unknown): value is 0 | 1 | null => value === 0 || value === 1 || value === null;
const decisionRule = (value: unknown): value is GameDecisionRule => value === "committee-mean" || value === "chair-decisive";
const reportLabel = (value: unknown): value is GameReportLabel => value === "decisive" || value === "not-decisive" || value === "invalid";
/** Rule versions that carry balances, ledger sequences and durable receipts. */
const BALANCE_RULES: ReadonlySet<string> = new Set(["brier-peer/v2", "brier-peer/v3"]);
/** Scoring v3 floor, 2 x (-75) - 25 (GAME_SCORE_FLOOR of the v3 settlement schema): the fixed invented-badge and deleted-badge penalty score. */
const GAME_SCORE_FLOOR = -175;
const inventedBadges = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(isFactId);
const deletedBadges = inventedBadges;

/**
 * The penalty fields of a scoring v3 row: `inventedBadges` exactly on an
 * "invented-badge" row; `deletedBadges` on a "deleted-badge" row, or beside
 * invented badges on an "invented-badge" row, and only in a settlement that
 * enables the deleted-badge penalty (fact-update settlement rule).
 */
function penaltyFields(row: Record<string, unknown>, deletedBadgePenalty: boolean): boolean {
  if (row.deletedBadges !== undefined && (!deletedBadges(row.deletedBadges) || !deletedBadgePenalty)) return false;
  if (row.penalty === "invented-badge") return inventedBadges(row.inventedBadges);
  if (row.penalty === "deleted-badge") return row.inventedBadges === undefined && row.deletedBadges !== undefined;
  return false;
}

/** A checkpoint's declared mode wins; old checkpoints must not inherit new preferences. */
export function gameReviewEnabled(checkpoint: unknown, snapshot: { readonly gamifiedReview?: boolean } | undefined): boolean {
  if (checkpoint !== undefined) {
    const state = object(object(object(checkpoint)?.input)?.__brainstormState);
    return object(state?.params)?.gamifiedReview === true;
  }
  return snapshot?.gamifiedReview === true;
}

/** Like the mode, numerical policy comes from the checkpoint or submission snapshot only. */
export function gameReviewConfiguration(checkpoint: unknown, snapshot: { readonly gameReview?: GameReviewSettings } | undefined): GameReviewSettings {
  const params = object(object(object(object(checkpoint)?.input)?.__brainstormState)?.params);
  const threshold = checkpoint !== undefined ? params?.gameDecisionThreshold : snapshot?.gameReview?.threshold;
  const initialPoints = checkpoint !== undefined ? params?.gameInitialPoints : snapshot?.gameReview?.initialPoints;
  const rule = checkpoint !== undefined ? params?.gameDecisionRule : snapshot?.gameReview?.decisionRule;
  const leaveOneOut = checkpoint !== undefined ? params?.gameLeaveOneOut : snapshot?.gameReview?.leaveOneOut;
  // A checkpoint whose params lack the v3 names ran under a bundle without
  // them, i.e. the legacy mean rule; an unstarted run takes the spec defaults.
  return {
    threshold: finite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : 0.5,
    ...(finite(initialPoints) && initialPoints >= 0 ? { initialPoints } : {}),
    decisionRule: decisionRule(rule) ? rule : checkpoint !== undefined ? "committee-mean" : "chair-decisive",
    leaveOneOut: typeof leaveOneOut === "boolean" ? leaveOneOut : checkpoint === undefined,
  };
}

export function gameCritiqueView(value: unknown, criticId: string, criticLabel: string): GameCritiqueView | undefined {
  const raw = object(value);
  if (!finite(raw?.q) || raw.q < 0 || raw.q > 1 || typeof raw.justification !== "string") return undefined;
  return { criticId, criticLabel, q: raw.q, justification: raw.justification };
}

export function gameChairView(value: unknown, issues: readonly JudgeIssueView[]): GameChairDecisionView | undefined {
  const raw = object(value);
  const reports = object(raw?.reports);
  if (!raw || !reports || (raw.y !== undefined && !label(raw.y)) || typeof raw.reason !== "string") return undefined;
  const parsed: Record<string, GameChairDecisionView["reports"][string]> = {};
  for (const [id, value] of Object.entries(reports)) {
    const report = object(value);
    if (typeof report?.admissible !== "boolean" || typeof report.reason !== "string") return undefined;
    const factChecks = Array.isArray(report.factChecks) ? report.factChecks.flatMap(value => {
      const check = object(value);
      return typeof check?.factId === "string" && typeof check.conditions === "string" &&
        typeof check.supportsConclusion === "boolean" && typeof check.reason === "string"
        ? [{ factId: check.factId, ...(typeof check.verifiedFactId === "string" ? { verifiedFactId: check.verifiedFactId } : {}),
          ...(typeof check.badgeHash === "string" ? { badgeHash: check.badgeHash } : {}),
          ...(typeof check.approvalId === "string" ? { approvalId: check.approvalId } : {}),
          conditions: check.conditions, supportsConclusion: check.supportsConclusion, reason: check.reason }] : [];
    }) : undefined;
    if (report.label !== undefined && !reportLabel(report.label)) return undefined;
    parsed[id] = { admissible: report.admissible, reason: report.reason, ...(reportLabel(report.label) ? { label: report.label } : {}), ...(factChecks !== undefined ? { factChecks } : {}) };
  }
  return { reports: parsed, ...(label(raw.y) ? { y: raw.y } : {}), reason: raw.reason, issues };
}

/** Project the journaled deterministic result; never rescore with a later rule. */
export function gameSettlementView(value: unknown): GameSettlementView | undefined {
  const raw = object(value);
  if (!raw || typeof raw.ruleVersion !== "string" || typeof raw.version !== "string" ||
      !label(raw.y) || (raw.status !== "settled" && raw.status !== "no-valid-reports") ||
      !Number.isSafeInteger(raw.admittedCount) || !Array.isArray(raw.rows)) return undefined;
  const rows: GameScoreRowView[] = [];
  const version2 = BALANCE_RULES.has(raw.ruleVersion);
  const version3 = raw.ruleVersion === "brier-peer/v3";
  if (version3 && (!decisionRule(raw.decisionRule) || typeof raw.leaveOneOut !== "boolean")) return undefined;
  if (version2 && (!nullableNumber(raw.meanQ) || !finite(raw.threshold) || raw.threshold < 0 || raw.threshold > 1 ||
      !finite(raw.initialPoints) || raw.initialPoints < 0 || !Number.isSafeInteger(raw.ledgerSequence) ||
      (raw.ledgerSequence as number) < 1 || typeof raw.settlementId !== "string" ||
      !Array.isArray(raw.criticIds) || !raw.criticIds.every(id => typeof id === "string"))) return undefined;
  for (const value of raw.rows) {
    const row = object(value);
    if (!row || typeof row.criticId !== "string" || !finite(row.q) || row.q < 0 || row.q > 1 ||
        typeof row.admissible !== "boolean" || typeof row.reason !== "string" ||
        !nullableNumber(row.brierLoss) || !nullableNumber(row.baseScore) ||
        !nullableNumber(row.peerMeanBaseScore) || !nullableNumber(row.score)) return undefined;
    if (version2 && (!finite(row.balanceBefore) || !finite(row.balanceAfter) || typeof row.excluded !== "boolean")) return undefined;
    if (version3 && ((row.label !== undefined && row.label !== null && !reportLabel(row.label)) ||
        (row.scoringLabel !== undefined && !label(row.scoringLabel)))) return undefined;
    // Scoring v3 badge penalty (invented badges, deleted ones cited after their
    // deletion, or both): a rejected report that records exactly the floor score.
    const penalty = version3 && (row.penalty !== undefined || row.inventedBadges !== undefined || row.deletedBadges !== undefined);
    if (penalty && (!penaltyFields(row, raw.deletedBadgePenalty === true) ||
        row.admissible !== false || row.score !== GAME_SCORE_FLOOR)) return undefined;
    // Rejected reports are explicitly unscored, including in old/corrupt data.
    rows.push({ criticId: row.criticId, q: row.q, admissible: row.admissible, reason: row.reason,
      brierLoss: row.admissible ? row.brierLoss : null,
      baseScore: row.admissible ? row.baseScore : null,
      peerMeanBaseScore: row.admissible ? row.peerMeanBaseScore : null,
      score: row.admissible || penalty ? row.score : null,
      ...(version2 ? { balanceBefore: row.balanceBefore as number, balanceAfter: row.balanceAfter as number, excluded: row.excluded as boolean } : {}),
      ...(version3 ? { label: row.admissible && reportLabel(row.label) ? row.label : null,
        scoringLabel: row.admissible && label(row.scoringLabel) ? row.scoringLabel : null } : {}),
      ...(penalty ? {
        penalty: row.penalty as "invented-badge" | "deleted-badge",
        ...(row.inventedBadges !== undefined ? { inventedBadges: row.inventedBadges as string[] } : {}),
        ...(row.deletedBadges !== undefined ? { deletedBadges: row.deletedBadges as string[] } : {}),
      } : {}) });
  }
  return { ruleVersion: raw.ruleVersion, version: raw.version, y: raw.y, status: raw.status,
    admittedCount: raw.admittedCount as number, rows,
    ...(version2 ? {
      meanQ: raw.meanQ as number | null, threshold: raw.threshold as number,
      initialPoints: raw.initialPoints as number, ledgerSequence: raw.ledgerSequence as number,
      settlementId: raw.settlementId as string, criticIds: raw.criticIds as string[],
      ...(Array.isArray(raw.repairArguments) ? { repairArguments: raw.repairArguments.filter((value): value is string => typeof value === "string") } : {}),
    } : {}),
    ...(version3 ? { decisionRule: raw.decisionRule as GameDecisionRule, leaveOneOut: raw.leaveOneOut as boolean } : {}),
    ...(version3 && raw.inventedBadgePenalty === true ? { inventedBadgePenalty: true } : {}),
    ...(version3 && raw.deletedBadgePenalty === true ? { deletedBadgePenalty: true } : {}),
  };
}

/** Reconstruct balances from durable runtime receipts, never from UI iteration order or current settings. */
export function gameLedgerFromJournal(entries: readonly { readonly kind: string; readonly key: string; readonly value?: unknown }[]): GameLedgerView | undefined {
  const receipts: { sequence: number; settlement?: GameSettlementView; dispatch?: Record<string, unknown> }[] = [];
  for (const entry of entries) {
    if (entry.kind !== "activity") continue;
    const raw = object(entry.value);
    if (raw?.kind === "gameCriticDispatch" && typeof raw.ruleVersion === "string" && BALANCE_RULES.has(raw.ruleVersion) &&
        typeof raw.criticId === "string" && Array.isArray(raw.criticIds) && raw.criticIds.every(id => typeof id === "string") &&
        finite(raw.initialPoints) && raw.initialPoints >= 0 && finite(raw.balance) &&
        typeof raw.excluded === "boolean" && typeof raw.eligible === "boolean" &&
        Number.isSafeInteger(raw.ledgerSequence) && (raw.ledgerSequence as number) >= 0) {
      receipts.push({ sequence: raw.ledgerSequence as number, dispatch: raw });
    } else if (/\/game-settle(?:-run)?::result$/.test(entry.key)) {
      const settlement = gameSettlementView(raw);
      if (settlement && BALANCE_RULES.has(settlement.ruleVersion)) receipts.push({ sequence: settlement.ledgerSequence!, settlement });
    }
  }
  receipts.sort((a, b) => a.sequence - b.sequence || Number(!!a.settlement) - Number(!!b.settlement));
  let initialPoints: number | undefined;
  let ledgerSequence = 0;
  const critics = new Map<string, GameLedgerView["critics"][number]>();
  for (const receipt of receipts) {
    const ids = receipt.settlement?.criticIds ?? receipt.dispatch!.criticIds as readonly string[];
    initialPoints ??= receipt.settlement?.initialPoints ?? receipt.dispatch!.initialPoints as number;
    for (const criticId of ids) if (!critics.has(criticId)) critics.set(criticId, { criticId, balance: initialPoints, excluded: false, eligible: true });
    ledgerSequence = Math.max(ledgerSequence, receipt.sequence);
    if (receipt.dispatch) {
      const dispatch = receipt.dispatch;
      const criticId = dispatch.criticId as string;
      const excluded = critics.get(criticId)?.excluded === true || dispatch.excluded === true;
      critics.set(criticId, { criticId, balance: dispatch.balance as number, excluded, eligible: !excluded && dispatch.eligible === true });
    }
    for (const row of receipt.settlement?.rows ?? []) {
      const excluded = critics.get(row.criticId)?.excluded === true || row.excluded === true;
      critics.set(row.criticId, { criticId: row.criticId, balance: row.balanceAfter!, excluded, eligible: !excluded });
    }
  }
  return initialPoints === undefined ? undefined : { initialPoints, ledgerSequence, critics: [...critics.values()] };
}
