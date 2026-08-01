import {
  artifactSchemas,
  type ContentBundle,
  type WorkflowDefinition as ContentWorkflowDefinition,
} from "@brainstorm-agentic/content";
import type { JsonObject, JsonValue, ScopeReader } from "@brainstorm-agentic/core";

import { jsonEqual, resolveDataReference, writeDataReference } from "./data-ref.js";
import { ArtifactValidationError, BrainstormRuntimeError } from "./errors.js";

export const BRAINSTORM_STATE = "__brainstormState";

type MutableJsonObject = Record<string, JsonValue>;

function asJson<T extends JsonValue>(value: unknown): T {
  return structuredClone(value) as T;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrainstormRuntimeError(`${label} must be an object`, "INVALID_RUNTIME_STATE");
  }
  return value as JsonObject;
}

function positiveParam(
  name: string,
  value: JsonValue,
  definition: ContentWorkflowDefinition["params"][string],
): void {
  if (typeof definition.default !== "number") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrainstormRuntimeError(`workflow param "${name}" must be numeric`, "INVALID_WORKFLOW_PARAM");
  }
  if (definition.min !== undefined && value < definition.min) {
    throw new BrainstormRuntimeError(
      `workflow param "${name}" must be at least ${definition.min}`,
      "INVALID_WORKFLOW_PARAM",
    );
  }
  if (definition.max !== undefined && value > definition.max) {
    throw new BrainstormRuntimeError(
      `workflow param "${name}" must be at most ${definition.max}`,
      "INVALID_WORKFLOW_PARAM",
    );
  }
}

export function createInitialState(
  bundle: ContentBundle,
  workflow: ContentWorkflowDefinition,
  submission: JsonValue,
  overrides: Readonly<Record<string, JsonValue>> = {},
): JsonObject {
  for (const name of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(workflow.params, name)) {
      throw new BrainstormRuntimeError(`unknown workflow param "${name}"`, "INVALID_WORKFLOW_PARAM");
    }
  }
  const params: MutableJsonObject = {};
  for (const [name, definition] of Object.entries(workflow.params)) {
    const value = overrides[name] ?? definition.default;
    positiveParam(name, value, definition);
    params[name] = value;
  }
  const verdicts = asJson<JsonObject>(bundle.catalogs.verdicts);
  return {
    session: { submission },
    params,
    catalog: {
      // The projected input-types reference: types (name -> description, in
      // disambiguation order) plus shapes/guidance/outlines projections, all
      // sourced from the bundle's single catalog/input-types.json.
      inputTypes: asJson<JsonObject>(bundle.catalogs.inputTypes),
      verdicts,
      departments: asJson<JsonObject>(bundle.catalogs.departments),
    },
    ideas: {},
    round: { comments: {} },
    review: {
      round: 0,
      allowedVerdicts: object(verdicts.verdicts, "catalog verdicts"),
      history: [],
    },
    // The per-member objection ledger: one compact, ANONYMIZED record per
    // review round (judge verdict, its issues content-only, and the
    // change-set of the redevelopment that followed, when one did). The
    // runtime — never a model — writes it; review.history is the per-round
    // projection bound into commentor/judge/redeveloper tasks.
    reviewLog: {},
    _runtime: {
      artifacts: {},
      gates: {},
    },
  };
}

