import assert from "node:assert/strict";
import test from "node:test";

import type {
  JsonValue,
  TaxonomyAccess,
  TaxonomyNodePosition,
  TaxonomyResolveResult,
} from "@brainstorm-agentic/core";

import { buildPlacerOutline } from "../src/taxonomy-activities.js";

/**
 * A fixed tree in the registry's outline format (two spaces per level):
 * three domains, four fields, mixed subfield/topic coverage — including a
 * topicless subfield and a subfieldless field, so the count markers and the
 * bare-name cases are all exercised.
 */
const TREE_OUTLINE = [
  "Natural Sciences",
  "  Physics",
  "    Quantum Optics",
  "      photon counting",
  "      squeezed light",
  "    Condensed Matter",
  "      transport",
  "  Chemistry",
  "    Electrochemistry",
  "      batteries",
  "Engineering",
  "  Computer Science",
  "    Artificial Intelligence",
  "      machine learning",
  "      normalizing flows",
  "    Computer Networks",
  "Life Sciences",
  "  Biology",
].join("\n");

/** Exact positions the options-fallback resolver may answer. */
const RESOLVABLE: Readonly<Record<string, readonly string[]>> = {
  "quantum optics": ["Natural Sciences", "Physics", "Quantum Optics"],
};

class OutlineStubTaxonomy implements TaxonomyAccess {
  treeCalls = 0;
  resolveCalls: string[] = [];

  constructor(private readonly failTree = false) {}

  async resolve(query: string): Promise<TaxonomyResolveResult> {
    this.resolveCalls.push(query);
    const path = RESOLVABLE[query.trim().toLowerCase()];
    if (!path) {
      return { query, found: false, status: "NA", revision: 9, beta: [], options: [], total: 0 };
    }
    const levels = ["domain", "field", "subfield", "topic"] as const;
    const position: TaxonomyNodePosition = {
      id: `S:${path[path.length - 1]!}`,
      name: path[path.length - 1]!,
      level: levels[path.length - 1]!,
      path,
      domain: path[0]!,
      ...(path[1] ? { field: path[1] } : {}),
      ...(path[2] ? { subfield: path[2] } : {}),
      matchedOn: "name",
    };
    return { query, found: true, revision: 9, position };
  }

  async tree(): Promise<{ revision: number; nodeCount: number; outline: string }> {
    this.treeCalls += 1;
    if (this.failTree) throw new Error("registry unreachable");
    return { revision: 9, nodeCount: 18, outline: TREE_OUTLINE };
  }

  async suggest(): Promise<{ id: string; receivedAt: string; revision: number; queued: number }> {
    return { id: "r", receivedAt: new Date(0).toISOString(), revision: 9, queued: 0 };
  }
}

function member(overrides: Record<string, JsonValue>): JsonValue {
  return {
    term: "spiking neural networks",
    count: 1,
    variants: [],
    origins: [],
    matched: false,
    options: [],
    ...overrides,
  };
}

test("candidate anchors expand exactly the touched branches; every cut carries its count", async () => {
  const taxonomy = new OutlineStubTaxonomy();
  const outline = await buildPlacerOutline(taxonomy, [
    member({
      candidates: [
        {
          name: "machine learning",
          level: "topic",
          path: ["Engineering", "Computer Science", "Artificial Intelligence", "machine learning"],
          score: 0.74,
        },
      ],
    }),
  ]);
  const lines = outline.split("\n");

  assert.match(lines[0]!, /revision 9, 18 nodes/, "the header names the pinned revision");
  // The skeleton always carries every domain and field.
  for (const name of ["Natural Sciences", "Engineering", "Life Sciences"]) {
    assert.ok(lines.includes(name), `domain "${name}" is in the skeleton`);
  }
  // The anchored field lists its subfields; the anchored subfield lists its topics.
  assert.ok(lines.includes("  Computer Science"));
  assert.ok(lines.includes("    Artificial Intelligence"));
  assert.ok(lines.includes("      machine learning"));
  assert.ok(lines.includes("      normalizing flows"));
  // The sibling subfield inside the anchored field shows its bare name (no topics).
  assert.ok(lines.includes("    Computer Networks"));
  // Untouched fields are cut with an explicit count — singular and plural.
  assert.ok(lines.includes("  Physics (2 subfields — not shown)"));
  assert.ok(lines.includes("  Chemistry (1 subfield — not shown)"));
  // A field with no subfields stays a bare name, never a "0 subfields" cut.
  assert.ok(lines.includes("  Biology"));
  // Nothing outside the anchored branch leaks topics.
  assert.ok(!outline.includes("photon counting"));
  assert.ok(!outline.includes("batteries"));
});

