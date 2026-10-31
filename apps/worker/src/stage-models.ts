import type { AgentModelExecutionControls } from "@brainstorm-agentic/core";
import type { BrainstormRouteResolver, ResolvedBrainstormRoute } from "@brainstorm-agentic/brainstorm-runtime";
import type {
  ClaudeAgentEffort,
  ModelCatalogSnapshot,
  StageModelSettings,
} from "@brainstorm-agentic/protocol";

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(env: NodeJS.ProcessEnv, name: string): unknown {
  if (env[name] === undefined) return undefined;
  try { return JSON.parse(env[name]!); }
  catch { throw new Error(`${name} is not valid JSON`); }
}

export function stageSettingsFromEnv(env: NodeJS.ProcessEnv): Readonly<Record<string, StageModelSettings>> | undefined {
  const value = readJson(env, "BRAINSTORM_AGENTIC_STAGE_SETTINGS");
  if (value === undefined) return undefined;
  if (!object(value)) throw new Error("BRAINSTORM_AGENTIC_STAGE_SETTINGS must be an object");
  const settings: Record<string, StageModelSettings> = Object.create(null);
  for (const [id, stage] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id) || !object(stage) ||
      Object.keys(stage).some((key) => !["model", "effort", "thinking", "transcript"].includes(key)) ||
      (stage.model !== undefined && (typeof stage.model !== "string" || !stage.model.trim())) ||
      (stage.effort !== undefined && (typeof stage.effort !== "string" || !EFFORTS.has(stage.effort))) ||
      (stage.thinking !== undefined && stage.thinking !== "adaptive" && stage.thinking !== "disabled") ||
      (stage.transcript !== undefined && stage.transcript !== "if-available" && stage.transcript !== "off")) {
      throw new Error("BRAINSTORM_AGENTIC_STAGE_SETTINGS contains an invalid stage override");
    }
    settings[id] = Object.freeze({
      ...(typeof stage.model === "string" ? { model: stage.model.trim() } : {}),
      ...(typeof stage.effort === "string" ? { effort: stage.effort as ClaudeAgentEffort } : {}),
      ...(stage.thinking !== undefined ? { thinking: stage.thinking } : {}),
      ...(stage.transcript !== undefined ? { transcript: stage.transcript } : {}),
    });
  }
  return Object.freeze(settings);
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function modelCatalogFromEnv(
  env: NodeJS.ProcessEnv,
  provider: ModelCatalogSnapshot["provider"],
): ModelCatalogSnapshot | undefined {
  const value = readJson(env, "BRAINSTORM_AGENTIC_MODEL_CATALOG");
  if (value === undefined) return undefined;
  if (!object(value) || value.provider !== provider ||
    (value.source !== "provider" && value.source !== "fallback") ||
    typeof value.stale !== "boolean" ||
    !(value.fetchedAt === null || (typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt))) ||
    !Array.isArray(value.models)) {
    throw new Error("BRAINSTORM_AGENTIC_MODEL_CATALOG is not a snapshot for the selected provider");
  }
  for (const model of value.models) {
    if (!object(model) || typeof model.id !== "string" || !model.id || typeof model.label !== "string" ||
      (model.aliases !== undefined && (!Array.isArray(model.aliases) || model.aliases.some((alias) => typeof alias !== "string")))) {
      throw new Error("BRAINSTORM_AGENTIC_MODEL_CATALOG contains an invalid model");
    }
    const capabilities = model.capabilities;
    if (capabilities !== undefined && (!object(capabilities) ||
      !Array.isArray(capabilities.effortLevels) || capabilities.effortLevels.some((effort) => typeof effort !== "string" || !EFFORTS.has(effort)) ||
      typeof capabilities.adaptiveThinking !== "boolean" ||
      (capabilities.thinkingCanBeDisabled !== undefined && typeof capabilities.thinkingCanBeDisabled !== "boolean"))) {
      throw new Error("BRAINSTORM_AGENTIC_MODEL_CATALOG contains invalid model capabilities");
    }
  }
  if (value.cursorModels !== undefined) {
    if (!Array.isArray(value.cursorModels)) throw new Error("BRAINSTORM_AGENTIC_MODEL_CATALOG contains invalid Cursor models");
    for (const model of value.cursorModels) {
      if (!object(model) || typeof model.id !== "string" ||
        (model.aliases !== undefined && (!Array.isArray(model.aliases) || model.aliases.some((alias) => typeof alias !== "string"))) ||
        (model.parameters !== undefined && (!Array.isArray(model.parameters) || model.parameters.some((parameter) =>
          !object(parameter) || typeof parameter.id !== "string" || !Array.isArray(parameter.values) ||
          parameter.values.some((choice) => !object(choice) || typeof choice.value !== "string"))))) {
        throw new Error("BRAINSTORM_AGENTIC_MODEL_CATALOG contains invalid Cursor parameters");
      }
    }
  }
  return freezeJson(value as unknown as ModelCatalogSnapshot);
}

interface StageRoutingConfig {
  readonly provider: ModelCatalogSnapshot["provider"];
  readonly models?: Readonly<Record<string, string>>;
  readonly defaultModel?: string;
  readonly agentSdk?: AgentModelExecutionControls;
  readonly transcript?: "if-available" | "off";
  readonly stageSettings?: Readonly<Record<string, StageModelSettings>>;
  readonly modelCatalog?: ModelCatalogSnapshot;
}

