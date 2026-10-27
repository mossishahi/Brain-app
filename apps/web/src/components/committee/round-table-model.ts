import type {
  FirstPassMemberView,
  ReviewMemberView,
  Verdict,
} from "@brainstorm-agentic/protocol";
import { gameAdmission } from "../panels/game-review-model.js";

export type CommitteeStatus = "pending" | "thinking" | "paused" | "completed" | "failed" | "reviewing" | "dismissed";
export type CommitteeStepStatus = "pending" | "thinking" | "ready" | "under-review" | "passed" | "force-passed" | "unresolved" | "dismissed";

export interface CommitteeStep {
  readonly index: number;
  readonly status: CommitteeStepStatus;
  readonly reviewable: boolean;
}

export interface CommitteeMember {
  readonly id: string;
  readonly label: string;
  readonly expertise: string;
  readonly expertiseLines: readonly [string, string, string];
  readonly status: CommitteeStatus;
  readonly steps: readonly CommitteeStep[];
  readonly stepCountKnown: boolean;
}

export interface CommitteeEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly stepIndex: number;
  readonly verdict: Verdict | "Reported" | "Admitted" | "Rejected";
  /** Distinct recorded comments with this source, target, step, and verdict. */
  readonly count: number;
}

export interface Committee {
  readonly members: readonly CommitteeMember[];
  readonly edges: readonly CommitteeEdge[];
  /** Comment targets whose reviewer or target could not be represented truthfully. */
  readonly omittedContributions: number;
}

function validCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function memberStatus(first: FirstPassMemberView | undefined, review: ReviewMemberView | undefined): CommitteeStatus {
  if (first?.dismissed || review?.dismissed) return "dismissed";
  if (review?.error !== undefined) return "failed";
  if (review?.progress) return "reviewing";
  if (review?.steps.length && review.steps.every((step) => step.outcome === "passed" || step.outcome === "force-passed" || step.outcome === "unresolved")) return "completed";
  if (review && first?.status === "completed") return "pending";
  return first?.status ?? "pending";
}

/**
 * Thinking-step counts come from recorded chains or this run's pinned cotSteps
 * parameter. Review maxRounds is deliberately absent: it is a different budget.
 */
