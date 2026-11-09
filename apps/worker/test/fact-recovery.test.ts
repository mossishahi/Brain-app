import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadContent, skillMetaSchema, workflowSchema, type ContentBundle, type FactTableCatalog, type Skill } from "@brainstorm-agentic/content";
import { Scope, type AgentExecutor, type AgentTask, type FactDeletion, type FactEntry, type FactUpdateEvent, type JsonObject, type JsonValue } from "@brainstorm-agentic/core";
import { BRAINSTORM_STATE, compileContentWorkflow, StaticBrainstormRouteResolver, applyChainReconsideration, applyRecoveryChoice, recoveryTarget, validateRecoveryChoice,
  type CompiledContentWorkflow, type RecoveryChoice } from "@brainstorm-agentic/brainstorm-runtime";
import { FactUpdateSpawner, type FactUpdateTable } from "../src/fact-updates.js";

const CONTROL: FactTableCatalog = {
  version: "0.2.0",
  accessMode: "supreme-mediated/v1",
  consultation: { skill: "supreme_judge_consult", route: "reasoning", output: "factConsultation" },
  verifier: { skill: "supreme_judge", route: "reasoning", output: "factVerdict" },
  updates: "delete-or-replace/v1",
  reconsideration: {
    chain: { skill: "reconsider-chain", route: "reasoning", output: "chainReconsiderationParts" },
    gameReport: { skill: "reconsider-game-report", route: "reasoning", output: "gameReportReconsideration" },
    comment: { skill: "reconsider-comment", route: "reasoning", output: "commentReconsideration" },
  },
  cases: {
    justified: "An entry of the table already covers the claim.",
    "justified-new": "Verified now; a new badge enters the table.",
    narrowed: "True only under narrower conditions; a badge for the narrowed claim.",
    conflict: "It contradicts an entry that stands.",
    refuted: "The evidence shows it false; nothing enters the table.",
    unverified: "It could not be checked with the verifier's tools or time.",
    "not-a-fact": "An opinion, a design choice, or connective reasoning that asserts no independently checkable claim.",
  },
  methods: {
    "re-executed": "The verifier ran the computation itself.",
    "source-quoted": "The verifier quotes the source that states the fact.",
    "record-match": "The verifier matched the value against the run's record.",
    "judgement-only": "The verifier worked the argument through itself.",
    none: "Nothing was checked.",
  },
  resolutions: {
    "incumbent-stands": "The entry holds and the submission is rejected.",
    "incumbent-revoked": "The entry is deleted and the new badge replaces it.",
    "both-narrowed": "Both hold, each under its own conditions.",
    disputed: "Neither can be settled; both are disputed.",
  },
  limits: { submissionsPerTask: 6, relatedFacts: 8, lookupResults: 5, verificationMinutes: 30 },
};

const RECONSIDERATION_VARS = {
  chain: ["input", "files", "department", "umbrella", "subfields", "board", "chain", "previousOutput", "factUpdates", "totalSteps", "type", "shape", "shapeGuide"],
  gameReport: ["input", "files", "department", "umbrella", "subfields", "shape", "chain", "currentStep", "type", "report", "factUpdates"],
  comment: ["input", "files", "department", "umbrella", "subfields", "shape", "chain", "currentStep", "type", "comment", "factUpdates", "verdictOptions", "verdictCatalog"],
} as const;

function role(name: string, vars: readonly string[], output: string, payload: readonly string[] = vars): Skill {
  return {
    meta: skillMetaSchema.parse({ name, kind: "role", description: `The ${name} fixture role.`, vars, payload, capabilities: ["fact-table"], output }),
    body: [`Do the ${name} work on the task data.`, ...vars.filter((name) => !payload.includes(name)).map((name) => `{{${name}}}`)].join("\n\n"),
    sourcePath: `test/${name}.md`,
  };
}

const MERGES = [
  ["facts.mergeChain", "idea", "artifact", "brainIdeaParts"],
  ["facts.mergeGameReports", "critiques", "artifactCollection", "gameCritique"],
  ["facts.mergeLateGameReports", "critiques", "artifactCollection", "gameCritique"],
  ["facts.mergeComments", "comments", "artifactCollection", "commentParts"],
  ["facts.mergeLateComments", "comments", "artifactCollection", "commentParts"],
  ["facts.mergeIdeas", "ideas", "artifactCollection", "brainIdeaParts"],
  ["facts.closeUpdates", "ideas", "artifactCollection", "brainIdeaParts"],
] as const;

