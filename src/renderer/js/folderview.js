import { state } from './state.js';
import { el, clear } from './util.js';
import { modal, status, toast, textInput, confirm, contextMenu } from './ui.js';
import { labelEntries, compileQuery } from './tags.js';
import {
  foldersIn, folderById, folderPath, hostsInFolder, hostsInTree,
  isFiled, hostKey, unfileHost, deleteFolder,
  reparentFolder, isManualMember, openFolderDialog,
  exportFoldersDialog, importFoldersDialog, folderIcon, folderColor, fileHostsInto,
} from './folders.js';
import { hostsInGroup, folderGroups, openHostMenu, hostIcon } from './sidebar.js';
import { isStale, staleLabel, ageLabel, heartbeatAge, heartbeatLine } from './heartbeat.js';
import { isWatched, showWatchMark } from './watch.js';

/**
 * The folder browser: the whole arrangement at once, with room to work in.
 *
 * The sidebar is a column three hundred pixels wide, which is right for
 * "open that host" and wrong for everything else — building the folders in
 * the first place, moving fifteen machines at a time, or reading a rule
 * against the nodes it currently claims. This is the same folders in the
 * shape a file manager uses, because that is the shape people already know:
 * a tree on the left, what is in the selected thing on the right, drag
 * between them, double-click to go in.
 *
 * It is deliberately not a second inventory. Everything it shows is the
 * sidebar's own data, and every change it makes is the same settings write
 * the sidebar watches — so the two are never out of step with each other.
 */

/** Where the view is pointed: a group, and a folder within it or `null`. */
let sel = { groupKey: null, folderId: null, unfiled: false };
/** Host keys picked out in the listing, for a drag or a bulk action. */
let picked = new Set();
let lastPickedKey = null;
let query = '';
let dragging = null;   // { keys: [...], groupKey } | { folderId }
const shut = new Set();

