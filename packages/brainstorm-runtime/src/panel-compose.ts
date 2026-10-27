/**
 * panel.compose and panel.seat — Steps 6-11 of the paper-based panel
 * composition (spec v2): evidence per need from the retrieved literature,
 * topic and facet-anchored candidates with their need affinities, a lazy
 * greedy maximisation of weighted need coverage under the subfield and field
 * caps, the committee size (k*, k_cov), the seats with their exemplar papers,
 * the flags and a determinism hash.
 *
 * Everything here is a pure function of its inputs: the literature record
 * (placements and need similarities already rounded to 6 decimals), the
 * screen, the params and the taxonomy hierarchy. Every ranking has an
 * explicit tie key and every sum runs in a fixed order — the same order as
 * the Python prototype (compose2.py), whose records this one reproduces.
 */
import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "@brainstorm-agentic/core";

/* ------------------------------------------------------------------------ */
/* Params (spec v2, Section 0)                                               */
/* ------------------------------------------------------------------------ */

/** Every panel-composition param with its spec default. */
export const PANEL_COMPOSITION_DEFAULTS = {
  panelSize: 6,
  panelSizeMode: "auto",
  askUserToConfirmNeeds: false,
  coreWeight: 1.0,
  formulationWeight: 0.5,
  equivalentProblemWeight: 0,
  sourceArxiv: true,
  sourceCrossref: true,
  sourceSemanticScholar: true,
  sourceOpenAlex: true,
  sourceEuropePmc: false,
  sourceCore: true,
  sourceOpenCitations: true,
  resultsPerCall: 25,
  maxCalls: 150,
  yearFrom: 0,
  routeTitle: true,
  routeFacetNames: true,
  routeFacetAliases: true,
  routePairs: "all",
  maxPairQueries: 15,
  routeStatements: true,
  routeEquivalents: true,
  routeKnn: true,
  knnK: 5,
  knnHopK: 0,
  knnKeywords: 0,
  knnMaxQueries: 20,
  routeCitations: true,
  citationSeeds: 10,
  citationLimit: 25,
  citationDirections: "both",
  routeFeedback: true,
  feedbackSeeds: 10,
  feedbackTerms: 5,
  routeKeyTerms: false,
  maxRounds: 2,
  minNewShare: 0.1,
  relevanceScreen: false,
  encoder: "specter2",
  minAbstractChars: 200,
  maxPapers: 1000,
  topicsPerPaper: 3,
  papersPerNeed: 20,
  weakPlacementQuantile: 0.05,
  minSupport: 2,
  saturationShare: 0.3,
  maxAffinity: 0.8,
  seatsPerSubfield: 0,
  seatsPerField: 0,
  gainStop: 0.05,
  criticalWeight: 0.5,
  criticalCoverage: 0.75,
  anchors: true,
  anchorThreshold: 0.4,
  anchorAffinity: 0.6,
  rescueUncoveredNeeds: true,
  shareAlarm: 0.6,
  thinNeed: 0.25,
  hubShare: 0.5,
} as const;

type Widen<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string : T;
export type PanelCompositionParams = { -readonly [K in keyof typeof PANEL_COMPOSITION_DEFAULTS]: Widen<(typeof PANEL_COMPOSITION_DEFAULTS)[K]> };

/**
 * The params a run composes with: each declared value of the bound params
 * object whose type matches the default's, the default otherwise (a bundle
 * that predates a knob, or a mistyped value, never breaks the stage).
 */
export function panelCompositionParams(config: JsonValue | undefined): PanelCompositionParams {
  const source = isObject(config) ? config : {};
  const out: Record<string, string | number | boolean> = {};
  for (const [name, fallback] of Object.entries(PANEL_COMPOSITION_DEFAULTS)) {
    const value = source[name];
    out[name] =
      typeof value === typeof fallback && (typeof value !== "number" || Number.isFinite(value))
        ? (value as string | number | boolean)
        : fallback;
  }
  return out as unknown as PanelCompositionParams;
}

/* ------------------------------------------------------------------------ */
/* Numeric helpers (shared with literature-activities)                       */
/* ------------------------------------------------------------------------ */

/**
 * Rounds to 6 decimals exactly as Python's round(x, 6): correctly rounded
 * on the double's exact decimal value, an exact tie going to the even digit.
 */
export function round6(value: number): number {
  if (!Number.isFinite(value)) return value;
  let text = value.toFixed(6);
  const magnitude = Math.abs(value);
  if (magnitude.toFixed(7).endsWith("5")) {
    const exact = magnitude.toFixed(100);
    const point = exact.indexOf(".");
    if (exact[point + 7] === "5" && /^0*$/.test(exact.slice(point + 8))) {
      const truncated = exact.slice(0, point + 7);
      if (Number(truncated[truncated.length - 1]) % 2 === 0) text = `${value < 0 ? "-" : ""}${truncated}`;
    }
  }
  const rounded = Number(text);
  return rounded === 0 ? 0 : rounded;
}

