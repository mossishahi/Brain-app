/**
 * hash-ngram-v1 — the registry's deterministic text embedder.
 *
 * A feature-hashing n-gram embedder: word unigrams, adjacent word bigrams,
 * and padded character trigrams, FNV-1a-hashed into a fixed-dimension signed
 * vector, L2-normalized. Deliberately dependency-free and fully specified so
 * two independent implementations produce BIT-IDENTICAL vectors: the
 * registry embeds taxonomy nodes with its copy, the orchestrator embeds
 * query texts with its copy, and the two spaces must be the same space.
 *
 * SYNC CONTRACT: this file exists twice — brain/src/embedder.ts (node side)
 * and app/packages/core/src/embedder.ts (query side) — and the copies must
 * stay identical. Drift is detected, never silent: the manifest served with
 * the node vectors carries verification texts with expected checksums, and
 * the orchestrator refuses the embedding lane (falling back to lexical
 * matching) when its local implementation cannot reproduce them.
 *
 * The embedder is versioned by `id`. Swapping in a stronger (e.g. neural)
 * encoder means shipping a new id + manifest + node vectors on the server
 * and a matching implementation in the app — never mixing spaces.
 */

/** Locked spec constants of hash-ngram-v1. */
export const EMBEDDER_ID = "hash-ngram-v1";
export const EMBEDDER_DIM = 256;

/** Weights of the locked spec. */
const WORD_WEIGHT = 1;
const BIGRAM_WEIGHT = 1;
const TRIGRAM_WEIGHT = 0.5;

export interface EmbedderThresholds {
  /** Cosine at/above which an unmatched term auto-matches its best node. */
  readonly tauMatch: number;
  /** Minimum best-vs-runner-up margin for an unambiguous auto-match. */
  readonly delta: number;
  /** Cosine below which a term is treated as foreign to the whole tree. */
  readonly tauFloor: number;
  /** Weight of the active-region (facet heat) boost added to raw cosine. */
  readonly lambda: number;
}

export interface EmbedderVerification {
  readonly text: string;
  /** Checksum of embedText([{text, weight: 1}]) — see vectorChecksum. */
  readonly checksum: string;
}

export interface EmbedderManifest {
  readonly id: string;
  readonly dim: number;
  /** Bumped when the spec (not just thresholds) changes. */
  readonly version: number;
  readonly thresholds: EmbedderThresholds;
  /** How node/query texts are assembled, for the record. */
  readonly nodeTemplate: string;
  readonly queryTemplate: string;
  /** Conformance vectors: a client must reproduce these before embedding. */
  readonly verification: readonly EmbedderVerification[];
}

/** One weighted text part of an embedding input. */
export interface EmbedTextPart {
  readonly text: string;
  readonly weight: number;
}

/** Case, punctuation and spacing are noise (same rule as taxonomy lookup). */
function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** 32-bit FNV-1a over UTF-16 code units (all feature text is ASCII after normalize). */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function features(text: string): Array<readonly [string, number]> {
  const words = normalizeText(text).split(" ").filter(Boolean);
  const parts: Array<readonly [string, number]> = [];
  for (const word of words) parts.push([`w:${word}`, WORD_WEIGHT]);
  for (let i = 0; i + 1 < words.length; i += 1) {
    parts.push([`b:${words[i]} ${words[i + 1]}`, BIGRAM_WEIGHT]);
  }
  for (const word of words) {
    const padded = `^${word}$`;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      parts.push([`c:${padded.slice(i, i + 3)}`, TRIGRAM_WEIGHT]);
    }
  }
  return parts;
}

/**
 * Embed weighted text parts into one L2-normalized vector. Deterministic:
 * integer hashing, fixed accumulation order, one final normalization.
 */
export function embedText(parts: readonly EmbedTextPart[]): number[] {
  const vector = new Float64Array(EMBEDDER_DIM);
  for (const part of parts) {
    if (part.weight === 0) continue;
    for (const [feature, weight] of features(part.text)) {
      const hash = fnv1a(feature);
      const index = hash % EMBEDDER_DIM;
      const sign = ((hash >>> 24) & 1) === 1 ? 1 : -1;
      vector[index]! += sign * weight * part.weight;
    }
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDER_DIM; i += 1) norm += vector[i]! * vector[i]!;
  norm = Math.sqrt(norm);
  const out = new Array<number>(EMBEDDER_DIM);
  for (let i = 0; i < EMBEDDER_DIM; i += 1) {
    out[i] = norm > 0 ? vector[i]! / norm : 0;
  }
  return out;
}

