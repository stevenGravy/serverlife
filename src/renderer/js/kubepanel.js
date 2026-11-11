import { el, clear, clickOrDblClick } from './util.js';
import { state } from './state.js';
import { toast, contextMenu, modal, select, textInput, field, checkbox, confirm, prompt } from './ui.js';
import { openLocalShell, splitActivePane, refreshPaneTitles } from './sessions.js';
import { openKubeBrowser } from './kubebrowser.js';
import { requestableHosts } from './requestable.js';
import { groupKeyFor } from './folders.js';
import { isWatched, toggleWatch } from './watch.js';
import { askNamespace, extraNamespaces } from './kubenamespaces.js';
import { providerFor, providerBadge, cloudMenuItem, detectOnConnect } from './kubecloud.js';

// Dynamic, not static: sidebar.js already imports this module, and a static
// import back would close the cycle — the same workaround sessions.js and
// explorer.js already use for the same reason.
async function sidebarHelpers() {
  const m = await import('./sidebar.js');
  return { isMfaHost: m.isMfaHost, setMfaHost: m.setMfaHost };
}

// labelSummary is needed inside plain (synchronous) render functions, where
// an awaited dynamic import has nowhere to go — resolved once, as early as
// possible, and cached here; a render before it resolves just shows no
// summary yet, corrected on the very next redraw.
let labelSummaryFn = null;
let showRequestableInFn = null;
import('./sidebar.js').then((m) => {
  labelSummaryFn = m.labelSummary;
  showRequestableInFn = m.showRequestableIn;
  state.emit('kubeContexts');
}).catch(() => {});

/**
 * KubeLife, inline in the Resources tab.
 *
 * Deliberately not a tab of its own, and deliberately not one flat list
 * either: a context tsh itself created with `tsh kube login` is reached
 * through a Teleport cluster exactly the way an SSH node is, so it belongs
 * in that cluster's own list — host-shaped (see kubeHostsForProfile) so it
 * falls into the same folders, the same label rules and the same filter box
 * sidebar.js's SSH nodes already use, not a second tree with its own rules
 * to learn. Only a context with no Teleport cluster behind it at all — a
 * raw EKS/GKE/kind context, reached with nothing but local credentials —
 * falls into the flat "Local kubeconfigs" group (kubeGroupRows), since there
 * is no SSH group for it to share. sidebar.js decides where each goes; this
 * module reads the kubeconfig, tells contexts apart, and draws the rows.
 *
 * The default kubeconfig location ($KUBECONFIG, or ~/.kube/config) is read
 * automatically — nothing to add by hand for the common case. "Add a
 * kubeconfig…" is for extra files beyond that default.
 *
 * None of this renders at all once state.settings.kubeEnabled is off.
 */

let contexts = [];
let loaded = false;
let loading = false;
let lastError = '';

/** Kicks off a read on first use; later calls just redraw from what's cached. */
function ensureLoaded() {
  if (loaded || loading) return;
  loading = true;
  window.api.kube.contexts({ extraPaths: state.settings.kubeconfigPaths || [] })
    .then((r) => {
      contexts = r?.contexts || [];
      lastError = r?.ok ? '' : (r?.error || 'Could not read kubeconfig contexts');
      if (r?.ok) rememberConnected();
    })
    .catch((e) => { contexts = []; lastError = e?.message || String(e); })
    .finally(() => { loading = false; loaded = true; state.emit('kubeContexts'); askReconnect(); });
}

/*
 * Reconnecting after a fresh login. `tsh logout` (and an expired login
 * cleaned up) takes the kube contexts tsh wrote with it, so logging back
 * in left every cluster that had been connected "not connected" again,
 * one `tsh kube login` click each. Which ones were connected is kept per
 * Teleport cluster (settings.kubeRemembered, bare proxy → kube cluster
 * names), and after a login — a profile whose certificate is new — any of
 * those missing are offered back, once per login, never done unasked.
 * Removing a context on purpose ("Remove from kubeconfig…") forgets it.
 */
const rememberedAll = () => state.settings.kubeRemembered || {};

function rememberConnected() {
  const all = rememberedAll();
  const next = { ...all };
  let changed = false;
  for (const c of contexts) {
    if (c.source !== 'teleport' || !c.teleportProxy || !c.kubeClusterName) continue;
    const key = bareProxy(c.teleportProxy);
    const list = next[key] || [];
    if (!list.includes(c.kubeClusterName)) { next[key] = [...list, c.kubeClusterName].sort(); changed = true; }
  }
  if (changed) window.api.settings.set({ kubeRemembered: next }).then((st) => { state.settings = st; }).catch(() => {});
}

async function forgetConnected(proxy, names) {
  const key = bareProxy(proxy);
  const all = rememberedAll();
  const list = (all[key] || []).filter((n) => !names.includes(n));
  state.settings = await window.api.settings.set({ kubeRemembered: { ...all, [key]: list } });
}

const loginSeen = new Map();   // bare proxy -> validUntil last seen
const askPending = new Set();  // bare proxies whose new login has not been asked about yet
let asking = false;

/** Called per profile on every sidebar render — cheap: it only notices a login it has not seen. */
function noticeLogin(p) {
  if (p.expired || !p.validUntil) return;
  const key = bareProxy(p.proxy);
  if (loginSeen.get(key) === p.validUntil) return;
  const first = !loginSeen.has(key);
  loginSeen.set(key, p.validUntil);
  askPending.add(key);
  // A new login can see different things: everything read for this cluster goes.
  if (!first) refreshKubeFor(p);
  // A login after the app was already up: the kubeconfig read is from
  // before it, so read again before deciding what is missing.
  if (!first) refreshKubeContexts();
  else askReconnect();
}

async function askReconnect() {
  if (asking || !loaded || loading || !askPending.size) return;
  const have = new Set(contexts.filter((c) => c.source === 'teleport' && c.teleportProxy)
    .map((c) => `${bareProxy(c.teleportProxy)}\u0001${c.kubeClusterName}`));
  for (const key of [...askPending]) {
    askPending.delete(key);
    const p = (state.teleportProfiles || []).find((x) => bareProxy(x.proxy) === key && !x.expired);
    if (!p) continue;
    const missing = (rememberedAll()[key] || []).filter((n) => !have.has(`${key}\u0001${n}`));
    if (!missing.length) continue;
    asking = true;
    try { await offerReconnect(p, missing); } finally { asking = false; }
  }
}

async function offerReconnect(p, missing) {
  const boxes = missing.map((n) => [n, checkbox(n, true)]);
  const choice = await modal({
    title: 'Reconnect Kubernetes clusters?',
    subtitle: p.cluster || p.proxy,
    render: (body) => body.append(
      el('div', { style: 'font-size:12px;margin-bottom:8px', text:
        `You were connected to ${missing.length === 1 ? 'this cluster' : 'these clusters'} on ${p.cluster || p.proxy} before logging in again. `
        + 'Run tsh kube login for the ones ticked?' }),
      ...boxes.map(([, cb]) => cb)),
    buttons: [
      { label: 'Don’t ask about these', value: 'forget' },
      { label: 'Not now', value: null },
      { label: 'Reconnect', value: 'go', class: 'primary-btn', autofocus: true },
    ],
  });
  const picked = boxes.filter(([, cb]) => cb.input.checked).map(([n]) => n);
  if (choice === 'forget') { await forgetConnected(p.proxy, missing); return; }
  if (choice !== 'go' || !picked.length) return;
  const failed = [];
  for (const name of picked) {
    const r = await window.api.kube.login({ proxy: p.proxy, home: p.homeDir, cluster: name }).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) failed.push(`${name}: ${r?.error || 'failed'}`);
  }
  refreshKubeContexts();
  if (failed.length) toast(`Could not reconnect ${failed.join('; ')}`, 'error');
  else toast(`Reconnected ${picked.length} Kubernetes cluster${picked.length === 1 ? '' : 's'} on ${p.cluster || p.proxy}`);
}

/**
 * A refresh of a Teleport cluster (its ⟳) or of everything (no profile)
 * is a refresh of its Kubernetes side too: what it offers (`tsh kube ls`),
 * what could be requested, the namespaces and pods already read, and the
 * kubeconfig — not only its SSH nodes, which left a newly joined kube
 * cluster missing until the cache aged out.
 */
export function refreshKubeFor(p = null) {
  if (p) {
    availableCache.delete(availableKey(p));
    kubeReqCache.delete(groupKeyFor(p));
    kubeReqCheck.delete(groupKeyFor(p));
    for (const c of contextsForProfile(p)) {
      namespacesCache.delete(c.id);
      for (const k of [...podsCache.keys()]) if (k.startsWith(c.id + '\u0001')) podsCache.delete(k);
    }
  } else {
    availableCache.clear(); kubeReqCache.clear(); kubeReqCheck.clear(); namespacesCache.clear(); podsCache.clear();
  }
  refreshKubeContexts();
}

/** Settings changed, or a kubeconfig was just added: read again, not from the stale cache. */
export function refreshKubeContexts() {
  loaded = false;
  ensureLoaded();
}

/*
 * Active port-forwards — kept current by push (kube:forwardUpdate, see
 * kubeforward.js's onChange hook), not by polling, so the sidebar's inline
 * list and the row/menu "running on :PORT" state are never stale behind
 * what actually started or stopped. One subscription for the life of the
 * app, the same top-level-side-effect idiom the dynamic sidebar.js import
 * just above already uses.
 */
let activeForwards = [];
window.api.kube.forwardList().then((r) => { activeForwards = r?.forwards || []; state.emit('kubeContexts'); }).catch(() => {});
window.api.kube.onForwardUpdate((r) => { activeForwards = r?.forwards || []; state.emit('kubeContexts'); });

/** Every active forward for one context — matched by contextName, the one field kubeforward.js's own id already encodes. */
function forwardsForContext(c) {
  return activeForwards.filter((f) => f.contextName === c.contextName);
}

function directContexts() {
  return contexts.filter((c) => c.source !== 'teleport');
}

/** A Teleport profile's own kube contexts — matched by cluster name, falling back to proxy. */
function contextsForProfile(p) {
  return contexts.filter((c) => c.source === 'teleport'
    && (c.teleportCluster === p.cluster || (!c.teleportCluster && c.teleportProxy === p.proxy)));
}

export function kubeCountForProfile(p) {
  return contextsForProfile(p).length;
}

/*
 * What a Teleport cluster *offers* (`tsh kube ls`) is a different question
 * from what is already in the local kubeconfig (listContexts, above) — a
 * cluster can have kube clusters nobody here has ever run `tsh kube login`
 * for, and those were invisible until this existed: kubeSectionRows only
 * ever showed what was already logged into, so a cluster with kube access
 * but no prior login looked like it had none.
 */
const availableCache = new Map(); // profile key -> { loading, error, clusters, at }
const AVAILABLE_RETRY_MS = 120000;
function availableKey(p) { return `${p.homeDir || ''}\u0001${p.proxy}`; }

/*
 * Called on every sidebar render, and the fetch's own kubeContexts emit is
 * one — so a failure has to count as an answer too, or it refetches the
 * moment it lands, forever. Worse on an expired profile: `tsh kube ls` there
 * does not just fail, it runs tsh's own relogin (SSO and an MFA tap) every
 * time. An expired profile is not asked at all; its login prompt is the
 * group's own, and a fresh profile is a different, unexpired object.
 */
