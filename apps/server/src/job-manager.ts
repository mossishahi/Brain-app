import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  execFile,
  spawn,
  type ExecFileOptions,
} from "node:child_process";

import type { WorkflowCheckpoint } from "@brainstorm-agentic/core";
import { MIN_SUPPORTED_WORKFLOW_VERSION } from "@brainstorm-agentic/content";
import {
  slurmClusterArgs,
  slurmClusterFrom,
  stripSlurmClusterBanners,
} from "@brainstorm-agentic/host-tools";
import {
  isCreditLimitMessage,
  resolveCreditReset,
} from "@brainstorm-agentic/credit-recovery";
import {
  ATTACHMENT_LIMITS,
  CLASSIFICATION_EDIT_LIMITS,
  PANEL_EDIT_LIMITS,
  type CustomSeatRequest,
  type GateAnswerRequest,
  type JobDetail,
  type JobStatus,
  type JobSummary,
  type ServerSettings,
  type TrashJobResponse,
} from "@brainstorm-agentic/protocol";
import {
  ingestAttachments,
} from "./attachments.js";
import {
  buildOrchestrationCommand,
  renderSlurmTemplate,
  shellQuote,
} from "./command.js";
import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./files.js";
import { readJsonCached, statStamp } from "./read-cache.js";
import type { JobRecord } from "./model.js";
import {
  SettingsStore,
  type AnthropicConnectionValidator,
  type ClaudeAgentConnectionValidator,
  type CursorAgentConnectionValidator,
} from "./settings.js";
import { buildJobDetail, compactJobDetail } from "./stage-mapper.js";

