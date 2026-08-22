import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentExecutionContext,
  AgentExecutor,
  AgentResult,
  AgentTask,
  PromptRecord,
} from "@brainstorm-agentic/core";

import { createPromptLog, noPromptCapture } from "../src/prompt-capture.js";
import { PromptCapturingAgentExecutor } from "../src/wiring.js";

function temp(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "prompt-capture-"));
  return {
    file: join(dir, "prompts.jsonl"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const lines = (file: string): PromptRecord[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PromptRecord);

function record(id: string, overrides: Partial<PromptRecord> = {}): PromptRecord {
  return {
    id,
    at: 1_700_000_000_000,
    taskId: `run-1:root/member[0]`,
    kind: "brainstorm.brain",
    attempt: 1,
    provider: "anthropic",
    complete: true,
    sections: [{ title: "System", body: "You are a panellist." }],
    ...overrides,
  };
}

test("records are batched into one write, one line each, in the order they were handed over", async () => {
  // A review fan-out starts a dozen agents in the same second, and the worker
  // and the server share only a network filesystem: a write per record would be
  // a dozen filesystem operations for something a reader opens once, by hand.
  const { file, cleanup } = temp();
  try {
    const log = createPromptLog(file);
    log.note(record("p1"));
    log.note(record("p2"));
    log.note(record("p3"));
    await log.close();
    assert.deepEqual(
      lines(file).map((line) => line.id),
      ["p1", "p2", "p3"],
    );
    assert.equal(
      readFileSync(file, "utf8").trimEnd().split("\n").length,
      3,
      "one line per record, so the reader can find one by id without parsing the rest",
    );
  } finally {
    cleanup();
  }
});

test("a whole prompt survives verbatim on one line", async () => {
  // Section bodies are entire system prompts and tool schemas: they carry
  // newlines, quotes and braces, and the file is line-delimited. If either
  // property gave way the record would be unreadable exactly when it matters.
  const { file, cleanup } = temp();
  const body = 'line one\nline two\t"quoted"\n{"schema":{"type":"object"}}\n';
  try {
    const log = createPromptLog(file);
    log.note(record("p1", { sections: [{ title: "Tools", body }] }));
    await log.close();
    const written = lines(file);
    assert.equal(written.length, 1, "a multi-line body is still one line of the file");
    assert.equal(written[0]?.sections[0]?.body, body);
  } finally {
    cleanup();
  }
});

test("a resumed run appends: the previous worker's records still resolve", async () => {
  // The one place this differs from live text. A resume replays its finished
  // tasks from the journal rather than re-issuing their prompts, so the earlier
  // worker's records are the ONLY copy — truncating would leave every row from
  // before the resume offering a download that no longer exists.
  const { file, cleanup } = temp();
  try {
    writeFileSync(file, JSON.stringify(record("before-the-resume")) + "\n");
    const log = createPromptLog(file);
    log.note(record("after-the-resume"));
    await log.close();
    assert.deepEqual(
      lines(file).map((line) => line.id),
      ["before-the-resume", "after-the-resume"],
    );
  } finally {
    cleanup();
  }
});

test("an unwritable file never touches the run, and says why once", async () => {
  // Transport, not a record of the run: a wedged or missing directory must not
  // fail a run that is otherwise producing real work. It must not fail SILENTLY
  // either — from here on every model row offers a download that cannot be
  // served, and without this line that looks like a bug in the row.
  const said: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => void said.push(String(message));
  try {
    const log = createPromptLog("/nonexistent-directory-for-prompt-capture/p.jsonl");
    log.note(record("p1"));
    log.note(record("p2"));
    await log.close();
  } finally {
    console.error = original;
  }
  assert.equal(said.length, 1, "one line for the run, not one per record");
  assert.match(said[0] ?? "", /prompt capture stopped/);
});

test("a write that never returns fails the flush instead of hanging it", async () => {
  // These files live on the same wedge-prone shared mounts as the checkpoints,
  // where a write can block in the kernel forever. Unbounded, that would hold
  // close() — and therefore the end of the run — open for the whole job.
  const said: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => void said.push(String(message));
  try {
    const log = createPromptLog("/wedged-mount/prompts.jsonl", {
      deadlineMs: 20,
      // A mount that has stopped answering: the write neither returns nor fails.
      append: () => new Promise<void>(() => {}),
    });
    log.note(record("p1"));
    await log.close();
  } finally {
    console.error = original;
  }
  assert.equal(said.length, 1);
  assert.match(said[0] ?? "", /not responding/);
});

test("a host with nowhere to serve records from spends nothing", async () => {
  const log = noPromptCapture();
  log.note(record("p1"));
  await log.close();
});

test("the wiring hands every executor the run's prompt sink", async () => {
  // One row, one file, and no row without a file behind it: the row is emitted
  // by the executor as a progress event, and the file exists only because the
  // same executor found reportPrompt on its context. If the sink stopped
  // arriving, every row in the run would offer a download that 404s.
  const captured: PromptRecord[] = [];
  let seen: AgentExecutionContext | undefined;
  const inner: AgentExecutor = {
    execute(_task: AgentTask, context: AgentExecutionContext): Promise<AgentResult> {
      seen = context;
      context.reportPrompt?.(record("p1"));
      return Promise.resolve({ status: "ok", output: null } as AgentResult);
    },
  };
  const executor = new PromptCapturingAgentExecutor(inner, (r) => void captured.push(r));
  const context: AgentExecutionContext = { runId: "run-1", nodePath: "root/member[0]" };
  await executor.execute(
    { taskId: "run-1:root/member[0]", kind: "brainstorm.brain", input: {} },
    context,
  );
  assert.deepEqual(
    captured.map((r) => r.id),
    ["p1"],
  );
  assert.equal(
    context.reportPrompt,
    undefined,
    "the runner's own context object is copied, never mutated",
  );
  assert.equal(seen?.runId, "run-1", "everything else about the context is passed through");
});

test("a host that wired its own sink keeps it", async () => {
  const mine: PromptRecord[] = [];
  const runtime: PromptRecord[] = [];
  const inner: AgentExecutor = {
    execute(_task: AgentTask, context: AgentExecutionContext): Promise<AgentResult> {
      context.reportPrompt?.(record("p1"));
      return Promise.resolve({ status: "ok", output: null } as AgentResult);
    },
  };
  const executor = new PromptCapturingAgentExecutor(inner, (r) => void runtime.push(r));
  await executor.execute(
    { taskId: "run-1:root/member[0]", kind: "brainstorm.brain", input: {} },
    {
      runId: "run-1",
      nodePath: "root/member[0]",
      reportPrompt: (r) => void mine.push(r),
    },
  );
  assert.equal(mine.length, 1);
  assert.equal(runtime.length, 0);
});