function ensureAvailableLoaded(p) {
  if (p.expired) return;
  const key = availableKey(p);
  const entry = availableCache.get(key);
  if (entry?.loading) return;
  // A success is kept no longer than a failure: a kube cluster that joins
  // Teleport after the first read (a fresh agent install) has to turn up
  // without a restart. The old list stays drawn while it is read again.
  if (entry && Date.now() - (entry.at || 0) < AVAILABLE_RETRY_MS) return;
  availableCache.set(key, { ...(entry?.clusters ? { clusters: entry.clusters } : {}), loading: true });
  window.api.kube.clusters({ proxy: p.proxy, home: p.homeDir })
    .then((r) => availableCache.set(key, r?.ok
      ? { clusters: r.clusters || [], at: Date.now() }
      : { error: r?.error || 'Could not list kube clusters', unsupported: r?.unsupported, at: Date.now() }))
    .catch((e) => availableCache.set(key, { error: e?.message || String(e), at: Date.now() }))
    .finally(() => state.emit('kubeContexts'));
}

/** Available clusters not already represented by a logged-in context. */
function notYetConnected(p) {
  const mineNames = new Set(contextsForProfile(p).map((c) => c.kubeClusterName || c.name));
  const entry = availableCache.get(availableKey(p));
  return (entry?.clusters || []).filter((c) => !mineNames.has(c.name));
}

/**
 * A logged-in context (listContexts(), from the local kubeconfig) carries
 * no Teleport labels at all — the kubeconfig format has nowhere to put
 * them. tsh kube ls does carry them, and ensureAvailableLoaded() already
 * fetches that per profile for the "not yet connected" rows below, so a
 * connected cluster's labels are borrowed from that same cache by name
 * and proxy rather than fetched a second time.
 */
// `teleport.example.com` vs `teleport.example.com:443` vs
// `https://teleport.example.com/` are all the same proxy — tsh writes the
// exec plugin's --proxy= in whatever form was active at `tsh kube login`
// time, which is not always the exact string a profile's own .proxy field
// holds, so an exact-string match silently found nothing for some clusters
// and not others. Same normalisation teleport.js's own bareProxy() does.
const bareProxy = (p) => String(p || '').trim().toLowerCase()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '').replace(/:443$/, '');

function labelsForContext(c) {
  if (!c.teleportProxy) return null;
  const wanted = c.kubeClusterName || c.name;
  const wantedProxy = bareProxy(c.teleportProxy);
  for (const entry of availableCache.values()) {
    const found = (entry?.clusters || []).find((cl) => cl.name === wanted && bareProxy(cl.proxy) === wantedProxy);
    if (found) return found.labels;
  }
  return null;
}

/** The same "key +N" summary a Teleport node's row shows, or '' while nothing is known yet. */
function labelTag(labels) {
  if (!labelSummaryFn || !labels) return null;
  const text = labelSummaryFn({ labels });
  return text ? el('span', { class: 'tag', text }) : null;
}

/**
 * The one visible mark that a row is a Kubernetes cluster and not an SSH
 * host — needed now that kube rows sit loose in the same list as SSH ones
 * (see kubeHostsForProfile in sidebar.js) rather than under their own "☸
 * kubernetes" heading, which was the only thing saying so before.
 */
export function kubeIcon() {
  return el('span', { class: 'kube-ico', title: 'Kubernetes cluster', text: '☸' });
}

/** The Teleport cluster entry (tsh kube ls) a row stands for, if any — where its labels and their provider are. */
function teleportEntryFor(x) {
  const proxy = bareProxy(x?.teleportProxy || x?.proxy || x?.profile?.proxy || '');
  if (!proxy) return null;
  const wanted = x.kubeClusterName || x.name;
  for (const entry of availableCache.values()) {
    const found = (entry?.clusters || []).find((cl) => cl.name === wanted && bareProxy(cl.proxy) === proxy);
    if (found) return found;
  }
  return null;
}

/** The ☸ and, when known, which cloud: EKS, GKE, AKS or a local one (kubecloud.js). */
export function kubeMarks(x) {
  return [kubeIcon(), providerBadge(providerFor(x, teleportEntryFor(x)))];
}

/** The best provider answer for a context or cluster, for the browser to start from. */
export function kubeProviderOf(x) { return providerFor(x, teleportEntryFor(x)); }

/*
 * Requestable kube clusters — not even "available" (tsh kube ls would not
 * list them at all), the same third state SSH nodes already have: no
 * standing access, so getting at one goes through an access request first.
 * Shares the per-group "show what you could ask for" toggle SSH already
 * has (showRequestableIn) rather than a second one of its own — same
 * question, same answer, for either kind of resource on this cluster.
 */
const kubeReqCache = new Map(); // groupKey -> { at, hosts, fetching }
const KUBE_REQ_TTL_MS = 120000;

/*
 * The same `tsh request search --kind=kube_cluster` as below, asked
 * regardless of the "show what you could ask for" toggle — but only when a
 * cluster has a kubeconfig context `tsh kube ls` no longer lists, to tell a
 * cluster you could request from one that is simply gone. A Map of name ->
 * the search's own row, or null until the first answer; a failed search is
 * an empty answer, so nothing unconfirmed is ever offered.
 */
const kubeReqCheck = new Map(); // groupKey -> { at, found: Map|null, fetching }
function requestableKubeFor(p, groupKey) {
  const hit = kubeReqCheck.get(groupKey);
  if (hit && (hit.fetching || Date.now() - hit.at < KUBE_REQ_TTL_MS)) return hit.found;
  kubeReqCheck.set(groupKey, { at: hit?.at || 0, found: hit?.found || null, fetching: true });
  requestableHosts({ proxy: p.proxy, home: p.homeDir || null, cluster: p.cluster, kind: 'kube_cluster' })
    .then((r) => {
      const found = new Map((r?.hosts || []).map((h) => [h.name, h]));
      kubeReqCheck.set(groupKey, { at: Date.now(), found, fetching: false });
    })
    .catch(() => kubeReqCheck.set(groupKey, { at: Date.now(), found: new Map(), fetching: false }))
    .finally(() => state.emit('kubeContexts'));
  return hit?.found || null;
}

function requestableKubeHostsFor(p, groupKey) {
  if (p.expired || !showRequestableInFn || !showRequestableInFn(groupKey)) return [];
  const hit = kubeReqCache.get(groupKey);
  if (hit && Date.now() - hit.at < KUBE_REQ_TTL_MS) return hit.hosts;
  if (!hit?.fetching) {
    kubeReqCache.set(groupKey, { at: hit?.at || 0, hosts: hit?.hosts || [], fetching: true });
    requestableHosts({ proxy: p.proxy, home: p.homeDir || null, cluster: p.cluster, kind: 'kube_cluster' })
      .then((r) => { kubeReqCache.set(groupKey, { at: Date.now(), hosts: r.hosts, fetching: false }); state.emit('kubeContexts'); })
      .catch(() => kubeReqCache.set(groupKey, { at: Date.now(), hosts: [], fetching: false }));
  }
  return hit?.hosts || [];
}

/**
 * Every kube cluster relevant to one Teleport profile, host-shaped for the
 * same folder/filter/request machinery sidebar.js already runs its SSH
 * nodes through — logged in, available but not logged in, and requestable,
 * in that order. Nothing here renders anything: sidebar.js's hostRow() reads
 * which of kubeContext/availableCluster/requestableInfo is set on a given
 * row and dispatches to kubeContextRow/availableClusterRow/a plain
 * requestable row accordingly — the same "everything downstream handles it
 * without knowing what it is" design requestable.js's own ghosts already
 * rely on for SSH.
 */
export function kubeHostsForProfile(p) {
  if (state.settings.kubeEnabled === false) return [];
  ensureLoaded();
  noticeLogin(p);
  ensureAvailableLoaded(p);
  const groupKey = groupKeyFor(p);
  const pending = notYetConnected(p);
  /*
   * `tsh kube ls` is the list of kube clusters this login can actually use.
   * A context in the kubeconfig whose cluster is not on it — left by an
   * earlier login, or by an access request that has since ended — is not
   * something to go into: opening it only gets "Forbidden: unknown". Shown
   * as requestable instead. Until the list has been read (or if reading it
   * failed) nothing is guessed, and every context stays as it is.
   */
  const offered = availableCache.get(availableKey(p))?.clusters;
  const offeredNames = offered ? new Set(offered.map((cl) => cl.name)) : null;
  const all = contextsForProfile(p);
  const nameOf = (c) => c.kubeClusterName || c.name;
  const mine = offeredNames ? all.filter((c) => offeredNames.has(nameOf(c))) : all;
  const unusable = offeredNames ? all.filter((c) => !offeredNames.has(nameOf(c))) : [];
  const mineNames = new Set(mine.map(nameOf));
  const pendingNames = new Set(pending.map((c) => c.name));
  const askable = requestableKubeHostsFor(p, groupKey).filter((h) => !mineNames.has(h.name) && !pendingNames.has(h.name));
  const askableNames = new Set(askable.map((h) => h.name));
  // Not offered is not the same as requestable: a context can outlive its
  // cluster entirely. It is shown as requestable only when `tsh request
  // search --kind=kube_cluster` actually finds it — and not at all while
  // that is unknown, or when it does not.
  const reqFound = unusable.length ? requestableKubeFor(p, groupKey) : null;
  return [
    ...unusable.filter((c) => !askableNames.has(nameOf(c)) && reqFound?.has(nameOf(c))).map((c) => {
      const found = reqFound.get(nameOf(c));
      return {
        kind: 'kube', id: c.id, name: nameOf(c), labels: found.labels || labelsForContext(c) || {},
        groupKey, profile: p, requestable: true, noAccessContext: c,
        requestableInfo: { ...found, name: nameOf(c) },
      };
    }),
    ...mine.map((c) => ({
      kind: 'kube', id: c.id, name: c.kubeClusterName || c.name, labels: labelsForContext(c) || {},
      groupKey, profile: p, kubeContext: c,
    })),
    ...pending.map((cl) => ({
      kind: 'kube', id: `avail:${groupKey}:${cl.name}`, name: cl.name, labels: cl.labels || {},
      groupKey, profile: p, availableCluster: cl,
    })),
    ...askable.map((h) => ({
      kind: 'kube', id: h.id, name: h.name, labels: h.labels || {},
      groupKey, profile: p, requestable: true, requestableInfo: h,
    })),
  ];
}

/** A cluster this Teleport cluster offers but nobody has logged into yet — click to `tsh kube login` it. */
export function availableClusterRow(p, cluster, opts = {}) {
  const key = availableKey(p) + '\u0001' + cluster.name;
  const busy = loggingIn.has(key);
  return el('div', {
    class: 'sb-item' + (opts.folder ? ' in-folder' : ''),
    style: 'opacity:.65' + (opts.depth ? `;--depth:${opts.depth}` : ''),
    title: `${cluster.name}\nAvailable, not yet logged in — click to tsh kube login`,
    onClick: () => connectAvailableCluster(p, cluster),
  },
    el('span', { class: 'st', style: 'background:var(--muted)' }),
    opts.watched ? el('span', { class: 'hwatch', text: '\u{1F514}', title: 'Watched — you will be told if this cluster leaves the inventory' }) : null,
    el('span', { class: 'name', text: cluster.name }),
    ...kubeMarks(cluster),
    labelTag(cluster.labels),
    el('span', { class: 'tag', text: busy ? 'logging in…' : 'not connected' }));
}

