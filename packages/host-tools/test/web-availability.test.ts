/**
 * The availability change set in the web layer: seeded statuses stand in
 * for the launch check, every status change is announced, a live 429/503
 * demotes a source (three in a row block it) and an answer recovers it,
 * derived route orders replace the configured lists, and the new known-answer
 * probes (Europe PMC, CORE, OpenCitations, the general web providers,
 * OpenRouter embeddings) produce redacted logs. No test touches the network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WebSearchHit, WebSearchKind, WebSourceStatus } from "@brainstorm-agentic/core";

import {
  EnginePool,
  ProviderRequestError,
  WebAccessManager,
  coreBackend,
  europePmcBackend,
  openCitationsBackend,
  probeOpenRouterEmbeddings,
  redactUrl,
  tavilyProvider,
  type ProviderFetch,
  type ProviderSearchRequest,
  type WebSearchProvider,
} from "../src/index.js";
import { statusFromError, type PaperBackend } from "../src/web/scholarly.js";

/** A scripted provider: counts calls and answers HTTP 429 for the first N calls. */
function scripted(options: {
  readonly id: string;
  readonly kinds?: readonly WebSearchKind[];
  readonly status429First?: number;
  readonly check?: () => Promise<WebSourceStatus>;
}): WebSearchProvider & { calls: ProviderSearchRequest[]; checks: number } {
  const calls: ProviderSearchRequest[] = [];
  let throttled = 0;
  const provider: WebSearchProvider & { calls: ProviderSearchRequest[]; checks: number } = {
    id: options.id,
    kinds: options.kinds ?? ["general", "news"],
    calls,
    checks: 0,
    async search(request) {
      calls.push(request);
      if (throttled < (options.status429First ?? 0)) {
        throttled += 1;
        throw new ProviderRequestError(`${options.id} answered HTTP 429`, true);
      }
      const hit: WebSearchHit = {
        title: `${options.id} answer`,
        url: `https://example.org/${options.id}/${encodeURIComponent(request.query)}`,
        snippet: "snippet",
        source: options.id,
      };
      return { hits: [hit], total: 1 };
    },
  };
  if (options.check !== undefined) {
    const check = options.check;
    provider.check = async () => {
      provider.checks += 1;
      return check();
    };
  }
  return provider;
}

const noSleep = async () => {};

test("a fresh seeded available status skips the source's launch probe; a stale one is probed", async () => {
  let now = 1_000_000;
  const fresh = scripted({ id: "fresh", check: async () => ({ id: "fresh", state: "available", checkedAt: now }) });
  const stale = scripted({ id: "stale", check: async () => ({ id: "stale", state: "available", checkedAt: now }) });
  const manager = new WebAccessManager({
    providers: [fresh, stale],
    chains: { general: ["fresh", "stale"] },
    now: () => now,
    sleep: noSleep,
    seededStatuses: [
      { id: "fresh", state: "available", checkedAt: now - 5 * 60_000, detail: "seeded" },
      { id: "stale", state: "degraded", checkedAt: now - 11 * 60_000, detail: "seeded" },
      { id: "unknown-source", state: "available", checkedAt: now },
      { id: "fresh", state: "unchecked" },
    ],
  });
  // The seed applies from construction.
  const before = new Map(manager.status().map((status) => [status.id, status]));
  assert.equal(before.get("fresh")?.detail, "seeded");
  assert.equal(before.get("stale")?.state, "degraded");
  assert.equal(before.has("unknown-source"), false);
  const table = await manager.startChecks();
  assert.equal(fresh.checks, 0, "fresh seed stands in for the probe");
  assert.equal(stale.checks, 1, "a seed older than ten minutes is probed again");
  const after = new Map(table.map((status) => [status.id, status]));
  assert.equal(after.get("fresh")?.detail, "seeded");
  assert.equal(after.get("stale")?.state, "available");
  now += 1;
});

test("a seeded unreachable status skips the source for its cool-down and is still probed at launch", async () => {
  const now = 2_000_000;
  const dead = scripted({ id: "dead", check: async () => ({ id: "dead", state: "unreachable", checkedAt: now }) });
  const alive = scripted({ id: "alive" });
  const manager = new WebAccessManager({
    providers: [dead, alive],
    chains: { general: ["dead", "alive"] },
    now: () => now,
    sleep: noSleep,
    seededStatuses: [{ id: "dead", state: "unreachable", checkedAt: now - 60_000, until: now + 9 * 60_000 }],
  });
  const answer = await manager.search({ kind: "general", query: "q" });
  assert.equal(answer.provider, "alive");
  assert.equal(dead.calls.length, 0, "a benched seed is not retried by the first agent");
  await manager.startChecks();
  assert.equal(dead.checks, 1);
});

