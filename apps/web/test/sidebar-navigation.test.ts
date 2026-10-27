import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, resolveRoute, routeHash, selectJob, withPanel, type Route } from "../src/shell/routes.js";

test("opening and switching library panels preserve the current job and stage", () => {
  const job: Route = { view: "job", jobId: "run-42", stage: "review-members" };
  const history = withPanel(job, "history");
  assert.deepEqual(history, { ...job, panel: "history" });
  assert.equal(routeHash(history), "#/jobs/run-42/stage/review-members?panel=history");
  const trash = withPanel(history, "trash");
  assert.deepEqual(trash, { ...job, panel: "trash" });
  assert.deepEqual(withPanel(trash), job);
  assert.deepEqual(job, { view: "job", jobId: "run-42", stage: "review-members" });
});

test("home and a library panel remain separate route state", () => {
  assert.deepEqual(parseRoute("#/?panel=history"), { view: "home", panel: "history" });
  assert.deepEqual(parseRoute("#/?panel=trash"), { view: "home", panel: "trash" });
  assert.equal(routeHash(withPanel({ view: "home" }, "history")), "#/?panel=history");
  assert.equal(routeHash(withPanel({ view: "home", panel: "trash" })), "#/");
});

test("canonical snapshots restore main view and panel independently of the current view", () => {
  const snapshots: Route[] = [
    { view: "job", jobId: "first", stage: "review-members" },
    { view: "job", jobId: "first", stage: "review-members", panel: "history" },
    { view: "job", jobId: "second", panel: "history" },
    { view: "job", jobId: "second" },
    { view: "home", panel: "trash" },
  ];
  for (const snapshot of [...snapshots, ...[...snapshots].reverse()]) {
    assert.deepEqual(resolveRoute(routeHash(snapshot), snapshots[4]), snapshot);
  }
});

test("legacy direct links open the library beside home while in-app links keep the run", () => {
  const current: Route = { view: "job", jobId: "working-run", stage: "synthesize-proposal", panel: "history" };
  for (const panel of ["history", "trash"] as const) {
    const hash = `#/${panel}`;
    assert.deepEqual(parseRoute(hash), { view: "home", panel });
    assert.deepEqual(resolveRoute(hash), { view: "home", panel });
    assert.deepEqual(resolveRoute(hash, current), { ...current, panel });
    assert.equal(routeHash(resolveRoute(hash, current)), `#/jobs/working-run/stage/synthesize-proposal?panel=${panel}`);
  }
  assert.deepEqual(resolveRoute("#/trash/", current), { ...current, panel: "trash" });
});

test("job and stage identifiers round-trip encoded punctuation and Unicode", () => {
  const route: Route = { view: "job", jobId: "run /?# +%中文", stage: "review/é #?", panel: "history" };
  const hash = routeHash(route);
  assert.equal(hash, "#/jobs/run%20%2F%3F%23%20%2B%25%E4%B8%AD%E6%96%87/stage/review%2F%C3%A9%20%23%3F?panel=history");
  assert.deepEqual(parseRoute(hash), route);
  assert.deepEqual(parseRoute("#/jobs/run-1/stage/review-members/"), { view: "job", jobId: "run-1", stage: "review-members" });
});

test("malformed path segments fail safely and valid panel state is retained", () => {
  for (const hash of ["#/jobs/%", "#/jobs/%E0%A4", "#/jobs/run/stage/%", "#/jobs/run/unexpected", "#/jobs/run/stage/", "#/jobs/%00", "#/jobs/run#extra"]) {
    assert.deepEqual(parseRoute(hash), { view: "home" }, hash);
    assert.deepEqual(parseRoute(`${hash}?panel=history`), { view: "home", panel: "history" }, hash);
  }
  assert.deepEqual(parseRoute("#/jobs/run?panel=unknown"), { view: "job", jobId: "run" });
  assert.deepEqual(parseRoute("#/jobs/run?panel=%E0%A4"), { view: "job", jobId: "run" });
  assert.deepEqual(parseRoute("#/jobs/run?ignored=yes&panel=trash"), { view: "job", jobId: "run", panel: "trash" });
  assert.deepEqual(parseRoute(""), { view: "home" });
});

test("invalid in-memory identifiers do not throw while rendering navigation links", () => {
  assert.equal(routeHash({ view: "job", jobId: "", panel: "history" }), "#/?panel=history");
  assert.equal(routeHash({ view: "job", jobId: "\ud800", panel: "trash" }), "#/?panel=trash");
  assert.equal(routeHash({ view: "job", jobId: "valid", stage: "\u0000" }), "#/jobs/valid");
  assert.equal(routeHash({ view: "job", jobId: "valid", stage: "\ud800", panel: "history" }), "#/jobs/valid?panel=history");
});

test("selecting a run closes the floating library and clears only another run's stage", () => {
  const current: Route = { view: "job", jobId: "first", stage: "review-members", panel: "history" };
  assert.deepEqual(selectJob(current, "second"), { view: "job", jobId: "second" });
  assert.deepEqual(selectJob(current, "first"), { view: "job", jobId: "first", stage: "review-members" });
  assert.deepEqual(selectJob({ view: "home" }, "first"), { view: "job", jobId: "first" });
});
