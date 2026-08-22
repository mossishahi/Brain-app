import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutionContext,
  AgentTask,
  CallOptions,
  JsonObject,
  JsonValue,
  ModelCapabilities,
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolResult,
} from "@brainstorm-agentic/core";
import {
  FixedModelRouteResolver,
  ToolLoopAgentExecutor,
  ToolRegistry,
} from "../src/index.js";

const capabilities: ModelCapabilities = {
  toolUse: true,
  parallelToolUse: true,
  imageInput: false,
  jsonOutput: true,
  jsonSchemaOutput: true,
  thinking: false,
  systemPrompt: true,
  stopSequences: true,
};

const context: AgentExecutionContext = {
  runId: "run-test",
  nodePath: "root/test",
};

class FakeProvider implements ModelProvider {
  public readonly providerId = "fake";
  public readonly requests: ModelRequest[] = [];
  public readonly options: Array<CallOptions | undefined> = [];

  public constructor(
    private readonly completeImpl: (
      request: ModelRequest,
      call: number,
      options?: CallOptions,
    ) => ModelResponse | Promise<ModelResponse>,
  ) {}

  public async listModels(): Promise<readonly ModelDescriptor[]> {
    return [{ modelId: "fake-model", capabilities }];
  }

  public async getCapabilities(
    modelId: string,
  ): Promise<ModelCapabilities | undefined> {
    return modelId === "fake-model" ? capabilities : undefined;
  }

  public async complete(
    request: ModelRequest,
    options?: CallOptions,
  ): Promise<ModelResponse> {
    this.requests.push(request);
    this.options.push(options);
    return this.completeImpl(request, this.requests.length, options);
  }
}

function response(
  content: ModelResponse["content"],
  usage: ModelResponse["usage"] = { inputTokens: 0, outputTokens: 0 },
): ModelResponse {
  return {
    providerId: "fake",
    modelId: "fake-model",
    content,
    stopReason: content.some((block) => block.type === "tool_use")
      ? "tool_use"
      : "end_turn",
    usage,
  };
}

function task(
  value: Omit<AgentTask, "kind"> & { readonly kind?: string },
): AgentTask {
  return {
    ...value,
    kind: value.kind ?? "test",
  };
}

function defineTool(
  name: string,
  execute: Tool["execute"],
): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      inputSchema: { type: "object" },
    },
    execute,
  };
}

function isJsonObjectValue(
  value: JsonValue,
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("maps input deterministically, runs safe tools in parallel, and accumulates usage", async () => {
  const provider = new FakeProvider((_request, call) =>
    call === 1
      ? response(
          [
            {
              type: "tool_use",
              id: "call-a",
              name: "lookup-a",
              input: { value: 1 },
            },
            {
              type: "tool_use",
              id: "call-b",
              name: "lookup-b",
              input: { value: 2 },
            },
          ],
          { inputTokens: 2, outputTokens: 1 },
        )
      : response(
          [{ type: "text", text: '{"answer":3}' }],
          { inputTokens: 1, outputTokens: 2 },
        ),
  );

  let active = 0;
  let maximumActive = 0;
  const execute = async (input: JsonValue): Promise<ToolResult> => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return { output: input };
  };
  const registry = new ToolRegistry()
    .register(defineTool("lookup-a", execute), { parallelSafe: true })
    .register(defineTool("lookup-b", execute), { parallelSafe: true });
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: registry,
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: {
        type: "jsonSchema",
        schema: {
          type: "object",
          required: ["answer"],
        },
      },
    }),
    outputValidator: {
      validate(value) {
        return (
          isJsonObjectValue(value) &&
          value.answer === 3
        )
          ? { success: true, value }
          : { success: false, issues: ["answer must equal 3"] };
      },
    },
  });

  const result = await executor.execute(
    task({
      taskId: "parallel-task",
      input: { z: 2, a: 1 },
      tools: ["lookup-a", "lookup-b"],
    }),
    context,
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.deepEqual(result.output, { answer: 3 });
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 3 });
  assert.equal(maximumActive, 2);
  assert.deepEqual(
    provider.requests[0]?.messages[0]?.content,
    [{ type: "text", text: '{"a":1,"z":2}' }],
  );
  assert.deepEqual(
    provider.requests[0]?.tools?.map(({ name }) => name),
    ["lookup-a", "lookup-b"],
  );
  assert.deepEqual(
    provider.requests[1]?.messages.at(-1)?.content.map((block) => ({
      type: block.type,
      toolUseId: block.type === "tool_result" ? block.toolUseId : undefined,
    })),
    [
      { type: "tool_result", toolUseId: "call-a" },
      { type: "tool_result", toolUseId: "call-b" },
    ],
  );
});

