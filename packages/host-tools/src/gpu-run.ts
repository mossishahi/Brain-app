/**
 * gpu_run: submit an agent-authored script to the deployment's GPU queue.
 *
 * The deployment owner completes a SLURM submission template in Settings
 * (partition, GPU count, environment setup) with an {{AGENT_COMMAND}} tag
 * where the agent's script belongs. This tool splices the agent's script in
 * VERBATIM, submits the rendered script with a host-enforced wall-clock
 * ceiling, waits for the job to finish, and returns the job's complete
 * stdout/stderr log exactly as the script printed it — the agent owns the
 * structure of its own output.
 *
 * The failure contract is deliberate and explicit: a failed job comes back
 * as a BUG REPORT addressed to the submitting agent — the diagnostic log,
 * the terminal state, and the standing instruction that the submitter owns
 * debugging its script and may resubmit a corrected version. The host never
 * edits or retries the script on the agent's behalf.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Grace between "job left the queue" and judging its final state. */
const DEFAULT_QUEUE_GONE_GRACE_MS = 15_000;

const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Job states that mean the probe is still on its way through the queue. */
const LIVE_STATES = /^(PENDING|CONFIGURING|RUNNING|COMPLETING|SUSPENDED|RESIZING)/i;

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
  /** Directory job scripts, logs, and script-written files live under. */
  readonly jobsRoot: string;
  /** Environment for scheduler commands (scrubbed before use). */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: scheduler command runner (sbatch/squeue/sacct/scancel). */
  readonly runCommand?: RunSchedulerCommand;
  /** Test seam: queue poll interval. */
  readonly pollIntervalMs?: number;
  /** Test seam: grace after the job leaves the queue. */
  readonly queueGoneGraceMs?: number;
  /** Test seam: how long the job may wait in the queue before running. */
  readonly maxQueueWaitMs?: number;
  /** Test seams: clock and sleep. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
    "you, the submitter: the log above is the complete diagnostic. Debug your script from " +
    "it, fix the bug, and RESUBMIT the corrected script with another gpu_run call — " +
    "resubmitting is safe and expected while you resolve the bug (each submission gets a " +
    "fresh job directory). If the log shows a scheduler or partition problem rather than " +
    "a bug in your script, report that in your output instead of retrying blindly."
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

/** Tail-biased log read: results print last, so the end survives the cap. */
function readJobLog(path: string): { log: string; truncated: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { log: "", truncated: false };
  }
  if (text.length <= MAX_LOG_CHARS) return { log: text, truncated: false };
  return { log: `…${text.slice(-MAX_LOG_CHARS)}`, truncated: true };
}

/** Files the agent's script left in the job directory (its own artifacts). */
function jobArtifacts(jobDir: string): readonly { name: string; bytes: number }[] {
  try {
    return readdirSync(jobDir)
      .filter((name) => name !== "job.sh" && name !== "job.log")
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
      "complete stdout/stderr log EXACTLY as your script printed it — print your results " +
      "in the structure you want them returned, and print everything you need: files your " +
      "script writes are listed by name but their content is not returned. If the job " +
      "fails, the response is a bug report addressed to you, the submitter: debug from " +
      "the log, fix your script, and resubmit with another call — resubmitting is safe " +
      "while you resolve the bug.",
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
  const env = scrubbedEnvironment(config.env ?? process.env);
  const run: RunSchedulerCommand =
    config.runCommand ??
    ((command, args, options) => runProcess(command, [...args], { ...options, env }));
  const sleep = config.sleep ?? defaultSleep;
  const now = config.now ?? (() => Date.now());
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const queueGoneGraceMs = config.queueGoneGraceMs ?? DEFAULT_QUEUE_GONE_GRACE_MS;
  const maxQueueWaitMs = config.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS;
  let jobSeq = 0;

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

      jobSeq += 1;
      const jobDir = join(config.jobsRoot, `job-${now()}-${jobSeq}`);
      mkdirSync(jobDir, { recursive: true });
      const scriptPath = join(jobDir, "job.sh");
      const logPath = join(jobDir, "job.log");
      writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o755 });

      const signal = context.signal;
      let submitted: ExecutionResult;
      try {
        submitted = await run(
          "sbatch",
          [
            `--job-name=${jobName}`,
            `--time=${minutes}`,
            `--output=${logPath}`,
            "--mail-type=NONE",
            scriptPath,
          ],
          { cwd: jobDir, timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS, signal },
        );
      } catch (error) {
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
      const match = /Submitted batch job\s+(\S+)/.exec(submitted.stdout);
      if (submitted.exitCode !== 0 || !match) {
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

      const deadline = now() + maxQueueWaitMs + minutes * 60_000 + 60_000;
      const startedAt = now();
      let goneSince: number | undefined;
      for (;;) {
        if (signal?.aborted) {
          await run("scancel", [jobId], {
            cwd: jobDir,
            timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS,
          }).catch(() => undefined);
          throw abortError();
        }
        if (now() > deadline) {
          await run("scancel", [jobId], {
            cwd: jobDir,
            timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS,
          }).catch(() => undefined);
          const { log, truncated } = readJobLog(logPath);
          return {
            output: {
              jobId,
              state: "DEADLINE",
              log,
              truncated,
              files: jobArtifacts(jobDir) as unknown as JsonValue,
              bugReport:
                `GPU job ${jobId} exceeded its window (queue wait allowance plus the ` +
                `${minutes}-minute runtime ceiling) and was cancelled. If the log shows your ` +
                "script was still working, it overran its time limit — a bug to fix: make it " +
                "faster, checkpoint earlier, or request a higher time_limit_minutes (the " +
                "deployment ceiling still applies) and RESUBMIT with another gpu_run call. " +
                "If the job never started, the queue was congested — report that in your " +
                "output rather than retrying immediately.",
            },
            isError: true,
          };
        }
        const queueState = await run("squeue", ["-h", "-j", jobId, "-o", "%T"], {
          cwd: jobDir,
          timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        })
          .then((result) => result.stdout.trim() || undefined)
          .catch(() => undefined);
        if (queueState && LIVE_STATES.test(queueState)) {
          goneSince = undefined;
        } else {
          // Left the queue (or squeue is unusable): give the shared
          // filesystem a grace period to surface the log, then judge.
          goneSince ??= now();
          if (now() - goneSince > queueGoneGraceMs) break;
        }
        await sleep(pollIntervalMs, signal);
      }

      const finalState = await run("sacct", ["-n", "-j", jobId, "--format=State"], {
        cwd: jobDir,
        timeoutMs: SCHEDULER_COMMAND_TIMEOUT_MS,
      })
        .then((result) => result.stdout.trim().split(/\s+/)[0] ?? "")
        .catch(() => "");
      const state = finalState || "UNKNOWN";
      const { log, truncated } = readJobLog(logPath);
      const durationMs = now() - startedAt;
      const files = jobArtifacts(jobDir) as unknown as JsonValue;

      if (/^COMPLETED/i.test(state)) {
        return {
          output: { jobId, state: "COMPLETED", log, truncated, files, durationMs },
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
          bugReport: bugReport(jobId, state),
        },
        isError: true,
      };
    },
  };
  return [tool];
}
