import {
  artifactSchemas,
  mergeRedevelopment,
  mergeRedevelopmentParts,
  type CotStepParts,
  type RedevelopmentPatch,
  type RedevelopmentPatchParts,
} from "@brainstorm-agentic/content";
import {
  systemPromptSegments,
  textContent,
  type AgentExecutionContext,
  type AgentTask,
  type JsonObject,
  type JsonValue,
  type ModelRequest,
  type ModelResponse,
  type ProviderOptions,
  type ResponseFormat,
  type SystemPrompt,
  type ToolChoice,
} from "@brainstorm-agentic/core";

import { BrainstormRuntimeError } from "./errors.js";

/**
 * Structural equivalent of the generic agent runtime's ModelRoute. Keeping
 * this adapter dependent only on core avoids a runtime package cycle.
 */
export interface GenericAgentModelRoute {
  readonly modelId: string;
  readonly system?: SystemPrompt;
  readonly toolChoice?: ToolChoice;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  readonly responseFormat?: ResponseFormat;
  readonly metadata?: JsonObject;
  readonly providerOptions?: ProviderOptions;
}

function mergeProviderOptions(
  base: ProviderOptions | undefined,
  override: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!base) return override;
  if (!override) return base;
  const merged: Record<string, JsonObject> = {};
  for (const provider of new Set([...Object.keys(base), ...Object.keys(override)])) {
    merged[provider] = { ...(base[provider] ?? {}), ...(override[provider] ?? {}) };
  }
  return merged;
}

/**
 * Deployment policy precedes the content's instructions. Both are static, so
 * the merged prefix stays cacheable; the result collapses back to a plain
 * string when nothing claims to be cacheable.
 */
function mergeSystem(
  routeSystem: SystemPrompt | undefined,
  descriptionSystem: SystemPrompt | undefined,
): SystemPrompt | undefined {
  const routeSegments = systemPromptSegments(routeSystem).map((segment) => ({
    ...segment,
    cacheable: true,
  }));
  const segments = [...routeSegments, ...systemPromptSegments(descriptionSystem)];
  if (segments.length === 0) return undefined;
  if (segments.every((segment) => segment.cacheable !== true)) {
    return segments.map((segment) => segment.text).join("\n\n");
  }
  return segments;
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value as Record<string, unknown>).every(jsonValue)
  );
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

/**
 * Adapter for ToolLoopAgentExecutor: consumes the pre-rendered request
 * description emitted by compileContentWorkflow while letting the generic
 * runtime's route resolver remain authoritative for concrete model settings.
 */
export class BrainstormAgentTaskAdapter {
  createRequest(
    task: AgentTask,
    _context: AgentExecutionContext,
    route: GenericAgentModelRoute,
  ): ModelRequest {
    const description = task.modelRequest;
    if (!description) {
      throw new BrainstormRuntimeError(
        `agent task "${task.taskId}" has no modelRequest description`,
        "MISSING_MODEL_REQUEST",
      );
    }
    const system = mergeSystem(route.system, description.system);
    const toolChoice = route.toolChoice ?? description.toolChoice;
    const maxOutputTokens = route.maxOutputTokens ?? description.maxOutputTokens;
    const temperature = route.temperature ?? description.temperature;
    const topP = route.topP ?? description.topP;
    const stopSequences = route.stopSequences ?? description.stopSequences;
    const responseFormat = description.responseFormat ?? route.responseFormat;
    const providerOptions = mergeProviderOptions(description.providerOptions, route.providerOptions);
    const metadata =
      route.metadata || description.metadata || task.metadata
        ? { ...(task.metadata ?? {}), ...(description.metadata ?? {}), ...(route.metadata ?? {}) }
        : undefined;
    return {
      modelId: route.modelId,
      ...(system !== undefined ? { system } : {}),
      messages: description.messages,
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { topP } : {}),
      ...(stopSequences !== undefined ? { stopSequences } : {}),
      ...(responseFormat !== undefined ? { responseFormat } : {}),
      ...(metadata ? { metadata } : {}),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      ...(task.capabilityPlan?.providerNativeKeys.length
        ? { nativeOperations: task.capabilityPlan.providerNativeKeys }
        : {}),
    };
  }

  responseToOutput(
    response: ModelResponse,
    task: AgentTask,
    _context: AgentExecutionContext,
    route: GenericAgentModelRoute,
  ): JsonValue {
    const format = task.modelRequest?.responseFormat ?? route.responseFormat;
    const text = textContent(response.content);
    if (!task.outputSchema && (format === undefined || format.type === "text")) return text;
    try {
      const parsed: unknown = JSON.parse(stripFence(text));
      if (!jsonValue(parsed)) throw new Error("parsed value is not JSON-safe");
      return parsed;
    } catch (error) {
      throw new BrainstormRuntimeError(
        `agent task "${task.taskId}" returned invalid JSON`,
        "INVALID_AGENT_JSON",
        { cause: error },
      );
    }
  }
}

