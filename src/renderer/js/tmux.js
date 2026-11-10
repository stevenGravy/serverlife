import { state } from './state.js';
import { toast, status, modal, confirm, prompt, field, select, textInput, contextMenu } from './ui.js';
import { el } from './util.js';
import {
  ensureConnection, openTmuxWindow, applyTmuxLayout, writeToPaneView,
  openPendingTab, paneOverlay, clearPaneOverlay, noteOverlay, closePane, closeTab, setPaneExplorerVisible,
  renderPanes, focusActivePane, renderPaneMacroButtons,
} from './sessions.js';

/**
 * tmux sessions, shown as tabs and panes.
 *
 * The thing this buys is simple enough to say in one sentence: the work stops
 * belonging to the connection. Close the lid, lose the wifi, quit the app by
 * accident, and what was running on the server is still running on the
 * server, with its scrollback, waiting. Everything else in this file is in
 * service of making that not feel like a different application.
 *
 * tmux owns the layout. A window's arrangement is decided on the far side and
 * drawn here, and a split made in this window is a command sent there and a
 * new layout drawn when it comes back. Two authorities over one layout is how
 * two clients looking at the same session end up disagreeing about it.
 */

/* sessionId -> { connId, host, name, version, windows, tabs: Map(@win -> tabId),
 *                panes: Map(%pane -> paneId), sizeTimer } */
const sessions = new Map();

/** What a window is called right now, for the tab and the pane header. */
function nameOfWindow(rec, win) {
  const tabId = rec.tabs.get(win);
  const tab = tabId ? state.getTab(tabId) : null;
  return tab?.tmuxName || 'tmux';
}

/** The pane record a tmux pane id is showing in, if any. */
function paneRecord(sessionId, tmuxPane) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const paneId = s.panes.get(tmuxPane);
  return paneId ? state.getPane(paneId) : null;
}

/*
 * tmux on this machine rather than a server. The main process answers the
 * connection id `local` with this machine (localhost.js), so everything below
 * runs unchanged; only dialling, and what the panes' file browsers show,
 * differ. Not offered on Windows, where tmux has no native build.
 */
const LOCAL_ID = 'local';
const isLocalId = (connId) => connId === LOCAL_ID;

/** Whether tmux on this machine is offered at all. */
export function localTmuxSupported() {
  return state.appInfo?.platform !== 'win32';
}

/** This machine as a host the tmux functions accept. */
export function localTmuxHost() {
  return { id: LOCAL_ID, type: 'local', name: 'this machine' };
}

/** A connection id for a host: this machine's needs no dialling. */
function dial(host, { login } = {}) {
  if (host?.type === 'local') {
    if (!localTmuxSupported()) return Promise.reject(new Error('tmux is not available on Windows'));
    return Promise.resolve(LOCAL_ID);
  }
  return ensureConnection(host, { login });
}

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

/**
 * Attach to a session on a host, creating it if it is not there.
 *
 * The probe happens first and its failure is the interesting one: a host
 * without tmux is the ordinary state of a machine nobody has set up, and the
 * useful answer names the one command that fixes it — and says that nothing
 * is needed on this machine, because "tmux is required" sounds like two
 * installations and is one.
 */
