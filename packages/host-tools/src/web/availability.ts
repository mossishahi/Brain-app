/**
 * Per-purpose tool orders derived from probed tool states (availability
 * spec, Section 4): from the configured list of a purpose, drop the tools
 * that are disabled, need a key, were unreachable or blocked; move degraded
 * tools behind every available one, keeping their relative order; keep
 * everything else in configured order; and record, per tool, whether it was
 * kept, moved or dropped and why. The derived order is what new runs
 * receive as their route lists.
 *
 * host-tools does not depend on @brainstorm-agentic/protocol, so the state
 * and entry shapes are restated here. They are structurally identical to
 * protocol's ToolState, PurposeOrderEntry and PurposeOrder (without its
 * `purpose` field), so a PurposeOrder is `{ purpose, ...deriveEffectiveOrder(...) }`.
 */
import type { WebSourceState } from "@brainstorm-agentic/core";

/** protocol's ToolState, restated. */
export type ToolAvailabilityState =
  | "available"
  | "degraded"
  | "unreachable"
  | "blocked"
  | "needs-key"
  | "disabled"
  | "unchecked";

/** protocol's PurposeOrderEntry, restated. */
export interface EffectiveOrderEntry {
  readonly id: string;
  readonly action: "kept" | "moved" | "dropped";
  readonly reason?: string;
}

/** protocol's PurposeOrder without `purpose`. */
export interface EffectiveOrder {
  readonly configured: readonly string[];
  readonly effective: readonly string[];
  readonly entries: readonly EffectiveOrderEntry[];
}

/** States that take a tool out of the order, with the reason recorded. */
const DROP_REASONS: Readonly<Record<string, string>> = {
  disabled: "disabled in settings",
  "not-configured": "not configured on this deployment",
  "needs-key": "needs an API key",
  unreachable: "unreachable at the last probe",
  blocked: "blocked at the last probe",
};

/**
 * The effective order of one purpose. `states` may carry protocol tool
 * states or the web layer's own source states ("not-configured" counts as
 * disabled). A tool without a state is treated as unchecked and kept. With
 * `demoteDegraded` off, degraded tools keep their place and are only flagged
 * in their entry's reason.
 */
export function deriveEffectiveOrder(
  configured: readonly string[],
  states: ReadonlyMap<string, ToolAvailabilityState | WebSourceState>,
  demoteDegraded: boolean,
): EffectiveOrder {
  const stateOf = (id: string): ToolAvailabilityState | WebSourceState => states.get(id) ?? "unchecked";
  const kept: string[] = [];
  const moved: string[] = [];
  const entries: EffectiveOrderEntry[] = [];
  for (const [position, id] of configured.entries()) {
    const state = stateOf(id);
    const drop = DROP_REASONS[state];
    if (drop !== undefined) {
      entries.push({ id, action: "dropped", reason: drop });
      continue;
    }
    if (state === "degraded") {
      if (!demoteDegraded) {
        kept.push(id);
        entries.push({ id, action: "kept", reason: "degraded at the last probe (automatic demotion is off)" });
        continue;
      }
      // Demoted behind every tool that stays in place; a degraded tool with
      // nothing to move behind keeps its position and is only flagged.
      const laterKept = configured
        .slice(position + 1)
        .some((other) => DROP_REASONS[stateOf(other)] === undefined && stateOf(other) !== "degraded");
      moved.push(id);
      entries.push(
        laterKept
          ? { id, action: "moved", reason: "degraded at the last probe: moved behind every available tool" }
          : { id, action: "kept", reason: "degraded at the last probe (already behind every available tool)" },
      );
      continue;
    }
    kept.push(id);
    entries.push(state === "unchecked" ? { id, action: "kept", reason: "not probed yet" } : { id, action: "kept" });
  }
  return { configured: [...configured], effective: [...kept, ...moved], entries };
}
