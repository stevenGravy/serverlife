import { state, paneNode, splitTree, swapPanes, movePaneToEdge } from './state.js';
import { decodeMenu } from './nettools.js';
import { TermView } from './term.js';
import { el, clear, $, uid, fmtDateTimeTz } from './util.js';
import { toast, status, contextMenu, modal, checkbox } from './ui.js';
import { liveSessionsIn } from './quitguard.js';
import { Explorer } from './explorer.js';
import { connectScene } from './connectanim.js';
import { playCloseAnimation, shouldAnimatePaneClose } from './paneclose.js';
import { pinnedMacros, macroKindOf } from './macros.js';
import { applyPaneStyle, paneStyleMenu } from './panestyle.js';
import { recordInput } from './macrorecord.js';
import { catchUpVisible } from './files.js';
import { noteOutput, forgetPane } from './activity.js';
import {
  highlightOn, rulesFor, compileRules, highlightChunk, newHighlightState,
  setHighlightForHost, openHighlightSettings, highlightSource,
} from './highlight.js';

/**
 * Session and pane orchestration: creating connections, opening terminals,
 * splitting panes, and routing keystrokes (including broadcast typing).
 */

const paneRoot = () => $('#panes');

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

/**
 * What the main process needs to dial a host descriptor.
 *
 * One place for it, because every way of opening a host — a tab, a split, a
 * connection on its own — has to send the same thing; a copy that forgot a
 * kind sent a beam off as an SSH alias that does not exist.
 */
export function connPayload(host) {
  if (host.type === 'beam') {
    // A beam is named, not addressed: `tsh beams ssh <name>` is the whole
    // target, and the proxy says which cluster's beam it is.
    return { type: 'beam', name: host.name, proxy: host.proxy, home: host.home || null };
  }
  if (host.type === 'teleport') {
    return {
      type: 'teleport', name: host.name, hostname: host.hostname, uuid: host.uuid,
      cluster: host.cluster, proxy: host.proxy, home: host.home || null,
      // Whether this hostname is shared with another node in the same
      // cluster. Without it the main process cannot know, and every
      // duplicate is dialled by a name that means two machines.
      ambiguous: !!host.ambiguous,
    };
  }
  return {
    type: 'ssh', alias: host.alias, name: host.name, direct: host.direct || null,
    // An alias from an extra config file is only findable with `ssh -F`.
    configFile: host.configFile || null, id: host.id,
    proxyJump: host.proxyJump || null,
  };
}

/**
 * Create (or reuse) a connection for a host descriptor, then open a session
 * tab for it. Returns the pane that was created.
 */
export async function openHost(host, { login, reuse = true, profileId, startupCommand, remoteStartPath, x11, transport, mfaMode, sshOptions, profileSshOptions, filesOnly = false } = {}) {
  // An X11 session needs its own connection: forwarding is negotiated on the
  // master, so it cannot be switched on for an already-open one. The same goes
  // for any SSH options given for this one opening — forwards, a jump host —
  // which `undefined` ("the host's own") does not ask for.
  // A profile's own ssh options need their own connection, the same as a one-off's.
  const existing = reuse && !x11 && !transport && sshOptions === undefined && !profileSshOptions ? findConnectionForHost(host, login) : null;
  let connId = existing?.id;

  if (!connId) {
    const created = await window.api.conn.create(connPayload(host), { login, x11, transport, mfaMode, sshOptions, profileSshOptions });
    connId = created.id;
    state.setConnection(connId, {
      id: connId, label: created.label, target: created.target,
      type: created.type, state: 'idle', hostId: host.id, login, x11: x11 || 'off',
      // A Teleport connection's own cluster/proxy/home, kept here rather than
      // only on the inventory row — so a failed reconnect can tell "this
      // cluster's session lapsed" from "this node wants per-session MFA"
      // without the inventory (which an expired or logged-out cluster may
      // not have listed this node in at all) ever being asked.
      cluster: host.type === 'teleport' ? host.cluster : null,
      proxy: host.type === 'teleport' ? host.proxy : null,
      home: host.type === 'teleport' ? (host.home || null) : null,
      // So a live profile-backed connection can be matched back to the
      // profile it came from (the Hosts-pane "Saved" group's "live" mark).
      profileId: profileId || null,
      /*
       * Two machines answering to one name also report one hostname when
       * they are two agents on the same box — so the shell's own title,
       * which is what a tab usually shows, is identical for both. The first
       * block of the node id is the only thing that differs, and a tab that
       * cannot be told from its neighbour is a tab you open to find out
       * which it was.
       */
      dupe: host.ambiguous && host.uuid ? String(host.uuid).slice(0, 8) : null,
      // The main process decides the final transport: with no OpenSSH client
      // a Teleport node is opened with tsh instead of what was asked for.
      transport: created.transport || transport || 'mux',
      transportForced: created.transportForced || null,
      noShell: !!created.noShell,
      forwards: created.forwards || [],
    });
    if (created.transportForced === 'no-ssh') {
      status('No ssh client here — opening with tsh ssh', 6000);
    } else if (created.transportForced === 'leaf') {
      status(`${host.cluster} is a leaf cluster — opening with tsh ssh`, 6000);
    } else if (host.ambiguous && host.uuid) {
      status(`Another node in ${host.cluster} is also called ${host.name} — `
        + `opening the one with id ${String(host.uuid).slice(0, 8)}`, 8000);
    }
  }

  const conn = state.getConnection(connId);
  const tab = state.createTab({ title: conn.label, kind: 'remote', connId });
  const pane = await createPane({ tabId: tab.id, kind: 'remote', connId });
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();

  /*
   * Files-only: the connection is dialled exactly as ever — it is the same
   * ControlMaster — but no terminal is opened on it. The pane becomes the file
   * browser, which is the whole tab.
   */
  if (filesOnly) {
    pane.filesOnly = true;
    pane.element.classList.add('files-only');
    setPaneExplorerVisible(pane, true);
    connectPane(pane, { remoteStartPath, noTerminal: true });
  } else if (conn.noShell) {
    /*
     * Forwarding only (-N): a tunnel, opened without the file browser. On a
     * per-session-MFA host the browser's own channel asks for a second
     * approval, which was the only prompt in sight — for files nobody opened
     * a tunnel to look at. tsh asks for the tunnel's approval in the pane.
     */
    setPaneExplorerVisible(pane, false);
    pane.forwardOnly = true;
    pane.view.writeln(`\x1b[90m[forwarding only (-N)${conn.forwards?.length ? ': ' + conn.forwards.join(', ') : ''}`
      + ' \u2014 no shell runs. Close the pane to stop the forwards.]\x1b[0m');
    connectPane(pane, { startupCommand, remoteStartPath });
  } else {
    applyOpensWithFiles(pane, host);
    connectPane(pane, { startupCommand, remoteStartPath });
  }
  if (profileId) window.api.profiles.markUsed(profileId).catch(() => {});
  return pane;
}

/**
 * A pane opens with its file browser, or without it, according to the host.
 *
 * The pane was built with the global preference already applied, because at
 * that point nothing knows which host it is for. This is the host's own
 * answer — its own setting, its cluster's, else that same global one — and it
 * is only ever applied to a pane that is being opened, so hiding the explorer
 * by hand and splitting the window does not fight the setting. A files-only
 * pane never comes through here: asking for the file browser outranks a
 * preference about whether to show it unasked.
 */
function applyOpensWithFiles(pane, host) {
  const { opensWithFiles } = sidebarHelpers();
  if (!opensWithFiles || !host) return;
  setPaneExplorerVisible(pane, opensWithFiles(host));
}

/**
 * A pane that lists hosts instead of running one.
 *
 * Built as an ordinary pane and then emptied of its session: the terminal
 * and the file explorer are hidden, no shell is started, and the pane's own
 * element gets the list instead. Doing it this way rather than inventing a
 * third kind of pane means every generic thing — splitting, closing, the
 * focus ring, the layout tree, the tab strip — goes on working without a
 * single `if` added to it, which is the same trade the files-only pane
 * already makes.
 */
export async function openHostsTab(title) {
  const tab = state.createTab({ title, kind: 'local', connId: null });
  const pane = await createPane({ tabId: tab.id, kind: 'local', connId: null });
  makeHostsPane(pane, title);
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();
  return pane;
}

/** Turn an ordinary pane into a hosts pane. */
export function makeHostsPane(pane, title) {
  pane.isHosts = true;
  pane.title = title || 'Hosts';
  pane.element.classList.add('hosts-pane');
  // The header was built for a shell and says "local"; this pane is not one.
  const name = pane.head?.querySelector('.pname');
  if (name) name.textContent = pane.title;
  setPaneExplorerVisible(pane, false);
  pane.hostsHost = el('div', { class: 'hp-root' });
  pane.body.append(pane.hostsHost);
  return pane;
}

/**
 * KubeLife's full-cluster browser, as a tab instead of a modal — the exact
 * same trick as a hosts pane (above): an ordinary pane, emptied of its
 * session, with its own root div for kubebrowser.js to render into. A
 * second, parallel function rather than teaching openHostsTab to take a
 * different body, since the two have nothing to do with each other beyond
 * both wanting "a pane that is not a session."
 */
export async function openKubeBrowserTab(title) {
  const tab = state.createTab({ title, kind: 'local', connId: null });
  const pane = await createPane({ tabId: tab.id, kind: 'local', connId: null });
  makeKubeBrowserPane(pane, title);
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();
  return pane;
}

/** Turn an ordinary pane into a KubeLife full-cluster-browser pane. */
export function makeKubeBrowserPane(pane, title) {
  pane.isKubeBrowser = true;
  pane.title = title || 'Kubernetes';
  pane.element.classList.add('kube-browser-pane');
  const name = pane.head?.querySelector('.pname');
  if (name) name.textContent = pane.title;
  setPaneExplorerVisible(pane, false);
  pane.kbpRoot = el('div', { class: 'kbp-root' });
  pane.body.append(pane.kbpRoot);
  return pane;
}

/**
 * The Log Viewer, as a tab — the same "pane with no session underneath,
 * its own root div" trick as the cluster browser just above, not a PTY
 * pane wearing a different title.
 */
export async function openKubeLogViewerTab(title) {
  const tab = state.createTab({ title, kind: 'local', connId: null });
  const pane = await createPane({ tabId: tab.id, kind: 'local', connId: null });
  makeKubeLogViewerPane(pane, title);
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();
  return pane;
}

/** Turn an ordinary pane into a KubeLife Log Viewer pane. */
export function makeKubeLogViewerPane(pane, title) {
  pane.isKubeLogViewer = true;
  pane.title = title || 'Logs';
  pane.element.classList.add('kube-log-viewer-pane');
  const name = pane.head?.querySelector('.pname');
  if (name) name.textContent = pane.title;
  setPaneExplorerVisible(pane, false);
  pane.klvRoot = el('div', { class: 'klv-root' });
  pane.body.append(pane.klvRoot);
  return pane;
}

/**
 * A connection to a host, without opening anything on it.
 *
 * `openHost` dials *and* builds a tab around what it dialled, which is right
 * for a shell and wrong for a tmux session: that needs the connection first
 * and decides what tabs to build afterwards, from what the far side says is
 * running. Reuses an open connection when there is one, exactly as a second
 * shell on the same host would.
 */
export async function ensureConnection(host, { login } = {}) {
  const existing = findConnectionForHost(host, login);
  if (existing) {
    if (existing.state !== 'connected') await connectWithRelogin(existing.id);
    return existing.id;
  }
  const created = await window.api.conn.create(connPayload(host), { login });
  state.setConnection(created.id, {
    id: created.id, label: created.label, target: created.target,
    type: created.type, state: 'idle', hostId: host.id, login,
    cluster: host.type === 'teleport' ? host.cluster : null,
    proxy: host.type === 'teleport' ? host.proxy : null,
    home: host.type === 'teleport' ? (host.home || null) : null,
    transport: created.transport || 'mux',
  });
  const info = await connectWithRelogin(created.id);
  state.setConnection(created.id, { state: 'connected', ...info });
  // Every new session asks the host afresh: Teleport may have been
  // installed — or removed entirely — since the last time it was asked.
  checkTeleportPresence(created.id, { refresh: true });
  return created.id;
}

/**
 * How long a login just performed here is trusted without doing it again.
 *
 * A manual "Retry" after a connect that still fails moments later — the
 * cluster's own session needing a beat before it is actually usable, not a
 * login that somehow did not take — is a fresh top-level call, with
 * nothing carried over from the one before it. Without this, every one of
 * those retries read as "not logged in" all over again and ran the whole
 * ceremony a second time, SSO browser round trip included, for a cluster
 * that had in fact just been logged into seconds ago.
 */
const RELOGIN_TRUST_MS = 15000;
const recentRelogins = new Map();

/**
 * How long a login — fresh, or trusted from moments ago — must have had
 * before the very first real connect attempt is allowed to happen. `tsh
 * login` returning, and even the inventory refresh after it, both mean
 * the cluster now says yes; neither means the node is reachable the
 * instant that answer arrives. Without this floor, the very first connect
 * attempt on a cluster this function had just logged into was *always*
 * too early, every time, because it ran the moment the login finished
 * rather than a beat after.
 */
const MIN_SETTLE_SINCE_LOGIN_MS = 3000;

function reloginKey(conn) {
  return `${conn?.proxy || ''}|${conn?.home || ''}`;
}

/**
 * Make sure a Teleport connection's cluster is actually logged into, and
 * has had a moment to settle, *before* ever dialling it — rather than
 * finding out from a failed connect and reacting to that afterward, which
 * always raced a login that had not even started yet.
 *
 * A no-op (no login, no wait) for anything that is not a Teleport
 * connection, or for a cluster that has simply been logged in for a while
 * (nothing here caused that, so nothing here owes it a wait). Otherwise
 * runs the login to completion if needed, then waits out whatever is
 * left of `MIN_SETTLE_SINCE_LOGIN_MS` since it happened — the full
 * amount for a login that just ran here, less (or none) for one already
 * trusted from moments ago.
 *
 * `background` is for the one caller that was not asked to open anything —
 * a still-attached tmux pane quietly healing its file channel on a timer.
 * There, logging back in behind a cluster you just told to log out of
 * would undo that the instant something redrew, so it is left alone and
 * the connect fails honestly instead. Everywhere else this runs because a
 * person just double-clicked a host, picked "Reconnect", or opened a tmux
 * session — asking to connect to a cluster you deliberately logged out of
 * is itself the deliberate act that should log you back into it, whether
 * what made it expired was that logout or the certificate simply lapsing;
 * the person doing it right now outranks a flag set by the last thing
 * they clicked.
 */
/**
 * Ask before logging back in, unless told not to.
 *
 * A background heal never reaches this (see `ensureLoggedIn`'s own
 * `background` handling) — this is only ever for a person who just
 * double-clicked a host, picked "Reconnect", or opened a tmux session, and
 * is about to get a login ceremony they did not explicitly ask for: a
 * browser tab, a terminal asking for a password, a Touch ID prompt. Saying
 * so first, rather than just doing it, is the same reasoning as
 * `confirmClosing` — the action is reversible enough that most people would
 * say yes, but surprising enough that nobody should have it done to them
 * silently.
 */
async function confirmLoginNeeded(conn) {
  if (state.settings.confirmLoginToConnect === false) return true;
  const where = conn.cluster || conn.proxy;
  const again = checkbox('Do not ask again', false);
  const ok = await modal({
    title: `Log in to ${where}?`,
    width: 460,
    render: (body) => {
      body.append(
        el('div', { style: 'font-size:13px;margin-bottom:6px' },
          `${where}'s session has lapsed. Connecting means logging back in first — `
          + 'a browser tab, a terminal, or a Touch ID prompt, depending on how this '
          + 'cluster authenticates.'),
        again);
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Log in', class: 'primary-btn', value: true, autofocus: true },
    ],
  });
  if (ok === true && again.input.checked) {
    state.settings = await window.api.settings.set({ confirmLoginToConnect: false });
    status('Won’t ask before logging in again — turn it back on in Settings');
  }
  return ok === true;
}

