import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";
import { importRuntimeComponent, installRuntimeComponent } from "../src/util/runtime-component.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-components-"));
  const source = join(root, "source"), cache = join(root, "cache");
  await mkdir(join(source, "node_modules", "@cursor", "sdk"), { recursive: true });
  await writeFile(join(source, "node_modules", "@cursor", "sdk", "package.json"), JSON.stringify({
    name: "@cursor/sdk", type: "module", exports: { import: "./esm.js", require: "./cjs.cjs" },
  }));
  await writeFile(join(source, "node_modules", "@cursor", "sdk", "esm.js"), 'export const channel = "esm";\n');
  await writeFile(join(source, "node_modules", "@cursor", "sdk", "cjs.cjs"), 'throw new Error("incorrect export condition");\n');
  const archive = join(root, "component.tar.gz");
  const pack = async () => {
    execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    const bytes = await readFile(archive);
    return { bytes, descriptor: { file: "component.tar.gz", size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://updates.example/component.tar.gz" } };
  };
  return { root, source, cache, pack, close: () => rm(root, { recursive: true, force: true }) };
}

test("verified components are reusable without network and preserve ESM package export conditions", async () => {
  const f = await fixture(); const old = process.env.BRAINSTORM_RUNTIME_COMPONENT_CACHE;
  try {
    const { bytes, descriptor } = await f.pack(); let downloads = 0;
    const download = (async () => { downloads++; return new Response(bytes); }) as typeof fetch;
    const installed = await installRuntimeComponent(descriptor, f.cache, download);
    assert.equal(await installRuntimeComponent(descriptor, f.cache, download), installed);
    assert.equal(downloads, 1);
    const app = join(f.root, "app"); await mkdir(app);
    await writeFile(join(app, ".co-inference-distribution.json"), JSON.stringify({
      schemaVersion: 2, platform: process.platform, arch: process.arch,
      nodeMajor: process.versions.node.split(".")[0], nodeAbi: process.versions.modules, components: { cursor: descriptor },
      libc: process.platform === "linux" ? "glibc" : "none", minimumLibc: "2.28",
    }));
    process.env.BRAINSTORM_RUNTIME_COMPONENT_CACHE = f.cache;
    const sdk = await importRuntimeComponent<{ channel: string }>("cursor", "@cursor/sdk", pathToFileURL(join(app, "entry.mjs")).href);
    assert.equal(sdk.channel, "esm");
  } finally {
    if (old === undefined) delete process.env.BRAINSTORM_RUNTIME_COMPONENT_CACHE;
    else process.env.BRAINSTORM_RUNTIME_COMPONENT_CACHE = old;
    await f.close();
  }
});

test("tampered or truncated downloads never become installed components and can be retried", async () => {
  const f = await fixture();
  try {
    const { bytes, descriptor } = await f.pack();
    const tampered = Buffer.from(bytes); tampered[20] = tampered[20]! ^ 1;
    await assert.rejects(installRuntimeComponent(descriptor, f.cache,
      (async () => new Response(tampered)) as typeof fetch), /integrity/);
    assert.deepEqual(await readdir(f.cache), []);
    await assert.rejects(installRuntimeComponent(descriptor, f.cache,
      (async () => new Response(bytes.subarray(0, 10))) as typeof fetch), /integrity/);
    assert.deepEqual(await readdir(f.cache), []);
    await installRuntimeComponent(descriptor, f.cache, (async () => new Response(bytes)) as typeof fetch);
    assert.deepEqual(await readdir(f.cache), [descriptor.sha256]);
  } finally { await f.close(); }
});

test("even a digest-matching component cannot extract symbolic links", async () => {
  const f = await fixture();
  try {
    await symlink("../../outside", join(f.source, "escape"));
    const { bytes, descriptor } = await f.pack();
    await assert.rejects(installRuntimeComponent(descriptor, f.cache,
      (async () => new Response(bytes)) as typeof fetch), /links or special/);
    assert.deepEqual(await readdir(f.cache), []);
  } finally { await f.close(); }
});

test("missing secure publication URL fails before contacting a server", async () => {
  const f = await fixture();
  try {
    const { descriptor } = await f.pack();
    for (const url of [undefined, "http://updates.example/archive", "https://secret@updates.example/archive"]) {
      await assert.rejects(installRuntimeComponent({ ...descriptor, url }, f.cache,
        (async () => { assert.fail("must not download"); }) as typeof fetch), /secure download/);
    }
  } finally { await f.close(); }
});

test("corrupt components are repaired separately while existing files and running users remain untouched", async () => {
  const f = await fixture();
  try {
    const { bytes, descriptor } = await f.pack(); let downloads = 0;
    const fetcher = (async () => { downloads++; return new Response(bytes); }) as typeof fetch;
    const original = await installRuntimeComponent(descriptor, f.cache, fetcher);
    const module = join(original, "node_modules/@cursor/sdk/esm.js"); await writeFile(module, "damaged");
    const replacement = await installRuntimeComponent(descriptor, f.cache, fetcher);
    assert.notEqual(replacement, original); assert.match(replacement, /-repair-/);
    assert.equal(await readFile(module, "utf8"), "damaged");
    assert.equal(await readFile(join(replacement, "node_modules/@cursor/sdk/esm.js"), "utf8"), 'export const channel = "esm";\n');
    assert.equal(await installRuntimeComponent(descriptor, f.cache, fetcher), replacement); assert.equal(downloads, 2);
    await writeFile(join(replacement, "node_modules/@cursor/sdk/unexpected.js"), "untracked source");
    const third = await installRuntimeComponent(descriptor, f.cache, fetcher);
    assert.notEqual(third, replacement, "unexpected code cannot be added to an immutable verified component");
  } finally { await f.close(); }
});

test("private cache ownership checks reject symlink roots and unsafe modes, and never follow a redirected cached package", async () => {
  const f = await fixture();
  try {
    const { bytes, descriptor } = await f.pack();
    const fetcher = (async () => new Response(bytes)) as typeof fetch;
    const outside = join(f.root, "outside"); await mkdir(outside); await symlink(outside, f.cache);
    await assert.rejects(installRuntimeComponent(descriptor, f.cache, fetcher), /Unsafe.*cache path/);
    assert.deepEqual(await readdir(outside), []);
    await rm(f.cache); await mkdir(f.cache, { mode: 0o700 }); await chmod(f.cache, 0o777);
    await assert.rejects(installRuntimeComponent(descriptor, f.cache, fetcher), /Unsafe.*cache path/);
    await chmod(f.cache, 0o700);
    const original = await installRuntimeComponent(descriptor, f.cache, fetcher);
    const packagePath = join(original, "node_modules/@cursor/sdk");
    await rm(packagePath, { recursive: true }); await symlink(outside, packagePath);
    const replacement = await installRuntimeComponent(descriptor, f.cache, fetcher);
    assert.notEqual(replacement, original); assert.deepEqual(await readdir(outside), []);
  } finally { await f.close(); }
});

test("HTTPS redirects cannot downgrade transport or add credentials", async () => {
  const f = await fixture();
  try {
    const { bytes, descriptor } = await f.pack();
    for (const target of ["http://updates.example/payload", "https://secret@updates.example/payload"]) {
      let calls = 0;
      const fetcher = (async (_url: URL, options?: RequestInit) => {
        calls++; assert.equal(options?.redirect, "manual");
        return new Response(null, { status: 302, headers: { location: target } });
      }) as typeof fetch;
      await assert.rejects(installRuntimeComponent(descriptor, f.cache, fetcher), /secure download/);
      assert.equal(calls, 1); assert.deepEqual(await readdir(f.cache), []);
    }
    let calls = 0;
    await installRuntimeComponent(descriptor, f.cache, (async () => ++calls === 1
      ? new Response(null, { status: 302, headers: { location: "https://assets.example/component.tar.gz" } })
      : new Response(bytes)) as typeof fetch);
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test("a valid marker alone cannot hide a missing file or replace a previously existing cache directory", async () => {
  const f = await fixture();
  try {
    const { bytes, descriptor } = await f.pack(), original = join(f.cache, descriptor.sha256);
    await mkdir(original, { recursive: true, mode: 0o700 });
    await writeFile(join(original, ".verified"), descriptor.sha256, { mode: 0o600 });
    const replacement = await installRuntimeComponent(descriptor, f.cache, (async () => new Response(bytes)) as typeof fetch);
    assert.notEqual(replacement, original); assert.deepEqual(await readdir(original), [".verified"]);
    await rm(join(replacement, "node_modules/@cursor/sdk/esm.js"));
    const another = await installRuntimeComponent(descriptor, f.cache, (async () => new Response(bytes)) as typeof fetch);
    assert.notEqual(another, replacement);
  } finally { await f.close(); }
});

test("digest-matching archives still require a complete tar terminator and valid gzip footer", async () => {
  const f = await fixture();
  try {
    const { bytes, descriptor } = await f.pack(), tar = gunzipSync(bytes);
    let offset = 0;
    while (!tar.subarray(offset, offset + 512).every(byte => byte === 0)) {
      const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, "").trim(), 8);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    const badFooter = Buffer.from(bytes); badFooter[badFooter.length - 1] = badFooter[badFooter.length - 1]! ^ 1;
    const oneTerminator = gzipSync(tar.subarray(0, offset + 512));
    const trailingPayload = gzipSync(Buffer.concat([tar, Buffer.alloc(512, 65)]));
    for (const invalid of [badFooter, oneTerminator, trailingPayload]) {
      const altered = { ...descriptor, size: invalid.length, sha256: createHash("sha256").update(invalid).digest("hex") };
      await assert.rejects(installRuntimeComponent(altered, f.cache, (async () => new Response(invalid)) as typeof fetch));
      assert.deepEqual(await readdir(f.cache), []);
    }
  } finally { await f.close(); }
});

test("provider imports reject incompatible system libraries before downloading an engine", { skip: process.platform !== "linux" }, async () => {
  const f = await fixture();
  try {
    const { descriptor } = await f.pack(), app = join(f.root, "app"); await mkdir(app);
    await writeFile(join(app, ".co-inference-distribution.json"), JSON.stringify({
      schemaVersion: 2, platform: process.platform, arch: process.arch,
      nodeMajor: process.versions.node.split(".")[0], nodeAbi: process.versions.modules,
      libc: "glibc", minimumLibc: "999.0", components: { cursor: descriptor },
    }));
    await assert.rejects(importRuntimeComponent("cursor", "@cursor/sdk", pathToFileURL(join(app, "entry.mjs")).href), /system libraries/);
  } finally { await f.close(); }
});
