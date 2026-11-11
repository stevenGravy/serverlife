'use strict';

/*
 * Which cloud a Kubernetes cluster runs on — Amazon EKS, Google GKE, Azure
 * AKS, or a local one (minikube, kind, Docker Desktop, k3s) — and, once the
 * cluster can be read, what is worth knowing about it that only makes sense
 * on that cloud: its node groups/pools, the service accounts mapped to cloud
 * identities, EKS's aws-auth mappings, and where it is in the cloud console.
 *
 * Asked of the cheapest evidence first and trusted in that order:
 *   - the kubeconfig: an EKS or AKS endpoint, GKE's and EKS's context names,
 *     the credential plugin (aws eks get-token, gke-gcloud-auth-plugin,
 *     kubelogin);
 *   - Teleport's labels for a cluster it discovered or was told about —
 *     teleport.dev/cloud, `cloud`, tags copied in as aws/… or azure/…;
 *   - the cluster itself, when opened: nodes' providerID (aws://, gce://,
 *     azure://) and their labels, and the server version (…-eks-…, …-gke.…);
 *   - last, its name (prod-eks), said as a guess.
 * Nothing here calls a cloud API: it is all kubeconfig, Teleport and the
 * Kubernetes API, read-only.
 */

const PROVIDERS = {
  eks: { short: 'EKS', name: 'Amazon EKS', cloud: 'AWS', color: '#ff9900' },
  gke: { short: 'GKE', name: 'Google GKE', cloud: 'Google Cloud', color: '#4285f4' },
  aks: { short: 'AKS', name: 'Azure AKS', cloud: 'Azure', color: '#0078d4' },
  minikube: { short: 'mk', name: 'minikube', cloud: 'local', color: '#326ce5' },
  kind: { short: 'kind', name: 'kind', cloud: 'local', color: '#326ce5' },
  'docker-desktop': { short: 'DD', name: 'Docker Desktop', cloud: 'local', color: '#1d63ed' },
  k3s: { short: 'k3s', name: 'k3s', cloud: 'local', color: '#ffc61c' },
};

// What you set by hand outranks everything: you know which cloud it is.
const CONFIDENCE = { manual: 5, kubeconfig: 3, labels: 3, cluster: 4, name: 1 };

function result(provider, how, extra = {}) {
  if (!provider) return null;
  const out = { provider, how, ...PROVIDERS[provider] };
  for (const [k, v] of Object.entries(extra)) if (v) out[k] = v;
  return out;
}

/** `arn:aws:eks:us-west-2:123456789012:cluster/name` → its parts. */
function parseEksArn(s) {
  const m = String(s || '').match(/^arn:aws(?:-[a-z]+)*:eks:([a-z0-9-]+):(\d{12}):cluster\/(.+)$/);
  return m ? { region: m[1], account: m[2], clusterName: m[3] } : null;
}

/** An argument's value from an exec plugin's args: `--region x` or `--region=x`. */
function argValue(args, ...names) {
  const list = Array.isArray(args) ? args.map(String) : [];
  for (let i = 0; i < list.length; i++) {
    for (const n of names) {
      if (list[i] === n && i + 1 < list.length) return list[i + 1];
      if (list[i].startsWith(n + '=')) return list[i].slice(n.length + 1);
    }
  }
  return '';
}

/** From a kubeconfig context: its name, its cluster's server, and its user's exec plugin. */
function fromKubeconfig({ contextName = '', clusterName = '', server = '', exec = null } = {}) {
  const cmd = String(exec?.command || '').split('/').pop();
  const args = exec?.args || [];
  const arn = parseEksArn(contextName) || parseEksArn(clusterName);
  if (arn) return result('eks', 'kubeconfig', arn);
  const eksHost = String(server).match(/\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.eks\.amazonaws\.com(?:\.cn)?(?::\d+)?\/?$/i);
  if (eksHost || (cmd === 'aws' && args.includes('eks')) || cmd === 'aws-iam-authenticator') {
    return result('eks', 'kubeconfig', {
      region: eksHost?.[1] || argValue(args, '--region'),
      clusterName: argValue(args, '--cluster-name', '-i', '--cluster-id'),
    });
  }
  const gke = String(contextName).match(/^gke_([^_]+)_([^_]+)_(.+)$/) || String(clusterName).match(/^gke_([^_]+)_([^_]+)_(.+)$/);
  if (gke) return result('gke', 'kubeconfig', { project: gke[1], location: gke[2], clusterName: gke[3] });
  if (cmd === 'gke-gcloud-auth-plugin' || /\.gke\.goog\b|container\.googleapis\.com/.test(server)) return result('gke', 'kubeconfig');
  const aksHost = String(server).match(/^https?:\/\/([^.]+)\.(?:hcp|privatelink)\.([a-z0-9]+)\.azmk8s\.io/i);
  if (aksHost || /\.azmk8s\.io/i.test(server) || cmd === 'kubelogin') {
    return result('aks', 'kubeconfig', { region: aksHost?.[2], clusterName: clusterName || contextName });
  }
  const local = fromLocalName(contextName) || fromLocalName(clusterName);
  if (local) return result(local, 'kubeconfig');
  return null;
}

