import {
  artifactSchemas,
  mergeRedevelopment,
  type RedevelopmentPatch,
  type ReviewPhaseName,
  type VerdictsCatalog,
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
  return {
    session: { submission },
    params,
    ideas: {},
    // Per-seat review scratch state, keyed by member id. Nothing here is
    // shared between seats, which is what allows two members' walks to be
    // reviewed in parallel: every key a review branch writes is qualified by
    // its member id, so mergeParallelStates only ever sees one-sided adds.
    // Seats are created lazily by initializeReview — the panel is not known
    // when the run starts.
    reviews: {},
    // The per-member objection ledger: one compact, ANONYMIZED record per
    // review round (judge verdict, its issues content-only, and the
    // change-set of the redevelopment that followed, when one did). The
    // runtime — never a model — writes it; the seat's `history` is the
    // per-round projection bound into commentor/judge/redeveloper tasks.
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
 * Applies a redevelopment, in either delivery form.
 *
 * FULL: the reviser re-emitted the COMPLETE chain and body (rewritten steps
 * changed, unaffected steps copied verbatim). PATCH: it submitted only the
 * steps it rewrote and only the body sections it changed, and the host
 * carries everything else over from the version being revised — which makes
 * an untouched step byte-identical by construction rather than by the
 * model's diligence.
 *
 * Either way the runtime — never the model — computes the change-set by exact
 * per-step comparison against the previous chain, chain length is invariant,
 * the change-set is stashed on the seat's `current` so finishReviewRound can
 * fold it into the review ledger, and the previous idea's `literature` rides
 * through unchanged (the reviser reworks reasoning, not its grounding
 * record). What lands in state is the same shape in both cases, so nothing
 * downstream can tell which form produced it.
 */
export function applyRedevelopment(
  state: JsonObject,
  scope: ScopeReader,
  revisionValue: JsonValue,
  nodeId: string,
  delivery: "full" | "patch" = "full",
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
  let steps: JsonValue[];
  let output: JsonValue;
  let novelty: JsonValue | undefined;
  if (delivery === "patch") {
    let merged;
    try {
      merged = mergeRedevelopment(
        {
          cot: previousCot as string[],
          output: object(previous.output, `idea for ${memberId}: output`),
          ...(typeof previous.novelty === "string" ? { novelty: previous.novelty } : {}),
        },
        revision as unknown as RedevelopmentPatch,
      );
    } catch (error) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" produced a revision that does not fit the version it revises: ` +
          (error instanceof Error ? error.message : String(error)),
        "INVALID_REDEVELOPMENT",
      );
    }
    steps = [...merged.steps];
    output = merged.output as JsonValue;
    novelty = merged.novelty;
  } else {
    const emitted = revision.steps;
    if (!Array.isArray(emitted) || emitted.length !== totalSteps) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" redevelopment must carry the complete ${totalSteps}-step chain`,
        "INVALID_REDEVELOPMENT",
      );
    }
    steps = emitted;
    output = revision.output!;
    novelty = revision.novelty;
  }
  const touched: number[] = [];
  const untouched: number[] = [];
  steps.forEach((step, index) => {
    (step === previousCot[index] ? untouched : touched).push(index + 1);
  });
  const revisedIdea: JsonObject = {
    output,
    cot: structuredClone(steps),
    ...(novelty !== undefined ? { novelty } : {}),
    ...(previous.literature !== undefined
      ? { literature: structuredClone(previous.literature) }
      : {}),
  };
  const withIdea = writeDataReference(state, "ideas[member.id]", revisedIdea, scope).state;
  const current = object(reviewSeat(withIdea, memberId).current, `reviews.${memberId}.current`);
  // Spread `current` so the judge's decision survives — finishReviewRound
  // reads it in this same iteration.
  return writeDataReference(
    withIdea,
    "reviews[member.id].current",
    { ...current, touched, untouched },
    scope,
  ).state;
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

/**
 * Three-way merge of isolated branch states, applied in stable item order.
 *
 * INVARIANT — every key a parallel branch writes must be qualified by that
 * branch's item id. The merge is generic and gives NO compile-time signal
 * when this is violated: two branches writing different values to one shared
 * path throw PARALLEL_STATE_CONFLICT mid-run, and two branches writing one
 * shared ARRAY path (e.g. an artifact-history entry) throw unconditionally,
 * because mergeValue deliberately refuses to guess how to combine arrays.
 *
 * This is what makes parallel review possible: a review branch touches only
 * `reviews[memberId]`, `reviewLog[memberId]`, `ideas[memberId]`, and
 * `_runtime.artifacts` keys derived from those member-qualified write paths,
 * so two seats' key sets never intersect and the merge sees only one-sided
 * adds. Introducing a seat-independent write inside a parallel body silently
 * reintroduces the collision.
 */
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