async function ensureLoggedIn(conn, { background = false } = {}) {
  if (conn?.type !== 'teleport' || !conn.proxy) return;
  const key = reloginKey(conn);
  let loggedInAt = recentRelogins.get(key);

  if (!loggedInAt || Date.now() - loggedInAt >= RELOGIN_TRUST_MS) {
    const { proxyAddress, doLogin, wasLoggedOutDeliberately } = await import('./teleportpanel.js');
    if (background && wasLoggedOutDeliberately(conn.proxy, conn.home)) return;
    /*
     * A fresh read, not `state.teleportProfiles` — that is only as current
     * as the last `refreshInventory()`, which can be tens of seconds stale
     * (the poll interval, or simply the time since the sidebar last asked).
     * A cluster logged into since then — by hand in a terminal, by another
     * ServerLife window, by `tsh`'s own silent cert renewal — still reads
     * `expired` from that stale copy, and this ran `doLogin` anyway: a
     * needless login box, and on an SSO cluster a browser window that did
     * not need to open. `teleport.status` is a local read, cheap enough to
     * run right before the decision it is actually for.
     */
    const fresh = await window.api.teleport.status().catch(() => null);
    const profiles = fresh?.profiles || state.teleportProfiles || [];
    /*
     * `p.home`, not `p.homeDir`: `home` is null-normalized for the default
     * tsh home the same way `conn.home` is, where `homeDir` is always the
     * real directory, default home included — comparing against that one
     * never matched a default-home cluster, so this always fell through to
     * `doLogin` below, however recently (or never) the cluster had in fact
     * logged out.
     */
    const prof = profiles.find((p) => proxyAddress(p.proxy) === proxyAddress(conn.proxy)
      && (p.home || null) === (conn.home || null));
    if (prof && !prof.expired) return; // already logged in, and not by anything here — nothing to settle
    /*
     * The background heal never reaches here at all: this entire block is
     * skipped for it whenever the cluster was logged out on purpose, and
     * a background wake that still needs a fresh login is rare enough
     * (an unattended first connect) that asking it to interrupt with a
     * popup nobody is there to answer would be the wrong trade. Everyone
     * else gets asked first.
     */
    if (!background && !(await confirmLoginNeeded(conn))) {
      throw new Error(`Login cancelled — ${conn.cluster || conn.proxy} needs a fresh login to connect`);
    }
    /*
     * Awaited to completion, not just to the login starting: for a local
     * or passwordless login this opened a terminal tab and waits out
     * whatever ran in it (`doLogin`, `runLoginInShell`) — a password
     * typed back, a security key tapped — before this resolves at all.
     * The connect below only ever runs once that has actually happened,
     * which is the whole point of doing it here first rather than
     * reacting to a failed connect afterward.
     */
    if (!(await doLogin({ proxy: conn.proxy, cluster: conn.cluster, homeDir: conn.home || null }))) return;
    loggedInAt = Date.now();
    recentRelogins.set(key, loggedInAt);
  }

  const remaining = MIN_SETTLE_SINCE_LOGIN_MS - (Date.now() - loggedInAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

/**
 * `window.api.conn.connect`, having first made sure — and waited out —
 * that the cluster is logged in (`ensureLoggedIn`), so the connect itself
 * is never the thing racing a login still in flight.
 *
 * Shared by the shell path (`connectPane`), tmux's (`ensureConnection`),
 * and the file explorer's own reconnect — all three dial through this one
 * call now; the explorer calling `window.api.conn.connect` directly meant
 * a file browser opened moments after a fresh login raced that login
 * exactly the way the terminal used to, and then named the failure MFA
 * because that is the only thing the ambiguous tag can mean on its own,
 * when the real cause was simply asking too soon.
 *
 * A node can still take a moment to become reachable even once the
 * cluster is confirmed logged in and settled, so a failure that still
 * looks like "needs MFA" after that gets a few more tries with a growing
 * wait — the only real confirmation that it is actually usable yet —
 * rather than being declared hopeless on the first one back.
 *
 * `background` is passed straight through to `ensureLoggedIn` — see there.
 */
export async function connectWithRelogin(connId, { background = false } = {}) {
  const conn = state.getConnection(connId);
  await ensureLoggedIn(conn, { background });
  try {
    return await window.api.conn.connect(connId);
  } catch (e) {
    if (!/ \[mfa\]$/.test(e.message) || conn?.type !== 'teleport' || !conn.proxy) throw e;
    let lastErr = e;
    for (const waitMs of CONNECT_SETTLE_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      try { return await window.api.conn.connect(connId); } catch (e2) { lastErr = e2; }
    }
    throw lastErr;
  }
}

const CONNECT_SETTLE_DELAYS_MS = [1200, 2000, 3000, 4000];

function findConnectionForHost(host, login) {
  for (const c of state.connections.values()) {
    if (c.hostId === host.id && (c.login || null) === (login || null)
        && ['connected', 'connecting', 'prompting', 'idle'].includes(c.state)) {
      return c;
    }
  }
  return null;
}

/**
 * Where the last local shell to close was, so the next one that opens with
 * nowhere else in mind starts there instead of always back at home.
 * Captured in `endPaneSession`, read here only when the caller named no
 * `cwd` of its own — a saved profile's directory, a workspace restoring a
 * pane's own, a login shell with nothing to do with either — all still
 * win outright.
 */
let lastLocalCwd = null;

/**
 * Open a local tab. With `opts.command` it runs that program instead of a
 * shell — used to replay Teleport recordings with `tsh play`.
 */
export async function openLocalShell(cwd, opts = {}) {
  const startCwd = cwd ?? lastLocalCwd;
  const tab = state.createTab({
    title: opts.title || 'Local shell',
    kind: 'local',
    connId: null,
  });
  const pane = await createPane({ tabId: tab.id, kind: 'local', connId: null, cwd: startCwd, explorerSource: opts.explorerSource });
  pane.title = opts.title || 'local';
  // A program with a screen of its own — `tsh latency` — has no use for a
  // file browser of this machine beside it. ⌘E still brings it back.
  if (opts.explorer === false) setPaneExplorerVisible(pane, false);
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();
  await startLocalTerm(pane, startCwd, opts);
  return pane;
}

/* ------------------------------------------------------------------ */
/* Consoles and screens                                                */
/* ------------------------------------------------------------------ */

/**
 * A serial console or a telnet session, in a tab of its own.
 *
 * Shaped like `openLocalShell` rather than like `openHost`, because that is
 * what it is: a terminal with something on the other end of it and no
 * connection, no file browser and no second channel. The spec is what the
 * saved connection holds, so the same function serves the Saved list, the
 * launcher and a one-off from the New session dialog.
 */
export async function openDeviceSession(spec = {}) {
  const kind = spec.kind === 'telnet' ? 'telnet' : 'serial';
  const title = spec.name
    || (kind === 'telnet' ? `${spec.host}:${spec.port || 23}` : (spec.path || 'serial'));

  const tab = state.createTab({ title, kind: 'local', connId: null });
  const pane = await createPane({ tabId: tab.id, kind: 'device', connId: null });
  pane.title = title;
  pane.deviceSpec = { ...spec, kind };
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();

  /*
   * Opening again after it ended, without losing what is on the screen.
   *
   * This is the ordinary case rather than the exception: a console is
   * unplugged and plugged back in, a device is power-cycled, a terminal
   * server drops the session when the far end reboots. What was printed
   * before it went is usually the reason you were watching, so the pane is
   * reused and the new session simply continues underneath it.
   */
  pane.offerReconnect = () => {
    pane.view.writeln('\x1b[90m[press Enter to reconnect]\x1b[0m');
    pane.reconnectArmed = true;
  };
  await startDeviceSession(pane);
  return pane;
}

/**
 * A new tab on a connection that is already open, running one command.
 *
 * For the things that have to happen *on* a host rather than from here —
 * telnet to a switch only the bastion can see, chiefly. It does not go through
 * `openHost`, because that wants a host from the inventory and a connection
 * made by quick connect is not in it; the connection is what is actually
 * wanted, and it is already there.
 */
export async function openOnConnection(connId, { startupCommand, title } = {}) {
  const conn = state.getConnection(connId);
  if (!conn) throw new Error('That session is no longer open');
  const tab = state.createTab({ title: title || conn.label, kind: 'remote', connId });
  const pane = await createPane({ tabId: tab.id, kind: 'remote', connId });
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();
  if (conn.state === 'connected') {
    await startRemoteTerm(pane);
    if (startupCommand) sendToPane(pane, startupCommand.replace(/\n*$/, '\n'));
    pane.view.fitNow();
    state.emit('tabs');
  } else {
    connectPane(pane, { startupCommand });
  }
  return pane;
}

async function startDeviceSession(pane) {
  const spec = pane.deviceSpec;
  const termId = uid('dev');
  pane.view.fitNow();
  try {
    const info = await window.api.device.open({
      ...spec,
      id: termId,
      cols: pane.view.cols || 100,
      rows: pane.view.rows || 30,
    });
    pane.termId = termId;
    pane.status = 'connected';
    pane.reconnectArmed = false;
    pane.reconnectBtn?.classList.add('hidden');
    /*
     * Say so, so the main process can release anything the far end said
     * between connecting and this pane existing — which is where a switch's
     * banner and telnet's own greeting live.
     */
    window.api.device.ready(termId).catch(() => {});
    pane.deviceLabel = info?.label || '';
    syncPtySize(pane);
    /*
     * A serial console says what it opened and at what speed, because
     * nothing else will. Telnet has already printed its own three lines —
     * Trying, Connected to, Escape character — and a banner above them would
     * be this app talking over a conversation forty years old.
     */
    if (!info?.greeted) {
      pane.view.writeln(`\x1b[90m[${spec.kind === 'telnet' ? 'telnet' : 'serial'} — ${info?.label || ''}]\x1b[0m`);
    }
    pane.view.focus();
    refreshPaneTitles();
    state.emit('tabs');
  } catch (e) {
    pane.status = 'error';
    pane.view.writeln(`\r\n\x1b[31m${e.message}\x1b[0m`);
    pane.offerReconnect();
  }
}

/**
 * A screen, drawn by noVNC into a pane.
 *
 * The viewer is loaded only when one is opened: it is a few hundred
 * kilobytes of RFB decoder that most sessions never want, and the terminal
 * should not pay for it at startup.
 */
export async function openVncSession(spec = {}) {
  const title = spec.name || `${spec.host}:${spec.port || 5900}`;
  const tab = state.createTab({ title, kind: 'local', connId: null });
  const pane = await createPane({ tabId: tab.id, kind: 'vnc', connId: null, graphic: true });
  pane.title = title;
  pane.vncSpec = spec;
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();

  const { connectVnc } = await import('./vnc.js');
  await connectVnc(pane);
  return pane;
}

/**
 * A tab whose panes are the panes of a tmux window.
 *
 * The layout comes from the far side, and that is deliberate: tmux is the one
 * that knows how the window is arranged, and two authorities over a layout is
 * how panes end up in different places in two clients looking at the same
 * session. So this builds what tmux describes, and a user rearranging things
 * here sends tmux a command and waits to be told the new shape.
 */
/**
 * A tab with one empty pane, for a session that is still being opened.
 *
 * Attaching to tmux is slower than opening a shell — it dials, asks the host
 * whether tmux is there, attaches, and then reads back what is on each pane —
 * and all of that used to happen before anything appeared on screen. A click
 * that does nothing for twenty seconds is a click people make again. So the
 * tab is created first and the waiting happens inside it, with the same
 * overlay, the same connect log and the same Cancel as every other session.
 */
export async function openPendingTab({ title }) {
  const tab = state.createTab({ title: title || 'tmux', kind: 'local', connId: null });
  const pane = await createPane({ tabId: tab.id, kind: 'tmux', connId: null });
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();
  return { tab, pane };
}

/** The connect overlay, for things that are not `connectPane`. */
export function paneOverlay(pane, opts) { showOverlay(pane, opts); }
export function clearPaneOverlay(pane) { hideOverlay(pane); }

/** One more line in an open overlay's log. */
export function noteOverlay(pane, text) {
  if (!pane?.overlay) return;
  pane.overlay.pre.textContent += text.replace(/\n*$/, '\n');
  pane.overlay.pre.scrollTop = pane.overlay.pre.scrollHeight;
}

export async function openTmuxWindow({ title, tree, bind }) {
  const tab = state.createTab({ title: title || 'tmux', kind: 'local', connId: null });
  tab.tmux = true;
  const built = await buildTmuxTree(tab.id, tree, bind);
  tab.root = built || paneNode((await createPane({ tabId: tab.id, kind: 'tmux', connId: null })).id);
  state.activeTabId = tab.id;
  const first = state.firstPaneOf(tab);
  if (first) state.setActivePane(first);
  state.emit('tabs');
  renderPanes();
  return tab;
}

/**
 * Build ServerLife's layout tree from tmux's, creating a pane for each leaf.
 *
 * The two shapes are the same thing with different names — tmux's `[` is a
 * column of panes and `{` a row — which is the reason this integration is
 * worth having here rather than in a terminal that would have to draw tmux's
 * own borders.
 */
async function buildTmuxTree(tabId, node, bind) {
  if (!node) return null;
  if (node.pane) {
    const pane = await createPane({ tabId, kind: 'tmux', connId: null });
    bind(pane, node.pane);
    return paneNode(pane.id);
  }
  const children = [];
  for (const c of node.children || []) {
    // Sequential rather than parallel: createPane appends to the DOM, and the
    // order it appends in is the order the panes appear.
    const built = await buildTmuxTree(tabId, c, bind);
    if (built) children.push(built);
  }
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return { type: 'split', dir: node.dir === 'row' ? 'row' : 'col', children };
}

/**
 * Re-shape an open tmux tab to match a layout that changed on the server —
 * someone split a pane in another client, or closed one.
 *
 * Panes that are still there keep their terminal and everything in it; the
 * rest are created or disposed of. Rebuilding the lot would be simpler and
 * would throw away every pane's scrollback each time anyone anywhere typed
 * `ctrl-b "`.
 */
export async function applyTmuxLayout(tabId, tree, { bind, paneFor }) {
  const tab = state.getTab(tabId);
  if (!tab) return null;

  const build = async (node) => {
    if (!node) return null;
    if (node.pane) {
      const existing = paneFor(node.pane);
      if (existing && state.getPane(existing.id)) return paneNode(existing.id);
      const pane = await createPane({ tabId, kind: 'tmux', connId: null });
      bind(pane, node.pane);
      return paneNode(pane.id);
    }
    const children = [];
    for (const c of node.children || []) {
      const built = await build(c);
      if (built) children.push(built);
    }
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return { type: 'split', dir: node.dir === 'row' ? 'row' : 'col', children };
  };

  const tmuxRoot = await build(tree);
  if (!tmuxRoot) return null;

  /*
   * A tab holding a tmux window can also hold panes tmux knows nothing
   * about — another server split in beside it, a hosts pane, a local shell.
   * Rebuilding the tab from tmux's layout alone threw those away, and since
   * adding a pane changes the client size and a changed size produces a
   * layout, the new pane disappeared the instant it arrived.
   *
   * So the tmux part is spliced into the arrangement that is already there:
   * it lands where its first pane was, every other tmux pane is dropped
   * (they are inside the new subtree), and the foreign panes stay exactly
   * where the user put them.
   */
  const isTmuxPane = (paneId) => state.getPane(paneId)?.kind === 'tmux';
  let placed = false;
  const splice = (node) => {
    if (!node) return null;
    if (node.type === 'pane') {
      if (!isTmuxPane(node.paneId)) return node;
      if (placed) return null;
      placed = true;
      return tmuxRoot;
    }
    const kids = (node.children || []).map(splice).filter(Boolean);
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    return { ...node, children: kids };
  };

  let root = splice(tab.root);
  // No tmux pane in the old tree at all — a window arriving into a tab that
  // was showing something else.
  if (!placed) root = root ? { type: 'split', dir: 'row', children: [tmuxRoot, root] } : tmuxRoot;

  const kept = new Set();
  const collect = (n) => {
    if (!n) return;
    if (n.type === 'pane') { kept.add(n.paneId); return; }
    for (const c of n.children || []) collect(c);
  };
  collect(root);

  // Anything no longer in the layout is a pane tmux has closed. A foreign
  // pane is never in tmux's layout and is never dropped here, because the
  // splice above keeps it in the tree.
  for (const id of state.panesOf(tabId)) {
    if (kept.has(id)) continue;
    const p = state.getPane(id);
    if (!p || p.kind !== 'tmux') continue;
    // Leaves the host's live stats too: the last pane off a host stops them.
    import('./monitor.js').then((m) => m.detachMonitor(p)).catch(() => {});
    p.view.dispose();
    p.element.remove();
    forgetPane(id);
    state.panes.delete(id);
  }
  tab.root = root;
  renderPanes();
  const first = state.firstPaneOf(tab);
  if (first && !state.getPane(state.activePaneId)) state.setActivePane(first);
  state.emit('tabs');
  return root;
}

/* ------------------------------------------------------------------ */
/* Panes                                                               */
/* ------------------------------------------------------------------ */

/**
 * A pane that is not a terminal at all.
 *
 * Everything in this file reaches for `pane.view` — to fit it, focus it,
 * search it, copy from it, save it. A VNC screen has none of those, and the
 * alternative to giving it something that answers anyway is an `if` in forty
 * places, each of which is a chance to forget one. So a graphical pane gets a
 * view that politely does nothing, and splitting, dragging, closing, the
 * focus ring and the tab strip all carry on without knowing.
 */
function graphicView() {
  const screen = el('div', { class: 'pane-screen' });
  return {
    // Null until attached: the pane is drawn once and then re-attached on
    // every layout, and `container` is how that is decided.
    container: null, isGraphic: true, screen, cols: 0, rows: 0, fontSize: 13,
    term: { options: {} },
    attach(host) { host.append(screen); this.container = screen; },
    fitNow() {}, focus() { screen.querySelector('canvas')?.focus(); },
    write() {}, writeln() {}, clearScreen() {},
    selection() { return ''; }, hasSelection() { return false; },
    allText() { return ''; }, screenTail() { return ''; }, linkAt() { return null; },
    findNext() { return false; }, findPrev() { return false; }, clearSearch() {},
    setTheme() {}, setFontSize() {},
    dispose() { screen.remove(); },
  };
}

async function createPane({ tabId, kind, connId, cwd, graphic = false, explorerSource = null }) {
  const id = uid('pane');
  const element = el('div', { class: 'pane', dataset: { pane: id } });
  const termHost = el('div', { class: 'pane-term' });

  // Every pane carries its own file explorer, so two open sessions each show
  // their own filesystem rather than sharing one panel.
  const filesHost = el('div', { class: 'pane-files' });
  const body = el('div', { class: 'pane-body' }, filesHost, el('div', { class: 'pane-split-h' }), termHost);

  const filesBtn = el('button', {
    class: 'icon-btn sm pfiles', text: '\u2630',
    title: 'Show/hide this file explorer (⌘E)\nRight-click for every pane in this tab',
    onClick: (e) => { e.stopPropagation(); togglePaneExplorer(id); },
  });
  // Left-click is this pane alone; the tab-wide and app-wide sweeps live on the
  // right-click menu, where they cannot be hit while aiming at one pane.
  filesBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openExplorerScopeMenu(e.clientX, e.clientY, id);
  });

  // Macros belong on the session, not in the sidebar: by the time you want one
  // you are already looking at the host, and this pane is that host.
  const macroBtn = el('button', {
    class: 'icon-btn sm pmacro', text: '▶',
    title: kind === 'local'
      ? 'Run a macro in this shell (⌘⇧R)'
      : 'Run a macro on this host (⌘⇧R)',
    onClick: async (e) => {
      e.stopPropagation();
      state.setActivePane(id);
      const { openMacroMenu } = await import('./macros.js');
      // The pane's kind decides which macros are on offer: a server command
      // has no business in the local shell.
      // A console on a serial cable takes the same commands a host does, so
      // it is offered the host macros rather than the local ones.
      // A beam's session gets the beam macros as well, first — tmux in a beam
      // included, since its pane carries the beam's connection.
      const { macroKindOf } = await import('./macros.js');
      const mk = macroKindOf(state.getPane(id));
      openMacroMenu(macroBtn, { kind: kind === 'device' ? 'remote' : mk });
    },
  });

  // Scrollback search lives next to the host name, where you look for it.
  const searchBox = buildPaneSearch(id);

  /*
   * Keyword highlighting, next to search because it answers the same question
   * in the other direction: search is "where is this word", highlighting is
   * "tell me when one of these words goes past".
   */
  /*
   * Network tools, from this host.
   *
   * The question is almost always "can *this server* reach that", and the
   * answer used to require opening the tools and then telling them which
   * session to use. On the pane's own header it arrives already pointed at
   * the right host. Remote panes only: a local shell is what the tools do by
   * default.
   */
  const netBtn = kind !== 'remote' ? null : el('button', {
    class: 'icon-btn sm pnet' + (state.settings.showPaneNetIcon === false ? ' hidden' : ''),
    text: '\u2317',
    title: 'Network and certificate tools from this host — reachability, HTTP and its own addresses',
    onClick: async (e) => {
      e.stopPropagation();
      state.setActivePane(id);
      const { openNetTools } = await import('./nettools.js');
      const p = state.getPane(id);
      openNetTools({ runOn: p?.connId || '', tool: 'ports' });
    },
  });

  const hlBtn = el('button', {
    class: 'icon-btn sm phl', text: '\u25A4',
    title: 'Highlight keywords in this session',
    onClick: async (e) => {
      e.stopPropagation();
      const p = state.getPane(id);
      if (!p) return;
      const key = paneHostKey(p);
      /*
       * Toggle what the pane is *doing*, not what the settings say — reading
       * the setting meant a pane switched off by hand asked "is it on?" of a
       * setting that still said yes, and switched itself off again.
       *
       * The pane's own override is three-valued (follow / on / off) rather
       * than a single "off" flag. As a flag it could only ever subtract, so
       * with highlighting off by default a local shell had no way to turn it
       * on at all.
       */
      const effective = !!p.highlight;
      if (key) {
        p.highlightOverride = null;
        await setHighlightForHost(key, !effective);
      } else {
        p.highlightOverride = !effective;
      }
      p.applyHighlightSettings?.();
      status(`Highlighting ${effective ? 'off' : 'on'}${key ? ' for this host' : ' in this pane'}`);
    },
  });
  hlBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const p = state.getPane(id);
    const key = p ? paneHostKey(p) : null;
    contextMenu(e.clientX, e.clientY, [
      { heading: true, label: 'Keyword highlighting' },
      {
        label: 'Highlights…',
        onClick: () => openHighlightSettings({
          hostKey: key,
          hostLabel: p?.kind === 'local' ? 'the local shell' : (state.getConnection(p?.connId)?.label || 'this host'),
        }),
      },
      key ? {
        label: `This host: ${highlightSource(key) === 'host' ? (highlightOn(key) ? 'always on' : 'always off') : 'follows the global setting'}`,
        submenu: [
          { label: 'Always on', onClick: async () => { await setHighlightForHost(key, true); p.applyHighlightSettings?.(); } },
          { label: 'Always off', onClick: async () => { await setHighlightForHost(key, false); p.applyHighlightSettings?.(); } },
          { label: 'Follow the global setting', onClick: async () => { await setHighlightForHost(key, null); p.applyHighlightSettings?.(); } },
        ],
      } : null,
    ].filter(Boolean));
  });

  /*
   * Pinned macros, as buttons on the session's own title bar.
   *
   * The macro menu is one click plus a read plus a click; a pinned macro is
   * the two or three you run constantly, reduced to a glyph you hit without
   * looking. They sit left of the menu that holds the rest, so the menu stays
   * where it has always been.
   */
  const macroPins = el('span', { class: 'pmacro-pins' });
  // Controls for the tmux session this pane shows, filled in by tmux.js once
  // the pane is bound to one. Empty and hidden on every other kind of pane.
  const tmuxCtl = el('span', { class: 'ptmux-ctl hidden' });

  /*
   * Shown the moment a session ends, next to the name — the one place on
   * the pane you are already looking at, rather than a line of text in the
   * scrollback that has to be noticed and then a right-click found to act
   * on it. Hidden again as soon as something reconnects it, by whichever
   * path did that (this button, the context menu's "Reconnect", or a plain
   * retry on a device console).
   */
  const reconnectBtn = el('button', {
    class: 'preconnect hidden', text: '↻ Reconnect',
    title: 'Open this session again',
    onClick: (e) => { e.stopPropagation(); reconnectFromBanner(state.getPane(id)); },
  });

  /*
   * Teleport, on a session whose host has no Teleport agent — the same offer
   * as the sidebar's tag and notice, on the pane that is actually open.
   * Shown from the sidebar's own probe result (state.teleportPresence), and
   * kept current by its 'teleportPresence' event.
   */
  const teleportBtn = el('button', {
    class: 'icon-btn sm pteleport hidden', type: 'button', text: '⚡',
    title: 'No Teleport agent on this host — install Teleport and join it to a cluster…',
    onClick: async (e) => {
      e.stopPropagation();
      const connId = state.getPane(id)?.connId;
      const hostId = state.getConnection(connId)?.hostId;
      if (!hostId) return;
      // Ask again first: it may have been installed since the last answer.
      const now = await checkTeleportPresence(connId, { refresh: true });
      if (now?.installed) return;
      (await import('./sidebar.js')).openInstallTeleportForHostId(hostId);
    },
  });
  const syncTeleportBtn = () => {
    const hostId = state.getConnection(state.getPane(id)?.connId)?.hostId;
    const p = hostId && state.teleportPresence?.get(hostId);
    teleportBtn.classList.toggle('hidden', !(kind !== 'local' && p && !p.installed));
  };
  state.on('teleportPresence', syncTeleportBtn);
  setTimeout(syncTeleportBtn, 0);

  const head = el('div', { class: 'pane-head', draggable: 'true' },
    el('span', {
      class: 'pname',
      text: kind === 'local' ? 'local' : (state.getConnection(connId)?.label || ''),
    }),
    reconnectBtn,
    teleportBtn,
    // The search sits on the right, over the terminal — next to the title it
    // reads as though it searches the file explorer below it.
    el('span', { class: 'spacer', style: 'flex:1' }),
    searchBox.element,
    hlBtn,
    netBtn,
    tmuxCtl,
    macroPins,
    macroBtn,
    filesBtn,
    el('button', {
      class: 'icon-btn sm pclose', text: '×', title: 'Close pane',
      onClick: (e) => { e.stopPropagation(); closePaneByHand(id); },
    }));
  element.append(head, body);
  wirePaneDrag(element, head, id);

  const view = graphic ? graphicView() : new TermView({
    settings: state.settings,
    onInput: (data) => handleInput(id, data),
    onResize: (cols, rows) => handleResize(id, cols, rows),
    onTitle: (t) => { const p = state.getPane(id); if (p) { p.remoteTitle = t; state.emit('tabs'); } },
  });

  element.addEventListener('mousedown', () => state.setActivePane(id));
  // Opt-in (Settings → "Focus follows the mouse"): hovering a pane makes it
  // the active one and puts the keyboard in it, the same as a click would —
  // for broadcasting or just working across several panes without a click
  // first for each one. Off by default, since the alternative — a stray
  // pass of the mouse on the way somewhere else stealing keystrokes meant
  // for a different pane — is worse than the click it saves.
  element.addEventListener('mouseenter', () => {
    if (!state.settings.focusFollowsMouse) return;
    state.setActivePane(id);
    view.focus();
  });
  element.addEventListener('contextmenu', (e) => {
    // File explorers inside the pane provide their own menu.
    if (e.target.closest('.pane-files')) return;
    onPaneContextMenu(e, id);
  });

  const pane = {
    id, tabId, kind, connId, cwd,
    termId: null, view, element, head, body, filesHost, filesBtn, search: searchBox,
    macroPins, hlBtn, tmuxCtl, reconnectBtn,
    // Compiled rules and the rewriter's own state (the colour in force, and
    // whether the program is on the alternate screen). The override is
    // null to follow the host or the global setting, true or false to say.
    highlight: null, highlightState: newHighlightState(), highlightOverride: null,
    explorer: null, explorerVisible: false,
    status: 'idle', error: null, overlay: null,
  };
  /**
   * Re-read the rules for this pane. Called when the pane is created, when a
   * connection lands on it (the host is only known then), and whenever the
   * rules change anywhere.
   */
  pane.applyHighlightSettings = () => {
    const key = paneHostKey(pane);
    const base = key ? highlightOn(key) : state.settings.highlight !== false;
    const on = pane.highlightOverride === null ? base : pane.highlightOverride;
    pane.highlight = on ? compileRules(rulesFor(key)) : null;
    pane.hlBtn?.classList.toggle('active', !!pane.highlight);
    if (pane.hlBtn) {
      const n = pane.highlight ? pane.highlight.length : 0;
      pane.hlBtn.title = pane.highlight
        ? `Highlighting ${n} keyword pattern${n === 1 ? '' : 's'} — click to turn off, right-click to edit`
        : 'Highlight keywords in this session — right-click to edit';
    }
  };
  state.addPane(pane);
  // Its own look, if its host has one remembered.
  applyPaneStyle(pane);
  pane.applyHighlightSettings();
  renderPaneMacroButtons(pane);

  // A remote pane's explorer follows its own session; a local pane shows this
  // machine. Either can be re-pointed from the explorer's own dropdown.
  pane.explorer = new Explorer({
    paneId: id,
    /*
     * A tmux pane has a host behind it like any other remote session — the
     * control stream rides the same connection — so its file browser is the
     * server's, not this machine's. A local shell, a serial console and a
     * screen have no remote filesystem at all, and show this machine.
     */
    source: explorerSource || ((kind === 'remote' || kind === 'tmux')
      ? { kind: 'remote', connId: null }
      : { kind: 'local', connId: null }),
    onChange: (what) => {
      if (what === 'hide') togglePaneExplorer(id, false);
      if (what === 'toggle-local') togglePaneLocalExplorer(id);
    },
  });
  filesHost.append(pane.explorer.element);

  wireExplorerResizer(pane);
  applyExplorerPosition(pane);
  /*
   * A console and a screen open without the file browser. It is not wrong
   * there — it shows this machine, and dragging a config off your laptop onto
   * a switch is not a thing it can do anyway — but half a pane given to
   * something unrelated is half a pane taken from the thing you opened. A
   * tmux pane keeps it: there is a real host under it, reached over the
   * connection the control stream is already using.
   */
  setPaneExplorerVisible(pane, kind === 'remote' || kind === 'local' || kind === 'tmux'
    ? state.settings.explorersVisible !== false
    : false);
  return pane;
}

