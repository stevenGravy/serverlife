'use strict';
/**
 * KubeLife's full-cluster browser: every resource kind a cluster actually
 * has, not a hand-maintained list. `kubectl api-resources` is the cluster's own answer to "what
 * kinds exist," CRDs included automatically, so a cluster that installs a
 * new CRD tomorrow needs no code change here today. Curated categories
 * (Workloads, Config, Network, Storage, Access Control, Cluster) are just a
 * classification laid over that discovered list; anything not matched is,
 * by construction, a custom resource, and falls into its own category
 * rather than being silently dropped.
 */

const { execFile } = require('child_process');
const kube = require('./kube');
const kubebin = require('./kubebin');
const kuberelations = require('./kuberelations');
const jsonpath = require('./jsonpath-lite');

function run(bin, args, { env, timeout = 20000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve(kubebin.explainMissing({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err })));
  });
}

/** Same as run(), with text fed over stdin — `kubectl diff`/`apply -f -` read the manifest from there, not a flag. */
function runWithStdin(bin, args, input, { env, timeout = 20000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve(kubebin.explainMissing({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err })));
    // A kubectl that never started (ENOENT) leaves nothing reading stdin;
    // the callback above already reports that, so the EPIPE here is noise.
    child.stdin.on('error', () => {});
    child.stdin.write(input == null ? '' : input);
    child.stdin.end();
  });
}

function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

/**
 * `kubectl api-resources -o wide`'s table, read by column position rather
 * than split on whitespace — a resource with no shortname (plenty have
 * none) leaves that column empty, which a naive whitespace split would read
 * as every later field shifting left by one. The header line is the only
 * reliable source for where each column actually starts; kubectl does not
 * offer this as JSON.
 */
function parseApiResources(text) {
  const lines = String(text || '').split('\n');
  const headerIdx = lines.findIndex((l) => l.startsWith('NAME'));
  if (headerIdx < 0) return [];
  const header = lines[headerIdx];
  const cols = ['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', 'VERBS', 'CATEGORIES'];
  const starts = cols.map((c) => [c, header.indexOf(c)]).filter(([, i]) => i >= 0);
  if (!starts.length) return [];
  const out = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const row = {};
    for (let i = 0; i < starts.length; i++) {
      const [c, start] = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1][1] : line.length;
      row[c] = line.slice(start, end).trim();
    }
    out.push({
      name: row.NAME,
      shortNames: row.SHORTNAMES ? row.SHORTNAMES.split(',') : [],
      apiVersion: row.APIVERSION,
      namespaced: row.NAMESPACED === 'true',
      kind: row.KIND,
      verbs: row.VERBS ? row.VERBS.split(',') : [],
      categories: row.CATEGORIES ? row.CATEGORIES.split(',') : [],
    });
  }
  return out;
}

/**
 * The curated groupings, by Kind — a fixed classification table for the
 * common kinds, and "everything else" (which is exactly "every CRD, automatically")
 * falls into Custom Resources, grouped by apiVersion's group so a cluster
 * with several operators installed doesn't get one undifferentiated pile.
 */
const CATEGORY_BY_KIND = {
  Pod: 'Workloads', Deployment: 'Workloads', ReplicaSet: 'Workloads', StatefulSet: 'Workloads',
  DaemonSet: 'Workloads', Job: 'Workloads', CronJob: 'Workloads', ReplicationController: 'Workloads',
  ConfigMap: 'Config', Secret: 'Config', ResourceQuota: 'Config', LimitRange: 'Config',
  HorizontalPodAutoscaler: 'Config', PodDisruptionBudget: 'Config',
  Service: 'Network', Endpoints: 'Network', EndpointSlice: 'Network', Ingress: 'Network',
  IngressClass: 'Network', NetworkPolicy: 'Network',
  PersistentVolume: 'Storage', PersistentVolumeClaim: 'Storage', StorageClass: 'Storage', VolumeAttachment: 'Storage',
  ServiceAccount: 'Access Control', Role: 'Access Control', ClusterRole: 'Access Control',
  RoleBinding: 'Access Control', ClusterRoleBinding: 'Access Control',
  Node: 'Cluster', Namespace: 'Cluster', Event: 'Cluster', ComponentStatus: 'Cluster', Binding: 'Cluster',
};

/** Argo CD's own CRDs, and any of Flux's several `*.toolkit.fluxcd.io` groups — keyed on apiGroup, not Kind name, so an unrelated CRD can never collide into this bucket by reusing a common Kind name. */
function isGitOpsGroup(group) {
  return group === 'argoproj.io' || group.endsWith('.toolkit.fluxcd.io');
}

