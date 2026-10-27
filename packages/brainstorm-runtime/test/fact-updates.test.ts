/**
 * Fact updates on the runtime side (spec/fact-updates.md v2 with decisions
 * D1-D15; section 10 tests 17-25): the subscriber index and its replay, the
 * merge points' folds, the round's chair task ids, the reconsideration tasks
 * the compiled workflow builds, and their retryable validation. Merge points
 * and stores are driven through the compiled workflow's own registered
 * functions, live (with a stub spawner) and on replay (their journaled output
 * folded, the spawner never called).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactSchemas,
  skillMetaSchema,
  workflowSchema,
  type ContentBundle,
  type FactTableCatalog,
  type Skill,
} from "@brainstorm-agentic/content";
import { InMemoryArtifactStore, Scope, type AgentTask, type JsonObject, type JsonValue } from "@brainstorm-agentic/core";

import {
  BRAINSTORM_STATE,
  ContentArtifactOutputValidator,
  FactUpdateIndex,
  StaticBrainstormRouteResolver,
  applyChainReconsideration,
  applyReportReconsiderations,
  chainBase,
  compileContentWorkflow,
  emptyFactUpdateMerge,
  reportBase,
  reportSubscriberKey,
  staleChainParts,
  type CompiledContentWorkflow,
  type FactMergeRequest,
  type FactNotice,
  type FactUpdateCoordinator,
} from "../src/index.js";
import { GameReviewLedger, committeeContextIssues } from "../src/game-ledger.js";
import { gameReviewVersion } from "../src/game-review.js";

const RUN = "run-1";
const SIGNAL = new AbortController().signal;

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

const PREFIX_BIND = { ref: "ideas[member.id].cot", through: "stepIndex" };
const merge = (id: string, handler: string, input: string, ref: string, key: string) =>
  ({ kind: "activity", id, handler, bind: { [input]: ref }, output: { key, schema: "factUpdateMerge" } });

const WORKFLOW = workflowSchema.parse({
  apiVersion: "brainstorm.workflow/v1",
  name: "updates",
  version: "0.30.0",
  description: "Fact-update fixture workflow.",
  root: {
    kind: "sequence",
    id: "root",
    steps: [
      merge("merge-chain", "facts.mergeChain", "idea", "ideas[member.id]", "reviews[member.id].factUpdate"),
      { kind: "agent", id: "critic", skill: "critic", route: "reasoning", bind: { chain: PREFIX_BIND, currentStep: "stepIndex" },
        output: { key: "reviews[member.id].current.gameCritiques[commentor.id]", schema: "gameCritique" } },
      { kind: "agent", id: "commentor", skill: "commentor", route: "reasoning", bind: { chain: PREFIX_BIND, currentStep: "stepIndex" },
        output: { key: "reviews[member.id].current.comments[commentor.id]", schema: "commentParts" } },
      merge("merge-reports", "facts.mergeGameReports", "critiques", "reviews[member.id].current.gameCritiques", "reviews[member.id].current.factReportUpdate"),
      { kind: "agent", id: "chair", skill: "chair", route: "reasoning",
        bind: { chain: PREFIX_BIND, comments: "reviews[member.id].current.gameCritiques", currentStep: "stepIndex" },
        output: { key: "reviews[member.id].current.gameChair", schema: "gameCommitteeDecision" } },
      merge("merge-late-reports", "facts.mergeLateGameReports", "critiques", "reviews[member.id].current.gameCritiques", "reviews[member.id].current.factLateUpdate"),
      { kind: "agent", id: "chair-reassess", skill: "chair", route: "reasoning",
        bind: { chain: PREFIX_BIND, comments: "reviews[member.id].current.gameCritiques", currentStep: "stepIndex" },
        output: { key: "reviews[member.id].current.gameChair", schema: "gameCommitteeDecision" } },
      merge("merge-comments", "facts.mergeComments", "comments", "reviews[member.id].current.comments", "reviews[member.id].current.factReportUpdate"),
      merge("merge-late-comments", "facts.mergeLateComments", "comments", "reviews[member.id].current.comments", "reviews[member.id].current.factLateUpdate"),
      merge("merge-ideas", "facts.mergeIdeas", "ideas", "ideas", "factUpdates"),
      merge("close-updates", "facts.closeUpdates", "ideas", "ideas", "factUpdates"),
      { kind: "terminal", id: "done" },
    ],
  },
});

function compile(): CompiledContentWorkflow {
  return compileContentWorkflow({
    bundle: bundle(),
    workflow: WORKFLOW,
    routeResolver: new StaticBrainstormRouteResolver({ reasoning: { modelId: "configured-reasoner", providerId: "fake" } }),
  });
}

const parts = (text: string) => ({ part1: `${text}, first part.`, part2: `${text}, second part.`, part3: `${text}, third part.`, part4: `${text}, fourth part.` });
const section = (n: number, text: string) => Array.from({ length: n }, (_, index) => `${text} paragraph ${index + 1}.`);
const OUTPUT = {
  type: "research idea",
  paper: { abstract: section(3, "Abstract"), introduction: section(3, "Introduction"), method: section(3, "Method [F:7]"), discussion: section(3, "Discussion"), conclusion: section(1, "Conclusion") },
};
/** member-1's idea: steps 1 and 3 and the method section cite F:7; step 3 also cites F:1. */
const IDEA: JsonObject = {
  output: OUTPUT,
  cot: [{ ...parts("One"), part2: "The bound holds [F:7]." }, parts("Two"), { ...parts("Three"), part1: "It rests on [F:1] and [F:7]." }],
  novelty: "Combining the bound with the control is new.",
  literature: [],
};
const MEMBERS = [
  { id: "member-1", department: "physics", umbrella: "Physics", subfields: ["optics"] },
  { id: "member-2", department: "biology", umbrella: "Biology", subfields: ["genetics", "ecology"] },
  { id: "member-3", department: "mathematics", umbrella: "Mathematics", subfields: [] },
];
const memberOf = (id: string): JsonObject => MEMBERS.find((member) => member.id === id)! as unknown as JsonObject;
const REPORT = (critic: string, cites: boolean) => ({ q: 0.3, justification: `${critic} finds the bound ${cites ? "unsupported [F:7]" : "plausible"} at step 2.` });
const COMMENT = (cites: boolean) => ({
  verdict: "Build",
  reason: `The step needs its control${cites ? " [F:7]" : ""}.`,
  flaws: [{ step: 2, part1: "", part2: "The control is missing.", part3: "", part4: "" }],
  suggestion: "Add the control.",
  evidence: { kind: "none", code: "", result: "", derivation: "", citation: "", locator: "", shows: "" },
});

