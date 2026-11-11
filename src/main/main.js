'use strict';
/**
 * Electron main process: window lifecycle and the IPC surface the renderer
 * talks to. All privileged work (spawning ssh, touching the filesystem) lives
 * here; the renderer is sandboxed and reaches it only through preload.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, safeStorage, screen, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');

/*
 * A UTF-8 locale for everything started from here, when the app was given none.
 *
 * Opened from the Dock or Finder, the app gets launchd's environment, which
 * has no LANG at all — and everything it starts inherits that. tmux is the one
 * that breaks visibly: without a UTF-8 locale it rewrites every tab and every
 * non-ASCII character in its output as `_`, so its tab-separated session and
 * window lists cannot be read, and attaching to tmux on this machine showed
 * nothing. A local shell and the LANG that ssh forwards to a server are the
 * same gap, quieter. Terminal.app fills it the same way; a locale the user
 * did set is left alone.
 */
if (process.platform !== 'win32' && !process.env.LANG && !process.env.LC_ALL && !process.env.LC_CTYPE) {
  process.env.LANG = 'en_US.UTF-8';
}

const { ConnectionManager } = require('./connections');
const { MultiExec } = require('./multiexec');
const { Store, hostPrefKey, clusterPrefKey } = require('./store');
const teleport = require('./teleport');
const livesessions = require('./livesessions');
const localhost = require('./localhost');
const sshoptions = require('./sshoptions');
const aiclients = require('./aiclients');
const { VnetManager } = require('./vnet');
const sshbin = require('./sshbin');
const { ControlServer } = require('./control');
const sshconfig = require('./sshconfig');
const local = require('./local');
const ansible = require('./ansible');
const crosstransfer = require('./crosstransfer');
const sshkeys = require('./sshkeys');
const nettools = require('./nettools');
const sockets = require('./sockets');
const findfiles = require('./findfiles');
const cityscan = require('./cityscan');
const procscan = require('./procscan');
const backup = require('./backup');
const s3 = require('./s3');
const rsync = require('./rsync');
const syncdirs = require('./syncdirs');
const watchdirs = require('./watchdirs');
const authprobe = require('./authprobe');
const beams = require('./beams');
const phasesetup = require('./phasesetup');
const localmonitor = require('./localmonitor');
const kube = require('./kube');
const kubebin = require('./kubebin');
const kubefs = require('./kubefs');
const kuberesources = require('./kuberesources');
const kubeops = require('./kubeops');
const kubeexport = require('./kubeexport');
const kubeproxy = require('./kubeproxy');
const kubeforward = require('./kubeforward');
const kubelogs = require('./kubelogs');
const kubewatch = require('./kubewatch');
const kubemetrics = require('./kubemetrics');
const kubelint = require('./kubelint');
const kubetest = require('./kubetest');
const kubeexplain = require('./kubeexplain');
const kubekustomize = require('./kubekustomize');
const kubehelm = require('./kubehelm');
const kubescan = require('./kubescan');
const kubegraph = require('./kubegraph');
const decoders = require('./decoders');
const awsproxy = require('./awsproxy');
const awscreds = require('./awscreds');
const mxfile = require('./multiexecfile');
const { DeviceSessions } = require('./devices');
const tmuxctl = require('./tmuxctl');
const { VncBridge } = require('./vncbridge');
const rdp = require('./rdp');
const { spawn, execFile } = require('child_process');
const { planUpload, planDownload, posixJoin, downloadFile, uploadFile, PlanCancelled } = require('./transfers');

// Set before anything reads app.name, so the menu bar and About panel say
// "ServerLife" rather than "Electron" when running unpackaged.
app.setName('ServerLife');

// A throwaway profile, for the Electron tests: they drive a second copy of the
// app beside the one in use, and must not read or write its settings.
if (process.env.SERVERLIFE_USER_DATA) app.setPath('userData', process.env.SERVERLIFE_USER_DATA);

/**
 * Windows are a set, not a singleton. Each one holds a *slot* — `w1`, `w2` —
 * which is how its layout is remembered, so reopening the app can put the same
 * arrangement back in the same window rather than merging everything into one.
 */
const windows = new Map();   // slot -> BrowserWindow
let store = null;
let manager = null;
let multiexec = null;
let localTerms = null;
/*
 * Serial and telnet sessions, and the VNC bridge. Separate from the
 * connection manager on purpose: none of them multiplexes, none of them has a
 * filesystem behind it, and a console cable has no more in common with an SSH
 * ControlMaster than a telephone does.
 */
let devices = null;
let vnc = null;
/* Attached tmux control-mode sessions, by the id the renderer knows them by. */
const tmuxSessions = new Map();
let control = null;

const isDev = !app.isPackaged;
let quitting = false;
/*
 * Asking before quitting with sessions open.
 *
 * `quitConfirmed` is the answer, kept so it is only asked for once: closing
 * the last window on Windows or Linux asks, and the app.quit() that follows
 * from it must not ask again. `quitAsking` covers the other impatient case —
 * Cmd+Q pressed a second time while the question is still on screen — which
 * should neither stack a second dialog nor quit behind the first one's back.
 */
let quitConfirmed = false;
let quitAsking = false;

/**
 * Push events carry ids the renderer either recognises or ignores — a terminal
 * it does not own, a connection it never opened — so broadcasting is both
 * correct and simpler than routing every event to the right window.
 */
function send(channel, ...args) {
  for (const w of windows.values()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

/** Menu commands mean "here", so they go to the window the user is looking at. */
function sendFocused(channel, ...args) {
  const w = BrowserWindow.getFocusedWindow() || [...windows.values()][0];
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
}

/**
 * Ask the focused window to do something and wait for the answer.
 *
 * Tabs, panes and the inventory live in the renderer, so anything the control
 * socket offers that touches them has to be asked for rather than done here.
 * One pending table, keyed by request id, with a timeout — a renderer that
 * never answers must not leave the caller hanging.
 */
const rendererCalls = new Map();
let rendererCallSeq = 0;

function askRenderer(action, payload = {}, { timeout = 60000, win = null } = {}) {
  const w = win || BrowserWindow.getFocusedWindow() || [...windows.values()][0];
  if (!w || w.isDestroyed()) return Promise.reject(new Error('No ServerLife window is open.'));
  const id = 'rc' + (++rendererCallSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rendererCalls.delete(id);
      reject(new Error(`The window did not answer "${action}" in time.`));
    }, timeout);
    rendererCalls.set(id, { resolve, reject, timer });
    w.webContents.send('automation', { id, action, payload });
  });
}

/** A modal belongs to the window that asked for it. */
function dialogParent() {
  return BrowserWindow.getFocusedWindow() || [...windows.values()][0] || null;
}

ipcMain.on('automation:result', (_evt, { id, ok, data, error } = {}) => {
  const pending = rendererCalls.get(id);
  if (!pending) return;
  rendererCalls.delete(id);
  clearTimeout(pending.timer);
  if (ok) pending.resolve(data);
  else pending.reject(new Error(error || 'automation failed'));
});

function windowFor(evt) {
  const w = BrowserWindow.fromWebContents(evt.sender);
  return w ? w.__slSlot : null;
}

/** The lowest slot no live window is using, so closing w1 frees it again. */
function nextSlot() {
  for (let i = 1; ; i++) {
    const slot = 'w' + i;
    if (!windows.has(slot)) return slot;
  }
}

/**
 * The size and position this window was last left at.
 *
 * Checked against the displays that exist *now*: a window remembered on a
 * second monitor that has since been unplugged would otherwise open somewhere
 * nobody can reach it. Anything that does not fit is clamped, and a position
 * that lands nowhere is dropped so Electron centres the window instead.
 */
function savedWindowBounds(slot) {
  const b = (store.settings.windowBounds || {})[slot];
  if (!b || !b.width || !b.height) return null;

  const area = screen.getDisplayMatching({
    x: Number(b.x) || 0, y: Number(b.y) || 0,
    width: Number(b.width), height: Number(b.height),
  }).workArea;

  const width = Math.max(900, Math.min(Number(b.width), area.width));
  const height = Math.max(600, Math.min(Number(b.height), area.height));
  const out = { width, height, maximized: !!b.maximized, fullScreen: !!b.fullScreen };

  // Keep at least a strip of the title bar reachable; otherwise forget where
  // it was and let the window be centred.
  const onScreen = Number.isFinite(b.x) && Number.isFinite(b.y)
    && b.x + width > area.x + 60 && b.x < area.x + area.width - 60
    && b.y + height > area.y + 20 && b.y < area.y + area.height - 60;
  if (onScreen) { out.x = Math.round(b.x); out.y = Math.round(b.y); }
  return out;
}

/**
 * Remember it, debounced.
 *
 * Resizing fires continuously, and the store writes to disk, so this waits for
 * the drag to stop. A maximised or full-screen window records the size it
 * would go back to rather than the screen it currently fills.
 */
function rememberWindowBounds(win, slot) {
  if (win.isDestroyed()) return;
  const bounds = win.isMaximized() || win.isFullScreen()
    ? (win.__slNormalBounds || win.getNormalBounds?.() || win.getBounds())
    : win.getBounds();
  const all = { ...(store.settings.windowBounds || {}) };
  all[slot] = {
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  };
  store.updateSettings({ windowBounds: all });
}

/**
 * `adopt` carries a pane being dragged out of another window: the
 * connection and terminal already exist and keep running, and the new
 * window binds to them instead of restoring a workspace. It is handed over
 * once — the renderer collects it at startup and it is cleared — so a
 * reload of that window does not try to adopt a pane it already has.
 */
