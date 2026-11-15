import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@brainstorm-agentic/core";
import { formattingTokensUnchanged, JsonRepairSearchLimitError, singleClosingDelimiterRepairs } from "../src/json-format-repair.js";

const repaired = {
  output: { type: "research idea", paper: { title: "A bounded synthetic example", sections: [{ text: "Claim and limitation." }] } },
  references: [{ title: "Source", url: "https://example.invalid/paper", relation: "Supports the stated limitation." }],
};
// The paper was closed, but its enclosing output object was not closed before
// the references sibling began. Keep this fixture synthetic: no user research.
const missingBrace = '{"output":{"type":"research idea","paper":{"title":"A bounded synthetic example","sections":[{"text":"Claim and limitation."}]},"references":[{"title":"Source","url":"https://example.invalid/paper","relation":"Supports the stated limitation."}]}';

test("a missing nested closing brace can be repaired without rewriting any content", () => {
  assert.throws(() => JSON.parse(missingBrace));
  assert.equal(formattingTokensUnchanged(missingBrace, repaired), true);
  assert.equal(formattingTokensUnchanged(JSON.stringify(repaired), repaired), true);
});

test("scalar additions, deletions, rewrites, type changes and reordering are rejected", () => {
  assert.equal(formattingTokensUnchanged(missingBrace, { ...repaired, extra: "new content" }), false);
  assert.equal(formattingTokensUnchanged(missingBrace, { output: repaired.output }), false);
  assert.equal(formattingTokensUnchanged(missingBrace, { ...repaired, output: { ...repaired.output, type: "research question" } }), false);
  assert.equal(formattingTokensUnchanged(missingBrace, { references: repaired.references, output: repaired.output }), false);
  assert.equal(formattingTokensUnchanged('{"a":1}', { a: "1" }), false);
  assert.equal(formattingTokensUnchanged('{"a":true}', { a: "true" }), false);
  assert.equal(formattingTokensUnchanged('{"a":"original","a":"replacement"}', { a: "replacement" }), false);
  assert.equal(formattingTokensUnchanged('{"first":"one","second":"two"}', { first: "two", second: "one" }), false);
});

test("commas, brackets, colons and whitespace may change, including missing separators", () => {
  assert.equal(formattingTokensUnchanged('{"a" [1 2,] "b" true}', { a: [1, 2], b: true }), true);
  assert.equal(formattingTokensUnchanged('{"a":1"b":false}', { a: 1, b: false }), true);
  assert.equal(formattingTokensUnchanged('["a""b"]', ["a", "b"]), true);
  assert.equal(formattingTokensUnchanged('{"a":null,}', { a: null }), true);
});

test("complete JSON string escapes compare by decoded value", () => {
  assert.equal(formattingTokensUnchanged(String.raw`{"a":"\u0061","b":"quote: \" and slash \/ and newline\n"}`, {
    a: "a", b: 'quote: " and slash / and newline\n',
  }), true);
  assert.equal(formattingTokensUnchanged(String.raw`{"a":"\\","b":"{[,]}","c":"\uD83D\uDE00"}`, {
    a: "\\", b: "{[,]}", c: "😀",
  }), true);
  assert.equal(formattingTokensUnchanged(String.raw`{"a":"\u0061"}`, { a: "b" }), false);
});

test("damaged or truncated strings, numbers and literals cannot be called formatting repairs", () => {
  const badInputs = [
    String.raw`{"a":"bad\q"}`, String.raw`{"a":"bad\u12"}`,
    '{"a":"unterminated}', '{"a":"trailing\\', '{"a":"raw\nnewline"}',
    '{"a":1e}', '{"a":1e+}', '{"a":-}', '{"a":01}', '{"a":-01}', '{"a":1.}',
    '{"a":.1}', '{"a":+1}', '{"a":1+2}', '{"a":0x10}', '{"a":1true}',
    '{"a":tru}', '{"a":True}', '{"a":nul}', '{"a":nullfalse}',
    '{"a":NaN}', '{"a":Infinity}', '{"a":1e309}', '{"a":undefined}',
    '{"a":1/* comment */}', "", " \t\r\n", "Here is the answer: {}",
  ];
  for (const raw of badInputs) {
    assert.equal(formattingTokensUnchanged(raw, { a: "replacement" }), false, raw);
  }
  // These would pass a scanner that silently split or ignored invalid scalar text.
  assert.equal(formattingTokensUnchanged('[01]', [0, 1]), false);
  assert.equal(formattingTokensUnchanged('[truefalse]', [true, false]), false);
  assert.equal(formattingTokensUnchanged('[1e]', [1]), false);
});

test("numeric notation may change but exact numeric content may not", () => {
  assert.equal(formattingTokensUnchanged('{"a":1.000,"b":1e3,"c":0.1250,"d":-2.5e-2}', {
    a: 1, b: 1000, c: 0.125, d: -0.025,
  }), true);
  assert.equal(formattingTokensUnchanged('{"a":-0}', { a: 0 }), true);
  assert.equal(formattingTokensUnchanged('{"a":9007199254740993}', { a: 9007199254740992 }), false);
  assert.equal(formattingTokensUnchanged('{"a":1e-999}', { a: 0 }), false);
  assert.equal(formattingTokensUnchanged('{"a":0.10000000000000001}', { a: 0.1 }), false);
});

