#!/usr/bin/env node
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import process from "node:process";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";

import type { ContentRegistryRuntimeStatus } from "./model.js";
import { createStartupReporter, type StartupReporter } from "./startup-status.js";

let reportStartup: StartupReporter = () => {};

interface ParsedArgs {
  readonly command: string;
  readonly values: Map<string, string | boolean>;
}

interface ContentRegistryConnection {
  readonly url: string;
  readonly child?: ChildProcess;
}

async function inspectContentRegistry(url: string) {
  const { ContentRegistryClient } = await import("@brainstorm-agentic/registry-client");
  const client = new ContentRegistryClient(url);
  try {
    return await client.resolvePin("brainstorm");
  } finally {
    await client.close().catch(() => undefined);
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (!argument.startsWith("--")) continue;
    const name = argument.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, true);
    }
  }
  return { command, values };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.values.get(name);
  return typeof value === "string" ? value : undefined;
}

function portFlag(args: ParsedArgs, name: string, fallback: number): number {
  const raw = stringFlag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`--${name} must be an integer from 0 to 65535`);
  }
  return value;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function contentRegistryMainPath(override?: string): string {
  if (!override) {
    throw new Error(
      "No content registry configured. Set --content-registry-url (recommended) or --content-registry-main.",
    );
  }
  return expandHome(override);
}

async function spawnContentRegistry(
  host: string,
  port: number,
  status: ContentRegistryRuntimeStatus,
  mainPath?: string,
): Promise<ContentRegistryConnection> {
  const child = spawn(
    process.execPath,
    [
      contentRegistryMainPath(mainPath),
      "--host",
      host,
      "--port",
      String(port),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("content registry did not report its URL within 15 seconds")),
      15_000,
    );
    let buffer = "";
    const finish = (value: string): void => {
      clearTimeout(timeout);
      resolveUrl(value);
    };
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!status.running) {
        clearTimeout(timeout);
        reject(new Error(`content registry exited before startup (code ${String(code)})`));
      }
    });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("CONTENT_REGISTRY_URL=")) {
          finish(line.slice("CONTENT_REGISTRY_URL=".length).trim());
          return;
        }
      }
    });
  });
  status.running = true;
  status.url = url;
  child.once("exit", () => {
    status.running = false;
  });
  const pin = await inspectContentRegistry(url);
  status.skills = pin.manifest.files.filter((file) =>
    file.path.startsWith("skills/") && file.path.endsWith(".md")
  ).length;
  status.workflows = pin.manifest.files.filter((file) =>
    file.path.startsWith("workflows/") && file.path.endsWith(".workflow.json")
  ).length;
  return { child, url };
}

async function connectRemoteContentRegistry(
  url: string,
  status: ContentRegistryRuntimeStatus,
): Promise<ContentRegistryConnection> {
  const pin = await inspectContentRegistry(url);
  status.running = true;
  status.url = url;
  status.skills = pin.manifest.files.filter((file) =>
    file.path.startsWith("skills/") && file.path.endsWith(".md")
  ).length;
  status.workflows = pin.manifest.files.filter((file) =>
    file.path.startsWith("workflows/") && file.path.endsWith(".workflow.json")
  ).length;
  return { url };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => undefined);
    child.unref();
  } catch {
    // Browser launch is best-effort and must not take down the server.
  }
}

function help(): void {
  console.log(
    "Usage: brain launch [--ip 127.0.0.1] [--port 8787] " +
      "[--workspace ~/.brainstorm-agentic] [--attachment-roots /data:/projects] " +
      "[--no-open] [--content-registry-url https://brain.example] " +
      "[--content-registry-port 0] [--content-registry-main /path/to/main.js]",
  );
}

