import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

import {
  ContentRegistryClient,
  ContentRegistryStore,
  isSessionLoss,
  parseContentRegistryManifest,
  readContentPin,
  writeContentPin,
  type ContentRegistryPin,
} from "../src/index.js";

const brainRepoRoot = fileURLToPath(new URL("../../../../../brain/", import.meta.url));

/** The published version these tests pin; immutable, so it never drifts. */
const FIXTURE_VERSION = "0.1.0";

function materializedVersionDir(version: string): string {
  execFileSync(
    process.execPath,
    [join(brainRepoRoot, "scripts", "materialize-store.mjs"), "--quiet"],
    { stdio: "inherit" },
  );
  return `${join(brainRepoRoot, ".registry-store", "bundles", "brainstorm", version)}/`;
}

/**
 * Deliberately NOT overridable through BRAIN_TEST_CONTENT_DIR, unlike the
 * content and runtime suites. Those load a bundle, so the editable source tree
 * works for them; this suite verifies that the client fetches files and checks
 * them against a manifest, and only a *published* version has one — the source
 * tree carries no manifest.json by design, because manifests are generated
 * from immutable tags.
 */
const versionRoot = materializedVersionDir(FIXTURE_VERSION);

function fixturePin(): ContentRegistryPin {
  const manifest = parseContentRegistryManifest(
    JSON.parse(readFileSync(join(versionRoot, "manifest.json"), "utf8")),
    "brainstorm",
    FIXTURE_VERSION,
  );
  return {
    registryUrl: "https://registry.test/mcp",
    bundle: manifest.bundle,
    version: manifest.version,
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    manifest,
  };
}

