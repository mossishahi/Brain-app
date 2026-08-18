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



/** Every adapter this build knows, by provider id. */
const ADAPTERS: readonly ProviderAdapterDescriptor[] = [
  ANTHROPIC_ADAPTER,
  CLAUDE_AGENT_ADAPTER,
  CURSOR_AGENT_ADAPTER,
];

export function adapterFor(
  providerId: string,
): ProviderAdapterDescriptor | undefined {
  return ADAPTERS.find((adapter) => adapter.providerId === providerId);
}

/**
 * The provider-native operations a RUN may resolve against — what the adapter
 * declares, minus anything this run has nothing behind.
 *
 * Web search, web fetch and code execution run natively wherever the backend
 * offers them. Attachment reads are conditional: both agent-SDK adapters serve
 * them through the SDK's own file tools, which the executor scopes to the run's
 * attachment roots. Offering them for a run with no roots resolves
 * attachment-access as AVAILABLE and then denies every real path — the agent is
 * told it can read the submission's files, tries, and is refused, which is worse
 * than being told plainly that there are none. A provider offer outranks host
 * tools and ignores enablement, so withdrawing it here is the only way to keep
 * the broker's verdict truthful.
 *
 * This lives beside the descriptors, and not in the worker that wires a run,
 * because the server's readiness probe answers the same question before any job
 * exists. Two copies of this rule would let the pre-submission promise drift
 * away from what a run actually does — which is exactly how a deployment came to
 * report attachment access green while every resumed run had none.
 */
export function nativeOffersFor(
  providerId: string,
  options: { readonly attachmentRootsPresent: boolean },
): readonly ProviderNativeOffer[] {
  const declared = adapterFor(providerId)?.staticOffers ?? [];
  if (options.attachmentRootsPresent) return declared;
  return declared.filter((offer) => !offer.operationId.startsWith("attachment."));
}
