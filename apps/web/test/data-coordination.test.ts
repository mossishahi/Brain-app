import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerEvent } from '@brainstorm-agentic/protocol';
import { SerializedResource } from '../src/data/serialized-resource.js';
import { CachedResource } from '../src/data/cached-resource.js';
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

test('opening another editor can read saved settings while a provider save is pending', async () => {
  const resource = new SerializedResource<number>();
  assert.equal(await resource.read(async () => 1), 1);
  const provider = deferred<number>();
  const save = resource.mutate(() => provider.promise, () => {});
  let readSettled = false;
  const read = resource.read(async () => 1).then(value => { readSettled = true; return value; });
  await tick();
  assert.equal(readSettled, true, 'a read must not queue behind credential verification');
  assert.equal(await read, 1);
  assert.equal(resource.getSnapshot(), 1);
  provider.resolve(2); await save;
  assert.equal(resource.getSnapshot(), 2);
});

test('a read begun after a queued write cannot overwrite its later committed snapshot', async () => {
  const resource = new SerializedResource<number>();
  const provider = deferred<number>(); const oldRead = deferred<number>();
  const save = resource.mutate(() => provider.promise, () => {});
  let count = 0;
  const read = resource.read(() => ++count === 1 ? oldRead.promise : Promise.resolve(2));
  provider.resolve(2); await save;
  oldRead.resolve(1);
  assert.equal(await read, 2);
  assert.equal(resource.getSnapshot(), 2);
});

test('a failed catalog load is retryable and late refreshes cannot replace newer results', async () => {
  let attempts = 0;
  const old = deferred<number>();
  const resource = new CachedResource(() => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error('offline'));
    if (attempts === 2) return old.promise;
    return Promise.resolve(3);
  });
  await assert.rejects(resource.read(), /offline/);
  const retry = resource.read();
  await tick();
  assert.equal(attempts, 2);
  await resource.refresh();
  old.resolve(2); await retry;
  assert.equal(resource.getSnapshot().value, 3);
  assert.equal(resource.getSnapshot().loading, false);
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
