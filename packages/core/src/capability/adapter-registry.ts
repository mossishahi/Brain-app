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
   * Model-specific offers should be reported via ModelProvider.getNativeOffers().
   */
  readonly staticOffers: readonly ProviderNativeOffer[];
  /** Whether this adapter supports rich tool results (images/documents). */
  readonly richToolResults: boolean;
}

/**
 * A provider adapter registry. Adding a new provider to the system requires
 * only registering an adapter here.
 */
export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapterDescriptor>();

  register(descriptor: ProviderAdapterDescriptor): this {
    if (this.adapters.has(descriptor.providerId)) {
      throw new Error(
        `provider adapter "${descriptor.providerId}" is already registered`,
      );
    }
    this.adapters.set(descriptor.providerId, descriptor);
    return this;
  }

  get(providerId: string): ProviderAdapterDescriptor | undefined {
    return this.adapters.get(providerId);
  }

  list(): readonly ProviderAdapterDescriptor[] {
    return [...this.adapters.values()];
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }
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
  richToolResults: true,
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
  richToolResults: true,
};

export const OFFLINE_ADAPTER: ProviderAdapterDescriptor = {
  providerId: "offline",
  displayName: "Offline (deterministic)",
  kind: "model-loop",
  staticOffers: [],
  richToolResults: false,
};

/**
 * Creates a registry pre-populated with the shipped adapter descriptors.
 */
export function createDefaultAdapterRegistry(): ProviderAdapterRegistry {
  return new ProviderAdapterRegistry()
    .register(ANTHROPIC_ADAPTER)
    .register(CLAUDE_AGENT_ADAPTER)
    .register(OFFLINE_ADAPTER);
}
