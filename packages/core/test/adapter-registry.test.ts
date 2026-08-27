import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTHROPIC_ADAPTER,
  CLAUDE_AGENT_ADAPTER,
  CURSOR_AGENT_ADAPTER,
} from "../src/capability/adapter-registry.js";

/**
 * The shipped provider descriptors.
 *
 * There is deliberately no registry object: both consumers (the worker's
 * wiring and the server's readiness check) select a descriptor directly and
 * read only its staticOffers, so a lookup abstraction had no callers and was
 * removed. These tests pin what those consumers actually depend on.
 */

test("the Anthropic adapter offers exactly its one server tool", () => {
  assert.equal(ANTHROPIC_ADAPTER.providerId, "anthropic");
  assert.equal(ANTHROPIC_ADAPTER.kind, "model-loop");
  // Attachment, taxonomy, AND web operations stay host-side on this path by
  // design: the web is host-owned (one unified, logged pipeline), and adding
  // an offer here would silently stop the host tools being offered to the
  // model, because provider-native always wins in the broker.
  assert.deepEqual(
    ANTHROPIC_ADAPTER.staticOffers.map((offer) => offer.operationId).sort(),
    ["code.execute"],
  );
});

test("no adapter offers web.search or web.fetch — the web is host-owned", () => {
  // Restoring a native web offer would silently split the pipeline's search
  // across backends again and route it around the unified search log.
  for (const adapter of [ANTHROPIC_ADAPTER, CLAUDE_AGENT_ADAPTER, CURSOR_AGENT_ADAPTER]) {
    for (const offer of adapter.staticOffers) {
      assert.ok(
        !offer.operationId.startsWith("web."),
        `${adapter.providerId} must not offer ${offer.operationId} natively`,
      );
    }
  }
});

test("the Claude Agent adapter additionally covers file access natively", () => {
  assert.equal(CLAUDE_AGENT_ADAPTER.kind, "agent-executor");
  const operations = CLAUDE_AGENT_ADAPTER.staticOffers.map((offer) => offer.operationId);
  assert.ok(operations.includes("attachment.read"));
  assert.ok(operations.includes("attachment.list"));
});

test("every offer maps an operation id to a provider-specific key", () => {
  // The indirection is the point: content names "web.search" and never the
  // provider's own token, so a bundle stays provider-neutral.
  for (const adapter of [ANTHROPIC_ADAPTER, CLAUDE_AGENT_ADAPTER]) {
    for (const offer of adapter.staticOffers) {
      assert.ok(offer.operationId.includes("."), `${offer.operationId} is a normalized id`);
      assert.ok(offer.nativeKey.length > 0);
    }
  }
});
