import {
  CHAIN_PARTS,
  OUTPUT_SHAPES,
  artifactSchemas,
  populatedShape,
  validateResolvedRole,
  type ActivityNode as ContentActivityNode,
  type AgentNode as ContentAgentNode,
  type BindValue,
  type ConditionExpr,
  type ContentBundle,
  type ForEachNode as ContentForEachNode,
  type HumanGateNode as ContentHumanGateNode,
  type RepeatUntilNode as ContentRepeatUntilNode,
  type Skill,
  type WorkflowDefinition as ContentWorkflowDefinition,
  type WorkflowNode as ContentWorkflowNode,
} from "@brainstorm-agentic/content";
import {
  WorkflowConfigError,
  WorkflowFunctions,
  activity,
  agent,
  condition,
  forEach,
  humanGate,
  reduce,
  repeatUntil,
  sequence,
  terminal,
  workflow,
  cacheBoundaryTextBlock,
  resolveCapabilityPlan,
  textBlock,
  type ArtifactRef,
  type BrokerInput,
  type CapabilityDeclaration,
  type ContentBlock,
  type FunctionContext,
  type HostToolManifest,
  type JsonArray,
  type JsonObject,
  type JsonValue,
  type ProviderNativeOffer,
  type ResolvedCapabilityPlan,
  type ScopeReader,
  type SystemPromptSegment,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@brainstorm-agentic/core";

import { planTaskCaches, type TaskCachePlan } from "./cache-plan.js";
import { createDismissalPolicy, type DismissalPolicy } from "./dismissal.js";
import {
  jsonEqual,
  type ReferenceRoots,
  resolveBindValue,
  resolveDataReference,
  writeDataReference,
} from "./data-ref.js";
import { BrainstormRuntimeError } from "./errors.js";
import { applyGateDecision, autoApproveDecision, type HumanGateMode } from "./gates.js";
import { artifactSchemaToJsonSchema } from "./json-schema.js";
import { selectPanel, weavePanel } from "./panel.js";
import { compileSkillPrompt, type PayloadEntry } from "./prompts.js";
import {
  ExecutorOwnedRouteResolver,
  LogicalCapabilityToolResolver,
  type BrainstormRouteResolver,
  type CapabilityToolResolver,
} from "./routes.js";
import {
  applyRedevelopment,
  BRAINSTORM_STATE,
  createInitialState,
  finishReviewRound,
  initializeReview,
  mergeParallelStates,
  prepareReviewRound,
  type ReviewPhase,
  setReviewPhase,
  validateArtifact,
} from "./state.js";

export interface DeterministicActivityContext {
  readonly runId: string;
  readonly nodePath: string;
  readonly signal: AbortSignal;
}

export type DeterministicActivityHandler = (
  input: JsonObject,
  context: DeterministicActivityContext,
) => JsonValue | Promise<JsonValue>;

export interface CompileContentWorkflowOptions {
  readonly bundle: ContentBundle;
  readonly workflow?: string | ContentWorkflowDefinition;
  readonly routeResolver?: BrainstormRouteResolver;
  readonly capabilityTools?: CapabilityToolResolver;
  readonly activities?: Readonly<Record<string, DeterministicActivityHandler>>;
  readonly humanGateMode?: HumanGateMode;
  /** Provider-native operation offers for the capability broker. */
  readonly providerOffers?: readonly ProviderNativeOffer[];
  /** All installed host tools for the capability broker. */
  readonly hostTools?: readonly HostToolManifest[];
  /** User-enabled host tool IDs for the capability broker. */
  readonly enabledHostToolIds?: ReadonlySet<string>;
  /** Capability ids the user disabled for THIS run (per-submission override). */
  readonly disabledCapabilityIds?: ReadonlySet<string>;
  /**
   * Capabilities the host affirms are legitimately empty, mapped to the fact
   * being affirmed. See CapabilityAvailability: an absence nobody vouches for
   * is treated as a defect, so this is how a run says "there is genuinely
   * nothing here" without a required capability failing the task.
   */
  readonly vacantCapabilities?: ReadonlyMap<string, string>;
  /** Resolves role/technique files on first execution; defaults to bundle.skills. */
  readonly skillResolver?: SkillResolver;
  /**
   * Journal layout to compile for. 2 (default): deterministic state folds
   * are never journaled and content activities journal their HANDLER OUTPUT
   * under a `<id>-run` child node — the journal stays bounded by the run's
   * real outputs. 1: the legacy layout (every activity journals its return,
   * which for the folds is a full state copy) — kept only so tests can
   * produce format-1 journals and as an emergency escape hatch; it is what
   * outgrew the engine's maximum string length on real runs.
   */
  readonly journalFormat?: 1 | 2;
  /**
   * Panel members the submitter dismissed mid-run (see dismissal.ts). Held for
   * the whole process and re-supplied on every resume, so the guards decide
   * identically on every replay.
   */
  readonly dismissedMembers?: readonly string[];
}

export interface ResolvedRole {
  readonly role: Skill;
  readonly techniques: readonly Skill[];
}

export interface SkillResolver {
  hasRole(name: string): boolean;
  resolveRole(name: string): Promise<ResolvedRole>;
}

class BundleSkillResolver implements SkillResolver {
  constructor(private readonly bundle: ContentBundle) {}

  hasRole(name: string): boolean {
    return this.bundle.skills[name]?.meta.kind === "role";
  }

  async resolveRole(name: string): Promise<ResolvedRole> {
    const role = this.bundle.skills[name];
    if (!role || role.meta.kind !== "role") {
      throw new WorkflowConfigError(`content bundle has no role "${name}"`);
    }
    return {
      role,
      techniques: role.meta.techniques.map((techniqueName) => {
        const technique = this.bundle.skills[techniqueName];
        if (!technique || technique.meta.kind !== "technique") {
          throw new WorkflowConfigError(
            `role "${name}" references missing technique "${techniqueName}"`,
          );
        }
        return technique;
      }),
    };
  }
}

export interface CompiledContentWorkflow {
  readonly content: ContentWorkflowDefinition;
  readonly definition: WorkflowDefinition;
  readonly functions: WorkflowFunctions;
  createInput(
    submission: JsonValue,
    params?: Readonly<Record<string, JsonValue>>,
  ): JsonObject;
  /**
   * True when the agent node compiled under `nodeId` belongs to a dismissed
   * seat — either it works ON one or it IS one. The runner consults this
   * through an override of the `agent` node executor (see runtime.ts), which is
   * how a dismissed seat's remaining model calls are skipped without moving a
   * single journal key. Absent when nothing is dismissed.
   */
  readonly isAgentDismissed?: (nodeId: string, scope: ScopeReader) => boolean;
}

const STATE_SELECTOR = "brainstorm.runtime.state";
const SNAPSHOT_ACTIVITY = "brainstorm.runtime.snapshot";

function asObject(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrainstormRuntimeError(`${label} must be an object`, "INVALID_RUNTIME_STATE");
  }
  return value as JsonObject;
}

function stateFrom(scope: ScopeReader): JsonObject {
  return asObject(scope.get(BRAINSTORM_STATE), BRAINSTORM_STATE);
}

/**
 * The member's idea as it currently stands — the version a patch revises.
 *
 * Carried on the task so the executor's validator can check the merged whole
 * while a retry is still possible. Resolved leniently: a task the reference
 * cannot be resolved for simply carries no base, and the rules it would have
 * checked are enforced when the revision is recorded, exactly as before.
 */
function revisionBaseFor(scope: ScopeReader): { revisionBase?: JsonValue } {
  const idea = resolveDataReference("ideas[member.id]", scope, stateFrom(scope), {
    required: false,
  });
  return typeof idea === "object" && idea !== null && !Array.isArray(idea)
    ? { revisionBase: idea }
    : {};
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function resolveBindings(
  bindings: Readonly<Record<string, BindValue>> | undefined,
  scope: ScopeReader,
  roots: ReferenceRoots,
  dismissal?: DismissalPolicy | undefined,
): JsonObject {
  const state = stateFrom(scope);
  const output: Record<string, JsonValue> = {};
  for (const [name, binding] of Object.entries(bindings ?? {})) {
    const value = resolveBindValue(binding, scope, state, roots);
    output[name] = dismissal === undefined ? value : dismissal.strip(value);
  }
  return output;
}

function evaluateCondition(
  expression: ConditionExpr,
  scope: ScopeReader,
  roots: ReferenceRoots,
): boolean {
  if ("all" in expression) {
    return expression.all.every((entry) => evaluateCondition(entry, scope, roots));
  }
  if ("any" in expression) {
    return expression.any.some((entry) => evaluateCondition(entry, scope, roots));
  }
  if ("not" in expression) return !evaluateCondition(expression.not, scope, roots);
  const actual = resolveDataReference(expression.ref, scope, stateFrom(scope), {
    required: false,
    roots,
  });
  if ("equals" in expression) return actual === expression.equals;
  return actual !== expression.notEquals;
}

function artifactRefValue(ref: ArtifactRef): JsonObject {
  return {
    id: ref.id,
    name: ref.name,
    size: ref.size,
    ...(ref.contentType !== undefined ? { contentType: ref.contentType } : {}),
    ...(ref.metadata !== undefined ? { metadata: ref.metadata } : {}),
  };
}

async function persistArtifact(
  state: JsonObject,
  path: string,
  schemaName: string,
  nodeId: string,
  value: JsonValue,
  context: FunctionContext,
): Promise<JsonObject> {
  if (!context.artifacts) return state;
  const ref = await context.artifacts.put({
    name: `${context.runId}/${path}.json`,
    data: JSON.stringify(value),
    contentType: "application/json",
    metadata: { nodeId, schema: schemaName, path },
  });
  const runtime = asObject(state._runtime, "_runtime");
  const artifacts = asObject(runtime.artifacts, "_runtime.artifacts");
  const history = artifacts[path];
  const refs = Array.isArray(history) ? history : [];
  return {
    ...state,
    _runtime: {
      ...runtime,
      artifacts: {
        ...artifacts,
        [path]: [...refs, artifactRefValue(ref)],
      },
    },
  };
}

/** Whether `type` names a key of the run's loaded input-type catalog. */
function isCatalogType(
  type: JsonValue | undefined,
  scope: ScopeReader,
  state: JsonObject,
  roots: ReferenceRoots,
): type is string {
  if (typeof type !== "string") return false;
  const knownTypes = resolveDataReference("bundle.inputTypes.types", scope, state, {
    required: true,
    roots,
  });
  return (
    typeof knownTypes === "object" &&
    knownTypes !== null &&
    !Array.isArray(knownTypes) &&
    Object.prototype.hasOwnProperty.call(knownTypes, type)
  );
}

/**
 * The run-level contract a developed output must satisfy, beyond its schema:
 * the type it echoes, the shape the catalog maps that type to, and the
 * requested-output sections the run recorded. Checked on the FINISHED
 * envelope — the first pass's, a full re-emission's, or the one the host
 * assembles from a revision patch — so a patched body cannot slip a wrong
 * section list past the contract the first pass had to meet.
 */
function assertDevelopedOutputFitsRun(
  developed: JsonObject,
  nodeId: string,
  scope: ScopeReader,
  state: JsonObject,
  roots: ReferenceRoots,
): void {
  // The envelope schema enforces "exactly one shape body"; the catalog owns
  // which shape that must be for the run's type, so that pairing — and the
  // type echo itself — is checked here against the loaded bundle.
  const expectedType = resolveDataReference("input.type", scope, state, { required: true });
  if (developed.type !== expectedType) {
    throw new BrainstormRuntimeError(
      `node "${nodeId}" returned output.type "${String(developed.type)}" but this run works a "${String(expectedType)}"`,
      "OUTPUT_TYPE_MISMATCH",
    );
  }
  const shape = populatedShape(developed as Parameters<typeof populatedShape>[0]);
  const expectedShape = resolveDataReference("bundle.inputTypes.shapes[input.type]", scope, state, {
    required: false,
    roots,
  });
  if (expectedShape !== undefined && shape !== expectedShape) {
    throw new BrainstormRuntimeError(
      `node "${nodeId}" produced a "${shape}" body but the catalog maps "${String(expectedType)}" to "${String(expectedShape)}"`,
      "OUTPUT_SHAPE_MISMATCH",
    );
  }
  // The submitter's explicitly requested outputs are run data: EVERY
  // member answers each recorded ask with one `requested` section, in the
  // recorded order, titles echoed verbatim — and no section list at all
  // when the run recorded none. The task schema is narrowed the same way;
  // this is the authoritative re-check on write.
  const asks = requestedOutputsOf(
    resolveDataReference("input", scope, state, { required: false }),
  );
  const sections = developed.requested;
  if (asks.length === 0) {
    if (sections !== undefined) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" returned requested-output sections, but this run recorded no requested outputs`,
        "REQUESTED_SECTION_MISMATCH",
      );
    }
    return;
  }
  const titles = (Array.isArray(sections) ? sections : []).map((entry) =>
    isJsonRecord(entry) ? entry.title : undefined,
  );
  const expected = asks.map((entry) => entry.title);
  if (
    titles.length !== expected.length ||
    titles.some((title, index) => title !== expected[index])
  ) {
    throw new BrainstormRuntimeError(
      `node "${nodeId}" must answer exactly the ${expected.length} requested output(s) of this run, in order: ${expected.join(" | ")}`,
      "REQUESTED_SECTION_MISMATCH",
    );
  }
}

