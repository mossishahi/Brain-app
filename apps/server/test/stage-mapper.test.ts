import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { FirstPassStage, ServerSettings } from "@brainstorm-agentic/protocol";

import type { JobRecord } from "../src/model.js";
import { buildJobDetail } from "../src/stage-mapper.js";

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

/** Materializes a completed run whose only artifacts are the panel and one member's idea. */
function firstPass(idea: unknown): FirstPassStage {
  const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "completed",
        input: {},
        journal: [],
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
    writeFileSync(join(sessionDir, "artifacts", "a-idea"), JSON.stringify(idea));

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
    const stage = detail.stages.find((candidate) => candidate.id === "first-pass");
    assert.ok(stage && stage.id === "first-pass");
    return stage;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function memberIdea(stage: FirstPassStage) {
  const member = stage.members.find((candidate) => candidate.memberId === "member-1");
  assert.ok(member?.idea, "member-1's idea must map to a view");
  return member.idea;
}

/**
 * The review reconstruction, driven by the journal-key shape of one topology.
 * A sequential walk paths a seat as review-members/member[i]; a parallel walk
 * inserts the compiler's fan-out segment before the member. Both shapes stay
 * live forever: old runs are pinned to sequential bundles, new bundles review
 * the seats in parallel.
 */
function assertReviewReconstruction(memberPathPrefix: string): void {
  const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });

    const paperBody = (method: string) => ({
      abstract: [paragraph, paragraph, paragraph],
      introduction: [paragraph, paragraph, paragraph],
      method: [method, paragraph, paragraph],
      discussion: [paragraph, paragraph, paragraph],
      conclusion: [paragraph],
    });
    const firstIdea = {
      output: { type: "research idea", paper: paperBody("The original mechanism.") },
      cot: ["Step one.", "Step two.", "Step three."],
      novelty: "Original novelty claim.",
      literature: [{ title: "Closest work", year: 2024 }],
    };
    const revisedEnvelope = {
      type: "research idea",
      paper: paperBody("The repaired mechanism."),
    };
    const revisedIdea = {
      output: revisedEnvelope,
      cot: ["Step one.", "REVISED step two.", "Step three."],
      novelty: "Revised novelty claim.",
      literature: firstIdea.literature,
    };
    // The journal records exactly as the runner writes them: a commentor's
    // result (under the dispatch-comment CONDITION, so the branch label
    // "else" replaces the node's own wrapper segment) and the redevelopment
    // (under maybe-redevelop, same branch-form key). These key shapes are
    // authoritative — a wrapper-only matcher regressed here once, hiding
    // every comment and revision from the dashboard while runs were fine.
    const commentEntry = {
      key:
        memberPathPrefix +
        "/cotStep[1]/review-round-loop/iter[0]/review-round-body/gather-comments/" +
        "gather-comments-fanout/commentor[0]/" +
        "dispatch-comment/else/comment-step-execute::result",
      kind: "agent",
      value: {
        taskId: "t-comment",
        status: "ok",
        output: {
          verdict: "Interrupt",
          step: 2,
          reason: "The mechanism misattributes its guarantee to the wrong framework.",
          suggestion: "",
          evidence: noEvidence,
        },
      },
    };
    const revisionEntry = {
      key:
        memberPathPrefix +
        "/cotStep[1]/review-round-loop/iter[0]/review-round-body/maybe-redevelop/then/" +
        "redevelop-idea-execute::result",
      kind: "agent",
      value: {
        taskId: "t-revision",
        status: "ok",
        output: {
          output: revisedEnvelope,
          steps: revisedIdea.cot,
          novelty: "Revised novelty claim.",
        },
      },
    };
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "completed",
        input: {},
        journal: [commentEntry, revisionEntry],
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
          // The runtime re-persists the idea after the redevelopment; the
          // first-pass view must stay pinned to the FIRST entry regardless.
          { id: "a-idea-rev", metadata: { schema: "brainIdea", path: "ideas.member-1" } },
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
    writeFileSync(join(sessionDir, "artifacts", "a-idea-rev"), JSON.stringify(revisedIdea));

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

    const firstPassStage = detail.stages.find((candidate) => candidate.id === "first-pass");
    assert.ok(firstPassStage && firstPassStage.id === "first-pass");
    const firstPassIdea = firstPassStage.members.find(
      (member) => member.memberId === "member-1",
    )?.idea;
    assert.ok(firstPassIdea?.paper);
    assert.ok(
      firstPassIdea.paper.method.startsWith("The original mechanism."),
      "the first-pass card keeps the original version",
    );
    assert.equal(firstPassIdea.cot[1], "Step two.");

    const reviewStage = detail.stages.find((candidate) => candidate.id === "review-members");
    assert.ok(reviewStage && reviewStage.id === "review-members");
    const reviewed = reviewStage.members.find((member) => member.memberId === "member-1");
    assert.ok(reviewed, "member-1 has a review view");
    assert.equal(reviewed.revisionCount, 1);
    assert.ok(reviewed.finalIdea?.paper);
    assert.ok(
      reviewed.finalIdea.paper.method.startsWith("The repaired mechanism."),
      "the review view carries the revised envelope as the final version",
    );
    assert.equal(reviewed.finalIdea.cot[1], "REVISED step two.");
    assert.equal(reviewed.finalIdea.novelty, "Revised novelty claim.");
    assert.equal(
      reviewed.finalIdea.literature?.length,
      1,
      "the first pass's literature record rides into the final version",
    );

    const round = reviewed.steps
      .find((step) => step.index === 2)
      ?.rounds.find((candidate) => candidate.round === 1);
    assert.ok(round, "step 2 replays its review round");
    assert.equal(
      round.cot,
      "Step two.",
      "the round shows the text the reviewers actually saw (pre-revision)",
    );
    assert.equal(round.comments.length, 1, "the commentor's interrupt is replayed");
    assert.equal(round.comments[0]?.verdict, "Interrupt");
    assert.ok(round.revision, "the redevelopment is replayed into the round");
    assert.deepEqual([...round.revision.touchedSteps], [2]);
    assert.equal(
      round.revision.rewritten?.[0]?.text,
      "REVISED step two.",
      "the rewritten step's new text rides along for display",
    );

    const untouched = reviewStage.members.find((member) => member.memberId === "member-2");
    assert.equal(untouched?.revisionCount, 0);
    assert.equal(untouched?.finalIdea, undefined, "no first pass, nothing to finalize");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("review view surfaces each member's final version; the first pass stays the original", () => {
  assertReviewReconstruction("brainstorm-root/review-members/member[0]");
});

