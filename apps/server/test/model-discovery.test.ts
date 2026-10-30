import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ModelOption, ServerSettings } from "@brainstorm-agentic/protocol";
import { ModelDiscovery, anthropicModelOption, claudeModelOptions, cursorModelOption, discoverProviderModels, mergeClaudeModelOptions, validateStageCapabilities } from "../src/model-discovery.js";
import { defaultServerSettings } from "../src/settings.js";

const context = { provider: "anthropic", secret: "test-private-credential" } as const;
const model: ModelOption = { id: "precise", label: "Precise", capabilities: { effortLevels: ["low", "high"], adaptiveThinking: true, thinkingCanBeDisabled: true } };
function workspace(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "brain-model-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("catalog reads and restarted hosts use stored options without provider requests", async (t) => {
  const root = workspace(t); let calls = 0;
  const discover = async () => { calls++; return { models: [model] }; };
  const cache = new ModelDiscovery(root, discover);
  assert.equal(cache.read(context).source, "fallback");
  assert.equal(calls, 0);
  const snapshot = await cache.refresh(context);
  assert.equal(snapshot.stale, false);
  for (let i = 0; i < 5; i++) assert.deepEqual(cache.read(context).models, [model]);
  assert.equal(calls, 1);
  const restarted = new ModelDiscovery(root, discover);
  assert.deepEqual(restarted.read(context).models, [model]);
  assert.equal(restarted.read(context).stale, true);
  assert.equal(calls, 1);
  const disk = readFileSync(join(root, "model-options-cache.json"), "utf8");
  assert.equal(disk.includes(context.secret), false);
  if (process.platform !== "win32") assert.equal(statSync(join(root, "model-options-cache.json")).mode & 0o777, 0o600);
});

test("launch refreshes coalesce while pending and fetch again for the next launch", async (t) => {
  let calls = 0; let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const cache = new ModelDiscovery(workspace(t), async () => { calls++; await held; return { models: [model] }; });
  const first = cache.refresh(context); const concurrent = cache.refresh(context);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, concurrent]);
  await cache.refresh(context);
  assert.equal(calls, 2);
});

test("catalog keys isolate providers, credentials and API endpoints", async (t) => {
  const cache = new ModelDiscovery(workspace(t), async () => ({ models: [model] }));
  await cache.refresh(context);
  for (const changed of [{ ...context, secret: "another-account" }, { ...context, baseUrl: "https://another.example" }, { ...context, provider: "claude-agent" as const }]) {
    assert.notEqual(cache.key(context), cache.key(changed));
    assert.equal(cache.read(changed).source, "fallback");
    assert.equal(cache.read(changed).models.some((entry) => entry.id === model.id), false);
  }
});

test("discovery failures retain last verified options and redact provider errors", async (t) => {
  let fail = false;
  const cache = new ModelDiscovery(workspace(t), async () => {
    if (fail) throw new Error(`Unauthorized Bearer ${context.secret}`);
    return { models: [model] };
  });
  const original = await cache.refresh(context); fail = true;
  const stale = await cache.refresh(context);
  assert.deepEqual(stale.models, original.models);
  assert.equal(stale.fetchedAt, original.fetchedAt);
  assert.equal(stale.source, "provider");
  assert.equal(stale.stale, true);
  assert.ok(stale.error);
  assert.equal(JSON.stringify(stale).includes(context.secret), false);
  assert.equal(original.stale, false, "already captured run snapshots must not change");
});

test("a hung provider is aborted and does not prevent a later refresh", async (t) => {
  let calls = 0; let signal: AbortSignal | undefined;
  const cache = new ModelDiscovery(workspace(t), async (_context, currentSignal) => {
    signal = currentSignal;
    if (++calls === 1) return new Promise<never>(() => {});
    return { models: [model] };
  }, 15);
  assert.equal((await cache.refresh(context)).stale, true);
  assert.equal(signal?.aborted, true);
  assert.equal((await cache.refresh(context)).stale, false);
  assert.equal(calls, 2);
});

