import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContent, type ContentBundle } from "@brainstorm-agentic/content";
import type { AgentResult, AgentTask, JsonObject, JsonValue } from "@brainstorm-agentic/core";

import { FsArtifactStore, FsCheckpointStore } from "../src/fs-stores.js";
import { OfflineBrainstormExecutor } from "../src/offline-executor.js";
import { LocalTaxonomyService, localTaxonomySeedPath } from "../src/taxonomy-service.js";
import { buildRuntime } from "../src/wiring.js";

/**
 * Worker end-to-end check of the invented-badge penalty (spec/invented-badge.md
 * section 7). Offline chair-decisive game runs on the Brain content, through
 * the worker's own wiring, in which exactly one critic report is wrapped to
 * cite [F:999], a badge the run's fact table never issued: that critic alone
 * records -175, every step decision matches the unwrapped run, and a run
 * stopped after the penalty resumes from its checkpoint to the same balances.
 * A last run checks that a badge quoted in the critics' task input is exempt.
 */

const brainRepoRoot = fileURLToPath(new URL("../../../../../brain/", import.meta.url));
/** The pinned published bundle, resolved as in cli.test.ts. */
function pinnedMaterializedDir(): string {
  execFileSync(process.execPath, [join(brainRepoRoot, "scripts", "materialize-store.mjs"), "--quiet"], { stdio: "inherit" });
  const storeRoot = join(brainRepoRoot, ".registry-store");
  const override = process.env.BRAIN_TEST_BUNDLE_VERSION;
  let version: string;
  if (override === "latest") {
    const index = JSON.parse(readFileSync(join(storeRoot, "index.json"), "utf8")) as { bundles: readonly { id: string; latest: string }[] };
    const brainstorm = index.bundles.find((bundle) => bundle.id === "brainstorm");
    if (!brainstorm) throw new Error("the materialized store publishes no brainstorm bundle");
    version = brainstorm.latest;
  } else if (override) {
    version = override;
  } else {
    version = (JSON.parse(readFileSync(new URL("../../../../test-bundle.json", import.meta.url), "utf8")) as { version: string }).version;
  }
  return `${join(storeRoot, "bundles", "brainstorm", version)}/`;
}
const sourceContentDir = process.env.BRAIN_TEST_CONTENT_DIR ?? pinnedMaterializedDir();
const sourceBundle = loadContent(sourceContentDir);
const supported = sourceBundle.workflows.brainstorm?.params.gameDecisionRule !== undefined && sourceBundle.factTable !== undefined;

/** The param as spec 6.2 declares it, for a content tree that does not declare it yet. */
const PENALTY_PARAM = {
  description: "In game review, reject a critic report that cites a badge [F:n] never issued in the run's fact table and record -175, the lowest score a round can produce, against that critic's private balance. Badges that appear in the reviewed chain or the task input are exempt. When false, rejection carries no penalty.",
  default: true,
};
const GAME_PARAMS = { gamifiedReview: true, gameDecisionRule: "chair-decisive", gameLeaveOneOut: true, panelSize: 2, maxReviewRounds: 2 };
/** The prompt reaches every critic's task input (input.title, input.question), never the reviewed chain. */
const SUBMISSION = { prompt: "Check whether the stated absolute-value inference [F:998] holds and repair any missing sign condition.", attachments: [] };
const HOST_TEXT = "invented badge F:999 never issued in this run's fact table; penalty -175";

/** The content directory with gameInventedBadgePenalty declared: the source itself
 * when its workflow declares the param, else a temporary copy that adds it. */
function contentWithPenalty(root: string): string {
  const manifest = join(sourceContentDir, "bundle.json");
  const entry = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")) as { entrypoints: { workflow: string } }).entrypoints.workflow
    : join("workflows", "brainstorm.workflow.json");
  const workflow = JSON.parse(readFileSync(join(sourceContentDir, entry), "utf8")) as { params: Record<string, JsonValue> };
  if (workflow.params.gameInventedBadgePenalty !== undefined) return sourceContentDir;
  const copy = join(root, "content");
  cpSync(sourceContentDir, copy, { recursive: true });
  workflow.params.gameInventedBadgePenalty = PENALTY_PARAM;
  writeFileSync(join(copy, entry), `${JSON.stringify(workflow, null, 2)}\n`);
  return copy;
}