test("rich tool results pass image blocks through and progress carries the target hint", async () => {
  const provider = new FakeProvider((_request, call) =>
    call === 1
      ? response([
          {
            type: "tool_use",
            id: "call-img",
            name: "attachment_read",
            input: { path: "/store/figure.png" },
          },
        ])
      : response([{ type: "text", text: "done" }]),
  );
  const registry = new ToolRegistry().register(
    defineTool("attachment_read", async () => ({
      output: "image figure.png",
      blocks: [
        {
          type: "image" as const,
          source: {
            kind: "base64" as const,
            mediaType: "image/png",
            data: "aGk=",
          },
        },
      ],
    })),
  );
  const progress: string[] = [];
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: registry,
    modelRouteResolver: new FixedModelRouteResolver({ modelId: "fake-model" }),
  });
  const result = await executor.execute(
    task({
      taskId: "image-task",
      input: "read the figure",
      tools: ["attachment_read"],
    }),
    {
      ...context,
      reportProgress: (update) => progress.push(update.message),
    },
  );
  assert.equal(result.status, "ok");
  const toolResults = provider.requests[1]?.messages.at(-1)?.content;
  assert.equal(toolResults?.length, 1);
  const block = toolResults![0]!;
  assert.ok(block.type === "tool_result");
  assert.deepEqual(block.type === "tool_result" ? block.content : [], [
    {
      type: "image",
      source: { kind: "base64", mediaType: "image/png", data: "aGk=" },
    },
  ]);
  assert.ok(
    progress.some((message) =>
      message.includes("attachment_read — /store/figure.png"),
    ),
    `progress must name the accessed file, got: ${JSON.stringify(progress)}`,
  );
});

test("never executes a tool outside AgentTask.tools", async () => {
  let forbiddenExecutions = 0;
  const provider = new FakeProvider((_request, call) =>
    call === 1
      ? response([
          {
            type: "tool_use",
            id: "forbidden-call",
            name: "forbidden",
            input: {},
          },
        ])
      : response([{ type: "text", text: "handled" }]),
  );
  const registry = new ToolRegistry()
    .register(
      defineTool("allowed", async () => ({ output: "ok" })),
    )
    .register(
      defineTool("forbidden", async () => {
        forbiddenExecutions += 1;
        return { output: "should not run" };
      }),
    );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: registry,
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
    }),
  });

  const result = await executor.execute(
    task({
      taskId: "allowlist-task",
      input: "Try a tool.",
      tools: ["allowed"],
    }),
    context,
  );

  assert.equal(result.status, "ok");
  assert.equal(forbiddenExecutions, 0);
  assert.deepEqual(
    provider.requests[0]?.tools?.map(({ name }) => name),
    ["allowed"],
  );
  const finalMessage = provider.requests[1]?.messages.at(-1);
  assert.equal(finalMessage?.content[0]?.type, "tool_result");
  if (finalMessage?.content[0]?.type === "tool_result") {
    assert.equal(finalMessage.content[0].isError, true);
    assert.equal(finalMessage.content[0].toolUseId, "forbidden-call");
  }
});

