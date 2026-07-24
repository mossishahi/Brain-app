import { z } from "zod";

/**
 * Schema for the declarative workflow definition, the logical model routes,
 * the executable-capability catalog, and skill front matter. Everything here
 * is provider-neutral: workflows reference skills, routes, capabilities, and
 * artifact schemas by logical name only.
 */

// ---------------------------------------------------------------------------
// small building blocks
// ---------------------------------------------------------------------------

const identifier = z.string().regex(/^[a-z][A-Za-z0-9_-]*$/, {
  message: "identifiers must be lowerCamel / kebab (start lowercase; letters, digits, _ or -)",
});

/** Namespaced logical key resolved by runtime registration, never executable code. */
const activityHandlerKey = z.string().regex(/^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)+$/, {
  message: "activity handler keys must be namespaced logical names such as panel.select",
});

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, { message: "must be a semantic version like 0.1.0" });

/**
 * A data reference: dot-separated path segments, each optionally followed by
 * bracket indexers, e.g. `input.cotSteps`, `ideas[member.id].cot`,
 * `round.comments`. References are resolved by the runtime against session
 * state, loop scopes, `params.*`, `catalog.*`, and runtime builtins
 * (`session.*`, `loop.*`, `review.*`).
 */
export function isValidDataRef(ref: string): boolean {
  if (ref.length === 0) return false;
  const plainSegment = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const plainPath = (s: string) => s.split(".").every((part) => plainSegment.test(part));
  // Bracket indexers may contain dotted refs (e.g. ideas[member.id].cot), so
  // validate and strip them before checking the dotted remainder.
  const bracket = /\[([^\[\]]*)\]/g;
  for (const match of ref.matchAll(bracket)) {
    const inner = match[1]!;
    if (!(inner === "*" || /^\d+$/.test(inner) || plainPath(inner))) return false;
  }
  const rest = ref.replace(bracket, "");
  if (rest.includes("[") || rest.includes("]")) return false;
  return plainPath(rest);
}

export const dataRefSchema = z
  .string()
  .refine(isValidDataRef, { message: "not a valid data reference" });

/**
 * A value bound into a skill variable: either a plain data reference, or a
 * reference with a declarative projection —
 * - `pick`: keep only the listed keys of the referenced object (applied to
 *   each element when the reference resolves to a collection); used to
 *   withhold fields an agent must never see (e.g. the chair never sees `cot`).
 * - `omit`: drop the listed keys of the referenced object (applied to each
 *   element when the reference resolves to a collection); used to withhold a
 *   single field while passing everything else (e.g. `input` without the raw
 *   file map).
 * - `through`: slice the referenced array to elements 1..resolve(through)
 *   (1-based, inclusive); used to show commentors only chain steps 1..i.
 */
export const bindValueSchema = z.union([
  dataRefSchema,
  z
    .object({
      ref: dataRefSchema,
      pick: z.array(z.string().min(1)).min(1).optional(),
      omit: z.array(z.string().min(1)).min(1).optional(),
      through: dataRefSchema.optional(),
    })
    .strict()
    .refine(
      (v) =>
        v.pick !== undefined || v.omit !== undefined || v.through !== undefined,
      {
        message: "a structured bind must use at least one of pick / omit / through",
      },
    )
    .refine((v) => v.pick === undefined || v.omit === undefined, {
      message: "pick and omit are mutually exclusive on one bind",
    }),
]);

export type BindValue = z.infer<typeof bindValueSchema>;

// ---------------------------------------------------------------------------
// condition expressions
// ---------------------------------------------------------------------------

const primitive = z.union([z.string(), z.number(), z.boolean()]);

export type ConditionExpr =
  | { ref: string; equals: string | number | boolean }
  | { ref: string; notEquals: string | number | boolean }
  | { all: ConditionExpr[] }
  | { any: ConditionExpr[] }
  | { not: ConditionExpr };

export const conditionExprSchema: z.ZodType<ConditionExpr> = z.lazy(() =>
  z.union([
    z.object({ ref: dataRefSchema, equals: primitive }).strict(),
    z.object({ ref: dataRefSchema, notEquals: primitive }).strict(),
    z.object({ all: z.array(conditionExprSchema).min(1) }).strict(),
    z.object({ any: z.array(conditionExprSchema).min(1) }).strict(),
    z.object({ not: conditionExprSchema }).strict(),
  ]),
);