test("corrupt persisted capabilities cannot enable unsupported controls", (t) => {
  const root = workspace(t);
  const key = new ModelDiscovery(root).key(context);
  writeFileSync(join(root, "model-options-cache.json"), JSON.stringify({ schemaVersion: 1, entries: {
    [key]: { provider: "anthropic", fetchedAt: 1000, models: [{ ...model, capabilities: { effortLevels: ["unlimited"], adaptiveThinking: true } }, null, { id: 123, label: "bad" }] },
  } }));
  const catalog = new ModelDiscovery(root).read(context);
  assert.deepEqual(catalog.models, [{ id: model.id, label: model.label }]);
});

test("returned snapshots cannot mutate the stored catalog", async (t) => {
  const cache = new ModelDiscovery(workspace(t), async () => ({ models: [model] }));
  const first = await cache.refresh(context);
  (first.models as ModelOption[]).splice(0);
  assert.deepEqual(cache.read(context).models, [model]);
  const read = cache.read(context);
  (read.models[0]!.capabilities!.effortLevels as string[]).push("max");
  assert.deepEqual(cache.read(context).models[0]!.capabilities!.effortLevels, ["low", "high"]);
});

test("deployment fallback models never claim unverified capabilities", (t) => {
  const root = workspace(t);
  writeFileSync(join(root, "model-catalog.json"), JSON.stringify({ anthropic: [model] }));
  const fallback = new ModelDiscovery(root).read(context);
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(fallback.models, [{ id: model.id, label: model.label }]);
});

test("unknown cache schema versions cannot supply capability metadata", (t) => {
  const root = workspace(t);
  const key = new ModelDiscovery(root).key(context);
  writeFileSync(join(root, "model-options-cache.json"), JSON.stringify({ schemaVersion: 99, entries: {
    [key]: { provider: "anthropic", fetchedAt: 1000, models: [model] },
  } }));
  assert.equal(new ModelDiscovery(root).read(context).source, "fallback");
});

test("Anthropic capabilities use explicit effort and disabled-thinking metadata", () => {
  const raw = { id: "new-model", display_name: "New model", capabilities: { effort: { supported: true, low: { supported: true }, max: { supported: false }, xhigh: { supported: true } }, thinking: { types: { adaptive: { supported: true }, disabled: { supported: false } } } } };
  assert.deepEqual(anthropicModelOption(raw)?.capabilities, { effortLevels: ["low", "xhigh"], adaptiveThinking: true, thinkingCanBeDisabled: false });
  const unknownOff = { ...raw, capabilities: { ...raw.capabilities, thinking: { types: { adaptive: { supported: true } } } } };
  assert.equal(anthropicModelOption(unknownOff)?.capabilities?.thinkingCanBeDisabled, undefined);
  assert.equal(anthropicModelOption({ id: "unknown", capabilities: null })?.capabilities, undefined);
});

test("Claude aliases expose their canonical model and preserve capability unknowns", () => {
  const options = claudeModelOptions([{ value: "sonnet", resolvedModel: "claude-sonnet-next", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsAdaptiveThinking: true }, { value: "legacy", supportsEffort: false, supportsAdaptiveThinking: false }]);
  const canonical = options.find((entry) => entry.id === "claude-sonnet-next");
  assert.deepEqual(canonical?.capabilities?.effortLevels, ["low", "high"]);
  assert.equal(canonical?.capabilities?.thinkingCanBeDisabled, undefined);
  assert.ok(canonical?.aliases?.includes("sonnet"));
  assert.deepEqual(options.find((entry) => entry.id === "legacy")?.capabilities?.effortLevels, []);
});

