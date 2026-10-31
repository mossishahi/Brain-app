import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { userMessage, type JsonObject, type ModelRequest, type RequestCoordinator } from "@brainstorm-agentic/core";
import { GeminiModelProvider, discoverGeminiModels, geminiModelProfile, GeminiProviderError, type GeminiClient } from "../src/index.js";

type Wire = Record<string, any>;
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ modelId: "gemini-3.8-flash", messages: [userMessage("Assess this claim.")], ...extra });
function client(responses: unknown[] = []): { client: GeminiClient; calls: Wire[] } {
  const calls: Wire[] = [];
  return { calls, client: { models: {
    async generateContent(params) { calls.push(params); const next = responses.shift(); if (next instanceof Error) throw next; return next; },
    async list() { return (async function* () { yield { name: "models/gemini-3.8-flash", supportedActions: ["generateContent"] }; })(); },
  } } };
}
const response = (parts: Wire[], extra: Wire = {}): Wire => ({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], ...extra });

test("newer Gemini models use the single-candidate default without an unsupported parameter", async () => {
  const strictClient: GeminiClient = { models: {
    async generateContent(params) {
      if (Object.hasOwn((params as Wire).config, "candidateCount")) {
        throw Object.assign(new Error("candidateCount is not supported for this model"), { status: 400 });
      }
      return response([{ text: "accepted" }]);
    },
    async list() { return (async function* () {})(); },
  } };
  const provider = new GeminiModelProvider({ apiKey: "unused", client: strictClient });
  for (const modelId of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) {
    const result = await provider.complete(request({ modelId }));
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result.content, [{ type: "text", text: "accepted", metadata: { gemini: { part: { text: "accepted" } } } }]);
  }
});

test("no thought summaries by default; system, schema, token usage and controls are independent", async () => {
  const fake = client([response([{ text: '{"ok":true}' }], { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150, cachedContentTokenCount: 60 } })]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client, maxOutputTokens: 8000 });
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const out = await provider.complete(request({ system: [{ text: "role", cacheable: true }, { text: "constraints" }],
    responseFormat: { type: "jsonSchema", schema }, providerOptions: { gemini: { thinkingLevel: "medium" } } }));
  assert.equal(out.stopReason, "end_turn");
  assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 50, reasoningTokens: 30, totalTokens: 150, cacheReadInputTokens: 60 });
  assert.equal(out.content.some((block) => block.type === "thinking"), false);
  assert.equal(fake.calls[0]!.config.systemInstruction, "role\n\nconstraints");
  assert.deepEqual(fake.calls[0]!.config.thinkingConfig, { includeThoughts: false, thinkingLevel: "MEDIUM" });
  assert.deepEqual(fake.calls[0]!.config.responseJsonSchema, schema);
  assert.equal(fake.calls[0]!.config.automaticContinuation, false);
  assert.equal(fake.calls[0]!.config.maxOutputTokens, 8000);
});

test("large output arrays use description guidance without changing host contracts or host tool schemas", async () => {
  const schema = { type: "object", properties: {
    files: { type: "array", description: "Submitted files.", minItems: 0, maxItems: 400,
      items: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["path"], additionalProperties: false } },
    score: { type: "integer", minimum: 1, maximum: 5 },
  }, required: ["files"], additionalProperties: false };
  const original = structuredClone(schema);
  const toolSchema = { type: "object", properties: { files: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } } } };
  for (const modelId of ["gemini-3.5-flash", "gemini-2.5-flash"]) {
    const fake = client([response([{ text: '{"files":[]}' }])]);
    const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
    await provider.complete(request({ modelId, tools: [{ name: "inspect", inputSchema: toolSchema }], responseFormat: { type: "jsonSchema", schema } }));
    const config = fake.calls[0]!.config;
    const wire = modelId === "gemini-2.5-flash" ? config.tools[0].functionDeclarations[1].parametersJsonSchema : config.responseJsonSchema;
    assert.deepEqual(wire.properties.files, {
      type: "array", description: "Submitted files.\nThis array must contain at least 0 items and no more than 400 items.",
      items: original.properties.files.items,
    });
    assert.deepEqual(wire.properties.score, original.properties.score);
    assert.deepEqual(wire.required, original.required);
    assert.equal(wire.additionalProperties, false);
    assert.deepEqual(config.tools[0].functionDeclarations[0].parametersJsonSchema, toolSchema);
    assert.deepEqual(schema, original, "the host validator still receives its full original contract");
  }
});

