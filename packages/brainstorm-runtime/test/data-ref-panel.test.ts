import assert from "node:assert/strict";
import test from "node:test";

import { artifactSchemas, type BindValue } from "@brainstorm-agentic/content";
import {
  Scope,
  systemPromptText,
  textBlock,
  userMessage,
  type AgentTask,
  type JsonObject,
} from "@brainstorm-agentic/core";

import {
  artifactSchemaToJsonSchema,
  BrainstormAgentTaskAdapter,
  ContentArtifactOutputValidator,
  resolveBindValue,
  resolveDataReference,
  selectPanel,
  weavePanel,
  writeDataReference,
} from "../src/index.js";

function fixture() {
  const state: JsonObject = {
    ideas: {
      thinker: {
        output: { title: "paper" },
        cot: ["one", "two", "three"],
        novelty: "novel",
      },
      peer: {
        output: { title: "peer paper" },
        cot: ["secret"],
        novelty: "peer novelty",
      },
    },
  };
  const scope = Scope.root({
    member: { id: "thinker" },
    stepIndex: 2,
  });
  return { state, scope };
}

test("safe references resolve bracket variables and through projections", () => {
  const { state, scope } = fixture();
  assert.deepEqual(resolveDataReference("ideas[member.id].cot", scope, state), [
    "one",
    "two",
    "three",
  ]);
  const projected = resolveBindValue(
    { ref: "ideas[member.id].cot", through: "stepIndex" } as BindValue,
    scope,
    state,
  );
  assert.deepEqual(projected, ["one", "two"]);
});

test("omit drops the listed keys and leaves the source untouched", () => {
  const { state, scope } = fixture();
  const idea = resolveBindValue(
    { ref: "ideas[member.id]", omit: ["cot"] } as BindValue,
    scope,
    state,
  );
  assert.deepEqual(Object.keys(idea as Record<string, unknown>).sort(), [
    "novelty",
    "output",
  ]);
  // The underlying state still carries the omitted field.
  assert.ok(
    (resolveDataReference("ideas[member.id].cot", scope, state) as unknown[])
      .length > 0,
  );
});

test("pick projects one artifact or every item in a keyed collection", () => {
  const { state, scope } = fixture();
  assert.deepEqual(
    resolveBindValue(
      { ref: "ideas[member.id]", pick: ["output", "novelty"] } as BindValue,
      scope,
      state,
    ),
    { output: { title: "paper" }, novelty: "novel" },
  );
  assert.deepEqual(
    resolveBindValue({ ref: "ideas", pick: ["output", "novelty"] } as BindValue, scope, state),
    {
      thinker: { output: { title: "paper" }, novelty: "novel" },
      peer: { output: { title: "peer paper" }, novelty: "peer novelty" },
    },
  );
});

test("writes materialize bracket variables immutably and reject prototype paths", () => {
  const { state, scope } = fixture();
  const written = writeDataReference(state, "round.comments[member.id]", { verdict: "Pass" }, scope);
  assert.deepEqual(written.state.round, { comments: { thinker: { verdict: "Pass" } } });
  assert.equal(state.round, undefined);
  assert.throws(
    () => resolveDataReference("__proto__.polluted", scope, state),
    /unsafe property/,
  );
});

