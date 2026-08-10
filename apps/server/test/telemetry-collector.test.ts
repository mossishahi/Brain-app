import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { JobSummary } from "@brainstorm-agentic/protocol";
import { TelemetrySpool } from "@brainstorm-agentic/telemetry";

import { buildDiagnostic, TelemetryCollector } from "../src/telemetry-collector.js";

function jobSummary(jobId: string, status: JobSummary["status"]): JobSummary {
  return {
    jobId,
    topic: "a submission whose text must never ride telemetry",
    status,
    runner: "local",
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now(),
  };
}

/**
 * Regression: the collector read checkpoints from
 * `<jobsDir>/<jobId>/session/checkpoint.json` — a path that does not exist in
 * the real workspace layout (`<workspace>/workspace/sessions/<jobId>/
 * checkpoint.json`), so every failure record silently degraded to the generic
 * "RunFailed" class. The collector must read the layout the worker writes.
 */
test("a failed run's telemetry record carries the checkpoint's error class", () => {
  const workspace = mkdtempSync(join(tmpdir(), "telemetry-collector-"));
  try {
    const sessionsDir = join(workspace, "workspace", "sessions");
    mkdirSync(join(sessionsDir, "job-1"), { recursive: true });
    writeFileSync(
      join(sessionsDir, "job-1", "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "failed",
        error: { name: "ArtifactValidationError", message: "quotes the submission" },
        journal: [],
        pendingGates: [],
        seq: 3,
        updatedAt: Date.now(),
      }),
    );

    const spool = new TelemetrySpool(workspace);
    const collector = new TelemetryCollector(spool, sessionsDir, () => ({
      installId: "install-1",
      appVersion: "0.0.0-test",
      provider: "offline",
      runner: "local",
    }));
    collector.collect([jobSummary("job-1", "failed")]);

    const records = spool.drain();
    assert.equal(records.length, 1);
    const failure = records[0] as { type: string; failure?: { errorName?: string } };
    assert.equal(failure.type, "run.failure");
    assert.equal(
      failure.failure?.errorName,
      "ArtifactValidationError",
      "the error CLASS comes from the real checkpoint, not the generic fallback",
    );
    // Tier-1 telemetry is content-free: the class travels, the message never does.
    assert.equal(JSON.stringify(records).includes("quotes the submission"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("buildDiagnostic reads the checkpoint from the sessions directory and strips journal values", () => {
  const workspace = mkdtempSync(join(tmpdir(), "telemetry-collector-"));
  try {
    const jobsDir = join(workspace, "workspace", "jobs");
    const sessionsDir = join(workspace, "workspace", "sessions");
    mkdirSync(join(jobsDir, "job-1"), { recursive: true });
    mkdirSync(join(sessionsDir, "job-1"), { recursive: true });
    writeFileSync(
      join(jobsDir, "job-1", "events.jsonl"),
      `${JSON.stringify({ type: "run:started", runId: "job-1", seq: 0, at: 1 })}\n`,
    );
    writeFileSync(
      join(sessionsDir, "job-1", "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "failed",
        error: { name: "AgentTaskFailedError" },
        journal: [
          { key: "brainstorm-root/process-input-execute::result", kind: "agent", value: { text: "the developed idea" } },
        ],
        pendingGates: [],
        seq: 7,
        updatedAt: Date.now(),
      }),
    );

    const { report, preview } = buildDiagnostic(
      jobsDir,
      sessionsDir,
      jobSummary("job-1", "failed"),
      true,
    );

    const checkpoint = report.checkpoint as {
      status?: unknown;
      seq?: unknown;
      journal?: Array<{ key?: unknown; kind?: unknown; value?: unknown }>;
    };
    assert.ok(checkpoint, "the report carries the checkpoint shape from the real layout");
    assert.equal(checkpoint.status, "failed");
    assert.equal(checkpoint.seq, 7);
    assert.deepEqual(checkpoint.journal, [
      { key: "brainstorm-root/process-input-execute::result", kind: "agent" },
    ]);
    // Keys and kinds only — journaled values hold the submitter's material.
    assert.equal(JSON.stringify(report).includes("the developed idea"), false);
    assert.equal((report.events as string[]).length, 1);
    const component = preview.components.find((entry) => entry.id === "checkpoint");
    assert.ok(component && component.bytes > 20, "the preview reflects a real checkpoint shape");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
