import assert from "node:assert/strict";
import test from "node:test";

import {
  checkedLabel,
  chipTitle,
  formatLog,
  formatLogLine,
  latencyLabel,
  orderChips,
  purposeLabel,
  relativeTime,
  stateIcon,
  summarizeAvailability,
  toolLabel,
} from "../src/components/settings/availability-model.js";
import type { PurposeOrder, ToolAvailability, ToolState } from "@brainstorm-agentic/protocol";

function tool(id: string, state: ToolState, extra: Partial<ToolAvailability> = {}): ToolAvailability {
  return { id, label: id, group: "search", state, log: [], ...extra };
}

test("state icons: green check, amber check, grey dash, red cross otherwise", () => {
  assert.deepEqual(stateIcon("available"), { kind: "check", tone: "ok", label: "available" });
  assert.deepEqual(stateIcon("degraded"), { kind: "check", tone: "warn", label: "degraded" });
  assert.deepEqual(stateIcon("unchecked"), { kind: "dash", tone: "muted", label: "not checked yet" });
  assert.deepEqual(stateIcon("disabled"), { kind: "dash", tone: "muted", label: "disabled" });
  for (const state of ["unreachable", "blocked", "needs-key"] as const) {
    const icon = stateIcon(state);
    assert.equal(icon.kind, "cross");
    assert.equal(icon.tone, "bad");
  }
  assert.equal(stateIcon("needs-key").label, "needs key");
});

test("relative time and the checked label", () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeTime(now, now), "just now");
  assert.equal(relativeTime(now - 30_000, now), "just now");
  assert.equal(relativeTime(now - 50_000, now), "1 min ago");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5 min ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 d ago");
  assert.equal(relativeTime(now + 60_000, now), "just now", "a clock skew never reads negative");
  assert.equal(checkedLabel(undefined, now), "never");
  assert.equal(checkedLabel(now - 5 * 60_000, now), "checked 5 min ago");
});

test("log lines format as HH:MM:SS level text, one per line", () => {
  const at = new Date(2026, 9, 3, 9, 5, 7).getTime();
  const later = new Date(2026, 9, 3, 23, 59, 59).getTime();
  assert.equal(formatLogLine({ at, level: "info", text: "GET https://api.crossref.org/works/10.1000/x" }), "09:05:07 info GET https://api.crossref.org/works/10.1000/x");
  assert.equal(
    formatLog([
      { at, level: "info", text: "request" },
      { at: later, level: "error", text: "timeout after 8000 ms" },
    ]),
    "09:05:07 info request\n23:59:59 error timeout after 8000 ms",
  );
  assert.equal(formatLog([]), "");
  // An injected clock keeps the format independent of the zone.
  assert.equal(formatLogLine({ at: 0, level: "warn", text: "x" }, () => "00:00:00"), "00:00:00 warn x");
});

test("latency label", () => {
  assert.equal(latencyLabel(undefined), "");
  assert.equal(latencyLabel(Number.NaN), "");
  assert.equal(latencyLabel(123.6), "124 ms");
});

test("order chips: effective order first with kept/moved, then dropped struck through", () => {
  const order: PurposeOrder = {
    purpose: "paper-lookup",
    configured: ["openalex", "crossref", "semantic-scholar", "arxiv"],
    effective: ["crossref", "arxiv", "semantic-scholar"],
    entries: [
      { id: "openalex", action: "dropped", reason: "needs-key" },
      { id: "crossref", action: "kept" },
      { id: "semantic-scholar", action: "moved", reason: "degraded: HTTP 429 on the probe" },
      { id: "arxiv", action: "kept" },
    ],
  };
  assert.deepEqual(orderChips(order), [
    { id: "crossref", action: "kept" },
    { id: "arxiv", action: "kept" },
    { id: "semantic-scholar", action: "moved", reason: "degraded: HTTP 429 on the probe" },
    { id: "openalex", action: "dropped", reason: "needs-key" },
  ]);
  assert.equal(chipTitle({ id: "openalex", action: "dropped", reason: "needs-key" }), "dropped: needs-key");
  assert.equal(chipTitle({ id: "semantic-scholar", action: "moved", reason: "degraded" }), "moved behind the available tools: degraded");
  assert.equal(chipTitle({ id: "crossref", action: "kept" }), "kept");
  // Without entries every effective tool counts as kept.
  assert.deepEqual(orderChips({ purpose: "web", configured: ["searxng"], effective: ["searxng"], entries: [] }), [
    { id: "searxng", action: "kept" },
  ]);
  assert.equal(purposeLabel("paper-lookup"), "Paper lookup");
  assert.equal(purposeLabel("something-new"), "something-new");
});

test("tool labels resolve through children; the summary takes the worst tone", () => {
  const tools: ToolAvailability[] = [
    tool("searxng", "available", {
      label: "SearXNG",
      children: [tool("searxng:google", "degraded", { label: "google" })],
    }),
    tool("brave", "disabled"),
    tool("arxiv", "available"),
  ];
  assert.equal(toolLabel("searxng:google", tools), "google");
  assert.equal(toolLabel("unknown", tools), "unknown");
  assert.deepEqual(summarizeAvailability(tools), { available: 2, total: 2, tone: "ok", probing: false });
  assert.equal(summarizeAvailability([...tools, tool("crossref", "degraded")]).tone, "warn");
  assert.equal(summarizeAvailability([...tools, tool("openalex", "needs-key")]).tone, "bad");
  assert.equal(summarizeAvailability([tool("code", "unchecked")]).tone, "muted");
  assert.equal(summarizeAvailability([]).tone, "muted");
  assert.equal(summarizeAvailability([tool("x", "available", { children: [tool("y", "unchecked", { probing: true })] })]).probing, true);
});
