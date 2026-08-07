import type {
  HostToolManifest,
  ProviderNativeOffer,
  ResolvedCapabilityPlan,
  ResolvedOperation,
} from "./types.js";
import type { ToolDefinition } from "../model/tools.js";

// ---------------------------------------------------------------------------
// Broker input
// ---------------------------------------------------------------------------

/** Capability declaration from the content catalog, enriched with operations. */
export interface CapabilityDeclaration {
  readonly capabilityId: string;
  readonly operations: readonly string[];
  readonly whenUnavailable: string;
}

/** Full input to the broker for one task. */
export interface BrokerInput {
  /** Capabilities required by the skill(s) bound to this task. */
  readonly requiredCapabilities: readonly CapabilityDeclaration[];
  /** Operations the provider can handle natively. */
  readonly providerOffers: readonly ProviderNativeOffer[];
  /** All installed host tools (whether enabled or not). */
  readonly hostTools: readonly HostToolManifest[];
  /** User-enabled host tool ids (from settings). */
  readonly enabledHostToolIds: ReadonlySet<string>;
  /**
   * Capability ids the user disabled for THIS run. A disabled capability
   * resolves every operation to "unavailable" regardless of provider offers
   * or enabled host tools, and its unavailable-instruction says so — the
   * agent must not claim the ability was missing, only switched off.
   */
  readonly disabledCapabilityIds?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Capability broker
// ---------------------------------------------------------------------------

/**
 * Resolves required capabilities into a concrete execution plan.
 *
 * Resolution order per operation:
 * 1. If the provider natively offers the operation, use provider.
 * 2. Else if an enabled host tool satisfies it, use host.
 * 3. Otherwise mark unavailable.
 */
export function resolveCapabilityPlan(input: BrokerInput): ResolvedCapabilityPlan {
  const operations: ResolvedOperation[] = [];
  const hostToolDefs: ToolDefinition[] = [];
  const providerNativeKeys: string[] = [];
  const unavailableInstructions: string[] = [];
  const addedHostTools = new Set<string>();

  for (const capability of input.requiredCapabilities) {
    const capUnavailableOps: string[] = [];
    const disabled =
      input.disabledCapabilityIds?.has(capability.capabilityId) === true;

    // A user-disabled capability short-circuits resolution entirely: no
    // provider native, no host tool, and an instruction that names the
    // disable so the agent reports it honestly instead of guessing.
    if (disabled) {
      for (const opId of capability.operations) {
        operations.push({
          operationId: opId,
          source: "unavailable",
          toolNames: [],
          capabilityId: capability.capabilityId,
        });
      }
      unavailableInstructions.push(
        `[${capability.capabilityId}] The user disabled this capability for this run. ${capability.whenUnavailable}`,
      );
      continue;
    }

    for (const opId of capability.operations) {
      // 1. Check provider offers
      const providerOffer = input.providerOffers.find((o) => o.operationId === opId);
      if (providerOffer) {
        operations.push({
          operationId: opId,
          source: "provider",
          toolNames: [providerOffer.nativeKey],
          capabilityId: capability.capabilityId,
        });
        providerNativeKeys.push(providerOffer.nativeKey);
        continue;
      }

      // 2. Check enabled host tools
      const hostTool = input.hostTools.find(
        (t) => t.operations.includes(opId) && input.enabledHostToolIds.has(t.toolId),
      );
      if (hostTool) {
        operations.push({
          operationId: opId,
          source: "host",
          toolNames: [hostTool.toolId],
          capabilityId: capability.capabilityId,
        });
        if (!addedHostTools.has(hostTool.toolId)) {
          hostToolDefs.push(hostTool.definition);
          addedHostTools.add(hostTool.toolId);
        }
        continue;
      }

      // 3. Unavailable
      operations.push({
        operationId: opId,
        source: "unavailable",
        toolNames: [],
        capabilityId: capability.capabilityId,
      });
      capUnavailableOps.push(opId);
    }

    // If any operations for this capability are unavailable, include instruction
    if (capUnavailableOps.length > 0) {
      unavailableInstructions.push(
        `[${capability.capabilityId}] ${capability.whenUnavailable}`,
      );
    }
  }

  return {
    operations,
    hostToolDefinitions: hostToolDefs,
    providerNativeKeys,
    unavailableInstructions: unavailableInstructions.length > 0
      ? "## Unavailable capabilities\n\n" + unavailableInstructions.join("\n\n")
      : "",
  };
}
