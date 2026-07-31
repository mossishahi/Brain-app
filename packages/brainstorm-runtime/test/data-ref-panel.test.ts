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

  // Departments outrank everything beneath them (their Σ dominates), so the
  // top of the queue seats one member per department, each through its
  // highest-cxr umbrella — the seat's focuses UNION the umbrella term with
  // its subfields.
  assert.deepEqual(selectPanel(experts, 3).members, [
    {
      id: "member-1",
      department: "Physics",
      umbrella: "Quantum Optics",
      subfields: ["Quantum Optics", "photon counting"],
    },
    {
      id: "member-2",
      department: "Computer Science",
      umbrella: "Machine Learning",
      subfields: ["Machine Learning", "representation learning"],
    },
    {
      id: "member-3",
      department: "Biology",
      umbrella: "Systems Biology",
      subfields: ["Systems Biology", "network inference"],
    },
  ]);

  // Beyond the departments, the queue continues with the remaining
  // umbrellas (level 3): a seat carries the umbrella's own subfields only,
  // and consumes the branch's level-4 entries.
  const five = selectPanel(experts, 5).members;
  assert.deepEqual(five[3], {
    id: "member-4",
    department: "Physics",
    umbrella: "Condensed Matter",
    subfields: ["transport", "Chip Morphology"],
  });
  assert.deepEqual(five[4], {
    id: "member-5",
    department: "Biology",
    umbrella: "Biophysics",
    subfields: ["single-molecule methods"],
  });
  // Queue exhaustion: every level-4 entry was consumed by its branch's seat.
  assert.equal(selectPanel(experts, 12).members.length, 5);
});

test("panel.select seats a topic directly when it tops the queue, and never duplicates a seat", () => {
  // Hand-made non-monotone values (an artifact can carry them even though
  // the bridge never produces them): the "hot" topic outranks its own
  // umbrella, so it seats as a single-focus member (level-4 case). The
  // umbrella and its remaining topics are then skipped — one member per
  // (department, umbrella) — and a department whose umbrellas are all
  // consumed seats nobody without spending capacity.
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
    { id: "member-2", department: "E", umbrella: "V", subfields: ["V", "x"] },
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
    { id: "member-3", department: "E", umbrella: "V", subfields: ["V", "x"] },
  ]);
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
