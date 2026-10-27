import assert from "node:assert/strict";
import test from "node:test";

import type {
  FactAccess,
  FactDeletion,
  FactEntry,
  FactRequester,
  FactScope,
  FactSubmission,
  FactSubmissionOutcome,
  FactSubmitContext,
  JsonObject,
} from "@brainstorm-agentic/core";
import { factCitationsOf, factIdsIn, factScopeOf, factSubmitContextOf } from "@brainstorm-agentic/core";

import {
  FACT_TABLE_MANIFEST,
  FactQueryError,
  createHostToolRegistry,
  describeFactTableCall,
  executableHostToolIds,
  factTools,
  formatFactOutcome,
  parseFactInput,
  rankFacts,
  runFactTable,
} from "../src/index.js";

const REQUESTER: FactRequester = { taskId: "t-1", role: "brain", agent: "seat-a", seat: "seat-a", step: 2 };

function entry(id: string, claim: string, conditions: string, extra: Partial<FactEntry> = {}): FactEntry {
  return {
    id,
    status: "justified",
    kind: "code",
    claim,
    conditions,
    method: "re-executed",
    evidence: `evidence for ${id}`,
    createdAt: 1_000,
    updatedAt: 1_000,
    history: [{ at: 1_000, event: "issued", by: "S:1" }],
    requesters: [REQUESTER],
    ...extra,
  };
}

const TABLE: FactEntry[] = [
  entry("F:1", "The default n_neighbors in laplacian.py is 10.", "file laplacian.py line 42, commit as attached"),
  entry("F:2", "The swiss-roll baseline error is 0.42.", "n = 1,200 points, seed 0"),
  entry("F:3", "Laplacian eigenmaps on a long strip return harmonics of the long axis.", "none", {
    status: "revoked",
    supersededBy: "F:4",
    history: [
      { at: 1_000, event: "issued", by: "S:2" },
      { at: 2_000, event: "revoked", by: "F:4", detail: "holds only for aspect ratio above 2" },
    ],
  }),
  entry("F:4", "Laplacian eigenmaps on a strip with aspect ratio above 2 return harmonics of the long axis first.", "aspect ratio > 2"),
  entry("F:5", "The swiss-roll baseline error is 0.37.", "n = 60,000 points, seed 0", { status: "disputed" }),
];

class FakeTable implements FactAccess {
  readonly submitted: { requester: FactRequester; submission: FactSubmission; context: FactSubmitContext }[] = [];
  constructor(private readonly table: readonly FactEntry[], private readonly outcome?: FactSubmissionOutcome) {}
  async entries(): Promise<readonly FactEntry[]> {
    return this.table;
  }
  async submit(requester: FactRequester, submission: FactSubmission, context: FactSubmitContext): Promise<FactSubmissionOutcome> {
    this.submitted.push({ requester, submission, context });
    return this.outcome!;
  }
}

const SCOPE: FactScope = {
  role: "commentor",
  agent: "critic-1",
  seat: "seat-a",
  step: 3,
  cited: [
    { step: 1, ids: ["F:1"] },
    { step: 3, ids: ["F:3", "F:9"] },
  ],
};

test("citations: [F:n] ids are read per step, lists inside one bracket included", () => {
  assert.deepEqual(factIdsIn("as shown [F:2], and [F:3, F:7]; again [F:2] but not F:8 or [F:0]"), ["F:2", "F:3", "F:7"]);
  const chain = [
    { part1: "Step one cites [F:1].", part2: "", part3: "", part4: "" },
    { part1: "Nothing here.", part2: "", part3: "", part4: "" },
    { part1: "a", part2: "b [F:4]", part3: "c [F:5; F:4]", part4: "" },
  ];
  assert.deepEqual(factCitationsOf(chain), [
    { step: 1, ids: ["F:1"] },
    { step: 3, ids: ["F:4", "F:5"] },
  ]);
  assert.deepEqual(factCitationsOf(["para [F:2]", { step: 7, text: "[F:3]" }]), [
    { step: 1, ids: ["F:2"] },
    { step: 7, ids: ["F:3"] },
  ]);
  assert.deepEqual(factCitationsOf(undefined), []);
});

