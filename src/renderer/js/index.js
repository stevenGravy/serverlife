import '@xterm/xterm/css/xterm.css';
import { state } from './state.js';
import { $, $$, el, clear, fmtBytes } from './util.js';
import { toast, status, modal, field, textInput, select, checkbox, confirm, contextMenu } from './ui.js';
import { organizeSettings } from './settingsnav.js';
import { initSidebar, refreshInventory, renderSidebar, updateStatusBar } from './sidebar.js';
import { initTabs, renderTabs } from './tabs.js';
import { initFiles, startFollowLoop, restartFollowLoop, setExplorerPosition, renderRemote } from './files.js';
import { initDock, toggleDock, openDock, setTransfers, setForwards, upsertRun, finishRunHistory, fitDockToContent } from './dock.js';
import {
  openLocalShell, splitActivePane, movePane, duplicateActiveTab, requestClosePane, requestCloseTab,
  renderPanes, routeTermData, routeLocalTermData, routeTermExit, routeDeviceData,
  appendConnLog, markPrompting, updatePaneFocusRing, pickHostForSplit, focusPaneSearch,
  renderPaneMacroButtons, focusActivePane,
} from './sessions.js';
import { openNewSessionDialog } from './profiles.js';
import { openTeleportPanel, openLoginDialog } from './teleportpanel.js';
import { openSessionsDialog } from './recordings.js';
import { applyPaneStyle, applyAllPaneStyles } from './panestyle.js';
import { APP_THEMES, TERMINAL_PALETTES, themeStylesheet, toneOf } from './themes.js';
import { fontStack, fontChoices } from './fonts.js';
import { openVersionHistory } from './versions.js';
import { openKeysDialog } from './keys.js';
import { CONNECT_ANIMS, buildConnectAnim } from './connectanim.js';
import { initAutomation } from './automation.js';
import { openSnippetsDialog } from './snippets.js';
import { initSearch } from './search.js';
import { offerRestore, saveWorkspaceNow, scheduleWorkspaceSave, saveLayoutAs, loadLayoutDialog, manageLayouts } from './workspace.js';

/**
 * Take over a pane handed across from another window.
 *
 * Both routes end here — the push from the main process when this window
 * finished loading, and the answer to "is there one for me?" at startup —
 * because either can arrive first and only one of them should act.
 */
let adopting = false;
async function takeAdoptedPane(adopt) {
  if (adopting || !adopt?.termId) return;
  adopting = true;
  try {
    const { adoptPane } = await import('./sessions.js');
    await adoptPane(adopt);
    await window.api.window.adopted().catch(() => {});
  } catch (e) {
    // Never swallowed: a window opened to receive a pane and showing none
    // is a window with no way to say what went wrong.
    toast(`Could not take the pane over: ${e.message}`, 'error', 12000);
  }
}

// Registered at module load, before the page finishes loading, so the push
// from the main process cannot arrive before anything is listening.
try { window.api.window.onAdoptPane((a) => takeAdoptedPane(a)); } catch { /* no adoption in a build without the bridge */ }

/** Application bootstrap: wire main-process events, keyboard, and layout. */

async function boot() {
  state.appInfo = await window.api.app.info().catch(() => ({}));
  // Which window this is, so a second one can say so rather than looking like
  // a duplicate of the first.
  try { state.windowInfo = await window.api.window.me(); } catch { state.windowInfo = { slot: 'w1', count: 1 }; }
  state.settings = await window.api.settings.get().catch(() => ({}));
  remindCustomTeleport();
  state.showHidden = !!state.settings.showHiddenFiles;
  state.showFileDetails = !!state.settings.showFileDetails;
  state.followTerminal = state.settings.followTerminalFolder !== false;
  state.hiddenHosts = new Set(state.settings.hiddenHosts || []);
  // Order matters here: starred hosts list in the order they were starred.
  state.starredHosts = [...(state.settings.starredHosts || [])];
  applyTheme();
  applySidebarSize();

  initSidebar();
  initTabs();
  initFiles();
  initDock();
  import('./monitor.js').then((m) => m.initMonitor()).catch(() => {});
  // After sleep or a locked screen, terminals repaint with fresh glyph caches.
  window.api.app.onResume?.(() => import('./sessions.js').then((m) => m.repaintAllTerminals()).catch(() => {}));
  /*
   * A terminal measures its font's cell once, when it opens — and a bundled
   * font is only fetched when something first uses it, so the first terminal
   * in one is measured against the fallback and its columns come out wrong.
   * When a font finishes loading, every terminal measures again. (xterm only
   * re-measures on a change, hence going away from the font and back.)
   */
  document.fonts?.addEventListener('loadingdone', () => {
    for (const p of state.panes.values()) {
      const t = p.view?.term;
      if (!t) continue;
      const family = t.options.fontFamily;
      t.options.fontFamily = 'monospace';
      t.options.fontFamily = family;
      p.view.fitNow();
    }
  });
  wireMainEvents();
  wireKeyboard();
  wireToolbar();
  wireResizers();
  startFollowLoop();
  // Beams expire on their own and can be started by anyone with the cluster,
  // so the list re-reads itself rather than waiting for a refresh.
  import('./beams.js').then((m) => m.startBeamsLoop()).catch(() => {});

  await refreshInventory();
  updateStatusBar();

  /*
   * Watching requestable resources carries on whether or not its pane is
   * open — the point of monitoring something is that it happens while you
   * are doing something else — so the loop starts here, after the profiles
   * are known, and reopens the pane if it was left open.
   */
  import('./reqmonitor.js').then((m) => m.initReqMonitor()).catch(() => {});

  /*
   * Saved clusters that asked to be logged in, once the inventory says which
   * are actually expired. Not awaited: a login can take as long as an SSO
   * round trip, and the window should be usable meanwhile.
   */
  import('./teleportpanel.js')
    .then((m) => m.autoLoginSavedClusters())
    .catch(() => {});

  /*
   * A window created to receive a pane dragged out of another one takes
   * that pane instead of restoring a workspace: it was opened for this, and
   * offering to reopen last night's sessions on top of it would be two
   * answers to a question nobody asked.
   */
  const adopt = state.windowInfo?.adopt;
  if (adopt) {
    await takeAdoptedPane(adopt);
  } else {
    // Inventory has to be loaded before saved panes can be matched to hosts.
    await offerRestore();
  }

  // After the restore offer, so a first run cannot be asked two questions at
  // once, and so a window that restored a layout is not treated as a first run.
  try {
    const { offerTourOnFirstRun } = await import('./tour.js');
    await offerTourOnFirstRun();
  } catch { /* the tour is never worth blocking startup for */ }

  // The AI assistant chosen to open every time, beside whatever was restored.
  // The first window only: a second one is somewhere to work, not a restart.
  if (!adopt && (state.windowInfo?.slot || 'w1') === 'w1') {
    import('./ai.js').then((m) => m.openAiAtStartup()).catch(() => {});
  }

  // Keep the snapshot current as the layout changes.
  state.on('tabs', scheduleWorkspaceSave);
  state.on('panes', scheduleWorkspaceSave);
  window.addEventListener('beforeunload', () => { saveWorkspaceNow(); });
}

/* ------------------------------------------------------------------ */
/* Theming                                                             */
/* ------------------------------------------------------------------ */

/**
 * Apply the stored theme. "auto" leaves data-theme unset so the CSS media
 * query follows the OS; explicit choices stamp the attribute.
 */
/*
 * The named themes' rules go in ahead of styles.css, not after it: at equal
 * specificity the later rule wins, so an accent or a skin chosen on top of a
 * theme still takes effect exactly as it does over plain dark and light.
 */
function ensureThemeStyles() {
  if (document.getElementById('named-themes')) return;
  const style = el('style', { id: 'named-themes', text: themeStylesheet() });
  const sheet = document.querySelector('link[href="styles.css"]');
  sheet ? sheet.before(style) : document.head.prepend(style);
}

export function applyTheme() {
  const root = document.documentElement;
  ensureThemeStyles();
  const theme = state.settings.theme || 'dark';
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  // Light or dark, whatever the theme is called — what the light-only accent
  // shades and the 3D view key on. Absent means "follow the system".
  const tone = toneOf(theme);
  if (tone) root.setAttribute('data-tone', tone);
  else root.removeAttribute('data-tone');

  const accent = state.settings.accent || 'blue';
  if (accent === 'blue') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', accent);

  // A skin repaints the whole palette and so sits over both of the above.
  // "none" is the ordinary dark/light look.
  const skin = state.settings.skin || 'none';
  if (skin === 'none') root.removeAttribute('data-skin');
  else root.setAttribute('data-skin', skin);

  // Terminals carry their own palette and must be told separately.
  // A pane with a look of its own keeps it; the rest follow the app.
  applyAllPaneStyles();
}

// Following the OS means reacting when it changes.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if ((state.settings.theme || 'dark') === 'auto') applyTheme();
});

/* ------------------------------------------------------------------ */
/* Events from the main process                                        */
/* ------------------------------------------------------------------ */