test("panel.select seats from one cxr-sorted queue over levels 2, 3 and 4 of the pruned tree", () => {
  // Bridged-tree shape: every node carries count and relevance. cxr values:
  // Physics Σ = 4×0.9 + 2×0.3 = 4.2 · QO 3.6 · photon counting 2.7 ·
  // CS Σ = ML 2.6 (dept/umbrella tie: count 4 = 4, tree order keeps the
  // department first) · Biology Σ = 3×0.7 + 1×0.25 = 2.35 · SysBio 2.1 ·
  // CM 0.6 · BP 0.25.
  const experts = {
    departments: [
      {
        name: "Physics",
        domain: "Natural Sciences",
        count: 6,
        relevance: 0.9,
        umbrellas: [
          {
            name: "Quantum Optics",
            count: 4,
            relevance: 0.9,
            subfields: [{ name: "photon counting", count: 3, relevance: 0.9 }],
          },
          {
            name: "Condensed Matter",
            count: 2,
            relevance: 0.3,
            subfields: [
              { name: "transport", count: 1, relevance: 0.3 },
              { name: "Chip Morphology", count: 1, relevance: 0.2 },
            ],
          },
        ],
      },
      {
        name: "Biology",
        domain: "Life Sciences",
        count: 4,
        relevance: 0.7,
        umbrellas: [
          {
            name: "Systems Biology",
            count: 3,
            relevance: 0.7,
            subfields: [{ name: "network inference", count: 3, relevance: 0.7 }],
          },
          {
            name: "Biophysics",
            count: 1,
            relevance: 0.25,
            subfields: [{ name: "single-molecule methods", count: 1, relevance: 0.25 }],
          },
        ],
      },
      {
        name: "Computer Science",
        domain: "Physical Sciences",
        count: 4,
        relevance: 0.65,
        umbrellas: [
          {
            name: "Machine Learning",
            count: 4,
            relevance: 0.65,
            subfields: [{ name: "representation learning", count: 2, relevance: 0.65 }],
          },
        ],
      },
    ],
  };

  // The look-ahead keeps parents from swallowing imminent children: with
  // capacity 3, Physics is skipped (Quantum Optics is within the next 3 live
  // entries), Quantum Optics is skipped (photon counting is imminent), and
  // the TOPIC seats. Machine Learning's topic is NOT within its window, so
  // the umbrella seats as a block — with the generic BROAD_SEAT_FOCUS, not
  // its topic's real name (a block win is not the same claim as a topic
  // winning on its own specific merit).
  assert.deepEqual(selectPanel(experts, 3).members, [
    {
      id: "member-1",
      department: "Physics",
      umbrella: "Quantum Optics",
      subfields: ["photon counting"],
    },
    {
      id: "member-2",
      department: "Computer Science",
      umbrella: "Machine Learning",
      subfields: ["super relevant to this project"],
    },
    {
      id: "member-3",
      department: "Biology",
      umbrella: "Systems Biology",
      subfields: ["network inference"],
    },
  ]);

  // With more capacity the windows widen, every parent defers to its
  // children, and the panel becomes topic-level seats in queue order.
  assert.deepEqual(selectPanel(experts, 5).members, [
    { id: "member-1", department: "Physics", umbrella: "Quantum Optics", subfields: ["photon counting"] },
    { id: "member-2", department: "Biology", umbrella: "Systems Biology", subfields: ["network inference"] },
    { id: "member-3", department: "Computer Science", umbrella: "Machine Learning", subfields: ["representation learning"] },
    { id: "member-4", department: "Physics", umbrella: "Condensed Matter", subfields: ["transport"] },
    { id: "member-5", department: "Biology", umbrella: "Biophysics", subfields: ["single-molecule methods"] },
  ]);
  // Queue exhaustion: the sixth seat is Condensed Matter's second topic —
  // two members under one umbrella, each with its own exact focus.
  const twelve = selectPanel(experts, 12).members;
  assert.equal(twelve.length, 6);
  assert.deepEqual(twelve[5], {
    id: "member-6",
    department: "Physics",
    umbrella: "Condensed Matter",
    subfields: ["Chip Morphology"],
  });
});

