/**
 * Exact shared contracts used by the Anthropic adapter. Wire-level Anthropic
 * shapes remain private to this package.
 */
export type {
  CallOptions,
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  JsonObject,
  JsonValue,
  ModelCapabilities,
  ModelDescriptor,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ResponseFormat,
  StopReason,
  SystemPrompt,
  SystemPromptSegment,
  ThinkingBlock,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "@brainstorm-agentic/core";

export {
  systemPromptBoundary,
  systemPromptSegments,
} from "@brainstorm-agentic/core";
