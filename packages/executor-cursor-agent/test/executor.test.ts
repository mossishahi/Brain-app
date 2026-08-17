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
    // The real SDK's shape (verified against provider billing exports):
    // inputTokens is the WHOLE context — cache read and cache write are
    // counted inside it — and totalTokens re-adds both (double-counting).
    // coreUsage() must undo both: 15 - 2 - 1 = 12 disjoint input tokens.
    usage: {
      inputTokens: 15,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 22,
    },
  };
}

/* ------------------------------------------------------------------ tests */

test("structured output rides the submit_result tool; cache-inclusive usage is normalized", async () => {
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
  // Disjoint fields: input excludes the cache parts, and totalTokens is
  // in + out — never the SDK's double-counted figure (22 in the fixture).
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

test("a thrown attempt's streamed usage reaches the final failure result", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          messages: [
            {
              type: "usage",
              usage: {
                inputTokens: 103, // 100 cache write + 3 cache read inside
                outputTokens: 7,
                cacheReadTokens: 3,
                cacheWriteTokens: 100,
                totalTokens: 213,
              },
            },
          ],
          result: {
            status: "error",
            error: { message: "backend exploded mid-run" },
          },
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
    /backend exploded/,
  );
  // The session was billed before it died; the tokens must not vanish with
  // the exception that reports the death.
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 7,
    totalTokens: 7,
    cacheReadInputTokens: 3,
    cacheWriteInputTokens: 100,
  });
});

test("a parse-failure attempt's usage carries into the eventual success", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          // Attempt 1 completes but its final message is not JSON: the
          // executor throws, spends a validation attempt on a fresh
          // session — and must keep the tokens this session billed.
          messages: [
            { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
          ],
          result: { status: "finished", result: "not json at all" },
        },
        {
          // The retry runs with the raw-JSON fallback (no submit_result
          // tool), so the final message itself carries the object.
          result: {
            status: "finished",
            result: '{"answer":"recovered"}',
            usage: {
              inputTokens: 15,
              outputTokens: 4,
              cacheReadTokens: 2,
              cacheWriteTokens: 1,
              totalTokens: 22,
            },
          },
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
    answer: "recovered",
  });
  // Attempt 1 (10 in, 5 out) plus attempt 2 (12 in, 4 out, 2 read, 1 write).
  assert.deepEqual(result.usage, {
    inputTokens: 22,
    outputTokens: 9,
    totalTokens: 31,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 1,
  });
  assert.match(state.prompts[1]!, /not parseable JSON/);
});

test("terminal usage merges component-wise with the streamed sum", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          // The stream saw more input than the terminal report; the terminal
          // saw more output (a tail the stream missed — observed against
          // provider billing). Neither view alone is complete, so the
          // estimate takes the larger of each component.
          messages: [
            { type: "usage", usage: { inputTokens: 100, outputTokens: 2 } },
          ],
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "merged" }, {});
          },
          result: {
            status: "finished",
            result: "",
            usage: { inputTokens: 40, outputTokens: 60 },
          },
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
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 60,
    totalTokens: 160,
  });
});

