import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifactSchemas,
  brainIdeaPartsSchema,
  brainIdeaSchema,
  commentPartsSchema,
  commentSchema,
  cotStepPartsSchema,
  evidenceSchema,
  expertsTreeSchema,
  finalProposalSchema,
  ignoredFilesSchema,
  judgeDecisionPartsSchema,
  judgeDecisionSchema,
  mergeRedevelopment,
  mergeRedevelopmentParts,
  panelSchema,
  processorOutputSchema,
  redevelopmentPatchPartsSchema,
  redevelopmentPatchSchema,
  RedevelopmentMergeError,
  redevelopmentSchema,
  usefulFilesSchema,
} from "../src/index.js";

const para = (n: number, text = "Lorem ipsum dolor sit amet.") =>
  Array.from({ length: n }, (_, i) => `${text} (${i + 1})`).join("\n\n");
const section = (n: number, text = "Lorem ipsum dolor sit amet.") =>
  Array.from({ length: n }, (_, i) => `${text} (${i + 1})`);

const validPaperBody = {
  abstract: section(3),
  introduction: section(3),
  method: section(3),
  discussion: section(3),
  conclusion: section(1),
};
// `type` is the catalog label (free-form data); `paper` is the shape key.
const validDevelopedOutput = {
  type: "research idea",
  paper: validPaperBody,
};
const noEvidence = {
  kind: "none" as const,
  code: "",
  result: "",
  derivation: "",
  citation: "",
  locator: "",
  shows: "",
};

test("processor output: accepts a well-formed object; type is data checked at runtime", () => {
  const good = {
    type: "research idea",
    title: "Differentiable KNN graphs",
    question: "Can KNN graph construction be made differentiable?",
    context: "Graph learning pipelines build KNN graphs as a discrete step.",
    attachments: [{ name: "notes.pdf", note: "Sketch of the idea." }],
    assumptions: ["Gradients must flow end to end."],
    cotSteps: 5,
  };
  assert.ok(processorOutputSchema.safeParse(good).success);

  // The types live in catalog/input-types.json, so the static schema accepts
  // any non-empty label; catalog membership is the runtime's cross-check
  // (INPUT_TYPE_NOT_IN_CATALOG), exercised in the brainstorm-runtime e2e tests.
  assert.ok(processorOutputSchema.safeParse({ ...good, type: "brilliant idea" }).success);
  assert.equal(processorOutputSchema.safeParse({ ...good, type: "" }).success, false);
  assert.equal(processorOutputSchema.safeParse({ ...good, cotSteps: 2 }).success, false);
  assert.equal(processorOutputSchema.safeParse({ ...good, cotSteps: 5.5 }).success, false);

  // Explicitly requested outputs: optional (pre-feature artifacts), bounded,
  // unique titles, and never placeholder probes.
  const ask = {
    title: "Benchmarking protocol",
    ask: "Propose a benchmarking protocol for the differentiable construction.",
  };
  assert.ok(processorOutputSchema.safeParse({ ...good, requestedOutputs: [] }).success);
  assert.ok(processorOutputSchema.safeParse({ ...good, requestedOutputs: [ask] }).success);
  assert.equal(
    processorOutputSchema.safeParse({ ...good, requestedOutputs: [ask, ask] }).success,
    false,
    "duplicate requested-output titles are rejected",
  );
  assert.equal(
    processorOutputSchema.safeParse({
      ...good,
      requestedOutputs: [{ title: "test", ask: "test-question" }],
    }).success,
    false,
    "placeholder requested outputs are rejected",
  );
  assert.equal(
    processorOutputSchema.safeParse({
      ...good,
      requestedOutputs: Array.from({ length: 5 }, (_, i) => ({
        title: `Deliverable ${i + 1}`,
        ask: `Provide the deliverable number ${i + 1} in full.`,
      })),
    }).success,
    false,
    "at most four requested outputs",
  );
});

