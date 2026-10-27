/**
 * Shared helpers: checksums, the canonical node-texts serialisation, the
 * document formats of an encoder manifest, and the conformance check.
 */
import { createHash } from "node:crypto";
import { endianness } from "node:os";

import type { EncodeMode, EncoderManifest, TextEncoder } from "@brainstorm-agentic/core";

/** Default absolute tolerance of a verification head (contract G). */
export const DEFAULT_HEAD_TOLERANCE = 2e-3;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * sha256 of a node-texts entries array serialised canonically: compact JSON,
 * keys sorted (id, text), non-ASCII characters unescaped, UTF-8. Equal to the
 * `sha256` field of catalog/taxonomy-texts.json and to Python's
 * `json.dumps(entries, ensure_ascii=False, separators=(",", ":"), sort_keys=True)`.
 */
export function nodeTextsSha256(texts: ReadonlyArray<{ readonly id: string; readonly text: string }>): string {
  return sha256Hex(JSON.stringify(texts.map((entry) => ({ id: entry.id, text: entry.text }))));
}

/** The vectors as float32 little-endian bytes (row-major), without copying. */
export function vectorBytes(vectors: Float32Array): Uint8Array {
  if (endianness() !== "LE") {
    const copy = new Uint8Array(vectors.byteLength);
    const view = new DataView(copy.buffer);
    for (let i = 0; i < vectors.length; i += 1) view.setFloat32(i * 4, vectors[i]!, true);
    return copy;
  }
  return new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength);
}

/** sha256 over the float32 little-endian bytes (the prototype's `vectors_sha256`). */
export function vectorsSha256(vectors: Float32Array): string {
  return sha256Hex(vectorBytes(vectors));
}

/** Replace `{name}` placeholders literally (no `$` patterns, every occurrence). */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(title|body|text)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * One document as the encoder expects it in "doc" mode: the manifest's
 * docFormat with {title} and {body} filled in, trimmed (leading and trailing
 * whitespace never changes a BERT tokenization). Callers format documents
 * with this before `embed(texts, "doc")`; embed embeds doc texts as given.
 */
export function formatDocument(manifest: Pick<EncoderManifest, "docFormat">, title: string, body: string): string {
  return fill(manifest.docFormat, { title, body }).trim();
}

/**
 * One taxonomy node text ("<name>. <body>", catalog/taxonomy-texts.json) as a
 * document: split at its FIRST ". " into title and body and formatted with
 * docFormat, so SPECTER2 sees "<name>[SEP]<body>" exactly as the prototype's
 * node vectors were built. A text without ". " is embedded as given.
 */
export function nodeDocument(manifest: Pick<EncoderManifest, "docFormat">, text: string): string {
  const cut = text.indexOf(". ");
  if (cut < 0) return text.trim();
  return formatDocument(manifest, text.slice(0, cut), text.slice(cut + 2));
}

/** A query as the encoder feeds it to the model: queryFormat with {text}. */
export function formatQuery(manifest: Pick<EncoderManifest, "queryFormat">, text: string): string {
  return fill(manifest.queryFormat, { text });
}

/** L2-normalise in float64 and return float32. */
export function l2normalise(values: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let i = 0; i < values.length; i += 1) norm += values[i]! * values[i]!;
  norm = Math.sqrt(norm);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = norm > 0 ? values[i]! / norm : 0;
  return out;
}

export interface ConformanceResult {
  readonly ok: boolean;
  /** Largest |head - local| over every verification entry. */
  readonly worst: number;
  readonly failures: ReadonlyArray<{ readonly index: number; readonly mode: EncodeMode; readonly diff: number; readonly tolerance: number }>;
}

/**
 * Embed every verification text in its mode and compare the first dims with
 * the manifest heads. A local encoder that fails this must not be used. Each
 * text is embedded on its own, as the heads were computed: dynamically
 * quantized (int8) graphs scale activations per batch tensor, so their
 * vectors depend on the batch a text shares.
 */
export async function checkConformance(encoder: TextEncoder, signal?: AbortSignal): Promise<ConformanceResult> {
  const failures: Array<{ index: number; mode: EncodeMode; diff: number; tolerance: number }> = [];
  let worst = 0;
  const entries = encoder.manifest.verification;
  for (const [index, entry] of entries.entries()) {
    const [vector = new Float32Array(0)] = await encoder.embed([entry.text], entry.mode, signal);
    let diff = vector.length === encoder.manifest.dim ? 0 : Number.POSITIVE_INFINITY;
    for (let dim = 0; dim < entry.head.length; dim += 1) {
      const local = vector[dim];
      const delta =
        local === undefined || !Number.isFinite(local) ? Number.POSITIVE_INFINITY : Math.abs(local - entry.head[dim]!);
      if (delta > diff) diff = delta;
    }
    worst = Math.max(worst, diff);
    const tolerance = entry.tolerance > 0 ? entry.tolerance : DEFAULT_HEAD_TOLERANCE;
    if (!(diff <= tolerance)) failures.push({ index, mode: entry.mode, diff, tolerance });
  }
  return { ok: entries.length > 0 && failures.length === 0, worst, failures };
}

/** Stable JSON (keys sorted recursively) for revision hashing. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The encoder revision a node-vector cache entry is tied to: sha256 over the
 * manifest's contract fields (id, dim, version, models — which for local
 * encoders include the graph checksums —, pooling, formats, verification).
 */
export function encoderRevision(manifest: EncoderManifest): string {
  const { id, dim, version, models, pooling, docFormat, queryFormat, verification } = manifest;
  return sha256Hex(stableStringify({ id, dim, version, models, pooling, docFormat, queryFormat, verification })).slice(0, 16);
}
