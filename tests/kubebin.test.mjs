import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubebin.js'));

/** `kubectl version --client`'s banner, parsed into a comparable version. */

test('parses the "Client Version: vX.Y.Z" line', () => {
  assert.deepEqual(K.parseKubectlVersion('Client Version: v1.34.1\nKustomize Version: v5.7.1'),
    { raw: 'Client Version: v1.34.1\nKustomize Version: v5.7.1', major: 1, minor: 34, patch: 1 });
});

test('falls back to a bare vX.Y.Z anywhere in the text', () => {
  assert.deepEqual(K.parseKubectlVersion('something unexpected v1.2.3 trailing'),
    { raw: 'something unexpected v1.2.3 trailing', major: 1, minor: 2, patch: 3 });
});

test('unparseable text reports nulls rather than throwing', () => {
  assert.equal(K.parseKubectlVersion('').major, null);
  assert.equal(K.parseKubectlVersion('not kubectl at all').major, null);
});

test('ecosystem tool list is the documented set', () => {
  for (const name of ['helm', 'k9s', 'stern', 'kubectx', 'kubens', 'kind', 'k3d', 'minikube', 'kustomize']) {
    assert.ok(K.ECOSYSTEM_TOOLS.includes(name), `expected ${name} in ECOSYSTEM_TOOLS`);
  }
});