function categorize(resourceType) {
  const builtin = CATEGORY_BY_KIND[resourceType?.kind];
  if (builtin) return builtin;
  const group = (resourceType?.apiVersion || '').split('/')[0];
  if (group && isGitOpsGroup(group)) return 'GitOps';
  return group && group !== 'v1' ? `Custom Resources: ${group}` : 'Custom Resources';
}

async function discoverResourceTypes(spec = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(spec);
  const r = await run(bin, [...baseArgs, 'api-resources', '-o', 'wide'], { env, timeout: 20000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl api-resources failed', types: [] };
  const types = parseApiResources(r.stdout).map((t) => ({ ...t, category: categorize(t) }));
  return { ok: true, types };
}

/**
 * "Actionable information" for each list row — ready-Pod counts for a
 * ReplicaSet, current status for a Pod — rather than every kind
 * collapsing to the same bare name/status pair. Only the common kinds get a tailored
 * `detail`; everything else (including every CRD) still gets a row, just
 * without one, which is the honest answer for a kind this has no special
 * knowledge of.
 */
function detailOf(kind, i) {
  if (kind === 'Pod') {
    const cs = i.status?.containerStatuses || [];
    const restarts = cs.reduce((n, c) => n + (c.restartCount || 0), 0);
    return `${cs.filter((c) => c.ready).length}/${cs.length} ready` + (restarts ? `, ${restarts} restarts` : '');
  }
  if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'ReplicaSet') {
    const ready = i.status?.readyReplicas ?? 0;
    const desired = i.spec?.replicas ?? i.status?.replicas ?? 0;
    return `${ready}/${desired} ready`;
  }
  if (kind === 'DaemonSet') {
    return `${i.status?.numberReady ?? 0}/${i.status?.desiredNumberScheduled ?? 0} ready`;
  }
  if (kind === 'Node') {
    const roles = Object.keys(i.metadata?.labels || {})
      .filter((k) => k.startsWith('node-role.kubernetes.io/'))
      .map((k) => k.split('/')[1]).join(',') || 'worker';
    return `${roles} · ${i.status?.nodeInfo?.kubeletVersion || ''}`;
  }
  if (kind === 'Service') {
    return `${i.spec?.type || 'ClusterIP'} · ${i.spec?.clusterIP || ''}`;
  }
  if (kind === 'Job') {
    return `${i.status?.succeeded ?? 0}/${i.spec?.completions ?? 1} completed`;
  }
  if (kind === 'CronJob') {
    return `${i.spec?.schedule || ''}${i.spec?.suspend ? ' · suspended' : ''}`;
  }
  if (kind === 'Event') {
    const obj = i.involvedObject || {};
    const times = i.count > 1 ? ` ×${i.count}` : '';
    return `${obj.kind || ''}/${obj.name || ''}: ${i.reason || ''} — ${i.message || ''}${times}`;
  }
  // Whatever resources this quota actually names — never a fixed
  // pods/cpu/memory list, since a quota can cap any countable resource
  // (storage, object counts for a CRD, …) and most only set a few.
  if (kind === 'ResourceQuota') {
    const hard = i.status?.hard || {};
    const used = i.status?.used || {};
    const keys = Object.keys(hard).slice(0, 3);
    return keys.length ? keys.map((k) => `${used[k] ?? '0'}/${hard[k]} ${k}`).join(' · ') : 'no limits set';
  }
  if (kind === 'LimitRange') {
    const limits = i.spec?.limits || [];
    if (!limits.length) return 'no limits defined';
    const first = limits[0];
    const bits = Object.entries(first.default || first.defaultRequest || {}).slice(0, 2).map(([k, v]) => `${k} ${v}`);
    return `${first.type || 'Container'}${bits.length ? ': ' + bits.join(', ') : ''}` + (limits.length > 1 ? ` (+${limits.length - 1} more)` : '');
  }
  if (kind === 'Role' || kind === 'ClusterRole') {
    const n = (i.rules || []).length;
    return `${n} rule${n === 1 ? '' : 's'}`;
  }
  if (kind === 'RoleBinding' || kind === 'ClusterRoleBinding') {
    const ref = i.roleRef || {};
    const n = (i.subjects || []).length;
    return `${ref.kind || ''}/${ref.name || ''} → ${n} subject${n === 1 ? '' : 's'}`;
  }
  // GitOps CRDs (Flux, Argo CD): real status instead of the silence every
  // other unrecognized CRD gets. Argo's own Application is the one shape
  // that isn't a Ready condition; every Flux kind shares that same shape.
  if (isGitOpsGroup((i.apiVersion || '').split('/')[0])) {
    if (kind === 'Application') return `${i.status?.sync?.status || 'Unknown'}, ${i.status?.health?.status || 'Unknown'}`;
    const ready = (i.status?.conditions || []).find((c) => c.type === 'Ready');
    if (!ready) return 'Unknown';
    return ready.status === 'True' ? 'Ready' : `Not ready: ${ready.reason || ready.message || 'unknown reason'}`;
  }
  return '';
}

/** A clean Ready/NotReady rather than every condition type joined together — what Node's status column means in every other k8s tool. */
function conditionStatus(i) {
  const ready = (i.status?.conditions || []).find((c) => c.type === 'Ready');
  if (ready) return ready.status === 'True' ? 'Ready' : 'NotReady';
  return (i.status?.conditions || []).map((c) => c.type).join(',');
}

/** Rows for one resource kind — `kubectl get <kind> [-n ns|-A] -o json`, trimmed to what a table needs. */
/** `metadata.labels` as `k=v,k2=v2` — kubectl's own -l syntax, from a workload's selector. */
function selectorString(matchLabels) {
  const entries = Object.entries(matchLabels || {});
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(',') : '';
}

/**
 * One full item (from a list or a single `get`) into the row a table
 * actually shows — pure, no IO. Factored out of getResources() so a
 * watched object (kubewatch.js, one object at a time, no list around it)
 * turns into exactly the same row shape rather than a second, poorer copy
 * of this logic living in the renderer.
 */
function rowFrom(i) {
  return {
    name: i.metadata?.name || '',
    namespace: i.metadata?.namespace || '',
    // An event's own creationTimestamp is when the record was first made —
    // for one that has been recurring for days, lastTimestamp (when it most
    // recently happened) is the age anyone asking "what just happened" means.
    age: i.kind === 'Event' ? (i.lastTimestamp || i.eventTime || i.firstTimestamp || i.metadata?.creationTimestamp || '') : (i.metadata?.creationTimestamp || ''),
    // Normal/Warning is the event's own status, not a phase or condition it does not have.
    status: i.kind === 'Event' ? (i.type || '') : (i.status?.phase || conditionStatus(i) || ''),
    detail: detailOf(i.kind, i),
    // Only a Pod needs this (for the full browser's own Exec action,
    // mirroring the Resources tab's pod tree) — harmless and unused on
    // everything else.
    containers: i.kind === 'Pod' ? (i.spec?.containers || []).map((c) => c.name) : undefined,
    // A workload's own selector — "jump to owner" for the common,
    // built-in set: the full browser's "Pods" button on one of these rows
    // re-fetches Pod with this as -l, rather than a fixed ownerReference
    // walk that would need its own code for every workload kind.
    // A Service's selector is a flat map (spec.selector), a workload's sits
    // under matchLabels — either way the same "Pods" button, and the same
    // map the 3D view matches pod labels against for its arrows.
    selector: ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(i.kind)
      ? selectorString(i.spec?.selector?.matchLabels)
      : i.kind === 'Service' ? selectorString(i.spec?.selector) || undefined : undefined,
    selectorLabels: ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(i.kind)
      ? (i.spec?.selector?.matchLabels || {})
      : i.kind === 'Service' ? (i.spec?.selector || {}) : undefined,
    // So the browser's Suspend/Resume toggle knows which label to show
    // without a separate fetch per row.
    suspended: i.kind === 'CronJob' ? !!i.spec?.suspend : undefined,
    // For the full browser's own crash-loop/stalled-rollout alerts —
    // Kubernetes' own label for the condition, not a restart-count
    // threshold guessed from outside; `desiredReplicas`/`readyReplicas`
    // let that same alert tell "just starting up" from "stuck."
    waitingReason: i.kind === 'Pod' ? (i.status?.containerStatuses || []).map((cs) => cs.state?.waiting?.reason).find(Boolean) : undefined,
    desiredReplicas: ['Deployment', 'StatefulSet'].includes(i.kind) ? (i.spec?.replicas ?? 1) : undefined,
    readyReplicas: ['Deployment', 'StatefulSet'].includes(i.kind) ? (i.status?.readyReplicas ?? 0) : undefined,
  };
}

async function getResources(spec = {}, { name, namespaced, namespace, selector, fieldSelector, apiVersion } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : { ...spec, namespace: null });
  const scope = !namespaced ? [] : namespace ? [] : ['-A'];
  const sel = selector ? ['-l', selector] : [];
  const fsel = fieldSelector ? ['--field-selector', fieldSelector] : [];
  const r = await run(bin, [...baseArgs, 'get', name, ...scope, ...sel, ...fsel, '-o', 'json'], { env, timeout: 20000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || `kubectl get ${name} failed`, items: [] };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Unexpected output from kubectl', items: [] }; }
  const list = data.items || (data.metadata ? [data] : []);
  const items = list.map(rowFrom);
  // A CRD's own `additionalPrinterColumns` — only asked for a kind the
  // caller already knows is a custom resource (apiVersion given), so a
  // built-in kind never pays for a `kubectl get crd` that could only ever
  // come back "not found."
  if (apiVersion) {
    const cols = await crdColumnsFor(spec, { resourceTypeName: name, apiVersion });
    if (cols.length) {
      for (let idx = 0; idx < list.length; idx++) {
        items[idx].crdColumns = cols.map((c) => ({ label: c.label, type: c.type, value: jsonpath.resolve(list[idx], c.jsonPath) }));
      }
    }
  }
  // Most-recent-first — what every event feed in every comparable tool
  // defaults to, and what "live" means here: kubectl itself hands back
  // creation order, which buries what just happened under everything older.
  if (list[0]?.kind === 'Event') items.sort((a, b) => Date.parse(b.age || 0) - Date.parse(a.age || 0));
  // Best-effort: metrics-server is an add-on, not a given, and a cluster
  // without one must not lose the list over it — only the cpu/mem detail.
  if (name === 'pods' || name === 'nodes') {
    try {
      const top = name === 'pods' ? await topPods(spec, { namespace }) : await topNodes(spec);
      if (top.ok) {
        const key = (it) => (name === 'pods' ? `${it.namespace}\u0001${it.name}` : it.name);
        const byKey = new Map(top.items.map((t) => [key(t), t]));
        for (const it of items) {
          const t = byKey.get(key(it));
          if (t) it.detail = (it.detail ? it.detail + ' · ' : '') + `cpu ${t.cpu} · mem ${t.memory}`;
        }
      }
    } catch { /* metrics-server missing or slow: the list itself still stands */ }
  }
  return { ok: true, items };
}

/**
 * A CRD's own extra columns (`spec.versions[].additionalPrinterColumns`),
 * for the version actually in use — the one thing `kubectl api-resources`
 * never says, since it has no idea these columns exist either. Cached per
 * cluster and kind: a CRD's schema does not change between one row
 * render and the next, so there is no reason to re-fetch it for every one.
 */
const crdColumnsCache = new Map(); // `${contextName}\u0001${crdName}` -> [{label, jsonPath, type}] | []
/** The matching version's own additionalPrinterColumns out of a parsed CRD object — pure, no IO. */
function columnsFromCrdObject(crd, version) {
  const v = (crd?.spec?.versions || []).find((x) => x.name === version) || crd?.spec?.versions?.[0];
  return (v?.additionalPrinterColumns || []).map((c) => ({ label: c.name, jsonPath: c.jsonPath, type: c.type }));
}

async function crdColumnsFor(spec = {}, { resourceTypeName, apiVersion } = {}) {
  const group = String(apiVersion || '').includes('/') ? apiVersion.split('/')[0] : '';
  const version = String(apiVersion || '').includes('/') ? apiVersion.split('/')[1] : apiVersion;
  if (!group || !resourceTypeName) return [];
  const crdName = `${resourceTypeName}.${group}`;
  const cacheKey = `${spec.contextName || ''}\u0001${crdName}`;
  if (crdColumnsCache.has(cacheKey)) return crdColumnsCache.get(cacheKey);
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const r = await run(bin, [...baseArgs, 'get', 'crd', crdName, '-o', 'json'], { env, timeout: 15000 });
  let cols = [];
  if (r.ok) {
    try { cols = columnsFromCrdObject(JSON.parse(r.stdout), version); }
    catch { /* not a CRD after all, or unreadable: no extra columns */ }
  }
  crdColumnsCache.set(cacheKey, cols);
  return cols;
}

/**
 * The full object a list row only ever shows trimmed — what the detail
 * panel, and the related-resource walk beside it, both actually need.
 * Same `{name, resource, namespace}` shape getYaml()/describe() already
 * take, so the renderer's existing target(r) builds this call for free.
 */
async function getObject(spec = {}, { name, resource, namespace } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : spec);
  const r = await run(bin, [...baseArgs, 'get', resource, name, '-o', 'json'], { env, timeout: 20000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl get failed' };
  let object;
  try { object = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Unexpected output from kubectl' }; }
  return { ok: true, object, related: kuberelations.relatedOf(object) };
}

/** `kubectl top pods` — per-pod CPU/memory, from metrics-server. Namespaced columns shift with -A, so each form is parsed on its own. */
async function topPods(spec = {}, { namespace } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : { ...spec, namespace: null });
  const scope = namespace ? [] : ['-A'];
  const r = await run(bin, [...baseArgs, 'top', 'pods', ...scope, '--no-headers'], { env, timeout: 15000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl top pods failed (metrics-server may not be installed)', items: [] };
  const items = plain(r.stdout).split('\n').filter(Boolean).map((line) => {
    const cols = line.trim().split(/\s+/);
    return namespace
      ? { namespace, name: cols[0], cpu: cols[1], memory: cols[2] }
      : { namespace: cols[0], name: cols[1], cpu: cols[2], memory: cols[3] };
  });
  return { ok: true, items };
}

/** `kubectl top nodes` — per-node CPU/memory and the percentage of capacity that is. */
async function topNodes(spec = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const r = await run(bin, [...baseArgs, 'top', 'nodes', '--no-headers'], { env, timeout: 15000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl top nodes failed (metrics-server may not be installed)', items: [] };
  const items = plain(r.stdout).split('\n').filter(Boolean).map((line) => {
    const cols = line.trim().split(/\s+/);
    return { name: cols[0], cpu: cols[1], cpuPercent: cols[2], memory: cols[3], memoryPercent: cols[4] };
  });
  return { ok: true, items };
}

/** `kubectl top pod NAME --containers` — per-container CPU/memory inside one pod, for Requests vs limits vs actual usage in the detail panel. */
async function topPodContainers(spec = {}, { name, namespace } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : spec);
  const r = await run(bin, [...baseArgs, 'top', 'pod', name, '--containers', '--no-headers'], { env, timeout: 15000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl top pod --containers failed (metrics-server may not be installed)', items: [] };
  const items = plain(r.stdout).split('\n').filter(Boolean).map((line) => {
    const cols = line.trim().split(/\s+/); // POD NAME CPU MEMORY
    return { container: cols[1], cpu: cols[2], memory: cols[3] };
  });
  return { ok: true, items };
}

async function getYaml(spec = {}, { name, resource, namespace } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : spec);
  const r = await run(bin, [...baseArgs, 'get', resource, name, '-o', 'yaml'], { env, timeout: 20000 });
  return r.ok ? { ok: true, yaml: r.stdout } : { ok: false, error: plain(r.stderr) || 'kubectl get -o yaml failed' };
}

/**
 * `kubectl diff -f -`, fed the edited YAML over stdin — what applying it
 * would actually change, shown before anything does. The one thing every
 * comparable tool's own "edit resource" has and KubeLife's read-only
 * viewer did not: a way to change a resource at all, let alone see the
 * blast radius of a typo before it lands.
 */
async function diffYaml(spec = {}, { yaml } = {}) {
  // --context= still has to come from here (which cluster); the manifest's
  // own metadata.namespace governs the rest, so a stray -n from `spec`
  // would only ever disagree with it — dropped rather than passed through.
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const r = await runWithStdin(bin, [...baseArgs, 'diff', '-f', '-'], yaml, { env, timeout: 20000 });
  // kubectl diff's own exit code is 1 when it found a difference to show —
  // that is the normal case here, not a failure.
  if (!r.ok && r.err?.code !== 1) return { ok: false, error: plain(r.stderr) || 'kubectl diff failed' };
  return { ok: true, diff: plain(r.stdout) || '(no changes)' };
}

/** `kubectl apply -f -` — the edit itself, only ever called after diffYaml's own result has been shown and confirmed. */
async function applyYaml(spec = {}, { yaml } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const r = await runWithStdin(bin, [...baseArgs, 'apply', '-f', '-'], yaml, { env, timeout: 30000 });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || 'kubectl apply failed' };
}

/**
 * The YAML editor's own live validation — a server-side dry-run apply,
 * nothing persisted. A different question from `diffYaml`'s ("what would
 * this change") even though both happen to dry-run under the hood: this
 * one only cares whether the API server would accept the manifest at
 * all, the cluster's own real schema (CRDs included) rather than a
 * bundled copy of it.
 */
async function validateYaml(spec = {}, { yaml } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const r = await runWithStdin(bin, [...baseArgs, 'apply', '--dry-run=server', '-f', '-'], yaml, { env, timeout: 20000 });
  return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'kubectl could not validate this' };
}

async function describe(spec = {}, { name, resource, namespace } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : spec);
  const r = await run(bin, [...baseArgs, 'describe', resource, name], { env, timeout: 20000 });
  return r.ok ? { ok: true, text: r.stdout } : { ok: false, error: plain(r.stderr) || 'kubectl describe failed' };
}

async function deleteResource(spec = {}, { name, resource, namespace } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : spec);
  const r = await run(bin, [...baseArgs, 'delete', resource, name], { env, timeout: 30000 });
  return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'kubectl delete failed' };
}

/** `kubectl cordon`/`uncordon` — standard node actions, unmarked as a separate "custom" step here. */
async function cordonNode(spec = {}, { name, uncordon = false } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const r = await run(bin, [...baseArgs, uncordon ? 'uncordon' : 'cordon', name], { env, timeout: 20000 });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || `kubectl ${uncordon ? 'un' : ''}cordon failed` };
}

