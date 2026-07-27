import type {
  AgentExecutionContext,
  AgentTask,
  JsonObject,
  JsonValue,
  ModelRequest,
  ModelResponse,
  ProviderOptions,
  ResponseFormat,
  SystemPrompt,
  ToolChoice,
} from "./core-adapter.js";
import { textContent, userMessage } from "./core-adapter.js";
import { AgentRuntimeError } from "./errors.js";

export interface ModelRoute {
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

/**
 * Resolves provider-neutral model settings for a task. Routing is deliberately
 * separate from AgentTask.input: callers may use task.kind, requirements, or
 * deployment policy without encoding model ids inside arbitrary task payloads.
 */
export interface ModelRouteResolver {
  resolve(
    task: AgentTask,
    context: AgentExecutionContext,
  ): ModelRoute | Promise<ModelRoute>;
}

export class FixedModelRouteResolver implements ModelRouteResolver {
  public constructor(private readonly route: ModelRoute) {}

  public resolve(): ModelRoute {
    return this.route;
  }
}

/**
 * Converts the workflow-level AgentTask into a normalized model request and
 * converts a terminal model response back to checkpoint-safe JSON.
 */
export interface AgentTaskModelAdapter {
  createRequest(
    task: AgentTask,
    context: AgentExecutionContext,
    route: ModelRoute,
  ): ModelRequest;
  responseToOutput(
    response: ModelResponse,
    task: AgentTask,
    context: AgentExecutionContext,
    route: ModelRoute,
  ): JsonValue;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new AgentRuntimeError(
        "AgentTask.input contains a non-JSON value.",
        "INVALID_TASK_INPUT",
      );
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key]!)}`,
    )
    .join(",")}}`;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/**
 * Default deterministic mapping:
 * - string input is sent verbatim;
 * - every other JsonValue is serialized with recursively sorted object keys;
 * - text responses return a string;
 * - json/jsonSchema responses are parsed and verified to remain JsonValue.
 */
export class DeterministicJsonTaskAdapter implements AgentTaskModelAdapter {
  public createRequest(
    task: AgentTask,
    _context: AgentExecutionContext,
    route: ModelRoute,
  ): ModelRequest {
    const prompt =
      typeof task.input === "string" ? task.input : canonicalJson(task.input);
    return {
      modelId: route.modelId,
      ...(route.system !== undefined ? { system: route.system } : {}),
      messages: [userMessage(prompt)],
      ...(route.toolChoice !== undefined
        ? { toolChoice: route.toolChoice }
        : {}),
      ...(route.maxOutputTokens !== undefined
        ? { maxOutputTokens: route.maxOutputTokens }
        : {}),
      ...(route.temperature !== undefined
        ? { temperature: route.temperature }
        : {}),
      ...(route.topP !== undefined ? { topP: route.topP } : {}),
      ...(route.stopSequences !== undefined
        ? { stopSequences: route.stopSequences }
        : {}),
      ...(route.responseFormat !== undefined
        ? { responseFormat: route.responseFormat }
        : {}),
      ...((route.metadata ?? task.metadata) !== undefined
        ? { metadata: route.metadata ?? task.metadata }
        : {}),
      ...(route.providerOptions !== undefined
        ? { providerOptions: route.providerOptions }
        : {}),
    };
  }

  public responseToOutput(
    response: ModelResponse,
    _task: AgentTask,
    _context: AgentExecutionContext,
    route: ModelRoute,
  ): JsonValue {
    const text = textContent(response.content);
    if (
      route.responseFormat === undefined ||
      route.responseFormat.type === "text"
    ) {
      return text;
    }

    try {
      const parsed: unknown = JSON.parse(text);
      if (!isJsonValue(parsed)) {
        throw new Error("parsed output is not JSON-safe");
      }
      return parsed;
    } catch (error) {
      throw new AgentRuntimeError(
        "Model response was not valid JSON.",
        "INVALID_JSON_OUTPUT",
        { cause: error },
      );
    }
  }
}

export { canonicalJson as canonicalJsonStringify };
