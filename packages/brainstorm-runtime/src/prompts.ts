import type { Skill } from "@brainstorm-agentic/content";
import type {
  JsonObject,
  JsonValue,
  SystemPromptSegment,
} from "@brainstorm-agentic/core";

import { BrainstormRuntimeError } from "./errors.js";

const MUSTACHE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

function renderValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export interface CompiledSkillPrompt {
  /**
   * Ordered system-prompt segments. Instruction text comes first and is marked
   * cacheable once the role declares payload vars, because everything left in
   * the body is then per-call-stable framing.
   */
  readonly system: readonly SystemPromptSegment[];
  /** Payload bindings in declared order; delivered as task data, not instructions. */
  readonly payload: readonly PayloadEntry[];
  readonly skills: readonly string[];
  readonly capabilities: readonly string[];
}

export interface PayloadEntry {
  readonly name: string;
  readonly value: JsonValue;
}

/** Folds technique instructions into a role and renders only declared vars. */
export function compileSkillPrompt(
  role: Skill,
  techniques: readonly Skill[],
  bindings: JsonObject,
): CompiledSkillPrompt {
  if (role.meta.kind !== "role") {
    throw new BrainstormRuntimeError(`skill "${role.meta.name}" is not a role`, "INVALID_SKILL");
  }
  const techniqueByName = new Map(
    techniques.map((technique) => [technique.meta.name, technique]),
  );
  const orderedTechniques = role.meta.techniques.map((name) => {
    const technique = techniqueByName.get(name);
    if (!technique || technique.meta.kind !== "technique") {
      throw new BrainstormRuntimeError(
        `role "${role.meta.name}" references missing technique "${name}"`,
        "INVALID_SKILL",
      );
    }
    return technique;
  });
  for (const variable of role.meta.vars) {
    if (!Object.prototype.hasOwnProperty.call(bindings, variable)) {
      throw new BrainstormRuntimeError(
        `role "${role.meta.name}" has no runtime binding for "${variable}"`,
        "MISSING_SKILL_BINDING",
      );
    }
  }

  const payloadVars = new Set(role.meta.payload);
  // Technique bodies render with the role's bindings: a technique may declare
  // vars (e.g. the seat's expertise) and the including role must cover them
  // with non-payload vars — enforced at content validation time.
  const render = (owner: string, body: string): string => {
    const rendered = body.replace(MUSTACHE, (_whole, variable: string) => {
      if (payloadVars.has(variable)) {
        throw new BrainstormRuntimeError(
          `skill "${owner}" renders payload var "${variable}" into its instructions`,
          "PAYLOAD_VAR_IN_BODY",
        );
      }
      const value = bindings[variable];
      if (value === undefined) {
        throw new BrainstormRuntimeError(
          `skill "${owner}" template variable "${variable}" did not resolve`,
          "MISSING_SKILL_BINDING",
        );
      }
      return renderValue(value);
    });
    if (MUSTACHE.test(rendered)) {
      throw new BrainstormRuntimeError(
        `skill "${owner}" contains unresolved template variables`,
        "MISSING_SKILL_BINDING",
      );
    }
    return rendered;
  };
  const renderedRole = render(role.meta.name, role.body);

  const techniqueText = orderedTechniques
    .map(
      (technique) =>
        `## Included technique: ${technique.meta.name}\n\n${render(technique.meta.name, technique.body)}`,
    )
    .join("\n\n---\n\n");
  const instructions = techniqueText.length > 0
    ? `${techniqueText}\n\n---\n\n## Role task: ${role.meta.name}\n\n${renderedRole}`
    : renderedRole;
  return {
    // Without declared payload vars the body still carries per-call data, so
    // the segment must not claim to be cacheable.
    system: [{ text: instructions, ...(payloadVars.size > 0 ? { cacheable: true } : {}) }],
    payload: role.meta.payload.map((name) => ({ name, value: bindings[name]! })),
    skills: [
      role.meta.name,
      ...orderedTechniques.map((technique) => technique.meta.name),
    ],
    capabilities: unique([
      ...role.meta.capabilities,
      ...orderedTechniques.flatMap((technique) => technique.meta.capabilities),
    ]),
  };
}
