#!/usr/bin/env node
/**
 * Compute the taxonomy node vectors of one encoder from catalog/taxonomy-texts.json
 * and write them as float32 little-endian rows plus a JSON sidecar — the input of
 * Brain's scripts/build-node-vectors.mjs (registry-served node vectors).
 *
 * usage: node scripts/export-node-vectors.mjs --encoder <id> --texts <taxonomy-texts.json>
 *          --out <rows.f32> [--revision <taxonomy revision, default 1>] [--model-dir <dir>] [--threads <n>]
 * Writes <out> and <out>.json ({encoderId, taxonomyRevision, ids, dim, vectorsSha256, nodeTextsSha256, models}).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { createEncoderProvider, nodeTextsSha256 } from "../dist/src/index.js";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) {
    console.error(`export-node-vectors: bad argument ${argv[i]}`);
    process.exit(1);
  }
  args[argv[i].slice(2)] = argv[i + 1];
}
for (const key of ["encoder", "texts", "out"]) {
  if (!args[key]) {
    console.error(`export-node-vectors: --${key} is required`);
    process.exit(1);
  }
}
const revision = Number(args.revision ?? 1);
const asset = JSON.parse(readFileSync(args.texts, "utf8"));
if (nodeTextsSha256(asset.entries) !== asset.sha256) {
  console.error("export-node-vectors: the texts asset sha256 does not match its entries");
  process.exit(1);
}
const provider = createEncoderProvider({
  ...(args["model-dir"] ? { modelDir: args["model-dir"] } : {}),
  ...(args.threads ? { threads: Number(args.threads) } : {}),
});
const encoder = await provider.encoder(args.encoder);
if ("unavailable" in encoder) {
  console.error(`export-node-vectors: ${encoder.unavailable}`);
  process.exit(1);
}
const started = Date.now();
const index = await provider.nodeIndex(encoder, revision, asset.entries);
const bytes = Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength);
writeFileSync(`${args.out}.tmp`, bytes);
renameSync(`${args.out}.tmp`, args.out);
const meta = {
  encoderId: index.encoderId,
  taxonomyRevision: index.taxonomyRevision,
  ids: index.ids,
  dim: index.dim,
  vectorsSha256: index.vectorsSha256,
  nodeTextsSha256: index.nodeTextsSha256,
  models: encoder.manifest.models,
};
writeFileSync(`${args.out}.json`, `${JSON.stringify(meta)}\n`);
console.log(JSON.stringify({ out: args.out, rows: index.ids.length, dim: index.dim, seconds: (Date.now() - started) / 1000, vectorsSha256: index.vectorsSha256 }));