/**
 * `kubectl drain` — cordons the node and evicts every pod on it.
 * `--ignore-daemonsets` and `--delete-emptydir-data` are not optional
 * here: without the first a DaemonSet pod blocks the drain forever (it is
 * meant to run on every node), and without the second a pod using an
 * emptyDir volume does too — both are the sensible default for exactly
 * this reason, not a shortcut taken here.
 */
async function drainNode(spec = {}, { name, force = false, timeoutSeconds = 120 } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const args = [...baseArgs, 'drain', name, '--ignore-daemonsets', '--delete-emptydir-data', `--timeout=${timeoutSeconds}s`];
  if (force) args.push('--force');
  const r = await run(bin, args, { env, timeout: (timeoutSeconds + 30) * 1000 });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || 'kubectl drain failed' };
}

/** `kubectl auth can-i <verb> <resource>` — the cheap way to ask whether an action is even allowed. */
async function canI(spec = {}, { verb, resource, namespace, asUser, asGroups, allNamespaces = false } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : spec);
  const impersonate = [
    ...(asUser ? ['--as=' + asUser] : []),
    ...(asGroups || []).filter(Boolean).map((g) => '--as-group=' + g),
  ];
  // -A: "in every namespace", the question a list across all of them asks.
  const scope = allNamespaces && !namespace ? ['-A'] : [];
  const r = await run(bin, [...baseArgs, 'auth', 'can-i', verb, resource, ...scope, ...impersonate], { env, timeout: 10000 });
  const out = plain(r.stdout).toLowerCase();
  // can-i exits 1 for a plain "no" — only an empty answer with an error
  // beside it means the question itself could not be asked.
  const unknown = !out && !!plain(r.stderr);
  return { ok: true, allowed: r.ok && out.startsWith('yes'), unknown, noAccess: !!r.noAccess, error: unknown ? plain(r.stderr) : undefined };
}

