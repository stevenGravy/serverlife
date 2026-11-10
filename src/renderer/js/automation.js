import { state } from './state.js';
import { status } from './ui.js';
import { openHost, openLocalShell, splitActivePane, closeTab, confirmClosing } from './sessions.js';
import { refreshInventory } from './sidebar.js';
import { liveSessions } from './quitguard.js';

/**
 * The window's half of the control socket.
 *
 * Tabs, panes and the live inventory only exist here, so the verbs that touch
 * them are answered here. Each request arrives with an id and is answered
 * exactly once; a throw becomes an error the caller can read, which is the
 * whole point of an interface something else drives.
 *
 * Nothing in here types into a session or runs a command of the caller's
 * choosing. Opening, closing, arranging and running a *saved* macro is the
 * extent of it — and reading back what a session shows, so an assistant that
 * ran a macro can see what it printed.
 */

/** The last `n` non-trailing-blank lines of a pane's text. */
function lastLines(text, n) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

/** A pane by tab and pane index: the active tab and its focused pane by default. */
function paneAt({ tab, pane } = {}) {
  const tabIdx = Number.isInteger(tab) ? tab : state.tabs.findIndex((t) => t.id === state.activeTabId);
  const t = state.tabs[tabIdx];
  if (!t) throw new Error(Number.isInteger(tab) ? `No tab ${tab}.` : 'No tab is open.');
  const ids = state.panesOf(t.id);
  const id = Number.isInteger(pane) ? ids[pane]
    : (ids.includes(state.activePaneId) ? state.activePaneId : ids[0]);
  const p = id ? state.getPane(id) : null;
  if (!p) throw new Error(`No pane ${pane} in tab ${tabIdx}.`);
  return { t, tabIdx, p, paneIdx: ids.indexOf(id) };
}

