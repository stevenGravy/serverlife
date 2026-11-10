import { state } from './state.js';
import { status } from './ui.js';
import { explorers } from './explorer.js';

/**
 * Controller for the per-pane file explorers.
 *
 * Each terminal pane owns an Explorer instance (see explorer.js); this module
 * handles what spans all of them: global show/hide, layout orientation, and
 * the background refresh tick.
 */

/* ------------------------------------------------------------------ */
/* Global visibility and layout                                        */
/* ------------------------------------------------------------------ */

export function initFiles() {
  // Redraw every explorer when connections change, and load the visible ones
  // that have just become usable — nothing else triggers that first load. A
  // hidden explorer waits: it is loaded when it is shown, not before.
  state.on('connections', () => {
    for (const e of explorers.values()) {
      e.syncSources();
      if (onScreen(e)) e.ensureLoaded().catch(() => {});
    }
  });

  state.on('activePane', () => {
    for (const e of explorers.values()) e.syncSources();
  });

  // Switching tabs brings a different set of explorers on screen. They were
  // not polled while they were away, so bring them up to date now rather than
  // showing a stale list until the next tick.
  state.on('tabs', () => catchUpVisible());

  // Registering or removing a bucket changes what every explorer can point at.
  state.on('s3', () => {
    for (const e of explorers.values()) e.syncSources();
  });

  startFollowLoop();
}

/** Show or hide every pane's explorer at once. */
export async function toggleAllExplorers(force) {
  const panes = [...state.panes.values()];
  const anyVisible = panes.some((p) => p.explorerVisible);
  const next = force === undefined ? !anyVisible : !!force;

  const { setPaneExplorerVisible } = await import('./sessions.js');
  for (const p of panes) setPaneExplorerVisible(p, next);

  state.settings = await window.api.settings.set({ explorersVisible: next });
  status(next ? 'File explorers shown' : 'File explorers hidden');
}

/** Explorer beside the terminal ('left'), or above it ('top'). */
export async function setExplorerPosition(position) {
  const pos = position || (state.settings.explorerPosition === 'top' ? 'left' : 'top');
  state.settings = await window.api.settings.set({ explorerPosition: pos });

  const { applyExplorerPosition } = await import('./sessions.js');
  for (const p of state.panes.values()) {
    applyExplorerPosition(p);
    setTimeout(() => p.view.fitNow(), 30);
  }
  status(pos === 'top' ? 'Explorers stacked above terminals' : 'Explorers beside terminals');
}

/** Redraw everything. */
export function renderRemote() {
  for (const e of explorers.values()) e.render();
}

/** Point a local explorer at a path (used by saved profiles). */
export async function setLocalPath(p) {
  if (!p) return;
  let target = [...explorers.values()].find((e) => e.source.kind === 'local');
  if (!target) {
    const pane = state.activePane;
    target = pane?.explorer;
    if (!target) return;
    await target._onSourcePicked('local');
  }
  await target.navigate(p);
}

/* ------------------------------------------------------------------ */
/* Background refresh                                                  */
/* ------------------------------------------------------------------ */

let tickTimer = null;

/**
 * One timer drives two optional behaviours: following the terminal's working
 * directory, and re-listing visible directories so files created outside the
 * app appear. Interval 0 ("Off") stops polling entirely — each tick costs one
 * SFTP round trip per visible explorer.
 */
/** Settings → "No background commands on servers" (enforced in main as well). */
export const quietRemote = () => state.settings?.quietRemote === true;

export function startFollowLoop() {
  clearInterval(tickTimer);
  const seconds = pollSeconds();
  if (!seconds) return;
  tickTimer = setInterval(tick, seconds * 1000);
}

export function restartFollowLoop() { startFollowLoop(); }

function pollSeconds() {
  const v = state.settings.refreshSeconds;
  return v === undefined ? 5 : Math.max(0, Number(v) || 0);
}

