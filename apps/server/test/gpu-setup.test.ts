import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { renderGpuTemplate, type GpuRunConfig } from "@brainstorm-agentic/host-tools";
import type { GpuDiscovery, GpuProbeApproval, GpuSetupReport } from "@brainstorm-agentic/protocol";

import { GPU_PROBE_BODY, GpuSetupError, GpuSetupService, type GpuSetupOptions } from "../src/gpu-setup.js";
import { gpuProfileVerified } from "../src/gpu-verification.js";
import { SettingsStore, type SettingsStoreOptions } from "../src/settings.js";

const discovery: GpuDiscovery = {
  hostname: hostname(), architecture: "x64", platform: "linux", scheduler: "slurm",
  schedulerVersion: "slurm 24.11", cluster: "test-cluster",
  partitions: [{ name: "gpu_p", accounts: ["research"], qos: ["gpu_normal", "gpu_priority"],
    accountQos: { research: ["gpu_normal", "gpu_priority"] }, gpuTypes: ["", "a100"], maxTimeMinutes: 120 }],
  qos: [
    { name: "gpu_normal", flags: [], requiresReservation: false, maxTimeMinutes: 120 },
    { name: "gpu_priority", flags: [], requiresReservation: false, maxTimeMinutes: 60 },
  ],
  warnings: [], evidence: [], discoveredAt: "2026-10-03T00:00:00.000Z",
};

const success = () => ({ output: {
  state: "COMPLETED", jobId: "12345", log: "BRAIN_GPU_PROBE_OK: CUDA device and memory transfer verified; frameworks not tested\n",
} });

async function fixture(t: TestContext, options: SettingsStoreOptions = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "brain-gpu-setup-"));
  const settings = new SettingsStore(workspace, { validateAnthropic: async () => undefined, ...options });
  const services: GpuSetupService[] = [];
  const releases: Array<() => void> = [];
  const calls = { discover: 0, planner: 0, submit: 0 };
  t.after(async () => {
    for (const release of releases) release();
    await Promise.all(services.map((service) => service.close()));
    rmSync(workspace, { recursive: true, force: true });
  });
  await settings.put({ llm: { provider: "anthropic", model: "test-model", apiKey: "gpu-test-key" } });
  return {
    workspace, settings, calls,
    deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      releases.push(resolve);
      return { promise, resolve };
    },
    service(overrides: Partial<GpuSetupOptions> = {}) {
      const service = new GpuSetupService({
        workspace, settings,
        discover: async () => { calls.discover += 1; return structuredClone(discovery); },
        planner: async () => { calls.planner += 1; return { notes: ["Use the discovered batch GPU queue."] }; },
        runProbe: async (config) => {
          calls.submit += 1;
          config.onSubmitted?.({ jobId: "12345", cluster: "test-cluster", jobDir: join(config.jobsRoot, "test-job") });
          config.onState?.({ jobId: "12345", state: "RUNNING" });
          return success();
        },
        cancelOwnedJob: async () => undefined,
        ...overrides,
      });
      services.push(service);
      return service;
    },
  };
}

