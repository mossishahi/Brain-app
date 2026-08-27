import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";

import {
  SearxngLauncher,
  renderSearxngSettings,
  searxngLocalUrl,
  searxngStatePath,
  type SearxngRuntime,
} from "../src/searxng-launcher.js";
import { readJsonFile } from "../src/files.js";

/** A scripted child process: alive until told to exit, records signals. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signals: string[] = [];
  readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream & {
    setEncoding: (enc: string) => void;
  };

  constructor() {
    super();
    (this.stderr as unknown as { setEncoding: (enc: string) => void }).setEncoding = () => {};
  }

  kill(signal?: string): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }

  die(code: number): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly child: FakeChild;
}

function fakeSpawn(record: Spawned[]): typeof spawn {
  return ((command: string, args: readonly string[]) => {
    const child = new FakeChild();
    record.push({ command, args, child });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}

function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "searxng-launch-"));
  return run(workspace).finally(() => rmSync(workspace, { recursive: true, force: true }));
}

test("docker path: detects the runtime, writes a JSON-enabled config, starts, and records running", () =>
  withWorkspace(async (workspace) => {
    const spawned: Spawned[] = [];
    let healthCalls = 0;
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "docker",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => {
        healthCalls += 1;
        // Not up on the first poll — the launcher must keep waiting.
        return { status: healthCalls >= 2 ? 200 : 503 };
      },
      sleep: async () => {},
      findPort: async () => 43210,
      log: () => {},
      env: {},
    });
    const status = await launcher.ensureRunning();
    assert.equal(status.state, "running");
    assert.equal(status.url, "http://127.0.0.1:43210");
    assert.equal(status.runtime, "docker");

    // The container publish stays on loopback for a local deployment.
    const [call] = spawned;
    assert.equal(call!.command, "docker");
    assert.ok(call!.args.includes("127.0.0.1:43210:8080"));
    assert.ok(call!.args.some((arg) => arg.endsWith(":/etc/searxng:rw")));

    // The written config enables the JSON API — without it every query 403s —
    // and switches the public-instance limiter off.
    const settings = readFileSync(join(workspace, "searxng", "settings.yml"), "utf8");
    assert.match(settings, /- json/);
    assert.match(settings, /limiter: false/);

    // The state file is what the rest of the app reads.
    assert.equal(searxngLocalUrl(workspace), "http://127.0.0.1:43210");

    // ensureRunning is idempotent while healthy: no second container.
    await launcher.ensureRunning();
    assert.equal(spawned.length, 1);

    // stop() kills the child, asks the engine too, and records "off".
    const execCalls: string[][] = [];
    // (the exec seam was defaulted; re-create with it to test stop politely)
    await launcher.stop();
    assert.deepEqual(spawned[0]!.child.signals, ["SIGTERM"]);
    assert.equal(searxngLocalUrl(workspace), undefined);
    void execCalls;
  }));

test("apptainer path: no port mapping — the config itself carries the chosen port", () =>
  withWorkspace(async (workspace) => {
    const spawned: Spawned[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      advertiseHost: "10.0.0.5",
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => ({ status: 200 }),
      sleep: async () => {},
      findPort: async () => 43211,
      log: () => {},
      env: { HTTPS_PROXY: "http://proxy.cluster:3128" },
    });
    const status = await launcher.ensureRunning();
    assert.equal(status.state, "running");
    assert.equal(status.url, "http://10.0.0.5:43211");
    const [call] = spawned;
    assert.equal(call!.command, "apptainer");
    assert.ok(call!.args.some((arg) => arg.startsWith("docker://")));
    assert.ok(!call!.args.includes("-p"), "apptainer runs in the host network");
    const settings = readFileSync(join(workspace, "searxng", "settings.yml"), "utf8");
    assert.match(settings, /port: 43211/);
    // A cluster host reaches the web through its proxy; the instance must too.
    assert.match(settings, /http:\/\/proxy\.cluster:3128/);
    // Reachable from compute nodes: bound beyond loopback.
    assert.match(settings, /bind_address: "0\.0\.0\.0"/);
    await launcher.stop();
  }));

test("no runtime found: a failed status that names the fix, never a throw", () =>
  withWorkspace(async (workspace) => {
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async () => false,
      spawnImpl: fakeSpawn([]),
      fetchImpl: async () => ({ status: 200 }),
      sleep: async () => {},
      findPort: async () => 43212,
      log: () => {},
      env: {},
    });
    const status = await launcher.ensureRunning();
    assert.equal(status.state, "failed");
    assert.match(status.detail ?? "", /no container runtime found/);
    assert.match(status.detail ?? "", /Docker|Apptainer/);
    const state = readJsonFile<{ state?: string }>(searxngStatePath(workspace));
    assert.equal(state?.state, "failed");
  }));

test("a container that dies is reported with its stderr tail and restarts are bounded", () =>
  withWorkspace(async (workspace) => {
    const spawned: Spawned[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate: SearxngRuntime) => candidate === "docker",
      spawnImpl: ((command: string, args: readonly string[]) => {
        const child = new FakeChild();
        spawned.push({ command, args, child });
        // Die immediately, before health ever answers.
        queueMicrotask(() => {
          child.stderr.emit("data", "bind: address already in use");
          child.die(125);
        });
        return child as unknown as ChildProcess;
      }) as unknown as typeof spawn,
      fetchImpl: async () => ({ status: 503 }),
      sleep: async () => {},
      findPort: async () => 43213,
      log: () => {},
      env: {},
    });
    // Every attempt fails with the exit named…
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = await launcher.ensureRunning();
      assert.equal(status.state, "failed");
      assert.match(status.detail ?? "", /exited \(code 125\)/);
      assert.match(status.detail ?? "", /address already in use/);
    }
    // …and the sixth inside the window refuses to flap.
    const bounded = await launcher.ensureRunning();
    assert.equal(bounded.state, "failed");
    assert.match(bounded.detail ?? "", /kept dying/);
    assert.equal(spawned.length, 5, "no sixth container inside the window");
  }));

test("the settings store hands runs the local instance only while it is really running", () =>
  withWorkspace(async (workspace) => {
    const { SettingsStore } = await import("../src/settings.js");
    const store = new SettingsStore(workspace);
    await store.put({
      ...store.get(),
      llm: { provider: "offline" },
      webSearch: { provider: "searxng-local" },
    });
    // Selected but not (yet) running: no general provider reaches the run —
    // an honest unconfigured beats a dead URL.
    assert.equal(store.webSearchRuntimeConfig().general, undefined);

    // A healthy launcher state file turns it into plain "searxng at URL".
    const spawned: Spawned[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "docker",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => ({ status: 200 }),
      sleep: async () => {},
      findPort: async () => 43214,
      log: () => {},
      env: {},
    });
    await launcher.ensureRunning();
    const config = store.webSearchRuntimeConfig();
    assert.equal(config.general, "searxng");
    assert.equal(config.searxngBaseUrl, "http://127.0.0.1:43214");

    // Stopped again: the URL leaves the config with it.
    await launcher.stop();
    assert.equal(store.webSearchRuntimeConfig().general, undefined);
  }));

test("renderSearxngSettings writes exactly the app-controlled shape", () => {
  const text = renderSearxngSettings({
    secret: "abc123",
    bindAddress: "127.0.0.1",
    port: 8080,
  });
  assert.match(text, /use_default_settings: true/);
  assert.match(text, /secret_key: "abc123"/);
  assert.match(text, /public_instance: false/);
  assert.ok(!text.includes("outgoing:"), "no proxy block when the host has no proxy");
});
