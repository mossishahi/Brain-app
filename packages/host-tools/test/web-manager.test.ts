import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  WebAccessLogRecord,
  WebSearchHit,
  WebSearchKind,
} from "@brainstorm-agentic/core";

import {
  FsWebSearchCache,
  LayeredWebSearchCache,
  MemoryWebSearchCache,
  ProviderRequestError,
  WebAccessError,
  WebAccessManager,
  buildWebAccessManager,
  searchCacheKey,
  webAccessTools,
  type ProviderSearchRequest,
  type WebSearchProvider,
} from "../src/index.js";

/** A scripted provider: counts calls, optionally fails the first N. */
function scriptedProvider(options: {
  readonly id: string;
  readonly kinds?: readonly WebSearchKind[];
  readonly hits?: readonly WebSearchHit[];
  readonly failFirst?: number;
  readonly retryable?: boolean;
  readonly delayMs?: number;
  readonly minIntervalMs?: number;
}): WebSearchProvider & { calls: ProviderSearchRequest[] } {
  const calls: ProviderSearchRequest[] = [];
  let failures = 0;
  return {
    id: options.id,
    kinds: options.kinds ?? ["general", "scholarly", "news"],
    ...(options.minIntervalMs !== undefined
      ? { minIntervalMs: options.minIntervalMs }
      : {}),
    calls,
    async search(request) {
      calls.push(request);
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (failures < (options.failFirst ?? 0)) {
        failures += 1;
        throw new ProviderRequestError(
          `${options.id} scripted failure`,
          options.retryable ?? false,
        );
      }
      return {
        hits: options.hits ?? [
          {
            title: `${options.id} answer`,
            url: `https://example.org/${options.id}/${request.query}`,
            snippet: "snippet",
            source: options.id,
          },
        ],
        total: 1,
      };
    },
  };
}

test("routes by kind and fails over down the chain, logging both", async () => {
  const records: WebAccessLogRecord[] = [];
  const broken = scriptedProvider({ id: "broken", failFirst: 99 });
  const working = scriptedProvider({ id: "working" });
  const scholarly = scriptedProvider({ id: "scholarly-only", kinds: ["scholarly"] });
  const manager = new WebAccessManager({
    providers: [broken, working, scholarly],
    chains: { general: ["broken", "working"], scholarly: ["scholarly-only"] },
    log: (record) => records.push(record),
  });

  const general = await manager.search({ query: "alpha" });
  assert.equal(general.provider, "working");
  assert.equal(broken.calls.length, 1, "non-retryable failure is not retried");
  const generalRecord = records.find((record) => record.outcome === "ok");
  assert.ok(generalRecord);
  assert.deepEqual(generalRecord.failedProviders, [
    { provider: "broken", error: "broken scripted failure" },
  ]);

  const papers = await manager.search({ query: "alpha", kind: "scholarly" });
  assert.equal(papers.provider, "scholarly-only");
  assert.deepEqual(manager.backedKinds(), ["general", "scholarly"]);
});

test("a retryable provider failure is retried once before failing over", async () => {
  const flaky = scriptedProvider({ id: "flaky", failFirst: 1, retryable: true });
  const manager = new WebAccessManager({
    providers: [flaky],
    chains: { general: ["flaky"] },
    sleep: async () => {},
  });
  const answer = await manager.search({ query: "beta" });
  assert.equal(answer.provider, "flaky");
  assert.equal(flaky.calls.length, 2, "one bounded retry after the retryable failure");
});

test("an unconfigured kind is an explicit configuration error naming the backed kinds", async () => {
  const records: WebAccessLogRecord[] = [];
  const scholarly = scriptedProvider({ id: "openalex-like", kinds: ["scholarly"] });
  const manager = new WebAccessManager({
    providers: [scholarly],
    chains: { scholarly: ["openalex-like"] },
    log: (record) => records.push(record),
  });
  await assert.rejects(
    manager.search({ query: "gamma", kind: "general" }),
    (error: Error) =>
      error instanceof WebAccessError &&
      /no general search provider is configured/.test(error.message) &&
      /scholarly/.test(error.message),
  );
  assert.equal(records[0]!.outcome, "error");
});