// ---------------------------------------------------------------------------
// workflow nodes
// ---------------------------------------------------------------------------

const nodeBase = {
  id: identifier,
  /** Free-text documentation for humans and runtime implementers. */
  notes: z.string().optional(),
};

export type WorkflowNode =
  | SequenceNode
  | AgentNode
  | ActivityNode
  | ForEachNode
  | RepeatUntilNode
  | ConditionNode
  | HumanGateNode
  | TerminalNode;

export interface SequenceNode {
  kind: "sequence";
  id: string;
  notes?: string;
  steps: WorkflowNode[];
}

export interface AgentNode {
  kind: "agent";
  id: string;
  notes?: string;
  /** Name of a role skill in the skill set. */
  skill: string;
  /** Logical model route name (resolved by a provider adapter, never a model id). */
  route: string;
  /** Skill variable name -> data reference (with optional pick/through projection). */
  bind?: Record<string, BindValue>;
  /** Where the agent's validated structured output lands, and the schema it must satisfy. */
  output: { key: string; schema: string };
}

/**
 * A deterministic host-runtime transform selected by a registered logical
 * handler key. Workflow JSON contains only data bindings — never code or an
 * expression language.
 */
export interface ActivityNode {
  kind: "activity";
  id: string;
  notes?: string;
  handler: string;
  bind: Record<string, BindValue>;
  output: { key: string; schema: string };
}

export interface ForEachNode {
  kind: "forEach";
  id: string;
  notes?: string;
  /** Reference to the collection to iterate. */
  items: string;
  /** Scope variable holding the current item. */
  itemVar: string;
  /** Optional scope variable holding the 1-based position. */
  indexVar?: string;
  /** Optional reference to an item to skip (e.g. the member under review). */
  exclude?: string;
  mode: "parallel" | "sequential";
  /** Optional cap on simultaneous branches in parallel mode. */
  maxConcurrency?: number;
  body: WorkflowNode;
}

export interface RepeatUntilNode {
  kind: "repeatUntil";
  id: string;
  notes?: string;
  body: WorkflowNode;
  /** Evaluated after each iteration; the loop exits as soon as it holds. */
  until: ConditionExpr;
  /** Hard bound on iterations — required; there are no unbounded loops. */
  maxIterations: number;
  /** What happens when the bound is hit before `until` holds. */
  onExhausted: "proceed" | "fail";
}

export interface ConditionNode {
  kind: "condition";
  id: string;
  notes?: string;
  if: ConditionExpr;
  then: WorkflowNode;
  else?: WorkflowNode;
}

export interface HumanGateNode {
  kind: "humanGate";
  id: string;
  notes?: string;
  gate: {
    title: string;
    prompt: string;
    /** Data reference rendered to the human alongside the prompt. */
    show?: string;
    actions: Array<{
      id: string;
      description: string;
      /** Data reference the action may edit. */
      edits?: string;
      /** The only supported edit rule: items may be removed, never added. */
      editRule?: "removeOnly";
    }>;
  };
  /** When true, an unattended runtime may auto-approve and continue. */
  skippable: boolean;
}

export interface TerminalNode {
  kind: "terminal";
  id: string;
  notes?: string;
  /** Data reference naming the workflow's result artifact. */
  result?: string;
}

