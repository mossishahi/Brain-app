import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ServerEvent } from "@brainstorm-agentic/protocol";
import { TOOL_IDS } from "../src/availability.js";
import { JobManager } from "../src/job-manager.js";
import { SearxngLauncher } from "../src/searxng-launcher.js";
import { startBrainServer, type RunningBrainServer } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";

test("desktop startup avoids recursive workspace scans and polling delivers nested updates", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-shallow-watch-"));
  const jobsDir = join(workspace, "workspace", "jobs");
  const sessionsDir = join(workspace, "workspace", "sessions");
  const jobId = "existing-run";
  mkdirSync(join(jobsDir, jobId), { recursive: true });
  mkdirSync(join(sessionsDir, jobId, "artifacts", "project", "node_modules", "dependency"), { recursive: true });
  writeFileSync(join(jobsDir, jobId, "job.json"), JSON.stringify({
    jobId, topic: "An existing run", status: "running", runner: "local",
    pid: process.pid, createdAt: 1, updatedAt: 1,
  }));
  const checkpointPath = join(sessionsDir, jobId, "checkpoint.json");
  const checkpoint = {
    runId: jobId, workflowId: "brainstorm", workflowVersion: "0.1.0",
    status: "running", input: {}, journal: [], pendingGates: [], seq: 1, updatedAt: 1,
  };
  writeFileSync(checkpointPath, JSON.stringify(checkpoint));
  const settings = new SettingsStore(workspace);
  await settings.put({
    runner: "local", llm: { provider: "offline" }, telemetry: { enabled: false },
    gateAutoApprove: false,
    creditRecovery: { ...settings.get().creditRecovery, autoResume: false },
    interruptedRecovery: { autoResume: false },
  });

  // Make every watcher silent, like an NFS mount without remote notifications.
  // Also record recursion requests: attempting one already incurs the blocking
  // tree walk, even if the OS ultimately rejects it and the caller falls back.
  const watched: Array<{ path: string; recursive: boolean }> = [];
  const originalWatch = fs.watch;
  t.mock.method(fs, "watch", ((path: string, options: fs.WatchOptions | (() => void)) => {
    watched.push({ path, recursive: typeof options === "object" && options.recursive === true });
    return originalWatch(path, () => {});
  }) as typeof fs.watch);
  syncBuiltinESMExports();

  const registry = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  let server: RunningBrainServer | undefined;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
  try {
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
    const address = registry.address();
    assert.ok(address && typeof address !== "string");
    const token = "a".repeat(64);
    server = await startBrainServer({
      workspace, port: 0, apiToken: token,
      contentRegistryUrl: `http://127.0.0.1:${address.port}`,
      readinessAdvisor: null,
      readinessProbes: {
        llm: async () => ({}), capabilities: async () => ({}),
        internet: async () => ({}), code: async () => ({}), slurm: async () => ({}),
      },
      availabilityProbes: Object.fromEntries(TOOL_IDS.map((id) => [
        id, async () => ({ state: "available" as const }),
      ])),
    });
    assert.deepEqual(watched, [
      { path: jobsDir, recursive: false }, { path: sessionsDir, recursive: false },
    ], "startup must never ask the filesystem to traverse saved run trees");
    const headers = { Authorization: `Bearer ${token}` };
    const handshake = await fetch(`${server.url}/api/desktop/handshake`, { headers, signal });
    assert.equal(handshake.status, 200);
    await handshake.json();

    const response = await fetch(`${server.url}/api/stream`, { headers, signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let updated = false;
    for (;;) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "the live stream must remain open");
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = block.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as ServerEvent;
        if (event.type !== "jobs") continue;
        const job = event.jobs.find((entry) => entry.jobId === jobId);
        if (!updated) {
          assert.equal(job?.status, "running");
          // A worker writes inside an existing session. No API call or watcher
          // callback notifies the server: its regular poll must discover this.
          writeFileSync(checkpointPath, JSON.stringify({ ...checkpoint, status: "completed", seq: 2, updatedAt: 2 }));
          updated = true;
        } else if (job?.status === "completed") {
          return;
        }
      }
    }
  } finally {
    controller.abort();
    await server?.close();
    await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("desktop handshake is available while recovery and optional services are still starting", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-background-start-"));
  const settings = new SettingsStore(workspace);
  await settings.put({
    runner: "local", llm: { provider: "offline" }, telemetry: { enabled: false },
    webSearch: { provider: "searxng-local", scholarly: true, cacheEnabled: false },
  });
  let releaseRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  t.mock.method(JobManager.prototype, "resumeDueCreditBlocks", () => recovery);
  const pending = async (): Promise<never> => new Promise(() => {});
  const search = new SearxngLauncher({ workspace, probeRuntime: pending, log: () => {} });
  const registry = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const address = registry.address();
  assert.ok(address && typeof address !== "string");
  const phases: string[] = [];
  const token = "a".repeat(64);
  const starting = startBrainServer({
    workspace, port: 0, apiToken: token,
    onStartupPhase: (phase) => phases.push(phase),
    contentRegistryUrl: `http://127.0.0.1:${address.port}`,
    searxngLauncher: search,
    readinessAdvisor: null,
    readinessProbes: { llm: pending, capabilities: pending, internet: pending, code: pending, slurm: pending },
    availabilityProbes: Object.fromEntries(TOOL_IDS.map((id) => [id, pending])),
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const server = await Promise.race([
      starting,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("optional startup work blocked desktop availability")), 2_000);
      }),
    ]);
    assert.deepEqual(phases, ["initializing", "listening"]);
    const signal = AbortSignal.timeout(2_000);
    const denied = await fetch(`${server.url}/api/desktop/handshake`, { signal });
    assert.equal(denied.status, 401);
    await denied.json();
    const authenticated = await fetch(`${server.url}/api/desktop/handshake`, {
      signal, headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json() as { protocolVersion: number }).protocolVersion, 1);
  } finally {
    if (timer) clearTimeout(timer);
    releaseRecovery();
    await (await starting).close();
    await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
    rmSync(workspace, { recursive: true, force: true });
  }
});