/** "Edit…": the two things a context holds that are its own — its name and its default namespace. */
async function editContextDialog(c) {
  const nameIn = textInput({ value: c.contextName, autofocus: true });
  const nsIn = textInput({ value: c.namespace || '', placeholder: 'default' });
  const ok = await modal({
    title: 'Edit kube context',
    subtitle: c.kubeClusterName || c.name,
    render: (body) => body.append(
      field('Context name', nameIn, c.source === 'teleport' ? 'A later tsh kube login writes the original name back alongside it.' : null),
      field('Default namespace', nsIn, 'Empty means the cluster default.'),
    ),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, class: 'primary-btn' }],
  });
  if (!ok) return;
  const newName = nameIn.value.trim();
  if (!newName) return toast('A context needs a name', 'error');
  const namespace = nsIn.value.trim();
  if (newName === c.contextName && namespace === (c.namespace || '')) return;
  const r = await window.api.kube.editContext({
    contextName: c.contextName, kubeconfigPaths: c.kubeconfigPaths, newName,
    namespace: namespace === (c.namespace || '') ? undefined : namespace,
  });
  if (!r.ok) return toast(r.error || 'Could not edit that context', 'error');
  toast(`Saved ${newName}`);
  refreshKubeContexts();
}

/**
 * The menu for a host-shaped kube row anywhere outside the sidebar's own
 * tree — the hosts pane, which hands every right-click to sidebar.js's
 * openHostMenu. Same menus the sidebar rows open, so neither place grows
 * an option the other lacks.
 */
export function openKubeHostMenu(e, host, groupKey) {
  e.preventDefault();
  if (host.kubeContext) return openKubeContextMenu(e, host.kubeContext, groupKey);
  if (host.availableCluster) {
    return contextMenu(e.clientX, e.clientY, [{
      label: 'Log in (tsh kube login)',
      onClick: () => connectAvailableCluster(host.profile, host.availableCluster),
    }, { sep: true }, cloudMenuItem(host.availableCluster)]);
  }
  return null;
}

const loggingIn = new Set();

/** "Remove from kubeconfig…": asks what would go first, so the confirm can say exactly that. */
async function removeContext(c) {
  const spec = { contextName: c.contextName, kubeconfigPaths: c.kubeconfigPaths };
  const plan = await window.api.kube.deleteContext({ ...spec, dryRun: true });
  if (!plan.ok) return toast(plan.error || 'Could not read the kubeconfig', 'error');
  const lines = [`context  ${plan.context}`];
  if (plan.user) lines.push(`user     ${plan.user}`);
  if (plan.cluster) lines.push(`cluster  ${plan.cluster}`);
  if (plan.wasCurrent) lines.push('', 'It is the current context; current-context will be left unset.');
  const sure = await (await import('./ui.js')).confirm({
    title: 'Remove from kubeconfig',
    message: c.source === 'teleport'
      ? `Remove "${c.name}"? tsh kube login brings it back.`
      : `Remove "${c.name}"? Its credentials come from outside Teleport and may not be easy to recreate.`,
    detail: lines.join('\n'), confirmLabel: 'Remove', danger: true,
  });
  if (!sure) return;
  const r = await window.api.kube.deleteContext(spec);
  if (!r.ok) return toast(r.error || 'Could not remove that context', 'error');
  toast(r.warnings?.length ? `Removed ${c.name}, with warnings: ${r.warnings.join('; ')}` : `Removed ${c.name} from the kubeconfig`,
    r.warnings?.length ? 'error' : undefined);
  // Removed on purpose: not one to offer back after the next login.
  if (c.source === 'teleport' && c.teleportProxy && c.kubeClusterName) await forgetConnected(c.teleportProxy, [c.kubeClusterName]);
  refreshKubeContexts();
}

export async function connectAvailableCluster(p, cluster) {
  const key = availableKey(p) + '\u0001' + cluster.name;
  if (loggingIn.has(key)) return;
  loggingIn.add(key);
  state.emit('kubeContexts');
  try {
    const r = await window.api.kube.login({ proxy: p.proxy, home: p.homeDir, cluster: cluster.name });
    if (!r.ok) { toast(r.error || `Could not log in to ${cluster.name}`, 'error'); return; }
    refreshKubeContexts();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    loggingIn.delete(key);
    state.emit('kubeContexts');
  }
}

/** Rows for the flat "Local kubeconfigs" group — contexts with no Teleport cluster behind them. */
export function kubeGroupRows() {
  if (state.settings.kubeEnabled === false) return [];
  ensureLoaded();

  const rows = [];
  const direct = directContexts();
  if (loading && !loaded) {
    rows.push(el('div', { class: 'sb-empty', style: 'padding-left:20px', text: 'Reading kubeconfig…' }));
  } else if (lastError) {
    rows.push(el('div', { class: 'sb-empty', style: 'padding-left:20px', text: lastError }));
  } else if (!direct.length) {
    rows.push(el('div', { class: 'sb-empty', style: 'padding-left:20px', text: 'No other contexts in the default kubeconfig.' }));
  } else {
    for (const c of direct) rows.push(kubeContextRow(c));
  }
  rows.push(el('div', {
    class: 'sb-item beam-add',
    title: 'Add another kubeconfig file to read contexts from',
    onClick: () => addKubeconfig(),
  },
    el('span', { class: 'st', style: 'background:var(--accent)' }),
    el('span', { class: 'name', text: '+  Add a kubeconfig…' })));
  // The kubeconfig itself, edited here — colour-coded, with suggestions,
  // and checked by kubectl before it is saved (kubeconfigedit.js).
  rows.push(el('div', {
    class: 'sb-item beam-add',
    title: 'Edit a kubeconfig file here, with suggestions — kubectl checks it before it is saved',
    onClick: async () => (await import('./kubeconfigedit.js')).editKubeconfig(),
  },
    el('span', { class: 'st', style: 'background:var(--accent)' }),
    el('span', { class: 'name', text: '✎  Edit kubeconfig…' })));
  return rows;
}

export function kubeGroupCount() {
  return directContexts().length;
}

/* ------------------------------------------------------------------ */
/* The tree: context -> namespaces -> pods, each level expanded on its */
/* own click. A cluster can hold hundreds of pods across a dozen        */
/* namespaces — opening one and being shown all of it at once is the    */
/* opposite of browsable, so nothing past the namespace list loads      */
/* until it's actually asked for.                                       */
/* ------------------------------------------------------------------ */

const expanded = new Set();        // context ids currently showing their namespace list
const expandedNs = new Set();      // `${contextId}\u0001${namespace}` currently showing its pods
const namespacesCache = new Map(); // context id -> { loading, error, namespaces }
const podsCache = new Map();       // `${contextId}\u0001${namespace}` -> { loading, error, pods }

function nsKey(c, ns) { return c.id + '\u0001' + ns; }

function ensureNamespacesLoaded(c) {
  const entry = namespacesCache.get(c.id);
  if (entry?.loading) return;
  // Same loop ensureAvailableLoaded() had: a failure that is not an answer
  // refetches on its own redraw — and each kubectl here can be an MFA prompt.
  // A success is not kept for good either: a list read under an earlier
  // login (or before access changed) said "No namespaces" until a Refresh.
  if (entry && Date.now() - (entry.at || 0) < AVAILABLE_RETRY_MS) return;
  namespacesCache.set(c.id, { ...(entry?.namespaces ? { namespaces: entry.namespaces } : {}), loading: true });
  window.api.kube.namespaces(kubeSpecOf(c))
    .then((r) => namespacesCache.set(c.id, r?.ok
      ? { namespaces: (r.namespaces || []).slice().sort(), at: Date.now() }
      : { error: r?.error || 'Could not list namespaces', at: Date.now() }))
    .catch((e) => namespacesCache.set(c.id, { error: e?.message || String(e), at: Date.now() }))
    .finally(() => state.emit('kubeContexts'));
}

function ensurePodsLoaded(c, ns) {
  const key = nsKey(c, ns);
  const entry = podsCache.get(key);
  if (entry?.loading) return;
  if (entry && Date.now() - (entry.at || 0) < AVAILABLE_RETRY_MS) return;
  podsCache.set(key, { ...(entry?.pods ? { pods: entry.pods } : {}), loading: true });
  window.api.kube.pods({ ...kubeSpecOf(c), namespace: ns })
    .then((r) => podsCache.set(key, r?.ok
      ? { pods: r.pods || [], at: Date.now() }
      : { error: r?.error || 'Could not list pods', at: Date.now() }))
    .catch((e) => podsCache.set(key, { error: e?.message || String(e), at: Date.now() }))
    .finally(() => state.emit('kubeContexts'));
}

function toggleExpanded(c) {
  if (expanded.has(c.id)) expanded.delete(c.id);
  else {
    expanded.add(c.id); ensureNamespacesLoaded(c);
    // Connecting is when to ask which cloud it is — once, and only then.
    detectOnConnect(c, kubeSpecOf(c)).catch(() => {});
  }
  state.emit('kubeContexts');
}

function toggleNamespace(c, ns) {
  const key = nsKey(c, ns);
  if (expandedNs.has(key)) expandedNs.delete(key);
  else { expandedNs.add(key); ensurePodsLoaded(c, ns); }
  state.emit('kubeContexts');
}

const PHASE_COLOR = { Running: 'var(--green)', Pending: 'var(--amber)', Succeeded: 'var(--muted)' };
function phaseColor(phase) {
  return PHASE_COLOR[phase] || (/error|crash|evict|fail/i.test(phase || '') ? 'var(--red)' : 'var(--muted)');
}

/** The {kubeconfigPaths, contextName} shape every kube.* IPC call takes, from a listContexts() record. */
export function kubeSpecOf(c) {
  return { kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName };
}

export function kubeContextRow(c, opts = {}) {
  const isOpen = expanded.has(c.id);
  const mine = forwardsForContext(c);
  const rows = [el('div', {
    class: 'sb-item' + (c.current ? ' current' : '') + (opts.folder ? ' in-folder' : ''),
    style: opts.depth ? `--depth:${opts.depth}` : null,
    title: [c.name, c.cluster ? 'cluster: ' + c.cluster : '', c.namespace ? 'namespace: ' + c.namespace : '']
      .filter(Boolean).join('\n'),
    onClick: () => toggleExpanded(c),
    oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); openKubeContextMenu(e, c, opts.groupKey); },
  },
    el('span', { class: 'chev', text: isOpen ? '▼' : '▶' }),
    el('span', { class: 'st', style: 'background:var(--accent)' }),
    opts.watched ? el('span', { class: 'hwatch', text: '\u{1F514}', title: 'Watched — you will be told if this cluster leaves the inventory' }) : null,
    el('span', { class: 'name', text: c.kubeClusterName || c.name }),
    ...kubeMarks(c),
    c.current ? el('span', { class: 'tag', text: 'current' }) : null,
    // Visible even collapsed — "is anything of mine still forwarding here"
    // should not require expanding the cluster to find out.
    mine.length ? el('span', {
      class: 'tag', style: 'cursor:pointer', title: 'Active port-forwards on this cluster — click to manage',
      onClick: (e) => { e.stopPropagation(); showActivePortForwards({ contextName: c.contextName }); },
      text: `⇄ ${mine.length}`,
    }) : null,
    labelTag(labelsForContext(c)),
    el('button', {
      class: 'ghost-btn sm', text: '⤢',
      title: 'Open the full cluster browser — every resource kind, including custom ones',
      onClick: (e) => { e.stopPropagation(); openKubeBrowser({ ...kubeSpecOf(c), teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null }, c.kubeClusterName || c.name, { contextNamespace: c.namespace || undefined, provider: kubeProviderOf(c) }); },
    }))];
  if (isOpen) {
    if (mine.length) rows.push(...activeForwardRows(mine));
    rows.push(...namespaceRows(c));
  }
  return el('div', { class: 'kube-ctx-tree' }, ...rows);
}