const HANDLERS = {
  list_sessions() {
    return {
      tabs: state.tabs.map((t, i) => {
        const panes = state.panesOf(t.id).map((id, j) => {
          const p = state.getPane(id);
          const conn = p?.connId ? state.getConnection(p.connId) : null;
          return {
            // Where it is, for read_output: { tab, pane }.
            index: j,
            focused: id === state.activePaneId,
            kind: p?.kind || 'unknown',
            host: conn?.label || (p?.kind === 'local' ? 'local' : null),
            state: conn?.state || (p?.kind === 'local' ? 'connected' : 'idle'),
            filesOnly: !!p?.filesOnly,
          };
        });
        return { index: i, title: t.title, active: t.id === state.activeTabId, panes };
      }),
    };
  },

  async open_session(params) {
    const opened = await openOne(params);
    return { opened: opened.label, transport: opened.transport || 'mux' };
  },

  /**
   * Open several at once — the reason this interface exists. Failures are
   * reported per entry rather than aborting the rest: a set of sessions where
   * one host is down should still give you the others.
   */
  async open_sessions({ sessions = [], stopOnError = false } = {}) {
    if (!Array.isArray(sessions) || !sessions.length) throw new Error('Give a "sessions" array.');
    const results = [];
    for (const spec of sessions) {
      try {
        const opened = await openOne(spec);
        results.push({ ok: true, host: opened.label });
      } catch (e) {
        results.push({ ok: false, host: spec?.host || '(unnamed)', error: e.message });
        if (stopOnError) break;
      }
    }
    const good = results.filter((r) => r.ok).length;
    status(`Automation opened ${good} of ${results.length} session(s)`);
    return { opened: good, failed: results.length - good, results };
  },

  /**
   * What tmux has running on a host, so a caller can decide whether to
   * resume rather than start. Dials the host to ask, as anything else here
   * that touches a server does.
   */
  async list_tmux({ host: name, cluster, login, beam } = {}) {
    if (typeof beam === 'string' && beam.trim()) { name = name || beam.trim(); beam = true; }
    if (!name) throw new Error('Give a "host", or a "beam" by name.');
    if (!state.teleportNodes.size && !state.sshHosts.length) await refreshInventory();
    const host = await findHost(String(name).trim(), cluster, beam);
    if (!host) throw new Error(`No host matching "${name}".`);
    const { ensureConnection } = await import('./sessions.js');
    const { preferredLogin } = await import('./sidebar.js');
    /*
     * The same account the app would use, unless one is named.
     *
     * tmux sessions belong to the user that started them, and connecting as
     * the Teleport principal rather than the login the host is actually
     * opened with answers "nothing is running there" about an account nobody
     * uses — while the sessions sit under the other one.
     */
    const as = host.type === 'beam' ? login : login || preferredLogin(host);
    const connId = await ensureConnection(host, { login: as || undefined });
    const probe = await window.api.tmux.probe(connId);
    if (!probe.ok) return { host: host.name || host.alias, available: false, reason: probe.reason };
    const sessions = await window.api.tmux.sessions(connId);
    return {
      host: host.name || host.alias,
      available: true,
      version: probe.version,
      sessions: sessions.map((x) => ({
        name: x.name, windows: x.windows, attached: x.attached,
        created: x.created ? new Date(x.created).toISOString() : null,
      })),
    };
  },

  /*
   * Asks first, the same way the tab's own × does — but only when a
   * session is actually still running in it. A tab that has already exited
   * closes straight away, and "do not ask again" in that dialog (or Settings)
   * is remembered for this path too.
   */
  async close_session({ index, title, all = false } = {}) {
    if (all) {
      const tabs = [...state.tabs];
      if (!await confirmClosing({ tabIds: tabs.map((t) => t.id) })) {
        throw new Error('The user declined to close the session(s).');
      }
      for (const t of tabs) closeTab(t.id);
      return { closed: tabs.length };
    }
    const tab = typeof index === 'number'
      ? state.tabs[index]
      : state.tabs.find((t) => t.title === title);
    if (!tab) throw new Error('No such session.');
    if (!await confirmClosing({ tabIds: [tab.id] })) {
      throw new Error('The user declined to close the session.');
    }
    closeTab(tab.id);
    return { closed: 1, title: tab.title };
  },

  /** Every setting as it is right now — what the Settings dialog would show. */
  get_settings() {
    return { settings: state.settings };
  },

  /*
   * Change one or more settings — the same patch the Settings dialog's own
   * Save button sends, so anything it can set, this can set. A cursor
   * setting also applies live to every open terminal, the same as Save
   * does; other settings take effect the way they always have, the next
   * time they are read.
   */
  async set_settings({ patch } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Give a "patch" object of settings to change, e.g. { cursorStyle: "block" }.');
    }
    state.settings = await window.api.settings.set(patch);
    if ('cursorBlink' in patch || 'cursorStyle' in patch) {
      for (const p of state.panes.values()) {
        if (!p.view.term) continue;
        if ('cursorBlink' in patch) p.view.term.options.cursorBlink = state.settings.cursorBlink;
        if ('cursorStyle' in patch) p.view.term.options.cursorStyle = state.settings.cursorStyle;
      }
    }
    // KubeLife's group and filter in the Resources tab are a whole control,
    // not a style — an agent turning it off should see them gone from the
    // sidebar immediately, the same as the Settings dialog's own Save button does.
    if ('kubeEnabled' in patch) {
      import('./sidebar.js').then((m) => m.applyKubeEnabledSetting?.()).catch(() => {});
    }
    return { settings: state.settings };
  },

  async load_layout({ name, id } = {}) {
    const layouts = await window.api.workspace.listLayouts();
    const layout = id ? layouts.find((l) => l.id === id) : layouts.find((l) => l.name === name);
    if (!layout) {
      throw new Error(`No layout named "${name || id}". Have: ${layouts.map((l) => l.name).join(', ') || 'none'}`);
    }
    const { restoreWorkspace } = await import('./workspace.js');
    // Replaces what is open, exactly as loading it from the menu does.
    for (const t of [...state.tabs]) closeTab(t.id);
    await restoreWorkspace(layout.workspace);
    return { loaded: layout.name, tabs: layout.workspace.tabs.length };
  },

  async save_layout({ name } = {}) {
    if (!name) throw new Error('Give a "name" for the layout.');
    const { captureWorkspace } = await import('./workspace.js');
    const ws = captureWorkspace();
    if (!ws.tabs.length) throw new Error('Nothing is open to save.');
    const saved = await window.api.workspace.saveLayout({ name, workspace: ws });
    return { saved: saved.name, tabs: ws.tabs.length };
  },

  /*
   * The search box at the top of the window, for an agent: everything in
   * ServerLife whose name or details match, grouped by kind. It finds; it
   * does not open — each kind says which tool takes it from there.
   */
  async search({ query = '', limit = 8, kinds = null } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('Give a "query" to search for.');
    const { searchData } = await import('./search.js');
    return searchData(q, { limit, kinds });
  },

  list_macros() {
    return {
      macros: (state.macros || []).map((m) => ({
        name: m.name,
        category: m.category || 'Custom',
        description: m.description || '',
        command: m.command,
        builtin: !!m.builtin,
        confirm: !!m.confirm,
        interactive: !!m.interactive,
        repeatSeconds: m.repeatSeconds || 0,
      })),
    };
  },

  async run_macro({ name, allPanes = false, waitSeconds = 0 } = {}) {
    const macro = (state.macros || []).find((m) => m.name === name
      || m.name.toLowerCase() === String(name || '').toLowerCase());
    if (!macro) {
      throw new Error(`No macro named "${name}". Have: ${(state.macros || []).map((m) => m.name).join(', ')}`);
    }
    const pane = state.activePane;
    if (!pane?.termId) throw new Error('No session is focused to run it in.');
    const before = pane.view?.allText?.() || '';
    const { sendMacro } = await import('./macros.js');
    await sendMacro(macro, { all: !!allPanes });
    /*
     * Asked to wait: give the command that long, then hand back what it
     * printed — so running a macro and reading its result is one call. The
     * new text is what came after the screen as it was; if scrollback was
     * trimmed in between, the last lines stand in for it.
     */
    const wait = Math.max(0, Math.min(60, Number(waitSeconds) || 0));
    if (!wait) return { ran: macro.name, command: macro.command };
    await new Promise((r) => setTimeout(r, wait * 1000));
    const after = pane.view?.allText?.() || '';
    const added = after.startsWith(before) ? after.slice(before.length) : lastLines(after, 80);
    return { ran: macro.name, command: macro.command, waitedSeconds: wait, output: lastLines(added, 400) };
  },

  /**
   * Type into a session — asked of the person first, unless they have said
   * not to ask. The text goes in as a paste (several lines as one bracketed
   * paste, so a shell does not run them one by one), and Enter is pressed
   * only if the caller asked for it and the person agreed.
   */
  async type_text({ text, enter = false, tab, pane, _client } = {}) {
    const mode = state.settings.automationTyping || 'ask';
    if (mode === 'off') {
      throw new Error('Typing into sessions is turned off in ServerLife (Settings \u2192 Local automation).');
    }
    const body = String(text ?? '');
    if (!body) throw new Error('Nothing to type.');
    let { t, tabIdx, p, paneIdx } = paneAt({ tab, pane });
    if (!p.termId || p.kind === 'vnc') throw new Error('That pane has no session to type into.');
    const describe = (pp) => {
      const conn = pp?.connId ? state.getConnection(pp.connId) : null;
      return conn?.label || (pp?.kind === 'local' ? 'this machine' : (pp?.title || 'a session'));
    };
    let where = describe(p);
    const who = _client ? `The assistant (${_client})` : 'An assistant';

    let run = !!enter;
    if (mode !== 'allow') {
      const { modal } = await import('./ui.js');
      const { el } = await import('./util.js');
      /*
       * Two tabs can carry the same title \u2014 two sessions open on the same
       * node, say, which is exactly when the request's tab/pane numbers are
       * the only thing telling them apart. Those numbers are also a request
       * from a moment ago: a tab opened or closed since can have shifted
       * them under it. So rather than asking the person to trust a number,
       * list what is actually open right now, defaulted to the request's
       * target, and let them look at each one's screen before picking.
       */
      const targets = [];
      state.tabs.forEach((tb, ti) => {
        const ids = state.panesOf(tb.id);
        ids.forEach((id, pi) => {
          const pp = state.getPane(id);
          if (!pp || !pp.termId || pp.kind === 'vnc') return;
          targets.push({ tabIdx: ti, paneIdx: pi, pane: pp,
            label: `Tab ${ti + 1} \u201c${tb.title}\u201d \u2014 ${describe(pp)}` + (ids.length > 1 ? `, pane ${pi + 1}` : '') });
        });
      });

      const preview = el('pre', { class: 'qc-debug',
        style: 'white-space:pre-wrap;max-height:10vh;overflow:auto;opacity:.75;margin:4px 0 8px' });
      const refreshPreview = () => {
        preview.textContent = lastLines(p.view?.allText?.() || '', 3) || '(nothing on screen yet)';
      };
      refreshPreview();

      const select = targets.length > 1 ? el('select', { style: 'width:100%' },
        ...targets.map((tg) => el('option', {
          value: `${tg.tabIdx}:${tg.paneIdx}`,
          selected: tg.tabIdx === tabIdx && tg.paneIdx === paneIdx,
          text: tg.label,
        }))) : null;
      if (select) {
        select.addEventListener('change', () => {
          const [ti, pi] = select.value.split(':').map(Number);
          ({ t, tabIdx, p, paneIdx } = paneAt({ tab: ti, pane: pi }));
          where = describe(p);
          refreshPreview();
        });
      }

      const answer = await modal({
        title: select ? `${who} wants to type into a session` : `${who} wants to type into ${where}`,
        width: 'min(640px, 94vw)',
        render: (b) => b.append(
          select ? el('div', { class: 'field', style: 'margin-bottom:8px' },
            el('label', { text: 'Where' }), select) : null,
          el('div', { class: 'hint', style: 'margin-bottom:2px',
            text: select ? '' : `Tab ${tabIdx + 1} \u201c${t.title}\u201d, pane ${paneIdx + 1}:` }),
          preview,
          el('div', { class: 'hint', style: 'margin-bottom:6px',
            text: enter ? 'and to press Enter to run it:' : '' }),
          el('pre', { class: 'qc-debug', style: 'white-space:pre-wrap;max-height:40vh;overflow:auto', text: body }),
          el('div', { class: 'hint', style: 'margin-top:8px',
            text: 'Settings \u2192 Local automation decides whether this is asked, allowed or refused.' })),
        buttons: [
          { label: 'Don\u2019t allow', value: null },
          { label: 'Paste only', value: 'paste' },
          enter ? { label: 'Paste and run', class: 'primary-btn', value: 'run' } : { label: 'Paste', class: 'primary-btn', value: 'paste' },
        ],
      });
      if (!answer) throw new Error('The user declined to have this typed into the session.');
      run = answer === 'run';
    }

    const { sendToPane } = await import('./sessions.js');
    const multi = body.includes('\n');
    sendToPane(p, multi ? `\x1b[200~${body}\x1b[201~` : body);
    if (run) sendToPane(p, '\r');
    return { typed: body.length, ran: run, into: { tab: tabIdx, pane: paneIdx, host: where } };
  },

  /**
   * What a session shows, as text: the last `lines` lines of a pane — the
   * focused pane of the current tab unless `tab` and `pane` say otherwise
   * (indexes from list_sessions). Read-only, and only what the terminal
   * holds: what scrolled off its scrollback is gone.
   */
  read_output({ tab, pane, lines = 80 } = {}) {
    const { t, tabIdx, p, paneIdx } = paneAt({ tab, pane });
    if (!p.view?.allText || p.kind === 'vnc') throw new Error('That pane is a screen, not text.');
    const n = Math.max(1, Math.min(1000, Number(lines) || 80));
    const conn = p.connId ? state.getConnection(p.connId) : null;
    const text = lastLines(p.view.allText(), n);
    return {
      tab: { index: tabIdx, title: t.title },
      pane: { index: paneIdx, kind: p.kind, host: conn?.label || (p.kind === 'local' ? 'local' : null) },
      lines: text ? text.split('\n').length : 0,
      text,
    };
  },

  focus_window() {
    return { slot: state.windowInfo.slot, tabs: state.tabs.length };
  },

  /*
   * Asked by the main process on its way out, not by the control socket —
   * it rides this channel because this channel already does "ask a window,
   * wait, give up after a while", which is exactly what quitting needs.
   */
  quit_census() {
    return { sessions: liveSessions(state) };
  },
};

