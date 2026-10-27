import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContent, type ContentBundle } from "@brainstorm-agentic/content";
import {
  WorkflowCancelledError,
  type AgentExecutionContext,
  type AgentResult,
  type AgentTask,
  type FactCase,
  type FactRequester,
  type FactVerdict,
  type JsonObject,
  type JsonValue,
} from "@brainstorm-agentic/core";

import { FileFactTable, type FactVerificationRequest, type FactVerifier } from "../src/fact-table.js";
import { FsArtifactStore, FsCheckpointStore } from "../src/fs-stores.js";
import { OfflineBrainstormExecutor } from "../src/offline-executor.js";
import { LocalTaxonomyService, localTaxonomySeedPath } from "../src/taxonomy-service.js";
import { buildRuntime } from "../src/wiring.js";

/**
 * Worker end-to-end checks of fact updates (spec/fact-updates.md section
 * 11.13, tests 32 to 36). Offline runs on the Brain content, through the
 * worker's own wiring, with a fact table supplied by the wiring's test seam.
 * Seat member-1's chain and the first report on seat member-2's first step
 * cite F:1; a ruling revokes F:1 while that round's chair (or judge) assesses.
 * The last test cancels a run while a reconsideration task runs (D16).
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
const supported = sourceBundle.factTable?.updates !== undefined && sourceBundle.workflows.brainstorm?.params.gameDecisionRule !== undefined;
const SKIP = supported ? false : "the Brain content's fact table declares no updates";

const CHAIN_SEAT = "member-1";
const REPORT_SEAT = "member-2";
const GAME_PARAMS = { gamifiedReview: true, gameDecisionRule: "chair-decisive", gameLeaveOneOut: true, panelSize: 2, maxReviewRounds: 2 };
const STANDARD_PARAMS = { gamifiedReview: false, panelSize: 2, maxReviewRounds: 2 };
const SUBMISSION = { prompt: "Check whether the stated absolute-value inference holds and repair any missing sign condition.", attachments: [] };
const CONDITIONS = "real inputs under the stated sign condition";
const DELETED_TEXT = "deleted badge F:1 cited after its deletion from this run's fact table; penalty -175";
const AFTER_TEXT = "F:1 was deleted from this run's fact table after this report was requested";
const ASSESSORS = new Set(["gameCommitteeDecision", "gameChairDecision", "judgeDecisionParts", "judgeDecision"]);
const CRITIQUES = new Set(["gameCritique", "commentParts"]);

type Decision = "revised" | "withdrawn" | "unchanged";
interface Scenario {
  table: FileFactTable | undefined;
  decision: Decision;
  failChainOnce: boolean;
  fineLater: boolean;
  /** The first report on seat member-2's first step: it cites F:1. */
  citing: { readonly path: string; readonly critic: string } | undefined;
  /** The first seat member-2 critique dispatched after the deletion, when fineLater. */
  late: { readonly path: string; readonly critic: string } | undefined;
  deleted: boolean;
  /** Paths of the chair's (or judge's) calls on seat member-2's first step. */
  assessorCalls: string[];
  /** `<schema> <path>` of every task the offline executor ran. */
  executed: string[];
  /** What each critique and assessment saw, for failure messages. */
  trace: string[];
  /** The first report reconsideration hangs, and the run is cancelled as it starts (D16). */
  holdReport: boolean;
  /** The run's cancel switch, when holdReport. */
  cancel: AbortController | undefined;
  /** The signals the held reconsideration's executor was given. */
  heldSignals: AbortSignal[];
}
type ScenarioExtra = Partial<Pick<Scenario, "failChainOnce" | "fineLater" | "holdReport">>;
const freshScenario = (decision: Decision, extra: ScenarioExtra = {}): Scenario => ({
  table: undefined, decision, failChainOnce: false, fineLater: false, citing: undefined, late: undefined,
  deleted: false, assessorCalls: [], executed: [], trace: [], holdReport: false, heldSignals: [], ...extra,
  cancel: extra.holdReport === true ? new AbortController() : undefined,
});
let scenario = freshScenario("unchanged");

