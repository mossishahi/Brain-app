import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { delimiter, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  READINESS_CHECK_IDS,
  type AttachmentSelectionKind,
  type GateAnswerRequest,
  type HealthResponse,
  type ModelOption,
  type ModelOptionsResponse,
  type ReadinessCheckId,
  type ServerEvent,
  type SubmitJobRequest,
} from "@brainstorm-agentic/protocol";

import { createReadinessAdvisor } from "./advisor.js";
import { JobConflictError, JobManager } from "./job-manager.js";
import { installId, TelemetrySpool } from "@brainstorm-agentic/telemetry";
import { TelemetrySender } from "./telemetry-sender.js";
import { buildDiagnostic, TelemetryCollector } from "./telemetry-collector.js";
import type { ContentRegistryRuntimeStatus } from "./model.js";
import {
  ReadinessService,
  defaultReadinessProbes,
  type ReadinessAdvisor,
  type ReadinessProbes,
} from "./readiness.js";
import {
  promptFilename,
  promptIdentity,
  readPromptRecord,
  renderPromptMarkdown,
} from "./prompt-record.js";
import { aggregateToolUsage } from "./tool-usage.js";
import {
  applyAppUpdate as applyAppUpdateDefault,
  checkAppUpdate,
  type AppUpdate,
  type ApplyAppUpdateOptions,
  type StartedAppUpdate,
} from "./self-update.js";
import { RouteCatalog, loadModelCatalog } from "./route-catalog.js";
import {
  CapabilityCatalog,
  LOCKED_CAPABILITY_IDS,
} from "./capability-catalog.js";
import {
  ServerFileBrowser,
  ServerFileError,
} from "./server-files.js";
import {
  validateAnthropicConnection,
  validateClaudeAgentConnection,
  validateCursorAgentConnection,
  type AnthropicConnectionValidator,
  type ClaudeAgentConnectionValidator,
  type CursorAgentConnectionValidator,
} from "./settings.js";
import { listCursorModels } from "@brainstorm-agentic/executor-cursor-agent";

/**
 * The announced app version, read from the app-root package.json at startup.
 * This must never be a hard-coded constant again: every release bumped one by
 * hand until v0.2.35 forgot to, and the freshly updated server then announced
 * the OLD version — the web app compared versions, concluded the update had
 * rolled back, and told the user so, all while the new code ran fine.
 */
const VERSION = readAppVersion();

function readAppVersion(): string {
  // Walk up from this module (dist/src/server.js at runtime) to the app root,
  // identified by its package name rather than a fixed depth so a build
  // layout change cannot silently break version reporting.
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (
          parsed.name === "brainstorm-agentic-app" &&
          typeof parsed.version === "string"
        ) {
          return parsed.version;
        }
      } catch {
        // Unreadable candidate; keep walking up.
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "could not resolve the app version: no package.json named " +
      "brainstorm-agentic-app above " +
      fileURLToPath(import.meta.url),
  );
}
const SNAPSHOT_THROTTLE_MS = 500;
const HEARTBEAT_MS = 15_000;
const POLL_MS = 2_000;
const REGISTRY_HEARTBEAT_MS = 15_000;
/** Telemetry is not time-critical; a slow cadence keeps it out of the way. */
const TELEMETRY_FLUSH_MS = 60_000;
/**
 * How long close() will wait for an in-flight telemetry cycle before giving up
 * on it. Generous relative to the cycle's own 2s network timeout, and short
 * enough that a wedged cycle can never hold a shutdown open.
 */
const CLOSE_DRAIN_GRACE_MS = 5_000;
/** Interrupted-job scans hit squeue/sacct, so they poll far less often. */
const INTERRUPTED_SCAN_MS = 30_000;
/**
 * How long a graceful post-update shutdown may take before the process is
 * ended hard. The close path's own drains are bounded well below this; the
 * fallback exists so a stray handle can never keep the OLD server running
 * while an updater (or the SLURM wrapper) waits for it to exit.
 */
const FORCED_EXIT_AFTER_UPDATE_MS = 15_000;
const ATTACHMENT_KINDS = new Set<AttachmentSelectionKind>([
  "file",
  "folder",
  "zip",
  "image",
  "video",
  "pdf",
  "web",
]);

function attachmentKind(value: unknown): AttachmentSelectionKind {
  if (typeof value !== "string" || !ATTACHMENT_KINDS.has(value as AttachmentSelectionKind)) {
    throw new HttpError(400, "invalid attachment kind");
  }
  return value as AttachmentSelectionKind;
}

/**
 * Registry probe budget. Deployments regularly sit on an HPC login node
 * talking to a cloud registry: single round-trips spike well past a couple
 * of seconds under login-node load, and a too-tight budget makes the strict
 * verdict flicker "disconnected" for a whole TTL window over one aborted
 * request.
 */
const REGISTRY_PROBE_TIMEOUT_MS = 8_000;

/**
 * One probe fetch with a single immediate retry: the two realistic flicker
 * sources on long-lived deployments — a latency spike hitting the timeout,
 * and a stale kept-alive socket through NAT dying on reuse — both succeed
 * on the second attempt, while a genuinely dead registry still fails fast.
 */
