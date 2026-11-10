import { state } from './state.js';
import { el, clear, colorCss } from './util.js';
import { status, toast, textInput, contextMenu, select } from './ui.js';
import { labelEntries, compileQuery, mostCommonLabelKeys } from './tags.js';
import {
  foldersIn, hostsInFolder, hostsInTree, isFiled, hostKey,
  folderIcon, folderColor, fileHostsInto, openFolderDialog, unfileHost, groupKeyFor,
} from './folders.js';
import { missingIn, missingLine, goneFor, isWatched, showWatchMark } from './watch.js';
import { clusterIcon } from './clustermarks.js';
import { isStale, staleLabel, ageLabel, heartbeatAge, heartbeatLine } from './heartbeat.js';
import { profileMeta } from './profiles.js';

/**
 * A cluster's hosts, given the whole pane.
 *
 * The sidebar is a three-hundred-pixel column. That is the right shape for
 * "open that host" and the wrong shape for looking at a fleet: a hundred
 * nodes in a column is a scroll, their labels are truncated to a badge, and
 * the folders you built are a tree squeezed into a gutter. This is the same
 * inventory with the room it needs — and it is a real pane, so it splits,
 * sits beside a terminal, and closes like anything else.
 *
 * Three things it can be told, all remembered:
 *
 *   folders on or off   the arrangement, or the plain list of everything
 *   list or boxes       rows to read, or tiles to scan
 *   a filter            the same query language as everywhere else
 *
 * It draws from the same state the sidebar draws from and writes through the
 * same functions, so filing something here moves it there, immediately.
 */

/** Panes currently showing hosts, so inventory changes can redraw them. */
const live = new Map();   // paneId -> { groupKey, filter, picked, shut }

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

/**
 * Open the hosts view in a pane of its own — a new tab, or beside the
 * focused pane when `dir` says so.
 */
export async function openHostsPane({ groupKey = null, dir = null } = {}) {
  const sidebar = await import('./sidebar.js');
  const panel = await import('./teleportpanel.js');
  const groups = paneGroups(sidebar, panel);
  if (!groups.length) return toast('No clusters or ssh hosts to show yet', 'error');
  const key = groupKey && groups.some((g) => g.key === groupKey) ? groupKey : groups[0].key;
  const label = groups.find((g) => g.key === key)?.label || 'Hosts';

  const sessions = await import('./sessions.js');
  const pane = dir
    ? await sessions.splitActivePane(dir, { hosts: true })
    : await sessions.openHostsTab(`Hosts · ${label}`);
  if (!pane) return undefined;

  live.set(pane.id, {
    groupKey: key,
    filter: '',
    picked: new Set(),
    shut: new Set(),
  });
  pane.title = `Hosts · ${label}`;
  pane.hostsGroup = key;
  const name = pane.head?.querySelector('.pname');
  if (name) name.textContent = pane.title;
  sessions.refreshPaneTitles?.();
  render(pane);
  return pane;
}

/** Redraw every open hosts pane — the inventory or the folders have moved. */
export function refreshHostsPanes() {
  for (const [id] of live) {
    const pane = state.getPane(id);
    if (!pane) { live.delete(id); continue; }
    render(pane);
  }
}

/** Is this pane one of ours? `closePane` asks before tearing a terminal down. */
export function isHostsPane(paneId) {
  return live.has(paneId);
}

export function forgetHostsPane(paneId) {
  live.delete(paneId);
}

/**
 * Whichever hosts are currently picked in this pane, host-shaped. Used by
 * `splitActivePane` (sessions.js) so a bare split (⌘⇧D/⌘⇧E, no host named)
 * on a hosts pane targets the host actually selected there instead of
 * falling through to a disconnected local shell.
 */
export function pickedHostsOf(paneId) {
  const view = live.get(paneId);
  if (!view) return [];
  return shownHosts(view).filter((h) => view.picked.has(hostKey(h)));
}

/* ------------------------------------------------------------------ */
/* Which lists can be shown                                            */
/* ------------------------------------------------------------------ */

/**
 * Nodes of a leaf cluster, fetched on demand and kept for a while.
 *
 * The sidebar only ever holds the nodes of the cluster each profile is
 * currently pointed at, because that is the list it draws. A leaf is a
 * different cluster behind the same proxy, and asking for it is one
 * `tsh ls --cluster=<leaf>` — cheap, but not something to repeat on every
 * redraw, so the answer is cached and re-read when it is stale.
 */
const leafNodes = new Map();   // pane key -> { at, nodes, error }
const LEAF_TTL = 30000;

/**
 * Kubernetes clusters, host-shaped, for a Teleport cluster group — same
 * `kubeHostsForProfile(p)` the sidebar tree already merges into its own
 * SSH list (sidebar.js's own `[...sshHosts, ...kubeHosts]`), filtered
 * by *this pane's* own `requestableOn()` rather than
 * `kubeHostsForProfile`'s internal default (the sidebar's own, separate
 * per-group "show requestable" toggle) — so the one setting on this
 * pane governs everything it shows, SSH or kube, not two different
 * toggles disagreeing with each other on the same screen. Only root
 * Teleport-cluster groups have a profile to resolve; a leaf or an SSH
 * config-file group correctly gets nothing back.
 */
function kubeHostsFor(groupKey) {
  if (!lastKubepanel) return [];
  const p = (state.teleportProfiles || []).find((x) => groupKeyFor(x) === groupKey);
  if (!p) return [];
  return lastKubepanel.kubeHostsForProfile(p).filter((h) => requestableOn() || !h.requestable);
}

/**
 * Whatever the pane is currently showing, without going back to the source.
 *
 * For a leaf that is the cache the render filled; for anything else it is
 * the sidebar's own list. Used by the handlers that run after a render —
 * a drop, a dialog — which need the same hosts the user is looking at.
 */
function shownHosts(view) {
  const leaf = leafOf(view.groupKey);
  const held = leaf
    ? leafNodes.get(view.groupKey)?.nodes || []
    : (lastSidebar ? lastSidebar.hostsInGroup(view.groupKey) : []);
  // Everything the render draws, not only what you hold: a requestable row
  // or a missing one that is dragged has to be found again on the drop, or
  // the drop quietly files nothing.
  const have = new Set(held.map((h) => h.uuid).filter(Boolean));
  const askable = requestableOn() ? (view.reqHosts || []).filter((h) => !have.has(h.uuid)) : [];
  const list = [...held, ...askable, ...(leaf ? [] : kubeHostsFor(view.groupKey))];
  return [...list, ...missingIn(view.groupKey, list)];
}

