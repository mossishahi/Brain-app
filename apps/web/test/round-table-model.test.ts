import assert from "node:assert/strict";
import test from "node:test";
import type { CommentView, FirstPassMemberView, ReviewMemberView, ReviewStepView } from "@brainstorm-agentic/protocol";
import { buildCommittee, layoutCommittee, COMMITTEE_LED_RADIUS, COMMITTEE_BULB_RADIUS, type CommitteeMember, type CommitteeRect, type CommitteePoint } from "../src/components/committee/round-table-model.js";

function first(id: string, changes: Partial<FirstPassMemberView> = {}): FirstPassMemberView {
  return { memberId: id, label: `Seat ${id}`, department: "Science", umbrella: "Physics", subfields: ["Optics"], status: "thinking", ...changes };
}

function step(index: number, comments: readonly CommentView[] = []): ReviewStepView {
  return { index, outcome: "under-review", rounds: [{ round: 1, comments }] };
}

function review(id: string, steps: readonly ReviewStepView[], changes: Partial<ReviewMemberView> = {}): ReviewMemberView {
  return { memberId: id, label: `Seat ${id}`, steps, ...changes };
}

function comment(changes: Partial<CommentView> = {}): CommentView {
  return { commentorId: "a", commentorLabel: "Seat a", verdict: "Pass", reason: "Recorded contribution", ...changes };
}

test("planned thinking steps have pending lights; completed chains replace the planned count", () => {
  const thinking = buildCommittee([first("a")], undefined, 6).members[0]!;
  assert.equal(thinking.status, "thinking");
  assert.equal(thinking.stepCountKnown, true);
  assert.deepEqual(thinking.steps.map((item) => item.status), Array(6).fill("pending"));
  assert.ok(thinking.steps.every((item) => !item.reviewable));
  const ready = buildCommittee([first("a", { status: "completed", idea: { type: "response", shape: "explanation", cot: ["First", "Second"] } })], undefined, 6).members[0]!;
  assert.equal(ready.status, "completed");
  assert.deepEqual(ready.steps.map((item) => item.status), ["ready", "ready"]);
});

test("unknown chain length remains unknown and review metadata supplies real step lengths", () => {
  const unknown = buildCommittee([first("a")]).members[0]!;
  assert.equal(unknown.stepCountKnown, false);
  assert.deepEqual(unknown.steps, []);
  const known = buildCommittee([], [review("b", [step(2)], { progress: { step: 2, stepCount: 7, round: 99 } })]).members[0]!;
  assert.equal(known.steps.length, 7);
  assert.equal(known.status, "reviewing");
  assert.equal(known.steps[1]?.status, "under-review");
  assert.equal(known.steps[1]?.reviewable, true);
  assert.equal(known.steps[6]?.status, "pending");
});

test("seat identity and expertise survive partial snapshots without merging similar specialties", () => {
  const committee = buildCommittee([first("a"), first("b")], [review("b", [step(1)]), review("c", [])]);
  assert.deepEqual(committee.members.map((member) => member.id), ["a", "b", "c"]);
  assert.equal(committee.members[1]?.expertise, "Science / Physics · Optics");
  assert.deepEqual(committee.members[1]?.expertiseLines, ["Science", "Physics", "Optics"]);
  assert.equal(committee.members[2]?.expertise, "");
});

test("long first-pass labels stay in expertise while compact seat labels follow stable roster order", () => {
  const long = "Natural Language Processing and Computational Linguistics";
  const committee = buildCommittee([
    first("member-one", { label: long, department: "", umbrella: "", subfields: [] }),
    first("member-two", { label: "Statistical and Applied Mathematics" }),
  ]);
  assert.deepEqual(committee.members.map((member) => member.label), ["Seat 1", "Seat 2"]);
  assert.equal(committee.members[0]?.expertise, long);
  assert.deepEqual(committee.members[0]?.expertiseLines, ["Expertise", long, ""]);
  assert.equal(committee.members[1]?.expertise, "Science / Physics · Optics");
  const reviewed = buildCommittee([first("member-one", { label: long })], [review("member-one", [], { label: "Seat 7" })]);
  assert.equal(reviewed.members[0]?.label, "Seat 7");
});

test("dismissal stops active state without erasing already passed steps or review access", () => {
  const member = buildCommittee([first("a")], [review("a", [
    { ...step(1), outcome: "passed" },
    step(2),
    { index: 3, outcome: "pending", rounds: [] },
  ], { dismissed: { at: 123 }, error: "Previous failure", progress: { step: 2, stepCount: 3, round: 1 } })]).members[0]!;
  assert.equal(member.status, "dismissed");
  assert.deepEqual(member.steps.map((item) => item.status), ["passed", "dismissed", "dismissed"]);
  assert.deepEqual(member.steps.map((item) => item.reviewable), [true, true, false]);
});

