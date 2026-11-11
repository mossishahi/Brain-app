import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask, PromptRecord } from "@brainstorm-agentic/core";
import { CursorAgentExecutor, type CursorSdkAgentOptions } from "../src/index.js";

test("missing output delivers the complete pinned schema in the fresh raw retry prompt", async () => {
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
    modelRequest: { modelId: "test-model", messages: [{ role: "user", content: [{ type: "text", text: "Develop the idea using the supplied output schema." }] }] },
  };
  const options: CursorSdkAgentOptions[] = [];
  const prompts: { attempt: number; text: string }[] = [];
  const records: PromptRecord[] = [];
  let validated = 0;
  const executor = new CursorAgentExecutor({
    apiKey: "test-key", maxValidationAttempts: 2,
    listModels: async () => [{ id: "test-model", parameters: [] }],
    agentFactory: async (input) => {
      options.push(input);
      const attempt = options.length;
      return {
        agentId: `raw-schema-${attempt}`,
        async send(text) {
          prompts.push({ attempt, text });
          return {
            id: `raw-schema-send-${prompts.length}`,
            async *stream() {},
            async wait() { return { status: "finished" as const,
              result: attempt === 1 ? "No final result submitted." : JSON.stringify(expected), usage: { inputTokens: 0, outputTokens: 0 } }; },
            supports: () => true,
            async cancel() {},
          };
        },
        close() {},
      };
    },
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
  assert.equal(options.length, 2);
  assert.ok(options[0]!.local.customTools?.submit_result);
  assert.equal(options[1]!.local.customTools?.submit_result, undefined);
  assert.ok(prompts.find((prompt) => prompt.attempt === 2)!.text.includes(JSON.stringify(schema, null, 2)), "the actual model request carries all nested constraints and descriptions");
  const retryRecord = records.find((record) => record.attempt === 2)!;
  assert.ok(retryRecord.sections.find((section) => section.title === "Prompt")!.body.includes(JSON.stringify(schema, null, 2)));
  assert.ok(retryRecord.sections.some((section) => section.title.startsWith("Delivered output JSON schema")));
  assert.ok(!retryRecord.sections.some((section) => /not delivered/.test(section.title)));
});
