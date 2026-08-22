import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  COT_STEP_PARTS,
  GPU_COMMAND_TAG,
  isCotStepParts,
  SLURM_COMMAND_TAG,
  type JobDetail,
  type JobSummary,
  type ReadinessReport,
  type ServerSettings,
  type ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";

import {
  aggregateToolUsage,
  buildOrchestrationCommand,
  applyAppUpdate,
  buildUpdaterScript,
  DEFAULT_SLURM_TEMPLATE,
  defaultReadinessProbes,
  defaultServerSettings,
  type ReadinessProbeContext,
  JobManager,
  ReadinessProbeError,
  ReadinessService,
  renderSlurmTemplate,
  SettingsStore,
  shellQuote,
  startBrainServer,
  type ApplyAppUpdateOptions,
  type RunningBrainServer,
  type StartBrainServerOptions,
} from "../src/index.js";
import { startTestRegistry } from "./mcp-registry.js";

function tempRoot(prefix = "brain-server-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Removes a test workspace, tolerating a worker that has not finished.
 *
 * A job's status comes from its checkpoint, and the worker writes its telemetry
 * record AFTER the checkpoint marks the run terminal. The worker is also
 * deliberately detached and unref'd so a run survives a server restart, so
 * neither the server nor a test can await it. "completed" therefore means the
 * pipeline finished, not that nothing is still writing — and a plain recursive
 * remove races the tail of that bookkeeping and fails with ENOTEMPTY.
 *
 * This retries briefly rather than ignoring the error, so a directory that is
 * genuinely stuck still fails the test instead of leaking silently.
 */
async function removeWorkspace(root: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const brainRepoRoot = fileURLToPath(new URL("../../../../../brain/", import.meta.url));
function materializedStoreRoot(): string {
  execFileSync(
    process.execPath,
    [join(brainRepoRoot, "scripts", "materialize-store.mjs"), "--quiet"],
    { stdio: "inherit" },
  );
  return join(brainRepoRoot, ".registry-store");
}
const staticRegistryRoot =
  process.env.BRAIN_TEST_REGISTRY_DIR ?? materializedStoreRoot();

/**
 * The bundle version a new run pins: this repository's declared pin.
 *
 * Reading the store's `latest` is what let a registry publish rewrite the
 * inputs of app tags that had already shipped: content alone could redden a
 * released commit. `BRAIN_TEST_BUNDLE_VERSION` overrides the pin for one run,
 * and its literal value "latest" restores the floating resolution for CI's
 * canary lane, which reports the next bump's cost without failing the workflow.
 *
 * The registry double is started advertising this same version (see
 * `startTestRegistry`), because the server picks a run's version by asking the
 * registry for its latest — pinning only the assertion side would leave the
 * server executing different content from the one these tests claim.
 */
function pinnedBundleVersion(): string {
  const override = process.env.BRAIN_TEST_BUNDLE_VERSION;
  if (override === "latest") {
    const index = JSON.parse(
      readFileSync(join(staticRegistryRoot, "index.json"), "utf8"),
    ) as { bundles: Array<{ id: string; latest: string }> };
    return index.bundles.find((bundle) => bundle.id === "brainstorm")!.latest;
  }
  if (override) return override;
  return (
    JSON.parse(
      readFileSync(new URL("../../../../test-bundle.json", import.meta.url), "utf8"),
    ) as { version: string }
  ).version;
}

/**
 * Where this run states what it actually executed, for a caller that cannot see
 * inside it. The path is fixed at the app root so a gate needs no plumbing to
 * find it, and `.gitignore` carries it: it is a run artifact, not source.
 */
const bundleReceiptPath = fileURLToPath(
  new URL("../../../../.test-bundle-used.json", import.meta.url),
);
let bundleReceiptWritten = false;

/**
 * Records the bundle this suite really ran, once the registry double has agreed
 * to serve it.
 *
 * `brain/scripts/publish-bundle.mjs` gates a publish on this suite and aims it
 * at a candidate store through three environment variables. An earlier wiring
 * set only the store directory — and a store directory cannot move a pinned
 * suite off its pin — so the gate built a candidate store and then watched this
 * suite execute the PREVIOUS release and called the candidate green. That is
 * the original floating-`latest` bug rebuilt inside the check meant to catch
 * it, and re-reading its own environment can never catch it: the environment is
 * what the caller ASKED for, and the gap being hunted is exactly the gap
 * between the ask and the result. So the suite states the result, from the
 * values it resolved rather than from the variables that requested them.
 *
 * This runs only after `startTestRegistry` has refused a version the store does
 * not publish, so the receipt names content that exists on disk rather than a
 * string that merely parsed.
 *
 * Bookkeeping must never redden a run: a read-only checkout, or two suites
 * racing this path, costs the receipt and not the test result. A gate that
 * finds no receipt has still learned something true — that the suite never got
 * as far as serving a bundle — which is a usable answer; a suite that failed
 * over its own note-taking would not be.
 */
function recordBundleUsed(version: string): void {
  if (bundleReceiptWritten) return;
  bundleReceiptWritten = true;
  const staging = `${bundleReceiptPath}.${process.pid}.tmp`;
  try {
    const storeRoot = realpathSync(staticRegistryRoot);
    const receipt = {
      bundle: "brainstorm",
      version,
      storeRoot,
      bundleDir: join(storeRoot, "bundles", "brainstorm", version),
      suite: "apps/server",
      // A reader must be able to tell this run's receipt from one a previous
      // run left behind after failing before it ever served a bundle.
      writtenAt: new Date().toISOString(),
    };
    // Write beside the target and rename, so a concurrent reader sees either
    // the old receipt or the new one, never half of either, and the rename
    // stays within one filesystem.
    writeFileSync(staging, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(staging, bundleReceiptPath);
  } catch {
    try {
      rmSync(staging, { force: true });
    } catch {
      // Nothing left to do: see above, a receipt is never worth a red run.
    }
  }
}

/**
 * The registry double every test here runs against, serving the pinned version
 * and leaving the receipt that says so. Tests start their registry through this
 * rather than calling `startTestRegistry` directly, so no path through the
 * suite can serve a bundle without recording which one.
 */
async function startPinnedTestRegistry(): ReturnType<typeof startTestRegistry> {
  const version = pinnedBundleVersion();
  const registry = await startTestRegistry(staticRegistryRoot, version);
  recordBundleUsed(version);
  return registry;
}

async function startTestBrainServer(
  options: Omit<StartBrainServerOptions, "contentRegistryUrl" | "contentRegistryStatus">,
): Promise<RunningBrainServer & { readonly registryReads: readonly string[] }> {
  const registry = await startPinnedTestRegistry();
  try {
    const server = await startBrainServer({
      // Production defaults a 3-minute post-start grace before unattended
      // gate countdowns arm (shift handovers must not swallow gates); the
      // suite's countdown tests need arming within seconds.
      gateAutoApproveGraceMs: 0,
      ...options,
      contentRegistryUrl: registry.url,
      contentRegistryStatus: { running: true, url: registry.url },
    });
    return {
      ...server,
      registryReads: registry.reads,
      close: async () => {
        await server.close();
        await registry.close();
      },
    };
  } catch (error) {
    await registry.close();
    throw error;
  }
}

async function requestJson<T>(
  server: RunningBrainServer,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; value: T }> {
  const response = await fetch(`${server.url}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return { status: response.status, value: await response.json() as T };
}

async function putSettings(
  server: RunningBrainServer,
  update: Partial<ServerSettingsUpdate>,
): Promise<ServerSettings> {
  const current = (await requestJson<ServerSettings>(server, "/api/settings")).value;
  return (
    await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ...current, ...update }),
    })
  ).value;
}

async function submit(
  server: RunningBrainServer,
  topic: string,
  attachments?: readonly string[],
  capabilityOverrides?: Readonly<Record<string, boolean>>,
): Promise<string> {
  const response = await requestJson<{ jobId: string }>(server, "/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      topic,
      ...(attachments ? { attachments } : {}),
      ...(capabilityOverrides ? { capabilityOverrides } : {}),
    }),
  });
  assert.equal(response.status, 200);
  return response.value.jobId;
}

async function waitFor(
  server: RunningBrainServer,
  jobId: string,
  status: string,
  // Look-ahead seating fills every topic-level seat, so offline pipelines
  // legitimately review twice the members they used to; suite-parallel load
  // stretches that further.
  timeoutMs = 180_000,
): Promise<JobDetail> {
  const deadline = Date.now() + timeoutMs;
  let latest: JobDetail | undefined;
  while (Date.now() < deadline) {
    const response = await requestJson<JobDetail>(server, `/api/jobs/${jobId}`);
    assert.equal(response.status, 200);
    latest = response.value;
    if (latest.status === status) return latest;
    if (latest.status === "failed") {
      throw new Error(`job ${jobId} failed: ${latest.error ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `job ${jobId} did not reach ${status}; latest=${latest?.status ?? "none"}`,
  );
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

test("settings roundtrip and template validation", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    const changed = await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });
    assert.equal(changed.runner, "local");
    assert.equal(changed.panelConfirmation, "auto");
    assert.equal(changed.llm.provider, "offline");

    const invalid = await requestJson<{ message: string }>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ...changed, slurmTemplate: "#!/bin/bash\ntrue\n" }),
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.value.message, new RegExp(SLURM_COMMAND_TAG.replace(/[{}]/g, "\\$&")));

    // Review-round override: set, keep when the update omits it, clear via {}.
    const withRounds = await putSettings(server, { review: { maxRounds: 6 } });
    assert.equal(withRounds.review?.maxRounds, 6);
    const { review: _omitted, ...withoutReview } = withRounds;
    const kept = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify(withoutReview),
    });
    assert.equal(kept.status, 200);
    assert.equal(kept.value.review?.maxRounds, 6);
    const cleared = await putSettings(server, { review: {} });
    assert.equal(cleared.review, undefined);
    const outOfRange = await requestJson<{ message: string }>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ...changed, review: { maxRounds: 11 } }),
    });
    assert.equal(outOfRange.status, 400);
    assert.match(outOfRange.value.message, /review\.maxRounds/);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("the registry endpoint is deployment-owned: PUT ignores it and health reports versions", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    const initial = (
      await requestJson<ServerSettings>(server, "/api/settings")
    ).value;
    const deploymentUrl = initial.contentRegistry.url;
    assert.ok(deploymentUrl.length > 0);

    // A user submitting a different registry URL/bundle/pin changes nothing:
    // the field is deployment configuration, not a setting.
    const tampered = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...initial,
        llm: { provider: "offline" },
        contentRegistry: {
          url: "https://attacker.example/mcp",
          bundle: "not-brainstorm",
          version: "9.9.9",
        },
      }),
    });
    assert.equal(tampered.status, 200);
    assert.equal(tampered.value.contentRegistry.url, deploymentUrl);
    assert.equal(tampered.value.contentRegistry.bundle, "brainstorm");
    assert.equal(tampered.value.contentRegistry.version, undefined);
    const stored = JSON.parse(
      readFileSync(join(workspace, "settings.json"), "utf8"),
    ) as { contentRegistry: { url: string; bundle: string } };
    assert.equal(stored.contentRegistry.url, deploymentUrl);
    assert.equal(stored.contentRegistry.bundle, "brainstorm");

    // An update that omits contentRegistry entirely (the webapp's shape) works.
    const omitted = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...tampered.value,
        contentRegistry: undefined,
      }),
    });
    assert.equal(omitted.status, 200);
    assert.equal(omitted.value.contentRegistry.url, deploymentUrl);

    // Health names the bundle and the version a new run starts with. No
    // DEPLOYMENT pin exists here, so the effective version is simply the
    // latest the registry advertises — which the double sets to this
    // repository's test pin, so both read the same version.
    const health = (
      await requestJson<{
        version: string;
        contentRegistry: {
          running: boolean;
          bundle?: string;
          effectiveVersion?: string;
          latest?: string;
          pinnedVersion?: string;
        };
      }>(server, "/api/health")
    ).value;
    assert.match(health.version, /^\d+\.\d+\.\d+$/);
    // The announced version must BE the app-root package.json version. It was
    // once a hand-bumped constant; the release that forgot the bump made a
    // successful update announce the old version, and the web app declared a
    // rollback that never happened.
    const appRootPackage = JSON.parse(
      readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
    ) as { name?: string; version?: string };
    assert.equal(appRootPackage.name, "brainstorm-agentic-app");
    assert.equal(health.version, appRootPackage.version);
    assert.equal(health.contentRegistry.bundle, "brainstorm");
    assert.equal(health.contentRegistry.latest, pinnedBundleVersion());
    assert.equal(health.contentRegistry.effectiveVersion, pinnedBundleVersion());
    assert.equal(health.contentRegistry.pinnedVersion, undefined);
    // Connected is a live verdict: the registry answered its probe and
    // served the bundle index during this health call, so running is true
    // WITH a resolved version — never one without the other.
    assert.equal(health.contentRegistry.running, true);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("a registry that disappears flips health to disconnected instead of a stale connection", async () => {
  const workspace = tempRoot();
  const registry = await startPinnedTestRegistry();
  const server = await startBrainServer({
    workspace,
    port: 0,
    contentRegistryUrl: registry.url,
    // The stale launch-time claim every probe must overrule.
    contentRegistryStatus: { running: true, url: registry.url },
    registryProbeTtlMs: 0,
  });
  try {
    const before = (
      await requestJson<{ contentRegistry: { running: boolean; effectiveVersion?: string } }>(
        server,
        "/api/health",
      )
    ).value;
    assert.equal(before.contentRegistry.running, true);
    assert.equal(before.contentRegistry.effectiveVersion, pinnedBundleVersion());

    await registry.close();
    const after = (
      await requestJson<{ contentRegistry: { running: boolean; effectiveVersion?: string } }>(
        server,
        "/api/health",
      )
    ).value;
    assert.equal(
      after.contentRegistry.running,
      false,
      "an unreachable registry must report disconnected, never the launch-time snapshot",
    );
    assert.equal(after.contentRegistry.effectiveVersion, undefined);

    // The readiness gate reads the same live verdict: the registry check
    // fails, so submissions are held rather than run against nothing.
    const readiness = (
      await requestJson<{ checks: Array<{ id: string; state: string }> }>(
        server,
        "/api/readiness",
      )
    ).value;
    const registryCheck = readiness.checks.find((check) => check.id === "registry");
    assert.equal(registryCheck?.state, "failed");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("Anthropic jobs are rejected before creation until settings are verified", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    const response = await requestJson<{ message: string }>(
      server,
      "/api/jobs",
      {
        method: "POST",
        body: JSON.stringify({ topic: "must not become orphaned" }),
      },
    );
    // 400 comes from the submit guard; 409 from the readiness gate once the
    // startup LLM check has recorded the missing credentials. Both carry the
    // same actionable message and neither creates a job.
    assert.ok(
      response.status === 400 || response.status === 409,
      `expected 400 or 409, got ${response.status}`,
    );
    assert.match(response.value.message, /Configure and verify/);
    const jobs = (
      await requestJson<readonly JobSummary[]>(server, "/api/jobs")
    ).value;
    assert.equal(jobs.length, 0);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("Anthropic settings are connection-tested, redacted, and transactional", async () => {
  const workspace = tempRoot();
  const attempts: Array<{ apiKey: string; model: string; baseUrl?: string }> = [];
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    validateAnthropic: async (input) => {
      attempts.push(input);
      if (input.apiKey === "bad-key") {
        throw new Error("authentication failed");
      }
    },
  });
  try {
    const initial = (
      await requestJson<ServerSettings>(server, "/api/settings")
    ).value;
    assert.equal(initial.llm.provider, "anthropic");
    assert.equal(initial.llm.model, "claude-sonnet-5");
    assert.equal(initial.llm.apiKeyConfigured, false);

    const saved = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...initial,
        llm: {
          provider: "anthropic",
          model: "claude-test-valid",
          baseUrl: "https://api.example.test",
          apiKey: "verified-secret",
        },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.value.llm.apiKeyConfigured, true);
    assert.equal(saved.value.llm.model, "claude-test-valid");
    assert.equal(
      JSON.stringify(saved.value).includes("verified-secret"),
      false,
    );
    assert.deepEqual(attempts[0], {
      apiKey: "verified-secret",
      model: "claude-test-valid",
      baseUrl: "https://api.example.test",
    });

    const settingsText = readFileSync(
      join(workspace, "settings.json"),
      "utf8",
    );
    assert.equal(settingsText.includes("verified-secret"), false);
    const credentialsPath = join(workspace, "credentials.json");
    assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);

    const rejected = await requestJson<{ message: string }>(
      server,
      "/api/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          ...saved.value,
          llm: {
            provider: "anthropic",
            model: "must-not-be-saved",
            apiKey: "bad-key",
          },
        } satisfies ServerSettingsUpdate),
      },
    );
    assert.equal(rejected.status, 400);
    assert.match(rejected.value.message, /authentication failed/);

    const after = (
      await requestJson<ServerSettings>(server, "/api/settings")
    ).value;
    assert.equal(after.llm.model, "claude-test-valid");
    assert.equal(after.llm.apiKeyConfigured, true);
    assert.match(readFileSync(credentialsPath, "utf8"), /verified-secret/);
    assert.equal(
      readFileSync(credentialsPath, "utf8").includes("bad-key"),
      false,
    );
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("Claude Agent SDK setup tokens are verified, redacted, and transactional", async () => {
  const workspace = tempRoot();
  const attempts: Array<{ token: string; model?: string }> = [];
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    validateClaudeAgent: async (input) => {
      attempts.push(input);
      if (input.token === "bad-setup-token") {
        throw new Error("setup token rejected");
      }
    },
  });
  try {
    const current = (
      await requestJson<ServerSettings>(server, "/api/settings")
    ).value;
    const saved = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...current,
        llm: {
          provider: "claude-agent",
          model: "sonnet",
          setupToken: "verified-setup-token",
        },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.value.llm.provider, "claude-agent");
    assert.equal(saved.value.llm.setupTokenConfigured, true);
    assert.equal(
      JSON.stringify(saved.value).includes("verified-setup-token"),
      false,
    );
    assert.deepEqual(attempts[0], {
      token: "verified-setup-token",
      model: "sonnet",
    });
    const credentialsPath = join(workspace, "credentials.json");
    assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(join(workspace, "settings.json"), "utf8").includes(
        "verified-setup-token",
      ),
      false,
    );

    const rejected = await requestJson<{ message: string }>(
      server,
      "/api/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          ...saved.value,
          llm: {
            provider: "claude-agent",
            model: "opus",
            setupToken: "bad-setup-token",
          },
        } satisfies ServerSettingsUpdate),
      },
    );
    assert.equal(rejected.status, 400);
    assert.match(rejected.value.message, /setup token rejected/);
    const after = (
      await requestJson<ServerSettings>(server, "/api/settings")
    ).value;
    assert.equal(after.llm.model, "sonnet");
    assert.equal(after.llm.setupTokenConfigured, true);
    const credentials = readFileSync(credentialsPath, "utf8");
    assert.match(credentials, /verified-setup-token/);
    assert.equal(credentials.includes("bad-setup-token"), false);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("verified settings populate orchestration environment without exposing the key", async () => {
  const workspace = tempRoot();
  try {
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => undefined,
      validateOpenRouter: async () => undefined,
    });
    await store.put({
      ...store.get(),
      llm: {
        provider: "anthropic",
        model: "claude-routed",
        baseUrl: "https://api.example.test",
        apiKey: "job-secret",
        modelsByRoute: { writing: "claude-writer" },
      },
      creditRecovery: {
        ...store.get().creditRecovery,
        openRouterApiKey: "parser-secret",
      },
    } satisfies ServerSettingsUpdate);
    const publicSettings = store.get();
    assert.equal(JSON.stringify(publicSettings).includes("job-secret"), false);
    const env = store.executionEnvironment({}, publicSettings);
    assert.equal(env.ANTHROPIC_API_KEY, "job-secret");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.example.test");
    assert.equal(env.BRAINSTORM_AGENTIC_MODEL, "claude-routed");
    assert.equal(
      env.BRAINSTORM_AGENTIC_MODEL_WRITING,
      "claude-writer",
    );
    // Credit-recovery parsing settings travel on the Messages-API path too:
    // the worker's CreditBlockDetectingAgentExecutor — which exists precisely
    // for this provider — needs them to turn a provider credit failure into a
    // schedulable credit_blocked checkpoint. They used to be emitted only for
    // claude-agent, leaving anthropic runs without the OpenRouter parse lane.
    assert.equal(env.BRAINSTORM_AGENTIC_CREDIT_SAFETY_BUFFER_SECONDS, "60");
    assert.equal(env.BRAINSTORM_AGENTIC_OPENROUTER_MODEL, "openrouter/free");
    assert.equal(env.OPENROUTER_API_KEY, "parser-secret");
  } finally {
    await removeWorkspace(workspace);
  }
});

