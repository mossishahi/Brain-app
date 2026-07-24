import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRequest } from "@brainstorm-agentic/core";
import {
  AnthropicMessagesProvider,
  AnthropicProviderError,
  classifyAnthropicError,
  type AnthropicMessagesClient,
} from "../src/index.js";

test("maps exact core requests and native JSON-schema responses", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  let capturedSignal: AbortSignal | undefined;
  const client: AnthropicMessagesClient = {
    messages: {
      async create(body, options) {
        capturedBody = body;
        capturedSignal = options?.signal;
        return {
          id: "msg_test",
          model: "claude-response",
          content: [{ type: "text", text: '{"answer":42}' }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        };
      },
    },
  };
  const provider = new AnthropicMessagesProvider({
    apiKey: "not-used-by-mock",
    model: "claude-default",
    maxTokens: 500,
    providerOptions: {
      metadata: { user_id: "test-user" },
    },
    client,
  });
  const controller = new AbortController();
  const request: ModelRequest = {
    modelId: "claude-request",
    system: "Be concise.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Use the prior result." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "lookup",
            input: { query: "x" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tool-1",
            content: [
              { type: "text", text: '{"value":42}' },
              {
                type: "image",
                source: {
                  kind: "base64",
                  mediaType: "image/png",
                  data: "aW1hZ2U=",
                },
              },
              {
                type: "document",
                source: {
                  kind: "base64",
                  mediaType: "application/pdf",
                  data: "cGRm",
                },
                title: "paper.pdf",
              },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        name: "lookup",
        description: "Look up a value.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
    toolChoice: { type: "required" },
    responseFormat: {
      type: "jsonSchema",
      name: "answer",
      schema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
    },
    maxOutputTokens: 123,
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled", budget_tokens: 32 },
        stream: true,
      },
    },
  };

  const response = await provider.complete(request, {
    signal: controller.signal,
  });

  assert.equal(capturedSignal, controller.signal);
  assert.equal(capturedBody?.model, "claude-request");
  assert.equal(capturedBody?.max_tokens, 123);
  assert.equal(capturedBody?.stream, false);
  assert.deepEqual(capturedBody?.thinking, {
    type: "enabled",
    budget_tokens: 32,
  });
  assert.equal(capturedBody?.system, "Be concise.");
  assert.deepEqual(capturedBody?.tool_choice, { type: "any" });

  const messages = capturedBody?.messages as Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(
    messages.map(({ role }) => role),
    ["user", "assistant", "user"],
  );
  assert.deepEqual(messages[1]?.content[0], {
    type: "tool_use",
    id: "tool-1",
    name: "lookup",
    input: { query: "x" },
  });
  assert.deepEqual(messages[2]?.content[0], {
    type: "tool_result",
    tool_use_id: "tool-1",
    content: [
      { type: "text", text: '{"value":42}' },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "aW1hZ2U=",
        },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "cGRm",
        },
        title: "paper.pdf",
      },
    ],
    is_error: false,
  });

  const tools = capturedBody?.tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools[0]?.input_schema, {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  });
  assert.deepEqual(capturedBody?.output_config, {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
    },
  });

  assert.equal(response.providerId, "anthropic");
  assert.equal(response.modelId, "claude-response");
  assert.deepEqual(response.content, [
    { type: "text", text: '{"answer":42}' },
  ]);
  assert.equal(response.stopReason, "end_turn");
  assert.deepEqual(response.usage, {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cacheReadInputTokens: 3,
    cacheWriteInputTokens: 2,
  });
});

test("maps Anthropic tool use to core tool_use blocks", async () => {
  const client: AnthropicMessagesClient = {
    messages: {
      async create() {
        return {
          id: "msg_tool",
          model: "claude-test",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "search",
              input: { query: "brainstorming" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      },
    },
  };
  const provider = new AnthropicMessagesProvider({
    model: "claude-test",
    client,
  });

  const response = await provider.complete({
    modelId: "claude-test",
    messages: [
      { role: "user", content: [{ type: "text", text: "Search." }] },
    ],
  });

  assert.deepEqual(response.content, [
    {
      type: "tool_use",
      id: "call-1",
      name: "search",
      input: { query: "brainstorming" },
    },
  ]);
  assert.equal(response.stopReason, "tool_use");
});

test("honors toolChoice none and generic JSON output", async () => {
  let captured: Record<string, unknown> | undefined;
  const provider = new AnthropicMessagesProvider({
    model: "claude-test",
    client: {
      messages: {
        async create(body) {
          captured = body;
          return {
            model: "claude-test",
            content: [{ type: "text", text: "{}" }],
            stop_reason: "end_turn",
            usage: {},
          };
        },
      },
    },
  });

  await provider.complete({
    modelId: "claude-test",
    messages: [
      { role: "user", content: [{ type: "text", text: "JSON." }] },
    ],
    tools: [
      {
        name: "unused",
        inputSchema: { type: "object" },
      },
    ],
    toolChoice: { type: "none" },
    responseFormat: { type: "json" },
  });

  assert.equal(captured?.tools, undefined);
  assert.equal(captured?.tool_choice, undefined);
  assert.deepEqual(captured?.output_config, {
    format: { type: "json_schema", schema: {} },
  });
});

test("lists the configured model and classifies failures", async () => {
  const client: AnthropicMessagesClient = {
    messages: {
      async create() {
        throw Object.assign(new Error("rate limited"), {
          status: 429,
          requestId: "req_123",
        });
      },
    },
  };
  const provider = new AnthropicMessagesProvider({
    model: "claude-test",
    displayName: "Claude Test",
    capabilities: { thinking: true },
    client,
  });

  const models = await provider.listModels();
  assert.equal(models[0]?.modelId, "claude-test");
  assert.equal(models[0]?.displayName, "Claude Test");
  assert.equal(models[0]?.capabilities.thinking, true);
  assert.equal(
    (await provider.getCapabilities("claude-test"))?.jsonSchemaOutput,
    true,
  );
  assert.equal(await provider.getCapabilities("unknown"), undefined);

  await assert.rejects(
    provider.complete({
      modelId: "claude-test",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello." }] },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AnthropicProviderError);
      assert.equal(error.category, "rate_limit");
      assert.equal(error.transient, true);
      assert.equal(error.status, 429);
      assert.equal(error.requestId, "req_123");
      return true;
    },
  );

  const validation = classifyAnthropicError(
    Object.assign(new Error("bad request"), { status: 400 }),
  );
  assert.equal(validation.category, "validation");
  assert.equal(validation.transient, false);
});

test("rejects pre-aborted calls with AbortError before the SDK boundary", async () => {
  let called = false;
  const provider = new AnthropicMessagesProvider({
    model: "claude-test",
    client: {
      messages: {
        async create() {
          called = true;
          throw new Error("not reached");
        },
      },
    },
  });
  const controller = new AbortController();
  controller.abort("cancelled");

  await assert.rejects(
    provider.complete(
      {
        modelId: "claude-test",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello." }] },
        ],
      },
      { signal: controller.signal },
    ),
    (error: Error) => error.name === "AbortError",
  );
  assert.equal(called, false);
});
