import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kuberesources.js'));

/**
 * `kubectl api-resources -o wide` is a tabwriter table, not JSON — read by
 * column position (from the header line), not split on whitespace, because
 * a resource with no shortname leaves that column empty and a naive split
 * would shift every later field left by one. The fixture is built from the
 * exact column offsets a real `kubectl` capture used (NAME=0, SHORTNAMES=36,
 * APIVERSION=89, NAMESPACED=123, KIND=136, VERBS=171, CATEGORIES=232) rather
 * than hand-typed spacing, which is exactly the kind of thing a stray
 * keystroke silently breaks.
 */
const COLS = [['NAME', 0], ['SHORTNAMES', 36], ['APIVERSION', 89], ['NAMESPACED', 123], ['KIND', 136], ['VERBS', 171], ['CATEGORIES', 232]];
const padTo = (s, n) => s.padEnd(Math.max(s.length, n));
const tableRow = (fields) => COLS.reduce((line, [, pos], i) => padTo(line, pos) + fields[i], '');

const SAMPLE = [
  tableRow(COLS.map(([name]) => name)),
  tableRow(['bindings', '', 'v1', 'true', 'Binding', 'create', '']),
  tableRow(['configmaps', 'cm', 'v1', 'true', 'ConfigMap', 'create,delete,deletecollection,get,list,patch,update,watch', '']),
  tableRow(['pods', 'po', 'v1', 'true', 'Pod', 'create,delete,deletecollection,get,list,patch,update,watch', 'all']),
  tableRow(['nodes', 'no', 'v1', 'false', 'Node', 'create,delete,deletecollection,get,list,patch,update,watch', '']),
  tableRow(['ingresses', 'ing', 'networking.k8s.io/v1', 'true', 'Ingress', 'create,delete,deletecollection,get,list,patch,update,watch', '']),
].join('\n');

test('a resource with no shortname is parsed with an empty one, not shifted', () => {
  const types = K.parseApiResources(SAMPLE);
  const bindings = types.find((t) => t.name === 'bindings');
  assert.deepEqual(bindings, {
    name: 'bindings', shortNames: [], apiVersion: 'v1', namespaced: true, kind: 'Binding', verbs: ['create'], categories: [],
  });
});

test('a resource with a shortname and a categories entry reads both correctly', () => {
  const types = K.parseApiResources(SAMPLE);
  const pods = types.find((t) => t.name === 'pods');
  assert.equal(pods.shortNames[0], 'po');
  assert.equal(pods.kind, 'Pod');
  assert.deepEqual(pods.categories, ['all']);
});

test('namespaced is a real boolean, not the string "false"', () => {
  const types = K.parseApiResources(SAMPLE);
  const nodes = types.find((t) => t.name === 'nodes');
  assert.equal(nodes.namespaced, false);
  assert.equal(typeof nodes.namespaced, 'boolean');
});

test('text with no header at all parses to nothing, not a throw', () => {
  assert.deepEqual(K.parseApiResources('garbage\nmore garbage'), []);
  assert.deepEqual(K.parseApiResources(''), []);
});

test('built-in kinds land in their curated category', () => {
  assert.equal(K.categorize({ kind: 'Pod', apiVersion: 'v1' }), 'Workloads');
  assert.equal(K.categorize({ kind: 'Secret', apiVersion: 'v1' }), 'Config');
  assert.equal(K.categorize({ kind: 'Ingress', apiVersion: 'networking.k8s.io/v1' }), 'Network');
  assert.equal(K.categorize({ kind: 'PersistentVolumeClaim', apiVersion: 'v1' }), 'Storage');
  assert.equal(K.categorize({ kind: 'ClusterRole', apiVersion: 'rbac.authorization.k8s.io/v1' }), 'Access Control');
  assert.equal(K.categorize({ kind: 'Namespace', apiVersion: 'v1' }), 'Cluster');
});

test('anything unmatched — every CRD, by construction — is a Custom Resource grouped by its apiGroup', () => {
  assert.equal(K.categorize({ kind: 'Widget', apiVersion: 'example.io/v1alpha1' }), 'Custom Resources: example.io');
  assert.equal(K.categorize({ kind: 'Certificate', apiVersion: 'cert-manager.io/v1' }), 'Custom Resources: cert-manager.io');
});