/**
 * Active port-forwards, inline in the already-expanded tree — no modal, no
 * extra click, right where "what's running on this cluster" is actually
 * being asked. One row per forward, Copy and Stop right there.
 */
/** Confirm, then stop — a running forward is live traffic someone may be depending on mid-click, not a free action to undo. */
async function confirmStopForward(f) {
  const sure = await confirm({
    title: 'Stop port-forward',
    message: `Stop forwarding ${f.resource}/${f.name}${f.namespace ? ` (${f.namespace})` : ''} — localhost:${f.port}?`,
    confirmLabel: 'Stop', danger: true,
  });
  if (!sure) return;
  await window.api.kube.forwardStop({ id: f.id });
  toast('Port-forward stopped');
}

function activeForwardRows(forwards) {
  const indent = 'padding-left:24px';
  return [
    el('div', { class: 'sb-subhead', style: indent, text: `⇄ Active port-forwards (${forwards.length})` }),
    ...forwards.map((f) => el('div', { class: 'sb-item', style: 'padding-left:36px' },
      el('span', { class: 'st', style: 'background:var(--green)' }),
      el('span', { class: 'name', text: `${f.resource}/${f.name}${f.namespace ? ` (${f.namespace})` : ''} → :${f.port}` }),
      el('button', {
        class: 'ghost-btn sm', text: 'Copy', title: `localhost:${f.port}`,
        onClick: (e) => { e.stopPropagation(); window.api.clipboard.write(`localhost:${f.port}`); toast('Copied'); },
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Stop',
        onClick: (e) => { e.stopPropagation(); confirmStopForward(f); },
      }))),
  ];
}

/**
 * The unscoped (or one-context) view of every active forward — reachable
 * from the sidebar badge above, and from the full browser's own topBar
 * button (kubebrowser.js). Lives here rather than kubebrowser.js since the
 * sidebar needs it too and this module has no dependency the other way.
 */
export async function showActivePortForwards({ contextName } = {}) {
  let unsub = null;
  await modal({
    title: contextName ? 'Active port-forwards' : 'All active port-forwards',
    width: 'min(640px, 94vw)',
    render: (body) => {
      const list = el('div', {});
      const paint = () => {
        clear(list);
        const mine = contextName ? activeForwards.filter((f) => f.contextName === contextName) : activeForwards;
        if (!mine.length) { list.append(el('div', { class: 'sb-empty', text: 'Nothing is being forwarded right now.' })); return; }
        list.append(...mine.map((f) => el('div', {
          class: 'kube-row', style: 'grid-template-columns:minmax(0,1fr) auto',
        },
          el('span', { text: `${f.resource}/${f.name}${f.namespace ? ` (${f.namespace})` : ''} — localhost:${f.port} → :${f.remotePort}` }),
          el('span', { class: 'kube-row-actions' },
            el('button', { class: 'ghost-btn sm', text: 'Copy', onClick: () => { window.api.clipboard.write(`localhost:${f.port}`); toast('Copied'); } }),
            el('button', {
              class: 'ghost-btn sm', text: 'Stop',
              onClick: () => confirmStopForward(f),
            })))));
      };
      paint();
      unsub = window.api.kube.onForwardUpdate(paint);
      body.append(list);
    },
    buttons: [{ label: 'Close', value: true, class: 'primary-btn' }],
  });
  unsub?.();
}

/**
 * Namespaces only — collapsed, one row each. A cluster's dev namespace
 * alone can hold dozens of pods; showing every namespace's pods the moment
 * the cluster itself is opened is the thing this is specifically avoiding.
 * Nothing past this list loads until a namespace is clicked.
 */
function namespaceRows(c) {
  const entry = namespacesCache.get(c.id);
  const indent = 'padding-left:24px';
  // Re-reading keeps the list it has on screen; "Reading…" only when there is none yet.
  if (!entry || (entry.loading && !entry.namespaces)) return [el('div', { class: 'sb-empty', style: indent, text: 'Reading namespaces…' })];
  // A role scoped to one namespace cannot list them — a refusal, or an
  // empty list through Teleport — so the names typed in before, the
  // context's own default, and a way to type one sit under either.
  const listed = entry.namespaces || [];
  const extra = extraNamespaces(c.contextName, listed, c.namespace);
  const rows = [];
  if (entry.error) rows.push(el('div', { class: 'sb-empty', style: indent, text: entry.error }));
  else if (!listed.length && !extra.length) rows.push(el('div', { class: 'sb-empty', style: indent, text: 'No namespaces.' }));
  for (const ns of [...listed, ...extra]) {
    const key = nsKey(c, ns);
    const nsOpen = expandedNs.has(key);
    rows.push(el('div', {
      class: 'sb-item', style: indent,
      onClick: () => toggleNamespace(c, ns),
    },
      el('span', { class: 'chev', text: nsOpen ? '▼' : '▶' }),
      el('span', { class: 'name', text: ns })));
    if (nsOpen) rows.push(...podRowsFor(c, ns));
  }
  rows.push(el('div', {
    class: 'sb-item', style: indent + ';color:var(--muted)',
    title: 'Open a namespace by name — for when your role can use it but not list namespaces',
    onClick: async () => {
      const ns = await askNamespace(c.contextName);
      if (ns && !expandedNs.has(nsKey(c, ns))) toggleNamespace(c, ns);
      else state.emit('kubeContexts');
    },
  }, el('span', { class: 'chev', text: '+' }), el('span', { class: 'name', text: 'Type a namespace…' })));
  return rows;
}

/** A single namespace's pods, fetched only once its row is actually opened. */
function podRowsFor(c, ns) {
  const entry = podsCache.get(nsKey(c, ns));
  const indent = 'padding-left:44px';
  if (!entry || (entry.loading && !entry.pods)) return [el('div', { class: 'sb-empty', style: indent, text: 'Reading pods…' })];
  if (entry.error) return [el('div', { class: 'sb-empty', style: indent, text: entry.error })];
  if (!entry.pods.length) return [el('div', { class: 'sb-empty', style: indent, text: 'No pods.' })];
  return entry.pods.sort((a, b) => a.name.localeCompare(b.name)).map((pod) => podRow(c, pod));
}

/**
 * A pod row's whole point is "get me in" — so, like an SSH host row, a
 * click does that directly: one container execs straight in, several
 * offer a pick-which-one menu at the click point rather than a row full
 * of small buttons easy to mistake for labels. Right-click still gets the
 * rest (YAML, Describe, Delete) — the same split context/kubebrowser.js's
 * own rows use.
 */
function podRow(c, pod) {
  const containers = pod.containers.length ? pod.containers : [null];
  // Either run `go` straight away (one container) or let the click point
  // offer a choice of which — same shape either way for click and dblclick.
  const execWith = (e, go) => {
    if (containers.length === 1) { go(containers[0]); return; }
    contextMenu(e.clientX, e.clientY, containers.map((name) => ({ label: `Exec into ${name}`, onClick: () => go(name) })));
  };
  return el('div', {
    class: 'sb-item kube-pod-row',
    style: 'padding-left:44px',
    title: `${pod.name}\nnamespace: ${pod.namespace}\nphase: ${pod.phase}\nnode: ${pod.node}`
      + (pod.restarts ? `\n${pod.restarts} restart(s)` : '')
      + '\n\nClick to exec in beside this' + (containers.length > 1 ? ' (choose a container)' : '')
      + ' · double-click for a tab of its own · right-click for more',
    // Single click splits the active pane ("beside what I'm already
    // looking at", the same default every other split in this app has);
    // double click gives it a tab of its own instead. clickOrDblClick
    // holds the single-click action back until the double-click window
    // passes, or a double-click would fire both.
    ...clickOrDblClick(
      (e) => execWith(e, (name) => openPodExec(c, pod, name, { dir: 'row' })),
      (e) => execWith(e, (name) => openPodExec(c, pod, name, { newTab: true })),
    ),
    oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); openPodContextMenu(e, c, pod, containers); },
  },
    el('span', { class: 'st', style: `background:${phaseColor(pod.phase)}` }),
    el('span', { class: 'name', text: pod.name }),
    el('span', { class: 'tag', text: `${pod.ready}/${pod.total}` }),
    pod.restarts ? el('span', { class: 'tag stale', text: `${pod.restarts} restarts` }) : null,
    el('span', { class: 'kube-exec-hint', text: '⏵ exec' }));
}