/** Drag the divider between a pane's explorer and its terminal. */
function wireExplorerResizer(pane) {
  const handle = pane.body.querySelector('.pane-split-h');
  if (!handle) return;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const stacked = pane.body.classList.contains('stacked');
    const startPos = stacked ? e.clientY : e.clientX;
    const startSize = stacked ? pane.filesHost.offsetHeight : pane.filesHost.offsetWidth;
    handle.classList.add('dragging');

    const move = (ev) => {
      const delta = (stacked ? ev.clientY : ev.clientX) - startPos;
      const next = Math.max(140, startSize + delta);
      if (stacked) pane.filesHost.style.height = next + 'px';
      else pane.filesHost.style.width = next + 'px';
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      pane.view.fitNow();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/**
 * The per-pane scrollback search: a field beside the host name, with a live
 * match count. Matches are highlighted across the whole buffer, so a long
 * scrollback shows at a glance where the hits are.
 */
/**
 * Draw this pane's pinned-macro buttons.
 *
 * Called when the pane is built and whenever the macro list changes, so
 * pinning something adds its button to every open session at once rather than
 * to the next one opened. A local pane gets none: these run on a host.
 */
export function renderPaneMacroButtons(pane) {
  if (!pane?.macroPins) return;
  clear(pane.macroPins);
  // A local shell shows the pins scoped to it (or to everything); a host
  // session shows the ones scoped to hosts (or to everything).
  for (const { macro, icon, where } of pinnedMacros({ kind: macroKindOf(pane) })) {
    const btn = el('button', {
      class: 'icon-btn sm pmacro-pin' + (macro.confirm ? ' careful' : ''),
      text: icon,
      title: `${macro.name}${macro.description ? ' — ' + macro.description : ''}`
        + `\n\n${macro.command}`
        + (macro.confirm ? '\n\n(asks first — it changes something)' : ''),
      dataset: { where },
      onClick: async (e) => {
        e.stopPropagation();
        // The button belongs to this pane, so run it here whatever had focus.
        state.setActivePane(pane.id);
        const { sendMacro } = await import('./macros.js');
        sendMacro(macro);
      },
    });
    // Right-click the button to be rid of it, without going to find the list.
    btn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { togglePin, pinOptions, setPinned, scopeLabel } = await import('./macros.js');
      contextMenu(e.clientX, e.clientY, [
        { label: macro.name, heading: true },
        {
          label: 'Icon and where it shows…',
          key: scopeLabel(where) === 'Host sessions only' ? 'hosts'
            : scopeLabel(where) === 'The local shell only' ? 'local' : 'all',
          onClick: async () => {
            const next = await pinOptions({ icon, where, name: macro.name });
            if (next) await setPinned(macro.id, { pinned: true, icon: next.icon, where: next.where });
          },
        },
        { label: 'Unpin this button', onClick: () => togglePin(macro) },
      ]);
    });
    pane.macroPins.append(btn);
  }
}

function buildPaneSearch(paneId) {
  const input = el('input', {
    class: 'pane-search-input', type: 'text',
    placeholder: 'Search…', spellcheck: 'false',
  });
  const count = el('span', { class: 'pane-search-count' });

  const btn = (label, title, fn) => el('button', {
    class: 'icon-btn sm', text: label, title,
    onClick: (e) => { e.stopPropagation(); fn(); },
  });

  const element = el('div', { class: 'pane-search' },
    input, count,
    btn('\u2039', 'Previous match (⇧⏎)', () => step(-1)),
    btn('\u203A', 'Next match (⏎)', () => step(1)),
    btn('×', 'Clear', () => clearSearch()));

  const api = { element, input, focus, clearSearch };
  let resultSub = null;

  function view() { return state.getPane(paneId)?.view || null; }

  function step(dir) {
    const v = view();
    const q = input.value;
    if (!v || !q) return;
    dir > 0 ? v.findNext(q) : v.findPrev(q);
  }

  function clearSearch() {
    input.value = '';
    count.textContent = '';
    element.classList.remove('active');
    view()?.clearSearch();
    view()?.focus();
  }

  function focus() {
    element.classList.add('active');
    input.focus();
    input.select();
  }

  input.addEventListener('focus', () => element.classList.add('active'));
  input.addEventListener('blur', () => {
    if (!input.value) element.classList.remove('active');
  });

  // Typing searches as you go, so you see the count converge.
  input.addEventListener('input', () => {
    const v = view();
    if (!v) return;
    if (!input.value) { count.textContent = ''; v.clearSearch(); return; }
    if (!resultSub) {
      resultSub = v.onSearchResults(({ resultIndex, resultCount }) => {
        count.textContent = resultCount > 0
          ? `${resultIndex + 1}/${resultCount}`
          : (input.value ? '0' : '');
        count.classList.toggle('none', resultCount === 0);
      });
    }
    v.findIncremental(input.value);
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
  });

  return api;
}

/** Focus the search field of the focused pane (⌘F). */
export function focusPaneSearch() {
  const pane = state.activePane;
  if (!pane?.search) return false;
  const sel = pane.view.hasSelection() ? pane.view.selection() : '';
  if (sel && !sel.includes('\n')) pane.search.input.value = sel.trim();
  pane.search.focus();
  if (pane.search.input.value) pane.search.input.dispatchEvent(new Event('input'));
  return true;
}

/** Explorer beside the terminal ('left') or above it ('top'). */
export function applyExplorerPosition(pane) {
  const pos = state.settings.explorerPosition || 'left';
  pane.body.classList.toggle('stacked', pos === 'top');
  // An inline width left over from the other orientation would fight the CSS.
  pane.filesHost.style.width = '';
  pane.filesHost.style.height = '';
}

export function setPaneExplorerVisible(pane, visible) {
  pane.explorerVisible = !!visible;
  pane.filesHost.classList.toggle('hidden', !visible);
  pane.body.querySelector('.pane-split-h')?.classList.toggle('hidden', !visible);
  pane.filesBtn.classList.toggle('active', !!visible);
  // Nothing is polled while this side is hidden, so the lists about to appear
  // may be stale (or never loaded at all) — bring them up to date on the way in.
  if (visible) catchUpVisible(pane.id);
  setTimeout(() => pane.view.fitNow(), 30);
}

export function togglePaneExplorer(paneId, force) {
  const pane = state.getPane(paneId);
  if (!pane) return;
  setPaneExplorerVisible(pane, force === undefined ? !pane.explorerVisible : force);
}

/** Every pane in one tab, for the times you do want the sweep. */
export function toggleTabExplorers(tabId, force) {
  const panes = state.panesOf(tabId || state.activeTabId)
    .map((id) => state.getPane(id))
    .filter(Boolean);
  if (!panes.length) return;
  const next = force === undefined ? !panes.some((p) => p.explorerVisible) : !!force;
  for (const p of panes) setPaneExplorerVisible(p, next);
}

/**
 * The scopes a show/hide can mean. Offered on right-click so the plain click
 * can stay unambiguous — this pane, and nothing else.
 */
export function openExplorerScopeMenu(x, y, paneId) {
  const pane = state.getPane(paneId);
  const tabPanes = state.panesOf(pane?.tabId || state.activeTabId).length;
  contextMenu(x, y, [
    {
      label: pane?.explorerVisible ? 'Hide this explorer' : 'Show this explorer',
      onClick: () => togglePaneExplorer(paneId),
    },
    { sep: true },
    {
      label: `Show in all ${tabPanes} pane(s) in this tab`,
      onClick: () => toggleTabExplorers(pane?.tabId, true),
    },
    {
      label: `Hide in all ${tabPanes} pane(s) in this tab`,
      onClick: () => toggleTabExplorers(pane?.tabId, false),
    },
    { sep: true },
    {
      label: 'Hide in every pane, everywhere',
      onClick: async () => (await import('./files.js')).toggleAllExplorers(false),
    },
  ]);
}

/**
 * Show the local filesystem *underneath* this pane's session files, in the
 * same column. Both are visible at once, which is the arrangement an upload or
 * download actually needs — drag from one list to the other.
 */
