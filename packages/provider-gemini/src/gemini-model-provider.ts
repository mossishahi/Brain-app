import { randomUUID } from "node:crypto";
import { systemPromptText, type CallOptions, type ContentBlock, type JsonObject, type JsonValue,
  type ModelCapabilities, type ModelDescriptor, type ModelMessage, type ModelProvider, type ModelRequest,
  type ModelResponse, type RequestCoordinator, type StopReason } from "@brainstorm-agentic/core";
import { abortable, classifyGeminiError, GeminiProviderError, record, throwIfAborted } from "./errors.js";
import { createGeminiClient, discoverGeminiModels, geminiCapabilities, geminiModelProfile,
  type GeminiClient, type GeminiDiscoveredModel } from "./models.js";

export interface GeminiModelProviderConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly coordinator?: RequestCoordinator;
  readonly baseURL?: string;
  readonly maxOutputTokens?: number;
  /** Official SDK boundary; tests need no network or credentials. */
  readonly client?: GeminiClient;
}

type Wire = Record<string, unknown>;
function invalid(message: string): never { throw new GeminiProviderError(message, "validation", false); }
function positive(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(`${label} must be a positive integer.`);
  return value;
}
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function originalPart(block: ContentBlock): Wire | undefined {
  const native = record(block.metadata?.gemini).part;
  return native && typeof native === "object" && !Array.isArray(native) ? structuredClone(native) as Wire : undefined;
}

function mediaPart(block: Extract<ContentBlock, { type: "image" | "document" }>): Wire {
  if (block.source.kind !== "base64") invalid("Gemini image/document inputs require base64 content; fetch attachments through the host first.");
  return { inlineData: { mimeType: block.source.mediaType, data: block.source.data } };
}