async function tick() {
  if (document.querySelector('.modal-backdrop')) return;   // a dialog is open

  const live = [];
  for (const e of explorers.values()) {
    if (onScreen(e)) live.push(e);
    else e.pollPaused = true;                              // re-listed when shown again
  }
  // Every explorer hidden: ask the servers nothing at all. Not a listing, and
  // not the directory probe either — that probe is an exec, which on a
  // recorded cluster is a session in the audit log every few seconds per pane.
  if (!live.length) return;

  // The directory each shell is in, read once per pane and used twice: for the
  // pane title, and by the follow loop below.
  await trackPaneCwds(live);
  await followTerminals(live);

  for (const e of live) {
    if (isMfaSession(e)) continue;                          // polling would re-prompt
    // "No background commands on servers": a remote list is re-read when asked.
    if (quietRemote() && e.source?.kind === 'remote') continue;
    e.pollPaused = false;
    await e.autoRefresh();
  }
}

/**
 * Is this explorer actually being looked at?
 *
 * Hidden means two things: the pane's file side is collapsed, or the pane sits
 * in a tab you are not on. Either way a re-list is a round trip nobody sees —
 * per explorer, every few seconds, on every open session. They are paused
 * instead and caught up the moment they come back (catchUpVisible).
 */
function onScreen(explorer) {
  const pane = explorer.paneId ? state.getPane(explorer.paneId) : null;
  if (!pane || !pane.explorerVisible) return false;
  return pane.tabId === state.activeTabId;
}

/**
 * Bring the explorers that have just come back on screen up to date — load the
 * ones that never got a first listing, re-list the ones whose polling was
 * paused. An explorer that was never paused is on the normal tick and is left
 * alone, so this is safe to call on any event that reveals a pane.
 *
 * Pass a pane id to limit it to that pane's explorers.
 */
export function catchUpVisible(paneId = null) {
  for (const e of explorers.values()) {
    if (paneId && e.paneId !== paneId) continue;
    if (!onScreen(e)) continue;
    const paused = e.pollPaused;
    const loaded = e.view.path != null;
    e.pollPaused = false;
    if (!paused && loaded) continue;
    if (isMfaSession(e)) continue;
    e.ensureLoaded()
      .then(() => (loaded ? e.autoRefresh() : null))
      .catch(() => {});
  }
}

/**
 * Read one pane's directory now, rather than at the next tick.
 *
 * The poll notices a `cd` eventually — within the refresh interval, which is
 * five seconds by default — and "eventually" is the wrong feel for something
 * that should look like the two panels are the same thing. This is the fast
 * path: the terminal says a directory has probably just changed, and the one
 * pane it happened in is asked straight away.
 *
 * Deliberately not "probe on every Enter". Each probe is an exec, and on a
 * cluster with session recording an exec is a line in the audit log; paying
 * that for `ls` would be a poor trade. The caller only rings when the line
 * looked like a directory change, and the ordinary poll stays as the
 * backstop for every way of moving that this cannot see — a shell alias, a
 * command recalled with the up arrow, a script that cds on its way out.
 */
export async function followPaneNow(paneId) {
  if (!state.followTerminal) return;
  const explorer = [...explorers.values()].find((e) => e.paneId === paneId);
  if (!explorer || !onScreen(explorer) || isMfaSession(explorer)) return;
  await trackPaneCwds([explorer]);
  await followTerminals([explorer]);
}

/**
 * A session the background loop must leave alone.
 *
 * A `tsh` session opens a channel per operation. On a per-session-MFA host
 * that costs the user an approval, which is reason enough never to poll it:
 * refreshing is a deliberate click on that pane instead. On a node that is
 * on tsh only because its hostname is ambiguous there is no approval — but
 * each channel is still a session in the audit log, and a listing nobody
 * asked for every few seconds is not worth that. Both are left to the
 * click; the difference is only in what the pane says about it, which is
 * the explorer's business rather than this loop's.
 */
function isMfaSession(explorer) {
  if (explorer.source.kind !== 'remote') return false;
  const conn = explorer.connId ? state.getConnection(explorer.connId) : null;
  return conn?.transport === 'tsh';
}

