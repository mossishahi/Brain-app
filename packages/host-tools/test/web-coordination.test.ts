import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebAccess } from "@brainstorm-agentic/core";

import {
  Breaker,
  EnginePool,
  FairGate,
  TokenBucket,
  WEB_SEARCH_MANIFESTS,
  WebAccessError,
  WebAccessManager,
  neutralizeSearxngTokens,
  notePaidRequest,
  paidRequestsInMonth,
  paidRequestsOfRun,
  parsePaperDetailsInput,
  parsePaperSearchInput,
  parseWebSearchInput,
  usageFile,
  webToolNames,
  type SchedulerClock,
  type WebSearchProvider,
} from "../src/index.js";

/** A clock whose sleeps advance time instantly, recording each one. */
function fakeClock(start = Date.UTC(2026, 8, 30, 12)): SchedulerClock & {
  advance(ms: number): void;
  readonly sleeps: number[];
} {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0.5,
    advance: (ms) => {
      now += ms;
    },
    sleeps,
  };
}

test("every web tool describes itself and every parameter", () => {
  assert.deepEqual(
    WEB_SEARCH_MANIFESTS.map((manifest) => manifest.toolId),
    ["web_search", "web_fetch", "news_search", "paper_search", "paper_details"],
  );
  for (const manifest of WEB_SEARCH_MANIFESTS) {
    assert.ok((manifest.definition.description ?? "").length > 80, manifest.toolId);
    const schema = manifest.definition.inputSchema as {
      properties?: Record<string, { description?: unknown }>;
    };
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      assert.ok(
        typeof property.description === "string" && property.description.length > 0,
        `${manifest.toolId}.${name} has a description`,
      );
    }
  }
  for (const id of ["news_search", "paper_search", "paper_details"]) {
    assert.deepEqual(
      WEB_SEARCH_MANIFESTS.find((manifest) => manifest.toolId === id)!.operations,
      ["web.search"],
    );
  }
});

test("only the tools this deployment can answer are offered", () => {
  const base = {
    async search(): Promise<never> {
      throw new Error("unused");
    },
    async fetch(): Promise<never> {
      throw new Error("unused");
    },
    async searchPapers(): Promise<never> {
      throw new Error("unused");
    },
    async paperDetails(): Promise<never> {
      throw new Error("unused");
    },
  };
  const everything: WebAccess = { ...base, backedKinds: () => ["general", "scholarly", "news"] };
  assert.deepEqual(webToolNames(everything), [
    "web_search",
    "web_fetch",
    "news_search",
    "paper_search",
    "paper_details",
  ]);
  const scholarlyOnly: WebAccess = { ...base, backedKinds: () => ["scholarly"] };
  assert.deepEqual(webToolNames(scholarlyOnly), ["web_fetch", "paper_search", "paper_details"]);
  const generalOnly: WebAccess = { ...base, backedKinds: () => ["general"] };
  assert.deepEqual(webToolNames(generalOnly), ["web_search", "web_fetch", "paper_search"]);
});

test("web_search options map onto the coordinator's query", () => {
  assert.deepEqual(
    parseWebSearchInput({
      query: " crispr off-target ",
      max_results: 12,
      page: 9,
      date_from: "2024-01-01",
      date_to: "2024-12-31",
      include_domains: ["nih.gov"],
      exclude_domains: ["example.com"],
      language: "EN",
      country: "de",
      file_type: ".PDF",
    }),
    {
      query: "crispr off-target",
      maxResults: 12,
      page: 5,
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
      domains: ["nih.gov"],
      excludeDomains: ["example.com"],
      language: "en",
      country: "DE",
      fileType: "pdf",
    },
  );
  assert.equal(parseWebSearchInput({ query: "x" }, "news").kind, "news");
  assert.equal(parseWebSearchInput({ query: "x", file_type: "pdf" }, "news").fileType, undefined);
  assert.equal(parseWebSearchInput({ query: "x", kind: "scholarly" }).kind, "scholarly");
});

