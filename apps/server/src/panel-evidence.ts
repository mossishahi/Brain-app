/**
 * The gate-time views of the paper-based panel composition (spec v2, Step 11;
 * contract K): the confirm-panel coverage view built from the run's
 * panelEvidence and literature artifacts, and the optional confirm-needs gate
 * built from the classifier's embeddingInput — plus the server-side mirror of
 * the runtime's editRule "needs" (the runtime re-validates authoritatively).
 *
 * Runs pinned to bundles without these artifacts get no view (the routes
 * answer 404), so their gate cards render exactly as before.
 */
import type { GateAnswerRequest } from "@brainstorm-agentic/protocol";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

/**
 * A gate answer as this server accepts it: the protocol's request, plus the
 * confirm-needs gate's "edit" action carrying the edited embeddingInput
 * (contract D/K). The protocol package does not declare these yet.
 */
export type ServerGateAnswer = Omit<GateAnswerRequest, "action"> & {
  readonly action: GateAnswerRequest["action"] | "edit";
  readonly embeddingInput?: JsonRecord;
};

/** The confirm-needs gate's node id (contract D). */
export const CONFIRM_NEEDS_GATE = "confirm-needs";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strings(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === "string");
}

/* ------------------------------------------------------------ coverage view */

export interface CoverageNeedView {
  /** Position in literature.needs; a[] and coverage[] are aligned to it. */
  readonly index: number;
  readonly id: number;
  readonly kind: string;
  readonly name: string;
  readonly weight: number;
  /** w >= criticalWeight: the needs k_cov must cover. */
  readonly critical: boolean;
  readonly thin: boolean;
}

export interface CoverageExemplarView {
  readonly pid: string;
  readonly score: number;
  readonly title?: string;
  readonly year?: number;
  readonly url?: string;
}

export interface CoverageSeatView {
  /** 1-based position in the greedy order. */
  readonly order: number;
  readonly id: string;
  readonly department: string;
  readonly umbrella: string;
  readonly subfields: readonly string[];
  readonly kind: string;
  readonly cand: string;
  readonly name?: string;
  /** a(seat, need) per need, aligned to `needs`; empty when the candidate is unknown. */
  readonly a: readonly number[];
  readonly covers: readonly string[];
  readonly exemplars: readonly CoverageExemplarView[];
  readonly inKStar: boolean;
  readonly rescued: boolean;
}

export interface CoverageCurvePoint {
  readonly k: number;
  readonly cand: string;
  readonly gain: number;
  readonly F: number;
  readonly Fnorm: number;
  readonly coverage: readonly number[];
  readonly runnerUp?: string;
  readonly runnerUpGain?: number;
}

export interface PanelEvidenceView {
  readonly version: 1;
  readonly W: number;
  readonly kStar: number;
  readonly kCov: number | null;
  readonly epsW: number;
  readonly criticalWeight: number;
  readonly criticalCoverage: number;
  readonly panelSize?: number;
  readonly panelSizeMode?: string;
  readonly needs: readonly CoverageNeedView[];
  readonly seats: readonly CoverageSeatView[];
  readonly curve: readonly CoverageCurvePoint[];
  readonly droppedByCap: readonly {
    readonly cand: string;
    readonly name?: string;
    readonly why: string;
    readonly atK: number;
    readonly gain: number;
  }[];
  readonly rescued: readonly string[];
  readonly flags: {
    readonly sourceShare: Readonly<Record<string, number>>;
    readonly sourceAlarm: readonly string[];
    readonly thinNeeds: readonly string[];
    readonly anchoredSeats: readonly string[];
    readonly failedSources: readonly string[];
    readonly screenedOut: number;
    readonly weakPlacements: number;
    readonly budgetExhausted: boolean;
    readonly hubs: readonly { readonly topic: string; readonly share: number }[];
    readonly notes: readonly string[];
    readonly sources: readonly { readonly id: string; readonly state: string; readonly detail?: string }[];
  };
  readonly determinismSha256?: string;
}

/** A paper's best public link, from the ids the literature record carries. */
export function paperUrl(ids: unknown): string | undefined {
  const entry = record(ids);
  if (!entry) return undefined;
  const doi = str(entry.doi);
  if (doi) return `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
  const arxiv = str(entry.arxivId);
  if (arxiv) return `https://arxiv.org/abs/${arxiv.replace(/^arxiv:/i, "")}`;
  const pmid = str(entry.pmid);
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  const s2 = str(entry.s2Id);
  if (s2) return `https://www.semanticscholar.org/paper/${s2}`;
  const oa = str(entry.oaId);
  if (oa) return `https://openalex.org/${oa.replace(/^https?:\/\/openalex\.org\//i, "")}`;
  const core = str(entry.coreId);
  if (core) return `https://core.ac.uk/works/${core}`;
  return undefined;
}

