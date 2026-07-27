import type { SerializedError } from "../errors.js";
import type {
  ModelMessage,
  ProviderOptions,
  ResponseFormat,
  SystemPrompt,
} from "../model/request.js";
import type { CapabilityRequirements } from "../model/provider.js";
import type { TokenUsage } from "../model/response.js";
import type { ToolChoice } from "../model/tools.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import type { ResolvedCapabilityPlan } from "../capability/types.js";

/**
 * Provider-neutral model request material prepared by a workflow integration.
 * Routing may leave modelId absent for an AgentExecutor to resolve from the
 * task's logicalRoute.
 */
export interface AgentModelRequestDescription {
  readonly modelId?: string;
  readonly system?: SystemPrompt;
  readonly messages: readonly ModelMessage[];
  readonly toolChoice?: ToolChoice;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  readonly responseFormat?: ResponseFormat;
  readonly metadata?: JsonObject;
  readonly providerOptions?: ProviderOptions;
}

/** Named, JSON-serializable structured-output contract for an agent task. */
export interface AgentOutputSchema {
  readonly name: string;
  readonly schema: JsonObject;
}

/**
 * A unit of agent work handed to an AgentExecutor. Tasks are pure data so
 * they can be checkpointed, retried, and routed across providers.
 */
export interface AgentTask {
  /** Stable id for correlation across events, journal entries, and retries. */
  readonly taskId: string;
  /** What kind of work this is, e.g. "brainstorm.generate", "critic.review". */
  readonly kind: string;
  /** Role/persona identifier, e.g. a panel member id. */
  readonly agentId?: string;
  /** Task payload (prompt fragments, structured directives, references). */
  readonly input: JsonValue;
  /** Provider-neutral route name declared by workflow content. */
  readonly logicalRoute?: string;
  /** Executable host capabilities the task is allowed to use. */
  readonly allowedCapabilities?: readonly string[];
  /** Skills the executor should activate for this task, by name. */
  readonly skills?: readonly string[];
  /** Tools the executor may offer to the model for this task, by name. */
  readonly tools?: readonly string[];
  /** Structured-output contract, independent of any provider SDK. */
  readonly outputSchema?: AgentOutputSchema;
  /** Pre-rendered request description a generic agent runtime can adapt. */
  readonly modelRequest?: AgentModelRequestDescription;
  /** Model capability requirements used for provider/model negotiation. */
  readonly requirements?: CapabilityRequirements;
  /** Resolved capability plan from the broker. */
  readonly capabilityPlan?: ResolvedCapabilityPlan;
  /** Free-form routing/observability metadata. */
  readonly metadata?: JsonObject;
}

export interface AgentResultSuccess {
  readonly taskId: string;
  readonly status: "ok";
  readonly output: JsonValue;
  readonly usage?: TokenUsage;
  readonly artifacts?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface AgentResultFailure {
  readonly taskId: string;
  readonly status: "error";
  readonly error: SerializedError;
  readonly usage?: TokenUsage;
  readonly metadata?: JsonObject;
}

export type AgentResult = AgentResultSuccess | AgentResultFailure;

/**
 * Safe operational progress only. Executors must never report chain-of-thought,
 * credentials, full prompts, or unredacted tool outputs through this channel.
 */
export type AgentProgressKind =
  | "status"
  | "model"
  | "tool_start"
  | "tool_progress"
  | "tool_end"
  | "retry"
  | "validation";

export interface AgentProgress {
  readonly kind: AgentProgressKind;
  readonly message: string;
  readonly toolName?: string;
  readonly turn?: number;
  readonly elapsedMs?: number;
}

export interface AgentExecutionContext {
  readonly runId: string;
  /** Workflow node path that spawned the task (e.g. "root/round/member[2]"). */
  readonly nodePath: string;
  readonly signal?: AbortSignal;
  /** Streams sanitized operational progress into the workflow event log. */
  readonly reportProgress?: (progress: AgentProgress) => void;
}

/**
 * Executes agent tasks. The reference implementation drives a ModelProvider
 * with skills/tools, but tests and hosts can supply anything satisfying this.
 */
export interface AgentExecutor {
  execute(task: AgentTask, context: AgentExecutionContext): Promise<AgentResult>;
}
