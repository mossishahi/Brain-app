import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  factBadgeHash, factReportHash, factStandingRevision,
  type FactConsultation, type FactEntry, type FactRequester, type FactSubmitContext,
  type FactTableLimits, type FactUseApproval, type JsonObject,
} from "@brainstorm-agentic/core";

import { FileFactTable, type FactVerificationRequest, type FactVerifier } from "../src/fact-table.js";
import type { FactConsultant, FactConsultationRequest } from "../src/fact-consultation.js";

const LIMITS: FactTableLimits = { submissionsPerTask: 6, relatedFacts: 2, lookupResults: 5, verificationMinutes: 1 };
const asker = (taskId = "critic-task"): FactRequester => ({ taskId, role: "game-commentor", agent: taskId, seat: "seat", step: 1 });
const chair: FactRequester = { taskId: "chair-task", role: "committee-chair", agent: "committee-chair", seat: "seat", step: 1 };
const submission = { claim: "The aggregate is bounded.", conditions: "finite inputs", evidence: "A complete finite-sum proof.", kind: "math" as const };
const fact = (id: string, extra: Partial<FactEntry> = {}): FactEntry => ({
  id, status: "justified", kind: "math", claim: `Independent statement ${id}`, conditions: "finite inputs",
  method: "judgement-only", evidence: "A checked proof.", createdAt: 1, updatedAt: 1,
  history: [{ at: 1, event: "issued", detail: "The proof establishes this exact statement." }], requesters: [], ...extra,
});

function fixture(entries: readonly FactEntry[] = [], limits = LIMITS) {
  const directory = mkdtempSync(join(tmpdir(), "supreme-mediated-"));
  const logPath = join(directory, "facts.jsonl");
  writeFileSync(logPath, entries.map((entry) => JSON.stringify({ type: "entry", entry })).join("\n") + (entries.length ? "\n" : ""));
  return { logPath, table: new FileFactTable({ logPath, limits, accessMode: "supreme-mediated/v1" }) };
}

function consultation(rule?: (request: FactConsultationRequest) => FactConsultation | Promise<FactConsultation>) {
  const seen: FactConsultationRequest[] = [];
  const callback: FactConsultant = async (request) => {
    seen.push(request);
    const result = rule ? await rule(request) : {
      answer: "The shown evidence is semantically relevant under its stated conditions.",
      matches: (request.bindings.entries as JsonObject[]).map((entry) => ({
        factId: String(entry.id), relation: "equivalent" as const, reason: "The propositions have the same meaning.",
      })),
      ...(request.bindings.request.phase === "approve" ? { approval: {
        approved: true, targetFactId: String(request.bindings.request.proposedTargetFactId),
        reason: "The verified proposition supports this report under these conditions.",
      } } : {}),
    };
    return { result, taskId: `consult:${request.consultation}` };
  };
  return { callback, seen };
}

function verification(existing?: string) {
  const seen: FactVerificationRequest[] = [];
  const callback: FactVerifier = async (request) => {
    seen.push(request);
    return { taskId: `verify:${request.submission}`, verdict: {
      case: existing ? "justified" : "justified-new", claim: String(request.bindings.request.claim),
      conditions: String(request.bindings.request.conditions), method: "judgement-only",
      evidence: "Independently checked the complete proof.", explanation: "The proof establishes the claim.",
      conflicts: [], integrity: "honest", ...(existing ? { existing } : {}),
    } };
  };
  return { callback, seen };
}

function reviewContext(justification = "The shown proof establishes the bound [F:1]."): FactSubmitContext {
  return { review: { chairTaskId: chair.taskId, reviewVersion: "review-version",
    reports: { critic: { justification, reportHash: factReportHash({ q: 0.2, justification }) } } } };
}