test("with no candidates, resolvable options anchor the outline instead", async () => {
  const taxonomy = new OutlineStubTaxonomy();
  const outline = await buildPlacerOutline(taxonomy, [
    member({ options: ["Quantum Optics", "definitely not a node"] }),
  ]);
  const lines = outline.split("\n");

  assert.deepEqual(
    taxonomy.resolveCalls,
    ["Quantum Optics", "definitely not a node"],
    "each option costs at most one deterministic resolve round-trip",
  );
  assert.ok(lines.includes("  Physics"), "the resolved option's field is expanded");
  assert.ok(lines.includes("    Quantum Optics"));
  assert.ok(lines.includes("      photon counting"));
  // The sibling subfield is cut with its topic count.
  assert.ok(lines.includes("    Condensed Matter (1 topic — not shown)"));
  assert.ok(lines.includes("  Computer Science (2 subfields — not shown)"));
});

test("with no anchors at all, the outline is the skeleton with counts", async () => {
  const taxonomy = new OutlineStubTaxonomy();
  const outline = await buildPlacerOutline(taxonomy, [member({})]);
  const lines = outline.split("\n");

  assert.ok(lines.includes("  Physics (2 subfields — not shown)"));
  assert.ok(lines.includes("  Computer Science (2 subfields — not shown)"));
  assert.ok(!outline.includes("      "), "no topics are expanded anywhere");
});

test("an outline too large to record degrades instead of failing the run", async () => {
  // A broad submission can anchor in many topic-heavy subfields at once. The
  // artifact schema caps this field, so rendering past the cap used to fail
  // the deterministic activity — and because that activity's output is
  // journaled, every resume replayed straight back into the same failure.
  const topics = Array.from({ length: 4000 }, (_, i) => `      topic ${i} ${"x".repeat(40)}`);
  const huge = [
    "Natural Sciences",
    "  Physics",
    "    Quantum Optics",
    ...topics,
    "    Condensed Matter",
    "      transport",
  ].join("\n");

  class HugeTree extends OutlineStubTaxonomy {
    override async tree(): Promise<{ revision: number; nodeCount: number; outline: string }> {
      return { revision: 9, nodeCount: 4003, outline: huge };
    }
  }
  const taxonomy = new HugeTree();
  const outline = await buildPlacerOutline(taxonomy, [
    member({ candidates: [{ name: "Quantum Optics", path: ["Natural Sciences", "Physics", "Quantum Optics"], score: 0.9 }] }),
  ]);

  assert.ok(
    outline.length <= 120_000,
    `the rendered outline stays inside the artifact schema's cap (was ${outline.length})`,
  );
  // Degrading is not going blank: the placer still gets the skeleton, and
  // every cut still names itself so the branch remains fetchable.
  assert.ok(outline.includes("Physics"), "the skeleton survives the degrade");
  assert.ok(
    outline.includes("not shown"),
    "the cut branches are still announced as fetchable",
  );
});

test("a failing tree read falls open to a fetch-it-yourself note, never an error", async () => {
  const taxonomy = new OutlineStubTaxonomy(true);
  const outline = await buildPlacerOutline(taxonomy, [member({})]);
  assert.match(outline, /outline unavailable/);
  assert.match(outline, /taxonomy-access/);
});
