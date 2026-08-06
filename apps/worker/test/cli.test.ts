import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContent } from "@brainstorm-agentic/content";
import type { TaxonomyAccess } from "@brainstorm-agentic/core";

import {
  buildRuntime,
  providerConfigFromEnv,
} from "../src/wiring.js";
import { FsArtifactStore, FsCheckpointStore } from "../src/fs-stores.js";
import {
  LocalTaxonomyService,
  localTaxonomySeedPath,
} from "../src/taxonomy-service.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "bsa-cli-"));
}

/** The bundle-seeded local taxonomy the deterministic activities run over. */
function testTaxonomy(root: string): { taxonomy: TaxonomyAccess } | Record<string, never> {
  const seed = localTaxonomySeedPath(registryContentDir);
  if (!existsSync(seed)) return {};
  return {
    taxonomy: new LocalTaxonomyService(seed, join(root, "taxonomy-suggestions")),
  };
}

const brainRepoRoot = fileURLToPath(new URL("../../../../../brain/", import.meta.url));
/**
 * The newest published bundle, read from the store's own index.
 *
 * Deliberately not a pinned version: these tests want "a real bundle", and a
 * hardcoded one silently becomes a museum piece. This file used to pin 0.1.0,
 * which kept passing until the workflow schema gained a requirement that
 * ancient bundles cannot satisfy — at which point the whole file failed at
 * import, on a rule that has nothing to do with what it tests. Old versions
 * stay in the store on purpose (a pinned run must still resolve), so nothing
 * prunes them and nothing would have flagged the staleness.
 */
function latestMaterializedDir(): string {
  execFileSync(
    process.execPath,
    [join(brainRepoRoot, "scripts", "materialize-store.mjs"), "--quiet"],
    { stdio: "inherit" },
  );
  const storeRoot = join(brainRepoRoot, ".registry-store");
  const index = JSON.parse(readFileSync(join(storeRoot, "index.json"), "utf8")) as {
    bundles: readonly { id: string; latest: string }[];
  };
  const brainstorm = index.bundles.find((bundle) => bundle.id === "brainstorm");
  if (!brainstorm) throw new Error("the materialized store publishes no brainstorm bundle");
  return `${join(storeRoot, "bundles", "brainstorm", brainstorm.latest)}/`;
}
const registryContentDir =
  process.env.BRAIN_TEST_CONTENT_DIR ?? latestMaterializedDir();
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
      ...testTaxonomy(root),
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
      ...testTaxonomy(root),
      bundle: registryBundle,
    });
    let result = await first.run({
      runId,
      submission: { prompt: "A topic that pauses at the panel gate", attachments: [] },
    });
    assert.equal(result.status, "suspended");

    // Approve every gate the bundle carries (0.14.0 adds the classification
    // gate before the panel gate), each time across a FRESH runtime instance
    // to simulate a process restart: state must come from disk.
    let resumes = 0;
    while (result.status === "suspended") {
      assert.ok((resumes += 1) <= 3, "unexpected number of gates");
      const gateKey = result.pendingGates[0]!.gateKey;
      assert.ok(gateKey.length > 0);
      const next = buildRuntime({
        providerConfig: { provider: "offline" },
        checkpoints: new FsCheckpointStore(root),
        artifacts: new FsArtifactStore(root, runId),
        autoApproveGates: false,
        ...testTaxonomy(root),
        bundle: registryBundle,
      });
      result = await next.resume(runId, {
        responses: { [gateKey]: { action: "approve" } },
      });
    }
    assert.equal(result.status, "completed");
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
      ...testTaxonomy(root),
      bundle: registryBundle,
    });
    let suspended = await runtime.run({
      runId,
      submission: { prompt: "Shrink the panel to two members", attachments: [] },
    });
    assert.equal(suspended.status, "suspended");
    // Split-classification bundles (>= 0.14.0) pause at the classification
    // gate first; approve it to reach the panel gate this test targets.
    if (
      suspended.status === "suspended" &&
      suspended.pendingGates[0]!.gateKey === "confirm-classification"
    ) {
      suspended = await runtime.resume(runId, {
        responses: { "confirm-classification": { action: "approve" } },
      });
      assert.equal(suspended.status, "suspended");
    }
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
    let checkpoint = JSON.parse(
      readFileSync(join(root, runId, "checkpoint.json"), "utf8"),
    ) as { status: string; pendingGates: Array<{ gateKey: string }> };
    assert.equal(checkpoint.status, "suspended");
    // Split-classification bundles pause at the classification gate first;
    // approve it explicitly to reach the panel gate this test targets.
    if (checkpoint.pendingGates[0]!.gateKey === "confirm-classification") {
      const approved = spawnSync(
        process.execPath,
        [cli.pathname, "resume", ...common, "--gate", "confirm-classification=approve"],
        { encoding: "utf8" },
      );
      assert.equal(approved.status, 0, approved.stderr);
      checkpoint = JSON.parse(
        readFileSync(join(root, runId, "checkpoint.json"), "utf8"),
      ) as { status: string; pendingGates: Array<{ gateKey: string }> };
      assert.equal(checkpoint.status, "suspended");
    }
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
    let checkpoint = JSON.parse(
      readFileSync(join(root, runId, "checkpoint.json"), "utf8"),
    ) as { status: string; pendingGates: Array<{ gateKey: string }> };
    assert.equal(checkpoint.status, "suspended");
    const before = readFileSync(eventsFile, "utf8").trim().split("\n").length;

    // Approve every gate the bundle carries (one on pre-0.14.0 bundles, the
    // classification gate first on split-classification bundles).
    let resumed = spawnSync(
      process.execPath,
      [cli.pathname, "resume", ...common, "--gate", `${checkpoint.pendingGates[0]!.gateKey}=approve`],
      { encoding: "utf8" },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    for (let round = 0; round < 2; round += 1) {
      checkpoint = JSON.parse(
        readFileSync(join(root, runId, "checkpoint.json"), "utf8"),
      ) as { status: string; pendingGates: Array<{ gateKey: string }> };
      if (checkpoint.status !== "suspended") break;
      resumed = spawnSync(
        process.execPath,
        [cli.pathname, "resume", ...common, "--gate", `${checkpoint.pendingGates[0]!.gateKey}=approve`],
        { encoding: "utf8" },
      );
      assert.equal(resumed.status, 0, resumed.stderr);
    }
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n");
    assert.ok(lines.length > before);
    const events = lines.map((line) => JSON.parse(line) as { type: string });
    assert.ok(events.some((event) => event.type === "run:suspended"));
    assert.ok(events.some((event) => event.type === "run:completed"));

    // The finished run leaves readable copies of the reviewed deliverables
    // beside the checkpoint: one file per member's final output plus the
    // chair's proposal, and the CLI names each written file.
    const finalDir = join(root, runId, "final");
    const finalFiles = readdirSync(finalDir).sort();
    assert.ok(finalFiles.includes("proposal.json"), "final/proposal.json is written");
    const memberFiles = finalFiles.filter((name) => /^member-\d+\.json$/.test(name));
    assert.ok(memberFiles.length >= 2, "one final file per panel member");
    const memberFinal = JSON.parse(
      readFileSync(join(finalDir, memberFiles[0]!), "utf8"),
    ) as { output?: unknown; cot?: unknown };
    assert.ok(memberFinal.output !== undefined && Array.isArray(memberFinal.cot));
    assert.ok(resumed.stdout.includes("Final output:"), "the CLI reports the final copies");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
