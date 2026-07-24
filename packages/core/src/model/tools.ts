import type { JsonObject } from "../types/json.js";

/** Declaration of a tool as advertised to a model (JSON Schema input contract). */
export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema describing the tool's input. */
  readonly inputSchema: JsonObject;
}

export type ToolChoice =
  | { readonly type: "auto" }
  | { readonly type: "none" }
  | { readonly type: "required" }
  | { readonly type: "tool"; readonly name: string };