export function togglePaneLocalExplorer(paneId, force) {
  const pane = state.getPane(paneId);
  if (!pane) return null;

  const wanted = force === undefined ? !pane.localExplorer : !!force;

  if (!wanted) {
    if (pane.localExplorer) {
      pane.localExplorer.destroy();
      pane.localExplorer = null;
      pane.localDivider?.remove();
      pane.localDivider = null;
    }
    pane.explorer?._syncToggles();
    return null;
  }

  if (pane.localExplorer) return pane.localExplorer;

  setPaneExplorerVisible(pane, true);

  pane.localDivider = el('div', { class: 'files-split' });
  pane.localExplorer = new Explorer({
    paneId,
    source: { kind: 'local', connId: null },
    onChange: (what) => {
      if (what === 'hide' || what === 'toggle-local') togglePaneLocalExplorer(paneId, false);
    },
  });
  pane.filesHost.append(pane.localDivider, pane.localExplorer.element);
  wireFilesSplit(pane);
  pane.localExplorer.ensureLoaded();
  pane.explorer?._syncToggles();
  return pane.localExplorer;
}

/** Drag the divider between a pane's two explorers. */
function wireFilesSplit(pane) {
  const handle = pane.localDivider;
  if (!handle) return;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const top = pane.explorer.element;
    const startY = e.clientY;
    const startH = top.offsetHeight;
    handle.classList.add('dragging');
    const move = (ev) => {
      const next = Math.max(90, startH + (ev.clientY - startY));
      top.style.flex = `0 0 ${next}px`;
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/** Dial the connection and attach a shell to the pane. */
async function connectPane(pane, opts = {}) {
  const conn = state.getConnection(pane.connId);
  pane.status = 'connecting';
  showOverlay(pane, {
    title: `Connecting to ${conn?.label || ''}…`,
    sub: conn?.target || '',
    log: true,
  });

  try {
    const info = await connectWithRelogin(pane.connId);
    state.setConnection(pane.connId, { state: 'connected', ...info });
    checkTeleportPresence(pane.connId, { refresh: true });
    // Stick with whatever login worked for this host next time.
    if (conn?.hostId && conn.login) {
      import('./sidebar.js').then(({ rememberLogin }) => rememberLogin(conn.hostId, conn.login)).catch(() => {});
    }
    hideOverlay(pane);
    // The listing can load as soon as the connection is usable.
    if (pane.explorerVisible) pane.explorer?.ensureLoaded();
    // A files-only pane has no terminal to open — the shared connection is
    // already all the file browser needs.
    if (!opts.noTerminal) await startRemoteTerm(pane);
    pane.status = 'connected';
    pane.reconnectBtn?.classList.add('hidden');
    // The pane knows which host it is only now, so its highlight rules — which
    // can be set per host — are read here rather than at construction. The
    // host's colour arrives the same way.
    pane.applyHighlightSettings?.();
    applyHostColors();
    pane.remoteHome = state.getConnection(pane.connId)?.homeDir || null;
    // Same reasoning as a local shell: a session starts in its home directory
    // unless it was told otherwise.
    pane.cwd = opts.remoteStartPath || pane.cwd || pane.remoteHome || null;
    refreshPaneTitles();

    if (opts.remoteStartPath) {
      sendToPane(pane, `cd ${JSON.stringify(opts.remoteStartPath)}\n`);
    }
    if (opts.startupCommand) {
      sendToPane(pane, opts.startupCommand.replace(/\n*$/, '\n'));
    }
    state.emit('tabs');
    state.emit('connections', state.getConnection(pane.connId));
  } catch (e) {
    pane.status = 'error';
    pane.error = e.message;
    state.setConnection(pane.connId, { state: 'error', error: e.message });
    /*
     * A node that wants per-session MFA and a login the user is not allowed to
     * use both fail the shared path with "too many authentication failures",
     * so this cannot be diagnosed from the error alone. Offer both remedies
     * rather than guessing and marking the host wrongly.
     */
    const authFailed = / \[mfa\]$/.test(e.message);
    // So the next attempt — a split, a reconnect, a run-command — goes
    // straight to `tsh` instead of failing the shared path first, same as
    // choosing "Mark as needing MFA" by hand already does.
    if (authFailed && conn?.type === 'teleport' && conn.hostId) {
      import('./sidebar.js')
        .then(({ setMfaHost }) => setMfaHost({ id: conn.hostId, name: conn.label }, true))
        .catch(() => {});
    }
    /*
     * A rebuilt box, a reimaged VM, a container recreated from scratch — ssh
     * refuses outright rather than retrying, and there is nothing to guess:
     * the fix is the same "Forget host key…" the sidebar's own host menu
     * already has, just reached from where the failure actually shows up
     * instead of making someone go find it. It only opens that dialog —
     * retrying is still a separate, deliberate click once the old entry is
     * gone, the same two steps as doing it from the menu.
     */
    const hostKeyChanged = / \[hostkey\]$/.test(e.message);
    /*
     * The same ambiguous "too many authentication failures" on a plain
     * ssh_config host, which has no tsh transport to fall back to. What it
     * does have is authprobe.js — already built, already wired into Quick
     * Connect — just never reachable from where this failure actually
     * shows up for a saved host. Offered only when nothing more specific
     * (the two above) already claimed the slot.
     */
    const authFailLikely = / \[authfail\]$/.test(e.message);
    /*
     * "access denied to <login> connecting" is the one failure here that is
     * not a guess — Teleport named the exact login it refused, which is
     * deliberately excluded from `authFailed` above (it is not an MFA
     * problem) but is exactly the case the login switcher below exists for.
     * Without this it fell through with no offered fix at all.
     */
    const loginDenied = /access denied to \S+ connecting/i.test(e.message);
    showOverlay(pane, {
      title: loginDenied ? 'Wrong login for this host?' : 'Connection failed',
      sub: conn?.target || '',
      error: e.message.replace(/ \[mfa\]$/, '').replace(/ \[hostkey\]$/, '').replace(/ \[authfail\]$/, ''),
      log: true,
      retry: () => connectPane(pane, opts),
      // A node with per-session MFA cannot be reached over the shared
      // connection; offer the transport that can. A changed host key is the
      // other failure with a specific, offerable fix rather than a plain
      // retry — and a plain host's own flavour of "too many attempts" gets
      // the probe that explains it. The three do not fire together, so one
      // slot covers all of them.
      alt: authFailed && conn?.type === 'teleport' ? {
        label: 'Connect with tsh ssh (MFA may be required)',
        onClick: () => reopenWithMfa(pane),
      } : hostKeyChanged ? {
        label: 'Forget old host key…',
        onClick: async () => {
          const { forgetHostKey } = await import('./keys.js');
          const host = conn?.hostId ? findHostById(conn.hostId) : null;
          const ctx = host && host.type !== 'teleport' ? { alias: host.alias, configFile: host.configFile } : undefined;
          forgetHostKey(undefined, ctx);
        },
      } : authFailLikely ? {
        label: 'Why was this refused?',
        onClick: () => showAuthProbe(conn),
      } : null,
      // The other thing it is usually is: the wrong login for this node.
      logins: (authFailed || loginDenied) && conn?.type === 'teleport' ? {
        current: conn.login,
        options: loginsForConn(conn),
        retry: (login) => reopenWithLogin(pane, login),
      } : null,
    });
    state.emit('tabs');
  }
}

async function startRemoteTerm(pane) {
  pane.view.fitNow();
  const cols = pane.view.cols || 100;
  const rows = pane.view.rows || 30;
  const termId = uid('term');
  await window.api.term.open(pane.connId, { id: termId, cols, rows });
  pane.termId = termId;
  syncPtySize(pane);
  pane.view.focus();
  // The live stats bar, once there is a session to show it for.
  import('./monitor.js').then((m) => m.attachMonitor(pane)).catch(() => {});
}

async function startLocalTerm(pane, cwd, opts = {}) {
  pane.view.fitNow();
  const termId = uid('lterm');
  // The answer says which shell was actually started, which matters when the
  // caller did not name one.
  const info = await window.api.localTerm.open({
    id: termId,
    cols: pane.view.cols || 100,
    rows: pane.view.rows || 30,
    cwd,
    command: opts.command,
    args: opts.args,
    teleportHome: opts.teleportHome,
    // A launched program's own settings, such as an AI assistant's config.
    env: opts.env,
    // Which shell, and whether to skip its startup files.
    shell: opts.shell,
    blank: opts.blank,
  });
  /*
   * Something to run when the program in this tab finishes.
   *
   * A login run in a terminal is the case: whoever opened it wants to know
   * when it is done so the inventory can be re-read, and polling for a tab to
   * close would be a worse way to find out.
   */
  if (typeof opts.onExit === 'function') pane.onExit = opts.onExit;
  // Which shell this tab is actually running — recorded either way, shown only
  // if the preference asks for it.
  pane.shellName = String(opts.shell || info?.shell || '').split('/').pop() || null;
  pane.blankShell = !!opts.blank;
  /*
   * Seed the directory rather than waiting for the first probe: a shell opened
   * with no cwd starts in the home directory, so the title can say so at once
   * instead of five seconds later.
   */
  pane.cwd = cwd || pane.cwd || state.appInfo?.home || null;
  refreshPaneTitles();
  pane.termId = termId;
  syncPtySize(pane);
  pane.status = 'connected';
  pane.view.focus();
  state.emit('tabs');
}

/**
 * What has been typed on the current line of each pane, so a `cd` can be
 * spotted as it is sent.
 *
 * Crude on purpose: printable characters in, backspace takes one out, and
 * anything that ends a line clears it. It cannot see a command recalled
 * with the up arrow or hidden behind an alias — which is why it only ever
 * *adds* a check, and the background poll remains what guarantees the file
 * browser catches up.
 */
const typedLine = new Map();

/** Does this line look like it moves the shell somewhere else? */
function changesDirectory(line) {
  return /(^|[;&|]\s*)\s*(cd|pushd|popd)(\s|$)/.test(line);
}

function noteTyped(paneId, data) {
  let line = typedLine.get(paneId) || '';
  for (const ch of String(data)) {
    if (ch === '\r' || ch === '\n') {
      if (changesDirectory(line)) {
        /*
         * After the shell has had a moment to actually change directory.
         * A probe fired the instant Enter is pressed reads the old one.
         */
        setTimeout(() => {
          import('./files.js').then((m) => m.followPaneNow(paneId)).catch(() => {});
        }, 450);
      }
      line = '';
    } else if (ch === '\u0003' || ch === '\u0015') line = '';        // ^C, ^U
    else if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1);
    else if (ch >= ' ') line += ch;
  }
  typedLine.set(paneId, line.slice(-200));
}

/**
 * Stop whatever this pane was running.
 *
 * Four kinds of session end four different ways and every one of them has to
 * be ended, or the pane goes and the thing behind it does not: a pty keeps
 * running, a serial port stays open and the next attempt to use the cable
 * says it is busy, a VNC socket holds the screen.
 */
function endPaneSession(pane) {
  // Every way a pane ends comes through here — a pane closed, a tab closed —
  // so this is where it leaves its host's live stats; the last one stops them.
  if (pane.statsBar) import('./monitor.js').then((m) => m.detachMonitor(pane)).catch(() => {});
  if (pane.vncToken) {
    try { pane.rfb?.disconnect(); } catch { /* the viewer may already be gone */ }
    pane.rfb = null;
    window.api.vnc.release(pane.vncToken).catch(() => {});
    pane.vncToken = null;
  }
  if (pane.kind === 'tmux') {
    // Closing the pane here closes the view of it, never the session: that
    // is the whole point of the thing running on the far side.
    pane.termId = null;
    import('./tmux.js').then((m) => m.forgetTmuxPane(pane)).catch(() => {});
    return;
  }
  if (!pane.termId) return;
  if (pane.kind === 'local') {
    /*
     * Read before the close, and *waited out* before it, not just
     * requested first — `cwd` is a round trip to the main process and a
     * real `lsof`/`/proc` read, which takes actual wall-clock time, where
     * `close` is close to instant (`pty.kill()` and done). Fired both at
     * once rather than one after the other, the kill routinely won: by
     * the time lsof got to the pid, the process behind it was already
     * gone, and this came back with nothing to remember on most closes,
     * not just the rare slow one. `endPaneSession` itself still is not
     * awaited by its own callers — nothing here needs that, only that the
     * close waits for the read, not the other way around.
     */
    const termId = pane.termId;
    pane.termId = null;
    window.api.localTerm.cwd(termId)
      .then((cwd) => { if (cwd) lastLocalCwd = cwd; })
      .catch(() => {})
      .then(() => window.api.localTerm.close(termId).catch(() => {}));
    return;
  }
  if (pane.kind === 'device') window.api.device.close(pane.termId).catch(() => {});
  else window.api.term.close(pane.connId, pane.termId).catch(() => {});
  pane.termId = null;
}

function handleInput(paneId, data) {
  const pane = state.getPane(paneId);
  if (!pane) return;
  // A console whose session has ended still takes one keystroke: the one that
  // opens it again.
  if (pane.kind === 'device' && !pane.termId) {
    if (pane.reconnectArmed && /[\r\n]/.test(data)) {
      pane.reconnectArmed = false;
      pane.view.writeln('');
      startDeviceSession(pane);
    }
    return;
  }
  if (!pane.termId) return;
  if (pane.kind === 'remote' || pane.kind === 'local') noteTyped(paneId, data);
  // Before the keys go: a recording reads the line from where the shell left the cursor.
  if (pane.recorder) recordInput(pane, data);

  // Broadcast typing fans the same keystrokes to every remote pane in the tab.
  if (state.broadcast && pane.kind === 'remote') {
    for (const pid of state.panesOf(pane.tabId)) {
      const p = state.getPane(pid);
      if (p && p.termId && p.kind === 'remote') writeTo(p, data);
    }
    return;
  }
  writeTo(pane, data);
}

function writeTo(pane, data) {
  if (pane.kind === 'local') window.api.localTerm.write(pane.termId, data).catch(() => {});
  else if (pane.kind === 'device') window.api.device.write(pane.termId, data).catch(() => {});
  // A tmux pane's keystrokes go to the server as a command, not down a pty:
  // there is one stream for the whole session and the pane is an argument.
  else if (pane.kind === 'tmux') window.api.tmux.write(pane.tmuxId, pane.tmuxPane, data).catch(() => {});
  else window.api.term.write(pane.connId, pane.termId, data).catch(() => {});
}

/** Programmatically send text to a pane's shell (used for cd / startup cmds). */
/*
 * "Is Teleport on this host?" — asked once per host, for any plain SSH
 * connection that comes up, whichever way it was opened: a sidebar row, a
 * saved profile (whose host is not the sidebar's), Quick connect. It used to
 * be asked only when the sidebar drew a connected ssh_config row, so a
 * session from a saved profile was never checked and never offered the
 * install. Not for Teleport nodes, and not when detection is turned off or
 * the app may run nothing on servers by itself (quietRemote).
 */
const teleportChecked = new Set();
/*
 * `refresh` asks the host again rather than taking the answer already held:
 * the first answer was kept for the connection's whole life (here and in
 * the main process), so a host that had Teleport installed on it afterwards
 * — by the wizard, or by hand — kept its ⚡ "install" button. A fresh
 * connection, a click on that button, and the minutes after the wizard runs
 * all ask anew. Resolves to the answer (or null).
 */
export async function checkTeleportPresence(connId, { refresh = false } = {}) {
  const c = state.getConnection(connId);
  if (!c || c.type !== 'ssh' || !c.hostId) return null;
  if (state.settings.detectTeleportOnSsh === false || state.settings.quietRemote) return null;
  if (!state.teleportPresence) state.teleportPresence = new Map();
  if (!refresh && state.teleportPresence.has(c.hostId)) {
    state.emit('teleportPresence', { hostId: c.hostId, presence: state.teleportPresence.get(c.hostId) });
    return state.teleportPresence.get(c.hostId);
  }
  if (!refresh && teleportChecked.has(c.hostId)) return null;
  teleportChecked.add(c.hostId);
  const before = state.teleportPresence.get(c.hostId);
  try {
    const r = await window.api.conn.teleportPresence(connId, { refresh });
    if (!r) { teleportChecked.delete(c.hostId); return null; }
    state.teleportPresence.set(c.hostId, r);
    state.emit('teleportPresence', { hostId: c.hostId, presence: r });
    // The notice: the first time a host is found without Teleport, and again
    // if it had Teleport the last time it was asked and has lost it since.
    if (!r.installed && (!before || before.installed)) {
      (await import('./sidebar.js')).offerTeleportInstallFor(c.hostId, c.label, { again: !!before?.installed });
    }
    if (r.installed && before && !before.installed) {
      const { toast } = await import('./ui.js');
      toast(`Teleport is on ${String(c.label || 'this host').replace(/\s+\([^)]*\)$/, '')} now${r.running ? ' and running' : ' — not running yet'}`);
    }
    return r;
  } catch {
    teleportChecked.delete(c.hostId);
    return null;
  }
}

/** Ask again every 15 s for a few minutes — after the install has been typed into a session. */
export function watchTeleportInstall(connId, { every = 15000, forMs = 180000 } = {}) {
  const until = Date.now() + forMs;
  const tick = async () => {
    const r = await checkTeleportPresence(connId, { refresh: true });
    if (r?.installed || Date.now() > until || !state.getConnection(connId)) return;
    setTimeout(tick, every);
  };
  setTimeout(tick, every);
}

export function sendToPane(pane, text) {
  if (!pane?.termId) return;
  writeTo(pane, text);
}

/**
 * Tell the pty how big the terminal actually is, now that there is a pty to
 * tell.
 *
 * The size travels one way only: xterm measures the pane, and `onResize`
 * carries the answer down to the shell. That event fires when the grid
 * *changes*, and until the pty exists there is nothing to send it to —
 * `handleResize` drops anything that arrives before `termId` is set. So a
 * fit that lands in the gap between the pane being drawn and the pty being
 * opened is simply lost, and because the grid is by then already the right
 * size, no later fit re-announces it. The shell keeps the 80x24 xterm starts
 * out with: lines wrap in the middle of a wide pane, and long commands run
 * off the end of what you are typing. Toggling the file explorer fixes it
 * only because that genuinely changes the width, which finally produces an
 * event with somewhere to go.
 *
 * Whether the fit won that race was down to whether an IPC round trip beat a
 * repaint, which is why it went wrong on some sessions and not others. This
 * closes it: once the pty is open, the current size is sent whether or not
 * anything changed. A resize to the size it already has costs one SIGWINCH.
 */
function syncPtySize(pane, again = true) {
  pane.view.fitNow();
  handleResize(pane.id, pane.view.cols, pane.view.rows);
  // Once more after the next layout, for a pane that was still being measured
  // when its shell started — fitNow declines to measure a container with no
  // width yet, so the first call there is a no-op.
  if (again) requestAnimationFrame(() => {
    if (state.getPane(pane.id)) syncPtySize(pane, false);
  });
}

function handleResize(paneId, cols, rows) {
  const pane = state.getPane(paneId);
  if (!pane || !pane.termId) return;
  if (pane.kind === 'local') window.api.localTerm.resize(pane.termId, cols, rows).catch(() => {});
  else if (pane.kind === 'device') window.api.device.resize(pane.termId, cols, rows).catch(() => {});
  /*
   * A tmux pane cannot be resized on its own: tmux sizes a window to its
   * smallest attached client, so the lever is the size of the whole client.
   * The tmux module works that out from the tab and sends it once, rather
   * than every pane shouting its own dimensions.
   */
  else if (pane.kind === 'tmux') import('./tmux.js').then((m) => m.notePaneResize(pane)).catch(() => {});
  else window.api.term.resize(pane.connId, pane.termId, cols, rows).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Overlays (connect progress / failure)                               */
/* ------------------------------------------------------------------ */

/** Logins the cluster's certificate actually carries. */
function loginsForConn(conn) {
  const host = conn?.hostId ? findHostById(conn.hostId) : null;
  const cluster = host?.cluster;
  const profile = state.teleportProfiles.find((p) => p.cluster === cluster
      && (p.home || null) === (host?.home || null))
    || state.teleportProfiles.find((p) => p.cluster === cluster);
  return (profile?.logins || []).filter((l) => l && l !== conn.login);
}

/** Reopen this pane's host as a different user. */
export async function reopenWithLogin(pane, login) {
  const conn = state.getConnection(pane.connId);
  if (!conn) return;
  const host = findHostById(conn.hostId);
  if (!host) return toast('Host is no longer in the inventory', 'error');
  const tabId = pane.tabId;
  // The tab goes with it immediately after — not really "closing a pane"
  // as a person would mean it, so no theatre for this one.
  closePane(pane.id, { animate: false });
  if (state.getTab(tabId)) closeTab(tabId);
  await openHost(host, { login, reuse: false });
}

/** Reopen this pane's host using `tsh ssh`, which prompts for MFA in-terminal. */
/**
 * Run authprobe.js against the host a plain ssh_config connection just
 * failed to reach, and show what it found — the same "which keys were
 * offered, in what order" diagnosis Quick Connect already has, reached for
 * once from a saved host's own failure instead of only from an ad-hoc one.
 */
async function showAuthProbe(conn) {
  const host = conn?.hostId ? findHostById(conn.hostId) : null;
  const target = conn?.login ? `${conn.login}@${host?.hostname || conn?.target || ''}` : (host?.hostname || conn?.target);
  if (!target) return toast('No host to probe', 'error');

  const box = el('pre', { class: 'qc-debug', style: 'max-height:50vh;overflow:auto;white-space:pre-wrap;margin:0' });
  modal({
    title: 'Why was this refused?',
    subtitle: target,
    width: 'min(640px, 94vw)',
    render: (body) => { box.textContent = 'Running ssh -vv …'; body.append(box); },
    buttons: [{ label: 'Close', value: null }],
  });

  try {
    const r = await window.api.ssh.authProbe(target, {
      port: host?.port,
      identityFile: host?.identityFile || undefined,
    });
    const lines = [
      r.methods ? `Server accepts:      ${r.methods}` : '',
      r.offered.length
        ? `Keys offered (${r.offered.length}):\n` + r.offered.map((o, i) => `  ${i + 1}. ${o}`).join('\n')
        : 'No keys were offered at all — nothing in the agent and no identity file matched.',
      r.accepted ? `\nAccepted:            ${r.accepted}` : '',
      r.tooMany
        ? `\nThe server stopped after ${r.offered.length} attempt(s): MaxAuthTries reached.`
        : '',
      r.pastLimit
        ? '\nsshd allows 6 attempts by default and counts every offer above, so '
          + 'anything after the sixth was never assessed. Offer one key instead.'
        : '',
      r.missingIdentity ? `\nThis identity file could not be read: ${r.missingIdentity}` : '',
      r.finalError ? `\n${r.finalError}` : '',
    ].filter(Boolean);
    box.textContent = lines.join('\n') || 'Nothing conclusive — the server may simply be unreachable.';
  } catch (e) {
    box.textContent = e.message;
  }
}

export async function reopenWithMfa(pane) {
  const conn = state.getConnection(pane.connId);
  if (!conn) return;
  const host = findHostById(conn.hostId);
  if (!host) return toast('Host is no longer in the inventory', 'error');
  /*
   * `conn.login` is whatever this pane was opened with, possibly a long time
   * ago — and the thing that just failed may be exactly that it is stale:
   * a login the cluster granted then and does not grant now. Every other
   * opener resolves `preferredLogin`, which already knows to drop a
   * remembered login the moment it stops being one of the cluster's current
   * ones; reusing `conn.login` unconditionally here skipped that check and
   * retried a login already known to be wrong.
   */
  const { loginOptionsFor, preferredLogin } = await import('./sidebar.js');
  const options = loginOptionsFor(host);
  const login = conn.login && (!options.length || options.includes(conn.login))
    ? conn.login
    : preferredLogin(host);
  const tabId = pane.tabId;
  // Same here — the tab is closing with it, replaced by a fresh one.
  closePane(pane.id, { animate: false });
  const tab = state.getTab(tabId);
  if (tab) closeTab(tabId);
  await openHost(host, {
    login: login || undefined,
    transport: 'tsh',
    reuse: false,
    mfaMode: state.settings.mfaMode || 'platform',
  });
}

function findHostById(id) {
  for (const nodes of state.teleportNodes.values()) {
    const n = nodes.find((x) => x.id === id);
    if (n) return n;
  }
  return state.sshHosts.find((h) => h.id === id) || null;
}

function showOverlay(pane, { title, sub, error, log, retry, promptInput, alt, mfaAlternatives, logins, peek }) {
  hideOverlay(pane);
  const pre = el('pre');
  const box = el('div', { class: 'box' },
    el('h3', { text: title }),
    sub ? el('div', { class: 'sub', text: sub }) : null,
    log ? pre : null);

  // Dialling is dead time; something crossing the wire makes it less so. Only
  // while it is still working — an error is not a moment for a cartoon.
  if (!error) {
    const scene = connectScene();
    if (scene) box.insertBefore(scene, box.firstChild);
  }

  if (promptInput) {
    const input = el('input', { type: 'password', placeholder: 'Response…', autofocus: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        window.api.conn.writeMaster(pane.connId, input.value + '\n').catch(() => {});
        input.value = '';
      }
    });
    box.append(el('div', { class: 'row' }, input));
  }

  if (mfaAlternatives) {
    const modes = [
      { value: 'platform', label: 'Touch ID' },
      { value: 'cross-platform', label: 'Security key' },
      { value: 'otp', label: 'OTP code' },
      { value: 'browser', label: 'Browser' },
    ];
    box.append(el('div', { class: 'hint', style: 'margin-bottom:8px' },
      'Try again, or use a method that does not need an OS prompt — an OTP code is typed straight into the terminal.'));
    const grid = el('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:10px' });
    for (const m of modes) {
      grid.append(el('button', {
        class: m.value === mfaAlternatives.current ? 'primary-btn' : 'ghost-btn',
        text: m.value === mfaAlternatives.current ? `Retry with ${m.label}` : m.label,
        onClick: () => mfaAlternatives.retry(m.value),
      }));
    }
    box.append(grid);
    box.append(el('div', { class: 'row', style: 'margin-bottom:10px' },
      el('button', {
        class: 'ghost-btn', text: 'Copy tsh command',
        title: 'Run it in Terminal if the OS prompt will not appear here',
        onClick: () => mfaAlternatives.copyCommand(),
      })));
  }

  if (logins?.options?.length) {
    box.append(el('div', { class: 'hint', style: 'margin-bottom:8px' },
      `Authentication failed as “${logins.current || 'default'}”. That is either a login this node does not allow, or a node that wants MFA per session — try another login, or the MFA transport.`));
    const grid = el('div', { class: 'row', style: 'flex-wrap:wrap;margin-bottom:10px' });
    for (const l of logins.options.slice(0, 6)) {
      grid.append(el('button', {
        class: 'ghost-btn', text: 'Try as ' + l,
        onClick: () => logins.retry(l),
      }));
    }
    box.append(grid);
  }

  const row = el('div', { class: 'row' });
  if (alt) row.append(el('button', { class: 'primary-btn', text: alt.label, onClick: () => alt.onClick() }));
  if (error && retry) row.append(el('button', { class: alt ? 'ghost-btn' : 'primary-btn', text: 'Retry', onClick: () => retry?.() }));
  row.append(el('button', {
    class: 'ghost-btn', text: error ? 'Close pane' : 'Cancel',
    onClick: () => closePane(pane.id),
  }));
  /*
   * `peek`: the text behind the notice is worth reading — what was on screen
   * when a session ended. Show terminal folds the notice into a bar along the
   * top, its buttons still there, and the terminal at full strength under it
   * to read, scroll and copy; Show notice puts it back.
   */
  let overlay = null;
  if (peek) {
    const toggle = el('button', {
      class: 'ghost-btn', text: 'Show terminal', title: 'Read what was on screen; the buttons stay in a bar at the top',
      onClick: () => {
        const on = !overlay.classList.contains('peek');
        overlay.classList.toggle('peek', on);
        pane.element.classList.toggle('overlay-peek', on);
        toggle.textContent = on ? 'Show notice' : 'Show terminal';
        if (on) pane.view?.focus?.();
      },
    });
    row.append(toggle);
  }
  box.append(row);

  overlay = el('div', { class: 'pane-overlay' }, box);
  pane.element.append(overlay);
  pane.overlay = { node: overlay, pre };

  if (log) {
    window.api.conn.log(pane.connId).then((entries) => {
      if (!pane.overlay) return;
      pre.textContent = entries.map((e) => e.text).join('');
      pre.scrollTop = pre.scrollHeight;
    }).catch(() => {});
  }
}

