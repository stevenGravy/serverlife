import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kuberelations.js'));

test('a Pod leads to its controlling ReplicaSet, by ownerReferences', () => {
  const pod = {
    kind: 'Pod',
    metadata: {
      name: 'web-57fdfc7498-b925x', namespace: 'default',
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-57fdfc7498', controller: true }],
    },
  };
  assert.deepEqual(K.relatedOf(pod), [{ kind: 'ReplicaSet', name: 'web-57fdfc7498', namespace: 'default', via: 'owner' }]);
});

test('several owner references: the controller is the one that counts, not the first in the list', () => {
  const obj = {
    kind: 'Pod',
    metadata: {
      name: 'x', namespace: 'ns',
      ownerReferences: [
        { kind: 'SomeWebhookWatcher', name: 'not-the-controller', controller: false },
        { kind: 'ReplicaSet', name: 'the-real-owner', controller: true },
      ],
    },
  };
  assert.deepEqual(K.relatedOf(obj)[0], { kind: 'ReplicaSet', name: 'the-real-owner', namespace: 'ns', via: 'owner' });
});

test('no owner references at all: nothing to jump to', () => {
  assert.deepEqual(K.relatedOf({ kind: 'Pod', metadata: { name: 'x', namespace: 'ns' } }), []);
});

test('a PersistentVolumeClaim leads to its bound PersistentVolume, cluster-scoped', () => {
  const pvc = { kind: 'PersistentVolumeClaim', metadata: { name: 'data', namespace: 'ns' }, spec: { volumeName: 'pv-0123' } };
  assert.deepEqual(K.relatedOf(pvc), [{ kind: 'PersistentVolume', name: 'pv-0123', namespace: null, via: 'volumeName' }]);
});

test('a PersistentVolumeClaim not yet bound leads nowhere', () => {
  assert.deepEqual(K.relatedOf({ kind: 'PersistentVolumeClaim', metadata: { name: 'data', namespace: 'ns' }, spec: {} }), []);
});

test('a Service leads to its own Endpoints, same name and namespace', () => {
  const svc = { kind: 'Service', metadata: { name: 'web', namespace: 'ns' }, spec: { selector: { app: 'web' } } };
  assert.deepEqual(K.relatedOf(svc), [{ kind: 'Endpoints', name: 'web', namespace: 'ns', via: 'same name' }]);
});

test('a Service with an owner (rare, but possible) gets both: owner first, then its Endpoints', () => {
  const svc = {
    kind: 'Service',
    metadata: { name: 'web', namespace: 'ns', ownerReferences: [{ kind: 'Ingress', name: 'web-ingress', controller: true }] },
  };
  assert.deepEqual(K.relatedOf(svc), [
    { kind: 'Ingress', name: 'web-ingress', namespace: 'ns', via: 'owner' },
    { kind: 'Endpoints', name: 'web', namespace: 'ns', via: 'same name' },
  ]);
});

test('not an object at all: an empty list, not a throw', () => {
  assert.deepEqual(K.relatedOf(null), []);
  assert.deepEqual(K.relatedOf(undefined), []);
});
