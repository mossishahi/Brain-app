/**
 * The runtime's only import surface for shared contracts. Keeping these
 * re-exports together makes contract changes explicit and prevents execution
 * code from inventing provider- or workflow-specific aliases.
 */
export {
  addUsage,
  emptyUsage,
  isCancellation,
  satisfiesRequirements,
  serializeError,
  textBlock,
  textContent,
  toolUseBlocks,
  userMessage,
} from "@brainstorm-agentic/core";

export type {
  AgentExecutionContext,
  AgentExecutor,
  AgentResult,
  AgentTask,
  CallOptions,
  ContentBlock,
  JsonObject,
  JsonValue,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderOptions,
  ResponseFormat,
  StopReason,
  TokenUsage,
  Tool,
  ToolChoice,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry as CoreToolRegistry,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
} from "@brainstorm-agentic/core";
