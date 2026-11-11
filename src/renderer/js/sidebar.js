import { serverIcon } from './hosticons.js';
import {
  clusterIcon, clusterColor, clusterMarkMenu,
} from './clustermarks.js';
import { decodeMenu } from './nettools.js';
import { state, tpKey } from './state.js';
import { $, $$, el, clear, debounce, HOST_COLORS, colorCss } from './util.js';
import { toast, status, contextMenu, modal, prompt, confirm, field, textInput, select } from './ui.js';
import { openHost, splitActivePane, registerSidebarHelpers } from './sessions.js';
import { sshOptionsMenu } from './sshoptions.js';
import { openProfileEditor } from './profiles.js';
import { hostStyleMenu } from './panestyle.js';
import { openPortForwardDialog, openServerInfo, openRunCommandDialog } from './hostactions.js';
import { openAddServerDialog, removeManagedHost, removeSshConfigHost, openSshConfigInEditor } from './addserver.js';
import {
  renderTeleportTab, leafClusterTag, clusterSwitchMenuItem,
  openTshConfigDialog, openClusterStatus, openRequestsDialog,
  expiringSoon, formatUntil, openLoginDialog, doRelogin,
} from './teleportpanel.js';
import { isPinned, pinnedIconFor, pinnedScopeFor, scopeLabel, runScopeOf, runScopeLabel } from './macros.js';
import {
  refreshBeams, beamsFor, beamsSupported, markedAsBeams, beamNodeNames,
  addBeam, beamMenu, openBeam, expiresIn, setMarkedAsBeams, hideBeamsFor, showBeamsFor,
  phasesSupported, phaseListFor, beamTabFor, setBeamTab, refreshPhases, phaseMenu, newPhase,
  failedListFor, refreshFailedPhases, failedMenu,
} from './beams.js';
import { labelEntries, compileQuery, toggleTerm, hasTerm, termFor, collectTags } from './tags.js';
import { openTagBrowser, openHostTagsDialog } from './tagbrowser.js';
import { loadMacros, macroCategories } from './macros.js';
import { startNodeLoop } from './nodewatch.js';
import {
  kubeGroupRows, kubeGroupCount, kubeHostsForProfile,
  kubeContextRow, availableClusterRow, kubeIcon, openKubeHostMenu, refreshKubeFor,
} from './kubepanel.js';
import { isNarrowed, noteRead, heldBackFor, lastFullReadFor } from './narrowed.js';
import {
  isStale, staleLabel, ageLabel, heartbeatLine, heartbeatAge,
  observe, showHeartbeats, quietFilter,
} from './heartbeat.js';
import {
  foldersIn, folderPath, allFolders, hostsInFolder, hostsInTree,
  foldersForHost, isFiled, showFiledHosts, setShowFiledHosts,
  folderIcon, folderColor,
  unfileHost, deleteFolder, reparentFolder, groupHasFolders, fileHostsInto,
  openFolderDialog, exportFoldersDialog, importFoldersDialog,
  isManualMember, repairFolderGroups, groupKeyFor, hostKey,
} from './folders.js';
import {
  isWatched, toggleWatch, missingIn, requestableIn, orphanGhosts, unconfirmedIn, unconfirmedLine,
  requestUncheckedLine, missingLine, goneFor, noteSeen, announcement,
  showWatchMark, forget as forgetWatched,
} from './watch.js';
import { savedOnlyProfiles } from './pinned.js';
import {
  startRequestLoop, refreshRequests, requestBadge, clusterRequestTag,
  liveCount, requestSummary, allLiveRequests,
} from './requestwatch.js';

let activeSbTab = 'hosts';
let savedView = 'profiles';
// All/SSH/K8s — which kind of resource the Resources (Hosts) tab shows.
// Only reachable, and only shown, while KubeLife is enabled.
let hostKindFilter = 'all';
let filterText = '';
/*
 * The filter as something that can be asked of a host. Compiled once per
 * change rather than per host: the box now understands `and`, `or`, `not`
 * and brackets, which is a parse rather than a split.
 */
let filterMatch = compileQuery('');
/*
 * Closed group headings and closed folders, kept in settings so a restart
 * opens the sidebar the way it was left rather than spreading every cluster
 * out again. Folder ids are stable; group keys are the cluster or file key.
 */
function closedSet(key) { return new Set(state.settings?.[key] || []); }
function toggleClosed(key, id) {
  const set = closedSet(key);
  set.has(id) ? set.delete(id) : set.add(id);
  const patch = { [key]: [...set] };
  state.settings = { ...state.settings, ...patch };
  renderSidebar();
  window.api.settings.set(patch).catch(() => {});
}
const collapsed = { has: (k) => closedSet('sidebarClosedGroups').has(k) };

// Lets a pane resolve its host without sessions.js importing this module
// back, which would be a cycle.
registerSidebarHelpers({ hostById, hostPrefKey, opensWithFiles });

/*
 * The shells on this machine, read once.
 *
 * The local shell's menu lists them, and asking the main process while the
 * menu is being built delayed the menu itself — a right-click that does
 * nothing for a moment reads as a right-click that missed.
 */
let shellCache = [];
window.api.localTerm.shells().then((v) => { shellCache = v || []; }).catch(() => {});

export function initSidebar() {
  /*
   * The tab strip's own menu.
   *
   * Access requests belong to no single host, so they had no home in the host
   * list — they lived behind a button on the Teleport tab, which is not where
   * anyone is looking while they wait for an approval. The tabs are always on
   * screen, so this is where the list hangs.
   */
  $$('.sb-tab').forEach((btn) => {
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openRequestsMenu(e.clientX, e.clientY);
    });
  });
  $('#sb-tabs')?.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.sb-tab')) return;
    e.preventDefault();
    openRequestsMenu(e.clientX, e.clientY);
  });

  state.on('requests', () => renderSidebar());

  $$('.sb-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeSbTab = btn.dataset.tab;
      $$('.sb-tab').forEach((b) => b.classList.toggle('active', b === btn));
      $('#sb-panel-hosts').classList.toggle('hidden', activeSbTab !== 'hosts');
      $('#sb-panel-saved').classList.toggle('hidden', activeSbTab !== 'saved');
      $('#sb-panel-teleport').classList.toggle('hidden', activeSbTab !== 'teleport');
      $('#sb-subtabs').classList.toggle('hidden', activeSbTab !== 'saved');
      // Tags, heartbeats, quiet nodes, folders, the ticked hosts and the
      // match count are all about host rows; the filter box itself is shared.
      $('.sb-search-row').classList.toggle('hidden', activeSbTab !== 'hosts');
      updateKubeFilterVisibility();
      renderSidebar();
    });
  });

  $$('.sb-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      savedView = btn.dataset.saved;
      $$('.sb-subtab').forEach((b) => b.classList.toggle('active', b === btn));
      renderSidebar();
    });
  });

  $$('.sb-kind-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      hostKindFilter = btn.dataset.kind;
      $$('.sb-kind-tab').forEach((b) => b.classList.toggle('active', b === btn));
      renderSidebar();
    });
  });

  state.on('kubeContexts', () => { if (activeSbTab === 'hosts') renderSidebar(); });

  applyKubeEnabledSetting();

  $('#host-filter').addEventListener('input', debounce((e) => {
    setFilter(e.target.value, { fromInput: true });
  }, 120));

  $('#btn-refresh').addEventListener('click', () => refreshInventory(true));
  $('#btn-add-server').addEventListener('click', () => openAddServerDialog());
  // A new cluster is not a server — `openAddServerDialog` has nowhere to put
  // a proxy address. This is the same dialog the empty Teleport tab already
  // offers, reached here so logging in to one more cluster does not require
  // finding that tab first.
  $('#btn-connect-cluster').addEventListener('click', () => openLoginDialog());
  $('#btn-tags').addEventListener('click', () => openTagBrowser({
    getFilter: () => filterText,
    setFilter: (term) => (term === null ? setFilter('') : setFilter(toggleTerm(filterText, term))),
  }));
  $('#btn-show-tags').addEventListener('click', () => toggleShowTags());
  $('#btn-heartbeats').addEventListener('click', () => toggleShowHeartbeats());
  $('#btn-quiet').addEventListener('click', () => setQuietFilter());
  $('#btn-folders').addEventListener('click', () => openFolderBrowser());
  $('#btn-clear-selection').addEventListener('click', () => {
    state.checkedHosts.clear();
    state.emit('checked');
    updateStatusBar();
  });

  // Requests are watched in the background: an approval that arrived twenty
  // minutes ago is no use if nothing says so.
  startRequestLoop();
  // And so are the node lists, so a host that came up while you were looking
  // at the list is there to click.
  startNodeLoop();

  state.on('connections', () => renderSidebar());
  state.on('inventory', () => renderSidebar());
  // Folders are settings, not inventory, and change without either moving.
  state.on('folders', () => renderSidebar());
  /*
   * A hosts pane is a second view of the same inventory, so it follows the
   * same three events the sidebar does — otherwise filing something in the
   * sidebar would leave the pane beside it showing yesterday's arrangement.
   */
  for (const ev of ['inventory', 'folders', 'connections']) {
    state.on(ev, () => import('./hostspane.js').then((m) => m.refreshHostsPanes()).catch(() => {}));
  }
  state.on('profiles', () => renderSidebar());
  state.on('beams', () => renderSidebar());
}

/**
 * Access requests, from the tab strip.
 *
 * What is outstanding, then the two things anyone does about it: open the list
 * for that cluster, or raise a new one.
 */
function openRequestsMenu(x, y) {
  const live = allLiveRequests();
  const { pending, approved } = requestSummary(live);
  const profiles = (state.teleportProfiles || []).filter((p) => !p.expired);

  const items = [
    { heading: true, label: live.length ? `Access requests — ${pending} waiting, ${approved} approved` : 'Access requests' },
  ];

  if (!profiles.length) {
    items.push({ label: 'No cluster is logged in', disabled: true });
  } else {
    for (const p of profiles) {
      const mine = (state.accessRequests?.get(tpKey(p)) || []);
      items.push({
        label: p.cluster || p.proxy,
        key: mine.length
          ? mine.some((r) => ['APPROVED', 'PROMOTED'].includes(r.state)) ? 'approved' : `${mine.length} waiting`
          : '',
        title: mine.length
          ? mine.map((r) => `${r.state.toLowerCase()}: ${r.roles.join(', ') || (r.resources || []).length + ' resources'}`).join('\n')
          : 'No requests outstanding on this cluster',
        onClick: async () => (await import('./teleportpanel.js')).openRequestsDialog(p),
      });
    }
    items.push({ sep: true });
    items.push({
      label: 'New request…',
      onClick: async () => {
        const { openRequestsDialog } = await import('./teleportpanel.js');
        openRequestsDialog(profiles.find((x) => x.active) || profiles[0]);
      },
    });
    items.push({
      label: 'Check again now',
      onClick: () => refreshRequests().then(() => status(
        liveCount() ? `${liveCount()} request(s) outstanding` : 'Nothing outstanding')),
    });
  }

  contextMenu(x, y, items);
}

/* ------------------------------------------------------------------ */
/* Inventory loading                                                   */
/* ------------------------------------------------------------------ */

export async function refreshInventory(notify) {
  state.loadingInventory = true;
  refreshKubeFor();
  renderSidebar();
  updateTshBadge('Loading…', '');

  const [sshRes, tpRes, toolRes, savedRes] = await Promise.allSettled([
    window.api.discovery.sshHosts(),
    window.api.teleport.status(),
    window.api.app.tools(),
    window.api.teleport.savedLogins(),
  ]);
  if (toolRes.status === 'fulfilled') state.toolInfo = toolRes.value;
  if (savedRes.status === 'fulfilled') state.savedLogins = savedRes.value || [];

  state.sshHosts = sshRes.status === 'fulfilled' ? sshRes.value : [];
  // Which files those hosts came from, so a configured-but-empty or missing
  // file still gets a heading rather than vanishing.
  try { state.sshConfigFiles = await window.api.discovery.sshConfigFiles(); }
  catch { state.sshConfigFiles = []; }
  if (tpRes.status === 'fulfilled') {
    state.tshInfo = tpRes.value.tsh || null;
    state.teleportProfiles = tpRes.value.profiles || [];
    state.teleportError = tpRes.value.loggedIn ? null : (tpRes.value.error || 'Not logged in to Teleport');
  } else {
    state.teleportProfiles = [];
    state.teleportError = tpRes.reason?.message || 'tsh unavailable';
  }

  // Load nodes for every profile whose certificate is still valid, and the
  // trusted clusters behind it — a leaf is not a profile, so nothing else in
  // this sweep would ever mention one.
  state.teleportNodes.clear();
  state.teleportClusters.clear();
  const live = state.teleportProfiles.filter((p) => !p.expired);
  await Promise.all(live.map(async (p) => {
    const key = tpKey(p);
    const opts = { proxy: p.proxy, cluster: p.cluster, home: p.homeDir };
    await Promise.all([
      (async () => {
        try {
          const r = await window.api.teleport.nodes(opts);
          state.teleportNodes.set(key, r.ok ? r.nodes : []);
          // Only a list that actually came back counts as having looked:
          // the heartbeat ages are read against the moment of the read.
          if (r.ok) {
            observe(key, r.nodes);
            noteRead(p, r.nodes);
            announceWatch(await noteSeen(groupKeyFor(p), r.nodes, { partial: isNarrowed(p) }));
          }
        } catch { state.teleportNodes.set(key, []); }
      })(),
      // Best effort: an old tsh, or a proxy that will not answer, simply means
      // no leaf badge rather than a broken inventory.
      (async () => {
        try {
          const r = await window.api.teleport.clusters({ proxy: p.proxy, home: p.homeDir });
          state.teleportClusters.set(key, r.ok ? r.clusters : []);
        } catch { state.teleportClusters.set(key, []); }
      })(),
    ]);
  }));
  // Folders made from a group heading before 0.6.2 went in under the proxy
  // address and were drawn nowhere; move them to the group they meant.
  const movedFolders = await repairFolderGroups(folderGroups());
  if (movedFolders) status(`${movedFolders} folder${movedFolders === 1 ? '' : 's'} restored to this list`);

  try {
    const { profiles, folders } = await window.api.profiles.list();
    state.profiles = profiles;
    state.folders = folders;
  } catch { /* the last known list stays */ }

  try { state.managedSshHosts = await window.api.discovery.managedSshHosts(); }
  catch { state.managedSshHosts = []; }

  // Beams come after the profiles, since which clusters to ask is decided by
  // them. Failures are per cluster and never block the inventory.
  try { await refreshBeams(); } catch { /* beams stay as they were */ }

  /*
   * Access requests, for the same reason and with the same timing problem:
   * the background loop starts with the window, which is before any profile
   * has been read, so its first pass found nothing and the badge stayed empty
   * for the next ninety seconds. Asking here is what makes it appear at once.
   */
  try { await refreshRequests(); } catch { /* requests stay as they were */ }

  try { await loadMacros(); } catch { /* macros stay as they were */ }
  try { await (await import('./s3.js')).loadS3Targets(); } catch { /* S3 targets stay as they were */ }

  state.loadingInventory = false;
  state.emit('inventory');
  renderSidebar();

  const nodeCount = [...state.teleportNodes.values()].reduce((a, b) => a + b.length, 0);
  if (state.teleportProfiles.length) {
    const expired = state.teleportProfiles.filter((p) => p.expired).length;
    updateTshBadge(
      `${nodeCount} nodes · ${live.length} profile${live.length === 1 ? '' : 's'}${expired ? ` · ${expired} expired` : ''}`,
      expired && !live.length ? 'err' : expired ? 'warn' : 'ok');
  } else if (tshMissing()) {
    // Telling someone to log in when the binary was never found sends them
    // round in circles; say which of the two it is.
    updateTshBadge('tsh not found', 'err');
  } else {
    updateTshBadge('tsh: not logged in', 'warn');
  }
  if (notify) status(`${nodeCount} Teleport nodes · ${state.sshHosts.length} SSH hosts`);
}

/** Is the trouble that tsh itself is not there? */
function tshMissing() {
  const info = state.toolInfo?.tsh || state.tshInfo;
  if (info) return info.found === false;
  return state.appInfo.tshFound === false;
}

/**
 * Windows without the OpenSSH client: Teleport still works over `tsh ssh`, but
 * plain SSH hosts cannot be reached, so the state belongs on screen rather than
 * in a failed connection.
 */
export function sshMissing() {
  const info = state.toolInfo?.ssh || state.appInfo?.ssh;
  return info ? info.found === false : false;
}

