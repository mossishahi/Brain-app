import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryArtifactStore, type AgentExecutionContext, type AgentExecutor, type AgentResult, type AgentTask,
  type DocumentCoverage, type DocumentReceipt, type JsonObject, type JsonValue, type WebAccess,
} from "@brainstorm-agentic/core";
import type { LiteratureReviewV1 } from "@brainstorm-agentic/content";
import { LiteratureReviewAgentExecutor, LiteratureReviewStore, type ReviewEnvelope } from "../src/literature-reviews.js";
import { FsArtifactStore } from "../src/fs-stores.js";

const SOURCE = "https://example.org/source.pdf";
const SHA = "a".repeat(64);
const REPRESENTATION = "b".repeat(64);
const context: AgentExecutionContext = { runId: "research-run", nodePath: "root/first-pass/member-1" };
const originalInput = { question: "Preserve all geometrical directions.", requestedOutputs: [{ title: "Review", ask: "Assess the closest existing approaches." }] };

function task(mode: "required" | "conditional" = "required", overrides: Partial<AgentTask> = {}): AgentTask {
  return { taskId: "research-run/member-1", kind: "brainstorm.brain", agentId: "member-1", skills: ["brain", "literature-review"],
    input: {}, metadata: { literatureReview: { mode, input: originalInput } }, ...overrides };
}

function receipt(overrides: Partial<DocumentReceipt> = {}): DocumentReceipt {
  return { receiptId: "receipt-1", documentId: `doc-${SHA}`, sha256: SHA, representationHash: REPRESENTATION,
    taskId: task().taskId, agentId: "member-1", nodePath: context.nodePath, at: "2026-11-14T00:00:00Z",
    source: SOURCE, finalUrl: SOURCE, segmentCount: 1, operation: "read", access: "retrieved", extraction: "text",
    segmentIds: ["page-2-paragraph-1"], locators: [{ segmentId: "page-2-paragraph-1", page: 2, pageLabel: "ii", heading: "Verified methods", start: 0, end: 40 }],
    deliveredHash: "c".repeat(64), ...overrides };
}

function webFixture(receipts: readonly DocumentReceipt[] = [receipt()], document: Partial<DocumentCoverage["document"]> = {}) {
  let fullyDelivered = false;
  const coverage: DocumentCoverage = {
    document: { documentId: `doc-${SHA}`, sha256: SHA, representationHash: REPRESENTATION, source: SOURCE, finalUrl: SOURCE,
      contentType: "application/pdf", fetchedAt: "2026-11-14T00:00:00Z", access: "retrieved", extraction: "text", warnings: [], segmentCount: 1, outline: [], ...document },
    fullyDelivered: false, deliveredSegmentIds: ["page-2-paragraph-1"],
  };
  const web: WebAccess = {
    search: async () => { throw new Error("Test must not perform external searches."); },
    fetch: async () => { throw new Error("Test must not fetch external sources."); },
    backedKinds: () => [],
    // Deliberately return all receipts: store-side ownership must still be checked.
    documentReceipts: async () => receipts,
    documentCoverage: async () => ({ ...coverage, fullyDelivered }),
  };
  return { web, setFullyDelivered: (value: boolean) => { fullyDelivered = value; } };
}