test("output schema normalization reaches nested, composed and referenced schemas without interpreting literal data", async () => {
  const bounded = () => ({ type: "array", minItems: 2, maxItems: 2, items: { type: "string" } });
  const literal = { minItems: 7, maxItems: 9, not: {}, if: {}, oneOf: [], contains: {}, properties: { nested: { minItems: 3, maxItems: 4 } } };
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      minItems: { type: "string", const: "maxItems" },
      maxItems: { type: "integer", minimum: 1, maximum: 10 },
      nested: { type: "array", maxItems: 3, items: bounded() },
      composed: { anyOf: [bounded(), { type: "null" }] },
      reference: { $ref: "#/$defs/bounded" },
      tuple: { type: "array", prefixItems: [bounded()] },
      literal: { type: "object", enum: [literal], default: literal, const: literal },
    },
    $defs: { bounded: bounded() },
    allOf: [{ properties: { composedAgain: { anyOf: [bounded(), { type: "string" }] } } }],
    additionalProperties: bounded(),
  };
  const original = structuredClone(schema);
  const fake = client([response([{ text: "{}" }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  await provider.complete(request({ responseFormat: { type: "jsonSchema", schema } }));
  const wire = fake.calls[0]!.config.responseJsonSchema;
  const exactArray = { type: "array", description: "This array must contain exactly 2 items.", items: { type: "string" } };
  assert.deepEqual(wire.properties.nested, { type: "array", description: "This array must contain no more than 3 items.", items: exactArray });
  assert.deepEqual(wire.properties.composed.anyOf[0], exactArray);
  assert.deepEqual(wire.properties.tuple.prefixItems[0], exactArray);
  assert.deepEqual(wire.$defs.bounded, exactArray);
  assert.deepEqual(wire.allOf[0].properties.composedAgain.anyOf[0], exactArray);
  assert.deepEqual(wire.additionalProperties, exactArray);
  assert.deepEqual(wire.properties.reference, original.properties.reference);
  assert.deepEqual(wire.properties.minItems, original.properties.minItems);
  assert.deepEqual(wire.properties.maxItems, original.properties.maxItems);
  assert.deepEqual(wire.properties.literal, original.properties.literal);
  assert.equal(wire.$schema, original.$schema);
  assert.deepEqual(schema, original);
});

test("nonmonotonic schema contexts retain all bounds including their shared reference targets", async () => {
  const contexts: JsonObject[] = [
    { not: { $ref: "#/$defs/bounded" } },
    { if: { $ref: "#/$defs/bounded" }, then: { maxItems: 2 }, else: { minItems: 3 } },
    { oneOf: [{ $ref: "#/$defs/bounded" }, { type: "array", maxItems: 10 }] },
    { contains: { $ref: "#/$defs/bounded" }, maxContains: 1 },
    { maxContains: 1 },
    { allOf: [{ $ref: "#/$defs/bounded" }], unevaluatedItems: false },
    { anyOf: [{ $ref: "#/$defs/bounded" }], unevaluatedProperties: false },
  ];
  for (const context of contexts) {
    const schema = { type: "object", properties: { result: context },
      $defs: { bounded: { type: "array", maxItems: 400, items: { type: "string" } } } };
    const original = structuredClone(schema);
    const fake = client([response([{ text: "{}" }])]);
    const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
    await provider.complete(request({ responseFormat: { type: "jsonSchema", schema } }));
    assert.deepEqual(fake.calls[0]!.config.responseJsonSchema, original);
    assert.deepEqual(schema, original);
  }
});

test("parallel tool calls retain signed Parts and opaque IDs byte-for-byte over a second turn", async () => {
  const parts = [{ text: "Checking.", thoughtSignature: "opaque-text-signature" },
    { functionCall: { name: "lookup", args: { n: 1 }, id: "call-a" }, thoughtSignature: "opaque-call-signature" },
    { functionCall: { name: "lookup", args: { n: 2 } } }];
  const fake = client([response(parts), response([{ text: "done" }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  const tools = [{ name: "lookup", inputSchema: { type: "object", properties: { n: { type: "integer" } } } }];
  const first = await provider.complete(request({ tools }));
  assert.equal(first.stopReason, "tool_use");
  const calls = first.content.filter((part) => part.type === "tool_use");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.id, calls[1]!.id);
  await provider.complete(request({ tools, messages: [...request().messages, { role: "assistant", content: first.content }, {
    role: "user", content: calls.map((call, i) => ({ type: "tool_result", toolUseId: call.id, content: [{ type: "text", text: `result ${i}` }], ...(i === 1 ? { isError: true } : {}) })),
  }] }));
  assert.deepEqual(fake.calls[1]!.contents[1], { role: "model", parts });
  assert.deepEqual(fake.calls[1]!.contents[2].parts, [
    { functionResponse: { name: "lookup", id: "call-a", response: { output: "result 0" } } },
    { functionResponse: { name: "lookup", response: { error: "result 1" } } },
  ]);
});

test("signature-only parts survive with no transcript, and summaries are opt-in", async () => {
  const fake = client([response([{ thoughtSignature: "encrypted" }, { text: "answer" }]), response([{ thought: true, text: "summary", thoughtSignature: "opaque" }, { text: "answer" }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  const first = await provider.complete(request());
  assert.deepEqual(first.content[0], { type: "thinking", text: "", metadata: { gemini: { part: { thoughtSignature: "encrypted" } } } });
  const second = await provider.complete(request({ providerOptions: { gemini: { includeThoughts: true } } }));
  assert.equal(second.content[0]!.type, "thinking");
  assert.equal("text" in second.content[0]! && second.content[0].text, "summary");
});

test("2.5 structured results use a collision-safe function; mixed host calls and validation retries preserve signatures", async () => {
  const schema = { type: "object", properties: { result: { type: "string" } }, required: ["result"] };
  const finalName = "brainstorm_final_result_1";
  const mixed = [
    { functionCall: { name: "brainstorm_final_result", args: { query: "check" }, id: "host" }, thoughtSignature: "host-signature" },
    { functionCall: { name: finalName, args: { result: "premature" }, id: "result" }, thoughtSignature: "result-signature" },
  ];
  const final = { functionCall: { name: finalName, args: {}, id: "invalid" }, thoughtSignature: "invalid-signature" };
  const fake = client([response(mixed), response([final]), response([{ functionCall: { name: finalName, args: { result: "corrected" } }, thoughtSignature: "final-signature" }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  const base = request({ modelId: "gemini-2.5-flash", tools: [{ name: "brainstorm_final_result", inputSchema: { type: "object" } }], responseFormat: { type: "jsonSchema", schema } });
  const first = await provider.complete(base);
  assert.equal(first.stopReason, "tool_use");
  assert.equal(first.content.filter((part) => part.type === "tool_use").length, 1);
  assert.equal(fake.calls[0]!.config.responseMimeType, undefined);
  assert.deepEqual(fake.calls[0]!.config.tools[0].functionDeclarations[1].parametersJsonSchema, schema);
  const messages = [...base.messages, { role: "assistant" as const, content: first.content }, { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: "host", isError: true, content: [{ type: "text" as const, text: "Check failed." }] }] }];
  const second = await provider.complete({ ...base, messages });
  assert.equal(second.stopReason, "end_turn");
  assert.equal(second.content[0]!.type, "text");
  assert.equal("text" in second.content[0]! && second.content[0].text, "{}");
  assert.deepEqual(fake.calls[1]!.contents[1].parts, mixed);
  assert.deepEqual(fake.calls[1]!.contents[2].parts.map((part: Wire) => part.functionResponse.name), ["brainstorm_final_result", finalName]);
  const third = await provider.complete({ ...base, messages: [...messages, { role: "assistant", content: second.content }, userMessage("Validation failed: result is required. Correct the result.")] });
  assert.equal("text" in third.content[0]! && third.content[0].text, '{"result":"corrected"}');
  assert.deepEqual(fake.calls[2]!.contents[3].parts, [final]);
  assert.equal(fake.calls[2]!.contents[4].parts[0].functionResponse.id, "invalid");
  assert.match(fake.calls[2]!.contents[4].parts[1].text, /Validation failed/);
});

test("a reserved-looking function is ordinary unless this request declared its internal result tool", async () => {
  const fake = client([response([{ functionCall: { name: "brainstorm_final_result", args: { result: "x" } } }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  const out = await provider.complete(request());
  assert.equal(out.content[0]!.type, "tool_use");
  assert.equal(out.stopReason, "tool_use");
});

test("forced tool turns omit JSON MIME settings rejected by the Gemini API", async () => {
  const fake = client([response([{ functionCall: { name: "lookup", args: {} } }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  await provider.complete(request({ tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    toolChoice: { type: "tool", name: "lookup" }, responseFormat: { type: "jsonSchema", schema: { type: "object" } } }));
  assert.equal(fake.calls[0]!.config.toolConfig.functionCallingConfig.mode, "ANY");
  assert.equal(fake.calls[0]!.config.responseMimeType, undefined);
  assert.equal(fake.calls[0]!.config.responseJsonSchema, undefined);
});

test("known thinking profiles constrain levels and budgets; unknown controls are unavailable", async () => {
  const fake = client([response([{ text: "done" }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  assert.equal(geminiModelProfile("gemini-future"), undefined);
  assert.deepEqual(geminiModelProfile("gemini-3.5-flash-lite")?.thinkingLevels, ["minimal", "low", "medium", "high"]);
  assert.deepEqual(geminiModelProfile("gemini-3.8-flash")?.thinkingLevels, ["low", "medium", "high"]);
  for (const [modelId, controls] of [
    ["gemini-3.8-flash", { thinkingLevel: "minimal" }], ["gemini-2.5-pro", { thinkingBudget: 0 }],
    ["gemini-future", { thinkingLevel: "high" }], ["gemini-2.5-flash", { thinkingLevel: "low" }],
    ["gemini-3.8-flash", { thinkingLevel: "high", thinkingBudget: -1 }],
  ] as const) await assert.rejects(provider.complete(request({ modelId, providerOptions: { gemini: controls } })), { category: "validation" });
  await provider.complete(request({ modelId: "gemini-2.5-flash", providerOptions: { gemini: { thinkingBudget: 0 } } }));
  assert.deepEqual(fake.calls[0]!.config.thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
});

test("models without documented thinking support receive no thinking configuration", async () => {
  const fake = client([response([{ text: "done" }]), response([{ text: "done" }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  await provider.complete(request({ modelId: "gemini-2.0-flash", providerOptions: { gemini: { includeThoughts: false } } }));
  await provider.complete(request({ modelId: "gemini-new-private", providerOptions: { gemini: { includeThoughts: true } } }));
  for (const call of fake.calls) assert.equal(Object.hasOwn(call.config, "thinkingConfig"), false);
  await assert.rejects(provider.complete(request({ modelId: "gemini-new-private", providerOptions: { gemini: { thinkingBudget: 0 } } })), { category: "validation" });
});

test("older and unknown models keep structured tools without assuming native JSON compatibility", async () => {
  const fake = client([response([{ functionCall: { name: "brainstorm_final_result", args: { ok: true } } }]),
    response([{ functionCall: { name: "brainstorm_final_result", args: { ok: true } } }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  for (const modelId of ["gemini-2.0-flash", "gemini-new-private"]) {
    const output = await provider.complete(request({ modelId, tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      responseFormat: { type: "jsonSchema", schema } }));
    assert.equal(output.stopReason, "end_turn");
    assert.equal("text" in output.content[0]! && output.content[0].text, '{"ok":true}');
  }
  for (const call of fake.calls) {
    assert.equal(call.config.responseMimeType, undefined);
    assert.deepEqual(call.config.tools[0].functionDeclarations[1].parametersJsonSchema, schema);
  }
});

test("plain JSON with older-model tools permits all JSON values through the host parser", async () => {
  const fake = client([response([{ text: "[1,true,null]" }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  const output = await provider.complete(request({ modelId: "gemini-2.5-flash", tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    responseFormat: { type: "json" } }));
  assert.equal(output.stopReason, "end_turn");
  assert.equal("text" in output.content[0]! && output.content[0].text, "[1,true,null]");
  assert.equal(fake.calls[0]!.config.responseMimeType, undefined);
  assert.equal(fake.calls[0]!.config.tools[0].functionDeclarations.length, 1);
  assert.match(fake.calls[0]!.config.systemInstruction, /return only valid JSON/);
});

test("finish reasons do not mistake exhausted, blocked or malformed responses for success", async () => {
  const fake = client([
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }], usageMetadata: { thoughtsTokenCount: 64000 } },
    { promptFeedback: { blockReason: "SAFETY" } },
    { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL", content: { parts: [] } }] },
    { candidates: [{ finishReason: "CONTINUATION", content: { parts: [{ text: "partial" }] } }], continuationToken: "opaque" },
    {},
  ]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  for (const expected of ["max_tokens", "content_filter", "error", "max_tokens"]) assert.equal((await provider.complete(request())).stopReason, expected);
  await assert.rejects(provider.complete(request()), { category: "server", transient: true });
});

test("rate limits pace the shared queue using service RetryInfo and sanitize raw SDK errors", async () => {
  const blocked: number[] = []; const acquired: string[] = [];
  const coordinator: RequestCoordinator = { acquire: async (priority) => { acquired.push(priority!); }, observe() {}, block: (until) => { blocked.push(until); } };
  const error = Object.assign(new Error(JSON.stringify({ error: { message: "secret-key-sample", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12.5s" }] } })), { status: 429 });
  const fake = client([error]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client, coordinator });
  const before = Date.now();
  await assert.rejects(provider.complete(request({ metadata: { dispatchPriority: "high" } })), (err: unknown) => {
    assert.ok(err instanceof GeminiProviderError); assert.equal(err.retryAfterMs, 12500); assert.equal(err.transient, true);
    assert.equal(err.message.includes("secret-key-sample"), false); return true;
  });
  assert.deepEqual(acquired, ["high"]);
  assert.ok(blocked[0]! >= before + 12500);
});

test("pre-abort prevents dispatch and abort during an uncooperative call returns promptly", async () => {
  let calls = 0;
  const fake = client();
  const hanging: GeminiClient = { models: { ...fake.client.models, generateContent: async () => { calls++; return new Promise(() => {}); } } };
  const provider = new GeminiModelProvider({ apiKey: "unused", client: hanging });
  await assert.rejects(provider.complete(request(), { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(calls, 0);
  const abort = new AbortController();
  const pending = provider.complete(request(), { signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("discovery paginates, normalizes IDs and excludes nontext endpoints without inventing profiles", async () => {
  const fake = client(); let pages = 0;
  fake.client.models.list = async () => (async function* () {
    pages++;
    for (const name of ["gemini-3.8-flash", "gemini-3.8-flash-image", "gemini-live", "gemini-embedding", "gemini-robotics", "gemini-3.5-transcribe", "gemini-nano-banana-2.1", "deep-research-pro"]) yield { name: `models/${name}`, supportedActions: ["generateContent"] };
    pages++;
    yield { name: "models/gemini-future", displayName: "Future", supportedActions: ["generateContent"], inputTokenLimit: 1000, outputTokenLimit: 100 };
    yield { name: "models/gemini-embed", supportedActions: ["embedContent"] };
  })();
  const models = await discoverGeminiModels({ apiKey: "unused", client: fake.client });
  assert.equal(pages, 2);
  assert.deepEqual(models.map((model) => model.id), ["gemini-3.8-flash", "gemini-future"]);
  assert.equal(models[1]!.profile, undefined);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  await provider.listModels(); const before = pages; await provider.listModels(); assert.equal(pages, before);
});

test("tool choice, base64 inputs and invalid tool replies are mapped explicitly", async () => {
  const fake = client([response([{ text: "done" }])]);
  const provider = new GeminiModelProvider({ apiKey: "unused", client: fake.client });
  await provider.complete(request({ messages: [{ role: "user", content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "abc" } }] }],
    tools: [{ name: "inspect", description: "Inspect data", inputSchema: { type: "object" } }], toolChoice: { type: "tool", name: "inspect" } }));
  assert.deepEqual(fake.calls[0]!.config.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["inspect"] } });
  assert.deepEqual(fake.calls[0]!.contents[0].parts[0], { inlineData: { mimeType: "image/png", data: "abc" } });
  await assert.rejects(provider.complete(request({ messages: [{ role: "user", content: [{ type: "tool_result", toolUseId: "missing", content: [] }] }] })), { category: "validation" });
});

test("actual official SDK sends schema, suppressed summaries and opaque signatures to a local HTTP fixture", async (t) => {
  const bodies: Wire[] = [];
  const server = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response([{ text: '{"ok":true}', thoughtSignature: "test-signature" }])));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const provider = new GeminiModelProvider({ apiKey: "test-key", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  const first = await provider.complete(request({ responseFormat: { type: "jsonSchema", schema: { type: "object", properties: { ok: { type: "boolean" } } } } }));
  await provider.complete(request({ messages: [...request().messages, { role: "assistant", content: first.content }, userMessage("Continue.")] }));
  assert.equal(bodies[0]!.generationConfig.thinkingConfig.includeThoughts, false);
  assert.equal(bodies[0]!.generationConfig.responseJsonSchema.type, "object");
  assert.deepEqual(bodies[1]!.contents[1].parts[0], { text: '{"ok":true}', thoughtSignature: "test-signature" });
});
