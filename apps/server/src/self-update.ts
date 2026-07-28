/**
 * Pull-based app self-update check, the standard for git-distributed
 * self-hosted software: releases are annotated `app/v<semver>` tags; the
 * server fetches tags from the remote (best effort — offline and remoteless
 * clones are fine), compares the highest release against the running
 * version, and surfaces the result for the dashboard to display. Nothing is
 * ever applied automatically.
 */
import { execFile } from "node:child_process";
import { dirname } from "node:path";
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