interface Critique { readonly path: string; readonly agentId: string; readonly penalties: readonly JsonObject[]; readonly input: string; readonly chain: string }
const wrap = { citing: new Map<string, string>(), stopAfterPenalty: undefined as string | undefined, seen: [] as Critique[] };
const objectOf = (value: JsonValue | undefined): JsonObject => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {});
const rowsOf = (settlement: JsonObject): JsonObject[] => settlement.rows as JsonObject[];
const pathOf = (task: AgentTask): string => task.taskId.slice(task.taskId.indexOf(":") + 1);

const offlineExecute = OfflineBrainstormExecutor.prototype.execute;
/** The offline executor, except that one chosen critique cites one more badge,
 * and a critic's first task after its committed penalty can fail once. */
async function wrappedExecute(this: OfflineBrainstormExecutor, task: AgentTask): Promise<AgentResult> {
  const result = await offlineExecute.call(this, task);
  if (task.outputSchema?.name !== "gameCritique" || result.status !== "ok") return result;
  const bindings = objectOf(objectOf(task.input).bindings);
  const history = objectOf(bindings.criticState).history;
  const entries: readonly JsonValue[] = Array.isArray(history) ? history : [];
  const penalties = entries.map((entry) => objectOf(entry)).filter((entry) => entry.penalty !== undefined);
  const agentId = task.agentId ?? "";
  wrap.seen.push({ path: pathOf(task), agentId, penalties, input: JSON.stringify(bindings.input ?? null), chain: JSON.stringify(bindings.chain ?? null) });
  if (wrap.stopAfterPenalty === agentId && penalties.length > 0) {
    wrap.stopAfterPenalty = undefined;
    return { taskId: task.taskId, status: "error", error: { name: "InterruptedFixture", message: "The worker stopped after a committed invented-badge penalty." } };
  }
  const badge = wrap.citing.get(pathOf(task));
  if (badge === undefined) return result;
  const output = objectOf(result.output);
  return { ...result, output: { ...output, justification: `${String(output.justification)} [${badge}]` } };
}

function runtimeFor(root: string, bundle: ContentBundle, contentDir: string, runId: string) {
  const seed = localTaxonomySeedPath(contentDir);
  return buildRuntime({
    providerConfig: { provider: "offline" },
    checkpoints: new FsCheckpointStore(root),
    artifacts: new FsArtifactStore(root, runId),
    autoApproveGates: true,
    ...(existsSync(seed) ? { taxonomy: new LocalTaxonomyService(seed, join(root, `taxonomy-${runId}`)) } : {}),
    bundle,
  });
}

async function settlementsOf(root: string, runId: string): Promise<Map<string, JsonObject>> {
  const checkpoint = await new FsCheckpointStore(root).load(runId);
  assert.ok(checkpoint, `checkpoint of ${runId}`);
  return new Map(checkpoint.journal
    .filter((entry) => entry.key.endsWith("/game-settle-run::result") && objectOf(entry.value).ruleVersion === "brier-peer/v3")
    .map((entry) => [entry.key, objectOf(entry.value)] as const));
}

/** Every critic's balance after the last recorded settlement, read from the rows. */
function recordedBalances(settlements: Map<string, JsonObject>): Record<string, number> {
  const ordered = [...settlements.values()].sort((a, b) => Number(a.ledgerSequence) - Number(b.ledgerSequence));
  assert.deepEqual(ordered.map((settlement) => settlement.ledgerSequence), ordered.map((_, index) => index + 1));
  const first = ordered[0]!;
  const balances: Record<string, number> = Object.fromEntries((first.criticIds as string[]).map((id) => [id, Number(first.initialPoints)]));
  for (const settlement of ordered) for (const entry of rowsOf(settlement)) balances[String(entry.criticId)] = Number(entry.balanceAfter);
  return balances;
}

/** The same balances replayed from the durable journal into a fresh runtime's ledger. */
async function replayedBalances(root: string, bundle: ContentBundle, contentDir: string, runId: string, settlements: Map<string, JsonObject>): Promise<Record<string, number>> {
  const checkpoint = await new FsCheckpointStore(root).load(runId);
  assert.ok(checkpoint, `checkpoint of ${runId}`);
  const ledger = runtimeFor(root, bundle, contentDir, runId).compiled.gameReviewLedger;
  ledger.hydrate(runId, checkpoint.journal);
  const first = [...settlements.values()][0]!;
  const ids = first.criticIds as string[];
  const panel = { members: ids.map((id) => ({ id })) };
  return Object.fromEntries(ids.map((id) => [id, Number(ledger.dispatch(runId, `${runId}:replay`, id, panel, Number(first.initialPoints)).balance)]));
}