export async function openFolderBrowser({ groupKey = null, folderId = null } = {}) {
  const groups = folderGroups();
  if (!groups.length) return toast('No clusters or ssh hosts to organise yet', 'error');

  sel = {
    groupKey: groupKey || groups[0].key,
    folderId: folderId || null,
    unfiled: false,
  };
  picked = new Set();
  query = '';

  let alive = true;
  await modal({
    title: 'Folders',
    subtitle: 'Drag hosts in. Double-click to open one.',
    width: 'min(1100px, 96vw)',
    resize: 'folders',
    render: (body, { close }) => {
      body.classList.add('fv-body');
      const draw = () => { if (alive) render(body, groups, close); };
      render(body, groups, close);
      /*
       * Redrawn on every folder write — including the ones made from the
       * sidebar behind this dialog — because two views of the same thing
       * disagreeing is worse than a repaint nobody asked for.
       */
      const off = state.on('folders', draw);
      const offInv = state.on('inventory', draw);
      return () => { alive = false; off?.(); offInv?.(); };
    },
    buttons: [{ label: 'Close', value: null }],
  });
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function render(body, groups, close) {
  clear(body);
  const hosts = hostsInGroup(sel.groupKey);
  body.append(
    toolbar(groups, hosts, close),
    el('div', { class: 'fv-main' },
      el('div', { class: 'fv-tree' }, ...treeRows(groups, hosts)),
      el('div', { class: 'fv-list' }, ...listing(hosts, close))),
    footer(hosts));
}

function toolbar(groups, hosts, close) {
  const groupSel = el('select', { class: 'fv-group' },
    ...groups.map((g) => el('option', { value: g.key, text: g.label, selected: g.key === sel.groupKey || null })));
  groupSel.addEventListener('change', () => {
    sel = { groupKey: groupSel.value, folderId: null, unfiled: false };
    picked = new Set();
    state.emit('folders');
  });

  const find = textInput({ value: query, placeholder: 'Filter what is listed' });
  find.addEventListener('input', () => {
    query = find.value;
    // Only the listing changes, so only the listing is rebuilt — a full
    // redraw here would take the focus out of the box on every keystroke.
    const list = find.closest('.fv-body')?.querySelector('.fv-list');
    if (list) { clear(list); list.append(...listing(hostsInGroup(sel.groupKey), close)); }
  });

  const current = sel.folderId ? folderById(sel.folderId) : null;
  return el('div', { class: 'fv-bar' },
    groupSel,
    el('div', { class: 'fv-crumbs' }, ...crumbs(current)),
    el('span', { style: 'flex:1' }),
    find,
    el('button', {
      class: 'ghost-btn sm', text: current ? 'New inside' : 'New folder',
      title: current ? `A folder inside ${current.name}` : 'A folder at the top of this group',
      onClick: () => openFolderDialog({ group: sel.groupKey, parent: sel.folderId, hosts }),
    }),
    current ? el('button', {
      class: 'ghost-btn sm', text: 'Edit',
      onClick: () => openFolderDialog({ group: sel.groupKey, folder: current, hosts }),
    }) : null,
    el('button', {
      class: 'ghost-btn sm', text: 'Export…',
      title: 'Write this group’s folders out as a file',
      onClick: () => exportFoldersDialog(sel.groupKey),
    }),
    el('button', {
      class: 'ghost-btn sm', text: 'Import…',
      onClick: () => importFoldersDialog(folderGroups()),
    }),
    el('button', {
      class: 'ghost-btn sm', text: 'Open as a pane',
      title: 'The same hosts in a pane of the window, which stays open while you work',
      onClick: async () => {
        const m = await import('./hostspane.js');
        close(null);
        m.openHostsPane({ groupKey: sel.groupKey });
      },
    }));
}

function crumbs(folder) {
  const out = [el('button', {
    class: 'fv-crumb' + (!folder && !sel.unfiled ? ' on' : ''),
    text: 'All',
    onClick: () => go(null),
  })];
  if (sel.unfiled) out.push(el('span', { class: 'sepc', text: '›' }), el('button', { class: 'fv-crumb on', text: 'Unfiled' }));
  for (const f of folder ? folderPath(folder) : []) {
    out.push(el('span', { class: 'sepc', text: '›' }));
    out.push(el('button', {
      class: 'fv-crumb' + (f.id === folder.id ? ' on' : ''),
      text: f.name,
      onClick: () => go(f.id),
    }));
  }
  return out;
}

function go(folderId, { unfiled = false } = {}) {
  sel = { ...sel, folderId, unfiled };
  picked = new Set();
  state.emit('folders');
}

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

function treeRows(groups, hosts) {
  const rows = [];
  for (const g of groups) {
    const mine = g.key === sel.groupKey ? hosts : null;
    rows.push(el('div', {
      class: 'fv-tgroup' + (g.key === sel.groupKey ? ' on' : ''),
      text: g.label,
      title: g.key,
      onClick: () => {
        sel = { groupKey: g.key, folderId: null, unfiled: false };
        picked = new Set();
        state.emit('folders');
      },
    }));
    if (g.key !== sel.groupKey) continue;

    const walk = (parent, depth) => {
      for (const f of foldersIn(g.key, parent)) {
        const kids = foldersIn(g.key, f.id);
        rows.push(treeRow(f, depth, hostsInTree(f, mine).length, kids.length));
        if (!shut.has(f.id)) walk(f.id, depth + 1);
      }
    };
    walk(null, 0);

    const loose = mine.filter((h) => !isFiled(h, g.key));
    rows.push(el('div', {
      class: 'fv-trow unfiled' + (sel.unfiled ? ' on' : ''),
      style: '--depth:0',
      title: 'Everything in this group that is not in a folder',
      onClick: () => go(null, { unfiled: true }),
    },
      el('span', { class: 'chev' }),
      el('span', { class: 'fico', text: '—' }),
      el('span', { class: 'name', text: 'Unfiled' }),
      el('span', { class: 'count', text: String(loose.length) })));
  }
  return rows;
}

function treeRow(folder, depth, count, kids) {
  const isShut = shut.has(folder.id);
  const colour = folderColor(folder);
  const row = el('div', {
    class: 'fv-trow' + (sel.folderId === folder.id ? ' on' : '') + (colour ? ' coloured' : ''),
    style: `--depth:${depth}` + (colour ? `;--folder-color:${colour}` : ''),
    dataset: { folder: folder.id },
    title: folder.rule ? `Rule: ${folder.rule}` : 'Holds what you drag into it',
  },
    el('span', {
      class: 'chev' + (kids ? '' : ' none'),
      text: kids ? (isShut ? '▶' : '▼') : '',
      onClick: (e) => {
        e.stopPropagation();
        isShut ? shut.delete(folder.id) : shut.add(folder.id);
        state.emit('folders');
      },
    }),
    el('span', { class: 'fico', text: folderIcon(folder, !isShut) }),
    el('span', { class: 'name', text: folder.name }),
    folder.rule ? el('span', { class: 'tag rule', text: 'rule' }) : null,
    el('span', { class: 'count', text: String(count) }));

  row.addEventListener('click', () => go(folder.id));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); folderActions(e, folder); });
  wireDrop(row, folder);
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragging = { folderId: folder.id };
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', folder.name); } catch { /* a drag without a payload still moves the row */ }
  });
  row.addEventListener('dragend', () => { dragging = null; unmark(); });
  return row;
}

