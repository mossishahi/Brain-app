import assert from "node:assert/strict";
import test from "node:test";

import {
  PANEL_EDIT_LIMITS,
  panelGateDecision,
  panelGateRequest,
  type CustomSeatRequest,
} from "../src/index.js";

const seats = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}` }));
const all = (count: number) => new Set(seats(count).map((seat) => seat.id));
const custom = (count: number): CustomSeatRequest[] =>
  Array.from({ length: count }, (_, index) => ({
    department: "Physics",
    umbrella: "Optics",
    subfields: [`sub${index}`],
  }));

test("an untouched panel approves, and sends no member list", () => {
  const decision = panelGateDecision({
    proposed: seats(6),
    checked: all(6),
    added: [],
  });
  assert.equal(decision.shrinking, false);
  assert.equal(decision.total, 6);
  assert.equal(decision.label, "Approve panel");

  const request = panelGateRequest("gate-1", decision, []);
  assert.equal(request.action, "approve");
  // An approve that also carried a member list would let a stale selection
  // silently override the panel the user actually approved.
  assert.equal(request.members, undefined);
  assert.equal(request.addedMembers, undefined);
});

test("unchecking a seat turns the same action into a shrink carrying the kept ids", () => {
  // The regression this guards: an always-enabled "approve" discarded the
  // selection, so seats stayed unchecked on screen while the full panel ran.
  const proposed = seats(6);
  const checked = new Set(["m1", "m2", "m4", "m5", "m6"]);
  const decision = panelGateDecision({ proposed, checked, added: [] });

  assert.equal(decision.shrinking, true);
  assert.deepEqual(decision.kept, ["m1", "m2", "m4", "m5", "m6"]);
  assert.equal(decision.label, "Continue with 5 of 6 seats");

  const request = panelGateRequest("gate-1", decision, []);
  assert.equal(request.action, "shrink");
  assert.deepEqual(request.members, ["m1", "m2", "m4", "m5", "m6"]);
});

test("kept ids keep the proposed order, not the click order", () => {
  // The server seats the panel in the order it receives, so a set built from
  // clicks must not be allowed to reorder the panel as a side effect.
  const decision = panelGateDecision({
    proposed: seats(4),
    checked: new Set(["m3", "m1"]),
    added: [],
  });
  assert.deepEqual(decision.kept, ["m1", "m3"]);
});

test("a panel below the minimum cannot be answered", () => {
  const decision = panelGateDecision({
    proposed: seats(4),
    checked: new Set(["m1"]),
    added: [],
  });
  assert.equal(decision.total, 1);
  assert.equal(decision.tooFew, true, `below ${PANEL_EDIT_LIMITS.minMembers} must block the gate`);
});

test("custom seats count toward both the minimum and the maximum", () => {
  // Added seats are not decoration: a panel stripped to one seat is legal again
  // once a custom seat joins it, and a full panel must not accept more.
  const rescued = panelGateDecision({
    proposed: seats(4),
    checked: new Set(["m1"]),
    added: custom(1),
  });
  assert.equal(rescued.total, 2);
  assert.equal(rescued.tooFew, false);
  assert.equal(rescued.shrinking, true, "keeping 1 of 4 is still a shrink");
  assert.equal(rescued.label, "Continue with 1 of 4 seats + 1 custom");

  const request = panelGateRequest("gate-1", rescued, custom(1));
  assert.equal(request.action, "shrink");
  assert.equal(request.addedMembers?.length, 1);

  const maxed = panelGateDecision({
    proposed: seats(PANEL_EDIT_LIMITS.maxMembers - 1),
    checked: all(PANEL_EDIT_LIMITS.maxMembers - 1),
    added: custom(1),
  });
  assert.equal(maxed.full, true, "kept + added reaching the cap must close the add affordance");
});

test("an empty proposal is not treated as a shrink", () => {
  // Nothing was removed, so the answer must not claim seats were dropped —
  // `kept.length < proposed.length` alone would be false here anyway, but the
  // guard is what makes that explicit rather than accidental.
  const decision = panelGateDecision({ proposed: [], checked: new Set(), added: custom(3) });
  assert.equal(decision.shrinking, false);
  assert.equal(decision.total, 3);
  assert.equal(decision.label, "Approve panel + 3 custom");
});