/*
 * "What can I do here?" `kubectl auth can-i --list` would answer it in one
 * call, but through Teleport it needs selfsubjectrulesreviews, which most
 * roles do not grant — a single can-i (a SelfSubjectAccessReview) is
 * allowed, so the answer is asked one question at a time over the
 * resources people actually touch. Cluster-scoped kinds are asked without
 * a namespace.
 */
const ACCESS_VERBS = ['get', 'list', 'create', 'update', 'delete'];
const ACCESS_RESOURCES = [
  { resource: 'pods' }, { resource: 'deployments' }, { resource: 'statefulsets' }, { resource: 'daemonsets' },
  { resource: 'jobs' }, { resource: 'services' }, { resource: 'ingresses' }, { resource: 'configmaps' },
  { resource: 'secrets' }, { resource: 'persistentvolumeclaims' }, { resource: 'events' },
  { resource: 'namespaces', cluster: true }, { resource: 'nodes', cluster: true },
];
// Subresources with one verb that matters each.
const ACCESS_EXTRA = [{ resource: 'pods/exec', verb: 'create' }, { resource: 'pods/log', verb: 'get' }];

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/**
 * Who the cluster sees, and a can-i grid. Identity from `auth whoami` when
 * the cluster allows it, else from the Teleport profile's own kubernetes
 * users/groups (`teleportProxy` says which profile).
 */
