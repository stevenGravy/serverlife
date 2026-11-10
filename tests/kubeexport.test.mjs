import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const X = require_(path.join(__PROJECT_ROOT__, 'src/main/kubeexport.js'));
const yaml = require_(path.join(__PROJECT_ROOT__, 'node_modules/js-yaml'));

/** Exports are Kubernetes' own List documents — what kubectl get -o json|yaml writes and kubectl apply -f reads. */
const deployment = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: {
    name: 'web', namespace: 'apps', uid: 'u-1', resourceVersion: '42', generation: 3,
    creationTimestamp: '2026-11-01T00:00:00Z', managedFields: [{ manager: 'kubectl' }],
    labels: { app: 'web' },
    annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}', 'deployment.kubernetes.io/revision': '3', team: 'se' },
    ownerReferences: [{ kind: 'X', name: 'x', uid: 'o' }],
  },
  spec: { replicas: 2 },
  status: { readyReplicas: 2 },
};
const service = {
  apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'apps' },
  spec: { type: 'ClusterIP', clusterIP: '10.0.0.1', clusterIPs: ['10.0.0.1'], ports: [{ port: 80, nodePort: 30000 }] },
};

test('YAML and JSON are a kind: List of full objects, each with its own apiVersion and kind', () => {
  for (const format of ['yaml', 'json']) {
    const text = X.toDocument([deployment, service], format);
    const doc = format === 'json' ? JSON.parse(text) : yaml.load(text);
    assert.equal(doc.apiVersion, 'v1');
    assert.equal(doc.kind, 'List');
    assert.equal(doc.items.length, 2);
    assert.deepEqual(doc.items.map((i) => [i.apiVersion, i.kind, i.metadata.name]), [['apps/v1', 'Deployment', 'web'], ['v1', 'Service', 'web']]);
  }
});

test('YAML has no anchors or aliases — every object stands on its own, as kubectl writes it', () => {
  const shared = { app: 'web' };
  const text = X.toDocument([{ ...deployment, metadata: { ...deployment.metadata, labels: shared }, spec: { selector: { matchLabels: shared } } }], 'yaml');
  assert.ok(!/[&*]ref_/.test(text));
});