test("mediated lookup scans every entry without lexical overlap, then bounds the displayed matches", async () => {
  const entries = Array.from({ length: 11 }, (_, index) => fact(`F:${index + 1}`));
  const { table, logPath } = fixture(entries);
  const consult = consultation();
  table.attachConsultant(consult.callback);
  const answer = await table.consult(asker(), { mode: "lookup", claim: "無限ではない", max_results: 1 }, {});
  assert.equal(consult.seen.length, 6);
  assert.deepEqual(consult.seen.flatMap((call) => (call.bindings.entries as JsonObject[]).map((entry) => entry.id)), entries.map((entry) => entry.id));
  assert.equal((answer.matches as unknown[]).length, 1);
  assert.equal("evidence" in ((answer.matches as JsonObject[])[0]!.badge as JsonObject), false);
  assert.equal("method" in ((answer.matches as JsonObject[])[0]!.badge as JsonObject), false);
  assert.equal(answer.totalMatches, 11);
  assert.equal(readFileSync(logPath, "utf8").includes('"semantic-alias"'), true);
  const resumed = new FileFactTable({ logPath, limits: LIMITS, accessMode: "supreme-mediated/v1" });
  const again = consultation();
  resumed.attachConsultant(again.callback);
  await resumed.consult(asker(), { mode: "lookup", claim: "無限ではない" }, {});
  assert.equal(again.seen.length, 6);
  assert.deepEqual(again.seen.flatMap((call) => (call.bindings.entries as JsonObject[]).map((entry) => entry.id)), entries.map((entry) => entry.id));
  for (const call of again.seen) {
    const shown = (call.bindings.entries as JsonObject[]).map((entry) => entry.id);
    const aliases = call.bindings.request.certifiedAliases as JsonObject[];
    assert.deepEqual(aliases.map((alias) => alias.targetId), shown);
  }
});

test("mediated submissions do not take the exact-text shortcut or cut semantic candidates to top eight", async () => {
  const entries = Array.from({ length: 11 }, (_, index) => fact(`F:${index + 1}`));
  const { table } = fixture(entries);
  const consult = consultation();
  const verify = verification("F:11");
  table.attachConsultant(consult.callback);
  table.attachVerifier(verify.callback);
  const outcome = await table.submit(asker(), { ...submission, claim: entries[0]!.claim }, {});
  assert.equal(outcome.badge?.id, "F:11");
  assert.equal(consult.seen.length, 6);
  assert.deepEqual((verify.seen[0]!.bindings.related as JsonObject[]).map((entry) => entry.id), entries.map((entry) => entry.id));
});

test("mediated submit issues and durably records a content hash without exposing a raw badge record", async () => {
  const { table, logPath } = fixture();
  table.attachConsultant(consultation().callback);
  table.attachVerifier(verification().callback);
  const result = await table.consult(asker(), { mode: "submit", ...submission }, {});
  const issued = (await table.entries())[0]!;
  assert.equal(issued.badgeHash, factBadgeHash(issued));
  assert.equal((result.badge as JsonObject).badgeHash, issued.badgeHash);
  assert.equal("evidence" in (result.badge as JsonObject), false);
  assert.equal("method" in (result.badge as JsonObject), false);
  assert.equal(readFileSync(logPath, "utf8").includes(`"badgeHash":"${issued.badgeHash}"`), true);
  const resumed = new FileFactTable({ logPath, limits: LIMITS, accessMode: "supreme-mediated/v1" });
  assert.equal((await resumed.entries())[0]!.badgeHash, issued.badgeHash);
});

test("an incomplete semantic scan cannot certify absence or issue a badge", async () => {
  const { table } = fixture([fact("F:1"), fact("F:2"), fact("F:3")]);
  const consult = consultation((request) => {
    if (request.bindings.request.batch === 2) throw new Error("second batch unavailable");
    return { answer: "No related entry in this batch.", matches: [] };
  });
  const verify = verification();
  table.attachConsultant(consult.callback);
  table.attachVerifier(verify.callback);
  const outcome = await table.submit(asker(), submission, {});
  assert.equal(outcome.case, "unverified");
  assert.match(outcome.refusal!, /second batch unavailable/);
  assert.equal(verify.seen.length, 0);
  assert.equal((await table.entries()).length, 3);
});

test("status is Supreme-mediated and returns all reviewed addressed badges even with no semantic matches", async () => {
  const entry = fact("F:1");
  const { table } = fixture([entry, fact("F:2")]);
  const consult = consultation(() => ({ answer: "The addressed badge still stands.", matches: [] }));
  table.attachConsultant(consult.callback);
  const answer = await table.consult(asker(), { mode: "status", ids: ["F:1", "F:99"] }, {});
  assert.equal(consult.seen.length, 1);
  assert.deepEqual((consult.seen[0]!.bindings.entries as JsonObject[]).map((entry) => entry.id), ["F:1"]);
  assert.equal((answer.entries as JsonObject[])[0]!.badgeHash, factBadgeHash(entry));
  assert.equal("evidence" in (answer.entries as JsonObject[])[0]!, false);
  assert.equal((consult.seen[0]!.bindings.entries as JsonObject[])[0]!.evidence, entry.evidence);
  assert.deepEqual(answer.unknown, ["F:99"]);
});

