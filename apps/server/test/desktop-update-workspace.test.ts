import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canUpdateDesktopWorkspace } from "../src/desktop-update.js";

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "brain-update-workspace-"));
  const directory = join(workspace, "workspace", "jobs", "previous-run");
  const path = join(directory, "job.json");
  return { workspace, directory, path,
    write(record: unknown) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, JSON.stringify(record));
    },
    close() { rmSync(workspace, { recursive: true, force: true }); },
  };
}

const settled = { jobId: "previous-run", status: "completed", runner: "local" };

test("an unopened workspace is idle without creating settings, directories, or a server", () => {
  const f = fixture();
  try {
    assert.equal(canUpdateDesktopWorkspace(f.workspace), true);
    assert.deepEqual(readdirSync(f.workspace), []);
    f.write(settled);
    const before = readFileSync(f.path, "utf8");
    assert.equal(canUpdateDesktopWorkspace(f.workspace), true);
    assert.equal(readFileSync(f.path, "utf8"), before);
    assert.deepEqual(readdirSync(f.workspace), ["workspace"]);
    assert.equal(existsSync(join(f.workspace, "workspace", "sessions")), false);
  } finally { f.close(); }
});

test("a previous session's detached worker blocks update even when its completed job is trashed", async () => {
  const f = fixture();
  const workerPath = join(f.workspace, "worker.cjs");
  writeFileSync(workerPath, 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
  const worker = spawn(process.execPath, [workerPath, "run", "--run-id", settled.jobId,
    "--session-root", join(f.workspace, "workspace", "sessions")], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(worker, "exit");
  try {
    await once(worker.stdout!, "data");
    f.write({ ...settled, pid: worker.pid, trashedAt: 1 });
    const before = readFileSync(f.path, "utf8");
    assert.equal(canUpdateDesktopWorkspace(f.workspace, workerPath), false);
    assert.equal(readFileSync(f.path, "utf8"), before);
    worker.kill();
    await exited;
    assert.equal(canUpdateDesktopWorkspace(f.workspace, workerPath), true);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill("SIGKILL"); await exited; }
    f.close();
  }
});

test("an unrelated process reusing a historical PID does not block an unopened workspace", () => {
  const f = fixture();
  try {
    f.write({ ...settled, pid: process.pid });
    assert.equal(canUpdateDesktopWorkspace(f.workspace), true);
  } finally { f.close(); }
});

test("active, corrupt, unreadable, or redirected job state cannot authorize an update", () => {
  const f = fixture();
  try {
    for (const record of [
      { ...settled, status: "running" }, { ...settled, status: "unknown" },
      { ...settled, jobId: "different" }, { ...settled, runner: "unknown" },
      { ...settled, pid: -1 }, { ...settled, pid: "123" }, null, [],
    ]) {
      f.write(record);
      assert.equal(canUpdateDesktopWorkspace(f.workspace), false, JSON.stringify(record));
    }
    writeFileSync(f.path, "{");
    assert.equal(canUpdateDesktopWorkspace(f.workspace), false);
    rmSync(f.path);
    assert.equal(canUpdateDesktopWorkspace(f.workspace), false, "missing job records are uncertain");
    mkdirSync(f.path);
    assert.equal(canUpdateDesktopWorkspace(f.workspace), false, "a directory is not a readable job file");
    rmSync(f.directory, { recursive: true });
    symlinkSync(join(f.workspace, "missing"), f.directory);
    assert.equal(canUpdateDesktopWorkspace(f.workspace), false, "symlinked job directories cannot be skipped");
  } finally { f.close(); }
});