function wireMainEvents() {
  window.api.term.onData((connId, payload) => routeTermData(connId, payload));
  window.api.term.onExit((connId, payload) => routeTermExit(connId, payload));
  window.api.localTerm.onData((payload) => routeLocalTermData(payload));
  window.api.localTerm.onExit((payload) => routeTermExit(null, payload));
  // A serial port or a telnet socket reports on its own channel; the exit
  // lands in the same place as every other session's.
  // tmux sessions report on their own channel; the module keeps the mapping
  // from tmux panes to the panes on screen.
  import('./tmux.js').then((m) => m.initTmux()).catch(() => {});
  window.api.device.onData((payload) => routeDeviceData(payload));
  window.api.device.onExit((payload) => routeTermExit(null, payload));

  window.api.conn.onState((connId, { state: s, error }) => {
    state.setConnection(connId, { state: s, error });
    if (s === 'prompting') markPrompting(connId);
    if (s === 'error') {
      const conn = state.getConnection(connId);
      if (conn && error) toast(`${conn.label}: ${error}`, 'error');
    }
    renderTabs();
    renderSidebar();
    renderRemote();
  });

  window.api.conn.onLog((connId, entry) => appendConnLog(connId, entry));

  window.api.conn.onInfo((connId, info) => {
    state.setConnection(connId, info);
    updateStatusBar();
  });

  // Transfers report their own completion: a queue that silently finishes is
  // indistinguishable from one that never started.
  const notifiedJobs = new Set();
  window.api.xfer.onUpdate((connId, jobs) => {
    setTransfers(connId, jobs);
    for (const j of jobs) {
      if (notifiedJobs.has(j.id) || !['done', 'error', 'cancelled'].includes(j.status)) continue;
      notifiedJobs.add(j.id);

      const conn = state.getConnection(connId);
      const where = conn?.label ? ` · ${conn.label}` : '';
      if (j.status === 'done') {
        const verb = j.kind === 'upload' ? 'Uploaded' : j.kind === 'download' ? 'Downloaded' : 'Copied';
        const secs = j.endedAt && j.startedAt ? (j.endedAt - j.startedAt) / 1000 : 0;
        const rate = secs > 0.2 && j.totalBytes ? ` at ${fmtBytes(j.totalBytes / secs)}/s` : '';
        const files = j.fileCount > 1 ? ` (${j.fileCount} files)` : '';
        const msg = `${verb} ${j.label}${files} — ${fmtBytes(j.totalBytes)}${rate}`;
        status(msg + where, 9000);
        toast(msg, 'success', 5000);
      } else if (j.status === 'error') {
        status(`Transfer failed: ${j.label}${where}`, 9000);
        toast(`Transfer failed: ${j.error}`, 'error', 7000);
      } else {
        status(`Transfer cancelled: ${j.label}`, 6000);
      }
    }
  });

  window.api.forward.onUpdate((connId, forwards) => setForwards(connId, forwards));

  /*
   * VNet's state, per tsh home, as the main process reports it. The sidebar
   * draws the badge from this; the toasts say what happened when it was not
   * the person's own click that changed it — tsh exiting, or finishing start.
   */
  state.vnet = new Map();
  window.api.vnet.status().then((list) => {
    for (const v of list || []) state.vnet.set(v.cluster || '', v);
    renderSidebar();
  }).catch(() => {});
  window.api.vnet.onState((v) => {
    const before = state.vnet.get(v.cluster || '')?.state;
    state.vnet.set(v.cluster || '', v);
    if (before !== v.state) {
      if (v.state === 'running') toast(`VNet is running for ${v.cluster}`, 'success');
      else if (v.state === 'error') toast(`VNet stopped: ${v.error || 'tsh vnet exited'}`, 'error', 9000);
      else if (v.state === 'stopped' && before) status('VNet stopped');
    }
    renderSidebar();
  });
  window.api.multiexec.onUpdate((view) => upsertRun(view));
  window.api.multiexec.onDone((view) => {
    upsertRun(view);
    // Recent runs records the outcome, so it is written now that there is one.
    finishRunHistory(view);
    const failed = view.results.filter((r) => r.status !== 'done').length;
    status(failed
      ? `Multi-exec finished — ${failed} of ${view.results.length} failed`
      : `Multi-exec finished on ${view.results.length} host(s)`);
  });

  window.api.app.onMenu((action) => handleMenu(action));
  initSearch({ runAction: handleMenu, openSettings });

  // The control socket's requests are answered by this window.
  initAutomation();

  state.on('activePane', () => { updatePaneFocusRing(); updateStatusBar(); });
  // Pinning a macro adds its button to every session already open, not just
  // to the next one — the buttons are a property of the macro list, not of
  // whichever pane happened to exist when it was pinned.
  state.on('macros', () => {
    for (const p of state.panes.values()) renderPaneMacroButtons(p);
  });
  state.on('checked', () => renderSidebar());
}

export function handleMenu(action) {
  switch (action) {
    case 'new-session': openNewSessionDialog(); break;
    case 'toggle-ai': import('./ai.js').then((m) => m.toggleAiPanel()); break;
    case 'quick-connect': import('./quickconnect.js').then(m => m.openQuickConnectDialog()); break;
    case 'request-monitor': import('./reqmonitor.js').then(m => m.toggleMonitorPane()); break;
    case 'tour': import('./tour.js').then(m => m.startTour()); break;
    case 'add-server': import('./addserver.js').then(m => m.openAddServerDialog()); break;
    case 'new-local': openLocalShell(); break;
    case 'new-window': window.api.window.create().catch((e) => toast(e.message, 'error')); break;
    case 'duplicate-tab': duplicateActiveTab(); break;
    case 'split-right': splitActivePane('row'); break;
    case 'split-down': splitActivePane('col'); break;
    case 'split-right-host': pickHostForSplit('row'); break;
    case 'split-down-host': pickHostForSplit('col'); break;
    case 'move-pane-left': movePane('left'); break;
    case 'move-pane-right': movePane('right'); break;
    case 'move-pane-up': movePane('up'); break;
    case 'move-pane-down': movePane('down'); break;
    case 'close-pane': closeActive(); break;
    case 'multiexec': openDock('multiexec'); break;
    case 'keys': openKeysDialog(); break;
    case 'snippets': openSnippetsDialog(); break;
    case 'toggle-log': toggleSessionLog(); break;
    case 'broadcast': toggleBroadcast(); break;
    case 'disconnect': {
      const t = state.getTab(state.activeTabId);
      if (t) requestCloseTab(t.id);
      break;
    }
    case 'find': if (!focusPaneSearch()) openFind(); break;
    case 'toggle-sidebar': $('#sidebar').classList.toggle('collapsed'); refit(); break;
    // The focused pane only. Sweeping every pane is on the button's own
    // right-click menu, since it is rarely what "hide this" means.
    case 'toggle-files': toggleFocusedExplorer(); break;
    case 'explorer-position': setExplorerPosition(); break;
    case 'toggle-transfers': toggleDock(); break;
    case 'zoom-in': zoom(1); break;
    case 'zoom-out': zoom(-1); break;
    case 'zoom-reset': zoom(0); break;
    case 'refresh': refreshInventory(true); break;
    case 'teleport-panel': openTeleportPanel(); break;
    case 'history': openSessionsDialog('history'); break;
    case 'recordings': openSessionsDialog('recordings'); break;
    case 'tsh-login': openLoginDialog(); break;
    case 'settings': openSettings(); break;
    case 'guide': import('./guide.js').then((m) => m.openGuide()); break;
    case 'about': openAbout(); break;
    case 'save-layout': saveWorkspaceNow().then(() => status('Current layout remembered')); break;
    case 'save-layout-as': saveLayoutAs(); break;
    case 'load-layout': loadLayoutDialog(); break;
    case 'manage-layouts': manageLayouts(); break;
    case 'local-files': openLocalFiles(); break;
    case 'clear-layout': window.api.workspace.clear().then(() => status('Saved layout cleared')); break;
    case 'version-history': openVersionHistory(); break;
    case 'nettools': import('./nettools.js').then((m) => m.openNetTools()); break;
    case 's3': import('./s3.js').then((m) => m.openS3Manager()); break;
    // The macro list hangs off the focused pane's own button, so the shortcut
    // just opens that — there is nowhere sensible to anchor it otherwise.
    case 'run-macro': {
      const btn = state.activePane?.element?.querySelector('.pmacro');
      if (btn) btn.click();
      else toast('Open a session first', 'error');
      break;
    }
    case 'cluster-info': import('./nettools.js').then((m) => m.openNetTools({ tool: 'teleport' })); break;
  }
}

/**
 * Put the local filesystem on screen next to the current session, ready to
 * drag files either way. A local pane brings both a local shell and a local
 * explorer, which is what makes upload and download a drag rather than a
 * dialog.
 */
export async function openLocalFiles({ path } = {}) {
  const pane = state.activePane;
  if (!pane) {
    const { openLocalShell } = await import('./sessions.js');
    await openLocalShell();
    return;
  }
  const { togglePaneLocalExplorer } = await import('./sessions.js');
  // With a path to show, this is "take me there" rather than a toggle: asking
  // for ~/.ssh and having the panel close because it was already open would be
  // the opposite of what was clicked.
  const added = togglePaneLocalExplorer(pane.id, path ? true : undefined);
  if (path && added) {
    added.navigate(path);
    status(`Local files — ${path}`);
    return;
  }
  status(added
    ? 'Local files shown below the session files — drag between them to upload or download'
    : 'Local file list hidden');
}

/** About box: version plus the environment facts worth reporting in a bug. */
function openAbout() {
  const i = state.appInfo || {};
  const rows = [
    ['Version', i.version],
    ['Platform', `${i.platform} ${i.arch} (${i.osRelease || ''})`.trim()],
    ['Connection multiplexing', i.multiplexing ? 'enabled (one auth per host)' : 'unavailable on this platform'],
    ['tsh', i.tshVersion ? `v${i.tshVersion}` : 'not found'],
    ['tsh path', i.tsh],
    ['Electron', i.electron],
    ['Chromium', i.chrome],
    ['Node', i.node],
    ['Settings', i.userData],
  ].filter(([, v]) => v);

  modal({
    title: 'About ServerLife',
    width: 'min(540px, 94vw)',
    render: (body) => {
      body.append(el('div', {
        style: 'display:flex;align-items:center;gap:14px;margin-bottom:16px;padding-bottom:15px;border-bottom:1px solid var(--border-soft)',
      },
        el('div', {
          style: 'width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--purple));'
            + 'display:flex;align-items:center;justify-content:center;font-size:25px',
          text: '\u{1F5A5}',
        }),
        el('div', {},
          el('div', { style: 'font-size:17px;font-weight:600', text: 'ServerLife' }),
          el('div', { style: 'color:var(--muted);font-size:12px', text: `Version ${i.version || '0.1.0'}` }),
          el('div', { style: 'color:var(--muted);font-size:11.5px;margin-top:3px', text: 'Teleport & SSH terminals, file transfer, multi-exec' }))));

      const table = el('div', { style: 'display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:12px' });
      for (const [k, v] of rows) {
        table.append(
          el('div', { style: 'color:var(--muted)', text: k }),
          el('div', { style: 'font-family:var(--mono);font-size:11.5px;word-break:break-all', text: String(v) }));
      }
      body.append(table);
    },
    buttons: [
      { label: 'Version history', onClick: ({ close }) => { close(null); openVersionHistory(); } },
      {
        label: 'Copy details',
        onClick: () => {
          window.api.clipboard.write(rows.map(([k, v]) => `${k}: ${v}`).join('\n'));
          status('Copied');
        },
      },
      { label: 'Close', class: 'primary-btn', value: null },
    ],
  });
}

function closeActive() {
  const pane = state.activePane;
  if (pane) requestClosePane(pane.id);
  else if (state.activeTabId) requestCloseTab(state.activeTabId);
}

function refit() {
  setTimeout(() => { for (const p of state.panes.values()) p.view.fitNow(); }, 30);
}

/*
 * Where ⌘+/⌘− (Ctrl elsewhere) should act: the part of the window last
 * clicked or focused. In the host list they size the host list; anywhere
 * else they size the text of the pane you are in, and only that pane, so a
 * log can be made small beside a shell kept large.
 */
let zoomRegion = 'panes';
function trackZoomRegion(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest('#sidebar')) zoomRegion = 'sidebar';
  // A dialog or a menu is passing through, not a change of place.
  else if (!t.closest('.modal-backdrop, .ctxmenu')) zoomRegion = 'panes';
}

const SIDEBAR_BASE = 13;
const clampSidebar = (px) => Math.max(10, Math.min(22, Math.round(px)));

/**
 * Size the host list. CSS `zoom` on the sidebar's contents, rather than a
 * font-size variable, because the list is drawn in a dozen sizes — names,
 * tags, headings, buttons — and they should all grow together; the sidebar
 * itself is left unzoomed so its width stays the width it was dragged to.
 */
