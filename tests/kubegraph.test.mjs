import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const G = require_(path.join(__PROJECT_ROOT__, 'src/main/kubegraph.js'));

/** A Helm release's manifest as a graph, and as Mermaid — canned YAML, no cluster. */
const MANIFEST = `
---
# Source: web/templates/sa.yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: web }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: web-config }
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec: { selector: { app: web } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: web }
spec:
  rules:
    - http: { paths: [ { path: /, backend: { service: { name: web, port: { number: 80 } } } } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      serviceAccountName: web
      volumes: [ { name: c, configMap: { name: web-config } } ]
      containers:
        - name: web
          envFrom: [ { secretRef: { name: preexisting } } ]
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: web }
spec: { scaleTargetRef: { kind: Deployment, name: web } }
`;

test('a manifest becomes its resources and the references between them', () => {
  const g = G.buildGraph(G.parseManifests(MANIFEST));
  assert.equal(g.nodes.length, 6);
  const has = (from, to, label) => g.edges.some((e) => e.from === from && e.to === to && e.label === label);
  assert.ok(has('Ingress/web', 'Service/web', 'routes'));
  assert.ok(has('Service/web', 'Deployment/web', 'selects'));
  assert.ok(has('Deployment/web', 'ConfigMap/web-config', 'mounts'));
  assert.ok(has('Deployment/web', 'ServiceAccount/web', 'runs as'));
  assert.ok(has('HorizontalPodAutoscaler/web', 'Deployment/web', 'scales'));
  assert.equal(g.edges.length, 5);
});

test('a reference to something the release did not install is listed, not drawn dangling', () => {
  const g = G.buildGraph(G.parseManifests(MANIFEST));
  assert.deepEqual(g.external, ['Secret/preexisting']);
  assert.ok(!g.edges.some((e) => e.to === 'Secret/preexisting'));
});

test('Mermaid: a flowchart with safe ids, every node and every labelled edge', () => {
  const m = G.manifestGraph(MANIFEST, { title: 'Helm release web (default)' }).mermaid;
  assert.match(m, /^---\ntitle: Helm release web \(default\)\n---\nflowchart LR\n/);
  assert.match(m, /n_Ingress_web\["Ingress<br\/><b>web<\/b>"\]/);
  assert.match(m, /n_Ingress_web -->\|routes\| n_Service_web/);
  assert.match(m, /n_Deployment_web -->\|runs as\| n_ServiceAccount_web/);
  assert.match(m, /classDef workload /);
  assert.ok(!/[^\w]n_[^\s["|]*[-./]/.test(m.replace(/\["[^"]*"\]/g, '')), 'ids carry no punctuation');
});

test('columns read left to right: ingress, service, workload, config, rbac', () => {
  const ranks = ['Ingress', 'Service', 'Deployment', 'ConfigMap', 'RoleBinding', 'ClusterRole'].map(G.rankOf);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(G.rankOf('SomeCustomThing'), 6);
});

test('an empty or broken manifest is an empty graph, not a throw', () => {
  assert.deepEqual(G.buildGraph(G.parseManifests('')), { nodes: [], edges: [], external: [] });
  assert.doesNotThrow(() => G.manifestGraph(': : not yaml ['));
});

const MORE = `
apiVersion: v1
kind: Service
metadata: { name: db-headless, labels: { app: db } }
spec: { clusterIP: None, selector: { app: db }, ports: [ { port: 5432 } ] }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db }
spec:
  replicas: 3
  serviceName: db-headless
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      imagePullSecrets: [ { name: regcred } ]
      containers: [ { name: pg, image: docker.io/library/postgres:16 } ]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { storageClassName: gp3, resources: { requests: { storage: 10Gi } } }
---
apiVersion: v1
kind: Secret
metadata: { name: regcred }
type: kubernetes.io/dockerconfigjson
---
apiVersion: v1
kind: Secret
metadata: { name: web-tls }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: web }
spec:
  tls: [ { secretName: web-tls, hosts: [ web.example.com ] } ]
  rules: [ { host: web.example.com, http: { paths: [ { path: /, backend: { service: { name: db-headless, port: { number: 5432 } } } } ] } } ]
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: gw }
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: r }
spec:
  parentRefs: [ { name: gw } ]
  rules: [ { backendRefs: [ { name: db-headless, port: 5432 } ] } ]
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: db }
spec: { selector: { matchLabels: { app: db } } }
`;

test('StatefulSet: its headless Service, a claim-template node per volumeClaimTemplate, pull secrets', () => {
  const g = G.buildGraph(G.parseManifests(MORE));
  const has = (from, to, label) => g.edges.some((e) => e.from === from && e.to === to && e.label === label);
  assert.ok(has('StatefulSet/db', 'Service/db-headless', 'governed by'));
  assert.ok(has('StatefulSet/db', 'PersistentVolumeClaim/data-db-*', 'claims'));
  assert.ok(has('StatefulSet/db', 'Secret/regcred', 'pulls with'));
  assert.ok(has('Service/db-headless', 'StatefulSet/db', 'selects'));
  const pvc = g.nodes.find((n) => n.id === 'PersistentVolumeClaim/data-db-*');
  assert.equal(pvc.detail, 'per replica · 10Gi · gp3');
  // gp3 was not installed by this chart: listed as external, not drawn.
  assert.ok(g.external.includes('StorageClass/gp3'));
});

test('Ingress TLS, Gateway API routes, and a ServiceMonitor are drawn', () => {
  const g = G.buildGraph(G.parseManifests(MORE));
  const has = (from, to, label) => g.edges.some((e) => e.from === from && e.to === to && e.label === label);
  assert.ok(has('Ingress/web', 'Secret/web-tls', 'TLS'));
  assert.ok(has('HTTPRoute/r', 'Service/db-headless', 'routes'));
  assert.ok(has('HTTPRoute/r', 'Gateway/gw', 'attached to'));
  assert.ok(has('ServiceMonitor/db', 'Service/db-headless', 'scrapes'));
});

test('details: replicas and images, a headless service and its ports, ingress hosts', () => {
  const g = G.buildGraph(G.parseManifests(MORE));
  const d = (id) => g.nodes.find((n) => n.id === id).detail;
  assert.equal(d('StatefulSet/db'), '3× postgres:16');
  assert.equal(d('Service/db-headless'), 'headless 5432');
  assert.equal(d('Ingress/web'), 'web.example.com');
  assert.match(G.toMermaid(g), /StatefulSet<br\/><b>db<\/b><br\/><small>3× postgres:16<\/small>/);
});
