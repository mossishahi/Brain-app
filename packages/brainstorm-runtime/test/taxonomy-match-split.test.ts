/**
 * Compound pool terms shaped "<A> for <B>" glue two distinct concepts into
 * one atomic string (one person's stated research interest, e.g. "Manifold
 * Learning for Network Analysis"). Left whole, the term either auto-matches
 * or gets placed as ONE unit, landing on only one of the two concepts and
 * silently losing the other. Regression grounded in a real production run
 * (bsa_20260818-010453_db4f75): "Manifold Learning" vanished because only
 * "Network Analysis" ever reached a taxonomy landing.
 *
 * The fix deterministically splits such terms into their two halves before
 * matching, each carrying the exact same count/relevance/origins as the
 * original — real evidence for BOTH concepts, not diluted between them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  JsonValue,
  TaxonomyAccess,
  TaxonomyResolveResult,
  TaxonomySuggestionReceipt,
  TaxonomyTreeExport,
} from "@brainstorm-agentic/core";

import { taxonomyActivities } from "../src/taxonomy-activities.js";

/** A resolve() stub answering from a fixed map, with every query recorded. */
class FakeTaxonomy implements TaxonomyAccess {
  readonly calls: string[] = [];

  constructor(private readonly answers: ReadonlyMap<string, TaxonomyResolveResult>) {}

  async resolve(query: string): Promise<TaxonomyResolveResult> {
    this.calls.push(query);
    const answer = this.answers.get(query);
    if (answer) return answer;
    return { query, found: false, status: "NA", revision: 1, beta: [], options: [], total: 0 };
  }

  async tree(): Promise<TaxonomyTreeExport> {
    return { revision: 1, nodeCount: 0, outline: "" };
  }

  async suggest(): Promise<TaxonomySuggestionReceipt> {
    return { id: "r", receivedAt: new Date(0).toISOString(), revision: 1, queued: 0 };
  }
}

function notFound(query: string, revision = 1): TaxonomyResolveResult {
  return { query, found: false, status: "NA", revision, beta: [], options: [], total: 0 };
}

const CONTEXT = { runId: "test-run", nodePath: "root/match", signal: new AbortController().signal };

test("a compound '<A> for <B>' pool term splits into two independently-landed halves, each keeping the original count/relevance/origins", async () => {
  const origins: JsonValue[] = [
    {
      name: "Ronen Talmon",
      paper:
        "Parsimonious representation of nonlinear dynamical systems through manifold learning: A chemotaxis case study",
      stated: "Manifold Learning for Network Analysis",
    },
  ];
  const networkAnalysisFound: TaxonomyResolveResult = {
    query: "Network Analysis",
    found: true,
    revision: 5,
    position: {
      id: "C:network-analysis",
      name: "Network Analysis",
      level: "topic",
      path: [
        "Physical Sciences",
        "Physics and Astronomy",
        "Statistical and Nonlinear Physics",
        "Network Analysis",
      ],
      domain: "Physical Sciences",
      field: "Physics and Astronomy",
      subfield: "Statistical and Nonlinear Physics",
      topic: "Network Analysis",
      matchedOn: "name",
    },
  };
  const answers = new Map<string, TaxonomyResolveResult>([
    ["Manifold Learning for Network Analysis", notFound("Manifold Learning for Network Analysis", 5)],
    ["Manifold Learning", notFound("Manifold Learning", 5)],
    ["Network Analysis", networkAnalysisFound],
  ]);
  const taxonomy = new FakeTaxonomy(answers);
  const match = taxonomyActivities(taxonomy)["taxonomy.match"]!;

  const member = {
    term: "Manifold Learning for Network Analysis",
    count: 1,
    relevance: 0.55,
    variants: ["Manifold Learning for Network Analysis"],
    origins,
  };

  const result = (await match(
    { pool: { members: [member] }, classification: {}, maxMembers: 200 },
    CONTEXT,
  )) as unknown as {
    members: readonly Record<string, JsonValue>[];
    unmatched: readonly Record<string, JsonValue>[];
  };

  // The original compound member becomes exactly 2 landings, never 3 — the
  // whole compound string itself must not also appear.
  assert.equal(result.members.length, 2);

  const manifold = result.members.find((m) => m.term === "Manifold Learning");
  const network = result.members.find((m) => m.term === "Network Analysis");
  assert.ok(manifold, "the 'Manifold Learning' half is present");
  assert.ok(network, "the 'Network Analysis' half is present");

  assert.equal(manifold!.matched, false);
  assert.equal(manifold!.count, 1);
  assert.equal(manifold!.relevance, 0.55);
  assert.equal(manifold!.splitFrom, "Manifold Learning for Network Analysis");
  assert.deepEqual(manifold!.origins, origins);
  assert.deepEqual(manifold!.variants, ["Manifold Learning"]);

  assert.equal(network!.matched, true);
  assert.equal((network!.position as { name: string }).name, "Network Analysis");
  assert.equal(network!.count, 1);
  assert.equal(network!.relevance, 0.55);
  assert.equal(network!.splitFrom, "Manifold Learning for Network Analysis");

  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0]!.term, "Manifold Learning");
});

