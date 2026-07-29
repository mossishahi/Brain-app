import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ContentRegistryCache,
  parseContentRegistryManifest,
  readContentPin,
  writeContentPin,
  type ContentRegistryClient,
  type ContentRegistryPin,
} from "../src/index.js";

const brainRepoRoot = fileURLToPath(new URL("../../../../../brain/", import.meta.url));

/** The published version these tests pin; immutable, so it never drifts. */
const FIXTURE_VERSION = "0.1.0";

function materializedVersionDir(version: string): string {
  execFileSync(
    process.execPath,
    [join(brainRepoRoot, "scripts", "materialize-store.mjs"), "--quiet"],
    { stdio: "inherit" },
  );
  return `${join(brainRepoRoot, ".registry-store", "bundles", "brainstorm", version)}/`;
}

/**
 * Deliberately NOT overridable through BRAIN_TEST_CONTENT_DIR, unlike the
 * content and runtime suites. Those load a bundle, so the editable source tree
 * works for them; this suite verifies that the client fetches files and checks
 * them against a manifest, and only a *published* version has one — the source
 * tree carries no manifest.json by design, because manifests are generated
 * from immutable tags.
 */
const versionRoot = materializedVersionDir(FIXTURE_VERSION);

function fixturePin(): ContentRegistryPin {
  const manifest = parseContentRegistryManifest(
    JSON.parse(readFileSync(join(versionRoot, "manifest.json"), "utf8")),
    "brainstorm",
    FIXTURE_VERSION,
  );
  return {
    registryUrl: "https://registry.test/mcp",
    bundle: manifest.bundle,
    version: manifest.version,
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    manifest,
  };
}

test("pin roundtrip rejects modified manifest metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "registry-pin-"));
  const path = join(root, "pin.json");
  try {
    writeContentPin(path, fixturePin());
    assert.equal(readContentPin(path).version, FIXTURE_VERSION);
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.manifest.version = "9.9.9";
    writeFileSync(path, JSON.stringify(tampered));
    assert.throws(() => readContentPin(path), /manifest hash is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cache fetches one exact file, verifies it, and deduplicates concurrency", async () => {
  const root = mkdtempSync(join(tmpdir(), "registry-cache-"));
  const pin = fixturePin();
  let reads = 0;
  const fake = {
    async readText(path: string): Promise<string> {
      reads += 1;
      const relative = path.replace(
        `bundles/${pin.bundle}/${pin.version}/`,
        "",
      );
      return readFileSync(join(versionRoot, relative), "utf8");
    },
  } as ContentRegistryClient;
  try {
    const cache = new ContentRegistryCache(root, pin, fake);
    const [first, second] = await Promise.all([
      cache.ensure("skills/roles/processor.md"),
      cache.ensure("skills/roles/processor.md"),
    ]);
    assert.equal(first, second);
    assert.equal(reads, 1);
    await cache.ensure("skills/roles/processor.md");
    assert.equal(reads, 1, "verified disk cache avoids another MCP read");
    assert.equal(cache.rolePath("judge"), "skills/roles/judge.md");
    assert.equal(
      cache.techniquePath("deep-understanding"),
      "skills/techniques/deep-understanding.md",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
