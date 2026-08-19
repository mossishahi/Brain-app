import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The server job's walltime survival (deploy/slurm-renew.sh).
 *
 * The overnight failure this exists for: the server's own SLURM job hit its
 * 12-hour limit and died while a run's worker went on executing with nobody
 * watching it — no resume when it failed, no dashboard, no scheduler for its
 * credit block. Runs are protected by the server; nothing protected the server.
 *
 * Tested through stubbed scheduler commands on PATH, because the logic that can
 * silently break here is time parsing and telling a walltime apart from a
 * scancel — neither of which needs a cluster to get wrong.
 */
/** Found by walking up from wherever this test runs (src or dist). */
function findRenewScript(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let up = 0; up < 6; up += 1) {
    const candidate = join(dir, "deploy", "slurm-renew.sh");
    if (existsSync(candidate)) return candidate;
    dir = join(dir, "..");
  }
  throw new Error("deploy/slurm-renew.sh not found above this test");
}

const renewScript = findRenewScript();

function harness(): {
  readonly bin: string;
  readonly root: string;
  stub: (name: string, body: string) => void;
  run: (snippet: string, env?: Record<string, string>) => string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "slurm-renew-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  return {
    bin,
    root,
    stub(name, body) {
      const file = join(bin, name);
      writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(file, 0o755);
    },
    run(snippet, env = {}) {
      return execFileSync("bash", ["-c", `. ${renewScript}\n${snippet}`], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          SLURM_JOB_ID: "4242",
          USER: "tester",
          ...env,
        },
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the job's end time and walltime are read from one scontrol call", () => {
  const h = harness();
  try {
    h.stub(
      "scontrol",
      `echo "JobId=4242 JobName=brain RunTime=02:00:00 TimeLimit=12:00:00 StartTime=2026-08-19T10:00:00 EndTime=2026-08-19T22:00:00 Partition=cpu_p"`,
    );
    const end = h.run("brain_job_end_epoch").trim();
    const expected = Math.floor(new Date("2026-08-19T22:00:00").getTime() / 1000);
    assert.equal(Number(end), expected, "EndTime parses to the right epoch");
    assert.equal(
      h.run("brain_time_limit_flag").trim(),
      "--time=12:00:00",
      "the successor inherits this job's own limit, override included",
    );
  } finally {
    h.cleanup();
  }
});

test("an unlimited or unknown walltime yields no --time flag rather than a broken one", () => {
  const h = harness();
  try {
    h.stub("scontrol", `echo "JobId=4242 TimeLimit=UNLIMITED EndTime=Unknown"`);
    assert.equal(h.run("brain_time_limit_flag").trim(), "");
    assert.equal(h.run("brain_job_end_epoch").trim(), "");
  } finally {
    h.cleanup();
  }
});

test("the successor is submitted once, with the job's walltime, and never duplicated", () => {
  const h = harness();
  try {
    h.stub("scontrol", `echo "JobId=4242 TimeLimit=24:00:00 EndTime=2026-08-19T22:00:00"`);
    h.stub("squeue", "exit 0"); // nothing pending
    h.stub("sbatch", `printf '%s\\n' "$*" >> "$SBATCH_LOG"; echo "Submitted batch job 777"`);
    const log = join(h.root, "sbatch.log");
    const id = h.run(`brain_submit_successor /repo/deploy/slurm-launch.sh brain 2>/dev/null`, {
      SBATCH_LOG: log,
    });
    assert.equal(id.trim(), "777", "the id is returned for the trap to cancel if needed");
    assert.match(
      execFileSync("cat", [log], { encoding: "utf8" }).trim(),
      /^--time=24:00:00 \/repo\/deploy\/slurm-launch\.sh$/,
      "submitted with the inherited walltime and the REPO script, not the spool copy",
    );

    // With one already pending, a second is not queued: singleton would hold it
    // forever and the queue would fill with successors.
    h.stub("squeue", `echo 999`);
    const again = h.run(`brain_submit_successor /repo/deploy/slurm-launch.sh brain 2>/dev/null`, {
      SBATCH_LOG: log,
    });
    assert.equal(again.trim(), "", "no second successor");
  } finally {
    h.cleanup();
  }
});

test("a deployment that cannot submit keeps serving and says so", () => {
  const h = harness();
  try {
    h.stub("scontrol", `echo "JobId=4242 TimeLimit=12:00:00"`);
    h.stub("squeue", "exit 0");
    h.stub("sbatch", `echo "sbatch: error: Batch job submission failed" >&2; exit 1`);
    const out = h.run(
      `brain_submit_successor /repo/deploy/slurm-launch.sh brain 2>&1; echo "exit=$?"`,
    );
    assert.match(out, /\[renew\] sbatch refused the successor/);
    assert.match(out, /exit=0/, "a failed renewal is never fatal to the running server");
  } finally {
    h.cleanup();
  }
});

test("a walltime TERM hands over; a scancel TERM does not", () => {
  const h = harness();
  try {
    const now = 1_800_000_000;
    // SLURM sends TERM for both. Minutes from the end: the walltime.
    assert.match(
      h.run(`brain_term_is_walltime ${now + 60} ${now} && echo yes || echo no`),
      /yes/,
    );
    // Hours from the end: somebody cancelled the deployment, and its queued
    // successor must go with it or the deployment cannot be stopped.
    assert.match(
      h.run(`brain_term_is_walltime ${now + 7200} ${now} && echo yes || echo no`),
      /no/,
    );
    // No end time known at all: treated as a cancel, which is the safe side.
    assert.match(h.run(`brain_term_is_walltime "" ${now} && echo yes || echo no`), /no/);
  } finally {
    h.cleanup();
  }
});
