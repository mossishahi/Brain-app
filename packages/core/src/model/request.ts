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
 * One segment of a system prompt.
 *
 * `cacheable` declares that the segment's bytes are stable across the calls a
 * pipeline makes — role instructions, technique text, deployment policy — as
 * opposed to per-call context. Providers place their cache breakpoint after
 * the leading run of cacheable segments; everything after it is sent fresh.
 * Marking a segment that actually varies per call only wastes cache writes,
 * so the flag is opt-in and never inferred.
 */
export interface SystemPromptSegment {
  readonly text: string;
  readonly cacheable?: boolean;
}

/** A plain string (never cached) or ordered segments with a cache boundary. */
export type SystemPrompt = string | readonly SystemPromptSegment[];

/** Normalizes either system-prompt form to segments, dropping empty text. */
export function systemPromptSegments(
  prompt: SystemPrompt | undefined,
): readonly SystemPromptSegment[] {
  if (prompt === undefined) return [];
  const segments = typeof prompt === "string" ? [{ text: prompt }] : prompt;
  return segments.filter((segment) => segment.text.trim().length > 0);
}

/** Flattens a system prompt for providers that accept only one string. */
export function systemPromptText(
  prompt: SystemPrompt | undefined,
): string | undefined {
  const segments = systemPromptSegments(prompt);
  if (segments.length === 0) return undefined;
  return segments.map((segment) => segment.text).join("\n\n");
}

/**
 * Index of the first segment that is not part of the cacheable prefix. A
 * non-cacheable segment ends the prefix: reordering to gather later cacheable
 * segments would silently change what the model reads.
 */
export function systemPromptBoundary(
  segments: readonly SystemPromptSegment[],
): number {
  let boundary = 0;
  while (boundary < segments.length && segments[boundary]!.cacheable === true) {
    boundary += 1;
  }
  return boundary;
}

/**
 * Escape hatch for provider-specific parameters that have no normalized
 * equivalent. Keyed by provider id so requests stay portable; providers must
 * ignore entries addressed to other providers.
 */
export type ProviderOptions = { readonly [providerId: string]: JsonObject };

export interface ModelRequest {
  readonly modelId: string;
  readonly system?: SystemPrompt;
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
