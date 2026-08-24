import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { FirstPassStage, ServerSettings } from "@brainstorm-agentic/protocol";

import type { JobRecord } from "../src/model.js";
import { buildJobDetail, editRoundIndex } from "../src/stage-mapper.js";

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
 *
 * `delivery: "patch-parts"` swaps the RECORDED shape rather than the topology:
 * the chain becomes four-part steps, the comment carries a flaw list instead
 * of a scalar step, and the patch names parts instead of text. Every assertion
 * below is shared, so the projection cannot be branching on the app version —
 * one journal is all a run pinned to an old bundle ever writes, and the other
 * is all a part-aware run ever writes.
 */
function assertReviewReconstruction(
  memberPathPrefix: string,
  delivery: "full" | "patch" | "patch-standing-novelty" | "patch-parts" = "full",
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
    // How this run writes a chain step. A run recorded before the chain had
    // parts writes one string; a part-aware run writes four parts. Both are
    // built from the same sentence so every assertion can be shared.
    const parts = delivery === "patch-parts";
    const ideaSchema = parts ? "brainIdeaParts" : "brainIdea";
    const step = (text: string): unknown =>
      parts
        ? { part1: text, part2: "Second part.", part3: "Third part.", part4: "Fourth part." }
        : text;
    const firstIdea = {
      output: { type: "research idea", paper: paperBody("The original mechanism.") },
      cot: ["Step one.", "Step two.", "Step three."].map(step),
      novelty: "Original novelty claim.",
      literature: [{ title: "Closest work", year: 2024 }],
    };
    const revisedEnvelope = {
      type: "research idea",
      paper: paperBody("The repaired mechanism."),
    };
    // A patch names `novelty` only when the repair actually moved the claim.
    // When it does not, the first pass's claim still stands and the runtime
    // records it on the revised idea — so the replay must reach the same
    // claim rather than dropping it. `finalNovelty` is therefore both what
    // the recorded artifact carries and what the review view must show.
    const movesNovelty = delivery !== "patch-standing-novelty";
    const finalNovelty = movesNovelty
      ? "Revised novelty claim."
      : "Original novelty claim.";
    const revisedIdea = {
      output: revisedEnvelope,
      cot: ["Step one.", "REVISED step two.", "Step three."].map(step),
      novelty: finalNovelty,
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
        // The two review records, whole. A part-aware comment carries a flaw
        // list and NO top-level step; a string-chain comment carries the step
        // and no flaws. Neither is a fallback for the other, so the fixtures
        // never carry both at once. `part2: ""` is a stray empty the prune
        // would have removed — the reader must drop it rather than render a
        // blank block for a part the reviewer said nothing about.
        output: parts
          ? {
              verdict: "Interrupt",
              reason: "The mechanism misattributes its guarantee to the wrong framework.",
              flaws: [
                { step: 2, part1: "The guarantee is claimed for the wrong framework.", part2: "" },
              ],
              suggestion: "",
              evidence: noEvidence,
            }
          : {
              verdict: "Interrupt",
              step: 2,
              reason: "The mechanism misattributes its guarantee to the wrong framework.",
              suggestion: "",
              evidence: noEvidence,
            },
      },
    };
    const judgeEntry = {
      key:
        memberPathPrefix +
        "/cotStep[1]/review-round-loop/iter[0]/review-round-body/judge-step/" +
        "judge-step-execute::result",
      kind: "agent",
      value: {
        taskId: "t-judge",
        status: "ok",
        output: {
          verdict: "Build",
          reason: "The commentor's objection stands and the step has to name its framework.",
          suggestion: "Name the framework the guarantee actually comes from.",
          evidence: noEvidence,
          assessment: [{ commentorId: "member-2", basis: "authority" }],
          // `issues` is the repair signal in BOTH shapes; a part-aware issue
          // adds the locator, and `flaws` is the judge's own marks beside it.
          issues: [
            {
              step: 2,
              ...(parts ? { part: "part1" } : {}),
              point: "The step attributes its guarantee to a framework that does not give it.",
              basis: "authority",
              mustAddress: true,
              suggestion: "Name the framework the guarantee actually comes from.",
              evidence: noEvidence,
            },
          ],
          ...(parts
            ? { flaws: [{ step: 2, part1: "The framework named here is the wrong one." }] }
            : {}),
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
          delivery === "full"
            ? {
                output: revisedEnvelope,
                steps: revisedIdea.cot,
                novelty: "Revised novelty claim.",
              }
            : {
                // A patched step is always the WHOLE new step: its text on a
                // string chain, all four parts on a part-aware one — never a
                // single part, because the part boundaries can move.
                steps: [
                  parts
                    ? { index: 2, ...(step("REVISED step two.") as object) }
                    : { index: 2, text: "REVISED step two." },
                ],
                outputPatch: {
                  paper: { method: ["The repaired mechanism.", paragraph, paragraph] },
                },
                ...(movesNovelty ? { novelty: "Revised novelty claim." } : {}),
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
        journal: [commentEntry, judgeEntry, revisionEntry],
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
          // A part-aware run records the very same path under the part-aware
          // schema NAME, so the lookup has to know both names to reach the
          // artifact at all.
          { id: "a-idea", metadata: { schema: ideaSchema, path: "ideas.member-1" } },
          // The runtime re-persists the idea after the redevelopment; the
          // first-pass view must stay pinned to the FIRST entry regardless.
          { id: "a-idea-rev", metadata: { schema: ideaSchema, path: "ideas.member-1" } },
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
    assert.deepEqual(firstPassIdea.cot[1], step("Step two."));

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
    assert.deepEqual(reviewed.finalIdea.cot[1], step("REVISED step two."));
    assert.equal(
      reviewed.finalIdea.novelty,
      finalNovelty,
      "the review view's novelty is the one the recorded idea carries",
    );
    assert.equal(
      reviewed.finalIdea.literature?.length,
      1,
      "the first pass's literature record rides into the final version",
    );

    const round = reviewed.steps
      .find((step) => step.index === 2)
      ?.rounds.find((candidate) => candidate.round === 1);
    assert.ok(round, "step 2 replays its review round");
    assert.deepEqual(
      round.cot,
      step("Step two."),
      "the round shows the step the reviewers actually saw (pre-revision)",
    );
    assert.equal(round.comments.length, 1, "the commentor's interrupt is replayed");
    assert.equal(round.comments[0]?.verdict, "Interrupt");
    assert.equal(round.decision?.verdict, "Build", "the judge's decision is replayed");
    assert.equal(round.decision?.issues?.[0]?.step, 2, "the repair signal keeps its step");
    assert.ok(round.revision, "the redevelopment is replayed into the round");
    assert.deepEqual([...round.revision.touchedSteps], [2]);
    assert.deepEqual(
      round.revision.rewritten?.[0]?.text,
      step("REVISED step two."),
      "the rewritten step's new content rides along for display",
    );

    // The two review records stay TELLABLE APART. A part-aware review carries
    // flaw lists and a part locator; a string-chain review carries a scalar
    // step and neither. Reading one as a fallback for the other would make a
    // run from before the parts look like a review that faulted nothing.
    const comment = round.comments[0]!;
    if (parts) {
      assert.equal(comment.step, undefined, "a part-aware comment has no top-level step");
      assert.deepEqual(
        comment.flaws,
        [{ step: 2, part1: "The guarantee is claimed for the wrong framework." }],
        "the comment's flaws project with the stray empty part dropped",
      );
      assert.equal(round.decision?.issues?.[0]?.part, "part1");
      assert.deepEqual(
        round.decision?.flaws,
        [{ step: 2, part1: "The framework named here is the wrong one." }],
        "the judge's own marks ride beside its repair signal",
      );
    } else {
      assert.equal(comment.step, 2, "a string-chain comment carries the scalar step");
      assert.equal(comment.flaws, undefined, "and no flaw list at all");
      assert.equal(round.decision?.issues?.[0]?.part, undefined);
      assert.equal(round.decision?.flaws, undefined);
    }

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

test("a four-part run's journal replays through the very same reconstruction", () => {
  // The whole point of the union: one projection, two recorded shapes. This
  // fixture is a run whose chain is four-part objects, whose comment carries a
  // flaw list instead of a scalar step, and whose patch names parts — and it
  // reaches every assertion the string-chain fixtures reach. The projection
  // reads the record, so a run pinned to a bundle from before the parts and a
  // run pinned to one after it both keep rendering, forever.
  assertReviewReconstruction(
    "brainstorm-root/review-members/review-members-fanout/member[0]",
    "patch-parts",
  );
});

test("a patch that leaves the novelty claim standing keeps it in the final version", () => {
  // The common revision: the repair moves a step and a section, and the
  // reviser correctly omits `novelty` because the claim still holds. The
  // claim lives on the idea beside `output`, never inside the envelope, so
  // a replay that looks for it in the envelope finds nothing and drops it —
  // from the review inspector AND from the seat's .tex export.
  assertReviewReconstruction(
    "brainstorm-root/review-members/review-members-fanout/member[0]",
    "patch-standing-novelty",
  );
});

test("a later patch inherits the novelty an earlier round moved, not the first pass's", () => {
  // Two rounds at one walk position: round 1 moves the claim, round 2 leaves
  // it standing. The base each patch merges over is the version the PREVIOUS
  // round left, so the surviving claim is round 1's — reseeding from the
  // first pass every round would silently roll the claim back.
  const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });

    const body = (method: string) => ({
      abstract: [paragraph, paragraph, paragraph],
      introduction: [paragraph, paragraph, paragraph],
      method: [method, paragraph, paragraph],
      discussion: [paragraph, paragraph, paragraph],
      conclusion: [paragraph],
    });
    const roundPath = (round: number) =>
      "brainstorm-root/review-members/review-members-fanout/member[0]" +
      `/cotStep[1]/review-round-loop/iter[${round}]/review-round-body/maybe-redevelop/then/` +
      "redevelop-idea-execute::result";

    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "completed",
        input: {},
        journal: [
          {
            key: roundPath(0),
            kind: "agent",
            value: {
              taskId: "t-r1",
              status: "ok",
              output: {
                steps: [{ index: 2, text: "Step two, first repair." }],
                novelty: "Round one's sharpened claim.",
              },
            },
          },
          {
            key: roundPath(1),
            kind: "agent",
            value: {
              taskId: "t-r2",
              status: "ok",
              // No novelty: this repair left the standing claim alone.
              output: {
                steps: [{ index: 2, text: "Step two, second repair." }],
                outputPatch: { paper: { method: ["A further repair.", paragraph, paragraph] } },
              },
            },
          },
        ],
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
        output: { type: "research idea", paper: body("The original mechanism.") },
        cot: ["Step one.", "Step two.", "Step three."],
        novelty: "The first pass's claim.",
        literature: [],
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
    const stage = detail.stages.find((candidate) => candidate.id === "review-members");
    assert.ok(stage && stage.id === "review-members");
    const reviewed = stage.members.find((member) => member.memberId === "member-1");
    assert.equal(reviewed?.revisionCount, 2);
    assert.equal(
      reviewed?.finalIdea?.novelty,
      "Round one's sharpened claim.",
      "round two inherits round one's claim instead of reverting to the first pass",
    );
    assert.equal(reviewed?.finalIdea?.cot[1], "Step two, second repair.");
    assert.ok(
      reviewed?.finalIdea?.paper?.method.startsWith("A further repair."),
      "the envelope carries both rounds' section repairs",
    );
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

test("a tool span is ONE row: the start's line gains outcome, elapsed, and detail", () => {
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

    const path = "brainstorm-root/review-members/member[0]";
    const progress = (at: number, body: object) =>
      JSON.stringify({ type: "agent:progress", seq: at, at, path, progress: body });
    const lines = [
      // 0+1: a read that succeeds — the end carries the measured elapsed and
      // the call detail some executors only attach on the finish.
      progress(0, { kind: "tool_start", message: "Reading an input file — a.pdf", toolName: "Read" }),
      progress(1, {
        kind: "tool_end",
        message: "File read finished",
        toolName: "Read",
        elapsedMs: 1200,
        data: { detail: { kind: "path", value: "a.pdf" } },
      }),
      // 2+3: a read the permission hook refused.
      progress(2, { kind: "tool_start", message: "Reading an input file — b.pdf", toolName: "Read" }),
      progress(3, { kind: "tool_end", message: "File read failed", toolName: "Read", failed: true }),
      // 4: a command still running when the log ends — no outcome.
      progress(4, { kind: "tool_start", message: "Running a command", toolName: "Bash" }),
      // 5: a finish with no start in the log (rotation) — stands alone.
      progress(5, { kind: "tool_end", message: "Search finished", toolName: "Grep", elapsedMs: 5 }),
    ];
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
    // Six events, four rows: each pair folded into its start's line.
    assert.deepEqual(activity.map((entry) => Number(entry.id)), [0, 2, 4, 5]);
    assert.equal(review.activityTotal, 4);
    assert.equal(review.activityFloor, "0");

    const read = activity[0]!;
    assert.equal(read.kind, "tool_start", "the row stays the start's row");
    assert.equal(read.message, "Reading an input file — a.pdf");
    assert.equal(read.outcome, "finished");
    assert.equal(read.elapsedMs, 1200, "the end's measured elapsed lands on the row");
    assert.equal(read.detail?.value, "a.pdf", "so does the end-only call detail");
    assert.ok(
      !activity.some((entry) => entry.message === "File read finished"),
      "no second 'finished' line exists",
    );

    assert.equal(activity[1]!.outcome, "failed");
    assert.equal(activity[1]!.elapsedMs, 1, "without a measured elapsed, the span's own clock serves");
    assert.equal(activity[2]!.outcome, undefined, "still running reads as no outcome");
    // The orphan finish keeps its own kind and its outcome.
    assert.equal(activity[3]!.kind, "tool_end");
    assert.equal(activity[3]!.outcome, "finished");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an agent task is one row, and a long span re-enters the window as a late edit", () => {
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

    // One agent whose task outlives the whole embedded window: it starts at
    // event 0, works through 250 model turns, and completes at the end.
    const path = "brainstorm-root/review-members/member[0]";
    const lines: string[] = [
      JSON.stringify({
        type: "agent:started",
        seq: 0,
        at: 0,
        path,
        taskId: "t1",
        taskKind: "brainstorm.commentor",
      }),
    ];
    for (let i = 1; i <= 250; i += 1) {
      lines.push(
        JSON.stringify({
          type: "agent:progress",
          seq: i,
          at: i,
          path,
          progress: { kind: "model", message: `turn ${i}` },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        type: "agent:completed",
        seq: 251,
        at: 251,
        path,
        taskId: "t1",
        taskKind: "brainstorm.commentor",
        status: "ok",
        usage: { inputTokens: 5, outputTokens: 7 },
      }),
    );
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
    // 252 events, 251 rows total (the completion edited the start's row); the
    // window is the newest 200 of them PLUS the edited row riding along ahead
    // of its gap-free floor.
    assert.equal(review.activityTotal, 251);
    assert.equal(review.activityFloor, "51");
    assert.equal(activity.length, 201);

    const agent = activity[0]!;
    assert.equal(agent.id, "0", "the late edit is the task's own original row");
    assert.equal(agent.message, "commentor agent", "'started' no longer suits a span that ended");
    assert.equal(agent.outcome, "finished");
    assert.equal(agent.elapsedMs, 251, "the span's own clock is the task's duration");
    assert.equal(agent.usage?.inputTokens, 5, "the completion's spend lands on the row");
    assert.ok(
      !activity.some((entry) => entry.message === "commentor agent completed"),
      "no second 'completed' line exists",
    );
    // Above the floor the window is gap-free and chronological.
    assert.equal(activity[1]!.id, "51");
    assert.equal(activity[activity.length - 1]!.id, "250");
    const ids = activity.map((entry) => Number(entry.id));
    assert.deepEqual([...ids].sort((a, b) => a - b), ids);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a failed agent's one row says failed", () => {
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
    const path = "brainstorm-root/first-pass/member[0]/develop-idea";
    writeFileSync(
      join(jobDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "agent:started",
          seq: 0,
          at: 10,
          path,
          taskId: "t1",
          taskKind: "brainstorm.brain",
        }),
        JSON.stringify({
          type: "agent:completed",
          seq: 1,
          at: 25,
          path,
          taskId: "t1",
          taskKind: "brainstorm.brain",
          status: "error",
        }),
      ].join("\n") + "\n",
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
    const stage = detail.stages.find((candidate) => candidate.id === "first-pass");
    assert.ok(stage);
    const activity = stage.activity ?? [];
    assert.equal(activity.length, 1);
    assert.equal(activity[0]!.message, "brain agent");
    assert.equal(activity[0]!.outcome, "failed");
    assert.equal(activity[0]!.elapsedMs, 15);
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

test("a dismissed seat keeps its whole record and leaves the review to the seats still in it", () => {
  const paper = {
    abstract: [paragraph, paragraph, paragraph],
    introduction: [paragraph, paragraph, paragraph],
    method: [paragraph, paragraph, paragraph],
    discussion: [paragraph, paragraph, paragraph],
    conclusion: [paragraph],
  };
  /** One seat's branch in a parallel review walk. */
  const seat = (index: number) =>
    `brainstorm-root/review-members/review-members-fanout/member[${index}]`;
  const judgePass = (index: number) => ({
    key:
      `${seat(index)}/cotStep[0]/review-round-loop/iter[0]/review-round-body/` +
      "judge-step/judge-step-execute::result",
    kind: "agent",
    value: {
      taskId: `t-judge-${index}`,
      status: "ok",
      output: {
        verdict: "Pass",
        reason: "The step holds.",
        assessment: [{ commentorId: "member-1", basis: "authority" }],
      },
    },
  });
  // Seat 1's only recorded round: a commentor interrupted it and no judge ever
  // decided, because the dismissal stopped the walk mid-round. That is the
  // realistic shape — a dismissed seat's walk is cut off wherever it stood.
  const interruptOfSeat1 = {
    key:
      `${seat(0)}/cotStep[0]/review-round-loop/iter[0]/review-round-body/` +
      "gather-comments/gather-comments-fanout/commentor[0]/" +
      "dispatch-comment/else/comment-step-execute::result",
    kind: "agent",
    value: {
      taskId: "t-comment",
      status: "ok",
      output: {
        verdict: "Interrupt",
        step: 1,
        reason: "The mechanism assumes the very thing it sets out to show.",
        suggestion: "",
        evidence: noEvidence,
      },
    },
  };

  /**
   * The same in-flight run built twice — once with member-1 dismissed and once
   * without. Everything else is identical, so every difference below is the
   * dismissal's doing and nothing else's.
   */
  const detailFor = (dismissed: boolean) => {
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
          // Still running: a completed checkpoint would report every stage
          // complete on its own and prove nothing about the review's own count.
          status: "running",
          input: {},
          journal: [interruptOfSeat1, judgePass(1), judgePass(2)],
          pendingGates: [],
          seq: 1,
          updatedAt: 1_000,
        }),
      );
      writeFileSync(
        join(sessionDir, "artifacts", "index.json"),
        JSON.stringify({
          refs: [
            { id: "a-panel", metadata: { schema: "panel", path: "panel" } },
            { id: "a-idea-1", metadata: { schema: "brainIdea", path: "ideas.member-1" } },
            { id: "a-idea-2", metadata: { schema: "brainIdea", path: "ideas.member-2" } },
            { id: "a-idea-3", metadata: { schema: "brainIdea", path: "ideas.member-3" } },
          ],
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
      for (const index of [1, 2, 3]) {
        writeFileSync(
          join(sessionDir, "artifacts", `a-idea-${index}`),
          JSON.stringify({
            output: { type: "research idea", paper },
            cot: [`Seat ${index} step one.`],
            novelty: `Seat ${index}'s claim.`,
          }),
        );
      }
      const record: JobRecord = {
        jobId: "job-1",
        topic: "topic",
        status: "running",
        runner: "local",
        createdAt: 1,
        updatedAt: 2,
        ...(dismissed
          ? {
              dismissedMembers: ["member-1"],
              dismissedAt: { "member-1": 1_700_000_000_000 },
            }
          : {}),
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

  const detail = detailFor(true);
  assert.deepEqual(detail.dismissedMembers, [
    { memberId: "member-1", label: "Quantum Optics", at: 1_700_000_000_000 },
  ]);

  // The seat is MARKED in every view that seats it, never dropped: the views
  // key a seat's first pass, its review coordinates and its token spend by its
  // index in the panel array, so removing one would re-attribute the rest.
  const select = detail.stages.find((stage) => stage.id === "select-panel");
  assert.ok(select && select.id === "select-panel");
  assert.deepEqual(
    select.panel?.map((member) => member.id),
    ["member-1", "member-2", "member-3"],
  );
  assert.equal(select.panel?.[0]?.dismissed?.at, 1_700_000_000_000);
  assert.equal(select.panel?.[1]?.dismissed, undefined);

  const firstPass = detail.stages.find((stage) => stage.id === "first-pass");
  assert.ok(firstPass && firstPass.id === "first-pass");
  const dismissedFirstPass = firstPass.members[0]!;
  assert.equal(dismissedFirstPass.memberId, "member-1");
  assert.equal(dismissedFirstPass.dismissed?.at, 1_700_000_000_000);
  // The dismissal ends the seat's future, not its record: the idea it had
  // already developed is still exactly there, and the card still reads completed.
  assert.equal(dismissedFirstPass.status, "completed");
  assert.equal(
    dismissedFirstPass.idea?.paper?.method.startsWith(paragraph),
    true,
    "the dismissed seat's first-pass idea is still shown in full",
  );
  assert.equal(firstPass.members[1]!.dismissed, undefined);

  const review = detail.stages.find((stage) => stage.id === "review-members");
  assert.ok(review && review.id === "review-members");
  const dismissedReview = review.members[0]!;
  assert.equal(dismissedReview.memberId, "member-1");
  assert.equal(dismissedReview.dismissed?.at, 1_700_000_000_000);
  // Every round the seat did record is still replayed, comments and all.
  const round = dismissedReview.steps[0]?.rounds[0];
  assert.ok(round, "the dismissed seat's round is still in the view");
  assert.equal(round.cot, "Seat 1 step one.");
  assert.deepEqual(
    round.comments.map((comment) => [comment.commentorId, comment.verdict]),
    [["member-2", "Interrupt"]],
  );
  assert.ok(dismissedReview.finalIdea?.paper, "its version as of the dismissal stands");
  // A dismissed seat is not working on anything, so it carries no live
  // position — the seat card must not animate an agent that will never run.
  assert.equal(dismissedReview.progress, undefined);

  // The review completes on the REMAINING seats. Counting the dismissed seat
  // would hold the stage open for the rest of the run, since its walk can
  // never finish.
  assert.equal(review.status, "completed");
  assert.equal(detail.progress?.review?.memberCount, 2);
  assert.equal(detail.progress?.review?.membersComplete, 2);
  assert.equal(detail.progress?.review?.activeSeats, 0);

  // Without the dismissal the very same run is still under review — which is
  // what makes every assertion above the dismissal's doing.
  const undismissed = detailFor(false);
  const stillReviewing = undismissed.stages.find((stage) => stage.id === "review-members");
  assert.ok(stillReviewing && stillReviewing.id === "review-members");
  assert.equal(stillReviewing.status, "active");
  assert.equal(stillReviewing.members[0]!.dismissed, undefined);
  assert.equal(undismissed.progress?.review?.memberCount, 3);
  assert.equal(undismissed.progress?.review?.membersComplete, 2);
  assert.equal(undismissed.dismissedMembers, undefined);
});

test("every activity row says what the agent is, who it is, and where it is working", () => {
  // The three columns the feed shows beside the timestamp. Only the ROLE is
  // carried by the event; the PLACE has to be read out of the execution path,
  // and the ACTOR is in neither — a round's commentors are the panel minus the
  // seat under review, in seat order, so a commentor's fan-out index only
  // becomes a seat once it is projected back over the roster. Getting that
  // projection wrong would attribute one seat's words to another.
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
    // Four seats, so a commentor index and a seat number cannot coincide by luck.
    writeFileSync(
      join(sessionDir, "artifacts", "a-panel"),
      JSON.stringify({
        members: [1, 2, 3, 4].map((n) => ({
          id: `member-${n}`,
          department: "Physics",
          umbrella: `Field ${n}`,
          subfields: [],
        })),
      }),
    );

    // Seat 3 is under review (member[2]), on chain step 5 (cotStep[4]), in
    // review round 2 (iter[1]). Its commentors are seats 1, 2 and 4 in that
    // order, so commentor[2] is SEAT 4 — not seat 3, and not seat 2.
    const reviewPath =
      "brainstorm-root/review-members/review-members-fanout/member[2]/review-steps/cotStep[4]" +
      "/review-round-loop/iter[1]/review-round-body";
    const lines = [
      {
        type: "agent:progress",
        seq: 1,
        at: 1,
        path: `${reviewPath}/gather-comments/gather-comments-fanout/commentor[2]/dispatch-comment/else/comment-step-execute`,
        taskKind: "brainstorm.commentor",
        progress: { kind: "model", message: "reading the chain", turn: 1 },
      },
      {
        type: "agent:progress",
        seq: 2,
        at: 2,
        path: `${reviewPath}/judge-step-execute`,
        taskKind: "brainstorm.judge",
        progress: { kind: "model", message: "weighing the comments" },
      },
      {
        type: "agent:progress",
        seq: 3,
        at: 3,
        path: `${reviewPath}/maybe-redevelop/then/redevelop-idea-execute`,
        taskKind: "brainstorm.redeveloper",
        progress: { kind: "tool", message: "ran a check", toolName: "Bash" },
      },
      {
        type: "agent:progress",
        seq: 4,
        at: 4,
        path: "brainstorm-root/first-pass/first-pass-fanout/member[3]/develop-idea-execute",
        taskKind: "brainstorm.brain",
        progress: { kind: "model", message: "thinking it through" },
      },
      {
        type: "agent:progress",
        seq: 5,
        at: 5,
        path: "brainstorm-root/process-input/process-input-execute",
        taskKind: "brainstorm.processor",
        progress: { kind: "model", message: "structuring the submission" },
      },
    ];
    writeFileSync(
      join(jobDir, "events.jsonl"),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
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
    const rowsOf = (id: string) =>
      detail.stages.find((stage) => stage.id === id)?.activity ?? [];
    const review = rowsOf("review-members");

    const comment = review.find((row) => row.message === "reading the chain");
    assert.deepEqual(
      { role: comment?.role, actor: comment?.actor, where: comment?.where },
      { role: "Commenter", actor: "Seat 4", where: { seat: "Seat 3", step: 5, round: 2 } },
      "a commenter names ITSELF in the actor column and the seat it is reviewing in where",
    );

    const judge = review.find((row) => row.message === "weighing the comments");
    assert.equal(judge?.role, "Judge");
    assert.equal(judge?.actor, undefined, "the judge is not a seat; its role says who it is");
    assert.deepEqual(judge?.where, { seat: "Seat 3", step: 5, round: 2 });

    const redeveloper = review.find((row) => row.message === "ran a check");
    assert.deepEqual(
      { role: redeveloper?.role, actor: redeveloper?.actor, where: redeveloper?.where },
      { role: "Redeveloper", actor: "Seat 3", where: { seat: "Seat 3", step: 5, round: 2 } },
      "a seat revising its own chain is both the actor and the place",
    );

    const thinking = rowsOf("first-pass").find((row) => row.message === "thinking it through");
    assert.deepEqual(
      { role: thinking?.role, actor: thinking?.actor, where: thinking?.where },
      { role: "Thinker", actor: "Seat 4", where: { seat: "Seat 4" } },
      "the first pass has a seat but no step or round yet",
    );

    const processor = rowsOf("process-input").find(
      (row) => row.message === "structuring the submission",
    );
    assert.equal(processor?.role, "Processor", "a pre-panel stage still says what ran");
    assert.equal(processor?.actor, undefined);
    assert.equal(processor?.where, undefined, "and the stage itself is the whole place");

    // The path the annotation was read from is never sent to the client.
    for (const row of [...review, ...rowsOf("first-pass")]) {
      assert.equal(
        (row as unknown as { path?: string }).path,
        undefined,
        "execution paths stay server-side",
      );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the activity feed's round is the edit round, so it agrees with the deck", () => {
  // The two-numbers-disagreeing bug, from the feed's side: the judge was shown
  // working on "step 5 > round 1" while that step's card deck already displayed
  // three edits. An edit is an edit, whoever wrote it, and both surfaces now
  // count the same way — this asserts the rule the deck implements in the client.
  const member = {
    memberId: "member-1",
    label: "Seat 1",
    steps: [
      {
        index: 1,
        outcome: "passed" as const,
        rounds: [
          {
            round: 1,
            comments: [],
            // Position 1's first round rewrites itself AND step 2.
            revision: {
              touchedSteps: [1, 2],
              rewritten: [
                { index: 1, text: "one v1" },
                { index: 2, text: "two, edited from position 1" },
              ],
            },
          },
          {
            round: 2,
            comments: [],
            revision: { touchedSteps: [2], rewritten: [{ index: 2, text: "two, again" }] },
          },
        ],
      },
      {
        index: 2,
        outcome: "under-review" as const,
        rounds: [{ round: 1, comments: [] }],
      },
    ],
  };
  const index = editRoundIndex([member]);
  assert.equal(
    index.get("member-1:1:1"),
    1,
    "a step's own first round is its first edit when nothing touched it before",
  );
  assert.equal(index.get("member-1:1:2"), 2, "and its second round its second");
  assert.equal(
    index.get("member-1:2:1"),
    3,
    "but step 2 was edited twice from position 1, so its own first round is round 3",
  );
});

test("edit rounds count each seat separately", () => {
  const seatWith = (memberId: string, rewrites: number) => ({
    memberId,
    label: memberId,
    steps: [
      {
        index: 1,
        outcome: "passed" as const,
        rounds: Array.from({ length: rewrites }, (_, i) => ({
          round: i + 1,
          comments: [],
          revision: { touchedSteps: [1], rewritten: [{ index: 1, text: `v${i + 1}` }] },
        })),
      },
    ],
  });
  const index = editRoundIndex([seatWith("member-1", 3), seatWith("member-2", 1)]);
  assert.equal(index.get("member-1:1:3"), 3);
  assert.equal(index.get("member-2:1:1"), 1, "one seat's edits never number another's");
  assert.equal(index.get("member-2:1:3"), undefined);
});

test("an llm_call row carries the id of its record, and an older run's rows are untouched", () => {
  // The row is the only thing that reaches the browser about a hand-off: the
  // prompt itself never enters the event log. The id is what turns the row into
  // a link, so a row that lost it would offer a reader a request they cannot
  // open. Every other column comes from the paths that were already there.
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
    const path = "brainstorm-root/first-pass/first-pass-fanout/member[0]/develop-idea-execute";
    const lines = [
      {
        type: "agent:progress",
        seq: 1,
        at: 1,
        path,
        taskKind: "brainstorm.brain",
        progress: {
          kind: "llm_call",
          message: "handed the prompt to the model",
          promptId: "3f0d-record",
          turn: 2,
        },
      },
      // A row written before prompt capture existed: no kind, no id, and it
      // must still render exactly as it did.
      {
        type: "agent:progress",
        seq: 2,
        at: 2,
        path,
        taskKind: "brainstorm.brain",
        progress: { kind: "model", message: "Model reasoning" },
      },
    ];
    writeFileSync(
      join(jobDir, "events.jsonl"),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
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
    const rows = detail.stages.find((stage) => stage.id === "first-pass")?.activity ?? [];

    const call = rows.find((row) => row.kind === "llm_call");
    assert.equal(call?.promptId, "3f0d-record");
    assert.equal(call?.turn, 2);
    assert.equal(call?.role, "Thinker", "the what column comes from the path it always did");

    const old = rows.find((row) => row.kind === "model");
    assert.equal(old?.message, "Model reasoning");
    assert.equal(old?.promptId, undefined, "a row with no record behind it claims none");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * The stage-transition hop: a gate is answered, its resume sits in the
 * scheduler queue, and the checkpoint on disk still says "suspended with a
 * pending gate". The dashboard must show one continuous run through that
 * window — recorded stages stand, the answered gate reads decided from the
 * record, and no card is re-offered. Erasing every stage to "pending" here
 * is what used to flash the whole dashboard blank on every routine
 * transition.
 */
test("a queued gate resume keeps recorded stages and shows the decision, not the machinery", () => {
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
        status: "suspended",
        input: {},
        journal: [],
        pendingGates: [
          {
            gateKey: "confirm-panel",
            journalKey: "brainstorm-root/confirm-panel/confirm-panel-wait::response",
            path: "brainstorm-root/confirm-panel/confirm-panel-wait",
          },
        ],
        seq: 3,
        updatedAt: Date.now(),
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "index.json"),
      JSON.stringify({
        refs: [
          {
            id: "a-processor",
            metadata: { schema: "processorOutput", path: "input" },
          },
          { id: "a-panel", metadata: { schema: "panel", path: "panel" } },
        ],
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "a-processor"),
      JSON.stringify({
        type: "research idea",
        title: "t",
        question: "q",
        context: "c",
        attachments: [],
        assumptions: [],
        cotSteps: 4,
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

    const record: JobRecord = {
      jobId: "job-1",
      topic: "topic",
      status: "queued",
      runner: "local",
      createdAt: 1,
      updatedAt: 2,
      gateAnswer: {
        gateKey: "confirm-panel",
        action: "approve",
        addedMembers: [
          { department: "Math", umbrella: "Topology", subfields: ["knots"] },
        ],
        at: 3,
      },
    };
    const detail = buildJobDetail({
      record,
      status: "queued",
      sessionDir,
      jobDir,
      // A suspended gate only exists under manual confirmation — auto mode
      // compiles the gate away in the worker and never suspends.
      settings: { ...settings, panelConfirmation: "manual" },
    });

    const byId = new Map(detail.stages.map((stage) => [stage.id, stage]));
    assert.equal(byId.get("process-input")?.status, "completed");
    assert.equal(byId.get("select-panel")?.status, "completed");
    const confirm = byId.get("confirm-panel");
    assert.ok(confirm && confirm.id === "confirm-panel");
    assert.equal(confirm.status, "completed");
    assert.equal(confirm.gate.state, "approved");
    assert.deepEqual(confirm.gate.addedMemberIds, ["member-user-1"]);
    assert.equal(detail.pendingGate, undefined, "an answered gate offers no card");
    const firstPass = byId.get("first-pass");
    assert.ok(firstPass && firstPass.id === "first-pass");
    assert.deepEqual(
      firstPass.members.map((member) => member.memberId),
      ["member-1", "member-2", "member-user-1"],
      "the confirmed panel — kept plus added — renders while the resume waits",
    );
    assert.ok((detail.progress?.completedStages ?? 0) >= 3);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a queued classification revise shows the revised reading while the resume waits", () => {
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
        status: "suspended",
        input: {},
        journal: [],
        pendingGates: [
          {
            gateKey: "confirm-classification",
            journalKey:
              "brainstorm-root/confirm-classification/confirm-classification-wait::response",
            path: "brainstorm-root/confirm-classification/confirm-classification-wait",
          },
        ],
        seq: 2,
        updatedAt: Date.now(),
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "index.json"),
      JSON.stringify({
        refs: [
          {
            id: "a-processor",
            metadata: { schema: "processorOutput", path: "input" },
          },
          {
            id: "a-classification",
            metadata: { schema: "taskClassification", path: "classification" },
          },
        ],
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "a-processor"),
      JSON.stringify({
        type: "research idea",
        title: "t",
        question: "q",
        context: "c",
        attachments: [],
        assumptions: [],
        cotSteps: 4,
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "a-classification"),
      JSON.stringify({
        primary: { type: "research idea", reason: "reads as a sketch" },
        alternative: { type: "open problem", reason: "names a formal target" },
        requestedOutputs: [],
      }),
    );

    const record: JobRecord = {
      jobId: "job-1",
      topic: "topic",
      status: "queued",
      runner: "local",
      createdAt: 1,
      updatedAt: 2,
      gateAnswer: {
        gateKey: "confirm-classification",
        action: "revise",
        type: "open problem",
        at: 3,
      },
    };
    const detail = buildJobDetail({
      record,
      status: "queued",
      sessionDir,
      jobDir,
      settings,
    });

    const stage = detail.stages.find((candidate) => candidate.id === "process-input");
    assert.ok(stage && stage.id === "process-input");
    assert.equal(stage.status, "completed");
    assert.equal(stage.classification?.gate.state, "revised");
    assert.equal(stage.classification?.gate.chosenType, "open problem");
    assert.equal(
      stage.output?.type,
      "open problem",
      "the revised type mirrors onto the structured input during the hop",
    );
    assert.equal(detail.pendingGate, undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a queued job with nothing recorded stays all-pending", () => {
  const workspace = mkdtempSync(join(tmpdir(), "stage-mapper-test-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    // Stale events from a worker that died before its first checkpoint: the
    // resubmitted job must not read them as live activity while it waits.
    writeFileSync(
      join(jobDir, "events.jsonl"),
      JSON.stringify({
        type: "node:started",
        seq: 1,
        at: 1,
        path: "brainstorm-root/process-input",
        kind: "sequence",
      }) + "\n",
    );
    const record: JobRecord = {
      jobId: "job-1",
      topic: "topic",
      status: "queued",
      runner: "local",
      createdAt: 1,
      updatedAt: 2,
    };
    const detail = buildJobDetail({
      record,
      status: "queued",
      sessionDir,
      jobDir,
      settings,
    });
    assert.ok(detail.stages.every((stage) => stage.status === "pending"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
