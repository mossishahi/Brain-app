import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  FactScopeRegistry,
  factBadgeHash,
  factReportHash,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type FactAccess,
  type FactCase,
  type FactEntry,
  type FactRequester,
  type FactSubmission,
  type FactSubmitContext,
  type FactTableLimits,
  type FactVerdict,
  type JsonObject,
} from "@brainstorm-agentic/core";

import { formatFactOutcome, runFactTable } from "@brainstorm-agentic/host-tools";

import { FileFactTable, type FactVerificationRequest, type FactVerifier } from "../src/fact-table.js";
import { buildAgentExecutor, FactScopeAgentExecutor } from "../src/wiring.js";

const LIMITS: FactTableLimits = {
  submissionsPerTask: 6,
  relatedFacts: 8,
  lookupResults: 5,
  verificationMinutes: 30,
};

/** A log in a run directory that does not exist yet: the first write creates both. */
function freshLog(): string {
  return join(mkdtempSync(join(tmpdir(), "fact-table-")), "run-1", "facts.jsonl");
}

/** A clock that ticks on every reading, so no two stamps are equal. */
function ticking(): () => number {
  let now = 1_000;
  return () => (now += 1);
}

function factTable(path = freshLog(), limits: FactTableLimits = LIMITS): FileFactTable {
  return new FileFactTable({ logPath: path, limits, now: ticking() });
}

const asker = (taskId: string, agent = "commentor-1"): FactRequester => ({
  taskId,
  role: "commentor",
  agent,
  seat: "member-1",
  step: 2,
});

const fact = (claim: string, conditions = "none", kind: FactSubmission["kind"] = "result"): FactSubmission => ({
  claim,
  conditions,
  evidence: `Ran the script; it printed: ${claim}`,
  kind,
});

type Ruling = Partial<FactVerdict> & { readonly case: FactCase };

/** A complete verdict on the submitted claim, as the supreme judge gives one. */
function verdictOn(request: FactVerificationRequest, ruling: Ruling): FactVerdict {
  return {
    claim: String(request.bindings.request.claim),
    conditions: String(request.bindings.request.conditions),
    method: "re-executed",
    evidence: "Re-ran the script: it printed the same value.",
    explanation: `Ruled ${ruling.case}.`,
    conflicts: [],
    integrity: "honest",
    ...ruling,
  };
}

/** A supreme judge that rules by script and keeps every request it was shown. */
function judge(rule: (request: FactVerificationRequest) => Ruling): FactVerifier & {
  readonly seen: FactVerificationRequest[];
} {
  const seen: FactVerificationRequest[] = [];
  const verifier: FactVerifier = async (request) => {
    seen.push(request);
    return {
      verdict: verdictOn(request, rule(request)),
      taskId: `fact-verification:${request.submission}`,
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  };
  return Object.assign(verifier, { seen });
}

interface Held {
  readonly request: FactVerificationRequest;
  rule(ruling: Ruling): void;
}

/** A supreme judge whose verifications stay open until the test rules on each. */
function heldJudge(): { readonly verifier: FactVerifier; readonly held: Held[] } {
  const held: Held[] = [];
  const verifier: FactVerifier = (request) =>
    new Promise((resolve) => {
      held.push({
        request,
        rule: (ruling) =>
          resolve({ verdict: verdictOn(request, ruling), taskId: `fact-verification:${request.submission}` }),
      });
    });
  return { verifier, held };
}

const relatedIds = (request: FactVerificationRequest): unknown[] =>
  (request.bindings.related as JsonObject[]).map((view) => view.id);

interface LogLine {
  readonly type: string;
  readonly id?: string;
  readonly entry?: FactEntry;
  readonly [field: string]: unknown;
}

function logLines(path: string): LogLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LogLine);
}

const lineIds = (lines: readonly LogLine[]): unknown[] =>
  lines.map((line) => (line.type === "entry" ? line.entry?.id : line.id));

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 5_000 && !condition(); waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), "the condition never held");
}

