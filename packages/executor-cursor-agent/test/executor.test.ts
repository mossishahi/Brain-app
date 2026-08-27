import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentProgress,
  AgentTask,
  JsonObject,
  JsonValue,
  PromptRecord,
} from "@brainstorm-agentic/core";
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
  /**
   * Per-SEND behavior within one attempt (session). Absent = every send in the
   * attempt behaves the same, which is what every scenario except the result
   * nudge needs; the nudge is precisely a SECOND send to the SAME session.
   */
  readonly sends?: readonly Pick<
    AttemptScript,
    "messages" | "callTools" | "result"
  >[];
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
    let sendIndex = 0;
    return {
      agentId: `agent-${attemptIndex}`,
      async send(message: string) {
        state.prompts.push(message);
        if (script.sendError) throw script.sendError;
        const turn =
          script.sends === undefined
            ? script
            : script.sends[Math.min(sendIndex, script.sends.length - 1)]!;
        sendIndex += 1;
        const tools = options.local.customTools ?? {};
        return {
          id: `run-${attemptIndex}`,
          async *stream() {
            for (const raw of turn.messages ?? []) {
              if (cancelled) return;
              yield raw;
            }
            if (turn.callTools) await turn.callTools(tools);
          },
          async wait() {
            if (cancelled && turn.result.status === "finished") {
              return { status: "cancelled" } as CursorSdkRunResult;
            }
            return turn.result;
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
  // in-process tools; nothing else (no edit/write/task) is offered. The web
  // is host-owned, so Cursor's own webSearch/webFetch never appear — the
  // capability is served by the bridged host web tools when a WebAccess is
  // configured, and resolves nowhere when none is.
  assert.deepEqual(
    [...state.options[0]!.tools].sort(),
    ["glob", "grep", "ls", "mcp", "read"].sort(),
  );
  // The prompt leads with the role instructions and carries the
  // structured-output contract.
  assert.match(state.prompts[0]!, /^# Instructions\n\nYou are a scientific panel member\./);
  assert.match(state.prompts[0]!, /calling the submit_result tool/);
  // Inline config only — ambient Cursor settings must never load.
  assert.deepEqual(state.options[0]!.local.settingSources, []);
});

test("the host web layer is bridged as custom tools and answers through the one manager", async () => {
  const state = newState();
  const searches: Array<{ query: string; kind?: string }> = [];
  const web = {
    async search(query: { query: string; kind?: "general" | "scholarly" | "news" }) {
      searches.push({ query: query.query, ...(query.kind ? { kind: query.kind } : {}) });
      return {
        query: query.query,
        kind: query.kind ?? ("general" as const),
        provider: "offline",
        results: [
          {
            title: "Result",
            url: "https://example.org/a",
            snippet: "snippet",
            source: "offline",
          },
        ],
      };
    },
    async fetch(query: { url: string }) {
      return {
        url: query.url,
        finalUrl: query.url,
        status: 200,
        contentType: "text/plain",
        text: "fetched",
        truncated: false,
        fetchedBytes: 7,
      };
    },
    backedKinds() {
      return ["general" as const];
    },
  };
  let searchAnswer: unknown;
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    web,
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            assert.ok(tools.web_search, "the host web_search tool is bridged");
            assert.ok(tools.web_fetch, "the host web_fetch tool is bridged");
            searchAnswer = await tools.web_search!.execute(
              { query: "manifold learning", kind: "general" },
              {},
            );
            await tools.submit_result!.execute({ answer: "structured" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-web",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  // Cursor's own web tools never enter the allowlist; "mcp" carries the bridge.
  const tools = [...state.options[0]!.tools];
  assert.ok(!tools.includes("webSearch"));
  assert.ok(!tools.includes("webFetch"));
  assert.ok(tools.includes("mcp"));
  assert.deepEqual(searches, [{ query: "manifold learning", kind: "general" }]);
  const answer = searchAnswer as { provider?: string; results?: unknown[] };
  assert.equal(answer.provider, "offline");
  assert.equal(answer.results?.length, 1);
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
    metadata: { stepwise: { tool: "submit_step", field: "cot", parts: false, count: 2 } },
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
    metadata: { stepwise: { tool: "submit_step", field: "cot", parts: false, count: 1 } },
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

/** The task shape the runtime delivers for a four-part chain: the stepwise
 *  field is stripped out of the schema (these tool calls fill it), so the
 *  spec's own `parts` flag is what tells the executor which chain form to
 *  ask for. */
const partsTask: AgentTask = {
  ...structuredTask,
  outputSchema: { name: "brainIdeaParts", schema: structuredTask.outputSchema!.schema },
  metadata: { stepwise: { tool: "submit_step", field: "cot", parts: true, count: 2 } },
};

test("a four-part chain asks for four parts and assembles them as step objects", async () => {
  const state = newState();
  let shape: JsonValue | undefined;
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            const step = tools.submit_step!;
            shape = step.inputSchema as JsonValue;
            await step.execute(
              { index: 1, part1: "one a", part2: "one b", part3: "one c", part4: "one d" },
              {},
            );
            // An empty part is legal: the parts are a size discipline, and a
            // refusal here would spend a turn enforcing a soft limit.
            await step.execute(
              { index: 2, part1: "two a", part2: "two b", part3: "two c", part4: "" },
              {},
            );
            await tools.submit_result!.execute({ answer: "done" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(partsTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.deepEqual((shape as JsonObject).required, [
    "index",
    "part1",
    "part2",
    "part3",
    "part4",
  ]);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "done",
    cot: [
      { part1: "one a", part2: "one b", part3: "one c", part4: "one d" },
      { part1: "two a", part2: "two b", part3: "two c", part4: "" },
    ],
  });
});

test("a four-part step that says nothing at all is refused, like an empty paragraph", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            const step = tools.submit_step!;
            const refused = (await step.execute(
              { index: 1, part1: " ", part2: "", part3: "", part4: "" },
              {},
            )) as { isError?: boolean };
            assert.equal(refused.isError, true);
            // The refusal left no gap: position 1 is still the one expected.
            await step.execute(
              { index: 1, part1: "one a", part2: "", part3: "", part4: "" },
              {},
            );
            await step.execute(
              { index: 2, part1: "two a", part2: "", part3: "", part4: "" },
              {},
            );
            await tools.submit_result!.execute({ answer: "done" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(partsTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.status === "ok" ? (result.output as JsonObject).cot : undefined,
    [
      { part1: "one a", part2: "", part3: "", part4: "" },
      { part1: "two a", part2: "", part3: "", part4: "" },
    ],
  );
});

test("a sparse four-part revision keeps each rewritten step's position", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            const step = tools.submit_step!;
            await step.execute({ index: 2, part1: "a", part2: "b", part3: "c", part4: "d" }, {});
            await step.execute({ index: 5, part1: "e", part2: "f", part3: "g", part4: "h" }, {});
            await tools.submit_result!.execute({ answer: "revised" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(
    {
      ...partsTask,
      outputSchema: {
        name: "redevelopmentPatchParts",
        schema: structuredTask.outputSchema!.schema,
      },
      metadata: {
        stepwise: { tool: "submit_step", field: "steps", parts: true, count: 6, sparse: true },
      },
    },
    { runId: "run-1", nodePath: "root/review/redevelop" },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.status === "ok" ? (result.output as JsonObject).steps : undefined,
    [
      { index: 2, part1: "a", part2: "b", part3: "c", part4: "d" },
      { index: 5, part1: "e", part2: "f", part3: "g", part4: "h" },
    ],
  );
});

test("the spec decides the chain form, whatever the schema is called and whatever it shows", async () => {
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            await tools.submit_step!.execute(
              { index: 1, part1: "a", part2: "b", part3: "c", part4: "d" },
              {},
            );
            await tools.submit_result!.execute({ answer: "done" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  // Deliberately starved of every other witness: a name carrying no "Parts"
  // suffix, and an array with no item schema to read a shape off. The spec
  // alone says four parts, and that has to be enough — a chain form whose
  // name broke the convention used to transport silently as strings.
  const result = await executor.execute(
    {
      ...partsTask,
      outputSchema: {
        name: "somethingElse",
        schema: { type: "object", properties: { cot: { type: "array" } } },
      },
      metadata: { stepwise: { tool: "submit_step", field: "cot", parts: true, count: 1 } },
    },
    { runId: "run-1", nodePath: "root/brain" },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.status === "ok" ? (result.output as JsonObject).cot : undefined,
    [{ part1: "a", part2: "b", part3: "c", part4: "d" }],
  );
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
  // Attempt 1 is asked twice for its result before the session is abandoned, so
  // it streams its usage message three times (3 x 10 in / 5 out); attempt 2 then
  // adds 12 in, 4 out, 2 read, 1 write. Every send is billed and every send is
  // counted — the point of the test is that none of it vanishes with the
  // exception that reports the parse failure.
  assert.deepEqual(result.usage, {
    inputTokens: 42,
    outputTokens: 19,
    totalTokens: 61,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 1,
  });
  // Same session first (asking for the result it never submitted), then the
  // fresh session with the corrective feedback.
  assert.match(state.prompts[1]!, /submit_result tool now/);
  assert.match(state.prompts[2]!, /submit_result tool now/);
  assert.match(state.prompts[3]!, /not parseable JSON/);
  assert.equal(state.options.length, 2, "exactly one fresh session was started");
});

test("a session that ends mid-thought is asked for its result, not thrown away", async () => {
  // Observed in a live review: a redeveloper ended its turn with "Good — I've
  // confirmed the key literature facts. Now let me run my own independent
  // verification…" and the run finished successfully having submitted nothing.
  // The agent's loop ends when the model stops calling tools, so narration
  // instead of a tool call ends the session — with all of its work still in it.
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          result: finished(),
          sends: [
            {
              // The model narrates its next move and stops. Nothing submitted.
              messages: [
                { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
              ],
              result: {
                status: "finished",
                result:
                  "Good — I've confirmed the key literature facts. Now let me run my own " +
                  "independent verification of the joint/group selection mechanism.",
              },
            },
            {
              // Asked for the result, it hands it over in the SAME session.
              callTools: async (tools) => {
                await tools.submit_result!.execute({ answer: "finished after all" }, {});
              },
              result: finished(),
            },
          ],
        },
      ],
      state,
    ),
  });
  const records: PromptRecord[] = [];
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/review/redevelop",
    reportPrompt: (record) => records.push(record),
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "finished after all",
  });
  // The session was CONTINUED, never restarted: one agent, two sends. Restarting
  // would re-buy the literature review the model had just finished, and can fail
  // the same way twice and take the run down with it.
  assert.equal(state.options.length, 1, "no fresh session was started");
  assert.equal(state.prompts.length, 2);
  assert.match(state.prompts[1]!, /ended your turn without submitting a result/);
  assert.match(state.prompts[1]!, /Do not start new work/);
  // Both sends are recorded, because the nudge is a prompt we sent and the
  // record's whole promise is that every prompt we send has one. It is also
  // the send a reader is most likely to be chasing: it only exists because
  // the session ended without handing anything over.
  assert.equal(records.length, 2, "the nudge is a second prompt, so a second record");
  assert.notEqual(records[0]!.id, records[1]!.id, "each send addresses its own file");
  // Each record's instruction and prompt sections concatenate, in that order,
  // to exactly the bytes that send carried. That is the promise the file makes,
  // and it has to hold for the nudge as much as for the first send.
  const sentBytes = (record: PromptRecord): string =>
    record.sections
      .filter((section) => /^(Instructions|Prompt)/.test(section.title))
      .map((section) => section.body)
      .join("");
  assert.equal(sentBytes(records[0]!), state.prompts[0]);
  assert.equal(sentBytes(records[1]!), state.prompts[1]);
  // Usage across a multi-send session stays an ESTIMATE, and deliberately so:
  // the streamed messages and the terminal result are two partial views of the
  // same session (either can miss its tail), so they merge component-wise by
  // MAX rather than summing — summing them would double-count a terminal figure
  // that is already cumulative. Send 1 streamed 10 in / 5 out; send 2's terminal
  // reported 15 in / 4 out with 2 read and 1 write, which normalizes to 12
  // disjoint input tokens.
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 1,
  });
});

test("a model that ignores the request twice falls back to a fresh session", async () => {
  // The nudge is bounded: a model that will not hand over a result after two
  // explicit requests is stuck, and starting over with corrective feedback is
  // then the right answer rather than sending forever.
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        { result: { status: "finished", result: "still thinking out loud" } },
        {
          // The fresh session runs in the raw-JSON fallback, so there is no
          // submit_result tool to call: the object rides the final message.
          result: { status: "finished", result: '{"answer":"fresh start"}' },
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/review/redevelop",
  });

  assert.equal(result.status, "ok");
  // Three sends in the first session (the original plus two requests), then one
  // fresh session — not an unbounded conversation.
  assert.equal(state.prompts.length, 4);
  assert.equal(state.options.length, 2);
  assert.match(state.prompts[3]!, /not parseable JSON/);
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

test("resource_exhausted waits briefly and restarts instead of failing the task", async () => {
  const state = newState();
  const events: string[] = [];
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 1,
    quotaRetryDelayMs: 5,
    agentFactory: fakeFactory(
      [
        // The upstream quota error carries NO isRetryable flag: the message
        // alone must route it into the bounded restart lane.
        { sendError: new Error("[resource_exhausted] Error"), result: finished("") },
        {
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "after refill" }, {});
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
    reportProgress: (progress) => {
      events.push(`${progress.kind}: ${progress.message}`);
    },
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "after refill",
  });
  assert.ok(
    events.some((entry) => /retry: .*resource_exhausted.*waiting \d+s/.test(entry)),
    `expected a quota-wait retry event, got: ${events.join(" | ")}`,
  );
});

test("a transient 401 restarts the task instead of failing the run", async () => {
  // Observed overnight: four of these HOURS apart on a run that authenticated
  // fine before and after each one, every time killing a redeveloper task and
  // with it the whole run. A token exchange that fails and then works again is
  // infrastructure, so it takes the bounded restart lane with a wait.
  const state = newState();
  const events: string[] = [];
  const authError = Object.assign(
    new Error("Authentication error If you are logged in, try logging out and back in."),
    { status: 401, name: "AuthenticationError" },
  );
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 1,
    quotaRetryDelayMs: 5,
    agentFactory: fakeFactory(
      [
        { sendError: authError, result: finished("") },
        {
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "after the hiccup" }, {});
          },
          result: finished(""),
        },
      ],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/review/redevelop",
    reportProgress: (progress) => {
      if (progress.kind === "retry") events.push(progress.message);
    },
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : undefined, {
    answer: "after the hiccup",
  });
  assert.equal(state.options.length, 2, "the task restarted in a fresh session");
  assert.match(events.join(" | "), /refused the credential; waiting/);
});

test("a credential refused on every attempt fails with the fix, not the SDK's sentence", async () => {
  // The other half of the rule: a revoked key must still surface, and say what
  // to do about it rather than leaving the SDK's "try logging out and back in".
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 1,
    quotaRetryDelayMs: 5,
    agentFactory: fakeFactory(
      [{ sendError: new Error("Authentication error"), result: finished("") }],
      state,
    ),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/review/redevelop",
  });
  assert.equal(result.status, "error");
  const message = result.status === "error" ? result.error.message : "";
  assert.match(message, /re-enter the Cursor API key in Settings/);
  assert.match(message, /retry this run/);
  // Bounded: the initial attempt plus MAX_CRASH_RETRIES restarts, no more.
  assert.equal(state.options.length, 3);
});

