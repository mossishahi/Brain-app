import assert from "node:assert/strict";
import test from "node:test";
import { createOverviewState } from "../src/features/library/overview-state.js";
import { libraryActions } from "../src/features/library/library-actions.js";

test("jobs snapshots cannot notify a readiness or connection-only consumer", () => {
  const state = createOverviewState();
  const readiness = state.readiness.getSnapshot();
  let readinessUpdates = 0;
  let connectionUpdates = 0;
  let listUpdates = 0;
  state.readiness.subscribe(() => readinessUpdates++);
  state.connected.subscribe(() => connectionUpdates++);
  const unsubscribe = state.jobs.subscribe(() => listUpdates++);
  for (let index = 0; index < 100; index++) state.jobs.publish({ data: [], loading: false, error: null });
  assert.equal(listUpdates, 100);
  assert.equal(readinessUpdates, 0);
  assert.equal(connectionUpdates, 0);
  assert.equal(state.readiness.getSnapshot(), readiness);
  unsubscribe();
  state.jobs.publish({ data: [], loading: false, error: null });
  assert.equal(listUpdates, 100);
});

test("a repeated stable snapshot emits no redundant subscriber notification", () => {
  const state = createOverviewState();
  let updates = 0;
  state.connected.subscribe(() => updates++);
  state.connected.publish(true);
  state.connected.publish(true);
  assert.equal(updates, 1);
});

test("trash stays read only even when a malformed list reports a live status", () => {
  const readonly = { pause: false, resume: false, stop: false, retry: false, trash: false, download: false };
  assert.deepEqual(libraryActions({ status: "running", trashedAt: 1 }), readonly);
  assert.deepEqual(libraryActions({ status: "failed" }, true), readonly);
});

test("pause, stop, resume and retry retain their distinct run semantics", () => {
  assert.equal(libraryActions({ status: "running" }).pause, true);
  assert.equal(libraryActions({ status: "running" }).trash, false);
  assert.equal(libraryActions({ status: "paused" }).resume, true);
  assert.equal(libraryActions({ status: "paused" }).stop, true);
  assert.equal(libraryActions({ status: "cancelled" }).resume, false);
  assert.equal(libraryActions({ status: "failed" }).retry, true);
  assert.equal(libraryActions({ status: "completed" }).retry, false);
});
