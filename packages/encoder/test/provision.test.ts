import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createEncoderProvider } from "../src/index.js";
import { defaultModelCacheRoot, inspectModelProvision, managedModelPlatformIssue, modelArtifactKey, provisionModel, recordModelRuntimeResult, type ModelArtifactBundle } from "../src/model-artifacts.js";

const exec = promisify(execFile);
const moduleUrl = new URL("../src/model-artifacts.js", import.meta.url).href;

function fixture() {
  const bodies: Record<string, string> = {
    "manifest.json": JSON.stringify({ id: "specter2", graphs: { doc: { file: "doc.onnx" }, query: { file: "query.onnx" } } }),
    "doc.onnx": "document graph fixture", "query.onnx": "query graph fixture",
    "tokenizer.json": "{}", "tokenizer_config.json": "{}",
  };
  const bundle: ModelArtifactBundle = { id: "specter2", revision: "test-export-1", files: Object.entries(bodies).map(([path, body]) => ({
    path, url: `https://models.example.test/${path}`, size: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"),
  })) };
  return { bodies, bundle, catalog: { specter2: bundle } };
}

function serve(bodies: Record<string, string>, calls: string[]): typeof fetch {
  return (async (input) => {
    const path = new URL(String(input)).pathname.slice(1);
    calls.push(path);
    return new Response(bodies[path], { headers: { "content-length": String(Buffer.byteLength(bodies[path]!)) } });
  }) as typeof fetch;
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "encoder-provision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("inspection is read-only and distinguishes download-on-first-use from external configuration", async (t) => {
  const root = await temporary(t), cacheRoot = join(root, "uncreated"), { catalog } = fixture();
  const missing = await inspectModelProvision("specter2", { cacheRoot, catalog, env: {} });
  assert.equal(missing.state, "missing");
  assert.equal(missing.managed, true);
  assert.equal(existsSync(cacheRoot), false);
  assert.equal(defaultModelCacheRoot({ HOME: "/users/a" }), "/users/a/.cache/co-inference/encoders");
  assert.equal(defaultModelCacheRoot({ HOME: "/users/a", XDG_CACHE_HOME: "/cache" }), "/cache/co-inference/encoders");
  assert.match(managedModelPlatformIssue("darwin", "x64") ?? "", /Intel Macs/);
  assert.equal(managedModelPlatformIssue("linux", "x64"), undefined);
  assert.equal(managedModelPlatformIssue("darwin", "arm64"), undefined);
  const explicit = { cacheRoot, catalog, env: { BRAINSTORM_AGENTIC_ENCODER_DIR: join(root, "external") } };
  assert.equal((await inspectModelProvision("specter2", explicit)).state, "unavailable");
  assert.equal(await provisionModel("specter2", { ...explicit, fetch: (() => { throw new Error("must not download"); }) as typeof fetch }), join(root, "external"));
  assert.equal(existsSync(join(root, "external")), false);
  assert.equal((await inspectModelProvision("bge-base-en-v1.5", { catalog, env: {} })).state, "unavailable");
});

test("one verified installation is shared concurrently, reused offline and repaired after same-size corruption", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bundle, bodies } = fixture(), calls: string[] = [];
  const options = { cacheRoot, catalog, env: {}, fetch: serve(bodies, calls) };
  const dirs = await Promise.all(Array.from({ length: 8 }, () => provisionModel("specter2", options)));
  assert.equal(new Set(dirs).size, 1);
  assert.equal(calls.length, bundle.files.length);
  const modelDir = dirs[0]!;
  assert.equal((await inspectModelProvision("specter2", options)).state, "prepared");
  assert.equal(await provisionModel("specter2", { ...options, fetch: (() => { throw new Error("offline"); }) as typeof fetch }), modelDir);
  await writeFile(join(modelDir, "specter2", "doc.onnx"), "x".repeat(bodies["doc.onnx"]!.length));
  await provisionModel("specter2", options);
  assert.equal(await readFile(join(modelDir, "specter2", "doc.onnx"), "utf8"), bodies["doc.onnx"]);
  assert.equal(calls.length, 2 * bundle.files.length);
  assert.deepEqual((await readdir(cacheRoot)).filter((name) => /partial|lock|failed/.test(name)), []);
});

