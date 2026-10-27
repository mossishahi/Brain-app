import { artifactSchemas } from "@brainstorm-agentic/content";
import type { JsonObject, JsonValue } from "@brainstorm-agentic/core";
import { factReviewVersion } from "@brainstorm-agentic/core";

import { BrainstormRuntimeError } from "./errors.js";

export const GAME_SCORE_RULE = "brier-peer/v1";

function record(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Identifies the immutable chain prefix on which a round's reports were made. */
export function gameReviewVersion(chain: JsonValue, currentStep: number): string {
  return factReviewVersion(chain, currentStep);
}

/**
 * Checks the chair against the reports it actually received. These checks run
 * in the output validator (retryable) and again at settlement (authoritative).
 * Disagreement with y is not grounds for removing a report from the cohort.
 */
export function gameChairContextIssues(
  value: unknown,
  critiques: unknown,
  currentStep?: number,
): string[] {
  if (!record(value) || !record(value.reports) || !record(critiques)) {
    return ["The chair decision needs a report assessment for the submitted critique map."];
  }
  const expected = Object.keys(critiques).sort();
  const supplied = Object.keys(value.reports).sort();
  const issues: string[] = [];
  if (expected.length !== supplied.length || expected.some((id, index) => supplied[index] !== id)) {
    issues.push("reports: assess every submitted critic exactly once, without adding or omitting critic IDs");
  }
  const admitted = Object.values(value.reports).filter(
    (assessment) => record(assessment) && assessment.admissible === true,
  ).length;
  if ((admitted === 0) !== (value.y === null)) {
    issues.push("y: use null exactly when no report is admissible; otherwise use 0 or 1");
  }
  if (currentStep !== undefined && Array.isArray(value.issues)) {
    for (const issue of value.issues) {
      if (!record(issue) || typeof issue.step !== "number" || issue.step < 1 || issue.step > currentStep) {
        issues.push("issues: target only steps in the reviewed chain prefix");
        break;
      }
    }
  }
  return issues;
}

/**
 * Observational scoring only. The chair supplies y; this function makes no
 * scientific judgment and never changes dispatch, labels, or panel membership.
 * Rejected reports remain visible, with null scores and outside peer means.
 */
export function settleGameReview(input: JsonObject): JsonObject {
  if (!record(input.critiques) || !Array.isArray(input.chain) || input.chain.length < 1) {
    throw new BrainstormRuntimeError("review.gameSettle needs the reports and the exact reviewed chain prefix", "INVALID_GAME_REVIEW");
  }
  const currentStep = input.chain.length;
  const critiques = Object.fromEntries(Object.entries(input.critiques).map(([id, raw]) => {
    const parsed = artifactSchemas.gameCritique.safeParse(raw);
    if (!parsed.success) {
      throw new BrainstormRuntimeError(`invalid game critique from ${id}: ${parsed.error.message}`, "INVALID_GAME_REVIEW");
    }
    return [id, parsed.data];
  }));
  const parsedChair = artifactSchemas.gameChairDecision.safeParse(input.chair);
  if (!parsedChair.success) {
    throw new BrainstormRuntimeError(`invalid game chair decision: ${parsedChair.error.message}`, "INVALID_GAME_REVIEW");
  }
  const chair = parsedChair.data;
  const issues = gameChairContextIssues(chair, critiques, currentStep);
  if (issues.length > 0) throw new BrainstormRuntimeError(issues.join("; "), "INVALID_GAME_REVIEW");
  // Sort before every sum: parallel completion order must not change scores.
  const ids = Object.keys(critiques).sort();
  const admitted = ids.filter((id) => chair.reports[id]!.admissible);
  const base = new Map<string, number>();
  if (chair.y !== null) {
    for (const id of admitted) base.set(id, 25 - 100 * (critiques[id]!.q - chair.y) ** 2);
  }
  const rows = ids.map((criticId): JsonObject => {
    const q = critiques[criticId]!.q;
    const assessment = chair.reports[criticId]!;
    const baseScore = base.get(criticId) ?? null;
    const peers = admitted.filter((id) => id !== criticId);
    const peerMeanBaseScore = baseScore !== null && peers.length > 0
      ? peers.reduce((sum, id) => sum + base.get(id)!, 0) / peers.length
      : null;
    return {
      criticId, q, admissible: assessment.admissible, reason: assessment.reason,
      brierLoss: baseScore === null || chair.y === null ? null : (q - chair.y) ** 2,
      baseScore, peerMeanBaseScore,
      score: baseScore === null ? null : peerMeanBaseScore === null ? baseScore : 2 * baseScore - peerMeanBaseScore,
    };
  });
  const settlement: JsonObject = {
    ruleVersion: GAME_SCORE_RULE,
    version: gameReviewVersion(input.chain, currentStep),
    y: chair.y,
    status: admitted.length === 0 ? "no-valid-reports" : "settled",
    admittedCount: admitted.length,
    rows,
    // Compatibility for the existing repair and review bookkeeping. A null y
    // is explicitly unresolved; it must never become a scientific Pass.
    decision: {
      verdict: chair.y === 0 ? "Pass" : "Interrupt",
      reason: chair.reason,
      suggestion: chair.issues.map((issue) => issue.suggestion).filter(Boolean).join("\n\n"),
      evidence: { kind: "none", code: "", result: "", derivation: "", citation: "", locator: "", shows: "" },
      issues: chair.issues as unknown as JsonValue,
    },
  };
  return settlement;
}