function review(envelope: ReviewEnvelope): LiteratureReviewV1 {
  return {
    schemaVersion: "literature-review/v1",
    scope: { question: "Which inspected methods address the original input?", inputRequirements: structuredClone([...envelope.inputRequirements]), vantage: "The author's own geometric learning expertise." },
    search: { queries: [{ query: "geometric representation directions", source: "scholarly source", evidenceRefIds: [] }], coverage: "A targeted source assessment.", limitations: [] },
    works: [{ id: "paper-1", source: { title: "An inspected paper", authors: ["A. Researcher"], year: 2024, venue: null, url: SOURCE, doi: null, version: SHA },
      inspected: { level: "sections", evidence: [{ documentId: `doc-${SHA}`, receiptId: "receipt-1", segmentId: "page-2-paragraph-1", locator: "Page 2, Verified methods" }], accessLimitations: [] },
      method: "Tests whether a new coordinate repeats existing directions.", results: "The inspected source reports a controlled comparison.",
      conditions: ["The inspected benchmark uses the stated sampling conditions."], limitations: ["Generalization remains unestablished."],
      relevance: [{ requirementId: "input", relationship: "partially-addresses", justification: "The comparison targets direction loss in the original input; its conditions do not cover every requested setting." }],
      intendedUse: ["Baseline under matching construction and sampling."], uncertainties: [],
    }],
    synthesis: { closestWorkIds: ["paper-1"], assessment: "partially-solved", findings: "A direct comparison is available under scoped conditions.", gaps: ["Generalization needs further evidence."], comparisons: ["Use the same input and evaluation metric."] },
    status: "complete", statusReason: "This scoped review records the inspected evidence and its limits.",
  };
}

function body(value: LiteratureReviewV1): JsonObject { return value as unknown as JsonObject; }
function unavailable(envelope: ReviewEnvelope): JsonObject {
  const value = review(envelope);
  value.works = [];
  value.search.queries = [];
  value.search.limitations = ["The source service was unavailable."];
  value.synthesis = { closestWorkIds: [], assessment: "undetermined", findings: "The available evidence cannot establish the state of the literature.", gaps: ["Inspect the missing sources."], comparisons: [] };
  value.status = "incomplete";
  value.statusReason = "Full-text access was unavailable; no unsupported source claims are made.";
  return body(value);
}

test("review begin/save are idempotent and work patches upsert by stable identity", async () => {
  const artifacts = new InMemoryArtifactStore();
  const store = new LiteratureReviewStore(artifacts);
  const [a, b] = await Promise.all([store.begin(task(), context), store.begin(task(), context)]);
  assert.equal(a.reviewId, b.reviewId);
  assert.equal((await artifacts.list()).length, 1);
  const first = body(review(a));
  const saved = await store.update(task(), context, a.reviewId, first, false);
  const replayed = await store.update(task(), context, a.reviewId, first, false);
  assert.equal(saved.revision, replayed.revision);
  assert.equal((await artifacts.list()).length, 2);
  const second = { ...review(a).works[0]!, id: "paper-2", method: "An independent comparison method." };
  const added = await store.update(task(), context, a.reviewId, { works: [second as unknown as JsonValue] }, false);
  assert.equal((added.review.works as JsonValue[]).length, 2);
  const replacement = { ...review(a).works[0]!, method: "Corrected interpretation of the inspected method." };
  const corrected = await store.update(task(), context, a.reviewId, { works: [replacement as unknown as JsonValue] }, false);
  assert.deepEqual((corrected.review.works as JsonObject[]).map((entry) => entry.id), ["paper-1", "paper-2"]);
  assert.equal((corrected.review.works as JsonObject[])[0]!.method, replacement.method);
  assert.equal((corrected.review.works as JsonObject[])[1]!.method, second.method);
});

test("review ownership prevents cross-task, cross-agent and cross-run reads or writes", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore());
  const owned = await store.begin(task(), context);
  for (const [otherTask, otherContext] of [
    [task("required", { taskId: "another-task" }), context],
    [task("required", { agentId: "member-2" }), context],
    [task(), { ...context, runId: "another-run" }],
  ] as const) {
    assert.deepEqual(await store.latest(otherTask, otherContext), []);
    await assert.rejects(store.update(otherTask, otherContext, owned.reviewId, {}, false), /not found for this agent task/);
    const response = await store.tool(otherTask, otherContext).execute({ action: "read", reviewId: owned.reviewId }, { runId: otherContext.runId });
    assert.equal(response.isError, true);
  }
});