/**
 * Resolve one session spec and open it.
 *
 * A host is named the way a person would name it — the node's hostname, an
 * ssh_config alias, a saved profile's name, or "local" — and matched against
 * the inventory rather than requiring an internal id.
 */
async function openOne(spec = {}) {
  // `beam` is a flag, or — as sync_apply takes it — the beam's name.
  const beamName = typeof spec.beam === 'string' ? spec.beam.trim() : '';
  if (beamName) spec = { ...spec, host: spec.host || beamName, beam: true };
  const name = String(spec.host || spec.name || '').trim();
  if (!name) throw new Error('Each session needs a "host", or a "beam" by name.');

  if (name === 'local' || name === 'local shell') {
    if (spec.split) await splitActivePane(spec.split === 'down' ? 'col' : 'row', { local: true });
    else await openLocalShell();
    return { label: 'local shell', transport: 'local' };
  }

  // A kube cluster dials nothing (openHost() below is terminal-only) —
  // checked ahead of the SSH/beam/profile resolution, the same way the
  // local-shell case above is.
  const kubeHost = await kubeClusterNamed(name, spec.cluster);
  if (kubeHost) {
    if (spec.split) throw new Error('A kube cluster browser opens in a tab of its own, not a split, through this interface.');
    const kubepanel = await import('./kubepanel.js');
    if (kubeHost.kubeContext) {
      const kubebrowser = await import('./kubebrowser.js');
      const c = kubeHost.kubeContext;
      await kubebrowser.openKubeBrowser(
        { ...kubepanel.kubeSpecOf(c), teleportProxy: c.teleportProxy || null, kubeClusterName: c.kubeClusterName || null, teleportCluster: c.teleportCluster || null },
        c.kubeClusterName || c.name,
      );
      return { label: c.kubeClusterName || c.name, transport: 'kube' };
    }
    if (kubeHost.availableCluster) {
      await kubepanel.connectAvailableCluster(kubeHost.profile, kubeHost.availableCluster);
      return { label: kubeHost.name, transport: 'kube' };
    }
  }

  if (!state.teleportNodes.size && !state.sshHosts.length) await refreshInventory();

  const host = await findHost(name, spec.cluster, spec.beam);
  if (!host) {
    throw new Error(`No host matching "${name}". Try list_hosts or list_beams to see what is available.`);
  }

  // Same reasoning as list_tmux: automation opens a host as the app would.
  // A beam is reached through `tsh beams`, which takes no login — the same as
  // opening one from the Beams list.
  const { preferredLogin } = await import('./sidebar.js');
  const login = host.type === 'beam' ? spec.login || undefined
    : spec.login || preferredLogin(host) || undefined;
  /*
   * An sftp profile defaults to the file browser, same as double-clicking it
   * — many dedicated SFTP accounts have no shell at all (`ForceCommand
   * internal-sftp`), so a terminal on one does not just look wrong, it does
   * not work. The caller can still ask for a terminal with `filesOnly: false`.
   */
  const filesOnly = spec.filesOnly === undefined ? host.profileType === 'sftp' : !!spec.filesOnly;
  const opts = { login, filesOnly, profileId: host.profileId || undefined };

  /*
   * In tmux, if asked — or if this host is set to open that way.
   *
   * Reading the preference matters more here than the flag does: a host the
   * user has told the app to always open in tmux should not become an
   * ordinary session because something else opened it. Automation that opens
   * a set of hosts to work on is exactly when losing the session to a dropped
   * connection costs the most.
   */
  const { opensInTmux, tmuxNameFor, isMfaHost } = await import('./sidebar.js');
  const wantsTmux = spec.tmux === undefined ? opensInTmux(host) : !!spec.tmux;
  if (wantsTmux && !filesOnly) {
    if (isMfaHost(host.id)) {
      throw new Error(`${host.name || host.alias} asks for MFA per session, so it cannot run in tmux.`);
    }
    if (spec.split) throw new Error('A tmux session opens in a tab of its own, not a split.');
    const { openTmux } = await import('./tmux.js');
    const session = spec.tmuxSession || tmuxNameFor(host);
    const rec = await openTmux(host, { login, session });
    if (!rec) throw new Error(`Could not open tmux on ${host.name || host.alias}.`);
    return { label: host.name || host.alias, transport: 'tmux', session: rec.name };
  }

  if (spec.split) {
    /*
     * "Split the tab I just opened" cannot lean on whatever happens to be
     * focused right now — a caller stringing tool calls together has no
     * way to be sure that is still true, and no handle on a tab at all
     * otherwise. `tab`, the same index `list_sessions` reports, lets it
     * say exactly which one rather than hope the focus held.
     */
    if (spec.tab !== undefined) {
      if (!Number.isInteger(spec.tab) || !state.tabs[spec.tab]) throw new Error(`No tab ${spec.tab}.`);
      state.setActiveTab(state.tabs[spec.tab].id);
    }
    const pane = await splitActivePane(spec.split === 'down' ? 'col' : 'row',
      { host, login, filesOnly: opts.filesOnly, profileId: opts.profileId });
    if (!pane) throw new Error('Nothing is focused to split.');
    return { label: host.name || host.alias };
  }

  /*
   * `splitActivePane`, just above, already skips straight to the `tsh`
   * transport for a host known to need per-session MFA before ever calling
   * `openHost` — this plain path never did, so opening MFA-flagged
   * hosts (anything marked MFA) through this tool tried the shared
   * connection and failed every time, same bug as the split path once had.
   */
  const transport = host.type === 'teleport' && isMfaHost(host.id) ? 'tsh' : undefined;
  const pane = await openHost(host, { ...opts, transport });
  const conn = pane?.connId ? state.getConnection(pane.connId) : null;
  return { label: conn?.label || host.name || host.alias, transport: conn?.transport };
}

