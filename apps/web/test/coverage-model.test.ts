import assert from "node:assert/strict";
import test from "node:test";

import {
  activeSeats,
  cellText,
  coverageOf,
  curveGeometry,
  nextGreedySeat,
  objective,
  seatRequest,
  seatStanding,
  uncoveredCritical,
  type CoverageSeat,
  type PanelEvidenceView,
} from "../src/components/panels/coverage-model.js";

function seat(order: number, a: number[], subfields: string[] = [`Topic ${order}`]): CoverageSeat {
  return {
    order,
    id: `member-${order}`,
    department: "Computer Science",
    umbrella: `Area ${order}`,
    subfields,
    kind: "topic",
    cand: `T${order}`,
    a,
    covers: [],
    exemplars: [],
    inKStar: order <= 2,
    rescued: false,
  };
}

const view: PanelEvidenceView = {
  version: 1,
  W: 2.25,
  kStar: 2,
  kCov: null,
  epsW: 0.1125,
  criticalWeight: 0.5,
  criticalCoverage: 0.75,
  needs: [
    { index: 0, id: 0, kind: "core", name: "core", weight: 1, critical: true, thin: false },
    { index: 1, id: 1, kind: "facet", name: "message passing", weight: 0.95, critical: true, thin: false },
    { index: 2, id: 2, kind: "facet", name: "random graphs", weight: 0.3, critical: false, thin: true },
  ],
  seats: [seat(1, [0.8, 0.6, 0]), seat(2, [0.2, 0.1, 0.7]), seat(3, [0, 0, 0.6]), seat(4, [0.1, 0.5, 0])],
  curve: [
    { k: 1, cand: "T1", gain: 1.29, F: 1.29, Fnorm: 0.573333, coverage: [] },
    { k: 2, cand: "T2", gain: 0.405, F: 1.695, Fnorm: 0.753333, coverage: [] },
    { k: 3, cand: "T3", gain: 0.09, F: 1.785, Fnorm: 0.793333, coverage: [] },
  ],
  droppedByCap: [],
  rescued: [],
  flags: {
    sourceShare: {},
    sourceAlarm: [],
    thinNeeds: [],
    anchoredSeats: [],
    failedSources: [],
    screenedOut: 0,
    weakPlacements: 0,
    budgetExhausted: false,
    hubs: [],
    notes: [],
    sources: [],
  },
};

test("coverage is 1 − Π(1 − a) over the seats, and F/W follows the needs' weights", () => {
  const coverage = coverageOf(view.seats.slice(0, 2), 3);
  assert.deepEqual(coverage.map((value) => Number(value.toFixed(6))), [0.84, 0.64, 0.7]);
  const { F, Fnorm } = objective(coverage, view.needs, view.W);
  assert.equal(Number(F.toFixed(6)), 1.658);
  assert.equal(Number(Fnorm.toFixed(6)), Number((1.658 / 2.25).toFixed(6)));
  assert.deepEqual(coverageOf([], 2), [0, 0]);
  assert.deepEqual(uncoveredCritical(view, coverage).map((need) => need.name), ["message passing"]);
});

test("the next seat comes from the greedy order, skipping seated and already-added seats", () => {
  const panel = new Set(["member-1", "member-2"]);
  assert.equal(nextGreedySeat(view, panel, [])?.id, "member-3");
  const added = [seatRequest(view.seats[2]!)];
  assert.equal(nextGreedySeat(view, panel, added)?.id, "member-4");
  assert.equal(nextGreedySeat(view, new Set(view.seats.map((entry) => entry.id)), []), undefined);
  // The woven seat (not part of the greedy order) does not shift the order.
  assert.equal(nextGreedySeat(view, new Set([...panel, "member-bridge"]), [])?.id, "member-3");
});

test("seat standings drive the matrix and the live coverage column", () => {
  const panel = new Set(["member-1", "member-2"]);
  const checked = new Set(["member-1"]);
  const added = [seatRequest(view.seats[2]!)];
  assert.deepEqual(
    view.seats.map((entry) => seatStanding(entry, panel, checked, added)),
    ["kept", "unchecked", "added", "not-seated"],
  );
  assert.deepEqual(activeSeats(view, panel, checked, added).map((entry) => entry.id), ["member-1", "member-3"]);
});

test("a greedy seat becomes a custom-seat request the gate accepts (1-3 subfields)", () => {
  assert.deepEqual(seatRequest(seat(5, [], ["a", "b", "c", "d"])), {
    department: "Computer Science",
    umbrella: "Area 5",
    subfields: ["a", "b", "c"],
  });
  assert.deepEqual(seatRequest({ ...seat(6, [], []), name: "Belief Propagation" }).subfields, ["Belief Propagation"]);
  assert.deepEqual(seatRequest(seat(7, [], ["  x  ", ""])).subfields, ["x"]);
});

test("the curve geometry spans the box and scales gains to the largest", () => {
  const points = curveGeometry(view.curve, 200, 100);
  assert.deepEqual(points.map((point) => point.x), [0, 100, 200]);
  assert.equal(Number(points[0]!.y.toFixed(3)), Number((100 - 57.3333).toFixed(3)));
  assert.equal(points[0]!.gainHeight, 100);
  assert.equal(Number(points[2]!.gainHeight.toFixed(3)), Number(((0.09 / 1.29) * 100).toFixed(3)));
  assert.deepEqual(curveGeometry([], 10, 10), []);
  assert.equal(curveGeometry([view.curve[0]!], 200, 100)[0]!.x, 100);
  assert.equal(cellText(0), "–");
  assert.equal(cellText(0.456), "0.46");
});