export async function openTmux(host, { login, session = 'serverlife' } = {}) {
  const label = host.name || host.alias || 'host';
  /*
   * The last word on MFA hosts, for the paths that do not come through the
   * host menu — automation, a saved layout, a keyboard shortcut.
   */
  const { isMfaHost } = await import('./sidebar.js');
  if (isMfaHost(host.id)) {
    toast(`${label} asks for MFA per session — tmux is not available on it`, 'error');
    return null;
  }
  /*
   * The tab comes first, before anything is dialled.
   *
   * Attaching is four round trips — dial, ask whether tmux is there, attach,
   * read back what is on each pane — and on a node behind a Teleport proxy
   * that is twenty seconds. Doing it all before drawing anything meant a
   * click that appeared to do nothing, which is a click people make twice.
   */
  const { tab, pane } = await openPendingTab({ title: `tmux · ${label}` });
  const step = (text) => noteOverlay(pane, text);
  const fail = (message, retry) => {
    paneOverlay(pane, {
      title: 'Could not open tmux',
      sub: label,
      error: message,
      log: true,
      retry,
    });
    status('');
    return null;
  };

  paneOverlay(pane, {
    title: `Opening tmux on ${label}…`,
    sub: session ? `session “${session}”` : '',
    log: true,
  });
  step('Connecting…');

  let connId;
  try {
    connId = await dial(host, { login });
  } catch (e) {
    return fail(e.message, () => { closePane(pane.id, { animate: false }); openTmux(host, { login, session }); });
  }
  if (!state.getPane(pane.id)) return null;        // cancelled while dialling
  /*
   * Now that the pane knows its connection, the master's own output — host
   * key prompts, MFA, "connection established" — streams into this overlay
   * like any other session's.
   */
  pane.connId = isLocalId(connId) ? null : connId;
  step(isLocalId(connId) ? 'Looking for tmux on this machine…' : 'Connected. Looking for tmux on the host…');

  const probe = await window.api.tmux.probe(connId).catch((e) => ({ ok: false, reason: e.message }));
  if (!state.getPane(pane.id)) return null;
  if (!probe.ok) {
    closePane(pane.id, { animate: false });
    status('');
    await explainMissingTmux(host, probe);
    return null;
  }
  step(`tmux ${probe.version} is there${probe.flowControl ? '' : ' (no flow control below 3.2)'}.`);
  step(`Attaching to “${session}”…`);

  let attached;
  try {
    attached = await window.api.tmux.attach(connId, { session, cols: 120, rows: 34 });
  } catch (e) {
    return fail(e.message, () => { closePane(pane.id, { animate: false }); openTmux(host, { login, session }); });
  }
  if (!state.getPane(pane.id)) {
    // Cancelled while attaching: the session is real, so detach rather than
    // leave a control client nobody is watching.
    window.api.tmux.detach(attached.id).catch(() => {});
    return null;
  }

  const rec = {
    id: attached.id,
    connId,
    host,
    login,                  // so Reattach comes back as the same user
    name: session,
    version: attached.version,
    tabs: new Map(),
    panes: new Map(),
    trees: new Map(),
    sizeTimer: null,
  };
  sessions.set(attached.id, rec);

  const windows = attached.windows || [];
  const first = windows[0];
  const paneCount = windows.reduce((n, w) => n + (w.panes?.length || 0), 0);
  step(`Attached — ${windows.length} window${windows.length === 1 ? '' : 's'}, `
    + `${paneCount} pane${paneCount === 1 ? '' : 's'}. Reading back what is on them…`);

  /*
   * The pane that has been showing the progress becomes the session's first
   * pane, rather than being thrown away and replaced — so the tab does not
   * blink, and the overlay is lifted off something that is already the right
   * pane.
   */
  if (first && first.panes?.length) {
    tab.tmuxId = rec.id;
    tab.tmuxWindow = first.id;
    tab.tmuxName = first.name || 'tmux';
    /*
     * The tab's stored title, not just what the strip draws: anything asking
     * the app what is open — automation, a saved layout — reads this one, and
     * "tmux · host" is what it was called while it was still connecting.
     */
    tab.title = `${tab.tmuxName} \u00b7 ${label}`;
    rec.trees.set(first.id, first.tree);
    bindPane(rec, pane, first.panes[0], first.name);
    rec.tabs.set(first.id, tab.id);
    await applyTmuxLayout(tab.id, first.tree, {
      bind: (p, tmuxPane) => bindPane(rec, p, tmuxPane, first.name),
      paneFor: (tmuxPane) => paneRecord(rec.id, tmuxPane),
    });
    clearPaneOverlay(pane);
    for (const p of first.panes) primePane(rec, p);
  } else {
    clearPaneOverlay(pane);
  }

  // Any further windows get tabs of their own.
  await showWindows(rec, windows.slice(1));
  sendSize(rec);
  /*
   * Back to the tab this was opened in, with the keyboard in it.
   *
   * Each further window's tab takes the front as it is built, which left you
   * on the last window rather than the one you asked for, and nothing here
   * gave the terminal focus — so what was typed next went nowhere, most
   * plainly after Reattach, whose button is gone by then. Only when one of
   * this session's tabs is in front: if you went elsewhere during a slow
   * attach, you stay there.
   */
  if (state.activeTabId === tab.id || [...rec.tabs.values()].includes(state.activeTabId)) {
    state.setActiveTab(tab.id);
    renderPanes();
    state.emit('tabs');
    focusActivePane();
  }
  status(`tmux ${attached.version} on ${label} — ${windows.length} window${windows.length === 1 ? '' : 's'}`);
  return rec;
}

/**
 * What to say when the host has no tmux.
 *
 * Worth a dialog rather than a toast: it is the one failure here that the
 * person can do something about, and the something is a single command they
 * will want to copy.
 */
async function explainMissingTmux(host, probe) {
  const local = host?.type === 'local';
  await modal({
    title: local ? 'This machine has no tmux' : 'This host has no tmux',
    width: 520,
    render: (body) => {
      body.append(
        el('div', { style: 'font-size:13px;margin-bottom:8px' },
          probe.reason || 'tmux is not installed there.'),
        el('div', { class: 'hint', style: 'margin-bottom:10px' }, local
          ? 'Install it here, then open tmux again. Sessions on a server need it on '
            + 'the server instead, never here.'
          : 'Only the server needs it — nothing is installed on this machine. ServerLife '
            + 'speaks tmux’s control protocol itself, over the connection that is '
            + 'already open.'),
        el('div', {
          text: probe.install || 'apt install tmux',
          style: 'font-family:var(--mono);font-size:12px;background:var(--panel-2);'
            + 'border:1px solid var(--border-soft);border-radius:6px;padding:8px 10px',
        }));
    },
    buttons: [{ label: 'Close', value: null, class: 'primary-btn' }],
  });
}

/** One tab per tmux window, each laid out the way tmux says. */
async function showWindows(rec, windows) {
  for (const w of windows) {
    if (rec.tabs.has(w.id)) continue;
    /*
     * Not until its layout is known. tmux announces a new window with only
     * its id, and the list that follows a moment later is the one with its
     * panes. A tab built from the announcement was a pane bound to nothing —
     * no terminal, no tmux menu, "no session selected" — and since the window
     * then had a tab, the real layout arriving next was skipped, and the tab
     * stayed that way.
     */
    if (!w.tree) continue;
    const tab = await openTmuxWindow({
      title: `${w.name || 'tmux'} · ${rec.host.name || rec.host.alias || ''}`,
      tree: w.tree,
      bind: (pane, tmuxPane) => bindPane(rec, pane, tmuxPane, w.name),
    });
    tab.tmuxId = rec.id;
    tab.tmuxWindow = w.id;
    tab.tmuxName = w.name || 'tmux';
    rec.trees.set(w.id, w.tree);
    rec.tabs.set(w.id, tab.id);
    for (const p of w.panes || []) primePane(rec, p);
  }
  sendSize(rec);
}

