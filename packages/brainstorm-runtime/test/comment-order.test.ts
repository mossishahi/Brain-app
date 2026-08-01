import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "@brainstorm-agentic/core";

import { shuffleKeyOrder } from "../src/index.js";

/** Six comments in panel seating order, as the merged round state carries them. */
const comments: JsonObject = {
  "member-1": { verdict: "Pass", step: 1 },
  "member-2": { verdict: "Build", step: 1 },
  "member-3": { verdict: "Pass", step: 1 },
  "member-4": { verdict: "Interrupt", step: 1 },
  "member-5": { verdict: "Pass", step: 1 },
  "member-6": { verdict: "Pass", step: 1 },
};

const seatingOrder = Object.keys(comments).join(",");

test("shuffleKeyOrder keeps every entry with its value untouched", () => {
  const shuffled = shuffleKeyOrder(comments, "thinker|3|2|member-1|member-2");
  assert.deepEqual(
    [...Object.keys(shuffled)].sort(),
    [...Object.keys(comments)].sort(),
  );
  for (const key of Object.keys(comments)) {
    assert.deepEqual(shuffled[key], comments[key]);
  }
});

test("shuffleKeyOrder is a pure function of the seed", () => {
  const seed = "member-2|4|1|member-1|member-3|member-4";
  assert.deepEqual(
    Object.keys(shuffleKeyOrder(comments, seed)),
    Object.keys(shuffleKeyOrder(comments, seed)),
  );
});

test("shuffleKeyOrder decouples comment order from seating order", () => {
  // Orders produced by distinct review coordinates (member|step|round). The
  // PRNG is deterministic, so once these assertions pass they can never
  // flake: the same seeds always yield the same permutations.
  const orders = ["m|1|1", "m|1|2", "m|2|1", "m|3|4"].map((seed) =>
    Object.keys(shuffleKeyOrder(comments, seed)).join(","),
  );
  assert.ok(new Set(orders).size > 1, "different rounds must see different orders");
  assert.ok(
    orders.some((order) => order !== seatingOrder),
    "at least one round must not read comments in seating order",
  );
});

test("shuffleKeyOrder leaves sub-two-entry records untouched", () => {
  const single: JsonObject = { "member-2": { verdict: "Pass", step: 1 } };
  const empty: JsonObject = {};
  assert.equal(shuffleKeyOrder(single, "any-seed"), single);
  assert.equal(shuffleKeyOrder(empty, "any-seed"), empty);
});
