import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTask } from "@brainstorm-agentic/core";

import {
  ClaudeAgentExecutor,
  validateClaudeSetupToken,
  type ClaudeAgentQueryFn,
  type ClaudeAgentQueryInput,
} from "../src/index.js";

function successQuery(
  capture: ClaudeAgentQueryInput[],
  structuredOutput: unknown = { answer: "ok" },
): ClaudeAgentQueryFn {
  return (input) => ({
    async *[Symbol.asyncIterator]() {
      capture.push(input);
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify(structuredOutput),
        structured_output: structuredOutput,
        session_id: "session-test",
        num_turns: 2,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      };
    },
  });
}

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
    modelId: "sonnet",
    system: "You are a scientific panel member.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Develop the idea." }],
      },
    ],
  },
};

test("segmented instructions become a cacheable prefix split by the SDK boundary marker", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: successQuery(captured),
  });
  await executor.execute(
    {
      ...structuredTask,
      modelRequest: {
        ...structuredTask.modelRequest!,
        system: [
          { text: "Stable role instructions.", cacheable: true },
          { text: "Web search is unavailable for this run." },
        ],
      },
    },
    { runId: "run-1", nodePath: "root/brain" },
  );

  // Every task runs in a fresh session, so the marker is what makes the
  // instruction prefix reusable across the panel's many similar calls.
  assert.deepEqual(captured[0]!.options.systemPrompt, [
    "Stable role instructions.",
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    "Web search is unavailable for this run.",
  ]);
});

test("instructions with nothing stable to cache stay a single system string", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: successQuery(captured),
  });
  await executor.execute(
    {
      ...structuredTask,
      modelRequest: {
        ...structuredTask.modelRequest!,
        system: [{ text: "Per-call instructions." }, { text: "More context." }],
      },
    },
    { runId: "run-1", nodePath: "root/brain" },
  );
  assert.equal(
    captured[0]!.options.systemPrompt,
    "Per-call instructions.\n\nMore context.",
  );
});

test("executes a structured task with setup-token auth and capability tools", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: successQuery(captured),
    env: {
      ANTHROPIC_API_KEY: "must-not-leak",
      HOME: "/tmp/test-home",
    },
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? result.output : null, {
    answer: "ok",
  });
  assert.equal(result.usage?.inputTokens, 12);
  assert.equal(result.usage?.outputTokens, 4);
  assert.equal(result.metadata?.sessionId, "session-test");

  assert.equal(captured.length, 1);
  const options = captured[0]!.options;
  const env = options.env as Record<string, string | undefined>;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "setup-token-secret");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.model, "sonnet");
  assert.equal(options.systemPrompt, "You are a scientific panel member.");
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.permissionMode, "dontAsk");
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.maxTurns, 100);
  assert.equal(options.effort, "high");
  assert.deepEqual(options.thinking, {
    type: "adaptive",
    display: "omitted",
  });
  assert.deepEqual(options.tools, [
    "WebSearch",
    "WebFetch",
    "Read",
    "Glob",
    "Grep",
  ]);
  assert.deepEqual(options.outputFormat, {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  });
});

test("passes customized Agent SDK execution controls", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    model: "opus",
    maxTurns: 160,
    maxBudgetUsd: 12.5,
    effort: "xhigh",
    thinking: "disabled",
    fallbackModel: "sonnet",
    queryFn: successQuery(captured),
  });
  await executor.execute(structuredTask, {
    runId: "run-params",
    nodePath: "root/decompose",
  });
  assert.equal(captured[0]!.options.maxTurns, 160);
  assert.equal(captured[0]!.options.maxBudgetUsd, 12.5);
  assert.equal(captured[0]!.options.effort, "xhigh");
  assert.deepEqual(captured[0]!.options.thinking, { type: "disabled" });
  assert.equal(captured[0]!.options.fallbackModel, "sonnet");
});