async function openPodContextMenu(e, c, pod, containers) {
  const pfItem = await portForwardMenuItem(kubeSpecOf(c), { resource: 'pod', name: pod.name, namespace: pod.namespace });
  contextMenu(e.clientX, e.clientY, [
    { label: pod.name, heading: true },
    // A plain click keeps the same default a left-click row already has
    // (split right) — the arrow is where "down" and "a tab of its own"
    // live, so the common case stays one click either way.
    ...containers.map((name) => ({
      label: `Exec into ${name || 'pod'}`,
      onClick: () => openPodExec(c, pod, name, { dir: 'row' }),
      submenu: [
        { label: 'Split right', onClick: () => openPodExec(c, pod, name, { dir: 'row' }) },
        { label: 'Split down', onClick: () => openPodExec(c, pod, name, { dir: 'col' }) },
        { label: 'Open in a new tab', onClick: () => openPodExec(c, pod, name, { newTab: true }) },
      ],
    })),
    ...containers.map((name) => ({
      label: `View logs${name ? ` (${name})` : ''}`,
      onClick: () => openPodLogs(c, pod, name, { dir: 'row' }),
      submenu: [
        { label: 'Split right', onClick: () => openPodLogs(c, pod, name, { dir: 'row' }) },
        { label: 'Split down', onClick: () => openPodLogs(c, pod, name, { dir: 'col' }) },
        { label: 'Open in a new tab', onClick: () => openPodLogs(c, pod, name, { newTab: true }) },
        // The one thing a crash loop actually needs that a live container's
        // own logs cannot give: what the *previous* incarnation printed
        // right before it died, not what the new one has said since.
        pod.restarts ? { label: 'Previous container’s logs', onClick: () => openPodLogs(c, pod, name, { dir: 'row', previous: true }) } : null,
      ],
    })),
    { label: `Open log viewer…`, onClick: () => openPodLogViewer(c, pod, containers[0]) },
    ...containers.map((name) => ({
      label: `Attach${name ? ` (${name})` : ''}`,
      onClick: () => openPodAttach(c, pod, name, { dir: 'row' }),
      submenu: [
        { label: 'Split right', onClick: () => openPodAttach(c, pod, name, { dir: 'row' }) },
        { label: 'Split down', onClick: () => openPodAttach(c, pod, name, { dir: 'col' }) },
        { label: 'Open in a new tab', onClick: () => openPodAttach(c, pod, name, { newTab: true }) },
      ],
    })),
    ...containers.map((name) => ({
      label: `Debug container${name ? ` (${name})` : ''}…`,
      onClick: () => openPodDebug(c, pod, name, { dir: 'row' }),
      submenu: [
        { label: 'Split right', onClick: () => openPodDebug(c, pod, name, { dir: 'row' }) },
        { label: 'Split down', onClick: () => openPodDebug(c, pod, name, { dir: 'col' }) },
        { label: 'Open in a new tab', onClick: () => openPodDebug(c, pod, name, { newTab: true }) },
      ],
    })),
    pfItem,
    {
      // Was silently calling a function kubebrowser.js never exported —
      // this row's YAML had no way to actually show since the feature was
      // first built. Editable now too — the diff is opt-in (textModal's
      // own "Preview the diff" checkbox), not forced before every apply.
      label: 'View YAML',
      onClick: async () => {
        const target = { name: pod.name, resource: 'pods', namespace: pod.namespace };
        const spec = kubeSpecOf(c);
        const { textModal } = await import('./kubebrowser.js');
        const r = await window.api.kube.resourceYaml({ spec, target });
        if (!r.ok) { await textModal(`Pod/${pod.name}`, r.error || 'Could not read YAML'); return; }
        await textModal(`Pod/${pod.name}`, r.yaml, {
          editable: true, spec,
          onApply: async (yaml, { preview } = {}) => {
            if (preview) {
              const d = await window.api.kube.diffYaml({ spec, yaml });
              if (!d.ok) { toast(d.error || 'Could not compute the diff', 'error'); return false; }
              if (d.diff === '(no changes)') { toast('Nothing to apply — the edit matches what is already there'); return false; }
              const sure = await confirm({
                title: `Apply changes to Pod/${pod.name}?`,
                message: 'This is what applying the edit below would change:',
                detail: d.diff, confirmLabel: 'Apply', danger: true,
              });
              if (!sure) return false;
            }
            const a = await window.api.kube.applyYaml({ spec, yaml });
            if (!a.ok) { toast(a.error || 'kubectl apply failed', 'error'); return false; }
            toast(`Applied changes to ${pod.name}`);
            return true;
          },
        });
      },
    },
    {
      label: 'Export YAML…',
      onClick: async () => {
        const r = await window.api.kube.resourceYaml({ spec: kubeSpecOf(c), target: { name: pod.name, resource: 'pods', namespace: pod.namespace } });
        if (!r.ok) return toast(r.error || 'Could not read YAML', 'error');
        const saved = await window.api.dialog.saveText({ text: r.yaml, defaultPath: `pod-${pod.name}.yaml`, title: `Export Pod/${pod.name}` });
        if (saved) toast(`Saved ${saved.path}`);
      },
    },
    {
      label: 'Delete pod…',
      onClick: async () => {
        const ok = await (await import('./ui.js')).confirm({ title: 'Delete pod', message: `Delete "${pod.name}"?`, confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        const r = await window.api.kube.deleteResource({ spec: kubeSpecOf(c), target: { name: pod.name, resource: 'pods', namespace: pod.namespace } });
        if (!r.ok) return toast(r.error || 'Delete failed', 'error');
        toast(`Deleted ${pod.name}`);
        podsCache.delete(nsKey(c, pod.namespace));
        ensurePodsLoaded(c, pod.namespace);
      },
    },
  ]);
}

/**
 * `kubectl port-forward` to one pod/service/workload — a small dialog for
 * the two ports, then kube:forwardStart (see kubeforward.js). Shared by
 * every entry point (the sidebar pod menu, the full browser's row actions,
 * the 3D view's Service popup) rather than each opening its own dialog.
 */
export async function startPortForward(spec, { resource, name, namespace, remotePortHint } = {}) {
  const remoteIn = textInput({ value: remotePortHint ? String(remotePortHint) : '', placeholder: 'e.g. 80' });
  const localIn = textInput({ placeholder: 'auto' });
  const ok = await modal({
    title: 'Port-forward',
    subtitle: `${resource}/${name}`,
    render: (body) => body.append(
      field('Remote port (on the pod/service)', remoteIn),
      field('Local port', localIn, 'Leave blank to let kubectl pick an open port.'),
    ),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Start', value: true, class: 'primary-btn' }],
  });
  if (!ok) return;
  const remotePort = remoteIn.value.trim();
  if (!remotePort) return toast('Give it a remote port', 'error');
  const localPort = localIn.value.trim();
  const id = `${spec.contextName || ''}:${resource}/${namespace || ''}/${name}:${remotePort}`;
  try {
    const r = await window.api.kube.forwardStart({ id, spec, resource, name, namespace, localPort: localPort || undefined, remotePort });
    if (!r.ok) return toast(r.error || 'Could not start the port-forward', 'error');
    const addr = `localhost:${r.port}`;
    window.api.clipboard.write(addr);
    toast(`Forwarding ${addr} → ${resource}/${name}:${remotePort} — address copied`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/**
 * A port-forward menu item: "Port-forward…" when none is running for this
 * resource, or a "running on :PORT" submenu (copy / start another / stop)
 * once one is — same shape kubeProxyMenuItem below already uses for `tsh
 * proxy kube`, reused here since several forwards can run at once.
 */
export async function portForwardMenuItem(spec, { resource, name, namespace, remotePortHint } = {}) {
  let active = [];
  try { active = (await window.api.kube.forwardList())?.forwards || []; } catch { /* treated as none running */ }
  const mine = active.filter((f) => f.resource === resource && f.name === name && f.namespace === namespace);
  if (!mine.length) {
    return { label: 'Port-forward…', onClick: () => startPortForward(spec, { resource, name, namespace, remotePortHint }) };
  }
  return {
    label: `Port-forward — running on :${mine[0].port}`,
    submenu: [
      { label: 'Copy local address', onClick: () => { window.api.clipboard.write(`localhost:${mine[0].port}`); toast('Copied'); } },
      { label: 'Start another…', onClick: () => startPortForward(spec, { resource, name, namespace, remotePortHint }) },
      { label: 'Stop', onClick: () => confirmStopForward(mine[0]) },
    ],
  };
}

/**
 * A real kubectl exec session, opened as a local-shell pane (see kube.js
 * execSpec()).
 *
 * Splits the active pane by default — the same "beside what I'm already
 * looking at" default every other split in this app has — rather than a
 * tab of its own; `opts.newTab` (a double-click, see podRow()) or nothing
 * focused yet is the only way to get a fresh tab instead. `opts.dir` picks
 * which way: 'row' (right) from the sidebar tree, 'col' (down) from the
 * full cluster browser, where the main panel reads better split downward.
 */
/** What identifies a kube cluster well enough to find it again after a restart — not just the context name, which `tsh logout` deletes. */
function kubeIdentity(c) {
  return {
    kubeconfigPaths: c.kubeconfigPaths || [], contextName: c.contextName,
    teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null,
  };
}

/*
 * Reopening a kube pane from a saved layout (workspace.js), after a restart.
 * Before anything opens, the cluster is checked: still in the kubeconfig and
 * — for one reached through Teleport — still offered by a cluster you are
 * logged in to. A context `tsh logout` took away is offered back with one
 * `tsh kube login`, asked first; one that is gone, or behind a login that
 * has lapsed, is said plainly rather than reopened into an error. Several
 * panes on one cluster share the one check (and the one question).
 */
const resolving = new Map(); // context name -> Promise<identity|null>
const reopenError = (text) => toast(text, 'error', 12000);

export function resolveKubeTarget(saved, what) {
  const key = saved?.contextName || '';
  if (!resolving.has(key)) {
    resolving.set(key, resolveKubeTargetOnce(saved, what));
    setTimeout(() => resolving.delete(key), 60000);
  }
  return resolving.get(key);
}

async function resolveKubeTargetOnce(saved, what) {
  const read = async () => (await window.api.kube.contexts({ extraPaths: state.settings.kubeconfigPaths || [] }).catch(() => null))?.contexts || [];
  let ctxs = await read();
  let c = ctxs.find((x) => x.contextName === saved.contextName);
  const proxy = saved.teleportProxy || c?.teleportProxy || null;
  const kubeName = saved.kubeClusterName || c?.kubeClusterName || null;
  if (!proxy) {
    if (!c) { reopenError(`Could not reopen ${what}: the context "${saved.contextName}" is no longer in your kubeconfig.`); return null; }
    return kubeIdentity(c);
  }
  const prof = (state.teleportProfiles || []).find((p) => bareProxy(p.proxy) === bareProxy(proxy));
  const where = prof?.cluster || saved.teleportCluster || bareProxy(proxy);
  if (!prof || prof.expired) {
    reopenError(`Could not reopen ${what}: you are not logged in to ${where}. Log in to it, then open ${kubeName || 'the cluster'} again.`);
    return null;
  }
  if (kubeName) {
    const offered = await window.api.kube.clusters({ proxy: prof.proxy, home: prof.homeDir }).catch(() => null);
    if (offered?.ok && !(offered.clusters || []).some((k) => k.name === kubeName)) {
      reopenError(`Could not reopen ${what}: ${kubeName} is no longer available on ${where} — its agent may be gone, or your access to it.`);
      return null;
    }
  }
  if (!c) {
    if (!kubeName) { reopenError(`Could not reopen ${what}: the context "${saved.contextName}" is no longer in your kubeconfig.`); return null; }
    const ok = await confirm({
      title: 'Log in to a Kubernetes cluster?',
      message: `${kubeName} on ${where} was open when ServerLife closed, but you are not logged in to it now.`,
      detail: `Runs: tsh kube login ${kubeName} — then reopens ${what}.`,
      confirmLabel: 'Log in',
    });
    if (!ok) return null;
    const r = await window.api.kube.login({ proxy: prof.proxy, home: prof.homeDir, cluster: kubeName }).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) { reopenError(`tsh kube login ${kubeName} failed: ${r?.error || 'unknown error'}`); return null; }
    refreshKubeContexts();
    ctxs = await read();
    c = ctxs.find((x) => x.source === 'teleport' && x.kubeClusterName === kubeName && bareProxy(x.teleportProxy) === bareProxy(proxy))
      || ctxs.find((x) => x.contextName === saved.contextName);
    if (!c) { reopenError(`Logged in to ${kubeName}, but its context did not appear in the kubeconfig.`); return null; }
  }
  return kubeIdentity(c);
}

/** A saved cluster-browser pane: the same cluster, on the same view. */
export async function reopenKubeBrowser(saved) {
  const name = saved.title || saved.spec?.kubeClusterName || saved.spec?.contextName || 'the cluster';
  const spec = await resolveKubeTarget(saved.spec || {}, `the ${name} browser`);
  if (!spec) return false;
  const view = saved.view;
  await openKubeBrowser(spec, saved.title || spec.kubeClusterName || spec.contextName, {
    initialView: typeof view === 'string' ? view : undefined,
    initialKind: view && typeof view === 'object' ? view.kind : undefined,
    initialNamespace: saved.namespace || undefined,
  });
  return true;
}

const MODE_VERBS = { logs: 'logs for', exec: 'the shell in', attach: 'an attach session to', debug: 'a debug session in', selectorLogs: 'logs for' };

/** A saved exec, logs, attach or debug pane — only if its pod is still there; pods are replaced under new names all the time. */
export async function reopenKubePod(saved, { first = true, dir = 'row' } = {}) {
  const what = `${MODE_VERBS[saved.mode] || 'the shell in'} ${saved.mode === 'selectorLogs' ? (saved.title || saved.selector) : saved.pod?.name}`;
  const spec = await resolveKubeTarget(saved.spec || {}, what);
  if (!spec) return false;
  const opts = first ? { newTab: true } : { dir };
  // A label selector tolerates its pods coming and going by design — no
  // one pod's existence to re-check before reopening it.
  if (saved.mode === 'selectorLogs') {
    await openSelectorLogs(spec, { namespace: saved.namespace, selector: saved.selector, title: saved.title }, opts);
    return true;
  }
  const r = await window.api.kube.pods({ ...spec, namespace: saved.pod?.namespace }).catch(() => null);
  const pod = (r?.pods || []).find((p) => p.name === saved.pod?.name);
  if (!pod) {
    reopenError(`Could not reopen ${what}: the pod is gone from ${saved.pod?.namespace || 'its namespace'} — a newer one may have replaced it.`);
    return false;
  }
  if (saved.mode === 'logs') await openPodLogs(spec, pod, saved.container, { ...opts, previous: !!saved.previous });
  else if (saved.mode === 'attach') await openPodAttach(spec, pod, saved.container, opts);
  else if (saved.mode === 'debug') await openPodDebug(spec, pod, saved.container, { ...opts, image: saved.image });
  else await openPodExec(spec, pod, saved.container, opts);
  return true;
}

/** A saved node-shell pane — a node isn't replaced under a new name the way a pod is, so this just confirms it still exists. */
export async function reopenKubeNode(saved, { first = true, dir = 'row' } = {}) {
  const what = `the shell on ${saved.nodeName}`;
  const spec = await resolveKubeTarget(saved.spec || {}, what);
  if (!spec) return false;
  const r = await window.api.kube.resources({ spec, type: { name: 'nodes', namespaced: false } }).catch(() => null);
  const node = (r?.ok ? r.items : []).find((n) => n.name === saved.nodeName);
  if (!node) {
    reopenError(`Could not reopen ${what}: the node is no longer in the cluster.`);
    return false;
  }
  const opts = first ? { newTab: true } : { dir };
  await openNodeShell(spec, saved.nodeName, { ...opts, image: saved.image });
  return true;
}

export async function openPodExec(c, pod, containerName, opts = {}) {
  try {
    const spec = await window.api.kube.execSpec({
      kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName,
      namespace: pod.namespace, podName: pod.name, containerName,
    });
    const title = containerName ? `${pod.name}/${containerName}` : pod.name;
    // The file browser beside it shows the pod's filesystem from the start —
    // picked for the pane up front, not raced against its own first load the
    // way reassigning .source after the fact would be.
    const kubeSpec = {
      kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName,
      namespace: pod.namespace, podName: pod.name, containerName,
    };
    const explorerSource = { kind: 'kube', connId: null, kubeSpec };
    const paneOpts = { command: spec.command, args: spec.args, env: spec.env, title, explorerSource };
    let pane;
    if (opts.newTab || !state.activePane) {
      pane = await openLocalShell(null, paneOpts);
      // So the tab reads as the pod, not as "local: ~" — see paneTitle() in sessions.js.
      pane.kubeExec = true;
    } else {
      // `local: true` forces the split to be a fresh local pane running
      // this exec command, regardless of what kind the active pane is —
      // without it a split off an SSH or kube-exec pane would inherit that
      // pane's own connection/kind instead of running kubectl at all.
      pane = await splitActivePane(opts.dir || 'row', { ...paneOpts, local: true, kubeExec: true });
    }
    pane.title = title;
    pane.kubeRestore = { mode: 'exec', spec: kubeIdentity(c), pod: { name: pod.name, namespace: pod.namespace }, container: containerName || null };
    refreshPaneTitles();
  } catch (e) {
    toast(`Could not exec into ${pod.name}: ${e?.message || e}`, 'error');
  }
}

/**
 * `kubectl logs -f`, opened the same way as openPodExec just above — a
 * program with a PTY, split by default rather than a shell. The gap every
 * comparable tool treats as table stakes and KubeLife did not have at all:
 * a container that has already crashed can still be read here, where
 * execing into it cannot. `opts.previous` reads the last incarnation's
 * logs instead of the running one's — the one thing a crash loop actually
 * needs that a live container does not.
 */
export async function openPodLogs(c, pod, containerName, opts = {}) {
  try {
    const spec = await window.api.kube.logSpec({
      kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName,
      namespace: pod.namespace, podName: pod.name, containerName,
      previous: !!opts.previous,
    });
    const title = (containerName ? `${pod.name}/${containerName}` : pod.name) + (opts.previous ? ' (previous) logs' : ' logs');
    const paneOpts = { command: spec.command, args: spec.args, env: spec.env, title, explorer: false };
    let pane;
    if (opts.newTab || !state.activePane) {
      pane = await openLocalShell(null, paneOpts);
      pane.kubeLogs = true;
    } else {
      pane = await splitActivePane(opts.dir || 'row', { ...paneOpts, local: true, kubeLogs: true });
    }
    pane.title = title;
    pane.kubeRestore = { mode: 'logs', spec: kubeIdentity(c), pod: { name: pod.name, namespace: pod.namespace }, container: containerName || null, previous: !!opts.previous };
    refreshPaneTitles();
  } catch (e) {
    toast(`Could not read logs for ${pod.name}: ${e?.message || e}`, 'error');
  }
}

/**
 * `kubectl attach -i`, opened the same way as openPodExec — the gap exec
 * cannot close: a container whose own entrypoint is already the process
 * worth seeing. No `-t`: kubectl flatly refuses to allocate a TTY on a
 * container that was not itself started with one, so this streams
 * stdout/stderr and passes stdin through either way, which every
 * container can actually honour (see kube.js's attachSpec).
 */
export async function openPodAttach(c, pod, containerName, opts = {}) {
  try {
    const spec = await window.api.kube.attachSpec({
      kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName,
      namespace: pod.namespace, podName: pod.name, containerName,
    });
    const title = (containerName ? `${pod.name}/${containerName}` : pod.name) + ' (attach)';
    const paneOpts = { command: spec.command, args: spec.args, env: spec.env, title, explorer: false };
    let pane;
    if (opts.newTab || !state.activePane) {
      pane = await openLocalShell(null, paneOpts);
      pane.kubeExec = true;
    } else {
      pane = await splitActivePane(opts.dir || 'row', { ...paneOpts, local: true, kubeExec: true });
    }
    pane.title = title;
    pane.kubeRestore = { mode: 'attach', spec: kubeIdentity(c), pod: { name: pod.name, namespace: pod.namespace }, container: containerName || null };
    refreshPaneTitles();
  } catch (e) {
    toast(`Could not attach to ${pod.name}: ${e?.message || e}`, 'error');
  }
}

// Picked for both the ephemeral debug container and the node shell below:
// a small image with actual tools (curl, dig, tcpdump, a shell with
// history) rather than one with none at all — editable in the prompt
// either way.
const DEFAULT_DEBUG_IMAGE = 'nicolaka/netshoot:latest';

/**
 * `kubectl debug -it --image=...`, an ephemeral debug container dropped
 * beside an already-running one — for a pod with no shell of its own, or
 * whose image has nothing worth execing into. `opts.image` is read
 * straight through on restore, rather than asked again.
 */
export async function openPodDebug(c, pod, containerName, opts = {}) {
  let image = opts.image;
  if (!image) {
    image = await prompt({
      title: `Debug container in ${pod.name}`,
      label: 'Image for the ephemeral debug container',
      value: DEFAULT_DEBUG_IMAGE,
      validate: (v) => (v.trim() ? null : 'An image is required.'),
    });
    if (!image) return;
  }
  try {
    const spec = await window.api.kube.debugSpec({
      kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName,
      namespace: pod.namespace, podName: pod.name, containerName, image,
    });
    const title = `${pod.name} debug (${image})`;
    const paneOpts = { command: spec.command, args: spec.args, env: spec.env, title, explorer: false };
    let pane;
    if (opts.newTab || !state.activePane) {
      pane = await openLocalShell(null, paneOpts);
      pane.kubeExec = true;
    } else {
      pane = await splitActivePane(opts.dir || 'row', { ...paneOpts, local: true, kubeExec: true });
    }
    pane.title = title;
    pane.kubeRestore = { mode: 'debug', spec: kubeIdentity(c), pod: { name: pod.name, namespace: pod.namespace }, container: containerName || null, image };
    refreshPaneTitles();
  } catch (e) {
    toast(`Could not start a debug container in ${pod.name}: ${e?.message || e}`, 'error');
  }
}

/**
 * `kubectl debug node/NAME -it --image=...` — a privileged debug pod on
 * the node itself, its root filesystem mounted at /host by kubectl's own
 * default (run `chroot /host` once inside for a true node shell; not done
 * automatically, since not every debug image carries `chroot`).
 */
export async function openNodeShell(c, nodeName, opts = {}) {
  let image = opts.image;
  if (!image) {
    image = await prompt({
      title: `Node shell on ${nodeName}`,
      label: 'Image for the debug pod (mounts the node at /host)',
      value: DEFAULT_DEBUG_IMAGE,
      validate: (v) => (v.trim() ? null : 'An image is required.'),
    });
    if (!image) return;
  }
  try {
    const spec = await window.api.kube.nodeDebugSpec({
      kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName, nodeName, image,
    });
    const title = `${nodeName} shell`;
    const paneOpts = { command: spec.command, args: spec.args, env: spec.env, title, explorer: false };
    let pane;
    if (opts.newTab || !state.activePane) {
      pane = await openLocalShell(null, paneOpts);
      pane.kubeExec = true;
    } else {
      pane = await splitActivePane(opts.dir || 'row', { ...paneOpts, local: true, kubeExec: true });
    }
    pane.title = title;
    pane.kubeRestore = { mode: 'nodeShell', spec: kubeIdentity(c), nodeName, image };
    refreshPaneTitles();
  } catch (e) {
    toast(`Could not open a shell on ${nodeName}: ${e?.message || e}`, 'error');
  }
}

/**
 * `kubectl logs -l <selector> --all-containers --prefix -f`, opened the
 * same way as openPodLogs — every pod a Deployment/StatefulSet/DaemonSet/
 * ReplicaSet/Service owns, interleaved and prefixed by kubectl itself, as
 * one stream. Tolerates pods coming and going (that's the point), so
 * there's no one pod identity to re-check on restore.
 */
export async function openSelectorLogs(c, { namespace, selector, title } = {}, opts = {}) {
  try {
    const spec = await window.api.kube.logSpec({
      kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName,
      namespace, selector, previous: !!opts.previous,
    });
    const paneTitle = title || `logs: ${selector}`;
    const paneOpts = { command: spec.command, args: spec.args, env: spec.env, title: paneTitle, explorer: false };
    let pane;
    if (opts.newTab || !state.activePane) {
      pane = await openLocalShell(null, paneOpts);
      pane.kubeLogs = true;
    } else {
      pane = await splitActivePane(opts.dir || 'row', { ...paneOpts, local: true, kubeLogs: true });
    }
    pane.title = paneTitle;
    pane.kubeRestore = { mode: 'selectorLogs', spec: kubeIdentity(c), namespace, selector, title: paneTitle };
    refreshPaneTitles();
  } catch (e) {
    toast(`Could not read logs for ${selector}: ${e?.message || e}`, 'error');
  }
}

/**
 * The searchable, downloadable Log Viewer (kubelogviewer.js) for one pod —
 * dynamic import for the same reason kubebrowser.js reaches back into this
 * module the same way: a static import either direction would close a cycle.
 */
export async function openPodLogViewer(c, pod, containerName) {
  const { openKubeLogViewer } = await import('./kubelogviewer.js');
  const title = (containerName ? `${pod.name}/${containerName}` : pod.name) + ' logs';
  await openKubeLogViewer(kubeIdentity(c), { namespace: pod.namespace, podName: pod.name, containerName }, title);
}

/**
 * "Mark as needing MFA once granted" — the same idea requestpicker.js
 * offers while a cluster is still only requestable, reachable here too
 * once it's an actual logged-in context. Teleport-sourced only: a direct
 * kubeconfig context (no `c.cluster`) has no per-session-MFA concept to
 * mark, the same reasoning GUIDE.md § KubeLife gives for the request
 * picker's own gate.
 */
async function openKubeContextMenu(e, c, groupKey) {
  const items = [
    // Namespaces and pods are read once and kept; this drops this context's
    // copies (and the kubeconfig read) so whatever is expanded reads again.
    {
      label: 'Refresh',
      icon: '⟳',
      title: 'Re-read this cluster’s namespaces and pods, and the kubeconfig',
      onClick: () => {
        namespacesCache.delete(c.id);
        for (const k of [...podsCache.keys()]) if (k.startsWith(c.id + '\u0001')) podsCache.delete(k);
        refreshKubeContexts();
      },
    },
    // Nothing in KubeLife itself cares which context is "current" —
    // kubectlArgsFor() always passes an explicit --context= — so this is
    // purely for a bare `kubectl`/`tsh kubectl` run outside the app: the
    // same switch `tsh kube login` makes as a side effect of logging in,
    // offered here without repeating the login round-trip for a cluster
    // already logged into.
    (c.source === 'teleport' && !c.current) ? {
      label: 'Make this the logged-in cluster',
      title: 'kubectl config use-context — so a plain kubectl/tsh kubectl outside this app points here too',
      onClick: async () => {
        const r = await window.api.kube.useContext({ contextName: c.contextName, kubeconfigPaths: c.kubeconfigPaths });
        if (!r.ok) return toast(r.error || 'Could not switch context', 'error');
        toast(`${c.kubeClusterName || c.name} is now the logged-in cluster`);
        refreshKubeContexts();
      },
    } : null,
    {
      label: 'Browse full cluster…',
      title: 'Every resource kind, including custom ones',
      onClick: () => openKubeBrowser({ ...kubeSpecOf(c), teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null }, c.kubeClusterName || c.name, { contextNamespace: c.namespace || undefined }),
    },
    // For a role that can use one namespace but not list them: there is
    // nothing in the browser's dropdown to pick, so name it on the way in.
    {
      label: 'Browse a namespace…',
      title: 'Type the namespace to open the browser in — for when your role cannot list namespaces',
      onClick: async () => {
        const ns = await askNamespace(c.contextName, { value: c.namespace || '' });
        if (ns) openKubeBrowser({ ...kubeSpecOf(c), teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null }, c.kubeClusterName || c.name, { initialNamespace: ns, contextNamespace: c.namespace || undefined });
      },
    },
    {
      label: 'Manage Helm releases…',
      title: 'Opens the full cluster browser straight on its Helm releases list',
      onClick: () => openKubeBrowser({ ...kubeSpecOf(c), teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null }, c.kubeClusterName || c.name, { initialView: 'helm', contextNamespace: c.namespace || undefined }),
    },
    // Same preference the file browser's 3D button already answers to —
    // this is the same "do I want 3D at all" switch, not a second one.
    // Opens the full cluster browser straight on its 3D view, not a modal —
    // a modal's own autofocus-steal (see kube3d.js's own doc comment) is
    // the reason arrow keys never worked there.
    state.settings.show3dView !== false ? {
      label: 'Open 3D view…',
      title: 'Namespaces as districts, pods as buildings — click one to exec into it',
      onClick: () => openKubeBrowser({ ...kubeSpecOf(c), teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null }, c.kubeClusterName || c.name, { initialView: '3d', contextNamespace: c.namespace || undefined }),
    } : null,
    // The same "who else is in what, right now" view a Teleport SSH host's
    // own menu already offers — livesessions.js is already kind-agnostic
    // (a k8s session tracker's own `target` is the kube cluster's name,
    // which its match filter already checks), so this only needed a call
    // site, not a change to that module.
    c.source === 'teleport' ? {
      label: 'Active sessions on this cluster…',
      icon: '⇄',
      title: 'Watch, join or moderate a kubectl exec session that is going on here now',
      onClick: async () => (await import('./livesessions.js')).openActiveSessions({
        proxy: c.teleportProxy, home: null,
        match: [c.kubeClusterName || c.name],
        title: `Active sessions on ${c.kubeClusterName || c.name}`, subtitle: c.teleportCluster || c.teleportProxy,
      }),
    } : null,
    // The same pairing an SSH host's own menu already has — "active" for
    // right now, "recorded" for after — missing here only because this
    // cluster's context menu is a separate one from a host row's.
    c.source === 'teleport' ? {
      label: 'Recorded sessions for this cluster…',
      icon: '◎',
      onClick: async () => {
        const { openSessionsDialog } = await import('./recordings.js');
        openSessionsDialog('recordings', { filter: c.kubeClusterName || c.name, proxy: c.teleportProxy });
      },
    } : null,
    {
      label: 'Open a shell here',
      title: 'A local shell with KUBECONFIG and --context already set — kubectl, helm, k9s, anything installed just works',
      onClick: () => openEcosystemShell(c, null),
    },
    await k9sMenuItem(c),
    // `tsh proxy kube` instead of `tsh kube login`: a local proxy any
    // other external tool can point at on its own, rather than this app's
    // own exec-plugin kubeconfig. Nothing
    // inside KubeLife uses this — it is purely for handing the cluster to
    // something else, which only makes sense for a Teleport-sourced one.
    c.source === 'teleport' ? await kubeProxyMenuItem(c) : null,
    // The reverse direction: a direct kubeconfig context — reachable only
    // from this one machine's kubeconfig — is a candidate to bring under
    // Teleport properly. Meaningless for a context that already came from
    // Teleport, which is why this is the one case the item above is not.
    c.source === 'direct' ? {
      label: 'Install Teleport on this cluster…',
      title: 'teleport-kube-agent via Helm — Teleport’s own documented way to enroll an existing cluster',
      onClick: () => openInstallTeleportWizard(c),
    } : null,
    // Either source: a Teleport one is just `tsh kube login` again to get
    // back, a direct one is whatever made it — said in the confirm, since
    // the second kind may not be so easy to recreate.
    {
      label: 'Edit…',
      title: 'Rename this context, or set its default namespace',
      onClick: () => editContextDialog(c),
    },
    {
      label: 'Edit its kubeconfig…',
      title: 'The kubeconfig file, edited here — colour-coded, with suggestions, checked by kubectl before saving',
      onClick: async () => (await import('./kubeconfigedit.js')).editKubeconfig(),
    },
    {
      label: 'Remove from kubeconfig…',
      title: 'kubectl config delete-context, plus its user and cluster entries if nothing else uses them',
      onClick: () => removeContext(c),
    },
  ];
  // MFA is a Teleport per-session-grant concept — a direct kubeconfig
  // context (no Teleport cluster behind it) has nothing to mark.
  if (c.source === 'teleport' && c.cluster) {
    const { isMfaHost, setMfaHost } = await sidebarHelpers();
    let mfaId = c.id;
    try {
      const ids = await window.api.teleport.inventoryKubeIds({
        // The real Teleport cluster name (parsed from the tsh exec plugin,
        // see teleportOriginOf() in kube.js) — not c.cluster, which is the
        // kubeconfig's own cluster field and, in a context tsh wrote, is
        // just the context's own name again, not the Teleport cluster's.
        items: [{ id: c.id, cluster: c.teleportCluster, name: c.kubeClusterName || c.name }],
      });
      mfaId = ids[c.id] || c.id;
    } catch { /* falls back to c.id, which just will not match anything already marked */ }
    const on = isMfaHost(mfaId);
    items.push({
      label: on ? 'Forget that this needs MFA' : 'Mark as needing MFA',
      onClick: () => setMfaHost({ id: mfaId, name: c.kubeClusterName || c.name }, !on).then(() => state.emit('kubeContexts')),
    });
  }
  // The same watch SSH hosts already have — isWatched/toggleWatch are
  // already host-shaped (keyed by hostKey(), which falls back to .id for
  // anything without a uuid or host.type), so this needed a row-shaped
  // object and a menu item, not a change to watch.js itself.
  {
    const watchHost = { id: c.id, name: c.kubeClusterName || c.name, labels: labelsForContext(c) || {} };
    const watching = isWatched(watchHost);
    items.push({
      label: watching ? 'Stop watching this cluster' : 'Watch this cluster',
      icon: '\u{1F514}',
      title: watching
        ? 'Forget it — no longer told if this cluster leaves the inventory'
        : 'Keep a record of this cluster, and say so if it ever leaves the inventory',
      onClick: () => toggleWatch(watchHost, groupKey || 'kube-local').then(() => state.emit('kubeContexts')),
    });
  }
  // Which cloud — set by hand when nothing detected it.
  items.push({ sep: true }, cloudMenuItem(c));
  // Only reachable from the integrated tree (see kubeHostsForProfile) —
  // "Local kubeconfigs" has no SSH-folder group to share, so there is
  // nothing to file into there.
  if (groupKey) {
    const { folderMenuFor } = await import('./sidebar.js');
    // Already a complete menu item (its own label, its own submenu) — see
    // folderMenuFor's own return shape — not a bare list to wrap again.
    const folderItem = folderMenuFor({ id: c.id, name: c.kubeClusterName || c.name, labels: labelsForContext(c) || {} }, { groupKey });
    if (folderItem) items.push({ sep: true }, folderItem);
  }
  contextMenu(e.clientX, e.clientY, items);
}

/**
 * "Install Teleport on this cluster" — `teleport-kube-agent` via Helm, the
 * documented way to bring an existing (direct-kubeconfig-only) cluster
 * under Teleport. This touches real cluster state — a Helm release, a new
 * namespace — so "Dry run" defaults to checked: the box has to be
 * unchecked by hand before anything is actually installed, the same
 * explicit "yes, really" every other consequential action in this app asks
 * for some other way (a danger-styled confirm, a typed name to match).
 */
export async function openInstallTeleportWizard(c) {
  const profiles = (state.teleportProfiles || []).filter((p) => !p.expired);
  if (!profiles.length) return toast('Log into a Teleport cluster first — that is what this one would join.', 'error');

  const profileSel = select(
    profiles.map((p) => ({ value: p.proxy, label: `${p.cluster || p.proxy} (${p.proxy})` })),
    profiles[0].proxy,
  );
  const nameIn = textInput({ value: c.kubeClusterName || c.name || c.contextName || '', placeholder: 'kube cluster name' });
  const dryRunIn = checkbox('Dry run (render the install, change nothing)', true);
  const releaseIn = textInput({ value: 'teleport-agent', placeholder: 'teleport-agent' });
  const nsIn = textInput({ value: 'teleport-agent', placeholder: 'teleport-agent' });
  const autoUpdateIn = checkbox('Keep the agent updated automatically (updater.enabled)', true);
  const where = () => ({
    releaseName: releaseIn.value.trim() || 'teleport-agent', namespace: nsIn.value.trim() || 'teleport-agent',
    autoUpdate: autoUpdateIn.input.checked,
  });
  // kube to reach the cluster, app + discovery to find what runs inside it
  // and publish it as Teleport apps — all three by default.
  const roleIns = Object.fromEntries(['kube', 'app', 'discovery'].map((r) => [r, checkbox(r, true)]));
  const labelsIn = el('textarea', {
    rows: 3, spellcheck: 'false', placeholder: 'env=dev\nteam=platform',
    style: 'width:100%;font-family:var(--mono);font-size:12px;resize:vertical',
  });
  const roles = () => Object.entries(roleIns).filter(([, cb]) => cb.input.checked).map(([r]) => r);
  // One `key=value` per line or comma; a line without "=" is ignored rather than guessed at.
  const labels = () => Object.fromEntries(labelsIn.value.split(/[\n,]/).map((l) => l.trim()).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]).filter(([k]) => k));
  // The token has to allow every service the agent will run.
  const tokenType = () => roles().join(',') || 'kube';
  // Made on the cluster picked above and checked to be that one (see
  // teleport.js's createJoinToken), then kept for this dialog so the
  // values.yaml export can carry the same token rather than mint another.
  let lastToken = null; // { token, cluster, proxy, type }
  const mintToken = async () => {
    const proxy = profileSel.value;
    const prof = profiles.find((p) => p.proxy === proxy);
    const type = tokenType();
    if (lastToken && lastToken.proxy === proxy && lastToken.type === type) return { ok: true, ...lastToken };
    const tok = await window.api.teleport.createJoinToken({ type, ttl: '1h', proxy, cluster: prof?.cluster });
    if (tok.ok) lastToken = { token: tok.token, cluster: tok.cluster || prof?.cluster || proxy, proxy, type };
    return tok.ok ? { ok: true, ...lastToken } : tok;
  };
  const out = el('pre', {
    style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-word;'
      + 'max-height:240px;overflow:auto;margin-top:10px;background:var(--panel-2);border:1px solid var(--border);'
      + 'border-radius:var(--radius);padding:8px 10px;color:var(--text-dim)',
  });
  let running = false;

  // The commands themselves, before anything runs — built by the same code
  // that runs them (kube.js's commandPreview), so what is shown is what runs.
  // The token is a placeholder until one is actually asked for: creating a
  // join token is a change on the Teleport cluster, not something a preview
  // should do.
  const cmdBox = el('pre', {
    style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;user-select:text;'
      + 'max-height:160px;overflow:auto;margin:4px 0 0;background:var(--panel-2);border:1px solid var(--border);'
      + 'border-radius:var(--radius);padding:8px 10px;color:var(--text)',
  });
  const spec = { kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName };
  const commandFor = async (token) => {
    const r = await window.api.kube.installTeleportAgent({
      spec, proxy: profileSel.value, token, clusterName: nameIn.value.trim() || '<cluster-name>', dryRun: dryRunIn.input.checked, preview: true,
      roles: roles(), labels: labels(), ...where(),
    });
    return r.ok ? r.command : (r.error || '');
  };
  const paintPreview = async () => { cmdBox.textContent = await commandFor('<join-token>'); };
  for (const n of [profileSel, dryRunIn.input, autoUpdateIn.input, ...Object.values(roleIns).map((cb) => cb.input)]) n.addEventListener('change', paintPreview);
  for (const n of [nameIn, labelsIn, releaseIn, nsIn]) n.addEventListener('input', paintPreview);
  paintPreview();

  await modal({
    title: 'Install Teleport on this cluster',
    width: 'min(640px, 94vw)',
    render: (body) => {
      body.append(
        el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:10px', text:
          'Installs teleport-kube-agent via Helm, joined to the Teleport cluster below. Leave "Dry run" '
          + 'checked to see exactly what would run before anything actually does.' }),
        field('Join this Teleport cluster', profileSel),
        field('Register as (kube cluster name)', nameIn),
        el('div', { style: 'display:flex;gap:10px' },
          el('div', { style: 'flex:1' }, field('Helm release name', releaseIn)),
          el('div', { style: 'flex:1' }, field('Install into namespace', nsIn, 'Created if it does not exist'))),
        field('Services this agent runs', el('div', { style: 'display:flex;gap:14px' }, ...Object.values(roleIns)),
          'kube: kubectl access through Teleport · app: publish HTTP apps · discovery: find Services in the cluster and publish them as apps'),
        autoUpdateIn,
        field('Labels', labelsIn, 'key=value, one per line — the kube cluster’s Teleport labels, what roles and search match on'),
        dryRunIn,
        el('div', { style: 'font-size:12px;font-weight:600;margin-top:10px', text: 'What will run' }),
        cmdBox,
        el('div', { class: 'hint', text: 'Copy command creates a real join token (valid 1 hour) and copies the full command, to run yourself — nothing is installed from here.' }),
        out,
      );
    },
    buttons: [
      { label: 'Close', value: null },
      {
        label: 'Export values.yaml…',
        onClick: async () => {
          const prof = profiles.find((p) => p.proxy === profileSel.value);
          const r = await window.api.kube.teleportAgentValues({
            proxy: profileSel.value, clusterName: nameIn.value.trim(), roles: roles(), labels: labels(), ...where(),
            // Only a token already made for this cluster and these roles in
            // this dialog; otherwise a placeholder and how to make one.
            token: lastToken && lastToken.proxy === profileSel.value && lastToken.type === tokenType() ? lastToken.token : null,
          });
          const saved = await window.api.dialog.saveText({ text: r.yaml, defaultPath: `${where().releaseName}-values.yaml`, title: `Teleport agent values for ${prof?.cluster || profileSel.value}` });
          if (saved) toast(`Saved ${saved.path}`);
        },
      },
      {
        label: 'Copy command',
        onClick: async () => {
          if (running) return;
          if (!nameIn.value.trim()) return toast('Give it a cluster name', 'error');
          running = true;
          try {
            const tok = await mintToken();
            if (!tok.ok) { out.textContent = 'Could not get a join token: ' + tok.error; return; }
            out.textContent = `Join token made on ${tok.cluster} (${tok.type}), valid 1 hour.`;
            const cmd = await commandFor(tok.token);
            cmdBox.textContent = cmd;
            await window.api.clipboard.write(cmd);
            toast('Command copied, with a join token valid for 1 hour');
          } finally { running = false; }
        },
      },
      {
        label: 'Run', class: 'primary-btn',
        onClick: async () => {
          if (running) return;
          const proxy = profileSel.value;
          const clusterName = nameIn.value.trim();
          if (!clusterName) return toast('Give it a cluster name', 'error');
          running = true;
          out.textContent = 'Requesting a join token…';
          try {
            const tok = await mintToken();
            if (!tok.ok) { out.textContent = 'Could not get a join token: ' + tok.error; return; }
            cmdBox.textContent = await commandFor(tok.token);
            out.textContent = `Join token made on ${tok.cluster}. Running helm install${dryRunIn.input.checked ? ' --dry-run' : ''}…`;
            const r = await window.api.kube.installTeleportAgent({
              spec: { kubeconfigPaths: c.kubeconfigPaths, contextName: c.contextName },
              proxy, token: tok.token, clusterName, dryRun: dryRunIn.input.checked, roles: roles(), labels: labels(), ...where(),
            });
            out.textContent = r.ok ? (r.output || 'Done.') : 'helm install failed: ' + r.error;
            if (r.ok && !dryRunIn.input.checked) {
              toast(`${clusterName} is enrolling — it will appear under ${proxy} once the agent connects`);
              refreshKubeContexts();
            }
          } finally { running = false; }
        },
      },
    ],
  });
}