async function waitFor(service: GpuSetupService, phase: GpuSetupReport["phase"]): Promise<GpuSetupReport> {
  const deadline = Date.now() + 3000;
  while (service.report().phase !== phase) {
    assert.ok(Date.now() < deadline, `expected ${phase}, got ${JSON.stringify(service.report())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // The service publishes its terminal phase before its promise finally
  // releases the busy controller; let that release complete too.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return service.report();
}

async function drafted(service: GpuSetupService): Promise<GpuSetupReport> {
  await service.start();
  return waitFor(service, "draft");
}

function approval(report: GpuSetupReport): GpuProbeApproval {
  assert.ok(report.draft);
  return { draftId: report.draft.id, revision: report.draft.revision,
    reviewToken: report.draft.reviewToken, approved: true };
}

function conflict(action: () => unknown, pattern: RegExp): void {
  assert.throws(action, (error) => error instanceof GpuSetupError && error.status === 409 && pattern.test(error.message));
}

test("discovery and planning prepare a draft; only exact explicit approval submits its displayed script", async (t) => {
  const f = await fixture(t);
  const release = f.deferred();
  let submittedScript: string | undefined;
  const service = f.service({ runProbe: async (config) => {
    f.calls.submit += 1;
    submittedScript = renderGpuTemplate(config.template, GPU_PROBE_BODY);
    config.onSubmitted?.({ jobId: "12345", cluster: "test-cluster", jobDir: config.jobsRoot });
    await release.promise;
    return success();
  } });
  const report = await drafted(service);
  assert.deepEqual(f.calls, { discover: 1, planner: 1, submit: 0 });
  assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), false);
  const approved = approval(report);
  conflict(() => service.approve({ ...approved, approved: false } as unknown as GpuProbeApproval), /Explicit approval/);
  conflict(() => service.approve({ ...approved, reviewToken: "wrong" }), /Explicit approval/);
  assert.equal(f.calls.submit, 0);
  service.approve(approved);
  assert.equal(submittedScript, report.draft!.probeScript);
  assert.equal(f.calls.submit, 1);
  conflict(() => service.approve(approved), /busy/);
  release.resolve();
  await waitFor(service, "ready");
  assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), true);
  assert.ok(f.settings.get().hostTools?.enabledToolIds.includes("gpu_run"));
  assert.equal(JSON.parse(f.settings.executionEnvironment({}).BRAINSTORM_AGENTIC_GPU_RUN!).template, report.draft!.template);
});

test("unrelated settings saves and restarting a draft do not rerun discovery or the planning agent", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const before = await drafted(service);
  await f.settings.put({ gateAutoApprove: false });
  service.settingsChanged();
  await service.start();
  await service.close();
  const restarted = f.service();
  await restarted.start();
  assert.deepEqual(f.calls, { discover: 1, planner: 1, submit: 0 });
  assert.deepEqual(restarted.report().draft, before.draft);
});

test("probe submission does not claim queue status, and result checking clears the queued message", async (t) => {
  const f = await fixture(t);
  const release = f.deferred();
  let callbacks!: GpuRunConfig;
  const service = f.service({ runProbe: async (config) => {
    callbacks = config;
    config.onSubmitted?.({ jobId: "12345", jobDir: config.jobsRoot });
    await release.promise;
    return success();
  } });
  service.approve(approval(await drafted(service)));
  assert.equal(service.report().probe?.state, "SUBMITTED");
  assert.match(service.report().progress.message, /accepted by SLURM/);
  assert.doesNotMatch(service.report().progress.message, /waiting|queued/);
  callbacks.onState?.({ jobId: "12345", state: "PENDING" });
  assert.match(service.report().progress.message, /waiting in the SLURM queue/);
  callbacks.onState?.({ jobId: "12345", state: "EXECUTION_OBSERVED" });
  assert.equal(service.report().probe?.state, "EXECUTION_OBSERVED");
  assert.match(service.report().progress.message, /produced output/);
  callbacks.onState?.({ jobId: "12345", state: "FINALIZING" });
  assert.equal(service.report().phase, "probing");
  assert.match(service.report().progress.message, /left the queue; checking its results/);
  assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), false);
  release.resolve();
  await waitFor(service, "ready");
  assert.equal(service.report().probe?.state, "COMPLETED");
  assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), true);
});

test("saving the first verified LLM connection starts discovery without submitting a GPU job", async (t) => {
  const f = await fixture(t);
  await f.settings.put({ llm: { provider: "offline" } });
  const service = f.service();
  await service.start();
  assert.equal(service.report().phase, "unconfigured");
  assert.deepEqual(f.calls, { discover: 0, planner: 0, submit: 0 });
  await f.settings.put({ llm: { provider: "anthropic", model: "test-model", apiKey: "gpu-test-key" } });
  service.settingsChanged();
  await waitFor(service, "draft");
  assert.deepEqual(f.calls, { discover: 1, planner: 1, submit: 0 });
});

test("editing resource selections invalidates the previous draft revision and approval digest", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const before = await drafted(service);
  const oldApproval = approval(before);
  const after = service.updateDraft({ draftId: before.draft!.id, revision: before.draft!.revision,
    parameters: { ...before.draft!.parameters, qos: "gpu_priority", nice: 10, prelude: "export GPU_TEST_ENV=reviewed" } });
  assert.ok(after.draft!.revision > before.draft!.revision);
  assert.notEqual(after.draft!.reviewToken, before.draft!.reviewToken);
  conflict(() => service.approve(oldApproval), /draft changed/);
  conflict(() => service.approve({ ...approval(after), reviewToken: oldApproval.reviewToken }), /Explicit approval/);
  assert.equal(f.calls.submit, 0);
  assert.match(after.draft!.probeScript, /#SBATCH --qos=gpu_priority/);
});

test("a persisted script from a different renderer is rejected and regenerated before submission", async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const original = await drafted(service);
  await service.close();
  const changed = { ...original, draft: { ...original.draft!, probeScript: "#!/bin/bash\necho old probe implementation\n" } };
  writeFileSync(join(f.workspace, "gpu-setup", "state.json"), JSON.stringify(changed));
  const restarted = f.service();
  await restarted.start();
  conflict(() => restarted.approve(approval(changed)), /implementation changed/);
  assert.equal(f.calls.submit, 0);
  assert.ok(restarted.report().draft!.revision > original.draft!.revision);
  assert.equal(restarted.report().draft!.probeScript, original.draft!.probeScript);
});

test("failed cancellation remains blocking after returned job failure and server restart", async (t) => {
  const f = await fixture(t);
  const service = f.service({ runProbe: async (config) => {
    f.calls.submit += 1;
    config.onSubmitted?.({ jobId: "12345", cluster: "test-cluster", jobDir: config.jobsRoot });
    config.onState?.({ jobId: "12345", state: "CANCEL_FAILED", detail: "controller unreachable" });
    return { isError: true, output: { jobId: "12345", state: "DEADLINE", cleanupRequired: true, detail: "cancellation failed" } };
  } });
  service.approve(approval(await drafted(service)));
  const failed = await waitFor(service, "failed");
  assert.equal(failed.cleanupRequired, true);
  conflict(() => service.discover(), /previous probe/);
  conflict(() => service.approve(approval(failed)), /previous probe/);
  assert.equal(JSON.parse(readFileSync(join(f.workspace, "gpu-setup", "state.json"), "utf8")).cleanupRequired, true);
  await service.close();
  let canCancel = false;
  const cancelled: string[] = [];
  const restarted = f.service({ cancelOwnedJob: async (jobId, cluster) => {
    cancelled.push(`${cluster}:${jobId}`);
    if (!canCancel) throw new Error("scheduler still unavailable");
  } });
  await restarted.start();
  assert.equal(restarted.report().cleanupRequired, true);
  conflict(() => restarted.discover(), /previous probe/);
  canCancel = true;
  await restarted.cancel();
  assert.deepEqual(cancelled, ["test-cluster:12345", "test-cluster:12345"]);
  assert.equal(restarted.report().cleanupRequired, false);
  assert.equal(restarted.report().probe?.state, "CANCEL_REQUESTED");
  assert.equal(f.calls.submit, 1);
  assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), false);
});

test("an approval consumed by a failed attempt cannot be replayed to submit another job", async (t) => {
  const f = await fixture(t);
  const service = f.service({ runProbe: async () => {
    f.calls.submit += 1;
    return { isError: true, output: { state: "FAILED", detail: "computation failed" } };
  } });
  const approved = approval(await drafted(service));
  service.approve(approved);
  await waitFor(service, "failed");
  conflict(() => service.approve(approved), /draft changed|already|consumed/);
  assert.equal(f.calls.submit, 1);
});

test("cancelling while verified-profile installation waits on settings cannot authorize GPU execution", async (t) => {
  let blockValidation = false;
  let verifying!: () => void;
  let releaseValidation!: () => void;
  const verificationStarted = new Promise<void>((resolve) => { verifying = resolve; });
  const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  const f = await fixture(t, { validateAnthropic: async () => {
    if (blockValidation) { verifying(); await validationGate; }
  } });
  const probeDone = f.deferred();
  const service = f.service({ runProbe: async () => {
    f.calls.submit += 1;
    await probeDone.promise;
    return success();
  } });
  try {
    service.approve(approval(await drafted(service)));
    blockValidation = true;
    const saving = f.settings.put({ llm: { model: "changed-model" } });
    await verificationStarted;
    probeDone.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.report().phase, "probing");
    const cancelled = service.cancel();
    releaseValidation();
    await Promise.all([saving, cancelled]);
    assert.equal(service.report().phase, "failed");
    assert.match(service.report().progress.message, /cancelled/i);
    assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), false);
    assert.equal(f.settings.executionEnvironment({}).BRAINSTORM_AGENTIC_GPU_RUN, undefined);
  } finally { releaseValidation(); }
});

test("a GPU settings edit committed during the probe cannot be overwritten or verified by the old result", async (t) => {
  const f = await fixture(t);
  const release = f.deferred();
  const service = f.service({ runProbe: async () => { await release.promise; return success(); } });
  const draft = await drafted(service);
  service.approve(approval(draft));
  const replacement = { template: "#!/bin/bash\n# user changed this profile\n{{AGENT_COMMAND}}\n", timeLimitMinutes: 7 };
  await f.settings.put({ gpu: replacement });
  release.resolve();
  const failed = await waitFor(service, "failed");
  assert.match(failed.error ?? "", /settings changed/);
  assert.deepEqual(f.settings.get().gpu, replacement);
  assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), false);
  assert.equal(f.settings.executionEnvironment({}).BRAINSTORM_AGENTIC_GPU_RUN, undefined);
});

test("scheduler completion without the CUDA success result never enables the profile", async (t) => {
  const f = await fixture(t);
  const service = f.service({ runProbe: async () => ({ output: {
    state: "COMPLETED", jobId: "12345", log: "environment setup exited before the CUDA test\n",
  } }) });
  service.approve(approval(await drafted(service)));
  await waitFor(service, "failed");
  assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), false);
  assert.equal(f.settings.executionEnvironment({}).BRAINSTORM_AGENTIC_GPU_RUN, undefined);
});

test("raw or inherited GPU templates never bypass verification, and editing a verified profile revokes it", async (t) => {
  const f = await fixture(t);
  const raw = { template: "#!/bin/bash\n{{AGENT_COMMAND}}\n", timeLimitMinutes: 10 };
  await f.settings.put({ gpu: raw, hostTools: { enabledToolIds: ["gpu_run"] } });
  assert.equal(f.settings.executionEnvironment({ BRAINSTORM_AGENTIC_GPU_RUN: JSON.stringify(raw) }).BRAINSTORM_AGENTIC_GPU_RUN, undefined);
  const service = f.service();
  service.approve(approval(await drafted(service)));
  await waitFor(service, "ready");
  assert.ok(f.settings.executionEnvironment({}).BRAINSTORM_AGENTIC_GPU_RUN);
  await f.settings.put({ gpu: { ...f.settings.get().gpu!, timeLimitMinutes: 11 } });
  service.settingsChanged();
  assert.equal(service.report().phase, "draft");
  assert.equal(gpuProfileVerified(f.workspace, f.settings.get().gpu), false);
  assert.equal(f.settings.executionEnvironment({ BRAINSTORM_AGENTIC_GPU_RUN: JSON.stringify(raw) }).BRAINSTORM_AGENTIC_GPU_RUN, undefined);
});

test("uncertain submission without a job identity remains blocked across cancellation and restart", async (t) => {
  const f = await fixture(t);
  const service = f.service({ runProbe: async () => {
    f.calls.submit += 1;
    return { isError: true, output: { state: "SUBMISSION_UNKNOWN", cleanupRequired: true, detail: "sbatch response lost" } };
  } });
  service.approve(approval(await drafted(service)));
  await waitFor(service, "failed");
  await assert.rejects(service.cancel(), /unknown|identity|manually|submission/i);
  assert.equal(service.report().cleanupRequired, true);
  await service.close();
  const restarted = f.service();
  await restarted.start();
  assert.equal(restarted.report().cleanupRequired, true);
  conflict(() => restarted.discover(), /previous probe/);
  assert.equal(f.calls.submit, 1);
});

function schedulerOutput(stdout: string) {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false, timedOut: false };
}

test("uncertain submission recovery matches only its exact scheduler comment in queue or accounting", async (t) => {
  for (const source of ["queue", "accounting"] as const) {
    const f = await fixture(t);
    const token = "brain-gpu:test-token";
    const commands: string[] = [];
    const cancelled: string[] = [];
    const unrelated = `22222|${token}-other\n33333|prefix-${token}\n44444|brain-gpu:another-token\n`;
    const service = f.service({
      runProbe: async (config) => {
        f.calls.submit += 1;
        config.onSubmissionUnknown?.({ submissionToken: token,
          jobDir: join(config.jobsRoot, "lost-reply"), cluster: "test-cluster" });
        return { isError: true, output: { state: "SUBMISSION_UNKNOWN", cleanupRequired: true, detail: "response lost" } };
      },
      runScheduler: async (command, args) => {
        commands.push(command);
        assert.equal(args[args.indexOf("-u") + 1], userInfo().username);
        assert.equal(args[args.indexOf("-M") + 1], "test-cluster");
        if (command === "squeue") return schedulerOutput(unrelated + (source === "queue" ? `12345|${token}\n` : ""));
        assert.equal(command, "sacct", "recovery invokes only the bounded discovery commands");
        assert.equal(source, "accounting");
        assert.ok(args.includes("--format=JobIDRaw,Comment%100,State"));
        return schedulerOutput(unrelated + `12345|${token}|COMPLETED\n`);
      },
      cancelOwnedJob: async (jobId, cluster) => { cancelled.push(`${cluster}:${jobId}`); },
    });
    service.approve(approval(await drafted(service)));
    const failed = await waitFor(service, "failed");
    assert.equal(failed.probe?.submissionToken, token);
    assert.equal(failed.cleanupRequired, true);
    await service.cancel();
    assert.deepEqual(commands, source === "queue" ? ["squeue"] : ["squeue", "sacct"]);
    assert.deepEqual(cancelled, ["test-cluster:12345"]);
    assert.equal(service.report().cleanupRequired, false);
    assert.equal(service.report().probe?.jobId, "12345");
    assert.equal(f.calls.submit, 1, "reconciliation never resubmits");
  }
});

test("multiple jobs with the owned submission comment remain blocked across restart", async (t) => {
  const f = await fixture(t);
  const token = "brain-gpu:ambiguous-token";
  const cancelled: string[] = [];
  const recovery: Partial<GpuSetupOptions> = {
    runScheduler: async (command) => {
      assert.equal(command, "squeue");
      return schedulerOutput(`12345|${token}\n67890|${token}\n`);
    },
    cancelOwnedJob: async (jobId) => { cancelled.push(jobId); },
  };
  const service = f.service({
    ...recovery,
    runProbe: async (config) => {
      config.onSubmissionUnknown?.({ submissionToken: token, jobDir: join(config.jobsRoot, "unknown") });
      return { isError: true, output: { state: "SUBMISSION_UNKNOWN", cleanupRequired: true } };
    },
  });
  service.approve(approval(await drafted(service)));
  await waitFor(service, "failed");
  await assert.rejects(service.cancel(), /identified uniquely/);
  assert.equal(service.report().cleanupRequired, true);
  conflict(() => service.discover(), /previous probe/);
  await service.close();
  const restarted = f.service(recovery);
  await restarted.start();
  assert.equal(restarted.report().cleanupRequired, true);
  conflict(() => restarted.approve(approval(restarted.report())), /previous probe/);
  assert.deepEqual(cancelled, [], "ambiguity never authorizes cancellation of either job");
});

test("restart recovers the persisted attempt directory after the review revision advances", async (t) => {
  const f = await fixture(t);
  let attemptDirectory = "";
  const cancelled: string[] = [];
  const service = f.service({ runProbe: async (config) => {
    attemptDirectory = config.jobsRoot;
    const jobDirectory = join(attemptDirectory, "submitted-before-callback");
    mkdirSync(jobDirectory, { recursive: true });
    writeFileSync(join(jobDirectory, "job-state.json"), JSON.stringify({
      jobId: "12345", cluster: "test-cluster", state: "PENDING",
    }));
    // The scheduler identity reached the durable job record but not the
    // setup observer. Failure advances the review draft's revision.
    return { isError: true, output: { state: "SUBMISSION_UNKNOWN", cleanupRequired: true } };
  } });
  const original = await drafted(service);
  service.approve(approval(original));
  const failed = await waitFor(service, "failed");
  assert.ok(failed.draft!.revision > original.draft!.revision);
  assert.equal(failed.probe?.attemptDirectory, attemptDirectory);
  assert.equal(failed.probe?.jobId, undefined);
  const wrongDirectory = join(f.workspace, "gpu-setup", "probes", `${failed.draft!.id}-${failed.draft!.revision}`, "unrelated");
  mkdirSync(wrongDirectory, { recursive: true });
  writeFileSync(join(wrongDirectory, "job-state.json"), JSON.stringify({ jobId: "99999", state: "PENDING" }));
  await service.close();
  const restarted = f.service({
    runScheduler: async () => { throw new Error("A durable job identity requires no scheduler lookup"); },
    cancelOwnedJob: async (jobId, cluster) => { cancelled.push(`${cluster}:${jobId}`); },
  });
  await restarted.start();
  assert.deepEqual(cancelled, ["test-cluster:12345"]);
  assert.equal(restarted.report().probe?.attemptDirectory, attemptDirectory);
  assert.equal(restarted.report().cleanupRequired, false);
});
