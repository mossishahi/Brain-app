import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readSearchTable,
  searchLogPath,
  searchTableCsv,
} from "../src/web-search-log.js";

function withSessionDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "search-log-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the search table reads one row per call with attribution, tolerating a torn tail", () => {
  withSessionDir((dir) => {
    const lines = [
      JSON.stringify({
        id: "web-x-1",
        at: 1700000000000,
        tool: "web_search",
        outcome: "ok",
        request: { query: "manifold learning", kind: "scholarly", maxResults: 5 },
        response: {
          query: "manifold learning",
          kind: "scholarly",
          provider: "openalex",
          results: [{ title: "t", url: "u", snippet: "s", source: "openalex" }],
        },
        provider: "openalex",
        elapsedMs: 812,
        cacheKey: "key-1",
        taskId: "task-1",
        agentId: "member-3",
        nodePath: "root/review/comment-step",
      }),
      JSON.stringify({
        id: "web-x-2",
        at: 1700000001000,
        tool: "web_fetch",
        outcome: "error",
        request: { url: "https://example.org/gone" },
        error: "HTTP 404 fetching https://example.org/gone",
        elapsedMs: 90,
      }),
      '{"torn": "lin', // a mid-append tail must be skipped, never an error
    ];
    writeFileSync(searchLogPath(dir), lines.join("\n") + "\n", "utf8");
    const table = readSearchTable(dir);
    assert.equal(table.total, 2);
    const [search, fetchRow] = table.entries;
    assert.equal(search!.subject, "manifold learning");
    assert.equal(search!.kind, "scholarly");
    assert.equal(search!.provider, "openalex");
    assert.equal(search!.resultCount, 1);
    assert.equal(search!.agentId, "member-3");
    assert.equal(search!.nodePath, "root/review/comment-step");
    assert.equal(fetchRow!.tool, "web_fetch");
    assert.equal(fetchRow!.outcome, "error");
    assert.equal(fetchRow!.subject, "https://example.org/gone");
    assert.match(fetchRow!.error ?? "", /404/);
  });
});

test("failure causes are named per row and counted across the run", () => {
  withSessionDir((dir) => {
    const lines = [
      // Succeeded, but only after a provider failed over AND an engine
      // inside the metasearch answer was CAPTCHA-blocked.
      JSON.stringify({
        id: "web-f-1",
        at: 1700000000000,
        tool: "web_search",
        outcome: "ok",
        request: { query: "q1", kind: "general", maxResults: 5 },
        response: {
          query: "q1",
          kind: "general",
          provider: "searxng",
          results: [],
          engineFailures: [{ engine: "google", reason: "CAPTCHA" }],
        },
        provider: "searxng",
        failedProviders: [{ provider: "openalex", error: "openalex answered HTTP 429" }],
        elapsedMs: 40,
      }),
      // Same engine blocked again on a later call.
      JSON.stringify({
        id: "web-f-2",
        at: 1700000001000,
        tool: "web_search",
        outcome: "ok",
        request: { query: "q2", kind: "general", maxResults: 5 },
        response: {
          query: "q2",
          kind: "general",
          provider: "searxng",
          results: [],
          engineFailures: [{ engine: "google", reason: "CAPTCHA" }],
        },
        provider: "searxng",
        elapsedMs: 41,
      }),
      // A call that failed outright.
      JSON.stringify({
        id: "web-f-3",
        at: 1700000002000,
        tool: "web_search",
        outcome: "error",
        request: { query: "q3", kind: "news", maxResults: 5 },
        error: "no news search provider is configured on this deployment",
        elapsedMs: 2,
      }),
    ];
    writeFileSync(searchLogPath(dir), lines.join("\n") + "\n", "utf8");
    const table = readSearchTable(dir);
    assert.equal(
      table.entries[0]!.failures,
      "openalex: openalex answered HTTP 429 · google: CAPTCHA",
    );
    assert.deepEqual(table.failureSummary, [
      { cause: "google: CAPTCHA", count: 2 },
      { cause: "openalex: openalex answered HTTP 429", count: 1 },
      {
        cause: "web_search failed: no news search provider is configured on this deployment",
        count: 1,
      },
    ]);
  });
});

test("a run with no log yields an empty table, and the CSV escapes what needs escaping", () => {
  withSessionDir((dir) => {
    assert.deepEqual(readSearchTable(dir), { entries: [], total: 0, failureSummary: [] });
  });
  const csv = searchTableCsv({
    total: 1,
    failureSummary: [],
    entries: [
      {
        id: "web-1",
        at: 1700000000000,
        tool: "web_search",
        outcome: "ok",
        subject: 'a query with "quotes", commas',
        kind: "general",
        provider: "tavily",
        resultCount: 3,
        elapsedMs: 5,
      },
    ],
  });
  const [header, row] = csv.trimEnd().split("\r\n");
  assert.match(header!, /^time,tool,outcome,kind,provider,subject/);
  assert.match(row!, /"a query with ""quotes"", commas"/);
});
