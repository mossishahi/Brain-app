import {
  artifactSchemas,
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
import { compileSkillPrompt } from "./prompts.js";
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
  const write = writeDataReference(state, target, parsed, scope);
  let next = write.state;
  if (schemaName === "redevelopment") {
    next = applyRedevelopment(next, scope, parsed, nodeId);
  }
  return persistArtifact(next, write.path, schemaName, nodeId, parsed, context);
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
        typeof bindings.verdictOptions === "object" &&
        bindings.verdictOptions !== null &&
        !Array.isArray(bindings.verdictOptions)
      ) {
        const allowed = Object.keys(bindings.verdictOptions);
        const cloned = structuredClone(jsonSchema);
        const properties = cloned.properties;
        if (
          typeof properties === "object" &&
          properties !== null &&
          !Array.isArray(properties)
        ) {
          const propertyRecord = properties as Record<string, JsonValue>;
          const verdict = propertyRecord.verdict;
          if (
            typeof verdict === "object" &&
            verdict !== null &&
            !Array.isArray(verdict)
          ) {
            propertyRecord.verdict = { ...verdict, enum: allowed };
            taskJsonSchema = cloned;
          }
        }
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
      const userPrompt =
        `Execute the rendered ${node.skill} role instructions. ` +
        `Return only one JSON value satisfying the "${node.output.schema}" schema.`;
      const messages = [userMessage(userPrompt)];
      const systemWithAvailability = capabilityPlan.unavailableInstructions
        ? `${prompt.system}\n\n---\n\n${capabilityPlan.unavailableInstructions}`
        : prompt.system;
      const modelRequest = {
        ...(resolved.modelId !== undefined ? { modelId: resolved.modelId } : {}),
        system: systemWithAvailability,
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
