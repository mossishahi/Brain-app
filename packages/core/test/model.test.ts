import assert from "node:assert/strict";
import test from "node:test";

import type {
  CallOptions,
  ModelCapabilities,
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../src/index.js";
import {
  addUsage,
  responseText,
  satisfiesRequirements,
  textBlock,
  toolUseBlocks,
  userMessage,
} from "../src/index.js";

const baseCapabilities: ModelCapabilities = {
  toolUse: false,
  parallelToolUse: false,
  imageInput: false,
  jsonOutput: false,
  jsonSchemaOutput: false,
  thinking: false,
  systemPrompt: true,
  stopSequences: true,
  maxContextTokens: 8000,
  maxOutputTokens: 1000,
};

class FakeProvider implements ModelProvider {
  readonly providerId = "fake";

  constructor(private readonly models: readonly ModelDescriptor[]) {}

  async listModels(): Promise<readonly ModelDescriptor[]> {
    return this.models;
  }

  async getCapabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    return this.models.find((model) => model.modelId === modelId)?.capabilities;
  }

  async complete(request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    if (options?.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return {
      providerId: this.providerId,
      modelId: request.modelId,
      content: [
        textBlock("thinking about it"),
        { type: "tool_use", id: "call-1", name: "search", input: { query: "fusion" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 4 },
    };
  }
}

test("satisfiesRequirements checks capability flags and token minimums", () => {
  assert.ok(satisfiesRequirements(baseCapabilities, {}));
  assert.ok(satisfiesRequirements(baseCapabilities, { systemPrompt: true, minContextTokens: 8000 }));
  assert.ok(!satisfiesRequirements(baseCapabilities, { toolUse: true }));
  assert.ok(!satisfiesRequirements(baseCapabilities, { minContextTokens: 8001 }));
  assert.ok(!satisfiesRequirements(baseCapabilities, { minOutputTokens: 2000 }));
});


test("normalized responses expose content blocks, stop reasons, and usage", async () => {
  const provider = new FakeProvider([{ modelId: "small", capabilities: baseCapabilities }]);
  const response = await provider.complete({ modelId: "small", messages: [userMessage("hi")] });
  assert.equal(response.stopReason, "tool_use");
  assert.equal(responseText(response), "thinking about it");
  const calls = toolUseBlocks(response.content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "search");
  assert.deepEqual(calls[0]!.input, { query: "fusion" });
});

test("providers honor AbortSignal in CallOptions", async () => {
  const provider = new FakeProvider([{ modelId: "small", capabilities: baseCapabilities }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => provider.complete({ modelId: "small", messages: [userMessage("hi")] }, { signal: controller.signal }),
    (error: Error) => error.name === "AbortError",
  );
});

test("addUsage sums required and optional counters", () => {
  const total = addUsage(
    { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 },
    { inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 7 },
  );
  assert.deepEqual(total, {
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 3,
    cacheReadInputTokens: 2,
    reasoningTokens: 7,
  });
});
