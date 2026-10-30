import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CachedResource } from '../src/data/cached-resource.js';

test('launch snapshot is shared by repeated picker reads and refreshed explicitly', async () => {
  let calls = 0;
  const resource = new CachedResource(async () => ++calls);
  const first = resource.read();
  assert.equal(resource.read(), first);
  assert.equal(await first, 1);
  assert.equal(await resource.read(), 1);
  assert.equal(calls, 1);
  assert.equal(await resource.refresh(), 2);
  assert.equal(await resource.read(), 2);
});

test('a previous provider response cannot replace a newer snapshot', async () => {
  const resolvers: ((value: string) => void)[] = [];
  const resource = new CachedResource(() => new Promise<string>(resolve => resolvers.push(resolve)));
  const old = resource.read();
  await Promise.resolve();
  const current = resource.refresh();
  await Promise.resolve();
  resolvers[1]!('current provider');
  await current;
  resolvers[0]!('previous provider');
  await old;
  assert.equal(resource.getSnapshot().value, 'current provider');
  assert.equal(await resource.read(), 'current provider');
});

test('refresh failure preserves the snapshot and opening a picker does not retry', async () => {
  let calls = 0;
  const error = new Error('temporarily unavailable');
  const resource = new CachedResource(async () => { if (++calls === 2) throw error; return calls; });
  await resource.read();
  await assert.rejects(resource.refresh(), error);
  assert.equal(resource.getSnapshot().value, 1);
  assert.equal(resource.getSnapshot().error, error);
  assert.equal(await resource.read(), 1);
  assert.equal(calls, 2);
  assert.equal(await resource.refresh(), 3);
});

test('failed initial discovery is retried only through an explicit refresh', async () => {
  let calls = 0;
  const error = new Error('offline');
  const resource = new CachedResource(async () => { if (++calls === 1) throw error; return 'ready'; });
  await assert.rejects(resource.read(), error);
  await assert.rejects(resource.read(), error);
  assert.equal(calls, 1);
  assert.equal(await resource.refresh(), 'ready');
  assert.equal(await resource.read(), 'ready');
  assert.equal(calls, 2);
});