test("separates transient retries from output-validation retries", async () => {
  const delays: number[] = [];
  const provider = new FakeProvider((_request, call) => {
    if (call === 1) {
      throw Object.assign(new Error("try again"), {
        category: "rate_limit",
        transient: true,
      });
    }
    return call === 2
      ? response(
          [{ type: "text", text: '{"answer":"wrong"}' }],
          { inputTokens: 4, outputTokens: 2 },
        )
      : response(
          [{ type: "text", text: '{"answer":42}' }],
          { inputTokens: 3, outputTokens: 1 },
        );
  });
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: {
        type: "jsonSchema",
        schema: { type: "object" },
      },
    }),
    retry: {
      maxTransientRetries: 1,
      maxValidationRetries: 1,
      initialDelayMs: 7,
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
    outputValidator: {
      validate(value) {
        return (
          isJsonObjectValue(value) &&
          value.answer === 42
        )
          ? { success: true, value }
          : { success: false, issues: ["answer must be 42"] };
      },
    },
  });

  const result = await executor.execute(
    task({
      taskId: "retry-task",
      input: "Return the answer.",
    }),
    context,
  );

  assert.deepEqual(delays, [7]);
  assert.equal(provider.requests.length, 3);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.deepEqual(result.output, { answer: 42 });
    assert.deepEqual(result.usage, {
      inputTokens: 7,
      outputTokens: 3,
    });
    assert.equal(result.metadata?.validationRetries, 1);
  }
  const feedback = provider.requests[2]?.messages.at(-1)?.content[0];
  assert.equal(feedback?.type, "text");
  if (feedback?.type === "text") {
    assert.match(feedback.text, /answer must be 42/);
  }
});

test("passes CallOptions.signal and propagates cancellation from tools", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const provider = new FakeProvider(() =>
    response([
      {
        type: "tool_use",
        id: "slow-call",
        name: "slow",
        input: {},
      },
    ]),
  );
  const registry = new ToolRegistry().register(
    defineTool("slow", async (_input, toolContext) => {
      markStarted();
      return await new Promise<ToolResult>((_resolve, reject) => {
        toolContext.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    }),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: registry,
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
    }),
  });
  const controller = new AbortController();
  const execution = executor.execute(
    task({
      taskId: "cancel-task",
      input: "Use the slow tool.",
      tools: ["slow"],
    }),
    { ...context, signal: controller.signal },
  );
  await started;
  assert.equal(provider.options[0]?.signal, controller.signal);
  controller.abort("test cancellation");

  await assert.rejects(
    execution,
    (error: Error) => error.name === "AbortError",
  );
});

test("returns an error result when the bounded loop is exhausted", async () => {
  const provider = new FakeProvider((_request, call) =>
    response([
      {
        type: "tool_use",
        id: `call-${call}`,
        name: "again",
        input: {},
      },
    ]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry().register(
      defineTool("again", async () => ({ output: "continue" })),
    ),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
    }),
    maxTurns: 2,
  });

  const result = await executor.execute(
    task({
      taskId: "bounded-task",
      input: "Keep calling.",
      tools: ["again"],
    }),
    context,
  );
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.name, "MaxTurnsExceededError");
  }
  assert.equal(provider.requests.length, 2);
});