test("GPU run settings validate the tag, persist across updates, and reach the worker environment", async () => {
  const workspace = tempRoot();
  try {
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => undefined,
    });
    // Off by default: empty template, sane ceiling, no env var emitted.
    assert.deepEqual(store.get().gpu, { template: "", timeLimitMinutes: 60 });

    const offlineLlm = { provider: "offline" as const, agentSdk: store.get().llm.agentSdk };
    // A non-empty template must carry the agent-command tag.
    await assert.rejects(
      store.put({
        ...store.get(),
        llm: offlineLlm,
        gpu: { template: "#!/bin/bash\ntrue\n", timeLimitMinutes: 30 },
      }),
      /AGENT_COMMAND/,
    );
    // The ceiling is bounded.
    await assert.rejects(
      store.put({
        ...store.get(),
        llm: offlineLlm,
        gpu: { template: "", timeLimitMinutes: 0 },
      }),
      /timeLimitMinutes/,
    );

    // A completed template persists and travels to the worker as one JSON var.
    const template = `#!/bin/bash\n#SBATCH --gres=gpu:1\n${GPU_COMMAND_TAG}\n`;
    await store.put({
      ...store.get(),
      llm: { provider: "anthropic", model: "claude-x", apiKey: "key" },
      gpu: { template, timeLimitMinutes: 90 },
    });
    assert.deepEqual(store.get().gpu, { template, timeLimitMinutes: 90 });
    const env = store.executionEnvironment({}, store.get());
    assert.deepEqual(JSON.parse(env.BRAINSTORM_AGENTIC_GPU_RUN!), {
      template,
      timeLimitMinutes: 90,
    });

    // An update that omits the GPU section keeps the stored setup.
    const { gpu: _omitted, ...withoutGpu } = store.get();
    await store.put({
      ...withoutGpu,
      llm: { provider: "anthropic", model: "claude-x" },
    });
    assert.deepEqual(store.get().gpu, { template, timeLimitMinutes: 90 });

    // Emptying the template switches GPU runs off; the env var disappears.
    await store.put({
      ...store.get(),
      llm: { provider: "anthropic", model: "claude-x" },
      gpu: { template: "", timeLimitMinutes: 90 },
    });
    const off = store.executionEnvironment({}, store.get());
    assert.equal(off.BRAINSTORM_AGENTIC_GPU_RUN, undefined);
  } finally {
    await removeWorkspace(workspace);
  }
});

test("OpenRouter parser credentials are verified and kept write-only", async () => {
  const workspace = tempRoot();
  const attempts: Array<{ apiKey: string; model: string }> = [];
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    validateOpenRouter: async (apiKey, model) => {
      attempts.push({ apiKey, model });
      if (apiKey === "bad-openrouter") throw new Error("OpenRouter rejected key");
    },
  });
  try {
    const current = (
      await requestJson<ServerSettings>(server, "/api/settings")
    ).value;
    const saved = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...current,
        llm: { provider: "offline", agentSdk: current.llm.agentSdk },
        creditRecovery: {
          ...current.creditRecovery,
          openRouterApiKey: "verified-openrouter",
        },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.value.creditRecovery.openRouterKeyConfigured, true);
    assert.equal(
      JSON.stringify(saved.value).includes("verified-openrouter"),
      false,
    );
    assert.deepEqual(attempts, [
      { apiKey: "verified-openrouter", model: "openrouter/free" },
    ]);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("a diagnostic preview describes exactly what would be sent, and excludes the submitter's work", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });
    const jobId = await submit(server, "A submission whose text must never be sent");
    await waitFor(server, jobId, "completed");

    const preview = (
      await requestJson<{
        components: Array<{ id: string; bytes: number; mayContainYourContent: boolean }>;
        totalBytes: number;
        excluded: string[];
        canSend: boolean;
      }>(server, `/api/jobs/${jobId}/diagnostics`)
    ).value;

    // The preview must name every component, so "send diagnostics" is an
    // informed decision rather than an implied one.
    assert.deepEqual(
      preview.components.map((component) => component.id).sort(),
      ["checkpoint", "events", "job"],
    );
    // ...and be honest about which parts can carry the submitter's material.
    const events = preview.components.find((component) => component.id === "events")!;
    assert.equal(events.mayContainYourContent, true, "the activity log names files and queries");
    const checkpoint = preview.components.find((component) => component.id === "checkpoint")!;
    assert.equal(checkpoint.mayContainYourContent, false, "only step names, never their results");
    assert.ok(preview.excluded.length > 0, "the preview names what is held back");
    assert.ok(preview.totalBytes > 0);

    // The ingest destination derives from the deployment's registry origin
    // at read time (never from what the settings file happens to carry), so
    // a healthy deployment can always send — the field-observed "no
    // destination" strandings came from stale stored settings and must not
    // recur. The unreachable-destination honesty lives on in the canSend
    // gate, covered by the legacy-settings derivation test.
    assert.equal(
      preview.canSend,
      true,
      "the destination derives from the deployment registry; a healthy deployment can always send",
    );
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("clearing a stored credential actually removes it", async () => {
  // Regression: the clear branch deleted the key, then the carry-forward branch
  // two lines later restored it from a value read BEFORE the delete — so a user
  // could never remove their OpenRouter key. No test covered the clear path; the
  // transactionality tests only covered setting and redaction.
  const workspace = tempRoot();
  try {
    const store = new SettingsStore(workspace, {
      validateOpenRouter: async () => undefined,
    });
    const base = store.get();
    await store.put({
      ...base,
      llm: { provider: "offline", agentSdk: base.llm.agentSdk },
      creditRecovery: { ...base.creditRecovery, openRouterApiKey: "secret-key" },
    });
    assert.equal(store.getOpenRouterApiKey(), "secret-key");

    const stored = store.get();
    await store.put({
      ...stored,
      llm: { provider: "offline", agentSdk: stored.llm.agentSdk },
      // The clear flag is nested under creditRecovery, alongside the key it clears.
      creditRecovery: { ...stored.creditRecovery, clearOpenRouterApiKey: true },
    });
    assert.equal(store.getOpenRouterApiKey(), undefined, "the cleared key must be gone");
    assert.equal(store.get().creditRecovery.openRouterKeyConfigured, false);
  } finally {
    await removeWorkspace(workspace);
  }
});

test("Claude Agent settings populate setup-token environment without leaking developer keys", async () => {
  const workspace = tempRoot();
  try {
    const store = new SettingsStore(workspace, {
      validateClaudeAgent: async () => undefined,
    });
    await store.put({
      ...store.get(),
      llm: {
        provider: "claude-agent",
        model: "sonnet",
        setupToken: "sdk-job-token",
        agentSdk: {
          maxTurns: 160,
          maxBudgetUsd: 9.5,
          effort: "xhigh",
          thinking: "disabled",
          fallbackModel: "haiku",
        },
      },
    } satisfies ServerSettingsUpdate);
    const publicSettings = store.get();
    assert.equal(publicSettings.llm.setupTokenConfigured, true);
    assert.equal(
      JSON.stringify(publicSettings).includes("sdk-job-token"),
      false,
    );
    const env = store.executionEnvironment(
      { ANTHROPIC_API_KEY: "inherited-must-be-removed" },
      publicSettings,
    );
    assert.equal(env.BRAINSTORM_AGENTIC_PROVIDER, "claude-agent");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sdk-job-token");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.BRAINSTORM_AGENTIC_MODEL, "sonnet");
    assert.equal(env.BRAINSTORM_AGENTIC_AGENT_MAX_TURNS, "160");
    assert.equal(env.BRAINSTORM_AGENTIC_AGENT_MAX_BUDGET_USD, "9.5");
    assert.equal(env.BRAINSTORM_AGENTIC_AGENT_EFFORT, "xhigh");
    assert.equal(env.BRAINSTORM_AGENTIC_AGENT_THINKING, "disabled");
    assert.equal(env.BRAINSTORM_AGENTIC_AGENT_FALLBACK_MODEL, "haiku");
  } finally {
    await removeWorkspace(workspace);
  }
});

test("outbound HTTP matches curl: proxy env honored, happy-eyeballs when direct", async () => {
  const { configureOutboundHttp } = await import("../src/proxy.js");
  const { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } =
    await import("undici");
  const before = getGlobalDispatcher();
  try {
    // Direct: a dual-stack host with unrouted IPv6 must not hang the first
    // connect — family auto-selection gives curl's fallback behavior.
    assert.equal(configureOutboundHttp({}), "direct (IPv4/IPv6 auto-selection)");
    assert.ok(getGlobalDispatcher() instanceof Agent);
    assert.ok(!(getGlobalDispatcher() instanceof EnvHttpProxyAgent));
    // Proxied: the environment proxy carries every in-process request.
    const url = "http://proxy.cluster.local:3128";
    assert.equal(configureOutboundHttp({ https_proxy: url }), `proxy ${url}`);
    assert.ok(getGlobalDispatcher() instanceof EnvHttpProxyAgent);
  } finally {
    setGlobalDispatcher(before);
  }
});

test("failed required readiness checks re-probe on their cooldown; passing checks stay untouched", async () => {
  const workspace = tempRoot();
  try {
    let clock = 1_000_000;
    let internetAttempts = 0;
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => undefined,
    });
    const readiness = new ReadinessService({
      workspace,
      settings: store,
      contentRegistry: { running: true },
      probes: defaultReadinessProbes({
        validateAnthropic: async () => undefined,
        validateClaudeAgent: async () => undefined,
        validateCursorAgent: async () => undefined,
      }),
      now: () => clock,
      probeOverrides: {
        internet: async () => {
          internetAttempts += 1;
          if (internetAttempts === 1) {
            throw new ReadinessProbeError("first attempt fails (transient)");
          }
          return { message: "outbound HTTPS works" };
        },
        llm: async () => ({ message: "stubbed" }),
        capabilities: async () => ({ message: "stubbed" }),
        code: async () => ({ message: "stubbed" }),
        slurm: async () => ({ message: "stubbed" }),
      },
    });
    try {
      readiness.refresh();
      const settled = async (): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const states = readiness
            .report()
            .checks.map((check) => check.state);
          if (!states.includes("checking")) return;
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
        }
      };
      await settled();
      const internet = () =>
        readiness.report().checks.find((check) => check.id === "internet")!;
      assert.equal(internet().state, "failed");

      // Within the cooldown nothing is due; past it, only the failed check.
      clock += 60_000;
      assert.deepEqual(readiness.autoRecheckDue(), []);
      clock += 5 * 60_000;
      assert.deepEqual(readiness.autoRecheckDue(), ["internet"]);

      readiness.refresh(readiness.autoRecheckDue());
      await settled();
      assert.equal(internet().state, "ok");
      assert.equal(internetAttempts, 2);
      assert.deepEqual(readiness.autoRecheckDue(), []);
    } finally {
      readiness.close();
    }
  } finally {
    await removeWorkspace(workspace);
  }
});

test("the SLURM readiness check validates the pilot pool on pilot deployments", async () => {
  // The server runs AS a SLURM job there — sbatch is denied on its node, so
  // an sbatch probe would stay red forever and the readiness gate would
  // block every submission. The honest check is the pool: held, claimable
  // pilots in the queue.
  const workspace = tempRoot();
  try {
    const bin = join(workspace, "bin");
    const pool = join(workspace, "pool");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(pool, "available"), { recursive: true });
    writeFileSync(join(pool, "available", "111"), "serial");
    writeFileSync(join(pool, "available", "222"), "serial");
    // 111 is genuinely held; 222 already runs a claim — only 111 counts.
    writeFileSync(
      join(bin, "squeue"),
      "#!/usr/bin/env bash\nprintf 'CLUSTER: serial\\n111 PENDING\\n222 RUNNING\\n'\n",
    );
    chmodSync(join(bin, "squeue"), 0o755);

    const probes = defaultReadinessProbes({
      validateAnthropic: async () => undefined,
      validateClaudeAgent: async () => undefined,
      validateCursorAgent: async () => undefined,
      pilotPoolDir: pool,
    });
    const base = defaultServerSettings();
    const context: ReadinessProbeContext = {
      settings: { ...base, runner: "slurm" },
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      workspace,
      signal: new AbortController().signal,
      credentials: {},
      onProgress: () => undefined,
    };
    const ready = await probes.slurm(context);
    assert.match(ready.message ?? "", /1 held pilot/);
    assert.match(ready.message ?? "", /pilot channel ready/);

    // An empty pool fails with the exact top-up instruction.
    rmSync(join(pool, "available", "111"));
    rmSync(join(pool, "available", "222"));
    await assert.rejects(probes.slurm(context), /lrz-queue-runway/);
  } finally {
    await removeWorkspace(workspace);
  }
});

test("llm and internet probes retry once, so a launch-time flicker never paints the dashboard red", async () => {
  // A freshly started host loses its first attempts to cold caches: the
  // first outbound connection overruns the fetch timeout, the Claude CLI's
  // first spawn reads cold shared storage. Those must not surface as hard
  // failures (which sit red for the whole 5-30 minute recheck cooldown) —
  // the probes carry the registry probe's one-immediate-retry doctrine.
  let anthropicCalls = 0;
  let claudeCalls = 0;
  let cursorCalls = 0;
  let fetchCalls = 0;
  const probes = defaultReadinessProbes({
    validateAnthropic: async () => {
      anthropicCalls += 1;
      if (anthropicCalls === 1) throw new Error("first connect overran its timeout");
    },
    validateClaudeAgent: async () => {
      claudeCalls += 1;
      if (claudeCalls === 1) throw new Error("cold first spawn overran its timeout");
    },
    validateCursorAgent: async () => {
      cursorCalls += 1;
      if (cursorCalls === 1) throw new Error("cold first runtime spawn overran its timeout");
    },
    fetchImpl: (async () => {
      fetchCalls += 1;
      if (fetchCalls % 2 === 1) throw new Error("connect timed out");
      return new Response("ok");
    }) as typeof fetch,
  });
  const base = defaultServerSettings();
  const context = (
    llm: ServerSettings["llm"],
    credentials: ReadinessProbeContext["credentials"],
  ): ReadinessProbeContext => ({
    settings: { ...base, llm },
    env: {},
    workspace: "/nonexistent-not-touched",
    signal: new AbortController().signal,
    credentials,
    onProgress: () => undefined,
  });

  // Anthropic path: the first validation failure is retried, not surfaced.
  const anthropic = await probes.llm(
    context(
      { ...base.llm, provider: "anthropic", model: "claude-test" },
      { anthropicApiKey: "key" },
    ),
  );
  assert.equal(anthropicCalls, 2);
  assert.match(anthropic.message ?? "", /Anthropic API responds/);

  // Claude Agent path: same doctrine.
  const claude = await probes.llm(
    context(
      { ...base.llm, provider: "claude-agent" },
      { claudeSetupToken: "token" },
    ),
  );
  assert.equal(claudeCalls, 2);
  assert.match(claude.message ?? "", /Claude Agent SDK responds/);

  // Cursor SDK path: same doctrine.
  const cursor = await probes.llm(
    context(
      { ...base.llm, provider: "cursor-agent" },
      { cursorApiKey: "cursor-key" },
    ),
  );
  assert.equal(cursorCalls, 2);
  assert.match(cursor.message ?? "", /Cursor SDK responds/);

  // Internet: first fetch dies, the immediate retry lands.
  const internet = await probes.internet(
    context({ ...base.llm, provider: "anthropic", model: "m" }, {}),
  );
  assert.equal(fetchCalls, 2);
  assert.equal(internet.message, "outbound HTTPS works");

  // Missing configuration is a real failure: no validator call, no retry.
  await assert.rejects(
    probes.llm(context({ ...base.llm, provider: "anthropic", model: undefined }, {})),
    /Configure and verify the Anthropic API key/,
  );
  assert.equal(anthropicCalls, 2);

  // A genuinely dead connection still fails — after both attempts errored.
  const failing = defaultReadinessProbes({
    validateAnthropic: async () => undefined,
    validateClaudeAgent: async () => undefined,
    validateCursorAgent: async () => undefined,
    fetchImpl: (async () => {
      fetchCalls += 1;
      throw new Error("network unreachable");
    }) as typeof fetch,
  });
  await assert.rejects(
    failing.internet(context({ ...base.llm, provider: "anthropic", model: "m" }, {})),
    /no outbound HTTPS/,
  );
  assert.equal(fetchCalls, 4);
});

test("the updater script checks out the tag, rebuilds, relaunches, and can roll back", () => {
  const script = buildUpdaterScript({
    repoRoot: "/opt/brain app",
    targetVersion: "0.9.0",
    relaunch: {
      command: "/usr/local/bin/node",
      args: ["dist/apps/server/src/main.js", "launch", "--port", "8787"],
      cwd: "/opt/brain app",
    },
    pid: 4242,
  });
  assert.ok(script.includes("kill -0 4242"), "waits for the server to exit");
  assert.ok(script.includes("git fetch --tags"), "fetches release tags");
  assert.ok(script.includes("'app/v0.9.0'"), "checks out the release tag");
  assert.ok(script.includes("npm ci --no-audit --no-fund"), "reinstalls");
  assert.ok(script.includes("npm run build"), "rebuilds");
  assert.ok(
    script.includes(
      "nohup '/usr/local/bin/node' 'dist/apps/server/src/main.js' 'launch' '--port' '8787'",
    ),
    "relaunches with the exact original command line",
  );
  assert.ok(script.includes("cd '/opt/brain app'"), "quotes the repo path");
  assert.ok(script.includes("rollback()"), "carries the rollback path");
  assert.ok(
    script.includes("stash push"),
    "local modifications are set aside recoverably, never a failure",
  );
  // The script must PARSE: an updater that dies on a syntax error after the
  // server exited leaves no app running at all. bash -n is the same gate
  // applyAppUpdate runs before letting the server exit.
  const scriptPath = join(tempRoot(), "updater.sh");
  writeFileSync(scriptPath, script);
  execFileSync("bash", ["-n", scriptPath]);
});

test("under SLURM the updater stashes, checks out the release, and hands rebuild/relaunch to the wrapper", () => {
  const root = tempRoot();
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@local", ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  writeFileSync(join(repo, "f.txt"), "one\n");
  git("add", "f.txt");
  git("commit", "--quiet", "-m", "one");
  const oldRev = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "f.txt"), "two\n");
  git("commit", "--quiet", "-am", "two");
  git("tag", "-a", "app/v9.9.9", "-m", "release");
  git("checkout", "--quiet", oldRev);
  // A bootstrap-style local modification that must survive, not block.
  writeFileSync(join(repo, "f.txt"), "local dirt\n");

  // A pid that is already dead, so the wait loop returns immediately.
  const dead = execFileSync("bash", ["-c", "true & echo $!"], { encoding: "utf8" }).trim();
  const relaunchMarker = join(root, "relaunched");
  const script = buildUpdaterScript({
    repoRoot: repo,
    targetVersion: "9.9.9",
    relaunch: { command: "touch", args: [relaunchMarker], cwd: root },
    pid: Number(dead),
  });
  const scriptPath = join(root, "updater.sh");
  writeFileSync(scriptPath, script);
  const log = execFileSync("bash", [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, SLURM_JOB_ID: "12345" },
  });

  assert.equal(
    git("rev-parse", "HEAD"),
    git("rev-parse", "app/v9.9.9^{commit}"),
    "the release tag is checked out",
  );
  assert.ok(
    git("stash", "list").includes("brainstorm self-update"),
    "the local modification is preserved in the stash",
  );
  assert.ok(log.includes("handing rebuild and relaunch to the launch wrapper"));
  assert.equal(
    existsSync(relaunchMarker),
    false,
    "the updater must NOT relaunch inside a SLURM allocation",
  );
});

/** A throwaway git repo with an app/v9.9.9 release ahead of HEAD. */
function updateFixtureRepo(root: string): {
  repo: string;
  git: (...args: string[]) => string;
  previousRev: string;
} {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@local", ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  writeFileSync(join(repo, "f.txt"), "one\n");
  git("add", "f.txt");
  git("commit", "--quiet", "-m", "one");
  const previousRev = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "f.txt"), "two\n");
  git("commit", "--quiet", "-am", "two");
  git("tag", "-a", "app/v9.9.9", "-m", "release");
  git("checkout", "--quiet", previousRev);
  return { repo, git, previousRev };
}

