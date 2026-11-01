import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCatalogSnapshot } from "@brainstorm-agentic/protocol";
import { ClaudeAgentExecutor } from "@brainstorm-agentic/executor-claude-agent";
import { contentRouteResolver, modelCatalogFromEnv, stageSettingsFromEnv } from "../src/stage-models.js";
import { modelsByRouteFromEnv, providerConfigFromEnv } from "../src/wiring.js";

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

const geminiRouteCatalog: ModelCatalogSnapshot = {
  provider: "gemini", fetchedAt: 123, source: "provider", stale: false,
  models: [
    { id: "gemini-flash", label: "Flash" },
    { id: "gemini-pro", label: "Pro", aliases: ["gemini-pro-latest"] },
  ],
};

test("an explicit route snapshot clears inherited legacy models while preserving Gemini stage choices", async () => {
  const config = providerConfigFromEnv({
    BRAINSTORM_AGENTIC_PROVIDER: "gemini",
    BRAINSTORM_AGENTIC_MODEL: "gemini-flash",
    BRAINSTORM_AGENTIC_MODEL_REASONING: "claude-sonnet-5",
    BRAINSTORM_AGENTIC_MODEL_WRITING: "claude-sonnet-5",
    BRAINSTORM_AGENTIC_MODELS_BY_ROUTE: "{}",
    BRAINSTORM_AGENTIC_MODEL_CATALOG: JSON.stringify(geminiRouteCatalog),
    BRAINSTORM_AGENTIC_STAGE_SETTINGS: JSON.stringify({ "develop-idea": { model: "gemini-pro-latest" } }),
  }, false);
  assert.equal(config.models, undefined);
  const resolver = contentRouteResolver(config);
  assert.equal((await resolver.resolve(request("process-input"))).modelId, "gemini-flash");
  assert.equal((await resolver.resolve(request("synthesize-proposal", "writing"))).modelId, "gemini-flash");
  assert.equal((await resolver.resolve(request("develop-idea"))).modelId, "gemini-pro-latest");
});

test("nonempty route snapshots replace legacy variables; legacy CLI launches keep their routing", async () => {
  const legacy = {
    BRAINSTORM_AGENTIC_MODEL_REASONING: "large",
    BRAINSTORM_AGENTIC_MODEL_WRITING: "small",
  };
  assert.deepEqual(modelsByRouteFromEnv(legacy), { reasoning: "large", writing: "small" });
  assert.deepEqual(modelsByRouteFromEnv({ ...legacy,
    BRAINSTORM_AGENTIC_MODELS_BY_ROUTE: '{"custom-route":"gemini-pro"}',
  }), { "custom-route": "gemini-pro" });
  const config = providerConfigFromEnv({ ...legacy, BRAINSTORM_AGENTIC_PROVIDER: "anthropic" }, false);
  assert.equal((await contentRouteResolver(config).resolve(request("process-input"))).modelId, "large");
  assert.equal((await contentRouteResolver(config).resolve(request("synthesize-proposal", "writing"))).modelId, "small");
});

