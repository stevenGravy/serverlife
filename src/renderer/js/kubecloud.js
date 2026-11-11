import { state } from './state.js';
import { el } from './util.js';
import { toast, status, modal, field, textInput } from './ui.js';
// The detection itself, shared with the main process (plain functions, bundled here as sshoptions.js is).
import kp from '../../main/kubeprovider.js';

/*
 * Which cloud a Kubernetes cluster is on, shown and acted on (the detection
 * itself is main/kubeprovider.js): a small badge beside the ☸ — EKS, GKE,
 * AKS, or a local cluster — and the cluster browser's Cloud view, with the
 * things people go to their cloud's console for but can read from the
 * Kubernetes API: node groups and pools, the service accounts mapped to
 * cloud identities, EKS's aws-auth, and a link to the console page itself.
 *
 * What the cluster reveals when it is opened (its nodes say aws://, gce://,
 * azure://) is the surest answer, and it is remembered (settings.kubeProviders)
 * so the badge is right next time, before the cluster is opened again.
 */

/** One key for a cluster, however it is reached: through Teleport, or a kubeconfig context. */
export function providerKey(x = {}) {
  const proxy = String(x.teleportProxy || x.proxy || x.profile?.proxy || '').toLowerCase().replace(/:443$/, '');
  const name = x.kubeClusterName || (x.source === 'teleport' && !x.contextName ? x.name : '') || x.contextName || x.name || '';
  return proxy ? `tsh:${proxy}:${name}` : `ctx:${name}`;
}

export function learnedProvider(key) {
  return (state.settings.kubeProviders || {})[key] || null;
}

/** Keep what the cluster itself said, for the badge next time. Only a changed answer is written. */
export async function rememberProvider(key, p) {
  if (!key || !p?.provider || p.how !== 'cluster') return;
  const all = state.settings.kubeProviders || {};
  const slim = Object.fromEntries(Object.entries(p).filter(([k, v]) => ['provider', 'how', 'short', 'name', 'cloud', 'color', 'region', 'managed'].includes(k) && v !== undefined));
  if (JSON.stringify(all[key]) === JSON.stringify(slim)) return;
  state.settings = await window.api.settings.set({ kubeProviders: { ...all, [key]: slim } });
  state.emit('kubeContexts');
}

/*
 * Set by hand: a cluster nothing identified (or identified wrongly) marked
 * as EKS, GKE or AKS — with the details its console link needs, if given.
 * Kept in settings.kubeProviderTags, by the same key, and outranking every
 * detected answer.
 */
export function taggedProvider(key) {
  const t = (state.settings.kubeProviderTags || {})[key];
  if (!t?.provider || !kp.PROVIDERS[t.provider]) return null;
  return { ...kp.PROVIDERS[t.provider], ...t, how: 'manual' };
}

export async function setProviderTag(key, tag) {
  const all = { ...(state.settings.kubeProviderTags || {}) };
  if (tag?.provider) all[key] = Object.fromEntries(Object.entries(tag).filter(([, v]) => v));
  else delete all[key];
  state.settings = await window.api.settings.set({ kubeProviderTags: all });
  state.emit('kubeContexts');
}

/** The best answer for a row: yours, else the cluster's own (remembered), else the kubeconfig's or Teleport's, else a name's guess. */
export function providerFor(x, ...others) {
  const key = providerKey(x);
  // Anything with labels or a name says what it can — a requestable cluster's labels, say — under what was found already.
  const fromRow = kp.combine(kp.fromLabels(x?.labels || {}), kp.fromName(x?.kubeClusterName || x?.name || ''));
  const known = [taggedProvider(key), learnedProvider(key), x?.provider, ...others.map((o) => o?.provider), fromRow].filter(Boolean);
  const rank = { manual: 5, cluster: 4, kubeconfig: 3, labels: 3, name: 1 };
  const best = known.sort((a, b) => (rank[b.how] || 0) - (rank[a.how] || 0))[0] || null;
  if (!best) return null;
  // Details from the other answers for the same cloud fill in what the best one lacks.
  const out = { ...best };
  for (const k of known) {
    if (k.provider !== best.provider) continue;
    for (const f of ['region', 'account', 'project', 'location', 'resourceGroup', 'subscription', 'clusterName']) if (!out[f] && k[f]) out[f] = k[f];
  }
  return out;
}

