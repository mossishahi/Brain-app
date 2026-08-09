/**
 * Pull-based app self-update, the standard for git-distributed self-hosted
 * software: releases are annotated `app/v<semver>` tags; the server fetches
 * tags from the remote (best effort — offline and remoteless clones are
 * fine), compares the highest release against the running version, and
 * surfaces the result for the dashboard to display.
 *
 * Detection never applies anything. Applying is a separate, user-initiated
 * step (`applyAppUpdate`): the server writes a self-contained updater script,
 * spawns it detached, and exits; the updater waits for the server to die,
 * checks out the release tag, reinstalls and rebuilds, and relaunches the
 * server with its original command line — same port, so the user's browser
 * tab reconnects and reloads itself into the new version. No user ever runs
 * git or npm by hand. Active jobs are separate detached processes reading
 * and writing workspace files; they keep running across the restart and the
 * relaunched server adopts them from disk.
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface AppUpdate {
  readonly version: string;
  readonly notes?: string;
}

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return stdout.trim();
}

async function appRepoRoot(): Promise<string | undefined> {
  try {
    return await git(dirname(fileURLToPath(import.meta.url)), [
      "rev-parse",
      "--show-toplevel",
    ]);
  } catch {
    return undefined;
  }
}

function newer(candidate: string, current: string): boolean {
  const [a, b] = [candidate.split(".").map(Number), current.split(".").map(Number)];
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

export async function checkAppUpdate(
  currentVersion: string,
): Promise<AppUpdate | undefined> {
  const repoRoot = await appRepoRoot();
  if (!repoRoot) return undefined;
  try {
    await git(repoRoot, ["fetch", "--tags", "--quiet"]);
  } catch {
    // No remote or no network: compare against locally known tags.
  }
  try {
    const versions = (await git(repoRoot, ["tag", "-l", "app/v*"]))
      .split("\n")
      .map((tag) => tag.slice("app/v".length))
      .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
      .sort((a, b) => (newer(a, b) ? 1 : -1));
    const best = versions[versions.length - 1];
    if (!best || !newer(best, currentVersion)) return undefined;
    const notes = await git(repoRoot, [
      "tag",
      "-l",
      `app/v${best}`,
      "--format",
      "%(contents:subject)",
    ]).catch(() => "");
    return { version: best, ...(notes ? { notes } : {}) };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Applying an update
// ---------------------------------------------------------------------------

export interface RelaunchCommand {
  /** Executable to relaunch with (normally process.execPath). */
  readonly command: string;
  /** Arguments (normally process.argv.slice(1)) — same port, same flags. */
  readonly args: readonly string[];
  /** Working directory to relaunch from. */
  readonly cwd: string;
}

export interface ApplyAppUpdateOptions {
  /** The release to move to (an existing `app/v<version>` tag). */
  readonly targetVersion: string;
  /** Directory for the updater script and its log (kept for diagnosis). */
  readonly stateDir: string;
  readonly relaunch: RelaunchCommand;
  /** The server process the updater must wait out. Defaults to process.pid. */
  readonly pid?: number;
  /** Environment consulted for SLURM detection. Test seam. */
  readonly env?: NodeJS.ProcessEnv;
  /** Repository to update; defaults to the running app's checkout. Test seam. */
  readonly repoRoot?: string;
}

export interface StartedAppUpdate {
  /** Where the updater logs every step (fetch, checkout, build, relaunch). */
  readonly logFile: string;
  /** The detached updater script; absent on the in-process SLURM path. */
  readonly scriptFile?: string;
}

/** POSIX single-quote escaping so paths and args survive the shell verbatim. */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The self-contained updater. It runs detached from the dying server:
 * 1. wait for the server process to exit (the tree must be quiet);
 * 2. set aside any local modifications with `git stash` (recoverable —
 *    bootstrap installs routinely carry an npm-rewritten package-lock, and
 *    an update must neither destroy changes nor fail over them);
 * 3. fetch tags and check out the release tag;
 * 4. `npm ci` + `npm run build`;
 * 5. relaunch the server with its original command line — or, when any step
 *    fails, roll back to the previous checkout, rebuild, and relaunch THAT,
 *    so a broken update never leaves the user without a running app.
 * Everything is logged to one file the dashboard can point at.
 */