const objectOf = (value: JsonValue | undefined): JsonObject => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {});
const rowsOf = (settlement: JsonObject): JsonObject[] => settlement.rows as JsonObject[];
const pathOf = (task: AgentTask): string => task.taskId.slice(task.taskId.indexOf(":") + 1);
const failure = (result: { readonly status: string; readonly error?: { readonly message: string } }): string | undefined => result.error?.message;

/** The four parts the offline brain writes for a chain step. */
const stepParts = (seat: string, index: number) => ({
  part1: `${seat} chain step ${index} part 1: the claim this step puts forward.`,
  part2: `${seat} chain step ${index} part 2: what the claim rests on.`,
  part3: `${seat} chain step ${index} part 3: the check that would break it.`,
  part4: `${seat} chain step ${index} part 4: what the next step leaves to settle.`,
});

/** Whether a task reviews seat member-2's first step: its bound current step, else a prefix through step 1 only. */
function seatTwoStepOne(bindings: JsonObject): boolean {
  const text = JSON.stringify({ ...bindings, comments: null });
  if (!text.includes(`${REPORT_SEAT} chain step 1 part`)) return false;
  return typeof bindings.currentStep === "number" ? bindings.currentStep === 1 : !text.includes(`${REPORT_SEAT} chain step 2 part`);
}

/** A complete verdict on the submitted claim, as the supreme judge gives one. */
function verdictOn(request: FactVerificationRequest, ruling: Partial<FactVerdict> & { readonly case: FactCase }): FactVerdict {
  return {
    claim: String(request.bindings.request.claim),
    conditions: String(request.bindings.request.conditions),
    method: "judgement-only",
    evidence: "A checked proof.",
    explanation: `Ruled ${ruling.case}.`,
    conflicts: [],
    integrity: "honest",
    ...ruling,
  };
}

const judge = (ruling: Partial<FactVerdict> & { readonly case: FactCase }): FactVerifier => async (request) => ({
  verdict: verdictOn(request, ruling),
  taskId: `fact-verification:${request.submission}`,
  usage: { inputTokens: 100, outputTokens: 20 },
});

const SEEDER: FactRequester = { taskId: "seed", role: "commentor", agent: "seed", seat: CHAIN_SEAT, step: 1 };
/** F:1's submitter has no revisable output in the run: its notice lists it without a task (design 6.1). */
const SEEDER_NONE = "none:commentor:seed";

/** The run's fact table, through the seam, holding F:1. */
async function seededTable(root: string, runId: string, bundle: ContentBundle): Promise<{ readonly table: FileFactTable; readonly logPath: string }> {
  mkdirSync(join(root, runId), { recursive: true });
  const logPath = join(root, runId, "facts.jsonl");
  const table = new FileFactTable({ logPath, limits: bundle.factTable!.limits, updates: "delete-or-replace/v1" });
  table.attachVerifier(judge({ case: "justified-new" }));
  const outcome = await table.submit(SEEDER, {
    claim: "The absolute-value inference holds for every real input", conditions: CONDITIONS, evidence: "A short proof by cases.", kind: "math",
  }, {});
  assert.equal(outcome.badge?.id, "F:1");
  return { table, logPath };
}

/** The ruling that revokes F:1 and issues F:2, submitted by the assessing task. */
async function revoke(table: FileFactTable, task: AgentTask, role: string): Promise<void> {
  table.attachVerifier(judge({
    case: "justified-new",
    conflicts: [{ id: "F:1", resolution: "incumbent-revoked", explanation: "F:1 drops the sign condition its proof needs." }],
  }));
  const outcome = await table.submit({ taskId: task.taskId, role, agent: role, seat: REPORT_SEAT, step: 1 }, {
    claim: "The absolute-value inference holds for every nonnegative real input", conditions: CONDITIONS,
    evidence: "The proof by cases needs the sign condition.", kind: "math",
  }, {});
  assert.deepEqual(outcome.conflicts.map((conflict) => [conflict.entry.id, conflict.deleted]), [["F:1", true]]);
}

/** A revised standard-review comment: still Build, so its round stays contested, and no badge cited. */
const REVISED_COMMENT: JsonObject = {
  verdict: "Build",
  reason: "Step 1 needs its sign condition stated; no badge supports the inference as written.",
  flaws: [],
  suggestion: "State the sign condition in step 1.",
  evidence: { kind: "none", code: "", result: "", derivation: "", citation: "", locator: "", shows: "" },
};