test("stepwise tasks record ordered submit_step calls, inject the chain, and capture traces", async () => {
  const provider = new FakeProvider((_request, call) =>
    call === 1
      ? response([
          {
            type: "thinking",
            text: "planning the chain",
            metadata: { signature: "sig" },
          },
          // Out of order: must be rejected without being recorded.
          {
            type: "tool_use",
            id: "s-2-early",
            name: "submit_step",
            input: { index: 2, text: "out of order" },
          },
          {
            type: "tool_use",
            id: "s-1",
            name: "submit_step",
            input: { index: 1, text: "step one" },
          },
        ])
      : call === 2
        ? response([
            {
              type: "tool_use",
              id: "s-2",
              name: "submit_step",
              input: { index: 2, text: "step two" },
            },
            {
              type: "tool_use",
              id: "s-3",
              name: "submit_step",
              input: { index: 3, text: "step three" },
            },
          ])
        : response([{ type: "text", text: '{"title":"done"}' }]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: { type: "json" },
    }),
  });

  const result = await executor.execute(
    task({
      taskId: "stepwise-1",
      input: "chain please",
      metadata: {
        stepwise: { tool: "submit_step", field: "cot", parts: false, count: 3 },
      },
    }),
    context,
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  assert.ok(isJsonObjectValue(result.output));
  assert.equal(result.output.title, "done");
  assert.deepEqual(result.output.cot, ["step one", "step two", "step three"]);

  // The virtual tool definition is offered to the model.
  assert.ok(
    provider.requests[0]?.tools?.some(
      (tool) => tool.name === "submit_step",
    ),
  );
  // The out-of-order call was answered with an error tool result.
  const secondTurn = provider.requests[1]?.messages.at(-1);
  const rejected = secondTurn?.content.find(
    (block) =>
      block.type === "tool_result" && block.toolUseId === "s-2-early",
  );
  assert.ok(
    rejected !== undefined &&
      rejected.type === "tool_result" &&
      rejected.isError === true,
  );

  // Thinking segments and step turns are surfaced for artifact capture.
  assert.deepEqual(result.metadata?.thinkingSegments, [
    { turn: 1, text: "planning the chain" },
  ]);
  assert.deepEqual(result.metadata?.stepTurns, [
    { index: 1, turn: 1 },
    { index: 2, turn: 2 },
    { index: 3, turn: 2 },
  ]);
});

test("a sparse stepwise task submits only rewritten steps, positions and all", async () => {
  const provider = new FakeProvider((_request, call) =>
    call === 1
      ? response([
          // Ascending, but not consecutive and not starting at 1: exactly
          // what a repair touching steps 2 and 5 looks like.
          {
            type: "tool_use",
            id: "s-2",
            name: "submit_step",
            input: { index: 2, text: "rewritten step two" },
          },
          // Backwards: refused without being recorded.
          {
            type: "tool_use",
            id: "s-1-late",
            name: "submit_step",
            input: { index: 1, text: "too late for step one" },
          },
          {
            type: "tool_use",
            id: "s-5",
            name: "submit_step",
            input: { index: 5, text: "rewritten step five" },
          },
        ])
      : response([{ type: "text", text: '{"title":"revised"}' }]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: { type: "json" },
    }),
  });

  const result = await executor.execute(
    task({
      taskId: "sparse-1",
      input: "repair please",
      metadata: {
        stepwise: { tool: "submit_step", field: "steps", parts: false, count: 6, sparse: true },
      },
    }),
    context,
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  assert.ok(isJsonObjectValue(result.output));
  assert.deepEqual(
    result.output.steps,
    [
      { index: 2, text: "rewritten step two" },
      { index: 5, text: "rewritten step five" },
    ],
    "each rewritten step keeps its position; the host carries the rest",
  );
  const secondTurn = provider.requests[1]?.messages.at(-1);
  const refused = secondTurn?.content.find(
    (block) => block.type === "tool_result" && block.toolUseId === "s-1-late",
  );
  assert.ok(
    refused !== undefined && refused.type === "tool_result" && refused.isError === true,
    "a backwards index is refused: applying it positionally would be ambiguous",
  );
});

test("a sparse revision that rewrites nothing gets corrective feedback, then fails closed", async () => {
  const provider = new FakeProvider(() =>
    response([{ type: "text", text: '{"title":"nothing changed"}' }]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: { type: "json" },
    }),
    retry: { maxValidationRetries: 1 },
  });

  const result = await executor.execute(
    task({
      taskId: "sparse-2",
      input: "repair please",
      metadata: {
        stepwise: { tool: "submit_step", field: "steps", parts: false, count: 4, sparse: true },
      },
    }),
    context,
  );

  assert.equal(result.status, "error");
  if (result.status !== "error") throw new Error("unreachable");
  assert.match(result.error.message, /At least one rewritten step/);
  assert.equal(provider.requests.length, 2);
});