test("factScopeOf accepts only a well-formed scope", () => {
  assert.deepEqual(factScopeOf({ factScope: SCOPE }), SCOPE);
  assert.equal(factScopeOf({ factScope: { role: "judge" } }), undefined);
  assert.equal(factScopeOf({ factScope: { ...SCOPE, step: 0 } }), undefined);
  assert.equal(factScopeOf({ factScope: { ...SCOPE, cited: [{ step: 1, ids: ["X:1"] }] } }), undefined);
  assert.equal(factScopeOf({}), undefined);
  assert.deepEqual(factScopeOf({ factScope: { ...SCOPE, blindReview: "frozen-round" } }), { ...SCOPE, blindReview: "frozen-round" });
  assert.equal(factScopeOf({ factScope: { ...SCOPE, blindReview: "" } }), undefined);
  assert.equal(factScopeOf({ factScope: { ...SCOPE, blindReview: 3 } }), undefined);
});

test("all fact tool modes use the private view for a blind critic", async () => {
  const privateTable = new FakeTable([TABLE[0]!], {
    submission: "S:1", case: "justified", badge: TABLE[0]!, conflicts: [],
  });
  const bindings: string[] = [];
  const live: FactAccess = {
    entries: async () => { throw new Error("shared peer facts leaked"); },
    submit: async () => { throw new Error("shared submission leaked"); },
    forTask: async (taskId, scope) => {
      assert.equal(scope.blindReview, "round-1");
      bindings.push(taskId);
      return privateTable;
    },
  };
  const scope = { ...SCOPE, blindReview: "round-1" };
  const queries: JsonObject[] = [
    { mode: "lookup", claim: "n_neighbors" },
    { mode: "status", ids: ["F:1"] },
    { mode: "submit", claim: "n_neighbors", conditions: "attached file", evidence: "line 42", kind: "code" },
  ];
  for (const query of queries) {
    const result = await runFactTable(live, scope, "blind-critic", query);
    assert.equal(result.isError, undefined);
  }
  assert.deepEqual(bindings, ["blind-critic", "blind-critic", "blind-critic"]);
  assert.equal(privateTable.submitted[0]?.requester.taskId, "blind-critic");
});

test("blind fact access fails closed if the host cannot isolate it", async () => {
  await assert.rejects(
    runFactTable(new FakeTable(TABLE), { ...SCOPE, blindReview: "round-1" }, "blind-critic", { mode: "status" }),
    /isolated fact-table view/,
  );
});

test("mediated modes consult the supreme judge in the caller's private view and never read the table", async () => {
  const calls: { query: unknown; context: FactSubmitContext }[] = [];
  const scoped: FactAccess = {
    accessMode: "supreme-mediated/v1",
    entries: async () => { throw new Error("direct table read"); },
    submit: async () => { throw new Error("direct submission"); },
    consult: async (requester, query, context) => {
      assert.equal(requester.taskId, "private-critic");
      calls.push({ query, context });
      return { answer: "Supreme judge's scoped response" };
    },
  };
  const shared: FactAccess = {
    ...scoped,
    consult: async () => { throw new Error("shared view leaked"); },
    forTask: async () => scoped,
  };
  const scope = { ...SCOPE, blindReview: "round-1" };
  const context = { input: { title: "problem" } };
  for (const query of [
    { mode: "lookup", claim: "Equivalent meaning", message: "Consider scope too", max_results: 1 },
    { mode: "status" },
    { mode: "submit", claim: "Claim", conditions: "none", evidence: "proof", kind: "math" },
  ] as JsonObject[]) {
    const result = await runFactTable(shared, scope, "private-critic", query, context);
    assert.deepEqual(result.output, { answer: "Supreme judge's scoped response" });
  }
  assert.deepEqual(calls[0], { query: { mode: "lookup", claim: "Equivalent meaning", message: "Consider scope too", max_results: 1 }, context });
  assert.deepEqual(calls[1]!.query, { mode: "status", ids: ["F:1", "F:3", "F:9"] });
});

test("mediated access cannot downgrade to a raw table or proceed without a consultant", async () => {
  const access: FactAccess = { ...new FakeTable([]), accessMode: "supreme-mediated/v1", entries: async () => [], submit: async () => { throw new Error("raw submit"); } };
  await assert.rejects(runFactTable(access, SCOPE, "t", { mode: "status" }), /direct table access is forbidden/);
  await assert.rejects(runFactTable({ ...access, forTask: async () => new FakeTable([]) },
    { ...SCOPE, blindReview: "r" }, "t", { mode: "status" }), /direct table access is forbidden/);
});

