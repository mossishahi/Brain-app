/**
 * JSON-safe value types. Everything that crosses a persistence or provider
 * boundary in core (scope variables, journal entries, checkpoints, task
 * inputs/outputs) must be a `JsonValue` so it can be serialized losslessly.
 */
export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/** Deep-clones a JSON value using structuredClone (safe for plain data). */
export function cloneJson<T extends JsonValue | undefined>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

/** True when the value is a plain JSON object (not null, not an array). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