/**
 * An explorer bound to its own pane's session follows that shell's directory.
 * Explorers pinned to a different session are left alone.
 *
 * It follows the shell *moving*, not the shell's position: what is acted on is
 * a cwd that differs from the one this loop last followed to, and never simply
 * a cwd that differs from what the explorer is showing. Otherwise browsing is
 * impossible — open a folder and the next tick, a few seconds later, drags the
 * list back to where the shell has been sitting all along. Having taken a turn
 * of its own the explorer is left where the user put it, and picks the shell up
 * again the moment it cds somewhere new.
 */
/**
 * Keep each visible pane's idea of its own directory current, for its title.
 *
 * Only the panes whose explorer is on screen. The probe reads the process
 * rather than typing `pwd` into someone's terminal, but reading it is still an
 * exec — a channel, and on a recorded cluster a session in the audit log. That
 * is a fair price for a list you are looking at and no price at all for a
 * title, so a pane with its explorer hidden keeps the last directory it knew
 * and picks the current one up when the explorer is opened again.
 */
async function trackPaneCwds(live) {
  const ids = new Set(live.map((e) => e.paneId).filter(Boolean));
  let changed = false;

  for (const id of ids) {
    const pane = state.getPane(id);
    if (!pane || !pane.termId) continue;
    try {
      let cwd = null;
      if (pane.kind === 'local') {
        cwd = await window.api.localTerm.cwd(pane.termId);
      } else {
        // Settings → "No background commands on servers": titles keep the last directory.
        if (quietRemote()) continue;
        const conn = state.getConnection(pane.connId);
        if (conn?.state !== 'connected') continue;
        // A probe over tsh is another MFA prompt, so those panes keep the
        // directory they started in.
        if (conn.transport === 'tsh' || conn.transport === 'beam') continue;
        cwd = await window.api.term.cwd(pane.connId, pane.termId);
      }
      if (cwd && cwd !== pane.cwd) { pane.cwd = cwd; changed = true; }
    } catch { /* a pane that cannot say keeps the last answer */ }
  }

  if (changed) {
    const { refreshPaneTitles } = await import('./sessions.js');
    refreshPaneTitles();
  }
}

/**
 * Follow the shell, using the directory trackPaneCwds has just read. It used
 * to probe for itself, which meant two execs per pane per tick for the one
 * answer; the pane's cwd is that answer, already current for this tick.
 *
 * A transport that cannot be probed — tsh, a beam — never updates pane.cwd, so
 * those panes simply never register a move, which is what they did before.
 */
async function followTerminals(live) {
  if (!state.followTerminal) return;
  for (const e of live) {
    const pane = state.getPane(e.paneId);
    if (!pane || !pane.termId) continue;
    /*
     * An explorer follows the terminal it is sitting next to, and only
     * while it is still pointed at it: `connId` means somebody re-pointed
     * this panel at another session, and it should stay where it was put.
     *
     * Local shells were missed entirely until now — the condition asked for
     * a remote pane, so `cd` in a local shell moved the title and left the
     * file list behind. They track their own directory the same way.
     */
    // A tmux pane is a remote session with a server-side multiplexer in the
    // middle; its explorer follows it exactly as an ordinary one does.
    const followsOwnSession = e.source.kind === 'remote' && !e.source.connId
      && (pane.kind === 'remote' || pane.kind === 'tmux');
    const followsThisShell = e.source.kind === 'local' && pane.kind === 'local';
    if (!followsOwnSession && !followsThisShell) continue;
    if (document.activeElement === e.pathInput) continue;

    const cwd = pane.cwd;
    if (!cwd) continue;
    // First reading on a fresh session: adopt it without counting as a move,
    // since the explorer has already loaded the same home directory.
    if (e.followedCwd === null) { e.followedCwd = cwd; continue; }
    if (cwd === e.followedCwd) continue;
    e.followedCwd = cwd;
    if (cwd !== e.view.path) await e.navigate(cwd).catch(() => {});
  }
}