function updateTshBadge(text, kind) {
  const b = $('#tsh-badge');
  b.textContent = text;
  b.className = 'badge ' + (kind || '');
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * The outstanding-request badge on the Teleport tab.
 *
 * On the tab rather than inside the panel, because the point is to be seen
 * while you are doing something else — which is the whole of waiting for an
 * approval.
 */
function renderRequestBadge() {
  const tab = $('.sb-tab[data-tab="teleport"]');
  if (!tab) return;
  tab.querySelector('.req-badge')?.remove();
  const badge = requestBadge();
  if (badge) tab.append(badge);
  tab.title = liveCount()
    ? `${liveCount()} access request(s) outstanding — right-click for the list`
    : 'Clusters, requests and recordings — right-click for access requests';
}

export function renderSidebar() {
  if (activeSbTab === 'hosts') renderHostsTab();
  else if (activeSbTab === 'saved') renderSavedTab();
  else renderTeleportTab($('#sb-panel-teleport'));
  renderRequestBadge();
  updateFilterUi();
  updateStatusBar();
}

/** Which kind of resource the Resources tab is currently filtered to. */
export function hostKindShown() {
  return state.settings.kubeEnabled === false ? 'ssh' : hostKindFilter;
}

/**
 * The All/SSH/K8s filter row only makes sense on the Resources tab, and only
 * while KubeLife is on — otherwise there is nothing for "K8s" or "All" to
 * mean, and it should not be on screen taking up a line for one option.
 */
function updateKubeFilterVisibility() {
  const show = activeSbTab === 'hosts' && state.settings.kubeEnabled !== false;
  $('#sb-kind-filter')?.classList.toggle('hidden', !show);
}

/**
 * The one place that reads settings.kubeEnabled to decide whether Kubernetes
 * shows up in the Resources tab at all. Called at startup and again whenever
 * Settings is saved (index.js) or the setting is changed over MCP
 * (automation.js), mirroring how apply3dSetting() is wired for the file
 * browser's 3D button — a capability that is off must leave no control
 * behind that still does something.
 */
export function applyKubeEnabledSetting() {
  const on = state.settings.kubeEnabled !== false;
  // Switched off while filtered to K8s: there is nothing left to show it, so
  // fall back to the full list rather than an empty one with no visible cause.
  if (!on && hostKindFilter === 'kube') {
    hostKindFilter = 'all';
    document.querySelector('.sb-kind-tab[data-kind="all"]')?.classList.add('active');
    document.querySelector('.sb-kind-tab[data-kind="kube"]')?.classList.remove('active');
  }
  updateKubeFilterVisibility();
  renderSidebar();
}

/**
 * Keep the filter controls telling the truth: how many hosts survived the
 * query, whether tags are being shown, and what the cluster's label vocabulary
 * is, so the box can autocomplete `key=value` instead of being a guessing game.
 */
function updateFilterUi() {
  const btn = $('#btn-show-tags');
  if (btn) {
    btn.classList.toggle('active', showTags());
    btn.title = showTags() ? 'Hide tags on host rows' : 'Show every tag on each host row';
  }

  const hb = $('#btn-heartbeats');
  if (hb) {
    hb.classList.toggle('active', showHeartbeats());
    hb.title = showHeartbeats()
      ? 'Stop showing when each node last checked in'
      : 'Show how long ago each Teleport node last checked in';
  }

  /*
   * The quiet-node control: one button cycling all → hidden → only → all.
   *
   * It names the state it is in rather than the click it would perform,
   * because the list in front of you being short is the thing that needs
   * explaining. It is only worth screen space when something is actually
   * quiet — or when a filter is on, since then the list is short for a
   * reason and must offer the way back.
   */
  const quiet = $('#btn-quiet');
  if (quiet) {
    const mode = quietFilter();
    const n = quietCount();
    quiet.classList.toggle('hidden', !n && mode === 'all');
    quiet.classList.toggle('active', mode !== 'all');
    quiet.textContent = { all: `Quiet: ${n}`, hide: `Quiet hidden (${n})`, only: `Only quiet (${n})` }[mode];
    const gone = goneCount();
    const breakdown = gone
      ? `${n - gone} quiet, ${gone} no longer in the inventory`
      : `${n} node${n === 1 ? ' has' : 's have'} gone quiet`;
    quiet.title = {
      all: `${breakdown} — click to hide them`,
      hide: `${breakdown}, hidden — click to see only them`,
      only: 'Showing only these — click for the whole list',
    }[mode];
  }

  /*
   * Only worth screen space once something is actually ticked — a bulk
   * action (multi-exec, request access to several) needs a quick way back
   * to nothing selected that is not "go find every ticked row again".
   */
  const clearSel = $('#btn-clear-selection');
  if (clearSel) {
    const n = state.checkedHosts.size;
    clearSel.classList.toggle('hidden', !n);
    clearSel.textContent = `Clear selection (${n})`;
    clearSel.title = `${n} host${n === 1 ? '' : 's'} ticked for multi-exec — click to untick all of them`;
  }

  const count = $('#filter-count');
  if (count) {
    const nodes = [...state.teleportNodes.values()].flat();
    const all = [...nodes, ...state.sshHosts];
    const shown = all.filter(hostMatches).length;
    count.textContent = filterText ? `${shown} of ${all.length}` : '';
    count.className = 'badge' + (filterText && !shown ? ' warn' : '');
  }

  const list = $('#host-tag-list');
  if (list && list.dataset.for !== tagListKey()) {
    clear(list);
    for (const [key, values] of collectTags([...state.teleportNodes.values()].flat())) {
      for (const v of values.keys()) list.append(el('option', { value: termFor(key, v) }));
    }
    list.dataset.for = tagListKey();
  }
}

/** Cheap signature for "the inventory changed", to avoid rebuilding the datalist. */
function tagListKey() {
  return [...state.teleportNodes.entries()].map(([k, n]) => `${k}:${n.length}`).join('|');
}

function matches(text) {
  return !filterText || String(text).toLowerCase().includes(filterText.toLowerCase());
}

/**
 * Set the host filter from anywhere — the box itself, a tag chip, the tag
 * browser — keeping the input, the parsed query and the list in step.
 */
export function setFilter(text, { fromInput = false } = {}) {
  filterText = String(text ?? '').trim();
  filterMatch = compileQuery(filterText);
  const input = $('#host-filter');
  if (input && !fromInput) input.value = filterText;
  renderSidebar();
}

export function filterByTag(key, value) {
  setFilter(toggleTerm(filterText, termFor(key, value)));
}

function openHostTags(host) {
  return openHostTagsDialog(host, {
    getFilter: () => filterText,
    setFilter: (term) => setFilter(toggleTerm(filterText, term)),
  });
}

/** Whether every host row lists its labels, rather than just a summary tag. */
function showTags() { return !!state.settings.showHostTags; }

export async function toggleShowTags() {
  state.settings = await window.api.settings.set({ showHostTags: !state.settings.showHostTags });
  renderSidebar();
}

/**
 * Put the heartbeat ages on the rows, or take them off again.
 *
 * Off by default because on a healthy cluster it is the same answer on every
 * row; on when you are watching something come back, or wondering whether the
 * list is telling you the truth.
 */
export async function toggleShowHeartbeats() {
  state.settings = await window.api.settings.set({ showHeartbeats: !state.settings.showHeartbeats });
  renderSidebar();
}

/**
 * Quiet, in the sense the button means it: a node that has stopped
 * heartbeating, or a watched one that has left the inventory altogether.
 * The same question asked at two distances — "is this machine still there?"
 * — and splitting them across two controls would make the second easy to
 * miss, which is the failing this was meant to fix.
 */
function isQuiet(h) {
  return !!h?.missing || !!h?.unconfirmed || isStale(h);
}

/** How many nodes are quiet or gone, out of those the filter box lets through. */
function quietCount() {
  const nodes = [...state.teleportNodes.values()].flat();
  return [...nodes, ...allGhosts()].filter((h) => isQuiet(h) && hostMatches(h)).length;
}

/** How many of those are gone rather than merely quiet, for the tooltip. */
function goneCount() {
  return allGhosts().filter(hostMatches).length;
}

/**
 * Every watched host that is missing — in the groups on screen, and the ones
 * whose group is not listed at all. The second half matters for the count as
 * much as for the rows: "three gone" that quietly becomes "two gone" because
 * a cluster expired is a worse answer than either number.
 */
function allGhosts() {
  const groups = folderGroups();
  return [
    ...groups.flatMap((g) => missingIn(g.key, hostsInGroup(g.key))),
    ...orphanGhosts(groups.map((g) => g.key)),
  ];
}

/**
 * Move the quiet-node filter on, or set it outright.
 *
 * Whichever way it is set, hiding them is not the same as ignoring them: the
 * button keeps their count, because a cluster that is quietly three nodes
 * short is the thing worth knowing.
 */
export async function setQuietFilter(mode) {
  const next = mode || ({ all: 'hide', hide: 'only', only: 'all' })[quietFilter()];
  state.settings = await window.api.settings.set({ quietNodeFilter: next });
  renderSidebar();
}

/* ------------------------------------------------------------------ */
/* Hosts known to need per-session MFA                                 */
/* ------------------------------------------------------------------ */

export function isMfaHost(id) {
  return (state.settings.mfaHosts || []).includes(id);
}

/**
 * Remember (or forget) that a host needs per-session MFA, so the next
 * connection goes straight to tsh instead of failing on the shared path first.
 */
export async function setMfaHost(host, remember) {
  const cur = new Set(state.settings.mfaHosts || []);
  remember ? cur.add(host.id) : cur.delete(host.id);
  state.settings = await window.api.settings.set({ mfaHosts: [...cur] });
  renderSidebar();
  status(remember
    ? `${host.name || host.alias} remembered as an MFA server`
    : `${host.name || host.alias} no longer marked as MFA`);
}

/** Hidden hosts stay out of the list unless the user asks to see them. */
function isHidden(h) { return state.hiddenHosts?.has(h.id); }

/* ------------------------------------------------------------------ */
/* SSH config files                                                    */
/* ------------------------------------------------------------------ */

/**
 * The config files to draw a group for. Falls back to the primary file alone,
 * so the list is never empty before the first answer arrives.
 */
function configRoots() {
  const files = state.sshConfigFiles;
  if (Array.isArray(files) && files.length) return files;
  return [{ file: '', label: '~/.ssh/config', primary: true, exists: true }];
}

/**
 * Add and remove the extra config files.
 *
 * `Include` already exists in OpenSSH, and is the right answer when you are
 * willing to edit `~/.ssh/config`. This is for the files you are not: one a
 * cloud tool rewrites, one that lives in a repository, one belonging to a
 * client. Each is read on its own terms.
 */
export async function openSshConfigDialog() {
  const rows = el('div', { class: 'picker-list' });

  const draw = () => {
    clear(rows);
    for (const r of configRoots()) {
      const count = (state.sshHosts || []).filter((h) => (h.configRoot || '') === r.file
        || (r.primary && !h.configRoot)).length;
      rows.append(el('div', { class: 'picker-item' },
        el('div', { style: 'flex:1;min-width:0' },
          el('div', { class: 'pname', text: r.label }),
          el('div', { class: 'sub', style: 'font-family:var(--mono);font-size:11px;opacity:.7', text: r.file }),
          el('div', { class: 'sub', style: 'font-size:11px;opacity:.75',
            text: r.exists === false ? 'not there' : `${count} host${count === 1 ? '' : 's'}` })),
        r.primary
          ? el('span', { class: 'tag', title: 'Always read; this is what plain ssh reads too', text: 'primary' })
          : el('button', {
              class: 'ghost-btn sm danger-btn', text: 'Remove',
              title: 'Stop reading this file. The file itself is not touched.',
              onClick: async () => {
                const keep = (state.settings.sshConfigFiles || []).filter((f) => f !== r.file);
                state.settings = await window.api.settings.set({ sshConfigFiles: keep });
                await refreshSshConfigs();
                draw();
              },
            })));
    }
  };

  return modal({
    title: 'SSH config files',
    subtitle: 'Extra files to read hosts from',
    render: (body) => {
      draw();
      body.append(
        rows,
        el('div', { class: 'hint', style: 'margin-top:9px' },
          'Hosts from an extra file are opened with ', el('code', { text: 'ssh -F <file>' }),
          ' — that file\u2019s options and defaults are what apply, and ~/.ssh/config is not read for them.'),
        el('div', { style: 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap' },
          el('button', {
            class: 'primary-btn sm', text: 'Add a file…',
            onClick: async () => {
              const picked = await window.api.discovery.pickSshConfigFile();
              if (!picked) return;
              const have = state.settings.sshConfigFiles || [];
              if (have.includes(picked)) return toast('That file is already listed', 'error');
              state.settings = await window.api.settings.set({ sshConfigFiles: [...have, picked] });
              await refreshSshConfigs();
              draw();
            },
          }),
          el('button', {
            class: 'ghost-btn sm', text: 'Refresh',
            onClick: async () => { await refreshSshConfigs(); draw(); },
          })));
    },
    buttons: [{ label: 'Close', value: null }],
  });
}

/* ------------------------------------------------------------------ */
/* Per-host preferences                                                */
/* ------------------------------------------------------------------ */

/**
 * The key a per-host preference is stored under.
 *
 * A Teleport node is keyed by its **uuid**, not its name: the hostname in the
 * inventory is a label that changes when a machine is renamed or rebuilt, and
 * a preference that evaporates on a rename is worse than none. The main
 * process has the same function (store.js) — the UI has to read the key the
 * connection will read, or the toggle would show one thing and do another.
 */
export function hostPrefKey(host) {
  if (!host) return '';
  if (host.uuid) return 'uuid:' + host.uuid;
  if (host.type === 'teleport' && host.name) return `tsh:${host.cluster || ''}:${host.name}`;
  return host.id || (host.alias ? 'ssh:' + host.alias : '');
}

/** The key a per-cluster preference is stored under: a proxy, or plain SSH. */
export function clusterPrefKey(host) {
  if (!host) return '';
  if (host.type === 'teleport' || host.type === 'beam') return host.proxy || host.cluster || '';
  return 'ssh';
}

/** The username set deliberately for this host, if any. */
function preferredUser(host) {
  return (state.settings.hostUsers || {})[hostPrefKey(host)] || '';
}

/**
 * Pin the account this host is always opened as.
 *
 * Distinct from the login that happens to have worked: that is a memory, and
 * the next successful connection overwrites it. This is a decision, so it wins
 * over the memory and is only changed by saying so here.
 */
async function setPreferredUser(host) {
  const options = loginOptionsFor(host);
  const current = preferredUser(host);
  const input = textInput({
    value: current,
    placeholder: options[0] || 'ubuntu',
    list: 'host-login-options',
  });
  const opts = el('datalist', { id: 'host-login-options' },
    ...options.map((o) => el('option', { value: o })));
  const note = el('div', { class: 'hint', style: 'margin-top:8px' });
  const syncNote = () => {
    const v = input.value.trim();
    note.textContent = !v
      ? `Nothing set: sessions use the last login that worked, or ${options[0] || 'the cluster default'}.`
      : (options.length && !options.includes(v)
        ? `${v} is not one of the logins this cluster grants (${options.join(', ')}). It will still be used — `
          + 'the cluster decides whether it is allowed.'
        : `Every session on this host will connect as ${v}.`);
  };
  input.addEventListener('input', syncNote);

  const res = await modal({
    title: 'Preferred username',
    subtitle: host.name || host.alias,
    render: (body) => {
      body.append(
        field('Connect as', input),
        opts,
        note,
        el('div', { class: 'hint', style: 'margin-top:9px' },
          host.type === 'teleport'
            ? `Stored against this node's uuid (${(host.uuid || '').slice(0, 8)}…), so renaming the host keeps it.`
            : 'Stored against this ssh_config entry.'));
      syncNote();
    },
    buttons: [
      { label: 'Cancel', value: null },
      current ? { label: 'Clear', class: 'ghost-btn danger-btn', value: '' } : null,
      { label: 'Save', class: 'primary-btn', onClick: ({ close }) => close(input.value.trim() || '') },
    ].filter(Boolean),
  });
  if (res === null || res === undefined) return;

  const map = { ...(state.settings.hostUsers || {}) };
  const key = hostPrefKey(host);
  if (res) map[key] = res; else delete map[key];
  state.settings = await window.api.settings.set({ hostUsers: map });
  renderSidebar();
  status(res ? `${host.name || host.alias} will connect as ${res}` : 'Preferred username cleared');
}

/** The command set to run the moment a session on this host opens, if any. */
function hostStartupCommand(host) {
  return (state.settings.hostStartupCommand || {})[hostPrefKey(host)] || '';
}

/**
 * Set a command to run the moment a terminal on this host comes up — the
 * same "sent to the session once it is open" a saved profile already has,
 * for a host nobody has saved a profile for. Stored the same way as the
 * preferred username, against the host's own key, so it survives a rename
 * and applies however the host is opened: a double-click, a split, tmux.
 */
async function setHostStartupCommand(host) {
  const current = hostStartupCommand(host);
  const input = el('textarea', {
    style: 'width:100%;height:64px;font-family:var(--mono);font-size:11.5px',
    placeholder: 'tmux attach || tmux new\ncd /var/log',
    spellcheck: 'false',
  });
  input.value = current;

  const res = await modal({
    title: 'Startup command',
    subtitle: host.name || host.alias,
    render: (body) => {
      body.append(
        field('Run on open', input, 'Sent to the session the moment it connects'),
        el('div', { class: 'hint', style: 'margin-top:9px' },
          host.type === 'teleport'
            ? `Stored against this node's uuid (${(host.uuid || '').slice(0, 8)}…), so renaming the host keeps it.`
            : 'Stored against this ssh_config entry.'));
    },
    buttons: [
      { label: 'Cancel', value: null },
      current ? { label: 'Clear', class: 'ghost-btn danger-btn', value: '' } : null,
      { label: 'Save', class: 'primary-btn', onClick: ({ close }) => close(input.value) },
    ].filter(Boolean),
  });
  if (res === null || res === undefined) return;

  const map = { ...(state.settings.hostStartupCommand || {}) };
  const key = hostPrefKey(host);
  if (res.trim()) map[key] = res; else delete map[key];
  state.settings = await window.api.settings.set({ hostStartupCommand: map });
  status(res.trim() ? `Startup command set for ${host.name || host.alias}` : 'Startup command cleared');
}

/* ---------------- agent forwarding ---------------- */

/** What this host will actually do: the host's own setting, else the cluster's, else the default. */
function agentForwardState(host) {
  const s = state.settings;
  const hk = hostPrefKey(host);
  const perHost = s.agentForwardHosts || {};
  if (hk && hk in perHost) return { on: !!perHost[hk], from: 'host' };
  const ck = clusterPrefKey(host);
  const perCluster = s.agentForwardClusters || {};
  if (ck && ck in perCluster) return { on: !!perCluster[ck], from: 'cluster' };
  return { on: !!s.agentForward, from: 'default' };
}

/**
 * Set or clear the host-level opinion. Three states, not two: on, off, and
 * "whatever the cluster says" — without the third, setting one host would
 * silently freeze it against a later change of mind about the cluster.
 */
async function setAgentForwardForHost(host, value) {
  const map = { ...(state.settings.agentForwardHosts || {}) };
  const key = hostPrefKey(host);
  if (value === null) delete map[key]; else map[key] = !!value;
  state.settings = await window.api.settings.set({ agentForwardHosts: map });
  renderSidebar();
  const st = agentForwardState(host);
  status(value === null
    ? `${host.name || host.alias}: agent forwarding follows the ${st.from} setting (${st.on ? 'on' : 'off'})`
    : `${host.name || host.alias}: agent forwarding ${value ? 'on' : 'off'}`);
}

/** The same, for every host of one cluster (or every ssh_config host). */
export async function setAgentForwardForCluster(key, value) {
  const map = { ...(state.settings.agentForwardClusters || {}) };
  if (value === null) delete map[key]; else map[key] = !!value;
  state.settings = await window.api.settings.set({ agentForwardClusters: map });
  renderSidebar();
  status(value === null
    ? `Agent forwarding for ${key} follows the global preference`
    : `Agent forwarding ${value ? 'on' : 'off'} for ${key}`);
}

export function clusterAgentForward(key) {
  const map = state.settings.agentForwardClusters || {};
  return key in map ? !!map[key] : null;
}

/**
 * The menu entries for agent forwarding, at whichever level the caller is.
 *
 * `-A` lets anything running as root on the far end use the keys in your
 * agent, which is the whole point on a jump host and a real exposure on a
 * shared one — so the current answer and where it comes from are both on
 * screen, rather than a checkbox that means "somewhere, something is set".
 */
function agentForwardMenu(host) {
  const st = agentForwardState(host);
  const ck = clusterPrefKey(host);
  const clusterSet = clusterAgentForward(ck);
  return {
    label: `Agent forwarding: ${st.on ? 'on' : 'off'}${st.from === 'host' ? '' : ` (from the ${st.from})`}`,
    title: 'Forwarding the agent lets processes on that host use your keys while the session is open',
    submenu: [
      { heading: true, label: 'This host' },
      { label: 'On', key: st.from === 'host' && st.on ? '✓' : '', onClick: () => setAgentForwardForHost(host, true) },
      { label: 'Off', key: st.from === 'host' && !st.on ? '✓' : '', onClick: () => setAgentForwardForHost(host, false) },
      {
        label: `Follow the ${ck === 'ssh' ? 'SSH config' : 'cluster'} setting`,
        key: st.from !== 'host' ? '✓' : '',
        onClick: () => setAgentForwardForHost(host, null),
      },
      { sep: true },
      { heading: true, label: ck === 'ssh' ? 'Every ssh_config host' : `Every host on ${ck}` },
      { label: 'On', key: clusterSet === true ? '✓' : '', onClick: () => setAgentForwardForCluster(ck, true) },
      { label: 'Off', key: clusterSet === false ? '✓' : '', onClick: () => setAgentForwardForCluster(ck, false) },
      {
        label: `Follow the global preference (${state.settings.agentForward ? 'on' : 'off'})`,
        key: clusterSet === null ? '✓' : '',
        onClick: () => setAgentForwardForCluster(ck, null),
      },
    ],
  };
}

/* ---------------- opening in tmux ---------------- */

/**
 * Whether a session on this host runs inside tmux: the host's own answer,
 * else the cluster's, else the global one.
 *
 * The same three levels as agent forwarding and the file browser, and for the
 * same reason — the right answer differs per machine. On the box where a
 * migration runs for six hours, tmux is what you always want; on an appliance
 * that has no tmux at all it is a session that fails to open. One switch for
 * everything could not be right for both, and the per-host answer is what
 * lets "always" mean always.
 */
function tmuxState(host) {
  const s = state.settings;
  /*
   * Never on a host that wants MFA per session.
   *
   * Such a node cannot be reached over the shared connection at all — it
   * needs `tsh ssh` and an approval for the session — and tmux's whole point
   * is a session that is attached to and detached from repeatedly. That would
   * be a tap per attach at best; at worst the control stream is opened on the
   * connection that cannot satisfy it and the attach fails in a way that
   * reads as "tmux is broken" rather than "this host asks for a tap".
   */
  if (isMfaHost(host.id)) return { on: false, from: 'mfa' };
  const hk = hostPrefKey(host);
  const perHost = s.tmuxHosts || {};
  if (hk && hk in perHost) return { on: !!perHost[hk], from: 'host' };
  const ck = clusterPrefKey(host);
  const perCluster = s.tmuxClusters || {};
  if (ck && ck in perCluster) return { on: !!perCluster[ck], from: 'cluster' };
  return { on: s.tmuxDefault === true, from: 'default' };
}

/** Does opening a session on this host mean attaching to tmux? */
export function opensInTmux(host) {
  return tmuxState(host).on;
}

/** The session name to attach to, which is per host if it has been said. */
export function tmuxNameFor(host) {
  const names = state.settings.tmuxSessionNames || {};
  const hk = hostPrefKey(host);
  return (hk && names[hk]) || state.settings.tmuxSessionName || 'serverlife';
}

async function setTmuxForHost(host, value) {
  const map = { ...(state.settings.tmuxHosts || {}) };
  const key = hostPrefKey(host);
  if (value === null) delete map[key]; else map[key] = !!value;
  state.settings = await window.api.settings.set({ tmuxHosts: map });
  renderSidebar();
  const st = tmuxState(host);
  status(value === null
    ? `${host.name || host.alias}: follows the ${st.from === 'cluster' ? 'cluster' : 'global'} setting (${st.on ? 'tmux' : 'plain session'})`
    : `${host.name || host.alias}: ${value ? 'always opens in tmux' : 'never opens in tmux'}`);
}

async function setTmuxForCluster(ck, value) {
  const map = { ...(state.settings.tmuxClusters || {}) };
  if (value === null) delete map[ck]; else map[ck] = !!value;
  state.settings = await window.api.settings.set({ tmuxClusters: map });
  renderSidebar();
}

async function setTmuxEverywhere(value) {
  state.settings = await window.api.settings.set({ tmuxDefault: !!value });
  renderSidebar();
  status(value
    ? 'New sessions open in tmux everywhere — hosts and clusters can still say otherwise'
    : 'New sessions are plain again');
}

/** The menu for all of that, on one host. */
function tmuxMenu(host) {
  const st = tmuxState(host);
  if (st.from === 'mfa') {
    return {
      label: 'Open in tmux: not on an MFA host',
      icon: '\u267B',
      disabled: true,
      title: 'A node that asks for MFA per session needs tsh ssh and an approval '
        + 'each time; a session you attach to and detach from cannot work that way',
    };
  }
  const ck = clusterPrefKey(host);
  const perCluster = state.settings.tmuxClusters || {};
  const clusterSet = ck && ck in perCluster ? !!perCluster[ck] : null;
  return {
    label: `Open in tmux: ${st.on ? 'always' : 'when asked'}`,
    icon: '\u267B',
    title: 'What runs in tmux keeps running when this window goes away',
    submenu: [
      { heading: true, label: 'This host' },
      { label: 'Always', key: st.from === 'host' && st.on ? '✓' : '', onClick: () => setTmuxForHost(host, true) },
      { label: 'Never', key: st.from === 'host' && !st.on ? '✓' : '', onClick: () => setTmuxForHost(host, false) },
      {
        label: 'Follow the setting below',
        key: st.from !== 'host' ? '✓' : '',
        onClick: () => setTmuxForHost(host, null),
      },
      { sep: true },
      { heading: true, label: ck === 'ssh' ? 'Every ssh_config host' : `Every host on ${ck}` },
      { label: 'Always', key: clusterSet === true ? '✓' : '', onClick: () => setTmuxForCluster(ck, true) },
      { label: 'Never', key: clusterSet === false ? '✓' : '', onClick: () => setTmuxForCluster(ck, false) },
      {
        label: `Follow the global setting (${state.settings.tmuxDefault ? 'always' : 'when asked'})`,
        key: clusterSet === null ? '✓' : '',
        onClick: () => setTmuxForCluster(ck, null),
      },
      { sep: true },
      { heading: true, label: 'Everywhere' },
      {
        label: 'Open every new session in tmux',
        key: state.settings.tmuxDefault ? '✓' : '',
        onClick: () => setTmuxEverywhere(!state.settings.tmuxDefault),
      },
      { sep: true },
      {
        label: 'Session name…',
        title: 'Which tmux session to attach to on this host',
        onClick: async () => {
          const name = await prompt({
            title: 'tmux session name',
            label: `What to attach to on ${host.name || host.alias}`,
            value: tmuxNameFor(host),
          });
          if (name === null || name === undefined) return;
          const names = { ...(state.settings.tmuxSessionNames || {}) };
          const key = hostPrefKey(host);
          if (!name.trim()) delete names[key]; else names[key] = name.trim();
          state.settings = await window.api.settings.set({ tmuxSessionNames: names });
          status(`tmux session: ${tmuxNameFor(host)}`);
        },
      },
    ],
  };
}

/* ---------------- opening with the file browser ---------------- */

/**
 * Whether a session on this host opens with its file browser beside the
 * terminal: the host's own answer, else the cluster's, else the global one.
 *
 * The same three levels as agent forwarding, for the same reason. Some hosts
 * are a shell and nothing else — a jump box, a router, an appliance whose
 * SFTP subsystem is not there at all — and on those the explorer is a panel
 * that costs half the pane and answers an error. Others, on the same cluster,
 * are entirely about the files. One global default cannot be right for both,
 * and setting it per host was the only way to say so.
 */
function openFilesState(host) {
  const s = state.settings;
  const hk = hostPrefKey(host);
  const perHost = s.openFilesHosts || {};
  if (hk && hk in perHost) return { on: !!perHost[hk], from: 'host' };
  const ck = clusterPrefKey(host);
  const perCluster = s.openFilesClusters || {};
  if (ck && ck in perCluster) return { on: !!perCluster[ck], from: 'cluster' };
  return { on: s.explorersVisible !== false, from: 'default' };
}

/** What a new session on this host should do about its explorer. */
export function opensWithFiles(host) {
  return openFilesState(host).on;
}

/**
 * Set or clear the host's own answer. Three states, not two: on, off, and
 * "whatever the cluster says" — without the third, a host set once would be
 * frozen against a later change of mind about the cluster.
 */
async function setOpenFilesForHost(host, value) {
  const map = { ...(state.settings.openFilesHosts || {}) };
  const key = hostPrefKey(host);
  if (value === null) delete map[key]; else map[key] = !!value;
  state.settings = await window.api.settings.set({ openFilesHosts: map });
  renderSidebar();
  const st = openFilesState(host);
  status(value === null
    ? `${host.name || host.alias}: the file browser follows the ${st.from} setting (${st.on ? 'on' : 'off'})`
    : `${host.name || host.alias}: new sessions open ${value ? 'with' : 'without'} the file browser`);
}

/** The same, for every host of one cluster (or every ssh_config host). */
export async function setOpenFilesForCluster(key, value) {
  const map = { ...(state.settings.openFilesClusters || {}) };
  if (value === null) delete map[key]; else map[key] = !!value;
  state.settings = await window.api.settings.set({ openFilesClusters: map });
  renderSidebar();
  status(value === null
    ? `The file browser on ${key} follows the global preference`
    : `Sessions on ${key} open ${value ? 'with' : 'without'} the file browser`);
}

export function clusterOpenFiles(key) {
  const map = state.settings.openFilesClusters || {};
  return key in map ? !!map[key] : null;
}

/** Whether the app opens panes with their explorer at all, by default. */
function globalOpenFiles() {
  return state.settings.explorersVisible !== false;
}

/**
 * The menu entries for it, at whichever level the caller is.
 *
 * It says what will happen and where that comes from, rather than offering a
 * checkbox that means "somewhere, something is set" — the point of the flag
 * is that the two levels disagree.
 */
function openFilesMenu(host) {
  const st = openFilesState(host);
  const ck = clusterPrefKey(host);
  const clusterSet = clusterOpenFiles(ck);
  return {
    label: `Opens with the file browser: ${st.on ? 'yes' : 'no'}${st.from === 'host' ? '' : ` (from the ${st.from})`}`,
    icon: '☰',
    title: 'Whether a new session on this host shows its files beside the terminal. ⌘E still opens it either way.',
    submenu: [
      { heading: true, label: 'This host' },
      { label: 'Open with files', key: st.from === 'host' && st.on ? '✓' : '', onClick: () => setOpenFilesForHost(host, true) },
      { label: 'Do not open with files', key: st.from === 'host' && !st.on ? '✓' : '', onClick: () => setOpenFilesForHost(host, false) },
      {
        label: `Follow the ${ck === 'ssh' ? 'SSH config' : 'cluster'} setting`,
        key: st.from !== 'host' ? '✓' : '',
        onClick: () => setOpenFilesForHost(host, null),
      },
      { sep: true },
      { heading: true, label: ck === 'ssh' ? 'Every ssh_config host' : `Every host on ${ck}` },
      { label: 'Open with files', key: clusterSet === true ? '✓' : '', onClick: () => setOpenFilesForCluster(ck, true) },
      { label: 'Do not open with files', key: clusterSet === false ? '✓' : '', onClick: () => setOpenFilesForCluster(ck, false) },
      {
        label: `Follow the global preference (${globalOpenFiles() ? 'with' : 'without'})`,
        key: clusterSet === null ? '✓' : '',
        onClick: () => setOpenFilesForCluster(ck, null),
      },
    ],
  };
}

/* ---------------- colour, and care ---------------- */

// The palette itself is in util.js, shared with the folders, so a host and
// the folder it sits in can be given the same red and actually match.
export { HOST_COLORS };

export function hostColor(host) {
  return colorCss((state.settings.hostColors || {})[hostPrefKey(host)]);
}

/**
 * The icon a host has been given, if any.
 *
 * A colour says "careful" from the corner of your eye; an icon says *what*.
 * The two are separate on purpose — a red 🐧 and a red 🪟 are both production
 * and not the same problem — and both are filed under the same per-host key
 * as everything else, so an ssh_config alias can carry one exactly as a
 * Teleport node does.
 */
export function hostIcon(host) {
  return (state.settings.hostIcons || {})[hostPrefKey(host)] || '';
}

async function setHostIcon(host) {
  const { pickIcon } = await import('./ui.js');
  const icon = await pickIcon({
    title: 'Icon for this host',
    subtitle: host.name || host.alias,
    value: hostIcon(host),
  });
  if (icon === null || icon === undefined) return;
  const map = { ...(state.settings.hostIcons || {}) };
  const key = hostPrefKey(host);
  if (icon) map[key] = icon; else delete map[key];
  state.settings = await window.api.settings.set({ hostIcons: map });
  renderSidebar();
  status(icon ? `${host.name || host.alias} is ${icon}` : 'Icon cleared');
}

/** The colour for a connection, so a tab or a pane can take it too. */
export function hostColorForConn(conn) {
  if (!conn?.hostId) return '';
  const host = hostById(conn.hostId);
  return host ? hostColor(host) : '';
}

export function isCareful(host) {
  return (state.settings.carefulHosts || []).includes(hostPrefKey(host));
}

async function setHostColor(host, value) {
  const map = { ...(state.settings.hostColors || {}) };
  const key = hostPrefKey(host);
  if (value) map[key] = value; else delete map[key];
  state.settings = await window.api.settings.set({ hostColors: map });
  renderSidebar();
  // Tabs and pane headers carry it too.
  const { renderTabs } = await import('./tabs.js');
  renderTabs();
  const { applyHostColors } = await import('./sessions.js');
  applyHostColors();
  status(value
    ? `${host.name || host.alias} is ${value}`
    : `Colour cleared for ${host.name || host.alias}`);
}

async function setCareful(host, on) {
  const list = new Set(state.settings.carefulHosts || []);
  const key = hostPrefKey(host);
  on ? list.add(key) : list.delete(key);
  state.settings = await window.api.settings.set({ carefulHosts: [...list] });
  renderSidebar();
  status(on
    ? `${host.name || host.alias} is marked careful — multi-exec will ask first`
    : `${host.name || host.alias} is no longer marked careful`);
}

/* ---------------- stars ---------------- */

export function isStarred(h) {
  return (state.starredHosts || []).includes(h.id);
}

/** Star or unstar a host. Starred hosts are listed again, together, at the top. */
export async function setStarred(host, on) {
  const list = (state.starredHosts || []).filter((id) => id !== host.id);
  // Appended rather than prepended: a list built up over weeks should not
  // reshuffle itself every time something is added to it.
  if (on) list.push(host.id);
  state.starredHosts = list;
  state.settings = await window.api.settings.set({ starredHosts: list });
  renderSidebar();
  status(on ? `Starred ${host.name || host.alias}` : `Unstarred ${host.name || host.alias}`);
}

/** Where starred hosts are shown: at the top of their own group, or gathered. */
export function starredMode() {
  return state.settings.starredMode === 'group' ? 'group' : 'inline';
}

export async function setStarredMode(mode) {
  state.settings = await window.api.settings.set({ starredMode: mode === 'group' ? 'group' : 'inline' });
  renderSidebar();
  status(mode === 'group'
    ? 'Starred hosts are gathered in their own group'
    : 'Starred hosts sit at the top of their own group');
}

/**
 * The order hosts appear in within one group.
 *
 * Three things decide it, most deliberate first: a manual order from dragging,
 * then a star (when stars are shown inline), then the order they arrived in —
 * which is alphabetical for a cluster's nodes and file order for a config.
 */
function orderHosts(list, groupKey) {
  const manual = (state.settings.hostOrder || {})[groupKey] || [];
  const starFirst = starredMode() === 'inline';
  return list
    .map((h, i) => ({ h, i }))
    .sort((a, b) => {
      const ma = manual.indexOf(a.h.id);
      const mb = manual.indexOf(b.h.id);
      if (ma >= 0 || mb >= 0) {
        // A dragged host outranks everything, including a star.
        if (ma >= 0 && mb >= 0) return ma - mb;
        return ma >= 0 ? -1 : 1;
      }
      if (starFirst) {
        const sa = isStarred(a.h) ? 0 : 1;
        const sb = isStarred(b.h) ? 0 : 1;
        if (sa !== sb) return sa - sb;
      }
      return a.i - b.i;
    })
    .map(({ h }) => h);
}

/** Write a group's manual order, keeping only the hosts that are in it. */
async function saveHostOrder(groupKey, ids) {
  const map = { ...(state.settings.hostOrder || {}) };
  if (ids.length) map[groupKey] = ids; else delete map[groupKey];
  state.settings = await window.api.settings.set({ hostOrder: map });
  renderSidebar();
}

let dragHost = null;

/**
 * Drag a host row to put it where you want it in its group — usually the top.
 *
 * Only within a group: dragging a node out of its cluster would say something
 * the app cannot honour. The drop lands before or after the row under the
 * pointer depending on which half it is over, which is the behaviour every
 * list with drag has and therefore the one people expect.
 */
function wireHostDrag(row, host, groupKey) {
  if (!groupKey) return;
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    // The row's own host rides along: a requestable node or a watched ghost
    // is drawn from a list hostById does not search, and the drop has to
    // be able to file it all the same.
    dragHost = { id: host.id, groupKey, host };
    dragFolder = null;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox and Chromium both want something set or no drag begins.
    try { e.dataTransfer.setData('text/plain', host.id); } catch { /* a drag without a payload still moves the row */ }
  });
  row.addEventListener('dragend', () => {
    dragHost = null;
    row.classList.remove('dragging');
    for (const n of document.querySelectorAll('.sb-item.drop-before, .sb-item.drop-after')) {
      n.classList.remove('drop-before', 'drop-after');
    }
  });
  row.addEventListener('dragover', (e) => {
    if (!dragHost || dragHost.groupKey !== groupKey || dragHost.id === host.id) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    row.classList.toggle('drop-before', !after);
    row.classList.toggle('drop-after', after);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', async (e) => {
    if (!dragHost || dragHost.groupKey !== groupKey) return;
    e.preventDefault();
    e.stopPropagation();
    const after = row.classList.contains('drop-after');
    row.classList.remove('drop-before', 'drop-after');
    // Start from what is on screen, so a drop respects the stars and the
    // natural order that produced the list being looked at.
    const ids = [...row.parentElement.querySelectorAll('.sb-item[data-host]')]
      .map((n) => n.dataset.host)
      .filter(Boolean);
    const from = ids.indexOf(dragHost.id);
    if (from >= 0) ids.splice(from, 1);
    let at = ids.indexOf(host.id);
    if (at < 0) at = ids.length; else if (after) at += 1;
    ids.splice(at, 0, dragHost.id);
    await saveHostOrder(groupKey, ids);
    status('Order saved for this group');
  });
}

/* ------------------------------------------------------------------ */
/* Folders                                                             */
/* ------------------------------------------------------------------ */

/**
 * Which folders are shut, for this run of the app.
 *
 * Not persisted, like the groups above them: collapse is what you are doing
 * now, not a preference, and a folder that comes back shut a week later has
 * to be remembered before it can be opened.
 */
const foldersShut = { has: (id) => closedSet('sidebarClosedFolders').has(id) };

/** What a folder is dragging, kept alongside `dragHost` for the same reason. */
let dragFolder = null;

/**
 * A group's rows: its folders, nested, with what is in them — and then the
 * hosts that are not filed anywhere.
 *
 * `hosts` has already been through the filter and the hidden list, so a
 * folder shows what it holds *of what is on screen*. That is what makes the
 * filter box and folders work together rather than fight: typing `env=prod`
 * leaves every folder holding only its prod machines.
 */
/**
 * Whether a row belongs under the All/SSH/K8s filter. Live rows are already
 * split by kind where they are built; ghosts drawn from watch records are
 * not, and a kube watch record carries its `kube:` id rather than a kind.
 */
function inKindShown(h) {
  const k = hostKindShown();
  if (k === 'all') return true;
  const isKube = h.kind === 'kube' || h.kind === 'kube_cluster' || /^kube:/.test(h.id || '')
    || /\/kube_cluster\//.test(h.resourceId || '');
  return k === 'kube' ? isKube : !isKube;
}

function groupRows(groupKey, hosts, labelFor) {
  const rows = [];
  const filtering = !!filterText;
  /*
   * Watched hosts that are no longer in the list are drawn from the record
   * kept of them, alongside the ones that are. Host-shaped, so they fall
   * into their folder, answer the filter and count like anything else —
   * the row itself is the only thing that knows they are gone.
   */
  const ghosts = [
    ...missingIn(groupKey, hosts),
    /*
     * Watched hosts that are out of reach rather than gone: the machine is
     * there and answering, and what lapsed is the access to it. They are
     * drawn from the record like a ghost, because the node list has nothing
     * to say about a node you cannot see — but they are not a loss, and the
     * row says so.
     */
    ...requestableIn(groupKey, hosts),
    // And the watches this group cannot currently answer for: its read
    // failed, its certificate lapsed, or it has not been asked in an hour.
    ...unconfirmedIn(groupKey, hosts),
  ].filter(visibleHost).filter(inKindShown);
  // First, not last: a machine that has vanished is the news in this list,
  // and appending it put it behind the twenty-row cap on any cluster big
  // enough to need one — which is exactly where it would never be seen.
  if (ghosts.length) hosts = [...ghosts, ...hosts];

  const walk = (parent, depth) => {
    for (const f of foldersIn(groupKey, parent)) {
      const deep = hostsInTree(f, hosts);
      /*
       * While a filter is running, an empty folder is in the way — the list
       * is meant to be the answer to a question. With no filter it stays:
       * a folder you have just made, or emptied, is not a mistake to hide.
       */
      if (filtering && !deep.length) continue;
      rows.push(folderRow(f, deep.length, depth, groupKey));
      if (foldersShut.has(f.id)) continue;
      walk(f.id, depth + 1);
      for (const h of orderHosts(hostsInFolder(f, hosts), groupKey)) {
        rows.push(hostRow(h, labelFor(h), groupKey, { depth: depth + 1, folder: f }));
      }
    }
  };
  walk(null, 0);

  const loose = showFiledHosts() ? hosts : hosts.filter((h) => !isFiled(h, groupKey));
  for (const h of orderHosts(loose, groupKey)) rows.push(hostRow(h, labelFor(h), groupKey));

  /*
   * The cap, applied to the host rows and not to the folders: the
   * arrangement is the point of the arrangement, and hiding half a tree to
   * save four lines would make the sidebar lie about its own shape. Filtering
   * is exempt — a query that finds forty things should show forty things,
   * because you asked a specific question and the answer is the list.
   */
  const limit = hostLimit();
  if (!limit || filterText) return rows;
  let shown = 0;
  const capped = [];
  let hidden = 0;
  for (const r of rows) {
    const isHost = r.classList?.contains('sb-item');
    // A host that has disappeared is never what the cap should hide: it is
    // there because somebody asked to be told about it.
    if (!isHost || r.classList.contains('missing')) { capped.push(r); continue; }
    if (shown < limit) { capped.push(r); shown += 1; } else hidden += 1;
  }
  if (hidden) capped.push(moreRow(groupKey, hidden));
  return capped;
}

function folderRow(folder, count, depth, groupKey) {
  const shut = foldersShut.has(folder.id);
  const colour = folderColor(folder);
  const row = el('div', {
    class: 'sb-folder' + (shut ? ' shut' : '') + (colour ? ' coloured' : ''),
    style: `--depth:${depth}` + (colour ? `;--folder-color:${colour}` : ''),
    dataset: { folder: folder.id },
    title: [
      folderPath(folder).map((f) => f.name).join(' / '),
      folder.rule ? `fills itself with: ${folder.rule}` : 'holds what you drag into it',
      `${count} host${count === 1 ? '' : 's'}`,
      'Drag a host onto it, or right-click for more',
    ].join('\n'),
  },
    el('span', { class: 'chev', text: shut ? '▶' : '▼' }),
    el('span', { class: 'fico', text: folderIcon(folder, !shut) }),
    el('span', { class: 'name', text: folder.name }),
    // A rule folder is a different thing from a hand-filled one — what is in
    // it will change on its own — and the row has to say which it is.
    folder.rule ? el('span', { class: 'tag rule', title: folder.rule, text: 'rule' }) : null,
    el('span', { class: 'count', text: String(count) }));

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleClosed('sidebarClosedFolders', folder.id);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openFolderMenu(e.clientX, e.clientY, folder, groupKey);
  });
  wireFolderDnD(row, folder, groupKey);
  return row;
}

/**
 * A folder is both something you drop onto and something you drag.
 *
 * Dropping a host files it; dropping a folder re-parents it, which is how a
 * tree gets rearranged without a dialog. The drop is refused rather than
 * silently ignored where it cannot work — a folder into its own descendant,
 * a host from another cluster — so the cursor says no before the mouse is
 * let go.
 */