async function probeFetch(url: URL | string): Promise<Response> {
  const attempt = (): Promise<Response> =>
    fetch(url, {
      signal: AbortSignal.timeout(REGISTRY_PROBE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  try {
    return await attempt();
  } catch {
    return await attempt();
  }
}

async function probeContentRegistry(
  registryUrl: string,
  status: ContentRegistryRuntimeStatus,
): Promise<void> {
  try {
    const url = new URL(registryUrl);
    url.pathname = url.pathname.replace(/\/mcp\/?$/, "/health");
    url.search = "";
    url.hash = "";
    const response = await probeFetch(url);
    status.running = response.ok;
    if (response.ok) {
      // Registry health announces its own process version; older registries
      // without it simply leave the field unset.
      const payload = (await response.json().catch(() => undefined)) as
        | { server?: { version?: unknown } }
        | undefined;
      const version = payload?.server?.version;
      if (typeof version === "string") status.serverVersion = version;
    }
  } catch {
    status.running = false;
  }
}

export interface StartBrainServerOptions {
  readonly workspace: string;
  readonly host?: string;
  readonly port?: number;
  /** Reachable Brain Registry URL; `brain launch` supplies local or remote. */
  readonly contentRegistryUrl: string;
  readonly contentRegistryStatus?: ContentRegistryRuntimeStatus;
  readonly workerPath?: string;
  readonly webappDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Server directories exposed by the read-only attachment picker. */
  readonly attachmentRoots?: readonly string[];
  /** Test/integration seam; production performs a real Anthropic request. */
  readonly validateAnthropic?: AnthropicConnectionValidator;
  /** Test/integration seam; production performs a real Agent SDK request. */
  readonly validateClaudeAgent?: ClaudeAgentConnectionValidator;
  /** Test/integration seam; production performs a real Cursor SDK request. */
  readonly validateCursorAgent?: CursorAgentConnectionValidator;
  /** Test seam; production lists the account's live Cursor model catalog. */
  readonly listCursorModels?: (
    apiKey: string,
  ) => Promise<readonly { id: string; displayName?: string }[]>;
  /** How long one live registry verification stays cached. Default 60s. */
  readonly registryProbeTtlMs?: number;
  readonly validateOpenRouter?: (
    apiKey: string,
    model: string,
  ) => Promise<void>;
  /** Check git release tags for a newer app version (real deployments only). */
  readonly selfUpdateCheck?: boolean;
  /** Test seam: how a newer release is detected. Default: git tag scan. */
  readonly appUpdateProbe?: (currentVersion: string) => Promise<AppUpdate | undefined>;
  /** Minimum time between on-demand release probes. Default 30s (test seam). */
  readonly appUpdateThrottleMs?: number;
  /** Test seam: how an update is applied. Default: detached updater script. */
  readonly applyAppUpdate?: (options: ApplyAppUpdateOptions) => Promise<StartedAppUpdate>;
  /**
   * Test seam: how the server hands itself over to the updater after
   * responding. Default sends SIGTERM to this process, which the launcher
   * turns into a graceful close; the detached updater waits for the process
   * to die before touching the tree.
   */
  readonly exitForUpdate?: () => void;
  /** Per-check probe overrides (test seam / special deployments). */
  readonly readinessProbes?: Partial<ReadinessProbes>;
  /** LLM fix-advice provider; null disables it (built-in hints only). */
  readonly readinessAdvisor?: ReadinessAdvisor | null;
  /** Ceiling for the SLURM probe job (submission + queue wait). */
  readonly slurmProbeTimeoutMs?: number;
  /** Unattended panel gates approve themselves after this. Default 30s. */
  readonly panelAutoApproveMs?: number;
  /**
   * Held-pilot submission channel (server-as-a-SLURM-job deployments where
   * sbatch is denied from compute nodes): the pool directory maintained by
   * deploy/lrz-queue-runway.sh. Unset submits via sbatch.
   */
  readonly pilotPoolDir?: string;
  /** Post-start quiet window before unattended-gate countdowns arm. */
  readonly gateAutoApproveGraceMs?: number;
}

export interface RunningBrainServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly workspace: string;
  readonly manager: JobManager;
  readonly contentRegistry: ContentRegistryRuntimeStatus;
  readonly readiness: ReadinessService;
  readonly httpServer: HttpServer;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * A signal that fires when the client stops waiting for this response.
 *
 * The file-explorer walks take it so a closed picker (or a re-typed search)
 * stops costing filesystem work the moment its request dies. Listening on the
 * RESPONSE is deliberate: `res` "close" fires on a dropped connection AND on
 * normal completion — and by completion the walk has already returned, so the
 * late abort is a no-op rather than a correctness risk.
 */
function requestAbortSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  return controller.signal;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, "request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requestObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function defaultWebappDir(): string {
  return fileURLToPath(new URL("../../../web/dist/", import.meta.url));
}

function serveStatic(
  res: ServerResponse,
  pathname: string,
  webappDir: string,
): void {
  const index = resolve(webappDir, "index.html");
  if (!existsSync(index)) {
    const placeholder =
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>Brain</title></head>" +
      "<body><main><h1>Brain</h1><p>The webapp is not built.</p></main></body></html>";
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(placeholder),
    });
    res.end(placeholder);
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid URL path");
  }
  const root = resolve(webappDir);
  const requested = resolve(root, `.${decoded}`);
  const safe = requested === root || requested.startsWith(`${root}/`);
  const file =
    safe && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : index;
  // Vite emits content-hashed filenames under assets/, so those bytes can
  // never change behind their URL: cache them forever and a page refresh
  // re-downloads nothing but index.html.
  const immutable = file !== index && decoded.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": contentType(file),
    "content-length": statSync(file).size,
    "cache-control":
      file === index
        ? "no-cache"
        : immutable
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
  });
  createReadStream(file).pipe(res);
}

class SseConnection {
  private lastSnapshotAt = 0;
  private timer: NodeJS.Timeout | undefined;
  /**
   * One pending snapshot producer per event type: a jobs snapshot and a
   * readiness snapshot may both be queued; a newer snapshot of the same type
   * replaces the older one (only the latest state matters).
   */
  private readonly pending = new Map<string, () => Promise<ServerEvent>>();
  /**
   * This reader's own position in each live thread — how many characters of it
   * have been sent. Held per CONNECTION so a frame carries only what this reader
   * has not seen, whatever the thread has grown to.
   */
  readonly liveSeen = new Map<string, number>();
  private closed = false;
  private sending = false;
  readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly res: ServerResponse,
    private readonly closeCallback: () => void,
  ) {
    this.heartbeat = setInterval(() => {
      if (!this.closed) this.res.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);
  }

  schedule(kind: string, producer: () => Promise<ServerEvent>): void {
    if (this.closed) return;
    this.pending.set(kind, producer);
    const delay = Math.max(
      0,
      SNAPSHOT_THROTTLE_MS - (Date.now() - this.lastSnapshotAt),
    );
    if (this.timer === undefined && !this.sending) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, delay);
    }
  }

  private async flush(): Promise<void> {
    if (this.closed || this.pending.size === 0) return;
    const producers = [...this.pending.values()];
    this.pending.clear();
    this.sending = true;
    try {
      for (const producer of producers) {
        if (this.closed) return;
        try {
          const event = await producer();
          if (!this.closed) {
            this.res.write(`data: ${JSON.stringify(event)}\n\n`);
            this.lastSnapshotAt = Date.now();
          }
        } catch (error) {
          if (!this.closed) {
            const event: ServerEvent = {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            };
            this.res.write(`data: ${JSON.stringify(event)}\n\n`);
            this.lastSnapshotAt = Date.now();
          }
        }
      }
    } finally {
      this.sending = false;
      if (this.pending.size > 0 && this.timer === undefined && !this.closed) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush();
        }, SNAPSHOT_THROTTLE_MS);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.closeCallback();
    this.res.end();
  }
}

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
}

function watcher(path: string, notify: () => void): FSWatcher | undefined {
  try {
    return watch(path, { recursive: true }, notify);
  } catch {
    try {
      return watch(path, notify);
    } catch {
      return undefined;
    }
  }
}

