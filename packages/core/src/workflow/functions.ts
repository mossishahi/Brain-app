/**
 * Named-function registry. The workflow AST never embeds code or eval-able
 * expressions: conditions, collection resolvers, selectors, activities, and
 * agent-task builders are all plain host functions registered by name and
 * referenced from nodes as strings.
 */
import type { AgentTask } from "../agent/contracts.js";
import { WorkflowConfigError } from "../errors.js";
import type { ArtifactStore } from "../store/artifacts.js";
import type { JsonArray, JsonValue } from "../types/json.js";
import type { ScopeReader } from "./scope.js";

export interface FunctionContext {
  readonly runId: string;
  /** Execution path of the node that invoked this function. */
  readonly nodePath: string;
  readonly signal: AbortSignal;
  readonly artifacts?: ArtifactStore;
}

export type ConditionFn = (scope: ScopeReader, context: FunctionContext) => boolean | Promise<boolean>;

export type CollectionFn = (scope: ScopeReader, context: FunctionContext) => JsonArray | Promise<JsonArray>;

export type SelectorFn = (
  scope: ScopeReader,
  context: FunctionContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export type ActivityFn = (
  input: JsonValue | undefined,
  scope: ScopeReader,
  context: FunctionContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

/** Everything of an AgentTask except the taskId, which the runner derives. */
export type AgentTaskSpec = Omit<AgentTask, "taskId">;

export type TaskBuilderFn = (
  scope: ScopeReader,
  params: JsonValue | undefined,
  context: FunctionContext,
) => AgentTaskSpec | Promise<AgentTaskSpec>;

export class WorkflowFunctions {
  private readonly conditions = new Map<string, ConditionFn>();
  private readonly collections = new Map<string, CollectionFn>();
  private readonly selectors = new Map<string, SelectorFn>();
  private readonly activities = new Map<string, ActivityFn>();
  private readonly taskBuilders = new Map<string, TaskBuilderFn>();

  registerCondition(name: string, fn: ConditionFn): this {
    return this.add(this.conditions, "condition", name, fn);
  }

  registerCollection(name: string, fn: CollectionFn): this {
    return this.add(this.collections, "collection", name, fn);
  }

  registerSelector(name: string, fn: SelectorFn): this {
    return this.add(this.selectors, "selector", name, fn);
  }

  registerActivity(name: string, fn: ActivityFn): this {
    return this.add(this.activities, "activity", name, fn);
  }

  registerTaskBuilder(name: string, fn: TaskBuilderFn): this {
    return this.add(this.taskBuilders, "taskBuilder", name, fn);
  }

  condition(name: string): ConditionFn {
    return this.lookup(this.conditions, "condition", name);
  }

  collection(name: string): CollectionFn {
    return this.lookup(this.collections, "collection", name);
  }

  selector(name: string): SelectorFn {
    return this.lookup(this.selectors, "selector", name);
  }

  activity(name: string): ActivityFn {
    return this.lookup(this.activities, "activity", name);
  }

  taskBuilder(name: string): TaskBuilderFn {
    return this.lookup(this.taskBuilders, "taskBuilder", name);
  }

  private add<T>(map: Map<string, T>, kind: string, name: string, fn: T): this {
    if (map.has(name)) {
      throw new WorkflowConfigError(`${kind} "${name}" is already registered`);
    }
    map.set(name, fn);
    return this;
  }

  private lookup<T>(map: Map<string, T>, kind: string, name: string): T {
    const fn = map.get(name);
    if (!fn) {
      throw new WorkflowConfigError(`${kind} "${name}" is not registered`);
    }
    return fn;
  }
}