/*
 * On connecting — expanding a cluster, opening its browser, logging in —
 * ask the cluster which cloud it is, once a run, unless that is already
 * known from the cluster or from you. One `kubectl version` (and the nodes
 * only if that is not enough); never on a timer, so a cluster with
 * per-session MFA is only asked when it is being used anyway.
 */
const asked = new Set();
export async function detectOnConnect(x, spec) {
  const key = providerKey(x);
  if (!spec?.contextName || asked.has(key) || taggedProvider(key) || learnedProvider(key)?.how === 'cluster') return;
  asked.add(key);
  const r = await window.api.kube.detectProvider({ spec }).catch(() => null);
  if (r?.provider) await rememberProvider(key, r.provider);
}

const HOW = { manual: 'set by you', cluster: 'seen on the cluster itself', kubeconfig: 'from the kubeconfig', labels: 'from its Teleport labels', name: 'guessed from its name' };

// What each cloud's console link needs, asked in Details….
const DETAIL_FIELDS = {
  eks: [['region', 'Region', 'us-west-2'], ['account', 'Account ID', '123456789012'], ['clusterName', 'EKS cluster name', 'my-cluster']],
  gke: [['project', 'Project ID', 'my-project'], ['location', 'Location (region or zone)', 'us-central1'], ['clusterName', 'GKE cluster name', 'my-cluster']],
  aks: [['subscription', 'Subscription ID', '00000000-0000-…'], ['resourceGroup', 'Resource group', 'my-rg'], ['region', 'Region', 'eastus'], ['clusterName', 'AKS cluster name', 'my-cluster']],
};

/** The details of a hand-set (or detected) cloud: what the console link and the badge's hover use. */
export async function editProviderDetails(x, provider) {
  const key = providerKey(x);
  const current = providerFor(x) || {};
  const fields = DETAIL_FIELDS[provider] || [];
  const inputs = Object.fromEntries(fields.map(([k, , ph]) => [k, textInput({ value: current.provider === provider ? current[k] || '' : '', placeholder: ph })]));
  const res = await modal({
    title: `${kp.PROVIDERS[provider]?.name || provider}: details`,
    subtitle: x.kubeClusterName || x.name || '',
    width: 'min(480px, 94vw)',
    render: (body) => body.append(
      el('div', { class: 'hint', style: 'margin-bottom:8px', text: 'All optional — they build the link to the cluster in its console, and show when you hover the badge.' }),
      ...fields.map(([k, label]) => field(label, inputs[k]))),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save', class: 'primary-btn', onClick: ({ close }) => close(Object.fromEntries(fields.map(([k]) => [k, inputs[k].value.trim()]))) },
    ],
  });
  if (!res) return;
  await setProviderTag(key, { provider, ...res });
}

/** The row menu's Cloud submenu: mark it as a cloud, its details, or back to detecting. */
export function cloudMenuItem(x) {
  const key = providerKey(x);
  const tag = taggedProvider(key);
  const now = providerFor(x);
  const pick = (id) => ({
    label: kp.PROVIDERS[id].name + (now?.provider === id ? (tag ? '  ✓ (set by you)' : '  ✓') : ''),
    onClick: () => setProviderTag(key, { ...(tag?.provider === id ? tag : {}), provider: id }),
  });
  return {
    label: 'Cloud', icon: '\u2601',
    title: 'Which cloud this cluster is on — set it by hand when it is not detected, or detected wrongly',
    submenu: [
      pick('eks'), pick('gke'), pick('aks'),
      { sep: true },
      pick('minikube'), pick('kind'), pick('docker-desktop'), pick('k3s'),
      { sep: true },
      now && ['eks', 'gke', 'aks'].includes(now.provider) ? { label: 'Details — region, account\u2026', onClick: () => editProviderDetails(x, now.provider) } : null,
      tag ? { label: 'Detect automatically', title: 'Forget what you set; use what is detected', onClick: () => setProviderTag(key, null) } : null,
    ].filter(Boolean),
  };
}