/** The ledger's rounds for one walk position, in the order they were recorded. */
function roundsByStep(entries: readonly JsonValue[]): Map<number, JsonObject[]> {
  const byStep = new Map<number, JsonObject[]>();
  for (const raw of entries) {
    if (!isObject(raw)) continue;
    const step = raw.step;
    if (typeof step !== "number") continue;
    byStep.set(step, [...(byStep.get(step) ?? []), raw]);
  }
  return byStep;
}

function issuePoints(rounds: readonly JsonObject[]): string[] {
  const points: string[] = [];
  for (const round of rounds) {
    for (const raw of Array.isArray(round.issues) ? round.issues : []) {
      const point = isObject(raw) ? raw.point : undefined;
      if (typeof point === "string" && point.length > 0 && !points.includes(point)) {
        points.push(point);
      }
    }
  }
  return points;
}

/** Every step any revision at this position rewrote, ascending. */
function revisedSteps(rounds: readonly JsonObject[]): number[] {
  const steps = new Set<number>();
  for (const round of rounds) {
    for (const step of Array.isArray(round.touched) ? round.touched : []) {
      if (typeof step === "number") steps.add(step);
    }
  }
  return [...steps].sort((a, b) => a - b);
}

/**
 * For each position in the ledger, the steps that a LATER round's revision
 * rewrote. Built once from the back, so the reconciliation below stays linear
 * and — like every other part of the projection — is a pure function of the
 * recorded ledger.
 *
 * This is what lets a closed record stay honest. A repair at a later walk
 * position may rewrite a step that closed earlier: the text an objection was
 * raised against, or that a `closingReason` certified, is then gone. Without
 * this, the projection keeps asserting the old status forever — an objection
 * left standing reads as open long after a later revision answered it, and a
 * settled step reads as checked when what was checked no longer exists.
 */
function stepsRevisedAfter(entries: readonly JsonValue[]): ReadonlySet<number>[] {
  const after: ReadonlySet<number>[] = new Array<ReadonlySet<number>>(entries.length);
  let running: ReadonlySet<number> = new Set<number>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    after[index] = running;
    const entry = entries[index];
    const touched = isObject(entry) && Array.isArray(entry.touched) ? entry.touched : [];
    if (touched.length > 0) {
      const next = new Set(running);
      for (const step of touched) {
        if (typeof step === "number") next.add(step);
      }
      running = next;
    }
  }
  return after;
}

/**
 * The member's ledger SCOPED to what the current walk position can still act
 * on. The flat ledger carried every round of every earlier position into every
 * later call, so a seat's context grew with its own walk — and most of that
 * text was closed business nobody may reopen.
 *
 * The projection keeps every load-bearing signal and drops the prose around
 * it. Four fields, each computed from the ledger alone — no model, no
 * summarization, so it is identical on every replay:
 *
 * - `clean`: earlier positions that passed in one round without an objection,
 *   as step numbers. The common case, and nothing more needs saying about it.
 * - `settled`: earlier positions that took work — the objections raised there
 *   (so nobody re-raises them), the steps their revisions rewrote, the number
 *   of rounds, and the reason that closed the position (so nobody re-runs a
 *   check that was already made).
 * - `standing`: issues nobody answered. A position that ended force-passed hit
 *   the round cap while the judge still faulted it, so its LAST round's issues
 *   are unresolved by construction — the one thing the flat ledger left every
 *   reader to infer for itself.
 * - `rounds`: this position's own rounds, verbatim, exactly as before.
 *
 * A closed entry carries `revisedSince: true` when a LATER revision rewrote
 * the step it speaks about. Nothing is dropped — the objection and the
 * closing reason still ride — but the reader is told the text they were
 * recorded against has since moved, so a standing objection is not presented
 * as open when a later repair may already have answered it, and a settled
 * step is not presented as checked when the check was made against text that
 * no longer stands.
 */