test('ready to apply: server-set fields gone, what the object says about itself kept', () => {
  const c = X.cleanObject(deployment);
  assert.equal(c.status, undefined);
  for (const k of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields']) assert.equal(c.metadata[k], undefined, k);
  assert.equal(c.metadata.ownerReferences, undefined);
  assert.deepEqual(c.metadata.annotations, { team: 'se' });
  assert.deepEqual(c.metadata.labels, { app: 'web' });
  assert.equal(c.spec.replicas, 2);
  // The original is not touched.
  assert.equal(deployment.metadata.uid, 'u-1');
});

test('ready to apply: a Service loses the addresses the cluster gave it', () => {
  const c = X.cleanObject(service);
  assert.equal(c.spec.clusterIP, undefined);
  assert.equal(c.spec.clusterIPs, undefined);
  assert.equal(c.spec.ports[0].nodePort, undefined);
  const np = X.cleanObject({ ...service, spec: { ...service.spec, type: 'NodePort', ports: [{ port: 80, nodePort: 30000 }] } });
  assert.equal(np.spec.ports[0].nodePort, 30000);
});

test('an unknown format or no kind is refused before kubectl is asked anything', async () => {
  assert.equal((await X.exportResources({}, { kind: 'pods', format: 'xml' })).ok, false);
  assert.equal((await X.exportResources({}, { format: 'yaml' })).ok, false);
});

test('ready to apply, for a Pod: no node, no injected token volume, no debug containers, no generateName', () => {
  const pod = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'web-abc12', generateName: 'web-', namespace: 'apps', ownerReferences: [{ kind: 'ReplicaSet', name: 'web-7d9', controller: true }] },
    spec: {
      nodeName: 'node-a',
      volumes: [{ name: 'data', configMap: { name: 'cfg' } }, { name: 'kube-api-access-x7k2p', projected: { sources: [] } }],
      containers: [{ name: 'web', image: 'nginx', volumeMounts: [{ name: 'data', mountPath: '/d' }, { name: 'kube-api-access-x7k2p', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount' }] }],
      ephemeralContainers: [{ name: 'debugger', image: 'busybox' }],
    },
  };
  const c = X.cleanObject(pod);
  assert.equal(c.spec.nodeName, undefined);
  assert.equal(c.spec.ephemeralContainers, undefined);
  assert.equal(c.metadata.generateName, undefined);
  assert.deepEqual(c.spec.volumes.map((v) => v.name), ['data']);
  assert.deepEqual(c.spec.containers[0].volumeMounts.map((m) => m.name), ['data']);
  // A volume of the user's own that only looks similar is left alone.
  const own = X.cleanObject({ ...pod, spec: { ...pod.spec, volumes: [{ name: 'kube-api-access-mine', secret: { secretName: 's' } }] } });
  assert.deepEqual(own.spec.volumes.map((v) => v.name), ['kube-api-access-mine']);
  assert.equal(X.controllerOf(pod), 'ReplicaSet/web-7d9');
  assert.equal(X.controllerOf({ metadata: {} }), null);
});

/** kubectl's failures said in a sentence — never a Go panic or a klog line on screen. */
const B = require_(path.join(__PROJECT_ROOT__, 'src/main/kubebin.js'));

test('a kubectl panic, or a bare Forbidden: unknown, reads as "no access yet"', () => {
  const panic = 'E1109 15:24:13.075244 72452 memcache.go:265] "Unhandled Error" err="couldn\'t get current server API group list: unknown"\npanic: runtime error: index out of range [0] with length 0\ngoroutine 1 [running]:\nk8s.io/kubectl/pkg/cmd/apiresources.(*APIResourceOptions).RunAPIResources(0x1400095e180)';
  assert.equal(B.humanizeKubectlError(panic), B.NO_ACCESS);
  assert.equal(B.humanizeKubectlError('Error from server (Forbidden): unknown'), B.NO_ACCESS);
  assert.ok(!/goroutine|panic|memcache/.test(B.humanizeKubectlError(panic)));
});

test('a specific refusal keeps what was refused, in plain words', () => {
  assert.equal(B.humanizeKubectlError('Error from server (Forbidden): pods is forbidden: User "x" cannot list resource "pods" in API group "" in the namespace "kube-system"'),
    "Not allowed: your role can't list pods in kube-system.");
  assert.equal(B.humanizeKubectlError('Error from server (Forbidden): nodes is forbidden: User "x" cannot list resource "nodes" in API group "" at the cluster scope'),
    "Not allowed: your role can't list nodes.");
});

test('unreachable, not found, and anything else: no log prefixes, no stack, no "error:"', () => {
  assert.match(B.humanizeKubectlError('E1109 1 memcache.go:265] x\nUnable to connect to the server: dial tcp 127.0.0.1:52596: connect: connection refused'), /^Can't reach the cluster/);
  assert.equal(B.humanizeKubectlError('Error from server (NotFound): pods "web-1" not found'), 'NotFound: pods "web-1" not found');
  assert.equal(B.humanizeKubectlError('error: the server doesn\'t have a resource type "widgets"'), 'the server doesn\'t have a resource type "widgets"');
});

test('explainMissing marks a no-access failure, and keeps the raw text for anyone who needs it', () => {
  const r = B.explainMissing({ ok: false, stderr: 'Error from server (Forbidden): unknown', err: {} });
  assert.equal(r.noAccess, true);
  assert.equal(r.rawStderr, 'Error from server (Forbidden): unknown');
  assert.equal(B.explainMissing({ ok: true, stdout: 'x' }).stdout, 'x');
});
