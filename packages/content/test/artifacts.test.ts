import assert from "node:assert/strict";
import { test } from "node:test";

import {
  brainIdeaSchema,
  commentSchema,
  expertsTreeSchema,
  finalProposalSchema,
  ignoredFilesSchema,
  judgeDecisionSchema,
  panelSchema,
  processorOutputSchema,
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
  assert.equal(panelSchema.safeParse(duplicateSeat).success, false, "one member per umbrella");

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
});

test("comment: Build requires a suggestion; Interrupt requires structured evidence", () => {
  assert.ok(
    commentSchema.safeParse({
      verdict: "Pass",
      reason: "The step is sound and nothing I could raise would improve it.",
      suggestion: "",
      evidence: noEvidence,
    }).success,
  );
  assert.ok(
    commentSchema.safeParse({
      verdict: "Build",
      reason: "Sound but improvable: the variance term is left unbounded.",
      suggestion: "Also bound the variance.",
      evidence: noEvidence,
    }).success,
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Build",
      reason: "Sound but improvable: the variance term is left unbounded.",
    }).success,
    false,
    "Build without a suggestion is rejected",
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Build",
      reason: "Sound but improvable: the variance term is left unbounded.",
      suggestion: "ok",
      evidence: noEvidence,
    }).success,
    false,
    "a stub Build suggestion is rejected — it must be concrete",
  );
  assert.equal(
    commentSchema.safeParse({
      verdict: "Pass",
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
      reason: "The gradient estimate is biased under the stated sampling scheme.",
    }).success,
    false,
    "Interrupt without evidence is rejected — evidence-backed verdicts only",
  );
  assert.ok(
    commentSchema.safeParse({
      verdict: "Interrupt",
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

test("judge decision: always carries the per-commentor assessment", () => {
  const assessment = [
    { commentorId: "cs-gnn", basis: "verified" },
    { commentorId: "math-opt", basis: "authority" },
  ];
  assert.ok(
    judgeDecisionSchema.safeParse({
      verdict: "Pass",
      reason: "No commentor raised a verified objection to this step.",
      suggestion: "",
      evidence: noEvidence,
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
      verdict: "Interrupt",
      reason: "A commentor demonstrated a verified flaw in the derivation.",
      suggestion: "",
      assessment,
    }).success,
    false,
    "judge Interrupt needs evidence too",
  );
  assert.ok(
    judgeDecisionSchema.safeParse({
      verdict: "Interrupt",
      reason: "A commentor demonstrated a verified flaw in the derivation.",
      suggestion: "Drop the shared temperature or correct the closed form.",
      assessment,
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
    "an Interrupt carrying a repair hint is accepted, never a task failure",
  );
  assert.equal(
    judgeDecisionSchema.safeParse({
      verdict: "Pass",
      reason: "test",
      suggestion: "",
      evidence: noEvidence,
      assessment,
    }).success,
    false,
    "placeholder judge reasons are rejected",
  );
});

test("redevelopment: revised steps start at a positive step and replace the tail only", () => {
  const good = { fromStep: 3, output: validDevelopedOutput, revisedSteps: [para(1), para(1), para(1)], novelty: para(1) };
  assert.ok(redevelopmentSchema.safeParse(good).success);
  assert.equal(redevelopmentSchema.safeParse({ ...good, fromStep: 0 }).success, false);
  assert.equal(redevelopmentSchema.safeParse({ ...good, revisedSteps: [] }).success, false);
  assert.equal(
    redevelopmentSchema.safeParse({ ...good, output: validDevelopedOutput, novelty: undefined }).success,
    false,
    "a paper-shaped output still requires novelty on a redevelopment",
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