test("input requirements are host-owned and a submitted review cannot rewrite the original ask", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore(), webFixture().web);
  const envelope = await store.begin(task(), context);
  assert.equal(envelope.inputRequirements[0]!.text, JSON.stringify(originalInput));
  const candidate = review(envelope);
  candidate.scope.inputRequirements[0]!.text = "Solve the author's preferred easier problem.";
  const draft = await store.update(task(), context, envelope.reviewId, body(candidate), false);
  assert.deepEqual(draft.inputRequirements, envelope.inputRequirements, "a draft patch cannot change trusted host requirements");
  await assert.rejects(store.update(task(), context, envelope.reviewId, undefined, true), /inputRequirements must exactly match/);
  assert.equal((await store.latest(task(), context))[0]!.state, "draft");
});

test("submission validates the structured schema without deleting the last useful draft", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore(), webFixture().web);
  const envelope = await store.begin(task(), context);
  const candidate = review(envelope); candidate.works[0]!.relevance = [];
  await store.update(task(), context, envelope.reviewId, body(candidate), false);
  const result = await store.tool(task(), context).execute({ action: "submit", reviewId: envelope.reviewId }, { runId: context.runId });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.output), /relevance/);
  assert.equal((await store.latest(task(), context))[0]!.state, "draft");
  const submitted = await store.update(task(), context, envelope.reviewId, body(review(envelope)), true);
  assert.equal(submitted.state, "submitted");
  const replayed = await store.update(task(), context, envelope.reviewId, undefined, true);
  assert.equal(replayed.revision, submitted.revision);
});

test("receipt validation rejects invented delivery, wrong source revision and another agent's evidence", async () => {
  for (const variation of ["receipt", "segment", "document", "version", "agent", "task"] as const) {
    const delivered = receipt(variation === "agent" ? { agentId: "member-2" } : variation === "task" ? { taskId: "another-task" } : {});
    const store = new LiteratureReviewStore(new InMemoryArtifactStore(), webFixture([delivered]).web);
    const envelope = await store.begin(task(), context);
    const candidate = review(envelope);
    const evidence = candidate.works[0]!.inspected.evidence[0]!;
    if (variation === "receipt") evidence.receiptId = "invented-receipt";
    if (variation === "segment") evidence.segmentId = "unread-segment";
    if (variation === "document") evidence.documentId = "another-document";
    if (variation === "version") candidate.works[0]!.source.version = "wrong-source-version";
    await assert.rejects(store.update(task(), context, envelope.reviewId, body(candidate), true), /not delivered|source.version/, variation);
  }
  const generic = new LiteratureReviewStore(new InMemoryArtifactStore(), webFixture([receipt({ agentId: task().taskId })]).web);
  const envelope = await generic.begin(task(), context);
  assert.equal((await generic.update(task(), context, envelope.reviewId, body(review(envelope)), true)).state, "submitted",
    "generic executor receipts use exact task identity as their agent attribution");
});

test("source identity cannot be reassigned and locators are derived from the delivered passage", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore(), webFixture().web);
  const envelope = await store.begin(task(), context);
  const wrongSource = review(envelope); wrongSource.works[0]!.source.url = "https://example.org/unread-paper.pdf";
  await assert.rejects(store.update(task(), context, envelope.reviewId, body(wrongSource), true), /source|URL|url/);
  const forgedLabel = review(envelope); forgedLabel.works[0]!.inspected.evidence[0]!.locator = "Invented page 999 and theorem 42";
  const submitted = await store.update(task(), context, envelope.reviewId, body(forgedLabel), true);
  const accepted = submitted.review as unknown as LiteratureReviewV1;
  const locator = accepted.works[0]!.inspected.evidence[0]!.locator;
  assert.ok(!locator.includes("Invented") && !locator.includes("999"));
  assert.match(locator, /2|Verified methods/);
});