export type ContentValidationResult =
  | { readonly success: true; readonly value: JsonValue }
  | { readonly success: false; readonly issues: readonly string[] };

function asRecord(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Checks a candidate artifact against the requested-output pin the task
 * compiler wrote into the delivered JSON schema: when the run recorded asks,
 * `output.requested` must carry exactly the pinned titles in order; when the
 * schema removed the property, the artifact must not carry it. Returns the
 * feedback issue, or undefined when the contract holds (or does not apply).
 */
function requestedSectionIssue(
  value: unknown,
  schemaProperties: JsonObject | undefined,
): string | undefined {
  const envelopeSchema = asRecord(schemaProperties?.output);
  if (!envelopeSchema) return undefined;
  const envelopeProperties = asRecord(envelopeSchema.properties);
  if (!envelopeProperties) return undefined;
  const envelope = asRecord(asRecord(value)?.output);
  const sections = envelope?.requested;

  const requestedSchema = asRecord(envelopeProperties.requested);
  if (!requestedSchema) {
    return sections === undefined
      ? undefined
      : "output.requested: this run recorded no requested outputs; omit the field entirely";
  }
  const required = Array.isArray(envelopeSchema.required) ? envelopeSchema.required : [];
  if (!required.includes("requested")) return undefined;

  const expectedTitles = (() => {
    const items = asRecord(requestedSchema.items);
    const titleSchema = asRecord(asRecord(items?.properties)?.title);
    return Array.isArray(titleSchema?.enum)
      ? titleSchema.enum.filter((entry): entry is string => typeof entry === "string")
      : [];
  })();
  if (expectedTitles.length === 0) return undefined;

  const titles = (Array.isArray(sections) ? sections : []).map(
    (entry) => asRecord(entry)?.title,
  );
  if (
    titles.length !== expectedTitles.length ||
    titles.some((title, index) => title !== expectedTitles[index])
  ) {
    return (
      `output.requested: must carry exactly ${expectedTitles.length} section(s), one per ` +
      `requested output, in order, with these titles copied verbatim: ${expectedTitles.join(" | ")}`
    );
  }
  return undefined;
}

/**
 * OutputValidator compatible with ToolLoopAgentExecutor. It resolves the
 * JSON Schema title back to the authoritative content Zod schema.
 */
/**
 * Signatures of probe/filler text — an agent fighting the output schema
 * sometimes degenerates into submitting minimal test payloads to see what
 * the validator accepts ("Test minimal reason string for schema debug
 * purpose only length check now.", "abc"). Those satisfy the SHAPE, so
 * without this check they are recorded as real verdicts and silently poison
 * the review. Every pattern here is unambiguous filler in any context and
 * at any length.
 */
const PLACEHOLDER_PHRASES: readonly RegExp[] = [
  /\blorem ipsum\b/i,
  /\bschema debug\b/i,
  /\blength check (?:now|only)\b/i,
  /\btest minimal\b/i,
  /\bminimal (?:test|reason|suggestion) string\b/i,
  /\bfiller text\b/i,
];

/**
 * Phrases that mark filler in a minimal payload but also occur in genuine
 * scientific prose — "just a test function" in a variational argument,
 * "string length 2" in a separation-of-variables step, "placeholder" echoed
 * from the verdict catalog's own "never placeholder text" wording. Scanned
 * only in SHORT strings: a probe payload is minimal by nature (it exists to
 * clear a length minimum, not to carry content), while a long substantive
 * text containing one of these phrases is real work. Observed in production
 * (bsa_20260811-151331_685134): a judge's genuine multi-hundred-character
 * reason re-deriving a Neumann-rectangle eigenvalue law was rejected as
 * filler on all retries, killing the seat's whole review walk.
 */
const SHORT_ONLY_PLACEHOLDER_PHRASES: readonly RegExp[] = [
  /\bplaceholder\b/i,
  /\bstring length (?:twenty|thirty|forty|fifty|\d+)\b/i,
  /\bjust (?:a test|to fill)\b/i,
  /\bdummy (?:text|value|content)\b/i,
];

/** Above this length a string is content, not a probe (see above). */
const SHORT_PHRASE_SCAN_MAX_CHARS = 200;

/** Exact throwaway field values (whole trimmed value, case-insensitive). */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  "abc",
  "abc abc",
  "ok",
  "test",
  "todo",
  "tbd",
  "n/a",
  "na",
  "xxx",
  "foo",
  "bar",
  "baz",
  "lorem",
  "asdf",
  "dummy",
  "placeholder",
  "...",
]);