export function buildCommittee(
  firstPass: readonly FirstPassMemberView[],
  review?: readonly ReviewMemberView[],
  plannedStepCount?: number,
): Committee {
  const firstById = new Map(firstPass.map((member) => [member.memberId, member]));
  const reviewById = new Map(review?.map((member) => [member.memberId, member]) ?? []);
  const ids = [...new Set([...firstById.keys(), ...reviewById.keys()])];
  const members: CommitteeMember[] = ids.map((id, memberIndex) => {
    const first = firstById.get(id);
    const reviewed = reviewById.get(id);
    const stepsByIndex = new Map(reviewed?.steps.map((step) => [step.index, step]) ?? []);
    const recordedIndices = [...stepsByIndex.keys()].filter((index) => Number.isSafeInteger(index) && index > 0);
    const recordedCount = reviewed?.finalIdea?.cot.length ?? first?.idea?.cot.length;
    const reviewCount = recordedIndices.length ? Math.max(...recordedIndices) : undefined;
    const knownCounts = [recordedCount, reviewCount, reviewed?.progress?.stepCount].filter(validCount);
    // Once a chain exists, its actual length supersedes the requested count.
    const count = knownCounts.length ? Math.max(...knownCounts) : validCount(plannedStepCount) ? plannedStepCount : 0;
    const status = memberStatus(first, reviewed);
    const steps: CommitteeStep[] = Array.from({ length: count }, (_, index) => {
      const stepIndex = index + 1;
      const step = stepsByIndex.get(stepIndex);
      const settled = step?.outcome === "passed" || step?.outcome === "force-passed" || step?.outcome === "unresolved";
      return {
        index: stepIndex,
        status: status === "dismissed" && !settled
          ? "dismissed"
          : step?.outcome ?? ((recordedCount ?? 0) >= stepIndex ? "ready" : "pending"),
        reviewable: step !== undefined && (step.rounds.length > 0 || step.outcome === "under-review"),
      };
    });
    const department = reviewed?.department || first?.department;
    const umbrella = reviewed?.umbrella || first?.umbrella;
    return {
      id,
      // First-pass labels are often long specialty names. The compact seat
      // label follows roster order; review already supplies its canonical one.
      label: reviewed?.label ?? `Seat ${memberIndex + 1}`,
      expertise: [[department, umbrella].filter(Boolean).join(" / "), ...(first?.subfields ?? [])].filter(Boolean).join(" · ") || first?.label || "",
      expertiseLines: [department || "Expertise", umbrella || first?.label || "Not recorded", (first?.subfields ?? []).join(" · ")],
      status,
      steps,
      stepCountKnown: knownCounts.length > 0 || validCount(plannedStepCount),
    };
  });

  const byId = new Map(members.map((member) => [member.id, member]));
  const edges = new Map<string, CommitteeEdge>();
  let omittedContributions = 0;
  for (const target of review ?? []) {
    const member = byId.get(target.memberId);
    const validTargets = new Set(member?.steps.map((step) => step.index) ?? []);
    for (const step of target.steps) {
      for (const round of step.rounds) {
        for (const report of round.gameCritiques ?? []) {
          if (!byId.has(report.criticId) || report.criticId === target.memberId || !validTargets.has(step.index)) {
            omittedContributions++;
            continue;
          }
          const admission = gameAdmission(round, report.criticId);
          const verdict = admission === undefined ? "Reported" : admission.admissible ? "Admitted" : "Rejected";
          const id = JSON.stringify([report.criticId, target.memberId, step.index, verdict]);
          edges.set(id, { id, sourceId: report.criticId, targetId: target.memberId, stepIndex: step.index, verdict, count: (edges.get(id)?.count ?? 0) + 1 });
        }
        for (const comment of round.comments) {
          // Scalar and part-aware targets coexist in the protocol. Neither is
          // a fallback for the other; repeated parts in one comment count once.
          const targets = new Set<number>([
            ...(comment.step === undefined ? [] : [comment.step]),
            ...(comment.flaws?.map((flaw) => flaw.step) ?? []),
          ]);
          if (targets.size === 0) targets.add(step.index);
          for (const stepIndex of targets) {
            if (!byId.has(comment.commentorId) || comment.commentorId === target.memberId || !validTargets.has(stepIndex)) {
              omittedContributions++;
              continue;
            }
            // JSON keeps arbitrary member ids unambiguous, including colons.
            const id = JSON.stringify([comment.commentorId, target.memberId, stepIndex, comment.verdict]);
            const existing = edges.get(id);
            edges.set(id, {
              id,
              sourceId: comment.commentorId,
              targetId: target.memberId,
              stepIndex,
              verdict: comment.verdict,
              count: (existing?.count ?? 0) + 1,
            });
          }
        }
      }
    }
  }
  return { members, edges: [...edges.values()], omittedContributions };
}

export interface CommitteePoint { readonly x: number; readonly y: number }
export interface CommitteeRect extends CommitteePoint { readonly width: number; readonly height: number }
export interface CommitteeSeatLayout {
  readonly memberId: string;
  /** SVG radians, with the first seat at -π/2 (the top). */
  readonly angle: number;
  /** The rim segment starting at this member's bulb, then its ordered LEDs. */
  readonly arc: { readonly radius: number; readonly startAngle: number; readonly endAngle: number };
  readonly head: CommitteePoint & { readonly radius: number };
  readonly body: CommitteeRect;
  /** Compact character and seat-name hit area; excludes the expertise block. */
  readonly personBounds: CommitteeRect;
  /** Seat name baseline, text-anchor middle. */
  readonly seatLabel: CommitteePoint;
  /** x is the text anchor; y is the block top, with three 18px lines. */
  readonly expertise: CommitteeRect & { readonly anchor: "start" | "end" };
  readonly agentNode: CommitteePoint;
  readonly leds: readonly (CommitteePoint & { readonly index: number })[];
}
export interface CommitteeLayout {
  readonly width: number;
  readonly height: number;
  readonly center: CommitteePoint;
  readonly tableRadius: number;
  /** The table and characters without desktop expertise, in the same coordinates. */
  readonly compactBounds: CommitteeRect;
  readonly seats: readonly CommitteeSeatLayout[];
}

