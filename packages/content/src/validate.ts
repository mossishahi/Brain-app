import { artifactSchemas, SHAPE_FIELDS } from "./schemas/artifacts.js";
import type {
  ActivityRegistry,
  BindValue,
  CapabilityCatalog,
  ConditionExpr,
  DepartmentsCatalog,
  LoadedInputTypes,
  ModelRoutes,
  Skill,
  VerdictsCatalog,
  WorkflowDefinition,
  WorkflowNode,
} from "./schemas/workflow.js";

/** Hard ceiling for repeatUntil bounds: anything above is treated as effectively unbounded. */
export const MAX_REPEAT_BOUND = 10;

/** Runtime-provided reference roots that are always in scope. */
const SESSION_ROOT = "session";
/** Runtime-provided reference roots that only exist inside a repeatUntil review round. */
const REVIEW_FIELDS = new Set(["allowedVerdicts", "round", "history"]);

export interface ContentBundle {
  workflows: Record<string, WorkflowDefinition>;
  routes: ModelRoutes;
  /** Logical deterministic runtime handlers available to activity nodes. */
  activities: ActivityRegistry;
  capabilities: CapabilityCatalog;
  catalogs: {
    /**
     * The projected view of catalog/input-types.json — the single reference
     * file that defines the submission types the pipeline considers. See
     * `LoadedInputTypes` for the projections and `validateInputTypes` for the
     * load-time consistency rules.
     */
    inputTypes: LoadedInputTypes;
    verdicts: VerdictsCatalog;
    departments: DepartmentsCatalog;
  };
  skills: Record<string, Skill>;
}

export type IssueCode =
  | "SCHEMA_INVALID"
  | "DUPLICATE_NODE_ID"
  | "NO_TERMINAL"
  | "MISSING_SKILL"
  | "WRONG_SKILL_KIND"
  | "MISSING_ROUTE"
  | "MISSING_DEFAULT_ROUTE"
  | "MISSING_ACTIVITY_HANDLER"
  | "NONDETERMINISTIC_ACTIVITY"
  | "UNBOUNDED_ACTIVITY"
  | "ACTIVITY_INPUT_MISMATCH"
  | "ACTIVITY_INPUT_TYPE_MISMATCH"
  | "ACTIVITY_OUTPUT_MISMATCH"
  | "MISSING_SCHEMA"
  | "SKILL_OUTPUT_MISMATCH"
  | "UNBOUND_VAR"
  | "UNKNOWN_BINDING"
  | "MISSING_TECHNIQUE"
  | "TECHNIQUE_VAR_UNCOVERED"
  | "MISSING_CAPABILITY"
  | "UNDECLARED_VAR"
  | "UNUSED_VAR"
  | "PAYLOAD_VAR_IN_BODY"
  | "FORBIDDEN_PROMPT_CONTENT"
  | "UNBOUNDED_LOOP"
  | "LOOP_BOUND_TOO_HIGH"
  | "UNKNOWN_REF"
  | "UNKNOWN_PARAM"
  | "UNKNOWN_CATALOG"
  | "REVIEW_REF_OUTSIDE_LOOP"
  | "UNKNOWN_VERDICT"
  | "DUPLICATE_SKILL"
  | "EMPTY_INPUT_TYPES"
  | "INPUT_TYPES_MIXED_FORMAT"
  | "OUTLINE_SHAPE_MISMATCH"
  | "OUTLINE_SECTION_STUB";

export interface ValidationIssue {
  code: IssueCode;
  /** Human-readable location, e.g. `workflow brainstorm > node judge-step`. */
  path: string;
  message: string;
}

export class ContentValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(
      `content validation failed with ${issues.length} issue(s):\n` +
        issues.map((i) => `  [${i.code}] ${i.path}: ${i.message}`).join("\n"),
    );
    this.name = "ContentValidationError";
  }
}

/**
 * Prompt content that must never appear in a provider-neutral skill: transport
 * mechanics (MCP, submit calls), host process control (spawning subagents or
 * sub-tasks), and filesystem coupling (path template variables, literal paths,
 * write-to-disk instructions). Skills return structured output; the runtime
 * owns transport and persistence.
 */
