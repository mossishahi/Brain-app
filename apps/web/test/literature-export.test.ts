/// <reference lib="dom" />
import assert from "node:assert/strict";
import test from "node:test";
import type { BrainIdeaView, LiteratureReviewView } from "@brainstorm-agentic/protocol";
import { seatOutputToLatex } from "../src/latex.js";

test("paper export appends attributable structured reviews and preserves legacy bibliography", () => {
  const review: LiteratureReviewView = { reviewId: "own-review", revision: 1, state: "submitted", owner: { runId: "run", taskId: "task-thinker", agentId: "seat-1", nodePath: "first-pass", role: "Thinker" },
    inputRevision: "input1", inputRequirements: [{ id: "R1", text: "Preserve geometry" }], createdAt: 1, updatedAt: 1,
    review: { schemaVersion: "literature-review/v1", scope: { question: "Which method?", inputRequirements: [{ id: "R1", text: "Preserve geometry" }], vantage: "Mathematics" },
      search: { queries: [], coverage: "Inspected methods", limitations: [] },
      works: [{ id: "W1", source: { title: "A relevant method", authors: ["An Author"], year: 2020, venue: null, url: "https://example.org/paper", doi: null, version: "v1" },
        inspected: { level: "sections", evidence: [{ documentId: "d1", receiptId: "receipt1", segmentId: "p3", locator: "Page 3" }], accessLimitations: [] },
        method: "Locally checks coordinates", results: "Addresses one obstacle", conditions: ["Uniform sampling"], limitations: [],
        relevance: [{ requirementId: "R1", relationship: "partially-addresses", justification: "Detects redundant directions" }], intendedUse: ["A comparison baseline"], uncertainties: [] }],
      synthesis: { closestWorkIds: ["W1"], assessment: "partially-solved", findings: "A relevant baseline exists", gaps: [], comparisons: [] }, status: "complete", statusReason: "Methods inspected" } };
  const idea: BrainIdeaView = { type: "research idea", shape: "paper", cot: ["An argument"], literature: [{ title: "Legacy source" }], literatureReviews: [review] };
  const rendered = seatOutputToLatex({ idea, seatNumber: 1, topic: "Geometry" }, "");
  assert.ok(rendered.includes("Legacy source"));
  assert.ok(rendered.includes("task-thinker"));
  assert.ok(rendered.includes("Preserve geometry"));
  assert.ok(rendered.includes("Detects redundant directions"));
  assert.ok(rendered.includes("receipt1"));
  assert.ok(rendered.indexOf("Literature review") > rendered.indexOf("Chain of thought"));
  const legacy = seatOutputToLatex({ idea: { type: "research idea", shape: "paper", cot: [], literature: [{ title: "Legacy source" }] }, seatNumber: 1, topic: "Geometry" }, "");
  assert.ok(legacy.includes("Legacy source"));
  assert.ok(!legacy.includes("Literature review"));
});