/** Cosine of two L2-normalized vectors (plain dot product). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

/** Serialization rounding: stable files, negligible cosine error. */
export function roundVector(vector: readonly number[]): number[] {
  return vector.map((value) => Math.round(value * 10000) / 10000);
}

/**
 * The node-side text: the node's name carries the meaning, curated aliases
 * reinforce it, and the ancestor names (weight 0.25) pull siblings of one
 * branch together — the within-region coherence the matching lane leans on.
 */
export function nodeEmbedding(node: {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** Ancestor names, root first, EXCLUDING the node itself. */
  readonly ancestors?: readonly string[];
}): number[] {
  return embedText([
    { text: node.name, weight: 1 },
    ...(node.aliases ?? []).map((alias) => ({ text: alias, weight: 0.7 })),
    ...(node.ancestors ?? []).map((ancestor) => ({ text: ancestor, weight: 0.25 })),
  ]);
}

/** The query-side text for one pool term and its verbatim variants. */
export function termEmbedding(term: string, variants: readonly string[] = []): number[] {
  return embedText([
    { text: term, weight: 1 },
    ...variants
      .filter((variant) => normalizeText(variant) !== normalizeText(term))
      .map((variant) => ({ text: variant, weight: 0.5 })),
  ]);
}

/** The query-side text for one retrieval facet (name + statement). */
export function facetEmbedding(name: string, statement: string): number[] {
  return embedText([
    { text: name, weight: 1 },
    { text: statement, weight: 0.35 },
  ]);
}

/** FNV-1a hex checksum over the rounded vector, the conformance currency. */
export function vectorChecksum(vector: readonly number[]): string {
  return fnv1a(roundVector(vector).join(",")).toString(16).padStart(8, "0");
}

/**
 * Thresholds of hash-ngram-v1, calibrated on the taxonomy's 185 curated
 * aliases (held-out: each alias removed from its node's embedding, then
 * ranked against all nodes). Verdict: top-1 accuracy 56% with
 * high-scoring lexical false positives, top-10 recall 81% — so this
 * embedder PROPOSES and never decides: tauMatch is set above any observed
 * score (auto-match effectively off; only a near-duplicate could clear it),
 * and the lane's value is scored candidate lists for the placer, region
 * heat for seating, and place anchors for insert suggestions. A neural
 * encoder (next embedder id) lowers tauMatch to a real value after the same
 * sweep.
 */
export const EMBEDDER_THRESHOLDS: EmbedderThresholds = {
  tauMatch: 0.995,
  delta: 0.05,
  tauFloor: 0.3,
  lambda: 0.1,
};

/** Conformance texts: stable, spec-covering (case, '&', bigrams, trigrams). */
const VERIFICATION_TEXTS: readonly string[] = [
  "manifold learning",
  "Graph Neural Networks",
  "geometry & topology of data",
  "a",
];

/** Baked expected checksums; regenerate with computeVerification() on spec change. */
const VERIFICATION_CHECKSUMS: readonly string[] = [
  "d3a71d32",
  "93798f73",
  "583302ec",
  "730719c5",
];

export const EMBEDDER_MANIFEST: EmbedderManifest = {
  id: EMBEDDER_ID,
  dim: EMBEDDER_DIM,
  version: 1,
  thresholds: EMBEDDER_THRESHOLDS,
  nodeTemplate: "name(1) + aliases(0.7) + ancestors(0.25) @1",
  queryTemplate: "term(1) + variants(0.5) | facet name(1) + statement(0.35) @1",
  verification: VERIFICATION_TEXTS.map((text, index) => ({
    text,
    checksum: VERIFICATION_CHECKSUMS[index]!,
  })),
};

/** Recompute the verification table from the local implementation. */
export function computeVerification(): EmbedderVerification[] {
  return VERIFICATION_TEXTS.map((text) => ({
    text,
    checksum: vectorChecksum(embedText([{ text, weight: 1 }])),
  }));
}

/**
 * Whether the LOCAL implementation reproduces a manifest's verification
 * vectors exactly. A client must call this before trusting its own query
 * vectors against served node vectors; false means the spaces have drifted
 * and the embedding lane must stay off.
 */
export function verifyEmbedder(manifest: EmbedderManifest): boolean {
  if (manifest.id !== EMBEDDER_ID || manifest.dim !== EMBEDDER_DIM) return false;
  return manifest.verification.every(
    (entry) => vectorChecksum(embedText([{ text: entry.text, weight: 1 }])) === entry.checksum,
  );
}
