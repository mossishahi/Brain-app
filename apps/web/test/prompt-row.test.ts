import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// api.ts is read rather than imported: it reaches for EventSource and window,
// and this suite compiles against the node lib alone (tsconfig.test.json).
const source = (relative: string): string =>
  readFileSync(new URL(`../../src/${relative}`, import.meta.url), "utf8");

// Comments are stripped before any selector is read, the same way
// liveness-css.test.ts does it: prose about ".activity-entry" would otherwise
// read as a rule.
const CSS = source("theme.css").replace(/\/\*[\s\S]*?\*\//g, "");

test("a row addresses its record by the run and the id, both escaped", () => {
  // Both halves are path SEGMENTS: an unescaped slash in either would address
  // a different route entirely.
  assert.match(
    source("api.ts"),
    /\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/prompt\/\$\{encodeURIComponent\(promptId\)\}/,
  );
});

test("an llm_call row is a link, so the keyboard reaches it too", () => {
  // A click handler on an <li> works for a mouse and for nothing else. The
  // anchor is also what makes the download the browser's rather than ours, so
  // a whole prompt never passes through this page's state.
  const code = source("components/common.tsx");
  assert.match(
    code,
    /entry\.kind === "llm_call" && entry\.promptId !== undefined/,
    "the row is clickable only when there is a record behind it",
  );
  // Both branches wear the same computed row class (kind + outcome).
  assert.match(code, /const rowClass = `activity-entry activity-\$\{entry\.kind\}/);
  assert.match(code, /<a\s+className=\{rowClass\}/);
  assert.match(code, /href=\{promptHref\}/);
  assert.match(code, /\bdownload\b/);
});

test("no other row kind became clickable", () => {
  // "The only clickable row in the feed" is the claim; this is what would
  // break it. Every other kind still renders as the plain <li> it always did.
  const code = source("components/common.tsx");
  assert.match(
    code,
    /<li key=\{entry\.id\} className=\{rowClass\}>\s*<ActivityCells entry=\{entry\}[^/]*\/>\s*<\/li>/,
    "the non-linked branch must stay a bare list item",
  );
  assert.doesNotMatch(
    code,
    /<li[^>]*\sonClick=/,
    "an activity row must not gain a click handler",
  );
});

test("the linked row takes the accent on hover AND on focus", () => {
  // Two states, one rule: a keyboard reader gets no pointer, so focus has to
  // say exactly what hover says.
  const hover = /a\.activity-entry:hover[^{]*\{([^}]*)\}/.exec(CSS);
  assert.ok(hover, "no a.activity-entry:hover rule in theme.css");
  assert.match(hover[1]!, /color:\s*var\(--accent\)/, "the colour must come from a token");
  assert.match(
    CSS,
    /a\.activity-entry:focus-visible/,
    "focus must be styled, not only hover",
  );
  assert.match(
    /a\.activity-entry\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "",
    /cursor:\s*pointer/,
    "the one clickable row must say so with the cursor",
  );
});

test("nothing in the feed is shouted", () => {
  // The design spec's standing rule, checked where new rules were added.
  const rules = [...CSS.matchAll(/(a\.activity-entry[^{]*|\.activity-entry-link[^{]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.doesNotMatch(rule[2]!, /text-transform/, `${rule[1]!.trim()} transforms its text`);
  }
});
