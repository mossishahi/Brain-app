import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionIdFromPath, connectionPath, researchApiBase, scopedStorageKey } from '../src/desktop/paths.js';

test('research requests bind to the connection in the page URL only in launcher mode', () => {
  assert.equal(researchApiBase('/connections/cluster-123/', true), '/connections/cluster-123/api');
  assert.equal(researchApiBase('/connections/laptop_2/', true), '/connections/laptop_2/api');
  assert.equal(researchApiBase('/connections/cluster-123/', false), '/api');
  assert.equal(researchApiBase('/', false), '/api');
});

test('connection identifiers cannot turn a workspace link into a different origin or API path', () => {
  for (const value of ['//evil.test', '../api', '', 'host?token=1', '%2e%2e', 'host/second', 'host#fragment']) {
    assert.throws(() => connectionPath(value));
  }
  assert.equal(connectionPath('valid-123_abc'), '/connections/valid-123_abc/');
  assert.equal(connectionIdFromPath('/connections/../', true), undefined);
  assert.equal(connectionIdFromPath('/connections/host%2Fother/', true), undefined);
  assert.equal(connectionIdFromPath('/another/connections/host/', true), undefined);
});

test('draft attachments and onboarding do not leak between hosts or into direct server mode', () => {
  assert.notEqual(scopedStorageKey('draft', '/connections/one/', true), scopedStorageKey('draft', '/connections/two/', true));
  assert.notEqual(scopedStorageKey('draft', '/connections/one/', true), scopedStorageKey('draft', '/', false));
  assert.equal(scopedStorageKey('draft', '/connections/one/', true), scopedStorageKey('draft', '/connections/one/', true));
  assert.equal(scopedStorageKey('draft', '/', false), 'draft');
});
