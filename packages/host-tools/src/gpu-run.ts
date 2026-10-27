/**
 * gpu_run: submit an agent-authored script to the deployment's GPU queue.
 *
 * The deployment owner completes a SLURM submission template in Settings
 * (partition, GPU count, environment setup) with an {{AGENT_COMMAND}} tag
 * where the agent's script belongs. This tool splices the agent's script in
 * VERBATIM, submits the rendered script with a host-enforced wall-clock
 * ceiling, waits for the job to finish, and returns a bounded stdout/stderr
 * tail. Each task has a durable submission budget; unresolved jobs block
 * replacement submissions, including after a worker restart.
 *
 * The failure contract is deliberate and explicit: a failed job comes back
 * as a BUG REPORT addressed to the submitting agent — the diagnostic log,
 * the terminal state, and the standing instruction that the submitter owns
 * debugging its script and may resubmit a corrected version. The host never
 * edits or retries the script on the agent's behalf.
 */
import {
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type {
  HostToolManifest,
  JsonValue,
  Tool,
  ToolResult,
} from "@brainstorm-agentic/core";

import {
  runProcess,
  scrubbedEnvironment,
  type ExecutionResult,
} from "./code-execution.js";

/** The tag the GPU template must contain; replaced by the agent's script. */
export const AGENT_COMMAND_TAG = "{{AGENT_COMMAND}}";

/** Cap for the returned job log; the TAIL survives (results print last). */
const MAX_LOG_CHARS = 48_000;

/** Scheduler command budget (sbatch/squeue/sacct/scancel invocations). */
const SCHEDULER_COMMAND_TIMEOUT_MS = 30_000;

/** Default allowance for the job to WAIT in the queue before it runs. */
const DEFAULT_MAX_QUEUE_WAIT_MS = 15 * 60_000;

/** Local-filesystem grace after queue exit; never delays the first accounting query. */
const DEFAULT_QUEUE_GONE_GRACE_MS = 15_000;

/**
 * Loop TICK: how often the wait loop wakes to check abort, deadline, and
 * the log file. Cheap local work only — never a scheduler call.
 */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Scheduler cadences, phase-dependent. Shared clusters treat seconds-scale
 * squeue polling as abuse (LRZ policy recommends ~10-minute intervals and
 * names high-frequency polling bannable), so squeue runs on its own clock,
 * far slower than the tick: every minute while the job waits in the queue
 * (start detection), every five once the job's log file exists (it is
 * running; only completion remains to be noticed, and GPU jobs run for
 * tens of minutes). A 1h job costs ~25 scheduler calls instead of ~720.
 */
const DEFAULT_QUEUED_SCHEDULER_POLL_MS = 60_000;
const DEFAULT_RUNNING_SCHEDULER_POLL_MS = 300_000;

/** Job states that mean the probe is still on its way through the queue. */
const LIVE_STATES = /^(PENDING|CONFIGURING|RUNNING|COMPLETING|SUSPENDED|RESIZING)/i;
const TERMINAL_STATES = /^(BOOT_FAIL|CANCELLED|COMPLETED|DEADLINE|FAILED|NODE_FAIL|OUT_OF_MEMORY|PREEMPTED|REVOKED|SPECIAL_EXIT|TIMEOUT)(?:\+|$)/i;

export type RunSchedulerCommand = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<ExecutionResult>;