test("under SLURM the update applies the checkout IN-PROCESS, before the server exits", async () => {
  // The production incident this pins down: a detached updater dies with
  // the SLURM job's cgroup the moment the server exits — its log ended at
  // "waiting for the server to exit" and no update ever landed. The SLURM
  // path must therefore finish the checkout while the server still runs.
  const root = tempRoot();
  const { repo, git } = updateFixtureRepo(root);
  // A bootstrap-style local modification that must survive, not block.
  writeFileSync(join(repo, "f.txt"), "local dirt\n");

  const started = await applyAppUpdate({
    targetVersion: "9.9.9",
    stateDir: join(root, "self-update"),
    relaunch: { command: "node", args: ["main.js"], cwd: repo },
    env: { SLURM_JOB_ID: "12345" },
    repoRoot: repo,
  });

  assert.equal(
    git("rev-parse", "HEAD"),
    git("rev-parse", "app/v9.9.9^{commit}"),
    "the release tag is checked out synchronously",
  );
  assert.ok(
    git("stash", "list").includes("brainstorm self-update"),
    "the local modification is preserved in the stash",
  );
  assert.equal(started.scriptFile, undefined, "no detached updater exists to die");
  const log = readFileSync(started.logFile, "utf8");
  assert.ok(log.includes("applying the checkout in-process"));
  assert.ok(log.includes("checked out — the launch wrapper rebuilds"));
});

test("a SLURM update whose tag is missing restores the checkout and throws", async () => {
  const root = tempRoot();
  const { repo, git, previousRev } = updateFixtureRepo(root);

  await assert.rejects(
    applyAppUpdate({
      targetVersion: "8.8.8",
      stateDir: join(root, "self-update"),
      relaunch: { command: "node", args: ["main.js"], cwd: repo },
      env: { SLURM_JOB_ID: "12345" },
      repoRoot: repo,
    }),
    /tag app\/v8\.8\.8 not found/,
  );
  assert.equal(
    git("rev-parse", "HEAD"),
    previousRev,
    "the previous checkout still stands — the server keeps running on it",
  );
});

test("POST /api/update-check re-probes on demand and throttles rapid retriggers", async () => {
  const workspace = tempRoot();
  let probes = 0;
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    selfUpdateCheck: true,
    appUpdateThrottleMs: 1_500,
    appUpdateProbe: async () => {
      probes += 1;
      // The release appears only after startup's initial check.
      return probes >= 2 ? { version: "9.9.9", notes: "fresh" } : undefined;
    },
    applyAppUpdate: async () => {
      throw new Error("must not be called");
    },
    exitForUpdate: () => {
      throw new Error("must not exit");
    },
  });
  try {
    // Startup check ran once and found nothing.
    const deadline = Date.now() + 5_000;
    while (probes < 1 && Date.now() < deadline) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
    }
    // Let the startup check's throttle window elapse — a check that JUST ran
    // is legitimately fresh and on-demand triggers reuse it by design.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_600));
    const before = await requestJson<{ appUpdate?: unknown }>(
      server,
      "/api/health",
    );
    assert.equal(before.value.appUpdate, undefined);

    // Opening the dashboard re-probes NOW and surfaces the new release.
    const checked = await requestJson<{
      version: string;
      selfUpdateEnabled: boolean;
      appUpdate?: { version: string };
    }>(server, "/api/update-check", { method: "POST", body: "{}" });
    assert.equal(checked.status, 200);
    assert.equal(checked.value.selfUpdateEnabled, true);
    assert.equal(checked.value.appUpdate?.version, "9.9.9");
    assert.equal(probes, 2);

    // A second tab arriving right after reuses the fresh result.
    const again = await requestJson<{ appUpdate?: { version: string } }>(
      server,
      "/api/update-check",
      { method: "POST", body: "{}" },
    );
    assert.equal(again.value.appUpdate?.version, "9.9.9");
    assert.equal(probes, 2, "throttled: no extra probe within the window");

    // And the regular health payload now carries it too.
    const after = await requestJson<{ appUpdate?: { version: string } }>(
      server,
      "/api/health",
    );
    assert.equal(after.value.appUpdate?.version, "9.9.9");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("with self-update disabled, update-check says NOTHING WAS CHECKED instead of claiming the latest version", async () => {
  // The Azure incident this pins down: a --no-self-update systemd host three
  // releases behind answered the "check for updates" button with "you are on
  // the latest version". The response must carry selfUpdateEnabled: false so
  // the UI can say checking is off — and no probe may run at all.
  const workspace = tempRoot();
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    // selfUpdateCheck deliberately absent (the --no-self-update launch).
    appUpdateProbe: async () => {
      throw new Error("a disabled deployment must never probe release tags");
    },
  });
  try {
    const checked = await requestJson<{
      version: string;
      selfUpdateEnabled: boolean;
      appUpdate?: unknown;
    }>(server, "/api/update-check", { method: "POST", body: "{}" });
    assert.equal(checked.status, 200);
    assert.equal(checked.value.selfUpdateEnabled, false);
    assert.equal(checked.value.appUpdate, undefined);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("model options serve the account's LIVE Cursor catalog when cursor-agent is selected", async () => {
  // Cursor serves many vendors' models per account (every Sonnet/Opus
  // version, GPT, Composer, …); a hardcoded excerpt is what left the picker
  // with a single Sonnet and no versions. The live list is fetched with the
  // configured key and mapped to id + display label.
  const workspace = tempRoot();
  let listedWith: string | undefined;
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    validateCursorAgent: async () => undefined,
    listCursorModels: async (apiKey) => {
      listedWith = apiKey;
      return [
        { id: "default", displayName: "Auto" },
        { id: "claude-sonnet-5", displayName: "Sonnet 5" },
        { id: "claude-sonnet-4-5", displayName: "Sonnet 4.5" },
        { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
      ];
    },
  });
  try {
    const current = await requestJson<{ llm: Record<string, unknown> }>(
      server,
      "/api/settings",
    );
    const put = await requestJson(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...current.value,
        llm: {
          provider: "cursor-agent",
          cursorApiKey: "cursor-test-key",
        },
      }),
    });
    assert.equal(put.status, 200);
    const options = await requestJson<{
      provider: string;
      models: readonly { id: string; label: string }[];
    }>(server, "/api/model-options");
    assert.equal(options.value.provider, "cursor-agent");
    assert.equal(listedWith, "cursor-test-key");
    assert.deepEqual(
      options.value.models.map((model) => model.id),
      ["default", "claude-sonnet-5", "claude-sonnet-4-5", "gpt-5.6-sol"],
    );
    assert.equal(options.value.models[1]!.label, "Sonnet 5");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("under systemd the update applies the checkout IN-PROCESS, before the server exits", async () => {
  // The systemd twin of the SLURM path: the unit's cgroup kills a detached
  // updater the moment the server exits, and Restart=on-failure never
  // restarts a clean exit — so the checkout must land while the server
  // still runs; the unit (Restart=always + the deploy/systemd wrapper)
  // owns rebuild and relaunch.
  const root = tempRoot();
  const { repo, git } = updateFixtureRepo(root);
  writeFileSync(join(repo, "f.txt"), "local dirt\n");

  const started = await applyAppUpdate({
    targetVersion: "9.9.9",
    stateDir: join(root, "self-update"),
    relaunch: { command: "node", args: ["main.js"], cwd: repo },
    env: { INVOCATION_ID: "0123abcd" },
    repoRoot: repo,
  });

  assert.equal(
    git("rev-parse", "HEAD"),
    git("rev-parse", "app/v9.9.9^{commit}"),
    "the release tag is checked out synchronously",
  );
  assert.ok(
    git("stash", "list").includes("brainstorm self-update"),
    "the local modification is preserved in the stash",
  );
  assert.equal(started.scriptFile, undefined, "no detached updater exists to die");
  const log = readFileSync(started.logFile, "utf8");
  assert.ok(log.includes("systemd unit (invocation 0123abcd)"));
  assert.ok(log.includes("applying the checkout in-process"));
  assert.ok(log.includes("checked out — the service unit rebuilds"));
});

test("POST /api/update hands over to the updater; without a known release it refuses", async () => {
  const workspace = tempRoot();
  const applied: ApplyAppUpdateOptions[] = [];
  let exits = 0;
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    selfUpdateCheck: true,
    appUpdateProbe: async () => ({ version: "9.9.9", notes: "test release" }),
    applyAppUpdate: async (options) => {
      applied.push(options);
      return {
        logFile: join(workspace, "self-update", "update-test.log"),
        scriptFile: join(workspace, "self-update", "update-test.sh"),
      };
    },
    exitForUpdate: () => {
      exits += 1;
    },
  });
  try {
    // The probe result lands asynchronously right after startup.
    const deadline = Date.now() + 5_000;
    let health: { appUpdate?: { version: string } } = {};
    while (Date.now() < deadline) {
      health = (
        await requestJson<{ appUpdate?: { version: string } }>(
          server,
          "/api/health",
        )
      ).value;
      if (health.appUpdate) break;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    }
    assert.equal(health.appUpdate?.version, "9.9.9");

    const response = await requestJson<{
      updatingTo: string;
      logFile: string;
    }>(server, "/api/update", { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(response.value.updatingTo, "9.9.9");
    assert.ok(response.value.logFile.endsWith("update-test.log"));
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.targetVersion, "9.9.9");
    assert.equal(applied[0]!.stateDir, join(workspace, "self-update"));
    assert.ok(applied[0]!.relaunch.args.length > 0);
    // The handover fires shortly after the response has flushed.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 700));
    assert.equal(exits, 1);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }

  // A server with no known newer release refuses rather than guessing.
  const quietWorkspace = tempRoot();
  const quiet = await startTestBrainServer({
    workspace: quietWorkspace,
    port: 0,
    selfUpdateCheck: true,
    appUpdateProbe: async () => undefined,
    applyAppUpdate: async () => {
      throw new Error("must not be called");
    },
    exitForUpdate: () => {
      throw new Error("must not exit");
    },
  });
  try {
    const refused = await requestJson<{ message?: string }>(
      quiet,
      "/api/update",
      { method: "POST", body: "{}" },
    );
    assert.equal(refused.status, 409);
  } finally {
    await quiet.close();
    await removeWorkspace(quietWorkspace);
  }
});

test("retrying a run pinned to a retired skills version refuses at the button with the reason", async () => {
  // The field failure: retry submitted a doomed worker that died at content
  // validation minutes later, visible only in raw logs. The refusal must
  // happen at the click, naming the pin and the way forward.
  const workspace = tempRoot();
  try {
    const jobId = "bsa_test_retired_pin";
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    mkdirSync(join(jobDir, "content"), { recursive: true });
    mkdirSync(join(workspace, "workspace", "sessions", jobId), { recursive: true });
    writeFileSync(
      join(jobDir, "job.json"),
      JSON.stringify({
        jobId,
        topic: "an old run pinned to retired skills",
        status: "failed",
        runner: "local",
        createdAt: 1,
        updatedAt: 1,
        submissionCount: 1,
      }),
    );
    writeFileSync(
      join(jobDir, "content", "content-pin.json"),
      JSON.stringify({ bundle: "brainstorm", version: "0.14.0", registryUrl: "https://registry.test" }),
    );
    writeFileSync(
      join(workspace, "workspace", "sessions", jobId, "checkpoint.json"),
      JSON.stringify({ status: "failed", workflowId: "brainstorm" }),
    );
    const manager = new JobManager({ workspace });
    await assert.rejects(
      manager.retryFailed(jobId),
      /pinned to skills v0\.14\.0.*no longer executes.*new run/,
    );
  } finally {
    await removeWorkspace(workspace);
  }
});

test("a legacy settings file without telemetry still derives the diagnostics destination", async () => {
  const workspace = tempRoot();
  try {
    // Exactly the stranded state seen in the field: settings persisted
    // before telemetry existed (or a partial update dropped it) — the
    // diagnostics destination must derive from the deployment's registry
    // origin at read time, never from what the file happens to carry.
    writeFileSync(
      join(workspace, "settings.json"),
      JSON.stringify({
        slurmTemplate: DEFAULT_SLURM_TEMPLATE,
        runner: "local",
        panelConfirmation: "manual",
        llm: { provider: "offline" },
      }),
    );
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => undefined,
    });
    const settings = store.get();
    assert.equal(settings.telemetry?.enabled, true);
    const origin = new URL(settings.contentRegistry.url);
    assert.equal(
      settings.telemetry?.ingestUrl,
      `${origin.protocol}//${origin.host}`,
    );
  } finally {
    await removeWorkspace(workspace);
  }
});

test("per-run capability disables reach the execution environment for every provider", async () => {
  const workspace = tempRoot();
  try {
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => undefined,
    });
    const settings = {
      ...store.get(),
      capabilityOverrides: { "web-search": false, "code-execution": true },
    };
    // The offline provider early-returns before most env assembly; the
    // capability disables must be emitted regardless.
    const offlineEnv = store.executionEnvironment(
      {},
      { ...settings, llm: { provider: "offline" } },
    );
    assert.equal(
      offlineEnv.BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES,
      "web-search",
    );
    const untouched = store.executionEnvironment(
      {},
      { ...store.get(), llm: { provider: "offline" } },
    );
    assert.equal(
      untouched.BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES,
      undefined,
    );
  } finally {
    await removeWorkspace(workspace);
  }
});

test("submitted capability overrides are snapshotted, validated, and enumerable", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });
    // Malformed maps are rejected before any job is created.
    const malformed = await requestJson<{ message?: string }>(
      server,
      "/api/jobs",
      {
        method: "POST",
        body: JSON.stringify({
          topic: "Reject bad overrides",
          capabilityOverrides: { "web-search": "off" },
        }),
      },
    );
    assert.equal(malformed.status, 400);

    const jobId = await submit(
      server,
      "Run without web search",
      undefined,
      // taxonomy-access is locked infrastructure: the override is dropped.
      { "web-search": false, "taxonomy-access": false },
    );
    const stored = JSON.parse(
      readFileSync(
        join(workspace, "workspace", "jobs", jobId, "job.json"),
        "utf8",
      ),
    ) as {
      executionSettings?: { capabilityOverrides?: Record<string, boolean> };
    };
    assert.deepEqual(stored.executionSettings?.capabilityOverrides, {
      "web-search": false,
    });

    // The composer's toggle list: capability catalog with lock flags.
    const options = await requestJson<{
      capabilities: readonly {
        id: string;
        locked: boolean;
        operations: readonly string[];
      }[];
    }>(server, "/api/capabilities");
    assert.equal(options.status, 200);
    const byId = new Map(
      options.value.capabilities.map((entry) => [entry.id, entry]),
    );
    assert.ok(byId.size >= 4);
    assert.equal(byId.get("taxonomy-access")?.locked, true);
    assert.equal(byId.get("web-search")?.locked, false);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("template rendering replaces one tag and preserves shell-quoted topics", () => {
  const topic = "quote ' and backslash \\\\ and\nnewline";
  const settings = { ...defaultServerSettings(), llm: { provider: "offline" as const } };
  const command = buildOrchestrationCommand({
    workerPath: "/tmp/worker path/main.js",
    mode: "run",
    runId: "bsa_test",
    topic,
    sessionRoot: "/tmp/session root",
    eventsFile: "/tmp/job/events.jsonl",
    contentDir: "/tmp/job/content",
    settings,
  });
  const rendered = renderSlurmTemplate(
    `before\n${SLURM_COMMAND_TAG}\nafter\n`,
    command,
  );
  assert.equal(rendered.includes(SLURM_COMMAND_TAG), false);
  assert.ok(rendered.includes(shellQuote(topic)));
  assert.equal(rendered.split(command).length - 1, 1);
});

test("a review-round override rides the command as its own env variable", () => {
  const base = { ...defaultServerSettings(), llm: { provider: "offline" as const } };
  const fixture = {
    workerPath: "/tmp/worker/main.js",
    mode: "run" as const,
    runId: "bsa_rounds",
    topic: "Review budget",
    sessionRoot: "/tmp/sessions",
    eventsFile: "/tmp/events.jsonl",
    contentDir: "/tmp/content",
  };
  const overridden = buildOrchestrationCommand({
    ...fixture,
    settings: { ...base, review: { maxRounds: 6 } },
  });
  assert.match(overridden, /BRAINSTORM_AGENTIC_MAX_REVIEW_ROUNDS='6'/);
  const unset = buildOrchestrationCommand({ ...fixture, settings: base });
  assert.equal(unset.includes("BRAINSTORM_AGENTIC_MAX_REVIEW_ROUNDS"), false);
});

test("the attachment store rides every submission for the job, resumes included", () => {
  // A judge mid-review reported it "could not open the real project files
  // myself". The manifest names the ROOT the attachment tools read through, and
  // it was emitted only for `run`: with no roots the worker deletes the
  // attachment tools and the broker truthfully resolves attachment-access
  // unavailable. Since a run suspends at its first human gate and continues as a
  // resume, that silenced the files for the code annotator, every panel member,
  // and every commentor, judge and reviser of the review.
  const base = { ...defaultServerSettings(), llm: { provider: "offline" as const } };
  const fixture = {
    workerPath: "/tmp/worker/main.js",
    runId: "bsa_attachments",
    sessionRoot: "/tmp/sessions",
    eventsFile: "/tmp/events.jsonl",
    contentDir: "/tmp/content",
    attachmentsManifest: "/tmp/jobs/bsa_attachments/attachments/manifest.json",
    settings: base,
  };
  const run = buildOrchestrationCommand({ ...fixture, mode: "run", topic: "Read my files" });
  const resume = buildOrchestrationCommand({ ...fixture, mode: "resume" });
  for (const [label, command] of [["run", run], ["resume", resume]] as const) {
    assert.match(
      command,
      /--attachments-manifest '\/tmp\/jobs\/bsa_attachments\/attachments\/manifest\.json'/,
      `the ${label} command must name the job's attachment store`,
    );
  }
  // The topic, by contrast, IS run-only: a resume replays it from the checkpoint.
  assert.match(run, /--topic 'Read my files'/);
  assert.equal(resume.includes("--topic"), false);
  // A job with nothing attached names no store, so the broker reports the files
  // as unavailable rather than pointing the tools at a directory that is absent.
  const without = buildOrchestrationCommand({
    ...fixture,
    mode: "resume",
    attachmentsManifest: undefined,
  });
  assert.equal(without.includes("--attachments-manifest"), false);
});

test("--auto-approve rides the command only when the gate countdown is switched on", () => {
  const fixture = {
    workerPath: "/tmp/worker/main.js",
    mode: "run" as const,
    runId: "bsa_gate_switch",
    topic: "Run this unattended",
    sessionRoot: "/tmp/sessions",
    eventsFile: "/tmp/events.jsonl",
    contentDir: "/tmp/content",
  };
  const auto: ServerSettings = {
    ...defaultServerSettings(),
    panelConfirmation: "auto",
    llm: { provider: "offline" },
  };
  const flag = (settings: ServerSettings): boolean =>
    buildOrchestrationCommand({ ...fixture, settings }).includes("--auto-approve");
  assert.equal(flag(auto), true);
  // Workspaces created before the switch existed store no value for it, and
  // absent has to keep meaning "on" — otherwise upgrading would silently start
  // parking every unattended run at a gate nobody is watching.
  const { gateAutoApprove: _absent, ...withoutSwitch } = auto;
  assert.equal(flag(withoutSwitch), true);
  // With the countdown switched off the flag must be withheld here, because
  // "auto" compiles the gates out of the worker altogether: a run launched with
  // the flag has no gate left for a human to answer, so nothing downstream
  // could honour the switch afterwards.
  assert.equal(flag({ ...auto, gateAutoApprove: false }), false);
  // A manual panel keeps its gates regardless, so the flag stays off whichever
  // way the countdown switch is set.
  assert.equal(flag({ ...auto, panelConfirmation: "manual" }), false);
  assert.equal(
    flag({ ...auto, panelConfirmation: "manual", gateAutoApprove: false }),
    false,
  );
});

test("Claude Agent command selects its executor without embedding the setup token", () => {
  const settings: ServerSettings = {
    ...defaultServerSettings(),
    llm: {
      provider: "claude-agent",
      model: "sonnet",
      setupTokenConfigured: true,
    },
  };
  const command = buildOrchestrationCommand({
    workerPath: "/tmp/worker/main.js",
    mode: "run",
    runId: "bsa_agent_sdk",
    topic: "Use Agent SDK",
    sessionRoot: "/tmp/sessions",
    eventsFile: "/tmp/events.jsonl",
    contentDir: "/tmp/content",
    settings,
  });
  assert.match(command, /BRAINSTORM_AGENTIC_PROVIDER='claude-agent'/);
  assert.match(command, /BRAINSTORM_AGENTIC_MODEL='sonnet'/);
  assert.equal(command.includes("CLAUDE_CODE_OAUTH_TOKEN="), false);
});

