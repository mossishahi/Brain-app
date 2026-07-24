#!/usr/bin/env node
/**
 * Brainstorm worker process (also exposed through a compatibility CLI alias).
 *
 *   brainstorm-agentic run --topic "..." [--attachments-manifest path] [--offline] [--auto-approve] [--run-id id]
 *   brainstorm-agentic resume --run-id id [--offline] [--gate key=action[:memberId,...]]
 *   brainstorm-agentic list
 *
 * Sessions live under BRAINSTORM_AGENTIC_SESSION_ROOT
 * (default ~/.brainstorm-agentic/workspace/sessions), one directory per run.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { loadContent } from "@brainstorm-agentic/content";
import type { JsonValue, RunEvent, RunEventListener, RunResult } from "@brainstorm-agentic/core";

import { defaultSessionRoot, loadDotEnv } from "./env.js";
import { FsArtifactStore, FsCheckpointStore } from "./fs-stores.js";
import { buildRuntime, providerConfigFromEnv } from "./wiring.js";

interface CliArgs {
  readonly command: string;
  readonly flags: Map<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function stringFlag(args: CliArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `bsa_${stamp}_${randomUUID().slice(0, 8)}`;
}

interface AttachmentsManifestFile {
  readonly baseDir: string;
  readonly attachments: readonly JsonValue[];
}

/** Loads the server-ingested attachment manifest referenced by --attachments-manifest. */
function loadAttachmentsManifest(
  path: string | undefined,
): AttachmentsManifestFile | undefined {
  if (path === undefined) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    readonly baseDir?: unknown;
    readonly attachments?: unknown;
  };
  if (typeof parsed.baseDir !== "string" || !Array.isArray(parsed.attachments)) {
    throw new Error(`attachments manifest "${path}" is malformed`);
  }
  return {
    baseDir: parsed.baseDir,
    attachments: parsed.attachments as readonly JsonValue[],
  };
}

function logEvent(event: RunEvent): void {
  switch (event.type) {
    case "run:started":
      console.log(`[run] started (resumed=${event.resumed})`);
      break;
    case "agent:started":
      console.log(`[agent] ${event.taskKind} started at ${event.path}`);
      break;
    case "agent:completed":
      console.log(`[agent] ${event.taskKind} ${event.status} at ${event.path}`);
      break;
    case "gate:pending":
      console.log(`[gate] pending: ${event.gateKey}`);
      break;
    case "gate:resolved":
      console.log(`[gate] resolved: ${event.gateKey}`);
      break;
    case "run:suspended":
      console.log(`[run] suspended on ${event.pendingGates.map((gate) => gate.gateKey).join(", ")}`);
      break;
    case "run:completed":
      console.log("[run] completed");
      break;
    case "run:failed":
      console.log(`[run] failed: ${event.error.message}`);
      break;
    default:
      break;
  }
}

function eventListener(verbose: boolean, eventsFile: string | undefined): RunEventListener | undefined {
  if (!verbose && eventsFile === undefined) return undefined;
  if (eventsFile !== undefined) mkdirSync(dirname(eventsFile), { recursive: true });
  return (event) => {
    if (verbose) logEvent(event);
    if (eventsFile !== undefined) appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, "utf8");
  };
}

