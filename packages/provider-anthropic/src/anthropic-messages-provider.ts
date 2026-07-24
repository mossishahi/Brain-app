import Anthropic from "@anthropic-ai/sdk";

import type {
  CallOptions,
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  JsonObject,
  JsonValue,
  ModelCapabilities,
  ModelDescriptor,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ResponseFormat,
  StopReason,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "./core-adapter.js";
import {
  AnthropicProviderError,
  classifyAnthropicError,
} from "./errors.js";

type WireRecord = Record<string, unknown>;

export interface AnthropicRequestOptions {
  readonly signal?: AbortSignal;
}

export interface AnthropicMessagesClient {
  readonly messages: {
    create(
      body: WireRecord,
      options?: AnthropicRequestOptions,
    ): Promise<unknown>;
  };
}

export interface AnthropicMessagesProviderConfig {
  readonly apiKey?: string;
  /** Configured model advertised by listModels(). */
  readonly model: string;
  readonly displayName?: string;
  readonly baseURL?: string;
  readonly maxTokens?: number;
  readonly capabilities?: Partial<ModelCapabilities>;
  readonly clientOptions?: WireRecord;
  readonly providerOptions?: WireRecord;
  /** Official-SDK boundary injection for deterministic tests. */
  readonly client?: AnthropicMessagesClient;
}

interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: WireRecord[];
}

const BASE_CAPABILITIES: ModelCapabilities = {
  toolUse: true,
  parallelToolUse: true,
  imageInput: true,
  jsonOutput: true,
  jsonSchemaOutput: true,
  thinking: false,
  systemPrompt: true,
  stopSequences: true,
};

function asWireRecord(value: unknown): WireRecord {
  return value !== null && typeof value === "object"
    ? (value as WireRecord)
    : {};
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AnthropicProviderError(
      "Anthropic request was cancelled.",
      "aborted",
      false,
      undefined,
      "ABORT_ERR",
      undefined,
      { cause: signal.reason },
    );
  }
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
  return Object.values(value as WireRecord).every(isJsonValue);
}

function requireJsonValue(value: unknown, description: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new AnthropicProviderError(
      `Anthropic returned non-JSON ${description}.`,
      "unknown",
      false,
    );
  }
  return value;
}

function mapImageSource(source: ImageBlock["source"]): WireRecord {
  return source.kind === "base64"
    ? {
        type: "base64",
        media_type: source.mediaType,
        data: source.data,
      }
    : { type: "url", url: source.url };
}

function mapImage(block: ImageBlock): WireRecord {
  return { type: "image", source: mapImageSource(block.source) };
}

function mapDocument(block: DocumentBlock): WireRecord {
  const source =
    block.source.kind === "base64"
      ? {
          type: "base64",
          media_type: block.source.mediaType,
          data: block.source.data,
        }
      : { type: "url", url: block.source.url };
  return {
    type: "document",
    source,
    ...(block.title !== undefined ? { title: block.title } : {}),
    ...(block.context !== undefined ? { context: block.context } : {}),
  };
}

function mapToolResultContent(
  content: Extract<ContentBlock, { type: "tool_result" }>["content"],
): WireRecord[] {
  return content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : block.type === "image"
        ? mapImage(block)
        : mapDocument(block),
  );
}

function mapRequestBlock(block: ContentBlock): WireRecord {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return mapImage(block);
    case "document":
      return mapDocument(block);
    case "thinking": {
      const signature = block.metadata?.signature;
      return typeof signature === "string"
        ? {
            type: "thinking",
            thinking: block.text,
            signature,
          }
        : { type: "text", text: block.text };
    }
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: mapToolResultContent(block.content),
        is_error: block.isError === true,
      };
  }
}

function mapMessages(messages: readonly ModelMessage[]): WireMessage[] {
  const mapped: Array<{
    role: "user" | "assistant";
    content: WireRecord[];
  }> = [];
  for (const message of messages) {
    const content = message.content.map(mapRequestBlock);
    if (content.length === 0) {
      continue;
    }
    const previous = mapped.at(-1);
    if (previous?.role === message.role) {
      previous.content.push(...content);
    } else {
      mapped.push({ role: message.role, content: [...content] });
    }
  }
  return mapped;
}

function mapTool(definition: ToolDefinition): WireRecord {
  return {
    name: definition.name,
    ...(definition.description !== undefined
      ? { description: definition.description }
      : {}),
    input_schema: definition.inputSchema,
  };
}

function mapToolChoice(choice: ToolChoice): WireRecord | undefined {
  switch (choice.type) {
    case "none":
      return undefined;
    case "auto":
      return { type: "auto" };
    case "required":
      return { type: "any" };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}

function schemaForFormat(format: ResponseFormat): JsonObject | undefined {
  switch (format.type) {
    case "text":
      return undefined;
    case "json":
      return {};
    case "jsonSchema":
      return format.schema;
  }
}

function mapStopReason(value: unknown): StopReason {
  switch (value) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "other";
  }
}

function mapResponseContent(value: unknown): readonly ContentBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const content: ContentBlock[] = [];
  for (const item of value) {
    const block = asWireRecord(item);
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: requireJsonValue(block.input ?? {}, "tool input"),
      });
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const metadata: Record<string, JsonValue> = {};
      if (typeof block.signature === "string") {
        metadata.signature = block.signature;
      }
      content.push({
        type: "thinking",
        text: block.thinking,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      continue;
    }
    if (
      block.type === "redacted_thinking" &&
      typeof block.data === "string"
    ) {
      content.push({
        type: "thinking",
        text: "",
        metadata: { redactedData: block.data },
      });
    }
  }
  return content;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function mapUsage(value: unknown): TokenUsage {
  const usage = asWireRecord(value);
  const inputTokens = numberOrZero(usage.input_tokens);
  const outputTokens = numberOrZero(usage.output_tokens);
  const cacheReadInputTokens = optionalNumber(
    usage.cache_read_input_tokens,
  );
  const cacheWriteInputTokens = optionalNumber(
    usage.cache_creation_input_tokens,
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens }
      : {}),
    ...(cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens }
      : {}),
  };
}

