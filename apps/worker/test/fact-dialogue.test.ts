import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { factBadgeHash, type FactConsultQuery, type FactEntry, type FactRequester, type FactVerdict, type JsonObject } from "@brainstorm-agentic/core";
import { FileFactTable, type FactVerificationRequest } from "../src/fact-table.js";
import type { FactConsultant } from "../src/fact-consultation.js";

const asker: FactRequester = { taskId: "critic-task", role: "commentor", agent: "critic-1", seat: "member-1" };
const limits = { submissionsPerTask: 6, relatedFacts: 8, lookupResults: 5, verificationMinutes: 1 };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function ruling(request: FactVerificationRequest, patch: Partial<FactVerdict> = {}): FactVerdict {
  return { case: "justified-new", claim: String(request.bindings.request.claim), conditions: String(request.bindings.request.conditions),
    method: "re-executed", evidence: "Independently evaluated the finite example.", explanation: "The stated proposition follows under these conditions.",
    conflicts: [], integrity: "honest", ...patch };
}
const matching: FactConsultant = async request => ({ taskId: "consultation", result: {
  answer: "Compare the selected claims and their exact conditions; justify a distinct proposition separately.",
  matches: (request.bindings.entries as JsonObject[]).map(entry => ({ factId: String(entry.id),
    relation: entry.claim === request.bindings.request.claim ? "equivalent" : "related",
    conditionsRelation: entry.conditions === request.bindings.request.conditions ? "same" : "different", reason: "Compared proposition and scope." })),
  ...(request.bindings.request.phase === "approve" ? { approval: { approved: true, targetFactId: String(request.bindings.request.factId), reason: "This use fits the verified conditions." } } : {}),
} });
async function fixture(path?: string): Promise<{ table: FileFactTable; path: string }> {
  path ??= join(await mkdtemp(join(tmpdir(), "facts-dialogue-")), "facts.jsonl");
  const table = new FileFactTable({ logPath: path, limits, accessMode: "supreme-dialogue/v2" });
  table.attachConsultant(matching);
  table.attachVerifier(async request => ({ verdict: ruling(request), taskId: "verifier" }));
  return { table, path };
}
async function lookup(table: FileFactTable, claim = "The finite sum equals four", owner = asker): Promise<string> {
  const answer = await table.consult(owner, { mode: "lookup", claim }, {});
  assert.equal(answer.state, "open"); return String(answer.conversationId);
}
function justify(conversationId: string, claim = "The finite sum equals four", conditions = "For input [2,2]"): FactConsultQuery {
  return { mode: "reply", conversationId, action: "justify", claim, conditions, kind: "result", evidence: "Compute 2 + 2 = 4." };
}
async function issue(table: FileFactTable, claim = "The finite sum equals four", conditions = "For input [2,2]"): Promise<FactEntry> {
  const id = await lookup(table, claim); const result = await table.consult(asker, justify(id, claim, conditions), {});
  assert.equal(result.state, "closed");
  return (await table.entries()).find(entry => entry.id === (result.badge as JsonObject).id)!;
}

test("v2 claim-only lookup, justification, badge selection and discarded conversation", async () => {
  const { table, path } = await fixture();
  await assert.rejects(table.consult(asker, { mode: "lookup", claim: "x", evidence: "premature evidence" }, {}), /only the claim/);
  const id = await lookup(table);
  const pendingPath = join(dirname(path), "fact-dialogues", `${id}.json`);
  assert.match(await readFile(pendingPath, "utf8"), /critic-task/);
  assert.equal((await table.entries()).length, 0);
  const result = await table.consult(asker, justify(id), {});
  assert.equal(result.state, "closed"); assert.equal(result.case, "justified-new");
  await assert.rejects(readFile(pendingPath), /ENOENT/);
  const entry = (await table.entries())[0]!;
  assert.equal(entry.status, "justified");
  const ledger = await readFile(path, "utf8");
  assert(!ledger.includes('"messages"')); assert(!ledger.includes('Compare the selected claims'));
  const usage = ledger.trim().split("\n").flatMap(line => JSON.parse(line).records).filter(record => record.type === "consultation-usage");
  assert(usage.length > 0); assert(usage.every(record => record.requesterTaskId === asker.taskId));
  const second = await lookup(table, "Related but different claim");
  const selected = await table.consult(asker, { mode: "reply", conversationId: second, action: "badge", factId: entry.id, badgeHash: factBadgeHash(entry) }, {});
  assert.equal((selected.badge as JsonObject).claim, entry.claim);
  assert.equal((selected.badge as JsonObject).evidence, entry.evidence);
  assert.match(String(selected.answer), /does not verify a different proposition/);
  assert.equal((await table.entries()).length, 1);
  assert.equal(await table.forTask("other-critic", { role: "commentor", agent: "other", blindReview: "round" }), table);
  await assert.rejects(table.submit(asker, { claim: "x", conditions: "none", evidence: "x", kind: "result" }, {}), /lookup/);
});

