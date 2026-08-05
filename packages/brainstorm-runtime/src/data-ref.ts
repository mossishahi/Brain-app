import type { BindValue } from "@brainstorm-agentic/content";
import type { JsonObject, JsonValue, ScopeReader } from "@brainstorm-agentic/core";

import { DataReferenceError } from "./errors.js";

type PathToken =
  | { readonly kind: "property"; readonly key: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "dynamic"; readonly ref: string }
  | { readonly kind: "wildcard" };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeKey(key: string, ref: string): void {
  if (UNSAFE_KEYS.has(key)) {
    throw new DataReferenceError(`unsafe property "${key}" in data reference "${ref}"`);
  }
}

/** Parses the content package's deliberately small, non-executable reference grammar. */
export function parseDataReference(ref: string): readonly PathToken[] {
  if (ref.length === 0) throw new DataReferenceError("data reference cannot be empty");
  const tokens: PathToken[] = [];
  let index = 0;

  const readIdentifier = (): string => {
    const start = index;
    while (index < ref.length && /[A-Za-z0-9_]/.test(ref[index]!)) index += 1;
    const value = ref.slice(start, index);
    if (!IDENTIFIER.test(value)) {
      throw new DataReferenceError(`invalid identifier at offset ${start} in data reference "${ref}"`);
    }
    assertSafeKey(value, ref);
    return value;
  };

  tokens.push({ kind: "property", key: readIdentifier() });
  while (index < ref.length) {
    const character = ref[index];
    if (character === ".") {
      index += 1;
      tokens.push({ kind: "property", key: readIdentifier() });
      continue;
    }
    if (character === "[") {
      const close = ref.indexOf("]", index + 1);
      if (close < 0) throw new DataReferenceError(`unclosed bracket in data reference "${ref}"`);
      const inner = ref.slice(index + 1, close);
      if (inner === "*") {
        tokens.push({ kind: "wildcard" });
      } else if (/^\d+$/.test(inner)) {
        tokens.push({ kind: "index", index: Number(inner) });
      } else {
        // Validate nested variable references now; they are resolved as data,
        // never parsed as JavaScript.
        parseDataReference(inner);
        tokens.push({ kind: "dynamic", ref: inner });
      }
      index = close + 1;
      continue;
    }
    throw new DataReferenceError(`unexpected "${character}" at offset ${index} in data reference "${ref}"`);
  }
  return tokens;
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, JsonValue>, key: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/**
 * Read-only reference roots supplied by the compiler rather than the run's
 * state: the content bundle's own projections (`bundle.*`). They resolve like
 * any other root but are NEVER state-backed, so nothing they carry can reach
 * the checkpoint journal — which is the point. Content prose (input-type
 * outlines, shape guides, verdict descriptions) is bound into tasks straight
 * out of the in-memory bundle instead of being threaded through state.
 *
 * Roots take precedence over both loop scope and state so a node output key or
 * loop variable can never shadow content, and `writeDataReference` refuses to
 * assign through one.
 */
export type ReferenceRoots = Readonly<Record<string, JsonValue>>;

function rootValue(
  name: string,
  scope: ScopeReader,
  state: JsonObject,
  roots: ReferenceRoots | undefined,
): JsonValue | undefined {
  if (roots && Object.prototype.hasOwnProperty.call(roots, name)) return roots[name];
  if (scope.has(name)) return scope.get(name);
  return own(state as Record<string, JsonValue>, name);
}

function dynamicKey(value: JsonValue | undefined, ref: string): string | number {
  if (typeof value === "string") {
    assertSafeKey(value, ref);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new DataReferenceError(
    `bracket reference "${ref}" must resolve to a string or non-negative integer, got ${JSON.stringify(value)}`,
  );
}

function readAt(value: JsonValue | undefined, token: PathToken, ref: string): JsonValue | undefined {
  if (token.kind === "property") {
    return isObject(value) ? own(value, token.key) : undefined;
  }
  if (token.kind === "index") {
    if (Array.isArray(value)) return value[token.index];
    return isObject(value) ? own(value, String(token.index)) : undefined;
  }
  throw new DataReferenceError(`internal resolver misuse for "${ref}"`);
}

/**
 * Safely resolves a data reference against compiler-supplied read-only roots
 * first (`bundle.*`), lexical loop variables second, and the runtime-owned
 * state object last. Wildcards project the remaining path over array elements
 * or object values in stable insertion order.
 */
export function resolveDataReference(
  ref: string,
  scope: ScopeReader,
  state: JsonObject,
  options: { readonly required?: boolean; readonly roots?: ReferenceRoots } = {},
): JsonValue | undefined {
  const tokens = parseDataReference(ref);
  const root = tokens[0] as Extract<PathToken, { kind: "property" }>;
  const { roots } = options;

  const walk = (value: JsonValue | undefined, offset: number): JsonValue | undefined => {
    if (offset >= tokens.length) return value;
    const token = tokens[offset]!;
    if (token.kind === "wildcard") {
      const values = Array.isArray(value)
        ? value
        : isObject(value)
          ? Object.values(value)
          : undefined;
      if (!values) return undefined;
      return values.map((entry) => walk(entry, offset + 1) ?? null);
    }
    if (token.kind === "dynamic") {
      const key = dynamicKey(
        resolveDataReference(token.ref, scope, state, { required: true, ...(roots ? { roots } : {}) }),
        token.ref,
      );
      const next =
        typeof key === "number"
          ? readAt(value, { kind: "index", index: key }, ref)
          : readAt(value, { kind: "property", key }, ref);
      return walk(next, offset + 1);
    }
    return walk(readAt(value, token, ref), offset + 1);
  };

  const result = walk(rootValue(root.key, scope, state, roots), 1);
  if (result === undefined && options.required !== false) {
    throw new DataReferenceError(`data reference "${ref}" did not resolve`);
  }
  return result;
}

function cloneValue<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function pickObject(value: Record<string, JsonValue>, keys: readonly string[]): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    assertSafeKey(key, key);
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = cloneValue(value[key]!);
  }
  return result;
}