function bindPane(rec, pane, tmuxPane, windowName) {
  pane.kind = 'tmux';
  pane.tmuxId = rec.id;
  pane.tmuxPane = tmuxPane;
  pane.tmuxHost = rec.host.name || rec.host.alias || '';
  /*
   * The connection the control stream rides is a connection like any other,
   * so the pane carries it: the file browser reads the server's files, the
   * network tools run from the host, and the highlight rules are the ones set
   * for it. A tmux session is not a different kind of machine.
   */
  pane.connId = isLocalId(rec.connId) ? null : rec.connId;
  // tmux on this machine: the files beside it are this machine's too.
  if (isLocalId(rec.connId) && pane.explorer?.source?.kind !== 'local') {
    pane.explorer?._onSourcePicked('local', { silent: true });
  }
  pane.tmuxWindowName = windowName || pane.tmuxWindowName || 'tmux';
  // `termId` is what the rest of the app reads as "there is something running
  // in this pane"; for a tmux pane the tmux pane id is exactly that.
  pane.termId = tmuxPane;
  rec.panes.set(tmuxPane, pane.id);
  renderTmuxControls(pane);
  // The pane was built before it had a connection, so its pinned buttons were
  // drawn as a plain host's; a beam's own buttons only appear once it knows.
  renderPaneMacroButtons(pane);
  /*
   * One file browser per session. Every pane in a tmux session is on the same
   * host, so a second browser shows the same server again and takes half of
   * the new pane to do it — and a split or a new window is asked for to get
   * more terminal. So a new pane opens without one while any pane of the
   * session, on any of its tabs, already shows one; the session's first pane
   * keeps the usual setting, and any pane can still open its own.
   */
  if (pane.explorerVisible) {
    const another = [...rec.panes.values(), ...state.panesOf(pane.tabId)]
      .some((id) => id !== pane.id && state.getPane(id)?.explorerVisible);
    if (another) setPaneExplorerVisible(pane, false);
  }
  // The explorer was built following the pane, which had no connection yet.
  if (pane.explorerVisible) pane.explorer?.ensureLoaded?.();
  // Live stats for the host, from the same one command as any pane on it.
  import('./monitor.js').then((m) => m.attachMonitor(pane)).catch(() => {});
}

/** How many panes a parsed tmux layout holds. */
function panesOf(node) {
  if (!node) return 0;
  if (node.pane) return 1;
  return (node.children || []).reduce((n, c) => n + panesOf(c), 0);
}

/**
 * A "tmux" menu on a tmux pane's title bar, for the session itself.
 *
 * Every item is a tmux command sent down the control stream, and what it does
 * comes back as the layout tmux reports — the same as typing the command in a
 * shell in the session, or pressing the prefix keys in any other client. So a
 * split made here is a pane in the session, there for whoever attaches next,
 * and nothing about ServerLife's own windows changes except to show it.
 *
 * One labelled button rather than a row of glyphs: these are commands to a
 * different program than the buttons beside them, and a symbol for "next
 * layout" is something nobody can read at a glance.
 *
 * Zoom is left out on purpose: the layout followed is the window's full one,
 * which a zoom does not change, so it would appear to do nothing.
 */
