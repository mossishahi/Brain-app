/**
 * The worker's literature wiring: the lazily resolved encoder package with
 * its hash-ngram-v1 fallback, registry-served node vectors, node texts from
 * the bundle, keyed sources and the run's cache locations.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { hashNgramTextEncoder } from "@brainstorm-agentic/brainstorm-runtime";
import type { ContentBundle } from "@brainstorm-agentic/content";
import type { EncoderProvider, TextEncoder } from "@brainstorm-agentic/core";

import {
  ENCODER_PACKAGE,
  keyedSourcesFromSecrets,
  lazyEncoderProvider,
  literatureWiringForRun,
  nodeTextsFromBundle,
  registryNodeVectors,
} from "../src/literature-wiring.js";

function isEncoder(value: TextEncoder | { readonly unavailable: string }): value is TextEncoder {
  return "embed" in value;
}

test("without the encoder package every call goes to hash-ngram-v1, announced once", async () => {
  const lines: string[] = [];
  const asked: string[] = [];
  const provider = lazyEncoderProvider({
    importer: async (specifier) => {
      asked.push(specifier);
      throw new Error("Cannot find package");
    },
    log: (line) => lines.push(line),
  });
  assert.equal(await provider.origin(), "fallback");
  const hash = await provider.encoder("hash-ngram-v1");
  assert.ok(isEncoder(hash));
  const [vector] = await hash.embed(["gaussian belief propagation"], "doc");
  assert.equal(vector!.length, hash.manifest.dim);
  const specter = await provider.encoder("specter2");
  assert.ok(!isEncoder(specter));
  assert.match(specter.unavailable, /not installed on this host/);
  const index = await provider.nodeIndex(hash, 3, [
    { id: "T1", text: "Graph neural networks" },
    { id: "T2", text: "Random graph theory" },
  ]);
  assert.deepEqual(index.ids, ["T1", "T2"]);
  assert.equal(index.taxonomyRevision, 3);
  assert.equal(index.vectors.length, 2 * hash.manifest.dim);
  assert.deepEqual(asked, [ENCODER_PACKAGE], "the import is attempted once");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /hash-ngram-v1/);
});

test("a package without createEncoderProvider also falls back", async () => {
  const lines: string[] = [];
  const provider = lazyEncoderProvider({ importer: async () => ({}), log: (line) => lines.push(line) });
  assert.equal(await provider.origin(), "fallback");
  assert.match(lines[0]!, /exports no createEncoderProvider/);
});

test("the encoder package, when importable, receives the run's settings and serves every call", async () => {
  const seen: Record<string, unknown>[] = [];
  const fake: EncoderProvider = {
    async encoder(id) {
      return { unavailable: `fake ${id}` };
    },
    async nodeIndex() {
      throw new Error("not used");
    },
  };
  const registry = { async nodeIndex() { return undefined; } };
  const provider = lazyEncoderProvider({
    modelDir: "/models",
    openRouterApiKey: "or-key",
    cacheDir: "/cache",
    registry,
    threads: 2,
    importer: async () => ({
      createEncoderProvider: (settings: Record<string, unknown>) => {
        seen.push(settings);
        return fake;
      },
    }),
    log: () => assert.fail("no fallback line"),
  });
  assert.equal(await provider.origin(), "package");
  assert.deepEqual(await provider.encoder("specter2"), { unavailable: "fake specter2" });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { modelDir: "/models", openRouterApiKey: "or-key", cacheDir: "/cache", registry, threads: 2 });
});

test("registry node vectors: float32 little-endian base64 decoded; wrong revision, size or shape means none", async () => {
  const values = [0.5, -0.25, 1, 0, 0.125, -1];
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
  const calls: unknown[] = [];
  const answer = {
    revision: 7,
    ids: ["T1", "T2"],
    dim: 3,
    vectorsB64: buffer.toString("base64"),
    nodeTextsSha256: "texts",
    vectorsSha256: "vectors",
  };
  const vectors = registryNodeVectors({
    async callTool(name, args) {
      calls.push([name, args]);
      return answer;
    },
  });
  const index = await vectors.nodeIndex("specter2", 7);
  assert.deepEqual(calls, [["taxonomy_embeddings", { encoder: "specter2" }]]);
  assert.ok(index);
  assert.deepEqual(index.ids, ["T1", "T2"]);
  assert.equal(index.dim, 3);
  assert.deepEqual([...index.vectors], values);
  assert.equal(index.encoderId, "specter2");
  assert.equal(index.nodeTextsSha256, "texts");
  assert.equal(index.vectorsSha256, "vectors");
  assert.equal(await vectors.nodeIndex("specter2", 8), undefined, "another revision");
  const short = registryNodeVectors({ async callTool() { return { ...answer, dim: 4 }; } });
  assert.equal(await short.nodeIndex("specter2", 7), undefined, "size mismatch");
  const none = registryNodeVectors({ async callTool() { return { error: "no vectors for this encoder" }; } });
  assert.equal(await none.nodeIndex("specter2", 7), undefined);
  const failing = registryNodeVectors({ async callTool() { throw new Error("registry down"); } });
  assert.equal(await failing.nodeIndex("specter2", 7), undefined);
});

test("node texts come from the bundle's catalog/taxonomy-texts.json when present", async () => {
  const withTexts = { taxonomyTexts: { sha256: "abc", entries: [{ id: "T1", text: "Graph neural networks" }] } } as unknown as ContentBundle;
  assert.deepEqual(await nodeTextsFromBundle(withTexts).texts(), { sha256: "abc", entries: [{ id: "T1", text: "Graph neural networks" }] });
  assert.equal(await nodeTextsFromBundle({} as unknown as ContentBundle).texts(), undefined);
});

test("keyed sources and the run's cache locations", () => {
  assert.deepEqual([...keyedSourcesFromSecrets({})], []);
  assert.deepEqual(
    [...keyedSourcesFromSecrets({ openAlexApiKey: "k", coreApiKey: "", semanticScholarApiKey: "s" })].sort(),
    ["openalex", "semantic-scholar"],
  );
  const wiring = literatureWiringForRun({ workspaceRoot: "/runs/r1", secrets: { coreApiKey: "c" }, env: {} });
  assert.equal(wiring.cacheDir, join("/runs/r1", "literature-cache"));
  assert.deepEqual([...wiring.keyedSources], ["core"]);
});

test("the installed encoder package is used when it resolves, and its hash-ngram-v1 agrees with the runtime's", async (t) => {
  try {
    await import(ENCODER_PACKAGE);
  } catch (error) {
    t.skip(`${ENCODER_PACKAGE} is not installed here (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  const provider = lazyEncoderProvider({ log: () => {} });
  assert.equal(await provider.origin(), "package");
  const fromPackage = await provider.encoder("hash-ngram-v1");
  assert.ok(isEncoder(fromPackage), JSON.stringify(fromPackage));
  const texts = ["Gaussian belief propagation on factor graphs", "Random graph models of networks"];
  const a = await fromPackage.embed(texts, "doc");
  const b = await hashNgramTextEncoder().embed(texts, "doc");
  assert.equal(fromPackage.manifest.dim, b[0]!.length);
  for (let i = 0; i < texts.length; i += 1) {
    let worst = 0;
    for (let d = 0; d < b[i]!.length; d += 1) worst = Math.max(worst, Math.abs(a[i]![d]! - b[i]![d]!));
    assert.ok(worst < 1e-6, `text ${i}: |diff| ${worst}`);
  }
});
