import { state } from './state.js';
import { el, $ } from './util.js';
import { toast, status } from './ui.js';

/**
 * Search everything — the box at the top right of the window.
 *
 * One place to type a name and get to it, whatever it is: a host, a saved
 * profile, a cluster or beam, an open tab, a macro or snippet, a layout, a
 * multi-exec run from the history, a saved AI prompt or response, something
 * from the menus, or a setting. Results are grouped by kind, best match first;
 * Enter opens the first, the arrows move, Escape leaves. ⌘P from anywhere
 * (Ctrl+Alt+P on Windows and Linux).
 */

/*
 * How well `q` matches an item: every word must be found somewhere in its
 * text, and a name that starts with the query, or a word in it that does,
 * ranks above a match in the middle of its details. 0 is no match.
 */
export function scoreMatch(q, name, extra = '') {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const n = String(name || '').toLowerCase();
  const all = `${n} ${String(extra || '').toLowerCase()}`;
  let score = 0;
  for (const w of words) {
    if (!all.includes(w)) return 0;
    if (n === w) score += 100;
    else if (n.startsWith(w)) score += 60;
    else if (new RegExp(`(^|[\\s._:/@=-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) score += 40;
    else if (n.includes(w)) score += 25;
    else score += 5;
  }
  // Shorter names are closer matches for the same words.
  return score + Math.max(0, 20 - n.length / 4);
}

/*
 * The menus, as things to search for: what each is called, other words for
 * it, and the action it runs.
 */
const COMMANDS = [
  ['New session…', 'connect open host', 'new-session'],
  ['New local shell', 'terminal local', 'new-local'],
  ['Quick connect…', 'ssh telnet vnc rdp serial address', 'quick-connect'],
  ['Add a server…', 'new server ssh config', 'add-server'],
  ['New window', '', 'new-window'],
  ['Multi-exec', 'run command many hosts fleet staged', 'multiexec'],
  ['Broadcast typing', 'type all panes', 'broadcast'],
  ['Command snippets…', 'snippet saved commands', 'snippets'],
  ['Run a macro…', 'macro', 'run-macro'],
  ['SSH keys…', 'agent keys identity', 'keys'],
  ['Network and certificate tools…', 'ping port dns trace network certificate cert ssh jwt spiffe svid subnet cidr url decode', 'nettools'],
  ['Cluster info', 'teleport cluster network', 'cluster-info'],
  ['S3 buckets…', 'aws s3 bucket', 's3'],
  ['Teleport panel', 'teleport clusters roles requests vnet', 'teleport-panel'],
  ['Sign in to Teleport…', 'tsh login', 'tsh-login'],
  ['Access request monitor', 'requests approve', 'request-monitor'],
  ['Session history', 'recent sessions', 'history'],
  ['Session recordings', 'recordings playback teleport', 'recordings'],
  ['Toggle the session log', 'log record output', 'toggle-log'],
  ['Find in terminal', 'search find text', 'find'],
  ['Split right', 'pane', 'split-right'],
  ['Split down', 'pane', 'split-down'],
  ['Split right with another host…', 'pane', 'split-right-host'],
  ['Split down with another host…', 'pane', 'split-down-host'],
  ['Duplicate tab', '', 'duplicate-tab'],
  ['Close pane', '', 'close-pane'],
  ['Disconnect', 'close end', 'disconnect'],
  ['File browser', 'files sftp explorer', 'toggle-files'],
  ['Local files', 'files local upload download', 'local-files'],
  ['Transfers', 'uploads downloads forwards tunnels', 'toggle-transfers'],
  ['Sidebar', 'hosts list', 'toggle-sidebar'],
  ['AI assistant', 'claude codex copilot gemini ai', 'toggle-ai'],
  ['Save layout as…', 'workspace layout', 'save-layout-as'],
  ['Load layout…', 'workspace layout', 'load-layout'],
  ['Manage layouts…', 'workspace layout', 'manage-layouts'],
  ['Refresh hosts', 'reload inventory', 'refresh'],
  ['Settings…', 'preferences options', 'settings'],
  ['Take the tour', 'tour help introduction', 'tour'],
  ['Guide', 'help manual', 'guide'],
  ['What’s new', 'version history changelog', 'version-history'],
  ['About ServerLife', 'version', 'about'],
  ['Zoom in', 'font bigger', 'zoom-in'],
  ['Zoom out', 'font smaller', 'zoom-out'],
];

const KIND = {
  tab: 'Open tabs', host: 'Hosts', profile: 'Saved profiles', beam: 'Beams', cluster: 'Clusters',
  macro: 'Macros', snippet: 'Snippets', layout: 'Layouts', run: 'Multi-exec runs',
  prompt: 'AI prompts', response: 'AI responses', command: 'Actions', setting: 'Settings',
};
const ORDER = Object.keys(KIND);
const PER_KIND = 6;

let hooks = { runAction: () => {}, openSettings: async () => {} };
let slow = null;        // what has to be asked for — snippets, layouts, runs, responses
let slowAt = 0;

/** What lives in the main process, fetched once a search starts and kept a minute. */
async function slowSources() {
  if (slow && Date.now() - slowAt < 60000) return slow;
  const [snippets, layouts, runs, responses] = await Promise.all([
    window.api.profiles.listSnippets().catch(() => []),
    window.api.workspace.listLayouts().catch(() => []),
    window.api.multiexec.history().catch(() => []),
    window.api.ai.savedList().catch(() => []),
  ]);
  slow = { snippets, layouts, runs, responses };
  slowAt = Date.now();
  return slow;
}

/**
 * Everything searchable, as { kind, name, extra, meta, open, data } — `data`
 * is what an agent is told about it (see searchData).
 */
async function everything() {
  const out = [];
  const add = (kind, name, extra, meta, open, data = {}) => out.push({ kind, name, extra, meta, open, data });

  for (const t of state.tabs) {
    add('tab', t.title || 'Tab', '', 'open tab', async () => {
      const s = await import('./sessions.js');
      state.setActiveTab(t.id); s.renderPanes(); s.focusActivePane();
    }, { index: state.tabs.indexOf(t) });
  }

  const { openHostFromList, preferredLogin } = await import('./sidebar.js');
  const { beamNodeNames, openBeam } = await import('./beams.js');
  const beamNodes = beamNodeNames();
  for (const nodes of state.teleportNodes.values()) {
    for (const n of nodes) {
      if (beamNodes.has(n.name)) continue;
      const labels = Object.entries(n.labels || {}).map(([k, v]) => `${k}=${v}`).join(' ');
      add('host', n.name, `${n.hostname || ''} ${n.addr || ''} ${n.cluster || ''} ${labels} ${n.uuid || n.id || ''}`,
        [n.cluster, labels.split(' ').slice(0, 3).join(' ')].filter(Boolean).join(' · '),
        () => openHostFromList(n, preferredLogin(n)),
        { type: 'teleport', cluster: n.cluster, hostname: n.hostname, addr: n.addr, uuid: n.uuid || n.id, labels: n.labels || {}, login: preferredLogin(n) || null });
    }
  }
  for (const h of state.sshHosts) {
    add('host', h.alias || h.name, `${h.hostname || ''} ${h.user || ''}`, `${h.user ? h.user + '@' : ''}${h.hostname || ''} · ssh`,
      () => openHostFromList(h, preferredLogin(h)),
      { type: 'ssh', alias: h.alias, hostname: h.hostname, user: h.user || null, port: h.port });
  }
  for (const list of (state.beams || new Map()).values()) {
    for (const b of list) add('beam', b.id, `${b.proxy || ''} beam`, b.proxy || 'beam', () => openBeam(b), { proxy: b.proxy });
  }

  for (const p of state.profiles || []) {
    add('profile', p.name, `${p.alias || ''} ${p.node || ''} ${p.cluster || ''} ${p.hostname || ''} ${p.type || ''}`,
      [p.type, p.node ? `${p.node} @ ${p.cluster}` : p.hostname].filter(Boolean).join(' · '),
      async () => (await import('./sidebar.js')).launchProfile(p),
      { type: p.type, node: p.node, cluster: p.cluster, hostname: p.hostname, alias: p.alias });
  }

  const seen = new Set();
  for (const p of state.teleportProfiles || []) {
    const key = `${p.cluster}\u0000${p.home || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add('cluster', p.cluster, `${p.proxy || ''} ${(p.roles || []).join(' ')} teleport`, `${p.user || ''}${p.proxy ? ' · ' + p.proxy : ''}`,
      () => hooks.runAction('teleport-panel'), { proxy: p.proxy, user: p.user, roles: p.roles || [] });
  }

  for (const m of state.macros || []) {
    add('macro', m.name, `${m.category || ''} ${m.command || ''}`, m.category || 'macro', async () => {
      const mm = await import('./macros.js');
      if (state.activePane?.termId) return mm.sendMacro(m);
      toast('Open a session to run the macro in, then choose it again', 'info');
    }, { category: m.category || 'Custom', command: m.command });
  }

  const s = await slowSources();
  for (const sn of s.snippets) {
    add('snippet', sn.name, sn.command || '', (sn.command || '').slice(0, 60), async () => {
      const m = await import('./snippets.js');
      if (state.activePane?.termId) return m.runSnippet(sn);
      m.openSnippetsDialog();
    }, { command: sn.command });
  }
  for (const l of s.layouts) {
    add('layout', l.name, 'layout workspace', `${l.workspace?.tabs?.length || 0} tab(s)`,
      async () => (await import('./workspace.js')).loadLayoutDialogFor(l), { tabs: l.workspace?.tabs?.length || 0 });
  }
  for (const r of s.runs.slice(0, 200)) {
    add('run', r.command, `${(r.hosts || []).join(' ')} ${r.label || ''} ${r.selector?.query || ''} ${r.runAs || ''}`,
      [r.selector?.query ? `by tag ${r.selector.query}` : `${(r.hosts || []).length} host(s)`, r.runAs ? `as ${r.runAs}` : ''].filter(Boolean).join(' · '),
      async () => { (await import('./dock.js')).editExecRun(r); },
      { hosts: r.hosts || [], tagQuery: r.selector?.query || null, runAs: r.runAs || null, ok: r.ok, failed: r.failed, at: r.at });
  }

  const ai = await import('./ai.js');
  for (const p of ai.savedPrompts()) {
    add('prompt', p.name, p.text, 'send to the AI assistant', () => ai.askAi(p.text, { send: true }), { text: p.text });
  }
  for (const r of s.responses) {
    add('response', r.title, r.file, new Date(r.mtime).toLocaleDateString(), () => ai.openSavedResponses(), { path: r.path, saved: r.mtime });
  }

  for (const [name, extra, action] of COMMANDS) add('command', name, extra, '', () => hooks.runAction(action));
  return out;
}

/* What an agent does next with each kind of result. */
const NEXT = {
  tab: 'serverlife_read_output with tab = its index, or serverlife_close_session with index',
  host: 'serverlife_open_session with host = its name, cluster for a Teleport node, login if wanted',
  profile: 'serverlife_open_session with host = the profile name',
  beam: 'serverlife_open_session with host = the beam name',
  cluster: 'serverlife_list_hosts or serverlife_list_clusters',
  macro: 'serverlife_run_macro with its name',
  snippet: 'its command, for the user to run',
  layout: 'serverlife_load_layout with its name',
  run: 'the hosts and command it ran, for the user to run again from multi-exec',
  prompt: 'its text',
  response: 'the file at its path',
};

/**
 * The search, for an agent (the MCP serverlife_search tool): the same matches
 * as the box, as plain data — the actions and settings the box also offers
 * are left out, as nothing an agent can use.
 */
export async function searchData(q, { limit = 8, kinds = null } = {}) {
  const per = Math.max(1, Math.min(50, Math.floor(Number(limit)) || 8));
  const want = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  const items = (await everything()).filter((it) => it.kind !== 'command' && (!want || want.has(it.kind)));
  const groups = rank(items, q, per);
  return {
    query: q,
    total: groups.reduce((a, g) => a + g.items.length + Math.max(0, g.more), 0),
    groups: groups.map((g) => ({
      kind: g.kind, title: g.title, next: NEXT[g.kind], more: Math.max(0, g.more),
      results: g.items.map((it) => ({ name: it.name, summary: it.meta || '', ...it.data })),
    })),
  };
}

/** The results for a query: grouped, best first, a few of each kind. */
export function rank(items, q, per = PER_KIND) {
  const scored = items.map((it) => ({ ...it, score: scoreMatch(q, it.name, it.extra) })).filter((it) => it.score > 0);
  const groups = [];
  for (const kind of ORDER) {
    const list = scored.filter((it) => it.kind === kind).sort((a, b) => b.score - a.score);
    if (list.length) groups.push({ kind, title: KIND[kind], items: list.slice(0, per), more: list.length - per });
  }
  // The kind with the best single match goes first.
  return groups.sort((a, b) => b.items[0].score - a.items[0].score);
}

/** Open Settings and bring the setting whose label matches `q` into view. */
async function openSettingAt(q) {
  hooks.openSettings();
  const needle = q.toLowerCase();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const labels = [...document.querySelectorAll('.modal label, .modal h3, .modal h4, .modal .hint')];
    if (!labels.length) continue;
    const hit = labels.find((l) => l.textContent.toLowerCase().includes(needle));
    if (!hit) { status(`No setting mentions “${q}”`); return; }
    const row = hit.closest('.field') || hit;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('search-flash');
    setTimeout(() => row.classList.remove('search-flash'), 1800);
    return;
  }
}

/** Put the box in the title bar and wire it up. */
export function initSearch({ runAction, openSettings }) {
  hooks = { runAction, openSettings };
  const input = el('input', {
    id: 'global-search', type: 'search', spellcheck: 'false', autocomplete: 'off',
    placeholder: `Search ServerLife  ${navigator.platform.startsWith('Mac') ? '⌘P' : 'Ctrl+Alt+P'}`,
    title: 'Hosts, profiles, clusters, beams, macros, snippets, layouts, multi-exec runs, AI prompts, actions and settings',
  });
  const drop = el('div', { id: 'global-search-results', class: 'hidden' });
  const wrap = el('div', { class: 'tb-search' }, input, drop);
  const actions = $('#titlebar-actions');
  actions.parentNode.insertBefore(wrap, actions);

  let flat = [];
  let active = 0;
  let seq = 0;
  let items = null;

  const close = () => { drop.classList.add('hidden'); active = 0; };
  const choose = async (it) => {
    close();
    input.value = '';
    input.blur();
    try { await it.open(); } catch (e) { toast(e.message, 'error'); }
  };
  const draw = (groups, q) => {
    drop.replaceChildren();
    flat = [];
    for (const g of groups) {
      drop.append(el('div', { class: 'gs-head', text: g.title + (g.more > 0 ? `  ·  ${g.more} more` : '') }));
      for (const it of g.items) {
        const i = flat.length;
        flat.push(it);
        const row = el('div', { class: 'gs-row' + (i === active ? ' active' : '') },
          el('span', { class: 'gs-name', text: it.name }),
          el('span', { class: 'gs-meta', text: it.meta || '' }));
        row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it); });
        row.addEventListener('mouseenter', () => { active = i; mark(); });
        drop.append(row);
      }
    }
    // A setting is found by opening Settings at it.
    const i = flat.length;
    const it = { kind: 'setting', name: `Search settings for “${q}”`, open: () => openSettingAt(q) };
    flat.push(it);
    drop.append(el('div', { class: 'gs-head', text: KIND.setting }));
    const row = el('div', { class: 'gs-row' + (i === active ? ' active' : '') }, el('span', { class: 'gs-name', text: it.name }));
    row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it); });
    drop.append(row);
    drop.classList.remove('hidden');
  };
  const mark = () => {
    const rows = drop.querySelectorAll('.gs-row');
    rows.forEach((r, i) => r.classList.toggle('active', i === active));
    rows[active]?.scrollIntoView({ block: 'nearest' });
  };
  const update = async () => {
    const q = input.value.trim();
    if (!q) return close();
    const my = ++seq;
    items = await everything();
    if (my !== seq) return;
    active = 0;
    draw(rank(items, q), q);
  };

  input.addEventListener('input', update);
  input.addEventListener('focus', () => { slow = null; if (input.value.trim()) update(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, flat.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) choose(flat[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; close(); input.blur(); import('./sessions.js').then((m) => m.focusActivePane()); }
  });
}

/** ⌘P: into the box, whatever has focus. */
export function focusSearch() {
  const input = $('#global-search');
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}