function bundle(): ContentBundle {
  return {
    workflows: {},
    routes: {
      version: "0.1.0",
      defaultRoute: "reasoning",
      routes: { reasoning: { description: "Careful multi-step reasoning.", traits: ["extended-reasoning"] } },
    },
    activities: {
      version: "0.1.0",
      handlers: Object.fromEntries(MERGES.map(([name, input, kind, schema]) => [name, {
        description: `The ${name} merge point.`,
        deterministic: true as const,
        inputs: { [input]: { kind, schema } },
        outputSchema: "factUpdateMerge",
      }])) as ContentBundle["activities"]["handlers"],
    },
    capabilities: {
      version: "0.1.0",
      capabilities: {
        "fact-table": {
          description: "Consult the run's fact table.",
          contract: "The runtime keeps one fact table per run.",
          operations: ["fact.lookup", "fact.status", "fact.submit", "fact.approve"],
          whenUnavailable: "Cite no badges; state your own evidence.",
        },
      },
    },
    catalogs: {
      inputTypes: { version: "0.1.0", types: {}, shapes: { "research idea": "paper" }, guidance: {}, outlines: {}, shapeGuides: { "research idea": "Write it as a paper." } },
      verdicts: {
        version: "0.1.0",
        verdicts: {},
        sequencing: { noImmediateRepeat: [], advanceOn: "Pass", redevelopOn: ["Build"] },
      },
      departments: { version: "0.1.0", groups: {} },
    },
    skills: {
      "reconsider-chain": role("reconsider-chain", RECONSIDERATION_VARS.chain, "chainReconsiderationParts"),
      "reconsider-game-report": role("reconsider-game-report", RECONSIDERATION_VARS.gameReport, "gameReportReconsideration"),
      "reconsider-comment": role("reconsider-comment", RECONSIDERATION_VARS.comment, "commentReconsideration"),
      critic: role("critic", ["chain", "currentStep"], "gameCritique"),
      commentor: role("commentor", ["chain", "currentStep"], "commentParts"),
      chair: role("chair", ["chain", "comments", "currentStep"], "gameCommitteeDecision"),
    },
    factTable: CONTROL,
  } as ContentBundle;
}


const RUN = "v2-recovery";
const signal = new AbortController().signal;
const part = (text: string) => ({ part1: text, part2: "A direct deduction.", part3: "Check its assumptions.", part4: "Consequence." });
const idea = (claim = "The bound holds [F:7]."): JsonObject => ({ cot: [part(claim), part("An intermediate consequence."), part("The resulting conclusion.")],
  output: { type: "research idea", paper: { abstract: ["A.", "A2.", "A3."], introduction: ["I.", "I2.", "I3."], method: ["M.", "M2.", "M3."], discussion: ["D.", "D2.", "D3."], conclusion: ["C."] } } });
const panel = { members: [{ id: "member-1", department: "Mathematics", umbrella: "Geometry", subfields: [] },
  { id: "member-2", department: "Computing", umbrella: "Learning", subfields: [] }] };
const BRIDGE = { noveltyAudit: [], contradictions: [], seams: [] };
const PROPOSAL = { title: "Corrected result", framing: "The revised argument is valid.", consensus: ["Use the verified result."], tensions: [], novelDirections: [],
  actionItems: [{ priority: 1, action: "Verify the next consequence." }], applications: [] };