test("exceeding maxTurns (tool rounds + completed sends) cancels the run and fails the task", async () => {
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
            { type: "tool_call", call_id: "c1", name: "read", status: "running" },
            { type: "tool_call", call_id: "c1", name: "read", status: "completed" },
            { type: "tool_call", call_id: "c2", name: "grep", status: "running" },
            { type: "tool_call", call_id: "c2", name: "grep", status: "completed" },
            { type: "tool_call", call_id: "c3", name: "shell", status: "running" },
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

test("streamed assistant/thinking FRAGMENTS never count as turns", async () => {
  // The production incident this pins down: one real model turn arrives as
  // many assistant and thinking delta messages (a probed single-turn run
  // carried 8 and 14), so counting messages cancelled a one-minute
  // preprocessing task as "100 turns exceeded".
  const state = newState();
  const fragments = Array.from({ length: 60 }, (_, index) =>
    index % 2 === 0
      ? { type: "assistant", message: { role: "assistant", content: [] } }
      : { type: "thinking", text: `fragment ${index} ` },
  );
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxTurns: 2,
    maxValidationAttempts: 1,
    agentFactory: fakeFactory(
      [
        {
          messages: [
            ...fragments,
            { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
          ],
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "ok" }, {});
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
  assert.equal(state.cancelled, 0);
  assert.equal(result.status === "ok" ? result.metadata?.turns : undefined, 1);
});

test("thinking deltas merge into readable trace segments; empty deltas split blocks", async () => {
  const state = newState();
  const traceTask: AgentTask = {
    ...structuredTask,
    input: { role: "brain", routeTraits: ["extended-reasoning"] },
  };
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          messages: [
            { type: "thinking", text: "I" },
            { type: "thinking", text: "'ll check the file" },
            { type: "thinking", text: "" },
            { type: "thinking", text: "The" },
            { type: "thinking", text: " answer is clear" },
          ],
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "ok" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(traceTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  const segments =
    result.status === "ok"
      ? (result.metadata?.thinkingSegments as { text: string }[])
      : [];
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ["I'll check the file", "The answer is clear"],
  );
});

test("stream tool_call events named mcp are not double-reported; wrappers own custom-tool progress", async () => {
  const state = newState();
  const events: AgentProgress[] = [];
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          messages: [
            { type: "tool_call", call_id: "m1", name: "mcp", status: "running" },
            { type: "tool_call", call_id: "m1", name: "mcp", status: "completed" },
          ],
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "ok" }, {});
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
    reportProgress: (progress) => events.push(progress),
  });
  assert.equal(result.status, "ok");
  const toolEvents = events.filter(
    (event) => event.kind === "tool_start" || event.kind === "tool_end",
  );
  // Exactly one start and one end — from the submit_result wrapper — and
  // no anonymous "mcp" rows from the stream.
  assert.deepEqual(
    toolEvents.map((event) => `${event.kind}:${event.toolName}`),
    ["tool_start:submit_result", "tool_end:submit_result"],
  );
  // The mcp round still counts toward the turn budget.
  assert.equal(result.status === "ok" ? result.metadata?.turns : undefined, 1);
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

test("a silent stream trips the stall watchdog and restarts the attempt", async () => {
  // The production wedge this pins down: Azure's NAT silently dropped the
  // idle upstream connection mid-run; the SDK's next write hit a black hole
  // and the run froze for the kernel's ~15-minute retransmission window
  // (observed as bytes stuck in Send-Q and a dashboard quiet for 10+
  // minutes). The watchdog cancels locally after the configured silence and
  // routes through the bounded infrastructure-retry lane.
  const state = newState();
  let attempts = 0;
  const factory: CursorAgentFactory = async (options) => {
    state.options.push(options);
    attempts += 1;
    const wedged = attempts === 1;
    let cancelled = false;
    return {
      agentId: `agent-${attempts}`,
      async send(message: string) {
        state.prompts.push(message);
        return {
          id: `run-${attempts}`,
          async *stream() {
            yield { type: "thinking", text: "one healthy fragment" };
            if (wedged) {
              // The dead connection: no further messages, no end-of-stream,
              // and cancel() cannot end the read either.
              await new Promise(() => undefined);
            }
          },
          async wait() {
            if (wedged) await new Promise(() => undefined);
            return {
              status: "finished",
              result: "",
              usage: { inputTokens: 1, outputTokens: 1 },
            } as CursorSdkRunResult;
          },
          supports: () => true,
          async cancel() {
            cancelled = true;
            state.cancelled += 1;
            void cancelled;
          },
        };
      },
      close() {
        // nothing held by the fake
      },
    };
  };
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 1,
    stallTimeoutMs: 60,
    agentFactory: factory,
  });
  const events: AgentProgress[] = [];
  const result = await executor.execute(
    {
      ...structuredTask,
      outputSchema: undefined,
      modelRequest: structuredTask.modelRequest,
    },
    {
      runId: "run-1",
      nodePath: "root/brain",
      reportProgress: (progress) => events.push(progress),
    },
  );
  assert.equal(result.status, "ok");
  assert.equal(attempts, 2, "the wedged attempt restarted in a fresh session");
  assert.ok(
    events.some(
      (event) =>
        event.kind === "retry" && /restarting the task/.test(event.message),
    ),
    "the restart is narrated in the activity feed",
  );
});