async function writeValidatedOutput(
  scope: ScopeReader,
  target: string,
  schemaName: string,
  nodeId: string,
  raw: JsonValue,
  context: FunctionContext,
  roots: ReferenceRoots,
): Promise<JsonObject> {
  const state = stateFrom(scope);
  const parsed = validateArtifact(schemaName, nodeId, raw);
  if (schemaName === "processorOutput") {
    // The submission types are data (catalog/input-types.json), so the static
    // schema cannot enumerate them; membership is enforced here instead.
    // Since workflow 0.14.0 the processor no longer classifies — `type` is
    // absent on its output and merged in later (classification.apply), so the
    // check runs exactly when the field is present: pre-split processors,
    // the merge write, and the classification gate's re-write.
    const type = asObject(parsed, "processor output").type;
    if (type !== undefined && !isCatalogType(type, scope, state, roots)) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" classified the submission as "${String(type)}", which is not a type of the loaded input-type catalog`,
        "INPUT_TYPE_NOT_IN_CATALOG",
      );
    }
  }
  if (schemaName === "taskClassification") {
    // Both offered readings must be types of the loaded catalog — the primary
    // is merged into the run's input and the alternative is offered at the
    // confirmation gate, so an invented label in either would derail the run.
    const classification = asObject(parsed, "task classification");
    for (const key of ["primary", "alternative"] as const) {
      const type = asObject(classification[key], `classification ${key}`).type;
      if (!isCatalogType(type, scope, state, roots)) {
        throw new BrainstormRuntimeError(
          `node "${nodeId}" offered ${key} type "${String(type)}", which is not a type of the loaded input-type catalog`,
          "INPUT_TYPE_NOT_IN_CATALOG",
        );
      }
    }
  }
  if (
    schemaName === "brainIdea" ||
    schemaName === "brainIdeaParts" ||
    schemaName === "redevelopment"
  ) {
    assertDevelopedOutputFitsRun(
      asObject(asObject(parsed, schemaName).output, `${schemaName}.output`),
      nodeId,
      scope,
      state,
      roots,
    );
  }
  if (schemaName === "brainIdea" || schemaName === "brainIdeaParts") {
    const idea = asObject(parsed, "brain idea");
    const expected = resolveDataReference("input.cotSteps", scope, state, { required: true });
    if (!Array.isArray(idea.cot) || idea.cot.length !== expected) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" must return exactly ${String(expected)} chain steps`,
        "CHAIN_LENGTH_MISMATCH",
      );
    }
  }
  if (schemaName === "placements") {
    // The placer must decide EVERY unmatched member — including deciding
    // "undecidable" — in the given order. The failed-placer incident showed
    // what an unconstrained list invites: one placeholder decision covering
    // nothing, accepted, and every unmatched term silently dropped. The
    // task schema is narrowed the same way; this is the authoritative
    // re-check on write.
    const bound = resolveDataReference("poolMatches.unmatched", scope, state, {
      required: false,
    });
    if (Array.isArray(bound)) {
      const expected = bound.flatMap((entry) => {
        const term = (entry as { readonly term?: JsonValue }).term;
        return typeof term === "string" ? [term] : [];
      });
      const returned = (asObject(parsed, "placements").decisions as JsonValue[]).map(
        (decision) => asObject(decision, "placement decision").term,
      );
      if (
        returned.length !== expected.length ||
        returned.some((term, index) => term !== expected[index])
      ) {
        throw new BrainstormRuntimeError(
          `node "${nodeId}" must return one decision for each of the ${expected.length} unmatched member(s), in their given order` +
            (expected.length > 0 ? `: ${expected.join(" | ")}` : ""),
          "PLACEMENT_COVERAGE_MISMATCH",
        );
      }
    }
  }
  if (schemaName === "codeAnnotations") {
    // The code-file list is run data, so the static schema cannot pin the
    // paths; completeness and order are enforced against the live projection
    // here (the task schema is additionally enum-narrowed per run). One
    // annotation per code file, in the projection's order, no inventions.
    const bound = resolveDataReference("codeFiles.files", scope, state, { required: true });
    const expected = (Array.isArray(bound) ? bound : []).flatMap((entry) => {
      const path = (entry as { readonly path?: JsonValue }).path;
      return typeof path === "string" ? [path] : [];
    });
    const returned = (asObject(parsed, "code annotations").files as JsonValue[]).map(
      (entry) => (entry as { readonly path?: JsonValue }).path,
    );
    if (
      returned.length !== expected.length ||
      returned.some((path, index) => path !== expected[index])
    ) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" must annotate exactly the ${expected.length} code files it was given, in their given order`,
        "CODE_ANNOTATION_MISMATCH",
      );
    }
  }
  if (
    schemaName === "comment" ||
    schemaName === "commentParts" ||
    schemaName === "judgeDecision" ||
    schemaName === "judgeDecisionParts"
  ) {
    const verdict = asObject(parsed, schemaName).verdict;
    // The seat carries allowed verdicts as NAMES; descriptions live in the
    // bundle and are zipped in at bind time, so no verdict prose is journaled.
    const allowed = resolveDataReference("reviews[member.id].allowedVerdicts", scope, state, {
      required: true,
    });
    if (
      typeof verdict !== "string" ||
      !Array.isArray(allowed) ||
      !allowed.includes(verdict)
    ) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" returned verdict "${String(verdict)}" which is not allowed this round`,
        "VERDICT_NOT_ALLOWED",
      );
    }
    // Reviewers may target the current step or any earlier one — never a
    // step the walk has not reached. Enforced against the live walk cursor,
    // since the static schema cannot know the review position.
    const reviewedThrough = resolveDataReference("stepIndex", scope, state, { required: true });
    if (typeof reviewedThrough === "number") {
      // Where the targets sit differs by form; the rule does not. The legacy
      // comment carries ONE scalar step. Every other form carries a list —
      // the part-keyed flaws a commentor files, the issues a judge raises —
      // and each entry names its own step. An EMPTY list is a reviewer that
      // read the chain and found nothing: legal, and the loop below simply
      // does not run.
      // A part-aware judge files BOTH lists — the flaws it marks as a reviewer
      // and the issues it distils as the repair signal — so both are checked.
      // Guarding only `issues` left the judge the one seat that could name a
      // step the walk has not reached and have nothing say so.
      const fields: readonly string[] | undefined =
        schemaName === "comment"
          ? undefined
          : schemaName === "commentParts"
            ? ["flaws"]
            : schemaName === "judgeDecisionParts"
              ? ["flaws", "issues"]
              : ["issues"];
      const targets: JsonValue[] =
        fields === undefined
          ? [asObject(parsed, schemaName).step ?? null]
          : fields.flatMap((field) => {
              const entries = asObject(parsed, schemaName)[field];
              const label = field === "issues" ? "judge issue" : "reviewer flaw";
              return (Array.isArray(entries) ? entries : []).map(
                (entry) => asObject(entry, label).step ?? null,
              );
            });
      for (const target of targets) {
        if (typeof target !== "number" || target < 1 || target > reviewedThrough) {
          throw new BrainstormRuntimeError(
            `node "${nodeId}" targeted step ${String(target)}, but the review has only reached step ${reviewedThrough}`,
            "STEP_TARGET_OUT_OF_RANGE",
          );
        }
      }
    }
  }
  if (schemaName === "bridgeReport") {
    // Panel membership is run data, so the static schema cannot enumerate the
    // member ids; the audit is pinned to the seated panel here instead.
    const members = resolveDataReference("panel.members", scope, state, { required: true });
    const seated = new Set(
      (Array.isArray(members) ? members : []).flatMap((member) => {
        const id = (member as { readonly id?: JsonValue }).id;
        return typeof id === "string" ? [id] : [];
      }),
    );
    const audits = asObject(parsed, "bridge report").noveltyAudit;
    for (const entry of Array.isArray(audits) ? audits : []) {
      const memberId = (entry as { readonly memberId?: JsonValue }).memberId;
      if (typeof memberId !== "string" || !seated.has(memberId)) {
        throw new BrainstormRuntimeError(
          `node "${nodeId}" audited "${String(memberId)}", which is not a seated panel member`,
          "AUDIT_MEMBER_NOT_SEATED",
        );
      }
    }
  }
  const stored =
    schemaName === "experts"
      ? canonicalizeExpertsTree(parsed)
      : schemaName === "commentParts" || schemaName === "judgeDecisionParts"
        ? pruneEmptyFlaws(parsed)
        : parsed;
  const write = writeDataReference(state, target, stored, scope, roots);
  let next = write.state;
  if (
    schemaName === "redevelopment" ||
    schemaName === "redevelopmentPatch" ||
    schemaName === "redevelopmentPatchParts"
  ) {
    next = applyRedevelopment(
      next,
      scope,
      parsed,
      nodeId,
      schemaName === "redevelopmentPatchParts"
        ? "patchParts"
        : schemaName === "redevelopmentPatch"
          ? "patch"
          : "full",
    );
    // Persist the member's UPDATED idea as its own artifact version under the
    // member's idea path (the same path the first pass wrote). The artifact
    // history then reads first pass -> revision 1 -> revision 2 -> …, so the
    // LAST entry under `ideas.<memberId>` is always the member's current —
    // and, once its review walk completes, final — reviewed output, ready
    // for the dashboard and the session's readable final-output copies.
    const memberId = resolveDataReference("member.id", scope, next, { required: true });
    const revised = resolveDataReference("ideas[member.id]", scope, next, { required: true });
    // The revised idea is journaled in the chain form the run itself writes:
    // a four-part patch folds back into a four-part idea, and validating it
    // as the string form would reject the very shape the run produced.
    const ideaSchema =
      schemaName === "redevelopmentPatchParts" ? "brainIdeaParts" : "brainIdea";
    const revisedIdea = validateArtifact(ideaSchema, nodeId, revised!);
    if (
      schemaName === "redevelopmentPatch" ||
      schemaName === "redevelopmentPatchParts"
    ) {
      // A patch carries no type and no shape key of its own, so the run-level
      // contract is checked here, on the envelope the host assembled.
      assertDevelopedOutputFitsRun(
        asObject(asObject(revisedIdea, "revised idea").output, "revised idea output"),
        nodeId,
        scope,
        next,
        roots,
      );
    }
    next = await persistArtifact(
      next,
      `ideas.${String(memberId)}`,
      ideaSchema,
      nodeId,
      revisedIdea,
      context,
    );
  }
  return persistArtifact(next, write.path, schemaName, nodeId, stored, context);
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strips the voids out of a part-keyed flaw list, on write.
 *
 * A reviewer receives its flaws as a DRAFT: one entry per step it has been
 * shown, every part key present and empty, so it fills boxes instead of
 * inventing structure. What comes back therefore carries a box for every
 * part the reviewer had nothing to say about, and those boxes would ride
 * into the judge's payload, the ledger and the dashboard as if they were
 * findings.
 *
 * This removes voids, never a claim, and it is therefore normalisation
 * rather than a decision: an entry keeps every part that says something, an
 * entry that says nothing at all is dropped, and the comment or decision
 * object ITSELF is never dropped — a reviewer that read the chain and found
 * nothing is recorded with `flaws: []`, which is a finding the judge must
 * see. Running it twice changes nothing, so a replayed journal rebuilds the
 * same bytes.
 */
