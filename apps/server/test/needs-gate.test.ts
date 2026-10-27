import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobManager } from "../src/job-manager.js";
import type { JobRecord } from "../src/model.js";

const embeddingInput = {
  title: "Message passing over Gaussian node distributions",
  abstract: "A".repeat(160),
  facets: [
    { name: "message passing", statement: "S".repeat(50), relevance: 0.95 },
    { name: "graph generation", statement: "G".repeat(50), relevance: 0.9 },
    { name: "random graph models", statement: "R".repeat(50), relevance: 0.7 },
  ],
};

/** A local job suspended on the confirm-needs gate, materialized on disk. */
function suspendedOnNeeds(workspace: string, gateKey = "confirm-needs", path = "brainstorm/maybe-confirm-needs/confirm-needs"): string {
  const jobId = "job-needs-1";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
  const record: JobRecord = {
    jobId,
    topic: "topic",
    status: "suspended",
    runner: "local",
    createdAt: 1,
    updatedAt: 2,
  };
  writeFileSync(join(jobDir, "job.json"), JSON.stringify(record));
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "suspended",
      input: { __brainstormState: { params: { coreWeight: 1, formulationWeight: 0.5, equivalentProblemWeight: 0 } } },
      journal: [],
      pendingGates: [{ gateKey, path, prompt: "Confirm the needs" }],
      seq: 1,
      updatedAt: Date.now(),
    }),
  );
  writeFileSync(
    join(sessionDir, "artifacts", "index.json"),
    JSON.stringify({ refs: [{ id: "a-class", metadata: { schema: "taskClassification", path: "classification" } }] }),
  );
  writeFileSync(join(sessionDir, "artifacts", "a-class"), JSON.stringify({ embeddingInput }));
  return jobId;
}

test("the needs gate serves its payload and refuses edits editRule needs forbids", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-needs-manager-"));
  try {
    const jobId = suspendedOnNeeds(workspace);
    const manager = new JobManager({ workspace });
    const view = await manager.needsGate(jobId);
    assert.equal(view?.gateKey, "confirm-needs");
    assert.deepEqual(view?.embeddingInput, embeddingInput);
    assert.equal(await manager.panelEvidence(jobId), undefined);

    const rewritten = structuredClone(embeddingInput);
    rewritten.facets[0]!.statement = "A rewritten statement that the gate must refuse.";
    await assert.rejects(
      manager.answerGate(jobId, { gateKey: "confirm-needs", action: "edit", embeddingInput: rewritten }),
      /statement cannot be rewritten/,
    );
    const tooFew = { ...embeddingInput, facets: embeddingInput.facets.slice(0, 2) };
    await assert.rejects(
      manager.answerGate(jobId, { gateKey: "confirm-needs", action: "edit", embeddingInput: tooFew }),
      /at least 3 facets/,
    );
    await assert.rejects(
      manager.answerGate(jobId, { gateKey: "confirm-needs", action: "edit" }),
      /needs the edited embeddingInput/,
    );
    await assert.rejects(
      manager.answerGate(jobId, { gateKey: "confirm-needs", action: "approve", embeddingInput }),
      /does not accept a needs edit/,
    );
    await assert.rejects(
      manager.answerGate(jobId, { gateKey: "confirm-needs", action: "edit", embeddingInput, members: ["m"] }),
      /accepts only the edited embeddingInput/,
    );
    await assert.rejects(manager.needsGate("job-missing"), /was not found/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a needs edit is refused on any other gate", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-needs-manager-"));
  try {
    const jobId = suspendedOnNeeds(workspace, "confirm-panel", "brainstorm/confirm-panel");
    const manager = new JobManager({ workspace });
    assert.equal(await manager.needsGate(jobId), undefined);
    await assert.rejects(
      manager.answerGate(jobId, { gateKey: "confirm-panel", action: "edit", embeddingInput }),
      /does not accept a needs edit/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
