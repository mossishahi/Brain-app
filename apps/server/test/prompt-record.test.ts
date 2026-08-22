import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PromptRecord } from "@brainstorm-agentic/core";
import type { JobDetail } from "@brainstorm-agentic/protocol";

import {
  promptFilename,
  promptIdentity,
  readPromptRecord,
  renderPromptMarkdown,
} from "../src/prompt-record.js";

function temp(lines: readonly string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "prompt-record-"));
  writeFileSync(join(dir, "prompts.jsonl"), lines.join("\n"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function record(overrides: Partial<PromptRecord> = {}): PromptRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    at: Date.UTC(2026, 7, 21, 12, 32, 7, 412),
    taskId: "run-7:root/review-members/member[1]/iter[0]/cotStep[2]/judge-step",
    kind: "brainstorm.judge",
    attempt: 1,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    complete: true,
    sections: [],
    ...overrides,
  };
}

test("a record is found by id, and a half-written line never fails the read", () => {
  // The worker flushes on a timer and appends across resumes, so a live run's
  // file legitimately ends mid-line and may carry records from two processes.
  const wanted = record({ id: "wanted", provider: "anthropic" });
  const { dir, cleanup } = temp([
    JSON.stringify(record({ id: "other" })),
    "",
    "{ not json at all",
    JSON.stringify(wanted),
    JSON.stringify(record({ id: "trailing" })).slice(0, 40),
  ]);
  try {
    assert.equal(readPromptRecord(dir, "wanted")?.id, "wanted");
    assert.equal(readPromptRecord(dir, "other")?.id, "other");
    assert.equal(readPromptRecord(dir, "trailing"), undefined);
    assert.equal(readPromptRecord(dir, "never-written"), undefined);
  } finally {
    cleanup();
  }
});

test("a duplicated id resolves to the last occurrence", () => {
  const { dir, cleanup } = temp([
    JSON.stringify(record({ id: "dup", model: "first" })),
    JSON.stringify(record({ id: "dup", model: "second" })),
  ]);
  try {
    assert.equal(readPromptRecord(dir, "dup")?.model, "second");
  } finally {
    cleanup();
  }
});

test("a run that never captured a prompt reads as absent, not as a fault", () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-record-"));
  try {
    assert.equal(readPromptRecord(dir, "anything"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the header carries who called, from where, on what, and how complete it is", () => {
  const markdown = renderPromptMarkdown(
    record({ turn: 3, attempt: 2, logicalRoute: "reasoning" }),
    { role: "Judge", actor: "Seat 2", where: { seat: "Seat 2", step: 3, round: 2 } },
  );
  const clock = new Date(record().at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // The same string the activity row shows, so a reader can match the file back
  // to the row they clicked.
  assert.match(markdown, new RegExp(`\\*\\*Time\\*\\* — ${clock} `));
  assert.match(markdown, /\*\*Role\*\* — Judge/);
  assert.match(markdown, /\*\*Seat\*\* — Seat 2/);
  assert.match(markdown, /\*\*Place\*\* — Seat 2 · step 3 · round 2/);
  assert.match(markdown, /\*\*Provider\*\* — anthropic/);
  assert.match(markdown, /\*\*Model\*\* — claude-sonnet-4-5/);
  assert.match(markdown, /\*\*Route\*\* — reasoning/);
  assert.match(markdown, /\*\*Attempt\*\* — 2/);
  assert.match(markdown, /\*\*Turn\*\* — 3/);
  assert.match(markdown, /This is every byte the model received/);
});

test("an SDK hand-off says in plain words that it is only our half", () => {
  const markdown = renderPromptMarkdown(
    record({ complete: false, provider: "claude-agent-sdk" }),
    { role: "Thinker" },
  );
  assert.match(markdown, /only our half of the request/);
  assert.match(markdown, /claude-agent-sdk SDK composes the final request/);
  assert.doesNotMatch(markdown, /every byte the model received/);
  // A task with no seat says so by omission rather than by a placeholder.
  assert.doesNotMatch(markdown, /\*\*Seat\*\*/);
  assert.doesNotMatch(markdown, /\*\*Place\*\*/);
});

test("sections render in order, fenced where the body is machine material", () => {
  const markdown = renderPromptMarkdown(
    record({
      sections: [
        { title: "System prompt", body: "You are a judge.\n\nBe strict." },
        { title: "Delivered output JSON schema", body: '{\n  "type": "object"\n}' },
        { title: "Execution settings in force", body: "maxTurns=40" },
      ],
    }),
    {},
  );
  const system = markdown.indexOf("## System prompt");
  const schema = markdown.indexOf("## Delivered output JSON schema");
  const settings = markdown.indexOf("## Execution settings in force");
  assert.ok(system > 0 && schema > system && settings > schema, "emission order is kept");
  assert.match(markdown, /## System prompt\n\nYou are a judge\.\n\nBe strict\./);
  assert.match(markdown, /```json\n\{\n  "type": "object"\n\}\n```/);
  // Machine material that is not JSON is still fenced, on the title's word.
  assert.match(markdown, /```\nmaxTurns=40\n```/);
});

test("a body containing a fence is wrapped in a longer one, so nothing spills", () => {
  const body = '{"code": "```\\nprint(1)\\n```"}';
  const markdown = renderPromptMarkdown(
    record({ sections: [{ title: "Tools offered", body }] }),
    {},
  );
  assert.ok(markdown.includes("````json\n" + body + "\n````"), markdown);
});

test("the filename names the role, the moment and the record", () => {
  const at = new Date(Date.UTC(2026, 7, 21, 12, 32, 7));
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  assert.equal(
    promptFilename(record({ at: at.getTime(), id: "abc-123" }), { role: "Judge" }),
    `judge-${stamp}-abc-123.md`,
  );
  // No role annotation (a pre-panel task): the task kind names the file instead.
  assert.equal(
    promptFilename(record({ at: at.getTime(), id: "abc-123" }), {}),
    `brainstorm-judge-${stamp}-abc-123.md`,
  );
});

test("identity comes from the row when the feed still holds it, and from the path when it does not", () => {
  const panel = [
    { id: "member-1", department: "A", umbrella: "a", subfields: [] },
    { id: "member-2", department: "B", umbrella: "b", subfields: [] },
  ];
  const withRow = {
    stages: [
      {
        id: "select-panel",
        status: "done",
        panel,
        activity: [
          {
            id: "9",
            at: 1,
            kind: "llm_call",
            message: "handed the prompt to the model",
            promptId: "p1",
            role: "Judge",
            actor: "Seat 2",
            where: { seat: "Seat 2", step: 3, round: 4 },
          },
        ],
      },
    ],
  } as unknown as JobDetail;
  assert.deepEqual(promptIdentity(record({ id: "p1" }), withRow), {
    role: "Judge",
    actor: "Seat 2",
    where: { seat: "Seat 2", step: 3, round: 4 },
  });

  // The feed is capped, so an older call's row may be gone; the same answers
  // are then derived from the task's own path, the way the row's were.
  const withoutRow = {
    stages: [{ id: "select-panel", status: "done", panel, activity: [] }],
  } as unknown as JobDetail;
  assert.deepEqual(promptIdentity(record({ id: "p1" }), withoutRow), {
    role: "Judge",
    where: { seat: "Seat 2", step: 3, round: 1 },
  });
});
