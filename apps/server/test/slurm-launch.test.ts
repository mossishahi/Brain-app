import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function findLauncher(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let up = 0; up < 6; up += 1) {
    const candidate = join(dir, "deploy", "slurm-launch.sh");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("deploy/slurm-launch.sh not found above this test");
}

// Exercise the actual startup code in both a checkout and a SLURM spool copy.
// Stop at the bootstrap boundary so these tests can never download Node, fetch
// releases, build the application, start a server, or submit a scheduler job.
const launcher = readFileSync(findLauncher(), "utf8");
const bootstrapBoundary = 'if [ ! -x "$NODE_DIR/bin/node" ]; then';
const bootstrapOffset = launcher.indexOf(bootstrapBoundary);
assert.ok(bootstrapOffset > 0, "the launcher's Node bootstrap boundary exists");
const startupProbe = `${launcher.slice(0, bootstrapOffset)}
printf 'BOOTSTRAP-REACHED\\n'
printf 'RESOLVED-APP=%s\\n' "$APP"
bash -c 'printf "EXPORTED-APP=%s\\n" "\${BRAIN_APP_DIR-}"'
`;

interface LaunchResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "slurm-launch-"));
  const app = join(root, "Brain app");
  const unrelated = join(root, "submission directory");
  const bin = join(root, "bin");
  const script = join(app, "deploy", "slurm-launch.sh");
  const spool = join(root, "slurmd", "job4242", "slurm_script");
  for (const directory of [join(app, "apps", "server"), dirname(script), dirname(spool), unrelated, bin]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(app, "package.json"), '{"name":"brainstorm-agentic-app"}\n');
  writeFileSync(join(app, "apps", "server", "package.json"), '{"name":"brainstorm-agentic-server"}\n');
  writeFileSync(join(app, "deploy", "slurm-renew.sh"), "# fixture root marker\n");
  writeFileSync(script, startupProbe);
  writeFileSync(spool, startupProbe);

  function stub(name: string, body: string): void {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  }

  // A source archive has no Git metadata: directory walking must still work.
  stub("git", "exit 1");
  stub("scontrol", `printf 'JobId=4242 JobName=brain\\n   Command=%s\\n   WorkDir=%s\\n   EndTime=Unknown\\n' "\${LAUNCH_TEST_COMMAND:-(null)}" "$LAUNCH_TEST_SUBMIT"`);
  // If root detection ever moves a side effect ahead of validation, record it
  // and refuse it instead of invoking anything real from the developer's PATH.
  for (const command of ["curl", "tar", "npm", "sbatch", "squeue"]) {
    stub(command, `printf 'UNEXPECTED-SIDE-EFFECT: ${command}\\n' >&2; exit 99`);
  }

  return {
    root,
    app: realpathSync(app),
    unrelated,
    script,
    spool,
    run(entry: string, cwd: string, overrides: Record<string, string> = {}): LaunchResult {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("SLURM_") || key.startsWith("BRAIN_") || key === "BASH_ENV" || key === "CDPATH") {
          delete env[key];
        }
      }
      const result = spawnSync("bash", [entry], {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          LAUNCH_TEST_SUBMIT: cwd,
          ...overrides,
        },
      });
      assert.ifError(result.error);
      assert.doesNotMatch(result.stderr, /UNEXPECTED-SIDE-EFFECT/, "startup must not run deployment side effects");
      return result;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertResolved(result: LaunchResult, expected: string): void {
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  assert.ok(lines.includes("BOOTSTRAP-REACHED"), result.stdout);
  assert.ok(lines.includes(`RESOLVED-APP=${expected}`), result.stdout);
  assert.ok(lines.includes(`EXPORTED-APP=${expected}`), "successors must inherit the canonical root: " + result.stdout);
}

test("a SLURM spool copy submitted from deploy resolves the app root", () => {
  const h = harness();
  try {
    const deploy = join(h.app, "deploy");
    assertResolved(h.run(h.spool, deploy, { SLURM_JOB_ID: "4242", SLURM_SUBMIT_DIR: deploy }), h.app);
  } finally {
    h.cleanup();
  }
});

test("a SLURM spool copy submitted from the repository root still resolves it", () => {
  const h = harness();
  try {
    assertResolved(h.run(h.spool, h.app, { SLURM_JOB_ID: "4242", SLURM_SUBMIT_DIR: h.app }), h.app);
  } finally {
    h.cleanup();
  }
});

test("the original SLURM Command locates the checkout from an unrelated submit directory", () => {
  const h = harness();
  try {
    assertResolved(h.run(h.spool, h.unrelated, {
      SLURM_JOB_ID: "4242",
      SLURM_SUBMIT_DIR: h.unrelated,
      // Spaces in the checkout path must survive scontrol's Command field.
      LAUNCH_TEST_COMMAND: h.script,
    }), h.app);
  } finally {
    h.cleanup();
  }
});

test("an explicit app directory wins and exports its canonical ancestor", () => {
  const h = harness();
  try {
    const alias = join(h.root, "checkout alias");
    symlinkSync(h.app, alias, "dir");
    assertResolved(h.run(h.spool, h.unrelated, {
      BRAIN_APP_DIR: join(alias, "deploy"),
      SLURM_JOB_ID: "4242",
      SLURM_SUBMIT_DIR: h.unrelated,
      LAUNCH_TEST_COMMAND: join(h.unrelated, "wrong-launcher.sh"),
    }), h.app);
  } finally {
    h.cleanup();
  }
});

test("an invalid explicit app directory fails before bootstrap instead of falling back", () => {
  const h = harness();
  try {
    const result = h.run(h.spool, h.app, {
      BRAIN_APP_DIR: h.unrelated,
      SLURM_JOB_ID: "4242",
      SLURM_SUBMIT_DIR: h.app,
      LAUNCH_TEST_COMMAND: h.script,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /BOOTSTRAP-REACHED/);
    assert.match(result.stderr + result.stdout, /BRAIN_APP_DIR/);
  } finally {
    h.cleanup();
  }
});

test("an unlocatable checkout fails before bootstrap with a useful diagnostic", () => {
  const h = harness();
  try {
    const result = h.run(h.spool, h.unrelated, { SLURM_JOB_ID: "4242", SLURM_SUBMIT_DIR: h.unrelated });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /BOOTSTRAP-REACHED/);
    assert.match(result.stderr + result.stdout, /BRAIN_APP_DIR/);
  } finally {
    h.cleanup();
  }
});

test("a direct invocation resolves the script's checkout independently of cwd", () => {
  const h = harness();
  try {
    assertResolved(h.run(h.script, h.unrelated), h.app);
  } finally {
    h.cleanup();
  }
});