/** The sidebar module, kept from the last render so handlers can be sync. */
let lastSidebar = null;
/** Same reasoning, for kubeHostsForProfile() — kube clusters, host-shaped, in this same list. */
let lastKubepanel = null;

/** A selection key naming a leaf, or null for an ordinary group. */
function leafOf(key) {
  const i = String(key || '').indexOf('::');
  if (i < 0) return null;
  return { group: key.slice(0, i), cluster: key.slice(i + 2) };
}

/**
 * Everything the pane can be pointed at: the groups the sidebar draws, plus
 * every leaf cluster behind each of them.
 *
 * Leaves belong here and not in the sidebar for the same reason the pane
 * exists at all — the sidebar is a column showing the cluster you are
 * logged into, and switching it to a leaf is a `tsh login`. Reading a
 * leaf's inventory is not a switch, it is a question, and this is the view
 * with room to ask it.
 */
export function paneGroups(sidebar, panel) {
  const out = [];
  for (const g of sidebar.folderGroups()) {
    out.push(g);
    if (g.kind !== 'teleport') continue;
    const p = (state.teleportProfiles || []).find((x) => sidebar.groupKeyFor(x) === g.key);
    if (!p) continue;
    for (const leaf of panel.leavesFor(p)) {
      if (leaf.name === p.cluster) continue;   // that is the entry above
      out.push({
        key: `${g.key}::${leaf.name}`,
        label: `${g.label} \u203A ${leaf.name}`,
        kind: 'leaf',
        proxy: p.proxy,
        home: p.homeDir || null,
        cluster: leaf.name,
      });
    }
  }
  // Every saved profile, as one more group to point the pane at \u2014 off by
  // default (the "Saved" toggle), since most of the time the question is
  // about a cluster's own hosts, not the separate list of saved shortcuts.
  if (profilesOn() && (state.profiles || []).length) {
    out.push({ key: 'profiles', label: 'Saved', kind: 'profiles' });
  }
  return out;
}

/**
 * The hosts for a selection: straight from the sidebar's own lists for a
 * cluster it draws, and from a cached `tsh ls` for a leaf.
 *
 * A leaf that has not been read yet returns nothing and starts the read;
 * `onReady` redraws when it lands, which keeps the render itself
 * synchronous and the pane responsive while a slow proxy answers.
 */
/**
 * What this cluster would let you ask for, fetched once per view and kept
 * until the toggle or the cluster changes. The search is a round trip to
 * the proxy, so it is not something to do on every redraw.
 */
function requestableFor(view, groups, onReady) {
  if (!requestableOn()) return [];
  const g = clusterOf(view.groupKey, groups);
  if (!g?.proxy) return [];
  const key = `${g.proxy}\u0000${g.home || ''}`;
  if (view.reqKey !== key || view.reqAt === undefined) {
    if (!view.reqFetching) {
      view.reqFetching = true;
      import('./requestable.js')
        .then((m) => m.requestableHosts({ proxy: g.proxy, home: g.home, cluster: g.cluster }))
        .then((r) => { view.reqHosts = r.hosts; view.reqError = r.error; })
        .catch((e) => { view.reqHosts = []; view.reqError = e.message; })
        .finally(() => {
          view.reqFetching = false;
          view.reqKey = key;
          view.reqAt = Date.now();
          onReady();
        });
    }
    return view.reqHosts || [];
  }
  return view.reqHosts || [];
}

/**
 * The cluster a pane is pointed at, as proxy, home and cluster name.
 *
 * A leaf entry in the picker carries all three; the root entry is built
 * from the folder groups and carries none, so it is matched back to its
 * profile. Without this the root cluster — the common case — looked like a
 * group with no proxy, and anything that needs to ask the cluster something
 * quietly did nothing.
 */
function clusterOf(groupKey, groups) {
  const g = groups.find((x) => x.key === groupKey);
  if (g?.proxy) return g;
  const p = (state.teleportProfiles || []).find((x) => groupKeyFor(x) === groupKey);
  return p ? { proxy: p.proxy, home: p.homeDir || null, cluster: p.cluster } : null;
}

function hostsFor(view, groups, sidebar, onReady) {
  // Saved profiles are already loaded into state — no fetch, no cache, no
  // leaf/requestable machinery, which none of them apply to.
  if (view.groupKey === 'profiles') {
    return { hosts: state.profiles || [], loading: false, error: null };
  }
  const askable = requestableFor(view, groups, onReady);
  const withAskable = (list) => {
    if (!askable.length) return list;
    // Anything already reachable wins: the same node cannot be both, and
    // what you hold is the more useful of the two rows.
    const have = new Set(list.map((h) => h.uuid).filter(Boolean));
    return [...list, ...askable.filter((h) => !have.has(h.uuid))];
  };
  const leaf = leafOf(view.groupKey);
  if (!leaf) {
    return { hosts: [...withAskable(sidebar.hostsInGroup(view.groupKey)), ...kubeHostsFor(view.groupKey)], loading: false, error: null };
  }

  const cached = leafNodes.get(view.groupKey);
  const fresh = cached && Date.now() - cached.at < LEAF_TTL;
  if (!fresh && !view.fetching) {
    const g = groups.find((x) => x.key === view.groupKey);
    if (g) {
      view.fetching = true;
      window.api.teleport.nodes({ proxy: g.proxy, cluster: g.cluster, home: g.home })
        .then((r) => {
          leafNodes.set(view.groupKey, {
            at: Date.now(),
            nodes: r?.ok ? r.nodes : [],
            error: r?.ok ? null : (r?.error || 'that cluster would not answer'),
          });
        })
        .catch((e) => leafNodes.set(view.groupKey, { at: Date.now(), nodes: [], error: e.message }))
        .finally(() => { view.fetching = false; onReady(); });
    }
  }
  return {
    hosts: withAskable(cached?.nodes || []),
    loading: !cached,
    error: cached?.error || null,
  };
}

/* ------------------------------------------------------------------ */
/* Settings the view remembers                                         */
/* ------------------------------------------------------------------ */

function boxView() { return state.settings.hostsPaneView === 'box'; }
function tableView() { return state.settings.hostsPaneView === 'table'; }
// Only meaningful in Table view — the toggle that offers it is hidden
// everywhere else, but a stale `true` from a prior session should not
// quietly turn List/Boxes into something they were never designed to show.
function labelColumnsOn() { return tableView() && state.settings.hostsPaneLabelColumns === true; }
function foldersOn() { return state.settings.hostsPaneFolders !== false; }
/*
 * Off by default: a cluster can offer far more than you hold, and a list
 * that opens with everything you *could* ask for buries the handful you
 * actually use.
 */
