/**
 * The taxonomy node-vector index of one (encoder, encoder revision, node-texts
 * sha256, taxonomy revision): registry-served when the registry supplies a
 * matching index, else computed from the node texts and cached on disk.
 *
 * Cache layout: <cacheDir>/node-vectors/<encodeURIComponent(encoder id)>/<encoder
 * revision>/<node-texts sha256>-r<taxonomy revision>.{json,f32} — the .json
 * holds ids, dim and vectorsSha256; the .f32 holds float32 little-endian rows.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { NodeVectorIndex, TextEncoder } from "@brainstorm-agentic/core";

import { encoderRevision, nodeDocument, nodeTextsSha256, vectorBytes, vectorsSha256 } from "./util.js";

export interface RegistryNodeVectors {
  nodeIndex(encoderId: string, revision: number): Promise<NodeVectorIndex | undefined>;
}

export interface NodeIndexOptions {
  readonly cacheDir?: string;
  readonly registry?: RegistryNodeVectors;
  /** Called with one line per decision (registry used / rejected, cache hit, computed). */
  readonly log?: (line: string) => void;
  /** Max |registry - local| allowed on the spot-checked rows (default 2e-3). */
  readonly spotCheckTolerance?: number;
}

interface CacheMeta {
  readonly format: 1;
  readonly encoderId: string;
  readonly encoderRevision: string;
  readonly taxonomyRevision: number;
  readonly nodeTextsSha256: string;
  readonly vectorsSha256: string;
  readonly dim: number;
  readonly ids: readonly string[];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function rowsDiff(vectors: Float32Array, dim: number, rows: readonly number[], local: readonly Float32Array[]): number {
  let worst = 0;
  rows.forEach((row, k) => {
    for (let d = 0; d < dim; d += 1) {
      const delta = Math.abs(vectors[row * dim + d]! - local[k]![d]!);
      if (!(delta <= worst)) worst = Number.isNaN(delta) ? Number.POSITIVE_INFINITY : delta;
    }
  });
  return worst;
}

async function fromRegistry(
  encoder: TextEncoder,
  taxonomyRevision: number,
  texts: ReadonlyArray<{ id: string; text: string }>,
  sha: string,
  options: NodeIndexOptions,
): Promise<NodeVectorIndex | undefined> {
  const { manifest } = encoder;
  const log = options.log ?? (() => undefined);
  let served: NodeVectorIndex | undefined;
  try {
    served = await options.registry!.nodeIndex(manifest.id, taxonomyRevision);
  } catch (error) {
    log(`node vectors: registry lookup failed (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
  if (!served) return undefined;
  const ids = texts.map((entry) => entry.id);
  const reasons: string[] = [];
  if (served.encoderId !== manifest.id) reasons.push(`encoder ${served.encoderId}`);
  if (served.taxonomyRevision !== taxonomyRevision) reasons.push(`taxonomy revision ${served.taxonomyRevision}`);
  if (served.nodeTextsSha256 !== sha) reasons.push(`node texts ${served.nodeTextsSha256.slice(0, 12)} != ${sha.slice(0, 12)}`);
  if (served.dim !== manifest.dim) reasons.push(`dim ${served.dim}`);
  if (served.vectors.length !== served.ids.length * served.dim) reasons.push("vector count");
  if (!sameIds(served.ids, ids)) reasons.push("ids");
  if (reasons.length === 0 && vectorsSha256(served.vectors) !== served.vectorsSha256) reasons.push("vectors sha256");
  if (reasons.length === 0) {
    // Content check: the served rows must be in this encoder's space (catches fp32/int8 or graph drift).
    const rows = [...new Set([0, Math.floor(ids.length / 2), ids.length - 1])].filter((row) => row >= 0);
    const local = await encoder.embed(rows.map((row) => nodeDocument(manifest, texts[row]!.text)), "doc");
    const diff = rowsDiff(served.vectors, served.dim, rows, local);
    const tolerance = options.spotCheckTolerance ?? 2e-3;
    if (!(diff <= tolerance)) reasons.push(`spot check |diff| ${diff.toExponential(2)} > ${tolerance}`);
  }
  if (reasons.length > 0) {
    log(`node vectors: registry index for ${manifest.id} r${taxonomyRevision} rejected (${reasons.join("; ")})`);
    return undefined;
  }
  log(`node vectors: registry index for ${manifest.id} r${taxonomyRevision} (${ids.length} x ${served.dim})`);
  return served;
}

export async function buildNodeIndex(
  encoder: TextEncoder,
  taxonomyRevision: number,
  texts: ReadonlyArray<{ id: string; text: string }>,
  options: NodeIndexOptions = {},
  signal?: AbortSignal,
): Promise<NodeVectorIndex> {
  const { manifest } = encoder;
  const log = options.log ?? (() => undefined);
  const ids = texts.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error("node texts contain duplicate ids");
  const sha = nodeTextsSha256(texts);

  if (options.registry) {
    const served = await fromRegistry(encoder, taxonomyRevision, texts, sha, options);
    if (served) return served;
  }

  const revision = encoderRevision(manifest);
  const dir = options.cacheDir
    ? join(options.cacheDir, "node-vectors", encodeURIComponent(manifest.id), revision)
    : undefined;
  const base = dir ? join(dir, `${sha}-r${taxonomyRevision}`) : undefined;
  if (base) {
    try {
      const meta = JSON.parse(await readFile(`${base}.json`, "utf8")) as CacheMeta;
      const bytes = await readFile(`${base}.f32`);
      const vectors = new Float32Array(bytes.byteLength / 4);
      new Uint8Array(vectors.buffer).set(bytes);
      if (
        meta.format === 1 &&
        meta.encoderId === manifest.id &&
        meta.encoderRevision === revision &&
        meta.taxonomyRevision === taxonomyRevision &&
        meta.nodeTextsSha256 === sha &&
        meta.dim === manifest.dim &&
        sameIds(meta.ids, ids) &&
        vectors.length === ids.length * meta.dim &&
        vectorsSha256(vectors) === meta.vectorsSha256
      ) {
        log(`node vectors: cache hit ${base}`);
        return { encoderId: manifest.id, taxonomyRevision, nodeTextsSha256: sha, vectorsSha256: meta.vectorsSha256, ids, dim: meta.dim, vectors };
      }
      log(`node vectors: cache entry ${base} does not match; recomputing`);
    } catch {
      // no usable cache entry
    }
  }

  const started = Date.now();
  const rows = await encoder.embed(texts.map((entry) => nodeDocument(manifest, entry.text)), "doc", signal);
  const vectors = new Float32Array(ids.length * manifest.dim);
  rows.forEach((row, index) => {
    if (row.length !== manifest.dim) throw new Error(`node vector ${index} has ${row.length} dims, expected ${manifest.dim}`);
    vectors.set(row, index * manifest.dim);
  });
  const digest = vectorsSha256(vectors);
  log(`node vectors: computed ${ids.length} x ${manifest.dim} with ${manifest.id} in ${Date.now() - started} ms`);
  if (dir && base) {
    try {
      await mkdir(dir, { recursive: true });
      const meta: CacheMeta = {
        format: 1,
        encoderId: manifest.id,
        encoderRevision: revision,
        taxonomyRevision,
        nodeTextsSha256: sha,
        vectorsSha256: digest,
        dim: manifest.dim,
        ids,
      };
      const tag = `${process.pid}-${Date.now()}`;
      await writeFile(`${base}.f32.${tag}`, vectorBytes(vectors));
      await rename(`${base}.f32.${tag}`, `${base}.f32`);
      await writeFile(`${base}.json.${tag}`, `${JSON.stringify(meta)}\n`, "utf8");
      await rename(`${base}.json.${tag}`, `${base}.json`);
    } catch (error) {
      log(`node vectors: cache write failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { encoderId: manifest.id, taxonomyRevision, nodeTextsSha256: sha, vectorsSha256: digest, ids, dim: manifest.dim, vectors };
}
