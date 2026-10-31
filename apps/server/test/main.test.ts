import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function entryPointFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-main-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(new URL("../src/main.js", import.meta.url), join(root, "main.js"));
  copyFileSync(new URL("../src/startup-status.js", import.meta.url), join(root, "startup-status.js"));
  const core = join(root, "node_modules", "@brainstorm-agentic", "core");
  const utilities = join(core, "dist", "src", "util");
  mkdirSync(utilities, { recursive: true });
  writeFileSync(join(core, "package.json"), JSON.stringify({ type: "module", exports: "./dist/src/index.js" }));
  // The shared Node floor is available, but the core index and all of its
  // runtime modules are deliberately absent, as are launch dependencies.
  for (const name of ["node-version.js", "semver.js"]) {
    copyFileSync(new URL(`./util/${name}`, import.meta.resolve("@brainstorm-agentic/core")), join(utilities, name));
  }
  return root;
}

test("desktop compatibility and help work without any launch dependencies, retaining the Node floor", () => {
  const root = entryPointFixture();
  const statusPath = join(root, "startup.json");
  try {
    // No server, settings, HTTP proxy, auth, registry client, or provider SDKs
    // exist beside this entry point. Eagerly importing any one must fail.
    const run = (...args: string[]) => spawnSync(process.execPath, args, {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, BRAINSTORM_API_TOKEN_FILE: join(root, "token"), BRAINSTORM_STARTUP_STATUS_FILE: statusPath },
    });
    const check = run("main.js", "desktop-check");
    assert.equal(check.status, 0, check.stderr || check.error?.message);
    assert.equal(check.stdout.trim(), "CO_INFERENCE_PROTOCOL=1");
    const help = run("main.js", "--help");
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: brain launch/);
    assert.equal(run("main.js", "unknown-command").status, 2);
    assert.equal(existsSync(statusPath), false, "compatibility and help must not overwrite live startup progress");

    writeFileSync(join(root, "old-node.cjs"), 'Object.defineProperty(process.versions, "node", { value: "20.0.0" });');
    const unsupported = run("--require", "./old-node.cjs", "main.js", "desktop-check");
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /needs Node\.js 22\.13\.0 or newer/);
    assert.doesNotMatch(unsupported.stdout, /CO_INFERENCE_PROTOCOL=/);

    // A failed application import still leaves safe progress diagnostics.
    const failed = run("main.js", "launch", "--no-open");
    assert.equal(failed.status, 1);
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.equal(status.phase, "failed");
    assert.doesNotMatch(status.message, /ERR_MODULE_NOT_FOUND|\/tmp|token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch passes desktop options and handles SIGTERM as soon as it announces readiness", async () => {
  const root = entryPointFixture();
  const tokenPath = join(root, "token");
  const statusPath = join(root, "startup.json");
  writeFileSync(tokenPath, "a".repeat(64), { mode: 0o600 });
  copyFileSync(new URL("../src/desktop-auth.js", import.meta.url), join(root, "desktop-auth.js"));
  writeFileSync(join(root, "proxy.js"), 'export function configureOutboundHttp() { return "test"; }');
  writeFileSync(join(root, "settings.js"), 'export const DEFAULT_CONTENT_REGISTRY_URL = "http://registry.test";');
  writeFileSync(join(root, "server.js"), `
    import { readFileSync, writeFileSync } from "node:fs";
    const progress = JSON.parse(readFileSync(process.env.BRAINSTORM_STARTUP_STATUS_FILE, "utf8"));
    if (progress.phase !== "loading" || progress.pid !== process.pid) throw new Error("missing loading progress before application import");
    // Deliver the same signal as an immediate desktop stop, without relying
    // on scheduling between the launcher and the parent test process.
    const log = console.log.bind(console);
    console.log = (...args) => {
      log(...args);
      if (String(args[0]).startsWith("BRAIN_URL=")) process.kill(process.pid, "SIGTERM");
    };
    export async function startBrainServer(options) {
      options.onStartupPhase("initializing");
      writeFileSync("options.json", JSON.stringify(options));
      const timer = setInterval(() => {}, 1000);
      options.onStartupPhase("listening");
      return { url: "http://127.0.0.1:43210", async close() {
        clearInterval(timer); writeFileSync("closed", "yes");
      } };
    }
  `);
  const child = spawn(process.execPath, [
    "main.js", "launch", "--ip", "127.0.0.1", "--port", "43210",
    "--workspace", join(root, "workspace"), "--no-open", "--no-self-update",
    "--content-registry-url", "http://configured-registry.test",
  ], {
    cwd: root,
    env: { ...process.env, BRAINSTORM_API_TOKEN_FILE: tokenPath, BRAINSTORM_STARTUP_STATUS_FILE: statusPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error(`launch did not announce its URL: ${stderr}`)), 10_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("BRAIN_URL=http://127.0.0.1:43210")) { clearTimeout(timer); resolve(); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`launch exited early: ${stderr}`)); });
    });
    const options = JSON.parse(readFileSync(join(root, "options.json"), "utf8"));
    assert.equal(options.workspace, join(root, "workspace"));
    assert.equal(options.host, "127.0.0.1");
    assert.equal(options.port, 43210);
    assert.equal(options.apiToken, "a".repeat(64));
    assert.equal(options.contentRegistryUrl, "http://configured-registry.test");
    assert.equal(options.selfUpdateCheck, false);
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.equal(status.phase, "ready");
    assert.equal(status.pid, child.pid);
    assert.equal(status.schemaVersion, 1);
    assert.equal(statSync(statusPath).mode & 0o777, 0o600);
    assert.deepEqual(await exited, [0, null]);
    assert.equal(existsSync(join(root, "closed")), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
