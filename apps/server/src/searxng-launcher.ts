/**
 * Launches and supervises a LOCAL SearXNG instance — the keyless,
 * runs-on-your-own-machine general web search behind the
 * `webSearch.provider = "searxng-local"` setting.
 *
 * Why the app launches it rather than asking the user to: the whole point of
 * the setting is that no third-party search API ever sees the pipeline's
 * queries, and "install a service first" is exactly the kind of setup step
 * that quietly never happens. So the server does what a careful operator
 * would: find a container runtime (Docker or Podman on workstations,
 * Apptainer/Singularity on HPC clusters where nobody has root), write a
 * minimal SearXNG configuration WITH THE JSON API ENABLED (the stock image
 * ships with it off, and without it every query answers 403), start the
 * container, wait for /healthz, and leave a STATE FILE in the workspace that
 * the settings store reads when it builds a run's environment.
 *
 * Supervision follows the house rules:
 * - the state on disk is the record (a relaunched server reads it, and the
 *   settings store never talks to this object directly);
 * - a dead instance is restarted, boundedly — repeated deaths within the
 *   window mark the launcher "failed" with the cause instead of flapping;
 * - stop() is polite (SIGTERM, plus `docker stop` where the client process
 *   is not the container) and always leaves the state file saying "off";
 * - the first start may genuinely take minutes (Apptainer converts the OCI
 *   image on first pull), so the health wait is generous and the status says
 *   "starting" rather than pretending failure.
 *
 * Everything the tests need is injectable: runtime probe, spawn, exec,
 * fetch, clock, sleep, and port finder. No test touches a real container.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./files.js";

export type SearxngRuntime = "docker" | "podman" | "apptainer" | "singularity";

const RUNTIME_CANDIDATES: readonly SearxngRuntime[] = [
  "docker",
  "podman",
  "apptainer",
  "singularity",
];

const DEFAULT_IMAGE = "docker.io/searxng/searxng:latest";
/** First start may pull and (on HPC) convert the image; be generous. */
const DEFAULT_START_TIMEOUT_MS = 5 * 60_000;
const HEALTH_POLL_MS = 2_000;
/** Restarts allowed inside the window before the launcher declares failure. */
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 60 * 60_000;

/** The on-disk record every other part of the app reads. */
export interface SearxngStateFile {
  /** "starting" | "running" | "off" | "failed". */
  readonly state: string;
  readonly url?: string;
  readonly port?: number;
  readonly runtime?: SearxngRuntime;
  readonly containerName?: string;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly detail?: string;
}

export const SEARXNG_STATE_FILE = "state.json";

export function searxngDir(workspace: string): string {
  return join(workspace, "searxng");
}

export function searxngStatePath(workspace: string): string {
  return join(searxngDir(workspace), SEARXNG_STATE_FILE);
}

/** The healthy local instance's URL, or undefined. Reads the state file. */
export function searxngLocalUrl(workspace: string): string | undefined {
  const state = readJsonFile<SearxngStateFile>(searxngStatePath(workspace));
  return state?.state === "running" && typeof state.url === "string"
    ? state.url
    : undefined;
}

export interface SearxngLauncherOptions {
  readonly workspace: string;
  /**
   * The host workers reach the instance at. Loopback (the default) keeps it
   * strictly on this machine; a cluster server passes its own address so
   * compute-node workers can reach it over the internal network.
   */
  readonly advertiseHost?: string;
  readonly imageRef?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly startTimeoutMs?: number;
  readonly log?: (line: string) => void;
  /** Test seams. */
  readonly probeRuntime?: (candidate: SearxngRuntime) => Promise<boolean>;
  readonly spawnImpl?: typeof spawn;
  readonly execImpl?: (
    command: string,
    args: readonly string[],
  ) => Promise<void>;
  readonly fetchImpl?: (url: string, init: { signal?: AbortSignal }) => Promise<{ status: number }>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly findPort?: () => Promise<number>;
}

export interface SearxngStatus {
  readonly state: "off" | "starting" | "running" | "failed";
  readonly url?: string;
  readonly runtime?: SearxngRuntime;
  readonly detail?: string;
}

function defaultProbe(candidate: SearxngRuntime): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(candidate, ["version"], { timeout: 10_000 }, (error) => {
      resolve(error === null);
    });
  });
}