function wireFolderDnD(row, folder, groupKey) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    dragFolder = folder;
    dragHost = null;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', folder.name); } catch { /* a drag without a payload still moves the row */ }
  });
  row.addEventListener('dragend', () => {
    dragFolder = null;
    row.classList.remove('dragging');
    clearDropMarks();
  });

  const canTake = () => {
    if (dragHost) return dragHost.groupKey === groupKey;
    if (dragFolder) {
      if (dragFolder.id === folder.id) return false;
      if (dragFolder.group !== groupKey) return false;
      // Into its own descendant is a loop; the tree walk would not return.
      return !folderPath(folder).some((f) => f.id === dragFolder.id);
    }
    return false;
  };

  row.addEventListener('dragover', (e) => {
    if (!canTake()) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-in');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-in'));
  row.addEventListener('drop', async (e) => {
    if (!canTake()) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-in');
    if (dragFolder) {
      const moving = dragFolder;
      dragFolder = null;
      if (await reparentFolder(moving.id, folder.id)) status(`${moving.name} is now inside ${folder.name}`);
      return;
    }
    const host = hostById(dragHost.id) || dragHost.host;
    dragHost = null;
    if (host) await dropHostIntoFolder(host, folder, groupKey);
  });
}

function clearDropMarks() {
  for (const n of document.querySelectorAll('.drop-before, .drop-after, .drop-in')) {
    n.classList.remove('drop-before', 'drop-after', 'drop-in');
  }
}

/**
 * The drop itself.
 *
 * A host that is filed nowhere just goes in. One already filed elsewhere in
 * the same tree is being tidied, and moves. One filed under a *different*
 * root is the interesting case: being in two places at once is a real answer
 * — the same box is one of the web servers and one of the things on call —
 * so it is asked rather than guessed.
 */
async function dropHostIntoFolder(host, folder, groupKey) {
  const r = await fileHostsInto([host], folder, groupKey);
  if (!r) return;
  status(`${host.name || host.alias} ${r.mode === 'move' ? 'moved to' : 'added to'} ${folder.name}`);
}

/**
 * Filing, from a host's own menu.
 *
 * Dragging is the good way to file something and the only way that is no use
 * at all when the folder you want is shut, scrolled off, or does not exist
 * yet. This is the same set of moves for the keyboard and for the far end of
 * a long list, and it is where a host says which folders already hold it.
 */
export function folderMenuFor(host, ctx = {}) {
  const groupKey = ctx.groupKey || groupKeyForHost(host);
  if (!groupKey) return null;
  const hosts = hostsInGroup(groupKey);
  const mine = foldersForHost(host, groupKey);
  const mineIds = new Set(mine.map((f) => f.id));
  const all = allFolders().filter((f) => f.group === groupKey);

  const label = (f) => folderPath(f).map((x) => x.name).join(' / ');
  const items = [
    {
      label: 'New folder with this host…', icon: '\u{1F4C1}',
      onClick: async () => {
        const made = await openFolderDialog({ group: groupKey, hosts });
        if (made) await dropHostIntoFolder(host, made, groupKey);
      },
    },
  ];

  if (all.length) {
    items.push({ sep: true }, { heading: true, label: 'File it in' });
    for (const f of all) {
      items.push({
        label: label(f),
        key: mineIds.has(f.id) ? '✓' : '',
        title: f.rule && !isManualMember(host, f.id) ? `Matched by this folder's rule: ${f.rule}` : '',
        onClick: () => (mineIds.has(f.id) ? unfileHost(host, f.id) : dropHostIntoFolder(host, f, groupKey)),
      });
    }
  }

  if (mine.length) {
    items.push({ sep: true }, {
      label: mine.length === 1 ? `Take it out of ${mine[0].name}` : 'Take it out of every folder',
      onClick: async () => {
        for (const f of mine) await unfileHost(host, f.id);
        status(`${host.name || host.alias} is loose again`);
      },
    });
  }

  return {
    label: mine.length
      ? `Folders: ${mine.map((f) => f.name).join(', ')}`
      : 'Folders: not filed',
    icon: '\u{1F4C2}',
    title: 'A filed host is listed inside its folder instead of loose in the group',
    submenu: items,
  };
}

/** Which group's list a host is drawn in — the scope its folders live in. */
function groupKeyForHost(host) {
  if (!host) return '';
  if (host.type === 'teleport') {
    const p = (state.teleportProfiles || []).find((x) => x.cluster === host.cluster
      && (x.home || null) === (host.home || null));
    return p ? groupKeyFor(p) : '';
  }
  if (host.type !== 'ssh') return '';
  const roots = configRoots();
  const root = roots.find((r) => r.file === (host.configRoot || ''))
    || roots.find((r) => r.primary);
  if (!root) return '';
  return root.primary ? 'ssh' : 'ssh:' + root.file;
}

function openFolderMenu(x, y, folder, groupKey) {
  const hosts = hostsInGroup(groupKey);
  contextMenu(x, y, [
    { label: folderPath(folder).map((f) => f.name).join(' / '), heading: true },
    {
      label: 'Open this folder…', icon: '⊞',
      title: 'The big view, with everything in it',
      onClick: () => openFolderBrowser({ groupKey, folderId: folder.id }),
    },
    { sep: true },
    {
      label: 'New folder inside…', icon: '\u{1F4C1}',
      onClick: () => openFolderDialog({ group: groupKey, parent: folder.id, hosts }),
    },
    {
      label: folder.rule ? 'Edit folder and its rule…' : 'Edit folder…', icon: '✎',
      onClick: () => openFolderDialog({ group: groupKey, folder, hosts }),
    },
    {
      label: 'Open every host in it',
      title: `${hostsInTree(folder, hosts).length} session(s)`,
      onClick: () => openEveryHostIn(folder, hosts),
    },
    { sep: true },
    {
      label: 'Select these for multi-exec', icon: '☑',
      onClick: () => {
        for (const h of hostsInTree(folder, hosts)) state.checkedHosts.add(h.id);
        state.emit('checked');
        renderSidebar();
        updateStatusBar();
      },
    },
    { sep: true },
    { label: 'Export these folders…', onClick: () => exportFoldersDialog(groupKey) },
    {
      label: 'Delete this folder…', icon: '⌦',
      onClick: async () => {
        const kids = allFolders().filter((f) => f.parent === folder.id).length;
        const go = await confirm({
          title: `Delete “${folder.name}”?`,
          message: kids
            ? `The folder and the ${kids} inside it go.`
            : 'The folder goes.',
          detail: 'The hosts stay exactly where they were — they live in the cluster, not in here. '
            + 'They go back to being listed loose.',
          confirmLabel: 'Delete',
        });
        if (go) {
          await deleteFolder(folder.id);
          status(`Deleted “${folder.name}”`);
        }
      },
    },
  ]);
}

/** Open a session on everything in a folder, asking first past a few. */
async function openEveryHostIn(folder, hosts) {
  const list = hostsInTree(folder, hosts);
  if (!list.length) return toast('Nothing in that folder', 'error');
  if (list.length > 6) {
    const go = await confirm({
      title: `Open ${list.length} sessions?`,
      message: `“${folder.name}” holds ${list.length} hosts.`,
      detail: 'Each one is a tab and a connection.',
      confirmLabel: `Open ${list.length}`,
    });
    if (!go) return undefined;
  }
  for (const h of list) {
    try { await open(h); } catch (e) { toast(`${h.name || h.alias}: ${e.message}`, 'error'); }
  }
  return undefined;
}

/**
 * The hosts a group is made of — the same list the sidebar draws, before the
 * filter. The folder dialogs and the big view both need it, and this is the
 * one place that knows how a group key maps onto the inventory.
 */
export function hostsInGroup(groupKey) {
  if (!groupKey) return [];
  if (groupKey.startsWith('tp:')) {
    const beams = beamNodeNames();
    for (const p of state.teleportProfiles || []) {
      if (groupKeyFor(p) !== groupKey) continue;
      return (state.teleportNodes.get(tpKey(p)) || []).filter((n) => !beams.has(n.name));
    }
    return [];
  }
  const roots = configRoots();
  const root = groupKey === 'ssh'
    ? roots.find((r) => r.primary)
    : roots.find((r) => 'ssh:' + r.file === groupKey);
  if (!root) return [];
  return (state.sshHosts || []).filter((h) => (h.configRoot || '') === root.file
    || (root.primary && !h.configRoot));
}

/** Every group that can hold folders, for the big view and for import. */
/* ------------------------------------------------------------------ */
/* What a cluster would let you ask for                                */
/* ------------------------------------------------------------------ */

/*
 * Fetched per cluster and kept briefly: a search is a round trip to the
 * proxy, and the host list redraws for all sorts of reasons that have
 * nothing to do with it.
 */
const reqCache = new Map();   // groupKey -> { at, hosts, fetching }
const REQ_TTL_MS = 120000;

export function showRequestableIn(groupKey) {
  return !!(state.settings.requestableGroups || {})[groupKey];
}

export async function setShowRequestable(groupKey, on) {
  const map = { ...(state.settings.requestableGroups || {}) };
  if (on) map[groupKey] = true; else delete map[groupKey];
  state.settings = await window.api.settings.set({ requestableGroups: map });
  if (on) reqCache.delete(groupKey);
  renderSidebar();
  status(on
    ? 'Also listing what this cluster would let you ask for'
    : 'Showing only what you can reach on this cluster');
}

/**
 * The requestable nodes of one cluster, host-shaped, or an empty list while
 * the answer is on its way. The redraw when it lands is what puts them on
 * screen — the sidebar cannot wait for a proxy mid-render.
 */
function requestableHostsFor(profile) {
  const key = groupKeyFor(profile);
  if (!showRequestableIn(key)) return [];
  const hit = reqCache.get(key);
  if (hit && Date.now() - hit.at < REQ_TTL_MS) return hit.hosts;
  if (!hit?.fetching) {
    reqCache.set(key, { at: hit?.at || 0, hosts: hit?.hosts || [], fetching: true });
    import('./requestable.js')
      .then((m) => m.requestableHosts({
        proxy: profile.proxy, home: profile.homeDir || null, cluster: profile.cluster,
      }))
      .then((r) => {
        reqCache.set(key, { at: Date.now(), hosts: r.hosts, fetching: false });
        renderSidebar();
      })
      .catch(() => reqCache.set(key, { at: Date.now(), hosts: [], fetching: false }));
  }
  return hit?.hosts || [];
}

export function folderGroups() {
  const out = [];
  for (const p of state.teleportProfiles || []) {
    if (p.expired) continue;
    out.push({ key: groupKeyFor(p), label: p.cluster || p.proxy, kind: 'teleport' });
  }
  for (const root of configRoots()) {
    out.push({ key: root.primary ? 'ssh' : 'ssh:' + root.file, label: root.label, kind: 'ssh' });
  }
  return out;
}

/** Re-read the saved clusters, after one is saved or forgotten. */
export async function loadSavedClusters() {
  try { state.savedLogins = await window.api.teleport.savedLogins(); } catch { return; }
  renderSidebar();
}

async function unpinSavedCluster(t) {
  // Every pinned record for the cluster, or another account's would keep it here.
  const same = (state.savedLogins || []).filter((s) => s.showInHosts
    && s.proxy.replace(/:443$/, '') === t.proxy.replace(/:443$/, '') && (s.home || '') === (t.home || ''));
  for (const s of same.length ? same : [t]) await window.api.teleport.saveLogin({ ...s, showInHosts: false });
  status(`${t.name} is no longer kept on the Hosts tab`);
  await loadSavedClusters();
}

/**
 * Say that a watched host has gone, or come back.
 *
 * Exported because the background poll has the same news to deliver and no
 * business building sentences of its own. A disappearance gets a long toast
 * and an error colour: it is the one thing in this app that reports
 * something being *absent*, and a notice that has already faded has failed.
 */
export function announceWatch(change) {
  if (!change) return;
  for (const w of change.gone) toast(announcement(w, 'gone'), 'error', 12000);
  for (const w of change.back) toast(announcement(w, 'back'), 'success', 8000);
}

/**
 * Delete a dead profile's files, after saying exactly which ones.
 *
 * Not `tsh logout`: that is right for a live cluster and wrong here, because
 * the profiles this offers to remove are the ones whose proxy has gone —
 * a torn-down lab, a demo cluster that no longer resolves — and logging out
 * of a host that is not answering can sit there until it times out. The
 * files are what makes tsh list the cluster, so the files are what goes.
 *
 * The dialog names every path first. This reaches into ~/.tsh, which is not
 * somewhere an app should be vague about.
 */
async function removeExpiredProfile(profile) {
  const opts = { proxy: profile.proxy, home: profile.homeDir };
  let files = [];
  try { files = await window.api.teleport.profileFiles(opts); } catch { /* listed below as none */ }

  const go = await confirm({
    title: `Remove ${profile.cluster || profile.proxy}?`,
    message: files.length
      ? `This deletes ${files.length} item${files.length === 1 ? '' : 's'} from your tsh home.`
      : 'There is nothing left of this profile to delete.',
    detail: [
      ...files,
      '',
      'The cluster stops being listed here and by tsh status. Nothing on the',
      'cluster itself is touched, and logging in again recreates the profile.',
    ].join('\n'),
    confirmLabel: 'Remove',
  });
  if (!go) return;

  try {
    const r = await window.api.teleport.removeProfile(opts);
    if (!r?.ok) return toast(r?.error || 'Could not remove that profile', 'error');
    status(`Removed ${profile.cluster || profile.proxy}`);
    await refreshInventory(false);
  } catch (e) {
    toast(e.message, 'error');
  }
  return undefined;
}

/** The hosts of one group in a pane of their own. */
export function openHostsPaneFor(groupKey, dir = null) {
  return import('./hostspane.js')
    .then((m) => m.openHostsPane({ groupKey, dir }))
    .catch((e) => toast(e.message, 'error'));
}

/**
 * How many hosts a group lists before it stops and offers the pane.
 *
 * A cluster with three hundred nodes turns the sidebar into a scrollbar with
 * a list attached: every other group is pushed off the bottom, and the one
 * you wanted is somewhere in the middle of the one you did not. Past this
 * many the list stops and says how many it is holding back — and the row
 * that says so is the way into the view that can actually show them.
 */
function hostLimit() {
  const v = state.settings.sidebarHostLimit;
  const n = v === undefined || v === null ? 20 : Number(v) || 0;
  return Math.max(0, n);
}

function moreRow(groupKey, hidden) {
  const row = el('div', {
    class: 'sb-more',
    title: `This list stops at ${hostLimit()} hosts.\nOpen the pane to see all of them, or raise the limit in Settings.`,
  },
    el('span', { class: 'dots', text: '…' }),
    el('span', { class: 'name', text: `${hidden} more` }),
    el('span', { class: 'go', text: 'open in a pane' }));
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    openHostsPaneFor(groupKey);
  });
  return row;
}

/** The big view, loaded on demand — it is a screenful of its own. */
export function openFolderBrowser(opts = {}) {
  return import('./folderview.js').then((m) => m.openFolderBrowser(opts)).catch((e) => toast(e.message, 'error'));
}

/** Every starred host that still exists, in the order they were starred. */
function starredHosts() {
  const byId = new Map();
  for (const n of [...state.teleportNodes.values()].flat()) byId.set(n.id, n);
  for (const h of state.sshHosts || []) byId.set(h.id, h);
  return (state.starredHosts || []).map((id) => byId.get(id)).filter(Boolean);
}

function visibleHost(h) {
  if (isHidden(h) && !state.settings.showHiddenHosts) return false;
  /*
   * The quiet-node filter. "only" hides everything that is not a quiet node,
   * ssh hosts included: the point of that mode is a list of what has stopped
   * answering, and anything else in it is in the way.
   */
  const quiet = quietFilter();
  /*
   * Gone is not quiet. A node that has stopped checking in is noise you may
   * reasonably want out of the way — that is what hiding quiet nodes is for
   * — but a host you marked and that has since left the inventory is the
   * opposite: it is the answer to a question you asked in advance, and it
   * stays on screen until you take the watch off it. Hiding it behind a
   * filter would mean the news arrived once, in a toast, and then vanished.
   */
  if (quiet === 'hide' && isQuiet(h) && !h.missing && !h.unconfirmed) return false;
  if (quiet === 'only' && !isQuiet(h)) return false;
  return hostMatches(h);
}

async function setHidden(h, hide) {
  if (!state.hiddenHosts) state.hiddenHosts = new Set();
  hide ? state.hiddenHosts.add(h.id) : state.hiddenHosts.delete(h.id);
  state.settings = await window.api.settings.set({ hiddenHosts: [...state.hiddenHosts] });
  renderSidebar();
  status(hide ? `Hid ${h.name || h.alias}` : `Restored ${h.name || h.alias}`);
}

export async function toggleShowHidden() {
  state.settings = await window.api.settings.set({ showHiddenHosts: !state.settings.showHiddenHosts });
  renderSidebar();
}

/**
 * A shell's name, qualified by its directory when the same name exists twice —
 * a Homebrew bash and the system one are not the same shell, and a menu with
 * "bash" twice is a coin toss.
 */
function shellLabel(sh, all) {
  const twice = all.filter((x) => x.name === sh.name).length > 1;
  return twice ? `${sh.name}  (${sh.path.replace(/\/[^/]+$/, '')})` : sh.name;
}

function hostMatches(h) {
  return filterMatch.match(h);
}

/**
 * The ⟳ on a group heading: re-read just this cluster, or just this config
 * file.
 *
 * The toolbar's Refresh re-reads everything — every profile's nodes, its
 * trusted clusters, its beams, every config file — which on a few clusters is
 * several seconds of `tsh` for the sake of the one that changed. This asks the
 * one you are looking at.
 */
function refreshTag(key, title, run) {
  const busy = (state.refreshingGroups || new Set()).has(key);
  const b = el('span', {
    class: 'gbtn' + (busy ? ' spin' : ''),
    text: '\u27F3',
    title: busy ? 'Refreshing…' : title,
  });
  b.addEventListener('click', (e) => {
    // The heading collapses when clicked, and is draggable; neither should
    // happen because someone aimed at the button on it.
    e.preventDefault();
    e.stopPropagation();
    if (!busy) run();
  });
  return b;
}

/** Run one group's refresh with the heading showing that it is running. */
async function withGroupBusy(key, fn) {
  if (!state.refreshingGroups) state.refreshingGroups = new Set();
  state.refreshingGroups.add(key);
  renderSidebar();
  try {
    await fn();
  } catch (e) {
    toast(e.message || String(e), 'error');
  } finally {
    state.refreshingGroups.delete(key);
    renderSidebar();
  }
}

/**
 * Re-read one Teleport profile: its nodes, the clusters it trusts, and its
 * beams. Everything else in the sidebar is left exactly as it was.
 */
export function refreshProfile(p) {
  const key = groupKeyFor(p);
  refreshKubeFor(p);
  return withGroupBusy(key, async () => {
    const opts = { proxy: p.proxy, cluster: p.cluster, home: p.homeDir };
    const [nodes, clusters] = await Promise.all([
      window.api.teleport.nodes(opts).catch(() => null),
      window.api.teleport.clusters({ proxy: p.proxy, home: p.homeDir }).catch(() => null),
    ]);
    if (nodes) state.teleportNodes.set(tpKey(p), nodes.ok ? nodes.nodes : []);
    if (clusters) state.teleportClusters.set(tpKey(p), clusters.ok ? clusters.clusters : []);
    if (nodes?.ok) {
      observe(tpKey(p), nodes.nodes);
      noteRead(p, nodes.nodes);
      announceWatch(await noteSeen(groupKeyFor(p), nodes.nodes, { partial: isNarrowed(p) }));
    }
    if (beamsSupported(p.proxy)) await refreshBeams({ refresh: true, proxy: p.proxy }).catch(() => {});
    state.emit('inventory');
    const n = (state.teleportNodes.get(tpKey(p)) || []).length;
    status(`${p.cluster || p.proxy}: ${n} node${n === 1 ? '' : 's'}`);
  });
}

/**
 * Re-read the ssh_config files. One file cannot be re-read on its own — the
 * discovery call answers with every host from every file — so the heading that
 * was clicked is the one that reports, and the rest are refreshed with it.
 */
export function refreshSshConfigs(key = 'ssh') {
  return withGroupBusy(key, async () => {
    const [hosts, files] = await Promise.all([
      window.api.discovery.sshHosts().catch(() => []),
      window.api.discovery.sshConfigFiles().catch(() => []),
    ]);
    state.sshHosts = hosts;
    state.sshConfigFiles = files;
    try { state.managedSshHosts = await window.api.discovery.managedSshHosts(); } catch { /* no managed hosts: nothing is marked */ }
    state.emit('inventory');
    status(`${hosts.length} host${hosts.length === 1 ? '' : 's'} in ${files.length} config file${files.length === 1 ? '' : 's'}`);
  });
}

function group(title, count, key, children, extra, profile) {
  // A cluster's own colour, on its heading. Groups that are not clusters —
  // ssh config files, Local, Starred — simply have none.
  const colour = profile ? clusterColor(profile) : '';
  const icon = profile ? clusterIcon(profile) : '';
  const g = el('div', {
    class: 'sb-group' + (collapsed.has(key) ? ' collapsed' : '') + (colour ? ' coloured' : ''),
    dataset: { group: key },
    style: colour ? `--cluster-color:${colour}` : null,
  });
  g.groupTitle = title;
  // Teleport groups carry their profile, so the heading's menu can act on the
  // cluster it names.
  g.profile = profile || null;
  // "prod" is reached at proxy.example.com, say — a heading
  // that names only one of the two is easy to not recognise as the same
  // cluster seen elsewhere by the other. The standard 443 is dropped from
  // both the comparison and the display: a cluster named after its own
  // proxy host, port aside, is not naming anything new. teleportpanel.js's
  // own row makes the same addition; duplicated rather than imported,
  // since that module reaches back into this one (dynamically) and a
  // short string helper is not worth risking the load order over.
  const proxyHost = profile ? String(profile.proxy || '').trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/@]*@/, '').replace(/\/.*$/, '')
    .replace(/:443$/, '').trim() : '';
  const proxyNote = profile?.cluster && proxyHost && proxyHost !== profile.cluster
    ? el('span', { class: 'hint', text: `(${proxyHost})` })
    : null;
  const head = el('div', { class: 'sb-group-head', draggable: 'true' },
    el('span', { class: 'chev', text: '▼' }),
    // Before the name, unlike a host's icon, which follows it: a heading is
    // read as a label rather than scanned down a column, and the mark is
    // what makes one heading findable among six.
    icon ? el('span', { class: 'gico', text: icon }) : null,
    el('span', { class: 'gname', text: title }),
    proxyNote,
    extra || null,
    el('span', { class: 'count', text: String(count) }));
  head.addEventListener('click', () => {
    toggleClosed('sidebarClosedGroups', key);
  });
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openGroupMenu(e.clientX, e.clientY, key, title, g.profile || null);
  });
  wireGroupDrag(g, head, key);
  const items = el('div', { class: 'sb-items' }, ...children);
  g.append(head, items);
  return g;
}

/* ------------------------------------------------------------------ */
/* Group order                                                         */
/* ------------------------------------------------------------------ */

/**
 * Which order the sidebar's groups appear in.
 *
 * Whatever the user has arranged comes first, in their order; anything new —
 * a cluster they have just logged into — falls in behind it, still in the
 * order the panel built it, so a fresh cluster never hides at the top.
 */
function orderedGroups(groups) {
  const order = state.settings.hostGroupOrder || [];
  /*
   * Starred hosts stay at the top.
   *
   * A group the user has never arranged falls in behind the ones they have,
   * which for a list built up over time would put the starred group below
   * everything — the opposite of the point of starring. It is pinned to the
   * front unless the user has deliberately placed it themselves, which their
   * saved order naming it is exactly the evidence of.
   */
  const pinStarred = !order.includes('starred');
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      if (pinStarred) {
        const sa = a.g.dataset.group === 'starred' ? 0 : 1;
        const sb = b.g.dataset.group === 'starred' ? 0 : 1;
        if (sa !== sb) return sa - sb;
      }
      const ra = order.indexOf(a.g.dataset.group);
      const rb = order.indexOf(b.g.dataset.group);
      return (ra < 0 ? order.length + a.i : ra) - (rb < 0 ? order.length + b.i : rb) || a.i - b.i;
    })
    .map(({ g }) => g);
}

/** The keys as they are on screen right now — the basis for any reorder. */
function groupKeysOnScreen() {
  return [...$('#sb-panel-hosts').querySelectorAll(':scope > .sb-group')].map((g) => g.dataset.group);
}

async function saveGroupOrder(keys) {
  state.settings = await window.api.settings.set({ hostGroupOrder: keys });
  renderSidebar();
}

/** Move a group so it sits where `beforeKey` is (or last, with no key). */
async function placeGroup(key, beforeKey) {
  const keys = groupKeysOnScreen().filter((k) => k !== key);
  const at = beforeKey ? keys.indexOf(beforeKey) : -1;
  keys.splice(at < 0 ? keys.length : at, 0, key);
  await saveGroupOrder(keys);
}

async function nudgeGroup(key, delta) {
  const keys = groupKeysOnScreen();
  const from = keys.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= keys.length) return;
  keys.splice(to, 0, keys.splice(from, 1)[0]);
  await saveGroupOrder(keys);
}

/**
 * How much of the requestable monitor belongs to this cluster, read without
 * pulling the module in until the menu is actually built.
 */
function monitorSummary(profile) {
  const list = state.settings.requestMonitor || [];
  const mine = list.filter((r) => (r.proxy || '') === (profile.proxy || '')
    && (r.home || null) === (profile.homeDir || null));
  return { total: mine.length, missing: mine.filter((r) => r.missingSince).length };
}

