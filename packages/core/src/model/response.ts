import type { JsonObject } from "../types/json.js";
import type { ContentBlock } from "./content.js";
import { textContent } from "./content.js";

/** Normalized reasons a model stopped generating. */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "content_filter"
  | "refusal"
  | "error"
  | "other";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningTokens?: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const opt = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const result: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
  } = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  const totalTokens = opt(a.totalTokens, b.totalTokens);
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  const cacheRead = opt(a.cacheReadInputTokens, b.cacheReadInputTokens);
  if (cacheRead !== undefined) result.cacheReadInputTokens = cacheRead;
  const cacheWrite = opt(a.cacheWriteInputTokens, b.cacheWriteInputTokens);
  if (cacheWrite !== undefined) result.cacheWriteInputTokens = cacheWrite;
  const reasoning = opt(a.reasoningTokens, b.reasoningTokens);
  if (reasoning !== undefined) result.reasoningTokens = reasoning;
  return result;
}

export interface ModelResponse {
  readonly providerId: string;
  readonly modelId: string;
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  /** Provider-specific response details that have no normalized equivalent. */
  readonly metadata?: JsonObject;
}

export function responseText(response: ModelResponse): string {
  return textContent(response.content);
}
