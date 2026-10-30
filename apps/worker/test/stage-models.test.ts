import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCatalogSnapshot } from "@brainstorm-agentic/protocol";
import { ClaudeAgentExecutor } from "@brainstorm-agentic/executor-claude-agent";
import { contentRouteResolver, modelCatalogFromEnv, stageSettingsFromEnv } from "../src/stage-models.js";
import { providerConfigFromEnv } from "../src/wiring.js";

const catalog: ModelCatalogSnapshot = {
  provider: "claude-agent", fetchedAt: 123, source: "provider", stale: false,
  models: [
    { id: "large", label: "Large", capabilities: {
      effortLevels: ["low", "medium", "high", "max"], adaptiveThinking: true, thinkingCanBeDisabled: true,
    } },
    { id: "small", label: "Small", aliases: ["quick"], capabilities: {
      effortLevels: ["low", "medium"], adaptiveThinking: false, thinkingCanBeDisabled: true,
    } },
    { id: "unknown", label: "Unknown" },
  ],
};
const request = (nodeId: string, logicalRoute = "reasoning") => ({
  nodeId, logicalRoute, traits: ["extended-reasoning"], skill: "brain", capabilities: [],
});

test("different workflow stages sharing a route get independent models and execution controls", async () => {
  const resolver = contentRouteResolver({
    provider: "claude-agent", models: { reasoning: "large", writing: "small" }, defaultModel: "unknown",
    agentSdk: { effort: "max", thinking: "adaptive" }, modelCatalog: catalog,
    stageSettings: {
      "classify-input": { model: "small", effort: "low", thinking: "disabled" },
      "fact-verification": { model: "quick", effort: "medium" },
    },
  });
  assert.deepEqual(await resolver.resolve(request("classify-input")), {
    providerId: "claude-agent", modelId: "small",
    execution: { effort: "low", thinking: "disabled", supportedEffortLevels: ["low", "medium"] },
  });
  assert.deepEqual(await resolver.resolve(request("develop-idea")), {
    providerId: "claude-agent", modelId: "large",
    execution: { effort: "max", thinking: "adaptive", supportedEffortLevels: ["low", "medium", "high", "max"] },
  });
  const fact = await resolver.resolve(request("fact-verification"));
  assert.equal(fact.modelId, "quick");
  assert.equal(fact.execution?.effort, "medium");
  assert.equal(fact.execution?.thinking, undefined, "unsupported inherited adaptive thinking is omitted");
  const writing = await resolver.resolve(request("synthesize-proposal", "writing"));
  assert.equal(writing.modelId, "small");
  assert.equal(writing.execution?.effort, undefined, "unsupported global max is omitted");
});

test("unknown and fallback capability metadata never synthesize effort or adaptive thinking", async () => {
  for (const modelCatalog of [catalog, { ...catalog, source: "fallback" as const, models: [] }]) {
    const route = await contentRouteResolver({ provider: "claude-agent", defaultModel: "unknown",
      agentSdk: { effort: "max", thinking: "adaptive" }, modelCatalog,
    }).resolve(request("classify-input"));
    assert.deepEqual(route.execution, {});
  }
});

test("explicit unsupported settings and unknown provider models fail before execution", async () => {
  for (const override of [
    { model: "small", effort: "max" as const },
    { model: "small", thinking: "adaptive" as const },
    { model: "unknown", thinking: "disabled" as const },
    { model: "unavailable" },
  ]) {
    const resolver = contentRouteResolver({ provider: "claude-agent", modelCatalog: catalog,
      stageSettings: { "classify-input": override },
    });
    await assert.rejects(async () => resolver.resolve(request("classify-input")), /launch catalog/);
  }
});

test("direct API stages send only declared native effort and thinking options", async () => {
  const resolver = contentRouteResolver({ provider: "anthropic", modelCatalog: { ...catalog, provider: "anthropic" },
    stageSettings: {
      "classify-input": { model: "small", effort: "low", thinking: "disabled" },
      "develop-idea": { model: "large", effort: "high", thinking: "adaptive" },
    },
  });
  assert.deepEqual((await resolver.resolve(request("classify-input"))).providerOptions, {
    anthropic: { output_config: { effort: "low" }, thinking: { type: "disabled" } },
  });
  assert.deepEqual((await resolver.resolve(request("develop-idea"))).providerOptions, {
    anthropic: { output_config: { effort: "high" }, thinking: { type: "adaptive", display: "summarized" } },
  });
});

test("Cursor's implicit auto model resolves its own declared controls", async () => {
  const route = await contentRouteResolver({ provider: "cursor-agent", agentSdk: { effort: "low" },
    modelCatalog: { ...catalog, provider: "cursor-agent", models: [
      { id: "auto", label: "Auto", capabilities: { effortLevels: ["low"], adaptiveThinking: false } },
    ] },
  }).resolve(request("classify-input"));
  assert.equal(route.modelId, "auto");
  assert.equal(route.execution?.effort, "low");
});

