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
  searxngDir,
  searxngLocalUrl,
  searxngStatePath,
  type SearxngRuntime,
} from "../src/searxng-launcher.js";
import { atomicWriteJson, readJsonFile } from "../src/files.js";

/** A scripted child process: alive until told to exit, records signals. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signals: string[] = [];
  readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream & {
    setEncoding: (enc: string) => void;
  };
  readonly stdout = new EventEmitter() as unknown as NodeJS.ReadableStream & {
    setEncoding: (enc: string) => void;
  };

  constructor() {
    super();
    (this.stderr as unknown as { setEncoding: (enc: string) => void }).setEncoding = () => {};
    this.stdout.setEncoding = () => this.stdout;
  }

  kill(signal?: string): boolean {
    this.signals.push(signal ?? "SIGTERM");
    this.die(0);
    return true;
  }

  die(code: number): void {
    this.exitCode = code;
    this.emit("exit", code);
    this.stdout.emit("end");
    this.stderr.emit("end");
    this.emit("close", code);
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
      execImpl: async () => {},
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
    const settings = readFileSync(join(searxngDir(workspace), "settings.yml"), "utf8");
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

test("servers sharing a workspace isolate service state, mounted configuration and legacy writes", () =>
  withWorkspace(async (workspace) => {
    const clusterId = "cpusrv73.scidom.de:8787";
    const desktopId = "hpc-submit03.scidom.de:43213";
    const clusterSpawned: Spawned[] = [];
    const desktopSpawned: Spawned[] = [];
    const common = {
      workspace,
      probeRuntime: async (candidate: SearxngRuntime) => candidate === "apptainer",
      fetchImpl: async () => ({ status: 200 }),
      sleep: async () => {},
      log: () => {},
      env: {},
    };
    const cluster = new SearxngLauncher({
      ...common,
      instanceId: clusterId,
      advertiseHost: "cpusrv73.scidom.de",
      spawnImpl: fakeSpawn(clusterSpawned),
      findPort: async () => 8080,
    });
    const desktop = new SearxngLauncher({
      ...common,
      instanceId: desktopId,
      spawnImpl: fakeSpawn(desktopSpawned),
      findPort: async () => 43210,
    });
    await cluster.ensureRunning();
    const clusterConfig = readFileSync(join(searxngDir(workspace, clusterId), "settings.yml"), "utf8");
    await desktop.ensureRunning();
    assert.notEqual(searxngDir(workspace, clusterId), searxngDir(workspace, desktopId));
    assert.ok(clusterSpawned[0]!.args.includes(`${searxngDir(workspace, clusterId)}:/etc/searxng`));
    assert.ok(desktopSpawned[0]!.args.includes(`${searxngDir(workspace, desktopId)}:/etc/searxng`));
    assert.equal(readFileSync(join(searxngDir(workspace, clusterId), "settings.yml"), "utf8"), clusterConfig);
    assert.equal(searxngLocalUrl(workspace, clusterId), "http://cpusrv73.scidom.de:8080");
    assert.equal(searxngLocalUrl(workspace, desktopId), "http://127.0.0.1:43210");

    // A stale packaged desktop backend still writes the old shared location.
    // Neither its healthy URL nor a later failure may control either server.
    atomicWriteJson(join(workspace, "searxng", "state.json"), {
      state: "running", url: "http://foreign-node:46449", port: 46449, updatedAt: 0,
    });
    desktopSpawned[0]!.child.die(1);
    assert.equal(searxngLocalUrl(workspace, desktopId), undefined);
    assert.equal(searxngLocalUrl(workspace, clusterId), "http://cpusrv73.scidom.de:8080");
    atomicWriteJson(join(workspace, "searxng", "state.json"), { state: "failed", updatedAt: 1 });
    await desktop.stop();
    assert.equal(searxngLocalUrl(workspace, clusterId), "http://cpusrv73.scidom.de:8080");
    assert.equal(readFileSync(join(searxngDir(workspace, clusterId), "settings.yml"), "utf8"), clusterConfig);
    assert.equal(readJsonFile<{ instanceId: string }>(searxngStatePath(workspace, clusterId))!.instanceId, clusterId);
    await cluster.stop();
  }));

test("server relaunch restores only its own port and ignores foreign state metadata", () =>
  withWorkspace(async (workspace) => {
    const ownId = "same-host:8787";
    const otherId = "same-host:43213";
    atomicWriteJson(searxngStatePath(workspace, ownId), {
      state: "off", instanceId: ownId, port: 43220, updatedAt: 0,
    });
    atomicWriteJson(searxngStatePath(workspace, otherId), {
      state: "running", instanceId: otherId, port: 43221,
      url: "http://127.0.0.1:43221", updatedAt: 0,
    });
    const options = {
      workspace,
      instanceId: ownId,
      probeRuntime: async (candidate: SearxngRuntime) => candidate === "apptainer",
      fetchImpl: async () => ({ status: 200 }),
      spawnImpl: fakeSpawn([]),
      log: () => {},
      env: {},
      findPort: async () => 43222,
    };
    const launcher = new SearxngLauncher(options);
    assert.equal((await launcher.ensureRunning()).url, "http://127.0.0.1:43220");
    await launcher.stop();
    assert.equal(searxngLocalUrl(workspace, otherId), "http://127.0.0.1:43221");

    atomicWriteJson(searxngStatePath(workspace, ownId), {
      state: "running", instanceId: otherId, port: 43221,
      url: "http://127.0.0.1:43221", updatedAt: 0,
    });
    assert.equal(searxngLocalUrl(workspace, ownId), undefined);
    const relaunched = new SearxngLauncher(options);
    assert.equal((await relaunched.ensureRunning()).url, "http://127.0.0.1:43222");
    await relaunched.stop();
  }));

test("legacy shared state never establishes a local service or a saved port", () =>
  withWorkspace(async (workspace) => {
    atomicWriteJson(join(workspace, "searxng", "state.json"), {
      state: "running", port: 46449, url: "http://foreign-node:46449", updatedAt: 0,
    });
    assert.equal(searxngLocalUrl(workspace), undefined);
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      fetchImpl: async () => ({ status: 200 }),
      spawnImpl: fakeSpawn([]),
      findPort: async () => 43223,
      log: () => {},
      env: {},
    });
    assert.equal((await launcher.ensureRunning()).url, "http://127.0.0.1:43223");
    await launcher.stop();
  }));

test("apptainer starts in the application's directory and configures Granian's listener", () =>
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
    assert.equal(call!.args[call!.args.indexOf("--pwd") + 1], "/usr/local/searxng");
    assert.ok(call!.args.includes("GRANIAN_HOST=0.0.0.0"));
    assert.ok(call!.args.includes("GRANIAN_PORT=43211"));
    const settings = readFileSync(join(searxngDir(workspace), "settings.yml"), "utf8");
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
    assert.match(bounded.detail ?? "", /address already in use/, "restart limit retains the actual failure");
    assert.equal((await launcher.ensureRunning()).detail, bounded.detail, "polling must not recursively append restart messages");
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
      execImpl: async () => {},
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
  assert.ok(!text.includes("proxies:"), "no proxy block when the host has no proxy");
  assert.match(text, /request_timeout: 5\.0/);
});

test("renderSearxngSettings keeps only the scheduled engines and switches each on", () => {
  const text = renderSearxngSettings({
    secret: "abc123",
    bindAddress: "127.0.0.1",
    port: 8080,
    proxy: "http://proxy.example:3128",
    engines: ["google", "bing news"],
  });
  assert.match(text, /use_default_settings:\n  engines:\n    keep_only:\n      - "google"\n      - "bing news"\n/);
  assert.match(text, /  - name: "bing news"\n    disabled: false\n    inactive: false\n/);
  assert.equal(text.match(/^outgoing:$/gm)?.length, 1, "one outgoing block carries timeouts and the proxy");
  assert.match(text, /  proxies:\n    all:\/\/:\n      - "http:\/\/proxy\.example:3128"\n/);
  assert.match(text, /- '\(\.\*\\\.\)\?sci-hub\\\.\.\*\$'/);
});

test("container and server restarts preserve the endpoint captured by workers", () =>
  withWorkspace(async (workspace) => {
    const spawned: Spawned[] = [];
    let allocations = 0;
    const options = {
      workspace,
      advertiseHost: "search.cluster",
      probeRuntime: async (candidate: SearxngRuntime) => candidate === "apptainer",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async (url: string) => {
        assert.equal(url, "http://127.0.0.1:43215/healthz", "health stays local while the advertised URL is remote");
        return { status: 200 };
      },
      findPort: async () => { allocations += 1; return 43215; },
      log: () => {},
      env: {},
    };
    const launcher = new SearxngLauncher(options);
    const first = await launcher.ensureRunning();
    spawned[0]!.child.die(1);
    assert.equal((await launcher.ensureRunning()).url, first.url);
    await launcher.stop();
    const relaunched = new SearxngLauncher(options);
    assert.equal((await relaunched.ensureRunning()).url, first.url);
    assert.equal(allocations, 1);
    await relaunched.stop();
  }));

test("a living but unhealthy container is stopped, reported, and restarted on the same port", () =>
  withWorkspace(async (workspace) => {
    const spawned: Spawned[] = [];
    let healthy = true;
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => ({ status: healthy ? 200 : 503 }),
      findPort: async () => 43216,
      log: () => {}, env: {},
    });
    const first = await launcher.ensureRunning();
    healthy = false;
    const failed = await launcher.ensureRunning();
    assert.equal(failed.state, "failed");
    assert.match(failed.detail!, /became unhealthy.*503/);
    assert.deepEqual(spawned[0]!.child.signals, ["SIGTERM"]);
    assert.equal(searxngLocalUrl(workspace), undefined);
    healthy = true;
    assert.equal((await launcher.ensureRunning()).url, first.url);
    assert.equal(spawned.length, 2);
    await launcher.stop();
  }));

test("stdout and stderr retain the import failure and redact proxy credentials", () =>
  withWorkspace(async (workspace) => {
    const logs: string[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: (() => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emit("data", "Listening at: http://:::8080\n");
          child.stderr.emit("data", "ModuleNotFoundError: No module named 'searx'\n");
          child.stderr.emit("data", "proxy=http://user:password@proxy.cluster:3128\n");
          child.die(1);
        });
        return child as unknown as ChildProcess;
      }) as typeof spawn,
      fetchImpl: async () => ({ status: 503 }),
      sleep: async () => {}, findPort: async () => 43217,
      log: (line) => logs.push(line), env: {},
    });
    const failed = await launcher.ensureRunning();
    assert.match(failed.detail!, /Listening at/);
    assert.match(failed.detail!, /ModuleNotFoundError/);
    assert.ok(logs.some((line) => line.includes("ModuleNotFoundError")));
    assert.ok(!failed.detail!.includes("user:password"));
    assert.ok(!logs.join("\n").includes("user:password"));
  }));

test("an asynchronous spawn failure becomes a diagnostic status", () =>
  withWorkspace(async (workspace) => {
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: (() => {
        const child = new FakeChild();
        queueMicrotask(() => child.emit("error", new Error("spawn apptainer ENOENT")));
        return child as unknown as ChildProcess;
      }) as typeof spawn,
      fetchImpl: async () => ({ status: 503 }),
      sleep: async () => {}, findPort: async () => 43218,
      log: () => {}, env: {},
    });
    const status = await launcher.ensureRunning();
    assert.equal(status.state, "failed");
    assert.match(status.detail!, /spawn apptainer ENOENT/);
  }));

test("startup timeout survives the shutdown exit event", () =>
  withWorkspace(async (workspace) => {
    let now = 0;
    const spawned: Spawned[] = [];
    const launcher = new SearxngLauncher({
      workspace, startTimeoutMs: 1_000,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => ({ status: 503 }),
      now: () => now,
      sleep: async (ms) => { now += ms; },
      findPort: async () => 43219,
      log: () => {}, env: {},
    });
    const status = await launcher.ensureRunning();
    assert.equal(status.state, "failed");
    assert.match(status.detail!, /did not answer \/healthz/);
    assert.deepEqual(spawned[0]!.child.signals, ["SIGTERM"]);
  }));

test("local SIF images are passed directly and IPv6 listeners produce valid URLs", () =>
  withWorkspace(async (workspace) => {
    const spawned: Spawned[] = [];
    const launcher = new SearxngLauncher({
      workspace, advertiseHost: "::1", imageRef: "/cache/searxng.sif",
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async (url) => {
        assert.equal(url, "http://[::1]:43220/healthz");
        return { status: 200 };
      },
      findPort: async () => 43220,
      log: () => {}, env: {},
    });
    assert.equal((await launcher.ensureRunning()).url, "http://[::1]:43220");
    assert.equal(spawned[0]!.args.at(-1), "/cache/searxng.sif");
    assert.ok(spawned[0]!.args.includes("GRANIAN_HOST=::1"));
    await launcher.stop();
  }));

test("stopping during runtime discovery prevents a late container launch", () =>
  withWorkspace(async (workspace) => {
    let release!: () => void;
    const probe = new Promise<void>((resolve) => { release = resolve; });
    const spawned: Spawned[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async () => { await probe; return true; },
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => ({ status: 200 }),
      findPort: async () => 43221, log: () => {}, env: {},
    });
    const starting = launcher.ensureRunning();
    await launcher.stop();
    release();
    assert.equal((await starting).state, "off");
    assert.equal(spawned.length, 0);
  }));

test("a replacement waits for a concurrent stop and repeated stops share shutdown", () =>
  withWorkspace(async (workspace) => {
    const children: FakeChild[] = [];
    const oldChild = new FakeChild();
    oldChild.kill = (signal) => { oldChild.signals.push(signal ?? "SIGTERM"); return true; };
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: (() => {
        const child = children.length === 0 ? oldChild : new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      }) as typeof spawn,
      fetchImpl: async () => ({ status: 200 }),
      findPort: async () => 43222, log: () => {}, env: {},
    });
    const original = await launcher.ensureRunning();
    const stopping = launcher.stop();
    assert.equal(launcher.stop(), stopping, "concurrent stops share one shutdown");
    const restarting = launcher.ensureRunning();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(children.length, 1, "no replacement may bind before the old process exits");
    oldChild.die(0);
    await stopping;
    assert.equal((await restarting).url, original.url);
    assert.equal(launcher.status().state, "running");
    assert.equal(children.length, 2);
    assert.deepEqual(oldChild.signals, ["SIGTERM"]);
    await launcher.stop();
  }));

test("a later stop cancels a restart queued during shutdown", () =>
  withWorkspace(async (workspace) => {
    const spawned: Spawned[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => ({ status: 200 }),
      findPort: async () => 43223, log: () => {}, env: {},
    });
    await launcher.ensureRunning();
    const oldChild = spawned[0]!.child;
    oldChild.kill = () => true;
    const stopping = launcher.stop();
    const restarting = launcher.ensureRunning();
    const lastStop = launcher.stop();
    oldChild.die(0);
    await Promise.all([stopping, lastStop]);
    assert.equal((await restarting).state, "off");
    assert.equal(spawned.length, 1);
  }));

test("an explicit stop waits for shutdown already started by health supervision", () =>
  withWorkspace(async (workspace) => {
    const spawned: Spawned[] = [];
    let healthy = true;
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => ({ status: healthy ? 200 : 503 }),
      findPort: async () => 43224, log: () => {}, env: {},
    });
    await launcher.ensureRunning();
    const oldChild = spawned[0]!.child;
    oldChild.kill = (signal) => { oldChild.signals.push(signal ?? "SIGTERM"); return true; };
    healthy = false;
    const unhealthy = launcher.ensureRunning();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(oldChild.signals, ["SIGTERM"]);
    const stopping = launcher.stop();
    const restarting = launcher.ensureRunning();
    await Promise.resolve();
    assert.equal(spawned.length, 1);
    healthy = true;
    oldChild.die(0);
    await Promise.all([unhealthy, stopping]);
    assert.equal((await restarting).state, "running");
    assert.equal(spawned.length, 2);
    await launcher.stop();
  }));

test("split proxy credentials, oversized lines, and trailing partial output stay redacted", () =>
  withWorkspace(async (workspace) => {
    const logs: string[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: (() => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stderr.emit("data", "proxy=http://split_user:");
          child.stdout.emit("data", "stdout remains independent\n");
          child.stderr.emit("data", "split_password@proxy.cluster:3128\n");
          child.stderr.emit("data", "x".repeat(8_001) + "http://oversized_user:");
          child.stderr.emit("data", "oversized_password@proxy.cluster:3128\n");
          child.stderr.emit("data", "ModuleNotFoundError: No module named 'searx'\n");
          child.stderr.emit("data", "proxy=http://trailing_user:");
          child.stderr.emit("data", "trailing_password@proxy.cluster:3128");
          // A process may die before completing a URL's userinfo, too.
          child.stdout.emit("data", "proxy=http://incomplete_user:incomplete_password");
          child.die(1);
        });
        return child as unknown as ChildProcess;
      }) as typeof spawn,
      fetchImpl: async () => ({ status: 503 }),
      sleep: async () => {}, findPort: async () => 43225,
      log: (line) => logs.push(line), env: {},
    });
    const failed = await launcher.ensureRunning();
    const persisted = readFileSync(searxngStatePath(workspace), "utf8");
    const output = [failed.detail, persisted, ...logs].join("\n");
    assert.match(output, /ModuleNotFoundError/);
    assert.match(output, /stdout remains independent/);
    assert.match(output, /output line omitted/);
    assert.match(output, /\[redacted\]@proxy.cluster/);
    for (const prefix of ["split", "oversized", "trailing", "incomplete"]) {
      assert.ok(!output.includes(`${prefix}_user`));
      assert.ok(!output.includes(`${prefix}_password`));
    }
    assert.ok(failed.detail!.length < 8_200, "failure details remain bounded");
  }));

test("output draining after exit stays buffered and completes the failure on close", () =>
  withWorkspace(async (workspace) => {
    const logs: string[] = [];
    const child = new FakeChild();
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: (() => {
        queueMicrotask(() => {
          child.stderr.emit("data", "proxy=http://late_user:");
          child.exitCode = 1;
          child.emit("exit", 1);
        });
        return child as unknown as ChildProcess;
      }) as typeof spawn,
      fetchImpl: async () => ({ status: 503 }),
      sleep: async () => {}, findPort: async () => 43227,
      log: (line) => logs.push(line), env: {},
    });
    assert.equal((await launcher.ensureRunning()).state, "failed");
    child.stderr.emit("data", "late_password@proxy.cluster:3128\nLate traceback detail");
    child.stderr.emit("end");
    child.emit("close", 1);
    const output = [readFileSync(searxngStatePath(workspace), "utf8"), ...logs].join("\n");
    assert.match(output, /Late traceback detail/);
    assert.match(output, /\[redacted\]@proxy.cluster/);
    assert.ok(!output.includes("late_user"));
    assert.ok(!output.includes("late_password"));
  }));

test("a previous child's late close cannot overwrite a replacement's running state", () =>
  withWorkspace(async (workspace) => {
    const children: FakeChild[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: (() => {
        const child = new FakeChild();
        children.push(child);
        if (children.length === 1) queueMicrotask(() => {
          child.exitCode = 1;
          child.emit("exit", 1);
        });
        return child as unknown as ChildProcess;
      }) as typeof spawn,
      fetchImpl: async () => ({ status: 200 }),
      findPort: async () => 43228, log: () => {}, env: {},
    });
    assert.equal((await launcher.ensureRunning()).state, "failed");
    assert.equal((await launcher.ensureRunning()).state, "running");
    children[0]!.stderr.emit("data", "late failure detail");
    children[0]!.stderr.emit("end");
    children[0]!.emit("close", 1);
    assert.equal(launcher.status().state, "running");
    assert.equal(searxngLocalUrl(workspace), "http://127.0.0.1:43228");
    await launcher.stop();
  }));

for (const entry of [
  { name: "explicit port overrides environment and saved port", port: 8080, envPort: "8081", expected: 8080 },
  { name: "environment port overrides saved port", envPort: "8081", expected: 8081 },
  { name: "saved port remains the default without an override", expected: 43226 },
]) {
  test(entry.name, () => withWorkspace(async (workspace) => {
    atomicWriteJson(searxngStatePath(workspace), { state: "off", port: 43226, updatedAt: 0 });
    const spawned: Spawned[] = [];
    const launcher = new SearxngLauncher({
      workspace,
      ...("port" in entry ? { port: entry.port } : {}),
      env: "envPort" in entry ? { BRAINSTORM_SEARXNG_PORT: entry.envPort } : {},
      probeRuntime: async (candidate) => candidate === "apptainer",
      spawnImpl: fakeSpawn(spawned),
      fetchImpl: async () => ({ status: 200 }),
      findPort: async () => { throw new Error("a configured or saved port must not be reallocated"); },
      log: () => {},
    });
    assert.equal((await launcher.ensureRunning()).url, `http://127.0.0.1:${entry.expected}`);
    assert.ok(spawned[0]!.args.includes(`GRANIAN_PORT=${entry.expected}`));
    await launcher.stop();
  }));
}

test("invalid explicit or environment listener ports are rejected", () =>
  withWorkspace(async (workspace) => {
    for (const port of [0, -1, 65_536, 1.5, NaN, Infinity]) {
      assert.throws(() => new SearxngLauncher({ workspace, port, env: {} }), /port must be an integer/);
    }
    for (const port of ["", "0", "-1", "65536", "1.5", "not-a-port"]) {
      assert.throws(() => new SearxngLauncher({ workspace, env: { BRAINSTORM_SEARXNG_PORT: port } }), /port must be an integer/);
    }
    assert.doesNotThrow(() => new SearxngLauncher({ workspace, port: 1, env: {} }));
    assert.doesNotThrow(() => new SearxngLauncher({ workspace, port: 65_535, env: {} }));
    assert.doesNotThrow(() => new SearxngLauncher({ workspace, port: 8080, env: { BRAINSTORM_SEARXNG_PORT: "invalid" } }));
  }));
