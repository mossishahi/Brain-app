/**
 * The worker's availability seed: reading the server's table (fresh, stale,
 * absent, malformed), mapping tool rows and purposes onto the web manager's
 * inputs, and the append-only event ledger of the run's status changes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WebSourceStatus } from "@brainstorm-agentic/core";

import {
  AVAILABILITY_EVENTS_FILE,
  AVAILABILITY_FILE,
  AVAILABILITY_MAX_AGE_MS,
  availabilityEventWriter,
  loadAvailabilitySeed,
  parseAvailabilitySeed,
  readAvailabilitySeed,
} from "../src/availability-seed.js";

const NOW = 1_800_000_000_000;

function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    updatedAt: NOW - 5 * 60_000,
    demoteDegraded: true,
    tools: [
      {
        id: "searxng",
        label: "SearXNG",
        group: "search",
        state: "available",
        checkedAt: NOW - 5 * 60_000,
        latencyMs: 300,
        detail: "3 of 4 engines usable",
        log: [{ at: NOW - 5 * 60_000, level: "info", text: "probe" }],
        children: [
          { id: "google", label: "google", group: "search", state: "blocked", detail: "CAPTCHA", checkedAt: NOW - 5 * 60_000, until: NOW + 60 * 60_000, log: [] },
          { id: "bing", label: "bing", group: "search", state: "available", checkedAt: NOW - 5 * 60_000, log: [] },
        ],
      },
      { id: "brave", label: "Brave", group: "search", state: "needs-key", keyPresent: false, log: [] },
      { id: "openalex", label: "OpenAlex", group: "papers", state: "degraded", detail: "HTTP 429", checkedAt: NOW - 4 * 60_000, log: [] },
      { id: "core", label: "CORE", group: "papers", state: "disabled", log: [] },
      { id: "arxiv", label: "arXiv", group: "papers", state: "unchecked", log: [] },
      { id: "llm", label: "Chat model", group: "models", state: "available", checkedAt: NOW, log: [] },
      { id: "slurm", label: "Slurm", group: "infrastructure", state: "unreachable", checkedAt: NOW, log: [] },
      { id: "", label: "nameless", group: "papers", state: "available", log: [] },
      { id: "odd", label: "odd state", group: "papers", state: "probing", log: [] },
    ],
    purposes: [
      { purpose: "web", configured: ["searxng", "brave"], effective: ["searxng"], entries: [] },
      { purpose: "paper-lookup", configured: ["openalex", "crossref"], effective: ["crossref", "openalex"], entries: [] },
      { purpose: "citation-hop", configured: ["opencitations"], effective: ["opencitations"], entries: [] },
      { purpose: "embedding", configured: ["encoder:specter2"], effective: ["encoder:specter2"], entries: [] },
      { purpose: "news", configured: ["searxng"], effective: ["searxng", 7], entries: [] },
    ],
    ...overrides,
  });
}

test("a fresh table seeds web-source statuses (children as engines, disabled as not-configured) and the web routes", () => {
  const seed = parseAvailabilitySeed(report(), NOW);
  assert.ok(seed);
  assert.equal(seed.updatedAt, NOW - 5 * 60_000);
  const byId = new Map(seed.seededStatuses.map((status) => [status.id, status]));
  assert.deepEqual([...byId.keys()], ["searxng", "brave", "openalex", "core", "arxiv"]);
  const searxng = byId.get("searxng")!;
  assert.equal(searxng.state, "available");
  assert.equal(searxng.detail, "3 of 4 engines usable");
  assert.equal(searxng.checkedAt, NOW - 5 * 60_000);
  assert.deepEqual(searxng.engines, [
    { id: "google", state: "blocked", detail: "CAPTCHA", checkedAt: NOW - 5 * 60_000, until: NOW + 60 * 60_000 },
    { id: "bing", state: "available", checkedAt: NOW - 5 * 60_000 },
  ]);
  assert.equal("log" in searxng, false, "probe logs and latency stay in the table");
  assert.equal("latencyMs" in searxng, false);
  assert.deepEqual(byId.get("brave"), { id: "brave", state: "needs-key" });
  assert.deepEqual(byId.get("core"), { id: "core", state: "not-configured" });
  assert.deepEqual(byId.get("arxiv"), { id: "arxiv", state: "unchecked" });
  assert.deepEqual(seed.routeOrders, { web: ["searxng"], "paper-lookup": ["crossref", "openalex"] });
});

test("a table older than 30 minutes, a malformed one, or one of another version is ignored", () => {
  assert.equal(parseAvailabilitySeed(report({ updatedAt: NOW - AVAILABILITY_MAX_AGE_MS - 1 }), NOW), undefined);
  assert.ok(parseAvailabilitySeed(report({ updatedAt: NOW - AVAILABILITY_MAX_AGE_MS }), NOW), "exactly 30 minutes old still counts");
  assert.equal(parseAvailabilitySeed(report({ version: 2 }), NOW), undefined);
  assert.equal(parseAvailabilitySeed(report({ updatedAt: "yesterday" }), NOW), undefined);
  assert.equal(parseAvailabilitySeed("not json", NOW), undefined);
  assert.equal(parseAvailabilitySeed("[]", NOW), undefined);
  const empty = parseAvailabilitySeed(JSON.stringify({ version: 1, updatedAt: NOW }), NOW);
  assert.deepEqual(empty, { updatedAt: NOW, seededStatuses: [], routeOrders: {} });
});

test("readAvailabilitySeed and loadAvailabilitySeed read <workspace>/availability.json; absent means no seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-avail-"));
  try {
    assert.equal(readAvailabilitySeed(dir, NOW), undefined);
    assert.equal(await loadAvailabilitySeed(dir, NOW), undefined);
    writeFileSync(join(dir, AVAILABILITY_FILE), report());
    const seed = readAvailabilitySeed(dir, NOW);
    assert.ok(seed);
    assert.equal(seed.seededStatuses.length, 5);
    const loaded = await loadAvailabilitySeed(dir, NOW);
    assert.deepEqual(loaded, seed);
    assert.equal(readAvailabilitySeed(dir, NOW + AVAILABILITY_MAX_AGE_MS), undefined, "stale at a later start");
    writeFileSync(join(dir, AVAILABILITY_FILE), "{");
    assert.equal(readAvailabilitySeed(dir, NOW), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit server seed never falls back to a foreign shared file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-avail-scoped-"));
  const explicit = join(dir, "server-availability.json");
  try {
    writeFileSync(join(dir, AVAILABILITY_FILE), report({
      purposes: [{ purpose: "web", effective: ["foreign-provider"] }],
    }));
    assert.deepEqual(readAvailabilitySeed(dir, NOW)?.routeOrders.web, ["foreign-provider"]);
    assert.equal(readAvailabilitySeed(dir, NOW, undefined, explicit), undefined, "missing own seed probes for itself");
    assert.equal(await loadAvailabilitySeed(dir, NOW, undefined, explicit), undefined);
    writeFileSync(explicit, report());
    const own = readAvailabilitySeed(dir, NOW, undefined, explicit);
    assert.deepEqual(own?.routeOrders.web, ["searxng"]);
    assert.deepEqual(await loadAvailabilitySeed(dir, NOW, undefined, explicit), own);
    for (const contents of ["{", report({ updatedAt: NOW - AVAILABILITY_MAX_AGE_MS - 1 })]) {
      writeFileSync(explicit, contents);
      assert.equal(readAvailabilitySeed(dir, NOW, undefined, explicit), undefined);
      assert.equal(await loadAvailabilitySeed(dir, NOW, undefined, explicit), undefined);
    }
    // An explicitly empty path is invalid, not a request to use shared state.
    assert.equal(readAvailabilitySeed(dir, NOW, undefined, ""), undefined);
    assert.equal(await loadAvailabilitySeed(dir, NOW, undefined, ""), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the event writer appends {at, runId, status} lines in order, and only announces a failure once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-avail-"));
  try {
    let tick = 0;
    const write = availabilityEventWriter(dir, "run-1", { now: () => NOW + tick++ });
    assert.equal(write.path, join(dir, AVAILABILITY_EVENTS_FILE));
    const statuses: WebSourceStatus[] = [
      { id: "openalex", state: "degraded", detail: "rate limit reached (HTTP 429)", checkedAt: NOW, until: NOW + 600_000 },
      { id: "openalex", state: "available", detail: "recovered", checkedAt: NOW + 1 },
    ];
    for (const status of statuses) write(status);
    await write.flush();
    const lines = readFileSync(write.path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines, [
      { at: NOW, runId: "run-1", status: statuses[0] },
      { at: NOW + 1, runId: "run-1", status: statuses[1] },
    ]);
    // Append-only: a second writer (a resume) adds to the same file.
    const again = availabilityEventWriter(dir, "run-1", { now: () => NOW + 10 });
    again({ id: "arxiv", state: "available", checkedAt: NOW + 10 });
    await again.flush();
    assert.equal(readFileSync(write.path, "utf8").trimEnd().split("\n").length, 3);

    const warnings: string[] = [];
    const broken = availabilityEventWriter(join(dir, "missing", "deeper"), "run-2", { log: (line) => warnings.push(line) });
    broken({ id: "a", state: "available" });
    broken({ id: "b", state: "available" });
    await broken.flush();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /\[availability\] could not append/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