test("fake sbatch submission records id and cancellation calls scancel", async () => {
  const workspace = tempRoot();
  const bin = join(workspace, "bin");
  mkdirSync(bin);
  const cancelRecord = join(workspace, "scancel.txt");
  const sbatch = join(bin, "sbatch");
  const scancel = join(bin, "scancel");
  // Multi-cluster SLURM (LRZ shape): sbatch names the landing cluster, and
  // later scheduler commands must carry -M for the job to be visible.
  writeFileSync(
    sbatch,
    "#!/usr/bin/env bash\necho 'Submitted batch job 123 on cluster serial'\n",
  );
  writeFileSync(
    scancel,
    "#!/usr/bin/env bash\nprintf '%s' \"$*\" > \"$SCANCEL_RECORD\"\n",
  );
  chmodSync(sbatch, 0o755);
  chmodSync(scancel, 0o755);
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SCANCEL_RECORD: cancelRecord,
    },
    // The stub sbatch cannot run the probe job; pin the check green so the
    // submission gate never interferes with what this test exercises.
    readinessProbes: { slurm: async () => ({ message: "stubbed" }) },
    readinessAdvisor: null,
  });
  try {
    await putSettings(server, { llm: { provider: "offline" } });
    const jobId = await submit(server, "Submit through fake Slurm");
    const stored = JSON.parse(
      readFileSync(join(workspace, "workspace", "jobs", jobId, "job.json"), "utf8"),
    ) as { slurmJobId?: string; slurmCluster?: string };
    assert.equal(stored.slurmJobId, "123");
    assert.equal(stored.slurmCluster, "serial");
    const cancelled = await requestJson<{ status: string }>(
      server,
      `/api/jobs/${jobId}/cancel`,
      { method: "POST", body: "{}" },
    );
    assert.equal(cancelled.value.status, "cancelled");
    assert.equal(readFileSync(cancelRecord, "utf8"), "-M serial 123");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("the pilot channel claims a held job, releases it, and never calls sbatch", async () => {
  // Server-as-a-SLURM-job deployments (LRZ): sbatch is denied at runtime,
  // so submission = claim a pre-queued held pilot + scontrol release.
  const workspace = tempRoot();
  const bin = join(workspace, "bin");
  const pool = join(workspace, "pilot-pool");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(pool, "available"), { recursive: true });
  writeFileSync(join(pool, "available", "4242"), "serial");
  const scontrolRecord = join(workspace, "scontrol.txt");
  const scancelRecord = join(workspace, "scancel.txt");
  writeFileSync(
    join(bin, "scontrol"),
    "#!/usr/bin/env bash\nprintf '%s' \"$*\" > \"$SCONTROL_RECORD\"\n",
  );
  writeFileSync(
    join(bin, "scancel"),
    "#!/usr/bin/env bash\nprintf '%s' \"$*\" > \"$SCANCEL_RECORD\"\n",
  );
  // No sbatch on PATH at all: a pilot submission must never need it.
  chmodSync(join(bin, "scontrol"), 0o755);
  chmodSync(join(bin, "scancel"), 0o755);
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    pilotPoolDir: pool,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SCONTROL_RECORD: scontrolRecord,
      SCANCEL_RECORD: scancelRecord,
    },
    readinessProbes: { slurm: async () => ({ message: "stubbed" }) },
    readinessAdvisor: null,
  });
  try {
    await putSettings(server, { llm: { provider: "offline" } });
    // Submitted with a capability switched off for this run: that policy travels
    // to the worker as an environment variable, so it is the sharpest probe of
    // whether the pilot assignment carries the environment at all.
    const jobId = await submit(server, "Ride a held pilot", undefined, {
      "web-search": false,
    });

    const stored = JSON.parse(
      readFileSync(join(workspace, "workspace", "jobs", jobId, "job.json"), "utf8"),
    ) as { slurmJobId?: string; slurmCluster?: string };
    assert.equal(stored.slurmJobId, "4242");
    assert.equal(stored.slurmCluster, "serial");
    assert.equal(
      readFileSync(scontrolRecord, "utf8"),
      "-M serial release 4242",
      "the release carries the pilot's landing cluster",
    );
    // The claim moved the marker and spooled the assignment.
    assert.equal(existsSync(join(pool, "available", "4242")), false);
    assert.equal(existsSync(join(pool, "claimed", "4242")), true);
    const assignment = readFileSync(join(pool, "spool", "4242.sh"), "utf8");
    assert.ok(
      assignment.includes(join(workspace, "workspace", "jobs", jobId)),
      "the assignment cds into the job directory",
    );
    assert.match(assignment, /exec bash .*submit\.sh/);
    // Pilots are queued long before the run exists and with --export=NONE, so
    // nothing is inherited: the assignment has to carry the execution
    // environment itself. Without it every setting that travels as an
    // environment variable was silently lost on this deployment alone — the
    // per-run capability disables, the GPU template, the enabled host tools, the
    // agent-SDK turn/effort/thinking/budget limits and the telemetry opt-out.
    assert.match(
      assignment,
      /^export BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES='web-search'$/m,
      "the pilot assignment exports what the server configured for this run",
    );
    // And never a credential: the spool script lives on shared storage, so
    // secrets keep coming from the owner-only credentials file.
    for (const secret of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CURSOR_API_KEY",
      "OPENROUTER_API_KEY",
    ]) {
      assert.equal(
        assignment.includes(secret),
        false,
        `${secret} must never be written into a job script`,
      );
    }

    // An empty pool fails LOUD with the runway instruction, creating no job.
    const empty = await requestJson<{ message: string }>(server, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ topic: "no pilot left" }),
    });
    assert.equal(empty.status, 400);
    assert.match(empty.value.message, /no held pilot jobs are available/);

    // Cancel goes through scancel with the recorded cluster, as usual.
    const cancelled = await requestJson<{ status: string }>(
      server,
      `/api/jobs/${jobId}/cancel`,
      { method: "POST", body: "{}" },
    );
    assert.equal(cancelled.value.status, "cancelled");
    assert.equal(readFileSync(scancelRecord, "utf8"), "-M serial 4242");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("gate countdowns do not arm during the post-start grace window", async () => {
  // A gate raised while no server was running (shift handover, restart)
  // must not auto-approve before a human could possibly have seen it.
  const workspace = tempRoot();
  try {
    const jobId = "handover-gate-job";
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const sessionDir = join(workspace, "workspace", "sessions", jobId);
    mkdirSync(jobDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(jobDir, "job.json"),
      JSON.stringify({
        jobId,
        topic: "suspended across a shift handover",
        status: "suspended",
        runner: "local",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        submissionCount: 1,
      }),
    );
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: jobId,
        workflowId: "brainstorm",
        status: "suspended",
        input: {},
        journal: [],
        pendingGates: [
          { gateKey: "confirm-panel", journalKey: "confirm-panel::response", path: "root/confirm-panel" },
        ],
        seq: 4,
        updatedAt: Date.now() - 30_000,
      }),
    );

    const graced = new JobManager({ workspace, gateAutoApproveGraceMs: 60_000 });
    graced.reload();
    await graced.autoApproveDueGates();
    const withGrace = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
      gateAutoApprove?: unknown;
    };
    assert.equal(
      withGrace.gateAutoApprove,
      undefined,
      "inside the grace window the countdown must not arm",
    );

    const immediate = new JobManager({ workspace, gateAutoApproveGraceMs: 0 });
    immediate.reload();
    await immediate.autoApproveDueGates();
    const withoutGrace = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
      gateAutoApprove?: { gateKey?: string };
    };
    assert.equal(withoutGrace.gateAutoApprove?.gateKey, "confirm-panel");
  } finally {
    await removeWorkspace(workspace);
  }
});

