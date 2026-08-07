import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilityPlan } from "../src/capability/broker.js";
import type { BrokerInput, CapabilityDeclaration } from "../src/capability/broker.js";
import type { HostToolManifest, ProviderNativeOffer } from "../src/capability/types.js";

const attachmentAccess: CapabilityDeclaration = {
  capabilityId: "attachment-access",
  operations: ["attachment.list", "attachment.read"],
  whenUnavailable: "Do NOT read attachments; reason from metadata only.",
};

const webSearch: CapabilityDeclaration = {
  capabilityId: "web-search",
  operations: ["web.search", "web.fetch"],
  whenUnavailable: "Do NOT claim to have searched; rely on training data.",
};

const codeExecution: CapabilityDeclaration = {
  capabilityId: "code-execution",
  operations: ["code.execute"],
  whenUnavailable: "Do NOT run code; include full script source instead.",
};

const hostAttachmentList: HostToolManifest = {
  toolId: "attachment_list",
  displayName: "Attachment List",
  operations: ["attachment.list"],
  risk: "low",
  defaultEnabled: true,
  definition: { name: "attachment_list", inputSchema: { type: "object" } },
};

const hostAttachmentRead: HostToolManifest = {
  toolId: "attachment_read",
  displayName: "Attachment Read",
  operations: ["attachment.read"],
  risk: "low",
  defaultEnabled: true,
  definition: { name: "attachment_read", inputSchema: { type: "object" } },
};

const hostWebSearch: HostToolManifest = {
  toolId: "web_search",
  displayName: "Web Search",
  operations: ["web.search"],
  risk: "medium",
  defaultEnabled: false,
  definition: { name: "web_search", inputSchema: { type: "object" } },
};

const hostWebFetch: HostToolManifest = {
  toolId: "web_fetch",
  displayName: "Web Fetch",
  operations: ["web.fetch"],
  risk: "medium",
  defaultEnabled: false,
  definition: { name: "web_fetch", inputSchema: { type: "object" } },
};

