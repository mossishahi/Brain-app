#!/usr/bin/env node
/**
 * Brainstorm worker process (also exposed through a compatibility CLI alias).
 *
 *   brainstorm-agentic run --topic "..." [--attachments-manifest path] [--offline] [--auto-approve] [--run-id id]
 *   brainstorm-agentic resume --run-id id [--offline] [--gate key=action[:memberId,...]] [--gate-json '{"gateKey":...,"action":...,"addedMembers":[...]}']
 *   brainstorm-agentic list
 *
 * Sessions live under BRAINSTORM_AGENTIC_SESSION_ROOT
 * (default ~/.brainstorm-agentic/workspace/sessions), one directory per run.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { scoreExpertiseTree } from "@brainstorm-agentic/brainstorm-runtime";
import { loadContent } from "@brainstorm-agentic/content";
import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
  RunEvent,
  RunEventListener,
  RunResult,
  TaxonomyAccess,
} from "@brainstorm-agentic/core";

import {
  prepareCodeWorkspace,
  type CodeRuntimeEnvironment,
} from "@brainstorm-agentic/host-tools";

import { defaultSessionRoot, loadDotEnv } from "./env.js";
import { FsArtifactStore, FsCheckpointStore } from "./fs-stores.js";
import {
  deriveRunSummary,
  installId,
  TelemetrySpool,
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryEvent,
} from "@brainstorm-agentic/telemetry";
import {
  buildRuntime,
  modelsByRouteFromEnv,
  providerConfigFromEnv,
} from "./wiring.js";
import { openLazyRegistryContent, type LazyRegistryContent } from "./registry-content.js";
import {
  LocalTaxonomyService,
  PinnedTaxonomyService,
  RegistryTaxonomyService,
  localTaxonomySeedPath,
} from "./taxonomy-service.js";

/**
 * Shared-taxonomy access for a run. Reads always resolve against the taxonomy
 * the run PINNED (a control input of the bundle), so panel assembly costs no
 * network round trips and is reproducible across runs. When the run is
 * connected to the registry, suggestions are submitted to the live shared
 * store; otherwise they are recorded per-run on disk.
 * Absent only for pre-taxonomy bundles that carry no seed.
 */
function taxonomyForRun(
  lazy: LazyRegistryContent | undefined,
  contentDir: string,
  sessionRoot: string,
  runId: string,
): TaxonomyAccess | undefined {
  // Registry runs carry the pinned taxonomy in memory with the rest of the
  // bundle; local runs read the seed from the content directory.
  if (lazy) {
    if (lazy.taxonomySeed === undefined) {
      return new RegistryTaxonomyService(lazy.client);
    }
    return new PinnedTaxonomyService(
      LocalTaxonomyService.fromText(
        lazy.taxonomySeed,
        join(sessionRoot, runId, "taxonomy-suggestions"),
      ),
      new RegistryTaxonomyService(lazy.client),
    );
  }
  const seed = localTaxonomySeedPath(contentDir);
  if (!existsSync(seed)) {
    return undefined;
  }
  return new LocalTaxonomyService(
    seed,
    join(sessionRoot, runId, "taxonomy-suggestions"),
  );
}

/**
 * Prepares the run's code scratch workspace when the host code-execution
 * tool is enabled. The workspace is self-sufficient (the probe runs through
 * this process's own Node binary), so it works on bare hosts without package
 * managers; python is detected opportunistically. A preparation failure
 * never fails the run — code execution then resolves provider-natively or
 * falls back to the capability catalog's honesty rules.
 */
