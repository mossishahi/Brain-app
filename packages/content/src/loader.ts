import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";

import { parseFrontMatter } from "./frontmatter.js";
import {
  activitiesSchema,
  capabilitiesSchema,
  departmentsCatalogSchema,
  inputTypesCatalogSchema,
  routesSchema,
  skillMetaSchema,
  verdictsCatalogSchema,
  workflowSchema,
  type Skill,
  type WorkflowDefinition,
} from "./schemas/workflow.js";
import {
  ContentValidationError,
  validateBundle,
  type ContentBundle,
  type ValidationIssue,
} from "./validate.js";

function structuralIssue(path: string, message: string): ValidationIssue {
  return { code: "SCHEMA_INVALID", path, message };
}

function parseJsonFile<T>(filePath: string, schema: ZodType<T>, issues: ValidationIssue[]): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    issues.push(structuralIssue(filePath, `cannot read file: ${(err as Error).message}`));
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    issues.push(structuralIssue(filePath, `not valid JSON: ${(err as Error).message}`));
    return undefined;
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push(structuralIssue(`${filePath} > ${issue.path.join(".") || "(root)"}`, issue.message));
    }
    return undefined;
  }
  return result.data;
}

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out.sort();
}

function safeListFiles(dir: string, suffix: string, issues: ValidationIssue[]): string[] {
  try {
    return listFiles(dir, suffix);
  } catch (err) {
    issues.push(structuralIssue(dir, `cannot list directory: ${(err as Error).message}`));
    return [];
  }
}

function parseSkillFile(filePath: string, issues: ValidationIssue[]): Skill | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    issues.push(structuralIssue(filePath, `cannot read file: ${(err as Error).message}`));
    return undefined;
  }
  let parsed;
  try {
    parsed = parseFrontMatter(raw);
  } catch (err) {
    issues.push(structuralIssue(filePath, (err as Error).message));
    return undefined;
  }
  const meta = skillMetaSchema.safeParse(parsed.data);
  if (!meta.success) {
    for (const issue of meta.error.issues) {
      issues.push(structuralIssue(`${filePath} > ${issue.path.join(".") || "(root)"}`, issue.message));
    }
    return undefined;
  }
  const body = parsed.body.trim();
  if (body.length === 0) {
    issues.push(structuralIssue(filePath, "skill body is empty"));
    return undefined;
  }
  return { meta: meta.data, body, sourcePath: filePath };
}

/**
 * Host-side read and structural validation of a materialized Brain Registry
 * directory (JSON documents and skill front matter), without cross-validation.
 * Throws ContentValidationError when any document is unreadable or malformed.
 */
export function readContentBundle(contentDir: string): ContentBundle {
  const issues: ValidationIssue[] = [];

  const workflows: Record<string, WorkflowDefinition> = {};
  for (const file of safeListFiles(join(contentDir, "workflows"), ".workflow.json", issues)) {
    const workflow = parseJsonFile(file, workflowSchema, issues);
    if (!workflow) continue;
    if (workflows[workflow.name]) {
      issues.push(structuralIssue(file, `duplicate workflow name "${workflow.name}"`));
      continue;
    }
    workflows[workflow.name] = workflow;
  }
  if (Object.keys(workflows).length === 0 && issues.length === 0) {
    issues.push(structuralIssue(join(contentDir, "workflows"), "no workflow definitions found"));
  }

  const routes = parseJsonFile(join(contentDir, "routes", "model-routes.json"), routesSchema, issues);
  const activities = parseJsonFile(
    join(contentDir, "catalog", "activity-handlers.json"),
    activitiesSchema,
    issues,
  );
  const capabilities = parseJsonFile(join(contentDir, "capabilities", "capabilities.json"), capabilitiesSchema, issues);
  const inputTypes = parseJsonFile(join(contentDir, "catalog", "input-types.json"), inputTypesCatalogSchema, issues);
  const verdicts = parseJsonFile(join(contentDir, "catalog", "verdicts.json"), verdictsCatalogSchema, issues);
  const departments = parseJsonFile(join(contentDir, "catalog", "departments.json"), departmentsCatalogSchema, issues);

  const skills: Record<string, Skill> = {};
  for (const file of safeListFiles(join(contentDir, "skills"), ".md", issues)) {
    const skill = parseSkillFile(file, issues);
    if (!skill) continue;
    if (skills[skill.meta.name]) {
      issues.push({ code: "DUPLICATE_SKILL", path: file, message: `duplicate skill name "${skill.meta.name}"` });
      continue;
    }
    skills[skill.meta.name] = skill;
  }

  if (issues.length > 0 || !routes || !activities || !capabilities || !inputTypes || !verdicts || !departments) {
    throw new ContentValidationError(issues);
  }

  return {
    workflows,
    routes,
    activities,
    capabilities,
    catalogs: { inputTypes, verdicts, departments },
    skills,
  };
}

/**
 * Host-side load and full cross-validation: every workflow node
 * must reference existing skills, routes, activity handlers, and artifact
 * schemas; every activity must be deterministic and bounded; every skill must
 * reference existing techniques and capabilities and pass prompt-hygiene
 * linting; every loop must be bounded. Throws ContentValidationError listing
 * every issue found.
 */
export function loadContent(contentDir: string): ContentBundle {
  const bundle = readContentBundle(contentDir);
  const issues = validateBundle(bundle);
  if (issues.length > 0) {
    throw new ContentValidationError(issues);
  }
  return bundle;
}