test("full-text claims require complete task-specific coverage rather than one inspected excerpt", async () => {
  const fixture = webFixture();
  const store = new LiteratureReviewStore(new InMemoryArtifactStore(), fixture.web);
  const envelope = await store.begin(task(), context);
  const candidate = review(envelope); candidate.works[0]!.inspected.level = "full-text";
  await assert.rejects(store.update(task(), context, envelope.reviewId, body(candidate), true), /full-text requires/);
  fixture.setFullyDelivered(true);
  assert.equal((await store.update(task(), context, envelope.reviewId, body(candidate), true)).state, "submitted");
});

test("complete delivery of a known abstract or landing page cannot be claimed as full-text paper access", async () => {
  const source = "https://example.org/abstract/paper-1";
  const fixture = webFixture([receipt({ source, finalUrl: source })], {
    source, finalUrl: source, contentType: "text/html", contentScope: "abstract-or-landing",
    warnings: ["The retrieved page contains an abstract or landing-page record, not the complete paper."],
  });
  fixture.setFullyDelivered(true);
  const store = new LiteratureReviewStore(new InMemoryArtifactStore(), fixture.web);
  const envelope = await store.begin(task(), context);
  const candidate = review(envelope);
  candidate.works[0]!.source.url = source;
  candidate.works[0]!.inspected.level = "full-text";
  await assert.rejects(store.update(task(), context, envelope.reviewId, body(candidate), true), /abstract\/landing page/);
  assert.equal((await store.latest(task(), context))[0]!.state, "draft");
  candidate.works[0]!.inspected.level = "abstract";
  candidate.works[0]!.inspected.accessLimitations = ["Only the abstract was available; methods and results need full-paper verification."];
  assert.equal((await store.update(task(), context, envelope.reviewId, body(candidate), true)).state, "submitted");
});

test("host extraction warnings survive submission even when the author omits or duplicates them", async () => {
  const warnings = ["Mathematical notation may be incomplete in the text extraction.", "One figure requires page-image inspection."];
  const fixture = webFixture([receipt()], { warnings });
  const store = new LiteratureReviewStore(new InMemoryArtifactStore(), fixture.web);
  const envelope = await store.begin(task(), context);
  const candidate = review(envelope);
  candidate.works[0]!.inspected.accessLimitations = ["Only selected sections were assessed.", warnings[0]!];
  const submitted = await store.update(task(), context, envelope.reviewId, body(candidate), true);
  const accepted = submitted.review as unknown as LiteratureReviewV1;
  assert.deepEqual(accepted.works[0]!.inspected.accessLimitations, ["Only selected sections were assessed.", ...warnings]);
  const replayed = await store.update(task(), context, envelope.reviewId, undefined, true);
  assert.equal(replayed.revision, submitted.revision, "rechecking host warnings does not duplicate limits or invent revisions");
});

test("a new worker instance restores the saved review instead of repeating completed work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "literature-review-resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new LiteratureReviewStore(new FsArtifactStore(root, context.runId), webFixture().web);
  const started = await first.begin(task(), context);
  const saved = await first.update(task(), context, started.reviewId, body(review(started)), false);
  const resumed = new LiteratureReviewStore(new FsArtifactStore(root, context.runId), webFixture().web);
  const same = await resumed.begin(task(), context);
  assert.equal(same.reviewId, started.reviewId);
  assert.equal(same.revision, saved.revision);
  assert.deepEqual(same.review.works, saved.review.works);
  assert.match(await resumed.restore(task(), context), /An inspected paper/);
  assert.equal((await resumed.update(task(), context, same.reviewId, undefined, true)).state, "submitted");
  assert.deepEqual(await resumed.validate(task(), context), []);
});