/** Does a beam's proxy belong to the cluster a caller named? */
function beamInCluster(beam, cluster) {
  if (!cluster) return true;
  if (beam.proxy === cluster || beam.proxy.replace(/:\d+$/, '') === cluster) return true;
  const p = (state.teleportProfiles || []).find((x) => x.proxy === beam.proxy);
  return p?.cluster === cluster;
}

/**
 * Beams named exactly: by alias, by UUID, or by the `beam-<uuid>` node it
 * registers as.
 *
 * Exact only, never partial. A beam's alias is made up by the service and can
 * sit next to an ordinary server with a similar name in the same cluster, and
 * the two are reached in different ways — a beam through `tsh beams`, a node
 * through ssh — so a near miss would open the wrong kind of session on the
 * wrong machine.
 */
function findBeams(name, cluster) {
  const out = [];
  for (const list of (state.beams || new Map()).values()) {
    for (const b of list) {
      if (!beamInCluster(b, cluster)) continue;
      if (b.id === name || (b.uuid && (b.uuid === name || 'beam-' + b.uuid === name))) out.push(b);
    }
  }
  return out;
}

/** Load the beams once if nothing has asked for them yet. */
async function ensureBeams() {
  if (state.beams?.size) return;
  const { refreshBeams } = await import('./beams.js');
  await refreshBeams().catch(() => {});
}