export interface GpuRunConfig {
  /** The user-completed submission template; must contain {{AGENT_COMMAND}}. */
  readonly template: string;
  /** Deployment ceiling for one job's wall-clock runtime, in minutes. */
  readonly timeLimitMinutes: number;
  /** Durable submission ceiling per run/task. Defaults to two attempts. */
  readonly maxSubmissionsPerTask?: number;
  /** Directory job scripts, logs, and script-written files live under. */
  readonly jobsRoot: string;
  /** Environment for scheduler commands (scrubbed before use). */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: scheduler command runner (sbatch/squeue/sacct/scancel). */
  readonly runCommand?: RunSchedulerCommand;
  /** Test seam: loop tick (abort/deadline/log checks; no scheduler calls). */
  readonly pollIntervalMs?: number;
  /** Scheduler cadence while the job waits in the queue. Default 60s. */
  readonly queuedPollIntervalMs?: number;
  /** Scheduler cadence once the job's log exists (it runs). Default 5 min. */
  readonly runningPollIntervalMs?: number;
  /** Test seam: grace after the job leaves the queue. */
  readonly queueGoneGraceMs?: number;
  /** Test seam: how long the job may wait in the queue before running. */
  readonly maxQueueWaitMs?: number;
  /** Test seams: clock and sleep. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Observational hooks for setup/probe progress; never authorize execution. */
  readonly onSubmitted?: (job: { jobId: string; cluster?: string; jobDir: string }) => void;
  readonly onState?: (job: { jobId: string; state: string; detail?: string }) => void;
  /** sbatch may have accepted a job before its reply was lost; blocks retries. */
  readonly onSubmissionUnknown?: (job: { submissionToken: string; jobDir: string; jobId?: string; cluster?: string }) => void;
}

/**
 * Multi-cluster SLURM helpers. On sites running several SLURM clusters
 * (e.g. LRZ CoolMUC-4: cm4/serial/inter), sbatch reports where a job
 * landed ("Submitted batch job N on cluster X"); every later squeue/sacct/
 * scancel must then carry -M X or the job is invisible. -M output prefixes
 * a "CLUSTER: X" banner line that state parsers must ignore.
 */
export function slurmClusterFrom(sbatchStdout: string): string | undefined {
  return /Submitted batch job\s+\S+\s+on cluster\s+(\S+)/.exec(sbatchStdout)?.[1]
    ?? /^\d+;([A-Za-z0-9_.-]+)$/m.exec(sbatchStdout.trim())?.[1];
}

/** Drops "CLUSTER: X" banner lines from squeue/sacct output. */
export function stripSlurmClusterBanners(output: string): string {
  return output
    .split("\n")
    .filter((line) => !/^\s*CLUSTER\s*:/i.test(line))
    .join("\n");
}

/** The -M argument list for a captured cluster (empty when single-cluster). */
export function slurmClusterArgs(cluster: string | undefined): readonly string[] {
  return cluster === undefined ? [] : ["-M", cluster];
}

/** Exact ownership match for squeue -h -u USER -o %i|%k reconciliation. */
export function gpuSubmissionJobIds(output: string, submissionToken: string): readonly string[] {
  return [...new Set(stripSlurmClusterBanners(output).split("\n").flatMap((line) => {
    const [id = "", comment = ""] = line.trim().split("|");
    return /^\d+$/.test(id.trim()) && comment.trim() === submissionToken ? [id.trim()] : [];
  }))];
}

/** Splices the agent's script into the user's template, verbatim. */
export function renderGpuTemplate(template: string, script: string): string {
  const index = template.indexOf(AGENT_COMMAND_TAG);
  if (index < 0) {
    throw new Error(`GPU template must contain ${AGENT_COMMAND_TAG}`);
  }
  return `${template.slice(0, index)}${script}${template.slice(
    index + AGENT_COMMAND_TAG.length,
  )}`;
}

/**
 * The standing debug-and-relaunch instruction attached to every failed job.
 * The orchestrator's side of the contract: the bug goes back to the
 * submitter with permission to relaunch while they resolve it.
 */
function bugReport(jobId: string, state: string): string {
  return (
    `GPU job ${jobId} ended in state ${state}. This result is a bug report addressed to ` +
    "you, the submitter: the log above is a bounded diagnostic tail. If it demonstrates " +
    "a script bug, correct it before considering another submission within the task's " +
    "remaining budget (two attempts by default). A scheduler or partition problem " +
    "requires deployment recovery; report it rather than retrying blindly. Never " +
    "resubmit while an earlier job has an unresolved state."
  );
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("gpu_run cancelled");
  error.name = "AbortError";
  return error;
}