function pruneEmptyFlaws(parsed: JsonValue): JsonValue {
  if (!isJsonRecord(parsed) || !Array.isArray(parsed.flaws)) return parsed;
  const parts: readonly string[] = CHAIN_PARTS;
  const flaws = parsed.flaws.flatMap((entry) => {
    if (!isJsonRecord(entry)) return [entry];
    const kept: Record<string, JsonValue> = {};
    let claims = 0;
    for (const [key, value] of Object.entries(entry)) {
      if (parts.includes(key)) {
        if (typeof value !== "string" || value.trim().length === 0) continue;
        claims += 1;
      }
      kept[key] = value;
    }
    return claims === 0 ? [] : [kept as JsonValue];
  });
  return { ...parsed, flaws };
}

/**
 * The run's explicitly requested outputs, read from the structured input
 * (the processor's `requestedOutputs`). Empty for runs whose submission
 * asked for nothing beyond the standard deliverable and for artifacts from
 * bundles that predate the field — both mean "no extra sections".
 */
function requestedOutputsOf(
  value: JsonValue | undefined,
): readonly { readonly title: string; readonly ask: string }[] {
  if (!isJsonRecord(value) || !Array.isArray(value.requestedOutputs)) return [];
  return value.requestedOutputs.flatMap((entry) => {
    if (!isJsonRecord(entry)) return [];
    const { title, ask } = entry;
    return typeof title === "string" && title.length > 0 && typeof ask === "string"
      ? [{ title, ask }]
      : [];
  });
}

/** FNV-1a 32-bit hash of a seed string (stable across processes and runs). */
function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: tiny deterministic PRNG over a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * The record with its key insertion order deterministically permuted by the
 * seed (Fisher–Yates over a seeded PRNG). Every key survives with its value
 * untouched; records with fewer than two keys are returned as-is. Used to
 * decouple the order in which the judge reads the round's comments from
 * panel seating order (LLM judges carry position bias), while staying a pure
 * function of the seed so a resumed or retried task rebuilds byte-identical.
 */
export function shuffleKeyOrder(record: JsonObject, seedText: string): JsonObject {
  const keys = Object.keys(record);
  if (keys.length < 2) return record;
  const random = mulberry32(hashSeed(seedText));
  for (let index = keys.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [keys[index], keys[swap]] = [keys[swap]!, keys[index]!];
  }
  const shuffled: Record<string, JsonValue> = {};
  for (const key of keys) shuffled[key] = record[key]!;
  return shuffled;
}

/**
 * Canonical form for the expertise tree, applied by the orchestrator on write
 * rather than trusted to the model, because both operations are computable:
 *
 * - every umbrella with no subfield gains the catch-all leaf
 *   "various topics under <umbrella>" with count 1, so every umbrella has a
 *   subfield sum to score with and every seat has a focus to state;
 * - every level sorts by the pool builder's input-topic `relevance` when the
 *   entries carry one (descending), ties by count; trees without relevance
 *   (older bundle versions) keep the pure count order — departments by k,
 *   umbrellas by j, subfields by i — descending, remaining ties keeping the
 *   order the producer emitted.
 */
function canonicalizeExpertsTree(tree: JsonValue): JsonValue {
  if (!isJsonRecord(tree) || !Array.isArray(tree.departments)) return tree;
  const count = (entry: JsonValue): number =>
    isJsonRecord(entry) && typeof entry.count === "number" ? entry.count : 0;
  const relevance = (entry: JsonValue): number =>
    isJsonRecord(entry) && typeof entry.relevance === "number" ? entry.relevance : 0;
  /** Stable descending sort: Array.prototype.sort is stable, so ties hold. */
  const byRelevanceThenCount = <T extends JsonValue>(entries: readonly T[]): T[] =>
    [...entries].sort(
      (left, right) =>
        relevance(right) - relevance(left) || count(right) - count(left),
    );

  const departments = tree.departments.map((department) => {
    if (!isJsonRecord(department) || !Array.isArray(department.umbrellas)) {
      return department;
    }
    const umbrellas = byRelevanceThenCount(department.umbrellas).map((umbrella) => {
      if (!isJsonRecord(umbrella) || !Array.isArray(umbrella.subfields)) {
        return umbrella;
      }
      const subfields =
        umbrella.subfields.length > 0
          ? byRelevanceThenCount(umbrella.subfields)
          : [{ name: `various topics under ${String(umbrella.name)}`, count: 1 }];
      return { ...umbrella, subfields };
    });
    return { ...department, umbrellas };
  });
  return {
    ...tree,
    departments: byRelevanceThenCount(departments),
  };
}

/**
 * Returns a clone of a JSON schema with the object property at
 * `properties.<path[0]>.properties.<path[1]>…` replaced by `patch`'s result,
 * or undefined when the path does not lead through object schemas. Used to
 * narrow per-task what the static artifact schema must leave open (allowed
 * verdicts per review round, the submission-type label per run).
 */
/**
 * Asserts that a schema pin actually applied.
 *
 * These narrowings are what stop a constrained model from emitting a verdict it
 * was not offered, a step the review has not reached, or a requested section
 * that was never asked for. When a patch silently fails to apply, the model is
 * handed an UNCONSTRAINED schema and the violation only surfaces later as a
 * failed run — or, worse, not at all, because the executor's retry validator
 * derives its own rules from this same delivered schema and quietly checks
 * nothing when the pin is missing. A patch that does not apply is a content or
 * schema bug, not a runtime data condition, so it fails loudly here.
 */
function pinned(
  patched: JsonObject | undefined,
  nodeId: string,
  what: string,
): JsonObject {
  if (patched === undefined) {
    throw new WorkflowConfigError(
      `node "${nodeId}" could not pin ${what} into its task schema; the artifact schema shape changed and the model would be left unconstrained`,
    );
  }
  return patched;
}

function patchSchemaProperty(
  schema: JsonObject,
  path: readonly string[],
  patch: (property: JsonObject) => JsonObject,
): JsonObject | undefined {
  const cloned = structuredClone(schema);
  let owner: JsonObject = cloned;
  for (let index = 0; index < path.length; index += 1) {
    const properties = owner.properties;
    if (!isJsonRecord(properties)) return undefined;
    const property = properties[path[index]!];
    if (!isJsonRecord(property)) return undefined;
    if (index === path.length - 1) {
      (properties as Record<string, JsonValue>)[path[index]!] = patch(property);
      return cloned;
    }
    owner = property;
  }
  return undefined;
}

/**
 * Returns a clone of a JSON schema with a property of an ARRAY property's
 * item schema replaced by `patch`'s result (properties.<array>.items
 * .properties.<name>), or undefined when the path does not have that shape.
 * Used to narrow per-task bounds inside array entries (the step targets of
 * the judge's issues).
 */
function patchArrayItemProperty(
  schema: JsonObject,
  arrayName: string,
  propertyName: string,
  patch: (property: JsonObject) => JsonObject,
): JsonObject | undefined {
  const cloned = structuredClone(schema);
  const properties = cloned.properties;
  if (!isJsonRecord(properties)) return undefined;
  const arrayProperty = properties[arrayName];
  if (!isJsonRecord(arrayProperty)) return undefined;
  const items = arrayProperty.items;
  if (!isJsonRecord(items)) return undefined;
  const itemProperties = items.properties;
  if (!isJsonRecord(itemProperties)) return undefined;
  const property = itemProperties[propertyName];
  if (!isJsonRecord(property)) return undefined;
  (itemProperties as Record<string, JsonValue>)[propertyName] = patch(property);
  return cloned;
}

/**
 * Returns a clone of an object JSON schema with the named top-level
 * properties removed from `properties` and `required`. Used for stepwise
 * agent tasks: fields the runtime assembles from submit_step tool calls must
 * not be demanded from (or offered to) the constrained model output.
 */
function removeSchemaProperties(
  schema: JsonObject,
  names: readonly string[],
): JsonObject {
  const cloned = structuredClone(schema) as Record<string, JsonValue>;
  const properties = cloned.properties;
  if (isJsonRecord(properties)) {
    for (const name of names) {
      delete (properties as Record<string, JsonValue>)[name];
    }
  }
  const required = cloned.required;
  if (Array.isArray(required)) {
    cloned.required = required.filter(
      (entry) => typeof entry !== "string" || !names.includes(entry),
    );
  }
  return cloned;
}

/**
 * The stepwise-delivery contract for chain-producing nodes: the model
 * submits each chain step through the submit_step tool and the executor
 * assembles the reviewed chain (plus any literal fields) into the artifact
 * before validation. Derived from the node's output schema and bindings.
 *
 * The step PAYLOAD differs between the chain forms — `{ index, text }` for a
 * string chain, `{ index, part1..part4 }` for a four-part one — so the spec
 * DECLARES which, in `parts`.
 *
 * It has to be declared rather than inferred. The natural witness is the
 * delivered schema's own step item, but `removed` strips the stepwise field
 * out of that schema a few lines below — the model must not be asked for a
 * field these tool calls are what fills — so by the time a task is built the
 * item is gone. What was left to read was the artifact schema's NAME, and a
 * naming convention is a silent contract: a later four-part form called
 * anything but `…Parts` would have compiled, run, and transported its steps
 * as strings with nothing to say so. The compiler knows the answer here,
 * because it is the code that chose the schema, so it states it.
 *
 * Read off the TASK, never off the app version, so a pinned run transports
 * exactly the chain form its own bundle compiled.
 */
function stepwiseContract(
  schemaName: string,
  bindings: JsonObject,
): { readonly spec: JsonObject; readonly removed: readonly string[] } | undefined {
  if (schemaName === "brainIdea" || schemaName === "brainIdeaParts") {
    const count = bindings.cotSteps;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
      return undefined;
    }
    return {
      spec: {
        tool: "submit_step",
        field: "cot",
        count,
        parts: schemaName === "brainIdeaParts",
      },
      removed: ["cot"],
    };
  }
  if (
    schemaName === "redevelopment" ||
    schemaName === "redevelopmentPatch" ||
    schemaName === "redevelopmentPatchParts"
  ) {
    // Full emission: the reviser re-emits the COMPLETE chain (touched steps
    // rewritten, untouched copied verbatim). Patch: only the rewritten steps,
    // and the host carries the rest. Either way the runtime — never the
    // model — computes the change-set, so nothing self-reports its own edits.
    const totalSteps = bindings.totalSteps;
    if (
      typeof totalSteps !== "number" ||
      !Number.isSafeInteger(totalSteps) ||
      totalSteps < 1
    ) {
      return undefined;
    }
    return {
      spec: {
        tool: "submit_step",
        field: "steps",
        count: totalSteps,
        parts: schemaName === "redevelopmentPatchParts",
        ...(schemaName === "redevelopment" ? {} : { sparse: true }),
      },
      removed: ["steps"],
    };
  }
  return undefined;
}

