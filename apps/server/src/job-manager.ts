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
  jobIsExecuting,
  PANEL_EDIT_LIMITS,
  type CustomSeatRequest,
  type GateAnswerRequest,
  type JobDetail,
  type JobStatus,
  type JobSummary,
  type LiveTextEntry,
  type PanelMemberView,
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
import { LiveTextStore } from "./live-text.js";
import { readJsonCached, statStamp } from "./read-cache.js";
import type { JobRecord } from "./model.js";
import {
  SettingsStore,
  type AnthropicConnectionValidator,
  type ClaudeAgentConnectionValidator,
  type CursorAgentConnectionValidator,
} from "./settings.js";
import {
  agentIdentity,
  buildJobDetail,
  compactJobDetail,
  liveIdentityPanel,
} from "./stage-mapper.js";

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

/**
 * Every agent node of the shipped workflow, mapped to the skill it runs.
 *
 * A live record carries only fragments, so the role behind a thread has to be
 * rebuilt from its execution path — and a path names the NODE while the role
 * labels are keyed by the SKILL. Those two vocabularies differ for every node
 * in the pipeline (`process-input` runs `processor`, `build-pool` runs
 * `pool-builder`), so anything missing from here is not merely unlabelled: it
 * is labelled WRONG, with a capitalized node id that no reader is looking for.
 *
 * A node this table does not know still gets a thread, because a bundle may add
 * a role before this app learns its name. `live-role.test.ts` fails when the
 * pinned bundle grows an agent node that is not listed here.
 */