/** Preserve each model Part separately, including opaque signatures on text/function calls. */
function messagesToContents(messages: readonly ModelMessage[]): Wire[] {
  const contents: Wire[] = [];
  const calls = new Map<string, { name: string; wireId?: string }>();
  let finalAcks: Wire[] = [];
  let callOrder: string[] = [];
  for (const message of messages) {
    const parts: Wire[] = message.role === "user" ? finalAcks.splice(0) : [];
    if (message.role === "assistant") callOrder = [];
    for (const block of message.content) {
      const native = message.role === "assistant" ? originalPart(block) : undefined;
      if (block.type === "tool_use") {
        const fn = record(native?.functionCall);
        calls.set(block.id, { name: block.name, ...(typeof fn.id === "string" ? { wireId: fn.id } : {}) });
      }
      if (native) {
        const fn = record(native.functionCall);
        if (typeof fn.name === "string") {
          callOrder.push(typeof fn.id === "string" ? `id:${fn.id}` : `name:${fn.name}`);
          if (record(block.metadata?.gemini).finalResult === true) finalAcks.push({ functionResponse: {
            name: fn.name, ...(typeof fn.id === "string" ? { id: fn.id } : {}),
            response: { output: "Structured result received. Consider any host tool results and validation feedback before submitting the final result again." },
          } });
        }
        parts.push(native); continue;
      }
      switch (block.type) {
        case "text": parts.push({ text: block.text }); break;
        case "thinking":
          // Foreign-provider reasoning is not a Gemini thought/signature.
          break;
        case "image": case "document": parts.push(mediaPart(block)); break;
        case "tool_use":
          if (message.role !== "assistant") invalid("Gemini function calls must be assistant messages.");
          parts.push({ functionCall: { name: block.name, args: block.input } });
          break;
        case "tool_result": {
          if (message.role !== "user") invalid("Gemini function results must be user messages.");
          const call = calls.get(block.toolUseId);
          if (!call) invalid(`Gemini tool result has no preceding function call: ${block.toolUseId}.`);
          const text = block.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
          const media = block.content.filter((part) => part.type !== "text").map(mediaPart);
          parts.push({ functionResponse: {
            name: call.name, ...(call.wireId ? { id: call.wireId } : {}),
            response: block.isError ? { error: text } : { output: text },
            ...(media.length ? { parts: media } : {}),
          } });
          break;
        }
      }
    }
    if (message.role === "user" && callOrder.length > 0) {
      // Keep synthetic acknowledgements and real tool responses in call order.
      const responses = parts.filter((part) => part.functionResponse !== undefined);
      responses.sort((a, b) => {
        const position = (part: Wire): number => {
          const fn = record(part.functionResponse);
          return callOrder.indexOf(typeof fn.id === "string" ? `id:${fn.id}` : `name:${fn.name}`);
        };
        return position(a) - position(b);
      });
      if (responses.length) parts.splice(0, parts.length, ...responses, ...parts.filter((part) => part.functionResponse === undefined));
    }
    if (parts.length) contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  if (finalAcks.length) contents.push({ role: "user", parts: finalAcks });
  return contents;
}

function thinkingConfig(request: ModelRequest): Wire | undefined {
  const options = request.providerOptions?.gemini ?? {};
  if (options.includeThoughts !== undefined && typeof options.includeThoughts !== "boolean") invalid("Gemini includeThoughts must be boolean.");
  const config: Wire = { includeThoughts: options.includeThoughts === true };
  const { thinkingLevel: level, thinkingBudget: budget } = options;
  if (level !== undefined && budget !== undefined) invalid("Gemini thinkingLevel and thinkingBudget are mutually exclusive.");
  const profile = geminiModelProfile(request.modelId);
  if (level !== undefined) {
    if (typeof level !== "string" || !profile?.thinkingLevels.some((supported) => supported === level)) invalid(`Gemini model ${request.modelId} does not advertise thinking level ${String(level)}.`);
    config.thinkingLevel = level.toUpperCase();
  }
  if (budget !== undefined) {
    const limits = profile?.thinkingBudget;
    if (!limits || typeof budget !== "number" || !Number.isSafeInteger(budget) ||
      !(budget === -1 || (budget === 0 && limits.canDisable) || (budget >= limits.min && budget <= limits.max))) {
      invalid(`Gemini model ${request.modelId} does not support the requested thinking budget.`);
    }
    config.thinkingBudget = budget;
  }
  // A transcript preference does not establish that a model supports thinking.
  // Do not send thinking-only options to older text models or unknown profiles.
  return profile?.supportsThinking === true ? config : undefined;
}

function resultToolName(request: ModelRequest): string | undefined {
  if (geminiModelProfile(request.modelId)?.supportsJsonWithTools === true || request.responseFormat?.type !== "jsonSchema" ||
    request.toolChoice?.type === "none" || !request.tools?.length) return undefined;
  const names = new Set(request.tools.map((tool) => tool.name));
  let name = "brainstorm_final_result";
  for (let suffix = 1; names.has(name); suffix++) name = `brainstorm_final_result_${suffix}`;
  return name;
}

function requestParams(request: ModelRequest, maxOutputTokens: number | undefined, signal?: AbortSignal): { params: Wire; finalTool?: string } {
  const contents = messagesToContents(request.messages);
  if (!contents.length) invalid("Gemini requests require at least one message.");
  if ((request.nativeOperations?.length ?? 0) > 0) invalid("Gemini native operations are not configured; use host tools.");
  const thinking = thinkingConfig(request);
  const plainJsonWithTools = geminiModelProfile(request.modelId)?.supportsJsonWithTools !== true &&
    request.responseFormat?.type === "json" && request.toolChoice?.type !== "none" && (request.tools?.length ?? 0) > 0;
  const config: Wire = {
    candidateCount: 1,
    // The host owns tools, retries and budgets. Never hide extra model calls inside the SDK.
    automaticFunctionCalling: { disable: true },
    automaticContinuation: false,
    ...(thinking ? { thinkingConfig: thinking } : {}),
    ...(signal ? { abortSignal: signal } : {}),
  };
  const finalTool = resultToolName(request);
  let system = systemPromptText(request.system);
  if (finalTool) system = [system, `Use the available host tools as needed. When the task is complete, call ${finalTool} exactly once with the final structured result. Do not return the final result as ordinary text. This result tool does not replace required submit_step calls.`].filter(Boolean).join("\n\n");
  if (plainJsonWithTools) system = [system, "Use the available host tools as needed. When the task is complete, return only valid JSON as the final response, without Markdown or commentary."].filter(Boolean).join("\n\n");
  if (system !== undefined) config.systemInstruction = system;
  const limit = positive(request.maxOutputTokens ?? maxOutputTokens, "Gemini maxOutputTokens");
  if (limit !== undefined) config.maxOutputTokens = limit;
  if (request.temperature !== undefined) config.temperature = request.temperature;
  if (request.topP !== undefined) config.topP = request.topP;
  if (request.stopSequences?.length) config.stopSequences = [...request.stopSequences];
  const tools = request.toolChoice?.type === "none" ? [] : request.tools ?? [];
  if (tools.length) {
    const declarations = tools.map((tool) => ({ name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}), parametersJsonSchema: tool.inputSchema }));
    if (finalTool && request.responseFormat?.type === "jsonSchema") declarations.push({ name: finalTool,
      description: "Deliver the final structured result after all required host tool and argument-step work is complete.", parametersJsonSchema: request.responseFormat.schema });
    config.tools = [{ functionDeclarations: declarations }];
    const choice = request.toolChoice;
    if (choice?.type === "tool" && !tools.some((tool) => tool.name === choice.name)) invalid(`Gemini requested an undeclared tool: ${choice.name}.`);
    config.toolConfig = { functionCallingConfig: {
      mode: choice?.type === "required" || choice?.type === "tool" ? "ANY" : "AUTO",
      ...(choice?.type === "tool" ? { allowedFunctionNames: [choice.name] } : {}),
    } };
  } else if (request.toolChoice?.type === "required" || request.toolChoice?.type === "tool") invalid("Gemini tool choice requires tools.");
  // Older models cannot combine constrained JSON generation with tool use. An
  // internal result function keeps the schema and the existing host validator,
  // without exposing that function to host dispatch. Only documented profiles
  // use native JSON alongside tools. Unconstrained JSON permits scalar/array
  // results as well, so it uses an instruction and the existing host parser.
  // https://ai.google.dev/gemini-api/docs/generate-content/structured-output
  // ANY mode produces only function calls; Gemini rejects a JSON response
  // MIME type on those turns even for modern models. The schema applies when
  // the host permits a final answer on a later turn.
  const forcedTool = request.toolChoice?.type === "required" || request.toolChoice?.type === "tool";
  if (!finalTool && !plainJsonWithTools && !forcedTool && (request.responseFormat?.type === "json" || request.responseFormat?.type === "jsonSchema")) {
    config.responseMimeType = "application/json";
    if (request.responseFormat.type === "jsonSchema") config.responseJsonSchema = request.responseFormat.schema;
  }
  return { params: { model: request.modelId.replace(/^models\//, ""), contents, config }, ...(finalTool ? { finalTool } : {}) };
}

function responseBlocks(parts: unknown, includeThoughts: boolean, finalTool?: string): ContentBlock[] {
  if (!Array.isArray(parts)) return [];
  return parts.map((raw): ContentBlock => {
    const part = record(raw);
    // Metadata belongs to the wire history, not human-readable thinking. Never merge signed Parts.
    const metadata: JsonObject = { gemini: { part: json(part) } };
    if (part.functionCall) {
      const fn = record(part.functionCall);
      if (typeof fn.name !== "string" || !fn.name) invalid("Gemini returned a function call without a name.");
      if (fn.name === finalTool) return { type: "text", text: JSON.stringify(fn.args ?? {}),
        metadata: { gemini: { part: json(part), finalResult: true } } };
      return { type: "tool_use", id: typeof fn.id === "string" && fn.id ? fn.id : `gemini-${randomUUID()}`,
        name: fn.name, input: json(fn.args ?? {}), metadata };
    }
    if (typeof part.text === "string") {
      return part.thought === true
        ? { type: "thinking", text: includeThoughts ? part.text : "", metadata }
        : { type: "text", text: part.text, metadata };
    }
    // A signature-only Part still has to travel back even with transcripts off.
    if (typeof part.thoughtSignature === "string") return { type: "thinking", text: "", metadata };
    invalid("Gemini returned an unsupported non-text output part.");
  });
}

function stopReason(reason: unknown, blocks: readonly ContentBlock[], blocked: unknown): StopReason {
  if (blocked || ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"].includes(String(reason))) return "content_filter";
  if (reason === "MAX_TOKENS" || reason === "CONTINUATION") return "max_tokens";
  if (reason === "MALFORMED_FUNCTION_CALL" || reason === "UNEXPECTED_TOOL_CALL") return "error";
  if (blocks.some((block) => block.type === "tool_use")) return "tool_use";
  return reason === "STOP" ? "end_turn" : "other";
}
function tokens(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }

export class GeminiModelProvider implements ModelProvider {
  readonly providerId = "gemini";
  readonly #client: GeminiClient;
  readonly #config: GeminiModelProviderConfig;
  #models: readonly GeminiDiscoveredModel[] | undefined;
  constructor(config: GeminiModelProviderConfig) {
    positive(config.maxOutputTokens, "Gemini maxOutputTokens");
    this.#config = config;
    this.#client = createGeminiClient(config);
  }
  async listModels(options?: CallOptions): Promise<readonly ModelDescriptor[]> {
    throwIfAborted(options?.signal);
    // ModelProvider routing must not repeatedly make discovery calls during a run.
    if (!this.#models) this.#models = await discoverGeminiModels({ ...this.#config, client: this.#client, signal: options?.signal });
    return this.#models.map((row) => ({ modelId: row.id, ...(row.displayName ? { displayName: row.displayName } : {}), capabilities: geminiCapabilities(row.id, row) }));
  }
  async getCapabilities(modelId: string, options?: CallOptions): Promise<ModelCapabilities | undefined> {
    throwIfAborted(options?.signal);
    const id = modelId.replace(/^models\//, "");
    const row = this.#models?.find((model) => model.id === id);
    // An explicitly configured model may be private/new; controls remain unknown unless documented.
    return row || id === this.#config.model?.replace(/^models\//, "") || geminiModelProfile(id)
      ? geminiCapabilities(id, row) : undefined;
  }
  async complete(request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    const signal = options?.signal;
    throwIfAborted(signal);
    const model = request.modelId.trim() || this.#config.model;
    if (!model) invalid("A Gemini model is required.");
    const resolved = { ...request, modelId: model };
    const { params, finalTool } = requestParams(resolved, this.#config.maxOutputTokens, signal);
    try {
      await this.#config.coordinator?.acquire(request.metadata?.dispatchPriority === "high" ? "high" : "normal", signal);
      throwIfAborted(signal);
      const raw = record(await abortable(this.#client.models.generateContent(params), signal));
      throwIfAborted(signal);
      const candidate = record(Array.isArray(raw.candidates) ? raw.candidates[0] : undefined);
      const blocks = responseBlocks(record(candidate.content).parts, resolved.providerOptions?.gemini?.includeThoughts === true, finalTool);
      const reason = stopReason(candidate.finishReason, blocks, record(raw.promptFeedback).blockReason);
      if (!Object.keys(candidate).length && reason !== "content_filter") throw new GeminiProviderError("Gemini returned no candidate.", "server", true);
      const usage = record(raw.usageMetadata);
      const thoughts = tokens(usage.thoughtsTokenCount);
      return { providerId: this.providerId, modelId: typeof raw.modelVersion === "string" ? raw.modelVersion : model,
        content: blocks, stopReason: reason,
        usage: { inputTokens: tokens(usage.promptTokenCount), outputTokens: tokens(usage.candidatesTokenCount) + thoughts,
          ...(typeof usage.thoughtsTokenCount === "number" ? { reasoningTokens: thoughts } : {}),
          ...(typeof usage.cachedContentTokenCount === "number" ? { cacheReadInputTokens: tokens(usage.cachedContentTokenCount) } : {}),
          ...(typeof usage.totalTokenCount === "number" ? { totalTokens: tokens(usage.totalTokenCount) } : {}),
        },
        metadata: { ...(typeof candidate.finishReason === "string" ? { finishReason: candidate.finishReason } : {}),
          ...(typeof raw.responseId === "string" ? { responseId: raw.responseId } : {}) },
      };
    } catch (error) {
      const classified = classifyGeminiError(error, signal);
      if (classified.category === "rate_limit") this.#config.coordinator?.block(Date.now() + (classified.retryAfterMs ?? 30_000), "gemini rate limit");
      throw classified;
    }
  }
}
