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
  GPU_COMMAND_TAG,
  SLURM_COMMAND_TAG,
  type JobDetail,
  type JobSummary,
  type ReadinessReport,
  type ServerSettings,
  type ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";

import {
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

/** The version the registry index publishes as latest — what a new run pins. */
function latestPublishedVersion(): string {
  const index = JSON.parse(
    readFileSync(join(staticRegistryRoot, "index.json"), "utf8"),
  ) as { bundles: Array<{ id: string; latest: string }> };
  return index.bundles.find((bundle) => bundle.id === "brainstorm")!.latest;
}

async function startTestBrainServer(
  options: Omit<StartBrainServerOptions, "contentRegistryUrl" | "contentRegistryStatus">,
): Promise<RunningBrainServer & { readonly registryReads: readonly string[] }> {
  const registry = await startTestRegistry(staticRegistryRoot);
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

    // Health names the bundle and the version a new run starts with (no pin
    // exists, so the effective version IS the latest published one).
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
    assert.equal(health.contentRegistry.bundle, "brainstorm");
    assert.equal(health.contentRegistry.latest, latestPublishedVersion());
    assert.equal(health.contentRegistry.effectiveVersion, latestPublishedVersion());
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
  const registry = await startTestRegistry(staticRegistryRoot);
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
    assert.equal(before.contentRegistry.effectiveVersion, latestPublishedVersion());

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
      appUpdate?: { version: string };
    }>(server, "/api/update-check", { method: "POST", body: "{}" });
    assert.equal(checked.status, 200);
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
    const jobId = await submit(server, "Ride a held pilot");

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
    assert.equal(storedPin.version, latestPublishedVersion());
    assert.match(storedPin.manifestSha256, /^[a-f0-9]{64}$/);
    // The exact skills version this run executed travels on the job itself.
    assert.deepEqual(detail.contentBundle, {
      id: "brainstorm",
      version: latestPublishedVersion(),
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
    assert.ok(
      typeof reviewedRound.cot === "string" && reviewedRound.cot.length > 0,
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

    // Lazy fetching is now observed where it actually happens — the documents
    // the run requested from the registry — rather than through a disk
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
    for (const notReached of ["brain", "commentor", "judge", "chair"]) {
      assert.equal(
        fetched.has(`skills/roles/${notReached}.md`),
        false,
        `${notReached} must not be fetched before its stage is reached`,
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
  assert.equal(firstPass.members[0]?.status, "thinking");
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
  assert.equal((await manager.detail("gate-auto")).status, "completed");
  assert.equal(
    (await manager.detail("gate-auto")).pendingGate,
    undefined,
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
