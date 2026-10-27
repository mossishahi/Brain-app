import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TOOL_IDS } from "../src/availability.js";
import { atomicWriteJson } from "../src/files.js";
import { searxngStatePath } from "../src/searxng-launcher.js";
import { startBrainServer, type RunningBrainServer } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";

test("servers sharing a workspace read only their own local search state", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-search-servers-"));
  const registry = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
  const address = registry.address();
  assert.ok(address && typeof address !== "string");
  const servers: RunningBrainServer[] = [];
  try {
    const initial = new SettingsStore(workspace);
    await initial.put({ llm: { provider: "offline" }, telemetry: { enabled: false } });
    for (let i = 0; i < 2; i++) {
      servers.push(await startBrainServer({
        workspace,
        port: 0,
        contentRegistryUrl: `http://127.0.0.1:${address.port}`,
        readinessAdvisor: null,
        readinessProbes: {
          llm: async () => ({}), capabilities: async () => ({}),
          internet: async () => ({}), code: async () => ({}), slurm: async () => ({}),
        },
        availabilityProbes: Object.fromEntries(TOOL_IDS.map(id => [
          id, async () => ({ state: "available" as const }),
        ])),
      }));
    }
    const [cluster, desktop] = servers.map(server => server.manager.settings);
    assert.ok(cluster?.searxngInstanceId);
    assert.ok(desktop?.searxngInstanceId);
    assert.notEqual(cluster.searxngInstanceId, desktop.searxngInstanceId);

    atomicWriteJson(searxngStatePath(workspace, cluster.searxngInstanceId), {
      instanceId: cluster.searxngInstanceId,
      state: "running", url: "http://cluster.test:8080", updatedAt: Date.now(),
    });
    atomicWriteJson(searxngStatePath(workspace, desktop.searxngInstanceId), {
      instanceId: desktop.searxngInstanceId,
      state: "failed", detail: "desktop runtime unavailable", updatedAt: Date.now(),
    });
    atomicWriteJson(join(workspace, "searxng", "state.json"), {
      state: "failed", detail: "legacy desktop overwrote shared state", updatedAt: Date.now(),
    });
    const settings = {
      ...cluster.get(),
      llm: { provider: "claude-agent" as const },
      webSearch: { provider: "searxng-local" as const, scholarly: false, cacheEnabled: false },
    };
    assert.equal(cluster.webSearchRuntimeConfig(settings).searxngBaseUrl, "http://cluster.test:8080");
    assert.throws(() => desktop.webSearchRuntimeConfig(settings), /Local SearXNG/);
    await servers[1]!.close();
    servers.pop();
    assert.equal(cluster.webSearchRuntimeConfig(settings).searxngBaseUrl, "http://cluster.test:8080",
      "closing one server must not clear the other server's search endpoint");
  } finally {
    await Promise.all(servers.map(server => server.close()));
    await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve()));
    rmSync(workspace, { recursive: true, force: true });
  }
});
