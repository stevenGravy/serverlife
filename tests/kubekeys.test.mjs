import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings } from './helpers.mjs';

/**
 * Kubernetes clusters' settings keys. A cluster was keyed by its row's id —
 * the context's id once logged in, `avail:…` before — and is now keyed by
 * its group and name, so it is the same cluster either way. What was saved
 * under the old ids (a watch, a colour, a folder) has to come along, or an
 * upgrade quietly forgets it.
 */

const OLD = 'kube:tsh:prod.example.com:prod.example.com:dev';
const G = 'tp:prod.example.com:443';
const NEW = `kube:${G}:dev`;

const store = fakeSettings({
  watchedHosts: { [OLD]: { key: OLD, group: G, name: 'dev' }, 'uuid:1': { key: 'uuid:1', name: 'web' } },
  folderMembers: { f1: { in: [OLD, 'uuid:1'], out: [] } },
  hostColors: { [OLD]: 'red', [`avail:${G}:prod`]: 'blue', [`kube:${G}:prod`]: 'green' },
  staleNodeMinutes: 2,
});
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;
const F = await import('../src/renderer/js/folders.js');

const kube = (id, name) => ({ kind: 'kube', id, name, groupKey: G });
const settle = () => new Promise((r) => setTimeout(r, 0));

test('a Teleport cluster is keyed by its group and name, a local context by its id', () => {
  assert.equal(F.hostKey(kube(OLD, 'dev')), NEW);
  assert.equal(F.hostKey({ kind: 'kube', id: 'kube:direct:minikube', name: 'minikube' }), 'kube:direct:minikube');
});

test('what was saved under the old id moves to the new key', async () => {
  F.migrateKubeHostKeys([kube(OLD, 'dev'), kube(`avail:${G}:prod`, 'prod')]);
  await settle();
  assert.deepEqual(store.watchedHosts[NEW], { key: NEW, group: G, name: 'dev' });
  assert.equal(store.watchedHosts[OLD], undefined);
  assert.deepEqual(store.folderMembers.f1.in, [NEW, 'uuid:1']);
  assert.equal(store.hostColors[NEW], 'red');
});

test('an entry already under the new key wins, and the old one goes', () => {
  assert.equal(store.hostColors[`kube:${G}:prod`], 'green');
  assert.equal(store.hostColors[`avail:${G}:prod`], undefined);
});

test('nothing else is touched, and it is done once', async () => {
  assert.deepEqual(store.watchedHosts['uuid:1'], { key: 'uuid:1', name: 'web' });
  assert.equal(store.staleNodeMinutes, 2);
  store.hostColors[OLD] = 'set again';
  F.migrateKubeHostKeys([kube(OLD, 'dev')]);
  await settle();
  assert.equal(store.hostColors[OLD], 'set again');
});