/**
 * Scans every string in a shape-valid artifact for probe/filler content.
 * Returned issues flow into the executors' validation-retry loop, so the
 * agent gets a fresh session with the exact field named — and a persistent
 * offender fails LOUD instead of being recorded.
 *
 * Fields whose schema constrains them to an enum are EXEMPT (via
 * `exemptTemplates`, path templates with `[*]` for array indices): an enum
 * member is the schema's own vocabulary, not filler. Without the exemption
 * a legitimate answer like the profile-lookup outcome "ok" — or the file
 * relation label "NA" — is indistinguishable from placeholder text, and a
 * correct artifact can NEVER pass validation (observed in production: every
 * pool whose scholars resolved profiles failed all retries on
 * `scholars[*].profile: "ok"`).
 */
export function placeholderContentIssues(
  value: unknown,
  path = "artifact",
  exemptTemplates?: ReadonlySet<string>,
): string[] {
  return scanPlaceholders(value, path, path, exemptTemplates);
}

function scanPlaceholders(
  value: unknown,
  path: string,
  template: string,
  exempt: ReadonlySet<string> | undefined,
): string[] {
  if (typeof value === "string") {
    if (exempt?.has(template)) return [];
    const trimmed = value.trim();
    if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) {
      return [
        `${path}: "${trimmed}" is placeholder text, not content — the submission is recorded verbatim as your answer; write the real value`,
      ];
    }
    const phrase =
      PLACEHOLDER_PHRASES.find((pattern) => pattern.test(trimmed)) ??
      (trimmed.length <= SHORT_PHRASE_SCAN_MAX_CHARS
        ? SHORT_ONLY_PLACEHOLDER_PHRASES.find((pattern) => pattern.test(trimmed))
        : undefined);
    if (phrase) {
      const snippet = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
      return [
        `${path}: "${snippet}" reads as schema-probing filler — never test the output tool; submit only your real, final content`,
      ];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      scanPlaceholders(entry, `${path}[${index}]`, `${template}[*]`, exempt),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      scanPlaceholders(entry, `${path}.${key}`, `${template}.${key}`, exempt),
    );
  }
  return [];
}

/** Recursion ceiling for the schema walk; artifact schemas are far shallower. */
const ENUM_WALK_MAX_DEPTH = 32;

/**
 * The path templates of every string-enum (or string-const) field a JSON
 * schema declares, rooted at "artifact" to match the placeholder scan's
 * paths, with `[*]` standing for any array index. These fields carry the
 * schema's own closed vocabulary and are exempt from the placeholder scan.
 */
export function enumPathTemplates(schema: JsonObject): ReadonlySet<string> {
  const out = new Set<string>();
  collectEnumTemplates(schema, "artifact", schema, out, 0);
  return out;
}

