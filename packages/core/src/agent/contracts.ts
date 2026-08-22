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
  /**
   * The version a PATCH-shaped output revises, for host-side validation only.
   *
   * A patch is deliberately validated loosely on its own — a rule relating two
   * sections cannot be judged from a patch that names one of them — so the
   * coherence of the MERGED whole can only be checked against the version
   * being revised. Supplying it here lets the executor's output validator run
   * that check while a retry is still possible; without it an incoherent patch
   * is only caught after the result is recorded, where the failure is no
   * longer retryable.
   *
   * Never rendered into a request and never journaled: it is context the host
   * already holds, not something the model is shown or asked to reproduce.
   */
  readonly revisionBase?: JsonValue;
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
 * Tool INPUTS that describe the operation (the path read, the query searched,
 * the URL fetched, the script/command the agent chose to run) are deliberately
 * allowed as `data.detail` (see toolCallDetail); content-transport tools
 * (stepwise chain, structured output) are excluded there.
 */
export type AgentProgressKind =
  | "status"
  | "model"
  | "tool_start"
  | "tool_progress"
  | "tool_end"
  | "retry"
  | "validation"
  // One real hand-off to a model, carrying only the id of the record that
  // holds what was sent. The prompt itself never travels this channel; the id
  // is the handle a reader follows to the file (see PromptRecord).
  | "llm_call";

export interface AgentProgress {
  readonly kind: AgentProgressKind;
  readonly message: string;
  readonly toolName?: string;
  readonly turn?: number;
  readonly elapsedMs?: number;
  /**
   * Whether a finished tool call FAILED — refused by a permission hook, or
   * errored. Meaningful on `tool_end` only.
   *
   * A first-class field rather than a phrase inside `message`, because the
   * aggregate the dashboard shows counts these events: with the outcome legible
   * only to a reader, a run whose every attachment read was denied reported the
   * same tool-call counts as one that read them all, positively suggesting the
   * files had been read.
   */
  readonly failed?: boolean;
  /**
   * Which captured prompt record this row addresses. Meaningful on `llm_call`
   * only, and always present there: a row without a record behind it would
   * offer a reader a request they cannot open.
   *
   * An id, never the prompt — the event log stays sanitized and small.
   */
  readonly promptId?: string;
  /**
   * Optional structured payload for machine aggregation (e.g. the resolved
   * capability plan at task start). Same sanitation rules as `message`:
   * operational facts only, never content.
   */
  readonly data?: JsonObject;
}

/**
 * Exactly what one hand-off to a model contained, kept verbatim so a reader can
 * reconstruct the request behind a single call byte for byte.
 *
 * Deliberately NOT an AgentProgress payload: `sections` carry whole prompts,
 * and the progress channel is sanitized, streamed to every connected browser,
 * and small on purpose. This travels the live-text way instead — its own
 * per-run file, fetched only when a reader asks for one.
 *
 * Executors hold API keys and setup tokens. Nothing a record is built from may
 * come from that material: a credential must never be reconstructable from a
 * section.
 */
export interface PromptRecord {
  /** Stable id: how a row addresses its file. Unique within the run. */
  readonly id: string;
  readonly at: number;
  readonly taskId: string;
  readonly kind: string;
  readonly agentId?: string;
  /** 1-based executor attempt (a validation retry or a fresh session is a new one). */
  readonly attempt: number;
  /** 1-based wire turn where the backend exposes one; absent on the SDK paths. */
  readonly turn?: number;
  readonly provider: string;
  readonly model?: string;
  readonly logicalRoute?: string;
  /**
   * True when this is every byte the model receives. False on the agent-SDK
   * paths, where the SDK composes the final request and adds its own system
   * prompt, built-in tools and harness scaffolding after we hand over. The
   * rendered file must SAY which case it is rather than imply completeness.
   */
  readonly complete: boolean;
  /** Ordered, named sections: everything we sent, verbatim. */
  readonly sections: readonly { readonly title: string; readonly body: string }[];
}

export interface AgentExecutionContext {
  readonly runId: string;
  /** Workflow node path that spawned the task (e.g. "root/round/member[2]"). */
  readonly nodePath: string;
  readonly signal?: AbortSignal;
  /** Streams sanitized operational progress into the workflow event log. */
  readonly reportProgress?: (progress: AgentProgress) => void;
  /**
   * Words the model is producing RIGHT NOW, in the order it produces them, so a
   * reader watching a task that runs for minutes can read along instead of
   * watching the word "thinking".
   *
   * Called with each fragment as it arrives. The host APPENDS them, so what a
   * reader sees is one continuous thread for this task — and drops the whole
   * thread the moment the task's real output exists, because the output is what
   * the run is made of and this was only ever the wait.
   *
   * It is NOT the chain of thought and must never be treated as one. It reaches
   * no other consumer: not the workflow event log, not the journal, not the
   * artifact store, not the telemetry record, and no decision anywhere. Nothing
   * reads it back after the task ends, because by then it does not exist. The
   * chain of thought a run is BUILT from is the task's output, which travels the
   * ordinary way and is kept.
   *
   * Absent on hosts that show no live text, and then executors must not spend
   * anything producing it.
   */
  readonly reportLive?: (text: string) => void;
  /**
   * What we handed the model, once per hand-off, for the reader who needs to
   * see the exact request behind a call.
   *
   * Deliberately NOT a progress event: prompts do not belong in the event log,
   * which is sanitized, streamed to every connected browser, and small on
   * purpose. This rides its own per-run file and is fetched only on request,
   * the same shape as the live-text channel.
   */
  readonly reportPrompt?: (record: PromptRecord) => void;
}

/**
 * Executes agent tasks. The reference implementation drives a ModelProvider
 * with skills/tools, but tests and hosts can supply anything satisfying this.
 */
export interface AgentExecutor {
  execute(task: AgentTask, context: AgentExecutionContext): Promise<AgentResult>;
}