/**
 * Margin weights over the top entries of a ranked list: (s_l - s_ref) /
 * sum(s_l' - s_ref), uniform when the sum is not positive (spec Steps 5-6).
 * The sum runs left to right, as the prototype's.
 */
export function marginWeights(top: readonly number[], reference: number): number[] {
  const margins = top.map((value) => value - reference);
  let total = 0;
  for (const margin of margins) total += margin;
  if (total > 0) return margins.map((margin) => margin / total);
  return top.map(() => 1 / top.length);
}

/** NumPy's default (linear) quantile of an unsorted sample. */
export function linearQuantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

/** Code-unit string order (Python's order for the ASCII ids used here). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------------ */
/* Taxonomy hierarchy                                                        */
/* ------------------------------------------------------------------------ */

export interface TopicPosition {
  readonly id: string;
  readonly name: string;
  readonly subfield: { readonly id: string; readonly name: string };
  readonly field: { readonly id: string; readonly name: string };
}

export interface TopicHierarchy {
  /** The topic's subfield and field, or undefined when the taxonomy does not hold it. */
  topic(id: string): TopicPosition | undefined;
  /** A subfield's name and field. */
  subfield(id: string): { readonly id: string; readonly name: string; readonly field: { readonly id: string; readonly name: string } } | undefined;
}