/* ------------------------------------------------------------------ */
/* The listing                                                         */
/* ------------------------------------------------------------------ */

function listing(hosts, close) {
  const folder = sel.folderId ? folderById(sel.folderId) : null;
  const q = query.trim() ? compileQuery(query) : null;
  const keep = (h) => !q || q.match(h);

  const subfolders = folder ? foldersIn(sel.groupKey, folder.id)
    : (sel.unfiled ? [] : foldersIn(sel.groupKey, null));
  const shown = folder ? hostsInFolder(folder, hosts).filter(keep)
    : sel.unfiled ? hosts.filter((h) => !isFiled(h, sel.groupKey)).filter(keep)
    : hosts.filter(keep);

  const rows = [];
  if (folder?.rule) {
    const c = compileQuery(folder.rule);
    rows.push(el('div', { class: 'fv-rule' },
      el('span', { class: 'k', text: 'Rule' }),
      el('code', { text: folder.rule }),
      c.error ? el('span', { class: 'warn', text: c.error }) : null,
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'ghost-btn sm', text: 'Edit rule',
        onClick: () => openFolderDialog({ group: sel.groupKey, folder, hosts }),
      })));
  }

  for (const f of subfolders) rows.push(tile(f, hosts));

  for (const h of shown) rows.push(hostRow(h, folder, close));

  if (!rows.length || (!shown.length && !subfolders.length)) {
    rows.push(el('div', { class: 'fv-empty' },
      el('div', { text: folder
        ? (query ? 'Nothing in this folder matches that.' : 'This folder is empty.')
        : (sel.unfiled ? 'Everything in this group is filed.' : 'Nothing here.') }),
      folder && !query ? el('div', {
        class: 'hint', style: 'margin-top:8px',
        text: 'Drag hosts onto it from Unfiled, or give it a rule so it fills itself.',
      }) : null));
  }
  return rows;
}

function tile(folder, hosts) {
  const count = hostsInTree(folder, hosts).length;
  const colour = folderColor(folder);
  const row = el('div', {
    class: 'fv-row folder' + (colour ? ' coloured' : ''),
    dataset: { folder: folder.id },
    style: colour ? `--folder-color:${colour}` : null,
    title: folder.rule ? `Rule: ${folder.rule}` : '',
  },
    el('span', { class: 'fico', text: folderIcon(folder) }),
    el('span', { class: 'fv-name', text: folder.name }),
    folder.rule ? el('span', { class: 'tag rule', text: 'rule' }) : null,
    el('span', { style: 'flex:1' }),
    el('span', { class: 'fv-meta', text: `${count} host${count === 1 ? '' : 's'}` }));
  row.addEventListener('dblclick', () => go(folder.id));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); folderActions(e, folder); });
  wireDrop(row, folder);
  return row;
}

