'use strict';
/**
 * KubeLife's write actions on workloads — the buttons every other client has
 * and the browser lacked: scale, rollout restart/status/history/undo,
 * pause/resume, set image/env/resources, run a CronJob now or suspend it,
 * force-delete, evict, delete several at once — plus the manifests the
 * "create" forms write.
 *
 * Each action is one kubectl argv built in one place, so the same function
 * answers "what would this run" (`preview: true`, for the dialog to show and
 * copy) and runs it — what is shown is what runs, the rule the Helm wizards
 * already follow (kube.js's commandPreview).
 */

const { execFile } = require('child_process');
const yaml = require('js-yaml');
const kube = require('./kube');
const kubebin = require('./kubebin');

function run(bin, args, { env, timeout = 60000, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => resolve(kubebin.explainMissing({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err })));
    if (stdin !== null) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  });
}

function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

/** `kubectl …` as text to read and copy — the context and namespace spelled out, values on a heredoc. */
function preview(args, { env, stdin = null } = {}) {
  const prefix = env?.KUBECONFIG ? `KUBECONFIG=${kube.shellQuote(env.KUBECONFIG)} ` : '';
  const cmd = prefix + ['kubectl', ...args].map(kube.shellQuote).join(' ');
  return stdin ? `${cmd} <<'YAML'\n${String(stdin).replace(/\n?$/, '\n')}YAML` : cmd;
}

/**
 * The one shape every action takes: build argv against a spec, then preview
 * or run it. `argsOf(ns)` returns the argv after `kubectl --context=…`.
 */
async function act(spec, { namespace, preview: wantPreview = false, stdin = null, timeout } = {}, argsOf) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : { ...spec, namespace: null });
  const argv = argsOf();
  if (!argv) return { ok: false, error: 'Nothing to do.' };
  // baseArgs may begin with "kubectl" itself (the tsh kubectl fallback); the
  // preview always reads as plain kubectl, which is what someone would type.
  const shown = baseArgs[0] === 'kubectl' ? baseArgs.slice(1) : baseArgs;
  if (wantPreview) return { ok: true, command: preview([...shown, ...argv], { env, stdin }) };
  const r = await run(bin, [...baseArgs, ...argv], { env, stdin, timeout });
  return r.ok ? { ok: true, output: plain(r.stdout) || plain(r.stderr) } : { ok: false, error: plain(r.stderr) || plain(r.stdout) || 'kubectl failed' };
}

const ref = (resource, name) => `${String(resource || '').toLowerCase()}/${name}`;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** `kubectl scale --replicas=N`. */
function scale(spec, { resource, name, namespace, replicas, preview: p } = {}) {
  const n = Number(replicas);
  if (!Number.isInteger(n) || n < 0) return Promise.resolve({ ok: false, error: 'Replicas must be a whole number, 0 or more.' });
  return act(spec, { namespace, preview: p }, () => ['scale', ref(resource, name), `--replicas=${n}`]);
}

const ROLLOUT = ['restart', 'status', 'history', 'undo', 'pause', 'resume'];
/** `kubectl rollout <action>` — undo can name the revision to go back to. */
function rollout(spec, { action, resource, name, namespace, revision, preview: p } = {}) {
  if (!ROLLOUT.includes(action)) return Promise.resolve({ ok: false, error: `Unknown rollout action "${action}".` });
  return act(spec, { namespace, preview: p, timeout: action === 'status' ? 20000 : 60000 }, () => {
    const a = ['rollout', action, ref(resource, name)];
    // status waits for the rollout by default; a dialog wants the answer now.
    if (action === 'status') a.push('--watch=false');
    if (action === 'undo' && revision) a.push(`--to-revision=${revision}`);
    return a;
  });
}

/** `kubectl rollout history` with each revision's change cause, parsed for a picker. */
async function rolloutHistory(spec, opts = {}) {
  const r = await rollout(spec, { ...opts, action: 'history' });
  if (!r.ok) return { ...r, revisions: [] };
  const revisions = r.output.split('\n').slice(1)
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ revision: Number(m[1]), cause: m[2].trim() === '<none>' ? '' : m[2].trim() }));
  return { ok: true, revisions, output: r.output };
}

/** `kubectl set image <ref> <container>=<image>`. */
function setImage(spec, { resource, name, namespace, container, image, preview: p } = {}) {
  if (!container || !image) return Promise.resolve({ ok: false, error: 'Pick a container and give an image.' });
  return act(spec, { namespace, preview: p }, () => ['set', 'image', ref(resource, name), `${container}=${image}`]);
}

