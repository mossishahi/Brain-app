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

test("each generation is named for its number, so handovers are countable", () => {
  const h = harness();
  try {
    h.stub("scontrol", `echo "JobId=4242 TimeLimit=12:00:00"`);
    // A hand-submitted job is generation 1, whatever it is called.
    assert.equal(h.run("brain_next_name brain").trim(), "brain-2");
    assert.equal(h.run("brain_next_name brain-2").trim(), "brain-3");
    assert.equal(h.run("brain_next_name brain-9").trim(), "brain-10");
    // A name that ends in something that is not a generation is not mistaken
    // for one.
    assert.equal(h.run("brain_next_name brain-internal").trim(), "brain-internal-2");
  } finally {
    h.cleanup();
  }
});

test("one server per port survives the renaming that singleton used to cover", () => {
  const h = harness();
  try {
    h.stub("scontrol", `echo "JobId=4242 TimeLimit=12:00:00"`);
    // Every generation of ours, plus somebody else's job and our own worker
    // jobs, which must not be mistaken for a server.
    h.stub(
      "squeue",
      `printf '%s\n' "111 brain R" "222 brain-3 R" "333 b9-db4f75 R" "444 brain-4 PD"`,
    );
    assert.match(
      h.run(`brain_other_server_running brain 4242`),
      /^111 brain$/m,
      "a running generation is found, whatever it is numbered",
    );
    assert.equal(
      h.run(`brain_other_server_running brain 111 | head -1`).trim(),
      "222 brain-3",
      "and the job asking is never itself the answer",
    );
    assert.match(
      h.run(`brain_successor_pending brain && echo pending || echo none`),
      /pending/,
      "a queued successor is seen by prefix, not by an exact name",
    );
  } finally {
    h.cleanup();
  }
});

test("the successor is submitted once, with the job's walltime, and never duplicated", () => {
  const h = harness();
  try {
    h.stub("scontrol", `echo "JobId=4242 TimeLimit=24:00:00 EndTime=2026-08-19T22:00:00"`);
    h.stub("squeue", "exit 0"); // nothing of ours in the queue
    h.stub("sbatch", `printf '%s\\n' "$*" >> "$SBATCH_LOG"; echo "Submitted batch job 777"`);
    const log = join(h.root, "sbatch.log");
    const id = h.run(`brain_submit_successor /repo/deploy/slurm-launch.sh brain 2>/dev/null`, {
      SBATCH_LOG: log,
    });
    assert.equal(id.trim(), "777", "the id is returned for the trap to cancel if needed");
    assert.match(
      execFileSync("cat", [log], { encoding: "utf8" }).trim(),
      /^--time=24:00:00 --job-name=brain-2 --dependency=afterany:4242 \/repo\/deploy\/slurm-launch\.sh$/,
      "inherited walltime, the next generation's name, held behind THIS job by id, " +
        "and the REPO script rather than the per-job spool copy",
    );

    // With one already pending, a second is not queued: the queue would
    // otherwise fill with successors that can never all run.
    h.stub("squeue", `printf '%s\n' "999 brain-2 PD"`);
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

test("the wrapper can tell that its own script has been superseded on disk", () => {
  // The failure this exists for: the relaunch loop restarts the SERVER when a
  // release lands, but bash keeps the code it was started with and a #SBATCH
  // script is only re-read by a NEW job. A twelve-hour job that began before the
  // walltime handover existed rebuilt the server five times as releases landed,
  // ran the newest server all day, and still died at its walltime with no
  // successor — the renewal was on disk beside it the whole time. The wrapper now
  // execs its new copy, and this is the comparison that tells it to.
  const h = harness();
  try {
    const a = join(h.root, "launch.sh");
    const b = join(h.root, "renew.sh");
    writeFileSync(a, "one\n");
    writeFileSync(b, "two\n");
    const fingerprint = () => h.run(`brain_wrapper_fingerprint ${a} ${b}`);
    const before = fingerprint();
    assert.ok(before.trim().length > 0, "a fingerprint is taken");
    assert.equal(fingerprint(), before, "unchanged files fingerprint identically");

    writeFileSync(b, "two, revised\n");
    assert.notEqual(fingerprint(), before, "a changed source changes it");

    // A fingerprint that cannot be taken must read as UNCHANGED, never as
    // changed, or a job would re-exec itself in a loop.
    const missing = h.run(`brain_wrapper_fingerprint ${join(h.root, "gone.sh")}`);
    assert.equal(missing.trim(), "", "a missing source contributes nothing");
    assert.equal(
      h.run(`brain_wrapper_fingerprint ${a} ${join(h.root, "gone.sh")}`),
      h.run(`brain_wrapper_fingerprint ${a}`),
      "and never makes an otherwise identical set look different",
    );
  } finally {
    h.cleanup();
  }
});
