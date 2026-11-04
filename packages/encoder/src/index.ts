/**
 * @brainstorm-agentic/encoder
 *
 * createEncoderProvider (contract G of panel composition v2): the pinned text
 * encoders and the taxonomy node-vector index.
 *
 * - "specter2" | "bge-base-en-v1.5": local ONNX graphs under modelDir
 *   (env BRAINSTORM_AGENTIC_ENCODER_DIR overrides automatic pinned model provisioning), checked against the
 *   manifest's verification heads before use; env
 *   BRAINSTORM_AGENTIC_ENCODER_PRECISION=int8 selects the dynamic-int8 graphs
 *   (fp32 is used when the int8 graphs fail their heads on this CPU).
 * - "openrouter:<model>": the OpenRouter embeddings API (needs openRouterApiKey).
 * - "hash-ngram-v1": @brainstorm-agentic/core's dependency-free embedder.
 * Anything unavailable is reported as {unavailable: reason}, never thrown.
 *
 * Text conventions: callers format documents with formatDocument(manifest,
 * title, body) (manifest.docFormat) and embed them in "doc" mode as given;
 * embed(texts, "query") applies manifest.queryFormat itself. nodeIndex
 * embeds each node text with nodeDocument (split at the first ". ").
 */
import { availableParallelism } from "node:os";

import type { EncoderProvider, NodeVectorIndex, TextEncoder } from "@brainstorm-agentic/core";

import { createHashNgramEncoder } from "./hash.js";
import { createLocalEncoder, LOCAL_ENCODER_IDS, type Precision } from "./local.js";
import { buildNodeIndex, type RegistryNodeVectors } from "./node-index.js";
import { createOpenRouterEncoder } from "./openrouter.js";
import { checkConformance } from "./util.js";
import { provisionModel, recordModelRuntimeResult, type ModelDownloadOptions } from "./model-artifacts.js";

export * from "./util.js";
export * from "./model-artifacts.js";
export { createHashNgramEncoder, HASH_NGRAM_MANIFEST } from "./hash.js";
export { createLocalEncoder, LOCAL_ENCODER_IDS, type LocalEncoder, type LocalEncoderOptions, type Precision } from "./local.js";
export { buildNodeIndex, type NodeIndexOptions, type RegistryNodeVectors } from "./node-index.js";
export {
  createOpenRouterEncoder,
  openRouterFormats,
  OpenRouterError,
  OPENROUTER_BASE_URL,
  type OpenRouterEncoderOptions,
} from "./openrouter.js";

export interface EncoderProviderOptions {
  readonly modelDir?: string;
  /** Model weights are shared across jobs; cacheDir below remains the taxonomy-vector cache. */
  readonly modelCacheDir?: string;
  /** Dependency injection for offline installers/tests; defaults to the release-pinned catalog and HTTPS fetch. */
  readonly modelProvision?: Omit<ModelDownloadOptions, "modelDir" | "cacheRoot">;
  readonly openRouterApiKey?: string;
  readonly cacheDir?: string;
  readonly registry?: RegistryNodeVectors;
  readonly threads?: number;
}

type Resolved = TextEncoder | { readonly unavailable: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultThreads(): number {
  const fromEnv = Number(process.env.BRAINSTORM_AGENTIC_ENCODER_THREADS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(1, Math.min(8, availableParallelism()));
}

export function createEncoderProvider(options: EncoderProviderOptions = {}): EncoderProvider {
  const resolved = new Map<string, Promise<Resolved>>();
  const threads = options.threads ?? defaultThreads();
  const precision: Precision = process.env.BRAINSTORM_AGENTIC_ENCODER_PRECISION === "int8" ? "int8" : "fp32";

  async function resolve(id: string): Promise<Resolved> {
    if (id === "hash-ngram-v1") {
      try {
        const encoder = createHashNgramEncoder();
        const conformance = await checkConformance(encoder);
        return conformance.ok ? encoder : { unavailable: `hash-ngram-v1: verification heads not reproduced (|diff| ${conformance.worst})` };
      } catch (error) {
        return { unavailable: message(error) };
      }
    }
    if (LOCAL_ENCODER_IDS.includes(id)) {
      let modelDir: string;
      const provisioning = { ...options.modelProvision,
        ...(options.modelDir !== undefined ? { modelDir: options.modelDir } : {}),
        ...(options.modelCacheDir !== undefined ? { cacheRoot: options.modelCacheDir } : {}),
      };
      try {
        modelDir = await provisionModel(id, provisioning);
      } catch (error) { return { unavailable: `${id}: model preparation failed: ${message(error)}` }; }
      // int8 is opt-in; when its graphs do not reproduce their heads on this CPU, the fp32 graphs
      // (the reference) are used instead — manifest.models["onnx:doc"] records which graph ran.
      const reasons: string[] = [];
      for (const attempt of precision === "int8" ? (["int8", "fp32"] as const) : (["fp32"] as const)) {
        let encoder: Awaited<ReturnType<typeof createLocalEncoder>> | undefined;
        let accepted = false;
        try {
          encoder = await createLocalEncoder({ modelDir, id, threads, precision: attempt });
          const conformance = await checkConformance(encoder);
          if (conformance.ok) {
            await recordModelRuntimeResult(id, {}, provisioning).catch(() => {});
            accepted = true;
            return encoder;
          }
          const first = conformance.failures[0];
          reasons.push(
            `${id} (${attempt}): verification heads not reproduced` +
              (first ? ` (entry ${first.index}, ${first.mode}: |diff| ${first.diff.toExponential(2)} > ${first.tolerance})` : ""),
          );
        } catch (error) {
          reasons.push(`${id} (${attempt}): ${message(error)}`);
        } finally {
          if (encoder && !accepted) await encoder.release().catch(() => {});
        }
      }
      await recordModelRuntimeResult(id, { error: reasons.join("; ") }, provisioning).catch(() => {});
      return { unavailable: reasons.join("; ") };
    }
    if (id.startsWith("openrouter:")) {
      const model = id.slice("openrouter:".length);
      if (!model) return { unavailable: "openrouter: empty model id" };
      if (!options.openRouterApiKey) return { unavailable: `${id}: needs an OpenRouter API key (openRouterApiKey)` };
      try {
        return await createOpenRouterEncoder({ apiKey: options.openRouterApiKey, model });
      } catch (error) {
        return { unavailable: `${id}: ${message(error)}` };
      }
    }
    return { unavailable: `unknown encoder "${id}"` };
  }

  return {
    encoder(id: string): Promise<Resolved> {
      let pending = resolved.get(id);
      if (!pending) {
        pending = resolve(id);
        resolved.set(id, pending);
        // Failed downloads, repaired external exports and temporary API errors must be retryable.
        void pending.then((value) => {
          if ("unavailable" in value && resolved.get(id) === pending) resolved.delete(id);
        });
      }
      return pending;
    },
    nodeIndex(
      encoder: TextEncoder,
      taxonomyRevision: number,
      texts: ReadonlyArray<{ id: string; text: string }>,
    ): Promise<NodeVectorIndex> {
      return buildNodeIndex(encoder, taxonomyRevision, texts, {
        ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
        // The registry serves fp32 vectors; the spot check rejects them for int8 encoders.
        ...(options.registry ? { registry: options.registry } : {}),
      });
    },
  };
}