test("a stepwise task that skips submissions gets corrective feedback, then fails closed", async () => {
  const provider = new FakeProvider(() =>
    response([{ type: "text", text: '{"title":"no steps"}' }]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: { type: "json" },
    }),
    retry: { maxValidationRetries: 1 },
  });

  const result = await executor.execute(
    task({
      taskId: "stepwise-2",
      input: "chain please",
      metadata: {
        stepwise: { tool: "submit_step", field: "cot", parts: false, count: 2 },
      },
    }),
    context,
  );

  assert.equal(result.status, "error");
  if (result.status !== "error") throw new Error("unreachable");
  assert.match(result.error.message, /2 steps must be submitted/);
  // One corrective feedback round-trip happened before failing closed.
  assert.equal(provider.requests.length, 2);
});

/**
 * The output contract the runtime delivers for a four-part chain. The
 * stepwise field is stripped out of the schema — these tool calls are what
 * fills it — so the artifact schema NAME is what tells the executor which
 * chain form to ask for.
 */
const partsSchema = {
  name: "brainIdeaParts",
  schema: {
    type: "object" as const,
    properties: { output: { type: "object" } },
  },
};

function partsCall(id: string, index: number, prefix: string): {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
} {
  return {
    type: "tool_use",
    id,
    name: "submit_step",
    input: {
      index,
      part1: `${prefix} a`,
      part2: `${prefix} b`,
      part3: `${prefix} c`,
      part4: `${prefix} d`,
    },
  };
}

test("a four-part chain task asks for four parts and assembles them as step objects", async () => {
  const provider = new FakeProvider((_request, call) =>
    call === 1
      ? response([
          // Says nothing at all: refused, exactly as an empty paragraph is.
          {
            type: "tool_use",
            id: "s-empty",
            name: "submit_step",
            input: { index: 1, part1: " ", part2: "", part3: "", part4: "" },
          },
          partsCall("s-1", 1, "one"),
        ])
      : call === 2
        ? response([
            // An empty PART is legal: the parts are a size discipline, and a
            // refusal here would spend a turn enforcing a soft limit.
            {
              type: "tool_use",
              id: "s-2",
              name: "submit_step",
              input: { index: 2, part1: "two a", part2: "", part3: "", part4: "" },
            },
          ])
        : response([{ type: "text", text: '{"title":"done"}' }]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: { type: "json" },
    }),
  });

  const result = await executor.execute(
    task({
      taskId: "parts-1",
      input: "chain please",
      outputSchema: partsSchema,
      metadata: {
        stepwise: { tool: "submit_step", field: "cot", parts: true, count: 2 },
      },
    }),
    context,
  );

  const definition = provider.requests[0]?.tools?.find(
    (tool) => tool.name === "submit_step",
  );
  assert.deepEqual(definition?.inputSchema.required, [
    "index",
    "part1",
    "part2",
    "part3",
    "part4",
  ]);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  assert.ok(isJsonObjectValue(result.output));
  assert.deepEqual(result.output.cot, [
    { part1: "one a", part2: "one b", part3: "one c", part4: "one d" },
    { part1: "two a", part2: "", part3: "", part4: "" },
  ]);
  // The empty submission was answered with an error and left no gap: the
  // step it named was still open on the next call.
  const secondTurn = provider.requests[1]?.messages.at(-1);
  const refused = secondTurn?.content.find(
    (block) => block.type === "tool_result" && block.toolUseId === "s-empty",
  );
  assert.ok(
    refused !== undefined && refused.type === "tool_result" && refused.isError === true,
  );
});

test("a sparse four-part revision keeps each rewritten step's position", async () => {
  const provider = new FakeProvider((_request, call) =>
    call === 1
      ? response([partsCall("s-2", 2, "two"), partsCall("s-5", 5, "five")])
      : response([{ type: "text", text: '{"title":"revised"}' }]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: { type: "json" },
    }),
  });

  const result = await executor.execute(
    task({
      taskId: "parts-sparse-1",
      input: "repair please",
      outputSchema: { ...partsSchema, name: "redevelopmentPatchParts" },
      metadata: {
        stepwise: { tool: "submit_step", field: "steps", parts: true, count: 6, sparse: true },
      },
    }),
    context,
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  assert.ok(isJsonObjectValue(result.output));
  assert.deepEqual(
    result.output.steps,
    [
      { index: 2, part1: "two a", part2: "two b", part3: "two c", part4: "two d" },
      { index: 5, part1: "five a", part2: "five b", part3: "five c", part4: "five d" },
    ],
    "a rewritten step replaces the whole step, so all four parts ride with its position",
  );
});

