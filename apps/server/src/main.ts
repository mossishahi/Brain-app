#!/usr/bin/env node
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import process from "node:process";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";

import type { ContentRegistryRuntimeStatus } from "./model.js";
import { startBrainServer } from "./server.js";
import { ContentRegistryClient } from "@brainstorm-agentic/registry-client";

interface ParsedArgs {
  readonly command: string;
  readonly values: Map<string, string | boolean>;
}

interface ContentRegistryConnection {
  readonly url: string;
  readonly child?: ChildProcess;
}

async function inspectContentRegistry(url: string) {
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
  const args = parseArgs(process.argv.slice(2));
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

  const host = stringFlag(args, "ip") ?? "127.0.0.1";
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
  const remoteContentRegistry =
    stringFlag(args, "content-registry-url") ??
    process.env.BRAIN_CONTENT_REGISTRY_URL?.trim();
  const spawned = remoteContentRegistry
    ? await connectRemoteContentRegistry(remoteContentRegistry, contentRegistryStatus)
    : await spawnContentRegistry(
        "127.0.0.1",
        contentRegistryPort,
        contentRegistryStatus,
        stringFlag(args, "content-registry-main") ??
          process.env.BRAIN_CONTENT_REGISTRY_MAIN?.trim(),
      );
  let running;
  try {
    running = await startBrainServer({
      workspace,
      host,
      port,
      ...(attachmentRoots && attachmentRoots.length > 0
        ? { attachmentRoots }
        : {}),
      contentRegistryUrl: spawned.url,
      contentRegistryStatus,
    });
  } catch (error) {
    spawned.child?.kill("SIGTERM");
    throw error;
  }
  console.log(`BRAIN_URL=${running.url}`);
  if (!args.values.has("no-open")) openBrowser(running.url);

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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