test("cross-process workers share one download and leave a complete atomic bundle", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bodies, bundle } = fixture();
  const source = `
    import { appendFile } from 'node:fs/promises';
    const [moduleUrl, cacheRoot, catalogText, bodiesText] = process.argv.slice(1);
    const { provisionModel } = await import(moduleUrl);
    const catalog = JSON.parse(catalogText), bodies = JSON.parse(bodiesText);
    const fetch = async input => {
      const file = new URL(input).pathname.slice(1);
      await appendFile(cacheRoot + '/requests.log', file + '\\n');
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response(bodies[file]);
    };
    process.stdout.write(await provisionModel('specter2', { cacheRoot, catalog, fetch, env: {} }));
  `;
  const run = () => exec(process.execPath, ["--input-type=module", "-e", source, moduleUrl, cacheRoot, JSON.stringify(catalog), JSON.stringify(bodies)], { timeout: 20_000 });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.stdout, b.stdout);
  assert.equal((await readFile(join(cacheRoot, "requests.log"), "utf8")).trim().split("\n").length, bundle.files.length);
  assert.equal((await inspectModelProvision("specter2", { cacheRoot, catalog, env: {} })).state, "prepared");
});

test("incomplete or tampered downloads never become ready, and a later attempt recovers", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bodies } = fixture();
  const options = { cacheRoot, catalog, env: {} };
  const badBodies = { ...bodies, "doc.onnx": "z".repeat(bodies["doc.onnx"]!.length) };
  await assert.rejects(provisionModel("specter2", { ...options, fetch: serve(badBodies, []) }), /checksum/);
  const failed = await inspectModelProvision("specter2", options);
  assert.equal(failed.state, "failed");
  assert.equal(existsSync(failed.modelDir!), false);
  assert.ok((await readdir(cacheRoot)).every((name) => !name.includes("partial") && !name.endsWith(".lock")));
  await provisionModel("specter2", { ...options, fetch: serve(bodies, []) });
  assert.equal((await inspectModelProvision("specter2", options)).state, "prepared");
});

test("streaming downloads enforce pinned length even without a content-length header", async (t) => {
  const cacheRoot = await temporary(t), { catalog } = fixture();
  const fetcher = (async () => new Response("x".repeat(10_000))) as typeof fetch;
  await assert.rejects(provisionModel("specter2", { cacheRoot, catalog, env: {}, fetch: fetcher }), /exceeds its pinned size/);
  assert.equal((await inspectModelProvision("specter2", { cacheRoot, catalog, env: {} })).state, "failed");
});

test("temporary HTTP failures retry, while invalid redirects cannot fetch an insecure target", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bodies } = fixture(), calls: string[] = [];
  let attempts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (attempts++ === 0) return new Response("busy", { status: 503 });
    return serve(bodies, calls)(input, init);
  };
  await provisionModel("specter2", { cacheRoot, catalog, env: {}, fetch: fetcher });
  assert.equal(attempts, Object.keys(bodies).length + 1);
  const otherRoot = join(cacheRoot, "other");
  let insecureCalls = 0;
  await assert.rejects(provisionModel("specter2", { cacheRoot: otherRoot, catalog, env: {}, fetch: (async () => {
    insecureCalls++;
    return new Response(null, { status: 302, headers: { location: "http://insecure.test/model" } });
  }) as typeof fetch }), /HTTPS/);
  assert.equal(insecureCalls, 3, "only the pinned HTTPS URL is requested on bounded retries");
});

test("preparing status is visible without downloading; abandoned locks recover and live locks time out", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bundle, bodies } = fixture();
  const lock = join(cacheRoot, `${modelArtifactKey(bundle)}.lock`);
  await mkdir(lock);
  const token = randomUUID(), ownerPath = join(lock, `owner-${token}.json`);
  await writeFile(ownerPath, JSON.stringify({ host: hostname(), pid: process.pid, token }));
  const options = { cacheRoot, catalog, env: {}, fetch: serve(bodies, []) };
  assert.equal((await inspectModelProvision("specter2", options)).state, "preparing");
  await assert.rejects(provisionModel("specter2", { ...options, lockTimeoutMs: 20 }), /waiting for another worker/);
  await writeFile(ownerPath, JSON.stringify({ host: hostname(), pid: 2147483647, token }));
  const old = new Date(Date.now() - 180_000);
  await utimes(ownerPath, old, old);
  const orphan = join(cacheRoot, `${modelArtifactKey(bundle)}.partial-crashed`);
  await mkdir(orphan);
  await writeFile(join(orphan, "incomplete.onnx"), "unfinished download");
  await writeFile(join(orphan, ".owner.json"), JSON.stringify({ host: hostname(), pid: 2147483647 }));
  await provisionModel("specter2", options);
  assert.equal(existsSync(orphan), false);
  assert.equal((await inspectModelProvision("specter2", options)).state, "prepared");
});

