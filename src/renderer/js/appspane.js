import { state } from './state.js';
import { el, clear } from './util.js';
import { toast, textInput, select } from './ui.js';
import { clusterIcon } from './clustermarks.js';

/**
 * A cluster's apps in a pane of their own, one focused — the one-stop
 * alternative to working an app's own sidebar row: see every app on the
 * cluster, logged in or not, and log in, launch, or start proxying any of
 * them from here. Same trick as `hostspane.js`: an ordinary pane with no
 * session (see makeAppsPane in sessions.js), its own root div to render
 * into, redrawn whenever the list it is pointed at changes.
 */

/** Panes currently showing an apps list, so a login/logout redraws them. */
const live = new Map();   // paneId -> { proxy, home, cluster, focusApp, filter }

function viewPref() { return { mode: 'list', ...(state.settings.appsPaneView ? { mode: state.settings.appsPaneView } : {}) }; }
function sortPref() { return state.settings.appsPaneSort || 'name'; }
async function setPref(patch) {
  state.settings = await window.api.settings.set(patch);
  refreshAppsPanes();
}

/**
 * Open the apps view in a pane of its own — a new tab, or beside the
 * focused pane when `dir` says so. `focusApp` scrolls to and highlights
 * that one app, the usual case being "I just logged in to this one — show
 * me everything else I could also do."
 */
export async function openAppsPane({ proxy, home = null, cluster = null, focusApp = null, dir = null } = {}) {
  if (!proxy) return toast('No cluster to show apps for', 'error');
  const sessions = await import('./sessions.js');
  const label = cluster || proxy;

  // Already open for this cluster: focus it and move the highlight rather
  // than opening a second pane onto the same list.
  for (const [id, view] of live) {
    if (view.proxy !== proxy || (view.home || null) !== (home || null)) continue;
    const pane = state.getPane(id);
    if (!pane) { live.delete(id); continue; }
    view.focusApp = focusApp || view.focusApp;
    state.setActivePane(pane.id);
    render(pane);
    return pane;
  }

  const pane = dir
    ? await sessions.splitActivePane(dir, { apps: true })
    : await sessions.openAppsTab(`Apps · ${label}`);
  if (!pane) return undefined;

  live.set(pane.id, { proxy, home, cluster, focusApp, filter: '' });
  pane.title = `Apps · ${label}`;
  const name = pane.head?.querySelector('.pname');
  if (name) name.textContent = pane.title;
  sessions.refreshPaneTitles?.();
  render(pane);
  return pane;
}

/** Redraw every open apps pane — used after a login/logout changes status. */
export function refreshAppsPanes() {
  for (const [id] of live) {
    const pane = state.getPane(id);
    if (!pane) { live.delete(id); continue; }
    render(pane);
  }
}

/** Is this pane one of ours? `closePane` asks before tearing anything down. */
export function isAppsPane(paneId) {
  return live.has(paneId);
}

export function forgetAppsPane(paneId) {
  live.delete(paneId);
}

/** Every cluster this pane could be pointed at — any logged-in Teleport profile. */
function clusterChoices() {
  return (state.teleportProfiles || []).filter((p) => !p.expired);
}

function profileFor(view) {
  return clusterChoices().find((p) => p.proxy === view.proxy && (p.homeDir || null) === (view.home || null))
    || { proxy: view.proxy, homeDir: view.home, cluster: view.cluster };
}

/** `name=value` matches a label; anything else is matched against name/description/cloud/transport/labels. */
function matchesQuery(app, q) {
  if (!q) return true;
  const m = /^([\w.-]+)=(.*)$/.exec(q);
  if (m) {
    const [, k, v] = m;
    return Object.entries(app.labels || {}).some(([lk, lv]) =>
      lk.toLowerCase() === k.toLowerCase() && String(lv).toLowerCase().includes(v.toLowerCase()));
  }
  const text = q.toLowerCase();
  const hay = [app.name, app.description, app.cloud, app.transport,
    ...Object.entries(app.labels || {}).map(([k, v]) => `${k}=${v}`)]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(text);
}

