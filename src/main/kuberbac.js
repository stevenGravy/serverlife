'use strict';
/**
 * "Who can do that?" — the reverse of can-i. Given a verb and a resource,
 * walk every RoleBinding/ClusterRoleBinding, resolve its roleRef to the
 * Role/ClusterRole it names, and check that role's own rules the same way
 * the API server would — wildcards in `apiGroups`/`resources`/`verbs`
 * included. Pure: given the four kinds already fetched (kuberesources.js
 * does that), no IO here at all — mirrors kuberelations.js's own split.
 */

/** A rule's own list field: absent/`['*']` matches anything, otherwise the value has to be in it. */
function matchesList(list, value) {
  if (!list || !list.length) return false; // an absent list means "none" for a PolicyRule, not "any"
  return list.includes('*') || list.includes(value);
}

/** Does one PolicyRule allow this verb/resource(/name)? */
function ruleAllows(rule, { verb, resource, apiGroup = '', resourceName } = {}) {
  if (!matchesList(rule.verbs, verb)) return false;
  if (!matchesList(rule.apiGroups, apiGroup)) return false;
  if (!matchesList(rule.resources, resource)) return false;
  if (resourceName && rule.resourceNames?.length && !rule.resourceNames.includes(resourceName)) return false;
  return true;
}

function roleAllows(role, query) {
  return (role.rules || []).some((rule) => ruleAllows(rule, query));
}

/**
 * Every subject some binding grants this verb/resource to, grouped by
 * which binding and role actually grants it — a RoleBinding only ever
 * names a Role in its own namespace or a ClusterRole (never a Role from
 * another namespace), which is why Roles are looked up by namespace+name
 * but ClusterRoles only by name.
 */
function whoCan(query, { roles = [], clusterRoles = [], roleBindings = [], clusterRoleBindings = [] } = {}) {
  const roleKey = (namespace, name) => `${namespace || ''}\u0001${name}`;
  const rolesByKey = new Map(roles.map((r) => [roleKey(r.metadata?.namespace, r.metadata?.name), r]));
  const clusterRolesByName = new Map(clusterRoles.map((r) => [r.metadata?.name, r]));

  const matches = [];
  const consider = (binding, bindingKind) => {
    const ref = binding.roleRef || {};
    const role = ref.kind === 'ClusterRole' ? clusterRolesByName.get(ref.name) : rolesByKey.get(roleKey(binding.metadata?.namespace, ref.name));
    if (!role || !roleAllows(role, query)) return;
    for (const subject of binding.subjects || []) {
      matches.push({
        subject: { kind: subject.kind, name: subject.name, namespace: subject.namespace || null },
        role: { kind: ref.kind, name: ref.name },
        binding: { kind: bindingKind, name: binding.metadata?.name, namespace: binding.metadata?.namespace || null },
      });
    }
  };
  for (const b of roleBindings) consider(b, 'RoleBinding');
  for (const b of clusterRoleBindings) consider(b, 'ClusterRoleBinding');
  return matches;
}

module.exports = { matchesList, ruleAllows, roleAllows, whoCan };