export interface JobManagerOptions {
  readonly workspace: string;
  readonly contentRegistryUrl?: string;
  readonly workerPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly onChange?: () => void;
  readonly validateAnthropic?: AnthropicConnectionValidator;
  readonly validateClaudeAgent?: ClaudeAgentConnectionValidator;
  readonly validateCursorAgent?: CursorAgentConnectionValidator;
  readonly validateOpenRouter?: (
    apiKey: string,
    model: string,
  ) => Promise<void>;
  /**
   * How long an unattended panel-confirmation gate waits before approving
   * itself as seated. Any interaction with the confirmation card holds the
   * countdown permanently. Default 30 seconds.
   */
  readonly panelAutoApproveMs?: number;
  /**
   * Window in which a SLURM job's own on-disk activity (checkpoint.json,
   * events.jsonl mtimes) proves it alive WITHOUT a scheduler query. 0
   * disables the shortcut (every liveness check consults the scheduler,
   * subject to the probe cache). Default 10 minutes.
   */
  readonly slurmActivityFreshnessMs?: number;
  /**
   * How long one squeue/sacct liveness verdict stays cached for a SLURM
   * job. Shared clusters treat seconds-scale scheduler polling as abuse
   * (LRZ policy recommends ~10-minute intervals), and the workspace
   * freshness shortcut answers the common case anyway. Default 10 minutes.
   */
  readonly slurmProbeTtlMs?: number;
  /**
   * Held-pilot submission channel, for deployments where the server itself
   * runs as a SLURM job and sbatch is denied from compute nodes (probed on
   * LRZ CoolMUC-4). The directory holds `available/<jobid>` markers written
   * by deploy/lrz-queue-runway.sh when it pre-queues held pilot jobs from a
   * login node; submitting a run claims a marker (atomic rename), writes
   * the assignment into `spool/<jobid>.sh`, and `scontrol release`s the
   * pilot — no sbatch at runtime. Unset (the default) submits via sbatch.
   */
  readonly pilotPoolDir?: string;
  /**
   * Quiet window after server start in which unattended-gate countdowns do
   * NOT arm: a gate raised while the server was down (a shift handover, a
   * restart) must not auto-approve before a human could possibly have seen
   * it. Default 3 minutes; 0 disables the grace.
   */
  readonly gateAutoApproveGraceMs?: number;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function execute(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${command} failed: ${String(stderr || error.message).trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function createJobId(now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `bsa_${stamp}_${randomBytes(3).toString("hex")}`;
}

export function defaultWorkerPath(): string {
  return fileURLToPath(new URL("../../../worker/dist/src/main.js", import.meta.url));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The requested transition needs the job stopped first (HTTP 409). */
export class JobConflictError extends Error {}

function semverBelow(candidate: string, threshold: string): boolean {
  const [a, b] = [candidate.split(".").map(Number), threshold.split(".").map(Number)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return false;
}

/**
 * The last worker:fatal report in an events log at/after sinceMs — the only
 * trace a worker leaves when it dies before its first checkpoint write
 * (content validation, a retired pin, an unreachable registry). Reads only
 * the tail; the events log of a long run can be large.
 */
export function lastWorkerFatalEvent(
  eventsPath: string,
  sinceMs: number,
): string | undefined {
  try {
    const raw = readFileSync(eventsPath, "utf8");
    const tail = raw.length > 65_536 ? raw.slice(-65_536) : raw;
    const lines = tail.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim();
      if (!line.includes('"worker:fatal"')) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          at?: number;
          message?: string;
        };
        if (
          event.type === "worker:fatal" &&
          typeof event.message === "string" &&
          (event.at ?? 0) >= sinceMs
        ) {
          return event.message;
        }
      } catch {
        // A partially-written tail line; keep scanning.
      }
    }
  } catch {
    // No events log yet — the worker died before creating it.
  }
  return undefined;
}

export class JobManager {
  readonly settings: SettingsStore;
  readonly jobsDir: string;
  readonly sessionsDir: string;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly contentRegistryUrl: string | undefined;
  private readonly workerPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly panelAutoApproveMs: number;
  private readonly slurmActivityFreshnessMs: number;
  private readonly slurmProbeTtlMs: number;
  private readonly workspace: string;
  private readonly pilotPoolDir: string | undefined;
  private readonly gateAutoApproveGraceMs: number;
  /** Wall-clock construction time; anchors the gate-arming grace window. */
  private readonly startedAt: number;
  private static readonly DEFAULT_GATE_GRACE_MS = 180_000;
  private readonly autoResuming = new Set<string>();
  private readonly summaryCache = new Map<
    string,
    { key: string; value: JobSummary }
  >();

  constructor(options: JobManagerOptions) {
    this.settings = new SettingsStore(options.workspace, {
      ...(options.contentRegistryUrl
        ? { defaultContentRegistryUrl: options.contentRegistryUrl }
        : {}),
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
    });
    this.jobsDir = join(options.workspace, "workspace", "jobs");
    this.sessionsDir = join(options.workspace, "workspace", "sessions");
    this.contentRegistryUrl = options.contentRegistryUrl;
    this.workerPath = options.workerPath ?? defaultWorkerPath();
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange ?? (() => undefined);
    this.panelAutoApproveMs = options.panelAutoApproveMs ?? 30_000;
    this.slurmActivityFreshnessMs =
      options.slurmActivityFreshnessMs ?? JobManager.DEFAULT_SLURM_ACTIVITY_FRESHNESS_MS;
    this.slurmProbeTtlMs = options.slurmProbeTtlMs ?? JobManager.DEFAULT_SLURM_PROBE_TTL_MS;
    this.workspace = options.workspace;
    this.pilotPoolDir = options.pilotPoolDir;
    this.gateAutoApproveGraceMs =
      options.gateAutoApproveGraceMs ?? JobManager.DEFAULT_GATE_GRACE_MS;
    this.startedAt = Date.now();
    mkdirSync(this.jobsDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    this.reload();
  }

  reload(): void {
    this.jobs.clear();
    for (const entry of readdirSync(this.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const record = readJsonFile<JobRecord>(
          join(this.jobsDir, entry.name, "job.json"),
        );
        if (record?.jobId === entry.name) this.jobs.set(record.jobId, record);
      } catch {
        // A malformed job file is isolated; other restart-recovered jobs remain usable.
      }
    }
  }

  jobDir(jobId: string): string {
    return join(this.jobsDir, jobId);
  }

  sessionDir(jobId: string): string {
    return join(this.sessionsDir, jobId);
  }

  /** When the run's checkpoint was last written; 0 when it does not exist. */
  private checkpointMtime(jobId: string): number {
    try {
      return statSync(join(this.sessionDir(jobId), "checkpoint.json")).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** The skills version this run pinned at submission, when recorded. */
  private pinnedContentVersion(jobId: string): string | undefined {
    try {
      const pin = readJsonCached<{ version?: unknown }>(
        join(this.jobDir(jobId), "content", "content-pin.json"),
      );
      return typeof pin?.version === "string" ? pin.version : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A resume replays the run against its PINNED bundle; a pin the current
   * app has retired would only die at worker startup — minutes later, in a
   * log nobody reads. Refuse at the button instead, with the reason on the
   * job card.
   */
  private assertPinResumable(jobId: string): void {
    const version = this.pinnedContentVersion(jobId);
    if (
      version !== undefined &&
      semverBelow(version, MIN_SUPPORTED_WORKFLOW_VERSION)
    ) {
      throw new JobConflictError(
        `this run is pinned to skills v${version}, which this app no longer executes ` +
          `(minimum v${MIN_SUPPORTED_WORKFLOW_VERSION}) — submit the prompt as a new run to use the current skills`,
      );
    }
  }

  private write(record: JobRecord): void {
    atomicWriteJson(join(this.jobDir(record.jobId), "job.json"), record);
    this.jobs.set(record.jobId, record);
    this.onChange();
  }

  private warning(record: JobRecord, message: string): void {
    record.warnings = [...(record.warnings ?? []), message];
  }

  private manifestPath(jobId: string): string {
    return join(this.jobDir(jobId), "attachments", "manifest.json");
  }

  private command(
    record: JobRecord,
    mode: "run" | "resume",
    settings: ServerSettings,
    gate?: GateAnswerRequest,
  ): string {
    return buildOrchestrationCommand({
      workerPath: this.workerPath,
      mode,
      runId: record.jobId,
      // Held pilots are queued with --export=NONE long before any run
      // exists, so secrets cannot ride the scheduler environment; the
      // worker reads them from the owner-only credentials file instead.
      ...(this.pilotPoolDir !== undefined
        ? { credentialsFile: join(this.workspace, "credentials.json") }
        : {}),
      ...(mode === "run" ? { topic: record.topic } : {}),
      ...(mode === "run" && existsSync(this.manifestPath(record.jobId))
        ? { attachmentsManifest: this.manifestPath(record.jobId) }
        : {}),
      sessionRoot: this.sessionsDir,
      eventsFile: join(this.jobDir(record.jobId), "events.jsonl"),
      contentDir: join(this.jobDir(record.jobId), "content"),
      contentRegistryUrl:
        settings.contentRegistry?.url ?? this.contentRegistryUrl,
      ...(settings.contentRegistry?.version
        ? { contentRegistryVersion: settings.contentRegistry.version }
        : {}),
      settings,
      ...(gate
        ? {
            gate: {
              gateKey: gate.gateKey,
              action: gate.action,
              ...(gate.members ? { members: gate.members } : {}),
              ...(gate.addedMembers && gate.addedMembers.length > 0
                ? { addedMembers: gate.addedMembers }
                : {}),
              ...(gate.type !== undefined ? { type: gate.type } : {}),
              ...(gate.requestedOutputs !== undefined
                ? { requestedOutputs: gate.requestedOutputs }
                : {}),
            },
          }
        : {}),
    });
  }

  private writeScript(
    record: JobRecord,
    filename: string,
    command: string,
    template: string,
  ): string {
    const path = join(this.jobDir(record.jobId), filename);
    atomicWriteFile(path, renderSlurmTemplate(template, command), 0o755);
    return path;
  }

  /**
   * Claims one pre-queued held pilot and releases it against this job's
   * submit script. Claim = atomic rename of the pilot's `available/<jobid>`
   * marker, so two concurrent submissions can never seize the same pilot.
   * The pilot's own bootstrap (queued by deploy/lrz-queue-runway.sh) execs
   * `spool/<jobid>.sh`, which cds into the job directory and runs the same
   * rendered submit script an sbatch submission would have run.
   */
  private async submitViaPilot(record: JobRecord, script: string): Promise<void> {
    const poolDir = this.pilotPoolDir!;
    const availableDir = join(poolDir, "available");
    const claimedDir = join(poolDir, "claimed");
    const spoolDir = join(poolDir, "spool");
    mkdirSync(claimedDir, { recursive: true });
    mkdirSync(spoolDir, { recursive: true });
    const markers = (() => {
      try {
        return readdirSync(availableDir)
          .filter((name) => /^\d+$/.test(name))
          .sort((a, b) => Number(a) - Number(b));
      } catch {
        return [] as string[];
      }
    })();
    for (const id of markers) {
      try {
        renameSync(join(availableDir, id), join(claimedDir, id));
      } catch {
        continue; // another submission won the race, or the marker vanished
      }
      const cluster =
        readFileSync(join(claimedDir, id), "utf8").trim() || undefined;
      atomicWriteFile(
        join(spoolDir, `${id}.sh`),
        `#!/usr/bin/env bash\ncd ${shellQuote(this.jobDir(record.jobId))} || exit 1\nexec bash ${shellQuote(script)}\n`,
        0o755,
      );
      // execute() rejects on a non-zero exit, so a refused release fails
      // the submission with scontrol's own message.
      await execute(
        "scontrol",
        [...slurmClusterArgs(cluster), "release", id],
        { cwd: this.jobDir(record.jobId), env: this.env, timeout: 10_000 },
      );
      record.slurmJobId = id;
      if (cluster !== undefined) record.slurmCluster = cluster;
      else delete record.slurmCluster;
      delete record.pid;
      return;
    }
    throw new Error(
      "no held pilot jobs are available — top up the pool from a login node with deploy/lrz-queue-runway.sh",
    );
  }

  private async submitScript(
    record: JobRecord,
    script: string,
    settings: ServerSettings,
  ): Promise<void> {
    const executionEnv = this.settings.executionEnvironment(this.env, settings);
    if (record.runner === "slurm") {
      if (this.pilotPoolDir !== undefined) {
        await this.submitViaPilot(record, script);
        return;
      }
      const result = await execute("sbatch", [script], {
        cwd: this.jobDir(record.jobId),
        env: executionEnv,
        timeout: 10_000,
      });
      const match = /Submitted batch job\s+(\S+)/.exec(result.stdout);
      if (!match) {
        throw new Error(`sbatch returned an unrecognized response: ${result.stdout.trim()}`);
      }
      record.slurmJobId = match[1]!;
      // Multi-cluster sites (LRZ) name the landing cluster; every later
      // squeue/sacct/scancel needs it or the job is invisible to them.
      const cluster = slurmClusterFrom(result.stdout);
      if (cluster !== undefined) record.slurmCluster = cluster;
      else delete record.slurmCluster;
      delete record.pid;
      return;
    }

    const log = openSync(join(this.jobDir(record.jobId), "local.log"), "a");
    try {
      const child = spawn("bash", [script], {
        cwd: this.jobDir(record.jobId),
        env: executionEnv,
        detached: true,
        stdio: ["ignore", log, log],
      });
      if (!child.pid) throw new Error("local runner did not return a process id");
      record.pid = child.pid;
      delete record.slurmJobId;
      child.unref();
    } finally {
      closeSync(log);
    }
  }

  async submit(
    topic: string,
    attachments: readonly string[] = [],
    capabilityOverrides?: Readonly<Record<string, boolean>>,
  ): Promise<string> {
    if (topic.trim().length === 0) throw new Error("topic must not be empty");
    if (
      attachments.length >
      ATTACHMENT_LIMITS.maxReferences
    ) {
      throw new Error(
        `a job may contain at most ${ATTACHMENT_LIMITS.maxReferences} attachments`,
      );
    }
    // Per-run capability overrides join the settings snapshot up front, so
    // the launch command, the execution environment, and every later resume
    // (which re-reads record.executionSettings) all replay the same policy.
    const overrides = Object.fromEntries(
      Object.entries(capabilityOverrides ?? {}).filter(
        ([, enabled]) => typeof enabled === "boolean",
      ),
    );
    const settings: ServerSettings = {
      ...structuredClone(this.settings.get()),
      ...(Object.keys(overrides).length > 0
        ? { capabilityOverrides: overrides }
        : {}),
    };
    if (
      settings.llm.provider === "anthropic" &&
      (!settings.llm.model || !settings.llm.apiKeyConfigured)
    ) {
      throw new Error(
        "Configure and verify the Anthropic API key and model in Settings before submitting a job",
      );
    }
    if (
      settings.llm.provider === "claude-agent" &&
      !settings.llm.setupTokenConfigured
    ) {
      throw new Error(
        "Configure and verify the Claude setup token in Settings before submitting a job",
      );
    }
    if (
      settings.llm.provider === "cursor-agent" &&
      !settings.llm.cursorApiKeyConfigured
    ) {
      throw new Error(
        "Configure and verify the Cursor API key in Settings before submitting a job",
      );
    }
    let jobId = createJobId(new Date(this.now()));
    while (this.jobs.has(jobId)) jobId = createJobId(new Date(this.now() + 1));
    const record: JobRecord = {
      jobId,
      topic,
      ...(attachments.length > 0 ? { attachments } : {}),
      status: "queued",
      runner: settings.runner,
      createdAt: this.now(),
      updatedAt: this.now(),
      submissionCount: 0,
      executionSettings: structuredClone(settings),
    };
    mkdirSync(join(this.jobDir(jobId), "logs"), { recursive: true });
    this.write(record);
    try {
      if (attachments.length > 0) {
        const manifest = await ingestAttachments(
          attachments,
          join(this.jobDir(jobId), "attachments"),
        );
        atomicWriteJson(this.manifestPath(jobId), manifest);
      }
      mkdirSync(join(this.jobDir(jobId), "content"), { recursive: true });
      const command = this.command(record, "run", settings);
      const script = this.writeScript(record, "submit.sh", command, settings.slurmTemplate);
      await this.submitScript(record, script, settings);
      record.status = "running";
      record.submissionCount = 1;
      record.updatedAt = this.now();
      this.write(record);
      return jobId;
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = this.now();
      this.write(record);
      throw error;
    }
  }

  private checkpoint(jobId: string): WorkflowCheckpoint | undefined {
    try {
      return readJsonCached<WorkflowCheckpoint>(
        join(this.sessionDir(jobId), "checkpoint.json"),
      );
    } catch {
      return undefined;
    }
  }

  private checkpointStatus(jobId: string): JobStatus | undefined {
    const checkpoint = this.checkpoint(jobId);
    try {
      switch (checkpoint?.status) {
        case "running":
        case "suspended":
        case "completed":
        case "failed":
        case "cancelled":
          return checkpoint.status;
        case "credit_blocked":
          return "credit-blocked";
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private async migrateLegacyCreditFailure(
    record: JobRecord,
  ): Promise<boolean> {
    const checkpoint = this.checkpoint(record.jobId);
    const message = checkpoint?.error?.message;
    if (
      checkpoint?.status !== "failed" ||
      typeof message !== "string" ||
      !isCreditLimitMessage(message)
    ) {
      return false;
    }
    const settings = this.settings.get();
    let creditBlock: WorkflowCheckpoint["creditBlock"];
    try {
      const resolution = await resolveCreditReset({
        message,
        now: new Date(checkpoint.updatedAt),
        safetyBufferSeconds: settings.creditRecovery.safetyBufferSeconds,
        openRouterApiKey: this.settings.getOpenRouterApiKey(),
        openRouterModel: settings.creditRecovery.openRouterModel,
      });
      creditBlock = {
        retryAt: resolution.retryAt,
        providerMessage: message,
        source: resolution.source,
      };
    } catch {
      // The message names no reset time (e.g. "credit balance is too low"):
      // still a credit block, but one the user claims manually after a
      // top-up instead of the scheduler claiming it at a reset time.
      creditBlock = { providerMessage: message, source: "manual" };
    }
    const migrated: WorkflowCheckpoint = {
      ...checkpoint,
      status: "credit_blocked",
      creditBlock,
      error: undefined,
      updatedAt: this.now(),
    };
    atomicWriteJson(
      join(this.sessionDir(record.jobId), "checkpoint.json"),
      migrated,
    );
    record.status = "credit-blocked";
    delete record.error;
    record.updatedAt = this.now();
    this.write(record);
    return true;
  }

  private localAlive(pid: number | undefined): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * SLURM liveness is answered from the workspace first and the scheduler
   * last. The worker continuously writes checkpoint.json and events.jsonl
   * to shared storage, so a fresh mtime proves the job alive more cheaply
   * AND more recently than any squeue answer — and shared clusters treat
   * seconds-scale squeue/sacct polling as abuse (LRZ policy names it
   * bannable and recommends ~10-minute intervals). The scheduler is
   * consulted only when the files go quiet (long model turn, queued job,
   * dead worker), and that verdict is cached for slurmProbeTtlMs. The cost
   * is orphan-detection latency of up to the freshness window — invisible
   * next to the resubmission machinery's own pacing, and the price of
   * staying welcome on the host cluster.
   */
  private static readonly DEFAULT_SLURM_ACTIVITY_FRESHNESS_MS = 600_000;
  private static readonly DEFAULT_SLURM_PROBE_TTL_MS = 600_000;
  private readonly slurmAliveCache = new Map<
    string,
    { at: number; alive: Promise<boolean> }
  >();

  /** Newest on-disk worker activity for a job, as a wall-clock timestamp. */
  private workspaceActivityAt(jobId: string): number {
    let latest = 0;
    for (const path of [
      join(this.sessionDir(jobId), "checkpoint.json"),
      join(this.jobDir(jobId), "events.jsonl"),
    ]) {
      try {
        const at = statSync(path).mtimeMs;
        if (at > latest) latest = at;
      } catch {
        // An absent file simply contributes no freshness.
      }
    }
    return latest;
  }

  private slurmAlive(record: JobRecord): Promise<boolean> {
    const id = record.slurmJobId;
    if (!id) return Promise.resolve(false);
    // Compared against the real clock, not this.now(): file mtimes are
    // wall-clock stamps, and tests that inject a synthetic clock must not
    // turn every freshly-written fixture into a live job.
    if (
      this.slurmActivityFreshnessMs > 0 &&
      Date.now() - this.workspaceActivityAt(record.jobId) < this.slurmActivityFreshnessMs
    ) {
      return Promise.resolve(true);
    }
    const key = `${record.slurmCluster ?? ""}:${id}`;
    const cached = this.slurmAliveCache.get(key);
    if (cached && this.now() - cached.at < this.slurmProbeTtlMs) {
      return cached.alive;
    }
    const alive = this.probeSlurmAlive(id, record.slurmCluster);
    this.slurmAliveCache.set(key, { at: this.now(), alive });
    return alive;
  }

  private async probeSlurmAlive(id: string, cluster?: string): Promise<boolean> {
    const clusterArgs = slurmClusterArgs(cluster);
    try {
      const queue = await execute(
        "squeue",
        ["-h", "-j", id, "-o", "%T", ...clusterArgs],
        {
          env: this.env,
          timeout: 2_000,
        },
      );
      // -M output carries a "CLUSTER: X" banner even for an empty queue;
      // only real state lines mean the job still exists there.
      if (stripSlurmClusterBanners(queue.stdout).trim().length > 0) return true;
    } catch {
      // Fall through to accounting; clusters commonly purge squeue quickly.
    }
    try {
      const accounting = await execute(
        "sacct",
        ["-n", "-j", id, "--format=State", ...clusterArgs],
        { env: this.env, timeout: 2_000 },
      );
      return stripSlurmClusterBanners(accounting.stdout)
        .split(/\s+/)
        .some((state) =>
          /^(PENDING|RUNNING|CONFIGURING|COMPLETING|SUSPENDED|RESIZING)$/i.test(
            state.replace(/\+.*/, ""),
          )
        );
    } catch {
      return false;
    }
  }

  private async reconcile(record: JobRecord): Promise<JobStatus> {
    if (record.status === "cancelled") return "cancelled";
    if (await this.migrateLegacyCreditFailure(record)) {
      return "credit-blocked";
    }
    if (record.status === "failed" && !this.checkpointStatus(record.jobId)) return "failed";
    const checkpoint = this.checkpointStatus(record.jobId);
    // A pending resubmission makes a terminal checkpoint verdict STALE
    // unless the resumed worker itself wrote it (checkpoint mtime after the
    // resubmission — e.g. a fast run that completed before this tick). For
    // a stale verdict: hold "queued" while the submission is alive (or
    // inside the startup grace) so the retry is VISIBLE; once the
    // submission is gone, surface the worker's own fatal report — the only
    // trace of a pre-checkpoint death — and fall through to the (still
    // stale, still true) checkpoint verdict.
    if (record.autoResumePending && checkpoint !== "running") {
      const submittedAt = record.autoResumePending.submittedAt;
      if (this.checkpointMtime(record.jobId) >= submittedAt) {
        // The resumed run reached its own terminal state; trust it below.
        delete record.autoResumePending;
        record.updatedAt = this.now();
        this.write(record);
      } else {
        const alive =
          record.runner === "local"
            ? this.localAlive(record.pid)
            : await this.slurmAlive(record);
        if (alive || this.now() - submittedAt < 30_000) {
          if (record.status !== "queued") {
            record.status = "queued";
            record.updatedAt = this.now();
            this.write(record);
          }
          return "queued";
        }
        delete record.autoResumePending;
        const fatal = lastWorkerFatalEvent(
          join(this.jobDir(record.jobId), "events.jsonl"),
          submittedAt,
        );
        if (fatal !== undefined) record.error = fatal;
        record.updatedAt = this.now();
        this.write(record);
      }
    }
    if (
      checkpoint === "completed" ||
      checkpoint === "failed" ||
      checkpoint === "cancelled" ||
      checkpoint === "suspended" ||
      checkpoint === "credit-blocked"
    ) {
      if (record.status !== checkpoint) {
        record.status = checkpoint;
        record.updatedAt = this.now();
        this.write(record);
      }
      return checkpoint;
    }
    if (
      checkpoint === "running" &&
      (record.autoResumePending || record.status === "queued")
    ) {
      // A resubmitted run (credit or interrupted resume) reached its worker.
      delete record.autoResumePending;
      record.status = "running";
      record.updatedAt = this.now();
      this.write(record);
    }
    if (record.status !== "running" && record.status !== "queued" && checkpoint !== "running") {
      return record.status;
    }

    const alive =
      record.runner === "local"
        ? this.localAlive(record.pid)
        : await this.slurmAlive(record);
    if (!alive) {
      if (record.status !== "orphaned") {
        record.status = "orphaned";
        record.updatedAt = this.now();
        this.write(record);
      }
      return "orphaned";
    }
    return checkpoint === "running" ? "running" : "queued";
  }

  private record(jobId: string): JobRecord {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`job "${jobId}" was not found`);
    return record;
  }

  /**
   * Built details memoized by a fingerprint of everything the build reads:
   * the record itself, the reconciled status, the settings, and the stat
   * stamps of the workspace files (checkpoint, event log, artifact index,
   * content pin). SSE ticks, polls, and page refreshes hit the cache for
   * the price of four stats; a change in any input rebuilds exactly once.
   */
  private readonly detailCache = new Map<
    string,
    { fingerprint: string; value: JobDetail }
  >();

  async detail(jobId: string): Promise<JobDetail> {
    const record = this.record(jobId);
    const status = await this.reconcile(record);
    const sessionDir = this.sessionDir(jobId);
    const jobDir = this.jobDir(jobId);
    const settings = record.executionSettings ?? this.settings.get();
    const fingerprint = [
      JSON.stringify(record),
      status,
      JSON.stringify(settings),
      statStamp(join(sessionDir, "checkpoint.json")),
      statStamp(join(jobDir, "events.jsonl")),
      statStamp(join(sessionDir, "artifacts", "index.json")),
      statStamp(join(jobDir, "content", "content-pin.json")),
    ].join("|");
    const cached = this.detailCache.get(jobId);
    if (cached && cached.fingerprint === fingerprint) return cached.value;
    const value = buildJobDetail({
      record,
      status,
      sessionDir,
      jobDir,
      settings,
    });
    this.detailCache.set(jobId, { fingerprint, value });
    return value;
  }

  /** Statuses whose workspace files no process writes to anymore. */
  private static readonly SETTLED_STATUSES: ReadonlySet<JobStatus> = new Set([
    "completed",
    "failed",
    "cancelled",
  ]);

  /**
   * Landing-card summary. Settled jobs are hydrated once and cached so a list
   * snapshot does not re-read every job's event log and artifacts; live jobs
   * recompute so their progress stays current.
   */
  private async summary(record: JobRecord): Promise<JobSummary> {
    const status = await this.reconcile(record);
    const key = `${status}:${record.updatedAt}`;
    const cached = this.summaryCache.get(record.jobId);
    if (cached?.key === key) return cached.value;
    // Live jobs ride the fingerprint-cached detail, so a list snapshot
    // costs stats — not a rebuild — when nothing changed.
    const value = compactJobDetail(await this.detail(record.jobId));
    if (JobManager.SETTLED_STATUSES.has(status)) {
      this.summaryCache.set(record.jobId, { key, value });
    }
    return value;
  }

  async list(): Promise<JobSummary[]> {
    const records = [...this.jobs.values()]
      .filter((record) => record.trashedAt === undefined)
      .sort((a, b) =>
        b.createdAt - a.createdAt || b.jobId.localeCompare(a.jobId)
      );
    return Promise.all(records.map((record) => this.summary(record)));
  }

  /** Trashed jobs, newest trash first. View-only: files stay on disk. */
  async listTrashed(): Promise<JobSummary[]> {
    const records = [...this.jobs.values()]
      .filter((record) => record.trashedAt !== undefined)
      .sort((a, b) =>
        b.trashedAt! - a.trashedAt! || b.jobId.localeCompare(a.jobId)
      );
    return Promise.all(records.map((record) => this.summary(record)));
  }

  /** Job states that may move to trash; everything else must stop first. */
  private static readonly TRASHABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
    "completed",
    "failed",
    "cancelled",
    "orphaned",
  ]);

  /**
   * Soft-delete: the job leaves the active list but its files and dashboard
   * stay readable forever. Live jobs conflict and must be cancelled first.
   */
  async trash(jobId: string): Promise<TrashJobResponse> {
    const record = this.record(jobId);
    if (record.trashedAt !== undefined) {
      return { jobId, trashedAt: record.trashedAt };
    }
    const status = await this.reconcile(record);
    if (!JobManager.TRASHABLE_STATUSES.has(status)) {
      throw new JobConflictError(
        `a ${status} job cannot move to trash; stop it first`,
      );
    }
    record.trashedAt = this.now();
    record.updatedAt = this.now();
    this.write(record);
    return { jobId, trashedAt: record.trashedAt };
  }

  private signalLocal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      process.kill(pid, signal);
    }
  }

  async cancel(jobId: string): Promise<JobStatus> {
    const record = this.record(jobId);
    const current = await this.reconcile(record);
    if (
      current === "completed" ||
      current === "failed" ||
      current === "cancelled"
    ) {
      return current;
    }
    try {
      if (record.runner === "slurm" && record.slurmJobId) {
        await execute("scancel", [...slurmClusterArgs(record.slurmCluster), record.slurmJobId], {
          env: this.env,
          timeout: 5_000,
        });
      } else if (record.runner === "local" && record.pid && this.localAlive(record.pid)) {
        this.signalLocal(record.pid, "SIGTERM");
        await sleep(500);
        if (this.localAlive(record.pid)) this.signalLocal(record.pid, "SIGKILL");
      }
    } catch (error) {
      this.warning(
        record,
        `Cancellation command reported an error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    record.status = "cancelled";
    delete record.autoResumePending;
    record.updatedAt = this.now();
    this.write(record);
    return "cancelled";
  }

  /**
   * Called by the server poller and once at startup. Claims due credit-blocked
   * checkpoints exactly once, submits the same deterministic resume command,
   * and persists the claim so a server restart cannot double-submit it.
   * Manual blocks (no retryAt — e.g. a top-up is needed) are never claimed
   * here; they wait for resumeCreditBlocked().
   */
  async resumeDueCreditBlocks(): Promise<void> {
    const recovery = this.settings.get().creditRecovery;
    if (!recovery.autoResume) return;
    for (const record of this.jobs.values()) {
      if (
        record.status === "cancelled" ||
        this.autoResuming.has(record.jobId)
      ) {
        continue;
      }
      const checkpoint = this.checkpoint(record.jobId);
      if (
        checkpoint?.status !== "credit_blocked" ||
        !checkpoint.creditBlock ||
        checkpoint.creditBlock.retryAt === undefined ||
        checkpoint.creditBlock.retryAt > this.now()
      ) {
        continue;
      }
      if (record.autoResumePending) {
        const alive =
          record.runner === "local"
            ? this.localAlive(record.pid)
            : await this.slurmAlive(record);
        if (alive || this.now() - record.autoResumePending.submittedAt < 30_000) {
          continue;
        }
        this.warning(
          record,
          "Previous automatic resume submission disappeared before starting; retrying.",
        );
        delete record.autoResumePending;
      }
      this.autoResuming.add(record.jobId);
      try {
        await this.submitCreditResume(record, checkpoint.creditBlock.retryAt);
      } catch (error) {
        this.warning(
          record,
          `Automatic credit resume submission failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        record.updatedAt = this.now();
        this.write(record);
      } finally {
        this.autoResuming.delete(record.jobId);
      }
    }
  }

  /**
   * User-initiated resume of a credit-blocked job: the only way to claim a
   * manual block (whose provider message named no reset time — a top-up
   * recovery), and an early claim for timed blocks once the user has
   * restored credit. Refuses jobs that are not credit blocked (409) and
   * claims that are already in flight.
   */
  async resumeCreditBlocked(jobId: string): Promise<JobStatus> {
    const record = this.record(jobId);
    if (record.trashedAt !== undefined) {
      throw new JobConflictError(`job "${jobId}" is in the trash`);
    }
    if (record.status === "cancelled") {
      throw new JobConflictError(`job "${jobId}" is cancelled`);
    }
    if (this.autoResuming.has(jobId)) {
      throw new JobConflictError(
        `job "${jobId}" already has a resume submission in progress`,
      );
    }
    const checkpoint = this.checkpoint(jobId);
    if (checkpoint?.status !== "credit_blocked" || !checkpoint.creditBlock) {
      throw new JobConflictError(`job "${jobId}" is not credit blocked`);
    }
    if (record.autoResumePending) {
      const alive =
        record.runner === "local"
          ? this.localAlive(record.pid)
          : await this.slurmAlive(record);
      if (alive || this.now() - record.autoResumePending.submittedAt < 30_000) {
        throw new JobConflictError(
          `job "${jobId}" already has a resume submission in progress`,
        );
      }
      delete record.autoResumePending;
    }
    this.autoResuming.add(jobId);
    try {
      await this.submitCreditResume(record, checkpoint.creditBlock.retryAt);
    } finally {
      this.autoResuming.delete(jobId);
    }
    return record.status;
  }

  /**
   * User-initiated retry of a FAILED job from its last checkpoint. A run
   * fails when one task fails (a provider error, a crashed Claude Code
   * subprocess, an invalid artifact after every retry) — but the checkpoint
   * journal keeps every completed effect, and failures are never journaled,
   * so resuming re-executes exactly the failed task and continues. Refuses
   * jobs that are not failed, failures with no checkpoint (nothing ran —
   * submit a new job instead), and claims already in flight.
   */
  async retryFailed(jobId: string): Promise<JobStatus> {
    const record = this.record(jobId);
    if (record.trashedAt !== undefined) {
      throw new JobConflictError(`job "${jobId}" is in the trash`);
    }
    if (this.autoResuming.has(jobId)) {
      throw new JobConflictError(
        `job "${jobId}" already has a resume submission in progress`,
      );
    }
    const status = await this.reconcile(record);
    if (status !== "failed") {
      throw new JobConflictError(`job "${jobId}" is not failed (status "${status}")`);
    }
    const checkpoint = this.checkpoint(jobId);
    if (checkpoint?.status !== "failed") {
      throw new JobConflictError(
        `job "${jobId}" failed before its first checkpoint; submit it again as a new job`,
      );
    }
    this.assertPinResumable(jobId);
    if (record.autoResumePending) {
      const alive =
        record.runner === "local"
          ? this.localAlive(record.pid)
          : await this.slurmAlive(record);
      if (alive || this.now() - record.autoResumePending.submittedAt < 30_000) {
        throw new JobConflictError(
          `job "${jobId}" already has a resume submission in progress`,
        );
      }
      delete record.autoResumePending;
    }
    this.autoResuming.add(jobId);
    try {
      const settings = record.executionSettings ?? this.settings.get();
      const command = this.command(record, "resume", settings);
      const number = (record.submissionCount ?? 1) + 1;
      const script = this.writeScript(
        record,
        `submit-retry-${number - 1}.sh`,
        command,
        settings.slurmTemplate,
      );
      await this.submitScript(record, script, settings);
      record.status = "queued";
      delete record.error;
      record.submissionCount = number;
      record.autoResumePending = { submittedAt: this.now() };
      record.updatedAt = this.now();
      this.write(record);
    } finally {
      this.autoResuming.delete(jobId);
    }
    return record.status;
  }

  /** Submits the deterministic credit-resume command and persists the claim. */
  private async submitCreditResume(
    record: JobRecord,
    retryAt: number | undefined,
  ): Promise<void> {
    const executionSettings = record.executionSettings ?? this.settings.get();
    const command = this.command(record, "resume", executionSettings);
    const number = (record.submissionCount ?? 1) + 1;
    const script = this.writeScript(
      record,
      `submit-credit-resume-${number - 1}.sh`,
      command,
      executionSettings.slurmTemplate,
    );
    await this.submitScript(record, script, executionSettings);
    record.status = "queued";
    record.submissionCount = number;
    record.autoResumePending = {
      ...(retryAt !== undefined ? { retryAt } : {}),
      submittedAt: this.now(),
    };
    record.updatedAt = this.now();
    this.write(record);
  }

  /** How many interrupted auto-resumes may run without checkpoint progress. */
  private static readonly MAX_STALLED_INTERRUPTED_RESUMES = 3;
  /** Minimum quiet time after a resubmission before another scan may act. */
  private static readonly INTERRUPTED_RESUBMIT_QUIET_MS = 60_000;

  /**
   * User-initiated resume of an interrupted (orphaned) job: the workspace
   * carries checkpoints/artifacts but no live process — a SLURM timeout, a
   * node failure, or a power cut took the worker down. Resubmits the same
   * deterministic command so the run continues from its last checkpoint (or
   * restarts cleanly when it died before the first checkpoint). Always
   * resets the stalled-attempts counter: an explicit click outranks the
   * auto-resume guard.
   */
  async resumeInterrupted(jobId: string): Promise<JobStatus> {
    const record = this.record(jobId);
    if (record.trashedAt !== undefined) {
      throw new JobConflictError(`job "${jobId}" is in the trash`);
    }
    if (this.autoResuming.has(jobId)) {
      throw new JobConflictError(
        `job "${jobId}" already has a resume submission in progress`,
      );
    }
    const status = await this.reconcile(record);
    if (status !== "orphaned") {
      throw new JobConflictError(
        `job "${jobId}" is not interrupted (status "${status}")`,
      );
    }
    this.assertPinResumable(jobId);
    this.autoResuming.add(jobId);
    try {
      await this.submitInterruptedResume(record, { resetAttempts: true });
    } finally {
      this.autoResuming.delete(jobId);
    }
    return record.status;
  }

  /**
   * Called by the server poller and once at startup: resubmits every
   * interrupted job from its last checkpoint (the workspace is shared
   * storage, so a relaunch on any node of the cluster recovers the same
   * jobs). A job that keeps dying without writing new checkpoints pauses
   * after MAX_STALLED_INTERRUPTED_RESUMES and waits for a manual resume.
   */
  async resumeInterruptedJobs(): Promise<void> {
    const recovery = this.settings.get().interruptedRecovery;
    if (recovery !== undefined && recovery.autoResume === false) return;
    for (const record of this.jobs.values()) {
      if (record.trashedAt !== undefined) continue;
      if (
        record.status !== "running" &&
        record.status !== "queued" &&
        record.status !== "orphaned"
      ) {
        continue;
      }
      if (this.autoResuming.has(record.jobId)) continue;
      const status = await this.reconcile(record);
      if (status !== "orphaned") continue;
      if (
        record.interruptedResume &&
        this.now() - record.interruptedResume.submittedAt <
          JobManager.INTERRUPTED_RESUBMIT_QUIET_MS
      ) {
        continue; // a fresh resubmission needs time to reach the scheduler
      }
      const checkpoint = this.checkpoint(record.jobId);
      const previous = record.interruptedResume;
      const progressed =
        previous?.checkpointSeq !== undefined &&
        checkpoint !== undefined &&
        checkpoint.seq > previous.checkpointSeq;
      if (
        previous !== undefined &&
        !progressed &&
        previous.count >= JobManager.MAX_STALLED_INTERRUPTED_RESUMES
      ) {
        const notice =
          "Automatic interrupted-job resume paused: " +
          `${previous.count} resubmissions made no checkpoint progress. ` +
          "Resume manually from the dashboard once the cause is fixed.";
        if (!record.warnings?.includes(notice)) {
          this.warning(record, notice);
          record.updatedAt = this.now();
          this.write(record);
        }
        continue;
      }
      this.autoResuming.add(record.jobId);
      try {
        await this.submitInterruptedResume(record, { resetAttempts: progressed });
      } catch (error) {
        this.warning(
          record,
          `Automatic interrupted-job resume failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        record.updatedAt = this.now();
        this.write(record);
      } finally {
        this.autoResuming.delete(record.jobId);
      }
    }
  }

  /**
   * Submits the resume of an interrupted job. With a checkpoint on disk the
   * worker resumes it (journal replay recovers the exact position — this
   * covers SLURM timeouts and power cuts mid-run); a job that died before
   * its first checkpoint is re-run from the start, reusing its content pin.
   */
  private async submitInterruptedResume(
    record: JobRecord,
    options: { readonly resetAttempts: boolean },
  ): Promise<void> {
    const settings = record.executionSettings ?? this.settings.get();
    const checkpoint = this.checkpoint(record.jobId);
    const command = this.command(
      record,
      checkpoint !== undefined ? "resume" : "run",
      settings,
    );
    const number = (record.submissionCount ?? 1) + 1;
    const script = this.writeScript(
      record,
      `submit-interrupted-resume-${number - 1}.sh`,
      command,
      settings.slurmTemplate,
    );
    await this.submitScript(record, script, settings);
    record.status = "queued";
    record.submissionCount = number;
    record.interruptedResume = {
      submittedAt: this.now(),
      count: options.resetAttempts ? 1 : (record.interruptedResume?.count ?? 0) + 1,
      ...(checkpoint !== undefined ? { checkpointSeq: checkpoint.seq } : {}),
    };
    record.updatedAt = this.now();
    this.write(record);
  }

  /** Validates the shape of gate-time custom seats (runtime re-validates). */
  private static validateAddedSeats(
    added: readonly CustomSeatRequest[],
  ): void {
    for (const seat of added) {
      if (
        typeof seat.department !== "string" ||
        seat.department.trim().length === 0 ||
        typeof seat.umbrella !== "string" ||
        seat.umbrella.trim().length === 0
      ) {
        throw new Error("an added seat needs a non-empty department and field");
      }
      if (
        !Array.isArray(seat.subfields) ||
        seat.subfields.length < PANEL_EDIT_LIMITS.minSubfields ||
        seat.subfields.length > PANEL_EDIT_LIMITS.maxSubfields ||
        seat.subfields.some(
          (entry) => typeof entry !== "string" || entry.trim().length === 0,
        )
      ) {
        throw new Error(
          `an added seat needs ${PANEL_EDIT_LIMITS.minSubfields} to ` +
            `${PANEL_EDIT_LIMITS.maxSubfields} non-empty subfields`,
        );
      }
    }
  }

  async answerGate(jobId: string, answer: GateAnswerRequest): Promise<JobDetail> {
    const record = this.record(jobId);
    const detail = await this.detail(jobId);
    if (detail.status !== "suspended" || !detail.pendingGate) {
      throw new Error(`job "${jobId}" is not suspended on a gate`);
    }
    if (detail.pendingGate.gateKey !== answer.gateKey) {
      throw new Error(`job "${jobId}" has no pending gate "${answer.gateKey}"`);
    }
    if (answer.action === "revise") {
      // A revise answers the classification gate: validate against the
      // offered options (the runtime re-validates authoritatively).
      const classification = detail.pendingGate.classification;
      if (!classification) {
        throw new Error(`gate "${answer.gateKey}" does not accept a classification revision`);
      }
      if (answer.members !== undefined || (answer.addedMembers?.length ?? 0) > 0) {
        throw new Error("revise does not accept panel edits");
      }
      if (answer.type !== undefined) {
        if (typeof answer.type !== "string" || answer.type.trim().length === 0) {
          throw new Error("revise needs a non-empty type");
        }
        if (
          classification.typeOptions.length > 0 &&
          !classification.typeOptions.includes(answer.type)
        ) {
          throw new Error(`"${answer.type}" is not a type of this run's catalog`);
        }
      }
      if (answer.requestedOutputs !== undefined) {
        if (answer.requestedOutputs.length > CLASSIFICATION_EDIT_LIMITS.maxRequestedOutputs) {
          throw new Error(
            `at most ${CLASSIFICATION_EDIT_LIMITS.maxRequestedOutputs} requested outputs are allowed`,
          );
        }
        const titles = new Set<string>();
        for (const entry of answer.requestedOutputs) {
          if (
            typeof entry.title !== "string" ||
            entry.title.trim().length < CLASSIFICATION_EDIT_LIMITS.minTitleChars ||
            typeof entry.ask !== "string" ||
            entry.ask.trim().length < CLASSIFICATION_EDIT_LIMITS.minAskChars
          ) {
            throw new Error(
              `each requested output needs a title (>= ${CLASSIFICATION_EDIT_LIMITS.minTitleChars} chars) ` +
                `and an ask (>= ${CLASSIFICATION_EDIT_LIMITS.minAskChars} chars)`,
            );
          }
          if (titles.has(entry.title)) {
            throw new Error(`duplicate requested-output title "${entry.title}"`);
          }
          titles.add(entry.title);
        }
      }
    } else if (answer.type !== undefined || answer.requestedOutputs !== undefined) {
      throw new Error(`action "${answer.action}" does not accept classification edits`);
    }
    const panelIds = detail.pendingGate.members?.map((member) => member.id) ?? [];
    const added = answer.addedMembers ?? [];
    JobManager.validateAddedSeats(added);
    // Seat-count bounds are enforceable only when the panel is known (it
    // always is in real flows; the runtime re-validates authoritatively).
    const keptCount =
      answer.action === "shrink" ? (answer.members?.length ?? 0) : panelIds.length;
    if (answer.action === "shrink" || panelIds.length > 0) {
      if (keptCount + added.length < PANEL_EDIT_LIMITS.minMembers) {
        throw new Error(
          `the confirmed panel needs at least ${PANEL_EDIT_LIMITS.minMembers} seats (kept + added)`,
        );
      }
      if (keptCount + added.length > PANEL_EDIT_LIMITS.maxMembers) {
        throw new Error(
          `the confirmed panel may seat at most ${PANEL_EDIT_LIMITS.maxMembers} members`,
        );
      }
    }
    if (answer.action === "shrink") {
      if (!answer.members || answer.members.length === 0) {
        throw new Error("shrink needs the member ids to keep");
      }
      if (new Set(answer.members).size !== answer.members.length) {
        throw new Error("shrink members must be unique");
      }
      if (answer.members.some((id) => !panelIds.includes(id))) {
        throw new Error("shrink may only keep members from the pending panel");
      }
      const inPanelOrder = panelIds.filter((id) => answer.members!.includes(id));
      if (inPanelOrder.some((id, index) => id !== answer.members![index])) {
        throw new Error("shrink members must preserve panel order");
      }
    } else if (answer.members !== undefined) {
      throw new Error("approve does not accept a members list");
    }

    // The human just answered this gate, so the resume is a manual-mode
    // continuation no matter what the settings say now: `--auto-approve` on a
    // gate-answering resume would compile the gate as an auto-approve activity
    // and silently discard the answer (e.g. a panel shrink).
    const settings: ServerSettings = {
      ...(record.executionSettings ?? this.settings.get()),
      panelConfirmation: "manual",
    };
    const command = this.command(record, "resume", settings, answer);
    const number = (record.submissionCount ?? 1) + 1;
    const script = this.writeScript(
      record,
      `submit-resume-${number - 1}.sh`,
      command,
      settings.slurmTemplate,
    );
    await this.submitScript(record, script, settings);
    record.status = "running";
    record.submissionCount = number;
    delete record.gateAutoApprove;
    record.updatedAt = this.now();
    this.write(record);
    return this.detail(jobId);
  }

  /**
   * Called by the server poller: starts the auto-approve countdown when a
   * suspended gate is first observed, and approves the panel as seated when
   * the deadline passes without any user interaction. A held countdown
   * (heldAt set) never fires — "the whole timeout idea stops".
   */
  async autoApproveDueGates(): Promise<void> {
    for (const record of this.jobs.values()) {
      if (record.trashedAt !== undefined) continue;
      if (
        record.status !== "suspended" &&
        record.status !== "running" &&
        record.status !== "queued"
      ) {
        continue;
      }
      const checkpoint = this.checkpoint(record.jobId);
      const gate =
        checkpoint?.status === "suspended" ? checkpoint.pendingGates[0] : undefined;
      if (!gate) {
        if (record.gateAutoApprove !== undefined) {
          delete record.gateAutoApprove;
          record.updatedAt = this.now();
          this.write(record);
        }
        continue;
      }
      const marker = record.gateAutoApprove;
      if (!marker || marker.gateKey !== gate.gateKey) {
        // Handover grace: a gate observed right after server start may have
        // been raised while no server was running (a shift handover, a
        // restart) — arming the countdown immediately would auto-approve it
        // before a human could possibly have seen it. Wall clock, not
        // this.now(): the grace is about real elapsed operator time.
        if (Date.now() - this.startedAt < this.gateAutoApproveGraceMs) continue;
        record.gateAutoApprove = {
          gateKey: gate.gateKey,
          deadlineAt: this.now() + this.panelAutoApproveMs,
          totalMs: this.panelAutoApproveMs,
        };
        record.updatedAt = this.now();
        this.write(record);
        continue;
      }
      if (marker.heldAt !== undefined) continue;
      if (this.now() < marker.deadlineAt) continue;
      if (this.autoResuming.has(record.jobId)) continue;
      this.autoResuming.add(record.jobId);
      try {
        await this.answerGate(record.jobId, {
          gateKey: gate.gateKey,
          action: "approve",
        });
      } catch (error) {
        this.warning(
          record,
          `Automatic gate approval failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        record.updatedAt = this.now();
        this.write(record);
      } finally {
        this.autoResuming.delete(record.jobId);
      }
    }
  }

  /**
   * Permanently pauses a pending gate's auto-approve countdown: the user
   * clicked into the confirmation card (or its pause control), so the run
   * waits for an explicit decision from here on.
   */
  async holdGateAutoApprove(jobId: string): Promise<JobDetail> {
    const record = this.record(jobId);
    if (record.trashedAt !== undefined) {
      throw new JobConflictError(`job "${jobId}" is in the trash`);
    }
    const checkpoint = this.checkpoint(jobId);
    const gate =
      checkpoint?.status === "suspended" ? checkpoint.pendingGates[0] : undefined;
    if (!gate) {
      throw new JobConflictError(`job "${jobId}" is not waiting on a gate`);
    }
    if (record.gateAutoApprove?.heldAt === undefined) {
      record.gateAutoApprove = {
        gateKey: gate.gateKey,
        deadlineAt: record.gateAutoApprove?.deadlineAt ?? this.now(),
        totalMs: record.gateAutoApprove?.totalMs ?? this.panelAutoApproveMs,
        heldAt: this.now(),
      };
      record.updatedAt = this.now();
      this.write(record);
    }
    return this.detail(jobId);
  }
}