function initialState(): JsonObject {
  return {
    input: { title: "Bounds on message passing", question: "Does it converge?", type: "research idea", cotSteps: 3, files: [] },
    usefulFiles: { files: [] },
    panel: { members: MEMBERS },
    params: { gamifiedReview: true },
    ideas: { "member-1": structuredClone(IDEA) },
    thoughts: { "member-1": ["t1", "t2", "t3"] },
    reviews: { "member-1": { round: 1, allowedVerdicts: ["Pass", "Build"], phase: "commenting", current: { comments: {}, gameCritiques: {} } } },
    reviewLog: { "member-1": [{ step: 1, round: 1, verdict: "Pass" }] },
    _runtime: { artifacts: {} },
  };
}

function scopeOf(state: JsonObject, critic = "member-2"): Scope {
  const scope = Scope.root({ [BRAINSTORM_STATE]: state });
  scope.set("member", memberOf("member-1"));
  scope.set("commentor", memberOf(critic));
  scope.set("stepIndex", 2);
  return scope;
}

const stateOf = (scope: Scope): JsonObject => scope.get(BRAINSTORM_STATE) as JsonObject;

/** A stub spawner: each merge point returns its scripted output; stored outputs are recorded. */
function coordinator(outputs: Partial<Record<FactMergeRequest["point"], JsonObject>> = {}) {
  const merges: FactMergeRequest[] = [];
  const stored: string[] = [];
  const value: FactUpdateCoordinator = {
    async merge(request) {
      merges.push(request);
      return structuredClone(outputs[request.point] ?? emptyFactUpdateMerge(request.point));
    },
    stored(output) {
      stored.push(output.key);
    },
  };
  return { value, merges, stored };
}

/** One merge point: live, its `-run` effect asks the spawner; on replay, the journaled output is folded. */
async function mergePoint(compiled: CompiledContentWorkflow, scope: Scope, nodeId: string, journaled?: JsonValue, artifacts?: InMemoryArtifactStore): Promise<JsonValue> {
  const context = { runId: RUN, nodePath: `root/${nodeId}/${nodeId}-run`, signal: SIGNAL, ...(artifacts ? { artifacts } : {}) };
  const output = journaled !== undefined
    ? journaled
    : await compiled.functions.activity(`brainstorm.updates.${nodeId}.run`)(undefined, scope, context);
  scope.set(`__brainstorm:${nodeId}:output`, output ?? null);
  const next = await compiled.functions.activity(`brainstorm.updates.${nodeId}.apply`)(undefined, scope,
    { ...context, nodePath: `root/${nodeId}/${nodeId}-apply` });
  scope.set(BRAINSTORM_STATE, next ?? null);
  return output ?? null;
}

/** One agent store: live, the task is built first (as the runner does); on replay only the store fold runs. */
async function store(compiled: CompiledContentWorkflow, scope: Scope, nodeId: string, result: JsonValue, live: boolean): Promise<AgentTask | undefined> {
  const prefix = `root/${nodeId}/`;
  let task: AgentTask | undefined;
  if (live) {
    const spec = await compiled.functions.taskBuilder(`brainstorm.updates.${nodeId}.task`)(scope, undefined,
      { runId: RUN, nodePath: `${prefix}${nodeId}-execute`, signal: SIGNAL });
    task = { taskId: `${RUN}:${prefix}${nodeId}-execute`, ...spec };
  }
  scope.set(`__brainstorm:${nodeId}:result`, result);
  const next = await compiled.functions.activity(`brainstorm.updates.${nodeId}.apply`)(undefined, scope,
    { runId: RUN, nodePath: `${prefix}${nodeId}-store`, signal: SIGNAL });
  scope.set(BRAINSTORM_STATE, next ?? null);
  return task;
}

