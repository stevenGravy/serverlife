'use strict';
/**
 * A set of Kubernetes manifests as a graph — what a Helm release actually
 * installs and how the pieces point at each other — and that graph as
 * Mermaid. Pure and IO-free like kubescan.js: the manifest comes from
 * kubehelm.js's getManifest() (`helm get manifest`), so this is testable
 * against canned YAML with no cluster.
 *
 * The edges are the references Kubernetes itself follows, read from the
 * fields that make them, not guessed from names:
 *   Ingress → Service              spec.rules[].http.paths[].backend, defaultBackend
 *   Service → workload             spec.selector against the pod template's labels
 *   workload → ConfigMap/Secret    volumes, env[].valueFrom, envFrom
 *   workload → PVC                 volumes[].persistentVolumeClaim
 *   workload → ServiceAccount      serviceAccountName
 *   (Cluster)RoleBinding → Role / ServiceAccount     roleRef, subjects
 *   HPA → its target               spec.scaleTargetRef
 *   PDB / NetworkPolicy → workload selector against the pod template's labels
 */
const yaml = require('js-yaml');

const WORKLOADS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob', 'Pod'];

/** Every document in a multi-doc YAML string, skipping the empty ones `---` leaves between. */
function parseManifests(text) {
  const out = [];
  try {
    yaml.loadAll(String(text || ''), (doc) => { if (doc && doc.kind && doc.metadata?.name) out.push(doc); });
  } catch { /* a document that will not parse leaves the ones before it */ }
  // A List (kubectl get -o yaml) is its items.
  return out.flatMap((d) => (d.kind === 'List' ? (d.items || []) : [d])).filter((d) => d?.kind && d.metadata?.name);
}

/** The pod spec and pod labels of anything that runs pods, whatever its nesting. */
function podTemplateOf(doc) {
  if (doc.kind === 'Pod') return { spec: doc.spec || {}, labels: doc.metadata?.labels || {} };
  if (doc.kind === 'CronJob') {
    const t = doc.spec?.jobTemplate?.spec?.template || {};
    return { spec: t.spec || {}, labels: t.metadata?.labels || {} };
  }
  const t = doc.spec?.template || {};
  return { spec: t.spec || {}, labels: t.metadata?.labels || {} };
}

function matchLabelsOf(selector) {
  if (!selector) return {};
  return selector.matchLabels || (selector.matchExpressions ? {} : selector);
}

function selects(selector, labels) {
  const entries = Object.entries(selector || {});
  if (!entries.length) return false;
  return entries.every(([k, v]) => (labels || {})[k] === v);
}

const idOf = (kind, name) => `${kind}/${name}`;

/** One short line of what matters about a resource, for under its name: replicas and images, type and ports, hosts, schedule, size. */
function detailOf(d) {
  const spec = d.spec || {};
  const images = (podSpec) => [...new Set([...(podSpec.initContainers || []), ...(podSpec.containers || [])]
    .map((c) => String(c.image || '').split('/').pop()).filter(Boolean))].join(', ');
  if (['Deployment', 'StatefulSet', 'ReplicaSet'].includes(d.kind)) {
    return [spec.replicas !== undefined ? `${spec.replicas}×` : null, images(podTemplateOf(d).spec)].filter(Boolean).join(' ');
  }
  if (['DaemonSet', 'Job', 'Pod'].includes(d.kind)) return images(podTemplateOf(d).spec);
  if (d.kind === 'CronJob') return [spec.schedule, images(podTemplateOf(d).spec)].filter(Boolean).join(' · ');
  if (d.kind === 'Service') {
    const ports = (spec.ports || []).map((p) => (p.targetPort && p.targetPort !== p.port ? `${p.port}→${p.targetPort}` : `${p.port}`)).join(',');
    return [spec.clusterIP === 'None' ? 'headless' : (spec.type || 'ClusterIP'), ports].filter(Boolean).join(' ');
  }
  if (d.kind === 'Ingress') return (spec.rules || []).map((r) => r.host).filter(Boolean).join(', ') || (spec.ingressClassName || '');
  if (d.kind === 'PersistentVolumeClaim') return [spec.resources?.requests?.storage, spec.storageClassName].filter(Boolean).join(' · ');
  if (d.kind === 'HorizontalPodAutoscaler') return `${spec.minReplicas ?? 1}–${spec.maxReplicas ?? '?'} replicas`;
  if (d.kind === 'ConfigMap' || d.kind === 'Secret') {
    const keys = Object.keys({ ...(d.data || {}), ...(d.stringData || {}) });
    return keys.length ? `${keys.length} key${keys.length === 1 ? '' : 's'}` : (d.type || '');
  }
  return '';
}