export const FORBIDDEN_PROMPT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "mcp", pattern: /\bmcp\b/i },
  { name: "brainstorm_submit", pattern: /brainstorm_submit/i },
  { name: "subagent-or-subtask", pattern: /\bsub-?(?:agent|task)s?\b/i },
  { name: "spawning", pattern: /\bspawn(?:s|ed|ing)?\b/i },
  { name: "legacy-path-template", pattern: /\{\{\s*[A-Z][A-Z0-9_]*\s*\}\}/ },
  { name: "file-path", pattern: /(?:^|[\s`"'(])(?:\/|~\/|\.\.?\/)[\w.-]+(?:\/[\w{}~.-]+)+/m },
  { name: "file-write", pattern: /\bwrit(?:e|es|ing|ten)\b[^.\n]{0,60}\b(?:file|files|disk|folder|directory|dir|path|paths)\b/i },
];

const MUSTACHE_VAR = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Body usage and var declaration must agree exactly, except for payload vars:
 * those reach the model as task data, so rendering one into the instructions
 * would put per-call content back into the cacheable prefix (and back into the
 * instruction channel). Shared by publication-time and lazy role validation.
 */
function checkSkillVars(skill: Skill, at: string, issues: ValidationIssue[]): void {
  const used = new Set<string>();
  for (const match of skill.body.matchAll(MUSTACHE_VAR)) used.add(match[1]!);
  const declared = new Set(skill.meta.vars);
  const payload = new Set(skill.meta.payload);
  for (const variable of used) {
    if (!declared.has(variable)) {
      issues.push({
        code: "UNDECLARED_VAR",
        path: at,
        message: `body uses {{${variable}}} which is not declared in vars`,
      });
    } else if (payload.has(variable)) {
      issues.push({
        code: "PAYLOAD_VAR_IN_BODY",
        path: at,
        message: `payload var "${variable}" is delivered as task data and must not appear as {{${variable}}}`,
      });
    }
  }
  for (const variable of declared) {
    if (!used.has(variable) && !payload.has(variable)) {
      issues.push({
        code: "UNUSED_VAR",
        path: at,
        message: `declared var "${variable}" is never used in the body`,
      });
    }
  }
}

function walkNodes(node: WorkflowNode, visit: (node: WorkflowNode) => void): void {
  visit(node);
  switch (node.kind) {
    case "sequence":
      node.steps.forEach((step) => walkNodes(step, visit));
      break;
    case "forEach":
    case "repeatUntil":
      walkNodes(node.body, visit);
      break;
    case "condition":
      walkNodes(node.then, visit);
      if (node.else) walkNodes(node.else, visit);
      break;
    default:
      break;
  }
}

/** Reference roots (output keys) a subtree defines, visible to later siblings. */
function definedRoots(node: WorkflowNode): Set<string> {
  const roots = new Set<string>();
  walkNodes(node, (n) => {
    if (n.kind === "agent" || n.kind === "activity") {
      roots.add(refRoot(n.output.key));
    }
  });
  return roots;
}

/** First dotted segment of a reference, with bracket indexers stripped. */
function refRoot(ref: string): string {
  return ref.replace(/\[[^\]]*\]/g, "").split(".")[0]!;
}

/** Bracket indexer expressions inside a reference that are themselves references. */
function innerRefs(ref: string): string[] {
  const out: string[] = [];
  for (const match of ref.matchAll(/\[([^\]]+)\]/g)) {
    const inner = match[1]!.trim();
    if (inner !== "*" && !/^\d+$/.test(inner)) out.push(inner);
  }
  return out;
}

// ---------------------------------------------------------------------------
// validator
// ---------------------------------------------------------------------------

export interface ValidateBundleOptions {
  /**
   * Role names declared by a pinned manifest but not loaded yet. Their
   * front-matter-specific checks are deferred until first use.
   */
  readonly availableRoleNames?: ReadonlySet<string>;
}

/**
 * Consistency rules for the single editable reference file
 * catalog/input-types.json. This is what makes the file a live setting rather
 * than documentation: a hand edit that breaks any rule fails at load time
 * (server/worker startup, tests, pinned-run compile) with a named issue.
 */
function validateInputTypes(inputTypes: ContentBundle["catalogs"]["inputTypes"], issues: ValidationIssue[]): void {
  const at = "catalog input-types";
  const typeNames = Object.keys(inputTypes.types);
  if (typeNames.length === 0) {
    issues.push({
      code: "EMPTY_INPUT_TYPES",
      path: at,
      message: "the catalog must define at least one submission type",
    });
    return;
  }

  const extended = Object.keys(inputTypes.shapes);
  if (extended.length > 0 && extended.length !== typeNames.length) {
    const missing = typeNames.filter((name) => !(name in inputTypes.shapes));
    issues.push({
      code: "INPUT_TYPES_MIXED_FORMAT",
      path: at,
      message:
        `either every type is a full definition (description, shape, guidance, outline) or every ` +
        `type is a plain description; missing full definitions: ${missing.join(", ")}`,
    });
  }

  // Shape rules are all-or-nothing: once the catalog carries any, every
  // mapped shape must resolve to one — a partially covered dictionary would
  // leave some runs with an unresolvable {{shapeGuide}} binding.
  const guided = Object.keys(inputTypes.shapeGuides);
  if (guided.length > 0 && guided.length !== Object.keys(inputTypes.shapes).length) {
    const uncovered = Object.entries(inputTypes.shapes)
      .filter(([typeName]) => !(typeName in inputTypes.shapeGuides))
      .map(([typeName, shape]) => `"${typeName}" (${shape})`);
    issues.push({
      code: "INPUT_TYPES_MIXED_FORMAT",
      path: at,
      message: `shapeRules must cover every mapped shape; no rule resolves for: ${uncovered.join(", ")}`,
    });
  }
  const ruleByShape = new Map<string, string>();
  for (const [typeName, guide] of Object.entries(inputTypes.shapeGuides)) {
    const shape = inputTypes.shapes[typeName];
    if (shape !== undefined && !ruleByShape.has(shape)) ruleByShape.set(shape, guide);
  }
  for (const [shape, guide] of ruleByShape) {
    const where = `${at} > shapeRules.${shape}`;
    // Rules are injected into already-rendered instructions, so template
    // syntax inside one would surface as an unresolved-variable error at
    // task-compile time; reject it at load time instead.
    if (/\{\{/.test(guide)) {
      issues.push({
        code: "FORBIDDEN_PROMPT_CONTENT",
        path: where,
        message: "shape rules must not contain template syntax ({{...}}); they are injected after rendering",
      });
    }
    for (const { name, pattern } of FORBIDDEN_PROMPT_PATTERNS) {
      if (pattern.test(guide)) {
        issues.push({
          code: "FORBIDDEN_PROMPT_CONTENT",
          path: where,
          message: `matches forbidden pattern "${name}" (${pattern})`,
        });
      }
    }
  }

  for (const [typeName, outline] of Object.entries(inputTypes.outlines)) {
    const shape = inputTypes.shapes[typeName];
    if (!shape) continue; // unreachable per the loader's projection, guarded above
    const expected = [...SHAPE_FIELDS[shape]].sort();
    const actual = Object.keys(outline).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const extra = actual.filter((field) => !expected.includes(field));
      const absent = expected.filter((field) => !actual.includes(field));
      issues.push({
        code: "OUTLINE_SHAPE_MISMATCH",
        path: `${at} > ${typeName}`,
        message:
          `outline sections must be exactly the fields of shape "${shape}"` +
          (absent.length > 0 ? `; missing: ${absent.join(", ")}` : "") +
          (extra.length > 0 ? `; unknown: ${extra.join(", ")}` : ""),
      });
    }
    for (const [section, description] of Object.entries(outline)) {
      if (description.trim().length < 20) {
        issues.push({
          code: "OUTLINE_SECTION_STUB",
          path: `${at} > ${typeName} > ${section}`,
          message: "outline sections need a real description of what the section must contain, not a stub",
        });
      }
    }
  }
}

export function validateBundle(
  bundle: ContentBundle,
  options: ValidateBundleOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const schemaNames = new Set(Object.keys(artifactSchemas));
  const routeNames = new Set(Object.keys(bundle.routes.routes));
  const activityHandlers = bundle.activities.handlers;
  const capabilityNames = new Set(Object.keys(bundle.capabilities.capabilities));
  const catalogNames = new Set(Object.keys(bundle.catalogs));

  // -- routes ---------------------------------------------------------------
  if (!routeNames.has(bundle.routes.defaultRoute)) {
    issues.push({
      code: "MISSING_DEFAULT_ROUTE",
      path: "routes",
      message: `defaultRoute "${bundle.routes.defaultRoute}" is not defined in routes`,
    });
  }

  // -- deterministic runtime activities -----------------------------------
  for (const [key, handler] of Object.entries(activityHandlers)) {
    const at = `activity handler ${key}`;
    if (handler.deterministic !== true) {
      issues.push({
        code: "NONDETERMINISTIC_ACTIVITY",
        path: at,
        message: "workflow activities must be registered as deterministic",
      });
    }
    if (
      !handler.bounds ||
      typeof handler.bounds.outputField !== "string" ||
      typeof handler.bounds.maxItemsFromInput !== "string" ||
      handler.inputs[handler.bounds.maxItemsFromInput]?.kind !== "positiveInteger"
    ) {
      issues.push({
        code: "UNBOUNDED_ACTIVITY",
        path: at,
        message: "activity must declare a typed finite-output bound sourced from one of its inputs",
      });
    }
    if (!schemaNames.has(handler.outputSchema)) {
      issues.push({
        code: "MISSING_SCHEMA",
        path: at,
        message: `output schema "${handler.outputSchema}" is not a known artifact schema`,
      });
    }
    for (const [name, input] of Object.entries(handler.inputs)) {
      if (input.kind === "artifact" && !schemaNames.has(input.schema)) {
        issues.push({
          code: "MISSING_SCHEMA",
          path: `${at} > input ${name}`,
          message: `artifact input schema "${input.schema}" is not a known artifact schema`,
        });
      }
    }
  }

  // -- verdict catalog ------------------------------------------------------
  {
    const verdictNames = new Set(Object.keys(bundle.catalogs.verdicts.verdicts));
    const seq = bundle.catalogs.verdicts.sequencing;
    for (const v of [seq.advanceOn, ...seq.redevelopOn, ...seq.noImmediateRepeat]) {
      if (!verdictNames.has(v)) {
        issues.push({
          code: "UNKNOWN_VERDICT",
          path: "catalog verdicts > sequencing",
          message: `sequencing references verdict "${v}" which is not defined`,
        });
      }
    }
  }

  // -- input-type catalog ----------------------------------------------------
  validateInputTypes(bundle.catalogs.inputTypes, issues);

  // -- skills ---------------------------------------------------------------
  for (const skill of Object.values(bundle.skills)) {
    const at = `skill ${skill.meta.name}`;

    for (const tech of skill.meta.techniques) {
      const found = bundle.skills[tech];
      if (!found) {
        issues.push({ code: "MISSING_TECHNIQUE", path: at, message: `technique "${tech}" does not exist` });
      } else if (found.meta.kind !== "technique") {
        issues.push({
          code: "WRONG_SKILL_KIND",
          path: at,
          message: `"${tech}" is a ${found.meta.kind} skill, not a technique`,
        });
      } else {
        // Technique bodies render with the including role's bindings, so
        // every technique var must be a non-payload var of the role.
        for (const variable of found.meta.vars) {
          if (!skill.meta.vars.includes(variable) || skill.meta.payload.includes(variable)) {
            issues.push({
              code: "TECHNIQUE_VAR_UNCOVERED",
              path: at,
              message: `technique "${tech}" uses {{${variable}}}, which the including role must declare as a non-payload var`,
            });
          }
        }
      }
    }

    for (const cap of skill.meta.capabilities) {
      if (!capabilityNames.has(cap)) {
        issues.push({
          code: "MISSING_CAPABILITY",
          path: at,
          message: `capability "${cap}" is not in the capability catalog`,
        });
      }
    }

    if (skill.meta.output !== undefined && !schemaNames.has(skill.meta.output)) {
      issues.push({
        code: "MISSING_SCHEMA",
        path: at,
        message: `output schema "${skill.meta.output}" is not a known artifact schema`,
      });
    }

    checkSkillVars(skill, at, issues);

    // Prompt hygiene: no transport, host-control, or filesystem coupling.
    for (const { name, pattern } of FORBIDDEN_PROMPT_PATTERNS) {
      for (const [where, text] of [["body", skill.body], ["description", skill.meta.description]] as const) {
        if (pattern.test(text)) {
          issues.push({
            code: "FORBIDDEN_PROMPT_CONTENT",
            path: `${at} > ${where}`,
            message: `matches forbidden pattern "${name}" (${pattern})`,
          });
        }
      }
    }
  }

  // -- workflows ------------------------------------------------------------
  for (const workflow of Object.values(bundle.workflows)) {
    validateWorkflow(
      workflow,
      bundle,
      {
        schemaNames,
        routeNames,
        catalogNames,
        availableRoleNames: options.availableRoleNames,
      },
      issues,
    );
  }

  return issues;
}

/**
 * Validates one lazily loaded role and its already resolved techniques. This
 * is the runtime counterpart to the registry's full publication-time check.
 */
export function validateResolvedRole(
  role: Skill,
  techniques: readonly Skill[],
  capabilities: CapabilityCatalog,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const skills: Record<string, Skill> = {
    [role.meta.name]: role,
    ...Object.fromEntries(techniques.map((skill) => [skill.meta.name, skill])),
  };
  const capabilityNames = new Set(Object.keys(capabilities.capabilities));
  const schemaNames = new Set(Object.keys(artifactSchemas));

  if (role.meta.kind !== "role") {
    issues.push({
      code: "WRONG_SKILL_KIND",
      path: `skill ${role.meta.name}`,
      message: `"${role.meta.name}" is not a role skill`,
    });
  }
  for (const expected of role.meta.techniques) {
    const found = skills[expected];
    if (!found) {
      issues.push({
        code: "MISSING_TECHNIQUE",
        path: `skill ${role.meta.name}`,
        message: `technique "${expected}" does not exist`,
      });
    } else if (found.meta.kind !== "technique") {
      issues.push({
        code: "WRONG_SKILL_KIND",
        path: `skill ${role.meta.name}`,
        message: `"${expected}" is not a technique skill`,
      });
    } else {
      for (const variable of found.meta.vars) {
        if (!role.meta.vars.includes(variable) || role.meta.payload.includes(variable)) {
          issues.push({
            code: "TECHNIQUE_VAR_UNCOVERED",
            path: `skill ${role.meta.name}`,
            message: `technique "${expected}" uses {{${variable}}}, which the including role must declare as a non-payload var`,
          });
        }
      }
    }
  }
  for (const skill of Object.values(skills)) {
    const at = `skill ${skill.meta.name}`;
    for (const capability of skill.meta.capabilities) {
      if (!capabilityNames.has(capability)) {
        issues.push({
          code: "MISSING_CAPABILITY",
          path: at,
          message: `capability "${capability}" is not in the capability catalog`,
        });
      }
    }
    if (skill.meta.output !== undefined && !schemaNames.has(skill.meta.output)) {
      issues.push({
        code: "MISSING_SCHEMA",
        path: at,
        message: `output schema "${skill.meta.output}" is not known`,
      });
    }
    checkSkillVars(skill, at, issues);
    for (const { name, pattern } of FORBIDDEN_PROMPT_PATTERNS) {
      for (const [where, text] of [
        ["body", skill.body],
        ["description", skill.meta.description],
      ] as const) {
        if (pattern.test(text)) {
          issues.push({
            code: "FORBIDDEN_PROMPT_CONTENT",
            path: `${at} > ${where}`,
            message: `matches forbidden pattern "${name}" (${pattern})`,
          });
        }
      }
    }
  }
  return issues;
}

function validateWorkflow(
  workflow: WorkflowDefinition,
  bundle: ContentBundle,
  known: {
    schemaNames: Set<string>;
    routeNames: Set<string>;
    catalogNames: Set<string>;
    availableRoleNames?: ReadonlySet<string>;
  },
  issues: ValidationIssue[],
): void {
  const wfPath = `workflow ${workflow.name}`;
  const paramNames = new Set(Object.keys(workflow.params));
  const producedSchemas = new Map<string, Set<string>>();
  walkNodes(workflow.root, (node) => {
    if (node.kind !== "agent" && node.kind !== "activity") return;
    const root = refRoot(node.output.key);
    const schemas = producedSchemas.get(root) ?? new Set<string>();
    schemas.add(node.output.schema);
    producedSchemas.set(root, schemas);
  });

  // Node-local checks: ids, terminals, loops, skill/route/schema wiring.
  const seenIds = new Set<string>();
  let terminals = 0;
  walkNodes(workflow.root, (node) => {
    const at = `${wfPath} > node ${node.id}`;

    if (seenIds.has(node.id)) {
      issues.push({ code: "DUPLICATE_NODE_ID", path: at, message: `node id "${node.id}" is used more than once` });
    }
    seenIds.add(node.id);

    if (node.kind === "terminal") terminals += 1;

    if (node.kind === "repeatUntil") {
      const max = (node as { maxIterations?: unknown }).maxIterations;
      if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
        issues.push({
          code: "UNBOUNDED_LOOP",
          path: at,
          message: "repeatUntil must declare a positive integer maxIterations — unbounded loops are rejected",
        });
      } else if (max > MAX_REPEAT_BOUND) {
        issues.push({
          code: "LOOP_BOUND_TOO_HIGH",
          path: at,
          message: `maxIterations ${max} exceeds the ceiling of ${MAX_REPEAT_BOUND} and is treated as effectively unbounded`,
        });
      }
    }

    if (node.kind === "agent") {
      const skill = bundle.skills[node.skill];
      if (!skill) {
        if (!known.availableRoleNames?.has(node.skill)) {
          issues.push({ code: "MISSING_SKILL", path: at, message: `skill "${node.skill}" does not exist` });
        }
      } else {
        if (skill.meta.kind !== "role") {
          issues.push({
            code: "WRONG_SKILL_KIND",
            path: at,
            message: `skill "${node.skill}" is a ${skill.meta.kind} skill; agent nodes must use role skills`,
          });
        }
        if (skill.meta.output !== undefined && skill.meta.output !== node.output.schema) {
          issues.push({
            code: "SKILL_OUTPUT_MISMATCH",
            path: at,
            message: `node expects schema "${node.output.schema}" but skill "${node.skill}" declares output "${skill.meta.output}"`,
          });
        }
        // Bindings must cover the skill's declared vars exactly.
        const bound = new Set(Object.keys(node.bind ?? {}));
        for (const v of skill.meta.vars) {
          if (!bound.has(v)) {
            issues.push({ code: "UNBOUND_VAR", path: at, message: `skill var "${v}" is not bound by this node` });
          }
        }
        for (const b of bound) {
          if (!skill.meta.vars.includes(b)) {
            issues.push({
              code: "UNKNOWN_BINDING",
              path: at,
              message: `bind key "${b}" is not a declared var of skill "${node.skill}"`,
            });
          }
        }
      }

      if (!known.routeNames.has(node.route)) {
        issues.push({ code: "MISSING_ROUTE", path: at, message: `route "${node.route}" is not defined in model routes` });
      }
      if (!known.schemaNames.has(node.output.schema)) {
        issues.push({
          code: "MISSING_SCHEMA",
          path: at,
          message: `output schema "${node.output.schema}" is not a known artifact schema`,
        });
      }
    }

    if (node.kind === "activity") {
      const handler = bundle.activities.handlers[node.handler];
      if (!handler) {
        issues.push({
          code: "MISSING_ACTIVITY_HANDLER",
          path: at,
          message: `activity handler "${node.handler}" is not registered`,
        });
      } else {
        const expectedInputs = new Set(Object.keys(handler.inputs));
        const boundInputs = new Set(Object.keys(node.bind));
        const missing = [...expectedInputs].filter((name) => !boundInputs.has(name));
        const extra = [...boundInputs].filter((name) => !expectedInputs.has(name));
        if (missing.length > 0 || extra.length > 0) {
          issues.push({
            code: "ACTIVITY_INPUT_MISMATCH",
            path: at,
            message: [
              missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
              extra.length > 0 ? `unexpected: ${extra.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; "),
          });
        }
        for (const [name, input] of Object.entries(handler.inputs)) {
          const binding = node.bind[name];
          if (binding === undefined) continue;
          if (input.kind === "artifact") {
            const sourceRoot = typeof binding === "string" ? refRoot(binding) : refRoot(binding.ref);
            if (!producedSchemas.get(sourceRoot)?.has(input.schema)) {
              issues.push({
                code: "ACTIVITY_INPUT_TYPE_MISMATCH",
                path: at,
                message: `input "${name}" requires artifact schema "${input.schema}", but "${sourceRoot}" does not produce it`,
              });
            }
          } else {
            const match = typeof binding === "string" ? /^params\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(binding) : null;
            const param = match ? workflow.params[match[1]!] : undefined;
            if (
              !param ||
              typeof param.default !== "number" ||
              !Number.isInteger(param.default) ||
              param.default < 1 ||
              typeof param.min !== "number" ||
              !Number.isInteger(param.min) ||
              param.min < 1 ||
              typeof param.max !== "number" ||
              !Number.isInteger(param.max) ||
              param.max < param.min ||
              param.default < param.min ||
              param.default > param.max
            ) {
              issues.push({
                code:
                  name === handler.bounds?.maxItemsFromInput
                    ? "UNBOUNDED_ACTIVITY"
                    : "ACTIVITY_INPUT_TYPE_MISMATCH",
                path: at,
                message:
                  name === handler.bounds?.maxItemsFromInput
                    ? `output bound input "${name}" must bind directly to a positive-integer workflow param with finite min/default/max`
                    : `input "${name}" must bind directly to a positive-integer workflow param with finite min/default/max`,
              });
            }
          }
        }
        if (node.output.schema !== handler.outputSchema) {
          issues.push({
            code: "ACTIVITY_OUTPUT_MISMATCH",
            path: at,
            message: `node expects schema "${node.output.schema}" but handler "${node.handler}" returns "${handler.outputSchema}"`,
          });
        }
      }
      if (!known.schemaNames.has(node.output.schema)) {
        issues.push({
          code: "MISSING_SCHEMA",
          path: at,
          message: `output schema "${node.output.schema}" is not a known artifact schema`,
        });
      }
    }
  });

  if (terminals === 0) {
    issues.push({ code: "NO_TERMINAL", path: wfPath, message: "workflow has no terminal node" });
  }

  // Scope-aware reference checking.
  const ctx: RefContext = { paramNames, catalogNames: known.catalogNames, issues, wfPath };
  checkNodeRefs(workflow.root, new Set(), false, ctx);
}