const NOTICE: FactNotice = {
  notice: "N:1",
  deleted: "F:7",
  claim: "The bound holds for every graph.",
  conditions: "none",
  reason: "The bound fails on graphs with a cycle.",
  replacement: { id: "F:12", status: "justified", claim: "The bound holds for every tree.", conditions: "acyclic graphs", reason: "Checked on trees." },
};

const KEY_2 = reportSubscriberKey("game-report", "member-1", 2, 1, "member-2");
const KEY_3 = reportSubscriberKey("game-report", "member-1", 2, 1, "member-3");

function indexView(index: FactUpdateIndex): JsonValue {
  return JSON.parse(JSON.stringify({
    seats: index.seats(RUN),
    ideas: index.seats(RUN).map((seat) => index.idea(RUN, seat)),
    reports: [KEY_2, KEY_3].map((key) => index.report(RUN, key) ?? null),
    subscribers: index.subscribersOf(RUN, "F:7", undefined, 1),
    consumed: [...index.consumedNotices(RUN, KEY_2)],
    taskConsumed: index.isTaskConsumed(RUN, `fact-update:${KEY_2}:1`),
    roundClosed: index.isRoundClosed(RUN, KEY_2),
    closed: index.isClosed(RUN),
  })) as JsonValue;
}

test("17 the index after a live run equals the index its replay rebuilds, and replay never calls the spawner", async () => {
  const revision = { decision: "revised", report: REPORT("member-2", false), reason: "F:7 was deleted; the report now stands on step 2 alone." };
  const scripted: Partial<Record<FactMergeRequest["point"], JsonObject>> = {
    "game-reports": { merged: [{ key: KEY_2, taskId: `fact-update:${KEY_2}:1`, notices: ["N:1"], output: revision, epoch: 1 }], discarded: [] },
    close: { merged: [], discarded: [] },
  };
  const live = compile();
  const spawner = coordinator(scripted);
  live.attachFactUpdates!(spawner.value);
  const liveScope = scopeOf(initialState());
  const journal: JsonValue[] = [];
  await store(live, liveScope, "critic", REPORT("member-2", true), true);
  liveScope.set("commentor", memberOf("member-3"));
  await store(live, liveScope, "critic", REPORT("member-3", true), true);
  journal.push(await mergePoint(live, liveScope, "merge-reports"));
  journal.push(await mergePoint(live, liveScope, "close-updates"));
  assert.deepEqual(spawner.merges.map((request) => [request.point, request.seat ?? null, request.step ?? null, request.round ?? null]),
    [["game-reports", "member-1", 2, 1], ["close", "member-1", 2, 1]]);
  assert.deepEqual(spawner.stored, [KEY_2, KEY_3], "an output stored by a task that ran in this process is reported");

  const replayed = compile();
  const silent = coordinator();
  replayed.attachFactUpdates!(silent.value);
  const replayScope = scopeOf(initialState());
  await store(replayed, replayScope, "critic", REPORT("member-2", true), false);
  replayScope.set("commentor", memberOf("member-3"));
  await store(replayed, replayScope, "critic", REPORT("member-3", true), false);
  await mergePoint(replayed, replayScope, "merge-reports", journal[0]);
  await mergePoint(replayed, replayScope, "close-updates", journal[1]);
  assert.deepEqual(silent.merges, [], "replay folds the journaled output and never waits");
  assert.deepEqual(silent.stored, [], "a replayed store is never reported");
  assert.deepEqual(indexView(replayed.factUpdateIndex!), indexView(live.factUpdateIndex!));
  assert.deepEqual(stateOf(replayScope), stateOf(liveScope));
  assert.equal(replayed.factUpdateIndex!.isClosed(RUN), true);
});