/** Gateway API refs and the like name a kind only sometimes; the kind they mean by default. */
const refKind = (ref, fallback) => ref?.kind || fallback;

/**
 * `{ nodes: [{id, kind, name, namespace}], edges: [{from, to, label}] }`.
 * An edge is only kept when both ends are in the manifests — a reference to
 * something the release did not install (a pre-existing Secret, the
 * `default` ServiceAccount) is a fact about the cluster, not this chart, and
 * is listed in `external` instead of drawn as a dangling arrow.
 */
function buildGraph(docs) {
  const nodes = new Map();
  for (const d of docs) {
    const id = idOf(d.kind, d.metadata.name);
    if (!nodes.has(id)) nodes.set(id, { id, kind: d.kind, name: d.metadata.name, namespace: d.metadata.namespace || '', detail: detailOf(d) });
  }
  // A StatefulSet's volumeClaimTemplates are not in the manifest as PVCs —
  // the controller makes one per replica — but they are what it stores
  // into, so each template is a node of its own, named the way its claims are.
  for (const d of docs.filter((x) => x.kind === 'StatefulSet')) {
    for (const t of d.spec?.volumeClaimTemplates || []) {
      const name = `${t.metadata?.name}-${d.metadata.name}-*`;
      const id = idOf('PersistentVolumeClaim', name);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id, kind: 'PersistentVolumeClaim', name, namespace: d.metadata.namespace || '',
          detail: ['per replica', t.spec?.resources?.requests?.storage, t.spec?.storageClassName].filter(Boolean).join(' · '),
        });
      }
    }
  }
  const edges = [];
  const external = new Set();
  const seen = new Set();
  const add = (from, toKind, toName, label) => {
    if (!toName) return;
    const to = idOf(toKind, toName);
    if (!nodes.has(to)) { external.add(to); return; }
    const key = `${from}>${to}>${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, label });
  };
  const workloads = docs.filter((d) => WORKLOADS.includes(d.kind));

  for (const d of docs) {
    const me = idOf(d.kind, d.metadata.name);
    const spec = d.spec || {};
    if (d.kind === 'Ingress') {
      const backends = [spec.defaultBackend, spec.backend,
        ...(spec.rules || []).flatMap((r) => (r.http?.paths || []).map((p) => p.backend))];
      for (const b of backends) add(me, 'Service', b?.service?.name || b?.serviceName, 'routes');
      for (const t of spec.tls || []) add(me, 'Secret', t.secretName, 'TLS');
    }
    // Gateway API: a route sends to Services and hangs off a Gateway.
    if (['HTTPRoute', 'GRPCRoute', 'TCPRoute', 'TLSRoute', 'UDPRoute'].includes(d.kind)) {
      for (const r of spec.rules || []) for (const b of r.backendRefs || []) add(me, refKind(b, 'Service'), b.name, 'routes');
      for (const ref of spec.parentRefs || []) add(me, refKind(ref, 'Gateway'), ref.name, 'attached to');
    }
    if (d.kind === 'Gateway') for (const l of spec.listeners || []) for (const c of l.tls?.certificateRefs || []) add(me, refKind(c, 'Secret'), c.name, 'TLS');
    // Things the API server itself calls: admission webhooks, aggregated APIs.
    if (d.kind === 'MutatingWebhookConfiguration' || d.kind === 'ValidatingWebhookConfiguration') {
      for (const w of d.webhooks || []) add(me, 'Service', w.clientConfig?.service?.name, 'calls');
    }
    if (d.kind === 'APIService') add(me, 'Service', spec.service?.name, 'serves');
    // Prometheus Operator: what gets scraped.
    if (d.kind === 'ServiceMonitor') {
      const sel = matchLabelsOf(spec.selector);
      for (const svc of docs.filter((x) => x.kind === 'Service')) if (selects(sel, svc.metadata?.labels)) add(me, 'Service', svc.metadata.name, 'scrapes');
    }
    if (d.kind === 'PodMonitor') {
      const sel = matchLabelsOf(spec.selector);
      for (const w of workloads) if (selects(sel, podTemplateOf(w).labels)) add(me, w.kind, w.metadata.name, 'scrapes');
    }
    // cert-manager: a Certificate writes its Secret, from an Issuer.
    if (d.kind === 'Certificate') {
      add(me, 'Secret', spec.secretName, 'writes');
      add(me, spec.issuerRef?.kind || 'Issuer', spec.issuerRef?.name, 'issued by');
    }
    // KEDA, the same shape as an HPA.
    if (d.kind === 'ScaledObject') add(me, spec.scaleTargetRef?.kind || 'Deployment', spec.scaleTargetRef?.name, 'scales');
    if (d.kind === 'PersistentVolumeClaim') add(me, 'StorageClass', spec.storageClassName, 'class');
    if (d.kind === 'Service') {
      for (const w of workloads) if (selects(spec.selector, podTemplateOf(w).labels)) add(me, w.kind, w.metadata.name, 'selects');
    }
    if (WORKLOADS.includes(d.kind)) {
      const pod = podTemplateOf(d).spec;
      for (const v of pod.volumes || []) {
        if (v.configMap) add(me, 'ConfigMap', v.configMap.name, 'mounts');
        if (v.secret) add(me, 'Secret', v.secret.secretName, 'mounts');
        if (v.persistentVolumeClaim) add(me, 'PersistentVolumeClaim', v.persistentVolumeClaim.claimName, 'mounts');
        for (const s of v.projected?.sources || []) {
          if (s.configMap) add(me, 'ConfigMap', s.configMap.name, 'mounts');
          if (s.secret) add(me, 'Secret', s.secret.name, 'mounts');
        }
      }
      for (const c of [...(pod.containers || []), ...(pod.initContainers || [])]) {
        for (const e of c.env || []) {
          add(me, 'ConfigMap', e.valueFrom?.configMapKeyRef?.name, 'env');
          add(me, 'Secret', e.valueFrom?.secretKeyRef?.name, 'env');
        }
        for (const e of c.envFrom || []) {
          add(me, 'ConfigMap', e.configMapRef?.name, 'env');
          add(me, 'Secret', e.secretRef?.name, 'env');
        }
      }
      add(me, 'ServiceAccount', pod.serviceAccountName || pod.serviceAccount, 'runs as');
      for (const s2 of pod.imagePullSecrets || []) add(me, 'Secret', s2.name, 'pulls with');
      if (d.kind === 'StatefulSet') {
        add(me, 'Service', spec.serviceName, 'governed by');
        for (const t of spec.volumeClaimTemplates || []) {
          const claim = `${t.metadata?.name}-${d.metadata.name}-*`;
          add(me, 'PersistentVolumeClaim', claim, 'claims');
          // The template's claims get their class the same way a plain PVC does.
          add(idOf('PersistentVolumeClaim', claim), 'StorageClass', t.spec?.storageClassName, 'class');
        }
      }
    }
    if (d.kind === 'RoleBinding' || d.kind === 'ClusterRoleBinding') {
      add(me, d.roleRef?.kind || 'Role', d.roleRef?.name, 'grants');
      for (const s of d.subjects || []) if (s.kind === 'ServiceAccount') add(me, 'ServiceAccount', s.name, 'to');
    }
    if (d.kind === 'HorizontalPodAutoscaler') add(me, spec.scaleTargetRef?.kind, spec.scaleTargetRef?.name, 'scales');
    if (d.kind === 'PodDisruptionBudget' || d.kind === 'NetworkPolicy') {
      const sel = matchLabelsOf(d.kind === 'NetworkPolicy' ? spec.podSelector : spec.selector);
      for (const w of workloads) if (selects(sel, podTemplateOf(w).labels)) add(me, w.kind, w.metadata.name, d.kind === 'NetworkPolicy' ? 'guards' : 'protects');
    }
  }
  return { nodes: [...nodes.values()], edges, external: [...external].sort() };
}

/** Left to right, the way traffic and dependency read: what you reach first, then what serves it, then what that uses. */
const RANKS = {
  Gateway: 0, Ingress: 0, HTTPRoute: 0, GRPCRoute: 0, TCPRoute: 0, TLSRoute: 0, UDPRoute: 0,
  HorizontalPodAutoscaler: 0, ScaledObject: 0, NetworkPolicy: 0, PodDisruptionBudget: 0,
  ServiceMonitor: 0, PodMonitor: 0, MutatingWebhookConfiguration: 0, ValidatingWebhookConfiguration: 0, APIService: 0,
  Service: 1,
  Deployment: 2, StatefulSet: 2, DaemonSet: 2, ReplicaSet: 2, Job: 2, CronJob: 2, Pod: 2,
  ConfigMap: 3, Secret: 3, PersistentVolumeClaim: 3, ServiceAccount: 3, Certificate: 3,
  StorageClass: 4, Issuer: 4, ClusterIssuer: 4, RoleBinding: 4, ClusterRoleBinding: 4,
  Role: 5, ClusterRole: 5,
};
function rankOf(kind) { return RANKS[kind] ?? 6; }

/** Mermaid ids are letters, digits and underscores; names are not. */
function mermaidId(id) { return 'n_' + id.replace(/[^A-Za-z0-9_]/g, '_'); }
function mermaidText(s) { return String(s).replace(/"/g, '#quot;'); }

const MERMAID_CLASS = {
  Ingress: 'fill:#3b2f5c,stroke:#a371f7,color:#fff',
  Service: 'fill:#123b4a,stroke:#4fd1ff,color:#fff',
  workload: 'fill:#16351f,stroke:#3fb950,color:#fff',
  config: 'fill:#3a2f12,stroke:#d29922,color:#fff',
  rbac: 'fill:#3a1a1a,stroke:#f85149,color:#fff',
  other: 'fill:#24292f,stroke:#8b949e,color:#fff',
};
function classOf(kind) {
  if (kind === 'Ingress' || kind === 'Gateway' || /Route$/.test(kind)) return 'Ingress';
  if (kind === 'Service') return 'Service';
  if (WORKLOADS.includes(kind)) return 'workload';
  if (['ConfigMap', 'Secret', 'PersistentVolumeClaim', 'ServiceAccount', 'Certificate', 'StorageClass'].includes(kind)) return 'config';
  if (/Role/.test(kind)) return 'rbac';
  return 'other';
}

/**
 * A Mermaid flowchart of the graph — pasteable into GitHub, Notion, a
 * Markdown doc. One subgraph per column (rank), so Mermaid's own layout
 * keeps the same left-to-right reading the app draws.
 */
function toMermaid(graph, { title } = {}) {
  const lines = [];
  if (title) lines.push('---', `title: ${mermaidText(title)}`, '---');
  lines.push('flowchart LR');
  const byClass = new Map();
  for (const n of [...graph.nodes].sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || a.id.localeCompare(b.id))) {
    const extra = n.detail ? `<br/><small>${mermaidText(n.detail)}</small>` : '';
    lines.push(`  ${mermaidId(n.id)}["${mermaidText(n.kind)}<br/><b>${mermaidText(n.name)}</b>${extra}"]`);
    const c = classOf(n.kind);
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(mermaidId(n.id));
  }
  for (const e of graph.edges) lines.push(`  ${mermaidId(e.from)} -->|${mermaidText(e.label)}| ${mermaidId(e.to)}`);
  for (const [c, ids] of byClass) {
    lines.push(`  classDef ${c} ${MERMAID_CLASS[c]}`);
    lines.push(`  class ${ids.join(',')} ${c}`);
  }
  return lines.join('\n') + '\n';
}

/** A Helm manifest straight to the graph the diagram draws and the Mermaid it exports. */
function manifestGraph(text, opts = {}) {
  const graph = buildGraph(parseManifests(text));
  // The column each node is drawn in, so the renderer lays out the same
  // left-to-right reading the Mermaid export has without its own copy of RANKS.
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, rank: rankOf(n.kind) })), mermaid: toMermaid(graph, opts) };
}

module.exports = { parseManifests, buildGraph, toMermaid, manifestGraph, rankOf, mermaidId };
