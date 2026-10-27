import { embeddingInputSchema, type HumanGateNode as ContentHumanGateNode } from "@brainstorm-agentic/content";
import type { JsonObject, JsonValue, ScopeReader } from "@brainstorm-agentic/core";

import { type ReferenceRoots, resolveDataReference, writeDataReference } from "./data-ref.js";
import { BrainstormRuntimeError } from "./errors.js";
import { validateArtifact } from "./state.js";

export type HumanGateMode = "manual" | "autoApproveSkippable";

export interface HumanGateDecision {
  readonly action: string;
  /** For a shrink action: retained member ids (existing order is preserved). */
  readonly members?: readonly JsonValue[];
  /**
   * User-defined custom seats added at confirmation (valid with any action
   * of a gate that edits the panel): department, umbrella (the seat's
   * field), and 1-3 subfields each. The runtime — not the client — assigns
   * their ids (`member-user-N`, deterministic in submission order) and
   * re-validates the whole panel after the edit.
   */
  readonly addedMembers?: readonly JsonValue[];
  /**
   * For a classification-revising action: the submission type to proceed
   * with — either offered option or any other type of the loaded catalog
   * (membership is validated; the type drives the run's shape/outline
   * bindings, so an unknown label is refused).
   */
  readonly type?: JsonValue;
  /**
   * For a classification-revising action: the full replacement list of
   * requested outputs ({title, ask} each, at most 4, unique titles). An
   * empty list clears them.
   */
  readonly requestedOutputs?: readonly JsonValue[];
  /**
   * For a needs-editing action (editRule "needs"): the edited embedding
   * input. It may only drop facets, aliases or equivalent problems and change
   * relevance/confidence values within [0, 1]; every remaining text stays
   * exactly as the classifier wrote it, and at least 3 facets remain.
   */
  readonly embeddingInput?: JsonValue;
}

/** Gate-time panel bounds (mirrors the protocol's PANEL_EDIT_LIMITS). */
const MAX_PANEL_MEMBERS = 12;
const MIN_SEAT_SUBFIELDS = 1;
const MAX_SEAT_SUBFIELDS = 3;

/** Gate-time classification bounds (mirrors the taskClassification schema). */
const MAX_REQUESTED_OUTPUTS = 4;

/**
 * Validates one user-added seat and returns the panel member it becomes.
 * Deterministic ids: `member-user-<position>` — a namespace ordinary
 * selection never uses, so removed original ids can never collide.
 */
function customSeatMember(raw: JsonValue, position: number): JsonObject {
  const seat = object(raw, "added panel seat");
  const department = typeof seat.department === "string" ? seat.department.trim() : "";
  const umbrella = typeof seat.umbrella === "string" ? seat.umbrella.trim() : "";
  const subfields = Array.isArray(seat.subfields)
    ? seat.subfields
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
  if (department.length === 0 || umbrella.length === 0) {
    throw new BrainstormRuntimeError(
      "an added panel seat needs a non-empty department and field",
      "INVALID_GATE_DECISION",
    );
  }
  if (
    subfields.length < MIN_SEAT_SUBFIELDS ||
    subfields.length > MAX_SEAT_SUBFIELDS
  ) {
    throw new BrainstormRuntimeError(
      `an added panel seat needs ${MIN_SEAT_SUBFIELDS} to ${MAX_SEAT_SUBFIELDS} subfields`,
      "INVALID_GATE_DECISION",
    );
  }
  return {
    id: `member-user-${position}`,
    department,
    umbrella,
    subfields,
  };
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrainstormRuntimeError(`${label} must be an object`, "INVALID_GATE_DECISION");
  }
  return value as JsonObject;
}

function normalizedDecision(value: JsonValue): HumanGateDecision {
  if (typeof value === "string") return { action: value };
  const decision = object(value, "human gate response");
  if (typeof decision.action !== "string") {
    throw new BrainstormRuntimeError("human gate response needs an action", "INVALID_GATE_DECISION");
  }
  return decision as unknown as HumanGateDecision;
}

export function autoApproveDecision(node: ContentHumanGateNode): HumanGateDecision {
  if (!node.skippable) {
    throw new BrainstormRuntimeError(
      `human gate "${node.id}" is not skippable and cannot be auto-approved`,
      "GATE_NOT_SKIPPABLE",
    );
  }
  const approve = node.gate.actions.find((action) => action.id === "approve") ?? node.gate.actions[0];
  if (!approve) throw new BrainstormRuntimeError(`human gate "${node.id}" has no action`, "INVALID_GATE");
  return { action: approve.id };
}