async function prepareRunCodeEnvironment(
  sessionRoot: string,
  runId: string,
  offline: boolean,
): Promise<CodeRuntimeEnvironment | undefined> {
  if (offline) return undefined;
  const disabledCapabilities = new Set(
    (process.env.BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (disabledCapabilities.has("code-execution")) return undefined;
  const enabled = new Set(
    (process.env.BRAINSTORM_AGENTIC_HOST_TOOLS ?? "").split(",").filter(Boolean),
  );
  if (!enabled.has("code_execute")) return undefined;
  try {
    return await prepareCodeWorkspace(join(sessionRoot, runId, "code-env"), {
      env: process.env,
    });
  } catch (error) {
    console.error(
      `[code] scratch workspace unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

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
 * - `raw_expertise.json` — the validated tree exactly as stored (counts and
 *   relevance per department, umbrella, and subfield);
 * - `mul_expertise.json` — the same tree annotated with each node's cxr
 *   seating value (count × relevance; departments carry the sum over their
 *   umbrellas), which is the queue panel selection seats from.
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
    // A pre-relevance tree (dead history) cannot be scored; raw copy only.
  }
  return written;
}

/**
 * Writes the run's reviewed deliverables as readable copies under
 * `<session>/<runId>/final/`:
 *
 * - `final/<memberId>.json` — the member's LAST recorded idea (the runtime
 *   re-persists the idea after every redevelopment, so the newest artifact
 *   under `ideas.<memberId>` is the version the review left standing: the
 *   final output once the member's walk completed, the latest one otherwise);
 * - `final/proposal.json` — the chair's synthesis, when the run reached it.
 *
 * These are readable copies for the submitter; the artifact store and the
 * checkpoint journal remain the authoritative records.
 */
async function writeFinalOutputs(
  artifacts: ArtifactStore,
  sessionRoot: string,
  runId: string,
): Promise<readonly string[]> {
  const refs = await artifacts.list();
  // Last ref per member idea path wins: first pass, then every revision, in
  // index (chronological) order.
  const latestByMember = new Map<string, string>();
  let proposalId: string | undefined;
  for (const ref of refs) {
    const path = ref.metadata?.path;
    if (ref.metadata?.schema === "brainIdea" && typeof path === "string" && path.startsWith("ideas.")) {
      latestByMember.set(path.slice("ideas.".length), ref.id);
    }
    if (ref.metadata?.schema === "finalProposal") proposalId = ref.id;
  }
  if (latestByMember.size === 0 && proposalId === undefined) return [];

  const directory = join(sessionRoot, runId, "final");
  mkdirSync(directory, { recursive: true });
  const writeAtomic = (name: string, body: string): string => {
    const path = join(directory, name);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
    return path;
  };
  const pretty = (raw: string): string => {
    try {
      return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
    } catch {
      return raw; // a payload that does not parse is still worth copying verbatim
    }
  };

  const written: string[] = [];
  for (const [memberId, id] of latestByMember) {
    const stored = await artifacts.get(id);
    if (!stored) continue;
    // Member ids are runtime-minted (`member-N`, `member-user-N`) and safe as
    // file names; anything unexpected is skipped rather than sanitized.
    if (!/^[A-Za-z0-9_-]+$/.test(memberId)) continue;
    written.push(writeAtomic(`${memberId}.json`, pretty(stored.data)));
  }
  if (proposalId !== undefined) {
    const stored = await artifacts.get(proposalId);
    if (stored) written.push(writeAtomic("proposal.json", pretty(stored.data)));
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

/**
 * Records one compact summary of the finished run in the local spool. The
 * server drains and sends it; this only ever writes a file, so a worker on a
 * network-less node behaves identically and telemetry can never delay or fail a
 * run. Every failure here is swallowed for the same reason.
 *
 * Opt-out is enforced by the caller (the environment carries the setting), so a
 * user who has switched telemetry off produces no record at all rather than one
 * that is written and then withheld.
 */
function recordRunSummary(options: {
  readonly workspace: string;
  readonly sessionRoot: string;
  readonly runId: string;
  readonly result: RunResult;
  readonly eventsFile: string | undefined;
  readonly pin: LazyRegistryContent["pin"] | undefined;
  readonly provider: string;
  readonly runner: "local" | "slurm";
  readonly modelsByRoute: Readonly<Record<string, string>> | undefined;
}): void {
  try {
    const events: JsonObject[] = [];
    if (options.eventsFile !== undefined && existsSync(options.eventsFile)) {
      for (const line of readFileSync(options.eventsFile, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          events.push(JSON.parse(line) as JsonObject);
        } catch {
          // A torn trailing line is not worth losing the summary over.
        }
      }
    }
    const checkpointPath = join(options.sessionRoot, options.runId, "checkpoint.json");
    let journal: JsonObject[] = [];
    let state: JsonObject | undefined;
    if (existsSync(checkpointPath)) {
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as JsonObject;
      journal = Array.isArray(checkpoint.journal) ? (checkpoint.journal as JsonObject[]) : [];
      // The last journaled activity result is the run's final state.
      for (const entry of journal) {
        const value = entry.value;
        if (
          entry.kind === "activity" &&
          typeof value === "object" && value !== null && !Array.isArray(value) &&
          "reviews" in value
        ) {
          state = value as JsonObject;
        }
      }
    }
    const summary = deriveRunSummary({
      status: options.result.status,
      events,
      journal,
      ...(state ? { state } : {}),
    });
    const event: TelemetryEvent = {
      type: "run.summary",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: randomUUID(),
      installId: installId(options.workspace),
      at: new Date().toISOString(),
      appVersion: APP_VERSION,
      platform: `${process.platform}-${process.arch}`,
      runner: options.runner,
      provider: options.provider,
      ...(options.pin
        ? {
            bundle: {
              name: options.pin.bundle,
              version: options.pin.version,
              digest: options.pin.manifestSha256,
            },
          }
        : {}),
      ...(summary.taxonomy?.revision !== undefined
        ? { taxonomyRevision: summary.taxonomy.revision }
        : {}),
      ...(options.modelsByRoute ? { modelsByRoute: options.modelsByRoute } : {}),
      runId: options.runId,
      summary,
    };
    new TelemetrySpool(options.workspace).append(event);
  } catch {
    // Telemetry is never a reason for a run to report differently.
  }
}

/** Read from package.json so the version is declared in exactly one place. */
const APP_VERSION: string = (() => {
  try {
    return (
      createRequire(import.meta.url)("../../package.json") as { version?: string }
    ).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** The workspace that owns this session root — where the install id lives. */
function defaultWorkspaceRoot(sessionRoot: string): string {
  return dirname(sessionRoot);
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
    if (result.retryAt !== undefined) {
      console.log(`Automatic resume time: ${new Date(result.retryAt).toISOString()}`);
      console.log("The brain server will resume it automatically unless it is cancelled.");
    } else {
      console.log(
        "No reset time was announced (a top-up is likely needed); resume it from the dashboard when ready.",
      );
    }
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

/**
 * Parses --gate-json, the rich gate answer used when the compact --gate
 * syntax cannot carry the response (user-added custom seats). The value is
 * one JSON object: { gateKey, action, members?, addedMembers? }.
 */
function parseGateJsonFlag(raw: string): { gateKey: string; response: JsonValue } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `--gate-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--gate-json must be a JSON object");
  }
  const { gateKey, ...response } = parsed as { gateKey?: unknown } & Record<string, unknown>;
  if (typeof gateKey !== "string" || gateKey.length === 0) {
    throw new Error("--gate-json needs a non-empty gateKey");
  }
  if (typeof (response as { action?: unknown }).action !== "string") {
    throw new Error("--gate-json needs an action string");
  }
  return { gateKey, response: response as JsonValue };
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
    // An interrupted job resubmitted before its first checkpoint arrives as a
    // fresh `run` with the content pin already on disk: reuse that pin (same
    // version, verified cache) instead of refusing the resubmission.
    const pinExists = existsSync(join(contentDir!, "content-pin.json"));
    const lazy = contentRegistryUrl
      ? await openLazyRegistryContent({
          registryUrl: contentRegistryUrl,
          contentDir: contentDir!,
          resume: pinExists,
          ...(!pinExists && contentRegistryVersion
            ? { version: contentRegistryVersion }
            : {}),
        })
      : undefined;
    const artifacts = new FsArtifactStore(sessionRoot, runId);
    const taxonomy = taxonomyForRun(lazy, contentDir!, sessionRoot, runId);
    const codeEnvironment = await prepareRunCodeEnvironment(
      sessionRoot,
      runId,
      offline,
    );
    const runtime = buildRuntime({
      providerConfig: providerConfigFromEnv(process.env, offline),
      checkpoints: new FsCheckpointStore(sessionRoot),
      artifacts,
      autoApproveGates: autoApprove,
      ...(manifest ? { attachmentRoots: [manifest.baseDir] } : {}),
      ...(taxonomy ? { taxonomy } : {}),
      ...(codeEnvironment ? { codeEnvironment } : {}),
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
      const finals = await writeFinalOutputs(artifacts, sessionRoot, runId);
      // Opt-out is honored here: with telemetry off, no record is produced at
      // all rather than one written and then withheld.
      if (process.env.BRAINSTORM_AGENTIC_TELEMETRY !== "off") {
        recordRunSummary({
          workspace: defaultWorkspaceRoot(sessionRoot),
          sessionRoot,
          runId,
          result,
          eventsFile,
          pin: lazy?.pin,
          provider: offline ? "offline" : (process.env.BRAINSTORM_AGENTIC_PROVIDER ?? "unknown"),
          runner: process.env.SLURM_JOB_ID ? "slurm" : "local",
          modelsByRoute: modelsByRouteFromEnv(process.env),
        });
      }
      reportResult(result, sessionRoot);
      for (const tree of trees) console.log(`Expertise tree: ${tree}`);
      for (const file of finals) console.log(`Final output: ${file}`);
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
    const gateJsonFlag = stringFlag(args, "gate-json");
    if (gateJsonFlag) {
      const { gateKey, response } = parseGateJsonFlag(gateJsonFlag);
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
    const taxonomy = taxonomyForRun(lazy, contentDir!, sessionRoot, runId);
    const codeEnvironment = await prepareRunCodeEnvironment(
      sessionRoot,
      runId,
      offline,
    );
    const runtime = buildRuntime({
      providerConfig: providerConfigFromEnv(process.env, offline),
      checkpoints: new FsCheckpointStore(sessionRoot),
      artifacts,
      autoApproveGates: resumeAutoApprove,
      ...(taxonomy ? { taxonomy } : {}),
      ...(codeEnvironment ? { codeEnvironment } : {}),
      bundle: lazy?.bundle ?? loadContent(contentDir!),
      ...(lazy ? { skillResolver: lazy.skillResolver } : {}),
      ...(onEvent !== undefined ? { onEvent } : {}),
    });
    try {
      const result = await runtime.resume(runId, {
        ...(Object.keys(responses).length > 0 ? { responses } : {}),
      });
      const trees = await writeExpertiseTrees(artifacts, sessionRoot, runId);
      const finals = await writeFinalOutputs(artifacts, sessionRoot, runId);
      // Opt-out is honored here: with telemetry off, no record is produced at
      // all rather than one written and then withheld.
      if (process.env.BRAINSTORM_AGENTIC_TELEMETRY !== "off") {
        recordRunSummary({
          workspace: defaultWorkspaceRoot(sessionRoot),
          sessionRoot,
          runId,
          result,
          eventsFile,
          pin: lazy?.pin,
          provider: offline ? "offline" : (process.env.BRAINSTORM_AGENTIC_PROVIDER ?? "unknown"),
          runner: process.env.SLURM_JOB_ID ? "slurm" : "local",
          modelsByRoute: modelsByRouteFromEnv(process.env),
        });
      }
      reportResult(result, sessionRoot);
      for (const tree of trees) console.log(`Expertise tree: ${tree}`);
      for (const file of finals) console.log(`Final output: ${file}`);
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
    "  brain-worker resume --run-id <id> --content-dir <cache-dir> [--content-registry-url <mcp-url>] [--gate key=action[:memberId,...]] [--gate-json <json>] [--events-file <path>]",
  );
  console.log("  brainstorm-agentic list");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
