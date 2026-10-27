import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerEvent } from '@brainstorm-agentic/protocol';
import { SerializedResource } from '../src/data/serialized-resource.js';
import { BoundedCache } from '../src/data/bounded-cache.js';
import { compactEvents, isServerEvent } from '../src/data/event-batch.js';
import { parseRoute } from '../src/shell/routes.js';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('concurrent editors publish writes in order, and a failed save does not block the next editor', async () => {
  const resource = new SerializedResource<number>();
  const first = deferred<number>(); const started: string[] = []; const published: number[] = [];
  const a = resource.mutate(() => { started.push('first'); return first.promise; }, value => published.push(value));
  const failed = resource.mutate(async () => { started.push('failed'); throw new Error('offline'); }, value => published.push(value));
  const rejected = assert.rejects(failed, /offline/);
  const last = resource.mutate(async () => { started.push('last'); return 3; }, value => published.push(value));
  await tick(); assert.deepEqual(started, ['first']);
  first.resolve(1); await a; await rejected; assert.equal(await last, 3);
  assert.deepEqual(started, ['first', 'failed', 'last']); assert.deepEqual(published, [1, 3]);
});

test('a read that overlaps a write never restores stale settings; simultaneous reads share transport', async () => {
  const resource = new SerializedResource<number>(); const stale = deferred<number>(); let count = 0;
  const load = () => ++count === 1 ? stale.promise : Promise.resolve(2);
  const a = resource.read(load); const b = resource.read(load); assert.equal(a, b);
  await tick(); await resource.mutate(async () => 2, () => {}); stale.resolve(1);
  assert.equal(await a, 2); assert.equal(count, 2);
});

test('job snapshots obey byte/count/age budgets and oversized jobs do not remain cached', () => {
  let now = 0; const cache = new BoundedCache<string, number>(2, 10, 100, () => now);
  cache.set('a', 1, 4); cache.set('b', 2, 4); assert.equal(cache.get('a'), 1);
  cache.set('c', 3, 4); assert.equal(cache.get('b'), undefined); assert.equal(cache.totalWeight, 8);
  cache.set('a', 4, 11); assert.equal(cache.get('a'), undefined); assert.equal(cache.size, 1);
  now = 101; assert.equal(cache.get('c'), undefined); assert.equal(cache.totalWeight, 0);
});

test('stream bursts compact full snapshots but preserve append/reset/end ordering across jobs', () => {
  const live = (jobId: string, entry: object) => ({ type: 'live', jobId, entries: [entry] }) as ServerEvent;
  const snapshot = (jobId: string, updatedAt: number) => ({ type: 'job', job: { jobId, updatedAt } }) as ServerEvent;
  const events = [snapshot('a', 1), live('a', { id: 'x', append: 'hello' }), live('a', { id: 'x', text: 'reset' }), live('b', { id: 'y', append: 'other' }), snapshot('a', 2), live('a', { id: 'x', ended: true })];
  const output = compactEvents(events);
  assert.deepEqual(output, [
    { type: 'live', jobId: 'a', entries: [{ id: 'x', append: 'hello' }, { id: 'x', text: 'reset' }] },
    events[3], events[4], events[5],
  ]);
  assert.equal(isServerEvent({ type: 'job' }), false);
  assert.equal(isServerEvent({ type: 'live', jobId: 'a', entries: null }), false);
  assert.equal(isServerEvent(null), false);
  assert.equal(isServerEvent(events[1]), true);
});

test('research deep links survive encoded identifiers and malformed links recover safely', () => {
  assert.deepEqual(parseRoute('#/jobs/my%20run/stage/review'), { view: 'job', jobId: 'my run', stage: 'review' });
  assert.deepEqual(parseRoute('#/jobs/%E0%A4%A'), { view: 'home' });
  assert.deepEqual(parseRoute('#/history'), { view: 'home', panel: 'history' });
});