function scopedRecord(
  state: JsonObject,
  memberId: string,
  currentStep: number,
): JsonObject {
  const entries = memberHistory(state, memberId);
  const byStep = roundsByStep(entries);
  const revisedAfter = stepsRevisedAfter(entries);
  const positionOf = new Map<JsonValue, number>();
  entries.forEach((entry, index) => positionOf.set(entry, index));
  const clean: number[] = [];
  const settled: JsonObject[] = [];
  const standing: JsonValue[] = [];
  for (const step of [...byStep.keys()].sort((a, b) => a - b)) {
    if (step === currentStep) continue;
    const rounds = byStep.get(step)!;
    const last = rounds[rounds.length - 1]!;
    const passed = last.verdict === "Pass";
    const objections = issuePoints(rounds);
    if (rounds.length === 1 && passed && objections.length === 0) {
      clean.push(step);
      continue;
    }
    // What a later round rewrote, as of the moment this position closed.
    const rewrittenLater = revisedAfter[positionOf.get(last) ?? entries.length - 1] ?? new Set<number>();
    settled.push({
      step,
      rounds: rounds.length,
      outcome: passed ? "passed" : "force-passed",
      objections,
      revised: revisedSteps(rounds),
      closingReason: typeof last.reason === "string" ? last.reason : "",
      ...(rewrittenLater.has(step) ? { revisedSince: true } : {}),
    });
    if (!passed) {
      for (const raw of Array.isArray(last.issues) ? last.issues : []) {
        const issue = structuredClone(raw);
        const target = isObject(issue) ? issue.step : undefined;
        standing.push(
          typeof target === "number" && rewrittenLater.has(target)
            ? { ...issue, revisedSince: true }
            : issue,
        );
      }
    }
  }
  return {
    clean,
    settled,
    standing,
    rounds: structuredClone(byStep.get(currentStep) ?? []) as JsonValue[],
  };
}

/**
 * The walk position the seat is being reviewed at. Resolved leniently: the
 * scoped record is a projection, and a position the loop cannot name is
 * treated as "before the first step", which yields the empty first-round view
 * rather than failing a fold.
 */
function reviewStepIndex(state: JsonObject, scope: ScopeReader): number {
  const stepIndex = resolveDataReference("stepIndex", scope, state, { required: false });
  return typeof stepIndex === "number" ? stepIndex : 0;
}

/**
 * What a seat is doing at its current walk position. Aliased from the content
 * schema rather than restated, so the vocabulary has exactly one definition
 * shared by the bundle, the runtime writer, and the dashboard protocol.
 */
export type ReviewPhase = ReviewPhaseName;

/** One seat's review scratch state; a missing seat reads as empty, never throws. */
function reviewSeat(state: JsonObject, memberId: string): JsonObject {
  const reviews = state.reviews;
  if (!isObject(reviews)) return {};
  const seat = (reviews as JsonObject)[memberId];
  return isObject(seat) ? seat : {};
}

/**
 * Copy-on-write seat replacement. The copy is load-bearing for parallel
 * review: mutating a shared `reviews` object in place would alias base and
 * branch, and the three-way merge decides what to keep by comparing them.
 */
function putSeat(state: MutableJsonObject, memberId: string, seat: JsonObject): void {
  const reviews = isObject(state.reviews) ? { ...(state.reviews as JsonObject) } : {};
  reviews[memberId] = seat;
  state.reviews = reviews;
}

/**
 * The verdicts available this round, as NAMES ONLY — the descriptions stay in
 * the bundle and are zipped back in at bind time, so verdict prose never
 * reaches the journaled state. Applies the catalog's own sequencing rule: a
 * verdict listed in `noImmediateRepeat` may not follow itself at the same
 * walk position.
 */
function allowedVerdictNames(verdicts: VerdictsCatalog, lastVerdict: JsonValue | undefined): string[] {
  const prohibited = new Set(verdicts.sequencing.noImmediateRepeat);
  return Object.keys(verdicts.verdicts).filter(
    (name) => !(name === lastVerdict && prohibited.has(name)),
  );
}

/**
 * The run's review round budget, from the single workflow param that owns it.
 * Read here so no literal round count exists anywhere in content or code.
 */
function roundBudget(state: JsonObject): number {
  const params = state.params;
  const value = isObject(params) ? (params as JsonObject).maxReviewRounds : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new BrainstormRuntimeError(
      'workflow param "maxReviewRounds" must be a positive integer',
      "INVALID_WORKFLOW_PARAM",
    );
  }
  return value;
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

