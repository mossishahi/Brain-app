import { artifactSchemas } from "@brainstorm-agentic/content";
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
export class ContentArtifactOutputValidator {
  validate(value: unknown, schema: unknown): ContentValidationResult {
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
    return { success: true, value: parsed.data };
  }
}
