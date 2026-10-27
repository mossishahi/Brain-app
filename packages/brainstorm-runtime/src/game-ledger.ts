import { artifactSchemas, GAME_SCORE_FLOOR, stableGameMean } from "@brainstorm-agentic/content";
import type { FactEntry, FactEvidenceSnapshot, JournalEntry, JsonObject, JsonValue } from "@brainstorm-agentic/core";
import { factIdsIn, factBadgeHash, factStandingRevision, factReportHash } from "@brainstorm-agentic/core";

import { BrainstormRuntimeError } from "./errors.js";
import { gameChairContextIssues, gameReviewVersion } from "./game-review.js";

export const COMMITTEE_SCORE_RULE = "brier-peer/v3";
/** Earlier committee rules whose journals replay with the same balance arithmetic and are never re-scored. */
export const LEGACY_COMMITTEE_SCORE_RULES: ReadonlySet<string> = new Set(["brier-peer/v2"]);
export const GAME_DECISION_RULES = ["committee-mean", "chair-decisive"] as const;
export type GameDecisionRule = (typeof GAME_DECISION_RULES)[number];
export type ReadGameFacts = () => Promise<readonly FactEntry[]>;
export type ReadGameEvidence = () => Promise<FactEvidenceSnapshot>;

const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => { throw new BrainstormRuntimeError(message, "INVALID_GAME_LEDGER"); };
const committeeRule = (value: unknown): boolean => value === COMMITTEE_SCORE_RULE || (typeof value === "string" && LEGACY_COMMITTEE_SCORE_RULES.has(value));

/** Canonical near-zero addition for both new settlements and journal replay. */
function balanceAfterScore(before: number, score: number | null, baseScore: number | null, peerMean: number | null): number {
  if (score === null || score === 0) return before;
  const after = before + score;
  // 50-S is the magnitude sum 25 + 100*loss in S=25-100*loss.
  // Include those intermediate operations, not just the final (possibly
  // cancelling) score, so a few floating-point ulps cannot latch exclusion.
  // This is relative machine roundoff, never decimal/cents rounding or a
  // fixed epsilon: genuinely negative balances outside this tiny band remain.
  const ownMagnitude = 50 - baseScore!;
  const scoreMagnitude = peerMean === null ? ownMagnitude : 2 * ownMagnitude + 50 - peerMean;
  const roundoff = 4 * Number.EPSILON * (Math.abs(before) + Math.abs(score) + scoreMagnitude);
  return Math.abs(after) <= roundoff ? 0 : after;
}

export function citedGameFactIds(value: string): string[] {
  return [...factIdsIn(value)].sort();
}

/** The sorted unique badge ids cited, as by `factIdsIn`, in every string value
 * of `value`, recursively; object keys are not scanned. The ids a critic was
 * shown in its task input or in the reviewed chain are never invented badges. */
export function factIdsInValue(value: JsonValue | undefined): string[] {
  const ids = new Set<string>();
  const visit = (entry: JsonValue | undefined): void => {
    if (typeof entry === "string") {
      for (const id of factIdsIn(entry)) ids.add(id);
    } else if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
    } else if (object(entry)) {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  return [...ids].sort();
}

/** The host verification text of an invented-badge offence (spec 3.4). */
function inventedBadgeError(ids: readonly string[]): string {
  return `invented badge${ids.length === 1 ? "" : "s"} ${ids.join(", ")} never issued in this run's fact table; penalty ${GAME_SCORE_FLOOR}`;
}

/**
 * The penalty clause of a fined report (fact-update design section 7): the
 * invented badges, the badges cited after their deletion, or both, and the
 * one penalty. Invented badges alone read exactly as inventedBadgeError.
 */
function penaltyClause(invented: readonly string[], deleted: readonly string[]): string {
  if (deleted.length === 0) return inventedBadgeError(invented);
  const deletedText = deleted.length === 1
    ? `deleted badge ${deleted[0]} cited after its deletion from this run's fact table`
    : `deleted badges ${deleted.join(", ")} cited after their deletion from this run's fact table`;
  const clauses = invented.length > 0
    ? [`invented badge${invented.length === 1 ? "" : "s"} ${invented.join(", ")} never issued in this run's fact table`, deletedText]
    : [deletedText];
  return `${clauses.join("; ")}; penalty ${GAME_SCORE_FLOOR}`;
}

/** A deletion from the run's fact table as settlement reads it (id and deletion epoch). */
interface SettledDeletion {
  readonly id: string;
  readonly seq: number;
}

function settledDeletions(value: JsonValue | undefined): Map<string, SettledDeletion> {
  const deletions = new Map<string, SettledDeletion>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!object(raw) || typeof raw.id !== "string" || typeof raw.seq !== "number" || !Number.isSafeInteger(raw.seq) || raw.seq < 1) {
      return fail("fact-table deletions need an id and a deletion sequence");
    }
    deletions.set(raw.id, { id: raw.id, seq: raw.seq });
  }
  return deletions;
}

