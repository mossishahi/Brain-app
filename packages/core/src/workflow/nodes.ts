/**
 * Builtin node executors. Each executor is registered by node kind in a
 * NodeExecutorRegistry; hosts can add custom kinds alongside these.
 *
 * Branch-combination precedence for forEach/parallel (deterministic, checked
 * in sibling-index order once all branches have settled):
 *   cancellation > hard error > terminal signal > suspension (gates merged).
 */
import type { AgentTask } from "../agent/contracts.js";
import {
  AgentTaskFailedError,
  MaxIterationsExceededError,
  WorkflowCancelledError,
  WorkflowConfigError,
  isCancellation,
} from "../errors.js";
import type { JsonValue } from "../types/json.js";
import type {
  ActivityNode,
  AgentNode,
  ConditionNode,
  ForEachNode,
  HumanGateNode,
  ParallelNode,
  ReduceNode,
  RepeatUntilNode,
  SequenceNode,
  TerminalNode,
} from "./ast.js";
import { nodeSegment } from "./ast.js";
import type { PendingGate } from "./checkpoint.js";
import type { NodeExecutor } from "./registry.js";
import { NodeExecutorRegistry } from "./registry.js";
import { SuspendSignal, TerminalSignal } from "./signals.js";
import type { Settled } from "../util/concurrency.js";
import { settleWithConcurrency } from "../util/concurrency.js";

function combineSettledBranches(settled: readonly Settled<JsonValue | undefined>[]): (JsonValue | null)[] {
  const rejections: unknown[] = [];
  for (const outcome of settled) {
    if (outcome.status === "rejected") rejections.push(outcome.reason);
  }
  if (rejections.length === 0) {
    return settled.map((outcome) => (outcome.status === "fulfilled" ? (outcome.value ?? null) : null));
  }
  const cancellations = rejections.filter((reason) => isCancellation(reason));
  if (cancellations.length > 0) throw cancellations[0];
  const hardErrors = rejections.filter(
    (reason) => !(reason instanceof SuspendSignal) && !(reason instanceof TerminalSignal),
  );
  if (hardErrors.length > 0) throw hardErrors[0];
  const terminals = rejections.filter((reason): reason is TerminalSignal => reason instanceof TerminalSignal);
  if (terminals.length > 0) throw terminals[0];
  const suspensions = rejections.filter((reason): reason is SuspendSignal => reason instanceof SuspendSignal);
  throw new SuspendSignal(suspensions.flatMap((signal) => signal.pendingGates));
}

const executeSequence: NodeExecutor = async (node, context) => {
  const spec = node as SequenceNode;
  let last: JsonValue | undefined;
  for (const [index, childNode] of spec.children.entries()) {
    last = await context.child(childNode, nodeSegment(childNode, index));
  }
  return last;
};

const executeActivity: NodeExecutor = async (node, context) => {
  const spec = node as ActivityNode;
  if (spec.input !== undefined && spec.inputFrom !== undefined) {
    throw new WorkflowConfigError(`activity node at "${context.path}" sets both input and inputFrom`);
  }
  const produce = async () => {
    const fn = context.functions.activity(spec.activity);
    const input =
      spec.inputFrom !== undefined
        ? await context.functions.selector(spec.inputFrom)(context.scope, context.fnContext())
        : spec.input;
    return await fn(input, context.scope, context.fnContext());
  };
  let value: JsonValue | undefined;
  if (spec.journal === false) {
    // A deterministic fold: re-run on first execution AND on every replay,
    // never journaled. State rebuilding stays exact because the fold's
    // inputs (scope state plus recorded effects) replay identically; the
    // journal stays bounded by the run's real outputs instead of carrying
    // a state copy per executed node.
    if (context.signal.aborted) throw new WorkflowCancelledError();
    value = await produce();
  } else {
    ({ value } = await context.effect("result", "activity", produce));
  }
  if (spec.resultKey !== undefined) context.scope.set(spec.resultKey, value ?? null);
  return value;
};

