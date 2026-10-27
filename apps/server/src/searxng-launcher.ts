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
 * fetch, clock, sleep, and port finder. Unit tests inject these seams; an
 * opt-in integration test verifies the real image and live search API.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";

import { localSearxngEngineNames } from "@brainstorm-agentic/host-tools";

import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./files.js";

export type SearxngRuntime = "docker" | "podman" | "apptainer" | "singularity";

const RUNTIME_CANDIDATES: readonly SearxngRuntime[] = [
  "docker",
  "podman",
  "apptainer",
  "singularity",
];

/**
 * The SearXNG build the engine list and settings were evaluated against
 * (2026.9.30-a9d990033), pinned by digest so an upstream release cannot
 * change engine behaviour under a running deployment. To move to a newer
 * build, re-run the engine evaluation, then update this digest (or set
 * BRAINSTORM_SEARXNG_IMAGE).
 */
const DEFAULT_IMAGE =
  "docker.io/searxng/searxng@sha256:a07a5cd2da2c63d66e559f9e4d3a3db106cfc6c32fb0ac70abe91cc28bcd7350";
/** First start may pull and (on HPC) convert the image; be generous. */
const DEFAULT_START_TIMEOUT_MS = 5 * 60_000;
const HEALTH_POLL_MS = 2_000;
/** Restarts allowed inside the window before the launcher declares failure. */
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 60 * 60_000;

/** The on-disk record every other part of the app reads. */
export interface SearxngStateFile {
  /** Stable owning Brain server identity; distinct servers never share state. */
  readonly instanceId?: string;
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

export function searxngDir(workspace: string, instanceId = hostname()): string {
  // Home/workspace directories are commonly shared across HPC nodes. A flat
  // state/settings directory lets a desktop backend on a login node overwrite
  // a healthy server's endpoint (and its mounted settings/cache) on another node.
  // Never migrate/fall back to that legacy directory: its owner is unknowable.
  const scope = createHash("sha256").update(instanceId).digest("hex").slice(0, 24);
  return join(workspace, "searxng", "instances", scope);
}

export function searxngStatePath(workspace: string, instanceId = hostname()): string {
  return join(searxngDir(workspace, instanceId), SEARXNG_STATE_FILE);
}

/** Reads only this server's state; a mismatched owner cannot supply an endpoint. */
export function readSearxngState(workspace: string, instanceId = hostname()): SearxngStateFile | undefined {
  const state = readJsonFile<SearxngStateFile>(searxngStatePath(workspace, instanceId));
  return state?.instanceId !== undefined && state.instanceId !== instanceId ? undefined : state;
}

/** The healthy local instance's URL, or undefined. Reads the state file. */
export function searxngLocalUrl(workspace: string, instanceId = hostname()): string | undefined {
  try {
    const state = readSearxngState(workspace, instanceId);
    return state?.state === "running" && typeof state.url === "string" && state.url !== ""
      ? state.url
      : undefined;
  } catch {
    // A missing/unreadable record cannot establish availability. Admission
    // reports the specific state-file error when a run requires this service.
    return undefined;
  }
}

export interface SearxngLauncherOptions {
  readonly workspace: string;
  /** Stable server identity, normally its advertised host and Brain listener port. */
  readonly instanceId?: string;
  /**
   * The host workers reach the instance at. Loopback (the default) keeps it
   * strictly on this machine; a cluster server passes its own address so
   * compute-node workers can reach it over the internal network.
   */
  readonly advertiseHost?: string;
  /** Fixed listener port, overriding the environment and a previously saved port. */
  readonly port?: number;
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

function httpUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Health checks are local service traffic, never outbound proxy traffic. */
function localHealthFetch(url: string, init: { signal?: AbortSignal }): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { signal: init.signal }, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    req.once("error", reject);
    req.end();
  });
}