/** Resolve once-snapshotted stage choices before a task reaches any executor. */
export function contentRouteResolver(config: StageRoutingConfig): BrainstormRouteResolver {
  const models = config.models ?? {};
  const fallback = config.defaultModel ?? models.reasoning ?? (config.provider === "cursor-agent" ? "auto" : "");
  return {
    resolve(request): ResolvedBrainstormRoute {
      if (config.provider === "offline") return config.transcript === undefined ? {} : { execution: { transcript: config.transcript } };
      const stage = request.nodeId ? config.stageSettings?.[request.nodeId] : undefined;
      const modelId = stage?.model ?? models[request.logicalRoute] ?? fallback;
      const transcript = stage?.transcript ?? config.transcript;
      // Legacy CLI launches and saved jobs have no snapshot. The desktop
      // exports an empty stage map on their resume to clear inherited policy.
      // Every new desktop launch supplies a catalog, even on discovery failure.
      if (config.modelCatalog === undefined && Object.keys(config.stageSettings ?? {}).length === 0) {
        return {
          providerId: config.provider,
          ...(modelId ? { modelId } : {}),
          ...(transcript !== undefined ? { execution: {
            ...(config.provider === "claude-agent" ? { effort: "high" as const, thinking: "adaptive" as const } : {}),
            ...config.agentSdk, transcript,
          } } : {}),
          ...(config.provider === "anthropic" && request.traits.includes("extended-reasoning") ? {
            providerOptions: { anthropic: { thinking: { type: "adaptive", display: transcript === "off" ? "omitted" : "summarized" } } },
          } : {}),
          ...(config.provider === "gemini" ? { providerOptions: { gemini: { includeThoughts: transcript === "if-available" } } } : {}),
        };
      }
      const model = config.modelCatalog?.models.find((entry) => entry.id === modelId || entry.aliases?.includes(modelId));
      // The stage inherits a concrete route/default model as well as explicit
      // stage choices. Validate all of them: an older host environment can
      // otherwise send a former provider's route model to the selected API.
      // A failed catalog refresh may retain an old provider list. Preserve the
      // existing explicit-stage validation, but do not reject a newly available
      // inherited model merely because it is absent from that stale list.
      if (modelId && config.modelCatalog?.source === "provider" &&
        (stage?.model !== undefined || !config.modelCatalog.stale) && model === undefined) {
        const selection = stage?.model !== undefined ? `Stage "${request.nodeId}"` : `Route "${request.logicalRoute}"`;
        throw new Error(`${selection} selects model "${modelId}", which is absent from the ${config.provider} provider's launch catalog`);
      }
      const capabilities = model?.capabilities;
      if (stage?.effort !== undefined && !capabilities?.effortLevels.includes(stage.effort)) {
        throw new Error(`Stage "${request.nodeId}" cannot use effort "${stage.effort}" with model "${modelId}": support was not declared in the launch catalog`);
      }
      const supportsThinking = (thinking: "adaptive" | "disabled"): boolean =>
        thinking === "adaptive" ? capabilities?.adaptiveThinking === true : capabilities?.thinkingCanBeDisabled === true;
      if (stage?.thinking !== undefined && !supportsThinking(stage.thinking)) {
        throw new Error(`Stage "${request.nodeId}" cannot use thinking "${stage.thinking}" with model "${modelId}": support was not declared in the launch catalog`);
      }
      const requestedEffort = stage?.effort ?? config.agentSdk?.effort ?? (config.provider === "claude-agent" ? "high" : undefined);
      const requestedThinking = stage?.thinking ?? config.agentSdk?.thinking ??
        (config.provider === "claude-agent" || request.traits.includes("extended-reasoning") ? "adaptive" : undefined);
      const execution: AgentModelExecutionControls = {
        ...(transcript !== undefined ? { transcript } : {}),
        ...(requestedEffort !== undefined && capabilities?.effortLevels.includes(requestedEffort) ? { effort: requestedEffort } : {}),
        ...(requestedThinking !== undefined && supportsThinking(requestedThinking) ? { thinking: requestedThinking } : {}),
        ...(capabilities !== undefined ? { supportedEffortLevels: capabilities.effortLevels } : {}),
      };
      return {
        providerId: config.provider,
        ...(modelId ? { modelId } : {}),
        execution,
        ...(config.provider === "anthropic" ? {
          providerOptions: { anthropic: {
            ...(execution.effort !== undefined ? { output_config: { effort: execution.effort } } : {}),
            ...(execution.thinking !== undefined ? {
              thinking: execution.thinking === "disabled" ? { type: "disabled" } : {
                type: "adaptive", display: transcript === "off" ? "omitted" :
                  transcript === "if-available" || request.traits.includes("extended-reasoning") ? "summarized" : "omitted",
              },
            } : {}),
          } },
        } : {}),
        ...(config.provider === "gemini" ? {
          providerOptions: { gemini: {
            includeThoughts: transcript === "if-available",
            ...(execution.effort !== undefined ? { thinkingLevel: execution.effort } : {}),
            ...(execution.thinking === "disabled" ? { thinkingBudget: 0 } : {}),
          } },
        } : {}),
      };
    },
  };
}
