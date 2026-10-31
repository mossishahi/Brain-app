import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReadinessReport } from "@brainstorm-agentic/protocol";
import { TOOL_IDS } from "../src/availability.js";
import { startBrainServer, type RunningBrainServer } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";

test("saving host tools refreshes Gemini capabilities without another model request", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-host-tool-readiness-"));
  const settings = new SettingsStore(workspace, { validateGemini: async () => undefined });
  await settings.put({
    runner: "local", llm: { provider: "gemini", model: "test-model", geminiApiKey: "test-key" },
    telemetry: { enabled: false }, interruptedRecovery: { autoResume: false },
    creditRecovery: { ...settings.get().creditRecovery, autoResume: false },
  });
  const defaultTools = settings.get().hostTools!.enabledToolIds;
  const registry = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  let server: RunningBrainServer | undefined;
  let llmProbes = 0;
  const headers = { authorization: `Bearer ${"a".repeat(64)}`, "content-type": "application/json" };
  try {
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
    const address = registry.address();
    assert.ok(address && typeof address !== "string");
    server = await startBrainServer({
      workspace, port: 0, apiToken: "a".repeat(64), selfUpdateCheck: false,
      contentRegistryUrl: `http://127.0.0.1:${address.port}`, readinessAdvisor: null,
      validateGemini: async () => undefined,
      discoverModels: async () => ({ models: [] }),
      readinessProbes: {
        llm: async () => { llmProbes += 1; return {}; },
        internet: async () => ({}), code: async () => ({}), slurm: async () => ({}),
      },
      availabilityProbes: Object.fromEntries(TOOL_IDS.map((id) => [
        id, async () => ({ state: "available" as const }),
      ])),
    });
    const waitForCapabilities = async (state: "ok" | "failed") => {
      const deadline = Date.now() + 3_000;
      let report: ReadinessReport;
      do {
        const response = await fetch(`${server!.url}/api/readiness`, { headers });
        assert.equal(response.status, 200);
        report = await response.json() as ReadinessReport;
        const capability = report.checks.find((check) => check.id === "capabilities");
        if (capability?.state === state) return capability;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assert.fail(`capabilities did not become ${state}: ${JSON.stringify(report.checks)}`);
    };
    assert.match((await waitForCapabilities("failed")).detail ?? "", /code.execute -> unavailable/);
    assert.equal(llmProbes, 1);
    for (const enabled of [true, false]) {
      const response = await fetch(`${server.url}/api/settings`, {
        method: "PUT", headers,
        body: JSON.stringify({ hostTools: { enabledToolIds: [...defaultTools, ...(enabled ? ["code_execute"] : [])] } }),
      });
      assert.equal(response.status, 200, await response.text());
      const result = await waitForCapabilities(enabled ? "ok" : "failed");
      assert.match(result.detail ?? "", enabled ? /code.execute -> host/ : /code.execute -> unavailable/);
      assert.equal(llmProbes, 1, "a tool preference must not issue another model readiness request");
    }
  } finally {
    await server?.close();
    registry.closeAllConnections();
    await new Promise<void>((resolve) => registry.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  }
});
