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
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
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

// ---------------------------------------------------------------------------
// Taxonomy tools: the same three tools the real Brain Registry serves, backed
// by the latest bundle's seed catalog served by this double. Exact name/alias
// resolution only — enough for the offline pipeline's deterministic matching,
// placement, and suggestion submission to run end to end in tests.
// ---------------------------------------------------------------------------

interface SeedNode {
  readonly id: string;
  readonly level: "domain" | "field" | "subfield" | "topic";
  readonly name: string;
  readonly parent?: string;
  readonly aliases?: readonly string[];
}

interface TestTaxonomy {
  readonly byKey: ReadonlyMap<string, { node: SeedNode; matchedOn: "name" | "alias" }>;
  readonly byId: ReadonlyMap<string, SeedNode>;
  readonly children: ReadonlyMap<string, readonly SeedNode[]>;
  readonly domains: readonly SeedNode[];
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function loadTestTaxonomy(files: ReadonlyMap<string, string>): TestTaxonomy | null {
  const index = files.get("index.json");
  if (!index) return null;
  const latest = (JSON.parse(index) as {
    bundles: Array<{ id: string; latest: string }>;
  }).bundles.find((bundle) => bundle.id === "brainstorm")?.latest;
  const seedText = latest && files.get(`bundles/brainstorm/${latest}/catalog/taxonomy.json`);
  if (!seedText) return null;
  const nodes = (JSON.parse(seedText) as { nodes: SeedNode[] }).nodes;
  const byKey = new Map<string, { node: SeedNode; matchedOn: "name" | "alias" }>();
  const byId = new Map<string, SeedNode>();
  const children = new Map<string, SeedNode[]>();
  const domains: SeedNode[] = [];
  for (const node of nodes) {
    byId.set(node.id, node);
    byKey.set(normalizeName(node.name), { node, matchedOn: "name" });
    for (const alias of node.aliases ?? []) {
      const key = normalizeName(alias);
      if (!byKey.has(key)) byKey.set(key, { node, matchedOn: "alias" });
    }
    if (node.parent) {
      const siblings = children.get(node.parent);
      if (siblings) siblings.push(node);
      else children.set(node.parent, [node]);
    } else if (node.level === "domain") {
      domains.push(node);
    }
  }
  return { byKey, byId, children, domains };
}

function taxonomyPosition(taxonomy: TestTaxonomy, node: SeedNode, matchedOn: "name" | "alias") {
  const chain: SeedNode[] = [];
  let cursor: SeedNode | undefined = node;
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parent ? taxonomy.byId.get(cursor.parent) : undefined;
  }
  const named = (level: SeedNode["level"]) => chain.find((entry) => entry.level === level)?.name;
  return {
    id: node.id,
    name: node.name,
    level: node.level,
    path: chain.map((entry) => entry.name),
    ...(named("domain") ? { domain: named("domain") } : {}),
    ...(named("field") ? { field: named("field") } : {}),
    ...(named("subfield") ? { subfield: named("subfield") } : {}),
    ...(named("topic") ? { topic: named("topic") } : {}),
    matchedOn,
  };
}

function taxonomyToolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function protocolServer(
  files: ReadonlyMap<string, string>,
  taxonomy: TestTaxonomy | null,
): Server {
  const server = new Server(
    { name: "brain-test-registry", version: "0.1.0" },
    { capabilities: { resources: {}, ...(taxonomy ? { tools: {} } : {}) } },
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

  if (taxonomy) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "taxonomy_resolve",
          description: "Resolve one query against the test taxonomy (exact name/alias).",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" }, optionLimit: { type: "integer" } },
            required: ["query"],
          },
        },
        {
          name: "taxonomy_tree",
          description: "Names-only outline of the test taxonomy.",
          inputSchema: { type: "object", properties: { root: { type: "string" } } },
        },
        {
          name: "taxonomy_suggest",
          description: "Accept one suggestion batch and return a receipt (nothing persists).",
          inputSchema: {
            type: "object",
            properties: { entries: { type: "array" }, submittedBy: { type: "string" } },
            required: ["entries"],
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      switch (request.params.name) {
        case "taxonomy_resolve": {
          const query = String(args.query ?? "");
          const hit = taxonomy.byKey.get(normalizeName(query));
          if (hit) {
            return taxonomyToolResult({
              query,
              found: true,
              revision: 1,
              position: taxonomyPosition(taxonomy, hit.node, hit.matchedOn),
            });
          }
          return taxonomyToolResult({
            query,
            found: false,
            status: "NA",
            revision: 1,
            beta: normalizeName(query).split(" ").filter(Boolean),
            options: [],
            total: 0,
          });
        }
        case "taxonomy_tree": {
          const lines: string[] = [];
          let count = 0;
          const walk = (node: SeedNode, depth: number): void => {
            lines.push(`${"  ".repeat(depth)}${node.name}`);
            count += 1;
            for (const child of taxonomy.children.get(node.id) ?? []) walk(child, depth + 1);
          };
          const rootArg = typeof args.root === "string" ? args.root : undefined;
          const root = rootArg ? taxonomy.byKey.get(normalizeName(rootArg))?.node : undefined;
          if (root) walk(root, 0);
          else for (const domain of taxonomy.domains) walk(domain, 0);
          return taxonomyToolResult({ revision: 1, nodeCount: count, outline: lines.join("\n") });
        }
        case "taxonomy_suggest": {
          const entries = Array.isArray(args.entries) ? args.entries : [];
          const receivedAt = new Date().toISOString();
          const user = typeof args.submittedBy === "string" && args.submittedBy !== ""
            ? args.submittedBy.replace(/[^A-Za-z0-9._-]+/g, "-")
            : "anonymous";
          return taxonomyToolResult({
            id: randomUUID(),
            receivedAt,
            revision: 1,
            queued: entries.length,
            file: `${receivedAt.replace(/[:.]/g, "-")}-${user}.json`,
          });
        }
        default:
          throw new Error(`unknown test tool "${request.params.name}"`);
      }
    });
  }

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
  const taxonomy = loadTestTaxonomy(files);
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
    const server = protocolServer(files, taxonomy);
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