function openGroupMenu(x, y, key, title, profile) {
  const keys = groupKeysOnScreen();
  const i = keys.indexOf(key);
  const isSshGroup = key === 'ssh' || key.startsWith('ssh:');
  const clusterKey = profile ? (profile.proxy || profile.cluster || '') : (isSshGroup ? 'ssh' : '');
  const clusterSet = clusterKey ? clusterAgentForward(clusterKey) : undefined;
  const clusterFiles = clusterKey ? clusterOpenFiles(clusterKey) : undefined;
  /*
   * Folders are scoped by the *group* key, not the cluster key above.
   *
   * They are two different things that both sound like "this cluster":
   * `clusterKey` is a proxy address, which is the right scope for a
   * preference that follows an identity (agent forwarding, the file browser)
   * and is shared by every home that reaches the same proxy. A folder is a
   * way of arranging one list on screen, so it belongs to the list — the
   * same key the rows are drawn under, home included. Using the wrong one
   * filed folders under a group nothing renders, and they vanished the
   * moment they were created.
   */
  const folderKey = profile || isSshGroup ? key : '';
  contextMenu(x, y, [
    { heading: true, label: title },
    profile ? {
      label: (() => {
        const mine = state.accessRequests?.get(tpKey(profile)) || [];
        if (!mine.length) return 'Access requests…';
        const { pending, approved } = requestSummary(mine);
        return `Access requests — ${[
          pending ? `${pending} waiting` : '',
          approved ? `${approved} approved` : '',
        ].filter(Boolean).join(', ')}…`;
      })(),
      title: 'Raise one, review what is outstanding, or assume an approval',
      onClick: () => openRequestsDialog(profile),
    } : null,
    /*
     * The other half of access requests, from the cluster it is about:
     * not what is outstanding, but whether what you expect to be able to
     * ask for is still being offered. The count comes along, so the menu
     * says whether anything has gone without the pane being open.
     */
    profile ? {
      label: (() => {
        const n = monitorSummary(profile);
        if (!n.total) return 'Monitor requestable resources…';
        return n.missing
          ? `Requestable monitor — ${n.missing} of ${n.total} missing…`
          : `Requestable monitor — ${n.total} watched…`;
      })(),
      title: 'Confirm on a timer that the resources you expect to be able to request are still offered',
      onClick: async () => {
        const m = await import('./reqmonitor.js');
        await m.openMonitorPane();
        await m.addForProfile(profile);
      },
    } : null,
    profile ? {
      label: showRequestableIn(key) ? 'Hide requestable nodes' : 'Show requestable nodes too',
      icon: '\u2691',
      title: showRequestableIn(key)
        ? 'List only what you can reach on this cluster'
        : 'Also list what this cluster would let you ask for, tagged req — double-click one to request it',
      onClick: () => setShowRequestable(key, !showRequestableIn(key)),
    } : null,
    ...(profile ? clusterMarkMenu(profile) : []),
    profile ? {
      label: 'Decode', icon: '\u2317',
      title: 'SSH certificate (yours, for this cluster), JWT or SPIFFE SVID',
      submenu: decodeMenu({ profile }),
    } : null,
    profile ? {
      label: 'Status (tsh status)…',
      title: 'Roles, logins, expiry and the certificate extensions, as tsh prints them',
      onClick: () => openClusterStatus(profile),
    } : null,
    profile ? {
      label: 'Refresh this cluster',
      title: 'Its nodes, the clusters it trusts and its beams — nothing else',
      onClick: () => refreshProfile(profile),
    } : null,
    isSshGroup ? {
      label: 'New host in this config…', icon: '+',
      title: 'Write a new Host block into ' + (key === 'ssh' ? '~/.ssh/config' : key.slice(4)),
      onClick: () => openAddServerDialog({ configFile: key === 'ssh' ? null : key.slice(4) }),
    } : null,
    isSshGroup ? {
      label: 'Edit this ssh config…', icon: '\u270E',
      title: key === 'ssh' ? '~/.ssh/config' : key.slice(4),
      onClick: () => openSshConfigInEditor(key === 'ssh' ? null : key.slice(4)),
    } : null,
    isSshGroup ? {
      label: 'Re-read the config files', icon: '\u21BB',
      onClick: () => refreshSshConfigs(key),
    } : null,
    isSshGroup ? {
      label: 'SSH config files…', icon: '\u2630',
      title: 'Read hosts from more than one config file',
      onClick: () => openSshConfigDialog(),
    } : null,
    clusterKey ? {
      label: `Agent forwarding: ${clusterSet === null ? `follows the global preference (${state.settings.agentForward ? 'on' : 'off'})` : (clusterSet ? 'on' : 'off')}`,
      title: 'Applies to every host in this group that has no setting of its own',
      submenu: [
        { label: 'On', key: clusterSet === true ? '✓' : '', onClick: () => setAgentForwardForCluster(clusterKey, true) },
        { label: 'Off', key: clusterSet === false ? '✓' : '', onClick: () => setAgentForwardForCluster(clusterKey, false) },
        {
          label: `Follow the global preference (${state.settings.agentForward ? 'on' : 'off'})`,
          key: clusterSet === null ? '✓' : '',
          onClick: () => setAgentForwardForCluster(clusterKey, null),
        },
      ],
    } : null,
    clusterKey ? {
      label: `Opens with the file browser: ${clusterFiles === null ? `follows the global preference (${globalOpenFiles() ? 'yes' : 'no'})` : (clusterFiles ? 'yes' : 'no')}`,
      title: 'Applies to every host in this group that has no setting of its own',
      submenu: [
        { label: 'Open with files', key: clusterFiles === true ? '\u2713' : '', onClick: () => setOpenFilesForCluster(clusterKey, true) },
        { label: 'Do not open with files', key: clusterFiles === false ? '\u2713' : '', onClick: () => setOpenFilesForCluster(clusterKey, false) },
        {
          label: `Follow the global preference (${globalOpenFiles() ? 'yes' : 'no'})`,
          key: clusterFiles === null ? '\u2713' : '',
          onClick: () => setOpenFilesForCluster(clusterKey, null),
        },
      ],
    } : null,
    folderKey ? { sep: true } : null,
    /*
     * The whole group, given a pane.
     *
     * The sidebar column is the wrong shape for a fleet, and the answer is
     * not a bigger sidebar: it is the inventory in the space a terminal
     * would have had, splittable and closable like any other pane.
     */
    folderKey ? {
      label: 'Open this list in a pane', icon: '\u25A6',
      title: 'The hosts of this group, with room: folders on or off, rows or tiles',
      submenu: [
        { label: 'In a new tab', onClick: () => openHostsPaneFor(folderKey) },
        { label: 'Beside this pane', onClick: () => openHostsPaneFor(folderKey, 'row') },
        { label: 'Below this pane', onClick: () => openHostsPaneFor(folderKey, 'col') },
      ],
    } : null,
    /*
     * Folders, at the level they belong to. A group is the scope: a folder
     * holds machines from one cluster or one ssh_config, because that is the
     * list it is drawn in and the list its rule is asked of.
     */
    folderKey ? {
      label: groupHasFolders(folderKey)
        ? `Folders (${allFolders().filter((f) => f.group === folderKey).length})`
        : 'Folders',
      icon: '\u{1F4C2}',
      submenu: [
        {
          label: 'New folder…', icon: '\u{1F4C1}',
          onClick: () => openFolderDialog({ group: folderKey, hosts: hostsInGroup(folderKey) }),
        },
        {
          label: 'Open the folder browser…', icon: '\u229E',
          title: 'The big view: a tree on the left, what is in it on the right',
          onClick: () => openFolderBrowser({ groupKey: folderKey }),
        },
        { sep: true },
        {
          label: showFiledHosts() ? 'Stop listing filed hosts at the top' : 'Also list filed hosts at the top',
          title: 'A host that has been filed is normally listed inside its folder and nowhere else',
          onClick: () => setShowFiledHosts(!showFiledHosts()),
        },
        { sep: true },
        { label: 'Export these folders…', onClick: () => exportFoldersDialog(folderKey) },
        { label: 'Import folders…', onClick: () => importFoldersDialog(folderGroups()) },
      ],
    } : null,
    (profile || isSshGroup) ? { sep: true } : null,
    // A Teleport cluster can be logged in and out of from the list it appears
    // in, rather than only from the Teleport tab.
    ...(profile ? [
      profile.expired
        ? {
            label: 'Log in…', icon: '\u2192',
            /*
             * The saved cluster's own login, not one reconstructed from the
             * certificate that just expired.
             *
             * This used to prefill `user` from the expired profile, which put
             * `--user=` on the command — and on an SSO cluster that is what
             * makes tsh take the local-auth path and prompt for a password
             * instead of opening the browser. The saved record is the login
             * command; where there is none, proxy and home are all that can
             * honestly be said, and tsh picks its own default connector.
             */
            onClick: async () => {
              const tp = await import('./teleportpanel.js');
              const saved = await tp.savedClusterFor(profile);
              if (saved) return tp.loginFromSaved(saved);
              return tp.openLoginDialog({ proxy: profile.proxy, home: profile.homeDir });
            },
          }
        : {
            label: 'Log out of this cluster…', icon: '\u2190',
            onClick: async () => (await import('./teleportpanel.js')).doLogout(profile),
          },
      {
        label: 'Copy login cmd', icon: '\u29C9',
        onClick: () => copyLoginCommand(profile),
      },
      {
        // TELEPORT_TOOLS_VERSION and the like, for this cluster's tsh alone.
        label: 'tsh environment for this cluster\u2026', icon: '$',
        onClick: async () => (await import('./tshenv.js')).editClusterEnv(profile),
      },
      profile.expired ? null : {
        label: 'Active sessions\u2026', icon: '\u21C4',
        title: 'Who is in what right now \u2014 and watch, join or moderate the SSH and Kubernetes ones',
        onClick: async () => (await import('./livesessions.js')).openActiveSessions({
          proxy: profile.proxy, home: profile.homeDir || null, subtitle: profile.cluster || profile.proxy,
        }),
      },
      /*
       * Which profile tsh itself treats as active — the one a plain `tsh`
       * command, and anything else on this machine that shells out to one,
       * will use. With two clusters logged in that is often not the cluster
       * you are looking at, and it could only be changed by logging in again
       * from somewhere else.
       */
      profile.expired ? null : {
        label: profile.active ? 'Active profile' : 'Make this the active profile',
        icon: '\u25C9',
        key: profile.active ? '✓' : '',
        disabled: !!profile.active,
        title: profile.active
          ? 'Plain tsh commands already use this cluster'
          : 'Runs this cluster’s login again, which is what makes it the active one. '
            + 'No re-authentication while the certificate is still valid.',
        onClick: async () => (await import('./teleportpanel.js')).makeProfileActive(profile),
      },
      ...vnetMenuItems(profile),
      // Root and leaves, so the heading's own menu can move the login between
      // them without a trip to the Teleport tab. A submenu for a handful, a
      // searchable dialog for an estate's worth — teleportpanel decides which.
      clusterSwitchMenuItem(profile),
      /*
       * Beams live in their own group, so this is where you say whether the
       * cluster has any. The probe answers it on its own; the override is for
       * a cluster that could not be asked.
       */
      {
        label: beamsSupported(profile.proxy)
          ? (markedAsBeams(profile.proxy) ? 'Stop marking this as a beams cluster' : 'Beams: listed')
          : 'Mark this as a beams cluster',
        title: beamsSupported(profile.proxy)
          ? 'Beams from this cluster are listed in their own group'
          : 'The cluster did not answer tsh beams ls — list them anyway',
        disabled: beamsSupported(profile.proxy) && !markedAsBeams(profile.proxy),
        onClick: () => setMarkedAsBeams(profile.proxy, !markedAsBeams(profile.proxy)),
      },
      (state.settings.hiddenBeamProxies || []).includes(profile.proxy)
        ? { label: 'Show beams for this cluster', onClick: () => showBeamsFor(profile.proxy) }
        : null,
      beamsSupported(profile.proxy) ? {
        label: 'Start a beam…', icon: '\u2197',
        onClick: () => addBeam(profile),
      } : null,
      beamsSupported(profile.proxy) ? {
        label: 'Refresh the beam list', icon: '\u21BB',
        onClick: () => refreshBeams({ refresh: true }),
      } : null,
      beamsSupported(profile.proxy) && !(state.settings.hiddenBeamProxies || []).includes(profile.proxy)
        ? { label: 'Hide beams for this cluster', onClick: () => hideBeamsFor(profile.proxy) }
        : null,
      // What every other ssh tool needs from this cluster, offered where the
      // cluster is named rather than only in the Teleport tab.
      {
        label: 'Add to ~/.ssh/config…',
        title: 'tsh config for this cluster, so ssh, scp, rsync and Ansible reach its nodes',
        onClick: () => openTshConfigDialog(profile),
      },
      // Same action as the Teleport tab's button, on the heading that names the
      // cluster — which is where you are when you notice you need the browser.
      {
        label: 'Open in web UI',
        onClick: async () => (await import('./teleportpanel.js')).openClusterWeb({
          proxy: profile.proxy, cluster: profile.cluster,
        }),
      },
      { sep: true },
    ] : []),
    {
      label: `Starred hosts: ${starredMode() === 'group' ? 'in their own group' : 'at the top of their group'}`,
      submenu: [
        {
          label: 'At the top of their own group',
          key: starredMode() === 'inline' ? '✓' : '',
          onClick: () => setStarredMode('inline'),
        },
        {
          label: 'Gathered in a Starred group',
          key: starredMode() === 'group' ? '✓' : '',
          onClick: () => setStarredMode('group'),
        },
      ],
    },
    (state.settings.hostOrder || {})[key] ? {
      label: 'Reset the host order in this group',
      title: 'Back to starred first, then the natural order',
      onClick: () => saveHostOrder(key, []),
    } : null,
    { sep: true },
    { label: 'Move up', disabled: i <= 0, onClick: () => nudgeGroup(key, -1) },
    { label: 'Move down', disabled: i < 0 || i >= keys.length - 1, onClick: () => nudgeGroup(key, 1) },
    { label: 'Move to top', disabled: i <= 0, onClick: () => placeGroup(key, keys.find((k) => k !== key)) },
    { label: 'Move to bottom', disabled: i < 0 || i >= keys.length - 1, onClick: () => placeGroup(key, null) },
    { sep: true },
    {
      label: 'Reset order',
      disabled: !(state.settings.hostGroupOrder || []).length,
      onClick: () => saveGroupOrder([]),
    },
  ].filter(Boolean));
}

let dragKey = null;

/** Drag a group by its heading to put it somewhere else in the list. */
function wireGroupDrag(g, head, key) {
  head.addEventListener('dragstart', (e) => {
    dragKey = key;
    g.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox and Chromium both want *something* set, or no drag begins.
    try { e.dataTransfer.setData('text/plain', key); } catch { /* a drag without a payload still moves the row */ }
  });
  head.addEventListener('dragend', () => {
    dragKey = null;
    g.classList.remove('dragging');
    for (const n of document.querySelectorAll('.sb-group.drop-before, .sb-group.drop-after')) {
      n.classList.remove('drop-before', 'drop-after');
    }
  });
  g.addEventListener('dragover', (e) => {
    if (!dragKey || dragKey === key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = g.getBoundingClientRect();
    const above = e.clientY < r.top + r.height / 2;
    g.classList.toggle('drop-before', above);
    g.classList.toggle('drop-after', !above);
  });
  g.addEventListener('dragleave', (e) => {
    if (g.contains(e.relatedTarget)) return;
    g.classList.remove('drop-before', 'drop-after');
  });
  g.addEventListener('drop', (e) => {
    if (!dragKey || dragKey === key) return;
    e.preventDefault();
    e.stopPropagation();
    const r = g.getBoundingClientRect();
    const above = e.clientY < r.top + r.height / 2;
    const moved = dragKey;
    dragKey = null;
    if (above) placeGroup(moved, key);
    else {
      const keys = groupKeysOnScreen().filter((k) => k !== moved);
      const after = keys[keys.indexOf(key) + 1] || null;
      placeGroup(moved, after);
    }
  });
}

/**
 * A cluster read from a second tsh home is its own group: the same cluster can
 * appear twice under two identities, and they are not the same thing.
 */
// The one in folders.js, so nodewatch and the disappearance watch can use
// the same key without importing this module.
export { groupKeyFor };

/**
 * Put the `tsh login` for a profile on the clipboard, with TELEPORT_HOME in
 * front of it when the profile does not live in the default home — the command
 * without it would write the certificate somewhere nothing reads.
 */
export async function copyLoginCommand(p, extra = {}) {
  try {
    /*
     * The saved cluster's details, for the same reason the buttons use them:
     * a command with `--user=` on the front of it is a local-auth command,
     * and pasting that at an SSO cluster asks for a password nobody has. The
     * profile's username is only used when nothing was saved *and* the caller
     * did not name one.
     */
    const { savedClusterFor } = await import('./teleportpanel.js');
    const saved = await savedClusterFor(p);
    const cmd = await window.api.teleport.loginCommand({
      proxy: p.proxy,
      cluster: p.cluster || saved?.cluster || undefined,
      user: saved?.user || undefined,
      authConnector: saved?.authConnector || undefined,
      ttl: saved?.ttl || undefined,
      mfaMode: saved?.mfaMode || undefined,
      home: p.homeDir || p.home || undefined,
      ...extra,
    });
    window.api.clipboard.write(cmd);
    status('Copied: ' + cmd, 8000);
    return cmd;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

/** The short name a home is known by, as the node ids use it. */
function homeLabel(home) {
  const p = state.teleportProfiles.find((x) => x.homeDir === home || x.home === home);
  return p?.homeName || home;
}

/** The badge that says which tsh home a cluster came from. */
function homeTag(p) {
  if (!p.homeName) return null;
  return el('span', {
    class: 'tag', title: `From TELEPORT_HOME=${p.homeDir}${p.username ? ' · as ' + p.username : ''}`,
    text: p.homeName,
  });
}

function connectionStateFor(hostId) {
  for (const c of state.connections.values()) {
    if (c.hostId === hostId) return c.state;
  }
  return null;
}

/** host.id -> the last probe result, or 'loading' while one is in flight. */
const teleportPresenceCache = new Map();
// Kept in step with the sessions' own re-checks (sessions.js checkTeleportPresence),
// so a host that has had Teleport installed since loses its "Add to Teleport" tag.
state.on('teleportPresence', ({ hostId, presence } = {}) => {
  if (!hostId || !presence) return;
  teleportPresenceCache.set(hostId, presence);
  renderSidebar();
});

/**
 * "Teleport detected" — a direct (non-Teleport) SSH host that already runs
 * a Teleport agent is a candidate to bring under Teleport properly, not
 * just a fact to note. Probed once per connection, lazily, the first time a
 * connected row like this renders; `detectTeleportOnSsh` turns the whole
 * thing off, probe included, so a host nobody asked about is never touched.
 */
function teleportPresenceBadge(host, connState) {
  if (host.type === 'teleport' || state.settings.detectTeleportOnSsh === false) return null;
  if (connState !== 'connected') return null;
  // The session may already have asked (sessions.js checkTeleportPresence).
  if (teleportPresenceCache.get(host.id) === undefined && state.teleportPresence?.get(host.id)) {
    teleportPresenceCache.set(host.id, state.teleportPresence.get(host.id));
  }
  const cached = teleportPresenceCache.get(host.id);
  if (cached === undefined) {
    teleportPresenceCache.set(host.id, 'loading');
    const conn = [...state.connections.values()].find((c) => c.hostId === host.id && c.state === 'connected');
    if (conn) {
      window.api.conn.teleportPresence(conn.id)
        .then((r) => {
          teleportPresenceCache.set(host.id, r);
          // Shared with the panes: a session on a host without Teleport shows
          // a Teleport button in its own header (sessions.js).
          if (!state.teleportPresence) state.teleportPresence = new Map();
          state.teleportPresence.set(host.id, r);
          state.emit('teleportPresence', { hostId: host.id, presence: r });
          if (r && !r.installed) offerTeleportInstall(host);
          renderSidebar();
        })
        .catch(() => teleportPresenceCache.set(host.id, null));
    }
    return null;
  }
  if (!cached || cached === 'loading') return null;
  /*
   * No Teleport on it at all: the offer to put it behind Teleport, where it
   * can be seen. It used to be only a right-click menu item, so a connected
   * host with nothing installed looked exactly like one that had never been
   * checked.
   */
  if (!cached.installed) {
    return el('span', {
      class: 'tag teleport-offer', style: 'cursor:pointer',
      title: `${host.name || host.alias} has no Teleport agent.\n`
        + 'Click to enroll it in a Teleport cluster — a join token and the commands to run.\n'
        + 'Turn this check off in Settings → detectTeleportOnSsh.',
      text: '⚡ Add to Teleport',
      onClick: (e) => { e.stopPropagation(); e.preventDefault(); openInstallTeleportOnHostWizard(host); },
    });
  }
  if (!cached.running) return null;
  return el('span', {
    class: 'tag teleport-detected',
    title: `${host.name || host.alias} is already running a Teleport agent.\n`
      + 'This box could be reached through Teleport instead of a direct SSH connection.\n'
      + 'Turn this check off in Settings → detectTeleportOnSsh.',
    text: '⚡ Teleport detected',
  });
}

/*
 * The offer, said once per host per run, where it cannot be missed: a tag at
 * the end of a sidebar row is cut off as soon as the row has a long name or
 * a few labels, which is where the offer used to be the only sign.
 */
const teleportOffered = new Set();
function offerTeleportInstall(host) {
  if (teleportOffered.has(host.id)) return;
  teleportOffered.add(host.id);
  const root = document.getElementById('toast-root');
  if (!root) return;
  const name = host.name || host.alias;
  const node = el('div', { class: 'toast info teleport-offer-toast' },
    el('div', { text: `${name} has no Teleport agent.` }),
    el('div', { style: 'display:flex;gap:6px;margin-top:6px;justify-content:flex-end' },
      el('button', { class: 'ghost-btn sm', text: 'Not now', onClick: () => node.remove() }),
      el('button', {
        class: 'primary-btn', style: 'padding:3px 10px', text: 'Add to Teleport…',
        onClick: () => { node.remove(); openInstallTeleportOnHostWizard(host); },
      })));
  root.append(node);
  // Long enough to read and act on; the sidebar tag and the menu item stay.
  setTimeout(() => node.remove(), 20000);
}

/**
 * "Install Teleport on this host" — for a direct SSH host the probe found
 * without Teleport. The commands come from teleport.js's
 * nodeInstallCommand(): the chosen cluster's own install.sh (its exact
 * version, through teleport-update), then `teleport node configure` with the
 * node name and labels, then the service started — shown live with a
 * placeholder token before any token exists. "Copy command" makes a real
 * join token, on the cluster picked and checked to be that one; "Run in this
 * session" types the commands into the host's own terminal, so sudo can ask
 * for its password there rather than only working with passwordless sudo.
 */
async function openInstallTeleportOnHostWizard(host) {
  const profiles = (state.teleportProfiles || []).filter((p) => !p.expired);
  if (!profiles.length) return toast('Log into a Teleport cluster first — that is what this host would join.', 'error');
  const conn = [...state.connections.values()].find((c) => c.hostId === host.id && c.state === 'connected');

  const profileSel = select(
    profiles.map((p) => ({ value: p.proxy, label: `${p.cluster || p.proxy} (${p.proxy})` })),
    profiles[0].proxy,
  );
  const nameIn = textInput({ value: host.alias || host.hostname || host.name || '', placeholder: 'node name (defaults to its hostname)' });
  const labelsIn = el('textarea', {
    rows: 3, spellcheck: 'false', placeholder: 'env=lab\nteam=se',
    style: 'width:100%;font-family:var(--mono);font-size:12px;resize:vertical',
  });
  const cmdBox = el('pre', {
    style: 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-all;user-select:text;'
      + 'max-height:180px;overflow:auto;margin:4px 0 0;background:var(--panel-2);border:1px solid var(--border);'
      + 'border-radius:var(--radius);padding:8px 10px;color:var(--text)',
  });
  const note = el('div', { class: 'hint', style: 'min-height:1.2em;white-space:pre-wrap' });
  const labels = () => Object.fromEntries(labelsIn.value.split(/[\n,]/).map((l) => l.trim()).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]).filter(([k]) => k));
  const profile = () => profiles.find((p) => p.proxy === profileSel.value);
  let token = null; // { value, proxy } — made once per cluster in this dialog
  const commandFor = async (tok) => window.api.teleport.nodeInstallCommand({
    proxy: profileSel.value, token: tok, labels: labels(), nodeName: nameIn.value.trim(),
  });
  const paint = async () => {
    const r = await commandFor(token && token.proxy === profileSel.value ? token.value : null);
    cmdBox.textContent = r.ok ? r.command : r.error;
    cmdBox.style.color = r.ok ? 'var(--text)' : 'var(--red)';
  };
  const mint = async () => {
    if (token && token.proxy === profileSel.value) return token;
    note.textContent = 'Making a join token…';
    const r = await window.api.teleport.createJoinToken({ type: 'node', ttl: '1h', proxy: profileSel.value, cluster: profile()?.cluster });
    if (!r.ok) { note.textContent = `Could not make a join token: ${r.error}`; return null; }
    token = { value: r.token, proxy: profileSel.value };
    note.textContent = `Join token made on ${r.cluster || profile()?.cluster}, valid 1 hour.`;
    await paint();
    return token;
  };
  for (const n of [nameIn, labelsIn]) n.addEventListener('input', paint);
  profileSel.addEventListener('change', paint);
  paint();

  await modal({
    title: `Install Teleport on ${host.name || host.alias}`,
    width: 'min(700px, 94vw)',
    render: (body) => {
      body.append(
        el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:10px', text:
          'Installs the cluster’s own Teleport version with its install.sh (managed updates included), configures it as an '
          + 'SSH node with the name and labels below, and starts it. Needs root on a Linux host with systemd.' }),
        field('Join this Teleport cluster', profileSel),
        field('Node name', nameIn, 'How it appears in tsh ls and the Web UI'),
        field('Labels', labelsIn, 'key=value, one per line — what roles and search match on'),
        el('div', { style: 'font-size:12px;font-weight:600;margin-top:10px', text: 'What will run' }),
        cmdBox,
        note,
      );
    },
    buttons: [
      { label: 'Close', value: null },
      {
        label: 'Copy command',
        onClick: async () => {
          const t = await mint();
          if (!t) return;
          const r = await commandFor(t.value);
          if (!r.ok) return toast(r.error, 'error');
          await window.api.clipboard.write(r.command);
          toast('Commands copied, with a join token valid for 1 hour');
        },
      },
      {
        label: 'Run in this session', class: 'primary-btn',
        title: 'Types the commands into the host’s own terminal, so sudo can ask for a password there',
        onClick: async ({ close }) => {
          const pane = conn && [...state.panes.values()].find((x) => x.connId === conn.id && x.termId);
          if (!pane) return toast(`Open a terminal on ${host.name || host.alias} first`, 'error');
          const t = await mint();
          if (!t) return;
          const r = await commandFor(t.value);
          if (!r.ok) return toast(r.error, 'error');
          const { sendToPane, watchTeleportInstall } = await import('./sessions.js');
          sendToPane(pane, r.oneLine + '\n');
          // The ⚡ clears itself once the install has landed.
          watchTeleportInstall(conn.id);
          state.setActivePane?.(pane.id);
          teleportPresenceCache.delete(host.id);
          state.teleportPresence?.delete?.(host.id);
          toast(`Running in ${host.name || host.alias}'s terminal — answer sudo's password prompt there`);
          close(true);
        },
      },
    ],
  });
}

/*
 * The host behind a connection, for a session opened some other way than a
 * sidebar row — a saved profile's host is not in the list under its own id —
 * built from the connection itself, which is all the wizard needs.
 */
function hostForConnection(hostId, label) {
  const known = drawnHosts.get(hostId) || hostById(hostId);
  if (known) return known;
  const conn = [...state.connections.values()].find((c) => c.hostId === hostId);
  const name = String(label || conn?.label || hostId).replace(/\s+\([^)]*\)$/, '');
  return { id: hostId, type: 'ssh', name, alias: name };
}

/** For the pane header's Teleport button: the host behind a connection, then the wizard. */
export function openInstallTeleportForHostId(hostId, label) {
  return openInstallTeleportOnHostWizard(hostForConnection(hostId, label));
}

/** The one-time notice, for a connection the session itself checked. */
export function offerTeleportInstallFor(hostId, label, { again = false } = {}) {
  // Teleport was there and has gone: say so again, even if the first notice was dismissed.
  if (again) teleportOffered.delete(hostId);
  offerTeleportInstall(hostForConnection(hostId, label));
}

/**
 * The beams belonging to a cluster, as rows inside that cluster's group.
 *
 * With the cluster rather than beside it: a beam is something running on that
 * cluster, and the question "what have I got on red-fire" has one answer, not
 * two lists. Marked off with its own heading, though — a beam is not a node,
 * it expires on its own, and the row offers to delete it, none of which is
 * true of the servers above it.
 */
function beamSection(p) {
  if (!beamsSupported(p.proxy)) return [];
  const all = beamsFor(p.proxy);
  const list = filterText
    ? all.filter((b) => JSON.stringify(b).toLowerCase().includes(filterText.toLowerCase()))
    : all;
  // A filter that nothing matched hides the section rather than showing an
  // empty one below a filtered node list.
  if (filterText && !list.length) return [];

  /*
   * Beams | Phases, as tabs, where this tsh can do Phases — the running
   * sandboxes and the saved images they start from, side by side. Without
   * Phase support the heading is the plain "beams" it always was.
   */
  const tab = beamTabFor(p.proxy);
  const phaseList = phaseListFor(p.proxy);
  // Whether the Failed tab shows at all depends on there being any, so the
  // list is read once up front rather than only when that tab is clicked.
  if (phasesSupported(p.proxy) && !failedListFor(p.proxy)) refreshFailedPhases(p);
  const tabButton = (id, label, n) => el('button', {
    class: 'beam-tab' + (tab === id ? ' active' : ''),
    onClick: (e) => { e.stopPropagation(); setBeamTab(p, id); },
  }, el('span', { text: label }), el('span', { class: 'sb-subhead-n', text: n ? String(n) : '' }));
  const rows = [phasesSupported(p.proxy)
    ? el('div', { class: 'sb-subhead beam-tabs' },
        tabButton('beams', 'beams', all.length),
        tabButton('phases', 'phases', phaseList?.phases?.length),
        // Builds that failed, and the snapshots they left: tsh phase ls-failed.
        // Only when there are any (or while it is the tab being looked at,
        // so emptying it does not pull the floor out) — an always-there
        // "failed 0" reads as a warning about nothing.
        (failedListFor(p.proxy)?.failed?.length || tab === 'failed')
          ? tabButton('failed', 'failed', failedListFor(p.proxy)?.failed?.length)
          : null,
        tab !== 'beams'
          ? el('button', {
              class: 'beam-tab-refresh',
              title: tab === 'failed' ? 'Read the failed builds again (tsh phase ls-failed)' : 'Read the Phases again (tsh phase ls)',
              text: '\u27F3',
              onClick: (e) => { e.stopPropagation(); (tab === 'failed' ? refreshFailedPhases : refreshPhases)(p); },
            })
          : null)
    : el('div', { class: 'sb-subhead' },
        el('span', { text: 'beams' }),
        el('span', { class: 'sb-subhead-n', text: all.length ? String(all.length) : '' }))];
  if (tab === 'phases') return [...rows, ...phaseRows(p, phaseList)];
  if (tab === 'failed') return [...rows, ...failedRows(p, failedListFor(p.proxy))];
  for (const b of list) rows.push(beamRow(b));
  rows.push(el('div', {
    class: 'sb-item beam-add',
    title: 'Start a new sandbox VM on this cluster',
    onClick: () => addBeam(p),
  },
    el('span', { class: 'st', style: 'background:var(--accent)' }),
    el('span', { class: 'name', text: list.length ? '+  Start a beam…' : '+  Start the first beam…' })));
  return rows;
}

/** The failed tab: `tsh phase ls-failed`, one row per failed snapshot. */
function failedRows(p, info) {
  const note = (text) => el('div', { class: 'sb-empty', style: 'padding-left:20px', text });
  if (!info || (info.loading && !info.failed?.length)) return [note('Reading failed builds (tsh phase ls-failed)\u2026')];
  if (!info.ok) return [note(info.error || 'Could not read the failed builds')];
  if (!info.failed.length) return [note('No failed builds.')];
  return info.failed.map((f) => {
    const row = el('div', {
      class: 'sb-item phase-row failed-row',
      title: [
        `${f.phase} \u2014 a build that failed`,
        f.digest ? 'snapshot: ' + f.digest : '',
        f.at ? 'observed: ' + new Date(f.at).toLocaleString() : '',
        f.expires ? 'kept until about: ' + new Date(f.expires).toLocaleString() : '',
      ].filter(Boolean).join('\n'),
    },
      el('span', { class: 'st error' }),
      el('span', { class: 'name', text: f.phase }),
      f.digest ? el('span', { class: 'tag gone', text: f.digest.replace(/^sha256:/, '').slice(0, 10) }) : null,
      f.at ? el('span', { class: 'tag', text: goneFor(f.at) + ' ago' }) : null);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      failedMenu(e.clientX, e.clientY, p, f);
    });
    return row;
  });
}

/** The group Phase folders live in — its own namespace, not a host's: a Phase folder and a host folder share the mechanism and nothing else. */
function phaseGroupKeyFor(p) { return 'phase:' + p.proxy + (p.home ? '@' + p.home : ''); }

/**
 * One Phase row — host-shaped only enough to be filed (see phaseRows
 * below): foldersIn/hostsInFolder/folderMenuFor neither know nor need to
 * know a Phase from an SSH host, the same reason that was already true
 * for a kube cluster.
 */
function phaseRow(host, groupKey, opts = {}) {
  const { ph, profile: p } = host;
  const ready = ph.state === 'ready';
  const failed = /fail|error/i.test(ph.state || '');
  const row = el('div', {
    class: 'sb-item phase-row' + (opts.folder ? ' in-folder' : ''),
    style: opts.depth ? `--depth:${opts.depth}` : null,
    title: [
      ph.name,
      ph.parent ? 'from: ' + ph.parent : '',
      ph.state ? 'state: ' + ph.state : '',
      ph.region ? 'region: ' + ph.region : '',
      ph.digest ? 'snapshot: ' + ph.digest : '',
      ph.publishedAt ? 'saved: ' + new Date(ph.publishedAt).toLocaleString() : '',
      ph.owner ? 'owner: ' + ph.owner : '',
      ph.lastError ? '\n' + ph.lastError : '',
      ready ? '\nDouble-click to start a beam from it' : '',
    ].filter(Boolean).join('\n'),
  },
    el('span', { class: 'st ' + (ready ? 'connected' : failed ? 'error' : 'connecting') }),
    el('span', { class: 'name', text: ph.name }),
    el('span', { class: 'tag' + (ready ? '' : failed ? ' gone' : ' stale'), text: ph.state || '?' }),
    ph.parent ? el('span', { class: 'tag', text: ph.parent }) : null,
    ph.publishedAt ? el('span', { class: 'tag', text: goneFor(ph.publishedAt) + ' ago' }) : null);
  row.addEventListener('dblclick', () => { if (ready) addBeam(p, { phase: ph.name }); });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    phaseMenu(e.clientX, e.clientY, p, ph, groupKey);
  });
  // Minimal drag — just enough for a folderRow's own drop target
  // (wireFolderDnD) to catch it, the same dragHost it already reads for
  // dropping an SSH host; no reordering, which nothing here asked for.
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragHost = { id: host.id, groupKey, host };
    dragFolder = null;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', host.id); } catch { /* fine without a payload */ }
  });
  row.addEventListener('dragend', () => { dragHost = null; row.classList.remove('dragging'); clearDropMarks(); });
  return row;
}

