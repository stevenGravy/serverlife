import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubeexplain.js'));

/**
 * Only the pure parser — running `kubectl explain` for real needs a real
 * cluster (see the Section 6 verification notes), the same boundary every
 * other kube*.test.mjs keeps. Fixtures below are trimmed, real
 * `kubectl explain <kind> --recursive` output, captured against the live
 * cluster while building this.
 */

const POD_EXCERPT = `KIND:       Pod
VERSION:    v1

DESCRIPTION:
    Pod is a collection of containers that can run on a host.

FIELDS:
  apiVersion\t<string>
  kind\t<string>
  metadata\t<ObjectMeta>
    annotations\t<map[string]string>
    managedFields\t<[]ManagedFieldsEntry>
      apiVersion\t<string>
      manager\t<string>
    name\t<string>
  spec\t<PodSpec>
    containers\t<[]Container> -required-
      image\t<string>
      name\t<string> -required-
    nodeSelector\t<map[string]string>
`;

test('parseExplainFields builds a dotted path per field, nested by indentation', () => {
  const fields = K.parseExplainFields(POD_EXCERPT);
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f.type]));
  assert.equal(byPath.apiVersion, 'string');
  assert.equal(byPath['metadata.annotations'], 'map[string]string');
  assert.equal(byPath['metadata.managedFields.apiVersion'], 'string');
  assert.equal(byPath['metadata.managedFields.manager'], 'string');
  assert.equal(byPath['metadata.name'], 'string');
  assert.equal(byPath['spec.containers.image'], 'string');
  assert.equal(byPath['spec.nodeSelector'], 'map[string]string');
});

test('parseExplainFields pops back out of a nested object correctly (sibling after a deeper child)', () => {
  const fields = K.parseExplainFields(POD_EXCERPT);
  const paths = fields.map((f) => f.path);
  // `spec.nodeSelector` is a sibling of `spec.containers`, not a child of it.
  assert.ok(paths.includes('spec.nodeSelector'));
  assert.ok(!paths.includes('spec.containers.nodeSelector'));
});

test('parseExplainFields ignores a `-required-`/`enum:` annotation line — not a field of its own', () => {
  const withEnum = POD_EXCERPT.replace('name\t<string> -required-', 'name\t<string> -required-\n      enum: A, B, C....');
  const fields = K.parseExplainFields(withEnum);
  assert.ok(!fields.some((f) => f.path.includes('enum')));
});

test('parseExplainFields returns nothing before a FIELDS: header appears at all', () => {
  assert.deepEqual(K.parseExplainFields('KIND: Pod\nVERSION: v1\n'), []);
});

test('parseExplainFields handles empty input', () => {
  assert.deepEqual(K.parseExplainFields(''), []);
  assert.deepEqual(K.parseExplainFields(undefined), []);
});

test('explainFields refuses up front when there is no kind to explain', async () => {
  const r = await K.explainFields({}, {});
  assert.equal(r.ok, false);
  assert.deepEqual(r.fields, []);
});
