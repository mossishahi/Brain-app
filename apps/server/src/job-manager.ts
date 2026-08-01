import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  execFile,
  spawn,
  type ExecFileOptions,
} from "node:child_process";

import type { WorkflowCheckpoint } from "@brainstorm-agentic/core";
import {
  isCreditLimitMessage,
  resolveCreditReset,
} from "@brainstorm-agentic/credit-recovery";
import {
  ATTACHMENT_LIMITS,
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
} from "./command.js";
import { atomicWriteFile, atomicWriteJson, readJsonFile } from "./files.js";
import type { JobRecord } from "./model.js";
import {
  SettingsStore,
  type AnthropicConnectionValidator,
  type ClaudeAgentConnectionValidator,
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
  readonly validateOpenRouter?: (
    apiKey: string,
    model: string,
  ) => Promise<void>;
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

  private async submitScript(
    record: JobRecord,
    script: string,
    settings: ServerSettings,
  ): Promise<void> {
    const executionEnv = this.settings.executionEnvironment(this.env, settings);
    if (record.runner === "slurm") {
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
    const settings = this.settings.get();
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
      return readJsonFile<WorkflowCheckpoint>(
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

  private async slurmAlive(id: string | undefined): Promise<boolean> {
    if (!id) return false;
    try {
      const queue = await execute("squeue", ["-h", "-j", id, "-o", "%T"], {
        env: this.env,
        timeout: 2_000,
      });
      if (queue.stdout.trim().length > 0) return true;
    } catch {
      // Fall through to accounting; clusters commonly purge squeue quickly.
    }
    try {
      const accounting = await execute(
        "sacct",
        ["-n", "-j", id, "--format=State"],
        { env: this.env, timeout: 2_000 },
      );
      return accounting.stdout
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
    if (checkpoint === "running" && record.autoResumePending) {
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
        : await this.slurmAlive(record.slurmJobId);
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

  async detail(jobId: string): Promise<JobDetail> {
    const record = this.record(jobId);
    const status = await this.reconcile(record);
    return buildJobDetail({
      record,
      status,
      sessionDir: this.sessionDir(jobId),
      jobDir: this.jobDir(jobId),
      settings: record.executionSettings ?? this.settings.get(),
    });
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
    const value = compactJobDetail(
      buildJobDetail({
        record,
        status,
        sessionDir: this.sessionDir(record.jobId),
        jobDir: this.jobDir(record.jobId),
        settings: record.executionSettings ?? this.settings.get(),
      }),
    );
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
        await execute("scancel", [record.slurmJobId], {
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
            : await this.slurmAlive(record.slurmJobId);
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
          : await this.slurmAlive(record.slurmJobId);
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

  async answerGate(jobId: string, answer: GateAnswerRequest): Promise<JobDetail> {
    const record = this.record(jobId);
    const detail = await this.detail(jobId);
    if (detail.status !== "suspended" || !detail.pendingGate) {
      throw new Error(`job "${jobId}" is not suspended on a gate`);
    }
    if (detail.pendingGate.gateKey !== answer.gateKey) {
      throw new Error(`job "${jobId}" has no pending gate "${answer.gateKey}"`);
    }
    const panelIds = detail.pendingGate.members?.map((member) => member.id) ?? [];
    if (answer.action === "shrink") {
      if (!answer.members || answer.members.length < 2) {
        throw new Error("shrink must keep at least two members");
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
    record.updatedAt = this.now();
    this.write(record);
    return this.detail(jobId);
  }
}