function requestableOn() { return state.settings.hostsPaneRequestable === true; }
// Also off by default — a "Saved" group of every saved profile alongside a
// cluster's own hosts is extra, not the common case.
function profilesOn() { return state.settings.hostsPaneProfiles === true; }

async function setPref(patch) {
  state.settings = await window.api.settings.set(patch);
  refreshHostsPanes();
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

function sortPref() { return state.settings.hostsPaneSort || { mode: 'name' }; }
function nameOf(h) { return h.name || h.alias || ''; }

/** Lower sorts first: connected, then the normal ones, then stale, gone, requestable. */
function statusRankOf(h) {
  if ([...state.connections.values()].some((c) => c.hostId === h.id && c.state === 'connected')) return 0;
  if (h.missing) return 3;
  if (isStale(h)) return 2;
  if (h.requestable) return 4;
  return 1;
}

/**
 * Every label key across this list, by how often it appears, most common
 * first — what the toolbar's sort dropdown offers beyond Name and Status.
 */
function labelKeysIn(hosts) {
  const counts = new Map();
  for (const h of hosts) {
    for (const [k] of labelEntries(h)) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/**
 * Hosts in the chosen order — Name (default), Status, or a label's value,
 * which is what clusters `env=prod` rows together. A host missing the
 * chosen label sorts after everything that has it, never erroring.
 */
function sortHosts(hosts, pref = sortPref()) {
  const list = [...hosts];
  if (pref.mode === 'status') {
    list.sort((a, b) => statusRankOf(a) - statusRankOf(b) || nameOf(a).localeCompare(nameOf(b)));
  } else if (pref.mode === 'label' && pref.labelKey) {
    const valueOf = (h) => (labelEntries(h).find(([k]) => k === pref.labelKey) || [])[1];
    list.sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va === undefined && vb === undefined) return nameOf(a).localeCompare(nameOf(b));
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      return String(va).localeCompare(String(vb)) || nameOf(a).localeCompare(nameOf(b));
    });
  } else {
    list.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }
  return list;
}


/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function render(pane) {
  const view = live.get(pane.id);
  if (!view || !pane.hostsHost) return;
  const host = pane.hostsHost;
  clear(host);

  Promise.all([import('./sidebar.js'), import('./teleportpanel.js'), import('./kubepanel.js')]).then(([sidebar, panel, kubepanel]) => {
    if (!state.getPane(pane.id)) return;
    lastSidebar = sidebar;
    lastKubepanel = kubepanel;
    const groups = paneGroups(sidebar, panel);
    const here = hostsFor(view, groups, sidebar, () => render(pane));
    // Watched hosts that have left the inventory are drawn here too: this
    // pane is the fleet view, and "what is missing" is a fleet question.
    const isProfiles = view.groupKey === 'profiles';
    const all = isProfiles ? here.hosts : [...here.hosts, ...missingIn(view.groupKey, here.hosts)];
    const q = view.filter.trim() ? compileQuery(view.filter) : null;
    const hosts = q ? all.filter(q.match) : all;

    clear(host);
    host.append(
      toolbar(pane, view, groups, all, hosts, here, sidebar),
      el('div', { class: 'hp-body' + (boxView() ? ' boxes' : tableView() ? ' table' : '') },
        ...(here.loading
          ? [el('div', { class: 'hp-empty', text: 'Reading that cluster…' })]
          : here.error
          ? [el('div', { class: 'hp-empty' },
              el('div', { style: 'color:var(--amber)', text: here.error }),
              el('div', { class: 'hint', style: 'margin-top:8px', text: 'A leaf is read with its own tsh ls; the certificate for the root has to be good.' }))]
          : content(pane, view, hosts, isProfiles))));
  }).catch((e) => {
    host.append(el('div', { class: 'hp-empty', text: e.message }));
  });
}

/**
 * What a "Refresh" click in this pane means for the group it is pointed at:
 * a leaf just drops the cached `tsh ls` so the next render re-asks for it,
 * a root cluster or an ssh config file goes through the same re-read the
 * sidebar's own ⟳ triggers for that group.
 */
async function refreshCurrent(pane, view, groups, sidebar) {
  if (view.refreshing) return;
  if (view.groupKey === 'profiles') {
    view.refreshing = true;
    render(pane);
    try { await sidebar.reloadProfiles(); } catch (e) { toast(e.message || String(e), 'error'); }
    view.refreshing = false;
    render(pane);
    return;
  }
  const leaf = leafOf(view.groupKey);
  view.refreshing = true;
  render(pane);
  try {
    if (leaf) {
      leafNodes.delete(view.groupKey);
    } else {
      const g = groups.find((x) => x.key === view.groupKey);
      if (g?.kind === 'ssh') {
        await sidebar.refreshSshConfigs(g.key);
      } else {
        const p = (state.teleportProfiles || []).find((x) => groupKeyFor(x) === view.groupKey);
        if (p) await sidebar.refreshProfile(p);
        else await sidebar.refreshInventory();
      }
    }
  } catch (e) {
    toast(e.message || String(e), 'error');
  } finally {
    view.refreshing = false;
    render(pane);
  }
}

