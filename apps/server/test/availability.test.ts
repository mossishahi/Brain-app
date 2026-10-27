import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { ServerSettings } from "@brainstorm-agentic/protocol";
import type { ProviderFetch } from "@brainstorm-agentic/host-tools";

import {
  AVAILABILITY_COOLDOWN_MS,
  AvailabilityService,
  TOOL_IDS,
  affectedTools,
  deriveEffectiveOrder,
  redactSecrets,
  stateFromError,
  type AvailabilityReport,
  type ToolState,
} from "../src/availability.js";
import { SettingsStore, availabilitySettingsOf } from "../src/settings.js";
import { searxngDir } from "../src/searxng-launcher.js";
import { startBrainServer, type RunningBrainServer } from "../src/server.js";
import { startTestRegistry } from "./mcp-registry.js";

/* ------------------------------------------------------------------------ */
/* helpers                                                                   */
/* ------------------------------------------------------------------------ */

function tempRoot(prefix = "brain-availability-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A clock that only moves when told to (and 1 ms per read, so latencies are non-zero). */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => {
      now += 1;
      return now;
    },
    advance: (ms: number) => {
      now += ms;
    },
    read: () => now,
  };
}

interface FakeResponse {
  readonly status: number;
  readonly body: string;
}

const ATTENTION_FEED = `<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention Is All You Need</title><published>2017-06-12T17:57:34Z</published></entry></feed>`;

