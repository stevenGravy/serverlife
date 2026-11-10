import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kube.js'));

/** Recognising a context tsh itself created, from its exec-plugin user entry alone. */

test('a tsh kube credentials exec plugin is recognised, flags in any order', () => {
  const user = {
    exec: {
      command: '/usr/local/bin/tsh',
      args: ['kube', 'credentials', '--kube-cluster=dev', '--teleport-cluster=teleport.example.com', '--proxy=teleport.example.com'],
    },
  };
  assert.deepEqual(K.teleportOriginOf(user),
    { kubeCluster: 'dev', cluster: 'teleport.example.com', proxy: 'teleport.example.com' });
});

test('falls back to the teleport cluster name when no --proxy= is given', () => {
  const user = { exec: { command: 'tsh', args: ['kube', 'credentials', '--kube-cluster=dev', '--teleport-cluster=foo'] } };
  assert.equal(K.teleportOriginOf(user).proxy, 'foo');
});

test('an AWS EKS exec plugin is not mistaken for one of tsh’s', () => {
  const user = { exec: { command: 'aws', args: ['--region', 'us-west-2', 'eks', 'get-token', '--cluster-name', 'prod-eks-shared'] } };
  assert.equal(K.teleportOriginOf(user), null);
});

test('a GKE auth plugin, which takes no args at all, is not mistaken either', () => {
  const user = { exec: { command: 'gke-gcloud-auth-plugin', args: null } };
  assert.equal(K.teleportOriginOf(user), null);
});

test('no exec plugin at all (a static cert/key user) is not Teleport', () => {
  assert.equal(K.teleportOriginOf({ 'client-certificate': '/x', 'client-key': '/y' }), null);
  assert.equal(K.teleportOriginOf(undefined), null);
});

test('tsh kube credentials missing its required flags is not treated as Teleport', () => {
  assert.equal(K.teleportOriginOf({ exec: { command: 'tsh', args: ['kube', 'credentials'] } }), null);
});