export const workflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        ...nodeBase,
        kind: z.literal("sequence"),
        steps: z.array(workflowNodeSchema).min(1),
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("agent"),
        skill: identifier,
        route: identifier,
        bind: z.record(z.string().min(1), bindValueSchema).optional(),
        output: z.object({ key: dataRefSchema, schema: z.string().min(1) }).strict(),
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("activity"),
        handler: activityHandlerKey,
        bind: z.record(z.string().min(1), bindValueSchema),
        output: z.object({ key: dataRefSchema, schema: z.string().min(1) }).strict(),
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("forEach"),
        items: dataRefSchema,
        itemVar: identifier,
        indexVar: identifier.optional(),
        exclude: dataRefSchema.optional(),
        mode: z.enum(["parallel", "sequential"]),
        maxConcurrency: z.number().int().min(1).optional(),
        body: workflowNodeSchema,
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("repeatUntil"),
        body: workflowNodeSchema,
        until: conditionExprSchema,
        maxIterations: z.number().int().min(1),
        onExhausted: z.enum(["proceed", "fail"]),
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("condition"),
        if: conditionExprSchema,
        then: workflowNodeSchema,
        else: workflowNodeSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("humanGate"),
        gate: z
          .object({
            title: z.string().min(1),
            prompt: z.string().min(1),
            show: dataRefSchema.optional(),
            actions: z
              .array(
                z
                  .object({
                    id: identifier,
                    description: z.string().min(1),
                    edits: dataRefSchema.optional(),
                    editRule: z.literal("removeOnly").optional(),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
        skippable: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...nodeBase,
        kind: z.literal("terminal"),
        result: dataRefSchema.optional(),
      })
      .strict(),
  ]),
) as z.ZodType<WorkflowNode>;

// ---------------------------------------------------------------------------
// workflow document
// ---------------------------------------------------------------------------

