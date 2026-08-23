/** Typed convenience constructors for the workflow AST. */
import type { JsonObject, JsonValue } from "../types/json.js";
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
  WorkflowDefinition,
  WorkflowNode,
} from "./ast.js";

interface BaseOptions {
  readonly id?: string;
  readonly description?: string;
}

export function sequence(children: readonly WorkflowNode[], options: BaseOptions = {}): SequenceNode {
  return { kind: "sequence", children, ...options };
}

export function activity(
  activityName: string,
  options: BaseOptions & {
    readonly input?: JsonValue;
    readonly inputFrom?: string;
    readonly resultKey?: string;
    /** false = deterministic fold, re-run on every pass and never journaled. */
    readonly journal?: boolean;
  } = {},
): ActivityNode {
  return { kind: "activity", activity: activityName, ...options };
}

export function agent(
  taskBuilder: string,
  options: BaseOptions & {
    readonly params?: JsonValue;
    readonly resultKey?: string;
    readonly resultMetadataKey?: string;
  } = {},
): AgentNode {
  return { kind: "agent", taskBuilder, ...options };
}

export function forEach(
  options: BaseOptions & {
    readonly itemsFrom: string;
    readonly itemVar: string;
    readonly indexVar?: string;
    readonly indexBase?: 0 | 1;
    readonly body: WorkflowNode;
    readonly concurrency?: number;
    readonly resultKey?: string;
  },
): ForEachNode {
  return { kind: "forEach", ...options };
}

export function reduce(
  options: BaseOptions & {
    readonly itemsFrom: string;
    readonly itemVar: string;
    readonly indexVar?: string;
    readonly indexBase?: 0 | 1;
    readonly accumulatorVar: string;
    readonly initialFrom: string;
    readonly body: WorkflowNode;
    readonly nextFrom: string;
    readonly resultKey: string;
  },
): ReduceNode {
  return { kind: "reduce", ...options };
}

export function parallel(
  branches: readonly WorkflowNode[],
  options: BaseOptions & { readonly concurrency?: number; readonly resultKey?: string } = {},
): ParallelNode {
  return { kind: "parallel", branches, ...options };
}

export function repeatUntil(
  options: BaseOptions & {
    readonly body: WorkflowNode;
    readonly condition: string;
    readonly maxIterations: number;
    readonly onMaxIterations?: "fail" | "continue";
    readonly iterationVar?: string;
    readonly resultKey?: string;
  },
): RepeatUntilNode {
  return { kind: "repeatUntil", ...options };
}

export function condition(
  conditionName: string,
  thenNode: WorkflowNode,
  elseNode?: WorkflowNode,
  options: BaseOptions = {},
): ConditionNode {
  const node: ConditionNode = { kind: "condition", condition: conditionName, then: thenNode, ...options };
  return elseNode ? { ...node, else: elseNode } : node;
}

export function humanGate(
  options: BaseOptions & {
    readonly gateKey?: string;
    readonly prompt?: string;
    readonly promptFrom?: string;
    readonly resultKey?: string;
    readonly metadata?: JsonObject;
  } = {},
): HumanGateNode {
  return { kind: "humanGate", ...options };
}

export function terminal(
  outcome: "success" | "failure",
  options: BaseOptions & {
    readonly reason?: string;
    readonly output?: JsonValue;
    readonly outputFrom?: string;
  } = {},
): TerminalNode {
  return { kind: "terminal", outcome, ...options };
}

export function workflow(
  id: string,
  root: WorkflowNode,
  options: { readonly version?: string; readonly description?: string } = {},
): WorkflowDefinition {
  return { id, root, ...options };
}