test("a quota wall that outlives the quick retries parks the run instead of failing it", async () => {
  // 30s + 60s of waiting is all the quick lane can buy, and an upstream window
  // refills on the provider's clock. Parking reuses the credit-block lane the
  // scheduler already claims when it comes due, so an overnight dip costs a
  // pause rather than the run.
  const state = newState();
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    maxValidationAttempts: 1,
    quotaRetryDelayMs: 5,
    agentFactory: fakeFactory(
      [{ sendError: new Error("[resource_exhausted] Error"), result: finished("") }],
      state,
    ),
  });
  const before = Date.now();
  const blocked = await executor
    .execute(structuredTask, { runId: "run-1", nodePath: "root/review/redevelop" })
    .then(() => undefined)
    .catch((error: unknown) => error);
  assert.ok(isCreditBlocked(blocked), "an exhausted quota parks the run");
  const block = blocked as { retryAt?: number; source?: string };
  assert.equal(block.source, "deterministic");
  assert.ok(
    (block.retryAt ?? 0) > before,
    "the block names a time to come back, so the scheduler can claim it",
  );
  // It still tried the quick restarts first: a brief dip never reaches here.
  assert.equal(state.options.length, 3);
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

test("a long stretch in one phase emits ONE model row, and the transition emits the next", async () => {
  const state = newState();
  const reported: AgentProgress[] = [];
  // One turn arrives as many delta messages. The timer this replaced turned a
  // stretch like this into a row per heartbeat window, all saying the same
  // thing; the phase rule must produce one row per phase.
  const thinkingDeltas = Array.from({ length: 40 }, () => ({
    type: "thinking",
    text: "fragment ",
  }));
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [
        {
          messages: [
            ...thinkingDeltas,
            { type: "assistant", text: "part one" },
            { type: "assistant", text: "part two" },
          ],
          result: finished(JSON.stringify({ answer: "ok" })),
        },
      ],
      state,
    ),
  });

  await executor.execute(structuredTask, {
    runId: "run-phases",
    nodePath: "root/brain",
    reportProgress: (entry) => reported.push(entry),
  });

  assert.deepEqual(
    reported.filter((entry) => entry.kind === "model").map((entry) => entry.message),
    ["Model reasoning", "Composing the response"],
  );
});

