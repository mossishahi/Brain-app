import type { HumanGateNode as ContentHumanGateNode } from "@brainstorm-agentic/content";
import type { JsonObject, JsonValue, ScopeReader } from "@brainstorm-agentic/core";

import { resolveDataReference, writeDataReference } from "./data-ref.js";
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
}

/** Gate-time panel bounds (mirrors the protocol's PANEL_EDIT_LIMITS). */
const MAX_PANEL_MEMBERS = 12;
const MIN_SEAT_SUBFIELDS = 1;
const MAX_SEAT_SUBFIELDS = 3;

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

/**
 * Validates a gate action and applies the permitted edits: the declared
 * remove-only retention, plus any user-added custom seats (accepted with
 * either action of a gate that edits the panel — additions are an explicit
 * host capability layered on the content's remove-only rule, so the
 * submitter can seat expertise the automatic selection missed).
 */
export function applyGateDecision(
  state: JsonObject,
  scope: ScopeReader,
  node: ContentHumanGateNode,
  response: JsonValue,
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
