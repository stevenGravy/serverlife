import { state, tpKey } from './state.js';
import { el, clear, fmtDate, fmtDuration, debounce } from './util.js';
import { modal, toast, status, confirm, textInput, select, field, checkbox } from './ui.js';
import { openLocalShell } from './sessions.js';

/**
 * Session history and recorded-session playback.
 *
 * Two views over the same question — "what happened on these servers?":
 * a local log of every session this app opened (including plain SSH, which
 * Teleport never sees), and Teleport's own recordings, which can be replayed
 * in a tab or opened in the web UI.
 */

let activeTab = 'history';
let cachedRecordings = [];
let recordingsProxy = null;
/*
 * Which tsh home the chosen cluster's certificate is in. A proxy alone stopped
 * being an identity once several homes could hold the same one.
 */
let recordingsHome = null;
let filterText = '';
/*
 * Non-interactive sessions are hidden by default.
 *
 * An `exec` recording is a command someone ran over SSH — a health check, a
 * config read, anything the app's own "run a command" does — and a cluster
 * produces hundreds of them for every session a person actually sat in. They
 * have no transcript to search and nothing to watch, so a list of recordings
 * that includes them is mostly noise around the handful worth opening.
 */
let showNonInteractive = false;
let flaggedOnly = false;
/** sid -> { flagged, note, … }, as the store holds them. */
let sessionNotes = new Map();

/**
 * tsh lists recordings by date, not by timestamp, so these are whole days.
 * Shared by the recordings list and the transcript search below — both ask
 * `tsh recordings ls`/`tsh recordings search` the same way.
 */
