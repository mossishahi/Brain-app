import assert from "node:assert/strict";
import test from "node:test";

import type { NoteTrace, NotesAccess, NotesScope } from "@brainstorm-agentic/core";

import {
  NOTES_SEARCH_MANIFEST,
  buildNotesIndex,
  notesTools,
  parseNotesInput,
  runNotesSearch,
  searchNotes,
  splitSentences,
} from "../src/index.js";

/** A thinker that planned everything before step 1, then wrote three steps. */
const FIRST_PASS: NoteTrace = {
  kind: "first-pass",
  order: 0,
  stepTurns: [
    { index: 1, turn: 10 },
    { index: 2, turn: 11 },
    { index: 3, turn: 12 },
  ],
  segments: [
    {
      turn: 2,
      text:
        "I'm checking the attachment list first. The data has 1,200 samples across 4 batches.\n\n" +
        "I'll assume the batches are exchangeable; I'm not sure that holds for batch 4, which was collected later. " +
        "Rather than fit a mixed model, the simpler route is to regress out batch means. Harmony (Korsunsky et al. 2019) does this with soft clustering.",
    },
    {
      turn: 5,
      text:
        "Convergence: the alternating scheme converges because each step decreases the objective, therefore the fixed point exists. " +
        "Should I double-check the Lipschitz condition? Probably fine.",
    },
    { turn: 10, text: "Step 1 drafted: the problem framing." },
    { turn: 11, text: "Step 2 drafted: the batch-correction method." },
    { turn: 12, text: "Step 3 drafted: the convergence argument." },
    { turn: 13, text: "Writing the final output now; the abstract leads with the convergence result." },
  ],
};

/** A repair of step 2 made at position 2. */
const REPAIR: NoteTrace = {
  kind: "redevelopment",
  order: 1,
  rewrote: [2],
  stepTurns: [{ index: 2, turn: 4 }],
  segments: [
    { turn: 2, text: "The judge says batch 4 breaks exchangeability. I'll switch to a per-batch intercept instead of regressing means." },
    { turn: 4, text: "Rewrote step 2 with the intercept model." },
  ],
};

const scopeAt = (throughStep: number): NotesScope => ({ seat: "member-3", throughStep });

test("sentences split on terminal punctuation but not on abbreviations", () => {
  assert.deepEqual(
    splitSentences("Harmony (Korsunsky et al. 2019) does this. It is fast, e.g. on 1M cells. Is it exact?"),
    ["Harmony (Korsunsky et al. 2019) does this.", "It is fast, e.g. on 1M cells.", "Is it exact?"],
  );
});

test("the index attributes paragraphs to the step they were written toward and hides later thinking", () => {
  const at1 = buildNotesIndex([FIRST_PASS, REPAIR], scopeAt(1));
  assert.deepEqual(
    at1.paragraphs.map((paragraph) => [paragraph.id, paragraph.step]),
    [
      ["F:1", 1],
      ["F:2", 1],
      ["F:3", 1],
      ["F:4", 1],
    ],
    "at step 1 only the planning and step 1's own turn are visible; the repair rewrote step 2 and is hidden",
  );
  const at3 = buildNotesIndex([FIRST_PASS, REPAIR], scopeAt(3));
  assert.deepEqual(
    at3.paragraphs.map((paragraph) => paragraph.id),
    ["F:1", "F:2", "F:3", "F:4", "F:5", "F:6", "F:7", "R1:1", "R1:2"],
    "at the last step the tail written after it and the repair are visible",
  );
  assert.equal(at3.paragraphs.find((paragraph) => paragraph.id === "F:7")!.step, undefined, "the tail belongs to no step");
  assert.equal(at3.traces[1]!.source, "redevelopment 1 (rewrote step 2)");
  assert.equal(at1.traces[0]!.hiddenChars > 0, true);
});

test("find returns sentences, paragraphs or windows, with filters", () => {
  const index = buildNotesIndex([FIRST_PASS, REPAIR], scopeAt(3));
  const sentences = searchNotes(index, { mode: "find", query: "batch 4" });
  assert.equal(sentences.total, 3, "words match inside longer words: '4 batches' counts");
  assert.deepEqual(
    (sentences.results as { id: string }[]).map((result) => result.id),
    ["F:1#2", "F:2#1", "R1:1#1"],
  );
  const phrase = searchNotes(index, { mode: "find", query: "batch 4", match: "phrase" });
  assert.deepEqual(
    (phrase.results as { id: string }[]).map((result) => result.id),
    ["F:2#1", "R1:1#1"],
  );
  const firstOnly = searchNotes(index, { mode: "find", query: "batch 4", match: "phrase", source: "first-pass" });
  assert.equal(firstOnly.total, 1);
  const window = searchNotes(index, { mode: "find", query: "Lipschitz", unit: "window", context: 1 });
  const hit = (window.results as { before?: string; text: string; after?: string }[])[0]!;
  assert.match(hit.before ?? "", /fixed point exists/);
  assert.match(hit.text, /Lipschitz/);
  assert.equal(hit.after, "Probably fine.");
  const paragraph = searchNotes(index, { mode: "find", query: "harmony clustering", unit: "paragraph" });
  assert.equal(paragraph.total, 1, "all words must occur in the paragraph");
  const any = searchNotes(index, { mode: "find", query: "harmony nowhere", match: "any", unit: "paragraph" });
  assert.equal(any.total, 1);
  const near = searchNotes(index, { mode: "find", query: "assume", near: "mixed model" });
  assert.equal(near.total, 1);
  const regex = searchNotes(index, { mode: "find", query: "converg\\w+", match: "regex" });
  assert.equal(regex.total, 3, "Convergence:…, step 3 drafted…, the abstract leads with the convergence result");
  const none = searchNotes(index, { mode: "find", query: "quantum" });
  assert.equal(none.total, 0);
  assert.match(String(none.hint), /Nothing matched/);
});