test("18 subscribersOf: citing seats, unsettled reports requested before the deletion, the submitter; never closed, later or dismissed ones", () => {
  const index = new FactUpdateIndex(new Set(["member-9"]));
  index.setIdea(RUN, "member-1", IDEA);
  index.setIdea(RUN, "member-2", { output: { ...OUTPUT, paper: { ...OUTPUT.paper, method: section(3, "Method") } }, cot: [parts("A"), parts("B"), parts("C")] });
  index.setIdea(RUN, "member-9", IDEA);
  const prefix = (IDEA.cot as JsonValue[]).slice(0, 2);
  const open = (kind: "game-report" | "comment", step: number, critic: string, report: JsonObject, epoch?: number) =>
    index.openReport(RUN, { key: reportSubscriberKey(kind, "member-1", step, 1, critic), kind, seat: "member-1", step, round: 1, critic, report,
      prefix: (IDEA.cot as JsonValue[]).slice(0, step), ...(epoch !== undefined ? { epoch } : {}), ...(kind === "comment" ? { allowedVerdicts: ["Pass", "Build"] } : {}) });
  open("game-report", 2, "member-2", REPORT("member-2", true), 0);
  open("game-report", 2, "member-3", REPORT("member-3", true), 1);
  open("game-report", 2, "member-5", REPORT("member-5", false), 0);
  open("comment", 2, "member-4", COMMENT(true));
  open("game-report", 1, "member-6", REPORT("member-6", true), 0);
  index.passToChair(RUN, "game-report", "member-1", 2, 1);
  index.closeRound(RUN, "game-report", "member-1", 1, 1);
  const found = index.subscribersOf(RUN, "F:7", { role: "game-commentor", agent: "member-5", seat: "member-1", step: 2 }, 1);
  assert.deepEqual(found.subscribers.map((subscriber) => [subscriber.key, subscriber.citedAt]), [
    ["chain:member-1", [1, 3]],
    [reportSubscriberKey("game-report", "member-1", 2, 1, "member-2"), [1]],
    [reportSubscriberKey("game-report", "member-1", 2, 1, "member-5"), [1]],
    [reportSubscriberKey("comment", "member-1", 2, 1, "member-4"), [1]],
  ], "member-3's report was requested at the deletion's epoch, member-6's round is closed, member-9 is dismissed");
  assert.equal(found.none, undefined);
  assert.equal(prefix.length, 2);
  const chair = index.subscribersOf(RUN, "F:7", { role: "committee-chair", agent: "committee-chair", seat: "member-1", step: 2 }, 1);
  assert.equal(chair.none, "none:committee-chair:committee-chair", "a submitter with no revisable output gets no task");
  const thinker = index.subscribersOf(RUN, "F:5", { role: "brain", agent: "member-2", seat: "member-2" }, 1);
  assert.deepEqual(thinker.subscribers.map((subscriber) => [subscriber.key, subscriber.citedAt]), [["chain:member-2", []]],
    "the thinker that submitted the badge reconsiders though its chain does not cite it");
  assert.deepEqual(index.citedBy(RUN, reportSubscriberKey("game-report", "member-1", 2, 1, "member-3"), [{ id: "F:7", seq: 1 }]), []);
  assert.deepEqual(index.citedBy(RUN, reportSubscriberKey("game-report", "member-1", 2, 1, "member-3"), [{ id: "F:7", seq: 2 }]), ["F:7"]);
  assert.deepEqual(index.citedBy(RUN, "chain:member-9", [{ id: "F:7", seq: 1 }]), []);
});

test("19 a chain merge applies the revision with the redevelopment merge and touches nothing of the review", async () => {
  const compiled = compile();
  compiled.attachFactUpdates!(coordinator().value);
  const artifacts = new InMemoryArtifactStore();
  const scope = scopeOf(initialState());
  const before = stateOf(scope);
  const revision = {
    decision: "revised",
    reason: "F:7 was deleted; step 3 now rests on F:12 within its conditions.",
    steps: [{ index: 3, ...parts("Three"), part1: "It rests on [F:1] and, for trees, [F:12]." }],
    outputPatch: { paper: { method: section(3, "Method for trees [F:12]") } },
  };
  const output = { merged: [{ key: "chain:member-1", taskId: "fact-update:chain:member-1:1", notices: ["N:1"], output: revision }], discarded: [] };
  await mergePoint(compiled, scope, "merge-chain", output, artifacts);
  const after = stateOf(scope);
  const idea = (after.ideas as JsonObject)["member-1"] as JsonObject;
  assert.equal((idea.cot as JsonValue[]).length, 3);
  assert.deepEqual((idea.cot as JsonValue[]).slice(0, 2), (IDEA.cot as JsonValue[]).slice(0, 2));
  assert.deepEqual((idea.cot as JsonValue[])[2], { ...parts("Three"), part1: "It rests on [F:1] and, for trees, [F:12]." });
  assert.deepEqual(((idea.output as JsonObject).paper as JsonObject).method, section(3, "Method for trees [F:12]"));
  assert.deepEqual(((idea.output as JsonObject).paper as JsonObject).abstract, OUTPUT.paper.abstract);
  assert.deepEqual([idea.novelty, idea.literature], [IDEA.novelty, []]);
  assert.deepEqual((after.thoughts as JsonObject)["member-1"], ["t1", "t2", ""]);
  assert.deepEqual(after.reviews, { ...(before.reviews as JsonObject), "member-1": { ...((before.reviews as JsonObject)["member-1"] as JsonObject), factUpdate: output } });
  assert.deepEqual(after.reviewLog, before.reviewLog);
  const history = ((after._runtime as JsonObject).artifacts as JsonObject)["ideas.member-1"] as JsonValue[];
  assert.equal(history.length, 1, "the revised idea is persisted under the seat's idea path");
  assert.deepEqual(compiled.factUpdateIndex!.idea(RUN, "member-1"), idea);
  // An unchanged decision changes nothing.
  const unchanged = applyChainReconsideration(after, "member-1", { decision: "unchanged", reason: "Nothing cites F:7.", steps: [] }, "merge-chain");
  assert.equal(unchanged.state, after);
  assert.deepEqual(unchanged.touched, []);
});

