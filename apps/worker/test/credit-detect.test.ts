import assert from "node:assert/strict";
import test from "node:test";

import {
  CreditBlockedError,
  type AgentExecutionContext,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
} from "@brainstorm-agentic/core";

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
