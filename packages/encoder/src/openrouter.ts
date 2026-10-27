/**
 * openrouter:<model> — the OpenRouter embeddings API (needs an API key).
 *
 * Every request sets provider.data_collection = "deny" so only providers that
 * do not retain or train on inputs may serve it. Documents and queries share
 * one mode unless the model documents an instruction prefix (table below).
 * The dimension and the verification head are learned from one probe call
 * when the encoder is created; a remote model has no pinned revision, so the
 * head is informative (the provider's resolved model name is recorded in
 * manifest.models) rather than a conformance gate.
 */
import type { EncodeMode, EncoderManifest, TextEncoder } from "@brainstorm-agentic/core";

import { l2normalise } from "./util.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const PROBE_TEXT = "graph generative models with Bernoulli adjacency";

/** Instruction prefixes documented on the model cards (matched on the model id). */
const PREFIXES: ReadonlyArray<{ readonly match: RegExp; readonly query: string; readonly doc: string }> = [
  { match: /(^|\/)(multilingual-)?e5-/i, query: "query: ", doc: "passage: " },
  { match: /nomic-embed-text/i, query: "search_query: ", doc: "search_document: " },
  { match: /(^|\/)bge-[a-z]+-en-v1\.5$/i, query: "Represent this sentence for searching relevant passages: ", doc: "" },
  {
    match: /qwen3-embedding/i,
    query: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
    doc: "",
  },
];

export function openRouterFormats(model: string): { docFormat: string; queryFormat: string } {
  const prefix = PREFIXES.find((entry) => entry.match.test(model));
  return {
    docFormat: `${prefix?.doc ?? ""}{title}. {body}`,
    queryFormat: `${prefix?.query ?? ""}{text}`,
  };
}

export interface OpenRouterEncoderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Texts per request (default 64). */
  readonly batchSize?: number;
  /** Retries on 429 / 5xx / network errors (default 3; 1 s, 2 s, 4 s, or Retry-After up to 30 s). */
  readonly maxRetries?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

interface EmbeddingsResponse {
  readonly data?: ReadonlyArray<{ readonly embedding?: readonly number[]; readonly index?: number }>;
  readonly model?: string;
  readonly error?: { readonly message?: string; readonly code?: number | string };
}

export async function createOpenRouterEncoder(options: OpenRouterEncoderOptions): Promise<TextEncoder> {
  if (!options.apiKey) throw new OpenRouterError(`openrouter:${options.model} needs an OpenRouter API key`);
  if (!options.model) throw new OpenRouterError("openrouter: empty model id");
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const batchSize = Math.max(1, options.batchSize ?? 64);
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const sleep = options.sleep ?? defaultSleep;
  const formats = openRouterFormats(options.model);
  let resolvedModel = "";

  async function request(input: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const body = JSON.stringify({
      model: options.model,
      input,
      encoding_format: "float",
      provider: { data_collection: "deny" },
    });
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted || attempt >= maxRetries) throw error;
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= maxRetries) {
          throw new OpenRouterError(`OpenRouter embeddings HTTP ${response.status}`, response.status);
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt;
        await response.body?.cancel().catch(() => undefined);
        await sleep(wait, signal);
        continue;
      }
      const payload = (await response.json().catch(() => ({}))) as EmbeddingsResponse;
      if (!response.ok || payload.error) {
        throw new OpenRouterError(
          `OpenRouter embeddings HTTP ${response.status}: ${payload.error?.message ?? "request failed"}`,
          response.status,
        );
      }
      const rows = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== input.length || rows.some((row) => !Array.isArray(row.embedding) || row.embedding.length === 0)) {
        throw new OpenRouterError(`OpenRouter embeddings: expected ${input.length} vectors, got ${rows.length}`);
      }
      if (payload.model) resolvedModel = payload.model;
      return rows.map((row) => l2normalise(row.embedding!));
    }
  }

  async function embedAll(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      out.push(...(await request(texts.slice(start, start + batchSize), signal)));
    }
    return out;
  }

  const queryPrefix = formats.queryFormat.slice(0, formats.queryFormat.indexOf("{text}"));
  const [probe] = await request([`${queryPrefix}${PROBE_TEXT}`]);
  const dim = probe!.length;
  const manifest: EncoderManifest = {
    id: `openrouter:${options.model}`,
    dim,
    version: 1,
    models: { [options.model]: resolvedModel || options.model },
    pooling: "mean",
    docFormat: formats.docFormat,
    queryFormat: formats.queryFormat,
    verification: [
      { text: PROBE_TEXT, mode: "query", head: Array.from(probe!.slice(0, 8), (x) => Math.round(x * 1e4) / 1e4), tolerance: 0.05 },
    ],
  };
  return {
    manifest,
    async embed(texts: readonly string[], mode: EncodeMode, signal?: AbortSignal): Promise<Float32Array[]> {
      const inputs = mode === "query" ? texts.map((text) => `${queryPrefix}${text}`) : texts;
      const vectors = await embedAll(inputs, signal);
      for (const vector of vectors) {
        if (vector.length !== dim) throw new OpenRouterError(`OpenRouter embeddings: dimension changed (${vector.length} != ${dim})`);
      }
      return vectors;
    },
  };
}