test("a fragment right after a re-arm does not double the stall deadline", async () => {
  // Regression: the watchdog re-arms at most once per second, so a fragment
  // landing just AFTER a re-arm leaves the timer pointing at the old
  // deadline. On fire the old code extended by a FULL window instead of the
  // remainder, letting detection drift toward 2x stallTimeoutMs (a 6-minute
  // watchdog observed firing ~12 minutes after the last delta). With the
  // remainder fix, detection stays ~stallTimeoutMs after the last activity.
  const state = newState();
  let attempts = 0;
  const factory: CursorAgentFactory = async (options) => {
    state.options.push(options);
    attempts += 1;
    const wedged = attempts === 1;
    return {
      agentId: `agent-${attempts}`,
      async send(message: string) {
        state.prompts.push(message);
        return {
          id: `run-${attempts}`,
          async *stream() {
            yield { type: "thinking", text: "fragment at arm time" };
            if (wedged) {
              // Trailing fragment inside the 1s arming throttle: activity
              // advances but the deadline timer does not move.
              await new Promise((resolve) => setTimeout(resolve, 100));
              yield { type: "thinking", text: "trailing fragment" };
              await new Promise(() => undefined); // the wedge
            }
          },
          async wait() {
            if (wedged) await new Promise(() => undefined);
            return {
              status: "finished",
              result: "",
              usage: { inputTokens: 1, outputTokens: 1 },
            } as CursorSdkRunResult;
          },
          supports: () => true,
          async cancel() {
            state.cancelled += 1;
          },
        };
      },
      close() {
        // nothing held by the fake
      },
    };
  };
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 1,
    stallTimeoutMs: 1_000,
    agentFactory: factory,
  });
  const startedAt = Date.now();
  let retryAfterMs: number | undefined;
  const result = await executor.execute(
    { ...structuredTask, outputSchema: undefined },
    {
      runId: "run-1",
      nodePath: "root/brain",
      reportProgress: (progress) => {
        if (progress.kind === "retry" && retryAfterMs === undefined) {
          retryAfterMs = Date.now() - startedAt;
        }
      },
    },
  );
  assert.equal(result.status, "ok");
  assert.equal(attempts, 2, "the wedged attempt restarted in a fresh session");
  assert.ok(retryAfterMs !== undefined, "the stall retry was narrated");
  // Remainder-based deadline: ~1150ms (wedge at 100ms + 1000ms window + 50ms
  // slack). The old full-window extension fired at ~2000ms; 1600ms splits the
  // two with wide margins on both sides.
  assert.ok(
    retryAfterMs < 1_600,
    `stall detected after ${retryAfterMs}ms; the deadline drifted toward 2x the window`,
  );
});

test("a stall on every attempt fails the task with the stall diagnosis", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 1,
    stallTimeoutMs: 40,
    agentFactory: fakeFactory(
      [
        {
          // send() itself wedges — the initial POST can hit the same dead
          // connection.
          sendError: undefined,
          result: finished(""),
          callTools: async () => {
            await new Promise(() => undefined);
          },
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
    /no activity for \d+s/,
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

  // GPT/Kimi/GLM-family models fold effort AND thinking into one
  // `reasoning` parameter (live catalog shape); `context`/`fast` params are
  // never touched.
  const gpt = {
    id: "gpt-5.6-sol",
    parameters: [
      { id: "context", values: [{ value: "272k" }, { value: "1m" }] },
      {
        id: "reasoning",
        values: ["none", "low", "medium", "high", "xhigh", "max"].map(
          (value) => ({ value }),
        ),
      },
      { id: "fast", values: [{ value: "false" }, { value: "true" }] },
    ],
  };
  assert.deepEqual(resolveModelParams(gpt, "max", "adaptive"), [
    { id: "reasoning", value: "max" },
  ]);
  // "no extended thinking" wins over effort where reasoning is both knobs.
  assert.deepEqual(resolveModelParams(gpt, "high", "disabled"), [
    { id: "reasoning", value: "none" },
  ]);
});

test("salvageJsonText finds fenced and embedded objects, never invents one", () => {
  assert.deepEqual(salvageJsonText('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(salvageJsonText('prose before {"a":[1,2]} prose after'), {
    a: [1, 2],
  });
  assert.equal(salvageJsonText("no json here"), undefined);
});
