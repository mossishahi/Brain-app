import type { ModelProvider } from "../model/provider.js";
import type { ProviderNativeOffer } from "./types.js";

/**
 * Metadata about a provider adapter that the registry and wiring layer use
 * to select, configure, and negotiate with a provider.
 */
export interface ProviderAdapterDescriptor {
  /** Unique provider identifier (e.g. "anthropic", "openai", "openrouter"). */
  readonly providerId: string;
  /** Human-readable name for settings UI. */
  readonly displayName: string;
  /**
   * Execution strategy this adapter supports.
   * - "model-loop": generic chat completion; uses ToolLoopAgentExecutor.
   * - "agent-executor": monolithic executor (e.g. Claude Agent SDK).
   */
  readonly kind: "model-loop" | "agent-executor";
  /**
   * Static native operation offers this adapter can provide regardless of model.
   */
  readonly staticOffers: readonly ProviderNativeOffer[];
}


// ---------------------------------------------------------------------------
// Built-in adapter descriptors
// ---------------------------------------------------------------------------

export const ANTHROPIC_ADAPTER: ProviderAdapterDescriptor = {
  providerId: "anthropic",
  displayName: "Anthropic API",
  kind: "model-loop",
  // Server tools executed on Anthropic's infrastructure: the broker prefers
  // these over host tools, and the provider adapter translates each native
  // key into its wire tool object. Attachment and taxonomy operations stay
  // host-side by design.
  staticOffers: [
    { operationId: "web.search", nativeKey: "web_search" },
    { operationId: "web.fetch", nativeKey: "web_fetch" },
    { operationId: "code.execute", nativeKey: "code_execution" },
  ],
};

export const CLAUDE_AGENT_ADAPTER: ProviderAdapterDescriptor = {
  providerId: "claude-agent",
  displayName: "Claude Agent SDK",
  kind: "agent-executor",
  staticOffers: [
    { operationId: "web.search", nativeKey: "WebSearch" },
    { operationId: "web.fetch", nativeKey: "WebFetch" },
    { operationId: "code.execute", nativeKey: "Bash" },
    { operationId: "attachment.list", nativeKey: "Glob" },
    { operationId: "attachment.read", nativeKey: "Read" },
  ],
};

export const CURSOR_AGENT_ADAPTER: ProviderAdapterDescriptor = {
  providerId: "cursor-agent",
  displayName: "Cursor SDK",
  kind: "agent-executor",
  // Cursor's local agent ships the same operation families as built-in
  // tools (public tool vocabulary names). Attachment search stays host-side
  // by design, exactly like the Claude Agent SDK path.
  staticOffers: [
    { operationId: "web.search", nativeKey: "webSearch" },
    { operationId: "web.fetch", nativeKey: "webFetch" },
    { operationId: "code.execute", nativeKey: "shell" },
    { operationId: "attachment.list", nativeKey: "glob" },
    { operationId: "attachment.read", nativeKey: "read" },
  ],
};


