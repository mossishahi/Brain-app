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
        // Adaptive thinking is the only mode compatible with the forced
        // tool_choice above; manual mode would be rejected by validation.
        thinking: { type: "adaptive", display: "summarized" },
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
    type: "adaptive",
    display: "summarized",
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

test("round-trips thinking, omitted, and redacted thinking blocks losslessly", async () => {
  let captured: Record<string, unknown> | undefined;
  const provider = new AnthropicMessagesProvider({
    model: "claude-test",
    client: {
      messages: {
        async create(body) {
          captured = body;
          return {
            model: "claude-test",
            content: [{ type: "text", text: "ok" }],
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
      { role: "user", content: [{ type: "text", text: "Continue." }] },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            text: "Summarized reasoning.",
            metadata: { signature: "sig-1" },
          },
          // Omitted-display block: empty text, signature only.
          { type: "thinking", text: "", metadata: { signature: "sig-2" } },
          // Safety-redacted block: opaque data, no readable text.
          {
            type: "thinking",
            text: "",
            metadata: { redactedData: "opaque-redacted" },
          },
          // Unsigned cross-provider thinking degrades to plain text.
          { type: "thinking", text: "Cross-provider reasoning text." },
          // Unsigned empty thinking is dropped, never an empty text block.
          { type: "thinking", text: "" },
          { type: "text", text: "Answer so far." },
        ],
      },
      { role: "user", content: [{ type: "text", text: "And then?" }] },
    ],
  });

  const messages = captured?.messages as Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(messages[1]?.content, [
    { type: "thinking", thinking: "Summarized reasoning.", signature: "sig-1" },
    { type: "thinking", thinking: "", signature: "sig-2" },
    { type: "redacted_thinking", data: "opaque-redacted" },
    { type: "text", text: "Cross-provider reasoning text." },
    { type: "text", text: "Answer so far." },
  ]);
});

test("maps thinking and redacted_thinking response blocks for lossless replay", async () => {
  const provider = new AnthropicMessagesProvider({
    model: "claude-test",
    client: {
      messages: {
        async create() {
          return {
            model: "claude-test",
            content: [
              {
                type: "thinking",
                thinking: "Reasoning summary.",
                signature: "sig-9",
              },
              { type: "redacted_thinking", data: "opaque-9" },
              { type: "text", text: "Final." },
            ],
            stop_reason: "end_turn",
            usage: {},
          };
        },
      },
    },
  });

  const response = await provider.complete({
    modelId: "claude-test",
    messages: [{ role: "user", content: [{ type: "text", text: "Think." }] }],
  });

  assert.deepEqual(response.content, [
    {
      type: "thinking",
      text: "Reasoning summary.",
      metadata: { signature: "sig-9" },
    },
    { type: "thinking", text: "", metadata: { redactedData: "opaque-9" } },
    { type: "text", text: "Final." },
  ]);
});

test("applies the provider-level thinking configuration and lets requests override it", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new AnthropicMessagesProvider({
    model: "claude-test",
    thinking: { type: "adaptive", display: "summarized" },
    client: {
      messages: {
        async create(body) {
          bodies.push(body);
          return {
            model: "claude-test",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: {},
          };
        },
      },
    },
  });
  const request: ModelRequest = {
    modelId: "claude-test",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi." }] }],
  };

  await provider.complete(request);
  assert.deepEqual(bodies[0]?.thinking, {
    type: "adaptive",
    display: "summarized",
  });

  await provider.complete({
    ...request,
    providerOptions: { anthropic: { thinking: { type: "disabled" } } },
  });
  assert.deepEqual(bodies[1]?.thinking, { type: "disabled" });
});

test("rejects thinking configurations the Messages API documents as invalid", async () => {
  const provider = new AnthropicMessagesProvider({
    model: "claude-test",
    maxTokens: 4096,
    client: {
      messages: {
        async create() {
          return {
            model: "claude-test",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: {},
          };
        },
      },
    },
  });
  const base: ModelRequest = {
    modelId: "claude-test",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi." }] }],
  };
  const expectValidation = (request: ModelRequest, pattern: RegExp) =>
    assert.rejects(provider.complete(request), (error: unknown) => {
      assert.ok(error instanceof AnthropicProviderError);
      assert.equal(error.category, "validation");
      assert.match(error.message, pattern);
      return true;
    });

  await expectValidation(
    {
      ...base,
      providerOptions: { anthropic: { thinking: { type: "enabled" } } },
    },
    /budget_tokens/,
  );
  await expectValidation(
    {
      ...base,
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budget_tokens: 512 } },
      },
    },
    /at least 1024/,
  );
  await expectValidation(
    {
      ...base,
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budget_tokens: 4096 } },
      },
    },
    /less than max_tokens/,
  );
  await expectValidation(
    {
      ...base,
      providerOptions: {
        anthropic: { thinking: { type: "adaptive", budget_tokens: 2048 } },
      },
    },
    /manual mode/,
  );
  await expectValidation(
    {
      ...base,
      providerOptions: {
        anthropic: { thinking: { type: "disabled", display: "summarized" } },
      },
    },
    /disabled/,
  );
  await expectValidation(
    {
      ...base,
      tools: [{ name: "t", inputSchema: { type: "object" } }],
      toolChoice: { type: "required" },
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budget_tokens: 2048 } },
      },
    },
    /forced tool use/,
  );
  await expectValidation(
    {
      ...base,
      temperature: 0.3,
      providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
    },
    /temperature/,
  );
  await expectValidation(
    {
      ...base,
      topP: 0.5,
      providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
    },
    /top_p/,
  );

  // Documented-valid combinations pass through untouched.
  await provider.complete({
    ...base,
    topP: 0.98,
    providerOptions: {
      anthropic: { thinking: { type: "adaptive", display: "omitted" } },
    },
  });
  await provider.complete({
    ...base,
    tools: [{ name: "t", inputSchema: { type: "object" } }],
    toolChoice: { type: "required" },
    providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
  });
  await provider.complete({
    ...base,
    providerOptions: {
      anthropic: { thinking: { type: "enabled", budget_tokens: 2048 } },
    },
  });
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