test("open dialogues survive restart, are requester-bound and close removes actual files", async () => {
  const first = await fixture(); const id = await lookup(first.table);
  const resumed = (await fixture(first.path)).table;
  await assert.rejects(resumed.consult({ ...asker, taskId: "intruder" }, { mode: "reply", conversationId: id, action: "close" }, {}), /different requester/);
  const clarified = await resumed.consult(asker, { mode: "reply", conversationId: id, action: "clarify", message: "Use only this finite example." }, {});
  assert.equal(clarified.state, "open");
  await resumed.consult(asker, { mode: "reply", conversationId: id, action: "close" }, {});
  assert.deepEqual(await readdir(join(dirname(first.path), "fact-dialogues")), []);
  assert(!(await readFile(first.path, "utf8")).includes("Use only this finite example"));
});

test("accepted decisions replay without duplicate verification after restart", async () => {
  const { table, path } = await fixture(); const id = await lookup(table); const query = justify(id);
  const original = await table.consult(asker, query, {});
  const resumed = (await fixture(path)).table;
  resumed.attachVerifier(async () => { throw new Error("must not repeat accepted verification"); });
  const replay = await resumed.consult(asker, query, {});
  assert.equal((replay.badge as JsonObject).id, (original.badge as JsonObject).id);
  assert.equal((await resumed.entries()).length, 1);
});

test("same proposition plus different conditions cannot silently reuse an incumbent badge", async () => {
  const { table } = await fixture(); const base = await issue(table);
  table.attachVerifier(async request => ({ taskId: "reuse", verdict: ruling(request, { case: "justified", existing: base.id }) }));
  const id = await lookup(table, base.claim);
  await assert.rejects(table.consult(asker, justify(id, base.claim, "For all real inputs"), {}), /same proposition and the same verified conditions/);
  assert.equal((await table.entries()).length, 1);
  await table.consult(asker, justify(id, base.claim, base.conditions), {});
  assert.equal((await table.entries()).length, 1);
});

test("new scoped implication receives its own badge with checked revision dependencies", async () => {
  const { table } = await fixture(); const base = await issue(table);
  const dependencies = [{ id: base.id, badgeHash: factBadgeHash(base) }];
  table.attachVerifier(async request => ({ taskId: "derive", verdict: ruling(request, { evidence: `Apply [${base.id}] to the first example.`, dependencies }) }));
  const derived = await issue(table, "The first example has positive sum", "The finite example only");
  assert.notEqual(derived.id, base.id); assert.deepEqual(derived.dependencies, dependencies);
  assert.equal((await table.entries()).find(e => e.id === base.id)?.conditions, base.conditions);
  table.attachVerifier(async request => ({ taskId: "invalid", verdict: ruling(request, { evidence: `Uses [${base.id}] without tracking its revision.` }) }));
  const id = await lookup(table, "Another conclusion");
  await assert.rejects(table.consult(asker, justify(id, "Another conclusion"), {}), /exact dependency/);
  table.attachVerifier(async request => ({ taskId: "stale", verdict: ruling(request, { dependencies: [{ id: base.id, badgeHash: `sha256:${"0".repeat(64)}` }] }) }));
  await assert.rejects(table.consult(asker, justify(id, "Another conclusion"), {}), /stale/);
  assert.equal((await table.entries()).length, 2);
});

