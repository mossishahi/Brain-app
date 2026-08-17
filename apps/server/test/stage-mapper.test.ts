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
function assertReviewReconstruction(
  memberPathPrefix: string,
  delivery: "full" | "patch" = "full",
): void {
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
        // The two delivery forms a revision can arrive in. Every assertion
        // below is shared: the dashboard must not be able to tell which one
        // produced the round it renders.
        output:
          delivery === "patch"
            ? {
                steps: [{ index: 2, text: "REVISED step two." }],
                outputPatch: {
                  paper: { method: ["The repaired mechanism.", paragraph, paragraph] },
                },
                novelty: "Revised novelty claim.",
              }
            : {
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

test("a revision delivered as a patch replays into exactly the same review view", () => {
  // Same assertions, different delivery: the dashboard applies the patch
  // through the runtime's own merge, so the chain it shows and the final
  // envelope it composes are the ones the run actually recorded.
  assertReviewReconstruction(
    "brainstorm-root/review-members/review-members-fanout/member[0]",
    "patch",
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
    // Chronology holds: survivors stay in event order, ending at the newest
    // tick. Ids are file positions (0-based), never per-attempt seqs.
    const ids = activity.map((entry) => Number(entry.id));
    assert.deepEqual([...ids].sort((a, b) => a - b), ids);
    assert.equal(ids[ids.length - 1], 409);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a resumed run's feed stays chronological — per-attempt seqs never reorder it", () => {
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
    writeFileSync(join(sessionDir, "artifacts", "index.json"), JSON.stringify({ refs: [] }));

    // One job, two attempts in one log: a long attempt whose seq climbed
    // high before it died, then a resume whose seq restarts at 0. Sorting
    // survivors by seq pinned the DEAD attempt's entries to the feed's tail
    // forever — the dashboard then claimed "no new events since 3am" while
    // the resumed run was working live.
    const path = "brainstorm-root/review-members/member[0]";
    const lines: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      lines.push(
        JSON.stringify({
          type: "agent:progress",
          seq: 9000 + i,
          at: 1000 + i,
          path,
          progress: { kind: "model", message: "overnight attempt heartbeat" },
        }),
      );
    }
    lines.push(
      JSON.stringify({ type: "run:started", seq: 0, at: 5000, workflowId: "brainstorm", resumed: true }),
    );
    for (let i = 0; i < 60; i += 1) {
      lines.push(
        JSON.stringify({
          type: "agent:progress",
          seq: 1 + i,
          at: 6000 + i,
          path,
          progress: { kind: "model", message: `resumed heartbeat ${i}` },
        }),
      );
    }
    writeFileSync(join(jobDir, "events.jsonl"), lines.join("\n") + "\n");

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
    assert.ok(review);
    const activity = review.activity ?? [];
    assert.ok(activity.length > 0);
    const last = activity[activity.length - 1]!;
    assert.equal(
      last.message,
      "resumed heartbeat 59",
      "the feed ends at the LIVE attempt's newest entry, not the dead attempt's",
    );
    assert.equal(last.at, 6059);
    // True time order end to end, and unique ids across attempts.
    for (let i = 1; i < activity.length; i += 1) {
      assert.ok(activity[i]!.at >= activity[i - 1]!.at, "chronological order");
    }
    assert.equal(new Set(activity.map((entry) => entry.id)).size, activity.length);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("token spend surfaces at every level: activity rows, seats, comments, stages", () => {
  const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });

    const processPath = "brainstorm-root/process-input/process-input-execute";
    const devPath = (member: number) =>
      `brainstorm-root/first-pass/first-pass-fanout/member[${member}]/develop-idea/develop-idea-execute`;
    const commentPath =
      "brainstorm-root/review-members/review-members-fanout/member[0]/review-steps/" +
      "cotStep[0]/review-round-loop/iter[0]/review-round-body/gather-comments/" +
      "gather-comments-fanout/commentor[0]/dispatch-comment/else/comment-step-execute";

    // The journal carries each successful task's total (the only record OLD
    // runs have). member[0]'s journal total deliberately disagrees with the
    // event-borne attempts below: events must win, because only they see
    // failed attempts.
    const journal = [
      {
        key: `${processPath}::result`,
        kind: "agent",
        value: {
          taskId: `job-1:${processPath}`,
          status: "ok",
          output: {},
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      },
      {
        key: `${devPath(0)}::result`,
        kind: "agent",
        value: {
          taskId: `job-1:${devPath(0)}`,
          status: "ok",
          output: {},
          usage: { inputTokens: 999_999, outputTokens: 999 },
        },
      },
      {
        key: `${devPath(1)}::result`,
        kind: "agent",
        value: {
          taskId: `job-1:${devPath(1)}`,
          status: "ok",
          output: {},
          usage: { inputTokens: 2000, outputTokens: 80, cacheReadInputTokens: 111 },
        },
      },
      {
        key: `${commentPath}::result`,
        kind: "agent",
        value: {
          taskId: `job-1:${commentPath}`,
          status: "ok",
          output: {
            verdict: "Build",
            step: 1,
            reason: "The framing skips the calibration step.",
            suggestion: "",
            evidence: noEvidence,
          },
          usage: { inputTokens: 500, outputTokens: 25 },
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
        journal,
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
    // member-1 needs an idea on record: the review walk sizes its steps from
    // the chain, and a chain-less member reconstructs no rounds to hang the
    // comment (and its spend) on.
    writeFileSync(
      join(sessionDir, "artifacts", "a-idea"),
      JSON.stringify({
        output: {
          type: "research idea",
          paper: {
            abstract: [paragraph],
            introduction: [paragraph],
            method: [paragraph],
            discussion: [paragraph],
            conclusion: [paragraph],
          },
        },
        cot: ["Step one."],
      }),
    );

    // member[0]'s task ran twice: a failed attempt, then the success. Each
    // agent:completed event carries that attempt's own spend.
    const events = [
      {
        type: "agent:completed",
        runId: "job-1",
        seq: 1,
        at: 1000,
        path: devPath(0),
        taskId: `job-1:${devPath(0)}`,
        taskKind: "brainstorm.brain",
        status: "error",
        usage: { inputTokens: 400, outputTokens: 5 },
      },
      {
        type: "agent:completed",
        runId: "job-1",
        seq: 2,
        at: 2000,
        path: devPath(0),
        taskId: `job-1:${devPath(0)}`,
        taskKind: "brainstorm.brain",
        status: "ok",
        usage: { inputTokens: 700, outputTokens: 45 },
      },
    ];
    writeFileSync(
      join(jobDir, "events.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
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

    // 1. Activity rows: each completion row shows THAT attempt's spend —
    //    the failed attempt's included.
    const firstPassStage = detail.stages.find((stage) => stage.id === "first-pass");
    assert.ok(firstPassStage && firstPassStage.id === "first-pass");
    const completionRows = (firstPassStage.activity ?? []).filter(
      (entry) => entry.usage !== undefined,
    );
    assert.deepEqual(
      completionRows.map((entry) => entry.usage),
      [
        { inputTokens: 400, outputTokens: 5 },
        { inputTokens: 700, outputTokens: 45 },
      ],
      "completion rows carry per-attempt usage",
    );

    // 2. Per seat in the first pass: events (which saw both attempts) win
    //    over the journal total; a seat without evented usage falls back to
    //    its journaled total, cache split included.
    const seatUsage = new Map(
      firstPassStage.members.map((member) => [member.memberId, member.usage]),
    );
    assert.deepEqual(seatUsage.get("member-1"), {
      inputTokens: 1100,
      outputTokens: 50,
    });
    assert.deepEqual(seatUsage.get("member-2"), {
      inputTokens: 2000,
      outputTokens: 80,
      cacheReadInputTokens: 111,
    });

    // 3. Per commentor per review round: the comment carries its task's spend.
    const reviewStage = detail.stages.find((stage) => stage.id === "review-members");
    assert.ok(reviewStage && reviewStage.id === "review-members");
    const reviewed = reviewStage.members.find((member) => member.memberId === "member-1");
    const round = reviewed?.steps[0]?.rounds[0];
    assert.ok(round, "the comment's round reconstructs");
    assert.deepEqual(round.comments[0]?.usage, { inputTokens: 500, outputTokens: 25 });

    // 4. Per stage: totals across every task of the stage, fan-outs included.
    const stageUsage = new Map(detail.stages.map((stage) => [stage.id, stage.usage]));
    assert.deepEqual(stageUsage.get("process-input"), {
      inputTokens: 100,
      outputTokens: 10,
    });
    assert.deepEqual(stageUsage.get("first-pass"), {
      inputTokens: 3100,
      outputTokens: 130,
      cacheReadInputTokens: 111,
    });
    assert.deepEqual(stageUsage.get("review-members"), {
      inputTokens: 500,
      outputTokens: 25,
    });
    assert.equal(stageUsage.get("select-panel"), undefined, "no tasks, no chip");
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

test("every root-level workflow node maps to a dashboard stage", async () => {
  const { stageForPath } = await import("../src/stage-mapper.js");
  // The complete root-level node roster of the shipped workflow (bundle
  // 0.18.0) and the stage each node's events surface on. The file-partition
  // trio, the code-annotation condition wrapper, and the panel weave used to
  // map to no stage at all, so their node events (and any failure they
  // carried) rendered without stage attribution. When a bundle release adds a
  // root node, add it here with its stage — an unmapped node is the defect
  // this test exists to catch.
  const rootNodes: Record<string, string> = {
    "process-input": "process-input",
    "classify-input": "process-input",
    "apply-classification": "process-input",
    "confirm-classification": "process-input",
    "partition-files-useful": "decompose-experts",
    "partition-files-ignored": "decompose-experts",
    "partition-files-code": "decompose-experts",
    "maybe-annotate-code": "decompose-experts",
    "build-pool": "decompose-experts",
    "match-taxonomy": "decompose-experts",
    "place-fields": "decompose-experts",
    "submit-decisions": "decompose-experts",
    "bridge-experts": "decompose-experts",
    "select-panel": "select-panel",
    "weave-panel": "select-panel",
    "confirm-panel": "confirm-panel",
    "first-pass": "first-pass",
    "review-members": "review-members",
    "bridge-audit": "bridge-audit",
    "synthesize-proposal": "synthesize-proposal",
    done: "done",
  };
  for (const [node, stage] of Object.entries(rootNodes)) {
    assert.equal(
      stageForPath(`brainstorm-root/${node}`),
      stage,
      `${node} folds into the ${stage} stage`,
    );
  }
  // Nodes nested under the condition wrapper resolve through it.
  assert.equal(
    stageForPath("brainstorm-root/maybe-annotate-code/annotate-code-flow/annotate-code"),
    "decompose-experts",
  );
});

test("the split step strip renders only for runs that actually used the split pipeline", () => {
  // The partition nodes have existed since bundle 0.1.0 — long before the
  // decomposer split landed at 0.9.0 — so their presence in a legacy run's
  // journal must not conjure a step strip of pipeline steps that never ran.
  // Only the split-defining nodes (build-pool … bridge-experts) prove the
  // topology.
  const decomposeFor = (journal: readonly unknown[]) => {
    const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
    try {
      const sessionDir = join(workspace, "session");
      const jobDir = join(workspace, "job");
      mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "artifacts", "index.json"),
        JSON.stringify({ refs: [] }),
      );
      writeFileSync(
        join(sessionDir, "checkpoint.json"),
        JSON.stringify({
          runId: "job-1",
          workflowId: "brainstorm",
          status: "running",
          input: {},
          journal,
          pendingGates: [],
          seq: 1,
          updatedAt: Date.now(),
        }),
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
      const stage = detail.stages.find(
        (candidate) => candidate.id === "decompose-experts",
      );
      assert.ok(stage && stage.id === "decompose-experts");
      return stage;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  };
  const partitions = [
    {
      key: "brainstorm-root/partition-files-useful::result",
      kind: "activity",
      value: { files: [] },
    },
    {
      key: "brainstorm-root/partition-files-ignored::result",
      kind: "activity",
      value: { files: [] },
    },
  ];
  // A legacy single-decomposer run: partitions plus the monolithic node.
  const legacy = decomposeFor([
    ...partitions,
    {
      key: "brainstorm-root/decompose-experts::result",
      kind: "agent",
      value: { taskId: "t", status: "ok", output: {} },
    },
  ]);
  assert.equal(legacy.steps, undefined, "no step strip for a pre-split run");
  // A split run: any split-pipeline node proves the topology.
  const split = decomposeFor([
    ...partitions,
    {
      key: "brainstorm-root/build-pool::result",
      kind: "agent",
      value: {
        taskId: "t",
        status: "ok",
        output: { members: [], grounding: { papers: [], scholars: [] } },
      },
    },
  ]);
  assert.ok(
    Array.isArray(split.steps) && split.steps.length > 0,
    "split runs render the step strip",
  );
});

/**
 * Format-2 journals record a content activity's OUTPUT under its `<id>-run`
 * child instead of a full state copy under the node itself. The view
 * fallbacks (used when the artifact index has not landed yet) must read
 * both layouts.
 */
test("format-2 journal entries back the panel and file-partition views", () => {
  const stageWorkspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(stageWorkspace, "session");
    const jobDir = join(stageWorkspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    const members = [
      { id: "member-1", department: "Physics", umbrella: "Quantum Optics", subfields: ["photonics"] },
      { id: "member-2", department: "Biology", umbrella: "Systems Biology", subfields: [] },
    ];
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "running",
        input: {},
        journalFormat: 2,
        journal: [
          {
            key: "brainstorm-root/partition-files-useful/partition-files-useful-run::result",
            kind: "activity",
            value: { files: [{ path: "a.py", label: "code", note: "the model" }] },
          },
          {
            key: "brainstorm-root/partition-files-ignored/partition-files-ignored-run::result",
            kind: "activity",
            value: { files: [{ path: "b.txt", label: "NA", note: "unrelated" }] },
          },
          {
            key: "brainstorm-root/weave-panel/weave-panel-run::result",
            kind: "activity",
            value: { members },
          },
        ],
        pendingGates: [],
        seq: 1,
        updatedAt: Date.now(),
      }),
    );
    writeFileSync(join(sessionDir, "artifacts", "index.json"), JSON.stringify({ refs: [] }));
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
    const panelStage = detail.stages.find((stage) => stage.id === "select-panel");
    assert.ok(panelStage && panelStage.id === "select-panel");
    assert.deepEqual(
      panelStage.panel?.map((member) => member.id),
      ["member-1", "member-2"],
      "the woven panel is read from the -run entry",
    );
    const processStage = detail.stages.find((stage) => stage.id === "process-input");
    assert.ok(processStage && processStage.id === "process-input");
    assert.equal(processStage.files?.useful[0]?.path, "a.py");
    assert.equal(processStage.files?.ignored[0]?.path, "b.txt");
  } finally {
    rmSync(stageWorkspace, { recursive: true, force: true });
  }
});

/**
 * Parallel-review failure attribution: every seat failure of the current
 * attempt is kept (never replaced by the next one), located (seat, step,
 * round, call), and marked on the failed seat's review view — while a
 * restarted attempt supersedes the whole record.
 */
test("review failures are located per seat and accumulate; a restart clears them", () => {
  const seat2Branch =
    "brainstorm-root/review-members/review-members-fanout/member[1]";
  const seat2Deep =
    `${seat2Branch}/review-members-branch/review-steps/cotStep[1]/review-round/` +
    "review-round-loop/iter[0]/review-round-iteration/review-round-body/judge-step/judge-step-execute";
  const seat3Branch =
    "brainstorm-root/review-members/review-members-fanout/member[2]";
  const seat3Deep =
    `${seat3Branch}/review-members-branch/review-steps/cotStep[0]/review-round/` +
    "review-round-loop/iter[0]/review-round-iteration/review-round-body/gather-comments/" +
    "commentor[1]/dispatch-comment/else/comment-step/comment-step-execute";
  const failure = { name: "RangeError", message: "Invalid string length" };
  const started = (seq: number, at: number, path: string) =>
    ({ type: "node:started", seq, at, path, kind: "sequence" });
  const failed = (seq: number, at: number, path: string) =>
    ({ type: "node:failed", seq, at, path, kind: "sequence", error: failure });

  const detailFor = (events: readonly unknown[]) => {
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
          refs: [{ id: "a-panel", metadata: { schema: "panel", path: "panel" } }],
        }),
      );
      writeFileSync(
        join(sessionDir, "artifacts", "a-panel"),
        JSON.stringify({
          members: [
            { id: "member-1", department: "Physics", umbrella: "Quantum Optics", subfields: [] },
            { id: "member-2", department: "Biology", umbrella: "Systems Biology", subfields: [] },
            { id: "member-3", department: "CS", umbrella: "Machine Learning", subfields: [] },
          ],
        }),
      );
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
      return buildJobDetail({
        record,
        status: "running",
        sessionDir,
        jobDir,
        settings,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  };

  // One attempt: seat 2's judge dies first; seat 3's commentor dies later
  // with the same message. Each failure re-emits node:failed at its branch
  // ancestors (same error object), which must NOT create extra entries.
  const detail = detailFor([
    started(1, 100, "brainstorm-root/review-members"),
    failed(2, 200, seat2Deep),
    failed(3, 200, `${seat2Branch}/review-members-branch`),
    failed(4, 200, seat2Branch),
    failed(5, 300, seat3Deep),
    failed(6, 300, seat3Branch),
  ]);
  const review = detail.stages.find((stage) => stage.id === "review-members");
  assert.ok(review && review.id === "review-members");
  assert.equal(review.status, "failed");
  assert.ok(review.errors, "the located failure list exists");
  assert.equal(review.errors.length, 2, "one entry per real failure, ancestors collapsed");
  assert.equal(review.errors[0]!.message, "Invalid string length");
  assert.equal(
    review.errors[0]!.where,
    "Seat 2 (Systems Biology) · step 2 · round 1 · judge task",
  );
  assert.equal(review.errors[0]!.path, seat2Deep);
  assert.equal(
    review.errors[1]!.where,
    "Seat 3 (Machine Learning) · step 1 · round 1 · commentor Seat 2 (Systems Biology) · commentor task",
  );
  // The failed seats are marked on their review views; the healthy seat is not.
  assert.equal(review.members[0]!.error, undefined);
  assert.equal(review.members[1]!.error, "Invalid string length");
  assert.equal(review.members[2]!.error, "Invalid string length");

  // A resumed attempt replays: the stage node (and the seats) start again,
  // which supersedes the previous attempt's whole failure record.
  const resumed = detailFor([
    started(1, 100, "brainstorm-root/review-members"),
    failed(2, 200, seat2Deep),
    failed(3, 200, `${seat2Branch}/review-members-branch`),
    failed(4, 200, seat2Branch),
    started(5, 400, "brainstorm-root/review-members"),
    started(6, 401, seat2Branch),
  ]);
  const resumedReview = resumed.stages.find((stage) => stage.id === "review-members");
  assert.ok(resumedReview && resumedReview.id === "review-members");
  assert.equal(resumedReview.errors, undefined, "a fresh attempt starts clean");
  assert.equal(resumedReview.members[1]!.error, undefined);
  assert.notEqual(resumedReview.status, "failed");
});
