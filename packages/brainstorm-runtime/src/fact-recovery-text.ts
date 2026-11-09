import type { JsonObject, JsonValue } from "@brainstorm-agentic/core";
function record(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Only authored arguments and deliverables enter recovery prompts. */
export function recoveryText(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(recoveryText);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["thinking", "thoughts", "thinkingSegments", "thinkingSummary"].includes(key))
    .map(([key, entry]) => [key, recoveryText(entry)]));
}

