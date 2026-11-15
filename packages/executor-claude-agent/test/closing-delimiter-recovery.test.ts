import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask } from "@brainstorm-agentic/core";
import { ClaudeAgentExecutor, type ClaudeAgentQueryFn, type ClaudeAgentQueryInput } from "../src/index.js";

const expected = {
  output: { paper: { abstract: ["A complete scientific result, with its conditions preserved."] } },
  novelty: "A comparison against the established baseline.",
  literature: [{ title: "An inspected source" }],
};
const serialized = JSON.stringify(expected);
const missingOffset = serialized.indexOf('},"novelty":');
assert.ok(missingOffset > 0);
const malformed = serialized.slice(0, missingOffset) + serialized.slice(missingOffset + 1);
const steps = Array.from({ length: 6 }, (_, index) => `Supported argument step ${index + 1}.`);
const task: AgentTask = {
  taskId: "closing-delimiter", kind: "brainstorm.brain", input: {}, allowedCapabilities: [],
  outputSchema: { name: "paper", schema: {
    type: "object", additionalProperties: false, required: ["output", "novelty", "literature"],
    properties: {
      output: { type: "object", additionalProperties: false, required: ["paper"], properties: {
        paper: { type: "object", additionalProperties: false, required: ["abstract"], properties: {
          abstract: { type: "array", minItems: 1, items: { type: "string" } },
        } },
      } },
      novelty: { type: "string" },
      literature: { type: "array", items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } } },
    },
  } },
  metadata: { stepwise: { tool: "submit_step", field: "cot", parts: false, count: 6 } },
  modelRequest: { messages: [{ role: "user", content: [{ type: "text", text: "Develop the research proposal." }] }] },
};

/** Drive the same in-process MCP handler that records the real SDK's step submissions. */
async function submitSteps(input: ClaudeAgentQueryInput, count = 6): Promise<void> {
  const servers = input.options.mcpServers as Record<string, { instance: { _registeredTools: Record<string, {
    handler(args: Record<string, unknown>, extra: unknown): Promise<{ isError?: boolean }>;
  }> } }>;
  const tool = servers.steps!.instance._registeredTools.submit_step!;
  for (let index = 0; index < count; index += 1) {
    assert.notEqual((await tool.handler({ index: index + 1, text: steps[index] }, {})).isError, true);
  }
}

function queryReturning(raw: string, capture: ClaudeAgentQueryInput[], count = 6): ClaudeAgentQueryFn {
  return input => ({ async *[Symbol.asyncIterator]() {
    capture.push(input);
    await submitSteps(input, count);
    yield { type: "result", subtype: "success", is_error: false, result: raw,
      session_id: "format-session", num_turns: 7, total_cost_usd: 0.25,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } };
  } });
}

test("one missing internal brace is repaired without a new model call or lost argument steps", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  let validations = 0;
  const result = await new ClaudeAgentExecutor({
    token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning(malformed, inputs),
    outputValidator: { validate(value) {
      validations += 1;
      assert.deepEqual(value, { ...expected, cot: steps });
      return true;
    } },
  }).execute(task, { runId: "single-delimiter", nodePath: "first-pass/member-1" });
  assert.equal(result.status, "ok");
  assert.equal(inputs.length, 1);
  assert.equal(validations, 1);
  if (result.status !== "ok") return;
  assert.deepEqual(result.output, { ...expected, cot: steps });
  const repair = result.metadata?.jsonFormattingRepair as { kind: string; offset: number; delimiter: string };
  assert.equal(repair.kind, "insert-closing-delimiter");
  assert.equal(repair.delimiter, "}");
  assert.ok(Number.isInteger(repair.offset));
  // Adjacent identical closers admit equivalent insertion offsets; the exact
  // reported edit must reconstruct the original bytes, not just the same object.
  assert.equal(malformed.slice(0, repair.offset) + repair.delimiter + malformed.slice(repair.offset), serialized);
  assert.equal(result.metadata?.sessionId, "format-session");
  assert.equal(result.metadata?.validationAttempts, 1);
  assert.equal(result.usage?.inputTokens, 10);
  assert.equal(result.usage?.outputTokens, 20);
  assert.equal(result.usage?.cacheReadInputTokens, 30);
  assert.equal(result.usage?.cacheWriteInputTokens, 40);
});

test("format repair still works after output-limit and native-output failures spend the earlier attempts", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  let validations = 0;
  const result = await new ClaudeAgentExecutor({
    token: "test-token", maxValidationAttempts: 3,
    queryFn: input => ({ async *[Symbol.asyncIterator]() {
      inputs.push(input);
      if (inputs.length === 1) {
        yield { type: "result", subtype: "success", is_error: true,
          result: "API Error: Claude's response exceeded the 64000 output token maximum.",
          usage: { input_tokens: 10, output_tokens: 64_000 } };
      } else if (inputs.length === 2) {
        yield { type: "result", subtype: "error_max_structured_output_retries", is_error: true,
          errors: ["Failed to provide valid structured output after 5 attempts"], usage: { input_tokens: 20, output_tokens: 200 } };
      } else {
        await submitSteps(input);
        yield { type: "result", subtype: "success", is_error: false,
          result: malformed, usage: { input_tokens: 30, output_tokens: 100 } };
      }
    } }),
    outputValidator: { validate(value) { validations += 1; assert.deepEqual(value, { ...expected, cot: steps }); return true; } },
  }).execute(task, { runId: "third-delimiter", nodePath: "first-pass/member-1" });
  assert.equal(result.status, "ok");
  assert.equal(inputs.length, 3, "format repair must not launch a fourth research session");
  assert.equal(validations, 1);
  assert.ok(inputs[0]!.options.outputFormat);
  assert.ok(inputs[1]!.options.outputFormat);
  assert.equal(inputs[2]!.options.outputFormat, undefined);
  assert.equal(result.metadata?.validationAttempts, 3);
  assert.equal(result.usage?.inputTokens, 60);
  assert.equal(result.usage?.outputTokens, 64_300);
});