/**
 * The SearXNG configuration this deployment needs, hand-rendered (the
 * values are all app-controlled, so no YAML library is warranted):
 * - `formats: [html, json]` — WITHOUT json every API query answers 403;
 * - `limiter: false` — the bot rate-limiter needs a Redis sidecar and
 *   protects PUBLIC instances; this one serves only this deployment;
 * - the engines the coordinator schedules, and ONLY those: `keep_only`
 *   drops every other default engine, and each kept one is switched on by
 *   name — the stock settings ship some disabled or inactive, and SearXNG
 *   never runs an inactive engine even when a request names it;
 * - the settings evaluated against recorded Brainstorm queries: no safe
 *   search, no autocomplete, every language, 5 s engine timeouts (12 s at
 *   most), a larger connection pool, and host priorities that raise
 *   scholarly and code hosts, lower content farms, and drop shadow
 *   libraries;
 * - the outgoing proxy, when the host itself reaches the web through one
 *   (HPC compute and login nodes usually do).
 */
export function renderSearxngSettings(options: {
  readonly secret: string;
  readonly bindAddress: string;
  readonly port: number;
  readonly proxy?: string;
  /** The engines to keep and switch on; absent = the stock engine set. */
  readonly engines?: readonly string[];
}): string {
  const quote = (value: string): string => JSON.stringify(value);
  const engines = options.engines ?? [];
  const lines = ["# Written by brainstorm-agentic (searxng-local); edits are overwritten on launch."];
  if (engines.length > 0) {
    lines.push(
      "use_default_settings:",
      "  engines:",
      "    keep_only:",
      ...engines.map((name) => `      - ${quote(name)}`),
    );
  } else {
    lines.push("use_default_settings: true");
  }
  lines.push(
    "server:",
    `  secret_key: "${options.secret}"`,
    "  limiter: false",
    "  public_instance: false",
    `  bind_address: "${options.bindAddress}"`,
    `  port: ${options.port}`,
    "search:",
    "  safe_search: 0",
    '  autocomplete: ""',
    '  default_lang: "all"',
    "  formats:",
    "    - html",
    "    - json",
    "outgoing:",
    "  request_timeout: 5.0",
    "  max_request_timeout: 12.0",
    "  pool_connections: 100",
    "  pool_maxsize: 20",
  );
  if (options.proxy !== undefined) {
    lines.push("  proxies:", "    all://:", `      - "${options.proxy}"`);
  }
  if (engines.length > 0) {
    lines.push("engines:");
    for (const name of engines) {
      lines.push(`  - name: ${quote(name)}`, "    disabled: false", "    inactive: false");
    }
  }
  lines.push(
    "hostnames:",
    "  high_priority:",
    ...[
      "arxiv\\.org", "doi\\.org", "aclanthology\\.org", "openreview\\.net", "semanticscholar\\.org",
      "ncbi\\.nlm\\.nih\\.gov", "europepmc\\.org", "biorxiv\\.org", "medrxiv\\.org", "neurips\\.cc",
      "mlr\\.press", "jmlr\\.org", "acm\\.org", "ieee\\.org", "springer\\.com", "nature\\.com",
      "sciencedirect\\.com", "github\\.com",
    ].map((host) => `    - '(.*\\.)?${host}$'`),
    "  low_priority:",
    ...["medium\\.com$", "quora\\.com$", "pinterest\\..*$"].map((host) => `    - '(.*\\.)?${host}'`),
    "  remove:",
    ...["sci-hub\\..*$", "libgen\\..*$"].map((host) => `    - '(.*\\.)?${host}'`),
  );
  return lines.join("\n") + "\n";
}

export class SearxngLauncher {
  readonly instanceId: string;
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
  private stopping: Promise<void> | undefined;
  private stoppingChild: Promise<void> | undefined;
  private stopVersion = 0;
  private stopped = false;
  private containerName: string | undefined;
  private restarts: number[] = [];
  private port: number | undefined;
  private healthUrl: string | undefined;
  private lastFailure: string | undefined;

