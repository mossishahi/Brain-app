import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson } from "../src/files.js";
import { readJsonCached, readJsonlCached } from "../src/read-cache.js";

test("atomic same-size settings replacement invalidates cached JSON even with an identical mtime", () => {
  const workspace = mkdtempSync(join(tmpdir(), "read-cache-"));
  try {
    const path = join(workspace, "settings.json");
    const timestamp = new Date("2026-01-01T00:00:00Z");
    atomicWriteJson(path, { gameReview: { threshold: 1 } });
    utimesSync(path, timestamp, timestamp);
    const before = statSync(path, { bigint: true });
    assert.deepEqual(readJsonCached(path), { gameReview: { threshold: 1 } });

    atomicWriteJson(path, { gameReview: { threshold: 0 } });
    utimesSync(path, timestamp, timestamp);
    const after = statSync(path, { bigint: true });
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.dev, before.dev);
    assert.notEqual(after.ino, before.ino, "atomic replacement has a distinct exact inode, even when Number-rounded IDs coincide");
    assert.deepEqual(readJsonCached(path), { gameReview: { threshold: 0 } });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("atomic same-size JSONL replacement refreshes committed records even with an identical mtime", () => {
  const workspace = mkdtempSync(join(tmpdir(), "read-cache-"));
  try {
    const path = join(workspace, "facts.jsonl");
    const replacement = join(workspace, "replacement.jsonl");
    const timestamp = new Date("2026-01-01T00:00:00Z");
    writeFileSync(path, '{"value":1}\n'); utimesSync(path, timestamp, timestamp);
    const before = statSync(path, { bigint: true });
    assert.deepEqual(readJsonlCached(path), [{ value: 1 }]);
    writeFileSync(replacement, '{"value":2}\n'); utimesSync(replacement, timestamp, timestamp);
    renameSync(replacement, path);
    const after = statSync(path, { bigint: true });
    assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs); assert.notEqual(after.ino, before.ino);
    assert.deepEqual(readJsonlCached(path), [{ value: 2 }]);
    writeFileSync(path, "");
    assert.deepEqual(readJsonlCached(path), [], "truncating a journal clears its previous records");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