/** The Phases tab: `tsh phase ls`, in its own folders, and a way to make another of either. */
function phaseRows(p, info) {
  const note = (text) => el('div', { class: 'sb-empty', style: 'padding-left:20px', text });
  // Last in the tab whatever else it shows, as "+ Start a beam…" is on the other.
  const addRow = (first) => el('div', {
    class: 'sb-item beam-add phase-add',
    title: 'tsh phase add: a build console on a build beam, from the default image, on top of a Phase, or forked from one',
    onClick: () => newPhase(p),
  },
    el('span', { class: 'st', style: 'background:var(--accent)' }),
    el('span', { class: 'name', text: first ? '+  Build the first Phase\u2026' : '+  New Phase\u2026' }));
  // The other way to make one: tools, services and files put together as stages (tsh phase apply).
  const setupRow = () => el('div', {
    class: 'sb-item beam-add phase-add',
    title: 'Pick setups — Go, Postgres, the AWS CLI, your dotfiles, a repo to clone — into a phase.yaml, and build it with tsh phase apply',
    onClick: async () => (await import('./phasebuilder.js')).openPhaseBuilder(p),
  },
    el('span', { class: 'st', style: 'background:var(--accent)' }),
    el('span', { class: 'name', text: '+  From setups\u2026' }));
  if (!info || (info.loading && !info.phases?.length)) return [note('Reading Phases (tsh phase ls)\u2026')];
  if (!info.ok) return [note(info.error || 'Could not read the Phases'), addRow(true), setupRow()];
  const all = info.phases || [];
  const list = filterText
    ? all.filter((x) => JSON.stringify(x).toLowerCase().includes(filterText.toLowerCase()))
    : all;
  if (!all.length) return [note('No Phases yet.'), addRow(true), setupRow()];
  if (!list.length) return [note('No Phase matches the filter.')];

  const groupKey = phaseGroupKeyFor(p);
  const hosts = list.map((ph) => ({ kind: 'phase', id: `phase:${p.proxy}:${ph.name}`, name: ph.name, labels: {}, ph, profile: p }));

  const addFolderRow = el('div', {
    class: 'sb-item beam-add phase-add',
    style: 'flex:1;min-width:0',
    title: 'A place to drag Phases into, or file one into from its own menu',
    onClick: () => openFolderDialog({ group: groupKey, hosts }),
  },
    el('span', { class: 'st', style: 'background:var(--muted)' }),
    el('span', { class: 'name', text: '+  New Folder…' }));

  const rows = [];
  const walk = (parent, depth) => {
    for (const f of foldersIn(groupKey, parent)) {
      const deep = hostsInTree(f, hosts);
      rows.push(folderRow(f, deep.length, depth, groupKey));
      if (foldersShut.has(f.id)) continue;
      walk(f.id, depth + 1);
      for (const h of hostsInFolder(f, hosts)) rows.push(phaseRow(h, groupKey, { depth: depth + 1, folder: f }));
    }
  };
  walk(null, 0);
  for (const h of hosts.filter((x) => !isFiled(x, groupKey))) rows.push(phaseRow(h, groupKey));
  const lastPhaseRow = addRow(false);
  lastPhaseRow.style.flex = '1';
  lastPhaseRow.style.minWidth = '0';
  const lastSetupRow = setupRow();
  lastSetupRow.style.flex = '1';
  lastSetupRow.style.minWidth = '0';
  rows.push(el('div', { style: 'display:flex;gap:6px' }, addFolderRow, lastPhaseRow, lastSetupRow));
  return rows;
}

/**
 * One beam in the list.
 *
 * What a beam has instead of labels and logins: a region, and a clock. The
 * expiry is the fact that changes the decision — whether to bother copying
 * anything off it — so it sits on the row rather than in a tooltip.
 */
function beamRow(beam) {
  const conn = [...state.connections.values()].find((c) => c.hostId === `beam:${beam.proxy}:${beam.id}`);
  const live = conn && ['connected', 'connecting', 'prompting'].includes(conn.state);
  const left = beam.expires ? beam.expires - Date.now() : 0;
  const soon = left > 0 && left < 60 * 60 * 1000;

  const row = el('div', {
    class: 'sb-item' + (live ? ' active' : ''),
    title: [
      beam.id,
      beam.region ? 'region: ' + beam.region : '',
      beam.requestedRegion ? `(asked for ${beam.requestedRegion})` : '',
      beam.owner ? 'owner: ' + beam.owner : '',
      beam.uuid,
      expiresIn(beam),
    ].filter(Boolean).join('\n'),
  },
    el('span', { class: 'st ' + (left <= 0 ? 'error' : 'connected') }),
    el('span', { class: 'name', text: beam.id }),
    // Unmistakable among the cluster's nodes, which is the point of keeping
    // them in the same group.
    el('span', { class: 'tag beams', text: 'beam' }),
    // Which image it runs, at a glance; the menu has the Phase's history.
    beam.phase ? el('span', { class: 'tag', title: 'Started from Phase ' + beam.phase, text: beam.phase.split('@')[0] }) : null,
    beam.region ? el('span', { class: 'tag', text: beam.region }) : null,
    el('span', {
      class: 'tag' + (soon ? ' mfa' : ''),
      title: beam.expires ? new Date(beam.expires).toLocaleString() : '',
      text: expiresIn(beam) || 'no expiry',
    }));

  row.addEventListener('dblclick', () => openBeam(beam));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    beamMenu(e.clientX, e.clientY, beam);
  });
  return row;
}

/**
 * The line at the top of a cluster narrowed by an assumed resource request,
 * saying why most of it is dimmed, with the way back.
 */
function narrowedNote(p, granted) {
  if (!isNarrowed(p)) return null;
  const ids = [...(p.activeRequests || [])];
  return el('div', { class: 'sb-narrowed', title: (p.allowedResources || []).join('\n') },
    el('span', {
      text: `Request assumed — this login reaches only ${granted} of the cluster's resources.`,
    }),
    ids.length ? el('button', {
      class: 'ghost-btn sm', text: 'Drop request',
      title: 'Go back to your standing access, and the whole cluster',
      onClick: async (e) => {
        e.stopPropagation();
        status('Dropping the request…', 0);
        const r = await window.api.teleport.requestDrop(ids, { proxy: p.proxy, home: p.homeDir }).catch((err) => ({ ok: false, output: err.message }));
        status('');
        if (r?.ok === false) return toast('Could not drop it: ' + (r.output || r.error || 'tsh failed'), 'error');
        toast('Request dropped', 'success');
        refreshInventory();
        return undefined;
      },
    }) : null);
}

function heldLine(host) {
  const n = (host.heldBy || []).length;
  return `${host.name} is out of reach while ${n === 1 ? 'an access request is' : n + ' access requests are'} assumed.\n`
    + 'Assuming a request for particular resources limits this login to just those; '
    + 'this node is still on the cluster.\nDrop the request to use it again.';
}

/**
 * A kube cluster with no standing access at all — not even "available" —
 * drawn the same way an SSH node in the same state already is: a bare name
 * and a `req` tag, double-click to start a request. Minimal on purpose,
 * unlike kubeContextRow's own row: there is nothing to browse or exec into
 * on a cluster that cannot be reached yet.
 */
function kubeRequestableRow(host, groupKey, opts = {}, watched = false) {
  const row = el('div', {
    class: 'sb-item' + (opts.folder ? ' in-folder' : ''),
    style: opts.depth ? `--depth:${opts.depth}` : null,
    dataset: { host: host.id },
    title: `${host.name}\nNot yet accessible on this cluster — double-click to start a request.`,
  },
    el('span', { class: 'st' }),
    watched ? el('span', { class: 'hwatch', text: '\u{1F514}', title: 'Watched — you will be told if this cluster leaves the inventory' }) : null,
    el('span', { class: 'name', text: host.name }),
    kubeIcon(),
    labelSummary(host) ? el('span', { class: 'tag', text: labelSummary(host) }) : null,
    el('span', { class: 'tag req', text: 'req' }));
  row.addEventListener('dblclick', () => requestKubeAccessFor(host));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [
      { label: host.name, heading: true },
      { label: 'Request access to it…', icon: '⚑', onClick: () => requestKubeAccessFor(host) },
      { label: 'Request a namespace or pod…', icon: '⚑', onClick: () => requestKubeResourceAccessFor(host) },
      { sep: true },
      {
        label: isWatched(host) ? 'Stop watching this cluster' : 'Watch this cluster', icon: '\u{1F514}',
        onClick: () => toggleWatch(host, groupKey),
      },
    ];
    // Already a complete menu item (its own label, its own submenu) — see
    // folderMenuFor's own return shape — not a bare list to wrap again.
    const folderItem = folderMenuFor(host, { groupKey });
    if (folderItem) items.push({ sep: true }, folderItem);
    contextMenu(e.clientX, e.clientY, items);
  });
  return row;
}

export async function requestKubeAccessFor(host) {
  const p = host.profile;
  if (!p) return toast('Log in to that cluster first', 'error');
  const { requestAccessTo } = await import('./teleportpanel.js');
  const r = host.requestableInfo || {};
  await requestAccessTo(p, {
    id: r.resourceId, kind: 'kube_cluster', name: host.name, uuid: r.uuid || host.name,
    cluster: r.cluster || p.cluster, labels: host.labels || {},
  });
}

/**
 * The narrower version of the above — a namespace or a pod inside this
 * cluster, not the whole thing. Works the same whether the cluster itself
 * is still only requestable (nothing granted yet) or already open: either
 * way the search needs to know which cluster, which the picker cannot
 * guess on its own.
 */
export async function requestKubeResourceAccessFor(host) {
  const p = host.profile;
  if (!p) return toast('Log in to that cluster first', 'error');
  const r = host.requestableInfo || {};
  const { pickRequestResources } = await import('./requestpicker.js');
  const picked = await pickRequestResources(p, [], {
    title: `Request a namespace or pod in ${host.name}…`,
    subtitle: host.name,
    initialKind: 'kube_resource',
    initialKubeCluster: r.uuid || host.name,
  });
  if (!picked || !picked.length) return;
  const { requestAccessToMany } = await import('./teleportpanel.js');
  await requestAccessToMany(p, picked);
}

/**
 * Dispatch for a kube cluster's row — host-shaped only for the folder,
 * filter and request machinery, never for its own look: a logged-in
 * context keeps its full tree (kubeContextRow), an available-but-not-
 * logged-in one keeps its "click to tsh kube login" row, and a
 * requestable one gets the minimal row just above.
 */
function kubeClusterHostRow(host, groupKey, opts = {}) {
  drawnHosts.set(host.id, host);
  // Both generic, host-shaped concerns that apply whichever of the three
  // row kinds below this turns out to be — same reason folders and the
  // filter box already just work on these rows without a kube-specific
  // branch anywhere in folders.js or tags.js.
  const watched = showWatchMark() && isWatched(host);
  const rowOpts = { depth: opts.depth, folder: opts.folder, groupKey, watched };
  /*
   * A watched cluster that has gone, or whose cluster cannot be read right
   * now, is drawn from its watch record like any other ghost — the gone or
   * not-confirmed tag, its menu — with the ☸ hostRow gives a kube one.
   */
  if (host.missing || host.unconfirmed) return hostRow(host, labelSummary(host), groupKey, opts);   // hostRow draws it, not back here
  let node;
  if (host.requestable) node = kubeRequestableRow(host, groupKey, opts, watched);
  else if (host.kubeContext) node = kubeContextRow(host.kubeContext, rowOpts);
  else if (host.availableCluster) node = availableClusterRow(host.profile, host.availableCluster, rowOpts);
  else return el('div', { class: 'sb-empty', text: host.name });
  // Draggable like any host row, or "file it by hand" was only half true:
  // a folder's drop target reads the same dragHost wireHostDrag sets. On a
  // logged-in context the row is the first .sb-item inside its tree.
  const dragRow = node.classList?.contains('sb-item') ? node : node.querySelector?.('.sb-item');
  if (dragRow) wireHostDrag(dragRow, host, groupKey);

  if (!showTags()) return node;
  const tags = labelEntries(host);
  if (!tags.length) return node;
  const strip = tagStrip(host, tags);
  // kubeContextRow's own wrapper (kube-ctx-tree) holds its namespace
  // children right after the row itself — the strip has to land between
  // the two, not simply appended at the end of everything.
  if (node.classList?.contains('kube-ctx-tree')) {
    node.insertBefore(strip, node.children[1] || null);
    return node;
  }
  return el('div', { class: node.className }, node, strip);
}

function hostRow(host, labelText, groupKey = null, opts = {}) {
  // A kube cluster is host-shaped (see kubeHostsForProfile in kubepanel.js)
  // for exactly the folder/filter/drag machinery below, but its own row —
  // the tree, the labels, the exec/logs menu — is nothing like an SSH
  // host's, so it is drawn by kubepanel.js and none of the rest of this
  // function ever runs for one.
  // …except a watched one drawn from its record (gone, or not confirmed): that is a ghost row like any other.
  if (host.kind === 'kube' && !host.missing && !host.unconfirmed) return kubeClusterHostRow(host, groupKey, opts);
  // Remembered so a tick in the multi-exec checkbox can be resolved back to
  // the host it was ticked on — including a ghost drawn from a watch
  // record, which `hostById` does not search. Cleared and refilled on every
  // render of the Hosts tab, which is the only place this is called from.
  drawnHosts.set(host.id, host);
  const connState = connectionStateFor(host.id);
  const checked = state.checkedHosts.has(host.id);

  const ck = el('input', { type: 'checkbox', class: 'ck', title: 'Select for multi-exec' });
  ck.checked = checked;
  // Nothing can be run on a host that is not there.
  if (host.missing) { ck.disabled = true; ck.title = 'This host is no longer in the inventory'; }
  if (host.unconfirmed) { ck.disabled = true; ck.title = 'Nobody has been able to check this host'; }
  if (host.heldBack) { ck.disabled = true; ck.title = 'Out of reach while a request is assumed'; }
  ck.addEventListener('click', (e) => e.stopPropagation());
  ck.addEventListener('change', () => {
    ck.checked ? state.checkedHosts.add(host.id) : state.checkedHosts.delete(host.id);
    state.emit('checked');
    updateStatusBar();
  });

  const tags = labelEntries(host);
  const expanded = showTags() && tags.length > 0;

  const colour = hostColor(host);
  const icon = hostIcon(host);
  const row = el('div', {
    class: 'sb-item' + (host.missing ? ' missing' : '') + (host.heldBack ? ' held' : '')
      + (host.unconfirmed ? ' unconfirmed' : '')
      + (connState === 'connected' ? ' active' : '')
      + (isHidden(host) ? ' host-hidden' : '') + (expanded ? ' has-tags' : '')
      + (colour ? ' coloured' : '') + (isCareful(host) ? ' careful' : '')
      + (opts.folder ? ' in-folder' : ''),
    // The row explains itself wherever you land on it, not only on the badge.
    title: host.missing ? missingLine(host)
      : host.heldBack ? heldLine(host)
      : host.unconfirmed ? unconfirmedLine(host)
      : hostTooltip(host, tags),
    /*
     * A bar down the left edge rather than a dot: it is visible in peripheral
     * vision, which is the point of colouring a host at all. `--depth` is the
     * folder nesting, indented by a CSS step so a row never indents itself
     * out of readability however deep the tree goes.
     */
    style: [colour ? `--host-color:${colour}` : '', opts.depth ? `--depth:${opts.depth}` : '']
      .filter(Boolean).join(';') || null,
  });

  // `el()` drops nulls for you; the DOM's own append() renders them as the text
  // "null", so the optional badges have to be filtered out before it sees them.
  const starred = isStarred(host);
  const star = el('span', {
    class: 'hstar' + (starred ? ' on' : ''),
    text: starred ? '\u2605' : '\u2606',
    title: starred ? 'Starred — click to unstar' : 'Star this host to keep it at the top',
  });
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    setStarred(host, !starred);
  });

  const line = [
    ck,
    el('span', { class: 'st ' + (connState || '') }),
    star,
    /*
     * Being watched is a mark you applied, like the star, so it sits with
     * the star rather than after the name where the host's own icon goes.
     * A bell rather than a dim glyph: the first attempt was an outline
     * circle at muted grey, which was invisible against a list of names —
     * a mark nobody can see is not a mark.
     *
     * Kept on an `unconfirmed` row — a watch whose cluster cannot currently
     * be read, logout included — on purpose: that row only exists because
     * the watch is still in force, and dropping the bell there read as the
     * watch itself having been dropped by the logout, which it was not.
     * `missing` is the one state the bell still skips, because its own
     * "gone" tag already says, unambiguously, what the bell would only
     * repeat.
     */
    showWatchMark() && isWatched(host) && !host.missing
      ? el('span', {
          class: 'hwatch', text: '\u{1F514}',
          title: 'Watched — you will be told if this host leaves the inventory',
        })
      : null,
    /*
     * The name, and its icon after it.
     *
     * Wrapped together because the name is the element that grows to fill
     * the row: an icon placed after it as a sibling would be pushed to the
     * far right, next to the badges, and read as one of them. Inside the
     * wrapper it stays where it belongs — beside the name it marks — and
     * the truncation still happens to the name rather than to the icon.
     */
    el('span', { class: 'nwrap' },
      el('span', { class: 'name', text: host.name || host.alias }),
      // What kind of thing it is: ☸ for a Kubernetes cluster drawn here (a watched one gone missing), a server otherwise.
      host.kind === 'kube' ? kubeIcon() : serverIcon(host.type === 'teleport' ? 'Teleport SSH server' : 'SSH server'),
      icon ? el('span', { class: 'hico', title: 'Right-click → Icon… to change it', text: icon }) : null,
      /*
       * Two nodes answering to one hostname. The row is otherwise identical
       * to its twin — same name, often the same labels — so without a mark
       * the list looks like it is drawing the same machine twice, and the
       * natural conclusion is that the app is broken rather than that the
       * cluster has two of them. It also explains why this one is dialled
       * by id: an ambiguous name is one tsh refuses, so these go over
       * `tsh ssh` with the UUID.
       */
      host.ambiguous && host.uuid
        ? el('span', {
            class: 'hdupe', text: '\u{1F4CB}',
            title: `Duplicate named node — another node in ${host.cluster || 'this cluster'} `
              + `answers to “${host.name}”.\nThis one is dialled by its id, ${host.uuid}.`,
          })
        : null),
    /*
     * A node whose agent has stopped talking, while it is still in the list.
     * It reads as a warning rather than a label because that is what it is:
     * the row still offers to connect, and the connection will hang on a
     * tunnel with nobody on the far end.
     */
    /*
     * Gone from the inventory, and being watched — so it is still drawn,
     * with the one thing the cluster can no longer tell you: that it used
     * to be here, and for how long it has not been.
     */
    host.heldBack
      ? el('span', { class: 'tag held', title: heldLine(host), text: 'held' })
      : host.missing
      ? el('span', {
          class: 'tag gone', title: missingLine(host),
          text: '\u2298 gone ' + goneFor(host.missingSince),
        })
      /*
       * Watched, and nobody has been able to check. Amber rather than red,
       * and worded as a question rather than a verdict: the cluster could
       * not be read, which says nothing about the host and everything about
       * the fact that this watch has quietly stopped being a watch.
       */
      : host.requestable
      ? el('span', {
          class: 'tag req',
          title: `You no longer have standing access to ${host.name}, but the cluster will let you `
            + `ask for it.\nDouble-click the row to start a request.\nRequestable since `
            + `${new Date(host.requestableSince).toLocaleString()}.`,
          text: 'req',
        })
      : host.unconfirmed
      ? el('span', {
          class: 'tag stale', title: unconfirmedLine(host),
          // A plain question mark: the double-question glyph falls back to a
          // literal "??" in the interface font, which reads as a mistake.
          text: '? unchecked ' + goneFor(host.lastSeen),
        })
      : isStale(host)
      ? el('span', { class: 'tag stale', title: heartbeatLine(host), text: '⚠ ' + staleLabel(host) })
      // The same fact for a node that is fine, when it has been asked for.
      // Not alongside the warning: that badge already carries the age.
      : (showHeartbeats() && heartbeatAge(host) !== null
        ? el('span', { class: 'tag hb', title: heartbeatLine(host), text: '♥ ' + ageLabel(host) })
        : null),
    // A requestable watch keeps its req tag when checks stop landing, and
    // says how long it has been, as an unchecked watch would.
    host.requestable && host.requestUncheckedSince
      ? el('span', {
          class: 'tag stale', title: requestUncheckedLine(host),
          text: '? unchecked ' + goneFor(host.requestUncheckedSince),
        })
      : null,
    (isMfaHost(host.id) || (host.mfaId && isMfaHost(host.mfaId)))
      ? el('span', { class: 'tag mfa', title: 'Requires per-session MFA', text: 'mfa' }) : null,
    teleportPresenceBadge(host, connState),
    trailingBadge(host, labelText, expanded),
  ].filter(Boolean);

  if (expanded) {
    row.append(el('div', { class: 'sb-line' }, ...line), tagStrip(host, tags));
  } else {
    row.append(...line);
  }

  row.dataset.host = host.id;
  row.addEventListener('dblclick', () => (host.heldBack
    ? toast(`${host.name} is out of reach while the request is assumed — drop it to use this node`, 'error')
    : host.requestable
    ? requestAccessFor(host)
    : host.missing
    ? toast(`${host.name} is not in the inventory any more — last seen ${goneFor(host.missingSince)} ago`, 'error')
    : open(host)));
  row.addEventListener('click', (e) => { if (e.detail === 1) setTimeout(() => {}, 0); });
  row.addEventListener('contextmenu', (e) => onHostContextMenu(e, host, { folder: opts.folder || null, groupKey }));
  if (groupKey) wireHostDrag(row, host, groupKey);
  return row;
}

/**
 * How many tags a row shows before deferring to the dialog, and how long a
 * value may be before it is treated as one of the long ones. Command labels
 * like `uptime` ("up 1 day, 22 hours, 3 minutes") and `stats` are the reason
 * for both: they are unreadable squeezed into a chip and would push everything
 * worth seeing off the row.
 */
const STRIP_LIMIT = 6;
const STRIP_MAX_VALUE = 22;

/**
 * At most one badge after the name, because the name is what the row is for.
 * A label beats "tunnel": on a cluster where every node dials home, "tunnel"
 * says nothing, and showing both left names like `soleng-tp-discovery-svc`
 * truncated to nothing. Once the tags are spelled out below, the summary is
 * redundant and only "tunnel" is worth a badge.
 */
function trailingBadge(host, labelText, expanded) {
  if (!expanded && labelText) return el('span', { class: 'tag', text: labelText });
  if (host.tunnel) {
    return el('span', { class: 'tag tunnel', title: 'Reached over a reverse tunnel', text: 'tunnel' });
  }
  return null;
}

/** Clickable `key=value` chips; a click filters the list down to that tag. */
function tagStrip(host, tags) {
  const strip = el('div', { class: 'sb-tags' });
  const ordered = orderForStrip(tags);
  // A tag the filter already names stays on screen, so the row can always show
  // why it survived the query.
  const shown = ordered.slice(0, STRIP_LIMIT);
  for (const t of ordered.slice(STRIP_LIMIT)) {
    if (hasTerm(filterText, termFor(t[0], t[1]))) shown.push(t);
  }

  for (const [k, v] of shown) {
    const term = termFor(k, v);
    const on = hasTerm(filterText, term);
    const chip = el('button', {
      class: 'chip' + (on ? ' on' : ''),
      title: on ? `${k} = ${v}\nClick to remove from the filter` : `${k} = ${v}\nClick to filter by it`,
      onClick: (e) => { e.stopPropagation(); filterByTag(k, v); },
    },
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v', text: v || '—' }));
    chip.addEventListener('dblclick', (e) => e.stopPropagation());
    strip.append(chip);
  }

  const hidden = tags.length - shown.length;
  if (hidden > 0) {
    const more = el('button', {
      class: 'chip more', title: 'Show every tag on this node',
      text: `+${hidden} more`,
      onClick: (e) => { e.stopPropagation(); openHostTags(host); },
    });
    more.addEventListener('dblclick', (e) => e.stopPropagation());
    strip.append(more);
  }
  return strip;
}

/**
 * Labels people actually sort by first, then the rest alphabetically, with
 * long-valued ones last so they fall into "+N more" rather than crowding out
 * `env` and `role`.
 */
function orderForStrip(tags) {
  const rank = ([k, v]) => {
    if (String(v).length > STRIP_MAX_VALUE) return LABEL_PRIORITY.length + 1;
    const i = LABEL_PRIORITY.indexOf(k.toLowerCase().split('/').pop());
    return i < 0 ? LABEL_PRIORITY.length : i;
  };
  return [...tags].sort((a, b) => rank(a) - rank(b) || a[0].localeCompare(b[0]));
}

function hostTooltip(host, tags) {
  if (host.type !== 'teleport') {
    return `${host.alias}\n${host.user}@${host.hostname}:${host.port}`;
  }
  const lines = [
    host.name,
    `cluster: ${host.cluster}`,
    `connects as: ${preferredLogin(host) || '(cluster default)'}`,
    host.addr || (host.tunnel ? 'tunnel' : ''),
    heartbeatLine(host),
    /*
     * Which of them this row is. Two nodes in a cluster can answer to the
     * same hostname, and then the rows are identical — the UUID is the only
     * thing that tells them apart, and the only thing tsh will dial them by.
     */
    host.ambiguous && host.uuid
      ? `node id: ${host.uuid}\n(another node here has the same hostname, so this one is dialled by id)`
      : '',
  ].filter(Boolean);
  if (tags.length) {
    lines.push('', `tags (${tags.length}):`, ...tags.slice(0, 20).map(([k, v]) => `  ${k} = ${v}`));
    if (tags.length > 20) lines.push(`  … and ${tags.length - 20} more`);
  }
  return lines.join('\n');
}

/**
 * Connect with `tsh ssh` instead of the shared connection. Nodes that require
 * per-session MFA do the ceremony on the session itself, so the prompt has to
 * land in the terminal the user is looking at.
 */
export async function openMfa(host, login) {
  const who = login || preferredLogin(host);
  const mode = state.settings.mfaMode || 'platform';
  /*
   * Choosing this is itself a statement that the host needs MFA — but only
   * worth recording under a *live* id. A ghost or requestable row's `id`
   * is synthesised (`missing:uuid:…`), never the live inventory's own
   * `tsh:<cluster>:<uuid>` that every lookup of this list reads by, so
   * marking it here just added a second, dead entry under a key nothing
   * will ever ask for again — `open()` in sidebar.js already resolves and
   * marks the real one before routing here, for exactly this case.
   */
  if (!host.missing && !host.unconfirmed && !host.requestable && !isMfaHost(host.id)) {
    setMfaHost(host, true).catch(() => {});
  }
  try {
    status(`Connecting to ${host.name} with tsh (${mfaLabel(mode)})…`, 0);
    await openHost(host, { login: who, transport: 'tsh', reuse: false, mfaMode: mode });
    status('');
    toast(mode === 'platform'
      ? 'Approve with Touch ID when prompted'
      : 'Answer the MFA prompt in the terminal', 'info', 6000);
  } catch (e) {
    toast(e.message, 'error');
    status('');
  }
}

function mfaLabel(mode) {
  return ({
    platform: 'Touch ID',
    'cross-platform': 'security key',
    otp: 'OTP code',
    browser: 'browser',
    auto: 'automatic',
  })[mode] || mode;
}

/* ------------------------------------------------------------------ */
/* VNet                                                                */
/* ------------------------------------------------------------------ */

/*
 * VNet for one cluster. `tsh vnet` would otherwise serve every profile in the
 * tsh home, and log in again to any that had expired; the main process runs
 * it against a home holding only this cluster (see vnet.js).
 */
const profileName = (proxy) => String(proxy || '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');

function vnetFor(p) {
  return state.vnet?.get(profileName(p.proxy)) || null;
}

const VNET_LIVE = new Set(['starting', 'running', 'stopping']);

/** `env` on a heading while the cluster has tsh variables of its own (tshenv.js). */
let envTagFn = null;
import('./tshenv.js').then((m) => { envTagFn = m.clusterEnvTag; renderSidebar(); }).catch(() => {});
function envTag(p) {
  return envTagFn ? envTagFn(p, async () => (await import('./tshenv.js')).editClusterEnv(p)) : null;
}

function vnetTag(p) {
  const v = vnetFor(p);
  if (!v || v.state === 'stopped') return null;
  const words = {
    starting: ['vnet-busy', 'VNet\u2026', 'VNet is starting \u2014 macOS may ask to approve it'],
    running: ['vnet-on', 'VNet', 'VNet is running for this cluster: its apps answer by name. Right-click to stop it.'],
    stopping: ['vnet-busy', 'VNet\u2026', 'VNet is stopping'],
    error: ['vnet-err', 'VNet \u2715', `VNet stopped: ${v.error || 'tsh vnet exited'} \u2014 right-click for its output`],
  }[v.state];
  if (!words) return null;
  const [cls, text, title] = words;
  return el('span', {
    class: `tag ${cls}`, text, title,
    onClick: (e) => { e.stopPropagation(); openVnetLog(p); },
  });
}

function vnetMenuItems(profile) {
  if (profile.expired) return [];
  const v = vnetFor(profile);
  const live = v && VNET_LIVE.has(v.state);
  return [
    live
      ? {
          label: v.state === 'stopping' ? 'Stopping VNet\u2026' : 'Stop VNet', icon: '\u25C9',
          disabled: v.state === 'stopping',
          title: 'Stops tsh vnet and takes its network setup down with it',
          onClick: () => window.api.vnet.stop(profile.proxy).catch((e) => toast(e.message, 'error')),
        }
      : {
          label: 'Start VNet', icon: '\u25CE',
          title: `Runs tsh vnet for ${profile.cluster || profile.proxy} alone: its TCP apps answer by name, no tsh proxy needed`,
          onClick: () => window.api.vnet.start({ proxy: profile.proxy, home: profile.homeDir || null })
            .then(() => status('Starting VNet\u2026 macOS may ask you to approve it', 8000))
            .catch((e) => toast(e.message, 'error')),
        },
    v ? { label: 'VNet output\u2026', icon: '\u2630', onClick: () => openVnetLog(profile) } : null,
  ].filter(Boolean);
}

async function openVnetLog(p) {
  const v = vnetFor(p);
  const { modal } = await import('./ui.js');
  modal({
    title: 'VNet',
    width: 'min(720px, 94vw)',
    render: (body) => {
      body.append(
        el('div', { class: 'hint', style: 'margin-bottom:8px', text: v
          ? `${v.state}${v.error ? ' \u2014 ' + v.error : ''} \u00b7 ${v.cluster}`
          : 'Not started.' }),
        el('pre', { class: 'qc-debug', style: 'max-height:50vh;overflow:auto;white-space:pre-wrap',
          text: (v?.log || []).join('\n') || '(tsh vnet has printed nothing)' }));
    },
    buttons: [{ label: 'Close', class: 'primary-btn', value: null }],
  });
}

/*
 * One "AI assistant" row under Local — not a row per tool. Double-click opens
 * the assistant chosen to open at startup, or the list to choose from;
 * right-click is the whole list, with setting up, checking and adding a tool
 * of your own. What is installed is read once from the login shell; until it
 * has been, the row still opens the list.
 */
let aiModule = null;
let aiLoading = false;
function localAiRows() {
  if (!aiModule && !aiLoading) {
    aiLoading = true;
    import('./ai.js').then(async (m) => { aiModule = m; await m.aiClients(); renderSidebar(); }).catch(() => {});
  }
  const running = aiModule ? aiModule.aiRunningCount() : 0;
  const waiting = aiModule ? aiModule.aiWaitingCount() : 0;
  const preferred = aiModule ? aiModule.startupAiName() : null;
  const row = el('div', {
    class: 'sb-item',
    title: 'AI assistants — Claude Code, Codex, Copilot, OpenCode, Pi, Gemini or one of your own — in the panel on the right',
  },
    el('span', { class: 'st', style: `background:${waiting ? 'var(--ai-ask)' : running ? 'var(--green)' : 'var(--purple)'}` }),
    el('span', { class: 'name', text: 'AI assistant' }),
    // A question waiting outranks "running": it is the one that needs you.
    el('span', { class: 'tag' + (waiting ? ' ai-waiting-tag' : ''), style: 'margin-left:auto',
      title: waiting ? 'An assistant is asking you something — double-click to see it' : '',
      text: waiting ? `${waiting} question${waiting === 1 ? '' : 's'} waiting` : running ? `${running} running` : (preferred || 'AI') }));
  const menuAt = async (x, y) => {
    const m = aiModule || await import('./ai.js');
    const items = await m.aiMenuItems();
    contextMenu(x, y, [
      ...items,
      { sep: true },
      m.aiRunningCount() ? {
        label: m.aiPanelShown() ? 'Hide the AI panel' : 'Show the AI panel',
        onClick: () => m.showAiPanel(!m.aiPanelShown()),
      } : null,
      {
        label: 'Open at startup',
        submenu: [
          { label: 'None', key: state.settings.aiStartup ? '' : '✓', onClick: () => setAiStartup('') },
          ...(m.cachedAiClients()?.clients || []).filter((c) => c.available).map((c) => ({
            label: c.name, key: state.settings.aiStartup === c.id ? '✓' : '', onClick: () => setAiStartup(c.id),
          })),
        ],
      },
      {
        label: 'Check that a tool is ready',
        submenu: (m.cachedAiClients()?.clients || []).map((c) => ({ label: c.name, onClick: () => m.checkAi(c.id) })),
      },
    ].filter(Boolean));
  };
  row.addEventListener('dblclick', async (e) => {
    const m = aiModule || await import('./ai.js');
    /*
     * A small prompt for a new session: which assistant, and what to ask it.
     * It answers at once — nothing starts until Open — so the row never
     * looks stuck; Show the panel is there for the ones already running.
     */
    m.openAiPrompt();
    void e;
  });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); menuAt(e.clientX, e.clientY); });
  return [row];
}