const failure = (result: { readonly status: string; readonly error?: { readonly message: string } }): string | undefined => result.error?.message;

test("one offline critic report citing an invented badge records -175 for that critic only, keeps every step decision, and resumes to the same balances",
  { skip: supported ? false : "the Brain content declares no committee decision rule or fact table" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bsa-invented-badge-"));
  OfflineBrainstormExecutor.prototype.execute = wrappedExecute;
  try {
    const contentDir = contentWithPenalty(root);
    const bundle = loadContent(contentDir);
    assert.equal(bundle.workflows.brainstorm?.params.gameInventedBadgePenalty?.default, true, "the Brain workflow enables the penalty by default");
    const run = (runId: string) => runtimeFor(root, bundle, contentDir, runId).run({ runId, submission: SUBMISSION, params: GAME_PARAMS });

    // The unwrapped run: the compiler binds the gate on every settlement and nobody is penalised.
    const plainResult = await run("invented-plain");
    assert.equal(plainResult.status, "completed", failure(plainResult));
    const plain = await settlementsOf(root, "invented-plain");
    assert.ok(plain.size > 0, "the run settled game rounds");
    for (const settlement of plain.values()) {
      assert.deepEqual([settlement.ruleVersion, settlement.decisionRule, settlement.inventedBadgePenalty], ["brier-peer/v3", "chair-decisive", true]);
      assert.ok(rowsOf(settlement).every((entry) => entry.penalty === undefined && entry.score !== null));
    }

    // The wrapped report: the lowest critic id in the first round two critics reviewed.
    const critiques = wrap.seen.splice(0);
    const roundOf = (path: string): string => path.slice(0, path.indexOf("/gather-game-comments/"));
    assert.ok(critiques.length > 0 && critiques.every((critique) => critique.path.includes("/gather-game-comments/")));
    const round = [...new Set(critiques.map((critique) => roundOf(critique.path)))].sort()
      .find((prefix) => critiques.filter((critique) => roundOf(critique.path) === prefix).length >= 2);
    assert.ok(round !== undefined, "a round reviewed by two critics");
    const target = critiques.filter((critique) => roundOf(critique.path) === round).sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0))[0]!;
    const settlementKey = [...plain.keys()].find((key) => key.startsWith(`${round}/`));
    assert.ok(settlementKey !== undefined, "the wrapped round has a settlement");
    const plainTargetRow = rowsOf(plain.get(settlementKey)!).find((entry) => entry.criticId === target.agentId)!;

    // The same run with the one report citing [F:999].
    wrap.citing.set(target.path, "F:999");
    const wrappedResult = await run("invented-wrapped");
    assert.equal(wrappedResult.status, "completed", failure(wrappedResult));
    const wrapped = await settlementsOf(root, "invented-wrapped");
    assert.deepEqual([...wrapped.keys()].sort(), [...plain.keys()].sort(), "the same review steps and rounds ran");
    const penalties = [...wrapped].flatMap(([key, settlement]) => rowsOf(settlement).filter((entry) => entry.penalty !== undefined).map((entry) => ({ key, entry })));
    assert.equal(penalties.length, 1, "exactly one row carries the penalty");
    const penalised = penalties[0]!;
    assert.equal(penalised.key, settlementKey);
    assert.equal(penalised.entry.criticId, target.agentId);
    assert.deepEqual([penalised.entry.score, penalised.entry.penalty, penalised.entry.inventedBadges, penalised.entry.admissible, penalised.entry.label],
      [-175, "invented-badge", ["F:999"], false, null]);
    assert.equal(penalised.entry.balanceAfter, Number(penalised.entry.balanceBefore) - 175);
    assert.equal(penalised.entry.reason, `${String(plainTargetRow.reason)} Host verification: ${HOST_TEXT}.`, "the chair's reason, then only the invented-badge text (addendum D4)");
    for (const [key, settlement] of wrapped) {
      const reference = plain.get(key)!;
      assert.equal(settlement.y, reference.y, `step decision at ${key}`);
      assert.equal(objectOf(settlement.decision).verdict, objectOf(reference.decision).verdict, `step decision at ${key}`);
      for (const entry of rowsOf(settlement)) {
        if (entry === penalised.entry) continue;
        assert.equal(entry.score, rowsOf(reference).find((candidate) => candidate.criticId === entry.criticId)?.score, `${key} ${String(entry.criticId)}`);
      }
    }
    const plainBalances = recordedBalances(plain);
    const wrappedBalances = recordedBalances(wrapped);
    for (const id of Object.keys(plainBalances)) {
      assert.equal(wrappedBalances[id], plainBalances[id]! + (id === target.agentId ? -175 - Number(plainTargetRow.score) : 0), id);
    }
    assert.ok(wrap.seen.some((critique) => critique.agentId === target.agentId &&
      critique.penalties.some((entry) => entry.penalty === "invented-badge" && JSON.stringify(entry.inventedBadges) === JSON.stringify(["F:999"]))),
      "the critic's later private history shows its penalty");
    assert.deepEqual(await replayedBalances(root, bundle, contentDir, "invented-wrapped", wrapped), wrappedBalances);

    // Stop the same run at the critic's first task after its committed penalty, then resume.
    wrap.seen.length = 0;
    wrap.stopAfterPenalty = target.agentId;
    const stopped = await run("invented-resumed");
    assert.equal(stopped.status, "failed");
    assert.equal(wrap.stopAfterPenalty, undefined, "the stop came after the committed penalty");
    const atStop = await settlementsOf(root, "invented-resumed");
    assert.ok(rowsOf(atStop.get(settlementKey)!).some((entry) => entry.penalty === "invented-badge"), "the penalty was durable before the stop");
    const resumedResult = await runtimeFor(root, bundle, contentDir, "invented-resumed").resume("invented-resumed");
    assert.equal(resumedResult.status, "completed", failure(resumedResult));
    const resumed = await settlementsOf(root, "invented-resumed");
    assert.deepEqual([...resumed.keys()].sort(), [...wrapped.keys()].sort());
    for (const [key, settlement] of resumed) {
      const reference = wrapped.get(key)!;
      assert.equal(settlement.y, reference.y, key);
      assert.deepEqual(rowsOf(settlement).map((entry) => [entry.criticId, entry.score, entry.penalty ?? null]),
        rowsOf(reference).map((entry) => [entry.criticId, entry.score, entry.penalty ?? null]), key);
    }
    assert.deepEqual(recordedBalances(resumed), wrappedBalances);
    assert.deepEqual(await replayedBalances(root, bundle, contentDir, "invented-resumed", resumed), wrappedBalances);

    // A badge quoted in the critics' task input (here the submitted prompt) is exempt.
    wrap.citing.clear();
    wrap.citing.set(target.path, "F:998");
    wrap.seen.length = 0;
    const quotedResult = await run("invented-quoted");
    assert.equal(quotedResult.status, "completed", failure(quotedResult));
    const quotedCritique = wrap.seen.find((critique) => critique.path === target.path);
    assert.ok(quotedCritique !== undefined);
    assert.ok(quotedCritique.input.includes("[F:998]"), "the critic's task input quotes [F:998]");
    assert.ok(!quotedCritique.chain.includes("F:998"), "the reviewed chain does not");
    const quoted = await settlementsOf(root, "invented-quoted");
    const quotedRow = rowsOf(quoted.get(settlementKey)!).find((entry) => entry.criticId === target.agentId)!;
    assert.deepEqual([quotedRow.admissible, quotedRow.score, Object.hasOwn(quotedRow, "penalty")], [false, null, false]);
    assert.ok(String(quotedRow.reason).startsWith(`${String(plainTargetRow.reason)} Host verification: fact checks must cover exactly the cited supporting badges; F:998 `) &&
      !String(quotedRow.reason).includes("invented badge"), `a report that does not offend keeps today's errors: ${String(quotedRow.reason)}`);
    assert.ok([...quoted.values()].every((settlement) => rowsOf(settlement).every((entry) => entry.penalty === undefined)));
  } finally {
    OfflineBrainstormExecutor.prototype.execute = offlineExecute;
    rmSync(root, { recursive: true, force: true });
  }
});
