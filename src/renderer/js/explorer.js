import { state } from './state.js';
import { el, clear, fmtBytes, fmtDate, posix, sortEntries, fileIcon, uid } from './util.js';
import { toast, status, contextMenu, prompt, confirm, modal, field, textInput, checkbox, select } from './ui.js';
import { City3D } from './city3d.js';

/**
 * A self-contained file explorer.
 *
 * One instance is attached to each terminal pane, so every open session shows
 * its own filesystem beside (or above) its terminal. An instance can also point
 * at the local machine or at any other open session, which is what makes
 * dragging files directly between two servers possible.
 */

/** A kube file's bytes travel as base64 over IPC — UTF-8 safe, unlike plain btoa/atob. */
function b64FromText(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function textFromB64(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Every live explorer, for the background refresh tick and drag routing. */
export const explorers = new Map();

/**
 * The same check `sidebar.js`'s own `isMfaHost` makes, read directly rather
 * than imported: `sidebar.js` imports from `sessions.js`, which imports
 * `Explorer` from here, so a static import the other way round would be a
 * cycle, and this is called from a synchronous render path where a dynamic
 * one is awkward. One array lookup is cheap enough to just repeat.
 */
function isMfaHost(id) {
  return (state.settings.mfaHosts || []).includes(id);
}

/**
 * A connect failure shown in the file list, with the one thing worth saying
 * about it said in words: "too many authentication failures" is exactly what
 * a node asking for per-session MFA looks like over this channel too, same
 * as it does for the terminal — the raw OpenSSH text alone does not say so.
 */
function explainConnectError(message) {
  const msg = String(message || '');
  return / \[mfa\]$/.test(msg) ? msg.replace(/ \[mfa\]$/, '') + ' (MFA may be required)' : msg;
}


/*
 * Which pane a drag started in, for the pointer to show move rather than
 * copy. `dragover` may not read the drag payload — the browser withholds it
 * until the drop — so it is written down here at dragstart.
 */
let dragFrom = null;

const isDir = (e) => e.type === 'directory' || e.targetType === 'directory';

/**
 * Which of Desktop/Documents/Downloads each connection actually has, so the
 * home directory is only listed once per session for this.
 */
const homeFolderCache = new Map();

/** Re-read the starred lists in every open explorer. */
export function refreshFavorites() {
  homeFolderCache.clear();
  for (const ex of explorers.values()) {
    ex._autoLocalKey = null;
    ex._syncFavButton();
  }
}

/** Show or hide the 3D button everywhere, closing any city the setting turned off. */
export function apply3dSetting() {
  const off = state.settings.show3dView === false;
  for (const ex of explorers.values()) {
    ex.cityBtn?.classList.toggle('hidden', off);
    if (off && ex.city) ex.toggle3d(false);
  }
}

/** Quote a path for a remote shell — paths contain spaces and worse. */
const shq = (p) => "'" + String(p).replace(/'/g, `'\\''`) + "'";

/* ------------------------------------------------------------------ */
/* Synchronise                                                         */
/* ------------------------------------------------------------------ */

const SYNC_OPS = {
  upload: { glyph: '↑', label: 'upload' },
  download: { glyph: '↓', label: 'download' },
  deleteRemote: { glyph: '✕', label: 'delete on server' },
  deleteLocal: { glyph: '✕', label: 'delete here' },
  rmdirRemote: { glyph: '⊘', label: 'remove folder on server, with anything in it' },
  rmdirLocal: { glyph: '⊘', label: 'remove folder here, with anything in it' },
  same: { glyph: '=', label: 'identical' },
  skip: { glyph: '·', label: 'left alone' },
};

/** The actions that do something, as opposed to the ones that report. */
const SYNC_DOES = ['upload', 'download', 'deleteRemote', 'deleteLocal', 'rmdirRemote', 'rmdirLocal'];

/**
 * Plan a sync, show every line of it, and run what survives review.
 *
 * The list is the feature. A sync tool that reports "47 files transferred"
 * after the fact is a tool you check by hand afterwards; one that says "these
 * 47, and this one would overwrite a newer copy" is one you can trust with a
 * direction and a delete.
 */
export async function openSyncDialog({ connId, localDir, remoteDir, onDone } = {}) {
  let planned = null;
  const excluded = new Set();      // rel paths the user unticked

  const dirSel = select([
    { value: 'up', label: 'This machine → server' },
    { value: 'down', label: 'Server → this machine' },
    { value: 'both', label: 'Both ways (newer wins)' },
  ], 'up');
  const delIn = checkbox('Delete what the source does not have', false);
  /*
   * What counts as "the same file". Size and time is the only rule that never
   * calls two different files identical, so it is the default; the other two
   * are for trees where the timestamps did not survive the journey.
   */
  const cmpSel = select([
    { value: 'both', label: 'Size and time' },
    { value: 'size', label: 'Size only' },
    { value: 'time', label: 'Time only' },
  ], 'both');
  const rows = el('div', { class: 'picker-list', style: 'max-height:min(46vh,420px)' });
  const summary = el('div', { class: 'hint', style: 'margin-top:9px' });
  const warn = el('div', { class: 'perm-note warn', style: 'display:none;margin-top:8px' });

  const syncDelState = () => {
    // Deleting in a two-way sync has no meaning: neither side is the source.
    const both = dirSel.value === 'both';
    delIn.input.disabled = both;
    if (both) delIn.input.checked = false;
    delIn.style.opacity = both ? '.5' : '';
  };

  const draw = () => {
    clear(rows);
    if (!planned) {
      rows.append(el('div', { class: 'sb-empty', text: 'Comparing…' }));
      summary.textContent = '';
      return;
    }
    const s = planned.summary;
    const doing = planned.actions.filter((a) => SYNC_DOES.includes(a.op));

    if (!doing.length) {
      rows.append(el('div', { class: 'sb-empty' },
        el('div', { text: 'Already in sync.' }),
        el('div', { style: 'margin-top:6px;opacity:.75', text: `${s.same} identical file(s) on both sides.` })));
    }

    for (const a of doing) {
      const meta = SYNC_OPS[a.op];
      const ck = el('input', { type: 'checkbox' });
      ck.checked = !excluded.has(a.rel + a.op);
      ck.addEventListener('change', () => {
        if (ck.checked) { excluded.delete(a.rel + a.op); draw(); return; }
        excluded.add(a.rel + a.op);
        /*
         * Removing a folder is not "remove it if it is empty".
         *
         * A Teleport node's SFTP service implements the protocol's RMDIR
         * recursively, so a folder removal takes whatever is still inside it
         * — including a file the user has just chosen to keep. Rather than
         * relying on the server to refuse, keeping anything inside a folder
         * keeps the folder: the deletion of that folder is unticked too, and
         * seen to be unticked.
         */
        if (a.op.startsWith('delete')) {
          for (const other of planned.actions) {
            if (!other.op.startsWith('rmdir')) continue;
            if (a.rel === other.rel || a.rel.startsWith(other.rel + '/')) {
              excluded.add(other.rel + other.op);
            }
          }
        }
        draw();
      });
      rows.append(el('div', { class: 'sync-row' + (a.overwritesNewer ? ' risky' : '') },
        ck,
        el('span', { class: 'sync-op', title: meta.label, text: meta.glyph }),
        el('span', { class: 'sync-name', title: a.rel, text: a.rel }),
        el('span', { class: 'sync-why', text: a.why + (a.overwritesNewer ? ' — overwrites a newer copy' : '') }),
        el('span', { class: 'fsize', text: a.size ? fmtBytes(a.size) : '' })));
    }

    const notes = [];
    if (s.localMissing) notes.push(`${localDir} does not exist on this machine.`);
    if (s.remoteMissing) notes.push(`${remoteDir} does not exist on the server.`);
    if (s.truncated) notes.push('One of the trees was too large to walk fully — this plan is partial.');
    if (s.links) notes.push(`${s.links} symlink(s) ignored: copying one would replace the link with its target.`);
    if (s.overwritesNewer) notes.push(`${s.overwritesNewer} file(s) would overwrite a newer copy — ticked rows in amber.`);
    // The commonest surprise: a file deleted on the source side is left alone
    // unless deleting is asked for, and nothing on screen said so.
    if (!delIn.input.checked && s.wouldDelete) {
      notes.push(`${s.wouldDelete} file(s) exist only on the other side and are being left alone. `
        + 'Tick "Delete what the source does not have" to remove them.');
    }
    warn.style.display = notes.length ? 'block' : 'none';
    warn.textContent = notes.join('\n');
    countUp();
  };

  const kept = () => (planned?.actions || []).filter((a) => SYNC_DOES.includes(a.op)
    && !excluded.has(a.rel + a.op));

  const countUp = () => {
    if (!planned) return;
    const k = kept();
    const bytes = k.filter((a) => a.op === 'upload' || a.op === 'download').reduce((x, y) => x + (y.size || 0), 0);
    const dels = k.filter((a) => a.op.startsWith('delete') || a.op.startsWith('rmdir')).length;
    summary.textContent = k.length
      ? `${k.length} action(s) · ${fmtBytes(bytes)} to move`
        + (dels ? ` · ${dels} deletion(s)` : '')
        + ` · ${planned.summary.same} already identical`
      : `Nothing selected · ${planned.summary.same} identical file(s)`;
  };

  const replan = async () => {
    planned = null;
    excluded.clear();
    draw();
    try {
      planned = await window.api.sync.plan(connId, {
        localDir, remoteDir, direction: dirSel.value, del: delIn.input.checked,
        compare: cmpSel.value,
      });
    } catch (e) {
      planned = null;
      clear(rows);
      rows.append(el('div', { class: 'sb-empty', style: 'color:var(--red)', text: e.message }));
      return;
    }
    draw();
  };

  dirSel.addEventListener('change', () => { syncDelState(); replan(); });
  delIn.input.addEventListener('change', replan);
  cmpSel.addEventListener('change', replan);
  syncDelState();

  const res = await modal({
    title: 'Synchronize',
    subtitle: `${localDir}  ↔  ${remoteDir}`,
    width: 'min(860px, 96vw)',
    render: (body) => {
      body.append(
        el('div', { class: 'field-row' },
          field('Direction', dirSel),
          field('Files match on', cmpSel),
          el('div', { style: 'flex:1;align-self:end;padding-bottom:12px' }, delIn)),
        rows, summary, warn);
      replan();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Synchronize', class: 'primary-btn',
        onClick: async ({ close }) => {
          const k = kept();
          if (!k.length) return toast('Nothing selected', 'error');
          const dels = k.filter((a) => a.op.startsWith('delete') || a.op.startsWith('rmdir'));
          if (dels.length && !await confirm({
            title: `Delete ${dels.length} file(s)?`,
            message: 'This sync removes files as well as copying them.',
            detail: dels.slice(0, 15).map((a) => (a.op.endsWith('Remote') ? 'server: ' : 'here: ')
              + a.rel + (a.dir ? '  (folder, and anything still in it)' : '')).join('\n')
              + (dels.length > 15 ? `\n…and ${dels.length - 15} more` : ''),
            confirmLabel: 'Delete them',
            danger: true,
          })) return;
          close(k);
        },
      },
    ],
  });
  if (!res) return null;

  try {
    const r = await window.api.sync.apply(connId, planned, res);
    const bits = [
      r.uploads ? `${r.uploads} up` : '',
      r.downloads ? `${r.downloads} down` : '',
      r.removed ? `${r.removed} removed` : '',
    ].filter(Boolean).join(' · ');
    status(`Sync started: ${bits || 'nothing to move'}`, 9000);
    if (r.failures?.length) toast(r.failures.slice(0, 3).join('\n'), 'error', 9000);
    // The queue is where the work now is, so that is where to look.
    showTransfers();
    onDone?.();
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

/**
 * `owner:group` for an entry, preferring names over numbers.
 *
 * The names come free — the server's own `ls -l` line for a remote listing,
 * `/etc/passwd` for a local one — but they are not always there: a uid from a
 * directory service is in no file this can read. The number is then shown as
 * a number rather than dressed up as a name, since `1001` is something you can
 * look up and a wrong name is not. Repeating one value for both, as `root:root`
 * does, is collapsed to one.
 */
/**
 * Permissions as both forms, plus the bits a mode string hides in plain sight.
 *
 * `rwsr-xr-x` differs from `rwxr-xr-x` by one letter and by the whole question
 * of whose privileges a program runs with, so setuid, setgid and the sticky bit
 * are named rather than left for the reader to spot. The octal is four digits
 * when any of them is set, which is the form you would type into chmod.
 */
function permText(d) {
  const mode = Number(d.mode) || 0;
  const special = [
    mode & 0o4000 ? 'setuid' : null,
    mode & 0o2000 ? 'setgid' : null,
    mode & 0o1000 ? 'sticky' : null,
  ].filter(Boolean);
  const octal = (mode & 0o7000
    ? (mode & 0o7777).toString(8).padStart(4, '0')
    : (mode & 0o777).toString(8).padStart(3, '0'));
  return `${d.modeString || ''}  (${octal})`.trim()
    + (special.length ? '  · ' + special.join(', ') : '');
}

/**
 * The permission bits, read back in words.
 *
 * Two things make `rwxr-xr-x` opaque, and both are answered here. The notation
 * is positional — nine letters in three silent groups — so the groups are
 * separated and named. And the letters mean different things on a directory
 * than on a file: `x` on a file is "run it", on a directory it is "go through
 * it", and `r` without `x` on a directory is a listing you cannot act on. So
 * the wording is chosen for what this entry actually is, rather than reciting
 * the same three sentences for everything.
 */
function explainPermissions({ mode, modeString, owner, group, folder }) {
  const m = Number(mode) || 0;
  const who = [
    { label: 'Owner', of: owner ? `${owner}` : 'the owning account', shift: 6 },
    { label: 'Group', of: group ? `members of ${group}` : 'the owning group', shift: 3 },
    { label: 'Others', of: 'everyone else with an account on the machine', shift: 0 },
  ];

  const verbs = folder
    ? { r: 'list what is in it', w: 'create, rename and delete things in it', x: 'enter it and reach what is inside' }
    : { r: 'read it', w: 'change or overwrite it', x: 'run it as a program' };

  const out = el('div');

  // The notation first: which letters belong to whom.
  const bits = (modeString || '').slice(1, 10).padEnd(9, '-');
  const lanes = el('div', { class: 'perm-lanes' });
  ['Owner', 'Group', 'Others'].forEach((label, i) => {
    lanes.append(el('div', { class: 'perm-lane' },
      el('span', { class: 'perm-bits', text: bits.slice(i * 3, i * 3 + 3) || '---' }),
      el('span', { class: 'perm-who', text: label })));
  });
  out.append(el('div', { class: 'perm-note' },
    'Nine letters in three groups of three — owner, then group, then everyone else. '
    + 'A letter means the permission is granted, a dash means it is not.'));
  out.append(lanes);

  // Then this entry, in sentences.
  const list = el('ul', { class: 'perm-list' });
  for (const w of who) {
    const can = [];
    if (m & (4 << w.shift)) can.push(verbs.r);
    if (m & (2 << w.shift)) can.push(verbs.w);
    if (m & (1 << w.shift)) can.push(verbs.x);
    const sentence = can.length
      ? `can ${can.length > 1 ? can.slice(0, -1).join(', ') + ' and ' + can.at(-1) : can[0]}`
      : (folder ? 'cannot see inside it or enter it' : 'cannot read it at all');
    list.append(el('li', {},
      el('b', { text: w.label + ': ' }),
      `${w.of} ${sentence}.`));
  }
  out.append(list);

  // Anything that needs saying beyond the nine letters.
  const notes = [];
  if (folder && (m & 0o111) === 0) {
    notes.push('Nobody has the execute bit, so this directory cannot be entered by anyone — '
      + 'a path through it fails even where the listing is readable.');
  }
  if (folder && (m & 0o1000)) {
    notes.push('The sticky bit is set: anyone may create things here, but only the owner of a '
      + 'file (or of the directory) may delete or rename it. This is what makes /tmp safe to share.');
  }
  if (!folder && (m & 0o4000)) {
    notes.push('Setuid is set: this program runs with the privileges of its owner'
      + (owner ? ` (${owner})` : '') + ', not of whoever starts it.');
  }
  if (!folder && (m & 0o2000)) {
    notes.push('Setgid is set: this program runs with the privileges of its group'
      + (group ? ` (${group})` : '') + ', not of whoever starts it.');
  }
  if (folder && (m & 0o2000)) {
    notes.push('Setgid is set on the directory: new files inside inherit its group'
      + (group ? ` (${group})` : '') + ' rather than the creator’s.');
  }
  if (!folder && (m & 0o111) && (m & 0o444) === 0) {
    notes.push('It is executable but not readable — a script needs to be read to be interpreted, '
      + 'so this only works for a compiled binary.');
  }
  if ((m & 0o002)) {
    notes.push('The last group includes write: anyone with an account can change '
      + (folder ? 'what is in this directory' : 'this file') + '.');
  }
  for (const n of notes) out.append(el('div', { class: 'perm-note warn', text: n }));

  out.append(el('div', { class: 'perm-note' },
    'The octal form adds the same three permissions up per group: read is 4, write is 2, '
    + 'execute is 1. So 6 is read and write, 7 is all three, 5 is read and execute — '
    + `and ${(m & 0o777).toString(8).padStart(3, '0')} is what this one has.`));

  return out;
}

/**
 * A path short enough for a narrow column, shortened at the *front*.
 *
 * The end of a path is the part that identifies it, so the home directory
 * becomes `~` and anything still too long loses its head rather than its tail.
 * Done here rather than in CSS: the `direction: rtl` trick that elides from
 * the left also drags the leading slash round to the other end of the string.
 */
function shortPath(p, max = 34) {
  let out = String(p || '');
  const home = state.appInfo?.home;
  if (home && out.startsWith(home)) out = '~' + out.slice(home.length);
  if (out.length <= max) return out;
  return '\u2026' + out.slice(-(max - 1));
}

function ownerText(entry) {
  const owner = entry.owner || (entry.uid === undefined || entry.uid === null ? '' : String(entry.uid));
  const group = entry.group || (entry.gid === undefined || entry.gid === null ? '' : String(entry.gid));
  if (!owner && !group) return '';
  if (!group || owner === group) return owner;
  return `${owner}:${group}`;
}

/** `key=value` lines from a shell probe, ignoring anything malformed. */
function parseKv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Move files with a bucket on one side.
 *
 * Only local↔S3 is a single hop. A server and a bucket have no way to talk to
 * each other, so those go through this machine — the same relay the app
 * already uses between two servers that cannot copy directly, and it says so
 * rather than looking like a direct transfer.
 */
async function s3Transfer(src, dest, entries, destDir) {
  const files = entries.filter((e) => !isDir(e));
  if (!files.length) {
    return toast('Folders cannot be moved in one step — open it and take the files.', 'error');
  }

  // Local → bucket
  if (src.source.kind === 'local' && dest.source.kind === 's3') {
    const cls = await pickStorageClass(dest.s3Target);
    if (!cls) return;
    return runS3(dest, `Uploading ${files.length} file(s)`, async () => {
      const r = await window.api.s3.upload(dest.s3Id, files.map((f) => f.path), destDir || '', { storageClass: cls });
      return `Uploaded ${r.uploaded.length} file(s) as ${r.storageClass}`;
    });
  }

  // Bucket → local
  if (src.source.kind === 's3' && dest.source.kind === 'local') {
    return runS3(dest, `Downloading ${files.length} object(s)`, async () => {
      const r = await window.api.s3.download(src.s3Id, files.map((f) => f.path), destDir);
      return `Downloaded ${r.downloaded.length} object(s)`;
    });
  }

  // Bucket → bucket
  if (src.source.kind === 's3' && dest.source.kind === 's3') {
    if (src.s3Id === dest.s3Id) {
      return toast('Both panes are the same bucket', 'info');
    }
    const cls = await pickStorageClass(dest.s3Target);
    if (!cls) return;
    return runS3(dest, `Copying ${files.length} object(s) via this machine`, async () => {
      const r = await window.api.s3.bucketToBucket(
        src.s3Id, files.map((f) => f.path), dest.s3Id, destDir || '', { storageClass: cls });
      return `Copied ${r.uploaded.length} object(s) as ${r.storageClass}`;
    });
  }

  // Server ↔ bucket, relayed through here.
  const viaHere = 'Routed through this machine — a server and a bucket cannot talk to each other directly.';
  if (src.source.kind === 'remote' && dest.source.kind === 's3') {
    const cls = await pickStorageClass(dest.s3Target);
    if (!cls) return;
    status(viaHere, 6000);
    return runS3(dest, `Uploading ${files.length} file(s) from the server`, async () => {
      const r = await window.api.s3.fromServer(
        src.connId,
        files.map((f) => ({ path: f.path, name: f.name, type: f.type })),
        dest.s3Id, destDir || '', { storageClass: cls });
      return `Uploaded ${r.uploaded.length} file(s) as ${r.storageClass}`;
    });
  }
  if (src.source.kind === 's3' && dest.source.kind === 'remote') {
    status(viaHere, 6000);
    return runS3(dest, `Sending ${files.length} object(s) to the server`, async () => {
      const r = await window.api.s3.toServer(src.s3Id, files.map((f) => f.path), dest.connId, destDir);
      return `Sent ${r.sent.length} object(s)`;
    });
  }
  return toast('That combination is not supported', 'error');
}

async function runS3(dest, busy, work) {
  status(busy + '…', 0);
  try {
    const msg = await work();
    status('');
    toast(msg, 'success');
    await dest.refresh();
  } catch (e) {
    status('');
    toast(e.message, 'error');
  }
}

/**
 * Which S3 storage class to write. Defaults to whatever the bucket was
 * registered with, so the common case is one Return.
 */
async function pickStorageClass(target, current) {
  let classes = [];
  try { classes = await window.api.s3.storageClasses(); } catch { /* no classes: the field offers the default only */ }
  if (!classes.length) return current || target?.defaultStorageClass || 'STANDARD';

  const initial = current || target?.defaultStorageClass || 'STANDARD';
  const sel = el('select', { class: 'pane-source', style: 'width:100%;padding:6px 8px' });
  for (const c of classes) {
    const o = el('option', { value: c.value, text: c.label });
    if (c.value === initial) o.selected = true;
    sel.append(o);
  }
  const hint = el('div', { class: 'hint' });
  const syncHint = () => {
    hint.textContent = (classes.find((c) => c.value === sel.value) || {}).hint || '';
  };
  sel.addEventListener('change', syncHint);
  syncHint();

  return modal({
    title: current ? 'Change storage class' : 'Storage class',
    subtitle: target?.name || '',
    render: (body) => { body.append(field('Store as', sel), hint); },
    buttons: [
      { label: 'Cancel', value: null },
      { label: current ? 'Change' : 'Upload', class: 'primary-btn', onClick: ({ close }) => close(sel.value) },
    ],
  });
}

function parentLocal(p) {
  if (!p) return p;
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** Disk space per `sourceKey|folder`, `{ at, disk }` — see `_loadDisk`. */
const diskCache = new Map();

/**
 * "38.9 GB free of 48.3 GB", first in the footer, coloured by how much is
 * left: ordinary above 20% free, amber with a warning sign below it, red
 * with a stop sign below 10% — the point at which a log rotation or a
 * deploy that writes a few gigabytes is a real risk, not a theoretical one.
 */
function diskBadge({ free, total }) {
  const pct = total ? free / total : 1;
  const level = pct < 0.10 ? 'danger' : pct < 0.20 ? 'warn' : '';
  const icon = level === 'danger' ? '⛔ ' : level === 'warn' ? '⚠ ' : '';
  return el('span', {
    class: 'disk' + (level ? ' ' + level : ''),
    title: `${Math.round(pct * 100)}% free on this volume`,
    text: `${icon}${fmtBytes(free)} free of ${fmtBytes(total)} · `,
  });
}

export class Explorer {
  /**
   * @param source {kind:'remote'|'local', connId?} — 'remote' with no connId
   *        means "follow whichever session this pane belongs to".
   */
  constructor({ source, paneId = null, onChange = null } = {}) {
    this.id = uid('exp');
    this.source = source || { kind: 'local', connId: null };
    this.paneId = paneId;
    this.onChange = onChange;
    this.sort = { key: 'name', dir: 1 };
    this.destroyed = false;

    /*
     * Name filter for this explorer. Per explorer rather than per source or
     * global: it is about what you are looking for right now, so two panes can
     * hunt for different things, and it is visible in its own box the whole
     * time it is in force — a filter you cannot see is a directory that looks
     * wrong for no reason.
     */
    this.filter = '';

    /**
     * The shell directory the follow loop last acted on, or null for "not yet
     * read". It follows the terminal *changing* directory rather than the
     * terminal's position, which is what lets a folder opened here stay open.
     * See followTerminals in files.js.
     */
    this.followedCwd = null;

    /**
     * Set while the background tick is skipping this explorer for being off
     * screen — hidden beside its terminal, or in a tab you are not on. It is
     * the signal to re-list once it is visible again. See files.js.
     */
    this.pollPaused = false;

    /**
     * A comparison in force: a map of name → verdict against another list,
     * and which list that was. Cleared by the button, by navigating, or by
     * comparing again.
     */
    this.compare = null;

    // Per-source view state, so switching back to a source keeps its place.
    this.views = new Map();

    this._build();
    explorers.set(this.id, this);
  }

  /* ---------------- view state ---------------- */

  get sourceKey() {
    if (this.source.kind === 's3') return 's3:' + this.source.targetId;
    // Keyed by pane, not shared like a real connection id — two kube exec
    // panes have no connId in common to tell their view state apart by.
    if (this.source.kind === 'kube') return 'kube:' + this.paneId;
    return this.source.kind === 'local' ? 'local' : 'conn:' + this.connId;
  }

  /** The registered bucket this explorer reads, when it is pointed at one. */
  get s3Id() { return this.source.kind === 's3' ? this.source.targetId : null; }

  get s3Target() {
    return this.s3Id ? (state.s3Targets || []).find((t) => t.id === this.s3Id) || null : null;
  }

  /** The connection this explorer reads, resolving "follow the pane". */
  get connId() {
    if (this.source.kind !== 'remote') return null;
    if (this.source.connId) return this.source.connId;
    const pane = this.paneId ? state.getPane(this.paneId) : null;
    return pane?.connId || null;
  }

  get view() {
    const key = this.sourceKey;
    if (!this.views.has(key)) {
      this.views.set(key, {
        path: null, entries: [], selection: new Set(),
        history: [], hIndex: -1, expanded: new Set(), children: new Map(),
        loadingPaths: new Set(), error: null, loading: false,
      });
    }
    return this.views.get(key);
  }

  /* ---------------- DOM ---------------- */

  _build() {
    this.sourceSel = el('select', { class: 'pane-source', title: 'What this explorer shows' });
    this.sourceSel.addEventListener('change', () => this._onSourcePicked(this.sourceSel.value));

    const btn = (label, title, fn, opt) =>
      el('button', { class: 'icon-btn sm', text: label, title, onClick: fn, dataset: opt ? { opt } : undefined });

    this.filterBtn = btn('⌕', 'Filter by name', () => this.toggleFilter());
    this.hiddenBtn = btn('•', 'Show hidden files', () => {
      state.showHidden = !state.showHidden;
      window.api.settings.set({ showHiddenFiles: state.showHidden }).catch(() => {});
      for (const e of explorers.values()) e.render();
    });
    /*
     * Permissions and owner as columns, the way a file manager on a server
     * shows them — the two facts you are usually after when a file will not
     * open or a script will not run, and the two that no amount of looking at
     * a name will tell you. A view setting, not a per-pane one: it answers
     * "how do I read a file list", which does not change between panes.
     */
    this.detailsBtn = btn('≣', 'Show permissions and owner', () => {
      state.showFileDetails = !state.showFileDetails;
      window.api.settings.set({ showFileDetails: state.showFileDetails }).catch(() => {});
      for (const e of explorers.values()) { e._syncToggles(); e.render(); }
    }, 'extra');
    this.followBtn = btn('⇲', 'Follow the terminal’s folder', () => {
      state.followTerminal = !state.followTerminal;
      window.api.settings.set({ followTerminalFolder: state.followTerminal }).catch(() => {});
      // Switching it back on means "go to where the shell is", so forget what
      // was last followed and let the next tick snap to the terminal.
      if (state.followTerminal) for (const e of explorers.values()) e.followedCwd = null;
      for (const e of explorers.values()) e._syncToggles();
    }, 'extra');

    // One click to put the local filesystem below this one, so both are on
    // screen together — the arrangement an upload or download needs.
    this.localBtn = btn('\u{1F4BB}', 'Show local files below (drag to upload/download)', () => {
      this.onChange?.('toggle-local');
    });

    // Sorting was internal-only; this exposes it, and remembers the choice per
    // explorer so two panes can be ordered differently.
    this.sortBtn = btn('\u21C5', 'Sort', (e) => this._openSortMenu(e), 'extra');

    /*
     * Compare and sync live on the toolbar as well as the menu: they are about
     * the pane as a whole, and both are things you reach for while looking at
     * two lists rather than at one file.
     */
    this.cmpBtn = btn('\u21C4', 'Compare with the other list', () => {
      this.compare ? this.clearCompare() : this.compareWith();
    }, 'extra');
    this.syncBtn = btn('\u21C6', 'Synchronize with the other list…', () => this.syncWith(), 'extra');

    /*
     * The star: this folder, kept.
     *
     * Clicking stars or unstars where you are; right-clicking offers the
     * scopes and the list, because "every host" is the answer for /var/log and
     * "this host" is the answer for a deploy directory.
     */
    /*
     * Search the tree, not the listing.
     *
     * The filter beside it narrows what is already on screen; this walks the
     * folder — `find` and `grep` on a server, a bounded walk locally — which
     * is the question people actually arrive with.
     */
    this.searchBtn = btn('\u{1F50E}', 'Search this folder and everything under it…', () => this.openSearch());

    /*
     * The same folder as a city you can fly over and walk into. A view of
     * this explorer rather than a separate tool: the toolbar keeps working.
     */
    this.cityBtn = btn('3D', 'See this folder in 3D — fly over it, walk into folders', () => this.toggle3d());
    this.cityBtn.classList.add('fcity');
    this.cityBtn.classList.toggle('hidden', state.settings.show3dView === false);

    this.favBtn = btn('\u2606', 'Star this folder', () => this.toggleFavorite(this.view.path));
    this.favBtn.classList.add('ffav');
    this.favBtn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const scope = await this._favScope();
      if (!scope) return;
      const favs = await this._favorites();
      const here = this.view.path;
      contextMenu(e.clientX, e.clientY, [
        { heading: true, label: here || 'this folder' },
        {
          label: await this._isFavorite(here) ? 'Unstar this folder' : `Star for ${scope.label}`,
          onClick: () => this.toggleFavorite(here),
        },
        scope.kind === 'host' ? {
          label: 'Star for every host',
          title: 'A folder like /var/log is the same question on every server',
          onClick: () => this.toggleFavorite(here, { scope: 'hosts' }),
        } : null,
        favs.length ? { sep: true } : null,
        ...(favs.length ? [{ heading: true, label: 'Favourites' }] : []),
        ...favs.map((f) => ({
          label: f.label || f.path,
          key: f.scope === 'hosts' ? 'every host' : '',
          title: f.path,
          onClick: () => this.navigate(f.path),
        })),
      ].filter(Boolean));
    });

    this.head = el('div', { class: 'fpane-head' },
      this.sourceSel,
      el('div', { class: 'fpane-actions' },
        this.localBtn,
        btn('⌖', 'Go to a path…', () => this.goToPath()),
        btn('↑', 'Parent', () => this.goParent()),
        btn('‹', 'Back', () => this.historyGo(-1), 'nav'),
        btn('›', 'Forward', () => this.historyGo(1), 'nav'),
        btn('⟳', 'Refresh', () => this.refresh()),
        this.favBtn,
        this.searchBtn,
        this.cityBtn,
        btn('+', 'New folder', () => this.makeDir(), 'extra'),
        this.sortBtn,
        this.cmpBtn,
        this.syncBtn,
        this.detailsBtn,
        this.followBtn,
        this.filterBtn,
        this.hiddenBtn,
        btn('×', 'Hide this explorer', () => this.onChange?.('hide'))));

    this.pathInput = el('input', { spellcheck: 'false', placeholder: '/' });
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.navigate(this.pathInput.value.trim()); }
      if (e.key === 'Escape') { this.pathInput.value = this.view.path || ''; this.pathInput.blur(); }
    });

    /*
     * The filter box. The arrow keys move the selection through the matches
     * without leaving it, so finding a name and acting on it is one gesture:
     * type a few letters, arrow to the one you meant, Enter. Having to click
     * into the list in between is what makes a filter box annoying.
     */
    this.filterInput = el('input', {
      spellcheck: 'false',
      placeholder: 'Filter by name — *.log, conf, id_*',
      title: 'Matches anywhere in the name. * and ? are wildcards.\n'
        + '↑ ↓ move through the matches · Enter opens · Esc clears',
    });
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value;
      // A filter that just excluded the selected file would otherwise leave a
      // selection that is no longer on screen, which Enter would then open.
      this._pruneSelection();
      this.render();
    });
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._moveSelection(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const sel = this.selected();
        // Nothing picked yet: Enter takes the first match, so a filter narrow
        // enough to leave one answer needs no arrow key at all.
        const target = sel.length === 1 ? sel[0] : this.flat()[0];
        if (target) this.open(target);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Clear first, close only if it was already empty — Esc on a filter
        // you can see should undo the filtering, not hide the evidence.
        if (this.filter) this.clearFilter();
        else this.toggleFilter(false);
      }
    });
    this.filterRow = el('div', { class: 'filterbar hidden' },
      this.filterInput,
      el('button', {
        class: 'icon-btn sm', text: '×', title: 'Clear the filter',
        onClick: () => { this.clearFilter(); this.toggleFilter(false); },
      }));

    /*
     * The column strip.
     *
     * Sorting was a button and a menu — two clicks and a read, for the thing
     * a file list is asked to do most. The columns are already there; this
     * only labels them and lets them be clicked, which is where everybody
     * expects to click. Deliberately tiny: it is a label, not a toolbar, and
     * the list underneath it is the point.
     */
    this.headRow = this._buildColumns();

    this.list = el('div', { class: 'flist', tabindex: '0' });
    this.list.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    this.list.addEventListener('keydown', (e) => this._onKey(e));
    this.statusBar = el('div', { class: 'fpane-status' });

    /*
     * The favourites, on screen rather than behind a dialog.
     *
     * A star that can only be seen again by opening *Go to a path* is a star
     * nobody uses. This is one thin row under the path: the folders kept for
     * wherever this pane is pointed, one click each.
     */
    this.favBar = el('div', { class: 'fpane-favs' });

    this.element = el('div', { class: 'fpane' },
      this.head,
      el('div', { class: 'pathbar' }, this.pathInput),
      this.favBar,
      this.filterRow,
      this.headRow,
      this.list,
      this.statusBar);

    // After the element exists: the drop target is the whole pane.
    this._setupDrop();

    this._syncToggles();
  }

  /** Sort keys, and which way. Ticks show what is in force. */
  /**
   * The header cells, in the same classes the rows use.
   *
   * Same classes on purpose: the widths, the shrink order and the points at
   * which a narrow pane drops a column all live in one place in the
   * stylesheet, so the header cannot drift out of line with the rows it
   * labels. The details columns are labelled but not clickable — `sortEntries`
   * has no key for a mode string, and a header that does nothing when clicked
   * is worse than one that plainly does not invite it.
   */
  _buildColumns() {
    const cell = (key, label, cls) => {
      const node = el('span', { class: cls + (key ? ' sortable' : ''), text: label });
      if (!key) return node;
      node.title = `Sort by ${label.toLowerCase()} — click again to reverse`;
      node.addEventListener('click', (e) => { e.stopPropagation(); this._sortBy(key); });
      return node;
    };
    return el('div', { class: 'fhead' },
      el('span', { class: 'ftwisty' }),
      el('span', { class: 'ficon' }),
      cell('name', 'Name', 'fname'),
      cell('', 'Mode', 'fperm'),
      cell('', 'Owner', 'fown'),
      cell('size', 'Size', 'fsize'),
      cell('mtime', 'Date', 'fdate'));
  }

  /** Mark the column in force, and which way it is pointing. */
  _syncColumns() {
    if (!this.headRow) return;
    const details = state.showFileDetails && this.source.kind !== 's3';
    this.headRow.querySelector('.fperm').classList.toggle('hidden', !details);
    this.headRow.querySelector('.fown').classList.toggle('hidden', !details);
    const arrow = this.sort.dir === 1 ? ' \u25B4' : ' \u25BE';
    for (const [key, cls, label] of [['name', 'fname', 'Name'], ['size', 'fsize', 'Size'], ['mtime', 'fdate', 'Date']]) {
      const node = this.headRow.querySelector('.' + cls);
      const on = this.sort.key === key;
      node.classList.toggle('on', on);
      node.textContent = label + (on ? arrow : '');
    }
  }

  /**
   * Sort by a column. Clicking the one already in force flips it, which is
   * what every file list does and saves a second menu.
   */
  _sortBy(key) {
    if (this.sort.key === key) this.sort.dir = -this.sort.dir;
    else this.sort = { key, dir: key === 'name' ? 1 : -1 };
    this.render();
  }

  /**
   * The sort, plus whether folders are held above the files — a preference
   * rather than part of `this.sort`, because it applies to every explorer
   * at once and survives a restart.
   */
  _sortOpts() {
    return { ...this.sort, foldersFirst: state.settings.foldersFirst !== false };
  }

  _openSortMenu(evt) {
    const r = (evt?.currentTarget || this.sortBtn).getBoundingClientRect();
    const pick = (key) => this._sortBy(key);
    const mark = (key) => (this.sort.key === key
      ? (this.sort.dir === 1 ? 'ascending' : 'descending')
      : '');
    contextMenu(r.left, r.bottom + 2, [
      { label: 'Sort by', heading: true },
      { label: 'Name', key: mark('name'), onClick: () => pick('name') },
      { label: 'Size', key: mark('size'), onClick: () => pick('size') },
      { label: 'Date modified', key: mark('mtime'), onClick: () => pick('mtime') },
      { sep: true },
      {
        label: this.sort.dir === 1 ? 'Reverse order' : 'Normal order',
        onClick: () => { this.sort.dir = -this.sort.dir; this.render(); },
      },
      { sep: true },
      {
        label: 'Folders first',
        key: state.settings.foldersFirst !== false ? '✓' : '',
        title: 'Off mixes files and folders together, in whatever order the column says',
        onClick: async () => {
          state.settings = await window.api.settings.set({
            foldersFirst: state.settings.foldersFirst === false,
          });
          // Every explorer sorts the same way, so every explorer redraws.
          for (const e of explorers.values()) e.render();
        },
      },
    ]);
  }

  /* ---------------- name filter ---------------- */

  /** Show or hide the filter row. Showing it focuses it; there is no other point. */
  toggleFilter(force) {
    const show = force === undefined ? this.filterRow.classList.contains('hidden') : force;
    this.filterRow.classList.toggle('hidden', !show);
    this.filterBtn.classList.toggle('active', show);
    if (show) setTimeout(() => this.filterInput.focus(), 0);
    else if (this.filter) this.clearFilter();
  }

  clearFilter() {
    this.filter = '';
    this.filterInput.value = '';
    this.render();
  }

  /** Focus the filter, seeding it — used by type-ahead from the list. */
  focusFilter(seed) {
    this.toggleFilter(true);
    if (seed !== undefined) {
      this.filter = this.filterInput.value = seed;
      this.render();
    }
  }

  /**
   * A predicate over entry names, or null for "everything".
   *
   * Plain text matches anywhere in the name, because that is what a few
   * remembered letters of a filename are. `*` and `?` turn it into a glob
   * anchored at both ends, so `*.log` means what it does in a shell rather
   * than matching a file called `mylog.txt`.
   */
  _matcher() {
    const q = this.filter.trim().toLowerCase();
    if (!q) return null;
    if (/[*?]/.test(q)) {
      const body = q.split(/([*?])/).map((part) => (
        part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )).join('');
      let re;
      // A half-typed glob can still be an invalid pattern; fall back to a
      // substring match rather than throwing on every keystroke.
      try { re = new RegExp(`^${body}$`); } catch { return (n) => n.toLowerCase().includes(q); }
      return (n) => re.test(n.toLowerCase());
    }
    return (n) => n.toLowerCase().includes(q);
  }

  /** Drop anything from the selection that the current filter hides. */
  _pruneSelection() {
    const view = this.view;
    if (!view.selection.size) return;
    const shown = new Set(this.flat().map((e) => e.path));
    for (const p of [...view.selection]) if (!shown.has(p)) view.selection.delete(p);
  }

  _syncToggles() {
    const pane = this.paneId ? state.getPane(this.paneId) : null;
    // On the local companion itself the button means "close me".
    const isCompanion = pane && pane.localExplorer === this;
    this.localBtn?.classList.toggle('active', isCompanion || !!pane?.localExplorer);
    if (this.localBtn) {
      this.localBtn.title = isCompanion
        ? 'Hide the local file list'
        : 'Show local files below (drag to upload/download)';
    }
    this.hiddenBtn.classList.toggle('active', state.showHidden);
    if (this.cmpBtn) {
      this.cmpBtn.classList.toggle('active', !!this.compare);
      this.cmpBtn.title = this.compare
        ? 'Clear the comparison'
        : 'Compare with the other list';
    }
    if (this.syncBtn) this.syncBtn.classList.toggle('hidden', this.source.kind === 's3' || this.source.kind === 'kube');
    if (this.detailsBtn) {
      this.detailsBtn.classList.toggle('active', state.showFileDetails);
      // A bucket has no permissions and no owner to show, so the button says
      // so rather than turning on two empty columns.
      this.detailsBtn.classList.toggle('hidden', this.source.kind === 's3' || this.source.kind === 'kube');
    }
    // A filter in force keeps its button lit even if the row was collapsed.
    this.filterBtn?.classList.toggle('active', !!this.filter
      || !this.filterRow.classList.contains('hidden'));
    this.followBtn.classList.toggle('active', state.followTerminal);
    // Only the explorer bound to its own pane's session can follow that shell.
    this.followBtn.classList.toggle('hidden', !!this.source.connId || this.source.kind === 'local' || this.source.kind === 'kube');
  }

  /** Refresh the source dropdown from the current set of connections. */
  syncSources() {
    const sel = this.sourceSel;
    const pane = this.paneId ? state.getPane(this.paneId) : null;
    const paneConn = pane?.connId ? state.getConnection(pane.connId) : null;

    const opts = [];
    /*
     * "This session" is offered by any pane that has a host behind it — a
     * tmux pane included, since its control stream rides the same connection
     * as an ordinary session's shell. Leaving it out did more than hide an
     * option: the source the explorer *was* on would not be in the list, so
     * it silently fell back to the local machine.
     */
    if (pane && (pane.kind === 'remote' || pane.kind === 'tmux')) {
      opts.push({ value: 'pane', label: paneConn ? `This session: ${paneConn.label}` : 'This session' });
    }
    /*
     * A kube exec pane is 'local'-kind underneath (see kubepanel.js) — no
     * connId, so none of the branches above apply — but its explorer is
     * just as pinned to "this session" as a remote pane's is. Same failure
     * mode the comment above describes for 'pane': leaving this out of the
     * list would make `want` below unmatched, and the explorer would be
     * silently reset to the local machine every time this ran.
     */
    if (this.source.kind === 'kube') {
      opts.push({ value: 'kube', label: `This pod: ${this.source.kubeSpec?.podName || ''}` });
    }
    opts.push({ value: 'local', label: 'Local machine' });
    for (const c of state.connections.values()) {
      if (c.state !== 'connected') continue;
      if (pane && c.id === pane.connId) continue;   // already offered as "this session"
      opts.push({ value: 'conn:' + c.id, label: c.label });
    }
    for (const t of state.s3Targets || []) {
      opts.push({ value: 's3:' + t.id, label: 'S3: ' + t.name });
    }

    const want = this.source.kind === 's3' ? 's3:' + this.source.targetId
      : this.source.kind === 'kube' ? 'kube'
        : this.source.kind === 'local' ? 'local'
          : this.source.connId ? 'conn:' + this.source.connId : 'pane';

    sel.replaceChildren(...opts.map((o) => el('option', { value: o.value, text: o.label })));
    sel.value = opts.some((o) => o.value === want) ? want : (opts[0]?.value || 'local');

    // The session this explorer was pinned to may have closed.
    if (sel.value !== want) this._onSourcePicked(sel.value, { silent: true });
  }

  async _onSourcePicked(value, { silent } = {}) {
    if (value === 'local') this.source = { kind: 'local', connId: null };
    else if (value === 'pane') this.source = { kind: 'remote', connId: null };
    // Not really "picked" — kube offers no other pod to switch to here, the
    // same way 'pane' isn't really a choice either. This only ever runs via
    // syncSources()'s own silent reconciliation, re-affirming what the pane
    // was already pinned to rather than changing it.
    else if (value === 'kube') this.source = { kind: 'kube', connId: null, kubeSpec: this.source.kubeSpec };
    else if (value.startsWith('s3:')) this.source = { kind: 's3', targetId: value.slice(3), connId: null };
    else this.source = { kind: 'remote', connId: value.slice('conn:'.length) };

    /*
     * Clear the path bar straight away. It is shared by every source, so
     * leaving the last one's path there while a bucket loads reads as though
     * the bucket has directories it does not.
     */
    this.pathInput.value = '';
    if (this.source.kind === 's3' && this.city) this.toggle3d(false);
    // A different source has a different shell behind it, so what was followed
    // before says nothing about this one.
    this.followedCwd = null;
    this._syncToggles();
    if (!silent) await this.ensureLoaded({ force: true });
    else this.render();
  }

  /* ---------------- listing ---------------- */

  _list(dir) {
    if (this.source.kind === 's3') return this._listS3(dir);
    if (this.source.kind === 'kube') return this._listKube(dir);
    return this.source.kind === 'local'
      ? window.api.local.list(dir)
      : window.api.sftp.list(this.connId, dir);
  }

  /**
   * A pod's filesystem, through `kubectl exec` — see kubefs.js on the main
   * side. Shaped like a local/SFTP listing (`{path, entries}`) so nothing
   * downstream needs to know this isn't one.
   */
  async _listKube(dir) {
    const p = (dir === '.' || !dir) ? '/' : String(dir);
    const r = await window.api.kube.ls({ spec: this.source.kubeSpec, dir: p });
    if (!r.ok) throw new Error(r.error || 'Could not list that directory');
    return { path: p, entries: r.entries };
  }

  /**
   * A bucket has no directories, only keys that share a prefix — so a "path"
   * here is a prefix, and the listing turns shared prefixes into folders.
   */
  async _listS3(prefix) {
    const p = (prefix === '.' || prefix === '/' || !prefix) ? '' : String(prefix);
    const r = await window.api.s3.browse(this.s3Id, p);
    return {
      path: r.prefix,
      entries: r.entries.map((e) => ({ ...e, mode: null })),
    };
  }

  /** Load the home/root listing the first time this source becomes usable. */
  async ensureLoaded({ force = false, user = false } = {}) {
    const view = this.view;
    if (this.source.kind === 'remote') {
      const conn = this.connId ? state.getConnection(this.connId) : null;
      if (conn?.state !== 'connected') { this.render(); return; }

      /*
       * On a per-session-MFA host every channel costs an approval, and the
       * file channel would otherwise race the terminal's prompt — two OS
       * dialogs at once, which macOS cancels. So the first load waits for an
       * explicit click, and a failure does not retry itself.
       *
       * Only where there is an approval to spend, though — a host actually
       * known to need per-session MFA, checked the same way the rest of the
       * app does (`isMfaHost`), not merely "this connection happens to be on
       * tsh": a leaf cluster, no local ssh client, tmux, or a duplicate
       * hostname dialled by id all put a connection on tsh for reasons that
       * have nothing to do with MFA, and the gate used to ask for an
       * approval none of them were ever going to need. Those load like any
       * other host.
       */
      if (conn.transport === 'tsh' && !isMfaHost(conn.hostId) && !view.path && !user) {
        // Nothing to approve: fall through and load.
      } else if (conn.transport === 'tsh' && !user && !view.path) { this.render(); return; }
      if (view._mfaFailed && !user) { this.render(); return; }

      if (view.path && !force) { this.render(); return; }
      if (view._loading) return;
      view._loading = true;
      try {
        await this.navigate(view.path || conn.homeDir || '.');
        view._mfaFailed = false;
      } catch {
        if (conn.transport === 'tsh') view._mfaFailed = true;
      } finally { view._loading = false; }
      return;
    }
    if (this.source.kind === 's3') {
      if (view.path !== null && !force) { this.render(); return; }
      try { await this.navigate(view.path || ''); } catch { /* the explorer stays where it was */ }
      return;
    }
    if (this.source.kind === 'kube') {
      if (view.path && !force) { this.render(); return; }
      try { await this.navigate(view.path || '/'); } catch { /* the explorer stays where it was */ }
      return;
    }
    if (view.path && !force) { this.render(); return; }
    try { await this.navigate(view.path || await window.api.local.home()); } catch { /* the explorer stays where it was */ }
  }

  /**
   * Bring the file browser's connection back, then the listing.
   *
   * `conn.connect` reuses a master that is still up — no authentication, a
   * second at most — and only dials afresh when it is really gone. It is the
   * same call a terminal's Reconnect makes, but the file browser needs one of
   * its own: a tmux pane's terminal never exits when the connection is marked
   * down, because its control stream is still running, so nothing else would
   * ever make the call and the browser would say "Session is error" for as
   * long as tmux kept going.
   *
   * `background` is for that same tmux self-heal only (`_maybeHealTmux`
   * passes it) — nobody asked this one to run, so it leaves a deliberate
   * logout alone rather than quietly logging back in behind it. The
   * explicit "Reconnect" button is the person asking, same as a
   * double-click on a host, so it gets the login attempt.
   */
  async reconnect({ quiet = false, background = false } = {}) {
    const connId = this.connId;
    if (!connId || this._reconnecting) return;
    this._reconnecting = true;
    this.render();
    this._setStatus('Reconnecting…');
    try {
      const { connectWithRelogin } = await import('./sessions.js');
      const info = await connectWithRelogin(connId, { background });
      state.setConnection(connId, { state: 'connected', ...(info || {}) });
      this.view.error = null;
      this.view._mfaFailed = false;
      await this.ensureLoaded({ force: true, user: !quiet });
    } catch (e) {
      this.view.error = explainConnectError(e.message);
      this.render();
      if (!quiet) toast(e.message, 'error');
    } finally {
      this._reconnecting = false;
    }
  }

  /**
   * A tmux pane whose session is still attached heals itself.
   *
   * The control stream rides the same connection, so while it is live the
   * connection is too, and putting the file channel back costs nothing. At
   * most once a minute, so a host that really is unreachable is not dialled
   * in a loop by every redraw.
   */
  _maybeHealTmux() {
    const pane = this.paneId ? state.getPane(this.paneId) : null;
    if (!pane?.tmuxId || pane.connId !== this.connId) return;
    if (Date.now() - (this._lastHeal || 0) < 60000) return;
    import('./tmux.js').then(({ tmuxAttached }) => {
      if (!tmuxAttached(pane.tmuxId)) return;
      this._lastHeal = Date.now();
      this.reconnect({ quiet: true, background: true });
    }).catch(() => {});
  }

  async navigate(path, { push = true } = {}) {
    // A comparison describes one pair of directories; leaving either of them
    // would make its marks a lie, so they go.
    this.compare = null;
    const view = this.view;
    if (this.source.kind === 'remote') {
      const conn = this.connId ? state.getConnection(this.connId) : null;
      if (conn?.state !== 'connected') { this._setStatus('Not connected', true); this.render(); return; }
    }
    view.loading = true;
    this._setStatus('Loading…');
    try {
      const res = await this._list(this.source.kind === 's3' ? (path || '') : (path || '.'));
      view.path = res.path;
      view.entries = res.entries;
      view.selection = new Set();
      view.error = null;
      view.expanded.clear();
      view.children.clear();
      view.loadingPaths.clear();
      if (push) {
        view.history = view.history.slice(0, view.hIndex + 1);
        if (view.history[view.history.length - 1] !== res.path) view.history.push(res.path);
        view.hIndex = view.history.length - 1;
      }
    } catch (e) {
      view.error = explainConnectError(e.message);
      this.render();
      throw e;
    } finally {
      view.loading = false;
    }
    this.render();
    this._loadDisk();
  }

  /**
   * Free and total space on the volume the listed folder lives on, for the
   * footer. Asked after the listing, never before it — a slow `df` must not
   * hold up the files — and remembered for half a minute per folder, so a
   * refresh or a quick back-and-forth does not run it again for an answer
   * that cannot have moved. Buckets have no such thing; a host that cannot
   * answer cheaply (per-session MFA) just shows no figure.
   */
  async _loadDisk() {
    const view = this.view;
    const dir = view.path;
    if (!dir || this.source.kind === 's3' || this.source.kind === 'kube') { view.disk = null; return; }
    // "No background commands on servers": no df on a host by itself.
    if (this.source.kind === 'remote' && state.settings?.quietRemote === true) { view.disk = null; return; }
    const key = this.sourceKey + '|' + dir;
    const hit = diskCache.get(key);
    if (hit && Date.now() - hit.at < 30000) { view.disk = hit.disk; this.render(); return; }
    let disk = null;
    try {
      disk = this.source.kind === 'local'
        ? await window.api.local.diskSpace(dir)
        : await window.api.conn.diskSpace(this.connId, dir);
    } catch { disk = null; }
    diskCache.set(key, { at: Date.now(), disk });
    // Still the same folder? A fast click elsewhere would otherwise get the
    // wrong volume's numbers painted under it.
    if (this.view === view && view.path === dir) {
      view.disk = disk;
      this.render();
    }
  }

  async refresh() {
    this.city?.invalidate();
    const view = this.view;
    if (!view.path) return this.ensureLoaded({ force: true });
    const open = [...view.expanded];
    await this.navigate(view.path, { push: false });
    for (const dir of open) {
      view.expanded.add(dir);
      try { view.children.set(dir, (await this._list(dir)).entries); }
      catch { view.children.set(dir, null); }
    }
    this.render();
  }

  /* ---------------- starred folders ---------------- */

  /**
   * Folders that start out flagged.
   *
   * The ones everybody wants on day one — Documents and Downloads here,
   * `/var/log` and `/etc` on a server — so the list is useful before anyone
   * has starred anything. They live in code rather than being written into
   * settings, the same arrangement the built-in macros use: they can improve
   * between releases, and unstarring one hides it rather than editing a list
   * the user never wrote.
   *
   * The local set comes from the main process, which only returns directories
   * that actually exist.
   */
  async _defaultFavorites(scope) {
    const hidden = new Set(state.settings.hiddenFolderFavorites || []);
    const list = scope.kind === 'local'
      ? (state.settings.autoFlagLocal || [])
      : (state.settings.autoFlagHost || []);
    if (!list.length) return [];

    const label = (p) => (p === '~' ? 'Home' : (posix.basename(p) || p));
    const id = (p) => 'builtin-' + scope.kind + '-' + p.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');

    if (scope.kind === 'local') {
      // The main process decides what is really there; a configured folder
      // that does not exist is simply not offered.
      const key = list.join('\n');
      if (this._autoLocalKey !== key) {
        this._autoLocalKey = key;
        this._autoLocal = await window.api.local.existingDirs(list).catch(() => []);
      }
      return (this._autoLocal || [])
        .map((x) => ({
          id: id(x.given), path: x.path, label: label(x.given), scope: 'local', builtin: true,
        }))
        .filter((f) => !hidden.has(f.id));
    }

    const homeDir = state.getConnection(this.connId)?.homeDir;
    const homeNames = await this._homeFolders(homeDir);
    const out = [];
    for (const raw of list) {
      const p = String(raw || '').trim();
      if (!p) continue;
      if (p === '~') {
        if (homeDir) out.push({ id: id(p), path: homeDir, label: 'Home', scope: 'hosts', builtin: true });
        continue;
      }
      if (p.startsWith('~/')) {
        // Only the home subfolders this host actually has, from one listing.
        const name = p.slice(2);
        if (!homeDir || !homeNames.includes(name)) continue;
        out.push({ id: id(p), path: posix.join(homeDir, name), label: name, scope: 'hosts', builtin: true });
        continue;
      }
      out.push({ id: id(p), path: p, label: label(p), scope: 'hosts', builtin: true });
    }
    return out.filter((f) => !hidden.has(f.id));
  }

  /**
   * Which favourites apply to this pane, and what a new one here would be
   * scoped to.
   *
   * A local pane is its own scope. A remote pane gets the host's key — the
   * same one the sidebar and the connection use, so a starred folder survives
   * a Teleport node being renamed — and also sees anything starred for every
   * host.
   */
  async _favScope() {
    if (this.source.kind === 'local') return { kind: 'local', key: 'local', label: 'this machine' };
    if (this.source.kind === 's3' || this.source.kind === 'kube') return null;
    const conn = state.getConnection(this.connId);
    if (!conn) return null;
    let key = conn.hostId || '';
    try {
      const { hostById, hostPrefKey } = await import('./sidebar.js');
      const host = conn.hostId ? hostById(conn.hostId) : null;
      if (host) key = hostPrefKey(host);
    } catch { /* the id alone is a workable key */ }
    return { kind: 'host', key, label: conn.label || 'this host' };
  }

  /**
   * Which of the usual home subfolders this server actually has.
   *
   * A Linux box may or may not have Desktop, Documents and Downloads — a
   * desktop install does, a cloud instance usually does not — and a starred
   * folder that 404s on click is worse than no star. So the home directory is
   * listed once per connection and the answer cached; anything not there is
   * simply not offered.
   */
  async _homeFolders(homeDir) {
    if (!homeDir || !this.connId) return [];
    homeFolderCache.has(this.connId) || homeFolderCache.set(this.connId, (async () => {
      try {
        const r = await window.api.sftp.list(this.connId, homeDir);
        const names = new Set((r?.entries || r || [])
          .filter((e) => e.type === 'directory' || e.targetType === 'directory')
          .map((e) => e.name));
        const wanted = (state.settings.autoFlagHost || [])
          .filter((p) => String(p).startsWith('~/'))
          .map((p) => String(p).slice(2))
          .filter((n) => n && !n.includes('/'));
        return wanted.filter((n) => names.has(n));
      } catch {
        // Not connected yet, or no permission to read home: offer nothing
        // rather than guessing.
        return [];
      }
    })());
    return homeFolderCache.get(this.connId);
  }

  /**
   * The favourites to show here: the built-in ones for this kind of pane, then
   * this scope's own, then anything starred for every host. A path starred by
   * hand replaces the built-in entry for the same path rather than doubling
   * it.
   */
  async _favorites() {
    const scope = await this._favScope();
    if (!scope) return [];
    const mine = (state.settings.folderFavorites || []).filter((f) => f.scope === scope.key
      || (scope.kind === 'host' && f.scope === 'hosts'));
    const defaults = await this._defaultFavorites(scope);
    const byPath = new Set(mine.map((f) => f.path));
    return [...defaults.filter((f) => !byPath.has(f.path)), ...mine];
  }

  /**
   * The starred folders for wherever this pane is pointed — the saved ones
   * and the defaults together, which is exactly what the star button shows.
   * Public because the rsync dialog offers the same list as somewhere to
   * copy to or from, and "the folders I keep coming back to" and "the
   * folders I keep copying" are very nearly the same list.
   */
  async favoriteFolders() {
    return (await this._favorites()).filter((f) => (f.kind || 'dir') === 'dir');
  }

  async _isFavorite(path) {
    const list = await this._favorites();
    return list.some((f) => f.path === path);
  }

  /**
   * Star or unstar a folder.
   *
   * Starring asks nothing — a star is instantly reversible, and a dialog for
   * it would cost more than the thing itself. The scope is offered on the
   * *manage* side instead, where changing it is the point.
   */
  async toggleFavorite(path, { scope: forceScope = null, kind = 'dir' } = {}) {
    const scope = await this._favScope();
    if (!scope) return toast('Buckets cannot be starred yet', 'error');
    const target = forceScope || scope.key;

    // A built-in for this path is hidden rather than deleted: there is nothing
    // in settings to remove, and it should stay hidden across restarts.
    const builtin = (await this._defaultFavorites(scope)).find((f) => f.path === path);
    if (builtin && !(state.settings.folderFavorites || []).some((f) => f.path === path)) {
      const hidden = new Set(state.settings.hiddenFolderFavorites || []);
      hidden.add(builtin.id);
      state.settings = await window.api.settings.set({ hiddenFolderFavorites: [...hidden] });
      status(`Unstarred ${path}`);
      this._syncFavButton();
      return;
    }

    const all = [...(state.settings.folderFavorites || [])];
    const at = all.findIndex((f) => f.path === path
      && (f.scope === target || (scope.kind === 'host' && f.scope === 'hosts')));
    if (at >= 0) {
      const gone = all.splice(at, 1)[0];
      state.settings = await window.api.settings.set({ folderFavorites: all });
      status(`Unstarred ${gone.path}`);
    } else {
      all.push({
        id: 'fav_' + Math.random().toString(36).slice(2, 9),
        path,
        label: posix.basename(path) || path,
        scope: target,
        scopeLabel: target === 'local' ? 'this machine' : target === 'hosts' ? 'every host' : scope.label,
        // A starred file opens; a starred folder is navigated to. Recorded,
        // because the two are not the same gesture.
        kind: kind === 'file' ? 'file' : 'dir',
      });
      state.settings = await window.api.settings.set({ folderFavorites: all });
      status(`Starred ${path}`);
    }
    this._syncFavButton();
  }

  async _syncFavButton() {
    if (!this.favBtn) return;
    const scope = await this._favScope();
    this.favBtn.classList.toggle('hidden', !scope);
    this._drawFavBar(scope);
    if (!scope) return;
    const on = await this._isFavorite(this.view.path);
    this.favBtn.classList.toggle('active', on);
    this.favBtn.textContent = on ? '\u2605' : '\u2606';
    this.favBtn.title = on
      ? `Starred — click to remove ${this.view.path}`
      : `Star ${this.view.path || 'this folder'} for ${scope.label}`;
  }

  /**
   * The starred folders, as a list above the files.
   *
   * A list rather than a strip of labels: these are places to go, the same
   * kind of thing as the rows underneath, so they read as one — name, where it
   * is, and whether you are in it. It collapses, because on a narrow pane the
   * files are what you came for.
   */
  async _drawFavBar(scope) {
    if (!this.favBar) return;
    if (!scope) { this.favBar.classList.add('hidden'); return; }
    this.favBar.classList.remove('hidden');
    const favs = await this._favorites();
    clear(this.favBar);

    const collapsed = state.settings.favListCollapsed === true;
    const head = el('div', { class: 'fav-head' + (collapsed ? ' collapsed' : '') },
      el('span', { class: 'chev', text: '▼' }),
      el('span', { class: 'ttl', text: 'starred' }),
      el('span', { class: 'n', text: favs.length ? String(favs.length) : '' }));
    head.addEventListener('click', async () => {
      state.settings = await window.api.settings.set({ favListCollapsed: !collapsed });
      // Both panes carry the same list, so both follow the same choice.
      for (const ex of explorers.values()) ex._syncFavButton();
    });
    this.favBar.append(head);
    if (collapsed) return;

    if (!favs.length) {
      this.favBar.append(el('div', {
        class: 'fav-empty',
        title: 'The star in the toolbar keeps the folder you are in',
        text: 'Nothing starred here yet — the ☆ in the toolbar keeps this folder.',
      }));
      return;
    }

    for (const f of favs) {
      const here = f.path === this.view.path;
      const row = el('div', {
        class: 'fav-row' + (here ? ' on' : '') + (f.kind === 'file' ? ' file' : ''),
        title: `${f.path}${f.scope === 'hosts' ? '  ·  starred for every host' : ''}`
          + (f.builtin ? '  ·  one of the built-in ones' : '')
          + (f.kind === 'file' ? '  ·  a file; opens when clicked' : ''),
      },
        el('span', { class: 'g', text: '★' }),
        el('span', { class: 'nm', text: f.label || f.path }),
        el('span', { class: 'pth', text: shortPath(f.path) }),
        f.scope === 'hosts' ? el('span', { class: 'sc', title: 'Starred for every host', text: 'all' }) : null);
      row.addEventListener('click', () => (f.kind === 'file' ? this._openFavFile(f) : this.navigate(f.path)));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        contextMenu(e.clientX, e.clientY, [
          { heading: true, label: f.path },
          f.kind === 'file'
            ? { label: 'Open it', icon: '\u2197', onClick: () => this._openFavFile(f) }
            : { label: 'Go here', icon: '\u2192', onClick: () => this.navigate(f.path) },
          /*
           * And the same place in the terminal. A starred folder is somewhere
           * you go often, which is exactly the folder you then want to be in
           * at the prompt — before this that was a navigate, then a
           * right-click on the blank space, then a second menu.
           */
          f.kind === 'file' ? null : this._cdItem(f.path),
          f.kind === 'file' ? {
            label: 'Show the folder it is in', icon: '\u2630',
            onClick: () => this.navigate(this.source.kind === 'local'
              ? parentLocal(f.path) : posix.parent(f.path)),
          } : {
            label: 'Open in the other list', icon: '\u216E',
            title: 'Useful for comparing or synchronising the same folder',
            onClick: async () => {
              const other = await this._otherPane();
              if (other) other.navigate(f.path);
            },
          },
          { sep: true },
          f.builtin ? null : {
            label: 'Rename…', icon: '\u270E',
            onClick: async () => {
              const name = await prompt({
                title: 'Rename favourite', label: 'Name', value: f.label || '', confirmLabel: 'Save',
              });
              if (!name) return;
              const all = (state.settings.folderFavorites || []).map((x) => (
                x.id === f.id ? { ...x, label: name } : x));
              state.settings = await window.api.settings.set({ folderFavorites: all });
              this._syncFavButton();
            },
          },
          {
            label: f.builtin ? 'Hide this one' : 'Unstar', icon: '\u2605',
            title: f.builtin ? 'A built-in favourite; hidden until you restore them' : undefined,
            onClick: () => this.toggleFavorite(f.path),
          },
          (state.settings.hiddenFolderFavorites || []).length ? {
            label: 'Restore the built-in ones', icon: '\u21BA',
            onClick: async () => {
              state.settings = await window.api.settings.set({ hiddenFolderFavorites: [] });
              this._syncFavButton();
            },
          } : null,
        ].filter(Boolean));
      });
      this.favBar.append(row);
    }
  }

  /**
   * Search this folder and everything under it.
   *
   * Two searches in one dialog, because they are the two questions: a name,
   * and a string inside the files. Both are capped — on a server the cap is
   * applied by `head` on the far end, so a search of `/` cannot pull a million
   * lines back over the connection.
   */
  async openSearch() {
    if (this.source.kind === 's3' || this.source.kind === 'kube') return toast('Search does not reach into a pod’s filesystem yet', 'error');
    const local = this.source.kind === 'local';
    const startDir = this.view.path || (local ? (state.appInfo?.home || '/') : '/');

    const dirIn = textInput({ value: startDir, placeholder: '/var/log' });
    const nameIn = textInput({ placeholder: 'nginx.conf, or *.log', autofocus: true });
    const textIn = textInput({ placeholder: 'optional — a string inside the files' });
    const caseIn = checkbox('Match case', false);
    const kindSel = select([
      { value: 'all', label: 'Files and folders' },
      { value: 'files', label: 'Files only' },
      { value: 'dirs', label: 'Folders only' },
    ], 'all');
    // Six is deep enough for most questions and cheap; twelve levels of a home
    // directory is millions of entries.
    const depthIn = textInput({ type: 'number', value: '6', min: '1', max: '40' });
    const results = el('div', { class: 'srch-list' });
    const note = el('div', { class: 'hint', style: 'margin-top:8px' });
    let running = false;

    const run = async () => {
      if (running) return;
      const dir = dirIn.value.trim();
      const pattern = nameIn.value.trim();
      const content = textIn.value.trim();
      if (!pattern && !content) return toast('Give a name to look for, or some text', 'error');
      running = true;
      clear(results);
      note.textContent = 'Searching…';
      const opts = {
        dir,
        pattern,
        content,
        caseSensitive: caseIn.input.checked,
        kinds: content ? 'files' : kindSel.value,
        maxDepth: parseInt(depthIn.value, 10) || 6,
        limit: 400,
      };
      try {
        const r = local
          ? await window.api.local.search(opts)
          : await window.api.sftp.search(this.connId, opts);
        clear(results);
        if (!r.results.length) {
          note.textContent = content
            ? 'Nothing under there contains that.'
            : 'Nothing under there matches that name.';
          return;
        }
        for (const hit of r.results) {
          const row = el('div', { class: 'srch-row', title: hit.path },
            el('span', { class: 'g', text: hit.type === 'directory' ? '\u{1F4C1}' : '\u{1F4C4}' }),
            el('div', { class: 'body' },
              el('div', { class: 'nm', text: hit.name + (hit.line ? `  :${hit.line}` : '') }),
              el('div', { class: 'pth', text: hit.path }),
              hit.excerpt ? el('div', { class: 'ex', text: hit.excerpt }) : null),
            el('span', { class: 'sz', text: hit.size !== null && hit.size !== undefined ? fmtBytes(hit.size) : '' }));
          // Clicking goes to it: into the folder, or to the folder holding the
          // file with the file selected, which is what "show me" means.
          row.addEventListener('click', () => {
            const target = hit.type === 'directory'
              ? hit.path
              : (local ? parentLocal(hit.path) : posix.parent(hit.path));
            this.navigate(target).then(() => {
              if (hit.type !== 'directory') {
                this.selected = new Set([hit.path]);
                this.render();
                const node = this.list.querySelector(`[data-path="${CSS.escape(hit.path)}"]`);
                node?.scrollIntoView({ block: 'center' });
              }
            });
          });
          row.addEventListener('dblclick', () => {
            if (hit.type === 'directory') this.navigate(hit.path);
            else this._openFavFile({ path: hit.path, kind: 'file' });
          });
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            contextMenu(e.clientX, e.clientY, [
              { heading: true, label: hit.path },
              { label: 'Show it in the list', onClick: () => row.click() },
              hit.type !== 'directory'
                ? { label: 'Open it', onClick: () => this._openFavFile({ path: hit.path, kind: 'file' }) }
                : { label: 'Go here', onClick: () => this.navigate(hit.path) },
              {
                label: 'Copy the path',
                onClick: () => { window.api.clipboard.write(hit.path); status('Copied ' + hit.path); },
              },
            ]);
          });
          results.append(row);
        }
        /*
         * Say why it stopped. "12 results" after a search that gave up two
         * levels in reads as "there are 12", which is the wrong thing to
         * believe.
         */
        const why = r.stopped === 'time'
          ? ` — stopped after ${Math.round((r.elapsedMs || 0) / 1000)}s; narrow the name or lower the depth`
          : r.stopped === 'entries'
            ? ' — stopped after a quarter of a million entries; start somewhere narrower'
            : r.truncated ? ' — stopped at the result cap, so narrow it if the one you want is missing' : '';
        note.textContent = `${r.results.length} result${r.results.length === 1 ? '' : 's'}`
          + why
          + (r.scanned ? `  ·  ${r.scanned} entries looked at` : '');
      } catch (e) {
        clear(results);
        note.textContent = e.message;
      } finally { running = false; }
    };

    for (const f of [nameIn, textIn, dirIn]) {
      f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    }

    return modal({
      title: 'Search',
      subtitle: local ? 'This machine' : (state.getConnection(this.connId)?.label || 'Server'),
      width: 'min(760px, 95vw)',
      resize: 'search',
      render: (body) => {
        body.append(
          field('Start in', dirIn),
          el('div', { class: 'field-row' },
            field('Name', nameIn, 'A bare word matches anywhere in the name; * and ? work as usual'),
            field('Containing (optional)', textIn)),
          el('div', { class: 'field-row' },
            field('What to find', kindSel),
            field('Depth', depthIn)),
          caseIn,
          el('div', { style: 'height:10px' }),
          results,
          note);
      },
      buttons: [
        { label: 'Close', value: null },
        { label: 'Search', class: 'primary-btn', onClick: () => run() },
      ],
    });
  }

  /**
   * Open a starred file.
   *
   * Locally that means handing it to the OS, which is what a bookmark to a
   * file is for. On a server it opens the built-in editor — the same as
   * double-clicking the file in the list; *Edit in my editor* is still on the
   * file's own row for anything more than a quick look.
   */
  async _openFavFile(f) {
    if (this.source.kind === 'local') {
      try { await window.api.local.open(f.path); }
      catch (e) { toast(e.message, 'error'); }
      return;
    }
    return this.edit({ name: posix.basename(f.path), path: f.path });
  }

  /**
   * Jump straight to a path. Offers the places people actually go, since
   * typing /var/log by hand every time is the thing this replaces.
   */
  async goToPath() {
    const local = this.source.kind === 'local';
    const places = local
      ? [
          { label: 'Home', path: state.appInfo?.home || '~' },
          { label: 'Desktop', path: (state.appInfo?.home || '~') + '/Desktop' },
          { label: 'Downloads', path: (state.appInfo?.home || '~') + '/Downloads' },
          { label: 'Documents', path: (state.appInfo?.home || '~') + '/Documents' },
          { label: 'Root', path: '/' },
          { label: 'Temp', path: '/tmp' },
        ]
      : [
          { label: 'Home', path: state.getConnection(this.connId)?.homeDir || '.' },
          { label: 'Root', path: '/' },
          { label: 'Logs', path: '/var/log' },
          { label: 'Config', path: '/etc' },
          { label: 'Temp', path: '/tmp' },
          { label: 'Web root', path: '/var/www' },
          { label: 'Services', path: '/etc/systemd/system' },
          { label: 'Opt', path: '/opt' },
        ];

    const input = textInput({ value: this.view.path || '', placeholder: '/var/log', autofocus: true });
    const chosen = await modal({
      title: 'Go to path',
      subtitle: local ? 'Local machine' : (state.getConnection(this.connId)?.label || 'Remote'),
      render: (body, { close }) => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim()); }
        });
        body.append(field('Path', input));

        /*
         * Favourites first: they are the ones this person chose, so they
         * outrank the built-in guesses below them.
         */
        const favWrap = el('div', {});
        body.append(favWrap);
        this._favorites().then((favs) => {
          if (!favs.length) return;
          const fg = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' });
          for (const f of favs) {
            const b = el('button', {
              class: 'ghost-btn sm', text: '\u2605 ' + (f.label || f.path),
              title: `${f.path}${f.scope === 'hosts' ? '  ·  starred for every host' : ''}`,
              onClick: () => close(f.path),
            });
            b.addEventListener('contextmenu', (ev) => {
              ev.preventDefault();
              contextMenu(ev.clientX, ev.clientY, [
                { heading: true, label: f.path },
                { label: 'Go here', onClick: () => close(f.path) },
                {
                  label: 'Unstar',
                  onClick: async () => {
                    const all = (state.settings.folderFavorites || []).filter((x) => x.id !== f.id);
                    state.settings = await window.api.settings.set({ folderFavorites: all });
                    status(`Unstarred ${f.path}`);
                    b.remove();
                    this._syncFavButton();
                  },
                },
              ]);
            });
            fg.append(b);
          }
          favWrap.append(
            el('label', { style: 'font-size:11px;color:var(--muted);margin-bottom:5px;display:block', text: 'Favourites' }),
            fg,
            el('div', { style: 'height:12px' }));
        });

        const grid = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' });
        for (const pl of places) {
          grid.append(el('button', {
            class: 'ghost-btn sm', text: pl.label, title: pl.path,
            onClick: () => close(pl.path),
          }));
        }
        body.append(el('label', { style: 'font-size:11px;color:var(--muted);margin-bottom:5px;display:block', text: 'Quick places' }), grid);
        // The history of this pane is worth one click too.
        const recent = [...new Set(this.view.history.slice(-8).reverse())].filter((h) => h !== this.view.path);
        if (recent.length) {
          const rg = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:10px' });
          for (const r of recent) {
            rg.append(el('button', { class: 'ghost-btn sm', text: r, onClick: () => close(r) }));
          }
          body.append(el('label', { style: 'font-size:11px;color:var(--muted);margin:12px 0 5px;display:block', text: 'Recent' }), rg);
        }
      },
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Go', class: 'primary-btn', onClick: ({ close }) => close(input.value.trim()) },
      ],
    });
    if (chosen) await this.navigate(chosen);
  }

  goParent() {
    const p = this.view.path;
    if (this.source.kind === 's3') {
      // '' is the bucket root, so there is nowhere above it.
      if (!p) return;
      const up = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
      this.navigate(up ? up + '/' : '');
      return;
    }
    if (!p) return;
    return this.navigate(this.source.kind === 'local' ? parentLocal(p) : posix.parent(p));
  }

  historyGo(delta) {
    const view = this.view;
    const i = view.hIndex + delta;
    if (i < 0 || i >= view.history.length) return;
    view.hIndex = i;
    this.navigate(view.history[i], { push: false });
  }

  /* ---------------- rendering ---------------- */

  /** The hidden-files rule alone, which the status line has to count separately. */
  _notHidden(entries) {
    return state.showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));
  }

  visible(entries) {
    const shown = this._notHidden(entries);
    const match = this._matcher();
    if (!match) return shown;
    // A directory survives a filter it does not match itself if something
    // inside it does and is on screen: hiding the parent of a visible match
    // would take the match with it.
    return shown.filter((e) => match(e.name) || this._hasMatchingDescendant(e, match));
  }

  _hasMatchingDescendant(entry, match, depth = 0) {
    const view = this.view;
    // Only expanded, already-loaded branches are considered — this decides what
    // to draw, so it cannot go and fetch directories to find out.
    if (depth > 8 || !isDir(entry) || !view.expanded.has(entry.path)) return false;
    const kids = view.children.get(entry.path);
    if (!Array.isArray(kids)) return false;
    return this._notHidden(kids)
      .some((k) => match(k.name) || this._hasMatchingDescendant(k, match, depth + 1));
  }

  /* ---------------- 3D ---------------- */

  toggle3d(force) {
    const on = force === undefined ? !this.city : force;
    if (on === !!this.city) return;
    if (on && state.settings.show3dView === false) return;
    if (on && (this.source.kind === 's3' || this.source.kind === 'kube')) return toast('The 3D view does not reach into buckets or pods yet', 'error');
    if (on) {
      try { this.city = new City3D(this); }
      catch (e) { return toast('3D needs WebGL, which is not available here: ' + e.message, 'error'); }
      this.list.after(this.city.element);
    } else {
      this.city.destroy();
      this.city = null;
    }
    this.cityBtn.classList.toggle('active', on);
    this.render();
    if (on) this.city?.element.focus({ preventScroll: true });
  }

  /**
   * Show the city when there is a folder to draw, and the list otherwise —
   * the list is where "not connected" and "approve MFA" already say so.
   */
  _sync3d() {
    if (!this.city) {
      this.list.classList.remove('hidden');
      this.headRow.classList.remove('c3-off');
      return;
    }
    const ready = this._listReady;
    this.city.element.classList.toggle('hidden', !ready);
    this.list.classList.toggle('hidden', ready);
    this.headRow.classList.toggle('c3-off', ready);
    if (ready) this.city.sync();
  }

  render() {
    if (this.destroyed) return;
    this._listReady = false;
    this._renderList();
    this._sync3d();
  }

  _renderList() {
    this.syncSources();
    const view = this.view;
    clear(this.list);
    this.pathInput.value = view.path || '';
    // The star reflects the folder on screen, so it has to follow the path.
    this._syncFavButton();

    if (this.source.kind === 'remote') {
      const conn = this.connId ? state.getConnection(this.connId) : null;
      if (!conn) {
        this.list.append(el('div', { class: 'sb-empty', text: 'No session selected.' }));
        this._setStatus('');
        return;
      }
      if (conn.state !== 'connected') {
        const down = conn.state === 'error' || conn.state === 'closed';
        this.list.append(el('div', { class: 'sb-empty' },
          el('div', { text: this._reconnecting ? 'Reconnecting…' : `Session is ${conn.state}.` }),
          down && conn.error ? el('div', { style: 'margin-top:5px;opacity:.75;font-size:11px', text: conn.error }) : null,
          down && !this._reconnecting
            ? el('button', {
                class: 'primary-btn', style: 'margin-top:10px', text: 'Reconnect files',
                title: 'Reuses the connection if it is still up; dials again if it is not',
                onClick: () => this.reconnect(),
              })
            : null));
        this._setStatus('');
        if (down) this._maybeHealTmux();
        return;
      }
      // A host dialled over `tsh` — a leaf cluster, no local ssh client, a
      // duplicate hostname by id, or one actually known to need per-session
      // MFA (checked the same way `ensureLoaded` above does) — nothing
      // loaded yet: ask before spending an approval rather than silently
      // trying and going quiet if the channel is waiting on one.
      //
      // `isMfaHost` is the known-for-sure case; it is not the only one that
      // needed this box here before that stopped gating entry to it. A
      // host reached as a ghost or a requestable row carries a different
      // id than the live inventory's own (see `open()` in sidebar.js), so
      // a node marked MFA read as not needing it the moment it was not
      // live — the explorer just sat there with nothing loading and
      // nothing said about why, which looked identical to broken. Now
      // every `tsh`-dialled connection gets this box once a load attempt
      // has actually settled without one (`!view._loading` — mid-attempt
      // is not yet "nothing happened"); the wording says "may need MFA"
      // rather than claiming it for sure when this cannot tell.
      if (conn.transport === 'tsh' && !view.path && !view._loading) {
        const known = isMfaHost(conn.hostId);
        const leaf = conn.transportForced === 'leaf';
        const noSsh = conn.transportForced === 'no-ssh';
        this.list.append(el('div', { class: 'sb-empty' },
          el('div', { text: view._mfaFailed
            ? 'Could not open the file channel.'
            : known ? 'This host asks for MFA per session.' : 'This host may ask for MFA per session.' }),
          el('div', { style: 'margin-top:5px;opacity:.75;font-size:11px',
            text: leaf
              ? 'It is also in a leaf cluster, so files go through tsh rather than the terminal’s own channel.'
              : noSsh
                ? 'No local ssh client was found either, so files go through tsh rather than the terminal’s own channel.'
                : 'Opening files needs one more approval, separate from the terminal.' }),
          el('button', {
            class: 'primary-btn', style: 'margin-top:10px',
            text: view._mfaFailed ? 'Try again' : known ? 'Load files (approve MFA)' : 'Load files (may need MFA)',
            onClick: () => { view._mfaFailed = false; this.ensureLoaded({ user: true, force: true }); },
          })));
        this._setStatus('');
        return;
      }
    }

    if (view.error) {
      /*
       * A remote listing that failed gets a way to try again in place. The
       * file channel is its own SFTP session, and it can drop — idle timeout,
       * a wake from sleep — while the terminal beside it carries on.
       */
      const remote = this.source.kind === 'remote';
      this.list.append(el('div', { class: 'sb-empty' },
        el('div', { style: 'color:var(--red)', text: view.error }),
        remote && !this._reconnecting
          ? el('button', {
              class: 'ghost-btn sm', style: 'margin-top:10px', text: 'Try again',
              onClick: () => this.reconnect(),
            })
          : null));
      this._setStatus(view.error, true);
      return;
    }

    this._syncColumns();
    this._listReady = true;
    const entries = sortEntries(this.visible(view.entries), this._sortOpts());
    if (!entries.length) this.list.append(this._emptyNotice());
    this._renderTree(this.list, entries, 0);

    // Counted against their own rule each: "hidden" means dotfiles, "filtered"
    // means the name filter. Rolling them together would report a number that
    // neither button can explain.
    const notHidden = this._notHidden(view.entries);
    const hidden = view.entries.length - notHidden.length;
    const filtered = notHidden.length - this.visible(view.entries).length;
    const dirs = entries.filter(isDir).length;
    this._setStatus(`${entries.length} items · ${dirs} folders`
      + (hidden ? ` · ${hidden} hidden` : '')
      + (filtered ? ` · ${filtered} filtered out` : ''));
    if (view.disk) this.statusBar.prepend(diskBadge(view.disk));
  }

  _emptyNotice() {
    const view = this.view;
    const notHidden = this._notHidden(view.entries);
    const hidden = view.entries.length - notHidden.length;
    const filtered = notHidden.length - this.visible(view.entries).length;

    // The filter comes first: it is the thing just typed, so it is the likelier
    // reason the list went empty, and clearing it is the likelier fix.
    if (filtered) {
      return el('div', { class: 'sb-empty' },
        el('div', { text: `No name matches “${this.filter.trim()}” — ${filtered} item${filtered === 1 ? '' : 's'} filtered out.` }),
        el('button', {
          class: 'ghost-btn', style: 'margin-top:9px', text: 'Clear the filter',
          onClick: () => { this.clearFilter(); this.filterInput.focus(); },
        }));
    }
    if (!hidden) return el('div', { class: 'sb-empty', text: 'Empty directory.' });
    return el('div', { class: 'sb-empty' },
      el('div', { text: `Nothing visible — ${hidden} hidden item${hidden === 1 ? '' : 's'}.` }),
      el('button', {
        class: 'ghost-btn', style: 'margin-top:9px', text: 'Show hidden files',
        onClick: () => {
          state.showHidden = true;
          window.api.settings.set({ showHiddenFiles: true }).catch(() => {});
          for (const e of explorers.values()) { e._syncToggles(); e.render(); }
        },
      }));
  }

  _renderTree(container, entries, depth) {
    const view = this.view;
    for (const entry of entries) {
      container.append(this._row(entry, depth));
      if (!isDir(entry) || !view.expanded.has(entry.path)) continue;

      const kids = view.children.get(entry.path);
      const indent = `padding-left:${8 + (depth + 1) * 14}px`;
      if (kids === undefined) {
        container.append(el('div', { class: 'frow ftree-note', style: indent, text: 'Loading…' }));
        continue;
      }
      if (kids === null) {
        container.append(el('div', { class: 'frow ftree-note err', style: indent, text: 'Cannot read directory' }));
        continue;
      }
      const sorted = sortEntries(this.visible(kids), this._sortOpts());
      if (!sorted.length) {
        container.append(el('div', { class: 'frow ftree-note', style: indent, text: 'empty' }));
        continue;
      }
      this._renderTree(container, sorted, depth + 1);
    }
  }

  _row(entry, depth) {
    const view = this.view;
    const dir = isDir(entry);
    const cls = ['frow'];
    if (dir) cls.push('dir');
    if (entry.type === 'symlink') cls.push('link');
    if (entry.targetType === 'broken') cls.push('broken');
    if (view.selection.has(entry.path)) cls.push('selected');

    const expanded = view.expanded.has(entry.path);
    const twisty = el('span', {
      class: 'ftwisty' + (dir ? '' : ' leaf'),
      text: dir ? (expanded ? '−' : '+') : '',
      title: dir ? (expanded ? 'Collapse' : 'Expand') : '',
    });
    if (dir) twisty.addEventListener('click', (e) => { e.stopPropagation(); this.toggleExpand(entry); });

    const details = state.showFileDetails && this.source.kind !== 's3';
    // A comparison in force colours the rows by verdict, which is the only
    // way a difference reads at a glance across two lists.
    const verdict = this.compare?.map.get(entry.name) || null;
    if (verdict) cls.push('cmp-' + verdict);
    const row = el('div', {
      class: cls.join(' ') + (details ? ' detailed' : ''),
      draggable: 'true',
      style: `padding-left:${8 + depth * 14}px`,
      title: [
        `${entry.modeString || ''}  ${entry.name}`,
        ownerText(entry) ? 'owner: ' + ownerText(entry) : null,
        // Only for files: a directory's link count is its subdirectory count
        // plus two, which is arithmetic rather than information.
        !dir && entry.links > 1 ? `${entry.links} hard links` : null,
      ].filter(Boolean).join('\n'),
      dataset: { path: entry.path },
    },
      twisty,
      el('span', { class: 'ficon', text: fileIcon(entry) }),
      el('span', { class: 'fname', text: entry.name }),
      // The details columns sit between the name and the size, in the order a
      // long listing puts them, so the two views read the same way.
      verdict && verdict !== 'same'
        ? el('span', {
            class: 'fcmp',
            title: {
              only: 'Only in this list',
              newer: 'Newer here than in the other list',
              older: 'Older here than in the other list',
              differs: 'Same timestamp, different size',
            }[verdict],
            text: { only: '＋', newer: '↑', older: '↓', differs: '≠' }[verdict] || '',
          })
        : null,
      details ? el('span', { class: 'fperm', text: entry.modeString || '' }) : null,
      details ? el('span', { class: 'fown', text: ownerText(entry) || '' }) : null,
      el('span', { class: 'fsize', text: dir ? '' : fmtBytes(entry.size) }),
      el('span', { class: 'fdate', text: fmtDate(entry.mtime) }));

    row.addEventListener('click', (e) => this._select(e, entry));
    row.addEventListener('dblclick', () => this.open(entry));
    row.addEventListener('dragstart', (ev) => {
      const sel = this.selected();
      const payload = sel.length && sel.some((s) => s.path === entry.path) ? sel : [entry];
      ev.dataTransfer.setData('application/x-serverlife', JSON.stringify({ from: this.id, entries: payload }));
      /*
       * Within one pane a drag is a move, between two it is a copy — and the
       * pointer should say which before the mouse is let go. The id is kept
       * here as well as in the payload because `dragover` is not allowed to
       * read the payload: the browser hides it until the drop, so the only
       * way to know where a drag started is to have written it down.
       */
      dragFrom = this.id;
      ev.dataTransfer.effectAllowed = 'copyMove';
      ev.dataTransfer.dropEffect = 'move';
    });
    return row;
  }

  _setStatus(text, isError) {
    clear(this.statusBar);
    this.statusBar.append(el('span', { class: isError ? 'err' : '', text: text || '' }));
  }

  /* ---------------- selection & navigation ---------------- */

  flat() {
    const view = this.view;
    const out = [];
    const walk = (entries) => {
      for (const e of sortEntries(this.visible(entries), this._sortOpts())) {
        out.push(e);
        if (isDir(e) && view.expanded.has(e.path)) {
          const kids = view.children.get(e.path);
          if (Array.isArray(kids)) walk(kids);
        }
      }
    };
    walk(view.entries);
    return out;
  }

  selected() {
    const view = this.view;
    return this.flat().filter((e) => view.selection.has(e.path));
  }

  _select(e, entry) {
    const view = this.view;
    const entries = this.flat();
    if (e.metaKey || e.ctrlKey) {
      view.selection.has(entry.path) ? view.selection.delete(entry.path) : view.selection.add(entry.path);
    } else if (e.shiftKey && this._lastClicked) {
      const a = entries.findIndex((x) => x.path === this._lastClicked);
      const b = entries.findIndex((x) => x.path === entry.path);
      if (a >= 0 && b >= 0) {
        view.selection.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) view.selection.add(entries[i].path);
      }
    } else {
      view.selection.clear();
      view.selection.add(entry.path);
    }
    this._lastClicked = entry.path;
    this.render();
  }

  async toggleExpand(entry) {
    const view = this.view;
    if (view.expanded.has(entry.path)) {
      view.expanded.delete(entry.path);
      this.render();
      return;
    }
    view.expanded.add(entry.path);
    if (view.children.has(entry.path)) { this.render(); return; }
    view.loadingPaths.add(entry.path);
    this.render();
    try { view.children.set(entry.path, (await this._list(entry.path)).entries); }
    catch { view.children.set(entry.path, null); }
    finally { view.loadingPaths.delete(entry.path); this.render(); }
  }

  collapseAll() {
    this.view.expanded.clear();
    this.view.children.clear();
    this.render();
  }

  async open(entry) {
    if (isDir(entry)) return this.navigate(entry.path);
    if (this.source.kind === 'local') return window.api.local.open(entry.path);
    if (entry.size > 2 * 1024 * 1024) return this.download([entry]);
    return this.edit(entry);
  }

  /**
   * Move the selection one row, over what is actually on screen.
   *
   * `flat()` is already filtered, so with a name filter in force this steps
   * from match to match — which is what makes the arrow keys useful from inside
   * the filter box. Shared with the list's own arrow keys so both behave alike.
   */
  _moveSelection(delta) {
    const view = this.view;
    const flat = this.flat();
    if (!flat.length) return;
    const sel = this.selected();
    const cur = sel.length === 1 ? flat.findIndex((x) => x.path === sel[0].path) : -1;
    // From nothing, down lands on the first row and up on the last.
    const next = cur === -1
      ? (delta > 0 ? flat[0] : flat[flat.length - 1])
      : flat[Math.max(0, Math.min(flat.length - 1, cur + delta))];
    if (!next) return;
    view.selection = new Set([next.path]);
    this._lastClicked = next.path;
    this.render();
    this.list.querySelector(`.frow[data-path="${CSS.escape(next.path)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  _onKey(e) {
    const view = this.view;
    const sel = this.selected();
    const flat = this.flat();

    if ((e.key === 'Delete' || e.key === 'Backspace') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); this.remove(sel); return;
    }
    if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      view.selection = new Set(flat.map((x) => x.path));
      this.render(); return;
    }
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.focusFilter(); return; }
    if (e.key === 'Escape' && this.filter) { e.preventDefault(); this.clearFilter(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); this.goParent(); return; }
    if (e.key === 'Enter') { if (sel.length === 1) this.open(sel[0]); return; }

    /*
     * Type-ahead: a printable character with the list focused starts filtering,
     * the way a file list has worked since before there were file managers.
     * It is also how anyone finds the filter box without reading about it.
     */
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
      e.preventDefault();
      this.focusFilter(this.filter + e.key);
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'ArrowRight' && sel.length === 1 && isDir(sel[0]) && !view.expanded.has(sel[0].path)) {
      e.preventDefault(); this.toggleExpand(sel[0]);
    } else if (e.key === 'ArrowLeft' && sel.length === 1 && isDir(sel[0]) && view.expanded.has(sel[0].path)) {
      e.preventDefault(); this.toggleExpand(sel[0]);
    }
  }

  /* ---------------- drag & drop ---------------- */

  _setupDrop() {
    let depth = 0;
    /*
     * The whole pane takes a drop, not just the list of rows.
     *
     * A drag that lands on the path bar, the toolbar, the status line or the
     * empty space under a short listing used to be refused silently — and
     * "nothing happened" is indistinguishable from "this is not allowed", so
     * it reads as the feature being broken. The row under the pointer still
     * decides the destination folder when there is one; everywhere else in the
     * pane means the directory it is showing.
     */
    const node = this.element;
    node.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; node.classList.add('dragover'); });
    node.addEventListener('dragleave', (e) => {
      // Moving between children fires leave on the one being left; only a
      // pointer that has actually left the pane should clear the highlight.
      if (node.contains(e.relatedTarget)) return;
      if (--depth <= 0) { depth = 0; node.classList.remove('dragover'); }
    });
    node.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = dragFrom === this.id ? 'move' : 'copy';
    });
    node.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      node.classList.remove('dragover');

      const row = e.target.closest?.('.frow');
      const dropped = row?.dataset.path ? this.flat().find((x) => x.path === row.dataset.path) : null;
      const destDir = dropped
        ? (isDir(dropped) ? dropped.path
          : (this.source.kind === 'local' ? parentLocal(dropped.path) : posix.parent(dropped.path)))
        : this.view.path;
      /*
       * A bucket's root prefix is the empty string, which is a perfectly good
       * destination — so only a genuinely absent path is a reason to stop.
       */
      if (destDir === null || destDir === undefined) return;
      if (this.source.kind !== 's3' && !destDir) return;

      // Files dragged in from Finder
      if (e.dataTransfer.files?.length) {
        const paths = [...e.dataTransfer.files].map((f) => window.api.files.pathFor(f)).filter(Boolean);
        if (!paths.length) return;
        if (this.source.kind === 'remote') uploadTo(this.connId, paths, destDir);
        else if (this.source.kind === 'kube') this._kubeUpload(paths, destDir);
        else if (this.source.kind === 's3') {
          const cls = await pickStorageClass(this.s3Target);
          if (cls) {
            await runS3(this, `Uploading ${paths.length} file(s)`, async () => {
              const r = await window.api.s3.upload(this.s3Id, paths, destDir || '', { storageClass: cls });
              return `Uploaded ${r.uploaded.length} file(s) as ${r.storageClass}`;
            });
          }
        } else toast('Those files are already on this machine', 'info');
        return;
      }

      const raw = e.dataTransfer.getData('application/x-serverlife');
      if (!raw) return;
      const { from, entries } = JSON.parse(raw);
      if (from === this.id) { await this.moveInto(entries, destDir); return; }
      const src = explorers.get(from);
      if (!src) return;

      // A bucket at either end is routed separately: S3 is not a filesystem,
      // so there is no path that both sides understand.
      if (src.source.kind === 's3' || this.source.kind === 's3') {
        await s3Transfer(src, this, entries, destDir);
        return;
      }
      // A pod has no scp/rsync-like primitive to relay through, the way
      // crossCopy does for two remote sessions — kube-to-kube is out of
      // scope for the same reason. Local-to-kube and kube-to-local are not:
      // that is exactly what kubectl cp is for.
      if (src.source.kind === 'kube' && this.source.kind === 'kube') {
        toast('Copying straight between two pods isn’t supported yet — download, then upload', 'error');
        return;
      }

      if (src.source.kind === 'local' && this.source.kind === 'remote') {
        uploadTo(this.connId, entries.map((x) => x.path), destDir);
      } else if (src.source.kind === 'remote' && this.source.kind === 'local') {
        downloadTo(src.connId, entries, destDir);
      } else if (src.source.kind === 'remote' && this.source.kind === 'remote') {
        if (src.connId === this.connId) { toast('Both panes are the same server', 'info'); return; }
        crossCopy(src.connId, entries, this.connId, destDir);
      } else if (src.source.kind === 'local' && this.source.kind === 'kube') {
        this._kubeUpload(entries.map((x) => x.path), destDir);
      } else if (src.source.kind === 'kube' && this.source.kind === 'local') {
        src._kubeDownload(entries, destDir);
      }
    });
  }

  /* ---------------- mutations ---------------- */

  async makeDir(targetDir) {
    const dir = targetDir || this.view.path;
    if (!dir) return;
    const name = await prompt({ title: 'New folder', label: `Folder name in ${dir}`, confirmLabel: 'Create' });
    if (!name) return;
    try {
      const target = dir.replace(/\/$/, '') + '/' + name;
      if (this.source.kind === 'local') await window.api.local.mkdir(target);
      else if (this.source.kind === 'kube') {
        const r = await window.api.kube.mkdir({ spec: this.source.kubeSpec, dir: target });
        if (!r.ok) throw new Error(r.error || 'mkdir failed');
      } else await window.api.sftp.mkdir(this.connId, target);
      await this.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  /**
   * Move entries into another folder of the same pane.
   *
   * Dragging within one list did nothing at all — the drop handler saw the
   * drag had come from itself and returned — so the obvious way to put a
   * file in a subfolder was the one way that was not available: you dragged,
   * nothing happened, and it read as the feature being broken rather than
   * absent.
   *
   * It is a rename underneath, which is what makes it worth doing: on the
   * same filesystem nothing is copied and nothing is at risk, however large
   * the folder. Two guards earn their place. A folder cannot be dropped into
   * itself or into anything beneath it — the filesystem would either refuse
   * or, worse, oblige and lose the subtree. And an existing name at the
   * destination stops the move rather than overwriting it: a drag is an easy
   * gesture to make by accident, and silently replacing a directory with
   * another of the same name is not something to find out about afterwards.
   */
  async moveInto(entries, destDir) {
    const local = this.source.kind === 'local';
    if (this.source.kind === 's3') {
      return toast('A bucket has no rename: copy the objects and delete the originals', 'error', 7000);
    }
    const dest = String(destDir || '').replace(/\/+$/, '') || (local ? destDir : '/');
    const parentOf = (x) => (local ? parentLocal(x) : posix.parent(x));
    const join = (dir, name) => (local ? `${dir}/${name}` : posix.join(dir, name));

    const moving = (entries || []).filter((x) => x?.path && parentOf(x.path) !== dest);
    if (!moving.length) return;

    // A folder cannot contain itself. `path + '/'` so a sibling whose name
    // merely starts the same way — /srv/app and /srv/apple — is not caught.
    const inside = moving.find((x) => dest === x.path || dest.startsWith(x.path.replace(/\/+$/, '') + '/'));
    if (inside) {
      return toast(`${inside.name} cannot be moved inside itself`, 'error');
    }

    // Names already taken at the destination, asked about before anything moves.
    const here = new Set();
    try {
      const listing = local
        ? await window.api.local.list(dest)
        : this.source.kind === 'kube'
          ? await window.api.kube.ls({ spec: this.source.kubeSpec, dir: dest })
          : await window.api.sftp.list(this.connId, dest);
      for (const x of (listing?.entries || listing || [])) here.add(x.name);
    } catch { /* unreadable: let the rename itself be the judge */ }
    const clash = moving.filter((x) => here.has(x.name));
    if (clash.length) {
      return toast(clash.length === 1
        ? `${clash[0].name} is already in that folder`
        : `${clash.length} of those names are already in that folder`, 'error', 7000);
    }

    let done = 0;
    for (const x of moving) {
      try {
        const to = join(dest, x.name);
        if (local) await window.api.local.rename(x.path, to);
        else if (this.source.kind === 'kube') {
          const r = await window.api.kube.rename({ spec: this.source.kubeSpec, from: x.path, to });
          if (!r.ok) throw new Error(r.error || 'rename failed');
        } else await window.api.sftp.rename(this.connId, x.path, to);
        done++;
      } catch (e) {
        toast(`${x.name}: ${e.message}`, 'error', 8000);
        break;
      }
    }
    if (done) {
      status(done === 1 ? `Moved ${moving[0].name} to ${dest}` : `Moved ${done} items to ${dest}`);
      // The paths just moved; a selection still pointing at them is stale.
      this.view.selection.clear();
      await this.refresh();
    }
  }

  async rename(entry) {
    const name = await prompt({ title: 'Rename', label: 'New name', value: entry.name, confirmLabel: 'Rename' });
    if (!name || name === entry.name) return;
    try {
      if (this.source.kind === 'local') {
        await window.api.local.rename(entry.path, parentLocal(entry.path) + '/' + name);
      } else if (this.source.kind === 'kube') {
        const to = posix.join(posix.parent(entry.path), name);
        const r = await window.api.kube.rename({ spec: this.source.kubeSpec, from: entry.path, to });
        if (!r.ok) throw new Error(r.error || 'rename failed');
      } else {
        await window.api.sftp.rename(this.connId, entry.path, posix.join(posix.parent(entry.path), name));
      }
      await this.refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async remove(entries) {
    if (!entries.length) return;
    const local = this.source.kind === 'local';
    const ok = await confirm({
      title: local ? 'Delete local items' : 'Delete remote items',
      message: entries.length === 1 ? `Delete “${entries[0].name}”?` : `Delete ${entries.length} items?`,
      detail: entries.slice(0, 12).map((e) => e.path).join('\n')
        + (entries.length > 12 ? `\n… and ${entries.length - 12} more` : '')
        + '\n\nDirectories are removed recursively. This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      if (local) await window.api.local.remove(entries.map((e) => e.path));
      else if (this.source.kind === 'kube') {
        for (const e of entries) {
          const r = await window.api.kube.rm({ spec: this.source.kubeSpec, target: e.path });
          if (!r.ok) throw new Error(r.error || `Could not delete ${e.name}`);
        }
      } else await window.api.sftp.remove(this.connId, entries.map((e) => ({ path: e.path, type: e.type, targetType: e.targetType })));
      await this.refresh();
      status(`Deleted ${entries.length} item(s)`);
    } catch (e) { toast(e.message, 'error'); }
  }

  /**
   * Permissions and ownership, for one entry or a selection.
   *
   * Three things that are one job: the mode, the owner and the group are what
   * you change after copying a tree into place, and changing them one file at
   * a time through three dialogs is the reason people drop to a shell.
   *
   * A single mode on a single file goes through SFTP, which needs nothing but
   * the connection already open. Anything else — recursion, an owner, a group
   * — is `chmod`/`chown` over the session, because SFTP has no recursive form
   * and no notion of user names at all. The command is shown before it runs.
   */
  async permissions(entries) {
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (!list.length) return;
    const one = list.length === 1 ? list[0] : null;
    const anyDir = list.some((e) => isDir(e));

    const modeIn = textInput({
      value: one ? (one.mode & 0o7777).toString(8).padStart(3, '0') : '',
      placeholder: '755',
    });
    modeIn.style.width = '110px';
    const ownerIn = textInput({ value: one?.owner || '', placeholder: 'leave blank to keep' });
    const groupIn = textInput({ value: one?.group || '', placeholder: 'leave blank to keep' });
    const recurseIn = checkbox(
      anyDir ? 'Apply to everything inside as well' : 'Apply recursively',
      false);
    const preview = el('div', { class: 'info-v', style: 'white-space:pre-wrap;font-size:11.5px' });

    const paths = list.map((e) => shq(e.path));
    const cmds = () => {
      const R = recurseIn.input.checked ? ' -R' : '';
      const out = [];
      const mode = modeIn.value.trim();
      if (mode) out.push(`chmod${R} ${mode} ${paths.join(' ')}`);
      const owner = ownerIn.value.trim();
      const group = groupIn.value.trim();
      // `chown user:group` does both in one call; a group on its own is chgrp.
      if (owner) out.push(`chown${R} ${owner}${group ? ':' + group : ''} ${paths.join(' ')}`);
      else if (group) out.push(`chgrp${R} ${group} ${paths.join(' ')}`);
      return out;
    };
    const sync = () => {
      const out = cmds();
      preview.textContent = out.length ? out.join('\n') : 'Nothing to change yet.';
    };
    for (const f of [modeIn, ownerIn, groupIn]) f.addEventListener('input', sync);
    recurseIn.input.addEventListener('change', sync);
    sync();

    const go = await modal({
      title: 'Permissions and owner',
      subtitle: one ? one.path : `${list.length} items`,
      width: 'min(620px, 94vw)',
      render: (body) => {
        body.append(
          field('Mode (octal)', modeIn, one
            ? `Currently ${one.modeString || ''} — blank leaves it alone.`
            : 'Blank leaves every selected item as it is.'),
          el('div', { class: 'field-row' },
            field('Owner', ownerIn),
            field('Group', groupIn)),
          recurseIn,
          el('div', { class: 'hint', style: 'margin-top:10px' }, 'Runs on the host:'),
          preview,
          el('div', { class: 'hint', style: 'margin-top:8px' },
            'Changing an owner normally needs root, so this may come back with '
            + '"Operation not permitted" — that is the host refusing, not a failure to ask.'));
      },
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Apply', class: 'primary-btn', value: true },
      ],
    });
    if (!go) return;

    const out = cmds();
    if (!out.length) return;
    const mode = modeIn.value.trim();

    // The one case that needs no shell at all.
    if (out.length === 1 && mode && !recurseIn.input.checked && one) {
      try {
        await window.api.sftp.chmod(this.connId, one.path, parseInt(mode, 8));
        status(`Set ${mode} on ${one.name}`);
        await this.refresh();
      } catch (e) { toast(e.message, 'error'); }
      return;
    }

    status('Applying…', 0);
    try {
      // `2>&1` and a join: one round trip, and a refusal on the chown is
      // reported rather than hidden behind a successful chmod.
      const res = await window.api.conn.exec(this.connId, out.join(' && echo __ok__; ') + ' && echo __ok__');
      const text = String(res || '').replace(/__ok__/g, '').trim();
      if (text) toast(text.split('\n').slice(0, 4).join('\n'), 'error', 9000);
      else status(`Applied to ${one ? one.name : list.length + ' items'}`);
      await this.refresh();
    } catch (e) {
      toast(e.message, 'error', 9000);
    } finally { status(''); }
  }

  /**
   * A local file in the app's own editor.
   *
   * The same dialog `edit` gives a remote file, over the local filesystem
   * instead of SFTP — a `.log` or a `.conf` is something you read here rather
   * than something to hand to whichever application claims the extension.
   *
   * Whether the file is text at all, and whether it is small enough, is
   * settled in the main process: a textarea handed a binary is a hung window
   * and a mangled file if it is then saved.
   */
  async editLocal(entry) {
    let read;
    try { read = await window.api.local.readText(entry.path); }
    catch (e) { return toast(e.message, 'error'); }

    const area = el('textarea', {
      style: 'width:100%;height:52vh;font-family:var(--mono);font-size:12px;line-height:1.45',
      spellcheck: 'false',
    });
    area.value = read.text;

    await modal({
      title: entry.name, subtitle: entry.path, width: 'min(920px, 94vw)',
      render: (body) => { body.append(area); },
      buttons: [
        { label: 'Close', value: false },
        {
          label: 'Save', class: 'primary-btn',
          onClick: async ({ close }) => {
            try {
              await window.api.local.writeText(entry.path, area.value);
              status('Saved ' + entry.name);
              close(true);
              this.refresh();
            } catch (e) { toast(e.message, 'error'); }
          },
        },
      ],
    });
  }

  async edit(entry) {
    const kube = this.source.kind === 'kube';
    let content;
    try {
      content = kube
        ? textFromB64(await this._kubeReadOrThrow(entry.path))
        : await window.api.sftp.readFile(this.connId, entry.path);
    } catch (e) { return toast(e.message, 'error'); }

    const area = el('textarea', {
      style: 'width:100%;height:52vh;font-family:var(--mono);font-size:12px;line-height:1.45',
      spellcheck: 'false',
    });
    area.value = content;
    const connId = this.connId;
    const kubeSpec = this.source.kubeSpec;

    await modal({
      title: entry.name, subtitle: entry.path, width: 'min(920px, 94vw)',
      render: (body) => { body.append(area); },
      buttons: [
        { label: 'Close', value: false },
        {
          label: 'Save', class: 'primary-btn',
          onClick: async ({ close }) => {
            try {
              if (kube) {
                const r = await window.api.kube.writeFile({ spec: kubeSpec, path: entry.path, data: b64FromText(area.value) });
                if (!r.ok) throw new Error(r.error || 'kubectl cp failed');
              } else {
                await window.api.sftp.writeFile(connId, entry.path, area.value);
              }
              status('Saved ' + entry.name);
              close(true);
              this.refresh();
            } catch (e) { toast(e.message, 'error'); }
          },
        },
      ],
    });
  }

  async _kubeReadOrThrow(path) {
    const r = await window.api.kube.readFile({ spec: this.source.kubeSpec, path });
    if (!r.ok) throw new Error(r.error || 'kubectl cp failed');
    return r.data;
  }

  download(entries, localDir) {
    if (this.source.kind === 'kube') return this._kubeDownload(entries, localDir);
    return downloadTo(this.connId, entries, localDir);
  }

  /**
   * Straight `kubectl cp` per entry, straight to a real local path — no
   * transfer queue (that machinery is keyed by a Connection's id, and a
   * kube exec pane has none, by design: see openPodExec in kubepanel.js),
   * so no pause/resume/speed-cap here, just "it either copied or it told
   * you why not."
   */
  async _kubeDownload(entries, localDir) {
    let dir = localDir;
    if (!dir) {
      dir = await window.api.dialog.chooseDir();
      if (!dir) return;
    }
    status(`Downloading ${entries.length} item(s) → ${dir}`);
    for (const e of entries) {
      const dest = dir.replace(/\/+$/, '') + '/' + e.name;
      const r = await window.api.kube.downloadPath({ spec: this.source.kubeSpec, remotePath: e.path, localPath: dest });
      if (!r.ok) return toast(`${e.name}: ${r.error || 'download failed'}`, 'error');
    }
    status(`Downloaded ${entries.length} item(s) → ${dir}`);
  }

  async _kubeUpload(localPaths, remoteDir) {
    status(`Uploading ${localPaths.length} item(s) → ${remoteDir}`);
    for (const p of localPaths) {
      const name = p.replace(/\/+$/, '').split('/').pop();
      const dest = remoteDir.replace(/\/+$/, '') + '/' + name;
      const r = await window.api.kube.uploadPath({ spec: this.source.kubeSpec, localPath: p, remotePath: dest });
      if (!r.ok) { toast(`${name}: ${r.error || 'upload failed'}`, 'error'); return; }
    }
    status(`Uploaded ${localPaths.length} item(s) → ${remoteDir}`);
    this.refresh();
  }

  /* ---------------- compare, sync, watch ---------------- */

  /**
   * The other explorer to work against.
   *
   * Compare and sync are both "this pane versus that one", and which one
   * *that* is has an obvious answer nearly always: the local list stacked
   * under this pane, or the only other one on screen. It is only asked when
   * the answer is genuinely ambiguous.
   */
  async _otherPane({ needLocal = false } = {}) {
    const pane = this.paneId ? state.getPane(this.paneId) : null;
    const companion = pane?.localExplorer && pane.localExplorer !== this ? pane.localExplorer : null;
    const mine = this;
    const candidates = [...explorers.values()].filter((e) => e !== mine
      && e.element.isConnected
      && (!needLocal || e.source.kind === 'local')
      && e.source.kind !== 's3' && e.source.kind !== 'kube');

    if (companion && (!needLocal || companion.source.kind === 'local')) return companion;
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) {
      toast(needLocal
        ? 'Open the local file list first (the 💻 button)'
        : 'Open a second file list to compare against', 'error');
      return null;
    }

    return modal({
      title: 'Which list?',
      subtitle: 'Compare and sync work between two file lists',
      render: (body, { close }) => {
        const list = el('div', { class: 'picker-list' });
        for (const e of candidates) {
          const conn = e.connId ? state.getConnection(e.connId) : null;
          list.append(el('div', { class: 'picker-item', onClick: () => close(e) },
            el('span', { class: 'pname' },
              el('div', { text: e.source.kind === 'local' ? 'This machine' : (conn?.label || 'Session') }),
              el('div', { class: 'pmeta', text: e.view.path || '' }))));
        }
        body.append(list);
      },
      buttons: [{ label: 'Cancel', value: null }],
    });
  }

  /**
   * Mark what differs between this list and another, in place.
   *
   * Non-recursive and instant: both listings are already loaded, so this is
   * arithmetic on what is on screen rather than a walk of two trees. It
   * answers "did that copy land" and "which of these two is ahead", which is
   * what the question usually is when two panes are open side by side.
   */
  async compareWith() {
    const other = await this._otherPane();
    if (!other) return;

    const mine = new Map(this.view.entries.map((e) => [e.name, e]));
    const theirs = new Map(other.view.entries.map((e) => [e.name, e]));
    const verdict = (a, b) => {
      if (!b) return 'only';
      if (isDir(a) || isDir(b)) return 'same';          // a folder is a folder
      if (a.size === b.size && Math.abs((a.mtime || 0) - (b.mtime || 0)) <= 2000) return 'same';
      if ((a.mtime || 0) > (b.mtime || 0) + 2000) return 'newer';
      if ((b.mtime || 0) > (a.mtime || 0) + 2000) return 'older';
      return 'differs';
    };

    const mark = (exp, from, against) => {
      const map = new Map();
      for (const [name, entry] of from) map.set(name, verdict(entry, against.get(name)));
      exp.compare = { map, against: other === exp ? this : other };
      // The toolbar has to agree with the state: its button becomes "clear".
      exp._syncToggles();
      exp.render();
    };
    mark(this, mine, theirs);
    mark(other, theirs, mine);

    const counts = (map) => [...map.values()].reduce((a, v) => (a[v] = (a[v] || 0) + 1, a), {});
    const c = counts(this.compare.map);
    this._setStatus(`Compared: ${c.same || 0} identical · ${c.newer || 0} newer here · `
      + `${c.older || 0} newer there · ${c.only || 0} only here`);
    status('Comparing — the ✕ on the pane header clears it', 7000);
  }

  clearCompare({ both = true } = {}) {
    const other = this.compare?.against;
    this.compare = null;
    this._syncToggles();
    this.render();
    if (both && other && other.compare) other.clearCompare({ both: false });
  }

  /**
   * Synchronise this directory with the other pane's, after showing the work.
   *
   * The plan is computed in the main process — two recursive walks and a
   * comparison — and every line of it is a checkbox here. Nothing moves until
   * the plan has been looked at, which is the entire point of the feature.
   */
  async syncWith() {
    if (this.source.kind === 's3' || this.source.kind === 'kube') return toast('Sync works between a server and this machine', 'error');
    const other = await this._otherPane();
    if (!other) return;

    const localSide = this.source.kind === 'local' ? this : (other.source.kind === 'local' ? other : null);
    const remoteSide = this.source.kind === 'remote' ? this : (other.source.kind === 'remote' ? other : null);
    if (!localSide || !remoteSide) {
      return toast('Sync needs one local list and one server list', 'error');
    }
    if (!localSide.view.path || !remoteSide.view.path) return toast('Both lists need a folder open', 'error');

    return openSyncDialog({
      connId: remoteSide.connId,
      localDir: localSide.view.path,
      remoteDir: remoteSide.view.path,
      onDone: () => { localSide.refresh(); remoteSide.refresh(); },
    });
  }

  /** Mirror a local folder onto the server as it changes. */
  async keepUpToDate() {
    if (this.source.kind !== 'remote') {
      return toast('Open this on the server side — it watches a local folder and uploads to here', 'error');
    }
    const other = await this._otherPane({ needLocal: true });
    if (!other) return;
    const localDir = other.view.path;
    const remoteDir = this.view.path;
    if (!localDir || !remoteDir) return toast('Both lists need a folder open', 'error');

    const ok = await confirm({
      title: 'Keep the server up to date',
      message: `Upload changes in ${localDir} to ${remoteDir} as they are saved?`,
      detail: 'Files are uploaded when they change, including new ones. Nothing is ever deleted '
        + 'on the server, and nothing is downloaded. Version control directories, node_modules '
        + 'and editor scratch files are ignored.\n\nIt keeps running until you stop it in the Watch panel.',
      confirmLabel: 'Start watching',
    });
    if (!ok) return;
    try {
      await window.api.watch.dir(this.connId, { localDir, remoteDir });
      const { openDock } = await import('./dock.js');
      openDock('watch');
      status(`Watching ${localDir} → ${remoteDir}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  /** Open a remote file in the editor this machine (or the user) prefers. */
  async editExternally(entry) {
    if (this.source.kind !== 'remote') return;
    status(`Fetching ${entry.name}…`, 0);
    try {
      const w = await window.api.watch.edit(this.connId, entry.path);
      const { openDock } = await import('./dock.js');
      openDock('watch');
      if (w.openError) {
        toast(`Saved to ${w.localPath} — could not open an editor: ${w.openError}`, 'error', 9000);
      } else {
        status(`${entry.name} is open — every save goes back to the server`, 9000);
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally { status(''); }
  }

  /* ---------------- info ---------------- */

  /**
   * What this folder (or file) is: type, permissions, owner, timestamps and
   * what it holds. The recursive total sits behind a button — adding up a deep
   * tree is a real walk of the filesystem, and doing it unasked would make
   * every right-click expensive.
   */
  async info(entry) {
    const folder = isDir(entry);
    const rows = el('div', { class: 'info-grid' });
    const total = el('div', { class: 'hint', style: 'margin-top:10px' });
    const actions = el('div', { style: 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap' });
    const help = el('div', { class: 'perm-help hidden' });
    const body = el('div', {}, rows, total, actions, help);

    const put = (label, value) => {
      if (value === null || value === undefined || value === '') return;
      rows.append(el('div', { class: 'info-k', text: label }),
        el('div', { class: 'info-v', text: String(value) }));
    };

    /*
     * What the loaders found out about the mode, so the explainer can be built
     * from the same numbers the Permissions row was printed from rather than
     * parsing that row back out of the DOM.
     */
    const perms = {};

    put('Path', entry.path);
    total.textContent = 'Reading…';

    // Fill the dialog while it is already on screen: a stat over a slow link
    // should not leave the user looking at nothing.
    const load = (async () => {
      try {
        const sizeUp = this.source.kind === 's3' ? await this._s3Info(entry, put, total)
          : this.source.kind === 'local' ? await this._localInfo(entry, put, total, perms)
          : await this._remoteInfo(entry, put, total, perms);
        if (sizeUp) {
          actions.append(el('button', {
            class: 'ghost-btn', text: 'Calculate total size',
            onClick: (e) => { e.target.disabled = true; sizeUp(); },
          }));
        }
        // Nine letters that decide whether anything works, in a notation that
        // explains itself to nobody. The reading is offered rather than shown:
        // most visits to this dialog are about size or dates.
        if (perms.modeString) {
          const btn = el('button', {
            class: 'ghost-btn', text: 'What do these permissions mean?',
            onClick: () => {
              const showing = !help.classList.contains('hidden');
              if (!showing) {
                clear(help);
                help.append(explainPermissions({ ...perms, folder }));
              }
              help.classList.toggle('hidden', showing);
              btn.textContent = showing
                ? 'What do these permissions mean?'
                : 'Hide the explanation';
            },
          });
          actions.append(btn);
        }
      } catch (e) {
        total.textContent = '';
        body.append(el('div', { style: 'color:var(--red);font-size:12px', text: e.message }));
      }
    })();

    await modal({
      title: entry.name || entry.path,
      subtitle: folder ? 'Folder' : 'File',
      width: 'min(560px, 94vw)',
      render: (b) => { b.append(body); },
      buttons: [
        {
          label: 'Copy',
          onClick: () => {
            const text = [...rows.children]
              .reduce((acc, node, i) => (i % 2 ? acc + node.textContent + '\n' : acc + node.textContent + ': '), '')
              + (total.textContent ? total.textContent + '\n' : '');
            window.api.clipboard.write(text);
            status('Copied');
          },
        },
        { label: 'Close', class: 'primary-btn', value: true },
      ],
    });
    await load.catch(() => {});
  }

  async _localInfo(entry, put, total, perms = {}) {
    const d = await window.api.local.info(entry.path);
    Object.assign(perms, {
      mode: d.mode, modeString: d.modeString, owner: d.owner || (d.uid ?? null), group: d.group || (d.gid ?? null),
    });
    put('Type', d.type + (d.target ? ' → ' + d.target : ''));
    put('Size', fmtBytes(d.size) + (d.size >= 1024 ? ` (${d.size.toLocaleString()} bytes)` : ''));
    put('Permissions', permText(d));
    put('Owner', ownerText(d) + (d.owner || d.group ? ` (uid ${d.uid}, gid ${d.gid})` : ''));
    put('Modified', fmtDate(d.mtime));
    put('Accessed', d.atime ? fmtDate(d.atime) : null);
    put('Changed', d.ctime ? fmtDate(d.ctime) : null);
    put('Created', d.birthtime ? fmtDate(d.birthtime) : null);
    put('Links', d.links);
    if (d.files !== null) put('Contains', `${d.files} file(s), ${d.dirs} folder(s) directly inside`);
    total.textContent = d.type === 'directory' ? 'Total size not calculated yet.' : '';
    if (d.type !== 'directory') return null;

    return async () => {
      total.textContent = 'Adding up…';
      try {
        const t = await window.api.local.treeSize(entry.path);
        total.textContent = `${fmtBytes(t.bytes)} in ${t.files.toLocaleString()} file(s)`
          + ` across ${t.dirs.toLocaleString()} folder(s)${t.truncated ? ' — stopped early, this is a floor' : ''}`;
      } catch (e) { total.textContent = e.message; }
    };
  }

  /**
   * One `stat` over the connection that is already open. GNU and BSD stat take
   * different format flags, so the command tries GNU first and falls back —
   * which covers Linux, the BSDs and macOS without asking which is which.
   */
  async _remoteInfo(entry, put, total, perms = {}) {
    const q = shq(entry.path);
    const cmd =
      `{ stat -c 'kind=%F\nsize=%s\nmode=%A\noct=%a\nowner=%U\ngroup=%G\nmtime=%Y\natime=%X\ninode=%i\nlinks=%h' ${q} 2>/dev/null`
      + ` || stat -f 'kind=%HT\nsize=%z\nmode=%Sp\noct=%Lp\nowner=%Su\ngroup=%Sg\nmtime=%m\natime=%a\ninode=%i\nlinks=%l' ${q}; }; `
      + `[ -L ${q} ] && echo "link=$(readlink ${q} 2>/dev/null)"; `
      + `if [ -d ${q} ]; then `
      + `echo "files=$(find ${q} -maxdepth 1 -mindepth 1 ! -type d 2>/dev/null | wc -l)"; `
      + `echo "dirs=$(find ${q} -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)"; `
      + `echo "fs=$(df -Pk ${q} 2>/dev/null | tail -1 | awk '{print $1" "$5" used, "$4"K free"}')"; fi`;

    const out = await window.api.conn.exec(this.connId, cmd);
    const d = parseKv(out);
    put('Type', d.kind + (d.link ? ' → ' + d.link : ''));
    if (d.size) put('Size', fmtBytes(Number(d.size)) + ` (${Number(d.size).toLocaleString()} bytes)`);
    Object.assign(perms, {
      mode: parseInt(d.oct || '0', 8), modeString: d.mode || entry.modeString,
      owner: d.owner || null, group: d.group || null,
    });
    put('Permissions', permText({ modeString: d.mode, mode: parseInt(d.oct || '0', 8) }));
    put('Owner', [d.owner, d.group].filter(Boolean).join(':'));
    if (d.mtime) put('Modified', fmtDate(Number(d.mtime) * 1000));
    if (d.atime && Number(d.atime)) put('Accessed', fmtDate(Number(d.atime) * 1000));
    put('Links', d.links);
    put('Inode', d.inode);
    if (d.files !== undefined) put('Contains', `${d.files} file(s), ${d.dirs} folder(s) directly inside`);
    put('Filesystem', d.fs);

    if (!isDir(entry)) { total.textContent = ''; return null; }
    total.textContent = 'Total size not calculated yet — it runs du on the host.';
    return async () => {
      total.textContent = 'Running du…';
      try {
        const r = await window.api.conn.exec(this.connId,
          `du -sk ${q} 2>/dev/null | awk '{print $1}'; find ${q} 2>/dev/null | wc -l`);
        const [kb, count] = r.trim().split('\n');
        total.textContent = `${fmtBytes(Number(kb) * 1024)} in ${Number(count).toLocaleString()} entries`;
      } catch (e) { total.textContent = e.message; }
    };
  }

  /** A prefix is not a directory — what it holds has to be counted. */
  async _s3Info(entry, put, total) {
    const id = this.source.s3Id;
    if (!isDir(entry)) {
      const h = await window.api.s3.head(id, entry.path);
      put('Key', entry.path);
      put('Size', fmtBytes(h.size ?? entry.size) + ` (${Number(h.size ?? entry.size).toLocaleString()} bytes)`);
      put('Storage class', h.storageClass || entry.storageClass || 'STANDARD');
      put('Modified', fmtDate(h.mtime || entry.mtime));
      put('ETag', h.etag || null);
      put('Content type', h.contentType || null);
      total.textContent = '';
      return null;
    }
    total.textContent = 'Counting objects under this prefix…';
    const d = await window.api.s3.prefixInfo(id, entry.path);
    put('Prefix', d.prefix);
    put('Objects', d.objects.toLocaleString() + (d.truncated ? ' (stopped early)' : ''));
    put('Size', fmtBytes(d.bytes) + ` (${d.bytes.toLocaleString()} bytes)`);
    if (d.classes.length) put('Storage classes', d.classes.map(([c, n]) => `${c} × ${n}`).join(', '));
    if (d.newest) put('Newest object', fmtDate(d.newest));
    if (d.oldest) put('Oldest object', fmtDate(d.oldest));
    total.textContent = '';
    return null;
  }

  /* ---------------- S3 ---------------- */

  /**
   * A bucket supports a smaller set of things than a filesystem: no
   * permissions, no symlinks, no rename in place. Offering only what works
   * beats offering everything and failing.
   */
  _s3ContextMenu(e, entry, sel) {
    const files = sel.filter((x) => !isDir(x));
    const items = [
      entry && isDir(entry) ? { label: 'Open', onClick: () => this.navigate(entry.path) } : null,
      files.length ? {
        label: `Download${files.length > 1 ? ' ' + files.length + ' items' : ''}…`,
        onClick: () => this._s3Download(files),
      } : null,
      files.length ? {
        label: 'Copy to another pane…',
        onClick: () => this._s3CopyToPane(files),
      } : null,
      { label: 'Upload files here…', onClick: () => this._s3Upload() },
      { sep: true },
      entry ? {
        label: 'Copy key',
        onClick: () => { window.api.clipboard.write(entry.path); status('Copied ' + entry.path); },
      } : null,
      files.length === 1 ? {
        label: 'Change storage class…',
        onClick: () => this._s3Retier(files[0]),
      } : null,
      sel.length ? {
        label: `Delete${sel.length > 1 ? ' ' + sel.length + ' items' : ''}`,
        onClick: () => this._s3Delete(sel),
      } : null,
      { sep: true },
      entry ? { label: 'Get info', onClick: () => this.info(entry) } : null,
      { label: 'Refresh', onClick: () => this.refresh() },
    ];
    contextMenu(e.clientX, e.clientY, items.filter(Boolean));
  }

  /**
   * The same transfers the drag does, from a menu — dragging between two
   * panes is precise work, and copying a key out of a bucket should not need it.
   */
  async _s3CopyToPane(files) {
    const others = [...explorers.values()].filter((e) => e !== this && e.element.isConnected);
    if (!others.length) return toast('Open another file pane first', 'error');

    const chosen = await modal({
      title: 'Copy to',
      subtitle: `${files.length} object${files.length === 1 ? '' : 's'}`,
      render: (body, { close }) => {
        const list = el('div', { class: 'picker-list' });
        for (const e of others) {
          const label = e.source.kind === 's3'
            ? 'S3: ' + (e.s3Target?.name || e.s3Id)
            : e.source.kind === 'local' ? 'Local machine'
              : (state.getConnection(e.connId)?.label || 'session');
          list.append(el('div', { class: 'picker-item', onClick: () => close(e) },
            el('span', { class: 'pname', text: label }),
            el('span', { class: 'pmeta', text: e.view.path || '/' })));
        }
        body.append(list);
      },
      buttons: [{ label: 'Cancel', value: null }],
    });
    if (!chosen) return;
    await s3Transfer(this, chosen, files, chosen.view.path || '');
  }

  async _s3Download(files) {
    const dest = await window.api.dialog.chooseDir(
      state.appInfo?.home ? state.appInfo.home + '/Downloads' : undefined);
    if (!dest) return;
    status(`Downloading ${files.length} object(s) → ${dest}`, 0);
    try {
      const r = await window.api.s3.download(this.s3Id, files.map((f) => f.path), dest);
      toast(`Downloaded ${r.downloaded.length} object(s)`, 'success');
      status('');
    } catch (err) { status(''); toast(err.message, 'error'); }
  }

  async _s3Upload() {
    const paths = await window.api.dialog.openFiles();
    if (!paths?.length) return;
    const cls = await pickStorageClass(this.s3Target);
    if (!cls) return;
    status(`Uploading ${paths.length} file(s) → ${this.view.path || 'bucket root'}`, 0);
    try {
      const r = await window.api.s3.upload(this.s3Id, paths, this.view.path || '', { storageClass: cls });
      toast(`Uploaded ${r.uploaded.length} file(s) as ${r.storageClass}`, 'success');
      status('');
      await this.refresh();
    } catch (err) { status(''); toast(err.message, 'error'); }
  }

  /** Re-tiering is a copy onto itself; S3 has no other way to change class. */
  async _s3Retier(file) {
    const cls = await pickStorageClass(this.s3Target, file.storageClass);
    if (!cls) return;
    try {
      await window.api.s3.copy(this.s3Id, file.path, file.path, cls);
      toast(`${file.name} is now ${cls}`, 'success');
      await this.refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  async _s3Delete(entries) {
    const keys = entries.filter((e) => !isDir(e)).map((e) => e.path);
    if (!keys.length) return toast('Folders in S3 are only shared prefixes — delete the objects inside.', 'error');
    if (!await confirm({
      title: 'Delete from S3',
      message: `Delete ${keys.length} object${keys.length === 1 ? '' : 's'}?`,
      detail: keys.slice(0, 8).join('\n') + (keys.length > 8 ? `\n… and ${keys.length - 8} more` : ''),
      confirmLabel: 'Delete', danger: true,
    })) return;
    try {
      await window.api.s3.deleteKeys(this.s3Id, keys);
      toast(`Deleted ${keys.length} object(s)`, 'success');
      await this.refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---------------- context menu ---------------- */

  /**
   * Would `cd` in this pane's terminal land where this list is looking?
   *
   * Not always, and getting it wrong is worse than not offering it. A list
   * can be pointed at a different host than the session beside it, and a
   * remote pane can open a *second*, local list for dragging files across —
   * sending a Mac path to a server's shell lands somewhere else, or nowhere,
   * and you find out by reading the prompt afterwards. So the item appears
   * only when the two are the same machine: a local list beside the local
   * shell, or a remote list showing the pane's own session.
   */
  _canCd() {
    if (this.source.kind === 's3' || this.source.kind === 'kube') return false;
    const pane = this.paneId ? state.getPane(this.paneId) : state.activePane;
    if (!pane) return false;
    if (this.source.kind === 'local') return pane.kind === 'local';
    return pane.kind !== 'local' && !!this.connId && this.connId === pane.connId;
  }

  /** The `cd here` item for a folder, or null where it would not mean this pane. */
  _cdItem(path, { label = 'cd here in terminal' } = {}) {
    if (!path || !this._canCd()) return null;
    return { label, icon: '\u232B', title: `cd ${path}`, onClick: () => cdInTerminal(this.paneId, path) };
  }

  /** `picked` is the entry the 3D view clicked on, which has no row to find. */
  _onContextMenu(e, picked) {
    e.preventDefault();
    // The pane also listens for contextmenu (terminal menu); inside the file
    // list this one is the right answer, so stop it bubbling.
    e.stopPropagation();
    const view = this.view;
    const row = e.target.closest('.frow');
    const entry = picked !== undefined ? picked
      : row?.dataset.path ? this.flat().find((x) => x.path === row.dataset.path) : null;
    if (entry && !view.selection.has(entry.path)) {
      view.selection.clear();
      view.selection.add(entry.path);
      this.render();
    }
    const sel = this.selected();
    const local = this.source.kind === 'local';
    const s3 = this.source.kind === 's3';
    if (s3) return this._s3ContextMenu(e, entry, sel);
    const targetDir = entry
      ? (isDir(entry) ? entry.path : (local ? parentLocal(entry.path) : posix.parent(entry.path)))
      : view.path;

    /*
     * Where a `cd` would go: the folder under the pointer, or — when the
     * click was on the blank space below the rows — the folder the list is
     * showing. Blank space means the menu is about *this folder*, so the item
     * leads there rather than sitting below the per-file ones, which is where
     * you would look for it after navigating somewhere and wanting the
     * terminal to follow.
     */
    const cdItem = entry && isDir(entry)
      ? this._cdItem(entry.path)
      : this._cdItem(view.path, { label: 'cd to this folder in terminal' });

    const items = [
      entry ? null : cdItem,
      entry && isDir(entry) ? {
        label: view.expanded.has(entry.path) ? 'Collapse' : 'Expand',
        icon: view.expanded.has(entry.path) ? '\u25BE' : '\u25B8',
        onClick: () => this.toggleExpand(entry),
      } : null,
      entry && isDir(entry) ? { label: 'Open folder', icon: '\u2192', onClick: () => this.navigate(entry.path) } : null,
      entry && !isDir(entry) && local ? {
        label: 'Open', icon: '\u2197',
        title: 'Whatever this Mac opens it with by default',
        onClick: () => window.api.local.open(entry.path),
      } : null,
      /*
       * The two things the default handler cannot do.
       *
       * "Open" hands the file to whatever owns its extension, which for a
       * `.log`, a `.conf` or anything without one is either the wrong
       * application or a dialog asking which. Reading it is the common case
       * and it already has an editor \u2014 the one the remote side uses \u2014 so it
       * is offered directly; naming an application covers the rest.
       */
      entry && !isDir(entry) && local ? {
        label: 'Open as text', icon: '\u270e',
        title: 'In this window, with the same editor a remote file gets',
        onClick: () => this.editLocal(entry),
      } : null,
      entry && !isDir(entry) && local ? {
        label: 'Open with\u2026', icon: '\u2197',
        submenu: openWithMenu(entry),
      } : null,
      entry && !isDir(entry) && !local ? { label: 'Edit / preview', icon: '\u270E', onClick: () => this.edit(entry) } : null,
      // The same file in whatever you actually edit in, with every save going
      // back up — the reason a second tool usually stays installed.
      entry && !isDir(entry) && !local ? {
        label: 'Edit in my editor…', icon: '\u270E',
        title: 'Downloads it, opens your editor, and uploads every save until you stop',
        onClick: () => this.editExternally(entry),
      } : null,
      { sep: true },
    ];

    if (!local) {
      items.push(
        sel.length ? { label: `Download${sel.length > 1 ? ' ' + sel.length + ' items' : ''}`, icon: '\u2193', onClick: () => this.download(sel) } : null,
        sel.length ? { label: 'Copy to another server…', icon: '\u21C6', onClick: () => copyToServerDialog(this.connId, sel) } : null,
        {
          label: 'Upload files here…', icon: '\u2191',
          onClick: async () => {
            const paths = await window.api.dialog.openFiles();
            if (paths.length) uploadTo(this.connId, paths, targetDir);
          },
        },
        {
          label: 'Upload folder here…', icon: '\u2191',
          onClick: async () => {
            const paths = await window.api.dialog.openDirs();
            if (paths.length) uploadTo(this.connId, paths, targetDir);
          },
        });
    } else {
      const remotes = [...explorers.values()].filter((x) => x.source.kind === 'remote' && x.connId);
      if (sel.length && remotes.length) {
        items.push({
          label: 'Upload to ' + (remotes[0].view.path || 'the other pane'), icon: '\u2191',
          onClick: () => uploadTo(remotes[0].connId, sel.map((x) => x.path), remotes[0].view.path),
        });
      }
      items.push(entry ? { label: 'Reveal in Finder', icon: '\u2197', onClick: () => window.api.local.reveal(entry.path) } : null);
    }

    items.push(
      { sep: true },
      { label: 'New folder…', icon: '\u002B', onClick: () => this.makeDir(targetDir) },
      entry ? { label: 'Rename…', icon: '\u270E', onClick: () => this.rename(entry) } : null,
      entry && !local ? {
        label: sel.length > 1 ? `Permissions and owner (${sel.length} items)…` : 'Permissions and owner…',
        icon: '\u26BF',
        onClick: () => this.permissions(sel.length > 1 ? sel : [entry]),
      } : null,
      sel.length ? { label: 'Delete', icon: '\u2715', onClick: () => this.remove(sel) } : null,
      { sep: true },
      entry ? {
        label: 'Copy path', icon: '\u29C9',
        onClick: () => { window.api.clipboard.write(entry.path); status('Copied ' + entry.path); },
      } : null,
      // On blank space this already led the menu, above.
      entry ? cdItem : null,
      entry ? {
        label: isDir(entry) ? 'Get folder info…' : 'Get info…', icon: '\u2139',
        onClick: () => this.info(entry),
      } : null,
      /*
       * Either can be starred, and the two mean different things: a starred
       * folder is somewhere to go, a starred file is something to open.
       */
      entry && this.source.kind !== 's3' ? {
        label: isDir(entry) ? 'Star this folder' : 'Star this file', icon: '\u2606',
        title: 'Keep it in the starred list above the files',
        onClick: () => this.toggleFavorite(entry.path, { kind: isDir(entry) ? 'dir' : 'file' }),
      } : null,
      { sep: true },
      // The two-pane operations. They act on the directory, not the selection,
      // so they sit at the bottom with the other whole-list actions.
      this.compare
        ? { label: 'Clear the comparison', icon: '\u2715', onClick: () => this.clearCompare() }
        : { label: 'Compare with the other list', icon: '\u2260', onClick: () => this.compareWith() },
      {
        label: 'Synchronize with the other list…', icon: '\u21C6',
        title: 'Walks both folders and shows what it would move before moving anything',
        onClick: () => this.syncWith(),
      },
      /*
       * The same intent, done by the tool that is good at it. Kept as a
       * separate entry rather than an option inside the one above, because
       * they fail differently and are good at different sizes: that one
       * works anywhere the browser can list files, including a bucket and a
       * per-session-MFA node; this one needs an ssh connection to ride, and
       * in exchange sends only the blocks that changed.
       */
      this.source.kind !== 's3' ? {
        label: 'Synchronize with rsync…', icon: '\u21C6',
        title: 'Runs rsync between this folder and the other pane, over the connection already open',
        onClick: async () => {
          const { openRsyncDialog } = await import('./rsyncsync.js');
          await openRsyncDialog(this, explorers);
        },
      } : null,
      !local ? {
        label: 'Keep this folder up to date from here…', icon: '\u21BB',
        title: 'Watches a local folder and uploads changes as they are saved',
        onClick: () => this.keepUpToDate(),
      } : null,
      { sep: true },
      { label: 'Collapse all', icon: '\u25BE', onClick: () => this.collapseAll() },
      { label: 'Refresh', icon: '\u21BB', onClick: () => this.refresh() });

    contextMenu(e.clientX, e.clientY, items.filter(Boolean));
  }

  /* ---------------- background refresh ---------------- */

  /** Re-list without disturbing selection, expansion or scroll. */
  async autoRefresh() {
    const view = this.view;
    if (!view.path || view.loading || view._loading || view._refreshing) return;
    if (document.activeElement === this.pathInput) return;
    if (this.source.kind === 'remote') {
      const conn = this.connId ? state.getConnection(this.connId) : null;
      if (conn?.state !== 'connected') return;
    }

    view._refreshing = true;
    try {
      const res = await this._list(view.path);
      if (res.path !== view.path) return;
      if (signature(res.entries) === signature(view.entries)) return;

      const scroll = this.list.scrollTop;
      const names = new Set(res.entries.map((e) => e.path));
      view.entries = res.entries;
      view.selection = new Set([...view.selection].filter((p) => names.has(p)));
      for (const dir of [...view.expanded]) {
        if (!names.has(dir) && dir !== view.path) view.expanded.delete(dir);
      }
      this.render();
      this.list.scrollTop = scroll;
    } catch {
      // Transient failures are not worth surfacing on a background tick.
    } finally {
      view._refreshing = false;
    }
  }

  destroy() {
    this.destroyed = true;
    this.city?.destroy();
    explorers.delete(this.id);
    this.element.remove();
  }
}

function signature(entries) {
  return entries
    .map((e) => `${e.name}\0${e.type}\0${e.size}\0${e.mtime}\0${e.mode}`)
    .sort().join('\x01');
}

/* ------------------------------------------------------------------ */
/* Transfer helpers shared by every explorer                           */
/* ------------------------------------------------------------------ */

const showTransfers = () => import('./dock.js').then((m) => m.openDock('transfers'));

/**
 * A folder going to or from a beam: say that one archive beats a file at a time.
 *
 * A beam is reached through `tsh beams`, so every file is its own round trip
 * through the proxy, and a tree of thousands of small files spends most of
 * its time on those rather than on bytes. Packing it into a tar.gz, moving
 * the one file and expanding it on the destination is the fast way, so the
 * transfer still starts — this only says how it could have gone quicker.
 */
function beamFolderAdvice(connId, dirPath, up, dest) {
  if (state.getConnection(connId)?.transport !== 'beam' || !dirPath) return;
  const parts = String(dirPath).replace(/[\\/]+$/, '').split(/[\\/]/);
  const name = parts.pop() || dirPath;
  const parent = parts.join('/') || '/';
  const pack = `tar czf ${name}.tar.gz -C ${shq(parent)} ${shq(name)}`;
  const unpack = `tar xzf ${name}.tar.gz -C ${shq(dest)}`;
  toast(up
    ? `Large folder? Faster to a beam as one archive: here, ${pack}; upload that; then in the beam, ${unpack}.`
    : `Large folder? Faster from a beam as one archive: in the beam, ${pack}; download that; then here, ${unpack}.`,
  'info', 15000);
}

export async function uploadTo(connId, paths, remoteDir) {
  if (!connId) return toast('No session for that pane', 'error');
  if (!remoteDir) return toast('No remote directory', 'error');
  try {
    await window.api.xfer.upload(connId, paths, remoteDir);
    status(`Uploading ${paths.length} item(s) → ${remoteDir}`);
    showTransfers();
    if (state.getConnection(connId)?.transport === 'beam') {
      const dirs = await window.api.local.existingDirs(paths).catch(() => []);
      beamFolderAdvice(connId, dirs[0]?.path, true, remoteDir);
    }
  } catch (e) { toast(e.message, 'error'); }
}

export async function downloadTo(connId, entries, localDir) {
  if (!connId) return toast('No session for that pane', 'error');
  let dir = localDir;
  if (!dir) {
    dir = await window.api.dialog.chooseDir();
    if (!dir) return;
  }
  try {
    await window.api.xfer.download(connId,
      entries.map((e) => ({ path: e.path, name: e.name, type: e.type, targetType: e.targetType })), dir);
    status(`Downloading ${entries.length} item(s) → ${dir}`);
    showTransfers();
    beamFolderAdvice(connId, entries.find(isDir)?.path, false, dir);
  } catch (e) { toast(e.message, 'error'); }
}

export async function crossCopy(fromConn, entries, toConn, destDir) {
  try {
    const plan = await window.api.xfer.crossPlan(fromConn, toConn);
    if (plan.mode === 'relay') {
      const ok = await confirm({
        title: 'Relay through this machine?',
        message: `${entries.length} item(s) will be downloaded here and re-uploaded.`,
        detail: plan.reason + '\n\nFiles go to a temporary folder and are deleted afterwards.',
        confirmLabel: 'Copy anyway',
      });
      if (!ok) return;
    }
    const out = await window.api.xfer.cross(fromConn,
      entries.map((e) => ({ path: e.path, name: e.name, type: e.type, targetType: e.targetType })),
      toConn, destDir);
    status(`${out.mode === 'direct' ? 'Direct' : 'Relayed'} copy of ${out.fileCount} file(s) started`);
    showTransfers();
  } catch (e) { toast(e.message, 'error'); }
}

async function copyToServerDialog(srcConn, entries) {
  const candidates = [...state.connections.values()].filter((c) => c.id !== srcConn && c.state === 'connected');
  if (!candidates.length) return toast('Open a session on the other server first', 'error');

  let chosen = candidates[0];
  const destDir = textInput({ value: chosen.homeDir || '~' });
  const note = el('div', { class: 'hint' });

  const refresh = async () => {
    destDir.value = chosen.homeDir || '~';
    note.textContent = 'Checking route…';
    try {
      const plan = await window.api.xfer.crossPlan(srcConn, chosen.id);
      note.textContent = plan.mode === 'direct' ? `Direct transfer. ${plan.reason}` : `Relayed. ${plan.reason}`;
      note.style.color = plan.mode === 'direct' ? 'var(--green)' : 'var(--amber)';
    } catch (e) { note.textContent = e.message; note.style.color = 'var(--red)'; }
  };

  const picker = el('div', { class: 'picker-list' });
  const draw = () => {
    picker.replaceChildren(...candidates.map((c) => {
      const row = el('div', {
        class: 'picker-item' + (c.id === chosen.id ? ' active' : ''),
        onClick: () => { chosen = c; draw(); refresh(); },
      }, el('span', { class: 'pname', text: c.label }),
         el('span', { class: 'pmeta', text: c.type === 'teleport' ? 'tsh' : 'ssh' }));
      return row;
    }));
  };
  draw(); refresh();

  const res = await modal({
    title: 'Copy to another server',
    subtitle: entries.length === 1 ? entries[0].name : `${entries.length} items`,
    render: (body) => {
      body.append(el('div', { class: 'field' }, el('label', { text: 'Destination session' }), picker),
        field('Destination directory', destDir), note);
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Copy', class: 'primary-btn', onClick: ({ close }) => close(destDir.value.trim() || null) },
    ],
  });
  if (!res) return;
  await crossCopy(srcConn, entries, chosen.id, res);
}

/** `/Applications/Visual Studio Code.app` → `Visual Studio Code`. */
function appName(p) {
  return String(p || '').split('/').pop().replace(/\.app$/i, '') || p;
}

/**
 * The submenu behind "Open with…".
 *
 * Applications previously chosen, then the picker. Deliberately not a list of
 * everything that *can* open the file: asking the OS that question is slow,
 * platform-specific and usually answers with thirty entries — whereas the
 * real answer is nearly always one of the two or three programs this person
 * already reaches for, which is worth remembering instead.
 */
function openWithMenu(entry) {
  const recent = (state.settings.openWithApps || []).slice(0, 8);
  const openIn = async (appPath) => {
    try {
      await window.api.local.openWith(entry.path, appPath);
      // Most recent first, so the list orders itself by use.
      const next = [appPath, ...(state.settings.openWithApps || []).filter((a) => a !== appPath)];
      state.settings = await window.api.settings.set({ openWithApps: next.slice(0, 12) });
    } catch (e) { toast(e.message, 'error'); }
  };

  return [
    ...recent.map((a) => ({ label: appName(a), title: a, icon: '↗', onClick: () => openIn(a) })),
    ...(recent.length ? [{ sep: true }] : []),
    {
      label: 'Choose an application…', icon: '+',
      onClick: async () => {
        const chosen = await window.api.dialog.chooseApp();
        if (chosen) openIn(chosen);
      },
    },
    ...(recent.length ? [{
      label: 'Forget these',
      title: 'Empty the list of applications above',
      onClick: async () => {
        state.settings = await window.api.settings.set({ openWithApps: [] });
      },
    }] : []),
  ];
}

function cdInTerminal(paneId, path) {
  import('./sessions.js').then(({ sendToPane }) => {
    const pane = paneId ? state.getPane(paneId) : state.activePane;
    if (pane) sendToPane(pane, `cd ${JSON.stringify(path)}\n`);
  });
}
