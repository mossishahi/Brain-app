import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";

import { parseFrontMatter } from "./frontmatter.js";
import type { OutputShape } from "./schemas/artifacts.js";
import {
  activitiesSchema,
  capabilitiesSchema,
  departmentsCatalogSchema,
  inputTypesCatalogSchema,
  routesSchema,
  skillMetaSchema,
  verdictsCatalogSchema,
  workflowSchema,
  type InputTypesCatalog,
  type LoadedInputTypes,
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

export function readSkillFile(filePath: string): Skill {
  const issues: ValidationIssue[] = [];
  const skill = parseSkillFile(filePath, issues);
  if (!skill || issues.length > 0) throw new ContentValidationError(issues);
  return skill;
}

export function readWorkflowFile(filePath: string): WorkflowDefinition {
  const issues: ValidationIssue[] = [];
  const workflow = parseJsonFile(filePath, workflowSchema, issues);
  if (!workflow || issues.length > 0) throw new ContentValidationError(issues);
  return workflow;
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
    catalogs: {
      inputTypes: projectInputTypes(inputTypes),
      verdicts,
      departments,
    },
    skills,
  };
}

/**
 * Flattens the on-disk input-types catalog into the bind-friendly projections
 * of `LoadedInputTypes`. Description-only entries (pre-0.2.0 bundles) project
 * into `types` alone; full definitions also fill `shapes`, `guidance`, and
 * `outlines`. Insertion order is preserved everywhere — it is the processor's
 * disambiguation order.
 */
function projectInputTypes(catalog: InputTypesCatalog): LoadedInputTypes {
  const types: Record<string, string> = {};
  const shapes: Record<string, OutputShape> = {};
  const guidance: Record<string, string> = {};
  const outlines: Record<string, Record<string, string>> = {};
  const shapeGuides: Record<string, string> = {};
  for (const [name, entry] of Object.entries(catalog.types)) {
    if (typeof entry === "string") {
      types[name] = entry;
      continue;
    }
    types[name] = entry.description;
    shapes[name] = entry.shape;
    guidance[name] = entry.guidance;
    outlines[name] = entry.outline;
    const rule = catalog.shapeRules?.[entry.shape];
    if (rule !== undefined) shapeGuides[name] = rule;
  }
  return { version: catalog.version, types, shapes, guidance, outlines, shapeGuides };
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

/**
 * Loads only the workflow/control plane needed to compile a pinned run. Role
 * and technique files remain absent until an agent node first executes.
 */
export function loadControlContent(
  contentDir: string,
  workflowPath: string,
  availableRoleNames: ReadonlySet<string>,
): ContentBundle {
  const issues: ValidationIssue[] = [];
  const workflow = parseJsonFile(
    join(contentDir, workflowPath),
    workflowSchema,
    issues,
  );
  const routes = parseJsonFile(
    join(contentDir, "routes", "model-routes.json"),
    routesSchema,
    issues,
  );
  const activities = parseJsonFile(
    join(contentDir, "catalog", "activity-handlers.json"),
    activitiesSchema,
    issues,
  );
  const capabilities = parseJsonFile(
    join(contentDir, "capabilities", "capabilities.json"),
    capabilitiesSchema,
    issues,
  );
  const inputTypes = parseJsonFile(
    join(contentDir, "catalog", "input-types.json"),
    inputTypesCatalogSchema,
    issues,
  );
  const verdicts = parseJsonFile(
    join(contentDir, "catalog", "verdicts.json"),
    verdictsCatalogSchema,
    issues,
  );
  const departments = parseJsonFile(
    join(contentDir, "catalog", "departments.json"),
    departmentsCatalogSchema,
    issues,
  );
  if (
    issues.length > 0 ||
    !workflow ||
    !routes ||
    !activities ||
    !capabilities ||
    !inputTypes ||
    !verdicts ||
    !departments
  ) {
    throw new ContentValidationError(issues);
  }
  const bundle: ContentBundle = {
    workflows: { [workflow.name]: workflow },
    routes,
    activities,
    capabilities,
    catalogs: {
      inputTypes: projectInputTypes(inputTypes),
      verdicts,
      departments,
    },
    skills: {},
  };
  const validation = validateBundle(bundle, { availableRoleNames });
  if (validation.length > 0) throw new ContentValidationError(validation);
  return bundle;
}