test("rulings persist as entry snapshots and submission lines, and a resume continues the ids", async () => {
  const path = freshLog();
  const first = factTable(path);
  first.attachVerifier(
    judge((request) =>
      request.bindings.request.claim === "The loss diverges at learning rate 1.0"
        ? { case: "refuted", evidence: "The script printed a finite loss." }
        : { case: "justified-new" },
    ),
  );
  const issued = await first.submit(asker("t1"), fact("The validation accuracy is 0.42", "seed 7"), {});
  assert.equal(issued.submission, "S:1");
  assert.equal(issued.case, "justified-new");
  assert.equal(issued.badge?.id, "F:1");
  const refuted = await first.submit(asker("t1"), fact("The loss diverges at learning rate 1.0", "dataset cifar10"), {});
  assert.equal(refuted.recorded?.id, "F:2");
  assert.equal(refuted.recorded?.status, "refuted");

  const lines = logLines(path);
  assert.deepEqual(lineIds(lines), ["F:1", "S:1", "F:2", "S:2"]);
  assert.deepEqual(
    lines.map((line) => line.type),
    ["entry", "submission", "entry", "submission"],
  );
  assert.deepEqual(lines[1]!.requester, asker("t1"));
  assert.deepEqual(lines[1]!.submission, fact("The validation accuracy is 0.42", "seed 7"));
  assert.equal(lines[1]!.case, "justified-new");
  assert.equal(lines[1]!.badge, "F:1");
  assert.deepEqual(lines[1]!.conflicts, []);
  assert.equal((lines[1]!.verdict as FactVerdict).case, "justified-new");
  assert.equal(lines[1]!.verifierTaskId, "fact-verification:S:1");
  assert.deepEqual(lines[1]!.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(lines[3]!.recorded, "F:2");
  assert.equal(lines[3]!.badge, undefined);

  const resumed = factTable(path);
  assert.deepEqual(await resumed.entries(), await first.entries());
  resumed.attachVerifier(judge(() => ({ case: "justified-new" })));
  const next = await resumed.submit(asker("t1"), fact("The test split holds 1,200 images", "dataset cifar10"), {});
  assert.equal(next.submission, "S:3");
  assert.equal(next.badge?.id, "F:3");
});

test("a partial last line is ignored on load, and the next write starts a fresh line", async () => {
  const path = freshLog();
  const seeded = factTable(path);
  seeded.attachVerifier(judge(() => ({ case: "justified-new" })));
  await seeded.submit(asker("t1"), fact("The encoder has 12 layers", "code version abc123"), {});
  // A crash in the middle of the next append:
  appendFileSync(path, '{"type":"entry","at":5,"entry":{"id":"F:2","status":"justi');

  const resumed = factTable(path);
  assert.deepEqual((await resumed.entries()).map((entry) => entry.id), ["F:1"]);
  resumed.attachVerifier(judge(() => ({ case: "justified-new" })));
  const next = await resumed.submit(asker("t2"), fact("The decoder has 6 layers", "code version abc123"), {});
  assert.equal(next.submission, "S:2");
  assert.equal(next.badge?.id, "F:2");

  const again = factTable(path);
  assert.deepEqual(
    (await again.entries()).map((entry) => [entry.id, entry.claim]),
    [
      ["F:1", "The encoder has 12 layers"],
      ["F:2", "The decoder has 6 layers"],
    ],
  );
});

test("an exact duplicate of a justified entry is answered from the table, without the supreme judge", async () => {
  const table = factTable();
  const verifier = judge(() => ({ case: "justified-new" }));
  table.attachVerifier(verifier);
  await table.submit(asker("t1"), fact("The dataset holds 1,200 images.", "split train"), {});
  const duplicate = await table.submit(
    asker("t2", "commentor-2"),
    fact("  the dataset  holds 1,200 images", "Split train."),
    {},
  );
  assert.equal(duplicate.case, "justified");
  assert.equal(duplicate.badge?.id, "F:1");
  assert.equal(duplicate.verdict, undefined);
  assert.equal(duplicate.refusal, undefined);
  assert.equal(verifier.seen.length, 1, "no second verification");
  const [entry] = await table.entries();
  assert.deepEqual(
    entry!.history.map((event) => [event.event, event.by]),
    [
      ["issued", "S:1"],
      ["relied", "S:2"],
    ],
  );
  assert.deepEqual(entry!.requesters.map((requester) => requester.taskId), ["t1", "t2"]);
  // Other conditions make another fact: that one goes to the supreme judge.
  await table.submit(asker("t3"), fact("The dataset holds 1,200 images", "split test"), {});
  assert.equal(verifier.seen.length, 2);
});

test("justified: the supreme judge names the covering entry, which gains the reliance and the requester", async () => {
  const table = factTable();
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  await table.submit(asker("t1"), fact("The model has 7 billion parameters", "checkpoint v2"), {});
  table.attachVerifier(judge(() => ({ case: "justified", existing: "F:1", explanation: "F:1 states it." })));
  const outcome = await table.submit(
    asker("t2", "commentor-2"),
    fact("The model has 7B parameters", "checkpoint v2"),
    {},
  );
  assert.equal(outcome.case, "justified");
  assert.equal(outcome.badge?.id, "F:1");
  assert.equal(outcome.verdict?.existing, "F:1");
  const entries = await table.entries();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.history.at(-1), {
    at: entries[0]!.updatedAt,
    event: "relied",
    by: "S:2",
    detail: "F:1 states it.",
  });
  assert.deepEqual(entries[0]!.requesters.map((requester) => requester.agent), ["commentor-1", "commentor-2"]);
});

test("justified-new over a wrong incumbent: the incumbent is revoked and superseded by the new badge", async () => {
  const path = freshLog();
  const table = factTable(path);
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  await table.submit(asker("t1"), fact("The baseline reaches 0.80 accuracy", "dataset cifar10, seed 7"), {});
  table.attachVerifier(
    judge(() => ({
      case: "justified-new",
      conflicts: [{ id: "F:1", resolution: "incumbent-revoked", explanation: "F:1 read the wrong log." }],
    })),
  );
  const outcome = await table.submit(
    asker("t2"),
    fact("The baseline reaches 0.75 accuracy", "dataset cifar10, seed 7"),
    {},
  );
  assert.equal(outcome.case, "justified-new");
  assert.equal(outcome.badge?.id, "F:2");
  assert.deepEqual(
    outcome.conflicts.map((conflict) => [conflict.entry.id, conflict.entry.status, conflict.resolution]),
    [["F:1", "revoked", "incumbent-revoked"]],
  );
  const [incumbent, badge] = await table.entries();
  assert.equal(incumbent!.status, "revoked");
  assert.equal(incumbent!.supersededBy, "F:2");
  assert.deepEqual(incumbent!.history.at(-1), {
    at: incumbent!.updatedAt,
    event: "revoked",
    by: "F:2",
    detail: "F:1 read the wrong log.",
  });
  assert.deepEqual(
    incumbent!.requesters.map((requester) => requester.taskId),
    ["t1"],
    "a ruling against an entry adds no requester to it",
  );
  assert.equal(badge!.status, "justified");
  assert.deepEqual(badge!.history.map((event) => [event.event, event.by]), [["issued", "S:2"]]);
  // The new badge's snapshot is written before the incumbent's that points at it.
  const lines = logLines(path);
  assert.deepEqual(lineIds(lines.slice(-3)), ["F:2", "F:1", "S:2"]);
  assert.deepEqual(lines.at(-1)!.conflicts, [{ id: "F:1", resolution: "incumbent-revoked" }]);
});

test("narrowed: the new badge holds the narrower claim, and the incumbent keeps narrower conditions", async () => {
  const table = factTable();
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  await table.submit(asker("t1"), fact("Training converges within 10 epochs", "none"), {});
  table.attachVerifier(
    judge(() => ({
      case: "narrowed",
      claim: "Training converges within 10 epochs at batch size 64",
      conditions: "batch size 64",
      conflicts: [
        {
          id: "F:1",
          resolution: "both-narrowed",
          conditions: "batch size 256",
          explanation: "F:1 holds at batch size 256 only.",
        },
      ],
    })),
  );
  const outcome = await table.submit(asker("t2"), fact("Training converges within 10 epochs", "batch size 64"), {});
  assert.equal(outcome.case, "narrowed");
  assert.equal(outcome.badge?.id, "F:2");
  assert.equal(outcome.badge?.claim, "Training converges within 10 epochs at batch size 64");
  assert.equal(outcome.badge?.conditions, "batch size 64");
  const [incumbent] = await table.entries();
  assert.equal(incumbent!.status, "justified");
  assert.equal(incumbent!.conditions, "batch size 256");
  assert.deepEqual(
    [incumbent!.history.at(-1)?.event, incumbent!.history.at(-1)?.by],
    ["narrowed", "F:2"],
  );
});

