import {
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
  userMessage,
  workflow,
  resolveCapabilityPlan,
  type ArtifactRef,
  type BrokerInput,
  type CapabilityDeclaration,
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

import {
  jsonEqual,
  resolveBindValue,
  resolveDataReference,
  writeDataReference,
} from "./data-ref.js";
import { BrainstormRuntimeError } from "./errors.js";
import { applyGateDecision, autoApproveDecision, type HumanGateMode } from "./gates.js";
import { artifactSchemaToJsonSchema } from "./json-schema.js";
import { selectPanel } from "./panel.js";
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
  /** Resolves role/technique files on first execution; defaults to bundle.skills. */
  readonly skillResolver?: SkillResolver;
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

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function resolveBindings(
  bindings: Readonly<Record<string, BindValue>> | undefined,
  scope: ScopeReader,
): JsonObject {
  const state = stateFrom(scope);
  const output: Record<string, JsonValue> = {};
  for (const [name, binding] of Object.entries(bindings ?? {})) {
    output[name] = resolveBindValue(binding, scope, state);
  }
  return output;
}

function evaluateCondition(
  expression: ConditionExpr,
  scope: ScopeReader,
): boolean {
  if ("all" in expression) return expression.all.every((entry) => evaluateCondition(entry, scope));
  if ("any" in expression) return expression.any.some((entry) => evaluateCondition(entry, scope));
  if ("not" in expression) return !evaluateCondition(expression.not, scope);
  const actual = resolveDataReference(expression.ref, scope, stateFrom(scope), { required: false });
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

async function writeValidatedOutput(
  scope: ScopeReader,
  target: string,
  schemaName: string,
  nodeId: string,
  raw: JsonValue,
  context: FunctionContext,
): Promise<JsonObject> {
  const state = stateFrom(scope);
  const parsed = validateArtifact(schemaName, nodeId, raw);
  if (schemaName === "processorOutput") {
    // The submission types are data (catalog/input-types.json), so the static
    // schema cannot enumerate them; membership is enforced here instead.
    const type = asObject(parsed, "processor output").type;
    const knownTypes = resolveDataReference("catalog.inputTypes.types", scope, state, { required: true });
    if (
      typeof type !== "string" ||
      typeof knownTypes !== "object" ||
      knownTypes === null ||
      Array.isArray(knownTypes) ||
      !Object.prototype.hasOwnProperty.call(knownTypes, type)
    ) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" classified the submission as "${String(type)}", which is not a type of the loaded input-type catalog`,
        "INPUT_TYPE_NOT_IN_CATALOG",
      );
    }
  }
  if (schemaName === "brainIdea" || schemaName === "redevelopment") {
    // The envelope schema enforces "exactly one shape body"; the catalog owns
    // which shape that must be for the run's type, so that pairing — and the
    // type echo itself — is checked here against the loaded bundle.
    const developed = asObject(asObject(parsed, schemaName).output, `${schemaName}.output`);
    const expectedType = resolveDataReference("input.type", scope, state, { required: true });
    if (developed.type !== expectedType) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" returned output.type "${String(developed.type)}" but this run works a "${String(expectedType)}"`,
        "OUTPUT_TYPE_MISMATCH",
      );
    }
    const shape = populatedShape(developed as Parameters<typeof populatedShape>[0]);
    // Description-only bundles (pre-0.2.0) map no shapes; for them any single
    // populated shape is acceptable, so the pairing check only runs when the
    // loaded catalog actually declares one.
    const expectedShape = resolveDataReference("catalog.inputTypes.shapes[input.type]", scope, state, {
      required: false,
    });
    if (expectedShape !== undefined && shape !== expectedShape) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" produced a "${shape}" body but the catalog maps "${String(expectedType)}" to "${String(expectedShape)}"`,
        "OUTPUT_SHAPE_MISMATCH",
      );
    }
  }
  if (schemaName === "brainIdea") {
    const idea = asObject(parsed, "brain idea");
    const expected = resolveDataReference("input.cotSteps", scope, state, { required: true });
    if (!Array.isArray(idea.cot) || idea.cot.length !== expected) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" must return exactly ${String(expected)} chain steps`,
        "CHAIN_LENGTH_MISMATCH",
      );
    }
  }
  if (schemaName === "comment" || schemaName === "judgeDecision") {
    const verdict = asObject(parsed, schemaName).verdict;
    const allowed = resolveDataReference("review.allowedVerdicts", scope, state, { required: true });
    if (
      typeof verdict !== "string" ||
      typeof allowed !== "object" ||
      allowed === null ||
      Array.isArray(allowed) ||
      !Object.prototype.hasOwnProperty.call(allowed, verdict)
    ) {
      throw new BrainstormRuntimeError(
        `node "${nodeId}" returned verdict "${String(verdict)}" which is not allowed this round`,
        "VERDICT_NOT_ALLOWED",
      );
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
  const stored = schemaName === "experts" ? sortExpertsBySupport(parsed) : parsed;
  const write = writeDataReference(state, target, stored, scope);
  let next = write.state;
  if (schemaName === "redevelopment") {
    next = applyRedevelopment(next, scope, parsed, nodeId);
  }
  return persistArtifact(next, write.path, schemaName, nodeId, stored, context);
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical order for the expertise tree: descending measured support, ties
 * keeping the order the model emitted (which the decomposer defines as first
 * appearance in the grounding pool). The orchestrator applies it rather than
 * trusting the model to, for the same reason it assembles the reviewed chain
 * itself — the ordering is computable, so it is not left to a judgement.
 *
 * Departments carry no count of their own; they rank by their strongest
 * umbrella, which is what `panel.select` walks in round-robin order.
 */
function sortExpertsBySupport(tree: JsonValue): JsonValue {
  if (!isJsonRecord(tree) || !Array.isArray(tree.departments)) return tree;
  const count = (entry: JsonValue): number =>
    isJsonRecord(entry) && typeof entry.count === "number" ? entry.count : 0;
  /** Stable descending sort: Array.prototype.sort is stable, so ties hold. */
  const byCount = <T extends JsonValue>(entries: readonly T[]): T[] =>
    [...entries].sort((left, right) => count(right) - count(left));

  const departments = tree.departments.map((department) => {
    if (!isJsonRecord(department) || !Array.isArray(department.umbrellas)) {
      return department;
    }
    const umbrellas = byCount(department.umbrellas).map((umbrella) =>
      isJsonRecord(umbrella) && Array.isArray(umbrella.subfields)
        ? { ...umbrella, subfields: byCount(umbrella.subfields) }
        : umbrella,
    );
    return { ...department, umbrellas };
  });
  const strongest = (department: JsonValue): number =>
    isJsonRecord(department) && Array.isArray(department.umbrellas)
      ? Math.max(0, ...department.umbrellas.map(count))
      : 0;
  return {
    ...tree,
    departments: [...departments].sort(
      (left, right) => strongest(right) - strongest(left),
    ),
  };
}

/**
 * Returns a clone of a JSON schema with the object property at
 * `properties.<path[0]>.properties.<path[1]>…` replaced by `patch`'s result,
 * or undefined when the path does not lead through object schemas. Used to
 * narrow per-task what the static artifact schema must leave open (allowed
 * verdicts per review round, the submission-type label per run).
 */
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
 */
function stepwiseContract(
  schemaName: string,
  bindings: JsonObject,
): { readonly spec: JsonObject; readonly removed: readonly string[] } | undefined {
  if (schemaName === "brainIdea") {
    const count = bindings.cotSteps;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
      return undefined;
    }
    return {
      spec: { tool: "submit_step", field: "cot", count },
      removed: ["cot"],
    };
  }
  if (schemaName === "redevelopment") {
    const currentStep = bindings.currentStep;
    const totalSteps = bindings.totalSteps;
    if (
      typeof currentStep !== "number" ||
      typeof totalSteps !== "number" ||
      !Number.isSafeInteger(currentStep) ||
      !Number.isSafeInteger(totalSteps)
    ) {
      return undefined;
    }
    const count = totalSteps - currentStep + 1;
    if (count < 1) return undefined;
    return {
      spec: {
        tool: "submit_step",
        field: "revisedSteps",
        count,
        inject: { fromStep: currentStep },
      },
      removed: ["revisedSteps", "fromStep"],
    };
  }
  return undefined;
}

/**
 * The task turn: what to do plus the payload the role's instructions refer to
 * by name. Keeping submission-derived data here rather than in the system
 * prompt holds it at user privilege and leaves the instructions byte-stable
 * across calls.
 */
function renderTaskMessage(
  role: string,
  schemaName: string,
  payload: readonly PayloadEntry[],
): string {
  const sections = payload.map(({ name, value }) => {
    const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return `## ${name}\n\n${rendered}`;
  });
  return [
    `# Task`,
    `Execute the ${role} role instructions from the system prompt against the data below. ` +
      `Return only one JSON value satisfying the "${schemaName}" schema.`,
    ...(sections.length > 0 ? ["# Task data", ...sections] : []),
  ].join("\n\n");
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
    "panel.select": (input) => {
      const experts = validateArtifact("experts", "panel.select", input.experts!);
      const panelSize = input.panelSize;
      const moduleSize = input.moduleSize;
      if (typeof panelSize !== "number" || typeof moduleSize !== "number") {
        throw new BrainstormRuntimeError(
          "panel.select requires numeric panelSize and moduleSize",
          "INVALID_ACTIVITY_INPUT",
        );
      }
      return selectPanel(
        experts as unknown as Parameters<typeof selectPanel>[0],
        panelSize,
        moduleSize,
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
  private readonly skillResolver: SkillResolver;

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
    this.skillResolver =
      options.skillResolver ?? new BundleSkillResolver(this.bundle);
    this.gateMode = options.humanGateMode ?? "manual";
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
        [BRAINSTORM_STATE]: createInitialState(this.bundle, this.content, submission, params),
      }),
    };
  }

  private functionName(nodeId: string, purpose: string): string {
    return `brainstorm.${this.content.name}.${nodeId}.${purpose}`;
  }

  private temp(nodeId: string, purpose: string): string {
    return `__brainstorm:${nodeId}:${purpose}`;
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
      const bindings = resolveBindings(node.bind, scope);
      let taskJsonSchema = jsonSchema;
      if (
        (node.output.schema === "comment" ||
          node.output.schema === "judgeDecision") &&
        isJsonRecord(bindings.verdictOptions)
      ) {
        const allowed = Object.keys(bindings.verdictOptions);
        taskJsonSchema =
          patchSchemaProperty(taskJsonSchema, ["verdict"], (verdict) => ({
            ...verdict,
            enum: allowed,
          })) ?? taskJsonSchema;
      }
      // The submission types are catalog data, so the static artifact schemas
      // leave `type` as an open string; each task narrows it to what is
      // actually legal for THIS run, so a schema-constrained model cannot
      // write the shape id (or any other invention) into the label field.
      if (
        (node.output.schema === "brainIdea" || node.output.schema === "redevelopment") &&
        typeof bindings.type === "string" &&
        bindings.type.length > 0
      ) {
        const label = bindings.type;
        const shape = typeof bindings.shape === "string" ? bindings.shape : undefined;
        taskJsonSchema =
          patchSchemaProperty(taskJsonSchema, ["output"], (output) => {
            const envelope =
              patchSchemaProperty(output, ["type"], (type) => ({ ...type, enum: [label] })) ??
              output;
            const required = Array.isArray(envelope.required) ? envelope.required : [];
            return shape !== undefined && !required.includes(shape)
              ? { ...envelope, required: [...required, shape] }
              : envelope;
          }) ?? taskJsonSchema;
      }
      if (
        node.output.schema === "processorOutput" &&
        isJsonRecord(bindings.typeOptions) &&
        Object.keys(bindings.typeOptions).length > 0
      ) {
        const labels = Object.keys(bindings.typeOptions);
        taskJsonSchema =
          patchSchemaProperty(taskJsonSchema, ["type"], (type) => ({
            ...type,
            enum: labels,
          })) ?? taskJsonSchema;
      }
      const stepwise = stepwiseContract(node.output.schema, bindings);
      if (stepwise !== undefined) {
        taskJsonSchema = removeSchemaProperties(taskJsonSchema, stepwise.removed);
      }
      const prompt = compileSkillPrompt(role, techniques, bindings);
      const capabilityTools = prompt.capabilities.flatMap((capability) => {
        const definition = this.bundle.capabilities.capabilities[capability];
        if (!definition) throw new WorkflowConfigError(`unknown capability "${capability}"`);
        return this.capabilityTools.resolve({
          capability,
          contract: definition.contract,
          skill: node.skill,
        });
      });
      const resolved = await this.routeResolver.resolve({
        logicalRoute: node.route,
        traits: routeDefinition.traits,
        skill: node.skill,
        capabilities: prompt.capabilities,
      });
      const tools = unique([...capabilityTools, ...(resolved.tools ?? [])]);

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
      };
      const capabilityPlan: ResolvedCapabilityPlan = resolveCapabilityPlan(brokerInput);
      const messages = [
        userMessage(
          renderTaskMessage(node.skill, node.output.schema, prompt.payload),
        ),
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
      if (raw === undefined) throw new BrainstormRuntimeError(`agent "${node.id}" produced no output`, "MISSING_OUTPUT");
      return writeValidatedOutput(
        scope,
        node.output.key,
        node.output.schema,
        node.id,
        raw,
        context,
      );
    });

    return sequence(
      [
        agent(builderName, { id: `${node.id}-execute`, resultKey }),
        activity(applyName, { id: `${node.id}-store`, resultKey: BRAINSTORM_STATE }),
      ],
      { id: node.id, description: node.notes },
    );
  }

  private compileActivity(node: ContentActivityNode): WorkflowNode {
    const functionName = this.functionName(node.id, "activity");
    const handler = this.activityHandlers[node.handler];
    const declaration = this.bundle.activities.handlers[node.handler];
    if (!handler || !declaration) {
      throw new WorkflowConfigError(`activity node "${node.id}" has no deterministic handler "${node.handler}"`);
    }
    this.functions.registerActivity(functionName, async (_input, scope, context) => {
      const bindings = resolveBindings(node.bind, scope);
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
      return writeValidatedOutput(
        scope,
        node.output.key,
        node.output.schema,
        node.id,
        parsed,
        context,
      );
    });
    return activity(functionName, {
      id: node.id,
      description: node.notes,
      resultKey: BRAINSTORM_STATE,
    });
  }

  private registerCollection(node: ContentForEachNode): string {
    const name = this.functionName(node.id, "items");
    this.functions.registerCollection(name, (scope) => {
      const state = stateFrom(scope);
      const value = resolveDataReference(node.items, scope, state, { required: true });
      if (!Array.isArray(value)) {
        throw new BrainstormRuntimeError(
          `forEach "${node.id}" items reference "${node.items}" is not an array`,
          "INVALID_COLLECTION",
        );
      }
      if (node.exclude === undefined) return structuredClone(value) as JsonArray;
      const excluded = resolveDataReference(node.exclude, scope, state, { required: true });
      return value.filter((item) => !jsonEqual(item, excluded)) as JsonArray;
    });
    return name;
  }

  private compileForEach(node: ContentForEachNode): WorkflowNode {
    const itemsFrom = this.registerCollection(node);
    const body = this.compileNode(node.body);
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
    const branchBody = sequence(
      [body, activity(SNAPSHOT_ACTIVITY, { id: `${node.id}-snapshot` })],
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
        activity(mergeName, { id: `${node.id}-merge`, resultKey: BRAINSTORM_STATE }),
      ],
      { id: node.id, description: node.notes },
    );
  }

  private compileRepeatUntil(node: ContentRepeatUntilNode): WorkflowNode {
    const initializeName = this.functionName(node.id, "initialize");
    const prepareName = this.functionName(node.id, "prepare");
    const finishName = this.functionName(node.id, "finish");
    const conditionName = this.functionName(node.id, "until");
    this.functions
      .registerActivity(initializeName, (_input, scope) => initializeReview(stateFrom(scope)))
      .registerActivity(prepareName, (_input, scope) => prepareReviewRound(stateFrom(scope)))
      .registerActivity(finishName, (_input, scope) => finishReviewRound(stateFrom(scope)))
      .registerCondition(conditionName, (scope) => evaluateCondition(node.until, scope));

    const iterationBody = sequence(
      [
        activity(prepareName, { id: `${node.id}-prepare`, resultKey: BRAINSTORM_STATE }),
        this.compileNode(node.body),
        activity(finishName, { id: `${node.id}-finish`, resultKey: BRAINSTORM_STATE }),
      ],
      { id: `${node.id}-iteration` },
    );
    return sequence(
      [
        activity(initializeName, { id: `${node.id}-initialize`, resultKey: BRAINSTORM_STATE }),
        repeatUntil({
          id: `${node.id}-loop`,
          body: iterationBody,
          condition: conditionName,
          maxIterations: node.maxIterations,
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
    this.functions.registerCondition(conditionName, (scope) => evaluateCondition(node.if, scope));
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
      return applyGateDecision(stateFrom(scope), scope, node, response);
    });

    let gateNode: WorkflowNode;
    if (this.gateMode === "autoApproveSkippable" && node.skippable) {
      const autoName = this.functionName(node.id, "auto");
      this.functions.registerActivity(autoName, () => autoApproveDecision(node) as unknown as JsonValue);
      gateNode = activity(autoName, { id: `${node.id}-auto`, resultKey: responseKey });
    } else {
      const promptName = this.functionName(node.id, "prompt");
      this.functions.registerSelector(promptName, (scope) => this.gatePrompt(node, scope));
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
        },
      });
    }
    return sequence(
      [
        gateNode,
        activity(applyName, { id: `${node.id}-apply`, resultKey: BRAINSTORM_STATE }),
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