export function applySidebarSize() {
  const px = clampSidebar(state.settings.sidebarFontSize || SIDEBAR_BASE);
  document.documentElement.style.setProperty('--sb-zoom', String(px / SIDEBAR_BASE));
}

async function zoomSidebar(dir) {
  const now = clampSidebar(state.settings.sidebarFontSize || SIDEBAR_BASE);
  const next = dir === 0 ? SIDEBAR_BASE : clampSidebar(now + dir);
  state.settings = await window.api.settings.set({ sidebarFontSize: next });
  applySidebarSize();
  status(`Host list text: ${next}px${next === SIDEBAR_BASE ? ' (default)' : ''}`);
}

function zoom(dir) {
  if (zoomRegion === 'sidebar') return zoomSidebar(dir);
  const pane = state.activePane;
  if (!pane?.view?.term) return;
  const base = state.settings.fontSize || 13;
  pane.view.setFontSize(dir === 0 ? base : pane.view.fontSize + dir);
  status(`Text in this pane: ${pane.view.fontSize}px${dir === 0 ? ' (the setting)' : ''}`);
}

/** Start or stop writing the focused terminal's output to a file. */
async function toggleSessionLog() {
  const pane = state.activePane;
  if (!pane || pane.kind !== 'remote' || !pane.termId) {
    return toast('Focus a remote terminal first', 'error');
  }
  try {
    const cur = await window.api.term.logState(pane.connId, pane.termId);
    if (cur.active) {
      const p = await window.api.term.stopLog(pane.connId, pane.termId);
      status('Session log saved: ' + p);
    } else {
      const p = await window.api.term.startLog(pane.connId, pane.termId);
      if (p) status('Logging this session to ' + p);
    }
  } catch (e) { toast(e.message, 'error'); }
}

export function toggleBroadcast() {
  state.broadcast = !state.broadcast;
  $('#status-broadcast').classList.toggle('hidden', !state.broadcast);
  updateStatusBar();
  status(state.broadcast
    ? 'Broadcast typing ON — keystrokes go to every pane in this tab'
    : 'Broadcast typing off');
}

/* ------------------------------------------------------------------ */
/* Toolbar & keyboard                                                  */
/* ------------------------------------------------------------------ */

/** ⌘E and the toolbar button mean "this pane", not "every pane I have open". */
function toggleFocusedExplorer() {
  const pane = state.activePane;
  if (!pane) return toast('No pane focused', 'error');
  import('./sessions.js').then((m) => m.togglePaneExplorer(pane.id));
}

function wireToolbar() {
  $('#tab-add').addEventListener('click', () => openNewSessionDialog());
  // Right-click goes straight to the address box, skipping the picker for a
  // host that was never in it.
  $('#tab-add').addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const { aiMenuItems } = await import('./ai.js');
    contextMenu(e.clientX, e.clientY, [
      { label: 'New session…', key: '⌘N', onClick: () => openNewSessionDialog() },
      { label: 'Quick connect…', key: '⌘⌥C', onClick: () => handleMenu('quick-connect') },
      { label: 'New local shell', key: '⌘T', onClick: () => openLocalShell() },
      { sep: true },
      // An AI assistant opens on the right of the tab in use.
      ...await aiMenuItems(),
    ]);
  });
  // The toolbar button carries the same scope menu as the one in a pane header.
  $('#titlebar-actions [data-action="toggle-files"]')?.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const pane = state.activePane;
    if (!pane) return;
    const { openExplorerScopeMenu } = await import('./sessions.js');
    openExplorerScopeMenu(e.clientX, e.clientY, pane.id);
  });
  $$('#titlebar-actions [data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.action;
      // The AI panel keeps its own button state: it can be shown from its
      // header and the + menu as well as from here.
      if (a === 'toggle-ai') { import('./ai.js').then((m) => m.toggleAiPanel()); return; }
      if (a === 'toggle-files') { toggleFocusedExplorer(); }
      else if (a === 'toggle-sidebar') { $('#sidebar').classList.toggle('collapsed'); refit(); }
      else if (a === 'toggle-transfers') toggleDock();
      else if (a === 'toggle-multiexec') openDock('multiexec');
      if (a === 'toggle-sidebar') {
        btn.classList.toggle('active', !$('#sidebar').classList.contains('collapsed'));
      } else if (a === 'toggle-files') {
        btn.classList.toggle('active', [...state.panes.values()].some((p) => p.explorerVisible));
      } else {
        btn.classList.toggle('active', !$('#dock').classList.contains('hidden'));
      }
    });
  });

  $$('#empty-state [data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleMenu(btn.dataset.action));
  });
}

function wireKeyboard() {
  document.addEventListener('mousedown', trackZoomRegion, true);
  document.addEventListener('focusin', trackZoomRegion, true);
  /*
   * ⌘= / ⌘− / ⌘0 (Ctrl on Windows and Linux) come through the View menu.
   * Shift+= — the key labelled +, which is what most people press — and the
   * numeric keypad's + and − are not those accelerators, so they are caught
   * here, in the capture phase, before a focused terminal can take them.
   * The modifier is the platform's own: on a Mac, Ctrl+= belongs to the
   * program in the terminal.
   */
  const isMac = state.appInfo?.platform === 'darwin';
  window.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey) return;
    const dir = (e.key === '+' || e.code === 'NumpadAdd') ? 1
      : e.code === 'NumpadSubtract' ? -1
        : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    zoom(dir);
  }, true);
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    // Tab switching: ⌘1..⌘9
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      const i = parseInt(e.key, 10) - 1;
      const tab = state.tabs[i];
      if (tab) { e.preventDefault(); state.setActiveTab(tab.id); renderPanes(); focusActivePane(); }
      return;
    }
    // ⌘⌥←/→ cycle tabs
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const i = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const next = state.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length];
      if (next) { state.setActiveTab(next.id); renderPanes(); focusActivePane(); }
      return;
    }
    if (e.key === 'k' && !e.shiftKey) {
      e.preventDefault();
      state.activePane?.view.clearScreen();
    }
    // ⌘P (Ctrl+Alt+P elsewhere — Ctrl+P is the shell's, Ctrl+Shift+P the explorer's): search everything.
    if (e.code === 'KeyP' && !e.shiftKey && (isMac ? e.metaKey && !e.altKey : e.ctrlKey && e.altKey)) {
      e.preventDefault();
      import('./search.js').then((m) => m.focusSearch());
    }
  });
}

/* ------------------------------------------------------------------ */
/* Terminal find                                                       */
/* ------------------------------------------------------------------ */

function openFind() {
  const pane = state.activePane;
  if (!pane) return;
  const input = textInput({ placeholder: 'Search in terminal…', autofocus: true });
  modal({
    title: 'Find',
    render: (body, { close }) => {
      body.append(field(null, input));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.shiftKey ? pane.view.findPrev(input.value) : pane.view.findNext(input.value);
        } else if (e.key === 'Escape') { pane.view.clearSearch(); close(null); }
      });
      return () => pane.view.clearSearch();
    },
    buttons: [
      { label: 'Previous', onClick: () => pane.view.findPrev(input.value) },
      { label: 'Next', class: 'primary-btn', onClick: () => pane.view.findNext(input.value) },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * Point the app at tsh by hand.
 *
 * Needed mostly on Windows, where the installers put tsh inside Teleport
 * Connect's own resources directory or Program Files and leave PATH alone —
 * so a machine with working clusters can still look, to the app, as though
 * Teleport were not installed.
 */
/**
 * Say so at launch when this is not the usual Teleport set-up: a tsh picked by
 * hand, or extra tsh homes. Both are easy to set for an afternoon's testing —
 * another tsh, a customer's home — and forget, and either changes what every
 * cluster in the list is read through. A picked tsh that will not even run
 * (macOS kills a tsh copied out of its tsh.app) says that instead, since
 * otherwise the list is just empty with no reason given.
 */
function remindCustomTeleport() {
  const info = state.appInfo || {};
  const homes = (state.settings.tshHomes || []).filter(Boolean);
  const where = info.tshChosenFrom === 'TSH_PATH' ? 'TSH_PATH' : 'Settings';
  const lines = [];
  let kind = 'info';
  if (info.tshChosen) {
    if (info.tshVersion) {
      lines.push(`Using a custom tsh (${where}): ${info.tshChosen} — v${info.tshVersion}.`);
    } else {
      kind = 'error';
      lines.push(`The custom tsh (${where}) at ${info.tshChosen} did not run — nothing can be read through it. `
        + 'On a Mac a tsh copied out of tsh.app is stopped by macOS; use tsh.app/Contents/MacOS/tsh.');
    }
  }
  if (homes.length) lines.push(`Reading Teleport homes: ${homes.join(', ')}.`);
  // Variables set for tsh: for every cluster, and the clusters with their own.
  const names = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim().replace(/^export\s+/, ''))
    .filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => l.slice(0, l.indexOf('=')));
  const globalVars = names(state.settings.tshEnvText);
  if (globalVars.length) lines.push(`tsh runs with ${globalVars.join(', ')} for every cluster.`);
  const perCluster = Object.entries(state.settings.clusterTshEnv || {}).filter(([, t]) => names(t).length);
  if (perCluster.length) lines.push(`…and its own for ${perCluster.map(([p, t]) => `${p} (${names(t).join(', ')})`).join('; ')}.`);
  if (!lines.length) return;
  lines.push('Settings → Teleport homes → Locate tsh / ssh… to change.');
  toast(lines.join('\n'), kind, kind === 'error' ? 20000 : 12000);
}