interface RefContext {
  paramNames: Set<string>;
  catalogNames: Set<string>;
  issues: ValidationIssue[];
  wfPath: string;
}

function checkRef(ref: string, scope: Set<string>, inRepeatUntil: boolean, ctx: RefContext, at: string): void {
  for (const inner of innerRefs(ref)) {
    checkRef(inner, scope, inRepeatUntil, ctx, at);
  }
  const segments = ref.replace(/\[[^\]]*\]/g, "").split(".");
  const root = segments[0]!;

  if (root === SESSION_ROOT) return;
  if (root === "params") {
    if (segments.length < 2 || !ctx.paramNames.has(segments[1]!)) {
      ctx.issues.push({
        code: "UNKNOWN_PARAM",
        path: at,
        message: `"${ref}" references a param that is not declared by the workflow`,
      });
    }
    return;
  }
  if (root === "catalog") {
    if (segments.length < 2 || !ctx.catalogNames.has(segments[1]!)) {
      ctx.issues.push({
        code: "UNKNOWN_CATALOG",
        path: at,
        message: `"${ref}" references a catalog that is not part of the bundle`,
      });
    }
    return;
  }
  if (root === "review") {
    if (!inRepeatUntil) {
      ctx.issues.push({
        code: "REVIEW_REF_OUTSIDE_LOOP",
        path: at,
        message: `"${ref}" uses the review builtin outside a repeatUntil loop`,
      });
    } else if (segments.length < 2 || !REVIEW_FIELDS.has(segments[1]!)) {
      ctx.issues.push({ code: "UNKNOWN_REF", path: at, message: `"${ref}" is not a known review builtin` });
    }
    return;
  }
  if (!scope.has(root)) {
    ctx.issues.push({
      code: "UNKNOWN_REF",
      path: at,
      message: `"${ref}" has root "${root}" which is not defined at this point of the workflow`,
    });
  }
}