function toolbar(pane, view, groups, all, shown, here = {}, sidebar) {
  const isProfiles = view.groupKey === 'profiles';
  const groupSel = el('select', { class: 'hp-group' },
    /*
     * The cluster's own icon rides along in the picker, so the pane names
     * the cluster the same way the host list and the Teleport tab do. The
     * colour does not: this is a <select>, and an option's colour is the
     * platform's to decide.
     */
    ...groups.map((g) => el('option', {
      value: g.key,
      text: (clusterIcon(g.key) ? clusterIcon(g.key) + ' ' : '') + g.label,
      selected: g.key === view.groupKey || null,
    })));
  groupSel.addEventListener('change', () => {
    view.groupKey = groupSel.value;
    pane.hostsGroup = groupSel.value;
    view.picked = new Set();
    // A different group can be a wildly different scale — opting into the
    // full, uncapped render of one cluster should not carry into the next.
    view.showAllRows = false;
    const label = groups.find((g) => g.key === view.groupKey)?.label || 'Hosts';
    pane.title = `Hosts · ${label}`;
    import('./sessions.js').then((m) => m.refreshPaneTitles?.());
    render(pane);
  });

  const find = textInput({ value: view.filter, placeholder: 'Filter — env=prod, name~^web, tag:gpu' });
  // Debounced: each keystroke rebuilds every row still matching, and on a
  // large fleet that rebuild itself takes long enough to feel like lag
  // typing fast would otherwise pay for on every single character.
  let filterTimer = null;
  find.addEventListener('input', () => {
    view.filter = find.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      const body = pane.hostsHost.querySelector('.hp-body');
      if (!body) return render(pane);
      const q = view.filter.trim() ? compileQuery(view.filter) : null;
      // Only the listing is rebuilt — a full redraw would take the focus out
      // of the box on every keystroke — so it resolves the hosts the same way
      // the full render does, cache and all.
      import('./sidebar.js').then((sidebar) => {
        const src = hostsFor(view, groups, sidebar, () => render(pane));
        const list = [...src.hosts, ...missingIn(view.groupKey, src.hosts)];
        clear(body);
        body.append(...content(pane, view, q ? list.filter(q.match) : list, isProfiles));
        const n = pane.hostsHost.querySelector('.hp-count');
        if (n) n.textContent = countText(q ? list.filter(q.match).length : list.length, list.length);
      });
      return undefined;
    }, 120);
  });

  const toggle = (label, on, title, onClick) => el('button', {
    class: 'ghost-btn sm' + (on ? ' active' : ''), text: label, title, onClick,
  });

  /*
   * Name, Status, or a label key seen on this group's own hosts — built
   * fresh each render so it always offers what is actually here, rather
   * than a fixed list that could name a label this cluster has never used.
   * Encoded as one string so a plain <select> can hold it.
   */
  const sortOptions = [
    { value: 'name', label: 'Sort: Name' },
    { value: 'status', label: 'Sort: Status' },
    ...labelKeysIn(all).map((k) => ({ value: 'label:' + k, label: `Sort: ${k}` })),
  ];
  const curSort = sortPref();
  const curSortValue = curSort.mode === 'label' && curSort.labelKey ? 'label:' + curSort.labelKey : curSort.mode;
  const sortSel = select(sortOptions, sortOptions.some((o) => o.value === curSortValue) ? curSortValue : 'name');
  sortSel.title = 'Order hosts by name, status, or a label’s value — '
    + 'picking a label clusters the same value together, e.g. every env=prod row';
  sortSel.addEventListener('change', () => {
    const v = sortSel.value;
    setPref({ hostsPaneSort: v.startsWith('label:') ? { mode: 'label', labelKey: v.slice(6) } : { mode: v } });
  });

  return el('div', { class: 'hp-bar' },
    groupSel,
    el('button', {
      class: 'ghost-btn sm',
      text: view.refreshing ? 'Refreshing…' : 'Refresh',
      title: isProfiles ? 'Re-read the saved profile list'
        : leafOf(view.groupKey)
        ? 'Re-read this leaf cluster’s nodes'
        : 'Re-read this cluster or config file — the same ⟳ the sidebar heading makes',
      disabled: view.refreshing || null,
      onClick: () => refreshCurrent(pane, view, groups, sidebar),
    }),
    ...(isProfiles ? [] : [toggle('Requestable', requestableOn(),
      requestableOn()
        ? 'Also listing what this cluster would let you ask for — click to show only what you hold'
        : 'Also list what this cluster would let you ask for, tagged req',
      () => setPref({ hostsPaneRequestable: !requestableOn() }))]),
    toggle('Saved', profilesOn(),
      profilesOn() ? 'Also listing saved profiles as their own group — click to hide them'
        : 'Also list every saved profile (SFTP, VNC, RDP, serial, telnet…) as its own group',
      () => setPref({ hostsPaneProfiles: !profilesOn() })),
    toggle('Folders', foldersOn(),
      foldersOn() ? 'Showing the folder arrangement — click for the plain list'
        : 'Showing every host in one list — click for the folders',
      () => setPref({ hostsPaneFolders: !foldersOn() })),
    el('div', { class: 'hp-seg' },
      toggle('List', !boxView() && !tableView(), 'One row per host', () => setPref({ hostsPaneView: 'list' })),
      toggle('Boxes', boxView(), 'Tiles, for scanning a lot of them', () => setPref({ hostsPaneView: 'box' })),
      toggle('Table', tableView(), 'Columns, for sorting and scanning a lot of them at once',
        () => setPref({ hostsPaneView: 'table' }))),
    /*
     * Table-only: breaking labels into their own columns is a table idea —
     * List and Boxes already show every label as chips, where "which column"
     * means nothing.
     */
    ...(tableView() ? [toggle('Label columns', labelColumnsOn(),
      labelColumnsOn()
        ? 'Labels most of these hosts share are their own columns — click for one combined Labels column'
        : 'Break out the labels most of these hosts share into their own sortable columns',
      () => setPref({ hostsPaneLabelColumns: !labelColumnsOn() }))] : []),
    ...(isProfiles ? [] : [sortSel]),
    find,
    el('span', {
      class: 'hp-count',
      text: here.loading ? 'reading…' : countText(shown.length, all.length),
    }),
    el('span', { style: 'flex:1' }),
    ...(isProfiles ? [] : [el('button', {
      class: 'ghost-btn sm', text: 'New folder…',
      onClick: () => openFolderDialog({ group: view.groupKey, hosts: all }),
    })]));
}


function countText(shown, total) {
  return shown === total ? `${total} host${total === 1 ? '' : 's'}` : `${shown} of ${total}`;
}

/**
 * The hosts, arranged or not.
 *
 * With folders off this is one flat run of everything, which is what you
 * want when the question is about the fleet rather than about your own
 * filing. With them on, each folder is a heading you can drop onto, its
 * subfolders indented under it, and whatever is left over lands in Unfiled —
 * named rather than silent, because "the rest" is a real category and a list
 * that quietly omits things is worse than a long one.
 */
/*
 * A render here is a full DOM rebuild — every row is real nodes, not a
 * virtualized window — because folding that in would mean rewriting grid(),
 * table() and the folder walk together to agree on what is "visible", for a
 * case (tens of thousands of hosts in one group) that is rare. Capping how
 * many rows a single render actually builds is the cheap version of the same
 * protection: past this many, each redraw (a keystroke in the filter among
 * them) is a visible stall rather than a sub-frame update. "Show all" is one
 * click away for whoever actually wants the full list drawn.
 */
const ROW_CAP = 500;