const ok = (task: AgentTask, output: JsonObject): AgentResult => ({ taskId: task.taskId, status: "ok", output, usage: { inputTokens: 10, outputTokens: 5 } });

const offlineExecute = OfflineBrainstormExecutor.prototype.execute;
/** The offline executor, except for the citations, the deletion and the reconsiderations each scenario scripts. */
async function wrappedExecute(this: OfflineBrainstormExecutor, task: AgentTask, context?: AgentExecutionContext): Promise<AgentResult> {
  const name = task.outputSchema?.name ?? "";
  const path = pathOf(task);
  scenario.executed.push(`${name} ${path}`);
  const bindings = objectOf(objectOf(task.input).bindings);
  if (name === "chainReconsiderationParts") {
    if (scenario.failChainOnce) {
      scenario.failChainOnce = false;
      return { taskId: task.taskId, status: "error", error: { name: "InterruptedFixture", message: "The worker stopped during the chain's reconsideration." } };
    }
    return ok(task, {
      decision: "revised",
      reason: "Step 1 no longer rests on F:1, which the fact table deleted; it states its own support.",
      steps: [{ index: 1, ...stepParts(CHAIN_SEAT, 1) }],
    });
  }
  if (name === "gameReportReconsideration" && scenario.holdReport) {
    // The run is cancelled while this task runs; it answers only when its signal aborts.
    scenario.holdReport = false;
    const signal = context?.signal;
    if (signal !== undefined) scenario.heldSignals.push(signal);
    scenario.cancel?.abort(new WorkflowCancelledError());
    return new Promise<AgentResult>((resolve) => signal?.addEventListener("abort",
      () => resolve({ taskId: task.taskId, status: "error", error: { name: "AbortError", message: "The held task was aborted." } }), { once: true }));
  }
  if (name === "gameReportReconsideration" || name === "commentReconsideration") {
    const reason = `The report reconsidered its use of F:1 after the deletion and is ${scenario.decision}.`;
    if (scenario.decision !== "revised") return ok(task, { decision: scenario.decision, reason });
    if (name === "commentReconsideration") return ok(task, { decision: "revised", reason, comment: REVISED_COMMENT });
    return ok(task, { decision: "revised", reason, report: { q: 0, justification: "Without F:1 the reviewed step still shows no demonstrable flaw; this report cites no badge." } });
  }
  if (ASSESSORS.has(name) || CRITIQUES.has(name)) {
    scenario.trace.push(`${name} agent=${task.agentId ?? ""} step=${String(bindings.currentStep)} seat2step1=${String(seatTwoStepOne(bindings))} comments=${Object.keys(objectOf(bindings.comments)).join("|")}`);
  }
  if (ASSESSORS.has(name) && seatTwoStepOne(bindings)) {
    scenario.assessorCalls.push(path);
    if (!scenario.deleted && scenario.citing !== undefined && Object.hasOwn(objectOf(bindings.comments), scenario.citing.critic)) {
      await revoke(scenario.table!, task, name.startsWith("judge") ? "judge" : "committee-chair");
      scenario.deleted = true;
    }
  }
  const result = await offlineExecute.call(this, task);
  if (result.status !== "ok") return result;
  const output = objectOf(result.output);
  if (name === "brainIdeaParts" && task.agentId === CHAIN_SEAT) {
    const cot = Array.isArray(output.cot) ? [...output.cot] : [];
    const first = objectOf(cot[0]);
    cot[0] = { ...first, part2: `${String(first.part2)} [F:1]` };
    return { ...result, output: { ...output, cot } };
  }
  if (CRITIQUES.has(name) && JSON.stringify(bindings).includes(`${REPORT_SEAT} chain step 1 part`)) {
    const field = name === "gameCritique" ? "justification" : "reason";
    // A Build comment keeps the standard round from being a unanimous fast pass, so the judge is convened.
    const build: JsonObject = name === "commentParts" && JSON.stringify(bindings.verdictOptions ?? null).includes("Build")
      ? { verdict: "Build", suggestion: "Rest the step on the stated sign condition." } : {};
    const cite = (): AgentResult => ({ ...result, output: { ...output, [field]: `${String(output[field])} [F:1]`, ...build } });
    if (scenario.citing === undefined && seatTwoStepOne(bindings)) {
      scenario.citing = { path, critic: task.agentId ?? "" };
      return cite();
    }
    if (scenario.fineLater && scenario.deleted && scenario.late === undefined && name === "gameCritique") {
      scenario.late = { path, critic: task.agentId ?? "" };
      return cite();
    }
  }
  return result;
}

