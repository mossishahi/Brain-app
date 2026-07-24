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

/** Validates a gate action and applies only the declared remove-only edit. */
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

  let next = state;
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
    const panel = resolveDataReference("panel", scope, next, { required: true })!;
    validateArtifact("panel", node.id, panel);
  } else if (decision.members !== undefined) {
    throw new BrainstormRuntimeError(
      `human gate action "${decision.action}" does not permit edits`,
      "INVALID_GATE_DECISION",
    );
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