/**
 * Opens a seat's review at a new walk position. The seat object is built
 * FRESH rather than spread: dropping `lastVerdict` at each new chain step is
 * deliberate, and it is what scopes the no-immediate-repeat rule to a single
 * position (a Build ending step N must not forbid a Build opening step N+1).
 */
export function initializeReview(
  state: JsonObject,
  scope: ScopeReader,
  verdicts: VerdictsCatalog,
): JsonObject {
  const next = mutableState(state);
  const memberId = reviewMemberId(next, scope);
  putSeat(next, memberId, {
    round: 0,
    allowedVerdicts: allowedVerdictNames(verdicts, undefined),
    history: memberHistory(next, memberId),
    record: scopedRecord(next, memberId, reviewStepIndex(next, scope)),
    phase: "commenting",
    current: { comments: {} },
  });
  return next;
}

export function prepareReviewRound(
  state: JsonObject,
  scope: ScopeReader,
  verdicts: VerdictsCatalog,
): JsonObject {
  const next = mutableState(state);
  const memberId = reviewMemberId(next, scope);
  const seat = reviewSeat(next, memberId);
  const round = (typeof seat.round === "number" ? seat.round : 0) + 1;
  putSeat(next, memberId, {
    // The spread carries `lastVerdict` across rounds at the same position —
    // it is the input to the sequencing rule.
    ...seat,
    round,
    allowedVerdicts: allowedVerdictNames(verdicts, seat.lastVerdict),
    history: memberHistory(next, memberId),
    record: scopedRecord(next, memberId, reviewStepIndex(next, scope)),
    // The single derived expression of the round budget: the loop's exit
    // condition and the redevelop guard both read this flag, so no literal
    // round count appears in content or in the dashboard.
    finalRound: round >= roundBudget(next),
    phase: "commenting",
    // Reset wholesale so last round's comments AND decision are dropped; the
    // loop's until-condition must never be satisfied by a stale verdict.
    current: { comments: {} },
  });
  return next;
}

/**
 * Closes one review round: records the judge's verdict for the sequencing
 * rule, and appends the round's ANONYMIZED record — walk position, round
 * number, verdict, reason, content-only issues, and the change-set of the
 * redevelopment that followed (when one did) — to the member's ledger.
 */
/**
 * Stamps what the seat is doing before a review node runs. The runtime — never
 * the model — writes it, and it lives under the seat, so it is merge-safe when
 * seats are reviewed in parallel and it gives the dashboard a live per-seat
 * phase instead of one global cursor.
 */
export function setReviewPhase(
  state: JsonObject,
  scope: ScopeReader,
  phase: ReviewPhase,
): JsonObject {
  const next = mutableState(state);
  const memberId = reviewMemberId(next, scope);
  putSeat(next, memberId, { ...reviewSeat(next, memberId), phase });
  return next;
}

export function finishReviewRound(state: JsonObject, scope: ScopeReader): JsonObject {
  const next = mutableState(state);
  const memberId = reviewMemberId(next, scope);
  const seat = reviewSeat(next, memberId);
  const current = object(seat.current, `reviews.${memberId}.current`);
  const decision = object(current.decision, `reviews.${memberId}.current.decision`);
  if (typeof decision.verdict !== "string") {
    throw new BrainstormRuntimeError("review round has no decision verdict", "INVALID_REVIEW_STATE");
  }
  // The spread keeps `current` intact: the loop's until-condition reads this
  // round's decision after this activity runs.
  putSeat(next, memberId, { ...seat, lastVerdict: decision.verdict });

  const stepIndex = resolveDataReference("stepIndex", scope, next, { required: true });
  if (typeof stepIndex !== "number") {
    throw new BrainstormRuntimeError("review loop has no stepIndex in scope", "INVALID_REVIEW_STATE");
  }
  const record: JsonObject = {
    step: stepIndex,
    round: typeof seat.round === "number" ? seat.round : 0,
    verdict: decision.verdict,
    reason: typeof decision.reason === "string" ? decision.reason : "",
    issues: (Array.isArray(decision.issues) ? decision.issues : []).map(ledgerIssue),
    ...(Array.isArray(current.touched)
      ? {
          touched: structuredClone(current.touched),
          untouched: Array.isArray(current.untouched) ? structuredClone(current.untouched) : [],
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