test("conflict: an incumbent that stands is upheld; a disputed one is marked, beside the disputed counter-claim", async () => {
  const table = factTable();
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  await table.submit(asker("t1"), fact("The ablation drops accuracy by 4 points", "dataset imagenet"), {});
  await table.submit(asker("t1"), fact("The pruned model runs 2x faster", "gpu a100"), {});
  table.attachVerifier(
    judge(() => ({
      case: "conflict",
      conflicts: [{ id: "F:1", resolution: "incumbent-stands", explanation: "F:1 was re-run and holds." }],
    })),
  );
  const stands = await table.submit(asker("t2"), fact("The ablation drops accuracy by 1 point", "dataset imagenet"), {});
  assert.equal(stands.case, "conflict");
  assert.equal(stands.badge, undefined);
  assert.equal(stands.recorded, undefined);
  assert.equal(stands.conflicts[0]?.entry.status, "justified");
  assert.deepEqual(
    [stands.conflicts[0]?.entry.history.at(-1)?.event, stands.conflicts[0]?.entry.history.at(-1)?.by],
    ["upheld", "S:3"],
  );
  table.attachVerifier(
    judge(() => ({
      case: "conflict",
      method: "judgement-only",
      conflicts: [{ id: "F:2", resolution: "disputed", explanation: "The two timings cannot be told apart." }],
    })),
  );
  const disputed = await table.submit(asker("t3"), fact("The pruned model runs no faster", "gpu a100"), {});
  assert.equal(disputed.case, "conflict");
  assert.equal(disputed.badge, undefined);
  assert.equal(disputed.recorded?.id, "F:3");
  assert.equal(disputed.recorded?.status, "disputed");
  assert.equal(disputed.recorded?.claim, "The pruned model runs no faster");
  assert.deepEqual(disputed.recorded?.history.map((event) => [event.event, event.by]), [["disputed", "S:4"]]);
  const entries = await table.entries();
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.status]),
    [
      ["F:1", "justified"],
      ["F:2", "disputed"],
      ["F:3", "disputed"],
    ],
  );
  assert.deepEqual(entries[1]!.history.at(-1), {
    at: entries[1]!.updatedAt,
    event: "disputed",
    by: "F:3",
    detail: "The two timings cannot be told apart.",
  });
});

test("refuted is recorded as refuted; an unverified or not-a-fact ruling adds nothing", async () => {
  const table = factTable();
  table.attachVerifier(judge(() => ({ case: "refuted", evidence: "The script printed 0.31." })));
  const refuted = await table.submit(asker("t1"), fact("The recall is 0.90", "split test"), {});
  assert.equal(refuted.case, "refuted");
  assert.equal(refuted.badge, undefined);
  assert.deepEqual(
    [refuted.recorded?.id, refuted.recorded?.status, refuted.recorded?.evidence],
    ["F:1", "refuted", "The script printed 0.31."],
  );
  assert.deepEqual(refuted.recorded?.history.map((event) => [event.event, event.by]), [["refuted", "S:1"]]);
  for (const unbadged of ["unverified", "not-a-fact"] as const) {
    table.attachVerifier(judge(() => ({ case: unbadged, method: "none", evidence: "" })));
    const outcome = await table.submit(asker("t2"), fact(`A claim the judge rules ${unbadged}`, "split test"), {});
    assert.equal(outcome.case, unbadged);
    assert.equal(outcome.verdict?.case, unbadged);
    assert.equal(outcome.refusal, undefined);
    assert.equal(outcome.badge, undefined);
    assert.equal(outcome.recorded, undefined);
  }
  assert.deepEqual((await table.entries()).map((entry) => entry.id), ["F:1"]);
});

test("a task's submissions are capped, and a table without a verifier refuses without a check", async () => {
  const path = freshLog();
  const table = factTable(path, { ...LIMITS, submissionsPerTask: 2 });
  const unattached = await table.submit(asker("t0"), fact("The vocabulary has 32,000 tokens"), {});
  assert.equal(unattached.case, "unverified");
  assert.equal(unattached.refusal, "The fact table's verifier is not available in this run.");
  const verifier = judge(() => ({ case: "not-a-fact", method: "none", evidence: "" }));
  table.attachVerifier(verifier);
  await table.submit(asker("t1"), fact("The vocabulary has 32,000 tokens"), {});
  await table.submit(asker("t1"), fact("The context window is 8,192 tokens"), {});
  const third = await table.submit(asker("t1"), fact("The embedding width is 4,096"), {});
  assert.equal(third.case, "unverified");
  assert.equal(
    third.refusal,
    "This task has used its 2 submissions; rely on lookups, or keep the argument conditional on the unverified premise; do not treat it as established.",
  );
  assert.equal(third.verdict, undefined);
  assert.equal(verifier.seen.length, 2);
  assert.equal((await table.submit(asker("t2"), fact("The embedding width is 4,096"), {})).case, "not-a-fact");
  assert.deepEqual(await table.entries(), []);
  // Refusals are recorded like every other submission.
  assert.deepEqual(
    logLines(path).map((line) => [line.id, line.case, line.refusal !== undefined]),
    [
      ["S:1", "unverified", true],
      ["S:2", "not-a-fact", false],
      ["S:3", "not-a-fact", false],
      ["S:4", "unverified", true],
      ["S:5", "not-a-fact", false],
    ],
  );
});