test("local offline job completes with every dashboard artifact", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });
    const jobId = await submit(
      server,
      "Can KNN graph construction be made differentiable?",
    );
    let detail = await waitFor(server, jobId, "completed");
    const storedPin = JSON.parse(
      readFileSync(
        join(
          workspace,
          "workspace",
          "jobs",
          jobId,
          "content",
          "content-pin.json",
        ),
        "utf8",
      ),
    ) as {
      bundle: string;
      version: string;
      manifestSha256: string;
    };
    assert.equal(storedPin.bundle, "brainstorm");
    assert.equal(storedPin.version, pinnedBundleVersion());
    assert.match(storedPin.manifestSha256, /^[a-f0-9]{64}$/);
    // The exact skills version this run executed travels on the job itself.
    assert.deepEqual(detail.contentBundle, {
      id: "brainstorm",
      version: pinnedBundleVersion(),
    });
    appendFileSync(
      join(workspace, "workspace", "jobs", jobId, "events.jsonl"),
      `${JSON.stringify({
        type: "agent:progress",
        runId: jobId,
        seq: 99999,
        at: Date.now(),
        path: "brainstorm-root/decompose-experts/decompose-experts-execute",
        taskId: `${jobId}:decompose`,
        taskKind: "brainstorm.decomposer",
        progress: {
          kind: "tool_start",
          toolName: "WebSearch",
          message: "Searching the web — differentiable graph construction",
        },
      })}\n`,
    );
    detail = await server.manager.detail(jobId);
    assert.equal(detail.stages.length, 9);
    assert.ok(detail.stages.every((stage) => stage.status === "completed"));
    assert.ok(detail.stages[0]!.id === "process-input" && detail.stages[0].output);
    assert.ok(detail.stages[1]!.id === "decompose-experts" && detail.stages[1].experts);
    assert.ok(
      !("grounding" in detail.stages[1].experts!),
      "the tree view carries departments only; grounding is a sibling field",
    );
    const decomposeGrounding = detail.stages[1].grounding;
    assert.ok(
      decomposeGrounding &&
        decomposeGrounding.papers.length > 0 &&
        decomposeGrounding.scholars.length > 0,
      "the decompose stage exposes the papers/authors/interests grounding",
    );
    assert.ok(
      decomposeGrounding.scholars.some(
        (scholar) => scholar.profile === "ok" && scholar.interests.length > 0,
      ),
    );
    // Review members are named by seat (umbrella terms may repeat across
    // seats), and every recorded round carries the chain-of-thought step
    // text exactly as its reviewers saw it.
    const reviewStage = detail.stages.find((stage) => stage.id === "review-members");
    assert.ok(reviewStage && reviewStage.id === "review-members");
    assert.ok(reviewStage.members.length > 0);
    reviewStage.members.forEach((member, index) => {
      assert.equal(member.label, `Seat ${index + 1}`);
      assert.ok(member.umbrella, "the seat keeps its umbrella as secondary detail");
    });
    const reviewedRound = reviewStage.members[0]!.steps[0]!.rounds[0];
    assert.ok(reviewedRound, "the first step records at least one round");
    // Branch on the RECORDED shape, never on a version: a step is one string
    // or four parts, both shapes reach the reader forever, and the round must
    // carry real text in whichever shape its own chain used. An absent step
    // satisfies neither branch, which is the failure this guards.
    const reviewedCot = reviewedRound.cot;
    assert.ok(
      reviewedCot !== undefined &&
        (isCotStepParts(reviewedCot)
          ? COT_STEP_PARTS.every((part) => reviewedCot[part].length > 0)
          : reviewedCot.length > 0),
      "each round carries the reviewed chain-of-thought text",
    );
    assert.ok(
      reviewedRound.comments.every((comment) => /^Seat \d+$/.test(comment.commentorLabel)),
      "commentors are named by seat",
    );

    // The split pipeline surfaces its sub-steps on the stage, each completed
    // and carrying a one-line result from its artifact.
    const decomposeSteps = detail.stages[1].steps;
    assert.ok(decomposeSteps, "the decompose stage carries the split pipeline steps");
    assert.deepEqual(
      decomposeSteps.map((step) => step.id),
      ["build-pool", "match-taxonomy", "place-fields", "submit-decisions", "bridge-experts"],
    );
    assert.ok(decomposeSteps.every((step) => step.status === "completed"));
    assert.match(decomposeSteps[0]!.detail ?? "", /\d+ members from \d+ papers/);
    assert.match(decomposeSteps[1]!.detail ?? "", /\d+ matched · \d+ unmatched/);
    assert.match(decomposeSteps[4]!.detail ?? "", /\d+ departments/);
    assert.ok(
      detail.stages[1]!.activity?.some((entry) =>
        entry.message.includes("differentiable graph construction"),
      ),
    );
    assert.ok(detail.stages[2]!.id === "select-panel" && detail.stages[2].panel?.length);
    assert.ok(
      detail.stages[4]!.id === "first-pass" &&
      detail.stages[4].members.every((member) => member.idea?.literature?.length),
    );
    assert.ok(
      detail.stages[5]!.id === "review-members" &&
      detail.stages[5].members.every((member) =>
        member.steps.every((step) => step.outcome === "passed")
      ),
    );
    assert.ok(
      detail.stages[6]!.id === "bridge-audit" &&
      detail.stages[6].bridge &&
      detail.stages[6].bridge.noveltyAudit.length > 0,
      "the integration audit stage carries the bridge report",
    );
    assert.ok(
      detail.stages[7]!.id === "synthesize-proposal" &&
      detail.stages[7].proposal,
    );
    assert.ok(detail.stages[8]!.id === "done" && detail.stages[8].summary);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("attachments are ingested at submission and partitioned into useful and ignored files", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    attachmentRoots: [workspace],
  });
  try {
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });

    const source = join(workspace, "material");
    mkdirSync(join(source, "src"), { recursive: true });
    mkdirSync(join(source, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(source, "src", "model.py"), "def f():\n    return 1\n");
    writeFileSync(join(source, "package-lock.json"), "{}\n");
    writeFileSync(join(source, "node_modules", "dep", "index.js"), "junk\n");

    // A broken attachment rejects the submission with a clear 400.
    const bad = await requestJson<{ message?: string }>(server, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        topic: "broken",
        attachments: [join(workspace, "missing-thing")],
      }),
    });
    assert.equal(bad.status, 400);
    assert.match(String(bad.value.message ?? ""), /does not exist/);

    const jobId = await submit(server, "Use the attached prototype", [source]);
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const manifestPath = join(jobDir, "attachments", "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest is materialized at submission");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      attachments: { kind: string; files: { path: string }[] }[];
      totalFiles: number;
    };
    assert.equal(manifest.attachments[0]!.kind, "folder");
    assert.equal(manifest.totalFiles, 2, "junk directories never enter the inventory");
    assert.ok(
      readFileSync(join(jobDir, "submit.sh"), "utf8").includes("--attachments-manifest"),
      "the orchestration command carries the manifest",
    );
    const record = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
      attachments?: string[];
    };
    assert.deepEqual(record.attachments, [realpathSync(source)]);

    const detail = await waitFor(server, jobId, "completed");
    const stage = detail.stages[0]!;
    assert.ok(stage.id === "process-input" && stage.files, "file partition reaches the dashboard");
    const files = stage.files!;
    assert.ok(files.useful.length >= 1);
    assert.ok(files.useful.every((file) => file.label !== "NA"));
    assert.ok(files.useful.some((file) => file.path.endsWith("src/model.py")));
    assert.ok(files.ignored.length >= 1, "the lockfile is labeled NA and split out");
    assert.ok(files.ignored.every((file) => file.label === "NA"));
    assert.ok(
      files.ignored.some((file) => file.path.endsWith("package-lock.json")),
    );
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("server file picker starts at its roots, reaches any readable path, and snapshots at launch", async () => {
  const workspace = tempRoot();
  const remoteRoot = join(workspace, "remote-data");
  const prototype = join(remoteRoot, "prototype");
  mkdirSync(join(prototype, "src"), { recursive: true });
  writeFileSync(join(prototype, "src", "model.py"), "def model():\n    return 42\n");
  writeFileSync(join(prototype, "package-lock.json"), "{}\n");
  writeFileSync(join(remoteRoot, "notes.txt"), "not a PDF\n");
  writeFileSync(join(remoteRoot, ".hidden.pdf"), "%PDF-hidden\n");
  mkdirSync(join(remoteRoot, "node_modules"), { recursive: true });
  writeFileSync(join(remoteRoot, "node_modules", "package.json"), "{}\n");
  const travel = join(remoteRoot, "Desktop", "fa-travel");
  mkdirSync(travel, { recursive: true });
  writeFileSync(join(travel, "itinerary.pdf"), "%PDF-itinerary\n");
  symlinkSync("/etc", join(remoteRoot, "escape-outside-root"));
  // A dataset OUTSIDE the configured root — the common HPC layout where
  // inputs live on scratch/project mounts, not under the browse root.
  const outsideData = join(workspace, "outside-data");
  mkdirSync(outsideData, { recursive: true });
  writeFileSync(join(outsideData, "measurements.txt"), "42, 43, 44\n");
  const canonicalRoot = realpathSync(remoteRoot);
  const canonicalPrototype = realpathSync(prototype);
  const canonicalOutside = realpathSync(outsideData);
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    attachmentRoots: [remoteRoot],
  });
  try {
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });

    const roots = await requestJson<{
      roots: { id: string; path: string }[];
    }>(server, "/api/attachments/roots");
    assert.equal(roots.status, 200);
    assert.equal(roots.value.roots.length, 1);
    assert.equal(roots.value.roots[0]!.path, canonicalRoot);
    const rootId = roots.value.roots[0]!.id;

    const top = await requestJson<{
      currentPath: string;
      entries: {
        name: string;
        path: string;
        kind: string;
        selectable: boolean;
      }[];
    }>(
      server,
      `/api/attachments/browse?kind=folder&root=${encodeURIComponent(rootId)}`,
    );
    assert.equal(top.status, 200);
    assert.equal(top.value.currentPath, canonicalRoot);
    assert.ok(
      top.value.entries.some(
        (entry) =>
          entry.name === "prototype" &&
          entry.kind === "folder" &&
          entry.selectable,
      ),
    );
    assert.ok(
      top.value.entries.some(
        (entry) =>
          entry.name === "escape-outside-root" && entry.kind === "folder",
      ),
      "symlinks leading outside the root stay visible (HPC scratch links)",
    );
    assert.equal(
      top.value.entries.some(
        (entry) =>
          entry.name.startsWith(".") || entry.name === "node_modules",
      ),
      false,
      "hidden and junk entries are not shown in the picker",
    );

    // Roots are starting points, not walls: browsing the parent of the
    // configured root works, and the root itself is one of its entries.
    const above = await requestJson<{
      currentPath: string;
      entries: { name: string; kind: string }[];
    }>(
      server,
      `/api/attachments/browse?kind=folder&root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(resolve(canonicalRoot, ".."))}`,
    );
    assert.equal(above.status, 200);
    assert.ok(
      above.value.entries.some(
        (entry) => entry.name === "remote-data" && entry.kind === "folder",
      ),
    );
    assert.ok(
      above.value.entries.some(
        (entry) => entry.name === "outside-data" && entry.kind === "folder",
      ),
      "sibling folders outside the configured root are browsable",
    );

    const folderSearch = await requestJson<{
      entries: {
        name: string;
        path: string;
        kind: string;
        selectable: boolean;
      }[];
      truncated: boolean;
    }>(
      server,
      `/api/attachments/search?kind=pdf&root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(canonicalRoot)}&q=${encodeURIComponent("fa-")}`,
    );
    assert.equal(folderSearch.status, 200);
    assert.ok(
      folderSearch.value.entries.some(
        (entry) =>
          entry.name === "fa-travel" &&
          entry.kind === "folder" &&
          !entry.selectable,
      ),
      "recursive search returns matching navigation folders even in PDF mode",
    );

    const fileSearch = await requestJson<{
      entries: {
        name: string;
        path: string;
        kind: string;
        selectable: boolean;
      }[];
    }>(
      server,
      `/api/attachments/search?kind=pdf&root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(canonicalRoot)}&q=itinerary`,
    );
    assert.ok(
      fileSearch.value.entries.some(
        (entry) =>
          entry.name === "itinerary.pdf" &&
          entry.kind === "file" &&
          entry.selectable,
      ),
      "recursive search returns selectable files of the requested type",
    );

    const inside = await requestJson<{
      entries: { name: string; selectable: boolean; reason?: string }[];
    }>(
      server,
      `/api/attachments/browse?kind=pdf&root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(canonicalRoot)}`,
    );
    assert.equal(inside.status, 200);
    assert.ok(
      inside.value.entries.some(
        (entry) =>
          entry.name === "notes.txt" &&
          !entry.selectable &&
          /pdf/i.test(entry.reason ?? ""),
      ),
      "type filtering happens while browsing",
    );

    const validated = await requestJson<{
      attachments: {
        path: string;
        valid: boolean;
        readable: boolean;
        files?: number;
      }[];
    }>(server, "/api/attachments/validate", {
      method: "POST",
      body: JSON.stringify({ kind: "folder", paths: [canonicalPrototype] }),
    });
    assert.equal(validated.status, 200);
    assert.deepEqual(validated.value.attachments, [
      {
        path: canonicalPrototype,
        name: "prototype",
        kind: "folder",
        valid: true,
        readable: true,
        files: 2,
        bytes:
          statSync(join(prototype, "src", "model.py")).size +
          statSync(join(prototype, "package-lock.json")).size,
      },
    ]);

    const wrongType = await requestJson<{
      attachments: { valid: boolean; reason?: string }[];
    }>(server, "/api/attachments/validate", {
      method: "POST",
      body: JSON.stringify({
        kind: "pdf",
        paths: [join(canonicalRoot, "notes.txt")],
      }),
    });
    assert.equal(wrongType.status, 200);
    assert.equal(wrongType.value.attachments[0]!.valid, false);
    assert.match(wrongType.value.attachments[0]!.reason ?? "", /PDF/i);

    // Paths outside every configured root validate like any other readable
    // path: the roots are bookmarks, the OS permissions are the boundary.
    const outsideFolder = await requestJson<{
      attachments: { valid: boolean; files?: number; reason?: string }[];
    }>(server, "/api/attachments/validate", {
      method: "POST",
      body: JSON.stringify({ kind: "folder", paths: [canonicalOutside] }),
    });
    assert.equal(outsideFolder.status, 200);
    assert.equal(outsideFolder.value.attachments[0]!.valid, true);
    assert.equal(outsideFolder.value.attachments[0]!.files, 1);

    // Nonexistent paths still fail cleanly.
    const missing = await requestJson<{
      attachments: { valid: boolean; reason?: string }[];
    }>(server, "/api/attachments/validate", {
      method: "POST",
      body: JSON.stringify({
        kind: "file",
        paths: [join(workspace, "never-created.txt")],
      }),
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.value.attachments[0]!.valid, false);
    assert.match(missing.value.attachments[0]!.reason ?? "", /does not exist/);

    const jobId = await submit(
      server,
      "Analyze this server-resident prototype",
      [canonicalPrototype, canonicalOutside],
    );
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const manifest = JSON.parse(
      readFileSync(join(jobDir, "attachments", "manifest.json"), "utf8"),
    ) as {
      attachments: {
        origin: string;
        files: { path: string }[];
      }[];
    };
    assert.deepEqual(
      manifest.attachments.map((attachment) => attachment.origin).sort(),
      [canonicalOutside, canonicalPrototype].sort(),
      "out-of-root folders launch alongside in-root ones",
    );
    assert.ok(
      manifest.attachments.every((attachment) =>
        attachment.files.every((file) =>
          file.path.startsWith(join(jobDir, "attachments")),
        ),
      ),
      "launch snapshots server files into the immutable job store",
    );

    const detail = await waitFor(server, jobId, "completed");
    const stage = detail.stages[0]!;
    assert.ok(stage.id === "process-input" && stage.files);
    assert.ok(stage.files.useful.some((file) => file.path.endsWith("model.py")));
    assert.ok(
      stage.files.ignored.some((file) =>
        file.path.endsWith("package-lock.json"),
      ),
    );

    // Submission rechecks existence even after the green validation result.
    const transient = join(remoteRoot, "transient.txt");
    writeFileSync(transient, "temporary");
    const transientValidation = await requestJson<{
      attachments: { valid: boolean }[];
    }>(server, "/api/attachments/validate", {
      method: "POST",
      body: JSON.stringify({ kind: "file", paths: [transient] }),
    });
    assert.equal(transientValidation.value.attachments[0]!.valid, true);
    rmSync(transient);
    const staleSubmit = await requestJson<{ message?: string }>(
      server,
      "/api/jobs",
      {
        method: "POST",
        body: JSON.stringify({ topic: "stale", attachments: [transient] }),
      },
    );
    assert.equal(staleSubmit.status, 400);
    assert.match(staleSubmit.value.message ?? "", /does not exist/);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("manual gate can shrink, complete, and reload after restart", async () => {
  const workspace = tempRoot();
  let server = await startTestBrainServer({ workspace, port: 0 });
  try {
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "manual",
      llm: { provider: "offline" },
    });
    const jobId = await submit(server, "Pause and shrink this panel");
    let suspended = await waitFor(server, jobId, "suspended");
    // Split-classification bundles (>= 0.14.0) pause at the classification
    // gate first; approve it to reach the panel gate this test targets.
    if (suspended.pendingGate?.gateKey === "confirm-classification") {
      const approvedClassification = await requestJson<JobDetail>(
        server,
        `/api/jobs/${jobId}/gate`,
        {
          method: "POST",
          body: JSON.stringify({
            gateKey: "confirm-classification",
            action: "approve",
          }),
        },
      );
      assert.equal(approvedClassification.status, 200);
      // The job reports "suspended" from its checkpoint until the resumed
      // worker actually reaches the panel gate, so wait for the NEXT gate,
      // never merely the next suspended status.
      const deadline = Date.now() + 120_000;
      for (;;) {
        suspended = (await requestJson<JobDetail>(server, `/api/jobs/${jobId}`)).value;
        if (
          suspended.status === "suspended" &&
          suspended.pendingGate?.gateKey === "confirm-panel"
        ) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error("the panel gate never arrived after approving the classification");
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    const contentDir = join(
      workspace,
      "workspace",
      "jobs",
      jobId,
      "content",
    );
    const pin = JSON.parse(
      readFileSync(join(contentDir, "content-pin.json"), "utf8"),
    ) as {
      bundle: string;
      version: string;
      manifestSha256: string;
      manifest: { files: Array<{ path: string }> };
    };
    // Content is fetched into memory and never written to disk, so the job's
    // content directory holds the pin and nothing else: no copy of the
    // pipeline is left behind after (or during) a run.
    assert.deepEqual(
      readdirSync(contentDir).sort(),
      ["content-pin.json"],
      "the run leaves only its provenance pin on disk",
    );

    // Skill delivery is observed where it actually happens — the documents the
    // run requested from the registry — rather than through a disk
    // side-effect that no longer exists.
    // The double logs full registry paths; compare on bundle-relative ones.
    const prefix = `bundles/${pin.bundle}/${pin.version}/`;
    const fetched = new Set(
      server.registryReads
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length)),
    );
    assert.ok(
      fetched.has("skills/roles/processor.md"),
      "a role whose stage has run is fetched",
    );
    const shippedRoles = new Set(pin.manifest.files.map((file) => file.path));
    const panelRoles = [
      "skills/roles/decomposer.md",
      "skills/roles/pool-builder.md",
      "skills/roles/placer.md",
    ].filter((path) => shippedRoles.has(path));
    assert.ok(panelRoles.length > 0, "the pinned bundle ships a panel-stage role");
    for (const path of panelRoles) {
      assert.ok(fetched.has(path), `${path} fetched by suspension`);
    }
    // Every skill is bought at pin time, while the connection that resolved the
    // pin is proven alive — including the roles whose stages are still many
    // hours away. Fetching them lazily made a run's success depend on the
    // registry connection surviving into its final stretch, and an overnight
    // run died exactly there: the one never-yet-fetched skill failed every
    // walk that reached it.
    for (const laterStage of ["brain", "commentor", "judge", "chair"]) {
      const path = `skills/roles/${laterStage}.md`;
      if (!shippedRoles.has(path)) continue;
      assert.ok(
        fetched.has(path),
        `${laterStage} is fetched up front, so no later stage needs the connection`,
      );
    }
    assert.ok(suspended.pendingGate?.members);
    const original = suspended.pendingGate.members;
    const keep = original.slice(0, 2).map((member) => member.id);

    // The poller arms the 30s auto-approve countdown; holding it (any click
    // in the confirmation card does this) freezes the gate open, which also
    // keeps the rest of this test deterministic.
    await (async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const detail = await requestJson<JobDetail>(server, `/api/jobs/${jobId}`);
        if (detail.value.pendingGate?.autoApprove) return;
        if (Date.now() > deadline) {
          throw new Error("the auto-approve countdown never armed");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    const heldDetail = await requestJson<JobDetail>(
      server,
      `/api/jobs/${jobId}/gate-hold`,
      { method: "POST" },
    );
    assert.equal(heldDetail.status, 200);
    assert.equal(heldDetail.value.pendingGate?.autoApprove?.held, true);

    // Malformed custom seats never reach the runtime: four subfields is out
    // of the 1-3 range.
    const badSeat = await requestJson<{ message: string }>(
      server,
      `/api/jobs/${jobId}/gate`,
      {
        method: "POST",
        body: JSON.stringify({
          gateKey: suspended.pendingGate.gateKey,
          action: "approve",
          addedMembers: [
            { department: "X", umbrella: "Y", subfields: ["a", "b", "c", "d"] },
          ],
        }),
      },
    );
    assert.equal(badSeat.status, 400);
    assert.match(badSeat.value.message, /1 to 3/);

    // Shrink to two seats AND add one user-defined custom seat.
    const customSeat = {
      department: "Synthetic Biology",
      umbrella: "Biofoundry Automation",
      subfields: [
        "Automated strain engineering",
        "Design-build-test-learn loops",
      ],
    };
    const answered = await requestJson<JobDetail>(
      server,
      `/api/jobs/${jobId}/gate`,
      {
        method: "POST",
        body: JSON.stringify({
          gateKey: suspended.pendingGate.gateKey,
          action: "shrink",
          members: keep,
          addedMembers: [customSeat],
        }),
      },
    );
    assert.equal(answered.status, 200);
    const completed = await waitFor(server, jobId, "completed");
    // Content never reaches disk at all — not during the run and not after it
    // — so the completed job's content directory still holds only the pin.
    assert.deepEqual(
      readdirSync(contentDir).sort(),
      ["content-pin.json"],
      "a completed run leaves only its provenance pin on disk",
    );
    const confirm = completed.stages[3]!;
    assert.equal(confirm.id, "confirm-panel");
    assert.equal(confirm.id === "confirm-panel" && confirm.gate.state, "shrunk");
    assert.deepEqual(
      confirm.id === "confirm-panel" ? confirm.gate.removedMemberIds : [],
      original.slice(2).map((member) => member.id),
    );
    assert.deepEqual(
      confirm.id === "confirm-panel" ? confirm.gate.addedMemberIds : [],
      ["member-user-1"],
    );

    // The custom seat ran the whole pipeline like any selected member.
    const firstPass = completed.stages[4]!;
    assert.equal(firstPass.id, "first-pass");
    if (firstPass.id === "first-pass") {
      assert.equal(firstPass.members.length, keep.length + 1);
      const custom = firstPass.members.find(
        (member) => member.memberId === "member-user-1",
      );
      assert.ok(custom, "the custom seat joins the first pass");
      assert.equal(custom.department, customSeat.department);
      assert.equal(custom.umbrella, customSeat.umbrella);
      assert.deepEqual(custom.subfields, customSeat.subfields);
      assert.equal(custom.status, "completed");
      assert.ok(custom.idea, "the custom seat produced a first-pass idea");
    }
    const reviewStage = completed.stages[5]!;
    assert.equal(reviewStage.id, "review-members");
    if (reviewStage.id === "review-members") {
      assert.ok(
        reviewStage.members.some((member) => member.memberId === "member-user-1"),
        "the custom seat is reviewed like any other",
      );
    }

    await server.close();
    server = await startTestBrainServer({ workspace, port: 0 });
    const listed = await requestJson<JobSummary[]>(server, "/api/jobs");
    assert.ok(listed.value.some((job) => job.jobId === jobId && job.status === "completed"));
    const reloaded = await requestJson<JobDetail>(server, `/api/jobs/${jobId}`);
    assert.equal(reloaded.value.status, "completed");
    assert.ok(reloaded.value.stages[6]!.id === "bridge-audit");
    assert.ok(reloaded.value.stages[7]!.id === "synthesize-proposal");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("a classification revision over HTTP proceeds with the revised reading", async () => {
  // Regression: the gate route validated action against approve|shrink only
  // and answered 400 "invalid gate answer" for "revise", while
  // JobManager.answerGate and the webapp's classification gate card fully
  // implement it — revising the submission type from the dashboard was
  // impossible.
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "manual",
      llm: { provider: "offline" },
    });
    const jobId = await submit(server, "Revise this run's reading at the gate");
    const suspended = await waitFor(server, jobId, "suspended");
    if (suspended.pendingGate?.gateKey !== "confirm-classification") {
      // Pre-split bundles (< 0.14.0) have no classification gate to revise.
      assert.ok(suspended.pendingGate, "the run paused on a gate");
      return;
    }
    const classification = suspended.pendingGate.classification;
    assert.ok(classification, "the classification gate carries the offered readings");

    // Structurally malformed asks are refused at the route.
    const malformed = await requestJson<{ message: string }>(
      server,
      `/api/jobs/${jobId}/gate`,
      {
        method: "POST",
        body: JSON.stringify({
          gateKey: "confirm-classification",
          action: "revise",
          requestedOutputs: [{ title: "Missing the ask" }],
        }),
      },
    );
    assert.equal(malformed.status, 400);
    assert.match(malformed.value.message, /invalid gate answer/);

    // Semantically invalid revisions still fail in the manager: a type the
    // run's catalog never offered is rejected, not forwarded to the worker.
    const unknownType = await requestJson<{ message: string }>(
      server,
      `/api/jobs/${jobId}/gate`,
      {
        method: "POST",
        body: JSON.stringify({
          gateKey: "confirm-classification",
          action: "revise",
          type: "not-a-catalog-type",
        }),
      },
    );
    assert.equal(unknownType.status, 400);
    assert.match(unknownType.value.message, /not a type/);

    // Revise the requested outputs while keeping the primary reading — the
    // offline executor stubs only the paper shape, so the type stays put and
    // the asks carry the revision end to end.
    const requestedOutputs = [
      { title: "Benchmark table", ask: "Summarize the benchmark results as one table." },
    ];
    const revised = await requestJson<JobDetail>(server, `/api/jobs/${jobId}/gate`, {
      method: "POST",
      body: JSON.stringify({
        gateKey: "confirm-classification",
        action: "revise",
        requestedOutputs,
      }),
    });
    assert.equal(revised.status, 200);

    // The revision resumes the run to the panel gate; approve it as seated.
    const deadline = Date.now() + 120_000;
    for (;;) {
      const detail = (await requestJson<JobDetail>(server, `/api/jobs/${jobId}`)).value;
      if (detail.status === "suspended" && detail.pendingGate?.gateKey === "confirm-panel") {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("the panel gate never arrived after the revision");
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const approved = await requestJson<JobDetail>(server, `/api/jobs/${jobId}/gate`, {
      method: "POST",
      body: JSON.stringify({ gateKey: "confirm-panel", action: "approve" }),
    });
    assert.equal(approved.status, 200);

    const completed = await waitFor(server, jobId, "completed");
    const stage = completed.stages[0]!;
    assert.equal(stage.id, "process-input");
    if (stage.id === "process-input") {
      assert.equal(stage.classification?.gate.state, "revised");
      assert.equal(
        stage.output?.type,
        classification.primary.type,
        "an asks-only revision keeps the primary reading",
      );
      assert.deepEqual(
        stage.output?.requestedOutputs?.map((entry) => entry.title),
        ["Benchmark table"],
        "the revised asks replace the classifier's suggestions",
      );
    }
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("jobs SSE emits a snapshot containing a newly submitted job", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  const controller = new AbortController();
  let jobId: string | undefined;
  try {
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });
    const response = await fetch(`${server.url}/api/stream`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const reading = (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
        for (const block of text.split("\n\n")) {
          const line = block.split("\n").find((entry) => entry.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as {
            type: string;
            jobs?: JobSummary[];
          };
          if (event.type === "jobs" && event.jobs?.length) return event.jobs;
        }
      }
      return [];
    })();
    jobId = await submit(server, "Appear in the live stream");
    const jobs = await reading;
    assert.ok(jobs.some((job) => job.jobId === jobId));
  } finally {
    controller.abort();
    if (jobId) await server.manager.cancel(jobId);
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("due credit blocks auto-resume once, survive restart, and can be cancelled", async () => {
  const workspace = tempRoot();
  const marker = join(workspace, "resume-marker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  writeFileSync(
    fakeCli,
    `import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(${JSON.stringify(marker)}, args[0] + "\\n");
const checkpointPath = path.join(value("--session-root"), value("--run-id"), "checkpoint.json");
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
checkpoint.status = "completed"; checkpoint.output = { resumed: true }; delete checkpoint.creditBlock;
checkpoint.updatedAt = Date.now(); fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
`,
  );
  const now = Date.parse("2026-07-22T15:31:00.000Z");
  const manager = new JobManager({ workspace, workerPath: fakeCli, now: () => now });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    llm: { provider: "offline" },
    creditRecovery: {
      autoResume: true,
      safetyBufferSeconds: 60,
      openRouterModel: "openrouter/free",
    },
  });
  const makeBlocked = (jobId: string, retryAt: number): void => {
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const sessionDir = join(workspace, "workspace", "sessions", jobId);
    mkdirSync(jobDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(jobDir, "job.json"),
      JSON.stringify({
        jobId,
        topic: "credit recovery",
        status: "credit-blocked",
        runner: "local",
        createdAt: now - 1000,
        updatedAt: now - 1000,
        submissionCount: 1,
        executionSettings: settings,
      }),
    );
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: jobId,
        workflowId: "brainstorm",
        workflowVersion: "0.1.0",
        status: "credit_blocked",
        input: {},
        journal: [],
        pendingGates: [],
        creditBlock: {
          retryAt,
          providerMessage: "session limit resets 5:30pm",
          source: "deterministic",
        },
        seq: 1,
        updatedAt: now - 1000,
      }),
    );
  };

  makeBlocked("due-job", now - 1);
  makeBlocked("cancelled-job", now + 60_000);
  manager.reload();
  assert.equal(await manager.cancel("cancelled-job"), "cancelled");
  await manager.resumeDueCreditBlocks();
  await waitUntil(() => existsSync(marker), 5_000);
  await waitUntil(() => {
    try {
      const checkpoint = JSON.parse(
        readFileSync(
          join(
            workspace,
            "workspace",
            "sessions",
            "due-job",
            "checkpoint.json",
          ),
          "utf8",
        ),
      ) as { status: string };
      return checkpoint.status === "completed";
    } catch {
      return false;
    }
  }, 5_000);
  await manager.resumeDueCreditBlocks();
  assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1);
  assert.equal((await manager.detail("due-job")).status, "completed");
  assert.equal((await manager.detail("cancelled-job")).status, "cancelled");
  const restarted = new JobManager({ workspace, workerPath: fakeCli, now: () => now });
  assert.equal((await restarted.detail("due-job")).status, "completed");
  rmSync(workspace, { recursive: true, force: true });
});

test("credit-blocked first-pass members surface as paused, not thinking", async () => {
  const workspace = tempRoot();
  const now = Date.parse("2026-07-23T09:45:00.000Z");
  const manager = new JobManager({ workspace, now: () => now });
  const jobId = "paused-members-job";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "paused members",
      status: "credit-blocked",
      runner: "local",
      createdAt: now - 5_000,
      updatedAt: now - 1_000,
      submissionCount: 1,
      executionSettings: {
        ...manager.settings.get(),
        llm: { provider: "offline" },
      },
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      workflowVersion: "0.1.0",
      status: "credit_blocked",
      input: {},
      journal: [],
      pendingGates: [],
      creditBlock: {
        retryAt: now + 60_000,
        providerMessage: "session limit resets 3:21pm",
        source: "deterministic",
      },
      seq: 3,
      updatedAt: now - 1_000,
    }),
  );
  writeFileSync(
    join(sessionDir, "artifacts", "index.json"),
    JSON.stringify({
      refs: [{ id: "panel.json", metadata: { schema: "panel" } }],
    }),
  );
  writeFileSync(
    join(sessionDir, "artifacts", "panel.json"),
    JSON.stringify({
      members: [
        { id: "member-1", department: "CS", umbrella: "GNNs", subfields: [] },
        { id: "member-2", department: "Statistics", umbrella: "Bayesian Inference", subfields: [] },
      ],
    }),
  );
  const started = (seq: number, path: string) =>
    JSON.stringify({ type: "node:started", runId: jobId, seq, at: now - 2_000 + seq, path });
  writeFileSync(
    join(jobDir, "events.jsonl"),
    [
      started(1, "brainstorm-root/first-pass"),
      started(2, "brainstorm-root/first-pass/first-pass-fanout/member[0]/develop-idea"),
      started(3, "brainstorm-root/first-pass/first-pass-fanout/member[1]/develop-idea"),
    ].join("\n") + "\n",
  );
  manager.reload();
  const detail = await manager.detail(jobId);
  assert.equal(detail.status, "credit-blocked");
  const firstPass = detail.stages.find((stage) => stage.id === "first-pass");
  assert.ok(firstPass && firstPass.id === "first-pass");
  assert.equal(firstPass.status, "credit_blocked");
  assert.deepEqual(
    firstPass.members.map((member) => member.status),
    ["paused", "paused"],
    "mid-flight tasks read paused while the credit block holds",
  );
  rmSync(workspace, { recursive: true, force: true });
});

