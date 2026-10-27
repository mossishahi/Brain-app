import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ExecutionResult, GpuRunConfig, RunSchedulerCommand } from "../src/index.js";
import {
  AGENT_COMMAND_TAG,
  GPU_RUN_MANIFEST,
  gpuRunTools,
  gpuSubmissionJobIds,
  renderGpuTemplate,
  slurmClusterFrom,
  stripSlurmClusterBanners,
} from "../src/index.js";

const TEMPLATE = `#!/usr/bin/env bash
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1
set -euo pipefail
${AGENT_COMMAND_TAG}
`;

function ok(stdout = "", stderr = ""): ExecutionResult {
  return { exitCode: 0, stdout, stderr, durationMs: 1, truncated: false, timedOut: false };
}

/**
 * A scripted scheduler: sbatch accepts and yields a job id, squeue walks the
 * given queue states (then reports the job gone), sacct answers the final
 * state. Every call is recorded for assertions.
 */
function fakeScheduler(options: {
  readonly jobId?: string;
  readonly queueStates?: readonly string[];
  readonly finalState?: string;
  readonly submitResult?: ExecutionResult;
  readonly writeLogOnLeave?: (jobDir: string) => void;
  /** Multi-cluster shape: sbatch names the cluster, output carries banners. */
  readonly cluster?: string;
}): { run: RunSchedulerCommand; calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const queue = [...(options.queueStates ?? [])];
  const banner = options.cluster !== undefined ? `CLUSTER: ${options.cluster}\n` : "";
  let jobDir: string | undefined;
  const run: RunSchedulerCommand = async (command, args, runOptions) => {
    calls.push({ command, args });
    jobDir ??= runOptions.cwd;
    if (command === "sbatch") {
      const suffix = options.cluster !== undefined ? ` on cluster ${options.cluster}` : "";
      return (
        options.submitResult ??
        ok(`Submitted batch job ${options.jobId ?? "4242"}${suffix}\n`)
      );
    }
    if (command === "squeue") {
      const state = queue.shift();
      if (state === undefined) {
        options.writeLogOnLeave?.(jobDir);
        return ok(banner);
      }
      return ok(`${banner}${state}\n`);
    }
    if (command === "sacct") return ok(`${banner}${options.finalState ?? "COMPLETED"}\n`);
    if (command === "scancel") return ok("");
    throw new Error(`unexpected scheduler command: ${command}`);
  };
  return { run, calls };
}

function config(
  jobsRoot: string,
  run: RunSchedulerCommand,
  overrides: Partial<GpuRunConfig> = {},
): GpuRunConfig {
  return {
    template: TEMPLATE,
    timeLimitMinutes: 30,
    jobsRoot,
    runCommand: run,
    pollIntervalMs: 1,
    // Zero cadences poll the scheduler every tick, preserving the scripted
    // one-state-per-call semantics of fakeScheduler.
    queuedPollIntervalMs: 0,
    runningPollIntervalMs: 0,
    queueGoneGraceMs: 0,
    sleep: async () => {},
    ...overrides,
  };
}

describe("renderGpuTemplate", () => {
  it("splices the agent's script verbatim at the tag", () => {
    const rendered = renderGpuTemplate(TEMPLATE, 'echo "hello"\npython train.py');
    assert.ok(rendered.includes('echo "hello"\npython train.py'));
    assert.ok(!rendered.includes(AGENT_COMMAND_TAG));
    assert.ok(rendered.startsWith("#!/usr/bin/env bash"));
  });

  it("rejects templates without the tag", () => {
    assert.throws(() => renderGpuTemplate("#!/bin/bash\n", "echo hi"), /AGENT_COMMAND/);
  });
});

