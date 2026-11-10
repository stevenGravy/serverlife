import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubelint.js'));

/**
 * Only the pure argv shape — running Popeye for real needs a real binary
 * and a real cluster (see the Section 5 verification notes), the same
 * boundary every other kube*.test.mjs keeps.
 */

test('buildArgs scopes to one namespace when given', () => {
  const args = K.buildArgs({ contextName: 'my-ctx' }, { namespace: 'ns1' }, '/tmp/log');
  assert.deepEqual(args, ['--context', 'my-ctx', '-n', 'ns1', '-o', 'json', '--logs', '/tmp/log']);
});

test('buildArgs scans every namespace when none is given', () => {
  const args = K.buildArgs({ contextName: 'my-ctx' }, {}, '/tmp/log');
  assert.deepEqual(args, ['--context', 'my-ctx', '-A', '-o', 'json', '--logs', '/tmp/log']);
});

test('buildArgs omits --context when the spec has none', () => {
  const args = K.buildArgs({}, { namespace: 'ns1' }, '/tmp/log');
  assert.deepEqual(args, ['-n', 'ns1', '-o', 'json', '--logs', '/tmp/log']);
});

test('buildArgs always redirects logs away from stdout, so a JSON parse never sees a stray log line', () => {
  const args = K.buildArgs({}, {}, '/tmp/popeye-xyz.log');
  assert.ok(args.includes('--logs'));
  assert.notEqual(args[args.indexOf('--logs') + 1], 'none');
});