test("onStatusChange fires for launch outcomes, a live 429 demotion, the block after three in a row, and recovery", async () => {
  let now = 3_000_000;
  const changes: WebSourceStatus[] = [];
  const flaky = scripted({ id: "flaky", status429First: 8, check: async () => ({ id: "flaky", state: "available", checkedAt: now }) });
  const steady = scripted({ id: "steady" });
  const manager = new WebAccessManager({
    providers: [flaky, steady],
    chains: { general: ["flaky", "steady"] },
    now: () => now,
    sleep: noSleep,
    onStatusChange: (status) => changes.push(status),
  });
  await manager.startChecks();
  assert.deepEqual(changes.map((status) => [status.id, status.state]), [["flaky", "available"]]);

  // First live 429 (plus its retry): degraded, not unreachable or blocked.
  const first = await manager.search({ kind: "general", query: "one" });
  assert.equal(first.provider, "steady");
  assert.equal(flaky.calls.length, 2, "one call and one retry");
  const degraded = changes.at(-1)!;
  assert.equal(degraded.id, "flaky");
  assert.equal(degraded.state, "degraded");
  assert.match(degraded.detail ?? "", /HTTP 429/);
  assert.equal(degraded.until, now + 10 * 60_000);

  // Demoted: the next search tries the steady source first and never reaches flaky.
  const second = await manager.search({ kind: "general", query: "two" });
  assert.equal(second.provider, "steady");
  assert.equal(flaky.calls.length, 2, "a demoted source is tried after the ones that answer");

  // Steady fails over to flaky when it is the only one left: two more 429s block flaky.
  const flakyOnly = new WebAccessManager({
    providers: [flaky],
    chains: { general: ["flaky"] },
    now: () => now,
    sleep: noSleep,
    onStatusChange: (status) => changes.push(status),
  });
  await assert.rejects(flakyOnly.search({ kind: "general", query: "three" }));
  assert.equal(changes.at(-1)!.state, "degraded");
  await assert.rejects(flakyOnly.search({ kind: "general", query: "four" }));
  assert.equal(changes.at(-1)!.state, "degraded", "two in a row stay degraded");
  await assert.rejects(flakyOnly.search({ kind: "general", query: "five" }));
  const blocked = changes.at(-1)!;
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.detail ?? "", /3 times in a row/);
  // Blocked: skipped for the cool-down.
  await assert.rejects(flakyOnly.search({ kind: "general", query: "six" }), /blocked at the last check/);
  const callsWhileBlocked = flaky.calls.length;
  // After the cool-down the source is tried again, answers, and recovers.
  now += 10 * 60_000 + 1;
  const recovered = await flakyOnly.search({ kind: "general", query: "seven" });
  assert.equal(recovered.provider, "flaky");
  assert.equal(flaky.calls.length, callsWhileBlocked + 1);
  assert.equal(changes.at(-1)!.state, "available");
});

test("a live-degraded source recovers to available on its next answer, announced once", async () => {
  const now = 4_000_000;
  const changes: WebSourceStatus[] = [];
  const flaky = scripted({ id: "flaky", status429First: 2 });
  const manager = new WebAccessManager({
    providers: [flaky],
    chains: { general: ["flaky"] },
    now: () => now,
    sleep: noSleep,
    onStatusChange: (status) => changes.push(status),
  });
  await assert.rejects(manager.search({ kind: "general", query: "one" }));
  assert.equal(changes.at(-1)!.state, "degraded");
  const answer = await manager.search({ kind: "general", query: "two" });
  assert.equal(answer.provider, "flaky");
  assert.deepEqual(changes.map((status) => status.state), ["degraded", "available"]);
  assert.equal(changes.at(-1)!.detail, "recovered");
  assert.equal(changes.at(-1)!.until, undefined);
});

