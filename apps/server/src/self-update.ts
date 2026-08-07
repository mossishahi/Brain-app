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
}

export interface StartedAppUpdate {
  /** Where the updater logs every step (fetch, checkout, build, relaunch). */
  readonly logFile: string;
  readonly scriptFile: string;
}

/** POSIX single-quote escaping so paths and args survive the shell verbatim. */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The self-contained updater. It runs detached from the dying server:
 * 1. wait for the server process to exit (the tree must be quiet);
 * 2. fetch tags and check out the release tag;
 * 3. `npm ci` + `npm run build`;
 * 4. relaunch the server with its original command line — or, when any step
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
  git checkout --quiet "$previous" \\
    && npm ci --no-audit --no-fund \\
    && npm run build \\
    && ${relaunch} \\
    && echo "[updater] previous version relaunched" \\
    || echo "[updater] ROLLBACK FAILED — relaunch manually with: npm ci && npm run build && npm run launch"
  exit 1
}
echo "[updater] fetching release tags"
git fetch --tags --quiet || echo "[updater] tag fetch failed; using locally known tags"
git rev-parse -q --verify ${shq(`refs/tags/${tag}`)} >/dev/null || { echo "[updater] tag ${tag} not found"; rollback; }
echo "[updater] checking out ${tag}"
git checkout --quiet ${shq(tag)} || rollback
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
 * Start the detached updater and return where it logs. The caller (the HTTP
 * handler) responds to the browser and then shuts the server down; the
 * updater takes over from there. Refuses when the tree has local
 * modifications — an update must never destroy work it cannot restore.
 */
export async function applyAppUpdate(
  options: ApplyAppUpdateOptions,
): Promise<StartedAppUpdate> {
  const repoRoot = await appRepoRoot();
  if (!repoRoot) {
    throw new Error("the app is not running from a git checkout; update it the way it was installed");
  }
  const dirty = await git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty !== "") {
    throw new Error(
      "the app checkout has local modifications; commit or stash them before updating",
    );
  }
  mkdirSync(options.stateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scriptFile = join(options.stateDir, `update-${stamp}.sh`);
  const logFile = join(options.stateDir, `update-${stamp}.log`);
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
  const log = openSync(logFile, "a");
  const child = spawn("bash", [scriptFile], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  return { logFile, scriptFile };
}
