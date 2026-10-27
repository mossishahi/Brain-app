import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { embedText, type EncodeMode, type NodeVectorIndex, type TextEncoder } from "@brainstorm-agentic/core";

import {
  buildNodeIndex,
  checkConformance,
  createEncoderProvider,
  createHashNgramEncoder,
  createOpenRouterEncoder,
  encoderRevision,
  formatDocument,
  formatQuery,
  nodeDocument,
  nodeTextsSha256,
  OpenRouterError,
  vectorsSha256,
} from "../src/index.js";

const TEXTS = [
  { id: "T1", text: "Graph Neural Networks. Message passing over node features and edges." },
  { id: "T2", text: "Gaussian Processes. Kernel methods with Gaussian priors over functions." },
  { id: "T3", text: "Belief Propagation. Sum-product message passing on factor graphs." },
  { id: "T4", text: "Random Graphs" },
];

function counting(inner: TextEncoder): TextEncoder & { calls: Array<{ n: number; mode: EncodeMode }> } {
  const calls: Array<{ n: number; mode: EncodeMode }> = [];
  return {
    manifest: inner.manifest,
    calls,
    async embed(texts, mode, signal) {
      calls.push({ n: texts.length, mode });
      return inner.embed(texts, mode, signal);
    },
  };
}

test("hash-ngram-v1 delegates to the core embedder and passes its verification heads", async () => {
  const encoder = createHashNgramEncoder();
  assert.equal(encoder.manifest.id, "hash-ngram-v1");
  assert.equal(encoder.manifest.dim, 256);
  const [doc, query] = [(await encoder.embed(["manifold learning"], "doc"))[0]!, (await encoder.embed(["manifold learning"], "query"))[0]!];
  assert.deepEqual(Array.from(doc), Array.from(Float32Array.from(embedText([{ text: "manifold learning", weight: 1 }]))));
  assert.deepEqual(Array.from(doc), Array.from(query));
  const conformance = await checkConformance(encoder);
  assert.equal(conformance.ok, true);
  const provider = createEncoderProvider({});
  const served = await provider.encoder("hash-ngram-v1");
  assert.ok(!("unavailable" in served));
  assert.equal(served.manifest.id, "hash-ngram-v1");
});