describe("resolveCapabilityPlan", () => {
  it("resolves all operations via host tools when enabled", () => {
    const input: BrokerInput = {
      requiredCapabilities: [attachmentAccess],
      providerOffers: [],
      hostTools: [hostAttachmentList, hostAttachmentRead],
      enabledHostToolIds: new Set(["attachment_list", "attachment_read"]),
    };
    const plan = resolveCapabilityPlan(input);
    assert.equal(plan.operations.length, 2);
    assert.equal(plan.operations[0]!.source, "host");
    assert.equal(plan.operations[1]!.source, "host");
    assert.equal(plan.hostToolDefinitions.length, 2);
    assert.equal(plan.providerNativeKeys.length, 0);
    assert.equal(plan.unavailableInstructions, "");
  });

  it("prefers provider offers over host tools", () => {
    const providerOffer: ProviderNativeOffer = {
      operationId: "web.search",
      nativeKey: "web_search_native",
    };
    const input: BrokerInput = {
      requiredCapabilities: [webSearch],
      providerOffers: [providerOffer],
      hostTools: [hostWebSearch, hostWebFetch],
      enabledHostToolIds: new Set(["web_search", "web_fetch"]),
    };
    const plan = resolveCapabilityPlan(input);
    const searchOp = plan.operations.find((o) => o.operationId === "web.search")!;
    const fetchOp = plan.operations.find((o) => o.operationId === "web.fetch")!;
    assert.equal(searchOp.source, "provider");
    assert.deepEqual(searchOp.toolNames, ["web_search_native"]);
    assert.equal(fetchOp.source, "host");
    assert.deepEqual(fetchOp.toolNames, ["web_fetch"]);
    assert.deepEqual(plan.providerNativeKeys, ["web_search_native"]);
    assert.equal(plan.hostToolDefinitions.length, 1);
    assert.equal(plan.hostToolDefinitions[0]!.name, "web_fetch");
  });

  it("marks operations unavailable when host tools are disabled", () => {
    const input: BrokerInput = {
      requiredCapabilities: [codeExecution],
      providerOffers: [],
      hostTools: [],
      enabledHostToolIds: new Set(),
    };
    const plan = resolveCapabilityPlan(input);
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.operations[0]!.source, "unavailable");
    assert.deepEqual(plan.operations[0]!.toolNames, []);
    assert.ok(plan.unavailableInstructions.includes("[code-execution]"));
    assert.ok(plan.unavailableInstructions.includes("Do NOT run code"));
  });

  it("marks disabled host tools as unavailable even when installed", () => {
    const input: BrokerInput = {
      requiredCapabilities: [webSearch],
      providerOffers: [],
      hostTools: [hostWebSearch, hostWebFetch],
      enabledHostToolIds: new Set(), // user disabled everything
    };
    const plan = resolveCapabilityPlan(input);
    assert.equal(plan.operations[0]!.source, "unavailable");
    assert.equal(plan.operations[1]!.source, "unavailable");
    assert.ok(plan.unavailableInstructions.includes("[web-search]"));
  });

  it("handles multiple capabilities with mixed availability", () => {
    const input: BrokerInput = {
      requiredCapabilities: [attachmentAccess, webSearch, codeExecution],
      providerOffers: [],
      hostTools: [hostAttachmentList, hostAttachmentRead],
      enabledHostToolIds: new Set(["attachment_list", "attachment_read"]),
    };
    const plan = resolveCapabilityPlan(input);

    const attachOps = plan.operations.filter((o) => o.capabilityId === "attachment-access");
    const webOps = plan.operations.filter((o) => o.capabilityId === "web-search");
    const codeOps = plan.operations.filter((o) => o.capabilityId === "code-execution");

    assert.ok(attachOps.every((o) => o.source === "host"));
    assert.ok(webOps.every((o) => o.source === "unavailable"));
    assert.ok(codeOps.every((o) => o.source === "unavailable"));

    assert.equal(plan.hostToolDefinitions.length, 2);
    assert.ok(plan.unavailableInstructions.includes("[web-search]"));
    assert.ok(plan.unavailableInstructions.includes("[code-execution]"));
    assert.ok(!plan.unavailableInstructions.includes("[attachment-access]"));
  });

  it("a run-disabled capability resolves unavailable past provider offers and host tools", () => {
    const providerOffer: ProviderNativeOffer = {
      operationId: "web.search",
      nativeKey: "web_search",
    };
    const input: BrokerInput = {
      requiredCapabilities: [webSearch, attachmentAccess],
      providerOffers: [providerOffer],
      hostTools: [hostAttachmentList, hostAttachmentRead, hostWebFetch],
      enabledHostToolIds: new Set(["attachment_list", "attachment_read", "web_fetch"]),
      disabledCapabilityIds: new Set(["web-search"]),
    };
    const plan = resolveCapabilityPlan(input);

    const webOps = plan.operations.filter((o) => o.capabilityId === "web-search");
    assert.ok(webOps.every((o) => o.source === "unavailable"));
    assert.equal(plan.providerNativeKeys.length, 0);
    assert.ok(!plan.hostToolDefinitions.some((d) => d.name === "web_fetch"));
    assert.ok(plan.unavailableInstructions.includes("[web-search]"));
    assert.ok(plan.unavailableInstructions.includes("disabled this capability for this run"));

    // The untouched capability still resolves normally.
    const attachOps = plan.operations.filter((o) => o.capabilityId === "attachment-access");
    assert.ok(attachOps.every((o) => o.source === "host"));
    assert.ok(!plan.unavailableInstructions.includes("[attachment-access]"));
  });

  it("does not duplicate host tool definitions for shared operations", () => {
    const multiOpTool: HostToolManifest = {
      toolId: "multi_tool",
      displayName: "Multi Tool",
      operations: ["attachment.list", "attachment.read"],
      risk: "low",
      defaultEnabled: true,
      definition: { name: "multi_tool", inputSchema: { type: "object" } },
    };
    const input: BrokerInput = {
      requiredCapabilities: [attachmentAccess],
      providerOffers: [],
      hostTools: [multiOpTool],
      enabledHostToolIds: new Set(["multi_tool"]),
    };
    const plan = resolveCapabilityPlan(input);
    assert.equal(plan.hostToolDefinitions.length, 1);
  });
});
