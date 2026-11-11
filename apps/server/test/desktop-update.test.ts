import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JobSummary } from "@brainstorm-agentic/protocol";
import { TOOL_IDS } from "../src/availability.js";
import { JobManager } from "../src/job-manager.js";
import { startBrainServer } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";

async function fixture(seedCompletedWorker?: "worker" | "reused-pid", updateOptions: { desktopUpdateLeaseMs?: number; exitForUpdate?: () => void; unauthenticated?: boolean } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "brain-desktop-update-"));
  const workerPath = join(workspace, "worker.cjs");
  let worker: ChildProcess | undefined;
  if (seedCompletedWorker) {
    const directory = join(workspace, "workspace/jobs/completed-worker");
    mkdirSync(directory, { recursive: true });
    if (seedCompletedWorker === "worker") {
      writeFileSync(workerPath, 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
      worker = spawn(process.execPath, [workerPath, "run", "--run-id", "completed-worker", "--session-root", join(workspace, "workspace/sessions")], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      await once(worker.stdout!, "data");
    }
    writeFileSync(join(directory, "job.json"), JSON.stringify({ jobId: "completed-worker", topic: "Finished research", status: "completed",
      runner: "local", pid: worker?.pid ?? process.pid, createdAt: 1, updatedAt: 1 }));
  }
  const settings = new SettingsStore(workspace);
  await settings.put({ runner: "local", llm: { provider: "offline" }, telemetry: { enabled: false },
    gateAutoApprove: false, creditRecovery: { ...settings.get().creditRecovery, autoResume: false }, interruptedRecovery: { autoResume: false } });
  const registry = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); });
  await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
  const address = registry.address(); assert.ok(address && typeof address !== "string");
  const token = "a".repeat(64);
  const server = await startBrainServer({ workspace, port: 0, ...(!updateOptions.unauthenticated ? { apiToken: token } : {}), selfUpdateCheck: false,
    managedRuntimeUpdates: true,
    ...(updateOptions.desktopUpdateLeaseMs !== undefined ? { desktopUpdateLeaseMs: updateOptions.desktopUpdateLeaseMs } : {}),
    ...(updateOptions.exitForUpdate ? { exitForUpdate: updateOptions.exitForUpdate } : {}),
    workerPath,
    contentRegistryUrl: `http://127.0.0.1:${address.port}`, readinessAdvisor: null,
    readinessProbes: { llm: async () => ({}), capabilities: async () => ({}), internet: async () => ({}), code: async () => ({}), slurm: async () => ({}) },
    availabilityProbes: Object.fromEntries(TOOL_IDS.map(id => [id, async () => ({ state: "available" as const })])),
  });
  // Let the empty-workspace startup recovery resolve before ordinary gate tests.
  await new Promise(resolve => setImmediate(resolve));
  return { server, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    close: async () => {
      await server.close(); registry.closeAllConnections();
      await new Promise<void>(resolve => registry.close(() => resolve()));
      if (worker && worker.exitCode === null) {
        const exited = once(worker, "exit");
        worker.kill(); await exited;
      }
      rmSync(workspace, { recursive: true, force: true });
    } };
}

test("desktop update gate rejects active jobs, holds an idle server, and cancellation restores requests", async t => {
  const f = await fixture();
  let jobs: JobSummary[] = [];
  t.mock.method(f.server.manager, "list", async () => jobs);
  try {
    for (const status of ["running", "queued", "suspended", "orphaned", "credit-blocked"] as const) {
      jobs = [{ jobId: "active", topic: "existing research", status, runner: "local", createdAt: 1, updatedAt: 1 }];
      assert.equal(await f.server.prepareForDesktopUpdate(), false, `${status} work must prevent bundle replacement`);
    }
    jobs = [];
    assert.equal(await f.server.prepareForDesktopUpdate(), true);
    const blocked = await fetch(`${f.server.url}/api/jobs`, { method: "POST", headers: f.headers, body: '{"topic":"new research"}' });
    assert.equal(blocked.status, 503);
    assert.match(await blocked.text(), /preparing to update/);
    f.server.cancelDesktopUpdate();
    const allowed = await fetch(`${f.server.url}/api/jobs`, { headers: f.headers });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), []);
  } finally { await f.close(); }
});

test("a completed checkpoint does not permit updating while its detached worker is alive", async t => {
  const f = await fixture("worker");
  // The OS liveness probe uses the real PID saved in job.json. The checkpoint
  // list is intentionally settled, as it is during final telemetry writes.
  t.mock.method(f.server.manager, "list", async (): Promise<JobSummary[]> => [{
    jobId: "completed-worker", topic: "Finished research", status: "completed", runner: "local", createdAt: 1, updatedAt: 1,
  }]);
  try {
    assert.equal(f.server.manager.hasLiveLocalWorkers(), true);
    assert.equal(await f.server.prepareForDesktopUpdate(), false);
  } finally { await f.close(); }
});

