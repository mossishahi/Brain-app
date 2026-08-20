import type { ToolDefinition } from "../model/tools.js";

// ---------------------------------------------------------------------------
// Normalized operations
// ---------------------------------------------------------------------------

/**
 * Where a resolved operation will be executed.
 * - "provider": the provider handles it natively (e.g. Anthropic web search).
 * - "host": a locally-registered tool handles it.
 * - "unavailable": NO SOURCE WAS FOUND. It says nothing about whether that is
 *   legitimate — a run that attached no files and a run whose attachment store
 *   this host cannot reach both land here. That question is answered per
 *   capability by `CapabilityAvailability`, and answering it in one word was
 *   what let a broken deployment look exactly like an empty submission.
 */
export type OperationSource = "provider" | "host" | "unavailable";

// ---------------------------------------------------------------------------
// Provider-side offers
// ---------------------------------------------------------------------------

/**
 * A provider adapter advertises which normalized operations it can satisfy
 * natively (without host-side tools). For example, Anthropic may offer
 * "web.search" via its built-in web search feature.
 */
export interface ProviderNativeOffer {
  /** The normalized operation id (e.g. "web.search"). */
  readonly operationId: string;
  /**
   * Provider-specific configuration key passed to the adapter when the
   * operation is selected. For example: "web_search" for Anthropic's native
   * web search tool type.
   */
  readonly nativeKey: string;
}

// ---------------------------------------------------------------------------
// Host-side offers
// ---------------------------------------------------------------------------

/**
 * Risk level of a host tool. Used by the settings UI to determine default
 * enable/disable state and to warn users.
 */
export type HostToolRisk = "low" | "medium" | "high";

/**
 * A host-side tool manifest that can satisfy one or more normalized operations.
 * Host tools run on the user's machine (or the job's compute node).
 */
export interface HostToolManifest {
  /** Stable tool identifier (e.g. "attachment_list"). */
  readonly toolId: string;
  /** Human-readable name for display in settings UI. */
  readonly displayName: string;
  /** Which normalized operations this tool satisfies. */
  readonly operations: readonly string[];
  /** Risk classification for default enable/disable. */
  readonly risk: HostToolRisk;
  /** Whether this tool is enabled by default in settings. */
  readonly defaultEnabled: boolean;
  /** The tool definition (schema) exposed to the model. */
  readonly definition: ToolDefinition;
}

// ---------------------------------------------------------------------------
// Resolved capability plan
// ---------------------------------------------------------------------------

/** One resolved operation in the final plan. */
export interface ResolvedOperation {
  readonly operationId: string;
  readonly source: OperationSource;
  /**
   * When source is "host": the tool name(s) the model can invoke.
   * When source is "provider": the native key(s) the adapter activates.
   * When source is "unavailable": empty.
   */
  readonly toolNames: readonly string[];
  /** The parent capability id (e.g. "web-search"). */
  readonly capabilityId: string;
}

/**
 * Why a capability could not be fully satisfied — the question `OperationSource`
 * cannot answer, because "no tool was found" is the same word for a deployment
 * that is broken and a run that legitimately has nothing to do.
 *
 * - "available": every operation resolved.
 * - "degraded": some operations resolved, some did not.
 * - "vacant": nothing resolved AND the party that owns the fact said so — this
 *   submission attached no files, this deployment configured no GPU template,
 *   this run was launched offline. Legitimate, expected, not a defect.
 * - "withheld": the submitter switched the capability off for this run.
 * - "unwired": nothing resolved and NOBODY claimed the absence. By construction
 *   this is a defect: something that should have been wired was not.
 *
 * The asymmetry is the whole point. Legitimacy is never inferred from runtime
 * state — it must be positively asserted by whoever holds the fact — so an
 * absence nobody will vouch for is a wiring bug rather than a silence a task
 * can reason around.
 */
export type CapabilityAvailability =
  | "available"
  | "degraded"
  | "vacant"
  | "withheld"
  | "unwired";

/** One capability's verdict, beside the per-operation sources. */
export interface ResolvedCapabilityStatus {
  readonly capabilityId: string;
  readonly availability: CapabilityAvailability;
  /** The operations that found no source (empty when available). */
  readonly unavailableOperations: readonly string[];
  /** For "vacant": the fact the host affirmed, in its own words. */
  readonly reason?: string;
}

/**
 * A fully resolved capability plan for one agent task. The executor uses this
 * to configure the model request: host tool definitions, provider native
 * selections, and unavailability instructions.
 */
export interface ResolvedCapabilityPlan {
  /** All resolved operations grouped by source. */
  readonly operations: readonly ResolvedOperation[];
  /** Host tool definitions to include in the model request. */
  readonly hostToolDefinitions: readonly ToolDefinition[];
  /** Provider native operation keys to activate (adapter-specific). */
  readonly providerNativeKeys: readonly string[];
  /**
   * Authoritative text to append to the system prompt for unavailable
   * capabilities. Empty string when everything is satisfied.
   */
  readonly unavailableInstructions: string;
  /**
   * One verdict per required capability. Required, not optional: an optional
   * field would let a caller go on reading `source` alone and reintroduce
   * exactly the silence this exists to end.
   */
  readonly capabilities: readonly ResolvedCapabilityStatus[];
}