test("every effective model must belong to the launch catalog before an API request", async () => {
  for (const selection of [
    { defaultModel: "claude-sonnet-5" },
    { defaultModel: "gemini-flash", models: { reasoning: "claude-sonnet-5" } },
    { defaultModel: "gemini-flash", stageSettings: { "process-input": { model: "claude-sonnet-5" } } },
  ]) {
    const resolver = contentRouteResolver({ provider: "gemini", modelCatalog: geminiRouteCatalog, ...selection });
    await assert.rejects(async () => resolver.resolve(request("process-input")), /claude-sonnet-5.*gemini provider's launch catalog/);
  }
  const resolver = contentRouteResolver({ provider: "gemini", defaultModel: "gemini-flash",
    models: { reasoning: "gemini-pro" }, modelCatalog: geminiRouteCatalog,
    stageSettings: { "process-input": { model: "gemini-flash" } },
  });
  assert.equal((await resolver.resolve(request("process-input"))).modelId, "gemini-flash");
  assert.equal((await resolver.resolve(request("develop-idea"))).modelId, "gemini-pro");
  const discoveryUnavailable = contentRouteResolver({ provider: "gemini", defaultModel: "gemini-new",
    modelCatalog: { ...geminiRouteCatalog, source: "fallback", stale: true, models: [] },
  });
  assert.equal((await discoveryUnavailable.resolve(request("process-input"))).modelId, "gemini-new");
});

test("stale provider catalogs preserve inherited model choices while retaining explicit-stage validation", async () => {
  const staleCatalog = { ...geminiRouteCatalog, stale: true };
  for (const selection of [
    { defaultModel: "gemini-new" },
    { defaultModel: "gemini-flash", models: { reasoning: "gemini-new" } },
  ]) {
    const resolver = contentRouteResolver({ provider: "gemini", modelCatalog: staleCatalog, ...selection });
    assert.equal((await resolver.resolve(request("process-input"))).modelId, "gemini-new");
  }
  const resolver = contentRouteResolver({ provider: "gemini", defaultModel: "gemini-flash", modelCatalog: staleCatalog,
    stageSettings: { "process-input": { model: "gemini-new" } },
  });
  await assert.rejects(async () => resolver.resolve(request("process-input")), /Stage.*gemini-new.*launch catalog/);
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
    effort: config.agentSdk?.effort === "minimal" ? undefined : config.agentSdk?.effort,
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

test("transcript overrides are independent of reasoning support and preserve stage precedence", async () => {
  const resolver = contentRouteResolver({ provider: "claude-agent", defaultModel: "large", modelCatalog: catalog,
    agentSdk: { effort: "high", thinking: "adaptive" }, transcript: "off",
    stageSettings: { "classify-input": { model: "unknown", transcript: "if-available" } },
  });
  assert.deepEqual((await resolver.resolve(request("classify-input"))).execution, { transcript: "if-available" });
  assert.deepEqual((await resolver.resolve(request("develop-idea"))).execution, {
    transcript: "off", effort: "high", thinking: "adaptive", supportedEffortLevels: ["low", "medium", "high", "max"],
  });
});

test("Anthropic transcript display changes without turning adaptive reasoning off", async () => {
  for (const transcript of ["off", "if-available"] as const) {
    const resolver = contentRouteResolver({ provider: "anthropic", defaultModel: "large",
      modelCatalog: { ...catalog, provider: "anthropic" }, agentSdk: { thinking: "adaptive" }, transcript,
    });
    const route = await resolver.resolve({ ...request("classify-input"), traits: [] });
    assert.equal(route.execution?.thinking, "adaptive");
    assert.deepEqual(route.providerOptions?.anthropic?.thinking, { type: "adaptive", display: transcript === "off" ? "omitted" : "summarized" });
  }
});

test("Gemini stages map native minimal effort and disabled reasoning separately from transcripts", async () => {
  const geminiCatalog: ModelCatalogSnapshot = { provider: "gemini", fetchedAt: 123, source: "provider", stale: false,
    models: [
      { id: "gemini-3.5-flash-lite", label: "Flash Lite", capabilities: {
        effortLevels: ["minimal", "low", "medium", "high"], adaptiveThinking: false, thinkingCanBeDisabled: false,
      } },
      { id: "gemini-2.5-flash-lite", label: "Legacy Lite", capabilities: {
        effortLevels: [], adaptiveThinking: false, thinkingCanBeDisabled: true,
      } },
      { id: "gemini-future", label: "Unknown capabilities" },
    ],
  };
  const resolver = contentRouteResolver({ provider: "gemini", modelCatalog: geminiCatalog,
    agentSdk: { effort: "max", thinking: "adaptive" }, transcript: "if-available",
    stageSettings: {
      "classify-input": { model: "gemini-3.5-flash-lite", effort: "minimal", transcript: "off" },
      "develop-idea": { model: "gemini-2.5-flash-lite", thinking: "disabled" },
      "fact-verification": { model: "gemini-future" },
    },
  });
  const classifier = await resolver.resolve(request("classify-input"));
  assert.equal(classifier.providerId, "gemini");
  assert.equal(classifier.execution?.effort, "minimal");
  assert.equal(classifier.execution?.thinking, undefined);
  assert.deepEqual(classifier.providerOptions, { gemini: { includeThoughts: false, thinkingLevel: "minimal" } });
  const legacy = await resolver.resolve(request("develop-idea"));
  assert.deepEqual(legacy.providerOptions, { gemini: { includeThoughts: true, thinkingBudget: 0 } });
  const unknown = await resolver.resolve(request("fact-verification"));
  assert.deepEqual(unknown.execution, { transcript: "if-available" });
  assert.deepEqual(unknown.providerOptions, { gemini: { includeThoughts: true } });
  for (const override of [{ effort: "max" as const }, { thinking: "disabled" as const }]) {
    await assert.rejects(async () => contentRouteResolver({ provider: "gemini", modelCatalog: geminiCatalog,
      stageSettings: { "classify-input": { model: "gemini-3.5-flash-lite", ...override } },
    }).resolve(request("classify-input")), /launch catalog/);
  }
});

test("worker environment preserves transcript policy and validates native minimal stage effort", () => {
  const stages = stageSettingsFromEnv({ BRAINSTORM_AGENTIC_STAGE_SETTINGS: JSON.stringify({
    "classify-input": { model: "gemini-3.5-flash-lite", effort: "minimal", transcript: "off" },
  }) })!;
  assert.deepEqual(stages["classify-input"], { model: "gemini-3.5-flash-lite", effort: "minimal", transcript: "off" });
  assert.ok(Object.isFrozen(stages["classify-input"]));
  for (const transcript of ["required", "adaptive", true, null]) {
    assert.throws(() => stageSettingsFromEnv({ BRAINSTORM_AGENTIC_STAGE_SETTINGS: JSON.stringify({ stage: { transcript } }) }), /invalid stage/);
  }
  for (const transcript of ["off", "if-available"] as const) {
    const config = providerConfigFromEnv({ BRAINSTORM_AGENTIC_PROVIDER: "gemini", BRAINSTORM_AGENTIC_TRANSCRIPT: transcript }, false);
    assert.equal(config.provider, "gemini");
    assert.equal(config.transcript, transcript);
    assert.equal(providerConfigFromEnv({ BRAINSTORM_AGENTIC_TRANSCRIPT: transcript }, true).transcript, transcript);
  }
});

test("a legacy transcript-only selection preserves Claude's existing reasoning defaults", async () => {
  for (const transcript of ["off", "if-available"] as const) {
    const route = await contentRouteResolver({ provider: "claude-agent", defaultModel: "large", transcript }).resolve(request("develop-idea"));
    const calls: Record<string, unknown>[] = [];
    const executor = new ClaudeAgentExecutor({ token: "test-token", queryFn: (input) => ({ async *[Symbol.asyncIterator]() {
      calls.push(input.options);
      yield { type: "result", subtype: "success", is_error: false, result: '{"answer":"ok"}', structured_output: { answer: "ok" } };
    } }) });
    const result = await executor.execute({ taskId: "legacy-transcript", kind: "classifier", input: {},
      modelRequest: { modelId: route.modelId, execution: route.execution, messages: [{ role: "user", content: [{ type: "text", text: "Classify." }] }] },
    }, { runId: "legacy-transcript", nodePath: "root/classify-input" });
    assert.equal(result.status, "ok");
    assert.equal(calls[0]!.effort, "high");
    assert.deepEqual(calls[0]!.thinking, { type: "adaptive", display: transcript === "off" ? "omitted" : "summarized" });
  }
});