test("scopes Claude Code file tools to ingested attachment roots", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  const root = mkdtempSync(join(tmpdir(), "claude-agent-attachments-"));
  try {
    await new ClaudeAgentExecutor({
      token: "setup-token-secret",
      attachmentRoots: [root],
      queryFn: successQuery(captured),
    }).execute(structuredTask, {
      runId: "run-file-scope",
      nodePath: "root/processor",
    });
    assert.deepEqual(captured[0]!.options.additionalDirectories, [root]);
    const hooks = captured[0]!.options.hooks as {
      PreToolUse: Array<{
        hooks: Array<(input: unknown) => Promise<Record<string, unknown>>>;
      }>;
    };
    const guard = hooks.PreToolUse[0]!.hooks[0]!;
    assert.deepEqual(
      await guard({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(root, "paper.pdf") },
      }),
      { continue: true },
    );
    const denied = await guard({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" },
    });
    assert.equal(
      (
        denied.hookSpecificOutput as {
          permissionDecision?: string;
        }
      ).permissionDecision,
      "deny",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports granular tool/status progress without exposing assistant text", async () => {
  const reported: Array<{ kind: string; message: string }> = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", model: "sonnet" };
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "PRIVATE REASONING MUST NOT APPEAR" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "WebSearch",
                input: { query: "recent manifold learning papers" },
              },
            ],
          },
        };
        yield {
          type: "tool_progress",
          tool_use_id: "tool-1",
          tool_name: "WebSearch",
          elapsed_time_seconds: 6,
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { answer: "ok" },
          result: "{\"answer\":\"ok\"}",
          usage: {},
        };
      },
    }),
  });
  await executor.execute(structuredTask, {
    runId: "run-progress",
    nodePath: "root/decompose",
    reportProgress: (entry) => reported.push(entry),
  });
  assert.ok(reported.some((entry) => entry.message.includes("initialized")));
  assert.ok(
    reported.some((entry) =>
      entry.message.includes("recent manifold learning papers"),
    ),
  );
  assert.ok(reported.some((entry) => entry.message.includes("still running")));
  assert.ok(reported.some((entry) => entry.kind === "validation"));
  assert.equal(
    reported.some((entry) => entry.message.includes("PRIVATE REASONING")),
    false,
  );
});

test("reports tool completions and streamed-turn heartbeats without content", async () => {
  const reported: Array<{ kind: string; message: string; toolName?: string; elapsedMs?: number }> = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    progressHeartbeatMs: 0,
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "stream_event", event: { type: "message_start" } };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "thinking" },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "SECRET THOUGHTS" },
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "WebSearch",
                input: { query: "graph priors" },
              },
              { type: "tool_use", id: "tool-2", name: "WebFetch", input: {} },
            ],
          },
        };
        yield { type: "stream_event", event: { type: "message_stop" } };
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-1" }],
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tool-2", is_error: true },
            ],
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", name: "StructuredOutput" },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "{\"answer\":" },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { answer: "ok" },
          result: "{\"answer\":\"ok\"}",
          usage: {},
        };
      },
    }),
  });
  await executor.execute(structuredTask, {
    runId: "run-heartbeat",
    nodePath: "root/decompose",
    reportProgress: (entry) => reported.push(entry),
  });

  const ends = reported.filter((entry) => entry.kind === "tool_end");
  assert.equal(ends.length, 2);
  assert.match(ends[0]!.message, /^Web search finished · \d+s · 1 tool still running$/);
  assert.equal(ends[0]!.toolName, "WebSearch");
  assert.ok(ends[0]!.elapsedMs !== undefined);
  assert.match(ends[1]!.message, /^Source fetch failed · \d+s$/);

  const heartbeats = reported.filter((entry) => entry.kind === "model");
  assert.ok(
    heartbeats.some((entry) => /^Model reasoning · \d+s$/.test(entry.message)),
    "silent thinking stretches surface as reasoning heartbeats",
  );
  assert.ok(
    heartbeats.some((entry) =>
      /^Writing the structured output · \d+s$/.test(entry.message),
    ),
    "long output writing surfaces as a heartbeat",
  );
  assert.equal(
    reported.some((entry) => entry.message.includes("SECRET THOUGHTS")),
    false,
    "stream deltas never leak content",
  );
});

test("adds an object type for top-level oneOf structured schemas", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  const task: AgentTask = {
    ...structuredTask,
    outputSchema: {
      name: "comment",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        oneOf: [
          {
            type: "object",
            properties: { verdict: { const: "Pass" } },
            required: ["verdict"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { verdict: { const: "Build" } },
            required: ["verdict"],
            additionalProperties: false,
          },
        ],
      },
    },
  };
  await new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: successQuery(captured, { verdict: "Pass" }),
  }).execute(task, { runId: "run-union", nodePath: "root/comment" });
  assert.deepEqual(captured[0]!.options.outputFormat, {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["Pass", "Build"] },
      },
      required: ["verdict"],
      additionalProperties: false,
    },
  });
});