function version2Bundle(): ContentBundle {
  const base = bundle();
  return { ...base, routes: { ...base.routes, routes: { ...base.routes.routes, writing: { description: "Write", traits: [] } } },
    factTable: { ...CONTROL, accessMode: "supreme-dialogue/v2", reconsideration: { ...CONTROL.reconsideration!, revoker: { skill: "revoker", route: "reasoning", output: "revokerPlan" } } },
    skills: { ...base.skills,
      revoker: role("revoker", ["input", "files", "factUpdates", "targets"], "revokerPlan"),
      "reconsider-chain": role("reconsider-chain", [...RECONSIDERATION_VARS.chain, "recoveryPlan"], "chainReconsiderationParts"),
      "reconsider-game-report": role("reconsider-game-report", [...RECONSIDERATION_VARS.gameReport, "recoveryPlan"], "gameReportReconsideration"),
      "reconsider-comment": role("reconsider-comment", [...RECONSIDERATION_VARS.comment, "recoveryPlan"], "commentReconsideration"),
      "game-commentor": role("game-commentor", ["input", "files", "department", "umbrella", "subfields", "shape", "chain", "currentStep", "type", "criticState"], "gameCritique"),
      "committee-chair": role("committee-chair", ["input", "files", "chain", "comments", "currentStep", "type", "shape", "typeGuidance"], "gameCommitteeDecision"),
      integrator: role("integrator", ["input", "files", "roster", "ideas", "type"], "bridgeReport"),
      chair: role("chair", ["input", "files", "roster", "ideas", "bridge", "type", "shape"], "finalProposal"),
    } };
}
const workflow = workflowSchema.parse({ apiVersion: "brainstorm.workflow/v1", name: "recovery", version: "0.31.0", description: "Recovery fixture",
  root: { kind: "sequence", id: "root", steps: [{ kind: "activity", id: "finalize", handler: "facts.closeUpdates", bind: { ideas: "ideas" },
    output: { key: "factUpdates", schema: "factUpdateMerge" } }, { kind: "terminal", id: "done", result: "proposal" }] } });
class Table implements FactUpdateTable {
  list: FactUpdateEvent[] = [];
  async deletionEpoch() { return this.list.length; }
  async deletions() { return this.list.map((event) => event.deletion); }
  async updateEvents() { return this.list; }
  remove(id = "F:7"): FactUpdateEvent {
    const entry: FactEntry = { id, status: "justified", kind: "math", claim: "Old bound", conditions: "Before correction", method: "judgement-only", evidence: "Proof",
      createdAt: 1, updatedAt: 1, history: [], requesters: [] };
    const event: FactUpdateEvent = { deletion: { id, seq: this.list.length + 1, at: 10 }, entry, reason: "Counterexample", submission: "S:3",
      replacement: { ...entry, id: "F:12", claim: "Corrected bound" } };
    this.list.push(event); return event;
  }
}
async function fixture(options: { path?: string; table?: Table; old?: JsonObject; blocked?: boolean; unresolved?: boolean; invalidRepair?: boolean; invalidPlan?: boolean; haltAfterRepair?: boolean } = {}) {
  const table = options.table ?? new Table();
  const compiled = compileContentWorkflow({ bundle: version2Bundle(), workflow,
    routeResolver: new StaticBrainstormRouteResolver({ reasoning: { modelId: "test-reasoner" }, writing: { modelId: "test-writer" } }),
    readGameEvidence: async () => ({ facts: [], approvals: [], deletions: await table.deletions() }) });
  const old = options.old ?? idea();
  const state: JsonObject = { input: { title: "Bound", type: "research idea", cotSteps: 3 }, usefulFiles: { files: [] }, panel,
    params: { gameDecisionThreshold: 0.5, gameDecisionRule: "chair-decisive", gameInitialPoints: 200 }, ideas: { "member-1": old, "member-2": idea("An unrelated argument.") },
    bridge: BRIDGE, proposal: { ...PROPOSAL, title: "Original" }, _runtime: { artifacts: {} } };
  const index = compiled.factUpdateIndex!;
  index.noteRunData(RUN, state);
  for (const [id, output] of Object.entries(state.ideas as JsonObject)) index.setIdea(RUN, id, output as JsonObject);
  const calls: AgentTask[] = [];
  let hook: ((task: AgentTask) => void) | undefined;
  const executor: AgentExecutor = { execute: async (task, context) => {
    calls.push(task); hook?.(task);
    const bindings = (task.input as JsonObject).bindings as JsonObject;
    let output: JsonValue;
    switch (task.kind) {
      case "brainstorm.revoker": {
        const targets = bindings.targets as JsonObject[];
        output = { reason: "Inspect direct and conceptual dependencies.", changes: targets.filter((target) => target.targetKey === "chain:member-1").map((target) => ({
          targetKey: target.targetKey!, base: options.invalidPlan ? { artifactHash: "wrong-version" } : target.base!, action: "redevelop", steps: [1], sections: [], rationale: "The withdrawn bound is a necessary premise." })),
          unaffected: targets.filter((target) => target.targetKey !== "chain:member-1").map((target) => ({ targetKey: target.targetKey!, base: target.base!, rationale: "This argument does not depend on the withdrawn premise." })) };
        break;
      }
      case "brainstorm.reconsider-chain": output = options.invalidRepair ? { decision: "unchanged", reason: "The author ignored the required repair.", steps: [] }
        : { decision: "revised", reason: "Use the corrected premise.", steps: [{ index: 1, ...part("The corrected bound follows directly.") }] }; break;
      case "brainstorm.game-commentor":
        if (options.haltAfterRepair) await new Promise<void>((_resolve, reject) => context.signal!.addEventListener("abort", () => reject(new Error("simulated shutdown")), { once: true }));
        output = { q: options.blocked ? 0.9 : 0.1, justification: "The revised inference is directly inspectable." }; break;
      case "brainstorm.committee-chair": output = { reports: Object.fromEntries(Object.keys(bindings.comments as JsonObject).map((id) => [id,
        { admissible: !options.unresolved, reason: "The inference follows.", label: options.blocked && calls.filter((call) => call.kind === "brainstorm.revoker").length === 1 ? "decisive" : "not-decisive", factChecks: [] }])), reason: "Assessment of every submitted argument." }; break;
      case "brainstorm.integrator": output = BRIDGE; break;
      case "brainstorm.chair": output = PROPOSAL; break;
      default: throw new Error(`Unexpected ${task.kind}`);
    }
    return { taskId: task.taskId, status: "ok", output };
  } };
  const path = options.path ?? join(await mkdtemp(join(tmpdir(), "revoker-test-")), "updates.jsonl");
  const spawner = new FactUpdateSpawner({ runId: RUN, journalPath: path, table, compiled, executor });
  compiled.attachFactUpdates!(spawner);
  const merge = () => spawner.merge({ runId: RUN, nodePath: "root/recovery", point: "ideas", signal });
  return { table, compiled, index, state, calls, path, spawner, merge, hook: (next: (task: AgentTask) => void) => { hook = next; } };
}
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(check()); }