/**
 * The review forms, legacy and four-part. Which one a node writes is the
 * bundle's choice through `output.schema`; the narrowings below are
 * properties of the REVIEW POSITION — this round's allowed verdicts, the
 * step the walk has reached — and so apply to every form alike. Listing the
 * names rather than sniffing the schema keeps a pinned run reading exactly
 * the path its own bundle was compiled against.
 */
const REVIEW_SCHEMAS: ReadonlySet<string> = new Set([
  "comment",
  "commentParts",
  "judgeDecision",
  "judgeDecisionParts",
]);

/** The forms that carry a full developed output envelope. */
const DEVELOPED_SCHEMAS: ReadonlySet<string> = new Set([
  "brainIdea",
  "brainIdeaParts",
  "redevelopment",
]);

/**
 * Longest collection a payload section is split into per-element blocks for.
 * Chains are single digits; the ceiling only keeps a pathological binding
 * from turning one section into hundreds of blocks.
 */
const MAX_SPLIT_ELEMENTS = 32;

function renderPayloadValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * One list element rendered exactly as `JSON.stringify(list, null, 2)`
 * renders it in place: pretty-printed, then every line after the first
 * pushed in by the list's own two spaces. A string never contains a raw
 * newline once stringified, so this is a no-op on the string case and a
 * pre-parts chain still splits into the identical bytes it always did.
 */
function splitElementText(element: JsonValue): string {
  return JSON.stringify(element, null, 2).replaceAll("\n", "\n  ");
}

/**
 * The chunks one payload section renders to. Every chunk carries its own
 * leading separator, so concatenating the whole turn's chunks reproduces the
 * single string this used to be, byte for byte.
 *
 * A section holding a list — the chain of thought under review — is cut at
 * its element boundaries, with each element's comma leading the NEXT chunk
 * rather than trailing its own. That placement is what makes one call's
 * chain a byte-exact prefix of the next call's: at step k the last element
 * chunk reads `,\n  <step k>`, and at step k+1 the very same bytes sit at
 * the very same offset, followed by step k+1 instead of the closing bracket.
 * A redevelopment that rewrites step j only breaks the prefix from j onward.
 *
 * A list of OBJECTS splits the same way, because a step written in four
 * parts is still one element and still grows the list one element at a time.
 * Without this the whole chain collapsed back into a single block the moment
 * a run stopped writing steps as strings, and review — where the same chain
 * is re-read once per walk position, per seat, per round — is exactly where
 * losing the split costs most. A MIXED list is left whole: elements of two
 * kinds mean the section is not a chain, and guessing at its boundaries
 * would risk the prefix property for nothing.
 */
export function payloadSectionChunks(
  entry: PayloadEntry,
  splittable: boolean,
): string[] {
  const header = `\n\n## ${entry.name}\n\n`;
  const value = entry.value;
  const elements =
    splittable &&
    Array.isArray(value) &&
    (value.every((item) => typeof item === "string") || value.every(isJsonRecord))
      ? (value as readonly JsonValue[])
      : undefined;
  if (
    elements === undefined ||
    elements.length === 0 ||
    elements.length > MAX_SPLIT_ELEMENTS
  ) {
    return [`${header}${renderPayloadValue(value)}`];
  }
  return [
    `${header}[`,
    ...elements.map(
      (element, index) => `${index === 0 ? "" : ","}\n  ${splitElementText(element)}`,
    ),
    "\n]",
  ];
}

/**
 * The task turn: what to do plus the payload the role's instructions refer to
 * by name. Keeping submission-derived data here rather than in the system
 * prompt holds it at user privilege and leaves the instructions byte-stable
 * across calls.
 *
 * The turn is emitted as content blocks rather than one string so the stable
 * spans can be declared to the provider: the leading run of payload sections
 * the workflow proves identical for the whole run (see cache-plan), and then
 * the first varying section when it is a growing list. Everything the model
 * reads is unchanged — the blocks concatenate to exactly the previous text —
 * only the billing of the repeated prefix moves.
 */
function renderTaskBlocks(
  role: string,
  schemaName: string,
  payload: readonly PayloadEntry[],
  stableVars: ReadonlySet<string>,
): ContentBlock[] {
  const head =
    `# Task\n\n` +
    `Execute the ${role} role instructions from the system prompt against the data below. ` +
    `Return only one JSON value satisfying the "${schemaName}" schema.` +
    (payload.length > 0 ? `\n\n# Task data` : "");

  let stableRun = 0;
  while (stableRun < payload.length && stableVars.has(payload[stableRun]!.name)) {
    stableRun += 1;
  }

  const chunks: string[] = [head];
  const boundaries = new Set<number>();
  payload.forEach((entry, index) => {
    // Only the first section after the stable run is worth splitting: it is
    // the one whose earlier elements repeat across calls (the chain), and the
    // provider's breakpoint budget has room for exactly one more boundary.
    const sectionChunks = payloadSectionChunks(entry, index === stableRun);
    chunks.push(...sectionChunks);
    if (index === stableRun - 1) {
      boundaries.add(chunks.length - 1);
    }
    if (index === stableRun && sectionChunks.length > 1) {
      // The last ELEMENT chunk, never the closing bracket: the bracket is the
      // one byte that differs between a chain of k steps and one of k+1.
      boundaries.add(chunks.length - 2);
    }
  });

  return chunks.map((text, index) =>
    boundaries.has(index) ? cacheBoundaryTextBlock(text) : textBlock(text),
  );
}

function concreteWorkflow(
  bundle: ContentBundle,
  requested: string | ContentWorkflowDefinition | undefined,
): ContentWorkflowDefinition {
  if (typeof requested === "object") return requested;
  const name = requested ?? "brainstorm";
  const found = bundle.workflows[name];
  if (!found) throw new WorkflowConfigError(`content bundle has no workflow "${name}"`);
  return found;
}

function partitionAnnotatedFiles(
  handler: string,
  input: JsonValue | undefined,
  keep: (label: string) => boolean,
): JsonValue {
  const processor = validateArtifact("processorOutput", handler, input!);
  const files = (processor as { readonly files?: readonly JsonValue[] }).files ?? [];
  return {
    files: files.filter(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        !Array.isArray(file) &&
        typeof (file as { readonly label?: JsonValue }).label === "string" &&
        keep((file as { readonly label: string }).label),
    ),
  };
}

/** Relation labels that mark a useful file as source code to annotate. */
const CODE_LABELS = new Set(["code", "implementation"]);

function annotatedEntries(
  handler: string,
  value: JsonValue | undefined,
): readonly JsonObject[] {
  const parsed = validateArtifact("usefulFiles", handler, value!);
  const files = (parsed as { readonly files?: readonly JsonValue[] }).files ?? [];
  return files.filter(isJsonRecord);
}

function builtinActivities(): Readonly<Record<string, DeterministicActivityHandler>> {
  return {
    "attachments.useful": (input) =>
      partitionAnnotatedFiles(
        "attachments.useful",
        input.input,
        (label) => label !== "NA",
      ),
    "attachments.ignored": (input) =>
      partitionAnnotatedFiles(
        "attachments.ignored",
        input.input,
        (label) => label === "NA",
      ),
    "attachments.code": (input) => {
      const files = annotatedEntries("attachments.code", input.files).filter(
        (file) => typeof file.label === "string" && CODE_LABELS.has(file.label),
      );
      return { count: files.length, files: files as unknown as JsonValue };
    },
    "classification.apply": (input) => {
      // Fold the classifier's primary decision into the structured input:
      // type, cotSteps, and the requested outputs (omitted when empty, the
      // same contract the processor used to follow). The confirmation gate
      // downstream may overwrite type and requestedOutputs with the human's
      // choice; everything else of the input rides through unchanged.
      const processor = asObject(
        validateArtifact("processorOutput", "classification.apply", input.input!),
        "classification.apply input",
      );
      const classification = asObject(
        validateArtifact(
          "taskClassification",
          "classification.apply",
          input.classification!,
        ),
        "classification.apply classification",
      );
      const primary = asObject(classification.primary, "classification primary");
      const requested = Array.isArray(classification.requestedOutputs)
        ? classification.requestedOutputs
        : [];
      const { requestedOutputs: _dropped, ...rest } = processor;
      return {
        ...rest,
        type: primary.type!,
        cotSteps: classification.cotSteps!,
        ...(requested.length > 0 ? { requestedOutputs: requested } : {}),
        // The finite-output bound is declared over the file map; the merge
        // never grows it, but the field must exist for the bound check.
        files: Array.isArray(processor.files) ? processor.files : [],
      };
    },
    "attachments.annotate": (input) => {
      const files = annotatedEntries("attachments.annotate", input.files);
      const annotations = validateArtifact(
        "codeAnnotations",
        "attachments.annotate",
        input.annotations!,
      );
      const known = new Set(
        files.flatMap((file) => (typeof file.path === "string" ? [file.path] : [])),
      );
      const summaryByPath = new Map<string, string>();
      const entries = (annotations as { readonly files: readonly JsonValue[] }).files;
      for (const raw of entries) {
        if (!isJsonRecord(raw)) continue;
        const { path, summary } = raw;
        if (typeof path !== "string" || typeof summary !== "string") continue;
        if (!known.has(path)) {
          throw new BrainstormRuntimeError(
            `attachments.annotate received a summary for "${path}", which is not a useful file of this run`,
            "CODE_ANNOTATION_UNKNOWN_PATH",
          );
        }
        summaryByPath.set(path, summary);
      }
      return {
        files: files.map((file) =>
          typeof file.path === "string" && summaryByPath.has(file.path)
            ? { ...file, codeSummary: summaryByPath.get(file.path)! }
            : file,
        ) as unknown as JsonValue,
      };
    },
    "panel.select": (input) => {
      const experts = validateArtifact("experts", "panel.select", input.experts!);
      const panelSize = input.panelSize;
      if (typeof panelSize !== "number") {
        throw new BrainstormRuntimeError(
          "panel.select requires a numeric panelSize",
          "INVALID_ACTIVITY_INPUT",
        );
      }
      return selectPanel(
        experts as unknown as Parameters<typeof selectPanel>[0],
        panelSize,
      ) as unknown as JsonValue;
    },
    "panel.weave": (input) => {
      const panel = validateArtifact("panel", "panel.weave", input.panel!);
      const maxSeats = input.maxSeats;
      if (typeof maxSeats !== "number") {
        throw new BrainstormRuntimeError(
          "panel.weave requires a numeric maxSeats",
          "INVALID_ACTIVITY_INPUT",
        );
      }
      return weavePanel(
        panel as unknown as Parameters<typeof weavePanel>[0],
        maxSeats,
      ) as unknown as JsonValue;
    },
  };
}

