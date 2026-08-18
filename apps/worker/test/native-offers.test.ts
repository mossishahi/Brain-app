import assert from "node:assert/strict";
import test from "node:test";

import { nativeOffersFor } from "../src/wiring.js";

/**
 * What the capability broker is allowed to resolve natively for a run.
 *
 * The rule under test exists because of a real failure: a judge mid-review
 * reported that it "could not open the real project files myself". Both
 * agent-SDK adapters declare attachment reads as native (Claude Code's Read and
 * Glob, Cursor's read and glob), a provider offer outranks host tools and
 * ignores enablement, and the executor scopes those same tools to the run's
 * attachment roots. A run without roots therefore resolved attachment-access as
 * AVAILABLE and then denied every real path.
 */
const attachmentOps = (
  offers: readonly { readonly operationId: string }[],
): readonly string[] =>
  offers
    .map((offer) => offer.operationId)
    .filter((id) => id.startsWith("attachment."))
    .sort();

const otherOps = (
  offers: readonly { readonly operationId: string }[],
): readonly string[] =>
  offers
    .map((offer) => offer.operationId)
    .filter((id) => !id.startsWith("attachment."))
    .sort();

test("an agent SDK offers native attachment reads only when the run has roots to read", () => {
  for (const provider of ["claude-agent", "cursor-agent"] as const) {
    assert.deepEqual(
      attachmentOps(nativeOffersFor(provider, true)),
      ["attachment.list", "attachment.read"],
      `${provider} serves attachment reads through its own file tools`,
    );
    assert.deepEqual(
      attachmentOps(nativeOffersFor(provider, false)),
      [],
      `${provider} must withdraw them when there is nothing to read: offering them ` +
        "resolves the capability available and then denies every path",
    );
    // Withdrawing the attachment offers must not disturb the rest: search,
    // fetch and execution do not depend on an attachment store.
    assert.deepEqual(
      otherOps(nativeOffersFor(provider, false)),
      ["code.execute", "web.fetch", "web.search"],
    );
    assert.deepEqual(
      otherOps(nativeOffersFor(provider, true)),
      ["code.execute", "web.fetch", "web.search"],
    );
  }
});

test("the developer API serves attachments host-side, so its offers never change", () => {
  // The Messages API path has no file tools of its own — attachment access is
  // the registered host tools there, which buildRuntime removes when there are
  // no roots. Its native offers are the same either way.
  assert.deepEqual(attachmentOps(nativeOffersFor("anthropic", true)), []);
  assert.deepEqual(
    otherOps(nativeOffersFor("anthropic", false)),
    ["code.execute", "web.fetch", "web.search"],
  );
  assert.deepEqual(
    nativeOffersFor("anthropic", true),
    nativeOffersFor("anthropic", false),
  );
});

test("an offline run offers nothing natively and falls back to the honesty rules", () => {
  assert.deepEqual(nativeOffersFor("offline", true), []);
  assert.deepEqual(nativeOffersFor("offline", false), []);
});