test("ready writes run sequentially while independent reads see committed snapshots", async () => {
  const { table } = await fixture(); const a = await lookup(table, "A"), b = await lookup(table, "B");
  const entered = deferred(), release = deferred(); const order: string[] = [];
  table.attachVerifier(async request => {
    const claim = String(request.bindings.request.claim); order.push(claim);
    if (claim === "A") { entered.resolve(); await release.promise; }
    return { taskId: claim, verdict: ruling(request) };
  });
  const first = table.consult(asker, justify(a, "A"), {}); await entered.promise;
  const second = table.consult(asker, justify(b, "B"), {});
  const read = await table.consult(asker, { mode: "lookup", claim: "C" }, {});
  assert.deepEqual(read.matches, []); assert.deepEqual(order, ["A"]);
  assert.equal((await table.entries()).length, 0);
  release.resolve(); await Promise.all([first, second]);
  assert.deepEqual(order, ["A", "B"]);
  assert.deepEqual((await table.entries()).map(e => e.claim), ["A", "B"]);
});

test("unrelated commits do not restart an in-flight read, and stale selections are rejected", async () => {
  const { table } = await fixture(); const old = await issue(table);
  const entered = deferred(), release = deferred(); let slowReads = 0;
  table.attachConsultant(async request => {
    if (request.bindings.request.claim === "slow read") { slowReads++; entered.resolve(); await release.promise; }
    return matching(request);
  });
  const pending = table.consult(asker, { mode: "lookup", claim: "slow read" }, {}); await entered.promise;
  await issue(table, "Unrelated fact"); release.resolve();
  const result = await pending; assert.equal(slowReads, 1); assert.equal((result.matches as unknown[]).length, 1);
  table.attachVerifier(async request => ({ taskId: "correct", verdict: ruling(request, { conflicts: [{ id: old.id, resolution: "incumbent-revoked", explanation: "Counterexample disproves the old scope." }] }) }));
  await issue(table, "Corrected fact");
  await assert.rejects(table.consult(asker, { mode: "reply", conversationId: String(result.conversationId), action: "badge", factId: old.id, badgeHash: factBadgeHash(old) }, {}), /changed/);
});

test("challenge replacement atomically withdraws transitive dependents and replays durable notifications", async () => {
  const { table, path } = await fixture(); const base = await issue(table, "Base");
  table.attachVerifier(async request => ({ taskId: "derived", verdict: ruling(request, { dependencies: [{ id: base.id, badgeHash: factBadgeHash(base) }] }) }));
  const child = await issue(table, "Child");
  table.attachVerifier(async request => ({ taskId: "grandchild", verdict: ruling(request, { dependencies: [{ id: child.id, badgeHash: factBadgeHash(child) }] }) }));
  const grandchild = await issue(table, "Grandchild");
  const events: string[] = []; table.onUpdate(event => { events.push(event.deletion.id); throw new Error("simulate crash before delivery"); });
  table.attachVerifier(async request => ({ taskId: "challenge", verdict: ruling(request, { conflicts: [{ id: base.id, resolution: "incumbent-revoked", explanation: "The counterexample invalidates the base." }] }) }));
  const id = await lookup(table, "Corrected base");
  const result = await table.consult(asker, { ...justify(id, "Corrected base"), action: "challenge", factId: base.id, badgeHash: factBadgeHash(base) }, {});
  assert.deepEqual(events, [base.id, child.id, grandchild.id]);
  assert.deepEqual((await table.entries()).map(e => e.id), [(result.badge as JsonObject).id]);
  const resumed = (await fixture(path)).table;
  assert.deepEqual((await resumed.updateEvents()).map(e => e.deletion.id), events);
  assert.equal((await resumed.updateEvents())[0]!.replacement!.id, (result.badge as JsonObject).id);
  assert.equal(await resumed.deletionEpoch(), 3);
});

