import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContent } from "@brainstorm-agentic/content";

import {
  buildRuntime,
  providerConfigFromEnv,
} from "../src/wiring.js";
import { FsArtifactStore, FsCheckpointStore } from "../src/fs-stores.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "bsa-cli-"));
}

const registryContentDir =
  process.env.BRAIN_TEST_CONTENT_DIR ??
  fileURLToPath(
    new URL(
      "../../../../../brain/content/bundles/brainstorm/0.1.0/",
      import.meta.url,
    ),
  );
const registryBundle = loadContent(registryContentDir);

test("Agent SDK environment settings map to executor configuration", () => {
  const config = providerConfigFromEnv(
    {
      BRAINSTORM_AGENTIC_PROVIDER: "claude-agent",
      CLAUDE_CODE_OAUTH_TOKEN: "setup-token",
      BRAINSTORM_AGENTIC_MODEL: "opus",
      BRAINSTORM_AGENTIC_AGENT_MAX_TURNS: "175",
      BRAINSTORM_AGENTIC_AGENT_MAX_BUDGET_USD: "15.25",
      BRAINSTORM_AGENTIC_AGENT_EFFORT: "xhigh",
      BRAINSTORM_AGENTIC_AGENT_THINKING: "disabled",
      BRAINSTORM_AGENTIC_AGENT_FALLBACK_MODEL: "sonnet",
    },
    false,
  );
  assert.deepEqual(config, {
    provider: "claude-agent",
    defaultModel: "opus",
    setupToken: "setup-token",
    agentSdk: {
      maxTurns: 175,
      maxBudgetUsd: 15.25,
      effort: "xhigh",
      thinking: "disabled",
      fallbackModel: "sonnet",
    },
  });
});