async function setAiStartup(id) {
  state.settings = await window.api.settings.set({ aiStartup: id });
  renderSidebar();
}

/** Put a host beside (or below) whatever pane is focused. */
async function splitWith(host, login, dir) {
  login = login || preferredLogin(host);
  try {
    status(`Opening ${host.name || host.alias}…`, 0);
    await splitActivePane(dir, { host, login, startupCommand: hostStartupCommand(host) || undefined });
    status('');
  } catch (e) {
    toast(e.message, 'error');
    status('');
  }
}

/** Open a session with X11 forwarding, warning first if there is no X server. */
async function openX11(host, login) {
  login = login || preferredLogin(host);
  const st = await window.api.x11.status().catch(() => ({ available: false, hint: 'Could not check for an X server.' }));
  if (!st.available) {
    const go = await confirm({
      title: 'No local X server detected',
      message: st.hint,
      detail: 'You can still open the session, but graphical programs will fail with "cannot open display".',
      confirmLabel: 'Open anyway',
    });
    if (!go) return;
  }
  const mode = state.settings.x11 && state.settings.x11 !== 'off' ? state.settings.x11 : 'untrusted';
  try {
    status(`Connecting to ${host.name || host.alias} with X11…`, 0);
    await openHost(host, { login, x11: mode, reuse: false });
    status('');
    toast(`X11 forwarding on (${mode}). Try: xeyes`, 'success');
  } catch (e) {
    toast(e.message, 'error');
    status('');
  }
}

/**
 * The same connection, without a terminal on it — for when the session is
 * about moving files and a shell is just something else on screen. With `dir`
 * it lands beside the focused pane instead of in a tab of its own, which is
 * how you get a file browser next to the shell you are already working in.
 */
async function openFilesOnly(host, login, dir) {
  const who = login || preferredLogin(host);
  try {
    status(`Opening files on ${host.name || host.alias}…`, 0);
    if (dir) {
      const { splitActivePane } = await import('./sessions.js');
      await splitActivePane(dir, { host, login: who, filesOnly: true });
    } else {
      await openHost(host, { login: who, filesOnly: true });
    }
    status('');
  } catch (e) {
    toast(e.message, 'error');
    status('');
  }
}

/**
 * Open a host the way the host list opens it.
 *
 * Exported because every other list of hosts — the pane, the folder browser
 * — has to do the *same* thing, and calling `openHost` directly is not it:
 * that skips the account this host is supposed to connect as (the pinned
 * one, else the one that last worked, else the cluster's first) and skips
 * the MFA route for a node that needs it. Opening the same machine from two
 * lists and getting two different users is the kind of difference nobody
 * reports as a bug until it has wasted an afternoon.
 */
export function openHostFromList(host, login) {
  return open(host, login);
}

async function open(host, login) {
  const who = login || preferredLogin(host);
  /*
   * A host set to always use tmux opens there instead, so "open a session"
   * keeps meaning one thing and the choice is made once rather than on every
   * connection.
   */
  if (opensInTmux(host)) {
    const { openTmux } = await import('./tmux.js');
    return openTmux(host, { login: who, session: tmuxNameFor(host) });
  }
  /*
   * A host we know needs MFA skips the shared path, which cannot satisfy
   * it. A ghost, unconfirmed, or requestable row's own `id` is not that
   * key, though — it is synthesised from the watch record or the search
   * result (`missing:uuid:…`), not the live inventory's own
   * `tsh:<cluster>:<uuid>` that the mark was set against. Without this, a
   * marked node that had gone missing, become unreachable, or turned
   * requestable quietly lost its MFA routing the moment it did, fell
   * through to the shared path, and failed there instead — on the OpenSSH
   * transport specifically with "tsh config failed", since that path
   * builds an ssh_config from a cluster login this skips straight past
   * the retry that would have fixed it.
   *
   * A requestable row already carries the resolved id as `host.mfaId`
   * (`requestable.js`; the row's own "mfa" tag already reads it the same
   * way) — reused rather than asked for again. Missing/unconfirmed
   * ghosts never got that precomputed, `watch.js` having no cluster to
   * ask, so those are resolved here the same way the context menu's own
   * "Mark as needing MFA" already does before reading or setting the mark.
   */
  let mfaId = host.mfaId || host.id;
  if (!host.mfaId && (host.missing || host.unconfirmed) && host.type === 'teleport' && host.uuid) {
    try {
      const resourceId = host.resourceId || `/${host.cluster}/node/${host.uuid}`;
      const ids = await window.api.teleport.inventoryNodeIds({
        items: [{ id: resourceId, cluster: host.cluster, uuid: host.uuid }],
        home: host.home,
      });
      mfaId = ids[resourceId] || host.id;
    } catch { /* falls back to host.id, which just will not match */ }
  }
  if (isMfaHost(mfaId) && host.type === 'teleport') return openMfa(host, who);
  try {
    status(`Connecting to ${host.name || host.alias}${who ? ' as ' + who : ''}…`, 0);
    await openHost(host, { login: who, startupCommand: hostStartupCommand(host) || undefined });
    status('');
  } catch (e) {
    toast(e.message, 'error');
    status('');
  }
}

export function loginOptionsFor(host) {
  if (host.type === 'teleport') {
    // The certificate that carries the logins belongs to a profile in one tsh
    // home; with the same cluster in two homes those login sets can differ.
    const p = state.teleportProfiles.find((x) => x.cluster === host.cluster
        && (x.home || null) === (host.home || null))
      || state.teleportProfiles.find((x) => x.cluster === host.cluster);
    return p?.logins || [];
  }
  return host.user ? [host.user] : [];
}

/**
 * Which login to connect as.
 *
 * `tsh config` writes the *Teleport username* as the ssh User, which is a
 * cluster principal, not necessarily a valid account on the node — connecting
 * without saying otherwise fails with "access denied to <you>". So always name
 * a login: the one that last worked for this host, else the first the cluster
 * grants.
 */
export function preferredLogin(host) {
  // Said deliberately for this host: honoured as given, even if it is not one
  // of the cluster's principals — the cluster decides whether it is allowed,
  // and quietly substituting a different account would be worse than failing.
  const explicit = preferredUser(host);
  if (explicit) return explicit;
  const remembered = (state.settings.hostLogins || {})[host.id];
  const options = loginOptionsFor(host);
  if (remembered && (!options.length || options.includes(remembered))) return remembered;
  return options[0] || undefined;
}

/** Remember the login that actually connected for this host. */
export async function rememberLogin(hostId, login) {
  if (!hostId || !login) return;
  const map = { ...(state.settings.hostLogins || {}) };
  if (map[hostId] === login) return;
  map[hostId] = login;
  state.settings = await window.api.settings.set({ hostLogins: map });
}

/**
 * `tsh latency ssh`, in its own tab.
 *
 * It is a live view that draws its own screen and insists on a real TTY, so it
 * runs as a terminal rather than being captured — the same treatment session
 * replay gets.
 */
async function openLatency(host, login) {
  try {
    const { command, args, teleportHome } = await window.api.teleport.latencyArgs({
      proxy: host.proxy,
      cluster: host.cluster,
      home: host.home || null,
      node: host.name,
      login: login || preferredLogin(host),
    });
    const { openLocalShell } = await import('./sessions.js');
    await openLocalShell(undefined, {
      command, args, teleportHome,
      title: `\u21C4 latency \u00B7 ${host.name}`,
      explorer: false,
    });
    status(`Measuring latency to ${host.name} — close the tab to stop`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/**
 * A host's own menu, opened from wherever the host is drawn — the sidebar row
 * or the folder browser's listing. `ctx.folder` is the folder it was clicked
 * in, when it was clicked in one, so the menu can offer to take it out again.
 */
export function openHostMenu(e, host, ctx = {}) {
  // The hosts pane routes every row here; a kube one has its own menu
  // (edit, remove, browse…), which hostRow() never reaches either.
  if (host.kind === 'kube' && !host.requestable) return openKubeHostMenu(e, host, ctx.groupKey);
  return onHostContextMenu(e, host, ctx);
}

/**
 * Ask for access to a host that has become requestable.
 *
 * The resource id is what a request names, and it is built the way the
 * cluster writes it: `/cluster/kind/id`. Rebuilt here rather than kept,
 * because the record predates the resource being requestable at all.
 */
export async function requestAccessFor(host) {
  // `p.home`, not `p.homeDir` — see the same fix in sessions.js's
  // `ensureLoggedIn`. `homeDir` is never null, default home included, so
  // comparing it against `host.home` (null there) never matched and this
  // always fell to the cluster-name fallback below.
  const profile = (state.teleportProfiles || []).find((p) => (p.proxy || '') === (host.proxy || '')
    && (p.home || null) === (host.home || null))
    || (state.teleportProfiles || []).find((p) => p.cluster === host.cluster);
  if (!profile) return toast('Log in to that cluster first', 'error');
  const { requestAccessTo } = await import('./teleportpanel.js');
  await requestAccessTo(profile, {
    id: `/${host.cluster || profile.cluster}/node/${host.uuid}`,
    kind: 'node',
    name: host.name,
    uuid: host.uuid,
    cluster: host.cluster || profile.cluster,
    labels: host.labels || {},
  });
}

/**
 * What `hostRow` last drew, by host id — including a ghost or a requestable
 * row, neither of which `hostById` can find since both are synthesised from
 * a watch record or a cluster's requestable list rather than kept in
 * `state.teleportNodes`/`state.sshHosts`. Refilled on every render of the
 * Hosts tab; a ticked-but-no-longer-drawn id just resolves to nothing.
 */
const drawnHosts = new Map();

/** The Hosts tab's ticked (multi-exec) hosts, resolved back to objects. */
function checkedHostObjects() {
  return [...state.checkedHosts].map((id) => drawnHosts.get(id)).filter(Boolean);
}

/**
 * "Request access to N selected nodes…", or null where there is nothing to
 * bulk-request — fewer than two hosts ticked.
 *
 * Shared by every menu a host row can show, not just the generic one: the
 * row right-clicked to get here is routinely *not* one of the ticked ones
 * — a requestable or an unconfirmed row has its own short menu instead of
 * the generic one, and those are exactly the rows most likely to be ticked
 * for this. Dropping the bulk action from them would make it disappear
 * precisely when it is most wanted.
 */
function bulkRequestMenuItem() {
  if (state.checkedHosts.size <= 1) return null;
  const reqCount = checkedHostObjects().filter((h) => h.requestable).length;
  return {
    label: `Request access to ${reqCount} selected node${reqCount === 1 ? '' : 's'}…`,
    icon: '\u2691',
    disabled: !reqCount,
    title: reqCount
      ? 'Starts one request per cluster the selection spans'
      : 'None of the selected hosts are requestable',
    onClick: () => requestAccessForMany(checkedHostObjects()),
  };
}

/**
 * The same thing for a multi-select — the Hosts pane's `picked`, or the
 * Hosts tab's multi-exec ticks — only the requestable hosts in it, one
 * request per cluster they resolve to (a selection can span more than
 * one), each prefilled with every node from that cluster at once — what
 * would otherwise be "Request access to it…" done by hand, repeatedly.
 */
export async function requestAccessForMany(hosts) {
  const requestable = hosts.filter((h) => h.requestable);
  if (!requestable.length) return toast('None of the selected hosts are requestable', 'error');
  const { requestAccessToMany } = await import('./teleportpanel.js');
  const groups = new Map();   // profile -> resources[]
  let unmatched = 0;
  for (const host of requestable) {
    const profile = (state.teleportProfiles || []).find((p) => (p.proxy || '') === (host.proxy || '')
      && (p.home || null) === (host.home || null))
      || (state.teleportProfiles || []).find((p) => p.cluster === host.cluster);
    if (!profile) { unmatched++; continue; }
    const resource = {
      id: `/${host.cluster || profile.cluster}/node/${host.uuid}`,
      kind: 'node', name: host.name, uuid: host.uuid,
      cluster: host.cluster || profile.cluster, labels: host.labels || {},
    };
    if (!groups.has(profile)) groups.set(profile, []);
    groups.get(profile).push(resource);
  }
  if (!groups.size) return toast('Log in to that cluster first', 'error');
  // Sequential, not parallel: each is its own modal, and two at once would
  // stack one behind the other with no way to tell they are both open.
  for (const [profile, resources] of groups) {
    await requestAccessToMany(profile, resources);
  }
  if (unmatched) toast(`${unmatched} host${unmatched === 1 ? '' : 's'} skipped — log in to ${unmatched === 1 ? 'its' : 'their'} cluster first`, 'error');
}

async function onHostContextMenu(e, host, ctx = {}) {
  e.preventDefault();
  /*
   * A host that is not there any more gets a short menu: there is nothing
   * to open, no account to pick, and no setting worth changing on a machine
   * that has gone. What is left is the record itself.
   */
  if (host.requestable) {
    /*
     * Two kinds of row land here: a watched host whose access lapsed (drawn
     * from its record), and a node the cluster's requestable list shows,
     * which may or may not be watched. Either can be watched or unwatched
     * from here — before, only "Stop watching" was offered, on both, so a
     * requestable node could never be watched and never had the bell.
     */
    const watched = isWatched(host);
    /*
     * MFA can be marked ahead of the grant too — same `mfaHosts` list a
     * known host uses, keyed by the id the node will carry once access
     * lands (see `inventoryNodeIds`). Only a `kind: 'node'` row carries a
     * uuid to predict that id from; a watched-but-lapsed row may lack
     * `resourceId` (its record predates the resource being requestable at
     * all), so it is rebuilt the way `requestAccessFor` does.
     */
    let mfaHostId = '';
    const resourceId = host.resourceId
      || (host.cluster && host.uuid ? `/${host.cluster}/node/${host.uuid}` : '');
    if ((host.kind || 'node') === 'node' && resourceId && host.uuid) {
      try {
        const ids = await window.api.teleport.inventoryNodeIds({
          items: [{ id: resourceId, cluster: host.cluster, uuid: host.uuid }],
          home: host.home,
        });
        mfaHostId = ids[resourceId] || '';
      } catch { /* the menu just won't offer the MFA toggle this time */ }
    }
    contextMenu(e.clientX, e.clientY, [
      { label: host.name, heading: true },
      host.requestableSince
        ? { label: `Requestable since ${goneFor(host.requestableSince)} ago`, disabled: true }
        : { label: 'Requestable — your roles do not reach it yet', disabled: true },
      {
        label: 'Request access to it…', icon: '\u2691',
        title: 'Starts a request with this node already chosen',
        onClick: () => requestAccessFor(host),
      },
      bulkRequestMenuItem(),
      mfaHostId ? {
        label: isMfaHost(mfaHostId) ? 'Forget that this needs MFA' : 'Mark as needing MFA once granted',
        icon: '\u26BF',
        title: isMfaHost(mfaHostId)
          ? 'Marked to need MFA once granted — click to forget'
          : 'So it connects straight to tsh the moment access lands, with no failed attempt first',
        onClick: () => setMfaHost({ id: mfaHostId, name: host.name }, !isMfaHost(mfaHostId)),
      } : null,
      watched ? {
        label: 'Profile…', icon: '\u2139',
        title: 'What was kept about it: the cluster it came from, its node id, address and labels',
        onClick: () => openWatchProfile(host),
      } : null,
      host.uuid ? {
        label: 'Copy its node id',
        onClick: () => { window.api.clipboard.write(host.uuid); status('Copied ' + host.uuid); },
      } : null,
      { sep: true },
      watched ? {
        label: 'Stop watching it', icon: '\u2326',
        onClick: async () => { await forgetWatched(host.watchKey || hostKey(host)); status(`Stopped watching ${host.name}`); },
      } : {
        label: 'Tell me if this host disappears', icon: '\u25CB',
        title: 'Keeps its node id and last known details, marks it with the bell, and says so if it leaves the cluster',
        onClick: () => toggleWatch(host, ctx.groupKey || groupKeyForHost(host)),
      },
    ].filter(Boolean));
    return;
  }
  if (host.missing || host.unconfirmed) {
    contextMenu(e.clientX, e.clientY, [
      { label: host.name, heading: true },
      {
        label: host.missing
          ? `Gone ${goneFor(host.missingSince)} — last seen ${goneFor(host.lastSeen)} ago`
          : `Not checked — last confirmed ${goneFor(host.lastSeen)} ago`,
        disabled: true,
      },
      {
        label: 'Profile…', icon: '\u2139',
        title: 'What was kept about it: the cluster it came from, its node id, address and labels',
        onClick: () => openWatchProfile(host),
      },
      host.uuid ? {
        label: 'Copy its node id',
        onClick: () => { window.api.clipboard.write(host.uuid); status('Copied ' + host.uuid); },
      } : null,
      bulkRequestMenuItem(),
      { sep: true },
      {
        label: 'Stop watching and forget it', icon: '\u2326',
        title: 'Removes the row and the record kept of it',
        onClick: async () => {
          await forgetWatched(host.watchKey);
          status(`Forgot ${host.name}`);
        },
      },
    ].filter(Boolean));
    return;
  }
  const logins = loginOptionsFor(host);
  const preferred = preferredLogin(host);
  const inTmux = opensInTmux(host);
  // Something has to be on screen for "beside it" to mean anything.
  const canSplit = !!state.activePane;
  /*
   * Three ways to open, and everything else behind one entry.
   *
   * This menu had six openings in a row before the marks and the folders and
   * the selection, and a menu long enough to need reading is a menu nobody
   * reads. The three that are left are the ones that answer "I want a session
   * on this machine"; the rest — another account, a split, files without a
   * terminal — are deliberate variations, and a variation is worth one more
   * click to keep the common case short.
   */
  const items = [
    {
      label: preferred ? `Open session as ${preferred}` : 'Open session',
      icon: '\u25B8',
      sub: inTmux ? 'in tmux' : '',
      onClick: () => open(host),
    },
    {
      label: inTmux ? 'Open without tmux' : 'Open in tmux\u2026',
      icon: inTmux ? '\u25B8' : '\u267B',
      // An MFA host is dialled per session with an approval; there is nothing
      // for a session that outlives the window to attach to.
      disabled: !inTmux && isMfaHost(host.id),
      title: isMfaHost(host.id) && !inTmux
        ? 'Not on a host that asks for MFA per session'
        : inTmux
          ? 'A plain session on this host, just this once'
          : 'Keeps running on the server when this window goes away',
      onClick: async () => {
        if (inTmux) {
          const who = preferred || logins[0];
          if (isMfaHost(host.id) && host.type === 'teleport') return openMfa(host, who);
          try {
            status(`Connecting to ${host.name || host.alias}…`, 0);
            await openHost(host, { login: who });
            status('');
          } catch (e) { toast(e.message, 'error'); status(''); }
          return;
        }
        const { openTmuxDialog } = await import('./tmux.js');
        openTmuxDialog(host, { login: preferred || logins[0] });
      },
    },
    /*
     * Splitting stays on the face of the menu, and only when there is
     * something to split.
     *
     * It is not a variation on opening a session, it is where the session
     * lands, and on a screen already holding one host it is the commonest
     * answer of the three — so behind a submenu it cost two gestures for
     * something done constantly. But "beside the current pane" with no
     * current pane is an instruction with no object: it opens a plain tab and
     * reads as a bug. With nothing open, the two lines simply are not there.
     */
    ...(canSplit ? [
      {
        label: 'Open beside current (split right)', icon: '\u216E',
        onClick: () => splitWith(host, preferred || logins[0], 'row'),
      },
      {
        label: 'Open below current (split down)', icon: '\u2017',
        onClick: () => splitWith(host, preferred || logins[0], 'col'),
      },
    ] : []),
    {
      label: 'Other ways to open', icon: '\u22EF',
      submenu: [
        ...(logins.length > 1 ? [{
          label: 'As another user…',
          onClick: async () => {
            const who = await pickLogin(logins, host);
            if (who) open(host, who);
          },
        }, { sep: true }] : []),
        { heading: true, label: 'Files without a terminal' },
        { label: 'In a new tab', onClick: () => openFilesOnly(host, preferred) },
        ...(canSplit ? [
          { label: 'Split right', onClick: () => openFilesOnly(host, preferred, 'row') },
          { label: 'Split down', onClick: () => openFilesOnly(host, preferred, 'col') },
        ] : []),
      ],
    },
    { sep: true },
    {
      label: preferredUser(host)
        ? `Preferred username: ${preferredUser(host)}…`
        : 'Preferred username…',
      icon: '\u263A',
      title: 'Always connect to this host as one account, whatever last worked',
      onClick: () => setPreferredUser(host),
    },
    {
      label: hostStartupCommand(host) ? 'Startup command: set…' : 'Startup command…',
      icon: '▸',
      title: 'Run a command the moment a session on this host opens',
      onClick: () => setHostStartupCommand(host),
    },
    openFilesMenu(host),
    tmuxMenu(host),
    folderMenuFor(host, ctx),
    { sep: true },
    /*
     * How the row looks, in one place.
     *
     * A colour, an icon and a star are the same kind of decision — what this
     * machine should look like in a list — and each of them was a line of its
     * own in a menu that had too many. Together they are one line, and the
     * watch is left outside because it is not decoration: it is the app
     * promising to tell you something.
     */
    {
      label: 'Mark this host', icon: hostIcon(host) || (isStarred(host) ? '\u2605' : '\u25C9'),
      title: 'Star it, colour it, give it an icon',
      submenu: [
        {
          label: isStarred(host) ? 'Unstar' : 'Star \u2014 keep at the top',
          key: isStarred(host) ? '\u2605' : '',
          onClick: () => setStarred(host, !isStarred(host)),
        },
        {
          label: hostIcon(host) ? `Icon: ${hostIcon(host)}` : 'Give it an icon\u2026',
          onClick: () => setHostIcon(host),
        },
        { sep: true },
        { heading: true, label: 'Colour' },
        ...HOST_COLORS.map((c) => ({
          label: c.label,
          key: (state.settings.hostColors || {})[hostPrefKey(host)] === c.value
            || (!c.value && !hostColor(host)) ? '✓' : '',
          onClick: () => setHostColor(host, c.value),
        })),
        { sep: true },
        { heading: true, label: 'Where starred hosts go' },
        {
          label: 'Top of their own group',
          key: starredMode() === 'inline' ? '✓' : '',
          onClick: () => setStarredMode('inline'),
        },
        {
          label: 'A Starred group above everything',
          key: starredMode() === 'group' ? '✓' : '',
          onClick: () => setStarredMode('group'),
        },
        { sep: true },
        {
          label: isCareful(host) ? 'Stop asking before multi-exec' : 'Ask before multi-exec on this host',
          title: 'A host worth a second look before a command fans out to it',
          onClick: () => setCareful(host, !isCareful(host)),
        },
      ],
    },
    {
      label: isWatched(host) ? 'Stop watching for its disappearance' : 'Tell me if this host disappears',
      icon: isWatched(host) ? '\u25C9' : '\u25CB',
      title: isWatched(host)
        ? 'Its last known details are kept; the row stays if it leaves the inventory'
        : 'Keeps its node id and last known details, and says so if it stops being listed',
      onClick: () => toggleWatch(host, ctx.groupKey || groupKeyForHost(host)),
    },
    // Only once a look has been saved for it, from Pane style on one of its panes.
    hostStyleMenu(host.id),
    {
      label: 'Ask the AI about this host', icon: '✦',
      title: 'Put its details into the AI assistant — then type your question',
      onClick: async () => {
        const m = await import('./ai.js');
        m.askAiAbout(m.describeHost(host), `the host ${host.name} in ServerLife`);
      },
    },
    bulkRequestMenuItem(),
    { sep: true },
    state.checkedHosts.size > 1 ? {
      label: `Open multi-exec on ${state.checkedHosts.size} selected hosts\u2026`,
      icon: '\u25b8',
      title: 'Opens the multi-exec dock, already targeting the ticked hosts',
      onClick: async () => {
        const { openDock } = await import('./dock.js');
        openDock('multiexec');
      },
    } : null,
    {
      label: state.checkedHosts.has(host.id) ? 'Unselect for multi-exec' : 'Select for multi-exec',
      icon: state.checkedHosts.has(host.id) ? '\u2611' : '\u2610',
      onClick: () => {
        state.checkedHosts.has(host.id)
          ? state.checkedHosts.delete(host.id)
          : state.checkedHosts.add(host.id);
        // Announced like a tick, so multi-exec's targets and the status bar
        // follow; the sidebar redraws on the same event.
        state.emit('checked');
        updateStatusBar();
      },
    },
    { sep: true },
    ...(host.type === 'teleport' ? [{
      label: 'Open with MFA (tsh ssh)', icon: '\u26BF',
      onClick: () => openMfa(host, logins[0]),
    }, {
      label: isMfaHost(host.id) ? 'Forget that this needs MFA' : 'Remember as an MFA server',
      icon: '\u26BF',
      onClick: () => setMfaHost(host, !isMfaHost(host.id)),
    }] : []),
    /*
     * X11 lived here on its own. It is one of the SSH options now, with
     * forwards, a jump host and Teleport's reason and invitations — kept per
     * host as a default, or as presets opened only when picked.
     */
    sshOptionsMenu(host, { login: logins[0], hostPrefKey, openX11 }),
    agentForwardMenu(host),
    { sep: true },
    {
      label: 'Run a command…', icon: '\u25B8',
      onClick: () => openRunCommandDialog(host, { login: preferred || logins[0], logins }),
    },
    // Teleport measures both halves of the path — you to the proxy, and the
    // proxy to the node — which is the question when a session feels slow but
    // ping to the proxy looks fine.
    ...(host.type === 'teleport' ? [{
      label: 'Latency to this node…', icon: '\u21C4',
      title: 'tsh latency ssh — round trip to the proxy and from the proxy to the node, live',
      onClick: () => openLatency(host, preferred),
    }] : []),
    /*
     * `preferred`, not `logins[0]`.
     *
     * The first login the cluster grants is an alphabetical accident —
     * `ec2-user` on a cluster that also grants `ubuntu` and `rocky` — and it
     * is not necessarily an account on this node. preferredLogin is the whole
     * point of the setting: what was said for this host, else what last
     * worked on it, and only then the cluster's first. Opening these two as
     * logins[0] meant the profile could fail as a user the terminal had never
     * used.
     */
    {
      label: 'Port forward…', icon: '\u21C6',
      onClick: () => openPortForwardDialog(host, { login: preferred }),
    },
    {
      label: 'Server profile…', icon: '\u2139',
      onClick: () => openServerInfo(host, { login: preferred }),
    },
    ...(host.type === 'teleport' ? [{
      label: `Tags (${labelEntries(host).length})…`, icon: '\u2691',
      onClick: () => openHostTags(host),
    }, {
      label: showTags() ? 'Stop showing tags in the list' : 'Show tags in the list', icon: '\u2691',
      onClick: () => toggleShowTags(),
    }, {
      label: showHeartbeats() ? 'Stop showing last heartbeats' : 'Show last heartbeats', icon: '\u2665',
      onClick: () => toggleShowHeartbeats(),
    }, {
      /*
       * Three named states rather than one item that cycles — a menu has room
       * to show which of them the list is in — but three lines of their own
       * is three lines spent on a setting most people change once. One entry
       * that says where it stands, and the choices behind it.
       */
      label: `Quiet nodes: ${({ all: 'shown in place', hide: 'hidden', only: 'only these' })[quietFilter()] || 'shown in place'}`,
      icon: '\u266A',
      title: 'Nodes that have stopped heartbeating but are still listed',
      submenu: [
        {
          label: 'Show them in place',
          key: quietFilter() === 'all' ? '✓' : '',
          onClick: () => setQuietFilter('all'),
        },
        {
          label: 'Hide them',
          key: quietFilter() === 'hide' ? '✓' : '',
          onClick: () => setQuietFilter('hide'),
        },
        {
          label: 'Show only these',
          key: quietFilter() === 'only' ? '✓' : '',
          onClick: () => setQuietFilter('only'),
        },
      ],
    }, { sep: true }, {
      label: 'Active sessions on this host…', icon: '\u21C4',
      title: 'Watch, join or moderate a session that is going on here now',
      onClick: async () => (await import('./livesessions.js')).openActiveSessions({
        proxy: host.proxy, home: host.home || null,
        match: [host.name, host.hostname, host.uuid],
        title: `Active sessions on ${host.name}`, subtitle: host.cluster || host.proxy,
      }),
    }, {
      label: 'Recorded sessions for this host…', icon: '\u25CE',
      onClick: async () => {
        const { openSessionsDialog } = await import('./recordings.js');
        openSessionsDialog('recordings', { filter: host.name, proxy: host.proxy });
      },
    }] : []),
    {
      label: 'Forget host key…', icon: '\u26BF',
      onClick: async () => {
        const { forgetHostKey } = await import('./keys.js');
        const ctx = host.type === 'teleport' ? undefined : { alias: host.alias, configFile: host.configFile };
        forgetHostKey(host.type === 'teleport' ? `${host.name}.${host.cluster}` : host.hostname || host.alias, ctx);
      },
    },
    { sep: true },
    {
      label: isHidden(host) ? 'Show in list' : 'Hide from list',
      onClick: () => setHidden(host, !isHidden(host)),
    },
    {
      label: state.settings.showHiddenHosts ? 'Stop showing hidden hosts' : 'Show hidden hosts',
      onClick: () => toggleShowHidden(),
    },
    { sep: true },
    { label: 'Save as profile…', onClick: () => openProfileEditor(profileFromHost(host)) },
    ...(host.type === 'ssh' && (state.managedSshHosts || []).includes(host.alias) ? [{
      label: 'Remove from ~/.ssh/config',
      onClick: () => removeManagedHost(host.alias),
    }] : []),
    ...(host.type === 'ssh' && host.source ? [
      {
        label: 'Delete or comment out in ssh config…', icon: '\u2716',
        title: `Take "${host.alias}" out of ${host.source}, after showing you its block`,
        onClick: () => removeSshConfigHost(host),
      },
      {
        label: 'New host in this config…', icon: '+',
        title: 'Write a new Host block into ' + (host.configRoot || host.source),
        onClick: () => openAddServerDialog({ configFile: host.configFile || null }),
      },
      {
        label: 'Edit its ssh config…', icon: '\u270E',
        title: host.source,
        onClick: () => openSshConfigInEditor(host.source),
      },
    ] : []),
    // Only once the probe above has actually found it missing \u2014 never
    // guessed at, and never shown with the detection setting off.
    ...(host.type !== 'teleport' && state.settings.detectTeleportOnSsh !== false
      && teleportPresenceCache.get(host.id) && teleportPresenceCache.get(host.id) !== 'loading'
      && !teleportPresenceCache.get(host.id).installed ? [{
        label: 'Install Teleport on this host\u2026', icon: '\u26A1',
        title: 'Generates a join token and the commands to enroll this machine',
        onClick: () => openInstallTeleportOnHostWizard(host),
      }] : []),
    {
      label: 'Copy ssh command',
      onClick: () => {
        const cmd = host.type === 'teleport'
          ? `tsh ssh ${logins[0] ? logins[0] + '@' : ''}${host.name}`
          : `ssh ${host.alias}`;
        window.api.clipboard.write(cmd);
        status('Copied: ' + cmd);
      },
    },
  ];
  contextMenu(e.clientX, e.clientY, items);
}

function profileFromHost(host) {
  if (host.type === 'teleport') {
    return {
      name: host.name, type: 'teleport', node: host.name,
      cluster: host.cluster, proxy: host.proxy,
      login: (loginOptionsFor(host)[0] || ''),
    };
  }
  return {
    name: host.alias, type: 'ssh', alias: host.alias,
    hostname: host.hostname, user: host.user, port: host.port,
  };
}

export function pickLogin(logins, host, { title = 'Open as user', subtitle, note } = {}) {
  return modal({
    title,
    subtitle: subtitle || host.name || host.alias,
    render: (body, { close }) => {
      const current = preferredLogin(host);
      if (note) body.append(el('div', { class: 'hint', style: 'margin-bottom:9px', text: note }));
      const list = el('div', { class: 'picker-list' });
      for (const l of logins) {
        list.append(el('div', {
          class: 'picker-item' + (l === current ? ' active' : ''),
          onClick: () => close(l),
        },
          el('span', { class: 'pname', text: l }),
          l === current ? el('span', { class: 'tag', text: 'default' }) : null));
      }
      if (logins.length) body.append(list);
      /*
       * A name that is not on the list.
       *
       * For a Teleport node the list is the certificate's principals and a
       * name outside it will be refused — but a plain ssh host has no such
       * list at all, and on a cluster the principals can be a wildcard that
       * no list can enumerate. Refusing to let someone type a name would
       * make this dialog useless in exactly the cases it is opened for.
       */
      const other = textInput({ placeholder: 'another user name', autofocus: !logins.length });
      other.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && other.value.trim()) close(other.value.trim());
      });
      body.append(el('div', { class: 'field', style: 'margin-top:10px' },
        el('label', { text: logins.length ? 'Or a name that is not listed' : 'User name' }),
        other));
      body.append(el('div', { class: 'hint', style: 'margin-top:9px' },
        'The one that connects is remembered for this host.'));
      body._other = other;
    },
    buttons: [
      { label: 'Cancel', value: undefined },
      {
        label: 'Use this name',
        class: 'primary-btn',
        onClick: ({ close, body }) => {
          const v = body._other?.value.trim();
          if (v) close(v);
        },
      },
    ],
  });
}