export async function locateTsh() {
  const info = await window.api.teleport.homes().catch(() => null);
  const win = state.appInfo.platform === 'win32';

  // Into .app bundles too: a signed tsh has to be run from inside tsh.app.
  const browse = (input, what) => el('button', {
    class: 'ghost-btn sm', text: 'Browse…',
    onClick: async () => {
      const files = await window.api.dialog.openFiles({ packages: true, single: true, title: `Choose the ${what} binary` });
      if (files && files[0]) input.value = files[0];
    },
  });

  const report = (tool, label) => el('div', { class: 'hint' },
    !tool ? '' : (tool.found
      ? `Currently using: ${tool.path}`
      : `${label} not found. Looked in:\n` + (tool.searched || []).join('\n')));

  const tshIn = textInput({
    value: state.settings.tshPath || '',
    placeholder: info?.tsh?.path || (win ? 'C:\\Program Files\\Teleport\\tsh.exe' : '/usr/local/bin/tsh'),
    autofocus: true,
  });
  const sshIn = textInput({
    value: state.settings.sshPath || '',
    placeholder: info?.ssh?.path || (win ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'),
  });

  const { globalEnvFields } = await import('./tshenv.js');
  const envFields = globalEnvFields();
  const res = await modal({
    title: 'Command-line tools',
    subtitle: 'Where tsh and ssh are on this machine',
    width: 'min(640px, 94vw)',
    render: (body) => {
      body.append(...[
        field('Path to tsh', tshIn, 'Everything Teleport is read through this. Leave blank to search the usual locations again.'),
        el('div', { style: 'display:flex;gap:6px;margin-bottom:6px' }, browse(tshIn, 'tsh')),
        report(info?.tsh, 'tsh'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        ...envFields.nodes,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Path to ssh', sshIn, win
          ? 'Optional on Windows: without it Teleport nodes are opened with tsh ssh instead, and plain SSH hosts cannot be reached.'
          : 'Used for plain SSH hosts and for Teleport nodes over the shared connection.'),
        el('div', { style: 'display:flex;gap:6px;margin-bottom:6px' }, browse(sshIn, 'ssh')),
        report(info?.ssh, 'ssh'),
        win && info?.ssh && !info.ssh.found
          ? el('div', { class: 'hint', style: 'margin-top:8px;color:var(--amber)' },
              'Windows ships the OpenSSH client as an optional feature: Settings → Apps → Optional features → Add → OpenSSH Client.')
          : null,
      // append() would render a null as text; el() drops it, this must too.
      ].filter(Boolean));
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!envFields.valid()) return toast('Some tsh environment lines are not NAME=value', 'error');
          close({ tshPath: tshIn.value.trim(), sshPath: sshIn.value.trim(), ...envFields.values() });
          return undefined;
        },
      },
    ],
  });
  if (!res) return;

  state.settings = await window.api.settings.set(res);
  state.appInfo = await window.api.app.info();
  await refreshInventory(true);
}