test("20 the base check: only a step or section the revision rewrites and that changed since the task began is stale", () => {
  const base = chainBase(IDEA);
  const revision = { decision: "revised", steps: [{ index: 3, ...parts("Three") }], outputPatch: { paper: { method: section(3, "Method") } }, novelty: "New novelty." };
  assert.deepEqual(staleChainParts(IDEA, base, revision), []);
  const repairedStep3 = { ...IDEA, cot: [...(IDEA.cot as JsonValue[]).slice(0, 2), parts("Three repaired")] };
  assert.deepEqual(staleChainParts(repairedStep3, base, revision), ["step 3"]);
  const repairedStep2 = { ...IDEA, cot: [(IDEA.cot as JsonValue[])[0]!, parts("Two repaired"), (IDEA.cot as JsonValue[])[2]!] };
  assert.deepEqual(staleChainParts(repairedStep2, base, revision), [], "a step the revision does not touch may change freely");
  const repairedMethod = { ...IDEA, output: { ...OUTPUT, paper: { ...OUTPUT.paper, method: section(3, "Repaired method") } }, novelty: "Changed." };
  assert.deepEqual(staleChainParts(repairedMethod, base, revision), ["paper.method", "novelty"]);
  assert.deepEqual(staleChainParts(repairedStep3, base, { decision: "unchanged", steps: [] }), []);
  assert.deepEqual(reportBase(REPORT("member-2", true)), { report: reportBase(REPORT("member-2", true)).report });
  assert.notEqual(reportBase(REPORT("member-2", true)).report, reportBase(REPORT("member-2", false)).report);
});

test("21 report merges before the chair or judge: revised replaces with its epoch, withdrawn is recorded, unchanged stays", async () => {
  const compiled = compile();
  compiled.attachFactUpdates!(coordinator().value);
  const scope = scopeOf(initialState());
  for (const critic of ["member-2", "member-3"]) {
    scope.set("commentor", memberOf(critic));
    await store(compiled, scope, "critic", REPORT(critic, true), false);
  }
  const revised = REPORT("member-2", false);
  await mergePoint(compiled, scope, "merge-reports", {
    merged: [
      { key: KEY_2, taskId: `fact-update:${KEY_2}:1`, notices: ["N:1"], output: { decision: "revised", reason: "F:7 was deleted.", report: revised }, epoch: 1 },
      { key: KEY_3, taskId: `fact-update:${KEY_3}:1`, notices: ["N:1"], output: { decision: "withdrawn", reason: "The report stood on F:7 alone." } },
    ],
    discarded: [],
  });
  const current = (((stateOf(scope).reviews as JsonObject)["member-1"] as JsonObject).current as JsonObject);
  assert.deepEqual(current.gameCritiques, { "member-2": revised });
  assert.deepEqual(current.gameReportEpochs, { "member-2": 1 });
  assert.deepEqual(current.gameWithdrawn, { "member-3": { notices: ["N:1"], reason: "The report stood on F:7 alone." } });
  const index = compiled.factUpdateIndex!;
  assert.deepEqual([index.report(RUN, KEY_2)?.report, index.report(RUN, KEY_2)?.epoch, index.report(RUN, KEY_2)?.phase], [revised, 1, "chair"]);
  assert.equal(index.report(RUN, KEY_3), undefined);
  await assert.rejects(
    mergePoint(compiled, scope, "merge-reports", { merged: [{ key: reportSubscriberKey("game-report", "member-1", 3, 1, "member-2"), taskId: "t", notices: ["N:1"], output: { decision: "withdrawn", reason: "Elsewhere." } }], discarded: [] }),
    /does not belong to this round/,
  );

  // Comments before the judge: the revision is stored as a comment store would store it.
  scope.set("commentor", memberOf("member-2"));
  await store(compiled, scope, "commentor", COMMENT(true), false);
  const key = reportSubscriberKey("comment", "member-1", 2, 1, "member-2");
  const comment = { ...COMMENT(false), flaws: [{ step: 2, part1: "", part2: "", part3: "", part4: "" }, { step: 1, part1: "The setup omits the control.", part2: "", part3: "", part4: "" }] };
  await mergePoint(compiled, scope, "merge-comments", {
    merged: [{ key, taskId: `fact-update:${key}:1`, notices: ["N:1"], output: { decision: "revised", reason: "F:7 was deleted.", comment } }],
    discarded: [],
  });
  const comments = ((((stateOf(scope).reviews as JsonObject)["member-1"] as JsonObject).current as JsonObject).comments as JsonObject);
  assert.deepEqual((comments["member-2"] as JsonObject).flaws, [{ step: 1, part1: "The setup omits the control." }], "empty boxes are pruned as a stored comment's are");
  assert.equal(index.report(RUN, key)?.phase, "chair");
});

