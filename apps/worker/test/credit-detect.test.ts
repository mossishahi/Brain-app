import assert from "node:assert/strict";
import test from "node:test";

import {
  CreditBlockedError,
  InMemoryCheckpointStore,
  WorkflowFunctions,
  WorkflowRunner,
  agent,
  workflow,
  type AgentExecutionContext,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
} from "@brainstorm-agentic/core";
import { FixedModelRouteResolver, ToolLoopAgentExecutor, ToolRegistry } from "@brainstorm-agentic/agent-runtime";
import { GeminiModelProvider, type GeminiClient } from "@brainstorm-agentic/provider-gemini";

import { CreditBlockDetectingAgentExecutor } from "../src/wiring.js";

const task: AgentTask = {
  taskId: "task-1",
  kind: "brainstorm.brain",
  input: { role: "brain" },
};

const context: AgentExecutionContext = {
  runId: "run-1",
  nodePath: "root/brain",
};

function returning(result: AgentResult): AgentExecutor {
  return { execute: async () => result };
}

function throwing(error: unknown): AgentExecutor {
  return {
    execute: async () => {
      throw error;
    },
  };
}

test("converts a credit-exhaustion task failure into a manual credit block", async () => {
  const inner = returning({
    taskId: "task-1",
    status: "error",
    error: {
      name: "AnthropicProviderError",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  });
  await assert.rejects(
    new CreditBlockDetectingAgentExecutor(inner).execute(task, context),
    (error: unknown) =>
      error instanceof CreditBlockedError &&
      error.retryAt === undefined &&
      error.source === "manual",
  );
});

test("parses the reset time from a thrown provider limit error", async () => {
  const before = Date.now();
  const inner = throwing(
    new Error("You've hit your usage limit · resets in 2h"),
  );
  await assert.rejects(
    new CreditBlockDetectingAgentExecutor(inner, {
      safetyBufferSeconds: 60,
    }).execute(task, context),
    (error: unknown) => {
      if (!(error instanceof CreditBlockedError)) return false;
      if (error.source !== "deterministic") return false;
      const twoHours = 2 * 60 * 60 * 1000;
      return (
        typeof error.retryAt === "number" &&
        error.retryAt >= before + twoHours &&
        error.retryAt <= Date.now() + twoHours + 61_000
      );
    },
  );
});

test("passes non-credit failures and successes through unchanged", async () => {
  const failure: AgentResult = {
    taskId: "task-1",
    status: "error",
    error: { name: "Error", message: "the model returned invalid JSON" },
  };
  assert.deepEqual(
    await new CreditBlockDetectingAgentExecutor(returning(failure)).execute(
      task,
      context,
    ),
    failure,
  );
  const ok: AgentResult = {
    taskId: "task-1",
    status: "ok",
    output: { fine: true },
  };
  assert.deepEqual(
    await new CreditBlockDetectingAgentExecutor(returning(ok)).execute(
      task,
      context,
    ),
    ok,
  );
});

test("rethrows an already-typed credit block unchanged", async () => {
  const typed = new CreditBlockedError(
    Date.parse("2026-07-22T15:31:00.000Z"),
    "session limit resets 5:30pm",
    "deterministic",
  );
  await assert.rejects(
    new CreditBlockDetectingAgentExecutor(throwing(typed)).execute(
      task,
      context,
    ),
    (error: unknown) => error === typed,
  );
});

test("Gemini daily quota checkpoints once and resumes through the worker wrapper", async () => {
  let calls = 0;
  const client: GeminiClient = { models: {
    async generateContent() {
      calls++;
      if (calls === 1) throw Object.assign(new Error(JSON.stringify({ error: { details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{
          quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
          quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20",
        }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "51194s" },
      ] } })), { status: 429 });
      return { candidates: [{ content: { parts: [{ text: "Resumed successfully." }] }, finishReason: "STOP" }] };
    },
    async list() { return (async function* () {})(); },
  } };
  const provider = new GeminiModelProvider({ apiKey: "unused", client });
  const executor = new CreditBlockDetectingAgentExecutor(new ToolLoopAgentExecutor({
    provider, tools: new ToolRegistry(),
    modelRouteResolver: new FixedModelRouteResolver({ modelId: "gemini-3.5-flash" }),
    retry: { sleep: async () => assert.fail("Daily quota must checkpoint rather than sleep or retry") },
  }));
  const checkpoints = new InMemoryCheckpointStore();
  const functions = new WorkflowFunctions().registerTaskBuilder("quotaTask", () => ({ kind: "quota.test", input: "Answer." }));
  const definition = workflow("quota", agent("quotaTask", { id: "work" }));
  const runner = new WorkflowRunner({ functions, agentExecutor: executor, checkpoints });
  const before = Date.now();
  const first = await runner.run(definition, { runId: "gemini-quota-run" });
  assert.equal(first.status, "credit_blocked");
  const checkpoint = await checkpoints.load("gemini-quota-run");
  assert.equal(checkpoint?.status, "credit_blocked");
  assert.equal(checkpoint?.journal.length, 0);
  assert.ok(checkpoint!.creditBlock!.retryAt! >= before + 51_194_000);
  assert.match(checkpoint!.creditBlock!.providerMessage, /daily.*quota/i);
  assert.equal(calls, 1);

  const resumed = await runner.resume(definition, "gemini-quota-run");
  assert.equal(resumed.status, "completed");
  assert.equal(calls, 2);
});
