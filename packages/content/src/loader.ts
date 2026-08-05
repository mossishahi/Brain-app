import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
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

/**
 * Where a bundle's documents come from.
 *
 * Content is an INPUT to a run, not something the host keeps: a registry-backed
 * run holds the fetched bundle in memory for the life of the process and never
 * writes it to disk, while local development reads a directory. Both satisfy
 * this interface, so the loader and validator are identical either way.
 */
export interface ContentSource {
  /** Human-readable origin, used to locate validation issues. */
  readonly label: string;
  /** Reads a bundle-relative path; undefined when the source has no such file. */
  read(relativePath: string): string | undefined;
  /** Bundle-relative paths under `prefix` ending in `suffix`, sorted. */
  list(prefix: string, suffix: string): readonly string[];
}

/** A bundle materialized on disk — local development and the offline path. */
export function directoryContentSource(contentDir: string): ContentSource {
  const walk = (dir: string, suffix: string, out: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, suffix, out);
      else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(full);
    }
  };
  return {
    label: contentDir,
    read(relativePath) {
      try {
        return readFileSync(join(contentDir, relativePath), "utf8");
      } catch {
        return undefined;
      }
    },
    list(prefix, suffix) {
      const root = join(contentDir, prefix);
      const absolute: string[] = [];
      walk(root, suffix, absolute);
      return absolute
        .map((file) => relative(contentDir, file).split(sep).join("/"))
        .sort();
    },
  };
}

/**
 * A bundle held only in memory — the registry path. Nothing here ever touches
 * the filesystem, so a run leaves no copy of the pipeline behind; the version
 * pin (which carries no content, only names and hashes) stays the durable
 * record of what ran.
 */
export function memoryContentSource(
  label: string,
  files: ReadonlyMap<string, string>,
): ContentSource {
  return {
    label,
    read: (relativePath) => files.get(relativePath),
    list(prefix, suffix) {
      const scope = prefix.endsWith("/") ? prefix : `${prefix}/`;
      return [...files.keys()]
        .filter((path) => path.startsWith(scope) && path.endsWith(suffix))
        .sort();
    },
  };
}

function sourceOf(source: ContentSource | string): ContentSource {
  return typeof source === "string" ? directoryContentSource(source) : source;
}

/** Where an issue in a bundle-relative file is reported. */
function at(source: ContentSource, relativePath: string): string {
  return `${source.label}/${relativePath}`;
}

function parseJsonFile<T>(
  source: ContentSource,
  relativePath: string,
  schema: ZodType<T>,
  issues: ValidationIssue[],
): T | undefined {
  const filePath = at(source, relativePath);
  const raw = source.read(relativePath);
  if (raw === undefined) {
    issues.push(structuralIssue(filePath, "cannot read file"));
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

function safeListFiles(
  source: ContentSource,
  prefix: string,
  suffix: string,
  issues: ValidationIssue[],
): readonly string[] {
  try {
    return source.list(prefix, suffix);
  } catch (err) {
    issues.push(structuralIssue(at(source, prefix), `cannot list: ${(err as Error).message}`));
    return [];
  }
}

/** Parses skill text that has already been read (and hash-verified) elsewhere. */
export function parseSkillText(
  text: string,
  filePath: string,
  issues: ValidationIssue[],
): Skill | undefined {
  return parseSkillBody(text, filePath, issues);
}

function parseSkillFile(
  source: ContentSource,
  relativePath: string,
  issues: ValidationIssue[],
): Skill | undefined {
  const filePath = at(source, relativePath);
  const raw = source.read(relativePath);
  if (raw === undefined) {
    issues.push(structuralIssue(filePath, "cannot read file"));
    return undefined;
  }
  return parseSkillBody(raw, filePath, issues);
}

function parseSkillBody(
  raw: string,
  filePath: string,
  issues: ValidationIssue[],
): Skill | undefined {
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
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ContentValidationError([
      structuralIssue(filePath, `cannot read file: ${(err as Error).message}`),
    ]);
  }
  const skill = parseSkillText(raw, filePath, issues);
  if (!skill || issues.length > 0) throw new ContentValidationError(issues);
  return skill;
}

export function readWorkflowFile(filePath: string): WorkflowDefinition {
  const issues: ValidationIssue[] = [];
  const workflow = parseJsonFile(
    directoryContentSource(dirname(filePath)),
    basename(filePath),
    workflowSchema,
    issues,
  );
  if (!workflow || issues.length > 0) throw new ContentValidationError(issues);
  return workflow;
}

/**
 * Host-side read and structural validation of a materialized Brain Registry
 * directory (JSON documents and skill front matter), without cross-validation.
 * Throws ContentValidationError when any document is unreadable or malformed.
 */
export function readContentBundle(from: ContentSource | string): ContentBundle {
  const source = sourceOf(from);
  const issues: ValidationIssue[] = [];

  const workflows: Record<string, WorkflowDefinition> = {};
  for (const file of safeListFiles(source, "workflows", ".workflow.json", issues)) {
    const workflow = parseJsonFile(source, file, workflowSchema, issues);
    if (!workflow) continue;
    if (workflows[workflow.name]) {
      issues.push(structuralIssue(at(source, file), `duplicate workflow name "${workflow.name}"`));
      continue;
    }
    workflows[workflow.name] = workflow;
  }
  if (Object.keys(workflows).length === 0 && issues.length === 0) {
    issues.push(structuralIssue(at(source, "workflows"), "no workflow definitions found"));
  }

  const routes = parseJsonFile(source, "routes/model-routes.json", routesSchema, issues);
  const activities = parseJsonFile(source, "catalog/activity-handlers.json", activitiesSchema, issues);
  const capabilities = parseJsonFile(source, "capabilities/capabilities.json", capabilitiesSchema, issues);
  const inputTypes = parseJsonFile(source, "catalog/input-types.json", inputTypesCatalogSchema, issues);
  const verdicts = parseJsonFile(source, "catalog/verdicts.json", verdictsCatalogSchema, issues);
  const departments = parseJsonFile(source, "catalog/departments.json", departmentsCatalogSchema, issues);

  const skills: Record<string, Skill> = {};
  for (const file of safeListFiles(source, "skills", ".md", issues)) {
    const skill = parseSkillFile(source, file, issues);
    if (!skill) continue;
    if (skills[skill.meta.name]) {
      issues.push({ code: "DUPLICATE_SKILL", path: at(source, file), message: `duplicate skill name "${skill.meta.name}"` });
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
export function loadContent(from: ContentSource | string): ContentBundle {
  const bundle = readContentBundle(from);
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
  from: ContentSource | string,
  workflowPath: string,
  availableRoleNames: ReadonlySet<string>,
): ContentBundle {
  const source = sourceOf(from);
  const issues: ValidationIssue[] = [];
  const workflow = parseJsonFile(source, workflowPath, workflowSchema, issues);
  const routes = parseJsonFile(source, "routes/model-routes.json", routesSchema, issues);
  const activities = parseJsonFile(source, "catalog/activity-handlers.json", activitiesSchema, issues);
  const capabilities = parseJsonFile(source, "capabilities/capabilities.json", capabilitiesSchema, issues);
  const inputTypes = parseJsonFile(source, "catalog/input-types.json", inputTypesCatalogSchema, issues);
  const verdicts = parseJsonFile(source, "catalog/verdicts.json", verdictsCatalogSchema, issues);
  const departments = parseJsonFile(source, "catalog/departments.json", departmentsCatalogSchema, issues);
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
