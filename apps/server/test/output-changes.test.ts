import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { JournalEntry } from "@brainstorm-agentic/core";
import type { ServerSettings } from "@brainstorm-agentic/protocol";

import type { JobRecord } from "../src/model.js";
import { buildJobDetailWithActivity } from "../src/stage-mapper.js";
import { outputChangesMarkdown } from "../src/output-changes.js";

const settings: ServerSettings = {
  slurmTemplate: "{{BRAIN_COMMAND}}",
  runner: "local",
  llm: { provider: "offline" },
  panelConfirmation: "auto",
  contentRegistry: { url: "http://127.0.0.1:1", bundle: "brainstorm" },
  creditRecovery: {
    autoResume: true,
    safetyBufferSeconds: 60,
    openRouterModel: "openrouter/free",
  },
};

const paragraph = "One paragraph of finished text that stands alone.";

const paperBody = (method: string) => ({
  abstract: [paragraph, paragraph, paragraph],
  introduction: [paragraph, paragraph, paragraph],
  method: [method, paragraph, paragraph],
  discussion: [paragraph, paragraph, paragraph],
  conclusion: [paragraph],
});

const DEVELOP_KEY =
  "brainstorm-root/first-pass/first-pass-fanout/member[0]/develop-idea/develop-idea-execute::result";
const REVISION_KEY =
  "brainstorm-root/review-members/review-members-fanout/member[0]" +
  "/review-steps/cotStep[1]/review-round-loop/iter[0]/review-round-body/maybe-redevelop/then/" +
  "redevelop-idea-execute::result";

test("the output history holds the first pass and every revision, addressed by review moment", () => {
  const workspace = mkdtempSync(join(tmpdir(), "output-changes-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });

    const firstIdea = {
      output: { type: "research idea", paper: paperBody("The original mechanism.") },
      cot: ["Step one.", "Step two.", "Step three."],
      novelty: "Original novelty claim.",
    };
    const entries: JournalEntry[] = [
      {
        key: DEVELOP_KEY,
        kind: "agent",
        value: { taskId: "t-develop", status: "ok", output: firstIdea },
      },
      {
        key: REVISION_KEY,
        kind: "agent",
        value: {
          taskId: "t-revision",
          status: "ok",
          output: {
            steps: [{ index: 2, text: "REVISED step two." }],
            outputPatch: {
              paper: { method: ["The repaired mechanism.", paragraph, paragraph] },
            },
          },
        },
      },
    ];
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "completed",
        input: {},
        journal: entries,
        pendingGates: [],
        seq: 1,
        updatedAt: Date.now(),
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "index.json"),
      JSON.stringify({
        refs: [
          { id: "a-panel", metadata: { schema: "panel", path: "panel" } },
          { id: "a-idea", metadata: { schema: "brainIdea", path: "ideas.member-1" } },
        ],
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "a-panel"),
      JSON.stringify({
        members: [
          { id: "member-1", department: "Physics", umbrella: "Quantum Optics", subfields: [] },
        ],
      }),
    );
    writeFileSync(join(sessionDir, "artifacts", "a-idea"), JSON.stringify(firstIdea));

    const record: JobRecord = {
      jobId: "job-1",
      topic: "topic",
      status: "completed",
      runner: "local",
      createdAt: 1,
      updatedAt: 2,
    };
    const { outputHistory } = buildJobDetailWithActivity({
      record,
      status: "completed",
      sessionDir,
      jobDir,
      settings,
    });
    const versions = outputHistory.get("member-1");
    assert.ok(versions);
    assert.equal(versions.length, 2, "the first pass plus one revision");

    const [first, revised] = versions;
    assert.equal(first!.step, 0, "the first pass is version zero");
    assert.equal(first!.round, 0);
    const firstMethod = first!.sections.find((section) => section.label === "Method");
    assert.match(firstMethod!.text, /The original mechanism\./);

    // cotStep[1]/iter[0] is the deck's "step 2, round 1".
    assert.equal(revised!.step, 2);
    assert.equal(revised!.round, 1);
    const revisedMethod = revised!.sections.find((section) => section.label === "Method");
    assert.match(revisedMethod!.text, /The repaired mechanism\./);
    assert.ok(
      !revisedMethod!.text.includes("The original mechanism."),
      "the revision's snapshot is the patched body",
    );
    // Untouched sections carry through unchanged.
    assert.equal(
      revised!.sections.find((section) => section.label === "Abstract")?.text,
      first!.sections.find((section) => section.label === "Abstract")?.text,
    );

    // The document: first version whole, then one dated section per change,
    // additions bold and removals struck, unchanged sections omitted.
    const markdown = outputChangesMarkdown({
      seat: "Seat 1",
      expertise: "Physics / Quantum Optics",
      topic: "topic",
      versions,
    });
    assert.match(markdown, /^# Seat 1 — final output, tracked changes/m);
    assert.match(markdown, /## First version — first pass/);
    assert.match(markdown, /## Step 2 · round 1/);
    // Word-level: only the changed word wears the mark, its sentence stays.
    assert.match(markdown, /The \*\*repaired\*\* ~~original~~|~~original~~ \*\*repaired\*\*/);
    assert.ok(
      !/### Abstract\n/.test(markdown.split("## Step 2")[1] ?? ""),
      "sections the revision left alone stay out of its entry",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a revision that rewrote only chain steps reads as a no-change entry", () => {
  const markdown = outputChangesMarkdown({
    seat: "Seat 2",
    versions: [
      {
        step: 0,
        round: 0,
        sections: [{ label: "Method", text: "The mechanism." }],
      },
      {
        step: 3,
        round: 1,
        sections: [{ label: "Method", text: "The mechanism." }],
      },
    ],
  });
  assert.match(markdown, /## Step 3 · round 1/);
  assert.match(markdown, /_No change to the main section in this round\._/);
});