function fromLocalName(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'minikube') return 'minikube';
  if (n === 'docker-desktop' || n === 'docker-for-desktop') return 'docker-desktop';
  if (/^kind-/.test(n)) return 'kind';
  if (/^k3d-|^k3s\b/.test(n)) return 'k3s';
  return null;
}

/** From the labels Teleport has for a cluster. */
function fromLabels(labels = {}) {
  const l = labels || {};
  const keys = Object.keys(l);
  const cloud = String(l['teleport.dev/cloud'] || l.cloud || l['cloud-provider'] || '').toLowerCase();
  const region = l.region || l['aws/region'] || l.location || l['gcp/location'] || l['azure/location'] || '';
  const extra = {
    region,
    account: l['account-id'] || l['aws/account-id'] || '',
    project: l['project-id'] || l['gcp/project-id'] || '',
    resourceGroup: l['resource-group'] || l['azure/resource-group'] || '',
    subscription: l['subscription-id'] || l['azure/subscription-id'] || '',
  };
  if (cloud === 'aws' || cloud === 'eks' || keys.some((k) => k.startsWith('aws/'))) return result('eks', 'labels', extra);
  if (cloud === 'gcp' || cloud === 'gke' || cloud === 'google' || keys.some((k) => k.startsWith('gcp/'))) return result('gke', 'labels', extra);
  if (cloud === 'azure' || cloud === 'aks' || keys.some((k) => k.startsWith('azure/'))) return result('aks', 'labels', extra);
  return null;
}

/** From a name alone — a guess, said as one. */
function fromName(name) {
  const n = String(name || '').toLowerCase();
  const local = fromLocalName(n);
  if (local) return result(local, 'name');
  if (/(^|[^a-z])eks([^a-z]|$)/.test(n)) return result('eks', 'name');
  if (/(^|[^a-z])gke([^a-z]|$)/.test(n)) return result('gke', 'name');
  if (/(^|[^a-z])aks([^a-z]|$)/.test(n)) return result('aks', 'name');
  return null;
}

/** From the cluster itself: its nodes (providerID, labels) and its version. */
function fromCluster({ nodes = [], version = '' } = {}) {
  const v = String(version || '');
  const ids = nodes.map((n) => String(n?.spec?.providerID || ''));
  const labelKeys = new Set(nodes.flatMap((n) => Object.keys(n?.metadata?.labels || {})));
  const label = (k) => nodes.map((n) => n?.metadata?.labels?.[k]).find(Boolean) || '';
  const region = label('topology.kubernetes.io/region') || label('failure-domain.beta.kubernetes.io/region');
  if (/-eks-/.test(v) || [...labelKeys].some((k) => k.startsWith('eks.amazonaws.com/')) || ids.some((i) => i.startsWith('aws://') && /eks|fargate/i.test(i))) return result('eks', 'cluster', { region });
  if (/-gke\./.test(v) || [...labelKeys].some((k) => k.startsWith('cloud.google.com/gke-'))) return result('gke', 'cluster', { region });
  if ([...labelKeys].some((k) => k.startsWith('kubernetes.azure.com/')) || ids.some((i) => i.startsWith('azure://') && /aks|virtualMachineScaleSets/i.test(i))) return result('aks', 'cluster', { region });
  if (labelKeys.has('minikube.k8s.io/name')) return result('minikube', 'cluster');
  if (ids.some((i) => i.startsWith('kind://'))) return result('kind', 'cluster');
  if (/\+k3s/.test(v) || ids.some((i) => i.startsWith('k3s://'))) return result('k3s', 'cluster');
  if (nodes.some((n) => n?.metadata?.name === 'docker-desktop')) return result('docker-desktop', 'cluster');
  // On a cloud but not its managed Kubernetes (kops, self-managed): say the cloud, not the service.
  if (ids.some((i) => i.startsWith('aws://'))) return { ...result('eks', 'cluster', { region }), short: 'AWS', name: 'Kubernetes on AWS', managed: false };
  if (ids.some((i) => i.startsWith('gce://'))) return { ...result('gke', 'cluster', { region }), short: 'GCP', name: 'Kubernetes on Google Cloud', managed: false };
  if (ids.some((i) => i.startsWith('azure://'))) return { ...result('aks', 'cluster', { region }), short: 'Azure', name: 'Kubernetes on Azure', managed: false };
  return null;
}

/**
 * The best answer from what is known: the most trusted source names the
 * provider, and the details (region, account, project…) are pooled from
 * every source that agrees with it.
 */
