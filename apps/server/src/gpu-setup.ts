import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { gpuRunTools, gpuSubmissionJobIds, runProcess, scrubbedEnvironment, type GpuRunConfig, type RunSchedulerCommand } from "@brainstorm-agentic/host-tools";
import type { GpuDiscovery, GpuDraftUpdate, GpuProbeApproval, GpuSetupDraft, GpuSetupReport, GpuSlurmParameters } from "@brainstorm-agentic/protocol";
import { atomicWriteFile, readJsonFile } from "./files.js";
import { createGpuPlanner, type GpuPlanner } from "./gpu-planner.js";
import { defaultGpuParameters, discoverGpuHost, renderGpuSubmission, validateGpuParameters } from "./gpu-slurm.js";
import { gpuProfileVerified, revokeGpuProfile } from "./gpu-verification.js";
import type { SettingsStore } from "./settings.js";

/** Framework-independent CUDA driver/memory smoke test, no installs/downloads. */
export const GPU_PROBE_BODY = `test -n "\${SLURM_JOB_ID:-}" || { echo 'Missing SLURM allocation'; exit 1; }
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
python3 - <<'BRAIN_GPU_PY'
import ctypes as c
cuda = c.CDLL('libcuda.so.1')
def call(name, types, *args):
    fn = getattr(cuda, name)
    fn.argtypes, fn.restype = types, c.c_int
    result = fn(*args)
    if result != 0: raise RuntimeError(name + ' failed: ' + str(result))
call('cuInit', [c.c_uint], 0)
count = c.c_int()
call('cuDeviceGetCount', [c.POINTER(c.c_int)], c.byref(count))
if count.value < 1: raise RuntimeError('No CUDA device is visible')
device, context, pointer = c.c_int(), c.c_void_p(), c.c_uint64()
call('cuDeviceGet', [c.POINTER(c.c_int), c.c_int], c.byref(device), 0)
call('cuCtxCreate_v2', [c.POINTER(c.c_void_p), c.c_uint, c.c_int], c.byref(context), 0, device)
try:
    call('cuMemAlloc_v2', [c.POINTER(c.c_uint64), c.c_size_t], c.byref(pointer), 4)
    try:
        source, target = c.c_int(1729), c.c_int()
        call('cuMemcpyHtoD_v2', [c.c_uint64, c.c_void_p, c.c_size_t], pointer, c.byref(source), 4)
        call('cuMemcpyDtoH_v2', [c.c_void_p, c.c_uint64, c.c_size_t], c.byref(target), pointer, 4)
        if target.value != source.value: raise RuntimeError('GPU memory verification failed')
    finally:
        call('cuMemFree_v2', [c.c_uint64], pointer)
finally:
    call('cuCtxDestroy_v2', [c.c_void_p], context)
print('BRAIN_GPU_PROBE_OK: CUDA device and memory transfer verified; frameworks not tested')
BRAIN_GPU_PY
`;

export class GpuSetupError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface GpuSetupOptions {
  readonly workspace: string;
  readonly settings: SettingsStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly discover?: (signal: AbortSignal) => Promise<GpuDiscovery>;
  readonly planner?: GpuPlanner;
  /** Tests use a scheduler fake; production uses the hardened host tool. */
  readonly runProbe?: (config: GpuRunConfig, signal: AbortSignal) => Promise<{ isError?: boolean; output: unknown }>;
  readonly cancelOwnedJob?: (jobId: string, cluster?: string) => Promise<void>;
  readonly runScheduler?: RunSchedulerCommand;
}

const timestamp = (): string => new Date().toISOString();