export function anonymizeRepairArgument(text: string, criticIds: readonly string[]): string {
  // Remove a standalone named-author header, never a whole labelled argument.
  // In particular "Reviewer: member-2 — claim [F:1]." must keep the claim.
  let result = text.replace(/^\s*(?:author|submitted by|reported by)\s*:\s*(?:Dr\.?|Prof\.?)\s+[\p{L}.' -]+\s*$/gimu, "");
  for (const id of [...criticIds].sort((a, b) => b.length - a.length)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "g"), "");
  }
  return result.replace(/^\s*(?:author|reviewer|critic|submitted by|reported by)\s*:\s*/gim, "")
    .replace(/^\s*[—–:-]\s*/gm, "").trim();
}

/** Only public fact fields cross into the committee's task; no requester history. */
export function committeeFactView(critiques: JsonObject, facts: readonly FactEntry[]): JsonValue[] {
  const cited = new Set(Object.values(critiques).flatMap((report) => object(report) && typeof report.justification === "string" ? citedGameFactIds(report.justification) : []));
  const originals = facts.filter((fact) => cited.has(fact.id));
  return facts.filter((fact) => cited.has(fact.id) || (fact.status === "justified" && originals.some((original) =>
    original.status === "disputed" && original.claim === fact.claim && original.conditions === fact.conditions && original.kind === fact.kind,
  ))).map((fact) => ({
    id: fact.id, claim: fact.claim, conditions: fact.conditions, kind: fact.kind, status: fact.status,
  }));
}

export function committeeContextIssues(value: unknown, critiques: unknown): string[] {
  if (!object(value) || !object(value.reports) || !object(critiques)) return ["committee reports must assess the submitted critique map"];
  // Reuse identity checking, but the committee never supplies the scientific y.
  const identities = gameChairContextIssues({ reports: value.reports, y: Object.values(value.reports).some((entry) => object(entry) && entry.admissible === true) ? 0 : null }, critiques);
  return identities;
}

interface Balance {
  value: number;
  excluded: boolean;
  history: JsonValue[];
}
interface RunLedger {
  criticIds: string[];
  initialPoints: number;
  sequence: number;
  balances: Map<string, Balance>;
  settlements: Map<string, JsonObject>;
}

/**
 * Shared across parallel thinker walks, never merged as branch-local state.
 * Runtime serializes dispatch and settlement effects through this coordinator,
 * and commits scores only after the journal has durably recorded the effect.
 */
export class GameReviewLedger {
  private readonly runs = new Map<string, RunLedger>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, unknown>();

  isExcluded(runId: string, criticId: string): boolean {
    return this.runs.get(runId)?.balances.get(criticId)?.excluded === true;
  }