function reportResult(result: RunResult, sessionRoot: string): void {
  console.log("");
  if (result.status === "completed") {
    console.log(`Run ${result.runId} completed.`);
    console.log(`Session directory: ${join(sessionRoot, result.runId)}`);
    console.log("Final proposal JSON:");
    console.log(JSON.stringify(result.output, null, 2));
    return;
  }
  if (result.status === "suspended") {
    console.log(`Run ${result.runId} is waiting on human input:`);
    for (const gate of result.pendingGates) {
      console.log(`  gate "${gate.gateKey}"${gate.prompt ? ` — ${gate.prompt}` : ""}`);
    }
    console.log("");
    console.log("Answer with:");
    console.log(`  brainstorm-agentic resume --run-id ${result.runId} --gate <gateKey>=approve`);
    console.log(`  brainstorm-agentic resume --run-id ${result.runId} --gate <gateKey>=shrink:member-1,member-2`);
    return;
  }
  if (result.status === "credit_blocked") {
    console.log(`Run ${result.runId} is credit blocked.`);
    console.log(`Provider message: ${result.providerMessage}`);
    console.log(`Automatic resume time: ${new Date(result.retryAt).toISOString()}`);
    console.log("The brain server will resume it automatically unless it is cancelled.");
    return;
  }
  if (result.status === "failed") {
    console.error(`Run ${result.runId} failed: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Run ${result.runId} cancelled.`);
}

/** Parses --gate key=action[:id1,id2] into the runtime's gate response shape. */
function parseGateFlag(raw: string): { gateKey: string; response: JsonValue } {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new Error(`--gate must look like key=action, got "${raw}"`);
  const gateKey = raw.slice(0, eq);
  const actionSpec = raw.slice(eq + 1);
  const colon = actionSpec.indexOf(":");
  if (colon < 0) return { gateKey, response: { action: actionSpec } };
  const action = actionSpec.slice(0, colon);
  const members = actionSpec
    .slice(colon + 1)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return { gateKey, response: { action, members } };
}

async function main(): Promise<void> {
  loadDotEnv(process.cwd());
  const args = parseArgs(process.argv.slice(2));
  const sessionRoot = stringFlag(args, "session-root") ?? defaultSessionRoot();
  const offline = args.flags.get("offline") === true;
  const autoApprove = args.flags.get("auto-approve") === true;
  const verbose = args.flags.get("verbose") === true;
  const eventsFile = stringFlag(args, "events-file");
  const contentDir = stringFlag(args, "content-dir");
  const onEvent = eventListener(verbose, eventsFile);

  if (args.command === "list") {
    const store = new FsCheckpointStore(sessionRoot);
    for (const runId of store.listRunIds()) {
      const checkpoint = await store.load(runId);
      console.log(`${runId}  ${checkpoint?.status ?? "unknown"}  (workflow ${checkpoint?.workflowId ?? "?"})`);
    }
    return;
  }
  if (
    (args.command === "run" || args.command === "resume") &&
    contentDir === undefined
  ) {
    throw new Error(
      "--content-dir is required; content must be fetched and pinned by the host",
    );
  }

  if (args.command === "run") {
    const topic = stringFlag(args, "topic");
    if (!topic) {
      console.error('run needs --topic "your research question"');
      process.exitCode = 2;
      return;
    }
    const manifest = loadAttachmentsManifest(
      stringFlag(args, "attachments-manifest"),
    );
    const runId = stringFlag(args, "run-id") ?? newRunId();
    mkdirSync(join(sessionRoot, runId), { recursive: true });
    const runtime = buildRuntime({
      providerConfig: providerConfigFromEnv(process.env, offline),
      checkpoints: new FsCheckpointStore(sessionRoot),
      artifacts: new FsArtifactStore(sessionRoot, runId),
      autoApproveGates: autoApprove,
      ...(manifest ? { attachmentRoots: [manifest.baseDir] } : {}),
      bundle: loadContent(contentDir!),
      ...(onEvent !== undefined ? { onEvent } : {}),
    });
    if (!verbose) runtime; // stores/events optional
    const result = await runtime.run({
      runId,
      submission: {
        prompt: topic,
        attachments: (manifest?.attachments ?? []) as unknown as JsonValue,
      },
    });
    reportResult(result, sessionRoot);
    return;
  }

  if (args.command === "resume") {
    const runId = stringFlag(args, "run-id");
    if (!runId) {
      console.error("resume needs --run-id");
      process.exitCode = 2;
      return;
    }
    const responses: Record<string, JsonValue> = {};
    const gateFlag = stringFlag(args, "gate");
    if (gateFlag) {
      const { gateKey, response } = parseGateFlag(gateFlag);
      responses[gateKey] = response;
    }
    const runtime = buildRuntime({
      providerConfig: providerConfigFromEnv(process.env, offline),
      checkpoints: new FsCheckpointStore(sessionRoot),
      artifacts: new FsArtifactStore(sessionRoot, runId),
      autoApproveGates: autoApprove,
      bundle: loadContent(contentDir!),
      ...(onEvent !== undefined ? { onEvent } : {}),
    });
    const result = await runtime.resume(runId, {
      ...(Object.keys(responses).length > 0 ? { responses } : {}),
    });
    reportResult(result, sessionRoot);
    return;
  }

  console.log("Usage:");
  console.log(
    '  brainstorm-agentic run --topic "..." --content-dir <pinned-dir> [--offline] [--auto-approve] [--events-file <path>] [--verbose]',
  );
  console.log(
    "  brainstorm-agentic resume --run-id <id> --content-dir <pinned-dir> [--gate key=action[:memberId,...]] [--events-file <path>]",
  );
  console.log("  brainstorm-agentic list");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
