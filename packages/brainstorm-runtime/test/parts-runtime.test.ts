import assert from "node:assert/strict";
import test from "node:test";

import { Scope, type JsonObject, type JsonValue } from "@brainstorm-agentic/core";

import { applyRedevelopment, payloadSectionChunks } from "../src/index.js";

// ---------------------------------------------------------------------------
// the cache split over a four-part chain
// ---------------------------------------------------------------------------

/** One chain step as a parts run writes it: four plain strings, nothing else. */
function step(index: number): JsonObject {
  return {
    part1: `Step ${index}: the claim this position makes.`,
    part2: `Step ${index}: the ground the claim stands on.`,
    part3: `Step ${index}: what follows once the ground holds.`,
    part4: `Step ${index}: what the step leaves open.`,
  };
}

const chain: readonly JsonObject[] = [1, 2, 3, 4, 5].map(step);

function split(value: JsonValue): string[] {
  return payloadSectionChunks({ name: "chain", value }, true);
}

/** The one block the same section renders to when it is not splittable. */
function whole(value: JsonValue): string {
  const chunks = payloadSectionChunks({ name: "chain", value }, false);
  assert.equal(chunks.length, 1, "an unsplittable section is one block");
  return chunks[0]!;
}

test("a chain of four-part steps splits, and its pieces are exactly the whole", () => {
  const chunks = split(chain);
  assert.equal(
    chunks.length,
    chain.length + 2,
    "one chunk per step, plus the header and the closing bracket",
  );
  // The split is a BILLING change and nothing else: whatever the model read
  // before a chain became four-part objects, it reads the identical bytes now.
  assert.equal(chunks.join(""), whole(chain));
  assert.equal(chunks.join(""), `\n\n## chain\n\n${JSON.stringify(chain, null, 2)}`);
});

test("one walk position's chunks are a byte-exact prefix of the next position's", () => {
  for (let k = 1; k < chain.length; k += 1) {
    const shorter = split(chain.slice(0, k));
    const longer = split(chain.slice(0, k + 1));
    // Every chunk except the closing bracket repeats, chunk for chunk. The
    // bracket is the one byte that moves when the walk advances, which is
    // why the boundary is declared on the last STEP and never on it.
    assert.deepEqual(
      shorter.slice(0, -1),
      longer.slice(0, shorter.length - 1),
      `step ${k}'s element chunks repeat at step ${k + 1}`,
    );
    assert.ok(
      longer.join("").startsWith(shorter.slice(0, -1).join("")),
      `step ${k}'s cacheable prefix is re-read byte for byte at step ${k + 1}`,
    );
  }
});

test("a rewritten step breaks the prefix from that step onward, and no earlier", () => {
  const revised = [...chain];
  revised[2] = { ...step(3), part2: "Step 3: the ground the repair now stands on." };
  const before = split(chain);
  const after = split(revised);
  assert.deepEqual(before.slice(0, 3), after.slice(0, 3), "steps 1 and 2 are untouched bytes");
  assert.notEqual(before[3], after[3], "the rewritten step is the first chunk to move");
});

test("a chain of strings still splits into the identical bytes it always did", () => {
  const strings = ["step one", "step two", "step three"];
  assert.deepEqual(split(strings), [
    "\n\n## chain\n\n[",
    '\n  "step one"',
    ',\n  "step two"',
    ',\n  "step three"',
    "\n]",
  ]);
  assert.equal(split(strings).join(""), whole(strings));
});

test("a list of two kinds is left whole", () => {
  // Elements of mixed kinds mean the section is not a chain, and guessing at
  // its boundaries would risk the prefix property for nothing.
  const mixed: JsonValue = ["step one", step(2)];
  assert.deepEqual(split(mixed), [whole(mixed)]);
});

// ---------------------------------------------------------------------------
// applyRedevelopment, four-part patch delivery
// ---------------------------------------------------------------------------

