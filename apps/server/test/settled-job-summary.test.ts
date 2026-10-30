import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STAGE_IDS } from "@brainstorm-agentic/protocol";
import { JobManager } from "../src/job-manager.js";

test("cold settled lists use checkpoint metadata without opening historical artifacts or event logs", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-settled-summary-"));
  const originalRead = fs.readFileSync;
  const originalStat = fs.statSync;
  const archiveAccesses: string[] = [];
  const forbidden = (path: unknown) => {
    const name = String(path);
    if (name.includes("/artifacts/") || /\/(events|facts|fact-updates)\.jsonl$/.test(name)) {
      archiveAccesses.push(name);
      throw new Error("Cold archive must not be accessed by a landing card");
    }
  };
  try {
    const processed = { title: "Recorded research title", question: "Question", context: "Context", attachments: [], assumptions: [] };
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const jobDir = join(workspace, "workspace/jobs", status);
      const sessionDir = join(workspace, "workspace/sessions", status);
      mkdirSync(jobDir, { recursive: true });
      mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
      writeFileSync(join(jobDir, "job.json"), JSON.stringify({ jobId: status, topic: "Original submission", status,
        runner: "local", createdAt: 10, updatedAt: 20, attachments: ["/data/paper.pdf"],
        contentBundle: { id: "brainstorm", version: "0.29.0", manifestSha256: "pin" } }));
      writeFileSync(join(sessionDir, "checkpoint.json"), JSON.stringify({ runId: status, workflowId: "brainstorm", status,
        updatedAt: 30, input: { __brainstormState: { params: { gamifiedReview: true, gameDecisionThreshold: 0.7 } } },
        pendingGates: [], journal: [{ kind: "agent", key: "brainstorm-root/process-input/process-input-execute::result", value: { status: "ok", output: status === "failed" ? processed : { ...processed, type: "research" } } }],
        ...(status === "failed" ? { error: { message: "Recorded failure" } } : {}) }));
      writeFileSync(join(sessionDir, "artifacts/index.json"), JSON.stringify({ refs: [{ id: "payload", metadata: { schema: "processorOutput", path: "input" } }] }));
      writeFileSync(join(sessionDir, "artifacts/payload"), JSON.stringify({ ...processed, title: "Full archived title" }));
    }
    const manager = new JobManager({ workspace });
    fs.readFileSync = ((path: unknown, ...args: unknown[]) => { forbidden(path); return Reflect.apply(originalRead, fs, [path, ...args]); }) as typeof fs.readFileSync;
    Reflect.set(fs, "statSync", (path: unknown, ...args: unknown[]) => { forbidden(path); return Reflect.apply(originalStat, fs, [path, ...args]); });
    syncBuiltinESMExports();
    const jobs = await manager.list();
    assert.equal(jobs.length, 3);
    assert.deepEqual(archiveAccesses, [], "no archive stat or read may block a cold settled list");
    for (const job of jobs) {
      assert.equal(job.title, processed.title);
      assert.equal(job.topic, "Original submission");
      assert.equal(job.updatedAt, 30);
      assert.deepEqual(job.attachments, ["/data/paper.pdf"]);
      assert.deepEqual(job.contentBundle, { id: "brainstorm", version: "0.29.0" });
      assert.equal(job.gamifiedReview, true);
      assert.equal(job.gameReview?.threshold, 0.7);
      assert.equal(job.progress?.completedStages, job.status === "completed" ? STAGE_IDS.length : job.status === "failed" ? 0 : 1,
        "a failed split classifier cannot complete the processing stage merely because preprocessing succeeded");
    }
    assert.equal(jobs.find((job) => job.status === "failed")?.error, "Recorded failure");
    fs.readFileSync = originalRead; Reflect.set(fs, "statSync", originalStat); syncBuiltinESMExports();
    const detail = await manager.detail("completed");
    assert.equal(detail.title, "Full archived title", "explicit detail requests retain full artifact projection");
    assert.equal((await manager.list()).find((job) => job.jobId === "completed")?.title, detail.title,
      "once opened, a settled detail enriches the cached landing summary");
  } finally {
    fs.readFileSync = originalRead; Reflect.set(fs, "statSync", originalStat); syncBuiltinESMExports();
    rmSync(workspace, { recursive: true, force: true });
  }
});
