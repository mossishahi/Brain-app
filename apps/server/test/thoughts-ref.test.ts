import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { JournalEntry } from "@brainstorm-agentic/core";
import type { ServerSettings } from "@brainstorm-agentic/protocol";

import type { JobRecord } from "../src/model.js";
import { buildJobDetail, resolveThoughtsRef } from "../src/stage-mapper.js";

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
const noEvidence = {
  kind: "none",
  code: "",
  result: "",
  derivation: "",
  citation: "",
  locator: "",
  shows: "",
};

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

// ---------------------------------------------------------------------------
// resolveThoughtsRef: the endpoint's half of the opaque handle
// ---------------------------------------------------------------------------

const journal: JournalEntry[] = [
  {
    key: DEVELOP_KEY,
    kind: "agent",
    value: {
      taskId: "t-develop",
      status: "ok",
      output: {},
      metadata: {
        stepThoughts: [
          { step: 1, text: "the thinking behind step one" },
          { step: 2, text: "" },
        ],
      },
    },
  },
];

test("a handle resolves to exactly the slice the view addressed", () => {
  assert.equal(
    resolveThoughtsRef(journal, `${DEVELOP_KEY}#1`),
    "the thinking behind step one",
  );
});

test("an unknown key, step, or malformed handle resolves to nothing", () => {
  assert.equal(resolveThoughtsRef(journal, `${DEVELOP_KEY}#7`), undefined);
  assert.equal(resolveThoughtsRef(journal, "some-other-key#1"), undefined);
  assert.equal(resolveThoughtsRef(journal, "no-step-marker"), undefined);
  assert.equal(resolveThoughtsRef(journal, `${DEVELOP_KEY}#zero`), undefined);
  // An EMPTY recorded slice is dropped at capture, so it never resolves —
  // matching the view side, which mints no handle for it.
  assert.equal(resolveThoughtsRef(journal, `${DEVELOP_KEY}#2`), undefined);
});

// ---------------------------------------------------------------------------
// the mapper mints handles exactly where a slice exists
// ---------------------------------------------------------------------------

test("review views carry resolvable handles for the original and the rewrite", () => {
  const workspace = mkdtempSync(join(tmpdir(), "thoughts-ref-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });

    const firstIdea = {
      output: { type: "research idea", paper: paperBody("The original mechanism.") },
      cot: ["Step one.", "Step two.", "Step three."],
      novelty: "Original novelty claim.",
      literature: [{ title: "Closest work", year: 2024 }],
    };
    const entries: JournalEntry[] = [
      {
        key: DEVELOP_KEY,
        kind: "agent",
        value: {
          taskId: "t-develop",
          status: "ok",
          output: firstIdea,
          metadata: {
            stepThoughts: [
              { step: 1, text: "first-pass thinking behind step one" },
              { step: 2, text: "first-pass thinking behind step two" },
              // Step three recorded nothing: no slice, so no handle below.
            ],
          },
        },
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
            novelty: "Revised novelty claim.",
          },
          metadata: {
            stepThoughts: [{ step: 2, text: "the reviser's thinking behind the repair" }],
          },
        },
      },
      {
        key:
          "brainstorm-root/review-members/review-members-fanout/member[0]" +
          "/review-steps/cotStep[1]/review-round-loop/iter[0]/review-round-body/judge-step/" +
          "judge-step-execute::result",
        kind: "agent",
        value: {
          taskId: "t-judge",
          status: "ok",
          output: {
            verdict: "Build",
            reason: "The step has to name its framework before it can stand.",
            suggestion: "Name the framework.",
            evidence: noEvidence,
            assessment: [],
            issues: [
              {
                step: 2,
                point: "The framework the guarantee comes from is never named.",
                basis: "authority",
                mustAddress: true,
                suggestion: "",
                evidence: noEvidence,
              },
            ],
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
          { id: "member-2", department: "Biology", umbrella: "Systems Biology", subfields: [] },
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
    const detail = buildJobDetail({
      record,
      status: "completed",
      sessionDir,
      jobDir,
      settings,
    });
    const review = detail.stages.find((candidate) => candidate.id === "review-members");
    assert.ok(review && review.id === "review-members");
    const seat = review.members.find((member) => member.memberId === "member-1");
    assert.ok(seat);

    // The original card's handle: present exactly where the first pass
    // recorded a slice, and resolvable against the same journal.
    const [stepOne, stepTwo, stepThree] = seat.steps;
    assert.ok(stepOne?.thoughts, "step 1 recorded thinking, so it carries a handle");
    assert.equal(
      resolveThoughtsRef(entries, stepOne.thoughts),
      "first-pass thinking behind step one",
    );
    assert.ok(stepTwo?.thoughts);
    assert.equal(stepThree?.thoughts, undefined, "no slice, no handle");

    // The rewrite's handle: the reviser's own thinking behind the version
    // its card shows.
    const round = stepTwo.rounds.find((candidate) => candidate.revision !== undefined);
    assert.ok(round?.revision?.rewritten);
    const rewrite = round.revision.rewritten.find((entry) => entry.index === 2);
    assert.ok(rewrite?.thoughts, "the rewritten step carries the reviser's handle");
    assert.equal(
      resolveThoughtsRef(entries, rewrite.thoughts),
      "the reviser's thinking behind the repair",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