/**
 * k9s gets its own menu item — the one ecosystem tool that's a full TUI of
 * its own, worth a direct launch rather than "open a shell and type it."
 * Disabled with an install hint when it isn't on this machine, the same
 * grey-out-rather-than-hide idiom nettools.js already uses for a missing
 * local tool, so the option is still there to explain rather than to guess
 * at from its absence.
 */
async function k9sMenuItem(c) {
  let found = false;
  try { found = (await window.api.kube.ecosystemStatus())?.k9s?.found; } catch { /* treated as not found */ }
  return {
    label: 'Open in k9s',
    disabled: !found,
    title: found ? undefined : 'k9s was not found on this machine',
    onClick: () => openEcosystemShell(c, 'k9s'),
  };
}

const exportLine = (kubeconfig) => `export KUBECONFIG="${kubeconfig}"`;

/**
 * `tsh proxy kube` as a menu item: not running yet is one click to start
 * (and the resulting `export KUBECONFIG=…` line copied straight to the
 * clipboard, since the whole point is handing it to something outside this
 * app); already running collapses into a submenu so "copy it again" and
 * "stop it" don't crowd the main list for a cluster nobody has started a
 * proxy for.
 */
async function kubeProxyMenuItem(c) {
  let info = null;
  try { info = (await window.api.kube.proxyStatus({ id: c.id }))?.info; } catch { /* treated as not running */ }
  if (!info) {
    return {
      label: 'Start tsh proxy kube…',
      title: 'A local proxy for plain kubectl or an external tool — not what this app itself uses to reach the cluster',
      onClick: async () => {
        const r = await window.api.kube.proxyStart({
          id: c.id, kubeClusterName: c.kubeClusterName || c.name, proxy: c.teleportProxy, teleportCluster: c.teleportCluster,
        });
        if (!r.ok) return toast(r.error || 'Could not start tsh proxy kube', 'error');
        window.api.clipboard.write(exportLine(r.kubeconfig));
        toast(`tsh proxy kube running on 127.0.0.1:${r.port} — KUBECONFIG export copied`);
      },
    };
  }
  return {
    label: `tsh proxy kube — running on :${info.port}`,
    submenu: [
      {
        label: 'Copy KUBECONFIG export',
        onClick: () => { window.api.clipboard.write(exportLine(info.kubeconfig)); toast('Copied'); },
      },
      {
        label: 'Stop tsh proxy kube',
        onClick: async () => { await window.api.kube.proxyStop({ id: c.id }); toast('tsh proxy kube stopped'); },
      },
    ],
  };
}