test("failed repair remains visibly failed until a complete verified bundle is available", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bodies } = fixture();
  const options = { cacheRoot, catalog, env: {} };
  const modelDir = await provisionModel("specter2", { ...options, fetch: serve(bodies, []) });
  await writeFile(join(modelDir, "specter2", "doc.onnx"), "x".repeat(bodies["doc.onnx"]!.length));
  await assert.rejects(provisionModel("specter2", { ...options, fetch: (async () => new Response(null, { status: 404 })) as typeof fetch }), /HTTP 404/);
  assert.equal((await inspectModelProvision("specter2", options)).state, "failed", "a receipt alone cannot hide a known failed integrity check");
  await provisionModel("specter2", { ...options, fetch: serve(bodies, []) });
  assert.equal((await inspectModelProvision("specter2", options)).state, "prepared");
});

test("cancelled downloads clean staging state and release their lock for a later attempt", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bodies } = fixture();
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const fetcher: typeof fetch = async (_input, init) => {
    started();
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  };
  const operation = provisionModel("specter2", { cacheRoot, catalog, env: {}, fetch: fetcher, signal: controller.signal });
  await entered;
  controller.abort(new Error("cancel preparation"));
  await assert.rejects(operation, /cancel preparation/);
  assert.ok((await readdir(cacheRoot)).every((name) => !name.includes("partial") && !name.endsWith(".lock")));
  await provisionModel("specter2", { cacheRoot, catalog, env: {}, fetch: serve(bodies, []) });
  assert.equal((await inspectModelProvision("specter2", { cacheRoot, catalog, env: {} })).state, "prepared");
});

test("provider does not retain an unavailable model after the external export is repaired", async (t) => {
  const modelDir = await temporary(t);
  const provider = createEncoderProvider({ modelDir });
  const first = await provider.encoder("specter2");
  assert.ok("unavailable" in first && /ENOENT/.test(first.unavailable));
  await mkdir(join(modelDir, "specter2"));
  await writeFile(join(modelDir, "specter2", "manifest.json"), JSON.stringify({ id: "wrong-export" }));
  const next = await provider.encoder("specter2");
  assert.ok("unavailable" in next && /declares id/.test(next.unavailable), "the next attempt re-reads the repaired directory");
});

test("catalog rejects unsafe paths, insecure sources and unbounded or incomplete bundles", () => {
  const { bundle } = fixture();
  const replace = (patch: Partial<(typeof bundle.files)[number]>) => ({ ...bundle, files: [{ ...bundle.files[0]!, ...patch }, ...bundle.files.slice(1)] });
  for (const path of ["../escape", "/absolute", "sub/file", ".verified.json", "bad\\file"]) assert.throws(() => modelArtifactKey(replace({ path })), /Invalid/);
  assert.throws(() => modelArtifactKey(replace({ url: "http://models.test/a" })), /HTTPS/);
  assert.throws(() => modelArtifactKey(replace({ size: 3 * 1024 ** 3 })), /Invalid/);
  assert.throws(() => modelArtifactKey(replace({ sha256: "bad" })), /Invalid/);
  assert.throws(() => modelArtifactKey({ ...bundle, files: bundle.files.slice(1) }), /missing manifest/);
});

test("explicit SPECTER2 exports without a query graph are unavailable before native loading", async (t) => {
  const modelDir = await temporary(t);
  await mkdir(join(modelDir, "specter2"));
  await writeFile(join(modelDir, "specter2", "manifest.json"), JSON.stringify({ id: "specter2", graphs: { doc: { file: "doc.onnx" } } }));
  const status = await inspectModelProvision("specter2", { modelDir });
  assert.equal(status.state, "unavailable");
  const encoder = await createEncoderProvider({ modelDir }).encoder("specter2");
  assert.ok("unavailable" in encoder && /no query graph/.test(encoder.unavailable));
});

test("runtime readiness distinguishes downloaded files, failed native validation and a verified repaired export", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bodies } = fixture();
  const options = { cacheRoot, catalog, env: {} };
  const modelDir = await provisionModel("specter2", { ...options, fetch: serve(bodies, []) });
  assert.equal((await inspectModelProvision("specter2", options)).state, "prepared");
  await recordModelRuntimeResult("specter2", { error: "The encoder engine cannot load on this host" }, options);
  const failed = await inspectModelProvision("specter2", options);
  assert.equal(failed.state, "failed");
  assert.match(failed.detail!, /engine cannot load/);
  await recordModelRuntimeResult("specter2", {}, options);
  assert.equal((await inspectModelProvision("specter2", options)).state, "ready");
  await writeFile(join(modelDir, "specter2", "doc.onnx"), bodies["doc.onnx"]!);
  const changedTime = new Date(Date.now() - 10_000);
  await utimes(join(modelDir, "specter2", "doc.onnx"), changedTime, changedTime);
  assert.equal((await inspectModelProvision("specter2", options)).state, "prepared", "changed file stats invalidate runtime verification without hashing graphs on inspection");
  const external = { modelDir, cacheRoot: join(cacheRoot, "external-state"), env: {} };
  await recordModelRuntimeResult("specter2", { error: "External export conformance failed" }, external);
  assert.equal((await inspectModelProvision("specter2", external)).state, "failed");
  assert.equal((await readdir(join(modelDir, "specter2"))).length, Object.keys(bodies).length, "runtime state never alters external model files");
});