async function access(spec = {}, { namespace, teleportProxy, asUser, asGroups } = {}) {
  let identity = null;
  // Impersonating someone else for this grid means the grid is about
  // them, not "me" — asking `auth whoami` (which can't speak for another
  // identity) would just be misleading here.
  if (asUser || asGroups?.length) {
    identity = { source: 'impersonated', users: asUser ? [asUser] : [], groups: asGroups || [] };
  }
  if (!identity) {
    const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
    const r = await run(bin, [...baseArgs, 'auth', 'whoami', '-o', 'json'], { env, timeout: 10000 });
    if (r.ok) {
      try {
        const u = JSON.parse(r.stdout)?.status?.userInfo || {};
        identity = { source: 'cluster', users: u.username ? [u.username] : [], groups: u.groups || [] };
      } catch { /* not JSON: fall through to the Teleport answer */ }
    }
  }
  if (!identity && teleportProxy) {
    const teleport = require('./teleport');
    const bare = (s) => String(s || '').replace(/^https?:\/\//, '').replace(/:443$/, '');
    const st = await teleport.status().catch(() => null);
    const p = (st?.profiles || []).find((x) => bare(x.proxy) === bare(teleportProxy));
    if (p) identity = { source: 'teleport', users: p.kubeUsers || [], groups: p.kubeGroups || [], teleportUser: p.username, roles: p.roles || [] };
  }
  const checks = [
    ...ACCESS_RESOURCES.flatMap((r) => ACCESS_VERBS.map((verb) => ({ ...r, verb }))),
    ...ACCESS_EXTRA,
  ];
  const answers = await mapLimit(checks, 8, (c) => canI(spec, { verb: c.verb, resource: c.resource, namespace: c.cluster ? undefined : namespace, asUser, asGroups }));
  const rights = checks.map((c, i) => ({ resource: c.resource, verb: c.verb, cluster: !!c.cluster, allowed: answers[i].allowed, unknown: answers[i].unknown }));
  return { ok: true, identity, rights, verbs: ACCESS_VERBS, namespace: namespace || null };
}

/**
 * A kind's full, untrimmed list — `getResources()`'s own fetch, minus the
 * row-shaping that throws everything but name/status/detail away. Roles
 * and Bindings need their actual `rules`/`subjects`/`roleRef`, which only
 * exist on the real objects.
 */
async function getRawList(spec = {}, { name, namespaced, namespace } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : { ...spec, namespace: null });
  const scope = !namespaced ? [] : namespace ? [] : ['-A'];
  const r = await run(bin, [...baseArgs, 'get', name, ...scope, '-o', 'json'], { env, timeout: 20000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || `kubectl get ${name} failed`, items: [] };
  try {
    const data = JSON.parse(r.stdout);
    return { ok: true, items: data.items || (data.metadata ? [data] : []) };
  } catch { return { ok: false, error: 'Unexpected output from kubectl', items: [] }; }
}

/**
 * Which cloud, from the cluster itself, as cheaply as it can be asked — on
 * connecting to it, not on a timer. The server's version first: an EKS or
 * GKE one says so (v1.35.9-eks-…, v1.35.8-gke.…), and any signed-in user
 * may read it. Only when that is not enough, the nodes: their providerID
 * and labels.
 */
async function detectProvider(spec = {}) {
  const kp = require('./kubeprovider');
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const ver = await run(bin, [...baseArgs, 'version', '-o', 'json', '--request-timeout=15s'], { env, timeout: 25000 });
  let version = '';
  try { version = JSON.parse(ver.stdout || '{}').serverVersion?.gitVersion || ''; } catch { version = ''; }
  if (!version) return { ok: false, provider: null, error: plain(ver.stderr || '') || 'Could not reach the cluster' };
  let provider = kp.fromCluster({ version });
  if (!provider) {
    const nodes = await getRawList(spec, { name: 'nodes', namespaced: false });
    provider = kp.fromCluster({ nodes: nodes.items || [], version });
  }
  return { ok: true, provider, version };
}

/**
 * What the Cloud view shows (kubeprovider.js): the nodes, every service
 * account (for the ones mapped to a cloud identity), EKS's aws-auth, and the
 * server's version — read at once; each that the role may not read is said
 * rather than failing the rest.
 */
async function cloudInfo(spec = {}, { provider = null } = {}) {
  const kp = require('./kubeprovider');
  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace: null });
  const [nodes, sas, auth, ver] = await Promise.all([
    getRawList(spec, { name: 'nodes', namespaced: false }),
    getRawList(spec, { name: 'serviceaccounts', namespaced: true }),
    run(bin, [...baseArgs, '-n', 'kube-system', 'get', 'configmap', 'aws-auth', '-o', 'json'], { env, timeout: 20000 }),
    run(bin, [...baseArgs, 'version', '-o', 'json'], { env, timeout: 20000 }),
  ]);
  let awsAuth = null;
  if (auth.ok) { try { awsAuth = JSON.parse(auth.stdout); } catch { awsAuth = null; } }
  let version = '';
  try { version = JSON.parse(ver.stdout || '{}').serverVersion?.gitVersion || ''; } catch { version = ''; }
  const summary = kp.summarize({ provider, nodes: nodes.items, serviceAccounts: sas.items, awsAuth, version });
  return {
    ok: nodes.ok || sas.ok,
    ...summary,
    consoleUrl: kp.consoleUrl(summary.provider, spec.kubeClusterName || ''),
    problems: {
      nodes: nodes.ok ? '' : nodes.error,
      serviceAccounts: sas.ok ? '' : sas.error,
      // Most EKS clusters now use access entries; a missing aws-auth is ordinary.
      awsAuth: auth.ok ? '' : (/NotFound|not found/i.test(auth.stderr || '') ? 'none' : plain(auth.stderr || '')),
    },
  };
}

