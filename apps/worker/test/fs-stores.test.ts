import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { WorkflowCheckpoint } from "@brainstorm-agentic/core";

import { FsArtifactStore, FsCheckpointStore } from "../src/fs-stores.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "fs-stores-test-"));
}

test("checkpoints serialize compactly (no pretty-printing)", async () => {
  const root = workspace();
  try {
    const store = new FsCheckpointStore(root);
    const checkpoint: WorkflowCheckpoint = {
      runId: "run-1",
      workflowId: "brainstorm",
      status: "running",
      journalFormat: 2,
      journal: [{ key: "a::result", kind: "activity", value: { nested: [1, 2, 3] } }],
      pendingGates: [],
      seq: 1,
      updatedAt: 123,
    };
    await store.save(checkpoint);
    const raw = readFileSync(join(root, "run-1", "checkpoint.json"), "utf8");
    assert.equal(raw, JSON.stringify(checkpoint), "compact JSON, byte for byte");
    assert.deepEqual(await store.load("run-1"), checkpoint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact puts are idempotent on (name, payload)", async () => {
  const root = workspace();
  try {
    const store = new FsArtifactStore(root, "run-1");
    const first = await store.put({ name: "run-1/ideas.member-1.json", data: '{"v":1}' });
    const replayed = await store.put({ name: "run-1/ideas.member-1.json", data: '{"v":1}' });
    assert.equal(replayed.id, first.id, "the same bytes under the same name reuse the ref");
    assert.equal((await store.list()).length, 1);

    // A REVISED payload under the same name is a new version, not a dupe.
    const revised = await store.put({ name: "run-1/ideas.member-1.json", data: '{"v":2}' });
    assert.notEqual(revised.id, first.id);
    // Replaying the whole history (first pass, then the revision) reuses
    // both refs — the exact access pattern of a resumed run's state folds.
    assert.equal((await store.put({ name: "run-1/ideas.member-1.json", data: '{"v":1}' })).id, first.id);
    assert.equal((await store.put({ name: "run-1/ideas.member-1.json", data: '{"v":2}' })).id, revised.id);
    assert.equal((await store.list()).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refs written before hashes existed are backfilled and dedupe correctly", async () => {
  const root = workspace();
  try {
    const dir = join(root, "run-1", "artifacts");
    mkdirSync(dir, { recursive: true });
    // A pre-hash index, as an old run left it on disk.
    writeFileSync(join(dir, "artifact-1"), '{"v":1}', "utf8");
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({
        counter: 1,
        refs: [{ id: "artifact-1", name: "run-1/pool.json", size: 7 }],
      }),
      "utf8",
    );
    const store = new FsArtifactStore(root, "run-1");
    const replayed = await store.put({ name: "run-1/pool.json", data: '{"v":1}' });
    assert.equal(replayed.id, "artifact-1", "the legacy ref is reused, not duplicated");
    const refs = await store.list();
    assert.equal(refs.length, 1);
    assert.ok(refs[0]!.sha256, "the legacy ref gained its hash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