test("real v2 compiler and spawner: Revoker scopes edits, closed positions re-review, scores unchanged, final proposal folded", async () => {
  const f = await fixture();
  f.index.openReport(RUN, { key: "game-report:member-1:2:1:member-2", kind: "game-report", seat: "member-1", step: 2, round: 1, critic: "member-2",
    report: { q: 0.9, justification: "Original adverse report [F:7]" }, prefix: (idea().cot as JsonValue[]).slice(0, 2) });
  f.index.closeRound(RUN, "game-report", "member-1", 2, 1);
  const before = f.compiled.gameReviewLedger.dispatch(RUN, "same", "member-2", panel, 200);
  f.spawner.onDeletion(f.table.remove());
  const scope = Scope.root({ [BRAINSTORM_STATE]: f.state });
  const ctx = { runId: RUN, nodePath: "root/finalize", signal };
  const merged = await f.compiled.functions.activity("brainstorm.recovery.finalize.run")(undefined, scope, ctx) as JsonObject;
  scope.set("__brainstorm:finalize:output", merged);
  const final = await f.compiled.functions.activity("brainstorm.recovery.finalize.apply")(undefined, scope, ctx) as JsonObject;
  assert.equal((final.proposal as JsonObject).title, "Corrected result");
  assert.deepEqual((final.ideas as JsonObject)["member-2"], (f.state.ideas as JsonObject)["member-2"]);
  assert.deepEqual(((final.ideas as JsonObject)["member-1"] as JsonObject).cot, [part("The corrected bound follows directly."), ...(idea().cot as JsonValue[]).slice(1)]);
  const recovery = (merged.merged as JsonObject[]).find((entry) => entry.key === "chain:member-1")!.recovery as JsonObject;
  assert.equal((recovery.certificates as JsonValue[]).length, 3, "all dependent suffix steps including closed positions are re-reviewed");
  assert.equal(f.calls.filter((task) => task.kind === "brainstorm.revoker").length, 1);
  assert.equal(f.calls.filter((task) => task.kind === "brainstorm.reconsider-chain").length, 1, "unaffected seat has no author call");
  assert.equal(f.calls.filter((task) => task.kind === "brainstorm.game-commentor").length, 3);
  assert.deepEqual(f.compiled.gameReviewLedger.dispatch(RUN, "same", "member-2", panel, 200), before, "recovery never commits points");
  assert.ok(f.calls.filter((task) => task.kind === "brainstorm.game-commentor").every((task) => !((task.metadata?.factScope as JsonObject).blindReview)));
  assert.ok(f.index.isClosed(RUN));
});

