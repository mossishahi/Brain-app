import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AttachmentIngestError,
  ingestAttachments,
} from "../src/attachments.js";

type Lookup = typeof import("node:dns/promises").lookup;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "bsa-ingest-"));
}

function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("folders are snapshotted with junk directories, symlinks, and oversized files skipped", async () => {
  const root = tempRoot();
  try {
    const source = join(root, "project");
    mkdirSync(join(source, "src"), { recursive: true });
    mkdirSync(join(source, "node_modules", "lib"), { recursive: true });
    mkdirSync(join(source, ".git"), { recursive: true });
    writeFileSync(join(source, "src", "train.py"), "print('x')\n");
    writeFileSync(join(source, "README.md"), "# readme\n");
    writeFileSync(join(source, "node_modules", "lib", "index.js"), "junk");
    writeFileSync(join(source, ".git", "HEAD"), "ref: junk");
    writeFileSync(join(source, "big.bin"), Buffer.alloc(64));
    symlinkSync(join(source, "README.md"), join(source, "link.md"));

    const baseDir = join(root, "store");
    const manifest = await ingestAttachments([source], baseDir, {
      maxFileBytes: 32,
    });

    assert.equal(manifest.attachments.length, 1);
    const attachment = manifest.attachments[0]!;
    assert.equal(attachment.kind, "folder");
    assert.equal(attachment.origin, source);
    const names = attachment.files.map((file) => file.path.slice(baseDir.length));
    assert.equal(attachment.files.length, 2, JSON.stringify(names));
    assert.ok(attachment.files.every((file) => file.path.startsWith(baseDir)));
    assert.ok(names.some((name) => name.endsWith("src/train.py")));
    assert.ok(names.some((name) => name.endsWith("README.md")));
    assert.ok(attachment.notes.some((note) => note.includes("junk")));
    assert.ok(attachment.notes.some((note) => note.includes("size limit")));
    assert.equal(manifest.totalFiles, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single pdf/image/video files are copied with honest notes for unreadable media", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "paper.pdf"), "%PDF-1.4 stub");
    writeFileSync(join(root, "demo.mp4"), Buffer.from([1, 2, 3]));
    const manifest = await ingestAttachments(
      [join(root, "paper.pdf"), join(root, "demo.mp4")],
      join(root, "store"),
    );
    assert.deepEqual(
      manifest.attachments.map((attachment) => attachment.kind),
      ["pdf", "video"],
    );
    assert.ok(
      manifest.attachments[1]!.notes.some((note) =>
        note.includes("not machine-readable"),
      ),
    );
    assert.ok(manifest.attachments.every((attachment) => attachment.files.length === 1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zip archives are extracted and inventoried without a server unzip dependency", { skip: !hasBinary("zip") }, async () => {
  const root = tempRoot();
  try {
    const source = join(root, "bundle");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "a.txt"), "alpha");
    writeFileSync(join(source, "b.txt"), "beta");
    execFileSync("zip", ["-r", "-q", join(root, "bundle.zip"), "bundle"], { cwd: root });

    const manifest = await ingestAttachments(
      [join(root, "bundle.zip")],
      join(root, "store"),
    );
    const attachment = manifest.attachments[0]!;
    assert.equal(attachment.kind, "zip");
    assert.equal(attachment.files.length, 2);
    assert.ok(attachment.notes.some((note) => note.includes("extracted 2 file")));
    assert.ok(
      attachment.files.every(
        (file) => existsSync(file.path) && readFileSync(file.path, "utf8").length > 0,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web URLs are fetched through the injected fetch and snapshotted with a typed extension", async () => {
  const root = tempRoot();
  try {
    const fetchImpl = (async (url: unknown) =>
      new Response("<html><body>hi</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch;
    const manifest = await ingestAttachments(
      ["https://example.org/paper"],
      join(root, "store"),
      {
        fetchImpl,
        lookupImpl: (async () => [
          { address: "93.184.216.34", family: 4 },
        ]) as unknown as Lookup,
      },
    );
    const attachment = manifest.attachments[0]!;
    assert.equal(attachment.kind, "web");
    assert.equal(attachment.origin, "https://example.org/paper");
    assert.equal(attachment.files.length, 1);
    assert.ok(attachment.files[0]!.path.endsWith(".html"));
    assert.equal(readFileSync(attachment.files[0]!.path, "utf8").includes("hi"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("web ingestion blocks private hosts and private redirect targets", async () => {
  const root = tempRoot();
  try {
    const privateLookup = (async () => [
      { address: "127.0.0.1", family: 4 },
    ]) as unknown as Lookup;
    await assert.rejects(
      ingestAttachments(
        ["http://localhost/admin"],
        join(root, "local"),
        { lookupImpl: privateLookup },
      ),
      /local or private host/,
    );
    await assert.rejects(
      ingestAttachments(
        ["http://public.example/start"],
        join(root, "redirect"),
        {
          lookupImpl: (async (hostname: string) =>
            hostname === "public.example"
              ? [{ address: "93.184.216.34", family: 4 }]
              : [{ address: "10.0.0.1", family: 4 }]) as unknown as Lookup,
          fetchImpl: (async () =>
            new Response(null, {
              status: 302,
              headers: { location: "http://private.example/secret" },
            })) as unknown as typeof fetch,
        },
      ),
      /private or reserved address/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing path or failing URL rejects the whole ingestion with a clear error", async () => {
  const root = tempRoot();
  try {
    await assert.rejects(
      ingestAttachments([join(root, "does-not-exist")], join(root, "store")),
      (error: unknown) =>
        error instanceof AttachmentIngestError &&
        error.message.includes("no such file or directory"),
    );
    const failingFetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(
      ingestAttachments(["https://example.org/gone"], join(root, "store"), {
        fetchImpl: failingFetch,
        lookupImpl: (async () => [
          { address: "93.184.216.34", family: 4 },
        ]) as unknown as Lookup,
      }),
      (error: unknown) =>
        error instanceof AttachmentIngestError && error.message.includes("HTTP 404"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