export const COMMITTEE_LED_RADIUS = 8;
export const COMMITTEE_BULB_RADIUS = 13;
const LED_ARC_PITCH = 32;
const BULB_ARC_GAP = 44;
const SECTOR_PADDING = 80;
const RIM_INSET = 24;
const PERSON_RIM_GAP = 12;
const COLLISION_GAP = 18;
const VIEW_PADDING = 16;

function overlaps(a: CommitteeRect, b: CommitteeRect): boolean {
  return a.x < b.x + b.width + COLLISION_GAP && a.x + a.width + COLLISION_GAP > b.x
    && a.y < b.y + b.height + COLLISION_GAP && a.y + a.height + COLLISION_GAP > b.y;
}

function textWidth(text: string): number {
  // A conservative 13px sans-serif estimate avoids DOM measurements and lets
  // geometry remain deterministic when the recorded expertise updates live.
  let width = 0;
  for (const character of text) {
    width += /[ilI.,'` :;]/.test(character) ? 4 : /[MW@%]/.test(character) ? 11 : /[^\x00-\x7f]/.test(character) ? 13 : 7.5;
  }
  return Math.ceil(width + 8);
}

function unionBounds(boxes: readonly CommitteeRect[], padding = 0): CommitteeRect {
  const x = Math.min(...boxes.map((box) => box.x)) - padding;
  const y = Math.min(...boxes.map((box) => box.y)) - padding;
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) + padding - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) + padding - y,
  };
}

function expertiseBounds(expertise: CommitteeSeatLayout["expertise"]): CommitteeRect {
  return { ...expertise, x: expertise.anchor === "end" ? expertise.x - expertise.width : expertise.x };
}

/** Place the actual head/body silhouette 12px from the rim at every angle. */
function personPosition(angle: number, tableRadius: number): CommitteePoint {
  const unit = { x: Math.cos(angle), y: Math.sin(angle) };
  const clearance = (radius: number): number => {
    const person = { x: unit.x * radius, y: unit.y * radius };
    const bodyX = Math.min(person.x + 22, Math.max(person.x - 22, 0));
    const bodyY = Math.min(person.y + 26, Math.max(person.y - 2, 0));
    return Math.min(Math.hypot(person.x, person.y - 18) - 14, Math.hypot(bodyX, bodyY)) - tableRadius;
  };
  let inner = tableRadius;
  let outer = tableRadius + 80;
  for (let iteration = 0; iteration < 28; iteration++) {
    const middle = (inner + outer) / 2;
    if (clearance(middle) < PERSON_RIM_GAP) inner = middle;
    else outer = middle;
  }
  return { x: unit.x * outer, y: unit.y * outer };
}

/**
 * Upright characters sit outside a circular table. Their ordered thinking
 * lights follow its inner rim, clockwise from the bulb directly in front of
 * their seat. A larger first gap distinguishes the bulb from the step lights.
 * The circle grows to the chain length rather than compressing the lights or
 * putting a dense chain into another seat's sector. Tight bounds let the card
 * scale the complete layout without a separate zoom viewport.
 */
