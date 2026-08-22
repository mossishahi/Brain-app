import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { LIVE_NODE_SKILLS } from "../src/job-manager.js";
import { activityAnnotation } from "../src/stage-mapper.js";

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