  async serialize<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const pending = previous.then(async () => {
      if (this.failures.has(runId)) throw this.failures.get(runId);
      try { return await work(); } catch (error) { this.failures.set(runId, error); throw error; }
    });
    this.queues.set(runId, pending.catch(() => undefined));
    return pending;
  }

  /** Seed ALL completed effects before any branch may dispatch on resume. */
  hydrate(runId: string, journal: readonly JournalEntry[]): void {
    this.runs.delete(runId); this.queues.delete(runId); this.failures.delete(runId);
    const effects = journal.map((entry) => entry.value).filter((value): value is JsonObject =>
      object(value) && committeeRule(value.ruleVersion) && typeof value.settlementId === "string",
    ).sort((a, b) => Number(a.ledgerSequence) - Number(b.ledgerSequence));
    for (const effect of effects) this.commit(runId, effect);
  }

  private initialize(runId: string, ids: readonly string[], initialPoints: number): RunLedger {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !id) || !Number.isFinite(initialPoints) || initialPoints < 0) fail("invalid confirmed panel or initial game points");
    let run = this.runs.get(runId);
    if (run === undefined) {
      run = { criticIds: [...ids], initialPoints, sequence: 0, balances: new Map(ids.map((id) => [id, { value: initialPoints, excluded: false, history: [] }])), settlements: new Map() };
      this.runs.set(runId, run);
    } else if (run.initialPoints !== initialPoints || JSON.stringify(run.criticIds) !== JSON.stringify(ids)) {
      fail("the confirmed panel and initial points cannot change during a game run");
    }
    return run;
  }

  configure(runId: string, panel: JsonValue | undefined, configured: JsonValue | undefined): RunLedger {
    const members = object(panel) && Array.isArray(panel.members) ? panel.members : [];
    const ids = members.map((member) => object(member) && typeof member.id === "string" ? member.id : fail("confirmed game panel has an invalid member"));
    const points = configured === -1 || configured === undefined ? 100 * ids.length : configured;
    if (typeof points !== "number") return fail("game initial points must be numeric");
    return this.initialize(runId, ids, points);
  }

  /**
   * `factEpoch`: the run's fact-table deletion epoch at dispatch (fact
   * updates), journaled with the snapshot so a report's request time is exact
   * on every replay. Absent for runs without fact updates.
   */
  dispatch(runId: string, dispatchId: string, criticId: string, panel: JsonValue | undefined, configured: JsonValue | undefined,
    factEpoch?: number): JsonObject {
    const run = this.configure(runId, panel, configured);
    const balance = run.balances.get(criticId) ?? fail("game critic is not in the confirmed panel");
    return {
      kind: "gameCriticDispatch", ruleVersion: COMMITTEE_SCORE_RULE, dispatchId, criticId,
      criticIds: [...run.criticIds], initialPoints: run.initialPoints, balance: balance.value,
      excluded: balance.excluded, eligible: !balance.excluded, ledgerSequence: run.sequence,
      history: structuredClone(balance.history),
      ...(factEpoch !== undefined ? { factEpoch } : {}),
    };
  }

  settle(runId: string, settlementId: string, input: JsonObject, facts: readonly FactEntry[], evidence?: FactEvidenceSnapshot): JsonObject {
    if (!object(input.critiques) || !Array.isArray(input.chain) || input.chain.length < 1) return fail("committee settlement needs submitted reports and the reviewed prefix");
    const threshold = input.threshold;
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return fail("game threshold must be between zero and one");
    // The compiler binds both from the run's params; a caller that binds
    // neither gets the legacy rule exactly (committee mean, no leave-one-out).
    const decisionRule = input.decisionRule ?? "committee-mean";
    if (!GAME_DECISION_RULES.includes(decisionRule as GameDecisionRule)) return fail("game decision rule must be committee-mean or chair-decisive");
    const leaveOneOut = input.leaveOneOut ?? false;
    if (typeof leaveOneOut !== "boolean") return fail("game leave-one-out scoring must be boolean");
    const chairRule = decisionRule === "chair-decisive";
    const run = this.configure(runId, input.panel, input.initialPoints);
    const prior = run.settlements.get(settlementId);
    if (prior !== undefined) return structuredClone(prior);
    const chair = artifactSchemas.gameCommitteeDecision.parse(input.chair);
    const contextIssues = committeeContextIssues(chair, input.critiques);
    if (contextIssues.length > 0) return fail(contextIssues.join("; "));
    const reports = Object.fromEntries(Object.entries(input.critiques).map(([id, report]) => {
      if (!run.balances.has(id)) return fail("a report names a critic outside the confirmed panel");
      return [id, artifactSchemas.gameCritique.parse(report)];
    }));
    const actualFacts = new Map(facts.map((fact) => [fact.id, fact]));
    const mediated = input.factAccessMode === "supreme-mediated/v1";
    const approvals = new Map(evidence?.approvals.map((approval) => [approval.id, approval]) ?? []);
    if (mediated && (typeof input.chairTaskId !== "string" || !input.chairTaskId)) return fail("mediated settlement needs its actual committee task identity");
    // A re-assessed round (fact updates, decision D12) accepts a receipt from
    // any of the round's chair tasks; otherwise only the one chair task's.
    const chairTaskIds = new Set(Array.isArray(input.chairTaskIds)
      ? input.chairTaskIds.filter((id): id is string => typeof id === "string" && id !== "")
      : typeof input.chairTaskId === "string" ? [input.chairTaskId] : []);
    if (mediated && approvals.size !== (evidence?.approvals.length ?? 0)) return fail("Supreme approval identifiers must be unique");
    const reviewVersion = gameReviewVersion(input.chain, input.chain.length);
    // The compiler binds the invented-badge gate only for a run that enables it
    // in a bundle with a fact table, with the ids quoted in the critics' task
    // input; ids quoted in the reviewed chain are exempt as well.
    const inventedBadgePenalty = input.inventedBadgePenalty === true;
    // Fact updates (design section 7): the run's deletions with their epochs,
    // and each report's request epoch. A deleted badge quoted from the chain
    // or the task input is evidence; one deleted before the report was
    // requested is fined with deletionPenalty; one deleted after it rejects the
    // report without a fine.
    const deletionsBound = Array.isArray(input.deletions);
    const deleted = settledDeletions(input.deletions);
    const deletionPenalty = deletionsBound && input.deletionPenalty === true;
    const reportEpochs = object(input.reportEpochs) ? input.reportEpochs : {};
    const exemptBadgeIds = new Set(inventedBadgePenalty || deletionsBound ? [...factIdsInValue(input.chain),
      ...(Array.isArray(input.badgeSourceIds) ? input.badgeSourceIds.filter((id): id is string => typeof id === "string") : [])] : []);
    const ids = Object.keys(reports).sort();
    const assessed = ids.map((criticId) => {
      const report = reports[criticId]!;
      const assessment = chair.reports[criticId]!;
      const cited = citedGameFactIds(report.justification);
      const checks = new Map(assessment.factChecks.map((check) => [check.factId, check]));
      const errors: string[] = [];
      const replacements = new Map<string, string>();
      // Admission classifies the argument's claims. Direct reasoning may cite
      // no badges; citing any still requires exact checks of the real table.
      // An invented badge is cited, never issued in this run's fact table in
      // any status, and not quoted from the reviewed chain or the task input.
      // The host checks then run as if it had not been cited (addendum D4):
      // no per-id errors for it, and coverage compares only the other cited
      // ids with the chair's checks of those ids. Without an invented badge
      // this is exactly the previous check over every cited id and check.
      const invented = inventedBadgePenalty ? cited.filter((id) => !actualFacts.has(id) && !deleted.has(id) && !exemptBadgeIds.has(id)) : [];
      const epochValue = reportEpochs[criticId];
      const epoch = typeof epochValue === "number" && Number.isFinite(epochValue) ? epochValue : 0;
      const quoted = cited.filter((id) => deleted.has(id) && exemptBadgeIds.has(id));
      const deletedBefore = cited.filter((id) => deleted.has(id) && !exemptBadgeIds.has(id) && deleted.get(id)!.seq <= epoch);
      const finedDeleted = deletionPenalty ? deletedBefore : [];
      // Like an invented id (addendum D4), a quoted or fined deleted id is left
      // out of the checks and of the coverage the chair's checks must match.
      const skipped = new Set([...invented, ...quoted, ...finedDeleted]);
      const verified = cited.filter((id) => !skipped.has(id));
      const coverage = new Set([...checks.keys()].filter((id) => !skipped.has(id)));
      if (coverage.size !== verified.length || verified.some((id) => !coverage.has(id))) errors.push("fact checks must cover exactly the cited supporting badges");
      for (const id of verified) {
        const deletion = deleted.get(id);
        if (deletion !== undefined) {
          errors.push(deletion.seq > epoch
            ? `${id} was deleted from this run's fact table after this report was requested`
            : `${id} was deleted from this run's fact table before this report was requested`);
          continue;
        }
        const original = actualFacts.get(id);
        const check = checks.get(id);
        if (mediated) {
          const receipt = check?.approvalId === undefined ? undefined : approvals.get(check.approvalId);
          const target = receipt === undefined ? undefined : actualFacts.get(receipt.targetBadgeId);
          if (!receipt || !check?.badgeHash) errors.push(`${id} has no durable Supreme approval and badge hash`);
          else if (!chairTaskIds.has(receipt.requesterTaskId) || receipt.reviewVersion !== reviewVersion ||
              receipt.criticId !== criticId || receipt.reportHash !== factReportHash(report) || receipt.citedBadgeId !== id ||
              receipt.citedBadgeHash !== check.badgeHash) errors.push(`${id} Supreme approval belongs to a different report, review, or badge`);
          else if (!original || factBadgeHash(original) !== receipt.citedBadgeHash ||
              (original.badgeHash !== undefined && original.badgeHash !== receipt.citedBadgeHash) ||
              original.status === "revoked" || original.status === "refuted") errors.push(`${id} cited badge revision is missing, changed, or invalid`);
          else if (!receipt.approved) errors.push(`${id} Supreme approval was denied: ${receipt.reason}`);
          else if (!target || target.status !== "justified" || factBadgeHash(target) !== receipt.targetBadgeHash ||
              (target.badgeHash !== undefined && target.badgeHash !== receipt.targetBadgeHash) ||
              factStandingRevision(target) !== receipt.targetStandingRevision) errors.push(`${id} approved target badge or standing has changed`);
          else if (check.verifiedFactId !== undefined && check.verifiedFactId !== target.id) errors.push(`${id} replacement does not match its Supreme approval`);
          else if (!check.supportsConclusion) errors.push(`${id} does not support the report's conclusion`);
          else replacements.set(id, target.id);
          continue;
        }
        let fact = original;
        if (check?.verifiedFactId !== undefined && check.verifiedFactId !== id) {
          const verified = actualFacts.get(check.verifiedFactId);
          if (original?.status === "disputed" && verified?.status === "justified" &&
              original.claim === verified.claim && original.conditions === verified.conditions && original.kind === verified.kind) {
            fact = verified; replacements.set(id, verified.id);
          } else errors.push(`${id} has no valid same-claim reconciliation to ${check.verifiedFactId}`);
        }
        if (!fact || fact.status !== "justified") errors.push(`${id} is not a currently justified table entry`);
        else if (!check || check.conditions !== fact.conditions) errors.push(`${id} conditions do not match the verified fact`);
        if (check?.supportsConclusion !== true) errors.push(`${id} does not support the report's conclusion under those conditions`);
      }
      const fined = invented.length > 0 || finedDeleted.length > 0;
      const admissible = !fined && assessment.admissible && errors.length === 0;
      const mapped = admissible && replacements.size > 0
        ? mediated
          ? ` Supreme approved this report's cited premises: ${verified.map((id) => approvals.get(checks.get(id)!.approvalId!)!.reason).join(" ")}`
          : ` Host verified the same claim, conditions, and kind under ${[...replacements].map(([from, to]) => `${from} -> ${to}`).join(", ")}.` : "";
      const hostErrors = fined ? [...errors, penaltyClause(invented, finedDeleted)] : errors;
      return { criticId, report, replacements, admissible, label: assessment.label, invented, deletedBadges: finedDeleted,
        reason: admissible || (!assessment.admissible && !fined) ? assessment.reason + mapped : `${assessment.reason} Host verification: ${hostErrors.join("; ")}.` };
    });
    const admitted = assessed.filter((entry) => entry.admissible);
    if (chairRule && admitted.some((entry) => entry.label === undefined)) return fail("chair-decisive settlement needs the chair's label on every admitted report");
    // meanQ is always recorded for the dashboard; under chair-decisive it decides nothing.
    const meanQ = stableGameMean(admitted.map((entry) => entry.report.q));
    const decisive = chairRule ? admitted.filter((entry) => entry.label === "decisive") : [];
    const y = meanQ === null ? null : chairRule ? (decisive.length > 0 ? 1 : 0) : meanQ >= threshold ? 1 : 0;
    // The label each admitted report is scored against: y, or under
    // committee-mean with leave-one-out the threshold applied to the OTHER
    // admitted reports (null, hence unscored, for a lone admitted report).
    const scoringLabels = new Map(admitted.map((entry): [string, 0 | 1 | null] => {
      if (chairRule || !leaveOneOut) return [entry.criticId, y];
      const others = stableGameMean(admitted.filter((peer) => peer.criticId !== entry.criticId).map((peer) => peer.report.q));
      return [entry.criticId, others === null ? null : others >= threshold ? 1 : 0];
    }));
    const base = new Map<string, number>();
    for (const entry of admitted) {
      const target = scoringLabels.get(entry.criticId)!;
      if (target !== null) base.set(entry.criticId, 25 - 100 * (entry.report.q - target) ** 2);
    }
    const rows = assessed.map((entry): JsonObject => {
      const balance = run.balances.get(entry.criticId)!;
      const scoringLabel = scoringLabels.get(entry.criticId) ?? null;
      const baseScore = base.get(entry.criticId) ?? null;
      const peers = admitted.filter((peer) => peer.criticId !== entry.criticId && base.has(peer.criticId));
      const peerMeanBaseScore = baseScore !== null && peers.length > 0 ? peers.reduce((sum, peer) => sum + base.get(peer.criticId)!, 0) / peers.length : null;
      // An invented badge, or a deleted one cited after its deletion, records
      // the floor once, outside y, the labels and every peer mean, and moves
      // the balance by exactly GAME_SCORE_FLOOR.
      const penalized = entry.invented.length > 0 || entry.deletedBadges.length > 0;
      const score = penalized ? GAME_SCORE_FLOOR : baseScore === null ? null : peerMeanBaseScore === null ? baseScore : 2 * baseScore - peerMeanBaseScore;
      const balanceAfter = penalized ? balance.value + GAME_SCORE_FLOOR : balanceAfterScore(balance.value, score, baseScore, peerMeanBaseScore);
      return {
        criticId: entry.criticId, q: entry.report.q, admissible: entry.admissible, reason: entry.reason,
        label: entry.admissible ? (entry.label ?? null) : null, scoringLabel,
        brierLoss: scoringLabel === null ? null : (entry.report.q - scoringLabel) ** 2,
        baseScore, peerMeanBaseScore, score, balanceBefore: balance.value, balanceAfter,
        excluded: balance.excluded || balanceAfter < 0,
        ...(penalized ? { penalty: entry.invented.length > 0 ? "invented-badge" : "deleted-badge",
          ...(entry.invented.length > 0 ? { inventedBadges: [...entry.invented] } : {}),
          ...(entry.deletedBadges.length > 0 ? { deletedBadges: [...entry.deletedBadges] } : {}) } : {}),
      };
    });
    const repairArguments = y === 1 ? (chairRule ? decisive : admitted.filter((entry) => entry.report.q >= threshold))
      .map((entry) => {
        let text = anonymizeRepairArgument(entry.report.justification, run.criticIds);
        text = text.replace(/\[[^\]]+\]/g, (group) => group.replace(/F:[1-9][0-9]*/g, (id) => entry.replacements.get(id) ?? id));
        return text;
      }) : [];
    const count = `${admitted.length} admitted report${admitted.length === 1 ? "" : "s"}`;
    const outcome = y === null
      ? "Unresolved: no reports were admitted, so no mean or scientific label was assigned."
      : chairRule
        ? y === 1
          ? `Blocked by a decisive argument: ${decisive.length} of ${count} ${decisive.length === 1 ? "is" : "are"} labelled decisive by the committee chair (mean q=${meanQ} recorded, threshold ${threshold} not applied); y=1.`
          : `Pass: no admitted argument is decisive (${count}, mean q=${meanQ} recorded, threshold ${threshold} not applied); y=0.`
        : `${y === 1 ? "Blocked" : "Pass"}: ${count} have mean q=${meanQ}, ${y === 1 ? ">=" : "<"} threshold ${threshold}; y=${y}.${leaveOneOut ? " Each report is scored against the label of the other admitted reports." : ""}`;
    const overrides = assessed.filter((entry) => chair.reports[entry.criticId]!.admissible && !entry.admissible);
    const overrideReason = overrides.length === 0 ? "" : ` Host admission overrides: ${overrides.map((entry) => `${entry.criticId}: ${entry.reason}`).join(" ")}`;
    return {
      ruleVersion: COMMITTEE_SCORE_RULE, settlementId, ledgerSequence: run.sequence + 1,
      version: gameReviewVersion(input.chain, input.chain.length), criticIds: [...run.criticIds], initialPoints: run.initialPoints,
      decisionRule, leaveOneOut, ...(inventedBadgePenalty ? { inventedBadgePenalty: true } : {}),
      ...(deletionPenalty ? { deletedBadgePenalty: true } : {}), meanQ, threshold, y, status: y === null ? "no-valid-reports" : "settled", admittedCount: admitted.length, rows,
      repairArguments,
      decision: { verdict: y === 0 ? "Pass" : "Interrupt", reason: `${outcome}${overrideReason} Committee assessment: ${chair.reason}`, suggestion: repairArguments.join("\n\n"),
        evidence: { kind: "none", code: "", result: "", derivation: "", citation: "", locator: "", shows: "" }, issues: [] },
    };
  }

  /** Called only after the raw settlement has been saved in the journal.
   * A legacy (v2) record replays with the same balance arithmetic and keeps
   * its recorded scores; its rows carry no labels. */
  commit(runId: string, raw: JsonValue | undefined): void {
    if (!object(raw) || !committeeRule(raw.ruleVersion) || typeof raw.settlementId !== "string") return;
    const parsed = artifactSchemas.gameSettlement.parse(raw) as unknown as JsonObject;
    const run = this.initialize(runId, parsed.criticIds as string[], Number(parsed.initialPoints));
    const existing = run.settlements.get(raw.settlementId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) fail("a recorded game settlement cannot change during replay");
      return;
    }
    if (parsed.ledgerSequence !== run.sequence + 1) fail("the durable game ledger has a missing or duplicate sequence");
    for (const row of parsed.rows as JsonObject[]) {
      const balance = run.balances.get(String(row.criticId)) ?? fail("a settlement critic is outside its confirmed panel");
      // A penalty row replays the exact arithmetic of settle(), with no roundoff band.
      const expectedAfter = row.penalty === "invented-badge" || row.penalty === "deleted-badge" ? balance.value + GAME_SCORE_FLOOR
        : balanceAfterScore(balance.value, row.score as number | null, row.baseScore as number | null, row.peerMeanBaseScore as number | null);
      if (row.balanceBefore !== balance.value || row.balanceAfter !== expectedAfter || row.excluded !== (balance.excluded || Number(row.balanceAfter) < 0)) fail("a recorded game balance is inconsistent with its preceding scores");
      balance.value = Number(row.balanceAfter); balance.excluded = row.excluded === true;
      balance.history.push({ settlementId: raw.settlementId, version: parsed.version!, q: row.q!, y: parsed.y!, admissible: row.admissible!, reason: row.reason!,
        label: row.label ?? null, scoringLabel: row.scoringLabel ?? null, score: row.score!, balanceAfter: row.balanceAfter!, excluded: row.excluded!,
        ...(row.penalty !== undefined ? { penalty: row.penalty } : {}), ...(row.inventedBadges !== undefined ? { inventedBadges: row.inventedBadges } : {}),
        ...(row.deletedBadges !== undefined ? { deletedBadges: row.deletedBadges } : {}) });
    }
    run.sequence += 1;
    run.settlements.set(raw.settlementId, structuredClone(parsed));
  }
}
