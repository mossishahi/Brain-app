/**
 * Text-encoder contracts for the paper-based panel composition: a pinned
 * neural (or hash-ngram fallback) encoder that embeds papers, needs and
 * taxonomy topics into one vector space, and the node-vector index of one
 * taxonomy revision under that encoder.
 *
 * Implementations live outside core: @brainstorm-agentic/encoder (local ONNX
 * models, the OpenRouter embeddings API) and the runtime's hash-ngram-v1
 * fallback (the dependency-free embedder of embedder.ts), so an offline run
 * still composes a panel.
 */

/** Papers, nodes and the core need embed as documents; facets as queries. */
export type EncodeMode = "doc" | "query";

export interface EncoderManifest {
  readonly id: string;
  readonly dim: number;
  readonly version: number;
  /** Model ids and revisions the encoder is pinned to. */
  readonly models: Readonly<Record<string, string>>;
  readonly pooling: "cls" | "mean";
  /** How a document / a query text is assembled before encoding, for the record. */
  readonly docFormat: string;
  readonly queryFormat: string;
  /** Conformance vectors: a local encoder must reproduce every head within tolerance. */
  readonly verification: ReadonlyArray<{
    readonly text: string;
    readonly mode: EncodeMode;
    /** First 8 dimensions, rounded to 1e-4. */
    readonly head: readonly number[];
    readonly tolerance: number;
  }>;
}

export interface TextEncoder {
  readonly manifest: EncoderManifest;
  /** One L2-normalised vector per text, in input order. */
  embed(texts: readonly string[], mode: EncodeMode, signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface NodeVectorIndex {
  readonly encoderId: string;
  readonly taxonomyRevision: number;
  readonly nodeTextsSha256: string;
  readonly vectorsSha256: string;
  readonly ids: readonly string[];
  readonly dim: number;
  /** Row-major ids.length x dim, L2-normalised. */
  readonly vectors: Float32Array;
}

export interface EncoderProvider {
  /** "specter2" | "bge-base-en-v1.5" | "hash-ngram-v1" | "openrouter:<model>"; unavailable -> {unavailable: reason}. */
  encoder(id: string): Promise<TextEncoder | { readonly unavailable: string }>;
  /** Registry-served when available, else computed from node texts and cached under cacheDir. */
  nodeIndex(
    encoder: TextEncoder,
    taxonomyRevision: number,
    texts: ReadonlyArray<{ id: string; text: string }>,
  ): Promise<NodeVectorIndex>;
}

/** The bundle's node texts (catalog/taxonomy-texts.json), when the bundle carries them. */
export interface NodeTextsAccess {
  texts(): Promise<
    | {
        readonly sha256: string;
        readonly entries: ReadonlyArray<{ readonly id: string; readonly text: string }>;
      }
    | undefined
  >;
}