class ContentCompiler {
  readonly functions = new WorkflowFunctions();
  private readonly routeResolver: BrainstormRouteResolver;
  private readonly capabilityTools: CapabilityToolResolver;
  private readonly activityHandlers: Readonly<Record<string, DeterministicActivityHandler>>;
  private readonly gateMode: HumanGateMode;
  private readonly schemas = new Map<string, JsonObject>();
  private readonly providerOffers: readonly ProviderNativeOffer[];
  private readonly hostTools: readonly HostToolManifest[];
  private readonly enabledHostToolIds: ReadonlySet<string>;
  private readonly disabledCapabilityIds: ReadonlySet<string>;
  private readonly vacantCapabilities: ReadonlyMap<string, string>;
  private readonly skillResolver: SkillResolver;
  /** Journal layout being compiled for (see CompileContentWorkflowOptions). */
  private readonly journalFormat: 1 | 2;
  /**
   * The read-only `bundle.*` reference roots: the content projections every
   * task binds against, resolved straight out of the in-memory bundle. They
   * are deliberately NOT part of the run state, so no catalog prose — input
   * type outlines, shape guides, verdict descriptions — can reach a journaled
   * activity result or `checkpoint.input`, and nothing can write through them.
   */
  private readonly roots: ReferenceRoots;
  /**
   * Per agent node, the bind names this workflow proves identical across
   * every call of the run — the task turn's cacheable prefix.
   */
  private readonly cachePlan: TaskCachePlan;
  /**
   * Mid-run seat dismissal, or undefined when nothing is dismissed — in which
   * case every guard below compiles away and the run behaves exactly as it did
   * before the feature existed.
   */
  private readonly dismissal: DismissalPolicy | undefined;
  /**
   * The enclosing loop item variables at the point currently being compiled
   * (`member`, then `cotStep`, then `commentor`, …). A dismissal guard asks
   * about exactly these, so it reads the identities the CONTENT declared
   * instead of guessing at variable names.
   */
  private readonly loopVars: string[] = [];
  /** Enclosing loop vars per compiled agent node id, for the executor override. */
  private readonly agentLoopVars = new Map<string, readonly string[]>();

  constructor(
    private readonly bundle: ContentBundle,
    private readonly content: ContentWorkflowDefinition,
    options: CompileContentWorkflowOptions,
  ) {
    this.routeResolver = options.routeResolver ?? new ExecutorOwnedRouteResolver();
    this.capabilityTools = options.capabilityTools ?? new LogicalCapabilityToolResolver();
    this.activityHandlers = { ...builtinActivities(), ...(options.activities ?? {}) };
    this.providerOffers = options.providerOffers ?? [];
    this.hostTools = options.hostTools ?? [];
    this.enabledHostToolIds = options.enabledHostToolIds ?? new Set();
    this.disabledCapabilityIds = options.disabledCapabilityIds ?? new Set();
    this.vacantCapabilities = options.vacantCapabilities ?? new Map();
    this.skillResolver =
      options.skillResolver ?? new BundleSkillResolver(this.bundle);
    this.journalFormat = options.journalFormat ?? 2;
    this.gateMode = options.humanGateMode ?? "manual";
    this.roots = {
      bundle: {
        inputTypes: structuredClone(this.bundle.catalogs.inputTypes) as unknown as JsonObject,
        verdicts: structuredClone(this.bundle.catalogs.verdicts) as unknown as JsonObject,
        departments: structuredClone(this.bundle.catalogs.departments) as unknown as JsonObject,
      },
    };
    this.cachePlan = planTaskCaches(this.content);
    this.dismissal = createDismissalPolicy(options.dismissedMembers);
    this.functions
      .registerSelector(STATE_SELECTOR, (scope) => scope.get(BRAINSTORM_STATE))
      .registerActivity(SNAPSHOT_ACTIVITY, (_input, scope) => scope.get(BRAINSTORM_STATE));
  }

  compile(): CompiledContentWorkflow {
    const root = this.compileNode(this.content.root);
    return {
      content: this.content,
      definition: workflow(this.content.name, root, {
        version: this.content.version,
        description: this.content.description,
      }),
      functions: this.functions,
      createInput: (submission, params = {}) => ({
        [BRAINSTORM_STATE]: createInitialState(this.content, submission, params),
      }),
      ...(this.dismissal !== undefined
        ? {
            isAgentDismissed: (nodeId: string, scope: ScopeReader) =>
              this.dismissedHere(scope, this.agentLoopVars.get(nodeId) ?? []),
          }
        : {}),
    };
  }

  /**
   * The one question every dismissal guard asks: does this scope belong to a
   * dismissed seat? `vars` are the enclosing loop item variables captured when
   * the guarded node was compiled.
   */
  private dismissedHere(scope: ScopeReader, vars: readonly string[]): boolean {
    return this.dismissal?.taints(scope, vars) ?? false;
  }

  /** Compiles `body` with `itemVar` added to the enclosing loop variables. */
  private withLoopVar(itemVar: string, compileBody: () => WorkflowNode): WorkflowNode {
    this.loopVars.push(itemVar);
    try {
      return compileBody();
    } finally {
      this.loopVars.pop();
    }
  }

  private functionName(nodeId: string, purpose: string): string {
    return `brainstorm.${this.content.name}.${nodeId}.${purpose}`;
  }

  private temp(nodeId: string, purpose: string): string {
    return `__brainstorm:${nodeId}:${purpose}`;
  }

  /**
   * Node options for a deterministic state fold. Format 2 marks the node
   * non-journaled (re-run on every pass, so no state copy ever reaches the
   * journal); format 1 keeps the legacy journal-everything behavior.
   */
  private foldOptions(): { journal?: boolean } {
    return this.journalFormat === 1 ? {} : { journal: false };
  }

  private jsonSchema(name: string): JsonObject {
    const cached = this.schemas.get(name);
    if (cached) return cached;
    const schema = (artifactSchemas as Readonly<Record<string, unknown>>)[name];
    if (!schema) throw new WorkflowConfigError(`unknown artifact schema "${name}"`);
    const converted = artifactSchemaToJsonSchema(schema, name);
    this.schemas.set(name, converted);
    return converted;
  }

  private compileNode(node: ContentWorkflowNode): WorkflowNode {
    switch (node.kind) {
      case "sequence":
        return sequence(node.steps.map((step) => this.compileNode(step)), {
          id: node.id,
          description: node.notes,
        });
      case "agent":
        return this.compileAgent(node);
      case "activity":
        return this.compileActivity(node);
      case "forEach":
        return this.compileForEach(node);
      case "repeatUntil":
        return this.compileRepeatUntil(node);
      case "condition":
        return this.compileCondition(node);
      case "humanGate":
        return this.compileHumanGate(node);
      case "terminal":
        return this.compileTerminal(node);
    }
  }

