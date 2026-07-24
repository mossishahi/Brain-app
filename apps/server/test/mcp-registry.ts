import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

function filesBelow(root: string, current = root): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      for (const item of filesBelow(root, absolute)) files.set(...item);
    } else if (entry.isFile()) {
      files.set(
        relative(root, absolute).split(sep).join("/"),
        readFileSync(absolute, "utf8"),
      );
    }
  }
  return files;
}

function pathFromUri(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== "brain:" || parsed.hostname !== "file") {
    throw new Error("unsupported registry resource URI");
  }
  return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
}

function protocolServer(files: ReadonlyMap<string, string>): Server {
  const server = new Server(
    { name: "brain-test-registry", version: "0.1.0" },
    { capabilities: { resources: {} } },
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [...files.keys()].map((path) => ({
      uri: `brain://file/${path}`,
      name: path,
      mimeType: path.endsWith(".json")
        ? "application/json"
        : "text/markdown",
    })),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const path = pathFromUri(request.params.uri);
    const text = files.get(path);
    if (text === undefined) throw new Error(`missing test resource "${path}"`);
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: path.endsWith(".json")
          ? "application/json"
          : "text/markdown",
        text,
      }],
    };
  });
  return server;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolveBody(raw.length === 0 ? undefined : JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export async function startTestRegistry(root: string): Promise<{
  readonly url: string;
  readonly httpServer: HttpServer;
  close(): Promise<void>;
}> {
  const files = filesBelow(root);
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/")) {
      const path = url.pathname === "/v1/index.json"
        ? "index.json"
        : decodeURIComponent(url.pathname.slice(4));
      const text = files.get(path);
      if (text === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "content-type": path.endsWith(".json")
          ? "application/json"
          : "text/markdown",
      });
      res.end(text);
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const known =
      typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (known) {
      await known.transport.handleRequest(req, res, await readBody(req));
      return;
    }
    const body = await readBody(req);
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      res.writeHead(400).end();
      return;
    }
    const server = protocolServer(files);
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60_000;
  httpServer.keepAliveTimeout = 120_000;
  const port = await new Promise<number>((resolvePort, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      const address = httpServer.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    httpServer,
    close: async () => {
      await Promise.allSettled(
        [...sessions.values()].map(({ server }) => server.close()),
      );
      await new Promise<void>((resolveClose, reject) => {
        httpServer.close((error) => error ? reject(error) : resolveClose());
        httpServer.closeAllConnections();
      });
    },
  };
}