/** The hierarchy of a taxonomy node list (id, name, level, parent). */
export function topicHierarchy(
  nodes: ReadonlyArray<{ readonly id: string; readonly name: string; readonly level: string; readonly parent?: string }>,
): TopicHierarchy {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const subfield = (id: string) => {
    const node = byId.get(id);
    if (node === undefined) return undefined;
    const field = node.parent !== undefined ? byId.get(node.parent) : undefined;
    return {
      id: node.id,
      name: node.name,
      field: { id: field?.id ?? node.id, name: field?.name ?? node.name },
    };
  };
  return {
    subfield,
    topic(id) {
      const node = byId.get(id);
      if (node === undefined || node.level !== "topic" || node.parent === undefined) return undefined;
      const parent = subfield(node.parent);
      if (parent === undefined) return undefined;
      return { id: node.id, name: node.name, subfield: { id: parent.id, name: parent.name }, field: parent.field };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Inputs                                                                    */
/* ------------------------------------------------------------------------ */

export interface ComposeNeed {
  readonly id: number;
  readonly kind: string;
  readonly name: string;
  readonly weight: number;
}

export interface ComposePaper {
  readonly pid: string;
  readonly cid: string;
  readonly rrf: number;
  readonly sources: readonly string[];
  readonly hits: ReadonlyArray<{ readonly source: string; readonly query: string; readonly rank: number }>;
  readonly placement: ReadonlyArray<{ readonly topic: string; readonly sim: number; readonly pi: number }>;
  readonly needSims: readonly number[];
  readonly weak: boolean;
}

export interface ComposeInput {
  readonly needs: readonly ComposeNeed[];
  /** Query id -> own need id (null: no own need). */
  readonly queryOwn: ReadonlyMap<string, number | null>;
  /** Eligible, on-topic papers in the literature's order (fused rank). */
  readonly papers: readonly ComposePaper[];
  /** Sources whose calls failed or that were unavailable, sorted. */
  readonly failedSources: readonly string[];
  /** Literature papers the relevance screen judged off-topic. */
  readonly screenedOut: number;
  /**
   * Label-only fallback shares per need (the margin-weighted topics nearest
   * each need), used only when no eligible paper remains.
   */
  readonly labelShares?: ReadonlyArray<ReadonlyArray<{ readonly topic: string; readonly pi: number }>>;
}

interface Candidate {
  readonly cand: string;
  readonly kind: "topic" | "anchor";
  readonly name: string;
  readonly subfield: string;
  readonly subfieldName: string;
  readonly field: string;
  readonly fieldName: string;
  readonly support: number;
  readonly a: readonly number[];
  readonly P: readonly number[];
  readonly M: number;
  readonly anchorNeed?: number;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return isObject(value) ? value : {};
}

/** The literature's eligible, on-topic papers and needs as compose inputs. */
export function composeInputFromLiterature(
  literature: JsonObject,
  screen: JsonObject | undefined,
): ComposeInput {
  const needs = asArray(literature.needs).map((entry) => {
    const need = asRecord(entry);
    return {
      id: Number(need.id),
      kind: String(need.kind),
      name: String(need.name),
      weight: Number(need.weight),
    };
  });
  const queryOwn = new Map<string, number | null>();
  for (const entry of asArray(literature.queries)) {
    const query = asRecord(entry);
    queryOwn.set(String(query.id), typeof query.own === "number" ? query.own : null);
  }
  const offTopic = new Set(
    asArray(screen?.decisions)
      .map(asRecord)
      .filter((decision) => decision.onTopic === false)
      .map((decision) => String(decision.pid)),
  );
  let screenedOut = 0;
  const papers: ComposePaper[] = [];
  for (const entry of asArray(literature.papers)) {
    const paper = asRecord(entry);
    if (offTopic.has(String(paper.pid))) {
      screenedOut += 1;
      continue;
    }
    if (paper.decision !== "eligible") continue;
    papers.push({
      pid: String(paper.pid),
      cid: String(paper.cid),
      rrf: Number(paper.rrf),
      sources: asArray(paper.sources).map(String),
      hits: asArray(paper.hits).map((hit) => {
        const record = asRecord(hit);
        return { source: String(record.source), query: String(record.query), rank: Number(record.rank) };
      }),
      placement: asArray(paper.placement).map((place) => {
        const record = asRecord(place);
        return { topic: String(record.topic), sim: Number(record.sim), pi: Number(record.pi) };
      }),
      needSims: asArray(paper.needSims).map(Number),
      weak: paper.weak === true,
    });
  }
  const failed = new Set<string>();
  for (const call of asArray(literature.calls).map(asRecord)) if (call.ok === false) failed.add(String(call.source));
  for (const source of asArray(literature.sources).map(asRecord)) if (source.state === "unavailable") failed.add(String(source.id));
  return {
    needs,
    queryOwn,
    papers,
    failedSources: [...failed].sort(compareText),
    screenedOut,
  };
}

/* ------------------------------------------------------------------------ */
/* Step 6: evidence per need                                                 */
/* ------------------------------------------------------------------------ */

export interface NeedEvidence {
  /** Indices into the eligible papers, in D_f order. */
  readonly top: readonly number[];
  /** omega(d, f) per entry of `top` (unrounded). */
  readonly omega: readonly number[];
  readonly sK1: number | null;
  /** P(t|f), in first-contribution order. */
  readonly shares: ReadonlyMap<string, number>;
  readonly ownShare: number;
  readonly thin: boolean;
}

/** Eligible-paper indices of need f in D_f order: similarity, then fused rank, then canonical id. */
export function needOrder(papers: readonly ComposePaper[], f: number): number[] {
  return papers
    .map((_, index) => index)
    .sort((a, b) => {
      const pa = papers[a]!;
      const pb = papers[b]!;
      const sa = pa.needSims[f] ?? 0;
      const sb = pb.needSims[f] ?? 0;
      if (sa !== sb) return sb - sa;
      if (pa.rrf !== pb.rrf) return pb.rrf - pa.rrf;
      return compareText(pa.cid, pb.cid);
    });
}

/**
 * D_f (the K papers most similar to need f), their margin weights omega
 * against the (K+1)-th similarity (uniform when |D| <= K or every margin is
 * 0), the evidence shares P(t|f) = sum_d omega(d,f) pi(d,t), and the share
 * of D_f found by the need's own queries.
 */
export function needEvidence(input: ComposeInput, f: number, K: number, thinNeed: number): NeedEvidence {
  const papers = input.papers;
  const need = input.needs[f]!;
  const order = needOrder(papers, f);
  const top = order.slice(0, K);
  let omega: number[];
  let sK1: number | null;
  if (papers.length > K) {
    sK1 = papers[order[K]!]!.needSims[f] ?? 0;
    omega = marginWeights(top.map((index) => papers[index]!.needSims[f] ?? 0), sK1);
  } else {
    sK1 = null;
    omega = top.map(() => 1 / top.length);
  }
  const shares = new Map<string, number>();
  top.forEach((index, k) => {
    for (const place of papers[index]!.placement) {
      if (place.pi > 0) shares.set(place.topic, (shares.get(place.topic) ?? 0) + omega[k]! * place.pi);
    }
  });
  const own = top.filter((index) =>
    papers[index]!.hits.some((hit) => input.queryOwn.get(hit.query) === need.id),
  ).length;
  const ownShare = top.length > 0 ? own / top.length : 0;
  return { top, omega, sK1, shares, ownShare, thin: ownShare < thinNeed };
}

/* ------------------------------------------------------------------------ */
/* Step 8: lazy greedy                                                       */
/* ------------------------------------------------------------------------ */

export interface GreedyPick {
  readonly k: number;
  readonly index: number;
  readonly gain: number;
  readonly F: number;
  readonly coverage: readonly number[];
  readonly runnerUp?: number;
  readonly runnerUpGain?: number;
  /** [need id, w_f a(j,f) (1 - c_f(S_k-1))] for every need with a(j,f) > 0. */
  readonly contrib: ReadonlyArray<readonly [number, number]>;
}

export interface GreedyResult {
  /** The seat list: the start seats, then the picks. */
  readonly order: readonly number[];
  readonly picks: readonly GreedyPick[];
  readonly dropped: ReadonlyArray<{ readonly index: number; readonly why: "subfield cap" | "field cap"; readonly atK: number; readonly gain: number }>;
}

/** Tie order: larger M, then topic before anchor, then the smaller id. */
function tieCompare(a: Candidate, b: Candidate): number {
  if (a.M !== b.M) return b.M - a.M;
  const ka = a.kind === "topic" ? 0 : 1;
  const kb = b.kind === "topic" ? 0 : 1;
  if (ka !== kb) return ka - kb;
  return compareText(a.cand, b.cand);
}

function coverageOf(candidates: readonly Candidate[], seats: readonly number[], needCount: number): number[] {
  let cov = new Array<number>(needCount).fill(0);
  for (const index of seats) {
    const a = candidates[index]!.a;
    cov = cov.map((value, f) => 1 - (1 - value) * (1 - a[f]!));
  }
  return cov;
}

/**
 * Lazy greedy maximisation of F(S) = sum_f w_f c_f(S) from the seat list
 * `start` up to kMax seats, under the subfield cap (0 = none) and the field
 * cap. Stale gains wait in a priority queue keyed by (gain, tie order) and
 * only the top entry is recomputed (gains only fall as S grows); a candidate
 * that would break a cap is dropped for good. Each pick records its
 * runner-up: the best other feasible candidate by fresh gain, then the tie
 * order.
 */
export function lazyGreedy(
  candidates: readonly Candidate[],
  needs: readonly ComposeNeed[],
  options: { readonly kMax: number; readonly subfieldCap: number; readonly fieldCap: number; readonly start?: readonly number[] },
): GreedyResult {
  const weights = needs.map((need) => need.weight);
  const selected = [...(options.start ?? [])];
  let cov = coverageOf(candidates, selected, needs.length);
  const subUsed = new Map<string, number>();
  const fieldUsed = new Map<string, number>();
  for (const index of selected) {
    const candidate = candidates[index]!;
    subUsed.set(candidate.subfield, (subUsed.get(candidate.subfield) ?? 0) + 1);
    fieldUsed.set(candidate.field, (fieldUsed.get(candidate.field) ?? 0) + 1);
  }
  const gainOf = (candidate: Candidate): number => {
    let total = 0;
    for (let f = 0; f < weights.length; f += 1) total += weights[f]! * candidate.a[f]! * (1 - cov[f]!);
    return total;
  };
  const feasible = (candidate: Candidate): boolean =>
    (options.subfieldCap <= 0 || (subUsed.get(candidate.subfield) ?? 0) < options.subfieldCap) &&
    (fieldUsed.get(candidate.field) ?? 0) < options.fieldCap;
  interface Entry {
    gain: number;
    readonly index: number;
    stamp: number;
  }
  const before = (x: Entry, y: Entry): boolean => {
    if (x.gain !== y.gain) return x.gain > y.gain;
    const tie = tieCompare(candidates[x.index]!, candidates[y.index]!);
    if (tie !== 0) return tie < 0;
    return x.index < y.index;
  };
  const gone = new Set<number>(selected);
  const queue: Entry[] = [];
  candidates.forEach((candidate, index) => {
    if (!gone.has(index)) queue.push({ gain: gainOf(candidate), index, stamp: selected.length });
  });
  const pop = (): Entry => {
    let best = 0;
    for (let i = 1; i < queue.length; i += 1) if (before(queue[i]!, queue[best]!)) best = i;
    return queue.splice(best, 1)[0]!;
  };
  const picks: GreedyPick[] = [];
  const dropped: Array<{ index: number; why: "subfield cap" | "field cap"; atK: number; gain: number }> = [];
  while (queue.length > 0 && selected.length < options.kMax) {
    const entry = pop();
    const candidate = candidates[entry.index]!;
    if (entry.stamp !== selected.length) {
      entry.gain = gainOf(candidate);
      entry.stamp = selected.length;
      queue.push(entry);
      continue;
    }
    if (options.subfieldCap > 0 && (subUsed.get(candidate.subfield) ?? 0) >= options.subfieldCap) {
      dropped.push({ index: entry.index, why: "subfield cap", atK: selected.length + 1, gain: entry.gain });
      gone.add(entry.index);
      continue;
    }
    if ((fieldUsed.get(candidate.field) ?? 0) >= options.fieldCap) {
      dropped.push({ index: entry.index, why: "field cap", atK: selected.length + 1, gain: entry.gain });
      gone.add(entry.index);
      continue;
    }
    if (entry.gain <= 0) break;
    let runnerUp = -1;
    let runnerUpGain = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const other = candidates[index]!;
      if (index === entry.index || gone.has(index) || !feasible(other)) continue;
      const gain = gainOf(other);
      if (
        runnerUp < 0 ||
        gain > runnerUpGain ||
        (gain === runnerUpGain && tieCompare(other, candidates[runnerUp]!) < 0)
      ) {
        runnerUp = index;
        runnerUpGain = gain;
      }
    }
    const contrib: Array<readonly [number, number]> = [];
    for (let f = 0; f < weights.length; f += 1) {
      if (candidate.a[f]! > 0) contrib.push([needs[f]!.id, weights[f]! * candidate.a[f]! * (1 - cov[f]!)]);
    }
    selected.push(entry.index);
    gone.add(entry.index);
    subUsed.set(candidate.subfield, (subUsed.get(candidate.subfield) ?? 0) + 1);
    fieldUsed.set(candidate.field, (fieldUsed.get(candidate.field) ?? 0) + 1);
    cov = cov.map((value, f) => 1 - (1 - value) * (1 - candidate.a[f]!));
    let F = 0;
    for (let f = 0; f < weights.length; f += 1) F += weights[f]! * cov[f]!;
    picks.push({
      k: selected.length,
      index: entry.index,
      gain: entry.gain,
      F,
      coverage: [...cov],
      ...(runnerUp >= 0 ? { runnerUp, runnerUpGain } : {}),
      contrib,
    });
  }
  return { order: selected, picks, dropped };
}

/** k* = min{k >= 2 : gain_(k+1) < eps W} over the trace, else max(2, |trace|). */
export function kStarOf(gains: readonly number[], epsW: number): number {
  for (let k = 2; k <= gains.length; k += 1) {
    if ((k < gains.length ? gains[k]! : 0) < epsW) return k;
  }
  return Math.max(2, gains.length);
}

/* ------------------------------------------------------------------------ */
/* Determinism hash                                                          */
/* ------------------------------------------------------------------------ */

/** A float as Python's repr() writes it (shortest round-trip digits). */
export function pythonFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const decpt = Number(exponentText) + 1;
  if (decpt <= -4 || decpt > 16) {
    const exponent = decpt - 1;
    const body = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${body}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/**
 * Canonical JSON as the prototype hashes it — json.dumps(sort_keys=True,
 * separators=(",", ":"), ensure_ascii=False) — with every number written as
 * a Python float except the integer keys named in `integerKeys`.
 */
export function pythonCanonicalJson(value: JsonValue | undefined, integerKeys: ReadonlySet<string> = new Set(), key?: string): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "number") {
    return key !== undefined && integerKeys.has(key) && Number.isInteger(value) ? String(value) : pythonFloat(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => pythonCanonicalJson(entry, integerKeys, key)).join(",")}]`;
  const record = value as Record<string, JsonValue>;
  return `{${Object.keys(record)
    .filter((name) => record[name] !== undefined)
    .sort(compareText)
    .map((name) => `${JSON.stringify(name)}:${pythonCanonicalJson(record[name], integerKeys, name)}`)
    .join(",")}}`;
}

/* ------------------------------------------------------------------------ */
/* Steps 6-11                                                                */
/* ------------------------------------------------------------------------ */

const TOP_TOPICS = 12;
const EXEMPLARS = 3;
const COVERS_MIN_AFFINITY = 0.2;

/**
 * Composes the panel evidence (spec v2 Steps 6-11) from the literature's
 * eligible papers. Deterministic: the same inputs give the same record and
 * the same hash.
 */
export function composePanelEvidence(
  input: ComposeInput,
  params: PanelCompositionParams,
  hierarchy: TopicHierarchy,
): JsonObject {
  const needs = input.needs;
  const weights = needs.map((need) => need.weight);
  let W = 0;
  for (const weight of weights) W += weight;
  const papers = input.papers;
  const notes: string[] = [];
  const labelOnly = papers.length === 0;

  // ---- Step 6: evidence per need
  const evidence: NeedEvidence[] = needs.map((_, f) => {
    if (!labelOnly) return needEvidence(input, f, params.papersPerNeed, params.thinNeed);
    const shares = new Map<string, number>();
    for (const entry of input.labelShares?.[f] ?? []) shares.set(entry.topic, entry.pi);
    return { top: [], omega: [], sK1: null, shares, ownShare: 0, thin: true };
  });
  if (labelOnly) {
    notes.push(
      input.labelShares !== undefined
        ? "no literature evidence: label-only shares (the margin-weighted 5 topics nearest each need)"
        : "no literature evidence and no label-only shares: no candidate could be formed",
    );
  }

  // ---- Step 7: candidates (topics in id order, then the anchors in need order)
  const used = [...new Set(evidence.flatMap((entry) => entry.top))].sort((a, b) => a - b);
  const support = new Map<string, number>();
  if (!labelOnly) {
    for (const index of used) {
      for (const place of papers[index]!.placement) {
        if (place.pi > 0) support.set(place.topic, (support.get(place.topic) ?? 0) + 1);
      }
    }
  } else {
    for (const entry of evidence) for (const topic of entry.shares.keys()) support.set(topic, 0);
  }
  const unknownTopics: string[] = [];
  const candidates: Candidate[] = [];
  for (const topic of [...support.keys()].sort(compareText)) {
    const n = support.get(topic)!;
    if (!labelOnly && n < params.minSupport) continue;
    const position = hierarchy.topic(topic);
    if (position === undefined) {
      unknownTopics.push(topic);
      continue;
    }
    const P = evidence.map((entry) => entry.shares.get(topic) ?? 0);
    const a = P.map((share) => params.maxAffinity * Math.min(1, share / params.saturationShare));
    let M = 0;
    for (let f = 0; f < needs.length; f += 1) M += weights[f]! * P[f]!;
    candidates.push({
      cand: topic,
      kind: "topic",
      name: position.name,
      subfield: position.subfield.id,
      subfieldName: position.subfield.name,
      field: position.field.id,
      fieldName: position.field.name,
      support: n,
      a,
      P,
      M,
    });
  }
  if (unknownTopics.length > 0) {
    notes.push(`${unknownTopics.length} placed topic(s) are not in the taxonomy and were not seated: ${unknownTopics.slice(0, 10).join(", ")}`);
  }
  const anchorFor = (f: number): Candidate | undefined => {
    const subShares = new Map<string, number>();
    for (const [topic, share] of evidence[f]!.shares) {
      const position = hierarchy.topic(topic);
      if (position === undefined) continue;
      subShares.set(position.subfield.id, (subShares.get(position.subfield.id) ?? 0) + share);
    }
    if (subShares.size === 0) return undefined;
    let best: string | undefined;
    for (const id of [...subShares.keys()].sort(compareText)) {
      if (best === undefined || subShares.get(id)! > subShares.get(best)!) best = id;
    }
    const sub = hierarchy.subfield(best!);
    if (sub === undefined) return undefined;
    const need = needs[f]!;
    return {
      cand: `anchor:${need.id}`,
      kind: "anchor",
      name: need.name,
      subfield: sub.id,
      subfieldName: sub.name,
      field: sub.field.id,
      fieldName: sub.field.name,
      support: 0,
      a: needs.map((_, g) => (g === f ? params.anchorAffinity : 0)),
      P: [],
      M: need.weight * subShares.get(best!)!,
      anchorNeed: need.id,
    };
  };
  const topicCount = candidates.length;
  if (params.anchors) {
    needs.forEach((need, f) => {
      if (need.kind !== "facet" || need.weight < params.criticalWeight) return;
      const covered = candidates.slice(0, topicCount).some((candidate) => candidate.a[f]! >= params.anchorThreshold);
      if (covered) return;
      const anchor = anchorFor(f);
      if (anchor !== undefined) candidates.push(anchor);
    });
  }

  // ---- Step 8: selection
  const caps = {
    kMax: params.panelSize,
    subfieldCap: params.seatsPerSubfield,
    fieldCap: params.seatsPerField > 0 ? params.seatsPerField : Math.ceil(params.panelSize / 2),
  };
  const first = lazyGreedy(candidates, needs, caps);
  let order = [...first.order];
  let picks: Array<GreedyPick & { readonly rescued?: true }> = [...first.picks];
  let dropped = [...first.dropped];
  const filled: string[] = [];
  if (order.length < 2) {
    const byMass = candidates.map((_, index) => index).sort((x, y) => tieCompare(candidates[x]!, candidates[y]!));
    for (const index of byMass) {
      if (order.includes(index)) continue;
      order.push(index);
      filled.push(candidates[index]!.cand);
      if (order.length >= 2) break;
    }
  }
  if (filled.length > 0) notes.push(`fewer than 2 seats had a positive gain; filled by evidence mass: ${filled.join(", ")}`);

  // ---- Step 9: size, then the rescue of critical facets still uncovered at k*
  const epsW = params.gainStop * W;
  let k0 = kStarOf(picks.map((pick) => pick.gain), epsW);
  if (order.length > 0) k0 = Math.min(k0, order.length);
  const rescued: string[] = [];
  if (params.rescueUncoveredNeeds && order.length > 0) {
    const atKStar = coverageOf(candidates, order.slice(0, k0), needs.length);
    const fresh: number[] = [];
    needs.forEach((need, f) => {
      if (need.weight < params.criticalWeight || atKStar[f]! >= params.anchorThreshold) return;
      if (need.kind !== "facet") return;
      if (k0 + fresh.length >= params.panelSize) return;
      let index = candidates.findIndex((candidate) => candidate.cand === `anchor:${need.id}`);
      if (index < 0) {
        const anchor = anchorFor(f);
        if (anchor === undefined) return;
        candidates.push(anchor);
        index = candidates.length - 1;
      }
      if (order.slice(0, k0).includes(index)) return;
      fresh.push(index);
    });
    if (fresh.length > 0) {
      const head = order.slice(0, k0);
      let cov = coverageOf(candidates, head, needs.length);
      const added: Array<GreedyPick & { readonly rescued: true }> = [];
      for (const index of fresh) {
        const candidate = candidates[index]!;
        const contrib: Array<readonly [number, number]> = [];
        for (let f = 0; f < needs.length; f += 1) {
          if (candidate.a[f]! > 0) contrib.push([needs[f]!.id, weights[f]! * candidate.a[f]! * (1 - cov[f]!)]);
        }
        let gain = 0;
        for (const [, value] of contrib) gain += value;
        cov = cov.map((value, f) => 1 - (1 - value) * (1 - candidate.a[f]!));
        let F = 0;
        for (let f = 0; f < needs.length; f += 1) F += weights[f]! * cov[f]!;
        added.push({ k: head.length + added.length + 1, index, gain, F, coverage: [...cov], contrib, rescued: true });
      }
      const tail = lazyGreedy(candidates, needs, { ...caps, start: [...head, ...fresh] });
      order = [...head, ...fresh, ...tail.order.slice(head.length + fresh.length)];
      picks = [...picks.slice(0, k0), ...added, ...tail.picks];
      dropped = [...dropped.filter((entry) => entry.atK <= k0), ...tail.dropped];
      rescued.push(...fresh.map((index) => candidates[index]!.cand));
    }
  }
  const kStar = k0 + rescued.length;
  const critical = needs.map((need) => need.weight >= params.criticalWeight);
  const kCovPick = picks.find((pick) => pick.coverage.every((value, f) => !critical[f] || value >= params.criticalCoverage));
  const kCov = kCovPick !== undefined ? kCovPick.k : null;

  // ---- Step 10: seats
  const omegaOf = evidence.map((entry) => new Map(entry.top.map((index, k) => [index, entry.omega[k]!])));
  const seats = order.map((index, position) => {
    const candidate = candidates[index]!;
    const k = position + 1;
    let exemplars: Array<{ pid: string; score: number }> = [];
    if (candidate.kind === "topic") {
      const scored: Array<{ score: number; pid: string }> = [];
      for (const paperIndex of used) {
        const pi = papers[paperIndex]!.placement.find((place) => place.topic === candidate.cand)?.pi ?? 0;
        if (pi <= 0) continue;
        let score = 0;
        for (let f = 0; f < needs.length; f += 1) score += weights[f]! * (omegaOf[f]!.get(paperIndex) ?? 0) * pi;
        if (score > 0) scored.push({ score, pid: papers[paperIndex]!.pid });
      }
      scored.sort((x, y) => (x.score !== y.score ? y.score - x.score : compareText(x.pid, y.pid)));
      exemplars = scored.slice(0, EXEMPLARS).map((entry) => ({ pid: entry.pid, score: round6(entry.score) }));
    }
    return {
      id: `member-${k}`,
      department: candidate.fieldName,
      umbrella: candidate.subfieldName,
      subfields: [candidate.name],
      kind: candidate.kind,
      cand: candidate.cand,
      covers: needs.filter((_, f) => candidate.a[f]! >= COVERS_MIN_AFFINITY).map((need) => need.name),
      exemplars,
      inKStar: k <= kStar,
    };
  });

  // ---- Step 11: flags
  const mass = new Map<number, number>();
  evidence.forEach((entry, f) => {
    entry.top.forEach((index, k) => mass.set(index, (mass.get(index) ?? 0) + weights[f]! * entry.omega[k]!));
  });
  let totalMass = 0;
  for (const value of mass.values()) totalMass += value;
  if (totalMass === 0) totalMass = 1;
  const share = new Map<string, number>();
  for (const [index, value] of mass) {
    const sources = papers[index]!.sources;
    for (const source of sources) share.set(source, (share.get(source) ?? 0) + value / sources.length / totalMass);
  }
  const shareSources = [...share.keys()].sort(compareText);
  const flags = {
    sourceShare: Object.fromEntries(shareSources.map((source) => [source, round6(share.get(source)!)])),
    sourceAlarm: shareSources.filter((source) => share.get(source)! > params.shareAlarm),
    thinNeeds: needs.filter((_, f) => evidence[f]!.thin).map((need) => need.name),
    anchoredSeats: seats.filter((seat) => seat.kind === "anchor").map((seat) => seat.id),
    failedSources: [...input.failedSources],
    screenedOut: input.screenedOut,
    weakPlacements: papers.filter((paper) => paper.weak).length,
    ...(notes.length > 0 ? { notes } : {}),
  };

  const trace = picks.map((pick) => ({
    k: pick.k,
    cand: candidates[pick.index]!.cand,
    gain: round6(pick.gain),
    F: round6(pick.F),
    Fnorm: round6(W > 0 ? pick.F / W : 0),
    coverage: pick.coverage.map(round6),
    ...(pick.runnerUp !== undefined
      ? { runnerUp: candidates[pick.runnerUp]!.cand, runnerUpGain: round6(pick.runnerUpGain!) }
      : {}),
    contrib: Object.fromEntries(pick.contrib.map(([need, value]) => [String(need), round6(value)])),
  }));
  const roundedShares = Object.fromEntries(
    evidence.map((entry, f) => [
      String(needs[f]!.id),
      Object.fromEntries([...entry.shares.keys()].sort(compareText).map((topic) => [topic, round6(entry.shares.get(topic)!)])),
    ]),
  );
  const determinismSha256 = createHash("sha256")
    .update(
      pythonCanonicalJson(
        {
          trace: trace as unknown as JsonValue,
          seats: seats.map((seat) => seat.cand),
          shares: roundedShares as unknown as JsonValue,
        },
        new Set(["k"]),
      ),
      "utf8",
    )
    .digest("hex");

  return {
    version: 1,
    params: { ...params },
    evidence: evidence.map((entry, f) => ({
      need: needs[f]!.id,
      ownShare: round6(entry.ownShare),
      thin: entry.thin,
      sK1: entry.sK1 === null ? null : round6(entry.sK1),
      papers: entry.top.map((index, k) => ({
        pid: papers[index]!.pid,
        sim: round6(papers[index]!.needSims[f] ?? 0),
        omega: round6(entry.omega[k]!),
      })),
      topTopics: [...entry.shares]
        .sort((x, y) => (x[1] !== y[1] ? y[1] - x[1] : compareText(x[0], y[0])))
        .slice(0, TOP_TOPICS)
        .map(([topic, P]) => ({ topic, P: round6(P) })),
    })),
    candidates: candidates.map((candidate) => ({
      cand: candidate.cand,
      kind: candidate.kind,
      name: candidate.name,
      subfield: candidate.subfield,
      field: candidate.field,
      support: candidate.support,
      a: candidate.a.map(round6),
      P: candidate.P.map(round6),
      M: round6(candidate.M),
      ...(candidate.anchorNeed !== undefined ? { anchorNeed: candidate.anchorNeed } : {}),
    })),
    greedy: {
      trace,
      droppedByCap: dropped.map((entry) => ({
        cand: candidates[entry.index]!.cand,
        why: entry.why,
        atK: entry.atK,
        gain: round6(entry.gain),
      })),
      rescued,
      kStar,
      kCov,
      epsW: round6(epsW),
    },
    seats,
    flags,
    determinismSha256,
  } as unknown as JsonObject;
}

/* ------------------------------------------------------------------------ */
/* panel.seat                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The first k seats of the evidence record's greedy order as the existing
 * panel artifact: k = kStar in auto mode, panelSize in fixed mode, never more
 * than the seats listed (nor panelSize), never fewer than 2. A seat whose
 * (department, umbrella, subfields) repeats an earlier one is skipped and the
 * next seat in order takes its place.
 */
export function seatPanel(evidence: JsonObject, panelSize: number, panelSizeMode: string): JsonObject {
  const seats = asArray(evidence.seats).map(asRecord);
  const greedy = asRecord(evidence.greedy);
  const kStar = typeof greedy.kStar === "number" ? greedy.kStar : 2;
  let k = panelSizeMode === "fixed" ? panelSize : kStar;
  k = Math.min(k, seats.length, Math.max(2, panelSize));
  k = Math.max(k, 2);
  const members: JsonObject[] = [];
  const seen = new Set<string>();
  for (const seat of seats) {
    if (members.length >= k) break;
    const subfields = asArray(seat.subfields).map(String);
    const key = `${String(seat.department)}\u0000${String(seat.umbrella)}\u0000${subfields.join("\u0001")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({
      id: String(seat.id),
      department: String(seat.department),
      umbrella: String(seat.umbrella),
      subfields,
    });
  }
  return { members };
}