function renderTmuxControls(pane) {
  const box = pane.tmuxCtl;
  if (!box) return;
  const send = (cmd) => {
    const rec = sessions.get(pane.tmuxId);
    if (!rec) return toast('This pane is no longer attached to tmux', 'error');
    return window.api.tmux.command(rec.id, cmd).catch((e) => toast(e.message, 'error'));
  };
  const closeTmuxPane = async () => {
    const ok = await confirm({
      title: 'Close this tmux pane?',
      message: 'What is running in it stops, on the server, for everyone attached.',
      detail: 'To keep it running and only stop showing it here, close the pane with \u00d7 instead.',
      confirmLabel: 'Close the tmux pane',
    });
    if (ok) send(`kill-pane -t ${pane.tmuxPane}`);
  };
  const closeTmuxWindow = async (count) => {
    const ok = await confirm({
      title: 'Close this tmux window?',
      message: `Its ${count === 1 ? 'pane' : `${count} panes`} and what runs in ${count === 1 ? 'it' : 'them'} stop, on the server, for everyone attached.`,
      detail: 'To keep it running and only stop showing it here, close the tab instead.',
      confirmLabel: 'Close the tmux window',
    });
    if (ok) send(`kill-window -t ${pane.tmuxPane}`);
  };
  /*
   * The five layouts by name. tmux's own names say how they are built, not
   * what they look like, so the label is the picture and the name is kept for
   * anyone who knows it.
   */
  const LAYOUTS = [
    ['even-horizontal', 'Side by side'],
    ['even-vertical', 'Stacked'],
    ['main-horizontal', 'One big on top, the rest below'],
    ['main-vertical', 'One big on the left, the rest beside it'],
    ['tiled', 'Tiled grid'],
  ];
  const btn = el('button', {
    class: 'ghost-btn sm ptmux-btn', text: 'tmux ▾',
    title: 'Commands for this tmux session — split, layout, windows',
    onClick: async (e) => {
      e.stopPropagation();
      state.setActivePane(pane.id);
      const r = btn.getBoundingClientRect();
      const rec = sessions.get(pane.tmuxId);
      // A layout is an arrangement of panes; with one there is nothing to
      // arrange, and an item that silently does nothing reads as broken.
      const win = state.getTab(pane.tabId)?.tmuxWindow;
      const count = rec?.trees.get(win) ? panesOf(rec.trees.get(win)) : 1;
      const alone = count < 2;
      const needsTwo = alone ? ' — needs two or more panes' : '';
      /*
       * Whether typing goes to every pane is tmux's to say — another client
       * may have turned it on — so it is asked as the menu opens, one round
       * trip, rather than remembered here and wrong.
       */
      let synced = false;
      if (rec && !alone) {
        const out = await window.api.tmux.command(rec.id,
          `display-message -p -t ${pane.tmuxPane} '#{synchronize-panes}'`).catch(() => []);
        synced = (out || [])[0] === '1';
      }
      contextMenu(r.left, r.bottom + 2, [
        { label: `tmux · ${rec?.name || 'session'}`, heading: true },
        { label: 'Split right', key: '⌘⇧D', icon: 'Ⅾ',
          title: 'A new tmux pane beside this one (split-window -h)',
          onClick: () => send(`split-window -h -t ${pane.tmuxPane}`) },
        { label: 'Split down', key: '⌘⇧E', icon: '‗',
          title: 'A new tmux pane below this one (split-window -v)',
          onClick: () => send(`split-window -v -t ${pane.tmuxPane}`) },
        { label: 'Layout' + needsTwo, icon: '⊞', disabled: alone,
          submenu: [
            ...LAYOUTS.map(([name, label]) => ({
              label, key: name, title: `select-layout ${name}`,
              onClick: () => send(`select-layout -t ${pane.tmuxPane} ${name}`),
            })),
            { sep: true },
            { label: 'Next layout', title: 'The next of the five, in turn (next-layout)',
              onClick: () => send(`next-layout -t ${pane.tmuxPane}`) },
          ] },
        { label: 'Swap with the next pane' + needsTwo, icon: '⇄', disabled: alone,
          title: 'This pane and the one after it change places (swap-pane -D)',
          onClick: () => send(`swap-pane -D -t ${pane.tmuxPane}`) },
        { label: 'Move this pane to its own window' + needsTwo, icon: '↗', disabled: alone,
          title: 'Takes this pane out into a new tmux window, shown as a tab (break-pane)',
          onClick: () => send(`break-pane -s ${pane.tmuxPane}`) },
        { label: 'Type in all panes at once' + needsTwo, icon: '⌨', disabled: alone,
          key: synced ? '✓ on' : '',
          title: synced
            ? 'On: every key goes to every pane in this window. Click to turn it off.'
            : 'Every key goes to every pane in this window — one command on several servers (synchronize-panes)',
          onClick: () => send(`set-window-option -t ${pane.tmuxPane} synchronize-panes ${synced ? 'off' : 'on'}`)
            ?.then?.(() => status(synced ? 'Typing goes to this pane only' : 'Typing goes to every pane in this window')) },
        { sep: true },
        { label: 'New tmux window', icon: '+',
          title: 'A new window in this session, shown as a tab (new-window)',
          onClick: () => send('new-window') },
        { sep: true },
        { label: 'Close this tmux pane…', icon: '⊗',
          title: 'Ends what runs in it, on the server (kill-pane)',
          onClick: closeTmuxPane },
        { label: 'Close this tmux window…', icon: '⊗',
          title: 'Ends every pane in it, on the server (kill-window)',
          onClick: () => closeTmuxWindow(count) },
      ]);
    },
  });
  box.replaceChildren(btn);
  box.classList.remove('hidden');
}

/**
 * Fill a pane with what is already on that tmux pane's screen.
 *
 * Without this a reattached session is a wall of blank panes until something
 * next prints — which, for the session you left running `tail -f` in three
 * hours ago, may be never. This is the difference between "it reconnected"
 * and "my work is back".
 */
async function primePane(rec, tmuxPane) {
  const pane = paneRecord(rec.id, tmuxPane);
  if (!pane) return;
  try {
    const text = await window.api.tmux.capture(rec.id, tmuxPane, 2000);
    /*
     * A captured pane is a whole screen, which is mostly empty rows below
     * whatever was printed. Writing them verbatim puts the content at the top
     * and the cursor forty lines below it, which looks like the session
     * failed to attach.
     */
    const trimmed = String(text || '').replace(/\s+$/, '');
    if (trimmed) writeToPaneView(pane, trimmed.replace(/\n/g, '\r\n') + '\r\n');
  } catch { /* an empty pane is better than a broken one */ }
}

/* ------------------------------------------------------------------ */
/* Sizing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Tell tmux how big this client is.
 *
 * tmux sizes a window to its smallest attached client, and there is no
 * per-pane resize a control client may ask for — so the only lever is the
 * size of the whole client, and the honest value for it is the grid of the
 * largest pane we are showing plus what the splits take up. Debounced,
 * because dragging a divider produces a resize per frame and each one is a
 * command round trip.
 */
