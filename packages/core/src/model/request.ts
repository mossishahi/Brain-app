import type { JsonObject } from "../types/json.js";
import type { ContentBlock } from "./content.js";
import { textBlock } from "./content.js";
import type { ToolChoice, ToolDefinition } from "./tools.js";

export type MessageRole = "user" | "assistant";

export interface ModelMessage {
  readonly role: MessageRole;
  readonly content: readonly ContentBlock[];
}

export type ResponseFormat =
  | { readonly type: "text" }
  | { readonly type: "json" }
  | { readonly type: "jsonSchema"; readonly schema: JsonObject; readonly name?: string };

/**
 * Escape hatch for provider-specific parameters that have no normalized
 * equivalent. Keyed by provider id so requests stay portable; providers must
 * ignore entries addressed to other providers.
 */
export type ProviderOptions = { readonly [providerId: string]: JsonObject };

export interface ModelRequest {
  readonly modelId: string;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  readonly responseFormat?: ResponseFormat;
  readonly metadata?: JsonObject;
  readonly providerOptions?: ProviderOptions;
  /**
   * Provider-native operation keys to activate alongside host tools.
   * Each key is provider-specific (e.g. "web_search" for Anthropic).
   * Providers that don't support native operations ignore this field.
   */
  readonly nativeOperations?: readonly string[];
}

export function userMessage(text: string): ModelMessage {
  return { role: "user", content: [textBlock(text)] };
}

export function assistantMessage(text: string): ModelMessage {
  return { role: "assistant", content: [textBlock(text)] };
}
