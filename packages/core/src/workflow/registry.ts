import type { AgentExecutor } from "../agent/contracts.js";
import { WorkflowConfigError } from "../errors.js";
import type { ArtifactStore } from "../store/artifacts.js";
import type { JsonValue } from "../types/json.js";
import type { WorkflowNode } from "./ast.js";
import type { RunEventBody } from "./events.js";
import type { FunctionContext, WorkflowFunctions } from "./functions.js";
import type { JournalEntryKind, JournalLookup } from "./journal.js";
import type { Scope } from "./scope.js";

export interface EffectResult {
  readonly value: JsonValue | undefined;
  /** True when the value was served from the journal instead of executing. */
  readonly replayed: boolean;
}

/**
 * Runtime services handed to a NodeExecutor. Custom node kinds get exactly
 * the same API the builtin executors are implemented with.
 */
export interface NodeExecutionContext {
  readonly runId: string;
  /** Deterministic execution path of the current node, e.g. "root/loop/item[2]/draft". */
  readonly path: string;
  /** Variable frame the node executes in. */
  readonly scope: Scope;
  readonly signal: AbortSignal;
  readonly functions: WorkflowFunctions;
  readonly artifacts?: ArtifactStore | undefined;
  readonly agentExecutor?: AgentExecutor | undefined;
  /**
   * Recursively executes a child node. `segment` must be deterministic and
   * unique among the node's children (include iteration indices); it becomes
   * part of the child's execution path and therefore of its journal keys.
   */
  child(node: WorkflowNode, segment: string, scope?: Scope): Promise<JsonValue | undefined>;
  /**
   * Journal-mediated effect. If a value is already recorded under this node's
   * path + slot it is returned without executing `produce` (replay);
   * otherwise `produce` runs, the value is recorded, and a checkpoint is
   * saved before the effect resolves.
   */
  effect(
    slot: string,
    kind: JournalEntryKind,
    produce: () => JsonValue | undefined | Promise<JsonValue | undefined>,
  ): Promise<EffectResult>;
  /** Journal key for a slot of this node ("<path>::<slot>"). */
  journalKey(slot: string): string;
  /** Non-executing journal peek (used by humanGate to detect a response). */
  lookupEffect(slot: string): JournalLookup;
  /** Emits a run event (runner stamps runId/seq/timestamp). */
  emit(body: RunEventBody): void;
  /** Context object passed to registered host functions. */
  fnContext(): FunctionContext;
}

export type NodeExecutor = (node: WorkflowNode, context: NodeExecutionContext) => Promise<JsonValue | undefined>;

/**
 * Extensible dispatch table mapping node `kind` to executor. Hosts may
 * register custom kinds or override builtins on their own registry instance.
 */
export class NodeExecutorRegistry {
  private readonly executors = new Map<string, NodeExecutor>();

  register(kind: string, executor: NodeExecutor, options: { readonly override?: boolean } = {}): this {
    if (!options.override && this.executors.has(kind)) {
      throw new WorkflowConfigError(`node executor for kind "${kind}" is already registered`);
    }
    this.executors.set(kind, executor);
    return this;
  }

  get(kind: string): NodeExecutor {
    const executor = this.executors.get(kind);
    if (!executor) {
      throw new WorkflowConfigError(`no node executor registered for kind "${kind}"`);
    }
    return executor;
  }

  has(kind: string): boolean {
    return this.executors.has(kind);
  }

  kinds(): readonly string[] {
    return [...this.executors.keys()];
  }
}
