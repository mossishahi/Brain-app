/**
 * The confirm-panel gate's coverage view (contract K; spec v2 Step 11) as
 * pure functions over GET /api/jobs/:jobId/panel-evidence: the coverage of
 * the seats the user is about to confirm, the greedy order's next seat, and
 * the custom-seat request that seats it through the existing gate edit path.
 *
 * No React and no DOM here, so `node --test` runs it like the review rules.
 */
import { PANEL_EDIT_LIMITS, type CustomSeatRequest } from "@brainstorm-agentic/protocol";

/** One need of the run (literature.needs order; a[] and coverage[] align to it). */
export interface CoverageNeed {
  readonly index: number;
  readonly id: number;
  readonly kind: string;
  readonly name: string;
  readonly weight: number;
  readonly critical: boolean;
  readonly thin: boolean;
}

export interface CoverageExemplar {
  readonly pid: string;
  readonly score: number;
  readonly title?: string;
  readonly year?: number;
  readonly url?: string;
}

/** One seat of the greedy order (S_1 ⊂ S_2 ⊂ …). */
export interface CoverageSeat {
  readonly order: number;
  readonly id: string;
  readonly department: string;
  readonly umbrella: string;
  readonly subfields: readonly string[];
  readonly kind: string;
  readonly cand: string;
  readonly name?: string;
  readonly a: readonly number[];
  readonly covers: readonly string[];
  readonly exemplars: readonly CoverageExemplar[];
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

/** Response of GET /api/jobs/:jobId/panel-evidence (the server's PanelEvidenceView). */
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
  readonly needs: readonly CoverageNeed[];
  readonly seats: readonly CoverageSeat[];
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

/** a(seat, need), 0 when the seat carries no affinity for it. */
export function affinity(seat: CoverageSeat, needIndex: number): number {
  const value = seat.a[needIndex];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** c_f(S) = 1 − Π_(j∈S) (1 − a(j,f)) for every need (spec v1 Step 8). */
export function coverageOf(seats: readonly CoverageSeat[], needCount: number): number[] {
  const coverage: number[] = [];
  for (let f = 0; f < needCount; f += 1) {
    let miss = 1;
    for (const seat of seats) miss *= 1 - Math.min(1, Math.max(0, affinity(seat, f)));
    coverage.push(1 - miss);
  }
  return coverage;
}

/** F(S) = Σ_f w_f · c_f(S), and F/W. */
export function objective(
  coverage: readonly number[],
  needs: readonly CoverageNeed[],
  W: number,
): { readonly F: number; readonly Fnorm: number } {
  let F = 0;
  for (const need of needs) F += need.weight * (coverage[need.index] ?? 0);
  return { F, Fnorm: W > 0 ? F / W : 0 };
}

/** The critical needs (w >= criticalWeight) still below the k_cov target. */
export function uncoveredCritical(
  view: PanelEvidenceView,
  coverage: readonly number[],
): CoverageNeed[] {
  return view.needs.filter(
    (need) => need.critical && (coverage[need.index] ?? 0) < view.criticalCoverage,
  );
}

/** The custom-seat request a greedy seat becomes (1-3 subfields, as the gate allows). */
export function seatRequest(seat: CoverageSeat): CustomSeatRequest {
  const subfields = seat.subfields
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, PANEL_EDIT_LIMITS.maxSubfields);
  const fallback = (seat.name ?? seat.umbrella).trim();
  return {
    department: seat.department.trim() || seat.umbrella.trim(),
    umbrella: seat.umbrella.trim() || fallback,
    subfields: subfields.length > 0 ? subfields : fallback.length > 0 ? [fallback] : [],
  };
}

function sameRequest(left: CustomSeatRequest, right: CustomSeatRequest): boolean {
  return (
    left.department === right.department &&
    left.umbrella === right.umbrella &&
    left.subfields.length === right.subfields.length &&
    left.subfields.every((entry, index) => entry === right.subfields[index])
  );
}

/** Whether a greedy seat is already among the user's added seats. */
export function seatAdded(seat: CoverageSeat, added: readonly CustomSeatRequest[]): boolean {
  const request = seatRequest(seat);
  return added.some((entry) => sameRequest(entry, request));
}

/**
 * Where each greedy seat stands at the gate: seated and kept, seated but
 * unchecked, added through "add next seat", or not seated.
 */
export type SeatStanding = "kept" | "unchecked" | "added" | "not-seated";

export function seatStanding(
  seat: CoverageSeat,
  panelIds: ReadonlySet<string>,
  checked: ReadonlySet<string>,
  added: readonly CustomSeatRequest[],
): SeatStanding {
  if (panelIds.has(seat.id)) return checked.has(seat.id) ? "kept" : "unchecked";
  return seatAdded(seat, added) ? "added" : "not-seated";
}

/** The seats whose coverage the confirmed panel would carry. */
export function activeSeats(
  view: PanelEvidenceView,
  panelIds: ReadonlySet<string>,
  checked: ReadonlySet<string>,
  added: readonly CustomSeatRequest[],
): CoverageSeat[] {
  return view.seats.filter((seat) => {
    const standing = seatStanding(seat, panelIds, checked, added);
    return standing === "kept" || standing === "added";
  });
}

/**
 * The next seat of the greedy order: the first seat neither on the proposed
 * panel nor already added. Undefined when the order is exhausted.
 */
export function nextGreedySeat(
  view: PanelEvidenceView,
  panelIds: ReadonlySet<string>,
  added: readonly CustomSeatRequest[],
): CoverageSeat | undefined {
  return view.seats.find((seat) => !panelIds.has(seat.id) && !seatAdded(seat, added));
}

/** One point of the coverage curve, placed in a width x height box. */
export interface CurvePoint {
  readonly k: number;
  readonly x: number;
  readonly y: number;
  readonly gainHeight: number;
  readonly Fnorm: number;
  readonly gain: number;
}

/** The curve's geometry: F/W on [0,1] and the gains scaled to the largest gain. */
export function curveGeometry(
  curve: readonly CoverageCurvePoint[],
  width: number,
  height: number,
): CurvePoint[] {
  if (curve.length === 0) return [];
  const maxK = Math.max(...curve.map((point) => point.k), 1);
  const maxGain = Math.max(...curve.map((point) => point.gain), 0);
  return curve.map((point) => ({
    k: point.k,
    x: maxK <= 1 ? width / 2 : ((point.k - 1) / (maxK - 1)) * width,
    y: height - Math.min(1, Math.max(0, point.Fnorm)) * height,
    gainHeight: maxGain > 0 ? (Math.max(0, point.gain) / maxGain) * height : 0,
    Fnorm: point.Fnorm,
    gain: point.gain,
  }));
}

/** A value as the matrix prints it: two decimals, "–" for zero. */
export function cellText(value: number): string {
  return value > 0.0005 ? value.toFixed(2) : "–";
}