/**
 * A local terminal with KUBECONFIG and --context already pointed at this
 * cluster — either running `tool` directly (k9s), or a plain shell where
 * kubectl/helm/stern/anything else installed already knows which cluster
 * to talk to, without the command having to name it. Same "program with no
 * Connection behind it" shape as a pod exec session (see openPodExec).
 */
async function openEcosystemShell(c, tool) {
  // The platform's own path delimiter belongs on the main side, which is
  // why this asks kube.js for the env rather than joining kubeconfigPaths
  // here — the renderer has no path.delimiter to reach for.
  const env = await window.api.kube.kubeconfigEnv(kubeSpecOf(c));
  const title = tool ? `${tool}: ${c.kubeClusterName || c.name}` : `shell: ${c.kubeClusterName || c.name}`;
  if (tool) {
    // The bare name resolves through PATH only if the tool happens to
    // live beside kubectl (the common case, not a guarantee) — the real
    // path ecosystemStatus() already found is what makes this actually
    // run rather than quietly depend on that coincidence. A full-screen
    // TUI also has no use for a file browser of this machine beside it.
    let command = tool;
    try { command = (await window.api.kube.ecosystemStatus())?.[tool]?.path || tool; } catch { /* falls back to the bare name */ }
    await openLocalShell(null, { command, args: ['--context=' + c.contextName], env, title, explorer: false });
    return;
  }
  // A plain shell still needs --context honoured by whatever is typed into
  // it, which env vars alone cannot do — KUBECTL_CONTEXT is not a thing
  // kubectl reads. kubeconfig's own `current-context` is the one knob nothing
  // needs to be told about twice, so it is set for just this shell's env by
  // writing it into the merged config... except kubeconfig has no per-env
  // override for that either. Simplest honest answer: name it in the title
  // and leave `--context=` to be typed, the same as a fresh terminal would.
  await openLocalShell(null, { env, title });
  toast(`KUBECONFIG set — add --context=${c.contextName} to kubectl/helm commands here`, 'info');
}

/** A file picker, appending to settings.kubeconfigPaths — kube.contexts() already reads every path there as `extraPaths`, so adding one just means picking it and saving it. */
async function addKubeconfig() {
  const paths = await window.api.dialog.openFiles({ title: 'Add a kubeconfig file' });
  if (!paths?.length) return;
  const existing = state.settings.kubeconfigPaths || [];
  const added = paths.filter((p) => !existing.includes(p));
  if (!added.length) return toast('Already added', 'info');
  state.settings = await window.api.settings.set({ kubeconfigPaths: [...existing, ...added] });
  toast(added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} kubeconfig files`);
  refreshKubeContexts();
}