function hideOverlay(pane) {
  if (pane.overlay) { pane.overlay.node.remove(); pane.overlay = null; }
  pane.element?.classList.remove('overlay-peek');
}

/** Append streaming master output into any open overlay for that connection. */
export function appendConnLog(connId, entry) {
  for (const pane of state.panes.values()) {
    if (pane.connId === connId && pane.overlay) {
      pane.overlay.pre.textContent += entry.text;
      pane.overlay.pre.scrollTop = pane.overlay.pre.scrollHeight;
    }
  }
}

/** A prompt on the master (password / MFA) needs an input box in the overlay. */
export function markPrompting(connId) {
  for (const pane of state.panes.values()) {
    if (pane.connId === connId && pane.overlay && !pane.overlay.node.querySelector('input')) {
      const input = el('input', { type: 'password', placeholder: 'Type response and press Enter…' });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          window.api.conn.writeMaster(connId, input.value + '\n').catch(() => {});
          input.value = '';
        }
      });
      const box = pane.overlay.node.querySelector('.box');
      box.insertBefore(el('div', { class: 'row', style: 'margin-bottom:10px' }, input),
                       box.querySelector('.row'));
      setTimeout(() => input.focus(), 20);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Splitting & closing                                                 */
/* ------------------------------------------------------------------ */

/**
 * Split the focused pane.
 *
 * With no `opts.host` the new pane joins the same server, which is the common
 * case. Pass a host to put a *different* machine beside the current one —
 * `dir` 'row' places it to the right, 'col' below. `opts.filesOnly` gives the
 * new pane the file browser and no terminal.
 */
export async function splitActivePane(dir, opts = {}) {
  const pane = state.activePane;
  /*
   * On a tmux pane, a plain split (⌘⇧D, ⌘⇧E) is tmux's: a new pane in the
   * same session, beside this one, that outlives the window like the rest.
   * A split that names something else — another host, a local shell, a
   * hosts list — is still ServerLife's, since tmux cannot hold those.
   */
  if (pane?.kind === 'tmux' && pane.tmuxId && !opts.host && !opts.local && !opts.hosts) {
    const { splitTmuxPane } = await import('./tmux.js');
    return splitTmuxPane(pane, dir);
  }
  if (!pane) {
    // Nothing focused yet: a split with a host is just "open it".
    if (opts.host) return openHost(opts.host, { login: opts.login, filesOnly: opts.filesOnly });
    /*
     * A bare split with nothing focused has nothing to split beside. With
     * nothing open at all there is nothing to even ask about — a fresh
     * local shell, the same as an empty window's own "+" would open.
     * With something open, just not the focused one (a click elsewhere
     * last, or a window that opened with none), guessing which pane was
     * meant is worse than asking: wait for the next click on one, then
     * run this same split from there.
     */
    if (!state.panes.size) return openLocalShell();
    status('Click a pane, then split it from there', 0);
    return new Promise((resolve) => {
      const off = state.on('activePane', (p) => {
        off();
        status('');
        resolve(p ? splitActivePane(dir, opts) : undefined);
      });
    });
  }
  /*
   * A bare split (⌘⇧D/⌘⇧E, or the tab menu's Split right/down — no host, no
   * `local`, no `hosts` named) means "more of the same" — which for a shell
   * is the same host, and for a hosts pane itself cannot be a *pane* with no
   * connection at all: that used to fall straight through to kind:'local'
   * below and open a disconnected local shell, not the host being looked at.
   * The host actually targeted is whatever is picked in that pane; with one
   * picked, split with it — same as its own "Open beside current" menu item
   * — and with none or several picked, open another view of the inventory
   * instead of a shell that answers to nothing.
   */
  if (!opts.host && !opts.local && !opts.hosts && pane.isHosts) {
    const { pickedHostsOf } = await import('./hostspane.js');
    const picked = pickedHostsOf(pane.id);
    if (picked.length !== 1) return splitActivePane(dir, { ...opts, hosts: true });
    // Same as "Open beside current": the host's own preferred login, not
    // whatever `conn:create` falls back to with none named at all (the OS
    // account running ServerLife).
    const { preferredLogin } = await import('./sidebar.js');
    return splitActivePane(dir, { ...opts, host: picked[0], login: opts.login || preferredLogin(picked[0]) });
  }
  const tab = state.getTab(pane.tabId);
  if (!tab) return;

  let kind = pane.kind;
  let connId = pane.connId;

  // A hosts pane connects to nothing, so it must not inherit the pane it
  // came from — a split off a session would otherwise take that session's
  // connection with it and then never use it.
  if (opts.hosts) {
    kind = 'local';
    connId = null;
  } else if (opts.local) {
    kind = 'local';
    connId = null;
  } else if (opts.host) {
    /*
     * `open()` skips straight to the `tsh` transport for a host already
     * known to need per-session MFA, before ever calling `openHost`. A
     * split dials its connection right here instead and never asked, so the
     * very host that opens cleanly from a double-click failed every time
     * from "Open beside/below current" — same symptom as the run-command
     * dialog, different code path.
     */
    let transport = opts.transport;
    if (!transport && opts.host.type === 'teleport') {
      const { isMfaHost } = await import('./sidebar.js');
      if (isMfaHost(opts.host.id)) transport = 'tsh';
    }
    // A different server needs its own connection before the pane appears.
    const created = await window.api.conn.create(connPayload(opts.host), { login: opts.login, transport, profileSshOptions: opts.profileSshOptions });
    state.setConnection(created.id, {
      id: created.id, label: created.label, target: created.target,
      type: created.type, state: 'idle', hostId: opts.host.id, login: opts.login,
      cluster: opts.host.type === 'teleport' ? opts.host.cluster : null,
      proxy: opts.host.type === 'teleport' ? opts.host.proxy : null,
      home: opts.host.type === 'teleport' ? (opts.host.home || null) : null,
      // So a live profile-backed connection can be matched back to its
      // profile, same as openHost — the Hosts-pane "Saved" group's "live" mark.
      profileId: opts.profileId || null,
      // Same as openHost: the transport the main process settled on, not the
      // one asked for — the file browser and multi-exec both read it.
      transport: created.transport || transport || 'mux',
      transportForced: created.transportForced || null,
    });
    kind = 'remote';
    connId = created.id;
  }

  const newPane = await createPane({ tabId: tab.id, kind, connId, cwd: pane.cwd, explorerSource: opts.explorerSource });
  // A kube exec split (see kubepanel.js's openPodExec) reads as the pod it
  // is in, not as "local: ~" — same reason openLocalShell's own kube path sets it.
  if (opts.kubeExec) newPane.kubeExec = true;
  if (opts.kubeLogs) newPane.kubeLogs = true;
  tab.root = splitTree(tab.root, pane.id, newPane.id, dir);
  renderPanes();
  state.setActivePane(newPane.id);

  /*
   * A hosts pane splits like anything else, and is the one kind that needs
   * no connection at all — it is a view of the inventory, not of a machine.
   */
  if (opts.hosts) {
    makeHostsPane(newPane, 'Hosts');
    renderPanes();
    state.emit('tabs');
    return newPane;
  }

  const filesOnly = !!opts.filesOnly && newPane.kind === 'remote';
  if (filesOnly) {
    newPane.filesOnly = true;
    newPane.element.classList.add('files-only');
    setPaneExplorerVisible(newPane, true);
  } else if (opts.host) {
    applyOpensWithFiles(newPane, opts.host);
  }

  if (newPane.kind === 'local') {
    // `opts.cwd` is for a caller that knows where the pane should start —
    // restoring a saved layout. A plain split inherits from the pane it came
    // from, which is what "split here" means.
    // A program to run instead of a shell — an AI assistant beside the
    // session — comes with its own title and environment.
    if (opts.title) { newPane.title = opts.title; const n = newPane.head?.querySelector('.pname'); if (n) n.textContent = opts.title; }
    // A program with no filesystem of its own to browse (kubectl logs -f —
    // see kubepanel.js's openPodLogs) — same opt openLocalShell already
    // honours, needed here too now that a split is the default way in.
    if (opts.explorer === false) setPaneExplorerVisible(newPane, false);
    await startLocalTerm(newPane, opts.cwd || pane.cwd, {
      shell: opts.shell, blank: opts.blank, command: opts.command, args: opts.args, env: opts.env,
    });
  } else {
    const conn = state.getConnection(newPane.connId);
    if (conn?.state === 'connected') {
      // Already dialled: the explorer only needs the listing, not a shell.
      if (filesOnly) newPane.explorer?.ensureLoaded();
      else {
        await startRemoteTerm(newPane);
        if (opts.remoteStartPath) sendToPane(newPane, `cd ${JSON.stringify(opts.remoteStartPath)}\n`);
        // Same as openHost/connectPane below — a profile opened as a split
        // keeps its startup command rather than silently dropping it.
        if (opts.startupCommand) sendToPane(newPane, opts.startupCommand.replace(/\n*$/, '\n'));
      }
    } else {
      connectPane(newPane, { noTerminal: filesOnly, remoteStartPath: opts.remoteStartPath, startupCommand: opts.startupCommand });
    }
  }
  if (!filesOnly) newPane.view.fitNow();
  state.emit('tabs');
  return newPane;
}

