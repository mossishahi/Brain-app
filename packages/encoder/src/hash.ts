/**
 * hash-ngram-v1 as a TextEncoder: a thin adapter over @brainstorm-agentic/core's
 * dependency-free embedder (the registry's node space). It is the fallback when
 * no neural encoder is available, so offline runs still compose a panel. Both
 * modes embed the text as given (one weighted part, weight 1).
 */
import {
  EMBEDDER_DIM,
  EMBEDDER_ID,
  EMBEDDER_MANIFEST,
  embedText,
  verifyEmbedder,
  type EncodeMode,
  type EncoderManifest,
  type TextEncoder,
} from "@brainstorm-agentic/core";

/** First 8 dims (1e-4) of embedText([{text, weight: 1}]) for core's conformance texts. */
const HASH_HEADS: ReadonlyArray<{ readonly text: string; readonly head: readonly number[] }> = [
  { text: "manifold learning", head: [0, 0, 0, 0, 0, 0, 0, 0] },
  { text: "Graph Neural Networks", head: [0, 0, 0, 0, 0, 0, 0, -0.1601] },
  { text: "geometry & topology of data", head: [0, 0, 0, 0, 0, 0, 0, 0] },
  { text: "a", head: [0, 0, 0, 0, 0, 0, 0, 0] },
];

export const HASH_NGRAM_MANIFEST: EncoderManifest = {
  id: EMBEDDER_ID,
  dim: EMBEDDER_DIM,
  version: EMBEDDER_MANIFEST.version,
  models: {},
  pooling: "mean",
  docFormat: "{title}. {body}",
  queryFormat: "{text}",
  verification: (["doc", "query"] as const).flatMap((mode) =>
    HASH_HEADS.map((entry) => ({ text: entry.text, mode, head: entry.head, tolerance: 1e-4 })),
  ),
};

export function createHashNgramEncoder(): TextEncoder {
  if (!verifyEmbedder(EMBEDDER_MANIFEST)) {
    throw new Error("hash-ngram-v1: the core embedder does not reproduce its own verification checksums");
  }
  return {
    manifest: HASH_NGRAM_MANIFEST,
    async embed(texts: readonly string[], _mode: EncodeMode, signal?: AbortSignal): Promise<Float32Array[]> {
      signal?.throwIfAborted();
      return texts.map((text) => Float32Array.from(embedText([{ text, weight: 1 }])));
    },
  };
}