test("22 late merges keep the first assessment for a re-assessment, close the round, and the re-assessment's chair task joins the round's ids", async () => {
  const compiled = compile();
  compiled.attachFactUpdates!(coordinator().value);
  compiled.factUpdateIndex!.setIdea(RUN, "member-1", IDEA);
  const scope = scopeOf(initialState());
  for (const critic of ["member-2", "member-3"]) {
    scope.set("commentor", memberOf(critic));
    await store(compiled, scope, "critic", REPORT(critic, true), false);
  }
  await mergePoint(compiled, scope, "merge-reports", { merged: [], discarded: [] });
  const assess = (reason: string) => ({
    reports: Object.fromEntries(["member-2", "member-3"].map((id) => [id, { admissible: true, reason, factChecks: [] }])),
    reason,
  });
  const first = assess("The first assessment admits both reports.");
  const firstTask = await store(compiled, scope, "chair", first, true);
  assert.equal(firstTask!.metadata?.factReview, undefined, "the round's first chair task has no earlier chair task");
  const firstId = `${RUN}:root/chair/chair-execute`;
  let current = (((stateOf(scope).reviews as JsonObject)["member-1"] as JsonObject).current as JsonObject);
  assert.equal(current.gameChairTaskId, firstId);

  await mergePoint(compiled, scope, "merge-late-reports", {
    merged: [{ key: KEY_3, taskId: `fact-update:${KEY_3}:1`, notices: ["N:1"], output: { decision: "withdrawn", reason: "The report stood on F:7 alone." } }],
    discarded: [],
    reassess: true,
  });
  current = (((stateOf(scope).reviews as JsonObject)["member-1"] as JsonObject).current as JsonObject);
  assert.deepEqual(current.gameChairFirst, first);
  assert.deepEqual(Object.keys(current.gameCritiques as JsonObject), ["member-2"]);
  assert.equal(compiled.factUpdateIndex!.isRoundClosed(RUN, KEY_2), true);
  assert.deepEqual(compiled.factUpdateIndex!.subscribersOf(RUN, "F:7", undefined, 1).subscribers.map((s) => s.key), ["chain:member-1"],
    "after the late merge the round's reports are closed");

  const second = { reports: { "member-2": { admissible: true, reason: "Re-assessed.", factChecks: [] } }, reason: "Re-assessed after the withdrawal." };
  const reassessment = await store(compiled, scope, "chair-reassess", second, true);
  assert.deepEqual(reassessment!.metadata?.factReview, { earlierChairTaskIds: [firstId] });
  current = (((stateOf(scope).reviews as JsonObject)["member-1"] as JsonObject).current as JsonObject);
  assert.deepEqual([current.gameChairEarlierTaskIds, current.gameChairTaskId], [[firstId], `${RUN}:root/chair-reassess/chair-reassess-execute`]);
  assert.deepEqual(current.gameChair, second);

  // A late merge with nothing to re-assess keeps no first assessment.
  const quiet = scopeOf(initialState());
  quiet.set("commentor", memberOf("member-2"));
  await store(compiled, quiet, "critic", REPORT("member-2", false), false);
  await mergePoint(compiled, quiet, "merge-late-reports", { merged: [], discarded: [], reassess: false });
  assert.equal(Object.hasOwn((((stateOf(quiet).reviews as JsonObject)["member-1"] as JsonObject).current as JsonObject), "gameChairFirst"), false);

  // The judge's first decision is kept the same way.
  const judged = { ...(initialState()) };
  const withDecision = applyReportReconsiderations(
    { ...judged, reviews: { "member-1": { round: 1, current: { comments: { "member-2": COMMENT(true) }, decision: { verdict: "Build" } } } } },
    "member-1", "comment",
    [{ key: reportSubscriberKey("comment", "member-1", 2, 1, "member-2"), taskId: "t", notices: ["N:1"], output: { decision: "withdrawn", reason: "Gone." } }],
    true,
  );
  const judgedCurrent = ((withDecision.state.reviews as JsonObject)["member-1"] as JsonObject).current as JsonObject;
  assert.deepEqual([judgedCurrent.decisionFirst, judgedCurrent.comments, judgedCurrent.commentsWithdrawn], [{ verdict: "Build" }, {}, { "member-2": { notices: ["N:1"], reason: "Gone." } }]);
});

test("23 a round whose reports were all withdrawn still convenes the chair once: an empty assessment is valid and settles with no valid report", async () => {
  const empty = { reports: {}, reason: "Every report of this round was withdrawn after a fact-table deletion." };
  assert.equal(artifactSchemas.gameCommitteeDecision.safeParse(empty).success, true);
  assert.deepEqual(committeeContextIssues(empty, {}), []);
  const settled = new GameReviewLedger().settle("r", "r:1", {
    critiques: {}, chain: [parts("One")], panel: { members: [{ id: "member-2" }] }, initialPoints: 100, threshold: 0.5,
    decisionRule: "chair-decisive", leaveOneOut: true, chair: empty, deletions: [], reportEpochs: {},
  }, []);
  assert.deepEqual([settled.status, settled.y, settled.rows], ["no-valid-reports", null, []]);
  assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true);
  // The chair's task for an empty round pins an empty report map.
  const compiled = compile();
  compiled.attachFactUpdates!(coordinator().value);
  const scope = scopeOf(initialState());
  const spec = await compiled.functions.taskBuilder("brainstorm.updates.chair.task")(scope, undefined, { runId: RUN, nodePath: "root/chair/chair-execute", signal: SIGNAL });
  const reports = ((spec.outputSchema!.schema as JsonObject).properties as JsonObject).reports as JsonObject;
  assert.deepEqual([reports.properties, reports.required, reports.additionalProperties], [{}, [], false]);
});