test("an umbrella- or department-level block seat gets a generic focus, never every topic name it accumulated", () => {
  // D's umbrellas (U1 cxr=2×0.5=1.0, U2 cxr=1×0.9=0.9) sum to D's own
  // cxr=1.9 — highest in the queue, so D is popped first. Filler
  // department E (no umbrellas of its own, cxr=1×1.2=1.2) sits between D
  // and D's own umbrellas in the sorted queue, so at capacity=1 the
  // look-ahead's single-entry window after D lands on E, not on U1 or U2:
  // D's own umbrella is never "imminent", so D seats through its best
  // umbrella (U1, the higher cxr — "most relevant") rather than deferring.
  const experts = {
    departments: [
      {
        name: "D",
        domain: "Domain",
        count: 1,
        relevance: 0.1,
        umbrellas: [
          {
            name: "U1",
            count: 2,
            relevance: 0.5,
            subfields: [
              { name: "topic-a", count: 1, relevance: 0.5 },
              { name: "topic-b", count: 1, relevance: 0.3 },
            ],
          },
          {
            name: "U2",
            count: 1,
            relevance: 0.9,
            subfields: [{ name: "topic-c", count: 1, relevance: 0.9 }],
          },
        ],
      },
      {
        // A filler with no umbrellas of its own: it seats nobody and spends
        // no capacity (per selectPanel's own contract), but its queue
        // position between D and D's umbrellas is exactly what keeps D's
        // look-ahead window from reaching them.
        name: "E",
        domain: "Domain",
        count: 1,
        relevance: 1.2,
        umbrellas: [],
      },
    ],
  };

  const panel = selectPanel(experts, 1);
  assert.deepEqual(panel.members, [
    {
      id: "member-1",
      department: "D",
      // The chosen umbrella's REAL name still fills {{umbrella}} — only the
      // topic list collapses to the generic phrase.
      umbrella: "U1",
      subfields: ["super relevant to this project"],
    },
  ]);
});

test("panel.select seats sibling topics as separate members under the same umbrella", () => {
  // Hand-made non-monotone values (an artifact can carry them even though
  // the bridge never produces them): the "hot" topic outranks its own
  // umbrella and seats alone; the look-ahead then skips U while "cold" is
  // imminent, so the second topic seats as its own member of the same
  // (department, umbrella) branch — exact seats, never the identical focus
  // set twice.
  const experts = {
    departments: [
      {
        name: "D",
        count: 2,
        relevance: 0.1,
        umbrellas: [
          {
            name: "U",
            count: 2,
            relevance: 0.1,
            subfields: [
              { name: "hot", count: 1, relevance: 0.9 },
              { name: "cold", count: 1, relevance: 0.05 },
            ],
          },
        ],
      },
      {
        name: "E",
        count: 1,
        relevance: 0.5,
        umbrellas: [
          {
            name: "V",
            count: 1,
            relevance: 0.5,
            subfields: [{ name: "x", count: 1, relevance: 0.5 }],
          },
        ],
      },
    ],
  };
  assert.deepEqual(selectPanel(experts, 4).members, [
    { id: "member-1", department: "D", umbrella: "U", subfields: ["hot"] },
    { id: "member-2", department: "E", umbrella: "V", subfields: ["x"] },
    { id: "member-3", department: "D", umbrella: "U", subfields: ["cold"] },
  ]);
});

test("panel.select refuses pre-relevance trees: their history restarts under the current pipeline", () => {
  const experts = {
    departments: [
      {
        name: "Computer Science",
        count: 5,
        umbrellas: [
          {
            name: "Graph Neural Networks",
            count: 7,
            subfields: [
              { name: "graph structure learning", count: 3 },
              { name: "latent graph inference", count: 1 },
            ],
          },
          {
            name: "Generative Models",
            count: 2,
            subfields: [{ name: "diffusion models", count: 4 }],
          },
        ],
      },
      {
        name: "Mathematics",
        count: 1,
        umbrellas: [
          {
            name: "Optimization",
            count: 5,
            subfields: [{ name: "optimal transport", count: 7 }],
          },
        ],
      },
    ],
  };
  assert.throws(() => selectPanel(experts, 3), /carries no relevance[\s\S]*restart the run/);
});

test("panel.select removes exhausted parents recursively when their last child is consumed", () => {
  // Non-monotone values put both topics of D ahead of everything else: each
  // topic seat exhausts its umbrella (no sibling left in the queue), which
  // removes the umbrella — and consuming D's second umbrella then removes D
  // itself, so the department never pops just to be skipped.
  const experts = {
    departments: [
      {
        name: "D",
        count: 2,
        relevance: 0.05,
        umbrellas: [
          {
            name: "U1",
            count: 1,
            relevance: 0.05,
            subfields: [{ name: "t1", count: 1, relevance: 0.9 }],
          },
          {
            name: "U2",
            count: 1,
            relevance: 0.04,
            subfields: [{ name: "t2", count: 1, relevance: 0.8 }],
          },
        ],
      },
      {
        name: "E",
        count: 2,
        relevance: 0.3,
        umbrellas: [
          {
            name: "V",
            count: 2,
            relevance: 0.3,
            subfields: [{ name: "x", count: 1, relevance: 0.3 }],
          },
        ],
      },
    ],
  };
  assert.deepEqual(selectPanel(experts, 4).members, [
    { id: "member-1", department: "D", umbrella: "U1", subfields: ["t1"] },
    { id: "member-2", department: "D", umbrella: "U2", subfields: ["t2"] },
    // E defers to V (look-ahead), V defers to its imminent topic.
    { id: "member-3", department: "E", umbrella: "V", subfields: ["x"] },
  ]);
});