  constructor(options: SearxngLauncherOptions) {
    this.workspace = options.workspace;
    this.instanceId = options.instanceId ?? hostname();
    this.advertiseHost = options.advertiseHost ?? "127.0.0.1";
    this.env = options.env ?? process.env;
    this.imageRef = options.imageRef ?? this.env.BRAINSTORM_SEARXNG_IMAGE ?? DEFAULT_IMAGE;
    const configuredPort = options.port ?? (this.env.BRAINSTORM_SEARXNG_PORT !== undefined
      ? Number(this.env.BRAINSTORM_SEARXNG_PORT) : undefined);
    if (configuredPort !== undefined) {
      if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
        throw new Error("SearXNG port must be an integer between 1 and 65535 (BRAINSTORM_SEARXNG_PORT).");
      }
      this.port = configuredPort;
    }
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.log = options.log ?? ((line) => console.log(line));
    this.probeRuntime = options.probeRuntime ?? defaultProbe;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.execImpl = options.execImpl ?? defaultExec;
    this.fetchImpl = options.fetchImpl ?? localHealthFetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.findPort = options.findPort ?? defaultFindPort;
    // Workers snapshot this endpoint. Preserve the port through both container
    // restarts and server relaunches instead of silently stranding those workers.
    try {
      const previous = readSearxngState(this.workspace, this.instanceId);
      const previousPort = previous?.port;
      if (this.port === undefined && previousPort !== undefined && Number.isInteger(previousPort) && previousPort > 0 && previousPort <= 65535) {
        this.port = previousPort;
      }
      if (previous?.state === "running") {
        this.setStatus({ state: "off", detail: "server restarted; waiting for search service startup" });
      }
    } catch {
      // Preserve an invalid record for readiness to explain until startup
      // replaces it; a damaged state file must not prevent the server booting.
    }
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
    if (this.stopping !== undefined || (this.stopped && this.starting !== undefined)) {
      // A replacement cannot bind the old child's port until shutdown finishes.
      // Drain a cancelled startup too, so its late completion cannot overwrite
      // the replacement. A subsequent stop cancels this queued restart.
      const version = this.stopVersion;
      const pendingStart = this.starting;
      return (this.stopping ?? Promise.resolve())
        .then(() => pendingStart)
        .then(() => version === this.stopVersion ? this.ensureRunning() : this.current);
    }
    this.starting ??= this.checkOrStart()
      .catch((error: unknown) => {
        if (this.stopped) return this.current;
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

  private async checkOrStart(): Promise<SearxngStatus> {
    if (this.current.state === "running" && this.child && this.child.exitCode === null) {
      const child = this.child;
      try {
        const health = await this.fetchImpl(this.healthUrl!, { signal: AbortSignal.timeout(HEALTH_POLL_MS) });
        if (this.stopped || this.child !== child) return this.current;
        if (health.status === 200) return this.current;
        throw new Error(`/healthz returned HTTP ${health.status}`);
      } catch (error) {
        if (this.stopped || this.child !== child) return this.current;
        const detail = `search container became unhealthy: ${error instanceof Error ? error.message : String(error)}`;
        await this.stopChild();
        if (this.stopped) return this.current;
        this.setStatus({ state: "failed", detail });
        this.log(`[searxng] ${detail}`);
        return this.current;
      }
    }
    return this.startOnce();
  }

  /** Stops the instance and records "off". Safe to call repeatedly. */
  stop(): Promise<void> {
    this.stopped = true;
    this.stopVersion += 1;
    this.stopping ??= this.stopChild()
      .then(() => {
        this.restarts = [];
        this.setStatus({ state: "off" });
      })
      .finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private stopChild(): Promise<void> {
    // Health supervision and an explicit stop can reach this simultaneously.
    this.stoppingChild ??= this.terminateChild()
      .finally(() => { this.stoppingChild = undefined; });
    return this.stoppingChild;
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        timer.unref();
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      child.kill("SIGTERM");
      await exited;
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
  }

  private setStatus(next: SearxngStatus): void {
    this.current = next;
    if (next.state === "failed" && next.detail !== undefined && !next.detail.startsWith("restarted ")) {
      this.lastFailure = next.detail;
    }
    try {
      mkdirSync(searxngDir(this.workspace, this.instanceId), { recursive: true });
      atomicWriteJson(searxngStatePath(this.workspace, this.instanceId), {
        instanceId: this.instanceId,
        state: next.state,
        ...(this.port !== undefined ? { port: this.port } : {}),
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
          "check the container runtime and the server log; retry after the restart window or toggle local search off and on" +
          (this.lastFailure !== undefined ? `; last failure: ${this.lastFailure}` : ""),
      });
      return this.current;
    }
    this.restarts.push(this.now());

    const runtime = await this.detectRuntime();
    if (this.stopped) return this.current;
    if (runtime === undefined) {
      this.setStatus({
        state: "failed",
        detail:
          "no container runtime found — install Docker or Podman (workstation) or load the " +
          "Apptainer/Singularity module (cluster), then save the setting again",
      });
      return this.current;
    }

    const port = this.port ??= await this.findPort();
    if (this.stopped) return this.current;
    const engineLike = runtime === "docker" || runtime === "podman";
    // Container engines map a host port onto the image's fixed 8080; the
    // rootless HPC runtimes run in the host network, so the instance itself
    // must listen on the chosen port.
    const internalPort = engineLike ? 8080 : port;
    const exposeBeyondLoopback = !isLoopback(this.advertiseHost);
    const bindAddress = engineLike ? "0.0.0.0"
      : exposeBeyondLoopback ? (this.advertiseHost.includes(":") ? "::" : "0.0.0.0")
      : this.advertiseHost === "::1" ? "::1" : "127.0.0.1";
    const url = httpUrl(this.advertiseHost, port);
    this.healthUrl = `${httpUrl(bindAddress === "::" || this.advertiseHost === "::1" ? "::1" : "127.0.0.1", port)}/healthz`;

    const directory = searxngDir(this.workspace, this.instanceId);
    mkdirSync(directory, { recursive: true });
    const proxy = this.proxyFromEnv();
    atomicWriteFile(
      join(directory, "settings.yml"),
      renderSearxngSettings({
        secret: randomBytes(32).toString("hex"),
        bindAddress,
        port: internalPort,
        ...(proxy !== undefined ? { proxy } : {}),
        engines: localSearxngEngineNames(),
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
          exposeBeyondLoopback ? `${port}:8080` : `${this.advertiseHost === "::1" ? "[::1]" : "127.0.0.1"}:${port}:8080`,
          "-v",
          `${directory}:/etc/searxng:rw`,
          this.imageRef,
        ]
      : [
          "run",
          "--writable-tmpfs",
          "--pwd",
          "/usr/local/searxng",
          "--env",
          `GRANIAN_HOST=${bindAddress}`,
          "--env",
          `GRANIAN_PORT=${port}`,
          "--bind",
          `${directory}:/etc/searxng`,
          isAbsolute(this.imageRef) || this.imageRef.startsWith(".") || this.imageRef.includes("://")
            ? this.imageRef : `docker://${this.imageRef}`,
        ];

    this.setStatus({ state: "starting", url, runtime });
    this.log(
      `[searxng] starting via ${runtime} on ${url} ` +
        `(first start may download the search image — a few minutes)`,
    );
    const child = this.spawnImpl(runtime, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: this.env,
    });
    this.child = child;
    let outputTail = "";
    let failureAtExit: SearxngStatus | undefined;
    let exitDescription = "";
    const captureLine = (line: string, partial = false): void => {
      // Keep enough context for Python tracebacks, without unbounded state files.
      // A configured proxy may carry credentials; never persist those in logs.
      let safe = line.replace(/(https?:\/\/)[^\s/]*@/gi, "$1[redacted]@");
      if (partial) {
        // The process can die before writing the @ that identifies userinfo.
        // An unterminated authority is ambiguous, so omit it on final flush.
        safe = safe.replace(/(https?:\/\/)(?!\[redacted\]@)[^\s/]*$/gi, "$1[redacted incomplete address]");
      }
      outputTail = (outputTail + safe + "\n").slice(-8_000);
      if (safe.trim() !== "") this.log(`[searxng] ${safe.trim()}`);
    };
    const flushOutput: (() => void)[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      let oversized = false;
      let closed = false;
      const flush = (partial = true): void => {
        if (oversized) captureLine("[container output line omitted: exceeded 8000 characters]");
        else if (pending !== "") captureLine(pending, partial);
        pending = "";
        oversized = false;
      };
      const finish = (): void => {
        if (closed) return;
        flush();
        closed = true;
      };
      flushOutput.push(finish);
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        if (closed) return;
        // Pipe chunks have arbitrary boundaries. Buffer complete lines before
        // redacting; if one is oversized, discard it rather than leak a suffix
        // whose credential prefix has been truncated.
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf("\n", offset);
          const end = newline < 0 ? chunk.length : newline;
          if (!oversized) {
            if (pending.length + end - offset > 8_000) {
              pending = "";
              oversized = true;
            } else pending += chunk.slice(offset, end);
          }
          if (newline < 0) break;
          flush(false);
          offset = newline + 1;
        }
      });
      stream?.once("end", finish);
      stream?.once("close", finish);
    }
    child.once("error", (error) => {
      if (this.child !== child || this.stopped) return;
      this.child = undefined;
      const detail = `could not start search container: ${error.message}`;
      this.setStatus({ state: "failed", detail });
      this.log(`[searxng] ${detail}`);
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopped) return;
      // Died on its own: report it; the supervision poller retries through
      // ensureRunning, and the bounded-restart rule above stops a flap.
      exitDescription = `the search container exited (code ${String(code)})`;
      failureAtExit = {
        state: "failed",
        detail: exitDescription + (outputTail !== "" ? ` — ${outputTail.trim()}` : ""),
      };
      this.setStatus(failureAtExit);
      this.log(`[searxng] exited (code ${String(code)})`);
    });
    child.once("close", () => {
      // exit can arrive before stdio finishes. Keep partial lines buffered until
      // close, then enrich only this child's still-current failure record.
      for (const flush of flushOutput) flush();
      if (!this.stopped && failureAtExit !== undefined && this.current === failureAtExit) {
        this.setStatus({
          ...failureAtExit,
          detail: exitDescription + (outputTail !== "" ? ` — ${outputTail.trim()}` : ""),
        });
      }
    });

    const deadline = this.now() + this.startTimeoutMs;
    for (;;) {
      if (this.stopped) return this.current;
      if (this.child !== child || child.exitCode !== null) {
        // The exit handler has already recorded the cause.
        return this.current;
      }
      try {
        const health = await this.fetchImpl(this.healthUrl, {
          signal: AbortSignal.timeout(HEALTH_POLL_MS),
        });
        if (this.stopped || this.child !== child) return this.current;
        if (health.status === 200) break;
      } catch {
        // Not up yet; keep waiting until the deadline.
      }
      if (this.stopped || this.child !== child) return this.current;
      if (this.now() >= deadline) {
        await this.stopChild();
        if (this.stopped) return this.current;
        this.setStatus({
          state: "failed",
          detail:
            `did not answer /healthz within ${Math.round(this.startTimeoutMs / 60_000)} minutes` +
            (outputTail !== "" ? ` — ${outputTail.trim()}` : ""),
        });
        return this.current;
      }
      await this.sleep(HEALTH_POLL_MS);
    }

    if (this.stopped || this.child !== child) return this.current;
    this.setStatus({ state: "running", url, runtime });
    this.log(`[searxng] running on ${url} (${runtime})`);
    return this.current;
  }
}