export function notePaneResize(pane) {
  const rec = sessions.get(pane?.tmuxId);
  if (!rec) return;
  sendSize(rec);
}

function sendSize(rec) {
  clearTimeout(rec.sizeTimer);
  rec.sizeTimer = setTimeout(() => {
    const size = clientSize(rec);
    if (!size) return;
    if (rec.lastSize === `${size.cols}x${size.rows}`) return;
    rec.lastSize = `${size.cols}x${size.rows}`;
    window.api.tmux.resize(rec.id, size.cols, size.rows).catch(() => {});
  }, 120);
}

/**
 * The size of the window as tmux would measure it: panes side by side add
 * their widths plus a column for each divider, stacked panes add their
 * heights plus a row each.
 *
 * Measured over *tmux's own* layout rather than the tab's, because a tab can
 * also hold panes tmux knows nothing about — another server split in beside
 * it. Counting those would tell tmux the window is wider than the space its
 * panes actually have, and every line would wrap one column early.
 */
function clientSize(rec) {
  const tree = rec.trees.get(activeWindowOf(rec));
  if (!tree) return null;

  const measure = (node) => {
    if (!node) return { cols: 0, rows: 0 };
    if (node.pane) {
      const p = paneRecord(rec.id, node.pane);
      return { cols: p?.view?.cols || 0, rows: p?.view?.rows || 0 };
    }
    const kids = (node.children || []).map(measure).filter((k) => k.cols && k.rows);
    if (!kids.length) return { cols: 0, rows: 0 };
    if (node.dir === 'row') {
      return {
        cols: kids.reduce((n, k) => n + k.cols, 0) + (kids.length - 1),
        rows: Math.max(...kids.map((k) => k.rows)),
      };
    }
    return {
      cols: Math.max(...kids.map((k) => k.cols)),
      rows: kids.reduce((n, k) => n + k.rows, 0) + (kids.length - 1),
    };
  };
  const size = measure(tree);
  return size.cols && size.rows ? size : null;
}

function activeWindowOf(rec) {
  const tab = state.getTab(state.activeTabId);
  if (tab?.tmuxId === rec.id) return tab.tmuxWindow;
  return [...rec.tabs.keys()][0];
}

/* ------------------------------------------------------------------ */
/* Events from the far side                                           */
/* ------------------------------------------------------------------ */

export function routeTmuxOutput({ id, pane, data }) {
  const p = paneRecord(id, pane);
  if (p) writeToPaneView(p, data);
}

export async function routeTmuxLayout({ id, window: win, tree }) {
  const rec = sessions.get(id);
  if (!rec || !tree) return;
  rec.trees.set(win, tree);
  const tabId = rec.tabs.get(win);
  if (!tabId) return;
  await applyTmuxLayout(tabId, tree, {
    bind: (pane, tmuxPane) => { bindPane(rec, pane, tmuxPane, nameOfWindow(rec, win)); primePane(rec, tmuxPane); },
    paneFor: (tmuxPane) => paneRecord(id, tmuxPane),
  });
  // Panes that have gone take their mapping with them.
  for (const [tmuxPane, paneId] of [...rec.panes]) {
    if (!state.getPane(paneId)) rec.panes.delete(tmuxPane);
  }
  sendSize(rec);
}

export async function routeTmuxWindows({ id, windows }) {
  const rec = sessions.get(id);
  if (!rec) return;
  await showWindows(rec, windows || []);
  /*
   * A window is renamed by whatever is running in it — the shell sets it to
   * the command — so the tab follows rather than keeping the name it had when
   * it was opened.
   */
  const { refreshPaneTitles } = await import('./sessions.js');
  for (const w of windows || []) {
    const tabId = rec.tabs.get(w.id);
    const tab = tabId ? state.getTab(tabId) : null;
    if (!tab || tab.tmuxName === w.name) continue;
    tab.tmuxName = w.name || 'tmux';
    tab.title = `${tab.tmuxName} \u00b7 ${rec.host.name || rec.host.alias || ''}`;
    for (const paneId of state.panesOf(tabId)) {
      const p = state.getPane(paneId);
      if (p) p.tmuxWindowName = tab.tmuxName;
    }
  }
  refreshPaneTitles();
  // A window closed on the far side closes the tab that was showing it.
  const live = new Set((windows || []).map((w) => w.id));
  for (const [win, tabId] of [...rec.tabs]) {
    if (live.has(win)) continue;
    rec.tabs.delete(win);
    const { closeTab } = await import('./sessions.js');
    closeTab(tabId);
  }
}

export function routeTmuxPause({ id, pane, paused }) {
  const p = paneRecord(id, pane);
  if (!p) return;
  // Flow control is tmux protecting the client from a flood. Saying so beats
  // a pane that has silently stopped moving.
  p.view.writeln(paused
    ? '\r\n\x1b[33m[tmux paused this pane — it was producing output faster than this window could take it]\x1b[0m'
    : '\x1b[90m[resumed]\x1b[0m');
}

/**
 * This window is no longer attached to a session — and whether the session is
 * still there, which the main process asked the host (`alive`: true, false,
 * or null when the connection went with it).
 *
 * Every pane is made to look like what it now is: dimmed, its tmux menu gone,
 * "ended" or "detached" in its title bar and on its tab, and on the first
 * pane of each tab a notice saying which, with Reattach only when there is
 * something to reattach to. The terminal text is left behind the notice, so
 * the last thing on screen can still be read and copied. Before, an ended
 * session kept every sign of life and took keystrokes into nowhere.
 */