  private compileAgent(node: ContentAgentNode): WorkflowNode {
    const builderName = this.functionName(node.id, "task");
    const applyName = this.functionName(node.id, "apply");
    const resultKey = this.temp(node.id, "result");
    // Captured for the `agent` executor override, which skips the call itself
    // (see dismissal.ts), and for the store fold below, which must then not
    // insist on an output that was deliberately never produced.
    const enclosing = [...this.loopVars];
    this.agentLoopVars.set(`${node.id}-execute`, enclosing);
    const routeDefinition = this.bundle.routes.routes[node.route];
    if (!this.skillResolver.hasRole(node.skill) || !routeDefinition) {
      throw new WorkflowConfigError(`agent node "${node.id}" has unresolved skill or route`);
    }
    const jsonSchema = this.jsonSchema(node.output.schema);

    this.functions.registerTaskBuilder(builderName, async (scope) => {
      const { role, techniques } =
        await this.skillResolver.resolveRole(node.skill);
      const skillIssues = validateResolvedRole(
        role,
        techniques,
        this.bundle.capabilities,
      );
      if (skillIssues.length > 0) {
        throw new WorkflowConfigError(
          `role "${node.skill}" failed lazy validation: ` +
            skillIssues.map((issue) => `[${issue.code}] ${issue.message}`).join("; "),
        );
      }
      if (
        role.meta.output !== undefined &&
        role.meta.output !== node.output.schema
      ) {
        throw new WorkflowConfigError(
          `node "${node.id}" expects "${node.output.schema}" but role ` +
            `"${node.skill}" declares "${role.meta.output}"`,
        );
      }
      const declaredVars = new Set(role.meta.vars);
      const boundVars = new Set(Object.keys(node.bind ?? {}));
      const missingVars = [...declaredVars].filter((name) => !boundVars.has(name));
      const extraVars = [...boundVars].filter((name) => !declaredVars.has(name));
      if (missingVars.length > 0 || extraVars.length > 0) {
        throw new WorkflowConfigError(
          `node "${node.id}" bindings disagree with role "${node.skill}"` +
            (missingVars.length > 0 ? `; missing: ${missingVars.join(", ")}` : "") +
            (extraVars.length > 0 ? `; unexpected: ${extraVars.join(", ")}` : ""),
        );
      }
      // A dismissed seat has no role from here on: it leaves the roster the
      // panel binds, the `ideas` map the integrator and the chair read, and the
      // comment set a judge weighs. Applied to AGENT bindings only —
      // deterministic activity handlers keep their journaled inputs untouched.
      const bindings = resolveBindings(node.bind, scope, this.roots, this.dismissal);
      if (
        (node.output.schema === "judgeDecision" ||
          node.output.schema === "judgeDecisionParts") &&
        isJsonRecord(bindings.comments)
      ) {
        // The merged comments object arrives in panel seating order every
        // round; re-key it in a deterministic per-round order so the judge's
        // weighing cannot correlate with seat position. The permutation is a
        // pure function of the review coordinates (member, walk position,
        // round), so a resumed or retried run rebuilds the identical task.
        const state = stateFrom(scope);
        const member = resolveDataReference("member.id", scope, state, { required: false });
        const step = resolveDataReference("stepIndex", scope, state, { required: false });
        const round = resolveDataReference("reviews[member.id].round", scope, state, { required: false });
        (bindings as Record<string, JsonValue>).comments = shuffleKeyOrder(
          bindings.comments,
          `${String(member)}|${String(step)}|${String(round)}|${Object.keys(bindings.comments).join("|")}`,
        );
      }
      // The seat carries this round's allowed verdicts as NAMES so verdict
      // prose never enters the journaled state. Whichever name reaches a task
      // must be one the bundle actually defines — a seat offering an unknown
      // verdict is a content defect, not something to pass to a model.
      if (
        REVIEW_SCHEMAS.has(node.output.schema) &&
        Array.isArray(bindings.verdictOptions)
      ) {
        const catalog = this.bundle.catalogs.verdicts.verdicts;
        for (const name of bindings.verdictOptions) {
          if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(catalog, name)) {
            throw new WorkflowConfigError(
              `node "${node.id}" was offered verdict "${String(name)}", which the bundle's verdict catalog does not define`,
            );
          }
        }
        // Where the DESCRIPTIONS travel is the bundle's decision. A bundle
        // that binds the catalog renders it into the role's instructions,
        // which are byte-stable across the run and therefore cached: the
        // task turn then carries only this round's names. A bundle that does
        // not gets the descriptions zipped into the payload, exactly as
        // before — its skills describe `verdictOptions` as carrying them,
        // and a pinned run must read what its own bundle promised.
        if (node.bind?.verdictCatalog === undefined) {
          const zipped: Record<string, JsonValue> = {};
          for (const name of bindings.verdictOptions as string[]) {
            zipped[name] = structuredClone(catalog[name]) as unknown as JsonValue;
          }
          (bindings as Record<string, JsonValue>).verdictOptions = zipped;
        }
      }
      let taskJsonSchema = jsonSchema;
      if (REVIEW_SCHEMAS.has(node.output.schema)) {
        // The round's allowed verdicts, however this bundle carries them:
        // names alone, or names zipped with their descriptions.
        const allowed = isJsonRecord(bindings.verdictOptions)
          ? Object.keys(bindings.verdictOptions)
          : Array.isArray(bindings.verdictOptions)
            ? bindings.verdictOptions.filter(
                (name): name is string => typeof name === "string",
              )
            : [];
        if (allowed.length > 0) {
          taskJsonSchema = pinned(patchSchemaProperty(taskJsonSchema, ["verdict"], (verdict) => ({
              ...verdict,
              enum: allowed,
            })), node.id, "the allowed verdicts");
        }
      }
      // Step targets are bounded by the live walk position, which only the
      // task knows: narrow the schema maxima so a constrained model cannot
      // emit a step the review has not reached.
      if (
        REVIEW_SCHEMAS.has(node.output.schema) &&
        typeof bindings.currentStep === "number" &&
        Number.isSafeInteger(bindings.currentStep) &&
        bindings.currentStep >= 1
      ) {
        const reviewedThrough = bindings.currentStep;
        taskJsonSchema = pinned(
          node.output.schema === "comment"
            ? patchSchemaProperty(taskJsonSchema, ["step"], (step) => ({
                ...step,
                maximum: reviewedThrough,
              }))
            : patchArrayItemProperty(
                taskJsonSchema,
                // Where the steps a reviewer may name live: the legacy
                // comment says it once at the top, a four-part comment says
                // it once per flaw entry, a decision once per issue.
                node.output.schema === "commentParts" ? "flaws" : "issues",
                "step",
                (step) => ({ ...step, maximum: reviewedThrough }),
              ),
          node.id,
          "the reviewed step bound",
        );
      }
      // The submission types are catalog data, so the static artifact schemas
      // leave `type` as an open string; each task narrows it to what is
      // actually legal for THIS run, so a schema-constrained model cannot
      // write the shape id (or any other invention) into the label field.
      // The run's shape body becomes required, and the eight OTHER shape
      // bodies are REMOVED from the task schema entirely: the strict
      // envelope already forbids populating them, so all they did was ride
      // the wire as ~2k tokens of dead schema on EVERY model turn of every
      // first-pass and redevelopment task. Removal also closes the last
      // constrained-decoding escape (additionalProperties is false, so an
      // absent property cannot be emitted at all). The full envelope still
      // validates the artifact on write, so nothing observable changes.
      if (
        DEVELOPED_SCHEMAS.has(node.output.schema) &&
        typeof bindings.type === "string" &&
        bindings.type.length > 0
      ) {
        const label = bindings.type;
        const shape = typeof bindings.shape === "string" ? bindings.shape : undefined;
        taskJsonSchema = pinned(patchSchemaProperty(taskJsonSchema, ["output"], (output) => {
            const envelope =
              patchSchemaProperty(output, ["type"], (type) => ({ ...type, enum: [label] })) ??
              output;
            const required = Array.isArray(envelope.required) ? envelope.required : [];
            const withShape: JsonObject =
              shape !== undefined && !required.includes(shape)
                ? { ...envelope, required: [...required, shape] }
                : envelope;
            const properties = isJsonRecord(withShape.properties)
              ? withShape.properties
              : undefined;
            // Slim only when the bound shape is a real declared body — an
            // unknown or missing shape keeps the full envelope, and the
            // write-time cross-check fails the task instead of this patch.
            if (
              shape === undefined ||
              properties === undefined ||
              !isJsonRecord(properties[shape])
            ) {
              return withShape;
            }
            const unusedShapes = new Set<string>(
              OUTPUT_SHAPES.filter((candidate) => candidate !== shape),
            );
            const slimmed: Record<string, JsonValue> = {};
            for (const [key, value] of Object.entries(properties)) {
              if (!unusedShapes.has(key)) slimmed[key] = value;
            }
            return { ...withShape, properties: slimmed };
          }), node.id, "the output type label");
      }
      // The submitter's explicitly requested outputs are run data the static
      // envelope leaves optional. When the run recorded any, the section
      // list becomes required with the entry count pinned and the titles
      // enum-narrowed in the recorded order, so a schema-constrained model
      // cannot skip, reorder, or invent a section; when the run recorded
      // none, the property is removed entirely so it cannot be emitted at
      // all. Presence and order are re-checked on write either way.
      if (DEVELOPED_SCHEMAS.has(node.output.schema)) {
        const asks = requestedOutputsOf(bindings.input);
        taskJsonSchema = pinned(patchSchemaProperty(taskJsonSchema, ["output"], (output) => {
            const properties = isJsonRecord(output.properties) ? output.properties : {};
            const required = (Array.isArray(output.required) ? output.required : []).filter(
              (entry): entry is string => typeof entry === "string",
            );
            if (asks.length === 0) {
              const { requested: _requested, ...rest } = properties as Record<string, JsonValue>;
              return {
                ...output,
                properties: rest,
                required: required.filter((entry) => entry !== "requested"),
              };
            }
            const requestedProperty = isJsonRecord(properties.requested)
              ? properties.requested
              : {};
            const items = isJsonRecord(requestedProperty.items) ? requestedProperty.items : {};
            const itemProperties = isJsonRecord(items.properties) ? items.properties : {};
            const titleProperty = isJsonRecord(itemProperties.title) ? itemProperties.title : {};
            return {
              ...output,
              properties: {
                ...properties,
                requested: {
                  ...requestedProperty,
                  minItems: asks.length,
                  maxItems: asks.length,
                  items: {
                    ...items,
                    properties: {
                      ...itemProperties,
                      title: { ...titleProperty, enum: asks.map((ask) => ask.title) },
                    },
                  },
                },
              },
              required: required.includes("requested") ? required : [...required, "requested"],
            };
          }), node.id, "the required shape body");
      }
      // A revision patch names sections of ONE shape body, so the other eight
      // partial bodies are removed from its task schema the same way the full
      // envelope's are — they are pure dead weight on every model turn. The
      // patch's `requested` stays OPTIONAL (omitting it carries the previous
      // sections), but when the run recorded asks and the reviser does supply
      // the list, it must be the run's list in the run's order.
      if (
        node.output.schema === "redevelopmentPatch" ||
        node.output.schema === "redevelopmentPatchParts"
      ) {
        const shape = typeof bindings.shape === "string" ? bindings.shape : undefined;
        const asks = requestedOutputsOf(bindings.input);
        taskJsonSchema = pinned(
          patchSchemaProperty(taskJsonSchema, ["outputPatch"], (patch) => {
            const properties = isJsonRecord(patch.properties) ? patch.properties : undefined;
            if (properties === undefined) return patch;
            const unusedShapes = new Set<string>(
              OUTPUT_SHAPES.filter((candidate) => candidate !== shape),
            );
            const slimmed: Record<string, JsonValue> = {};
            for (const [key, value] of Object.entries(properties)) {
              if (unusedShapes.has(key)) continue;
              if (key === "requested" && asks.length === 0) continue;
              slimmed[key] = value;
            }
            if (asks.length > 0 && isJsonRecord(slimmed.requested)) {
              const requestedProperty = slimmed.requested;
              const items = isJsonRecord(requestedProperty.items) ? requestedProperty.items : {};
              const itemProperties = isJsonRecord(items.properties) ? items.properties : {};
              const titleProperty = isJsonRecord(itemProperties.title) ? itemProperties.title : {};
              slimmed.requested = {
                ...requestedProperty,
                minItems: asks.length,
                maxItems: asks.length,
                items: {
                  ...items,
                  properties: {
                    ...itemProperties,
                    title: { ...titleProperty, enum: asks.map((ask) => ask.title) },
                  },
                },
              };
            }
            return { ...patch, properties: slimmed };
          }),
          node.id,
          "the revision patch's shape body",
        );
      }
      if (
        node.output.schema === "processorOutput" &&
        isJsonRecord(bindings.typeOptions) &&
        Object.keys(bindings.typeOptions).length > 0
      ) {
        const labels = Object.keys(bindings.typeOptions);
        taskJsonSchema = pinned(patchSchemaProperty(taskJsonSchema, ["type"], (type) => ({
            ...type,
            enum: labels,
          })), node.id, "the requested output sections");
      }
      // The processor never classifies: its task schema drops the
      // classification fields entirely so the model cannot emit them. The
      // dedicated classifier stage decides them and the deterministic merge
      // writes them into the input.
      if (node.output.schema === "processorOutput") {
        taskJsonSchema = removeSchemaProperties(taskJsonSchema, [
          "type",
          "cotSteps",
          "requestedOutputs",
        ]);
      }
      // The classifier's two offered readings are pinned to the loaded
      // catalog's type keys, so a schema-constrained model cannot invent a
      // label; membership is re-checked on write either way.
      if (
        node.output.schema === "taskClassification" &&
        isJsonRecord(bindings.typeOptions) &&
        Object.keys(bindings.typeOptions).length > 0
      ) {
        const labels = Object.keys(bindings.typeOptions);
        for (const option of ["primary", "alternative"] as const) {
          taskJsonSchema = pinned(patchSchemaProperty(taskJsonSchema, [option, "type"], (type) => ({
              ...type,
              enum: labels,
            })), node.id, "the processor type options");
        }
      }
      // The placer must cover exactly the unmatched members it was given:
      // the decision count is pinned and the term field is narrowed to the
      // given terms, so a schema-constrained model cannot skip a member,
      // invent one, or answer with a placeholder list. Completeness and
      // order are re-checked on write.
      if (node.output.schema === "placements" && Array.isArray(bindings.unmatched)) {
        const terms = bindings.unmatched.flatMap((entry) => {
          const term = (entry as { readonly term?: JsonValue }).term;
          return typeof term === "string" ? [term] : [];
        });
        taskJsonSchema = pinned(patchSchemaProperty(taskJsonSchema, ["decisions"], (decisions) => {
            const items = isJsonRecord(decisions.items) ? decisions.items : {};
            const properties = isJsonRecord(items.properties) ? items.properties : {};
            const termProperty = isJsonRecord(properties.term) ? properties.term : {};
            return {
              ...decisions,
              minItems: terms.length,
              maxItems: terms.length,
              ...(terms.length > 0
                ? {
                    items: {
                      ...items,
                      properties: {
                        ...properties,
                        term: { ...termProperty, enum: terms },
                      },
                    },
                  }
                : {}),
            };
          }), node.id, "the classifier type options");
      }
      // The code annotator must cover exactly the code files it was given:
      // the entry count is pinned and the path field is narrowed to the
      // given paths, so a schema-constrained model cannot skip or invent a
      // file. Completeness and order are re-checked on write.
      if (node.output.schema === "codeAnnotations" && Array.isArray(bindings.files)) {
        const paths = bindings.files.flatMap((entry) => {
          const path = (entry as { readonly path?: JsonValue }).path;
          return typeof path === "string" ? [path] : [];
        });
        if (paths.length > 0) {
          taskJsonSchema = pinned(patchSchemaProperty(taskJsonSchema, ["files"], (files) => {
              const items = isJsonRecord(files.items) ? files.items : {};
              const properties = isJsonRecord(items.properties) ? items.properties : {};
              const pathProperty = isJsonRecord(properties.path) ? properties.path : {};
              return {
                ...files,
                minItems: paths.length,
                maxItems: paths.length,
                items: {
                  ...items,
                  properties: {
                    ...properties,
                    path: { ...pathProperty, enum: paths },
                  },
                },
              };
            }), node.id, "the placement coverage");
        }
      }
      const stepwise = stepwiseContract(node.output.schema, bindings);
      if (stepwise !== undefined) {
        taskJsonSchema = removeSchemaProperties(taskJsonSchema, stepwise.removed);
      }
      const prompt = compileSkillPrompt(role, techniques, bindings);
      for (const capability of prompt.capabilities) {
        if (!this.bundle.capabilities.capabilities[capability]) {
          throw new WorkflowConfigError(`unknown capability "${capability}"`);
        }
      }
      const resolved = await this.routeResolver.resolve({
        logicalRoute: node.route,
        traits: routeDefinition.traits,
        skill: node.skill,
        capabilities: prompt.capabilities,
      });

      // Resolve the capability plan via the broker
      const requiredCapabilities: CapabilityDeclaration[] = prompt.capabilities.map((capId) => {
        const def = this.bundle.capabilities.capabilities[capId];
        return {
          capabilityId: capId,
          operations: def?.operations ?? [],
          whenUnavailable: def?.whenUnavailable ?? "",
        };
      });
      const brokerInput: BrokerInput = {
        requiredCapabilities,
        providerOffers: this.providerOffers,
        hostTools: this.hostTools,
        enabledHostToolIds: this.enabledHostToolIds,
        disabledCapabilityIds: this.disabledCapabilityIds,
        vacantCapabilities: this.vacantCapabilities,
      };
      const capabilityPlan: ResolvedCapabilityPlan = resolveCapabilityPlan(brokerInput);
      // The tool list follows the PLAN: an operation that resolved to a host
      // tool contributes that tool; a disabled or unavailable capability
      // contributes nothing, so the model is never offered a tool the system
      // prompt just told it it does not have. The legacy static resolver only
      // contributes names the plan did not already produce (deployments that
      // configure extra capability tools outside the broker).
      const planHostTools = capabilityPlan.operations
        .filter((operation) => operation.source === "host")
        .flatMap((operation) => operation.toolNames);
      const disabledOrUnavailable = new Set(
        capabilityPlan.operations
          .filter((operation) => operation.source === "unavailable")
          .map((operation) => operation.capabilityId),
      );
      const legacyTools = prompt.capabilities
        .filter((capability) => !disabledOrUnavailable.has(capability))
        .flatMap((capability) =>
          this.capabilityTools.resolve({
            capability,
            contract: this.bundle.capabilities.capabilities[capability]!.contract,
            skill: node.skill,
          }),
        );
      const tools = unique([...planHostTools, ...legacyTools, ...(resolved.tools ?? [])]);
      // Load-bearing capabilities fail LOUD, before any model call: a task
      // whose skill marks a capability required must never run degraded —
      // a forced answer without the capability poisons every downstream
      // stage silently (the toolless-placer failure), while a failed task
      // is visible, diagnosable, and retryable after the deployment is
      // fixed. Degradable capabilities keep the catalog's whenUnavailable
      // prompt treatment.
      //
      // What it reads is the capability's VERDICT, not whether some operation
      // found no tool. Those differ in the case that matters: a run that
      // attached no files and a run whose attachment store this host cannot
      // reach both leave every attachment operation without a tool, and only
      // the second is a reason to stop. Reading the source alone is why no role
      // could safely require attachment-access — declaring it would have failed
      // every topic-only run — and why the one deployment that lost its store
      // ran 442 review tasks that quietly reasoned from metadata instead.
      //
      // Fails on "unwired" (nobody will vouch for the absence, so it is a
      // defect) and on "withheld" (the submitter switched off something this
      // task cannot work without — an answerable request, not a silent
      // degradation). Passes on "vacant" (there is legitimately nothing) and on
      // "degraded" (part of it still works, and the prompt says which part).
      const mustHave = role.meta.requiredCapabilities ?? [];
      if (mustHave.length > 0) {
        const verdicts = new Map(
          capabilityPlan.capabilities.map((status) => [status.capabilityId, status]),
        );
        const missing = mustHave.filter((capabilityId) => {
          const availability = verdicts.get(capabilityId)?.availability;
          return availability === "unwired" || availability === "withheld";
        });
        if (missing.length > 0) {
          const disabledByUser = missing.filter(
            (capabilityId) => verdicts.get(capabilityId)?.availability === "withheld",
          );
          throw new BrainstormRuntimeError(
            `node "${node.id}" (skill "${node.skill}") requires ${missing
              .map((capabilityId) => `"${capabilityId}"`)
              .join(", ")} but the capability resolved unavailable — ` +
              (disabledByUser.length > 0
                ? `${disabledByUser
                    .map((capabilityId) => `"${capabilityId}"`)
                    .join(", ")} was disabled for this run; re-enable it and resubmit`
                : "nothing on this deployment backs it and nothing declared its absence, so " +
                  "this run was wired wrong: enable the backing host tools in the server " +
                  "settings, or run on a backend that provides them, then resume") +
              "; this task refuses to run degraded",
            "REQUIRED_CAPABILITY_UNAVAILABLE",
          );
        }
      }
      const messages = [
        {
          role: "user" as const,
          content: renderTaskBlocks(
            node.skill,
            node.output.schema,
            prompt.payload,
            this.cachePlan.get(node.id) ?? new Set<string>(),
          ),
        },
      ];
      // Capability availability depends on the host's settings, not on the
      // bundle, so it trails the cacheable instruction segments.
      const system: SystemPromptSegment[] = [
        ...prompt.system,
        ...(capabilityPlan.unavailableInstructions
          ? [{ text: capabilityPlan.unavailableInstructions }]
          : []),
      ];
      const modelRequest = {
        ...(resolved.modelId !== undefined ? { modelId: resolved.modelId } : {}),
        system,
        messages,
        ...(resolved.toolChoice !== undefined ? { toolChoice: resolved.toolChoice } : {}),
        ...(resolved.maxOutputTokens !== undefined
          ? { maxOutputTokens: resolved.maxOutputTokens }
          : {}),
        ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
        ...(resolved.topP !== undefined ? { topP: resolved.topP } : {}),
        ...(resolved.stopSequences !== undefined ? { stopSequences: resolved.stopSequences } : {}),
        responseFormat: {
          type: "jsonSchema" as const,
          name: node.output.schema,
          schema: taskJsonSchema,
        },
        ...(resolved.metadata !== undefined ? { metadata: resolved.metadata } : {}),
        ...(resolved.providerOptions !== undefined ? { providerOptions: resolved.providerOptions } : {}),
      };
      const modelRequestValue = modelRequest as unknown as JsonObject;
      const input: JsonObject = {
        role: node.skill,
        logicalRoute: node.route,
        routeTraits: [...routeDefinition.traits],
        bindings,
        allowedCapabilities: [...prompt.capabilities],
        allowedTools: [...tools],
        outputSchema: { name: node.output.schema, schema: taskJsonSchema },
        modelRequest: modelRequestValue,
      };
      const member = resolveDataReference("member.id", scope, stateFrom(scope), { required: false });
      const commentor = resolveDataReference("commentor.id", scope, stateFrom(scope), { required: false });
      return {
        kind: `brainstorm.${node.skill}`,
        agentId:
          typeof commentor === "string"
            ? commentor
            : typeof member === "string"
              ? member
              : node.skill,
        input,
        logicalRoute: node.route,
        allowedCapabilities: prompt.capabilities,
        skills: prompt.skills,
        tools,
        outputSchema: { name: node.output.schema, schema: taskJsonSchema },
        modelRequest,
        ...(resolved.requirements !== undefined ? { requirements: resolved.requirements } : {}),
        capabilityPlan,
        // A patch's coherence can only be judged once it is applied, so the
        // executor's validator gets the version being revised. Host-side
        // context only: it is never rendered into the request — the reviser
        // already receives what it needs through its own bindings.
        ...(node.output.schema === "redevelopmentPatch" ||
        node.output.schema === "redevelopmentPatchParts"
          ? revisionBaseFor(scope)
          : {}),
        metadata: {
          workflow: this.content.name,
          nodeId: node.id,
          schema: node.output.schema,
          logicalRoute: node.route,
          ...(stepwise !== undefined ? { stepwise: stepwise.spec } : {}),
          ...(resolved.providerId !== undefined ? { providerId: resolved.providerId } : {}),
        },
      };
    });
    this.functions.registerActivity(applyName, async (_input, scope, context) => {
      const raw = scope.get(resultKey);
      // The agent node was skipped because its seat is dismissed: there is no
      // output to store, and nothing further is written under that seat's
      // paths — which is what leaves its history exactly as the dismissal
      // found it.
      if (raw === undefined && this.dismissedHere(scope, enclosing)) return stateFrom(scope);
      if (raw === undefined) throw new BrainstormRuntimeError(`agent "${node.id}" produced no output`, "MISSING_OUTPUT");
      return writeValidatedOutput(
        scope,
        node.output.key,
        node.output.schema,
        node.id,
        raw,
        context,
        this.roots,
      );
    });