test('Argo CD and Flux CRDs land in GitOps, keyed on apiGroup rather than Kind name', () => {
  assert.equal(K.categorize({ kind: 'Application', apiVersion: 'argoproj.io/v1alpha1' }), 'GitOps');
  assert.equal(K.categorize({ kind: 'AppProject', apiVersion: 'argoproj.io/v1alpha1' }), 'GitOps');
  assert.equal(K.categorize({ kind: 'Kustomization', apiVersion: 'kustomize.toolkit.fluxcd.io/v1' }), 'GitOps');
  assert.equal(K.categorize({ kind: 'HelmRelease', apiVersion: 'helm.toolkit.fluxcd.io/v2' }), 'GitOps');
  assert.equal(K.categorize({ kind: 'GitRepository', apiVersion: 'source.toolkit.fluxcd.io/v1' }), 'GitOps');
});

test('a Kind name shared with a GitOps CRD does not collide when the apiGroup differs', () => {
  assert.equal(K.categorize({ kind: 'Kustomization', apiVersion: 'example.io/v1' }), 'Custom Resources: example.io');
});

test('a core-group unmatched kind still falls back to the plain bucket', () => {
  assert.equal(K.categorize({ kind: 'SomethingNew', apiVersion: 'v1' }), 'Custom Resources');
});

/**
 * detailOf()/conditionStatus() are the "actionable information" a real
 * Kubernetes Dashboard row shows (ready-pod counts, not a bare status) —
 * shapes below are trimmed real captures from a live EKS and a live GKE
 * cluster, not invented JSON.
 */

test('a Pod with all containers ready and no restarts', () => {
  const pod = { kind: 'Pod', status: { containerStatuses: [{ ready: true, restartCount: 0 }] } };
  assert.equal(K.detailOf('Pod', pod), '1/1 ready');
});

test('a Pod with restarts says so', () => {
  const pod = { kind: 'Pod', status: { containerStatuses: [{ ready: true, restartCount: 29 }] } };
  assert.equal(K.detailOf('Pod', pod), '1/1 ready, 29 restarts');
});

test('a Deployment reads readyReplicas over spec.replicas', () => {
  const dep = { kind: 'Deployment', status: { readyReplicas: 1 }, spec: { replicas: 1 } };
  assert.equal(K.detailOf('Deployment', dep), '1/1 ready');
});

test('a Deployment with zero ready replicas is not mistaken for "no detail"', () => {
  const dep = { kind: 'Deployment', status: {}, spec: { replicas: 3 } };
  assert.equal(K.detailOf('Deployment', dep), '0/3 ready');
});

test('a DaemonSet uses its own ready/desired fields, not Deployment’s', () => {
  const ds = { kind: 'DaemonSet', status: { numberReady: 2, desiredNumberScheduled: 2 } };
  assert.equal(K.detailOf('DaemonSet', ds), '2/2 ready');
});

test('a Node with no role labels (GKE’s default) falls back to "worker"', () => {
  const node = { kind: 'Node', metadata: { labels: {} }, status: { nodeInfo: { kubeletVersion: 'v1.35.8-gke.1796000' } } };
  assert.equal(K.detailOf('Node', node), 'worker · v1.35.8-gke.1796000');
});

test('a Node with role labels names them instead', () => {
  const node = { kind: 'Node', metadata: { labels: { 'node-role.kubernetes.io/control-plane': '' } }, status: { nodeInfo: {} } };
  assert.equal(K.detailOf('Node', node), 'control-plane · ');
});

test('a kind with no special-cased knowledge (every CRD, by construction) gets no detail, not a crash', () => {
  assert.equal(K.detailOf('WidgetThing', {}), '');
});

test('conditionStatus reads the Ready condition specifically, not every condition joined together', () => {
  const node = { status: { conditions: [{ type: 'MemoryPressure', status: 'False' }, { type: 'Ready', status: 'True' }] } };
  assert.equal(K.conditionStatus(node), 'Ready');
});

test('a Ready condition that is False reads as NotReady, not as the string "False"', () => {
  const node = { status: { conditions: [{ type: 'Ready', status: 'False' }] } };
  assert.equal(K.conditionStatus(node), 'NotReady');
});

test('no Ready condition at all falls back to listing whatever conditions exist', () => {
  const obj = { status: { conditions: [{ type: 'Available', status: 'True' }] } };
  assert.equal(K.conditionStatus(obj), 'Available');
});