/**
 * A kube cluster, named like a host — kubepanel.js's own
 * `kubeHostsForProfile(p)`, the exact function the sidebar tree and
 * this session's Hosts-pane fix both already merge into their own SSH
 * list, searched across every Teleport profile. Exact match first,
 * then one unambiguous partial match, the same two-step `findExact`/
 * `findPartial` already use below. Requestable-only rows are skipped:
 * opening one needs an access request first, a mutating action this
 * interface does not offer, with or without a Machine ID.
 */
async function kubeClusterNamed(name, cluster) {
  const kubepanel = await import('./kubepanel.js');
  const lower = name.toLowerCase();
  const candidates = [];
  for (const p of state.teleportProfiles || []) {
    if (cluster && p.cluster !== cluster) continue;
    for (const h of kubepanel.kubeHostsForProfile(p)) {
      if (!h.requestable) candidates.push(h);
    }
  }
  const exact = candidates.find((h) => h.name === name);
  if (exact) return exact;
  const partial = candidates.filter((h) => h.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${name}" matches ${partial.length} kube clusters: ` + partial.map((h) => h.name).join(', '));
  }
  return null;
}

/**
 * Match a name against beams, Teleport nodes, ssh_config aliases and saved
 * profiles.
 *
 * `beam` narrows it: true for beams only, false for anything but. Left unset,
 * a name that is exactly both a beam and another host is refused rather than
 * guessed, and the error says how to choose.
 */