function sortApps(apps, mode, profile, sidebar) {
  const list = [...apps];
  if (mode === 'transport') {
    list.sort((a, b) => (a.transport || '').localeCompare(b.transport || '') || a.name.localeCompare(b.name));
  } else if (mode === 'login') {
    const rank = (a) => (a.transport === 'tcp' ? 1 : sidebar.loginStatusFor(a, profile)?.loggedIn ? 0 : 2);
    list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return list;
}

function toolbar(pane, view, sidebar) {
  const clusterSel = select(
    clusterChoices().map((p) => ({
      value: `${p.proxy}\u0000${p.homeDir || ''}`,
      label: (clusterIcon(p) ? clusterIcon(p) + ' ' : '') + (p.cluster || p.proxy),
    })),
    `${view.proxy}\u0000${view.home || ''}`,
    { class: 'ap-cluster' },
  );
  clusterSel.title = 'Point this pane at a different cluster';
  clusterSel.addEventListener('change', () => {
    const [proxy, home] = clusterSel.value.split('\u0000');
    const p = clusterChoices().find((x) => x.proxy === proxy && (x.homeDir || '') === home);
    view.proxy = proxy;
    view.home = home || null;
    view.cluster = p?.cluster || proxy;
    view.focusApp = null;
    pane.title = `Apps · ${view.cluster}`;
    import('./sessions.js').then((m) => m.refreshPaneTitles?.());
    render(pane);
  });

  const find = textInput({ value: view.filter, placeholder: 'Search apps — name, description, or env=prod' });
  let filterTimer = null;
  find.addEventListener('input', () => {
    view.filter = find.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => renderList(pane, view, sidebar), 120);
  });

  const sortSel = select(
    [
      { value: 'name', label: 'Sort: Name' },
      { value: 'transport', label: 'Sort: Kind' },
      { value: 'login', label: 'Sort: Logged in first' },
    ],
    sortPref(),
  );
  sortSel.title = 'Order apps by name, kind (HTTP/TCP/cloud/MCP), or logged-in apps first';
  sortSel.addEventListener('change', () => setPref({ appsPaneSort: sortSel.value }));

  const viewToggle = (label, mode, title) => el('button', {
    class: 'ghost-btn sm' + (viewPref().mode === mode ? ' active' : ''), text: label, title,
    onClick: () => setPref({ appsPaneView: mode }),
  });

  return el('div', { class: 'ap-bar' },
    clusterSel,
    el('button', {
      class: 'ghost-btn sm', text: 'Refresh',
      onClick: () => render(pane),
    }),
    sortSel,
    el('div', { class: 'ap-seg' },
      viewToggle('List', 'list', 'One row per app'),
      viewToggle('Cards', 'card', 'Tiles, for scanning a lot of them')),
    find);
}

/** Grafana gets its own inline search box, right beside its name — see openGrafanaFor in sidebar.js. */
function grafanaExtra(app, profile, sidebar) {
  const input = textInput({ placeholder: 'Search dashboards…' });
  const go = () => { if (input.value.trim()) sidebar.openGrafanaFor(input.value.trim(), profile); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return el('span', { class: 'ap-grafana', onClick: (e) => e.stopPropagation() },
    input,
    el('button', { class: 'ghost-btn sm', text: 'Search', onClick: go }));
}

function renderList(pane, view, sidebar) {
  const body = pane.appsHost?.querySelector('.ap-body');
  if (!body) return;
  clear(body);

  let apps;
  try { apps = view.apps || []; } catch { apps = []; }
  if (!apps.length) {
    body.append(el('div', { class: 'sb-empty', text: view.error || 'No apps visible on this cluster.' }));
    return;
  }

  const profile = profileFor(view);
  const q = view.filter.trim();
  const filtered = q ? apps.filter((a) => matchesQuery(a, q)) : apps;
  const shown = sortApps(filtered, sortPref(), profile, sidebar);

  if (!shown.length) {
    body.append(el('div', { class: 'sb-empty', text: `No apps match "${q}".` }));
    return;
  }

  const mode = viewPref().mode;
  const list = el('div', { class: mode === 'card' ? 'ap-cards' : 'ap-list' });
  let focusedRow = null;
  for (const app of shown) {
    const focused = !!(view.focusApp && app.name === view.focusApp);
    const row = sidebar.appRow(app, profile, { focused });
    if (/grafana/i.test(app.name) || /grafana/i.test(app.description || '')) row.querySelector('.sb-line')?.append(grafanaExtra(app, profile, sidebar));
    if (focused) focusedRow = row;
    list.append(row);
  }
  body.append(list);
  if (focusedRow) focusedRow.scrollIntoView({ block: 'center' });
}

async function render(pane) {
  const view = live.get(pane.id);
  if (!view || !pane.appsHost) return;
  const host = pane.appsHost;
  clear(host);

  const sidebar = await import('./sidebar.js');
  const profile = profileFor(view);

  host.append(toolbar(pane, view, sidebar), el('div', { class: 'ap-body' }));
  renderList(pane, view, sidebar);   // shows "No apps" until the real list lands

  try {
    view.apps = await window.api.apps.list({ proxy: view.proxy, home: view.home });
    view.error = null;
  } catch (e) {
    view.apps = [];
    view.error = e.message;
  }
  // The fetch above may outlive the pane (closed) or the view it was for
  // (cluster picker switched) while it was in flight.
  if (!live.has(pane.id) || live.get(pane.id) !== view || !pane.appsHost) return;

  if (view.apps.length) {
    sidebar.refreshAppsLoginStatuses(profile, view.apps.filter((a) => a.transport !== 'tcp').map((a) => a.name));
  }
  renderList(pane, view, sidebar);
}

/**
 * What a pane is currently showing — used by `splitActivePane` (sessions.js)
 * so a bare split off an apps pane reopens the same list rather than
 * falling through to a disconnected local shell.
 */
export function appsPaneView(paneId) {
  return live.get(paneId) || null;
}
