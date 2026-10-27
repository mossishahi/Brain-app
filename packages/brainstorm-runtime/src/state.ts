import {
  artifactSchemas,
  mergeRedevelopment,
  mergeRedevelopmentParts,
  type CotStepParts,
  type RedevelopmentPatch,
  type RedevelopmentPatchParts,
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
  if (typeof value !== typeof definition.default) {
    throw new BrainstormRuntimeError(
      `workflow param "${name}" must be ${typeof definition.default}`,
      "INVALID_WORKFLOW_PARAM",
    );
  }
  if (name === "gameDecisionRule" && value !== "committee-mean" && value !== "chair-decisive") {
    throw new BrainstormRuntimeError('workflow param "gameDecisionRule" must be "committee-mean" or "chair-decisive"', "INVALID_WORKFLOW_PARAM");
  }
  if (typeof definition.default !== "number") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrainstormRuntimeError(`workflow param "${name}" must be numeric`, "INVALID_WORKFLOW_PARAM");
  }
  if (name === "gameInitialPoints" && value < 0 && value !== -1) {
    throw new BrainstormRuntimeError('workflow param "gameInitialPoints" must be -1 (automatic) or nonnegative', "INVALID_WORKFLOW_PARAM");
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
    const value = Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name]! : definition.default;
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
    // The per-member objection ledger: the anonymized scientific decision
    // and repair changes for each round, plus optional host-only game score
    // observations. The runtime writes it; task history projections strip
    // those observations before any model receives the scientific record.
    reviewLog: {},
    // The thinking behind each seat's chain, one entry per step, keyed by
    // member id (parallel-merge safe like `ideas`). Written by the runtime
    // from the executor's captured per-step thought slices: the first pass
    // fills the whole array, and each applied redevelopment replaces exactly
    // the TOUCHED steps' entries with the reviser's own slices — so a step's
    // thoughts always belong to whoever wrote its current text. "" means
    // nothing was recorded (providers may withhold thinking). Bound into
    // review tasks only — never the thinker's or the reviser's — and never
    // written to the ledger, so nothing the author receives can reveal that
    // its thoughts are read.
    thoughts: {},
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
 * model's diligence. PATCHPARTS is the same patch over a chain whose steps
 * are written in four parts: a named step is replaced whole, because a
 * rewrite may move the boundaries between its parts.
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
  delivery: "full" | "patch" | "patchParts" = "full",
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
  if (delivery === "patch" || delivery === "patchParts") {
    let merged;
    try {
      // The two merges differ only in what one step IS; the body patch and
      // the novelty carry-over are the same code in both, so a run cannot
      // end up with a four-part chain folded by a different set of rules
      // than the string chain beside it.
      const base = {
        output: object(previous.output, `idea for ${memberId}: output`),
        ...(typeof previous.novelty === "string" ? { novelty: previous.novelty } : {}),
      };
      merged =
        delivery === "patchParts"
          ? mergeRedevelopmentParts(
              { ...base, cot: previousCot as unknown as readonly CotStepParts[] },
              revision as unknown as RedevelopmentPatchParts,
            )
          : mergeRedevelopment(
              { ...base, cot: previousCot as string[] },
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
    // Compared by VALUE, not identity: a four-part patch hands back a fresh
    // object for every step it names, and a step whose four parts all match
    // the previous one changed nothing however new the object holding them
    // is. Identity remains the fast path jsonEqual takes first, which is
    // what every step the patch did not name hits. The ledger stays at STEP
    // granularity — a step is touched when ANY of its parts differ — because
    // that is the unit the review walk, the history and the dashboard all
    // already speak in.
    (jsonEqual(step, previousCot[index]) ? untouched : touched).push(index + 1);
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

/**
 * Merges one fact-update reconsideration of a seat's chain (fact-update design
 * 5.1) into `ideas[seat]` with the redevelopment merge: the rewritten
 * four-part steps, the developed sections and the novelty it names, the chain
 * length fixed and `literature` kept. The rewritten steps' thoughts become ""
 * (the reconsideration's own thinking stays in its thinking artifact).
 * `reviews[seat]`, the review log and every settlement are not touched (U2).
 * An `unchanged` decision changes nothing. Returns the steps it rewrote.
 */
export function applyChainReconsideration(
  state: JsonObject,
  seat: string,
  revisionValue: JsonValue,
  nodeId: string,
): { readonly state: JsonObject; readonly touched: readonly number[] } {
  const revision = object(revisionValue, "chain reconsideration");
  if (revision.decision !== "revised") return { state, touched: [] };
  const ideas = isObject(state.ideas) ? state.ideas : {};
  const previous = object(ideas[seat], `idea for ${seat}`);
  const previousCot = previous.cot;
  if (!Array.isArray(previousCot) || !previousCot.every((step) => isObject(step))) {
    throw new BrainstormRuntimeError(
      `node "${nodeId}" can merge a fact-update reconsideration only into a four-part chain`,
      "INVALID_REDEVELOPMENT",
    );
  }
  let merged;
  try {
    merged = mergeRedevelopmentParts(
      {
        output: object(previous.output, `idea for ${seat}: output`),
        cot: previousCot as unknown as readonly CotStepParts[],
        ...(typeof previous.novelty === "string" ? { novelty: previous.novelty } : {}),
      },
      {
        steps: Array.isArray(revision.steps) ? revision.steps : [],
        ...(revision.outputPatch !== undefined ? { outputPatch: revision.outputPatch } : {}),
        ...(revision.novelty !== undefined ? { novelty: revision.novelty } : {}),
      } as unknown as RedevelopmentPatchParts,
    );
  } catch (error) {
    throw new BrainstormRuntimeError(
      `node "${nodeId}" merged a fact-update reconsideration that does not fit the chain it revises: ` +
        (error instanceof Error ? error.message : String(error)),
      "INVALID_REDEVELOPMENT",
    );
  }
  const steps = [...merged.steps] as unknown as JsonValue[];
  const touched: number[] = [];
  steps.forEach((step, index) => {
    if (!jsonEqual(step, previousCot[index])) touched.push(index + 1);
  });
  const revisedIdea: JsonObject = {
    output: merged.output as JsonValue,
    cot: structuredClone(steps),
    ...(merged.novelty !== undefined ? { novelty: merged.novelty } : {}),
    ...(previous.literature !== undefined ? { literature: structuredClone(previous.literature) } : {}),
  };
  const next: MutableJsonObject = { ...state, ideas: { ...ideas, [seat]: revisedIdea } };
  const thoughts = isObject(state.thoughts) ? state.thoughts : undefined;
  const seatThoughts = thoughts?.[seat];
  if (thoughts !== undefined && Array.isArray(seatThoughts) && touched.length > 0) {
    const cleared = [...seatThoughts];
    for (const step of touched) if (step <= cleared.length) cleared[step - 1] = "";
    next.thoughts = { ...thoughts, [seat]: cleared };
  }
  return { state: next, touched };
}

/**
 * Applies a report or comment merge point's journaled entries (fact-update
 * design 5.2, 5.3, 6.3) to the round record `reviews[seat].current`: a revised
 * report or comment replaces the critic's, a game report with its revision's
 * request epoch in `gameReportEpochs`; a withdrawn one leaves the round and is
 * recorded in `gameWithdrawn` or `commentsWithdrawn` with its notices and
 * reason; an unchanged one stays. With `keepFirst` (a late merge that set
 * `reassess`) the first assessment is kept in `gameChairFirst` or
 * `decisionFirst` before the re-assessment replaces it (D4). Returns whether
 * anything was revised or withdrawn.
 */
export function applyReportReconsiderations(
  state: JsonObject,
  seat: string,
  kind: "game-report" | "comment",
  merged: readonly JsonValue[],
  keepFirst: boolean,
  normalize: (report: JsonValue) => JsonValue = (report) => report,
): { readonly state: JsonObject; readonly changed: boolean } {
  const seatState = reviewSeat(state, seat);
  const current = isObject(seatState.current) ? seatState.current : {};
  const reportsKey = kind === "game-report" ? "gameCritiques" : "comments";
  const withdrawnKey = kind === "game-report" ? "gameWithdrawn" : "commentsWithdrawn";
  const reports: MutableJsonObject = { ...(isObject(current[reportsKey]) ? current[reportsKey] : {}) };
  const epochs: MutableJsonObject = { ...(isObject(current.gameReportEpochs) ? current.gameReportEpochs : {}) };
  const withdrawn: MutableJsonObject = { ...(isObject(current[withdrawnKey]) ? current[withdrawnKey] : {}) };
  let changed = false;
  let epochsChanged = false;
  let withdrawals = false;
  for (const raw of merged) {
    const entry = object(raw, "fact-update merge entry");
    const parts = typeof entry.key === "string" ? entry.key.split(":") : [];
    if (parts.length !== 5 || parts[0] !== kind || parts[1] !== seat || parts[4] === "") {
      throw new BrainstormRuntimeError(`fact-update merge entry "${String(entry.key)}" does not belong to this round`, "INVALID_REVIEW_STATE");
    }
    const critic = parts[4]!;
    const output = object(entry.output, "fact-update merge output");
    if (output.decision === "revised") {
      reports[critic] = normalize(structuredClone(kind === "game-report" ? output.report! : output.comment!));
      if (kind === "game-report" && typeof entry.epoch === "number") {
        epochs[critic] = entry.epoch;
        epochsChanged = true;
      }
      changed = true;
    } else if (output.decision === "withdrawn") {
      delete reports[critic];
      withdrawn[critic] = { notices: structuredClone(entry.notices ?? []), reason: output.reason ?? "" };
      withdrawals = true;
      changed = true;
    }
  }
  if (!changed && !keepFirst) return { state, changed };
  const updated: MutableJsonObject = { ...current, [reportsKey]: reports };
  if (epochsChanged) updated.gameReportEpochs = epochs;
  if (withdrawals) updated[withdrawnKey] = withdrawn;
  if (keepFirst) {
    const first = kind === "game-report" ? current.gameChair : current.decision;
    if (first !== undefined) updated[kind === "game-report" ? "gameChairFirst" : "decisionFirst"] = structuredClone(first);
  }
  const next: MutableJsonObject = { ...state };
  putSeat(next, seat, { ...seatState, current: updated });
  return { state: next, changed };
}

/** The per-step thought slices of one agent result, from its journaled metadata. */
function thoughtSlices(metadata: JsonValue | undefined): ReadonlyMap<number, string> {
  const slices = new Map<number, string>();
  if (!isObject(metadata) || !Array.isArray(metadata.stepThoughts)) return slices;
  for (const raw of metadata.stepThoughts) {
    if (!isObject(raw)) continue;
    const { step, text } = raw;
    if (typeof step === "number" && Number.isSafeInteger(step) && step >= 1 && typeof text === "string") {
      slices.set(step, text);
    }
  }
  return slices;
}

/**
 * Folds an agent result's captured per-step thoughts into the member's
 * `thoughts` state.
 *
 * A FIRST PASS replaces the whole array: one entry per chain step, "" where
 * the capture recorded nothing (withheld thinking is a normal answer, never
 * an error). A REDEVELOPMENT replaces exactly the steps the applied patch
 * TOUCHED — the reviser's thinking now stands behind the text it rewrote,
 * and a touched step whose slice is empty becomes "" rather than keeping the
 * previous author's thoughts about text that no longer exists. Untouched
 * steps keep their entries, exactly like the chain text they describe.
 *
 * Deterministic over journaled values only (the metadata IS part of the
 * journaled agent result), so every replay rebuilds the same array. Runs
 * recorded before the capture existed simply keep empty strings.
 */
export function applyThoughts(
  state: JsonObject,
  scope: ScopeReader,
  metadata: JsonValue | undefined,
  delivery: "develop" | "redevelop",
): JsonObject {
  const memberId = resolveDataReference("member.id", scope, state, { required: false });
  const totalSteps = resolveDataReference("input.cotSteps", scope, state, { required: false });
  if (typeof memberId !== "string" || typeof totalSteps !== "number" || totalSteps < 1) {
    return state;
  }
  const slices = thoughtSlices(metadata);
  const existing = resolveDataReference("thoughts[member.id]", scope, state, {
    required: false,
  });
  const current: string[] = Array.from({ length: totalSteps }, (_, index) => {
    const entry = Array.isArray(existing) ? existing[index] : undefined;
    return typeof entry === "string" ? entry : "";
  });
  if (delivery === "develop") {
    for (let step = 1; step <= totalSteps; step += 1) {
      current[step - 1] = slices.get(step) ?? "";
    }
  } else {
    const touched = resolveDataReference("reviews[member.id].current.touched", scope, state, {
      required: false,
    });
    for (const step of Array.isArray(touched) ? touched : []) {
      if (typeof step !== "number" || step < 1 || step > totalSteps) continue;
      current[step - 1] = slices.get(step) ?? "";
    }
  }
  return writeDataReference(state, "thoughts[member.id]", current, scope).state;
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

/**
 * The objections a closed position raised, each with the step it targets.
 *
 * Keyed on the PAIR: an objection is identified by what it says and where it
 * says it. Collapsing on the text alone merged two genuinely different
 * objections whenever a reviewer worded the same fault at two steps — and the
 * record then told every later reader that one of them had been raised
 * somewhere it never was. The target also matters on its own: a position may
 * fault a step other than its own, so without it "raised at position 3" says
 * nothing about which step is meant.
 */
function issuePoints(rounds: readonly JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  const objections: JsonObject[] = [];
  for (const round of rounds) {
    for (const raw of Array.isArray(round.issues) ? round.issues : []) {
      if (!isObject(raw)) continue;
      const point = raw.point;
      if (typeof point !== "string" || point.length === 0) continue;
      const step = typeof raw.step === "number" ? raw.step : 0;
      const key = `${step}\u0000${point}`;
      if (seen.has(key)) continue;
      seen.add(key);
      objections.push({ step, point });
    }
  }
  return objections;
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
 * A round record with every step reference its reader cannot see removed.
 *
 * Review is never prospective — in what a reviewer READS as much as in what
 * it may say. A redevelopment may rewrite steps past the walk position (the
 * host applies them, and they are reviewed when the walk arrives), so the
 * ledger's change-sets legitimately name future steps — but a record handed
 * to a task must not: a commentor at position 1 was handed
 * `touched: [1,2], untouched: [3,4,5,6]` beside a chain of one step, and
 * spent its round reconciling bookkeeping that, in its own world, cannot
 * exist ("is this history stale?"). The clamp keeps every reference the
 * reader can check and drops every reference it cannot — including the
 * accidental announcement of the chain's planned length.
 *
 * The LEDGER itself stays complete: the dashboard's prospective-edit cards
 * and the run summary read the full record; only what a task is handed is
 * clamped.
 */
function clampRoundToPosition(round: JsonObject, currentStep: number): JsonObject {
  const visible = (value: JsonValue | undefined): number[] | undefined =>
    Array.isArray(value)
      ? value.filter(
          (step): step is number => typeof step === "number" && step <= currentStep,
        )
      : undefined;
  const touched = visible(round.touched);
  const untouched = visible(round.untouched);
  // Scores are host observations, not feedback to later model tasks. Keep
  // them in the durable ledger/dashboard only, including after a repair.
  const { gameSettlement: _observations, gameLabels: _labels, ...taskRecord } = round;
  return {
    ...taskRecord,
    ...(touched !== undefined ? { touched } : {}),
    ...(untouched !== undefined ? { untouched } : {}),
  };
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
      outcome: passed ? "passed" : last.gameStatus === "unresolved" ? "unresolved" : "force-passed",
      objections,
      // A closed position's revisions may have rewritten steps the CURRENT
      // reader has not been shown yet (a prospective repair); only the
      // rewrites it can check are named. The full list surfaces naturally as
      // the walk advances past those steps.
      revised: revisedSteps(rounds).filter((revised) => revised <= currentStep),
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
    // This position's rounds ride verbatim — except their change-sets, which
    // are clamped like everything else the reader is handed: a revision here
    // may have rewritten later steps, and naming them would tell a reviewer
    // the future already exists as text.
    rounds: (byStep.get(currentStep) ?? []).map((round) =>
      clampRoundToPosition(structuredClone(round), currentStep),
    ) as JsonValue[],
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
  const position = reviewStepIndex(next, scope);
  putSeat(next, memberId, {
    round: 0,
    allowedVerdicts: allowedVerdictNames(verdicts, undefined),
    history: boundHistory(next, memberId, position),
    record: scopedRecord(next, memberId, position),
    phase: "commenting",
    current: { comments: {}, ...(object(next.params, "params").gamifiedReview === true ? { gameCritiques: {} } : {}) },
  });
  return next;
}

/**
 * The flat ledger as a task may READ it — bundles published before the
 * scoped record bind this instead. Same clamp as the record: the ledger
 * itself keeps every change-set in full, but nothing handed to a task may
 * name a step past the walk position, whatever bundle the run is pinned to.
 * The invariant is the runtime's, not the content's, so old pinned runs are
 * protected too.
 */
function boundHistory(
  state: JsonObject,
  memberId: string,
  currentStep: number,
): JsonValue[] {
  return memberHistory(state, memberId).map((entry) =>
    isObject(entry) ? clampRoundToPosition(entry, currentStep) : entry,
  );
}

export function prepareReviewRound(
  state: JsonObject,
  scope: ScopeReader,
  verdicts: VerdictsCatalog,
): JsonObject {
  const next = mutableState(state);
  const memberId = reviewMemberId(next, scope);
  const position = reviewStepIndex(next, scope);
  const seat = reviewSeat(next, memberId);
  const round = (typeof seat.round === "number" ? seat.round : 0) + 1;
  putSeat(next, memberId, {
    // The spread carries `lastVerdict` across rounds at the same position —
    // it is the input to the sequencing rule.
    ...seat,
    round,
    allowedVerdicts: allowedVerdictNames(verdicts, seat.lastVerdict),
    history: boundHistory(next, memberId, position),
    record: scopedRecord(next, memberId, position),
    // The single derived expression of the round budget: the loop's exit
    // condition and the redevelop guard both read this flag, so no literal
    // round count appears in content or in the dashboard.
    finalRound: round >= roundBudget(next),
    phase: "commenting",
    // Reset wholesale so last round's comments AND decision are dropped; the
    // loop's until-condition must never be satisfied by a stale verdict. With
    // fact updates the round record may gain, all optional and all dropped
    // here: gameReportEpochs, gameWithdrawn, commentsWithdrawn,
    // factReportUpdate, factLateUpdate, gameChairFirst, decisionFirst and
    // gameChairEarlierTaskIds (fact-update design 11.10).
    current: { comments: {}, ...(object(next.params, "params").gamifiedReview === true ? { gameCritiques: {} } : {}) },
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
    ...(isObject(current.gameSettlement)
      ? {
          gameSettlement: structuredClone(current.gameSettlement),
          gameStatus: current.gameSettlement.y === 0
            ? "passed"
            : current.gameSettlement.y === null || seat.finalRound === true
              ? "unresolved"
              : "continuing",
          // Scoring v3 records the rule the round was decided under and the
          // chair's label of each report. The labels are host observations
          // like the settlement itself and are stripped from task records.
          ...(typeof current.gameSettlement.decisionRule === "string"
            ? {
                gameDecisionRule: current.gameSettlement.decisionRule,
                gameLeaveOneOut: current.gameSettlement.leaveOneOut === true,
                gameLabels: Object.fromEntries((Array.isArray(current.gameSettlement.rows) ? current.gameSettlement.rows : [])
                  .filter(isObject).map((row) => [String(row.criticId), typeof row.label === "string" ? row.label : null] as const)),
              }
            : {}),
        }
      : {}),
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