/** `kubectl set env` — `set` is {NAME: value}, `unset` a list of names to remove (NAME-). */
function setEnv(spec, { resource, name, namespace, container, set = {}, unset = [], preview: p } = {}) {
  const pairs = Object.entries(set || {}).filter(([k]) => k).map(([k, v]) => `${k}=${v}`);
  const gone = (unset || []).filter(Boolean).map((k) => `${k}-`);
  if (!pairs.length && !gone.length) return Promise.resolve({ ok: false, error: 'No variables to set or remove.' });
  return act(spec, { namespace, preview: p }, () => [
    'set', 'env', ref(resource, name), ...(container ? [`--containers=${container}`] : []), ...pairs, ...gone,
  ]);
}

/** `kubectl set resources` — requests/limits as `cpu=…,memory=…`. */
function setResources(spec, { resource, name, namespace, container, requests = '', limits = '', preview: p } = {}) {
  if (!requests && !limits) return Promise.resolve({ ok: false, error: 'Give requests, limits, or both.' });
  return act(spec, { namespace, preview: p }, () => [
    'set', 'resources', ref(resource, name), ...(container ? [`--containers=${container}`] : []),
    ...(requests ? [`--requests=${requests}`] : []), ...(limits ? [`--limits=${limits}`] : []),
  ]);
}

/** What a workload's containers are now — the image and env and resources dialogs start from it. */
async function containersOf(spec, { resource, name, namespace } = {}) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespace ? { ...spec, namespace } : { ...spec, namespace: null });
  const r = await run(bin, [...baseArgs, 'get', ref(resource, name), '-o', 'json'], { env, timeout: 20000 });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl get failed', containers: [] };
  let d;
  try { d = JSON.parse(r.stdout); } catch { return { ok: false, error: 'Unexpected output from kubectl', containers: [] }; }
  const podSpec = d.kind === 'Pod' ? d.spec : d.kind === 'CronJob' ? d.spec?.jobTemplate?.spec?.template?.spec : d.spec?.template?.spec;
  const containers = (podSpec?.containers || []).map((c) => ({
    name: c.name, image: c.image || '',
    env: (c.env || []).filter((e) => e.value !== undefined).map((e) => ({ name: e.name, value: e.value })),
    envFrom: (c.env || []).filter((e) => e.valueFrom).map((e) => e.name),
    requests: c.resources?.requests || {}, limits: c.resources?.limits || {},
  }));
  return { ok: true, containers, replicas: d.spec?.replicas, paused: !!d.spec?.paused, suspend: !!d.spec?.suspend };
}

/** Run a CronJob now: `kubectl create job --from=cronjob/<name> <name>-manual-<time>`. */
function cronTrigger(spec, { name, namespace, jobName, preview: p } = {}) {
  const job = jobName || `${name}-manual-${Math.floor(Date.now() / 1000)}`.slice(0, 63).replace(/-+$/, '');
  if (!DNS_LABEL.test(job)) return Promise.resolve({ ok: false, error: `"${job}" is not a valid job name.` });
  return act(spec, { namespace, preview: p }, () => ['create', 'job', job, `--from=cronjob/${name}`]);
}

/** Suspend or resume a CronJob's schedule. */
function cronSuspend(spec, { name, namespace, suspend = true, preview: p } = {}) {
  return act(spec, { namespace, preview: p }, () => ['patch', 'cronjob', name, '--type=merge', '-p', JSON.stringify({ spec: { suspend: !!suspend } })]);
}

/**
 * Delete one or several, of one kind, in one kubectl call. `force` is the
 * stuck-pod case — `--grace-period=0 --force`, which removes it from the
 * API without waiting for the kubelet — and is only offered for pods.
 */
function deleteMany(spec, { resource, namespace, names = [], force = false, preview: p } = {}) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return Promise.resolve({ ok: false, error: 'Nothing selected.' });
  return act(spec, { namespace, preview: p, timeout: 120000 }, () => [
    'delete', String(resource).toLowerCase(), ...list, ...(force ? ['--grace-period=0', '--force'] : ['--wait=false']),
  ]);
}

/** Evict a pod through the Eviction API — what drain does, so a PodDisruptionBudget is respected. */
function evict(spec, { name, namespace, preview: p } = {}) {
  const body = JSON.stringify({ apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name, namespace } });
  return act(spec, { namespace, preview: p, stdin: body }, () => [
    'create', '--raw', `/api/v1/namespaces/${namespace}/pods/${name}/eviction`, '-f', '-',
  ]);
}

/*
 * The "create" forms: a small set of fields in, a complete manifest out —
 * shown as YAML before it is applied (through the browser's existing apply
 * flow, diff and all), so the form is a quicker way to the same file, not a
 * second, hidden way of changing the cluster.
 */
