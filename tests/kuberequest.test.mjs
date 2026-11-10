import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const teleport = require(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));

/**
 * Marking a requestable kube cluster as needing MFA happens before the grant
 * exists, exactly like mfarequest.test.mjs covers for a server — but a kube
 * cluster has no uuid at all, so it is keyed by name instead, with a
 * distinct `tsh-kube:` prefix so the two id spaces can never collide.
 */

test('a default-home kube cluster gets the plain tsh-kube:<cluster>:<name> id', () => {
  const ids = teleport.inventoryKubeIds({
    items: [{ id: '/teleport.example.com/kube_cluster/dev', cluster: 'teleport.example.com', name: 'dev' }],
  });
  assert.deepEqual(ids, { '/teleport.example.com/kube_cluster/dev': 'tsh-kube:teleport.example.com:dev' });
});

test('a non-default home folds its own name into the id, same as inventoryNodeIds does', () => {
  const ids = teleport.inventoryKubeIds({
    items: [{ id: '/teleport.example.com/kube_cluster/dev', cluster: 'teleport.example.com', name: 'dev' }],
    home: '/Users/steven/.tsh-work',
  });
  assert.deepEqual(ids, { '/teleport.example.com/kube_cluster/dev': 'tsh-kube:work:teleport.example.com:dev' });
});

test('several resources are matched back up by their own id, not by array order', () => {
  const items = [
    { id: '/a.example.com/kube_cluster/dev', cluster: 'a.example.com', name: 'dev' },
    { id: '/b.example.com/kube_cluster/staging', cluster: 'b.example.com', name: 'staging' },
  ];
  const ids = teleport.inventoryKubeIds({ items });
  assert.equal(ids['/a.example.com/kube_cluster/dev'], 'tsh-kube:a.example.com:dev');
  assert.equal(ids['/b.example.com/kube_cluster/staging'], 'tsh-kube:b.example.com:staging');
});

test('a resource with no name is skipped rather than mis-keyed', () => {
  const ids = teleport.inventoryKubeIds({
    items: [{ id: '/teleport.example.com/kube_cluster/', cluster: 'teleport.example.com', name: '' }],
  });
  assert.deepEqual(ids, {});
});

test('a kube id can never collide with a node id, even naming the same cluster', () => {
  const kubeIds = teleport.inventoryKubeIds({ items: [{ id: 'x', cluster: 'lab.example.com', name: 'abc-123' }] });
  const nodeIds = teleport.inventoryNodeIds({ items: [{ id: 'x', cluster: 'lab.example.com', uuid: 'abc-123' }] });
  assert.notEqual(kubeIds.x, nodeIds.x);
});

test('no items, or no argument at all, is just an empty map', () => {
  assert.deepEqual(teleport.inventoryKubeIds({}), {});
  assert.deepEqual(teleport.inventoryKubeIds(), {});
});