test("identical in-flight questions coalesce into one upstream call, each with its own log row", async () => {
  const records: WebAccessLogRecord[] = [];
  const slow = scriptedProvider({ id: "slow", delayMs: 30 });
  const manager = new WebAccessManager({
    providers: [slow],
    chains: { general: ["slow"] },
    log: (record) => records.push(record),
  });
  const [first, second] = await Promise.all([
    manager.search({ query: "delta" }),
    manager.search({ query: "delta" }),
  ]);
  assert.equal(slow.calls.length, 1, "one upstream call served both");
  assert.deepEqual(first.results, second.results);
  assert.equal(records.length, 2, "every caller gets its own row");
  const joined = records.find((record) => record.outcome === "coalesced");
  const original = records.find((record) => record.outcome === "ok");
  assert.ok(joined && original);
  assert.equal(joined.coalescedWith, original.id, "the joiner names the row it joined");
});

test("the global concurrency bound holds under a parallel burst", async () => {
  let inFlight = 0;
  let peak = 0;
  const provider: WebSearchProvider = {
    id: "counting",
    kinds: ["general"],
    async search(request) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return {
        hits: [{
          title: request.query,
          url: `https://example.org/${request.query}`,
          snippet: "",
          source: "counting",
        }],
      };
    },
  };
  const manager = new WebAccessManager({
    providers: [provider],
    chains: { general: ["counting"] },
    maxConcurrent: 2,
    maxPerProvider: 2,
  });
  await Promise.all(
    Array.from({ length: 8 }, (_, index) => manager.search({ query: `q${index}` })),
  );
  assert.ok(peak <= 2, `at most two calls in flight, saw ${peak}`);
});

test("the cache serves a repeated keyword without a provider call — and still logs it", async () => {
  const records: WebAccessLogRecord[] = [];
  const provider = scriptedProvider({ id: "cached-upstream" });
  const manager = new WebAccessManager({
    providers: [provider],
    chains: { general: ["cached-upstream"] },
    cache: new MemoryWebSearchCache(60_000),
    log: (record) => records.push(record),
  });
  const first = await manager.search({ query: "epsilon" });
  const second = await manager.search({ query: "  Epsilon " });
  assert.equal(provider.calls.length, 1, "the normalized keyword hit the cache");
  assert.equal(second.cached, true);
  assert.deepEqual(second.results, first.results);
  assert.equal(records.length, 2);
  assert.equal(records[1]!.outcome, "cached");
  assert.equal(records[1]!.cacheKey, records[0]!.cacheKey);
});