test("a whole term that already resolves wins outright — no split attempted even though it contains ' for '", async () => {
  const found: TaxonomyResolveResult = {
    query: "Wireless Sensor Networks for Data Analysis",
    found: true,
    revision: 3,
    position: {
      id: "C:wsn-data-analysis",
      name: "Wireless Sensor Networks for Data Analysis",
      level: "topic",
      path: ["Physical Sciences", "Computer Science", "Networks", "Wireless Sensor Networks for Data Analysis"],
      matchedOn: "name",
    },
  };
  const taxonomy = new FakeTaxonomy(
    new Map([["Wireless Sensor Networks for Data Analysis", found]]),
  );
  const match = taxonomyActivities(taxonomy)["taxonomy.match"]!;

  const member = {
    term: "Wireless Sensor Networks for Data Analysis",
    count: 2,
    relevance: 0.8,
    variants: ["Wireless Sensor Networks for Data Analysis"],
    origins: [{ name: "Someone", paper: "Some Paper", stated: "Wireless Sensor Networks for Data Analysis" }],
  };

  const result = (await match(
    { pool: { members: [member] }, classification: {}, maxMembers: 200 },
    CONTEXT,
  )) as unknown as { members: readonly Record<string, JsonValue>[] };

  assert.equal(result.members.length, 1);
  assert.equal(result.members[0]!.matched, true);
  assert.equal("splitFrom" in result.members[0]!, false, "an outright whole-term match carries no splitFrom field");
});

test("organization names containing ' for ' are never split — the halves are never even queried", async () => {
  const taxonomy = new FakeTaxonomy(new Map());
  const match = taxonomyActivities(taxonomy)["taxonomy.match"]!;

  const member = {
    term: "Center for Computational Biology",
    count: 1,
    relevance: 0.4,
    variants: ["Center for Computational Biology"],
    origins: [{ name: "Someone", paper: "Some Paper", stated: "Center for Computational Biology" }],
  };

  const result = (await match(
    { pool: { members: [member] }, classification: {}, maxMembers: 200 },
    CONTEXT,
  )) as unknown as { members: readonly Record<string, JsonValue>[] };

  assert.equal(result.members.length, 1);
  assert.equal(result.members[0]!.term, "Center for Computational Biology");
  assert.equal("splitFrom" in result.members[0]!, false);
  assert.equal(taxonomy.calls.length, 1, "resolve is called exactly once — the halves are never queried");
  assert.deepEqual(taxonomy.calls, ["Center for Computational Biology"]);
});

test("the maxMembers bound blocks a split when there is no room for 2 more entries", async () => {
  const filler1Found: TaxonomyResolveResult = {
    query: "Field 1",
    found: true,
    revision: 1,
    position: {
      id: "C:field-1",
      name: "Field 1",
      level: "topic",
      path: ["Domain", "Field", "Subfield", "Field 1"],
      matchedOn: "name",
    },
  };
  const filler2Found: TaxonomyResolveResult = {
    query: "Field 2",
    found: true,
    revision: 1,
    position: {
      id: "C:field-2",
      name: "Field 2",
      level: "topic",
      path: ["Domain", "Field", "Subfield", "Field 2"],
      matchedOn: "name",
    },
  };
  const taxonomy = new FakeTaxonomy(
    new Map([
      ["Field 1", filler1Found],
      ["Field 2", filler2Found],
      ["Deep Learning for Genomics", notFound("Deep Learning for Genomics")],
    ]),
  );
  const match = taxonomyActivities(taxonomy)["taxonomy.match"]!;

  const members = [
    { term: "Field 1", count: 1, relevance: 0.5, variants: ["Field 1"], origins: [] },
    { term: "Field 2", count: 1, relevance: 0.5, variants: ["Field 2"], origins: [] },
    {
      term: "Deep Learning for Genomics",
      count: 1,
      relevance: 0.5,
      variants: ["Deep Learning for Genomics"],
      origins: [{ name: "Someone", paper: "Some Paper", stated: "Deep Learning for Genomics" }],
    },
  ];

  // maxMembers is tight enough (3 members in, room for only 1 more slot on
  // the compound term) that splitting it into 2 halves would exceed the
  // declared bound — the guard must fall back to the whole-term behavior.
  const result = (await match(
    { pool: { members }, classification: {}, maxMembers: 3 },
    CONTEXT,
  )) as unknown as { members: readonly Record<string, JsonValue>[] };

  assert.ok(result.members.length <= 3, `members.length (${result.members.length}) must not exceed maxMembers`);
  const compound = result.members.find((m) => m.term === "Deep Learning for Genomics");
  assert.ok(compound, "the compound term is carried through unsplit");
  assert.equal(compound!.matched, false);
  assert.equal("splitFrom" in compound!, false, "the guard blocked the split — no splitFrom field");
  assert.ok(
    !taxonomy.calls.includes("Deep Learning") && !taxonomy.calls.includes("Genomics"),
    "the halves are never queried when the capacity guard blocks the split",
  );
});