async function openSettings() {
  const fontSize = textInput({ type: 'number', value: state.settings.fontSize || 13, min: 8, max: 28 });
  const sidebarSize = textInput({ type: 'number', value: state.settings.sidebarFontSize || 13, min: 10, max: 22 });
  // What the terminal size was before this dialog, so saving it changes the
  // panes only if the size itself changed — not every save, which would undo
  // the size each pane was given on its own with ⌘+ and ⌘−.
  const fontSizeBefore = state.settings.fontSize || 13;
  /*
   * The font as a list of what is installed, rather than a box to type an
   * exact family name into. "Other…" keeps the box, for a font the list does
   * not know or a whole stack; a saved value that is neither is shown there.
   */
  const savedFont = String(state.settings.fontFamily || '').trim();
  // Installed, then the fonts bundled with the app, then its display faces.
  const choices = fontChoices();
  const listed = choices.flatMap((g) => g.fonts);
  const fontPick = select([
    { value: '', label: 'Default (the system\u2019s monospace)' },
    ...choices.map((g) => ({ group: g.group, options: g.fonts.map((f) => ({ value: f, label: f })) })),
    { value: '__other', label: 'Other\u2026' },
  ], savedFont === '' ? '' : (listed.includes(savedFont) ? savedFont : '__other'));
  const fontOther = textInput({
    value: listed.includes(savedFont) ? '' : savedFont,
    placeholder: 'A family name, or a stack: "My Font", monospace',
  });
  const fontPreview = el('div', {
    style: 'margin-top:6px;padding:6px 9px;border:1px solid var(--border-soft);border-radius:6px;'
      + 'font-size:13px;background:var(--panel-2);white-space:nowrap;overflow:hidden',
    text: 'ubuntu@web-1:~$ ls -la /var/log  0O 1lI {}[] => != ->',
  });
  const fontValue = () => (fontPick.value === '__other' ? fontOther.value.trim() : fontPick.value);
  const syncFont = () => {
    fontOther.classList.toggle('hidden', fontPick.value !== '__other');
    fontPreview.style.fontFamily = fontStack(fontValue());
  };
  fontPick.addEventListener('change', syncFont);
  fontOther.addEventListener('input', syncFont);
  syncFont();
  const fontFamily = el('div', {}, fontPick, fontOther, fontPreview);
  const scrollback = textInput({ type: 'number', value: state.settings.scrollback || 10000, min: 500, max: 200000 });
  const follow = checkbox('Follow the terminal’s working directory in the file browser', state.followTerminal);
  const hidden = checkbox('Show hidden files', state.showHidden);
  const details = checkbox('Show permissions and owner in file lists', state.showFileDetails);
  const foldersFirstIn = checkbox('Folders before files in file lists',
    state.settings.foldersFirst !== false);
  const show3dIn = checkbox('3D view button in the file browser', state.settings.show3dView !== false);
  /*
   * KubeLife: the single switch for the whole Kubernetes module. On by
   * default; turning it off removes every trace of it — the Kubernetes
   * group and All/SSH/K8s filter in Resources, profile type, quick connect
   * scheme, row in access requests, all of it. See GUIDE.md § KubeLife.
   */
  const kubeEnabledIn = checkbox('Enable Kubernetes support (KubeLife)', state.settings.kubeEnabled !== false);
  const kubeEnabledNote = el('div', { class: 'hint', style: 'margin:-4px 0 10px 22px',
    text: 'Kubernetes clusters in the Resources tab beside your SSH hosts (filterable to All/SSH/K8s), the '
      + 'default kubeconfig read automatically, Teleport-registered clusters, exec sessions with a file '
      + 'browser, a 3D cluster view, and Kubernetes clusters as a kind in access requests. Off leaves no '
      + 'trace of any of it — a pure-SSH setup, exactly as before KubeLife existed.' });
  const editorIn = textInput({ value: state.settings.externalEditor || '', placeholder: 'code -w' });
  const blink = checkbox('Blinking cursor', state.settings.cursorBlink !== false);
  const cursorStyleIn = select([
    { value: 'bar', label: 'Bar (line)' },
    { value: 'block', label: 'Block' },
    { value: 'underline', label: 'Underline' },
  ], state.settings.cursorStyle || 'bar');
  const hlIn = checkbox('Highlight keywords in terminal output', state.settings.highlight === true);
  const shellTitleIn = checkbox('Name the shell in a local tab\u2019s title', !!state.settings.showShellInTitle);
  const serverIconIn = checkbox('Server icon on SSH hosts, beside the ☸ on Kubernetes clusters', state.settings.showServerIcon !== false);
  const netIconIn = checkbox('Network and certificate tools icon on every session header',
    state.settings.showPaneNetIcon !== false);
  // One long-running command per connection; off on per-session-MFA hosts anyway.
  const liveStatsIn = checkbox('Live stats under each server session (CPU, memory, disk, network)',
    state.settings.liveStats !== false);
  // This computer's, under a plain local shell — macOS and Linux; hiding one from its menu turns this off.
  const localStatsIn = ['darwin', 'linux'].includes(state.appInfo?.platform)
    ? checkbox('Live stats under local shells too, for this computer', state.settings.localStats !== false) : null;
  const onePerTabIn = checkbox('One live stats bar per machine in a tab — split panes on the same host share it',
    state.settings.statsOncePerTab === true);
  for (const box of [localStatsIn, onePerTabIn]) if (box) box.style.marginLeft = '22px';
  /*
   * The one switch for everything the app runs on a host by itself, on a
   * timer: on a Teleport node each is an entry in the audit log. Off by
   * default, as these always have been; on, the log holds only what you do.
   */
  const quietIn = checkbox('No background commands on servers — keeps the Teleport audit log to what you do',
    state.settings.quietRemote === true);
  const quietHint = el('div', { class: 'hint', style: 'margin:-4px 0 10px 22px',
    text: 'Turns off live stats, following the shell\u2019s folder, the file browser\u2019s free space and '
      + 'its re-listing every few seconds on remote hosts. Refresh still works when you ask; local folders are unaffected.' });
  const syncQuiet = () => {
    liveStatsIn.input.disabled = quietIn.input.checked;
    liveStatsIn.style.opacity = quietIn.input.checked ? '.5' : '';
  };
  quietIn.input.addEventListener('change', syncQuiet);
  syncQuiet();
  /*
   * A direct SSH host that already runs Teleport is worth knowing about —
   * it is a candidate to bring under Teleport properly rather than keep
   * reaching by raw SSH — but the probe and the badge are one extra round
   * trip and one extra thing on the row, so it is a switch, not a given.
   */
  const detectTeleportIn = checkbox('Detect an already-running Teleport agent on direct SSH hosts',
    state.settings.detectTeleportOnSsh !== false);
  const detectTeleportHint = el('div', { class: 'hint', style: 'margin:-4px 0 10px 22px',
    text: 'A badge on a connected, non-Teleport SSH host’s row when it already runs a Teleport agent. '
      + 'Off skips the probe entirely — nothing is checked or shown.' });
  /*
   * The bell on a host being watched for disappearance.
   *
   * Worth being able to turn off: mark thirty machines and the column of
   * names grows thirty bells, which is where a mark stops meaning anything.
   * The watch itself is unaffected — the message when something goes, and
   * the row that stays behind, are the part that matters.
   */
  /*
   * What each tab says about its session.
   *
   * On by default and worth being able to switch off: it is movement in the
   * corner of the eye, and on a strip of eight busy tabs that is a fair
   * amount of it. Nothing else changes when it is off — the sessions carry
   * on exactly as before, the tabs simply stop commenting.
   */
  const tabActIn = checkbox('Show what each tab is doing (output, and waiting for an answer)',
    state.settings.showTabActivity !== false);
  const tabActNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px' },
    'Three bars ripple beside the tab while output is arriving, and the tab turns amber '
    + 'when the session is waiting on something — a password, a yes/no, or a coding agent '
    + 'asking permission. Never on the tab you are looking at: you can already see it.');
  /*
   * The question a clicked link gets asked.
   *
   * On by default: what a terminal shows was written by the far end, and a
   * single click on a line of log should not be able to open an address
   * nobody read. Off restores xterm's own behaviour — one click, straight to
   * the browser. Right-click → Open link asks either way only when this is on.
   */
  const linkAskIn = checkbox('Ask before opening a link clicked in a terminal',
    state.settings.confirmLinkOpen !== false);
  const linkAskNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px' },
    'The question shows the whole address and names the host it would open, so a link '
    + 'that reads one way and goes another is visible before the browser starts. '
    + 'Right-click a link for Open link and Copy link — copying works even when the '
    + 'URL wrapped over several rows.');
  /*
   * The assistant to open at startup, and the launcher assistants go
   * through, if any. What is installed is read from the login shell.
   */
  const ai = await import('./ai.js').then((m) => m.aiClients({ fresh: true })).catch(() => ({ clients: [] }));
  const aiWorkdirIn = textInput({ value: state.settings.aiWorkdir || '', placeholder: '~/ServerLife AI' });
  const aiKeysIn = checkbox('Esc, ↑, ↓ and Enter buttons under the assistant',
    state.settings.aiKeys !== false);
  const aiStartIn = select([
    { value: '', label: 'None' },
    ...ai.clients.filter((c) => c.available).map((c) => ({ value: c.id, label: c.name })),
  ], state.settings.aiStartup || '');
  /*
   * A launcher: a command assistants are run through — one that routes them
   * through a gateway, provides credentials, records usage. Generic on
   * purpose, and typed by the person: no launcher is ever suggested.
   */
  const savedLauncher = state.settings.aiLauncher || {};
  const launcherOn = checkbox('Default launcher, for tools set to use it', !!savedLauncher.on);
  const launcherIn = textInput({ value: savedLauncher.template || '', placeholder: 'mytool {client}   or   mytool exec -- {command}' });
  const launcherNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px',
    text: '{client} becomes the assistant’s name (claude, codex, …) followed by its arguments; {command} its whole command line; with neither, the command goes after the launcher.' });
  const closeAskIn = checkbox('Ask before closing a tab or pane with a live session',
    state.settings.confirmCloseWithSessions !== false);
  const loginAskIn = checkbox('Ask before logging back in to connect',
    state.settings.confirmLoginToConnect !== false);
  const loginAskNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px' },
    'Opening a host on a cluster that has logged out or expired means logging back in '
    + 'first — a browser tab, a terminal, a Touch ID prompt. On by default, since that '
    + 'can be more than a click to undo; the "Do not ask again" box on the prompt itself '
    + 'turns this off the same as unchecking it here.');
  const paneCloseAnimIn = checkbox('Pane close animations',
    state.settings.paneCloseAnimations !== false);
  const focusFollowsMouseIn = checkbox('Focus follows the mouse, into panes and the AI panel',
    !!state.settings.focusFollowsMouse);
  const focusFollowsMouseNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px',
    text: 'Hovering a pane or the AI panel focuses it — no click needed first. Off by default: a stray pass of the mouse stealing keystrokes meant for somewhere else is worse than the extra click.' });
  const quitAskIn = checkbox('Ask before quitting with remote sessions open',
    state.settings.confirmQuitWithSessions !== false);
  const quitAskNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px' },
    'Servers, consoles, VNC and tmux count, across every window; local shells do not. '
    + 'The question lists what would be disconnected.');
  /*
   * tmux everywhere, for people who have decided.
   *
   * The same switch is on every host's menu, per host and per cluster — this
   * is the bottom of that stack, for "I always want this" rather than "on
   * these machines". Off by default because it needs tmux on the far side and
   * changes what a session is; on, it is the difference between a dropped
   * connection costing a reconnect and costing the afternoon.
   */
  const tmuxIn = checkbox('Open every new session in tmux', state.settings.tmuxDefault === true);
  const tmuxNameIn = textInput({
    value: state.settings.tmuxSessionName || 'serverlife',
    placeholder: 'serverlife',
  });
  const tmuxNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px' },
    'What runs inside tmux keeps running when the window goes away — a dropped '
    + 'connection, a closed laptop, a restarted app — and reattaching brings back the '
    + 'scrollback with it. The host needs tmux installed; nothing is needed here. '
    + 'Individual hosts and clusters can say otherwise from their own menu.');
  const reqPaneIn = checkbox('Open the requestable-resource monitor when the app starts',
    state.settings.requestMonitorAutoOpen === true);
  const reqPaneNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px' },
    'Off by default: the pane floats above the app, and it has nothing urgent to say most '
    + 'mornings. The monitoring itself runs either way, and the count appears on the Teleport '
    + 'tab and on a cluster\u2019s heading — Teleport \u2192 Monitor Requestable Resources\u2026 opens it.');
  const watchMarkIn = checkbox('Bell on hosts watched for disappearance',
    state.settings.showWatchMark !== false);
  const watchNote = el('div', { class: 'hint', style: 'margin:2px 0 0 22px' });
  // Declared before the function that fills it: relying on the call order to
  // stay out of the temporal dead zone is the sort of thing that survives
  // review and breaks the next time a line moves.
  const watchClear = el('div', { style: 'margin:6px 0 0 22px' });
  const syncWatchNote = async () => {
    const { watchCount, missingHosts } = await import('./watch.js');
    const n = watchCount();
    const gone = missingHosts().length;
    watchNote.textContent = n
      ? `${n} host${n === 1 ? '' : 's'} watched${gone ? `, ${gone} currently missing` : ''}.`
      : 'Nothing is being watched yet — the mark is on a host’s right-click menu.';
    clear(watchClear);
    if (n) {
      watchClear.append(el('button', {
        class: 'ghost-btn sm', text: `Stop watching all ${n}`,
        onClick: async () => {
          const { forgetAll } = await import('./watch.js');
          const go = await confirm({
            title: `Stop watching ${n} host${n === 1 ? '' : 's'}?`,
            message: 'The records kept of them go too.',
            detail: 'Any that are currently shown as gone disappear from the list with them.',
            confirmLabel: 'Stop watching',
          });
          if (go) { await forgetAll(); syncWatchNote(); }
        },
      }));
    }
  };
  syncWatchNote();
  /*
   * What a logged-out or expired cluster's group still shows, beside the
   * login prompt. "Only watched" is what it always drew — the hosts
   * someone marked ahead of time, via `watch.js`'s own ghosts — the other
   * two add everything else the last successful read had, dimmed, for as
   * long as this says to still believe it. In memory only (`narrowed.js`),
   * so it never survives a restart, timed or not.
   */
  const expiredListModeIn = select([
    { value: 'off', label: 'Only watched hosts' },
    { value: 'timed', label: 'The last known hosts, for a while' },
    { value: 'always', label: 'The last known hosts, always' },
  ], state.settings.expiredListMode || 'off');
  const expiredListHoursIn = textInput({
    value: String(state.settings.expiredListHours || 1), style: 'width:60px',
  });
  const expiredListHoursField = field('Hours to keep showing them', expiredListHoursIn);
  const syncExpiredListHours = () => expiredListHoursField.classList.toggle('hidden', expiredListModeIn.value !== 'timed');
  expiredListModeIn.addEventListener('change', syncExpiredListHours);
  syncExpiredListHours();
  const expiredListField = field('When a cluster logs out or expires, show', expiredListModeIn,
    'Beyond the hosts you watched, which this still shows either way — a lapsed certificate '
    + 'says nothing about whether the rest of the cluster is still there.');
  const hlBtn = el('button', {
    class: 'ghost-btn sm', text: 'Edit the highlights…',
    onClick: async () => {
      const { openHighlightSettings } = await import('./highlight.js');
      await openHighlightSettings();
    },
  });
  const agentIn = checkbox('Forward the ssh agent by default (-A)', !!state.settings.agentForward);
  /*
   * What gets starred without being asked for. One path per line, `~` for the
   * home directory of whichever side it applies to.
   */
  const autoLocalIn = el('textarea', { class: 'nt-ta', rows: '4', spellcheck: 'false', placeholder: '~\n~/Documents' });
  autoLocalIn.value = (state.settings.autoFlagLocal || []).join('\n');
  const autoHostIn = el('textarea', { class: 'nt-ta', rows: '5', spellcheck: 'false', placeholder: '~\n/var/log' });
  autoHostIn.value = (state.settings.autoFlagHost || []).join('\n');

  const starredSel = select([
    { value: 'inline', label: 'At the top of the group they belong to' },
    { value: 'group', label: 'Gathered in a Starred group above everything' },
  ], state.settings.starredMode === 'group' ? 'group' : 'inline');
  const sshCfgBtn = el('button', {
    class: 'ghost-btn sm', text: 'SSH config files…',
    onClick: async () => {
      const { openSshConfigDialog } = await import('./sidebar.js');
      await openSshConfigDialog();
    },
  });

  const themeSel = select([
    { value: 'auto', label: 'Automatic (follow system)' },
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { group: 'Dark themes', options: APP_THEMES.filter((t) => t.tone === 'dark').map((t) => ({ value: t.id, label: t.label })) },
    { group: 'Light themes', options: APP_THEMES.filter((t) => t.tone === 'light').map((t) => ({ value: t.id, label: t.label })) },
  ], state.settings.theme || 'dark');
  // Blue is the default and so also means "the theme's own": a named theme
  // keeps its accent unless another colour is picked here.
  const accentSel = select([
    { value: 'blue', label: 'Default (blue, or the theme\u2019s own)' },
    { value: 'violet', label: 'Violet' },
    { value: 'teal', label: 'Teal' },
    { value: 'green', label: 'Green' },
    { value: 'amber', label: 'Amber' },
    { value: 'rose', label: 'Rose' },
    { value: 'slate', label: 'Slate' },
  ], state.settings.accent || 'blue');
  /*
   * The terminal's sixteen colours, separately from the app's theme: a
   * Solarized user wants Solarized whatever colour the sidebar is.
   */
  const paletteSel = select(
    TERMINAL_PALETTES.map((p) => ({ value: p.value, label: p.label })),
    state.settings.terminalPalette || 'app');

  const skinSel = select([
    { value: 'none', label: 'None — plain dark or light' },
    { value: 'party', label: '\u{1F389} Party' },
    { value: 'halloween', label: '\u{1F383} Halloween' },
    { value: 'christmas', label: '\u{1F384} Christmas' },
    { value: 'winter', label: '\u{2744}\u{FE0F} Winter' },
    { value: 'valentine', label: '\u{1F495} Valentine' },
    { value: 'shamrock', label: '\u{1F340} Shamrock' },
    { value: 'fireworks', label: '\u{1F386} Fireworks' },
    { value: 'synthwave', label: '\u{1F3B9} Synthwave' },
    { value: 'matrix', label: '\u{1F7E9} Matrix' },
    { value: 'thuglife', label: '\u{1F576}\u{FE0F} Thug Life' },
  ], state.settings.skin || 'none');
  // The scene that plays while a session dials. Off is a setting, not a policy:
  // some people want the log and nothing else.
  const animSel = select([
    { value: 'rotate', label: 'Rotate through all of them' },
    { value: 'off', label: 'Off — just the log' },
    ...CONNECT_ANIMS.map((a) => ({ value: a.id, label: a.cast[0] + '  ' + a.name })),
  ], state.settings.connectAnim || 'rotate');
  const animPreview = el('div');
  const showAnimPreview = () => {
    clear(animPreview);
    if (animSel.value === 'off') return;
    const a = animSel.value === 'rotate' ? CONNECT_ANIMS[Math.floor(Math.random() * CONNECT_ANIMS.length)] : animSel.value;
    const scene = buildConnectAnim(a);
    if (scene) animPreview.append(scene);
  };
  animSel.addEventListener('change', showAnimPreview);

  /*
   * Local automation: the control socket the bundled MCP server talks to.
   * Off by default, and shown with what it lets in rather than as a bare
   * toggle — it can open sessions on request.
   */
  let controlInfo = null;
  const controlBox = el('div', { class: 'mcp-panel' });
  const drawControl = () => {
    clear(controlBox);
    if (!controlInfo) { controlBox.append(el('div', { class: 'hint', text: 'Reading…' })); return; }

    const onBox = checkbox('Allow local automation (MCP)', controlInfo.enabled);
    onBox.input.addEventListener('change', async () => {
      try {
        controlInfo = { ...controlInfo, ...(await window.api.control.setEnabled(onBox.input.checked)) };
        drawControl();
      } catch (e) { toast(e.message, 'error'); }
    });
    controlBox.append(onBox);

    /*
     * Whether an assistant may type into a session — the one thing here that
     * can run anything. Asked each time unless the person says otherwise.
     */
    const typingSel = select([
      { value: 'ask', label: 'Ask me each time, showing the text (recommended)' },
      { value: 'allow', label: 'Allow without asking' },
      { value: 'off', label: 'Never' },
    ], state.settings.automationTyping || 'ask');
    typingSel.addEventListener('change', async () => {
      state.settings = await window.api.settings.set({ automationTyping: typingSel.value });
      status(`Assistants typing into sessions: ${typingSel.selectedOptions[0].textContent}`);
    });
    controlBox.append(field('Assistants typing into sessions', typingSel,
      'Lets an assistant paste a command into a terminal and, if you agree, run it.'));

    controlBox.append(el('div', { class: 'hint', style: 'margin-top:6px' },
      'A program on this machine can then list hosts, open sessions, load layouts and run your saved macros. '
      + 'It cannot run arbitrary commands. Every call is shown in the status bar.'));

    if (!controlInfo.enabled) return;

    controlBox.append(el('div', { class: 'mcp-code' },
      el('span', { class: 'k', text: 'socket  ' }), controlInfo.socketPath, '\n',
      el('span', { class: 'k', text: 'token   ' }), controlInfo.tokenFile));
    controlBox.append(el('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' },
      el('button', {
        class: 'ghost-btn sm', text: 'Copy claude mcp add',
        title: 'Register this app with Claude Code',
        onClick: () => { window.api.clipboard.write(controlInfo.mcpCommand); status('Copied'); },
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Copy bridge path',
        onClick: () => { window.api.clipboard.write(controlInfo.bridge); status('Copied'); },
      }),
      el('button', {
        class: 'ghost-btn sm danger-btn', text: 'New token',
        title: 'Anything currently authorised loses access',
        onClick: async () => {
          await window.api.control.rotateToken();
          controlInfo = await window.api.control.status();
          drawControl();
          toast('Token replaced — re-register any client', 'success');
        },
      })));
    controlBox.append(el('div', { class: 'mcp-code', text: controlInfo.mcpCommand }));
  };
  window.api.control.status().then((i) => { controlInfo = i; drawControl(); }).catch(() => {});
  drawControl();

  /*
   * tsh homes. One TELEPORT_HOME means one identity per cluster, so anyone with
   * two logins to the same cluster — or clusters they want kept apart — needs
   * more than one directory. The list is also a precedence list: the first home
   * to offer a proxy owns it.
   */
  let tshHomes = [...(state.settings.tshHomes || [])];
  // Variables each home's tsh runs with, keyed by the home as written (teleport.js tshEnv).
  const tshHomeEnv = { ...(state.settings.tshHomeEnv || {}) };

  /*
   * Add a tsh home — or change one: the path typed (~, $VAR and ${VAR} allowed,
   * read each time) or browsed for, where it points now, and NAME=value
   * variables for every tsh run against it. Resolves { path, env } or null.
   */
  const homeDialog = async ({ path: start = '', env: startEnv = '' } = {}) => {
    const pathIn = textInput({ value: start, placeholder: '~/.tsh-work  or  $TELEPORT_HOME  or  ${WORK}/.tsh', style: 'flex:1' });
    const where = el('div', { class: 'hint', style: 'min-height:1.3em;word-break:break-all' });
    const envIn = el('textarea', { rows: 4, spellcheck: 'false', placeholder: 'TELEPORT_TOOLS_VERSION=18.11.10\nTELEPORT_ADD_KEYS_TO_AGENT=no', style: 'width:100%;font-family:var(--mono);font-size:12px' });
    envIn.value = startEnv;
    const envNote = el('div', { class: 'hint', style: 'min-height:1.2em' });
    let t1 = null;
    const look = () => {
      clearTimeout(t1);
      t1 = setTimeout(async () => {
        const r = await window.api.teleport.resolveHome(pathIn.value).catch(() => null);
        if (!r || !r.raw) { where.textContent = ''; return; }
        if (r.unset.length) { where.textContent = `$${r.unset.join(', $')} is not set for ServerLife — the home would be skipped until it is`; where.style.color = 'var(--amber)'; return; }
        where.style.color = '';
        where.textContent = r.resolved === r.raw ? (r.exists ? `${r.profiles} profile${r.profiles === 1 ? '' : 's'} there` : 'Not there yet — tsh makes it at the first login')
          : `Now: ${r.resolved}${r.exists ? ` — ${r.profiles} profile${r.profiles === 1 ? '' : 's'}` : ' — not there yet'}`;
      }, 200);
    };
    const checkEnv = async () => {
      const r = await window.api.teleport.parseEnv(envIn.value).catch(() => ({ vars: {}, errors: [] }));
      const n = Object.keys(r.vars || {}).length;
      envNote.textContent = r.errors?.length ? r.errors.join(' · ') : (n ? `${n} variable${n === 1 ? '' : 's'} for tsh with this home` : '');
      envNote.style.color = r.errors?.length ? 'var(--red)' : '';
      return r;
    };
    pathIn.addEventListener('input', look);
    envIn.addEventListener('input', checkEnv);
    return modal({
      title: start ? 'Change a tsh home' : 'Add a tsh home',
      width: 'min(600px, 94vw)',
      render: (body) => {
        body.append(
          field('Directory (TELEPORT_HOME)', el('div', {},
            el('div', { style: 'display:flex;gap:6px' }, pathIn,
              el('button', { class: 'ghost-btn sm', type: 'button', text: 'Browse…', onClick: async () => {
                const d = await window.api.dialog.chooseDir(pathIn.value || undefined);
                if (d) { pathIn.value = d; look(); }
              } })),
            where),
          'A path, or an environment variable — $TELEPORT_HOME, ${WORK}/.tsh — read each time the app starts and when Settings are saved.'),
          field('Variables for this home (optional)', el('div', {}, envIn, envNote),
            'NAME=value, one a line, for every tsh command run with this home — on top of the ones for every cluster, under a cluster\u2019s own.'));
        look(); checkEnv();
      },
      buttons: [
        { label: 'Cancel', value: null },
        {
          label: start ? 'Save' : 'Add', class: 'primary-btn',
          onClick: async ({ close }) => {
            const p = pathIn.value.trim();
            if (!p) return toast('Which directory?', 'error');
            const r = await checkEnv();
            if (r.errors?.length) return toast(r.errors[0], 'error');
            close({ path: p, env: envIn.value.trim() });
            return undefined;
          },
        },
      ],
    });
  };
  const homesList = el('div', { class: 'homes-list' });
  const homesNote = el('div', { class: 'hint homes-note' });

  const drawHomes = () => {
    clear(homesList);
    if (!tshHomes.length) {
      homesList.append(el('div', { class: 'hint', style: 'padding:2px 0', text: `Just the default — ${state.appInfo.tshHome || '~/.tsh'}. Add a directory to read more than one.` }));
    }
    tshHomes.forEach((home, i) => {
      const nVars = String(tshHomeEnv[home] || '').split('\n').filter((l) => /^\s*(export\s+)?[A-Za-z_]\w*=/.test(l)).length;
      const row = el('div', { class: 'home-row' },
        el('span', { class: 'hpath', text: home, title: home }),
        el('button', {
          class: 'ghost-btn sm', text: nVars ? `${nVars} var${nVars === 1 ? '' : 's'}` : 'vars',
          title: 'Change the path or the variables tsh runs with for this home',
          onClick: async () => {
            const r = await homeDialog({ path: home, env: tshHomeEnv[home] || '' });
            if (!r) return;
            delete tshHomeEnv[home];
            if (r.env) tshHomeEnv[r.path] = r.env;
            tshHomes[i] = r.path;
            drawHomes();
          },
        }),
        el('button', {
          class: 'icon-btn sm', text: '▲', title: 'Earlier — owns a cluster both homes hold',
          disabled: i === 0,
          onClick: () => { tshHomes.splice(i - 1, 0, tshHomes.splice(i, 1)[0]); drawHomes(); },
        }),
        el('button', {
          class: 'icon-btn sm', text: '▼', title: 'Later',
          disabled: i === tshHomes.length - 1,
          onClick: () => { tshHomes.splice(i + 1, 0, tshHomes.splice(i, 1)[0]); drawHomes(); },
        }),
        el('button', {
          class: 'icon-btn sm', text: '×', title: 'Remove',
          onClick: () => { tshHomes.splice(i, 1); drawHomes(); },
        }));
      homesList.append(row);
    });
    homesList.append(el('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' },
      el('button', {
        class: 'ghost-btn sm', text: 'Add a directory…',
        onClick: async () => {
          const r = await homeDialog();
          if (!r) return;
          // The list replaces the default rather than adding to it, so the
          // first directory added brings the default along — otherwise the
          // clusters already on screen would quietly disappear.
          if (!tshHomes.length) tshHomes.push(state.appInfo.tshHome || '~/.tsh');
          if (!tshHomes.includes(r.path)) tshHomes.push(r.path);
          if (r.env) tshHomeEnv[r.path] = r.env;
          drawHomes();
        },
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Add the default (~/.tsh)',
        title: 'Name the default explicitly, so its place in the order is yours to set',
        onClick: () => {
          const def = state.appInfo.tshHome || '~/.tsh';
          if (!tshHomes.includes(def)) tshHomes.push(def);
          drawHomes();
        },
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Locate tsh / ssh…',
        title: 'Point the app at the tsh and ssh binaries, if they are somewhere unusual',
        onClick: () => locateTsh(),
      }),
      el('button', {
        class: 'ghost-btn sm', text: 'Check what they hold',
        onClick: async () => {
          homesNote.textContent = 'Reading profiles…';
          try {
            // Applied first: what the check reports has to be what will be used.
            state.settings = await window.api.settings.set({ tshHomes });
            const r = await window.api.teleport.homes();
            if (r.tsh && !r.tsh.found) {
              homesNote.textContent = 'tsh was not found, so no home can be read. Looked in:\n'
                + (r.tsh.searched || []).join('\n');
              return;
            }
            homesNote.textContent = r.homes.map((h) => {
              const where = h.default ? 'default' : (h.name || h.path);
              if (!h.exists) return `${where}: directory not found`;
              if (h.error) return `${where}: ${h.error}`;
              if (!h.profiles.length) return `${where}: no profiles`;
              return `${where}: ${h.profiles.map((p) => p.cluster + (p.expired ? ' (expired)' : '')).join(', ')}`;
            }).join('\n');
          } catch (e) { homesNote.textContent = e.message; }
        },
      })));
  };
  drawHomes();

  // How much of a memory the New Session dialog has.
  const recentSel = select([
    { value: '0', label: 'Off — do not offer recent connections' },
    { value: '5', label: 'Last 5' },
    { value: '10', label: 'Last 10' },
    { value: '20', label: 'Last 20' },
    { value: '50', label: 'Last 50' },
  ], String(state.settings.recentLimit ?? 20));

  const refreshSel = select([
    { value: '0', label: 'Off — refresh only when I ask' },
    { value: '2', label: 'Every 2 seconds' },
    { value: '5', label: 'Every 5 seconds' },
    { value: '10', label: 'Every 10 seconds' },
    { value: '30', label: 'Every 30 seconds' },
  ], String(state.settings.refreshSeconds ?? 5));

  /*
   * How often the Teleport node lists are re-read. Separate from the file
   * list above: that is an SFTP round trip per open pane, this is one
   * `tsh ls` per logged-in cluster, and they are watched for different
   * reasons.
   */
  const nodeRefreshSel = select([
    { value: '0', label: 'Off — only when I press Refresh' },
    { value: '10', label: 'Every 10 seconds' },
    { value: '30', label: 'Every 30 seconds' },
    { value: '60', label: 'Every minute' },
    { value: '300', label: 'Every 5 minutes' },
  ], String(state.settings.nodeRefreshSeconds ?? 10));

  /*
   * When a node that is still in the list has stopped talking to the cluster.
   * The threshold is a preference because the normal heartbeat interval is a
   * cluster's own business: a minute or two on most, longer where the auth
   * server has been configured that way, and a warning that fires inside the
   * normal interval is noise rather than news.
   */
  const staleSel = select([
    { value: '0', label: 'Off — do not warn' },
    { value: '2', label: 'Quiet for 2 minutes' },
    { value: '5', label: 'Quiet for 5 minutes' },
    { value: '10', label: 'Quiet for 10 minutes' },
  ], String(state.settings.staleNodeMinutes ?? 2));

  /*
   * How long a group's list may get before it stops and offers the pane.
   * A number rather than a toggle because "too long" depends on the screen
   * and on how many clusters are open at once.
   */
  const heartbeatStyleSel = select([
    { value: 'relative', label: 'How long ago — <1m, 2m (default)' },
    { value: 'exact', label: 'The exact time — 14:32:05' },
  ], state.settings.heartbeatStyle === 'exact' ? 'exact' : 'relative');
  const hostLimitSel = select([
    { value: '0', label: 'No limit — list every host' },
    { value: '10', label: 'Stop at 10 per group' },
    { value: '20', label: 'Stop at 20 per group' },
    { value: '30', label: 'Stop at 30 per group' },
    { value: '50', label: 'Stop at 50 per group' },
    { value: '100', label: 'Stop at 100 per group' },
  ], String(state.settings.sidebarHostLimit ?? 20));

  const mfaSel = select([
    { value: 'platform', label: 'Touch ID / platform authenticator' },
    { value: 'cross-platform', label: 'Security key (YubiKey)' },
    { value: 'otp', label: 'OTP code' },
    { value: 'browser', label: 'Browser' },
    { value: 'auto', label: 'Automatic (tsh decides)' },
  ], state.settings.mfaMode || 'platform');

  const x11Sel = select([
    { value: 'off', label: 'Off' },
    { value: 'untrusted', label: 'On - untrusted (ssh -X)' },
    { value: 'trusted', label: 'On - trusted (ssh -Y)' },
  ], state.settings.x11 || 'off');

  // Preview theme changes live rather than only on save.
  const livePreview = () => {
    state.settings.theme = themeSel.value;
    state.settings.accent = accentSel.value;
    state.settings.skin = skinSel.value;
    applyTheme();
  };
  themeSel.addEventListener('change', livePreview);
  accentSel.addEventListener('change', livePreview);
  skinSel.addEventListener('change', livePreview);

  const x11Note = el('div', { class: 'hint' });
  window.api.x11.status().then((st) => {
    x11Note.textContent = st.available
      ? `X server detected (DISPLAY=${st.display}).`
      : st.hint;
    x11Note.style.color = st.available ? 'var(--muted)' : 'var(--amber)';
  }).catch(() => {});

  const res = await modal({
    title: 'Settings',
    onOpen: () => showAnimPreview(),
    render: (body) => {
      body.append(
        // First: which tsh and which homes every cluster in the list is read
        // through — the setting that changes what the app shows at all.
        field('Teleport homes (TELEPORT_HOME)', homesList,
          'Every directory listed is read for clusters, and every tsh command for a cluster runs with the home it came from. Order is precedence.'),
        homesNote,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        el('div', { class: 'field-row' },
          field('Theme', themeSel),
          field('Accent colour', accentSel)),
        field('Skin', skinSel, 'A skin repaints everything, terminals included, and ignores the two above.'),
        field('Terminal colours', paletteSel,
          'The palette programs\u2019 output is drawn in. "Follow the app theme" keeps the old behaviour, '
          + 'including skins; a named palette wins over both.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        el('div', { class: 'field-row' },
          field('Terminal font size', fontSize),
          field('Host list text size', sidebarSize),
          field('Scrollback lines', scrollback)),
        el('div', { class: 'hint', style: 'margin:-4px 0 10px' },
          `${state.appInfo?.platform === 'darwin' ? '\u2318' : 'Ctrl'} + and \u2212 change the pane you are in, `
          + 'or the host list when that is where you clicked last; 0 puts it back.'),
        field('Font family', fontFamily),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Local automation', controlBox),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Remember recent connections', recentSel,
          'Offered at the top of New session, newest first, one row per destination. The full session history (⌘Y) is kept either way.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('While a session connects', animSel,
          'A small scene plays over the connection log. Thirty of them, rotating.'),
        animPreview,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Refresh the file list', refreshSel,
          'Also how often the browser follows the terminal\u2019s directory. Each tick is one SFTP round trip per visible pane.'),
        field('Refresh the Teleport clusters', nodeRefreshSel,
          'Whether each certificate is still valid, and one `tsh ls` per live cluster. '
          + 'Paused while the window is hidden, and only redrawn when a node, an address, '
          + 'a label or a cluster’s expiry has actually changed.'),
        field('Hosts listed per group in the sidebar', hostLimitSel,
          'Past this many the list stops and says how many it is holding back — and that row '
          + 'opens the same hosts in a pane, which has the room for them. A filter is exempt: '
          + 'you asked a specific question, so you get the whole answer.'),
        field('Heartbeat times', heartbeatStyleSel,
          'How a heartbeat reads on a row, SSH and Kubernetes alike — how long ago, or the clock time it was heard. The tooltip always has the exact time.'),
        field('Warn about nodes that have gone quiet', staleSel,
          'A node stays in the inventory for ten or fifteen minutes after its agent stops '
          + 'heartbeating, offering to connect the whole time. Past this much silence its row '
          + 'is marked, and the tooltip says how long it has left before the cluster drops it.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('MFA method for per-session-MFA nodes', mfaSel,
          'Automatic can pick a method that fails in a spawned process and consumes the challenge; naming one avoids that.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('X11 forwarding (default for new sessions)', x11Sel),
        x11Note,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        follow, hidden, details, foldersFirstIn, show3dIn, blink,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        el('div', { style: 'font-weight:600;margin:2px 0 6px', text: 'KubeLife' }),
        kubeEnabledIn, kubeEnabledNote,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Cursor style', cursorStyleIn), shellTitleIn, serverIconIn, netIconIn, liveStatsIn, localStatsIn, onePerTabIn, quietIn, quietHint,
        detectTeleportIn, detectTeleportHint,
        tabActIn, tabActNote,
        linkAskIn, linkAskNote,
        quitAskIn, quitAskNote,
        closeAskIn,
        loginAskIn, loginAskNote,
        paneCloseAnimIn,
        focusFollowsMouseIn, focusFollowsMouseNote,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('AI assistant to open when ServerLife starts', aiStartIn,
          'Opens in the panel on the right. Any assistant can be opened from the + menu or the ✦ button.'),
        field('Folder assistants start in', aiWorkdirIn,
          'Trusted once and remembered — Claude asks about a home folder every time. Empty means ~/ServerLife AI.'),
        aiKeysIn,
        launcherOn, el('div', { style: 'margin:4px 0 0 22px' }, launcherIn), launcherNote,
        tmuxIn, tmuxNote,
        el('div', { style: 'margin:6px 0 0 22px;max-width:280px' },
          field('tmux session name', tmuxNameIn)),
        reqPaneIn, reqPaneNote,
        watchMarkIn, watchNote, watchClear,
        expiredListField, expiredListHoursField,
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        hlIn,
        el('div', { style: 'display:flex;gap:6px;align-items:center;margin-top:7px' }, hlBtn),
        el('div', { class: 'hint', style: 'margin-top:6px' },
          'Off unless you ask for it: colour in a terminal belongs to the program. Switched on, the '
          + 'built-in rules cover errors, warnings and good news; more can be added here or for one '
          + 'host, and each session has its own toggle beside its search box.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Automatically starred here', autoLocalIn,
          'One folder per line, `~` for your home directory. They appear in the starred list of every '
          + 'local file pane. Anything that is not there is skipped, and any one of them can be hidden '
          + 'from its own menu.'),
        field('Automatically starred on servers', autoHostIn,
          'The same for a server. A `~/name` entry only appears on hosts that actually have that '
          + 'folder — checked once per connection — so a cloud instance is not offered a Desktop.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Starred hosts', starredSel,
          'A star keeps a host where you can find it. Either it sorts to the top of its own cluster, '
          + 'or every starred host is gathered into one group. Hosts can also be dragged into the '
          + 'order you want within a group.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        agentIn,
        el('div', { class: 'hint', style: 'margin-top:6px' },
          'Agent forwarding lets processes on the far host use the keys in your agent while the session '
          + 'is open \u2014 what a jump host needs, and what a shared box should not have. A cluster or a '
          + 'single host can override this from its menu in the host list.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        el('div', { style: 'display:flex;gap:6px;align-items:center' }, sshCfgBtn),
        el('div', { class: 'hint', style: 'margin-top:6px' },
          'Read hosts from more than one OpenSSH config file. Each extra file gets its own group in the '
          + 'host list, and its hosts are opened with ssh -F so that file\u2019s own settings apply.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 12px' }),
        field('Editor for remote files', editorIn,
          'Left blank, a remote file opens in whatever this machine opens that file type with. '
          + 'Name a command — code -w, subl -w, mate — to use one editor for all of them. '
          + 'Every save goes back to the server until you stop the edit.'),
        el('div', { style: 'border-top:1px solid var(--border-soft);margin:14px 0 10px' }),
        el('div', { class: 'hint' },
          `tsh: ${state.appInfo.tsh || 'not found'}${state.appInfo.tshVersion ? ' (v' + state.appInfo.tshVersion + ')' : ''}`));
      // Sections, a dropdown to show one, and a search (settingsnav.js).
      organizeSettings(body);
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', class: 'primary-btn',
        onClick: ({ close }) => close({
          theme: themeSel.value,
          accent: accentSel.value,
          skin: skinSel.value,
          terminalPalette: paletteSel.value,
          x11: x11Sel.value,
          mfaMode: mfaSel.value,
          connectAnim: animSel.value,
          recentLimit: parseInt(recentSel.value, 10),
          tshHomes,
          // Only the homes still listed keep their variables.
          tshHomeEnv: Object.fromEntries(Object.entries(tshHomeEnv).filter(([h, v]) => v && tshHomes.includes(h))),
          refreshSeconds: parseInt(refreshSel.value, 10),
          nodeRefreshSeconds: parseInt(nodeRefreshSel.value, 10),
          staleNodeMinutes: parseInt(staleSel.value, 10),
          sidebarHostLimit: parseInt(hostLimitSel.value, 10),
          heartbeatStyle: heartbeatStyleSel.value,
          fontSize: parseInt(fontSize.value, 10) || 13,
          sidebarFontSize: Math.max(10, Math.min(22, parseInt(sidebarSize.value, 10) || 13)),
          fontFamily: fontValue(),
          scrollback: parseInt(scrollback.value, 10) || 10000,
          cursorBlink: blink.input.checked,
          cursorStyle: cursorStyleIn.value,
          followTerminalFolder: follow.input.checked,
          showHiddenFiles: hidden.input.checked,
          showFileDetails: details.input.checked,
          foldersFirst: foldersFirstIn.input.checked,
          show3dView: show3dIn.input.checked,
          kubeEnabled: kubeEnabledIn.input.checked,
          externalEditor: editorIn.value.trim(),
          highlight: hlIn.input.checked,
          showShellInTitle: shellTitleIn.input.checked,
          showPaneNetIcon: netIconIn.input.checked,
          showServerIcon: serverIconIn.input.checked,
          liveStats: liveStatsIn.input.checked,
          ...(localStatsIn ? { localStats: localStatsIn.input.checked } : {}),
          statsOncePerTab: onePerTabIn.input.checked,
          quietRemote: quietIn.input.checked,
          detectTeleportOnSsh: detectTeleportIn.input.checked,
          showTabActivity: tabActIn.input.checked,
          confirmLinkOpen: linkAskIn.input.checked,
          confirmQuitWithSessions: quitAskIn.input.checked,
          confirmCloseWithSessions: closeAskIn.input.checked,
          confirmLoginToConnect: loginAskIn.input.checked,
          paneCloseAnimations: paneCloseAnimIn.input.checked,
          focusFollowsMouse: focusFollowsMouseIn.input.checked,
          aiStartup: aiStartIn.value,
          aiWorkdir: aiWorkdirIn.value.trim(),
          aiKeys: aiKeysIn.input.checked,
          aiLauncher: { on: launcherOn.input.checked && !!launcherIn.value.trim(), template: launcherIn.value.trim(),
            clients: launcherIn.value.trim() === (savedLauncher.template || '') ? (savedLauncher.clients || []) : [] },
          tmuxDefault: tmuxIn.input.checked,
          tmuxSessionName: tmuxNameIn.value.trim() || 'serverlife',
          requestMonitorAutoOpen: reqPaneIn.input.checked,
          showWatchMark: watchMarkIn.input.checked,
          expiredListMode: expiredListModeIn.value,
          expiredListHours: Math.max(1, Number(expiredListHoursIn.value) || 1),
          agentForward: agentIn.input.checked,
          starredMode: starredSel.value,
          autoFlagLocal: autoLocalIn.value.split('\n').map((x) => x.trim()).filter(Boolean),
          autoFlagHost: autoHostIn.value.split('\n').map((x) => x.trim()).filter(Boolean),
        }),
      },
    ],
  });
  if (!res) {
    applyTheme();   // undo any live preview
    return;
  }

  const homesChanged = JSON.stringify(state.settings.tshHomes || []) !== JSON.stringify(res.tshHomes || []);
  // Switching the quiet-node warning on or off changes rows that nothing else
  // here would touch: the node lists themselves are unchanged.
  const staleChanged = (state.settings.staleNodeMinutes ?? 2) !== res.staleNodeMinutes
    || (state.settings.showWatchMark !== false) !== res.showWatchMark
    || (state.settings.showServerIcon !== false) !== res.showServerIcon
    || (state.settings.heartbeatStyle || 'relative') !== res.heartbeatStyle;
  state.settings = await window.api.settings.set(res);
  if (staleChanged) state.emit('inventory');
  applyTheme();
  // A changed home list is a changed inventory: the clusters on screen came
  // from the old set of directories.
  if (homesChanged) refreshInventory(true);
  restartFollowLoop();   // pick up a changed interval immediately
  // Same for the node lists, which are on a timer of their own.
  import('./nodewatch.js').then((m) => m.startNodeLoop()).catch(() => {});
  state.followTerminal = res.followTerminalFolder;
  state.showHidden = res.showHiddenFiles;
  state.showFileDetails = res.showFileDetails;
  // Highlighting may have been switched off (or on) for every session at once.
  for (const p of state.panes.values()) p.applyHighlightSettings?.();
  // Turning the tab marks off has to take them off now, not at whatever point
  // the strip is next rebuilt.
  import('./activity.js').then((m) => m.refreshTabActivity?.()).catch(() => {});
  import('./ai.js').then((m) => m.applyAiKeys?.()).catch(() => {});
  // A title that names its shell, or does not, changes with the preference —
  // and so does whether the network icon is on each header.
  import('./sessions.js').then((m) => {
    m.refreshPaneTitles?.();
    m.applyPaneButtons?.();
  }).catch(() => {});
  // The automatically-starred folders may have changed, and every explorer
  // draws its own list from them.
  import('./explorer.js').then((m) => {
    m.refreshFavorites?.();
    m.apply3dSetting?.();
    // Folders-first is a sort, so every open listing has to be redrawn.
    for (const e of m.explorers.values()) e.render();
  }).catch(() => {});
  // KubeLife's group and filter in Resources are present or absent only by this setting.
  import('./sidebar.js').then((m) => m.applyKubeEnabledSetting?.()).catch(() => {});
  applySidebarSize();
  // Live stats on or off, for the panes already open.
  import('./monitor.js').then((m) => m.applyLiveStatsSetting()).catch(() => {});
  for (const p of state.panes.values()) {
    // A VNC screen has no terminal and no text to size.
    if (!p.view.term) continue;
    if (res.fontSize !== fontSizeBefore) p.view.term.options.fontSize = res.fontSize;
    // Empty is the default, not "leave it as it was" \u2014 or Default could not be chosen.
    p.view.term.options.fontFamily = fontStack(res.fontFamily);
    // …except in a pane that has a font of its own.
    applyPaneStyle(p);
    p.view.term.options.scrollback = res.scrollback;
    p.view.term.options.cursorBlink = res.cursorBlink;
    p.view.term.options.cursorStyle = res.cursorStyle;
    p.view.fitNow();
  }
  renderRemote();
  status('Settings saved');
}