function zodIssues(error: unknown): readonly string[] {
  const issues = (error as { readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[] })
    .issues;
  if (!issues) return [error instanceof Error ? error.message : String(error)];
  return issues.map((issue) => {
    const path = issue.path?.map(String).join(".") ?? "";
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateArtifact(
  schemaName: string,
  nodeId: string,
  value: JsonValue,
): JsonValue {
  const schema = (artifactSchemas as Readonly<Record<string, { safeParse(value: unknown): unknown }>>)[schemaName];
  if (!schema) {
    throw new BrainstormRuntimeError(`unknown artifact schema "${schemaName}"`, "UNKNOWN_ARTIFACT_SCHEMA");
  }
  const parsed = schema.safeParse(value) as
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false; readonly error: unknown };
  if (!parsed.success) {
    throw new ArtifactValidationError(schemaName, nodeId, zodIssues(parsed.error));
  }
  return asJson<JsonValue>(parsed.data);
}

/**
 * Applies a full-chain redevelopment: the reviser re-emitted the COMPLETE
 * chain (touched steps rewritten, unaffected steps copied verbatim), and the
 * runtime — never the model — computes the change-set by exact per-step
 * comparison against the previous chain. Chain length is invariant. The
 * change-set is stashed on `round` so finishReviewRound can fold it into the
 * member's review-ledger record, and the previous idea's `literature` rides
 * through unchanged (the reviser reworks reasoning, not its grounding
 * record).
 */
export function applyRedevelopment(
  state: JsonObject,
  scope: ScopeReader,
  revisionValue: JsonValue,
  nodeId: string,
): JsonObject {
  const revision = object(revisionValue, "redevelopment");
  const totalSteps = resolveDataReference("input.cotSteps", scope, state, { required: true });
  const memberId = resolveDataReference("member.id", scope, state, { required: true });
  if (typeof totalSteps !== "number" || typeof memberId !== "string") {
    throw new BrainstormRuntimeError(
      `node "${nodeId}" cannot apply redevelopment without member.id and input.cotSteps`,
      "INVALID_REDEVELOPMENT",
    );
  }
  const steps = revision.steps;
  if (!Array.isArray(steps) || steps.length !== totalSteps) {
    throw new BrainstormRuntimeError(
      `node "${nodeId}" redevelopment must carry the complete ${totalSteps}-step chain`,
      "INVALID_REDEVELOPMENT",
    );
  }
  const previous = object(
    resolveDataReference("ideas[member.id]", scope, state, { required: true }),
    `idea for ${memberId}`,
  );
  const previousCot = previous.cot;
  if (!Array.isArray(previousCot) || previousCot.length !== totalSteps) {
    throw new BrainstormRuntimeError(
      `idea for "${memberId}" does not have the invariant ${totalSteps}-step chain`,
      "INVALID_REDEVELOPMENT",
    );
  }
  const touched: number[] = [];
  const untouched: number[] = [];
  steps.forEach((step, index) => {
    (step === previousCot[index] ? untouched : touched).push(index + 1);
  });
  const revisedIdea: JsonObject = {
    output: revision.output!,
    cot: structuredClone(steps),
    ...(revision.novelty !== undefined ? { novelty: revision.novelty } : {}),
    ...(previous.literature !== undefined
      ? { literature: structuredClone(previous.literature) }
      : {}),
  };
  const next = writeDataReference(state, "ideas[member.id]", revisedIdea, scope).state;
  const round = object(next.round, "round");
  return {
    ...next,
    round: { ...round, touched, untouched },
  };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone(value: JsonValue | undefined): JsonValue | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function mergeValue(
  base: JsonValue | undefined,
  current: JsonValue | undefined,
  branch: JsonValue | undefined,
  path: string,
): JsonValue | undefined {
  if (jsonEqual(branch, base)) return clone(current);
  if (jsonEqual(current, base) || jsonEqual(current, branch)) return clone(branch);

  if (
    isObject(current) &&
    isObject(branch) &&
    (base === undefined || isObject(base))
  ) {
    const baseObject = isObject(base) ? base : {};
    const result: MutableJsonObject = {};
    const keys = new Set([
      ...Object.keys(baseObject),
      ...Object.keys(current),
      ...Object.keys(branch),
    ]);
    for (const key of keys) {
      const merged = mergeValue(baseObject[key], current[key], branch[key], path ? `${path}.${key}` : key);
      if (merged !== undefined) result[key] = merged;
    }
    return result;
  }
  throw new BrainstormRuntimeError(
    `parallel branches produced conflicting state updates at "${path || "(root)"}"`,
    "PARALLEL_STATE_CONFLICT",
  );
}

/** Three-way merge of isolated branch states, applied in stable item order. */
export function mergeParallelStates(
  base: JsonObject,
  branches: readonly JsonValue[],
): JsonObject {
  let current: JsonValue = structuredClone(base);
  for (const branch of branches) {
    if (!isObject(branch)) {
      throw new BrainstormRuntimeError("parallel branch did not return runtime state", "INVALID_RUNTIME_STATE");
    }
    current = mergeValue(base, current, branch, "")!;
  }
  return object(current, "merged runtime state");
}

function mutableState(state: JsonObject): MutableJsonObject {
  return structuredClone(state) as MutableJsonObject;
}

/**
 * The member whose chain the current review loop walks, resolved from scope.
 */
function reviewMemberId(state: JsonObject, scope: ScopeReader): string {
  const memberId = resolveDataReference("member.id", scope, state, { required: true });
  if (typeof memberId !== "string") {
    throw new BrainstormRuntimeError("review loop has no member.id in scope", "INVALID_REVIEW_STATE");
  }
  return memberId;
}

/**
 * The member's review ledger so far: chronological, compact, and ANONYMOUS
 * (objection content, never commentor identity), cloned for binding as
 * review.history. An empty array is the valid first-round view.
 */
function memberHistory(state: JsonObject, memberId: string): JsonValue[] {
  const log = state.reviewLog;
  if (typeof log !== "object" || log === null || Array.isArray(log)) return [];
  const entries = (log as JsonObject)[memberId];
  return Array.isArray(entries) ? (structuredClone(entries) as JsonValue[]) : [];
}

/** An issue as the ledger keeps it: the content, with evidence collapsed to its kind. */
function ledgerIssue(value: JsonValue): JsonObject {
  const issue = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
  const evidence = issue.evidence;
  const evidenceKind =
    typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
      ? (evidence as JsonObject).kind
      : undefined;
  return {
    step: typeof issue.step === "number" ? issue.step : 0,
    point: typeof issue.point === "string" ? issue.point : "",
    basis: typeof issue.basis === "string" ? issue.basis : "authority",
    evidenceKind: typeof evidenceKind === "string" ? evidenceKind : "none",
    mustAddress: issue.mustAddress === true,
    suggestion: typeof issue.suggestion === "string" ? issue.suggestion : "",
  };
}

export function initializeReview(state: JsonObject, scope: ScopeReader): JsonObject {
  const next = mutableState(state);
  const catalog = object(next.catalog, "catalog");
  const verdictCatalog = object(catalog.verdicts, "catalog.verdicts");
  next.review = {
    round: 0,
    allowedVerdicts: object(verdictCatalog.verdicts, "catalog.verdicts.verdicts"),
    history: memberHistory(next, reviewMemberId(next, scope)),
  };
  next.round = { comments: {} };
  return next;
}

export function prepareReviewRound(state: JsonObject, scope: ScopeReader): JsonObject {
  const next = mutableState(state);
  const review = object(next.review, "review");
  const catalog = object(next.catalog, "catalog");
  const verdictCatalog = object(catalog.verdicts, "catalog.verdicts");
  const verdicts = object(verdictCatalog.verdicts, "catalog.verdicts.verdicts");
  const sequencing = object(verdictCatalog.sequencing, "catalog.verdicts.sequencing");
  const prohibited = Array.isArray(sequencing.noImmediateRepeat)
    ? sequencing.noImmediateRepeat
    : [];
  const lastVerdict = review.lastVerdict;
  const allowed: MutableJsonObject = {};
  for (const [name, description] of Object.entries(verdicts)) {
    if (!(lastVerdict === name && prohibited.includes(name))) allowed[name] = description;
  }
  next.review = {
    ...review,
    round: typeof review.round === "number" ? review.round + 1 : 1,
    allowedVerdicts: allowed,
    history: memberHistory(next, reviewMemberId(next, scope)),
  };
  next.round = { comments: {} };
  return next;
}

/**
 * Closes one review round: records the judge's verdict for the sequencing
 * rule, and appends the round's ANONYMIZED record — walk position, round
 * number, verdict, reason, content-only issues, and the change-set of the
 * redevelopment that followed (when one did) — to the member's ledger.
 */
export function finishReviewRound(state: JsonObject, scope: ScopeReader): JsonObject {
  const next = mutableState(state);
  const review = object(next.review, "review");
  const round = object(next.round, "round");
  const decision = object(round.decision, "round.decision");
  if (typeof decision.verdict !== "string") {
    throw new BrainstormRuntimeError("review round has no decision verdict", "INVALID_REVIEW_STATE");
  }
  next.review = { ...review, lastVerdict: decision.verdict };

  const memberId = reviewMemberId(next, scope);
  const stepIndex = resolveDataReference("stepIndex", scope, next, { required: true });
  if (typeof stepIndex !== "number") {
    throw new BrainstormRuntimeError("review loop has no stepIndex in scope", "INVALID_REVIEW_STATE");
  }
  const record: JsonObject = {
    step: stepIndex,
    round: typeof review.round === "number" ? review.round : 0,
    verdict: decision.verdict,
    reason: typeof decision.reason === "string" ? decision.reason : "",
    issues: (Array.isArray(decision.issues) ? decision.issues : []).map(ledgerIssue),
    ...(Array.isArray(round.touched)
      ? {
          touched: structuredClone(round.touched),
          untouched: Array.isArray(round.untouched) ? structuredClone(round.untouched) : [],
        }
      : {}),
  };
  const log =
    typeof next.reviewLog === "object" && next.reviewLog !== null && !Array.isArray(next.reviewLog)
      ? (next.reviewLog as MutableJsonObject)
      : {};
  const entries = Array.isArray(log[memberId]) ? (log[memberId] as JsonValue[]) : [];
  log[memberId] = [...entries, record];
  next.reviewLog = log;
  return next;
}
