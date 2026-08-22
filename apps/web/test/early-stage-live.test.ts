import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DECOMPOSE_ROLES,
  PROCESS_INPUT_ROLES,
  applyLiveEntries,
  liveForRoles,
  seatlessLiveByRole,
  type LiveThread,
} from "../src/components/live-threads.js";

const empty: ReadonlyMap<string, LiveThread> = new Map();

const source = (relative: string): string =>
  readFileSync(new URL(`../../src/${relative}`, import.meta.url), "utf8");

/* ------------------------------- the selector the early stages were missing */

test("a task with no seat is addressed by its role", () => {
  // The whole reason these threads used to be dropped: every other selector
  // matches on a seat, and the stages before the panel is seated have none.
  const live = applyLiveEntries(empty, [
    { id: "run/process-input", append: "reading the submission", role: "Processor" },
  ]);
  const byRole = seatlessLiveByRole(live);
  assert.equal(byRole.get("Processor")?.text, "reading the submission");
});

test("a seated task is left to the selectors that own it", () => {
  // A first-pass or review thread already has a card of its own to fill;
  // showing it here as well would put the same work on screen twice.
  const live = applyLiveEntries(empty, [
    { id: "run/first-pass/member[0]", append: "…", role: "Thinker", seatId: "member-1" },
    { id: "run/review/judge", append: "…", role: "Judge", seatId: "member-2" },
  ]);
  assert.equal(seatlessLiveByRole(live).size, 0);
});

test("a thread with no role at all is not shown", () => {
  // The role is the only name these threads can carry; unlabelled words in a
  // panel body cannot be attributed to anyone.
  const live = applyLiveEntries(empty, [{ id: "run/somewhere", append: "…" }]);
  assert.equal(seatlessLiveByRole(live).size, 0);
});

/* ------------------------------------------- what each early stage asks for */

test("a stage's threads come back in the order the stage runs them", () => {
  // These roles run in SEQUENCE, so a reader reads down the panel the same way
  // the run works down it. Arrival order is not that order.
  const live = applyLiveEntries(empty, [
    { id: "b", append: "placing the leftovers", role: "Placer" },
    { id: "a", append: "building the pool", role: "Pool builder" },
  ]);
  assert.deepEqual(
    liveForRoles(seatlessLiveByRole(live), DECOMPOSE_ROLES).map((t) => t.role),
    ["Pool builder", "Placer"],
  );
});

test("each early stage takes only its own roles", () => {
  const live = applyLiveEntries(empty, [
    { id: "a", append: "…", role: "Processor" },
    { id: "b", append: "…", role: "Pool builder" },
  ]);
  const byRole = seatlessLiveByRole(live);
  assert.deepEqual(
    liveForRoles(byRole, PROCESS_INPUT_ROLES).map((t) => t.role),
    ["Processor"],
  );
  assert.deepEqual(
    liveForRoles(byRole, DECOMPOSE_ROLES).map((t) => t.role),
    ["Pool builder"],
  );
});

test("a thread with nothing in it yet renders nothing", () => {
  // An empty labelled box claims a task is silent when it has not started.
  const live = applyLiveEntries(empty, [{ id: "a", append: "   \n", role: "Classifier" }]);
  assert.deepEqual(liveForRoles(seatlessLiveByRole(live), PROCESS_INPUT_ROLES), []);
});

/* --------------------------------- where the two early panels put the words */

for (const panel of ["panels/ProcessInputPanel.tsx", "panels/DecomposePanel.tsx"] as const) {
  test(`${panel} reuses LiveThread rather than styling its own box`, () => {
    const code = source(`components/${panel}`);
    assert.match(
      code,
      /import \{[^}]*\bLiveThread\b[^}]*\} from "\.\.\/common"/,
      `${panel}: the dashed border, the dim monospace, the capped box and the ` +
        `steady reveal are what stop live text being read as a stored chain of ` +
        `thought — a second component would have to carry all four`,
    );
    assert.match(
      code,
      /<LiveThread\s+key=\{thread\.role\}\s+text=\{thread\.text\}\s+label=\{thread\.role\}/,
      `${panel}: the thread must be labelled with its role, the way the review ` +
        `deck labels the judge and each reviewer — these stages run several ` +
        `roles one after another`,
    );
  });
}

test("decompose does not show an empty tree beside the thread standing in for it", () => {
  // The rule: live text occupies the place of the output it is producing. A
  // "no departments" tree next to the words building that tree is the doubling
  // the rule exists to prevent.
  const code = source("components/panels/DecomposePanel.tsx");
  assert.match(code, /stage\.experts \|\| \(!steps && live\.length === 0\)/);
});