const executeAgent: NodeExecutor = async (node, context) => {
  const spec = node as AgentNode;
  const { value } = await context.effect("result", "agent", async () => {
    if (!context.agentExecutor) {
      throw new WorkflowConfigError(`agent node at "${context.path}" requires an AgentExecutor on the runner`);
    }
    const builder = context.functions.taskBuilder(spec.taskBuilder);
    const taskSpec = await builder(context.scope, spec.params, context.fnContext());
    const task: AgentTask = { taskId: `${context.runId}:${context.path}`, ...taskSpec };
    context.emit({ type: "agent:started", path: context.path, taskId: task.taskId, taskKind: task.kind });
    const result = await context.agentExecutor.execute(task, {
      runId: context.runId,
      nodePath: context.path,
      signal: context.signal,
      reportProgress: (progress) =>
        context.emit({
          type: "agent:progress",
          path: context.path,
          taskId: task.taskId,
          taskKind: task.kind,
          progress,
        }),
    });
    context.emit({
      type: "agent:completed",
      path: context.path,
      taskId: task.taskId,
      taskKind: task.kind,
      status: result.status,
    });
    if (result.status === "error") {
      // Failures are never journaled: a resumed run re-executes the task.
      throw new AgentTaskFailedError(task.taskId, result.error);
    }
    // AgentResult carries only JSON-safe data by contract.
    return result as unknown as JsonValue;
  });
  const output = value === undefined ? undefined : (value as { readonly output?: JsonValue }).output;
  if (spec.resultKey !== undefined) context.scope.set(spec.resultKey, output ?? null);
  return output;
};

function indexBase(value: 0 | 1 | undefined, path: string): 0 | 1 {
  const base = value ?? 0;
  if (base !== 0 && base !== 1) {
    throw new WorkflowConfigError(`node at "${path}" has invalid indexBase=${String(value)}; expected 0 or 1`);
  }
  return base;
}

const executeForEach: NodeExecutor = async (node, context) => {
  const spec = node as ForEachNode;
  const { value: itemsValue } = await context.effect("items", "items", async () => {
    const items = await context.functions.collection(spec.itemsFrom)(context.scope, context.fnContext());
    if (!Array.isArray(items)) {
      throw new WorkflowConfigError(`collection "${spec.itemsFrom}" did not produce an array`);
    }
    return items as JsonValue;
  });
  const items = itemsValue as readonly JsonValue[];
  const base = indexBase(spec.indexBase, context.path);
  const settled = await settleWithConcurrency(items, spec.concurrency ?? Infinity, async (item, index) => {
    const frame = context.scope.child();
    frame.set(spec.itemVar, item);
    if (spec.indexVar !== undefined) frame.set(spec.indexVar, index + base);
    return await context.child(spec.body, `${spec.itemVar}[${index}]`, frame);
  });
  const results = combineSettledBranches(settled);
  if (spec.resultKey !== undefined) context.scope.set(spec.resultKey, results);
  return results;
};

const executeReduce: NodeExecutor = async (node, context) => {
  const spec = node as ReduceNode;
  const { value: itemsValue } = await context.effect("items", "items", async () => {
    const items = await context.functions.collection(spec.itemsFrom)(context.scope, context.fnContext());
    if (!Array.isArray(items)) {
      throw new WorkflowConfigError(`collection "${spec.itemsFrom}" did not produce an array`);
    }
    return items as JsonValue;
  });
  const items = itemsValue as readonly JsonValue[];
  const base = indexBase(spec.indexBase, context.path);
  let accumulator = await context.functions.selector(spec.initialFrom)(context.scope, context.fnContext());
  if (accumulator === undefined) {
    throw new WorkflowConfigError(
      `reduce node at "${context.path}" initial selector "${spec.initialFrom}" returned undefined`,
    );
  }
  for (const [index, item] of items.entries()) {
    const frame = context.scope.child();
    frame.set(spec.accumulatorVar, accumulator);
    frame.set(spec.itemVar, item);
    if (spec.indexVar !== undefined) frame.set(spec.indexVar, index + base);
    await context.child(spec.body, `${spec.itemVar}[${index}]`, frame);
    const next = await context.functions.selector(spec.nextFrom)(frame, context.fnContext());
    if (next === undefined) {
      throw new WorkflowConfigError(
        `reduce node at "${context.path}" next selector "${spec.nextFrom}" returned undefined at index ${index}`,
      );
    }
    accumulator = next;
  }
  context.scope.set(spec.resultKey, accumulator);
  return accumulator;
};

const executeParallel: NodeExecutor = async (node, context) => {
  const spec = node as ParallelNode;
  const settled = await settleWithConcurrency(spec.branches, spec.concurrency ?? Infinity, (branch, index) =>
    context.child(branch, nodeSegment(branch, index), context.scope.child()),
  );
  const results = combineSettledBranches(settled);
  if (spec.resultKey !== undefined) context.scope.set(spec.resultKey, results);
  return results;
};

