import type { JsonArray, JsonObject, JsonValue, ScopeReader } from "@brainstorm-agentic/core";

/**
 * Mid-run seat dismissal.
 *
 * The submitter may dismiss a panel member while the run is in flight. From
 * that point the seat develops nothing further, comments on nobody, and is
 * withheld from the integrator and the chair — but everything it produced
 * before the dismissal stays in the artifact history, so the dashboard's record
 * of what happened is never rewritten.
 *
 * WHY THIS IS A HOST-SIDE POLICY AND NOT A CONTENT CHANGE: a running job is
 * pinned to an already-published bundle version and can never receive one. The
 * dismissal therefore rides the resume command as a list of member ids, is held
 * for the whole worker process, and is re-supplied on every later resume by the
 * server — so a dismissal is permanent and replays identically.
 *
 * WHY IT CANNOT ADD OR REMOVE WORKFLOW NODES: journal keys are execution
 * paths. Wrapping a node to skip it would move every key beneath it, and a
 * resumed run would miss its own completed work and re-buy it. Every guard here
 * is therefore placed INSIDE an existing node — a collection resolver, a
 * condition, a fold activity, or an override of the `agent` node executor —
 * where it changes what a node does without changing where the node sits.
 *
 * Consequently a dismissal is honoured at the granularity the journal allows:
 * a collection already recorded still lists the seat (the record cannot be
 * rewritten), so the guards make its remaining leaves no-ops instead. Nothing
 * partially executed is left half-applied, because a skipped agent node
 * records no journal entry at all — exactly as if the run had not reached it.
 */
export interface DismissalPolicy {
  /** The dismissed member ids, in dismissal order. */
  readonly ids: ReadonlySet<string>;
  /**
   * True when any member identity visible in `scope` is dismissed. `loopVars`
   * are the enclosing loop item variables the compiler saw around the guarded
   * node, so this asks the question the content itself declared: is the seat
   * being worked ON, or the agent doing the work, dismissed?
   */
  taints(scope: ScopeReader, loopVars: readonly string[]): boolean;
  /**
   * Removes dismissed members from a value about to be handed to a model:
   * array entries that ARE a dismissed member (or its bare id) and map keys
   * that are a dismissed member id.
   */
  strip(value: JsonValue): JsonValue;
}

/**
 * Reads a member id out of a value: a seat object carries it as `id`, and a bare
 * id is accepted too, in case a bundle ever iterates ids rather than seats.
 *
 * The bare form is deliberately narrowed to the shape the runtime mints
 * (`member-N`, `member-user-N`): the same values flow through arrays of ordinary
 * prose — chain steps, subfield names — and a plain string comparison there could
 * treat a sentence that happens to equal an id as a dismissed seat.
 */
function memberIdOf(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value.startsWith("member-") ? value : undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as JsonObject).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Builds the policy, or returns undefined when nothing is dismissed. The
 * undefined case matters: a run without dismissals must take byte-identical
 * code paths to one compiled before this feature existed.
 */
export function createDismissalPolicy(
  dismissed: readonly string[] | undefined,
): DismissalPolicy | undefined {
  // Tolerant of a malformed list on purpose: this runs while the workflow is
  // being COMPILED, so throwing here would fail the whole run — including every
  // resume of it — over a bad entry in a resubmission's command line.
  const ids = new Set(
    (dismissed ?? []).filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0,
    ),
  );
  if (ids.size === 0) return undefined;

  const isDismissed = (value: JsonValue | undefined): boolean => {
    const id = memberIdOf(value);
    return id !== undefined && ids.has(id);
  };

  return {
    ids,
    taints(scope, loopVars) {
      for (const name of loopVars) {
        if (!scope.has(name)) continue;
        if (isDismissed(scope.get(name))) return true;
      }
      return false;
    },
    /**
     * Deliberately shallow. The values that carry seats are one level deep by
     * construction — a roster array of member objects, an `ideas` map keyed by
     * member id, a `comments` map keyed by commentor id — and a deep walk
     * would start guessing at unrelated objects that happen to carry an `id`.
     */
    strip(value) {
      if (Array.isArray(value)) {
        const kept = (value as JsonArray).filter((entry) => !isDismissed(entry));
        return kept.length === value.length ? value : (kept as JsonValue);
      }
      if (value === null || typeof value !== "object") return value;
      const entries = Object.entries(value as JsonObject);
      const kept = entries.filter(([key]) => !ids.has(key));
      if (kept.length === entries.length) return value;
      return Object.fromEntries(kept) as JsonValue;
    },
  };
}
