import { GoogleGenAI } from "@google/genai";
import type { ModelCapabilities } from "@brainstorm-agentic/core";
import { abortable, classifyGeminiError, record, throwIfAborted, GeminiProviderError } from "./errors.js";

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";
export interface GeminiModelProfile {
  readonly thinkingLevels: readonly GeminiThinkingLevel[];
  readonly supportsThinking: boolean;
  /** Only documented combinations may mix native constrained JSON and tools. */
  readonly supportsJsonWithTools?: boolean;
  readonly thinkingBudget?: { readonly min: number; readonly max: number; readonly canDisable: boolean };
}

const LEVELS = ["minimal", "low", "medium", "high"] as const;
const PROFILES: Readonly<Record<string, GeminiModelProfile>> = {
  "gemini-4-argon": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: ["low", "medium", "high"] },
  "gemini-3.8-flash": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: ["low", "medium", "high"] },
  "gemini-3.7-flash": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: ["low", "medium", "high"] },
  "gemini-3.6-flash": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: LEVELS },
  "gemini-3.5-flash": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: LEVELS },
  "gemini-3.5-flash-lite": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: LEVELS },
  "gemini-3.1-flash-lite-preview": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: LEVELS },
  "gemini-3.1-flash-lite": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: LEVELS },
  "gemini-3.1-pro-preview": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: ["low", "medium", "high"] },
  "gemini-3-flash-preview": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: LEVELS },
  "gemini-3-pro-preview": { supportsThinking: true, supportsJsonWithTools: true, thinkingLevels: ["low", "high"] },
  "gemini-2.5-pro": { supportsThinking: true, thinkingLevels: [], thinkingBudget: { min: 128, max: 32768, canDisable: false } },
  "gemini-2.5-flash": { supportsThinking: true, thinkingLevels: [], thinkingBudget: { min: 0, max: 24576, canDisable: true } },
  "gemini-2.5-flash-lite": { supportsThinking: true, thinkingLevels: [], thinkingBudget: { min: 512, max: 24576, canDisable: true } },
};

/** Explicit profiles, not a guess from a future model's family or alias.
 * Sources checked 2026-10-30:
 * https://ai.google.dev/gemini-api/docs/generate-content/thinking
 * https://ai.google.dev/gemini-api/docs/thinking
 */
export function geminiModelProfile(model: string): GeminiModelProfile | undefined {
  const value = PROFILES[model.replace(/^models\//, "")];
  return value === undefined ? undefined : structuredClone(value);
}

export interface GeminiClient {
  readonly models: {
    generateContent(params: Record<string, unknown>): Promise<unknown>;
    list(params: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
  };
}
export interface GeminiDiscoveryConfig {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly signal?: AbortSignal;
  readonly client?: GeminiClient;
}
export interface GeminiDiscoveredModel {
  readonly id: string;
  readonly displayName?: string;
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
  readonly profile?: GeminiModelProfile;
}

export function createGeminiClient(config: Pick<GeminiDiscoveryConfig, "apiKey" | "baseURL" | "client">): GeminiClient {
  if (config.client) return config.client;
  if (!config.apiKey.trim()) throw new GeminiProviderError("A Gemini API key is required.", "validation", false);
  return new GoogleGenAI({ apiKey: config.apiKey, vertexai: false,
    httpOptions: { ...(config.baseURL ? { baseUrl: config.baseURL } : {}), retryOptions: { attempts: 1 } },
  }) as unknown as GeminiClient;
}

/** Keep generative text models; never advertise an image/audio/agent model as a pipeline executor. */
export function isGeminiTextModel(value: unknown): boolean {
  const row = record(value);
  const name = typeof row.name === "string" ? row.name.replace(/^models\//, "") : "";
  const actions = row.supportedActions ?? row.supportedGenerationMethods;
  return /^gemini-/.test(name) && !/(?:image|audio|tts|live|transcribe|nano-banana|embedding|embed|robotics|computer-use|agent|deep-research|aqa)/i.test(name) &&
    Array.isArray(actions) && actions.includes("generateContent");
}

export async function discoverGeminiModels(config: GeminiDiscoveryConfig): Promise<readonly GeminiDiscoveredModel[]> {
  throwIfAborted(config.signal);
  try {
    const pager = await abortable(createGeminiClient(config).models.list({ config: { pageSize: 100, queryBase: true, ...(config.signal ? { abortSignal: config.signal } : {}) } }), config.signal);
    const iterator = pager[Symbol.asyncIterator]();
    const found = new Map<string, GeminiDiscoveredModel>();
    for (;;) {
      const next = await abortable(iterator.next(), config.signal);
      if (next.done) break;
      if (!isGeminiTextModel(next.value)) continue;
      const row = record(next.value);
      const id = String(row.name).replace(/^models\//, "");
      found.set(id, {
        id,
        ...(typeof row.displayName === "string" ? { displayName: row.displayName } : {}),
        ...(typeof row.inputTokenLimit === "number" && row.inputTokenLimit > 0 ? { inputTokenLimit: row.inputTokenLimit } : {}),
        ...(typeof row.outputTokenLimit === "number" && row.outputTokenLimit > 0 ? { outputTokenLimit: row.outputTokenLimit } : {}),
        ...(geminiModelProfile(id) ? { profile: geminiModelProfile(id) } : {}),
      });
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) { throw classifyGeminiError(error, config.signal); }
}

export function geminiCapabilities(model: string, limits?: GeminiDiscoveredModel): ModelCapabilities {
  return { toolUse: true, parallelToolUse: true, imageInput: true, jsonOutput: true, jsonSchemaOutput: true,
    thinking: geminiModelProfile(model)?.supportsThinking === true, systemPrompt: true, stopSequences: true,
    ...(limits?.inputTokenLimit ? { maxContextTokens: limits.inputTokenLimit } : {}),
    ...(limits?.outputTokenLimit ? { maxOutputTokens: limits.outputTokenLimit } : {}),
  };
}