export const workflowSchema = z
  .object({
    apiVersion: z.literal("brainstorm.workflow/v1"),
    name: identifier,
    version: semver,
    description: z.string().min(1),
    /** Tunable knobs referenced from binds as `params.<name>`. */
    params: z
      .record(
        z.string().min(1),
        z
          .object({
            description: z.string().min(1),
            default: primitive,
            min: z.number().optional(),
            max: z.number().optional(),
          })
          .strict(),
      )
      .default({}),
    root: workflowNodeSchema,
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof workflowSchema>;

// ---------------------------------------------------------------------------
// model routes (logical names only — provider adapters map them to models)
// ---------------------------------------------------------------------------

export const routesSchema = z
  .object({
    version: semver,
    /** Route consulted when a node names no known route — must exist in `routes`. */
    defaultRoute: identifier,
    routes: z.record(
      identifier,
      z
        .object({
          description: z.string().min(1),
          /** Neutral capability traits a provider adapter matches against, e.g. "extended-reasoning". */
          traits: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();

export type ModelRoutes = z.infer<typeof routesSchema>;

// ---------------------------------------------------------------------------
// deterministic runtime activities (logical handlers — no embedded code)
// ---------------------------------------------------------------------------

const activityHandlerSchema = z
  .object({
    description: z.string().min(1),
    /** Only deterministic handlers are valid workflow activities. */
    deterministic: z.literal(true),
    /** Exact typed input bindings the activity node must provide. */
    inputs: z.record(
      identifier,
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("artifact"), schema: z.string().min(1) }).strict(),
        z.object({ kind: z.literal("positiveInteger") }).strict(),
      ]),
    ),
    /** Artifact schema the registered handler returns. */
    outputSchema: z.string().min(1),
    /**
     * Typed finite-output contract. The named output collection may contain
     * at most the positive integer supplied through the named activity input.
     */
    bounds: z
      .object({
        outputField: identifier,
        maxItemsFromInput: identifier,
      })
      .strict(),
  })
  .strict()
  .superRefine((handler, ctx) => {
    if (Object.keys(handler.inputs).length === 0) {
      ctx.addIssue({ code: "custom", path: ["inputs"], message: "an activity must declare at least one input" });
    }
    const boundInput = handler.inputs[handler.bounds.maxItemsFromInput];
    if (!boundInput) {
      ctx.addIssue({
        code: "custom",
        path: ["bounds", "maxItemsFromInput"],
        message: "the bound source must name one of the handler inputs",
      });
    } else if (boundInput.kind !== "positiveInteger") {
      ctx.addIssue({
        code: "custom",
        path: ["bounds", "maxItemsFromInput"],
        message: "the bound source must be a positiveInteger input",
      });
    }
  });

export const activitiesSchema = z
  .object({
    version: semver,
    handlers: z.record(activityHandlerKey, activityHandlerSchema),
  })
  .strict();

export type ActivityRegistry = z.infer<typeof activitiesSchema>;

// ---------------------------------------------------------------------------
// executable capabilities (host-provided tools — NOT prompts)
// ---------------------------------------------------------------------------

/**
 * Dot-separated normalized operation identifier, e.g. "web.search",
 * "attachment.read", "code.execute".
 */
const operationId = z.string().regex(
  /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/,
  "operation id must be dot-separated lowercase segments (e.g. web.search)",
);

export const capabilitiesSchema = z
  .object({
    version: semver,
    capabilities: z.record(
      identifier,
      z
        .object({
          description: z.string().min(1),
          /** What the runtime must provide for an agent that declares this capability. */
          contract: z.string().min(1),
          /** Normalized operations this capability decomposes into. */
          operations: z.array(operationId).min(1),
          /** Authoritative instruction appended to the system prompt when none of the operations are available. */
          whenUnavailable: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type CapabilityCatalog = z.infer<typeof capabilitiesSchema>;

// ---------------------------------------------------------------------------
// skill front matter
// ---------------------------------------------------------------------------

/**
 * A skill is pure prompt content.
 * - `role` skills are the main instruction of one agent node; they declare the
 *   artifact schema their structured output must satisfy.
 * - `technique` skills are reusable instruction fragments a role pulls in;
 *   they produce no artifact of their own.
 * Executable needs are never expressed as prompt text — they are declared as
 * `capabilities` and resolved by the runtime.
 */
export const skillMetaSchema = z
  .object({
    name: identifier,
    kind: z.enum(["role", "technique"]),
    description: z.string().min(1),
    /** Template variables the body may use as {{var}}; bound by the workflow node. */
    vars: z.array(identifier).default([]),
    /** Technique skills folded into this role's instructions (roles only). */
    techniques: z.array(identifier).default([]),
    /** Executable capabilities the host must provide (from the capability catalog). */
    capabilities: z.array(identifier).default([]),
    /** Artifact schema the structured output must satisfy (roles only). */
    output: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    if (meta.kind === "role" && meta.output === undefined) {
      ctx.addIssue({ code: "custom", path: ["output"], message: "role skills must declare an output schema" });
    }
    if (meta.kind === "technique" && meta.output !== undefined) {
      ctx.addIssue({ code: "custom", path: ["output"], message: "technique skills must not declare an output schema" });
    }
    if (meta.kind === "technique" && meta.techniques.length > 0) {
      ctx.addIssue({ code: "custom", path: ["techniques"], message: "technique skills cannot include other techniques" });
    }
  });

export type SkillMeta = z.infer<typeof skillMetaSchema>;

export interface Skill {
  meta: SkillMeta;
  /** The prompt body (markdown, after the front matter). */
  body: string;
  /** Path the skill was loaded from, for error reporting. */
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// catalogs
// ---------------------------------------------------------------------------

export const inputTypesCatalogSchema = z
  .object({
    version: semver,
    /** Classification key -> "choose when" guidance shown to the processor. */
    types: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

export type InputTypesCatalog = z.infer<typeof inputTypesCatalogSchema>;

export const verdictsCatalogSchema = z
  .object({
    version: semver,
    verdicts: z.record(
      z.string().min(1),
      z
        .object({
          description: z.string().min(1),
          /** Keys the structured verdict must carry (mirrors the comment schema). */
          requires: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    /** Declarative sequencing rules the runtime enforces between review rounds. */
    sequencing: z
      .object({
        /** A verdict in this list may not be issued twice in a row on the same step. */
        noImmediateRepeat: z.array(z.string().min(1)),
        /** The verdict that lets the chain advance to the next step. */
        advanceOn: z.string().min(1),
        /** Verdicts that trigger a redevelopment of the current step. */
        redevelopOn: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

export type VerdictsCatalog = z.infer<typeof verdictsCatalogSchema>;

export const departmentsCatalogSchema = z
  .object({
    version: semver,
    /** Group key -> departments; the decomposer picks departments only from here. */
    groups: z.record(
      z.string().min(1),
      z
        .array(
          z
            .object({
              name: z.string().min(1),
              /** Overlaps several concrete disciplines — never co-selected with one it subsumes. */
              crossCutting: z.boolean().optional(),
              subfields: z.array(z.string().min(1)).optional(),
            })
            .strict(),
        )
        .min(1),
    ),
  })
  .strict();

export type DepartmentsCatalog = z.infer<typeof departmentsCatalogSchema>;