test("both-narrowed creates separate corrected incumbent and incoming records", async () => {
  const { table } = await fixture(); const old = await issue(table, "All examples have value four", "All examples");
  table.attachVerifier(async request => ({ taskId: "narrow", verdict: ruling(request, { case: "narrowed", conflicts: [{ id: old.id, resolution: "both-narrowed", conditions: "Example A only",
    explanation: "The examples differ; neither universal statement holds.", replacement: { claim: "Example A has value four", conditions: "Example A only", method: "re-executed", evidence: "Independently evaluated A: 4." } }] }) }));
  const incoming = await issue(table, "Example B has value five", "Example B only");
  const entries = await table.entries(); assert.equal(entries.length, 2);
  const replacement = entries.find(e => e.id !== incoming.id)!;
  assert.equal(replacement.claim, "Example A has value four"); assert.notEqual(replacement.id, old.id);
  assert.equal((await table.deletions())[0]!.replacedBy, replacement.id);
  assert.equal((await table.updateEvents())[0]!.entry.claim, old.claim);
});

test("unresolved conflicts and invalid claims never create unverified active rows", async () => {
  const { table } = await fixture(); const old = await issue(table);
  table.attachVerifier(async request => ({ taskId: "conflict", verdict: ruling(request, { case: "conflict", method: "none", evidence: "", conflicts: [{ id: old.id, resolution: "disputed", explanation: "The prior evidence cannot resolve this counterexample." }] }) }));
  const id = await lookup(table, "Contrary claim");
  const answer = await table.consult(asker, { ...justify(id, "Contrary claim"), action: "challenge", factId: old.id, badgeHash: factBadgeHash(old) }, {});
  assert.equal(answer.state, "open"); assert.equal((await table.entries()).length, 0);
  table.attachVerifier(async request => ({ taskId: "invalid", verdict: ruling(request, { case: "not-a-fact", method: "none", evidence: "" }) }));
  await table.consult(asker, justify(id, "We should prefer blue"), {});
  assert.equal((await table.entries()).length, 0);
});

test("approval checks the actual use without another verification or unrelated-table retry", async () => {
  const { table } = await fixture(); const fact = await issue(table);
  const entered = deferred(), release = deferred(); let count = 0;
  table.attachConsultant(async request => {
    if (request.bindings.request.phase === "approve") { count++; entered.resolve(); await release.promise; }
    return matching(request);
  });
  const chair = { taskId: "chair", role: "committee-chair", agent: "chair" };
  const query: FactConsultQuery = { mode: "approve", criticId: "c1", factId: fact.id, badgeHash: factBadgeHash(fact) };
  const context = { review: { chairTaskId: "chair", reviewVersion: "v1", reports: { c1: { reportHash: "report", justification: `This step uses [${fact.id}].` } } } };
  await assert.rejects(table.consult(asker, query, context), /actual committee task/);
  const approval = table.consult(chair, query, context); await entered.promise;
  await issue(table, "Unrelated example");
  table.attachVerifier(async () => { throw new Error("approval must not verify again"); });
  release.resolve(); const answer = await approval;
  assert.equal(count, 1); assert.equal((answer.approval as JsonObject).approved, true);
  assert.equal((await table.evidence()).approvals.length, 1);
});

test("failed durable ruling exposes no badge and no withdrawal notifications", async () => {
  const { table, path } = await fixture(); const id = await lookup(table);
  table.attachVerifier(async request => {
    await rm(path); await mkdir(path);
    return { taskId: "failure", verdict: ruling(request) };
  });
  let events = 0; table.onUpdate(() => { events++; });
  await assert.rejects(table.consult(asker, justify(id), {}), /EISDIR/);
  assert.equal(events, 0);
  await assert.rejects(table.entries(), /EISDIR/);
  await rm(path, { recursive: true });
  const resumed = (await fixture(path)).table;
  assert.equal((await resumed.entries()).length, 0);
});

test("verification timeout releases writer queue even when a verifier ignores cancellation", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "facts-dialogue-timeout-")), "facts.jsonl");
  const table = new FileFactTable({ logPath: path, limits: { ...limits, verificationMinutes: 0.01 }, accessMode: "supreme-dialogue/v2" });
  table.attachConsultant(matching);
  const id = await lookup(table);
  table.attachVerifier(async () => new Promise(() => undefined));
  // Keep the process alive while AbortSignal.timeout's unreferenced timer fires.
  const keepAlive = setInterval(() => undefined, 10);
  try { await assert.rejects(table.consult(asker, justify(id), {}), /timeout|timed out/i); }
  finally { clearInterval(keepAlive); }
  table.attachVerifier(async request => ({ taskId: "next", verdict: ruling(request) }));
  await issue(table, "Next fact"); assert.equal((await table.entries()).length, 1);
});