function runtimeFor(root: string, bundle: ContentBundle, contentDir: string, runId: string, seam: { readonly table: FileFactTable; readonly logPath: string }) {
  const seed = localTaxonomySeedPath(contentDir);
  return buildRuntime({
    providerConfig: { provider: "offline" },
    checkpoints: new FsCheckpointStore(root),
    artifacts: new FsArtifactStore(root, runId),
    autoApproveGates: true,
    ...(existsSync(seed) ? { taxonomy: new LocalTaxonomyService(seed, join(root, `taxonomy-${runId}`)) } : {}),
    bundle,
    factTableForTests: seam,
  });
}

async function journalOf(root: string, runId: string): Promise<JsonObject[]> {
  const checkpoint = await new FsCheckpointStore(root).load(runId);
  assert.ok(checkpoint, `checkpoint of ${runId}`);
  return checkpoint.journal.map((entry) => ({ key: entry.key, value: entry.value ?? null }));
}

async function settlementsOf(root: string, runId: string): Promise<Map<string, JsonObject>> {
  return new Map((await journalOf(root, runId))
    .filter((entry) => String(entry.key).endsWith("/game-settle-run::result") && objectOf(entry.value).ruleVersion === "brier-peer/v3")
    .map((entry) => [String(entry.key), objectOf(entry.value)] as const));
}

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 10_000 && !condition(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "the condition never held");
}

