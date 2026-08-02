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

test("review view surfaces each member's final version; the first pass stays the original", () => {
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
    // The journal record of the revision: the agent result of the
    // redevelop-idea execute step at member[0], step index 1, round 0.
    const revisionEntry = {
      key:
        "brainstorm-root/review-members/member[0]/review-steps/cotStep[1]/" +
        "review-round/iter[0]/review-round-body/maybe-redevelop/then/" +
        "redevelop-idea/redevelop-idea-execute::result",
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
        journal: [revisionEntry],
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

    const untouched = reviewStage.members.find((member) => member.memberId === "member-2");
    assert.equal(untouched?.revisionCount, 0);
    assert.equal(untouched?.finalIdea, undefined, "no first pass, nothing to finalize");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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
