/**
 * The optional confirm-needs gate (spec v2 D2; contract D/K) as pure
 * functions: the needs and weights a run would retrieve with, and the edits
 * editRule "needs" allows — removing facets (at least 3 stay), aliases and
 * equivalent problems, and re-weighting relevance / confidence within [0,1].
 * Text is never added or rewritten.
 *
 * No React and no DOM here, so `node --test` runs it.
 */

export interface NeedsFacet {
  readonly name: string;
  readonly statement: string;
  readonly relevance: number;
  readonly aliases?: readonly string[];
  readonly kind?: string;
  readonly [key: string]: unknown;
}

export interface NeedsEquivalentProblem {
  readonly field: string;
  readonly name: string;
  readonly statement: string;
  readonly confidence: number;
  readonly [key: string]: unknown;
}

/** The classifier's embeddingInput, as far as this gate reads it. */
export interface NeedsInput {
  readonly title: string;
  readonly abstract: string;
  readonly facets: readonly NeedsFacet[];
  readonly problemFormulation?: string;
  readonly equivalentProblems?: readonly NeedsEquivalentProblem[];
  readonly keyTerms?: readonly string[];
  readonly [key: string]: unknown;
}

export interface NeedsWeights {
  readonly coreWeight: number;
  readonly formulationWeight: number;
  readonly equivalentProblemWeight: number;
}

/** Response of GET /api/jobs/:jobId/needs. */
export interface NeedsGateView {
  readonly gateKey: string;
  readonly embeddingInput: NeedsInput;
  readonly weights: NeedsWeights;
}

/** The answer that edits the needs (sent to POST /api/jobs/:jobId/gate). */
export interface NeedsGateAnswer {
  readonly gateKey: string;
  readonly action: "approve" | "edit";
  readonly embeddingInput?: NeedsInput;
}

export const MIN_FACETS = 3;

/** One need as spec v2 Section 2 defines it. */
export interface NeedRow {
  readonly kind: "core" | "facet" | "formulation" | "equivalent";
  readonly name: string;
  readonly weight: number;
  /** Weight 0: not a need, but still feeds retrieval (routes B and C). */
  readonly retrievalOnly: boolean;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * F = core (coreWeight) + facets (relevance) + formulation (formulationWeight,
 * if present) + equivalent problems (equivalentProblemWeight x confidence).
 */
export function needRows(input: NeedsInput, weights: NeedsWeights): NeedRow[] {
  const rows: NeedRow[] = [
    { kind: "core", name: input.title, weight: weights.coreWeight, retrievalOnly: weights.coreWeight <= 0 },
  ];
  for (const facet of input.facets) {
    rows.push({ kind: "facet", name: facet.name, weight: facet.relevance, retrievalOnly: facet.relevance <= 0 });
  }
  if (typeof input.problemFormulation === "string" && input.problemFormulation.trim() !== "") {
    rows.push({
      kind: "formulation",
      name: "problem formulation",
      weight: weights.formulationWeight,
      retrievalOnly: weights.formulationWeight <= 0,
    });
  }
  for (const problem of input.equivalentProblems ?? []) {
    const weight = weights.equivalentProblemWeight * problem.confidence;
    rows.push({ kind: "equivalent", name: `${problem.name} (${problem.field})`, weight, retrievalOnly: weight <= 0 });
  }
  return rows;
}

/** W = Σ weights of the needs (weight-0 entries contribute nothing). */
export function totalWeight(rows: readonly NeedRow[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
}

export function removeFacet(input: NeedsInput, index: number): NeedsInput {
  if (input.facets.length <= MIN_FACETS) return input;
  return { ...input, facets: input.facets.filter((_, i) => i !== index) };
}

export function removeAlias(input: NeedsInput, facetIndex: number, alias: string): NeedsInput {
  return {
    ...input,
    facets: input.facets.map((facet, i) =>
      i === facetIndex && facet.aliases
        ? { ...facet, aliases: facet.aliases.filter((entry) => entry !== alias) }
        : facet,
    ),
  };
}

export function setRelevance(input: NeedsInput, facetIndex: number, value: number): NeedsInput {
  if (!Number.isFinite(value)) return input;
  return {
    ...input,
    facets: input.facets.map((facet, i) =>
      i === facetIndex ? { ...facet, relevance: clamp01(value) } : facet,
    ),
  };
}

export function removeEquivalent(input: NeedsInput, index: number): NeedsInput {
  if (!input.equivalentProblems) return input;
  return { ...input, equivalentProblems: input.equivalentProblems.filter((_, i) => i !== index) };
}

export function setConfidence(input: NeedsInput, index: number, value: number): NeedsInput {
  if (!input.equivalentProblems || !Number.isFinite(value)) return input;
  return {
    ...input,
    equivalentProblems: input.equivalentProblems.map((problem, i) =>
      i === index ? { ...problem, confidence: clamp01(value) } : problem,
    ),
  };
}

/** Whether the edited input differs from what the classifier produced. */
export function needsEdited(original: NeedsInput, edited: NeedsInput): boolean {
  return JSON.stringify(original) !== JSON.stringify(edited);
}

/** Approve as read, or edit with the full edited embeddingInput. */
export function needsGateAnswer(
  gateKey: string,
  original: NeedsInput,
  edited: NeedsInput,
): NeedsGateAnswer {
  return needsEdited(original, edited)
    ? { gateKey, action: "edit", embeddingInput: edited }
    : { gateKey, action: "approve" };
}