/** Minimum facets an edited embedding input keeps (the schema's floor). */
const MIN_FACETS = 3;

function needsEditError(nodeId: string, message: string): BrainstormRuntimeError {
  return new BrainstormRuntimeError(`human gate "${nodeId}": ${message}`, "INVALID_GATE_DECISION");
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unitInterval(value: JsonValue | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Checks an edited embedding input against the current one under editRule
 * "needs": facets, aliases and equivalent problems may only be removed
 * (order kept), relevance and confidence may change within [0, 1], and no
 * text may be added or rewritten; at least 3 facets remain. Returns the
 * edited input.
 */
export function applyNeedsEdit(current: JsonObject, proposed: JsonValue, nodeId: string): JsonObject {
  const edited = object(proposed, "edited embedding input");
  for (const key of Object.keys(edited)) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      throw needsEditError(nodeId, `the needs edit may not add "${key}"`);
    }
  }
  for (const key of Object.keys(current)) {
    if (key === "facets" || key === "equivalentProblems") continue;
    if (!sameJson(current[key], edited[key])) {
      throw needsEditError(nodeId, `the needs edit may not change "${key}"`);
    }
  }
  const currentFacets = Array.isArray(current.facets) ? current.facets.map((entry) => object(entry, "facet")) : [];
  const editedFacets = Array.isArray(edited.facets) ? edited.facets : undefined;
  if (editedFacets === undefined) throw needsEditError(nodeId, "the needs edit must keep a facets list");
  if (editedFacets.length < MIN_FACETS) {
    throw needsEditError(nodeId, `at least ${MIN_FACETS} facets must remain`);
  }
  let cursor = 0;
  for (const raw of editedFacets) {
    const facet = object(raw, "edited facet");
    let match = -1;
    for (let index = cursor; index < currentFacets.length; index += 1) {
      if (currentFacets[index]!.name === facet.name) {
        match = index;
        break;
      }
    }
    if (match < 0) {
      throw needsEditError(nodeId, `facet "${String(facet.name)}" is not one of the classifier's facets (or is out of order)`);
    }
    const original = currentFacets[match]!;
    cursor = match + 1;
    for (const key of Object.keys(facet)) {
      if (!Object.prototype.hasOwnProperty.call(original, key)) {
        throw needsEditError(nodeId, `facet "${String(facet.name)}" may not gain "${key}"`);
      }
    }
    for (const key of Object.keys(original)) {
      if (key === "relevance" || key === "aliases") continue;
      if (!sameJson(original[key], facet[key])) {
        throw needsEditError(nodeId, `facet "${String(facet.name)}" may not change "${key}"`);
      }
    }
    if (!unitInterval(facet.relevance)) {
      throw needsEditError(nodeId, `facet "${String(facet.name)}" needs a relevance within [0, 1]`);
    }
    if (facet.aliases !== undefined) {
      const kept = Array.isArray(facet.aliases) ? facet.aliases : undefined;
      const known = Array.isArray(original.aliases) ? original.aliases : [];
      if (kept === undefined) throw needsEditError(nodeId, `facet "${String(facet.name)}" aliases must be a list`);
      let at = 0;
      for (const alias of kept) {
        while (at < known.length && known[at] !== alias) at += 1;
        if (at >= known.length) {
          throw needsEditError(nodeId, `facet "${String(facet.name)}" alias "${String(alias)}" is not one of its aliases (or is out of order)`);
        }
        at += 1;
      }
    }
  }
  if (edited.equivalentProblems !== undefined) {
    const kept = Array.isArray(edited.equivalentProblems) ? edited.equivalentProblems : undefined;
    const known = Array.isArray(current.equivalentProblems) ? current.equivalentProblems.map((entry) => object(entry, "equivalent problem")) : [];
    if (kept === undefined) throw needsEditError(nodeId, "equivalentProblems must be a list");
    let at = 0;
    for (const raw of kept) {
      const entry = object(raw, "edited equivalent problem");
      while (at < known.length && known[at]!.name !== entry.name) at += 1;
      if (at >= known.length) {
        throw needsEditError(nodeId, `equivalent problem "${String(entry.name)}" is not one of the classifier's (or is out of order)`);
      }
      const original = known[at]!;
      at += 1;
      for (const key of new Set([...Object.keys(original), ...Object.keys(entry)])) {
        if (key === "confidence") continue;
        if (!sameJson(original[key], entry[key])) {
          throw needsEditError(nodeId, `equivalent problem "${String(entry.name)}" may not change "${key}"`);
        }
      }
      if (!unitInterval(entry.confidence)) {
        throw needsEditError(nodeId, `equivalent problem "${String(entry.name)}" needs a confidence within [0, 1]`);
      }
    }
  }
  const parsed = embeddingInputSchema.safeParse(edited);
  if (!parsed.success) {
    throw needsEditError(
      nodeId,
      `the edited embedding input is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
    );
  }
  return edited;
}

/**
 * Validates a gate action and applies the permitted edits: the declared
 * remove-only retention, plus any user-added custom seats (accepted with
 * either action of a gate that edits the panel — additions are an explicit
 * host capability layered on the content's remove-only rule, so the
 * submitter can seat expertise the automatic selection missed).
 *
 * A classification revise is checked against the in-memory content bundle
 * (`roots`), never against run state: the input-type catalog is deliberately
 * not state-backed, so it cannot reach the checkpoint journal.
 */
export function applyGateDecision(
  state: JsonObject,
  scope: ScopeReader,
  node: ContentHumanGateNode,
  response: JsonValue,
  roots: ReferenceRoots,
): JsonObject {
  const decision = normalizedDecision(response);
  const action = node.gate.actions.find((candidate) => candidate.id === decision.action);
  if (!action) {
    throw new BrainstormRuntimeError(
      `human gate "${node.id}" does not allow action "${decision.action}"`,
      "INVALID_GATE_DECISION",
    );
  }
  // Additions target the same collection the gate's remove-only action edits.
  const editableTarget = node.gate.actions.find(
    (candidate) => candidate.editRule === "removeOnly" && candidate.edits,
  )?.edits;

  let next = state;
  let panelEdited = false;
  if (action.editRule === "removeOnly") {
    if (!action.edits) {
      throw new BrainstormRuntimeError(
        `human gate "${node.id}" remove-only action has no edit target`,
        "INVALID_GATE",
      );
    }
    if (!Array.isArray(decision.members)) {
      throw new BrainstormRuntimeError(
        `human gate "${node.id}" shrink action needs a members array`,
        "INVALID_GATE_DECISION",
      );
    }
    const requestedIds = new Set(
      decision.members.map((entry) => {
        if (typeof entry === "string") return entry;
        const member = object(entry, "retained member");
        if (typeof member.id !== "string") {
          throw new BrainstormRuntimeError("retained members need string ids", "INVALID_GATE_DECISION");
        }
        return member.id;
      }),
    );
    const existing = resolveDataReference(action.edits, scope, state, { required: true });
    if (!Array.isArray(existing)) {
      throw new BrainstormRuntimeError(
        `human gate edit target "${action.edits}" is not an array`,
        "INVALID_GATE",
      );
    }
    const knownIds = new Set(
      existing.map((entry) => {
        const member = object(entry, "panel member");
        if (typeof member.id !== "string") {
          throw new BrainstormRuntimeError("panel member has no id", "INVALID_RUNTIME_STATE");
        }
        return member.id;
      }),
    );
    for (const id of requestedIds) {
      if (!knownIds.has(id)) {
        throw new BrainstormRuntimeError(
          `human gate "${node.id}" cannot add unknown member "${id}"`,
          "INVALID_GATE_DECISION",
        );
      }
    }
    const retained = existing.filter((entry) => requestedIds.has((entry as JsonObject).id as string));
    next = writeDataReference(state, action.edits, retained, scope).state;
    panelEdited = true;
  } else if (decision.members !== undefined) {
    throw new BrainstormRuntimeError(
      `human gate action "${decision.action}" does not permit edits`,
      "INVALID_GATE_DECISION",
    );
  }

  if (action.editRule === "classification") {
    if (!action.edits) {
      throw new BrainstormRuntimeError(
        `human gate "${node.id}" classification action has no edit target`,
        "INVALID_GATE",
      );
    }
    const hasType = decision.type !== undefined;
    const hasRequested = decision.requestedOutputs !== undefined;
    // A revise carrying neither field is a plain approval of the merged
    // primary decision; edits apply only to the fields actually sent.
    if (hasType || hasRequested) {
      const current = object(
        resolveDataReference(action.edits, scope, next, { required: true }),
        "classification edit target",
      );
      const edited: Record<string, JsonValue> = { ...current };
      if (hasType) {
        const type = decision.type;
        const knownTypes = resolveDataReference("bundle.inputTypes.types", scope, next, {
          required: true,
          roots,
        });
        if (
          typeof type !== "string" ||
          type.trim().length === 0 ||
          typeof knownTypes !== "object" ||
          knownTypes === null ||
          Array.isArray(knownTypes) ||
          !Object.prototype.hasOwnProperty.call(knownTypes, type)
        ) {
          throw new BrainstormRuntimeError(
            `human gate "${node.id}" cannot set type "${String(type)}": not a type of the loaded input-type catalog`,
            "INVALID_GATE_DECISION",
          );
        }
        edited.type = type;
      }
      if (hasRequested) {
        if (
          !Array.isArray(decision.requestedOutputs) ||
          decision.requestedOutputs.length > MAX_REQUESTED_OUTPUTS
        ) {
          throw new BrainstormRuntimeError(
            `human gate "${node.id}" accepts at most ${MAX_REQUESTED_OUTPUTS} requested outputs`,
            "INVALID_GATE_DECISION",
          );
        }
        const titles = new Set<string>();
        const entries = decision.requestedOutputs.map((raw) => {
          const entry = object(raw, "requested output");
          if (
            typeof entry.title !== "string" ||
            entry.title.trim().length === 0 ||
            typeof entry.ask !== "string" ||
            entry.ask.trim().length === 0
          ) {
            throw new BrainstormRuntimeError(
              "each requested output needs a non-empty title and ask",
              "INVALID_GATE_DECISION",
            );
          }
          if (titles.has(entry.title)) {
            throw new BrainstormRuntimeError(
              `duplicate requested-output title "${entry.title}"`,
              "INVALID_GATE_DECISION",
            );
          }
          titles.add(entry.title);
          return { title: entry.title, ask: entry.ask };
        });
        if (entries.length > 0) {
          edited.requestedOutputs = entries;
        } else {
          delete edited.requestedOutputs;
        }
      }
      next = writeDataReference(next, action.edits, edited, scope).state;
      // The edited input must still be a valid structured input — the same
      // schema every downstream task reads (title/ask floors included).
      validateArtifact(
        "processorOutput",
        node.id,
        resolveDataReference(action.edits, scope, next, { required: true })!,
      );
    }
  } else if (decision.type !== undefined || decision.requestedOutputs !== undefined) {
    throw new BrainstormRuntimeError(
      `human gate action "${decision.action}" does not permit classification edits`,
      "INVALID_GATE_DECISION",
    );
  }

  if (action.editRule === "needs") {
    if (!action.edits) {
      throw new BrainstormRuntimeError(
        `human gate "${node.id}" needs action has no edit target`,
        "INVALID_GATE",
      );
    }
    // An edit carrying no embedding input is a plain approval of the needs.
    if (decision.embeddingInput !== undefined) {
      const current = object(
        resolveDataReference(action.edits, scope, next, { required: true }),
        "needs edit target",
      );
      const edited = applyNeedsEdit(current, decision.embeddingInput, node.id);
      next = writeDataReference(next, action.edits, edited, scope).state;
    }
  } else if (decision.embeddingInput !== undefined) {
    throw new BrainstormRuntimeError(
      `human gate action "${decision.action}" does not permit needs edits`,
      "INVALID_GATE_DECISION",
    );
  }

  if (decision.addedMembers !== undefined) {
    if (!Array.isArray(decision.addedMembers)) {
      throw new BrainstormRuntimeError(
        `human gate "${node.id}" addedMembers must be an array`,
        "INVALID_GATE_DECISION",
      );
    }
    if (decision.addedMembers.length > 0) {
      if (!editableTarget) {
        throw new BrainstormRuntimeError(
          `human gate "${node.id}" has no editable panel to add seats to`,
          "INVALID_GATE_DECISION",
        );
      }
      const current = resolveDataReference(editableTarget, scope, next, { required: true });
      if (!Array.isArray(current)) {
        throw new BrainstormRuntimeError(
          `human gate edit target "${editableTarget}" is not an array`,
          "INVALID_GATE",
        );
      }
      const added = decision.addedMembers.map((entry, index) =>
        customSeatMember(entry, index + 1),
      );
      const merged = [...current, ...added];
      if (merged.length > MAX_PANEL_MEMBERS) {
        throw new BrainstormRuntimeError(
          `the confirmed panel may seat at most ${MAX_PANEL_MEMBERS} members`,
          "INVALID_GATE_DECISION",
        );
      }
      next = writeDataReference(next, editableTarget, merged, scope).state;
      panelEdited = true;
    }
  }

  if (panelEdited) {
    const panel = resolveDataReference("panel", scope, next, { required: true })!;
    validateArtifact("panel", node.id, panel);
  }

  const runtime = object(next._runtime, "_runtime");
  const gates = object(runtime.gates, "_runtime.gates");
  return {
    ...next,
    _runtime: {
      ...runtime,
      gates: { ...gates, [node.id]: decision as unknown as JsonObject },
    },
  };
}