test("retries the whole Agent SDK task when authoritative validation fails", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  let calls = 0;
  const queryFn: ClaudeAgentQueryFn = (input) => ({
    async *[Symbol.asyncIterator]() {
      captured.push(input);
      calls += 1;
      const output = calls === 1 ? { answer: "" } : { answer: "corrected" };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: output,
        result: JSON.stringify(output),
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  });
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn,
    maxValidationAttempts: 2,
    outputValidator: {
      validate(value) {
        const candidate = value as Record<string, unknown>;
        const answer =
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          typeof candidate.answer === "string"
            ? candidate.answer
            : "";
        return answer.length > 0
          ? { success: true, value }
          : { success: false, issues: ["answer must not be empty"] };
      },
    },
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-validation",
    nodePath: "root/redevelopment",
  });
  assert.equal(result.status, "ok");
  assert.equal(calls, 2);
  assert.match(captured[1]!.prompt, /answer must not be empty/);
  assert.ok(
    captured[1]!.prompt.includes('{"answer":""}'),
    "the retry prompt echoes the rejected output — fresh sessions have no memory of it",
  );
  assert.ok(
    captured[0]!.prompt.includes("Never submit placeholder"),
    "structured tasks always carry the final-submission guard",
  );
  assert.equal(result.usage?.inputTokens, 2);
  assert.equal(result.metadata?.validationAttempts, 2);
});

test("falls back to validated raw JSON when native structured output exhausts", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  let calls = 0;
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    maxValidationAttempts: 3,
    queryFn: (input) => ({
      async *[Symbol.asyncIterator]() {
        captured.push(input);
        calls += 1;
        if (calls === 1) {
          yield {
            type: "result",
            subtype: "error_max_structured_output_retries",
            is_error: true,
            errors: ["Failed to provide valid structured output after 5 attempts"],
            usage: {},
          };
          return;
        }
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "```json\n{\"answer\":\"raw fallback\"}\n```",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    }),
    outputValidator: {
      validate(value) {
        const candidate = value as Record<string, unknown>;
        return {
          success:
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            candidate.answer === "raw fallback",
          value,
        };
      },
    },
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-fallback",
    nodePath: "root/comment",
  });
  assert.equal(result.status, "ok");
  assert.equal(calls, 2);
  assert.ok(captured[0]!.options.outputFormat);
  assert.equal(captured[1]!.options.outputFormat, undefined);
  assert.match(captured[1]!.prompt, /Return ONLY the complete raw JSON object/);
});

test("turns session limits into credit blocks and removes partial task files", async () => {
  const root = mkdtempSync(join(tmpdir(), "credit-sandbox-"));
  let workspace = "";
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    taskWorkspaceRoot: root,
    creditRecovery: {
      resolver: async () => ({
        retryAt: Date.parse("2026-07-22T15:31:00.000Z"),
        source: "deterministic",
        timeZone: "Europe/Berlin",
      }),
    },
    queryFn: (input) => ({
      async *[Symbol.asyncIterator]() {
        workspace = String(input.options.cwd);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "partial-output.txt"), "partial");
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [
            "You've hit your session limit · resets 5:30pm (Europe/Berlin)",
          ],
          usage: {},
        };
      },
    }),
  });
  await assert.rejects(
    executor.execute(structuredTask, {
      runId: "credit-run",
      nodePath: "root/brain",
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "CreditBlockedError" &&
      "retryAt" in error &&
      error.retryAt === Date.parse("2026-07-22T15:31:00.000Z"),
  );
  assert.equal(existsSync(join(workspace, "partial-output.txt")), false);
  assert.equal(existsSync(workspace), false);
  rmSync(root, { recursive: true, force: true });
});

test("credit exhaustion without a reset time blocks for a manual resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-claude-manual-credit-"));
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    taskWorkspaceRoot: root,
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [
            "Your credit balance is too low to access the Anthropic API.",
          ],
          usage: {},
        };
      },
    }),
  });
  await assert.rejects(
    executor.execute(structuredTask, {
      runId: "manual-credit-run",
      nodePath: "root/brain",
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "CreditBlockedError" &&
      (error as { retryAt?: number }).retryAt === undefined &&
      (error as { source?: string }).source === "manual",
  );
  rmSync(root, { recursive: true, force: true });
});

