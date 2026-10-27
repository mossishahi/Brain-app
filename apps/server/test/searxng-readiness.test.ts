import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ServerSettings } from "@brainstorm-agentic/protocol";
import { buildWebAccessManager, notePaidRequest, webToolSpecs } from "@brainstorm-agentic/host-tools";

import { atomicWriteJson } from "../src/files.js";
import { JobManager } from "../src/job-manager.js";
import { defaultReadinessProbes, ReadinessProbeError, ReadinessService } from "../src/readiness.js";
import { searxngDir, searxngStatePath } from "../src/searxng-launcher.js";
import { defaultServerSettings, SettingsStore } from "../src/settings.js";

const probes = () => defaultReadinessProbes({
  validateAnthropic: async () => undefined,
  validateClaudeAgent: async () => undefined,
  validateCursorAgent: async () => undefined,
});

function localSearchSettings(scholarly = true): ServerSettings {
  return {
    ...defaultServerSettings(),
    webSearch: { provider: "searxng-local", scholarly, cacheEnabled: false },
  };
}

test("local search blocks when no search alternative is enabled", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-readiness-"));
  try {
    const settings = localSearchSettings(false);
    const store = new SettingsStore(workspace);
    const capabilities = probes().capabilities;
    const context = {
      settings,
      workspace,
      env: {},
      signal: new AbortController().signal,
      credentials: {},
      onProgress: () => undefined,
    };
    for (const state of [undefined, "starting", "failed", "off"]) {
      if (state) {
        atomicWriteJson(searxngStatePath(workspace), {
          state,
          detail: "container exited (code 1): Could not import searx.webapp",
          updatedAt: 1,
        });
      }
      await assert.rejects(capabilities(context), (error: unknown) => {
        assert.ok(error instanceof ReadinessProbeError);
        assert.match(error.message, new RegExp(`Local SearXNG is ${state ?? "not started"}`));
        assert.match(error.detail ?? "", /^web-search \/ web.search -> unavailable$/m);
        if (state) assert.match(error.detail ?? "", /Could not import searx.webapp/);
        return true;
      });
      assert.throws(() => store.webSearchRuntimeConfig(settings), /Local SearXNG/);
    }

    atomicWriteJson(searxngStatePath(workspace), {
      state: "running", url: "http://worker-reachable.test:43214", updatedAt: 2,
    });
    assert.match((await capabilities(context)).message ?? "", /web-search: host tools/);
    assert.equal(store.webSearchRuntimeConfig(settings).general, "searxng");
    assert.equal(store.webSearchRuntimeConfig(settings).searxngBaseUrl, "http://worker-reachable.test:43214");

    writeFileSync(searxngStatePath(workspace), "{not valid JSON");
    await assert.rejects(capabilities(context), /Local SearXNG state cannot be read/);
    assert.equal(store.webSearchRuntimeConfig({
      ...settings, llm: { provider: "offline" },
    }).general, undefined);
    assert.equal(store.webSearchRuntimeConfig({
      ...settings, capabilityOverrides: { "web-search": false },
    }).general, undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("missing or failed local search preserves the worker's configured scholarly tools", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-scholarly-fallback-"));
  try {
    const store = new SettingsStore(workspace, { validateAnthropic: async () => undefined });
    await store.put({
      ...localSearchSettings(),
      llm: { provider: "anthropic", model: "test-model", apiKey: "test-api-key" },
    });
    const settings = store.get();
    const context = {
      settings, workspace, env: {}, signal: new AbortController().signal,
      credentials: {}, onProgress: () => undefined,
    };
    for (const state of [undefined, "starting", "failed", "off", "malformed"]) {
      if (state === "malformed") writeFileSync(searxngStatePath(workspace), "{broken JSON");
      else if (state) atomicWriteJson(searxngStatePath(workspace), { state, updatedAt: 1 });
      assert.match((await probes().capabilities(context)).message ?? "", /web-search: host tools/);
      const config = store.webSearchRuntimeConfig(settings);
      assert.equal(config.general, undefined);
      assert.equal(config.scholarly, true);
      assert.equal(config.mode, undefined, "must not enable provider-native internet access");
      const web = buildWebAccessManager({ config });
      assert.ok(web, "the worker must still construct its host search manager");
      assert.deepEqual(webToolSpecs(web).map((spec) => spec.name), [
        "web_fetch", "paper_search", "paper_details",
      ]);
      const env = store.executionEnvironment({}, settings);
      assert.equal(JSON.parse(env.BRAINSTORM_AGENTIC_WEB_SEARCH!).scholarly, true);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a configured paid fallback works without local search, but an unconfigured key does not", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-paid-fallback-"));
  try {
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => undefined, validateWebSearch: async () => undefined,
    });
    await store.put({
      ...localSearchSettings(false),
      llm: { provider: "anthropic", model: "test-model", apiKey: "test-api-key" },
      webSearch: {
        ...localSearchSettings(false).webSearch!,
        braveApiKey: "test-brave-key",
        braveFallback: { enabled: true },
      },
    });
    atomicWriteJson(searxngStatePath(workspace), { state: "failed", updatedAt: 1 });
    const settings = store.get();
    const context = {
      settings, workspace, env: {}, signal: new AbortController().signal,
      credentials: {}, onProgress: () => undefined,
    };
    assert.match((await probes().capabilities(context)).message ?? "", /web-search: host tools/);
    const config = store.webSearchRuntimeConfig(settings);
    assert.equal(config.general, undefined);
    assert.equal(config.braveFallback?.enabled, true);
    const web = buildWebAccessManager({ config, secrets: store.webSearchSecrets() });
    assert.ok(web);
    assert.ok(webToolSpecs(web).some((spec) => spec.name === "web_search"));
    await assert.rejects(probes().capabilities({
      ...context,
      settings: { ...settings, webSearch: { ...settings.webSearch!, braveKeyConfigured: false } },
    }), /no search alternative is enabled/);
    for (const cap of [{ maxRequestsPerRun: 0 }, { maxRequestsPerMonth: 0 }]) {
      const capped = {
        ...settings,
        webSearch: { ...settings.webSearch!, braveFallback: { enabled: true, ...cap } },
      };
      await assert.rejects(probes().capabilities({ ...context, settings: capped }), /no search alternative is enabled/);
      assert.throws(() => store.webSearchRuntimeConfig(capped), /no search alternative is enabled/);
    }
    notePaidRequest(workspace, "brave", "older-run");
    const exhausted = {
      ...settings,
      webSearch: { ...settings.webSearch!, braveFallback: { enabled: true, maxRequestsPerMonth: 1 } },
    };
    await assert.rejects(probes().capabilities({ ...context, settings: exhausted }), /no search alternative is enabled/);
    assert.throws(() => store.webSearchRuntimeConfig(exhausted), /no search alternative is enabled/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("readiness reports local search degradation without blocking available scholarly tools", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-readiness-live-"));
  const store = new SettingsStore(workspace, { validateAnthropic: async () => undefined });
  await store.put({
    ...localSearchSettings(),
    llm: { provider: "anthropic", model: "test-model", apiKey: "test-api-key" },
  });
  atomicWriteJson(searxngStatePath(workspace), {
    state: "running", url: "http://server.test:43214", updatedAt: 1,
  });
  const readiness = new ReadinessService({
    workspace,
    settings: store,
    contentRegistry: { running: true },
    probes: probes(),
    probeOverrides: {
      llm: async () => ({}), internet: async () => ({}),
      code: async () => ({}), slurm: async () => ({}),
    },
  });
  try {
    readiness.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readiness.report().ready, true);

    atomicWriteJson(searxngStatePath(workspace), {
      state: "failed", detail: "container exited (code 1): import failed", updatedAt: 2,
    });
    const degraded = readiness.report();
    assert.equal(degraded.ready, true);
    const capability = degraded.checks.find((check) => check.id === "capabilities")!;
    assert.equal(capability.state, "ok");
    assert.match(capability.message ?? "", /Local SearXNG is failed/);
    assert.match(capability.message ?? "", /scholarly search remains available; general web search is unavailable/);
    assert.match(capability.detail ?? "", /import failed/);
    assert.deepEqual(readiness.report().checks, degraded.checks, "reports must not accumulate warnings");
    readiness.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readiness.report().ready, true);
    assert.equal(
      (readiness.report().checks.find((check) => check.id === "capabilities")!.detail!.match(/import failed/g) ?? []).length,
      1,
    );

    writeFileSync(searxngStatePath(workspace), "{not valid JSON");
    assert.match(
      readiness.report().checks.find((check) => check.id === "capabilities")?.message ?? "",
      /Local SearXNG state cannot be read/,
    );
    assert.equal(readiness.report().ready, true);

    // Service recovery removes the scope warning immediately, even before
    // the next deployment probe refreshes its cached capability summary.
    atomicWriteJson(searxngStatePath(workspace), {
      state: "running", url: "http://server.test:43214", updatedAt: 3,
    });
    assert.doesNotMatch(
      readiness.report().checks.find((check) => check.id === "capabilities")?.message ?? "",
      /Local SearXNG|scholarly search remains/,
    );

    await store.put({ ...store.get(), webSearch: localSearchSettings(false).webSearch! });
    atomicWriteJson(searxngStatePath(workspace), { state: "failed", detail: "container exited", updatedAt: 4 });
    assert.equal(readiness.report().ready, false, "no search alternative must still block admission");

    await store.put({ ...store.get(), llm: { provider: "offline" } });
    assert.equal(readiness.report().ready, true);
    assert.equal(readiness.report().checks.find((check) => check.id === "capabilities")?.state, "skipped");
    assert.doesNotThrow(() => store.executionEnvironment({}, store.get()));
  } finally {
    readiness.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("direct submission refuses unavailable local search before writing jobs, but honors explicit web opt-out", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-admission-"));
  const bin = join(workspace, "bin");
  mkdirSync(bin);
  const sbatch = join(bin, "sbatch");
  writeFileSync(sbatch, "#!/bin/sh\necho 'Submitted batch job 123'\n");
  chmodSync(sbatch, 0o755);
  const manager = new JobManager({
    workspace,
    validateAnthropic: async () => undefined,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  try {
    await manager.settings.put({
      ...localSearchSettings(false),
      llm: { provider: "anthropic", model: "test-model", apiKey: "test-api-key" },
    });
    atomicWriteJson(searxngStatePath(workspace), {
      state: "starting", detail: "Waiting for the local search service", updatedAt: 1,
    });
    await assert.rejects(manager.submit("needs general search"), /Local SearXNG is starting/);
    assert.deepEqual(readdirSync(manager.jobsDir), []);

    const jobId = await manager.submit("deliberately no web search", [], { "web-search": false });
    assert.deepEqual(readdirSync(manager.jobsDir), [jobId]);
    const optedOut = {
      ...manager.settings.get(), capabilityOverrides: { "web-search": false },
    };
    const env = manager.settings.executionEnvironment({}, optedOut);
    assert.equal(env.BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES, "web-search");
    assert.equal(JSON.parse(env.BRAINSTORM_AGENTIC_WEB_SEARCH!).general, undefined);

    atomicWriteJson(searxngStatePath(workspace), {
      state: "running", url: "http://internal.test:43214", updatedAt: 2,
    });
    const baseEnv = { NO_PROXY: "localhost", no_proxy: "registry.test" };
    const localEnv = manager.settings.executionEnvironment(baseEnv);
    assert.equal(localEnv.NO_PROXY, "localhost,registry.test,internal.test:43214");
    assert.equal(localEnv.no_proxy, localEnv.NO_PROXY);
    assert.deepEqual(baseEnv, { NO_PROXY: "localhost", no_proxy: "registry.test" });
    const remoteEnv = manager.settings.executionEnvironment(baseEnv, {
      ...manager.settings.get(),
      webSearch: { provider: "searxng", searxngBaseUrl: "https://remote.test", scholarly: true, cacheEnabled: false },
    });
    assert.equal(remoteEnv.NO_PROXY, baseEnv.NO_PROXY);
    assert.equal(remoteEnv.no_proxy, baseEnv.no_proxy);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("managed local search failures use built-in advice unless diagnosis is explicitly requested", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-advice-"));
  const store = new SettingsStore(workspace, { validateAnthropic: async () => undefined });
  await store.put({
    ...localSearchSettings(false),
    llm: { provider: "anthropic", model: "test-model", apiKey: "test-api-key" },
  });
  let advisorCalls = 0;
  const readiness = new ReadinessService({
    workspace,
    settings: store,
    contentRegistry: { running: true },
    probes: probes(),
    probeOverrides: {
      llm: async () => ({}), internet: async () => ({}),
      code: async () => ({}), slurm: async () => ({}),
    },
    advisor: async () => {
      advisorCalls += 1;
      return "Explicit diagnostic advice";
    },
  });
  try {
    for (const state of ["starting", "failed"]) {
      atomicWriteJson(searxngStatePath(workspace), {
        state: "running", url: "http://internal.test:43214", updatedAt: 1,
      });
      readiness.refresh();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readiness.report().ready, true);
      atomicWriteJson(searxngStatePath(workspace), {
        state, detail: `Local search is ${state}`, updatedAt: 2,
      });
      readiness.refresh();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const capability = readiness.report().checks.find((check) => check.id === "capabilities")!;
      assert.equal(capability.state, "failed");
      assert.match(capability.advice ?? "", /Wait for local SearXNG/);
      assert.equal(advisorCalls, 0, `${state} must not invoke the LLM advisor automatically`);
    }
    await readiness.advise("capabilities", { force: true });
    assert.equal(advisorCalls, 1);
    assert.equal(
      readiness.report().checks.find((check) => check.id === "capabilities")?.advice,
      "Explicit diagnostic advice",
    );
  } finally {
    readiness.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("direct submission starts with scholarly tools when local general search failed", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-fallback-admission-"));
  const bin = join(workspace, "bin");
  mkdirSync(bin);
  const sbatch = join(bin, "sbatch");
  writeFileSync(sbatch, "#!/bin/sh\necho 'Submitted batch job 123'\n");
  chmodSync(sbatch, 0o755);
  const manager = new JobManager({
    workspace,
    validateAnthropic: async () => undefined,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  try {
    await manager.settings.put({
      ...localSearchSettings(),
      llm: { provider: "anthropic", model: "test-model", apiKey: "test-api-key" },
    });
    atomicWriteJson(searxngStatePath(workspace), { state: "failed", updatedAt: 1 });
    const jobId = await manager.submit("Research with the configured scholarly indexes");
    assert.deepEqual(readdirSync(manager.jobsDir), [jobId]);
    const env = manager.settings.executionEnvironment({});
    const config = JSON.parse(env.BRAINSTORM_AGENTIC_WEB_SEARCH!);
    assert.equal(config.scholarly, true);
    assert.equal(config.general, undefined);
    assert.equal(config.mode, undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("settings and readiness use only their app instance's local search state and cached checks", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-instance-readiness-"));
  const instanceId = "server-a:8787";
  const store = new SettingsStore(workspace, {
    searxngInstanceId: instanceId, validateAnthropic: async () => undefined,
  });
  await store.put({
    ...localSearchSettings(false),
    llm: { provider: "anthropic", model: "test-model", apiKey: "test-api-key" },
  });
  atomicWriteJson(searxngStatePath(workspace, instanceId), {
    instanceId, state: "running", url: "http://server-a.test:43214", updatedAt: 1,
  });
  atomicWriteJson(searxngStatePath(workspace, "server-b:8787"), {
    instanceId: "server-b:8787", state: "failed", detail: "another server's container failed", updatedAt: 2,
  });
  const options = {
    workspace, settings: store, contentRegistry: { running: true }, probes: probes(),
    probeOverrides: {
      llm: async () => ({}), internet: async () => ({}), code: async () => ({}), slurm: async () => ({}),
    },
  };
  const readiness = new ReadinessService(options);
  try {
    assert.equal(store.webSearchRuntimeConfig().searxngBaseUrl, "http://server-a.test:43214");
    const inherited = { BRAINSTORM_AGENTIC_AVAILABILITY_PATH: "/another/app/availability.json" };
    assert.equal(
      store.executionEnvironment(inherited).BRAINSTORM_AGENTIC_AVAILABILITY_PATH,
      join(searxngDir(workspace, instanceId), "availability.json"),
    );
    assert.deepEqual(inherited, { BRAINSTORM_AGENTIC_AVAILABILITY_PATH: "/another/app/availability.json" });
    assert.equal(
      new SettingsStore(workspace).executionEnvironment(inherited, {
        ...store.get(), llm: { provider: "offline" },
      }).BRAINSTORM_AGENTIC_AVAILABILITY_PATH,
      undefined,
      "legacy stores use their default path without inheriting a different app's scoped path",
    );
    readiness.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readiness.report().ready, true);
    const otherStore = new SettingsStore(workspace, { searxngInstanceId: "server-b:8787" });
    const otherReadiness = new ReadinessService({ ...options, settings: otherStore });
    try {
      assert.equal(otherReadiness.report().checks.find((check) => check.id === "llm")?.state, "unknown");
      assert.equal(otherReadiness.report().ready, false);
      assert.throws(() => otherStore.webSearchRuntimeConfig(), /another server's container failed/);
    } finally {
      otherReadiness.close();
    }
    atomicWriteJson(searxngStatePath(workspace, instanceId), {
      instanceId: "server-b:8787", state: "running", url: "http://server-b.test:43214", updatedAt: 3,
    });
    assert.throws(() => store.webSearchRuntimeConfig(), /no search alternative is enabled/);
    assert.equal(readiness.report().ready, false);
  } finally {
    readiness.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