test("malformed web_search options are refused with the correction", () => {
  const refused = (input: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(
      () => parseWebSearchInput(input as never),
      (error: unknown) => error instanceof WebAccessError && pattern.test(error.message),
    );
  refused({ query: " " }, /query must be a non-empty string/);
  refused({ query: "x", date_from: "2024/01/01" }, /YYYY-MM-DD/);
  refused({ query: "x", date_from: "2024-05-01", date_to: "2024-01-01" }, /date range is empty/);
  refused({ query: "x", recency: "7d" }, /recency must be one of day, week, month, year/);
  refused({ query: "x", country: "Germany" }, /ISO 3166-1 alpha-2/);
  refused({ query: "x", language: "english" }, /ISO 639-1/);
});

test("paper_search dates: years, days, and the last N years", () => {
  const now = new Date(Date.UTC(2026, 8, 30));
  assert.deepEqual(
    parsePaperSearchInput(
      { query: "diffusion models", sources: ["arxiv"], title_contains: ["diffusion"], last_years: 5 },
      now,
    ),
    { query: "diffusion models", titleContains: ["diffusion"], dateFrom: "2021-09-30", sources: ["arxiv"] },
  );
  assert.equal(parsePaperSearchInput({ query: "q", year_from: 2019, last_years: 5 }, now).dateFrom, "2021-09-30");
  assert.equal(parsePaperSearchInput({ query: "q", year_from: 2023, last_years: 5 }, now).dateFrom, "2023-01-01");
  assert.equal(parsePaperSearchInput({ query: "q", date_from: "2020-03", year_from: 2023 }, now).dateFrom, "2020-03");
  assert.equal(parsePaperSearchInput({ query: "q", year_to: 2023 }, now).dateTo, "2023");
  assert.throws(() => parsePaperSearchInput({ query: "q", year_from: 2024, year_to: 2020 }, now), /year range is empty/);
});

test("paper_search vocabulary: tool names map to the core's, unknown values are refused", () => {
  const now = new Date(Date.UTC(2026, 8, 30));
  const parsed = parsePaperSearchInput(
    {
      query: "q",
      sources: ["semantic_scholar", "openalex", "openalex"],
      types: ["journal_article", "book_chapter"],
      sort: "most_cited",
      fields_of_study: ["computer science"],
      open_access_only: true,
      min_citations: 50,
    },
    now,
  );
  assert.deepEqual(parsed.sources, ["semantic-scholar", "openalex"]);
  assert.deepEqual(parsed.types, ["journal-article", "book-chapter"]);
  assert.equal(parsed.sort, "most-cited");
  assert.deepEqual(parsed.fieldsOfStudy, ["Computer Science"]);
  assert.equal(parsed.openAccessOnly, true);
  assert.equal(parsed.minCitations, 50);
  assert.deepEqual(
    parsePaperSearchInput({ native_query: { source: "openalex", query: "title.search:x" } }, now).native,
    { source: "openalex", query: "title.search:x" },
  );
  assert.throws(() => parsePaperSearchInput({ query: "q", types: ["poster"] }, now), /unknown type "poster"/);
  assert.throws(() => parsePaperSearchInput({ query: "q", fields_of_study: ["Astrology"] }, now), /not a Semantic Scholar field/);
  assert.throws(() => parsePaperSearchInput({ query: "q", sources: ["google"] }, now), /unknown source "google"/);
  assert.throws(() => parsePaperSearchInput({ native_query: { source: "web", query: "x" } }, now), /native_query\.source/);
  assert.throws(() => parsePaperSearchInput({ query: "" }, now), /or give native_query/);
});

test("paper_details input", () => {
  assert.deepEqual(parsePaperDetailsInput({ ids: "10.1038/nature14539" }), { ids: ["10.1038/nature14539"] });
  assert.deepEqual(
    parsePaperDetailsInput({ ids: ["1706.03762"], include: ["references", "references", "citations"], limit: 5 }),
    { ids: ["1706.03762"], include: ["references", "citations"], limit: 5 },
  );
  assert.throws(() => parsePaperDetailsInput({ ids: [] }), /ids must list/);
  assert.throws(() => parsePaperDetailsInput({ ids: ["x"], include: ["figures"] }), /unknown part "figures"/);
});

test("SearXNG control tokens cannot override the engine list", () => {
  assert.equal(neutralizeSearxngTokens("rust !g lifetimes :en <5 !!w"), "rust g lifetimes en 5 w");
  const plain = '"exact phrase" -word site:example.org C++ 3:1';
  assert.equal(neutralizeSearxngTokens(plain), plain);
});

test("a token bucket allows its burst, then paces", async () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({ perMinute: 6, burst: 2, clock });
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
  assert.equal(bucket.waitMs(), 10_000);
  await bucket.take();
  assert.deepEqual(clock.sleeps, [10_000]);
});