async function main(): Promise<void> {
  // Before the first async filesystem or DNS call: those run on libuv's
  // thread pool, which defaults to 4 threads and is created lazily at first
  // use. The file explorer and attachment ingestion walk shared filesystems
  // asynchronously and in parallel, and on a slow mount 4 threads are gone
  // the moment one walk runs — every other async filesystem caller then
  // queues behind it. 16 keeps concurrent walks and the rest of the server
  // out of each other's way; an operator-set value always wins. Setting it
  // after the pool exists is harmless (it is simply ignored).
  process.env.UV_THREADPOOL_SIZE ??= "16";
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "launch" && !args.values.has("help")) {
    reportStartup = createStartupReporter();
    reportStartup("loading");
  }
  // An unsupported Node must fail with one clear sentence, never as a
  // cryptic dependency crash minutes later. Resolve the package without
  // evaluating its runtime index: this shared guard needs only two tiny files.
  const { assertSupportedNodeVersion } = await import(
    new URL("./util/node-version.js", import.meta.resolve("@brainstorm-agentic/core")).href
  ) as Pick<typeof import("@brainstorm-agentic/core"), "assertSupportedNodeVersion">;
  assertSupportedNodeVersion();
  if (args.command === "desktop-check") {
    console.log("CO_INFERENCE_PROTOCOL=1");
    return;
  }
  if (
    args.command === "help" ||
    args.values.has("help") ||
    args.command === "--help" ||
    args.command === "-h"
  ) {
    help();
    return;
  }
  if (args.command !== "launch") {
    help();
    process.exitCode = 2;
    return;
  }
  // The SSH compatibility probe runs under a short deadline. Loading the
  // server also loads provider SDKs and can take minutes on a cold shared
  // filesystem; only a real launch needs that dependency graph.
  const [
    { configureOutboundHttp },
    { startBrainServer },
    { DEFAULT_CONTENT_REGISTRY_URL },
    { allowsSourceUpdates, readDesktopApiToken },
  ] = await Promise.all([
    import("./proxy.js"),
    import("./server.js"),
    import("./settings.js"),
    import("./desktop-auth.js"),
  ]);
  console.log(`[launch] outbound HTTP: ${configureOutboundHttp()}`);

  const host = stringFlag(args, "ip") ?? "127.0.0.1";
  const apiToken = readDesktopApiToken();
  const port = portFlag(args, "port", 8787);
  const contentRegistryPort = portFlag(args, "content-registry-port", 0);
  const workspace = expandHome(
    stringFlag(args, "workspace") ?? "~/.brainstorm-agentic",
  );
  const attachmentRoots = stringFlag(args, "attachment-roots")
    ?.split(delimiter)
    .map((entry) => expandHome(entry.trim()))
    .filter((entry) => entry.length > 0);
  const contentRegistryStatus: ContentRegistryRuntimeStatus = { running: false };
  const localRegistryMain =
    stringFlag(args, "content-registry-main") ??
    process.env.BRAIN_CONTENT_REGISTRY_MAIN?.trim();
  const configuredRegistryUrl =
    stringFlag(args, "content-registry-url") ??
    process.env.BRAIN_CONTENT_REGISTRY_URL?.trim();
  const remoteContentRegistry =
    configuredRegistryUrl ??
    (localRegistryMain ? undefined : DEFAULT_CONTENT_REGISTRY_URL);
  const spawned: ContentRegistryConnection = remoteContentRegistry
    ? apiToken
      ? { url: remoteContentRegistry }
      : await connectRemoteContentRegistry(remoteContentRegistry, contentRegistryStatus)
    : await spawnContentRegistry(
        "127.0.0.1",
        contentRegistryPort,
        contentRegistryStatus,
        localRegistryMain,
      );
  let running;
  try {
    const pilotPool = stringFlag(args, "slurm-pilot-pool");
    running = await startBrainServer({
      workspace,
      host,
      port,
      apiToken,
      onStartupPhase: reportStartup,
      ...(attachmentRoots && attachmentRoots.length > 0
        ? { attachmentRoots }
        : {}),
      contentRegistryUrl: spawned.url,
      contentRegistryStatus,
      // A shift job cannot rebuild after an in-app update checkout (no
      // wrapper loop follows it), so shifts launch with --no-self-update
      // and releases are applied from the login node by the runway script.
      selfUpdateCheck: !args.values.has("no-self-update") && allowsSourceUpdates(),
      ...(pilotPool !== undefined
        ? { pilotPoolDir: expandHome(pilotPool) }
        : {}),
    });
  } catch (error) {
    spawned.child?.kill("SIGTERM");
    throw error;
  }
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void running.close().finally(() => {
      if (spawned.child && !spawned.child.killed) {
        spawned.child.kill("SIGTERM");
      }
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  // A desktop client can stop us as soon as readiness is published.
  // Install shutdown handlers first so that stop still closes the server.
  reportStartup("ready");
  console.log(`BRAIN_URL=${running.url}`);
  if (!args.values.has("no-open")) openBrowser(running.url);
}

main().catch((error: unknown) => {
  reportStartup("failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