test("an ambiguous closing-brace location is rejected even when either shape could pass the schema", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  const ambiguousTask: AgentTask = { ...task, outputSchema: { name: "ambiguous", schema: {
    type: "object", required: ["output"], properties: { output: { type: "object" } },
  } } };
  const result = await new ClaudeAgentExecutor({ token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning('{"output":{"paper":"Claim","novelty":"Comparison"}', inputs),
    outputValidator: { validate() { assert.fail("ambiguous repairs must never reach authoritative validation"); } },
  }).execute(ambiguousTask, { runId: "ambiguous-delimiter", nodePath: "first-pass/member-1" });
  assert.equal(result.status, "error");
  assert.equal(inputs.length, 1);
});

test("a format repair cannot bypass an authoritative rejection", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  let validations = 0;
  const result = await new ClaudeAgentExecutor({ token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning(malformed, inputs),
    outputValidator: { validate() { validations += 1; return { success: false, issues: ["The supporting fact badge has been revoked."] }; } },
  }).execute(task, { runId: "rejected-delimiter", nodePath: "first-pass/member-1" });
  assert.equal(result.status, "error");
  assert.equal(inputs.length, 1);
  assert.equal(validations, 1);
  if (result.status === "error") assert.match(result.error.message, /supporting fact badge has been revoked/);
});

test("a missing argument step makes the formatted answer ineligible for repair", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  const result = await new ClaudeAgentExecutor({ token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning(malformed, inputs, 5),
    outputValidator: { validate() { assert.fail("an incomplete argument cannot be accepted through format repair"); } },
  }).execute(task, { runId: "incomplete-delimiter", nodePath: "first-pass/member-1" });
  assert.equal(result.status, "error");
  assert.equal(inputs.length, 1);
});

test("cancellation during authoritative validation propagates instead of accepting the repair", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  const controller = new AbortController();
  await assert.rejects(new ClaudeAgentExecutor({ token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning(malformed, inputs),
    outputValidator: { async validate() {
      controller.abort(new DOMException("Cancelled during validation", "AbortError"));
      await Promise.resolve();
      return true;
    } },
  }).execute(task, { runId: "cancelled-delimiter", nodePath: "first-pass/member-1", signal: controller.signal }),
  error => error instanceof Error && error.name === "AbortError");
  assert.equal(inputs.length, 1);
});

test("a completed format repair still requires the literature deliverable to pass", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  let deliverableValidations = 0;
  const result = await new ClaudeAgentExecutor({ token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning(malformed, inputs), outputValidator: { validate() { return true; } },
  }).execute(task, { runId: "deliverable-delimiter", nodePath: "first-pass/member-1",
    async validateDeliverables() { deliverableValidations += 1; return ["Submit the inspected-source literature review before finishing."]; },
  });
  assert.equal(result.status, "error");
  assert.equal(inputs.length, 1);
  assert.equal(deliverableValidations, 1);
  if (result.status === "error") assert.match(result.error.message, /inspected-source literature review/);
});

test("format repair is unavailable without an authoritative validator", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  const result = await new ClaudeAgentExecutor({ token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning(malformed, inputs),
  }).execute(task, { runId: "unvalidated-delimiter", nodePath: "first-pass/member-1" });
  assert.equal(result.status, "error");
  assert.equal(inputs.length, 1);
});

test("an unresolved schema reference cannot weaken the repair's shape checks", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  const unsupportedTask: AgentTask = { ...task, outputSchema: { name: "unresolved", schema: {
    $ref: "https://example.invalid/unavailable-schema.json",
  } } };
  const result = await new ClaudeAgentExecutor({ token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning(malformed, inputs),
    outputValidator: { validate() { assert.fail("an uncheckable schema must not permit a formatting repair"); } },
  }).execute(unsupportedTask, { runId: "unresolved-delimiter", nodePath: "first-pass/member-1" });
  assert.equal(result.status, "error");
  assert.equal(inputs.length, 1);
});

test("an asynchronous schema cannot be mistaken for a successful synchronous validation", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  const asyncTask: AgentTask = { ...task, outputSchema: { name: "async", schema: {
    ...task.outputSchema!.schema, $async: true,
  } } };
  const result = await new ClaudeAgentExecutor({ token: "test-token", maxValidationAttempts: 1,
    queryFn: queryReturning(malformed, inputs),
    outputValidator: { validate() { assert.fail("async validation is unsupported by the local repair search"); } },
  }).execute(asyncTask, { runId: "async-delimiter", nodePath: "first-pass/member-1" });
  assert.equal(result.status, "error");
  assert.equal(inputs.length, 1);
});
