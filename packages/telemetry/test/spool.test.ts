import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TelemetrySpool, installId, type TelemetryEvent } from "../src/index.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "bsa-spool-"));
}

const event = (id: string): TelemetryEvent =>
  ({
    schemaVersion: 1,
    type: "run.summary",
    eventId: id,
    runId: `run-${id}`,
    installId: "install",
    at: "2026-01-01T00:00:00.000Z",
    appVersion: "0.1.0",
    platform: "test",
    runner: "local",
    provider: "offline",
    status: "completed",
  }) as unknown as TelemetryEvent;

test("appended records come back in order, and draining clears the spool", () => {
  const root = workspace();
  try {
    const spool = new TelemetrySpool(root);
    spool.append(event("a"));
    spool.append(event("b"));

    const drained = spool.drain();
    assert.deepEqual(
      drained.map((record) => (record as { eventId: string }).eventId),
      ["a", "b"],
    );
    // Draining takes ownership: a second drain must not hand out the same
    // records again, or a retry would double-count every run.
    assert.deepEqual(spool.drain(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a torn trailing line from a crash mid-append is dropped, not fatal", () => {
  const root = workspace();
  try {
    const spool = new TelemetrySpool(root);
    spool.append(event("a"));
    // Exactly what a crash between write() and the newline leaves behind.
    writeFileSync(join(root, "telemetry", "spool.jsonl"), `${JSON.stringify(event("a"))}\n{"type":"run.su`, {
      flag: "w",
    });

    const drained = spool.drain();
    assert.equal(drained.length, 1, "the intact record survives its damaged neighbour");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore puts undelivered records back for the next attempt", () => {
  const root = workspace();
  try {
    const spool = new TelemetrySpool(root);
    spool.append(event("a"));
    const drained = spool.drain();

    spool.restore(drained);
    assert.deepEqual(
      spool.drain().map((record) => (record as { eventId: string }).eventId),
      ["a"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a read failure during drain keeps the batch instead of destroying it", (t) => {
  // Regression: drain() removed the staged file in a `finally`, so a read that
  // threw returned an empty array AND deleted the records — the caller got
  // nothing to restore and never knew anything was lost. A transient read
  // failure must cost a retry, not the batch.
  const root = workspace();
  try {
    const spool = new TelemetrySpool(root);
    spool.append(event("a"));
    spool.append(event("b"));

    const path = join(root, "telemetry", "spool.jsonl");
    chmodSync(path, 0o000);
    try {
      readFileSync(path, "utf8");
      // Running as root (or on a filesystem ignoring the mode) — the failure
      // this test needs cannot be produced here.
      t.skip("the environment can read a mode-000 file, so no read failure occurs");
      return;
    } catch {
      // Good: the read genuinely fails, which is the case under test.
    }

    assert.deepEqual(spool.drain(), [], "a failed read yields nothing");
    chmodSync(path, 0o600);
    assert.ok(existsSync(path), "and leaves the spool where it was, not consumed");
    assert.deepEqual(
      spool.drain().map((record) => (record as { eventId: string }).eventId),
      ["a", "b"],
      "so the records are still there once the cause clears",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append never throws, whatever state the workspace is in", () => {
  // Telemetry must never be able to fail a run. A path that cannot be created
  // is the ordinary case on a read-only or full filesystem.
  const root = workspace();
  try {
    // A FILE where the telemetry DIRECTORY belongs: mkdir and append both fail.
    writeFileSync(join(root, "telemetry"), "not a directory", "utf8");
    const spool = new TelemetrySpool(root);
    assert.doesNotThrow(() => spool.append(event("a")));
    assert.deepEqual(spool.drain(), [], "and drain stays quiet too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the install id is minted once and then stable", () => {
  const root = workspace();
  try {
    const first = installId(root);
    assert.match(first, /^[0-9a-f-]{36}$/, "a plain UUID, carrying no machine detail");
    assert.equal(installId(root), first, "a second call must not mint a new identity");
    // Stability is the whole point: it is what makes "did this install's runs
    // get faster?" answerable, and it cannot be reconstructed after the fact.
    assert.equal(readFileSync(join(root, "install-id"), "utf8").trim(), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable workspace still yields an id rather than failing", () => {
  const root = workspace();
  try {
    writeFileSync(join(root, "install-id"), "", "utf8");
    chmodSync(root, 0o500);
    const minted = installId(root);
    assert.match(minted, /^[0-9a-f-]{36}$/);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
