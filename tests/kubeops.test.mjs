import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubeops.js'));
const yaml = require_('js-yaml');

/** Validation and manifest generation — no live cluster needed, same spirit as kubescan's own tests. */

test('scale refuses a non-integer or negative replica count before touching kubectl', async () => {
  assert.equal((await K.scale({}, { replicas: 'three' })).ok, false);
  assert.equal((await K.scale({}, { replicas: -1 })).ok, false);
  assert.equal((await K.scale({}, { replicas: 1.5 })).ok, false);
});

test('rollout refuses an action kubectl does not have', async () => {
  const r = await K.rollout({}, { action: 'cancel', resource: 'deployments', name: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown rollout action/);
});

test('setImage needs both a container and an image', async () => {
  assert.equal((await K.setImage({}, { container: 'app' })).ok, false);
  assert.equal((await K.setImage({}, { image: 'nginx' })).ok, false);
});

test('setEnv with nothing to set or remove is a no-op error, not a bare kubectl call', async () => {
  const r = await K.setEnv({}, { set: {}, unset: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /No variables/);
});

test('setResources needs requests, limits, or both', async () => {
  assert.equal((await K.setResources({}, {})).ok, false);
});

test('cronTrigger rejects an explicit job name that is not a valid DNS label', async () => {
  const r = await K.cronTrigger({}, { name: 'nightly', jobName: 'Not Valid!' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a valid job name/);
});

test('deleteMany with nothing selected is refused before building a kubectl argv', async () => {
  const r = await K.deleteMany({}, { resource: 'pods', names: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /Nothing selected/);
});

test('manifestFor builds a Deployment with the given replicas, image and env', () => {
  const r = K.manifestFor('Deployment', { name: 'web', namespace: 'ns1', image: 'nginx:1.27', replicas: '3', port: '8080', env: 'LOG_LEVEL=debug' });
  assert.equal(r.ok, true);
  const doc = yaml.load(r.yaml);
  assert.equal(doc.kind, 'Deployment');
  assert.equal(doc.spec.replicas, 3);
  assert.equal(doc.spec.template.spec.containers[0].image, 'nginx:1.27');
  assert.equal(doc.spec.template.spec.containers[0].ports[0].containerPort, 8080);
  assert.deepEqual(doc.spec.template.spec.containers[0].env, [{ name: 'LOG_LEVEL', value: 'debug' }]);
});

test('manifestFor refuses a Deployment with no image', () => {
  const r = K.manifestFor('Deployment', { name: 'web' });
  assert.equal(r.ok, false);
  assert.match(r.error, /needs an image/);
});

test('manifestFor refuses a name that is not a valid DNS label', () => {
  const r = K.manifestFor('ConfigMap', { name: 'Not Valid', data: 'a=b' });
  assert.equal(r.ok, false);
});

test('manifestFor builds a Service, defaulting its selector to app=<name>', () => {
  const r = K.manifestFor('Service', { name: 'web', port: '80' });
  assert.equal(r.ok, true);
  const doc = yaml.load(r.yaml);
  assert.deepEqual(doc.spec.selector, { app: 'web' });
  assert.equal(doc.spec.ports[0].targetPort, 80);
});

test('manifestFor builds a ConfigMap from one KEY=value per line', () => {
  const r = K.manifestFor('ConfigMap', { name: 'cfg', data: 'A=1\nB=2' });
  assert.equal(r.ok, true);
  const doc = yaml.load(r.yaml);
  assert.deepEqual(doc.data, { A: '1', B: '2' });
});

test('manifestFor builds a Secret as stringData, never base64 in the form itself', () => {
  const r = K.manifestFor('Secret', { name: 'creds', data: 'PASSWORD=hunter2' });
  assert.equal(r.ok, true);
  const doc = yaml.load(r.yaml);
  assert.deepEqual(doc.stringData, { PASSWORD: 'hunter2' });
  assert.equal(doc.data, undefined);
});

test('manifestFor has no form for a kind it does not know', () => {
  const r = K.manifestFor('Pod', { name: 'x' });
  assert.equal(r.ok, false);
});

test('parseRules reads the VERBS | APIGROUPS | RESOURCES mini-syntax a preset or a hand-written line both use', () => {
  assert.deepEqual(K.parseRules('get,list,watch | | pods,pods/log'), [
    { verbs: ['get', 'list', 'watch'], apiGroups: [''], resources: ['pods', 'pods/log'] },
  ]);
});

test('parseRules keeps a blank apiGroups segment as the core group, not an empty (matches-nothing) list', () => {
  const [rule] = K.parseRules('get | | pods');
  assert.deepEqual(rule.apiGroups, ['']);
});

test('parseRules reads several groups from one segment, for resources split across them', () => {
  const [rule] = K.parseRules('get,list | apps, | deployments,pods');
  assert.deepEqual(rule.apiGroups, ['apps', '']);
});

test('parseRules reads several lines as several rules, and drops a line with no verbs or resources', () => {
  const rules = K.parseRules('get | | pods\ncreate,get | | pods/exec\n   \nnoverbshere | | ');
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[1].resources, ['pods/exec']);
});

test('parseSubjects reads KIND:name, defaulting to User', () => {
  assert.deepEqual(K.parseSubjects('User:alice\nGroup:devs', 'ns1'), [
    { kind: 'User', name: 'alice' }, { kind: 'Group', name: 'devs' },
  ]);
  assert.deepEqual(K.parseSubjects('bare-name', 'ns1'), [{ kind: 'User', name: 'bare-name' }]);
});

test('parseSubjects gives a ServiceAccount its namespace, explicit or the binding\'s own', () => {
  assert.deepEqual(K.parseSubjects('ServiceAccount:ci-bot:other-ns', 'ns1'), [{ kind: 'ServiceAccount', name: 'ci-bot', namespace: 'other-ns' }]);
  assert.deepEqual(K.parseSubjects('ServiceAccount:ci-bot', 'ns1'), [{ kind: 'ServiceAccount', name: 'ci-bot', namespace: 'ns1' }]);
});

test('manifestFor builds a Role with real rules from the mini-syntax', () => {
  const r = K.manifestFor('Role', { name: 'pod-reader', namespace: 'ns1', rules: 'get,list,watch | | pods' });
  assert.equal(r.ok, true);
  const doc = yaml.load(r.yaml);
  assert.equal(doc.kind, 'Role');
  assert.equal(doc.metadata.namespace, 'ns1');
  assert.deepEqual(doc.rules, [{ verbs: ['get', 'list', 'watch'], apiGroups: [''], resources: ['pods'] }]);
});

test('manifestFor builds a ClusterRole with no namespace at all', () => {
  const r = K.manifestFor('ClusterRole', { name: 'viewer', rules: 'get | | pods' });
  assert.equal(r.ok, true);
  const doc = yaml.load(r.yaml);
  assert.equal(doc.kind, 'ClusterRole');
  assert.equal(doc.metadata.namespace, undefined);
});

test('manifestFor refuses a Role with no usable rules', () => {
  const r = K.manifestFor('Role', { name: 'empty', rules: '' });
  assert.equal(r.ok, false);
});

test('manifestFor builds a RoleBinding with its roleRef and subjects', () => {
  const r = K.manifestFor('RoleBinding', {
    name: 'read-pods', namespace: 'ns1', roleRefKind: 'Role', roleRefName: 'pod-reader',
    subjects: 'ServiceAccount:ci-bot',
  });
  assert.equal(r.ok, true);
  const doc = yaml.load(r.yaml);
  assert.deepEqual(doc.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'pod-reader' });
  assert.deepEqual(doc.subjects, [{ kind: 'ServiceAccount', name: 'ci-bot', namespace: 'ns1' }]);
});

test('manifestFor refuses a RoleBinding with no role to bind, or no subjects', () => {
  assert.equal(K.manifestFor('RoleBinding', { name: 'x', namespace: 'ns1', subjects: 'User:alice' }).ok, false);
  assert.equal(K.manifestFor('RoleBinding', { name: 'x', namespace: 'ns1', roleRefName: 'y', subjects: '' }).ok, false);
});

test('manifestFor refuses a ClusterRoleBinding that tries to bind a namespaced Role — the API server would refuse it too', () => {
  const r = K.manifestFor('ClusterRoleBinding', { name: 'x', roleRefKind: 'Role', roleRefName: 'y', subjects: 'User:alice' });
  assert.equal(r.ok, false);
});

test('manifestFor builds a ClusterRoleBinding to a real ClusterRole', () => {
  const r = K.manifestFor('ClusterRoleBinding', { name: 'admins', roleRefKind: 'ClusterRole', roleRefName: 'cluster-admin', subjects: 'Group:platform-team' });
  assert.equal(r.ok, true);
  const doc = yaml.load(r.yaml);
  assert.equal(doc.metadata.namespace, undefined);
  assert.deepEqual(doc.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' });
});