test("panel.weave appends one interdisciplinary full member derived from the seated fields", () => {
  const seated = {
    members: [
      { id: "member-1", department: "Physics", umbrella: "Quantum Optics", subfields: ["photon counting"] },
      { id: "member-2", department: "Computer Science", umbrella: "Machine Learning", subfields: ["representation learning"] },
      { id: "member-3", department: "Biology", umbrella: "Systems Biology", subfields: ["network inference"] },
    ],
  };
  const woven = weavePanel(seated, 13);
  assert.equal(woven.members.length, 4);
  assert.deepEqual(woven.members.slice(0, 3), seated.members);
  assert.deepEqual(woven.members[3], {
    id: "member-4",
    department: "Interdisciplinary Research",
    umbrella:
      "the interdisciplinary space between Quantum Optics, Machine Learning and Systems Biology",
    subfields: [
      "the pairwise interfaces of Quantum Optics, Machine Learning and Systems Biology",
      "methods and results that transfer between these fields",
    ],
    seat: "interdisciplinary",
  });

  // Idempotent: weaving an already-woven panel changes nothing.
  assert.deepEqual(weavePanel(woven, 13), woven);

  // A one-field panel has no between-space; the weave is skipped.
  const oneField = {
    members: [
      { id: "member-1", department: "Physics", umbrella: "Quantum Optics", subfields: ["photon counting"] },
      { id: "member-2", department: "Physics", umbrella: "Quantum Optics", subfields: ["squeezed light"] },
    ],
  };
  assert.deepEqual(weavePanel(oneField, 13), oneField);

  // At capacity the panel rides through unchanged rather than overflowing.
  assert.deepEqual(weavePanel(seated, 3), seated);
});

test("artifact schemas become structural JSON Schema descriptions", () => {
  const schema = artifactSchemaToJsonSchema(artifactSchemas.brainIdea, "brainIdea");
  assert.equal(schema.title, "brainIdea");
  assert.equal(schema.type, "object");
  const properties = schema.properties as JsonObject;
  assert.ok(properties.output);
  assert.ok(properties.cot);
  assert.ok(properties.novelty);

  const expertsSchema = artifactSchemaToJsonSchema(
    artifactSchemas.experts,
    "experts",
  );
  assert.equal(JSON.stringify(expertsSchema).includes("propertyNames"), false);
  const expertProperties = expertsSchema.properties as JsonObject;
  assert.ok(expertProperties.departments);
});