test("a failed, overrunning or malformed verification leaves the claim unverified; the requester's abort propagates", async () => {
  const table = factTable(freshLog(), { ...LIMITS, verificationMinutes: 0.0005 });
  table.attachVerifier(async () => {
    throw new Error("the executor failed.");
  });
  const failed = await table.submit(asker("t1"), fact("The model has 7B parameters"), {});
  assert.equal(failed.case, "unverified");
  assert.equal(failed.refusal, "The supreme judge could not complete the check: the executor failed.");

  // The ceiling's own timer does not hold the event loop open; this does.
  const hold = setInterval(() => {}, 1_000);
  try {
    table.attachVerifier(() => new Promise<never>(() => {}));
    const overran = await table.submit(asker("t2"), fact("The model has 7B parameters"), {});
    assert.equal(
      overran.refusal,
      "The supreme judge could not complete the check: it did not finish within 0.0005 minutes.",
    );
  } finally {
    clearInterval(hold);
  }

  table.attachVerifier(async (request) => ({
    verdict: { case: "justified-new" } as unknown as FactVerdict,
    taskId: `fact-verification:${request.submission}`,
  }));
  const malformed = await table.submit(asker("t3"), fact("The model has 7B parameters"), {});
  assert.equal(malformed.case, "unverified");
  assert.match(
    malformed.refusal ?? "",
    /^The supreme judge could not complete the check: its verdict failed validation \(.+\)\.$/,
  );

  const controller = new AbortController();
  table.attachVerifier(() => new Promise<never>(() => {}));
  const pending = table.submit(asker("t4"), fact("The model has 7B parameters"), { signal: controller.signal });
  controller.abort(new Error("task cancelled"));
  await assert.rejects(pending, /task cancelled/);
  assert.deepEqual(await table.entries(), []);
});

test("a ruling that names entries the supreme judge was not shown is not committed", async () => {
  const table = factTable();
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  await table.submit(asker("t1"), fact("The learning rate is 0.01", "seed 7"), {});
  // F:1 shares no word with this claim, so the judge was not shown it.
  table.attachVerifier(judge(() => ({ case: "justified", existing: "F:1" })));
  const unseen = await table.submit(asker("t2"), fact("Dropout follows every attention block", "code version abc123"), {});
  assert.equal(unseen.case, "unverified");
  assert.equal(unseen.refusal, "The ruling referenced entries the supreme judge was not shown.");
  assert.equal(unseen.verdict, undefined);
  table.attachVerifier(
    judge(() => ({
      case: "justified-new",
      conflicts: [{ id: "F:9", resolution: "incumbent-revoked", explanation: "F:9 is wrong." }],
    })),
  );
  const phantom = await table.submit(asker("t3"), fact("The learning rate is 0.02", "seed 7"), {});
  assert.equal(phantom.refusal, "The ruling referenced entries the supreme judge was not shown.");
  // Shown but no longer a badge: a revoked entry covers nothing.
  table.attachVerifier(
    judge(() => ({
      case: "justified-new",
      conflicts: [{ id: "F:1", resolution: "incumbent-revoked", explanation: "F:1 misread the config." }],
    })),
  );
  await table.submit(asker("t4"), fact("The learning rate is 0.001", "seed 7"), {});
  table.attachVerifier(judge(() => ({ case: "justified", existing: "F:1" })));
  const revoked = await table.submit(asker("t5"), fact("The learning rate is 0.01", "seed 7"), {});
  assert.equal(revoked.refusal, "The ruling referenced entries the supreme judge was not shown.");
  assert.deepEqual(
    (await table.entries()).map((entry) => [entry.id, entry.status]),
    [
      ["F:1", "revoked"],
      ["F:2", "justified"],
    ],
  );
});

test("two concurrent submissions of one claim: the second is verified once more and ends on the first's badge", async () => {
  const table = factTable();
  const { verifier, held } = heldJudge();
  table.attachVerifier(verifier);
  const claim = fact("The cache hit rate is 93%", "run 4, 10k requests");
  const first = table.submit(asker("t1"), claim, {});
  const second = table.submit(asker("t2", "commentor-2"), claim, {});
  await until(() => held.length === 2);
  assert.deepEqual(held.map(({ request }) => relatedIds(request)), [[], []]);
  held[0]!.rule({ case: "justified-new" });
  assert.equal((await first).badge?.id, "F:1");
  // The second ruling was made against a table without F:1, which now states the same claim.
  held[1]!.rule({ case: "justified-new" });
  await until(() => held.length === 3);
  assert.equal(held[2]!.request.submission, "S:2");
  assert.deepEqual(relatedIds(held[2]!.request), ["F:1"]);
  held[2]!.rule({ case: "justified", existing: "F:1" });
  const outcome = await second;
  assert.equal(outcome.case, "justified");
  assert.equal(outcome.badge?.id, "F:1");
  const entries = await table.entries();
  assert.deepEqual(entries.map((entry) => entry.id), ["F:1"]);
  assert.deepEqual(entries[0]!.requesters.map((requester) => requester.taskId), ["t1", "t2"]);
  assert.equal(held.length, 3, "verified again once, not twice");
});

test("a ruling is not sent back when nothing that ranks against its claim changed meanwhile", async () => {
  const table = factTable();
  const { verifier, held } = heldJudge();
  table.attachVerifier(verifier);
  const tokenizer = table.submit(asker("t1"), fact("The tokenizer splits on whitespace", "code version abc123", "code"), {});
  const latency = table.submit(asker("t2"), fact("Inference latency is 40 ms", "gpu a100, batch 1"), {});
  await until(() => held.length === 2);
  held[0]!.rule({ case: "justified-new" });
  assert.equal((await tokenizer).badge?.id, "F:1");
  held[1]!.rule({ case: "justified-new" });
  assert.equal((await latency).badge?.id, "F:2");
  assert.equal(held.length, 2);
});

test("a log that cannot be written is announced once and never fails a submission", async () => {
  const runDirectory = join(mkdtempSync(join(tmpdir(), "fact-table-")), "run-1");
  mkdirSync(runDirectory, { mode: 0o500 });
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => {
    errors.push(String(message));
  };
  try {
    const table = factTable(join(runDirectory, "facts.jsonl"));
    table.attachVerifier(judge(() => ({ case: "justified-new" })));
    const first = await table.submit(asker("t1"), fact("The batch size is 64"), {});
    const second = await table.submit(asker("t1"), fact("The warmup lasts 500 steps"), {});
    assert.deepEqual([first.badge?.id, second.badge?.id], ["F:1", "F:2"]);
    assert.equal((await table.entries()).length, 2, "the table in memory stays authoritative");
    assert.equal(errors.length, 1, "one announcement, not one per line");
    assert.match(errors[0]!, /fact table could not record/);
  } finally {
    console.error = original;
    chmodSync(runDirectory, 0o700);
  }
});

