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

test("panel.select seats umbrellas by j times the sum of their subfield counts", () => {
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
          }, // new j = 7 * (3+1) = 28
          {
            name: "Generative Models",
            count: 2,
            subfields: [{ name: "diffusion models", count: 4 }],
          }, // new j = 2 * 4 = 8
        ],
      },
      {
        name: "Mathematics",
        count: 1,
        umbrellas: [
          {
            name: "Optimization",
            count: 5,
            subfields: [
              { name: "optimal transport", count: 7 },
              { name: "bilevel programming", count: 2 },
            ],
          }, // new j = 5 * (7+2) = 45 — department k plays no role
          {
            name: "Numerical Analysis",
            count: 4,
            subfields: [{ name: "various topics under Numerical Analysis", count: 2 }],
          }, // new j = 4 * 2 = 8, tied with Generative Models but later in tree order
        ],
      },
    ],
  };

  assert.deepEqual(
    selectPanel(experts, 3).members,
    [
      {
        id: "member-1",
        department: "Mathematics",
        umbrella: "Optimization",
        // A seat carries every subfield of its umbrella.
        subfields: ["optimal transport", "bilevel programming"],
      },
      {
        id: "member-2",
        department: "Computer Science",
        umbrella: "Graph Neural Networks",
        subfields: ["graph structure learning", "latent graph inference"],
      },
      // 8-point tie: Generative Models appears earlier in tree order.
      {
        id: "member-3",
        department: "Computer Science",
        umbrella: "Generative Models",
        subfields: ["diffusion models"],
      },
    ],
  );
  // The catch-all leaf is a valid stated focus for a subfield-less umbrella.
  assert.deepEqual(selectPanel(experts, 4).members[3]!.subfields, [
    "various topics under Numerical Analysis",
  ]);
  // panelSize beyond the umbrella supply returns every umbrella, highest first.
  assert.equal(selectPanel(experts, 12).members.length, 4);
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