test("reusing a task ID with revised input cannot inherit another input revision's review", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore());
  const old = await store.begin(task(), context);
  await store.update(task(), context, old.reviewId, unavailable(old), true);
  const revised = task("required", { metadata: { literatureReview: { mode: "required", input: { question: "A genuinely different input." } } } });
  assert.deepEqual(await store.latest(revised, context), []);
  assert.ok((await store.validate(revised, context)).length > 0);
  const next = await store.begin(revised, context);
  assert.notEqual(next.reviewId, old.reviewId);
  assert.notEqual(next.inputRevision, old.inputRevision);
});

test("required reviews and begun conditional reviews block completion, honest incomplete results do not", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore());
  assert.ok((await store.validate(task(), context)).length > 0);
  assert.deepEqual(await store.validate(task("conditional"), context), []);
  const started = await store.begin(task("conditional"), context);
  assert.ok((await store.validate(task("conditional"), context)).length > 0);
  await store.update(task("conditional"), context, started.reviewId, unavailable(started), true);
  assert.deepEqual(await store.validate(task(), context), []);
  const second = await store.begin(task(), context, "follow-up-comparison");
  assert.ok((await store.validate(task(), context)).some((message) => message.includes(second.reviewId)), "every begun review must close explicitly");
});

test("executor wrapper leaves legacy tasks untouched and injects review lifecycle into required tasks", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore());
  let checked = false;
  const inner: AgentExecutor = { execute: async (active, execution): Promise<AgentResult> => {
    if (active.taskId === "legacy") {
      assert.equal(execution, context);
      return { taskId: active.taskId, status: "ok", output: "unchanged", metadata: { legacy: true } };
    }
    checked = true;
    assert.equal((await store.latest(active, context)).length, 1, "mandatory draft exists before the model executes");
    assert.ok(execution.deliverableTools?.some((tool) => tool.definition.name === "literature_review"));
    assert.ok((await execution.beforeArgumentStep!()).length > 0);
    assert.ok((await execution.validateDeliverables!()).length > 0);
    assert.match(await execution.restoreDeliverables!(), /saved progress/);
    const draft = (await store.latest(active, context))[0]!;
    await store.update(active, context, draft.reviewId, unavailable(draft), true);
    assert.deepEqual(await execution.beforeArgumentStep!(), []);
    return { taskId: active.taskId, status: "ok", output: { final: "An honestly limited result." }, metadata: { original: true } };
  } };
  const executor = new LiteratureReviewAgentExecutor(inner, store);
  const legacy = await executor.execute({ taskId: "legacy", kind: "legacy", input: {} }, context);
  assert.deepEqual(legacy, { taskId: "legacy", status: "ok", output: "unchanged", metadata: { legacy: true } });
  const result = await executor.execute(task(), context);
  assert.ok(checked);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.metadata?.original, true);
    assert.deepEqual(result.metadata?.literatureReviewIds, (await store.latest(task(), context)).map((entry) => entry.reviewId));
    assert.deepEqual(result.output, { final: "An honestly limited result." });
  }
});

test("wrapper postcondition catches an executor bypass and permits conditional no-review tasks", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore());
  const executor = new LiteratureReviewAgentExecutor({ execute: async (active) => ({ taskId: active.taskId, status: "ok", output: "Unconditionally finished." }) }, store);
  const required = await executor.execute(task(), context);
  assert.equal(required.status, "error");
  if (required.status === "error") assert.equal(required.error.name, "LiteratureReviewIncomplete");
  const conditional = await executor.execute(task("conditional", { taskId: "no-source-check" }), context);
  assert.equal(conditional.status, "ok");
  if (conditional.status === "ok") assert.deepEqual(conditional.metadata?.literatureReviewIds, []);
});