export function buildUpdaterScript(input: {
  readonly repoRoot: string;
  readonly targetVersion: string;
  readonly relaunch: RelaunchCommand;
  readonly pid: number;
}): string {
  const tag = `app/v${input.targetVersion}`;
  const relaunch = [
    `cd ${shq(input.relaunch.cwd)}`,
    `nohup ${[input.relaunch.command, ...input.relaunch.args].map(shq).join(" ")} >/dev/null 2>&1 &`,
  ].join(" && ");
  return `#!/usr/bin/env bash
# brainstorm self-updater (written by the server; safe to delete)
set -u
echo "[updater] target ${tag}"
echo "[updater] waiting for the server (pid ${input.pid}) to exit"
for _ in $(seq 1 240); do
  kill -0 ${input.pid} 2>/dev/null || break
  sleep 0.5
done
if kill -0 ${input.pid} 2>/dev/null; then
  echo "[updater] the server never exited; aborting without touching the tree"
  exit 1
fi
cd ${shq(input.repoRoot)}
previous=$(git rev-parse HEAD)
echo "[updater] previous checkout: $previous"
rollback() {
  echo "[updater] update failed; rolling back to $previous"
  if [ -n "\${SLURM_JOB_ID:-}" ]; then
    git checkout --quiet "$previous" \\
      && echo "[updater] previous checkout restored; the launch wrapper relaunches it" \\
      || echo "[updater] ROLLBACK FAILED — restore manually: git checkout $previous"
    exit 1
  fi
  if git checkout --quiet "$previous" && npm ci --no-audit --no-fund && npm run build; then
    ${relaunch}
    echo "[updater] previous version relaunched"
  else
    echo "[updater] ROLLBACK FAILED — relaunch manually with: npm ci && npm run build && npm run launch"
  fi
  exit 1
}
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "[updater] local modifications detected; setting them aside recoverably (git stash list to inspect)"
  git -c user.name=brainstorm-updater -c user.email=updater@localhost \\
    stash push --quiet -m ${shq(`brainstorm self-update to ${tag}`)} || rollback
fi
echo "[updater] fetching release tags"
git fetch --tags --quiet || echo "[updater] tag fetch failed; using locally known tags"
git rev-parse -q --verify ${shq(`refs/tags/${tag}`)} >/dev/null || { echo "[updater] tag ${tag} not found"; rollback; }
echo "[updater] checking out ${tag}"
git checkout --quiet ${shq(tag)} || rollback
if [ -n "\${SLURM_JOB_ID:-}" ]; then
  # Inside a SLURM allocation the job ends (and this process dies) with the
  # batch script, and relaunching here would race the wrapper's loop. The
  # launch wrapper owns rebuild + relaunch: it waits for this script to
  # exit, sees the new checkout, builds it, and starts the server again.
  echo "[updater] SLURM job \${SLURM_JOB_ID}: ${tag} checked out — handing rebuild and relaunch to the launch wrapper"
  echo "[updater] done — waiting wrapper will rebuild ${tag}"
  exit 0
fi
echo "[updater] installing dependencies"
npm ci --no-audit --no-fund || rollback
echo "[updater] building"
npm run build || rollback
echo "[updater] relaunching the server"
${relaunch}
echo "[updater] done — now running ${tag}"
`;
}

/**
 * Applies the checkout for a SLURM deployment, in-process, BEFORE the server
 * exits. Nothing here relies on a detached process surviving the server:
 * inside a SLURM job the updater's process dies with the job's cgroup the
 * moment the server (the job's task) exits — observed in production as a
 * two-line updater log, a dead dashboard, and an update that never landed.
 * Ordering fixes it: stash, fetch, and check out the release while the
 * server is still alive (dist/ is gitignored, so the running build is
 * untouched), answer the browser, and only then exit; the launch wrapper's
 * loop rebuilds the already-checked-out release and relaunches it. A
 * failure restores the previous checkout and throws — the endpoint answers
 * 409 and the server keeps running, which is strictly better than dying
 * over a broken tree.
 */