/** The badge: the provider's short name in its colour. A guess is outlined, not filled. */
export function providerBadge(p) {
  if (!p?.provider) return null;
  const guess = p.how === 'name';
  return el('span', {
    class: 'kprov' + (guess ? ' guess' : ''),
    style: `--kprov:${p.color || 'var(--accent)'}`,
    title: [p.name, p.region, p.account && `account ${p.account}`, p.project && `project ${p.project}`, p.resourceGroup && `resource group ${p.resourceGroup}`]
      .filter(Boolean).join(' · ') + ` — ${HOW[p.how] || ''}${guess ? ' (opening it confirms)' : ''}`,
    text: p.short,
  });
}

/* ------------------------------------------------------------------ */
/* The cluster browser's Cloud view                                    */
/* ------------------------------------------------------------------ */

const cellStyle = 'padding:4px 8px;border-bottom:1px solid var(--border-soft);vertical-align:top';
const table = (head, rows) => el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' },
  el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { style: cellStyle + ';text-align:left;color:var(--muted);font-weight:600', text: h })))),
  el('tbody', {}, ...rows));
const td = (content, extra = '') => el('td', { style: cellStyle + extra }, ...(Array.isArray(content) ? content : [content]));
const section = (title, ...body) => el('div', { style: 'margin:14px 0 6px' },
  el('div', { style: 'font-weight:600;margin-bottom:6px', text: title }), ...body);
const note = (text) => el('div', { class: 'hint', style: 'margin:4px 0', text });

const POOL_KIND = { nodegroup: 'managed node group', karpenter: 'Karpenter', auto: 'EKS Auto Mode', fargate: 'Fargate', 'self-managed': 'self-managed', nodepool: 'node pool', agentpool: 'agent pool', nodes: '' };
const IDENTITY_HEAD = { eks: 'IAM role (IRSA)', gke: 'Google service account', aks: 'Azure client ID' };

/**
 * The Cloud panel's contents, from window.api.kube.cloudInfo's answer.
 * `openPool(selector, label)` shows the Nodes list filtered to one pool.
 */