test("annotated file map: labels are closed, NA notes may be empty, partitions are pure", () => {
  const useful = { path: "attachments/1-repo/src/train.py", label: "code", note: "Training loop of the prototype." };
  const ignored = { path: "attachments/1-repo/package-lock.json", label: "NA", note: "" };

  const withFiles = {
    type: "research idea",
    title: "Differentiable KNN graphs",
    question: "Can KNN graph construction be made differentiable?",
    context: "",
    attachments: [{ name: "repo", note: "Prototype repository." }],
    assumptions: [],
    cotSteps: 5,
    files: [useful, ignored],
  };
  assert.ok(processorOutputSchema.safeParse(withFiles).success);
  assert.equal(
    processorOutputSchema.safeParse({
      ...withFiles,
      files: [{ ...useful, label: "important" }],
    }).success,
    false,
    "labels come from the closed catalog only",
  );
  assert.equal(
    processorOutputSchema.safeParse({
      ...withFiles,
      files: [{ ...useful, note: "" }],
    }).success,
    false,
    "a useful file requires a relation note",
  );

  // A structured-output transport that rejects a valid payload makes the model
  // shrink its submission until something is accepted. One real run got through
  // with {title: "test-title", question: "test-question"}, which every later
  // stage then read as the research input — the decomposer searched the
  // literature for "test" and seated six software-testing experts.
  const probe = {
    type: "research idea",
    attachments: [],
    assumptions: [],
    cotSteps: 4,
  };
  for (const [title, question, context] of [
    ["test-title", "test-question", "test-context"],
    ["test", "test", "test"],
    ["Test Title", "Test Question", ""],
    ["Title", "Question", ""],
    ["TODO", "TODO", ""],
    ["n/a", "n/a", ""],
    ["placeholder", "placeholder", ""],
  ] as const) {
    assert.equal(
      processorOutputSchema.safeParse({ ...probe, title, question, context }).success,
      false,
      `a probe value must never pass as an answer: ${title} / ${question}`,
    );
  }
  // Real answers that merely start with one of those words still pass.
  for (const [title, question] of [
    ["Test-time adaptation for graph networks", "Can test-time adaptation stabilise a GNN?"],
    ["A/B testing of ranking models", "Which ranking metric predicts retention?"],
    ["Sample complexity of contrastive learning", "What sample complexity is required?"],
    ["Context-aware recommendation", "Does context improve cold-start ranking?"],
  ] as const) {
    assert.ok(
      processorOutputSchema.safeParse({ ...probe, title, question, context: "" }).success,
      `a real answer must not be mistaken for a probe: ${title}`,
    );
  }

  assert.ok(usefulFilesSchema.safeParse({ files: [useful] }).success);
  assert.equal(
    usefulFilesSchema.safeParse({ files: [ignored] }).success,
    false,
    "NA entries never appear in the useful list",
  );
  assert.ok(ignoredFilesSchema.safeParse({ files: [ignored] }).success);
  assert.equal(
    ignoredFilesSchema.safeParse({ files: [useful] }).success,
    false,
    "the ignored list carries NA entries only",
  );
});

test("experts and panel are separate artifacts", () => {
  const tree = {
    departments: [
      {
        name: "Computer Science",
        domain: "engineering_and_applied_sciences",
        count: 5,
        umbrellas: [
          {
            name: "Graph Neural Networks",
            count: 7,
            subfields: [{ name: "graph structure learning", count: 3 }],
          },
        ],
      },
      {
        name: "Mathematics",
        count: 1,
        umbrellas: [
          {
            name: "Optimization",
            count: 3,
            subfields: [{ name: "optimal transport", count: 2 }],
          },
        ],
      },
    ],
  };
  assert.ok(expertsTreeSchema.safeParse(tree).success);
  assert.equal(
    expertsTreeSchema.safeParse({ tree, members: [] }).success,
    false,
    "the decomposer returns only the ordered expertise tree, not a panel wrapper",
  );
  assert.equal(
    expertsTreeSchema.safeParse({
      departments: [
        { name: "Computer Science", count: 1, umbrellas: [{ name: "ML", count: 1, subfields: [] }] },
        { name: "Computer Science", count: 1, umbrellas: [{ name: "GNN", count: 1, subfields: [] }] },
      ],
    }).success,
    false,
    "department names must be unique",
  );
  // Every area carries measured support, and support is a positive integer.
  assert.equal(
    expertsTreeSchema.safeParse({
      departments: [
        { name: "Computer Science", count: 1, umbrellas: [{ name: "ML", subfields: [] }] },
      ],
    }).success,
    false,
    "an umbrella without a count has no measured support",
  );
  assert.equal(
    expertsTreeSchema.safeParse({
      departments: [
        {
          name: "Computer Science",
          count: 1,
          umbrellas: [{ name: "ML", count: 1, subfields: ["graph learning"] }],
        },
      ],
    }).success,
    false,
    "subfields are counted areas, not bare names",
  );
  assert.equal(
    expertsTreeSchema.safeParse({
      departments: [
        { name: "Computer Science", count: 1, umbrellas: [{ name: "ML", count: 0, subfields: [] }] },
      ],
    }).success,
    false,
    "a count of zero means nobody stated it, so it does not belong in the tree",
  );

  const grounded = {
    ...tree,
    grounding: {
      papers: [
        {
          title: "Latent Graph Inference with Differentiable Top-k",
          authors: ["Ada Lovelace", "Norbert Wiener"],
          year: 2023,
          venue: "NeurIPS",
          url: "https://example.org/abs/2301.00000",
          relation: "Learns sparse graphs end to end.",
        },
      ],
      scholars: [
        {
          name: "Ada Lovelace",
          affiliation: "TU Eindhoven",
          url: "https://scholar.example.org/ada",
          profile: "ok",
          interests: ["Graph Neural Networks", "Optimal Transport"],
        },
        {
          name: "Norbert Wiener",
          affiliation: "",
          url: "",
          profile: "no_profile",
          interests: [],
        },
      ],
    },
  };
  assert.ok(
    expertsTreeSchema.safeParse(grounded).success,
    "the tree may carry the literature grounding (papers, scholars, interests)",
  );
  const backfilled = structuredClone(grounded);
  backfilled.grounding.scholars[1]!.interests = ["Cybernetics"];
  assert.equal(
    expertsTreeSchema.safeParse(backfilled).success,
    false,
    "a no_profile lookup must not carry backfilled interests",
  );
  assert.equal(
    expertsTreeSchema.safeParse({
      ...tree,
      grounding: { papers: [], scholars: grounded.grounding.scholars },
    }).success,
    false,
    "grounding without papers is omitted, never empty",
  );

  const good = {
    members: [
      { id: "cs-gnn", department: "Computer Science", umbrella: "Graph Neural Networks", subfields: ["graph structure learning"] },
      { id: "math-opt", department: "Mathematics", umbrella: "Optimization", subfields: ["optimal transport"] },
    ],
  };
  assert.ok(panelSchema.safeParse(good).success);

  assert.equal(
    panelSchema.safeParse({ tree, ...good }).success,
    false,
    "the seated panel does not duplicate its upstream experts tree",
  );

  const duplicateSeat = structuredClone(good);
  duplicateSeat.members[1] = { ...duplicateSeat.members[0]!, id: "cs-gnn-2" };
  assert.equal(
    panelSchema.safeParse(duplicateSeat).success,
    false,
    "the identical focus set is one seat, never two",
  );

  // Sibling topics may seat separately under one umbrella: same department
  // and umbrella, different exact focus — the look-ahead seating produces
  // these when a branch's topics outrank the umbrella seat.
  const siblingSeats = structuredClone(good);
  siblingSeats.members[1] = {
    ...siblingSeats.members[0]!,
    id: "cs-gnn-2",
    subfields: ["latent graph inference"],
  };
  assert.ok(panelSchema.safeParse(siblingSeats).success);

  const single = { members: [good.members[0]] };
  assert.equal(panelSchema.safeParse(single).success, false, "a reviewable panel needs at least two members");
});