/* ---------------------------- hosts tab ---------------------------- */

function renderHostsTab() {
  const panel = $('#sb-panel-hosts');
  clear(panel);
  drawnHosts.clear();

  if (state.loadingInventory && !state.teleportNodes.size && !state.sshHosts.length) {
    panel.append(el('div', { class: 'sb-empty sb-scanning' },
      el('div', { class: 'sb-radar' },
        el('div', { class: 'sb-radar-sweep' }),
        el('span', { class: 'sb-radar-blip b1' }),
        el('span', { class: 'sb-radar-blip b2' }),
        el('span', { class: 'sb-radar-blip b3' })),
      el('div', { class: 'sb-scanning-text', text: 'Loading inventory…' })));
    return;
  }

  // The All/SSH/K8s control above the list. A Teleport-sourced kube cluster
  // nests inside its own cluster's group below, the same place beams do —
  // only a context with no Teleport cluster behind it (raw EKS/GKE/kind, see
  // kubepanel.js) shows up in its own flat group, appended at the end.
  const kindShown = hostKindShown();

  /*
   * Starred hosts, first and together. Skipped for "K8s only": starring has
   * no Kubernetes analogue yet, so the section could only ever be empty.
   *
   * They stay in their own cluster's group as well, marked with the star —
   * moving them out would leave a cluster's list quietly incomplete, which is
   * worse than naming a host twice. The group is orderable and collapsible
   * like any other, so it can be pushed down or shut if it stops being useful.
   */
  const starred = kindShown !== 'kube' && starredMode() === 'group' ? starredHosts().filter(visibleHost) : [];
  if (starred.length) {
    panel.append(group('Starred', starred.length, 'starred',
      starred.map((h) => hostRow(h, h.type === 'teleport' ? labelSummary(h) : (h.viaTsh ? 'tsh' : h.user), 'starred')),
      el('span', { class: 'gtags' },
        el('span', {
          class: 'tag',
          title: 'Starred hosts are gathered here. Their menu can put them back at the top of their own group instead.',
          text: 'gathered',
        }))));
  }

  // Teleport clusters
  const beamNodes = beamNodeNames();
  for (const p of [...state.teleportProfiles, ...savedOnlyProfiles()]) {
    const nodes = state.teleportNodes.get(tpKey(p)) || [];
    /*
     * A running beam registers as a node called `beam-<uuid>`. It is already
     * listed under its own name, with its region and its expiry, in the beams
     * group — so leaving it here too would list it twice, once in a form
     * nothing can be done with.
     */
    /*
     * What you hold, and — where the cluster's heading menu has asked for
     * it — what you could ask for. Anything reachable wins: the same node
     * cannot be both, and the row you can open is the more useful one.
     */
    const reachable = nodes.filter((n) => !beamNodes.has(n.name));
    const askable = requestableHostsFor(p);
    const have = new Set(reachable.map((n) => n.uuid).filter(Boolean));
    /*
     * Under an assumed resource request the list holds only what was granted.
     * The rest of the cluster is still there, so it is still drawn — dimmed,
     * from the last full read — rather than the group shrinking to one row.
     */
    const held = heldBackFor(p, reachable);
    for (const h of held) if (h.uuid) have.add(h.uuid);
    // Kube clusters are host-shaped for exactly this reason: they fall into
    // this same list, the same folders (by hand or by a label rule) and the
    // same filter box as the SSH nodes beside them, rather than a second
    // tree with its own rules to learn.
    const kubeHosts = kindShown === 'ssh' ? [] : kubeHostsForProfile(p);
    const sshHosts = kindShown === 'kube' ? [] : [...reachable, ...held, ...askable.filter((h) => !have.has(h.uuid))];
    const shown = [...sshHosts, ...kubeHosts].filter(visibleHost);
    if (p.expired) {
      /*
       * A lapsed certificate says nothing about the machines behind it, so
       * the hosts you were watching are still watched and the ones already
       * gone are still gone. They were being dropped here: this branch
       * draws the group with a login prompt and no rows at all, so every
       * ghost on the cluster disappeared the moment the session expired —
       * which is a daily event, and exactly when you are least able to go
       * and check for yourself.
       */
      const expiredGhosts = [
        ...missingIn(groupKeyFor(p), []),
        ...unconfirmedIn(groupKeyFor(p), []),
      ].filter(visibleHost).filter(inKindShown);
      /*
       * Everything else the last successful read had, not only the hosts
       * someone happened to mark — Settings → "Show the last known hosts"
       * says whether to, and for how long. Off by default: this is the
       * one thing here that was never asked for ahead of time, so showing
       * it costs a cluster's whole last inventory in screen space, every
       * time it logs out, for anyone who has not turned it on.
       */
      const listMode = state.settings.expiredListMode || 'off';
      let lastKnown = [];
      if (listMode !== 'off' && kindShown !== 'kube') {
        const maxAgeMs = listMode === 'always'
          ? null
          : (Number(state.settings.expiredListHours) || 1) * 3600000;
        const read = lastFullReadFor(p, maxAgeMs);
        if (read) {
          const alreadyShown = new Set(expiredGhosts.map((h) => h.uuid).filter(Boolean));
          lastKnown = read.nodes
            .filter((n) => n.uuid && !alreadyShown.has(n.uuid))
            .map((n) => ({ ...n, unconfirmed: true, lastSeen: read.at }))
            .filter(visibleHost);
        }
      }
      const g = group(p.cluster || p.saved?.name || p.proxy, 0, groupKeyFor(p), [
        ...expiredGhosts.map((h) => hostRow(h, labelSummary(h), groupKeyFor(p))),
        ...lastKnown.map((h) => hostRow(h, labelSummary(h), groupKeyFor(p))),
        /*
         * Indented like the rows a live cluster would have here, with the
         * same hairline rail down its left. Sitting flush against the panel
         * edge, it read as a notice about the app rather than about the
         * cluster whose heading is directly above it — which matters most
         * in a sidebar of six clusters where only one has lapsed.
         */
        el('div', { class: 'sb-empty sb-expired' },
          el('div', { class: 'sb-expired-line', text: p.savedOnly ? 'Not logged in.' : 'Session expired.' }),
          el('div', { style: 'display:flex;gap:6px;margin-top:7px;flex-wrap:wrap' },
            el('button', {
              class: 'ghost-btn sm',
              text: 'tsh login',
              onClick: async () => {
                const tp = await import('./teleportpanel.js');
                const saved = await tp.savedClusterFor(p);
                /*
                 * How the cluster is *saved* to be logged in to, not what the
                 * lapsed certificate happened to say.
                 *
                 * This used to take `--user` from the expired profile — which
                 * every expired profile has — and conclude that tsh was going
                 * to prompt, so it opened a local shell tab to hold the
                 * prompt. On an SSO cluster both halves are wrong: the user
                 * is not how you authenticate there, and the browser flow
                 * needs no terminal at all, so a shell tab opened for nothing
                 * every single time.
                 */
                const opts = {
                  proxy: p.proxy,
                  cluster: p.cluster || saved?.cluster || undefined,
                  home: p.homeDir,
                  user: saved?.user || undefined,
                  authConnector: saved?.authConnector || undefined,
                  ttl: saved?.ttl || undefined,
                  mfaMode: saved?.mfaMode || undefined,
                };
                /*
                 * A terminal is needed wherever tsh asks for something that
                 * needs a real foreground process to answer it — local auth
                 * (a typed password) and passwordless (a Touch ID or
                 * security-key challenge) both qualify, the same two cases
                 * `doLogin` in teleportpanel.js routes this same way, and for
                 * the same reason: a platform-authenticator prompt looks like
                 * a native OS dialog that needs no TTY, but the headless
                 * child process spawned below is never the foreground app,
                 * and on at least one machine that leaves the prompt with
                 * nothing able to answer it. Only a named external
                 * connector — SSO, which opens a browser and waits on an
                 * HTTP callback — is actually fine in the background.
                 */
                if (opts.user
                    && (!opts.authConnector || opts.authConnector === 'local' || opts.authConnector === 'passwordless')) {
                  return tp.runLoginInShell(opts);
                }
                status('Running tsh login…', 0);
                const r = await window.api.teleport.login(opts);
                status('');
                if (r.ok) { toast('Logged in', 'success'); refreshInventory(); }
                else toast('Login failed — copy the command and run it in a terminal', 'error');
                return undefined;
              },
            }),
            // Some logins only go through in a real terminal — a hardware key
            // that wants a TTY, an SSO flow already open in a browser.
            el('button', {
              class: 'ghost-btn sm',
              text: 'Copy login cmd',
              title: 'Copy the tsh login command, ready to paste into a terminal',
              onClick: () => copyLoginCommand(p),
            }),
            /*
             * And the way out.
             *
             * An expired cluster stays listed because its profile file is
             * still in the tsh home — that is what `tsh status` reads, so
             * the app shows it too. A lab that was torn down never comes
             * back, and until now the only way to stop seeing it was buried
             * in the heading's right-click menu. It belongs here, next to
             * the two things you would otherwise do with a dead cluster.
             */
            // A pinned saved cluster has no profile files to remove; the way
            // out is to stop pinning it.
            p.savedOnly
              ? el('button', {
                  class: 'ghost-btn sm',
                  text: 'Unpin',
                  title: 'Stop showing this saved cluster here while it is not logged in. The saved login is kept.',
                  onClick: () => unpinSavedCluster(p.saved),
                })
              : el('button', {
              // Plain, like the two beside it: the weight belongs in the
              // confirmation, which names every file, not in a red button
              // sitting in the sidebar all day.
              class: 'ghost-btn sm',
              text: 'Remove',
              title: 'Delete this profile from the tsh home, so it stops being listed',
              onClick: () => removeExpiredProfile(p),
            }))),
      ], el('span', { class: 'gtags' },
        homeTag(p),
        clusterRequestTag(p),
        p.savedOnly
          ? el('span', {
              class: 'tag expired',
              title: 'Not in tsh status — shown because this saved cluster is pinned to the Hosts tab',
              text: 'logged out',
            })
          : el('span', { class: 'tag expired', title: 'The certificate has lapsed — log in again', text: 'expired' }),
        refreshTag(groupKeyFor(p), 'Re-read this cluster',
          () => (p.savedOnly ? refreshInventory(true) : refreshProfile(p)))), p);
      panel.append(g);
      continue;
    }
    const beamRows = kindShown === 'kube' ? [] : beamSection(p);
    // "K8s only": a cluster with no kube clusters of its own has nothing to
    // show here at all, not even an empty heading. (shown is kube-only
    // already, in that mode — see where it is built, above.)
    if (kindShown === 'kube' && !shown.length) continue;
    if (!shown.length && !beamRows.length && filterText) continue;
    panel.append(group(
      p.cluster || p.proxy, shown.length, groupKeyFor(p),
      [
        /*
         * Built first, then asked whether it came to anything: a group can
         * have no nodes on screen and still have rows — a watched host that
         * has left the inventory is drawn from its own record, and deciding
         * on the node count alone hid exactly the row that was the news.
         */
        ...(() => {
          const rows = groupRows(groupKeyFor(p), shown, (n) => labelSummary(n));
          const note = narrowedNote(p, reachable.length);
          if (note) rows.unshift(note);
          return rows.length ? rows : [el('div', {
            class: 'sb-empty',
            text: kindShown === 'kube' ? 'No Kubernetes clusters visible.' : 'No nodes visible.',
          })];
        })(),
        ...beamRows,
      ],
      // Which home a cluster came from sits alongside the active marker: with
      // the same cluster in two homes, the name alone does not say which. The
      // leaf badge is the same idea — the heading names one cluster, and this
      // says whether there are others behind it.
      el('span', { class: 'gtags' },
        homeTag(p),
        leafClusterTag(p),
        // What is outstanding on this cluster specifically, clickable straight
        // into its request list.
        clusterRequestTag(p),
        refreshTag(groupKeyFor(p), 'Re-read this cluster: its nodes, its leaves and its beams',
          () => refreshProfile(p)),
        // Beams are inside this group, so the heading counts them where the
        // node count cannot.
        beamsSupported(p.proxy) && beamsFor(p.proxy).length
          ? el('span', {
              class: 'tag beams',
              title: `${beamsFor(p.proxy).length} beam(s) running on this cluster`,
              text: beamsFor(p.proxy).length + ' beams',
            })
          : null,
        vnetTag(p),
        envTag(p),
        p.active
          ? el('span', {
              class: 'tag live',
              title: 'Plain tsh commands use this cluster',
              text: 'active',
            })
          : null,
        // Same warning the Clusters panel shows, here too — the Hosts tab
        // is where most time is actually spent, and a login that is about
        // to lapse is easy to miss if it only shows up somewhere else.
        expiringSoon(p)
          ? el('span', {
              class: 'tag soon', style: 'cursor:pointer',
              title: 'Certificate expires soon — click to log out and back in now',
              text: `⏳ ${formatUntil(p.validUntil)} left`,
              onClick: (e) => {
                // The heading collapses when clicked, and is draggable;
                // neither should happen because someone aimed at the badge
                // on it — same fix as refreshTag just above.
                e.preventDefault();
                e.stopPropagation();
                doRelogin(p);
              },
            })
          : null),
      p));
  }

  // Every cluster filtered itself out: say so, and say how the query reads,
  // rather than leaving the panel looking like the inventory failed to load.
  if (filterText && state.teleportProfiles.some((p) => !p.expired)
      && ![...state.teleportNodes.values()].flat().some(visibleHost)) {
    panel.append(el('div', { class: 'sb-empty' },
      el('div', { text: `No Teleport node matches ${filterText}.` }),
      el('div', { style: 'margin-top:6px;opacity:.75', text: 'Tags match as key=value, key:partial, key=a,b for either, or -key=value to exclude.' }),
      el('div', { style: 'display:flex;gap:6px;margin-top:9px' },
        el('button', { class: 'ghost-btn sm', text: 'Browse tags…', onClick: () => $('#btn-tags').click() }),
        el('button', { class: 'ghost-btn sm', text: 'Clear filter', onClick: () => setFilter('') }))));
  }

  if (state.teleportError && !state.teleportProfiles.length && (tshMissing() || !savedOnlyProfiles().length)) {
    const missing = tshMissing();
    panel.append(group('Teleport', 0, 'tp:none', [
      el('div', { class: 'sb-empty' },
        el('div', { text: missing ? 'tsh was not found on this machine.' : state.teleportError }),
        el('div', {
          style: 'margin-top:6px;opacity:.75',
          text: missing
            ? 'Clusters are read through tsh, so nothing can be listed until it is located.'
            : 'Run tsh login, then Refresh.',
        }),
        missing
          ? el('button', {
              class: 'ghost-btn sm', style: 'margin-top:9px',
              text: 'Locate tsh…',
              onClick: async () => (await import('./index.js')).locateTsh(),
            })
          : null),
    ]));
  }

  // ssh_config hosts are SSH-only, so "K8s only" leaves them out. The Local
  // group below is not: a local shell, the AI assistants and the network
  // tools are as much for working on a cluster as on a server.
  if (kindShown !== 'kube') {
  // SSH config hosts
  const sshShown = state.sshHosts.filter(visibleHost);
  /*
   * With no ssh client these hosts are real but unreachable — Teleport nodes
   * fall back to `tsh ssh`, an ssh_config alias has no such route. They stay
   * listed, with the reason above them, rather than vanishing as though the
   * config were empty.
   */
  const noSshNote = sshMissing()
    ? el('div', { class: 'sb-empty', style: 'text-align:left' },
        el('div', { style: 'color:var(--amber)', text: 'No ssh client on this machine.' }),
        el('div', {
          style: 'margin-top:6px;opacity:.75',
          text: 'These hosts need OpenSSH; Teleport nodes open with tsh ssh instead.',
        }),
        el('button', {
          class: 'ghost-btn sm', style: 'margin-top:9px',
          text: 'Locate ssh…',
          onClick: async () => (await import('./index.js')).locateTsh(),
        }))
    : null;

  /*
   * One group per config file, in the order they are configured.
   *
   * A file is its own group rather than one merged list because the file is
   * the thing that decides how its hosts connect: an extra config is opened
   * with `ssh -F <file>`, so two aliases of the same name in two files are
   * genuinely two hosts, and a merged list could not say which was which.
   */
  const roots = configRoots();
  for (const root of roots) {
    const mine = sshShown.filter((h) => (h.configRoot || '') === root.file
      // A config read before this list arrived has no root recorded; it can
      // only have come from the primary file.
      || (root.primary && !h.configRoot));
    const key = root.primary ? 'ssh' : 'ssh:' + root.file;
    if (!root.primary && filterText && !mine.length) continue;
    const sshRows = groupRows(key, mine, (h) => (h.viaTsh ? 'tsh' : (h.proxied ? 'proxy' : h.user)));
    const rows = sshRows.length
      ? [root.primary ? noSshNote : null, ...sshRows]
      : [root.primary ? noSshNote : null, el('div', { class: 'sb-empty' },
          el('div', {
            text: filterText ? 'No matches.'
              : root.exists === false ? 'That file is not there.'
              : `No hosts in ${root.label}.`,
          }),
          filterText ? null : el('button', {
            class: 'ghost-btn', style: 'margin-top:9px',
            text: root.primary ? 'Add a server…' : 'Manage config files…',
            onClick: () => (root.primary ? openAddServerDialog() : openSshConfigDialog()),
          }))];
    panel.append(group(root.label, mine.length, key, rows.filter(Boolean),
      el('span', { class: 'gtags' },
        root.exists === false ? el('span', { class: 'tag', title: root.file, text: 'missing' }) : null,
        !root.primary ? el('span', { class: 'tag', title: root.file, text: '-F' }) : null,
        refreshTag(key, 'Re-read the ssh config files', () => refreshSshConfigs(key)))));
  }
  } // ssh_config hosts: not in "K8s only"

  // Local shell shortcut
  const localRow = el('div', { class: 'sb-item', title: 'Open a shell on this machine' },
    el('span', { class: 'st', style: 'background:var(--purple)' }),
    el('span', { class: 'name', text: 'Local shell' }));
  const openLocal = () => import('./sessions.js').then((m) => m.openLocalShell());
  const splitLocal = (dir) => import('./sessions.js').then((m) => m.splitActivePane(dir, { local: true }));
  localRow.addEventListener('dblclick', openLocal);
  // A local shell splits like any host does — it was the one row in the list
  // with no menu, which made "put a local pane next to this" impossible.
  localRow.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    /*
     * Which shell, and whether it reads its startup files.
     *
     * Two questions people actually have: "what does this look like in bash
     * rather than my zsh" and "is my rc file the problem". The list is what is
     * installed on this machine, read at startup so the menu opens at once.
     */
    const shells = shellCache;
    const openWith = (sh, blank) => import('./sessions.js').then((m) => m.openLocalShell(undefined, {
      shell: sh.path,
      blank,
      title: `${sh.name}${blank ? ' (blank)' : ''}`,
    }));
    contextMenu(e.clientX, e.clientY, [
      { label: 'Open local shell', onClick: openLocal },
      shells.length ? {
        label: 'Open another shell',
        title: 'The shells installed on this machine',
        submenu: shells.map((sh) => ({
          label: shellLabel(sh, shells),
          key: sh.note || '',
          title: sh.path,
          onClick: () => openWith(sh, false),
        })),
      } : null,
      shells.length ? {
        label: 'Open with a blank configuration',
        title: 'No profile, no rc file — what a script sees, and a way in when an rc file is broken',
        submenu: shells.filter((sh) => sh.canBlank).map((sh) => ({
          label: shellLabel(sh, shells),
          key: sh.note || '',
          title: `${sh.path} with its startup files skipped`,
          onClick: () => openWith(sh, true),
        })),
      } : null,
      // tmux on this laptop, the same as on a server — except on Windows,
      // where there is no native tmux and the option would only fail.
      hostStyleMenu('local'),
      state.appInfo?.platform !== 'win32' ? {
        label: 'Open in tmux…', icon: '\u267B',
        title: 'A tmux session on this machine — what runs in it keeps running when this window closes',
        onClick: async () => {
          const t = await import('./tmux.js');
          t.openTmuxDialog(t.localTmuxHost());
        },
      } : null,
      { sep: true },
      { label: 'Open beside current (split right)', onClick: () => splitLocal('row') },
      { label: 'Open below current (split down)', onClick: () => splitLocal('col') },
      { sep: true },
      {
        label: 'Show local files in this pane',
        onClick: async () => {
          const pane = state.activePane;
          if (!pane) return toast('Open a session first', 'error');
          const { togglePaneLocalExplorer } = await import('./sessions.js');
          togglePaneLocalExplorer(pane.id, true);
        },
      },
    ].filter(Boolean));
  });

  // Not a host, but it belongs with the things that are about this machine
  // rather than a server, and it is where you go when a host will not answer.
  const netRow = el('div', {
    class: 'sb-item',
    dataset: { tour: 'nettools' },
    title: 'Ping, traceroute, DNS, ports, TLS, HTTP and cluster info (⌘⇧T)',
  },
    el('span', { class: 'st', style: 'background:var(--accent)' }),
    el('span', { class: 'name', text: 'Network and certificate tools' }));
  const openNet = () => import('./nettools.js').then((m) => m.openNetTools());
  netRow.addEventListener('dblclick', openNet);
  netRow.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [{ label: 'Open network and certificate tools…', onClick: openNet }]);
  });

  /*
   * The keys this machine can authenticate with. It belongs beside the local
   * shell and the network tools: all three are about this machine rather than a
   * server, and "which key am I actually offering, and is the agent holding
   * it?" is a question asked while a host is refusing you — not one worth
   * hunting through a menu for.
   */
  const keysRow = el('div', {
    class: 'sb-item',
    dataset: { tour: 'keys' },
    title: 'Keypairs in ~/.ssh, their fingerprints and what the agent holds (⌘⇧K)',
  },
    el('span', { class: 'st', style: 'background:var(--amber)' }),
    el('span', { class: 'name', text: 'SSH keys' }));
  const openKeys = () => import('./keys.js').then((m) => m.openKeysDialog());
  keysRow.addEventListener('dblclick', openKeys);
  keysRow.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Show keys…', key: '⌘⇧K', onClick: openKeys },
      { sep: true },
      {
        label: 'Browse ~/.ssh in the file browser',
        onClick: async () => {
          const { openLocalFiles } = await import('./index.js');
          // Local paths are not tilde-expanded anywhere downstream.
          await openLocalFiles({ path: `${state.appInfo?.home || ''}/.ssh` });
        },
      },
    ]);
  });

  const aiRows = localAiRows();
  // SSH keys and certificates are the one row in Local about SSH alone.
  const localRows = [localRow, ...aiRows, kindShown === 'kube' ? null : keysRow, netRow].filter(Boolean);
  panel.append(group('Local', localRows.length, 'local', localRows));

  // Watched SSH hosts with nowhere left to be drawn: not in "K8s only" either.
  if (kindShown !== 'kube') {

  /*
   * And the watched hosts with nowhere left to be drawn.
   *
   * Every ghost belongs to a group, and up to here each one has been drawn
   * inside its own — which silently fails the moment that group is not on
   * screen: a cluster logged out of, a profile removed, a proxy renamed so
   * the key no longer matches. The record is still kept, so the app still
   * knows the machine has gone; it just had nowhere to say so, and a watch
   * that stops being mentioned is a watch you have lost without being told.
   * They are gathered here instead, and leave when you take the watch off
   * them — which is the only thing that should ever end one.
   */
  // A pinned saved cluster draws its own watches, in its own group.
  const orphans = orphanGhosts([...folderGroups().map((g) => g.key), ...savedOnlyProfiles().map(groupKeyFor)])
    .filter(hostMatches);
  if (orphans.length) {
    const goneN = orphans.filter((h) => h.missing).length;
    const unsureN = orphans.length - goneN;
    panel.append(group('Watched', orphans.length, 'gone',
      orphans.map((h) => hostRow(h, labelSummary(h), h.group || 'gone')),
      el('span', { class: 'gtags' },
        goneN ? el('span', {
          class: 'tag gone',
          title: 'Watched hosts that left the inventory, and whose cluster is no longer listed.\nThe record is kept until you stop watching them.',
          text: `${goneN} gone`,
        }) : null,
        /*
         * The state that used to be silent. A cluster you are logged out of
         * draws nothing, so the watches on it simply stopped being
         * mentioned — which reads exactly like "all is well" and is the one
         * thing this must never imply.
         */
        unsureN ? el('span', {
          class: 'tag stale',
          title: 'Watched hosts whose cluster cannot be read — logged out, expired or removed.\nNothing is known about them either way until it can be.',
          text: `${unsureN} unchecked`,
        }) : null)));
  }
  } // if (kindShown !== 'kube')

  // Contexts with no Teleport cluster behind them at all (raw EKS/GKE/kind,
  // etc.) — everything else is nested inside its own cluster's group above.
  if (kindShown !== 'ssh') {
    const rows = kubeGroupRows();
    if (rows.length) panel.append(group('☸ Local kubeconfigs', kubeGroupCount(), 'kube-local', rows));
  }

  applyGroupOrder(panel);
}

/**
 * Put the groups in the user's order. Each group is swapped into the slot
 * another one occupied, so anything else in the panel — a "nothing matched"
 * note, a Teleport error — stays exactly where it was written.
 */
function applyGroupOrder(panel) {
  const groups = [...panel.querySelectorAll(':scope > .sb-group')];
  if (groups.length < 2 || !(state.settings.hostGroupOrder || []).length) return;
  const ordered = orderedGroups(groups);
  const slots = groups.map((g) => {
    const marker = document.createComment('group');
    panel.replaceChild(marker, g);
    return marker;
  });
  slots.forEach((marker, i) => panel.replaceChild(ordered[i], marker));
}

/**
 * What is known about a watched host that cannot be looked at now — gone, or
 * on a cluster that cannot be read: the record kept of it, and where it came
 * from. Which cluster and proxy, whether that cluster is logged in now (the
 * usual reason it is unchecked), its node id, last address, labels, and when
 * it was last seen. Every value can be copied.
 */