function capNotice(pane, view, total) {
  return el('div', { class: 'hp-empty', style: 'padding:6px 9px;text-align:left' },
    el('span', { text: `Showing ${ROW_CAP.toLocaleString()} of ${total.toLocaleString()} hosts. ` }),
    el('button', {
      class: 'ghost-btn sm', text: 'Show all',
      title: 'Draw every one of them — a redraw this big can take a moment, and typing in the filter will too',
      onClick: () => { view.showAllRows = true; render(pane); },
    }));
}

function content(pane, view, hosts, isProfiles = false) {
  if (isProfiles) return profilesContent(pane, view, hosts);
  if (!hosts.length) {
    return [el('div', { class: 'hp-empty' },
      el('div', { text: view.filter ? 'Nothing matches that filter.' : 'No hosts in this group.' }))];
  }
  // Sorted once, up front: filtering a sorted list into folders and an
  // Unfiled bucket below keeps every one of them in that same order, which
  // is "sorted within each folder" without sorting each bucket separately.
  hosts = sortHosts(hosts);
  const total = hosts.length;
  const notice = total > ROW_CAP && !view.showAllRows ? capNotice(pane, view, total) : null;
  if (notice) hosts = hosts.slice(0, ROW_CAP);
  // Columns are chosen from what is actually about to be drawn — capped or
  // not — so a huge fleet never pays for a frequency scan over hosts that
  // will not even get a row.
  view.labelColumns = tableView() && labelColumnsOn() ? mostCommonLabelKeys(hosts) : [];

  if (!foldersOn()) return [...(notice ? [notice] : []), rowsFor(pane, view, hosts)];

  const out = [];
  const walk = (parent, depth) => {
    for (const f of foldersIn(view.groupKey, parent)) {
      const deep = hostsInTree(f, hosts);
      if (view.filter && !deep.length) continue;
      out.push(folderHead(pane, view, f, depth, deep.length));
      if (view.shut.has(f.id)) continue;
      const mine = hostsInFolder(f, hosts);
      if (mine.length) out.push(rowsFor(pane, view, mine, depth + 1, f));
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);

  const loose = hosts.filter((h) => !isFiled(h, view.groupKey));
  if (loose.length) {
    out.push(el('div', { class: 'hp-head unfiled' },
      el('span', { class: 'fico', text: '—' }),
      el('span', { class: 'name', text: 'Unfiled' }),
      el('span', { class: 'count', text: String(loose.length) })));
    out.push(rowsFor(pane, view, loose, 0, null));
  }
  return [...(notice ? [notice] : []), ...out];
}


/** The chosen layout for a list of hosts — a table only in Table view. */
function rowsFor(pane, view, hosts, depth = 0, folder = null) {
  return tableView() ? table(pane, view, hosts, depth, folder) : grid(pane, view, hosts, depth, folder);
}

/**
 * Saved profiles, for the "Saved" group — flat by the profile's own
 * `folderId`, the same grouping the Saved tab uses (`renderSavedTab` in
 * sidebar.js), not the Teleport/ssh tree-folder system above: that is keyed
 * by a cluster's groupKey and a profile belongs to no cluster.
 */
function profilesContent(pane, view, hosts) {
  if (!hosts.length) {
    return [el('div', { class: 'hp-empty' },
      el('div', { text: view.filter ? 'Nothing matches that filter.' : 'No saved profiles yet.' }))];
  }
  if (!foldersOn()) return [grid(pane, view, hosts, 0, null, profileCard)];

  const byFolder = new Map();
  for (const p of hosts) {
    const key = p.folderId || '';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(p);
  }
  const out = [];
  for (const folder of state.folders || []) {
    const items = byFolder.get(folder.id) || [];
    if (!items.length) continue;
    const colour = folderColor(folder);
    out.push(el('div', { class: 'hp-head' + (colour ? ' coloured' : ''), style: colour ? `--folder-color:${colour}` : null },
      el('span', { class: 'fico', text: folderIcon(folder, true) }),
      el('span', { class: 'name', text: folder.name }),
      el('span', { class: 'count', text: String(items.length) })));
    out.push(grid(pane, view, items, 1, null, profileCard));
  }
  const loose = byFolder.get('') || [];
  if (loose.length) {
    out.push(el('div', { class: 'hp-head unfiled' },
      el('span', { class: 'fico', text: '—' }),
      el('span', { class: 'name', text: 'Unfiled' }),
      el('span', { class: 'count', text: String(loose.length) })));
    out.push(grid(pane, view, loose, 0, null, profileCard));
  }
  return out;
}

function folderHead(pane, view, folder, depth, count) {
  const shut = view.shut.has(folder.id);
  const colour = folderColor(folder);
  const head = el('div', {
    class: 'hp-head' + (colour ? ' coloured' : ''),
    style: `--depth:${depth}` + (colour ? `;--folder-color:${colour}` : ''),
    title: folder.rule ? `Fills itself with: ${folder.rule}` : 'Drop hosts here to file them',
  },
    el('span', { class: 'chev', text: shut ? '▶' : '▼' }),
    el('span', { class: 'fico', text: folderIcon(folder, !shut) }),
    el('span', { class: 'name', text: folder.name }),
    folder.rule ? el('span', { class: 'tag rule', text: 'rule' }) : null,
    el('span', { class: 'count', text: String(count) }));

  head.addEventListener('click', () => {
    shut ? view.shut.delete(folder.id) : view.shut.add(folder.id);
    render(pane);
  });

  // A folder heading is a drop target, which is what makes this pane a place
  // you can do the filing rather than only look at it.
  head.addEventListener('dragover', (e) => {
    if (!dragging || dragging.paneId !== pane.id) return;
    e.preventDefault();
    head.classList.add('drop-in');
  });
  head.addEventListener('dragleave', () => head.classList.remove('drop-in'));
  head.addEventListener('drop', async (e) => {
    if (!dragging || dragging.paneId !== pane.id) return;
    e.preventDefault();
    head.classList.remove('drop-in');
    const keys = dragging.keys;
    dragging = null;
    // The same resolver the render uses, so a leaf's hosts can be filed
    // exactly like a root cluster's.
    const list = shownHosts(view).filter((h) => keys.includes(hostKey(h)));
    const r = await fileHostsInto(list, folder, view.groupKey);
    if (r) status(`${r.count} host${r.count === 1 ? '' : 's'} ${r.mode === 'move' ? 'moved to' : 'added to'} ${folder.name}`);
  });
  return head;
}

let dragging = null;

function grid(pane, view, hosts, depth = 0, folder = null, cardFn = card) {
  const wrap = el('div', {
    class: 'hp-grid' + (boxView() ? ' boxes' : ''),
    style: depth ? `--depth:${depth}` : null,
  });
  for (const h of hosts) wrap.append(cardFn(pane, view, h, folder));
  return wrap;
}

/**
 * Double-click a host row: request it if it is only requestable, say so if
 * it is missing, otherwise open it the way the list does. Shared by the
 * card/box renderer and the table-row renderer below, so both layouts
 * behave identically.
 */
async function openHostRow(host) {
  // A kube cluster is host-shaped only for the folder/filter/drag
  // machinery above — its own open/request is nothing like an SSH
  // host's (see kubeHostsFor()'s own doc comment), so none of the SSH
  // logic below ever runs for one.
  if (host.kind === 'kube') {
    if (host.requestable) {
      const { requestKubeAccessFor } = await import('./sidebar.js');
      await requestKubeAccessFor(host);
      return;
    }
    const kubepanel = await import('./kubepanel.js');
    if (host.kubeContext) {
      const kubebrowser = await import('./kubebrowser.js');
      const c = host.kubeContext;
      await kubebrowser.openKubeBrowser(
        { ...kubepanel.kubeSpecOf(c), teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null },
        c.kubeClusterName || c.name,
      );
      return;
    }
    if (host.availableCluster) await kubepanel.connectAvailableCluster(host.profile, host.availableCluster);
    return;
  }
  if (host.requestable) {
    const { requestAccessFor } = await import('./sidebar.js');
    await requestAccessFor(host);
    return;
  }
  if (host.missing) {
    toast(`${host.name} is not in the inventory any more — last seen ${goneFor(host.missingSince)} ago`, 'error');
    return;
  }
  // The host list's own open: the pinned or remembered account, and the
  // MFA route where the node needs one.
  const { openHostFromList } = await import('./sidebar.js');
  await openHostFromList(host);
}

/**
 * Right-click a host row, in either layout. A multi-selection gets its own
 * small menu — for now just a bulk "Request access…" — rather than the
 * single-host menu, which has nothing to say about more than one host at
 * once; picking it also updates the selection to the clicked row first, the
 * same as a single-host right-click already did.
 */
async function openHostRowMenu(e, pane, view, host, folder) {
  const k = hostKey(host);
  if (!view.picked.has(k)) pick(pane, view, k, {});
  if (view.picked.size > 1) {
    const picked = shownHosts(view).filter((h) => view.picked.has(hostKey(h)));
    // Bulk requesting stays SSH-node-only — requestAccessForMany() builds
    // every request as a `node`, the same reason a single kube row below
    // goes through requestKubeAccessFor() instead of requestAccessFor().
    // A ticked kube cluster just isn't counted here, the same as if it
    // weren't selectable for this particular action at all.
    const reqable = picked.filter((h) => h.requestable && h.kind !== 'kube');
    contextMenu(e.clientX, e.clientY, [{
      label: `Request access to ${reqable.length} node${reqable.length === 1 ? '' : 's'}…`,
      disabled: !reqable.length,
      onClick: async () => {
        const { requestAccessForMany } = await import('./sidebar.js');
        await requestAccessForMany(reqable);
      },
    }]);
    return;
  }
  if (host.kind === 'kube') {
    if (host.requestable) {
      const [{ requestKubeAccessFor, requestKubeResourceAccessFor }, { toggleWatch }] = await Promise.all([import('./sidebar.js'), import('./watch.js')]);
      contextMenu(e.clientX, e.clientY, [
        { label: host.name, heading: true },
        { label: 'Request access to it…', onClick: () => requestKubeAccessFor(host) },
        { label: 'Request a namespace or pod…', onClick: () => requestKubeResourceAccessFor(host) },
        { sep: true },
        { label: isWatched(host) ? 'Stop watching this cluster' : 'Watch this cluster', onClick: () => toggleWatch(host, view.groupKey) },
      ]);
      return;
    }
    const kubepanel = await import('./kubepanel.js');
    kubepanel.openKubeHostMenu(e, host, view.groupKey);
    return;
  }
  const { openHostMenu } = await import('./sidebar.js');
  openHostMenu(e, host, { folder, groupKey: view.groupKey });
}

/**
 * A kube cluster's own card — name, the same ☸ mark kubepanel.js's own
 * rows use, and a state tag (requestable/available — a logged-in one
 * needs neither, the same as an ordinary reachable SSH host needs no
 * tag of its own). Not sharing the SSH card below: that one's title,
 * tags and `.hp-meta` all read fields (`.addr`, `.tunnel`,
 * `isStale()`/heartbeat) a kube row either lacks or means nothing on,
 * and writing a kube-shaped row through it would read as a host that
 * merely forgot to fill in its own address rather than a different
 * kind of thing on purpose.
 */
function kubeCard(pane, view, host, folder, k) {
  const tags = labelEntries(host).slice(0, boxView() ? 3 : 5);
  const node = el('div', {
    class: 'hp-card' + (view.picked.has(k) ? ' picked' : ''),
    dataset: { key: k, host: host.id },
    title: host.name,
  },
    el('div', { class: 'hp-line' },
      el('span', { class: 'st' }),
      el('span', { class: 'hp-name', text: host.name }),
      lastKubepanel ? lastKubepanel.kubeIcon() : null,
      host.requestable
        ? el('span', { class: 'tag req', title: 'Not yours to open yet — double-click to start a request.', text: 'req' })
        : host.availableCluster
        ? el('span', { class: 'tag', title: 'Offered by this cluster, not logged in yet — double-click to log in', text: 'available' })
        : null,
      el('span', { style: 'flex:1' })),
    tags.length
      ? el('div', { class: 'hp-tags' }, ...tags.map(([tk, tv]) => el('span', { class: 'chip sm' },
          el('span', { class: 'k', text: tk }), el('span', { class: 'v', text: tv || '—' }))))
      : null);
  node.addEventListener('click', (e) => pick(pane, view, k, e));
  node.addEventListener('dblclick', () => openHostRow(host));
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); openHostRowMenu(e, pane, view, host, folder); });
  // Foldable the same way an SSH host is — the folder system (folders.js)
  // is already host-shaped generic, keyed by hostKey(), not SSH-specific.
  node.draggable = true;
  node.addEventListener('dragstart', (e) => {
    if (!view.picked.has(k)) { view.picked = new Set([k]); paintPicked(pane, view); }
    dragging = { paneId: pane.id, keys: [...view.picked] };
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', host.name); } catch { /* a drag without a payload still moves the row */ }
  });
  node.addEventListener('dragend', () => {
    dragging = null;
    for (const n of document.querySelectorAll('.hp-head.drop-in')) n.classList.remove('drop-in');
  });
  return node;
}