/**
 * Move the focused pane one place in `dir` ('left' | 'right' | 'up' | 'down').
 *
 * The neighbour is found by where the panes actually are on screen rather than
 * by walking the tree, because "the one to my left" is a thing the eye decides,
 * not the nesting. With a neighbour the two trade places; with none — the pane
 * is already against that edge — it is pulled out and laid along the edge
 * instead, which is how a side-by-side pair becomes a stack.
 */
/**
 * Give a pane a tab of its own.
 *
 * A split is for two things you are watching together; a tab is for two
 * things you are doing separately, and a pane often starts as the first and
 * becomes the second. Before this the only way across was to close it and
 * reopen the host, which drops whatever was running in it.
 *
 * Nothing is reconnected: the pane keeps its terminal, its scrollback, its
 * explorer and its running process, and only its place in the layout
 * changes.
 */
export function movePaneToNewTab(paneId = state.activePaneId) {
  const pane = state.getPane(paneId);
  if (!pane) return false;
  const from = state.getTab(pane.tabId);
  if (!from) return false;
  if (state.panesOf(from.id).length < 2) {
    status('That pane already has a tab to itself');
    return false;
  }

  state.detachPane(paneId);
  /*
   * Sizes belonged to the split it has just left — on both sides. The pane
   * is about to be the whole of a tab, and the panes left behind have to
   * share out the space it was using.
   */
  pane.element.style.flex = '';
  for (const id of state.panesOf(from.id)) {
    const p = state.getPane(id);
    if (p) p.element.style.flex = '';
  }

  const conn = pane.connId ? state.getConnection(pane.connId) : null;
  const tab = state.createTab({
    title: conn?.label || pane.title || (pane.kind === 'local' ? 'Local shell' : 'Session'),
    kind: pane.kind,
    connId: pane.connId,
  });
  pane.tabId = tab.id;
  tab.root = paneNode(pane.id);

  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();
  updatePaneFocusRing();
  setTimeout(() => pane.view.fitNow(), 30);
  return true;
}

/* ------------------------------------------------------------------ */
/* Handing a pane to another window                                    */
/* ------------------------------------------------------------------ */

/* How much scrollback travels with a pane. The buffer lives in this
 * window's terminal and cannot be handed over as an object, so it goes as
 * text — enough to keep the session readable, not so much that the handoff
 * is a megabyte of IPC. */
const CARRY_SCROLLBACK = 120000;

/**
 * Move a pane into a window of its own.
 *
 * The session is not restarted and nothing is reconnected: the connection
 * and the pty live in the main process, which broadcasts terminal output to
 * every window, so a pane in a new window that knows the same terminal id
 * simply starts receiving it. What cannot travel is the xterm buffer — it
 * is a live object in this window — so the text goes with it and is written
 * into the new terminal before it opens.
 *
 * The old pane is then dropped **without closing anything**: the ordinary
 * close path would kill the pty, which is precisely what must not happen to
 * a session being moved.
 */
export async function popPaneToWindow(paneId = state.activePaneId) {
  const pane = state.getPane(paneId);
  if (!pane) return false;
  if (pane.isHosts) { status('A hosts pane belongs to its window'); return false; }
  if (!pane.termId) { status('That pane has nothing running in it yet'); return false; }

  const conn = pane.connId ? state.getConnection(pane.connId) : null;
  let text = '';
  try { text = pane.view.allText(); } catch { /* an unreadable buffer moves as an empty one */ }
  if (text.length > CARRY_SCROLLBACK) text = text.slice(-CARRY_SCROLLBACK);

  const adopt = {
    kind: pane.kind,
    connId: pane.connId || null,
    termId: pane.termId,
    title: conn?.label || pane.title || null,
    login: conn?.login || null,
    cwd: pane.cwd || null,
    remoteHome: pane.remoteHome || null,
    explorerVisible: !!pane.explorerVisible,
    scrollback: text,
  };

  try {
    await window.api.window.create({ adopt });
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }

  /*
   * Let go of it here. The pty keeps running — the new window owns it now —
   * so this drops the pane's own furniture and nothing else: no term.close,
   * no conn.disconnect.
   */
  const tab = state.getTab(pane.tabId);
  const alone = state.panesOf(pane.tabId).length < 2;
  forgetPane(paneId);
  state.detachPane(paneId);
  try { pane.explorer?.dispose?.(); } catch { /* the pane is going regardless */ }
  try { pane.view.dispose(); } catch { /* the pane is going regardless */ }
  pane.element.remove();
  state.panes.delete(paneId);
  if (tab && alone) closeTab(tab.id, { skipPanes: true });
  else for (const id of state.panesOf(tab?.id)) state.getPane(id)?.element.style.setProperty('flex', '');
  if (state.activePaneId === paneId) {
    const next = tab ? state.firstPaneOf(tab) : null;
    state.activePaneId = next || null;
  }
  state.emit('tabs');
  renderPanes();
  return true;
}

/**
 * The other side of it: a window started to receive a pane.
 *
 * Called once at startup in place of restoring a workspace. The terminal
 * already exists, so this must not open one — it binds to the id it was
 * given, writes the scrollback it was handed, and lets the first fit tell
 * the pty its new size.
 */
export async function adoptPane(adopt) {
  if (!adopt?.termId) return false;

  // The connection belongs to the main process, so this window can simply
  // be told about it.
  if (adopt.connId) {
    try {
      const all = await window.api.conn.list();
      const c = all.find((x) => x.id === adopt.connId);
      if (c) state.setConnection(c.id, { ...c, state: c.state || 'connected' });
    } catch { /* the connection state catches up on its next event */ }
  }

  const tab = state.createTab({
    title: adopt.title || (adopt.kind === 'local' ? 'Local shell' : 'Session'),
    kind: adopt.kind,
    connId: adopt.connId || undefined,
  });
  const pane = await createPane({ tabId: tab.id, kind: adopt.kind, connId: adopt.connId || null });
  tab.root = paneNode(pane.id);
  state.activeTabId = tab.id;
  state.setActivePane(pane.id);
  state.emit('tabs');
  renderPanes();

  pane.termId = adopt.termId;
  pane.status = 'connected';
  pane.cwd = adopt.cwd || null;
  pane.remoteHome = adopt.remoteHome || null;
  if (adopt.scrollback) pane.view.write(adopt.scrollback.replace(/\n/g, '\r\n'));
  setPaneExplorerVisible(pane, !!adopt.explorerVisible);
  refreshPaneTitles();
  // The pty is still sized for the window it came from.
  setTimeout(() => { pane.view.fitNow(); syncPtySize(pane); pane.view.focus(); }, 60);
  return true;
}

/* ------------------------------------------------------------------ */
/* Dragging a pane                                                     */
/* ------------------------------------------------------------------ */

/*
 * Which pane is being dragged, for the drop targets to read.
 *
 * `dragover` is not allowed to see the payload — the browser withholds it
 * until the drop — so a target cannot otherwise tell a pane drag from a
 * file drag and would light up for both.
 */
let dragPaneId = null;

export function draggingPaneId() { return dragPaneId; }

/** The MIME type is ours, so nothing else mistakes this for its own drag. */
const PANE_MIME = 'application/x-serverlife-pane';

/**
 * A pane can be picked up by its header and put somewhere else.
 *
 * Three places, and the gesture is the same for all of them: another pane
 * in this tab swaps the two, a tab in the strip moves it into that tab, and
 * the empty end of the strip gives it a tab of its own. The menu has always
 * offered the last of those and the arrow keys the first; a drag is how
 * people expect to say it, and it was the one way that did nothing.
 *
 * The pane object itself never moves — only its place in a tree — so the
 * terminal, its scrollback and anything running carry on without noticing.
 */
