'use strict';
/**
 * Exporting resources as Kubernetes' own JSON or YAML: the same document
 * `kubectl get <kind> -o json|yaml` writes — `apiVersion: v1`, `kind: List`,
 * `items:` of full objects, each with its own apiVersion and kind — so the
 * file is something kubectl, Helm, Kustomize or a GitOps repo already reads.
 *
 * Only the rows the browser is showing (or has ticked) are kept, matched by
 * namespace and name, so the export is what is on screen, not everything of
 * that kind in the cluster.
 *
 * `clean` gives a file ready to apply elsewhere: what the API server sets on
 * its own — status, managedFields, uid, resourceVersion, creationTimestamp,
 * generation, selfLink, the last-applied annotation, a Service's clusterIP —
 * is taken out, the cleanup people otherwise do by hand before re-applying.
 */

const { execFile } = require('child_process');
const yaml = require('js-yaml');
const kube = require('./kube');
const kubebin = require('./kubebin');

function run(bin, args, { env, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 128 * 1024 * 1024, env },
      (err, stdout, stderr) => resolve(kubebin.explainMissing({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err })));
  });
}

function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

const SERVER_METADATA = ['uid', 'resourceVersion', 'creationTimestamp', 'generation', 'selfLink', 'managedFields', 'deletionTimestamp', 'deletionGracePeriodSeconds'];
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/** One object made ready to apply somewhere else — a copy, the original is left alone. */
function cleanObject(obj) {
  const o = JSON.parse(JSON.stringify(obj));
  delete o.status;
  if (o.metadata) {
    for (const k of SERVER_METADATA) delete o.metadata[k];
    if (o.metadata.annotations) {
      delete o.metadata.annotations[LAST_APPLIED];
      delete o.metadata.annotations['deployment.kubernetes.io/revision'];
      if (!Object.keys(o.metadata.annotations).length) delete o.metadata.annotations;
    }
    // Owned objects (a Deployment's ReplicaSets and Pods) belong to their
    // owner by uid — meaningless anywhere else, and the uid is gone above.
    delete o.metadata.ownerReferences;
  }
  // Addresses the cluster handed out are its, not the object's.
  if (o.kind === 'Service' && o.spec) {
    delete o.spec.clusterIP;
    delete o.spec.clusterIPs;
    if (o.spec.type !== 'NodePort' && o.spec.type !== 'LoadBalancer') {
      for (const p of o.spec.ports || []) delete p.nodePort;
    }
  }
  if (o.kind === 'PersistentVolumeClaim' && o.spec) delete o.spec.volumeName;
  if (o.kind === 'Pod' && o.spec) cleanPodSpec(o);
  return o;
}

/*
 * A running Pod carries where it was scheduled, which no other cluster has:
 *   - spec.nodeName binds it to a node by name — applied elsewhere it is
 *     accepted and then sits Pending forever, with no node of that name;
 *   - the service-account token volume (kube-api-access-xxxxx) and its
 *     mounts are injected by this cluster's admission controller, and the
 *     target cluster injects its own;
 *   - ephemeralContainers (a debug container) can never be set on create —
 *     the API server refuses the whole Pod.
 * generateName goes too: the Pod already has its own name.
 */
const INJECTED_TOKEN_VOLUME = /^kube-api-access-[a-z0-9]{5}$/;
function cleanPodSpec(o) {
  delete o.spec.nodeName;
  delete o.spec.ephemeralContainers;
  if (o.metadata) delete o.metadata.generateName;
  const injected = new Set((o.spec.volumes || []).filter((v) => INJECTED_TOKEN_VOLUME.test(v.name) && v.projected).map((v) => v.name));
  if (!injected.size) return;
  o.spec.volumes = o.spec.volumes.filter((v) => !injected.has(v.name));
  if (!o.spec.volumes.length) delete o.spec.volumes;
  for (const c of [...(o.spec.containers || []), ...(o.spec.initContainers || [])]) {
    if (!c.volumeMounts) continue;
    c.volumeMounts = c.volumeMounts.filter((m) => !injected.has(m.name));
    if (!c.volumeMounts.length) delete c.volumeMounts;
  }
}

/** What owns this object, when something does — a Pod's ReplicaSet, StatefulSet, DaemonSet or Job. */
function controllerOf(obj) {
  const ref = (obj.metadata?.ownerReferences || []).find((r) => r.controller) || obj.metadata?.ownerReferences?.[0];
  return ref ? `${ref.kind}/${ref.name}` : null;
}

/** The objects as a Kubernetes List document, in the format asked for. */
function toDocument(items, format) {
  const list = { apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '' }, items };
  if (format === 'json') return JSON.stringify(list, null, 2) + '\n';
  return yaml.dump(list, { lineWidth: -1, noRefs: true });
}

/**
 * `rows` is `[{namespace, name}]` — the rows to keep. Empty keeps every
 * object the `get` returned. Returns `{ok, text, count, missing}`; `missing`
 * names any row that was no longer there by the time it was read.
 */
async function exportResources(spec = {}, {
  kind, namespaced = true, namespace, selector, apiVersion, rows = [], format = 'yaml', clean = false,
} = {}) {
  if (!kind) return { ok: false, error: 'No kind to export.' };
  if (!['json', 'yaml'].includes(format)) return { ok: false, error: `Unknown format "${format}".` };
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : { ...spec, namespace: null });
  // A CRD is named by its group, the way kubectl needs it to be unambiguous.
  const group = apiVersion && apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
  const what = group && !kind.includes('.') ? `${kind}.${group}` : kind;
  const scope = namespaced && !namespace ? ['-A'] : [];
  const sel = selector ? ['-l', selector] : [];
  const r = await run(bin, [...baseArgs, 'get', what, ...scope, ...sel, '-o', 'json'], { env });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || `kubectl get ${what} failed` };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Unexpected output from kubectl' }; }
  let items = data.items || (data.kind && data.kind !== 'List' ? [data] : []);
  let missing = [];
  if (rows.length) {
    const key = (ns, name) => `${ns || ''}\u0001${name}`;
    const byKey = new Map(items.map((o) => [key(namespaced ? o.metadata?.namespace : '', o.metadata?.name), o]));
    const wanted = rows.map((x) => key(namespaced ? x.namespace : '', x.name));
    items = wanted.map((k) => byKey.get(k)).filter(Boolean);
    missing = rows.filter((x, i) => !byKey.has(wanted[i])).map((x) => (x.namespace ? `${x.namespace}/${x.name}` : x.name));
  }
  // `kubectl get` on a list leaves each item's apiVersion/kind set; make sure
  // of it anyway, since a List whose items lack them will not apply.
  const fallbackApi = apiVersion || data.items?.[0]?.apiVersion || '';
  items = items.map((o) => ({ apiVersion: o.apiVersion || fallbackApi, kind: o.kind || data.kind?.replace(/List$/, '') || '', ...o }));
  // Owned objects, said before anything is stripped: exported on their own
  // they are standalone copies nothing manages — the owner (a Deployment, a
  // StatefulSet) is what moves them between clusters properly.
  const owned = items.map((o) => ({ name: o.metadata?.name, owner: controllerOf(o) })).filter((x) => x.owner);
  if (clean) items = items.map(cleanObject);
  return { ok: true, text: toDocument(items, format), count: items.length, missing, owned };
}

module.exports = { exportResources, cleanObject, toDocument, controllerOf };
