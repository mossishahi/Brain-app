import assert from "node:assert/strict";
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

const versionRoot =
  process.env.BRAIN_TEST_CONTENT_DIR ??
  fileURLToPath(
    new URL(
      "../../../../../brain/content/bundles/brainstorm/0.1.0/",
      import.meta.url,
    ),
  );

function fixturePin(): ContentRegistryPin {
  const manifest = parseContentRegistryManifest(
    JSON.parse(readFileSync(join(versionRoot, "manifest.json"), "utf8")),
    "brainstorm",
    "0.1.0",
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
    assert.equal(readContentPin(path).version, "0.1.0");
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
