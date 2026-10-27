/**
 * The availability contract types: TOOL_PURPOSES names every purpose once,
 * and the shapes compile as the server and the UI use them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_PURPOSES,
  type AvailabilityProbeRequest,
  type AvailabilityReport,
  type AvailabilityServerEvent,
  type PurposeOrder,
  type ServerSettingsUpdate,
  type ToolAvailability,
  type ToolPurpose,
  type ToolState,
} from "../src/index.js";

test("TOOL_PURPOSES lists the seven purposes in pipeline order, once each", () => {
  assert.deepEqual([...TOOL_PURPOSES], ["web", "news", "paper-lookup", "paper-topic", "paper-details", "citation-hop", "embedding"]);
  assert.equal(new Set(TOOL_PURPOSES).size, TOOL_PURPOSES.length);
  const purpose: ToolPurpose = TOOL_PURPOSES[0]!;
  assert.equal(purpose, "web");
});

test("an AvailabilityReport with every field compiles and round-trips through JSON", () => {
  const state: ToolState = "degraded";
  const tool: ToolAvailability = {
    id: "searxng",
    label: "SearXNG",
    group: "search",
    state,
    keyPresent: false,
    latencyMs: 412,
    detail: "3 of 4 engines usable",
    checkedAt: 1,
    until: 2,
    probing: false,
    log: [{ at: 1, level: "info", text: "probe searxng" }],
    children: [{ id: "google", label: "google", group: "search", state: "blocked", log: [] }],
  };
  const order: PurposeOrder = {
    purpose: "web",
    configured: ["searxng", "brave"],
    effective: ["searxng"],
    entries: [
      { id: "searxng", action: "moved", reason: "degraded" },
      { id: "brave", action: "dropped", reason: "needs an API key" },
    ],
  };
  const report: AvailabilityReport = { version: 1, updatedAt: 3, tools: [tool], purposes: [order], demoteDegraded: true };
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  const event: AvailabilityServerEvent = { type: "availability", availability: report };
  assert.equal(event.type, "availability");
  const request: AvailabilityProbeRequest = { tools: ["searxng"] };
  assert.deepEqual(request.tools, ["searxng"]);
  const update: ServerSettingsUpdate = { availability: { demoteDegraded: false, periodicMinutes: 15 } };
  assert.equal(update.availability?.periodicMinutes, 15);
});