/** Answers every probe's known-answer request the way the real services do. */
function fakeAnswers(url: string): FakeResponse | undefined {
  const host = new URL(url).hostname;
  if (host === "api.tavily.com") {
    return { status: 200, body: JSON.stringify({ results: [{ title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762", content: "The dominant sequence transduction models" }] }) };
  }
  if (host === "api.search.brave.com") {
    return { status: 200, body: JSON.stringify({ web: { results: [{ title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762", description: "paper" }] } }) };
  }
  if (host === "api.crossref.org") {
    return { status: 200, body: JSON.stringify({ message: { DOI: "10.1038/nature14539", title: ["Deep learning"], issued: { "date-parts": [[2015, 5, 27]] } } }) };
  }
  if (host === "export.arxiv.org") return { status: 200, body: ATTENTION_FEED };
  if (host === "api.semanticscholar.org") return { status: 200, body: JSON.stringify({ title: "Attention Is All You Need" }) };
  if (host === "www.ebi.ac.uk") {
    return { status: 200, body: JSON.stringify({ resultList: { result: [{ title: "Deep learning.", doi: "10.1038/nature14539" }] } }) };
  }
  if (host === "api.core.ac.uk") return { status: 200, body: JSON.stringify({ results: [{ title: "Deep learning" }] }) };
  if (host === "api.opencitations.net") {
    return { status: 200, body: JSON.stringify([{ citing: "omid:br/061 doi:10.1038/nature14539", cited: "omid:br/062 doi:10.1162/neco.1997.9.8.1735" }]) };
  }
  if (host === "openrouter.ai") return { status: 200, body: JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
  return undefined;
}

function fakeFetch(
  answer: (url: string, init: Parameters<ProviderFetch>[1]) => FakeResponse | undefined = fakeAnswers,
): { fetch: ProviderFetch; calls: { url: string; init: Parameters<ProviderFetch>[1] }[] } {
  const calls: { url: string; init: Parameters<ProviderFetch>[1] }[] = [];
  const fetch: ProviderFetch = async (url, init) => {
    calls.push({ url, init });
    const response = answer(url, init) ?? { status: 500, body: "no fake answer" };
    return {
      status: response.status,
      headers: { get: () => null },
      text: async () => response.body,
    } as unknown as Awaited<ReturnType<ProviderFetch>>;
  };
  return { fetch, calls };
}

async function storeWithKeys(workspace: string): Promise<SettingsStore> {
  const store = new SettingsStore(workspace, {
    validateAnthropic: async () => undefined,
    validateWebSearch: async () => undefined,
    validateOpenRouter: async () => undefined,
  });
  await store.put({
    llm: { provider: "anthropic", model: "claude-test", apiKey: "anthropic-secret-key-5678" },
    webSearch: { provider: "tavily", scholarly: true, cacheEnabled: false, tavilyApiKey: "tv-secret-key-1234" },
  });
  return store;
}

function tool(report: AvailabilityReport, id: string) {
  const found = report.tools.find((entry) => entry.id === id);
  assert.ok(found, `tool ${id} is in the table`);
  return found;
}

function purpose(report: AvailabilityReport, name: string) {
  const found = report.purposes.find((entry) => entry.purpose === name);
  assert.ok(found, `purpose ${name} is in the report`);
  return found;
}

/* ------------------------------------------------------------------------ */
/* derive                                                                    */
/* ------------------------------------------------------------------------ */

test("deriveEffectiveOrder drops the unusable, moves the degraded behind the available, keeps the rest in order", () => {
  const states = new Map<string, ToolState>([
    ["searxng", "degraded"],
    ["openalex", "needs-key"],
    ["crossref", "available"],
    ["semantic-scholar", "unreachable"],
    ["arxiv", "available"],
    ["brave", "blocked"],
    ["tavily", "disabled"],
  ]);
  const configured = ["searxng", "openalex", "crossref", "semantic-scholar", "arxiv", "brave", "tavily", "europepmc"];
  const order = deriveEffectiveOrder(configured, states, true);
  assert.deepEqual(order.configured, configured);
  assert.deepEqual(order.effective, ["crossref", "arxiv", "europepmc", "searxng"]);
  assert.deepEqual(
    order.entries.map((entry) => [entry.id, entry.action]),
    [
      ["searxng", "moved"],
      ["openalex", "dropped"],
      ["crossref", "kept"],
      ["semantic-scholar", "dropped"],
      ["arxiv", "kept"],
      ["brave", "dropped"],
      ["tavily", "dropped"],
      ["europepmc", "kept"],
    ],
  );
  assert.match(order.entries[0]!.reason ?? "", /degraded/);
  assert.match(order.entries[1]!.reason ?? "", /key/);
  assert.match(order.entries[3]!.reason ?? "", /unreachable/);
  assert.match(order.entries[5]!.reason ?? "", /blocked/);
  assert.match(order.entries[6]!.reason ?? "", /disabled/);
  assert.equal(order.entries[2]!.reason, undefined);
  // Demotion off: degraded tools stay where they are, flagged.
  const flagged = deriveEffectiveOrder(configured, states, false);
  assert.deepEqual(flagged.effective, ["searxng", "crossref", "arxiv", "europepmc"]);
  assert.equal(flagged.entries[0]!.action, "kept");
  assert.match(flagged.entries[0]!.reason ?? "", /degraded/);
  // Two degraded tools keep their relative order behind the available ones.
  const two = deriveEffectiveOrder(["a", "b", "c", "d"], new Map([["a", "degraded"], ["b", "available"], ["c", "degraded"], ["d", "available"]] as [string, ToolState][]), true);
  assert.deepEqual(two.effective, ["b", "d", "a", "c"]);
});

test("stateFromError and redactSecrets follow the spec's state rules and never leak a key", () => {
  assert.equal(stateFromError("tavily answered HTTP 429").state, "degraded");
  assert.equal(stateFromError("crossref answered HTTP 503").state, "degraded");
  assert.equal(stateFromError("brave refused the API key (HTTP 401) — check it in Settings").state, "needs-key");
  assert.equal(stateFromError("searxng answered HTTP 403").state, "blocked");
  assert.equal(stateFromError("CAPTCHA required").state, "blocked");
  assert.equal(stateFromError("openalex answered HTTP 404").state, "degraded");
  assert.equal(stateFromError("fetch failed: ECONNREFUSED").state, "unreachable");
  assert.equal(stateFromError("arxiv timed out after 15s").state, "unreachable");
  const redacted = redactSecrets(
    "GET https://api.openalex.org/works?api_key=abc123&search=x authorization: Bearer tok-999 x-api-key: s2key secret-value",
    ["secret-value", "s2key"],
  );
  assert.ok(!redacted.includes("abc123"), redacted);
  assert.ok(!redacted.includes("tok-999"), redacted);
  assert.ok(!redacted.includes("s2key"), redacted);
  assert.ok(!redacted.includes("secret-value"), redacted);
  assert.ok(redacted.includes("search=x"), redacted);
});

/* ------------------------------------------------------------------------ */
/* service                                                                   */
/* ------------------------------------------------------------------------ */

test("probeAll probes every tool through the injected fetch, records logs and latencies, persists the table and derives the orders", async () => {
  const workspace = tempRoot();
  try {
    const store = await storeWithKeys(workspace);
    const clock = fakeClock();
    const net = fakeFetch();
    const service = new AvailabilityService({
      workspace,
      settings: store,
      env: {},
      fetchImpl: net.fetch,
      now: clock.now,
      sleep: async () => undefined,
      registryClient: async () => undefined,
      searxngStatus: () => ({ state: "off" }),
      readinessChecks: () => [
        { id: "llm", label: "Model connection", required: true, state: "ok", message: "Anthropic API responds · claude-test", finishedAt: clock.read() },
        { id: "code", label: "Code workspace", required: true, state: "ok", message: "scripts run · node v24", finishedAt: clock.read() },
        { id: "slurm", label: "SLURM scheduler", required: true, state: "failed", message: "sbatch rejected the probe job", finishedAt: clock.read() },
      ],
    });
    const report = await service.probeAll({ reason: "start" });
    assert.deepEqual(report.tools.map((entry) => entry.id), TOOL_IDS);
    const states = Object.fromEntries(report.tools.map((entry) => [entry.id, entry.state]));
    assert.deepEqual(states, {
      searxng: "disabled",
      brave: "needs-key",
      tavily: "available",
      openalex: "needs-key",
      crossref: "available",
      arxiv: "available",
      "semantic-scholar": "available",
      europepmc: "available",
      core: "needs-key",
      opencitations: "available",
      llm: "available",
      "openrouter-embeddings": "needs-key",
      "encoder:specter2": "unreachable",
      "encoder:bge-base-en-v1.5": "unreachable",
      "encoder:hash-ngram-v1": "available",
      registry: "available",
      "searxng-local": "disabled",
      code: "available",
      slurm: "unreachable",
    });
    // No OpenAlex call without a key; the other paper indexes were asked once each.
    assert.ok(net.calls.every((call) => !call.url.includes("openalex.org")), "OpenAlex is never called keyless");
    assert.equal(net.calls.filter((call) => call.url.includes("api.crossref.org")).length, 1);
    assert.equal(net.calls.filter((call) => call.url.includes("export.arxiv.org")).length, 1);
    // Every probed tool carries a log, a latency and a checkedAt; the log never holds the key.
    for (const entry of report.tools) {
      assert.ok(entry.log.length > 0, `${entry.id} has log lines`);
      assert.ok(typeof entry.latencyMs === "number" && entry.latencyMs > 0, `${entry.id} has a latency`);
      assert.ok(typeof entry.checkedAt === "number", `${entry.id} has checkedAt`);
      assert.equal(entry.probing, undefined);
      for (const line of entry.log) {
        assert.ok(!line.text.includes("tv-secret-key-1234"), `${entry.id} log: ${line.text}`);
        assert.ok(!line.text.includes("anthropic-secret-key-5678"), `${entry.id} log: ${line.text}`);
      }
    }
    assert.equal(tool(report, "llm").detail, "Anthropic API responds · claude-test");
    assert.equal(tool(report, "llm").keyPresent, true);
    const tavily = tool(report, "tavily");
    assert.equal(tavily.keyPresent, true);
    assert.ok(tavily.log.some((line) => /POST https:\/\/api\.tavily\.com/.test(line.text)), JSON.stringify(tavily.log));
    assert.ok(tavily.log.some((line) => /HTTP 200 in \d+ ms/.test(line.text)));
    assert.equal(tool(report, "brave").keyPresent, false);
    assert.equal(tool(report, "slurm").detail, "sbatch rejected the probe job");
    assert.equal(tool(report, "code").detail, "scripts run · node v24");
    // Derived orders: tavily is the primary, brave (no key) is dropped.
    const web = purpose(report, "web");
    assert.deepEqual(web.configured, ["tavily", "brave"]);
    assert.deepEqual(web.effective, ["tavily"]);
    assert.equal(web.entries[1]!.id, "brave");
    assert.equal(web.entries[1]!.action, "dropped");
    assert.match(web.entries[1]!.reason ?? "", /key/);
    const lookup = purpose(report, "paper-lookup");
    assert.deepEqual(lookup.configured, ["searxng", "openalex", "crossref", "semantic-scholar", "arxiv", "brave"]);
    assert.deepEqual(lookup.effective, ["crossref", "semantic-scholar", "arxiv"]);
    const embedding = purpose(report, "embedding");
    assert.deepEqual(embedding.configured, ["encoder:specter2", "encoder:hash-ngram-v1"]);
    assert.deepEqual(embedding.effective, ["encoder:hash-ngram-v1"]);
    assert.deepEqual(purpose(report, "citation-hop").effective, ["semantic-scholar", "opencitations"]);
    assert.equal(report.demoteDegraded, true);
    // Persisted atomically at <workspace>/availability.json, and reloaded by a new service.
    const persisted = JSON.parse(readFileSync(join(workspace, "availability.json"), "utf8")) as AvailabilityReport;
    assert.equal(persisted.version, 1);
    assert.equal(persisted.tools.length, TOOL_IDS.length);
    assert.equal(persisted.purposes.length, 7);
    assert.ok(!existsSync(join(workspace, "availability.json.tmp")));
    const reloaded = new AvailabilityService({ workspace, settings: store, env: {}, fetchImpl: net.fetch, now: clock.now });
    assert.equal(tool(reloaded.report(), "tavily").state, "available");
    assert.equal(tool(reloaded.report(), "tavily").log.length, tavily.log.length);
    service.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("server availability snapshots survive another instance and legacy backend sharing the workspace", async () => {
  const workspace = tempRoot();
  const services: AvailabilityService[] = [];
  const make = (instanceId: string | undefined, state: ToolState) => {
    const service = new AvailabilityService({
      workspace,
      settings: new SettingsStore(workspace, instanceId === undefined ? {} : { searxngInstanceId: instanceId }),
      probeOverrides: { arxiv: async () => ({ state }) },
      env: {},
    });
    services.push(service);
    return service;
  };
  try {
    const legacy = make(undefined, "blocked");
    await legacy.probe(["arxiv"], { reason: "manual" });
    const cluster = make("cluster:8787", "available");
    assert.equal(tool(cluster.report(), "arxiv").state, "unchecked", "a scoped server never loads legacy state");
    await cluster.probe(["arxiv"], { reason: "manual" });
    const desktop = make("desktop:43213", "unreachable");
    await desktop.probe(["arxiv"], { reason: "manual" });
    await legacy.probe(["arxiv"], { reason: "manual" });
    const read = (id: string) => JSON.parse(readFileSync(join(searxngDir(workspace, id), "availability.json"), "utf8")) as AvailabilityReport;
    assert.equal(tool(read("cluster:8787"), "arxiv").state, "available");
    assert.equal(tool(read("desktop:43213"), "arxiv").state, "unreachable");
    assert.equal(tool(make("cluster:8787", "unchecked").report(), "arxiv").state, "available",
      "a restarted server loads only its own latest snapshot");
  } finally {
    for (const service of services) service.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a 429 or an empty known answer marks a tool degraded; demotion moves it behind the available tools unless switched off", async () => {
  const workspace = tempRoot();
  try {
    const store = await storeWithKeys(workspace);
    const net = fakeFetch((url) => {
      const host = new URL(url).hostname;
      if (host === "api.crossref.org") return { status: 429, body: "slow down" };
      if (host === "api.semanticscholar.org") return { status: 200, body: JSON.stringify({ title: "Something else" }) };
      return fakeAnswers(url);
    });
    const service = new AvailabilityService({ workspace, settings: store, env: {}, fetchImpl: net.fetch, sleep: async () => undefined });
    const report = await service.probe(["crossref", "semantic-scholar", "arxiv"]);
    assert.equal(tool(report, "crossref").state, "degraded");
    assert.match(tool(report, "crossref").detail ?? "", /HTTP 429/);
    assert.equal(tool(report, "semantic-scholar").state, "degraded");
    assert.equal(tool(report, "arxiv").state, "available");
    const lookup = purpose(report, "paper-lookup");
    // Unchecked tools are kept (unknown is not unusable); the two degraded ones go last, in order.
    assert.deepEqual(lookup.effective, ["searxng", "openalex", "arxiv", "brave", "crossref", "semantic-scholar"]);
    assert.equal(lookup.entries.find((entry) => entry.id === "crossref")?.action, "moved");
    await store.put({ availability: { demoteDegraded: false } });
    assert.deepEqual(availabilitySettingsOf(store.get()), { demoteDegraded: false, periodicMinutes: 30 });
    const flagged = service.report();
    assert.equal(flagged.demoteDegraded, false);
    assert.deepEqual(purpose(flagged, "paper-lookup").effective, ["searxng", "openalex", "crossref", "semantic-scholar", "arxiv", "brave"]);
    service.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("probe with a wait cap answers early with probing: true and finishes in the background; listeners hear every change", async () => {
  const workspace = tempRoot();
  try {
    const store = await storeWithKeys(workspace);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new AvailabilityService({
      workspace,
      settings: store,
      env: {},
      fetchImpl: fakeFetch().fetch,
      probeOverrides: {
        tavily: async (context) => {
          context.log.info("waiting on the gate");
          await gate;
          return { state: "available", detail: "released" };
        },
      },
    });
    const seen: AvailabilityReport[] = [];
    const unsubscribe = service.subscribe((report) => seen.push(report));
    const early = await service.probe(["tavily", "arxiv"], { waitMs: 50 });
    assert.equal(tool(early, "tavily").probing, true);
    assert.equal(tool(early, "tavily").state, "unchecked");
    assert.equal(tool(early, "arxiv").state, "available");
    // A second request for the same tool joins the running probe instead of starting another.
    const joined = service.probe(["tavily"]);
    release();
    const done = await joined;
    assert.equal(tool(done, "tavily").state, "available");
    assert.equal(tool(done, "tavily").detail, "released");
    assert.equal(tool(done, "tavily").probing, undefined);
    assert.ok(tool(done, "tavily").log.some((line) => line.text === "waiting on the gate"));
    assert.ok(seen.length >= 3, `listeners heard ${seen.length} updates`);
    unsubscribe();
    service.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the timers re-probe unreachable/blocked tools after the cooldown and everything on the periodic interval", async () => {
  const workspace = tempRoot();
  try {
    const store = await storeWithKeys(workspace);
    const clock = fakeClock();
    const probed: string[] = [];
    let arxivState: ToolState = "unreachable";
    const service = new AvailabilityService({
      workspace,
      settings: store,
      env: {},
      fetchImpl: fakeFetch().fetch,
      now: clock.now,
      sleep: async () => undefined,
      registryClient: async () => undefined,
      probeOverrides: Object.fromEntries(
        TOOL_IDS.map((id) => [
          id,
          async () => {
            probed.push(id);
            return id === "arxiv" ? { state: arxivState, detail: "no route to host" } : { state: "available" as ToolState };
          },
        ]),
      ),
    });
    await service.probeAll({ reason: "start" });
    assert.equal(probed.length, TOOL_IDS.length);
    probed.length = 0;
    assert.deepEqual(service.cooldownDue(), []);
    assert.equal(service.periodicDue(), false);
    clock.advance(AVAILABILITY_COOLDOWN_MS - 5_000);
    assert.deepEqual(service.cooldownDue(), []);
    clock.advance(5_000 + 100);
    assert.deepEqual(service.cooldownDue(), ["arxiv"]);
    arxivState = "available";
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(probed, ["arxiv"]);
    assert.equal(tool(service.report(), "arxiv").state, "available");
    probed.length = 0;
    // The periodic full re-check follows settings availability.periodicMinutes (default 30).
    clock.advance(30 * 60_000);
    assert.equal(service.periodicDue(), true);
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(probed.length, TOOL_IDS.length);
    assert.equal(service.periodicDue(), false);
    await store.put({ availability: { periodicMinutes: 5 } });
    clock.advance(5 * 60_000 + 1);
    assert.equal(service.periodicDue(), true);
    service.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("manual probes of code and slurm ask readiness for a fresh outcome and wait for it; start probes only mirror", async () => {
  const workspace = tempRoot();
  try {
    const store = await storeWithKeys(workspace);
    const refreshed: string[][] = [];
    let state: "unknown" | "checking" | "ok" | "failed" = "ok";
    let finishedAt = 10;
    const clock = fakeClock(1_000);
    const service = new AvailabilityService({
      workspace,
      settings: store,
      env: {},
      fetchImpl: fakeFetch().fetch,
      now: clock.now,
      sleep: async () => {
        // The readiness check finishes on the first wait.
        state = "failed";
        finishedAt = clock.read();
      },
      readinessChecks: () => [{ id: "code", label: "Code workspace", required: true, state, message: state === "ok" ? "scripts run" : "node missing", finishedAt }],
      refreshReadiness: (ids) => {
        refreshed.push([...ids]);
        state = "checking";
      },
    });
    const start = await service.probe(["code"], { reason: "start" });
    assert.deepEqual(refreshed, []);
    assert.equal(tool(start, "code").state, "available");
    const manual = await service.probe(["code"], { reason: "manual" });
    assert.deepEqual(refreshed, [["code"]]);
    assert.equal(tool(manual, "code").state, "unreachable");
    assert.equal(tool(manual, "code").detail, "node missing");
    service.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the llm row mirrors the readiness model check: no credential is needs-key, an overload degraded", async () => {
  const workspace = tempRoot();
  try {
    const store = new SettingsStore(workspace, { validateAnthropic: async () => undefined });
    await store.put({ llm: { provider: "offline" } });
    let message = "Configure and verify the Anthropic API key and model in Settings";
    const checks = () => [{ id: "llm" as const, label: "Model connection", required: true, state: "failed" as const, message, finishedAt: 5 }];
    const service = new AvailabilityService({ workspace, settings: store, env: {}, fetchImpl: fakeFetch().fetch, readinessChecks: checks });
    // offline → anthropic without a credential (the stored settings carry no key yet).
    const noKey = { ...store.get(), llm: { ...store.get().llm, provider: "anthropic" as const, model: "claude-test" } };
    const needsKey = await new AvailabilityService({
      workspace,
      settings: new Proxy(store, { get: (target, property, receiver) => (property === "get" ? () => noKey : Reflect.get(target, property, receiver)) }),
      env: {},
      fetchImpl: fakeFetch().fetch,
      readinessChecks: checks,
    }).probe(["llm"], { reason: "start" });
    assert.equal(tool(needsKey, "llm").state, "needs-key");
    assert.equal(tool(needsKey, "llm").keyPresent, false);
    await store.put({ llm: { provider: "anthropic", model: "claude-test", apiKey: "anthropic-key" } });
    message = "Anthropic answered HTTP 529 overloaded";
    const overloaded = await service.probe(["llm"], { reason: "start" });
    assert.equal(tool(overloaded, "llm").state, "degraded");
    assert.equal(tool(overloaded, "llm").keyPresent, true);
    message = "network unreachable";
    assert.equal(tool(await service.probe(["llm"], { reason: "periodic" }), "llm").state, "unreachable");
    service.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ */
/* settings diff                                                             */
/* ------------------------------------------------------------------------ */

test("affectedTools names only the tools a settings save touched", async () => {
  const workspace = tempRoot();
  try {
    const store = await storeWithKeys(workspace);
    const before = store.get();
    const same = (patch: Partial<ServerSettings>): ServerSettings => ({ ...before, ...patch });
    assert.deepEqual(affectedTools(before, same({})), []);
    assert.deepEqual(affectedTools(before, same({ webSearch: { ...before.webSearch!, braveKeyConfigured: true } })), ["brave"]);
    // A freshly pasted key for a provider that already had one shows only in the body.
    assert.deepEqual(affectedTools(before, same({}), { webSearch: { tavilyApiKey: "new" } }), ["tavily"]);
    assert.deepEqual(affectedTools(before, same({ webSearch: { ...before.webSearch!, provider: "brave" } })), ["searxng", "brave", "tavily", "searxng-local"]);
    assert.deepEqual(affectedTools(before, same({ webSearch: { ...before.webSearch!, scholarly: false } })), ["openalex", "crossref", "arxiv", "semantic-scholar", "europepmc", "core", "opencitations"]);
    assert.deepEqual(affectedTools(before, same({ webSearch: { ...before.webSearch!, mode: "agent" } })).length, 11);
    assert.deepEqual(affectedTools(before, same({ llm: { ...before.llm, model: "claude-other" } })), ["llm"]);
    assert.deepEqual(affectedTools(before, same({}), { llm: { apiKey: "pasted" } }), ["llm"]);
    assert.deepEqual(
      affectedTools(before, same({ creditRecovery: { ...before.creditRecovery, openRouterKeyConfigured: true } })),
      ["openrouter-embeddings", "encoder:specter2", "encoder:bge-base-en-v1.5", "encoder:hash-ngram-v1"],
    );
    assert.deepEqual(affectedTools(before, same({ hostTools: { enabledToolIds: ["code_execute"] } })), ["code"]);
    assert.deepEqual(affectedTools(before, same({ runner: "local" })), ["slurm"]);
    assert.deepEqual(
      affectedTools(before, { ...before, panelComposition: { params: { encoder: "bge-base-en-v1.5" } } } as ServerSettings),
      ["openrouter-embeddings", "encoder:specter2", "encoder:bge-base-en-v1.5", "encoder:hash-ngram-v1"],
    );
    // Unrelated saves touch nothing.
    assert.deepEqual(affectedTools(before, same({ gateAutoApprove: false })), []);
    assert.deepEqual(affectedTools(before, same({ webSearch: { ...before.webSearch!, routePreset: "api-first" } })), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the availability settings section validates, merges one level deep and survives a reload", async () => {
  const workspace = tempRoot();
  try {
    const store = new SettingsStore(workspace);
    await store.put({ llm: { provider: "offline" } });
    assert.deepEqual(availabilitySettingsOf(store.get()), { demoteDegraded: true, periodicMinutes: 30 });
    await store.put({ availability: { demoteDegraded: false, periodicMinutes: 45 } });
    assert.deepEqual(availabilitySettingsOf(store.get()), { demoteDegraded: false, periodicMinutes: 45 });
    await store.put({ availability: { demoteDegraded: true } });
    assert.deepEqual(availabilitySettingsOf(store.get()), { demoteDegraded: true, periodicMinutes: 45 });
    assert.deepEqual(availabilitySettingsOf(new SettingsStore(workspace).get()), { demoteDegraded: true, periodicMinutes: 45 });
    await assert.rejects(store.put({ availability: { periodicMinutes: 0 } }), /periodicMinutes must be an integer between 1 and 1440/);
    await assert.rejects(store.put({ availability: { demoteDegraded: "no" } }), /demoteDegraded must be a boolean/);
    await assert.rejects(store.put({ availability: [] }), /availability must be an object/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ */
/* endpoints                                                                 */
/* ------------------------------------------------------------------------ */

const brainRepoRoot = fileURLToPath(new URL("../../../../../brain/", import.meta.url));
function registryRoot(): string {
  if (process.env.BRAIN_TEST_REGISTRY_DIR) return process.env.BRAIN_TEST_REGISTRY_DIR;
  execFileSync(process.execPath, [join(brainRepoRoot, "scripts", "materialize-store.mjs"), "--quiet"], { stdio: "inherit" });
  return join(brainRepoRoot, ".registry-store");
}
function pinnedBundleVersion(): string {
  const override = process.env.BRAIN_TEST_BUNDLE_VERSION;
  if (override && override !== "latest") return override;
  const root = registryRoot();
  if (override === "latest") {
    const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8")) as { bundles: Array<{ id: string; latest: string }> };
    return index.bundles.find((bundle) => bundle.id === "brainstorm")!.latest;
  }
  return (JSON.parse(readFileSync(new URL("../../../../test-bundle.json", import.meta.url), "utf8")) as { version: string }).version;
}

async function requestJson<T>(server: RunningBrainServer, path: string, init?: RequestInit): Promise<{ status: number; value: T }> {
  const response = await fetch(`${server.url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: response.status, value: (await response.json()) as T };
}

test("probes still running when the server closes (and its workspace is removed) never reject unhandled", async () => {
  const workspace = tempRoot();
  const registry = await startTestRegistry(registryRoot(), pinnedBundleVersion());
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const server = await startBrainServer({
    workspace,
    port: 0,
    gateAutoApproveGraceMs: 0,
    contentRegistryUrl: registry.url,
    contentRegistryStatus: { running: true, url: registry.url },
    validateAnthropic: async () => undefined,
    readinessProbes: {
      llm: async () => ({ message: "stub" }),
      internet: async () => ({ message: "stub online" }),
      code: async () => ({ message: "stub scripts run" }),
      slurm: async () => ({ message: "stub sbatch works" }),
    },
    readinessAdvisor: null,
    availabilityProbes: Object.fromEntries(
      TOOL_IDS.map((id) => [
        id,
        async () => {
          started += 1;
          await gate;
          return { state: "available" as ToolState };
        },
      ]),
    ),
  });
  let closed = false;
  try {
    const current = (await requestJson<ServerSettings>(server, "/api/settings")).value;
    const saved = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ...current, llm: { ...current.llm, provider: "anthropic", model: "claude-closing", apiKey: "k-2" } }),
    });
    assert.equal(saved.status, 200);
    assert.ok(started >= TOOL_IDS.length, "the start probe and the settings probe are in flight");
    // The suite's teardown order: close, then remove the workspace — while
    // the probes above are still waiting on the gate.
    await server.close();
    closed = true;
    rmSync(workspace, { recursive: true, force: true });
    release();
    await new Promise((resolve) => setTimeout(resolve, 250));
    // After close the service still answers, quietly, without a workspace.
    const after = await server.availability.probe(["llm"], { reason: "manual" });
    assert.equal(after.version, 1);
    assert.equal(after.tools.length, TOOL_IDS.length);
    assert.ok(!existsSync(join(searxngDir(workspace, server.manager.settings.searxngInstanceId), "availability.json")), "nothing is written after close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
    if (!closed) await server.close();
    await registry.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("GET /api/availability, POST /api/availability/probe and the settings PUT diff drive the service; the stream announces updates", async () => {
  const workspace = tempRoot();
  const registry = await startTestRegistry(registryRoot(), pinnedBundleVersion());
  const probed: string[] = [];
  const server = await startBrainServer({
    workspace,
    port: 0,
    gateAutoApproveGraceMs: 0,
    contentRegistryUrl: registry.url,
    contentRegistryStatus: { running: true, url: registry.url },
    validateAnthropic: async () => undefined,
    readinessProbes: {
      llm: async () => ({ message: "stub" }),
      internet: async () => ({ message: "stub online" }),
      code: async () => ({ message: "stub scripts run" }),
      slurm: async () => ({ message: "stub sbatch works" }),
    },
    readinessAdvisor: null,
    availabilityFetch: fakeFetch().fetch,
    availabilityProbes: Object.fromEntries(
      TOOL_IDS.map((id) => [
        id,
        async () => {
          probed.push(id);
          return { state: "available" as ToolState, detail: `stub ${id}` };
        },
      ]),
    ),
  });
  try {
    // The start probe runs in the background; wait for it to land.
    for (let attempt = 0; attempt < 100 && probed.length < TOOL_IDS.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(probed.length, TOOL_IDS.length, "every tool probed at start");
    const table = await requestJson<AvailabilityReport>(server, "/api/availability");
    assert.equal(table.status, 200);
    assert.equal(table.value.version, 1);
    assert.equal(table.value.tools.length, TOOL_IDS.length);
    assert.equal(tool(table.value, "arxiv").state, "available");
    assert.equal(tool(table.value, "arxiv").detail, "stub arxiv");
    assert.ok(existsSync(join(searxngDir(workspace, server.manager.settings.searxngInstanceId), "availability.json")));

    // One tool on demand: only that tool is probed, and the answer is synchronous.
    probed.length = 0;
    const one = await requestJson<AvailabilityReport>(server, "/api/availability/probe", {
      method: "POST",
      body: JSON.stringify({ tools: ["crossref"] }),
    });
    assert.equal(one.status, 200);
    assert.deepEqual(probed, ["crossref"]);
    assert.equal(tool(one.value, "crossref").probing, undefined);
    const bad = await requestJson<{ error?: string }>(server, "/api/availability/probe", {
      method: "POST",
      body: JSON.stringify({ tools: ["not-a-tool"] }),
    });
    assert.equal(bad.status, 400);
    // No body = re-check all.
    probed.length = 0;
    const all = await requestJson<AvailabilityReport>(server, "/api/availability/probe", { method: "POST" });
    assert.equal(all.status, 200);
    assert.equal(probed.length, TOOL_IDS.length);

    // The stream carries the table on connect.
    const stream = await fetch(`${server.url}/api/stream`);
    const reader = stream.body!.getReader();
    let text = "";
    for (let attempt = 0; attempt < 50 && !text.includes('"type":"availability"'); attempt += 1) {
      const chunk = await Promise.race([reader.read(), new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => setTimeout(() => resolve({ done: false }), 200))]);
      if (chunk.value) text += Buffer.from(chunk.value).toString("utf8");
    }
    await reader.cancel().catch(() => undefined);
    assert.ok(text.includes('"type":"availability"'), text.slice(0, 500));

    // A settings save re-probes only what it touched: the model here.
    probed.length = 0;
    const current = (await requestJson<ServerSettings>(server, "/api/settings")).value;
    const saved = await requestJson<ServerSettings>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ...current, llm: { ...current.llm, provider: "anthropic", model: "claude-availability", apiKey: "k-1" }, availability: { demoteDegraded: false } }),
    });
    assert.equal(saved.status, 200);
    for (let attempt = 0; attempt < 50 && probed.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(probed, ["llm"]);
    const after = await requestJson<AvailabilityReport>(server, "/api/availability");
    assert.equal(after.value.demoteDegraded, false);
    assert.equal((saved.value as ServerSettings & { availability?: { demoteDegraded?: boolean } }).availability?.demoteDegraded, false);
    const rejected = await requestJson<{ error?: string }>(server, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ...saved.value, availability: { periodicMinutes: 100000 } }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await server.close();
    await registry.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