function positiveInteger(
  value: unknown,
  description: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new AnthropicProviderError(
      `${description} must be a positive integer.`,
      "validation",
      false,
    );
  }
  return value;
}

function responseMetadata(raw: WireRecord): JsonObject {
  const anthropic: Record<string, JsonValue> = {};
  if (typeof raw.id === "string") {
    anthropic.messageId = raw.id;
  }
  if (typeof raw.stop_sequence === "string") {
    anthropic.stopSequence = raw.stop_sequence;
  }
  return { anthropic };
}

export class AnthropicMessagesProvider implements ModelProvider {
  public readonly providerId = "anthropic";

  readonly #client: AnthropicMessagesClient;
  readonly #model: string;
  readonly #displayName?: string;
  readonly #maxTokens: number;
  readonly #capabilities: ModelCapabilities;
  readonly #providerOptions: WireRecord;

  public constructor(config: AnthropicMessagesProviderConfig) {
    if (config.model.trim() === "") {
      throw new AnthropicProviderError(
        "Anthropic provider configuration requires a model.",
        "validation",
        false,
      );
    }
    this.#model = config.model;
    this.#displayName = config.displayName;
    this.#maxTokens =
      positiveInteger(config.maxTokens, "Anthropic maxTokens") ?? 4_096;
    this.#capabilities = {
      ...BASE_CAPABILITIES,
      maxOutputTokens: this.#maxTokens,
      ...(config.capabilities ?? {}),
    };
    this.#providerOptions = { ...(config.providerOptions ?? {}) };

    if (config.client !== undefined) {
      this.#client = config.client;
      return;
    }

    const clientOptions: WireRecord = { ...(config.clientOptions ?? {}) };
    if (config.apiKey !== undefined) {
      clientOptions.apiKey = config.apiKey;
    }
    if (config.baseURL !== undefined) {
      clientOptions.baseURL = config.baseURL;
    }
    this.#client = new Anthropic(
      clientOptions as ConstructorParameters<typeof Anthropic>[0],
    ) as unknown as AnthropicMessagesClient;
  }

  public async listModels(
    options?: CallOptions,
  ): Promise<readonly ModelDescriptor[]> {
    throwIfAborted(options?.signal);
    return [
      {
        modelId: this.#model,
        ...(this.#displayName !== undefined
          ? { displayName: this.#displayName }
          : {}),
        capabilities: this.#capabilities,
      },
    ];
  }

  public async getCapabilities(
    modelId: string,
    options?: CallOptions,
  ): Promise<ModelCapabilities | undefined> {
    throwIfAborted(options?.signal);
    return modelId === this.#model ? this.#capabilities : undefined;
  }

  public async complete(
    request: ModelRequest,
    options?: CallOptions,
  ): Promise<ModelResponse> {
    const signal = options?.signal;
    throwIfAborted(signal);
    if (request.modelId.trim() === "") {
      throw new AnthropicProviderError(
        "ModelRequest.modelId cannot be empty.",
        "validation",
        false,
      );
    }

    const escaped = {
      ...this.#providerOptions,
      ...(request.providerOptions?.anthropic ?? {}),
    };
    const maxOutputTokens =
      positiveInteger(
        request.maxOutputTokens ?? escaped.max_tokens,
        "maxOutputTokens",
      ) ?? this.#maxTokens;
    const messages = mapMessages(request.messages);
    if (messages.length === 0) {
      throw new AnthropicProviderError(
        "Anthropic requests require at least one message.",
        "validation",
        false,
      );
    }

    const params: WireRecord = {
      ...escaped,
      model: request.modelId,
      max_tokens: maxOutputTokens,
      messages,
      stream: false,
    };
    delete params.system;
    delete params.tools;
    delete params.tool_choice;

    if (request.system !== undefined) {
      params.system = request.system;
    }
    const tools =
      request.toolChoice?.type === "none" ? [] : (request.tools ?? []);
    if (tools.length > 0) {
      params.tools = tools.map(mapTool);
      const choice =
        request.toolChoice === undefined
          ? undefined
          : mapToolChoice(request.toolChoice);
      if (choice !== undefined) {
        params.tool_choice = choice;
      }
    }
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
      params.top_p = request.topP;
    }
    if (request.stopSequences !== undefined) {
      params.stop_sequences = [...request.stopSequences];
    }

    if (request.responseFormat !== undefined) {
      const schema = schemaForFormat(request.responseFormat);
      if (schema !== undefined) {
        params.output_config = {
          ...asWireRecord(escaped.output_config),
          format: {
            type: "json_schema",
            schema,
          },
        };
      } else {
        delete params.output_config;
      }
    }

    try {
      const rawResponse = await this.#client.messages.create(
        params,
        signal === undefined ? undefined : { signal },
      );
      throwIfAborted(signal);
      const raw = asWireRecord(rawResponse);
      return {
        providerId: this.providerId,
        modelId:
          typeof raw.model === "string" ? raw.model : request.modelId,
        content: mapResponseContent(raw.content),
        stopReason: mapStopReason(raw.stop_reason),
        usage: mapUsage(raw.usage),
        metadata: responseMetadata(raw),
      };
    } catch (error) {
      throw classifyAnthropicError(error, signal);
    }
  }
}