test("a restarted stage sheds its recorded failure after credit-block resume", async () => {
  const workspace = tempRoot();
  const now = Date.parse("2026-07-23T14:00:00.000Z");
  const manager = new JobManager({ workspace, now: () => now });
  const jobId = "resumed-after-limit";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "resumed after session limit",
      status: "running",
      runner: "local",
      createdAt: now - 90_000,
      updatedAt: now,
      submissionCount: 2,
      executionSettings: {
        ...manager.settings.get(),
        llm: { provider: "offline" },
      },
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      workflowVersion: "0.1.0",
      status: "running",
      input: {},
      journal: [],
      pendingGates: [],
      seq: 9,
      updatedAt: now,
    }),
  );
  writeFileSync(
    join(sessionDir, "artifacts", "index.json"),
    JSON.stringify({
      refs: [{ id: "panel.json", metadata: { schema: "panel" } }],
    }),
  );
  writeFileSync(
    join(sessionDir, "artifacts", "panel.json"),
    JSON.stringify({
      members: [
        { id: "member-1", department: "CS", umbrella: "GNNs", subfields: [] },
        { id: "member-2", department: "Statistics", umbrella: "Bayes", subfields: [] },
      ],
    }),
  );
  const memberPath =
    "brainstorm-root/first-pass/first-pass-fanout/member[0]/develop-idea";
  const events = [
    { type: "node:started", at: now - 80_000, path: "brainstorm-root/first-pass" },
    { type: "node:started", at: now - 80_000, path: memberPath },
    {
      type: "node:failed",
      at: now - 60_000,
      path: memberPath,
      error: { name: "AgentTaskFailedError", message: "You've hit your session limit · resets 5:30pm (Europe/Berlin)" },
    },
    {
      type: "node:failed",
      at: now - 60_000,
      path: "brainstorm-root/first-pass",
      error: { name: "AgentTaskFailedError", message: "You've hit your session limit · resets 5:30pm (Europe/Berlin)" },
    },
    // Auto-resume restarts the stage and the member task.
    { type: "node:started", at: now - 10_000, path: "brainstorm-root/first-pass" },
    { type: "node:started", at: now - 10_000, path: memberPath },
  ].map((event, index) => ({ runId: jobId, seq: index + 1, ...event }));
  writeFileSync(
    join(jobDir, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  manager.reload();
  const detail = await manager.detail(jobId);
  const firstPass = detail.stages.find((stage) => stage.id === "first-pass");
  assert.ok(firstPass && firstPass.id === "first-pass");
  assert.equal(firstPass.status, "active", "the restarted stage is running, not failed");
  assert.equal(firstPass.error, undefined, "the superseded failure is not shown");
  assert.equal(
    firstPass.startedAt,
    now - 10_000,
    "elapsed time reflects the current attempt, not the one from yesterday",
  );
  // The stage is the subject here; the seat's own chip says "paused" because
  // this fixture has no live worker (a local job with no pid reconciles to
  // orphaned), and a seat whose run is not executing is not thinking.
  assert.equal(firstPass.members[0]?.status, "paused");
  rmSync(workspace, { recursive: true, force: true });
});

test("legacy failed Claude limit checkpoints migrate to credit-blocked waits", async () => {
  const workspace = tempRoot();
  const errorAt = Date.parse("2026-07-22T15:14:00.000Z");
  const now = Date.parse("2026-07-22T15:20:00.000Z");
  const manager = new JobManager({ workspace, now: () => now });
  const jobId = "legacy-credit-job";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "legacy credit failure",
      status: "failed",
      runner: "local",
      createdAt: errorAt,
      updatedAt: errorAt,
      submissionCount: 1,
      executionSettings: {
        ...manager.settings.get(),
        llm: { provider: "offline" },
      },
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "failed",
      input: {},
      journal: [],
      pendingGates: [],
      error: {
        name: "AgentTaskFailedError",
        message:
          "You've hit your session limit · resets 5:30pm (Europe/Berlin)",
      },
      seq: 1,
      updatedAt: errorAt,
    }),
  );
  manager.reload();
  const detail = await manager.detail(jobId);
  assert.equal(detail.status, "credit-blocked");
  assert.equal(
    detail.creditBlock?.retryAt,
    Date.parse("2026-07-22T15:31:00.000Z"),
  );
  const migrated = JSON.parse(
    readFileSync(join(sessionDir, "checkpoint.json"), "utf8"),
  ) as { status: string; error?: unknown };
  assert.equal(migrated.status, "credit_blocked");
  assert.equal(migrated.error, undefined);
  rmSync(workspace, { recursive: true, force: true });
});

test("credit exhaustion without a reset time becomes a manual block resumed on demand", async () => {
  const workspace = tempRoot();
  const marker = join(workspace, "manual-resume-marker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  writeFileSync(
    fakeCli,
    `import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(${JSON.stringify(marker)}, args[0] + "\\n");
const checkpointPath = path.join(value("--session-root"), value("--run-id"), "checkpoint.json");
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
checkpoint.status = "completed"; checkpoint.output = { resumed: true }; delete checkpoint.creditBlock;
checkpoint.updatedAt = Date.now(); fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
`,
  );
  const now = Date.parse("2026-07-22T15:31:00.000Z");
  const manager = new JobManager({ workspace, workerPath: fakeCli, now: () => now });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    llm: { provider: "offline" },
    creditRecovery: {
      autoResume: true,
      safetyBufferSeconds: 60,
      openRouterModel: "openrouter/free",
    },
  });
  const jobId = "manual-credit-job";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "developer API top-up",
      status: "failed",
      runner: "local",
      createdAt: now - 5_000,
      updatedAt: now - 1_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "failed",
      input: {},
      journal: [],
      pendingGates: [],
      error: {
        name: "AgentTaskFailedError",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
      seq: 1,
      updatedAt: now - 1_000,
    }),
  );
  manager.reload();
  // The failure migrates to a credit block with no reset time (manual).
  const detail = await manager.detail(jobId);
  assert.equal(detail.status, "credit-blocked");
  assert.equal(detail.creditBlock?.retryAt, undefined);
  assert.equal(detail.creditBlock?.source, "manual");
  // The scheduler never claims a manual block, even with auto-resume on.
  await manager.resumeDueCreditBlocks();
  assert.equal(existsSync(marker), false, "manual blocks are not auto-claimed");
  // A user claim submits the deterministic resume command.
  assert.equal(await manager.resumeCreditBlocked(jobId), "queued");
  await waitUntil(() => existsSync(marker), 5_000);
  await waitUntil(() => {
    try {
      const checkpoint = JSON.parse(
        readFileSync(join(sessionDir, "checkpoint.json"), "utf8"),
      ) as { status: string };
      return checkpoint.status === "completed";
    } catch {
      return false;
    }
  }, 5_000);
  assert.equal((await manager.detail(jobId)).status, "completed");
  // A job that is no longer credit blocked cannot be claimed again.
  await assert.rejects(
    manager.resumeCreditBlocked(jobId),
    /not credit blocked/,
  );
  rmSync(workspace, { recursive: true, force: true });
});

test("GET /api/jobs/:id/prompt/:promptId serves the record, and 404s what it cannot find", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    // The point of the assertion: the job-detail matcher must not swallow the
    // longer path, and an unknown run or record is a 404 rather than a 500 —
    // a row can legitimately reach the browser a moment before its file line
    // lands, so this answer is expected and must never be cached.
    const missing = await fetch(`${server.url}/api/jobs/no-such-job/prompt/no-such-id`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /was not found/);

    // The other half of the one-row-one-file invariant: a row that DOES have a
    // record behind it must resolve to the file, with the headers that make the
    // browser save it under a legible name. Written as the worker writes it —
    // one JSON.stringify per line in the run's job directory.
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });
    const jobId = await submit(server, "A run whose prompt can be downloaded");
    const promptId = "0f9e6b1c-7a4d-4e2f-9c3b-1d5a8e7f2b60";
    const promptDir = join(workspace, "workspace", "jobs", jobId);
    mkdirSync(promptDir, { recursive: true });
    appendFileSync(
      join(promptDir, "prompts.jsonl"),
      `${JSON.stringify({
        id: promptId,
        at: Date.now(),
        taskId: `${jobId}:brainstorm-root/first-pass/member[0]/develop-idea`,
        kind: "brainstorm.brain",
        agentId: "member-1",
        attempt: 1,
        turn: 1,
        provider: "anthropic",
        model: "claude-sonnet-5",
        complete: true,
        sections: [
          { title: "System prompt", body: "You are a scientific panel member." },
          { title: "Message 1 · user", body: "Develop the idea.\nSecond line." },
        ],
      })}\n`,
    );
    const served = await fetch(
      `${server.url}/api/jobs/${encodeURIComponent(jobId)}/prompt/${encodeURIComponent(promptId)}`,
    );
    assert.equal(served.status, 200);
    assert.match(served.headers.get("content-type") ?? "", /^text\/markdown/);
    // The filename is what turns a bare id in the URL into a legible download.
    assert.match(
      served.headers.get("content-disposition") ?? "",
      new RegExp(`attachment; filename="[a-z0-9-]+-\\d{8}-\\d{6}-${promptId}\\.md"`),
    );
    const markdown = await served.text();
    assert.match(markdown, /^# Prompt · /m);
    assert.match(markdown, /## System prompt/);
    assert.match(markdown, /You are a scientific panel member\./);
    assert.match(markdown, /Develop the idea\./);
    // A record the file does not hold is still a 404, never another record.
    const wrong = await fetch(`${server.url}/api/jobs/${jobId}/prompt/not-that-one`);
    assert.equal(wrong.status, 404);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("POST /api/jobs/:id/resume rejects unknown and non-blocked jobs", async () => {
  const workspace = tempRoot();
  const server = await startTestBrainServer({ workspace, port: 0 });
  try {
    const missing = await requestJson<{ error: string }>(
      server,
      "/api/jobs/no-such-job/resume",
      { method: "POST" },
    );
    assert.equal(missing.status, 404);
    await putSettings(server, {
      runner: "local",
      panelConfirmation: "auto",
      llm: { provider: "offline" },
    });
    const jobId = await submit(server, "Resume endpoint conflict check");
    const conflict = await requestJson<{ error: string }>(
      server,
      `/api/jobs/${jobId}/resume`,
      { method: "POST" },
    );
    assert.equal(conflict.status, 409);
    await server.manager.cancel(jobId);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("readiness reports required checks, gates submissions while red, and re-runs on demand", async () => {
  const workspace = tempRoot();
  let llmProbeCalls = 0;
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    readinessProbes: {
      llm: async () => {
        llmProbeCalls += 1;
        throw new Error(
          "Configure and verify the Anthropic API key and model in Settings",
        );
      },
      internet: async () => ({ message: "stub online" }),
      code: async () => ({ message: "stub scripts run" }),
      slurm: async () => ({ message: "stub sbatch works" }),
    },
    readinessAdvisor: null,
  });
  try {
    // The startup evaluation lands asynchronously: wait for the failed LLM check.
    let report!: ReadinessReport;
    await (async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        report = (
          await requestJson<ReadinessReport>(server, "/api/readiness")
        ).value;
        const llm = report.checks.find((check) => check.id === "llm");
        if (llm?.state === "failed") return;
        if (Date.now() > deadline) throw new Error("llm check never failed");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    assert.equal(report.ready, false);
    assert.equal(report.checks.length, 6);
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    assert.equal(byId.get("registry")?.state, "ok");
    // Default settings: anthropic provider + slurm runner => all six required.
    assert.ok(report.checks.every((check) => check.required));
    // The capabilities probe is pure evaluation (no stub needed): with the
    // default enabled host tools every core capability resolves to a source.
    assert.equal(byId.get("capabilities")?.state, "ok");
    assert.match(byId.get("capabilities")?.message ?? "", /taxonomy-access: host tools/);
    assert.match(byId.get("llm")?.message ?? "", /Configure and verify/);
    // A failed check always carries fix advice (built-in hint without an LLM).
    assert.ok((byId.get("llm")?.advice ?? "").length > 0);

    // The gate: a red required check holds submissions with a 409 + report.
    const blocked = await requestJson<{
      message: string;
      readiness: ReadinessReport;
    }>(server, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ topic: "must wait for green icons" }),
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.value.message, /Environment is not ready/);
    assert.match(blocked.value.message, /Configure and verify/);
    assert.equal(blocked.value.readiness.ready, false);
    assert.equal(
      (await requestJson<readonly JobSummary[]>(server, "/api/jobs")).value.length,
      0,
    );

    // Switching to the offline provider re-evaluates: the LLM and internet
    // checks stop being required and the environment turns ready.
    await putSettings(server, { llm: { provider: "offline" } });
    await (async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        report = (
          await requestJson<ReadinessReport>(server, "/api/readiness")
        ).value;
        if (report.ready) return;
        if (Date.now() > deadline) {
          throw new Error(
            `environment never turned ready: ${JSON.stringify(report.checks)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    const after = new Map(report.checks.map((check) => [check.id, check]));
    assert.equal(after.get("llm")?.state, "skipped");
    assert.equal(after.get("internet")?.state, "skipped");
    // The offline executor never calls tools, so capabilities skip with it.
    assert.equal(after.get("capabilities")?.state, "skipped");
    assert.equal(after.get("slurm")?.state, "ok");
    assert.equal(after.get("code")?.state, "ok");

    // The gate is open now: submission proceeds past readiness and fails only
    // inside the submitter (no sbatch binary in this environment) — a 400,
    // never the 409 readiness hold.
    const past = await requestJson<{ message: string }>(server, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ topic: "gate is open" }),
    });
    assert.notEqual(past.status, 409);

    // Targeted re-run hits exactly the requested probe. The LLM probe is not
    // required under the offline provider, so it must NOT run again.
    const callsBefore = llmProbeCalls;
    const recheck = await requestJson<ReadinessReport>(
      server,
      "/api/readiness/check",
      { method: "POST", body: JSON.stringify({ checks: ["llm"] }) },
    );
    assert.equal(recheck.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(llmProbeCalls, callsBefore);
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("a SLURM worker's fresh workspace activity proves it alive without a scheduler call", async () => {
  // LRZ policy treats seconds-scale squeue/sacct polling as bannable. The
  // worker's own checkpoint/events writes on shared storage are the primary
  // liveness signal; the scheduler is only consulted once they go quiet.
  const workspace = tempRoot();
  try {
    const jobId = "slurm-fresh-job";
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const sessionDir = join(workspace, "workspace", "sessions", jobId);
    mkdirSync(jobDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(jobDir, "job.json"),
      JSON.stringify({
        jobId,
        topic: "runs on the serial cluster",
        status: "running",
        runner: "slurm",
        slurmJobId: "424242",
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 60_000,
        submissionCount: 1,
      }),
    );
    // Written NOW: the mtime is fresh even though the checkpoint says the
    // run is mid-flight.
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: jobId,
        workflowId: "brainstorm",
        status: "running",
        input: {},
        journal: [],
        pendingGates: [],
        seq: 3,
        updatedAt: Date.now() - 60_000,
      }),
    );
    // PATH has no squeue/sacct: any scheduler probe would report dead.
    const env = { PATH: join(workspace, "no-bin") };

    const fresh = new JobManager({ workspace, env });
    fresh.reload();
    assert.equal(
      (await fresh.detail(jobId)).status,
      "running",
      "fresh on-disk activity is the liveness verdict; the scheduler is never needed",
    );

    const strict = new JobManager({ workspace, env, slurmActivityFreshnessMs: 0 });
    strict.reload();
    assert.equal(
      (await strict.detail(jobId)).status,
      "orphaned",
      "with the freshness shortcut disabled, the (unreachable) scheduler decides",
    );
  } finally {
    await removeWorkspace(workspace);
  }
});

test("interrupted jobs resume manually from their last checkpoint", async () => {
  const workspace = tempRoot();
  const marker = join(workspace, "interrupted-resume-marker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  writeFileSync(
    fakeCli,
    `import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(${JSON.stringify(marker)}, args[0] + "\\n");
const checkpointPath = path.join(value("--session-root"), value("--run-id"), "checkpoint.json");
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
checkpoint.status = "completed"; checkpoint.output = { resumed: true };
checkpoint.seq += 1; checkpoint.updatedAt = Date.now();
fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
`,
  );
  const now = Date.now();
  const manager = new JobManager({ workspace, workerPath: fakeCli, now: () => now });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    llm: { provider: "offline" },
    creditRecovery: {
      autoResume: true,
      safetyBufferSeconds: 60,
      openRouterModel: "openrouter/free",
    },
  });
  const jobId = "interrupted-job";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "interrupted by a SLURM timeout",
      status: "running",
      runner: "local",
      pid: 999_999_999, // long dead
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "running", // crashed mid-run: journal intact, process gone
      input: {},
      journal: [],
      pendingGates: [],
      seq: 5,
      updatedAt: now - 30_000,
    }),
  );
  manager.reload();
  assert.equal((await manager.detail(jobId)).status, "orphaned");

  assert.equal(await manager.resumeInterrupted(jobId), "queued");
  await waitUntil(() => existsSync(marker), 5_000);
  assert.equal(readFileSync(marker, "utf8"), "resume\n");
  const record = JSON.parse(
    readFileSync(join(jobDir, "job.json"), "utf8"),
  ) as {
    submissionCount: number;
    interruptedResume?: { count: number; checkpointSeq?: number };
  };
  assert.equal(record.submissionCount, 2);
  assert.equal(record.interruptedResume?.count, 1);
  assert.equal(record.interruptedResume?.checkpointSeq, 5);
  assert.ok(
    existsSync(join(jobDir, "submit-interrupted-resume-1.sh")),
    "the resubmission script is kept beside the job",
  );
  await waitUntil(() => {
    try {
      return (
        (JSON.parse(
          readFileSync(join(sessionDir, "checkpoint.json"), "utf8"),
        ) as { status: string }).status === "completed"
      );
    } catch {
      return false;
    }
  }, 5_000);
  assert.equal((await manager.detail(jobId)).status, "completed");
  // A finished job is no longer interrupted.
  await assert.rejects(manager.resumeInterrupted(jobId), /not interrupted/);
  rmSync(workspace, { recursive: true, force: true });
});

test("a resubmission ends the host the record still names, before submitting the next", async () => {
  // The live failure: a worker failed, hung, and kept its SLURM job RUNNING.
  // The submitter then continued the run from its checkpoint, the record's
  // slurmJobId was overwritten with the new host, and the previous one — still
  // alive, now unreferenced — ran the same session directory alongside it.
  // Whatever the record's status says, the id it carries has to be ended first.
  const workspace = tempRoot();
  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  const trace = join(workspace, "scheduler-trace.txt");
  // Both stubs append to ONE file, so the ORDER is what the test reads.
  writeFileSync(
    join(bin, "scancel"),
    "#!/usr/bin/env bash\nprintf 'scancel %s\\n' \"$*\" >> \"$TRACE\"\n",
  );
  writeFileSync(
    join(bin, "sbatch"),
    "#!/usr/bin/env bash\nprintf 'sbatch\\n' >> \"$TRACE\"\necho 'Submitted batch job 222'\n",
  );
  // A failed record is reconciled before the retry; the scheduler must answer
  // that the old job is no longer listed, exactly as a real queue would once
  // it has been cancelled.
  for (const name of ["squeue", "sacct"]) {
    writeFileSync(join(bin, name), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  chmodSync(join(bin, "scancel"), 0o755);
  chmodSync(join(bin, "sbatch"), 0o755);
  const now = Date.now();
  const manager = new JobManager({
    workspace,
    workerPath: join(workspace, "unused.mjs"),
    now: () => now,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TRACE: trace },
  });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "slurm",
    llm: { provider: "offline" },
  });
  const jobId = "double-host";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "a worker that failed and then hung",
      status: "failed",
      runner: "slurm",
      slurmJobId: "111",
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "failed",
      input: {},
      journal: [
        { key: "brainstorm-root/process-input::result", kind: "agent", value: { status: "ok", output: {} } },
      ],
      pendingGates: [],
      error: { name: "AgentTaskFailedError", message: "[resource_exhausted] Error" },
      seq: 9,
      updatedAt: now - 30_000,
    }),
  );
  manager.reload();
  try {
    assert.equal(await manager.retryFailed(jobId), "queued");
    const lines = readFileSync(trace, "utf8").trim().split("\n");
    assert.match(lines[0] ?? "", /^scancel .*111/, "the previous host is cancelled FIRST");
    assert.equal(lines[1], "sbatch", "and only then is the next one submitted");
    const record = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
      slurmJobId?: string;
    };
    assert.equal(record.slurmJobId, "222", "the record now names the new host alone");
  } finally {
    await removeWorkspace(workspace);
  }
});

test("failed jobs retry from their last checkpoint and re-run only the failed task", async () => {
  const workspace = tempRoot();
  const marker = join(workspace, "failed-retry-marker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  // The retried worker resumes and finishes: journal replay re-executed the
  // failed task; here it simply rewrites the checkpoint to completed.
  writeFileSync(
    fakeCli,
    `import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(${JSON.stringify(marker)}, args[0] + "\\n");
const checkpointPath = path.join(value("--session-root"), value("--run-id"), "checkpoint.json");
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
checkpoint.status = "completed"; checkpoint.output = { retried: true }; delete checkpoint.error;
checkpoint.seq += 1; checkpoint.updatedAt = Date.now();
fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
`,
  );
  const now = Date.now();
  const manager = new JobManager({ workspace, workerPath: fakeCli, now: () => now });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    llm: { provider: "offline" },
    creditRecovery: {
      autoResume: true,
      safetyBufferSeconds: 60,
      openRouterModel: "openrouter/free",
    },
  });
  const jobId = "failed-job";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "one commentor subprocess crashed overnight",
      status: "failed",
      runner: "local",
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "failed",
      input: {},
      journal: [{ key: "brainstorm-root/process-input::result", kind: "agent", value: { status: "ok", output: {} } }],
      pendingGates: [],
      error: { name: "AgentTaskFailedError", message: "Claude Code process exited with code 1" },
      seq: 9,
      updatedAt: now - 30_000,
    }),
  );
  // A second failed job with no checkpoint at all: nothing ran, nothing to resume.
  const bareId = "failed-before-checkpoint";
  mkdirSync(join(workspace, "workspace", "jobs", bareId), { recursive: true });
  writeFileSync(
    join(workspace, "workspace", "jobs", bareId, "job.json"),
    JSON.stringify({
      jobId: bareId,
      topic: "failed at submission",
      status: "failed",
      error: "sbatch failed",
      runner: "local",
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  manager.reload();
  assert.equal((await manager.detail(jobId)).status, "failed");

  assert.equal(await manager.retryFailed(jobId), "queued");
  await waitUntil(() => existsSync(marker), 5_000);
  assert.equal(readFileSync(marker, "utf8"), "resume\n", "the retry resumes, never restarts");
  const record = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
    submissionCount: number;
    error?: string;
  };
  assert.equal(record.submissionCount, 2);
  assert.equal(record.error, undefined, "the stale failure is cleared on retry");
  assert.ok(
    existsSync(join(jobDir, "submit-retry-1.sh")),
    "the retry script is kept beside the job",
  );
  await waitUntil(() => {
    try {
      return (
        (JSON.parse(
          readFileSync(join(sessionDir, "checkpoint.json"), "utf8"),
        ) as { status: string }).status === "completed"
      );
    } catch {
      return false;
    }
  }, 5_000);
  assert.equal((await manager.detail(jobId)).status, "completed");
  // A finished job is no longer retryable, and a checkpoint-less failure never is.
  await assert.rejects(manager.retryFailed(jobId), /not failed/);
  await assert.rejects(manager.retryFailed(bareId), /before its first checkpoint/);
  rmSync(workspace, { recursive: true, force: true });
});

test("interrupted auto-resume scans resubmit orphans and pause after stalled attempts", async () => {
  const workspace = tempRoot();
  const marker = join(workspace, "auto-resume-marker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  // This worker dies without touching the checkpoint: no progress is ever made.
  writeFileSync(
    fakeCli,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2)[0] + "\\n");
`,
  );
  let clock = Date.now();
  const manager = new JobManager({ workspace, workerPath: fakeCli, now: () => clock });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    llm: { provider: "offline" },
    creditRecovery: {
      autoResume: true,
      safetyBufferSeconds: 60,
      openRouterModel: "openrouter/free",
    },
  });
  const jobId = "stalled-job";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "keeps dying before any checkpoint progress",
      status: "running",
      runner: "local",
      pid: 999_999_999,
      createdAt: clock - 60_000,
      updatedAt: clock - 30_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "running",
      input: {},
      journal: [],
      pendingGates: [],
      seq: 5,
      updatedAt: clock - 30_000,
    }),
  );
  manager.reload();

  const markerLines = (): number =>
    existsSync(marker)
      ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length
      : 0;

  // The spawned script may briefly still be alive when a scan runs (the scan
  // then correctly sees a live process and skips); keep scanning until the
  // resubmission lands.
  const scanUntilMarker = async (target: number): Promise<void> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      await manager.resumeInterruptedJobs();
      if (markerLines() >= target) return;
      if (Date.now() > deadline) {
        throw new Error(`resubmission ${target} never happened`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await scanUntilMarker(attempt);
    clock += 61_000; // past the resubmission quiet window
  }

  // Further scans pause instead of resubmitting: three attempts, no progress.
  await (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      await manager.resumeInterruptedJobs();
      const record = JSON.parse(
        readFileSync(join(jobDir, "job.json"), "utf8"),
      ) as { warnings?: string[] };
      if (record.warnings?.some((warning) => warning.includes("resume paused"))) {
        return;
      }
      if (Date.now() > deadline) throw new Error("the pause warning never appeared");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  assert.equal(markerLines(), 3);

  // An explicit manual resume overrides the guard and resets the counter.
  assert.equal(await manager.resumeInterrupted(jobId), "queued");
  await waitUntil(() => markerLines() === 4, 5_000);
  const reset = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
    interruptedResume?: { count: number };
  };
  assert.equal(reset.interruptedResume?.count, 1);
  rmSync(workspace, { recursive: true, force: true });
});

test("unattended gates auto-approve after the countdown unless held", async () => {
  const workspace = tempRoot();
  const marker = join(workspace, "gate-auto-marker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  writeFileSync(
    fakeCli,
    `import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(${JSON.stringify(marker)}, args.join(" ") + "\\n");
const checkpointPath = path.join(value("--session-root"), value("--run-id"), "checkpoint.json");
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
checkpoint.status = "completed"; checkpoint.output = { resumed: true };
checkpoint.pendingGates = []; checkpoint.seq += 1; checkpoint.updatedAt = Date.now();
fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
`,
  );
  let clock = Date.now();
  const manager = new JobManager({
    workspace,
    workerPath: fakeCli,
    now: () => clock,
    // This test drives arming/firing directly; the post-start handover
    // grace is covered by its own test.
    gateAutoApproveGraceMs: 0,
  });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    panelConfirmation: "manual",
    llm: { provider: "offline" },
  });
  const fabricate = (jobId: string) => {
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const sessionDir = join(workspace, "workspace", "sessions", jobId);
    mkdirSync(jobDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(jobDir, "job.json"),
      JSON.stringify({
        jobId,
        topic: "suspended on the panel gate",
        status: "running",
        runner: "local",
        pid: 999_999_999,
        createdAt: clock - 60_000,
        updatedAt: clock - 30_000,
        submissionCount: 1,
        executionSettings: settings,
      }),
    );
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: jobId,
        workflowId: "brainstorm",
        status: "suspended",
        input: {},
        journal: [],
        pendingGates: [
          {
            gateKey: "confirm-panel",
            journalKey:
              "brainstorm-root/confirm-panel/confirm-panel-wait::response",
            path: "brainstorm-root/confirm-panel/confirm-panel-wait",
            prompt: "Review the seated panel.",
            metadata: { title: "Confirm the panel" },
          },
        ],
        seq: 5,
        updatedAt: clock - 30_000,
      }),
    );
    return { jobDir, sessionDir };
  };
  const auto = fabricate("gate-auto");
  const held = fabricate("gate-held");
  manager.reload();

  // The first scan only ARMS the countdown (30s from first observation).
  await manager.autoApproveDueGates();
  const armed = await manager.detail("gate-auto");
  assert.equal(armed.status, "suspended");
  assert.equal(armed.pendingGate?.autoApprove?.held, false);
  assert.equal(armed.pendingGate?.autoApprove?.totalMs, 30_000);
  assert.equal(armed.pendingGate?.autoApprove?.deadlineAt, clock + 30_000);

  // A user interaction holds one gate permanently.
  const afterHold = await manager.holdGateAutoApprove("gate-held");
  assert.equal(afterHold.pendingGate?.autoApprove?.held, true);

  // Past the deadline: the unattended gate approves as seated, the held one
  // stays suspended forever.
  clock += 31_000;
  await manager.autoApproveDueGates();
  await waitUntil(() => {
    try {
      return (
        (JSON.parse(
          readFileSync(join(auto.sessionDir, "checkpoint.json"), "utf8"),
        ) as { status: string }).status === "completed"
      );
    } catch {
      return false;
    }
  }, 5_000);
  assert.match(
    readFileSync(marker, "utf8"),
    /resume .*--gate confirm-panel=approve/,
    "the auto-approval resumes with a plain approve answer",
  );
  // An answered gate now carries the same in-flight claim every other resume
  // does, so the job reads "queued" until its worker's own checkpoint postdates
  // the claim. That claim is the whole point: without it the still-suspended
  // checkpoint won the reconcile, the answered gate was re-offered immediately,
  // and the countdown answered it again every 30s for as long as the resume sat
  // in the scheduler queue. Under this test's synthetic clock the claim is
  // stamped in the future relative to the file's real mtime, so it stays queued
  // here; what matters is that the gate is gone and the resume ran exactly once.
  const answered = await manager.detail("gate-auto");
  assert.equal(answered.status, "queued");
  assert.equal(answered.pendingGate, undefined, "the answered gate is not re-offered");
  assert.equal(
    readFileSync(marker, "utf8").split("\n").filter((line) => line.includes("resume")).length,
    1,
    "one countdown expiry submits exactly one resume",
  );
  // A second scan while that submission is in flight must add nothing.
  await manager.autoApproveDueGates();
  assert.equal(
    readFileSync(marker, "utf8").split("\n").filter((line) => line.includes("resume")).length,
    1,
  );

  clock += 31_000;
  await manager.autoApproveDueGates();
  const stillHeld = await manager.detail("gate-held");
  assert.equal(stillHeld.status, "suspended");
  assert.equal(stillHeld.pendingGate?.autoApprove?.held, true);
  assert.ok(
    !readFileSync(marker, "utf8").includes("gate-held"),
    "a held gate never auto-approves",
  );
  rmSync(workspace, { recursive: true, force: true });
});