function card(pane, view, host, folder) {
  const k = hostKey(host);
  if (host.kind === 'kube') return kubeCard(pane, view, host, folder, k);
  const conn = [...state.connections.values()].find((c) => c.hostId === host.id && c.state === 'connected');
  const tags = labelEntries(host).slice(0, boxView() ? 3 : 5);
  const icon = state.settings.hostIcons?.[k] || '';

  const node = el('div', {
    class: 'hp-card' + (view.picked.has(k) ? ' picked' : '') + (conn ? ' live' : '')
      + (isStale(host) ? ' quiet' : '') + (host.missing ? ' missing' : ''),
    dataset: { key: k, host: host.id },
    title: [host.name || host.alias, host.addr || (host.tunnel ? 'tunnel' : ''), heartbeatLine(host)]
      .filter(Boolean).join('\n'),
  },
    el('div', { class: 'hp-line' },
      el('span', { class: 'st' + (conn ? ' connected' : '') }),
      showWatchMark() && isWatched(host) && !host.missing
        ? el('span', { class: 'hwatch', text: '\u{1F514}', title: 'Watched for disappearance' })
        : null,
      el('span', { class: 'hp-name', text: host.name || host.alias }),
      icon ? el('span', { class: 'hico', text: icon }) : null,
      // The same mark the host list carries: two rows with one name look
      // like a bug in the list until something says otherwise.
      host.ambiguous && host.uuid
        ? el('span', {
            class: 'hdupe', text: '\u{1F4CB}',
            title: `Duplicate named node — another node here answers to “${host.name}”.\n`
              + `This one is dialled by its id, ${host.uuid}.`,
          })
        : null,
      host.requestable
        ? el('span', {
            class: 'tag req',
            title: `Not yours to open yet \u2014 ${host.cluster || 'this cluster'} will let you ask for it.\n`
              + 'Double-click to start a request.',
            text: 'req',
          })
        : host.missing
        ? el('span', { class: 'tag gone', title: missingLine(host), text: '\u2298 gone ' + goneFor(host.missingSince) })
        : isStale(host)
        ? el('span', { class: 'tag stale', text: '⚠ ' + staleLabel(host) })
        : (heartbeatAge(host) !== null ? el('span', { class: 'tag hb', text: '♥ ' + ageLabel(host) }) : null),
      el('span', { style: 'flex:1' }),
      el('span', { class: 'hp-meta', text: host.addr || (host.tunnel ? 'tunnel' : (host.user || '')) })),
    tags.length
      ? el('div', { class: 'hp-tags' }, ...tags.map(([tk, tv]) => el('span', { class: 'chip sm' },
          el('span', { class: 'k', text: tk }), el('span', { class: 'v', text: tv || '—' }))))
      : null);

  node.addEventListener('click', (e) => pick(pane, view, k, e));
  node.addEventListener('dblclick', () => openHostRow(host));
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openHostRowMenu(e, pane, view, host, folder);
  });

  node.draggable = true;
  node.addEventListener('dragstart', (e) => {
    if (!view.picked.has(k)) { view.picked = new Set([k]); paintPicked(pane, view); }
    dragging = { paneId: pane.id, keys: [...view.picked] };
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', host.name || host.alias); } catch { /* a drag without a payload still moves the row */ }
  });
  node.addEventListener('dragend', () => {
    dragging = null;
    for (const n of document.querySelectorAll('.hp-head.drop-in')) n.classList.remove('drop-in');
  });

  // In a folder, the fastest way out of it is the one you already tried.
  if (folder) {
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' || e.key === 'Delete') unfileHost(host, folder.id);
    });
  }
  return node;
}