/**
 * The coverage view of one run, or undefined when the run has no
 * panelEvidence artifact (older bundles) or it is not version 1.
 */
export function buildPanelEvidenceView(
  evidenceValue: unknown,
  literatureValue: unknown,
): PanelEvidenceView | undefined {
  const evidence = record(evidenceValue);
  if (!evidence || evidence.version !== 1) return undefined;
  const literature = record(literatureValue);
  const params = record(evidence.params) ?? {};
  const criticalWeight = num(params.criticalWeight) ?? 0.5;
  const criticalCoverage = num(params.criticalCoverage) ?? 0.75;
  const greedy = record(evidence.greedy) ?? {};
  const flags = record(evidence.flags) ?? {};
  const thinNeeds = strings(flags.thinNeeds);
  const evidenceRows = list(evidence.evidence).map(record);

  const literatureNeeds = list(literature?.needs).map(record);
  const needCount = Math.max(literatureNeeds.length, evidenceRows.length);
  const needs: CoverageNeedView[] = [];
  for (let index = 0; index < needCount; index += 1) {
    const need = literatureNeeds[index];
    const row = evidenceRows[index];
    const name = str(need?.name) ?? `need ${index}`;
    const weight = num(need?.weight) ?? 0;
    needs.push({
      index,
      id: num(need?.id) ?? num(row?.need) ?? index,
      kind: str(need?.kind) ?? "need",
      name,
      weight,
      critical: weight >= criticalWeight,
      thin: row?.thin === true || thinNeeds.includes(name),
    });
  }

  const papers = new Map<string, Record<string, unknown>>();
  for (const paper of list(literature?.papers)) {
    const entry = record(paper);
    const pid = str(entry?.pid);
    if (entry && pid) papers.set(pid, entry);
  }
  const candidates = new Map<string, Record<string, unknown>>();
  for (const candidate of list(evidence.candidates)) {
    const entry = record(candidate);
    const id = str(entry?.cand);
    if (entry && id) candidates.set(id, entry);
  }
  const rescued = strings(greedy.rescued);

  const seats: CoverageSeatView[] = [];
  for (const [position, raw] of list(evidence.seats).entries()) {
    const seat = record(raw);
    const id = str(seat?.id);
    if (!seat || !id) continue;
    const cand = str(seat.cand) ?? "";
    const candidate = candidates.get(cand);
    const a = list(candidate?.a).map((value) => num(value) ?? 0);
    seats.push({
      order: position + 1,
      id,
      department: str(seat.department) ?? "",
      umbrella: str(seat.umbrella) ?? "",
      subfields: strings(seat.subfields),
      kind: str(seat.kind) ?? str(candidate?.kind) ?? "topic",
      cand,
      ...(str(candidate?.name) !== undefined ? { name: str(candidate?.name)! } : {}),
      a,
      covers: strings(seat.covers),
      exemplars: list(seat.exemplars).flatMap((rawExemplar): CoverageExemplarView[] => {
        const exemplar = record(rawExemplar);
        const pid = str(exemplar?.pid);
        if (!exemplar || !pid) return [];
        const paper = papers.get(pid);
        const title = str(paper?.title) ?? str(exemplar.title);
        const year = num(paper?.year);
        const url = paperUrl(paper?.ids);
        return [
          {
            pid,
            score: num(exemplar.score) ?? 0,
            ...(title !== undefined ? { title } : {}),
            ...(year !== undefined ? { year } : {}),
            ...(url !== undefined ? { url } : {}),
          },
        ];
      }),
      inKStar: seat.inKStar === true,
      rescued: rescued.includes(cand) || rescued.includes(id),
    });
  }

  const curve: CoverageCurvePoint[] = list(greedy.trace).flatMap((raw): CoverageCurvePoint[] => {
    const point = record(raw);
    const k = num(point?.k);
    if (!point || k === undefined) return [];
    const runnerUp = str(point.runnerUp);
    const runnerUpGain = num(point.runnerUpGain);
    return [
      {
        k,
        cand: str(point.cand) ?? "",
        gain: num(point.gain) ?? 0,
        F: num(point.F) ?? 0,
        Fnorm: num(point.Fnorm) ?? 0,
        coverage: list(point.coverage).map((value) => num(value) ?? 0),
        ...(runnerUp !== undefined ? { runnerUp } : {}),
        ...(runnerUpGain !== undefined ? { runnerUpGain } : {}),
      },
    ];
  });

  const literatureFlags = record(literature?.flags) ?? {};
  const shareRaw = record(flags.sourceShare) ?? {};
  const sourceShare: Record<string, number> = {};
  for (const [source, share] of Object.entries(shareRaw)) {
    const value = num(share);
    if (value !== undefined) sourceShare[source] = value;
  }
  const W = num(literature?.W) ?? needs.reduce((sum, need) => sum + need.weight, 0);
  const panelSize = num(params.panelSize);
  const panelSizeMode = str(params.panelSizeMode);
  const determinism = str(evidence.determinismSha256);
  return {
    version: 1,
    W,
    kStar: num(greedy.kStar) ?? 0,
    kCov: num(greedy.kCov) ?? null,
    epsW: num(greedy.epsW) ?? 0,
    criticalWeight,
    criticalCoverage,
    ...(panelSize !== undefined ? { panelSize } : {}),
    ...(panelSizeMode !== undefined ? { panelSizeMode } : {}),
    needs,
    seats,
    curve,
    droppedByCap: list(greedy.droppedByCap).flatMap((raw) => {
      const entry = record(raw);
      const cand = str(entry?.cand);
      if (!entry || cand === undefined) return [];
      const name = str(candidates.get(cand)?.name);
      return [
        {
          cand,
          ...(name !== undefined ? { name } : {}),
          why: str(entry.why) ?? "",
          atK: num(entry.atK) ?? 0,
          gain: num(entry.gain) ?? 0,
        },
      ];
    }),
    rescued,
    flags: {
      sourceShare,
      sourceAlarm: strings(flags.sourceAlarm),
      thinNeeds,
      anchoredSeats: strings(flags.anchoredSeats),
      failedSources: strings(flags.failedSources),
      screenedOut: num(flags.screenedOut) ?? 0,
      weakPlacements: num(flags.weakPlacements) ?? 0,
      budgetExhausted: literatureFlags.budgetExhausted === true,
      hubs: list(literatureFlags.hubs).flatMap((raw) => {
        const hub = record(raw);
        const topic = str(hub?.topic);
        const share = num(hub?.share);
        return topic !== undefined && share !== undefined ? [{ topic, share }] : [];
      }),
      notes: strings(literatureFlags.notes),
      sources: list(literature?.sources).flatMap((raw) => {
        const source = record(raw);
        const id = str(source?.id);
        const state = str(source?.state);
        if (id === undefined || state === undefined) return [];
        const detail = str(source?.detail);
        return [{ id, state, ...(detail !== undefined ? { detail } : {}) }];
      }),
    },
    ...(determinism !== undefined ? { determinismSha256: determinism } : {}),
  };
}

