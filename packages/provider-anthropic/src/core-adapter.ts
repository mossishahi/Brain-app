/**
 * Exact shared contracts used by the Anthropic adapter. Wire-level Anthropic
 * shapes remain private to this package.
 */
export type {
  CallOptions,
  ContentBlock,
  DispatchPriority,
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
  RateObservation,
  RequestCoordinator,
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
  contentCacheBoundaries,
  systemPromptBoundary,
  systemPromptSegments,
} from "@brainstorm-agentic/core";
