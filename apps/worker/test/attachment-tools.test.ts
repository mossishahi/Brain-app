import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { attachmentTools } from "../src/attachment-tools.js";

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "bsa-att-tools-"));
  mkdirSync(join(root, "1-repo", "src"), { recursive: true });
  writeFileSync(join(root, "1-repo", "src", "train.py"), "print('hello')\n");
  writeFileSync(join(root, "1-repo", "notes.md"), "# notes\n");
  // Tiny valid PNG (1x1) so the image path is exercised with real bytes.
  writeFileSync(
    join(root, "1-repo", "figure.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  writeFileSync(join(root, "1-repo", "paper.pdf"), "%PDF-1.4 stub");
  writeFileSync(join(root, "1-repo", "demo.mp4"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, "1-repo", "blob.bin"), Buffer.from([0, 255, 0, 255]));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const context = { runId: "run-1" };

test("attachment_read serves text, returns image/PDF blocks, and refuses binary/video", async () => {
  const { root, cleanup } = fixture();
  try {
    const [, read] = attachmentTools([root]);

    const text = await read!.execute({ path: join(root, "1-repo", "src", "train.py") }, context);
    assert.equal(text.isError, undefined);
    assert.match(String(text.output), /print\('hello'\)/);

    const image = await read!.execute({ path: join(root, "1-repo", "figure.png") }, context);
    assert.equal(image.isError, undefined);
    assert.equal(image.blocks?.length, 1);
    const block = image.blocks![0]!;
    assert.equal(block.type, "image");
    assert.ok(
      block.type === "image" &&
        block.source.kind === "base64" &&
        block.source.mediaType === "image/png" &&
        block.source.data.length > 0,
    );

    const pdf = await read!.execute({ path: join(root, "1-repo", "paper.pdf") }, context);
    assert.equal(pdf.isError, undefined);
    assert.equal(pdf.blocks?.[0]?.type, "document");
    assert.ok(
      pdf.blocks?.[0]?.type === "document" &&
        pdf.blocks[0].source.kind === "base64" &&
        pdf.blocks[0].source.mediaType === "application/pdf",
    );

    const video = await read!.execute({ path: join(root, "1-repo", "demo.mp4") }, context);
    assert.equal(video.isError, true);

    const binary = await read!.execute({ path: join(root, "1-repo", "blob.bin") }, context);
    assert.equal(binary.isError, true);
    assert.match(String(binary.output), /binary/);
  } finally {
    cleanup();
  }
});

test("attachment_read never leaves the attachment store", async () => {
  const { root, cleanup } = fixture();
  try {
    const [, read] = attachmentTools([root]);
    for (const escape of [
      "/etc/passwd",
      join(root, "..", "outside.txt"),
      `${root}/../${root.split("/").pop()!}-other/x.txt`,
    ]) {
      const result = await read!.execute({ path: escape }, context);
      assert.equal(result.isError, true, `must refuse ${escape}`);
      assert.match(String(result.output), /outside|No attached file/);
    }
    const missingPath = await read!.execute({ path: join(root, "1-repo", "nope.txt") }, context);
    assert.equal(missingPath.isError, true);
  } finally {
    cleanup();
  }
});

test("attachment_list inventories every file and honors the prefix filter", async () => {
  const { root, cleanup } = fixture();
  try {
    const [list] = attachmentTools([root]);
    const all = await list!.execute({}, context);
    const files = (all.output as { files: { path: string; bytes: number }[] }).files;
    assert.equal(files.length, 6);
    assert.ok(files.every((file) => file.path.startsWith(root) && file.bytes >= 0));

    const filtered = await list!.execute(
      { prefix: join(root, "1-repo", "src") },
      context,
    );
    const filteredFiles = (filtered.output as { files: { path: string }[] }).files;
    assert.equal(filteredFiles.length, 1);
    assert.match(filteredFiles[0]!.path, /train\.py$/);
  } finally {
    cleanup();
  }
});