/**
 * The same hosts as a real table — Name / Status / Address / Labels, one
 * line each — for scanning a lot of them at once rather than reading a
 * wrapped card. Clicking a column header sorts by it, the same state the
 * toolbar's sort dropdown sets.
 */
/**
 * The same hosts as a real table — Name / Status / Address / Labels, one
 * line each — for scanning a lot of them at once rather than reading a
 * wrapped card. Clicking a column header sorts by it, the same state the
 * toolbar's sort dropdown sets.
 *
 * With "Label columns" on, `view.labelColumns` (set by content(), from
 * whichever hosts are actually about to be drawn) gets one column each,
 * ahead of the catch-all Labels column for whatever is left over.
 */
function table(pane, view, hosts, depth = 0, folder = null) {
  const wrap = el('div', { class: 'hp-table', style: depth ? `--depth:${depth}` : null });
  const cols = labelColumnsOn() ? (view.labelColumns || []) : [];
  const gridTemplate = 'minmax(140px, 1.6fr) 110px minmax(100px, 1fr)'
    + ' minmax(90px, 1fr)'.repeat(cols.length) + ' minmax(140px, 2fr)';
  // `pref` is what a click sets as the sort preference — null for a column
  // that is not sortable (Address, the leftover Labels column).
  const col = (label, pref) => {
    const active = !!pref && sortPref().mode === pref.mode
      && (pref.mode !== 'label' || sortPref().labelKey === pref.labelKey);
    return el('div', {
      class: 'hp-th' + (active ? ' active' : ''),
      text: label,
      onClick: pref ? (() => setPref({ hostsPaneSort: pref })) : null,
    });
  };
  wrap.append(el('div', { class: 'hp-tr head', style: `grid-template-columns:${gridTemplate}` },
    col('Name', { mode: 'name' }), col('Status', { mode: 'status' }), col('Address', null),
    ...cols.map((ck) => col(ck, { mode: 'label', labelKey: ck })),
    col('Labels', null)));
  for (const h of hosts) wrap.append(tableRow(pane, view, h, folder, cols, gridTemplate));
  return wrap;
}