test("a 503 demotes like a 429; other failures neither demote nor count", async () => {
  const now = 5_000_000;
  const changes: WebSourceStatus[] = [];
  let mode: "503" | "500" = "503";
  const provider: WebSearchProvider = {
    id: "p",
    kinds: ["general"],
    async search() {
      throw new ProviderRequestError(`p answered HTTP ${mode}`, false);
    },
  };
  const manager = new WebAccessManager({
    providers: [provider],
    chains: { general: ["p"] },
    now: () => now,
    sleep: noSleep,
    onStatusChange: (status) => changes.push(status),
  });
  await assert.rejects(manager.search({ kind: "general", query: "one" }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.state, "degraded");
  assert.match(changes[0]!.detail ?? "", /HTTP 503/);
  mode = "500";
  await assert.rejects(manager.search({ kind: "general", query: "two" }));
  assert.equal(changes.length, 1, "a 500 is a plain failure");
});

test("routeOrders replace the configured route lists where present and leave the others", async () => {
  const a = scripted({ id: "a" });
  const b = scripted({ id: "b" });
  const manager = new WebAccessManager({
    providers: [a, b],
    chains: { general: ["a", "b"], news: ["a", "b"] },
    routes: { web: ["a", "b"], news: ["a", "b"] },
    routeOrders: { web: ["b", "a"], news: undefined },
    sleep: noSleep,
  });
  const web = await manager.search({ kind: "general", query: "q" });
  assert.equal(web.provider, "b");
  assert.equal(a.calls.length, 0);
  const news = await manager.search({ kind: "news", query: "q" });
  assert.equal(news.provider, "a");
});

/** One canned HTTP answer, capturing every request. */
function fetchReturning(
  body: string,
  status = 200,
  seen: { url: string; init: Parameters<ProviderFetch>[1] }[] = [],
): ProviderFetch {
  return async (url, init) => {
    seen.push({ url, init });
    return { status, headers: { get: () => null }, text: async () => body };
  };
}

async function check(backend: PaperBackend) {
  assert.ok(backend.check);
  return backend.check();
}

test("europepmc, core and opencitations probes: known answers, misses, throttling and refusals, with redacted logs", async () => {
  const pmc = await check(europePmcBackend({ fetchImpl: fetchReturning('{"hitCount":1,"resultList":{"result":[{"title":"Deep learning"}]}}') }));
  assert.equal(pmc.state, "available");
  assert.ok(typeof pmc.latencyMs === "number");
  assert.ok(pmc.log!.some((line) => /GET https:\/\/www\.ebi\.ac\.uk\/europepmc.*DOI/.test(line.text)));
  assert.ok(pmc.log!.some((line) => /HTTP 200/.test(line.text)));
  const pmcMiss = await check(europePmcBackend({ fetchImpl: fetchReturning('{"hitCount":0,"resultList":{"result":[]}}') }));
  assert.equal(pmcMiss.state, "degraded");
  assert.equal(pmcMiss.detail, "answered without the known paper");
  const pmcThrottled = await check(europePmcBackend({ fetchImpl: fetchReturning("", 429) }));
  assert.equal(pmcThrottled.state, "degraded");
  assert.match(pmcThrottled.detail ?? "", /HTTP 429/);
  const pmcDown = await check(europePmcBackend({ fetchImpl: fetchReturning("", 503) }));
  assert.equal(pmcDown.state, "degraded");
  const pmcBlocked = await check(europePmcBackend({ fetchImpl: fetchReturning("", 403) }));
  assert.equal(pmcBlocked.state, "blocked", "a 403 on a keyless probe is a block");
  const pmcGone = await check(europePmcBackend({ fetchImpl: fetchReturning("", 502) }));
  assert.equal(pmcGone.state, "unreachable");
  assert.ok(pmcGone.log!.some((line) => line.level === "error"));

  const seen: { url: string; init: Parameters<ProviderFetch>[1] }[] = [];
  const core = await check(
    coreBackend({ apiKey: "core-secret-key", fetchImpl: fetchReturning('{"totalHits":1,"results":[{"title":"Deep learning"}]}', 200, seen) }),
  );
  assert.equal(core.state, "available");
  assert.equal(seen[0]!.init.headers?.authorization, "Bearer core-secret-key");
  assert.ok(core.log!.every((line) => !line.text.includes("core-secret-key")), "the log never carries the key");
  const coreKeyless = await check(coreBackend({ fetchImpl: fetchReturning("{}") }));
  assert.equal(coreKeyless.state, "needs-key");
  const coreRefused = await check(coreBackend({ apiKey: "k", fetchImpl: fetchReturning("", 401) }));
  assert.equal(coreRefused.state, "needs-key");
  const coreForbidden = await check(coreBackend({ apiKey: "k", fetchImpl: fetchReturning("", 403) }));
  assert.equal(coreForbidden.state, "needs-key", "a 403 on a keyed probe is a refused key");

  const oc = await check(
    openCitationsBackend({
      accessToken: "oc-secret-token",
      fetchImpl: fetchReturning('[{"cited":"omid:br/1 doi:10.1038/nature12345"},{"cited":"omid:br/2 doi:10.1126/science.1"}]'),
    }),
  );
  assert.equal(oc.state, "available");
  assert.ok(oc.log!.some((line) => /2 references/.test(line.text)));
  assert.ok(oc.log!.every((line) => !line.text.includes("oc-secret-token")));
  const ocEmpty = await check(openCitationsBackend({ fetchImpl: fetchReturning("[]") }));
  assert.equal(ocEmpty.state, "degraded");
});

test("a probe times out at its bound and reports unreachable", async () => {
  const never: ProviderFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const backend = europePmcBackend({ fetchImpl: never });
  assert.ok(backend.check);
  const controller = new AbortController();
  const pending = backend.check(controller.signal);
  controller.abort();
  const status = await pending;
  assert.equal(status.state, "unreachable");
  assert.ok(status.log!.some((line) => /probe europepmc/.test(line.text)));
});

test("statusFromError maps probe failures per the spec", () => {
  const at = 1;
  assert.equal(statusFromError("x", new Error("x answered HTTP 429"), at).state, "degraded");
  assert.equal(statusFromError("x", new Error("x answered HTTP 503"), at).state, "degraded");
  assert.equal(statusFromError("x", new Error("x answered HTTP 403"), at).state, "blocked");
  assert.equal(statusFromError("x", new Error("x refused the API key (HTTP 403) — check it in Settings"), at).state, "needs-key");
  assert.equal(statusFromError("x", new Error("x answered HTTP 401"), at).state, "needs-key");
  assert.equal(statusFromError("x", new Error("x answered HTTP 404"), at).state, "degraded");
  assert.equal(statusFromError("x", new Error("x timed out after 20s"), at).state, "unreachable");
});

test("redactUrl hides credential-bearing query values", () => {
  assert.equal(
    redactUrl("https://api.openalex.org/works?filter=doi:x&api_key=SECRET&mailto=me%40example.org&per_page=1"),
    "https://api.openalex.org/works?filter=doi%3Ax&api_key=%3Credacted%3E&mailto=%3Credacted%3E&per_page=1",
  );
  assert.equal(redactUrl("not a url?token=abc"), "not a url?token=<redacted>");
});

test("a general web provider's probe: one known-answer search, available when the known target is among the top hits", async () => {
  const seen: { url: string; init: Parameters<ProviderFetch>[1] }[] = [];
  const tavily = tavilyProvider({
    apiKey: "tavily-secret",
    fetchImpl: fetchReturning(
      JSON.stringify({ results: [{ title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762", content: "..." }] }),
      200,
      seen,
    ),
  });
  assert.ok(tavily.check);
  const status = await tavily.check();
  assert.equal(status.state, "available");
  assert.equal(seen.length, 1);
  assert.ok(status.log!.some((line) => /POST https:\/\/api\.tavily\.com\/search/.test(line.text)));
  assert.ok(status.log!.every((line) => !line.text.includes("tavily-secret")));
  const miss = tavilyProvider({
    apiKey: "k",
    fetchImpl: fetchReturning(JSON.stringify({ results: [{ title: "x", url: "https://example.org/x", content: "" }] })),
  });
  const missed = await miss.check!();
  assert.equal(missed.state, "degraded");
  assert.match(missed.detail ?? "", /without the known target/);
});

test("probeOpenRouterEmbeddings: one one-word request; needs-key without a key; the key never reaches the log", async () => {
  const seen: { url: string; init: Parameters<ProviderFetch>[1] }[] = [];
  const ok = await probeOpenRouterEmbeddings(
    "or-secret",
    "openai/text-embedding-3-small",
    fetchReturning('{"model":"openai/text-embedding-3-small","data":[{"index":0,"embedding":[0.1,0.2,0.3]}]}', 200, seen),
  );
  assert.equal(ok.id, "openrouter-embeddings");
  assert.equal(ok.state, "available");
  assert.match(ok.detail ?? "", /3 dimensions/);
  assert.equal(seen[0]!.url, "https://openrouter.ai/api/v1/embeddings");
  assert.equal(seen[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(seen[0]!.init.body!).input, ["hello"]);
  assert.ok(ok.log!.every((line) => !line.text.includes("or-secret")));
  assert.ok(ok.log!.some((line) => /model=openai\/text-embedding-3-small/.test(line.text)));

  const keyless = await probeOpenRouterEmbeddings(undefined, "m", async () => {
    throw new Error("must not be called");
  });
  assert.equal(keyless.state, "needs-key");
  const refused = await probeOpenRouterEmbeddings("bad", "m", fetchReturning('{"error":{"message":"no"}}', 401));
  assert.equal(refused.state, "needs-key");
  const throttled = await probeOpenRouterEmbeddings("k", "m", fetchReturning("", 429));
  assert.equal(throttled.state, "degraded");
  const empty = await probeOpenRouterEmbeddings("k", "m", fetchReturning('{"data":[]}'));
  assert.equal(empty.state, "degraded");
});

test("EnginePool.seed takes an earlier engine table; unknown and unchecked entries are ignored", () => {
  const pool = new EnginePool({ byRoute: { web: ["google", "bing"], news: ["bing"] } });
  pool.seed([
    { id: "google", state: "blocked", detail: "CAPTCHA", checkedAt: 10 },
    { id: "bing", state: "unchecked" },
    { id: "duckduckgo", state: "available", checkedAt: 10 },
  ]);
  const table = new Map(pool.status().map((status) => [status.id, status]));
  assert.equal(table.get("google")?.state, "blocked");
  assert.equal(table.get("google")?.detail, "CAPTCHA");
  assert.equal(table.get("bing")?.state, "unchecked");
  assert.equal(table.has("duckduckgo"), false);
});

test("a seeded searxng status with engines seeds the engine pool", () => {
  const pool = new EnginePool({ byRoute: { web: ["google", "bing"] } });
  const searxng: WebSearchProvider = { id: "searxng", kinds: ["general"], metasearch: true, async search() { return { hits: [] }; } };
  new WebAccessManager({
    providers: [searxng],
    chains: { general: ["searxng"] },
    engines: pool,
    seededStatuses: [
      {
        id: "searxng",
        state: "available",
        checkedAt: Date.now(),
        engines: [{ id: "google", state: "available", checkedAt: 1 }, { id: "bing", state: "unreachable", checkedAt: 1 }],
      },
    ],
  });
  const table = new Map(pool.status().map((status) => [status.id, status.state]));
  assert.equal(table.get("google"), "available");
  assert.equal(table.get("bing"), "unreachable");
});

test("the SearXNG launch check logs each engine's probes and summarizes them on the provider's status", async () => {
  const pool = new EnginePool({ byRoute: { news: ["bing", "duckduckgo"] }, perMinute: 600, burst: 10 });
  const asked: string[] = [];
  const searxng: WebSearchProvider = {
    id: "searxng",
    kinds: ["general", "news"],
    metasearch: true,
    async search(request) {
      const engine = request.engines![0]!;
      asked.push(engine);
      if (engine === "duckduckgo") return { hits: [], engineFailures: [{ engine, reason: "CAPTCHA" }] };
      return { hits: [{ title: "t", url: `https://news.example.org/${encodeURIComponent(request.query)}`, snippet: "", source: "searxng" }] };
    },
  };
  const manager = new WebAccessManager({ providers: [searxng], chains: { general: ["searxng"], news: ["searxng"] }, engines: pool, sleep: noSleep });
  const table = await manager.startChecks();
  const status = table.find((entry) => entry.id === "searxng")!;
  assert.equal(status.state, "available");
  assert.equal(status.detail, "1 of 2 engines usable");
  const log = (status as { log?: { level: string; text: string }[] }).log!;
  assert.ok(log.some((line) => /probe searxng: 2 engines/.test(line.text)));
  assert.ok(log.some((line) => /^bing: available/.test(line.text)));
  assert.ok(log.some((line) => /^duckduckgo: blocked/.test(line.text) && line.level === "error"));
  const engines = status.engines as unknown as { id: string; log?: { level: string; text: string }[] }[];
  const bing = engines.find((engine) => engine.id === "bing")!;
  assert.equal(bing.log!.filter((line) => /^probe bing:/.test(line.text)).length, 2, "two canaries, two probe lines");
  assert.ok(bing.log!.some((line) => /1 hits in \d+ ms/.test(line.text)));
  const ddg = engines.find((engine) => engine.id === "duckduckgo")!;
  assert.ok(ddg.log!.some((line) => /engine failure: CAPTCHA/.test(line.text) && line.level === "warn"));
  assert.ok(asked.length >= 3);
});
