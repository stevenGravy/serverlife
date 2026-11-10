/**
 * What would be lost by quitting now.
 *
 * Asked by the main process when the app is about to exit, so it can say
 * "you have four sessions open" before taking them away. Only sessions with
 * something on the other end count: a local shell is this machine talking to
 * itself, and quitting with one open is what quitting is for. A host you are
 * logged into, a console cable, a screen, a tmux session — those took effort
 * to get to, and are the ones worth one question before they go.
 *
 * Dead things do not count either. A pane that says "[session ended]", a
 * connection that failed, a VNC viewer showing why it closed: nothing is
 * running there, and asking about it would teach people to click Quit without
 * reading, which is the opposite of the point.
 *
 * Kept free of the DOM and of sessions.js so a test can hand it a state that
 * is nothing but maps.
 */

/**
 * The live sessions in this window, as `{ kind, name }`.
 *
 * One entry per pane, except tmux: a tmux tab's panes are one session on the
 * server drawn several times, so the tab is counted once under its own name.
 */
export function liveSessions(state) {
  const out = [];
  const tmuxTabs = new Set();
  for (const tab of state.tabs || []) {
    for (const pid of state.panesOf(tab.id)) {
      const p = state.getPane(pid);
      if (!p) continue;
      const entry = liveEntry(state, tab, p);
      if (!entry) continue;
      if (entry.kind === 'tmux') {
        if (tmuxTabs.has(tab.id)) continue;
        tmuxTabs.add(tab.id);
      }
      out.push(entry);
    }
  }
  return out;
}

/**
 * The live sessions that closing these tabs or panes would end.
 *
 * The same test as quitting, with one difference: tmux is left out. Closing
 * a tmux tab detaches from the session and leaves it running on the server,
 * which is what tmux is for — there is nothing to warn about. A pane given
 * on its own counts only itself; a tab counts every pane in it.
 */
export function liveSessionsIn(state, { tabIds = [], paneIds = [] } = {}) {
  const out = [];
  const seen = new Set();
  const consider = (tab, pid) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const p = state.getPane(pid);
    if (!p || !tab) return;
    const entry = liveEntry(state, tab, p);
    if (entry && entry.kind !== 'tmux') out.push(entry);
  };
  for (const id of tabIds) {
    const tab = state.getTab(id);
    for (const pid of state.panesOf(id)) consider(tab, pid);
  }
  for (const pid of paneIds) {
    const p = state.getPane(pid);
    consider(p ? state.getTab(p.tabId) : null, pid);
  }
  return out;
}

function liveEntry(state, tab, p) {
  switch (p.kind) {
    case 'local':
      return null;

    case 'remote': {
      /*
       * The connection being up is not enough: a shell that exited leaves the
       * ControlMaster behind it. Something has to be using it — a terminal, a
       * files-only browser, or a port forward someone may be pointing a
       * database client at right now.
       */
      const conn = p.connId ? state.getConnection(p.connId) : null;
      if (!conn || conn.state !== 'connected') return null;
      const forwards = state.forwards?.get(p.connId) || [];
      const inUse = (p.termId && p.status === 'connected') || p.filesOnly || forwards.length > 0;
      if (!inUse) return null;
      return { kind: conn.type === 'teleport' ? 'teleport' : 'ssh', name: conn.label || tab.title || 'remote session' };
    }

    case 'tmux':
      // `termId` is how the rest of the app tells a bound pane from a
      // detached one, so it is how this does too.
      if (!p.termId) return null;
      return { kind: 'tmux', name: tab.title || 'tmux' };

    case 'device':
      if (!p.termId || p.status !== 'connected') return null;
      return { kind: p.deviceSpec?.kind === 'telnet' ? 'telnet' : 'serial', name: p.title || p.deviceLabel || 'console' };

    case 'vnc':
      if (p.status !== 'connected') return null;
      return { kind: 'vnc', name: p.title || 'VNC' };

    default:
      return null;
  }
}
