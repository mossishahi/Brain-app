import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ExecutionResult, GpuRunConfig, RunSchedulerCommand } from "../src/index.js";
import {
  AGENT_COMMAND_TAG,
  GPU_RUN_MANIFEST,
  gpuRunTools,
  renderGpuTemplate,
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
}): { run: RunSchedulerCommand; calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const queue = [...(options.queueStates ?? [])];
  let jobDir: string | undefined;
  const run: RunSchedulerCommand = async (command, args, runOptions) => {
    calls.push({ command, args });
    jobDir ??= runOptions.cwd;
    if (command === "sbatch") {
      return (
        options.submitResult ?? ok(`Submitted batch job ${options.jobId ?? "4242"}\n`)
      );
    }
    if (command === "squeue") {
      const state = queue.shift();
      if (state === undefined) {
        options.writeLogOnLeave?.(jobDir);
        return ok("");
      }
      return ok(`${state}\n`);
    }
    if (command === "sacct") return ok(`${options.finalState ?? "COMPLETED"}\n`);
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
      // The orchestrator's contract: tell the submitter about the bug and
      // that resubmitting is safe while they resolve it.
      assert.match(output.bugReport, /bug report addressed to\s+you, the submitter/i);
      assert.match(output.bugReport, /RESUBMIT/);
      assert.match(output.bugReport, /resubmitting is safe/i);
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

  it("declares gpu.run and stays disabled by default", () => {
    assert.deepEqual(GPU_RUN_MANIFEST.operations, ["gpu.run"]);
    assert.equal(GPU_RUN_MANIFEST.defaultEnabled, false);
    assert.equal(GPU_RUN_MANIFEST.risk, "high");
    // The agent-facing highlight: verbatim script, output in the agent's own
    // structure, and the debug-and-resubmit permission.
    const description = GPU_RUN_MANIFEST.definition.description ?? "";
    assert.match(description, /VERBATIM/);
    assert.match(description, /EXACTLY as your script printed it/);
    assert.match(description, /resubmit/i);
    assert.ok(existsSync !== undefined);
  });
});