test("approval validates the hash and routes only chair requests through the gateway", async () => {
  const request = { mode: "approve", factId: "F:1", badgeHash: `sha256:${"a".repeat(64)}`, criticId: "critic-1" };
  assert.deepEqual(parseFactInput(request), request);
  assert.throws(() => parseFactInput({ ...request, badgeHash: "made-up" }), /badgeHash/);
  assert.throws(() => parseFactInput({ mode: "approve", factId: "F:1" }), /needs/);
  assert.throws(() => parseFactInput({ ...request, reviewVersion: "forged" }), /Unknown argument/);
  let consulted = false;
  const access: FactAccess = {
    accessMode: "supreme-mediated/v1", entries: async () => { throw new Error("raw read"); },
    submit: async () => { throw new Error("raw submit"); },
    consult: async (_requester, query) => { consulted = true; assert.deepEqual(query, request); return { approvalId: "A:1" }; },
  };
  assert.equal((await runFactTable(access, SCOPE, "t", request)).isError, true);
  assert.equal(consulted, false);
  const result = await runFactTable(access, { ...SCOPE, role: "committee-chair" }, "chair", request);
  assert.deepEqual(result.output, { approvalId: "A:1" });
  assert.equal((await runFactTable(new FakeTable([]), { ...SCOPE, role: "committee-chair" }, "chair", request)).isError, true);
});

test("factSubmitContextOf carries the requester's input and files bindings", () => {
  const context = factSubmitContextOf({
    taskId: "t",
    kind: "brainstorm.commentor",
    input: { role: "commentor", bindings: { input: { title: "x" }, files: [{ path: "a.py" }], chain: [] } },
  });
  assert.deepEqual(context, { input: { title: "x" }, files: [{ path: "a.py" }] });
});

test("parseFactInput validates each mode", () => {
  assert.deepEqual(parseFactInput({ claim: "x" }), { mode: "lookup", claim: "x" });
  assert.throws(() => parseFactInput({ mode: "submit", claim: "x" }), FactQueryError);
  assert.throws(() => parseFactInput({ mode: "lookup" }), /needs `claim`/);
  assert.throws(() => parseFactInput({ mode: "status", ids: ["F:1", "12"] }), /Not badge ids/);
  assert.throws(() => parseFactInput({ claim: "x", foo: 1 }), /Unknown argument/);
  assert.throws(() => parseFactInput({ mode: "submit", claim: "x", conditions: "none", evidence: "e", kind: "rumour" }), /`kind`/);
  const submit = parseFactInput({ mode: "submit", claim: " x ", conditions: "none", evidence: "e", kind: "math", step: 2 });
  assert.deepEqual(submit, { mode: "submit", claim: "x", conditions: "none", evidence: "e", kind: "math", step: 2 });
});

test("rankFacts is deterministic: numbers and identifiers match whole, same claim first", () => {
  const ranked = rankFacts(TABLE, { claim: "The swiss-roll baseline error is 0.42." }, 5);
  assert.equal(ranked[0]!.entry.id, "F:2");
  assert.equal(ranked[0]!.sameClaim, true);
  assert.ok(ranked.some((hit) => hit.entry.id === "F:5"));
  const again = rankFacts(TABLE, { claim: "The swiss-roll baseline error is 0.42." }, 5);
  assert.deepEqual(again.map((hit) => hit.entry.id), ranked.map((hit) => hit.entry.id));
  const file = rankFacts(TABLE, { claim: "default of n_neighbors in laplacian" }, 2);
  assert.equal(file[0]!.entry.id, "F:1");
  assert.deepEqual(rankFacts(TABLE, { claim: "quantum chromodynamics" }, 5), []);
});

test("lookup answers anonymously, with conditions and status", async () => {
  const access = new FakeTable(TABLE);
  const result = await runFactTable(access, SCOPE, "t-2", { mode: "lookup", claim: "swiss-roll baseline error 0.42" });
  assert.equal(result.isError, undefined);
  const output = result.output as JsonObject;
  const text = JSON.stringify(output);
  assert.ok(!text.includes("seat-a") && !text.includes("requesters") && !text.includes("t-1"));
  const results = output.results as JsonObject[];
  assert.equal(results[0]!.id, "F:2");
  assert.equal(results[0]!.conditions, "n = 1,200 points, seed 0");
});