test("consultations reject invented matches outside the shown batch", async () => {
  const { table } = fixture([fact("F:1")]);
  table.attachConsultant(consultation(() => ({ answer: "Invented match.", matches: [
    { factId: "F:999", relation: "equivalent", reason: "Not actually shown." },
  ] })).callback);
  await assert.rejects(table.consult(asker(), { mode: "lookup", claim: "anything" }, {}), /outside its authorized batch/);
});

test("approval binds actual review, reconciles a paraphrase, survives resume, and does not spend submission quota", async () => {
  const cited = fact("F:1", { status: "disputed", claim: "Every term is nonnegative." });
  const equivalent = fact("F:2", { claim: "No summand is less than zero." });
  const limits = { ...LIMITS, submissionsPerTask: 1 };
  const { table, logPath } = fixture([cited, equivalent], limits);
  const consult = consultation();
  table.attachConsultant(consult.callback);
  table.attachVerifier(verification("F:2").callback);
  const result = await table.consult(chair, { mode: "approve", factId: cited.id, badgeHash: factBadgeHash(cited), criticId: "critic" }, reviewContext());
  const receipt = result.approval as unknown as FactUseApproval;
  assert.equal(receipt.approved, true);
  assert.equal(receipt.citedBadgeId, "F:1");
  assert.equal(receipt.targetBadgeId, "F:2");
  assert.equal(receipt.reportHash, reviewContext().review!.reports.critic!.reportHash);
  assert.equal(receipt.targetStandingRevision, factStandingRevision((await table.entries())[1]!));
  assert.equal("evidence" in (result.badge as JsonObject), false);
  assert.equal(consult.seen.some((call) => "criticId" in call.bindings.request), false);
  const resumed = new FileFactTable({ logPath, limits, accessMode: "supreme-mediated/v1" });
  assert.deepEqual((await resumed.evidence()).approvals, [receipt]);
  resumed.attachConsultant(consultation().callback);
  resumed.attachVerifier(verification("F:2").callback);
  assert.equal((await resumed.submit(chair, submission, {})).case, "justified");
  assert.equal((await resumed.submit(chair, submission, {})).case, "unverified");
});

test("denied approval is durable; forged review bindings, uncited badges and stale hashes fail closed", async () => {
  const entry = fact("F:1");
  const { table, logPath } = fixture([entry]);
  const consult = consultation(() => ({ answer: "The conclusion overreaches.", matches: [],
    approval: { approved: false, reason: "This condition does not apply to that inference." } }));
  table.attachConsultant(consult.callback);
  const query = { mode: "approve" as const, factId: entry.id, badgeHash: factBadgeHash(entry), criticId: "critic" };
  await assert.rejects(table.consult(asker(), query, reviewContext()), /actual committee task/);
  await assert.rejects(table.consult(chair, query, reviewContext("No cited badge.")), /actual committee task/);
  await assert.rejects(table.consult(chair, { ...query, badgeHash: `sha256:${"0".repeat(64)}` }, reviewContext()), /hash is stale/);
  const result = await table.consult(chair, query, reviewContext());
  assert.equal((result.approval as JsonObject).approved, false);
  const resumed = new FileFactTable({ logPath, limits: LIMITS, accessMode: "supreme-mediated/v1" });
  assert.deepEqual((await resumed.evidence()).approvals, [result.approval]);
  assert.equal(consult.seen.length, 1);
});