/**
 * "Who can do that?" — every Role/ClusterRole reachable from every
 * RoleBinding/ClusterRoleBinding, matched against one verb/resource the
 * same way the API server would (kuberbac.js). Cluster-scoped kinds are
 * always fetched; namespaced ones are scoped to `namespace` when given,
 * every namespace otherwise — a reverse lookup has no "just my own
 * namespace" default the way a forward can-i does.
 */
async function whoCan(spec = {}, { verb, resource, apiGroup, resourceName, namespace } = {}) {
  const kuberbac = require('./kuberbac');
  const [roles, clusterRoles, roleBindings, clusterRoleBindings] = await Promise.all([
    getRawList(spec, { name: 'roles', namespaced: true, namespace }),
    getRawList(spec, { name: 'clusterroles', namespaced: false }),
    getRawList(spec, { name: 'rolebindings', namespaced: true, namespace }),
    getRawList(spec, { name: 'clusterrolebindings', namespaced: false }),
  ]);
  const firstError = [roles, clusterRoles, roleBindings, clusterRoleBindings].find((r) => !r.ok);
  if (firstError) return { ok: false, error: firstError.error };
  const matches = kuberbac.whoCan({ verb, resource, apiGroup, resourceName }, {
    roles: roles.items, clusterRoles: clusterRoles.items, roleBindings: roleBindings.items, clusterRoleBindings: clusterRoleBindings.items,
  });
  return { ok: true, matches };
}

