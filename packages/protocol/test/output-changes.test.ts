import assert from "node:assert/strict";
import { test } from "node:test";

import {
  diffInline,
  hasInlineChanges,
  outputSections,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// diffInline: one alignment, both sides
// ---------------------------------------------------------------------------

test("kept and added segments reassemble the after-text exactly", () => {
  const before = "The fix must move two numbers together.";
  const after = "The fix must move THREE numbers together, at once.";
  const segments = diffInline(before, after);
  assert.equal(
    segments
      .filter((segment) => segment.kind !== "removed")
      .map((segment) => segment.text)
      .join(""),
    after,
  );
  assert.ok(hasInlineChanges(segments));
});

test("a removed run appears in place, with its own spacing", () => {
  const segments = diffInline("x A y", "x y");
  assert.deepEqual(
    segments.map((segment) => [segment.kind, segment.text]),
    [
      ["kept", "x "],
      ["removed", "A "],
      ["kept", "y"],
    ],
  );
});

test("a replacement reads old-out then new-in", () => {
  const segments = diffInline("near 17 today", "near 42 today");
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["kept", "removed", "added", "kept"],
  );
  const removed = segments.find((segment) => segment.kind === "removed");
  assert.equal(removed?.text.trim(), "17");
});

test("identical texts are one kept run; empty sides do not throw", () => {
  const same = diffInline("only words", "only words");
  assert.deepEqual(same.map((segment) => segment.kind), ["kept"]);
  assert.equal(hasInlineChanges(same), false);
  assert.deepEqual(diffInline("", ""), []);
  assert.deepEqual(
    diffInline("", "all new").map((segment) => segment.kind),
    ["added"],
  );
  assert.deepEqual(
    diffInline("all gone", "").map((segment) => segment.kind),
    ["removed"],
  );
});

// ---------------------------------------------------------------------------
// outputSections: the main section as diffable text
// ---------------------------------------------------------------------------

test("a paper body projects to labelled sections, paragraphs stacked", () => {
  const sections = outputSections({
    paper: {
      abstract: ["First paragraph.", "Second paragraph."],
      introduction: ["Intro."],
      method: ["The mechanism."],
      discussion: [],
      conclusion: ["Done."],
    },
  });
  assert.deepEqual(
    sections.map((section) => section.label),
    ["Abstract", "Introduction", "Method", "Conclusion"],
  );
  assert.equal(sections[0]!.text, "First paragraph.\nSecond paragraph.");
});

test("nested structures flatten deterministically; camelCase keys humanize", () => {
  const sections = outputSections({
    solution: {
      problemFraming: "The frame.",
      priorAttempts: [
        { attempt: "Swap the eigenvector", outcome: "smeared cloud" },
      ],
      validationPlan: ["Measure the ratio", "Rerun the map"],
    },
  });
  assert.deepEqual(
    sections.map((section) => section.label),
    ["Problem framing", "Prior attempts", "Validation plan"],
  );
  assert.equal(sections[1]!.text, "Swap the eigenvector — smeared cloud");
  assert.equal(sections[2]!.text, "Measure the ratio\nRerun the map");
});

test("an idea without a shape body projects to nothing", () => {
  assert.deepEqual(outputSections({}), []);
});