/** Table view's own version of kubeCard() above — same reasoning, same fields it doesn't try to show. */
function kubeTableRow(pane, view, host, folder, k, gridTemplate) {
  const tags = labelEntries(host);
  const row = el('div', {
    class: 'hp-card hp-tr' + (view.picked.has(k) ? ' picked' : ''),
    dataset: { key: k, host: host.id },
    style: gridTemplate ? `grid-template-columns:${gridTemplate}` : null,
    title: host.name,
  },
    el('div', { class: 'hp-td name' },
      el('span', { class: 'st' }),
      el('span', { class: 'hp-name', text: host.name }),
      lastKubepanel ? lastKubepanel.kubeIcon() : null),
    el('div', { class: 'hp-td status' },
      host.requestable ? el('span', { class: 'tag req', text: 'req' })
        : host.availableCluster ? el('span', { class: 'tag', text: 'available' }) : null),
    el('div', { class: 'hp-td addr' }),
    el('div', { class: 'hp-td labels' },
      ...tags.map(([tk, tv]) => el('span', { class: 'chip sm' },
        el('span', { class: 'k', text: tk }), el('span', { class: 'v', text: tv || '—' })))));
  row.addEventListener('click', (e) => pick(pane, view, k, e));
  row.addEventListener('dblclick', () => openHostRow(host));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openHostRowMenu(e, pane, view, host, folder); });
  return row;
}

function tableRow(pane, view, host, folder, cols = [], gridTemplate = null) {
  const k = hostKey(host);
  if (host.kind === 'kube') return kubeTableRow(pane, view, host, folder, k, gridTemplate);
  const conn = [...state.connections.values()].find((c) => c.hostId === host.id && c.state === 'connected');
  const tags = labelEntries(host);
  // Whatever did not get its own column still shows, as before — pulling a
  // handful of common keys out does not mean the rest are gone.
  const leftover = cols.length ? tags.filter(([tk]) => !cols.includes(tk)) : tags;

  const row = el('div', {
    // hp-card as well as hp-tr: shift/⌘-click range selection (`pick`) and
    // the picked/live/stale/missing look are all keyed off `.hp-card`.
    class: 'hp-card hp-tr' + (view.picked.has(k) ? ' picked' : '') + (conn ? ' live' : '')
      + (isStale(host) ? ' quiet' : '') + (host.missing ? ' missing' : ''),
    dataset: { key: k, host: host.id },
    style: gridTemplate ? `grid-template-columns:${gridTemplate}` : null,
    title: [host.name || host.alias, host.addr || (host.tunnel ? 'tunnel' : ''), heartbeatLine(host)]
      .filter(Boolean).join('\n'),
  },
    el('div', { class: 'hp-td name' },
      el('span', { class: 'st' + (conn ? ' connected' : '') }),
      el('span', { class: 'hp-name', text: host.name || host.alias })),
    el('div', { class: 'hp-td status' },
      host.requestable
        ? el('span', { class: 'tag req', text: 'req' })
        : host.missing
        ? el('span', { class: 'tag gone', title: missingLine(host), text: '⊘ gone ' + goneFor(host.missingSince) })
        : isStale(host)
        ? el('span', { class: 'tag stale', text: '⚠ ' + staleLabel(host) })
        : (heartbeatAge(host) !== null ? el('span', { class: 'tag hb', text: '♥ ' + ageLabel(host) }) : null)),
    el('div', { class: 'hp-td addr', text: host.addr || (host.tunnel ? 'tunnel' : (host.user || '')) }),
    ...cols.map((ck) => {
      const found = tags.find(([tk]) => tk === ck);
      return el('div', { class: 'hp-td label-col', title: found ? `${ck}=${found[1] || ''}` : ck, text: found ? (found[1] || '—') : '—' });
    }),
    el('div', { class: 'hp-td labels' },
      ...leftover.map(([tk, tv]) => el('span', { class: 'chip sm' },
        el('span', { class: 'k', text: tk }), el('span', { class: 'v', text: tv || '—' })))));

  row.addEventListener('click', (e) => pick(pane, view, k, e));
  row.addEventListener('dblclick', () => openHostRow(host));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openHostRowMenu(e, pane, view, host, folder);
  });
  return row;
}

/**
 * A saved profile, drawn the same shape as a host card so the Saved group
 * fits into the same grid/picking/drag machinery — just with a profile's
 * own fields (no uuid, no cluster, no heartbeat) and its own menu.
 */
function profileCard(pane, view, p) {
  const k = 'profile:' + p.id;
  const conn = [...state.connections.values()].find((c) => c.profileId === p.id && c.state === 'connected');
  // Mirrors profileKindLabel in sidebar.js — kept local rather than
  // imported so this stays synchronous at render time.
  const kind = ({ sftp: 'sftp', teleport: 'tsh', serial: 'serial', telnet: 'telnet', vnc: 'vnc', rdp: 'rdp' })[p.type] || 'ssh';
  // Mirrors profileColor/profileIcon in sidebar.js, same reason as kind
  // above: colorCss is a plain util so it costs nothing to call here,
  // where importing sidebar.js itself at render time would.
  const colour = colorCss(p.color);
  const icon = p.icon || '';

  const node = el('div', {
    class: 'hp-card' + (view.picked.has(k) ? ' picked' : '') + (conn ? ' live' : '') + (colour ? ' coloured' : ''),
    dataset: { key: k },
    title: p.name,
    style: colour ? `--host-color:${colour}` : null,
  },
    el('div', { class: 'hp-line' },
      el('span', { class: 'st' + (conn ? ' connected' : '') }),
      el('span', { class: 'hp-name', text: p.name }),
      icon ? el('span', { class: 'hico', text: icon }) : null,
      el('span', { class: 'tag', text: kind }),
      el('span', { style: 'flex:1' }),
      el('span', { class: 'hp-meta', text: profileMeta(p) })));

  node.addEventListener('click', (e) => pick(pane, view, k, e));
  node.addEventListener('dblclick', async () => {
    const { launchProfile } = await import('./sidebar.js');
    await launchProfile(p);
  });
  node.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (!view.picked.has(k)) pick(pane, view, k, {});
    const { profileContextMenuItems } = await import('./sidebar.js');
    contextMenu(e.clientX, e.clientY, profileContextMenuItems(p));
  });
  return node;
}

function pick(pane, view, k, e) {
  const keys = [...pane.hostsHost.querySelectorAll('.hp-card')].map((n) => n.dataset.key);
  if (e.shiftKey && view.lastKey) {
    const a = keys.indexOf(view.lastKey);
    const b = keys.indexOf(k);
    if (a >= 0 && b >= 0) for (const key of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) view.picked.add(key);
  } else if (e.metaKey || e.ctrlKey) {
    view.picked.has(k) ? view.picked.delete(k) : view.picked.add(k);
  } else {
    view.picked = new Set([k]);
  }
  view.lastKey = k;
  paintPicked(pane, view);
}

function paintPicked(pane, view) {
  for (const n of pane.hostsHost.querySelectorAll('.hp-card')) {
    n.classList.toggle('picked', view.picked.has(n.dataset.key));
  }
}
