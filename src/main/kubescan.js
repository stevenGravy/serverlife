'use strict';
/**
 * Turning pods/deployments/services into a 3D scene's data — the kube3d.js
 * counterpart to cityscan.js's filesystem walk. Deliberately pure and
 * IO-free: the actual `kubectl get …` calls already exist (kube.js's
 * listPods(), kuberesources.js's getResources()), so this only reshapes what
 * those already return into `{namespaces: [{name, pods, deployments,
 * services, podCount}]}`, which is what makes it testable against canned
 * data with no live cluster.
 */

/** Rough per-container resource footprint, for the tower's floor count — no metrics-server call, just what's always known. */
function footprintOf(pod) {
  return Math.max(1, pod.total || pod.containers?.length || 1);
}

const PHASE_WEIGHT = { Running: 3, Pending: 1, Succeeded: 1, Unknown: 1 };
function heightOf(pod) {
  const base = PHASE_WEIGHT[pod.phase] ?? 2;
  return base + footprintOf(pod) + Math.min(pod.restarts || 0, 10) * 0.3;
}

/**
 * "3/3 ready" — the `detail` string kuberesources.js's detailOf() already
 * computes for a Deployment/StatefulSet/DaemonSet row — read back into
 * {ready, desired} rather than re-derived from the raw resource here.
 * Anything that doesn't match reads as 0/0 rather than guessed at.
 */
function readyRatioOf(detail) {
  const m = /^(\d+)\/(\d+) ready/.exec(detail || '');
  return m ? { ready: Number(m[1]), desired: Number(m[2]) } : { ready: 0, desired: 0 };
}

/** Does this selector pick these labels? Every key must match; an empty selector picks nothing — a Service with no selector routes to hand-made Endpoints, not to pods. */
function selects(selector, labels) {
  const entries = Object.entries(selector || {});
  if (!entries.length) return false;
  return entries.every(([k, v]) => (labels || {})[k] === v);
}

/**
 * The arrows: who sends traffic to whom, read from the same label
 * selectors Kubernetes itself uses. Service → Deployment where the Service
 * picks any of that Deployment's pods; Deployment → Pod for the pods it
 * owns; Service → Pod straight, for a pod no Deployment owns (a
 * StatefulSet's, a bare one). Ends are `Kind/name`, within one namespace —
 * selectors never cross one.
 */
function linksOf({ pods, deployments, services }) {
  const links = [];
  const ownerOf = new Map(); // pod name -> deployment name
  for (const d of deployments) {
    for (const p of pods) {
      if (!ownerOf.has(p.name) && selects(d.selectorLabels, p.labels)) {
        ownerOf.set(p.name, d.name);
        links.push({ from: `Deployment/${d.name}`, to: `Pod/${p.name}` });
      }
    }
  }
  for (const s of services) {
    const viaDeployment = new Set();
    for (const p of pods) {
      if (!selects(s.selectorLabels, p.labels)) continue;
      const owner = ownerOf.get(p.name);
      if (owner) viaDeployment.add(owner);
      else links.push({ from: `Service/${s.name}`, to: `Pod/${p.name}` });
    }
    for (const d of [...viaDeployment].sort()) links.push({ from: `Service/${s.name}`, to: `Deployment/${d}` });
  }
  return links;
}

/**
 * `pods` is exactly what kube.js's `listPods()` already shapes:
 * `{name, namespace, phase, ready, total, restarts, containers, node, labels}`.
 * `deployments`/`services` are kuberesources.js's `getResources()` rows:
 * `{name, namespace, status, detail, selectorLabels}`. Grouped by namespace
 * (the "district"), each resource carries just the numbers kube3d.js needs
 * to size and colour its shape without recomputing anything from raw k8s
 * objects — and each namespace its `links`, see linksOf().
 */
function buildScene({ pods = [], deployments = [], services = [] } = {}) {
  const byNs = new Map();
  const nsEntry = (ns) => {
    if (!byNs.has(ns)) byNs.set(ns, { pods: [], deployments: [], services: [], raw: { pods: [], deployments: [], services: [] } });
    return byNs.get(ns);
  };

  for (const pod of pods) {
    const ns = pod.namespace || 'default';
    nsEntry(ns).raw.pods.push(pod);
    nsEntry(ns).pods.push({
      name: pod.name,
      phase: pod.phase || 'Unknown',
      restarts: pod.restarts || 0,
      footprint: footprintOf(pod),
      height: heightOf(pod),
      node: pod.node || '',
      containers: pod.containers || [],
    });
  }
  for (const dep of deployments) {
    const ns = dep.namespace || 'default';
    nsEntry(ns).raw.deployments.push(dep);
    nsEntry(ns).deployments.push({ name: dep.name, ...readyRatioOf(dep.detail) });
  }
  for (const svc of services) {
    const ns = svc.namespace || 'default';
    nsEntry(ns).raw.services.push(svc);
    nsEntry(ns).services.push({ name: svc.name, detail: svc.detail || '' });
  }

  const namespaces = [...byNs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      name,
      pods: entry.pods.sort((a, b) => a.name.localeCompare(b.name)),
      deployments: entry.deployments.sort((a, b) => a.name.localeCompare(b.name)),
      services: entry.services.sort((a, b) => a.name.localeCompare(b.name)),
      podCount: entry.pods.length,
      links: linksOf(entry.raw),
    }));
  return { namespaces, podCount: pods.length };
}

module.exports = { buildScene, footprintOf, heightOf, readyRatioOf, selects, linksOf };