export class GpuSetupService {
  private value: GpuSetupReport;
  private controller: AbortController | undefined;
  private work: Promise<void> | undefined;
  private closed = false;
  private cleanupRequired = false;
  private readonly path: string;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: GpuSetupOptions) {
    this.path = join(options.workspace, "gpu-setup", "state.json");
    let saved: GpuSetupReport | undefined;
    try { saved = readJsonFile<GpuSetupReport>(this.path); } catch { /* corrupt state requires rediscovery */ }
    this.value = saved?.updatedAt && saved.progress ? saved : {
      phase: "unconfigured", progress: { percent: 0, message: "Connect an LLM to discover optional GPU resources" }, updatedAt: timestamp(),
    };
    if (this.value.phase === "discovering") this.value = { ...this.value, phase: "unconfigured" };
    if (this.value.phase === "probing" || this.value.cleanupRequired || this.value.probe?.state === "CANCEL_FAILED") {
      this.cleanupRequired = true;
      revokeGpuProfile(options.workspace);
    } else if (this.value.phase === "ready" && !gpuProfileVerified(options.workspace, options.settings.get().gpu)) {
      this.value = { ...this.value, phase: "draft", progress: { percent: 100, message: "GPU profile changed; review and probe again" } };
    }
    if (this.value.discovery && this.value.discovery.hostname !== hostname() && !this.cleanupRequired) {
      revokeGpuProfile(options.workspace);
      this.value = { phase: "unconfigured", progress: { percent: 0, message: "Server host changed; rediscovery required" }, updatedAt: timestamp() };
    }
  }

  report(): GpuSetupReport { return this.value; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private set(patch: Partial<GpuSetupReport>): void {
    this.value = { ...this.value, ...patch, cleanupRequired: this.cleanupRequired, updatedAt: timestamp() };
    // Setup preludes and logs can contain private paths; keep state owner-only.
    atomicWriteFile(this.path, JSON.stringify(this.value, null, 2), 0o600);
    for (const listener of this.listeners) listener();
  }

  private message(error: unknown): string {
    let result = error instanceof Error ? error.message : String(error);
    const secrets = [this.options.settings.getAnthropicApiKey(), this.options.settings.getClaudeSetupToken(), this.options.settings.getCursorApiKey(), this.options.settings.getGeminiApiKey()];
    for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[redacted]");
    return result.slice(-16_000);
  }

  private hasLlm(): boolean {
    const llm = this.options.settings.get().llm;
    return llm.provider === "anthropic" ? !!this.options.settings.getAnthropicApiKey()
      : llm.provider === "claude-agent" ? !!this.options.settings.getClaudeSetupToken()
      : llm.provider === "cursor-agent" ? !!this.options.settings.getCursorApiKey()
      : llm.provider === "gemini" ? !!this.options.settings.getGeminiApiKey() : false;
  }

  /** Startup/verified credential-save hook. Unrelated settings saves do no work. */
  async start(): Promise<void> {
    if (this.closed) return;
    if (this.cleanupRequired) {
      try { await this.recoverOwnedProbe(); }
      catch (error) { this.set({ phase: "failed", error: this.message(error), progress: { percent: 0, message: "Could not cancel the interrupted probe; retry cancellation before submitting another" } }); }
    }
    this.settingsChanged();
  }

  settingsChanged(): void {
    if (this.closed || this.controller || this.cleanupRequired) return;
    if (this.value.phase === "ready" && !gpuProfileVerified(this.options.workspace, this.options.settings.get().gpu)) {
      this.set({ phase: "draft", progress: { percent: 100, message: "GPU settings changed; review and probe again" } });
    }
    if (this.value.phase === "unconfigured" && this.hasLlm()) this.discover();
  }

  private assertIdle(): void {
    if (this.closed) throw new GpuSetupError(409, "GPU setup is shutting down");
    if (this.controller) throw new GpuSetupError(409, "GPU setup is busy; cancel or wait for it to finish");
    if (this.cleanupRequired) throw new GpuSetupError(409, "Cancel the previous probe before starting another");
  }

  discover(): GpuSetupReport {
    this.assertIdle();
    if (!this.hasLlm()) throw new GpuSetupError(400, "Connect and verify an LLM before GPU discovery");
    const controller = new AbortController();
    this.controller = controller;
    revokeGpuProfile(this.options.workspace);
    this.value = { phase: "discovering", progress: { percent: 10, message: "Inspecting host and SLURM permissions (read only)" }, updatedAt: timestamp() };
    this.set({});
    this.work = (async () => {
      try {
        const discovery = await (this.options.discover?.(controller.signal) ?? discoverGpuHost({ ...(this.options.env ? { env: this.options.env } : {}), signal: controller.signal }));
        controller.signal.throwIfAborted();
        this.set({ discovery, progress: { percent: 55, message: "Preparing a bounded planning-agent draft" } });
        if (discovery.scheduler !== "slurm" || discovery.partitions.length === 0) {
          this.set({ phase: "unsupported", progress: { percent: 100, message: "No accessible SLURM GPU partition discovered" } });
          return;
        }
        const defaults = defaultGpuParameters(discovery);
        let parameters = defaults;
        const notes: string[] = [...discovery.warnings];
        try {
          const plan = await (this.options.planner ?? createGpuPlanner(this.options.settings, this.options.env))(discovery, defaults, controller.signal);
          parameters = validateGpuParameters({ ...defaults, ...plan.parameters }, discovery);
          notes.push(...plan.notes);
        } catch (error) {
          controller.signal.throwIfAborted();
          notes.push(`Planning agent unavailable or returned an invalid draft: ${this.message(error)}. Showing a deterministic draft from scheduler metadata.`);
        }
        controller.signal.throwIfAborted();
        this.set({ phase: "draft", draft: this.draft(parameters, notes), progress: { percent: 100, message: "Draft ready; awaiting your review and approval" } });
      } catch (error) {
        this.set({ phase: "failed", error: this.message(error), progress: { percent: 0, message: controller.signal.aborted ? "Discovery cancelled" : "GPU discovery failed" } });
      } finally { if (this.controller === controller) this.controller = undefined; }
    })();
    return this.report();
  }

  private draft(parameters: GpuSlurmParameters, notes: readonly string[], previous?: GpuSetupDraft): GpuSetupDraft {
    const template = renderGpuSubmission(parameters);
    const probeScript = renderGpuSubmission({ ...parameters, timeLimitMinutes: Math.min(2, parameters.timeLimitMinutes) }, GPU_PROBE_BODY);
    const id = previous?.id ?? randomUUID();
    const revision = (previous?.revision ?? 0) + 1;
    const reviewToken = createHash("sha256").update(JSON.stringify([id, revision, parameters, template, probeScript])).digest("hex");
    return { id, revision, parameters, template, probeScript, reviewToken, notes };
  }

  private matching(value: { draftId?: unknown; revision?: unknown }): GpuSetupDraft {
    const draft = this.value.draft;
    if (!draft || value.draftId !== draft.id || value.revision !== draft.revision) throw new GpuSetupError(409, "The GPU draft changed. Reload and review the current script");
    return draft;
  }

  updateDraft(update: GpuDraftUpdate): GpuSetupReport {
    this.assertIdle();
    const current = this.matching(update);
    if (!this.value.discovery) throw new GpuSetupError(409, "Rediscover the host first");
    const parameters = validateGpuParameters(update.parameters, this.value.discovery);
    revokeGpuProfile(this.options.workspace);
    this.value = { ...this.value, phase: "draft", draft: this.draft(parameters, current.notes, current) };
    delete (this.value as { error?: string }).error;
    delete (this.value as { probe?: unknown }).probe;
    this.set({ progress: { percent: 100, message: "Updated draft; review and approve the exact probe script" } });
    return this.report();
  }

  approve(approval: GpuProbeApproval): GpuSetupReport {
    this.assertIdle();
    const draft = this.matching(approval);
    if (approval.approved !== true || approval.reviewToken !== draft.reviewToken) throw new GpuSetupError(409, "Explicit approval of the current script is required");
    const rendered = this.draft(draft.parameters, draft.notes, { ...draft, revision: draft.revision - 1 });
    if (rendered.reviewToken !== draft.reviewToken || rendered.probeScript !== draft.probeScript || rendered.template !== draft.template) {
      this.set({ phase: "draft", draft: this.draft(draft.parameters, draft.notes, draft), progress: { percent: 100, message: "The probe implementation changed; review the updated script" } });
      throw new GpuSetupError(409, "The probe implementation changed. Review and approve the updated script");
    }
    if (this.value.phase === "ready") throw new GpuSetupError(409, "This GPU profile is already verified");
    validateGpuParameters(draft.parameters, this.value.discovery!);
    const controller = new AbortController();
    this.controller = controller;
    revokeGpuProfile(this.options.workspace);
    this.set({ phase: "probing", probe: { state: "SUBMITTING", startedAt: timestamp(), attemptDirectory: join(this.options.workspace, "gpu-setup", "probes", `${draft.id}-${draft.revision}`) }, progress: { percent: 10, message: "Submitting the approved GPU probe" } });
    this.work = this.probe(draft, controller).finally(() => { if (this.controller === controller) this.controller = undefined; });
    return this.report();
  }

  private async probe(draft: GpuSetupDraft, controller: AbortController): Promise<void> {
    const settingsRevision = this.options.settings.gpuProfileRevision();
    try {
      const config: GpuRunConfig = {
        template: renderGpuSubmission({ ...draft.parameters, timeLimitMinutes: Math.min(2, draft.parameters.timeLimitMinutes) }),
        timeLimitMinutes: Math.min(2, draft.parameters.timeLimitMinutes),
        // Short setup probes normally finish in seconds. Keep scheduler calls
        // bounded, but don't use the cadence intended for long research jobs.
        queuedPollIntervalMs: 30_000,
        runningPollIntervalMs: 30_000,
        jobsRoot: this.value.probe!.attemptDirectory!,
        ...(this.options.env ? { env: this.options.env } : {}),
        onSubmitted: (job) => this.set({ probe: { ...this.value.probe!, ...job, state: "SUBMITTED" }, progress: { percent: 30, message: `Probe ${job.jobId} was accepted by SLURM; checking its status` } }),
        onSubmissionUnknown: (job) => {
          this.cleanupRequired = true;
          this.set({ probe: { ...this.value.probe!, ...job, state: "SUBMISSION_UNKNOWN" }, progress: { percent: 0, message: "Submission outcome is unknown; reconcile this attempt before retrying" } });
        },
        onState: (job) => {
          if (job.state === "CANCEL_FAILED") this.cleanupRequired = true;
          const progress = job.state === "PENDING"
            ? { percent: 35, message: `Probe ${job.jobId} is waiting in the SLURM queue` }
            : job.state === "EXECUTION_OBSERVED"
              ? { percent: 60, message: `Probe ${job.jobId} produced output; checking scheduler status` }
              : job.state === "FINALIZING"
                ? { percent: 85, message: `Probe ${job.jobId} left the queue; checking its results` }
                : { percent: job.state === "RUNNING" ? 65 : 35, message: `GPU probe: ${job.state.toLowerCase()}` };
          this.set({ probe: { ...this.value.probe!, state: job.state }, progress });
        },
      };
      const result = await (this.options.runProbe ? this.options.runProbe(config, controller.signal) : gpuRunTools(config)[0]!.execute({ script: GPU_PROBE_BODY, job_name: "brain-gpu-probe" }, { runId: "gpu-setup", signal: controller.signal }));
      controller.signal.throwIfAborted();
      const output = result.output as { state?: string; log?: string; jobId?: string; detail?: string; bugReport?: string; cleanupRequired?: boolean };
      this.cleanupRequired ||= output?.cleanupRequired === true || output?.state === "SUBMISSION_UNKNOWN";
      const log = this.message(output?.log ?? "");
      this.set({ probe: { ...this.value.probe!, state: output?.state ?? "FAILED", log, finishedAt: timestamp() } });
      if (result.isError || output?.state !== "COMPLETED" || !log.includes("BRAIN_GPU_PROBE_OK:") || !output.jobId) {
        throw new Error(output?.detail ?? output?.bugReport ?? "GPU probe did not verify CUDA device access and memory transfer. Review its log and environment prelude");
      }
      await this.options.settings.installVerifiedGpu({ template: draft.template, timeLimitMinutes: draft.parameters.timeLimitMinutes }, output.jobId, controller.signal, settingsRevision);
      controller.signal.throwIfAborted();
      this.set({ phase: "ready", progress: { percent: 100, message: "GPU execution enabled; CUDA device and memory transfer verified" } });
    } catch (error) {
      revokeGpuProfile(this.options.workspace);
      this.cleanupRequired ||= this.value.probe?.state === "CANCEL_FAILED";
      this.set({ phase: "failed", draft: this.draft(draft.parameters, draft.notes, draft), error: this.message(error), progress: { percent: 0, message: controller.signal.aborted ? "Probe cancelled; GPU execution remains disabled" : "GPU probe failed; review diagnostics before retrying" } });
    }
  }

  async cancel(): Promise<GpuSetupReport> {
    this.controller?.abort(new Error("Cancelled by user"));
    await this.work;
    if (this.cleanupRequired) await this.recoverOwnedProbe();
    return this.report();
  }

  private async recoverOwnedProbe(): Promise<void> {
    const run = this.options.runScheduler ?? ((command, args, options) => runProcess(command, args, { ...options, env: scrubbedEnvironment(this.options.env ?? process.env) }));
    let probe = this.value.probe;
    if (!probe?.jobId && this.value.draft) {
      const root = probe?.attemptDirectory ?? join(this.options.workspace, "gpu-setup", "probes", `${this.value.draft.id}-${this.value.draft.revision}`);
      let dirs: string[] = [];
      try { dirs = readdirSync(root); } catch { /* no submitted record */ }
      for (const dir of dirs) {
        const record = readJsonFile<{ jobId?: string; cluster?: string; submissionToken?: string }>(join(root, dir, "job-state.json"));
        if (record?.jobId || record?.submissionToken) probe = { ...probe!, ...record, state: "INTERRUPTED", startedAt: probe?.startedAt ?? timestamp() };
      }
    }
    if (!probe?.jobId && probe?.submissionToken) {
      if (!/^brain-gpu:[\w-]+$/.test(probe.submissionToken)) throw new Error("Invalid GPU submission identity; inspect the scheduler manually");
      const args = probe.cluster ? ["-M", probe.cluster] : [];
      const queue = await run("squeue", ["-h", "-u", userInfo().username, "-o", "%i|%k", ...args], { cwd: this.options.workspace, timeoutMs: 30_000 });
      if (queue.exitCode !== 0) throw new Error(`Could not reconcile GPU submission: ${queue.stderr}`);
      let ids = gpuSubmissionJobIds(queue.stdout, probe.submissionToken);
      if (ids.length === 0) {
        const date = new Date(probe.startedAt);
        if (!Number.isFinite(date.getTime())) throw new Error("Invalid GPU submission time; inspect scheduler ownership manually");
        // SLURM interprets this format in the scheduler client's local zone.
        const localStart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
        const account = await run("sacct", ["-nP", "-X", "-u", userInfo().username, "-S", localStart, "--format=JobIDRaw,Comment%100,State", ...args], { cwd: this.options.workspace, timeoutMs: 30_000 });
        if (account.exitCode === 0) ids = gpuSubmissionJobIds(account.stdout, probe.submissionToken);
      }
      if (ids.length !== 1) throw new Error("The uncertain GPU submission could not be identified uniquely. Retry cancellation after scheduler accounting catches up; do not submit another job");
      probe = { ...probe, jobId: ids[0]! };
      this.set({ probe });
    }
    if (!probe?.jobId) throw new Error("The interrupted GPU submission has no confirmed job identity. Inspect scheduler ownership before retrying; GPU execution remains blocked");
    if (probe?.jobId) {
      if (!/^\d+$/.test(probe.jobId) || (probe.cluster && !/^[\w.-]+$/.test(probe.cluster))) throw new Error("Invalid persisted GPU job identity; inspect the scheduler manually");
      if (this.options.cancelOwnedJob) await this.options.cancelOwnedJob(probe.jobId, probe.cluster);
      else {
        const result = await run("scancel", [...(probe.cluster ? ["-M", probe.cluster] : []), probe.jobId], { cwd: this.options.workspace, timeoutMs: 30_000 });
        if (result.exitCode !== 0 && !/Invalid job id/i.test(result.stderr)) throw new Error(`Could not cancel GPU job ${probe.jobId}: ${result.stderr}`);
      }
    }
    this.cleanupRequired = false;
    this.set({ phase: "failed", ...(this.value.draft ? { draft: this.draft(this.value.draft.parameters, this.value.draft.notes, this.value.draft) } : {}), ...(probe ? { probe: { ...probe, state: "CANCEL_REQUESTED", finishedAt: timestamp() } } : {}), progress: { percent: 0, message: "Cancellation requested for interrupted probe; review before retrying" } });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort(new Error("Server shutdown"));
    await this.work;
    this.listeners.clear();
  }
}