test("review status prefers failure and active review over old first-pass completion", () => {
  const completed = first("a", { status: "completed" });
  assert.equal(buildCommittee([completed], [review("a", [step(1)], { error: "failed" })]).members[0]?.status, "failed");
  assert.equal(buildCommittee([completed], [review("a", [{ index: 1, outcome: "pending", rounds: [] }])]).members[0]?.status, "pending");
  assert.equal(buildCommittee([completed], [review("a", [{ ...step(1), outcome: "force-passed" }])]).members[0]?.status, "completed");
  assert.equal(buildCommittee([first("a", { status: "paused" })]).members[0]?.status, "paused");
});

test("edges read scalar and part-aware targets together, deduplicate parts, and keep Build distinct", () => {
  const committee = buildCommittee([first("a"), first("b")], [review("b", [step(1), step(2), step(3, [
    comment({ verdict: "Interrupt", step: 1, flaws: [{ step: 2, part1: "one" }, { step: 2, part4: "two" }] }),
    comment({ verdict: "Build", step: 2 }),
    comment({ flaws: [] }),
  ])])]);
  assert.deepEqual(committee.edges.map((edge) => [edge.sourceId, edge.targetId, edge.stepIndex, edge.verdict, edge.count]), [
    ["a", "b", 1, "Interrupt", 1],
    ["a", "b", 2, "Interrupt", 1],
    ["a", "b", 2, "Build", 1],
    ["a", "b", 3, "Pass", 1],
  ]);
});

test("only recorded reviewers and valid targets become edges; invalid targets are not reassigned", () => {
  const committee = buildCommittee([first("a"), first("b")], [review("b", [step(1, [
    comment({ commentorId: "unknown" }),
    comment({ commentorId: "b" }),
    comment({ step: 8 }),
    comment({ step: 0 }),
    comment({ step: 1.5 }),
  ])])]);
  assert.deepEqual(committee.edges, []);
  assert.equal(committee.omittedContributions, 5);
});

test("multiple rounds aggregate comment counts per edge without losing independent verdicts", () => {
  const committee = buildCommittee([first("a"), first("b")], [review("b", [{
    index: 1, outcome: "passed", rounds: [
      { round: 1, comments: [comment({ verdict: "Interrupt" })] },
      { round: 2, comments: [comment()] },
      { round: 3, comments: [comment()] },
    ],
  }])]);
  assert.deepEqual(committee.edges.map((edge) => [edge.verdict, edge.count]), [["Interrupt", 1], ["Pass", 2]]);
});

function layoutMembers(count: number, steps: number): readonly CommitteeMember[] {
  return buildCommittee(Array.from({ length: count }, (_, index) => first(String(index))), undefined, steps).members;
}