function createWindow({ restoreSlot = null, autoRestore = false, adopt = null } = {}) {
  const slot = restoreSlot && !windows.has(restoreSlot) ? restoreSlot : nextSlot();
  const remembered = savedWindowBounds(slot);
  const win = new BrowserWindow({
    width: remembered?.width || 1500,
    height: remembered?.height || 950,
    ...(remembered && remembered.x !== undefined
      ? { x: remembered.x, y: remembered.y }
      : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'ServerLife',
    backgroundColor: '#12141a',
    // The inset traffic-light treatment is macOS-only; elsewhere keep the
    // native frame so the window stays usable.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.__slSlot = slot;
  // A window opened *because* the user agreed to restore must not ask again.
  win.__slAutoRestore = !!autoRestore;
  /*
   * A pane being handed over from another window.
   *
   * Pushed rather than waited for: the renderer asking "is there one for
   * me?" at startup turns a handoff into a race between its first question
   * and this window finishing its load, and a lost race leaves a window
   * with nothing in it and a session running nowhere. It is sent when the
   * page is ready and kept until the renderer says it has taken it, so a
   * reload before that still gets its pane.
   */
  win.__slAdopt = adopt;
  if (adopt) {
    win.webContents.on('did-finish-load', () => {
      if (win.__slAdopt) win.webContents.send('pane:adopt', win.__slAdopt);
    });
  }
  windows.set(slot, win);

  if (remembered?.maximized) win.maximize();
  if (remembered?.fullScreen) win.setFullScreen(true);

  /*
   * Keep the size the window would return to, so a maximised window that is
   * closed maximised still remembers a sensible size underneath.
   */
  win.__slNormalBounds = win.getBounds();
  const noteNormal = () => {
    if (!win.isMaximized() && !win.isFullScreen() && !win.isMinimized()) {
      win.__slNormalBounds = win.getBounds();
    }
  };

  let boundsTimer = null;
  const scheduleRemember = () => {
    noteNormal();
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => rememberWindowBounds(win, slot), 400);
  };
  win.on('resize', scheduleRemember);
  win.on('move', scheduleRemember);
  win.on('maximize', scheduleRemember);
  win.on('unmaximize', scheduleRemember);
  win.on('enter-full-screen', scheduleRemember);
  win.on('leave-full-screen', scheduleRemember);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    if (windows.get(slot) === win) windows.delete(slot);
  });

  // A window the user closed deliberately should not come back tomorrow — but
  // its size should, which is a preference rather than a session.
  win.on('close', (e) => {
    /*
     * Closing the last window is quitting, everywhere but macOS — and by the
     * time before-quit hears about it the window, and every session in it,
     * has already gone. So the question is asked here, while there is still
     * something to keep. The close is held, and done again if the answer is
     * Quit; that second time round `quitConfirmed` waves it through, and
     * before-quit after it.
     */
    if (!quitting && !quitConfirmed && process.platform !== 'darwin'
        && [...windows.values()].filter((w) => !w.isDestroyed()).length === 1) {
      e.preventDefault();
      if (quitAsking) return;
      quitAsking = true;
      confirmQuit().catch(() => true).then((go) => {
        quitAsking = false;
        if (!go) return;
        quitConfirmed = true;
        if (!win.isDestroyed()) win.close();
      });
      return;
    }
    clearTimeout(boundsTimer);
    rememberWindowBounds(win, slot);
    if (!quitting) store.clearWorkspace(slot);
  });

  // External links open in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'About ServerLife', click: () => sendFocused('menu', 'about') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendFocused('menu', 'settings') },
        { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Session',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Alt+N', click: () => createWindow() },
        { label: 'New Session…', accelerator: 'CmdOrCtrl+N', click: () => sendFocused('menu', 'new-session') },
        // Between the two: New Session picks from what you have, Add a Server
        // defines something to keep, and this dials an address once.
        { label: 'Quick Connect…', accelerator: 'CmdOrCtrl+Alt+C', click: () => sendFocused('menu', 'quick-connect') },
        { label: 'Add a Server…', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendFocused('menu', 'add-server') },
        { label: 'New Local Shell', accelerator: 'CmdOrCtrl+T', click: () => sendFocused('menu', 'new-local') },
        { label: 'Show/Hide Local Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendFocused('menu', 'local-files') },
        { label: 'Duplicate Tab', accelerator: 'CmdOrCtrl+D', click: () => sendFocused('menu', 'duplicate-tab') },
        { type: 'separator' },
        { label: 'Split Right', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendFocused('menu', 'split-right') },
        { label: 'Split Down', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendFocused('menu', 'split-down') },
        { label: 'Split Right with Another Host…', accelerator: 'CmdOrCtrl+Alt+D', click: () => sendFocused('menu', 'split-right-host') },
        { label: 'Split Down with Another Host…', accelerator: 'CmdOrCtrl+Alt+E', click: () => sendFocused('menu', 'split-down-host') },
        {
          label: 'Move Pane',
          submenu: [
            { label: 'Left', accelerator: 'CmdOrCtrl+Shift+Left', click: () => sendFocused('menu', 'move-pane-left') },
            { label: 'Right', accelerator: 'CmdOrCtrl+Shift+Right', click: () => sendFocused('menu', 'move-pane-right') },
            { label: 'Up', accelerator: 'CmdOrCtrl+Shift+Up', click: () => sendFocused('menu', 'move-pane-up') },
            { label: 'Down', accelerator: 'CmdOrCtrl+Shift+Down', click: () => sendFocused('menu', 'move-pane-down') },
          ],
        },
        { label: 'Close Pane', accelerator: 'CmdOrCtrl+W', click: () => sendFocused('menu', 'close-pane') },
        { type: 'separator' },
        { label: 'Toggle Session Log', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendFocused('menu', 'toggle-log') },
        { type: 'separator' },
        { label: 'Command Snippets…', accelerator: 'CmdOrCtrl+Shift+C', click: () => sendFocused('menu', 'snippets') },
        { label: 'SSH Keys…', accelerator: 'CmdOrCtrl+Shift+K', click: () => sendFocused('menu', 'keys') },
        { label: 'Network and Certificate Tools…', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendFocused('menu', 'nettools') },
        { label: 'S3 Buckets…', click: () => sendFocused('menu', 's3') },
        { label: 'Run Macro…', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendFocused('menu', 'run-macro') },
        { label: 'Multi-Exec…', accelerator: 'CmdOrCtrl+Shift+M', click: () => sendFocused('menu', 'multiexec') },
        { label: 'Toggle Broadcast Typing', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendFocused('menu', 'broadcast') },
        { type: 'separator' },
        { type: 'separator' },
        {
          label: 'Layouts',
          submenu: [
            { label: 'Save Layout As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendFocused('menu', 'save-layout-as') },
            { label: 'Load Layout…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendFocused('menu', 'load-layout') },
            { type: 'separator' },
            { label: 'Manage Layouts…', click: () => sendFocused('menu', 'manage-layouts') },
            { type: 'separator' },
            { label: 'Remember Current Layout', click: () => sendFocused('menu', 'save-layout') },
            { label: 'Forget Remembered Layout', click: () => sendFocused('menu', 'clear-layout') },
          ],
        },
        { type: 'separator' },
        { label: 'Disconnect', click: () => sendFocused('menu', 'disconnect') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Terminal', accelerator: 'CmdOrCtrl+F', click: () => sendFocused('menu', 'find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Show/Hide File Explorers', accelerator: 'CmdOrCtrl+E', click: () => sendFocused('menu', 'toggle-files') },
        { label: 'Explorer Beside / Above Terminal', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendFocused('menu', 'explorer-position') },
        { label: 'Show/Hide Hosts', accelerator: 'CmdOrCtrl+B', click: () => sendFocused('menu', 'toggle-sidebar') },
        { label: 'Toggle Transfers', accelerator: 'CmdOrCtrl+J', click: () => sendFocused('menu', 'toggle-transfers') },
        { type: 'separator' },
        /*
         * `=` rather than `Plus`: Plus is Shift+= on most layouts, so the key
         * people actually press did nothing. The shifted form and the keypad's
         * are handled in the window (index.js) — they cannot share an item.
         * They size the pane you are in, or the host list if you are there.
         */
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: () => sendFocused('menu', 'zoom-in') },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: () => sendFocused('menu', 'zoom-out') },
        { label: 'Default Text Size', accelerator: 'CmdOrCtrl+0', click: () => sendFocused('menu', 'zoom-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }, { role: 'reload' }] : []),
      ],
    },
    {
      label: 'Teleport',
      submenu: [
        { label: 'Refresh Inventory', accelerator: 'CmdOrCtrl+R', click: () => sendFocused('menu', 'refresh') },
        { label: 'Profiles & Access Requests…', click: () => sendFocused('menu', 'teleport-panel') },
        { label: 'Cluster Information…', click: () => sendFocused('menu', 'cluster-info') },
        {
          label: 'Monitor Requestable Resources…',
          click: () => sendFocused('menu', 'request-monitor'),
        },
        { type: 'separator' },
        { label: 'Session History…', accelerator: 'CmdOrCtrl+Y', click: () => sendFocused('menu', 'history') },
        { label: 'Recorded Sessions…', accelerator: 'CmdOrCtrl+Shift+Y', click: () => sendFocused('menu', 'recordings') },
        { type: 'separator' },
        { label: 'tsh login…', click: () => sendFocused('menu', 'tsh-login') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        // First in Help because it is the answer to "what is this and how do I
        // use it", which is what the menu is opened for.
        { label: 'Take the Tour…', click: () => sendFocused('menu', 'tour') },
        // The reference, in the app: the moment anyone wants it is while they
        // are looking at the thing they are asking about.
        {
          label: 'Guide — what everything does…',
          accelerator: 'CmdOrCtrl+/',
          click: () => sendFocused('menu', 'guide'),
        },
        { type: 'separator' },
        { label: 'About ServerLife', click: () => sendFocused('menu', 'about') },
        { label: 'Version History…', click: () => sendFocused('menu', 'version-history') },
        { type: 'separator' },
        {
          label: 'Teleport Documentation',
          click: () => shell.openExternal('https://goteleport.com/docs/connect-your-client/tsh/'),
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** Wrap a handler so the renderer always gets {ok, data|error} instead of a throw. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

/**
 * As `handle`, but the handler is told which window asked. Used where the
 * answer differs per window — its own saved layout, its own identity — rather
 * than being global state like the connection list.
 */
function handleWin(channel, fn) {
  ipcMain.handle(channel, async (evt, ...args) => {
    try {
      const data = await fn(windowFor(evt) || 'w1', ...args);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

/**
 * A kube cluster, named, for the control socket's own read-only verbs —
 * resolved from `kube.listContexts()` alone (every context, Teleport-
 * sourced or not, already carries `contextName`/`kubeconfigPaths`,
 * everything `kuberesources.js`'s functions need). Nothing renderer-only
 * is needed for a read: a cluster has to already be logged in to answer
 * one at all, so `kubeHostsForProfile`'s own available/requestable
 * states have nothing to add here — `list_hosts`/`open_session` are
 * where logging in happens, not this.
 */
async function resolveKubeContext(name) {
  if (!name) throw new Error('Give a "cluster".');
  const r = await kube.listContexts({ extraPaths: store.settings.kubeconfigPaths || [] });
  if (!r.ok) throw new Error(r.error || 'Could not read kubeconfig contexts.');
  const byContextName = r.contexts.find((c) => c.contextName === name);
  if (byContextName) return byContextName;
  const byKubeName = r.contexts.filter((c) => c.kubeClusterName === name);
  if (byKubeName.length === 1) return byKubeName[0];
  if (byKubeName.length > 1) {
    throw new Error(`"${name}" matches ${byKubeName.length} logged-in contexts: `
      + byKubeName.map((c) => c.contextName).join(', ') + '. Give the exact context name.');
  }
  throw new Error(`No logged-in cluster called "${name}". Try serverlife_list_hosts to see what is available, `
    + 'or serverlife_open_session to log in first — this only reads from a cluster already logged into.');
}

/** A discovered resource type matching `kind`, case-insensitive — the same rule the cross-cluster search in kubebrowser.js already uses. */
async function resolveKubeType(spec, kind) {
  if (!kind) throw new Error('Give a "kind" (e.g. Pod, Deployment).');
  const r = await kuberesources.discoverResourceTypes(spec);
  if (!r.ok) throw new Error(r.error || 'Could not list resource kinds for that cluster.');
  const type = r.types.find((t) => t.kind.toLowerCase() === kind.toLowerCase());
  if (!type) throw new Error(`"${kind}" is not a kind this cluster lists. Try serverlife_list_kube_resource_types.`);
  return type;
}

/* ------------------------------------------------------------------ */
/* Control socket verbs                                                */
/* ------------------------------------------------------------------ */

/**
 * What an outside program is allowed to ask for.
 *
 * Reads are answered here where they can be (inventory, clusters, layouts,
 * macros, tool paths); anything that opens or closes a session is asked of the
 * window, because that is where tabs and panes live. There is deliberately no
 * verb that runs an arbitrary command: `run_macro` runs something the user
 * wrote and can read, which is a line worth holding.
 */
const CONTROL_VERBS = {
  async status() {
    const tp = await teleport.status();
    return {
      app: 'ServerLife',
      version: app.getVersion(),
      platform: process.platform,
      windows: windows.size,
      tsh: teleport.tshStatus(),
      ssh: sshbin.sshStatus(),
      clusters: tp.profiles.map((p) => ({
        cluster: p.cluster, proxy: p.proxy, user: p.username,
        home: p.home || null, expired: !!p.expired, active: !!p.active,
      })),
    };
  },

  async list_hosts({ query, limit = 200 } = {}) {
    const [ssh, tp, kubeCtx] = await Promise.all([
      sshHostList().catch(() => []),
      teleport.status().catch(() => ({ profiles: [] })),
      kube.listContexts({ extraPaths: store.settings.kubeconfigPaths || [] }).catch(() => ({ ok: false, contexts: [] })),
    ]);
    const kubeContexts = kubeCtx.ok ? kubeCtx.contexts : [];
    const nodes = [];
    const beamList = [];
    const kubeList = [];
    for (const p of (tp.profiles || []).filter((x) => !x.expired)) {
      /*
       * Beams by the name they are opened with. Each also registers as a
       * `beam-<uuid>` node, which is listed too but says which beam it is —
       * opened as a plain node it fails, so the beam's name is the one to use.
       */
      const probe = await beams.supported({ proxy: p.proxy, home: p.homeDir }).catch(() => ({ ok: false }));
      const bs = probe.ok
        ? (await beams.list({ proxy: p.proxy, home: p.homeDir }).catch(() => ({ beams: [] }))).beams
        : [];
      const byNode = new Map(bs.filter((b) => b.uuid).map((b) => ['beam-' + b.uuid, b.id]));
      for (const b of bs) {
        beamList.push({
          kind: 'beam', name: b.id, uuid: b.uuid, cluster: p.cluster, proxy: p.proxy, region: b.region,
          expires: b.expires ? new Date(b.expires).toISOString() : null,
        });
      }
      const r = await teleport.listNodes({ proxy: p.proxy, cluster: p.cluster, home: p.homeDir }).catch(() => null);
      for (const n of r?.nodes || []) {
        nodes.push({
          kind: 'teleport', name: n.name, cluster: n.cluster, home: n.home || null,
          ...(byNode.has(n.name) ? { beam: byNode.get(n.name) } : {}),
          addr: n.addr || null, labels: n.labels || {}, logins: p.logins || [],
          // What the window would do with this host, so a caller does not have
          // to guess at the account or wonder why a session used another one.
          starred: (store.settings.starredHosts || []).includes(n.id),
          preferredUser: (store.settings.hostUsers || {})[hostPrefKey(n)] || null,
          agentForward: agentForwardFor(n),
        });
      }
      // Kube clusters, named like a host for exactly this reason — see
      // MCP.md's own "KubeLife" section. Logged in first (same rule
      // kubepanel.js's contextsForProfile uses to match a context to its
      // profile); available-but-not-logged-in ones fill in the rest, not
      // double-counting a name already in the first group. Requestable-
      // only clusters are left out, same as list_hosts never surfaces an
      // SSH node you would first have to request — a mutating action
      // this interface still does not offer.
      const mineKube = kubeContexts.filter((c) => c.source === 'teleport'
        && (c.teleportCluster === p.cluster || (!c.teleportCluster && c.teleportProxy === p.proxy)));
      const mineKubeNames = new Set(mineKube.map((c) => c.kubeClusterName || c.name));
      for (const c of mineKube) {
        kubeList.push({
          kind: 'kube', name: c.kubeClusterName || c.name, cluster: p.cluster, proxy: p.proxy,
          home: p.homeDir || null, loggedIn: true, contextName: c.contextName,
        });
      }
      const availKube = await kube.listKubeClusters({ proxy: p.proxy, home: p.homeDir }).catch(() => ({ ok: false, clusters: [] }));
      if (availKube.ok) {
        for (const cl of availKube.clusters) {
          if (mineKubeNames.has(cl.name)) continue;
          kubeList.push({
            kind: 'kube', name: cl.name, cluster: p.cluster, proxy: p.proxy,
            home: p.homeDir || null, loggedIn: false, labels: cl.labels || {},
          });
        }
      }
    }
    const hosts = [
      ...beamList,
      ...nodes,
      ...kubeList,
      ...ssh.map((h) => ({
        kind: 'ssh', name: h.alias, user: h.user, hostname: h.hostname, port: h.port,
        // Which config file it came from; null means ~/.ssh/config.
        configFile: h.configFile || null,
        starred: (store.settings.starredHosts || []).includes(h.id),
        preferredUser: (store.settings.hostUsers || {})[hostPrefKey(h)] || null,
      })),
      ...store.listProfiles().map((p) => ({
        kind: 'profile', name: p.name, type: p.type, cluster: p.cluster || null,
        // Where it actually points — useful for an sftp/ssh profile especially,
        // where the name alone does not say what it dials.
        hostname: p.hostname || p.direct?.hostname || null,
        port: p.port || p.direct?.port || null,
        user: p.user || p.direct?.user || null,
      })),
    ];
    const q = String(query || '').toLowerCase();
    const matched = q
      ? hosts.filter((h) => JSON.stringify(h).toLowerCase().includes(q))
      : hosts;
    return { count: matched.length, hosts: matched.slice(0, Math.max(1, Math.min(1000, limit))) };
  },

  async list_clusters() {
    const tp = await teleport.status();
    return {
      homes: tp.homes,
      clusters: tp.profiles.map((p) => ({
        cluster: p.cluster, proxy: p.proxy, user: p.username, roles: p.roles || [],
        logins: p.logins || [], home: p.home || null, homeName: p.homeName || '',
        expired: !!p.expired, active: !!p.active, validUntil: p.validUntil || null,
      })),
      saved: store.listTshLogins().map((t) => ({ name: t.name, proxy: t.proxy, user: t.user, home: t.home || null })),
    };
  },

  /** The command to paste into a terminal. Reading it changes nothing. */
  async login_command({ cluster, proxy, user, home } = {}) {
    const tp = await teleport.status();
    const p = tp.profiles.find((x) => x.cluster === cluster || x.proxy === proxy)
      || store.listTshLogins().find((x) => x.cluster === cluster || x.proxy === proxy);
    const target = {
      proxy: proxy || p?.proxy,
      user: user || p?.username || p?.user,
      home: home || p?.homeDir || p?.home,
    };
    if (!target.proxy) throw new Error('No such cluster, and no proxy given.');
    return { command: teleport.loginCommand(target) };
  },

  /** Every resource kind a kube cluster actually has — kuberesources.js's own discovery, no fixed list. */
  async list_kube_resource_types({ cluster } = {}) {
    const spec = await resolveKubeContext(cluster);
    const r = await kuberesources.discoverResourceTypes(spec);
    if (!r.ok) throw new Error(r.error || 'Could not list resource kinds.');
    return { cluster: spec.contextName, types: r.types };
  },

  /** Resources of one kind — kubectl get, trimmed the same way the app's own cluster browser shows a row. */
  async list_kube_resources({ cluster, kind, namespace, selector, limit = 100 } = {}) {
    const spec = await resolveKubeContext(cluster);
    const type = await resolveKubeType(spec, kind);
    const r = await kuberesources.getResources(spec, { name: type.name, namespaced: type.namespaced, namespace, selector });
    if (!r.ok) throw new Error(r.error || 'Could not list that resource.');
    const items = r.items || [];
    return { cluster: spec.contextName, kind: type.kind, count: items.length, items: items.slice(0, Math.max(1, Math.min(1000, limit))) };
  },

  /** One resource's own YAML — kubectl get -o yaml, read-only. */
  async get_kube_resource({ cluster, kind, name, namespace } = {}) {
    if (!name) throw new Error('Give a "name".');
    const spec = await resolveKubeContext(cluster);
    const type = await resolveKubeType(spec, kind);
    const r = await kuberesources.getYaml(spec, { name, resource: type.name, namespace });
    if (!r.ok) throw new Error(r.error || 'Could not read that resource.');
    return { cluster: spec.contextName, kind: type.kind, name, yaml: r.yaml };
  },

  /** `kubectl describe` for one resource — conditions and recent events, in kubectl's own words. */
  async describe_kube_resource({ cluster, kind, name, namespace } = {}) {
    if (!name) throw new Error('Give a "name".');
    const spec = await resolveKubeContext(cluster);
    const type = await resolveKubeType(spec, kind);
    const r = await kuberesources.describe(spec, { name, resource: type.name, namespace });
    if (!r.ok) throw new Error(r.error || 'Could not describe that resource.');
    return { cluster: spec.contextName, kind: type.kind, name, text: r.text };
  },

  async list_layouts() {
    return { layouts: store.listLayouts() };
  },

  /**
   * Beams, so a caller can name one before syncing to it. Cheap when no
   * cluster has the service: the probe is cached and a cluster without it is
   * asked once.
   */
  async list_beams({ proxy } = {}) {
    const tp = await teleport.status();
    const out = [];
    for (const p of (tp.profiles || []).filter((x) => !x.expired)) {
      if (proxy && p.proxy !== proxy) continue;
      const probe = await beams.supported({ proxy: p.proxy, home: p.homeDir }).catch(() => ({ ok: false }));
      if (!probe.ok) continue;
      const r = await beams.list({ proxy: p.proxy, home: p.homeDir }).catch(() => ({ ok: false, beams: [] }));
      for (const b of r.beams) {
        out.push({
          beam: b.id, uuid: b.uuid, cluster: p.cluster, proxy: p.proxy,
          region: b.region, expires: b.expires ? new Date(b.expires).toISOString() : null,
        });
      }
    }
    return { count: out.length, beams: out };
  },

  /**
   * Tunnels: what is open, and what has been kept.
   *
   * A caller setting up someone's work needs to know which ports are already
   * listening before it opens more, and the favourites are the list of
   * "tunnels this person actually uses".
   */
  async list_forwards() {
    const open = manager.allForwards().map((f) => ({
      connection: f.connLabel || f.connId,
      kind: f.kind,
      listen: `${f.bindAddr || 'localhost'}:${f.bindPort}`,
      destination: f.kind === 'D' ? null : `${f.destHost}:${f.destPort}`,
    }));
    return {
      open,
      favorites: store.listForwardFavorites().map((f) => ({
        id: f.id,
        name: f.name || '',
        kind: f.kind,
        listen: `${f.bindAddr || 'localhost'}:${f.bindPort}`,
        destination: f.kind === 'D' ? null : `${f.destHost}:${f.destPort}`,
        host: f.host?.name || '',
        login: f.login || null,
        lastUsed: f.lastUsedAt ? new Date(f.lastUsedAt).toISOString() : null,
      })),
    };
  },

  /**
   * Open a tunnel that was already saved — by name or by id, never by
   * arbitrary ports.
   *
   * The same shape as run_macro: the caller can only ask for something the
   * user defined, which is what keeps this from being "open any port to
   * anywhere on my machine".
   */
  async open_forward({ name, id } = {}) {
    const want = String(name || id || '').trim().toLowerCase();
    if (!want) throw new Error('Name a favourite. list_forwards has them.');
    const favs = store.listForwardFavorites();
    const fav = favs.find((f) => f.id === (id || '')) 
      || favs.find((f) => (f.name || '').toLowerCase() === want)
      || favs.find((f) => (f.name || '').toLowerCase().includes(want));
    if (!fav) {
      throw new Error(`No saved tunnel called "${name || id}". Known: `
        + (favs.map((f) => f.name || f.id).join(', ') || 'none'));
    }
    const host = fav.host || {};
    const { conn } = await targetConnection({
      host: host.type === 'teleport' ? host.name : (host.alias || host.name),
      cluster: host.cluster || undefined,
      login: fav.login || undefined,
    });
    const rec = await conn.addForward({
      kind: fav.kind,
      bindPort: fav.bindPort,
      bindAddr: fav.bindAddr || '',
      destHost: fav.destHost || '',
      destPort: fav.destPort || undefined,
    });
    store.markForwardFavoriteUsed(fav.id);
    return {
      opened: true,
      name: fav.name || fav.id,
      kind: rec.kind,
      listen: `${rec.bindAddr || 'localhost'}:${rec.bindPort}`,
      destination: rec.kind === 'D' ? null : `${rec.destHost}:${rec.destPort}`,
      host: host.name || '',
    };
  },

  /** The saved HTTP requests, by name. */
  async list_requests() {
    return {
      requests: store.listNetRequests().map((r) => ({
        id: r.id,
        name: r.name,
        method: r.opts?.method || 'GET',
        url: r.target,
        lastRun: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
      })),
    };
  },

  /**
   * Run one of them. Again the same principle: a request the user wrote and
   * can read, not a URL of the caller's choosing.
   */
  async run_request({ name, id, limit = 4000 } = {}) {
    const want = String(name || id || '').trim().toLowerCase();
    if (!want) throw new Error('Name a saved request. list_requests has them.');
    const all = store.listNetRequests();
    const req = all.find((r) => r.id === (id || ''))
      || all.find((r) => r.name.toLowerCase() === want)
      || all.find((r) => r.name.toLowerCase().includes(want));
    if (!req) {
      throw new Error(`No saved request called "${name || id}". Known: `
        + (all.map((r) => r.name).join(', ') || 'none'));
    }
    const r = await nettools.curlRequest({ ...req.opts, url: req.target });
    store.saveNetRequest({ ...req, lastRunAt: Date.now() });
    const body = String(r.body || '');
    return {
      name: req.name,
      method: r.method,
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      ms: r.ms,
      bytes: r.bytes,
      contentType: r.contentType,
      body: body.slice(0, Math.max(200, Math.min(200000, limit))),
      truncated: body.length > limit,
    };
  },

  /**
   * What a synchronise would do, without doing it.
   *
   * The preview is the point: an agent that is about to copy or delete files
   * on a server should be able to show its work first, and a caller that goes
   * straight to `sync_apply` has chosen to skip that.
   */
  async sync_preview(params = {}) {
    const { conn, target } = await targetConnection(params);
    const sftp = await conn.getSftp();
    const planned = await syncdirs.plan(sftp, {
      localDir: params.local,
      remoteDir: params.remote,
      direction: params.direction || 'up',
      del: !!params.delete,
      compare: params.compare || 'both',
    });
    return { target, ...describePlan(planned) };
  },

  /**
   * Run a synchronise.
   *
   * Deletions are opt-in with `delete`, exactly as they are in the dialog: a
   * caller that does not ask for them gets a copy-only sync, which is the
   * safe reading of an ambiguous instruction.
   */
  async sync_apply(params = {}) {
    const { conn, target } = await targetConnection(params);
    const sftp = await conn.getSftp();
    const planned = await syncdirs.plan(sftp, {
      localDir: params.local,
      remoteDir: params.remote,
      direction: params.direction || 'up',
      del: !!params.delete,
      compare: params.compare || 'both',
    });
    const doing = planned.actions.filter((a) => SYNC_DOING.includes(a.op));
    if (!doing.length) return { target, applied: false, reason: 'already in sync', ...describePlan(planned) };

    const r = await applySyncPlan(conn, planned, doing);
    /*
     * "Permission denied" on a server is nearly always the wrong account
     * rather than the wrong path, and the message never says which account it
     * was. Transfers report through the queue, so this only annotates what it
     * can see here.
     */
    const denied = (r.failures || []).some((f) => /permission denied/i.test(f));
    return {
      target,
      applied: true,
      ...r,
      ...(denied && target.login
        ? { hint: `Connected as "${target.login}" — a permission failure usually means that `
            + 'account cannot write there. Pass a different login to sync as someone else.' }
        : {}),
      ...describePlan(planned),
    };
  },


  /* --- everything below happens in the window --- */

  list_sessions() { return askRenderer('list_sessions'); },
  // Asked of the window because the built-in macros live there: a caller that
  // lists macros and then runs one must be looking at the same set.
  list_macros() { return askRenderer('list_macros'); },
  // The same search as the box at the top of the window, read-only.
  search(params) { return askRenderer('search', params, { timeout: 30000 }); },
  open_session(params) { return askRenderer('open_session', params, { timeout: 120000 }); },
  // Dials the host to ask tmux what it has, so it gets a connect's worth of time.
  list_tmux(params) { return askRenderer('list_tmux', params, { timeout: 120000 }); },
  open_sessions(params) { return askRenderer('open_sessions', params, { timeout: 300000 }); },
  close_session(params) { return askRenderer('close_session', params); },
  // Read/change settings the same way the Settings dialog does — so a
  // preference like the terminal's cursor is not only a thing a person
  // clicks to, it is also a thing asked for.
  get_settings() { return askRenderer('get_settings'); },
  set_settings(params) { return askRenderer('set_settings', params); },
  load_layout(params) { return askRenderer('load_layout', params, { timeout: 300000 }); },
  save_layout(params) { return askRenderer('save_layout', params); },
  run_macro(params) { return askRenderer('run_macro', params, { timeout: 120000 }); },
  // Read-only: what a pane shows, so a macro's result can be read back.
  read_output(params) { return askRenderer('read_output', params); },
  /*
   * Typing into a session: the one verb that can run anything. The window
   * decides, by the person's setting — off, ask each time (the default), or
   * allowed — and the asking can take as long as the person does.
   */
  type_text(params) { return askRenderer('type_text', params, { timeout: 300000 }); },
  focus_window() { return askRenderer('focus_window'); },
};

/** The plan actions that change something, as opposed to reporting. */
const SYNC_DOING = ['upload', 'download', 'deleteRemote', 'deleteLocal', 'rmdirRemote', 'rmdirLocal'];

/**
 * A plan, summarised for a caller that cannot see the dialog.
 *
 * The action list is capped: a first sync of a large tree is thousands of
 * lines, and an agent needs the shape of the work and a sample of it, not
 * every path.
 */
function describePlan(planned, limit = 200) {
  const doing = planned.actions.filter((a) => SYNC_DOING.includes(a.op));
  return {
    localDir: planned.localDir,
    remoteDir: planned.remoteDir,
    direction: planned.direction,
    compare: planned.compare,
    summary: planned.summary,
    actionCount: doing.length,
    actions: doing.slice(0, limit).map((a) => ({ op: a.op, path: a.rel, bytes: a.size || 0, why: a.why })),
    truncated: doing.length > limit,
  };
}

/** Every ssh_config host, from the primary config and any extra files. */
function sshHostList() {
  return sshconfig.listSshHosts({ extra: store.settings.sshConfigFiles || [] });
}

/**
 * The login this host should connect as when the caller has not said.
 *
 * A username set deliberately for the host wins; failing that, whatever last
 * worked; failing that, the first login the cluster grants. The window and the
 * control socket both go through here, so an agent opening a session connects
 * as the same account a double-click would.
 */
function preferredLoginFor(host, { login, logins = [] } = {}) {
  if (login) return login;
  const s = store.settings;
  return (s.hostUsers || {})[hostPrefKey(host)]
    || (s.hostLogins || {})[host?.id]
    || logins[0]
    || undefined;
}

/**
 * Whether to forward the ssh agent to this host.
 *
 * Resolved here rather than in the renderer so that every way of opening a
 * connection — a double-click, a saved profile, multi-exec, the control socket
 * — obeys the same three levels: the host's own setting, then its cluster's,
 * then the global preference. `undefined` at a level means "no opinion", which
 * is why these are read with `in` rather than for truthiness.
 */
function agentForwardFor(host) {
  const s = store.settings;
  const hk = hostPrefKey(host);
  const perHost = s.agentForwardHosts || {};
  if (hk && hk in perHost) return !!perHost[hk];
  const ck = clusterPrefKey(host);
  const perCluster = s.agentForwardClusters || {};
  if (ck && ck in perCluster) return !!perCluster[ck];
  return !!s.agentForward;
}

/** Fill in the options a host has preferences for, without overriding a caller. */
/**
 * A host's saved SSH options: a default, applied whenever it is opened, and
 * named presets that apply only when picked. Stored per host like the other
 * host preferences.
 */
function sshOptionsRecord(host) {
  const rec = (store.settings.sshOptionsHosts || {})[hostPrefKey(host)] || {};
  return { default: rec.default || null, presets: Array.isArray(rec.presets) ? rec.presets : [] };
}

function withHostPrefs(host, opts = {}) {
  const out = { ...opts };
  if (out.agentForward === undefined) out.agentForward = agentForwardFor(host);
  /*
   * Options a caller passes — a preset, a one-off, or `null` for "plain" —
   * win; with none, the host's default applies. X11 is part of the options
   * but has always been its own argument, so an explicit one still rules.
   */
  if (out.sshOptions === undefined) out.sshOptions = sshOptionsRecord(host).default;
  /*
   * A saved profile's own ssh options go on top of whatever applies — the
   * host's default or a preset — rather than replacing it; for the same
   * option, the profile's line wins.
   */
  if (out.profileSshOptions) {
    const base = sshoptions.normalize(out.sshOptions || {}).options;
    const mine = String(out.profileSshOptions).split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const nameOf = (l) => l.split(/[\s=]/)[0].toLowerCase();
    const mineNames = new Set(mine.map(nameOf));
    base.extraOptions = [...base.extraOptions.filter((l) => !mineNames.has(nameOf(l))), ...mine];
    out.sshOptions = base;
  }
  delete out.profileSshOptions;
  if (out.sshOptions) {
    const n = sshoptions.normalize(out.sshOptions).options;
    out.sshOptions = n;
    if (out.x11 === undefined && n.x11 !== 'off') out.x11 = n.x11;
    // Reason, invites and automatic requests exist only as tsh flags.
    if (host?.type === 'teleport' && !out.transport && sshoptions.needsTsh(n)) out.transport = 'tsh';
  }
  if (!out.login) {
    const explicit = (store.settings.hostUsers || {})[hostPrefKey(host)];
    if (explicit) out.login = explicit;
  }
  return out;
}

/**
 * Resolve what a caller named into a connection, dialling one if needed.
 *
 * Callers outside the window think in names — a node, an ssh_config alias, a
 * beam — not in connection ids, and they should not have to open a session
 * (with a terminal and a tab) just to copy files. An already-open connection
 * to the same thing is reused rather than dialled twice.
 */
async function targetConnection({ host, beam, cluster, proxy, login } = {}) {
  if (!host && !beam) throw new Error('Name a host or a beam to sync with.');

  // Something already open that is the same thing.
  for (const c of manager.list()) {
    const conn = manager.get(c.id);
    if (!conn || !['connected', 'connecting', 'idle'].includes(conn.state)) continue;
    if (beam && conn.beam?.name === beam) return { conn, target: { beam, reused: true } };
    if (host && !beam) {
      const node = conn.spec?.node || conn.spec?.host;
      const name = node?.name || node?.alias || conn.spec?.target;
      // A named login has to match: the same host as two different accounts
      // is two different views of the filesystem.
      if (name === host && (!cluster || node?.cluster === cluster)
          && (!login || conn.spec?.login === login)) {
        return {
          conn,
          target: { host, cluster: node?.cluster, login: conn.spec?.login || null, reused: true },
        };
      }
    }
  }

  if (beam) {
    const tp = await teleport.status();
    for (const p of (tp.profiles || []).filter((x) => !x.expired)) {
      if (proxy && p.proxy !== proxy) continue;
      const r = await beams.list({ proxy: p.proxy, home: p.homeDir }).catch(() => ({ beams: [] }));
      const found = r.beams.find((b) => b.id === beam || b.uuid === beam);
      if (!found) continue;
      const conn = await manager.create({
        type: 'beam', name: found.id, proxy: p.proxy, home: p.home || null,
      });
      await conn.connect();
      return { conn, target: { beam: found.id, cluster: p.cluster, proxy: p.proxy } };
    }
    throw new Error(`No beam called "${beam}" on any logged-in cluster.`);
  }

  // A Teleport node, by hostname, in whichever cluster has it.
  const tp = await teleport.status();
  for (const p of (tp.profiles || []).filter((x) => !x.expired)) {
    if (cluster && p.cluster !== cluster) continue;
    const r = await teleport.listNodes({ proxy: p.proxy, cluster: p.cluster, home: p.homeDir })
      .catch(() => ({ nodes: [] }));
    const node = (r.nodes || []).find((n) => n.name === host || n.hostname === host);
    if (!node) continue;
    /*
     * The same login the window would use.
     *
     * `tsh config` writes the Teleport username as the ssh user, which is a
     * cluster principal and often not an account on the node — on a node whose
     * home directories belong to `ubuntu`, connecting as `steven` can read
     * nothing. The app remembers what worked per host and offers the cluster's
     * logins otherwise; a caller outside the window has to get the same
     * treatment or it silently connects as the wrong person.
     */
    const as = preferredLoginFor(node, { login, logins: p.logins || [] });
    const conn = await manager.create({ ...node, type: 'teleport' },
      { login: as, agentForward: agentForwardFor(node) });
    await conn.connect();
    return { conn, target: { host: node.name, cluster: node.cluster, proxy: node.proxy, login: as || null } };
  }

  // An ssh_config alias.
  const ssh = await sshHostList().catch(() => []);
  const alias = ssh.find((h) => h.alias === host);
  if (alias) {
    const as = preferredLoginFor(alias, { login });
    const conn = await manager.create(
      { type: 'ssh', alias: alias.alias, name: alias.alias, configFile: alias.configFile || null, id: alias.id },
      { login: as, agentForward: agentForwardFor(alias) });
    await conn.connect();
    return { conn, target: { host: alias.alias, login: as || null } };
  }

  throw new Error(`No host or beam called "${host}". Use list_hosts or list_beams for the names.`);
}

/**
 * Apply a plan's actions: transfers through the queue, deletions here.
 *
 * Shared by the dialog and the control socket so both behave identically —
 * including the one protection that cannot be left to the caller: a folder
 * removal is recursive on the other side (a Teleport node's SFTP service
 * implements RMDIR as a recursive delete), so a list that keeps a file but
 * removes the folder above it would lose the file anyway. Such a folder is
 * dropped from the work.
 */
async function applySyncPlan(conn, planned, actions) {
  const keptInside = new Set(
    (planned?.actions || [])
      .filter((a) => a.op?.startsWith('delete')
        && !actions.some((k) => k.rel === a.rel && k.op === a.op))
      .map((a) => a.rel),
  );
  const list = keptInside.size
    ? actions.filter((a) => !(a.op?.startsWith('rmdir')
        && [...keptInside].some((rel) => rel === a.rel || rel.startsWith(a.rel + '/'))))
    : actions;

  const { uploads, downloads, upDirs, downDirs } = syncdirs.items(planned, list);
  const jobs = [];
  if (uploads.length) {
    jobs.push(conn.queue.add({
      kind: 'upload',
      label: `sync ↑ ${uploads.length} file(s) → ${planned.remoteDir}`,
      items: uploads, dirs: upDirs, roots: [planned.localDir],
    }));
  }
  if (downloads.length) {
    jobs.push(conn.queue.add({
      kind: 'download',
      label: `sync ↓ ${downloads.length} file(s) → ${planned.localDir}`,
      items: downloads, dirs: downDirs, roots: [planned.remoteDir],
    }));
  }

  const sftp = await conn.getSftp();
  let removed = 0;
  const failures = [];
  for (const a of list) {
    try {
      if (a.op === 'deleteRemote') {
        await sftp.remove(syncdirs.posixJoin(planned.remoteDir, a.rel));
        removed++;
      } else if (a.op === 'deleteLocal') {
        await fsp.rm(path.join(planned.localDir, a.rel), { force: true });
        removed++;
      } else if (a.op === 'rmdirRemote') {
        /*
         * Emptiness is checked here, not left to the server.
         *
         * A Teleport node's SFTP service implements RMDIR as a recursive
         * delete, so handing it a folder that still contains something
         * destroys that something — a file the walk never saw, one added
         * since the plan was made, or one this sync deliberately ignores
         * (`.DS_Store`). Nothing may be deleted that the plan did not list,
         * so the folder is looked at first and kept if anything is in it.
         */
        const dir = syncdirs.posixJoin(planned.remoteDir, a.rel);
        const left = await sftp.list(dir).catch(() => []);
        if (left.length) {
          failures.push(`${a.rel}: kept — still has ${left.length} item(s) in it`);
        } else {
          await sftp.rmdir(dir);
          removed++;
        }
      } else if (a.op === 'rmdirLocal') {
        // The same rule locally, where rmdir does refuse a non-empty
        // directory — checked anyway, so both sides read the same way.
        const dir = path.join(planned.localDir, a.rel);
        const left = await fsp.readdir(dir).catch(() => []);
        if (left.length) {
          failures.push(`${a.rel}: kept — still has ${left.length} item(s) in it`);
        } else {
          await fsp.rmdir(dir);
          removed++;
        }
      }
    } catch (e) {
      const why = /not empty|ENOTEMPTY|failure/i.test(e.message) && a.dir
        ? 'still has something in it'
        : e.message;
      failures.push(`${a.rel}: ${why}`);
    }
  }
  return { jobs, uploads: uploads.length, downloads: downloads.length, removed, failures };
}

/**
 * Where the MCP bridge script is on disk.
 *
 * It has to be a real file: an outside `node` cannot read anything inside
 * `app.asar`, which is a format only Electron understands. The build unpacks
 * `mcp/`, so the path is the same with `.unpacked` appended.
 */
function mcpBridgePath() {
  const base = app.getAppPath();
  const dir = base.includes('app.asar') && !base.includes('app.asar.unpacked')
    ? base.replace('app.asar', 'app.asar.unpacked')
    : base;
  return path.join(dir, 'mcp', 'serverlife-mcp.mjs');
}

async function handleControl(verb, params, ctx) {
  const fn = CONTROL_VERBS[verb];
  if (!fn) {
    throw new Error(`Unknown verb "${verb}". Known: ${Object.keys(CONTROL_VERBS).sort().join(', ')}`);
  }
  // Every accepted call is visible: automation that opens sessions should not
  // be the one thing that happens quietly.
  const line = `${ctx.client || 'automation'} → ${verb}${params && Object.keys(params).length ? ' ' + JSON.stringify(params).slice(0, 200) : ''}`;
  send('control:activity', { at: Date.now(), text: line });
  return fn(params || {}, ctx);
}

/** Flatten a connection into the shape the history log stores. */
function historyEntryFor(c) {
  const node = c.spec?.node;
  return {
    type: c.type,
    label: c.label,
    target: c.target,
    cluster: node?.cluster || null,
    proxy: node?.proxy || null,
    node: node?.name || c.spec?.host?.alias || null,
    // Which tsh home the session went through, so reopening it from the recent
    // list goes back to the same identity.
    home: node?.home || null,
    login: c.spec?.login || null,
    user: c.remoteUser,
    hostname: c.remoteHostname,
    /*
     * A host dialled by details rather than by an ssh_config alias — a quick
     * connect, or a server saved in the app. Without these the recent entry
     * keeps only `user@host`, so reopening it would quietly drop the port, the
     * identity file and the jump host and dial something else.
     */
    direct: c.spec?.direct || null,
  };
}

/*
 * `local` is this machine, for tmux — see localhost.js. It is not in the
 * manager because it is not a connection: nothing to dial, nothing to drop.
 */
let localHostConn = null;

/* The VNet processes this app has started — see vnet.js. */
const vnet = new VnetManager({ findTsh: () => teleport.findTsh(), tshEnv: (home, proxy) => teleport.tshEnv(home, proxy) });

/** Settings' tsh variables into the module every tsh is started from. */
function applyTshEnv(s) {
  teleport.setEnvSettings({ global: s.tshEnvText || '', clusters: s.clusterTshEnv || {}, homesEnv: s.tshHomeEnv || {}, inShells: !!s.tshEnvInShells });
}

function requireConn(id) {
  if (id === localhost.LOCAL_ID) return (localHostConn ||= new localhost.LocalHost());
  const c = manager.get(id);
  if (!c) throw new Error('No such connection: ' + id);
  return c;
}

function registerIpc() {
  /* --- app / settings --- */
  handle('app:info', async () => ({
    name: 'ServerLife',
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    home: os.homedir(),
    tsh: teleport.findTsh(),
    tshHome: teleport.DEFAULT_HOME,
    tshFound: teleport.tshStatus().found,
    // No OpenSSH client is a normal state on Windows; Teleport nodes then go
    // over `tsh ssh` instead, and plain SSH hosts cannot be reached at all.
    ssh: sshbin.sshStatus(),
    tshVersion: await teleport.version(),
    // A tsh someone picked, rather than one found by searching — and where
    // the pick was made — for the reminder at launch.
    tshChosen: teleport.chosenTsh(),
    tshChosenFrom: store.settings.tshPath ? 'settings' : (process.env.TSH_PATH ? 'TSH_PATH' : null),
    // Multiplexing is what lets one authentication serve every channel.
    multiplexing: process.platform !== 'win32',
    userData: app.getPath('userData'),
    isDev,
  }));

  handle('settings:get', async () => store.settings);
  /* --- control socket (automation / MCP) --- */
  handle('control:status', async () => {
    const bridge = mcpBridgePath();
    return {
      ...control.info(),
      enabled: !!store.settings.controlSocket,
      // What to paste into Claude Code. The bridge reads the token from the
      // file itself, so the command carries no secret.
      mcpCommand: `claude mcp add serverlife -- node ${bridge}`,
      bridge,
      verbs: Object.keys(CONTROL_VERBS).sort(),
    };
  });
  handle('control:setEnabled', async (on) => {
    store.updateSettings({ controlSocket: !!on });
    if (on) await control.start();
    else await control.stop();
    return { ...control.info(), enabled: !!on };
  });
  handle('control:rotateToken', async () => {
    const token = control.rotateToken();
    // Anything already connected was authorised with the old token.
    if (control.running) { await control.stop(); await control.start(); }
    return { token };
  });

  handle('settings:set', async (patch) => {
    const next = store.updateSettings(patch);
    // The list of tsh homes is the environment every tsh command runs in, so
    // it is applied the moment it changes rather than at the next launch.
    if (patch && 'tshHomes' in patch) teleport.setHomes(next.tshHomes);
    if (patch && 'tshPath' in patch) teleport.setTshPath(next.tshPath);
    if (patch && ('tshEnvText' in patch || 'clusterTshEnv' in patch || 'tshHomeEnv' in patch || 'tshEnvInShells' in patch || 'tshHomes' in patch)) applyTshEnv(next);
    if (patch && 'sshPath' in patch) sshbin.setSshPath(next.sshPath);
    return next;
  });

  /**
   * What a tsh home actually holds, for the preferences list: whether the
   * directory is there and which profiles it yields.
   */
  /**
   * Whether the two command-line tools everything runs through are actually
   * here. Read on every inventory refresh, so correcting a path takes effect
   * without a restart.
   */
  handle('tools:status', async () => ({
    tsh: teleport.tshStatus(),
    ssh: sshbin.sshStatus(),
  }));

  handle('teleport:homes', async () => {
    const dirs = teleport.activeHomes();
    const st = await teleport.status();
    return {
      configured: store.settings.tshHomes || [],
      defaultHome: teleport.DEFAULT_HOME,
      // Whether tsh itself was found matters more than any of the below: with
      // no tsh, every home reads as empty for a reason that has nothing to do
      // with the home.
      tsh: teleport.tshStatus(),
      ssh: sshbin.sshStatus(),
      homes: dirs.map((dir) => ({
        path: dir,
        name: teleport.homeName(dir),
        default: teleport.isDefaultHome(dir),
        exists: fs.existsSync(dir),
        profiles: st.profiles.filter((p) => p.homeDir === dir).map((p) => ({
          cluster: p.cluster, proxy: p.proxy, username: p.username, expired: !!p.expired,
        })),
        error: (st.homeErrors || []).find((e) => e.home === dir)?.error || null,
      })),
    };
  });

  /* --- saved profiles --- */
  handle('profiles:list', async () => ({ profiles: store.listProfiles(), folders: store.listFolders() }));
  handle('profiles:save', async (p) => store.upsertProfile(p));
  handle('profiles:delete', async (id) => { store.deleteProfile(id); return true; });
  handle('profiles:markUsed', async (id) => { store.markUsed(id); return true; });
  handle('snippets:list', async () => store.listSnippets());
  handle('snippets:save', async (sn) => store.upsertSnippet(sn));
  handle('snippets:delete', async (id) => { store.deleteSnippet(id); return true; });
  handle('snippets:used', async (id) => { store.markSnippetUsed(id); return true; });

  /* --- macros --- */
  handle('macros:list', async () => store.listMacros());
  handle('macros:save', async (m) => store.upsertMacro(m));
  handle('macros:delete', async (id) => { store.deleteMacro(id); return true; });
  handle('macros:hide', async (id, hidden) => store.setMacroHidden(id, hidden));
  handle('macros:used', async (id) => { store.markMacroUsed(id); return true; });
  handle('macros:order', async (order) => store.setMacroCategoryOrder(order));
  handle('macros:arrange', async (ids) => store.setMacroOrder(ids));
  // Pinning is a view decision, not a change to the macro: a built-in can be
  // pinned too, and nothing in code can be written to.
  handle('macros:pin', async (id, opts) => store.setMacroPin(id, opts || {}));

  /* --- S3 buckets --- */

  /**
   * A stored secret key is encrypted with the OS keychain, so sessions.json
   * never holds one in the clear. Where the keychain is unavailable the key is
   * refused rather than written plainly — environment credentials still work.
   */
  const sealSecret = (plain) => {
    if (!plain) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('This system has no secure keychain available, so an access key cannot be stored. Use environment credentials instead.');
    }
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  };
  const openSecret = (stored) => {
    if (!stored) return null;
    if (!String(stored).startsWith('enc:')) return stored;
    return safeStorage.decryptString(Buffer.from(String(stored).slice(4), 'base64'));
  };

  /**
   * The target as s3.js needs it: secrets decrypted, and for Teleport targets a
   * running local proxy with the tunnel to reach it.
   */
  const usableTarget = async (idOrTarget) => {
    const t = typeof idOrTarget === 'string' ? store.getS3Target(idOrTarget) : idOrTarget;
    if (!t) throw new Error('No such S3 bucket.');
    const mode = t.credentials?.mode || 'env';

    if (mode === 'teleport') {
      const env = await awsproxy.ensure(t.credentials.app, { proxy: t.credentials.proxy });
      return {
        ...t,
        credentials: { mode: 'teleport', accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
        agent: awsproxy.tunnelAgent(env),
      };
    }
    if (mode === 'profile') {
      const profile = t.credentials.profile || 'default';
      const creds = await awscreds.resolveProfile(profile);
      return {
        ...t,
        region: t.region || await awscreds.profileRegion(profile),
        credentials: { mode: 'profile', ...creds },
      };
    }
    if (mode !== 'explicit') return t;
    return {
      ...t,
      credentials: {
        ...t.credentials,
        accessKeyId: t.credentials.accessKeyId || '',
        secretAccessKey: openSecret(t.credentials.secretAccessKey),
        sessionToken: openSecret(t.credentials.sessionToken),
      },
    };
  };

  handle('s3:list', async () => store.listS3Targets().map((t) => ({
    ...t,
    // The renderer never needs the ciphertext, only whether one is set.
    credentials: {
      mode: t.credentials?.mode || 'env',
      envPrefix: t.credentials?.envPrefix || '',
      accessKeyId: t.credentials?.accessKeyId || '',
      hasSecret: !!t.credentials?.secretAccessKey,
    },
  })));
  handle('s3:save', async (t) => {
    const next = { ...t, credentials: { ...(t.credentials || { mode: 'env' }) } };
    if (next.credentials.mode === 'explicit') {
      const existing = t.id ? store.getS3Target(t.id) : null;
      next.credentials.secretAccessKey = next.credentials.secretAccessKey
        ? sealSecret(next.credentials.secretAccessKey)
        : (existing?.credentials?.secretAccessKey || null);
      next.credentials.sessionToken = next.credentials.sessionToken
        ? sealSecret(next.credentials.sessionToken)
        : (existing?.credentials?.sessionToken || null);
    }
    return store.upsertS3Target(next);
  });
  handle('s3:delete', async (id) => { store.deleteS3Target(id); return true; });
  handle('s3:storageClasses', async () => s3.STORAGE_CLASSES);

  /* --- rsync, for the file browser's right-click sync --- */
  handle('rsync:check', async () => rsync.check());
  handle('rsync:transport', async (connId) => {
    const c = manager.get(connId);
    if (!c) return { ok: false, reason: 'That connection is not open any more.' };
    return c.rsyncTransport();
  });
  handle('rsync:run', async (id, args) => rsync.run(id, {
    args,
    onOut: (m) => send('rsync:out', m),
    onDone: (m) => send('rsync:done', { ...m, message: rsync.explain(m.code) }),
  }));
  handle('rsync:cancel', async (id) => rsync.cancel(id));
  handle('s3:test', async (idOrTarget) => s3.test({ target: await usableTarget(idOrTarget) }));
  handle('s3:browse', async (id, prefix) => s3.list({ target: await usableTarget(id), prefix }));
  handle('s3:head', async (id, key) => s3.head({ target: await usableTarget(id), key }));
  handle('s3:prefixInfo', async (id, prefix) => s3.prefixInfo({ target: await usableTarget(id), prefix }));
  handle('s3:remove', async (id, keys) => s3.remove({ target: await usableTarget(id), keys }));
  handle('s3:copy', async (id, fromKey, toKey, storageClass) =>
    s3.copy({ target: await usableTarget(id), fromKey, toKey, storageClass }));
  handle('s3:buckets', async (t) => s3.listBuckets({ target: await usableTarget(t) }));
  handle('s3:bucketRegion', async (t) => s3.bucketRegion({ target: await usableTarget(t) }));

  /* --- AWS credentials already on this desktop --- */
  handle('aws:profiles', async () => awscreds.listProfiles());
  handle('aws:profileCheck', async (profile) => {
    const c = await awscreds.resolveProfile(profile, { refresh: true });
    return {
      ok: true,
      profile: profile || 'default',
      source: c.source,
      accessKeyId: c.accessKeyId.slice(0, 6) + '…',
      temporary: !!c.sessionToken,
      expiration: c.expiration || null,
      region: await awscreds.profileRegion(profile),
    };
  });
  handle('aws:forgetProfile', async (profile) => { awscreds.forget(profile); return true; });

  /* --- AWS credentials via Teleport --- */
  handle('aws:apps', async (opts) => awsproxy.listAwsApps(opts || {}));
  handle('aws:roles', async (app, opts) => awsproxy.listAwsRoles(app, opts || {}));
  handle('aws:login', async (app, role, opts) => awsproxy.login(app, role, opts || {}));
  handle('aws:logout', async (app, opts) => awsproxy.logout(app, opts || {}));
  handle('aws:proxies', async () => awsproxy.status());
  // VNet: one `tsh vnet`, for one cluster at a time, from a cluster's menu.
  handle('vnet:start', async (opts) => vnet.start({
    home: opts?.home || teleport.homeForProxy(opts?.proxy) || null, proxy: opts?.proxy || null,
  }));
  handle('vnet:stop', async (proxy) => vnet.stop(proxy || null));
  handle('vnet:status', async () => vnet.status());

  /*
   * AI assistants, opened beside a session — see aiclients.js. Which are
   * installed is asked of the login shell, which sees the PATH the person's
   * own terminal does; an app started from the Dock does not.
   */
  /*
   * The person's PATH, as their own terminal has it — asked of their login,
   * interactive shell once, in the background, and kept. Opened from the
   * Dock the app has only launchd's PATH, and Homebrew, nvm and friends are
   * often set up in ~/.zshrc, which only an interactive shell reads. But
   * ~/.zshrc can take seconds, and nothing on screen should wait for it:
   * until the answer arrives the usual install directories stand in, and
   * after it everything — finding tools, running their checks — uses the
   * kept PATH with a plain shell that reads no startup files at all.
   */
  let userPath = null;
  let userPathAsk = null;
  const askUserPath = () => {
    if (userPathAsk || process.platform === 'win32') return userPathAsk;
    /*
     * Input closed: an rc file that asks something — oh-my-zsh's "update
     * now? [Y/n]" every couple of weeks — reads end-of-file and carries on,
     * rather than waiting on a question nobody can see.
     */
    userPathAsk = new Promise((resolve) => {
      let out = '';
      const child = spawn(process.env.SHELL || '/bin/zsh', ['-l', '-i', '-c', 'printf "__SLPATH__%s__SLEND__" "$PATH"'],
        { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
      const done = () => {
        const m = out.match(/__SLPATH__([\s\S]*?)__SLEND__/);
        if (m && m[1]) userPath = aiclients.withToolPath({ PATH: m[1] }).PATH;
        resolve(userPath);
      };
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(); }, 30000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => { clearTimeout(timer); done(); });
      child.on('error', () => { clearTimeout(timer); done(); });
    });
    return userPathAsk;
  };
  const toolPath = () => userPath || aiclients.withToolPath(process.env).PATH;
  askUserPath();
  // A plain shell with the person's PATH: no ~/.zshrc, so no waiting on it.
  const shellOut = (script, timeout = 20000) => new Promise((resolve) => {
    if (process.platform === 'win32') return resolve('');
    execFile('/bin/sh', ['-c', script], { timeout, env: { ...process.env, PATH: toolPath() } },
      (err, stdout) => resolve(String(stdout || '')));
  });
  const aiSpec = () => aiclients.serverSpec({
    runtime: process.execPath, bridge: mcpBridgePath(), userData: app.getPath('userData'),
  });
  /*
   * The launcher assistants go through, from Settings: { on, template,
   * clients }. Off, or with no template, they run directly.
   */
  const aiLauncher = () => {
    const l = store.settings.aiLauncher || {};
    return l.on && l.template ? { template: l.template, clients: l.clients || [] } : null;
  };
  /*
   * The launcher for one assistant. Each can say for itself: 'direct' (never
   * a launcher), 'custom:<template>' (its own), or 'default' / unset — the
   * global launcher, if it is on and covers this assistant. Returned with
   * an empty client list, since it has already been decided for this one.
   */
  const aiLauncherFor = (id) => {
    const mode = (store.settings.aiClientLaunch || {})[id] || 'default';
    if (mode === 'direct') return null;
    if (mode.startsWith('custom:')) {
      const template = mode.slice('custom:'.length).trim();
      return template ? { template, clients: [] } : null;
    }
    const g = aiLauncher();
    if (!g || (g.clients.length && !g.clients.includes(id))) return null;
    return { template: g.template, clients: [] };
  };
  // The person's own tools, from settings, alongside the built-in ones.
  const aiAll = () => { aiclients.setCustom(store.settings.aiCustomClients); return aiclients.allClients(store.settings.aiCustomClients); };
  /*
   * What is installed, looked up on disk along the person's PATH — no shell,
   * so it answers at once. `fresh` waits for the kept PATH if it is still
   * being asked for; otherwise whatever is known now is the answer.
   */
  handle('ai:clients', async ({ waitForPath = false } = {}) => {
    if (waitForPath) await askUserPath();
    const list = aiAll();
    const p = toolPath();
    const found = {};
    for (const b of new Set(list.map((c) => c.bin).filter(Boolean))) {
      const hit = aiclients.findOnPath(b, p);
      if (hit) found[b] = hit;
    }
    return {
      pathSettled: !!userPath,
      clients: list.map((c) => ({ ...c, path: found[c.bin] || null, available: !!found[c.bin] })),
      automation: !!store.settings.controlSocket,
    };
  });
  /*
   * Arguments a known launcher needs for this client (see recipes in
   * aiclients.js). prism's port is read from its state, after `prism up` —
   * idempotent, and quick when it is already up — so the port is real.
   */
  const recipeArgsFor = async (id, launcher) => {
    const r = launcher ? aiclients.recipeFor(id, launcher.template) : null;
    if (!r) return { args: [], why: null };
    if (r.needs === 'prismPort') {
      let port = aiclients.prismPort();
      if (!port) { await shellOut('prism up >/dev/null 2>&1', 90000); port = aiclients.prismPort(); }
      if (!port) return { args: [], why: r.why, missing: 'The launcher\u2019s gateway is not running, and could not be started' };
      return { args: r.args(port), why: r.why };
    }
    return { args: [], why: r.why };
  };

  handle('ai:launch', async (id, { withMcp = true, resume = '', name = '' } = {}) => {
    aiAll();
    const recipe = await recipeArgsFor(id, aiLauncherFor(id));
    const l = aiclients.launch(id, {
      recipeArgs: recipe.args,
      spec: withMcp ? aiSpec() : null, launcher: aiLauncherFor(id),
      model: (store.settings.aiClientModel || {})[id] || '',
      extraArgs: (store.settings.aiClientArgs || {})[id] || '',
      tmpDir: path.join(app.getPath('userData'), 'ai-sessions'),
      resume, name,
    });
    aiclients.writeFiles(l.files);
    return { command: l.command, args: l.args, env: l.env, title: l.title, launched: l.launched, cwd: aiWorkdir() };
  });

  /*
   * The folder assistants start in. Not the home folder: Claude Code does not
   * remember trusting a home folder, so it asked "do you trust this folder?"
   * on every start. A folder of their own is trusted once and remembered —
   * and it gets an AGENTS.md (read by Claude Code, Codex and the rest) that
   * says where they are running and which tools ServerLife gives them. One
   * the person wrote is never touched.
   */
  function aiWorkdir() {
    const dir = (store.settings.aiWorkdir || '').trim().replace(/^~(?=$|\/)/, os.homedir())
      || path.join(os.homedir(), 'ServerLife AI');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const guide = path.join(dir, 'AGENTS.md');
      if (!fs.existsSync(guide)) {
        fs.writeFileSync(guide, [
          '# Running inside ServerLife',
          '',
          'You were started from ServerLife, a terminal and server manager for Teleport and SSH.',
          'Its MCP tools are named `serverlife_*`: list hosts and clusters, open sessions, run the',
          'user\'s saved macros, read what a terminal shows (`serverlife_read_output`) and, with the',
          'user\'s approval each time, type into a session (`serverlife_type_into_session`).',
          '',
          'Prefer those tools for anything on the user\'s servers rather than guessing hostnames.',
          'This folder is your working folder; it holds nothing else.',
          '',
        ].join('\n'));
      }
    } catch { /* fall back to the home folder in the terminal */ }
    return dir;
  }

  /*
   * Saved responses: what an assistant said that is worth keeping, one
   * Markdown file each in "saved" in the assistants' folder — where Finder
   * shows them and where an assistant can be asked to read them again.
   */
  const savedDir = () => path.join(aiWorkdir(), 'saved');
  const savedPath = (file) => {
    const p = path.join(savedDir(), path.basename(String(file || '')));
    if (!p.endsWith('.md')) throw new Error('Not a saved response');
    return p;
  };
  handle('ai:saveResponse', async ({ title = '', text = '', source = '' } = {}) => {
    const body = String(text || '').replace(/[ \t]+$/gm, '').trim();
    if (!body) throw new Error('Nothing to save');
    const name = String(title || '').trim() || body.split('\n')[0].slice(0, 60);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'response';
    await fsp.mkdir(savedDir(), { recursive: true });
    let file = path.join(savedDir(), `${stamp}-${slug}.md`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(savedDir(), `${stamp}-${slug}-${i}.md`);
    const head = [`# ${name}`, '', `Saved ${now.toLocaleString()}${source ? ` from ${source}` : ''}.`, '', ''].join('\n');
    await fsp.writeFile(file, head + body + '\n', 'utf8');
    return { file: path.basename(file), path: file };
  });
  handle('ai:savedList', async () => {
    let names = [];
    try { names = (await fsp.readdir(savedDir())).filter((f) => f.endsWith('.md')); } catch { return []; }
    const out = [];
    for (const f of names) {
      const full = path.join(savedDir(), f);
      try {
        const [st, text] = await Promise.all([fsp.stat(full), fsp.readFile(full, 'utf8')]);
        const title = (text.match(/^# (.+)$/m) || [])[1] || f;
        out.push({ file: f, path: full, title, size: st.size, mtime: st.mtimeMs });
      } catch { /* gone since the listing */ }
    }
    return out.sort((x, y) => y.mtime - x.mtime);
  });
  handle('ai:savedRead', async (file) => fsp.readFile(savedPath(file), 'utf8'));
  handle('ai:savedDelete', async (file) => { await fsp.unlink(savedPath(file)); return true; });
  handle('ai:savedReveal', async (file) => {
    if (file) shell.showItemInFolder(savedPath(file));
    else { await fsp.mkdir(savedDir(), { recursive: true }); await shell.openPath(savedDir()); }
    return true;
  });

  /*
   * Is this assistant ready to open? Each step says what it found and, where
   * something is missing, how to put it right — a command to run, a setting
   * to turn on. Asked of the same login shell the assistant will run in.
   */
  handle('ai:check', async (id) => {
    aiAll();
    const c = aiclients.byId(id);
    if (!c) throw new Error(`Unknown assistant: ${id}`);
    const steps = [];
    const add = (level, label, detail, fix = null) => steps.push({ level, label, detail, fix });
    const q = aiclients.shq;

    const ver = (await shellOut(`command -v ${q(c.bin)} >/dev/null 2>&1 && { ${q(c.bin)} --version 2>&1 | head -1; } || echo __missing__`, 8000)).trim();
    if (!ver || ver.includes('__missing__')) {
      add('error', `${c.name} is installed`, `\`${c.bin}\` is not on your PATH.`,
        c.install ? { kind: 'run', label: 'Install', command: c.install } : null);
      return { id, steps, ready: false };
    }
    add('ok', `${c.name} is installed`, ver);

    const launcher = aiLauncherFor(id);
    const launched = !!launcher;
    if (launched) {
      const first = launcher.template.split(/\s+/)[0];
      const where = (await shellOut(`command -v ${q(first)} 2>/dev/null`)).trim();
      if (!where) {
        add('error', `The launcher \`${first}\` is installed`, `Settings runs assistants through \`${launcher.template}\`, and \`${first}\` is not on your PATH.`,
          { kind: 'settings', label: 'Open Settings' });
      } else {
        add('ok', `Runs through \`${launcher.template}\``, where);
        // A launcher that names a Teleport cluster: is there a login for it?
        if (first === 'prism') {
          const cfg = await shellOut('prism config show 2>/dev/null');
          let proxy = null;
          try { proxy = JSON.parse(cfg).proxy || null; } catch { /* no config yet */ }
          if (!proxy) {
            add('error', 'The launcher knows which cluster to use', 'No Teleport cluster is set for the launcher yet.',
              { kind: 'run', label: 'Set the cluster', command: 'prism config set proxy <cluster>:443', edit: true });
          } else {
            const st = await shellOut(`tsh status --proxy=${q(proxy)} 2>&1`);
            const valid = /Valid until:[^\n]*valid for/i.test(st) && !/EXPIRED/.test(st.split('\n').find((l) => /Valid until/.test(l)) || '');
            add(valid ? 'ok' : 'error', `Logged in to ${proxy}`, valid ? 'Teleport login is valid' : 'The Teleport login has expired or is missing.',
              valid ? null : { kind: 'run', label: 'Log in', command: `tsh login --proxy=${proxy}` });
          }
        }
      }
    }

    // Signed in to the vendor — unless a launcher is doing the signing in.
    if (launched) {
      add('info', 'Signed in', 'Through the launcher, so no vendor sign-in is needed.');
    } else if (id === 'claude') {
      const out = await shellOut('claude auth status 2>/dev/null', 8000);
      let st = null;
      try { st = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* not JSON */ }
      add(st?.loggedIn ? 'ok' : 'error', 'Signed in', st?.loggedIn ? `${st.authMethod || 'signed in'}` : 'Not signed in.',
        st?.loggedIn ? null : { kind: 'run', label: 'Sign in', command: c.login });
    } else if (id === 'codex') {
      const out = (await shellOut('codex login status 2>&1', 8000)).trim();
      const ok = /logged in/i.test(out);
      add(ok ? 'ok' : 'error', 'Signed in', out || 'Not signed in.', ok ? null : { kind: 'run', label: 'Sign in', command: c.login });
    } else if (id === 'opencode') {
      const out = await shellOut('opencode auth list 2>&1', 8000);
      const n = Number((out.match(/(\d+)\s+credentials?/) || [])[1] || 0);
      add(n ? 'ok' : 'warn', 'Signed in to a provider', n ? `${n} saved credential${n === 1 ? '' : 's'}`
        : 'No saved credentials — OpenCode will offer only its free models.', n ? null : { kind: 'run', label: 'Sign in', command: c.login });
    } else if (id === 'gemini') {
      const ok = fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'))
        || !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
      add(ok ? 'ok' : 'warn', 'Signed in', ok ? 'Credentials found' : 'Not yet — Gemini asks you to sign in in the browser when it first opens.');
    } else if (c.custom) {
      add('info', 'Signed in', `${c.name} signs in its own way \u2014 ServerLife cannot check it.`);
    } else if (id === 'copilot') {
      add('info', 'Signed in', 'Copilot asks you to sign in with GitHub when it first opens, if needed (/login).');
    } else {
      add('info', 'Signed in', `${c.name} signs in per model provider: \`pi auth check --provider <name>\`.`);
    }

    // ServerLife's tools, over MCP.
    const bridge = mcpBridgePath();
    if (!store.settings.controlSocket) {
      // Said once, then — if the person would rather not have them — not again.
      add(store.settings.aiNoToolsOk ? 'info' : 'warn', 'ServerLife\u2019s tools are available',
        'Local automation is off, so the assistant opens without them.',
        store.settings.aiNoToolsOk ? null : { kind: 'automation', label: 'Turn on', alt: { kind: 'noToolsOk', label: 'Don\u2019t ask again' } });
    } else if (!fs.existsSync(bridge)) {
      add('error', 'ServerLife’s tools are available', `The MCP bridge is missing: ${bridge}`);
    } else if (c.mcp === 'none') {
      add('info', 'ServerLife\u2019s tools are available', `No MCP flag was given for ${c.name}, so it opens without them. Edit the tool to add one.`);
    } else if (c.mcp === 'persist') {
      const cfg = id === 'pi' ? path.join(os.homedir(), '.pi', 'agent', 'mcp.json') : path.join(os.homedir(), '.gemini', 'settings.json');
      const has = (() => { try { return /"serverlife"/.test(fs.readFileSync(cfg, 'utf8')); } catch { return false; } })();
      add(has ? 'ok' : 'warn', 'ServerLife’s tools are available', has ? `Registered in ${cfg}`
        : `${c.name} keeps MCP servers in ${cfg}; ServerLife is not there yet.`, has ? null : { kind: 'register', label: 'Add it' });
    } else {
      add('ok', 'ServerLife’s tools are available', 'Given to it for each session');
    }
    return { id, steps, ready: !steps.some((x) => x.level === 'error') };
  });
  /*
   * What will run, for the "How it runs" dialog: settings as they would be
   * saved (`draft`), shown as the command line — the MCP config shortened.
   */
  handle('ai:preview', async (id, draft = {}) => {
    aiAll();
    const c = aiclients.byId(id);
    if (!c) throw new Error(`Unknown assistant: ${id}`);
    const mode = draft.mode || 'default';
    let launcher = null;
    if (mode === 'custom' && draft.template) launcher = { template: draft.template, clients: [] };
    else if (mode === 'default') {
      const g = aiLauncher();
      if (g && (!g.clients.length || g.clients.includes(id))) launcher = { template: g.template, clients: [] };
    }
    const r = launcher ? aiclients.recipeFor(id, launcher.template) : null;
    const port = r?.needs === 'prismPort' ? (aiclients.prismPort() || '<gateway port>') : null;
    const l = aiclients.launch(id, {
      launcher, model: draft.model || '', extraArgs: draft.extraArgs || '',
      recipeArgs: r ? r.args(port) : [], platform: 'win32',
    });
    const words = [l.command, ...l.args].map((w) => (/^\{"mcpServers"/.test(w) ? "'{…serverlife MCP…}'" : aiclients.shq(w)));
    return { command: words.join(' '), recipe: r ? r.why : null, launched: l.launched };
  });

  handle('ai:registerCommand', async (id) => {
    const argv = aiclients.registerCommand(id, aiSpec());
    return argv ? argv.map(aiclients.shq).join(' ') : null;
  });
  handle('ai:register', async (id) => {
    const argv = aiclients.registerCommand(id, aiSpec());
    if (!argv) throw new Error('This assistant takes ServerLife for each session; nothing to register');
    const out = await shellOut(argv.map(aiclients.shq).join(' ') + ' 2>&1; echo "exit=$?"', 30000);
    const ok = /exit=0\s*$/.test(out);
    return { ok, output: out.replace(/exit=\d+\s*$/, '').trim() };
  });
  /*
   * Per-host SSH options. Checked here, where the flags are built, so what is
   * saved is what will run — the dialog shows the errors rather than storing
   * a forward ssh would refuse.
   */
  handle('sshopts:get', async (host) => {
    const rec = sshOptionsRecord(host);
    return {
      default: rec.default,
      defaultSummary: rec.default ? sshoptions.summary(rec.default) : [],
      presets: rec.presets.map((p) => ({ ...p, summary: sshoptions.summary(p.options) })),
    };
  });
  handle('sshopts:command', async (host, options, login) => sshoptions.commandLine({
    host, options, login: login || (store.settings.hostUsers || {})[hostPrefKey(host)] || null,
  }));
  handle('sshopts:check', async (options) => {
    const { options: o, errors, warnings } = sshoptions.normalize(options || {});
    return { options: o, errors, warnings, summary: sshoptions.summary(o), needsTsh: sshoptions.needsTsh(o) };
  });
  handle('sshopts:save', async (host, { asDefault, presetName, options, clearDefault, deletePreset } = {}) => {
    const key = hostPrefKey(host);
    if (!key) throw new Error('This host cannot have saved options');
    const all = { ...(store.settings.sshOptionsHosts || {}) };
    const rec = { default: null, presets: [], ...(all[key] || {}) };
    if (clearDefault) rec.default = null;
    if (deletePreset) rec.presets = rec.presets.filter((p) => p.name !== deletePreset);
    if (options) {
      const { options: o, errors } = sshoptions.normalize(options);
      if (errors.length) return { ok: false, errors };
      if (asDefault) rec.default = sshoptions.isEmpty(o) ? null : o;
      if (presetName) {
        const name = String(presetName).trim().slice(0, 60);
        rec.presets = [...rec.presets.filter((p) => p.name !== name), { name, options: o }];
      }
    }
    if (!rec.default && !rec.presets.length) delete all[key];
    else all[key] = rec;
    store.updateSettings({ sshOptionsHosts: all });
    return { ok: true };
  });

  /* --- S3 transfers, reported through the same queue as SFTP --- */
  handle('s3:upload', async (id, localPaths, prefix, opts) => {
    const target = await usableTarget(id);
    const storageClass = opts?.storageClass || target.defaultStorageClass || 'STANDARD';
    const done = [];
    for (const p of localPaths) {
      const key = s3.joinPrefix(prefix) + path.basename(p);
      done.push(await s3.upload({ target, localPath: p, key, storageClass }));
    }
    return { uploaded: done, storageClass };
  });
  /**
   * Scratch space for transfers that cannot go directly — a server and a
   * bucket have no way to reach each other, so the bytes come through here.
   */
  handle('s3:relayDir', async () => {
    const dir = path.join(os.tmpdir(), `serverlife-s3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  });
  handle('s3:cleanRelay', async (dir) => {
    // Only ever remove a directory this process made, whatever is passed in.
    if (!dir || !path.basename(dir).startsWith('serverlife-s3-') || path.dirname(dir) !== os.tmpdir()) {
      throw new Error('Refusing to remove a directory that is not a transfer scratch area.');
    }
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  });

  /**
   * Server → bucket, and back, done here in one call.
   *
   * The renderer cannot do this: its download is a *queued* transfer that
   * returns as soon as the job is registered, so an upload chained after it
   * would read files that have not arrived. Here the SFTP transfer is awaited
   * properly before S3 sees anything.
   */
  handle('s3:fromServer', async (connId, entries, s3Id, prefix, opts) => {
    const target = await usableTarget(s3Id);
    const storageClass = opts?.storageClass || target.defaultStorageClass || 'STANDARD';
    const sftp = await requireConn(connId).getSftp();
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'serverlife-s3-'));
    const done = [];
    try {
      for (const e of entries) {
        if (e.type === 'directory') continue;
        const local = path.join(tmp, path.posix.basename(e.path));
        await downloadFile(sftp, e.path, local);
        const key = s3.joinPrefix(prefix) + path.posix.basename(e.path);
        done.push(await s3.upload({ target, localPath: local, key, storageClass }));
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    return { uploaded: done, storageClass };
  });

  handle('s3:toServer', async (s3Id, keys, connId, destDir) => {
    const target = await usableTarget(s3Id);
    const sftp = await requireConn(connId).getSftp();
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'serverlife-s3-'));
    const done = [];
    try {
      for (const key of keys) {
        const base = path.posix.basename(key);
        const local = path.join(tmp, base);
        await s3.download({ target, key, destPath: local });
        await uploadFile(sftp, local, posixJoin(destDir, base));
        done.push({ key, path: posixJoin(destDir, base) });
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    return { sent: done };
  });

  /** Bucket → bucket, also relayed here rather than in the renderer. */
  handle('s3:bucketToBucket', async (fromId, keys, toId, prefix, opts) => {
    const from = await usableTarget(fromId);
    const to = await usableTarget(toId);
    const storageClass = opts?.storageClass || to.defaultStorageClass || 'STANDARD';
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'serverlife-s3-'));
    const done = [];
    try {
      for (const key of keys) {
        const base = path.posix.basename(key);
        const local = path.join(tmp, base);
        await s3.download({ target: from, key, destPath: local });
        done.push(await s3.upload({ target: to, localPath: local, key: s3.joinPrefix(prefix) + base, storageClass }));
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    return { uploaded: done, storageClass };
  });

  handle('s3:download', async (id, keys, destDir) => {
    const target = await usableTarget(id);
    const done = [];
    for (const key of keys) {
      const dest = path.join(destDir, path.posix.basename(key));
      const r = await s3.download({ target, key, destPath: dest });
      done.push(r);
      // An object pulled out of a bucket is as much a download as a file off a
      // server, and lands in the same list.
      store.addDownload({
        localPath: dest,
        name: path.basename(dest),
        source: `s3://${target.bucket}/${key}`,
        from: target.name || target.bucket || 'S3',
        kind: 'file',
        bytes: r.bytes || 0,
        files: 1,
      });
    }
    if (done.length) send('downloads:update', store.listDownloads());
    return { downloaded: done };
  });

  /* --- export / import --- */
  handle('backup:export', async (what, ids) => {
    const macrosOnly = what === 'macros';
    const doc = macrosOnly ? backup.exportMacros(store, ids) : backup.exportAll(store);
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(dialogParent(), {
      title: macrosOnly ? 'Export macros' : 'Export all settings',
      defaultPath: path.join(app.getPath('documents'),
        `serverlife-${macrosOnly ? 'macros' : 'settings'}-${stamp}.json`),
      filters: [{ name: 'ServerLife export', extensions: ['json'] }],
    });
    if (r.canceled) return null;
    await backup.writeFile(r.filePath, doc);
    return { path: r.filePath, counts: doc.counts || {} };
  });

  // Reading and applying are separate so the renderer can show what is in the
  // file and let the user choose merge or replace before anything changes.
  handle('backup:read', async () => {
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: 'Import ServerLife settings',
      properties: ['openFile'],
      filters: [{ name: 'ServerLife export', extensions: ['json'] }],
    });
    if (r.canceled) return null;
    const doc = await backup.readFile(r.filePaths[0]);
    return { path: r.filePaths[0], doc, summary: backup.describe(doc) };
  });

  handle('backup:apply', async (doc, opts) => backup.applyImport(store, doc, opts || {}));
  handle('folders:save', async (f) => store.upsertFolder(f));
  handle('folders:delete', async (id) => { store.deleteFolder(id); return true; });

  /* --- discovery --- */
  /**
   * One verbose, non-interactive ssh attempt, summarised — the evidence behind
   * "too many authentication failures". It cannot authenticate (BatchMode),
   * so it can only reproduce the refusal it is explaining.
   */
  handle('ssh:authProbe', async (target, opts) => authprobe.authProbe(target, opts || {}));

  handle('discovery:ssh', async () => sshHostList());
  handle('sshconfig:files', async () => sshconfig.listConfigFiles(store.settings.sshConfigFiles || []));
  /*
   * `tsh config` into ~/.ssh/config, in two steps: what it would write and
   * whether this cluster is already in there, then the write itself. Two steps
   * because the second one edits a file the user owns, and nothing should be
   * written that was not shown first.
   */
  handle('sshconfig:tshPreview', async ({ proxy, cluster, home } = {}) => {
    const text = await teleport.clusterSshConfigText({ proxy, home });
    const state = await sshconfig.tshConfigStatus({ cluster, proxy, text });
    return { text, ...state };
  });
  handle('sshconfig:tshWrite', async ({ proxy, cluster, text } = {}) =>
    sshconfig.appendTshConfig({ proxy, cluster, text }));
  /*
   * Picking a config file rather than typing a path: these live in dotted
   * directories, so the dialog has to show hidden files or the one place
   * people keep them is invisible.
   */
  handle('sshconfig:pickFile', async () => {
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: 'Choose an SSH config file',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('sshconfig:add', async (host) => sshconfig.addHostToConfig(
    host?.file ? { ...host, file: await knownConfigFile(host.file) } : host));
  handle('sshconfig:remove', async (alias) => sshconfig.removeHostFromConfig(alias));
  handle('sshconfig:managed', async () => sshconfig.managedAliases());
  /*
   * Only a file the host list was actually read from: these write to disk
   * (or hand a path to the system), so the renderer cannot name any file
   * it likes.
   */
  const knownConfigFile = async (file) => {
    const p = path.resolve(sshconfig.expandHome(String(file || '')));
    const roots = (await sshconfig.listConfigFiles(store.settings.sshConfigFiles || [])).map((f) => f.file || f.path || f);
    const sources = (await sshHostList().catch(() => [])).map((h) => h.source);
    if (![sshconfig.CONFIG_PATH, ...roots, ...sources].filter(Boolean).map((x) => path.resolve(String(x))).includes(p)) {
      throw new Error(`${file} is not one of the ssh config files ServerLife reads.`);
    }
    return p;
  };
  handle('sshconfig:blockPreview', async ({ file, alias } = {}) =>
    sshconfig.hostBlockPreview({ file: await knownConfigFile(file), alias }));
  handle('sshconfig:removeFromFile', async ({ file, alias, mode } = {}) =>
    sshconfig.removeHostFromFile({ file: await knownConfigFile(file), alias, mode: mode === 'comment' ? 'comment' : 'delete' }));
  // In the text editor, not whatever claims extension-less files: `config`
  // would otherwise open in a terminal, or nothing at all.
  handle('sshconfig:openInEditor', async (file) => {
    const p = await knownConfigFile(file || sshconfig.CONFIG_PATH);
    if (process.platform === 'darwin') {
      await new Promise((resolve, reject) => execFile('open', ['-t', p], (err) => (err ? reject(err) : resolve())));
    } else {
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
    }
    return p;
  });
  /*
   * Editing an ssh config inside the app. Only files the app already reads
   * (knownConfigFile), and never saved without ssh itself having parsed the
   * new text first: `ssh -G -F <copy>` reads every line the way a real
   * connection would, so a typo is caught here — with its line number —
   * instead of breaking every ssh on the machine. The file it replaces is
   * kept beside it as <file>.serverlife-backup, and its permissions are kept.
   */
  const checkSshConfigText = async (text, realPath) => {
    const tmp = path.join(os.tmpdir(), `serverlife-sshconfig-${process.pid}-${Date.now()}`);
    await fs.promises.writeFile(tmp, String(text || ''), { mode: 0o600 });
    try {
      return await new Promise((resolve) => {
        execFile(sshbin.findSsh(), ['-G', '-F', tmp, 'serverlife-config-check.invalid'], { timeout: 15000 }, (err, stdout, stderr) => {
          const said = String(stderr || '').split('\n').map((l) => l.replace(tmp, realPath || 'config').trim()).filter(Boolean);
          const problems = said.filter((l) => /line \d+|Bad configuration|bad|unsupported|Unsupported|error|missing|garbage/i.test(l));
          resolve(err ? { ok: false, errors: problems.length ? problems : said.slice(0, 5) } : { ok: true, warnings: problems });
        });
      });
    } finally { fs.promises.unlink(tmp).catch(() => {}); }
  };
  handle('sshconfig:read', async (file) => {
    const p = await knownConfigFile(file || sshconfig.CONFIG_PATH);
    const text = await fs.promises.readFile(p, 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
    return { path: p, text };
  });
  handle('sshconfig:check', async ({ file, text } = {}) => {
    const p = await knownConfigFile(file || sshconfig.CONFIG_PATH);
    return checkSshConfigText(text, p);
  });
  handle('sshconfig:write', async ({ file, text } = {}) => {
    const p = await knownConfigFile(file || sshconfig.CONFIG_PATH);
    const check = await checkSshConfigText(text, p);
    if (!check.ok) return { ok: false, errors: check.errors };
    let mode = 0o600;
    try {
      const st = await fs.promises.stat(p);
      mode = st.mode & 0o777;
      await fs.promises.copyFile(p, `${p}.serverlife-backup`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.promises.writeFile(p, String(text || ''), { mode });
    await fs.promises.chmod(p, mode);
    return { ok: true, path: p, backup: `${p}.serverlife-backup`, warnings: check.warnings };
  });
  handle('sshconfig:path', async () => sshconfig.CONFIG_PATH);
  handle('sshconfig:pickKey', async () => {
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: 'Choose a private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  /*
   * Every tsh call that names a proxy runs inside that profile's home. The
   * proxy alone would be ambiguous when two homes hold the same cluster, so
   * whatever `home` the renderer knows about is honoured first.
   */
  const inHome = (fn) => async (...args) => {
    const opts = args[args.length - 1];
    const home = opts && typeof opts === 'object' ? opts.home : null;
    return teleport.withHome(home, () => fn(...args));
  };

  handle('teleport:status', async () => teleport.status());
  handle('teleport:nodes', inHome(async (opts) => teleport.listNodes(opts || {})));
  // Root plus every trusted leaf, which `tsh status` never mentions.
  handle('teleport:clusters', inHome(async (opts) => teleport.listClusters(opts || {})));
  handle('teleport:switchProfile', inHome(async (opts) => teleport.switchProfile(opts)));
  /*
   * How a proxy can be logged into, as its own login page knows it: the SSO
   * providers, whether local users and passwordless are allowed, the default.
   * Read from the web UI's config — public, no certificate needed — so a
   * cluster can be set up before anyone has logged into it.
   */
  handle('teleport:loginMethods', async (proxy) => {
    const host = String(proxy || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
    if (!host) return { ok: false, error: 'No proxy' };
    try {
      const res = await fetch(`https://${host}/web/config.js`, { signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      const m = text.match(/GRV_CONFIG\s*=\s*(\{[\s\S]*?\});?\s*$/m);
      const auth = m ? (JSON.parse(m[1]).auth || {}) : {};
      return {
        ok: true,
        authType: auth.authType || null,
        defaultConnector: auth.defaultConnectorName || '',
        local: auth.localAuthEnabled !== false,
        passwordless: !!auth.allowPasswordless,
        secondFactors: auth.second_factors || [],
        providers: (auth.providers || []).map((x) => ({ name: x.name, type: x.type, display: x.displayName || x.name })),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  handle('teleport:login', inHome(async (opts) => teleport.login(opts || {})));
  /*
   * The same login as an argv, to be run in a terminal instead.
   *
   * A login that names a user is heading for a password or an OTP prompt, and
   * a prompt in a spawned process with nowhere to draw is a login that hangs
   * and then fails. Handing it a real terminal is the only honest answer.
   */
  handle('teleport:loginArgs', async (opts) => ({
    command: teleport.findTsh(),
    args: teleport.loginArgs(opts || {}),
    teleportHome: opts?.home || teleport.homeForProxy(opts?.proxy) || null,
  }));
  // The same login as a line to paste into a terminal, TELEPORT_HOME included.
  handle('teleport:loginCommand', async (opts) => teleport.loginCommand(opts || {}));
  handle('teleport:logout', inHome(async (opts) => teleport.logout(opts || {})));
  handle('teleport:removeProfile', async (opts) => teleport.removeProfile(opts || {}));
  handle('teleport:profileFiles', async (opts) => teleport.profileFiles(opts || {}));
  handle('teleport:requests', inHome(async (opts) => teleport.listRequests(opts || {})));
  handle('teleport:requestShow', inHome(async (id, opts) => teleport.showRequest(id, opts || {})));
  handle('teleport:requestAssume', inHome(async (id, opts) => teleport.assumeRequest(id, opts || {})));
  handle('teleport:requestDrop', inHome(async (ids, opts) => teleport.dropRequest(ids, opts || {})));
  handle('teleport:requestCreate', inHome(async (opts) => teleport.createRequest(opts || {})));
  handle('teleport:requestSearch', inHome(async (opts) => teleport.searchRequestable(opts || {})));
  handle('teleport:inventoryNodeIds', async (opts) => teleport.inventoryNodeIds(opts || {}));
  handle('teleport:inventoryKubeIds', async (opts) => teleport.inventoryKubeIds(opts || {}));
  // A join token for the SSH/Kubernetes "add Teleport" install wizards — see teleport.js's createJoinToken().
  handle('teleport:createJoinToken', async (opts) => teleport.createJoinToken(opts || {}));
  // The commands for "Install Teleport on this host" — see teleport.js's nodeInstallCommand().
  handle('teleport:nodeInstallCommand', async (opts) => teleport.nodeInstallCommand(opts || {}));
  handle('teleport:requestRoles', inHome(async (opts) => teleport.searchRequestableRoles(opts || {})));
  handle('teleport:probeRequest', inHome(async (opts) => teleport.probeRequest(opts || {})));
  handle('teleport:rolesForResources', async (requests, ids) => teleport.rolesForResources(requests, ids));
  handle('teleport:requestKinds', async () => teleport.REQUEST_KINDS);
  handle('teleport:requestPreview', async (opts) => ['tsh', ...teleport.createRequestArgs(opts || {})]);
  handle('teleport:webapiPing', async (opts) => nettools.webapiPing(opts || {}));
  // The cluster's page in the Teleport web UI. Built here and opened here, so
  // the renderer never gets to hand an arbitrary URL to the browser.
  handle('teleport:webClusterUrl', async (opts) => teleport.webClusterUrl(opts || {}));
  handle('teleport:openWebCluster', async (opts) => {
    const url = teleport.webClusterUrl(opts || {});
    if (!url) throw new Error('No proxy address for this cluster, so there is no web UI to open');
    await shell.openExternal(url);
    return url;
  });

  /* --- beams --- */

  /*
   * Whether a cluster runs the beams service, cached per proxy: the answer
   * cannot change between two clicks, and the probe is a round trip to the
   * cluster. `refresh` is for after someone has upgraded one.
   */
  const beamSupport = new Map();
  /*
   * KubeLife: contexts from the default kubeconfig location ($KUBECONFIG or
   * ~/.kube/config) plus any extra files added in Settings. No caching here
   * — unlike a Teleport probe this is a local file read, cheap enough to
   * re-run whenever the Resources tab wants a fresh list.
   */
  handle('kube:contexts', async (opts) => kube.listContexts(opts || {}));
  /*
   * Editing a kubeconfig in the app, the same rules as the ssh config editor:
   * only files the app already reads (the default kubeconfig and the ones
   * added in Settings), and never saved before kubectl itself has parsed the
   * new text — `kubectl config view` on a copy — with a context pointing at
   * a cluster or user the file does not have said as a problem too. The file
   * it replaces is kept as <file>.serverlife-backup, permissions kept.
   */
  const knownKubeconfig = (file) => {
    const known = [...kube.defaultKubeconfigPaths(), ...(store.settings.kubeconfigPaths || [])].map((x) => path.resolve(sshconfig.expandHome(String(x))));
    const p = path.resolve(sshconfig.expandHome(String(file || known[0] || '')));
    if (!known.includes(p)) throw new Error(`${file} is not one of the kubeconfig files ServerLife reads.`);
    return p;
  };
  const checkKubeconfigText = async (text, realPath) => {
    const tmp = path.join(os.tmpdir(), `serverlife-kubeconfig-${process.pid}-${Date.now()}`);
    await fs.promises.writeFile(tmp, String(text || ''), { mode: 0o600 });
    try {
      const r = await new Promise((resolve) => {
        execFile(kubebin.findKubectl(), ['config', 'view', '--kubeconfig', tmp, '-o', 'json'], { timeout: 15000, env: kubebin.kubectlEnv({}) },
          (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '').split(tmp).join(realPath) }));
      });
      if (!r.ok) return { ok: false, errors: [kubebin.humanizeKubectlError(r.stderr) || 'kubectl could not read it'] };
      let cfg = {};
      try { cfg = JSON.parse(r.stdout); } catch { return { ok: false, errors: ['kubectl could not read it as a kubeconfig'] }; }
      const clusters = new Set((cfg.clusters || []).map((c) => c.name));
      const users = new Set((cfg.users || []).map((u) => u.name));
      const warnings = [];
      for (const c of cfg.contexts || []) {
        if (c.context?.cluster && !clusters.has(c.context.cluster)) warnings.push(`Context "${c.name}" names cluster "${c.context.cluster}", which this file does not have`);
        if (c.context?.user && !users.has(c.context.user)) warnings.push(`Context "${c.name}" names user "${c.context.user}", which this file does not have`);
      }
      const current = cfg['current-context'];
      if (current && !(cfg.contexts || []).some((c) => c.name === current)) warnings.push(`current-context "${current}" is not one of the contexts in this file`);
      return { ok: true, warnings, contexts: (cfg.contexts || []).length };
    } finally { fs.promises.unlink(tmp).catch(() => {}); }
  };
  handle('kubeconfig:files', async () => {
    const all = [...new Set([...kube.defaultKubeconfigPaths(), ...(store.settings.kubeconfigPaths || [])].map((x) => path.resolve(sshconfig.expandHome(String(x)))))];
    return all.map((f) => ({ path: f, exists: fs.existsSync(f) }));
  });
  handle('kubeconfig:read', async (file) => {
    const p = knownKubeconfig(file);
    const text = await fs.promises.readFile(p, 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
    return { path: p, text };
  });
  handle('kubeconfig:check', async ({ file, text } = {}) => checkKubeconfigText(text, knownKubeconfig(file)));
  handle('kubeconfig:write', async ({ file, text } = {}) => {
    const p = knownKubeconfig(file);
    const check = await checkKubeconfigText(text, p);
    if (!check.ok) return { ok: false, errors: check.errors };
    let mode = 0o600;
    try {
      const st = await fs.promises.stat(p);
      mode = st.mode & 0o777;
      await fs.promises.copyFile(p, `${p}.serverlife-backup`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, String(text || ''), { mode });
    await fs.promises.chmod(p, mode);
    return { ok: true, path: p, backup: `${p}.serverlife-backup`, warnings: check.warnings };
  });
  // What a Teleport cluster *offers*, whether or not it has been logged
  // into yet — the counterpart to kube:contexts, which only ever sees what
  // is already in the local kubeconfig. See kubepanel.js's "available"
  // rows and kube.loginKubeCluster below.
  handle('kube:clusters', async (opts) => kube.listKubeClusters(opts || {}));
  handle('kube:login', async (opts) => kube.loginKubeCluster(opts || {}));
  // "Make this the logged-in cluster" on an already-logged-into context's
  // menu — see kube.js's useContext().
  handle('kube:useContext', async (opts) => kube.useContext(opts || {}));
  // "Remove from kubeconfig…" — see kube.js's deleteContext().
  handle('kube:deleteContext', async (opts) => kube.deleteContext(opts || {}));
  handle('kube:editContext', async (opts) => kube.editContext(opts || {}));
  // "Install Teleport on this cluster" wizard — see kube.js's installTeleportAgent().
  handle('kube:installTeleportAgent', async (opts) => kube.installTeleportAgent(opts?.spec || {}, opts || {}));
  // The same install as a values.yaml — see kube.js's teleportAgentValues().
  handle('kube:teleportAgentValues', async (opts) => ({ ok: true, yaml: kube.teleportAgentValues(opts || {}) }));
  // `tsh proxy kube` — a local proxy for handing a cluster to a plain
  // kubectl or an external tool, kept running until stopped. See kubeproxy.js.
  handle('kube:proxyStart', async (opts) => {
    try { return { ok: true, ...(await kubeproxy.ensure(opts?.id, opts || {})) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  handle('kube:proxyStop', async (opts) => ({ ok: kubeproxy.stop(opts?.id) }));
  handle('kube:proxyStatus', async (opts) => ({ ok: true, info: kubeproxy.status(opts?.id) }));
  // `kubectl port-forward` to one pod/service/workload, kept running until
  // stopped — see kubeforward.js. Several of these can run at once, unlike
  // the one-per-context tsh proxy kube above.
  handle('kube:forwardStart', async (opts) => {
    try { return { ok: true, ...(await kubeforward.start(opts || {})) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  handle('kube:forwardStop', async (opts) => ({ ok: kubeforward.stop(opts?.id) }));
  handle('kube:forwardList', async () => ({ ok: true, forwards: kubeforward.list() }));
  // Pushed to every window the moment a forward starts, stops, or dies on
  // its own — the sidebar's inline list and the full browser's count badge
  // both listen for this rather than polling.
  kubeforward.onChange(() => send('kube:forwardUpdate', { forwards: kubeforward.list() }));
  handle('kube:namespaces', async (opts) => kube.listNamespaces(opts || {}));
  handle('kube:pods', async (opts) => kube.listPods(opts || {}));
  handle('kube:execSpec', async (opts) => kube.execSpec(opts || {}));
  handle('kube:attachSpec', async (opts) => kube.attachSpec(opts || {}));
  handle('kube:debugSpec', async (opts) => kube.debugSpec(opts || {}));
  handle('kube:nodeDebugSpec', async (opts) => kube.nodeDebugSpec(opts || {}));
  handle('kube:logSpec', async (opts) => kube.logSpec(opts || {}, opts || {}));
  handle('kube:kubeconfigEnv', async (opts) => kube.kubeconfigEnvFor(opts || {}));
  // The Log Viewer: one pod, or every pod behind a label selector, tailed
  // as plain lines rather than a PTY — see kubelogs.js. Each line (and the
  // final exit) is pushed as it arrives rather than polled for.
  let logsSeq = 0;
  handle('kube:logsStart', async (opts) => {
    const id = 'logs-' + (++logsSeq) + '-' + Date.now();
    try {
      kubelogs.start({ id, ...(opts || {}) }, (evt) => send('kube:logsData', { id, ...evt }));
      return { ok: true, id };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('kube:logsStop', async (opts) => ({ ok: kubelogs.stop(opts?.id) }));
  // Live rows for the full browser's list views: `kubectl get <kind> -w`,
  // each watched object pushed as it arrives — see kubewatch.js. Pairs
  // with a slower periodic kube:resources re-fetch on the renderer side
  // to catch deletions, which this alone can never see (kubectl's own
  // text watch output has no "it's gone" signal).
  let watchSeq = 0;
  handle('kube:watchStart', async (opts) => {
    const id = 'watch-' + (++watchSeq) + '-' + Date.now();
    try {
      kubewatch.start({ id, ...(opts || {}) }, (evt) => {
        // Shaped into the exact same row a list fetch already returns —
        // not a second, poorer copy of that mapping living in the renderer.
        if (evt.object) send('kube:watchData', { id, row: kuberesources.rowFrom(evt.object) });
        else send('kube:watchData', { id, ...evt });
      });
      return { ok: true, id };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('kube:watchStop', async (opts) => ({ ok: kubewatch.stop(opts?.id) }));
  // KubeLife's file browser: a pod's filesystem, through kubectl exec/cp — see kubefs.js.
  handle('kube:ls', async (opts) => kubefs.ls(opts?.spec || {}, opts?.dir));
  handle('kube:mkdir', async (opts) => kubefs.mkdir(opts?.spec || {}, opts?.dir));
  handle('kube:rm', async (opts) => kubefs.rm(opts?.spec || {}, opts?.target));
  handle('kube:rename', async (opts) => kubefs.rename(opts?.spec || {}, opts?.from, opts?.to));
  handle('kube:readFile', async (opts) => kubefs.readFile(opts?.spec || {}, opts?.path));
  handle('kube:writeFile', async (opts) => kubefs.writeFile(opts?.spec || {}, opts?.path, opts?.data));
  handle('kube:downloadPath', async (opts) => kubefs.downloadPath(opts?.spec || {}, opts?.remotePath, opts?.localPath));
  handle('kube:uploadPath', async (opts) => kubefs.uploadPath(opts?.spec || {}, opts?.localPath, opts?.remotePath));
  // The full-cluster browser: every resource kind the cluster has, CRDs
  // included automatically — see kuberesources.js.
  handle('kube:resourceTypes', async (opts) => kuberesources.discoverResourceTypes(opts?.spec || {}));
  handle('kube:resources', async (opts) => kuberesources.getResources(opts?.spec || {}, opts?.type || {}));
  handle('kube:resourceYaml', async (opts) => kuberesources.getYaml(opts?.spec || {}, opts?.target || {}));
  handle('kube:diffYaml', async (opts) => kuberesources.diffYaml(opts?.spec || {}, { yaml: opts?.yaml }));
  handle('kube:applyYaml', async (opts) => kuberesources.applyYaml(opts?.spec || {}, { yaml: opts?.yaml }));
  // The YAML editor's own live validation/autocomplete — see kuberesources.js's validateYaml and kubeexplain.js.
  handle('kube:validateYaml', async (opts) => kuberesources.validateYaml(opts?.spec || {}, { yaml: opts?.yaml }));
  handle('kube:explainFields', async (opts) => kubeexplain.explainFields(opts?.spec || {}, opts?.target || {}));
  // `kubectl kustomize <dir>` — see kubekustomize.js.
  handle('kube:kustomizeBuild', async (opts) => kubekustomize.build(opts?.spec || {}, opts?.target || {}));
  handle('kube:describeResource', async (opts) => kuberesources.describe(opts?.spec || {}, opts?.target || {}));
  // The detail panel: the full object a list row only ever shows trimmed,
  // plus where it leads next (owners, a PVC's PV, a Service's Endpoints).
  handle('kube:getObject', async (opts) => kuberesources.getObject(opts?.spec || {}, opts?.target || {}));
  // A CRD's own additionalPrinterColumns, cached — see kuberesources.js.
  handle('kube:crdColumns', async (opts) => ({ ok: true, columns: await kuberesources.crdColumnsFor(opts?.spec || {}, opts?.type || {}) }));
  handle('kube:deleteResource', async (opts) => kuberesources.deleteResource(opts?.spec || {}, opts?.target || {}));
  handle('kube:cordonNode', async (opts) => kuberesources.cordonNode(opts?.spec || {}, opts?.target || {}));
  handle('kube:drainNode', async (opts) => kuberesources.drainNode(opts?.spec || {}, opts?.target || {}));
  handle('kube:canI', async (opts) => kuberesources.canI(opts?.spec || {}, opts?.target || {}));
  // The kube browser's "My access" and the overview's usage section.
  handle('kube:access', async (opts) => kuberesources.access(opts?.spec || {}, opts?.target || {}));
  // The reverse of can-i: every subject some Role/ClusterRole binding
  // already grants a verb/resource to — see kuberbac.js.
  handle('kube:whoCan', async (opts) => kuberesources.whoCan(opts?.spec || {}, opts?.target || {}));
  // Edit a Secret's decoded values — see kuberesources.js's patchSecretStringData.
  handle('kube:patchSecretData', async (opts) => kuberesources.patchSecretStringData(opts?.spec || {}, opts?.target || {}));
  // A Popeye cluster scan — see kubelint.js.
  handle('kube:lintScan', async (opts) => kubelint.scan(opts?.spec || {}, opts?.target || {}));
  // "Test this role": a disposable in-cluster pod runs as a binding's own
  // ServiceAccount and asks SelfSubjectAccessReview for real — see kubetest.js.
  handle('kube:testServiceAccountAccess', async (opts) => {
    const { rules, namespace, serviceAccountName } = opts?.target || {};
    const checks = kuberesources.sampleChecksFromRules(rules, namespace);
    return kubetest.testServiceAccountAccess(opts?.spec || {}, { namespace, serviceAccountName, checks });
  });
  handle('kube:top', async (opts) => kuberesources.top(opts?.spec || {}, opts?.target || {}));
  handle('kube:topPodContainers', async (opts) => kuberesources.topPodContainers(opts?.spec || {}, opts?.target || {}));
  // CPU/memory history for the full browser's own charts: `kubectl top`
  // has no watch mode, so this polls on an interval — see kubemetrics.js.
  let metricsSeq = 0;
  handle('kube:metricsStart', async (opts) => {
    const id = 'metrics-' + (++metricsSeq) + '-' + Date.now();
    try {
      kubemetrics.start({ id, ...(opts || {}) }, (snap) => send('kube:metricsData', { id, ...snap }));
      return { ok: true, id };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('kube:metricsStop', async (opts) => ({ ok: kubemetrics.stop(opts?.id) }));
  // Workload actions — the buttons every other kube client has. See kubeops.js.
  handle('kube:scale', async (opts) => kubeops.scale(opts?.spec || {}, opts?.target || {}));
  handle('kube:rollout', async (opts) => kubeops.rollout(opts?.spec || {}, opts?.target || {}));
  handle('kube:rolloutHistory', async (opts) => kubeops.rolloutHistory(opts?.spec || {}, opts?.target || {}));
  handle('kube:setImage', async (opts) => kubeops.setImage(opts?.spec || {}, opts?.target || {}));
  handle('kube:setEnv', async (opts) => kubeops.setEnv(opts?.spec || {}, opts?.target || {}));
  handle('kube:setResources', async (opts) => kubeops.setResources(opts?.spec || {}, opts?.target || {}));
  handle('kube:containersOf', async (opts) => kubeops.containersOf(opts?.spec || {}, opts?.target || {}));
  handle('kube:cronTrigger', async (opts) => kubeops.cronTrigger(opts?.spec || {}, opts?.target || {}));
  handle('kube:cronSuspend', async (opts) => kubeops.cronSuspend(opts?.spec || {}, opts?.target || {}));
  handle('kube:deleteMany', async (opts) => kubeops.deleteMany(opts?.spec || {}, opts?.target || {}));
  handle('kube:evict', async (opts) => kubeops.evict(opts?.spec || {}, opts?.target || {}));
  // Export as Kubernetes JSON/YAML (a `kind: List`) — see kubeexport.js.
  handle('kube:exportResources', async (opts) => kubeexport.exportResources(opts?.spec || {}, opts?.target || {}));
  // The group → ClusterRole wizard's two halves (see kubeops.js): pure, nothing applied here.
  handle('kube:groupBinding', async (opts) => kubeops.groupBinding(opts || {}));
  handle('kube:teleportRoleFor', async (opts) => kubeops.teleportRoleFor(opts || {}));
  // No spec — a pure {kind, fields} -> YAML manifest, shown through the
  // browser's existing diff-before-apply flow (kube:diffYaml/kube:applyYaml).
  handle('kube:manifestFor', async (opts) => kubeops.manifestFor(opts?.kind, opts?.fields || {}));
  // Local ecosystem tools (helm, k9s, stern, kubectx, kubens, kind, k3d,
  // minikube, kustomize) — see kubebin.js. No caching: a fast local search.
  handle('kube:ecosystemStatus', async () => kubebin.ecosystemStatus());
  // The 3D view's data: pods (listPods()) plus Deployments/Services through
  // the same generic resource reader the full browser uses — reshaped by
  // namespace, see kubescan.js. Deployments/Services are best-effort: a
  // cluster where either call fails (RBAC, a slow API) still gets its pods.
  handle('kube:scene', async (opts) => {
    const spec = opts?.spec || {};
    const namespace = opts?.namespace || undefined;
    const [podsRes, depRes, svcRes] = await Promise.all([
      kube.listPods(namespace ? { ...spec, namespace } : spec),
      kuberesources.getResources(spec, { name: 'deployments', namespaced: true, namespace }),
      kuberesources.getResources(spec, { name: 'services', namespaced: true, namespace }),
    ]);
    if (!podsRes.ok) return podsRes;
    return {
      ok: true,
      ...kubescan.buildScene({
        pods: podsRes.pods,
        deployments: depRes.ok ? depRes.items : [],
        services: svcRes.ok ? svcRes.items : [],
      }),
    };
  });
  // Helm releases, surfaced in the full cluster browser — see kubehelm.js.
  handle('kube:helmReleases', async (opts) => kubehelm.listReleases(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmHistory', async (opts) => kubehelm.history(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmValues', async (opts) => kubehelm.getValues(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmManifest', async (opts) => kubehelm.getManifest(opts?.spec || {}, opts?.target || {}));
  // A release as a diagram: its rendered manifest read into resources and
  // the references between them, plus the same graph as Mermaid — see kubegraph.js.
  handle('kube:helmGraph', async (opts) => {
    const t = opts?.target || {};
    const m = await kubehelm.getManifest(opts?.spec || {}, t);
    if (!m.ok) return m;
    return { ok: true, ...kubegraph.manifestGraph(m.yaml, { title: `Helm release ${t.release} (${t.namespace})` }) };
  });
  // Any {nodes, edges} as Mermaid — the 3D view's "Export Mermaid".
  handle('kube:mermaid', async (opts) => ({ ok: true, mermaid: kubegraph.toMermaid({ nodes: opts?.nodes || [], edges: opts?.edges || [] }, { title: opts?.title }) }));
  handle('kube:helmRollback', async (opts) => kubehelm.rollback(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmUninstall', async (opts) => kubehelm.uninstall(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmAddRepo', async (opts) => kubehelm.addRepo(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmInstall', async (opts) => kubehelm.install(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmUpgrade', async (opts) => kubehelm.upgrade(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmSearch', async (opts) => kubehelm.searchCharts(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmReadme', async (opts) => kubehelm.showReadme(opts?.spec || {}, opts?.target || {}));
  // The values-form in the Install/Upgrade wizard — flattened server-side (see kubehelm.js's fieldsFromSchema) so the renderer never has to parse a raw JSON Schema itself.
  handle('kube:helmValuesSchema', async (opts) => {
    const r = await kubehelm.getValuesSchema(opts?.spec || {}, opts?.target || {});
    if (!r.ok) return r;
    return { ok: true, fields: r.schema ? kubehelm.fieldsFromSchema(r.schema) : [] };
  });
  handle('kube:helmTest', async (opts) => kubehelm.test(opts?.spec || {}, opts?.target || {}));
  handle('kube:helmRenderTemplate', async (opts) => kubehelm.renderTemplate(opts?.spec || {}, opts?.target || {}));

  handle('beams:supported', inHome(async (opts) => {
    const key = `${opts?.home || ''}|${opts?.proxy || ''}`;
    if (!opts?.refresh && beamSupport.has(key)) return beamSupport.get(key);
    const r = await beams.supported(opts || {});
    beamSupport.set(key, r);
    return r;
  }));
  handle('beams:list', inHome(async (opts) => beams.list(opts || {})));
  handle('beams:add', inHome(async (opts) => beams.add(opts || {})));
  handle('beams:addSupport', inHome(async (opts) => beams.addSupport(opts || {})));
  // Checking a tsh variables box as it is typed: what it sets, and what it cannot read.
  handle('teleport:parseEnv', async (text) => teleport.parseEnvText(text));
  // A tsh home as typed — ~, $VAR, ${VAR} — and where it points now, for the Add a tsh home dialog.
  handle('teleport:resolveHome', async (text) => {
    const raw = String(text || '').trim();
    const unset = [...raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((m) => m[1] || m[2]).filter((n) => !process.env[n]);
    const resolved = teleport.expandHome(raw);
    let exists = false;
    let profiles = 0;
    if (resolved) {
      try { exists = fs.statSync(resolved).isDirectory(); } catch { exists = false; }
      try { profiles = fs.readdirSync(resolved).filter((n) => n.endsWith('.yaml')).length; } catch { profiles = 0; }
    }
    return { raw, resolved, exists, profiles, unset };
  });
  handle('beams:phases', inHome(async (opts) => beams.phases(opts || {})));
  handle('beams:removePhase', inHome(async (opts) => beams.removePhase(opts || {})));
  // What a terminal tab runs for a Phase build — the console needs a real one.
  const phaseRun = (args, opts) => ({
    command: teleport.findTsh(),
    args,
    teleportHome: opts?.home || teleport.homeForProxy(opts?.proxy) || null,
  });
  handle('beams:failedPhases', inHome(async (opts) => beams.failedPhases(opts || {})));
  handle('beams:phaseAddArgs', async (opts) => phaseRun(beams.phaseAddArgs(opts || {}), opts));
  handle('beams:phaseEditArgs', async (opts) => phaseRun(beams.phaseEditArgs(opts || {}), opts));
  handle('beams:phaseApplyArgs', async (opts) => phaseRun(beams.phaseApplyArgs(opts || {}), opts));
  handle('beams:phaseSnapshot', inHome(async (opts) => beams.phaseSnapshot(opts || {})));
  handle('beams:services', inHome(async (opts) => beams.beamServices(opts || {})));
  handle('beams:serviceLogs', inHome(async (opts) => beams.beamServiceLogs(opts || {})));
  /*
   * Phase setups (phasesetup.js): the catalog, a live check of the stages as
   * they are put together — local files looked for here, where they are —
   * and the phase.yaml written where tsh can read it. A build gets its own
   * file under the app's data, kept so the build journal can say what ran.
   */
  // Add-ins: a folder of setups of your own (phasesetup.js), read fresh each time — they are a few small files.
  const addinsDir = () => store.settings.phaseAddinsDir || path.join(app.getPath('userData'), 'phase-addins');
  const setupCtx = () => ({
    home: os.homedir(),
    exists: (p) => { try { fs.accessSync(p); return true; } catch { return false; } },
    addins: phasesetup.loadAddins(addinsDir()).addins,
  });
  handle('phasesetup:catalog', async () => phasesetup.catalog(phasesetup.loadAddins(addinsDir()).addins));
  handle('phasesetup:build', async (stages) => phasesetup.build(stages || [], setupCtx()));
  /*
   * phase.yaml written by hand in the builder: read into stages (to show on
   * the left, and to check with the same rules), the text itself left as it
   * was typed — comments, order and all.
   */
  const checkHandYaml = (text) => {
    let parsed;
    try { parsed = phasesetup.fromYaml(text); } catch (e) { return { ok: false, parsed: false, stages: null, errors: [e.message], warnings: [], incomplete: [] }; }
    const r = phasesetup.build(parsed.stages, setupCtx());
    // tsh reads a relative from: against the file's own folder — wherever it is saved — and does not expand ~.
    const relative = [];
    try {
      for (const d of require('js-yaml').loadAll(text)) {
        for (const f of (d && Array.isArray(d.files) ? d.files : [])) {
          if (f?.from && !path.isAbsolute(String(f.from))) relative.push(`${d.metadata?.name || 'a stage'}: write "${f.from}" as a full path — tsh reads it relative to wherever the file is saved, and does not expand ~`);
        }
      }
    } catch { /* fromYaml has already said what is wrong with it */ }
    r.errors.push(...relative);
    return { ok: !r.errors.length, parsed: true, stages: parsed.stages, errors: r.errors, incomplete: r.incomplete, warnings: [...parsed.warnings, ...r.warnings], names: r.docs.map((d) => d.metadata.name) };
  };
  handle('phasesetup:checkYaml', async (text) => checkHandYaml(String(text || '')));
  handle('phasesetup:write', async ({ stages, file, yaml: handText } = {}) => {
    if (typeof handText === 'string') {
      const c = checkHandYaml(handText);
      if (!c.ok) return { ok: false, errors: c.errors };
      const target = file || path.join(app.getPath('userData'), 'phase-setups',
        `${(c.names[0] || 'phase')}-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, handText.endsWith('\n') ? handText : handText + '\n');
      return { ok: true, file: target, yaml: handText, stages: c.names };
    }
    const r = phasesetup.build(stages || [], setupCtx());
    if (r.errors.length) return { ok: false, errors: r.errors };
    const target = file || path.join(app.getPath('userData'), 'phase-setups',
      `${(r.docs[0]?.metadata?.name || 'phase')}-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, r.yaml);
    return { ok: true, file: target, yaml: r.yaml, stages: r.docs.map((d) => d.metadata.name) };
  });
  // An existing phase.yaml, to carry on from: picked here, from where the builds are kept unless told otherwise.
  handle('phasesetup:open', async () => {
    const dir = path.join(app.getPath('userData'), 'phase-setups');
    fs.mkdirSync(dir, { recursive: true });
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: 'Open a phase.yaml', defaultPath: dir, properties: ['openFile'],
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const text = fs.readFileSync(file, 'utf8');
    return { file, text, ...phasesetup.fromYaml(text, { dir: path.dirname(file) }) };
  });
  /* The add-in manager: list, check as typed, save, delete, and where they live. */
  const addinFile = (name) => {
    const base = String(name || '').trim().toLowerCase().replace(/\.ya?ml$/, '');
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(base)) throw new Error('A file name is lowercase letters, digits, . _ -');
    return path.join(addinsDir(), base + '.yaml');
  };
  const insideAddins = (file) => path.dirname(path.resolve(file)) === path.resolve(addinsDir());
  handle('phasesetup:addins', async () => {
    const r = phasesetup.loadAddins(addinsDir());
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    return {
      dir: r.dir, custom: !!store.settings.phaseAddinsDir, template: phasesetup.ADDIN_TEMPLATE,
      addins: r.addins.map((a) => ({ id: a.id, label: a.label, group: a.group, stage: a.stage, file: a.file, text: read(a.file) })),
      problems: r.problems.map((p) => ({ ...p, text: read(p.file) })),
    };
  });
  handle('phasesetup:checkAddin', async ({ text, name } = {}) => {
    try {
      const a = phasesetup.parseAddin(String(text || ''), String(name || 'addin'));
      // Built with its defaults, as the builder would on adding it: the errors a stage would show.
      const values = Object.fromEntries(a.fields.map((f) => [f.key, f.default || f.placeholder || 'x']));
      const kind = a.stage === 'files' ? 'files' : 'commands';
      const setups = [{ id: a.id, values }];
      if (a.stage === 'any') setups.push({ id: 'command', values: { shell: 'true' } });
      const r = phasesetup.build([{ name: 'check', kind, setups }], { ...setupCtx(), addins: [a], exists: () => true });
      return { ok: !r.errors.length, errors: r.errors.map((e) => e.replace(/^Stage "check", /, '')), label: a.label, stage: a.stage, yaml: r.yaml };
    } catch (e) { return { ok: false, errors: [e.message] }; }
  });
  handle('phasesetup:saveAddin', async ({ name, text, file } = {}) => {
    const target = file && insideAddins(file) ? file : addinFile(name);
    phasesetup.parseAddin(String(text || ''), path.basename(target).replace(/\.ya?ml$/, ''));
    if (!file && fs.existsSync(target)) throw new Error(`${path.basename(target)} is already there — pick another name`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(text));
    return { ok: true, file: target };
  });
  handle('phasesetup:removeAddin', async (file) => {
    if (!file || !insideAddins(file)) throw new Error('Not an add-in file');
    fs.rmSync(file, { force: true });
    return true;
  });
  handle('phasesetup:openAddinsDir', async () => {
    fs.mkdirSync(addinsDir(), { recursive: true });
    const err = await shell.openPath(addinsDir());
    return err ? { ok: false, error: err } : { ok: true, dir: addinsDir() };
  });
  handle('phasesetup:chooseAddinsDir', async ({ reset } = {}) => {
    if (reset) { store.updateSettings({ phaseAddinsDir: '' }); return { dir: addinsDir(), custom: false }; }
    const r = await dialog.showOpenDialog(dialogParent(), { title: 'Folder of Phase add-ins', properties: ['openDirectory', 'createDirectory'], defaultPath: addinsDir() });
    if (r.canceled || !r.filePaths[0]) return null;
    store.updateSettings({ phaseAddinsDir: r.filePaths[0] });
    return { dir: r.filePaths[0], custom: true };
  });
  handle('beams:remove', inHome(async (opts) => beams.remove(opts || {})));
  handle('beams:stillListed', inHome(async (opts) => beams.stillListed(opts || {})));
  handle('beams:exec', inHome(async (opts) => beams.exec(opts || {})));
  handle('beams:publish', inHome(async (opts) => beams.publish(opts || {})));
  handle('beams:unpublish', inHome(async (opts) => beams.unpublish(opts || {})));
  handle('beams:scp', inHome(async (opts) => beams.scp(opts || {})));

  /* --- network tools --- */
  /*
   * Pasted things taken apart — a subnet, a URL, an SSH certificate, a JWT,
   * an X.509-SVID. Nothing is sent anywhere.
   */
  handle('decode:run', async ({ kind, input, opts } = {}) => {
    const fn = { cidr: decoders.cidr, url: decoders.url, jwt: decoders.jwt, sshcert: decoders.sshCert, svid: decoders.svid }[kind];
    if (!fn) throw new Error(`Nothing decodes "${kind}".`);
    return fn(input, opts || {});
  });
  // The SSH certificates tsh has issued, newest first, with their text.
  handle('decode:tshCerts', async () => {
    const tp = await teleport.status().catch(() => ({ profiles: [] }));
    const homes = [...new Set([path.join(os.homedir(), '.tsh'), ...(tp.profiles || []).map((p) => p.homeDir).filter(Boolean)])];
    const list = await decoders.tshCertificates(homes);
    return Promise.all(list.map(async (c) => ({ ...c, text: await fsp.readFile(c.file, 'utf8').catch(() => '') })));
  });
  /**
   * A file to decode, picked from disk. SSH certificates start in tsh's keys
   * folder, where they usually are; the rest start wherever the dialog last was.
   * Capped and checked for text: these are all one-line or PEM files, and a
   * stray binary picked by mistake should say so rather than fail to decode.
   */
  handle('decode:pickFile', async (kind) => {
    const keys = path.join(os.homedir(), '.tsh', 'keys');
    const filters = {
      sshcert: [{ name: 'SSH certificates', extensions: ['pub'] }],
      svid: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }],
    }[kind];
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: 'Choose a file to decode',
      properties: ['openFile', 'showHiddenFiles'],
      defaultPath: kind === 'sshcert' && fs.existsSync(keys) ? keys : undefined,
      filters: filters ? [...filters, { name: 'All files', extensions: ['*'] }] : undefined,
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const st = await fsp.stat(file);
    if (st.size > 1024 * 1024) throw new Error('That file is too large to be a certificate or token.');
    const buf = await fsp.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) throw new Error('That looks like a binary file — pick the PEM or text form.');
    return { file, text: buf.toString('utf8') };
  });
  handle('net:ping', async (opts) => nettools.ping(opts || {}));
  handle('net:traceroute', async (opts) => nettools.traceroute(opts || {}));
  handle('net:lookup', async (opts) => nettools.lookup(opts || {}));
  handle('net:portCheck', async (opts) => nettools.portCheck(opts || {}));
  handle('net:tlsInfo', async (opts) => nettools.tlsInfo(opts || {}));
  handle('net:httpCheck', async (opts) => nettools.httpCheck(opts || {}));
  handle('net:whois', async (opts) => nettools.whois(opts || {}));
  handle('net:curl', async (opts) => nettools.curlRequest(opts || {}));
  handle('net:telnetProbe', async (opts) => nettools.telnetProbe(opts || {}));
  // What is listening, and what is connected — on this machine.
  handle('net:sockets', async () => sockets.listSockets());
  // A CA bundle or a client cert/key for curl — any file, unlike pickKey's
  // own default of ~/.ssh and its "private key" framing.
  handle('net:pickFile', async (title) => {
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: title || 'Choose a file',
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  /* --- the same tools, run against a host rather than from here --- */

  /**
   * The command that would install a missing tool on *that* host, named for
   * the package manager it actually has. Cheap: the capability probe already
   * looked, and its answer is cached for the life of the connection.
   */
  const hintFor = async (conn, tool) => {
    if (!tool) return null;
    const caps = await conn.hostTools().catch(() => null);
    return nettools.installHint(tool, caps?.pkg) || null;
  };

  /**
   * What the chosen host can do, and what it would need installed.
   *
   * The answer drives the tool list in the window: a tool that cannot run is
   * greyed with the reason and the command that would fix it, rather than
   * failing when it is pressed.
   */
  handle('net:hostTools', async (connId, opts) => {
    const conn = requireConn(connId);
    const caps = await conn.hostTools({ refresh: !!opts?.refresh });
    /*
     * Only what is actually missing. A tool with a working stand-in on the box
     * is not missing anything: `tracepath` and `mtr` answer the traceroute
     * question, and listing "missing traceroute" beside "traceroute: yes"
     * reads as a contradiction.
     */
    const covered = {
      traceroute: caps.tools.tracepath || caps.tools.mtr,
      dig: caps.tools.host || caps.tools.nslookup,
      nc: caps.devtcp || caps.tools.ncat || caps.tools.python3,
    };
    return {
      ...caps,
      hints: Object.fromEntries(Object.keys(nettools.TOOL_PACKAGES)
        .filter((t) => !caps.tools[t] && !covered[t])
        .map((t) => [t, nettools.installHint(t, caps.pkg)])
        .filter(([, hint]) => hint)),
    };
  });

  handle('net:hostFacts', async (connId) => requireConn(connId).hostFacts());

  /**
   * Can that host reach this address and port?
   *
   * Preferably answered with nothing installed on it — `ssh -W` has the server
   * open the connection over the session that is already authenticated. The
   * cap is the same as the local check: a reachability question, not a
   * scanner, and this one runs on somebody else's machine.
   */
  handle('net:hostPorts', async (connId, opts) => {
    const conn = requireConn(connId);
    // Parsed exactly as the local check parses it: the same "host:port"
    // shorthand, the same ranges, the same cap.
    const { host, port } = nettools.splitHostPort(opts?.host || '');
    const target = nettools.checkHost(host);
    const ports = opts?.ports
      ? nettools.parsePorts(opts.ports)
      : (port ? [port] : nettools.DEFAULT_PORTS);

    const results = await conn.probePorts(target, ports.slice(0, nettools.MAX_PORTS), {
      timeout: opts?.timeout || 4000,
    });
    return {
      host: target,
      from: conn.label,
      how: results.find((r) => r.how)?.how || null,
      results,
    };
  });

  /**
   * Ping and traceroute, run by the host.
   *
   * Both need a tool installed there, unlike the port check — so each returns
   * `missing` rather than an error when the box does not have one, and the
   * window turns that into the install command for its package manager.
   */
  handle('net:hostPing', async (connId, opts) => {
    const conn = requireConn(connId);
    const { host } = nettools.splitHostPort(opts?.host || '');
    const target = nettools.checkHost(host);
    const r = await conn.hostPing(target, { count: opts?.count });
    return { ...r, host: target, from: conn.label, hint: await hintFor(conn, r.missing) };
  });

  handle('net:hostTrace', async (connId, opts) => {
    const conn = requireConn(connId);
    const { host } = nettools.splitHostPort(opts?.host || '');
    const target = nettools.checkHost(host);
    const r = await conn.hostTrace(target, { maxHops: opts?.maxHops });
    return { ...r, host: target, from: conn.label, hint: await hintFor(conn, r.missing) };
  });

  handle('net:hostSockets', async (connId) => {
    const conn = requireConn(connId);
    const r = await conn.hostSockets();
    return { ...r, from: conn.label, hint: await hintFor(conn, r.missing) };
  });

  /**
   * An HTTP request made *by* that host, through a SOCKS proxy over the
   * session. Nothing has to be installed there — the name is resolved and the
   * connection made on the far side, which is the question being asked.
   */
  handle('net:hostCurl', async (connId, opts) => {
    const conn = requireConn(connId);
    return conn.withSocks(({ proxy }) => nettools.curlRequest({ ...(opts || {}), proxy }));
  });
  // The command without running it, for the copy button and the preview.
  handle('net:curlCommand', async (opts) => {
    const { args } = nettools.curlArgs(opts || {});
    return nettools.curlCommand(args);
  });
  // Same idea for every other tool here: no I/O, just what it would run.
  handle('net:previewCommand', async (opts) => nettools.previewCommand(opts || {}));
  /* --- saved requests and recent runs --- */
  handle('net:requests', async () => store.listNetRequests());
  handle('net:requestSave', async (rec) => { store.saveNetRequest(rec); return store.listNetRequests(); });
  handle('net:requestDelete', async (id) => { store.deleteNetRequest(id); return store.listNetRequests(); });
  handle('net:recents', async () => store.listNetRuns());
  handle('net:recentAdd', async (rec) => { store.addNetRun(rec); return store.listNetRuns(); });
  handle('net:recentsClear', async () => { store.clearNetRuns(); return store.listNetRuns(); });
  handle('net:localInfo', async () => nettools.localInfo());
  /* --- downloads --- */
  handle('downloads:list', async () => store.listDownloads());
  handle('downloads:forget', async (id) => { store.deleteDownload(id); return store.listDownloads(); });
  handle('downloads:clear', async () => { store.clearDownloads(); return []; });
  /*
   * Whether each file is still where it was put. Asked for the whole list at
   * once rather than per row, so the panel can grey out what has been moved or
   * deleted instead of offering an Open that silently does nothing.
   */
  handle('downloads:check', async (paths) => {
    const out = {};
    for (const p of Array.isArray(paths) ? paths : []) {
      try { out[p] = fs.existsSync(p); } catch { out[p] = false; }
    }
    return out;
  });

  handle('teleport:savedLogins', async () => store.listTshLogins());
  handle('teleport:saveLogin', async (t) => store.upsertTshLogin(t || {}));
  handle('teleport:deleteSavedLogin', async (id) => { store.deleteTshLogin(id); return true; });
  handle('teleport:markSavedLoginUsed', async (id) => store.markTshLoginUsed(id));

  handle('teleport:savedRequests', async (opts) => store.listRequestTemplates(opts || {}));
  handle('teleport:saveRequest', async (t) => store.upsertRequestTemplate(t || {}));
  handle('teleport:deleteSavedRequest', async (id) => { store.deleteRequestTemplate(id); return true; });
  handle('teleport:markSavedRequestUsed', async (id) => store.markRequestTemplateUsed(id));

  /* --- connections --- */
  handle('conn:create', async (host, opts) => {
    const c = await manager.create(host, withHostPrefs(host, opts || {}));
    // Whatever speed limit is set applies to this connection's queue too.
    const limit = (Number(store.settings.transferLimitKb) || 0) * 1024;
    if (limit && c.queue) c.queue.setLimit(limit);
    return {
      id: c.id, label: c.label, target: c.target, type: c.type, state: c.state,
      // The transport may not be the one that was asked for: with no OpenSSH
      // client, or a node in a leaf cluster, a Teleport node goes over tsh
      // instead. `transportForced` says which of the two it was.
      transport: c.transport,
      transportForced: c.spec?.transportForced || null,
      // Forwarding only (-N), from the host's default or this opening's options:
      // the window opens it as a tunnel, without the file browser.
      noShell: !!c.sshOptions?.noShell,
      forwards: c.sshOptions ? sshoptions.summary(c.sshOptions).filter((x) => /^(-L|-R|SOCKS)/.test(x)) : [],
    };
  });
  handle('conn:connect', async (id) => {
    const c = requireConn(id);
    try {
      await c.connect();
    } catch (e) {
      // Record failed attempts too — a timeline with only successes hides
      // exactly the cases worth investigating.
      const h = store.startHistory(historyEntryFor(c));
      store.endHistory(h.id, { error: e.message });
      // Let the renderer offer the MFA-capable transport rather than a retry
      // that will fail the same way.
      if (c.lastErrorMfaLikely) e.message += ' [mfa]';
      // Let the renderer offer to forget the stale known_hosts entry instead
      // of a retry that will fail identically every time.
      if (c.lastErrorHostKeyChanged) e.message += ' [hostkey]';
      // Let the renderer offer the authprobe diagnosis — which keys were
      // offered, in what order, and why — instead of leaving a plain
      // ssh_config host's "too many authentication failures" unexplained.
      if (c.lastErrorAuthFailedLikely) e.message += ' [authfail]';
      throw e;
    }
    if (!c._historyId) {
      const h = store.startHistory(historyEntryFor(c));
      c._historyId = h.id;
    }
    return { id: c.id, state: c.state, homeDir: c.homeDir, user: c.remoteUser, hostname: c.remoteHostname };
  });
  handle('conn:disconnect', async (id) => {
    const c = manager.get(id);
    if (c && c._historyId) store.endHistory(c._historyId);
    // A watcher whose connection has gone would upload into nothing, and its
    // row would claim to be live. Both go with the session.
    await watchdirs.stopForConnection(id);
    send('watch:update', watchdirs.list());
    await manager.remove(id);
    return true;
  });

  /* --- saved layout --- */
  handleWin('workspace:save', async (slot, ws) => store.saveWorkspace(ws, slot));
  handleWin('workspace:get', async (slot) => store.getWorkspace(slot));
  handleWin('workspace:clear', async (slot) => { store.clearWorkspace(slot); return true; });

  /**
   * Layouts saved by *other* windows. The first window to start asks about all
   * of them, so the user answers "put my windows back" once rather than once
   * per window as each appears.
   */
  handleWin('workspace:others', async (slot) => store.listWorkspaces()
    .filter((w) => w.slot !== slot && !windows.has(w.slot))
    .map((w) => ({ slot: w.slot, savedAt: w.savedAt, tabs: (w.tabs || []).length })));

  /* --- windows --- */
  handle('window:new', async (opts) => {
    const w = createWindow({
      restoreSlot: opts?.restoreSlot || null,
      autoRestore: !!opts?.autoRestore,
      adopt: opts?.adopt || null,
    });
    return w.__slSlot;
  });
  handleWin('window:me', async (slot) => {
    const w = windows.get(slot);
    // Reported, not consumed: the renderer acknowledges separately, so a
    // window that asks twice does not lose the pane it was sent.
    return { slot, count: windows.size, autoRestore: !!(w && w.__slAutoRestore), adopt: w?.__slAdopt || null };
  });
  // "I have it" — after which a reload restores normally rather than
  // adopting a pane this window is already showing.
  handleWin('window:adopted', async (slot) => {
    const w = windows.get(slot);
    if (w) w.__slAdopt = null;
    return true;
  });
  handle('window:list', async () => [...windows.entries()].map(([slot, w]) => ({
    slot,
    title: w.isDestroyed() ? '' : w.getTitle(),
    focused: !w.isDestroyed() && w.isFocused(),
  })));

  handle('layouts:list', async () => store.listLayouts());
  handle('layouts:get', async (id) => store.getLayout(id));
  handle('layouts:save', async (layout) => store.saveLayout(layout));
  handle('layouts:delete', async (id) => { store.deleteLayout(id); return true; });
  handle('layouts:setDefault', async (id) => store.setDefaultLayout(id));
  handle('layouts:getDefault', async () => store.getDefaultLayout());

  /* --- multi-exec files --- */
  handle('mxfile:save', async (def) => {
    const text = mxfile.toYaml(def);
    const safe = String(def?.name || 'multiexec').replace(/[^\w.-]+/g, '-').toLowerCase();
    const r = await dialog.showSaveDialog(dialogParent(), {
      title: 'Save multi-exec run',
      defaultPath: path.join(app.getPath('documents'), `${safe}.yaml`),
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    });
    if (r.canceled) return null;
    await mxfile.save(r.filePath, text);
    return { path: r.filePath, text };
  });
  handle('mxfile:preview', async (def) => mxfile.toYaml(def));
  handle('mxfile:load', async () => {
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: 'Open multi-exec run',
      properties: ['openFile'],
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    });
    if (r.canceled) return null;
    const text = await mxfile.read(r.filePaths[0]);
    return { path: r.filePaths[0], ...mxfile.fromYaml(text) };
  });
  handle('mxfile:saveResults', async (view, opts) => {
    const text = mxfile.resultsToYaml(view, opts || {});
    const r = await dialog.showSaveDialog(dialogParent(), {
      title: 'Save multi-exec results',
      defaultPath: path.join(app.getPath('documents'), `multiexec-results-${Date.now()}.yaml`),
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    });
    if (r.canceled) return null;
    await mxfile.save(r.filePath, text);
    return { path: r.filePath };
  });

  /* --- session history & recordings --- */
  handle('history:list', async (opts) => store.listHistory(opts || {}));
  handle('history:clear', async () => { store.clearHistory(); return true; });
  handle('history:recent', async (opts) =>
    store.listRecent({ limit: opts?.limit ?? store.settings.recentLimit ?? 20 }));
  /* --- flagged sessions and notes --- */
  handle('sessions:notes', async () => store.listSessionNotes());
  handle('sessions:noteSave', async (rec) => store.upsertSessionNote(rec || {}));
  handle('sessions:noteDelete', async (sid) => store.deleteSessionNote(sid));

  handle('recordings:list', inHome(async (opts) => teleport.listRecordings(opts || {})));
  handle('recordings:webUrl', async (opts) => teleport.webSessionUrl(opts || {}));
  handle('recordings:openWeb', async (opts) => {
    const url = teleport.webSessionUrl(opts || {});
    if (!url) throw new Error('Could not build a web UI link for this recording');
    await shell.openExternal(url);
    return url;
  });
  /**
   * Search recorded session transcripts. Long-running, so progress is pushed
   * to the renderer and a cancel flag is honoured between sessions.
   */
  let searchCancelled = false;
  handle('recordings:search', inHome(async (opts) => {
    searchCancelled = false;
    return teleport.searchRecordings({
      ...(opts || {}),
      onProgress: (p) => send('recordings:searchProgress', p),
      shouldStop: () => searchCancelled,
    });
  }));
  handle('recordings:cancelSearch', async () => { searchCancelled = true; return true; });
  handle('recordings:text', inHome(async (sid, opts) => teleport.playText(sid, opts || {})));
  handle('recordings:saveTranscript', async (sid, opts) => {
    const got = await teleport.playText(sid, opts || {});
    if (!got.ok) throw new Error(got.error || 'No stored recording');
    const stamp = (opts?.startedAt ? new Date(opts.startedAt) : new Date())
      .toISOString().slice(0, 19).replace(/:/g, '-');
    const r = await dialog.showSaveDialog(dialogParent(), {
      title: 'Save transcript',
      defaultPath: path.join(app.getPath('documents'),
        `${stamp}_${(opts?.node || 'session')}_${String(sid).slice(0, 8)}.txt`),
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
    });
    if (r.canceled) return null;
    await fsp.writeFile(r.filePath, got.text, 'utf8');
    return { path: r.filePath, bytes: got.text.length };
  });
  handle('recordings:chooseSaveDir', async () => {
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: 'Save transcripts into',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Save here',
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('teleport:statusText', async (opts) => teleport.statusText(opts || {}));
  handle('teleport:latencyArgs', async (opts) => ({
    command: teleport.findTsh(),
    args: teleport.latencyArgs(opts || {}),
    teleportHome: opts?.home || teleport.homeForProxy(opts?.proxy) || null,
  }));
  handle('teleport:activeSessions', async (opts) => teleport.listActiveSessions(opts || {}));
  handle('teleport:joinArgs', async (sid, opts) => ({
    command: teleport.findTsh(),
    args: livesessions.joinArgs(sid, opts || {}),
    teleportHome: opts?.home || teleport.homeForProxy(opts?.proxy) || null,
  }));
  handle('recordings:playArgs', async (sid, opts) => ({
    command: teleport.findTsh(),
    args: teleport.playArgs(sid, opts || {}),
    // Which tsh home holds the certificate for this cluster.
    teleportHome: opts?.home || teleport.homeForProxy(opts?.proxy) || null,
  }));
  handle('conn:list', async () => manager.list());
  handle('conn:writeMaster', async (id, data) => { requireConn(id).writeMaster(data); return true; });
  handle('conn:log', async (id) => requireConn(id).log);
  handle('conn:exec', async (id, cmd) => requireConn(id).exec(cmd));
  /*
   * A one-off command that can prompt — per-session MFA on the tsh
   * transport, where `conn:exec` has no pty for the prompt to appear on or
   * be answered. See Connection.execInteractive.
   */
  handle('conn:execInteractive', async (id, cmd, opts) => requireConn(id).execInteractive(cmd, opts || {}));
  handle('conn:writeExec', async (id, execId, data) => { requireConn(id).writeExec(execId, data); return true; });
  handle('conn:killExec', async (id, execId) => { requireConn(id).killExec(execId); return true; });

  /**
   * Is there a local X server to forward to? Without one, `ssh -X` connects
   * but every graphical program dies on "cannot open display".
   */
  handle('x11:status', async () => {
    const display = process.env.DISPLAY || null;
    if (process.platform === 'win32') {
      return {
        available: !!display,
        display,
        hint: display
          ? 'Using DISPLAY from the environment.'
          : 'Install and start VcXsrv or X410, then set DISPLAY (e.g. 127.0.0.1:0).',
      };
    }
    if (process.platform === 'linux') {
      return {
        available: !!display,
        display,
        hint: display ? 'Using the session X server.' : 'No DISPLAY set. On Wayland, install XWayland.',
      };
    }
    // macOS: XQuartz provides the server and sets DISPLAY for its own clients.
    const installed = ['/opt/X11/bin/Xquartz', '/Applications/Utilities/XQuartz.app', '/opt/X11']
      .some((p) => { try { return fs.existsSync(p); } catch { return false; } });
    return {
      available: !!display && installed,
      display,
      installed,
      hint: !installed
        ? 'XQuartz is not installed. Install it (brew install --cask xquartz), log out and back in.'
        : !display
          ? 'XQuartz is installed but DISPLAY is not set for this app. Launch XQuartz, then restart ServerLife from a terminal so it inherits DISPLAY.'
          : 'XQuartz detected.',
    };
  });

  /* --- keys, agent and known_hosts --- */
  handle('keys:list', async () => sshkeys.listKeys());
  handle('keys:agent', async () => sshkeys.agentKeys());
  handle('keys:addToAgent', async (p2, opts) => sshkeys.addToAgent(p2, opts || {}));
  handle('keys:isEncrypted', async (p2) => sshkeys.isEncrypted(p2));
  handle('keys:generate', async (opts) => sshkeys.generateKey(opts || {}));
  handle('keys:install', async (connId, publicKey) => {
    const c = requireConn(connId);
    await c.connect();
    return sshkeys.installPublicKey((cmd) => c.exec(cmd, { timeout: 20000 }), publicKey);
  });
  /**
   * The known_hosts files that matter for one host: the default, plus any
   * UserKnownHostsFile its ssh_config entry names instead or in addition — a
   * directive that can list more than one path on a single line. Without
   * this, "forget the host key" for a host pinned somewhere else always
   * reported "nothing recorded" even though a stale key really was there.
   */
  async function knownHostsFilesFor(ctx) {
    const files = [sshkeys.KNOWN_HOSTS];
    const alias = ctx?.alias;
    if (!alias || !sshbin.sshAvailable()) return files;
    try {
      const cfg = await sshconfig.resolveHost(alias, ctx.configFile ? ['-F', ctx.configFile] : []);
      const raw = cfg?.userknownhostsfile;
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      for (const entry of list) {
        for (const p of String(entry).split(/\s+/).filter(Boolean)) {
          const expanded = sshconfig.expandHome(p);
          if (!files.includes(expanded)) files.push(expanded);
        }
      }
    } catch { /* ssh -G failed for some reason: the default file is still checked */ }
    return files;
  }
  handle('knownhosts:entries', async (host, ctx) => sshkeys.knownHostEntries(host, await knownHostsFilesFor(ctx)));
  handle('knownhosts:forget', async (host, ctx) => sshkeys.forgetHost(host, await knownHostsFilesFor(ctx)));

  /* --- session logging --- */
  handle('term:startLog', async (connId, termId, filePath) => {
    let target = filePath;
    if (!target) {
      const conn = requireConn(connId);
      const safe = String(conn.label).replace(/[^\w.-]+/g, '_');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const r = await dialog.showSaveDialog(dialogParent(), {
        title: 'Save session log',
        defaultPath: path.join(app.getPath('documents'), `${safe}-${stamp}.log`),
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
      });
      if (r.canceled) return null;
      target = r.filePath;
    }
    return requireConn(connId).startLogging(termId, target);
  });
  handle('term:stopLog', async (connId, termId) => requireConn(connId).stopLogging(termId));
  handle('term:logState', async (connId, termId) => requireConn(connId).loggingState(termId));

  /* --- port forwarding --- */
  handle('forward:add', async (connId, fwd) => requireConn(connId).addForward(fwd));
  handle('forward:remove', async (connId, id) => requireConn(connId).removeForward(id));
  handle('forward:list', async (connId) => (connId ? requireConn(connId).listForwards() : manager.allForwards()));
  handle('forward:favorites', async () => store.listForwardFavorites());
  handle('forward:favoriteAdd', async (rec) => {
    store.addForwardFavorite(rec);
    return store.listForwardFavorites();
  });
  handle('forward:favoriteUpdate', async (id, patch) => {
    store.updateForwardFavorite(id, patch);
    return store.listForwardFavorites();
  });
  handle('forward:favoriteUsed', async (id) => {
    store.markForwardFavoriteUsed(id);
    return store.listForwardFavorites();
  });
  handle('forward:favoriteRemove', async (id) => {
    store.deleteForwardFavorite(id);
    return store.listForwardFavorites();
  });

  /* --- remote host facts --- */
  /*
   * Settings → "No background commands on servers": what the app runs on a
   * host by itself, on a timer — following the shell's folder, the file
   * browser's free space, the live stats — is refused here, whatever asks.
   * On a Teleport node each of those is an entry in the audit log; with this
   * on, the log holds what the person did and nothing else.
   */
  const quietRemote = () => store.settings.quietRemote === true;
  handle('conn:serverInfo', async (connId, opts) => requireConn(connId).serverInfo(opts || {}));
  // "Teleport detected" on a direct SSH host — see Connection.teleportPresence().
  handle('conn:teleportPresence', async (connId, opts) => requireConn(connId).teleportPresence(opts || {}));
  // The live stats bar's one long-running command (Connection.startMonitor).
  handle('conn:startMonitor', async (connId, opts) => (quietRemote()
    ? { ok: false, reason: 'quiet', error: 'Background commands on servers are off in Settings.' }
    : requireConn(connId).startMonitor(opts || {})));
  handle('conn:stopMonitor', async (connId) => manager.connections.get(connId)?.stopMonitor() || false);
  // The same bar under a local shell: this computer, sampled here (localmonitor.js), sent as connection "local".
  handle('local:startMonitor', async (opts) => localmonitor.start(opts || {}, (payload) => send('conn:monitor', 'local', payload)));
  handle('local:stopMonitor', async () => localmonitor.stop());
  handle('conn:diskSpace', async (connId, p) => (quietRemote() ? null : requireConn(connId).diskSpace(p)));
  handle('conn:shellHistory', async (connId, opts) => requireConn(connId).shellHistory(opts || {}));

  /* --- terminals --- */
  handle('term:open', async (connId, opts) => {
    const c = requireConn(connId);
    const rec = await c.openTerminal(opts || {});
    return { id: rec.id };
  });
  handle('term:write', async (connId, id, data) => { requireConn(connId).writeTerminal(id, data); return true; });
  handle('term:resize', async (connId, id, cols, rows) => { requireConn(connId).resizeTerminal(id, cols, rows); return true; });
  handle('term:close', async (connId, id) => { requireConn(connId).closeTerminal(id); return true; });
  handle('term:cwd', async (connId, id) => (quietRemote() ? null : requireConn(connId).terminalCwd(id)));

  handle('localterm:open', async (opts) => localTerms.open(opts || {}));
  handle('localterm:shells', async () => local.listShells());
  handle('localterm:cwd', async (id) => localTerms.cwd(id));
  handle('localterm:write', async (id, data) => { localTerms.write(id, data); return true; });
  handle('localterm:resize', async (id, cols, rows) => { localTerms.resize(id, cols, rows); return true; });
  handle('localterm:close', async (id) => { localTerms.close(id); return true; });

  /* --- serial consoles and telnet --- */
  handle('device:ports', async () => devices.listPorts());
  handle('device:open', async (opts) => devices.open(opts || {}));
  // The pane is bound: release whatever the far end said while it was not.
  handle('device:ready', async (id) => { devices.ready(id); return true; });
  handle('device:write', async (id, data) => { devices.write(id, data); return true; });
  handle('device:resize', async (id, cols, rows) => { devices.resize(id, cols, rows); return true; });
  handle('device:break', async (id, ms) => devices.sendBreak(id, ms));
  handle('device:signals', async (id, sig) => devices.setSignals(id, sig || {}));
  handle('device:close', async (id) => { devices.close(id); return true; });

  /* --- tmux control mode --- */
  /*
   * Only the far side needs tmux: this side speaks the protocol itself, so
   * `probe` asks the host and says what to install if the answer is no.
   */
  handle('tmux:probe', async (connId) => tmuxctl.probeTmux(requireConn(connId)));
  handle('tmux:sessions', async (connId) => tmuxctl.listSessions(requireConn(connId)));

  handle('tmux:attach', async (connId, opts = {}) => {
    const conn = requireConn(connId);
    const probe = await tmuxctl.probeTmux(conn);
    if (!probe.ok) throw new Error(probe.reason || 'tmux is not available on this host');
    const id = `tmux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const session = new tmuxctl.TmuxSession({
      conn,
      sessionName: opts.session || 'serverlife',
      cols: opts.cols || 100,
      rows: opts.rows || 30,
      flowControl: probe.flowControl,
    });
    session.on('output', (ev) => send('tmux:output', { id, pane: ev.pane, data: ev.data, age: ev.age || 0 }));
    session.on('windows', (windows) => send('tmux:windows', { id, windows }));
    session.on('layout', (ev) => send('tmux:layout', { id, ...ev }));
    session.on('pause', (pane) => send('tmux:pause', { id, pane, paused: true }));
    session.on('continue', (pane) => send('tmux:pause', { id, pane, paused: false }));
    /*
     * Whether the session is still on the host, asked of the host.
     *
     * tmux tells a control client only `%exit`, with no reason, whether the
     * session was killed, its last shell exited, or another client detached
     * this one. So the panes cannot tell "ended" from "still running" by the
     * notice alone, and saying "still running, reattach" over a session that
     * no longer exists is what made an ended session look alive. `=` makes the
     * name an exact match. With the connection itself gone the answer is
     * unknown (null), and the window says that instead.
     */
    const stillThere = async () => {
      try {
        const r = await conn.execResult(
          `tmux has-session -t ${tmuxctl.shellQuote('=' + session.sessionName)} 2>/dev/null && echo yes || echo no`,
          { timeout: 10000 });
        if (/\byes\b/.test(r.stdout || '')) return true;
        if (/\bno\b/.test(r.stdout || '')) return false;
      } catch { /* the connection may be gone */ }
      return null;
    };
    const finish = async (reason) => {
      if (!tmuxSessions.has(id)) return;
      tmuxSessions.delete(id);
      const alive = await stillThere();
      send('tmux:ended', { id, reason: reason || null, alive });
    };
    session.on('ended', finish);
    session.on('exit', () => finish('the connection closed'));
    tmuxSessions.set(id, session);
    try {
      await session.start();
    } catch (e) {
      tmuxSessions.delete(id);
      session.close();
      throw e;
    }
    return { id, version: probe.version, flowControl: probe.flowControl, windows: session.windowList() };
  });

  const requireTmux = (id) => {
    const s = tmuxSessions.get(id);
    if (!s) throw new Error('that tmux session is not attached any more');
    return s;
  };
  handle('tmux:write', async (id, pane, data) => { requireTmux(id).writePane(pane, data); return true; });
  handle('tmux:resize', async (id, cols, rows) => { await requireTmux(id).resize(cols, rows); return true; });
  handle('tmux:capture', async (id, pane, lines) => requireTmux(id).capture(pane, { lines: lines || 2000 }));
  handle('tmux:command', async (id, cmd) => requireTmux(id).command(cmd));
  handle('tmux:windows', async (id) => requireTmux(id).refreshWindows());
  /*
   * Detach and end are asked for here, so what became of the session is known
   * and is told to the window directly. The session comes off the list first,
   * so the `%exit` that follows is not reported a second time. Before, it was
   * not reported at all, and the panes went on looking attached to a session
   * that had been left or ended.
   */
  handle('tmux:detach', async (id) => {
    const s = tmuxSessions.get(id);
    if (!s) return true;
    tmuxSessions.delete(id);
    await s.detach();
    send('tmux:ended', { id, reason: 'detached', alive: true });
    return true;
  });
  handle('tmux:kill', async (id) => {
    const s = tmuxSessions.get(id);
    if (!s) return true;
    tmuxSessions.delete(id);
    await s.kill();
    send('tmux:ended', { id, reason: 'ended', alive: false });
    return true;
  });

  /* --- VNC and RDP --- */
  handle('vnc:prepare', async (target) => vnc.prepare(target || {}));
  handle('vnc:release', async (token) => { vnc.release(token); return true; });
  handle('rdp:launch', async (conn) => rdp.launch(conn || {}, { shell }));
  handle('rdp:available', async () => rdp.clientAvailable());

  /* --- remote files (SFTP) --- */
  handle('sftp:home', async (connId) => {
    const c = requireConn(connId);
    const s = await c.getSftp();
    return c.homeDir || await s.realpath('.');
  });
  handle('sftp:list', async (connId, dir) => {
    const s = await requireConn(connId).getSftp();
    // Always hand back an absolute path: the UI shows it and navigates from it,
    // and "." or "~" would break going to the parent.
    const target = (!dir || dir === '~' || dir === '.')
      ? await s.realpath('.')
      : await s.realpath(dir).catch(() => dir);
    const entries = await s.list(target);
    // Resolve symlink targets so the UI knows what is enterable.
    const resolved = await Promise.all(entries.map((e) =>
      e.type === 'symlink' ? s.resolveEntry(e) : Promise.resolve(e)));
    return { path: target, entries: resolved };
  });
  handle('sftp:realpath', async (connId, p) => (await requireConn(connId).getSftp()).realpath(p));
  handle('sftp:mkdir', async (connId, p) => { await (await requireConn(connId).getSftp()).mkdir(p); return true; });
  handle('sftp:rename', async (connId, a, b) => { await (await requireConn(connId).getSftp()).rename(a, b); return true; });
  handle('sftp:chmod', async (connId, p, mode) => { await (await requireConn(connId).getSftp()).chmod(p, mode); return true; });
  handle('sftp:remove', async (connId, entries) => {
    const s = await requireConn(connId).getSftp();
    for (const e of entries) {
      const isDir = e.type === 'directory' || e.targetType === 'directory';
      if (isDir && e.type !== 'symlink') await s.removeTree(e.path);
      else await s.remove(e.path);
    }
    return true;
  });
  handle('sftp:readFile', async (connId, p, maxBytes = 2 * 1024 * 1024) => {
    const s = await requireConn(connId).getSftp();
    const st = await s.stat(p);
    if ((st.size ?? 0) > maxBytes) throw new Error(`File is too large to preview (${st.size} bytes)`);
    const h = await s.open(p, 1 /* READ */);
    try {
      const chunks = [];
      let off = 0;
      for (;;) {
        const d = await s.readChunk(h, off, s.maxRead);
        if (!d || !d.length) break;
        chunks.push(d); off += d.length;
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await s.close(h).catch(() => {}); }
  });
  handle('sftp:writeFile', async (connId, p, content) => {
    const s = await requireConn(connId).getSftp();
    const buf = Buffer.from(content, 'utf8');
    const h = await s.open(p, 2 | 8 | 16 /* WRITE|CREAT|TRUNC */);
    try {
      let off = 0;
      while (off < buf.length) {
        const end = Math.min(off + s.maxWrite, buf.length);
        await s.writeChunk(h, off, buf.subarray(off, end));
        off = end;
      }
    } finally { await s.close(h).catch(() => {}); }
    return true;
  });

  /* --- local files --- */
  handle('local:home', async () => os.homedir());
  handle('local:shortcuts', async () => local.shortcuts());
  handle('local:existingDirs', async (paths) => local.existingDirs(paths || []));
  handle('local:search', async (opts) => findfiles.searchLocal(opts || {}));
  /**
   * The same search on a server, over the connection already open.
   *
   * `find -printf` is GNU-only, so a run that comes back with nothing is
   * tried again in the portable form before reporting an empty result — a
   * BSD or busybox host should answer the question too, just with less
   * detail.
   */
  handle('sftp:search', async (connId, opts) => {
    const conn = requireConn(connId);
    const cmd = findfiles.remoteCommand(opts || {});
    let out = await conn.exec(cmd).catch((e) => { throw new Error(e.message); });
    let parsed = findfiles.parseRemote(out, opts || {});
    if (!parsed.results.length && !opts?.content) {
      out = await conn.exec(findfiles.remoteCommandPlain(opts || {})).catch(() => '');
      parsed = findfiles.parseRemote(out, opts || {});
    }
    return { ...parsed, where: opts?.dir || '', command: cmd };
  });
  /*
   * The 3D view's measurements: what is under each folder of a directory,
   * by size and by kind of file. One walk here, one find|awk on a server.
   */
  handle('city:scanLocal', async (dir) => cityscan.scanLocal(dir));
  handle('city:scanRemote', async (connId, dir) => {
    const conn = requireConn(connId);
    const out = await conn.exec(cityscan.remoteCommand(dir)).catch((e) => { throw new Error(e.message); });
    return cityscan.parseRemote(out, dir);
  });
  handle('city:procsLocal', async () => procscan.scanLocal());
  handle('city:procsRemote', async (connId) => {
    const conn = requireConn(connId);
    const out = await conn.exec(procscan.remoteCommand()).catch((e) => { throw new Error(e.message); });
    return procscan.parse(out);
  });
  handle('local:list', async (dir) => {
    const target = dir && dir !== '~' ? dir : os.homedir();
    return { path: target, entries: await local.list(target) };
  });
  handle('local:mkdir', async (p) => { await local.ensureDir(p); return true; });
  handle('local:remove', async (paths) => { for (const p of paths) await local.removeEntry(p); return true; });
  handle('local:rename', async (a, b) => { await fsp.rename(a, b); return true; });
  handle('local:reveal', async (p) => { shell.showItemInFolder(p); return true; });
  handle('local:open', async (p) => { await shell.openPath(p); return true; });

  /**
   * A local file as text, for the same editor the remote side gets.
   *
   * Capped, and checked for being text at all. A textarea handed four
   * megabytes of ELF is a hung window and a mangled file if it is then saved,
   * so both are refused here with a reason rather than left to the renderer
   * to notice.
   */
  handle('local:readText', async (p, opts) => {
    const max = Math.min(Number(opts?.max) || 2 * 1024 * 1024, 16 * 1024 * 1024);
    const st = await fsp.stat(p);
    if (!st.isFile()) throw new Error('That is not a file.');
    if (st.size > max) {
      const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
      throw new Error(`${mb(st.size)} is too large to edit here — the limit is `
        + `${mb(max)}. Open it with an application instead.`);
    }
    const buf = await fsp.readFile(p);
    /*
     * A NUL byte in the first few kilobytes is the oldest test there is and
     * still the right one: no text encoding this editor can save uses them,
     * and every binary format has them early.
     */
    const head = buf.subarray(0, 8000);
    if (head.includes(0)) {
      throw new Error('This looks like a binary file, not text.');
    }
    return { text: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
  });

  handle('local:writeText', async (p, text) => {
    await fsp.writeFile(p, String(text ?? ''), 'utf8');
    return true;
  });

  /**
   * Open a local file with a named application.
   *
   * macOS has a verb for this — `open -a` resolves an application bundle and
   * hands it the file — so it is used directly rather than through
   * `shell.openPath`, which only ever opens the *default* handler. Elsewhere
   * the chosen thing is simply run with the path as its argument, which is
   * what "open with" means on those platforms anyway.
   *
   * An argument array, never a shell: these are paths, and a path can contain
   * anything.
   */
  handle('local:openWith', async (filePath, appPath) => {
    if (!filePath || !appPath) throw new Error('A file and an application are needed.');
    await fsp.access(filePath);
    const [file, args] = process.platform === 'darwin'
      ? ['/usr/bin/open', ['-a', appPath, filePath]]
      : [appPath, [filePath]];
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 20000 }, (err, _out, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').trim() || 'Could not open it.'));
        resolve(true);
      });
    });
  });

  /** Pick an application. On macOS a bundle is a file, so this selects one. */
  handle('dialog:chooseApp', async () => {
    const r = await dialog.showOpenDialog(dialogParent(), {
      title: 'Choose an application',
      properties: ['openFile'],
      defaultPath: process.platform === 'darwin' ? '/Applications' : undefined,
      filters: process.platform === 'darwin' ? [{ name: 'Applications', extensions: ['app'] }] : undefined,
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('local:parent', async (p) => local.parentOf(p));
  handle('local:info', async (p) => local.info(p));
  handle('local:treeSize', async (p) => local.treeSize(p));
  handle('local:diskSpace', async (p) => local.diskSpace(p));

  /* --- transfers --- */
  /*
   * Uploads/downloads show up — and can be cancelled — the moment they're
   * asked for, not once the whole directory tree has been walked and
   * stat'd. addPlanning() puts a placeholder job in the queue (and in
   * front of the user) immediately; the walk runs in the background and
   * finishPlanning()/failPlanning() turn it into a real job once it's
   * done, same "return an id now, stream the rest via push events" shape
   * multiexec:run already uses. A cancel mid-walk aborts `signal`, which
   * planUpload()/planDownload() check between directories — the walk's own
   * PlanCancelled is swallowed here since cancel() has already marked the
   * job cancelled; anything else becomes a visible error row, the same as
   * a failed byte-transfer already is.
   */
  handle('xfer:upload', async (connId, localPaths, remoteDir) => {
    const c = requireConn(connId);
    await c.getSftp();
    const label = localPaths.length === 1
      ? path.basename(localPaths[0])
      : `${localPaths.length} items`;
    const { id, signal } = c.queue.addPlanning({ kind: 'upload', label: `${label} → ${remoteDir}` });
    (async () => {
      try {
        const items = [];
        const dirs = [];
        for (const lp of localPaths) {
          const plan = await planUpload(lp, remoteDir, signal);
          items.push(...plan.files);
          dirs.push(...plan.dirs);
        }
        c.queue.finishPlanning(id, { items, dirs });
      } catch (err) {
        if (!(err instanceof PlanCancelled)) c.queue.failPlanning(id, err.message);
      }
    })();
    return id;
  });

  handle('xfer:download', async (connId, remoteEntries, localDir) => {
    const c = requireConn(connId);
    const s = await c.getSftp();
    const label = remoteEntries.length === 1
      ? (remoteEntries[0].name || path.posix.basename(remoteEntries[0].path))
      : `${remoteEntries.length} items`;
    const { id, signal } = c.queue.addPlanning({ kind: 'download', label: `${label} → ${localDir}` });
    (async () => {
      try {
        const items = [];
        const dirs = [];
        for (const e of remoteEntries) {
          const plan = await planDownload(s, e.path, localDir, e, signal);
          items.push(...plan.files);
          dirs.push(...plan.dirs);
        }
        c.queue.finishPlanning(id, { items, dirs, roots: remoteEntries.map((e) => e.path).filter(Boolean) });
      } catch (err) {
        if (!(err instanceof PlanCancelled)) c.queue.failPlanning(id, err.message);
      }
    })();
    return id;
  });

  /** Which route a server-to-server copy would take, without starting it. */
  handle('xfer:crossPlan', async (srcConnId, destConnId) =>
    crosstransfer.planRoute(requireConn(srcConnId), requireConn(destConnId)));

  handle('xfer:cross', async (srcConnId, entries, destConnId, destDir, opts) => {
    const src = requireConn(srcConnId);
    const dest = requireConn(destConnId);
    if (src.id === dest.id) throw new Error('Source and destination are the same session');
    await Promise.all([src.connect(), dest.connect()]);
    return crosstransfer.transfer({
      srcConn: src, destConn: dest, entries, destDir, mode: opts?.mode,
    });
  });

  /* --- directory synchronisation --- */

  /**
   * What a sync would do, without doing any of it. Both trees are walked and
   * compared; the renderer shows the result and hands back whichever actions
   * survive the review.
   */
  handle('sync:plan', async (connId, opts) => {
    const c = requireConn(connId);
    const sftp = await c.getSftp();
    return syncdirs.plan(sftp, opts || {});
  });

  /**
   * Apply a reviewed plan. Transfers go through the connection's own queue, so
   * a sync is visible, cancellable and rate-reported like anything else.
   * Deletions are done here and counted back, since there is no queue for
   * "remove this".
   */
  handle('sync:apply', async (connId, planned, actions) => {
    const c = requireConn(connId);
    const list = Array.isArray(actions) ? actions : (planned?.actions || []);
    return applySyncPlan(c, planned, list);
  });

  /* --- watched directories and remote edits --- */

  const watchEvent = () => send('watch:update', watchdirs.list());

  handle('watch:list', async () => watchdirs.list());
  handle('watch:dir', async (connId, opts) => {
    const c = requireConn(connId);
    const r = watchdirs.watchDir({
      connId,
      label: c.label,
      localDir: opts?.localDir,
      remoteDir: opts?.remoteDir,
      getSftp: () => c.getSftp(),
      onEvent: () => watchEvent(),
    });
    watchEvent();
    return r;
  });
  handle('watch:edit', async (connId, remotePath) => {
    const c = requireConn(connId);
    const r = await watchdirs.editRemote({
      connId,
      label: c.label,
      remotePath,
      getSftp: () => c.getSftp(),
      // The editor the OS already associates with the file type, unless the
      // user has named one — a preference that exists because "open in my
      // editor" means a specific editor to most people.
      open: async (p) => {
        const cmd = String(store.settings.externalEditor || '').trim();
        if (!cmd) {
          const err = await shell.openPath(p);
          if (err) throw new Error(err);
          return;
        }
        // Split on spaces so `code -w` and `subl` both work; the path is
        // passed as its own argument and never through a shell.
        const parts = cmd.split(/\s+/).filter(Boolean);
        spawn(parts[0], [...parts.slice(1), p], { detached: true, stdio: 'ignore' }).unref();
      },
      onEvent: () => watchEvent(),
    });
    watchEvent();
    return r;
  });
  handle('watch:stop', async (id) => {
    const r = await watchdirs.stop(id);
    watchEvent();
    return r;
  });

  handle('xfer:list', async (connId) => requireConn(connId).queue.view());
  handle('xfer:cancel', async (connId, jobId) => { requireConn(connId).queue.cancel(jobId); return true; });
  handle('xfer:clear', async (connId) => { requireConn(connId).queue.clearFinished(); return true; });
  handle('xfer:pause', async (connId, jobId) => { requireConn(connId).queue.pause(jobId); return true; });
  handle('xfer:resume', async (connId, jobId) => { requireConn(connId).queue.resume(jobId); return true; });
  handle('xfer:pauseAll', async (connId) => { requireConn(connId).queue.pauseAll(); return true; });
  handle('xfer:resumeAll', async (connId) => { requireConn(connId).queue.resumeAll(); return true; });
  handle('xfer:retry', async (connId, jobId) => { requireConn(connId).queue.retry(jobId); return true; });
  handle('xfer:move', async (connId, jobId, delta) => { requireConn(connId).queue.move(jobId, delta); return true; });
  /*
   * The speed limit is a preference, so it is applied to every queue — the one
   * being changed and any other connection that is already open.
   */
  handle('xfer:limit', async (kbPerSecond) => {
    const bytes = Math.max(0, Number(kbPerSecond) || 0) * 1024;
    store.updateSettings({ transferLimitKb: Math.round(bytes / 1024) });
    for (const c of manager.list()) {
      const conn = manager.get(c.id);
      if (conn?.queue) conn.queue.setLimit(bytes);
    }
    return store.settings.transferLimitKb;
  });

  /* --- multi-exec --- */
  handle('multiexec:run', async (connIds, command, opts) => multiexec.run(connIds, command, opts || {}));
  handle('multiexec:cancel', async (runId) => { multiexec.cancel(runId); return true; });
  handle('multiexec:decide', async (runId, choice) => { multiexec.decide(runId, choice); return true; });
  handle('multiexec:answer', async (runId, connId, data) => { multiexec.answer(runId, connId, data); return true; });
  handle('multiexec:list', async () => multiexec.list());
  handle('multiexec:clear', async () => { multiexec.clear(); return true; });
  handle('multiexec:history', async () => store.listExecRuns());
  handle('multiexec:historyAdd', async (rec) => { store.addExecRun(rec); return store.listExecRuns(); });
  handle('multiexec:historyDelete', async (id) => { store.deleteExecRun(id); return store.listExecRuns(); });
  handle('multiexec:historyClear', async () => { store.clearExecRuns(); return store.listExecRuns(); });

  /* --- ansible export --- */
  handle('ansible:build', async (targets, command, opts) => ansible.build(targets, command, opts || {}));
  handle('ansible:suggestName', async (command) => ansible.suggestFolderName(command));
  handle('ansible:save', async (targets, command, opts) => {
    const bundle = ansible.build(targets, command, opts || {});
    let dir = opts?.dir;
    if (!dir) {
      const r = await dialog.showOpenDialog(dialogParent(), {
        title: 'Choose a folder for the Ansible bundle',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Export here',
      });
      if (r.canceled) return null;
      dir = path.join(r.filePaths[0], ansible.exportFolderName(opts?.folderName));
    }
    /*
     * An earlier export by the same name is not overwritten unasked: its
     * playbook may have been edited since. The window is told, asks, and
     * comes back with the folder and `overwrite`.
     */
    if (!opts?.overwrite) {
      try {
        if (fs.readdirSync(dir).length) return { exists: true, dir };
      } catch { /* not there yet: nothing to overwrite */ }
    }
    const res = await ansible.write(dir, bundle, { teleport });
    if (opts?.reveal !== false) shell.showItemInFolder(path.join(res.dir, 'playbook.yml'));
    return res;
  });

  /* --- dialogs & misc --- */
  /*
   * `packages`: let the picker open a macOS .app as the folder it is, for
   * choosing the binary inside one — tsh lives at tsh.app/Contents/MacOS/tsh,
   * and copied out of the bundle it fails its signature and is killed on
   * launch. Otherwise the Mac picker treats a bundle as one file. `single` for
   * a choice of one; `title` to say what is being chosen.
   */
  handle('dialog:openFiles', async (opts = {}) => {
    const r = await dialog.showOpenDialog(dialogParent(), {
      ...(opts?.title ? { title: opts.title, message: opts.title } : {}),
      properties: [
        'openFile',
        ...(opts?.single ? [] : ['multiSelections']),
        ...(opts?.packages ? ['treatPackageAsDirectory'] : []),
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:openDirs', async () => {
    const r = await dialog.showOpenDialog(dialogParent(), { properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  /**
   * Write text somewhere the user picks. Used for a response body, a header
   * dump, a tool's output — anything worth keeping out of a dialog that is
   * about to be closed.
   */
  handle('dialog:saveText', async ({ text, defaultPath, title } = {}) => {
    const r = await dialog.showSaveDialog(dialogParent(), {
      title: title || 'Save output',
      defaultPath: defaultPath || path.join(app.getPath('downloads'), 'output.txt'),
    });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, String(text ?? ''), 'utf8');
    return { path: r.filePath, bytes: Buffer.byteLength(String(text ?? '')) };
  });

  handle('dialog:chooseDir', async (defaultPath) => {
    const r = await dialog.showOpenDialog(dialogParent(), { properties: ['openDirectory', 'createDirectory'], defaultPath });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:confirm', async ({ title, message, detail, confirmLabel }) => {
    const r = await dialog.showMessageBox(dialogParent(), {
      type: 'warning',
      buttons: [confirmLabel || 'OK', 'Cancel'],
      defaultId: 1, cancelId: 1,
      title: title || 'Confirm', message: message || '', detail: detail || '',
    });
    return r.response === 0;
  });
  handle('clipboard:write', async (text) => { clipboard.writeText(text); return true; });
  handle('clipboard:read', async () => clipboard.readText());
}

/**
 * Turn a finished transfer into rows for the downloads list.
 *
 * Only downloads: an upload leaves nothing on this machine to go and find.
 * A flat selection of files is remembered file by file, which is what makes
 * "open the one I pulled down" possible; a folder is remembered as the folder,
 * because a tree of two thousand files is one gesture and would otherwise bury
 * everything else. The per-job cap is the same idea for a very wide selection.
 */
function recordDownloads(job) {
  if (!job || job.kind !== 'download') return [];
  const items = (job.items || []).filter((i) => i && i.local);
  if (!items.length) return [];
  const rows = [];

  /*
   * Downloading a directory brings its local directories with it, so the
   * top-level ones — those with no other local dir above them — are the
   * folders that were asked for. One selection can hold both folders and
   * loose files, so both are recorded: a row per folder, then a row per file
   * that is not inside one of them.
   */
  const dirs = [...new Set(job.dirs || [])].sort((a, b) => a.length - b.length);
  const tops = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + path.sep)));

  for (const top of tops) {
    // The remote folder as it was asked for; the first file's own directory
    // would name whichever leaf the walk happened to reach first.
    const source = (job.roots || []).find((r) => path.posix.basename(r) === path.basename(top))
      || (tops.length === 1 ? (job.roots || [])[0] : '')
      || '';
    const inside = items.filter((i) => i.local.startsWith(top + path.sep));
    const row = store.addDownload({
      localPath: top,
      name: path.basename(top),
      source,
      from: job.from || '',
      kind: 'folder',
      bytes: inside.reduce((a, b) => a + (b.size || 0), 0),
      files: inside.length,
    });
    if (row) rows.push(row);
  }

  // Loose files, capped: a very wide selection is still a list to read.
  const loose = items.filter((i) => !tops.some((t) => i.local.startsWith(t + path.sep)));
  for (const i of loose.slice(0, 20)) {
    const row = store.addDownload({
      localPath: i.local,
      name: path.basename(i.local),
      source: i.remote || '',
      from: job.from || '',
      kind: 'file',
      bytes: i.size || 0,
      files: 1,
    });
    if (row) rows.push(row);
  }
  return rows;
}

function wireEvents() {
  manager.on('conn:state', (id, payload) => send('conn:state', id, payload));
  manager.on('conn:log', (id, payload) => send('conn:log', id, payload));
  manager.on('conn:info', (id, payload) => send('conn:info', id, payload));
  manager.on('conn:monitor', (id, payload) => send('conn:monitor', id, payload));
  // Waking from sleep is when the GPU's glyph caches are most often stale: every terminal repaints.
  powerMonitor.on('resume', () => send('app:resume'));
  powerMonitor.on('unlock-screen', () => send('app:resume'));
  manager.on('conn:transfers', (id, payload) => send('xfer:update', id, payload));
  manager.on('conn:xferdone', (id, job) => {
    const rows = recordDownloads(job);
    if (rows.length) send('downloads:update', store.listDownloads());
  });
  manager.on('conn:forwards', (id, payload) => send('forward:update', id, payload));
  manager.on('conn:logging', (id, payload) => send('term:logging', id, payload));
  manager.on('conn:serverinfo', (id, payload) => send('conn:serverInfo', id, payload));
  manager.on('conn:terminal-data', (id, payload) => send('term:data', id, payload));
  manager.on('conn:terminal-exit', (id, payload) => send('term:exit', id, payload));
  manager.on('conn:exec-data', (id, payload) => send('exec:data', id, payload));
  manager.on('conn:exec-prompt', (id, payload) => send('exec:prompt', id, payload));
  manager.on('changed', () => send('conn:changed', manager.list()));

  multiexec.on('update', (v) => send('multiexec:update', v));
  multiexec.on('done', (v) => send('multiexec:done', v));
  vnet.on('state', (v) => send('vnet:state', v));

  localTerms.on('data', (p) => send('localterm:data', p));
  localTerms.on('exit', (p) => send('localterm:exit', p));

  devices.on('data', (p) => send('device:data', p));
  devices.on('exit', (p) => send('device:exit', p));
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  await store.load();
  if (store.settings.tshPath) teleport.setTshPath(store.settings.tshPath);
  applyTshEnv(store.settings);
  if (store.settings.sshPath) sshbin.setSshPath(store.settings.sshPath);

  control = new ControlServer({
    dir: app.getPath('userData'),
    handle: handleControl,
    onLog: (entry) => send('control:activity', { at: Date.now(), text: entry.text }),
  });
  // Off unless the user has turned it on: something that can open sessions on
  // request should not appear because the app was installed.
  if (store.settings.controlSocket) {
    // The terminal that launched the app is the only place this can be said.
    // eslint-disable-next-line no-console
    control.start().catch((e) => console.error('control socket:', e.message));
  }
  teleport.setHomes(store.settings.tshHomes || []);
  manager = new ConnectionManager();
  multiexec = new MultiExec(manager);
  localTerms = new local.LocalTerminals();
  devices = new DeviceSessions();
  vnc = new VncBridge();

  registerIpc();
  wireEvents();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Every live remote session in every window, as `{ kind, name }`.
 *
 * The windows are asked, because panes are theirs and only they know which
 * are dead. A window that does not answer within a second and a half is
 * hung, or busy enough that it may as well be, and a hung window must not be
 * able to hold the quit hostage. So if any of them stays quiet, the answer
 * comes from what this process has open instead — connections that are up,
 * consoles, VNC bridges — which is coarser (it cannot tell a shell that has
 * exited from one that has not) but errs on the side of asking.
 */
async function liveSessionsForQuit() {
  const wins = [...windows.values()].filter((w) => !w.isDestroyed());
  const answers = await Promise.all(wins.map((win) => askRenderer('quit_census', {}, { win, timeout: 1500 })
    .then((r) => (Array.isArray(r?.sessions) ? r.sessions : null))
    .catch(() => null)));
  if (answers.every(Boolean)) return answers.flat();

  const out = [];
  for (const c of manager?.list() || []) {
    if (c.state === 'connected') out.push({ kind: c.type === 'teleport' ? 'teleport' : 'ssh', name: c.label || c.target || 'remote session' });
  }
  for (const s of devices?.sessions?.values() || []) out.push({ kind: s.kind || 'console', name: s.label || 'console' });
  for (const s of vnc?.sessions?.values() || []) out.push({ kind: 'vnc', name: `${s.host}:${s.port}` });
  return out;
}

/**
 * Resolves true to go ahead and quit.
 *
 * Nothing open, or the setting turned off, and it says yes without showing
 * anything — the quit is exactly what it was before this existed. Otherwise a
 * native question, Cancel the default, because the button Return presses
 * should be the one that loses nothing.
 */
async function confirmQuit() {
  if (quitConfirmed) return true;
  if (store?.settings?.confirmQuitWithSessions === false) return true;
  const live = await liveSessionsForQuit().catch(() => []);
  if (!live.length) return true;

  // The same host open in three panes is one name in the list, said once.
  const counts = new Map();
  for (const s of live) counts.set(s.name, (counts.get(s.name) || 0) + 1);
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} (×${n})` : name));
  const shown = names.slice(0, 6);
  const more = names.length - shown.length;
  const n = live.length;

  /*
   * A sheet on a window that is hidden or minimised is a question nobody can
   * see, and a quit that silently never happens. Those get a free-standing
   * dialog instead.
   */
  const parent = dialogParent();
  const visible = parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized();
  const opts = {
    type: 'warning',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Quit ServerLife?',
    message: `${n} session${n === 1 ? ' is' : 's are'} still open.`,
    detail: shown.join('\n') + (more > 0 ? `\n…and ${more} more` : '')
      + '\n\nQuitting disconnects ' + (n === 1 ? 'it' : 'them') + '.'
      // The one kind that survives, said only when there is one to survive.
      + (live.some((s) => s.kind === 'tmux') ? ' tmux sessions are detached and keep running on the server.' : ''),
  };
  if (!visible) app.focus({ steal: true });
  const r = visible ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  if (r.response !== 0) return false;
  quitConfirmed = true;
  return true;
}

app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  if (quitAsking) return;
  quitAsking = true;
  let go = true;
  try { go = await confirmQuit(); } catch { go = true; } finally { quitAsking = false; }
  if (!go) return;
  quitting = true;
  try {
    localTerms.closeAll();
    /*
     * Detaching rather than killing: the point of these sessions is that they
     * outlive the client, and quitting the app is the commonest way a client
     * goes away.
     */
    for (const [, s] of tmuxSessions) { try { s.close(); } catch { /* quitting anyway */ } }
    tmuxSessions.clear();
    devices?.closeAll();
    vnc?.releaseAll();
    awsproxy.stopAll();
    kubeproxy.stopAll();
    kubelogs.stopAll();
    kubewatch.stopAll();
    kubemetrics.stopAll();
    // VNet changed this machine's network setup; Ctrl-C lets tsh undo it.
    vnet.stopAll();
    await store.saveNow().catch(() => {});
    await manager.shutdown();
  } finally {
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