test("brain idea: paragraph counts and chain length limits are enforced", () => {
  const good = { output: validDevelopedOutput, cot: [para(1), para(1), para(1), para(1), para(1)], novelty: para(1) };
  assert.ok(brainIdeaSchema.safeParse(good).success);

  const shortAbstract = structuredClone(good);
  shortAbstract.output.paper.abstract = section(2);
  assert.equal(brainIdeaSchema.safeParse(shortAbstract).success, false, "abstract must be exactly 3 paragraphs");

  const multiParagraphStep = structuredClone(good);
  multiParagraphStep.cot[2] = para(2);
  assert.equal(brainIdeaSchema.safeParse(multiParagraphStep).success, false, "each step is exactly one paragraph");

  assert.equal(brainIdeaSchema.safeParse({ ...good, cot: [para(1), para(1)] }).success, false, "chain too short");

  assert.equal(
    brainIdeaSchema.safeParse({ ...good, novelty: undefined }).success,
    false,
    "a paper-shaped output requires a novelty statement",
  );

  const verificationOutput = {
    type: "unverified claim",
    verification: {
      claim: "Attention layers implicitly perform kernel regression.",
      claimSource: "submitter's own hypothesis",
      verdict: "indeterminate" as const,
      evidence: noEvidence,
      reasoning: para(1),
      confidence: { level: "low" as const, rationale: "No decisive test was available in the time given." },
    },
  };
  assert.ok(
    brainIdeaSchema.safeParse({ output: verificationOutput, cot: [para(1), para(1), para(1)] }).success,
    "a verification-shaped output needs no novelty statement",
  );
  assert.equal(
    brainIdeaSchema.safeParse({ output: verificationOutput, cot: [para(1), para(1), para(1)], novelty: para(1) })
      .success,
    false,
    "a verification-shaped output must omit novelty entirely",
  );
  assert.equal(
    brainIdeaSchema.safeParse({
      output: { ...verificationOutput, paper: validPaperBody },
      cot: [para(1), para(1), para(1)],
    }).success,
    false,
    "exactly one shape body may be populated",
  );

  // Requested-output sections ride the envelope, uniform across shapes:
  // unique verbatim titles, 1-6 paragraph responses, no placeholder probes.
  // Presence-iff-asked is run data, enforced by the runtime, not here.
  const askSection = {
    title: "Benchmarking protocol",
    response: [para(1), para(1)],
  };
  const withSections = {
    output: { ...validDevelopedOutput, requested: [askSection] },
    cot: [para(1), para(1), para(1)],
    novelty: para(1),
  };
  assert.ok(brainIdeaSchema.safeParse(withSections).success);
  assert.equal(
    brainIdeaSchema.safeParse({
      ...withSections,
      output: { ...validDevelopedOutput, requested: [] },
    }).success,
    false,
    "an empty requested list is meaningless; the key must be omitted instead",
  );
  assert.equal(
    brainIdeaSchema.safeParse({
      ...withSections,
      output: { ...validDevelopedOutput, requested: [askSection, askSection] },
    }).success,
    false,
    "duplicate requested-section titles are rejected",
  );
  assert.equal(
    brainIdeaSchema.safeParse({
      ...withSections,
      output: {
        ...validDevelopedOutput,
        requested: [{ title: "Benchmarking protocol", response: ["placeholder"] }],
      },
    }).success,
    false,
    "placeholder responses are rejected",
  );
});

