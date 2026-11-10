import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const O = require_(path.join(__PROJECT_ROOT__, 'src/main/kubeops.js'));
const yaml = require_(path.join(__PROJECT_ROOT__, 'node_modules/js-yaml'));

/** Teleport group → ClusterRole: the binding in the cluster, and the Teleport role that hands out the group. */
test('whole cluster: one ClusterRoleBinding, a Group subject, a ClusterRole ref', () => {
  const r = O.groupBinding({ group: 'viewers', clusterRole: 'view' });
  const [d] = yaml.loadAll(r.yaml);
  assert.equal(d.kind, 'ClusterRoleBinding');
  assert.equal(d.metadata.name, 'teleport-viewers-view');
  assert.deepEqual(d.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' });
  assert.deepEqual(d.subjects, [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'viewers' }]);
});

test('some namespaces: a RoleBinding in each, still granting the ClusterRole only there', () => {
  const r = O.groupBinding({ group: 'developers', clusterRole: 'edit', namespaces: ['dev', 'staging'] });
  const docs = yaml.loadAll(r.yaml);
  assert.deepEqual(docs.map((d) => [d.kind, d.metadata.namespace, d.roleRef.kind, d.roleRef.name]),
    [['RoleBinding', 'dev', 'ClusterRole', 'edit'], ['RoleBinding', 'staging', 'ClusterRole', 'edit']]);
});

test('a group with a space, no group, or no ClusterRole is refused', () => {
  assert.equal(O.groupBinding({ group: 'my devs', clusterRole: 'view' }).ok, false);
  assert.equal(O.groupBinding({ clusterRole: 'view' }).ok, false);
  assert.equal(O.groupBinding({ group: 'devs' }).ok, false);
});

test('the Teleport role names the group under spec.allow.kubernetes_groups, with this cluster\'s labels', () => {
  const r = O.teleportRoleFor({ group: 'developers', clusterLabels: { env: 'dev', 'teleport.internal/resource-id': 'x' }, namespaces: ['dev'] });
  const role = yaml.load(r.yaml);
  assert.equal(role.kind, 'role');
  assert.equal(role.version, 'v8');
  assert.deepEqual(role.spec.allow.kubernetes_groups, ['developers']);
  assert.deepEqual(role.spec.allow.kubernetes_labels, { env: 'dev' });
  assert.deepEqual(role.spec.allow.kubernetes_resources.map((x) => x.namespace), ['dev']);
  assert.equal(r.broadLabels, false);
});

test('with no labels known the role matches every cluster — and says so', () => {
  const r = O.teleportRoleFor({ group: 'viewers' });
  assert.deepEqual(yaml.load(r.yaml).spec.allow.kubernetes_labels, { '*': '*' });
  assert.equal(r.broadLabels, true);
});
