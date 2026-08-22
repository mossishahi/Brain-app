import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { LIVE_NODE_SKILLS } from "../src/job-manager.js";
import { activityAnnotation, liveIdentityPanel } from "../src/stage-mapper.js";

/**
 * The role behind a task reaches the page down two separate channels, and they
 * do not share a source.
 *
 * An activity ROW carries its task kind on the event, so it names the SKILL.
 * A live THREAD carries only fragments, so the server rebuilds the kind from
 * the execution path, which names the NODE. Those two vocabularies differ for
 * every agent node in the pipeline, and the table that joins them once covered
 * the review nodes alone. Everything earlier fell through to the node id: the
 * processor's thread arrived labelled "Process-input" while its rows said
 * "Processor", so the stage panels — which look for the row's word — found no
 * thread and rendered nothing for the whole of Process input and Decompose.
 *
 * Nothing failed. Two channels simply disagreed about the same fact, which is
 * why this asserts they agree rather than asserting either one alone.
 */

// Compiled to apps/server/dist/test/, so four levels up is the app repository
// and five is the umbrella that holds app/ and brain/ side by side.
const appRoot = new URL("../../../../", import.meta.url).pathname;
const umbrellaRoot = new URL("../../../../../", import.meta.url).pathname;

/** The bundle version the suite is pinned to, from the app repository root. */
function pinnedBundleVersion(): string {
  const pin = JSON.parse(
    readFileSync(join(appRoot, "test-bundle.json"), "utf8"),
  ) as { readonly version: string };
  return pin.version;
}

/** Every agent node of the pinned workflow, as `{ id, skill }`. */
function agentNodes(): readonly { readonly id: string; readonly skill: string }[] {
  const workflow = JSON.parse(
    readFileSync(
      join(
        umbrellaRoot,
        "brain",
        ".registry-store",
        "bundles",
        "brainstorm",
        pinnedBundleVersion(),
        "workflows",
        "brainstorm.workflow.json",
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;

  const found: { id: string; skill: string }[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (
      record.kind === "agent" &&
      typeof record.id === "string" &&
      typeof record.skill === "string"
    ) {
      found.push({ id: record.id, skill: record.skill });
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(workflow.root);
  return found;
}

test("the live thread and the activity row name the same role for the same node", () => {
  const nodes = agentNodes();
  assert.ok(nodes.length > 0, "the pinned workflow has agent nodes to check");

  for (const { id, skill } of nodes) {
    // The path the worker writes for this node's live fragments, and the one
    // its events carry. Both channels see exactly this string.
    const path = `brainstorm-root/${id}/${id}-execute`;

    // What an activity row shows: the event carries the skill.
    const row = activityAnnotation(path, `brainstorm.${skill}`, []);
    // What a live thread shows: the server rebuilds the kind from the path.
    const thread = activityAnnotation(
      path,
      `brainstorm.${LIVE_NODE_SKILLS[id] ?? id}`,
      [],
    );

    assert.equal(
      thread.role,
      row.role,
      `node "${id}" runs skill "${skill}", so its thread must be labelled ` +
        `"${String(row.role)}" like its rows, not "${String(thread.role)}"`,
    );
  }
});

test("every agent node the pinned bundle ships is one the live channel can name", () => {
  const missing = agentNodes()
    .filter(({ id }) => LIVE_NODE_SKILLS[id] === undefined)
    .map(({ id, skill }) => `${id} (runs ${skill})`);

  assert.deepEqual(
    missing,
    [],
    "a bundle grew an agent node the live-role table does not know; add it to " +
      "LIVE_NODE_SKILLS, or its thread arrives labelled with its node id and " +
      "no stage panel will show it",
  );
});

/* ------------------------------------- the roster identity is stamped against */

/** A minimal detail carrying only the stages the roster selector reads. */
function detailWith(stages: readonly unknown[]): Parameters<typeof liveIdentityPanel>[0] {
  return { stages } as unknown as Parameters<typeof liveIdentityPanel>[0];
}

const firstPassSeat = (id: string, umbrella: string): unknown => ({
  memberId: id,
  label: umbrella,
  department: "Computer Science",
  umbrella,
  subfields: [],
  status: "thinking",
});

test("live identity is stamped against the roster the run executes", () => {
  // Every seated path's member[i] indexes the CONFIRMED panel — the seats
  // kept at the gate plus the custom seats added there — which is exactly the
  // first-pass stage's members. The select-panel stage shows the PROPOSAL,
  // and stamping identity against it put an added seat's words under a seat
  // that was never seated: its card waited forever while its member spoke,
  // and every seat past a removal wore its neighbour's thread.
  const detail = detailWith([
    {
      id: "select-panel",
      // The proposal: three seats, of which the user kept two and added one.
      panel: [
        { id: "member-1", department: "CS", umbrella: "AI", subfields: [] },
        { id: "member-2", department: "CS", umbrella: "Systems", subfields: [] },
        { id: "member-3", department: "Math", umbrella: "Topology", subfields: [] },
      ],
    },
    { id: "confirm-panel", gate: { state: "approved" } },
    {
      id: "first-pass",
      members: [
        firstPassSeat("member-1", "Artificial Intelligence"),
        firstPassSeat("member-3", "Geometry and Topology"),
        firstPassSeat("member-user-1", "Machine Learning"),
      ],
    },
  ]);
  const { panel, final } = liveIdentityPanel(detail);
  assert.deepEqual(
    panel.map((member) => member.id),
    ["member-1", "member-3", "member-user-1"],
    "the confirmed roster in fan-out order, never the proposal",
  );
  assert.equal(final, true, "an answered gate pins the roster for the run");
});

test("a roster is only final once the confirmation gate is answered", () => {
  // Before the answer the members are the proposal riding through — usable
  // for the seatless early stages, but never to be cached past the gate.
  for (const state of ["not-reached", "pending"]) {
    const { final } = liveIdentityPanel(
      detailWith([
        { id: "confirm-panel", gate: { state } },
        { id: "first-pass", members: [firstPassSeat("member-1", "AI")] },
      ]),
    );
    assert.equal(final, false, `a "${state}" gate leaves the roster provisional`);
  }
});
