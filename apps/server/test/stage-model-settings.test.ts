import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelCatalogSnapshot, ServerSettings } from "@brainstorm-agentic/protocol";
import { SettingsStore, runtimeModelCatalog } from "../src/settings.js";
import { validateStageCapabilities } from "../src/model-discovery.js";

const catalog: ModelCatalogSnapshot = { provider: "cursor-agent", fetchedAt: 100, source: "provider", stale: false,
  models: [{ id: "small", label: "Small", capabilities: { effortLevels: ["low", "medium"], adaptiveThinking: true, thinkingCanBeDisabled: true } }],
  cursorModels: [{ id: "small", parameters: [] }],
};
const stages = [{ id: "classify-input", label: "Classification", description: "", route: "reasoning" }];

test("stage validation follows runtime global, reasoning-route, and Cursor automatic defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "stage-defaults-"));
  try {
    const stored = new SettingsStore(root).get();
    const writing = [{ id: "synthesize-proposal", label: "Synthesis", description: "", route: "writing" }];
    const selection = { "synthesize-proposal": { effort: "low" as const } };
    const settings: ServerSettings = { ...stored, llm: { provider: "cursor-agent", modelsByRoute: { reasoning: "small" } } };
    assert.doesNotThrow(() => validateStageCapabilities(settings, selection, catalog, writing));
    assert.doesNotThrow(() => validateStageCapabilities({ ...settings, llm: { provider: "cursor-agent" } }, selection,
      { ...catalog, models: [{ ...catalog.models[0]!, id: "auto" }] }, writing));
    assert.throws(() => validateStageCapabilities({ ...settings, llm: { ...settings.llm, model: "global" } }, selection,
      { ...catalog, models: [...catalog.models, { id: "global", label: "Global", capabilities: { effortLevels: ["high"], adaptiveThinking: false } }] }, writing), /global.*low effort/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stage selections stay provider-specific, survive partial saves, and never verify credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "stage-settings-"));
  let verifies = 0;
  try {
    const store = new SettingsStore(root, { validateCursorAgent: async () => { verifies++; }, validateClaudeAgent: async () => { verifies++; } });
    await store.put({ llm: { provider: "cursor-agent", cursorApiKey: "test-cursor", model: "small" } });
    const validate = (settings: ServerSettings, selected: Parameters<typeof validateStageCapabilities>[1]) => validateStageCapabilities(settings, selected, catalog, stages);
    const before = verifies;
    await store.putStageModels({ provider: "cursor-agent", stageSettings: { "classify-input": { effort: "low", thinking: "disabled" }, "future-stage": { model: "future" } } }, validate);
    await assert.rejects(store.putStageModels({ provider: "cursor-agent", stageSettings: { "classify-input": { effort: "max" } } }, validate), /Classification.*max/);
    assert.equal(verifies, before);
    await store.put({ review: { maxRounds: 2 } });
    assert.equal(store.get().llm.stageSettingsByProvider?.["cursor-agent"]?.["classify-input"]?.effort, "low");
    await store.put({ llm: { provider: "claude-agent", setupToken: "test-token" } });
    await assert.rejects(store.putStageModels({ provider: "cursor-agent", stageSettings: {} }, validate), /active provider changed/);
    await store.putStageModels({ provider: "claude-agent", stageSettings: { "classify-input": { model: "sonnet" } } }, () => undefined);
    const restored = new SettingsStore(root).get();
    assert.equal(restored.llm.stageSettingsByProvider?.["cursor-agent"]?.["future-stage"]?.model, "future");
    assert.equal(restored.llm.stageSettingsByProvider?.["claude-agent"]?.["classify-input"]?.model, "sonnet");
    await store.putStageModels({ provider: "claude-agent", stageSettings: {} }, () => undefined);
    assert.deepEqual(store.get().llm.stageSettingsByProvider?.["claude-agent"], {});
    assert.ok(store.get().llm.stageSettingsByProvider?.["cursor-agent"]?.["classify-input"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("launch metadata discovery and its settings snapshot serialize against later settings saves", async () => {
  const root = mkdtempSync(join(tmpdir(), "stage-launch-lock-"));
  let enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const store = new SettingsStore(root);
    await store.put({ llm: { provider: "offline" } });
    const snapshot = store.snapshotForLaunch(async (settings) => { enter(); await hold; return { ...settings, llm: { ...settings.llm, modelCatalog: { ...catalog, provider: "offline" } } }; });
    await entered;
    const update = store.putStageModels({ provider: "offline", stageSettings: { "classify-input": { model: "later" } } }, () => undefined);
    await Promise.resolve();
    assert.equal(store.get().llm.stageSettingsByProvider, undefined);
    release();
    const launched = await snapshot; await update;
    assert.equal(launched.llm.stageSettingsByProvider, undefined);
    assert.equal(launched.llm.modelCatalog?.fetchedAt, 100);
    assert.equal(store.get().llm.stageSettingsByProvider?.offline?.["classify-input"]?.model, "later");
    assert.equal(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).llm.modelCatalog, undefined, "launch discovery is not an editable global setting");
    const env = store.executionEnvironment({ BRAINSTORM_AGENTIC_STAGE_SETTINGS: "stale", BRAINSTORM_AGENTIC_MODEL_CATALOG: "stale" }, launched);
    assert.deepEqual(JSON.parse(env.BRAINSTORM_AGENTIC_STAGE_SETTINGS!), {});
    assert.equal(JSON.parse(env.BRAINSTORM_AGENTIC_MODEL_CATALOG!).fetchedAt, 100);
    const legacy = store.executionEnvironment({ BRAINSTORM_AGENTIC_MODEL_CATALOG: "stale" }, store.get());
    assert.equal(legacy.BRAINSTORM_AGENTIC_MODEL_CATALOG, undefined);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test("worker catalog retains selected aliases and fallbacks without copying a large unused provider catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "stage-env-size-"));
  try {
    const store = new SettingsStore(root);
    const unused = Array.from({ length: 500 }, (_, i) => ({ id: `unused-${i}`, label: "Unused ".repeat(100) }));
    const settings: ServerSettings = { ...store.get(), llm: { provider: "offline", model: "default", modelsByRoute: { reasoning: "alias" },
      agentSdk: { maxTurns: 100, effort: "high", thinking: "adaptive", fallbackModel: "fallback" },
      stageSettingsByProvider: { offline: { "classify-input": { model: "small" } } },
      modelCatalog: { ...catalog, provider: "offline", models: [...unused,
        { id: "default", label: "Default" }, { id: "real-model", label: "Alias", aliases: ["alias"] }, { id: "fallback", label: "Fallback" }, ...catalog.models],
        cursorModels: [...unused.map((x) => ({ id: x.id, parameters: [{ id: "long", values: [{ value: "x".repeat(1000) }] }] })), { id: "real-model", aliases: ["alias"] }, ...catalog.cursorModels!] },
    } };
    const selected = runtimeModelCatalog(settings)!;
    assert.deepEqual(selected.models.map((x) => x.id), ["default", "real-model", "fallback", "small"]);
    assert.deepEqual(selected.cursorModels!.map((x) => x.id), ["real-model", "small"]);
    assert.equal(settings.llm.modelCatalog!.models.length, 504, "the job snapshot retains the full provider catalog");
    const env = store.executionEnvironment({}, settings);
    assert.ok(Buffer.byteLength(env.BRAINSTORM_AGENTIC_MODEL_CATALOG!) < 2000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("new direct Anthropic launches carry saved reasoning defaults while legacy snapshots retain their behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "stage-anthropic-defaults-"));
  try {
    const store = new SettingsStore(root, { validateAnthropic: async () => undefined });
    await store.put({ llm: { provider: "anthropic", apiKey: "test-key", model: "small",
      agentSdk: { maxTurns: 100, effort: "low", thinking: "disabled" } } });
    const settings = store.get();
    const legacy = store.executionEnvironment({}, settings);
    assert.equal(legacy.BRAINSTORM_AGENTIC_AGENT_EFFORT, undefined);
    assert.equal(legacy.BRAINSTORM_AGENTIC_AGENT_THINKING, undefined);
    const launched = store.executionEnvironment({ BRAINSTORM_AGENTIC_AGENT_EFFORT: "max", BRAINSTORM_AGENTIC_AGENT_THINKING: "adaptive" },
      { ...settings, llm: { ...settings.llm, modelCatalog: { ...catalog, provider: "anthropic", cursorModels: undefined } } });
    assert.equal(launched.BRAINSTORM_AGENTIC_AGENT_EFFORT, "low");
    assert.equal(launched.BRAINSTORM_AGENTIC_AGENT_THINKING, "disabled");
    assert.equal(JSON.parse(launched.BRAINSTORM_AGENTIC_MODEL_CATALOG!).provider, "anthropic");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