/** The fact-update journal beside the run's fact log. */
function updatesOf(root: string, runId: string): JsonObject[] {
  const path = join(root, runId, "fact-updates.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as JsonObject);
}

/** The journaled merge outputs that merged `key`. */
async function mergesOf(root: string, runId: string, key: string): Promise<JsonObject[]> {
  return (await journalOf(root, runId)).map((entry) => objectOf(entry.value))
    .filter((value) => Array.isArray(value.merged) && (value.merged as JsonValue[]).some((entry) => objectOf(entry).key === key));
}

/** One scenario's run; the content must declare fact updates. */
async function scenarioRun(decision: Decision, review: "game" | "standard", extra: ScenarioExtra,
  check: (context: { readonly root: string; readonly runId: string; readonly bundle: ContentBundle; readonly contentDir: string;
    readonly seam: { readonly table: FileFactTable; readonly logPath: string }; readonly result: Awaited<ReturnType<ReturnType<typeof buildRuntime>["run"]>> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "bsa-fact-updates-"));
  OfflineBrainstormExecutor.prototype.execute = wrappedExecute;
  try {
    const bundle = loadContent(sourceContentDir);
    const runId = `fact-updates-${review}-${decision}`;
    const seam = await seededTable(root, runId, bundle);
    scenario = freshScenario(decision, extra);
    scenario.table = seam.table;
    const result = await runtimeFor(root, bundle, sourceContentDir, runId, seam)
      .run({ runId, submission: SUBMISSION, params: review === "game" ? GAME_PARAMS : STANDARD_PARAMS,
        ...(scenario.cancel !== undefined ? { signal: scenario.cancel.signal } : {}) });
    await check({ root, runId, bundle, contentDir: sourceContentDir, seam, result });
  } finally {
    OfflineBrainstormExecutor.prototype.execute = offlineExecute;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Common checks: one deletion, one notice with exactly the two subscribers, both tasks started before either finished. */
async function checkNotice(root: string, runId: string, table: FileFactTable, reportKey: string): Promise<JsonObject[]> {
  assert.deepEqual((await table.deletions()).map((deletion) => [deletion.id, deletion.seq, deletion.replacedBy ?? null]), [["F:1", 1, "F:2"]]);
  const lines = updatesOf(root, runId);
  const notices = lines.filter((line) => line.type === "notice");
  assert.equal(notices.length, 1, "one notice");
  assert.deepEqual([...(notices[0]!.subscribers as string[])].sort(), [`chain:${CHAIN_SEAT}`, reportKey, SEEDER_NONE].sort());
  const tasks = lines.filter((line) => line.type === "task");
  assert.deepEqual(tasks.slice(0, 2).map((line) => line.key).sort(), [`chain:${CHAIN_SEAT}`, reportKey].sort());
  const firstResult = lines.findIndex((line) => line.type === "result");
  assert.ok(firstResult > lines.indexOf(tasks[1]!), "both reconsideration tasks started before either finished");
  return lines;
}

const gameReportKey = (): string => `game-report:${REPORT_SEAT}:1:1:${scenario.citing!.critic}`;
const roundOf = (path: string): string => path.slice(0, path.indexOf("/gather-game-comments/"));

test("fact updates 32: a revocation during the chair's assessment revises the report and the chain; the chair re-assesses once; a later citation is fined",
  { skip: SKIP }, async () => {
  await scenarioRun("revised", "game", { fineLater: true }, async ({ root, runId, seam, result }) => {
    assert.equal(result.status, "completed", failure(result));
    assert.ok(scenario.citing !== undefined && scenario.deleted, "the report cited F:1 and the ruling deleted it");
    const lines = await checkNotice(root, runId, seam.table, gameReportKey());
    assert.deepEqual(lines.filter((line) => line.type === "result").map((line) => [line.taskId, line.status, objectOf(line.output).decision]).sort(),
      [[`fact-update:chain:${CHAIN_SEAT}:1`, "ok", "revised"], [`fact-update:${gameReportKey()}:1`, "ok", "revised"]].sort());
    assert.equal(scenario.assessorCalls.length, 2, `the chair assessed and re-assessed once: ${scenario.assessorCalls.join(", ")}`);
    assert.ok(scenario.assessorCalls[1]!.includes("game-chair-reassess"));
    assert.equal(scenario.executed.filter((entry) => entry.includes("game-chair-reassess")).length, 1);
    assert.equal((await mergesOf(root, runId, `chain:${CHAIN_SEAT}`)).length, 1, "the chain's reconsideration merged once");
    const late = (await mergesOf(root, runId, gameReportKey())).filter((value) => value.reassess === true);
    assert.equal(late.length, 1, "the late merge asked for the re-assessment");
    const settlements = await settlementsOf(root, runId);
    const roundKey = [...settlements.keys()].find((key) => key.startsWith(`${roundOf(scenario.citing!.path)}/`));
    assert.ok(roundKey !== undefined, "the round settled");
    const row = rowsOf(settlements.get(roundKey)!).find((entry) => entry.criticId === scenario.citing!.critic);
    assert.ok(row !== undefined && row.admissible === true && row.penalty === undefined, "the revised report is admitted and not fined");
    assert.ok(scenario.late !== undefined, "a later critique on the seat cited F:1");
    const fined = [...settlements.values()].flatMap((settlement) => rowsOf(settlement)).filter((entry) => entry.penalty !== undefined);
    assert.equal(fined.length, 1, "only the later citation is fined");
    assert.deepEqual([fined[0]!.criticId, fined[0]!.penalty, fined[0]!.deletedBadges, fined[0]!.score, fined[0]!.admissible],
      [scenario.late.critic, "deleted-badge", ["F:1"], -175, false]);
    assert.ok(String(fined[0]!.reason).endsWith(`Host verification: ${DELETED_TEXT}.`), String(fined[0]!.reason));
  });
});

test("fact updates 33: a report withdrawn after the deletion has no settlement row; the chair re-assesses once", { skip: SKIP }, async () => {
  await scenarioRun("withdrawn", "game", {}, async ({ root, runId, seam, result }) => {
    assert.equal(result.status, "completed", failure(result));
    await checkNotice(root, runId, seam.table, gameReportKey());
    assert.equal(scenario.assessorCalls.length, 2, scenario.assessorCalls.join(", "));
    assert.equal(scenario.executed.filter((entry) => entry.includes("game-chair-reassess")).length, 1);
    const settlements = await settlementsOf(root, runId);
    const roundKey = [...settlements.keys()].find((key) => key.startsWith(`${roundOf(scenario.citing!.path)}/`));
    assert.ok(roundKey !== undefined, "the round settled");
    assert.ok(rowsOf(settlements.get(roundKey)!).every((entry) => entry.criticId !== scenario.citing!.critic), "the withdrawn report has no row");
    assert.ok([...settlements.values()].every((settlement) => rowsOf(settlement).every((entry) => entry.penalty === undefined)));
  });
});

test("fact updates 34: a report kept unchanged is rejected without a score, and the chair does not re-assess", { skip: SKIP }, async () => {
  await scenarioRun("unchanged", "game", {}, async ({ root, runId, seam, result }) => {
    assert.equal(result.status, "completed", failure(result));
    await checkNotice(root, runId, seam.table, gameReportKey());
    assert.equal(scenario.assessorCalls.length, 1, scenario.assessorCalls.join(", "));
    assert.equal(scenario.executed.filter((entry) => entry.includes("game-chair-reassess")).length, 0);
    const settlements = await settlementsOf(root, runId);
    const roundKey = [...settlements.keys()].find((key) => key.startsWith(`${roundOf(scenario.citing!.path)}/`));
    assert.ok(roundKey !== undefined, "the round settled");
    const row = rowsOf(settlements.get(roundKey)!).find((entry) => entry.criticId === scenario.citing!.critic)!;
    assert.deepEqual([row.admissible, row.score, Object.hasOwn(row, "penalty")], [false, null, false]);
    assert.ok(String(row.reason).includes(AFTER_TEXT), String(row.reason));
  });
});

test("fact updates 35: in the standard review a revised comment brings the judge's single re-assessment; a withdrawal that leaves a unanimous Pass re-assesses as a fast pass",
  { skip: SKIP }, async () => {
  const commentKey = (): string => `comment:${REPORT_SEAT}:1:1:${scenario.citing!.critic}`;
  await scenarioRun("revised", "standard", {}, async ({ root, runId, seam, result }) => {
    assert.equal(result.status, "completed", failure(result));
    assert.ok(scenario.citing !== undefined && scenario.deleted,
      `the comment cited F:1 and the ruling deleted it: ${JSON.stringify(scenario.citing)} ${scenario.trace.slice(0, 24).join("; ")}`);
    const lines = await checkNotice(root, runId, seam.table, commentKey());
    assert.ok(lines.some((line) => line.type === "result" && line.taskId === `fact-update:${commentKey()}:1` && objectOf(line.output).decision === "revised"));
    const merges = await mergesOf(root, runId, commentKey());
    assert.equal(merges.filter((value) => value.reassess === true).length, 1, JSON.stringify(merges));
    assert.equal(scenario.assessorCalls.length, 2, scenario.assessorCalls.join(", "));
    assert.ok(scenario.assessorCalls[1]!.includes("judge-reassess"));
    assert.equal(scenario.executed.filter((entry) => entry.includes("judge-reassess")).length, 1);
  });
  await scenarioRun("withdrawn", "standard", {}, async ({ root, runId, seam, result }) => {
    assert.equal(result.status, "completed", failure(result));
    assert.ok(scenario.citing !== undefined && scenario.deleted, "the comment cited F:1 and the ruling deleted it");
    await checkNotice(root, runId, seam.table, commentKey());
    assert.equal((await mergesOf(root, runId, commentKey())).filter((value) => value.reassess === true).length, 1);
    assert.ok((await journalOf(root, runId)).some((entry) => String(entry.key).endsWith("/maybe-judge-reassess/then/judge-reassess-execute::result")),
      "the re-assessment is recorded");
    assert.equal(scenario.assessorCalls.length, 1, "the remaining comments all pass: the re-assessment is a fast pass, with no judge call");
    assert.equal(scenario.executed.filter((entry) => entry.includes("judge-reassess")).length, 0);
  });
});

test("fact updates 36: a run stopped by a failed reconsideration resumes; only the unfinished task runs again", { skip: SKIP }, async () => {
  await scenarioRun("revised", "game", { failChainOnce: true }, async ({ root, runId, bundle, contentDir, seam, result }) => {
    assert.equal(result.status, "failed");
    assert.match(failure(result) ?? "", /fact-update task fact-update:chain:member-1:1 failed: The worker stopped during the chain's reconsideration\./);
    const reportKey = gameReportKey();
    const table = new FileFactTable({ logPath: seam.logPath, limits: bundle.factTable!.limits, updates: "delete-or-replace/v1" });
    const resumed = await runtimeFor(root, bundle, contentDir, runId, { table, logPath: seam.logPath }).resume(runId);
    assert.equal(resumed.status, "completed", failure(resumed));
    const lines = updatesOf(root, runId);
    assert.equal(lines.filter((line) => line.type === "notice").length, 1, "the notice is not composed again");
    const taskIds = lines.filter((line) => line.type === "task").map((line) => String(line.taskId));
    assert.deepEqual([taskIds.slice(0, 2).sort(), taskIds.slice(2)],
      [[`fact-update:chain:${CHAIN_SEAT}:1`, `fact-update:${reportKey}:1`].sort(), [`fact-update:chain:${CHAIN_SEAT}:2`]]);
    assert.equal(scenario.executed.filter((entry) => entry.startsWith("gameReportReconsideration ")).length, 1, "the finished report task is not run again");
    assert.equal(scenario.executed.filter((entry) => entry.startsWith("chainReconsiderationParts ")).length, 2);
    assert.equal((await mergesOf(root, runId, `chain:${CHAIN_SEAT}`)).length, 1);
    const settlements = await settlementsOf(root, runId);
    const roundKey = [...settlements.keys()].find((key) => key.startsWith(`${roundOf(scenario.citing!.path)}/`));
    assert.ok(roundKey !== undefined, "the round settled once");
    const row = rowsOf(settlements.get(roundKey)!).find((entry) => entry.criticId === scenario.citing!.critic);
    assert.ok(row !== undefined && row.admissible === true && row.penalty === undefined);
  });
});

test("fact updates D16: a run cancelled while a reconsideration task runs aborts that task; the resume runs it again at its merge point",
  { skip: SKIP, timeout: 180_000 }, async () => {
  await scenarioRun("revised", "game", { holdReport: true }, async ({ root, runId, bundle, contentDir, seam, result }) => {
    assert.equal(result.status, "cancelled", failure(result));
    const reportKey = gameReportKey();
    const resultOf = (taskId: string) => updatesOf(root, runId).find((line) => line.type === "result" && line.taskId === taskId);
    await until(() => resultOf(`fact-update:${reportKey}:1`) !== undefined);
    assert.deepEqual([resultOf(`fact-update:${reportKey}:1`)!.status, resultOf(`fact-update:${reportKey}:1`)!.error], ["error", "workflow run was cancelled"],
      "the running task stopped with the run");
    assert.ok(scenario.heldSignals.length === 1 && scenario.heldSignals[0]!.aborted, "its executor's signal aborted");
    // The cancelled invocation's offline calls in flight settle before the resume.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const table = new FileFactTable({ logPath: seam.logPath, limits: bundle.factTable!.limits, updates: "delete-or-replace/v1" });
    const resumed = await runtimeFor(root, bundle, contentDir, runId, { table, logPath: seam.logPath }).resume(runId);
    assert.equal(resumed.status, "completed", failure(resumed));
    const reportTasks = updatesOf(root, runId).filter((line) => line.type === "task" && String(line.key) === reportKey).map((line) => line.taskId);
    assert.deepEqual(reportTasks, [`fact-update:${reportKey}:1`, `fact-update:${reportKey}:2`], "the aborted task ran once more, on resume");
    assert.equal(resultOf(`fact-update:${reportKey}:2`)?.status, "ok");
    assert.equal(scenario.executed.filter((entry) => entry.startsWith("gameReportReconsideration ")).length, 2);
    assert.equal(scenario.executed.filter((entry) => entry.includes("game-chair-reassess")).length, 1, "the chair re-assessed once");
    const settlements = await settlementsOf(root, runId);
    const roundKey = [...settlements.keys()].find((key) => key.startsWith(`${roundOf(scenario.citing!.path)}/`));
    assert.ok(roundKey !== undefined, "the round settled");
    const row = rowsOf(settlements.get(roundKey)!).find((entry) => entry.criticId === scenario.citing!.critic);
    assert.ok(row !== undefined && row.admissible === true && row.penalty === undefined, "the revised report is admitted and not fined");
  });
});
