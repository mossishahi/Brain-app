import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilityPlan } from "../src/capability/broker.js";
import { nativeOffersFor } from "../src/capability/adapter-registry.js";
import type { HostToolManifest } from "../src/capability/types.js";

function manifest(toolId: string, operations: readonly string[]): HostToolManifest {
  return {
    toolId,
    displayName: toolId,
    operations,
    risk: "medium",
    defaultEnabled: false,
    definition: { name: toolId, description: toolId, inputSchema: { type: "object" } },
  };
}

const webSearch = {
  capabilityId: "web-search",
  operations: ["web.search", "web.fetch"],
  whenUnavailable: "",
};

const webTools = [
  manifest("web_search", ["web.search"]),
  manifest("web_fetch", ["web.fetch"]),
  manifest("news_search", ["web.search"]),
  manifest("paper_search", ["web.search"]),
  manifest("paper_details", ["web.search"]),
];

describe("one operation, several specialised host tools", () => {
  it("offers every enabled tool that serves the operation, each defined once", () => {
    const plan = resolveCapabilityPlan({
      requiredCapabilities: [webSearch],
      providerOffers: [],
      hostTools: webTools,
      enabledHostToolIds: new Set(["web_search", "web_fetch", "paper_search", "paper_details"]),
    });
    const search = plan.operations.find((operation) => operation.operationId === "web.search")!;
    assert.equal(search.source, "host");
    assert.deepEqual(search.toolNames, ["web_search", "paper_search", "paper_details"]);
    assert.deepEqual(
      plan.hostToolDefinitions.map((definition) => definition.name),
      ["web_search", "paper_search", "paper_details", "web_fetch"],
    );
    assert.equal(plan.capabilities[0]!.availability, "available");
  });

  it("still prefers a provider-native offer", () => {
    const plan = resolveCapabilityPlan({
      requiredCapabilities: [webSearch],
      providerOffers: [{ operationId: "web.search", nativeKey: "WebSearch" }],
      hostTools: webTools,
      enabledHostToolIds: new Set(webTools.map((tool) => tool.toolId)),
    });
    const search = plan.operations.find((operation) => operation.operationId === "web.search")!;
    assert.equal(search.source, "provider");
    assert.deepEqual(search.toolNames, ["WebSearch"]);
    assert.deepEqual(plan.hostToolDefinitions.map((definition) => definition.name), ["web_fetch"]);
  });
});

describe("the agents' own web tools (webSearch.mode \"agent\")", () => {
  it("are offered only when the deployment chose them", () => {
    for (const provider of ["anthropic", "claude-agent", "cursor-agent"]) {
      const offers = nativeOffersFor(provider, { attachmentRootsPresent: true });
      assert.ok(!offers.some((offer) => offer.operationId.startsWith("web.")), provider);
    }
    const claude = nativeOffersFor("claude-agent", { attachmentRootsPresent: true, nativeWeb: true });
    assert.deepEqual(
      claude.filter((offer) => offer.operationId.startsWith("web.")).map((offer) => offer.nativeKey),
      ["WebSearch", "WebFetch"],
    );
    const cursor = nativeOffersFor("cursor-agent", { attachmentRootsPresent: true, nativeWeb: true });
    assert.deepEqual(
      cursor.filter((offer) => offer.operationId.startsWith("web.")).map((offer) => offer.nativeKey),
      ["webSearch", "webFetch"],
    );
    // The Messages API searches server-side; fetch stays the host's.
    const messages = nativeOffersFor("anthropic", { attachmentRootsPresent: true, nativeWeb: true });
    assert.deepEqual(
      messages.filter((offer) => offer.operationId.startsWith("web.")).map((offer) => offer.operationId),
      ["web.search"],
    );
  });
});