/**
 * Edit a Secret's decoded values without ever base64-encoding anything
 * here: a merge patch's `stringData` overwrites the matching `data` key
 * server-side (documented Kubernetes behaviour) — the same "let the API
 * server do it" reasoning the create form's own stringData already uses.
 * The JSON is one `execFile` argv element, not shell text, so nothing
 * about a secret's own content (quotes, newlines) needs escaping.
 */
async function patchSecretStringData(spec = {}, { name, namespace, stringData } = {}) {
  if (!name) return { ok: false, error: 'No secret given.' };
  if (!stringData || !Object.keys(stringData).length) return { ok: false, error: 'Nothing changed.' };
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : spec);
  const patch = JSON.stringify({ stringData });
  const r = await run(bin, [...baseArgs, 'patch', 'secret', name, '--type=merge', '--patch=' + patch], { env, timeout: 20000 });
  return r.ok ? { ok: true, output: plain(r.stdout) } : { ok: false, error: plain(r.stderr) || 'kubectl patch failed' };
}

/**
 * One representative check per rule — "does this actually work," not an
 * exhaustive permission audit. `*` stands for something concrete and
 * readable to actually ask about (`get`/`pods`) rather than being tested
 * literally, since `SelfSubjectAccessReview` has no wildcard verb or
 * resource of its own to ask with. Capped at 10: a smoke test, not a
 * report on every rule a very broad role might have.
 */