test("status without ids reports every cited badge with alerts; unknown ids are listed", async () => {
  const access = new FakeTable(TABLE);
  const result = await runFactTable(access, SCOPE, "t-2", { mode: "status" });
  const output = result.output as JsonObject;
  assert.deepEqual((output.entries as JsonObject[]).map((e) => e.id), ["F:1", "F:3"]);
  assert.deepEqual(output.unknown, ["F:9"]);
  const alerts = output.alerts as string[];
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /F:3 was revoked and superseded by F:4.*cited at step 3/);
  const byIds = await runFactTable(access, SCOPE, "t-2", { mode: "status", ids: ["F:5"] });
  assert.match(((byIds.output as JsonObject).alerts as string[])[0]!, /disputed/);
  const none = await runFactTable(access, { role: "brain", agent: "seat-a" }, "t-3", { mode: "status" });
  assert.equal((none.output as JsonObject).note, "The chain you were shown cites no badge.");
});

test("submit hands the requester, the submission and the task data to the table", async () => {
  const badge = entry("F:6", "The solver stops after 200 iterations.", "solver.py line 12");
  const outcome: FactSubmissionOutcome = {
    submission: "S:7",
    case: "justified-new",
    badge,
    verdict: {
      case: "justified-new",
      claim: badge.claim,
      conditions: badge.conditions,
      method: "re-executed",
      evidence: "ran it",
      explanation: "The loop bound is 200.",
      conflicts: [],
      integrity: "honest",
    },
    conflicts: [],
  };
  const access = new FakeTable(TABLE, outcome);
  const context: FactSubmitContext = { input: { title: "x" }, files: [] };
  const result = await runFactTable(
    access,
    SCOPE,
    "t-9",
    { mode: "submit", claim: "The solver stops after 200 iterations.", conditions: "solver.py line 12", evidence: "line 12: for i in range(200)", kind: "code", step: 3 },
    context,
  );
  assert.equal(access.submitted.length, 1);
  assert.deepEqual(access.submitted[0]!.requester, { taskId: "t-9", role: "commentor", agent: "critic-1", seat: "seat-a", step: 3 });
  assert.deepEqual(access.submitted[0]!.context, context);
  const output = result.output as JsonObject;
  assert.equal(output.case, "justified-new");
  assert.equal((output.badge as JsonObject).id, "F:6");
  assert.match(output.next as string, /Cite \[F:6\]/);
  assert.ok(!JSON.stringify(output).includes("integrity"));
  assert.ok(!JSON.stringify(output).includes("requesters"));
});

test("registry: fact_table registers through a binding resolver and refuses outside a task", async () => {
  const access = new FakeTable(TABLE);
  const config = {
    facts: { access, bindingOf: (context: { taskId?: string }) => (context.taskId === "t-1" ? { scope: SCOPE, context: {} } : undefined) },
    enabledToolIds: new Set([FACT_TABLE_MANIFEST.toolId]),
  };
  const { registeredToolNames } = createHostToolRegistry(config);
  assert.deepEqual(registeredToolNames, ["fact_table"]);
  assert.ok(executableHostToolIds({ facts: config.facts }).has("fact_table"));
  const [tool] = factTools(access, config.facts.bindingOf);
  const inside = await tool!.execute({ claim: "laplacian.py n_neighbors" }, { runId: "r", taskId: "t-1" });
  assert.equal(inside.isError, undefined);
  const outside = await tool!.execute({ claim: "x" }, { runId: "r", taskId: "t-x" });
  assert.equal(outside.isError, true);
});

test("describeFactTableCall words the activity line without evidence", () => {
  assert.equal(describeFactTableCall({ mode: "status" }), "Checking the badges the chain cites");
  assert.match(describeFactTableCall({ mode: "submit", claim: "A", evidence: "SECRET" }), /^Submitting a fact to the supreme judge — A$/);
  assert.equal(describeFactTableCall({ claim: "B" }), "Looking up the fact table — B");
});

// ---------------------------------------------------------------------------
// fact updates (spec/fact-updates.md 11.12 items 1, 2, 4, 5; section 10 test 39)
// ---------------------------------------------------------------------------

/** A table that deleted badges (control `updates`): it answers them through `deletions()`. */
class DeletingTable extends FakeTable {
  constructor(
    table: readonly FactEntry[],
    private readonly removed: readonly FactDeletion[],
    outcome?: FactSubmissionOutcome,
  ) {
    super(table, outcome);
  }
  async deletions(): Promise<readonly FactDeletion[]> {
    return this.removed;
  }
}

