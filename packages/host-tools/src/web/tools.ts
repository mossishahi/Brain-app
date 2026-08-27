/**
 * The unified web tools over one WebAccess.
 *
 * These are the ONLY model-facing web tools in the pipeline: the Messages
 * path registers them in its tool registry, and both agent-SDK executors
 * bridge the same definitions as in-process tools — so an agent sees the
 * identical search surface whichever backend runs it, and every call lands
 * in the same manager (and therefore the same log).
 */
import type {
  JsonValue,
  Tool,
  ToolResult,
  WebAccess,
  WebAccessCallContext,
  WebSearchKind,
} from "@brainstorm-agentic/core";

import {
  WEB_FETCH_MANIFEST,
  WEB_SEARCH_MANIFEST,
} from "../web-search.js";
import { WebAccessError } from "./manager.js";

export const WEB_ACCESS_TOOL_NAMES = ["web_search", "web_fetch"] as const;

function inputRecord(value: JsonValue): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function refusal(message: string): ToolResult {
  return { output: message, isError: true };
}

/** The model-facing search input, parsed leniently — bounds live in the manager. */
export function parseWebSearchInput(input: JsonValue): {
  readonly query: string;
  readonly kind?: WebSearchKind;
  readonly maxResults?: number;
  readonly recency?: "day" | "week" | "month" | "year";
  readonly domains?: readonly string[];
} | undefined {
  const args = inputRecord(input);
  if (typeof args.query !== "string" || args.query.trim() === "") return undefined;
  const kind =
    args.kind === "general" || args.kind === "scholarly" || args.kind === "news"
      ? args.kind
      : undefined;
  const recency =
    args.recency === "day" ||
    args.recency === "week" ||
    args.recency === "month" ||
    args.recency === "year"
      ? args.recency
      : undefined;
  const domains = Array.isArray(args.domains)
    ? args.domains.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : undefined;
  return {
    query: args.query,
    ...(kind !== undefined ? { kind } : {}),
    ...(typeof args.max_results === "number" ? { maxResults: args.max_results } : {}),
    ...(recency !== undefined ? { recency } : {}),
    ...(domains !== undefined && domains.length > 0 ? { domains } : {}),
  };
}

/**
 * The web_search + web_fetch tools over a WebAccess. `context` attribution
 * (task, agent, node path) is supplied per registration site where known.
 */
export function webAccessTools(
  web: WebAccess,
  attribution: Omit<WebAccessCallContext, "signal"> = {},
): readonly Tool[] {
  const searchTool: Tool = {
    definition: WEB_SEARCH_MANIFEST.definition,
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseWebSearchInput(input);
      if (parsed === undefined) return refusal("query must be a non-empty string.");
      try {
        const answer = await web.search(parsed, { ...attribution, signal: context.signal });
        return { output: answer as unknown as JsonValue };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        if (error instanceof WebAccessError) return refusal(error.message);
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
  const fetchTool: Tool = {
    definition: WEB_FETCH_MANIFEST.definition,
    async execute(input, context): Promise<ToolResult> {
      const args = inputRecord(input);
      if (typeof args.url !== "string" || args.url.trim() === "") {
        return refusal("url must be a non-empty string.");
      }
      try {
        const answer = await web.fetch(
          {
            url: args.url,
            ...(typeof args.max_chars === "number" ? { maxChars: args.max_chars } : {}),
          },
          { ...attribution, signal: context.signal },
        );
        return { output: answer as unknown as JsonValue };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        if (error instanceof WebAccessError) return refusal(error.message);
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
  return [searchTool, fetchTool];
}