async function findHost(name, cluster, beam) {
  const lower = name.toLowerCase();

  if (beam !== false) {
    await ensureBeams();
    const beams = findBeams(name, cluster);
    if (beams.length > 1) {
      throw new Error(`"${name}" matches ${beams.length} beams: `
        + beams.map((b) => `${b.id} (${b.proxy})`).join(', ') + '. Give a "cluster".');
    }
    const { beamHost } = await import('./beams.js');
    if (beams.length === 1) {
      // A beam's own node name is that beam, not a namesake.
      if (beam === true || name === 'beam-' + beams[0].uuid) return beamHost(beams[0]);
      const other = findExact(name, cluster);
      if (other) {
        throw new Error(`"${name}" is both a beam (${beams[0].proxy}) and a ${other.type} host `
          + `(${other.cluster || other.alias || other.name}). Say "beam": true for the beam, or false for the other.`);
      }
      return beamHost(beams[0]);
    }
    if (beam === true) throw new Error(`No beam called "${name}". Try list_beams to see what is available.`);
  }

  const exact = findExact(name, cluster);
  if (exact) return exact;
  return findPartial(lower, cluster);
}

/** A Teleport node, ssh_config alias or saved profile with exactly this name. */
function findExact(name, cluster) {
  for (const nodes of state.teleportNodes.values()) {
    for (const n of nodes) {
      if (cluster && n.cluster !== cluster) continue;
      if (n.name === name || n.hostname === name || n.uuid === name) return n;
    }
  }
  const ssh = state.sshHosts.find((h) => h.alias === name);
  if (ssh) return ssh;

  const profile = state.profiles.find((p) => p.name === name);
  if (profile) {
    if (profile.type === 'teleport') {
      return {
        id: `tsh:${profile.cluster}:${profile.node}`, type: 'teleport',
        name: profile.node, hostname: profile.node,
        cluster: profile.cluster, proxy: profile.proxy, home: profile.home || null,
      };
    }
    /*
     * A profile with its own connection details (any ssh profile that named
     * a hostname rather than only an alias, and every sftp profile — those
     * are always a standalone direct host) needs no ssh_config entry, same
     * as `launchProfile` (sidebar.js) building a host from one. Building
     * `{ alias: profile.alias }` for this case, as before, produced
     * `ssh:null` with no connection details at all: a profile saved by
     * hostname has no alias to carry.
     */
    if (profile.direct) {
      return {
        id: 'app:' + profile.id, type: 'ssh', name: profile.name, alias: profile.name,
        direct: profile.direct, user: profile.user, hostname: profile.hostname, port: profile.port,
        // Read back by openOne()/openSessions to default filesOnly and to
        // tag the connection so it can be found again (Hosts pane "Saved").
        profileType: profile.type, profileId: profile.id,
      };
    }
    return { id: 'ssh:' + profile.alias, type: 'ssh', alias: profile.alias, name: profile.name, configFile: profile.configFile || null };
  }
  return null;
}