test("comment: targets a step; Build requires a suggestion; Interrupt requires structured evidence", () => {
  assert.ok(
    commentSchema.safeParse({
      verdict: "Pass",
      step: 2,
      reason: "The step is sound and nothing I could raise would improve it.",
      suggestion: "",
      evidence: noEvidence,
    }).success,
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Pass",
      reason: "The step is sound and nothing I could raise would improve it.",
      suggestion: "",
      evidence: noEvidence,
    }).success,
    false,
    "a comment must name the step its verdict targets",
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Pass",
      step: 0,
      reason: "The step is sound and nothing I could raise would improve it.",
      suggestion: "",
      evidence: noEvidence,
    }).success,
    false,
    "step targets are 1-based",
  );
  assert.ok(
    commentSchema.safeParse({
      verdict: "Build",
      step: 1,
      reason: "Sound but incomplete: the variance term is left unbounded.",
      suggestion: "Also bound the variance.",
      evidence: noEvidence,
    }).success,
    "a Build may target an earlier step than the current one",
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Build",
      step: 2,
      reason: "Sound but incomplete: the variance term is left unbounded.",
    }).success,
    false,
    "Build without a suggestion is rejected",
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Build",
      step: 2,
      reason: "Sound but incomplete: the variance term is left unbounded.",
      suggestion: "ok",
      evidence: noEvidence,
    }).success,
    false,
    "a stub Build suggestion is rejected — it must be concrete",
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Pass",
      step: 1,
      reason: "test",
      suggestion: "",
      evidence: noEvidence,
    }).success,
    false,
    "placeholder reasons can never satisfy the contract",
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Interrupt",
      step: 2,
      reason: "The gradient estimate is biased under the stated sampling scheme.",
    }).success,
    false,
    "Interrupt without evidence is rejected — evidence-backed verdicts only",
  );
  assert.ok(
    commentSchema.safeParse({
      verdict: "Interrupt",
      step: 2,
      reason: "The gradient estimate is biased under the stated sampling scheme.",
      suggestion: "",
      evidence: {
        kind: "script",
        code: "import numpy as np\nprint(np.mean([1, 2]))",
        result: "1.5",
        derivation: "",
        citation: "",
        locator: "",
        shows: "",
      },
    }).success,
  );
  assert.ok(
    commentSchema.safeParse({
      verdict: "Interrupt",
      step: 3,
      reason: "The gradient estimate is biased under the stated sampling scheme.",
      suggestion: "Recompute the estimator with a control variate before step 3.",
      evidence: {
        kind: "math",
        code: "",
        result: "",
        derivation: "Expanding the expectation term by term shows the bias.",
        citation: "",
        locator: "",
        shows: "",
      },
    }).success,
    "a repair hint attached to an Interrupt is tolerated as extra context",
  );
  assert.ok(
    commentSchema.safeParse({
      verdict: "Interrupt",
      step: 3,
      reason: "This exact problem is already solved in published prior work.",
      suggestion: "",
      evidence: {
        kind: "reference",
        code: "",
        result: "",
        derivation: "",
        citation: "Doe et al. 2021, NeurIPS",
        locator: "https://example.org/paper",
        shows: "Solves the stated problem.",
      },
    }).success,
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Interrupt",
      step: 3,
      reason: "This step is flawed in a way the cited work already demonstrates.",
      suggestion: "",
      evidence: {
        kind: "reference",
        code: "",
        result: "",
        derivation: "",
        citation: "Doe et al.",
        locator: "",
        shows: "",
      },
    }).success,
    false,
    "a reference must say where to find it and what it shows",
  );
});

test("evidence: an omitted detail field IS the empty string the runtime writes", () => {
  // A judge wrote its second issue as `evidence: { kind: "none" }` and spent all
  // three validation attempts on "issues.1.evidence.shows: expected string,
  // received undefined", failing the task and the run. For kind "none" every
  // detail field must be exactly "" — an empty string carries no information, so
  // requiring the model to type six of them fails on shape, never on substance.
  const parsed = evidenceSchema.safeParse({ kind: "none" });
  assert.ok(parsed.success, "a bare none-kind evidence is accepted");
  assert.deepEqual(
    parsed.success ? parsed.data : undefined,
    {
      kind: "none",
      code: "",
      result: "",
      derivation: "",
      citation: "",
      locator: "",
      shows: "",
    },
    "the runtime writes the canonical fields the model left out",
  );
  // Nothing about substance is loosened: a kind that PROMISES content still has
  // to carry it, and now says so instead of complaining about a missing type.
  const scriptWithoutCode = evidenceSchema.safeParse({ kind: "script" });
  assert.equal(scriptWithoutCode.success, false);
  assert.match(
    (scriptWithoutCode.success ? [] : scriptWithoutCode.error.issues)
      .map((issue: { path: (string | number | symbol)[]; message: string }) =>
        `${issue.path.join(".")}: ${issue.message}`)
      .join(" | "),
    /code: script evidence requires code/,
  );
  // And a field that must stay empty for its kind is still refused when filled.
  assert.equal(
    evidenceSchema.safeParse({ kind: "none", shows: "something" }).success,
    false,
    "none-kind evidence may not smuggle content into a detail field",
  );
});

