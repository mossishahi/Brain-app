/**
 * The file explorer's one rule: never block, never run without a bound.
 *
 * These tests drive ServerFileBrowser directly (the HTTP suite covers the
 * routes) and pin the properties that ended the frozen-server incident: a
 * search that runs out of budget answers with partial results instead of
 * hanging, an aborted request stops the walk, caps mark the answer truncated,
 * and a folder whose inventory cannot finish in time FAILS validation with a
 * reason instead of freezing the "Validate & attach" click.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ServerFileBrowser } from "../src/server-files.js";

function tempRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "bsa-files-")));
}

test("search finds nested matches, follows symlinked folders, and skips junk", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "papers", "drafts"), { recursive: true });
    writeFileSync(join(root, "papers", "drafts", "main.tex"), "\\begin{}\n");
    writeFileSync(join(root, "papers", "notes.txt"), "notes\n");
    // Junk and hidden entries never surface, even on a name match.
    mkdirSync(join(root, "node_modules", "main-lib"), { recursive: true });
    writeFileSync(join(root, "node_modules", "main-lib", "main.tex"), "x");
    writeFileSync(join(root, ".main.tex"), "hidden");
    // The HPC layout: the useful storage hangs off a symlink, and the link
    // is the ONLY route there — the real directory sits under a hidden
    // parent the walk never enters on its own.
    const scratch = join(root, ".mounts", "scratch");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "main-results.tex"), "results");
    symlinkSync(scratch, join(root, "scratch-link"));

    const browser = new ServerFileBrowser({ roots: [root] });
    const found = await browser.search(undefined, undefined, "file", "main");
    const names = found.entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["main-results.tex", "main.tex"]);
    assert.equal(found.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search stops at the result cap and says so", async () => {
  const root = tempRoot();
  try {
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(root, `match-${index}.txt`), "x");
    }
    const browser = new ServerFileBrowser({
      roots: [root],
      limits: { searchMaxResults: 3 },
    });
    const found = await browser.search(undefined, undefined, "file", "match");
    assert.equal(found.entries.length, 3);
    assert.equal(found.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search out of time answers with what it has instead of hanging", async () => {
  const root = tempRoot();
  try {
    // A wide tree; with a zero budget none of it may be walked.
    for (let index = 0; index < 40; index += 1) {
      const dir = join(root, `dir-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "match.txt"), "x");
    }
    const browser = new ServerFileBrowser({
      roots: [root],
      limits: { searchDeadlineMs: 0 },
    });
    const started = Date.now();
    const found = await browser.search(undefined, undefined, "file", "match");
    assert.equal(found.truncated, true);
    assert.equal(found.entries.length, 0);
    // The whole point: an exhausted budget returns at once.
    assert.ok(Date.now() - started < 2_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted request stops the walk", async () => {
  const root = tempRoot();
  try {
    for (let index = 0; index < 40; index += 1) {
      const dir = join(root, `dir-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "match.txt"), "x");
    }
    const browser = new ServerFileBrowser({ roots: [root] });
    const controller = new AbortController();
    controller.abort();
    const found = await browser.search(
      undefined,
      undefined,
      "file",
      "match",
      controller.signal,
    );
    assert.equal(found.truncated, true);
    assert.equal(found.entries.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browse caps a huge directory and marks the listing partial", async () => {
  const root = tempRoot();
  try {
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(root, `file-${String(index).padStart(2, "0")}.txt`), "x");
    }
    const browser = new ServerFileBrowser({
      roots: [root],
      limits: { browseMaxEntries: 4 },
    });
    const listing = await browser.browse(undefined, undefined, "file");
    assert.equal(listing.entries.length, 4);
    assert.equal(listing.truncated, true);
    // The cap keeps the name-sorted FIRST entries, so which ones survive is
    // deterministic.
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ["file-00.txt", "file-01.txt", "file-02.txt", "file-03.txt"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder whose inventory cannot finish in time fails validation with a reason", async () => {
  const root = tempRoot();
  try {
    const folder = join(root, "dataset");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "data.csv"), "1,2,3\n");
    const browser = new ServerFileBrowser({
      roots: [root],
      limits: { validateDeadlineMs: 0 },
    });
    const [validated] = await browser.validate("folder", [folder]);
    assert.equal(validated!.valid, false);
    assert.match(validated!.reason ?? "", /did not finish in time/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation still counts a healthy folder exactly", async () => {
  const root = tempRoot();
  try {
    const folder = join(root, "project");
    mkdirSync(join(folder, "src"), { recursive: true });
    writeFileSync(join(folder, "src", "model.py"), "def f():\n    return 1\n");
    writeFileSync(join(folder, "README.md"), "# hello\n");
    mkdirSync(join(folder, ".git"), { recursive: true });
    writeFileSync(join(folder, ".git", "HEAD"), "ref");
    const browser = new ServerFileBrowser({ roots: [root] });
    const [validated] = await browser.validate("folder", [folder]);
    assert.equal(validated!.valid, true);
    assert.equal(validated!.files, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