test("a parallel review's fan-out paths reconstruct the same review view", () => {
  assertReviewReconstruction(
    "brainstorm-root/review-members/review-members-fanout/member[0]",
  );
});

test("every submission type's first-pass output maps to its own view shape", () => {
  const develop = memberIdea(
    firstPass({
      output: {
        type: "research idea",
        paper: {
          abstract: [paragraph, paragraph, paragraph],
          introduction: [paragraph, paragraph, paragraph],
          method: [paragraph, paragraph, paragraph],
          discussion: [paragraph, paragraph, paragraph],
          conclusion: [paragraph],
        },
      },
      cot: [paragraph, paragraph, paragraph],
      novelty: paragraph,
      literature: [{ title: "Closest work", year: 2024 }],
    }),
  );
  assert.equal(develop.type, "research idea");
  assert.equal(develop.shape, "paper");
  assert.ok(develop.paper);
  assert.equal(develop.paper.abstract.split("\n\n").length, 3);
  assert.equal(develop.novelty, paragraph);
  assert.equal(develop.literature?.length, 1);

  const resolve = memberIdea(
    firstPass({
      output: {
        type: "open problem",
        resolution: {
          problemStatement: paragraph,
          knownResults: [
            { result: "A weaker bound.", sourceType: "bound", relation: "Improved here." },
          ],
          approach: paragraph,
          derivation: [paragraph, paragraph],
          verification: { ...noEvidence, kind: "math", derivation: "Re-derive the key step." },
          status: "partial",
          remainingGaps: ["The tight constant is unknown."],
          significance: paragraph,
        },
      },
      cot: [paragraph, paragraph, paragraph],
      novelty: paragraph,
    }),
  );
  assert.equal(resolve.type, "open problem");
  assert.equal(resolve.shape, "resolution");
  assert.equal(resolve.resolution?.status, "partial");
  assert.equal(resolve.resolution?.derivation.length, 2);
  assert.deepEqual(resolve.resolution?.verification, {
    kind: "math",
    derivation: "Re-derive the key step.",
  });
  assert.equal(resolve.resolution?.knownResults[0]?.sourceType, "bound");

  const verify = memberIdea(
    firstPass({
      output: {
        type: "unverified claim",
        verification: {
          claim: "The reported flaw exists.",
          claimSource: "attachments/paper.pdf, section 3",
          verdict: "refuted",
          evidence: {
            ...noEvidence,
            kind: "reference",
            citation: "Doe et al. 2021",
            locator: "https://example.org/doe2021",
            shows: "The derivation holds under the stated assumptions.",
          },
          reasoning: paragraph,
          confidence: { level: "high", rationale: "The reference settles it directly." },
        },
      },
      cot: [paragraph, paragraph, paragraph],
    }),
  );
  assert.equal(verify.type, "unverified claim");
  assert.equal(verify.shape, "verification");
  assert.equal(verify.verification?.verdict, "refuted");
  assert.equal(verify.verification?.evidence?.kind, "reference");
  assert.equal(verify.verification?.confidence.level, "high");
  assert.equal(verify.novelty, undefined, "an unverified claim carries no novelty statement");

  const feasibility = memberIdea(
    firstPass({
      output: {
        type: "research proposal",
        feasibility: {
          designSummary: paragraph,
          importance: paragraph,
          hypothesisLogic: paragraph,
          methodologySoundness: [
            { aspect: "sampling", assessment: "concern", note: "Underpowered for the effect." },
          ],
          replicability: paragraph,
          feasibilityVerdict: "feasible-with-changes",
          requiredChanges: ["Raise the sample size."],
          alternativeDesigns: [],
        },
      },
      cot: [paragraph, paragraph, paragraph],
    }),
  );
  assert.equal(feasibility.type, "research proposal");
  assert.equal(feasibility.shape, "feasibility");
  assert.equal(feasibility.feasibility?.feasibilityVerdict, "feasible-with-changes");
  assert.equal(feasibility.feasibility?.methodologySoundness[0]?.assessment, "concern");

  const critique = memberIdea(
    firstPass({
      output: {
        type: "completed work",
        critique: {
          artifactSummary: paragraph,
          strengths: ["A clear problem statement."],
          issues: [
            {
              description: "The baseline is outdated.",
              severity: "major",
              evidence: noEvidence,
              suggestion: "Compare against a 2023 baseline.",
            },
          ],
          missingConsiderations: [],
          recommendation: "sound-with-revisions",
          prioritizedNextSteps: [{ priority: 1, action: "Add the newer baseline." }],
        },
      },
      cot: [paragraph, paragraph, paragraph],
    }),
  );
  assert.equal(critique.type, "completed work");
  assert.equal(critique.shape, "critique");
  assert.equal(critique.critique?.recommendation, "sound-with-revisions");
  assert.equal(critique.critique?.issues[0]?.severity, "major");
  assert.equal(critique.critique?.issues[0]?.evidence, undefined, "none-kind evidence is omitted");

  const interpret = memberIdea(
    firstPass({
      output: {
        type: "empirical result",
        interpretation: {
          observationSummary: paragraph,
          candidateInterpretations: [
            {
              interpretation: "A measurement artifact.",
              supportingEvidence: "The spike aligns with the sensor swap.",
              contradictingEvidence: "",
              plausibility: "medium",
            },
          ],
          mostLikelyInterpretation: paragraph,
          confidence: { level: "low", rationale: "No replication was possible." },
          threatsToValidity: ["Small sample."],
          implications: "",
        },
      },
      cot: [paragraph, paragraph, paragraph],
    }),
  );
  assert.equal(interpret.type, "empirical result");
  assert.equal(interpret.shape, "interpretation");
  assert.equal(interpret.interpretation?.candidateInterpretations[0]?.plausibility, "medium");
  assert.equal(
    interpret.interpretation?.candidateInterpretations[0]?.contradictingEvidence,
    undefined,
    "empty evidence strings are omitted",
  );
  assert.equal(interpret.interpretation?.implications, undefined, "empty implications are omitted");

  const survey = memberIdea(
    firstPass({
      output: {
        type: "research area",
        survey: {
          landscapeMap: [
            {
              name: "Diffusion-based methods",
              works: [{ title: "A Diffusion Survey", year: 2023 }],
              characterization: paragraph,
            },
          ],
          comparisonTable: [{ dimension: "Scalability", comparison: "A scales; B does not." }],
          consensusAndFrontier: paragraph,
          openGaps: ["3D generalization."],
          recommendation: "Use approach A for this setting.",
        },
      },
      cot: [paragraph, paragraph, paragraph],
      novelty: paragraph,
    }),
  );
  assert.equal(survey.type, "research area");
  assert.equal(survey.shape, "survey");
  assert.equal(survey.survey?.landscapeMap[0]?.works[0]?.title, "A Diffusion Survey");
  assert.equal(survey.survey?.comparisonTable.length, 1);
  assert.equal(survey.survey?.recommendation, "Use approach A for this setting.");

  const explain = memberIdea(
    firstPass({
      output: {
        type: "established concept",
        explanation: {
          motivatingQuestion: paragraph,
          coreIntuition: paragraph,
          formalTreatment: paragraph,
          workedExample: paragraph,
          commonMisconceptions: [
            { misconception: "It always converges.", correction: "Only under a bounded step size." },
          ],
          connections: ["Gradient descent"],
        },
      },
      cot: [paragraph, paragraph, paragraph],
    }),
  );
  assert.equal(explain.type, "established concept");
  assert.equal(explain.shape, "explanation");
  assert.equal(explain.explanation?.commonMisconceptions.length, 1);
  assert.equal(explain.explanation?.connections[0], "Gradient descent");
});