function wirePaneDrag(element, head, paneId) {
  head.addEventListener('dragstart', (e) => {
    // A drag that starts on a button is that button's business.
    if (e.target.closest('button, input, select')) { e.preventDefault(); return; }
    dragPaneId = paneId;
    try {
      e.dataTransfer.setData(PANE_MIME, paneId);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setDragImage(element, 40, 20);
    } catch { /* a drag without a payload is simply not dropped anywhere */ }
    element.classList.add('dragging');
  });
  head.addEventListener('dragend', (e) => {
    const wasDragging = dragPaneId;
    dragPaneId = null;
    element.classList.remove('dragging');
    for (const n of document.querySelectorAll('.pane.dropinto, .tab.dropinto')) n.classList.remove('dropinto');
    document.querySelector('#tabstrip')?.classList.remove('dropnew');
    /*
     * Dropped outside the window entirely: that is the gesture for "give
     * this its own window", and it is the one people try first. `dropEffect`
     * is none because nothing in the page took it, and the pointer being
     * outside the frame is what distinguishes a deliberate drag-out from a
     * drag abandoned over the app.
     */
    if (!wasDragging || e.dataTransfer?.dropEffect !== 'none') return;
    const outside = e.screenX < window.screenX || e.screenY < window.screenY
      || e.screenX > window.screenX + window.outerWidth
      || e.screenY > window.screenY + window.outerHeight;
    if (outside) popPaneToWindow(wasDragging);
  });

  /*
   * The whole pane is the target, not just its header: aiming at a header
   * to swap two panes is a precision game for no reason. The file browser
   * inside a pane keeps its own drops — it is dropped *into*, with files —
   * so a pane drag over it is left alone.
   */
  const overOwnFiles = (e) => !!e.target.closest?.('.pane-files');
  element.addEventListener('dragover', (e) => {
    if (!dragPaneId || dragPaneId === paneId || overOwnFiles(e)) return;
    const other = state.getPane(dragPaneId);
    if (!other || other.tabId !== state.getPane(paneId)?.tabId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    element.classList.add('dropinto');
  });
  element.addEventListener('dragleave', (e) => {
    if (element.contains(e.relatedTarget)) return;
    element.classList.remove('dropinto');
  });
  element.addEventListener('drop', (e) => {
    element.classList.remove('dropinto');
    if (!dragPaneId || dragPaneId === paneId || overOwnFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const moved = dragPaneId;
    dragPaneId = null;
    swapPanesById(moved, paneId);
  });
}

/**
 * Move a pane into another tab, keeping everything running in it.
 *
 * The pane object never changes hands — only its place in a tree does — so
 * the terminal, its scrollback, the file browser beside it and whatever is
 * running carry on without noticing. That is the same trick "move to its
 * own tab" has always used; this one gives the pane to a tab that already
 * exists, splitting it beside whatever is there.
 */
export function movePaneToTab(paneId, tabId, { dir = 'row' } = {}) {
  const pane = state.getPane(paneId);
  const tab = state.getTab(tabId);
  if (!pane || !tab || pane.tabId === tabId) return false;

  const from = state.getTab(pane.tabId);
  state.detachPane(paneId);
  // Sizes belonged to the split it has left, and to the one it joins.
  pane.element.style.flex = '';
  for (const id of [...(from ? state.panesOf(from.id) : []), ...state.panesOf(tabId)]) {
    const p = state.getPane(id);
    if (p) p.element.style.flex = '';
  }

  pane.tabId = tabId;
  const host = state.firstPaneOf(tab);
  tab.root = host ? splitTree(tab.root, host, paneId, dir) : paneNode(paneId);

  /*
   * A tab emptied by the move has nothing left to draw. Closing it is what
   * the user means — they moved its only pane away — and leaving an empty
   * tab behind would be a tab that cannot be closed by closing its panes.
   */
  if (from && from.id !== tabId && !state.panesOf(from.id).length) {
    // Its panes are gone by definition, so nothing is closed with it.
    closeTab(from.id, { skipPanes: true });
  }

  state.activeTabId = tabId;
  state.setActivePane(paneId);
  state.emit('tabs');
  renderPanes();
  updatePaneFocusRing();
  setTimeout(() => pane.view.fitNow(), 30);
  return true;
}

/** Swap two panes' places in their tab's layout. */
export function swapPanesById(aId, bId) {
  const a = state.getPane(aId);
  const b = state.getPane(bId);
  if (!a || !b || a.id === b.id || a.tabId !== b.tabId) return false;
  const tab = state.getTab(a.tabId);
  if (!tab) return false;
  tab.root = swapPanes(tab.root, a.id, b.id);
  // Sizes belong to the slot, not to the pane that was sitting in it.
  a.element.style.flex = '';
  b.element.style.flex = '';
  renderPanes();
  updatePaneFocusRing();
  setTimeout(() => { a.view.fitNow(); b.view.fitNow(); }, 30);
  return true;
}

export async function movePane(dir, paneId = state.activePaneId) {
  const pane = state.getPane(paneId);
  if (!pane) return false;
  const tab = state.getTab(pane.tabId);
  if (!tab || !tab.root) return false;

  const others = [...state.panesOf(tab.id)].filter((id) => id !== pane.id).map((id) => state.getPane(id)).filter(Boolean);
  if (!others.length) return false;

  const target = nearestPane(pane, others, dir);
  if (target) {
    tab.root = swapPanes(tab.root, pane.id, target.id);
    // Sizes belong to the slot, not to the pane that was sitting in it.
    pane.element.style.flex = '';
    target.element.style.flex = '';
  } else {
    // Already hard against that edge — but if it shares its split with
    // somebody, it can still become the whole edge.
    const before = tab.root;
    tab.root = movePaneToEdge(tab.root, pane.id, dir);
    if (tab.root === before) return false;
    for (const id of state.panesOf(tab.id)) {
      const p = state.getPane(id);
      if (p) p.element.style.flex = '';
    }
  }

  renderPanes();
  state.setActivePane(pane.id);
  updatePaneFocusRing();
  state.emit('tabs');
  return true;
}

/** The pane a human would call "the next one that way". */
function nearestPane(pane, others, dir) {
  const r = pane.element.getBoundingClientRect();
  const horizontal = dir === 'left' || dir === 'right';
  const back = dir === 'left' || dir === 'up';

  let best = null;
  let bestGap = Infinity;
  for (const other of others) {
    const o = other.element.getBoundingClientRect();
    // Must overlap across the other axis, or it is not beside this pane at all.
    const overlap = horizontal
      ? Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)
      : Math.min(r.right, o.right) - Math.max(r.left, o.left);
    if (overlap <= 1) continue;
    const gap = horizontal
      ? (back ? r.left - o.right : o.left - r.right)
      : (back ? r.top - o.bottom : o.top - r.bottom);
    if (gap < -1) continue;           // behind us, or the same slot
    if (gap < bestGap) { bestGap = gap; best = other; }
  }
  return best;
}

export async function duplicateActiveTab() {
  const pane = state.activePane;
  if (!pane) return;
  if (pane.kind === 'local') return openLocalShell(pane.cwd);
  const conn = state.getConnection(pane.connId);
  if (!conn) return;
  const tab = state.createTab({ title: conn.label, kind: 'remote', connId: pane.connId });
  const np = await createPane({ tabId: tab.id, kind: 'remote', connId: pane.connId });
  tab.root = paneNode(np.id);
  state.activeTabId = tab.id;
  state.setActivePane(np.id);
  state.emit('tabs');
  renderPanes();
  if (conn.state === 'connected') await startRemoteTerm(np);
  else connectPane(np);
}

/**
 * The panes that were sharing a split with this one.
 *
 * Asked *before* the pane is taken out, because removing it collapses the
 * split and the answer disappears with it.
 */
function splitNeighbours(tab, paneId) {
  const under = (node, out) => {
    if (!node) return out;
    if (node.type === 'pane') out.push(node.paneId);
    else node.children.forEach((c) => under(c, out));
    return out;
  };
  let found = null;
  const walk = (node) => {
    if (!node || node.type === 'pane' || found) return;
    if (node.children.some((c) => c.type === 'pane' && c.paneId === paneId)) {
      found = node.children.filter((c) => !(c.type === 'pane' && c.paneId === paneId));
      return;
    }
    node.children.forEach(walk);
  };
  walk(tab?.root);
  return (found || []).reduce((acc, n) => under(n, acc), []);
}

export function closePane(paneId, { animate = true } = {}) {
  const pane = state.getPane(paneId);
  if (!pane) return;
  // An AI assistant lives in the panel on the right, not in a tab.
  if (pane.aiSession) { pane.aiSession.close(); return; }
  const tabId = pane.tabId;
  /*
   * Who inherits the space, noted before the tree changes.
   *
   * Dragging a splitter sets `flex: 0 0 <px>` on both sides — a fixed basis
   * with no grow — so a pane that has ever been resized keeps that exact
   * width for good. Close its neighbour and it stays the size it was, with a
   * gap where the other pane used to be, and it will not grow when the
   * window does either. The sizes belonged to a split that no longer exists,
   * so they go with it.
   */
  const neighbours = splitNeighbours(state.getTab(tabId), paneId);

  // A macro on a timer belongs to this pane; it goes with it.
  import('./macros.js').then(({ stopRepeatsForPane }) => stopRepeatsForPane(paneId)).catch(() => {});

  endPaneSession(pane);
  pane.localExplorer?.destroy();
  pane.explorer?.destroy();
  // A kube-browser pane's own 3D view, if it was ever opened — the WebGL
  // context otherwise outlives the pane that owned it.
  pane.kube3d?.destroy();
  // A Log Viewer pane's own spawned kubectl process — otherwise it keeps
  // tailing, unseen, until the app quits (kubelogs.stopAll()'s own backstop).
  pane.klvStop?.();
  // A kube-browser pane's own CPU/memory history poll, same reasoning.
  pane.kubeMetricsStop?.();

  /*
   * The session above has already ended for real — what is left is only
   * the pane's own DOM node, canvas and all. An animation, when one plays,
   * holds onto exactly that node and nothing else, so disposing the
   * terminal and discarding it waits for the animation; the layout below
   * reflows immediately regardless; `animate: false` is for a close that
   * is not really the user closing anything (a reopen under a different
   * transport, a failed tmux attach) and skips the show entirely, the way
   * this always worked before there was one.
   */
  const node = pane.element;
  const playAnim = animate && shouldAnimatePaneClose();
  const rect = playAnim ? node.getBoundingClientRect() : null;
  const finish = () => { pane.view.dispose(); node.remove(); };
  if (!playAnim) finish();
  state.removePane(paneId);

  const tab = state.getTab(tabId);
  if (!tab || !tab.root) {
    closeTab(tabId, { skipPanes: true });
    if (playAnim) playCloseAnimation(node, rect).then(finish);
    return;
  }

  for (const id of neighbours) {
    const p = state.getPane(id);
    if (p) p.element.style.flex = '';
  }

  renderPanes();
  if (playAnim) playCloseAnimation(node, rect).then(finish);
  const first = state.firstPaneOf(tab);
  if (first) state.setActivePane(first);
  // The survivors are a different size now, so their terminals need to agree
  // with the space they actually occupy.
  setTimeout(() => {
    for (const id of state.panesOf(tabId)) state.getPane(id)?.view.fitNow();
  }, 30);
}

/**
 * Ask before closing what would end a live session, then close it.
 *
 * `closeTab` and `closePane` stay unconditional: they are also how panes are
 * moved between tabs, how a saved layout replaces what is open and how a
 * closed tmux window takes its tab with it, none of which should stop to ask.
 * These are for a person closing something — the tab's ×, its menu, ⌘W — and
 * ask only when something would actually be lost: a shell on a host, a port
 * forward, a console, a screen. A local shell is not asked about, nor is a
 * tmux tab, which only detaches and keeps running.
 */
export async function confirmClosing({ tabIds = [], paneIds = [] } = {}) {
  if (state.settings.confirmCloseWithSessions === false) return true;
  const live = liveSessionsIn(state, { tabIds, paneIds });
  if (!live.length) return true;
  const names = [...new Set(live.map((x) => `${x.name} (${x.kind})`))];
  const what = paneIds.length && !tabIds.length ? 'this pane'
    : tabIds.length > 1 ? `these ${tabIds.length} tabs` : 'this tab';
  const again = checkbox('Do not ask again', false);
  const ok = await modal({
    title: `Close ${what}?`,
    width: 460,
    render: (body) => {
      body.append(
        el('div', { style: 'font-size:13px;margin-bottom:6px',
          text: live.length === 1
            ? 'A session is open in it, and closing ends it:'
            : `${live.length} sessions are open in it, and closing ends them:` }),
        el('ul', { style: 'margin:0 0 10px;padding-left:18px;font-size:12.5px' },
          ...names.slice(0, 8).map((n) => el('li', { text: n })),
          names.length > 8 ? el('li', { text: `and ${names.length - 8} more` }) : null),
        el('div', { class: 'hint', style: 'margin-bottom:10px' },
          'Whatever is running in them stops. A tmux session would keep running \u2014 '
          + 'open it in tmux to be able to close the window and come back.'),
        again);
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Close', class: 'primary-btn', value: true, autofocus: true },
    ],
  });
  if (ok === true && again.input.checked) {
    state.settings = await window.api.settings.set({ confirmCloseWithSessions: false });
    status('Closing tabs will not ask again \u2014 turn it back on in Settings');
  }
  return ok === true;
}

/** Close a tab as a person does: asking first if it would end a session. */
export async function requestCloseTab(tabId) {
  if (await confirmClosing({ tabIds: [tabId] })) closeTab(tabId, { animate: true });
}

/** Close several tabs, asking once about all of them. */
export async function requestCloseTabs(tabIds) {
  if (!tabIds.length) return;
  if (await confirmClosing({ tabIds })) for (const id of tabIds) closeTab(id, { animate: true });
}

/** Close a pane as a person does — ⌘W — asking first if it is live. */
export async function requestClosePane(paneId) {
  if (await confirmClosing({ paneIds: [paneId] })) closePaneByHand(paneId);
}

/**
 * Close a pane because a person asked to — its ✕, ⌘W, *Close pane*. For a
 * tmux pane that means closing it in tmux as well (killTmuxPane), and tmux's
 * next layout removes it here; anything else, or a tmux pane no longer
 * attached, closes as before.
 */
export async function closePaneByHand(paneId) {
  const pane = state.getPane(paneId);
  if (pane?.kind === 'tmux') {
    const { killTmuxPane } = await import('./tmux.js');
    if (await killTmuxPane(pane)) return;
  }
  closePane(paneId);
}

/**
 * `animate` plays `closePane`'s own close animation on every pane the tab
 * is carrying down with it, all at once rather than one after another —
 * closing a split-up tab used to just drop its panes instantly, the only
 * way a pane ever went away without the show the single-pane path always
 * got. Defaulting to off, same reasoning as `closePane`'s own default: most
 * callers here are not a person closing anything — a layout being restored,
 * a pane moved to another tab, a tmux window that closed on its own — and
 * those should not suddenly get a performance nobody asked to watch.
 */
export function closeTab(tabId, { skipPanes, animate = false } = {}) {
  const tab = state.getTab(tabId);
  if (!tab) return;

  if (!skipPanes) {
    const playAnim = animate && shouldAnimatePaneClose();
    for (const pid of state.panesOf(tabId)) {
      const p = state.getPane(pid);
      if (!p) continue;
      import('./macros.js').then(({ stopRepeatsForPane }) => stopRepeatsForPane(pid)).catch(() => {});
      endPaneSession(p);
      p.localExplorer?.destroy();
      p.explorer?.destroy();
      p.kube3d?.destroy();
      const node = p.element;
      // The rect, and the real teardown below, both have to happen before
      // the tab itself is torn down further down — `playCloseAnimation`
      // re-parents the node into its own overlay right away, but only if
      // it is still where `getBoundingClientRect` found it.
      const rect = playAnim ? node.getBoundingClientRect() : null;
      if (playAnim) playCloseAnimation(node, rect).then(() => p.view.dispose());
      else { p.view.dispose(); node.remove(); }
      forgetPane(pid);
      state.panes.delete(pid);
    }
  }

  const connId = tab.connId;
  state.removeTab(tabId);

  // Drop the connection once no tab is using it any more.
  if (connId) {
    const stillUsed = state.tabs.some((t) => t.connId === connId);
    if (!stillUsed) {
      window.api.conn.disconnect(connId).catch(() => {});
      state.removeConnection(connId);
    }
  }
  renderPanes();
}

/* ------------------------------------------------------------------ */
/* Rendering the pane tree                                             */
/* ------------------------------------------------------------------ */

export function renderPanes() {
  const root = paneRoot();
  clear(root);

  const tab = state.getTab(state.activeTabId);
  $('#empty-state').classList.toggle('hidden', !!tab);
  root.classList.toggle('hidden', !tab);
  if (!tab || !tab.root) return;

  root.append(buildNode(tab.root));

  // Re-fit every visible terminal after layout settles.
  requestAnimationFrame(() => {
    for (const pid of state.panesOf(tab.id)) state.getPane(pid)?.view.fitNow();
  });
  updatePaneFocusRing();
}

function buildNode(node) {
  if (node.type === 'pane') {
    const pane = state.getPane(node.paneId);
    if (!pane) return el('div');
    if (!pane.view.container) pane.view.attach(pane.element.querySelector('.pane-term'));
    return pane.element;
  }
  const wrap = el('div', { class: 'pane-split ' + (node.dir === 'col' ? 'col' : 'row') });
  node.children.forEach((child, i) => {
    if (i > 0) wrap.append(makeSplitResizer(wrap, node.dir));
    wrap.append(buildNode(child));
  });
  return wrap;
}

function makeSplitResizer(wrap, dir) {
  const r = el('div', { class: dir === 'col' ? 'h-resizer' : 'v-resizer' });
  r.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const prev = r.previousElementSibling;
    const next = r.nextElementSibling;
    if (!prev || !next) return;
    const horizontal = dir !== 'col';
    const startPos = horizontal ? e.clientX : e.clientY;
    const prevSize = horizontal ? prev.offsetWidth : prev.offsetHeight;
    const nextSize = horizontal ? next.offsetWidth : next.offsetHeight;
    r.classList.add('dragging');

    const move = (ev) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
      const a = Math.max(80, prevSize + delta);
      const b = Math.max(80, nextSize - delta);
      prev.style.flex = `0 0 ${a}px`;
      next.style.flex = `0 0 ${b}px`;
    };
    const up = () => {
      r.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      for (const pid of state.panesOf(state.activeTabId)) state.getPane(pid)?.view.fitNow();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  return r;
}

/**
 * Mark the panes with a macro on a timer. The run button is where the repeat
 * was started and where it is stopped, so it is where the fact belongs.
 */
function updateMacroButtons() {
  import('./macros.js').then(({ repeatsOnPane, fmtEvery }) => {
    for (const pane of state.panes.values()) {
      const btn = pane.head?.querySelector('.pmacro');
      if (!btn) continue;
      const running = repeatsOnPane(pane.id);
      btn.classList.toggle('repeating', running.length > 0);
      btn.title = running.length
        ? running.map((r) => `${r.macro.name} — every ${fmtEvery(r.every)}`).join('\n') + '\n\nClick to stop or run another'
        : 'Run a macro on this host (⌘⇧R)';
    }
  }).catch(() => {});
}
state.on('macro-repeats', updateMacroButtons);

/**
 * Paint each pane with its host's colour.
 *
 * A bar down the pane's edge and the host name in that colour: enough to know
 * which pane is production without reading it, and little enough that four
 * panes do not turn into a paint chart. Called when a colour changes and when
 * a pane connects, since the host is only known then.
 */
/** Show or hide the per-pane buttons that are a matter of preference. */
export function applyPaneButtons() {
  const showNet = state.settings.showPaneNetIcon !== false;
  for (const pane of state.panes.values()) {
    pane.head?.querySelector('.pnet')?.classList.toggle('hidden', !showNet);
  }
}

export function applyHostColors() {
  import('./sidebar.js').then(({ hostColorForConn }) => {
    for (const pane of state.panes.values()) {
      const conn = pane.connId ? state.getConnection(pane.connId) : null;
      const colour = conn ? hostColorForConn(conn) : '';
      pane.element.classList.toggle('coloured', !!colour);
      if (colour) pane.element.style.setProperty('--host-color', colour);
      else pane.element.style.removeProperty('--host-color');
    }
  }).catch(() => {});
}

export function updatePaneFocusRing() {
  for (const pane of state.panes.values()) {
    pane.element.classList.toggle('focused', pane.id === state.activePaneId);
  }
}

/* ------------------------------------------------------------------ */
/* Terminal data routing                                               */
/* ------------------------------------------------------------------ */

const MFA_FAILED_RE = /authentication canceled|authenticate: .*cancel|MFA authentication with \w+ failed|failed to verify WebAuthn|ERROR: authenticate/i;

/**
 * A path short enough for a title: the home directory as `~`, and only the
 * last couple of segments of anything long — the end of a path is the part
 * that says where you are.
 */
export function shortCwd(p, { home } = {}) {
  let out = String(p || '');
  if (!out) return '';
  const h = home || state.appInfo?.home;
  if (h && (out === h || out.startsWith(h + '/'))) out = '~' + out.slice(h.length);
  if (out.length <= 24) return out;
  const parts = out.split('/').filter(Boolean);
  return (out.startsWith('~') ? '' : '…/') + parts.slice(-2).join('/');
}

/**
 * What a pane is: who you are, where you are, and on what.
 *
 * A row of tabs all saying "Local shell", or four sessions on one host all
 * saying the host's name, tells you nothing — the username and the directory
 * are what distinguish them, and they are exactly what a terminal's own title
 * bar has always carried.
 */
export function paneTitle(pane, { long = false } = {}) {
  if (!pane) return '';
  // A hosts pane is not running anything, so nothing can be read off a
  // shell or a connection: its own title is the whole answer.
  if (pane.isHosts) return pane.title || 'Hosts';
  // Same reasoning for KubeLife's full-cluster browser — it is a 'local'
  // pane only as a mechanism (see makeKubeBrowserPane), with no cwd of its
  // own, so without this it fell through to the generic local-shell case
  // below and read as plain "local".
  if (pane.isKubeBrowser) return pane.title || 'Kubernetes';
  /*
   * A tmux pane is named by the window it is in, not by the pane id: `%7` is
   * how the protocol refers to it and means nothing to anyone reading a tab
   * strip. The host comes after, as it does everywhere else.
   */
  if (pane.kind === 'tmux') {
    const label = [pane.tmuxWindowName, pane.tmuxHost].filter(Boolean).join(' \u00b7 ');
    return long ? `${label} \u00b7 tmux ${pane.tmuxPane || ''}`.trim() : (label || 'tmux');
  }
  if (pane.kind === 'device') return pane.title || 'console';
  if (pane.kind === 'vnc') return pane.title || 'screen';
  // A KubeLife exec session is a 'local' pane underneath (see kubepanel.js's
  // openPodExec — it runs kubectl, not a shell, with no Connection behind
  // it, exactly the way a local shell runs a program) — but it should read
  // as the pod it is in, not as the directory the kubectl process was
  // started from.
  if (pane.kubeExec) return pane.title || 'kube exec';
  // Same reasoning, for a `kubectl logs -f` pane (see kubepanel.js's openPodLogs).
  if (pane.kubeLogs) return pane.title || 'kube logs';
  const dir = shortCwd(pane.cwd, pane.kind === 'local' ? {} : { home: pane.remoteHome });

  if (pane.kind === 'local') {
    const named = state.settings.showShellInTitle && pane.shellName;
    const shell = named ? pane.shellName + (pane.blankShell ? ' (blank)' : '') : 'local';
    return dir ? `${shell}: ${dir}` : shell;
  }

  const conn = pane.connId ? state.getConnection(pane.connId) : null;
  if (!conn) return pane.title || '';
  const login = conn.login || conn.user || '';
  // The hostname, without the cluster suffix the label carries: the cluster is
  // in the sidebar and in the tooltip, and a title has to fit.
  const host = conn.hostname || String(conn.label || '').replace(/\s*\(.*\)$/, '');
  const who = (login ? `${login}@${host}` : host) + (conn.dupe ? ` \u00b7 ${conn.dupe}` : '');
  if (long) {
    /*
     * The bracketed part of a label is the cluster for a Teleport node and the
     * login for an ssh_config host — so only the first is worth appending, or
     * an ssh session reads "ubuntu@host ~ · ubuntu".
     */
    const cluster = conn.type === 'teleport'
      ? (conn.cluster || String(conn.label || '').match(/\(([^)]+)\)$/)?.[1])
      : '';
    return [who, dir, cluster ? `· ${cluster}` : ''].filter(Boolean).join(' ');
  }
  return dir ? `${who}: ${dir}` : who;
}

/** Put the current titles on a pane's header and the tab strip. */
export function refreshPaneTitles() {
  for (const pane of state.panes.values()) {
    const name = pane.head?.querySelector('.pname');
    if (!name) continue;
    const text = paneTitle(pane);
    if (name.textContent !== text) name.textContent = text;
    name.title = paneTitle(pane, { long: true });
  }
  state.emit('tabs');
}

/**
 * Which host's preferences this pane obeys.
 *
 * The same key the sidebar and the main process use — a Teleport node's uuid,
 * an ssh host's id — so a setting made from the host list applies to the pane
 * and the other way round. A local shell has no host, and answers null.
 */
export function paneHostKey(pane) {
  if (!pane || pane.kind === 'local') return null;
  const conn = state.getConnection(pane.connId);
  if (!conn?.hostId) return null;
  const { hostById, hostPrefKey } = sidebarHelpers();
  const host = hostById ? hostById(conn.hostId) : null;
  // A host that has left the inventory (logged out, deleted from the config)
  // still has its id, which is the key for everything except a uuid.
  return host ? hostPrefKey(host) : conn.hostId;
}

// Imported lazily: sidebar.js imports this module, so a static import back
// would close a cycle that breaks the bundle's initialisation order.
let _sidebar = null;
function sidebarHelpers() {
  return _sidebar || {};
}
export function registerSidebarHelpers(h) { _sidebar = h; }

/**
 * Write a terminal's buffer out to a file.
 *
 * The scrollback is the record of what happened in a session, and until now it
 * could only leave through the clipboard. Saved as plain text — the colours
 * are escape sequences, and a file full of them is worse than useless in every
 * other tool.
 */
export async function savePaneText(pane) {
  const text = pane.view.allText();
  if (!text) return status('Nothing in this terminal yet');
  const label = (pane.kind === 'local' ? 'local' : (state.getConnection(pane.connId)?.label || 'session'))
    .replace(/[^\w.-]+/g, '_');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  try {
    const r = await window.api.dialog.saveText({
      text,
      title: 'Save terminal output',
      defaultPath: `${label}-${stamp}.txt`,
    });
    if (r) {
      status(`Saved ${r.path}`);
      toast(`Terminal saved — ${label}`, 'success');
    }
  } catch (e) { toast(e.message, 'error'); }
}

/** Everything the terminal is about to show, with keywords coloured. */
/**
 * Put bytes on a pane's screen, highlighting and activity marks included.
 *
 * Exported because a tmux pane's output does not arrive through any of the
 * terminal channels — it comes tagged with a pane id on the session's own
 * stream — and it should still look and behave exactly like every other
 * pane's output once it lands.
 */
export function writeToPaneView(pane, data) { writeToPane(pane, data); }

function writeToPane(pane, data) {
  // Every byte of every session passes here, which makes it the one honest
  // place to judge whether a tab is doing anything.
  noteOutput(pane.id, data);
  if (!pane.highlight) { pane.view.write(data); return; }
  try {
    pane.view.write(highlightChunk(data, pane.highlight, pane.highlightState));
  } catch {
    // Never let a highlighting slip swallow output.
    pane.view.write(data);
  }
}

export function routeTermData(connId, { id, data }) {
  for (const pane of state.panes.values()) {
    if (pane.termId === id && pane.connId === connId) {
      writeToPane(pane, data);
      watchForMfaFailure(pane, data);
      return;
    }
  }
}

/**
 * Keep a little of a tsh session's output so that, *if* it exits without ever
 * reaching a shell, we can tell an abandoned MFA ceremony from an ordinary
 * disconnect. Nothing is shown while the session may still succeed — covering
 * a terminal that is about to work would be worse than saying nothing.
 */
