import type { ModelRequest } from "./request.js";
import type { ModelResponse } from "./response.js";
import type { ProviderNativeOffer } from "../capability/types.js";

/** Feature flags a provider/model combination may or may not support. */
export interface ModelCapabilities {
  readonly toolUse: boolean;
  readonly parallelToolUse: boolean;
  readonly imageInput: boolean;
  readonly jsonOutput: boolean;
  readonly jsonSchemaOutput: boolean;
  readonly thinking: boolean;
  readonly systemPrompt: boolean;
  readonly stopSequences: boolean;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelDescriptor {
  readonly modelId: string;
  readonly displayName?: string;
  readonly capabilities: ModelCapabilities;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/**
 * Provider-neutral model gateway. Implementations (Anthropic, OpenAI, local,
 * fakes for tests) live outside core; core only depends on this interface.
 */
export interface ModelProvider {
  readonly providerId: string;
  /** Enumerate models this provider can serve, with their capabilities. */
  listModels(options?: CallOptions): Promise<readonly ModelDescriptor[]>;
  /** Capability lookup for a specific model; undefined when unknown. */
  getCapabilities(modelId: string, options?: CallOptions): Promise<ModelCapabilities | undefined>;
  /** Single-shot completion. Must reject with an AbortError when the signal fires. */
  complete(request: ModelRequest, options?: CallOptions): Promise<ModelResponse>;
}

/** Requirements an agent can declare so a router can pick a suitable model. */
export interface CapabilityRequirements {
  readonly toolUse?: boolean;
  readonly parallelToolUse?: boolean;
  readonly imageInput?: boolean;
  readonly jsonOutput?: boolean;
  readonly jsonSchemaOutput?: boolean;
  readonly thinking?: boolean;
  readonly systemPrompt?: boolean;
  readonly stopSequences?: boolean;
  readonly minContextTokens?: number;
  readonly minOutputTokens?: number;
}

/** Capability negotiation: does this model satisfy the stated requirements? */
export function satisfiesRequirements(
  capabilities: ModelCapabilities,
  requirements: CapabilityRequirements,
): boolean {
  const booleanKeys = [
    "toolUse",
    "parallelToolUse",
    "imageInput",
    "jsonOutput",
    "jsonSchemaOutput",
    "thinking",
    "systemPrompt",
    "stopSequences",
  ] as const;
  for (const key of booleanKeys) {
    if (requirements[key] === true && !capabilities[key]) return false;
  }
  if (
    requirements.minContextTokens !== undefined &&
    (capabilities.maxContextTokens ?? Infinity) < requirements.minContextTokens
  ) {
    return false;
  }
  if (
    requirements.minOutputTokens !== undefined &&
    (capabilities.maxOutputTokens ?? Infinity) < requirements.minOutputTokens
  ) {
    return false;
  }
  return true;
}