test("judge decision: carries the assessment and the issues[] repair signal", () => {
  const assessment = [
    { commentorId: "cs-gnn", basis: "verified" },
    { commentorId: "math-opt", basis: "authority" },
  ];
  const mathEvidence = {
    kind: "math",
    code: "",
    result: "",
    derivation: "Expanding the expectation term by term shows the bias.",
    citation: "",
    locator: "",
    shows: "",
  };
  const verifiedIssue = {
    step: 2,
    point: "The estimator's bias is demonstrated by the expansion below.",
    basis: "verified",
    evidence: mathEvidence,
    suggestion: "",
    mustAddress: true,
  };
  assert.ok(
    judgeDecisionSchema.safeParse({
      verdict: "Pass",
      reason: "No commentor raised a verified objection to this step.",
      suggestion: "",
      evidence: noEvidence,
      issues: [],
      assessment,
    }).success,
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      verdict: "Pass",
      reason: "No commentor raised a verified objection to this step.",
    }).success,
    false,
    "assessment is mandatory",
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      verdict: "Pass",
      reason: "No commentor raised a verified objection to this step.",
      suggestion: "",
      evidence: noEvidence,
      issues: [{ ...verifiedIssue, mustAddress: false }],
      assessment,
    }).success,
    false,
    "Pass carries no issues — an open issue rules out Pass",
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      verdict: "Interrupt",
      reason: "A commentor demonstrated a verified flaw in the derivation.",
      suggestion: "",
      assessment,
    }).success,
    false,
    "judge Interrupt needs evidence too",
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      verdict: "Interrupt",
      reason: "A commentor demonstrated a verified flaw in the derivation.",
      suggestion: "",
      evidence: mathEvidence,
      issues: [],
      assessment,
    }).success,
    false,
    "Interrupt requires at least one verified must-address issue",
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      verdict: "Interrupt",
      reason: "A commentor demonstrated a verified flaw in the derivation.",
      suggestion: "",
      evidence: mathEvidence,
      issues: [
        {
          ...verifiedIssue,
          basis: "authority",
          evidence: noEvidence,
        },
      ],
      assessment,
    }).success,
    false,
    "an authority-only issue cannot sustain an Interrupt",
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      verdict: "Interrupt",
      reason: "A commentor demonstrated a verified flaw in the derivation.",
      suggestion: "",
      evidence: mathEvidence,
      issues: [{ ...verifiedIssue, evidence: noEvidence }],
      assessment,
    }).success,
    false,
    "a verified issue must carry evidence",
  );
  assert.ok(
    judgeDecisionSchema.safeParse({
      verdict: "Interrupt",
      reason: "A commentor demonstrated a verified flaw in the derivation.",
      suggestion: "Drop the shared temperature or correct the closed form.",
      assessment,
      issues: [verifiedIssue],
      evidence: mathEvidence,
    }).success,
    "an Interrupt carrying a repair hint is accepted, never a task failure",
  );
  assert.ok(
    judgeDecisionSchema.safeParse({
      verdict: "Build",
      reason: "A necessary justification is missing from the second step.",
      suggestion: "State and bound the variance term explicitly.",
      evidence: noEvidence,
      issues: [
        {
          step: 2,
          point: "The variance term is used but never bounded anywhere.",
          basis: "authority",
          evidence: noEvidence,
          suggestion: "State and bound the variance term explicitly.",
          mustAddress: true,
        },
      ],
      assessment,
    }).success,
    "a Build stands on at least one must-address issue",
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      verdict: "Pass",
      reason: "test",
      suggestion: "",
      evidence: noEvidence,
      issues: [],
      assessment,
    }).success,
    false,
    "placeholder judge reasons are rejected",
  );
});

test("redevelopment: re-emits the complete chain within the fixed step bounds", () => {
  const good = {
    output: validDevelopedOutput,
    steps: [para(1), para(1), para(1)],
    novelty: para(1),
  };
  assert.ok(redevelopmentSchema.safeParse(good).success);
  assert.equal(
    redevelopmentSchema.safeParse({ ...good, steps: [para(1)] }).success,
    false,
    "a chain below the minimum step count is rejected",
  );
  assert.equal(
    redevelopmentSchema.safeParse({ ...good, fromStep: 2 }).success,
    false,
    "the retired tail-splice fields are no longer accepted",
  );
  assert.equal(
    redevelopmentSchema.safeParse({ ...good, output: validDevelopedOutput, novelty: undefined }).success,
    false,
    "a paper-shaped output still requires novelty on a redevelopment",
  );
});

