import type { JsonObject, JsonValue } from "../types/json.js";
import { cloneJson } from "../types/json.js";

/** Read-only view of a scope chain, handed to registered functions. */
export interface ScopeReader {
  get(name: string): JsonValue | undefined;
  has(name: string): boolean;
  /** Flattened view (leaf frames shadow parents). */
  snapshot(): JsonObject;
}

/**
 * Lexically chained variable frames.
 *
 * Rules (kept deliberately simple so journal replay is deterministic):
 * - `get`/`has` walk the chain from leaf to root.
 * - `set` always writes to the *current* frame.
 * - `sequence`, `condition` and `repeatUntil` bodies run in an enclosing
 *   frame; `forEach` iterations and `parallel` branches each get an isolated
 *   child frame, and their values flow outward via node return values and
 *   `resultKey` aggregation on the loop/parallel node itself.
 */
export class Scope implements ScopeReader {
  private readonly vars = new Map<string, JsonValue>();

  constructor(private readonly parent?: Scope) {}

  static root(input?: JsonObject): Scope {
    const scope = new Scope();
    if (input) {
      for (const [key, value] of Object.entries(input)) {
        scope.set(key, cloneJson(value));
      }
    }
    return scope;
  }

  get(name: string): JsonValue | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.get(name);
  }

  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }

  set(name: string, value: JsonValue): void {
    this.vars.set(name, value);
  }

  child(): Scope {
    return new Scope(this);
  }

  snapshot(): JsonObject {
    const merged: { [key: string]: JsonValue } = this.parent ? { ...this.parent.snapshot() } : {};
    for (const [key, value] of this.vars) merged[key] = value;
    return merged;
  }
}