test("the maxMembers bound holds across the WHOLE pass, not just the split it was checked against — two splits never jointly overshoot", async () => {
  // Regression for a real overshoot: a per-split check against a snapshot of
  // `annotated.length` only proves THAT split leaves room; it says nothing
  // about a second split, or an ordinary member, still ahead in the loop.
  // maxMembers=4, 2 compound terms + 1 filler (3 pool members in) — only 1
  // net extra entry is ever affordable (4 - 3 = 1), so exactly one of the two
  // splits must be allowed and the other must fall back to the whole term.
  const taxonomy = new FakeTaxonomy(
    new Map([
      ["AAA for BBB", notFound("AAA for BBB")],
      ["CCC for DDD", notFound("CCC for DDD")],
      [
        "Filler",
        {
          query: "Filler",
          found: true,
          revision: 1,
          position: {
            id: "C:filler",
            name: "Filler",
            level: "topic",
            path: ["Domain", "Field", "Subfield", "Filler"],
            matchedOn: "name",
          },
        },
      ],
    ]),
  );
  const match = taxonomyActivities(taxonomy)["taxonomy.match"]!;

  const members = [
    { term: "AAA for BBB", count: 1, relevance: 0.5, variants: ["AAA for BBB"], origins: [] },
    { term: "CCC for DDD", count: 1, relevance: 0.5, variants: ["CCC for DDD"], origins: [] },
    { term: "Filler", count: 1, relevance: 0.5, variants: ["Filler"], origins: [] },
  ];

  const result = (await match(
    { pool: { members }, classification: {}, maxMembers: 4 },
    CONTEXT,
  )) as unknown as { members: readonly Record<string, JsonValue>[] };

  assert.ok(
    result.members.length <= 4,
    `members.length (${result.members.length}) must not exceed maxMembers=4`,
  );
  // Exactly one of the two compounds got to split; the other was carried
  // through whole because the budget was already spent.
  const splitHalves = result.members.filter((m) => "splitFrom" in m).length;
  assert.equal(splitHalves, 2, "exactly one compound term split, producing its 2 halves");
  const wholeCompounds = result.members.filter(
    (m) => m.term === "AAA for BBB" || m.term === "CCC for DDD",
  );
  assert.equal(wholeCompounds.length, 1, "the other compound was carried through unsplit");
});

test("the maxMembers bound holds when the pool is already at its natural cap, regardless of where the compound term sits", async () => {
  // Same shape as the production overshoot: pool.length === maxMembers (the
  // normal way this bound ever binds at all), and the compound term is
  // placed FIRST rather than last — the one ordering a local, per-split
  // check would get wrong.
  const taxonomy = new FakeTaxonomy(
    new Map([
      ["Manifold Learning for Network Analysis", notFound("Manifold Learning for Network Analysis")],
      [
        "Filler 1",
        {
          query: "Filler 1",
          found: true,
          revision: 1,
          position: {
            id: "C:filler-1",
            name: "Filler 1",
            level: "topic",
            path: ["Domain", "Field", "Subfield", "Filler 1"],
            matchedOn: "name",
          },
        },
      ],
      [
        "Filler 2",
        {
          query: "Filler 2",
          found: true,
          revision: 1,
          position: {
            id: "C:filler-2",
            name: "Filler 2",
            level: "topic",
            path: ["Domain", "Field", "Subfield", "Filler 2"],
            matchedOn: "name",
          },
        },
      ],
    ]),
  );
  const match = taxonomyActivities(taxonomy)["taxonomy.match"]!;

  const members = [
    {
      term: "Manifold Learning for Network Analysis",
      count: 1,
      relevance: 0.5,
      variants: ["Manifold Learning for Network Analysis"],
      origins: [],
    },
    { term: "Filler 1", count: 1, relevance: 0.5, variants: ["Filler 1"], origins: [] },
    { term: "Filler 2", count: 1, relevance: 0.5, variants: ["Filler 2"], origins: [] },
  ];

  const result = (await match(
    { pool: { members }, classification: {}, maxMembers: 3 },
    CONTEXT,
  )) as unknown as { members: readonly Record<string, JsonValue>[] };

  assert.ok(
    result.members.length <= 3,
    `members.length (${result.members.length}) must not exceed maxMembers=3`,
  );
  const compound = result.members.find((m) => m.term === "Manifold Learning for Network Analysis");
  assert.ok(compound, "the compound term is carried through unsplit — no room for its 2 halves");
  assert.equal("splitFrom" in compound!, false);
  assert.ok(
    !taxonomy.calls.includes("Manifold Learning") && !taxonomy.calls.includes("Network Analysis"),
    "the halves are never queried when the pool is already at its natural cap",
  );
});
