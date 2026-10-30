import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelCatalogSnapshot } from "@brainstorm-agentic/protocol";
import { geminiModelProfile } from "@brainstorm-agentic/provider-gemini";
import { SettingsStore, type GeminiConnectionInput } from "../src/settings.js";
import { geminiModelOption, ModelDiscovery, validateStageCapabilities } from "../src/model-discovery.js";
import { defaultReadinessProbes } from "../src/readiness.js";

test("new Gemini connections explicitly inherit the enabled recording default and preserve an opt-out", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-gemini-default-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir, { validateGemini: async () => {} });
  const saved = await store.put({ llm: { provider: "gemini", model: "gemini-3.8-flash", geminiApiKey: "test-key" } });
  assert.equal(saved.llm.transcript, "if-available");
  assert.equal(store.executionEnvironment({}).BRAINSTORM_AGENTIC_TRANSCRIPT, "if-available");
  await store.put({ llm: { transcript: "off" } });
  await store.put({ llm: { provider: "offline" } });
  const reconnected = await store.put({ llm: { provider: "gemini" } });
  assert.equal(reconnected.llm.transcript, "off");
});

test("Gemini credentials are verified before private persistence and never exposed in settings", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-gemini-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const verified: GeminiConnectionInput[] = [];
  const store = new SettingsStore(dir, { validateGemini: async (input) => {
    verified.push(input);
    if (input.apiKey === "rejected-key") throw new Error("verification failed");
  } });
  const saved = await store.put({ llm: { provider: "gemini", model: "gemini-3.8-flash", geminiApiKey: " test-gemini-key ", baseUrl: "https://gateway.example", transcript: "off" } });
  assert.deepEqual(verified, [{ apiKey: "test-gemini-key", model: "gemini-3.8-flash", baseUrl: "https://gateway.example" }]);
  assert.equal(saved.llm.geminiApiKeyConfigured, true);
  assert.equal(JSON.stringify(saved).includes("test-gemini-key"), false);
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8").includes("test-gemini-key"), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")).geminiApiKey, "test-gemini-key");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
  const env = store.executionEnvironment({ GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_API_KEY: "inherited", GEMINI_BASE_URL: "old", BRAINSTORM_AGENTIC_TRANSCRIPT: "if-available" });
  assert.equal(env.GEMINI_API_KEY, "test-gemini-key");
  assert.equal(env.GEMINI_BASE_URL, "https://gateway.example");
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.BRAINSTORM_AGENTIC_TRANSCRIPT, "off");
  await store.put({ llm: { transcript: "if-available" } });
  assert.equal(verified.length, 1, "recording preferences do not reverify the connection");
  await assert.rejects(store.put({ llm: { geminiApiKey: "rejected-key" } }), /verification failed/);
  assert.equal(store.getGeminiApiKey(), "test-gemini-key");
  await assert.rejects(store.put({ llm: { clearGeminiApiKey: true } }), /cannot clear/);
  await store.put({ llm: { provider: "offline", clearGeminiApiKey: true } });
  assert.equal(store.get().llm.geminiApiKeyConfigured, false);
  await assert.rejects(store.put({ llm: { geminiApiKey: "wrong-provider" } }), /select Gemini/);
});

