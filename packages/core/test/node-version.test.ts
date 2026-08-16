import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_NODE_VERSION,
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
} from "../src/index.js";

test("the floor is the Cursor SDK's requirement, matching the deploy scripts", () => {
  // Pinned deliberately: the deploy scripts install v22.13.0 and @cursor/sdk
  // declares >=22.13. Changing the floor means changing all three together.
  assert.equal(MINIMUM_NODE_VERSION, "22.13.0");
});

test("version comparison is numeric per segment, never lexicographic", () => {
  assert.equal(isSupportedNodeVersion("22.13.0"), true);
  assert.equal(isSupportedNodeVersion("22.13.1"), true);
  assert.equal(isSupportedNodeVersion("22.14.0"), true);
  assert.equal(isSupportedNodeVersion("23.0.0"), true);
  assert.equal(isSupportedNodeVersion("100.0.0"), true);
  assert.equal(isSupportedNodeVersion("22.12.9"), false);
  assert.equal(isSupportedNodeVersion("22.9.0"), false);
  assert.equal(isSupportedNodeVersion("20.19.0"), false);
  assert.equal(isSupportedNodeVersion("9.99.99"), false);
});

test("an unsupported Node fails with one clear sentence naming both versions", () => {
  assert.throws(
    () => assertSupportedNodeVersion("20.11.1"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Node\.js 22\.13\.0 or newer/);
      assert.match(error.message, /running Node 20\.11\.1/);
      assert.match(error.message, /Cursor SDK/);
      return true;
    },
  );
});

test("the running process passes its own guard (CI and dev enforce the floor)", () => {
  assertSupportedNodeVersion();
});