test("conceptual dependency without any badge is offered to Revoker and repaired", async () => {
  const f = await fixture({ old: idea("The unnamed bound determines this conclusion.") });
  f.spawner.onDeletion(f.table.remove());
  const merged = await f.merge();
  assert.equal((merged.merged as JsonObject[]).length, 2);
  const revoker = f.calls.find((task) => task.kind === "brainstorm.revoker")!;
  assert.equal((((revoker.input as JsonObject).bindings as JsonObject).targets as JsonValue[]).length, 2);
  assert.equal(f.calls.filter((task) => task.kind === "brainstorm.reconsider-chain").length, 1);
});

test("blocked recovery returns actual scientific feedback to Revoker and obtains a new validated generation", async () => {
  const f = await fixture({ blocked: true }); f.spawner.onDeletion(f.table.remove());
  const merged = await f.merge();
  const revokers = f.calls.filter((task) => task.kind === "brainstorm.revoker");
  assert.equal(revokers.length, 2);
  const retryTargets = ((revokers[1]!.input as JsonObject).bindings as JsonObject).targets as JsonObject[];
  assert.equal(retryTargets.length, 1, "only the rejected target remains actionable on this retry");
  assert.equal(retryTargets[0]!.targetKey, "chain:member-1");
  assert.ok(retryTargets[0]!.recoveryFeedback);
  assert.ok((retryTargets[0]!.relatedTargets as JsonObject[]).some((target) => target.targetKey === "chain:member-2"));
  assert.notEqual(revokers[0]!.taskId, revokers[1]!.taskId);
  assert.ok((merged.merged as JsonObject[]).length > 0);
});

test("unresolved recovery cannot publish a patch or a final proposal", async () => {
  const f = await fixture({ unresolved: true }); f.spawner.onDeletion(f.table.remove());
  await assert.rejects(f.merge(), /Recovery review unresolved/);
  assert.deepEqual(f.index.idea(RUN, "member-1"), idea());
  assert.equal(f.calls.filter((task) => task.kind === "brainstorm.chair").length, 0);
});

