import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubescan.js'));

/** Reshaping kube.js's pod rows into kube3d.js's namespace/pod scene — no live cluster needed. */

test('pods group into their namespace, sorted, with a count', () => {
  const scene = K.buildScene({ pods: [
    { name: 'b-pod', namespace: 'ns2', phase: 'Running', ready: 1, total: 1, restarts: 0, containers: ['c1'], node: 'n1' },
    { name: 'a-pod', namespace: 'ns1', phase: 'Running', ready: 1, total: 1, restarts: 0, containers: ['c1'], node: 'n1' },
    { name: 'c-pod', namespace: 'ns1', phase: 'Pending', ready: 0, total: 1, restarts: 0, containers: ['c1'], node: 'n1' },
  ] });
  assert.equal(scene.podCount, 3);
  assert.deepEqual(scene.namespaces.map((n) => n.name), ['ns1', 'ns2']);
  assert.deepEqual(scene.namespaces[0].pods.map((p) => p.name), ['a-pod', 'c-pod']);
  assert.equal(scene.namespaces[0].podCount, 2);
});

test('a pod with no namespace field lands in "default" rather than being dropped', () => {
  const scene = K.buildScene({ pods: [{ name: 'x', namespace: '', phase: 'Running', containers: [] }] });
  assert.equal(scene.namespaces[0].name, 'default');
});

test('height grows with restarts and container count, never past a sane cap from restarts alone', () => {
  const quiet = K.heightOf({ phase: 'Running', total: 1, restarts: 0 });
  const flaky = K.heightOf({ phase: 'Running', total: 1, restarts: 500 });
  assert.ok(flaky > quiet);
  assert.ok(flaky - quiet <= 3.1); // restarts are capped at 10 * 0.3 in the weighting
});

test('a pod with no containers array still gets a footprint of at least 1', () => {
  assert.equal(K.footprintOf({ phase: 'Running' }), 1);
});

test('no pods at all is an empty scene, not a throw', () => {
  assert.deepEqual(K.buildScene({}), { namespaces: [], podCount: 0 });
  assert.deepEqual(K.buildScene(), { namespaces: [], podCount: 0 });
});

test('deployments and services land in their namespace, sorted, beside its pods', () => {
  const scene = K.buildScene({
    pods: [{ name: 'web-1', namespace: 'app', phase: 'Running', containers: ['c'] }],
    deployments: [
      { name: 'web', namespace: 'app', detail: '2/3 ready' },
      { name: 'api', namespace: 'app', detail: '1/1 ready' },
    ],
    services: [{ name: 'web-svc', namespace: 'app', detail: 'ClusterIP' }],
  });
  const ns = scene.namespaces[0];
  assert.deepEqual(ns.deployments, [{ name: 'api', ready: 1, desired: 1 }, { name: 'web', ready: 2, desired: 3 }]);
  assert.deepEqual(ns.services, [{ name: 'web-svc', detail: 'ClusterIP' }]);
  // Pods alone are counted — a namespace's buildings, not its every shape.
  assert.equal(ns.podCount, 1);
  assert.equal(scene.podCount, 1);
});

test('a namespace with only a deployment still becomes a district', () => {
  const scene = K.buildScene({ deployments: [{ name: 'idle', namespace: 'quiet', detail: '0/0 ready' }] });
  assert.deepEqual(scene.namespaces.map((n) => n.name), ['quiet']);
  assert.equal(scene.namespaces[0].podCount, 0);
});

test('readyRatioOf reads "n/m ready", and anything else as 0/0 rather than a guess', () => {
  assert.deepEqual(K.readyRatioOf('3/3 ready'), { ready: 3, desired: 3 });
  assert.deepEqual(K.readyRatioOf('0/2 ready · cpu 1m'), { ready: 0, desired: 2 });
  assert.deepEqual(K.readyRatioOf('Running'), { ready: 0, desired: 0 });
  assert.deepEqual(K.readyRatioOf(undefined), { ready: 0, desired: 0 });
});

test('arrows: Service → Deployment → its pods, and Service → a pod nobody owns', () => {
  const scene = K.buildScene({
    pods: [
      { name: 'web-1', namespace: 'app', labels: { app: 'web', tier: 'fe' } },
      { name: 'web-2', namespace: 'app', labels: { app: 'web', tier: 'fe' } },
      { name: 'db-0', namespace: 'app', labels: { app: 'db' } },
      { name: 'stray', namespace: 'app', labels: { app: 'other' } },
    ],
    deployments: [{ name: 'web', namespace: 'app', selectorLabels: { app: 'web' } }],
    services: [
      { name: 'web-svc', namespace: 'app', selectorLabels: { app: 'web' } },
      { name: 'db-svc', namespace: 'app', selectorLabels: { app: 'db' } },
    ],
  });
  assert.deepEqual(scene.namespaces[0].links, [
    { from: 'Deployment/web', to: 'Pod/web-1' },
    { from: 'Deployment/web', to: 'Pod/web-2' },
    { from: 'Service/web-svc', to: 'Deployment/web' },
    { from: 'Service/db-svc', to: 'Pod/db-0' },
  ]);
});

test('a selector never crosses a namespace, and an empty one selects nothing', () => {
  const scene = K.buildScene({
    pods: [{ name: 'a', namespace: 'one', labels: { app: 'x' } }, { name: 'b', namespace: 'two', labels: { app: 'x' } }],
    services: [
      { name: 's', namespace: 'one', selectorLabels: { app: 'x' } },
      { name: 'manual', namespace: 'two', selectorLabels: {} },
    ],
  });
  assert.deepEqual(scene.namespaces.find((n) => n.name === 'one').links, [{ from: 'Service/s', to: 'Pod/a' }]);
  assert.deepEqual(scene.namespaces.find((n) => n.name === 'two').links, []);
  assert.equal(K.selects({ app: 'x', tier: 'fe' }, { app: 'x' }), false);
});
