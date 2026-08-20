import type {
  CapabilityAvailability,
  HostToolManifest,
  ProviderNativeOffer,
  ResolvedCapabilityPlan,
  ResolvedCapabilityStatus,
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
  /**
   * Capabilities the host AFFIRMS are legitimately empty, mapped to the fact it
   * is affirming ("This submission carries no attached files."). Only the party
   * that owns a fact may assert it — the job record knows what was submitted,
   * the deployment knows whether it configured a GPU, `--offline` knows there is
   * no network by choice — so nothing here can be inferred from the absence of
   * a tool, which is precisely the inference that let a lost attachment store
   * pass for an empty one.
   */
  readonly vacantCapabilities?: ReadonlyMap<string, string>;
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
  const statuses: ResolvedCapabilityStatus[] = [];
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
      statuses.push({
        capabilityId: capability.capabilityId,
        availability: "withheld",
        unavailableOperations: [...capability.operations],
      });
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

    // A capability that lost SOME of its operations has not gone away, and
    // saying it has is expensive: the catalog's whenUnavailable prose is
    // written for total loss ("state explicitly that attachment access was
    // unavailable and reason only from the metadata"), so injecting it when
    // only, say, deterministic search is missing tells an agent holding a
    // working file-read tool to stop reading files and to report itself blind.
    // A partial outage names what is actually missing instead.
    const vacancy = input.vacantCapabilities?.get(capability.capabilityId);
    const availability: CapabilityAvailability =
      capUnavailableOps.length === 0
        ? "available"
        : capUnavailableOps.length < capability.operations.length
          ? "degraded"
          // Nothing resolved. Whether that is a fact or a fault is not the
          // broker's to guess: it is whether anyone vouched for it.
          : vacancy !== undefined
            ? "vacant"
            : "unwired";
    statuses.push({
      capabilityId: capability.capabilityId,
      availability,
      unavailableOperations: [...capUnavailableOps],
      ...(availability === "vacant" && vacancy !== undefined
        ? { reason: vacancy }
        : {}),
    });

    if (capUnavailableOps.length > 0) {
      unavailableInstructions.push(
        availability === "degraded"
          ? `[${capability.capabilityId}] ${capUnavailableOps.join(", ")} ${
              capUnavailableOps.length === 1 ? "is" : "are"
            } unavailable; the rest of this capability works. Use the operations you do have, and report only the missing ones as missing — do not treat the capability as unavailable.`
          : availability === "vacant"
            // NOT the catalog's whenUnavailable prose. That sentence tells an
            // agent to report the ability as missing, which is false here and
            // reads to a reviewer as a broken run: there is simply nothing to
            // work on, and saying so plainly is what stops a task from hunting
            // for files that were never submitted.
            ? `[${capability.capabilityId}] ${vacancy} Nothing is broken and nothing is missing — work from the input you were given, and do not report this capability as unavailable.`
            : `[${capability.capabilityId}] ${capability.whenUnavailable}`,
      );
    }
  }

  return {
    operations,
    hostToolDefinitions: hostToolDefs,
    providerNativeKeys,
    capabilities: statuses,
    unavailableInstructions: unavailableInstructions.length > 0
      ? "## Unavailable capabilities\n\n" + unavailableInstructions.join("\n\n")
      : "",
  };
}