test("cancelling a queued writer returns promptly and never executes its verification", async () => {
  const { table } = await fixture(); const firstId = await lookup(table, "First"), secondId = await lookup(table, "Cancelled");
  const entered = deferred(), release = deferred(); const verified: string[] = [];
  table.attachVerifier(async request => {
    verified.push(String(request.bindings.request.claim)); entered.resolve(); await release.promise;
    return { taskId: "writer", verdict: ruling(request) };
  });
  const first = table.consult(asker, justify(firstId, "First"), {}); await entered.promise;
  const controller = new AbortController();
  const second = table.consult(asker, justify(secondId, "Cancelled"), { signal: controller.signal });
  controller.abort(new Error("request cancelled"));
  await assert.rejects(second, /request cancelled/);
  release.resolve(); await first;
  assert.deepEqual(verified, ["First"]);
  assert.deepEqual((await table.entries()).map(e => e.claim), ["First"]);
});

test("replaying an accepted reply after its badge was withdrawn cannot return that badge", async () => {
  const { table, path } = await fixture(); const originalId = await lookup(table, "Original");
  const originalQuery = justify(originalId, "Original"); await table.consult(asker, originalQuery, {});
  const original = (await table.entries())[0]!;
  table.attachVerifier(async request => ({ taskId: "replacement", verdict: ruling(request, { conflicts: [{ id: original.id, resolution: "incumbent-revoked", explanation: "Counterexample verified." }] }) }));
  await issue(table, "Replacement");
  const resumed = (await fixture(path)).table;
  const replay = await resumed.consult(asker, originalQuery, {});
  assert.equal(replay.badge, undefined); assert.match(String(replay.answer), /withdrawn/);
});

test("withdrawn conflict responses explicitly mark the historical entry unusable", async () => {
  const { table } = await fixture(); const old = await issue(table);
  table.attachVerifier(async request => ({ taskId: "unresolved", verdict: ruling(request, { case: "conflict", conflicts: [{ id: old.id, resolution: "disputed", explanation: "Conflicting evidence leaves neither claim justified." }] }) }));
  const id = await lookup(table, "Contrary");
  const result = await table.consult(asker, justify(id, "Contrary"), {});
  const conflict = (result.conflicts as JsonObject[])[0]!;
  assert.equal(result.mode, "reply"); assert.equal(conflict.deleted, true);
  assert.equal((conflict.entry as JsonObject).status, "revoked");
  assert.match(String(result.next), /further justification or rebuttal/);
});

test("open dialogue preserves clarifications, full rejected arguments and ruling context for rebuttal", async () => {
  const { table, path } = await fixture(); const id = await lookup(table);
  await table.consult(asker, { mode: "reply", conversationId: id, action: "clarify", message: "CLARIFICATION_MARKER" }, {});
  const seen: FactVerificationRequest[] = [];
  table.attachVerifier(async request => {
    seen.push(request);
    return { taskId: "unverified", verdict: ruling(request, { case: "unverified", explanation: "SUPREME_RULING_MARKER", evidence: "RULING_EVIDENCE_MARKER" }) };
  });
  await table.consult(asker, { ...justify(id), evidence: "EVIDENCE_MARKER", message: "MESSAGE_MARKER", purpose: "PURPOSE_MARKER", step: 2 }, {});
  for (const marker of ["CLARIFICATION_MARKER", "MESSAGE_MARKER", "PURPOSE_MARKER", "EVIDENCE_MARKER"]) assert(JSON.stringify(seen[0]!.bindings.request).includes(marker));
  const openThread = await readFile(join(dirname(path), "fact-dialogues", `${id}.json`), "utf8");
  assert(openThread.includes("EVIDENCE_MARKER")); assert(openThread.includes("RULING_EVIDENCE_MARKER"));
  await table.consult(asker, { ...justify(id), evidence: "REFINED_ARGUMENT" }, {});
  assert(JSON.stringify(seen[1]!.bindings.request).includes("EVIDENCE_MARKER"));
  assert(JSON.stringify(seen[1]!.bindings.request).includes("SUPREME_RULING_MARKER"));
  const ledger = await readFile(path, "utf8");
  assert(!ledger.includes("CLARIFICATION_MARKER")); assert(!ledger.includes("MESSAGE_MARKER")); assert(!ledger.includes('"messages"'));
  await table.consult(asker, { mode: "reply", conversationId: id, action: "close" }, {});
  await assert.rejects(readFile(join(dirname(path), "fact-dialogues", `${id}.json`)), /ENOENT/);
});