    return sequence(
      [
        // A declared review phase is stamped on the seat before the task runs,
        // inside the sequence this node already compiles to — so no journal
        // path changes and the dashboard sees the live phase while the (long)
        // model call is in flight.
        ...(node.reviewPhase !== undefined
          ? [activity(this.reviewPhaseActivity(node.id, node.reviewPhase), {
              id: `${node.id}-phase`,
              resultKey: BRAINSTORM_STATE,
              ...this.foldOptions(),
            })]
          : []),
        agent(builderName, { id: `${node.id}-execute`, resultKey }),
        // The store is a deterministic fold over the journaled agent result:
        // it validates and writes the output into the run state (and persists
        // the artifact, idempotently), so it re-runs on replay instead of
        // journaling a full state copy.
        activity(applyName, {
          id: `${node.id}-store`,
          resultKey: BRAINSTORM_STATE,
          ...this.foldOptions(),
        }),
      ],
      { id: node.id, description: node.notes },
    );
  }

  /** Registers (once per node) the activity that stamps a seat's review phase. */
  private reviewPhaseActivity(nodeId: string, phase: ReviewPhase): string {
    const name = this.functionName(nodeId, "phase");
    this.functions.registerActivity(name, (_input, scope) =>
      setReviewPhase(stateFrom(scope), scope, phase),
    );
    return name;
  }

  private compileActivity(node: ContentActivityNode): WorkflowNode {
    const handler = this.activityHandlers[node.handler];
    const declaration = this.bundle.activities.handlers[node.handler];
    if (!handler || !declaration) {
      throw new WorkflowConfigError(`activity node "${node.id}" has no deterministic handler "${node.handler}"`);
    }
    const runHandler = async (
      scope: ScopeReader,
      context: FunctionContext,
    ): Promise<JsonValue> => {
      const bindings = resolveBindings(node.bind, scope, this.roots);
      const output = await handler(bindings, {
        runId: context.runId,
        nodePath: context.nodePath,
        signal: context.signal,
      });
      const parsed = validateArtifact(node.output.schema, node.id, output);
      const boundedBy = bindings[declaration.bounds.maxItemsFromInput];
      const boundedOutput =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as JsonObject)[declaration.bounds.outputField]
          : undefined;
      if (
        typeof boundedBy !== "number" ||
        !Array.isArray(boundedOutput) ||
        boundedOutput.length > boundedBy
      ) {
        throw new BrainstormRuntimeError(
          `activity "${node.id}" violated its declared finite output bound`,
          "ACTIVITY_BOUND_VIOLATION",
        );
      }
      return parsed;
    };

    if (this.journalFormat === 1) {
      // Legacy layout: one journaled node whose recorded value is the full
      // post-apply state. Kept byte-compatible with old journals.
      const functionName = this.functionName(node.id, "activity");
      this.functions.registerActivity(functionName, async (_input, scope, context) =>
        writeValidatedOutput(
          scope,
          node.output.key,
          node.output.schema,
          node.id,
          await runHandler(scope, context),
          context,
          this.roots,
        ),
      );
      return activity(functionName, {
        id: node.id,
        description: node.notes,
        resultKey: BRAINSTORM_STATE,
      });
    }

    // Format 2: the handler's bounded output is the journaled effect; the
    // write into the run state is a deterministic fold recomputed on replay.
    const runName = this.functionName(node.id, "run");
    const applyName = this.functionName(node.id, "apply");
    const outputKey = this.temp(node.id, "output");
    this.functions
      .registerActivity(runName, async (_input, scope, context) => runHandler(scope, context))
      .registerActivity(applyName, async (_input, scope, context) => {
        const parsed = scope.get(outputKey);
        if (parsed === undefined) {
          throw new BrainstormRuntimeError(
            `activity "${node.id}" produced no output`,
            "MISSING_OUTPUT",
          );
        }
        return writeValidatedOutput(
          scope,
          node.output.key,
          node.output.schema,
          node.id,
          parsed,
          context,
          this.roots,
        );
      });
    return sequence(
      [
        activity(runName, { id: `${node.id}-run`, resultKey: outputKey }),
        activity(applyName, {
          id: `${node.id}-apply`,
          resultKey: BRAINSTORM_STATE,
          ...this.foldOptions(),
        }),
      ],
      { id: node.id, description: node.notes },
    );
  }

  private registerCollection(node: ContentForEachNode): string {
    const name = this.functionName(node.id, "items");
    // The loop variables enclosing the forEach itself: its own itemVar is not
    // bound yet, because the collection resolves in the parent frame.
    const enclosing = [...this.loopVars];
    this.functions.registerCollection(name, (scope) => {
      // A dismissed seat iterates nothing — this is what ends its own walk over
      // its chain steps, and it answers before the reference is resolved
      // because a seat dismissed before its first pass has no chain to read.
      if (this.dismissedHere(scope, enclosing)) return [];
      const state = stateFrom(scope);
      const value = resolveDataReference(node.items, scope, state, { required: true });
      if (!Array.isArray(value)) {
        throw new BrainstormRuntimeError(
          `forEach "${node.id}" items reference "${node.items}" is not an array`,
          "INVALID_COLLECTION",
        );
      }
      // A dismissed member is deliberately NOT filtered out of a member
      // collection. Fan-out paths are `${itemVar}[${index}]` over the resolved
      // array, and the dashboard reads a seat's first pass, its token spend and
      // its review coordinates by that same index into the panel — so dropping
      // one seat would renumber the rest and silently re-attribute their work.
      // The seat keeps its branch and every leaf inside it is skipped instead,
      // which costs a few journal entries and not one model call.
      if (node.exclude === undefined) return structuredClone(value) as JsonArray;
      const excluded = resolveDataReference(node.exclude, scope, state, { required: true });
      return value.filter((item) => !jsonEqual(item, excluded)) as JsonArray;
    });
    return name;
  }

  private compileForEach(node: ContentForEachNode): WorkflowNode {
    const itemsFrom = this.registerCollection(node);
    const body = this.withLoopVar(node.itemVar, () => this.compileNode(node.body));
    if (node.mode === "sequential") {
      return reduce({
        id: node.id,
        description: node.notes,
        itemsFrom,
        itemVar: node.itemVar,
        indexVar: node.indexVar,
        indexBase: 1,
        accumulatorVar: BRAINSTORM_STATE,
        initialFrom: STATE_SELECTOR,
        body,
        nextFrom: STATE_SELECTOR,
        resultKey: BRAINSTORM_STATE,
      });
    }

    const branchesKey = this.temp(node.id, "branches");
    const mergeName = this.functionName(node.id, "merge");
    this.functions.registerActivity(mergeName, (_input, scope) => {
      const branchValues = scope.get(branchesKey);
      if (!Array.isArray(branchValues)) {
        throw new BrainstormRuntimeError(`parallel forEach "${node.id}" has no branch results`, "INVALID_RUNTIME_STATE");
      }
      return mergeParallelStates(stateFrom(scope), branchValues);
    });
    // Snapshot and merge are deterministic folds over the branch scopes:
    // each branch's end state (and the merged whole) is rebuilt by replaying
    // the branches' recorded effects, so neither belongs in the journal —
    // journaling them once copied the FULL run state per branch per fan-out.
    const branchBody = sequence(
      [body, activity(SNAPSHOT_ACTIVITY, { id: `${node.id}-snapshot`, ...this.foldOptions() })],
      { id: `${node.id}-branch` },
    );
    return sequence(
      [
        forEach({
          id: `${node.id}-fanout`,
          itemsFrom,
          itemVar: node.itemVar,
          indexVar: node.indexVar,
          indexBase: 1,
          body: branchBody,
          concurrency: node.maxConcurrency,
          resultKey: branchesKey,
        }),
        activity(mergeName, {
          id: `${node.id}-merge`,
          resultKey: BRAINSTORM_STATE,
          ...this.foldOptions(),
        }),
      ],
      { id: node.id, description: node.notes },
    );
  }

  /**
   * A repeatUntil bound is either a literal, or `params.<name>` naming a
   * positive-integer param. The core AST needs a STATIC bound (it is validated
   * as a literal and the compiler runs before a run supplies its params), so the
   * param form compiles to that param's declared `max` — a finite ceiling — and
   * the per-run budget is enforced by the loop's `until` condition against the
   * runtime-stamped seat flag. That keeps the budget declared in exactly one
   * place while the static loop bound stays provably finite.
   */
  private resolveLoopBound(node: ContentRepeatUntilNode): number {
    if (typeof node.maxIterations === "number") return node.maxIterations;
    const ref = node.maxIterations;
    const name = ref.startsWith("params.") ? ref.slice("params.".length) : undefined;
    const declared = name === undefined ? undefined : this.content.params[name];
    if (!declared || typeof declared.max !== "number" || !Number.isSafeInteger(declared.max)) {
      throw new WorkflowConfigError(
        `repeatUntil "${node.id}" sources maxIterations from "${ref}", which must name a workflow param declaring a finite integer max`,
      );
    }
    return declared.max;
  }

  private compileRepeatUntil(node: ContentRepeatUntilNode): WorkflowNode {
    const initializeName = this.functionName(node.id, "initialize");
    const prepareName = this.functionName(node.id, "prepare");
    const finishName = this.functionName(node.id, "finish");
    const conditionName = this.functionName(node.id, "until");
    const enclosing = [...this.loopVars];
    // A dismissed seat's round does nothing, so its bookkeeping has nothing to
    // record: `finishReviewRound` in particular REQUIRES a decision verdict,
    // and the judge that would have produced one was skipped.
    const seatGone = (scope: ScopeReader): boolean => this.dismissedHere(scope, enclosing);
    this.functions
      .registerActivity(initializeName, (_input, scope) =>
        seatGone(scope)
          ? stateFrom(scope)
          : initializeReview(stateFrom(scope), scope, this.bundle.catalogs.verdicts),
      )
      .registerActivity(prepareName, (_input, scope) =>
        seatGone(scope)
          ? stateFrom(scope)
          : prepareReviewRound(stateFrom(scope), scope, this.bundle.catalogs.verdicts),
      )
      .registerActivity(finishName, (_input, scope) =>
        seatGone(scope) ? stateFrom(scope) : finishReviewRound(stateFrom(scope), scope),
      )
      // Ends a dismissed seat's loop at the first boundary instead of spinning
      // it to the round budget: with the round's leaves skipped there is no
      // verdict, and the content's own until-expression would never be true.
      .registerCondition(conditionName, (scope) =>
        seatGone(scope) ? true : evaluateCondition(node.until, scope, this.roots),
      );

    // Round bookkeeping (allowed verdicts, ledger refresh, cursor flags) is
    // a pure function of the state plus the bundle's verdict catalog — a
    // fold, recomputed on replay rather than journaled as state copies.
    const iterationBody = sequence(
      [
        activity(prepareName, {
          id: `${node.id}-prepare`,
          resultKey: BRAINSTORM_STATE,
          ...this.foldOptions(),
        }),
        this.compileNode(node.body),
        activity(finishName, {
          id: `${node.id}-finish`,
          resultKey: BRAINSTORM_STATE,
          ...this.foldOptions(),
        }),
      ],
      { id: `${node.id}-iteration` },
    );
    return sequence(
      [
        activity(initializeName, {
          id: `${node.id}-initialize`,
          resultKey: BRAINSTORM_STATE,
          ...this.foldOptions(),
        }),
        repeatUntil({
          id: `${node.id}-loop`,
          body: iterationBody,
          condition: conditionName,
          maxIterations: this.resolveLoopBound(node),
          onMaxIterations: node.onExhausted === "proceed" ? "continue" : "fail",
          resultKey: BRAINSTORM_STATE,
        }),
      ],
      { id: node.id, description: node.notes },
    );
  }

  private compileCondition(
    node: Extract<ContentWorkflowNode, { kind: "condition" }>,
  ): WorkflowNode {
    const conditionName = this.functionName(node.id, "condition");
    this.functions.registerCondition(conditionName, (scope) => evaluateCondition(node.if, scope, this.roots));
    return condition(
      conditionName,
      this.compileNode(node.then),
      node.else ? this.compileNode(node.else) : undefined,
      { id: node.id, description: node.notes },
    );
  }

  private gatePrompt(node: ContentHumanGateNode, scope: ScopeReader): string {
    if (!node.gate.show) return node.gate.prompt;
    const shown = resolveDataReference(node.gate.show, scope, stateFrom(scope), { required: true });
    return `${node.gate.prompt}\n\n${node.gate.title}:\n${JSON.stringify(shown, null, 2)}`;
  }

  private compileHumanGate(node: ContentHumanGateNode): WorkflowNode {
    const responseKey = this.temp(node.id, "response");
    const applyName = this.functionName(node.id, "apply");
    this.functions.registerActivity(applyName, (_input, scope) => {
      const response = scope.get(responseKey);
      if (response === undefined) {
        throw new BrainstormRuntimeError(`human gate "${node.id}" has no response`, "INVALID_GATE_DECISION");
      }
      return applyGateDecision(stateFrom(scope), scope, node, response, this.roots);
    });

    let gateNode: WorkflowNode;
    if (this.gateMode === "autoApproveSkippable" && node.skippable) {
      const autoName = this.functionName(node.id, "auto");
      this.functions.registerActivity(autoName, () => autoApproveDecision(node) as unknown as JsonValue);
      gateNode = activity(autoName, { id: `${node.id}-auto`, resultKey: responseKey });
    } else {
      const promptName = this.functionName(node.id, "prompt");
      this.functions.registerSelector(promptName, (scope) => this.gatePrompt(node, scope));
      // A classification gate lets the human pick ANY type of the loaded
      // catalog, so the choice list ships in the gate metadata — the server
      // renders it without loading the bundle.
      const offersTypes = node.gate.actions.some(
        (action) => action.editRule === "classification",
      );
      gateNode = humanGate({
        id: `${node.id}-wait`,
        gateKey: node.id,
        promptFrom: promptName,
        resultKey: responseKey,
        metadata: {
          title: node.gate.title,
          show: node.gate.show ?? null,
          actions: node.gate.actions as unknown as JsonArray,
          skippable: node.skippable,
          ...(offersTypes
            ? { typeOptions: Object.keys(this.bundle.catalogs.inputTypes.types) }
            : {}),
        },
      });
    }
    return sequence(
      [
        gateNode,
        // The gate ANSWER is journaled (response entry, or the auto-approve
        // activity's decision); applying it to the state is a deterministic
        // fold over that record.
        activity(applyName, {
          id: `${node.id}-apply`,
          resultKey: BRAINSTORM_STATE,
          ...this.foldOptions(),
        }),
      ],
      { id: node.id, description: node.notes },
    );
  }

  private compileTerminal(
    node: Extract<ContentWorkflowNode, { kind: "terminal" }>,
  ): WorkflowNode {
    if (!node.result) return terminal("success", { id: node.id });
    const selectorName = this.functionName(node.id, "result");
    this.functions.registerSelector(selectorName, (scope) =>
      resolveDataReference(node.result!, scope, stateFrom(scope), { required: true }),
    );
    return terminal("success", {
      id: node.id,
      description: node.notes,
      outputFrom: selectorName,
    });
  }
}

export function compileContentWorkflow(
  options: CompileContentWorkflowOptions,
): CompiledContentWorkflow {
  const content = concreteWorkflow(options.bundle, options.workflow);
  return new ContentCompiler(options.bundle, content, options).compile();
}
