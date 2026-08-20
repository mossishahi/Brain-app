import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Comments are stripped first: a selector capture reaches back to the previous
// closing brace, so prose about ".test.ts" would read as a class name.
const CSS = readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Animations that are NOT a claim about the run, with the reason each one is
 * allowed to keep moving while a run stands still. Anything not here has to be
 * covered by the run-liveness switch instead — that is the whole point of this
 * test: a new blinking thing cannot be added without deciding which it is.
 */
const NOT_RUN_LIVENESS: ReadonlyMap<string, string> = new Map([
  ["ambient", "page background décor, unrelated to any run"],
  ["job-state-strip-queued", "says WAITING — which is what a stopped run does"],
  ["job-state-strip-suspended", "says WAITING for the submitter's answer"],
  ["job-state-strip-credit-blocked", "says WAITING for the credit window"],
  ["btn-spinner", "a control the user just pressed — pausing must not freeze it"],
  ["save-spinner", "settings being saved, not a run"],
  ["update-spinner", "the app updating itself, not a run"],
  ["state-checking", "environment probe: it checks the machine, not the run"],
]);

/** Innermost blocks only; @keyframes step bodies never declare `animation`. */
function blocks(): readonly { selector: string; declarations: string }[] {
  const out: { selector: string; declarations: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS)) !== null) {
    out.push({ selector: m[1] ?? "", declarations: m[2] ?? "" });
  }
  return out;
}

function classesIn(selector: string): readonly string[] {
  return [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1] ?? "");
}

const frozen = new Set(
  blocks()
    .filter((b) => b.selector.includes('[data-run-live="false"]'))
    .flatMap((b) => classesIn(b.selector)),
);

test("the run-liveness switch actually stills something", () => {
  assert.ok(frozen.size > 0, "no [data-run-live=\"false\"] rule found in theme.css");
  for (const expected of ["pulse", "node-pulse", "skeleton-line"]) {
    assert.ok(frozen.has(expected), `.${expected} must be stilled by the switch`);
  }
});

test("every endless animation is either a run's or explicitly not", () => {
  const unclassified: string[] = [];
  for (const block of blocks()) {
    if (!/animation(-name)?\s*:[^;]*infinite/.test(block.declarations)) continue;
    const classes = classesIn(block.selector);
    const covered = classes.some((c) => frozen.has(c) || NOT_RUN_LIVENESS.has(c));
    if (!covered) unclassified.push(block.selector.trim().replace(/\s+/g, " "));
  }
  assert.deepEqual(
    unclassified,
    [],
    `these animations never stop, and nothing says whether they belong to the run:\n` +
      `${unclassified.join("\n")}\n` +
      `Add the class to the [data-run-live="false"] rule in theme.css if it means ` +
      `"work is in flight", or to NOT_RUN_LIVENESS here with the reason it does not.`,
  );
});

test("reduced motion and a stopped run still the same set", () => {
  // Two switches, one list: whatever a reader turns off for motion sickness is
  // exactly what a stopped run turns off for honesty. They drifted once —
  // .decompose-step-dot was in neither — and this keeps them together.
  const reduced = new Set(
    blocks()
      .filter((b) => /animation:\s*none\s*!important/.test(b.declarations))
      .flatMap((b) => classesIn(b.selector)),
  );
  assert.deepEqual(
    [...frozen].sort(),
    [...reduced].sort(),
    "the reduced-motion rule and the run-liveness rule name different classes",
  );
});