function collectEnumTemplates(
  node: unknown,
  template: string,
  root: JsonObject,
  out: Set<string>,
  depth: number,
): void {
  if (depth > ENUM_WALK_MAX_DEPTH) return;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  const record = node as JsonObject;
  // Defensive $ref resolution (the artifact converter inlines reused
  // schemas today, but a "#/$defs/…" pointer must not silently drop a leg).
  const ref = record.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const defs = root.$defs;
    if (typeof defs === "object" && defs !== null && !Array.isArray(defs)) {
      collectEnumTemplates(
        (defs as JsonObject)[ref.slice("#/$defs/".length)],
        template,
        root,
        out,
        depth + 1,
      );
    }
    return;
  }
  if (
    (Array.isArray(record.enum) && record.enum.some((entry) => typeof entry === "string")) ||
    typeof record.const === "string"
  ) {
    out.add(template);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = record[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        collectEnumTemplates(branch, template, root, out, depth + 1);
      }
    }
  }
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      collectEnumTemplates(child, `${template}.${key}`, root, out, depth + 1);
    }
  }
  collectEnumTemplates(record.items, `${template}[*]`, root, out, depth + 1);
  const prefixItems = record.prefixItems;
  if (Array.isArray(prefixItems)) {
    for (const item of prefixItems) {
      collectEnumTemplates(item, `${template}[*]`, root, out, depth + 1);
    }
  }
}

/**
 * The rules a PATCH can only break once it is applied.
 *
 * redevelopmentPatchSchema deliberately drops every cross-field refinement:
 * a rule relating two sections is unjudgeable on a patch that names one of
 * them, and a novelty statement is legal or not depending on the shape of the
 * body it belongs to — which the patch need not carry. Those rules live on the
 * assembled idea, so this merges the patch over the version it revises and
 * validates that, exactly as the runtime will when it records the revision.
 *
 * Returns nothing at all when the task carries no base (every non-revision
 * task, and full-emission bundles, whose schema already carries the rules).
 */
function mergedRevisionIssues(
  schemaName: string | undefined,
  patch: JsonValue,
  task: AgentTask | undefined,
): string[] {
  // Both patch forms carry the same hole: the schema on the wire cannot judge
  // a cross-field rule, so the merged whole is where the rules live. A parts
  // run that skipped this check would lose the retry-before-write a string run
  // gets, and die at the fold on a fault it was never told about.
  const parts = schemaName === "redevelopmentPatchParts";
  if (schemaName !== "redevelopmentPatch" && !parts) return [];
  const ideaSchema = parts ? artifactSchemas.brainIdeaParts : artifactSchemas.brainIdea;
  const base = task?.revisionBase;
  if (base === undefined || base === null || typeof base !== "object" || Array.isArray(base)) {
    return [];
  }
  const record = base as JsonObject;
  const cot = record.cot;
  const output = record.output;
  const stepShapeFits = parts
    ? cot !== undefined &&
      Array.isArray(cot) &&
      cot.every((step) => typeof step === "object" && step !== null && !Array.isArray(step))
    : Array.isArray(cot) && cot.every((step) => typeof step === "string");
  if (
    !Array.isArray(cot) ||
    !stepShapeFits ||
    typeof output !== "object" ||
    output === null ||
    Array.isArray(output)
  ) {
    return [];
  }
  // A patch can only be judged against a whole that was sound to begin with.
  // If the version being revised does not itself validate, every patch over
  // it fails here — the model burns its attempts on a fault it did not cause
  // and cannot repair, turning a bad state into a dead task. Report nothing
  // and let the fold, which is authoritative either way, fail loudly.
  const baseIdea = {
    output,
    cot,
    ...(typeof record.novelty === "string" ? { novelty: record.novelty } : {}),
    ...(record.literature !== undefined ? { literature: record.literature } : {}),
  };
  if (!(ideaSchema.safeParse(baseIdea) as { success: boolean }).success) {
    return [];
  }
  let merged;
  try {
    const from = {
      output: output as Record<string, unknown>,
      ...(typeof record.novelty === "string" ? { novelty: record.novelty } : {}),
    };
    merged = parts
      ? mergeRedevelopmentParts(
          { ...from, cot: cot as readonly CotStepParts[] },
          patch as unknown as RedevelopmentPatchParts,
        )
      : mergeRedevelopment(
          { ...from, cot: cot as readonly string[] },
          patch as unknown as RedevelopmentPatch,
        );
  } catch (error) {
    // The patch does not fit what it revises (an out-of-range step, a body
    // key this member's output never had). Retryable: the model can only
    // learn this from being told.
    return [error instanceof Error ? error.message : String(error)];
  }
  const idea = ideaSchema.safeParse({
    output: merged.output,
    cot: merged.steps,
    ...(merged.novelty !== undefined ? { novelty: merged.novelty } : {}),
    ...(record.literature !== undefined ? { literature: record.literature } : {}),
  }) as
    | { readonly success: true }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { readonly message: string }[] };
      };
  if (idea.success) return [];
  return idea.error.issues.map((issue) => {
    const path = "path" in issue && Array.isArray(issue.path) ? issue.path.join(".") : "";
    const where = path ? `${path}: ` : "";
    return (
      `${where}${issue.message} — this is how your patch reads once applied to the ` +
      `version it revises; deliver the sections that make the whole consistent.`
    );
  });
}