test("pre-shape artifacts with a flat paper output still map as a legacy paper", () => {
  const legacy = memberIdea(
    firstPass({
      output: {
        abstract: [paragraph, paragraph, paragraph],
        introduction: [paragraph, paragraph, paragraph],
        method: [paragraph, paragraph, paragraph],
        discussion: [paragraph, paragraph, paragraph],
        conclusion: [paragraph],
      },
      cot: [paragraph, paragraph, paragraph],
      novelty: paragraph,
    }),
  );
  // Legacy artifacts predate catalog labels, so the shape id stands in as the label.
  assert.equal(legacy.type, "paper");
  assert.equal(legacy.shape, "paper");
  assert.ok(legacy.paper);
  assert.equal(legacy.novelty, paragraph);
});

test("a mismatched or malformed type body yields no idea view instead of wrong content", () => {
  const stage = firstPass({
    output: { type: "unverified claim", verification: { claim: "missing the rest" } },
    cot: [paragraph],
  });
  const member = stage.members.find((candidate) => candidate.memberId === "member-1");
  assert.ok(member);
  assert.equal(member.idea, undefined);
});

test("the activity cap evicts plain progress ticks before capability rows", () => {
  const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "completed",
        input: {},
        journal: [],
        pendingGates: [],
        seq: 1,
        updatedAt: Date.now(),
      }),
    );
    writeFileSync(join(sessionDir, "artifacts", "index.json"), JSON.stringify({ refs: [] }));

    // Ten early tool calls, then a long tail of icon-less heartbeats — the
    // review-phase shape that used to flush every capability row out of the
    // 200-entry window by the time the run finished.
    const path = "brainstorm-root/review-members/member[0]";
    const lines: string[] = [];
    let seq = 0;
    for (let i = 0; i < 10; i += 1) {
      seq += 1;
      lines.push(
        JSON.stringify({
          type: "agent:progress",
          seq,
          at: seq,
          path,
          progress: { kind: "tool", message: `read attachment ${i}`, toolName: "Read" },
        }),
      );
    }
    for (let i = 0; i < 400; i += 1) {
      seq += 1;
      lines.push(
        JSON.stringify({
          type: "agent:progress",
          seq,
          at: seq,
          path,
          progress: { kind: "model", message: "thinking", elapsedMs: 1000 },
        }),
      );
    }
    writeFileSync(join(jobDir, "events.jsonl"), lines.join("\n") + "\n");

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
    assert.ok(review);
    const activity = review.activity ?? [];
    assert.equal(activity.length, 200, "the cap still bounds the feed");
    const withCapability = activity.filter((entry) => entry.capability !== undefined);
    assert.equal(
      withCapability.length,
      10,
      "every capability row outlives the heartbeat flood",
    );
    // Chronology holds: survivors stay in event order, ending at the newest tick.
    const ids = activity.map((entry) => Number(entry.id));
    assert.deepEqual([...ids].sort((a, b) => a - b), ids);
    assert.equal(ids[ids.length - 1], 410);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the woven interdisciplinary seat surfaces in every panel view (latest panel artifact wins)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "completed",
        input: {},
        journal: [],
        pendingGates: [],
        seq: 1,
        updatedAt: Date.now(),
      }),
    );
    // The runtime persists the panel TWICE under one path: panel.select's
    // seating first, then panel.weave's replacement carrying the woven
    // interdisciplinary seat. The views must read the latter.
    writeFileSync(
      join(sessionDir, "artifacts", "index.json"),
      JSON.stringify({
        refs: [
          { id: "a-panel-selected", metadata: { schema: "panel", path: "panel" } },
          { id: "a-panel-woven", metadata: { schema: "panel", path: "panel" } },
          { id: "a-idea", metadata: { schema: "brainIdea", path: "ideas.member-3" } },
        ],
      }),
    );
    const seated = [
      { id: "member-1", department: "Physics", umbrella: "Quantum Optics", subfields: [] },
      { id: "member-2", department: "Biology", umbrella: "Systems Biology", subfields: [] },
    ];
    const woven = {
      id: "member-3",
      department: "Interdisciplinary Research",
      umbrella: "the interdisciplinary space between Quantum Optics and Systems Biology",
      subfields: [],
    };
    writeFileSync(
      join(sessionDir, "artifacts", "a-panel-selected"),
      JSON.stringify({ members: seated }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "a-panel-woven"),
      JSON.stringify({ members: [...seated, woven] }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "a-idea"),
      JSON.stringify({
        output: {
          type: "research idea",
          paper: {
            abstract: [paragraph, paragraph, paragraph],
            introduction: [paragraph, paragraph, paragraph],
            method: [paragraph, paragraph, paragraph],
            discussion: [paragraph, paragraph, paragraph],
            conclusion: [paragraph],
          },
        },
        cot: ["Step one.", "Step two.", "Step three."],
      }),
    );

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

    const select = detail.stages.find((candidate) => candidate.id === "select-panel");
    assert.ok(select && select.id === "select-panel");
    assert.ok(select.panel, "the seating view is present");
    assert.deepEqual(
      select.panel.map((member) => member.id),
      ["member-1", "member-2", "member-3"],
      "the seating view carries the woven seat",
    );

    const firstPassStage = detail.stages.find((candidate) => candidate.id === "first-pass");
    assert.ok(firstPassStage && firstPassStage.id === "first-pass");
    const wovenFirstPass = firstPassStage.members.find(
      (member) => member.memberId === "member-3",
    );
    assert.ok(wovenFirstPass, "the woven seat has a first-pass card");
    assert.equal(wovenFirstPass.status, "completed");
    assert.ok(wovenFirstPass.idea?.paper, "its idea maps to a view");

    const review = detail.stages.find((candidate) => candidate.id === "review-members");
    assert.ok(review && review.id === "review-members");
    assert.deepEqual(
      review.members.map((member) => member.memberId),
      ["member-1", "member-2", "member-3"],
      "the review matrix carries the woven seat",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("live per-seat progress is derived from parallel fan-out event paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "running",
        input: {},
        journal: [],
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
    writeFileSync(
      join(sessionDir, "artifacts", "a-idea"),
      JSON.stringify({
        output: {
          type: "research idea",
          paper: {
            abstract: [paragraph, paragraph, paragraph],
            introduction: [paragraph, paragraph, paragraph],
            method: [paragraph, paragraph, paragraph],
            discussion: [paragraph, paragraph, paragraph],
            conclusion: [paragraph],
          },
        },
        cot: ["Step one.", "Step two.", "Step three."],
      }),
    );

    // The seat's walk is mid-flight: the stage node and one deep comment task
    // have started and nothing has completed. Paths carry the parallel
    // topology's fan-out segment.
    const commentPath =
      "brainstorm-root/review-members/review-members-fanout/member[0]/" +
      "review-steps/cotStep[1]/review-round/review-round-loop/iter[0]/" +
      "review-round-iteration/review-round-body/gather-comments/" +
      "gather-comments-fanout/commentor[0]/dispatch-comment/else/comment-step";
    const events = [
      { type: "node:started", seq: 1, at: 1, path: "brainstorm-root/review-members", kind: "sequence" },
      { type: "node:started", seq: 2, at: 2, path: commentPath, kind: "sequence" },
    ];
    writeFileSync(
      join(jobDir, "events.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );

    const record: JobRecord = {
      jobId: "job-1",
      topic: "topic",
      status: "running",
      runner: "local",
      createdAt: 1,
      updatedAt: 2,
    };
    const detail = buildJobDetail({
      record,
      status: "running",
      sessionDir,
      jobDir,
      settings,
    });
    const review = detail.stages.find((candidate) => candidate.id === "review-members");
    assert.ok(review && review.id === "review-members");
    const seat = review.members.find((member) => member.memberId === "member-1");
    assert.ok(seat, "member-1 has a review view");
    assert.deepEqual(seat.progress, {
      step: 2,
      stepCount: 3,
      round: 1,
      phase: "commenting",
    });
    const idle = review.members.find((member) => member.memberId === "member-2");
    assert.equal(idle?.progress, undefined, "the seat without events carries no progress");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