test("an unrelated process reusing a completed job's PID does not block an update", async t => {
  const f = await fixture("reused-pid");
  t.mock.method(f.server.manager, "list", async (): Promise<JobSummary[]> => [{
    jobId: "completed-worker", topic: "Finished research", status: "completed", runner: "local", createdAt: 1, updatedAt: 1,
  }]);
  try {
    assert.equal(f.server.manager.hasLiveLocalWorkers(), false);
    assert.equal(await f.server.prepareForDesktopUpdate(), true);
    f.server.cancelDesktopUpdate();
  } finally { await f.close(); }
});

test("failed local activity inspection releases the gate and cannot authorize an update", async t => {
  const f = await fixture();
  t.mock.method(f.server.manager, "list", async () => { throw new Error("workspace cannot be read"); });
  try {
    await assert.rejects(f.server.prepareForDesktopUpdate(), /workspace cannot be read/);
    const response = await fetch(`${f.server.url}/api/desktop/handshake`, { headers: f.headers });
    assert.equal(response.status, 200, "a failed probe must leave the existing app usable");
    await response.text();
  } finally { await f.close(); }
});

test("an unfinished submission body prevents readiness before a job record exists", async () => {
  const f = await fixture();
  let submission: ReturnType<typeof request> | undefined;
  try {
    const received = once(f.server.httpServer, "request");
    const response = new Promise<number | undefined>((resolve, reject) => {
      submission = request(`${f.server.url}/api/jobs`, { method: "POST", headers: f.headers }, res => {
        res.resume(); res.once("end", () => resolve(res.statusCode));
      });
      submission.once("error", reject);
    });
    submission!.write('{"topic":');
    await received;
    assert.equal(await f.server.prepareForDesktopUpdate(), false, "in-flight requests are work even before manager.submit runs");
    submission!.end('""}');
    assert.equal(await response, 400, "the fixture finishes without creating any research job");
    assert.equal(await f.server.prepareForDesktopUpdate(), true);
    f.server.cancelDesktopUpdate();
  } finally { submission?.destroy(); await f.close(); }
});

test("startup credit recovery in progress prevents an apparently idle desktop update", async t => {
  let release!: () => void;
  const recovering = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(JobManager.prototype, "resumeDueCreditBlocks", () => recovering);
  const f = await fixture();
  try {
    assert.equal(await f.server.prepareForDesktopUpdate(), false, "startup recovery may still launch a worker after the empty job scan");
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await f.server.prepareForDesktopUpdate(), true);
    f.server.cancelDesktopUpdate();
  } finally { release(); await f.close(); }
});

const updateId = "d1f8b04a-e5ac-4f89-855e-688c004520f7";
const otherUpdateId = "f8196f38-631c-4aa5-874c-2bed2c3ad243";
const maintenance = (f: Awaited<ReturnType<typeof fixture>>, action: string, requestId = updateId, authorized = true) =>
  fetch(`${f.server.url}/api/desktop/update/${action}`, { method: "POST", headers: authorized ? f.headers : { "content-type": "application/json" }, body: JSON.stringify({ requestId }) });

