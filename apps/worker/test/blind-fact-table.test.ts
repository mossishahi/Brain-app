import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  factRequesterOf,
  factScopeOf,
  type FactAccess,
  type FactEntry,
  type FactScope,
  type FactSubmission,
  type FactTableLimits,
  type FactVerdict,
  type JsonObject,
} from "@brainstorm-agentic/core";
import { runFactTable } from "@brainstorm-agentic/host-tools";

import { FileFactTable, type FactVerificationRequest, type FactVerifier } from "../src/fact-table.js";

const LIMITS: FactTableLimits = {
  submissionsPerTask: 6, relatedFacts: 8, lookupResults: 5, verificationMinutes: 1,
};
const GROUP = "run-1/thinker-1/step-2/round-1";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function scope(agent = "critic-a", group = GROUP): FactScope {
  return { role: "game-commentor", agent, seat: "thinker-1", step: 2, blindReview: group };
}

function fact(claim: string, conditions = "calibration cohort"): FactSubmission {
  return { claim, conditions, evidence: `A checked record states: ${claim}`, kind: "record", step: 2 };
}

function verifier(rule?: (request: FactVerificationRequest) => Partial<FactVerdict>): FactVerifier & {
  seen: FactVerificationRequest[];
} {
  const seen: FactVerificationRequest[] = [];
  return Object.assign(async (request: FactVerificationRequest) => {
    seen.push(request);
    return {
      taskId: `verify-${request.submission}`,
      verdict: {
        case: "justified-new" as const,
        claim: String(request.bindings.request.claim),
        conditions: String(request.bindings.request.conditions),
        method: "record-match" as const,
        evidence: "The checked record states this value under the specified conditions.",
        explanation: "The record supports the submitted fact.",
        conflicts: [],
        integrity: "honest" as const,
        ...rule?.(request),
      },
    };
  }, { seen });
}