test("native operations become server tools; their activity round-trips and is surfaced", async () => {
  const bodies: Record<string, unknown>[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      async create(body) {
        bodies.push(body);
        return {
          id: "msg_native",
          model: "claude-response",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "photon counting" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [{ type: "web_search_result", url: "https://example.org", title: "Result" }],
            },
            { type: "text", text: '{"answer":1}' },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        };
      },
    },
  };
  const provider = new AnthropicMessagesProvider({
    apiKey: "not-used-by-mock",
    model: "claude-default",
    client,
  });
  const response = await provider.complete({
    modelId: "claude-request",
    messages: [{ role: "user", content: [{ type: "text", text: "Search." }] }],
    nativeOperations: ["web_search", "code_execution"],
  });

  const tools = bodies[0]!.tools as Record<string, unknown>[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["web_search", "code_execution"],
    "each selected native operation ships as one server tool",
  );
  assert.match(String(tools[0]!.type), /^web_search_\d+$/);
  assert.match(String(tools[1]!.type), /^code_execution_\d+$/);

  // Server-tool activity is invisible to text extraction but preserved for
  // round-trips, and surfaced for observability.
  assert.deepEqual(response.metadata?.serverToolUses, ["web_search"]);
  const passthrough = response.content.filter(
    (block) => block.type === "text" && block.metadata?.anthropicRaw !== undefined,
  );
  assert.equal(passthrough.length, 2, "server blocks ride as raw passthrough");
  const visibleText = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
  assert.equal(visibleText, '{"answer":1}', "passthrough blocks add no visible text");

  // Resending the assistant content must reproduce the wire blocks verbatim.
  await provider.complete({
    modelId: "claude-request",
    messages: [
      { role: "user", content: [{ type: "text", text: "Search." }] },
      { role: "assistant", content: response.content },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ],
  });
  const resent = bodies[1]!.messages as { role: string; content: Record<string, unknown>[] }[];
  const assistant = resent.find((message) => message.role === "assistant")!;
  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["server_tool_use", "web_search_tool_result", "text"],
    "server blocks round-trip byte-identical on the next turn",
  );
});

test("an unmapped native operation key fails loudly instead of dropping the capability", async () => {
  const client: AnthropicMessagesClient = {
    messages: {
      async create() {
        throw new Error("must not be called");
      },
    },
  };
  const provider = new AnthropicMessagesProvider({
    apiKey: "not-used-by-mock",
    model: "claude-default",
    client,
  });
  await assert.rejects(
    provider.complete({
      modelId: "claude-request",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi." }] }],
      nativeOperations: ["not_a_real_tool"],
    }),
    (error: AnthropicProviderError) =>
      error.category === "validation" && /not_a_real_tool/.test(error.message),
  );
});

test("pause_turn responses continue automatically and concatenate the full turn", async () => {
  const bodies: Record<string, unknown>[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      async create(body) {
        bodies.push(body);
        if (bodies.length === 1) {
          return {
            id: "msg_paused",
            model: "claude-response",
            content: [
              { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "q" } },
            ],
            stop_reason: "pause_turn",
            usage: { input_tokens: 4, output_tokens: 1 },
          };
        }
        return {
          id: "msg_final",
          model: "claude-response",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 6, output_tokens: 2 },
        };
      },
    },
  };
  const provider = new AnthropicMessagesProvider({
    apiKey: "not-used-by-mock",
    model: "claude-default",
    client,
  });
  const response = await provider.complete({
    modelId: "claude-request",
    messages: [{ role: "user", content: [{ type: "text", text: "Go." }] }],
    nativeOperations: ["web_search"],
  });

  assert.equal(bodies.length, 2, "the paused turn is resent once");
  const continuation = bodies[1]!.messages as { role: string }[];
  assert.equal(continuation[continuation.length - 1]!.role, "assistant");
  assert.equal(response.stopReason, "end_turn");
  assert.equal(response.usage.inputTokens, 10, "usage sums across continuations");
  assert.equal(response.usage.outputTokens, 3);
  assert.deepEqual(response.metadata?.serverToolUses, ["web_search"]);
  const visibleText = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
  assert.equal(visibleText, "done", "the caller sees one concatenated turn");
});