test("source tools automatically open conditional reviews, compose existing hooks, and preserve retry identity", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore());
  const calls: string[] = [];
  const inner: AgentExecutor = { execute: async (active, execution) => {
    assert.deepEqual(await store.latest(active, context), []);
    await execution.beforeToolUse!("code_execute");
    assert.deepEqual(await store.latest(active, context), [], "unrelated computations do not require a literature survey");
    await execution.beforeToolUse!("mcp__brainstorm_local__paper_search");
    const first = (await store.latest(active, context))[0]!;
    assert.equal(first.state, "draft");
    await execution.beforeToolUse!("paper_read");
    const repeated = await store.latest(active, context);
    assert.equal(repeated.length, 1);
    assert.equal(repeated[0]!.reviewId, first.reviewId, "source calls continue the current review");
    assert.equal(repeated[0]!.revision, first.revision, "source calls do not create empty revisions while a draft is active");
    assert.ok((await execution.beforeArgumentStep!()).length > 0);
    await store.update(active, context, first.reviewId, unavailable(first), true);
    return { taskId: active.taskId, status: "ok", output: "The source check is recorded with its limitation." };
  } };
  const result = await new LiteratureReviewAgentExecutor(inner, store).execute(task("conditional"), {
    ...context, beforeToolUse: async (name) => { calls.push(name); },
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(calls, ["code_execute", "mcp__brainstorm_local__paper_search", "paper_read"]);
});

test("new source activity after submission must be incorporated before a task can finish", async () => {
  const store = new LiteratureReviewStore(new InMemoryArtifactStore());
  const inner: AgentExecutor = { execute: async (active, execution) => {
    await execution.beforeToolUse!("paper_read");
    const first = (await store.latest(active, context))[0]!;
    await store.update(active, context, first.reviewId, unavailable(first), true);
    assert.deepEqual(await execution.validateDeliverables!(), []);
    await execution.beforeToolUse!("web_fetch");
    const pending = (await store.latest(active, context)).filter((record) => record.state === "draft");
    assert.equal(pending.length, 1, "a previously submitted review does not cover new source activity automatically");
    assert.equal(pending[0]!.reviewId, first.reviewId, "follow-up source use resumes the author's existing review");
    assert.ok((await execution.validateDeliverables!()).length > 0);
    await store.update(active, context, pending[0]!.reviewId, unavailable(pending[0]!), true);
    return { taskId: active.taskId, status: "ok", output: "Follow-up source assessment recorded." };
  } };
  assert.equal((await new LiteratureReviewAgentExecutor(inner, store).execute(task("conditional"), context)).status, "ok");
});

test("source use continues a named review and reopens the most recently submitted review without creating a default", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => ++now);
  const store = new LiteratureReviewStore(new InMemoryArtifactStore());
  const inner: AgentExecutor = { execute: async (active, execution) => {
    const named = await store.begin(active, context, "counterexample");
    await execution.beforeToolUse!("paper_read");
    const activeDrafts = await store.latest(active, context);
    assert.equal(activeDrafts.length, 1, "source use must not open a second default review beside an explicitly named review");
    assert.equal(activeDrafts[0]!.reviewId, named.reviewId);
    assert.equal(activeDrafts[0]!.revision, named.revision);
    await store.update(active, context, named.reviewId, unavailable(named), true);
    const newer = await store.begin(active, context, "baseline-comparison");
    await store.update(active, context, newer.reviewId, unavailable(newer), true);
    await execution.beforeToolUse!("web_search");
    const records = await store.latest(active, context);
    assert.equal(records.length, 2, "a source call reopens an authored review instead of creating an unrelated default");
    assert.equal(records.find((entry) => entry.reviewId === named.reviewId)!.state, "submitted");
    assert.equal(records.find((entry) => entry.reviewId === newer.reviewId)!.state, "draft", "the most recently updated submitted review receives the new source activity");
    assert.ok((await execution.validateDeliverables!()).length > 0);
    await store.update(active, context, newer.reviewId, undefined, true);
    return { taskId: active.taskId, status: "ok", output: "Both scoped source checks are recorded." };
  } };
  const result = await new LiteratureReviewAgentExecutor(inner, store).execute(task("conditional"), context);
  assert.equal(result.status, "ok");
});