test("remote update needs authentication and owns an expiring reservation across requests", async () => {
  let exits = 0;
  const f = await fixture(undefined, { exitForUpdate: () => { exits++; } });
  try {
    assert.equal((await maintenance(f, "prepare", updateId, false)).status, 401);
    assert.equal((await maintenance(f, "prepare", "invalid")).status, 400);
    const prepared = await maintenance(f, "prepare");
    assert.equal(prepared.status, 200);
    assert.equal((await prepared.json() as { ready: boolean }).ready, true);
    assert.equal((await fetch(`${f.server.url}/api/desktop/handshake`, { headers: f.headers })).status, 200);
    assert.equal((await fetch(`${f.server.url}/api/jobs`, { method: "POST", headers: f.headers, body: '{"topic":"new work"}' })).status, 503);
    assert.equal((await maintenance(f, "commit", otherUpdateId)).status, 409);
    assert.equal((await maintenance(f, "cancel", otherUpdateId)).status, 409);
    f.server.cancelDesktopUpdate();
    assert.equal((await fetch(`${f.server.url}/api/jobs`, { headers: f.headers })).status, 503, "local cancellation cannot release a remote reservation");
    assert.equal((await maintenance(f, "cancel")).status, 200);
    assert.equal((await maintenance(f, "commit")).status, 409);
    assert.equal((await fetch(`${f.server.url}/api/jobs`, { headers: f.headers })).status, 200);
    assert.equal((await (await maintenance(f, "prepare")).json() as { ready: boolean }).ready, true);
    const committed = await maintenance(f, "commit");
    assert.equal(committed.status, 202);
    assert.deepEqual(await committed.json(), { accepted: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exits, 1);
    assert.equal((await maintenance(f, "commit")).status, 409, "commit cannot be repeated");
  } finally { await f.close(); }
});

test("remote update refuses active research and automatically releases an abandoned reservation", async t => {
  const f = await fixture(undefined, { desktopUpdateLeaseMs: 30 });
  let jobs: JobSummary[] = [{ jobId: "live", topic: "research", runner: "slurm", status: "running", createdAt: 1, updatedAt: 1 }];
  t.mock.method(f.server.manager, "list", async () => jobs);
  try {
    assert.equal((await (await maintenance(f, "prepare")).json() as { ready: boolean }).ready, false);
    assert.equal((await maintenance(f, "commit")).status, 409);
    jobs = [];
    assert.equal((await (await maintenance(f, "prepare")).json() as { ready: boolean }).ready, true);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal((await maintenance(f, "commit")).status, 409, "expired reservation cannot stop the backend");
    assert.equal((await fetch(`${f.server.url}/api/jobs`, { headers: f.headers })).status, 200);
  } finally { await f.close(); }
});

test("cancelling during idle inspection cannot revive a stale update reservation", async t => {
  const f = await fixture();
  let release!: () => void;
  let inspecting!: () => void;
  const started = new Promise<void>(resolve => { inspecting = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(f.server.manager, "list", async () => { inspecting(); await wait; return []; });
  try {
    const pending = maintenance(f, "prepare");
    await started;
    assert.equal((await maintenance(f, "commit")).status, 409);
    assert.equal((await maintenance(f, "cancel")).status, 200);
    release();
    assert.equal((await (await pending).json() as { ready: boolean }).ready, false);
    assert.equal((await maintenance(f, "commit")).status, 409);
  } finally { release(); await f.close(); }
});

test("ordinary unauthenticated deployments do not expose remote shutdown", async () => {
  const f = await fixture(undefined, { unauthenticated: true });
  try {
    const handshake = await (await fetch(`${f.server.url}/api/desktop/handshake`)).json() as { capabilities: string[] };
    assert.ok(!handshake.capabilities.includes("managed-runtime-update"));
    assert.equal((await maintenance(f, "prepare")).status, 404);
  } finally { await f.close(); }
});

test("a cancelled local scan cannot release a newer remote update reservation", async t => {
  const f = await fixture();
  let rejectScan!: (error: Error) => void;
  const wait = new Promise<JobSummary[]>((_, reject) => { rejectScan = reject; });
  let calls = 0;
  t.mock.method(f.server.manager, "list", () => ++calls === 1 ? wait : Promise.resolve([]));
  try {
    const local = f.server.prepareForDesktopUpdate();
    f.server.cancelDesktopUpdate();
    assert.equal((await (await maintenance(f, "prepare")).json() as { ready: boolean }).ready, true);
    const rejected = assert.rejects(local, /cancelled scan/);
    rejectScan(new Error("cancelled scan"));
    await rejected;
    assert.equal((await fetch(`${f.server.url}/api/jobs`, { headers: f.headers })).status, 503);
    assert.equal((await maintenance(f, "cancel")).status, 200);
  } finally { rejectScan(new Error("cancelled scan")); await f.close(); }
});

test("an interrupted commit releases admission instead of stranding a live backend", async () => {
  let exits = 0;
  const f = await fixture(undefined, { desktopUpdateLeaseMs: 100, exitForUpdate: () => { exits++; } });
  try {
    assert.equal((await (await maintenance(f, "prepare")).json() as { ready: boolean }).ready, true);
    f.server.httpServer.on("request", (req, res) => {
      if (req.url === "/api/desktop/update/commit") req.once("end", () => res.destroy());
    });
    await assert.rejects(maintenance(f, "commit"));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(exits, 0);
    assert.equal((await fetch(`${f.server.url}/api/jobs`, { headers: f.headers })).status, 200);
    assert.equal((await maintenance(f, "cancel")).status, 409);
    assert.equal((await (await maintenance(f, "prepare", otherUpdateId)).json() as { ready: boolean }).ready, true);
  } finally { await f.close(); }
});