test("generic agent adapter consumes compiled request descriptions and content schemas", () => {
  const schema = artifactSchemaToJsonSchema(artifactSchemas.processorOutput, "processorOutput");
  const task: AgentTask = {
    taskId: "task-1",
    kind: "brainstorm.processor",
    input: { logicalRoute: "reasoning" },
    logicalRoute: "reasoning",
    outputSchema: { name: "processorOutput", schema },
    modelRequest: {
      system: "Rendered content instructions",
      messages: [userMessage("Execute the role")],
      responseFormat: { type: "jsonSchema", name: "processorOutput", schema },
    },
  };
  const adapter = new BrainstormAgentTaskAdapter();
  const request = adapter.createRequest(
    task,
    { runId: "run-1", nodePath: "root/task" },
    { modelId: "configured-model", system: "Deployment policy" },
  );
  assert.equal(request.modelId, "configured-model");
  assert.match(
    systemPromptText(request.system) ?? "",
    /Deployment policy[\s\S]*Rendered content instructions/,
  );
  assert.equal(request.responseFormat?.type, "jsonSchema");

  const value = {
    type: "research idea",
    // processorOutput refuses degenerate values, so a fixture standing in for a
    // real submission has to look like one.
    title: "Gaussian node states in message passing",
    question: "Can message passing carry a distribution per node?",
    context: "",
    attachments: [],
    assumptions: [],
    cotSteps: 3,
  };
  const response = {
    providerId: "fake",
    modelId: "configured-model",
    content: [textBlock(JSON.stringify(value))],
    stopReason: "end_turn" as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  assert.deepEqual(
    adapter.responseToOutput(response, task, { runId: "run-1", nodePath: "root/task" }, { modelId: "configured-model" }),
    value,
  );
  assert.equal(new ContentArtifactOutputValidator().validate(value, schema).success, true);
});

test("a patch that only breaks once applied is retryable, not a recorded failure", () => {
  // The rules a patch cannot be judged against on its own live on the merged
  // whole. Before the base travelled with the task these passed validation
  // and failed at write time — and because the answer is journaled first,
  // every resume replayed the same patch into the same dead end.
  const validator = new ContentArtifactOutputValidator();
  const schema = { title: "redevelopmentPatch" };
  const paragraph = "One paragraph of finished text that stands alone and says something real.";
  const base = {
    cot: ["step one text here", "step two text here", "step three text here"],
    output: {
      type: "research obstacle",
      solution: {
        problemFraming: paragraph,
        diagnosis: [{ cause: "A concrete cause statement.", rationale: paragraph }],
        priorAttempts: [],
        candidateSolutions: [
          { approach: "An approach.", mechanism: paragraph, expectedEffect: paragraph, risk: paragraph },
        ],
        recommendation: paragraph,
        validationPlan: ["A validation step that is concrete."],
        residualRisks: ["A residual risk worth naming."],
      },
    },
  };
  // Legal as a patch — the patch schema drops the cross-field rules on
  // purpose — but a solution-shaped output may not carry a novelty claim.
  const patch = {
    steps: [{ index: 2, text: "a repaired step two paragraph that stands alone" }],
    novelty: paragraph,
  };

  assert.equal(
    validator.validate(patch, schema).success,
    true,
    "on its own the patch is well-formed: the whole is what it contradicts",
  );

  const checked = validator.validate(patch, schema, {
    taskId: "t-1",
    kind: "brainstorm.redeveloper",
    input: {},
    revisionBase: base,
  });
  assert.equal(checked.success, false, "merged against its base, the patch is incoherent");
  assert.ok(
    checked.success === false &&
      checked.issues.some((issue) => issue.includes("must omit novelty")),
    "the feedback names the rule the merged whole breaks",
  );
});

test("a patch that fits its base still passes, and no base means no merge check", () => {
  const validator = new ContentArtifactOutputValidator();
  const schema = { title: "redevelopmentPatch" };
  const base = {
    cot: ["step one text here", "step two text here", "step three text here"],
    output: {
      type: "research idea",
      paper: {
        abstract: ["a one", "a two", "a three"],
        introduction: ["i one", "i two", "i three"],
        method: ["m one", "m two", "m three"],
        discussion: ["d one", "d two", "d three"],
        conclusion: ["c one"],
      },
    },
    novelty: "the claim as it currently stands",
  };
  const patch = { steps: [{ index: 1, text: "a repaired opening step" }] };

  assert.equal(
    validator.validate(patch, schema, {
      taskId: "t-2",
      kind: "brainstorm.redeveloper",
      input: {},
      revisionBase: base,
    }).success,
    true,
    "a patch that leaves the whole consistent is accepted",
  );
  // Tasks that carry no base — every non-revision task, and the full-emission
  // contract older bundles use — are untouched by the check.
  assert.equal(
    validator.validate(patch, schema, { taskId: "t-3", kind: "brainstorm.redeveloper", input: {} })
      .success,
    true,
  );

  // A base that is not itself a valid whole must not be charged to the patch:
  // the reviser cannot repair a fault it did not cause, and failing here would
  // spend every validation attempt before the fold ever reports the real one.
  const brokenBase = { ...base, cot: ["only one step"] };
  assert.equal(
    validator.validate(patch, schema, {
      taskId: "t-4",
      kind: "brainstorm.redeveloper",
      input: {},
      revisionBase: brokenBase,
    }).success,
    true,
    "an unsound base is left to the fold, not blamed on the revision",
  );
});

test("a four-part patch gets the same pre-write merge check a string patch gets", () => {
  // The hole both patch forms share is the cross-field rule the wire schema
  // cannot judge. Checking it for one form and not the other would leave a
  // parts run dying at the fold on a fault nothing ever told it about — the
  // exact dead end the string form's check was added to close.
  const validator = new ContentArtifactOutputValidator();
  const schema = { title: "redevelopmentPatchParts" };
  const paragraph = "One paragraph of finished text that stands alone and says something real.";
  const step = (n: number): JsonObject => ({
    part1: `Step ${n}: the claim it makes.`,
    part2: `Step ${n}: the ground under the claim.`,
    part3: `Step ${n}: what follows once the ground holds.`,
    part4: `Step ${n}: what it leaves open.`,
  });
  const base = {
    cot: [step(1), step(2), step(3)],
    output: {
      type: "research obstacle",
      solution: {
        problemFraming: paragraph,
        diagnosis: [{ cause: "A concrete cause statement.", rationale: paragraph }],
        priorAttempts: [],
        candidateSolutions: [
          { approach: "An approach.", mechanism: paragraph, expectedEffect: paragraph, risk: paragraph },
        ],
        recommendation: paragraph,
        validationPlan: ["A validation step that is concrete."],
        residualRisks: ["A residual risk worth naming."],
      },
    },
  };
  // Legal as a patch on its own; a solution-shaped output may carry no novelty.
  const patch = { steps: [{ index: 2, ...step(2) }], novelty: paragraph };

  assert.equal(
    validator.validate(patch, schema).success,
    true,
    "on its own the four-part patch is well-formed: the whole is what it contradicts",
  );
  const checked = validator.validate(patch, schema, {
    taskId: "t-5",
    kind: "brainstorm.redeveloper",
    input: {},
    revisionBase: base,
  });
  assert.equal(checked.success, false, "merged against its base, the four-part patch is incoherent");
  assert.ok(
    checked.success === false && checked.issues.some((issue) => issue.includes("must omit novelty")),
    "the feedback names the rule the merged whole breaks",
  );

  // An out-of-range step is reported as feedback the model can act on, not as
  // a validation pass followed by a dead task at the fold.
  const overshoot = validator.validate({ steps: [{ index: 9, ...step(9) }] }, schema, {
    taskId: "t-6",
    kind: "brainstorm.redeveloper",
    input: {},
    revisionBase: base,
  });
  assert.equal(overshoot.success, false);
  assert.ok(
    overshoot.success === false &&
      overshoot.issues.some((issue) => /step 9, but the chain has 3 steps/.test(issue)),
    "the patch is told which step it named and how long the chain is",
  );

  // The mirror of the string case: a patch that fits is accepted, and a base
  // recorded in the OTHER chain form is left alone rather than blamed.
  const paperBase = {
    cot: [step(1), step(2), step(3)],
    output: {
      type: "research idea",
      paper: {
        abstract: ["a one", "a two", "a three"],
        introduction: ["i one", "i two", "i three"],
        method: ["m one", "m two", "m three"],
        discussion: ["d one", "d two", "d three"],
        conclusion: ["c one"],
      },
    },
    novelty: "the claim as it currently stands",
  };
  assert.equal(
    validator.validate({ steps: [{ index: 1, ...step(1) }] }, schema, {
      taskId: "t-7",
      kind: "brainstorm.redeveloper",
      input: {},
      revisionBase: paperBase,
    }).success,
    true,
    "a four-part patch that leaves the whole consistent is accepted",
  );
  assert.equal(
    validator.validate({ steps: [{ index: 1, ...step(1) }] }, schema, {
      taskId: "t-8",
      kind: "brainstorm.redeveloper",
      input: {},
      revisionBase: { ...paperBase, cot: ["a string chain", "not a parts chain", "third"] },
    }).success,
    true,
    "a base in the other chain form is left to the fold, never charged to the patch",
  );
});
