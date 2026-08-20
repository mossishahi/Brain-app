import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (relative: string): string =>
  readFileSync(new URL(`../../src/${relative}`, import.meta.url), "utf8");

/**
 * The run roots: every element that scopes one run. Each must be a RunScope,
 * because that is what carries the liveness decision to both the stylesheet
 * and the hooks — a plain <div className="dash"> renders identically and
 * silently drops the whole mechanism, which is exactly how it would rot.
 */
const RUN_ROOTS = [
  { file: "components/Dashboard.tsx", className: "dash", element: "div" },
  { file: "components/Landing.tsx", className: "job-card", element: "li" },
] as const;

for (const root of RUN_ROOTS) {
  test(`${root.className} is a run scope, not a bare ${root.element}`, () => {
    const code = source(root.file);
    assert.match(
      code,
      new RegExp(`<RunScope[^>]*className="${root.className}"`),
      `${root.file}: the .${root.className} root must be a <RunScope>, so a run's ` +
        `animations and its clocks stop when the run does`,
    );
    assert.doesNotMatch(
      code,
      new RegExp(`<${root.element}\\s+className="${root.className}"`),
      `${root.file}: a bare <${root.element} className="${root.className}"> is outside ` +
        `the liveness scope`,
    );
  });
}

test("the scope hands down the run's own status", () => {
  const code = source("components/run-liveness.tsx");
  assert.match(code, /data-run-live/, "the scope must reach the stylesheet");
  assert.match(code, /useRunLive/, "the scope must answer the hooks");
});