test("the supreme judge is shown the claim, the task's data and the related entries, never who asked", async () => {
  const table = factTable();
  const verifier = judge(() => ({ case: "justified-new" }));
  table.attachVerifier(verifier);
  await table.submit(
    asker("task-alpha", "commentor-alpha"),
    fact("The parser accepts UTF-16 input", "file src/parse.ts line 40", "code"),
    {},
  );
  const execution = { runId: "run-1", nodePath: "root/review/member[0]/judge-step" };
  await table.submit(
    { taskId: "task-beta", role: "judge", agent: "judge-beta", seat: "member-beta", step: 5 },
    {
      ...fact("The parser rejects UTF-16 input", "file src/parse.ts line 40", "code"),
      step: 5,
      purpose: "Step 5 rests on it.",
    },
    { input: { prompt: "the submission" }, files: [{ path: "src/parse.ts" }], execution },
  );
  const request = verifier.seen[1]!;
  assert.equal(request.submission, "S:2");
  assert.deepEqual(Object.keys(request.bindings.request).sort(), [
    "claim",
    "conditions",
    "evidence",
    "kind",
    "purpose",
    "step",
  ]);
  assert.deepEqual(request.bindings.input, { prompt: "the submission" });
  assert.deepEqual(request.bindings.files, [{ path: "src/parse.ts" }]);
  assert.equal(request.execution, execution);
  assert.deepEqual(relatedIds(request), ["F:1"]);
  const shown = JSON.stringify(request.bindings);
  for (const requester of ["task-alpha", "commentor-alpha", "member-1", "task-beta", "judge-beta", "member-beta"]) {
    assert.equal(shown.includes(requester), false, `${requester} must not reach the supreme judge`);
  }
  assert.equal(shown.includes("requesters"), false);
  assert.deepEqual(verifier.seen[0]!.bindings.input, {}, "absent task data binds empty");
  assert.deepEqual(verifier.seen[0]!.bindings.files, []);
});

test("the fact scope registry holds a task's scope and task data exactly while it runs", async () => {
  const scopes = new FactScopeRegistry();
  let seenDuring: unknown;
  const inner: AgentExecutor = {
    async execute(task: AgentTask): Promise<AgentResult> {
      seenDuring = scopes.get(task.taskId);
      return { taskId: task.taskId, status: "ok", output: {} };
    },
  };
  const executor = new FactScopeAgentExecutor(inner, scopes);
  const context = { runId: "run-1", nodePath: "root/review" };
  await executor.execute(
    {
      taskId: "review-1",
      kind: "brainstorm.commentor",
      input: { bindings: { input: { prompt: "the submission" }, files: [] } },
      metadata: { factScope: { role: "commentor", agent: "commentor-1", seat: "member-1", step: 2 } },
    },
    context,
  );
  assert.deepEqual(seenDuring, {
    scope: { role: "commentor", agent: "commentor-1", seat: "member-1", step: 2 },
    context: { input: { prompt: "the submission" }, files: [], execution: context },
  });
  assert.equal(scopes.get("review-1"), undefined, "cleared after the task");
  await executor.execute({ taskId: "plain", kind: "brainstorm.brain", input: {} }, context);
  assert.equal(seenDuring, undefined, "a task without a fact scope sees none");
});