test("fact updates: status answers a deleted badge as deleted, with its replacement and the alert", async () => {
  // SCOPE cites F:9 at step 3; the table deleted it and issued F:4 in its place, and deleted F:7 outright.
  const access = new DeletingTable(TABLE, [
    { id: "F:9", seq: 1, at: 2_000, replacedBy: "F:4" },
    { id: "F:7", seq: 2, at: 3_000 },
  ]);
  const cited = (await runFactTable(access, SCOPE, "t-2", { mode: "status" })).output as JsonObject;
  assert.deepEqual((cited.entries as JsonObject[]).map((e) => e.id), ["F:1", "F:3"]);
  assert.equal(cited.unknown, undefined, "a deleted id is no longer listed as unknown");
  assert.deepEqual(cited.deleted, [{ id: "F:9", replacedBy: "F:4" }]);
  assert.deepEqual(cited.alerts, [
    "F:3 was revoked and superseded by F:4: whatever cites it stands on a fact the table no longer holds. (cited at step 3)",
    "F:9 was deleted from the fact table and replaced by F:4: nothing may cite F:9 as support; check whether F:4 covers the citing claim within its conditions. (cited at step 3)",
  ]);
  const byIds = (await runFactTable(access, SCOPE, "t-2", { mode: "status", ids: ["F:7", "F:8"] })).output as JsonObject;
  assert.deepEqual(byIds.entries, []);
  assert.deepEqual(byIds.unknown, ["F:8"]);
  assert.deepEqual(byIds.deleted, [{ id: "F:7" }]);
  assert.deepEqual(byIds.alerts, ["F:7 was deleted from the fact table: nothing may cite it as support."]);
  // A table without deletions answers exactly as before.
  const plain = (await runFactTable(new FakeTable(TABLE), SCOPE, "t-2", { mode: "status" })).output as JsonObject;
  assert.deepEqual(plain.unknown, ["F:9"]);
  assert.equal(plain.deleted, undefined);
});

test("fact updates: a refuted ruling records nothing, and an incumbent the ruling deleted is marked deleted", async () => {
  const submit = { mode: "submit", claim: "The solver stops after 300 iterations.", conditions: "solver.py line 12", evidence: "line 12: for i in range(300)", kind: "code", step: 3 } as const;
  const verdict = {
    claim: submit.claim,
    conditions: submit.conditions,
    method: "re-executed" as const,
    evidence: "The loop bound is 200.",
    explanation: "The loop stops after 200 iterations.",
    integrity: "honest" as const,
  };
  const refuted: FactSubmissionOutcome = { submission: "S:8", case: "refuted", verdict: { ...verdict, case: "refuted", conflicts: [] }, conflicts: [] };
  const refutedAnswer = (await runFactTable(new FakeTable(TABLE, refuted), SCOPE, "t-9", submit)).output as JsonObject;
  assert.equal(refutedAnswer.recorded, undefined);
  assert.equal(refutedAnswer.next, "The claim is false under the evidence above: drop it and every step built on it.");

  const badge = entry("F:6", "The solver stops after 200 iterations.", "solver.py line 12");
  const incumbent = TABLE[1]!;
  const replaced: FactSubmissionOutcome = {
    submission: "S:9",
    case: "justified-new",
    badge,
    verdict: { ...verdict, case: "justified-new", conflicts: [{ id: incumbent.id, resolution: "incumbent-revoked", explanation: "F:2 read the wrong log." }] },
    conflicts: [{ entry: incumbent, resolution: "incumbent-revoked", explanation: "F:2 read the wrong log.", deleted: true }],
  };
  const answer = (await runFactTable(new FakeTable(TABLE, replaced), SCOPE, "t-9", submit)).output as JsonObject;
  const conflicts = answer.conflicts as JsonObject[];
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.deleted, true);
  assert.equal(conflicts[0]!.resolution, "incumbent-revoked");
  assert.equal((conflicts[0]!.entry as JsonObject).id, "F:2", "the conflict keeps the entry as it stood");
  const { deleted: _deleted, ...standing } = replaced.conflicts[0]!;
  assert.equal("deleted" in (formatFactOutcome({ ...replaced, conflicts: [standing] }).conflicts as JsonObject[])[0]!, false,
    "an incumbent that stays in the table is not marked");
});
