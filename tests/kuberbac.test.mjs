import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kuberbac.js'));

test('ruleAllows matches an exact verb/apiGroup/resource', () => {
  const rule = { verbs: ['get', 'list'], apiGroups: [''], resources: ['pods'] };
  assert.equal(K.ruleAllows(rule, { verb: 'get', resource: 'pods', apiGroup: '' }), true);
  assert.equal(K.ruleAllows(rule, { verb: 'delete', resource: 'pods', apiGroup: '' }), false);
  assert.equal(K.ruleAllows(rule, { verb: 'get', resource: 'secrets', apiGroup: '' }), false);
});

test('ruleAllows treats "*" as a wildcard in any of the three lists', () => {
  assert.equal(K.ruleAllows({ verbs: ['*'], apiGroups: [''], resources: ['pods'] }, { verb: 'delete', resource: 'pods', apiGroup: '' }), true);
  assert.equal(K.ruleAllows({ verbs: ['get'], apiGroups: ['*'], resources: ['pods'] }, { verb: 'get', resource: 'pods', apiGroup: 'apps' }), true);
  assert.equal(K.ruleAllows({ verbs: ['get'], apiGroups: [''], resources: ['*'] }, { verb: 'get', resource: 'secrets', apiGroup: '' }), true);
});

test('ruleAllows restricts to resourceNames when the rule names any', () => {
  const rule = { verbs: ['get'], apiGroups: [''], resources: ['secrets'], resourceNames: ['db-creds'] };
  assert.equal(K.ruleAllows(rule, { verb: 'get', resource: 'secrets', apiGroup: '', resourceName: 'db-creds' }), true);
  assert.equal(K.ruleAllows(rule, { verb: 'get', resource: 'secrets', apiGroup: '', resourceName: 'other-secret' }), false);
  // Asking without naming one at all is answered on the rule's own terms — it still applies to *a* secret.
  assert.equal(K.ruleAllows(rule, { verb: 'get', resource: 'secrets', apiGroup: '' }), true);
});

test('ruleAllows: an empty verbs/apiGroups/resources list grants nothing, not everything', () => {
  assert.equal(K.ruleAllows({ verbs: [], apiGroups: [''], resources: ['pods'] }, { verb: 'get', resource: 'pods', apiGroup: '' }), false);
});

test('roleAllows is true if any one of several rules matches', () => {
  const role = { rules: [
    { verbs: ['get'], apiGroups: [''], resources: ['configmaps'] },
    { verbs: ['get', 'list'], apiGroups: [''], resources: ['pods'] },
  ] };
  assert.equal(K.roleAllows(role, { verb: 'list', resource: 'pods', apiGroup: '' }), true);
  assert.equal(K.roleAllows(role, { verb: 'delete', resource: 'pods', apiGroup: '' }), false);
});

/**
 * whoCan() — a real-shaped fixture: a RoleBinding naming a namespaced
 * Role, and a ClusterRoleBinding naming a ClusterRole, each with subjects.
 */
const fixture = {
  roles: [{
    metadata: { name: 'pod-reader', namespace: 'ns1' },
    rules: [{ verbs: ['get', 'list', 'watch'], apiGroups: [''], resources: ['pods'] }],
  }],
  clusterRoles: [{
    metadata: { name: 'cluster-admin-ish' },
    rules: [{ verbs: ['*'], apiGroups: ['*'], resources: ['*'] }],
  }],
  roleBindings: [{
    metadata: { name: 'read-pods', namespace: 'ns1' },
    roleRef: { kind: 'Role', name: 'pod-reader' },
    subjects: [{ kind: 'ServiceAccount', name: 'ci-bot', namespace: 'ns1' }],
  }],
  clusterRoleBindings: [{
    metadata: { name: 'admins' },
    roleRef: { kind: 'ClusterRole', name: 'cluster-admin-ish' },
    subjects: [{ kind: 'Group', name: 'platform-team' }],
  }],
};

test('whoCan finds the subject bound through a namespaced RoleBinding', () => {
  const matches = K.whoCan({ verb: 'get', resource: 'pods', apiGroup: '' }, fixture);
  const sa = matches.find((m) => m.subject.kind === 'ServiceAccount');
  assert.ok(sa, 'expected the ci-bot ServiceAccount to show up');
  assert.deepEqual(sa.subject, { kind: 'ServiceAccount', name: 'ci-bot', namespace: 'ns1' });
  assert.deepEqual(sa.binding, { kind: 'RoleBinding', name: 'read-pods', namespace: 'ns1' });
});

test('whoCan finds the subject bound through a ClusterRoleBinding, for any resource', () => {
  const matches = K.whoCan({ verb: 'delete', resource: 'secrets', apiGroup: '' }, fixture);
  const group = matches.find((m) => m.subject.kind === 'Group');
  assert.ok(group, 'expected the platform-team group to show up (cluster-admin-ish grants everything)');
  assert.equal(group.binding.kind, 'ClusterRoleBinding');
});

test('whoCan finds nothing for a verb/resource no rule actually grants', () => {
  // ci-bot's Role only grants get/list/watch on pods — not delete.
  const matches = K.whoCan({ verb: 'delete', resource: 'pods', apiGroup: '' }, fixture).filter((m) => m.subject.kind === 'ServiceAccount');
  assert.deepEqual(matches, []);
});

test('whoCan never confuses a Role in one namespace for the same name in another', () => {
  const twoNamespaces = {
    ...fixture,
    roles: [...fixture.roles, { metadata: { name: 'pod-reader', namespace: 'ns2' }, rules: [{ verbs: ['delete'], apiGroups: [''], resources: ['pods'] }] }],
    roleBindings: [...fixture.roleBindings, {
      metadata: { name: 'other', namespace: 'ns2' }, roleRef: { kind: 'Role', name: 'pod-reader' },
      subjects: [{ kind: 'User', name: 'alice' }],
    }],
  };
  // alice's binding is in ns2, whose pod-reader grants delete — not ns1's, which only grants get/list/watch.
  const matches = K.whoCan({ verb: 'delete', resource: 'pods', apiGroup: '' }, twoNamespaces);
  assert.ok(matches.some((m) => m.subject.name === 'alice'));
  assert.ok(!matches.some((m) => m.subject.name === 'ci-bot'));
});

test('whoCan with nothing fetched at all returns no matches, not a throw', () => {
  assert.deepEqual(K.whoCan({ verb: 'get', resource: 'pods' }, {}), []);
});