test("offline run completes end to end with file-backed stores and auto-approved gate", async () => {
  const root = tempRoot();
  try {
    const runId = "bsa_test_full";
    const runtime = buildRuntime({
      providerConfig: { provider: "offline" },
      checkpoints: new FsCheckpointStore(root),
      artifacts: new FsArtifactStore(root, runId),
      autoApproveGates: true,
      bundle: registryBundle,
    });
    const result = await runtime.run({
      runId,
      submission: { prompt: "Can KNN graph construction be made differentiable?", attachments: [] },
    });
    assert.equal(result.status, "completed");
    assert.ok(result.status === "completed" && result.output !== undefined);
    const proposal = result.output as { title?: string };
    assert.ok(typeof proposal.title === "string" && proposal.title.length > 0);

    const artifacts = await new FsArtifactStore(root, runId).list();
    assert.ok(artifacts.length > 0, "artifacts were persisted to disk");
    const checkpoint = await new FsCheckpointStore(root).load(runId);
    assert.equal(checkpoint?.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual gate suspends; resume across a fresh runtime instance completes from disk", async () => {
  const root = tempRoot();
  try {
    const runId = "bsa_test_resume";
    const first = buildRuntime({
      providerConfig: { provider: "offline" },
      checkpoints: new FsCheckpointStore(root),
      artifacts: new FsArtifactStore(root, runId),
      autoApproveGates: false,
      bundle: registryBundle,
    });
    const suspended = await first.run({
      runId,
      submission: { prompt: "A topic that pauses at the panel gate", attachments: [] },
    });
    assert.equal(suspended.status, "suspended");
    const gateKey =
      suspended.status === "suspended" ? suspended.pendingGates[0]!.gateKey : "";
    assert.ok(gateKey.length > 0);

    // Fresh instance simulates a process restart: state must come from disk.
    const second = buildRuntime({
      providerConfig: { provider: "offline" },
      checkpoints: new FsCheckpointStore(root),
      artifacts: new FsArtifactStore(root, runId),
      autoApproveGates: false,
      bundle: registryBundle,
    });
    const finished = await second.resume(runId, {
      responses: { [gateKey]: { action: "approve" } },
    });
    assert.equal(finished.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Distinct first-pass member indices that actually executed, from the journal. */
function firstPassMembers(root: string, runId: string): number[] {
  const checkpoint = JSON.parse(
    readFileSync(join(root, runId, "checkpoint.json"), "utf8"),
  ) as { journal: Array<{ key?: string }> };
  const indices = new Set<number>();
  for (const entry of checkpoint.journal) {
    if (!entry.key?.includes("/first-pass/")) continue;
    const match = entry.key.match(/\/member\[(\d+)\]\//);
    if (match) indices.add(Number(match[1]));
  }
  return [...indices].sort();
}

test("gate shrink action reduces the seated panel before the first pass", async () => {
  const root = tempRoot();
  try {
    const runId = "bsa_test_shrink";
    const runtime = buildRuntime({
      providerConfig: { provider: "offline" },
      checkpoints: new FsCheckpointStore(root),
      artifacts: new FsArtifactStore(root, runId),
      autoApproveGates: false,
      bundle: registryBundle,
    });
    const suspended = await runtime.run({
      runId,
      submission: { prompt: "Shrink the panel to two members", attachments: [] },
    });
    assert.equal(suspended.status, "suspended");
    const gateKey =
      suspended.status === "suspended" ? suspended.pendingGates[0]!.gateKey : "";
    const finished = await runtime.resume(runId, {
      responses: { [gateKey]: { action: "shrink", members: ["member-1", "member-2"] } },
    });
    assert.equal(finished.status, "completed");
    assert.deepEqual(
      firstPassMembers(root, runId),
      [0, 1],
      "only the retained members may reach the first pass",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit gate answer wins over --auto-approve on resume", () => {
  // Regression: the server may pass --auto-approve on a resume (settings
  // drift), which used to compile the gate as an auto-approve activity that
  // silently discarded the human's shrink and ran the full panel.
  const root = tempRoot();
  try {
    const runId = "bsa_test_gate_beats_auto";
    const cli = new URL("../src/main.js", import.meta.url);
    const common = [
      "--offline",
      "--run-id",
      runId,
      "--session-root",
      root,
      "--content-dir",
      registryContentDir,
    ];
    const started = spawnSync(
      process.execPath,
      [cli.pathname, "run", "--topic", "Shrink must survive auto-approve", ...common],
      { encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    const checkpoint = JSON.parse(
      readFileSync(join(root, runId, "checkpoint.json"), "utf8"),
    ) as { status: string; pendingGates: Array<{ gateKey: string }> };
    assert.equal(checkpoint.status, "suspended");
    const gateKey = checkpoint.pendingGates[0]!.gateKey;

    const resumed = spawnSync(
      process.execPath,
      [
        cli.pathname,
        "resume",
        ...common,
        "--auto-approve",
        "--gate",
        `${gateKey}=shrink:member-1,member-2`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const finished = JSON.parse(
      readFileSync(join(root, runId, "checkpoint.json"), "utf8"),
    ) as { status: string; journal: Array<{ key?: string }> };
    assert.equal(finished.status, "completed");
    assert.ok(
      !finished.journal.some((entry) => entry.key?.includes("confirm-panel-auto")),
      "the gate must not be auto-approved when an explicit answer was given",
    );
    assert.deepEqual(firstPassMembers(root, runId), [0, 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run and resume accept content-dir and append JSONL events", () => {
  const root = tempRoot();
  try {
    const runId = "bsa_test_cli_flags";
    const eventsFile = join(root, "nested", "events.jsonl");
    const cli = new URL("../src/main.js", import.meta.url);
    const common = [
      "--offline",
      "--run-id",
      runId,
      "--session-root",
      root,
      "--events-file",
      eventsFile,
      "--content-dir",
      registryContentDir,
    ];
    const started = spawnSync(
      process.execPath,
      [cli.pathname, "run", "--topic", "Exercise CLI flags", ...common],
      { encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    const checkpoint = JSON.parse(
      readFileSync(join(root, runId, "checkpoint.json"), "utf8"),
    ) as { status: string; pendingGates: Array<{ gateKey: string }> };
    assert.equal(checkpoint.status, "suspended");
    const before = readFileSync(eventsFile, "utf8").trim().split("\n").length;

    const resumed = spawnSync(
      process.execPath,
      [cli.pathname, "resume", ...common, "--gate", `${checkpoint.pendingGates[0]!.gateKey}=approve`],
      { encoding: "utf8" },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n");
    assert.ok(lines.length > before);
    const events = lines.map((line) => JSON.parse(line) as { type: string });
    assert.ok(events.some((event) => event.type === "run:suspended"));
    assert.ok(events.some((event) => event.type === "run:completed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