function manifestFor(kind, f = {}) {
  const ns = f.namespace || 'default';
  const labels = { app: f.name || 'app' };
  const kv = (text) => Object.fromEntries(String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  let doc;
  if (kind === 'Deployment') {
    const port = Number(f.port) || null;
    doc = {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: f.name, namespace: ns, labels },
      spec: {
        replicas: Number(f.replicas) >= 0 ? Number(f.replicas) : 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [{
              name: f.name, image: f.image,
              ...(port ? { ports: [{ containerPort: port }] } : {}),
              ...(Object.keys(kv(f.env)).length ? { env: Object.entries(kv(f.env)).map(([name, value]) => ({ name, value })) } : {}),
            }],
          },
        },
      },
    };
  } else if (kind === 'Service') {
    doc = {
      apiVersion: 'v1', kind: 'Service', metadata: { name: f.name, namespace: ns },
      spec: {
        type: f.type || 'ClusterIP',
        selector: Object.keys(kv(f.selector)).length ? kv(f.selector) : { app: f.name },
        ports: [{ port: Number(f.port) || 80, targetPort: Number(f.targetPort) || Number(f.port) || 80 }],
      },
    };
  } else if (kind === 'ConfigMap') {
    doc = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: f.name, namespace: ns }, data: kv(f.data) };
  } else if (kind === 'Secret') {
    // stringData: the API server does the base64, so the form never shows an encoded value.
    doc = { apiVersion: 'v1', kind: 'Secret', metadata: { name: f.name, namespace: ns }, type: f.type || 'Opaque', stringData: kv(f.data) };
  } else if (kind === 'Role' || kind === 'ClusterRole') {
    const rules = parseRules(f.rules);
    if (!rules.length) return { ok: false, error: 'At least one rule is needed — pick a common need, or fill in VERBS | APIGROUPS | RESOURCES.' };
    doc = kind === 'Role'
      ? { apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: { name: f.name, namespace: ns }, rules }
      : { apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: { name: f.name }, rules };
  } else if (kind === 'RoleBinding' || kind === 'ClusterRoleBinding') {
    const subjects = parseSubjects(f.subjects, ns);
    if (!subjects.length) return { ok: false, error: 'At least one subject is needed — one per line, KIND:name (a ServiceAccount also needs :namespace).' };
    if (!f.roleRefName) return { ok: false, error: 'A Role or ClusterRole to bind is needed.' };
    const roleRefKind = f.roleRefKind || 'Role';
    // A real Kubernetes constraint, not a preference: a ClusterRoleBinding
    // can only ever name a ClusterRole — the API server itself refuses a
    // namespaced Role there, since nothing says *which* namespace's Role.
    if (kind === 'ClusterRoleBinding' && roleRefKind !== 'ClusterRole') {
      return { ok: false, error: 'A ClusterRoleBinding can only bind a ClusterRole, not a namespaced Role.' };
    }
    const roleRef = { apiGroup: 'rbac.authorization.k8s.io', kind: roleRefKind, name: f.roleRefName };
    doc = kind === 'RoleBinding'
      ? { apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: { name: f.name, namespace: ns }, subjects, roleRef }
      : { apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: { name: f.name }, subjects, roleRef };
  } else {
    return { ok: false, error: `No form for ${kind}.` };
  }
  if (!DNS_LABEL.test(f.name || '')) return { ok: false, error: `"${f.name || ''}" is not a valid name — lowercase letters, digits and "-".` };
  if (kind === 'Deployment' && !f.image) return { ok: false, error: 'A Deployment needs an image.' };
  return { ok: true, yaml: yaml.dump(doc, { lineWidth: -1 }) };
}

/**
 * One rule per line: `VERBS | APIGROUPS | RESOURCES`, comma-separated
 * within each part — the same mini-syntax a preset fills in and a
 * hand-written rule uses, so manifestFor() only ever parses one shape
 * regardless of where the text came from. A blank APIGROUPS segment
 * means the core group (`""`, kept rather than dropped — a PolicyRule's
 * `apiGroups: []` means "nothing", not "core"); `*` means any.
 */
function parseRules(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [verbsPart, groupsPart, resourcesPart] = line.split('|');
    return {
      verbs: String(verbsPart || '').split(',').map((s) => s.trim()).filter(Boolean),
      apiGroups: String(groupsPart ?? '').split(',').map((s) => s.trim()),
      resources: String(resourcesPart || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
  }).filter((r) => r.verbs.length && r.resources.length);
}

