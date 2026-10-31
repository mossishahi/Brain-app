import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultWorkerPath(): string {
  return fileURLToPath(new URL("../../../worker/dist/src/main.js", import.meta.url));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only a definitely absent process is safe to ignore.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Historical PIDs are reusable; only this job's shell or worker owns its files. */
export function ownedLocalWorkerAlive(
  record: { readonly jobId: string; readonly pid?: number },
  workspace: string,
  workerPath = defaultWorkerPath(),
): boolean {
  const { pid } = record;
  if (pid === undefined) return false;
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (!processAlive(pid)) return false;
  const jobDirectory = join(workspace, "workspace", "jobs", record.jobId);
  const scriptName = /^submit(?:-[a-z]+)*(?:-\d+)?\.sh$/;
  try {
    if (process.platform === "linux") {
      const bytes = readFileSync(`/proc/${pid}/cmdline`);
      if (bytes.length > 262_144) return true;
      if (bytes.length === 0) {
        // Zombies still answer kill(0), but cannot write to the workspace.
        const state = /\)\s+([A-Z])\s/.exec(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1];
        return state !== "Z" && processAlive(pid);
      }
      const args = bytes.toString("utf8").split("\0").filter(Boolean);
      if (basename(args[0] ?? "") === "bash" && args.length === 2) {
        return dirname(args[1]!) === jobDirectory && scriptName.test(basename(args[1]!));
      }
      const flag = (name: string, value: string) => {
        const index = args.indexOf(name, 3);
        return index >= 0 && args[index + 1] === value;
      };
      return basename(args[0] ?? "") === "node" && args[1] === workerPath &&
        (args[2] === "run" || args[2] === "resume") &&
        flag("--run-id", record.jobId) && flag("--session-root", join(workspace, "workspace", "sessions"));
    }
    // macOS has no /proc. ps is local, bounded, and never invokes a shell.
    const inspected = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8", timeout: 500, maxBuffer: 262_144,
    });
    if (inspected.error || inspected.status !== 0) return processAlive(pid);
    const command = inspected.stdout.trim();
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^(?:/[^\\s]+/)?bash ${escape(jobDirectory)}/submit(?:-[a-z]+)*(?:-\\d+)?\\.sh$`).test(command)) return true;
    const worker = new RegExp(`^(?:${escape(process.execPath)}|(?:[^\\s]+/)?node) ${escape(workerPath)} (?:run|resume)(?: |$)`);
    const flag = (name: string, value: string) => new RegExp(`(?:^| )${name} ${escape(value)}(?: |$)`).test(command);
    return worker.test(command) && flag("--run-id", record.jobId) && flag("--session-root", join(workspace, "workspace", "sessions"));
  } catch {
    // A process that disappeared is safe. An inaccessible live process is
    // uncertain, so preserve it rather than authorizing bundle replacement.
    return processAlive(pid);
  }
}

const SETTLED_STATUSES = new Set(["completed", "failed", "cancelled", "paused"]);

/**
 * Read-only update preflight before the desktop opens its local server. A
 * worker from an earlier desktop session may still use the installed bundle.
 * Unknown state blocks replacement; opening research can reconcile stale jobs.
 */
export function canUpdateDesktopWorkspace(workspace: string, workerPath = defaultWorkerPath()): boolean {
  const jobsDirectory = join(workspace, "workspace", "jobs");
  try {
    let entries;
    try {
      if (!lstatSync(jobsDirectory).isDirectory()) return false;
      entries = readdirSync(jobsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    for (const entry of entries) {
      // Job directories are never symlinks. Do not silently skip an unknown
      // record that could still describe a worker using the application.
      if (entry.isSymbolicLink()) return false;
      if (!entry.isDirectory()) continue;
      const path = join(jobsDirectory, entry.name, "job.json");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return false;
      const record: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
      const { jobId, status, runner, pid } = record as Record<string, unknown>;
      if (jobId !== entry.name || (runner !== "local" && runner !== "slurm") ||
          typeof status !== "string" || !SETTLED_STATUSES.has(status) ||
          (pid !== undefined && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0))) return false;
      if (runner === "local" && ownedLocalWorkerAlive({ jobId, pid: pid as number | undefined }, workspace, workerPath)) return false;
    }
    return true;
  } catch {
    // Unreadable/malformed job state cannot authorize bundle replacement.
    return false;
  }
}
