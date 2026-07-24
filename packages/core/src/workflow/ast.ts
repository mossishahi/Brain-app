/**
 * Composable workflow AST. Nodes are pure JSON data: every piece of behavior
 * (conditions, collection resolvers, selectors, activities, agent task
 * builders) is referenced *by name* and resolved against a WorkflowFunctions
 * registry at runtime. No eval, no serialized code.
 */
import type { JsonObject, JsonValue } from "../types/json.js";

export interface WorkflowNodeBase {
  readonly kind: string;
  /** Optional stable id; used in node paths, journal keys and events. */
  readonly id?: string;
  readonly description?: string;
}

/** Open node type so hosts can add custom kinds via the executor registry. */
export type WorkflowNode = WorkflowNodeBase;

export interface SequenceNode extends WorkflowNodeBase {
  readonly kind: "sequence";
  readonly children: readonly WorkflowNode[];
}

export interface ActivityNode extends WorkflowNodeBase {
  readonly kind: "activity";
  /** Name of a registered activity function (the effect to run). */
  readonly activity: string;
  /** Static input passed to the activity. Mutually exclusive with inputFrom. */
  readonly input?: JsonValue;
  /** Name of a registered selector that computes the input from scope. */
  readonly inputFrom?: string;
  /** Scope key (current frame) that receives the activity's return value. */
  readonly resultKey?: string;
}

export interface AgentNode extends WorkflowNodeBase {
  readonly kind: "agent";
  /** Name of a registered task builder producing the AgentTask spec. */
  readonly taskBuilder: string;
  /** Static params forwarded to the task builder. */
  readonly params?: JsonValue;
  /** Scope key that receives the agent result's output. */
  readonly resultKey?: string;
}

export interface ForEachNode extends WorkflowNodeBase {
  readonly kind: "forEach";
  /** Name of a registered collection resolver producing the items. */
  readonly itemsFrom: string;
  /** Variable name bound to the current item in the iteration frame. */
  readonly itemVar: string;
  /** Optional variable name bound to the item index. */
  readonly indexVar?: string;
  /** Index exposed to indexVar; defaults to 0 for JavaScript-style loops. */
  readonly indexBase?: 0 | 1;
  readonly body: WorkflowNode;
  /** Max simultaneous iterations; default: unbounded. */
  readonly concurrency?: number;
  /** Scope key that receives the array of per-item body results (item order). */
  readonly resultKey?: string;
}

/**
 * Sequential collection fold with explicit accumulator threading.
 *
 * The initial accumulator and each next accumulator are produced by named
 * selectors. This keeps the AST data-only while allowing nested workflows to
 * preserve state across iterations without shared mutable branch state.
 */
export interface ReduceNode extends WorkflowNodeBase {
  readonly kind: "reduce";
  readonly itemsFrom: string;
  readonly itemVar: string;
  readonly indexVar?: string;
  readonly indexBase?: 0 | 1;
  /** Variable bound to the current accumulator in each iteration frame. */
  readonly accumulatorVar: string;
  /** Selector evaluated in the enclosing scope before the first iteration. */
  readonly initialFrom: string;
  readonly body: WorkflowNode;
  /** Selector evaluated in the iteration frame after body completion. */
  readonly nextFrom: string;
  /** Enclosing-scope key receiving the final accumulator. */
  readonly resultKey: string;
}

export interface ParallelNode extends WorkflowNodeBase {
  readonly kind: "parallel";
  readonly branches: readonly WorkflowNode[];
  /** Max simultaneous branches; default: unbounded. */
  readonly concurrency?: number;
  /** Scope key that receives the array of branch results (branch order). */
  readonly resultKey?: string;
}

export interface RepeatUntilNode extends WorkflowNodeBase {
  readonly kind: "repeatUntil";
  readonly body: WorkflowNode;
  /** Name of a registered condition; evaluated after each iteration. */
  readonly condition: string;
  readonly maxIterations: number;
  /** What to do when maxIterations elapse without the condition holding. */
  readonly onMaxIterations?: "fail" | "continue";
  /** Variable bound to the 0-based iteration counter in the loop frame. */
  readonly iterationVar?: string;
  /** Scope key that receives the last body result. */
  readonly resultKey?: string;
}

export interface ConditionNode extends WorkflowNodeBase {
  readonly kind: "condition";
  /** Name of a registered condition function. */
  readonly condition: string;
  readonly then: WorkflowNode;
  readonly else?: WorkflowNode;
}

export interface HumanGateNode extends WorkflowNodeBase {
  readonly kind: "humanGate";
  /** Stable id used to address the gate when resuming; defaults to the node path. */
  readonly gateKey?: string;
  readonly prompt?: string;
  /** Name of a registered selector producing a dynamic prompt. */
  readonly promptFrom?: string;
  /** Scope key that receives the human-supplied value. */
  readonly resultKey?: string;
  readonly metadata?: JsonObject;
}

export interface TerminalNode extends WorkflowNodeBase {
  readonly kind: "terminal";
  readonly outcome: "success" | "failure";
  readonly reason?: string;
  readonly output?: JsonValue;
  /** Name of a registered selector producing the run output from scope. */
  readonly outputFrom?: string;
}

export type BuiltinWorkflowNode =
  | SequenceNode
  | ActivityNode
  | AgentNode
  | ForEachNode
  | ReduceNode
  | ParallelNode
  | RepeatUntilNode
  | ConditionNode
  | HumanGateNode
  | TerminalNode;

export interface WorkflowDefinition {
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  readonly root: WorkflowNode;
}

/** Deterministic path segment for a child node at a sibling index. */
export function nodeSegment(node: WorkflowNode, index: number): string {
  return node.id ?? `${node.kind}#${index}`;
}
