/**
 * Shared extraction of the OPERATIONAL DETAIL of a tool call for progress
 * events: the one input that tells a human what the call targeted — the file
 * path read, the query searched, the URL fetched, or the script/command the
 * agent chose to run. Both agent executors emit it through
 * `AgentProgress.data.detail`, so the dashboard can show per-activity
 * capability usage.
 *
 * Sanitization contract: tool INPUTS listed here are deliberately shown
 * (they are the agent's own operational choices); prompts, chain-of-thought,
 * tool OUTPUTS, and credentials remain excluded. Tools that transport
 * artifact or chain content (the stepwise chain tool, structured-output
 * transport) are hard-excluded so reasoning never leaks through this
 * channel.
 */
import type { JsonValue } from "../types/json.js";

export type ToolDetailKind = "code" | "query" | "url" | "path" | "text";

export interface ToolCallDetail {
  readonly kind: ToolDetailKind;
  readonly value: string;
}

/** Content-bearing tools whose inputs must never reach the event log. */
const EXCLUDED_TOOLS = new Set(["submit_step", "submit_result", "StructuredOutput"]);

/** Script/command payloads stay readable in a scrollable hover window. */
const MAX_CODE_CHARS = 6_000;
/** Paths, queries, and URLs are single lines; cap defends against abuse. */
const MAX_TEXT_CHARS = 600;

const DETAIL_KEYS: readonly { keys: readonly string[]; kind: ToolDetailKind }[] = [
  { keys: ["code", "command", "script"], kind: "code" },
  { keys: ["query"], kind: "query" },
  { keys: ["url"], kind: "url" },
  { keys: ["path", "file_path", "prefix"], kind: "path" },
  { keys: ["pattern", "root"], kind: "text" },
];

function clip(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/**
 * A tool's short name: in-process MCP tools reach the executors as
 * `mcp__<server>__<tool>`, and the exclusion contract is about the TOOL —
 * `submit_step` transports chain content whichever server carries it, while
 * `web_search` is operational whether it arrives bare (Messages path) or
 * MCP-bridged (agent-SDK paths). Keying the exclusion on the full name once
 * hid every bridged operational call — a search's query showed on one
 * backend and vanished on the other two.
 */
function shortToolName(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return toolName;
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  return separator >= 0 ? rest.slice(separator + 2) : toolName;
}

/**
 * The displayable detail of one tool call, or undefined when the tool is
 * excluded, the input carries no recognized field, or the field is empty.
 */
export function toolCallDetail(
  toolName: string,
  input: JsonValue | undefined,
): ToolCallDetail | undefined {
  if (EXCLUDED_TOOLS.has(shortToolName(toolName))) {
    return undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as { readonly [key: string]: JsonValue };
  for (const { keys, kind } of DETAIL_KEYS) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return {
          kind,
          value: clip(value, kind === "code" ? MAX_CODE_CHARS : MAX_TEXT_CHARS),
        };
      }
    }
  }
  return undefined;
}