test("on the Messages path a fact-table task reaches the table through the scope registry", async () => {
  const submitted: { requester: FactRequester; submission: FactSubmission; context: FactSubmitContext }[] = [];
  const badge: FactEntry = {
    id: "F:1",
    status: "justified",
    kind: "code",
    claim: "The loader skips empty files",
    conditions: "file src/load.py line 12",
    method: "source-quoted",
    evidence: "if not data: continue",
    createdAt: 1,
    updatedAt: 1,
    history: [{ at: 1, event: "issued", by: "S:1" }],
    requesters: [],
  };
  const access: FactAccess = {
    entries: async () => [],
    submit: async (requester, submission, context) => {
      submitted.push({ requester, submission, context });
      return { submission: "S:1", case: "justified-new", badge, conflicts: [] };
    },
  };
  const toolUse = (input: JsonObject): JsonObject => ({
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: "toolu_1", name: "fact_table", input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const answer: JsonObject = {
    id: "msg_text",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text: "Reviewed." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 3 },
  };
  const submission = {
    claim: "The loader skips empty files",
    conditions: "file src/load.py line 12",
    evidence: "if not data: continue",
    kind: "code",
    step: 3,
  };
  const replies: JsonObject[] = [
    toolUse({ mode: "submit", ...submission }),
    answer,
    toolUse({ mode: "lookup", claim: "The loader skips empty files" }),
    answer,
  ];
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(replies.shift() ?? answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const scopes = new FactScopeRegistry();
    const executor = new FactScopeAgentExecutor(
      buildAgentExecutor(
        {
          provider: "anthropic",
          defaultModel: "claude-test",
          apiKey: "test-key",
          baseURL: `http://127.0.0.1:${port}`,
        },
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        { access, scopes },
      ),
      scopes,
    );
    const review = (taskId: string, metadata?: JsonObject): AgentTask => ({
      taskId,
      kind: "brainstorm.commentor",
      agentId: "commentor-2",
      input: { bindings: { input: { prompt: "the submission" }, files: [{ path: "src/load.py" }] } },
      tools: ["fact_table"],
      modelRequest: { messages: [{ role: "user", content: [{ type: "text", text: "Review step 3." }] }] },
      ...(metadata !== undefined ? { metadata } : {}),
    });
    const scoped = await executor.execute(
      review("review-1", { factScope: { role: "commentor", agent: "commentor-2", seat: "member-1", step: 3 } }),
      { runId: "run-1", nodePath: "root/review/member[0]/comment-step" },
    );
    assert.equal(scoped.status, "ok", JSON.stringify(scoped));
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0]!.requester, {
      taskId: "review-1",
      role: "commentor",
      agent: "commentor-2",
      seat: "member-1",
      step: 3,
    });
    assert.deepEqual(submitted[0]!.submission, submission);
    assert.deepEqual(submitted[0]!.context.input, { prompt: "the submission" });
    assert.deepEqual(submitted[0]!.context.files, [{ path: "src/load.py" }]);
    assert.equal(submitted[0]!.context.execution?.runId, "run-1");
    assert.match(bodies[0]!, /"fact_table"/, "the tool was offered");
    assert.match(bodies[1]!, /justified-new/, "the table's answer reached the model");
    assert.equal(scopes.get("review-1"), undefined, "the binding ends with the task");
    // A task without a fact scope finds the same registered tool, which refuses it.
    const unscoped = await executor.execute(review("plain-1"), { runId: "run-1", nodePath: "root/other" });
    assert.equal(unscoped.status, "ok", JSON.stringify(unscoped));
    assert.match(bodies[3]!, /answers only inside a board task whose role may use it/);
    assert.equal(submitted.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Fact updates (spec/fact-updates.md section 2 with decisions D1-D3, D12, D15;
// section 10 tests 1-8). With the control's `updates` a revoked entry leaves
// the table with a one-line deletion marker and a refuted claim never enters.
// ---------------------------------------------------------------------------

const UPDATES = "delete-or-replace/v1" as const;

function updatesTable(path = freshLog(), extra: { readonly strictWrites?: boolean } = {}): FileFactTable {
  return new FileFactTable({ logPath: path, limits: LIMITS, now: ticking(), updates: UPDATES, ...extra });
}

const revoking = (id: string, explanation: string) => judge(() => ({
  case: "justified-new",
  conflicts: [{ id, resolution: "incumbent-revoked", explanation }],
}));

/** A stored entry, as a seeded log line carries it. */
const storedEntry = (id: string, extra: Partial<FactEntry> = {}): FactEntry => ({
  id, status: "justified", kind: "math", claim: `Independent statement ${id}`, conditions: "finite inputs",
  method: "judgement-only", evidence: "A checked proof.", createdAt: 1, updatedAt: 1,
  history: [{ at: 1, event: "issued", detail: "The proof establishes this exact statement." }], requesters: [], ...extra,
});

/** A run directory whose log is seeded with `lines`; mediated unless `legacy`. */
function seededTable(lines: readonly object[], legacy = false): { readonly logPath: string; readonly table: FileFactTable } {
  const logPath = freshLog();
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return {
    logPath,
    table: new FileFactTable({ logPath, limits: LIMITS, updates: UPDATES, ...(legacy ? {} : { accessMode: "supreme-mediated/v1" as const }) }),
  };
}

const CRITIC: FactRequester = { taskId: "critic-task", role: "game-commentor", agent: "critic-task", seat: "member-1", step: 1 };
const CHAIR = (taskId: string): FactRequester => ({ taskId, role: "committee-chair", agent: "committee-chair", seat: "member-1", step: 1 });
const DELETED_F1 = "F:1 was deleted from the fact table and replaced by F:2: nothing may cite F:1 as support; check whether F:2 covers the citing claim within its conditions.";

test("fact updates 1: a ruling that revokes F:1 deletes it with one deletion record in the ruling's records; a resume keeps it deleted", async () => {
  const path = freshLog();
  const table = updatesTable(path);
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  await table.submit(asker("t1"), fact("The baseline reaches 0.80 accuracy", "dataset cifar10, seed 7"), {});
  table.attachVerifier(revoking("F:1", "F:1 read the wrong log."));
  const outcome = await table.submit(asker("t2"), fact("The baseline reaches 0.75 accuracy", "dataset cifar10, seed 7"), {});
  assert.equal(outcome.badge?.id, "F:2");
  assert.deepEqual(
    outcome.conflicts.map((conflict) => [conflict.entry.id, conflict.entry.status, conflict.resolution, conflict.deleted]),
    [["F:1", "justified", "incumbent-revoked", true]],
    "the submitter's answer keeps the deleted entry as it stood, marked deleted",
  );
  assert.deepEqual((await table.entries()).map((entry) => entry.id), ["F:2"]);
  const lines = logLines(path);
  assert.deepEqual(lines.slice(-3).map((line) => line.type), ["entry", "deletion", "submission"]);
  const marker = lines.at(-2)!;
  assert.deepEqual(Object.keys(marker).sort(), ["at", "id", "replacedBy", "seq", "type"], "the marker keeps no claim and no reason");
  assert.deepEqual([marker.id, marker.seq, marker.replacedBy], ["F:1", 1, "F:2"]);
  assert.equal(lines.filter((line) => line.type === "deletion").length, 1);
  assert.deepEqual(await table.deletions(), [{ id: "F:1", seq: 1, at: marker.at, replacedBy: "F:2" }]);
  assert.equal(await table.deletionEpoch(), 1);
  assert.deepEqual((await table.evidence()).deletions, await table.deletions());

  const resumed = updatesTable(path);
  assert.deepEqual((await resumed.entries()).map((entry) => entry.id), ["F:2"]);
  assert.deepEqual(await resumed.deletions(), await table.deletions());
  const [event] = await resumed.updateEvents();
  assert.deepEqual(
    [event!.deletion.id, event!.entry.claim, event!.reason, event!.replacement?.id, event!.submission],
    ["F:1", "The baseline reaches 0.80 accuracy", "F:1 read the wrong log.", "F:2", "S:2"],
  );
  resumed.attachVerifier(judge(() => ({ case: "justified-new" })));
  const next = await resumed.submit(asker("t3"), fact("The model trains in 2 hours", "one GPU"), {});
  assert.equal(next.badge?.id, "F:3", "a deleted id is never issued again");
});

test("fact updates 2: a refuted claim enters nothing and spends no id", async () => {
  const path = freshLog();
  const table = updatesTable(path);
  table.attachVerifier(judge(() => ({ case: "refuted", evidence: "The script printed 0.31." })));
  const refuted = await table.submit(asker("t1"), fact("The recall is 0.90", "split test"), {});
  assert.equal(refuted.case, "refuted");
  assert.equal(refuted.recorded, undefined);
  assert.equal(refuted.badge, undefined);
  assert.deepEqual(await table.entries(), []);
  assert.equal(formatFactOutcome(refuted).next, "The claim is false under the evidence above: drop it and every step built on it.");
  assert.equal(logLines(path).filter((line) => line.type === "entry").length, 0);
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  assert.equal((await table.submit(asker("t2"), fact("The precision is 0.70", "split test"), {})).badge?.id, "F:1");
});

test("fact updates 3: status answers a deleted id as deleted, without a consultation when no requested id stands", async () => {
  const lines = [
    { type: "entry", entry: storedEntry("F:1") },
    { type: "entry", entry: storedEntry("F:2") },
    { type: "deletion", id: "F:1", seq: 1, at: 5, replacedBy: "F:2" },
  ];
  const { table } = seededTable(lines);
  let calls = 0;
  table.attachConsultant(async (request) => {
    calls += 1;
    return { result: { answer: "The addressed badge still stands.", matches: [] }, taskId: `consult:${request.consultation}` };
  });
  const answer = await table.consult(CRITIC, { mode: "status", ids: ["F:1"] }, {});
  assert.equal(calls, 0);
  assert.deepEqual(answer, {
    mode: "status",
    answer: "None of the requested badges is in the fact table: see deleted and unknown.",
    matches: [],
    entries: [],
    unknown: [],
    deleted: [{ id: "F:1", replacedBy: "F:2", alert: DELETED_F1 }],
  });
  const mixed = await table.consult(CRITIC, { mode: "status", ids: ["F:1", "F:2", "F:9"] }, {});
  assert.equal(calls, 1);
  assert.deepEqual((mixed.entries as JsonObject[]).map((entry) => entry.id), ["F:2"]);
  assert.deepEqual(mixed.unknown, ["F:9"]);
  assert.deepEqual(mixed.deleted, [{ id: "F:1", replacedBy: "F:2", alert: DELETED_F1 }]);

  const legacy = seededTable(lines, true).table;
  const result = await runFactTable(legacy, { role: "commentor", agent: "critic-1", seat: "member-1", step: 2, cited: [{ step: 2, ids: ["F:1"] }] }, "t-1", { mode: "status" });
  const output = result.output as JsonObject;
  assert.deepEqual(output.deleted, [{ id: "F:1", replacedBy: "F:2" }]);
  assert.deepEqual(output.alerts, [`${DELETED_F1} (cited at step 2)`]);
  assert.equal(output.unknown, undefined);
});

test("fact updates 4: approve on a deleted cited id throws the exact message", async () => {
  const { table } = seededTable([
    { type: "entry", entry: storedEntry("F:1") },
    { type: "entry", entry: storedEntry("F:2") },
    { type: "entry", entry: storedEntry("F:3") },
    { type: "deletion", id: "F:1", seq: 1, at: 5, replacedBy: "F:2" },
    { type: "deletion", id: "F:3", seq: 2, at: 6 },
  ]);
  table.attachConsultant(async () => assert.fail("a deleted badge is answered without a consultation"));
  const review = (justification: string): FactSubmitContext => ({ review: { chairTaskId: "chair-1", reviewVersion: "review-version",
    reports: { critic: { justification, reportHash: factReportHash({ q: 0.2, justification }) } } } });
  const approve = (factId: string) => ({ mode: "approve" as const, factId, badgeHash: `sha256:${"0".repeat(64)}`, criticId: "critic" });
  await assert.rejects(table.consult(CHAIR("chair-1"), approve("F:1"), review("The bound holds [F:1].")),
    { message: "The cited badge F:1 was deleted from the fact table and replaced by F:2; it cannot support a report." });
  await assert.rejects(table.consult(CHAIR("chair-1"), approve("F:3"), review("The bound holds [F:3].")),
    { message: "The cited badge F:3 was deleted from the fact table; it cannot support a report." });
});

test("fact updates 5: a private revocation disputes the shared entry; only a shared ruling deletes it, once, and nothing resurrects it [D3]", async () => {
  const path = freshLog();
  const shared = updatesTable(path);
  const heard: string[] = [];
  shared.onUpdate((event) => heard.push(event.deletion.id));
  shared.attachVerifier(judge(() => ({ case: "justified-new" })));
  await shared.submit(asker("t0"), fact("The bound holds for every graph", "none"), {});
  const scope = { role: "game-commentor", agent: "critic-b", seat: "member-1", step: 1, blindReview: "round-group-1" };
  const viewB = await shared.forTask("critic-b-task", scope);
  const snapshotPath = join(dirname(path), "fact-views", createHash("sha256").update("round-group-1").digest("hex"), "snapshot.json");
  const snapshot = readFileSync(snapshotPath, "utf8");

  shared.attachVerifier(revoking("F:1", "The bound fails on graphs with a cycle."));
  const critic: FactRequester = { taskId: "critic-b-task", role: "game-commentor", agent: "critic-b", seat: "member-1", step: 1 };
  const privateRuling = await viewB.submit(critic, fact("The bound holds for every tree", "acyclic graphs"), {});
  const successor = privateRuling.badge!.id;
  assert.equal(privateRuling.conflicts[0]?.deleted, true);
  assert.deepEqual((await viewB.entries()).map((entry) => entry.id), [successor], "the view itself deleted F:1");
  const published = new Map((await shared.entries()).map((entry) => [entry.id, entry]));
  assert.equal(published.get("F:1")!.status, "disputed");
  assert.deepEqual(
    { event: published.get("F:1")!.history.at(-1)!.event, by: published.get("F:1")!.history.at(-1)!.by, detail: published.get("F:1")!.history.at(-1)!.detail },
    { event: "disputed", by: successor, detail: "Revoked in a private review; pending a ruling against the shared table's combined evidence." },
  );
  assert.equal(published.get(successor)!.status, "disputed", "the private successor awaits the shared check");
  assert.equal(logLines(path).filter((line) => line.type === "deletion").length, 0);
  assert.deepEqual(heard, []);

  // The committee chair's reconciliation of the successor rules against the shared table and revokes F:1.
  const reconciled = await shared.submit(CHAIR("chair-task"), fact("The bound holds for every tree", "acyclic graphs"), {});
  assert.equal(reconciled.case, "justified-new");
  assert.deepEqual(heard, ["F:1"]);
  assert.equal(logLines(path).filter((line) => line.type === "deletion").length, 1);
  assert.equal((await shared.entries()).some((entry) => entry.id === "F:1"), false);

  await viewB.entries();
  assert.equal((await shared.entries()).some((entry) => entry.id === "F:1"), false, "a later publish never resurrects a shared-deleted id");
  const viewC = await shared.forTask("critic-c-task", { ...scope, agent: "critic-c" });
  assert.equal((await viewC.entries()).some((entry) => entry.id === "F:1"), false, "a view opened after the deletion omits the id");
  assert.deepEqual((await viewC.deletions!()).map((deletion) => deletion.id), ["F:1"]);
  assert.equal(readFileSync(snapshotPath, "utf8"), snapshot, "the frozen snapshot is never rewritten");
  assert.deepEqual(heard, ["F:1"]);
});

test("fact updates 6: the update listener hears each durable shared deletion once, and nothing after a failed strict write", async () => {
  const path = freshLog();
  const table = updatesTable(path, { strictWrites: true });
  const heard: string[] = [];
  table.onUpdate((event) => heard.push(event.deletion.id));
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  await table.submit(asker("t1"), fact("The first estimate is 0.4", "seed 1"), {});
  await table.submit(asker("t2"), fact("The second estimate is 0.6", "seed 2"), {});
  table.attachVerifier(revoking("F:1", "The first estimate used the wrong seed."));
  await table.submit(asker("t3"), fact("The first estimate is 0.5", "seed 1"), {});
  assert.deepEqual(heard, ["F:1"]);
  chmodSync(path, 0o400);
  table.attachVerifier(revoking("F:2", "The second estimate used the wrong seed."));
  await assert.rejects(table.submit(asker("t4"), fact("The second estimate is 0.7", "seed 2"), {}));
  assert.deepEqual(heard, ["F:1"], "a ruling whose records are not durable announces nothing");
});

test("fact updates 7: without updates a table writes no deletion and its evidence carries no deletions", async () => {
  const path = freshLog();
  const table = factTable(path);
  table.attachVerifier(judge(() => ({ case: "justified-new" })));
  await table.submit(asker("t1"), fact("The baseline reaches 0.80 accuracy", "dataset cifar10, seed 7"), {});
  table.attachVerifier(revoking("F:1", "F:1 read the wrong log."));
  await table.submit(asker("t2"), fact("The baseline reaches 0.75 accuracy", "dataset cifar10, seed 7"), {});
  assert.deepEqual((await table.entries()).map((entry) => [entry.id, entry.status]), [["F:1", "revoked"], ["F:2", "justified"]]);
  assert.equal(logLines(path).filter((line) => line.type === "deletion").length, 0);
  assert.equal(Object.hasOwn(await table.evidence(), "deletions"), false);
  assert.deepEqual(await table.deletions(), []);
});

test("fact updates 8: a re-assessment's approve for an unchanged report and badge returns the earlier receipt without a consultation [D12]", async () => {
  const entry = storedEntry("F:1");
  const { table } = seededTable([{ type: "entry", entry }]);
  let calls = 0;
  table.attachConsultant(async (request) => {
    calls += 1;
    return {
      result: {
        answer: "The verified premise supports the report.",
        matches: [],
        approval: { approved: true, targetFactId: String(request.bindings.request.proposedTargetFactId), reason: "The verified proposition supports this report under these conditions." },
      },
      taskId: `consult:${calls}`,
    };
  });
  const justification = "The shown proof establishes the bound [F:1].";
  const review = (chairTaskId: string, text: string, q: number, earlier?: readonly string[]): FactSubmitContext => ({
    review: { chairTaskId, reviewVersion: "review-version", reports: { critic: { justification: text, reportHash: factReportHash({ q, justification: text }) } },
      ...(earlier !== undefined ? { earlierChairTaskIds: earlier } : {}) },
  });
  const query = { mode: "approve" as const, factId: "F:1", badgeHash: factBadgeHash(entry), criticId: "critic" };
  const first = await table.consult(CHAIR("chair-1"), query, review("chair-1", justification, 0.2));
  assert.equal(calls, 1);
  const again = await table.consult(CHAIR("chair-2"), query, review("chair-2", justification, 0.2, ["chair-1"]));
  assert.equal(calls, 1, "no consultation for an unchanged report and badge");
  assert.deepEqual(again.approval, first.approval);
  const revised = "The revised proof establishes the bound [F:1] for every tree.";
  const fresh = await table.consult(CHAIR("chair-2"), query, review("chair-2", revised, 0.4, ["chair-1"]));
  assert.equal(calls, 2, "a revised report needs a fresh approval");
  assert.equal((fresh.approval as JsonObject).requesterTaskId, "chair-2");
  await table.consult(CHAIR("chair-3"), query, review("chair-3", justification, 0.2));
  assert.equal(calls, 3, "a chair task without the round's earlier ids consults");
});

test("fact updates D15: a status scan whose table moved before it could commit adds its consultation and usage to the scan that commits", async () => {
  const { logPath, table } = seededTable([{ type: "entry", entry: storedEntry("F:1") }]);
  let call = 0;
  table.attachVerifier(async (request) => ({
    taskId: `verify:${request.submission}`,
    verdict: {
      case: "justified-new", claim: String(request.bindings.request.claim), conditions: String(request.bindings.request.conditions),
      method: "judgement-only", evidence: "Independently checked the complete proof.", explanation: "The proof establishes the claim.",
      conflicts: [], integrity: "honest",
    },
  }));
  table.attachConsultant(async (request) => {
    call += 1;
    const mine = call;
    // While the first scan is out, another task's submission moves the table.
    if (mine === 1) await table.submit(CHAIR("chair-1"), { claim: "An unrelated sum is finite.", conditions: "finite inputs", evidence: "A complete finite-sum proof.", kind: "math" }, {});
    return { result: { answer: "The addressed badge still stands.", matches: [] }, taskId: `consult:${mine}`, usage: { inputTokens: 10, outputTokens: 2 } };
  });
  await table.consult(CRITIC, { mode: "status", ids: ["F:1"] }, {});
  const statusLines = logLines(logPath).filter((line) => line.type === "consultation" && (line.request as JsonObject).mode === "status");
  assert.equal(statusLines.length, 1);
  const [line] = statusLines;
  assert.equal((line!.taskIds as string[])[0], "consult:1", "the discarded scan is recorded with the scan that commits");
  assert.equal((line!.taskIds as string[]).length, 2);
  assert.deepEqual([(line!.usage as JsonObject).inputTokens, (line!.usage as JsonObject).outputTokens], [20, 4]);
});
