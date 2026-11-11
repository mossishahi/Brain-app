import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask, PromptRecord } from "@brainstorm-agentic/core";
import { ClaudeAgentExecutor, type ClaudeAgentQueryInput } from "../src/index.js";

test("native output exhaustion delivers the complete pinned schema in the raw retry prompt", async () => {
  const schema: NonNullable<AgentTask["outputSchema"]>["schema"] = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      output: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["research idea"] },
          derivation: {
            type: "array", minItems: 2, maxItems: 2,
            description: "Exactly two proof paragraphs, each grounded in the submitted argument.",
            items: { type: "string" },
          },
        },
        required: ["type", "derivation"],
        additionalProperties: false,
      },
    },
    required: ["output"],
    additionalProperties: false,
  };
  const expected = { output: { type: "research idea", derivation: ["First proof paragraph.", "Second proof paragraph."] } };
  const task: AgentTask = {
    taskId: "raw-schema", kind: "brainstorm.brain", input: {}, allowedCapabilities: [],
    outputSchema: { name: "brainIdeaParts", schema },
    modelRequest: { messages: [{ role: "user", content: [{ type: "text", text: "Develop the idea using the supplied output schema." }] }] },
  };
  const captured: ClaudeAgentQueryInput[] = [];
  const records: PromptRecord[] = [];
  let validated = 0;
  const executor = new ClaudeAgentExecutor({
    token: "test-token", maxValidationAttempts: 2,
    queryFn: (input) => ({ async *[Symbol.asyncIterator]() {
      captured.push(input);
      if (captured.length === 1) {
        yield { type: "result", subtype: "error_max_structured_output_retries", is_error: true,
          errors: ["Failed to provide valid structured output after 5 attempts"], usage: {} };
      } else {
        yield { type: "result", subtype: "success", is_error: false, result: JSON.stringify(expected), usage: {} };
      }
    } }),
    outputValidator: { validate(value, receivedSchema) {
      validated += 1;
      assert.deepEqual(receivedSchema, schema);
      assert.deepEqual(value, expected);
      return true;
    } },
  });
  const result = await executor.execute(task, {
    runId: "raw-schema", nodePath: "root/brain", reportPrompt: (record) => { records.push(record); },
  });
  assert.equal(result.status, "ok");
  assert.equal(validated, 1, "raw output still passes authoritative validation");
  assert.equal(captured.length, 2);
  assert.ok(captured[0]!.options.outputFormat);
  assert.equal(captured[1]!.options.outputFormat, undefined);
  assert.ok(captured[1]!.prompt.includes(JSON.stringify(schema, null, 2)), "the actual model request carries all nested constraints and descriptions");
  const retryRecord = records.find((record) => record.attempt === 2)!;
  assert.ok(retryRecord.sections.find((section) => section.title === "Prompt")!.body.includes(JSON.stringify(schema, null, 2)));
  assert.ok(retryRecord.sections.some((section) => section.title.startsWith("Delivered output JSON schema")));
  assert.ok(!retryRecord.sections.some((section) => /not delivered/.test(section.title)));
});