export function layoutCommittee(members: readonly CommitteeMember[]): CommitteeLayout {
  const mostSteps = Math.max(0, ...members.map((member) => member.steps.length));
  const requiredSectorLength = Math.max(0, mostSteps - 1) * LED_ARC_PITCH + BULB_ARC_GAP + SECTOR_PADDING;
  let ringRadius = Math.max(156, members.length * requiredSectorLength / (2 * Math.PI));
  let tableRadius = ringRadius + RIM_INSET;
  let seats: CommitteeSeatLayout[] = [];

  const place = (): { seats: CommitteeSeatLayout[]; boxes: { memberId: string; bounds: CommitteeRect }[] } => {
    tableRadius = ringRadius + RIM_INSET;
    const boxes: { memberId: string; bounds: CommitteeRect }[] = [];
    const next = members.map((member, index) => {
      const angle = index * 2 * Math.PI / members.length - Math.PI / 2;
      const person = personPosition(angle, tableRadius);
      const head = { x: person.x, y: person.y - 18, radius: 14 };
      const body = { x: person.x - 22, y: person.y - 2, width: 44, height: 28 };
      const seatLabel = { x: person.x, y: person.y + (Math.sin(angle) > 0.3 ? 48 : -48) };
      const nameWidth = Math.max(48, textWidth(member.label));
      const personBounds = unionBounds([
        { x: person.x - 22, y: person.y - 32, width: 44, height: 58 },
        { x: seatLabel.x - nameWidth / 2, y: seatLabel.y - 13, width: nameWidth, height: 16 },
      ]);
      const anchor = Math.cos(angle) < -0.05 ? "end" as const : "start" as const;
      const expertise = {
        x: person.x + (anchor === "end" ? -36 : 36),
        y: person.y - 27,
        width: Math.max(100, Math.min(340, Math.max(...member.expertiseLines.map(textWidth)))),
        height: 54,
        anchor,
      };
      boxes.push({ memberId: member.id, bounds: personBounds }, { memberId: member.id, bounds: expertiseBounds(expertise) });
      const angularPitch = LED_ARC_PITCH / ringRadius;
      const bulbAngle = angle;
      const firstAngle = bulbAngle + BULB_ARC_GAP / ringRadius;
      const lastAngle = firstAngle + Math.max(0, member.steps.length - 1) * angularPitch;
      const onRing = (position: number, radius = ringRadius): CommitteePoint => ({ x: Math.cos(position) * radius, y: Math.sin(position) * radius });
      return {
        memberId: member.id,
        angle,
        arc: { radius: ringRadius, startAngle: bulbAngle - 16 / ringRadius, endAngle: member.steps.length ? lastAngle + 14 / ringRadius : bulbAngle + 16 / ringRadius },
        head,
        body,
        personBounds,
        seatLabel,
        expertise,
        agentNode: onRing(bulbAngle),
        leds: member.steps.map((step, ledIndex) => ({
          index: step.index,
          ...onRing(firstAngle + ledIndex * angularPitch),
        })),
      };
    });
    return { seats: next, boxes };
  };

  // With finite upright rectangles, increasing the ring always separates
  // distinct people, including their labels in diagonal 3/5-seat layouts.
  for (let attempt = 0; attempt < 80; attempt++) {
    const placed = place();
    seats = placed.seats;
    const collides = placed.boxes.some((box, index) => placed.boxes.slice(index + 1).some((other) => box.memberId !== other.memberId && overlaps(box.bounds, other.bounds)));
    if (!collides) break;
    ringRadius += Math.max(32, ringRadius * 0.12);
  }

  const tableBounds = { x: -tableRadius, y: -tableRadius, width: tableRadius * 2, height: tableRadius * 2 };
  const compact = unionBounds([tableBounds, ...seats.map((seat) => seat.personBounds)], VIEW_PADDING);
  const complete = unionBounds([tableBounds, ...seats.flatMap((seat) => [seat.personBounds, expertiseBounds(seat.expertise)])], VIEW_PADDING);
  const point = (value: CommitteePoint): CommitteePoint => ({ x: value.x - complete.x, y: value.y - complete.y });
  return {
    width: complete.width,
    height: complete.height,
    center: { x: -complete.x, y: -complete.y },
    tableRadius,
    compactBounds: { ...compact, ...point(compact) },
    seats: seats.map((seat) => ({
      ...seat,
      head: { ...seat.head, ...point(seat.head) },
      body: { ...seat.body, ...point(seat.body) },
      personBounds: { ...seat.personBounds, ...point(seat.personBounds) },
      seatLabel: point(seat.seatLabel),
      expertise: { ...seat.expertise, ...point(seat.expertise) },
      agentNode: point(seat.agentNode),
      leds: seat.leds.map((led) => ({ ...led, ...point(led) })),
    })),
  };
}