function sampleChecksFromRules(rules, namespace) {
  return (rules || []).slice(0, 10).map((rule) => {
    const verb = (rule.verbs || [])[0];
    const resource = (rule.resources || [])[0];
    if (!verb || !resource) return null;
    return { verb: verb === '*' ? 'get' : verb, resource: resource === '*' ? 'pods' : resource, namespace: namespace || undefined };
  }).filter(Boolean);
}

/** `kubectl top` for the overview: nodes, and pods busiest first. metrics-server is an add-on, so either may fail alone. */
async function top(spec = {}, { namespace } = {}) {
  const [nodes, pods] = await Promise.all([topNodes(spec), topPods(spec, { namespace })]);
  const milli = (v) => (/m$/.test(v || '') ? parseFloat(v) : parseFloat(v || 0) * 1000) || 0;
  if (pods.ok) pods.items.sort((a, b) => milli(b.cpu) - milli(a.cpu));
  return { ok: nodes.ok || pods.ok, nodes, pods };
}

module.exports = { cloudInfo, detectProvider,
  parseApiResources, categorize, discoverResourceTypes, getResources, getYaml, describe, deleteResource, canI, access, top,
  detailOf, conditionStatus, diffYaml, applyYaml, validateYaml, topPods, topNodes, topPodContainers, cordonNode, drainNode, getObject, crdColumnsFor, rowFrom, columnsFromCrdObject,
  getRawList, whoCan, patchSecretStringData, sampleChecksFromRules,
};