function watchForMfaFailure(pane, data) {
  const conn = state.getConnection(pane.connId);
  if (!conn || conn.transport !== 'tsh') return;
  pane._mfaTail = ((pane._mfaTail || '') + data).slice(-1200);
  // A shell prompt means the session got through; stop watching.
  if (/[$#%>]\s$/.test(pane._mfaTail) || /Welcome to|Last login/i.test(pane._mfaTail)) {
    pane._mfaSucceeded = true;
  }
}

/** Called when a tsh session's process exits. */
function offerMfaAlternatives(pane) {
  const conn = state.getConnection(pane.connId);
  if (!conn || conn.transport !== 'tsh' || pane._mfaOffered) return false;
  if (pane._mfaSucceeded) return false;
  if (!MFA_FAILED_RE.test(pane._mfaTail || '')) return false;

  pane._mfaOffered = true;
  const current = conn.mfaMode || state.settings.mfaMode || 'platform';
  showOverlay(pane, {
    title: 'MFA was not completed',
    sub: `${conn.label} — tried ${mfaLabel(current)}`,
    error: 'The prompt was cancelled or timed out, so the session did not open.',
    mfaAlternatives: {
      current,
      retry: (mode) => retryWithMfaMode(pane, mode),
      copyCommand: () => {
        window.api.conn.log(pane.connId).then((entries) => {
          const line = entries.find((e) => e.stream === 'sys' && e.text.startsWith('$ '));
          const cmd = line ? line.text.replace(/^\$ /, '').trim() : '';
          window.api.clipboard.write(cmd);
          status('Command copied — run it in Terminal if the OS prompt will not appear here');
        });
      },
    },
  });
  return true;
}

function mfaLabel(mode) {
  return ({
    platform: 'Touch ID',
    'cross-platform': 'security key',
    otp: 'an OTP code',
    browser: 'the browser',
    auto: 'automatic',
  })[mode] || mode;
}

/** Reopen this pane's host with a different MFA method. */
async function retryWithMfaMode(pane, mode) {
  const conn = state.getConnection(pane.connId);
  if (!conn) return;
  const host = findHostById(conn.hostId);
  if (!host) return toast('Host is no longer in the inventory', 'error');
  const login = conn.login || undefined;
  const tabId = pane.tabId;
  closePane(pane.id, { animate: false });
  if (state.getTab(tabId)) closeTab(tabId);
  // Remember the working method so the next connection starts with it.
  window.api.settings.set({ mfaMode: mode }).then((s2) => { state.settings = s2; }).catch(() => {});
  await openHost(host, { login, transport: 'tsh', reuse: false, mfaMode: mode });
}

export function routeLocalTermData({ id, data }) {
  for (const pane of state.panes.values()) {
    if (pane.termId === id && pane.kind === 'local') { writeToPane(pane, data); return; }
  }
}

/**
 * Output from a serial port or a telnet socket. Matched on the session id
 * alone: there is no connection to disambiguate it with, and the ids are
 * unique across the window.
 */
export function routeDeviceData({ id, data }) {
  for (const pane of state.panes.values()) {
    if (pane.termId === id && pane.kind === 'device') { writeToPane(pane, data); return; }
  }
}

export function routeTermExit(connId, { id, exitCode, reason }) {
  for (const pane of state.panes.values()) {
    if (pane.termId === id) {
      if (pane.onExit) {
        const fn = pane.onExit;
        pane.onExit = null;
        try { fn(exitCode); } catch { /* a callback must not break the pane */ }
      }
      pane.termId = null;
      pane.status = 'closed';
      /*
       * Why it ended, when the far end said. A serial cable pulled out and a
       * telnet server hanging up both look like "session ended" otherwise,
       * and the difference is the whole of what you want to know.
       *
       * The date/time rides along too — scroll back to this later (or just
       * glance at a pane you left running overnight) and "session ended"
       * alone doesn't say whether that was five minutes or five days ago.
       * 12-hour with the timezone named: this line is the one most likely
       * to get pasted to someone in a different zone.
       */
      const why = reason ? ` — ${reason}` : (exitCode ? ` — exit ${exitCode}` : '');
      pane.view.writeln(`\r\n\x1b[90m[session ended${why} — ${fmtDateTimeTz(Date.now())}]\x1b[0m`);
      if (pane.kind === 'device') pane.offerReconnect?.();
      // A local shell has nothing to reconnect to — it ran, and it is done.
      // Every other kind gets the button, device included: the scrollback
      // hint above still works, but a button at the top is the one thing
      // that does not require remembering it is there.
      if (pane.kind !== 'local') pane.reconnectBtn?.classList.remove('hidden');
      // An MFA session that never opened gets a way forward instead of a
      // dead terminal.
      offerMfaAlternatives(pane);
      state.emit('tabs');
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pane context menu                                                   */
/* ------------------------------------------------------------------ */

/**
 * Enough of a URL to recognise it in a menu row, with the middle taken out
 * rather than the end: the host and the last part of the path are what tell
 * two links apart, and a plain truncation throws the second of those away.
 */
function shortLink(url, max = 52) {
  const u = String(url || '');
  if (u.length <= max) return u;
  const head = Math.ceil((max - 1) * 0.62);
  return `${u.slice(0, head)}…${u.slice(-(max - 1 - head))}`;
}

function onPaneContextMenu(e, paneId) {
  e.preventDefault();
  const pane = state.getPane(paneId);
  if (!pane) return;
  state.setActivePane(paneId);

  const hasSel = pane.view.hasSelection();
  /*
   * A link under the pointer gets its own two items at the top. Copying one
   * is the thing a terminal otherwise makes awkward — a URL that wrapped over
   * three rows cannot be selected cleanly with a mouse — and opening it from
   * here is the same guarded path as clicking it, question included.
   */
  const link = pane.view.linkAt?.(e.clientX, e.clientY) || null;
  /*
   * A console and a screen each have two or three things that only they can
   * do, and they go at the top where the link items go: they are what the
   * menu was opened for, in a pane that cannot use half of what follows.
   */
  const device = pane.kind === 'device' ? pane.deviceSpec : null;
  const screen = pane.kind === 'vnc';
  // An ended session's pane is a record of what was on screen, not a session.
  const tmux = pane.kind === 'tmux' && !pane.tmuxEnded;
  contextMenu(e.clientX, e.clientY, [
    ...(device ? [
      device.kind === 'serial' ? {
        label: 'Send break', icon: '\u26A1',
        title: 'A long break on the line — how you interrupt a boot loader',
        disabled: !pane.termId,
        onClick: async () => {
          try { await window.api.device.sendBreak(pane.termId, 300); status('Break sent'); }
          catch (err) { toast(err.message, 'error'); }
        },
      } : null,
      {
        label: pane.termId ? 'Close this console' : 'Open it again', icon: '\u21BB',
        onClick: () => {
          if (pane.termId) window.api.device.close(pane.termId).catch(() => {});
          else { pane.reconnectArmed = false; startDeviceSession(pane); }
        },
      },
      { sep: true },
    ].filter(Boolean) : []),
    ...(tmux ? [
      {
        label: 'Split right (tmux)', icon: '\u216E',
        title: 'Asks tmux to split, so the other clients see it too',
        onClick: async () => (await import('./tmux.js')).splitTmuxPane(pane, 'row'),
      },
      {
        label: 'Split down (tmux)', icon: '\u2017',
        onClick: async () => (await import('./tmux.js')).splitTmuxPane(pane, 'col'),
      },
      {
        label: 'New tmux window', icon: '\u2795',
        onClick: async () => (await import('./tmux.js')).newTmuxWindow(pane),
      },
      {
        label: 'Rename this window\u2026', icon: '\u270E',
        title: 'Stops tmux renaming the tab after whatever is running in it',
        onClick: async () => (await import('./tmux.js')).renameTmuxWindow(pane),
      },
      {
        label: 'Rename the session\u2026', icon: '\u270E',
        title: 'How you find it again \u2014 here, and in tmux ls on the host',
        onClick: async () => (await import('./tmux.js')).renameTmuxSession(pane.tmuxId),
      },
      { sep: true },
      {
        label: 'Detach \u2014 leave it running', icon: '\u23CF',
        title: 'The session stays on the server with everything in it',
        onClick: async () => (await import('./tmux.js')).detachTmux(pane.tmuxId),
      },
      {
        label: 'End this tmux session\u2026', icon: '\u2716',
        onClick: async () => (await import('./tmux.js')).killTmux(pane.tmuxId),
      },
      { sep: true },
    ] : []),
    // A local shell can become a tmux session on this machine. Not on
    // Windows, which has no native tmux.
    ...(pane.kind === 'local' && !pane.isHosts && !pane.isKubeBrowser && state.appInfo?.platform !== 'win32' ? [
      {
        label: 'Open in tmux on this machine\u2026', icon: '\u267B',
        title: 'A tmux session here — what runs in it keeps running when this window closes',
        onClick: async () => {
          const t = await import('./tmux.js');
          t.openTmuxDialog(t.localTmuxHost());
        },
      },
      { sep: true },
    ] : []),
    ...(screen ? [
      {
        label: 'Send Ctrl+Alt+Del', icon: '\u2328',
        onClick: async () => (await import('./vnc.js')).sendVncKeys(pane, 'cad'),
      },
      {
        label: 'Paste into the session', icon: '\u2935', key: '⌘V',
        onClick: async () => (await import('./vnc.js')).pasteToVnc(pane),
      },
      {
        label: 'Reconnect', icon: '\u21BB',
        onClick: async () => {
          try { pane.rfb?.disconnect(); } catch { /* the viewer may already be gone */ }
          (await import('./vnc.js')).connectVnc(pane);
        },
      },
      { sep: true },
    ] : []),
    ...(link ? [
      {
        label: 'Open link', icon: '↗', sub: shortLink(link), title: link,
        onClick: async () => (await import('./links.js')).openLink(link),
      },
      {
        label: 'Copy link', icon: '⧉', title: link,
        onClick: () => { window.api.clipboard.write(link); status('Link copied'); },
      },
      { sep: true },
    ] : []),
    {
      label: 'Copy', icon: '\u29C9', key: '⌘C', disabled: !hasSel,
      onClick: () => window.api.clipboard.write(pane.view.selection()),
    },
    {
      label: 'Paste', icon: '\u2935', key: '⌘V',
      onClick: async () => { const t = await window.api.clipboard.read(); if (t) writeTo(pane, t); },
    },
    {
      label: 'Decode', icon: '\u2317',
      title: hasSel ? 'Take the selected text apart' : 'Open a decoder to paste into',
      submenu: decodeMenu({ input: hasSel ? pane.view.selection() : '' }),
    },
    /*
     * The AI assistant, from here: an assistant's own pane saves what it
     * said; any other gives what is selected (or on screen) to the assistant,
     * with where it came from, for a question to be asked about it.
     */
    ...(pane.aiSession ? [
      {
        label: 'Save the selection as a response\u2026', icon: '\u2193', disabled: !hasSel,
        onClick: async () => (await import('./ai.js')).saveResponse(pane, pane.view.selection()),
      },
      { label: 'Saved responses\u2026', icon: '\u2630', onClick: async () => (await import('./ai.js')).openSavedResponses() },
    ] : screen ? [] : [
      {
        label: hasSel ? 'Ask the AI about this' : 'Ask the AI about what is on screen', icon: '\u2726',
        title: 'Put it into the AI assistant, with the host it came from — then type your question',
        onClick: async () => {
          const m = await import('./ai.js');
          const { screenTail } = await import('./aiwaiting.js');
          const text = hasSel ? pane.view.selection() : screenTail(pane.view.term, 60);
          const conn = pane.kind === 'local' ? null : state.getConnection(pane.connId);
          m.askAiAbout(text, conn ? `my session on ${conn.label}` : 'my local shell');
        },
      },
    ]),
    { sep: true },
    { label: 'Split right — same tab', icon: '\u216E', key: '⌘⇧D', onClick: () => splitActivePane('row') },
    { label: 'Split down — same tab', icon: '\u2017', key: '⌘⇧E', onClick: () => splitActivePane('col') },
    { label: 'Split right — another host…', icon: '\u216E', onClick: () => pickHostForSplit('row') },
    { label: 'Split down — another host…', icon: '\u2017', onClick: () => pickHostForSplit('col') },
    {
      label: 'Move this pane', icon: '\u2725',
      disabled: state.panesOf(pane.tabId).length < 2,
      submenu: [
        { label: 'Left', key: '⌘⇧←', onClick: () => movePane('left', paneId) },
        { label: 'Right', key: '⌘⇧→', onClick: () => movePane('right', paneId) },
        { label: 'Up', key: '⌘⇧↑', onClick: () => movePane('up', paneId) },
        { label: 'Down', key: '⌘⇧↓', onClick: () => movePane('down', paneId) },
      ],
    },
    {
      label: 'Move to its own window', icon: '\u29C9',
      title: 'Keeps the session and the scrollback — or drag the pane out of the window',
      onClick: () => popPaneToWindow(paneId),
    },
    {
      label: 'Move to its own tab', icon: '\u2197',
      disabled: state.panesOf(pane.tabId).length < 2,
      title: 'Keeps the session, the scrollback and anything running in it',
      onClick: () => movePaneToNewTab(paneId),
    },
    { label: 'Duplicate tab', icon: '\u29C9', key: '⌘D', onClick: () => duplicateActiveTab() },
    { sep: true },
    /*
     * The host's own history, which Up-arrow only reaches one shell of.
     * Remote only: it is read from the files on the far side, and a local
     * shell's history is already the one this machine's own tools show.
     */
    {
      label: 'Command history on this host…', icon: '\u21BA',
      disabled: pane.kind !== 'remote' || !pane.connId,
      title: pane.kind === 'remote'
        ? 'Search everything this account has run here, and reuse it'
        : 'Read from the server — open it on a host session',
      onClick: async () => (await import('./history.js')).openHistoryDialog(pane),
    },
    { sep: true },
    {
      label: 'Snippets…', icon: '\u2702', key: '⌘⇧C',
      onClick: async () => (await import('./snippets.js')).openSnippetsDialog(),
    },
    pane.kind === 'vnc' || pane.kind === 'device' ? null : pane.recorder ? {
      label: `Stop recording the macro (${pane.recorder.steps.length})\u2026`, icon: '\u25CF',
      onClick: async () => (await import('./macrorecord.js')).stopRecording(pane),
    } : {
      label: 'Record a macro', icon: '\u25CF',
      title: 'Run commands as usual; when you stop, they become a macro',
      onClick: async () => (await import('./macrorecord.js')).startRecording(pane),
    },
    {
      label: 'Save selection as snippet…', icon: '\u2702', disabled: !hasSel,
      onClick: async () => (await import('./snippets.js')).snippetFromSelection(pane.view.selection()),
    },
    { sep: true },
    {
      label: 'Save this terminal to a file\u2026', icon: '\u2193',
      title: 'Everything in the buffer, scrollback included',
      onClick: () => savePaneText(pane),
    },
    {
      label: 'Copy everything', icon: '\u29C9',
      onClick: () => {
        const text = pane.view.allText();
        if (!text) return status('Nothing in this terminal yet');
        window.api.clipboard.write(text);
        status('Terminal copied');
      },
    },
    { sep: true },
    paneStyleMenu(pane),
    (pane.kind === 'remote' || pane.kind === 'tmux') && pane.connId ? {
      label: pane.statsBar ? 'Hide live stats' : 'Show live stats', icon: '\u2581',
      title: 'CPU, memory, disk and network for this host, under the terminal',
      onClick: async () => (await import('./monitor.js')).toggleStatsFor(pane),
    } : null,
    { label: 'Clear', icon: '\u2327', onClick: () => pane.view.clearScreen() },
    {
      label: 'Reconnect', icon: '\u21BB', disabled: pane.kind === 'local',
      onClick: () => reconnectPane(pane),
    },
    { sep: true },
    // A tmux pane closes in tmux too; this one only stops showing it.
    pane.kind === 'tmux' ? {
      label: 'Close the view (keep it running in tmux)', icon: '\u2298',
      onClick: () => closePane(paneId),
    } : null,
    {
      label: pane.kind === 'tmux' ? 'Close pane (in tmux too)' : 'Close pane', icon: '\u2715', key: '⌘W',
      onClick: () => closePaneByHand(paneId),
    },
  ]);
}

/** Choose a host, then split the focused pane with it. */
export async function pickHostForSplit(dir) {
  const { pickHost } = await import('./profiles.js');
  const choice = await pickHost({ title: dir === 'row' ? 'Split right with…' : 'Split down with…' });
  if (!choice) return;
  try {
    if (choice.kind === 'local') return splitActivePane(dir, { local: true });
    await splitActivePane(dir, { host: choice.host, login: choice.login });
  } catch (e) { toast(e.message, 'error'); }
}

export async function reconnectPane(pane) {
  if (pane.kind === 'local') return;
  if (pane.termId) { window.api.term.close(pane.connId, pane.termId).catch(() => {}); pane.termId = null; }
  pane.view.clearScreen();
  await connectPane(pane);
}

/**
 * The top-of-pane button's own handler — one entry point for every kind
 * that can end and come back, dispatching to whichever reconnect that kind
 * already has rather than growing a second copy of each.
 */
async function reconnectFromBanner(pane) {
  if (!pane) return;
  pane.reconnectBtn?.classList.add('hidden');
  if (pane.kind === 'device') { pane.reconnectArmed = false; await startDeviceSession(pane); return; }
  if (pane.kind === 'vnc') {
    try { pane.rfb?.disconnect(); } catch { /* the viewer may already be gone */ }
    const { connectVnc } = await import('./vnc.js');
    await connectVnc(pane);
    return;
  }
  await reconnectPane(pane);
}

/**
 * Put the keyboard where the eye already is.
 *
 * Clicking a tab moved the tab and nothing else: the terminal came up, and
 * the first thing typed went nowhere, because focus was still on whatever
 * was clicked. Every session needed two clicks — one to arrive, one to be
 * able to type — which is the sort of small daily friction nobody reports
 * and everybody feels.
 *
 * Only from a deliberate switch (a tab click, \u23181-\u23189, next/previous,
 * closing a tab onto another), never from an incidental redraw, or it would
 * snatch the cursor out of the filter box while somebody was typing in it.
 * A dialog owns the keyboard while it is open, so it is left alone; the
 * focus is taken on the next frame, once the pane it belongs to is on
 * screen.
 */
export function focusActivePane() {
  if (document.querySelector('.modal-backdrop')) return;
  const id = state.activePaneId;
  requestAnimationFrame(() => {
    const pane = state.getPane(id);
    if (!pane || pane.tabId !== state.activeTabId) return;
    try { pane.view?.focus?.(); } catch { /* nothing to focus yet */ }
  });
}

export { connectPane, createPane, startLocalTerm };