test("the spec decides the chain form, whatever the schema is called and whatever it shows", async () => {
  const provider = new FakeProvider((_request, call) =>
    call === 1
      ? response([partsCall("s-1", 1, "one")])
      : response([{ type: "text", text: '{"title":"done"}' }]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      responseFormat: { type: "json" },
    }),
  });

  // Deliberately starved of every other witness: a name that carries no
  // "Parts" suffix, and an array with no item schema to read a shape off.
  // The spec alone says four parts, and that has to be enough — a chain form
  // whose name broke the convention used to transport silently as strings.
  const result = await executor.execute(
    task({
      taskId: "parts-spec-1",
      input: "chain please",
      outputSchema: {
        name: "somethingElse",
        schema: {
          type: "object",
          properties: { cot: { type: "array" } },
        },
      },
      metadata: {
        stepwise: { tool: "submit_step", field: "cot", parts: true, count: 1 },
      },
    }),
    context,
  );

  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  assert.ok(isJsonObjectValue(result.output));
  assert.deepEqual(result.output.cot, [
    { part1: "one a", part2: "one b", part3: "one c", part4: "one d" },
  ]);
});

test("rate limits get their own retry budget and honor the declared retry-after", async () => {
  const delays: number[] = [];
  const provider = new FakeProvider((_request, call) => {
    if (call <= 3) {
      throw Object.assign(new Error("429 rate_limit_error"), {
        category: "rate_limit",
        status: 429,
        retryAfterMs: 5_000,
        transient: true,
      });
    }
    return response([{ type: "text", text: "recovered" }]);
  });
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({ modelId: "fake-model" }),
    retry: {
      // Zero generic retries proves the rate-limit budget is its own lane.
      maxTransientRetries: 0,
      initialDelayMs: 7,
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
  });

  const result = await executor.execute(
    task({ taskId: "rate-limit-task", input: "Answer." }),
    context,
  );
  assert.equal(result.status, "ok");
  assert.equal(provider.requests.length, 4);
  assert.deepEqual(
    delays,
    [5_000, 5_000, 5_000],
    "each wait honors the provider-declared retry-after",
  );
});

test("a declared retry-after never exceeds one budget window", async () => {
  const delays: number[] = [];
  const provider = new FakeProvider((_request, call) => {
    if (call === 1) {
      throw Object.assign(new Error("429 rate_limit_error"), {
        category: "rate_limit",
        status: 429,
        retryAfterMs: 500_000,
        transient: true,
      });
    }
    return response([{ type: "text", text: "recovered" }]);
  });
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({ modelId: "fake-model" }),
    retry: {
      maxTransientRetries: 0,
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
  });

  const result = await executor.execute(
    task({ taskId: "capped-wait-task", input: "Answer." }),
    context,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(delays, [60_000]);
});

test("the rate-limit budget is bounded: a wall that never lifts still fails", async () => {
  const provider = new FakeProvider(() => {
    throw Object.assign(new Error("429 rate_limit_error"), {
      category: "rate_limit",
      status: 429,
      transient: true,
    });
  });
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({ modelId: "fake-model" }),
    retry: {
      maxTransientRetries: 0,
      maxRateLimitRetries: 2,
      sleep: async () => {},
    },
  });

  const result = await executor.execute(
    task({ taskId: "exhausted-task", input: "Answer." }),
    context,
  );
  assert.equal(result.status, "error");
  assert.equal(provider.requests.length, 3, "initial call plus the bounded retries");
});