export const LIVE_NODE_SKILLS: Readonly<Record<string, string>> = {
  "process-input": "processor",
  "classify-input": "classifier",
  "annotate-code": "code-annotator",
  "build-pool": "pool-builder",
  "place-fields": "placer",
  "develop-idea": "brain",
  "comment-step": "commentor",
  "comment-step-bridge": "interdisciplinary-commentor",
  "judge-step": "judge",
  "redevelop-idea": "redeveloper",
  "bridge-audit": "integrator",
  "synthesize-proposal": "chair",
};

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
  /** One live-text reader per job, created when a reader first asks. */
  private readonly liveStores = new Map<string, LiveTextStore>();
  /** Cached roster per job, for placing live threads. See livePanel(). */
  private readonly livePanels = new Map<
    string,
    { at: number; panel: readonly PanelMemberView[]; final: boolean }
  >();
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
      // Every mode: the attachment store is a resource of the job, and a resume
      // launched without it runs the rest of the pipeline with the submitted
      // files reported unavailable. When there is no manifest the builder says
      // so explicitly (--attachments none) instead of staying silent, so the
      // worker can tell "this submission had no files" from "this host cannot
      // see the ones it had".
      ...(existsSync(this.manifestPath(record.jobId))
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
      // Threaded here, in the one builder every submission path goes through,
      // so a dismissal survives a gate answer, a credit resume, a retry and an
      // interrupted-job resubmission without each having to remember it.
      ...(record.dismissedMembers !== undefined && record.dismissedMembers.length > 0
        ? { dismissedMembers: record.dismissedMembers }
        : {}),
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
    atomicWriteFile(
      path,
      renderSlurmTemplate(template, `${this.windDownPrologue()}${command}`),
      0o755,
    );
    return path;
  }

  /**
   * The shell that tells the worker when its host expires, prepended to the
   * command inside the operator's own template — which is where the command tag
   * already sits, safely after the last #SBATCH directive.
   *
   * The job's end time is asked for ONCE, at job start, because only then is it
   * known: a job's walltime starts when it starts, and this one may have waited
   * hours in the queue. Everything is conditional and nothing is fatal — a
   * workstation run, a scheduler that will not say, or a `date` that cannot parse
   * the stamp all simply leave the variable unset, and the run behaves exactly as
   * it did before this existed.
   */
  private windDownPrologue(): string {
    const lead = this.windDownLeadSeconds;
    if (lead <= 0) return "";
    return [
      "# The run stops STARTING work this long before the allocation ends, so it",
      "# exits with nothing in flight instead of being killed mid-task and buying",
      "# every unjournalled call again on the resume.",
      "_bsa_lead=__LEAD__",
      "if [ -n \"${SLURM_JOB_ID:-}\" ] && command -v scontrol >/dev/null 2>&1; then",
      "  _bsa_end=$(scontrol -o show job \"$SLURM_JOB_ID\" 2>/dev/null | tr ' ' '\\n' | sed -n 's/^EndTime=//p' | head -1)",
      "  if [ -n \"${_bsa_end:-}\" ] && [ \"$_bsa_end\" != \"Unknown\" ]; then",
      "    _bsa_epoch=$(date -d \"$_bsa_end\" +%s 2>/dev/null || true)",
      "    if [ -n \"${_bsa_epoch:-}\" ]; then",
      "      export BRAINSTORM_AGENTIC_WIND_DOWN_AT_MS=$(( (_bsa_epoch - _bsa_lead) * 1000 ))",
      "      export BRAINSTORM_AGENTIC_WIND_DOWN_REASON=\"the host job ends at $_bsa_end\"",
      "      echo \"[submit] host ends $_bsa_end; winding down ${_bsa_lead}s before that\"",
      "    fi",
      "  fi",
      "fi",
      "",
    ].join("\n").replace("__LEAD__", String(lead));
  }

  /**
   * A submission's own name in the queue: the index first, so it survives
   * squeue's narrow NAME column, then the run it belongs to.
   *
   * Taken from the script FILENAME, which every submission path already numbers
   * uniquely (submit.sh, submit-resume-2.sh, submit-retry-3.sh,
   * submit-interrupted-resume-9.sh) — so the name in the queue and the file on
   * disk carry the same number, and counting handovers is reading one column.
   */
  private static jobNameFor(record: JobRecord, scriptPath: string): string {
    const file = scriptPath.slice(scriptPath.lastIndexOf("/") + 1);
    const index = /-(\d+)\.sh$/.exec(file)?.[1] ?? "1";
    const suffix = record.jobId.slice(-6);
    return `b${index}-${suffix}`;
  }

  /**
   * Claims one pre-queued held pilot and releases it against this job's
   * submit script. Claim = atomic rename of the pilot's `available/<jobid>`
   * marker, so two concurrent submissions can never seize the same pilot.
   * The pilot's own bootstrap (queued by deploy/lrz-queue-runway.sh) execs
   * `spool/<jobid>.sh`, which cds into the job directory and runs the same
   * rendered submit script an sbatch submission would have run.
   */
  /**
   * Never written into a job script, however the channel is built. Secrets ride
   * the scheduler environment or the owner-only credentials file; a spool script
   * lives on shared storage, so a name that looks like a credential is skipped
   * by rule rather than by remembering to list it.
   */
  private static secretEnvName(name: string): boolean {
    return /KEY|TOKEN|SECRET|PASSWORD/i.test(name);
  }

  /**
   * The execution environment as `export` lines for a submission channel that
   * cannot be handed an environment.
   *
   * Held pilots are queued long before the run exists and with `--export=NONE`,
   * so nothing is inherited: without this the worker received only what the
   * command string inlines, and every setting that travels as an environment
   * variable was silently lost on that deployment — the per-run capability
   * disables, the GPU template, the enabled host tools, the agent-SDK turn,
   * effort, thinking and USD BUDGET limits, the API base URL, and the telemetry
   * opt-out. Only what this server actually added is exported, and never a
   * secret: those still come from the credentials file.
   */
  private exportedEnvironment(executionEnv: NodeJS.ProcessEnv): string {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(executionEnv)) {
      if (value === undefined) continue;
      if (this.env[name] === value) continue; // inherited, not ours to restate
      if (JobManager.secretEnvName(name)) continue;
      lines.push(`export ${name}=${shellQuote(value)}`);
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }

  private async submitViaPilot(
    record: JobRecord,
    script: string,
    executionEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
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
        `#!/usr/bin/env bash\ncd ${shellQuote(this.jobDir(record.jobId))} || exit 1\n` +
          `${this.exportedEnvironment(executionEnv)}` +
          `exec bash ${shellQuote(script)}\n`,
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

  /**
   * Ends the host the record still names before a replacement is submitted.
   *
   * Every resubmission — retry, credit resume, interrupted resume, dismissal —
   * overwrites `slurmJobId` with the new host, so anything the previous id
   * referred to becomes unreachable the moment the new one lands. If that host
   * was still alive, the run now has TWO of them over one session directory,
   * and the orphan is invisible to the dashboard, to cancellation and to every
   * liveness check.
   *
   * That is not hypothetical: a worker that failed and then hung kept its SLURM
   * job RUNNING for hours, the submitter ordered a resume, and the two hosts ran
   * side by side until they were found by hand in the queue.
   *
   * A worker that failed of its own accord has to be reaped too, because the
   * hosting JOB can outlive it, so this asks the scheduler rather than the
   * record's status. Cancelling an id that has already finished is a no-op that
   * scancel reports as an error and stopWorker() swallows, which is the right
   * trade: one wasted call against a duplicated run.
   */
  /**
   * What the models are SAYING right now, framed for one reader.
   *
   * The store tails the worker's live-text file and holds only threads that are
   * still live; `seen` is this reader's own position in each, so a frame carries
   * the characters written since its last one and nothing else. A thread that has
   * ended is reported ended — the task's OUTPUT exists now, and that is what the
   * page shows instead.
   *
   * Nothing here is stored, and nothing reads it back. The annotation (who is
   * talking, and where) is the activity feed's, so the page can put a thread where
   * that agent already appears; the roster it needs is cached, because live frames
   * are frequent and a roster changes once per run.
   */
  async liveText(
    jobId: string,
    seen: Map<string, number>,
  ): Promise<readonly LiveTextEntry[]> {
    // Streamed text is what an agent is saying WHILE it says it, so a run that
    // is not executing has none. Readers still carrying threads are told they
    // ended — the alternative is a page holding a dead worker's last sentence
    // for the two minutes the store takes to expire it, and a new reader being
    // handed that whole sentence as if it were arriving now. Nothing is read
    // from disk until the run moves again.
    const record = this.jobs.get(jobId);
    if (record === undefined || !jobIsExecuting(record.status)) {
      if (seen.size === 0) return [];
      const ended = [...seen.keys()].map((id) => ({ id, ended: true as const }));
      seen.clear();
      return ended;
    }
    let store = this.liveStores.get(jobId);
    if (store === undefined) {
      store = new LiveTextStore(join(this.jobDir(jobId), "live-text.jsonl"), this.now);
      this.liveStores.set(jobId, store);
    }
    store.poll();
    const deltas = store.deltas(seen);
    if (deltas.length === 0) return [];
    const panel = await this.livePanel(jobId, deltas.map((delta) => delta.path));
    return deltas.map((delta) => ({
      id: delta.path,
      ...(delta.append !== undefined ? { append: delta.append } : {}),
      ...(delta.text !== undefined ? { text: delta.text } : {}),
      ...(delta.ended === true ? { ended: true as const } : {}),
      ...agentIdentity(delta.path, this.liveTaskKind(delta.path), panel),
    }));
  }

  /**
   * The role behind a live thread, from the leaf of its execution path — the one
   * thing a live record does not carry, because the worker writes only fragments.
   */
  private liveTaskKind(path: string): string | undefined {
    const leaf = /([^/]+)-execute$/.exec(path)?.[1];
    if (leaf === undefined) return undefined;
    // EVERY agent node, not just the reviewed ones. A path names the NODE, and
    // the role labels are keyed by the SKILL the node runs, so the two only
    // meet through this table. It once held the review nodes alone and let the
    // rest fall through to the node id: the processor's thread arrived labelled
    // "Process-input", the pool builder's "Build-pool", and the stage panels —
    // which look for the same words the activity feed shows — matched none of
    // them and rendered nothing. The activity rows were right the whole time,
    // because an event carries its task kind rather than rebuilding it.
    return `brainstorm.${LIVE_NODE_SKILLS[leaf] ?? leaf}`;
  }

  /**
   * The roster the live annotation needs, cached — the CONFIRMED panel, whose
   * order is what every seated path's `member[i]` indexes (liveIdentityPanel).
   *
   * A roster built after the confirmation gate is trusted for the life of the
   * run: seats are marked dismissed, never removed, so its indexes cannot
   * shift. Before that the cache holds the proposal riding through — good
   * enough for the seatless early stages, which are the only threads that
   * exist then — and the first SEATED path forces a rebuild, because it means
   * the run is past the gate and the roster it indexes may differ from the
   * proposal (a shrink shifts every later seat; an added seat is not in the
   * proposal at all). Rebuilds stay throttled: building the roster means
   * building the whole job detail.
   */
  private async livePanel(
    jobId: string,
    paths: readonly string[],
  ): Promise<readonly PanelMemberView[]> {
    const cached = this.livePanels.get(jobId);
    if (cached !== undefined && cached.final) return cached.panel;
    const seated = paths.some((path) => /member\[\d+\]/.test(path));
    if (cached !== undefined && !seated) return cached.panel;
    if (cached !== undefined && this.now() - cached.at < 30_000) return cached.panel;
    let panel: readonly PanelMemberView[] = [];
    let final = false;
    try {
      const identity = liveIdentityPanel(await this.detail(jobId));
      panel = identity.panel;
      // An answered gate with no seats would be a contradiction; refusing to
      // pin it keeps one malformed detail from freezing identity forever.
      final = identity.final && identity.panel.length > 0;
    } catch {
      // A job whose detail cannot be built yet simply has no names to attach.
    }
    this.livePanels.set(jobId, { at: this.now(), panel, final });
    return panel;
  }

  private async reapPreviousHost(record: JobRecord): Promise<void> {
    const hadHost =
      record.runner === "slurm"
        ? record.slurmJobId !== undefined
        : record.pid !== undefined;
    if (!hadHost) return;
    await this.stopWorker(record);
    await this.awaitWorkerExit(record);
  }

  private async submitScript(
    record: JobRecord,
    script: string,
    settings: ServerSettings,
  ): Promise<void> {
    await this.reapPreviousHost(record);
    const executionEnv = this.settings.executionEnvironment(this.env, settings);
    if (record.runner === "slurm") {
      if (this.pilotPoolDir !== undefined) {
        await this.submitViaPilot(record, script, executionEnv);
        return;
      }
      // --job-name on the command line beats the template's directive, so the
      // operator keeps owning the template and the queue still shows which
      // submission this is.
      const result = await execute(
        "sbatch",
        ["--job-name", JobManager.jobNameFor(record, script), script],
        {
          cwd: this.jobDir(record.jobId),
          env: executionEnv,
          timeout: 10_000,
        },
      );
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

  /**
   * How long before its allocation ends a worker stops starting new tasks.
   *
   * It has to exceed the longest single agent task, because the wind-down waits
   * for what is already running: a redeveloper writing a full chain revision, or
   * a judge verifying with a script, runs for many minutes. Twenty is generous
   * against that and costs 1.4% of a 24-hour allocation. Set
   * BRAINSTORM_AGENTIC_WIND_DOWN_LEAD_S to 0 to switch the whole mechanism off.
   */
  /**
   * What can be paused: anything still on its way somewhere. A completed,
   * failed or cancelled run has nothing left to stop, and a paused one is
   * already stopped.
   */
  private static readonly PAUSABLE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
    "queued",
    "running",
    "suspended",
    "credit-blocked",
    "orphaned",
  ]);

  private static readonly DEFAULT_WIND_DOWN_LEAD_SECONDS = 1_200;

  private get windDownLeadSeconds(): number {
    const raw = this.env.BRAINSTORM_AGENTIC_WIND_DOWN_LEAD_S?.trim();
    if (raw === undefined || raw === "") return JobManager.DEFAULT_WIND_DOWN_LEAD_SECONDS;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0
      ? value
      : JobManager.DEFAULT_WIND_DOWN_LEAD_SECONDS;
  }

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
    // A paused run is a DECISION, not a state to be inferred: its worker is gone
    // and its checkpoint says running, which is exactly the shape of an
    // interrupted run, and everything below would read it as one and hand it
    // back to the poller that exists to resurrect those.
    if (record.status === "paused") return "paused";
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

  /**
   * Stops the job's worker process, whatever it is doing, WITHOUT deciding what
   * the job becomes — the caller does that. `cancel()` ends the job here;
   * `dismissMember()` uses the same stop and then resubmits, so the run
   * continues from its last checkpoint without the dismissed seat.
   *
   * The worker installs no signal handlers on purpose, so a signal terminates
   * it immediately and its last checkpoint is the resume point. Work that was
   * in flight is lost and re-executed on the resume; work already journaled
   * replays.
   */
  private async stopWorker(record: JobRecord): Promise<void> {
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
  }

  /**
   * Stops the run and keeps it: the worker is ended, the checkpoint stands, and
   * NOTHING resumes it until the submitter does.
   *
   * That last part is the whole feature. A paused run looks exactly like an
   * interrupted one on disk — a worker that is gone with a `running` checkpoint —
   * and the interrupted-job poller exists precisely to resubmit those. So the
   * pause is recorded as a STATUS, and every automatic path is taught to leave it
   * alone: the poller, the credit scheduler, and reconcile(), which would
   * otherwise read the missing worker as an orphan and hand it straight back.
   *
   * Work in flight when the pause lands is lost and re-executed on the resume,
   * exactly as for a dismissal; everything journalled replays for free.
   */
  async pause(jobId: string): Promise<JobStatus> {
    const record = this.record(jobId);
    if (record.trashedAt !== undefined) {
      throw new JobConflictError(`job "${jobId}" is in the trash`);
    }
    const current = await this.reconcile(record);
    if (!JobManager.PAUSABLE_STATUSES.has(current)) {
      throw new JobConflictError(`a ${current} job cannot be paused`);
    }
    await this.stopWorker(record);
    await this.awaitWorkerExit(record);
    record.status = "paused";
    record.pausedAt = this.now();
    // A resume submission in flight would land after the pause and restart the
    // very run being stopped.
    delete record.autoResumePending;
    record.updatedAt = this.now();
    this.write(record);
    return record.status;
  }

  /**
   * Continues a paused run from its last checkpoint. The same submission every
   * other resume uses, so the previous host is reaped and the dismissals, the
   * content pin and the execution settings all ride the record as always.
   */
  async resumePaused(jobId: string): Promise<JobStatus> {
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
    if (status !== "paused") {
      throw new JobConflictError(`job "${jobId}" is not paused (status "${status}")`);
    }
    this.assertPinResumable(jobId);
    this.autoResuming.add(jobId);
    try {
      const settings = record.executionSettings ?? this.settings.get();
      // A run paused before its first checkpoint has nothing to resume from and
      // starts over on its pinned content — the same rule the dismissal and
      // interrupted paths follow.
      const checkpoint = this.checkpoint(jobId);
      const command = this.command(
        record,
        checkpoint !== undefined ? "resume" : "run",
        settings,
      );
      const number = (record.submissionCount ?? 1) + 1;
      const script = this.writeScript(
        record,
        `submit-resume-${number - 1}.sh`,
        command,
        settings.slurmTemplate,
      );
      await this.submitScript(record, script, settings);
      record.status = "queued";
      delete record.pausedAt;
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
    await this.stopWorker(record);
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
        // A run the submitter paused is waiting for THEM, not for the provider's
        // window: claiming it here would restart a run that was deliberately
        // stopped, and the checkpoint it was stopped on still says credit_blocked.
        record.status === "paused" ||
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
    // An answered gate is a resubmission like any other, and it needs the same
    // in-flight claim. Without one, the resumed worker has not yet written a
    // non-suspended checkpoint, so reconcile keeps answering "suspended" with
    // the same gate attached: the card re-appeared the instant it was answered,
    // and the countdown re-armed and answered it again every 30 seconds for as
    // long as the resume sat in the scheduler queue — a stream of submissions
    // all resuming one runId into one session directory, writing over each
    // other's checkpoints and artifacts.
    if (this.autoResuming.has(jobId)) {
      throw new JobConflictError(
        `job "${jobId}" already has a resume submission in progress`,
      );
    }
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
    // Refused at the button, like every other resume: a run pinned to content
    // this app no longer executes must not be discovered minutes later by a
    // worker that dies on startup.
    this.assertPinResumable(jobId);
    const settings: ServerSettings = {
      ...(record.executionSettings ?? this.settings.get()),
      panelConfirmation: "manual",
    };
    this.autoResuming.add(jobId);
    try {
      const command = this.command(record, "resume", settings, answer);
      const number = (record.submissionCount ?? 1) + 1;
      const script = this.writeScript(
        record,
        `submit-resume-${number - 1}.sh`,
        command,
        settings.slurmTemplate,
      );
      await this.submitScript(record, script, settings);
      // "queued", not "running": the worker has been submitted, not started.
      // Paired with the claim below, this is what stops reconcile from reading
      // the still-suspended checkpoint as the live truth and re-offering a gate
      // that has already been answered.
      record.status = "queued";
      record.submissionCount = number;
      record.autoResumePending = { submittedAt: this.now() };
      // The decision, recorded where the dashboard can read it while the
      // resume sits in the scheduler queue: the checkpoint keeps saying
      // "suspended with a pending gate" until the new worker's first write,
      // and without this the stage mapper had only machinery to show for
      // that whole window. The journal's own response supersedes it the
      // moment the resumed run records one.
      record.gateAnswer = {
        gateKey: answer.gateKey,
        action: answer.action,
        ...(answer.members !== undefined ? { members: answer.members } : {}),
        ...(answer.addedMembers !== undefined && answer.addedMembers.length > 0
          ? { addedMembers: answer.addedMembers }
          : {}),
        ...(answer.type !== undefined ? { type: answer.type } : {}),
        ...(answer.requestedOutputs !== undefined
          ? { requestedOutputs: answer.requestedOutputs }
          : {}),
        at: this.now(),
      };
      delete record.gateAutoApprove;
      record.updatedAt = this.now();
      this.write(record);
    } finally {
      this.autoResuming.delete(jobId);
    }
    return this.detail(jobId);
  }

  /** Job states a seat can still be dismissed from — the run is not over. */
  private static readonly DISMISSABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
    "queued",
    "running",
    "suspended",
    "orphaned",
    "credit-blocked",
  ]);

  /**
   * Dismisses one panel seat mid-run: it develops nothing further, comments on
   * nobody, and is withheld from the integrator and the chair. What it produced
   * before the dismissal is untouched — the dashboard's record of the run is
   * never rewritten, and no artifact is deleted.
   *
   * The mechanism is stop-and-resume, because a running worker has no channel
   * to be told anything: the dismissal is recorded on the job, the worker is
   * stopped, and the run is resubmitted from its last checkpoint with the
   * accumulated dismissal list on the command line. Completed work replays out
   * of the journal; only what was in flight is re-executed — for the dismissed
   * seat, not at all.
   */
  async dismissMember(jobId: string, memberId: string): Promise<JobDetail> {
    const record = this.record(jobId);
    if (record.trashedAt !== undefined) {
      throw new JobConflictError(`job "${jobId}" is in the trash`);
    }
    if (this.autoResuming.has(jobId)) {
      throw new JobConflictError(
        `job "${jobId}" already has a resume submission in progress`,
      );
    }
    if (record.dismissedMembers?.includes(memberId)) {
      // Idempotent: a double click, or a retry of a request whose response was
      // lost, must not stop and resubmit the run twice.
      return this.detail(jobId);
    }
    const status = await this.reconcile(record);
    if (!JobManager.DISMISSABLE_STATUSES.has(status)) {
      throw new JobConflictError(
        `a ${status} job has no panel left to change`,
      );
    }
    const roster = await this.roster(jobId);
    if (roster.length === 0) {
      throw new JobConflictError(
        `job "${jobId}" has not seated its panel yet`,
      );
    }
    if (!roster.includes(memberId)) {
      throw new JobConflictError(
        `"${memberId}" is not a seat of job "${jobId}"`,
      );
    }
    const remaining = roster.filter(
      (id) => id !== memberId && !(record.dismissedMembers ?? []).includes(id),
    ).length;
    if (remaining < PANEL_EDIT_LIMITS.minMembers) {
      // The same floor the confirmation gate enforces: below it there is no
      // panel left to review anything, and the review stage cannot proceed.
      throw new JobConflictError(
        `a panel needs at least ${PANEL_EDIT_LIMITS.minMembers} seats — dismissing this one would leave ${remaining}`,
      );
    }
    this.assertPinResumable(jobId);
    this.autoResuming.add(jobId);
    try {
      // Recorded BEFORE the worker is stopped and before the resubmission, so
      // an interruption anywhere after this point still leaves the dismissal in
      // force: every later submission reads it back off the record.
      record.dismissedMembers = [...(record.dismissedMembers ?? []), memberId];
      record.dismissedAt = { ...record.dismissedAt, [memberId]: this.now() };
      record.updatedAt = this.now();
      this.write(record);

      if (status === "credit-blocked") {
        // The worker already exited and the run is waiting for the provider's
        // reset. Resubmitting now would only walk into the same block; the
        // dismissal rides the credit resume that is already scheduled, because
        // every submission builds its command from this record.
        return this.detail(jobId);
      }

      // The worker is stopped by the submission itself (reapPreviousHost),
      // which every resubmission now goes through — a dismissal was the only
      // path that reaped its predecessor, which is why the others could leave
      // one running.

      const settings = record.executionSettings ?? this.settings.get();
      // A run that died before its first checkpoint has nothing to resume from
      // and starts over, reusing its content pin — the same rule the
      // interrupted-job path follows.
      const checkpoint = this.checkpoint(jobId);
      const command = this.command(
        record,
        checkpoint !== undefined ? "resume" : "run",
        settings,
      );
      const number = (record.submissionCount ?? 1) + 1;
      const script = this.writeScript(
        record,
        `submit-dismiss-${number - 1}.sh`,
        command,
        settings.slurmTemplate,
      );
      try {
        await this.submitScript(record, script, settings);
      } catch (error) {
        // The seat is dismissed and the worker is stopped, but the replacement
        // did not reach the scheduler. Say so on the job: the interrupted-job
        // scan resubmits it (carrying the dismissal, which lives on the record),
        // and if that recovery is switched off the resume action is one click.
        this.warning(
          record,
          `Dismissing ${memberId} stopped the run, but resubmitting it failed: ${
            error instanceof Error ? error.message : String(error)
          }. Resume the job to continue without that seat.`,
        );
        record.updatedAt = this.now();
        this.write(record);
        throw error;
      }
      record.status = "queued";
      delete record.error;
      // Any countdown belonged to the submission that just ended. If the run
      // comes back to an unanswered gate it gets a fresh window rather than a
      // deadline that may already have passed while this was being arranged.
      delete record.gateAutoApprove;
      record.submissionCount = number;
      // The claim a restart reads: this job has a submission in flight, so
      // neither the interrupted scan nor a second dismissal double-submits it.
      record.autoResumePending = { submittedAt: this.now() };
      record.updatedAt = this.now();
      this.write(record);
    } finally {
      this.autoResuming.delete(jobId);
    }
    return this.detail(jobId);
  }

  /**
   * Waits, briefly and boundedly, for a stopped worker to actually be gone
   * before the replacement is submitted: two workers sharing one session
   * directory would write over each other's checkpoints and artifacts.
   *
   * Only the local runner can be observed directly. A SLURM job gets a fixed
   * grace instead — scancel signals a worker that has no handler to delay it,
   * and squeue must not be polled at seconds-scale on shared clusters — after
   * which queue latency on the resubmission is the remaining margin.
   */
  private async awaitWorkerExit(record: JobRecord): Promise<void> {
    if (record.runner === "local") {
      if (record.pid === undefined) return;
      for (let waited = 0; waited < 5_000; waited += 200) {
        if (!this.localAlive(record.pid)) return;
        await sleep(200);
      }
      this.warning(
        record,
        "The previous worker was still running when the run was resubmitted; it may re-execute the task it was on.",
      );
      return;
    }
    if (record.slurmJobId !== undefined) await sleep(3_000);
  }

  /**
   * The seat ids the run is actually working with — the panel as the run
   * executed it, including seats the submitter added at confirmation. Empty
   * until the panel exists.
   */
  private async roster(jobId: string): Promise<readonly string[]> {
    const detail = await this.detail(jobId);
    for (const stage of detail.stages) {
      if (stage.id === "first-pass" && stage.members.length > 0) {
        return stage.members.map((member) => member.memberId);
      }
    }
    for (const stage of detail.stages) {
      if (stage.id === "review-members" && stage.members.length > 0) {
        return stage.members.map((member) => member.memberId);
      }
    }
    return [];
  }

  /**
   * Called by the server poller: starts the auto-approve countdown when a
   * suspended gate is first observed, and approves the panel as seated when
   * the deadline passes without any user interaction. A held countdown
   * (heldAt set) never fires — "the whole timeout idea stops".
   */
  async autoApproveDueGates(): Promise<void> {
    // Read LIVE, once per tick, and never from the job's own snapshot: the
    // submitter must be able to switch the countdown off while runs are in
    // flight, including a run that has already passed the classification gate
    // and has not yet reached the panel gate.
    const countdownEnabled = this.settings.get().gateAutoApprove !== false;
    for (const record of this.jobs.values()) {
      if (record.trashedAt !== undefined) continue;
      if (!countdownEnabled) {
        // Switching it off retires any countdown already showing, so the card
        // stops promising a deadline the server will not act on. A later
        // switch-on arms a fresh one, with the full window.
        if (record.gateAutoApprove !== undefined) {
          delete record.gateAutoApprove;
          record.updatedAt = this.now();
          this.write(record);
        }
        continue;
      }
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
      // answerGate takes the claim itself, so this must not take it first: the
      // two would deadlock into "already has a resume submission in progress"
      // and the countdown would never be able to answer anything.
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
