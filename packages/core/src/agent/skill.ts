import type { JsonObject } from "../types/json.js";

/**
 * A skill is reusable prompt/knowledge material an executor can activate for
 * a task: instruction text plus optional named assets (templates, rubrics).
 */
export interface Skill {
  readonly name: string;
  readonly description?: string;
  /** Instruction text injected into the system prompt when activated. */
  readonly instructions: string;
  /** Named auxiliary documents the executor may reference or inline. */
  readonly assets?: { readonly [assetName: string]: string };
  readonly metadata?: JsonObject;
}

export interface SkillRegistry {
  get(name: string): Skill | undefined;
  list(): readonly Skill[];
}

export class InMemorySkillRegistry implements SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): this {
    if (this.skills.has(skill.name)) {
      throw new Error(`skill "${skill.name}" is already registered`);
    }
    this.skills.set(skill.name, skill);
    return this;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): readonly Skill[] {
    return [...this.skills.values()];
  }
}