export function cloudPanel(info, { loading, error, known, clusterName, onRefresh, openPool, onTag } = {}) {
  // What you set wins over what the cluster says; otherwise the cluster's answer, then what was known before.
  const p = known?.how === 'manual' ? { ...(info?.provider || {}), ...known } : (info?.provider || known || null);
  const head = el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
    p ? providerBadge(p) : null,
    el('div', { style: 'font-size:15px;font-weight:600', text: p ? p.name : 'Not a cloud this knows' }),
    el('div', { class: 'hint', text: p ? (HOW[p.how] || '') : '' }),
    el('div', { style: 'flex:1' }),
    p && (p.region || p.project || p.resourceGroup) ? el('button', {
      class: 'ghost-btn sm', type: 'button', text: `Open in the ${p.cloud === 'local' ? '' : p.cloud + ' '}console`,
      title: 'The cluster’s page in its cloud console, in your browser',
      onClick: async () => {
        try { const url = await window.api.kube.openCloudConsole({ provider: p, clusterName }); status(`Opened ${url}`, 5000); }
        catch (e) { toast(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error', 8000); }
      },
    }) : null,
    // Nothing identified it: say which it is, by hand.
    !p && onTag ? el('span', { class: 'hint', text: 'Mark it as:' }) : null,
    ...(!p && onTag ? ['eks', 'gke', 'aks'].map((id) => el('button', { class: 'ghost-btn sm', type: 'button', text: kp.PROVIDERS[id].short, title: `Mark this cluster as ${kp.PROVIDERS[id].name}`, onClick: () => onTag(id) })) : []),
    el('button', { class: 'ghost-btn sm', type: 'button', text: loading ? 'Reading…' : 'Refresh', disabled: !!loading, onClick: onRefresh }));
  const facts = p ? el('div', { class: 'hint', style: 'margin-top:4px' }, [
    p.region && `Region ${p.region}`, p.location && p.location !== p.region && `Location ${p.location}`,
    p.account && `Account ${p.account}`, p.project && `Project ${p.project}`,
    p.subscription && `Subscription ${p.subscription}`, p.resourceGroup && `Resource group ${p.resourceGroup}`,
    info?.version && `Kubernetes ${info.version}`, info?.autopilot && 'GKE Autopilot',
    p.managed === false && 'Not the managed service — Kubernetes on this cloud’s machines',
  ].filter(Boolean).join(' · ')) : null;

  if (error) return el('div', { style: 'padding:12px' }, head, facts, note(error));
  if (!info) return el('div', { style: 'padding:12px' }, head, facts, note(loading ? 'Reading nodes, service accounts and cloud mappings…' : ''));

  const provider = p?.provider;
  const local = p?.cloud === 'local';
  const problems = info.problems || {};

  // Node groups and pools.
  const pools = info.pools || [];
  const poolRows = pools.map((pl) => el('tr', {
    style: pl.selector ? 'cursor:pointer' : '',
    title: pl.selector ? `Show these nodes (${pl.selector})` : '',
    onClick: () => pl.selector && openPool?.(pl.selector, `${pl.name} (${POOL_KIND[pl.kind] || 'pool'})`),
  },
    td([el('span', { style: 'font-weight:600', text: pl.name }), POOL_KIND[pl.kind] ? el('span', { class: 'tag', style: 'margin-left:6px', text: POOL_KIND[pl.kind] }) : null,
      pl.mode ? el('span', { class: 'tag', style: 'margin-left:4px', text: pl.mode }) : null]),
    td(el('span', { style: pl.ready < pl.nodes ? 'color:var(--amber)' : '', text: `${pl.ready}/${pl.nodes} ready` })),
    td(pl.types.join(', ') || '—'),
    td(pl.capacity.join(', ') || '—'),
    td(pl.zones.join(', ') || '—'),
    td(pl.versions.join(', ') || '—')));
  const poolTitle = provider === 'eks' ? 'Node groups' : provider === 'aks' ? 'Agent pools' : 'Node pools';
  const poolSection = section(`${poolTitle} (${info.readyNodes}/${info.nodes} nodes ready)`,
    problems.nodes ? note(`Could not read nodes: ${problems.nodes}`)
      : !pools.length ? note('No nodes your role can see — Teleport shows only the ones a role allows, so an empty list is not an empty cluster.')
        : table(['Pool', 'Ready', 'Machine type', 'Capacity', 'Zones', 'Kubelet'], poolRows),
    pools.length ? note('Click a pool for its nodes.') : null);

  // Cloud identities.
  const ids = info.identities || [];
  const idSection = local ? null : section(`Workload identity (${ids.length})`,
    problems.serviceAccounts ? note(`Could not read service accounts: ${problems.serviceAccounts}`)
      : !ids.length ? note(provider === 'eks' ? 'No service account has an eks.amazonaws.com/role-arn annotation (IRSA). EKS Pod Identity associations live in the AWS API, not Kubernetes.'
        : provider === 'gke' ? 'No service account has an iam.gke.io/gcp-service-account annotation (Workload Identity).'
          : provider === 'aks' ? 'No service account has an azure.workload.identity/client-id annotation (Workload Identity).'
            : 'No service account is mapped to a cloud identity.')
        : table(['Service account', IDENTITY_HEAD[provider] || 'Cloud identity', ''], ids.map((i) => el('tr', {},
          td(`${i.namespace}/${i.name}`),
          td(el('code', { style: 'font-size:11px;word-break:break-all', text: i.identity })),
          td(el('button', { class: 'ghost-btn sm', type: 'button', text: 'Copy', onClick: () => { window.api.clipboard.write(i.identity); status('Copied'); } }))))));

  // EKS: aws-auth.
  let authSection = null;
  if (provider === 'eks') {
    const maps = info.awsAuth;
    authSection = section('IAM → Kubernetes (aws-auth)',
      problems.awsAuth === 'none' || (!maps && !problems.awsAuth)
        ? note('No aws-auth ConfigMap — this cluster uses EKS access entries, which live in the AWS API rather than in Kubernetes.')
        : problems.awsAuth ? note(`Could not read kube-system/aws-auth: ${problems.awsAuth}`)
          : table(['IAM', 'Kubernetes user', 'Groups'], maps.map((m) => el('tr', {},
            td([el('span', { class: 'tag', style: 'margin-right:6px', text: m.kind }), el('code', { style: 'font-size:11px;word-break:break-all', text: m.arn })]),
            td(m.username || '—'),
            td((m.groups || []).join(', ') || '—')))));
  }

  return el('div', { style: 'padding:12px;overflow:auto' }, head, facts, poolSection, idSection, authSection);
}