test("successful Revoker and repair calls survive a crash before re-review", async () => {
  const f = await fixture({ haltAfterRepair: true }); f.spawner.onDeletion(f.table.remove());
  const pending = f.merge();
  await until(() => f.calls.some((task) => task.kind === "brainstorm.game-commentor"));
  f.spawner.close(); await assert.rejects(pending);
  const next = await fixture({ path: f.path, table: f.table });
  const merged = await next.merge();
  assert.ok((merged.merged as JsonObject[]).length > 0);
  assert.equal(next.calls.filter((task) => task.kind === "brainstorm.revoker" || task.kind === "brainstorm.reconsider-chain").length, 0);
  const journal = (await readFile(f.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(journal.some((entry) => entry.type === "recovery-review"));
});

test("withdrawal during recovery invalidates its generation and causes a fresh decision", async () => {
  const f = await fixture(); let changed = false;
  f.hook((task) => { if (!changed && task.kind === "brainstorm.game-commentor") { changed = true; f.spawner.onDeletion(f.table.remove("F:8")); } });
  f.spawner.onDeletion(f.table.remove());
  const merged = await f.merge();
  assert.ok((merged.merged as JsonObject[]).some((entry) => entry.key === "chain:member-1"));
  assert.ok(f.calls.filter((task) => task.kind === "brainstorm.revoker").length >= 2);
  assert.ok((merged.discarded as JsonObject[]).length > 0);
});

test("Revoker plans cannot target a stale artifact or broaden a selected repair", async () => {
  const f = await fixture(); const target = recoveryTarget(f.index, RUN, "chain:member-1");
  const choice = { targetKey: "chain:member-1", base: { artifactHash: "stale" }, action: "redevelop", steps: [1], sections: [], rationale: "Fix premise" } as RecoveryChoice;
  assert.throws(() => validateRecoveryChoice(choice, target), /stale/);
});


test("withdrawal after final snapshot forces new conceptual assessment and synthesis", async () => {
  const f = await fixture(); let injected = false;
  const original = f.table.deletions.bind(f.table);
  f.table.deletions = async () => {
    if (!injected && f.calls.some((task) => task.kind === "brainstorm.chair")) { injected = true; f.spawner.onDeletion(f.table.remove("F:8")); }
    return original();
  };
  f.spawner.onDeletion(f.table.remove());
  const result = await f.spawner.merge({ runId: RUN, nodePath: "root/close", point: "close", signal });
  assert.ok(result.finalOutputs);
  assert.equal(f.calls.filter((task) => task.kind === "brainstorm.chair").length, 2, "post-snapshot withdrawal cannot reuse the old proposal");
});

test("substitution permits only citation changes; restart must redevelop output as well as all steps", async () => {
  const f = await fixture(); const target = recoveryTarget(f.index, RUN, "chain:member-1");
  const substitute = { targetKey: "chain:member-1", base: target.base as { artifactHash: string }, action: "substitute", steps: [1], sections: [], rationale: "Same claim", replacementFactId: "F:12" } as RecoveryChoice;
  const patch = { decision: "revised", reason: "Replace citation", steps: [{ index: 1, ...part("The bound holds [F:12].") }] };
  const result = applyRecoveryChoice(target, substitute, patch, ["F:7"]);
  assert.deepEqual((result.cot as JsonValue[]).slice(1), (idea().cot as JsonValue[]).slice(1));
  assert.throws(() => applyRecoveryChoice(target, substitute, { ...patch, steps: [...patch.steps, { index: 2, ...part("Unauthorized rewrite") }] }, ["F:7"]), /unauthorized step 2/);
  assert.throws(() => applyRecoveryChoice(target, substitute, { ...patch, steps: [{ index: 1, ...part("Changed science [F:12].") }] }, ["F:7"]), /substitution changed/);
  assert.throws(() => applyRecoveryChoice(target, { ...substitute, action: "redevelop" }, { decision: "unchanged", reason: "I disagree", steps: [] }, ["F:7"]), /must deliver a revision/);
  const restart = { ...substitute, action: "restart", steps: [1, 2, 3], sections: target.sections } as RecoveryChoice;
  assert.throws(() => applyRecoveryChoice(target, restart, { decision: "revised", reason: "New argument", steps: [1, 2, 3].map((index) => ({ index, ...part("Rewritten") })) }, ["F:7"]), /every developed output section/);
});

test("unaffected cache uses authored version, and open uncited reports are conceptually assessed", async () => {
  const f = await fixture({ old: { ...idea(), thinking: "Unneeded provider transcript" } });
  const target = recoveryTarget(f.index, RUN, "chain:member-1");
  f.index.noteMerge(RUN, { merged: [{ key: "chain:member-1", taskId: "unchanged", notices: ["N:1"], recovery: { artifactHash: (target.base as JsonObject).artifactHash! } }], discarded: [] });
  assert.deepEqual(f.index.citedBy(RUN, "chain:member-1", [{ id: "F:7", seq: 1 }]), []);
  f.index.openReport(RUN, { key: "game-report:member-1:2:1:member-2", kind: "game-report", seat: "member-1", step: 2, round: 1, critic: "member-2", epoch: 0,
    report: { q: 0.9, justification: "The unnamed premise is decisive." }, prefix: (idea().cot as JsonValue[]).slice(0, 2) });
  assert.ok(f.index.subscribersOf(RUN, "F:7", undefined, 1).subscribers.some((entry) => entry.kind === "game-report"));
});

test("actual candidate content control roles compile exact payloads including interdisciplinary recovery", { skip: !process.env.BRAIN_TEST_CONTENT_DIR }, async (t) => {
  const candidate = loadContent(process.env.BRAIN_TEST_CONTENT_DIR!);
  if (candidate.factTable?.accessMode !== "supreme-dialogue/v2") { t.skip("candidate is legacy"); return; }
  const compiled = compileContentWorkflow({ bundle: candidate, workflow,
    routeResolver: new StaticBrainstormRouteResolver({ reasoning: { modelId: "test" }, writing: { modelId: "test" }, balanced: { modelId: "test" } }) });
  const members = [...panel.members, { id: "member-3", department: "Interdisciplinary", umbrella: "Cross-field", subfields: [], seat: "interdisciplinary" }];
  const index = compiled.factUpdateIndex!;
  index.noteRunData(RUN, { input: { type: "research idea", cotSteps: 3 }, usefulFiles: { files: [] }, panel: { members }, params: { gameInitialPoints: 300 } });
  index.setIdea(RUN, "member-1", idea());
  const target = recoveryTarget(index, RUN, "chain:member-1");
  const choice = { targetKey: "chain:member-1", base: target.base as { artifactHash: string }, action: "redevelop", steps: [1], sections: [], rationale: "Repair" } as RecoveryChoice;
  const revoker = await compiled.factRevokerTask!({ runId: RUN, taskId: "revoker", notices: [], targets: [target] });
  assert.ok(revoker.allowedCapabilities?.includes("fact-table"));
  await compiled.factReconsiderationTask!({ runId: RUN, taskId: "repair", key: "chain:member-1", notices: [], recoveryPlan: choice });
  const critic = await compiled.factRecoveryReviewTask!({ runId: RUN, taskId: "critic", kind: "critic", seat: "member-1", idea: idea(), step: 1, criticId: "member-3" });
  assert.equal(critic.kind, "brainstorm.game-interdisciplinary-commentor");
  assert.equal((((critic.input as JsonObject).bindings as JsonObject).roster as JsonValue[]).length, 3);
  await compiled.factRecoveryReviewTask!({ runId: RUN, taskId: "chair", kind: "chair", seat: "member-1", idea: idea(), step: 1, reports: {} });
  await compiled.factFinalizationTask!({ runId: RUN, taskId: "bridge", stage: "bridge", ideas: { "member-1": idea() } });
  await compiled.factFinalizationTask!({ runId: RUN, taskId: "proposal", stage: "proposal", ideas: { "member-1": idea() }, bridge: BRIDGE });
});


test("invalid authored repair is never cached as success and resume replaces previously cached invalid output", async () => {
  for (const legacyCache of [false, true]) {
    const first = await fixture({ invalidRepair: true }); first.spawner.onDeletion(first.table.remove());
    await assert.rejects(first.merge(), /must deliver a revision/);
    const repair = first.calls.find((task) => task.kind === "brainstorm.reconsider-chain")!;
    const before = (await readFile(first.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(before.some((entry) => entry.type === "recovery-result" && entry.taskId === repair.taskId && entry.output), false);
    if (legacyCache) {
      await appendFile(first.path, JSON.stringify({ type: "recovery-result", taskId: repair.taskId,
        output: { decision: "unchanged", reason: "Old schema-only cache entry", steps: [] }, at: 1 }) + "\n");
    }
    const resumed = await fixture({ path: first.path, table: first.table });
    const result = await resumed.merge();
    assert.ok((result.merged as JsonObject[]).some((entry) => entry.key === "chain:member-1"));
    assert.equal(resumed.calls.filter((task) => task.kind === "brainstorm.revoker").length, 0, "valid plan is still reused");
    assert.equal(resumed.calls.filter((task) => task.kind === "brainstorm.reconsider-chain").length, 1, "invalid author output is executed again");
    if (legacyCache) {
      const after = (await readFile(first.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(after.some((entry) => entry.type === "recovery-invalidated" && entry.taskId === repair.taskId));
    }
  }
});

test("Revoker authority validation happens before its plan becomes a reusable success", async () => {
  const first = await fixture({ invalidPlan: true }); first.spawner.onDeletion(first.table.remove());
  await assert.rejects(first.merge(), /stale or unauthorized/);
  assert.equal(first.calls.filter((task) => task.kind === "brainstorm.reconsider-chain").length, 0);
  const plan = first.calls.find((task) => task.kind === "brainstorm.revoker")!;
  const records = (await readFile(first.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.some((entry) => entry.type === "recovery-result" && entry.taskId === plan.taskId && entry.output), false);
  const resumed = await fixture({ path: first.path, table: first.table });
  const result = await resumed.merge();
  assert.ok((result.merged as JsonObject[]).length > 0);
  assert.equal(resumed.calls.filter((task) => task.kind === "brainstorm.revoker").length, 1);
});