export async function routeTmuxEnded({ id, reason, alive = null }) {
  const rec = sessions.get(id);
  if (!rec) return;
  sessions.delete(id);
  const host = rec.host.name || rec.host.alias || 'the host';
  const word = alive === false ? 'ended' : alive === true ? 'detached' : 'disconnected';
  const title = alive === false ? `tmux session “${rec.name}” has ended`
    : alive === true ? `Detached from “${rec.name}”`
      : `Lost the connection to “${rec.name}”`;
  const sub = alive === false
    ? `Nothing is running in it any more on ${host}.`
    : alive === true
      ? `It is still running on ${host}, with everything in it.`
      : `It may still be running on ${host}${reason ? ` (${reason})` : ''}.`;

  for (const [, tabId] of rec.tabs) {
    const tab = state.getTab(tabId);
    if (tab) { tab.tmuxEnded = word; tab.title = `${tab.tmuxName || 'tmux'} · ${host} — ${word}`; }
    let first = true;
    for (const paneId of state.panesOf(tabId)) {
      const p = state.getPane(paneId);
      if (!p || p.tmuxId !== id) continue;
      p.termId = null;
      p.tmuxEnded = word;
      // Still on screen with its last output, but nothing is running on the
      // host for it now: it stops counting towards the host's live stats.
      import('./monitor.js').then((m) => m.detachMonitor(p)).catch(() => {});
      p.element.classList.add('tmux-ended');
      p.tmuxCtl?.classList.add('hidden');
      const name = p.head?.querySelector('.pname');
      if (name && !name.querySelector('.ended-tag')) {
        name.append(el('span', { class: 'tag ended-tag', text: word }));
      }
      p.view.writeln(`\r\n\x1b[90m[${title.replace(/[“”]/g, '"')} — ${sub}]\x1b[0m`);
      if (first) {
        first = false;
        paneOverlay(p, {
          title, sub,
          error: alive === false ? 'This pane shows what was on screen when it ended.' : null,
          peek: true,
          alt: alive !== false ? {
            label: 'Reattach',
            onClick: () => { closeTab(tabId); openTmux(rec.host, { login: rec.login, session: rec.name }); },
          } : null,
        });
      }
    }
  }
  state.emit('tabs');
  status(`${title} — ${sub}`);
}

/**
 * Whether this window still has a control client on the session.
 *
 * A live control stream means the connection under it is alive too — tmux is
 * talking over it — so whatever else says the connection is down is wrong,
 * and the file browser can take its channel back without asking anyone.
 */
export function tmuxAttached(sessionId) {
  return !!sessionId && sessions.has(sessionId);
}

/** A pane closed in this window: stop routing to it, leave the session alone. */
export function forgetTmuxPane(pane) {
  const rec = sessions.get(pane?.tmuxId);
  if (!rec) return;
  rec.panes.delete(pane.tmuxPane);
  /*
   * The last pane closing means nothing is looking at this session any more,
   * so the control client detaches — and the session carries on running on
   * the server, which is the entire point. Killing it here would turn closing
   * a tab into losing the work.
   */
  const anyLeft = [...rec.panes.values()].some((id) => state.getPane(id));
  if (anyLeft) return;
  sessions.delete(rec.id);
  window.api.tmux.detach(rec.id).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Commands from this side                                             */
/* ------------------------------------------------------------------ */

/** Split the tmux pane this pane is showing, and let tmux say what happened. */
export async function splitTmuxPane(pane, dir = 'row') {
  const rec = sessions.get(pane?.tmuxId);
  if (!rec) return toast(pane?.tmuxEnded ? `This tmux session has ${pane.tmuxEnded === 'ended' ? 'ended' : 'been left'} \u2014 nothing to split` : 'Not attached to tmux', 'error');
  // tmux's -h is a vertical divider (side by side); ours is called 'row'.
  const flag = dir === 'row' ? '-h' : '-v';
  await window.api.tmux.command(rec.id, `split-window ${flag} -t ${pane.tmuxPane}`)
    .catch((e) => toast(e.message, 'error'));
}

/**
 * Close a tmux pane as a person closing it means: in tmux too.
 *
 * Closing a pane here used to close only the view of it, leaving the shell
 * running in tmux with nothing showing it — and tmux's own layout would put it
 * straight back the next time anything resized. So a pane closed by hand is
 * killed in tmux (`kill-pane`), and tmux's next layout takes it off the screen
 * the same way it does a pane closed on the far side. The last pane of the
 * session ends the session, so that one is asked first. Closing a tab or
 * quitting still only detaches: the session is still there to come back to.
 *
 * Answers whether it was handled; false means "not attached — close the view".
 */
export async function killTmuxPane(pane) {
  const rec = sessions.get(pane?.tmuxId);
  if (!rec || !pane.tmuxPane) return false;
  const bound = [...rec.panes.values()].filter((id) => state.getPane(id)).length;
  if (bound <= 1 && rec.tabs.size <= 1) {
    const ok = await confirm({
      title: 'Close the last pane?',
      message: `It is the last pane in tmux session “${rec.name || 'tmux'}”, so closing it ends the session on the server.`,
      detail: 'Detach instead (the tmux menu) to leave it running.',
      confirmLabel: 'Close it and end the session',
      danger: true,
    });
    if (!ok) return true;
  }
  try {
    await window.api.tmux.command(rec.id, `kill-pane -t ${pane.tmuxPane}`);
  } catch (e) {
    toast(`tmux would not close the pane: ${e.message}`, 'error');
    return false;
  }
  return true;
}

export async function newTmuxWindow(pane) {
  const rec = sessions.get(pane?.tmuxId);
  if (!rec) return;
  await window.api.tmux.command(rec.id, 'new-window').catch((e) => toast(e.message, 'error'));
}

/** Leave it running on the server. */
export async function detachTmux(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) return;
  await window.api.tmux.detach(sessionId).catch(() => {});
  status('Detached — the session is still running on the server');
}