test("24 reconsideration tasks: the roles' exact bindings, the fact scope, the narrowed schema and what each task saw", async () => {
  const compiled = compile();
  compiled.attachFactUpdates!(coordinator().value);
  const scope = scopeOf(initialState());
  for (const critic of ["member-2", "member-3"]) {
    scope.set("commentor", memberOf(critic));
    await store(compiled, scope, "critic", REPORT(critic, true), false);
  }
  scope.set("commentor", memberOf("member-2"));
  await store(compiled, scope, "commentor", COMMENT(true), false);
  const index = compiled.factUpdateIndex!;
  index.setIdea(RUN, "member-1", IDEA);
  index.noteRunData(RUN, stateOf(scope));

  const chain = await compiled.factReconsiderationTask!({ runId: RUN, taskId: "fact-update:chain:member-1:1", key: "chain:member-1", notices: [{ ...NOTICE, citedAt: [1, 3] }] });
  const chainBindings = (chain.task.input as JsonObject).bindings as JsonObject;
  assert.deepEqual(Object.keys(chainBindings).sort(), [...RECONSIDERATION_VARS.chain].sort());
  assert.deepEqual([chainBindings.chain, chainBindings.previousOutput, chainBindings.totalSteps, chainBindings.shape, chainBindings.shapeGuide],
    [IDEA.cot, IDEA.output, 3, "paper", "Write it as a paper."]);
  assert.equal(chainBindings.board, "- Biology, genetics, ecology\n- Mathematics", "the other seats as prose");
  assert.equal(Object.hasOwn(chainBindings.input as JsonObject, "files"), false);
  assert.deepEqual(chainBindings.factUpdates, [{ ...NOTICE, citedAt: [1, 3] }]);
  assert.deepEqual([chain.task.taskId, chain.task.agentId, chain.task.kind], ["fact-update:chain:member-1:1", "member-1", "brainstorm.reconsider-chain"]);
  assert.deepEqual(chain.task.metadata?.factScope, { role: "reconsider-chain", agent: "member-1", seat: "member-1", cited: [{ step: 1, ids: ["F:7"] }, { step: 3, ids: ["F:1", "F:7"] }] });
  assert.equal(chain.task.metadata?.nodeId, "fact-update");
  assert.deepEqual(chain.task.revisionBase, IDEA);
  assert.deepEqual(chain.base, chainBase(IDEA));
  const chainSchema = chain.task.outputSchema!.schema as JsonObject;
  const steps = (chainSchema.properties as JsonObject).steps as JsonObject;
  assert.deepEqual([steps.maxItems, ((steps.items as JsonObject).properties as JsonObject).index], [3, { ...(((steps.items as JsonObject).properties as JsonObject).index as JsonObject), maximum: 3 }]);
  assert.equal(((((steps.items as JsonObject).properties as JsonObject).index as JsonObject).maximum), 3);
  assert.deepEqual(Object.keys(((chainSchema.properties as JsonObject).outputPatch as JsonObject).properties as JsonObject), ["paper"],
    "the patch offers the run's shape body only, and no requested sections when the run recorded none");

  const report = await compiled.factReconsiderationTask!({ runId: RUN, taskId: `fact-update:${KEY_2}:1`, key: KEY_2, notices: [{ ...NOTICE, citedAt: [1] }] });
  const reportBindings = (report.task.input as JsonObject).bindings as JsonObject;
  assert.deepEqual(Object.keys(reportBindings).sort(), [...RECONSIDERATION_VARS.gameReport].sort());
  assert.deepEqual([reportBindings.report, reportBindings.chain, reportBindings.currentStep, reportBindings.department, reportBindings.umbrella],
    [REPORT("member-2", true), (IDEA.cot as JsonValue[]).slice(0, 2), 2, "biology", "Biology"]);
  assert.equal(Object.hasOwn(reportBindings.input as JsonObject, "cotSteps"), false);
  assert.deepEqual(report.task.metadata?.factScope, {
    role: "reconsider-game-report", agent: "member-2",
    blindReview: JSON.stringify(["member-1", 2, 1, gameReviewVersion((IDEA.cot as JsonValue[]).slice(0, 2), 2)]),
    seat: "member-1", step: 2, cited: [{ step: 1, ids: ["F:7"] }],
  });
  assert.deepEqual(report.base, reportBase(REPORT("member-2", true)));

  const commentKey = reportSubscriberKey("comment", "member-1", 2, 1, "member-2");
  const comment = await compiled.factReconsiderationTask!({ runId: RUN, taskId: `fact-update:${commentKey}:1`, key: commentKey, notices: [NOTICE] });
  const commentBindings = (comment.task.input as JsonObject).bindings as JsonObject;
  assert.deepEqual(Object.keys(commentBindings).sort(), [...RECONSIDERATION_VARS.comment].sort());
  assert.deepEqual(commentBindings.verdictOptions, ["Pass", "Build"]);
  const nested = ((comment.task.outputSchema!.schema as JsonObject).properties as JsonObject).comment as JsonObject;
  const nestedProperties = nested.properties as JsonObject;
  assert.deepEqual((nestedProperties.verdict as JsonObject).enum, ["Pass", "Build"]);
  assert.equal((nestedProperties.flaws as JsonObject).maxItems, 2);
  assert.equal(((((nestedProperties.flaws as JsonObject).items as JsonObject).properties as JsonObject).step as JsonObject).maximum, 2);
  await assert.rejects(compiled.factReconsiderationTask!({ runId: RUN, taskId: "t", key: "chain", notices: [NOTICE] }), /is not a fact-update subscriber/);
});