function combine(...answers) {
  const found = answers.filter(Boolean);
  if (!found.length) return null;
  const best = found.slice().sort((a, b) => (CONFIDENCE[b.how] || 0) - (CONFIDENCE[a.how] || 0))[0];
  const out = { ...best };
  for (const a of found) {
    if (a.provider !== best.provider) continue;
    for (const k of ['region', 'account', 'project', 'location', 'resourceGroup', 'subscription', 'clusterName']) if (!out[k] && a[k]) out[k] = a[k];
  }
  out.guess = best.how === 'name';
  return out;
}

/** The cluster's page in its cloud's console, when enough is known to build one. */
function consoleUrl(p, clusterName = '') {
  if (!p) return '';
  const name = encodeURIComponent(p.clusterName || clusterName || '');
  if (!name) return '';
  if (p.provider === 'eks' && p.region && p.managed !== false) {
    const host = /^us-gov-/.test(p.region) ? 'console.amazonaws-us-gov.com' : 'console.aws.amazon.com';
    return `https://${host}/eks/home?region=${p.region}#/clusters/${name}`;
  }
  if (p.provider === 'gke' && p.project && (p.location || p.region) && p.managed !== false) {
    return `https://console.cloud.google.com/kubernetes/clusters/details/${p.location || p.region}/${name}/details?project=${encodeURIComponent(p.project)}`;
  }
  if (p.provider === 'aks' && p.subscription && p.resourceGroup && p.managed !== false) {
    return `https://portal.azure.com/#@/resource/subscriptions/${p.subscription}/resourceGroups/${encodeURIComponent(p.resourceGroup)}/providers/Microsoft.ContainerService/managedClusters/${name}/overview`;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* What is worth knowing once the cluster can be read                  */
/* ------------------------------------------------------------------ */

const L = (n, k) => n?.metadata?.labels?.[k] || '';
const ready = (n) => (n?.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');

/** Which pool a node is in, and what kind of capacity, on its provider. */
function poolOf(n, provider) {
  if (provider === 'eks') {
    // `selector` is the label that picks this pool's nodes out — for the Nodes list, filtered to it.
    if (L(n, 'eks.amazonaws.com/compute-type') === 'fargate') return { pool: 'Fargate', kind: 'fargate', capacity: 'Fargate', selector: 'eks.amazonaws.com/compute-type=fargate' };
    if (L(n, 'karpenter.sh/nodepool') || L(n, 'karpenter.sh/provisioner-name')) {
      const key = L(n, 'karpenter.sh/nodepool') ? 'karpenter.sh/nodepool' : 'karpenter.sh/provisioner-name';
      return { pool: L(n, key), kind: 'karpenter', capacity: L(n, 'karpenter.sh/capacity-type'), selector: `${key}=${L(n, key)}` };
    }
    if (L(n, 'eks.amazonaws.com/compute-type') === 'auto' || L(n, 'eks.amazonaws.com/nodepool')) {
      return { pool: L(n, 'eks.amazonaws.com/nodepool') || 'Auto Mode', kind: 'auto', capacity: L(n, 'karpenter.sh/capacity-type'), selector: L(n, 'eks.amazonaws.com/nodepool') ? `eks.amazonaws.com/nodepool=${L(n, 'eks.amazonaws.com/nodepool')}` : 'eks.amazonaws.com/compute-type=auto' };
    }
    if (L(n, 'eks.amazonaws.com/nodegroup')) return { pool: L(n, 'eks.amazonaws.com/nodegroup'), kind: 'nodegroup', capacity: L(n, 'eks.amazonaws.com/capacityType'), selector: `eks.amazonaws.com/nodegroup=${L(n, 'eks.amazonaws.com/nodegroup')}` };
    return { pool: 'self-managed', kind: 'self-managed', capacity: '', selector: '!eks.amazonaws.com/nodegroup,!karpenter.sh/nodepool' };
  }
  if (provider === 'gke') {
    const spot = L(n, 'cloud.google.com/gke-spot') === 'true' ? 'Spot' : L(n, 'cloud.google.com/gke-preemptible') === 'true' ? 'Preemptible' : 'Standard';
    const pool = L(n, 'cloud.google.com/gke-nodepool');
    return { pool: pool || 'default', kind: 'nodepool', capacity: spot, selector: pool ? `cloud.google.com/gke-nodepool=${pool}` : '' };
  }
  if (provider === 'aks') {
    const key = L(n, 'kubernetes.azure.com/agentpool') ? 'kubernetes.azure.com/agentpool' : 'agentpool';
    return {
      pool: L(n, key) || 'default', kind: 'agentpool',
      capacity: L(n, 'kubernetes.azure.com/scalesetpriority') === 'spot' ? 'Spot' : 'Regular',
      mode: L(n, 'kubernetes.azure.com/mode'), selector: L(n, key) ? `${key}=${L(n, key)}` : '',
    };
  }
  return { pool: 'nodes', kind: 'nodes', capacity: '', selector: '' };
}

/** Node pools: what each holds, how much of it is ready, on what machines and where. */
function nodePools(nodes = [], provider) {
  const pools = new Map();
  for (const n of nodes) {
    const p = poolOf(n, provider);
    const key = `${p.kind}:${p.pool}`;
    if (!pools.has(key)) pools.set(key, { name: p.pool, kind: p.kind, mode: p.mode || '', selector: p.selector || '', capacity: new Set(), types: new Set(), zones: new Set(), versions: new Set(), arch: new Set(), nodes: 0, ready: 0 });
    const e = pools.get(key);
    e.nodes++;
    if (ready(n)) e.ready++;
    if (p.capacity) e.capacity.add(p.capacity);
    const t = L(n, 'node.kubernetes.io/instance-type') || L(n, 'beta.kubernetes.io/instance-type');
    if (t) e.types.add(t);
    const z = L(n, 'topology.kubernetes.io/zone') || L(n, 'failure-domain.beta.kubernetes.io/zone');
    // AKS says "0" for a pool that is not spread across zones: no zone, not one called 0.
    if (z && !/^\d+$/.test(z)) e.zones.add(z);
    if (n?.status?.nodeInfo?.kubeletVersion) e.versions.add(n.status.nodeInfo.kubeletVersion);
    if (L(n, 'kubernetes.io/arch')) e.arch.add(L(n, 'kubernetes.io/arch'));
  }
  return [...pools.values()].map((e) => ({ ...e, capacity: [...e.capacity], types: [...e.types], zones: [...e.zones].sort(), versions: [...e.versions], arch: [...e.arch] }))
    .sort((a, b) => b.nodes - a.nodes || a.name.localeCompare(b.name));
}

/** Service accounts mapped to a cloud identity: IRSA, GKE Workload Identity, Azure Workload Identity. */
function cloudIdentities(serviceAccounts = []) {
  const out = [];
  for (const sa of serviceAccounts) {
    const a = sa?.metadata?.annotations || {};
    const at = { namespace: sa?.metadata?.namespace || '', name: sa?.metadata?.name || '' };
    if (a['eks.amazonaws.com/role-arn']) out.push({ ...at, cloud: 'eks', via: 'IRSA', identity: a['eks.amazonaws.com/role-arn'] });
    if (a['iam.gke.io/gcp-service-account']) out.push({ ...at, cloud: 'gke', via: 'Workload Identity', identity: a['iam.gke.io/gcp-service-account'] });
    if (a['azure.workload.identity/client-id']) out.push({ ...at, cloud: 'aks', via: 'Workload Identity', identity: a['azure.workload.identity/client-id'] });
  }
  return out.sort((x, y) => (x.namespace + x.name).localeCompare(y.namespace + y.name));
}

/** EKS's kube-system/aws-auth ConfigMap: which IAM roles and users are which Kubernetes users and groups. */
function awsAuthMappings(configMap) {
  if (!configMap?.data) return null;
  const yaml = require('js-yaml');
  const read = (k) => { try { return yaml.load(configMap.data[k] || '') || []; } catch { return []; } };
  const roles = read('mapRoles').map((r) => ({ kind: 'role', arn: r.rolearn || '', username: r.username || '', groups: r.groups || [] }));
  const users = read('mapUsers').map((u) => ({ kind: 'user', arn: u.userarn || '', username: u.username || '', groups: u.groups || [] }));
  const accounts = read('mapAccounts').map((a) => ({ kind: 'account', arn: String(a), username: '', groups: [] }));
  return [...roles, ...users, ...accounts];
}

/** Everything the Cloud view shows, from what was read of the cluster. */
function summarize({ provider: known = null, nodes = [], serviceAccounts = [], awsAuth = null, version = '' } = {}) {
  const seen = fromCluster({ nodes, version });
  const p = combine(known, seen) || null;
  const provider = p?.provider || null;
  const autopilot = provider === 'gke' && nodes.some((n) => Object.keys(n?.metadata?.labels || {}).some((k) => k.startsWith('autopilot.gke.io')));
  return {
    provider: p, version,
    nodes: nodes.length, readyNodes: nodes.filter(ready).length,
    pools: nodePools(nodes, provider),
    identities: cloudIdentities(serviceAccounts),
    awsAuth: provider === 'eks' ? awsAuthMappings(awsAuth) : null,
    autopilot,
  };
}

module.exports = {
  PROVIDERS, fromKubeconfig, fromLabels, fromName, fromCluster, combine, consoleUrl,
  nodePools, cloudIdentities, awsAuthMappings, summarize, parseEksArn,
};