/**
 * Nothing exact: one unambiguous partial match is still a clear intent.
 *
 * Beams' `beam-<uuid>` nodes are left out — reached as plain nodes they fail,
 * and a beam is only ever opened when it is named exactly.
 */
async function findPartial(lower, cluster) {
  const { beamNodeNames } = await import('./beams.js');
  const beamNodes = beamNodeNames();
  const partial = [];
  for (const nodes of state.teleportNodes.values()) {
    for (const n of nodes) {
      if (cluster && n.cluster !== cluster) continue;
      if (beamNodes.has(n.name) || /^beam-[0-9a-f-]{36}$/.test(n.name || '')) continue;
      if ((n.name || '').toLowerCase().includes(lower)) partial.push(n);
    }
  }
  for (const h of state.sshHosts) {
    if (h.alias.toLowerCase().includes(lower)) partial.push(h);
  }
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${lower}" matches ${partial.length} hosts: `
      + partial.slice(0, 8).map((h) => h.name || h.alias).join(', '));
  }
  return null;
}

/** Listen for requests from the control socket. */
export function initAutomation() {
  window.api.app.onAutomation(async ({ id, action, payload }) => {
    const fn = HANDLERS[action];
    if (!fn) {
      window.api.app.automationResult({ id, ok: false, error: `Unknown action "${action}"` });
      return;
    }
    try {
      const data = await fn(payload || {});
      window.api.app.automationResult({ id, ok: true, data });
    } catch (e) {
      window.api.app.automationResult({ id, ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  // Automation that opens sessions should be visible while it happens.
  window.api.control.onActivity((entry) => {
    if (entry?.text) status('Automation: ' + entry.text, 5000);
  });
}