function fixture(t: TestContext, limits = LIMITS): {
  path: string;
  table: FileFactTable;
  judge: ReturnType<typeof verifier>;
  reopen(): FileFactTable;
} {
  const directory = mkdtempSync(join(tmpdir(), "blind-facts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "run-1", "facts.jsonl");
  let tick = 1000;
  const judge = verifier();
  const reopen = (): FileFactTable => {
    const table = new FileFactTable({ logPath: path, limits, now: () => ++tick });
    table.attachVerifier(judge);
    return table;
  };
  return { path, table: reopen(), judge, reopen };
}

function viewPath(path: string, taskId: string, suffix: "json" | "jsonl" = "jsonl"): string {
  return join(dirname(path), "fact-views", hash(GROUP), `${hash(taskId)}.${suffix}`);
}

async function submit(access: FactAccess, taskId: string, claim: string) {
  return access.submit(factRequesterOf(scope(taskId), taskId), fact(claim), {});
}

const ids = (entries: readonly FactEntry[]): string[] => entries.map((entry) => entry.id);

test("same-round critics see the frozen table and their own facts, including a view opened after a peer publishes", async (t) => {
  const { table } = fixture(t);
  const initial = await submit(table, "thinker", "The calibration cohort includes eight observations.");
  assert.ok(initial.badge);
  const alice = await table.forTask("a", scope("a"));
  const ownA = await submit(alice, "a", "The calibration cohort uses protocol alpha.");
  assert.ok(ownA.badge);

  // Bob's first call happens only after Alice's verified fact is globally published.
  const bob = await table.forTask("b", scope("b"));
  assert.deepEqual(ids(await bob.entries()), [initial.badge.id]);
  const ownB = await submit(bob, "b", "The calibration cohort uses instrument beta.");
  assert.ok(ownB.badge);
  assert.deepEqual(ids(await alice.entries()), [initial.badge.id, ownA.badge.id]);
  assert.deepEqual(ids(await bob.entries()), [initial.badge.id, ownB.badge.id]);

  const chairScope: FactScope = { role: "review-chair", agent: "review-chair", seat: "thinker-1", step: 2 };
  const chair = await table.forTask("chair", chairScope);
  assert.equal(chair, table);
  assert.deepEqual(new Set(ids(await chair.entries())), new Set([initial.badge.id, ownA.badge.id, ownB.badge.id]));
  assert.equal((await alice.entries()).find((entry) => entry.id === ownA.badge!.id)!.status, "justified");
  assert.equal((await chair.entries()).find((entry) => entry.id === ownA.badge!.id)!.status, "disputed");

  const status = await runFactTable(table, scope("b"), "b", { mode: "status", ids: [ownA.badge.id] });
  assert.deepEqual((status.output as JsonObject).unknown, [ownA.badge.id]);
  assert.deepEqual((status.output as JsonObject).entries, []);
  const globalStatus = await runFactTable(table, chairScope, "chair", { mode: "status", ids: [ownA.badge.id] });
  assert.equal(((globalStatus.output as JsonObject).entries as JsonObject[]).length, 1);
  assert.equal(JSON.stringify(globalStatus.output).includes("requesters"), false);

  const nextRound = await table.forTask("c", scope("c", `${GROUP}/next`));
  assert.deepEqual(ids(await nextRound.entries()), ids(await table.entries()));
});

test("private submissions neither deduplicate against a peer nor expose peers to the verifier", async (t) => {
  const { table, judge } = fixture(t);
  const seed = await submit(table, "thinker", "The calibration cohort has eight observations.");
  assert.ok(seed.badge);
  const alice = await table.forTask("a", scope("a"));
  const sharedClaim = "The calibration cohort has eleven observations under protocol alpha.";
  const ownA = await submit(alice, "a", sharedClaim);
  assert.ok(ownA.badge);
  const bob = await table.forTask("b", scope("b"));
  const before = judge.seen.length;
  const ownB = await submit(bob, "b", sharedClaim);
  assert.equal(ownB.case, "justified-new", "the peer's private fact must not satisfy Bob's duplicate lookup");
  assert.ok(ownB.badge);
  assert.notEqual(ownB.badge.id, ownA.badge.id);
  assert.equal(judge.seen.length, before + 1);
  const related = judge.seen.at(-1)!.bindings.related as JsonObject[];
  assert.ok(related.some((entry) => entry.id === seed.badge!.id));
  assert.equal(related.some((entry) => entry.id === ownA.badge!.id), false);
  assert.equal(JSON.stringify(related).includes("requesters"), false);

  const beforeDuplicate = judge.seen.length;
  const repeated = await submit(alice, "a", sharedClaim);
  assert.equal(repeated.case, "justified");
  assert.equal(repeated.badge?.id, ownA.badge.id);
  assert.equal(judge.seen.length, beforeDuplicate, "Alice can reuse her own verified facts");
});

test("parallel views and later global submissions receive distinct fact and submission identifiers", async (t) => {
  const { table } = fixture(t);
  const tasks = ["a", "b", "c", "d"];
  const views = await Promise.all(tasks.map((task) => table.forTask(task, scope(task))));
  const outcomes = await Promise.all(views.map((view, index) => submit(view, tasks[index]!, `The calibration cohort has marker ${index}.`)));
  outcomes.push(await submit(table, "chair", "The calibration cohort has a final global record."));
  assert.ok(outcomes.every((outcome) => outcome.badge !== undefined));
  assert.equal(new Set(outcomes.map((outcome) => outcome.badge!.id)).size, outcomes.length);
  assert.equal(new Set(outcomes.map((outcome) => outcome.submission)).size, outcomes.length);
  assert.equal((await table.entries()).length, outcomes.length);
});

test("contradictory new peer facts await a shared check and resubmission reaches the supreme judge", async (t) => {
  const { table } = fixture(t);
  const [alice, bob] = await Promise.all([table.forTask("a", scope("a")), table.forTask("b", scope("b"))]);
  const claimA = "The calibration cohort contains exactly eight observations.";
  const claimB = "The calibration cohort contains exactly eleven observations.";
  const [a, b] = await Promise.all([submit(alice, "a", claimA), submit(bob, "b", claimB)]);
  assert.ok(a.badge);
  assert.ok(b.badge);
  assert.equal(a.badge.status, "justified");
  assert.equal(b.badge.status, "justified");
  assert.deepEqual((await table.entries()).map((entry) => entry.status), ["disputed", "disputed"]);

  const sharedJudge = verifier(() => ({
    case: "justified-new",
    conflicts: [{ id: b.badge!.id, resolution: "incumbent-revoked", explanation: "The complete shared record shows eight observations, not eleven." }],
  }));
  table.attachVerifier(sharedJudge);
  const chair = await table.submit({ taskId: "chair", role: "review-chair", agent: "review-chair" }, fact(claimA), {});
  assert.equal(sharedJudge.seen.length, 1, "a privately verified match must not take the global duplicate shortcut");
  const related = sharedJudge.seen[0]!.bindings.related as JsonObject[];
  assert.deepEqual(new Set(related.map((entry) => entry.id)), new Set([a.badge.id, b.badge.id]));
  assert.ok(chair.badge);
  assert.equal(chair.badge.status, "justified");
  assert.notEqual(chair.badge.id, a.badge.id);
  assert.equal((await table.entries()).find((entry) => entry.id === b.badge!.id)!.status, "revoked");
  assert.equal((await table.entries()).filter((entry) => entry.status === "justified").length, 1);
  // Shared reconciliation is deliberately invisible to the still-isolated critics.
  assert.equal((await alice.entries()).find((entry) => entry.id === a.badge!.id)!.status, "justified");
  assert.equal((await bob.entries()).find((entry) => entry.id === b.badge!.id)!.status, "justified");
});

test("a privately narrowed justified standing awaits shared verification, while simple reuse preserves a shared badge", async (t) => {
  const { table } = fixture(t);
  const claim = "The calibration cohort's readings are valid.";
  const seed = await submit(table, "thinker", claim);
  assert.ok(seed.badge);
  const alice = await table.forTask("a", scope("a"));
  await submit(alice, "a", claim);
  assert.equal((await table.entries()).find((entry) => entry.id === seed.badge!.id)!.status, "justified");
  table.attachVerifier(verifier(() => ({
    case: "narrowed",
    conflicts: [{ id: seed.badge!.id, resolution: "both-narrowed", conditions: "protocol alpha only", explanation: "The calibration record covers protocol alpha only." }],
  })));
  await submit(alice, "a", "The calibration cohort's readings are valid under protocol alpha.");
  assert.equal((await alice.entries()).find((entry) => entry.id === seed.badge!.id)!.status, "justified");
  const global = (await table.entries()).find((entry) => entry.id === seed.badge!.id)!;
  assert.equal(global.status, "disputed");
  assert.equal(global.conditions, "protocol alpha only");
});

test("resume restores each frozen view, own facts, and the private task's submission budget", async (t) => {
  const { table, reopen, judge } = fixture(t, { ...LIMITS, submissionsPerTask: 2 });
  const alice = await table.forTask("a", scope("a"));
  const first = await submit(alice, "a", "The calibration cohort has marker alpha.");
  assert.ok(first.badge);
  const resumed = reopen();
  const resumedAlice = await resumed.forTask("a", scope("a"));
  assert.deepEqual(ids(await resumedAlice.entries()), [first.badge.id]);
  const lateBob = await resumed.forTask("b", scope("b"));
  assert.deepEqual(await lateBob.entries(), [], "the persisted group snapshot predates Alice's fact");
  const second = await submit(resumedAlice, "a", "The calibration cohort has marker beta.");
  assert.ok(second.badge);
  assert.notEqual(second.badge.id, first.badge.id);
  assert.notEqual(second.submission, first.submission);
  const beforeRefusal = judge.seen.length;
  const refused = await submit(resumedAlice, "a", "The calibration cohort has marker gamma.");
  assert.equal(refused.case, "unverified");
  assert.match(refused.refusal!, /used its 2 submissions/);
  assert.equal(judge.seen.length, beforeRefusal);
  assert.deepEqual(ids(await resumed.entries()), [first.badge.id, second.badge.id]);
});

test("conflicting private changes leave global standing disputed and cannot be overwritten by replay", async (t) => {
  const { table, path, reopen } = fixture(t);
  const seed = await submit(table, "thinker", "The calibration cohort's readings are valid.");
  assert.ok(seed.badge);
  const [alice, bob] = await Promise.all([table.forTask("a", scope("a")), table.forTask("b", scope("b"))]);
  table.attachVerifier(verifier((request) => ({
    case: "narrowed",
    conflicts: [{
      id: seed.badge!.id, resolution: "both-narrowed",
      conditions: String(request.bindings.request.claim).includes("alpha") ? "protocol alpha only" : "protocol beta only",
      explanation: "The calibration record supports only the named protocol.",
    }],
  })));
  await Promise.all([
    submit(alice, "a", "The calibration cohort's readings are valid under protocol alpha."),
    submit(bob, "b", "The calibration cohort's readings are valid under protocol beta."),
  ]);
  const global = (await table.entries()).find((entry) => entry.id === seed.badge!.id)!;
  assert.equal(global.status, "disputed");
  assert.equal((await alice.entries()).find((entry) => entry.id === seed.badge!.id)!.conditions, "protocol alpha only");
  assert.equal((await bob.entries()).find((entry) => entry.id === seed.badge!.id)!.conditions, "protocol beta only");
  const beforeRead = readFileSync(path, "utf8");
  await alice.entries();
  await bob.entries();
  assert.equal(readFileSync(path, "utf8"), beforeRead, "unchanged private reads do not republish standing");
  const resumed = reopen();
  await (await resumed.forTask("a", scope("a"))).entries();
  await (await resumed.forTask("b", scope("b"))).entries();
  assert.deepEqual((await resumed.entries()).find((entry) => entry.id === seed.badge!.id), global);
});

test("a missing or corrupt established group snapshot fails closed instead of copying live peer facts", async (t) => {
  for (const damage of ["missing", "corrupt"] as const) {
    await t.test(damage, async (childTest) => {
      const { table, path, reopen } = fixture(childTest);
      const alice = await table.forTask("a", scope("a"));
      await submit(alice, "a", "The calibration cohort has Alice's new private finding.");
      const snapshot = join(dirname(path), "fact-views", hash(GROUP), "snapshot.json");
      if (damage === "missing") rmSync(snapshot);
      else writeFileSync(snapshot, "not valid snapshot JSON", "utf8");
      await assert.rejects(reopen().forTask("b", scope("b")));
    });
  }
});

test("a missing published private journal cannot reset a task's budget or reuse its identifiers", async (t) => {
  const { table, path, reopen } = fixture(t, { ...LIMITS, submissionsPerTask: 1 });
  const alice = await table.forTask("a", scope("a"));
  const outcome = await submit(alice, "a", "The calibration cohort has a persisted private finding.");
  assert.ok(outcome.badge);
  rmSync(viewPath(path, "a"));
  await assert.rejects(reopen().forTask("a", scope("a")));
});

test("losing a journal that contains only unverified submissions cannot reset its budget", async (t) => {
  const { table, path, reopen } = fixture(t, { ...LIMITS, submissionsPerTask: 1 });
  table.attachVerifier(verifier(() => ({ case: "unverified", method: "none", evidence: "" })));
  const alice = await table.forTask("a", scope("a"));
  const outcome = await submit(alice, "a", "The calibration cohort has an uncheckable measurement.");
  assert.equal(outcome.case, "unverified");
  assert.deepEqual(await table.entries(), []);
  rmSync(viewPath(path, "a"));
  await assert.rejects(reopen().forTask("a", scope("a")));
});

test("a missing shared journal cannot reset identifier allocations while private views survive", async (t) => {
  const { table, path, reopen } = fixture(t);
  const alice = await table.forTask("a", scope("a"));
  const published = await submit(alice, "a", "The calibration cohort has a private fact with an allocated identifier.");
  assert.ok(published.badge);
  rmSync(path);
  const resumed = reopen();
  await assert.rejects(resumed.entries(), /journal|fact/i);
  await assert.rejects(resumed.forTask("b", scope("b")), /journal|fact/i);
  await assert.rejects(resumed.forTask("a", scope("a")), /journal|fact/i);
});

test("a failed private append exposes no new badge and keeps that view closed until reload", async (t) => {
  const { table, path, reopen } = fixture(t);
  const alice = await table.forTask("a", scope("a"));
  const journal = viewPath(path, "a");
  const saved = `${journal}.saved`;
  renameSync(journal, saved);
  mkdirSync(journal); // EISDIR is deterministic even when tests run with elevated permissions.
  await assert.rejects(submit(alice, "a", "The calibration cohort has a finding that could not persist."));
  await assert.rejects(alice.entries());
  assert.deepEqual(await table.entries(), []);
  rmSync(journal, { recursive: true });
  renameSync(saved, journal);
  await assert.rejects(alice.entries(), "repairing storage must not silently revive the failed in-memory view");
  const recovered = await reopen().forTask("a", scope("a"));
  assert.deepEqual(await recovered.entries(), []);
});

test("a failed global publish withholds the private result until durable recovery", async (t) => {
  const { table, path, reopen } = fixture(t);
  const alice = await table.forTask("a", scope("a"));
  const saved = `${path}.saved`;
  renameSync(path, saved);
  mkdirSync(path);
  await assert.rejects(submit(alice, "a", "The calibration cohort has a durably private pending finding."));
  await assert.rejects(table.entries());
  await assert.rejects(table.forTask("b", scope("b")));
  rmSync(path, { recursive: true });
  renameSync(saved, path);
  const resumed = reopen();
  const recovered = await resumed.forTask("a", scope("a"));
  const entries = await recovered.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.status, "justified");
  assert.deepEqual(ids(await resumed.entries()), ids(entries));
  assert.equal((await resumed.entries())[0]!.status, "disputed");
  assert.deepEqual(await (await resumed.forTask("b", scope("b"))).entries(), []);
});

test("an incomplete strict transaction restores neither its fact nor its consumed budget", async (t) => {
  const { table, path, reopen } = fixture(t, { ...LIMITS, submissionsPerTask: 2 });
  const alice = await table.forTask("a", scope("a"));
  const first = await submit(alice, "a", "The calibration cohort has one complete finding.");
  assert.ok(first.badge);
  const orphan: FactEntry = { ...first.badge, id: "F:9999", claim: "An incomplete transaction's fact must stay invisible." };
  appendFileSync(viewPath(path, "a"), JSON.stringify({ type: "transaction", records: [
    { type: "entry", entry: orphan },
    { type: "submission", id: "S:9999", requester: factRequesterOf(scope("a"), "a"), badge: orphan.id },
  ] })); // Even syntactically complete JSON is uncommitted without its terminating newline.
  const resumed = reopen();
  const recovered = await resumed.forTask("a", scope("a"));
  assert.deepEqual(ids(await recovered.entries()), [first.badge.id]);
  const second = await submit(recovered, "a", "The calibration cohort has a second complete finding.");
  assert.ok(second.badge, second.refusal);
  assert.notEqual(second.badge.id, first.badge.id);
  assert.notEqual(second.submission, first.submission);
  assert.equal((await resumed.entries()).some((entry) => entry.id === orphan.id), false);
  // Appending must discard/invalidate the old tail, not finish its newline and
  // accidentally make it a committed transaction on the following restart.
  const again = reopen();
  const againAlice = await again.forTask("a", scope("a"));
  assert.deepEqual(ids(await againAlice.entries()), [first.badge.id, second.badge.id]);
  assert.equal((await again.entries()).some((entry) => entry.id === orphan.id), false);
});

test("tool access cannot silently use an unisolated implementation for a blind scope", async () => {
  let reads = 0;
  const unisolated: FactAccess = {
    entries: async () => { reads += 1; return []; },
    submit: async () => { throw new Error("not used"); },
  };
  await assert.rejects(runFactTable(unisolated, scope("a"), "a", { mode: "lookup", claim: "A fact." }), /isolated fact-table view/);
  assert.equal(reads, 0);
  assert.deepEqual(factScopeOf({ factScope: scope("a") }), scope("a"));
  assert.equal(factScopeOf({ factScope: { ...scope("a"), blindReview: "" } }), undefined);
});
