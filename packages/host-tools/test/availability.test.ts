/**
 * deriveEffectiveOrder: the per-purpose order new runs receive, derived
 * from probed tool states (availability spec, Section 4).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveEffectiveOrder, type ToolAvailabilityState } from "../src/index.js";

const states = (entries: Record<string, ToolAvailabilityState | "not-configured">) =>
  new Map(Object.entries(entries));

test("kept, moved and dropped: degraded tools go behind every available one, the rest keep configured order", () => {
  const order = deriveEffectiveOrder(
    ["openalex", "crossref", "semantic-scholar", "arxiv", "brave", "searxng"],
    states({
      openalex: "needs-key",
      crossref: "degraded",
      "semantic-scholar": "available",
      arxiv: "available",
      brave: "unreachable",
      searxng: "blocked",
    }),
    true,
  );
  assert.deepEqual(order.configured, ["openalex", "crossref", "semantic-scholar", "arxiv", "brave", "searxng"]);
  assert.deepEqual(order.effective, ["semantic-scholar", "arxiv", "crossref"]);
  assert.deepEqual(
    order.entries.map((entry) => [entry.id, entry.action]),
    [
      ["openalex", "dropped"],
      ["crossref", "moved"],
      ["semantic-scholar", "kept"],
      ["arxiv", "kept"],
      ["brave", "dropped"],
      ["searxng", "dropped"],
    ],
  );
  for (const entry of order.entries) {
    if (entry.action !== "kept") assert.ok(entry.reason !== undefined && entry.reason.length > 0, `${entry.id} has a reason`);
  }
  assert.match(order.entries[0]!.reason!, /key/);
  assert.match(order.entries[4]!.reason!, /unreachable/);
  assert.match(order.entries[5]!.reason!, /blocked/);
});

test("relative order is preserved among kept tools and among moved tools", () => {
  const order = deriveEffectiveOrder(
    ["a", "b", "c", "d", "e"],
    states({ a: "degraded", b: "available", c: "degraded", d: "available", e: "available" }),
    true,
  );
  assert.deepEqual(order.effective, ["b", "d", "e", "a", "c"]);
});

test("a degraded tool already behind every available one keeps its place and is only flagged", () => {
  const order = deriveEffectiveOrder(["b", "a"], states({ b: "available", a: "degraded" }), true);
  assert.deepEqual(order.effective, ["b", "a"]);
  assert.deepEqual(order.entries[1], {
    id: "a",
    action: "kept",
    reason: "degraded at the last probe (already behind every available tool)",
  });
});

test("with demotion off, degraded tools keep their configured position and carry the flag in their reason", () => {
  const order = deriveEffectiveOrder(
    ["a", "b", "c"],
    states({ a: "degraded", b: "available", c: "unreachable" }),
    false,
  );
  assert.deepEqual(order.effective, ["a", "b"]);
  assert.equal(order.entries[0]!.action, "kept");
  assert.match(order.entries[0]!.reason!, /degraded/);
  assert.equal(order.entries[2]!.action, "dropped");
});

test("disabled and not-configured drop; unchecked and unknown ids are kept in place", () => {
  const order = deriveEffectiveOrder(
    ["x", "searxng:science", "y", "z"],
    states({ x: "disabled", y: "not-configured", z: "unchecked" }),
    true,
  );
  assert.deepEqual(order.effective, ["searxng:science", "z"]);
  assert.deepEqual(
    order.entries.map((entry) => entry.action),
    ["dropped", "kept", "dropped", "kept"],
  );
  assert.equal(order.entries[1]!.reason, "not probed yet");
});

test("an empty configured list derives an empty order; the result never aliases its input", () => {
  const configured: string[] = [];
  const order = deriveEffectiveOrder(configured, new Map(), true);
  assert.deepEqual(order, { configured: [], effective: [], entries: [] });
  const list = ["a"];
  const derived = deriveEffectiveOrder(list, new Map(), true);
  list.push("b");
  assert.deepEqual(derived.configured, ["a"]);
});
