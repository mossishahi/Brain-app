import assert from "node:assert/strict";
import test from "node:test";

import type { AgentProgress, AgentTask, JsonObject, JsonValue } from "@brainstorm-agentic/core";
import { isCreditBlocked } from "@brainstorm-agentic/core";

import {
  CursorAgentExecutor,
  cursorOutputSchema,
  resolveModelParams,
  salvageJsonText,
  validateCursorApiKey,
  type CursorAgentFactory,
  type CursorModelListEntry,
  type CursorSdkAgentOptions,
  type CursorSdkCustomTool,
  type CursorSdkRunResult,
} from "../src/index.js";

/* ------------------------------------------------------------------ fakes */

interface AttemptScript {
  /** Streamed SDK messages, yielded in order before the run settles. */
  readonly messages?: readonly Record<string, unknown>[];
  /** Simulated model tool calls, invoked with the created customTools. */
  readonly callTools?: (
    tools: Readonly<Record<string, CursorSdkCustomTool>>,
  ) => Promise<void> | void;
  readonly result: CursorSdkRunResult;
  /** Throw from send() instead of running (startup failure). */
  readonly sendError?: Error;
  readonly costUsd?: number;
}

interface FakeState {
  readonly options: CursorSdkAgentOptions[];
  readonly prompts: string[];
  cancelled: number;
}

/** An Agent.create replacement scripted per attempt. */
function fakeFactory(
  attempts: readonly AttemptScript[],
  state: FakeState,
): CursorAgentFactory {
  let attemptIndex = 0;
  return async (options) => {
    state.options.push(options);
    const script = attempts[Math.min(attemptIndex, attempts.length - 1)]!;
    attemptIndex += 1;
    let cancelled = false;
    return {
      agentId: `agent-${attemptIndex}`,
      async send(message: string) {
        state.prompts.push(message);
        if (script.sendError) throw script.sendError;
        const tools = options.local.customTools ?? {};
        return {
          id: `run-${attemptIndex}`,
          async *stream() {
            for (const raw of script.messages ?? []) {
              if (cancelled) return;
              yield raw;
            }
            if (script.callTools) await script.callTools(tools);
          },
          async wait() {
            if (cancelled && script.result.status === "finished") {
              return { status: "cancelled" } as CursorSdkRunResult;
            }
            return script.result;
          },
          supports: () => true,
          async cancel() {
            cancelled = true;
            state.cancelled += 1;
          },
        };
      },
      async getUsage() {
        return script.costUsd !== undefined
          ? { cost: { chargedCents: script.costUsd * 100 } }
          : {};
      },
      close() {
        // nothing to release in the fake
      },
    };
  };
}

function newState(): FakeState {
  return { options: [], prompts: [], cancelled: 0 };
}

const CATALOG: readonly CursorModelListEntry[] = [
  {
    id: "composer-2.5",
    parameters: [
      {
        id: "reasoningEffort",
        displayName: "Reasoning effort",
        values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      },
    ],
  },
  {
    id: "claude-sonnet-5",
    aliases: ["sonnet"],
    parameters: [
      {
        id: "thinkingLevel",
        displayName: "Thinking",
        values: [{ value: "off" }, { value: "adaptive" }],
      },
      {
        id: "reasoningEffort",
        values: [{ value: "high" }, { value: "xhigh" }],
      },
    ],
  },
];

const structuredTask: AgentTask = {
  taskId: "task-1",
  kind: "brainstorm.brain",
  input: { role: "brain" },
  allowedCapabilities: ["web-search", "attachment-access"],
  outputSchema: {
    name: "answer",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  modelRequest: {
    modelId: "claude-sonnet-5",
    system: "You are a scientific panel member.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Develop the idea." }] },
    ],
  },
};

function finished(result?: string): CursorSdkRunResult {
  return {
    status: "finished",
    ...(result !== undefined ? { result } : {}),
    usage: {
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 16,
    },
  };
}

/* ------------------------------------------------------------------ tests */