test("Claude discovery combines all API models with SDK aliases and authoritative thinking support", () => {
  const sdk = claudeModelOptions([{ value: "sonnet", resolvedModel: "precise[1m]", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"], supportsAdaptiveThinking: true }]);
  const merged = mergeClaudeModelOptions(sdk, [model, { id: "newly-released", label: "New model" }]);
  assert.deepEqual(new Set(merged.map((entry) => entry.id)), new Set(["precise", "newly-released", "sonnet", "precise[1m]"]));
  for (const id of ["sonnet", "precise[1m]"]) assert.deepEqual(merged.find((entry) => entry.id === id)?.capabilities, model.capabilities);
  const mandatory = mergeClaudeModelOptions(sdk, [{ ...model, capabilities: { ...model.capabilities!, thinkingCanBeDisabled: false } }]);
  assert.equal(mandatory.find((entry) => entry.id === "sonnet")?.capabilities?.thinkingCanBeDisabled, false);
});

test("combined Claude capabilities retain SDK restrictions and tolerate an unavailable metadata endpoint", () => {
  const sdk: ModelOption[] = [{ ...model, capabilities: { effortLevels: ["low"], adaptiveThinking: false } }];
  const merged = mergeClaudeModelOptions(sdk, [model]);
  assert.deepEqual(merged[0]!.capabilities, { effortLevels: ["low"], adaptiveThinking: false, thinkingCanBeDisabled: true });
  assert.deepEqual(mergeClaudeModelOptions(sdk, []), sdk);
  assert.deepEqual(mergeClaudeModelOptions([], [model]), [model]);
  const sdkRequiredThinking = [{ ...model, capabilities: { ...model.capabilities!, thinkingCanBeDisabled: false } }];
  assert.equal(mergeClaudeModelOptions(sdkRequiredThinking, [model])[0]!.capabilities!.thinkingCanBeDisabled, false);
  for (const restriction of [{ supportsEffort: false }, { supportsAdaptiveThinking: false }, { supportsThinkingDisabled: false }]) {
    const partial = claudeModelOptions([{ value: model.id, ...restriction }]);
    const caps = mergeClaudeModelOptions(partial, [model])[0]!.capabilities!;
    if ("supportsEffort" in restriction) assert.deepEqual(caps.effortLevels, []);
    if ("supportsAdaptiveThinking" in restriction) assert.equal(caps.adaptiveThinking, false);
    if ("supportsThinkingDisabled" in restriction) assert.equal(caps.thinkingCanBeDisabled, false);
  }
});

test("Cursor capability mapping exposes exact offered tiers, never promotes high to max", () => {
  const option = cursorModelOption({ id: "cursor-model", parameters: [{ id: "reasoning_effort", values: [{ value: "low" }, { value: "extra-high" }] }, { id: "thinking", values: [{ value: "true" }, { value: "false" }] }] });
  assert.deepEqual(option.capabilities, { effortLevels: ["low", "xhigh"], adaptiveThinking: true, thinkingCanBeDisabled: true });
  assert.equal(cursorModelOption({ id: "unknown" }).capabilities, undefined);
});

test("Anthropic discovery follows every model page without generating a response", async (t) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    const next = request.url?.includes("after_id=first");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: next ? "second" : "first", display_name: next ? "Second" : "First", type: "model", created_at: "2026-01-01T00:00:00Z", capabilities: null }], has_more: !next, first_id: next ? "second" : "first", last_id: next ? "second" : "first" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const result = await discoverProviderModels({ ...context, baseUrl: `http://127.0.0.1:${address.port}` }, new AbortController().signal);
  assert.deepEqual(result.models.map((entry) => entry.id), ["first", "second"]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.startsWith("/v1/models?")));
});

test("stage validation uses actual stage defaults and rejects newly unavailable settings", () => {
  const base = defaultServerSettings();
  const settings: ServerSettings = { ...base, llm: { ...base.llm, provider: "anthropic", model: "global", modelsByRoute: { reasoning: model.id } } };
  const catalog = { provider: "anthropic" as const, fetchedAt: 1, source: "provider" as const, stale: false, models: [model] };
  const stages = [{ id: "classify-input", label: "Classify input", description: "", route: "reasoning" }];
  assert.doesNotThrow(() => validateStageCapabilities(settings, { "classify-input": { effort: "low", thinking: "disabled" } }, catalog, stages));
  assert.throws(() => validateStageCapabilities(settings, { "classify-input": { effort: "max" } }, catalog, stages), /Classify input.*max effort/);
  assert.throws(() => validateStageCapabilities(settings, { "classify-input": { model: "removed" } }, catalog, stages), /Classify input.*removed.*not available/);
  const changed = { ...catalog, models: [{ ...model, capabilities: { ...model.capabilities!, thinkingCanBeDisabled: false } }] };
  assert.throws(() => validateStageCapabilities(settings, { "classify-input": { thinking: "disabled" } }, changed, stages), /does not advertise disabling thinking/);
});
