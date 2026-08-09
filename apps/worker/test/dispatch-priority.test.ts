import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutionContext,
  AgentTask,
  JsonValue,
  ModelRequest,
  ModelResponse,
} from "@brainstorm-agentic/core";
import type {
  AgentTaskModelAdapter,
  ModelRoute,
} from "@brainstorm-agentic/agent-runtime";

import { DispatchPriorityTaskAdapter } from "../src/wiring.js";

const context: AgentExecutionContext = { runId: "run-1", nodePath: "root" };
const route: ModelRoute = { modelId: "model-1" };

function innerAdapter(): AgentTaskModelAdapter & { outputs: JsonValue[] } {
  const outputs: JsonValue[] = [];
  return {
    outputs,
    createRequest(task: AgentTask): ModelRequest {
      return {
        modelId: "model-1",
        messages: [],
        metadata: { nodeId: `${task.kind}-node` },
      };
    },
    responseToOutput(): JsonValue {
      outputs.push("delegated");
      return "delegated";
    },
  };
}

function taskOf(kind: string): AgentTask {
  return { taskId: `t-${kind}`, kind, input: {} };
}

test("a round's gating calls dispatch high; everything else stays normal", () => {
  const adapter = new DispatchPriorityTaskAdapter(innerAdapter());
  const judged = adapter.createRequest(taskOf("brainstorm.judge"), context, route);
  const redeveloped = adapter.createRequest(
    taskOf("brainstorm.redeveloper"),
    context,
    route,
  );
  const comment = adapter.createRequest(taskOf("brainstorm.commentor"), context, route);
  const brain = adapter.createRequest(taskOf("brainstorm.brain"), context, route);

  assert.equal(judged.metadata?.dispatchPriority, "high");
  assert.equal(redeveloped.metadata?.dispatchPriority, "high");
  assert.equal(comment.metadata?.dispatchPriority, "normal");
  assert.equal(brain.metadata?.dispatchPriority, "normal");
  // The inner adapter's metadata survives the stamp.
  assert.equal(judged.metadata?.nodeId, "brainstorm.judge-node");
});

test("response mapping delegates untouched", () => {
  const inner = innerAdapter();
  const adapter = new DispatchPriorityTaskAdapter(inner);
  const value = adapter.responseToOutput(
    {} as ModelResponse,
    taskOf("brainstorm.judge"),
    context,
    route,
  );
  assert.equal(value, "delegated");
  assert.deepEqual(inner.outputs, ["delegated"]);
});