test("structured output rides the submit_result tool and maps usage", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    effort: "xhigh",
    thinking: "adaptive",
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            const submit = tools.submit_result!;
            await submit.execute({ answer: "structured" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "structured",
  });
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 1,
  });
  // Effort/thinking land as the model's own declared parameters.
  assert.deepEqual(state.options[0]!.model, {
    id: "claude-sonnet-5",
    params: [
      { id: "thinkingLevel", value: "adaptive" },
      { id: "reasoningEffort", value: "xhigh" },
    ],
  });
  // Capabilities map to Cursor's public tool names, plus mcp for the
  // in-process tools; nothing else (no edit/write/task) is offered.
  assert.deepEqual(
    [...state.options[0]!.tools].sort(),
    ["glob", "grep", "ls", "mcp", "read", "webFetch", "webSearch"].sort(),
  );
  // The prompt leads with the role instructions and carries the
  // structured-output contract.
  assert.match(state.prompts[0]!, /^# Instructions\n\nYou are a scientific panel member\./);
  assert.match(state.prompts[0]!, /calling the submit_result tool/);
  // Inline config only — ambient Cursor settings must never load.
  assert.deepEqual(state.options[0]!.local.settingSources, []);
});

test("falls back to salvaging raw JSON when the tool was never called", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          result: finished('Here it is:\n```json\n{"answer":"salvaged"}\n```'),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "salvaged",
  });
});

test("stepwise chain: ordered submit_step calls are assembled into the output", async () => {
  const state = newState();
  const stepwiseTask: AgentTask = {
    ...structuredTask,
    metadata: { stepwise: { tool: "submit_step", field: "cot", count: 2 } },
  };
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            const step = tools.submit_step!;
            // Out-of-order and duplicate calls are refused, then the valid
            // sequence lands.
            const refused = (await step.execute({ index: 2, text: "b" }, {})) as {
              isError?: boolean;
            };
            assert.equal(refused.isError, true);
            await step.execute({ index: 1, text: "step one" }, {});
            await step.execute({ index: 2, text: "step two" }, {});
            await tools.submit_result!.execute({ answer: "done" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(stepwiseTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "done",
    cot: ["step one", "step two"],
  });
});

test("missing stepwise delivery spends a validation attempt with feedback", async () => {
  const state = newState();
  const stepwiseTask: AgentTask = {
    ...structuredTask,
    metadata: { stepwise: { tool: "submit_step", field: "cot", count: 1 } },
  };
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 2,
    agentFactory: fakeFactory(
      [
        {
          // First attempt: result submitted without any chain step.
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "no steps" }, {});
          },
          result: finished(""),
        },
        {
          callTools: async (tools) => {
            await tools.submit_step!.execute({ index: 1, text: "the step" }, {});
            await tools.submit_result!.execute({ answer: "with steps" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(stepwiseTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "with steps",
    cot: ["the step"],
  });
  assert.match(state.prompts[1]!, /Exactly 1 steps must be submitted/);
});

test("authoritative validation feeds issues into a fresh attempt", async () => {
  const state = newState();
  let validations = 0;
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 2,
    outputValidator: {
      validate(value: JsonValue) {
        validations += 1;
        const answer = (value as JsonObject).answer;
        return answer === "good"
          ? { success: true }
          : { success: false, issues: ["answer must be good"] };
      },
    },
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "bad" }, {});
          },
          result: finished(""),
        },
        {
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "good" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  assert.equal(validations, 2);
  assert.equal(
    result.status === "ok" ? result.metadata?.validationAttempts : undefined,
    2,
  );
  assert.match(state.prompts[1]!, /failed authoritative validation/);
  assert.match(state.prompts[1]!, /answer must be good/);
});

test("exceeding maxTurns cancels the run and fails the task", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxTurns: 2,
    maxValidationAttempts: 1,
    agentFactory: fakeFactory(
      [
        {
          messages: [
            { type: "assistant", message: { role: "assistant", content: [] } },
            { type: "assistant", message: { role: "assistant", content: [] } },
            { type: "assistant", message: { role: "assistant", content: [] } },
          ],
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "error");
  assert.match(
    result.status === "error" ? result.error.message : "",
    /exceeded the configured maximum of 2 turns/,
  );
  assert.equal(state.cancelled, 1);
});

test("provider usage-limit messages become a credit block", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    creditRecovery: {
      resolver: async () => ({
        retryAt: 1234,
        source: "deterministic" as const,
        timeZone: "UTC",
      }),
    },
    agentFactory: fakeFactory(
      [
        {
          result: {
            status: "error",
            error: { message: "You have hit your usage limit. It resets at 5pm." },
          },
        },
      ],
      state,
    ),
  });
  await assert.rejects(
    executor.execute(structuredTask, { runId: "run-1", nodePath: "root/brain" }),
    (error: unknown) => {
      assert.ok(isCreditBlocked(error));
      assert.equal((error as { retryAt?: number }).retryAt, 1234);
      return true;
    },
  );
});