/** End it for good, which is the only action here that destroys work. */
export async function killTmux(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) return;
  const ok = await confirm({
    title: 'End this tmux session?',
    message: `Everything running in “${rec.name}” on ${rec.host.name || rec.host.alias} will be killed.`,
    detail: 'Detaching instead leaves it running, which is what makes the session worth having.',
    confirmLabel: 'End the session', danger: true,
  });
  if (!ok) return;
  await window.api.tmux.kill(sessionId).catch(() => {});
}

/**
 * Rename the session.
 *
 * The name is how you find it again — from this app, from `tmux ls` on the
 * host, from a colleague's terminal — and the one it was given when nobody
 * knew what it would be for is rarely the one that helps six hours later.
 * A session called `serverlife` on four machines tells you nothing; one
 * called `db-migration` tells you not to kill it.
 */
export async function renameTmuxSession(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) return;
  const next = await prompt({
    title: 'Rename this tmux session',
    label: `On ${rec.host.name || rec.host.alias || 'the host'}`,
    value: rec.name,
    confirmLabel: 'Rename',
    validate: (v) => {
      // tmux refuses a name with a colon or a full stop: both are how it
      // addresses windows and panes, so a name holding one is ambiguous.
      if (!v.trim()) return 'Give it a name';
      if (/[:.]/.test(v)) return 'A tmux session name cannot contain : or .';
      return null;
    },
  });
  if (!next || next.trim() === rec.name) return;
  const name = next.trim();
  try {
    await window.api.tmux.command(rec.id, `rename-session -t ${quote(rec.name)} ${quote(name)}`);
  } catch (e) {
    return toast(e.message, 'error');
  }
  const was = rec.name;
  rec.name = name;
  /*
   * The host now opens this one.
   *
   * Without that, "Open session" would go on using the name it had before —
   * the host's own setting, or the global default — and start a *second*
   * session beside the renamed one, which is how a session someone named
   * because it mattered becomes a session they cannot find. Renaming is a
   * clear enough statement of which session this host means.
   */
  const names = { ...(state.settings.tmuxSessionNames || {}) };
  const { hostPrefKey } = await import('./sidebar.js');
  const key = hostPrefKey(rec.host);
  let pinned = false;
  if (key && names[key] !== name) {
    names[key] = name;
    state.settings = await window.api.settings.set({ tmuxSessionNames: names });
    pinned = true;
  }
  status(pinned
    ? `Renamed to “${name}” — ${rec.host.name || rec.host.alias} now opens this session`
    : `Renamed to “${name}”`);
  if (was) { /* the old name is gone from the host; nothing else refers to it */ }
  const { refreshPaneTitles } = await import('./sessions.js');
  refreshPaneTitles();
}

/**
 * Rename the window this pane is in — which is what the tab is called.
 *
 * tmux names a window after whatever is running in it, so a tab that said
 * `zsh` a moment ago says `htop` now. Naming one by hand stops that for that
 * window, which is the point: the tab you want to find again should not be
 * renamed by the thing you just ran in it.
 */
export async function renameTmuxWindow(pane) {
  const rec = sessions.get(pane?.tmuxId);
  if (!rec) return;
  const tab = state.getTab(pane.tabId);
  if (!tab?.tmuxWindow) return;
  const next = await prompt({
    title: 'Rename this window',
    label: 'What the tab is called',
    value: tab.tmuxName || '',
    confirmLabel: 'Rename',
  });
  if (next === null || next === undefined) return;
  try {
    await window.api.tmux.command(rec.id, `rename-window -t ${tab.tmuxWindow} ${quote(next.trim() || 'window')}`);
  } catch (e) { toast(e.message, 'error'); }
}

