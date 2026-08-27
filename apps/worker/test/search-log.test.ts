import assert from "node:assert/strict";
import test from "node:test";

import type { WebAccessLogRecord } from "@brainstorm-agentic/core";

import { createSearchLog } from "../src/search-log.js";
import { webSearchRuntimeFromEnv } from "../src/wiring.js";

function record(id: string): WebAccessLogRecord {
  return {
    id,
    at: 1000,
    tool: "web_search",
    outcome: "ok",
    request: { query: `question ${id}`, kind: "general", maxResults: 5 },
    response: { query: `question ${id}`, kind: "general", provider: "p", results: [] },
    provider: "p",
    elapsedMs: 12,
  };
}

test("search records batch into one append, one JSON line each", async () => {
  const appends: string[] = [];
  const log = createSearchLog("/tmp/searches.jsonl", {
    append: async (_path, data) => {
      appends.push(data);
    },
  });
  log.note(record("a"));
  log.note(record("b"));
  await log.close();
  assert.equal(appends.length, 1, "two records coalesce into one write");
  const lines = appends[0]!.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), record("a"));
  assert.deepEqual(JSON.parse(lines[1]!), record("b"));
});

test("a failed append announces once and stops; the run is never failed", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => {
    errors.push(String(message));
  };
  try {
    const log = createSearchLog("/tmp/searches.jsonl", {
      append: async () => {
        throw new Error("disk on fire");
      },
    });
    log.note(record("a"));
    await log.close();
    log.note(record("b"));
    await log.close();
    assert.equal(errors.length, 1, "one loud line, not one per record");
    assert.match(errors[0]!, /search log stopped/);
    assert.match(errors[0]!, /disk on fire/);
  } finally {
    console.error = original;
  }
});

test("webSearchRuntimeFromEnv: defaults, JSON config, and secrets from env", () => {
  // Absent variable: the default config (scholarly on via config defaulting).
  const bare = webSearchRuntimeFromEnv({});
  assert.deepEqual(bare.config, {});
  assert.deepEqual(bare.secrets, {});

  const parsed = webSearchRuntimeFromEnv({
    BRAINSTORM_AGENTIC_WEB_SEARCH: JSON.stringify({
      general: "tavily",
      scholarly: true,
      cache: { enabled: true, ttlHours: 6 },
      contactEmail: "team@example.org",
    }),
    TAVILY_API_KEY: "tvly-abc",
    SEMANTIC_SCHOLAR_API_KEY: "s2-abc",
  });
  assert.equal(parsed.config.general, "tavily");
  assert.deepEqual(parsed.config.cache, { enabled: true, ttlHours: 6 });
  assert.equal(parsed.secrets.tavilyApiKey, "tvly-abc");
  assert.equal(parsed.secrets.semanticScholarApiKey, "s2-abc");
  assert.equal(parsed.secrets.braveApiKey, undefined);
});

test("webSearchRuntimeFromEnv: a malformed JSON config is announced and ignored", () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => {
    errors.push(String(message));
  };
  try {
    const parsed = webSearchRuntimeFromEnv({
      BRAINSTORM_AGENTIC_WEB_SEARCH: "{not json",
    });
    assert.deepEqual(parsed.config, {});
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /BRAINSTORM_AGENTIC_WEB_SEARCH could not be parsed/);
  } finally {
    console.error = original;
  }
});