describe("gpu_run", () => {
  it("submits the rendered script, waits the queue out, and returns the log verbatim", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    try {
      const scheduler = fakeScheduler({
        jobId: "77",
        queueStates: ["PENDING", "RUNNING"],
        finalState: "COMPLETED",
        writeLogOnLeave: (jobDir) => {
          writeFileSync(join(jobDir, "job.log"), "RESULT {\"loss\": 0.03}\n", "utf8");
          writeFileSync(join(jobDir, "metrics.json"), "{}", "utf8");
        },
      });
      const [tool] = gpuRunTools(config(root, scheduler.run));
      const result = await tool!.execute(
        { script: "python train.py --epochs 1", job_name: "probe run #1" },
        { runId: "r1" },
      );
      assert.equal(result.isError, undefined);
      const output = result.output as {
        jobId: string;
        state: string;
        log: string;
        files: readonly { name: string }[];
      };
      assert.equal(output.jobId, "77");
      assert.equal(output.state, "COMPLETED");
      // The log is the agent's own structure, returned untouched.
      assert.equal(output.log, 'RESULT {"loss": 0.03}\n');
      assert.deepEqual(
        output.files.map((file) => file.name),
        ["metrics.json"],
      );

      // The submitted script is the template with the script spliced in.
      const submit = scheduler.calls.find((call) => call.command === "sbatch")!;
      const scriptPath = submit.args.at(-1)!;
      const script = readFileSync(scriptPath, "utf8");
      assert.ok(script.includes("python train.py --epochs 1"));
      assert.ok(script.includes("--gres=gpu:1"));
      // The job name is sanitized; the time limit is the deployment ceiling.
      assert.ok(submit.args.includes("--job-name=probe-run--1"));
      assert.ok(submit.args.includes("--time=30"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("polls the scheduler on its own slow cadence, never on every tick", async () => {
    // Shared clusters ban seconds-scale squeue polling; the loop tick (5s,
    // abort/deadline responsiveness) must not translate into scheduler calls.
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    try {
      let clock = 0;
      const scheduler = fakeScheduler({
        jobId: "88",
        queueStates: ["PENDING", "PENDING", "RUNNING"],
        finalState: "COMPLETED",
        writeLogOnLeave: (jobDir) => {
          writeFileSync(join(jobDir, "job.log"), "done\n", "utf8");
        },
      });
      const [tool] = gpuRunTools(
        config(root, scheduler.run, {
          pollIntervalMs: 5_000,
          queuedPollIntervalMs: 60_000,
          runningPollIntervalMs: 300_000,
          queueGoneGraceMs: 0,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        }),
      );
      const result = await tool!.execute({ script: "python train.py" }, { runId: "rc" });
      assert.equal((result.output as { state: string }).state, "COMPLETED");
      const squeueCalls = scheduler.calls.filter((call) => call.command === "squeue").length;
      // The first empty queue response at t=180 immediately queries
      // accounting; the filesystem grace never costs another queue poll.
      assert.equal(squeueCalls, 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finalizes a fast probe on the first empty queue poll and reports observed progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-fast-probe-"));
    try {
      let clock = 0;
      let jobDir = "";
      const calls: Array<{ command: string; at: number }> = [];
      const states: Array<{ state: string; at: number }> = [];
      const [tool] = gpuRunTools(config(root, async (command, _args, options) => {
        jobDir = options.cwd;
        calls.push({ command, at: clock });
        if (command === "sbatch") return ok("123\n");
        if (command === "squeue") return ok(clock < 3_000 ? "PENDING\n" : "");
        if (command === "sacct") return ok("123|COMPLETED|0:0\n");
        return ok();
      }, {
        timeLimitMinutes: 2, pollIntervalMs: 5_000,
        queuedPollIntervalMs: 30_000, runningPollIntervalMs: 30_000,
        queueGoneGraceMs: 15_000, now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          if (clock >= 5_000) writeFileSync(join(jobDir, "job.log"), "BRAIN_GPU_PROBE_OK: all diagnostics\n");
        },
        onState: (job) => { states.push({ state: job.state, at: clock }); },
      }));
      const result = await tool!.execute({ script: "true" }, { runId: "r" });
      assert.equal(result.isError, undefined);
      assert.equal(clock, 30_000, "first empty queue poll immediately confirms completion");
      assert.deepEqual(calls, [
        { command: "sbatch", at: 0 }, { command: "squeue", at: 0 },
        { command: "squeue", at: 30_000 }, { command: "sacct", at: 30_000 },
      ]);
      assert.deepEqual(states, [
        { state: "SUBMITTED", at: 0 }, { state: "PENDING", at: 0 },
        { state: "EXECUTION_OBSERVED", at: 5_000 },
        { state: "FINALIZING", at: 30_000 }, { state: "COMPLETED", at: 30_000 },
      ]);
      assert.equal((result.output as { log: string }).log, "BRAIN_GPU_PROBE_OK: all diagnostics\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const accountingLag of [false, true]) it(`waits for shared logs on local ticks${accountingLag ? " and delayed accounting" : ""}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-log-grace-"));
    try {
      let clock = 0;
      let jobDir = "";
      const calls: Array<{ command: string; at: number }> = [];
      const [tool] = gpuRunTools(config(root, async (command, _args, options) => {
        jobDir = options.cwd;
        calls.push({ command, at: clock });
        if (command === "sbatch") return ok("123\n");
        if (command === "sacct") return ok(accountingLag && clock < 15_000 ? "" : "123|FAILED|1:0\n");
        return ok();
      }, {
        pollIntervalMs: 5_000, queuedPollIntervalMs: 60_000, runningPollIntervalMs: 300_000,
        queueGoneGraceMs: 15_000, now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          if (clock >= 10_000) writeFileSync(join(jobDir, "job.log"), "complete failure diagnostic\n");
        },
      }));
      const result = await tool!.execute({ script: "false" }, { runId: "r" });
      assert.equal(result.isError, true);
      assert.equal((result.output as { state: string; log: string }).state, "FAILED");
      assert.equal((result.output as { log: string }).log, "complete failure diagnostic\n");
      assert.equal(clock, accountingLag ? 15_000 : 10_000);
      assert.equal(calls.filter((call) => call.command === "squeue").length, 1);
      assert.deepEqual(calls.filter((call) => call.command === "sacct").map((call) => call.at), accountingLag ? [0, 15_000] : [0]);
      assert.equal(calls.some((call) => call.command === "scancel"), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reconciles accounting before a local deadline can cancel an already completed short job", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-deadline-reconcile-"));
    try {
      let clock = 0;
      let jobDir = "";
      const calls: string[] = [];
      const [tool] = gpuRunTools(config(root, async (command, _args, options) => {
        calls.push(command);
        jobDir = options.cwd;
        if (command === "sbatch") return ok("123\n");
        if (command === "squeue") return ok("PENDING\n");
        if (command === "sacct") return ok("123|COMPLETED|0:0\n");
        return ok();
      }, {
        timeLimitMinutes: 1, pollIntervalMs: 5_000,
        queuedPollIntervalMs: 60_000, runningPollIntervalMs: 300_000,
        queueGoneGraceMs: 15_000, now: () => clock,
        sleep: async (ms) => { clock += ms; writeFileSync(join(jobDir, "job.log"), "done\n"); },
      }));
      const result = await tool!.execute({ script: "true" }, { runId: "r" });
      assert.equal(result.isError, undefined);
      assert.equal((result.output as { state: string }).state, "COMPLETED");
      assert.deepEqual(calls, ["sbatch", "squeue", "sacct"]);
      assert.ok(clock < 300_000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("caps the agent's requested time at the deployment ceiling", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    try {
      const scheduler = fakeScheduler({ queueStates: [], finalState: "COMPLETED" });
      const [tool] = gpuRunTools(config(root, scheduler.run));
      await tool!.execute({ script: "true", time_limit_minutes: 999 }, { runId: "r1" });
      const submit = scheduler.calls.find((call) => call.command === "sbatch")!;
      assert.ok(submit.args.includes("--time=30"), "999 requested, ceiling 30 wins");

      const scheduler2 = fakeScheduler({ queueStates: [], finalState: "COMPLETED" });
      const [tool2] = gpuRunTools(config(root, scheduler2.run));
      await tool2!.execute({ script: "true", time_limit_minutes: 5 }, { runId: "r1" });
      const submit2 = scheduler2.calls.find((call) => call.command === "sbatch")!;
      assert.ok(submit2.args.includes("--time=5"), "a smaller request is honored");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a failed job as a bug report addressed to the submitter", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    try {
      const scheduler = fakeScheduler({
        jobId: "99",
        queueStates: ["RUNNING"],
        finalState: "FAILED",
        writeLogOnLeave: (jobDir) => {
          writeFileSync(
            join(jobDir, "job.log"),
            "Traceback (most recent call last):\nValueError: bad shape\n",
            "utf8",
          );
        },
      });
      const [tool] = gpuRunTools(config(root, scheduler.run));
      const result = await tool!.execute({ script: "python broken.py" }, { runId: "r1" });
      assert.equal(result.isError, true);
      const output = result.output as { state: string; log: string; bugReport: string };
      assert.equal(output.state, "FAILED");
      assert.match(output.log, /ValueError: bad shape/);
      // Failed execution is diagnostic evidence; any retry remains bounded.
      assert.match(output.bugReport, /bug report addressed to\s+you, the submitter/i);
      assert.match(output.bugReport, /remaining budget/);
      assert.match(output.bugReport, /Never resubmit while an earlier job has an unresolved state/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a scheduler rejection as a deployment problem, not a script bug", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    try {
      const scheduler = fakeScheduler({
        submitResult: {
          exitCode: 1,
          stdout: "",
          stderr: "sbatch: error: invalid partition specified: gpu",
          durationMs: 1,
          truncated: false,
          timedOut: false,
        },
      });
      const [tool] = gpuRunTools(config(root, scheduler.run));
      const result = await tool!.execute({ script: "true" }, { runId: "r1" });
      assert.equal(result.isError, true);
      const output = result.output as { failure: string; message: string; detail: string };
      assert.equal(output.failure, "submission");
      assert.match(output.message, /NOT a bug in your script/);
      assert.match(output.detail, /invalid partition/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels and reports when the job overruns its window", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    try {
      let clock = 0;
      const scheduler = fakeScheduler({
        jobId: "13",
        finalState: "RUNNING",
        // Endless RUNNING answers: the deadline has to cut the wait short.
        queueStates: Array.from({ length: 1000 }, () => "RUNNING"),
      });
      const [tool] = gpuRunTools(
        config(root, scheduler.run, {
          timeLimitMinutes: 1,
          maxQueueWaitMs: 0,
          now: () => clock,
          sleep: async () => {
            clock += 30_000;
          },
        }),
      );
      const result = await tool!.execute({ script: "sleep 999999" }, { runId: "r1" });
      assert.equal(result.isError, true);
      const output = result.output as { state: string; bugReport: string };
      assert.equal(output.state, "DEADLINE");
      assert.match(output.bugReport, /overran its time limit|exceeded its window/);
      assert.ok(
        scheduler.calls.some((call) => call.command === "scancel"),
        "the overrunning job is cancelled",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses bad input without touching the scheduler", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    try {
      const scheduler = fakeScheduler({});
      const [tool] = gpuRunTools(config(root, scheduler.run));
      const empty = await tool!.execute({ script: "   " }, { runId: "r1" });
      assert.equal(empty.isError, true);
      const badLimit = await tool!.execute(
        { script: "true", time_limit_minutes: 0 },
        { runId: "r1" },
      );
      assert.equal(badLimit.isError, true);
      assert.equal(scheduler.calls.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tracks the landing cluster on multi-cluster sites and reads through banners", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    try {
      const scheduler = fakeScheduler({
        jobId: "55",
        cluster: "serial",
        queueStates: ["PENDING", "RUNNING"],
        finalState: "COMPLETED",
        writeLogOnLeave: (jobDir) => {
          writeFileSync(join(jobDir, "job.log"), "done\n", "utf8");
        },
      });
      const [tool] = gpuRunTools(config(root, scheduler.run));
      const result = await tool!.execute({ script: "true" }, { runId: "r1" });
      assert.equal(result.isError, undefined);
      assert.equal((result.output as { state: string }).state, "COMPLETED");
      // Every post-submission scheduler command carries -M <cluster>.
      for (const call of scheduler.calls.filter((c) => c.command !== "sbatch")) {
        const flag = call.args.indexOf("-M");
        assert.ok(flag >= 0, `${call.command} carries -M`);
        assert.equal(call.args[flag + 1], "serial");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses multi-cluster sbatch output and strips banners", () => {
    assert.equal(
      slurmClusterFrom("Submitted batch job 5397996 on cluster serial\n"),
      "serial",
    );
    assert.equal(slurmClusterFrom("Submitted batch job 123\n"), undefined);
    assert.equal(
      stripSlurmClusterBanners("CLUSTER: serial\nRUNNING\n").trim(),
      "RUNNING",
    );
    assert.equal(stripSlurmClusterBanners("CLUSTER: serial\n").trim(), "");
  });

  it("declares gpu.run and stays disabled by default", () => {
    assert.deepEqual(GPU_RUN_MANIFEST.operations, ["gpu.run"]);
    assert.equal(GPU_RUN_MANIFEST.defaultEnabled, false);
    assert.equal(GPU_RUN_MANIFEST.risk, "high");
    // The agent-facing contract names both output and submission bounds.
    const description = GPU_RUN_MANIFEST.definition.description ?? "";
    assert.match(description, /VERBATIM/);
    assert.match(description, /tail, limited to 48000 characters/);
    assert.match(description, /two submission attempts/);
    assert.match(description, /reconciliation/);
    assert.ok(existsSync !== undefined);
  });

  it("cancels an allocated job when abort arrives during sleep and persists ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-abort-"));
    try {
      const controller = new AbortController();
      const scheduler = fakeScheduler({ queueStates: ["RUNNING"] });
      const [tool] = gpuRunTools(config(root, scheduler.run, {
        sleep: async () => { controller.abort(); const error = new Error("aborted"); error.name = "AbortError"; throw error; },
      }));
      await assert.rejects(tool!.execute({ script: "true" }, { runId: "r", signal: controller.signal }), { name: "AbortError" });
      assert.equal(scheduler.calls.filter((call) => call.command === "scancel").length, 1);
      const record = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!, "job-state.json"), "utf8"));
      assert.equal(record.jobId, "4242");
      assert.equal(record.state, "CANCEL_REQUESTED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not confuse transient squeue failures with a completed job", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-monitor-"));
    try {
      const scheduler = fakeScheduler({ queueStates: ["RUNNING"], finalState: "COMPLETED" });
      let failures = 0;
      const run: RunSchedulerCommand = async (command, args, options) => {
        if (command === "squeue" && failures++ < 2) return { ...ok(), exitCode: 1, stderr: "controller unavailable" };
        if (command === "sacct" && failures <= 2) return ok("4242|RUNNING|0:0\n");
        return scheduler.run(command, args, options);
      };
      const [tool] = gpuRunTools(config(root, run));
      const result = await tool!.execute({ script: "true" }, { runId: "r" });
      assert.equal(result.isError, undefined);
      assert.equal((result.output as { state: string }).state, "COMPLETED");
      assert.equal(scheduler.calls.some((call) => call.command === "scancel"), false);
      assert.ok(scheduler.calls.filter((call) => call.command === "squeue").length >= 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("cancels after persistent scheduler failure instead of abandoning the job", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-monitor-failed-"));
    try {
      const commands: string[] = [];
      const [tool] = gpuRunTools(config(root, async (command) => {
        commands.push(command);
        if (command === "sbatch") return ok("123;algoritam\n");
        if (command === "scancel") return ok();
        return { ...ok(), exitCode: 1, stderr: "controller unavailable" };
      }));
      const result = await tool!.execute({ script: "true" }, { runId: "r" });
      assert.equal((result.output as { state: string }).state, "MONITORING_ERROR");
      assert.equal(commands.filter((command) => command === "squeue").length, 3);
      assert.equal(commands.filter((command) => command === "scancel").length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the main allocation and exit code from parsable accounting", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-accounting-"));
    try {
      const calls: string[] = [];
      let accounts = 0;
      const [tool] = gpuRunTools(config(root, async (command) => {
        calls.push(command);
        if (command === "sbatch") return ok("123;algoritam\n");
        if (command === "sacct") return ++accounts === 1 ? ok() : ok("123.batch|COMPLETED|0:0\n123|COMPLETED|1:0\n");
        return ok();
      }));
      const result = await tool!.execute({ script: "false" }, { runId: "r" });
      assert.equal(result.isError, true);
      assert.equal((result.output as { exitCode: string }).exitCode, "1:0");
      assert.equal(accounts, 2, "wait for delayed accounting");
      assert.equal(calls.includes("scancel"), false, "terminal allocation needs no cancellation");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("recognizes completion from accounting when squeue no longer knows the job id", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-gone-"));
    try {
      const calls: string[] = [];
      const [tool] = gpuRunTools(config(root, async (command) => {
        calls.push(command);
        if (command === "sbatch") return ok("123\n");
        if (command === "sacct") return ok("123|COMPLETED|0:0\n");
        return { ...ok(), exitCode: 1, stderr: "Invalid job id specified" };
      }));
      const result = await tool!.execute({ script: "true" }, { runId: "r" });
      assert.equal(result.isError, undefined);
      assert.deepEqual(calls, ["sbatch", "squeue", "sacct"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not treat unknown accounting states as terminal and exposes failed cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-cleanup-failed-"));
    try {
      const states: string[] = [];
      const [tool] = gpuRunTools(config(root, async (command) => {
        if (command === "sbatch") return ok("123\n");
        if (command === "sacct") return ok("123|GARBAGE|0:0\n");
        if (command === "scancel") return { ...ok(), exitCode: 1, stderr: "controller unavailable" };
        return ok();
      }, { onState: (job) => { states.push(job.state); } }));
      const result = await tool!.execute({ script: "true" }, { runId: "r" });
      const output = result.output as { cleanupRequired: boolean; cancellationAccepted: boolean; bugReport: string };
      assert.equal(result.isError, true);
      assert.equal(output.cleanupRequired, true);
      assert.equal(output.cancellationAccepted, false);
      assert.match(output.bugReport, /not confirmed/);
      assert.ok(states.includes("CANCEL_FAILED"));
      const record = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!, "job-state.json"), "utf8"));
      assert.equal(record.state, "CANCEL_FAILED");
      assert.equal(record.cancellationAccepted, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("persists and reports ambiguous submission ownership instead of inviting a retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-submit-unknown-"));
    try {
      let notified: { submissionToken: string; jobDir: string } | undefined;
      let comment: string | undefined;
      const [tool] = gpuRunTools(config(root, async (_command, args) => {
        comment = args.find((value) => value.startsWith("--comment="));
        return { ...ok(), exitCode: 128, timedOut: true, stderr: "reply timed out" };
      }, { onSubmissionUnknown: (job) => { notified = job; } }));
      const result = await tool!.execute({ script: "true" }, { runId: "r" });
      const output = result.output as { state: string; cleanupRequired: boolean; submissionToken: string };
      assert.equal(output.state, "SUBMISSION_UNKNOWN");
      assert.equal(output.cleanupRequired, true);
      assert.equal(comment, `--comment=${output.submissionToken}`);
      assert.equal(notified?.submissionToken, output.submissionToken);
      assert.equal(JSON.parse(readFileSync(join(notified!.jobDir, "job-state.json"), "utf8")).submissionToken, output.submissionToken);
      assert.deepEqual(gpuSubmissionJobIds(`12|${output.submissionToken}\n13|${output.submissionToken}-other\n14|unrelated\n`, output.submissionToken), ["12"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires allocation exit-code evidence for modern parsable submissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-accounting-missing-"));
    try {
      const calls: string[] = [];
      const [tool] = gpuRunTools(config(root, async (command) => {
        calls.push(command);
        if (command === "sbatch") return ok("123\n");
        if (command === "sacct") return ok("COMPLETED\n");
        return ok();
      }));
      const result = await tool!.execute({ script: "true" }, { runId: "r" });
      assert.equal(result.isError, true);
      assert.ok(calls.includes("scancel"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("enforces two attempts per task across newly created tool instances and permits an explicit override", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-task-budget-"));
    try {
      const scheduler = fakeScheduler({ finalState: "FAILED" });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [tool] = gpuRunTools(config(root, scheduler.run));
        const result = await tool!.execute({ script: "false" }, { runId: "run", taskId: "brain-1" });
        assert.equal((result.output as { state: string }).state, "FAILED");
      }
      const [tool] = gpuRunTools(config(root, scheduler.run));
      const refused = await tool!.execute({ script: "true" }, { runId: "run", taskId: "brain-1" });
      assert.equal((refused.output as { failure: string }).failure, "submission-budget");
      assert.equal(scheduler.calls.filter((call) => call.command === "sbatch").length, 2);
      const records = readdirSync(root).filter((name) => name.startsWith("job-")).map((name) => JSON.parse(readFileSync(join(root, name, "job-state.json"), "utf8")));
      assert.equal(records.length, 2);
      assert.ok(records.every((record) => record.runId === "run" && record.taskId === "brain-1"));
      const [authorized] = gpuRunTools(config(root, scheduler.run, { maxSubmissionsPerTask: 3 }));
      await authorized!.execute({ script: "true" }, { runId: "run", taskId: "brain-1" });
      assert.equal(scheduler.calls.filter((call) => call.command === "sbatch").length, 3);
      const other = await tool!.execute({ script: "true" }, { runId: "run", taskId: "brain-2" });
      assert.equal((other.output as { state: string }).state, "FAILED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns an unresolved task's existing ownership without cancelling or replacing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-task-existing-"));
    try {
      const commands: string[] = [];
      const run: RunSchedulerCommand = async (command) => {
        commands.push(command);
        return { ...ok("Submitted batch job 9876\n"), exitCode: 128, timedOut: true };
      };
      const [first] = gpuRunTools(config(root, run));
      const unknown = await first!.execute({ script: "true" }, { runId: "run", taskId: "task" });
      assert.equal((unknown.output as { state: string }).state, "SUBMISSION_UNKNOWN");
      const [restarted] = gpuRunTools(config(root, run));
      const refused = await restarted!.execute({ script: "true" }, { runId: "run", taskId: "task" });
      const output = refused.output as { failure: string; jobId: string; recordPath: string };
      assert.equal(output.failure, "existing-job");
      assert.equal(output.jobId, "9876");
      assert.ok(existsSync(output.recordPath));
      assert.deepEqual(commands, ["sbatch"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reserves ownership before awaiting sbatch so concurrent task calls cannot duplicate a job", async () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-task-concurrent-"));
    try {
      let release!: (value: ExecutionResult) => void;
      const submission = new Promise<ExecutionResult>((resolve) => { release = resolve; });
      let submits = 0;
      const run: RunSchedulerCommand = async (command) => {
        if (command === "sbatch") { submits += 1; return submission; }
        return ok();
      };
      const [first] = gpuRunTools(config(root, run));
      const [second] = gpuRunTools(config(root, run));
      const pending = first!.execute({ script: "true" }, { runId: "r", taskId: "t" });
      const refused = await second!.execute({ script: "true" }, { runId: "r", taskId: "t" });
      assert.equal((refused.output as { failure: string }).failure, "existing-job");
      assert.equal(submits, 1);
      release({ ...ok(), exitCode: 1, stderr: "test rejection" });
      await pending;
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