/** Single quotes, the only quoting that is always right for a remote shell. */
function quote(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/** The session this pane belongs to, for menus. */
export function tmuxSessionOf(pane) {
  return sessions.get(pane?.tmuxId) || null;
}

/* ------------------------------------------------------------------ */
/* The "open in tmux" dialog                                           */
/* ------------------------------------------------------------------ */

/**
 * Which session, on a host that may already have several.
 *
 * Asked rather than assumed, because attaching to the wrong one is the one
 * mistake here that looks like data loss: your work is not gone, it is in the
 * session you did not pick.
 */
export async function openTmuxDialog(host, { login } = {}) {
  const label = host.name || host.alias || 'host';
  const nameIn = textInput({ value: state.settings.tmuxSessionName || 'serverlife', placeholder: 'serverlife' });
  const pick = select([], '');
  const body = el('div');
  let ready = false;
  let attachBtn = null;

  /*
   * The dialog opens before the host has been asked anything.
   *
   * Finding out what is already running there means dialling first, and on a
   * node behind a proxy that is ten or twenty seconds. Showing nothing until
   * the answer arrives makes the menu item look broken; showing the dialog
   * with "connecting" in it is the same wait with something to look at, and
   * Escape still works.
   */
  const waiting = el('div', { class: 'hint' }, `Connecting to ${label}…`);
  body.append(waiting);

  const load = async () => {
    let connId;
    try {
      connId = await dial(host, { login });
    } catch (e) {
      waiting.textContent = e.message;
      return null;
    }
    const probe = await window.api.tmux.probe(connId).catch((e) => ({ ok: false, reason: e.message }));
    if (!probe.ok) return { probe };

    waiting.textContent = `tmux ${probe.version} — reading the sessions already running there…`;
    const existing = await window.api.tmux.sessions(connId).catch(() => []);
    return { probe, existing };
  };

  const fill = ({ probe, existing }) => {
    ready = true;
    body.replaceChildren();
    for (const sess of existing || []) {
      pick.append(el('option', {
        value: sess.name,
        text: `${sess.name} — ${sess.windows} window${sess.windows === 1 ? '' : 's'}`
          + `${sess.attached ? ', attached elsewhere' : ''}`,
      }));
    }
    pick.append(el('option', { value: '', text: existing?.length ? 'A new session…' : 'Start a session' }));
    pick.value = existing?.[0]?.name || '';

    const nameField = field('Name', nameIn);
    const syncName = () => nameField.classList.toggle('hidden', !!pick.value);
    pick.addEventListener('change', syncName);

    body.append(
      field('Session', pick, existing?.length
        ? 'Already running there — attaching picks up where it was left'
        : 'Nothing is running there yet'),
      nameField,
      el('div', { class: 'hint', style: 'margin-top:10px' },
        `tmux is a terminal multiplexer: a program that has to be installed and running `
        + `on ${label} itself, not something ServerLife brings with it, that holds a `
        + `shell session open independently of whatever connects to it. tmux `
        + `${probe.version} is already there, so this is covered. What runs inside it `
        + 'keeps running when this window goes away — a dropped connection, a closed '
        + 'laptop, a restarted app — and reattaching brings back the scrollback with it.'));
    syncName();
    if (attachBtn) { attachBtn.disabled = false; attachBtn.textContent = 'Attach'; }
  };

  const res = await modal({
    title: `tmux on ${label}`,
    width: 520,
    render: (b) => { b.append(body); },
    onOpen: ({ box, close }) => {
      attachBtn = [...box.querySelectorAll('button')].find((x) => /Attach|Connecting/.test(x.textContent));
      if (attachBtn) { attachBtn.disabled = true; attachBtn.textContent = 'Connecting…'; }
      load().then((r) => {
        if (!r) { if (attachBtn) attachBtn.textContent = 'Attach'; return; }
        if (!r.probe.ok) { close(null); explainMissingTmux(host, r.probe); return; }
        fill(r);
      }).catch((e) => { waiting.textContent = e.message; });
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Attach', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!ready) return;
          close(pick.value || nameIn.value.trim() || 'serverlife');
        },
      },
    ],
  });
  if (!res) return null;
  return openTmux(host, { login, session: res });
}

/**
 * Keep tmux's idea of the active pane in step with the focused one.
 *
 * tmux resolves "the current pane" from the attached client, and a control
 * client that never says which pane it is looking at leaves that pointing at
 * whatever was active when it attached. Everything that defaults to the
 * current pane then goes to the wrong place: a `tmux display` run by hand, a
 * split from another client, copy mode. Nobody notices until something lands
 * somewhere surprising, which is the worst way to find out.
 */
function followFocus(pane) {
  const rec = sessions.get(pane?.tmuxId);
  if (!rec || !pane.tmuxPane) return;
  if (rec.lastSelected === pane.tmuxPane) return;
  rec.lastSelected = pane.tmuxPane;
  window.api.tmux.command(rec.id, `select-pane -t ${pane.tmuxPane}`).catch(() => {});
  /*
   * Where that pane's shell actually is, so the file browser can follow the
   * terminal as it does on an ordinary session. Asked on focus rather than
   * polled: it is the moment the answer starts to matter, and every question
   * is a command round trip.
   */
  window.api.tmux.command(rec.id, `display-message -p -t ${pane.tmuxPane} '#{pane_current_path}'`)
    .then((lines) => {
      const dir = (lines || [])[0];
      if (!dir || pane.cwd === dir) return;
      // Setting it is enough: the file browser's own follow loop reads
      // `pane.cwd` and moves when it changes, the same for every session.
      pane.cwd = dir;
    })
    .catch(() => {});
}

/** Subscribe once, at startup. */
export function initTmux() {
  state.on('activePane', (pane) => followFocus(pane));
  window.api.tmux.onOutput((p) => routeTmuxOutput(p));
  window.api.tmux.onLayout((p) => routeTmuxLayout(p));
  window.api.tmux.onWindows((p) => routeTmuxWindows(p));
  window.api.tmux.onPause((p) => routeTmuxPause(p));
  window.api.tmux.onEnded((p) => routeTmuxEnded(p));
}