test("returns a normalized error when Agent SDK execution fails", async () => {
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["oauth token rejected"],
          usage: {},
        };
      },
    }),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "error");
  assert.match(
    result.status === "error" ? result.error.message : "",
    /oauth token rejected/,
  );
});

test("a crashed Claude Code subprocess is retried in a fresh session before failing", async () => {
  // The SDK surfaces a nonzero subprocess exit as a thrown error whose
  // message can carry no reason at all (empty stderr): transient
  // infrastructure, retried without consuming validation attempts.
  let calls = 0;
  const queryFn: ClaudeAgentQueryFn = (input) => ({
    async *[Symbol.asyncIterator]() {
      calls += 1;
      if (calls === 1) {
        throw new Error("Claude Code process exited with code 1");
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({ answer: "recovered" }),
        structured_output: { answer: "recovered" },
        usage: { input_tokens: 3, output_tokens: 2 },
      };
      void input;
    },
  });
  const progressKinds: string[] = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn,
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
    reportProgress: (progress) => progressKinds.push(progress.kind),
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" && result.output, { answer: "recovered" });
  assert.equal(calls, 2, "the crashed attempt restarts once");
  assert.ok(progressKinds.includes("retry"), "the restart is reported as a retry");
});

test("a subprocess that keeps crashing fails after the bounded retries", async () => {
  let calls = 0;
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        calls += 1;
        throw new Error("Claude Code process terminated by signal SIGKILL");
        yield undefined; // makes this a generator; never reached
      },
    }),
  });
  const result = await executor.execute(structuredTask, {
    runId: "run-1",
    nodePath: "root/brain",
  });
  assert.equal(result.status, "error");
  assert.match(
    result.status === "error" ? result.error.message : "",
    /terminated by signal/,
  );
  assert.equal(calls, 3, "one attempt plus two crash retries");
});

test("pre-aborted execution propagates AbortError", async () => {
  const controller = new AbortController();
  controller.abort("stop");
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: successQuery([]),
  });
  await assert.rejects(
    executor.execute(structuredTask, {
      runId: "run-1",
      nodePath: "root/brain",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});

test("setup-token validation performs a real-shaped one-turn query", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  await validateClaudeSetupToken({
    token: "setup-token-secret",
    queryFn: successQuery(captured, "OK"),
  });
  assert.equal(captured[0]!.options.maxTurns, 1);
  assert.equal(
    (captured[0]!.options.env as Record<string, string>)
      .CLAUDE_CODE_OAUTH_TOKEN,
    "setup-token-secret",
  );
});


test("reasoning-trace routes get summarized thinking and stepwise tasks get the chain tool", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    maxValidationAttempts: 2,
    queryFn: successQuery(captured, {
      output: { type: "research idea" },
    }),
  });
  const result = await executor.execute(
    {
      ...structuredTask,
      input: { role: "brain", routeTraits: ["extended-reasoning"] },
      metadata: {
        stepwise: { tool: "submit_step", field: "cot", count: 3 },
      },
    },
    { runId: "run-stepwise", nodePath: "root/first-pass/member[0]" },
  );

  const options = captured[0]!.options;
  assert.deepEqual(options.thinking, {
    type: "adaptive",
    display: "summarized",
  });
  const tools = options.tools as string[];
  assert.ok(tools.includes("mcp__steps__submit_step"));
  const servers = options.mcpServers as Record<string, unknown>;
  assert.ok(servers.steps !== undefined);

  // The stubbed query never records submit_step calls, so the executor must
  // fail closed rather than accept a chainless result.
  assert.equal(result.status, "error");
  assert.match(
    result.status === "error" ? result.error.message : "",
    /3 steps must be submitted/,
  );
  assert.equal(captured.length, 2);
});

test("tasks without the trace trait keep the omitted thinking display", async () => {
  const captured: ClaudeAgentQueryInput[] = [];
  const executor = new ClaudeAgentExecutor({
    token: "setup-token-secret",
    queryFn: successQuery(captured),
  });
  await executor.execute(structuredTask, {
    runId: "run-untraced",
    nodePath: "root/brain",
  });
  assert.deepEqual(captured[0]!.options.thinking, {
    type: "adaptive",
    display: "omitted",
  });
  assert.equal(captured[0]!.options.mcpServers, undefined);
});