/**
 * rowFrom() — the per-item shaping getResources() always did inline, now
 * its own function so a watched object (one item, no list around it)
 * turns into the exact same row shape — see kubewatch.js / main.js's
 * kube:watchStart handler.
 */
test('rowFrom gives a watched Pod the same shape a listed one gets', () => {
  const pod = {
    kind: 'Pod',
    metadata: { name: 'web-1', namespace: 'ns', creationTimestamp: '2026-01-01T00:00:00Z' },
    status: { phase: 'Running' },
    spec: { containers: [{ name: 'app' }, { name: 'sidecar' }] },
  };
  const row = K.rowFrom(pod);
  assert.equal(row.name, 'web-1');
  assert.equal(row.namespace, 'ns');
  assert.equal(row.status, 'Running');
  assert.deepEqual(row.containers, ['app', 'sidecar']);
});

test('rowFrom reads an Event\'s own type as its status, and lastTimestamp as its age', () => {
  const ev = {
    kind: 'Event', type: 'Warning',
    metadata: { name: 'e1', namespace: 'ns', creationTimestamp: '2026-01-01T00:00:00Z' },
    lastTimestamp: '2026-01-02T00:00:00Z',
  };
  const row = K.rowFrom(ev);
  assert.equal(row.status, 'Warning');
  assert.equal(row.age, '2026-01-02T00:00:00Z');
});

/**
 * columnsFromCrdObject() — the pure half of crdColumnsFor(), picking the
 * matching version's own additionalPrinterColumns out of a parsed CRD.
 * Fixture shaped exactly like cert-manager's real Certificate CRD.
 */
const certificateCrd = {
  spec: {
    versions: [
      { name: 'v1', additionalPrinterColumns: [
        { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type == "Ready")].status' },
        { name: 'Secret', type: 'string', jsonPath: '.spec.secretName' },
      ] },
      { name: 'v1alpha2', additionalPrinterColumns: [{ name: 'Old', type: 'string', jsonPath: '.spec.old' }] },
    ],
  },
};

test('columnsFromCrdObject picks the version actually in use, not just the first one listed', () => {
  const cols = K.columnsFromCrdObject(certificateCrd, 'v1');
  assert.deepEqual(cols, [
    { label: 'Ready', jsonPath: '.status.conditions[?(@.type == "Ready")].status', type: 'string' },
    { label: 'Secret', jsonPath: '.spec.secretName', type: 'string' },
  ]);
});

test('columnsFromCrdObject falls back to the first version if the exact one is not found', () => {
  assert.deepEqual(K.columnsFromCrdObject(certificateCrd, 'v2-does-not-exist'), [
    { label: 'Ready', jsonPath: '.status.conditions[?(@.type == "Ready")].status', type: 'string' },
    { label: 'Secret', jsonPath: '.spec.secretName', type: 'string' },
  ]);
});

test('a CRD with no additionalPrinterColumns at all gives an empty list, not a throw', () => {
  assert.deepEqual(K.columnsFromCrdObject({ spec: { versions: [{ name: 'v1' }] } }, 'v1'), []);
  assert.deepEqual(K.columnsFromCrdObject({}, 'v1'), []);
});

/** detailOf() — ResourceQuota and LimitRange, for "at a glance" without opening Details. */
test('detailOf reads a ResourceQuota\'s own used/hard numbers, up to three', () => {
  const rq = { status: { hard: { pods: '20', 'requests.cpu': '4', 'requests.memory': '8Gi', 'limits.cpu': '8' }, used: { pods: '12', 'requests.cpu': '2500m' } } };
  assert.equal(K.detailOf('ResourceQuota', rq), '12/20 pods · 2500m/4 requests.cpu · 0/8Gi requests.memory');
});

test('detailOf says so when a ResourceQuota sets no limits at all', () => {
  assert.equal(K.detailOf('ResourceQuota', { status: {} }), 'no limits set');
});

test('detailOf reads a LimitRange\'s first entry', () => {
  const lr = { spec: { limits: [{ type: 'Container', default: { cpu: '500m', memory: '256Mi' } }, { type: 'Pod' }] } };
  assert.equal(K.detailOf('LimitRange', lr), 'Container: cpu 500m, memory 256Mi (+1 more)');
});

