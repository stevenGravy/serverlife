import { uid } from './util.js';

/**
 * Central renderer state. Everything the UI draws comes from here, and every
 * mutation goes through a method that notifies subscribers, so views never
 * have to guess when to redraw.
 */
class State extends EventTarget {
  constructor() {
    super();
    this.settings = {};
    this.appInfo = {};
    /** Which window this renderer is, and how many are open. */
    this.windowInfo = { slot: 'w1', count: 1 };

    /** Discovered inventory. */
    this.sshHosts = [];
    this.teleportProfiles = [];
    this.savedLogins = [];            // saved clusters, for the ones pinned to the Hosts tab
    this.teleportNodes = new Map();   // profile key (see tpKey) -> nodes[]
    /**
     * Trusted clusters behind each profile: root plus leaves, as `tsh clusters`
     * reports them. A profile names one cluster; this is the set it can be
     * pointed at.
     */
    this.teleportClusters = new Map(); // profile key (see tpKey) -> clusters[]
    this.teleportError = null;
    /** What the last status read knew about the tsh binary itself. */
    this.tshInfo = null;
    /** tsh and ssh as the main process last found them. */
    this.toolInfo = null;
    this.loadingInventory = false;

    /** Saved profiles. */
    this.profiles = [];
    this.folders = [];

    /** Macros: built-in commands plus the user's own, for running on a host. */
    this.macros = [];
    this.macroCategoryOrder = [];
    /** Macro ids in the order they were dragged into. */
    this.macroOrder = [];
    /** Macros promoted to a button in each session header: [{id, icon}]. */
    this.macroPins = [];

    /** Registered S3 buckets, offered as a source in every file explorer. */
    this.s3Targets = [];

    /** Live connections, keyed by connId. */
    this.connections = new Map();

    /** Tabs (sessions) and panes. */
    this.tabs = [];          // {id, title, kind, connId, root}
    this.panes = new Map();  // paneId -> {id, tabId, kind, connId, termId, view, title, element}
    this.activeTabId = null;
    this.activePaneId = null;

    /** Multi-exec selection + broadcast typing. */
    this.checkedHosts = new Set();   // host ids from the sidebar
    this.broadcast = false;

    /** File browser view state, per connection. */
    this.remoteState = new Map();    // connId -> {path, history, hIndex, entries, selection}
    this.localView = { path: null, history: [], hIndex: -1, entries: [], selection: new Set() };
    this.followTerminal = true;
    this.showHidden = false;
    /** Permissions and owner as columns in the file lists. */
    this.showFileDetails = false;

    this.transfers = new Map();      // connId -> job[]
    this.forwards = new Map();       // connId -> forward[]
    this.multiRuns = [];
    /** Live watches: mirrored folders and remote files open in an editor. */
    this.watches = [];
  }

  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  /*
   * The returned unsubscribe used to call `removeEventListener(name, fn)`
   * — but `fn` was never what got added; the wrapper that reads
   * `e.detail` was. `removeEventListener` only drops a listener that is
   * the exact same function reference as one already added, so that
   * unsubscribe silently did nothing, every time, for every caller that
   * ever stored and later called it (the folder browser among them) —
   * each left its listener live and still firing after the view that
   * subscribed it believed it had let go.
   */
  on(name, fn) {
    const wrapped = (e) => fn(e.detail);
    this.addEventListener(name, wrapped);
    return () => this.removeEventListener(name, wrapped);
  }

  /* ---------------- connections ---------------- */

  setConnection(id, patch) {
    const prev = this.connections.get(id) || { id };
    const next = { ...prev, ...patch };
    this.connections.set(id, next);
    this.emit('connections', next);
    return next;
  }

  getConnection(id) { return this.connections.get(id); }

  removeConnection(id) {
    this.connections.delete(id);
    this.remoteState.delete(id);
    this.transfers.delete(id);
    this.emit('connections', null);
  }

  /* ---------------- tabs & panes ---------------- */

  createTab({ title, kind, connId }) {
    const tab = { id: uid('tab'), title, kind, connId, root: null };
    this.tabs.push(tab);
    this.emit('tabs');
    return tab;
  }

  getTab(id) { return this.tabs.find((t) => t.id === id); }

  removeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.activeTabId === id) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activeTabId = next ? next.id : null;
      this.activePaneId = next ? this.firstPaneOf(next) : null;
    }
    this.emit('tabs');
  }

  setActiveTab(id) {
    if (this.activeTabId === id) return;
    this.activeTabId = id;
    const tab = this.getTab(id);
    /*
     * Back to the pane you were last in, not to the first one.
     *
     * A tab split three ways, with your work in the right-hand pane: coming
     * back to it used to drop you in the left one, so the next thing typed
     * went to the wrong server. The tab remembers instead, and falls back to
     * the first pane only when what it remembers has since been closed.
     */
    const remembered = tab?.lastPaneId;
    const stillThere = remembered && this.panes.get(remembered)?.tabId === id;
    this.activePaneId = tab ? (stillThere ? remembered : this.firstPaneOf(tab)) : null;
    this.emit('tabs');
    this.emit('activePane');
  }

  firstPaneOf(tab) {
    const walk = (node) => {
      if (!node) return null;
      if (node.type === 'pane') return node.paneId;
      for (const c of node.children) { const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(tab.root);
  }

  panesOf(tabId) {
    const tab = this.getTab(tabId);
    if (!tab) return [];
    const out = [];
    const walk = (node) => {
      if (!node) return;
      if (node.type === 'pane') { out.push(node.paneId); return; }
      node.children.forEach(walk);
    };
    walk(tab.root);
    return out;
  }

  addPane(pane) {
    this.panes.set(pane.id, pane);
    this.emit('panes');
    return pane;
  }

  getPane(id) { return this.panes.get(id); }

  /**
   * Take a pane out of its tab's layout without destroying it.
   *
   * `removePane` is for a pane that is going away and tears down its terminal
   * with it. This is for one that is *moving*: the pane object, its view, its
   * element and the session running inside it all survive, and only its place
   * in the tree changes — so whatever is running never notices.
   *
   * The caller owns it afterwards and must give it a new home, or it is a
   * pane in `panes` that no tab draws.
   */
  detachPane(id) {
    const pane = this.panes.get(id);
    if (!pane) return null;
    const tab = this.getTab(pane.tabId);
    if (tab) tab.root = removeFromTree(tab.root, id);
    this.emit('panes');
    return pane;
  }

  removePane(id) {
    const pane = this.panes.get(id);
    if (!pane) return null;
    this.panes.delete(id);
    // Its activity record goes with it, or a closed pane keeps a tab
    // looking busy forever. Imported lazily: state is the bottom of the
    // import graph and everything else is allowed to depend on it.
    import('./activity.js').then((m) => m.forgetPane(id)).catch(() => {});
    const tab = this.getTab(pane.tabId);
    if (tab) tab.root = removeFromTree(tab.root, id);
    this.emit('panes');
    return pane;
  }

  setActivePane(id) {
    if (this.activePaneId === id) return;
    this.activePaneId = id;
    const pane = this.panes.get(id);
    /*
     * A pane outside every tab — an assistant in the AI panel — leaves the
     * active tab alone. It used to become "no tab", which nothing showed while
     * the panel was open, and closing the panel then drew that: a blank
     * workspace until a tab was picked again.
     */
    if (pane?.tabId && pane.tabId !== this.activeTabId) this.activeTabId = pane.tabId;
    // So the tab can put you back here when you come back to it.
    const tab = pane ? this.getTab(pane.tabId) : null;
    if (tab) tab.lastPaneId = id;
    this.emit('activePane', pane);
  }

  get activePane() { return this.panes.get(this.activePaneId) || null; }

  /** The connection backing the focused pane — what the file browser follows. */
  get activeConnId() {
    const p = this.activePane;
    return p && p.kind === 'remote' ? p.connId : null;
  }

  /* ---------------- file browser ---------------- */

  remoteView(connId) {
    if (!connId) return null;
    if (!this.remoteState.has(connId)) {
      this.remoteState.set(connId, {
        path: null, history: [], hIndex: -1, entries: [], selection: new Set(), error: null, loading: false,
        // Tree navigation: which directories are expanded, and their cached
        // listings so collapsing and re-expanding costs nothing.
        expanded: new Set(), children: new Map(), loadingPaths: new Set(),
      });
    }
    return this.remoteState.get(connId);
  }
}

function removeFromTree(node, paneId) {
  if (!node) return null;
  if (node.type === 'pane') return node.paneId === paneId ? null : node;
  const children = node.children.map((c) => removeFromTree(c, paneId)).filter(Boolean);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/**
 * The key a Teleport profile's node list is stored under.
 *
 * Two tsh homes can hold the same cluster under different identities, so the
 * cluster name alone is not an identity. A profile in the default home keeps
 * the bare cluster name, which is what every stored setting already refers to.
 */
export function tpKey(p) {
  const cluster = p?.cluster || p?.proxy || '';
  return p?.home ? `${cluster}@@${p.home}` : cluster;
}

export function paneNode(paneId) { return { type: 'pane', paneId }; }

/** Exchange two panes' places in the layout, leaving the shape alone. */
export function swapPanes(node, a, b) {
  if (!node) return null;
  if (node.type === 'pane') {
    if (node.paneId === a) return paneNode(b);
    if (node.paneId === b) return paneNode(a);
    return node;
  }
  return { ...node, children: node.children.map((c) => swapPanes(c, a, b)) };
}

/**
 * Pull a pane out of wherever it sits and lay it along the whole edge of the
 * tab — what "move it further left" has to mean once there is nothing left of
 * it to trade places with.
 */
export function movePaneToEdge(root, paneId, dir) {
  const rest = removeFromTree(root, paneId);
  if (!rest) return root;
  const axis = dir === 'left' || dir === 'right' ? 'row' : 'col';
  const first = dir === 'left' || dir === 'up';
  return { type: 'split', dir: axis, children: first ? [paneNode(paneId), rest] : [rest, paneNode(paneId)] };
}

/** Replace `paneId` with a split containing it plus a new pane. */
export function splitTree(node, paneId, newPaneId, dir) {
  if (!node) return null;
  if (node.type === 'pane') {
    if (node.paneId !== paneId) return node;
    return { type: 'split', dir, children: [paneNode(paneId), paneNode(newPaneId)] };
  }
  return { ...node, children: node.children.map((c) => splitTree(c, paneId, newPaneId, dir)) };
}

/**
 * Does opening a second channel on this session cost the user an approval?
 *
 * Every `tsh` session opens a channel per operation, and on a
 * per-session-MFA host each one is an approval — so the file browser waits
 * for a click rather than racing the terminal's prompt, which macOS
 * cancels when two dialogs appear at once.
 *
 * A duplicate hostname is deliberately *not* a reason to be here. Such a
 * node keeps the shared connection and is dialled by its UUID, so there is
 * no second channel and nothing to approve. If it also wants MFA it lands
 * on tsh like any other MFA host — through the same offer made when the
 * shared path is refused — and is gated exactly as it should be.
 */
export function needsMfaApproval(conn) {
  return conn?.transport === 'tsh';
}

export const state = new State();
