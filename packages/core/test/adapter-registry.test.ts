import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultAdapterRegistry,
  ProviderAdapterRegistry,
  ANTHROPIC_ADAPTER,
  CLAUDE_AGENT_ADAPTER,
  OFFLINE_ADAPTER,
} from "../src/capability/adapter-registry.js";

describe("ProviderAdapterRegistry", () => {
  it("ships with three built-in adapters", () => {
    const registry = createDefaultAdapterRegistry();
    assert.equal(registry.list().length, 3);
    assert.ok(registry.has("anthropic"));
    assert.ok(registry.has("claude-agent"));
    assert.ok(registry.has("offline"));
  });

  it("retrieves adapters by id", () => {
    const registry = createDefaultAdapterRegistry();
    const anthropic = registry.get("anthropic");
    assert.equal(anthropic?.providerId, "anthropic");
    assert.equal(anthropic?.kind, "model-loop");
    assert.equal(anthropic?.richToolResults, true);
  });

  it("rejects duplicate registrations", () => {
    const registry = createDefaultAdapterRegistry();
    assert.throws(
      () => registry.register(ANTHROPIC_ADAPTER),
      /already registered/,
    );
  });

  it("allows registering new adapters", () => {
    const registry = createDefaultAdapterRegistry();
    registry.register({
      providerId: "openai",
      displayName: "OpenAI API",
      kind: "model-loop",
      staticOffers: [],
      richToolResults: false,
    });
    assert.equal(registry.list().length, 4);
    assert.ok(registry.has("openai"));
  });

  it("returns undefined for unknown adapters", () => {
    const registry = createDefaultAdapterRegistry();
    assert.equal(registry.get("unknown"), undefined);
    assert.ok(!registry.has("unknown"));
  });
});

describe("built-in adapter descriptors", () => {
  it("Anthropic adapter has no static native offers (host tools only)", () => {
    assert.equal(ANTHROPIC_ADAPTER.staticOffers.length, 0);
    assert.equal(ANTHROPIC_ADAPTER.kind, "model-loop");
  });

  it("Claude Agent SDK adapter offers all operations natively", () => {
    assert.ok(CLAUDE_AGENT_ADAPTER.staticOffers.length >= 5);
    const opIds = CLAUDE_AGENT_ADAPTER.staticOffers.map((o) => o.operationId);
    assert.ok(opIds.includes("web.search"));
    assert.ok(opIds.includes("web.fetch"));
    assert.ok(opIds.includes("code.execute"));
    assert.ok(opIds.includes("attachment.list"));
    assert.ok(opIds.includes("attachment.read"));
    assert.equal(CLAUDE_AGENT_ADAPTER.kind, "agent-executor");
  });

  it("Offline adapter offers nothing and does not support rich results", () => {
    assert.equal(OFFLINE_ADAPTER.staticOffers.length, 0);
    assert.equal(OFFLINE_ADAPTER.richToolResults, false);
  });
});

describe("conformance: new provider adapter checklist", () => {
  it("a new adapter must specify providerId, displayName, kind, staticOffers, and richToolResults", () => {
    const newAdapter = {
      providerId: "openrouter",
      displayName: "OpenRouter",
      kind: "model-loop" as const,
      staticOffers: [],
      richToolResults: true,
    };
    const registry = new ProviderAdapterRegistry();
    registry.register(newAdapter);
    const retrieved = registry.get("openrouter")!;
    assert.equal(retrieved.providerId, "openrouter");
    assert.equal(retrieved.displayName, "OpenRouter");
    assert.equal(retrieved.kind, "model-loop");
    assert.equal(retrieved.staticOffers.length, 0);
    assert.equal(retrieved.richToolResults, true);
  });
});
