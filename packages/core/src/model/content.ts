/**
 * Provider-neutral content blocks shared by model requests and responses.
 * Providers translate these to/from their native wire formats.
 */
import type { JsonObject, JsonValue } from "../types/json.js";

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
  /**
   * Declares that the prompt prefix through this block is stable across the
   * calls a pipeline makes, so providers that support prefix caching may
   * place a cache breakpoint right after it. Unlike a system prompt's
   * `cacheable` (a leading RUN with one boundary at its end), this is an
   * explicit per-block marker: one message may carry several, because a task
   * turn can hold several nested stable prefixes — the run-level payload, and
   * then a growing collection whose earlier elements never change.
   *
   * Marking a block whose prefix actually varies per call only wastes cache
   * writes, so the flag is opt-in and never inferred.
   */
  readonly cacheBoundary?: boolean;
  readonly metadata?: JsonObject;
}

export type ImageSource =
  | { readonly kind: "base64"; readonly mediaType: string; readonly data: string }
  | { readonly kind: "url"; readonly url: string };

export interface ImageBlock {
  readonly type: "image";
  readonly source: ImageSource;
  readonly metadata?: JsonObject;
}

export type DocumentSource =
  | {
      readonly kind: "base64";
      readonly mediaType: "application/pdf";
      readonly data: string;
    }
  | { readonly kind: "url"; readonly url: string };

/** Provider-neutral document input (currently PDF for Anthropic). */
export interface DocumentBlock {
  readonly type: "document";
  readonly source: DocumentSource;
  readonly title?: string;
  readonly context?: string;
  readonly metadata?: JsonObject;
}

/** Reasoning/thinking output surfaced by models that expose it. */
export interface ThinkingBlock {
  readonly type: "thinking";
  readonly text: string;
  readonly metadata?: JsonObject;
}

/** A model's request to invoke a tool. */
export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly metadata?: JsonObject;
}

/** The host's answer to a prior tool_use block. */
export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: readonly (TextBlock | ImageBlock | DocumentBlock)[];
  readonly isError?: boolean;
  readonly metadata?: JsonObject;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

/** A text block that closes a stable prefix (see TextBlock.cacheBoundary). */
export function cacheBoundaryTextBlock(text: string): TextBlock {
  return { type: "text", text, cacheBoundary: true };
}

/**
 * Indices of the blocks that close a stable prefix, ascending. Providers
 * without prefix caching ignore them; providers with a breakpoint budget
 * apply their own ceiling.
 */
export function contentCacheBoundaries(
  content: readonly ContentBlock[],
): readonly number[] {
  const boundaries: number[] = [];
  content.forEach((block, index) => {
    if (block.type === "text" && block.cacheBoundary === true) {
      boundaries.push(index);
    }
  });
  return boundaries;
}

/** Concatenates all text blocks in a content list. */
export function textContent(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function toolUseBlocks(blocks: readonly ContentBlock[]): readonly ToolUseBlock[] {
  return blocks.filter((block): block is ToolUseBlock => block.type === "tool_use");
}