async function applySlurmCheckout(
  repoRoot: string,
  targetVersion: string,
  jobId: string,
  logFile: string,
): Promise<void> {
  const tag = `app/v${targetVersion}`;
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
    writeFileSync(logFile, `${lines.join("\n")}\n`);
  };
  log(`[updater] target ${tag}`);
  log(
    `[updater] SLURM job ${jobId}: applying the checkout in-process before the server exits ` +
      "(a detached updater would die with the job's cgroup)",
  );
  const previous = await git(repoRoot, ["rev-parse", "HEAD"]);
  log(`[updater] previous checkout: ${previous}`);
  const rollback = async (reason: string): Promise<never> => {
    log(`[updater] ${reason}; restoring ${previous}`);
    await git(repoRoot, ["checkout", "--quiet", previous]).catch(() => {
      log(`[updater] ROLLBACK FAILED — restore manually: git checkout ${previous}`);
    });
    throw new Error(`${reason} — the server keeps running; details in ${logFile}`);
  };
  const dirty = await git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty !== "") {
    log("[updater] local modifications detected; setting them aside recoverably (git stash list to inspect)");
    await run(
      "git",
      [
        "-C", repoRoot,
        "-c", "user.name=brainstorm-updater",
        "-c", "user.email=updater@localhost",
        "stash", "push", "--quiet", "-m", `brainstorm self-update to ${tag}`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    ).catch(() => rollback("stashing local modifications failed"));
  }
  log("[updater] fetching release tags");
  await run("git", ["-C", repoRoot, "fetch", "--tags", "--quiet"], {
    encoding: "utf8",
    timeout: 60_000,
  }).catch(() => {
    log("[updater] tag fetch failed; using locally known tags");
  });
  await git(repoRoot, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).catch(() =>
    rollback(`tag ${tag} not found`),
  );
  log(`[updater] checking out ${tag}`);
  await git(repoRoot, ["checkout", "--quiet", tag]).catch(() =>
    rollback(`checking out ${tag} failed`),
  );
  log(
    `[updater] ${tag} checked out — the launch wrapper rebuilds and relaunches it after this server exits`,
  );
  log("[updater] done — the waiting wrapper builds the new checkout");
}

/**
 * Start the detached updater and return where it logs. The caller (the HTTP
 * handler) responds to the browser and then shuts the server down; the
 * updater takes over from there. Local modifications never block the update
 * and are never destroyed: the updater sets them aside with `git stash`
 * (bootstrap installs routinely carry an npm-rewritten package-lock).
 *
 * Under SLURM there is no detached updater at all: the checkout is applied
 * in-process before the server exits (see applySlurmCheckout), and the
 * launch wrapper's loop owns rebuild + relaunch.
 */
export async function applyAppUpdate(
  options: ApplyAppUpdateOptions,
): Promise<StartedAppUpdate> {
  const repoRoot = options.repoRoot ?? (await appRepoRoot());
  if (!repoRoot) {
    throw new Error("the app is not running from a git checkout; update it the way it was installed");
  }
  mkdirSync(options.stateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scriptFile = join(options.stateDir, `update-${stamp}.sh`);
  const logFile = join(options.stateDir, `update-${stamp}.log`);
  const jobId = (options.env ?? process.env).SLURM_JOB_ID;
  if (jobId !== undefined && jobId !== "") {
    await applySlurmCheckout(repoRoot, options.targetVersion, jobId, logFile);
    return { logFile };
  }
  writeFileSync(
    scriptFile,
    buildUpdaterScript({
      repoRoot,
      targetVersion: options.targetVersion,
      relaunch: options.relaunch,
      pid: options.pid ?? process.pid,
    }),
    { mode: 0o700 },
  );
  // Syntax-check the generated script BEFORE the server commits to exiting:
  // an updater that dies parsing would otherwise leave no server running at
  // all — the one outcome this whole mechanism must never produce.
  try {
    await run("bash", ["-n", scriptFile], { timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `the generated updater script failed its syntax check; not updating (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  const log = openSync(logFile, "a");
  const child = spawn("bash", [scriptFile], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  return { logFile, scriptFile };
}
