import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobManager } from "../src/job-manager.js";
import type { JobRecord } from "../src/model.js";
import { defaultReadinessProbes } from "../src/readiness.js";
import { slurmSubmissionReceipt } from "../src/slurm-submission.js";

async function fixture(sbatch: string, queue = "", accounting = "", onChange?: (workspace: string) => void) {
  const workspace = mkdtempSync(join(tmpdir(), "brain-slurm-receipt-"));
  const bin = join(workspace, "bin");
  mkdirSync(bin);
  const trace = join(workspace, "commands");
  const receipt = join(workspace, "receipt-token");
  const release = join(workspace, "release");
  for (const [command, body] of Object.entries({ sbatch, squeue: queue, sacct: accounting, scancel: "" })) {
    const path = join(bin, command);
    writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' '${command}' >> "$TRACE"\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TRACE: trace, RECEIPT: receipt, RELEASE: release };
  const manager = new JobManager({ workspace, env, gateAutoApproveGraceMs: 0, onChange: () => onChange?.(workspace) });
  await manager.settings.put({ runner: "slurm", llm: { provider: "offline" }, gateAutoApprove: true });
  return {
    workspace, manager, env, release,
    record: (id: string) => JSON.parse(readFileSync(join(manager.jobDir(id), "job.json"), "utf8")) as JobRecord,
    calls: () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [],
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

const captureToken = `
for arg in "$@"; do
  case "$arg" in --comment=*) printf '%s' "\${arg#--comment=}" > "$RECEIPT";; esac
done
`;

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "fixture command started before deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("scheduler receipts accept parsable and legacy wrappers without interpreting warnings as IDs", () => {
  assert.deepEqual(slurmSubmissionReceipt("123;serial\n", "warning: license busy"), { jobId: "123", cluster: "serial" });
  assert.deepEqual(slurmSubmissionReceipt("Submitted batch job 123 on cluster serial\n"), { jobId: "123", cluster: "serial" });
  assert.deepEqual(slurmSubmissionReceipt("", "Submitted batch job 123\n"), { jobId: "123" });
  assert.equal(slurmSubmissionReceipt("warning: job 123 rejected"), undefined);
  assert.equal(slurmSubmissionReceipt("Submitted batch job nonsense"), undefined);
  assert.equal(slurmSubmissionReceipt("123\n124\n"), undefined);
  assert.equal(slurmSubmissionReceipt("123;serial\n", "Submitted batch job 456"), undefined);
});

test("polling a submission before its receipt cannot orphan or duplicate the worker", async () => {
  const h = await fixture(`${captureToken}
case " $* " in *" --parsable "*) ;; *) exit 2;; esac
while [ ! -f "$RELEASE" ]; do sleep 0.01; done
printf '123;serial\\n'
`);
  const pending = h.manager.submit("hi");
  try {
    await until(() => h.calls().includes("sbatch"));
    const id = readdirSync(h.manager.jobsDir)[0]!;
    assert.equal(h.record(id).slurmSubmission?.state, "submitting");
    await assert.rejects(h.manager.pause(id), /submission .*unresolved/);
    await assert.rejects(h.manager.cancel(id), /submission .*unresolved/);
    const summaries = await h.manager.list();
    assert.equal(summaries[0]?.status, "queued");
    await h.manager.resumeInterruptedJobs();
    await h.manager.resumeDueCreditBlocks();
    await h.manager.autoApproveDueGates();
    assert.deepEqual(h.calls(), ["sbatch"]);
    writeFileSync(h.release, "ready");
    assert.equal(await pending, id);
    assert.equal(h.record(id).slurmJobId, "123");
    assert.equal(h.record(id).slurmCluster, "serial");
    assert.equal(h.record(id).slurmSubmission, undefined);
    assert.equal(h.record(id).submissionCount, 1);
  } finally {
    writeFileSync(h.release, "ready");
    await pending.catch(() => undefined);
    h.cleanup();
  }
});

test("an empty receipt reconciles only the exact submission comment, including completed jobs", async () => {
  const h = await fixture(captureToken,
    `printf '987|unrelated\\n'`,
    `printf '456|%s|serial\\n' "$(cat "$RECEIPT")"`);
  try {
    const id = await h.manager.submit("hi");
    assert.equal(h.record(id).slurmJobId, "456");
    assert.equal(h.record(id).slurmCluster, "serial");
    assert.equal(h.record(id).status, "running");
    assert.equal(h.record(id).slurmSubmission, undefined);
    assert.deepEqual(h.calls(), ["sbatch", "squeue", "sacct"]);
  } finally { h.cleanup(); }
});

test("a wrapper that exits nonzero after accepting a job is reconciled without resubmission", async () => {
  const h = await fixture(`${captureToken}\nprintf 'wrapper logging failed\\n' >&2; exit 1`,
    `printf '457|%s\\n' "$(cat "$RECEIPT")"`);
  try {
    const id = await h.manager.submit("hi");
    assert.equal(h.record(id).slurmJobId, "457");
    assert.equal(h.record(id).status, "running");
    assert.equal(h.record(id).slurmSubmission, undefined);
    assert.deepEqual(h.calls(), ["sbatch", "squeue", "sacct"]);
  } finally { h.cleanup(); }
});

test("a receipt persisted before the caller commits its status keeps recovery blocked after a crash", async () => {
  let crashSnapshot: JobRecord | undefined;
  const h = await fixture(`printf '458\\n'`, "", "", (workspace) => {
    const jobs = join(workspace, "workspace", "jobs");
    for (const id of readdirSync(jobs)) {
      const record = JSON.parse(readFileSync(join(jobs, id, "job.json"), "utf8")) as JobRecord;
      if (record.slurmJobId && record.slurmSubmission) crashSnapshot = record;
    }
  });
  try {
    const id = await h.manager.submit("hi");
    assert.equal(crashSnapshot?.slurmJobId, "458");
    assert.equal(crashSnapshot?.submissionCount, 0);
    writeFileSync(join(h.manager.jobDir(id), "job.json"), JSON.stringify(crashSnapshot));
    const restarted = new JobManager({ workspace: h.workspace, env: h.env });
    assert.match(h.record(id).error ?? "", /server stopped before committing SLURM submission/);
    assert.equal(h.record(id).slurmSubmission?.state, "unknown");
    await restarted.list();
    await restarted.resumeInterruptedJobs();
    await restarted.autoApproveDueGates();
    await assert.rejects(restarted.cancel(id), /submission .*unresolved/);
    assert.deepEqual(h.calls(), ["sbatch"]);
    assert.equal(h.record(id).slurmJobId, "458");
  } finally { h.cleanup(); }
});

test("an ambiguous submission stays inspectable and cannot retry after a server restart", async () => {
  const h = await fixture(`${captureToken}\nprintf 'wrapper diagnostic\\n' >&2`);
  try {
    const id = await h.manager.submit("hi");
    const record = h.record(id);
    assert.equal(record.status, "failed");
    assert.equal(record.slurmSubmission?.state, "unknown");
    assert.match(record.error ?? "", /wrapper diagnostic/);
    assert.match(record.error ?? "", /inspect scheduler comment brain-/);
    mkdirSync(h.manager.sessionDir(id), { recursive: true });
    writeFileSync(join(h.manager.sessionDir(id), "checkpoint.json"), JSON.stringify({ status: "failed", seq: 1, journal: {}, pendingGates: [] }));
    const restarted = new JobManager({ workspace: h.workspace, env: h.env });
    await restarted.resumeInterruptedJobs();
    await restarted.resumeDueCreditBlocks();
    await restarted.autoApproveDueGates();
    await assert.rejects(restarted.retryFailed(id), /previous SLURM submission is unresolved/);
    await assert.rejects(restarted.cancel(id), /submission .*unresolved/);
    assert.deepEqual(h.calls(), ["sbatch", "squeue", "sacct"]);
    assert.equal(h.record(id).slurmSubmission?.token, record.slurmSubmission?.token);
  } finally { h.cleanup(); }
});

test("multiple exact ownership matches remain unresolved instead of selecting a worker", async () => {
  const h = await fixture(captureToken, `printf '123|%s\\n124|%s\\n' "$(cat "$RECEIPT")" "$(cat "$RECEIPT")"`);
  try {
    const id = await h.manager.submit("hi");
    assert.equal(h.record(id).slurmJobId, undefined);
    assert.equal(h.record(id).slurmSubmission?.state, "unknown");
    assert.match(h.record(id).error ?? "", /no output on stdout or stderr/);
  } finally { h.cleanup(); }
});

test("a definitive scheduler rejection keeps its diagnostic without an unknown-submission guard", async () => {
  const h = await fixture(`printf 'sbatch: error: invalid partition specified\\n' >&2; exit 1`);
  try {
    await assert.rejects(h.manager.submit("hi"), /invalid partition/);
    const id = readdirSync(h.manager.jobsDir)[0]!;
    assert.equal(h.record(id).slurmSubmission, undefined);
    assert.equal(h.record(id).status, "failed");
    assert.deepEqual(h.calls(), ["sbatch", "squeue", "sacct"]);
  } finally { h.cleanup(); }
});

test("readiness uses the same parsable receipt protocol as pipeline submission", async () => {
  const h = await fixture(`
if [ "$1" = --version ]; then echo 'slurm fixture'; exit 0; fi
case " $* " in *" --parsable "*) ;; *) exit 2;; esac
for arg in "$@"; do script="$arg"; done
bash "$script"
printf '303;serial\\n'
`);
  try {
    const result = await defaultReadinessProbes({
      slurmProbeTimeoutMs: 1_000, validateAnthropic: async () => undefined,
      validateClaudeAgent: async () => undefined, validateCursorAgent: async () => undefined,
    }).slurm({
      settings: h.manager.settings.get(), workspace: h.workspace, env: h.env,
      signal: new AbortController().signal, credentials: {}, onProgress: () => undefined,
    });
    assert.match(result.message ?? "", /probe job 303 ran to completion/);
    assert.deepEqual(h.calls(), ["sbatch", "sbatch"]);
  } finally { h.cleanup(); }
});
