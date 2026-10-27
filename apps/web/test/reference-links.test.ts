import assert from "node:assert/strict";
import test from "node:test";
import { referenceLinks } from "../src/components/panels/reference-links.js";

test("references retain surrounding prose and balanced URL parentheses", () => {
  assert.deepEqual(referenceLinks("See (https://example.org/paper_(proof)). Next: https://doi.org/10.1/abc?x=1&y=2; done."), [
    { text: "See (" }, { text: "https://example.org/paper_(proof)", href: "https://example.org/paper_(proof)" },
    { text: "). Next: " }, { text: "https://doi.org/10.1/abc?x=1&y=2", href: "https://doi.org/10.1/abc?x=1&y=2" }, { text: "; done." },
  ]);
});

test("markdown references use their label and keep nested URL parentheses", () => {
  assert.deepEqual(referenceLinks("[Full proof](https://example.org/a_(b_(c))) and [record](http://example.org/log#L3)."), [
    { text: "Full proof", href: "https://example.org/a_(b_(c))" }, { text: " and " },
    { text: "record", href: "http://example.org/log#L3" }, { text: "." },
  ]);
});

test("unsafe schemes, HTML and invalid URLs stay inert text", () => {
  const text = '[bad](javascript:alert(1)) <img src=x onerror=alert(1)> [data](data:text/html,test) https://.';
  assert.deepEqual(referenceLinks(text), [{ text }]);
  assert.deepEqual(referenceLinks(""), []);
});

test("malformed markdown preserves its text while linking a valid URL", () => {
  assert.deepEqual(referenceLinks("[Reference](https://example.org/paper missing close"), [
    { text: "[Reference](" }, { text: "https://example.org/paper", href: "https://example.org/paper" }, { text: " missing close" },
  ]);
});