function checkBind(value: BindValue, scope: Set<string>, inRepeatUntil: boolean, ctx: RefContext, at: string): void {
  if (typeof value === "string") {
    checkRef(value, scope, inRepeatUntil, ctx, at);
    return;
  }
  checkRef(value.ref, scope, inRepeatUntil, ctx, at);
  if (value.through !== undefined) checkRef(value.through, scope, inRepeatUntil, ctx, at);
}

function checkCondition(expr: ConditionExpr, scope: Set<string>, inRepeatUntil: boolean, ctx: RefContext, at: string): void {
  if ("all" in expr) {
    expr.all.forEach((e) => checkCondition(e, scope, inRepeatUntil, ctx, at));
  } else if ("any" in expr) {
    expr.any.forEach((e) => checkCondition(e, scope, inRepeatUntil, ctx, at));
  } else if ("not" in expr) {
    checkCondition(expr.not, scope, inRepeatUntil, ctx, at);
  } else {
    checkRef(expr.ref, scope, inRepeatUntil, ctx, at);
  }
}

function checkNodeRefs(node: WorkflowNode, scope: Set<string>, inRepeatUntil: boolean, ctx: RefContext): void {
  const at = `${ctx.wfPath} > node ${node.id}`;

  switch (node.kind) {
    case "sequence": {
      const local = new Set(scope);
      for (const step of node.steps) {
        checkNodeRefs(step, local, inRepeatUntil, ctx);
        for (const root of definedRoots(step)) local.add(root);
      }
      break;
    }
    case "agent": {
      for (const value of Object.values(node.bind ?? {})) {
        checkBind(value, scope, inRepeatUntil, ctx, at);
      }
      // The output key's root is being defined here; only its indexers must resolve.
      for (const inner of innerRefs(node.output.key)) {
        checkRef(inner, scope, inRepeatUntil, ctx, at);
      }
      break;
    }
    case "activity": {
      for (const value of Object.values(node.bind)) {
        checkBind(value, scope, inRepeatUntil, ctx, at);
      }
      // The output key's root is being defined here; only its indexers must resolve.
      for (const inner of innerRefs(node.output.key)) {
        checkRef(inner, scope, inRepeatUntil, ctx, at);
      }
      break;
    }
    case "forEach": {
      checkRef(node.items, scope, inRepeatUntil, ctx, at);
      if (node.exclude !== undefined) checkRef(node.exclude, scope, inRepeatUntil, ctx, at);
      const bodyScope = new Set(scope);
      bodyScope.add(node.itemVar);
      if (node.indexVar !== undefined) bodyScope.add(node.indexVar);
      checkNodeRefs(node.body, bodyScope, inRepeatUntil, ctx);
      break;
    }
    case "repeatUntil": {
      checkNodeRefs(node.body, scope, true, ctx);
      const untilScope = new Set(scope);
      for (const root of definedRoots(node.body)) untilScope.add(root);
      checkCondition(node.until, untilScope, true, ctx, at);
      break;
    }
    case "condition": {
      checkCondition(node.if, scope, inRepeatUntil, ctx, at);
      checkNodeRefs(node.then, scope, inRepeatUntil, ctx);
      if (node.else) checkNodeRefs(node.else, scope, inRepeatUntil, ctx);
      break;
    }
    case "humanGate": {
      if (node.gate.show !== undefined) checkRef(node.gate.show, scope, inRepeatUntil, ctx, at);
      for (const action of node.gate.actions) {
        if (action.edits !== undefined) checkRef(action.edits, scope, inRepeatUntil, ctx, at);
      }
      break;
    }
    case "terminal": {
      if (node.result !== undefined) checkRef(node.result, scope, inRepeatUntil, ctx, at);
      break;
    }
  }
}
