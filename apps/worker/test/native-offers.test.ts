import assert from "node:assert/strict";
import test from "node:test";

import { nativeOffersFor } from "@brainstorm-agentic/core";

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
      attachmentOps(nativeOffersFor(provider, { attachmentRootsPresent: true })),
      ["attachment.list", "attachment.read"],
      `${provider} serves attachment reads through its own file tools`,
    );
    assert.deepEqual(
      attachmentOps(nativeOffersFor(provider, { attachmentRootsPresent: false })),
      [],
      `${provider} must withdraw them when there is nothing to read: offering them ` +
        "resolves the capability available and then denies every path",
    );
    // Withdrawing the attachment offers must not disturb the rest — and web
    // operations are never offered natively: the web is HOST-OWNED, so
    // web.search/web.fetch resolve to the unified host web tools everywhere.
    assert.deepEqual(
      otherOps(nativeOffersFor(provider, { attachmentRootsPresent: false })),
      ["code.execute"],
    );
    assert.deepEqual(
      otherOps(nativeOffersFor(provider, { attachmentRootsPresent: true })),
      ["code.execute"],
    );
  }
});

test("the developer API serves attachments host-side, so its offers never change", () => {
  // The Messages API path has no file tools of its own — attachment access is
  // the registered host tools there, which buildRuntime removes when there are
  // no roots. Its native offers are the same either way — and carry no web
  // operations, because the web is host-owned on every backend.
  assert.deepEqual(attachmentOps(nativeOffersFor("anthropic", { attachmentRootsPresent: true })), []);
  assert.deepEqual(
    otherOps(nativeOffersFor("anthropic", { attachmentRootsPresent: false })),
    ["code.execute"],
  );
  assert.deepEqual(
    nativeOffersFor("anthropic", { attachmentRootsPresent: true }),
    nativeOffersFor("anthropic", { attachmentRootsPresent: false }),
  );
});

test("an offline run offers nothing natively and falls back to the honesty rules", () => {
  assert.deepEqual(nativeOffersFor("offline", { attachmentRootsPresent: true }), []);
  assert.deepEqual(nativeOffersFor("offline", { attachmentRootsPresent: false }), []);
});