test("provider persists local loading failures and retries them instead of reporting prepared files as ready", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bodies } = fixture(), calls: string[] = [];
  const provider = createEncoderProvider({ modelCacheDir: cacheRoot, modelProvision: { catalog, env: {}, fetch: serve(bodies, calls) } });
  // Fixture graphs are not real ONNX graphs, and the deliberately incomplete manifest has no hashes.
  const value = await provider.encoder("specter2");
  assert.ok("unavailable" in value && /sha256/.test(value.unavailable));
  const status = await inspectModelProvision("specter2", { cacheRoot, catalog, env: {} });
  assert.equal(status.state, "failed");
  assert.match(status.detail!, /sha256/);
  const again = await provider.encoder("specter2");
  assert.ok("unavailable" in again);
  assert.notEqual(value, again, "failed encoder resolution is retried");
  assert.equal(calls.length, Object.keys(bodies).length, "retry reuses checked model files");
});

test("a delayed stale-lock reclaimer cannot steal a fresh owner's lock or remove its active download", { timeout: 15_000 }, async (t) => {
  const cacheRoot = await temporary(t), { catalog, bundle, bodies } = fixture();
  const lock = join(cacheRoot, `${modelArtifactKey(bundle)}.lock`), token = randomUUID();
  const oldOwner = join(lock, `owner-${token}.json`);
  await mkdir(lock);
  await writeFile(oldOwner, JSON.stringify({ host: hostname(), pid: 2147483647, token }));
  const expired = new Date(Date.now() - 180_000);
  await utimes(oldOwner, expired, expired);
  const gate = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
  const secondReclaimer = gate(), firstDownload = gate(), delayedUnlink = gate();
  const original = fsPromises.unlink;
  let staleUnlinks = 0, downloads = 0;
  fsPromises.unlink = async (path) => {
    if (String(path) === oldOwner) {
      staleUnlinks++;
      if (staleUnlinks === 1) await secondReclaimer.promise;
      else if (staleUnlinks === 2) {
        secondReclaimer.release();
        await firstDownload.promise;
        try { return await original(path); }
        finally { delayedUnlink.release(); }
      }
    }
    return original(path);
  };
  syncBuiltinESMExports();
  const fetcher: typeof fetch = async (input) => {
    if (downloads++ === 0) {
      firstDownload.release();
      await delayedUnlink.promise;
    }
    const name = new URL(String(input)).pathname.slice(1);
    return new Response(bodies[name]);
  };
  try {
    const run = () => provisionModel("specter2", { cacheRoot, catalog, env: {}, fetch: fetcher, signal: new AbortController().signal });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a, b);
    assert.equal(downloads, bundle.files.length);
    assert.equal(staleUnlinks, 2);
    assert.equal((await inspectModelProvision("specter2", { cacheRoot, catalog, env: {} })).state, "prepared");
  } finally {
    fsPromises.unlink = original;
    syncBuiltinESMExports();
    secondReclaimer.release(); firstDownload.release(); delayedUnlink.release();
  }
});

test("a long-waiting lock candidate refreshes its lease before publication on a shared host cache", async (t) => {
  const cacheRoot = await temporary(t), { catalog, bundle, bodies } = fixture();
  const lock = join(cacheRoot, `${modelArtifactKey(bundle)}.lock`);
  const original = fsPromises.rename;
  let claims = 0;
  fsPromises.rename = async (from, to) => {
    if (String(to) === lock) {
      const owner = join(String(from), (await readdir(from))[0]!);
      if (claims++ === 0) {
        const old = new Date(Date.now() - 180_000);
        await utimes(owner, old, old);
        throw Object.assign(new Error("another worker held the lock for several minutes"), { code: "EEXIST" });
      }
      assert.ok(Date.now() - (await lstat(owner)).mtimeMs < 5000, "the published lease must not retain the candidate's old timestamp");
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  try {
    await provisionModel("specter2", { cacheRoot, catalog, env: {}, fetch: serve(bodies, []) });
    assert.equal(claims, 2);
  } finally { fsPromises.rename = original; syncBuiltinESMExports(); }
});