function refusal(message: string): ToolResult {
  return { output: message, isError: true };
}

interface JobReservation {
  readonly jobDir: string;
  readonly submissionToken: string;
  readonly record: Record<string, unknown>;
}

/**
 * Reserve the attempt durably before the first asynchronous operation. The
 * exclusive directory also serializes separate workers on shared storage.
 * A crash while reserving leaves a lock for explicit inspection, never a
 * silent budget reset or a replacement allocation.
 */
function reserveJob(config: GpuRunConfig, runId: string, taskId: string | undefined, script: string, createdAt: number): JobReservation | ToolResult {
  mkdirSync(config.jobsRoot, { recursive: true });
  let lock: string | undefined;
  if (taskId !== undefined) {
    const root = join(config.jobsRoot, ".task-locks");
    mkdirSync(root, { recursive: true });
    const key = createHash("sha256").update(JSON.stringify([runId, taskId])).digest("hex");
    const path = join(root, key);
    try { mkdirSync(path); lock = path; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return { isError: true, output: { failure: "task-reservation-busy", runId, taskId, lockPath: path,
        message: "Another worker is reserving a GPU attempt for this task, or a reservation was interrupted. Inspect its lock and existing job records before retrying; no new job was submitted." } };
    }
  }
  try {
    if (taskId !== undefined) {
      const records: Array<{ path: string; value: Record<string, unknown> }> = [];
      for (const name of readdirSync(config.jobsRoot).filter((entry) => entry.startsWith("job-"))) {
        const path = join(config.jobsRoot, name, "job-state.json");
        try {
          const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
          if (value.runId === runId && value.taskId === taskId) records.push({ path, value });
        } catch {
          return { isError: true, output: { failure: "job-record-unreadable", recordPath: path,
            message: "A previous GPU job record cannot be read. Inspect it before submitting another job; its ownership and completion cannot be verified." } };
        }
      }
      const unresolved = records.find(({ value }) => typeof value.state !== "string"
        || (!TERMINAL_STATES.test(value.state) && !["SUBMISSION_FAILED", "SUBMISSION_CANCELLED"].includes(value.state)));
      if (unresolved) return { isError: true, output: { failure: "existing-job", runId, taskId,
        recordPath: unresolved.path, state: String(unresolved.value.state ?? "UNKNOWN"),
        ...(typeof unresolved.value.jobId === "string" ? { jobId: unresolved.value.jobId } : {}),
        ...(typeof unresolved.value.cluster === "string" ? { cluster: unresolved.value.cluster } : {}),
        ...(typeof unresolved.value.submissionToken === "string" ? { submissionToken: unresolved.value.submissionToken } : {}),
        message: "This task already owns a GPU job whose completion is unresolved. Inspect and reconcile that job; no replacement was submitted and the existing job was not cancelled." } };
      const limit = config.maxSubmissionsPerTask ?? 2;
      if (records.length >= limit) return { isError: true, output: { failure: "submission-budget", runId, taskId,
        submissions: records.length, limit,
        message: `This task has used its ${limit}-submission GPU budget. Report the diagnostics; further submissions require an explicit host configuration change.` } };
    }
    const jobDir = mkdtempSync(join(config.jobsRoot, `job-${createdAt}-`));
    const submissionToken = `brain-gpu:${randomUUID()}`;
    const record = { version: 1, runId, ...(taskId !== undefined ? { taskId } : {}), createdAt, updatedAt: createdAt, submissionToken, state: "SUBMITTING" };
    writeFileSync(join(jobDir, "job.sh"), script, { encoding: "utf8", mode: 0o755 });
    writeFileSync(join(jobDir, "job-state.json"), JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    return { jobDir, submissionToken, record };
  } finally { if (lock) rmdirSync(lock); }
}

/** Tail-biased log read: results print last, so the end survives the cap. */
function readJobLog(path: string): { log: string; truncated: boolean } {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const bytes = Math.min(size, MAX_LOG_CHARS * 4);
    const buffer = Buffer.alloc(bytes);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, bytes, Math.max(0, size - bytes));
    const text = buffer.toString("utf8");
    const truncated = size > bytes || text.length > MAX_LOG_CHARS;
    return { log: truncated ? `…${text.slice(-MAX_LOG_CHARS)}` : text, truncated };
  } catch {
    return { log: "", truncated: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Files the agent's script left in the job directory (its own artifacts). */
function jobArtifacts(jobDir: string): readonly { name: string; bytes: number }[] {
  try {
    return readdirSync(jobDir)
      .filter((name) => !["job.sh", "job.log", "job-state.json", "job-state.json.tmp"].includes(name))
      .map((name) => {
        try {
          const stats = statSync(join(jobDir, name));
          return { name, bytes: stats.isFile() ? stats.size : 0 };
        } catch {
          return { name, bytes: 0 };
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export const GPU_RUN_MANIFEST: HostToolManifest = {
  toolId: "gpu_run",
  displayName: "GPU Run (host)",
  operations: ["gpu.run"],
  risk: "high",
  defaultEnabled: false,
  definition: {
    name: "gpu_run",
    description:
      "Submit a self-contained bash script to this deployment's GPU queue and wait for it " +
      "to finish. YOUR SCRIPT RUNS VERBATIM: it is spliced unchanged into the deployment " +
      "owner's GPU submission template (partition, GPU count, environment setup come from " +
      "that template) and runs under a wall-clock ceiling. The response returns the job's " +
      "stdout/stderr tail, limited to 48000 characters; print final results and useful " +
      "diagnostics near the end. Files your script writes are listed by name but their " +
      "content is not returned. Each task has two submission attempts by default, " +
      "persisted across retries and restarts. Diagnose a confirmed script failure before " +
      "considering a corrected submission within that budget. An unresolved job blocks " +
      "replacement submissions. Scheduler errors and ambiguous submissions require " +
      "reconciliation, not blind resubmission.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "Self-contained bash script body. Runs verbatim inside the deployment's GPU " +
            "submission template, with the job directory as the working directory.",
        },
        time_limit_minutes: {
          type: "integer",
          minimum: 1,
          description:
            "Requested wall-clock limit in minutes; silently capped at the deployment's ceiling.",
        },
        job_name: {
          type: "string",
          description: "Short job name for the scheduler and logs.",
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
};

export const GPU_RUN_MANIFESTS: readonly HostToolManifest[] = [GPU_RUN_MANIFEST];

export const GPU_RUN_TOOL_NAMES: readonly string[] = [GPU_RUN_MANIFEST.toolId];

export function gpuRunTools(config: GpuRunConfig): readonly Tool[] {
  if (config.maxSubmissionsPerTask !== undefined && (!Number.isInteger(config.maxSubmissionsPerTask) || config.maxSubmissionsPerTask < 1)) {
    throw new Error("maxSubmissionsPerTask must be a positive integer");
  }
  const env = scrubbedEnvironment(config.env ?? process.env);
  const run: RunSchedulerCommand =
    config.runCommand ??
    ((command, args, options) => runProcess(command, [...args], { ...options, env }));
  const sleep = config.sleep ?? defaultSleep;
  const now = config.now ?? (() => Date.now());
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const queuedPollIntervalMs =
    config.queuedPollIntervalMs ?? DEFAULT_QUEUED_SCHEDULER_POLL_MS;
  const runningPollIntervalMs =
    config.runningPollIntervalMs ?? DEFAULT_RUNNING_SCHEDULER_POLL_MS;
  const queueGoneGraceMs = config.queueGoneGraceMs ?? DEFAULT_QUEUE_GONE_GRACE_MS;
  const maxQueueWaitMs = config.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS;

  const tool: Tool = {
    definition: GPU_RUN_MANIFEST.definition,
    async execute(input, context): Promise<ToolResult> {
      const args = (input ?? {}) as {
        script?: unknown;
        time_limit_minutes?: unknown;
        job_name?: unknown;
      };
      if (typeof args.script !== "string" || args.script.trim() === "") {
        return refusal("script must be a non-empty bash script body");
      }
      if (
        args.time_limit_minutes !== undefined &&
        (!Number.isInteger(args.time_limit_minutes) || (args.time_limit_minutes as number) < 1)
      ) {
        return refusal("time_limit_minutes must be a positive integer");
      }
      const requested = (args.time_limit_minutes as number | undefined) ?? config.timeLimitMinutes;
      const minutes = Math.max(1, Math.min(requested, config.timeLimitMinutes));
      const jobName =
        typeof args.job_name === "string" && args.job_name.trim() !== ""
          ? args.job_name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48)
          : "brain-gpu";

      let script: string;
      try {
        script = renderGpuTemplate(config.template, args.script);
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }

      const signal = context.signal;
      if (signal?.aborted) throw abortError();
      const reserved = reserveJob(config, context.runId, context.taskId, script, now());
      if (!("jobDir" in reserved)) return reserved;
      const { jobDir, submissionToken, record } = reserved;
      const scriptPath = join(jobDir, "job.sh");
      const logPath = join(jobDir, "job.log");
      const save = (state: string, fields: Record<string, unknown> = {}): void => {
        Object.assign(record, fields, { state, updatedAt: now() });
        writeFileSync(join(jobDir, "job-state.json.tmp"), JSON.stringify(record, null, 2), { mode: 0o600 });
        renameSync(join(jobDir, "job-state.json.tmp"), join(jobDir, "job-state.json"));
        if (typeof record.jobId === "string") {
          try { config.onState?.({ jobId: record.jobId, state,
            ...(typeof fields.detail === "string" ? { detail: fields.detail } : {}) }); } catch { /* observer */ }
        }
      };
      const unknownSubmission = (detail: string, jobId?: string, cluster?: string): ToolResult => {
        save("SUBMISSION_UNKNOWN", { detail, ...(jobId ? { jobId } : {}), ...(cluster ? { cluster } : {}) });
        try { config.onSubmissionUnknown?.({ submissionToken, jobDir, ...(jobId ? { jobId } : {}), ...(cluster ? { cluster } : {}) }); } catch { /* observer */ }
        return { isError: true, output: { failure: "submission-unknown", state: "SUBMISSION_UNKNOWN", cleanupRequired: true,
          submissionToken, jobDir, ...(jobId ? { jobId } : {}), ...(cluster ? { cluster } : {}), detail,
          message: "The submission response was lost or unrecognized. A job may exist; do not retry until the exact submission comment has been reconciled with SLURM." } };
      };
      let submitted: ExecutionResult;
      if (signal?.aborted) { save("SUBMISSION_CANCELLED"); throw abortError(); }
      try {
        submitted = await run(
          "sbatch",
          [
            "--parsable",
            `--comment=${submissionToken}`,
            `--job-name=${jobName}`,
            `--time=${minutes}`,
            `--output=${logPath}`,
            `--error=${logPath}`,
            `--chdir=${jobDir}`,
            "--mail-type=NONE",
            scriptPath,
          ],
          { cwd: jobDir, timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS, signal },
        );
      } catch (error) {
        if (signal?.aborted || !["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException)?.code ?? "")) {
          return unknownSubmission(error instanceof Error ? error.message : String(error));
        }
        save("SUBMISSION_FAILED", { detail: error instanceof Error ? error.message : String(error) });
        // Spawn-level failure: sbatch is not on this node's PATH. A
        // deployment problem, never the script's bug — say so.
        return {
          output: {
            failure: "submission",
            message:
              "GPU submission failed before your script ran: sbatch is not available on " +
              "this host. This is a deployment problem, NOT a bug in your script — report " +
              "it in your output; do not rewrite the script to work around it.",
            detail: error instanceof Error ? error.message : String(error),
          },
          isError: true,
        };
      }
      const match = /^(\d+)(?:;[A-Za-z0-9_.-]+)?$/m.exec(submitted.stdout.trim())
        ?? /Submitted batch job\s+(\d+)\b/.exec(submitted.stdout);
      if (submitted.exitCode !== 0 || !match) {
        if (submitted.timedOut || signal?.aborted || submitted.exitCode === 128 || submitted.exitCode === 0 || match) {
          return unknownSubmission([submitted.stdout, submitted.stderr].filter(Boolean).join("\n"), match?.[1], slurmClusterFrom(submitted.stdout));
        }
        save("SUBMISSION_FAILED", {
          detail: [submitted.stdout, submitted.stderr].filter(Boolean).join("\n"),
        });
        return {
          output: {
            failure: "submission",
            message:
              "The scheduler rejected the GPU job before your script ran (check the " +
              "deployment's GPU template: partition, account, QOS). This is a deployment " +
              "problem, NOT a bug in your script — report it in your output; do not " +
              "rewrite the script to work around it.",
            detail: [submitted.stdout.trim(), submitted.stderr.trim()]
              .filter(Boolean)
              .join("\n"),
          },
          isError: true,
        };
      }
      const jobId = match[1]!;
      // Multi-cluster sites report the landing cluster; later scheduler
      // commands need it or the job is invisible to them.
      const cluster = slurmClusterFrom(submitted.stdout);
      const clusterArgs = slurmClusterArgs(cluster);
      try { save("SUBMITTED", { jobId, ...(cluster ? { cluster } : {}) }); }
      catch (error) {
        // Ownership must become durable before a worker is allowed to wait.
        await run("scancel", [...clusterArgs, jobId], { cwd: jobDir, timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS }).catch(() => undefined);
        throw error;
      }
      try { config.onSubmitted?.({ jobId, ...(cluster ? { cluster } : {}), jobDir }); } catch { /* observer */ }

      const queueDeadline = now() + maxQueueWaitMs;
      const startedAt = now();
      let runningAt: number | undefined;
      let goneSince: number | undefined;
      let terminalConfirmed = false;
      let cancelled = false;
      let schedulerErrors = 0;
      let confirmedAccounting: { state: string; exitCode?: string } | undefined;
      const modernSubmission = /^\d+(?:;[A-Za-z0-9_.-]+)?$/m.test(submitted.stdout.trim());
      const readAccounting = async (): Promise<{ state: string; exitCode?: string } | undefined> => {
        const result = await run("sacct", ["-n", "-P", "-X", "-j", jobId, "--format=JobIDRaw,State,ExitCode", ...clusterArgs], {
          cwd: jobDir, timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS, ...(signal ? { signal } : {}),
        }).catch(() => undefined);
        if (!result || result.exitCode !== 0) return undefined;
        const lines = stripSlurmClusterBanners(result.stdout).trim().split("\n");
        const row = lines.map((line) => line.trim().split("|")).find((values) => values[0] === jobId);
        if (row) {
          if (!/^\d+:\d+$/.test(row[2]?.trim() ?? "")) return undefined;
          return { state: row[1]?.trim().split(/\s/)[0] || "UNKNOWN", exitCode: row[2]!.trim() };
        }
        // Older scheduler wrappers may ignore --format; accept only a state token.
        const state = lines[0]?.trim().split(/\s/)[0];
        return !modernSubmission && state && /^[A-Z_]+\+?$/.test(state) ? { state } : undefined;
      };
      const cancel = async (reason: string): Promise<void> => {
        if (cancelled || terminalConfirmed) return;
        cancelled = true;
        try {
          const result = await run("scancel", [...clusterArgs, jobId], {
            cwd: jobDir, timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS,
          });
          save(result.exitCode === 0 ? "CANCEL_REQUESTED" : "CANCEL_FAILED", {
            reason, cancellationAccepted: result.exitCode === 0,
            ...(result.exitCode !== 0 ? { detail: result.stderr || result.stdout } : {}),
          });
        } catch (error) {
          save("CANCEL_FAILED", { reason, cancellationAccepted: false,
            detail: error instanceof Error ? error.message : String(error) });
        }
      };
      // The scheduler runs on its own, much slower clock than the loop
      // tick: the tick stays responsive to aborts and the deadline, while
      // squeue fires only when its phase cadence elapses (queued vs
      // running, running detected by the log file's existence).
      let lastSchedulerPollAt = Number.NEGATIVE_INFINITY;
      try {
      for (;;) {
        if (signal?.aborted) {
          throw abortError();
        }
        if (runningAt === undefined && existsSync(logPath)) {
          runningAt = now();
          if (["SUBMITTED", "PENDING", "CONFIGURING"].includes(String(record.state))) {
            save("EXECUTION_OBSERVED", { detail: "The job log appeared; awaiting the next scheduler status update." });
          }
        }
        if (goneSince !== undefined) {
          // A terminal accounting record is authoritative; only shared-file
          // visibility may still need a short local wait. Do not pay another
          // scheduler polling interval for this grace period.
          const logVisible = readJobLog(logPath).log.length > 0;
          if ((confirmedAccounting && logVisible) || now() - goneSince >= queueGoneGraceMs) break;
          await sleep(pollIntervalMs, signal);
          continue;
        }
        const deadline = runningAt === undefined ? queueDeadline : runningAt + minutes * 60_000 + 60_000;
        if (now() > deadline) {
          // A short job can finish between slow scheduler polls. Reconcile
          // once before enforcing the local deadline so stale monitoring
          // cannot turn an already completed job into a false timeout.
          const accounting = await readAccounting();
          if (accounting && TERMINAL_STATES.test(accounting.state)) {
            confirmedAccounting = accounting;
            terminalConfirmed = true;
            goneSince = now();
            save("FINALIZING", { detail: `Accounting reports ${accounting.state}; collecting the job log.` });
            continue;
          }
          await cancel(runningAt === undefined ? "queue deadline" : "runtime deadline");
          const { log, truncated } = readJobLog(logPath);
          return {
            output: {
              jobId,
              state: "DEADLINE",
              cancellationAccepted: record.cancellationAccepted === true,
              cleanupRequired: record.cancellationAccepted !== true,
              log,
              truncated,
              files: jobArtifacts(jobDir) as unknown as JsonValue,
              bugReport:
                `GPU job ${jobId} exceeded its window (${runningAt === undefined ? "queue wait" : `${minutes}-minute runtime ceiling`}). ` +
                (record.cancellationAccepted === true
                  ? "The scheduler accepted a cancellation request. Inspect the log and confirm the job stopped before considering a corrected submission."
                  : "Cancellation failed; the job may still be active. Do not resubmit until its state is checked and cleanup completed."),
            },
            isError: true,
          };
        }
        // Queued and just-left-the-queue phases poll faster (start and end
        // detection); a running job (log file exists) needs the scheduler
        // only to notice completion, so it polls slowest.
        const schedulerCadence =
          goneSince === undefined && existsSync(logPath)
            ? runningPollIntervalMs
            : queuedPollIntervalMs;
        if (now() - lastSchedulerPollAt >= schedulerCadence) {
          lastSchedulerPollAt = now();
          const queueResult = await run(
            "squeue",
            ["-h", "-j", jobId, "-o", "%T", ...clusterArgs],
            {
              cwd: jobDir,
              timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS,
              ...(signal ? { signal } : {}),
            },
          ).catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: String(error) }));
          if (queueResult.exitCode !== 0) {
            // Some SLURM versions return an error once the job leaves squeue.
            // Only a terminal allocation record, never that error, proves exit.
            const accounting = await readAccounting();
            if (accounting && TERMINAL_STATES.test(accounting.state)) {
              confirmedAccounting = accounting;
              terminalConfirmed = true;
              goneSince = now();
              save("FINALIZING", { detail: `Accounting reports ${accounting.state}; collecting the job log.` });
              continue;
            }
            schedulerErrors += 1;
            save("MONITORING_ERROR", { detail: queueResult.stderr || queueResult.stdout });
            if (schedulerErrors >= 3) throw new Error(`SLURM monitoring failed three times: ${queueResult.stderr}`);
            await sleep(pollIntervalMs, signal);
            continue;
          }
          schedulerErrors = 0;
          const queueState = stripSlurmClusterBanners(queueResult.stdout).trim() || undefined;
          if (queueState && LIVE_STATES.test(queueState)) {
            if (/^(RUNNING|COMPLETING|SUSPENDED|RESIZING)/i.test(queueState)) runningAt ??= now();
            if (record.state !== queueState) save(queueState);
            goneSince = undefined;
          } else {
            goneSince = now();
            save("FINALIZING", { detail: "The job is no longer listed in the queue; checking accounting and collecting its log." });
            // A successful empty squeue response warrants accounting NOW.
            // The old path waited another full scheduler interval here,
            // leaving a three-second probe displayed as pending for minutes.
            const accounting = await readAccounting();
            if (accounting && TERMINAL_STATES.test(accounting.state)) {
              confirmedAccounting = accounting;
              terminalConfirmed = true;
            }
            continue;
          }
        }
        await sleep(pollIntervalMs, signal);
      }

      let state = confirmedAccounting?.state ?? "UNKNOWN";
      let exitCode = confirmedAccounting?.exitCode;
      for (let attempt = 0; attempt < 3 && confirmedAccounting === undefined; attempt += 1) {
      if (signal?.aborted) throw abortError();
      const accounting = await readAccounting();
      if (accounting) { state = accounting.state; exitCode = accounting.exitCode; }
      if (TERMINAL_STATES.test(state)) break;
      if (attempt < 2) await sleep(queuedPollIntervalMs, signal);
      }
      terminalConfirmed = TERMINAL_STATES.test(state);
      if (!terminalConfirmed) await cancel("accounting could not confirm completion");
      else save(state, { ...(exitCode ? { exitCode } : {}) });
      const { log, truncated } = readJobLog(logPath);
      const durationMs = now() - startedAt;
      const files = jobArtifacts(jobDir) as unknown as JsonValue;

      if (/^COMPLETED/i.test(state) && (exitCode === undefined || exitCode === "0:0")) {
        return {
          output: { jobId, state: "COMPLETED", log, truncated, files, durationMs, ...(exitCode ? { exitCode } : {}) },
        };
      }
      return {
        output: {
          jobId,
          state,
          log,
          truncated,
          files,
          durationMs,
          ...(cancelled ? { cancellationAccepted: record.cancellationAccepted === true, cleanupRequired: record.cancellationAccepted !== true } : {}),
          ...(exitCode ? { exitCode } : {}),
          bugReport: terminalConfirmed ? bugReport(jobId, state)
            : `The scheduler has not confirmed that GPU job ${jobId} stopped. ` +
              (record.cancellationAccepted === true ? "It accepted a cancellation request. " : "Cancellation failed. ") +
              "Check its state before considering another submission; this is a monitoring problem, not evidence of a script bug.",
        },
        isError: true,
      };
      } catch (error) {
        await cancel(signal?.aborted ? "caller aborted" : "monitoring failed");
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
        const { log, truncated } = readJobLog(logPath);
        return { isError: true, output: { jobId, state: "MONITORING_ERROR", log, truncated,
          cancellationAccepted: record.cancellationAccepted === true, cleanupRequired: record.cancellationAccepted !== true,
          detail: error instanceof Error ? error.message : String(error),
          message: record.cancellationAccepted === true
            ? "The scheduler could not be monitored. The scheduler accepted a cancellation request; inspect job-state.json before submitting another job."
            : "The scheduler could not be monitored and cancellation failed. The job may still be active; resolve it before submitting another job." } };
      }
    },
  };
  return [tool];
}