test("doubts, decisions and claims surface the thinker's hedges, choices and supports", () => {
  const index = buildNotesIndex([FIRST_PASS, REPAIR], scopeAt(3));
  const doubts = searchNotes(index, { mode: "doubts" });
  const doubtTexts = (doubts.results as { text: string; group: string }[]).map((result) => result.text);
  assert.ok(doubtTexts.some((text) => /not sure that holds/.test(text)));
  assert.ok(doubtTexts.some((text) => /double-check the Lipschitz/.test(text)));
  assert.equal((doubts.groups as Record<string, number>)["open question"], 1);
  assert.equal((doubts.results as { group: string }[])[0]!.group, "open question", "open questions come first");
  const hedges = searchNotes(index, { mode: "doubts", group: "hedge" });
  assert.ok((hedges.results as { group: string }[]).every((result) => result.group === "hedge"));
  assert.equal(hedges.total, (doubts.groups as Record<string, number>).hedge);
  assert.equal((doubts.scope as { traces: number }).traces, 2, "answers other than overview carry the trace count only");
  const decisions = searchNotes(index, { mode: "decisions" });
  const decisionTexts = (decisions.results as { text: string; after?: string }[]);
  assert.ok(decisionTexts.some((result) => /Rather than fit a mixed model/.test(result.text) && /Harmony/.test(result.after ?? "")));
  assert.ok(decisionTexts.some((result) => /switch to a per-batch intercept/.test(result.text)));
  const claims = searchNotes(index, { mode: "claims" });
  const groups = claims.groups as Record<string, number>;
  assert.ok(groups.assumptions >= 1 && groups.evidence >= 1 && groups.calculations >= 1 && groups.conclusions >= 1, JSON.stringify(groups));
  const filtered = searchNotes(index, { mode: "claims", query: "converges" });
  assert.equal(filtered.total, 1);
  assert.equal((filtered.results as { group: string }[])[0]!.group, "conclusions");
});

test("outline, read and overview give orientation and bounded reading", () => {
  const index = buildNotesIndex([FIRST_PASS, REPAIR], scopeAt(3));
  const outline = searchNotes(index, { mode: "outline" });
  assert.equal(outline.total, 9);
  const read = searchNotes(index, { mode: "read", from: "F:1", to: "F:2" });
  assert.equal((read.results as unknown[]).length, 2);
  const sentence = searchNotes(index, { mode: "read", ids: ["F:2#1", "F:99"] });
  assert.equal((sentence.results as { text: string }[])[0]!.text, "I'll assume the batches are exchangeable; I'm not sure that holds for batch 4, which was collected later.");
  assert.deepEqual(sentence.notFound, ["F:99"]);
  assert.throws(() => searchNotes(index, { mode: "read", from: "F:1", to: "R1:1" }), /same trace/);
  assert.throws(() => searchNotes(index, { mode: "read", ids: ["paragraph 3"] }), /not a notes id/);
  const overview = searchNotes(index, { mode: "overview" });
  assert.equal((overview.traces as unknown[]).length, 2);
  assert.ok((overview.frequentTerms as { term: string }[]).some((entry) => entry.term === "batch"));
  const small = searchNotes(index, { mode: "outline", maxResults: 2 });
  assert.equal((small.results as unknown[]).length, 2);
  assert.equal(small.more, true);
  assert.match(String(small.hint), /offset 2/);
});

test("a seat without recorded notes gets an honest empty answer", () => {
  const empty = buildNotesIndex([], scopeAt(2));
  const answer = searchNotes(empty, { mode: "find", query: "anything" });
  assert.equal(answer.total, 0);
  assert.match(String(answer.note), /No working notes were recorded/);
});

test("the tool parses the model's input and refuses outside a review scope", async () => {
  const access: NotesAccess = { traces: async () => [FIRST_PASS, REPAIR] };
  const [tool] = notesTools(access, (context) => (context.taskId === "task-in-review" ? scopeAt(2) : undefined));
  assert.equal(tool!.definition.name, NOTES_SEARCH_MANIFEST.toolId);
  const outside = await tool!.execute({ mode: "overview" }, { runId: "run", taskId: "other" });
  assert.equal(outside.isError, true);
  const inside = await tool!.execute({ mode: "find", query: "exchangeable", max_results: 5 }, { runId: "run", taskId: "task-in-review" });
  assert.equal(inside.isError, undefined);
  assert.equal((inside.output as { total: number }).total, 1);
  const bad = await runNotesSearch(access, scopeAt(2), { mode: "find", query: "(", match: "regex" });
  assert.equal(bad.isError, true);
  assert.match(String(bad.output), /regular expression/);
  assert.throws(() => parseNotesInput({ mode: "summarize" }), /mode must be one of/);
  assert.deepEqual(parseNotesInput({ query: "x", steps: 2, max_chars: 1000 }), { mode: "find", query: "x", steps: [2], maxChars: 1000 });
});