function openWatchProfile(host) {
  const bare = (x) => String(x || '').replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase();
  const prof = (state.teleportProfiles || []).find((p) => host.proxy && bare(p.proxy) === bare(host.proxy)
    && (!host.cluster || !p.cluster || p.cluster === host.cluster));
  const when = (ms) => (ms ? `${new Date(ms).toLocaleString()} (${goneFor(ms)} ago)` : '');
  const login = !host.proxy ? ''
    : !prof ? 'Not logged in — no tsh profile for this proxy'
      : prof.expired ? `Expired${prof.validUntil ? ` at ${new Date(prof.validUntil).toLocaleString()}` : ''}`
        : `Logged in${prof.username ? ` as ${prof.username}` : ''}${prof.validUntil ? `, valid until ${new Date(prof.validUntil).toLocaleString()}` : ''}`;
  const state_ = host.requestable ? `Requestable — alive, but your roles do not reach it (since ${goneFor(host.requestableSince)} ago)`
      + (host.requestUncheckedSince ? `; not rechecked since ${when(host.requestUncheckedSince)}` : '')
    : host.missing ? `Gone — absent from the cluster’s list since ${when(host.missingSince)}`
      : 'Unchecked — its cluster could not be read, so nothing is known either way';
  const rows = [
    ['Status', state_, 'text'],
    ['Name', host.name],
    ['Hostname', host.hostname && host.hostname !== host.name ? host.hostname : ''],
    ['ssh_config alias', host.alias || ''],
    ['Node id (UUID)', host.uuid || ''],
    ['Cluster', host.cluster || ''],
    ['Proxy', host.proxy || ''],
    ['Cluster login', login, 'text'],
    ['tsh home', host.home || ''],
    // A tunnelled node has no address of its own; "tunnel" is what tsh says.
    ['Last address', host.addr && host.addr !== 'tunnel' ? host.addr : ''],
    ['Connects', host.type === 'teleport' || !host.type ? (host.tunnel ? 'Reverse tunnel (dials the cluster)' : 'Direct') : host.type, 'text'],
    ['Last seen', when(host.lastSeen), 'text'],
  ].filter(([, v]) => v);
  const labels = Object.entries(host.labels || {});
  const copyBtn = (v) => el('button', {
    class: 'icon-btn sm', text: '⧉', title: 'Copy',
    onClick: () => { window.api.clipboard.write(String(v)); status('Copied ' + v); },
  });
  const table = el('div', { class: 'watch-profile' },
    // Values worth pasting get a copy button and a fixed-width face; the
    // sentences around them do not.
    ...rows.map(([k, v, kind]) => el('div', { class: 'wp-row' },
      el('span', { class: 'wp-k', text: k }),
      el('span', { class: 'wp-v' + (kind === 'text' ? ' prose' : ''), text: v }),
      kind === 'text' ? el('span') : copyBtn(v))));
  const labelBox = labels.length ? el('div', { class: 'watch-profile', style: 'margin-top:10px' },
    el('div', { class: 'wp-k', style: 'margin-bottom:4px', text: `Labels (${labels.length})` }),
    ...labels.map(([k, v]) => el('div', { class: 'wp-row' },
      el('span', { class: 'wp-k', text: k }),
      el('span', { class: 'wp-v', text: v }),
      copyBtn(`${k}=${v}`)))) : null;
  const all = [...rows, ...labels.map(([k, v]) => [`label ${k}`, v])].map(([k, v]) => `${k}: ${v}`).join('\n');
  modal({
    title: `${host.name} — watched`,
    width: 'min(620px, 94vw)',
    render: (b) => b.append(table, labelBox || '',
      el('div', { class: 'hint', style: 'margin-top:10px',
        text: 'Kept from the last time the cluster listed it; nothing here is read from the host now.' })),
    buttons: [
      host.proxy && (!prof || prof.expired) ? {
        label: 'Copy the login command', onClick: ({ close }) => {
          close(null);
          window.api.clipboard.write(`tsh login --proxy=${host.proxy}${host.cluster ? ` ${host.cluster}` : ''}`);
          status('Copied the tsh login command');
        },
      } : null,
      { label: 'Copy all', onClick: () => { window.api.clipboard.write(all); status('Copied the record'); } },
      { label: 'Close', class: 'primary-btn', value: null },
    ].filter(Boolean),
  });
}

/** Pick the label a human would actually sort by, not just the first one. */
const LABEL_PRIORITY = ['env', 'environment', 'tier', 'role', 'service', 'app', 'team', 'region', 'az', 'os'];

export function labelSummary(node) {
  // "tunnel" is drawn as its own badge, so it no longer crowds out the label —
  // on a cluster where most nodes dial home, it was all any row ever said.
  const entries = labelEntries(node);
  if (!entries.length) return '';

  const preferred = LABEL_PRIORITY.map((k) => entries.find(([key]) => key.toLowerCase().split('/').pop() === k)).find(Boolean);
  const [k, v] = preferred || entries[0];
  const text = String(v).length > 12 ? String(v).slice(0, 11) + '…' : String(v);
  // A bare "true"/"false" is meaningless on its own — show the key instead.
  const shown = /^(true|false)$/i.test(text) ? k : text;
  return entries.length > 1 ? `${shown} +${entries.length - 1}` : shown;
}

/* ---------------------------- saved tab ---------------------------- */

function renderSavedTab() {
  const panel = $('#sb-panel-saved');
  clear(panel);
  if (savedView === 'macros') return renderMacrosTab(panel);
  if (savedView === 's3') return renderS3Tab(panel);

  const profiles = state.profiles.filter((p) => matches(p.name) || matches(p.alias) || matches(p.node));
  if (!profiles.length) {
    panel.append(el('div', { class: 'sb-empty' },
      el('div', { text: filterText ? 'No matching profiles.' : 'No saved profiles yet.' }),
      el('div', { style: 'display:flex;gap:6px;margin-top:9px;flex-wrap:wrap' },
        el('button', { class: 'ghost-btn', text: 'New profile…', onClick: () => openProfileEditor({}) }),
        el('button', {
          class: 'ghost-btn', text: 'Import…',
          title: 'Load a ServerLife export from another machine',
          onClick: () => runImport(),
        }))));
    return;
  }

  const byFolder = new Map();
  for (const p of profiles) {
    const key = p.folderId || '';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(p);
  }

  for (const folder of [...state.folders, { id: '', name: 'Ungrouped' }]) {
    const items = byFolder.get(folder.id || '') || [];
    if (!items.length) continue;
    panel.append(group(folder.name, items.length, 'sf:' + (folder.id || 'none'),
      items.map((p) => profileRow(p))));
  }

  panel.append(el('div', { style: 'padding:9px 10px;display:flex;gap:6px;flex-wrap:wrap' },
    el('button', { class: 'ghost-btn', text: 'New profile…', onClick: () => openProfileEditor({}) }),
    el('button', {
      class: 'ghost-btn', text: 'Export all…',
      title: 'Profiles, macros, snippets, saved requests, layouts and preferences — everything but the session log',
      onClick: async () => (await import('./backup.js')).exportSettings('all'),
    }),
    el('button', {
      class: 'ghost-btn', text: 'Import…',
      title: 'Load a ServerLife export from another machine',
      onClick: () => runImport(),
    })));
}

/**
 * A saved profile's own colour and icon — stored on the profile record
 * itself (same fields store.js already persists), not the per-host settings
 * map a plain host uses, since a profile already is its own record.
 */
export function profileColor(p) {
  return colorCss(p.color);
}

export function profileIcon(p) {
  return p.icon || '';
}

async function setProfileColor(p, value) {
  await window.api.profiles.save({ id: p.id, color: value || null });
  await reloadProfiles();
  status(value ? `${p.name} is ${value}` : `Colour cleared for ${p.name}`);
}

async function setProfileIcon(p) {
  const { pickIcon } = await import('./ui.js');
  const icon = await pickIcon({ title: 'Icon for this profile', subtitle: p.name, value: p.icon || '' });
  if (icon === null || icon === undefined) return;
  await window.api.profiles.save({ id: p.id, icon: icon || null });
  await reloadProfiles();
  status(icon ? `${p.name} is ${icon}` : 'Icon cleared');
}

/**
 * A saved profile's menu — "Open session", edit, duplicate, delete, plus an
 * sftp-only escape hatch back to a terminal (an sftp profile opens straight
 * into the file browser by default). Exported so the Hosts-pane "Saved"
 * group (hostspane.js) can show the same menu on its own profile cards.
 */
export function profileContextMenuItems(p) {
  /*
   * Serial, telnet, VNC and RDP each open in their own always-new tab —
   * neither launchProfile nor the session opener behind it can land one in
   * an existing pane — so there is nothing honest to offer here for them.
   * ssh, Teleport and sftp all go through openHost/splitActivePane, which
   * can.
   */
  const canSplit = !!state.activePane && !['serial', 'telnet', 'vnc', 'rdp'].includes(p.type);
  return [
    { label: 'Open session', onClick: () => launchProfile(p) },
    ...(p.type === 'sftp' ? [{
      label: 'Open with a terminal',
      onClick: () => launchProfile(p, { forceTerminal: true }),
    }] : []),
    /*
     * Same two lines the Hosts-pane host menu offers once something is open
     * — see the matching comment on onHostContextMenu. A saved profile is a
     * host too; it was just never asked this question before the Hosts-pane
     * "Saved" group gave it a context menu of its own.
     */
    ...(canSplit ? [
      {
        label: 'Open beside current (split right)', icon: 'Ⅾ',
        onClick: () => launchProfile(p, { dir: 'row' }),
      },
      {
        label: 'Open below current (split down)', icon: '‗',
        onClick: () => launchProfile(p, { dir: 'col' }),
      },
    ] : []),
    { sep: true },
    {
      label: 'Mark this profile', icon: profileIcon(p) || '◉',
      title: 'Give it an icon or a colour, same as a plain host',
      submenu: [
        {
          label: p.icon ? `Icon: ${p.icon}` : 'Give it an icon…',
          onClick: () => setProfileIcon(p),
        },
        { sep: true },
        { heading: true, label: 'Colour' },
        ...HOST_COLORS.map((c) => ({
          label: c.label,
          key: (p.color || null) === c.value || (!c.value && !p.color) ? '✓' : '',
          onClick: () => setProfileColor(p, c.value),
        })),
      ],
    },
    { sep: true },
    { label: 'Edit…', onClick: () => openProfileEditor(p) },
    {
      label: 'Duplicate',
      onClick: async () => {
        const copy = { ...p, id: undefined, name: p.name + ' copy' };
        await window.api.profiles.save(copy);
        await reloadProfiles();
      },
    },
    { sep: true },
    {
      label: 'Delete', onClick: async () => {
        if (await confirm({ title: 'Delete profile', message: `Delete “${p.name}”?`, confirmLabel: 'Delete', danger: true })) {
          await window.api.profiles.remove(p.id);
          await reloadProfiles();
        }
      },
    },
  ];
}

function profileRow(p) {
  const icon = profileIcon(p);
  const row = el('div', { class: 'sb-item' },
    el('span', { class: 'st', style: profileColor(p) ? `background:${profileColor(p)}` : '' }),
    el('span', { class: 'name', text: p.name }),
    icon ? el('span', { class: 'hico', text: icon }) : null,
    el('span', { class: 'tag', text: profileKindLabel(p) }));
  row.addEventListener('dblclick', () => launchProfile(p));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, profileContextMenuItems(p));
  });
  return row;
}

/* ------------------------------ S3 -------------------------------- */

/**
 * Registered buckets sit beside profiles and macros, because that is what they
 * are: a saved place, not a live connection. Each one also shows up in every
 * file explorer's source list.
 */
function renderS3Tab(panel) {
  const targets = (state.s3Targets || []).filter((t) =>
    matches(t.name) || matches(t.bucket) || matches(t.region) || matches(t.prefix));

  if (!targets.length) {
    panel.append(el('div', { class: 'sb-empty' },
      el('div', { text: filterText ? 'No matching buckets.' : 'No S3 buckets registered.' }),
      el('div', {
        style: 'margin-top:6px;opacity:.75',
        text: 'Register one and it appears as a source in every file explorer, alongside your sessions.',
      }),
      el('button', {
        class: 'ghost-btn', style: 'margin-top:9px',
        text: 'Register a bucket…', onClick: () => newS3Target(),
      })));
    return;
  }

  panel.append(group('Buckets', targets.length, 's3', targets.map((t) => s3Row(t))));
  panel.append(el('div', { style: 'padding:9px 10px;display:flex;gap:6px;flex-wrap:wrap' },
    el('button', { class: 'ghost-btn', text: 'Register…', onClick: () => newS3Target() }),
    el('button', {
      class: 'ghost-btn', text: 'Manage…',
      onClick: async () => { await (await import('./s3.js')).openS3Manager(); renderSidebar(); },
    })));
}

function s3Row(t) {
  const mode = t.credentials?.mode || 'env';
  const row = el('div', {
    class: 'sb-item',
    title: `${t.bucket}${t.region ? ' · ' + t.region : ''}\n`
      + `${t.prefix ? 'prefix: ' + t.prefix + '\n' : ''}`
      + `uploads as ${t.defaultStorageClass || 'STANDARD'}`,
  },
    el('span', { class: 'st', style: 'background:var(--amber)' }),
    el('span', { class: 'name', text: t.name }),
    el('span', {
      class: 'tag',
      text: mode === 'teleport' ? 'tsh' : mode === 'profile' ? 'aws' : mode === 'explicit' ? 'key' : 'env',
    }));

  row.addEventListener('dblclick', () => openS3InExplorer(t));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Browse in the file explorer', onClick: () => openS3InExplorer(t) },
      {
        label: 'Test connection',
        onClick: async () => {
          status('Testing ' + t.bucket + '…', 0);
          try { const r = await window.api.s3.test(t.id); status(''); toast(`Reached ${r.bucket} in ${r.region}`, 'success'); }
          catch (err) { status(''); toast(err.message, 'error'); }
        },
      },
      { sep: true },
      {
        label: 'Edit…',
        onClick: async () => { await (await import('./s3.js')).openS3Editor(t); renderSidebar(); },
      },
      {
        label: 'Remove',
        onClick: async () => {
          if (!await confirm({
            title: 'Remove bucket',
            message: `Remove “${t.name}”?`,
            detail: 'Only the registration goes. Nothing in S3 is touched.',
            confirmLabel: 'Remove', danger: true,
          })) return;
          await window.api.s3.remove(t.id);
          await (await import('./s3.js')).loadS3Targets();
          renderSidebar();
        },
      },
    ]);
  });
  return row;
}

/** Point the focused pane's explorer at this bucket, opening one if needed. */
async function openS3InExplorer(t) {
  const pane = state.activePane;
  if (!pane?.explorer) {
    const { openLocalShell } = await import('./sessions.js');
    await openLocalShell();
  }
  const target = state.activePane;
  if (!target?.explorer) return toast('Open a session first', 'error');
  const { togglePaneExplorer } = await import('./sessions.js');
  togglePaneExplorer(target.id, true);
  target.explorer.sourceSel.value = 's3:' + t.id;
  target.explorer.sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
  status(`Browsing ${t.name}`);
}

async function newS3Target() {
  const { openS3Editor } = await import('./s3.js');
  await openS3Editor({});
  renderSidebar();
}

/* ---------------------------- macros ------------------------------ */

/**
 * Macros are commands aimed at whatever host you are in, so the list says what
 * each one answers and running one needs no typing. Double-click sends it to
 * the focused terminal; with nothing open, it offers to run it headless.
 */
function renderMacrosTab(panel) {
  const all = state.macros || [];
  const shown = all.filter((m) =>
    matches(m.name) || matches(m.command) || matches(m.description) || matches(m.category));

  /*
   * At the top, not under the list: with the built-ins alone the list runs
   * past the bottom of the sidebar, and these were only reachable by
   * scrolling the whole thing.
   */
  const actions = el('div', { style: 'padding:2px 10px 8px;display:flex;gap:6px;flex-wrap:wrap' },
    el('button', { class: 'ghost-btn', text: 'New macro…', onClick: () => newMacro() }),
    el('button', {
      class: 'ghost-btn', text: 'Restore built-ins',
      title: 'Bring back any built-in macros you have hidden',
      onClick: async () => {
        const { restoreBuiltins } = await import('./macros.js');
        await restoreBuiltins();
        renderSidebar();
      },
    }),
    el('button', {
      class: 'ghost-btn', text: 'Export…',
      title: 'Write your macros to a file',
      onClick: async () => (await import('./backup.js')).exportSettings('macros'),
    }),
    el('button', {
      class: 'ghost-btn', text: 'Import…',
      title: 'Load macros, or a whole settings export, from a file',
      onClick: () => runImport(),
    }));

  const host = activeMacroHost();
  panel.append(el('div', { class: 'sb-note' },
    host
      ? el('span', {}, 'Runs in ', el('b', { text: host.label || host.hostname }))
      : el('span', { text: 'No session focused — macros will offer to run on a host you pick.' })));
  panel.append(actions);

  if (!shown.length) {
    // The buttons above cover it, Restore built-ins included — which is the
    // way back when every built-in has been hidden.
    panel.append(el('div', { class: 'sb-empty' },
      el('div', { text: filterText ? 'No matching macros.' : 'No macros yet.' })));
    return;
  }

  const groups = macroCategories(shown);
  groups.forEach(([category, items], i) => {
    panel.append(group(
      category, items.length, 'mac:' + category,
      items.map((m) => macroRow(m)),
      // Arrows only where they can go somewhere, so the row never offers a
      // control that does nothing.
      groups.length > 1 ? categoryMoveControls(category, i, groups.length) : null));
  });
}

/** Up/down arrows on a category heading, so custom groups can sit on top. */
function categoryMoveControls(category, index, total) {
  const move = async (e, delta) => {
    // The heading itself collapses the group; these must not.
    e.stopPropagation();
    const { moveCategory } = await import('./macros.js');
    if (await moveCategory(category, delta)) renderSidebar();
  };
  return el('span', { class: 'cat-move' },
    el('button', {
      class: 'cat-arrow', title: `Move ${category} up`,
      disabled: index === 0, text: '▲',
      onClick: (e) => move(e, -1),
    }),
    el('button', {
      class: 'cat-arrow', title: `Move ${category} down`,
      disabled: index === total - 1, text: '▼',
      onClick: (e) => move(e, 1),
    }));
}

function macroRow(m) {
  const row = el('div', {
    class: 'sb-item macro-item',
    title: `${m.description ? m.description + '\n\n' : ''}${m.command}`,
  },
    el('span', { class: 'st', style: `background:${m.confirm ? 'var(--amber)' : 'var(--muted)'}` }),
    el('span', { class: 'name', text: m.name }),
    // Its button's own icon, so the list says which glyph in the session
    // header is this macro — the whole point of the icon being chosen.
    isPinned(m.id)
      ? el('span', {
          class: 'tag pinned',
          title: `Pinned as a button — ${scopeLabel(pinnedScopeFor(m.id)).toLowerCase()}`,
          text: pinnedIconFor(m.id),
        })
      : null,
    m.confirm ? el('span', { class: 'tag mfa', title: 'Asks before running', text: 'careful' }) : null,
    m.repeatSeconds ? el('span', { class: 'tag', title: 'Runs on a timer once started', text: 'repeats' }) : null,
    /*
     * Where it can run, when that is not "hosts".
     *
     * Most macros are host commands, so saying so on every row would be noise;
     * the two that are worth flagging are the one that also works locally and
     * the one that only works locally.
     */
    runScopeOf(m) !== 'hosts'
      ? el('span', {
          class: 'tag', title: `Offered in: ${runScopeLabel(runScopeOf(m)).toLowerCase()}`,
          text: runScopeOf(m) === 'local' ? 'local' : 'local too',
        })
      : null,
    m.builtin ? null : el('span', { class: 'tag', text: 'mine' }));

  row.addEventListener('dblclick', () => runMacroHere(m));
  row.addEventListener('contextmenu', (e) => onMacroContextMenu(e, m));
  wireMacroDrag(row, m);
  return row;
}

let dragMacro = null;

/**
 * Drag a macro to put it where you want it — the ▶ menu follows the same
 * order. Dropped on a row in another category, your own macro moves into that
 * category; a built-in stays in its own (see moveMacro).
 */
function wireMacroDrag(row, m) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragMacro = m;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', m.id); } catch { /* a drag without a payload still moves the row */ }
  });
  row.addEventListener('dragend', () => {
    dragMacro = null;
    row.classList.remove('dragging');
    for (const n of document.querySelectorAll('.macro-item.drop-before, .macro-item.drop-after')) {
      n.classList.remove('drop-before', 'drop-after');
    }
  });
  row.addEventListener('dragover', (e) => {
    if (!dragMacro || dragMacro.id === m.id) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    row.classList.toggle('drop-before', !after);
    row.classList.toggle('drop-after', after);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', async (e) => {
    if (!dragMacro) return;
    e.preventDefault();
    e.stopPropagation();
    const after = row.classList.contains('drop-after');
    row.classList.remove('drop-before', 'drop-after');
    const moving = dragMacro;
    const { moveMacro } = await import('./macros.js');
    if (await moveMacro(moving.id, m.id, { after })) {
      status((moving.category || 'Custom') === (m.category || 'Custom')
        ? 'Macro order saved'
        : `Moved ${moving.name} to ${m.category || 'Custom'}`);
      renderSidebar();
    }
  });
}

/** The host behind the focused pane, if any. */
function activeMacroHost() {
  const conn = state.activeConnId ? state.getConnection(state.activeConnId) : null;
  if (!conn) return null;
  return { id: conn.hostId, label: conn.label, hostname: conn.hostname, user: conn.user };
}

/** Find the sidebar host descriptor a connection came from, for headless runs. */
export function hostById(id) {
  for (const nodes of state.teleportNodes.values()) {
    const n = nodes.find((x) => x.id === id);
    if (n) return n;
  }
  return state.sshHosts.find((h) => h.id === id) || null;
}

async function runMacroHere(m) {
  const { sendMacro, runMacroOnHost } = await import('./macros.js');
  if (state.activePane?.termId) return sendMacro(m);

  // Nothing focused: fall back to running it on a host the user picks.
  const host = await pickMacroHost();
  if (host) await runMacroOnHost(m, host, preferredLogin(host));
}

async function pickMacroHost() {
  const hosts = [...[...state.teleportNodes.values()].flat(), ...state.sshHosts].filter(visibleHost);
  if (!hosts.length) { toast('No hosts available', 'error'); return null; }
  return modal({
    title: 'Run on which host?',
    render: (body, { close }) => {
      const list = el('div', { class: 'picker-list' });
      for (const h of hosts.slice(0, 200)) {
        list.append(el('div', { class: 'picker-item', onClick: () => close(h) },
          el('span', { class: 'pname', text: h.name || h.alias }),
          el('span', { class: 'tag', text: h.type === 'teleport' ? h.cluster : 'ssh' })));
      }
      body.append(list);
    },
    buttons: [{ label: 'Cancel', value: null }],
  });
}

function onMacroContextMenu(e, m) {
  e.preventDefault();
  const conn = activeMacroHost();
  const items = [
    { label: conn ? `Send to ${conn.label || conn.hostname}` : 'Send to focused terminal', onClick: () => runMacroHere(m) },
    {
      label: 'Send to every pane in this tab',
      onClick: async () => (await import('./macros.js')).sendMacro(m, { all: true }),
    },
    {
      label: 'Run on a host and show output…',
      onClick: async () => {
        const { runMacroOnHost } = await import('./macros.js');
        const host = await pickMacroHost();
        if (host) runMacroOnHost(m, host, preferredLogin(host));
      },
    },
    // Repeating needs a live terminal to type into, and a command that ends.
    !m.interactive && !m.noEnter ? {
      label: 'Repeat in the focused pane every…',
      disabled: !state.activePane?.termId,
      title: state.activePane?.termId ? null : 'Open a session first',
      onClick: async () => (await import('./macros.js')).promptRepeat(m),
    } : null,
    { sep: true },
    // A button in every session header, for the two or three you run so often
    // that opening a menu for them is the slow part. Built-ins pin too.
    {
      label: isPinned(m.id) ? 'Unpin from session headers' : 'Pin as a button…',
      onClick: async () => {
        await (await import('./macros.js')).togglePin(m);
        renderSidebar();
      },
    },
    {
      label: 'Copy command',
      onClick: () => { window.api.clipboard.write(m.command); status('Copied'); },
    },
    {
      label: m.builtin ? 'Duplicate and edit…' : 'Edit…',
      onClick: async () => {
        const { editMacro } = await import('./macros.js');
        await editMacro(m.builtin ? { ...m, name: m.name + ' copy' } : m);
        renderSidebar();
      },
    },
    {
      label: m.builtin ? 'Hide this built-in' : 'Delete',
      onClick: async () => {
        const { deleteMacro } = await import('./macros.js');
        if (await deleteMacro(m)) renderSidebar();
      },
    },
  ];
  contextMenu(e.clientX, e.clientY, items.filter(Boolean));
}

/** Import, then reload everything it may have changed. */
async function runImport() {
  const { importSettings } = await import('./backup.js');
  if (await importSettings()) {
    state.settings = await window.api.settings.get();
    const { applyTheme } = await import('./index.js');
    applyTheme();
    await refreshInventory();
  }
}

async function newMacro() {
  const { editMacro } = await import('./macros.js');
  await editMacro({});
  renderSidebar();
}

/**
 * What a saved connection is, in one word, for the tag on its row.
 */
export function profileKindLabel(p) {
  return ({ teleport: 'tsh', sftp: 'sftp', serial: 'serial', telnet: 'telnet', vnc: 'vnc', rdp: 'rdp' })[p?.type] || 'ssh';
}

/**
 * Open a saved connection — whatever kind it is.
 *
 * The four new kinds are not hosts in the sense the rest of this file means
 * by it: there is no connection to reuse, no login to remember and nothing to
 * put a file browser on. They are dispatched before any of that applies.
 *
 * An sftp profile is a plain `ssh`-with-`direct` host underneath (same as any
 * other direct host), but lands in the file browser by default — WinSCP-
 * like — rather than a terminal; `forceTerminal` is the escape hatch back to
 * one, from the profile's own "Open with a terminal" menu item.
 */
export async function launchProfile(p, { forceTerminal = false, dir = null } = {}) {
  if (p.type === 'serial' || p.type === 'telnet') {
    const { openDeviceSession } = await import('./sessions.js');
    status(`Opening ${p.name}…`, 0);
    try {
      await openDeviceSession({
        kind: p.type,
        name: p.name,
        path: p.path,
        baudRate: p.baudRate, dataBits: p.dataBits, parity: p.parity, stopBits: p.stopBits,
        rtscts: p.rtscts, xon: p.xon, xoff: p.xoff,
        host: p.host, port: p.devicePort,
        newline: p.newline, localEcho: p.localEcho,
      });
      if (p.startupCommand) {
        const { sendToPane } = await import('./sessions.js');
        const pane = state.getPane(state.activePaneId);
        if (pane) sendToPane(pane, p.startupCommand.replace(/\n*$/, '\n'));
      }
    } catch (e) { toast(e.message, 'error'); }
    status('');
    window.api.profiles.markUsed(p.id).catch(() => {});
    return;
  }
  // A Kubernetes profile opens its cluster's browser — checked first, the way
  // a restored kube tab is: logged out offers tsh kube login, gone says so.
  if (p.type === 'kube') {
    if (!p.kube?.spec?.contextName) return toast(`${p.name} has no kubeconfig context set`, 'error');
    const { reopenKubeBrowser } = await import('./kubepanel.js');
    const ok = await reopenKubeBrowser({ spec: p.kube.spec, title: p.name, view: p.kube.view || null, namespace: p.kube.namespace || null });
    if (ok) window.api.profiles.markUsed(p.id).catch(() => {});
    return;
  }
  if (p.type === 'vnc') {
    const { openVncSession } = await import('./sessions.js');
    await openVncSession({
      name: p.name, host: p.host, port: p.devicePort || 5900,
      viewOnly: p.viewOnly, scaling: p.scaling, quality: p.quality,
    });
    window.api.profiles.markUsed(p.id).catch(() => {});
    return;
  }
  if (p.type === 'rdp') {
    try {
      const r = await window.api.rdp.launch({
        name: p.name, hostname: p.host, port: p.devicePort || 3389,
        username: p.username, domain: p.domain,
        fullscreen: p.fullscreen, width: p.width, height: p.height,
        clipboard: p.clipboard, drives: p.drives, gateway: p.gateway,
      });
      status(`${p.name} opened in ${r.client === 'mstsc' ? 'Remote Desktop Connection'
        : r.client === 'system' ? 'your Remote Desktop client' : r.client}`);
    } catch (e) { toast(e.message, 'error'); }
    window.api.profiles.markUsed(p.id).catch(() => {});
    return;
  }

  const host = p.type === 'teleport'
    ? {
        // Matches the id listNodes gives a node from the same home, so a saved
        // profile and the inventory row for it are the same host.
        id: p.home ? `tsh:${homeLabel(p.home)}:${p.cluster}:${p.node}` : `tsh:${p.cluster}:${p.node}`,
        type: 'teleport', name: p.node, hostname: p.node,
        cluster: p.cluster, proxy: p.proxy, home: p.home || null,
      }
    // A profile with its own connection details needs no ssh_config entry.
    : p.direct
      ? { id: 'app:' + p.id, type: 'ssh', name: p.name, alias: p.name, direct: p.direct, user: p.user, hostname: p.hostname, port: p.port }
      : {
          id: 'ssh:' + p.alias, type: 'ssh', alias: p.alias, user: p.user,
          hostname: p.hostname, port: p.port,
          // A bastion named on the profile applies even when the rest of the
          // connection comes from ssh_config.
          proxyJump: p.proxyJump || null,
        };
  try {
    status(`Connecting to ${p.name}…`, 0);
    const opts = {
      login: p.login || undefined,
      profileId: p.id,
      startupCommand: p.startupCommand,
      remoteStartPath: p.remoteStartPath,
      filesOnly: p.type === 'sftp' && !forceTerminal,
      // The profile's own ssh options, on top of the host's (main.js withHostPrefs).
      profileSshOptions: p.sshExtraOptions || undefined,
    };
    // Beside or below the focused pane instead of in a tab of its own —
    // the profile menu's "Open beside/below current", same shape as a plain
    // host's.
    if (dir) {
      const { splitActivePane } = await import('./sessions.js');
      await splitActivePane(dir, { ...opts, host });
    } else {
      await openHost(host, opts);
    }
    status('');
    if (p.localStartPath) {
      const { setLocalPath } = await import('./files.js');
      setLocalPath(p.localStartPath);
    }
  } catch (e) {
    toast(e.message, 'error');
    status('');
  }
}

export async function reloadProfiles() {
  const { profiles, folders } = await window.api.profiles.list();
  state.profiles = profiles;
  state.folders = folders;
  state.emit('profiles');
}

/* --------------------------- status bar --------------------------- */

export function updateStatusBar() {
  const conn = state.activeConnId ? state.getConnection(state.activeConnId) : null;
  const pane = state.activePane;
  let text = '';
  if (pane?.kind === 'local') text = 'Local shell';
  else if (conn) {
    text = `${conn.label} — ${conn.state}`;
    if (conn.user && conn.hostname) text = `${conn.user}@${conn.hostname} · ${conn.state}`;
  }
  const checked = state.checkedHosts.size;
  if (checked) text += (text ? '  ·  ' : '') + `${checked} selected for multi-exec`;
  $('#status-conn').textContent = text;
  $('#status-broadcast').classList.toggle('hidden', !state.broadcast);
}
