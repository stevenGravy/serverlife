import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubetest.js'));

/**
 * Only the pure parts — running the test pod for real needs a real
 * cluster (see the Section 5 follow-up verification notes), the same
 * boundary every other kube*.test.mjs keeps.
 */

test('buildSelfCheckScript includes one curl per check, each preceded by its own marker', () => {
  const script = K.buildSelfCheckScript([{ verb: 'get', resource: 'pods', namespace: 'ns1' }, { verb: 'list', resource: 'secrets' }]);
  assert.match(script, /CHECK get pods/);
  assert.match(script, /CHECK list secrets/);
  assert.equal(script.match(/curl/g).length, 2);
  assert.match(script, /\/var\/run\/secrets\/kubernetes\.io\/serviceaccount\/token/);
  assert.match(script, /kubernetes\.default\.svc/);
});

test('buildSelfCheckScript embeds a correctly-shaped SelfSubjectAccessReview body', () => {
  const script = K.buildSelfCheckScript([{ verb: 'delete', resource: 'pods', namespace: 'ns1' }]);
  assert.match(script, /"kind":"SelfSubjectAccessReview"/);
  assert.match(script, /"verb":"delete"/);
  assert.match(script, /"resource":"pods"/);
  assert.match(script, /"namespace":"ns1"/);
});

test('buildSelfCheckScript defaults a missing namespace to empty (cluster-scoped check)', () => {
  const script = K.buildSelfCheckScript([{ verb: 'get', resource: 'nodes' }]);
  assert.match(script, /"namespace":""/);
});

test('buildSelfCheckScript shell-escapes a value containing a single quote, rather than breaking out of the quoted string', () => {
  const script = K.buildSelfCheckScript([{ verb: "ge't", resource: 'pods' }]);
  // The script must remain syntactically sound shell: every curl -d argument stays a single shell word.
  assert.doesNotThrow(() => { if (!script.includes("'\\''")) throw new Error('not escaped'); });
});

test('buildSelfCheckScript with no checks still emits the token/cacert/api setup', () => {
  const script = K.buildSelfCheckScript([]);
  assert.match(script, /TOKEN=/);
  assert.match(script, /CACERT=/);
  assert.match(script, /API=/);
  assert.doesNotMatch(script, /CHECK/);
});

test('parseCheckResults matches each CHECK marker to the allowed field that follows it', () => {
  const checks = [{ verb: 'get', resource: 'pods' }, { verb: 'delete', resource: 'secrets' }];
  const output = [
    'CHECK get pods',
    '{"status":{"allowed":true}}',
    '',
    'CHECK delete secrets',
    '{"status":{"allowed":false,"reason":"no matching rule"}}',
    '',
  ].join('\n');
  assert.deepEqual(K.parseCheckResults(output, checks), [
    { verb: 'get', resource: 'pods', allowed: true, error: null },
    { verb: 'delete', resource: 'secrets', allowed: false, error: null },
  ]);
});

test('parseCheckResults captures a message when there is no allowed field at all (e.g. a curl/API error)', () => {
  const checks = [{ verb: 'get', resource: 'pods' }];
  const output = 'CHECK get pods\n{"message":"connection refused"}\n';
  const result = K.parseCheckResults(output, checks);
  assert.equal(result[0].allowed, null);
  assert.equal(result[0].error, 'connection refused');
});

test('parseCheckResults leaves a check unresolved (allowed: null) when its marker never appears', () => {
  const result = K.parseCheckResults('', [{ verb: 'get', resource: 'pods' }]);
  assert.deepEqual(result, [{ verb: 'get', resource: 'pods', allowed: null, error: null }]);
});

test('parseCheckResults handles two checks for the same verb/resource independently', () => {
  const checks = [{ verb: 'get', resource: 'pods' }, { verb: 'get', resource: 'pods' }];
  const output = ['CHECK get pods', '{"status":{"allowed":true}}', 'CHECK get pods', '{"status":{"allowed":false}}'].join('\n');
  assert.deepEqual(K.parseCheckResults(output, checks), [
    { verb: 'get', resource: 'pods', allowed: true, error: null },
    { verb: 'get', resource: 'pods', allowed: false, error: null },
  ]);
});

test('testServiceAccountAccess refuses up front when there is no namespace or ServiceAccount', async () => {
  const r1 = await K.testServiceAccountAccess({}, { namespace: '', serviceAccountName: 'sa1', checks: [{ verb: 'get', resource: 'pods' }] });
  assert.equal(r1.ok, false);
  const r2 = await K.testServiceAccountAccess({}, { namespace: 'ns1', serviceAccountName: '', checks: [{ verb: 'get', resource: 'pods' }] });
  assert.equal(r2.ok, false);
});

test('testServiceAccountAccess refuses up front when there is nothing to check', async () => {
  const r = await K.testServiceAccountAccess({}, { namespace: 'ns1', serviceAccountName: 'sa1', checks: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing to check/i);
});