/* ------------------------------------------------------- confirm-needs gate */

/** The three weight params the needs depend on (spec 0.1 defaults). */
export interface NeedsWeights {
  readonly coreWeight: number;
  readonly formulationWeight: number;
  readonly equivalentProblemWeight: number;
}

export const DEFAULT_NEEDS_WEIGHTS: NeedsWeights = {
  coreWeight: 1,
  formulationWeight: 0.5,
  equivalentProblemWeight: 0,
};

/** Response of GET /api/jobs/:jobId/needs while the confirm-needs gate is pending. */
export interface NeedsGateView {
  readonly gateKey: string;
  readonly embeddingInput: JsonRecord;
  readonly weights: NeedsWeights;
}

export function buildNeedsGateView(
  gateKey: string,
  classificationValue: unknown,
  params: unknown,
): NeedsGateView | undefined {
  const embeddingInput = record(record(classificationValue)?.embeddingInput);
  if (!embeddingInput) return undefined;
  const values = record(params) ?? {};
  return {
    gateKey,
    embeddingInput: embeddingInput as JsonRecord,
    weights: {
      coreWeight: num(values.coreWeight) ?? DEFAULT_NEEDS_WEIGHTS.coreWeight,
      formulationWeight: num(values.formulationWeight) ?? DEFAULT_NEEDS_WEIGHTS.formulationWeight,
      equivalentProblemWeight:
        num(values.equivalentProblemWeight) ?? DEFAULT_NEEDS_WEIGHTS.equivalentProblemWeight,
    },
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Minimum facets an embeddingInput keeps (contract C/K). */
export const MIN_NEEDS_FACETS = 3;

/**
 * editRule "needs" (contract K), mirrored: the edited embeddingInput may only
 * remove facets, aliases or equivalent problems and change relevance /
 * confidence values within [0,1]; it may not add or rewrite text; facets stay
 * >= 3. Returns the reason when the edit is refused.
 */
export function needsEditViolation(originalValue: unknown, editedValue: unknown): string | undefined {
  const original = record(originalValue);
  const edited = record(editedValue);
  if (!original) return "the run has no embeddingInput to edit";
  if (!edited) return "embeddingInput must be an object";
  for (const key of Object.keys(edited)) {
    if (!(key in original)) return `embeddingInput.${key} cannot be added`;
  }
  for (const key of Object.keys(original)) {
    if (key === "facets" || key === "equivalentProblems") continue;
    if (!(key in edited)) return `embeddingInput.${key} cannot be removed`;
    if (!sameJson(original[key], edited[key])) return `embeddingInput.${key} cannot be rewritten`;
  }
  const originalFacets = list(original.facets).map(record);
  const editedFacets = list(edited.facets);
  if (!Array.isArray(edited.facets)) return "embeddingInput.facets must be an array";
  if (editedFacets.length < MIN_NEEDS_FACETS) {
    return `at least ${MIN_NEEDS_FACETS} facets must remain`;
  }
  let cursor = 0;
  for (const [index, raw] of editedFacets.entries()) {
    const facet = record(raw);
    if (!facet) return `facet ${index + 1} must be an object`;
    while (cursor < originalFacets.length && str(originalFacets[cursor]?.name) !== str(facet.name)) {
      cursor += 1;
    }
    const source = originalFacets[cursor];
    if (!source) return `facet "${str(facet.name) ?? index + 1}" is not one of the classifier's facets (or is out of order)`;
    cursor += 1;
    for (const key of Object.keys(facet)) {
      if (!(key in source)) return `facet "${str(facet.name)}": ${key} cannot be added`;
    }
    for (const key of Object.keys(source)) {
      if (key === "relevance" || key === "aliases") continue;
      if (!sameJson(source[key], facet[key])) return `facet "${str(facet.name)}": ${key} cannot be rewritten`;
    }
    const relevance = facet.relevance;
    if (typeof relevance !== "number" || !Number.isFinite(relevance) || relevance < 0 || relevance > 1) {
      return `facet "${str(facet.name)}": relevance must be within [0, 1]`;
    }
    if ("aliases" in source || "aliases" in facet) {
      const before = strings(source.aliases);
      if (facet.aliases !== undefined && !Array.isArray(facet.aliases)) {
        return `facet "${str(facet.name)}": aliases must be an array`;
      }
      const after = list(facet.aliases);
      let at = 0;
      for (const alias of after) {
        while (at < before.length && before[at] !== alias) at += 1;
        if (at >= before.length) return `facet "${str(facet.name)}": alias "${String(alias)}" is not one of the classifier's aliases`;
        at += 1;
      }
    }
  }
  if ("equivalentProblems" in edited) {
    if (!Array.isArray(edited.equivalentProblems)) return "embeddingInput.equivalentProblems must be an array";
    const before = list(original.equivalentProblems).map(record);
    let at = 0;
    for (const [index, raw] of edited.equivalentProblems.entries()) {
      const problem = record(raw);
      if (!problem) return `equivalent problem ${index + 1} must be an object`;
      while (
        at < before.length &&
        !(str(before[at]?.name) === str(problem.name) && str(before[at]?.field) === str(problem.field))
      ) {
        at += 1;
      }
      const source = before[at];
      if (!source) return `equivalent problem "${str(problem.name) ?? index + 1}" is not one of the classifier's (or is out of order)`;
      at += 1;
      for (const key of Object.keys(problem)) {
        if (!(key in source)) return `equivalent problem "${str(problem.name)}": ${key} cannot be added`;
      }
      for (const key of Object.keys(source)) {
        if (key === "confidence") continue;
        if (!sameJson(source[key], problem[key])) return `equivalent problem "${str(problem.name)}": ${key} cannot be rewritten`;
      }
      const confidence = problem.confidence;
      if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return `equivalent problem "${str(problem.name)}": confidence must be within [0, 1]`;
      }
    }
  }
  return undefined;
}