test("a resumed run is launched with the same attachment store the run had", async () => {
  // The end-to-end half of the manifest fix: not only does the command carry the
  // flag, the script the server actually writes and submits for a resume does.
  // Without it a resumed worker has no attachment roots, deletes the attachment
  // tools, and every agent from there on is told the submission's files cannot
  // be read — which is what a judge reported from a live review.
  const workspace = tempRoot();
  const marker = join(workspace, "resume-args.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  writeFileSync(
    fakeCli,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + "\\n");
`,
  );
  const now = Date.now();
  const manager = new JobManager({ workspace, workerPath: fakeCli, now: () => now });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    llm: { provider: "offline" },
  });
  const jobId = "attachment-resume";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(join(jobDir, "attachments"), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  // The store the server ingested for this job at submission time.
  const manifestPath = join(jobDir, "attachments", "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ baseDir: join(jobDir, "attachments"), attachments: [] }),
  );
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "read the attached project",
      status: "running",
      runner: "local",
      pid: 999_999_999, // long dead, so the job reconciles to orphaned
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "running",
      input: {},
      journal: [],
      pendingGates: [],
      seq: 5,
      updatedAt: now - 30_000,
    }),
  );
  manager.reload();
  assert.equal((await manager.detail(jobId)).status, "orphaned");
  assert.equal(await manager.resumeInterrupted(jobId), "queued");
  const script = readFileSync(
    join(jobDir, "submit-interrupted-resume-1.sh"),
    "utf8",
  );
  assert.match(script, /resume/);
  assert.ok(
    script.includes(`--attachments-manifest '${manifestPath}'`),
    "the resumed worker must be pointed at the job's attachment store",
  );
  await waitUntil(() => existsSync(marker), 5_000);
  assert.ok(
    readFileSync(marker, "utf8").includes("--attachments-manifest"),
    "and the worker must actually receive it",
  );
  rmSync(workspace, { recursive: true, force: true });
});

test("switching the gate countdown off retires the armed deadline and waits forever", async () => {
  const workspace = tempRoot();
  const marker = join(workspace, "gate-switch-marker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  writeFileSync(
    fakeCli,
    `import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(${JSON.stringify(marker)}, args.join(" ") + "\\n");
const checkpointPath = path.join(value("--session-root"), value("--run-id"), "checkpoint.json");
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
checkpoint.status = "completed"; checkpoint.output = { resumed: true };
checkpoint.pendingGates = []; checkpoint.seq += 1; checkpoint.updatedAt = Date.now();
fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
`,
  );
  let clock = Date.now();
  const manager = new JobManager({
    workspace,
    workerPath: fakeCli,
    now: () => clock,
    gateAutoApproveGraceMs: 0,
  });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    panelConfirmation: "manual",
    llm: { provider: "offline" },
  });
  assert.equal(settings.gateAutoApprove, true, "the countdown ships switched on");
  const jobId = "gate-switch";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "nobody may approve this panel but a human",
      status: "running",
      runner: "local",
      pid: 999_999_999,
      createdAt: clock - 60_000,
      updatedAt: clock - 30_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "suspended",
      input: {},
      journal: [],
      pendingGates: [
        {
          gateKey: "confirm-panel",
          journalKey: "brainstorm-root/confirm-panel/confirm-panel-wait::response",
          path: "brainstorm-root/confirm-panel/confirm-panel-wait",
          prompt: "Review the seated panel.",
          metadata: { title: "Confirm the panel" },
        },
      ],
      seq: 5,
      updatedAt: clock - 30_000,
    }),
  );
  manager.reload();

  // With the switch on, the first scan arms the countdown as usual: this is the
  // state the dashboard is already showing a deadline for when the submitter
  // changes their mind.
  await manager.autoApproveDueGates();
  assert.equal(
    (await manager.detail(jobId)).pendingGate?.autoApprove?.deadlineAt,
    clock + 30_000,
  );

  await manager.settings.put({ ...manager.settings.get(), gateAutoApprove: false });
  await manager.autoApproveDueGates();
  const retired = await manager.detail(jobId);
  assert.equal(retired.status, "suspended");
  assert.equal(retired.pendingGate?.gateKey, "confirm-panel");
  assert.equal(
    retired.pendingGate?.autoApprove,
    undefined,
    "the card must stop promising a deadline the server will not act on",
  );
  assert.equal(
    (JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
      gateAutoApprove?: unknown;
    }).gateAutoApprove,
    undefined,
    "the armed marker is deleted from the record, not merely hidden",
  );

  // Well past the deadline that was armed, and past a second full window: an
  // expired marker must not be resurrected by any later scan.
  clock += 31_000;
  await manager.autoApproveDueGates();
  clock += 60_000;
  await manager.autoApproveDueGates();
  assert.equal((await manager.detail(jobId)).status, "suspended");
  assert.equal(
    existsSync(marker),
    false,
    "a switched-off countdown never submits a resume",
  );
  assert.equal(
    (JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
      submissionCount: number;
    }).submissionCount,
    1,
  );

  // Switching it back on arms a FRESH full window rather than firing at once on
  // the deadline that quietly went by while it was off.
  await manager.settings.put({ ...manager.settings.get(), gateAutoApprove: true });
  await manager.autoApproveDueGates();
  const rearmed = await manager.detail(jobId);
  assert.equal(rearmed.status, "suspended");
  assert.equal(rearmed.pendingGate?.autoApprove?.held, false);
  assert.equal(rearmed.pendingGate?.autoApprove?.totalMs, 30_000);
  assert.equal(rearmed.pendingGate?.autoApprove?.deadlineAt, clock + 30_000);
  assert.equal(existsSync(marker), false, "re-arming alone approves nothing");

  clock += 31_000;
  await manager.autoApproveDueGates();
  await waitUntil(() => {
    try {
      return (
        (JSON.parse(
          readFileSync(join(sessionDir, "checkpoint.json"), "utf8"),
        ) as { status: string }).status === "completed"
      );
    } catch {
      return false;
    }
  }, 5_000);
  assert.match(
    readFileSync(marker, "utf8"),
    /resume .*--gate confirm-panel=approve/,
    "the re-armed countdown approves the panel as seated",
  );
  // "queued", not "completed": answering a gate now claims the job as having a
  // submission in flight, and under this test's synthetic clock that claim is
  // stamped ahead of the checkpoint file's real mtime. The gate is answered and
  // gone, which is what the countdown was for.
  const approved = await manager.detail(jobId);
  assert.equal(approved.status, "queued");
  assert.equal(approved.pendingGate, undefined);
  rmSync(workspace, { recursive: true, force: true });
});

test("the gate countdown switch is read live, never from the job's snapshot", async () => {
  // A run submitted while the countdown was on carries `gateAutoApprove: true`
  // in its execution settings forever, and every resume replays that snapshot.
  // The countdown itself must NOT come from there: switching it off is the
  // submitter saying no gate may pass without them, including in runs that are
  // already in flight and have not yet reached their next gate.
  const workspace = tempRoot();
  const marker = join(workspace, "gate-live-marker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  // The run-mode worker parks the run on the panel gate, exactly as a real
  // manual-confirmation run does, and logs every invocation so a resume this
  // test forbids would leave evidence.
  writeFileSync(
    fakeCli,
    `import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
fs.appendFileSync(${JSON.stringify(marker)}, args.join(" ") + "\\n");
if (args[0] !== "run") process.exit(0);
const runId = value("--run-id");
const runDir = path.join(value("--session-root"), runId);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, "checkpoint.json"), JSON.stringify({
  runId,
  workflowId: "brainstorm",
  status: "suspended",
  input: {},
  journal: [],
  pendingGates: [{
    gateKey: "confirm-panel",
    journalKey: "brainstorm-root/confirm-panel/confirm-panel-wait::response",
    path: "brainstorm-root/confirm-panel/confirm-panel-wait",
    prompt: "Review the seated panel.",
    metadata: { title: "Confirm the panel" },
  }],
  seq: 3,
  updatedAt: Date.now(),
}, null, 2));
`,
  );
  let clock = Date.now();
  const manager = new JobManager({
    workspace,
    workerPath: fakeCli,
    now: () => clock,
    gateAutoApproveGraceMs: 0,
  });
  await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    panelConfirmation: "manual",
    llm: { provider: "offline" },
  });
  const jobId = await manager.submit("submitted while the countdown was on");
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  await waitUntil(() => {
    try {
      return (
        (JSON.parse(
          readFileSync(join(sessionDir, "checkpoint.json"), "utf8"),
        ) as { status: string }).status === "suspended"
      );
    } catch {
      return false;
    }
  }, 10_000);
  const snapshot = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
    executionSettings?: { gateAutoApprove?: boolean };
  };
  assert.equal(
    snapshot.executionSettings?.gateAutoApprove,
    true,
    "the run's own settings snapshot recorded the countdown as on",
  );

  await manager.settings.put({ ...manager.settings.get(), gateAutoApprove: false });
  clock += 31_000;
  await manager.autoApproveDueGates();
  clock += 31_000;
  await manager.autoApproveDueGates();
  const detail = await manager.detail(jobId);
  assert.equal(detail.status, "suspended");
  assert.equal(detail.pendingGate?.gateKey, "confirm-panel");
  assert.equal(detail.pendingGate?.autoApprove, undefined);
  assert.equal(
    readFileSync(marker, "utf8").includes("resume"),
    false,
    "the in-flight run's snapshot must not out-vote the live switch",
  );
  const record = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
    submissionCount: number;
    executionSettings?: { gateAutoApprove?: boolean };
  };
  assert.equal(record.submissionCount, 1);
  assert.equal(
    record.executionSettings?.gateAutoApprove,
    true,
    "the snapshot is left alone; only the live read changed the outcome",
  );
  rmSync(workspace, { recursive: true, force: true });
});

test("a per-section settings save keeps every other section and re-verifies nothing", async () => {
  // The reported bug: every save verified the model connection, so changing
  // the review-round budget re-tested the Claude setup token — seconds of
  // waiting, and then a "token verified" notice about an edit nobody made.
  const workspace = tempRoot();
  const attempts: Array<{ token: string; model?: string }> = [];
  // Verification is FORBIDDEN once the connection stands. A validator that
  // throws turns a stray re-verification into a failed PUT that names itself,
  // rather than a bare count mismatch at the end of the test.
  let forbidden = false;
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    validateClaudeAgent: async (input) => {
      if (forbidden) {
        throw new Error("re-verified a connection that did not change");
      }
      attempts.push(input);
    },
    // The readiness llm check drives the SAME validator on its own schedule,
    // so it is stubbed out here: this test counts what the SAVES verify.
    readinessProbes: { llm: async () => ({ message: "stubbed" }) },
    readinessAdvisor: null,
  });
  try {
    // One full save establishes the connection and every neighbouring section.
    const connected = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        llm: {
          provider: "claude-agent",
          model: "sonnet",
          setupToken: "verified-setup-token",
          agentSdk: { maxTurns: 12, effort: "high", thinking: "adaptive" },
        },
        hostTools: { enabledToolIds: ["taxonomy_tree"] },
        updateCheck: "off",
        creditRecovery: {
          autoResume: false,
          safetyBufferSeconds: 90,
          openRouterModel: "openrouter/keep-me",
        },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(connected.status, 200);
    assert.equal(connected.value.llm.setupTokenConfigured, true);
    assert.equal(attempts.length, 1, "establishing the connection verifies it once");

    forbidden = true;
    const patched = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        review: { maxRounds: 7 },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(patched.status, 200);
    assert.equal(attempts.length, 1, "a review-budget patch verifies nothing at all");
    // The budget is the ONLY difference between the two documents. An absent
    // section used to RESET rather than keep, so this is the assertion that one
    // panel of the drawer cannot wipe what another panel holds: the connection,
    // its agentSdk knobs, the host tools, the update policy and the
    // credit-recovery policy all survive a save that never mentioned them.
    assert.deepEqual(patched.value, { ...connected.value, review: { maxRounds: 7 } });

    // The same holds section by section, in either direction.
    const tools = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        hostTools: { enabledToolIds: ["taxonomy_tree", "attachment_list"] },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(tools.status, 200);
    assert.deepEqual(tools.value, {
      ...patched.value,
      hostTools: { enabledToolIds: ["taxonomy_tree", "attachment_list"] },
    });
    assert.equal(attempts.length, 1, "no save but the connecting one verified");

    // Served from disk, not echoed back: a patch that kept a section only in
    // the response would lose it on the next read.
    const reread = await requestJson<ServerSettings>(server, "/api/settings");
    assert.deepEqual(reread.value, tools.value);
    const stored = JSON.parse(
      readFileSync(join(workspace, "settings.json"), "utf8"),
    ) as ServerSettings;
    assert.equal(stored.review?.maxRounds, 7);
    assert.equal(stored.llm.model, "sonnet");
    assert.equal(stored.llm.agentSdk?.maxTurns, 12);
    assert.equal(stored.creditRecovery.openRouterModel, "openrouter/keep-me");
    assert.equal(stored.updateCheck, "off");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("the usage receipt separates calls that were refused from calls that worked", async () => {
  // A run whose every attachment read was denied reported the same tool-call
  // counts as one that read them all, because the outcome lived only inside the
  // human-readable message. The dashboard therefore suggested the files had been
  // read. The refusal is now a field, and it is counted apart.
  const workspace = tempRoot();
  const jobDir = join(workspace, "job");
  mkdirSync(jobDir, { recursive: true });
  const event = (progress: Record<string, unknown>): string =>
    `${JSON.stringify({
      type: "agent:progress",
      runId: "usage",
      seq: 1,
      at: Date.now(),
      path: "brainstorm-root/review-members/member[0]/cotStep[0]/judge-step",
      taskId: "usage:judge",
      taskKind: "brainstorm.judge",
      progress,
    })}\n`;
  writeFileSync(
    join(jobDir, "events.jsonl"),
    [
      event({ kind: "tool_end", toolName: "Read", message: "read a file", failed: true }),
      event({ kind: "tool_end", toolName: "Read", message: "read a file", failed: true }),
      event({ kind: "tool_end", toolName: "Read", message: "read a file" }),
      event({ kind: "tool_end", toolName: "Bash", message: "ran a script" }),
    ].join(""),
  );

  const report = aggregateToolUsage(jobDir);
  // Every call still counts as a call — the agent did spend a turn on it.
  assert.equal(report.totals.Read, 3);
  assert.equal(report.totals.Bash, 1);
  // And the two that came back with nothing are legible as such.
  assert.equal(report.failures.Read, 2);
  assert.equal(report.failures.Bash, undefined, "a tool with no failures has no entry");
  assert.equal(report.byRole.judge?.Read, 3);
  rmSync(workspace, { recursive: true, force: true });
});

test("switching telemetry off survives the save and reaches the worker", async () => {
  // The flag was validated and then dropped from the persisted document, so
  // opting out appeared to work and was forgotten on the next read. It also
  // never reached the worker, which gates on BRAINSTORM_AGENTIC_TELEMETRY: the
  // records were still written into the spool and merely withheld from sending,
  // where the contract is that opting out produces no record at all.
  const workspace = tempRoot();
  const store = new SettingsStore(workspace, {
    validateAnthropic: async () => undefined,
  });
  const enabled = await store.put({
    ...store.get(),
    llm: { provider: "offline" },
  });
  assert.equal(enabled.telemetry?.enabled, true, "reporting is on by default");
  assert.equal(
    store.executionEnvironment({}, enabled).BRAINSTORM_AGENTIC_TELEMETRY,
    undefined,
    "an opted-in run says nothing, so the worker's default applies",
  );

  const off = await store.put({ telemetry: { enabled: false } });
  assert.equal(off.telemetry?.enabled, false);
  // Read back from disk, not echoed: this is the assertion the bug failed.
  assert.equal(new SettingsStore(workspace).get().telemetry?.enabled, false);
  const stored = JSON.parse(
    readFileSync(join(workspace, "settings.json"), "utf8"),
  ) as { telemetry?: { enabled?: boolean; ingestUrl?: string } };
  assert.equal(stored.telemetry?.enabled, false);
  // The ingest destination is deployment-owned and recomputed on every read, so
  // persisting it could only go stale.
  assert.equal(stored.telemetry?.ingestUrl, undefined);
  assert.equal(
    store.executionEnvironment({}, off).BRAINSTORM_AGENTIC_TELEMETRY,
    "off",
    "the worker must know, or it writes a record nobody asked for",
  );

  // And back on again, so the opt-out is a switch rather than a one-way door.
  const again = await store.put({ telemetry: { enabled: true } });
  assert.equal(again.telemetry?.enabled, true);
  assert.equal(
    store.executionEnvironment({}, again).BRAINSTORM_AGENTIC_TELEMETRY,
    undefined,
  );
  await removeWorkspace(workspace);
});

test("a new credential and a changed model each re-verify the connection for real", async () => {
  // The other half of the rule: skipping verification must never skip it for a
  // change verification is the whole point of. A submitted secret is unproven
  // until the provider answers, and a different model can be one the account
  // cannot reach at all.
  const workspace = tempRoot();
  const attempts: Array<{ token: string; model?: string }> = [];
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    validateClaudeAgent: async (input) => {
      attempts.push(input);
      if (input.model === "unreachable") throw new Error("model not available");
    },
    readinessProbes: { llm: async () => ({ message: "stubbed" }) },
    readinessAdvisor: null,
  });
  try {
    const connected = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        llm: {
          provider: "claude-agent",
          model: "sonnet",
          setupToken: "first-token",
        },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(connected.status, 200);
    assert.deepEqual(attempts, [{ token: "first-token", model: "sonnet" }]);

    // A freshly submitted secret is verified even though nothing else moved.
    const rekeyed = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        llm: {
          provider: "claude-agent",
          model: "sonnet",
          setupToken: "second-token",
        },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(rekeyed.status, 200);
    assert.deepEqual(attempts[1], { token: "second-token", model: "sonnet" });

    // A changed model is verified against the STORED credential — the patch
    // carries no secret, so this only works if the verification reads the one
    // on disk.
    const remodelled = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        llm: { provider: "claude-agent", model: "opus" },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(remodelled.status, 200);
    assert.equal(remodelled.value.llm.model, "opus");
    assert.deepEqual(attempts[2], { token: "second-token", model: "opus" });

    // And a model the account cannot reach is rejected before anything is
    // persisted, exactly as an unverifiable credential is.
    const rejected = await requestJson<{ message: string }>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        llm: { provider: "claude-agent", model: "unreachable" },
      } satisfies ServerSettingsUpdate),
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.value.message, /model not available/);
    assert.equal(attempts.length, 4);
    const after = (await requestJson<ServerSettings>(server, "/api/settings")).value;
    assert.equal(after.llm.model, "opus", "the refused model was never stored");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("POST /api/jobs/:id/dismiss-member stops one seat and resumes the rest", async () => {
  const workspace = tempRoot();
  const marker = join(workspace, "dismiss-worker.txt");
  const fakeCli = join(workspace, "fake-cli.mjs");
  // The resubmitted worker records the argv it was given and leaves the
  // checkpoint exactly as it found it, so the run stays resumable throughout.
  writeFileSync(
    fakeCli,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + "\\n");
`,
  );
  const server = await startTestBrainServer({
    workspace,
    port: 0,
    workerPath: fakeCli,
  });
  try {
    await putSettings(server, {
      runner: "local",
      llm: { provider: "offline" },
      // The orphan scan would resubmit this manufactured run on its own tick
      // and race every assertion below. Here the dismissal is the only thing
      // allowed to resubmit.
      interruptedRecovery: { autoResume: false },
    });
    const settings = (await requestJson<ServerSettings>(server, "/api/settings")).value;

    // A run interrupted mid-flight with a seated panel of four: its worker is
    // long gone, its checkpoint is intact, and it is still resumable — the
    // state a submitter actually dismisses a seat from.
    const jobId = "dismiss-job";
    const jobDir = join(workspace, "workspace", "jobs", jobId);
    const sessionDir = join(workspace, "workspace", "sessions", jobId);
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "job.json"),
      JSON.stringify({
        jobId,
        topic: "one seat is off the rails",
        status: "running",
        runner: "local",
        pid: 999_999_999, // long dead
        createdAt: 1,
        updatedAt: 2,
        submissionCount: 1,
        executionSettings: settings,
      }),
    );
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: jobId,
        workflowId: "brainstorm",
        status: "running",
        input: {},
        journal: [],
        pendingGates: [],
        seq: 5,
        updatedAt: 3,
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "index.json"),
      JSON.stringify({
        refs: [{ id: "a-panel", metadata: { schema: "panel", path: "panel" } }],
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "a-panel"),
      JSON.stringify({
        members: [1, 2, 3, 4].map((n) => ({
          id: `member-${n}`,
          department: "Physics",
          umbrella: `Umbrella ${n}`,
          subfields: [],
        })),
      }),
    );
    server.manager.reload();

    const dismiss = (id: string, body: unknown) =>
      requestJson<JobDetail & { message?: string }>(
        server,
        `/api/jobs/${id}/dismiss-member`,
        { method: "POST", body: JSON.stringify(body) },
      );

    assert.equal((await dismiss("no-such-job", { memberId: "member-1" })).status, 404);
    assert.equal((await dismiss(jobId, {})).status, 400);
    // A seat that is not on this run's roster is a conflict, not a silent
    // no-op: the id came from somewhere, and dismissing nothing would look
    // like success in the dashboard.
    const stranger = await dismiss(jobId, { memberId: "member-9" });
    assert.equal(stranger.status, 409);
    assert.match(stranger.value.message!, /not a seat of job/);

    const dismissed = await dismiss(jobId, { memberId: "member-4" });
    assert.equal(dismissed.status, 200);
    assert.deepEqual(
      dismissed.value.dismissedMembers?.map((entry) => entry.memberId),
      ["member-4"],
    );
    assert.equal(dismissed.value.dismissedMembers?.[0]?.label, "Umbrella 4");
    // The run continues. Stopping the worker is how the dismissal reaches a
    // process that has no channel to be told anything — it must never be
    // mistaken for cancelling the run.
    assert.notEqual(dismissed.value.status, "cancelled");
    await waitUntil(() => existsSync(marker), 5_000);
    const first = readFileSync(join(jobDir, "submit-dismiss-1.sh"), "utf8");
    assert.match(first, /--dismissed-members 'member-4'/);
    assert.match(first, /fake-cli\.mjs' resume/, "the run resumes, never restarts");

    // Idempotent: a double click, or a retry of a request whose response was
    // lost, must not stop and resubmit the run a second time.
    const again = await dismiss(jobId, { memberId: "member-4" });
    assert.equal(again.status, 200);
    assert.deepEqual(
      again.value.dismissedMembers?.map((entry) => entry.memberId),
      ["member-4"],
    );
    assert.deepEqual(
      readdirSync(jobDir).filter((name) => name.startsWith("submit-dismiss")),
      ["submit-dismiss-1.sh"],
      "the second identical call submits nothing",
    );

    // A second dismissal carries the FULL accumulated list as one
    // comma-joined value: the worker parses flags into a map, so a repeated
    // flag would keep only the last id and put the earlier seat back to work.
    const second = await dismiss(jobId, { memberId: "member-3" });
    assert.equal(second.status, 200);
    assert.deepEqual(
      second.value.dismissedMembers?.map((entry) => entry.memberId),
      ["member-4", "member-3"],
    );
    assert.match(
      readFileSync(join(jobDir, "submit-dismiss-2.sh"), "utf8"),
      /--dismissed-members 'member-4,member-3'/,
    );

    // The floor the confirmation gate enforces holds here too: below two seats
    // there is no panel left to review anything.
    const tooFew = await dismiss(jobId, { memberId: "member-2" });
    assert.equal(tooFew.status, 409);
    assert.match(tooFew.value.message!, /at least 2 seats/);
    const record = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
      dismissedMembers?: string[];
      dismissedAt?: Record<string, number>;
      submissionCount: number;
      status: string;
    };
    assert.deepEqual(record.dismissedMembers, ["member-4", "member-3"]);
    assert.deepEqual(Object.keys(record.dismissedAt ?? {}), ["member-4", "member-3"]);
    assert.equal(record.submissionCount, 3, "two dismissals, two resubmissions");
    assert.notEqual(record.status, "cancelled");
  } finally {
    await server.close();
    await removeWorkspace(workspace);
  }
});