/** One subject per line: a bare name (a User), `KIND:name`, or `ServiceAccount:name:namespace` (falls back to the binding's own namespace). */
function parseSubjects(text, fallbackNamespace) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const parts = line.split(':').map((s) => s.trim());
    const [kindPart, namePart, nsPart] = parts.length === 1 ? ['User', parts[0]] : parts;
    const kind = kindPart || 'User';
    const subject = { kind, name: namePart || '' };
    if (kind === 'ServiceAccount') subject.namespace = nsPart || fallbackNamespace;
    return subject;
  }).filter((s) => s.name);
}

/*
 * Mapping a Teleport user's Kubernetes group to cluster permissions — the
 * two halves Teleport's own Kubernetes access-control docs describe.
 *
 * In the cluster: Teleport's Kubernetes Service talks to the API server by
 * impersonating the user and groups a role allows (kubernetes_users,
 * kubernetes_groups), and those groups mean nothing until a binding gives
 * them a role — "If they do not exist in the cluster, Kubernetes RBAC will
 * ignore them." So: a ClusterRoleBinding for the whole cluster, or one
 * RoleBinding per namespace that grants the same ClusterRole only there.
 *
 * In Teleport: a role whose spec.allow.kubernetes_groups names that group,
 * kubernetes_labels choosing which clusters it applies to, and (role v8)
 * kubernetes_resources narrowing it to the namespaces bound. Written out to
 * copy or save, never applied from here — creating Teleport roles is an
 * admin's call, through tctl.
 */
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
function bindingName(group, clusterRole) {
  return `teleport-${group}-${clusterRole}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 253);
}

function groupBinding({ group, clusterRole, namespaces = [], name } = {}) {
  const g = String(group || '').trim();
  const role = String(clusterRole || '').trim();
  if (!g) return { ok: false, error: 'Name the group.' };
  if (/\s/.test(g)) return { ok: false, error: 'A group name has no spaces.' };
  if (!role) return { ok: false, error: 'Pick a ClusterRole.' };
  const bind = (name || bindingName(g, role)).trim();
  if (!K8S_NAME.test(bind)) return { ok: false, error: `"${bind}" is not a valid binding name — lowercase letters, digits, "-" and ".".` };
  const subjects = [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g }];
  const roleRef = { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role };
  const labels = { 'app.kubernetes.io/managed-by': 'serverlife', 'serverlife.teleport/group': g.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 63) };
  const docs = (namespaces || []).filter(Boolean).length
    ? namespaces.filter(Boolean).map((ns) => ({
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: bind, namespace: ns, labels }, roleRef, subjects,
    }))
    : [{ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: bind, labels }, roleRef, subjects }];
  return { ok: true, yaml: docs.map((d) => yaml.dump(d, { lineWidth: -1, noRefs: true })).join('---\n'), count: docs.length, scope: docs[0].kind };
}

/** The Teleport role to go with it — the group under spec.allow.kubernetes_groups. */
function teleportRoleFor({ group, roleName, clusterLabels = {}, kubeClusterName, namespaces = [] } = {}) {
  const g = String(group || '').trim();
  if (!g) return { ok: false, error: 'Name the group.' };
  const name = (roleName || `kube-${g}`).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  // Labels this cluster really has (from tsh kube ls); without any, every
  // cluster — narrow it before using it on a production Teleport cluster.
  const labels = Object.fromEntries(Object.entries(clusterLabels || {}).filter(([k]) => k && !k.startsWith('teleport.internal/') && !k.startsWith('teleport.dev/')));
  const ns = (namespaces || []).filter(Boolean);
  const role = {
    kind: 'role', version: 'v8', metadata: { name, description: `Kubernetes group "${g}"${kubeClusterName ? ` on ${kubeClusterName}` : ''} — made with ServerLife` },
    spec: {
      allow: {
        kubernetes_labels: Object.keys(labels).length ? labels : { '*': '*' },
        kubernetes_groups: [g],
        // v8: plural kinds and an api_group; '*' everywhere is "whatever the
        // group is bound to" — Kubernetes RBAC still decides what that is.
        kubernetes_resources: (ns.length ? ns : ['*']).map((n) => ({ kind: '*', namespace: n, name: '*', api_group: '*', verbs: ['*'] })),
      },
      deny: {},
    },
  };
  return { ok: true, name, yaml: yaml.dump(role, { lineWidth: -1, noRefs: true }), broadLabels: !Object.keys(labels).length };
}

module.exports = {
  scale, rollout, rolloutHistory, setImage, setEnv, setResources, containersOf,
  cronTrigger, cronSuspend, deleteMany, evict, manifestFor, preview, ROLLOUT, parseRules, parseSubjects,
  groupBinding, teleportRoleFor, bindingName,
};