test("one hand-off produces one llm_call row and one record, and no credential rides in it", async () => {
  // Recognisable and unlikely: if it ever appears in a record, the capture
  // reached the executor's credential and the test says exactly which one.
  const apiKey = "cursor-key-CREDENTIAL-MUST-NOT-BE-CAPTURED-7c4a";
  const state = newState();
  const reported: AgentProgress[] = [];
  const records: PromptRecord[] = [];
  const executor = new CursorAgentExecutor({
    apiKey,
    listModels: async () => CATALOG,
    effort: "xhigh",
    thinking: "adaptive",
    maxTurns: 24,
    fallbackModel: "composer-2.5",
    agentFactory: fakeFactory(
      [
        {
          callTools: async (tools) => {
            await tools.submit_result!.execute({ answer: "ok" }, {});
          },
          result: finished(),
        },
      ],
      state,
    ),
  });

  await executor.execute(structuredTask, {
    runId: "run-prompt-capture",
    nodePath: "root/brain",
    reportProgress: (entry) => reported.push(entry),
    reportPrompt: (record) => records.push(record),
  });

  const rows = reported.filter((entry) => entry.kind === "llm_call");
  assert.equal(rows.length, 1, "one hand-off, one row");
  assert.equal(records.length, 1, "one hand-off, one record");
  assert.equal(rows[0]!.promptId, records[0]!.id, "the row addresses the record");

  const record = records[0]!;
  assert.equal(record.provider, "cursor-agent-sdk");
  assert.equal(record.model, "claude-sonnet-5");
  assert.equal(record.taskId, "task-1");
  assert.equal(record.attempt, 1);
  assert.equal(record.turn, undefined, "the SDK path composes no wire turn of its own");
  assert.equal(record.complete, false, "the SDK adds its own half after we hand over");

  // Byte for byte: the instructions section prepended to the prompt section is
  // exactly the message the agent was sent.
  const body = (title: string): string =>
    record.sections.find((section) => section.title.startsWith(title))?.body ?? "";
  assert.equal(body("Instructions") + body("Prompt"), state.prompts[0]);
  const settings = JSON.parse(body("Execution settings")) as JsonObject;
  assert.equal(settings.maxTurns, 24);
  assert.equal(settings.effort, "xhigh");
  assert.equal(settings.fallbackModel, "composer-2.5");
  // The structured-output transport is one of ours, so its whole definition —
  // the schema the answer must satisfy — is reconstructable from the record.
  assert.match(body("Tools offered"), /submit_result/);

  const serialized = JSON.stringify(records);
  assert.equal(
    serialized.includes(apiKey),
    false,
    "the API key must never reach a captured prompt",
  );
  assert.equal(serialized.includes("CREDENTIAL"), false);
});

test("a host with no prompt sink gets no llm_call row", async () => {
  const state = newState();
  const reported: AgentProgress[] = [];
  const executor = new CursorAgentExecutor({
    apiKey: "cursor-key",
    listModels: async () => CATALOG,
    agentFactory: fakeFactory(
      [{ result: finished(JSON.stringify({ answer: "ok" })) }],
      state,
    ),
  });

  await executor.execute(structuredTask, {
    runId: "run-no-sink",
    nodePath: "root/brain",
    reportProgress: (entry) => reported.push(entry),
  });

  // No file behind it means no row: a reader must never be offered a request
  // they cannot open.
  assert.equal(
    reported.some((entry) => entry.kind === "llm_call"),
    false,
  );
});