test("retryable infrastructure errors restart without consuming attempts", async () => {
  const state = newState();
  const transportError = Object.assign(new Error("transport closed"), {
    isRetryable: true,
  });
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 1,
    agentFactory: fakeFactory(
      [
        { sendError: transportError, result: finished("") },
        {
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "after crash" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "after crash",
  });
});

test("cancellation propagates as an AbortError and cancels the run", async () => {
  const state = newState();
  const controller = new AbortController();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          messages: [
            { type: "assistant", message: { role: "assistant", content: [] } },
          ],
          callTools: async () => {
            controller.abort("user cancelled");
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  await assert.rejects(
    executor.execute(structuredTask, {
      runId: "run-1",
      nodePath: "root/brain",
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("tool lifecycle reaches progress with detail; content tools carry none", async () => {
  const state = newState();
  const events: AgentProgress[] = [];
  const taxonomy = {
    async tree() {
      return { revision: 1, nodeCount: 0, outline: "" };
    },
    async resolve(query: string) {
      return { query, found: false as const };
    },
    async suggest() {
      return { queued: 0 };
    },
  };
  const task: AgentTask = {
    ...structuredTask,
    allowedCapabilities: ["taxonomy-access"],
  };
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    taxonomy: taxonomy as never,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            await tools.taxonomy_resolve!.execute({ query: "systems biology" }, {});
            await tools.submit_result!.execute({ answer: "ok" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  await executor.execute(task, {
    runId: "run-1",
    nodePath: "root/place",
    reportProgress: (progress) => events.push(progress),
  });
  const starts = events.filter((event) => event.kind === "tool_start");
  const resolveStart = starts.find((event) => event.toolName === "taxonomy_resolve");
  assert.ok(resolveStart);
  assert.deepEqual(resolveStart!.data?.detail, {
    kind: "query",
    value: "systems biology",
  });
  const submitStart = starts.find((event) => event.toolName === "submit_result");
  assert.ok(submitStart);
  // The structured-output transport never leaks its payload as detail.
  assert.equal(submitStart!.data, undefined);
});

test("validateCursorApiKey runs one plain-text task through the factory", async () => {
  const state = newState();
  await validateCursorApiKey({
    apiKey: "cursor-key",
    model: "composer-2.5",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory([{ result: finished("OK.") }], state),
    timeoutMs: 5_000,
  });
  assert.equal(state.prompts.length, 1);
  assert.match(state.prompts[0]!, /Reply with OK\./);
  // A key-validation task carries no capabilities and no schema: text only.
  assert.deepEqual(state.options[0]!.tools, []);
});

test("cursorOutputSchema flattens a top-level object union and strips $schema", () => {
  const flattened = cursorOutputSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      {
        type: "object",
        properties: { kind: { const: "a" }, shared: { type: "string" }, onlyA: { type: "number" } },
        required: ["kind", "shared", "onlyA"],
      },
      {
        type: "object",
        properties: { kind: { const: "b" }, shared: { type: "string" } },
        required: ["kind", "shared"],
      },
    ],
  });
  assert.equal(flattened.$schema, undefined);
  assert.equal(flattened.type, "object");
  assert.deepEqual((flattened.properties as JsonObject).kind, {
    type: "string",
    enum: ["a", "b"],
  });
  assert.deepEqual(flattened.required, ["kind", "shared"]);
});

test("resolveModelParams degrades along the effort ladder and honors thinking off", () => {
  // composer offers low/medium/high: xhigh degrades to high, max to high.
  const composer = CATALOG[0]!;
  assert.deepEqual(resolveModelParams(composer, "xhigh", undefined), [
    { id: "reasoningEffort", value: "high" },
  ]);
  assert.deepEqual(resolveModelParams(composer, "max", undefined), [
    { id: "reasoningEffort", value: "high" },
  ]);
  // No thinking parameter declared: the setting is skipped, never invented.
  assert.deepEqual(resolveModelParams(composer, undefined, "disabled"), []);
  const sonnet = CATALOG[1]!;
  assert.deepEqual(resolveModelParams(sonnet, undefined, "disabled"), [
    { id: "thinkingLevel", value: "off" },
  ]);
  // An unknown model (auto) carries no parameters.
  assert.deepEqual(resolveModelParams(undefined, "high", "adaptive"), []);
});

test("salvageJsonText finds fenced and embedded objects, never invents one", () => {
  assert.deepEqual(salvageJsonText('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(salvageJsonText('prose before {"a":[1,2]} prose after'), {
    a: [1, 2],
  });
  assert.equal(salvageJsonText("no json here"), undefined);
});
