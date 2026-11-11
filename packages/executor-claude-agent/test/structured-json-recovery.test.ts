import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask } from "@brainstorm-agentic/core";
import { ClaudeAgentExecutor, salvageJsonText, type ClaudeAgentQueryInput } from "../src/index.js";

const task: AgentTask = {
  taskId: "paper-format", kind: "brainstorm.brain", input: {}, allowedCapabilities: [],
  outputSchema: { name: "paper", schema: {
    type: "object", additionalProperties: false, required: ["abstract"],
    properties: { abstract: { type: "array", items: { type: "string" }, minItems: 1,
      description: "One or more complete paragraphs; retain the argument and its conditions." } },
  } },
  modelRequest: { messages: [{ role: "user", content: [{ type: "text", text: "Develop the research proposal." }] }] },
};

test("a malformed long draft reaches corrective feedback intact, with its parser error and schema", async () => {
  const expected = { abstract: ["Anisotropic spectrum. ".repeat(600) + "Final important condition: connected graph."] };
  const malformed = JSON.stringify(expected).slice(0, -1);
  assert.ok(malformed.length > 11_000);
  assert.equal(salvageJsonText(malformed), undefined, "never accept a complete inner array as the paper");
  const inputs: ClaudeAgentQueryInput[] = [];
  let validations = 0;
  const result = await new ClaudeAgentExecutor({
    token: "test-token", maxValidationAttempts: 2,
    queryFn: input => ({ async *[Symbol.asyncIterator]() {
      inputs.push(input);
      yield { type: "result", subtype: "success", is_error: false,
        result: inputs.length === 1 ? malformed : JSON.stringify(expected),
        usage: { input_tokens: 10, output_tokens: 20 } };
    } }),
    outputValidator: { validate(value) { validations += 1; assert.deepEqual(value, expected); return true; } },
  }).execute(task, { runId: "paper-format", nodePath: "first-pass/member-0" });
  assert.equal(result.status, "ok");
  assert.equal(inputs.length, 2);
  assert.equal(validations, 1, "only complete JSON reaches authoritative validation");
  assert.ok(inputs[1]!.prompt.includes(JSON.stringify(malformed)), "the full rejected draft, including its tail, is preserved");
  assert.ok(inputs[1]!.prompt.includes(JSON.stringify(task.outputSchema!.schema, null, 2)));
  assert.match(inputs[1]!.prompt, /JSON parser:/);
  assert.equal(result.usage?.inputTokens, 20);
  assert.equal(result.usage?.outputTokens, 40);
});

test("malformed scientific escapes fail explicitly instead of being silently rewritten", async () => {
  const malformed = String.raw`{"abstract":["The parameter \alpha is positive."]}`;
  assert.equal(salvageJsonText(malformed), undefined);
  const result = await new ClaudeAgentExecutor({
    token: "test-token", maxValidationAttempts: 1,
    queryFn: () => ({ async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", is_error: false, result: malformed, usage: {} };
    } }),
    outputValidator: { validate() { assert.fail("invalid JSON must not reach the validator"); } },
  }).execute(task, { runId: "invalid-escape", nodePath: "first-pass/member-0" });
  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.error.name, "StructuredOutputParseError");
  assert.match(result.error.message, /JSON parser:.*(?:escape|position)/i);
});

test("token-limit then native-output failure still delivers the schema on the final allowed attempt", async () => {
  const inputs: ClaudeAgentQueryInput[] = [];
  const expected = { abstract: ["A complete proposal with explicit conditions."] };
  let validations = 0;
  const result = await new ClaudeAgentExecutor({
    token: "test-token", maxValidationAttempts: 3,
    queryFn: input => ({ async *[Symbol.asyncIterator]() {
      inputs.push(input);
      if (inputs.length === 1) {
        yield { type: "result", subtype: "success", is_error: true,
          result: "API Error: Claude's response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
          usage: { input_tokens: 10, output_tokens: 64_000 } };
      } else if (inputs.length === 2) {
        yield { type: "result", subtype: "error_max_structured_output_retries", is_error: true,
          errors: ["Failed to provide valid structured output after 5 attempts"], usage: { input_tokens: 20, output_tokens: 200 } };
      } else {
        yield { type: "result", subtype: "success", is_error: false,
          result: JSON.stringify(expected), usage: { input_tokens: 30, output_tokens: 100 } };
      }
    } }),
    outputValidator: { validate(value) { validations += 1; assert.deepEqual(value, expected); return true; } },
  }).execute(task, { runId: "three-attempts", nodePath: "first-pass/member-0" });
  assert.equal(result.status, "ok");
  assert.equal(inputs.length, 3, "recovery stays within the existing attempt budget");
  assert.ok(inputs[0]!.options.outputFormat);
  assert.ok(inputs[1]!.options.outputFormat);
  assert.equal(inputs[2]!.options.outputFormat, undefined);
  assert.ok(inputs[2]!.prompt.includes(JSON.stringify(task.outputSchema!.schema, null, 2)));
  assert.equal(validations, 1);
  assert.equal(result.usage?.inputTokens, 60);
  assert.equal(result.usage?.outputTokens, 64_300);
});
