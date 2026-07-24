import type { ToolDefinition } from "../model/tools.js";

// ---------------------------------------------------------------------------
// Normalized operations
// ---------------------------------------------------------------------------

/**
 * Where a resolved operation will be executed.
 * - "provider": the provider handles it natively (e.g. Anthropic web search).
 * - "host": a locally-registered tool handles it.
 * - "unavailable": neither provider nor host can satisfy it.
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
}