const RANGES = [
  { label: 'Today and yesterday', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  // Teleport rejects ranges beyond roughly half a year, so this is the
  // practical maximum rather than a promise of "everything".
  { label: 'Last 180 days (maximum)', days: 180 },
];

/** A plain YYYY-MM-DD, which is the only format tsh accepts. */
function dateDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/*
 * The recordings list defaulted to whatever `tsh recordings ls` does with
 * no range at all — the last 24 hours, silently — with no control to look
 * further back. Kept at a day by default (closest match to that old
 * behaviour); the two date fields are the actual source of truth read at
 * fetch time — a RANGES preset is just a shortcut that fills them in,
 * not a separate kind of state, so picking an exact day needs nothing
 * the presets don't already use.
 */
let fromDateStr = dateDaysAgo(1);
let toDateStr = dateDaysAgo(0);

async function loadSessionNotes() {
  try {
    const list = await window.api.recordings.notes();
    sessionNotes = new Map(list.map((n) => [n.sid, n]));
  } catch { sessionNotes = new Map(); }
  return sessionNotes;
}

export async function openSessionsDialog(initialTab = 'history', opts = {}) {
  activeTab = initialTab;
  // Opening this for one host should land on that host, not the whole cluster.
  if (opts.filter !== undefined) filterText = String(opts.filter || '').toLowerCase();
  if (opts.proxy) { recordingsProxy = opts.proxy; recordingsHome = opts.home || null; cachedRecordings = []; }

  const tabBar = el('div', { class: 'sb-tabs', style: 'margin:-4px -2px 12px' });
  const mkTab = (key, label) => {
    const b = el('button', { class: 'sb-tab' + (activeTab === key ? ' active' : ''), text: label });
    b.addEventListener('click', () => {
      activeTab = key;
      [...tabBar.children].forEach((c) => c.classList.toggle('active', c === b));
      render();
    });
    return b;
  };
  tabBar.append(
    mkTab('history', 'Connection history'),
    mkTab('recordings', 'Teleport recordings'),
    mkTab('search', 'Search transcripts'));

  const search = textInput({ placeholder: 'Filter…', value: filterText });
  search.addEventListener('input', debounce(() => { filterText = search.value.trim().toLowerCase(); render(); }, 120));

  const listNode = el('div');

  const render = async () => {
    clear(listNode);
    search.parentElement?.classList.toggle('hidden', activeTab === 'search');
    if (activeTab === 'history') await renderHistory(listNode);
    else if (activeTab === 'search') renderTranscriptSearch(listNode);
    else await renderRecordings(listNode);
  };

  await modal({
    title: 'Sessions',
    subtitle: 'History and recordings',
    width: 'min(920px, 95vw)',
    render: (b) => {
      b.append(tabBar, el('div', { class: 'field' }, search), listNode);
      render();
    },
    buttons: [
      {
        label: 'Refresh',
        onClick: () => { cachedRecordings = []; render(); },
      },
      { label: 'Close', value: null },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Local connection history                                            */
/* ------------------------------------------------------------------ */

async function renderHistory(node) {
  node.append(el('div', { class: 'sb-empty', text: 'Loading history…' }));
  let entries;
  try {
    entries = await window.api.history.list({ limit: 300 });
  } catch (e) {
    clear(node);
    node.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: e.message }));
    return;
  }
  clear(node);

  const shown = entries.filter((h) => !filterText ||
    [h.label, h.node, h.cluster, h.login, h.target, h.hostname].filter(Boolean).join(' ').toLowerCase().includes(filterText));

  if (!shown.length) {
    node.append(el('div', { class: 'sb-empty', text: entries.length ? 'No matches.' : 'No sessions recorded yet.' }));
    return;
  }

  node.append(el('div', {
    style: 'display:flex;justify-content:flex-end;margin-bottom:8px',
  }, el('button', {
    class: 'ghost-btn sm danger-btn', text: 'Clear history',
    onClick: async () => {
      if (!await confirm({
        title: 'Clear history', message: 'Delete the local session history?',
        detail: 'The addresses Quick connect offers back go with it. '
          + 'Teleport’s own audit log is unaffected.',
        confirmLabel: 'Clear', danger: true,
      })) return;
      await window.api.history.clear();
      // Quick connect keeps its own short list of typed addresses; leaving it
      // behind would mean "clear history" did not.
      const { clearQuickConnectHistory } = await import('./quickconnect.js');
      await clearQuickConnectHistory();
      clear(node);
      await renderHistory(node);
    },
  })));

  const table = el('div', { class: 'picker-list' });
  for (const h of shown) {
    const live = !h.endedAt && !h.error;
    const dur = h.endedAt ? fmtDuration(h.endedAt - h.startedAt) : (live ? 'open' : '');
    const row = el('div', { class: 'picker-item', style: 'cursor:default' },
      el('span', {
        class: 'st ' + (h.error ? 'error' : live ? 'connected' : ''),
        style: `width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${
          h.error ? 'var(--red)' : live ? 'var(--green)' : 'var(--muted)'}`,
      }),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'pname', text: h.label || h.target }),
        el('div', { class: 'pmeta', text: [
          h.type === 'teleport' ? `tsh · ${h.cluster || ''}` : 'ssh',
          h.login ? 'as ' + h.login : '',
          h.error ? 'failed: ' + h.error : '',
        ].filter(Boolean).join('  ·  ') })),
      el('span', { class: 'pmeta', style: 'width:120px;text-align:right', text: fmtDate(h.startedAt) }),
      el('span', { class: 'pmeta', style: 'width:64px;text-align:right', text: dur }));
    table.append(row);
  }
  node.append(table);
}

/* ------------------------------------------------------------------ */
/* Teleport recordings                                                 */
/* ------------------------------------------------------------------ */