test("narrowing reissues the content hash and makes an earlier approval stale", async () => {
  const entry = fact("F:1");
  const { table, logPath } = fixture([entry]);
  table.attachConsultant(consultation().callback);
  const query = { mode: "approve" as const, factId: entry.id, badgeHash: factBadgeHash(entry), criticId: "critic" };
  const result = await table.consult(chair, query, reviewContext());
  const receipt = result.approval as unknown as FactUseApproval;
  table.attachVerifier(async (request) => ({ taskId: `verify:${request.submission}`, verdict: {
    case: "narrowed", claim: submission.claim, conditions: "positive finite inputs", method: "judgement-only",
    evidence: "The proof fails for a negative input.", explanation: "Both claims require positive inputs.",
    conflicts: [{ id: "F:1", resolution: "both-narrowed", conditions: "positive finite inputs", explanation: "The sign matters." }],
    integrity: "honest",
  } }));
  await table.submit(asker(), submission, {});
  const narrowed = (await table.entries()).find((candidate) => candidate.id === "F:1")!;
  assert.notEqual(factBadgeHash(narrowed), receipt.citedBadgeHash);
  assert.equal(narrowed.badgeHash, factBadgeHash(narrowed));
  assert.notEqual(factStandingRevision(narrowed), receipt.targetStandingRevision);
  await assert.rejects(table.consult(chair, query, reviewContext()), /hash is stale/);
  const resumed = new FileFactTable({ logPath, limits: LIMITS, accessMode: "supreme-mediated/v1" });
  const saved = await resumed.evidence();
  assert.deepEqual(saved.approvals, [receipt]);
  assert.notEqual(factBadgeHash(saved.facts.find((candidate) => candidate.id === "F:1")!), receipt.citedBadgeHash);
});

test("a concurrent unrelated entry forces full semantic re-verification before commit", async () => {
  const { table } = fixture();
  table.attachConsultant(consultation().callback);
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const first = new Promise<void>((resolve) => { release = resolve; });
  const seen: FactVerificationRequest[] = [];
  table.attachVerifier(async (request) => {
    seen.push(request);
    if (request.bindings.request.claim === "Alpha premise" && seen.filter((call) => call.bindings.request.claim === "Alpha premise").length === 1) {
      entered!();
      await first;
    }
    return { taskId: `verify:${request.submission}`, verdict: {
      case: "justified-new", claim: String(request.bindings.request.claim), conditions: "none", method: "judgement-only",
      evidence: "The complete proof was checked.", explanation: "The proof holds.", conflicts: [], integrity: "honest",
    } };
  });
  const pending = table.submit(asker("a"), { ...submission, claim: "Alpha premise", conditions: "none" }, {});
  await ready;
  await table.submit(asker("b"), { ...submission, claim: "無関係", conditions: "別条件" }, {});
  release!();
  await pending;
  const checked = seen.filter((request) => request.bindings.request.claim === "Alpha premise");
  assert.equal(checked.length, 2);
  assert.equal((checked[1]!.bindings.related as JsonObject[]).length, 1);
});

test("mediated private views preserve frozen facts and own semantic aliases across resume", async () => {
  const { table, logPath } = fixture([fact("F:1")]);
  const consult = consultation();
  table.attachConsultant(consult.callback);
  table.attachVerifier(verification().callback);
  const scope = { role: "game-commentor", agent: "a", blindReview: "round-1" };
  const a = await table.forTask("a", scope);
  const b = await table.forTask("b", { ...scope, agent: "b" });
  assert.equal(a.accessMode, "supreme-mediated/v1");
  const own = await a.submit(asker("a"), submission, {});
  assert.ok(own.badge);
  consult.seen.length = 0;
  await b.consult!(asker("b"), { mode: "lookup", claim: submission.claim }, {});
  assert.deepEqual(consult.seen.flatMap((call) => (call.bindings.entries as JsonObject[]).map((entry) => entry.id)), ["F:1"]);
  const resumed = new FileFactTable({ logPath, limits: LIMITS, accessMode: "supreme-mediated/v1" });
  const again = consultation();
  resumed.attachConsultant(again.callback);
  const resumedB = await resumed.forTask("b", { ...scope, agent: "b" });
  await resumedB.consult!(asker("b"), { mode: "lookup", claim: submission.claim }, {});
  assert.deepEqual(again.seen.flatMap((call) => (call.bindings.entries as JsonObject[]).map((entry) => entry.id)), ["F:1"]);
});

test("mediated replies are withheld when the strict consultation journal cannot be committed", async () => {
  const { table, logPath } = fixture([fact("F:1")]);
  await table.entries();
  table.attachConsultant(consultation().callback);
  renameSync(logPath, `${logPath}.saved`);
  mkdirSync(logPath);
  await assert.rejects(table.consult(asker(), { mode: "lookup", claim: "bound" }, {}));
  await assert.rejects(table.evidence());
});