test("launch environment snapshots validate provider identity and remain immutable", () => {
  const parsed = modelCatalogFromEnv({ BRAINSTORM_AGENTIC_MODEL_CATALOG: JSON.stringify(catalog) }, "claude-agent")!;
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.models[0]!.capabilities!.effortLevels));
  const stages = stageSettingsFromEnv({ BRAINSTORM_AGENTIC_STAGE_SETTINGS: JSON.stringify({ "classify-input": { model: " small ", effort: "low" } }) })!;
  assert.equal(stages["classify-input"]!.model, "small");
  assert.ok(Object.isFrozen(stages["classify-input"]));
  assert.throws(() => modelCatalogFromEnv({ BRAINSTORM_AGENTIC_MODEL_CATALOG: JSON.stringify(catalog) }, "cursor-agent"), /selected provider/);
  assert.throws(() => stageSettingsFromEnv({ BRAINSTORM_AGENTIC_STAGE_SETTINGS: '{"stage":{"effort":"extreme"}}' }), /invalid stage/);
  assert.throws(() => stageSettingsFromEnv({ BRAINSTORM_AGENTIC_STAGE_SETTINGS: '{"stage":{"unexpected":true}}' }), /invalid stage/);
  assert.throws(() => modelCatalogFromEnv({ BRAINSTORM_AGENTIC_MODEL_CATALOG: "not-json" }, "claude-agent"), /valid JSON/);
});

test("Cursor launch snapshot retains declared parameter choices without rediscovery", () => {
  const snapshot: ModelCatalogSnapshot = { ...catalog, provider: "cursor-agent", cursorModels: [
    { id: "large", aliases: ["default"], parameters: [{ id: "reasoningEffort", values: [{ value: "high" }] }] },
  ] };
  const parsed = modelCatalogFromEnv({ BRAINSTORM_AGENTIC_MODEL_CATALOG: JSON.stringify(snapshot) }, "cursor-agent")!;
  assert.deepEqual(parsed.cursorModels, snapshot.cursorModels);
  assert.ok(Object.isFrozen(parsed.cursorModels![0]!.parameters![0]!.values));
});

test("worker configuration carries the saved launch snapshot and active stage settings", async () => {
  const config = providerConfigFromEnv({
    BRAINSTORM_AGENTIC_PROVIDER: "claude-agent", BRAINSTORM_AGENTIC_MODEL: "large",
    BRAINSTORM_AGENTIC_AGENT_EFFORT: "max", BRAINSTORM_AGENTIC_AGENT_THINKING: "adaptive",
    BRAINSTORM_AGENTIC_STAGE_SETTINGS: JSON.stringify({ "classify-input": { model: "small", effort: "low" } }),
    BRAINSTORM_AGENTIC_MODEL_CATALOG: JSON.stringify(catalog),
  }, false);
  assert.equal(config.modelCatalog?.fetchedAt, 123);
  assert.equal(config.stageSettings?.["classify-input"]?.model, "small");
  const route = await contentRouteResolver(config).resolve(request("classify-input"));
  assert.equal(route.execution?.effort, "low");
  assert.equal(route.execution?.thinking, undefined);
});

test("legacy launches without a stage snapshot retain their existing executor defaults", async () => {
  const route = await contentRouteResolver({ provider: "claude-agent", defaultModel: "large" }).resolve(request("develop-idea"));
  assert.equal(route.modelId, "large");
  assert.equal(route.execution, undefined);
});

test("resuming a legacy job with an exported empty stage map preserves its saved execution settings", async () => {
  const config = providerConfigFromEnv({
    BRAINSTORM_AGENTIC_PROVIDER: "claude-agent", BRAINSTORM_AGENTIC_MODEL: "large",
    BRAINSTORM_AGENTIC_AGENT_EFFORT: "max", BRAINSTORM_AGENTIC_AGENT_THINKING: "adaptive",
    BRAINSTORM_AGENTIC_STAGE_SETTINGS: "{}",
  }, false);
  assert.equal(config.modelCatalog, undefined);
  const route = await contentRouteResolver(config).resolve(request("classify-input"));
  assert.equal(route.execution, undefined);
  const calls: Record<string, unknown>[] = [];
  const executor = new ClaudeAgentExecutor({ token: "test-token", ...config.agentSdk,
    queryFn: (input) => ({ async *[Symbol.asyncIterator]() {
      calls.push(input.options);
      yield { type: "result", subtype: "success", is_error: false, result: '{"answer":"ok"}', structured_output: { answer: "ok" } };
    } }),
  });
  const result = await executor.execute({ taskId: "legacy", kind: "classifier", input: {},
    modelRequest: { modelId: route.modelId, execution: route.execution, messages: [{ role: "user", content: [{ type: "text", text: "Classify." }] }] },
  }, { runId: "legacy-run", nodePath: "root/classify-input" });
  assert.equal(result.status, "ok");
  assert.equal(calls[0]!.effort, "max");
  assert.deepEqual(calls[0]!.thinking, { type: "adaptive", display: "omitted" });
});