test("the disk cache survives a new manager (cross-run reuse) and layers under memory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-cache-"));
  try {
    const provider = scriptedProvider({ id: "run-one" });
    const cache = () =>
      new LayeredWebSearchCache(
        new MemoryWebSearchCache(60_000),
        new FsWebSearchCache(dir, 60_000),
      );
    const runOne = new WebAccessManager({
      providers: [provider],
      chains: { general: ["run-one"] },
      cache: cache(),
    });
    await runOne.search({ query: "zeta" });
    // A NEW manager (a new run) with a fresh memory layer over the same disk.
    const providerTwo = scriptedProvider({ id: "run-one" });
    const runTwo = new WebAccessManager({
      providers: [providerTwo],
      chains: { general: ["run-one"] },
      cache: cache(),
    });
    const answer = await runTwo.search({ query: "zeta" });
    assert.equal(providerTwo.calls.length, 0, "the second run reused the first run's answer");
    assert.equal(answer.cached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("results dedupe by DOI first, then by normalized URL, preserving order", async () => {
  const provider = scriptedProvider({
    id: "dupes",
    hits: [
      { title: "A", url: "https://Example.org/paper/", snippet: "", source: "dupes", doi: "10.1/x" },
      { title: "A again", url: "https://other.org/mirror", snippet: "", source: "dupes", doi: "10.1/X" },
      { title: "B", url: "https://example.org/paper?utm_source=x", snippet: "", source: "dupes" },
      { title: "C", url: "https://example.org/c", snippet: "", source: "dupes" },
    ],
  });
  const manager = new WebAccessManager({
    providers: [provider],
    chains: { general: ["dupes"] },
  });
  const answer = await manager.search({ query: "eta", maxResults: 10 });
  assert.deepEqual(
    answer.results.map((hit) => hit.title),
    ["A", "B", "C"],
    "the DOI dupe fell out; the utm-tracked URL dupe fell out",
  );
});

test("the log carries the verbatim request and the exact payload the model receives", async () => {
  const records: WebAccessLogRecord[] = [];
  const provider = scriptedProvider({ id: "verbatim" });
  const manager = new WebAccessManager({
    providers: [provider],
    chains: { general: ["verbatim"] },
    log: (record) => records.push(record),
  });
  const answer = await manager.search({
    query: "exact question — every char? & sign",
    maxResults: 3,
  });
  const record = records[0]!;
  assert.equal(record.tool, "web_search");
  assert.equal(record.request.query, "exact question — every char? & sign");
  assert.equal(record.request.maxResults, 3);
  // Character-for-character: the logged response IS the delivered answer.
  assert.deepEqual(record.response, JSON.parse(JSON.stringify(answer)));
  assert.equal(
    record.cacheKey,
    searchCacheKey({
      kind: "general",
      query: "exact question — every char? & sign",
      maxResults: 3,
    }),
  );
});

test("attribution (task, agent, node path) rides every log row", async () => {
  const records: WebAccessLogRecord[] = [];
  const provider = scriptedProvider({ id: "attributed" });
  const manager = new WebAccessManager({
    providers: [provider],
    chains: { general: ["attributed"] },
    log: (record) => records.push(record),
  });
  await manager.search(
    { query: "theta" },
    { taskId: "task-9", agentId: "member-2", nodePath: "root/review/comment" },
  );
  assert.equal(records[0]!.taskId, "task-9");
  assert.equal(records[0]!.agentId, "member-2");
  assert.equal(records[0]!.nodePath, "root/review/comment");
});

test("a fetch refusal surfaces as a WebAccessError and is logged as what the model heard", async () => {
  const records: WebAccessLogRecord[] = [];
  const manager = new WebAccessManager({
    providers: [],
    chains: {},
    log: (record) => records.push(record),
  });
  await assert.rejects(
    manager.fetch({ url: "ftp://example.org/file" }),
    (error: Error) => error instanceof WebAccessError && /only http\(s\)/.test(error.message),
  );
  assert.equal(records[0]!.tool, "web_fetch");
  assert.equal(records[0]!.outcome, "error");
  assert.match(String(records[0]!.response), /only http\(s\)/);
});

test("the unified tools wrap the manager and convert errors into honest tool refusals", async () => {
  const provider = scriptedProvider({ id: "tooling", kinds: ["scholarly"] });
  const manager = new WebAccessManager({
    providers: [provider],
    chains: { scholarly: ["tooling"] },
  });
  const [searchTool, fetchTool] = webAccessTools(manager);
  const good = await searchTool!.execute(
    { query: "iota", kind: "scholarly" },
    { runId: "test" },
  );
  assert.notEqual(good.isError, true);
  const bad = await searchTool!.execute({ query: "iota" }, { runId: "test" });
  assert.equal(bad.isError, true, "an unconfigured kind is a refusal, not a crash");
  assert.match(String(bad.output), /scholarly/);
  const refused = await fetchTool!.execute({ url: "" }, { runId: "test" });
  assert.equal(refused.isError, true);
});

test("buildWebAccessManager: scholarly is on by default, general needs its key, nothing configured means no manager", () => {
  // Default config: the keyless scholarly chain backs search out of the box.
  const scholarlyOnly = buildWebAccessManager({ config: {} });
  assert.ok(scholarlyOnly);
  assert.deepEqual(scholarlyOnly.backedKinds(), ["scholarly"]);

  // A selected general provider without its key contributes nothing.
  const keyless = buildWebAccessManager({ config: { general: "tavily" } });
  assert.ok(keyless);
  assert.deepEqual(keyless.backedKinds(), ["scholarly"]);

  // With the key, general and news come alive.
  const keyed = buildWebAccessManager({
    config: { general: "tavily" },
    secrets: { tavilyApiKey: "tvly-test" },
  });
  assert.ok(keyed);
  assert.deepEqual([...keyed.backedKinds()].sort(), ["general", "news", "scholarly"]);

  // Everything off: no manager, so the broker reports web-search honestly.
  assert.equal(
    buildWebAccessManager({ config: { scholarly: false } }),
    undefined,
  );
});