/** A member mid-review: a three-step four-part chain and a developed paper. */
function partsIdeaState(): JsonObject {
  return {
    params: { maxReviewRounds: 4 },
    input: { cotSteps: 3, type: "research idea" },
    ideas: {
      "member-1": {
        output: {
          type: "research idea",
          paper: {
            abstract: ["a1", "a2", "a3"],
            introduction: ["i1", "i2", "i3"],
            method: ["m1", "m2", "m3"],
            discussion: ["d1", "d2", "d3"],
            conclusion: ["c1"],
          },
        },
        cot: [step(1), step(2), step(3)],
        novelty: "the original novelty claim",
        literature: [{ title: "A prior work", authors: ["Author"], relation: "closest" }],
      },
    },
    reviews: { "member-1": { current: { comments: {} } } },
    reviewLog: {},
  };
}

function walkScope(stepIndex: number): Scope {
  const scope = Scope.root();
  scope.set("member", { id: "member-1" });
  scope.set("stepIndex", stepIndex);
  return scope;
}

function ideaOf(state: JsonObject): JsonObject {
  return (state.ideas as JsonObject)["member-1"] as JsonObject;
}

function changeSet(state: JsonObject): JsonObject {
  return ((state.reviews as JsonObject)["member-1"] as JsonObject).current as JsonObject;
}

test("a four-part patch replaces the named step whole and carries the rest verbatim", () => {
  const repaired = {
    part1: "Step 2: the repaired claim.",
    part2: "Step 2: the control the earlier round required.",
    part3: "Step 2: what now follows.",
    part4: "Step 2: what it still leaves open.",
  };
  const patched = applyRedevelopment(
    partsIdeaState(),
    walkScope(2),
    {
      steps: [{ index: 2, ...repaired }],
      outputPatch: { paper: { method: ["m1 revised", "m2 revised", "m3 revised"] } },
    },
    "redevelop-idea",
    "patchParts",
  );
  const idea = ideaOf(patched);

  // A rewrite may move the boundaries between the parts, so the patch names
  // a step and replaces all four of its parts — never one part in place.
  assert.deepEqual(idea.cot, [step(1), repaired, step(3)]);
  const paper = (idea.output as JsonObject).paper as JsonObject;
  assert.deepEqual(paper.method, ["m1 revised", "m2 revised", "m3 revised"]);
  assert.deepEqual(paper.abstract, ["a1", "a2", "a3"], "unpatched sections stand");
  assert.equal(idea.novelty, "the original novelty claim", "novelty stands until moved");
  assert.ok(idea.literature, "the grounding record rides through, as it always did");

  const current = changeSet(patched);
  assert.deepEqual(current.touched, [2]);
  assert.deepEqual(current.untouched, [1, 3]);
});

test("a patch that re-submits all four parts unchanged counts as untouched", () => {
  const patched = applyRedevelopment(
    partsIdeaState(),
    walkScope(2),
    { steps: [{ index: 2, ...step(2) }] },
    "redevelop-idea",
    "patchParts",
  );
  const current = changeSet(patched);
  // The patch hands back a FRESH object for every step it names, so identity
  // alone would file this as a rewrite that changed nothing.
  assert.deepEqual(current.touched, [], "parts that did not change did not change");
  assert.deepEqual(current.untouched, [1, 2, 3]);
});

test("one changed part makes the whole step touched: the ledger stays at step granularity", () => {
  const patched = applyRedevelopment(
    partsIdeaState(),
    walkScope(3),
    { steps: [{ index: 3, ...step(3), part4: "Step 3: the opening the repair closes." }] },
    "redevelop-idea",
    "patchParts",
  );
  const current = changeSet(patched);
  assert.deepEqual(current.touched, [3]);
  assert.deepEqual(current.untouched, [1, 2]);
});

test("a four-part patch naming a step the chain does not have fails the task", () => {
  assert.throws(
    () =>
      applyRedevelopment(
        partsIdeaState(),
        walkScope(3),
        { steps: [{ index: 4, ...step(4) }] },
        "redevelop-idea",
        "patchParts",
      ),
    (error: unknown) =>
      (error as { code?: string }).code === "INVALID_REDEVELOPMENT" &&
      /step 4, but the chain has 3 steps/.test((error as Error).message),
  );
});
