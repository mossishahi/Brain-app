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
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { scoreExpertiseTree } from "@brainstorm-agentic/brainstorm-runtime";
import { loadContent } from "@brainstorm-agentic/content";
import type {
  ArtifactStore,
  JsonValue,
  RunEvent,
  RunEventListener,
  RunResult,
} from "@brainstorm-agentic/core";

import { defaultSessionRoot, loadDotEnv } from "./env.js";
import { FsArtifactStore, FsCheckpointStore } from "./fs-stores.js";
import { buildRuntime, providerConfigFromEnv } from "./wiring.js";
import { openLazyRegistryContent } from "./registry-content.js";

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

/**
 * Writes the run's expertise trees beside `checkpoint.json`:
 *
 * - `raw_expertise.json` — the validated tree exactly as stored (counts per
 *   department, umbrella, and subfield);
 * - `mul_expertise.json` — the same tree with every subfield leaf scored by
 *   the product of its own count and its parents' counts (i × j × k), which is
 *   the ranking panel selection seats from.
 *
 * The artifact store keys every payload by an opaque id, so the tree is
 * otherwise reachable only by looking its id up in `artifacts/index.json`.
 * These are readable copies; the artifact and the checkpoint journal remain
 * the authoritative records. When the node ran more than once (a retry or a
 * credit-block resume) the latest version wins.
 */
async function writeExpertiseTrees(
  artifacts: ArtifactStore,
  sessionRoot: string,
  runId: string,
): Promise<readonly string[]> {
  const ref = [...(await artifacts.list())]
    .reverse()
    .find((candidate) => candidate.metadata?.schema === "experts");
  if (!ref) return [];
  const stored = await artifacts.get(ref.id);
  if (!stored) return [];

  const writeAtomic = (name: string, body: string): string => {
    const path = join(sessionRoot, runId, name);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
    return path;
  };

  let tree: unknown;
  try {
    tree = JSON.parse(stored.data);
  } catch {
    // A payload that does not parse is still worth copying verbatim.
    return [writeAtomic("raw_expertise.json", stored.data)];
  }
  const written = [
    writeAtomic("raw_expertise.json", `${JSON.stringify(tree, null, 2)}\n`),
  ];
  try {
    const scored = scoreExpertiseTree(tree as Parameters<typeof scoreExpertiseTree>[0]);
    written.push(
      writeAtomic("mul_expertise.json", `${JSON.stringify(scored, null, 2)}\n`),
    );
  } catch {
    // A pre-count tree (an old run resumed under new code) has no scores.
  }
  return written;
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
  const contentRegistryUrl =
    stringFlag(args, "content-registry-url") ??
    process.env.BRAIN_CONTENT_REGISTRY_URL?.trim();
  const contentRegistryVersion = stringFlag(args, "content-registry-version");
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
    const lazy = contentRegistryUrl
      ? await openLazyRegistryContent({
          registryUrl: contentRegistryUrl,
          contentDir: contentDir!,
          resume: false,
          ...(contentRegistryVersion
            ? { version: contentRegistryVersion }
            : {}),
        })
      : undefined;
    const artifacts = new FsArtifactStore(sessionRoot, runId);
    const runtime = buildRuntime({
      providerConfig: providerConfigFromEnv(process.env, offline),
      checkpoints: new FsCheckpointStore(sessionRoot),
      artifacts,
      autoApproveGates: autoApprove,
      ...(manifest ? { attachmentRoots: [manifest.baseDir] } : {}),
      bundle: lazy?.bundle ?? loadContent(contentDir!),
      ...(lazy ? { skillResolver: lazy.skillResolver } : {}),
      ...(onEvent !== undefined ? { onEvent } : {}),
    });
    try {
      const result = await runtime.run({
        runId,
        submission: {
          prompt: topic,
          attachments: (manifest?.attachments ?? []) as unknown as JsonValue,
        },
      });
      const trees = await writeExpertiseTrees(artifacts, sessionRoot, runId);
      reportResult(result, sessionRoot);
      for (const tree of trees) console.log(`Expertise tree: ${tree}`);
    } finally {
      await lazy?.close();
    }
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
    const lazy = contentRegistryUrl
      ? await openLazyRegistryContent({
          registryUrl: contentRegistryUrl,
          contentDir: contentDir!,
          resume: true,
        })
      : undefined;
    // A resume that carries an explicit gate answer must compile the gate as a
    // real (manual) gate: in auto-approve mode the gate becomes an auto-approve
    // activity that never reads the answer, silently discarding e.g. a panel
    // shrink. The run only suspends on gates in manual mode anyway, so a
    // gate-answering resume is by definition a manual-mode continuation.
    const resumeAutoApprove = autoApprove && Object.keys(responses).length === 0;
    const artifacts = new FsArtifactStore(sessionRoot, runId);
    const runtime = buildRuntime({
      providerConfig: providerConfigFromEnv(process.env, offline),
      checkpoints: new FsCheckpointStore(sessionRoot),
      artifacts,
      autoApproveGates: resumeAutoApprove,
      bundle: lazy?.bundle ?? loadContent(contentDir!),
      ...(lazy ? { skillResolver: lazy.skillResolver } : {}),
      ...(onEvent !== undefined ? { onEvent } : {}),
    });
    try {
      const result = await runtime.resume(runId, {
        ...(Object.keys(responses).length > 0 ? { responses } : {}),
      });
      const trees = await writeExpertiseTrees(artifacts, sessionRoot, runId);
      reportResult(result, sessionRoot);
      for (const tree of trees) console.log(`Expertise tree: ${tree}`);
    } finally {
      await lazy?.close();
    }
    return;
  }

  console.log("Usage:");
  console.log(
    '  brain-worker run --topic "..." --content-dir <cache-dir> [--content-registry-url <mcp-url>] [--offline] [--auto-approve] [--events-file <path>] [--verbose]',
  );
  console.log(
    "  brain-worker resume --run-id <id> --content-dir <cache-dir> [--content-registry-url <mcp-url>] [--gate key=action[:memberId,...]] [--events-file <path>]",
  );
  console.log("  brainstorm-agentic list");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