test("Gemini transcript policy is independent of reasoning support and survives launch snapshots", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-gemini-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir, { validateGemini: async () => {} });
  await store.put({ llm: { provider: "gemini", model: "gemini-3.5-flash-lite", geminiApiKey: "test-key", transcript: "off" } });
  const catalog: ModelCatalogSnapshot = { provider: "gemini", source: "provider", stale: false, fetchedAt: 1,
    models: [geminiModelOption({ id: "gemini-3.5-flash-lite", profile: geminiModelProfile("gemini-3.5-flash-lite") }), { id: "unknown", label: "Unknown" }] };
  const stages = [{ id: "classify-input", label: "Classification", description: "" }];
  const validate = (settings: ReturnType<SettingsStore["get"]>, selections: Parameters<typeof validateStageCapabilities>[1]) => validateStageCapabilities(settings, selections, catalog, stages);
  await store.putStageModels({ provider: "gemini", stageSettings: { "classify-input": { effort: "minimal", transcript: "if-available" } } }, validate);
  await assert.rejects(store.putStageModels({ provider: "gemini", stageSettings: { "classify-input": { thinking: "disabled" } } }, validate), /disabling thinking/);
  await assert.rejects(store.putStageModels({ provider: "gemini", stageSettings: { "classify-input": { thinking: "adaptive" } } }, validate), /adaptive thinking/);
  const snapshot = await store.snapshotForLaunch(async (settings) => ({ ...settings, llm: { ...settings.llm, modelCatalog: catalog } }));
  await store.put({ llm: { transcript: "if-available" } });
  await store.putStageModels({ provider: "gemini", stageSettings: { "classify-input": { model: "unknown", transcript: "off" } } }, validate);
  const resumed = store.executionEnvironment({}, snapshot);
  assert.equal(resumed.BRAINSTORM_AGENTIC_TRANSCRIPT, "off");
  assert.deepEqual(JSON.parse(resumed.BRAINSTORM_AGENTIC_STAGE_SETTINGS!)["classify-input"], { effort: "minimal", transcript: "if-available" });
  const restored = new SettingsStore(dir).get();
  assert.equal(restored.llm.transcript, "if-available");
  assert.equal(restored.llm.stageSettingsByProvider?.gemini?.["classify-input"]?.transcript, "off");
  await assert.rejects(store.put({ llm: { transcript: "disabled" } }), /if-available or off/);
  await assert.rejects(store.putStageModels({ provider: "gemini", stageSettings: { "classify-input": { transcript: "required" } } }, validate), /if-available or off/);
  const legacy = store.executionEnvironment({ BRAINSTORM_AGENTIC_TRANSCRIPT: "off" }, { ...restored, llm: { provider: "offline" } });
  assert.equal(legacy.BRAINSTORM_AGENTIC_TRANSCRIPT, undefined);
});

test("Gemini discovery retains native effort levels and caches unknown capabilities conservatively", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-gemini-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const models = [geminiModelOption({ id: "gemini-3.5-flash-lite", profile: geminiModelProfile("gemini-3.5-flash-lite") }), geminiModelOption({ id: "future-model" })];
  assert.deepEqual(models[0]?.capabilities, { effortLevels: ["minimal", "low", "medium", "high"], adaptiveThinking: false });
  assert.equal(models[1]?.capabilities, undefined);
  const context = { provider: "gemini", secret: "private-test-key" } as const;
  let calls = 0;
  const cache = new ModelDiscovery(dir, async () => { calls++; return { models }; });
  await cache.refresh(context);
  assert.deepEqual(new ModelDiscovery(dir).read(context).models, models);
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(dir, "model-options-cache.json"), "utf8").includes(context.secret), false);
});

test("Gemini readiness uses its own credential and never falls through to offline or Claude", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "brain-gemini-ready-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir, { validateGemini: async () => {} });
  await store.put({ llm: { provider: "gemini", model: "gemini-3.8-flash", geminiApiKey: "test-key" } });
  let calls = 0;
  const unexpected = async () => { throw new Error("wrong provider"); };
  const probes = defaultReadinessProbes({ validateAnthropic: unexpected, validateClaudeAgent: unexpected, validateCursorAgent: unexpected,
    validateGemini: async ({ apiKey, model }) => { calls++; assert.equal(apiKey, "test-key"); assert.equal(model, "gemini-3.8-flash"); } });
  const result = await probes.llm({ settings: store.get(), credentials: { geminiApiKey: "test-key" }, workspace: dir, env: {}, signal: new AbortController().signal, onProgress: () => {} });
  assert.match(result.message ?? "", /Gemini/);
  assert.equal(calls, 1);
});