function defaultExec(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 30_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function defaultFindPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * The minimal SearXNG configuration this deployment needs, hand-rendered
 * (the values are all app-controlled, so no YAML library is warranted):
 * - `formats: [html, json]` — WITHOUT json every API query answers 403;
 * - `limiter: false` — the bot rate-limiter needs a Redis sidecar and
 *   protects PUBLIC instances; this one serves only this deployment;
 * - the outgoing proxy, when the host itself reaches the web through one
 *   (HPC compute and login nodes usually do).
 */
export function renderSearxngSettings(options: {
  readonly secret: string;
  readonly bindAddress: string;
  readonly port: number;
  readonly proxy?: string;
}): string {
  const lines = [
    "# Written by brainstorm-agentic (searxng-local); edits are overwritten on launch.",
    "use_default_settings: true",
    "server:",
    `  secret_key: "${options.secret}"`,
    "  limiter: false",
    "  public_instance: false",
    `  bind_address: "${options.bindAddress}"`,
    `  port: ${options.port}`,
    "search:",
    "  formats:",
    "    - html",
    "    - json",
  ];
  if (options.proxy !== undefined) {
    lines.push("outgoing:", "  proxies:", "    all://:", `      - "${options.proxy}"`);
  }
  return lines.join("\n") + "\n";
}

export class SearxngLauncher {
  private readonly workspace: string;
  private readonly advertiseHost: string;
  private readonly imageRef: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startTimeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly probeRuntime: (candidate: SearxngRuntime) => Promise<boolean>;
  private readonly spawnImpl: typeof spawn;
  private readonly execImpl: (command: string, args: readonly string[]) => Promise<void>;
  private readonly fetchImpl: (
    url: string,
    init: { signal?: AbortSignal },
  ) => Promise<{ status: number }>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly findPort: () => Promise<number>;

  private child: ChildProcess | undefined;
  private current: SearxngStatus = { state: "off" };
  private starting: Promise<SearxngStatus> | undefined;
  private stopped = false;
  private containerName: string | undefined;
  private restarts: number[] = [];

  constructor(options: SearxngLauncherOptions) {
    this.workspace = options.workspace;
    this.advertiseHost = options.advertiseHost ?? "127.0.0.1";
    this.imageRef = options.imageRef ?? DEFAULT_IMAGE;
    this.env = options.env ?? process.env;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.log = options.log ?? ((line) => console.log(line));
    this.probeRuntime = options.probeRuntime ?? defaultProbe;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.execImpl = options.execImpl ?? defaultExec;
    this.fetchImpl =
      options.fetchImpl ??
      (async (url, init) => {
        const response = await fetch(url, { signal: init.signal });
        return { status: response.status };
      });
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.findPort = options.findPort ?? defaultFindPort;
  }

  status(): SearxngStatus {
    return this.current;
  }

  /**
   * Starts the instance when it is not already running (or being started);
   * concurrent callers share one attempt. Never throws — a failure is a
   * STATUS with its cause, because the callers are pollers and settings
   * saves, and neither may die for a container that would not start.
   */
  ensureRunning(): Promise<SearxngStatus> {
    if (this.current.state === "running" && this.child && this.child.exitCode === null) {
      return Promise.resolve(this.current);
    }
    this.starting ??= this.startOnce()
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.setStatus({ state: "failed", detail });
        this.log(`[searxng] failed to start: ${detail}`);
        return this.current;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  /** Stops the instance and records "off". Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    // Docker/Podman: the spawned process is the CLIENT, and although an
    // attached run forwards SIGTERM, a wedged client can strand the
    // container — so the engine is also asked directly, best effort.
    if (
      this.containerName !== undefined &&
      (this.current.runtime === "docker" || this.current.runtime === "podman")
    ) {
      await this.execImpl(this.current.runtime, ["stop", "--time", "5", this.containerName]).catch(
        () => undefined,
      );
    }
    this.setStatus({ state: "off" });
  }

  private setStatus(next: SearxngStatus): void {
    this.current = next;
    try {
      mkdirSync(searxngDir(this.workspace), { recursive: true });
      atomicWriteJson(searxngStatePath(this.workspace), {
        state: next.state,
        ...(next.url !== undefined ? { url: next.url } : {}),
        ...(next.runtime !== undefined ? { runtime: next.runtime } : {}),
        ...(this.containerName !== undefined ? { containerName: this.containerName } : {}),
        ...(next.detail !== undefined ? { detail: next.detail } : {}),
        updatedAt: this.now(),
      } satisfies Omit<SearxngStateFile, "port" | "startedAt">);
    } catch {
      // The state file is how OTHERS read us; failing to write it must not
      // take the instance down. The in-memory status stays authoritative
      // for this process.
    }
  }

  private async detectRuntime(): Promise<SearxngRuntime | undefined> {
    for (const candidate of RUNTIME_CANDIDATES) {
      if (await this.probeRuntime(candidate)) return candidate;
    }
    return undefined;
  }

  private proxyFromEnv(): string | undefined {
    const proxy =
      this.env.HTTPS_PROXY ?? this.env.https_proxy ?? this.env.HTTP_PROXY ?? this.env.http_proxy;
    return proxy !== undefined && proxy.trim() !== "" ? proxy.trim() : undefined;
  }

  private async startOnce(): Promise<SearxngStatus> {
    this.stopped = false;
    // Bounded restarts: a container that keeps dying inside the window is a
    // real problem to report, not a thing to relaunch forever.
    const cutoff = this.now() - RESTART_WINDOW_MS;
    this.restarts = this.restarts.filter((at) => at > cutoff);
    if (this.restarts.length >= MAX_RESTARTS_PER_WINDOW) {
      this.setStatus({
        state: "failed",
        detail:
          `restarted ${MAX_RESTARTS_PER_WINDOW} times within an hour and kept dying — ` +
          "check the container runtime and the server log, then save the setting again to retry",
      });
      return this.current;
    }
    this.restarts.push(this.now());

    const runtime = await this.detectRuntime();
    if (runtime === undefined) {
      this.setStatus({
        state: "failed",
        detail:
          "no container runtime found — install Docker or Podman (workstation) or load the " +
          "Apptainer/Singularity module (cluster), then save the setting again",
      });
      return this.current;
    }

    const port = await this.findPort();
    const engineLike = runtime === "docker" || runtime === "podman";
    // Container engines map a host port onto the image's fixed 8080; the
    // rootless HPC runtimes run in the host network, so the instance itself
    // must listen on the chosen port.
    const internalPort = engineLike ? 8080 : port;
    const exposeBeyondLoopback = !isLoopback(this.advertiseHost);
    const bindAddress = engineLike || exposeBeyondLoopback ? "0.0.0.0" : "127.0.0.1";
    const url = `http://${this.advertiseHost}:${port}`;

    const directory = searxngDir(this.workspace);
    mkdirSync(directory, { recursive: true });
    const proxy = this.proxyFromEnv();
    atomicWriteFile(
      join(directory, "settings.yml"),
      renderSearxngSettings({
        secret: randomBytes(32).toString("hex"),
        bindAddress,
        port: internalPort,
        ...(proxy !== undefined ? { proxy } : {}),
      }),
    );

    this.containerName = `brainstorm-searxng-${port}`;
    const args = engineLike
      ? [
          "run",
          "--rm",
          "--name",
          this.containerName,
          "-p",
          exposeBeyondLoopback ? `${port}:8080` : `127.0.0.1:${port}:8080`,
          "-v",
          `${directory}:/etc/searxng:rw`,
          this.imageRef,
        ]
      : [
          "run",
          "--writable-tmpfs",
          "--bind",
          `${directory}:/etc/searxng`,
          this.imageRef.startsWith("docker://") ? this.imageRef : `docker://${this.imageRef}`,
        ];

    this.setStatus({ state: "starting", url, runtime });
    this.log(
      `[searxng] starting via ${runtime} on ${url} ` +
        `(first start may download the search image — a few minutes)`,
    );
    const child = this.spawnImpl(runtime, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    let lastStderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line !== "") lastStderr = line.slice(-500);
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopped) return;
      // Died on its own: report it; the supervision poller retries through
      // ensureRunning, and the bounded-restart rule above stops a flap.
      this.setStatus({
        state: "failed",
        detail:
          `the search container exited (code ${String(code)})` +
          (lastStderr !== "" ? ` — ${lastStderr}` : ""),
      });
      this.log(`[searxng] exited (code ${String(code)})`);
    });

    const deadline = this.now() + this.startTimeoutMs;
    for (;;) {
      if (this.stopped) return this.current;
      if (this.child !== child || child.exitCode !== null) {
        // The exit handler has already recorded the cause.
        return this.current;
      }
      try {
        const health = await this.fetchImpl(`${url}/healthz`, {
          signal: AbortSignal.timeout(HEALTH_POLL_MS),
        });
        if (health.status === 200) break;
      } catch {
        // Not up yet; keep waiting until the deadline.
      }
      if (this.now() >= deadline) {
        child.kill("SIGTERM");
        this.setStatus({
          state: "failed",
          detail:
            `did not answer /healthz within ${Math.round(this.startTimeoutMs / 60_000)} minutes` +
            (lastStderr !== "" ? ` — ${lastStderr}` : ""),
        });
        return this.current;
      }
      await this.sleep(HEALTH_POLL_MS);
    }

    this.setStatus({ state: "running", url, runtime });
    this.log(`[searxng] running on ${url} (${runtime})`);
    return this.current;
  }
}