test("redevelopment patch: rewritten steps only, ascending, at least one", () => {
  const good = {
    steps: [{ index: 2, text: para(1) }],
    outputPatch: { paper: { method: section(3) } },
  };
  assert.ok(redevelopmentPatchSchema.safeParse(good).success);
  assert.ok(
    redevelopmentPatchSchema.safeParse({ steps: [{ index: 1, text: para(1) }] }).success,
    "a repair that leaves the body standing patches the chain alone",
  );
  assert.equal(
    redevelopmentPatchSchema.safeParse({ ...good, steps: [] }).success,
    false,
    "a revision that rewrites nothing is not a revision",
  );
  assert.equal(
    redevelopmentPatchSchema.safeParse({
      ...good,
      steps: [
        { index: 2, text: para(1) },
        { index: 2, text: para(1) },
      ],
    }).success,
    false,
    "one step cannot be rewritten twice in a patch",
  );
  assert.equal(
    redevelopmentPatchSchema.safeParse({
      ...good,
      steps: [
        { index: 3, text: para(1) },
        { index: 1, text: para(1) },
      ],
    }).success,
    false,
    "steps are listed in chain order",
  );
  assert.equal(
    redevelopmentPatchSchema.safeParse({ ...good, output: validDevelopedOutput }).success,
    false,
    "a patch never carries a whole developed output",
  );
});

test("merging a patch reassembles exactly what full re-emission would have produced", () => {
  const base = {
    cot: ["step one text", "step two text", "step three text"],
    output: {
      type: "research idea",
      paper: validPaperBody,
      requested: [{ title: "A benchmark table", response: section(1) }],
    },
    novelty: para(1, "Original novelty"),
  };
  const merged = mergeRedevelopment(base, {
    steps: [{ index: 2, text: "rewritten step two" }],
    outputPatch: { paper: { method: section(3, "Revised method") } },
  });

  // Untouched steps are byte-identical because the HOST carried them, not
  // because the model retyped them correctly.
  assert.deepEqual(merged.steps, [
    "step one text",
    "rewritten step two",
    "step three text",
  ]);
  const paper = (merged.output as { paper: Record<string, unknown> }).paper;
  assert.deepEqual(paper.method, section(3, "Revised method"));
  assert.deepEqual(paper.abstract, validPaperBody.abstract, "unpatched sections stand");
  assert.deepEqual(
    (merged.output as { requested: unknown }).requested,
    base.output.requested,
    "requested sections carry through when the patch omits them",
  );
  assert.equal(merged.novelty, base.novelty, "novelty stands until a repair moves it");
  // And the reassembled whole is a valid redevelopment, so nothing downstream
  // can tell a patch from a re-emission.
  assert.ok(
    redevelopmentSchema.safeParse({
      output: merged.output,
      steps: merged.steps,
      ...(merged.novelty !== undefined ? { novelty: merged.novelty } : {}),
    }).success,
  );
});

test("a patch that does not fit the version it revises fails loudly", () => {
  const base = {
    cot: ["step one text", "step two text", "step three text"],
    output: { type: "research idea", paper: validPaperBody },
  };
  assert.throws(
    () => mergeRedevelopment(base, { steps: [{ index: 4, text: "beyond the chain" }] }),
    RedevelopmentMergeError,
    "a step index past the chain is a broken patch, never a silent append",
  );
  assert.throws(
    () =>
      mergeRedevelopment(base, {
        steps: [{ index: 1, text: "fixed" }],
        outputPatch: { survey: { openGaps: section(1) } },
      }),
    RedevelopmentMergeError,
    "a patch cannot switch the member's output to another shape",
  );
});

test("final proposal: prioritized action items are required", () => {
  const good = {
    title: "A differentiable graph construction program",
    framing: "Why gradients over graph space matter.",
    consensus: ["Optimal-transport relaxations are the shared substrate."],
    tensions: ["Soft top-k versus discrete sampling with straight-through estimators."],
    novelDirections: ["A Riemannian view of adjacency updates."],
    actionItems: [{ priority: 1, action: "Benchmark soft top-k against Gumbel sampling.", rationale: "Cheapest decisive experiment." }],
    applications: ["Point-cloud pipelines with learnable neighborhoods."],
  };
  assert.ok(finalProposalSchema.safeParse(good).success);
  assert.equal(finalProposalSchema.safeParse({ ...good, actionItems: [] }).success, false);
  assert.equal(
    finalProposalSchema.safeParse({ ...good, actionItems: [{ priority: 0, action: "x" }] }).success,
    false,
  );
});

// ---------------------------------------------------------------------------
// the four-part chain forms
// ---------------------------------------------------------------------------

const emptyParts = { part1: "", part2: "", part3: "", part4: "" };
const stepParts = (text: string) => ({
  part1: `${text}, first part.`,
  part2: `${text}, second part.`,
  part3: `${text}, third part.`,
  part4: `${text}, fourth part.`,
});
const partsAssessment = [{ commentorId: "cs-gnn", basis: "verified" as const }];
const mathEvidence = {
  kind: "math" as const,
  code: "",
  result: "",
  derivation: "Expanding the expectation term by term shows the bias.",
  citation: "",
  locator: "",
  shows: "",
};

test("a chain step is exactly four parts, and an empty part is legal", () => {
  assert.ok(cotStepPartsSchema.safeParse(stepParts("Step one")).success);
  assert.ok(
    cotStepPartsSchema.safeParse(emptyParts).success,
    "an empty part carries no claim, and no length rule may fail a run over it",
  );
  assert.equal(
    cotStepPartsSchema.safeParse({ ...stepParts("Step one"), part5: "one more" }).success,
    false,
    "four is the ceiling: a fifth part would let a step grow without bound",
  );
  assert.equal(
    cotStepPartsSchema.safeParse({ part1: "a", part2: "b", part3: "c" }).success,
    false,
    "all four keys are always present, even when empty",
  );
});