test("unavailable encoders are reported, never thrown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "encoder-missing-"));
  try {
    const provider = createEncoderProvider({ modelDir: dir });
    const specter = await provider.encoder("specter2");
    assert.ok("unavailable" in specter && /specter2/.test(specter.unavailable) && /manifest\.json/.test(specter.unavailable));
    const bge = await provider.encoder("bge-base-en-v1.5");
    assert.ok("unavailable" in bge);
    const remote = await provider.encoder("openrouter:openai/text-embedding-3-small");
    assert.ok("unavailable" in remote && /OpenRouter API key/.test(remote.unavailable));
    const unknown = await provider.encoder("word2vec");
    assert.deepEqual(unknown, { unavailable: 'unknown encoder "word2vec"' });
    const empty = await provider.encoder("openrouter:");
    assert.ok("unavailable" in empty);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("document, node and query formats follow the manifest", () => {
  const specter = { docFormat: "{title}[SEP]{body}", queryFormat: "{text}" };
  const bge = { docFormat: "{title}. {body}", queryFormat: "Represent this sentence for searching relevant passages: {text}" };
  assert.equal(formatDocument(specter, "A $& title", "Body $1."), "A $& title[SEP]Body $1.");
  assert.equal(formatDocument(bge, " Title", "body "), "Title. body");
  assert.equal(nodeDocument(specter, "Graph Neural Networks. Message passing. More."), "Graph Neural Networks[SEP]Message passing. More.");
  assert.equal(nodeDocument(bge, TEXTS[0]!.text), TEXTS[0]!.text);
  assert.equal(nodeDocument(specter, "Random Graphs"), "Random Graphs");
  assert.equal(formatQuery(bge, "q"), "Represent this sentence for searching relevant passages: q");
  assert.equal(formatQuery(specter, "q {text}"), "q {text}");
});

test("node-texts sha256 equals the canonical Python serialisation", () => {
  // python: json.dumps(entries, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
  const entries = [
    { text: "Graph Neural Networks. \u00c4 \u00e9 \u6771\u4eac \u2014 \u201cq\u201d", id: "T1" },
    { id: "C:x", text: "a\nb\t\"c\" \\ / \u0001" },
  ];
  assert.equal(nodeTextsSha256(entries), "71e20bcbe3ccf5231c6fe987a00a86af97cdfacfe36be399a733fc9468743f95");
});

test("OpenRouter encoder: auth, data_collection deny, batching, order, normalisation, retry", async () => {
  const requests: Array<{ auth?: string; body: any }> = [];
  let failNext = 1;
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body });
    if (failNext > 0 && requests.length === 2) {
      failNext -= 1;
      res.writeHead(429, { "retry-after": "1" }).end("{}");
      return;
    }
    const data = (body.input as string[]).map((text, index) => ({ index, embedding: [3, 4, text.length % 7, 0] }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "intfloat/e5-large-v2@resolved", data: data.reverse() }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const slept: number[] = [];
  try {
    const encoder = await createOpenRouterEncoder({
      apiKey: "test-key",
      model: "intfloat/e5-large-v2",
      baseUrl: `http://127.0.0.1:${port}/api/v1/`,
      batchSize: 2,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.equal(encoder.manifest.id, "openrouter:intfloat/e5-large-v2");
    assert.equal(encoder.manifest.dim, 4);
    assert.equal(encoder.manifest.queryFormat, "query: {text}");
    assert.equal(encoder.manifest.docFormat, "passage: {title}. {body}");
    assert.deepEqual(encoder.manifest.models, { "intfloat/e5-large-v2": "intfloat/e5-large-v2@resolved" });
    const docs = ["a", "bb", "ccc", "dddd", "eeeee"];
    const vectors = await encoder.embed(docs, "doc");
    assert.equal(vectors.length, 5);
    for (const [i, v] of vectors.entries()) {
      const third = docs[i]!.length % 7;
      const norm = Math.sqrt(9 + 16 + third * third);
      assert.ok(Math.abs(v[0]! - 3 / norm) < 1e-6 && Math.abs(v[2]! - third / norm) < 1e-6, `row ${i} order and normalisation`);
    }
    const [q] = await encoder.embed(["graph"], "query");
    assert.ok(q && q.length === 4);
    assert.deepEqual(slept, [1000]);
    for (const request of requests) {
      assert.equal(request.auth, "Bearer test-key");
      assert.equal(request.body.model, "intfloat/e5-large-v2");
      assert.deepEqual(request.body.provider, { data_collection: "deny" });
      assert.equal(request.body.encoding_format, "float");
    }
    assert.deepEqual(requests[0]!.body.input, ["query: graph generative models with Bernoulli adjacency"]);
    assert.deepEqual(requests.slice(1).map((r) => r.body.input.length), [2, 2, 2, 1, 1]);
    assert.deepEqual(requests.at(-1)!.body.input, ["query: graph"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await assert.rejects(
    createOpenRouterEncoder({
      apiKey: "k",
      model: "m",
      fetch: (async () => new Response(JSON.stringify({ error: { message: "No auth credentials found" } }), { status: 401 })) as typeof fetch,
    }),
    (error: unknown) => error instanceof OpenRouterError && error.status === 401 && /No auth credentials/.test(error.message),
  );
});

test("nodeIndex computes once, then serves the disk cache keyed by encoder, texts and taxonomy revision", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "encoder-cache-"));
  try {
    const encoder = counting(createHashNgramEncoder());
    const first = await buildNodeIndex(encoder, 1, TEXTS, { cacheDir });
    assert.deepEqual(encoder.calls, [{ n: 4, mode: "doc" }]);
    assert.equal(first.ids.length, 4);
    assert.equal(first.vectors.length, 4 * 256);
    assert.equal(first.vectorsSha256, vectorsSha256(first.vectors));
    assert.equal(first.nodeTextsSha256, nodeTextsSha256(TEXTS));
    assert.ok(existsSync(join(cacheDir, "node-vectors", "hash-ngram-v1", encoderRevision(encoder.manifest), `${first.nodeTextsSha256}-r1.f32`)));
    const provider = createEncoderProvider({ cacheDir });
    const again = await provider.nodeIndex(encoder, 1, TEXTS);
    assert.equal(encoder.calls.length, 1, "second call is a cache hit");
    assert.deepEqual(Array.from(again.vectors), Array.from(first.vectors));
    await buildNodeIndex(encoder, 2, TEXTS, { cacheDir });
    assert.equal(encoder.calls.length, 2, "a new taxonomy revision recomputes");
    await buildNodeIndex(encoder, 1, [...TEXTS.slice(0, 3), { id: "T4", text: "Random Graphs. Erdos-Renyi models." }], { cacheDir });
    assert.equal(encoder.calls.length, 3, "changed node texts recompute");
    await assert.rejects(buildNodeIndex(encoder, 1, [TEXTS[0]!, TEXTS[0]!]), /duplicate ids/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("nodeIndex prefers matching registry vectors and rejects mismatched ones", async () => {
  const encoder = counting(createHashNgramEncoder());
  const good = await buildNodeIndex(createHashNgramEncoder(), 3, TEXTS);
  const lines: string[] = [];
  const served = await buildNodeIndex(encoder, 3, TEXTS, { registry: { nodeIndex: async () => good }, log: (line) => lines.push(line) });
  assert.equal(served, good);
  assert.deepEqual(encoder.calls, [{ n: 3, mode: "doc" }], "only the spot check runs locally");
  assert.match(lines[0]!, /registry index for hash-ngram-v1 r3/);

  const variants: Array<[string, NodeVectorIndex | undefined | Error]> = [
    ["texts", { ...good, nodeTextsSha256: "0".repeat(64) }],
    ["revision", { ...good, taxonomyRevision: 2 }],
    ["sha", { ...good, vectorsSha256: "f".repeat(64) }],
    ["spot", (() => {
      const vectors = good.vectors.slice();
      for (let i = 0; i < vectors.length; i += 1) vectors[i] = vectors[i]! + 0.01;
      return { ...good, vectors, vectorsSha256: vectorsSha256(vectors) };
    })()],
    ["missing", undefined],
    ["error", new Error("registry down")],
  ];
  for (const [label, value] of variants) {
    encoder.calls.length = 0;
    const log: string[] = [];
    const index = await buildNodeIndex(encoder, 3, TEXTS, {
      registry: {
        nodeIndex: async () => {
          if (value instanceof Error) throw value;
          return value;
        },
      },
      log: (line) => log.push(line),
    });
    assert.notEqual(index, good, label);
    assert.deepEqual(Array.from(index.vectors), Array.from(good.vectors), `${label}: recomputed locally`);
    assert.ok(encoder.calls.some((call) => call.n === 4), `${label}: computed from the node texts`);
  }
});