async function renderRecordings(node) {
  // Every known profile, not just the ones still logged in — a cluster
  // whose certificate has lapsed is not gone, just one "Login" away, the
  // same offer teleportpanel.js's own profile list already makes rather
  // than hiding it until it's active again.
  const profiles = state.teleportProfiles;
  if (!profiles.length) {
    node.append(el('div', { class: 'sb-empty', text: 'No Teleport profile. Log in first.' }));
    return;
  }

  const chooser = select(profiles.map(profileOption), currentKey(profiles));
  chooser.addEventListener('change', () => {
    const p = profiles.find((x) => tpKey(x) === chooser.value) || profiles[0];
    recordingsProxy = p.proxy;
    recordingsHome = p.homeDir || null;
    cachedRecordings = [];
    clear(node);
    renderRecordings(node);
  });
  const chosen = profiles.find((x) => tpKey(x) === currentKey(profiles)) || profiles[0];
  recordingsProxy = chosen.proxy;
  recordingsHome = chosen.homeDir || null;

  // How far back to ask — defaulted to the last 24 hours (tsh's own default
  // with no range given at all) until now, with no way to look further
  // back without knowing to pass one. The dropdown is a shortcut that fills
  // the two date fields in; typing an exact day into either is just as good.
  const rangeSel = select([{ value: '', label: 'Custom range…' }, ...RANGES.map((r) => ({ value: String(r.days), label: r.label }))], '');
  const fromIn = el('input', { type: 'date', value: fromDateStr, max: toDateStr });
  const toIn = el('input', { type: 'date', value: toDateStr, max: dateDaysAgo(0) });
  const applyDates = () => {
    cachedRecordings = [];
    clear(node);
    renderRecordings(node);
  };
  rangeSel.addEventListener('change', () => {
    if (!rangeSel.value) return;
    fromDateStr = dateDaysAgo(Number(rangeSel.value));
    toDateStr = dateDaysAgo(0);
    applyDates();
  });
  fromIn.addEventListener('change', () => { fromDateStr = fromIn.value || fromDateStr; applyDates(); });
  toIn.addEventListener('change', () => { toDateStr = toIn.value || toDateStr; applyDates(); });
  node.append(el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end' },
    el('div', { class: 'field' }, el('label', { text: 'Cluster' }), chooser),
    el('div', { class: 'field' }, el('label', { text: 'Range' }), rangeSel),
    el('div', { class: 'field' }, el('label', { text: 'From' }), fromIn),
    el('div', { class: 'field' }, el('label', { text: 'To' }), toIn)));

  const listWrap = el('div');
  node.append(listWrap);

  if (chosen.expired) {
    listWrap.append(el('div', { class: 'sb-empty' },
      el('div', { text: `${chosen.cluster || chosen.proxy}'s certificate has expired — log in to view its recordings.` }),
      el('button', {
        class: 'primary-btn sm', style: 'margin-top:8px', text: 'Login',
        onClick: async () => {
          const { doLogin } = await import('./teleportpanel.js');
          const ok = await doLogin(chosen);
          // A fresh certificate on the same proxy+home is still found by
          // currentKey() below, so the dropdown stays on the cluster just
          // logged into rather than jumping elsewhere.
          if (ok) { cachedRecordings = []; clear(node); renderRecordings(node); }
        },
      })));
    return;
  }

  if (!cachedRecordings.length) {
    listWrap.append(el('div', { class: 'sb-empty', text: 'Loading recordings…' }));
    try {
      const res = await window.api.recordings.list({
        proxy: recordingsProxy, home: recordingsHome, fromUtc: fromDateStr, toUtc: toDateStr,
      });
      if (!res.ok) throw new Error(res.error || 'Could not list recordings');
      cachedRecordings = res.recordings;
    } catch (e) {
      clear(listWrap);
      listWrap.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: e.message }));
      return;
    }
  }
  clear(listWrap);
  await loadSessionNotes();

  /*
   * The two switches that decide what a list of recordings is for: everything
   * a person actually sat in (the default), or every exec the cluster logged
   * as well — and, separately, only the ones flagged to come back to.
   */
  const interactiveBox = checkbox('Include non-interactive (exec) sessions', showNonInteractive);
  interactiveBox.input.addEventListener('change', () => {
    showNonInteractive = interactiveBox.input.checked;
    clear(node);
    renderRecordings(node);
  });
  const flaggedBox = checkbox('Flagged only', flaggedOnly);
  flaggedBox.input.addEventListener('change', () => {
    flaggedOnly = flaggedBox.input.checked;
    clear(node);
    renderRecordings(node);
  });
  listWrap.append(el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px' },
    interactiveBox, flaggedBox));

  const matches = (r) => !filterText
    || [r.node, r.login, r.user, r.sid, r.cluster, sessionNotes.get(r.sid)?.note]
      .filter(Boolean).join(' ').toLowerCase().includes(filterText);

  let shown = cachedRecordings
    .filter((r) => showNonInteractive || r.interactive)
    .filter(matches);
  const hiddenExec = cachedRecordings.filter((r) => !r.interactive).length;

  if (flaggedOnly) {
    /*
     * Flagged sessions are shown even when the cluster no longer lists them.
     *
     * The whole point of flagging one is to come back to it, and "later" is
     * often after it has fallen out of the range `tsh recordings ls` will
     * answer for. The saved record carries enough — node, user, when — to
     * list it and to play it by id.
     */
    const inList = new Set(shown.map((r) => r.sid));
    const saved = [...sessionNotes.values()]
      .filter((n) => n.flagged && !inList.has(n.sid))
      .filter((n) => !recordingsProxy || !n.proxy || n.proxy === recordingsProxy)
      .map((n) => ({ ...n, proxy: n.proxy || recordingsProxy, interactive: true, fromNote: true }))
      .filter(matches);
    shown = [...shown.filter((r) => sessionNotes.get(r.sid)?.flagged), ...saved]
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  if (!shown.length) {
    listWrap.append(el('div', { class: 'sb-empty' },
      el('div', { text: flaggedOnly
        ? 'Nothing flagged yet.'
        : (cachedRecordings.length ? 'No matches.' : 'No recordings found for this cluster.') }),
      flaggedOnly
        ? el('div', { style: 'margin-top:6px;opacity:.75', text: 'Flag a recording with its ☆ to keep it here.' })
        : (hiddenExec && !showNonInteractive
            ? el('div', { style: 'margin-top:6px;opacity:.75',
                text: `${hiddenExec} non-interactive session(s) are hidden — tick the box above to include them.` })
            : null),
      // A session id pasted in that is not in the range can still be opened.
      sidLookup(filterText)));
    return;
  }

  const table = el('div', { class: 'picker-list' });
  for (const r of shown) {
    const note = sessionNotes.get(r.sid);
    const row = el('div', { class: 'picker-item' + (note?.flagged ? ' flagged' : ''), style: 'cursor:default;gap:10px' },
      // Flagging is one click, on the row, because deciding to come back to a
      // session happens while looking at it.
      el('button', {
        class: 'icon-btn sm flagbtn' + (note?.flagged ? ' on' : ''),
        text: note?.flagged ? '★' : '☆',
        title: note?.flagged ? 'Flagged — click to unflag' : 'Flag this session to come back to it',
        onClick: async () => {
          await window.api.recordings.saveNote({ ...recordKey(r), flagged: !note?.flagged });
          clear(node);
          renderRecordings(node);
        },
      }),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'pname' },
          r.node || 'unknown node',
          r.fromNote
            ? el('span', { class: 'tag', style: 'margin-left:7px', text: 'outside the range' })
            : el('span', { class: 'tag', style: 'margin-left:7px', text: r.interactive ? 'interactive' : 'exec' }),
          // ssh is the overwhelming majority of rows — only label the ones
          // that aren't, so a kube/app/db session is recognizable at a
          // glance instead of looking like a nameless ssh one.
          r.proto && r.proto !== 'ssh'
            ? el('span', { class: 'tag', style: 'margin-left:5px', text: r.proto })
            : null,
          !r.playable ? el('span', { class: 'tag', style: 'margin-left:5px;color:var(--amber)', text: 'not recorded' }) : null),
        el('div', { class: 'pmeta', text: [
          `${r.user} → ${r.login}`,
          r.durationMs !== null && r.durationMs !== undefined ? fmtDuration(r.durationMs) : '',
          (r.sid || '').slice(0, 8),
        ].filter(Boolean).join('  ·  ') }),
        note?.note
          ? el('div', { class: 'pmeta session-note', title: note.note, text: note.note })
          : null),
      el('span', { class: 'pmeta', style: 'width:118px;text-align:right', text: fmtDate(r.startedAt) }),
      el('button', {
        class: 'ghost-btn sm',
        text: note?.note ? 'Note ✎' : 'Note…',
        title: note?.note ? note.note : 'Write a note about this session',
        onClick: () => editSessionNote(r, () => { clear(node); renderRecordings(node); }),
      }),
      el('button', {
        class: 'ghost-btn sm',
        text: 'Play',
        disabled: r.playable === false,
        title: r.playable === false ? 'This session was not recorded' : 'Replay in a local tab',
        onClick: () => playRecording(r),
      }),
      el('button', {
        class: 'ghost-btn sm',
        text: 'Web UI',
        title: 'Open in the Teleport web UI',
        onClick: () => openInWeb(r),
      }));
    table.append(row);
  }
  listWrap.append(table);

  const notes = [];
  if (!showNonInteractive && hiddenExec) {
    notes.push(`${hiddenExec} non-interactive session(s) hidden.`);
  }
  if (notes.length) {
    listWrap.append(el('div', { class: 'hint', style: 'margin-top:8px', text: notes.join(' ') }));
  }
  listWrap.append(sidLookup(filterText) || el('span'));
}