test("brainIdeaParts: the same first pass with a four-part chain", () => {
  const good = {
    output: validDevelopedOutput,
    cot: [stepParts("One"), stepParts("Two"), stepParts("Three")],
    novelty: para(1),
  };
  assert.ok(brainIdeaPartsSchema.safeParse(good).success);
  assert.ok(
    brainIdeaPartsSchema.safeParse({
      ...good,
      cot: [emptyParts, emptyParts, emptyParts],
    }).success,
    "no length rule lives in the new chain",
  );
  assert.equal(
    brainIdeaPartsSchema.safeParse({ ...good, cot: [stepParts("One")] }).success,
    false,
    "the 3..9 step bounds are unchanged",
  );
  assert.equal(
    brainIdeaPartsSchema.safeParse({ ...good, cot: [para(1), para(1), para(1)] }).success,
    false,
    "a parts chain never accepts the legacy string steps",
  );
  assert.equal(
    brainIdeaPartsSchema.safeParse({ ...good, novelty: undefined }).success,
    false,
    "the shape/novelty rule is carried over, not re-decided",
  );
  // And the legacy schema is untouched by the new one existing beside it.
  assert.ok(
    brainIdeaSchema.safeParse({ ...good, cot: [para(1), para(1), para(1)] }).success,
  );
  assert.equal(brainIdeaSchema.safeParse(good).success, false);
});

test("commentParts: flaws replace the scalar step, and an empty list is a verdict", () => {
  const pass = {
    verdict: "Pass",
    reason: "Nothing to fault.",
    flaws: [],
    suggestion: "",
    evidence: noEvidence,
  };
  assert.ok(
    commentPartsSchema.safeParse(pass).success,
    "a reviewer that found nothing is legal, and says so with an empty list",
  );
  assert.ok(
    commentPartsSchema.safeParse({
      ...pass,
      verdict: "Build",
      reason: "ok",
      flaws: [{ step: 2, ...emptyParts, part3: "The bound is asserted, never derived." }],
    }).success,
    "no length floor on the reason, and no required suggestion on a Build",
  );
  assert.equal(
    commentPartsSchema.safeParse({ ...pass, step: 2 }).success,
    false,
    "the top-level step is gone; each flaw carries its own",
  );
  assert.equal(
    commentPartsSchema.safeParse({
      ...pass,
      flaws: [{ step: 1, ...emptyParts, part5: "elsewhere" }],
    }).success,
    false,
    "a flaw entry locates itself in one of the four parts, never a fifth",
  );
  // KEPT: the evidence contract, which says what a verdict means.
  assert.equal(
    commentPartsSchema.safeParse({ ...pass, verdict: "Interrupt" }).success,
    false,
    "Interrupt still requires script, math, or reference evidence",
  );
  assert.ok(
    commentPartsSchema.safeParse({
      ...pass,
      verdict: "Interrupt",
      evidence: mathEvidence,
      flaws: [{ step: 3, ...emptyParts, part1: "The expansion contradicts the claim." }],
    }).success,
  );
});

test("judgeDecisionParts: a flaw list beside the repair signal, no length rules", () => {
  const partsIssue = {
    step: 2,
    part: "part3",
    point: "The bias term is asserted, never bounded.",
    basis: "verified",
    evidence: mathEvidence,
    suggestion: "",
    mustAddress: true,
  };
  const good = {
    verdict: "Interrupt",
    reason: "ok",
    suggestion: "",
    evidence: mathEvidence,
    flaws: [{ step: 2, ...emptyParts, part3: "The bias term is asserted." }],
    issues: [partsIssue],
    assessment: partsAssessment,
  };
  assert.ok(good.reason.length < 30 && judgeDecisionPartsSchema.safeParse(good).success);
  assert.ok(
    judgeDecisionPartsSchema.safeParse({
      ...good,
      verdict: "Build",
      evidence: noEvidence,
      issues: [{ ...partsIssue, basis: "authority", evidence: noEvidence }],
      flaws: [],
      suggestion: "",
    }).success,
    "a Build no longer owes a suggestion of any particular length",
  );
  // KEPT: every verdict/issue rule that is a contract rather than a length.
  assert.equal(
    judgeDecisionPartsSchema.safeParse({ ...good, verdict: "Pass", evidence: noEvidence }).success,
    false,
    "Pass still carries no issues",
  );
  assert.equal(
    judgeDecisionPartsSchema.safeParse({
      ...good,
      issues: [{ ...partsIssue, basis: "authority", evidence: noEvidence }],
    }).success,
    false,
    "an authority-only issue still cannot sustain an Interrupt",
  );
  assert.equal(
    judgeDecisionPartsSchema.safeParse({
      ...good,
      issues: [{ ...partsIssue, part: undefined }],
    }).success,
    false,
    "a parts issue names the part it sits in",
  );
  assert.equal(
    judgeDecisionPartsSchema.safeParse({ ...good, assessment: [] }).success,
    false,
    "assessment keeps its min(1): naming who was verified is the judge's core act",
  );
});