test("a paused run stops its worker and is left alone until the submitter resumes it", async () => {
  // The whole risk of a pause: on disk it is indistinguishable from an
  // interrupted run — worker gone, checkpoint still "running" — and the poller
  // exists to resubmit exactly those. If it cannot tell the difference, the
  // pause button starts the run again a moment after stopping it.
  const workspace = tempRoot();
  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  const trace = join(workspace, "scheduler-trace.txt");
  writeFileSync(
    join(bin, "scancel"),
    "#!/usr/bin/env bash\nprintf 'scancel %s\\n' \"$*\" >> \"$TRACE\"\n",
  );
  writeFileSync(
    join(bin, "sbatch"),
    "#!/usr/bin/env bash\nprintf 'sbatch\\n' >> \"$TRACE\"\necho 'Submitted batch job 900'\n",
  );
  for (const name of ["squeue", "sacct"]) {
    writeFileSync(join(bin, name), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  chmodSync(join(bin, "scancel"), 0o755);
  chmodSync(join(bin, "sbatch"), 0o755);
  const now = Date.now();
  const manager = new JobManager({
    workspace,
    workerPath: join(workspace, "unused.mjs"),
    now: () => now,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TRACE: trace },
  });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "slurm",
    llm: { provider: "offline" },
  });
  const jobId = "pausable";
  const jobDir = join(workspace, "workspace", "jobs", jobId);
  const sessionDir = join(workspace, "workspace", "sessions", jobId);
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(jobDir, "job.json"),
    JSON.stringify({
      jobId,
      topic: "a run the submitter wants to stop for a while",
      status: "running",
      runner: "slurm",
      slurmJobId: "800",
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      submissionCount: 1,
      executionSettings: settings,
    }),
  );
  // A checkpoint that says "running" — the shape an interrupted run also has.
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId: jobId,
      workflowId: "brainstorm",
      status: "running",
      input: {},
      journal: [
        { key: "brainstorm-root/process-input::result", kind: "agent", value: { status: "ok", output: {} } },
      ],
      pendingGates: [],
      seq: 4,
      updatedAt: now - 30_000,
    }),
  );
  manager.reload();
  try {
    assert.equal(await manager.pause(jobId), "paused");
    assert.match(
      readFileSync(trace, "utf8"),
      /^scancel .*800/m,
      "the worker is ended, not merely marked",
    );

    // The two automatic paths must both leave it alone.
    await manager.resumeInterruptedJobs();
    await manager.resumeDueCreditBlocks();
    assert.equal(
      (readFileSync(trace, "utf8").match(/sbatch/g) ?? []).length,
      0,
      "nothing resubmitted the run behind the submitter",
    );
    assert.equal((await manager.detail(jobId)).status, "paused", "and it stayed paused");

    // Resuming is the submitter's call, and it goes through the ordinary
    // submission — so the previous host is reaped first.
    assert.equal(await manager.resumePaused(jobId), "queued");
    const lines = readFileSync(trace, "utf8").trim().split("\n");
    assert.equal(lines[lines.length - 1], "sbatch", "the resume submits");
    const record = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8")) as {
      slurmJobId?: string;
      pausedAt?: number;
      submissionCount?: number;
    };
    assert.equal(record.slurmJobId, "900", "the record names the new host");
    assert.equal(record.pausedAt, undefined, "and no longer looks paused");
    assert.equal(record.submissionCount, 2);
  } finally {
    await removeWorkspace(workspace);
  }
});

test("a stopped run streams no live text, and its readers are told so", async () => {
  // The channel exists to show what an agent is saying WHILE it says it. Once
  // the worker is gone those sentences are the last words of a process that no
  // longer exists — a reader holding them would keep a thinking box on screen,
  // and a reader arriving later would be handed the whole dead thread as if it
  // were arriving now (the store's own expiry takes two minutes).
  const workspace = tempRoot();
  const now = Date.now();
  const manager = new JobManager({ workspace, now: () => now });
  const jobId = "streaming-job";
  const dir = join(workspace, "workspace", "jobs", jobId);
  mkdirSync(dir, { recursive: true });
  const record = (status: string): void => {
    writeFileSync(
      join(dir, "job.json"),
      JSON.stringify({
        jobId, topic: "a run mid-thought", status, runner: "local",
        createdAt: now - 10_000, updatedAt: now, submissionCount: 1,
        pid: process.pid,
      }),
    );
  };
  record("running");
  writeFileSync(
    join(dir, "live-text.jsonl"),
    JSON.stringify({ p: "brainstorm-root/first-pass/member[0]/develop-idea", t: "weighing two designs" }) + "\n",
  );
  manager.reload();
  try {
    const seen = new Map<string, number>();
    const streaming = await manager.liveText(jobId, seen);
    assert.equal(streaming.length, 1, "a running job streams what its agent is writing");
    assert.match(streaming[0]?.append ?? streaming[0]?.text ?? "", /weighing two designs/);
    assert.equal(seen.size, 1, "the reader is now carrying that thread");

    record("paused");
    manager.reload();
    const stopped = await manager.liveText(jobId, seen);
    assert.deepEqual(
      stopped,
      [{ id: "brainstorm-root/first-pass/member[0]/develop-idea", ended: true }],
      "the pause ends every thread the reader still holds",
    );
    assert.equal(seen.size, 0, "and forgets it, so nothing is re-sent");
    assert.deepEqual(await manager.liveText(jobId, seen), [], "nothing more while it stands still");

    // Resuming puts the channel back exactly as it was.
    record("running");
    manager.reload();
    const again = await manager.liveText(jobId, new Map());
    assert.equal(again.length, 1, "a resumed run streams again");
  } finally {
    await removeWorkspace(workspace);
  }
});

test("a settled run cannot be paused, and a paused one cannot be paused twice", async () => {
  const workspace = tempRoot();
  const now = Date.now();
  const manager = new JobManager({ workspace, workerPath: join(workspace, "x.mjs"), now: () => now });
  const settings = await manager.settings.put({
    ...manager.settings.get(),
    runner: "local",
    llm: { provider: "offline" },
  });
  const make = (jobId: string, status: string) => {
    const dir = join(workspace, "workspace", "jobs", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "job.json"),
      JSON.stringify({
        jobId, topic: jobId, status, runner: "local",
        createdAt: now - 1000, updatedAt: now - 500, submissionCount: 1,
        executionSettings: settings,
      }),
    );
  };
  make("done-job", "completed");
  make("stopped-job", "cancelled");
  make("already-paused", "paused");
  manager.reload();
  try {
    await assert.rejects(manager.pause("done-job"), /cannot be paused/);
    await assert.rejects(manager.pause("stopped-job"), /cannot be paused/);
    await assert.rejects(manager.pause("already-paused"), /cannot be paused/);
    // And resuming something that was never paused is refused rather than
    // quietly submitting a second worker.
    await assert.rejects(manager.resumePaused("done-job"), /not paused/);
  } finally {
    await removeWorkspace(workspace);
  }
});
