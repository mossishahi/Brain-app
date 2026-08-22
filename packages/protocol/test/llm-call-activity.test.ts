import assert from "node:assert/strict";
import test from "node:test";

import type { StageActivityEntry, StageActivityKind } from "../src/index.js";

test("an activity row written before this change is still a StageActivityEntry", () => {
  // The additive rule, stated as a type: every field the new kind brings is
  // optional, so a row recorded by an older worker keeps typechecking and
  // keeps rendering exactly as it did.
  const legacy: StageActivityEntry = {
    id: "a1",
    at: 1,
    kind: "model",
    message: "Model reasoning",
  };
  assert.equal(legacy.promptId, undefined);
});

test("an llm_call row carries the id of the prompt file behind it", () => {
  // The one-row-one-file invariant, as far as the protocol can express it:
  // the row never carries the prompt, only the address a reader fetches it by.
  const kind: StageActivityKind = "llm_call";
  const row: StageActivityEntry = {
    id: "a2",
    at: 2,
    kind,
    message: "Sent the prompt to the model",
    promptId: "p-0001",
  };
  assert.equal(row.kind, "llm_call");
  assert.equal(row.promptId, "p-0001");
});