/* ------------------------------------------------------------------ */
/* Resizers                                                            */
/* ------------------------------------------------------------------ */

/*
 * The four draggable panels. Each remembers what it was dragged to, keyed by
 * its resizer, because dragging the sidebar back to the width you like at
 * every launch is exactly the sort of friction nobody should have to accept.
 */
const PANELS = [
  { handle: '#sidebar-resizer', target: '#sidebar', prop: 'width', min: 170, max: 460 },
  { handle: '#file-resizer-v', target: '#filepanel', prop: 'width', min: 200, max: 720 },
  /*
   * The dock's ceiling is a share of the window, not 560 pixels: on a laptop
   * that was most of the screen, and a size dragged on a monitor came back
   * far too big on the smaller one. Half the window, wherever it is opened.
   */
  {
    handle: '#bottom-resizer', target: '#dock', prop: 'height',
    min: 108, max: () => Math.round(window.innerHeight * 0.5), inverse: true,
  },
  { handle: '#file-resizer', target: '#remote-pane', prop: 'height', min: 90, max: 900 },
];

function wireResizers() {
  for (const p of PANELS) {
    dragResize($(p.handle), $(p.target), p.prop, p.min, p.max, p.inverse, p.handle);
  }
  applyPanelSizes();
}

/** Put the panels back where they were left. */
export function applyPanelSizes() {
  const saved = state.settings.panelSizes || {};
  for (const p of PANELS) {
    const px = Number(saved[p.handle]);
    if (!px) continue;
    const node = $(p.target);
    if (!node) continue;
    const next = Math.max(p.min, Math.min(limitOf(p), px));
    node.style[p.prop] = next + 'px';
    // A height-driven panel is a flex item; the basis is what actually holds.
    if (p.prop === 'height') node.style.flex = '0 0 ' + next + 'px';
  }
  // The dock's restored height is the ceiling a drag once set, not what its
  // current tab actually needs — see fitDockToContent's own comment. This
  // writes `style`, not a class, so dock.js's own observer never sees it;
  // without this call the dock would come back oversized on every launch
  // until some later tab switch or render happened to correct it.
  fitDockToContent();
  refit();
}

