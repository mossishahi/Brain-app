import {
  createReadStream,
  existsSync,
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
import { delimiter, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AttachmentSelectionKind,
  GateAnswerRequest,
  HealthResponse,
  ServerEvent,
  SubmitJobRequest,
} from "@brainstorm-agentic/protocol";

import { JobManager } from "./job-manager.js";
import type { ContentRegistryRuntimeStatus } from "./model.js";
import {
  ServerFileBrowser,
  ServerFileError,
} from "./server-files.js";
import type {
  AnthropicConnectionValidator,
  ClaudeAgentConnectionValidator,
} from "./settings.js";

const VERSION = "0.1.0";
const SNAPSHOT_THROTTLE_MS = 500;
const HEARTBEAT_MS = 15_000;
const POLL_MS = 2_000;
const REGISTRY_HEARTBEAT_MS = 15_000;
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

async function probeContentRegistry(
  registryUrl: string,
  status: ContentRegistryRuntimeStatus,
): Promise<void> {
  try {
    const url = new URL(registryUrl);
    url.pathname = url.pathname.replace(/\/mcp\/?$/, "/health");
    url.search = "";
    url.hash = "";
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: "application/json" },
    });
    status.running = response.ok;
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
  readonly validateOpenRouter?: (
    apiKey: string,
    model: string,
  ) => Promise<void>;
}

export interface RunningBrainServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly workspace: string;
  readonly manager: JobManager;
  readonly contentRegistry: ContentRegistryRuntimeStatus;
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
  res.writeHead(200, {
    "content-type": contentType(file),
    "content-length": statSync(file).size,
    "cache-control": file === index ? "no-cache" : "public, max-age=3600",
  });
  createReadStream(file).pipe(res);
}

class SseConnection {
  private lastSnapshotAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private pending: (() => Promise<ServerEvent>) | undefined;
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

  schedule(producer: () => Promise<ServerEvent>): void {
    if (this.closed) return;
    this.pending = producer;
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
    const producer = this.pending;
    this.pending = undefined;
    if (!producer || this.closed) return;
    this.sending = true;
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
    } finally {
      this.sending = false;
      if (this.pending) this.schedule(this.pending);
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

  const jobStreams = new Set<SseConnection>();
  const detailStreams = new Map<string, Set<SseConnection>>();
  let manager!: JobManager;
  const broadcastJobs = (): void => {
    for (const stream of jobStreams) {
      stream.schedule(async () => ({ type: "jobs", jobs: await manager.list() }));
    }
  };
  const broadcastDetails = (): void => {
    for (const [jobId, streams] of detailStreams) {
      for (const stream of streams) {
        stream.schedule(async () => ({ type: "job", job: await manager.detail(jobId) }));
      }
    }
  };
  const broadcast = (): void => {
    broadcastJobs();
    broadcastDetails();
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
    ...(options.validateOpenRouter
      ? { validateOpenRouter: options.validateOpenRouter }
      : {}),
    onChange: broadcast,
  });
  const configuredAttachmentRoots =
    options.attachmentRoots ??
    (options.env?.BRAIN_ATTACHMENT_ROOTS ?? process.env.BRAIN_ATTACHMENT_ROOTS)
      ?.split(delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) ??
    [homedir()];
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
          },
        };
        sendJson(res, 200, health);
        return;
      }
      if (req.method === "GET" && path === "/api/attachments/roots") {
        sendJson(res, 200, { roots: fileBrowser.roots });
        return;
      }
      if (req.method === "GET" && path === "/api/attachments/browse") {
        try {
          sendJson(
            res,
            200,
            fileBrowser.browse(
              url.searchParams.get("root") ?? undefined,
              url.searchParams.get("path") ?? undefined,
              attachmentKind(url.searchParams.get("kind") ?? "file"),
            ),
          );
        } catch (error) {
          throw new HttpError(
            error instanceof ServerFileError ? error.status : 400,
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }
      if (req.method === "GET" && path === "/api/attachments/search") {
        try {
          sendJson(
            res,
            200,
            fileBrowser.search(
              url.searchParams.get("root") ?? undefined,
              url.searchParams.get("path") ?? undefined,
              attachmentKind(url.searchParams.get("kind") ?? "file"),
              url.searchParams.get("q") ?? "",
            ),
          );
        } catch (error) {
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
        sendJson(res, 200, {
          attachments: await fileBrowser.validate(
            kind,
            body.paths as string[],
          ),
        });
        return;
      }
      if (req.method === "GET" && path === "/api/settings") {
        sendJson(res, 200, manager.settings.get());
        return;
      }
      if (req.method === "PUT" && path === "/api/settings") {
        try {
          const settings = await manager.settings.put(await readJson(req));
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
          const references = fileBrowser.canonicalizeReferences(
            request.attachments ?? [],
          );
          jobId = await manager.submit(request.topic, references);
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
        connection.schedule(async () => ({ type: "jobs", jobs: await manager.list() }));
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
        connection.schedule(async () => ({ type: "job", job: await manager.detail(jobId) }));
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

      const gateMatch = /^\/api\/jobs\/([^/]+)\/gate$/.exec(path);
      if (req.method === "POST" && gateMatch) {
        const body = requestObject(await readJson(req));
        if (
          typeof body.gateKey !== "string" ||
          (body.action !== "approve" && body.action !== "shrink") ||
          (body.members !== undefined &&
            (!Array.isArray(body.members) ||
              !body.members.every((member) => typeof member === "string")))
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
    void manager.resumeDueCreditBlocks().finally(broadcast);
  }, POLL_MS);
  const registryPoll = setInterval(() => {
    void probeContentRegistry(contentRegistryUrl, contentRegistry);
  }, REGISTRY_HEARTBEAT_MS);
  await manager.resumeDueCreditBlocks();
  await probeContentRegistry(contentRegistryUrl, contentRegistry);

  return {
    port,
    host,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    workspace: options.workspace,
    manager,
    contentRegistry,
    httpServer,
    close: async () => {
      clearInterval(poll);
      clearInterval(registryPoll);
      watchers.forEach((entry) => entry.close());
      for (const stream of [...jobStreams]) stream.close();
      for (const streams of detailStreams.values()) {
        for (const stream of [...streams]) stream.close();
      }
      await new Promise<void>((resolveClose, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolveClose()));
        httpServer.closeAllConnections();
      });
    },
  };
}
