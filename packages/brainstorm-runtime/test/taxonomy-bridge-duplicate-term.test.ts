/**
 * Regression: a compound "<A> for <B>" pool term splits into two halves,
 * each carrying the half's plain text as its `matches.members[].term`.
 * Nothing prevents that text from colliding with an unrelated, perfectly
 * legal standalone pool member of the same name — the two RAW pool strings
 * were different and both passed the pool's own dedup check, so the
 * schema-level uniqueness guarantee that used to hold for `matches.members`
 * no longer does. `experts.bridge` (like `taxonomy.suggest`) must keep each
 * occurrence's own placement decision attached by POSITION, not by
 * re-keying a Map on that now-ambiguous term text — the previous approach
 * silently let the second decision overwrite the first's, seating one
 * member's evidence under the wrong node entirely.
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

class FakeTaxonomy implements TaxonomyAccess {
  constructor(private readonly answers: ReadonlyMap<string, TaxonomyResolveResult>) {}

  async resolve(query: string): Promise<TaxonomyResolveResult> {
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

interface DepartmentArtifact {
  readonly name: string;
  readonly count: number;
  readonly umbrellas: ReadonlyArray<{
    readonly name: string;
    readonly count: number;
    readonly subfields: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  }>;
}

test("duplicate term text across matches.members keeps each occurrence's own placement decision — never last-write-wins", async () => {
  const fieldX: TaxonomyResolveResult = {
    query: "Field X",
    found: true,
    revision: 1,
    position: {
      id: "FX",
      name: "Field X",
      level: "subfield",
      path: ["Domain A", "Field A", "Field X"],
      matchedOn: "name",
    },
  };
  const fieldY: TaxonomyResolveResult = {
    query: "Field Y",
    found: true,
    revision: 1,
    position: {
      id: "FY",
      name: "Field Y",
      level: "subfield",
      path: ["Domain B", "Field B", "Field Y"],
      matchedOn: "name",
    },
  };
  const taxonomy = new FakeTaxonomy(
    new Map([
      ["Field X", fieldX],
      ["Field Y", fieldY],
    ]),
  );
  const bridge = taxonomyActivities(taxonomy)["experts.bridge"]!;

  const matches = {
    revision: 1,
    members: [
      // The standalone occurrence: 3 people's worth of real evidence.
      {
        term: "Manifold Learning",
        count: 3,
        relevance: 0.9,
        variants: ["Manifold Learning"],
        origins: [],
        matched: false,
        options: [],
      },
      // An unrelated split half of a different compound term, same text.
      {
        term: "Manifold Learning",
        count: 1,
        relevance: 0.4,
        variants: ["Manifold Learning"],
        origins: [],
        matched: false,
        options: [],
        splitFrom: "Manifold Learning for Something Else",
      },
      // An ordinary matched member, unrelated to either decision.
      {
        term: "Network Analysis",
        count: 2,
        relevance: 0.7,
        variants: ["Network Analysis"],
        origins: [],
        matched: true,
        position: {
          id: "NA",
          name: "Network Analysis",
          level: "topic",
          path: ["Domain C", "Field C", "Subfield C", "Network Analysis"],
        },
        options: [],
      },
    ],
    unmatched: [],
  } as unknown as JsonValue;

  const placements = {
    revision: 1,
    // Positional against the two unmatched "Manifold Learning" occurrences,
    // in the order they appear above — NOT distinguishable by term text.
    decisions: [
      {
        term: "Manifold Learning",
        outcome: "place",
        name: "Manifold Learning",
        parent: "Field X",
        reason: "standalone interest, 3 people",
      },
      {
        term: "Manifold Learning",
        outcome: "place",
        name: "Manifold Learning",
        parent: "Field Y",
        reason: "half of a compound statement",
      },
    ],
  } as unknown as JsonValue;

  const result = (await bridge({ matches, placements, maxDepartments: 12 }, {
    runId: "test-run",
    nodePath: "root/bridge",
    signal: new AbortController().signal,
  })) as unknown as { departments: readonly DepartmentArtifact[] };

  const fieldA = result.departments.find((d) => d.name === "Field A");
  const fieldB = result.departments.find((d) => d.name === "Field B");
  const fieldC = result.departments.find((d) => d.name === "Field C");

  assert.ok(fieldA, "the standalone member's decision seated its own department (Field A)");
  assert.equal(fieldA!.count, 3, "Field A carries only the standalone member's count");
  const umbrellaX = fieldA!.umbrellas.find((u) => u.name === "Field X");
  assert.ok(umbrellaX, "Field A's umbrella is Field X, per the standalone member's own decision");
  assert.equal(umbrellaX!.count, 3);
  assert.equal(umbrellaX!.subfields.find((s) => s.name === "Manifold Learning")?.count, 3);

  assert.ok(fieldB, "the split half's decision seated its own, separate department (Field B)");
  assert.equal(fieldB!.count, 1, "Field B carries only the split half's count — not bled together with Field A's 3");
  const umbrellaY = fieldB!.umbrellas.find((u) => u.name === "Field Y");
  assert.ok(umbrellaY, "Field B's umbrella is Field Y, per the split half's own decision");
  assert.equal(umbrellaY!.count, 1);

  assert.ok(fieldC, "the ordinary matched member still seats normally");
  assert.equal(fieldC!.count, 2);
});