test("a surviving incumbent first offered by a rejection can be selected as a badge", async () => {
  const { table } = await fixture(); const old = await issue(table);
  let empty = true;
  table.attachConsultant(async request => empty ? { taskId: "empty", result: { answer: "No relevant incumbent found initially.", matches: [] } } : matching(request));
  const id = await lookup(table, "Alternative claim"); empty = false;
  table.attachVerifier(async request => ({ taskId: "upheld", verdict: ruling(request, { case: "conflict", conflicts: [{ id: old.id, resolution: "incumbent-stands", explanation: "The original evidence remains applicable." }] }) }));
  await table.consult(asker, justify(id, "Alternative claim"), {});
  const result = await table.consult(asker, { mode: "reply", conversationId: id, action: "badge", factId: old.id, badgeHash: factBadgeHash(old) }, {});
  assert.equal((result.badge as JsonObject).id, old.id);
});

test("a failed reply does not poison a concurrently queued recovery reply", async () => {
  const { table } = await fixture(); const id = await lookup(table);
  const failed = table.consult(asker, { mode: "reply", conversationId: id, action: "clarify" }, {});
  const recovered = table.consult(asker, { mode: "reply", conversationId: id, action: "clarify", message: "Complete clarification" }, {});
  await assert.rejects(failed, /needs a message/);
  assert.equal((await recovered).state, "open");
});

test("closing a rejected nonmutating exchange leaves accounting but no rejected argument archive", async () => {
  const { table, path } = await fixture();
  const claim = "UNACCEPTED_CLAIM_MARKER", evidence = "UNACCEPTED_EVIDENCE_MARKER";
  const id = await lookup(table, claim);
  table.attachVerifier(async request => ({ taskId: "rejected-verifier", usage: { inputTokens: 10, outputTokens: 5 },
    verdict: ruling(request, { case: "unverified", method: "none", evidence: "UNACCEPTED_CHECK_MARKER", explanation: "UNACCEPTED_RULING_MARKER" }) }));
  const answer = await table.consult(asker, { ...justify(id, claim), evidence }, {});
  assert.equal(answer.state, "open"); assert.equal(answer.submission, "S:1");
  const thread = join(dirname(path), "fact-dialogues", `${id}.json`);
  const open = await readFile(thread, "utf8");
  for (const marker of [claim, evidence, "UNACCEPTED_CHECK_MARKER", "UNACCEPTED_RULING_MARKER"]) assert(open.includes(marker));
  await table.consult(asker, { mode: "reply", conversationId: id, action: "close" }, {});
  await assert.rejects(readFile(thread), /ENOENT/);
  const journal = await readFile(path, "utf8");
  for (const marker of [claim, evidence, "UNACCEPTED_CHECK_MARKER", "UNACCEPTED_RULING_MARKER"]) assert(!journal.includes(marker));
  const records = journal.trim().split("\n").flatMap(line => JSON.parse(line).records);
  assert(!records.some(record => record.type === "submission"));
  const usage = records.find(record => record.type === "verification-usage");
  assert.equal(usage.requesterTaskId, asker.taskId); assert.equal(usage.verifierTaskId, "rejected-verifier");
  assert.deepEqual(usage.usage, { inputTokens: 10, outputTokens: 5 });
  const resumed = (await fixture(path)).table;
  const next = await lookup(resumed, "Accepted later claim");
  assert.equal((await resumed.consult(asker, justify(next, "Accepted later claim"), {})).submission, "S:2");
});
