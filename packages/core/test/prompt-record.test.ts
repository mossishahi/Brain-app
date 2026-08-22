import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutionContext,
  PromptRecord,
} from "../src/index.js";

function record(overrides: Partial<PromptRecord> = {}): PromptRecord {
  return {
    id: "p1",
    at: 1,
    taskId: "t1",
    kind: "brainstorm.generate",
    attempt: 1,
    provider: "anthropic",
    complete: true,
    sections: [{ title: "System", body: "be helpful" }],
    ...overrides,
  };
}

test("reportPrompt is optional, so a host that shows no prompts costs nothing", () => {
  // Absence must be legal at the type level AND at the call site: executors
  // reach the hook through `?.`, exactly as they do reportLive.
  const context: AgentExecutionContext = { runId: "r1", nodePath: "root" };
  context.reportPrompt?.(record());
  assert.equal(context.reportPrompt, undefined);
});

test("a host receives each hand-off's record verbatim", () => {
  const seen: PromptRecord[] = [];
  const context: AgentExecutionContext = {
    runId: "r1",
    nodePath: "root",
    reportPrompt: (r) => seen.push(r),
  };

  context.reportPrompt?.(record({ id: "p1", turn: 1 }));
  context.reportPrompt?.(record({ id: "p2", turn: 2, complete: false }));

  assert.deepEqual(
    seen.map((r) => r.id),
    ["p1", "p2"],
  );
  // `complete` is the one field a reader cannot infer: it says whether the
  // sections are every byte the model got, or only our half of the request.
  assert.deepEqual(
    seen.map((r) => r.complete),
    [true, false],
  );
  assert.equal(seen[0]?.sections[0]?.body, "be helpful");
});
