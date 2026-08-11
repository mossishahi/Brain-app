import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installId,
  TelemetrySpool,
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryEvent,
} from "@brainstorm-agentic/telemetry";

import { workspaceRootFromSessionRoot } from "../src/env.js";

/**
 * The cross-process telemetry contract: the worker appends run summaries to
 * the spool, the SERVER drains and sends them. The server drains
 * `<workspace>/telemetry/spool.jsonl` and lays sessions out as
 * `<workspace>/workspace/sessions`, so the worker's derivation from its
 * `--session-root` must land on the same workspace root — one level short and
 * every run summary is spooled where nothing ever drains it.
 */

test("a server-launched session root resolves to the server's workspace root", () => {
  const workspace = join("/home/user", ".brainstorm-agentic");
  assert.equal(
    workspaceRootFromSessionRoot(join(workspace, "workspace", "sessions")),
    workspace,
  );
});

test("a bespoke session root keeps the one-level parent", () => {
  assert.equal(
    workspaceRootFromSessionRoot(join("/scratch/me", "my-sessions")),
    "/scratch/me",
  );
});

test("worker-spooled records land where the server's sender drains", () => {
  const workspace = mkdtempSync(join(tmpdir(), "bsa-telemetry-"));
  try {
    const sessionRoot = join(workspace, "workspace", "sessions");
    const workerWorkspace = workspaceRootFromSessionRoot(sessionRoot);

    // Both processes must agree on the install identity file.
    assert.equal(installId(workerWorkspace), installId(workspace));

    // The worker's half of the contract: append a run summary.
    const event: TelemetryEvent = {
      type: "run.summary",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: "event-1",
      installId: installId(workerWorkspace),
      at: new Date().toISOString(),
      appVersion: "0.0.0-test",
      platform: "test",
      runner: "local",
      provider: "offline",
      runId: "run-1",
      summary: { status: "completed", resumed: false, stages: [], roles: [], failures: [] },
    };
    new TelemetrySpool(workerWorkspace).append(event);

    // The server's half: TelemetrySender drains TelemetrySpool(<workspace>).
    const drained = new TelemetrySpool(workspace).drain();
    assert.equal(drained.length, 1);
    assert.deepEqual(drained[0], event);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