function hostRow(host, folder, close) {
  const k = hostKey(host);
  const on = picked.has(k);
  const conn = [...state.connections.values()].find((c) => c.hostId === host.id && c.state === 'connected');
  const tags = labelEntries(host).slice(0, 4);
  const byRule = folder && !isManualMember(host, folder.id);

  const row = el('div', {
    class: 'fv-row' + (on ? ' picked' : '') + (conn ? ' live' : ''),
    dataset: { host: host.id, key: k },
    title: heartbeatLine(host) || '',
  },
    el('span', { class: 'st' + (conn ? ' connected' : '') }),
    showWatchMark() && isWatched(host)
      ? el('span', { class: 'hwatch', text: '\u{1F514}', title: 'Watched for disappearance' })
      : null,
    el('span', { class: 'fv-name', text: host.name || host.alias }),
    hostIcon(host) ? el('span', { class: 'hico', text: hostIcon(host) }) : null,
    byRule ? el('span', { class: 'tag rule', title: 'In here because the folder’s rule matches it', text: 'by rule' }) : null,
    isStale(host) ? el('span', { class: 'tag stale', text: '⚠ ' + staleLabel(host) })
      : (heartbeatAge(host) !== null ? el('span', { class: 'tag hb', text: '♥ ' + ageLabel(host) }) : null),
    el('span', { class: 'fv-tags' }, ...tags.map(([tk, tv]) => el('span', { class: 'chip sm' },
      el('span', { class: 'k', text: tk }), el('span', { class: 'v', text: tv || '—' })))),
    el('span', { style: 'flex:1' }),
    el('span', { class: 'fv-meta', text: host.addr || (host.tunnel ? 'tunnel' : (host.hostname || '')) }));

  row.addEventListener('click', (e) => pick(k, e));
  row.addEventListener('dblclick', async () => {
    // Through the host list's own open, so the account and the MFA route
    // are the same ones the sidebar would have used.
    const { openHostFromList } = await import('./sidebar.js');
    close(null);
    await openHostFromList(host);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!picked.has(k)) pick(k, {});
    openHostMenu(e, host, { folder, groupKey: sel.groupKey });
  });

  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    // Dragging something outside the selection means that is what you meant.
    if (!picked.has(k)) { picked = new Set([k]); markPicked(); }
    dragging = { keys: [...picked], groupKey: sel.groupKey, from: folder?.id || null };
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', host.name || host.alias); } catch { /* a drag without a payload still moves the row */ }
  });
  row.addEventListener('dragend', () => { dragging = null; unmark(); });
  return row;
}

/**
 * Click, ⌘-click, shift-click — the three a list like this has to answer to,
 * because filing fifteen machines one at a time is the thing this view exists
 * to avoid.
 */
function pick(k, e) {
  const rows = [...document.querySelectorAll('.fv-list .fv-row[data-key]')].map((n) => n.dataset.key);
  if (e.shiftKey && lastPickedKey) {
    const a = rows.indexOf(lastPickedKey);
    const b = rows.indexOf(k);
    if (a >= 0 && b >= 0) for (const key of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) picked.add(key);
  } else if (e.metaKey || e.ctrlKey) {
    picked.has(k) ? picked.delete(k) : picked.add(k);
  } else {
    picked = new Set([k]);
  }
  lastPickedKey = k;
  markPicked();
}

function markPicked() {
  for (const n of document.querySelectorAll('.fv-list .fv-row[data-key]')) {
    n.classList.toggle('picked', picked.has(n.dataset.key));
  }
  const foot = document.querySelector('.fv-foot .sel');
  if (foot) foot.textContent = picked.size ? `${picked.size} selected` : '';
}