test("25 validators: a merged chain that still cites a deleted badge, an unchanged decision on a citing chain, a comment outside the round's verdicts", async () => {
  const compiled = compile();
  compiled.attachFactUpdates!(coordinator().value);
  const state = initialState();
  // This round allows Pass and Interrupt: a revised comment that says Build is outside it.
  (state.reviews as Record<string, Record<string, JsonValue>>)["member-1"]!.allowedVerdicts = ["Pass", "Interrupt"];
  const scope = scopeOf(state);
  const index = compiled.factUpdateIndex!;
  index.setIdea(RUN, "member-1", IDEA);
  index.noteRunData(RUN, stateOf(scope));
  const validator = new ContentArtifactOutputValidator();
  const chainTask = async (notices: readonly FactNotice[]) =>
    (await compiled.factReconsiderationTask!({ runId: RUN, taskId: "fact-update:chain:member-1:1", key: "chain:member-1", notices })).task;
  const task = await chainTask([NOTICE]);
  const schema = task.outputSchema!.schema;
  const issues = (value: JsonValue, on: AgentTask = task) => {
    const result = validator.validate(value, on.outputSchema!.schema, on);
    return result.success ? [] : result.issues;
  };
  const step3 = { index: 3, ...parts("Three"), part1: "It rests on [F:1] and, for trees, [F:12]." };
  const step1 = { index: 1, ...parts("One"), part2: "The bound holds for trees [F:12]." };
  const method = { paper: { method: section(3, "Method for trees [F:12]") } };
  assert.deepEqual(issues({ decision: "revised", reason: "Steps 1 and 3 and the method now rest on F:12 within its conditions.", steps: [step1, step3], outputPatch: method }), []);
  assert.deepEqual(issues({ decision: "revised", reason: "Step 3 and the method now rest on F:12 within its conditions.", steps: [step3], outputPatch: method }),
    ["the revision still cites F:7, deleted from the fact table: rebuild or remove every citation of it"]);
  const twoNotices = await chainTask([NOTICE, { ...NOTICE, notice: "N:2", deleted: "F:1" }]);
  assert.deepEqual(issues({ decision: "revised", reason: "The method now rests on F:12 within its conditions.", steps: [], outputPatch: method }, twoNotices),
    ["the revision still cites F:7, F:1, deleted from the fact table: rebuild or remove every citation of them"]);
  assert.deepEqual(issues({ decision: "unchanged", reason: "No step or section rests on the deleted badge F:7.", steps: [] }),
    ["an unchanged decision is not possible: the work still cites F:7, deleted from the fact table"]);
  assert.deepEqual(issues({ decision: "revised", reason: "Step 5 now rests on F:12 within its conditions.", steps: [{ index: 5, ...parts("Five") }] }),
    ["the patch rewrites step 5, but the chain has 3 steps"]);
  index.setIdea(RUN, "member-1", { ...IDEA, cot: [parts("One"), parts("Two"), parts("Three")], output: { ...OUTPUT, paper: { ...OUTPUT.paper, method: section(3, "Method") } } });
  assert.deepEqual(issues({ decision: "unchanged", reason: "No step or section cites the deleted badge F:7 any more.", steps: [] }, await chainTask([NOTICE])), []);
  assert.equal(typeof schema, "object");

  for (const critic of ["member-2"]) {
    scope.set("commentor", memberOf(critic));
    await store(compiled, scope, "critic", REPORT(critic, true), false);
    await store(compiled, scope, "commentor", { ...COMMENT(true), verdict: "Pass" }, false);
  }
  const reportTask = (await compiled.factReconsiderationTask!({ runId: RUN, taskId: `fact-update:${KEY_2}:1`, key: KEY_2, notices: [NOTICE] })).task;
  assert.deepEqual(issues({ decision: "withdrawn", reason: "The report stood on the deleted badge F:7 alone.", report: REPORT("member-2", false) }, reportTask),
    ["report: a report is returned exactly when the decision is revised"]);
  assert.deepEqual(issues({ decision: "withdrawn", reason: "The report stood on the deleted badge F:7 alone." }, reportTask), []);
  const commentKey = reportSubscriberKey("comment", "member-1", 2, 1, "member-2");
  const commentTask = (await compiled.factReconsiderationTask!({ runId: RUN, taskId: `fact-update:${commentKey}:1`, key: commentKey, notices: [NOTICE] })).task;
  const pass = { ...COMMENT(false), verdict: "Pass", reason: "With F:7 gone the step stands on its own derivation.", flaws: [], suggestion: "" };
  assert.deepEqual(issues({ decision: "revised", reason: "The comment no longer rests on the deleted badge F:7.", comment: COMMENT(false) }, commentTask),
    ["comment.verdict: must be one of Pass, Interrupt for this round"]);
  assert.deepEqual(issues({ decision: "revised", reason: "The comment no longer rests on the deleted badge F:7.", comment: pass }, commentTask), []);
  assert.deepEqual(issues({ decision: "unchanged", reason: "The comment does not rest on the deleted badge F:7.", comment: pass }, commentTask),
    ["comment: a comment is returned exactly when the decision is revised"]);
});