function projectPick(value: JsonValue, keys: readonly string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (!isObject(entry)) throw new DataReferenceError("pick projection requires object collection elements");
      return pickObject(entry, keys);
    });
  }
  if (!isObject(value)) throw new DataReferenceError("pick projection requires an object or object collection");

  // If the object itself exposes every requested field, it is one artifact
  // (e.g. round.decision). Otherwise it is a keyed collection of artifacts
  // (e.g. ideas), and projection is applied to each value.
  if (keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return pickObject(value, keys);
  }
  const projected: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isObject(entry)) throw new DataReferenceError("pick projection requires object collection elements");
    projected[key] = pickObject(entry, keys);
  }
  return projected;
}

function omitObject(value: Record<string, JsonValue>, keys: readonly string[]): JsonObject {
  const drop = new Set(keys);
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (drop.has(key)) continue;
    assertSafeKey(key, key);
    result[key] = cloneValue(entry);
  }
  return result;
}

function projectOmit(value: JsonValue, keys: readonly string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (!isObject(entry)) throw new DataReferenceError("omit projection requires object collection elements");
      return omitObject(entry, keys);
    });
  }
  if (!isObject(value)) throw new DataReferenceError("omit projection requires an object or object collection");
  return omitObject(value, keys);
}

/** Resolves a binding and applies declarative pick/through projections. */
export function resolveBindValue(
  binding: BindValue,
  scope: ScopeReader,
  state: JsonObject,
  roots?: ReferenceRoots,
): JsonValue {
  const ref = typeof binding === "string" ? binding : binding.ref;
  const withRoots = roots ? { roots } : {};
  let value: JsonValue = resolveDataReference(ref, scope, state, { required: true, ...withRoots })!;
  if (typeof binding !== "string" && binding.through !== undefined) {
    if (!Array.isArray(value)) throw new DataReferenceError(`through projection on "${ref}" requires an array`);
    const through = resolveDataReference(binding.through, scope, state, { required: true, ...withRoots });
    if (typeof through !== "number" || !Number.isSafeInteger(through) || through < 0) {
      throw new DataReferenceError(`through reference "${binding.through}" must resolve to a non-negative integer`);
    }
    value = value.slice(0, through);
  }
  if (typeof binding !== "string" && binding.pick !== undefined) {
    value = projectPick(value, binding.pick);
  }
  if (typeof binding !== "string" && binding.omit !== undefined) {
    value = projectOmit(value, binding.omit);
  }
  return cloneValue(value);
}

function materializedKeys(
  ref: string,
  scope: ScopeReader,
  state: JsonObject,
  roots: ReferenceRoots | undefined,
): readonly (string | number)[] {
  const tokens = parseDataReference(ref);
  return tokens.map((token) => {
    if (token.kind === "property") return token.key;
    if (token.kind === "index") return token.index;
    if (token.kind === "wildcard") {
      throw new DataReferenceError(`wildcards are not valid assignment targets: "${ref}"`);
    }
    return dynamicKey(
      resolveDataReference(token.ref, scope, state, { required: true, ...(roots ? { roots } : {}) }),
      token.ref,
    );
  });
}

export interface DataReferenceWrite {
  readonly state: JsonObject;
  /** Concrete dot path after resolving bracket variables. */
  readonly path: string;
}

/** Immutable, prototype-safe write to a content data-reference target. */
export function writeDataReference(
  state: JsonObject,
  target: string,
  value: JsonValue,
  scope: ScopeReader,
  roots?: ReferenceRoots,
): DataReferenceWrite {
  const keys = materializedKeys(target, scope, state, roots);
  if (keys.length === 0 || typeof keys[0] !== "string") {
    throw new DataReferenceError(`assignment target "${target}" needs a string root`);
  }
  // Content roots are read-only by construction: allowing a write here would
  // both mutate the bundle projection and smuggle content into the journaled
  // state, defeating the reason `bundle.*` is not state-backed.
  if (roots && Object.prototype.hasOwnProperty.call(roots, keys[0])) {
    throw new DataReferenceError(
      `assignment target "${target}" writes through the read-only content root "${keys[0]}"`,
    );
  }
  const next = structuredClone(state) as Record<string, JsonValue>;
  let cursor: Record<string, JsonValue> | JsonValue[] = next;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const following = keys[index + 1]!;
    const property = String(key);
    assertSafeKey(property, target);
    let child: JsonValue | undefined = (cursor as Record<string, JsonValue>)[property];
    if (child === undefined || child === null) {
      child = typeof following === "number" ? [] : {};
      (cursor as Record<string, JsonValue>)[property] = child;
    }
    if (typeof following === "number") {
      if (!Array.isArray(child)) throw new DataReferenceError(`"${target}" traverses a non-array at "${property}"`);
      cursor = child as JsonValue[];
    } else {
      if (!isObject(child)) throw new DataReferenceError(`"${target}" traverses a non-object at "${property}"`);
      cursor = child;
    }
  }
  const leaf = keys.at(-1)!;
  const leafKey = String(leaf);
  assertSafeKey(leafKey, target);
  (cursor as Record<string, JsonValue>)[leafKey] = cloneValue(value);
  return { state: next, path: keys.map(String).join(".") };
}

export function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || typeof left !== typeof right) return false;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEqual(entry, right[index]))
    );
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonEqual((left as JsonObject)[key], (right as JsonObject)[key]),
    )
  );
}