test('detailOf falls back to defaultRequest when a LimitRange sets no default', () => {
  const lr = { spec: { limits: [{ type: 'Container', defaultRequest: { cpu: '100m' } }] } };
  assert.equal(K.detailOf('LimitRange', lr), 'Container: cpu 100m');
});

test('detailOf says so when a LimitRange defines nothing', () => {
  assert.equal(K.detailOf('LimitRange', { spec: {} }), 'no limits defined');
});

test('detailOf counts a Role/ClusterRole\'s own rules', () => {
  assert.equal(K.detailOf('Role', { rules: [{}, {}] }), '2 rules');
  assert.equal(K.detailOf('ClusterRole', { rules: [{}] }), '1 rule');
  assert.equal(K.detailOf('Role', {}), '0 rules');
});

test('detailOf reads a RoleBinding/ClusterRoleBinding\'s roleRef and subject count', () => {
  const rb = { roleRef: { kind: 'ClusterRole', name: 'view' }, subjects: [{ kind: 'User', name: 'alice' }, { kind: 'Group', name: 'devs' }] };
  assert.equal(K.detailOf('RoleBinding', rb), 'ClusterRole/view → 2 subjects');
  assert.equal(K.detailOf('ClusterRoleBinding', { roleRef: { kind: 'Role', name: 'x' }, subjects: [{}] }), 'Role/x → 1 subject');
});

test('detailOf reads an Argo CD Application\'s own sync/health status', () => {
  const app = { apiVersion: 'argoproj.io/v1alpha1', status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } } };
  assert.equal(K.detailOf('Application', app), 'Synced, Healthy');
});

test('detailOf falls back to Unknown for an Argo CD Application with no status yet', () => {
  assert.equal(K.detailOf('Application', { apiVersion: 'argoproj.io/v1alpha1' }), 'Unknown, Unknown');
});

test('detailOf reads a Flux kind\'s own Ready condition', () => {
  const ready = { apiVersion: 'kustomize.toolkit.fluxcd.io/v1', status: { conditions: [{ type: 'Ready', status: 'True' }] } };
  assert.equal(K.detailOf('Kustomization', ready), 'Ready');
  const notReady = { apiVersion: 'kustomize.toolkit.fluxcd.io/v1', status: { conditions: [{ type: 'Ready', status: 'False', reason: 'BuildFailed' }] } };
  assert.equal(K.detailOf('Kustomization', notReady), 'Not ready: BuildFailed');
});

test('detailOf says Unknown for a GitOps kind with no Ready condition reported yet', () => {
  assert.equal(K.detailOf('HelmRelease', { apiVersion: 'helm.toolkit.fluxcd.io/v2', status: {} }), 'Unknown');
});

test('detailOf leaves an unrelated CRD alone (empty, same as before)', () => {
  assert.equal(K.detailOf('Widget', { apiVersion: 'example.io/v1alpha1', status: { conditions: [{ type: 'Ready', status: 'True' }] } }), '');
});

test('sampleChecksFromRules takes the first verb/resource from each rule', () => {
  const rules = [{ verbs: ['get', 'list'], resources: ['pods', 'nodes'] }, { verbs: ['create'], resources: ['secrets'] }];
  assert.deepEqual(K.sampleChecksFromRules(rules, 'ns1'), [
    { verb: 'get', resource: 'pods', namespace: 'ns1' },
    { verb: 'create', resource: 'secrets', namespace: 'ns1' },
  ]);
});

test('sampleChecksFromRules turns a wildcard verb/resource into a concrete, askable default', () => {
  assert.deepEqual(K.sampleChecksFromRules([{ verbs: ['*'], resources: ['*'] }], null), [{ verb: 'get', resource: 'pods', namespace: undefined }]);
});

test('sampleChecksFromRules skips a rule with no verb or no resource', () => {
  assert.deepEqual(K.sampleChecksFromRules([{ verbs: [], resources: ['pods'] }, { verbs: ['get'], resources: [] }], 'ns1'), []);
});

test('sampleChecksFromRules caps at 10 rules', () => {
  const rules = Array.from({ length: 15 }, (_, i) => ({ verbs: ['get'], resources: [`r${i}`] }));
  assert.equal(K.sampleChecksFromRules(rules, 'ns1').length, 10);
});

test('sampleChecksFromRules handles no rules at all', () => {
  assert.deepEqual(K.sampleChecksFromRules(undefined, 'ns1'), []);
});