function overlaps(a: CommitteeRect, b: CommitteeRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function distance(a: CommitteePoint, b: CommitteePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToRect(point: CommitteePoint, rect: CommitteeRect): number {
  return distance(point, {
    x: Math.min(rect.x + rect.width, Math.max(rect.x, point.x)),
    y: Math.min(rect.y + rect.height, Math.max(rect.y, point.y)),
  });
}

function contains(outer: CommitteeRect, inner: CommitteeRect): boolean {
  return inner.x >= outer.x - 1e-7 && inner.y >= outer.y - 1e-7
    && inner.x + inner.width <= outer.x + outer.width + 1e-7 && inner.y + inner.height <= outer.y + outer.height + 1e-7;
}

function assertSeparatedRimNodes(layout: ReturnType<typeof layoutCommittee>): void {
  const nodes = layout.seats.flatMap((seat) => [
    ...seat.leds.map((led) => ({ ...led, radius: COMMITTEE_LED_RADIUS })),
    { ...seat.agentNode, radius: COMMITTEE_BULB_RADIUS },
  ]).sort((a, b) => Math.atan2(a.y - layout.center.y, a.x - layout.center.x) - Math.atan2(b.y - layout.center.y, b.x - layout.center.x));
  if (nodes.length < 2) return;
  for (const [index, node] of nodes.entries()) {
    const next = nodes[(index + 1) % nodes.length]!;
    assert.ok(distance(node, next) > node.radius + next.radius + 6, "neighboring LED and bulb nodes never overlap across seat boundaries");
  }
}

for (const count of [1, 2, 3, 4, 5, 8, 13, 20]) {
  for (const steps of [0, 1, 7, 32, 256]) {
    test(`${count} seats × ${steps} steps: rim lights stay circular and all shapes remain separated`, () => {
      const layout = layoutCommittee(layoutMembers(count, steps));
      assert.equal(layout.seats.length, count);
      assert.ok(Number.isFinite(layout.width) && layout.width > 0 && layout.width < 100_000);
      const boxes: { memberId: string; bounds: CommitteeRect }[] = [];
      for (const seat of layout.seats) {
        const expertise = { ...seat.expertise, x: seat.expertise.anchor === "end" ? seat.expertise.x - seat.expertise.width : seat.expertise.x };
        boxes.push({ memberId: seat.memberId, bounds: seat.personBounds }, { memberId: seat.memberId, bounds: expertise });
        assert.ok(contains(layout.compactBounds, seat.personBounds));
        assert.ok(distanceToRect(layout.center, expertise) > layout.tableRadius, "expertise remains outside the table");
        const shapeGap = Math.min(distance(layout.center, seat.head) - seat.head.radius, distanceToRect(layout.center, seat.body)) - layout.tableRadius;
        assert.ok(shapeGap >= 11.99 && shapeGap < 12.01, `characters sit close to the rim at every angle: ${shapeGap}`);
        assert.equal(seat.leds.length, steps);
        for (const led of seat.leds) {
          assert.ok(Math.abs(distance(led, layout.center) - seat.arc.radius) < 1e-7);
          assert.ok(distance(led, layout.center) + COMMITTEE_LED_RADIUS < layout.tableRadius);
        }
        assert.ok(Math.abs(distance(seat.agentNode, layout.center) - seat.arc.radius) < 1e-7);
        assert.ok(distance(seat.agentNode, layout.center) + COMMITTEE_BULB_RADIUS < layout.tableRadius);
        const personAnchor = { x: seat.body.x + seat.body.width / 2, y: seat.body.y + 2 };
        const bulbAngle = Math.atan2(seat.agentNode.y - layout.center.y, seat.agentNode.x - layout.center.x);
        const personAngle = Math.atan2(personAnchor.y - layout.center.y, personAnchor.x - layout.center.x);
        assert.ok(Math.abs(Math.sin(personAngle - bulbAngle)) < 1e-8 && Math.cos(personAngle - bulbAngle) > 0, "the bulb sits directly in front of its own person");
        let previousAngle = 0;
        for (const led of seat.leds) {
          const angle = (Math.atan2(led.y - layout.center.y, led.x - layout.center.x) - bulbAngle + Math.PI * 2) % (Math.PI * 2);
          assert.ok(angle > previousAngle, "thinking-step LEDs follow the bulb in strictly clockwise order");
          previousAngle = angle;
        }
      }
      for (let index = 0; index < boxes.length; index++) {
        const box = boxes[index]!;
        assert.ok(contains({ x: 0, y: 0, width: layout.width, height: layout.height }, box.bounds));
        for (const other of boxes.slice(index + 1)) {
          if (box.memberId !== other.memberId) assert.equal(overlaps(box.bounds, other.bounds), false);
        }
      }
      assert.ok(contains({ x: 0, y: 0, width: layout.width, height: layout.height }, layout.compactBounds));
      assert.ok(contains(layout.compactBounds, { x: layout.center.x - layout.tableRadius, y: layout.center.y - layout.tableRadius, width: layout.tableRadius * 2, height: layout.tableRadius * 2 }));
      assertSeparatedRimNodes(layout);
    });
  }
}

test("mixed chain lengths have deterministic layouts and preserve all step identities", () => {
  const members = [1, 8, 65, 3, 256].flatMap((count, index) => buildCommittee([first(String(index))], undefined, count).members);
  const result = layoutCommittee(members);
  assert.deepEqual(layoutCommittee(members), result);
  for (const [index, seat] of result.seats.entries()) {
    assert.deepEqual(seat.leds.map((led) => led.index), members[index]!.steps.map((item) => item.index));
  }
  assertSeparatedRimNodes(result);
  assert.deepEqual(layoutCommittee([]).seats, []);
});

test("the right-hand seat has its bulb directly ahead and an ordered curved LED row alongside", () => {
  const result = layoutCommittee(layoutMembers(4, 7));
  const right = result.seats[1]!;
  assert.ok(right.leds[0]!.y < right.leds[3]!.y && right.leds[3]!.y < right.leds[6]!.y);
  assert.ok(right.leds[0]!.x > right.leds[3]!.x && right.leds[3]!.x > right.leds[6]!.x);
  assert.ok(Math.abs(right.agentNode.y - result.center.y) < 1e-8);
  assert.ok(right.agentNode.y < right.leds[0]!.y);
  assert.ok(distance(right.agentNode, right.leds[0]!) > distance(right.leds[0]!, right.leds[1]!));
});

test("long three-line expertise fits adjacent collision bounds, with a compact view for narrow screens", () => {
  const members = buildCommittee(Array.from({ length: 13 }, (_, index) => first(String(index), {
    department: "Computer Science / Statistical Research",
    umbrella: "Artificial Intelligence and Computational Methods",
    subfields: ["Natural Language Processing", "Complex Reasoning", "Multi-Agent Systems"],
  })), undefined, 9).members;
  const layout = layoutCommittee(members);
  const labels = layout.seats.map((seat) => ({ ...seat.expertise, x: seat.expertise.anchor === "end" ? seat.expertise.x - seat.expertise.width : seat.expertise.x }));
  for (const [index, label] of labels.entries()) {
    assert.equal(label.height, 54);
    assert.equal(label.width, 340);
    for (const other of labels.slice(index + 1)) assert.equal(overlaps(label, other), false);
    for (const seat of layout.seats) assert.equal(overlaps(label, seat.personBounds), false);
  }
  assert.ok(layout.compactBounds.width < layout.width);
  assert.ok(layout.width > layout.height, "desktop uses a wide, tightly bounded canvas");
  assert.ok(layout.width - layout.compactBounds.width < 2 * (340 + 36), "only expertise width adds horizontal space");
});
