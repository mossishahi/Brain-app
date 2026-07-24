import type { ContentBundle, Skill } from "@brainstorm-agentic/content";
import type { JsonObject, JsonValue } from "@brainstorm-agentic/core";

import { BrainstormRuntimeError } from "./errors.js";

const MUSTACHE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

function renderValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export interface CompiledSkillPrompt {
  readonly system: string;
  readonly skills: readonly string[];
  readonly capabilities: readonly string[];
}

/** Folds technique instructions into a role and renders only declared vars. */
export function compileSkillPrompt(
  bundle: ContentBundle,
  role: Skill,
  bindings: JsonObject,
): CompiledSkillPrompt {
  if (role.meta.kind !== "role") {
    throw new BrainstormRuntimeError(`skill "${role.meta.name}" is not a role`, "INVALID_SKILL");
  }
  const techniques = role.meta.techniques.map((name) => {
    const technique = bundle.skills[name];
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

  const renderedRole = role.body.replace(MUSTACHE, (_whole, variable: string) => {
    const value = bindings[variable];
    if (value === undefined) {
      throw new BrainstormRuntimeError(
        `role "${role.meta.name}" template variable "${variable}" did not resolve`,
        "MISSING_SKILL_BINDING",
      );
    }
    return renderValue(value);
  });
  if (MUSTACHE.test(renderedRole)) {
    throw new BrainstormRuntimeError(
      `role "${role.meta.name}" contains unresolved template variables`,
      "MISSING_SKILL_BINDING",
    );
  }

  const techniqueText = techniques
    .map((technique) => `## Included technique: ${technique.meta.name}\n\n${technique.body}`)
    .join("\n\n---\n\n");
  const system = techniqueText.length > 0
    ? `${techniqueText}\n\n---\n\n## Role task: ${role.meta.name}\n\n${renderedRole}`
    : renderedRole;
  return {
    system,
    skills: [role.meta.name, ...techniques.map((technique) => technique.meta.name)],
    capabilities: unique([
      ...role.meta.capabilities,
      ...techniques.flatMap((technique) => technique.meta.capabilities),
    ]),
  };
}
