import test from 'node:test';
import assert from 'node:assert/strict';
import { inferYamlPath, topLevelKind } from '../src/renderer/js/yamlpath.js';

const MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: app
        image: nginx
`;

function posAfter(text, needle) {
  const i = text.indexOf(needle);
  return i < 0 ? -1 : i + needle.length;
}

test('inferYamlPath finds the immediate parent key of the cursor', () => {
  const pos = posAfter(MANIFEST, 'metadata:\n  ');
  assert.deepEqual(inferYamlPath(MANIFEST, pos), ['metadata']);
});

test('inferYamlPath builds the full nested path, not just the nearest ancestor', () => {
  const pos = posAfter(MANIFEST, 'spec:\n  ');
  assert.deepEqual(inferYamlPath(MANIFEST, pos), ['spec']);
  // Right after typing the dash of a new sequence item — kubectl's own -o
  // yaml aligns the dash with its parent key (`containers:` / `- name:`
  // at the same column), so this is the realistic "about to name the
  // first field of a new item" moment, not the column before the dash.
  const deeper = posAfter(MANIFEST, '    spec:\n      containers:\n      - ');
  assert.deepEqual(inferYamlPath(MANIFEST, deeper), ['spec', 'template', 'spec', 'containers']);
});

test('inferYamlPath treats a list-item key line the same as a plain key line (no array index segment)', () => {
  const pos = posAfter(MANIFEST, '      - name: app\n        ');
  assert.deepEqual(inferYamlPath(MANIFEST, pos), ['spec', 'template', 'spec', 'containers']);
});

test('inferYamlPath returns an empty path at column 0 (top level)', () => {
  assert.deepEqual(inferYamlPath(MANIFEST, 0), []);
});

test('inferYamlPath on an empty document', () => {
  assert.deepEqual(inferYamlPath('', 0), []);
});

test('topLevelKind reads kind and apiVersion from column 0', () => {
  assert.deepEqual(topLevelKind(MANIFEST), { kind: 'Deployment', apiVersion: 'apps/v1' });
});

test('topLevelKind returns null before a kind has been typed at all', () => {
  assert.equal(topLevelKind('apiVersion: v1\n'), null);
  assert.equal(topLevelKind(''), null);
});

test('topLevelKind ignores a nested field that happens to be named kind/apiVersion', () => {
  const text = 'kind: Pod\napiVersion: v1\nspec:\n  kind: not-this-one\n';
  assert.deepEqual(topLevelKind(text), { kind: 'Pod', apiVersion: 'v1' });
});