test("a paused dispatch queue narrates itself instead of passing as a long model turn", async () => {
  const provider = new FakeProvider(() =>
    response([{ type: "text", text: "the answer" }], { inputTokens: 1, outputTokens: 1 }),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({ modelId: "fake-model" }),
    // The gate says the shared queue is blocked for another 30s; the
    // provider fake resolves immediately, so only the narration matters.
    dispatchGate: {
      blockedUntil: Date.now() + 30_000,
      blockReason: "anthropic rate limit",
    },
  });

  const progress: string[] = [];
  const result = await executor.execute(task({ taskId: "gate-task", input: "q" }), {
    runId: "run-1",
    nodePath: "root/gate",
    reportProgress: (update) => progress.push(update.message),
  });

  assert.equal(result.status, "ok");
  assert.ok(
    progress.some((message) => message.includes("Dispatch paused (anthropic rate limit)")),
    `the wait must be narrated, got: ${JSON.stringify(progress)}`,
  );
});

test("every turn records its own hand-off, complete, with no credential in it", async () => {
  // Recognisable and unlikely: a provider that carries a key must not be able
  // to put it into a record, whatever the executor reads off the request.
  const apiKey = "sk-CREDENTIAL-MUST-NOT-BE-CAPTURED-3f81";
  class KeyedProvider extends FakeProvider {
    public readonly apiKey = apiKey;
  }
  const provider = new KeyedProvider((_request, call) =>
    call === 1
      ? response([
          { type: "tool_use", id: "call-a", name: "lookup", input: { value: 1 } },
        ])
      : response([{ type: "text", text: '{"answer":3}' }]),
  );
  const registry = new ToolRegistry().register(
    defineTool("lookup", async (input) => ({ output: input })),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: registry,
    maxTurns: 4,
    modelRouteResolver: new FixedModelRouteResolver({
      modelId: "fake-model",
      system: "You are a scientific panel member.",
    }),
  });

  const records: Array<{
    readonly id: string;
    readonly turn?: number;
    readonly attempt: number;
    readonly provider: string;
    readonly complete: boolean;
    readonly sections: readonly { readonly title: string; readonly body: string }[];
  }> = [];
  const rows: Array<{ kind: string; promptId?: string; turn?: number }> = [];
  const result = await executor.execute(
    task({ taskId: "t-prompt", input: "Develop the idea.", tools: ["lookup"] }),
    {
      ...context,
      reportProgress: (entry) => rows.push(entry),
      reportPrompt: (record) => records.push(record),
    },
  );

  assert.equal(result.status, "ok");
  // Two wire calls, two rows, two records, each row addressing its own record.
  const calls = rows.filter((entry) => entry.kind === "llm_call");
  assert.equal(provider.requests.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.turn), [1, 2]);
  assert.deepEqual(calls.map((entry) => entry.promptId), records.map((r) => r.id));
  assert.equal(new Set(records.map((record) => record.id)).size, 2);

  const first = records[0]!;
  assert.equal(first.attempt, 1);
  assert.equal(first.provider, "fake");
  assert.equal(first.complete, true, "this path composes the whole wire request");
  assert.equal(
    first.sections.find((section) => section.title === "System prompt")?.body,
    "You are a scientific panel member.",
  );
  assert.match(
    first.sections.find((section) => section.title.startsWith("Message 1"))?.body ?? "",
    /Develop the idea\./,
  );
  assert.match(
    first.sections.find((section) => section.title === "Tool definitions offered")?.body ?? "",
    /lookup/,
  );
  // The second turn carries the first turn's tool result, so the conversation
  // is reconstructable from the record alone.
  assert.equal(
    records[1]!.sections.filter((section) => section.title.startsWith("Message")).length,
    3,
  );

  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes("CREDENTIAL"), false);
});

test("a host with no prompt sink gets no llm_call row", async () => {
  const provider = new FakeProvider(() =>
    response([{ type: "text", text: '{"answer":3}' }]),
  );
  const executor = new ToolLoopAgentExecutor({
    provider,
    tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({ modelId: "fake-model" }),
  });
  const rows: Array<{ kind: string }> = [];
  await executor.execute(task({ taskId: "t-no-sink", input: "hello" }), {
    ...context,
    reportProgress: (entry) => rows.push(entry),
  });

  // No file behind it means no row: a reader must never be offered a request
  // they cannot open.
  assert.equal(
    rows.some((entry) => entry.kind === "llm_call"),
    false,
  );
});