/** A panel's maximum, which for the dock depends on the window's height. */
function limitOf(p) {
  return typeof p.max === 'function' ? p.max() : p.max;
}

function dragResize(handle, target, prop, min, max, inverse, key) {
  if (!handle || !target) return;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startPos = prop === 'width' ? e.clientX : e.clientY;
    const startSize = prop === 'width' ? target.offsetWidth : target.offsetHeight;

    const move = (ev) => {
      const cur = prop === 'width' ? ev.clientX : ev.clientY;
      let delta = cur - startPos;
      if (inverse) delta = -delta;
      const ceiling = typeof max === 'function' ? max() : max;
      const next = Math.max(min, Math.min(ceiling, startSize + delta));
      target.style[prop] = next + 'px';
      if (prop === 'height') target.style.flex = '0 0 ' + next + 'px';
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      refit();
      // Written when the drag ends rather than on every pixel of it.
      if (key) {
        const px = Math.round(prop === 'width' ? target.offsetWidth : target.offsetHeight);
        const sizes = { ...(state.settings.panelSizes || {}), [key]: px };
        window.api.settings.set({ panelSizes: sizes })
          .then((next) => { state.settings = next; })
          .catch(() => {});
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/*
 * A panel dragged tall on a big screen must not still be tall when the
 * window shrinks — the dock could end up taller than the window it is in.
 * Only the ones with a window-relative ceiling need checking, and only when
 * they are actually over it.
 */
function clampPanels() {
  for (const p of PANELS) {
    if (typeof p.max !== 'function') continue;
    const node = $(p.target);
    if (!node) continue;
    const ceiling = p.max();
    const cur = p.prop === 'width' ? node.offsetWidth : node.offsetHeight;
    if (cur <= ceiling) continue;
    node.style[p.prop] = ceiling + 'px';
    if (p.prop === 'height') node.style.flex = '0 0 ' + ceiling + 'px';
  }
}

window.addEventListener('resize', () => { clampPanels(); refit(); });

boot().catch((e) => {
  document.body.append(el('div', {
    style: 'padding:28px;font-family:monospace;color:#f85149;white-space:pre-wrap',
    text: 'Failed to start ServerLife:\n\n' + (e.stack || e.message),
  }));
});