/** What a saved note keeps about the session it belongs to. */
function recordKey(r) {
  return {
    sid: r.sid,
    cluster: r.cluster || '',
    proxy: r.proxy || recordingsProxy || '',
    home: r.home ?? recordingsHome ?? null,
    node: r.node || '',
    user: r.user || '',
    login: r.login || '',
    startedAt: r.startedAt ?? null,
    durationMs: r.durationMs ?? null,
    playable: r.playable !== false,
  };
}

/**
 * A session id typed into the filter that is not in the list.
 *
 * Session ids arrive from elsewhere — an audit log, a colleague, a ticket —
 * and the session they name is usually outside whatever range is loaded.
 * `tsh play` needs only the id, so there is no reason to make someone widen a
 * date range to reach it.
 */
function sidLookup(text) {
  const sid = String(text || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return null;
  if (cachedRecordings.some((r) => r.sid.toLowerCase() === sid.toLowerCase())) return null;

  const rec = { sid, proxy: recordingsProxy, home: recordingsHome, playable: true };
  return el('div', { class: 'qc-advice', style: 'margin-top:10px' },
    el('div', { class: 'qc-advice-head', text: 'That looks like a session id' }),
    el('div', { class: 'perm-note', text: 'It is not in the range loaded here, but a recording can be '
      + 'opened by id alone.' }),
    el('div', { style: 'display:flex;gap:6px;margin-top:9px;flex-wrap:wrap' },
      el('button', { class: 'primary-btn sm', text: 'Play it', onClick: () => playRecording(rec) }),
      el('button', { class: 'ghost-btn sm', text: 'Open in web UI', onClick: () => openInWeb(rec) }),
      el('button', {
        class: 'ghost-btn sm', text: 'Flag it with a note…',
        onClick: () => editSessionNote(rec, () => {}),
      })));
}

/** Write (or clear) the note on a session. */
async function editSessionNote(r, done) {
  const existing = sessionNotes.get(r.sid);
  const area = el('textarea', {
    class: 'macro-cmd', rows: '5', spellcheck: 'true',
    placeholder: 'What happened here, and why you might want it again.',
  });
  area.value = existing?.note || '';
  const flag = checkbox('Keep it flagged', existing?.flagged !== false);

  const res = await modal({
    title: 'Note on a session',
    subtitle: [r.node, r.user, r.startedAt ? fmtDate(r.startedAt) : '', (r.sid || '').slice(0, 8)]
      .filter(Boolean).join('  ·  '),
    width: 'min(620px, 94vw)',
    render: (body) => {
      body.append(
        el('div', { class: 'hint', style: 'margin-bottom:8px' },
          'Kept against the session id, so it survives the recording falling out of the range '
          + 'the cluster will list.'),
        area, flag);
    },
    buttons: [
      { label: 'Cancel', value: null },
      existing ? { label: 'Remove', class: 'ghost-btn danger-btn', value: 'delete' } : null,
      { label: 'Save', class: 'primary-btn', value: 'save' },
    ].filter(Boolean),
  });
  if (!res) return;

  try {
    if (res === 'delete') await window.api.recordings.deleteNote(r.sid);
    else {
      await window.api.recordings.saveNote({
        ...recordKey(r),
        note: area.value.trim(),
        flagged: flag.input.checked,
      });
    }
    await loadSessionNotes();
    done?.();
  } catch (e) { toast(e.message, 'error'); }
}

/** A cluster option that says which tsh home it came from. */
function profileOption(p) {
  return {
    value: tpKey(p),
    label: (p.cluster || p.proxy) + (p.homeName ? ' · ' + p.homeName : '') + (p.expired ? '  (expired)' : ''),
  };
}

/** The key of the profile currently chosen, falling back to the first. */
function currentKey(profiles) {
  const match = profiles.find((p) => p.proxy === recordingsProxy
      && (p.homeDir || null) === (recordingsHome || p.homeDir || null));
  return tpKey(match || profiles[0]);
}

/** Replay a recording locally, in a tab, via `tsh play`. */
export async function playRecording(r, opts = {}) {
  try {
    const { command, args, teleportHome } = await window.api.recordings.playArgs(r.sid, {
      proxy: r.proxy || recordingsProxy,
      home: r.home || recordingsHome,
      cluster: r.cluster,
      speed: opts.speed,
      skipIdle: opts.skipIdle,
    });
    await openLocalShell(undefined, {
      command, args, teleportHome,
      title: `▶ ${r.node || 'recording'} · ${r.sid.slice(0, 8)}`,
    });
    status(`Replaying session ${r.sid.slice(0, 8)}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function openInWeb(r) {
  try {
    const url = await window.api.recordings.openWeb({
      proxy: r.proxy || recordingsProxy,
      cluster: r.cluster,
      sid: r.sid,
    });
    status('Opened in browser: ' + url);
  } catch (e) {
    toast(e.message, 'error');
  }
}


/* ------------------------------------------------------------------ */
/* Searching recorded session transcripts                              */
/* ------------------------------------------------------------------ */

let lastSearch = { query: '', days: 7, caseSensitive: false, useRegex: false, saveDir: null };

/**
 * Fetch the transcripts of recorded sessions in a time range and look for a
 * word. Each transcript is its own `tsh play`, so the range and the session cap
 * are deliberately visible: this is a search you decide to run, not one that
 * happens in the background.
 */
function renderTranscriptSearch(node) {
  const profiles = state.teleportProfiles.filter((p) => !p.expired);
  if (!profiles.length) {
    node.append(el('div', { class: 'sb-empty', text: 'No active Teleport profile. Log in first.' }));
    return;
  }

  const clusterSel = select(profiles.map(profileOption), currentKey(profiles));
  const preset = profiles.find((x) => tpKey(x) === currentKey(profiles)) || profiles[0];
  recordingsProxy = preset.proxy;
  recordingsHome = preset.homeDir || null;
  clusterSel.addEventListener('change', () => {
    const p = profiles.find((x) => tpKey(x) === clusterSel.value) || profiles[0];
    recordingsProxy = p.proxy;
    recordingsHome = p.homeDir || null;
  });

  const queryIn = textInput({ value: lastSearch.query, placeholder: 'sudo, systemctl restart, a hostname…', autofocus: true });
  const rangeSel = select(RANGES.map((r) => ({ value: String(r.days), label: r.label })), String(lastSearch.days));
  const limitIn = textInput({ type: 'number', value: '200', min: 1, max: 2000 });
  const caseBox = checkbox('Match case', lastSearch.caseSensitive);
  const regexBox = checkbox('Regular expression', lastSearch.useRegex);
  const allBox = checkbox('Include non-interactive sessions (usually have no transcript)', false);

  let saveDir = lastSearch.saveDir;
  const saveLabel = el('span', { class: 'pmeta', text: saveDir || 'not saving' });
  const saveBtn = el('button', {
    class: 'ghost-btn sm', text: 'Download to folder…',
    title: 'Also write every transcript scanned into a folder',
    onClick: async () => {
      const dir = await window.api.recordings.chooseSaveDir();
      if (dir) { saveDir = dir; saveLabel.textContent = dir; }
    },
  });
  const clearSaveBtn = el('button', {
    class: 'ghost-btn sm', text: 'Don\u2019t save',
    onClick: () => { saveDir = null; saveLabel.textContent = 'not saving'; },
  });

  const progress = el('div', { class: 'hint', style: 'margin:10px 0' });
  const results = el('div');
  let running = false;

  const runBtn = el('button', { class: 'primary-btn', text: 'Search' });
  const cancelBtn = el('button', { class: 'ghost-btn hidden', text: 'Stop' });

  cancelBtn.addEventListener('click', () => {
    window.api.recordings.cancelSearch().catch(() => {});
    progress.textContent = 'Stopping…';
  });

  const run = async () => {
    const query = queryIn.value.trim();
    if (!query) return toast('Enter something to search for', 'error');
    if (running) return;
    running = true;
    runBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    clear(results);
    progress.textContent = 'Listing recordings…';

    const days = Number(rangeSel.value);
    lastSearch = { query, days, caseSensitive: caseBox.input.checked, useRegex: regexBox.input.checked, saveDir };

    const off = window.api.recordings.onSearchProgress((p) => {
      progress.textContent = `Scanned ${p.scanned}/${p.total} — ${p.matches} matching${p.current ? ' · ' + p.current : ''}`;
    });

    try {
      const res = await window.api.recordings.search({
        proxy: recordingsProxy,
        home: recordingsHome,
        query,
        fromUtc: dateDaysAgo(days || 180),
        caseSensitive: caseBox.input.checked,
        useRegex: regexBox.input.checked,
        interactiveOnly: !allBox.input.checked,
        limit: parseInt(limitIn.value, 10) || 200,
        saveDir,
        contextLines: 1,
      });
      if (res.ok === false) {
        results.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: res.error || 'Search failed' }));
        progress.textContent = '';
        return;
      }
      renderSearchResults(results, res, query);
      progress.textContent = [
        `${res.results.length} session${res.results.length === 1 ? '' : 's'} matched`,
        `${res.scanned} scanned`,
        res.failed ? `${res.failed} without a stored recording` : null,
        res.skippedNonInteractive ? `${res.skippedNonInteractive} non-interactive skipped` : null,
        res.savedTo ? `transcripts saved to ${res.savedTo}` : null,
        res.stopped ? 'stopped early' : null,
      ].filter(Boolean).join(' · ');
    } catch (e) {
      progress.textContent = '';
      results.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: e.message }));
    } finally {
      off?.();
      running = false;
      runBtn.classList.remove('hidden');
      cancelBtn.classList.add('hidden');
    }
  };

  runBtn.addEventListener('click', run);
  queryIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });

  node.append(
    el('div', { class: 'field-row' },
      field('Cluster', clusterSel),
      field('Time range', rangeSel),
      field('Max sessions', limitIn)),
    field('Find', queryIn, 'Searches the text of each recorded session'),
    el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;align-items:center' },
      caseBox, regexBox, allBox),
    el('div', { style: 'display:flex;gap:8px;align-items:center;margin:10px 0' },
      saveBtn, clearSaveBtn, saveLabel),
    el('div', { class: 'row', style: 'display:flex;gap:8px' }, runBtn, cancelBtn),
    progress,
    results);
}

function renderSearchResults(node, res, query) {
  clear(node);
  if (!res.results.length) {
    node.append(el('div', { class: 'sb-empty' },
      el('div', { text: `No session mentioned “${query}”.` }),
      res.skippedNonInteractive
        ? el('div', { style: 'margin-top:6px;opacity:.75', text: `${res.skippedNonInteractive} non-interactive session(s) were skipped — tick the box above to include them.` })
        : null));
    return;
  }

  for (const r of res.results) {
    const card = el('div', { class: 'mx-result' });
    const head = el('div', { class: 'mx-rhead' },
      el('span', { class: 'st done' }),
      el('span', { class: 'mxname', text: `${r.node || 'unknown'} — ${r.user} → ${r.login}` }),
      el('span', { class: 'mxmeta', text: `${r.matchCount} match${r.matchCount === 1 ? '' : 'es'} · ${fmtDate(r.startedAt)} · ${fmtDuration(r.durationMs)}` }));
    head.addEventListener('click', () => card.classList.toggle('collapsed'));

    const body = el('div', { class: 'mx-rbody' });
    for (const h of r.hits.slice(0, 12)) {
      for (const b of h.before) body.append(el('div', { style: 'opacity:.45', text: `  ${b}` }));
      body.append(el('div', {}, ...highlight(h.text, query, res)));
      for (const a of h.after) body.append(el('div', { style: 'opacity:.45', text: `  ${a}` }));
      body.append(el('div', { style: 'height:6px' }));
    }
    if (r.matchCount > 12) {
      body.append(el('div', { style: 'opacity:.6', text: `… ${r.matchCount - 12} more matches in this session` }));
    }

    const actions = el('div', { style: 'display:flex;gap:6px;padding:7px 10px;background:var(--panel-2)' },
      el('button', { class: 'ghost-btn sm', text: 'Play', onClick: () => playRecording(r) }),
      el('button', { class: 'ghost-btn sm', text: 'Web UI', onClick: () => openInWeb(r) }),
      el('button', {
        class: 'ghost-btn sm', text: 'Save transcript…',
        onClick: async () => {
          try {
            const out = await window.api.recordings.saveTranscript(r.sid, {
              proxy: r.proxy || recordingsProxy, home: r.home || recordingsHome, cluster: r.cluster,
              node: r.node, startedAt: r.startedAt,
            });
            if (out) { status(`Saved ${out.path}`); toast('Transcript saved', 'success'); }
          } catch (e) { toast(e.message, 'error'); }
        },
      }),
      el('span', { class: 'pmeta', style: 'margin-left:auto', text: r.sid.slice(0, 8) }));

    card.append(head, body, actions);
    node.append(card);
  }
}

/** Mark the matched term inside a line so the eye lands on it. */
function highlight(line, query, res) {
  const out = [];
  let re;
  try {
    re = new RegExp(res?.useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch { return [el('span', { text: line })]; }

  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push(el('span', { text: line.slice(last, m.index) }));
    out.push(el('span', { style: 'background:var(--amber);color:#000;border-radius:2px', text: m[0] }));
    last = m.index + m[0].length;
  }
  out.push(el('span', { text: line.slice(last) }));
  return out;
}