export async function startBrainServer(
  options: StartBrainServerOptions,
): Promise<RunningBrainServer> {
  const host = options.host ?? "127.0.0.1";
  const contentRegistry = options.contentRegistryStatus ?? {
    running: true,
    url: options.contentRegistryUrl,
  };
  const contentRegistryUrl = options.contentRegistryUrl;

  // Live registry verification with a short cache: every refresh probes the
  // registry's /health (reachability + its own server version) AND resolves
  // the configured bundle from /v1/index.json. "Connected" is strict by
  // design — the registry must be reachable NOW and serving the bundle's
  // index NOW, or the status reports not running. There is deliberately no
  // fallback that keeps showing a stale launch-time connection: an
  // unverifiable registry surfaces as disconnected, never as an old version.
  // The verdict lands on the shared mutable status object, so the readiness
  // gate and the health endpoint always agree.
  const registryProbeTtlMs = options.registryProbeTtlMs ?? 60_000;
  let registryIndexCache:
    | { at: number; latest?: string; latestNotes?: string }
    | undefined;
  const registryLatest = async (
    bundle: string,
  ): Promise<{ latest?: string; latestNotes?: string }> => {
    if (registryIndexCache && Date.now() - registryIndexCache.at < registryProbeTtlMs) {
      return registryIndexCache;
    }
    // Reachability first: a dead or non-registry host must flip the shared
    // status to not running even when the index fetch below cannot run.
    await probeContentRegistry(contentRegistryUrl, contentRegistry);
    let latest: string | undefined;
    let latestNotes: string | undefined;
    try {
      // The configured URL may be the MCP endpoint; the HTTP API lives at
      // the same origin without the /mcp suffix.
      const httpBase = contentRegistryUrl.replace(/\/+$/, "").replace(/\/mcp$/, "");
      const response = await probeFetch(`${httpBase}/v1/index.json`);
      if (response.ok) {
        const index = (await response.json()) as {
          bundles?: Array<{
            id?: string;
            latest?: string;
            releases?: Record<string, { notes?: string }>;
          }>;
        };
        const entry = index.bundles?.find((candidate) => candidate.id === bundle);
        if (entry && typeof entry.latest === "string") {
          latest = entry.latest;
          const notes = entry.releases?.[entry.latest]?.notes;
          if (typeof notes === "string" && notes.length > 0) latestNotes = notes;
        }
      }
    } catch {
      // The registry being unreachable never fails the health endpoint;
      // it reports a disconnected registry instead.
    }
    // Reachable but not serving the configured bundle's index is NOT a
    // connection — nothing current could be resolved to run from.
    contentRegistry.running = contentRegistry.running && latest !== undefined;
    registryIndexCache = {
      at: Date.now(),
      ...(latest ? { latest } : {}),
      ...(latestNotes ? { latestNotes } : {}),
    };
    return registryIndexCache;
  };

  let appUpdate: Awaited<ReturnType<typeof checkAppUpdate>>;
  let appUpdateTimer: NodeJS.Timeout | undefined;
  let appUpdateProbedAt = 0;
  let appUpdateInFlight: Promise<AppUpdate | undefined> | undefined;
  /** A fresh probe involves a git fetch; several tabs opening at once must
   *  share one, and rapid re-triggers within the window reuse the cache. */
  const APP_UPDATE_PROBE_THROTTLE_MS = options.appUpdateThrottleMs ?? 30_000;
  const probeAppUpdate = async (): Promise<AppUpdate | undefined> => {
    if (options.selfUpdateCheck !== true) return undefined;
    if (appUpdateInFlight) return appUpdateInFlight;
    if (Date.now() - appUpdateProbedAt < APP_UPDATE_PROBE_THROTTLE_MS) {
      return appUpdate;
    }
    const probe = options.appUpdateProbe ?? checkAppUpdate;
    appUpdateInFlight = probe(VERSION)
      .then((found) => {
        appUpdate = found;
        appUpdateProbedAt = Date.now();
        return found;
      })
      .catch(() => appUpdate)
      .finally(() => {
        appUpdateInFlight = undefined;
      });
    return appUpdateInFlight;
  };
  if (options.selfUpdateCheck === true) {
    void probeAppUpdate();
    // Half-hourly as the floor; opening the dashboard and submitting a run
    // each trigger a fresh (throttled) check so "the beginning of a
    // pipeline session" always sees the latest release, not the last tick.
    appUpdateTimer = setInterval(() => void probeAppUpdate(), 30 * 60 * 1000);
    appUpdateTimer.unref();
  }

  const jobStreams = new Set<SseConnection>();
  const detailStreams = new Map<string, Set<SseConnection>>();
  const routeCatalog = new RouteCatalog();
  const capabilityCatalog = new CapabilityCatalog();

  // The account's live Cursor model catalog, TTL-cached: new models appear
  // in the picker without an app release, but a settings render never pays
  // more than one network round-trip per window.
  const CURSOR_MODELS_TTL_MS = 5 * 60_000;
  let cursorModelsCache:
    | { at: number; models: readonly ModelOption[] }
    | undefined;
  const cursorModelOptions = async (): Promise<readonly ModelOption[]> => {
    if (
      cursorModelsCache &&
      Date.now() - cursorModelsCache.at < CURSOR_MODELS_TTL_MS
    ) {
      return cursorModelsCache.models;
    }
    const apiKey = manager.settings.getCursorApiKey();
    if (!apiKey) return [];
    try {
      const listed = await (options.listCursorModels ?? listCursorModels)(apiKey);
      const models = listed.map((entry) => ({
        id: entry.id,
        label: entry.displayName ?? entry.id,
      }));
      cursorModelsCache = { at: Date.now(), models };
      return models;
    } catch {
      // Unreachable API or a revoked key: the static catalog still serves.
      return [];
    }
  };
  let manager!: JobManager;
  let readiness!: ReadinessService;
  const broadcastJobs = (): void => {
    for (const stream of jobStreams) {
      stream.schedule("jobs", async () => ({ type: "jobs", jobs: await manager.list() }));
    }
  };
  const broadcastDetails = (): void => {
    for (const [jobId, streams] of detailStreams) {
      for (const stream of streams) {
        stream.schedule("job", async () => ({ type: "job", job: await manager.detail(jobId) }));
      }
    }
  };
  /**
   * Live text goes out on the same tick as everything else, under its own kind so
   * it coalesces separately: a frame that only carries new words does not have to
   * wait for a job detail to be rebuilt. Each connection frames its own delta.
   */
  const broadcastLive = (): void => {
    for (const [jobId, streams] of detailStreams) {
      for (const stream of streams) {
        stream.schedule("live", async () => ({
          type: "live",
          jobId,
          entries: await manager.liveText(jobId, stream.liveSeen),
        }));
      }
    }
  };
  const broadcastReadiness = (): void => {
    for (const stream of jobStreams) {
      stream.schedule("readiness", async () => ({
        type: "readiness",
        readiness: readiness.report(),
      }));
    }
  };
  const broadcast = (): void => {
    broadcastJobs();
    broadcastDetails();
    broadcastLive();
  };

  manager = new JobManager({
    workspace: options.workspace,
    contentRegistryUrl,
    ...(options.workerPath ? { workerPath: options.workerPath } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.validateAnthropic
      ? { validateAnthropic: options.validateAnthropic }
      : {}),
    ...(options.validateClaudeAgent
      ? { validateClaudeAgent: options.validateClaudeAgent }
      : {}),
    ...(options.validateCursorAgent
      ? { validateCursorAgent: options.validateCursorAgent }
      : {}),
    ...(options.validateOpenRouter
      ? { validateOpenRouter: options.validateOpenRouter }
      : {}),
    ...(options.panelAutoApproveMs !== undefined
      ? { panelAutoApproveMs: options.panelAutoApproveMs }
      : {}),
    ...(options.pilotPoolDir !== undefined
      ? { pilotPoolDir: options.pilotPoolDir }
      : {}),
    ...(options.gateAutoApproveGraceMs !== undefined
      ? { gateAutoApproveGraceMs: options.gateAutoApproveGraceMs }
      : {}),
    onChange: broadcast,
  });
  readiness = new ReadinessService({
    workspace: options.workspace,
    settings: manager.settings,
    contentRegistry,
    probes: defaultReadinessProbes({
      validateAnthropic: options.validateAnthropic ?? validateAnthropicConnection,
      validateClaudeAgent:
        options.validateClaudeAgent ?? validateClaudeAgentConnection,
      validateCursorAgent:
        options.validateCursorAgent ?? validateCursorAgentConnection,
      ...(options.slurmProbeTimeoutMs !== undefined
        ? { slurmProbeTimeoutMs: options.slurmProbeTimeoutMs }
        : {}),
      ...(options.pilotPoolDir !== undefined
        ? { pilotPoolDir: options.pilotPoolDir }
        : {}),
    }),
    ...(options.readinessProbes ? { probeOverrides: options.readinessProbes } : {}),
    ...(options.readinessAdvisor !== null
      ? {
          advisor:
            options.readinessAdvisor ??
            createReadinessAdvisor({
              settings: manager.settings,
              ...(options.env ? { env: options.env } : {}),
            }),
        }
      : {}),
    ...(options.env ? { env: options.env } : {}),
    onChange: broadcastReadiness,
  });
  // Starting points for the file picker, not a boundary: any server-readable
  // path can be attached. Defaults cover home, the launch workspace, and the
  // storage mounts HPC sites conventionally export as env vars ($SCRATCH,
  // $WORK, $PROJECT) — the browser dedupes and drops unreadable entries.
  const hpcStorageRoots = ["SCRATCH", "WORK", "PROJECT"]
    .map((name) => options.env?.[name] ?? process.env[name])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
  const configuredAttachmentRoots =
    options.attachmentRoots ??
    (options.env?.BRAIN_ATTACHMENT_ROOTS ?? process.env.BRAIN_ATTACHMENT_ROOTS)
      ?.split(delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) ??
    [homedir(), options.workspace, process.cwd(), ...hpcStorageRoots];
  const fileBrowser = new ServerFileBrowser({
    roots: configuredAttachmentRoots,
  });
  const webappDir =
    options.webappDir ??
    options.env?.BRAIN_WEBAPP_DIR ??
    process.env.BRAIN_WEBAPP_DIR ??
    defaultWebappDir();

  const httpServer = createServer(async (req, res) => {
    try {
      const authority = host.includes(":") ? `[${host}]` : host;
      const url = new URL(req.url ?? "/", `http://${authority}`);
      const path = url.pathname;
      if (req.method === "GET" && path === "/api/health") {
        const settings = manager.settings.get();
        const { latest, latestNotes } = await registryLatest(
          settings.contentRegistry.bundle,
        );
        // The version a new run starts with right now: the developer pin
        // when one exists, else the latest the registry publishes.
        const effectiveVersion = settings.contentRegistry.version ?? latest;
        const health: HealthResponse = {
          ok: true,
          version: VERSION,
          workspace: options.workspace,
          contentRegistry: {
            running: contentRegistry.running,
            ...(contentRegistry.url ? { url: contentRegistry.url } : {}),
            ...(contentRegistry.skills !== undefined ? { skills: contentRegistry.skills } : {}),
            ...(contentRegistry.workflows !== undefined
              ? { workflows: contentRegistry.workflows }
              : {}),
            bundle: settings.contentRegistry.bundle,
            ...(contentRegistry.serverVersion
              ? { serverVersion: contentRegistry.serverVersion }
              : {}),
            ...(latest ? { latest } : {}),
            ...(latestNotes ? { latestNotes } : {}),
            ...(settings.contentRegistry.version
              ? { pinnedVersion: settings.contentRegistry.version }
              : {}),
            ...(effectiveVersion ? { effectiveVersion } : {}),
          },
          ...(appUpdate && settings.updateCheck !== "off" ? { appUpdate } : {}),
        };
        sendJson(res, 200, health);
        return;
      }
      if (req.method === "POST" && path === "/api/update-check") {
        // "The beginning of a pipeline session": the dashboard calls this on
        // load so a just-published release surfaces immediately instead of
        // on the next half-hourly tick. Throttled server-side. When
        // self-update is disabled, `selfUpdateEnabled: false` tells the UI
        // that NOTHING was checked — answering with just the running version
        // let the settings drawer claim "you are on the latest version" on
        // deployments that never looked (observed on a --no-self-update
        // systemd host sitting three releases behind).
        const found = await probeAppUpdate();
        sendJson(res, 200, {
          version: VERSION,
          selfUpdateEnabled: options.selfUpdateCheck === true,
          ...(found ? { appUpdate: found } : {}),
        });
        return;
      }
      if (req.method === "POST" && path === "/api/update") {
        // One-click self-update: hand over to a detached updater and exit.
        // Active jobs are their own detached processes over workspace files;
        // they survive the restart and the relaunched server adopts them.
        if (options.selfUpdateCheck !== true) {
          throw new HttpError(409, "self-update is disabled on this deployment");
        }
        // The cache may lag a release pushed minutes ago, and the user
        // expressed intent NOW: re-probe so the button always targets the
        // freshest tag (the cached value is the fallback).
        appUpdate = (await probeAppUpdate()) ?? appUpdate;
        if (!appUpdate) {
          throw new HttpError(
            409,
            "no newer release is known; the server checks for releases every 30 minutes",
          );
        }
        const target = appUpdate.version;
        let started: StartedAppUpdate;
        try {
          started = await (options.applyAppUpdate ?? applyAppUpdateDefault)({
            targetVersion: target,
            stateDir: join(options.workspace, "self-update"),
            relaunch: {
              command: process.execPath,
              args: process.argv.slice(1),
              cwd: process.cwd(),
            },
            pid: process.pid,
          });
        } catch (error) {
          throw new HttpError(
            409,
            error instanceof Error ? error.message : String(error),
          );
        }
        sendJson(res, 200, {
          updatingTo: target,
          logFile: started.logFile,
        });
        // Let the response flush, then shut down; the updater (or the SLURM
        // wrapper, whose checkout was already applied in-process) is waiting
        // for this process to exit before rebuild/relaunch.
        const exitForUpdate =
          options.exitForUpdate ??
          ((): void => {
            process.kill(process.pid, "SIGTERM");
            // The graceful close must END the process: if any stray handle
            // (a kept-alive socket, a wedged watcher) keeps the event loop
            // alive past the bounded drains, exit hard — an old server that
            // never exits stalls the update indefinitely. Unref'd, so a
            // clean exit is never delayed by this timer.
            setTimeout(() => process.exit(0), FORCED_EXIT_AFTER_UPDATE_MS).unref();
          });
        setTimeout(exitForUpdate, 500).unref();
        return;
      }
      if (req.method === "GET" && path === "/api/attachments/roots") {
        sendJson(res, 200, { roots: fileBrowser.roots });
        return;
      }
      if (req.method === "GET" && path === "/api/attachments/browse") {
        const signal = requestAbortSignal(res);
        try {
          const listing = await fileBrowser.browse(
            url.searchParams.get("root") ?? undefined,
            url.searchParams.get("path") ?? undefined,
            attachmentKind(url.searchParams.get("kind") ?? "file"),
            signal,
          );
          if (signal.aborted) return;
          sendJson(res, 200, listing);
        } catch (error) {
          if (signal.aborted) return;
          throw new HttpError(
            error instanceof ServerFileError ? error.status : 400,
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      if (req.method === "GET" && path === "/api/attachments/search") {
        const signal = requestAbortSignal(res);
        try {
          const found = await fileBrowser.search(
            url.searchParams.get("root") ?? undefined,
            url.searchParams.get("path") ?? undefined,
            attachmentKind(url.searchParams.get("kind") ?? "file"),
            url.searchParams.get("q") ?? "",
            signal,
          );
          if (signal.aborted) return;
          sendJson(res, 200, found);
        } catch (error) {
          if (signal.aborted) return;
          throw new HttpError(
            error instanceof ServerFileError ? error.status : 400,
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      if (req.method === "POST" && path === "/api/attachments/validate") {
        const body = requestObject(await readJson(req));
        const kind = attachmentKind(body.kind);
        if (
          !Array.isArray(body.paths) ||
          body.paths.length < 1 ||
          body.paths.length > 20 ||
          !body.paths.every(
            (entry) => typeof entry === "string" && entry.trim().length > 0,
          )
        ) {
          throw new HttpError(
            400,
            "paths must be an array of 1–20 non-empty server paths or URLs",
          );
        }
        const signal = requestAbortSignal(res);
        const attachments = await fileBrowser.validate(
          kind,
          body.paths as string[],
          signal,
        );
        if (signal.aborted) return;
        sendJson(res, 200, { attachments });
        return;
      }
      if (req.method === "GET" && path === "/api/settings") {
        sendJson(res, 200, manager.settings.get());
        return;
      }
      if (req.method === "PUT" && path === "/api/settings") {
        try {
          const body = await readJson(req);
          const before = manager.settings.get();
          const settings = await manager.settings.put(body);
          broadcast();
          // Provider/runner changes flip which checks matter, so those re-verify.
          // Nothing else does: with each section saving on its own, refreshing
          // on every save would re-probe the provider (a real request) every
          // time someone nudged an unrelated control.
          if (
            settings.llm.provider !== before.llm.provider ||
            settings.llm.model !== before.llm.model ||
            settings.runner !== before.runner
          ) {
            readiness.refresh();
            broadcastReadiness();
          }
          sendJson(res, 200, settings);
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      if (req.method === "GET" && path === "/api/readiness") {
        sendJson(res, 200, readiness.report());
        return;
      }
      if (req.method === "POST" && path === "/api/readiness/check") {
        const body = requestObject(await readJson(req));
        let checks: ReadinessCheckId[] | undefined;
        if (body.checks !== undefined) {
          if (
            !Array.isArray(body.checks) ||
            !body.checks.every(
              (id): id is ReadinessCheckId =>
                typeof id === "string" &&
                (READINESS_CHECK_IDS as readonly string[]).includes(id),
            )
          ) {
            throw new HttpError(400, "checks must be an array of readiness check ids");
          }
          checks = body.checks;
        }
        readiness.refresh(checks);
        broadcastReadiness();
        sendJson(res, 200, readiness.report());
        return;
      }
      if (req.method === "POST" && path === "/api/readiness/diagnose") {
        const body = requestObject(await readJson(req));
        if (
          typeof body.check !== "string" ||
          !(READINESS_CHECK_IDS as readonly string[]).includes(body.check)
        ) {
          throw new HttpError(400, "check must be a readiness check id");
        }
        await readiness.advise(body.check as ReadinessCheckId, { force: true });
        broadcastReadiness();
        sendJson(res, 200, readiness.report());
        return;
      }
      if (req.method === "GET" && path === "/api/model-options") {
        const settings = manager.settings.get();
        const catalog = loadModelCatalog(options.workspace);
        const taskTypes = await routeCatalog.taskTypes(
          settings.contentRegistry.url,
          settings.contentRegistry.bundle,
          settings.contentRegistry.version,
        );
        let models = catalog[settings.llm.provider] ?? [];
        if (settings.llm.provider === "cursor-agent") {
          // Cursor serves many vendors' models per account, so the picker
          // offers the LIVE catalog (every Sonnet/Opus version, GPT,
          // Composer, …) instead of a hardcoded excerpt. Failure or a
          // missing key falls back to the static list.
          const live = await cursorModelOptions();
          if (live.length > 0) models = live;
        }
        const response: ModelOptionsResponse = {
          provider: settings.llm.provider,
          taskTypes,
          models,
          modelsByRoute: settings.llm.modelsByRoute ?? {},
          ...(settings.llm.model ? { defaultModel: settings.llm.model } : {}),
        };
        sendJson(res, 200, response);
        return;
      }
      if (req.method === "GET" && path === "/api/capabilities") {
        const settings = manager.settings.get();
        const snapshot = await capabilityCatalog.options(
          settings.contentRegistry.url,
          settings.contentRegistry.bundle,
          settings.contentRegistry.version,
        );
        sendJson(res, 200, snapshot);
        return;
      }
      if (req.method === "PUT" && path === "/api/settings/models-by-route") {
        try {
          const settings = manager.settings.putModelsByRoute(
            await readJson(req),
          );
          broadcast();
          sendJson(res, 200, settings);
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      if (req.method === "GET" && path === "/api/jobs") {
        sendJson(res, 200, await manager.list());
        return;
      }
      if (req.method === "POST" && path === "/api/jobs") {
        const body = requestObject(await readJson(req));
        if (typeof body.topic !== "string" || body.topic.trim().length === 0) {
          throw new HttpError(400, "topic must be a non-empty string");
        }
        const rawOverrides = body.capabilityOverrides;
        if (
          rawOverrides !== undefined &&
          (typeof rawOverrides !== "object" ||
            rawOverrides === null ||
            Array.isArray(rawOverrides) ||
            !Object.entries(rawOverrides).every(
              ([id, enabled]) =>
                /^[a-z][a-z0-9-]*$/.test(id) && typeof enabled === "boolean",
            ))
        ) {
          throw new HttpError(
            400,
            "capabilityOverrides must map capability ids to booleans",
          );
        }
        // Locked capabilities are runtime infrastructure; overrides for them
        // are dropped rather than rejected so older/newer UIs stay compatible.
        const capabilityOverrides = Object.fromEntries(
          Object.entries(
            (rawOverrides as Record<string, boolean> | undefined) ?? {},
          ).filter(([id]) => !LOCKED_CAPABILITY_IDS.has(id)),
        );
        const disabledForRun = new Set(
          Object.entries(capabilityOverrides)
            .filter(([, enabled]) => enabled === false)
            .map(([id]) => id),
        );
        // The submission gate: while a required environment check is RED the
        // pipeline must not start. The webapp holds the prompt and shows the
        // waiting card; checks still running do not block (their failures
        // surface as ordinary job errors, exactly as before readiness existed).
        {
          const report = readiness.report();
          const failing = report.checks
            .filter((check) => check.required && check.state === "failed")
            .filter((check) => {
              if (check.id !== "capabilities" || disabledForRun.size === 0) {
                return true;
              }
              // The capabilities probe fails on ANY unsatisfiable capability.
              // When every unsatisfied capability is one this run explicitly
              // disabled, the failure cannot degrade this job — let it pass.
              const unsatisfied = [
                ...(check.detail ?? "").matchAll(
                  /^([a-z][a-z0-9-]*) \/ \S+ -> unavailable$/gm,
                ),
              ].map((match) => match[1]!);
              return !(
                unsatisfied.length > 0 &&
                unsatisfied.every((id) => disabledForRun.has(id))
              );
            });
          if (failing.length > 0) {
            sendJson(res, 409, {
              message:
                "Environment is not ready: " +
                failing
                  .map((check) => `${check.label} — ${check.message ?? "check failed"}`)
                  .join("; "),
              readiness: report,
            });
            return;
          }
        }
        if (
          body.attachments !== undefined &&
          (!Array.isArray(body.attachments) ||
            body.attachments.length > 20 ||
            !body.attachments.every(
              (entry) => typeof entry === "string" && entry.trim().length > 0,
            ))
        ) {
          throw new HttpError(
            400,
            "attachments must be up to 20 non-empty server paths or URLs",
          );
        }
        const request = body as unknown as SubmitJobRequest;
        let jobId: string;
        try {
          const references = await fileBrowser.canonicalizeReferences(
            request.attachments ?? [],
          );
          jobId = await manager.submit(
            request.topic,
            references,
            capabilityOverrides,
          );
          // Launching a pipeline is the other "beginning": refresh release
          // knowledge in the background so the toast is current while the
          // run executes. Never blocks or fails the submission.
          void probeAppUpdate();
        } catch (error) {
          throw new HttpError(
            error instanceof ServerFileError ? error.status : 400,
            error instanceof Error ? error.message : String(error),
          );
        }
        broadcast();
        sendJson(res, 200, { jobId });
        return;
      }
      if (req.method === "GET" && path === "/api/stream") {
        openSse(res);
        let connection!: SseConnection;
        connection = new SseConnection(res, () => jobStreams.delete(connection));
        jobStreams.add(connection);
        res.once("close", () => connection.close());
        connection.schedule("jobs", async () => ({ type: "jobs", jobs: await manager.list() }));
        connection.schedule("readiness", async () => ({
          type: "readiness",
          readiness: readiness.report(),
        }));
        return;
      }

      const streamMatch = /^\/api\/jobs\/([^/]+)\/stream$/.exec(path);
      if (req.method === "GET" && streamMatch) {
        const jobId = decodeURIComponent(streamMatch[1]!);
        try {
          await manager.detail(jobId);
        } catch {
          throw new HttpError(404, `job "${jobId}" was not found`);
        }
        openSse(res);
        const streams = detailStreams.get(jobId) ?? new Set<SseConnection>();
        detailStreams.set(jobId, streams);
        let connection!: SseConnection;
        connection = new SseConnection(res, () => {
          streams.delete(connection);
          if (streams.size === 0) detailStreams.delete(jobId);
        });
        streams.add(connection);
        res.once("close", () => connection.close());
        connection.schedule("job", async () => ({ type: "job", job: await manager.detail(jobId) }));
        // A reader that has just opened the page has seen nothing, so its first
        // live frame carries each thread whole — the part of the conversation it
        // walked in on.
        connection.schedule("live", async () => ({
          type: "live",
          jobId,
          entries: await manager.liveText(jobId, connection.liveSeen),
        }));
        return;
      }

      const cancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
      if (req.method === "POST" && cancelMatch) {
        const jobId = decodeURIComponent(cancelMatch[1]!);
        const status = await manager.cancel(jobId);
        broadcast();
        sendJson(res, 200, { jobId, status });
        return;
      }

      const pauseMatch = /^\/api\/jobs\/([^/]+)\/pause$/.exec(path);
      if (req.method === "POST" && pauseMatch) {
        const jobId = decodeURIComponent(pauseMatch[1]!);
        try {
          const status = await manager.pause(jobId);
          broadcast();
          sendJson(res, 200, { jobId, status });
        } catch (error) {
          if (error instanceof JobConflictError) {
            throw new HttpError(409, error.message);
          }
          throw error;
        }
        return;
      }

      const resumePausedMatch = /^\/api\/jobs\/([^/]+)\/resume-paused$/.exec(path);
      if (req.method === "POST" && resumePausedMatch) {
        const jobId = decodeURIComponent(resumePausedMatch[1]!);
        try {
          const status = await manager.resumePaused(jobId);
          broadcast();
          sendJson(res, 200, { jobId, status });
        } catch (error) {
          if (error instanceof JobConflictError) {
            throw new HttpError(409, error.message);
          }
          throw error;
        }
        return;
      }

      const resumeMatch = /^\/api\/jobs\/([^/]+)\/resume$/.exec(path);
      if (req.method === "POST" && resumeMatch) {
        const jobId = decodeURIComponent(resumeMatch[1]!);
        try {
          const status = await manager.resumeCreditBlocked(jobId);
          broadcast();
          sendJson(res, 200, { jobId, status });
        } catch (error) {
          if (error instanceof JobConflictError) {
            throw new HttpError(409, error.message);
          }
          throw error; // "was not found" maps to 404 in the outer handler
        }
        return;
      }

      const resumeInterruptedMatch =
        /^\/api\/jobs\/([^/]+)\/resume-interrupted$/.exec(path);
      if (req.method === "POST" && resumeInterruptedMatch) {
        const jobId = decodeURIComponent(resumeInterruptedMatch[1]!);
        try {
          const status = await manager.resumeInterrupted(jobId);
          broadcast();
          sendJson(res, 200, { jobId, status });
        } catch (error) {
          if (error instanceof JobConflictError) {
            throw new HttpError(409, error.message);
          }
          throw error; // "was not found" maps to 404 in the outer handler
        }
        return;
      }

      const retryMatch = /^\/api\/jobs\/([^/]+)\/retry$/.exec(path);
      if (req.method === "POST" && retryMatch) {
        const jobId = decodeURIComponent(retryMatch[1]!);
        try {
          const status = await manager.retryFailed(jobId);
          broadcast();
          sendJson(res, 200, { jobId, status });
        } catch (error) {
          if (error instanceof JobConflictError) {
            throw new HttpError(409, error.message);
          }
          throw error; // "was not found" maps to 404 in the outer handler
        }
        return;
      }

      // Must precede the ":jobId" detail route, which would match "trash".
      if (req.method === "GET" && path === "/api/jobs/trash") {
        sendJson(res, 200, await manager.listTrashed());
        return;
      }

      const trashMatch = /^\/api\/jobs\/([^/]+)\/trash$/.exec(path);
      if (req.method === "POST" && trashMatch) {
        try {
          const result = await manager.trash(decodeURIComponent(trashMatch[1]!));
          broadcast();
          sendJson(res, 200, result);
        } catch (error) {
          if (error instanceof JobConflictError) {
            throw new HttpError(409, error.message);
          }
          throw error; // "was not found" maps to 404 in the outer handler
        }
        return;
      }

      // A diagnostic report is NEVER sent automatically and is NOT covered by
      // the telemetry setting: it can carry material the submitter wrote, so it
      // takes a deliberate per-report action. The preview exists so that
      // decision is informed rather than implied.
      const diagPreviewMatch = /^\/api\/jobs\/([^/]+)\/diagnostics$/.exec(path);
      if (req.method === "GET" && diagPreviewMatch) {
        const jobId = decodeURIComponent(diagPreviewMatch[1]!);
        const job = (await manager.list()).find((entry) => entry.jobId === jobId);
        if (!job) throw new HttpError(404, `job "${jobId}" was not found`);
        // Truthy, not defined: a derived-but-empty URL (no registry) is
        // still "nowhere to send".
        const configured = !!manager.settings.get().telemetry?.ingestUrl;
        sendJson(
          res,
          200,
          buildDiagnostic(manager.jobsDir, manager.sessionsDir, job, configured).preview,
        );
        return;
      }
      if (req.method === "POST" && diagPreviewMatch) {
        const jobId = decodeURIComponent(diagPreviewMatch[1]!);
        const job = (await manager.list()).find((entry) => entry.jobId === jobId);
        if (!job) throw new HttpError(404, `job "${jobId}" was not found`);
        const ingestUrl = manager.settings.get().telemetry?.ingestUrl;
        if (!ingestUrl) {
          throw new HttpError(409, "no diagnostics endpoint is configured");
        }
        const { report, preview } = buildDiagnostic(
          manager.jobsDir,
          manager.sessionsDir,
          job,
          true,
        );
        try {
          const response = await fetch(`${ingestUrl.replace(/\/+$/, "")}/v1/diagnostics`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) {
            throw new HttpError(502, `the diagnostics endpoint answered ${response.status}`);
          }
          sendJson(res, 200, { sent: true, bytes: preview.totalBytes });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, "could not reach the diagnostics endpoint");
        }
        return;
      }

      const gateHoldMatch = /^\/api\/jobs\/([^/]+)\/gate-hold$/.exec(path);
      if (req.method === "POST" && gateHoldMatch) {
        const jobId = decodeURIComponent(gateHoldMatch[1]!);
        try {
          const detail = await manager.holdGateAutoApprove(jobId);
          broadcast();
          sendJson(res, 200, detail);
        } catch (error) {
          if (error instanceof JobConflictError) {
            throw new HttpError(409, error.message);
          }
          throw error; // "was not found" maps to 404 in the outer handler
        }
        return;
      }

      const gateMatch = /^\/api\/jobs\/([^/]+)\/gate$/.exec(path);
      if (req.method === "POST" && gateMatch) {
        const body = requestObject(await readJson(req));
        if (
          typeof body.gateKey !== "string" ||
          (body.action !== "approve" &&
            body.action !== "shrink" &&
            body.action !== "revise") ||
          (body.members !== undefined &&
            (!Array.isArray(body.members) ||
              !body.members.every((member) => typeof member === "string"))) ||
          (body.addedMembers !== undefined &&
            (!Array.isArray(body.addedMembers) ||
              !body.addedMembers.every(
                (seat) =>
                  typeof seat === "object" && seat !== null && !Array.isArray(seat),
              ))) ||
          (body.type !== undefined && typeof body.type !== "string") ||
          (body.requestedOutputs !== undefined &&
            (!Array.isArray(body.requestedOutputs) ||
              !body.requestedOutputs.every(
                (entry) =>
                  typeof entry === "object" &&
                  entry !== null &&
                  !Array.isArray(entry) &&
                  typeof (entry as { title?: unknown }).title === "string" &&
                  typeof (entry as { ask?: unknown }).ask === "string",
              )))
        ) {
          throw new HttpError(400, "invalid gate answer");
        }
        const answer = body as unknown as GateAnswerRequest;
        let detail;
        try {
          detail = await manager.answerGate(
            decodeURIComponent(gateMatch[1]!),
            answer,
          );
        } catch (error) {
          if (error instanceof Error && /was not found/.test(error.message)) throw error;
          throw new HttpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
        broadcast();
        sendJson(res, 200, detail);
        return;
      }

      const dismissMatch = /^\/api\/jobs\/([^/]+)\/dismiss-member$/.exec(path);
      if (req.method === "POST" && dismissMatch) {
        const body = requestObject(await readJson(req));
        if (typeof body.memberId !== "string" || body.memberId.trim().length === 0) {
          throw new HttpError(400, "memberId must be a non-empty string");
        }
        let detail;
        try {
          detail = await manager.dismissMember(
            decodeURIComponent(dismissMatch[1]!),
            body.memberId,
          );
        } catch (error) {
          if (error instanceof JobConflictError) {
            throw new HttpError(409, error.message);
          }
          throw error; // "was not found" maps to 404 in the outer handler
        }
        broadcast();
        sendJson(res, 200, detail);
        return;
      }

      const usageMatch = /^\/api\/jobs\/([^/]+)\/tool-usage$/.exec(path);
      if (req.method === "GET" && usageMatch) {
        const jobId = decodeURIComponent(usageMatch[1]!);
        await manager.detail(jobId); // "was not found" maps to 404 in the outer handler
        sendJson(res, 200, aggregateToolUsage(manager.jobDir(jobId)));
        return;
      }

      // Before the job-detail matcher below, which would otherwise swallow it.
      const promptMatch = /^\/api\/jobs\/([^/]+)\/prompt\/([^/]+)$/.exec(path);
      if (req.method === "GET" && promptMatch) {
        const jobId = decodeURIComponent(promptMatch[1]!);
        const promptId = decodeURIComponent(promptMatch[2]!);
        const detail = await manager.detail(jobId); // unknown run -> 404 outside
        const record = readPromptRecord(manager.jobDir(jobId), promptId);
        if (record === undefined) {
          // Also the honest answer while a row is younger than the writer's
          // flush timer, which is why nothing here may be cached: the same
          // request a second later legitimately succeeds.
          throw new HttpError(404, "that prompt record was not found");
        }
        const identity = promptIdentity(record, detail);
        const body = renderPromptMarkdown(record, identity);
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "content-disposition": `attachment; filename="${promptFilename(record, identity)}"`,
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }

      const detailMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
      if (req.method === "GET" && detailMatch) {
        sendJson(res, 200, await manager.detail(decodeURIComponent(detailMatch[1]!)));
        return;
      }

      if (path.startsWith("/api/")) {
        throw new HttpError(404, "API route not found");
      }
      if (req.method === "GET") {
        serveStatic(res, path, webappDir);
        return;
      }
      throw new HttpError(404, "not found");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const notFound =
        error instanceof Error && /was not found/.test(error.message);
      const status =
        error instanceof HttpError ? error.status : notFound ? 404 : 500;
      sendJson(res, status, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60_000;
  httpServer.keepAliveTimeout = 5_000;

  const port = await new Promise<number>((resolvePort, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.off("error", reject);
      const address = httpServer.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });

  const watchers = [
    watcher(manager.jobsDir, broadcast),
    watcher(manager.sessionsDir, broadcast),
  ].filter((entry): entry is FSWatcher => entry !== undefined);
  const poll = setInterval(() => {
    void manager
      .resumeDueCreditBlocks()
      .then(() => manager.autoApproveDueGates())
      .finally(broadcast);
  }, POLL_MS);
  const interruptedPoll = setInterval(() => {
    void manager.resumeInterruptedJobs().finally(broadcast);
  }, INTERRUPTED_SCAN_MS);
  // Telemetry rides an existing timer rather than adding its own: a flush is
  // a no-op when the spool is empty, which is the common case.
  const telemetrySender = new TelemetrySender(new TelemetrySpool(options.workspace), {
    enabled: () => manager.settings.get().telemetry?.enabled !== false,
    ingestUrl: () => manager.settings.get().telemetry?.ingestUrl,
  });
  const telemetryCollector = new TelemetryCollector(
    new TelemetrySpool(options.workspace),
    manager.sessionsDir,
    () => {
      const current = manager.settings.get();
      return {
        installId: installId(options.workspace),
        appVersion: VERSION,
        provider: current.llm.provider,
        runner: current.runner === "slurm" ? "slurm" : "local",
      };
    },
  );
  // The in-flight telemetry cycle, if one is running.
  //
  // clearInterval stops future ticks but not the async body a tick has already
  // started, which appends to the spool and then flushes. close() awaits this
  // so shutdown does not resolve mid-write. Scope, precisely: this covers the
  // SERVER's own spool writes only. The worker writes far more of the
  // workspace, from a detached process the server cannot await by design (a run
  // must survive a server restart) — so "closed" still does not mean "nothing
  // in this workspace is being written". It only means the server itself is
  // done.
  let telemetryCycle: Promise<void> | undefined;
  const telemetryPoll = setInterval(() => {
    const cycle = (async () => {
      if (manager.settings.get().telemetry?.enabled !== false) {
        try {
          telemetryCollector.collect(await manager.list());
        } catch {
          // Collection is never a reason to disturb the server.
        }
      }
      await telemetrySender.flush();
    })().finally(() => {
      // Only retire the handle if it is still ours. Clearing unconditionally
      // would let a slow cycle, settling after a later tick had stored its own
      // promise, erase that newer one — and close() would then await nothing
      // while a write was still in flight.
      if (telemetryCycle === cycle) telemetryCycle = undefined;
    });
    telemetryCycle = cycle;
  }, TELEMETRY_FLUSH_MS);
  const registryPoll = setInterval(() => {
    void probeContentRegistry(contentRegistryUrl, contentRegistry);
  }, REGISTRY_HEARTBEAT_MS);
  await manager.resumeDueCreditBlocks();
  await probeContentRegistry(contentRegistryUrl, contentRegistry);
  // Startup recovery + verification run in the background: interrupted jobs
  // found on the shared workspace resume from their checkpoints, and every
  // required environment check re-verifies for the status icons.
  void manager.resumeInterruptedJobs().finally(broadcast);
  readiness.refresh();
  // Failed required checks re-probe themselves on a per-check cooldown, so
  // one transient failure at launch cannot hold the submission gate red
  // until a human finds the recheck button.
  readiness.startAutoRecheck();

  return {
    port,
    host,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    workspace: options.workspace,
    manager,
    contentRegistry,
    readiness,
    httpServer,
    close: async () => {
      clearInterval(poll);
      clearInterval(interruptedPoll);
      clearInterval(registryPoll);
      clearInterval(telemetryPoll);
      if (appUpdateTimer) clearInterval(appUpdateTimer);
      readiness.close();
      watchers.forEach((entry) => entry.close());
      for (const stream of [...jobStreams]) stream.close();
      for (const streams of detailStreams.values()) {
        for (const stream of [...streams]) stream.close();
      }
      await new Promise<void>((resolveClose, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolveClose()));
        httpServer.closeAllConnections();
      });
      // Last, once the listener is down: awaiting here rather than at the top
      // means shutdown does not yield while the server is still accepting
      // requests, which would have kept new work arriving during teardown.
      //
      // The cycle never rejects (flush swallows send failures) and its network
      // leg carries its own abort timeout, but the race is bounded here anyway
      // so no future change inside it can leave close() hanging.
      if (telemetryCycle) {
        let bail: NodeJS.Timeout | undefined;
        await Promise.race([
          telemetryCycle.catch(() => undefined),
          new Promise<void>((settle) => {
            bail = setTimeout(settle, CLOSE_DRAIN_GRACE_MS);
          }),
        ]);
        if (bail) clearTimeout(bail);
      }
    },
  };
}