function unmark() {
  for (const n of document.querySelectorAll('.drop-in')) n.classList.remove('drop-in');
}

/* ------------------------------------------------------------------ */
/* Dropping                                                            */
/* ------------------------------------------------------------------ */

function wireDrop(row, folder) {
  const ok = () => {
    if (!dragging) return false;
    if (dragging.folderId) {
      if (dragging.folderId === folder.id) return false;
      return !folderPath(folder).some((f) => f.id === dragging.folderId);
    }
    return dragging.groupKey === sel.groupKey && dragging.from !== folder.id;
  };
  row.addEventListener('dragover', (e) => {
    if (!ok()) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.add('drop-in');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-in'));
  row.addEventListener('drop', async (e) => {
    if (!ok()) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-in');
    const d = dragging;
    dragging = null;
    if (d.folderId) {
      const moving = folderById(d.folderId);
      if (moving && await reparentFolder(moving.id, folder.id)) status(`${moving.name} is now inside ${folder.name}`);
      return;
    }
    await dropKeys(d.keys, folder);
  });
}

/**
 * Several hosts onto one folder.
 *
 * The both-or-move question is asked once for the whole drag rather than per
 * host: a drop of fifteen machines is one decision, and fifteen identical
 * dialogs is how you teach somebody to click the first button without
 * reading it.
 */
async function dropKeys(keys, folder) {
  const hosts = hostsInGroup(sel.groupKey).filter((h) => keys.includes(hostKey(h)));
  const r = await fileHostsInto(hosts, folder, sel.groupKey);
  if (!r) return;
  status(`${r.count} host${r.count === 1 ? '' : 's'} ${r.mode === 'move' ? 'moved to' : 'added to'} ${folder.name}`);
}

/* ------------------------------------------------------------------ */
/* Bits                                                                */
/* ------------------------------------------------------------------ */

function folderActions(e, folder) {
  const hosts = hostsInGroup(sel.groupKey);
  contextMenu(e.clientX, e.clientY, [
    { label: folder.name, heading: true },
    { label: 'Open it', onClick: () => go(folder.id) },
    { label: folder.rule ? 'Edit folder and its rule…' : 'Edit folder…', onClick: () => openFolderDialog({ group: sel.groupKey, folder, hosts }) },
    { label: 'New folder inside…', onClick: () => openFolderDialog({ group: sel.groupKey, parent: folder.id, hosts }) },
    { sep: true },
    { label: 'Move to the top level', onClick: () => reparentFolder(folder.id, null) },
    { sep: true },
    {
      label: 'Delete this folder…',
      onClick: async () => {
        const ok = await confirm({
          title: `Delete “${folder.name}”?`,
          message: 'The folder and anything inside it go.',
          detail: 'The hosts stay where they were — they live in the cluster, not in here.',
          confirmLabel: 'Delete',
        });
        if (ok) {
          await deleteFolder(folder.id);
          if (sel.folderId === folder.id) go(folder.parent || null);
        }
      },
    },
  ]);
}

function footer(hosts) {
  const folder = sel.folderId ? folderById(sel.folderId) : null;
  const total = hosts.length;
  const filed = hosts.filter((h) => isFiled(h, sel.groupKey)).length;
  const bar = el('div', { class: 'fv-foot' },
    el('span', { class: 'sel' }),
    el('span', { style: 'flex:1' }),
    folder ? el('button', {
      class: 'ghost-btn sm', text: 'Take the selected out of this folder',
      onClick: async () => {
        const list = hosts.filter((h) => picked.has(hostKey(h)));
        if (!list.length) return toast('Nothing selected', 'error');
        for (const h of list) await unfileHost(h, folder.id);
        picked = new Set();
        return status(`${list.length} taken out of ${folder.name}`);
      },
    }) : null,
    el('span', { class: 'fv-meta', text: `${filed} of ${total} filed` }));
  return bar;
}