test("a declared app floor rides the manifest; a malformed one is refused", () => {
  const raw = JSON.parse(
    readFileSync(join(versionRoot, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;

  // Published bundles predate the field, so its absence must stay legal —
  // the floor only binds hosts once a publisher declares one.
  assert.equal(
    parseContentRegistryManifest({ ...raw }, "brainstorm", FIXTURE_VERSION).minAppVersion,
    undefined,
  );

  assert.equal(
    parseContentRegistryManifest(
      { ...raw, minAppVersion: "0.2.46" },
      "brainstorm",
      FIXTURE_VERSION,
    ).minAppVersion,
    "0.2.46",
  );

  // A floor nobody can compare against is worse than none: it would parse,
  // ride into the pin, and quietly never turn anything away.
  assert.throws(
    () =>
      parseContentRegistryManifest(
        { ...raw, minAppVersion: "0.2" },
        "brainstorm",
        FIXTURE_VERSION,
      ),
    /minAppVersion must be a plain semver/,
  );
});

test("pin roundtrip rejects modified manifest metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "registry-pin-"));
  const path = join(root, "pin.json");
  try {
    writeContentPin(path, fixturePin());
    assert.equal(readContentPin(path).version, FIXTURE_VERSION);
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.manifest.version = "9.9.9";
    writeFileSync(path, JSON.stringify(tampered));
    assert.throws(() => readContentPin(path), /manifest hash is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store fetches one exact file, verifies it, deduplicates, and writes nothing to disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "registry-store-"));
  const pin = fixturePin();
  let reads = 0;
  const fake = {
    async readText(path: string): Promise<string> {
      reads += 1;
      const relative = path.replace(
        `bundles/${pin.bundle}/${pin.version}/`,
        "",
      );
      return readFileSync(join(versionRoot, relative), "utf8");
    },
  } as ContentRegistryClient;
  try {
    const store = new ContentRegistryStore(pin, fake);
    const [first, second] = await Promise.all([
      store.ensure("skills/roles/processor.md"),
      store.ensure("skills/roles/processor.md"),
    ]);
    assert.equal(first, second);
    assert.equal(reads, 1, "concurrent requests for one file share a single fetch");
    const again = await store.ensure("skills/roles/processor.md");
    assert.equal(reads, 1, "an already-loaded document is not re-fetched");

    // ensure() yields the document itself, not a path.
    assert.ok(again.includes("name: processor"), "the fetched role text is returned");
    assert.equal(store.loaded().get("skills/roles/processor.md"), again);

    // The point of the store: content is an input, never a copy left behind.
    assert.deepEqual(readdirSync(root), [], "nothing is written to disk");

    assert.equal(store.rolePath("judge"), "skills/roles/judge.md");
    assert.equal(
      store.techniquePath("deep-understanding"),
      "skills/techniques/deep-understanding.md",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry rate limits are waited out, not fatal", async (t) => {
  await t.test("a 429 retries after the declared window and then succeeds", async () => {
    const { withRegistryRateLimitRetry } = await import("../src/index.js");
    const sleeps: number[] = [];
    let calls = 0;
    const narrated: string[] = [];
    const value = await withRegistryRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("Error POSTing to endpoint (HTTP 429): rate limit exceeded");
        }
        return "pinned";
      },
      {
        waitMs: 5,
        sleep: async (ms) => { sleeps.push(ms); },
        onWait: (waitMs, attempt, retries) => {
          narrated.push(`${waitMs}:${attempt}/${retries}`);
        },
      },
    );
    assert.equal(value, "pinned");
    assert.deepEqual(sleeps, [5]);
    // The minute-scale sleep announces itself instead of passing as a hang.
    assert.deepEqual(narrated, ["5:1/2"]);
  });

  await t.test("a non-rate-limit failure is rethrown immediately", async () => {
    const { withRegistryRateLimitRetry } = await import("../src/index.js");
    let calls = 0;
    await assert.rejects(
      withRegistryRateLimitRetry(
        async () => {
          calls += 1;
          throw new Error("manifest does not list \"skills/roles/ghost.md\"");
        },
        { sleep: async () => {} },
      ),
      /does not list/,
    );
    assert.equal(calls, 1);
  });

  await t.test("the retry budget is bounded", async () => {
    const { withRegistryRateLimitRetry } = await import("../src/index.js");
    let calls = 0;
    await assert.rejects(
      withRegistryRateLimitRetry(
        async () => {
          calls += 1;
          throw new Error("rate limit exceeded");
        },
        { retries: 2, waitMs: 1, sleep: async () => {} },
      ),
      /rate limit/,
    );
    assert.equal(calls, 3);
  });

  await t.test("the server-declared window paces the retry", async () => {
    const { withRegistryRateLimitRetry } = await import("../src/index.js");
    const sleeps: number[] = [];
    let lookups = 0;
    let calls = 0;
    const value = await withRegistryRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("HTTP 429");
        return "pinned";
      },
      {
        declaredWaitMs: async () => {
          lookups += 1;
          return 250;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(value, "pinned");
    assert.deepEqual(sleeps, [250]);
    assert.equal(lookups, 1, "the declaration is consulted only when a wait is due");
  });

  await t.test("an explicit waitMs overrides the declared window", async () => {
    const { withRegistryRateLimitRetry } = await import("../src/index.js");
    const sleeps: number[] = [];
    let lookups = 0;
    let calls = 0;
    await withRegistryRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("HTTP 429");
        return "pinned";
      },
      {
        waitMs: 7,
        declaredWaitMs: async () => {
          lookups += 1;
          return 250;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.deepEqual(sleeps, [7]);
    assert.equal(lookups, 0);
  });
});

test("declaredRegistryWindowMs reads /health and tolerates registries that declare nothing", async () => {
  const { declaredRegistryWindowMs } = await import("../src/index.js");
  const { createServer } = await import("node:http");

  let body = JSON.stringify({ ok: true, rateLimit: { requestsPerMinute: 300, windowMs: 45_000 } });
  let status = 200;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/health");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    // A declaring registry: the window comes back as declared.
    assert.equal(await declaredRegistryWindowMs(url), 45_000);

    // An older registry without the field: undefined, caller falls back.
    body = JSON.stringify({ ok: true, files: 12 });
    assert.equal(await declaredRegistryWindowMs(url), undefined);

    // A malformed declaration: undefined, never NaN or a negative wait.
    body = JSON.stringify({ ok: true, rateLimit: { windowMs: "soon" } });
    assert.equal(await declaredRegistryWindowMs(url), undefined);

    // A failing health route: undefined.
    status = 503;
    assert.equal(await declaredRegistryWindowMs(url), undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // An unreachable host: undefined, not a thrown error.
  assert.equal(
    await declaredRegistryWindowMs(`http://127.0.0.1:${port}/mcp`),
    undefined,
  );
});

/**
 * A minimal Streamable-HTTP MCP registry whose sessions can be FORGOTTEN on
 * demand — exactly what the real registry does to sessions idle for 30
 * minutes (and to every session on a restart), answering later requests
 * with the same 404 body ("session not found") the incident carried.
 */
async function startForgetfulRegistry(): Promise<{
  readonly url: string;
  readonly initializeCount: () => number;
  forgetSessions(): void;
  close(): Promise<void>;
}> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let initializes = 0;
  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (req.method === "GET" || req.method === "DELETE") {
        resolve(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length === 0) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      req.on("error", reject);
    });
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      const known = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (known) {
        await known.handleRequest(req, res, await readBody(req));
        return;
      }
      if (sessionId !== undefined) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("session not found");
        return;
      }
      const body = await readBody(req);
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(400);
        res.end("a new session must start with initialize");
        return;
      }
      initializes += 1;
      const mcp = new McpServer(
        { name: "forgetful-registry", version: "0.0.1" },
        { capabilities: { resources: {} } },
      );
      mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
          { uri: "brain://file/hello.md", name: "hello.md", mimeType: "text/markdown" },
        ],
      }));
      mcp.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
        contents: [
          { uri: request.params.uri, mimeType: "text/markdown", text: "hello" },
        ],
      }));
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("error");
      } else {
        res.end();
      }
    }
  };
  const httpServer = createHttpServer((req, res) => {
    void handle(req, res);
  });
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    initializeCount: () => initializes,
    forgetSessions: () => sessions.clear(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test("a read after the registry forgot the session reconnects instead of failing", async () => {
  const registry = await startForgetfulRegistry();
  const client = new ContentRegistryClient(registry.url);
  try {
    assert.equal(await client.readText("hello.md"), "hello");
    assert.equal(registry.initializeCount(), 1);

    // The idle reap (or a registry restart): every session is forgotten.
    // The next read used to surface "failed to read Brain Registry resource
    // …: session not found" and sink the run at its first lazy skill fetch
    // after a long quiet stage; it must instead reconnect once and succeed.
    registry.forgetSessions();
    assert.equal(await client.readText("hello.md"), "hello");
    assert.equal(registry.initializeCount(), 2, "exactly one reconnect");

    // The refreshed session keeps serving without further reconnects.
    assert.equal(await client.readText("hello.md"), "hello");
    assert.equal(registry.initializeCount(), 2);
  } finally {
    await client.close().catch(() => undefined);
    await registry.close();
  }
});

test("isSessionLoss recognizes every healable session/transport failure", () => {
  // The exact string of the overnight incident: the idle HTTP connection
  // died under the session and the SDK reported a transport-level close.
  // The old matcher missed it, so the client stayed a zombie and every
  // later skill fetch failed identically for hours.
  assert.equal(isSessionLoss(new Error("MCP error -32000: Connection closed")), true);
  assert.equal(isSessionLoss(new Error("session not found")), true);
  assert.equal(isSessionLoss(new Error("Not connected")), true);
  // Real refusals must NOT trigger reconnects.
  assert.equal(isSessionLoss(new Error('unknown static file "nope.md"')), false);
  assert.equal(isSessionLoss(new Error("rate limit exceeded (429)")), false);
});
