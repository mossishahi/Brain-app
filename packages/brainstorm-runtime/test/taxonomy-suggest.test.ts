/**
 * The suggestion queue submission: every decision kind the taxonomy.suggest
 * activity can emit must satisfy the suggestionReceipt artifact schema — the
 * exact validation the runtime applies on write. Regression for the failed
 * production run where placer-declared undecidable members became "insert"
 * suggestions and the receipt schema did not know the kind.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { artifactSchemas } from "@brainstorm-agentic/content";
import type {
  JsonValue,
  TaxonomyAccess,
  TaxonomySuggestionEntry,
} from "@brainstorm-agentic/core";

import { taxonomyActivities } from "../src/taxonomy-activities.js";

class RecordingTaxonomy implements TaxonomyAccess {
  submitted: TaxonomySuggestionEntry[] = [];

  async resolve(query: string): Promise<never> {
    throw new Error(`unexpected resolve("${query}") — suggest never resolves`);
  }

  async tree(): Promise<never> {
    throw new Error("unexpected tree() — suggest never reads the tree");
  }

  async suggest(entries: readonly TaxonomySuggestionEntry[]) {
    this.submitted = [...entries];
    return {
      id: "receipt-1",
      receivedAt: "2026-08-04T00:00:00.000Z",
      revision: 7,
      queued: entries.length,
    };
  }
}

const candidates = [
  {
    name: "Geometry and complex manifolds",
    level: "topic",
    path: ["Physical Sciences", "Mathematics", "Geometry and Topology", "Geometry and complex manifolds"],
    score: 0.61,
  },
];

function member(term: string, extra: Record<string, JsonValue>): JsonValue {
  return {
    term,
    count: 1,
    relevance: 0.9,
    variants: [term],
    origins: [{ name: "Test Author", paper: "Test Paper", stated: term }],
    options: [],
    ...extra,
  } as unknown as JsonValue;
}

test("every suggest kind — including insert from undecidable and undecided members — passes the receipt schema", async () => {
  const taxonomy = new RecordingTaxonomy();
  const suggest = taxonomyActivities(taxonomy)["taxonomy.suggest"]!;

  const matches = {
    revision: 7,
    members: [
      member("machine learning", {
        matched: true,
        position: {
          id: "T1",
          name: "Machine Learning",
          level: "topic",
          path: ["Physical Sciences", "Computer Science", "Artificial Intelligence", "Machine Learning"],
        },
        matchScore: 0.998,
      }),
      // Placer placed it: kind "place", nearest evidence attached.
      member("chip morphology", { matched: false, candidates }),
      // Placer resolved it to an existing node: kind "already_present".
      member("statistical ML", { matched: false, candidates }),
      // Placer declared it undecidable WITH candidates: the place-anchored
      // INSERT suggestion — the kind the production run failed on.
      member("manifold learning", { matched: false, candidates }),
      // Undecidable WITHOUT candidates: plain undecided with the reason.
      member("mystery field", { matched: false }),
      // No decision at all but candidates exist: also an insert.
      member("orphan term", { matched: false, candidates }),
    ],
    unmatched: [],
  } as unknown as JsonValue;

  const placements = {
    revision: 7,
    decisions: [
      {
        term: "chip morphology",
        outcome: "place",
        name: "Chip Morphology",
        parent: "Condensed Matter",
        aliases: [],
        reason: "A fabrication-morphology area housed with condensed matter research.",
      },
      {
        term: "statistical ML",
        outcome: "already_present",
        node: "Statistical Machine Learning",
        reason: "Resolves to an existing topic under another spelling.",
      },
      {
        term: "manifold learning",
        outcome: "undecidable",
        reason: "The material does not disambiguate the geometric from the applied sense.",
      },
      {
        term: "mystery field",
        outcome: "undecidable",
        reason: "No usable signal about where this field is researched.",
      },
    ],
  } as unknown as JsonValue;

  const receipt = await suggest(
    { matches, placements, maxMembers: 200 },
    { runId: "test-run", nodePath: "root/submit-decisions", signal: new AbortController().signal },
  );

  // The write-time validation that failed in production.
  const parsed = artifactSchemas.suggestionReceipt.parse(receipt);
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.term, entry.kind]),
    [
      ["machine learning", "matched"],
      ["chip morphology", "place"],
      ["statistical ML", "already_present"],
      ["manifold learning", "insert"],
      ["mystery field", "undecided"],
      ["orphan term", "insert"],
    ],
  );

  // The queue receives the evidence: inserts carry their nearest nodes and
  // the reason (the placer's own for undecidable, the standard one otherwise).
  const byTerm = new Map(taxonomy.submitted.map((entry) => [entry.term, entry]));
  const undecidableInsert = byTerm.get("manifold learning")!;
  assert.equal(undecidableInsert.kind, "insert");
  const undecidableDetail = undecidableInsert.detail as {
    name?: string;
    reason?: string;
    nearest?: readonly { name: string; score: number }[];
  };
  assert.equal(undecidableDetail.name, "manifold learning");
  assert.match(undecidableDetail.reason ?? "", /disambiguate/);
  assert.equal(undecidableDetail.nearest?.[0]?.name, "Geometry and complex manifolds");
  const orphanInsert = byTerm.get("orphan term")!;
  assert.equal(orphanInsert.kind, "insert");
  const placeDetail = byTerm.get("chip morphology")!.detail as {
    nearest?: readonly unknown[];
  };
  assert.equal(placeDetail.nearest?.length, 1);
});

test("duplicate term text across matches.members — a split half colliding with an unrelated standalone member of the same name — keeps each member's own decision, never last-write-wins", async () => {
  // Regression: a compound "<A> for <B>" pool term splits into two halves,
  // each carrying the half's plain text as its `term`. Nothing stops that
  // text from colliding with an unrelated, perfectly legal standalone pool
  // member of the same name (the two RAW pool strings were different and
  // both passed the pool's own dedup check). Decisions must stay attached
  // to the right occurrence by POSITION, not by re-keying on that now-
  // ambiguous term text.
  const taxonomy = new RecordingTaxonomy();
  const suggest = taxonomyActivities(taxonomy)["taxonomy.suggest"]!;

  const matches = {
    revision: 7,
    members: [
      // The standalone occurrence: 3 people's worth of real evidence.
      member("Manifold Learning", { matched: false, count: 3, candidates: [] }),
      // An unrelated split half of a different compound term, same text.
      member("Manifold Learning", { matched: false, count: 1, candidates: [] }),
      member("Network Analysis", {
        matched: true,
        count: 1,
        position: {
          id: "T2",
          name: "Network Analysis",
          level: "topic",
          path: [
            "Physical Sciences",
            "Physics and Astronomy",
            "Statistical and Nonlinear Physics",
            "Network Analysis",
          ],
        },
      }),
    ],
    unmatched: [],
  } as unknown as JsonValue;

  const placements = {
    revision: 7,
    // Positional against the two unmatched "Manifold Learning" occurrences,
    // in the order they appear above — NOT distinguishable by term text.
    decisions: [
      {
        term: "Manifold Learning",
        outcome: "place",
        name: "Manifold Learning",
        parent: "Field X",
        aliases: [],
        reason: "standalone interest, 3 people",
      },
      {
        term: "Manifold Learning",
        outcome: "place",
        name: "Manifold Learning",
        parent: "Field Y",
        aliases: [],
        reason: "half of a compound statement",
      },
    ],
  } as unknown as JsonValue;

  const receipt = await suggest(
    { matches, placements, maxMembers: 200 },
    { runId: "test-run", nodePath: "root/submit-decisions", signal: new AbortController().signal },
  );
  artifactSchemas.suggestionReceipt.parse(receipt);

  // Inspect what was actually queued, in encounter order — not by term
  // (which is exactly the ambiguity a term-keyed map would collapse).
  type PlaceDetail = { parent?: string; reason?: string };
  const standalone = taxonomy.submitted[0]!;
  const splitHalf = taxonomy.submitted[1]!;
  assert.equal(standalone.term, "Manifold Learning");
  assert.equal((standalone.detail as PlaceDetail).parent, "Field X");
  assert.match((standalone.detail as PlaceDetail).reason ?? "", /3 people/);
  assert.equal(splitHalf.term, "Manifold Learning");
  assert.equal((splitHalf.detail as PlaceDetail).parent, "Field Y");
  assert.match((splitHalf.detail as PlaceDetail).reason ?? "", /compound/);
});