const executeRepeatUntil: NodeExecutor = async (node, context) => {
  const spec = node as RepeatUntilNode;
  if (!Number.isInteger(spec.maxIterations) || spec.maxIterations < 1) {
    throw new WorkflowConfigError(
      `repeatUntil node at "${context.path}" needs a positive integer maxIterations, got ${spec.maxIterations}`,
    );
  }
  // One loop frame for the whole loop: iterationVar and any accumulator
  // variables set by the body persist across iterations but do not leak out.
  const loopScope = context.scope.child();
  let last: JsonValue | undefined;
  let satisfied = false;
  for (let iteration = 0; iteration < spec.maxIterations; iteration++) {
    if (spec.iterationVar !== undefined) loopScope.set(spec.iterationVar, iteration);
    last = await context.child(spec.body, `iter[${iteration}]`, loopScope);
    const { value: done } = await context.effect(`until[${iteration}]`, "condition", async () => {
      return (await context.functions.condition(spec.condition)(loopScope, context.fnContext())) === true;
    });
    if (done === true) {
      satisfied = true;
      break;
    }
  }
  if (!satisfied && (spec.onMaxIterations ?? "fail") === "fail") {
    throw new MaxIterationsExceededError(context.path, spec.maxIterations);
  }
  if (spec.resultKey !== undefined) context.scope.set(spec.resultKey, last ?? null);
  return last;
};

const executeCondition: NodeExecutor = async (node, context) => {
  const spec = node as ConditionNode;
  const { value: verdict } = await context.effect("cond", "condition", async () => {
    return (await context.functions.condition(spec.condition)(context.scope, context.fnContext())) === true;
  });
  if (verdict === true) return await context.child(spec.then, "then");
  if (spec.else !== undefined) return await context.child(spec.else, "else");
  return undefined;
};

function coercePrompt(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

const executeHumanGate: NodeExecutor = async (node, context) => {
  const spec = node as HumanGateNode;
  const lookup = context.lookupEffect("response");
  if (!lookup.hit) {
    const prompt =
      spec.promptFrom !== undefined
        ? coercePrompt(await context.functions.selector(spec.promptFrom)(context.scope, context.fnContext()))
        : spec.prompt;
    const gateKey = spec.gateKey ?? context.path;
    const gate: PendingGate = {
      gateKey,
      journalKey: context.journalKey("response"),
      path: context.path,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
    };
    context.emit({
      type: "gate:pending",
      path: context.path,
      gateKey,
      ...(prompt !== undefined ? { prompt } : {}),
    });
    throw new SuspendSignal([gate]);
  }
  const response = lookup.value;
  context.emit({ type: "gate:resolved", path: context.path, gateKey: spec.gateKey ?? context.path });
  if (spec.resultKey !== undefined) context.scope.set(spec.resultKey, response ?? null);
  return response;
};

const executeTerminal: NodeExecutor = async (node, context) => {
  const spec = node as TerminalNode;
  const output =
    spec.outputFrom !== undefined
      ? await context.functions.selector(spec.outputFrom)(context.scope, context.fnContext())
      : spec.output;
  throw new TerminalSignal(spec.outcome, output, spec.reason);
};

export const BUILTIN_NODE_KINDS = [
  "sequence",
  "activity",
  "agent",
  "forEach",
  "reduce",
  "parallel",
  "repeatUntil",
  "condition",
  "humanGate",
  "terminal",
] as const;

export type BuiltinNodeKind = (typeof BUILTIN_NODE_KINDS)[number];

/** Fresh registry with all builtin executors; hosts may register more. */
export function createBuiltinExecutorRegistry(): NodeExecutorRegistry {
  return new NodeExecutorRegistry()
    .register("sequence", executeSequence)
    .register("activity", executeActivity)
    .register("agent", executeAgent)
    .register("forEach", executeForEach)
    .register("reduce", executeReduce)
    .register("parallel", executeParallel)
    .register("repeatUntil", executeRepeatUntil)
    .register("condition", executeCondition)
    .register("humanGate", executeHumanGate)
    .register("terminal", executeTerminal);
}

// Exported for hosts implementing custom fan-out executors that want the
// same deterministic branch-combination semantics as forEach/parallel.
export { combineSettledBranches };
