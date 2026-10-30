import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStartupReporter, type StartupStatus } from "../src/startup-status.js";

test("startup progress is atomic, private, process-bound, and contains only fixed messages", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-startup-status-"));
  const path = join(root, "startup.json");
  try {
    const report = createStartupReporter({
      BRAINSTORM_STARTUP_STATUS_FILE: path,
      BRAINSTORM_API_TOKEN_FILE: "/private/token-do-not-publish",
      ANTHROPIC_API_KEY: "secret-do-not-publish",
    });
    report("loading");
    const initial = JSON.parse(readFileSync(path, "utf8")) as StartupStatus;
    assert.equal(initial.schemaVersion, 1);
    assert.equal(initial.pid, process.pid);
    assert.equal(initial.hostname, hostname());
    assert.equal(initial.phase, "loading");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    report("ready");
    const ready = JSON.parse(readFileSync(path, "utf8")) as StartupStatus;
    assert.equal(ready.startedAt, initial.startedAt);
    assert.ok(ready.updatedAt >= initial.updatedAt);
    assert.equal(ready.phase, "ready");
    assert.deepEqual(readdirSync(root), ["startup.json"], "atomic writes must not leave temporary files");
    assert.doesNotMatch(readFileSync(path, "utf8"), /secret-do-not-publish|token-do-not-publish/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reporting is optional and cannot create or use unsafe directories", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-startup-unavailable-"));
  const path = join(root, "startup.json");
  try {
    createStartupReporter({ BRAINSTORM_STARTUP_STATUS_FILE: path })("loading");
    assert.equal(existsSync(path), false, "ordinary launches do not publish desktop progress");
    const env = { BRAINSTORM_STARTUP_STATUS_FILE: path, BRAINSTORM_API_TOKEN_FILE: "/token" };
    chmodSync(root, 0o755);
    assert.doesNotThrow(() => createStartupReporter(env)("loading"));
    assert.equal(existsSync(path), false);
    chmodSync(root, 0o700);
    const missing = join(root, "missing", "startup.json");
    assert.doesNotThrow(() => createStartupReporter({ ...env, BRAINSTORM_STARTUP_STATUS_FILE: missing })("loading"));
    assert.equal(existsSync(join(root, "missing")), false);
    symlinkSync(root, join(root, "link"), "dir");
    createStartupReporter({ ...env, BRAINSTORM_STARTUP_STATUS_FILE: join(root, "link", "startup.json") })("loading");
    assert.equal(existsSync(path), false);
    // A failed final rename is contained and its temporary file is removed.
    mkdirSync(path);
    assert.doesNotThrow(() => createStartupReporter(env)("failed"));
    assert.deepEqual(readdirSync(root).sort(), ["link", "startup.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
