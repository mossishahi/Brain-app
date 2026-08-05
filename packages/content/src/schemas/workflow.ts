import { z } from "zod";

import { OUTPUT_SHAPES, type OutputShape } from "./artifacts.js";

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

/**
 * What a review seat is doing at its current walk position. Declared in content
 * so the pipeline can say which stage of a round a node represents, and the
 * runtime — never the model — stamps it on the seat.
 */
export const REVIEW_PHASES = ["commenting", "judging", "redeveloping"] as const;
export type ReviewPhaseName = (typeof REVIEW_PHASES)[number];
const reviewPhaseSchema = z.enum(REVIEW_PHASES);

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
  /**
   * Inside a review loop, what the seat is doing while this node runs. The
   * runtime stamps it on the seat before the node executes, so the dashboard
   * can show a live per-seat phase (the model never reports it).
   */
  reviewPhase?: ReviewPhaseName;
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
  /**
   * Cap on simultaneous branches. REQUIRED in parallel mode: unbounded fan-out
   * would let one run open as many provider sessions as the collection is long.
   */
  maxConcurrency?: number;
  /** Inside a review loop, the phase to stamp on the seat while this node runs. */
  reviewPhase?: ReviewPhaseName;
  body: WorkflowNode;
}

export interface RepeatUntilNode {
  kind: "repeatUntil";
  id: string;
  notes?: string;
  body: WorkflowNode;
  /** Evaluated after each iteration; the loop exits as soon as it holds. */
  until: ConditionExpr;
  /**
   * Hard bound on iterations — required; there are no unbounded loops. Either a
   * literal integer, or `params.<name>` naming a positive-integer workflow param
   * with a finite declared `max`. In the param form the loop compiles to that
   * declared `max`, so the static bound stays finite while the per-run budget is
   * enforced by `until` — which keeps the budget in exactly one place.
   */
  maxIterations: number | string;
  /** What happens when the bound is hit before `until` holds. */
  onExhausted: "proceed" | "fail";
  /**
   * The review seat this loop owns: a data reference resolving to a member id.
   * Declaring it is what makes `reviews[<seat>].*` addressable in the body, and
   * it is what keeps two seats reviewed in parallel from colliding — every write
   * the body makes is qualified by this seat.
   */
  seat?: string;
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
      /**
       * The edit contract of the action:
       * - "removeOnly": items of the edited collection may be removed, never
       *   added (the panel gate; the host may additionally layer explicit
       *   custom-seat additions on top).
       * - "classification": the decision may override the edited input's
       *   `type` (any type of the loaded catalog) and replace its
       *   `requestedOutputs` (the classification gate).
       */
      editRule?: "removeOnly" | "classification";
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
        reviewPhase: reviewPhaseSchema.optional(),
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
        reviewPhase: reviewPhaseSchema.optional(),
        body: workflowNodeSchema,
      })
      .strict()
      .superRefine((node, ctx) => {
        if (node.mode === "parallel" && node.maxConcurrency === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["maxConcurrency"],
            message: "a parallel forEach must declare maxConcurrency — unbounded fan-out is rejected",
          });
        }
      }),
    z
      .object({
        ...nodeBase,
        kind: z.literal("repeatUntil"),
        body: workflowNodeSchema,
        until: conditionExprSchema,
        maxIterations: z.union([z.number().int().min(1), dataRefSchema]),
        onExhausted: z.enum(["proceed", "fail"]),
        seat: dataRefSchema.optional(),
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
                    editRule: z.enum(["removeOnly", "classification"]).optional(),
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
    /**
     * Vars delivered to the model as task data instead of being rendered into
     * the instruction body (roles only; a subset of `vars`). Declaring any
     * payload var asserts that every remaining var is per-call-stable framing,
     * which is what lets the runtime mark the rendered instructions as a
     * cacheable system-prompt prefix. Payload vars must not appear as {{var}}.
     */
    payload: z.array(identifier).default([]),
    /** Technique skills folded into this role's instructions (roles only). */
    techniques: z.array(identifier).default([]),
    /** Executable capabilities the host must provide (from the capability catalog). */
    capabilities: z.array(identifier).default([]),
    /**
     * The subset of `capabilities` that is LOAD-BEARING for this role: the
     * task must fail loudly (before the model is called) when one of these
     * resolves unavailable on the deployment, instead of degrading with the
     * catalog's whenUnavailable prose. Mark a capability required exactly
     * when the role's job is impossible without it (the placer without
     * taxonomy reads); leave enrichment capabilities (a member's web
     * search) degradable.
     */
    requiredCapabilities: z.array(identifier).default([]),
    /** Artifact schema the structured output must satisfy (roles only). */
    output: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    for (const name of meta.requiredCapabilities) {
      if (!meta.capabilities.includes(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["requiredCapabilities"],
          message: `required capability "${name}" is not among the skill's declared capabilities`,
        });
      }
    }
    if (meta.kind === "role" && meta.output === undefined) {
      ctx.addIssue({ code: "custom", path: ["output"], message: "role skills must declare an output schema" });
    }
    if (meta.kind === "technique" && meta.output !== undefined) {
      ctx.addIssue({ code: "custom", path: ["output"], message: "technique skills must not declare an output schema" });
    }
    if (meta.kind === "technique" && meta.techniques.length > 0) {
      ctx.addIssue({ code: "custom", path: ["techniques"], message: "technique skills cannot include other techniques" });
    }
    if (meta.kind === "technique" && meta.payload.length > 0) {
      ctx.addIssue({ code: "custom", path: ["payload"], message: "technique skills cannot declare payload vars" });
    }
    for (const name of meta.payload) {
      if (!meta.vars.includes(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["payload"],
          message: `payload var "${name}" is not declared in vars`,
        });
      }
    }
    if (new Set(meta.payload).size !== meta.payload.length) {
      ctx.addIssue({ code: "custom", path: ["payload"], message: "payload vars must be unique" });
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

/**
 * One submission type, fully described in data. This is the single reference
 * the pipeline obeys: the record key is the type's name (rendered verbatim
 * into prompts as `{{type}}`), `description` is the "what it is / choose when"
 * text the processor classifies against, `shape` names which code-owned output
 * structure members produce for it, `guidance` is the reviewing rubric for the
 * commentor/judge, and `outline` maps each output section (a literal field of
 * the shape's schema) to what it must contain.
 */
export const inputTypeDefinitionSchema = z
  .object({
    description: z.string().min(1),
    shape: z.enum(OUTPUT_SHAPES),
    guidance: z.string().min(1),
    outline: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

export type InputTypeDefinition = z.infer<typeof inputTypeDefinitionSchema>;

/**
 * catalog/input-types.json. Since bundle 0.2.0 each entry is a full
 * `InputTypeDefinition`; entries may also be plain "choose when" strings,
 * which is how pre-0.2.0 immutable bundles remain loadable. Entry order is
 * meaningful: it is the processor's disambiguation order, and the LAST entry
 * is the residual default.
 *
 * `shapeRules` (optional) maps a shape id to the mechanical-rules block the
 * developing skills receive as `{{shapeGuide}}`: exact paragraph counts,
 * permitted enum values, and what a chain step is for that shape. The rules
 * are prose mirrors of the code-owned artifact schemas — the runtime enforces
 * the structure regardless — and must contain no template syntax, because
 * they are injected into already-rendered instructions.
 */
export const inputTypesCatalogSchema = z
  .object({
    version: semver,
    types: z.record(
      z.string().min(1),
      z.union([z.string().min(1), inputTypeDefinitionSchema]),
    ),
    shapeRules: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();

export type InputTypesCatalog = z.infer<typeof inputTypesCatalogSchema>;

/**
 * The in-memory view of catalog/input-types.json the loader builds and the
 * runtime serializes into state: flat projections so workflow binds stay
 * simple bracket lookups (`catalog.inputTypes.outlines[input.type]`, …).
 * `types` is always the name -> description map (whatever the on-disk format),
 * so the processor's `typeOptions` bind is identical across bundle versions;
 * the other projections are empty for pre-0.2.0 description-only bundles.
 */
export interface LoadedInputTypes {
  readonly version: string;
  /** Type name -> description; the processor's option set, in priority order. */
  readonly types: Record<string, string>;
  /** Type name -> output shape (empty for description-only bundles). */
  readonly shapes: Record<string, OutputShape>;
  /** Type name -> reviewing rubric (empty for description-only bundles). */
  readonly guidance: Record<string, string>;
  /** Type name -> output outline (empty for description-only bundles). */
  readonly outlines: Record<string, Record<string, string>>;
  /**
   * Type name -> the mechanical rules of the type's shape (resolved through
   * `shapeRules`; empty for bundles that keep the rules in the skill body).
   */
  readonly shapeGuides: Record<string, string>;
}

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

