import assert from "node:assert/strict";
import test from "node:test";

import { artifactSchemas, type BindValue } from "@brainstorm-agentic/content";
import {
  Scope,
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

test("panel.select implements stable chunked round-robin semantics", () => {
  const experts = {
    departments: [
      {
        name: "A",
        umbrellas: [
          { name: "A1", subfields: ["a1"] },
          { name: "A2", subfields: ["a2"] },
          { name: "A3", subfields: ["a3"] },
        ],
      },
      {
        name: "B",
        umbrellas: [
          { name: "B1", subfields: ["b1"] },
          { name: "B2", subfields: ["b2"] },
          { name: "B3", subfields: ["b3"] },
        ],
      },
      {
        name: "C",
        umbrellas: [
          { name: "C1", subfields: ["c1"] },
          { name: "C2", subfields: ["c2"] },
        ],
      },
    ],
  };

  assert.deepEqual(
    selectPanel(experts, 7, 2).members.map((member) => [
      member.id,
      member.department,
      member.umbrella,
    ]),
    [
      ["member-1", "A", "A1"],
      ["member-2", "A", "A2"],
      ["member-3", "B", "B1"],
      ["member-4", "B", "B2"],
      ["member-5", "C", "C1"],
      ["member-6", "C", "C2"],
      ["member-7", "A", "A3"],
    ],
  );
  assert.deepEqual(
    selectPanel(experts, 5, 1).members.map((member) => member.umbrella),
    ["A1", "B1", "C1", "A2", "B2"],
  );
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
  assert.match(request.system ?? "", /Deployment policy[\s\S]*Rendered content instructions/);
  assert.equal(request.responseFormat?.type, "jsonSchema");

  const value = {
    type: "research question",
    title: "Title",
    question: "Question",
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