test("merging a four-part patch carries untouched steps byte-identical", () => {
  const base = {
    cot: [stepParts("One"), stepParts("Two"), stepParts("Three")],
    output: {
      type: "research idea",
      paper: validPaperBody,
      requested: [{ title: "A benchmark table", response: section(1) }],
    },
    novelty: para(1, "Original novelty"),
  };
  const patch = {
    steps: [{ index: 2, ...stepParts("Rewritten two") }],
    outputPatch: { paper: { method: section(3, "Revised method") } },
  };
  assert.ok(redevelopmentPatchPartsSchema.safeParse(patch).success);
  const merged = mergeRedevelopmentParts(base, patch);

  // Same object, not an equal one: the host carried the step, so no retyping
  // could have altered a character of it.
  assert.equal(merged.steps[0], base.cot[0]);
  assert.equal(merged.steps[2], base.cot[2]);
  assert.deepEqual(merged.steps[1], stepParts("Rewritten two"));
  const paper = (merged.output as { paper: Record<string, unknown> }).paper;
  assert.deepEqual(paper.method, section(3, "Revised method"));
  assert.deepEqual(paper.abstract, validPaperBody.abstract, "unpatched sections stand");
  assert.deepEqual(
    (merged.output as { requested: unknown }).requested,
    base.output.requested,
    "requested sections carry through when the patch omits them",
  );
  assert.equal(merged.novelty, base.novelty, "novelty stands until a repair moves it");
  // The reassembled whole is a valid first-pass artifact, exactly as the
  // string-chain merge produces a valid redevelopment.
  assert.ok(
    brainIdeaPartsSchema.safeParse({
      output: merged.output,
      cot: merged.steps,
      ...(merged.novelty !== undefined ? { novelty: merged.novelty } : {}),
    }).success,
  );

  assert.throws(
    () => mergeRedevelopmentParts(base, { steps: [{ index: 4, ...stepParts("Beyond") }] }),
    RedevelopmentMergeError,
    "a step index past the chain is a broken patch, never a silent append",
  );
  assert.throws(
    () =>
      mergeRedevelopmentParts(base, {
        steps: [{ index: 1, ...stepParts("Fixed") }],
        outputPatch: { survey: { openGaps: section(1) } },
      }),
    RedevelopmentMergeError,
    "a patch cannot switch the member's output to another shape",
  );
});

test("the legacy names keep their exact meaning beside the new ones", () => {
  // A run pins its bundle version forever, so the old entries must still be
  // the old schemas — the new forms are additions, never replacements.
  assert.equal(artifactSchemas.comment, commentSchema);
  assert.equal(artifactSchemas.judgeDecision, judgeDecisionSchema);
  assert.equal(artifactSchemas.brainIdea, brainIdeaSchema);
  assert.equal(artifactSchemas.redevelopment, redevelopmentSchema);
  assert.equal(artifactSchemas.redevelopmentPatch, redevelopmentPatchSchema);
  assert.equal(artifactSchemas.brainIdeaParts, brainIdeaPartsSchema);
  assert.equal(artifactSchemas.commentParts, commentPartsSchema);
  assert.equal(artifactSchemas.judgeDecisionParts, judgeDecisionPartsSchema);
  assert.equal(artifactSchemas.redevelopmentPatchParts, redevelopmentPatchPartsSchema);

  // The legacy length rules the new schemas dropped are still enforced there.
  const legacyComment = {
    verdict: "Build",
    step: 2,
    reason: "The bound in step two is asserted rather than derived anywhere.",
    suggestion: "Derive the bound explicitly from the stated assumptions.",
    evidence: noEvidence,
  };
  assert.ok(commentSchema.safeParse(legacyComment).success);
  assert.equal(
    commentSchema.safeParse({ ...legacyComment, reason: "ok" }).success,
    false,
    "the legacy comment still demands a substantive reason",
  );
  assert.equal(
    commentSchema.safeParse({ ...legacyComment, suggestion: "fix it" }).success,
    false,
    "the legacy comment still demands a concrete Build suggestion",
  );
  assert.equal(
    commentSchema.safeParse({ ...legacyComment, flaws: [] }).success,
    false,
    "the legacy comment never gained the new fields",
  );
  const legacyIssue = {
    step: 2,
    point: "The estimator's bias is demonstrated by the expansion below.",
    basis: "verified",
    evidence: mathEvidence,
    suggestion: "",
    mustAddress: true,
  };
  const legacyDecision = {
    verdict: "Interrupt",
    reason: "A commentor demonstrated a verified flaw in the derivation.",
    suggestion: "",
    evidence: mathEvidence,
    issues: [legacyIssue],
    assessment: partsAssessment,
  };
  assert.ok(judgeDecisionSchema.safeParse(legacyDecision).success);
  assert.equal(
    judgeDecisionSchema.safeParse({ ...legacyDecision, reason: "ok" }).success,
    false,
    "the legacy decision still demands a substantive reason",
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      ...legacyDecision,
      issues: [{ ...legacyIssue, part: "part1" }],
    }).success,
    false,
    "the legacy issue never gained the part locator",
  );
});
