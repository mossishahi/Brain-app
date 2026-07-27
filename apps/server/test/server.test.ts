import assert from "node:assert/strict";
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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  SLURM_COMMAND_TAG,
  type JobDetail,
  type JobSummary,
  type ServerSettings,
  type ServerSettingsUpdate,
} from "@brainstorm-agentic/protocol";

import {
  buildOrchestrationCommand,
  defaultServerSettings,
  JobManager,
  renderSlurmTemplate,
  SettingsStore,
  shellQuote,
  startBrainServer,
  type RunningBrainServer,
  type StartBrainServerOptions,
} from "../src/index.js";
import { startTestRegistry } from "./mcp-registry.js";

function tempRoot(prefix = "brain-server-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const staticRegistryRoot =
  process.env.BRAIN_TEST_REGISTRY_DIR ??
  fileURLToPath(
    new URL("../../../../../brain/content/", import.meta.url),
  );

async function startTestBrainServer(
  options: Omit<StartBrainServerOptions, "contentRegistryUrl" | "contentRegistryStatus">,
): Promise<RunningBrainServer> {
  const registry = await startTestRegistry(staticRegistryRoot);
  try {
    const server = await startBrainServer({
      ...options,
      contentRegistryUrl: registry.url,
      contentRegistryStatus: { running: true, url: registry.url },
    });
    return {
      ...server,
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
): Promise<string> {
  const response = await requestJson<{ jobId: string }>(server, "/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      topic,
      ...(attachments ? { attachments } : {}),
    }),
  });
  assert.equal(response.status, 200);
  return response.value.jobId;
}

async function waitFor(
  server: RunningBrainServer,
  jobId: string,
  status: string,
  timeoutMs = 60_000,
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
    rmSync(workspace, { recursive: true, force: true });
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
    assert.equal(response.status, 400);
    assert.match(response.value.message, /Configure and verify/);
    const jobs = (
      await requestJson<readonly JobSummary[]>(server, "/api/jobs")
    ).value;
    assert.equal(jobs.length, 0);
  } finally {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
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
    rmSync(workspace, { recursive: true, force: true });
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
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("verified settings populate orchestration environment without exposing the key", async () => {
  const workspace = tempRoot();
  try {
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => undefined,
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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
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
    rmSync(workspace, { recursive: true, force: true });
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
    rmSync(workspace, { recursive: true, force: true });
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
  writeFileSync(sbatch, "#!/usr/bin/env bash\necho 'Submitted batch job 123'\n");
  writeFileSync(
    scancel,
    "#!/usr/bin/env bash\nprintf '%s' \"$1\" > \"$SCANCEL_RECORD\"\n",
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
  });
  try {
    await putSettings(server, { llm: { provider: "offline" } });
    const jobId = await submit(server, "Submit through fake Slurm");
    const stored = JSON.parse(
      readFileSync(join(workspace, "workspace", "jobs", jobId, "job.json"), "utf8"),
    ) as { slurmJobId?: string };
    assert.equal(stored.slurmJobId, "123");
    const cancelled = await requestJson<{ status: string }>(
      server,
      `/api/jobs/${jobId}/cancel`,
      { method: "POST", body: "{}" },
    );
    assert.equal(cancelled.value.status, "cancelled");
    assert.equal(readFileSync(cancelRecord, "utf8"), "123");
  } finally {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
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
    assert.equal(storedPin.version, "0.2.0");
    assert.match(storedPin.manifestSha256, /^[a-f0-9]{64}$/);
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
    rmSync(workspace, { recursive: true, force: true });
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
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("server file picker browses allowlisted roots, validates immediately, and snapshots at launch", async () => {
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
  const canonicalRoot = realpathSync(remoteRoot);
  const canonicalPrototype = realpathSync(prototype);
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
    assert.equal(
      top.value.entries.some(
        (entry) => entry.name === "escape-outside-root",
      ),
      false,
      "symlinks escaping an allowed root are not exposed",
    );
    assert.equal(
      top.value.entries.some(
        (entry) =>
          entry.name.startsWith(".") || entry.name === "node_modules",
      ),
      false,
      "hidden and junk entries are not shown in the picker",
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

    const outside = await requestJson<{
      attachments: { valid: boolean; reason?: string }[];
    }>(server, "/api/attachments/validate", {
      method: "POST",
      body: JSON.stringify({ kind: "file", paths: ["/etc/passwd"] }),
    });
    assert.equal(outside.status, 200);
    assert.equal(outside.value.attachments[0]!.valid, false);
    assert.match(
      outside.value.attachments[0]!.reason ?? "",
      /outside the configured attachment roots/,
    );

    const jobId = await submit(
      server,
      "Analyze this server-resident prototype",
      [canonicalPrototype],
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
    assert.equal(manifest.attachments[0]!.origin, canonicalPrototype);
    assert.ok(
      manifest.attachments[0]!.files.every((file) =>
        file.path.startsWith(join(jobDir, "attachments")),
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
    rmSync(workspace, { recursive: true, force: true });
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
    const suspended = await waitFor(server, jobId, "suspended");
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
    };
    const cacheRoot = join(
      contentDir,
      pin.bundle,
      pin.version,
      pin.manifestSha256,
    );
    assert.ok(existsSync(join(cacheRoot, "skills", "roles", "processor.md")));
    assert.ok(existsSync(join(cacheRoot, "skills", "roles", "decomposer.md")));
    for (const notReached of ["brain", "commentor", "judge", "chair"]) {
      assert.equal(
        existsSync(join(cacheRoot, "skills", "roles", `${notReached}.md`)),
        false,
        `${notReached} must not be fetched before its stage is reached`,
      );
    }
    assert.ok(suspended.pendingGate?.members);
    const original = suspended.pendingGate.members;
    const keep = original.slice(0, 2).map((member) => member.id);
    const answered = await requestJson<JobDetail>(
      server,
      `/api/jobs/${jobId}/gate`,
      {
        method: "POST",
        body: JSON.stringify({
          gateKey: suspended.pendingGate.gateKey,
          action: "shrink",
          members: keep,
        }),
      },
    );
    assert.equal(answered.status, 200);
    const completed = await waitFor(server, jobId, "completed");
    assert.ok(existsSync(join(cacheRoot, "skills", "roles", "chair.md")));
    const confirm = completed.stages[3]!;
    assert.equal(confirm.id, "confirm-panel");
    assert.equal(confirm.id === "confirm-panel" && confirm.gate.state, "shrunk");
    assert.deepEqual(
      confirm.id === "confirm-panel" ? confirm.gate.removedMemberIds : [],
      original.slice(2).map((member) => member.id),
    );

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
    rmSync(workspace, { recursive: true, force: true });
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
    rmSync(workspace, { recursive: true, force: true });
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