test("only an exact full markdown fence may surround the JSON", () => {
  assert.equal(formattingTokensUnchanged(`\n\`\`\`json\n${missingBrace}\n\`\`\`\n`, repaired), true);
  assert.equal(formattingTokensUnchanged(`\`\`\`\n${missingBrace}\n\`\`\``, repaired), true);
  for (const raw of [
    `\`\`\`json\n${missingBrace}`, `${missingBrace}\n\`\`\``,
    `Here is the result:\n\`\`\`json\n${missingBrace}\n\`\`\``,
    `\`\`\`json\n${missingBrace}\n\`\`\`\nExplanation follows.`,
    `\`\`\`javascript\n${missingBrace}\n\`\`\``,
  ]) assert.equal(formattingTokensUnchanged(raw, repaired), false);
});

test("non-JSON runtime values cannot be hidden by JSON.stringify", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, Symbol("x"), 1n]) {
    assert.equal(formattingTokensUnchanged('{"a":null}', { a: value } as unknown as JsonValue), false);
  }
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.equal(formattingTokensUnchanged("{}", cycle as JsonValue), false);
});

const repairs = (raw: string) => [...singleClosingDelimiterRepairs(raw, { maxDurationMs: 5_000 })];

test("single-closing-delimiter search preserves the missing nested-brace draft", () => {
  const candidates = repairs(missingBrace);
  assert.ok(candidates.some((candidate) => JSON.stringify(candidate.value) === JSON.stringify(repaired)));
  for (const candidate of candidates) {
    assert.equal(candidate.delimiter, "}");
    assert.equal(candidate.text, missingBrace.slice(0, candidate.offset) + "}" + missingBrace.slice(candidate.offset));
    assert.equal(formattingTokensUnchanged(missingBrace, candidate.value), true);
  }
});

test("a missing closing bracket before the parent brace is repaired at its token boundary", () => {
  assert.deepEqual(repairs('{"a":[1,2}').map((candidate) => candidate.value), [{ a: [1, 2] }]);
  assert.deepEqual(repairs('{"a":{"b":1},"c":"two"').map((candidate) => candidate.value), [{ a: { b: 1 }, c: "two" }]);
  assert.deepEqual(repairs('```json\n{"a":["braces: } ]"]\n```').map((candidate) => candidate.value), [{ a: ["braces: } ]"] }]);
});

test("ambiguous nesting is exposed as distinct candidates, identical parses are deduplicated", () => {
  const candidates = repairs('{"a":{"b":1,"c":2}');
  assert.deepEqual(candidates.map((candidate) => candidate.value), [
    { a: { b: 1 }, c: 2 }, { a: { b: 1, c: 2 } },
  ]);
});

test("single-delimiter search never invents values, repairs other syntax or accepts multiple missing closers", () => {
  for (const raw of [
    '{"a":}', '{"a":[1,}', '{"a":', '{"a":[1', '{"a":1,',
    '{"a":1 "b":2', '{"a":01', '{"a":1e', '{"a":tru', '{"a":"unfinished',
    String.raw`{"a":"bad\q"`, '{"a":9007199254740993', '{"a":1e-999',
    '{"a":1,"a":2', '[1}}', '{"a":[1}}', '{"a":1}', 'prefix {"a":1',
    '{"a":123', '{"a":true', '{"a":false', '{"a":null', '{"a":[123',
    '{"a":{},"a":{}', '{"a":{"b":9007199254740993}', '{"a":{"b":1e-999}',
  ]) assert.deepEqual(repairs(raw), [], raw);
});

test("a search timeout invalidates even a previously yielded candidate", () => {
  let tick = 0;
  const search = singleClosingDelimiterRepairs('{"a":"complete"', { maxDurationMs: 8, now: () => tick++ });
  const first = search.next();
  assert.equal(first.done, false);
  assert.deepEqual(first.value?.value, { a: "complete" });
  assert.throws(() => search.next(), JsonRepairSearchLimitError);
  assert.throws(() => [...singleClosingDelimiterRepairs('{"a":"complete"', { maxDurationMs: 1, now: () => tick++ })], JsonRepairSearchLimitError);
});

test("the search budget is checked while scanning a long string", () => {
  let tick = 0;
  const raw = `{"a":"${"x".repeat(10_000)}"`;
  assert.throws(() => [...singleClosingDelimiterRepairs(raw, { maxDurationMs: 2, now: () => tick++ })], JsonRepairSearchLimitError);
  assert.equal(tick, 3, "the lexer stopped before traversing the complete long string");
});

test("a long complete string is retained without any draft-length cap", () => {
  const value = "Evidence remains exactly as generated. ".repeat(3_000);
  const raw = `{"evidence":${JSON.stringify(value)}`;
  assert.deepEqual(repairs(raw).map((candidate) => candidate.value), [{ evidence: value }]);
});
