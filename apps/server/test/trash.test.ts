import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  JobStatus,
  JobSummary,
  TrashJobResponse,
} from "@brainstorm-agentic/protocol";

import {
  JobConflictError,
  JobManager,
  startBrainServer,
} from "../src/index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "brain-trash-"));
}

function writeJob(
  workspace: string,
  jobId: string,
  status: JobStatus,
  extra: Record<string, unknown> = {},
): void {
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: `topic of ${jobId}`,
      status,
      runner: "local",
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 120_000,
      ...extra,
    }),
  );
}

test("terminal jobs move to a view-only trash that filters lists and survives restart", async () => {
  const workspace = tempRoot();
  const manager = new JobManager({ workspace });
  writeJob(workspace, "done-job", "completed");
  writeJob(workspace, "dead-job", "failed");
  writeJob(workspace, "ghost-job", "orphaned");
  manager.reload();

  const trashed = await manager.trash("done-job");
  assert.equal(trashed.jobId, "done-job");
  assert.ok(trashed.trashedAt > 0);

  // Trashing again is idempotent and keeps the original timestamp.
  assert.deepEqual(await manager.trash("done-job"), trashed);

  // Already-dead orphaned jobs qualify too.
  await manager.trash("ghost-job");

  const active = await manager.list();
  assert.deepEqual(active.map((job) => job.jobId), ["dead-job"]);

  const bin = await manager.listTrashed();
  assert.deepEqual(
    bin.map((job) => job.jobId).sort(),
    ["done-job", "ghost-job"],
  );
  const binned = bin.find((job) => job.jobId === "done-job");
  assert.equal(binned?.trashedAt, trashed.trashedAt);

  // The dashboard stays readable for trashed jobs (view-only, files intact).
  const detail = await manager.detail("done-job");
  assert.equal(detail.trashedAt, trashed.trashedAt);
  assert.equal(detail.topic, "topic of done-job");

  // A restart reloads the persisted trash marker from job.json.
  const restarted = new JobManager({ workspace });
  assert.deepEqual(
    (await restarted.list()).map((job) => job.jobId),
    ["dead-job"],
  );
  assert.deepEqual(
    (await restarted.listTrashed()).map((job) => job.jobId).sort(),
    ["done-job", "ghost-job"],
  );

  // Unknown jobs surface the standard not-found error.
  await assert.rejects(manager.trash("missing-job"), /was not found/);
});

test("live jobs conflict on trash until they are stopped", async () => {
  const workspace = tempRoot();
  // This test process's own pid makes the job look alive to the manager.
  writeJob(workspace, "live-job", "running", { pid: process.pid });
  const manager = new JobManager({ workspace });

  await assert.rejects(manager.trash("live-job"), JobConflictError);
  assert.equal((await manager.list()).length, 1);
  assert.equal((await manager.listTrashed()).length, 0);

  // Once stopped (simulated externally), the same job becomes trashable.
  writeJob(workspace, "live-job", "cancelled", { pid: process.pid });
  manager.reload();
  const trashed = await manager.trash("live-job");
  assert.ok(trashed.trashedAt > 0);
  assert.deepEqual(
    (await manager.listTrashed()).map((job) => job.jobId),
    ["live-job"],
  );
});

test("trash endpoints list the bin and reject live jobs with 409", async () => {
  const workspace = tempRoot();
  writeJob(workspace, "done-job", "completed");
  writeJob(workspace, "live-job", "running", { pid: process.pid });
  const server = await startBrainServer({
    workspace,
    // Unreachable registry: the health probe fails fast and is irrelevant here.
    contentRegistryUrl: "http://127.0.0.1:9/mcp",
    contentRegistryStatus: { running: false, url: "http://127.0.0.1:9/mcp" },
  });
  try {
    const conflict = await fetch(`${server.url}/api/jobs/live-job/trash`, {
      method: "POST",
    });
    assert.equal(conflict.status, 409);

    const ok = await fetch(`${server.url}/api/jobs/done-job/trash`, {
      method: "POST",
    });
    assert.equal(ok.status, 200);
    const trashed = (await ok.json()) as TrashJobResponse;
    assert.equal(trashed.jobId, "done-job");
    assert.ok(trashed.trashedAt > 0);

    const active = (await (
      await fetch(`${server.url}/api/jobs`)
    ).json()) as JobSummary[];
    assert.deepEqual(active.map((job) => job.jobId), ["live-job"]);

    const bin = (await (
      await fetch(`${server.url}/api/jobs/trash`)
    ).json()) as JobSummary[];
    assert.deepEqual(bin.map((job) => job.jobId), ["done-job"]);
    assert.equal(bin[0]?.trashedAt, trashed.trashedAt);

    const missing = await fetch(`${server.url}/api/jobs/missing-job/trash`, {
      method: "POST",
    });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});