export class ContentArtifactOutputValidator {
  validate(value: unknown, schema: unknown, task?: AgentTask): ContentValidationResult {
    const schemaName =
      typeof schema === "object" && schema !== null && typeof (schema as JsonObject).title === "string"
        ? ((schema as JsonObject).title as string)
        : undefined;
    const artifact = schemaName
      ? (artifactSchemas as Readonly<Record<string, { safeParse(value: unknown): unknown }>>)[schemaName]
      : undefined;
    if (!artifact) {
      return { success: false, issues: ["JSON Schema title does not name a content artifact schema"] };
    }
    const schemaRecord =
      typeof schema === "object" && schema !== null
        ? (schema as JsonObject)
        : undefined;
    const properties =
      schemaRecord &&
      typeof schemaRecord.properties === "object" &&
      schemaRecord.properties !== null &&
      !Array.isArray(schemaRecord.properties)
        ? (schemaRecord.properties as JsonObject)
        : undefined;
    const verdictSchema =
      properties &&
      typeof properties.verdict === "object" &&
      properties.verdict !== null &&
      !Array.isArray(properties.verdict)
        ? (properties.verdict as JsonObject)
        : undefined;
    const allowedVerdicts = Array.isArray(verdictSchema?.enum)
      ? verdictSchema.enum.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    if (
      allowedVerdicts.length > 0 &&
      (typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        typeof (value as JsonObject).verdict !== "string" ||
        !allowedVerdicts.includes((value as JsonObject).verdict as string))
    ) {
      return {
        success: false,
        issues: [
          `verdict: must be one of ${allowedVerdicts.join(", ")} for this round`,
        ],
      };
    }
    // The task schema pins the run's requested-output sections (required +
    // entry count + ordered titles) when the submission explicitly asked for
    // deliverables, and removes the property when it did not. Enforcing that
    // pin here turns a wrong section list into retryable feedback on every
    // executor path instead of a failed run at write time.
    const requestedIssue = requestedSectionIssue(value, properties);
    if (requestedIssue !== undefined) {
      return { success: false, issues: [requestedIssue] };
    }
    const parsed = artifact.safeParse(value) as
      | { readonly success: true; readonly data: unknown }
      | { readonly success: false; readonly error: { readonly issues: readonly { readonly message: string }[] } };
    if (!parsed.success) {
      return {
        success: false,
        issues: parsed.error.issues.map((issue) => {
          const path = "path" in issue && Array.isArray(issue.path)
            ? issue.path.join(".")
            : "";
          return path ? `${path}: ${issue.message}` : issue.message;
        }),
      };
    }
    if (!jsonValue(parsed.data)) {
      return { success: false, issues: ["validated artifact is not JSON-safe"] };
    }
    // Shape-valid is not enough: probe/filler submissions satisfy the schema
    // by construction, and once recorded they poison the review as real
    // verdicts. Reject them here so the retry loop demands real content —
    // exempting enum-constrained fields, whose members ("ok", "NA", …) are
    // the schema's own vocabulary, never filler.
    const placeholderIssues = placeholderContentIssues(
      parsed.data,
      "artifact",
      schemaRecord ? enumPathTemplates(schemaRecord) : undefined,
    );
    if (placeholderIssues.length > 0) {
      return { success: false, issues: placeholderIssues };
    }
    // A patch is validated loosely on its own — a rule relating two sections
    // cannot be judged from a patch naming one of them — so the rules that
    // only exist on the WHOLE are checked here, against the version being
    // revised. Doing it while the loop can still retry is the whole point:
    // the same check runs again when the revision is recorded, and a failure
    // there is a dead run, because the answer is already journaled.
    const mergeIssues = mergedRevisionIssues(schemaName, parsed.data, task);
    if (mergeIssues.length > 0) {
      return { success: false, issues: mergeIssues };
    }
    return { success: true, value: parsed.data };
  }
}