test("the run-wide gate serves agents round-robin", async () => {
  const gate = new FairGate(1);
  const order: string[] = [];
  const first = await gate.acquire("agent-a");
  const pending = [
    gate.acquire("agent-a").then((release) => {
      order.push("a2");
      release();
    }),
    gate.acquire("agent-a").then((release) => {
      order.push("a3");
      release();
    }),
    gate.acquire("agent-b").then((release) => {
      order.push("b1");
      release();
    }),
  ];
  first();
  await Promise.all(pending);
  assert.deepEqual(order, ["a2", "b1", "a3"]);
});

test("a blocked upstream cools down, doubling, with one trial at a time", () => {
  const clock = fakeClock();
  const breaker = new Breaker({
    baseCooldownMs: 1_000,
    maxCooldownMs: 3_000,
    errorThreshold: 2,
    errorCooldownMs: 500,
    clock,
  });
  assert.equal(breaker.block("captcha"), 1_000);
  assert.equal(breaker.admit(), false);
  clock.advance(1_000);
  assert.equal(breaker.state(), "trial");
  assert.equal(breaker.admit(), true);
  assert.equal(breaker.admit(), false, "one trial request at a time");
  assert.equal(breaker.block("captcha"), 2_000);
  clock.advance(2_000);
  assert.equal(breaker.block("captcha"), 3_000, "the cool-down is capped");
  breaker.success();
  assert.equal(breaker.state(), "closed");
});

test("an engine that hit a CAPTCHA rests at least an hour while the others serve", async () => {
  const clock = fakeClock();
  const pool = new EnginePool({ byRoute: { web: ["google", "yahoo"] }, jitter: 0, clock });
  assert.deepEqual(await pool.acquire("web"), { engines: ["google"], waitedMs: 0 });
  pool.report([{ engine: "google", hits: 0, failure: "CAPTCHA" }]);
  const engines = async () => {
    const answer = await pool.acquire("web");
    return "engines" in answer ? answer.engines : [];
  };
  assert.deepEqual(await engines(), ["yahoo"]);
  clock.advance(59 * 60_000);
  assert.deepEqual(await engines(), ["yahoo"]);
  clock.advance(2 * 60_000);
  assert.deepEqual(await engines(), ["google"], "after the hour one trial request goes");
});

test("the paid-request ledger counts per month and per run", () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-usage-"));
  try {
    const now = new Date(Date.UTC(2026, 8, 30, 12));
    notePaidRequest(dir, "brave", "run-a", now);
    notePaidRequest(dir, "brave", "run-a", now);
    notePaidRequest(dir, "brave", "run-b", now);
    notePaidRequest(dir, "brave", "run-a", new Date(Date.UTC(2026, 7, 31, 23)));
    assert.equal(paidRequestsInMonth(dir, "brave", now), 3);
    assert.equal(paidRequestsOfRun(dir, "brave", "run-a", now), 3, "a run spanning the month boundary");
    assert.equal(paidRequestsOfRun(dir, "brave", "run-b", now), 1);
    assert.equal(usageFile(dir, "brave", "2026-09"), join(dir, "web-usage", "brave-2026-09.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every billed request counts against the paid budget, a resume's too", async () => {
  const spends: string[] = [];
  let paidCalls = 0;
  const paid: WebSearchProvider = {
    id: "paid",
    kinds: ["general"],
    costPerRequestUsd: 0.005,
    async search(request) {
      paidCalls += 1;
      return {
        hits:
          paidCalls === 1
            ? []
            : [{ title: "paid", url: `https://example.org/paid/${request.query}`, snippet: "s", source: "paid" }],
      };
    },
  };
  const free: WebSearchProvider = {
    id: "free",
    kinds: ["general"],
    async search(request) {
      return {
        hits: [{ title: "free", url: `https://example.org/free/${request.query}`, snippet: "s", source: "free" }],
      };
    },
  };
  const manager = new WebAccessManager({
    providers: [paid, free],
    chains: {},
    routes: { web: ["paid", "free"] },
    budgets: { paid: 3 },
    spent: { paid: 1 },
    onSpend: (id) => spends.push(id),
  });
  // An empty paid page fails over, and is billed all the same.
  assert.equal((await manager.search({ query: "one" })).provider, "free");
  assert.equal((await manager.search({ query: "two" })).provider, "paid");
  // One request before the resume plus two now: the budget of three is spent.
  assert.equal((await manager.search({ query: "three" })).provider, "free");
  assert.equal(paidCalls, 2);
  assert.deepEqual(spends, ["paid", "paid"]);
});
