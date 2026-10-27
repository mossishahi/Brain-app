import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoute, resolveRoute, type Route } from '../src/shell/routes.js';
import { dismissTransientOnNavigation } from '../src/shell/transient-navigation.js';

test('closing the library leaves a newly clicked workspace control open', () => {
  for (const workspace of [{ view: 'home' }, { view: 'job', jobId: 'run-42', stage: 'review-members' }] satisfies Route[]) {
    for (const panel of ['history', 'trash'] as const) {
      assert.equal(dismissTransientOnNavigation({ ...workspace, panel }, workspace), false);
    }
    assert.equal(dismissTransientOnNavigation(workspace, { ...workspace }), false);
  }
});

test('opening or switching library sections dismisses existing workspace menus', () => {
  const workspace: Route = { view: 'job', jobId: 'run-42', stage: 'review-members' };
  for (const panel of ['history', 'trash'] as const) {
    const opened: Route = { ...workspace, panel };
    assert.equal(dismissTransientOnNavigation(workspace, opened), true);
    assert.equal(dismissTransientOnNavigation(opened, { ...opened }), false);
  }
  assert.equal(dismissTransientOnNavigation({ ...workspace, panel: 'history' }, { ...workspace, panel: 'trash' }), true);
  assert.equal(dismissTransientOnNavigation({ ...workspace, panel: 'trash' }, { ...workspace, panel: 'history' }), true);
});

test('main workspace and stage navigation dismiss controls even when the library closes', () => {
  const current: Route = { view: 'job', jobId: 'run-42', stage: 'review-members', panel: 'history' };
  for (const next of [
    { view: 'home' },
    { view: 'job', jobId: 'run-43' },
    { view: 'job', jobId: 'run-42', stage: 'synthesize-proposal' },
    { view: 'job', jobId: 'run-42' },
  ] satisfies Route[]) {
    assert.equal(dismissTransientOnNavigation(current, next), true);
    assert.equal(dismissTransientOnNavigation(next, current), true);
  }
});

test('legacy library navigation is resolved against the previous workspace before dismissal', () => {
  const previous = parseRoute('#/jobs/run-42/stage/review-members?panel=history');
  assert.equal(dismissTransientOnNavigation(previous, resolveRoute('#/history', previous)), false);
  assert.equal(dismissTransientOnNavigation(previous, resolveRoute('#/trash', previous)), true);
});
