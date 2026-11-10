'use strict';
/**
 * Two things that are the same thing: a local file being watched, and whatever
 * it should be pushed to when it changes.
 *
 *   - **Keep a directory up to date** — you edit a tree on this machine and it
 *     lands on the server as you save, which is the whole build-deploy loop
 *     for anything interpreted.
 *   - **Edit a remote file in your own editor** — the file comes down to a
 *     temporary copy, opens in whatever you use, and every save goes back up.
 *     This is the feature people keep a second tool installed for.
 *
 * Both are a watch plus an upload, so both live here and appear in one list.
 *
 * What it will not do: delete. A watcher that mirrors deletions is a watcher
 * that can empty a server because a checkout was moved. Removals are left to
 * a deliberate sync, where they are previewed first.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { uploadFile, downloadFile } = require('./transfers');

/** Noise that would otherwise upload itself every few seconds. */
const SKIP = [
  /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/,
  /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.#/, /~$/, /\.swp$/, /\.tmp$/, /^\.~lock/,
];

/**
 * How long to wait after a change before uploading.
 *
 * An editor writing a file produces several events — truncate, write, rename
 * — and uploading on the first one sends an empty file. This waits for the
 * writes to stop, which is also what coalesces "save all" into one pass.
 */
const SETTLE_MS = 400;

let seq = 0;
const watches = new Map();   // id -> record

function skip(rel) {
  return SKIP.some((re) => re.test(rel));
}

/**
 * Watch a local directory and upload what changes.
 *
 * @param getSftp  () => Promise<SftpClient> for the target connection
 * @param onEvent  (id, event) => void, for the UI's activity line
 */
function watchDir({ connId, label, localDir, remoteDir, getSftp, onEvent }) {
  const id = 'w' + (++seq);
  const pending = new Map();   // rel -> timer
  const rec = {
    id, kind: 'dir', connId, label,
    localDir, remoteDir,
    started: Date.now(),
    uploads: 0, errors: 0, lastFile: null, lastAt: null, lastError: null,
    watcher: null,
  };

  const push = async (rel) => {
    const local = path.join(localDir, rel);
    let st;
    try { st = await fsp.lstat(local); } catch { return; }      // gone again
    if (st.isSymbolicLink() || st.isDirectory()) return;
    const remote = joinPosix(remoteDir, rel.split(path.sep).join('/'));
    try {
      const sftp = await getSftp();
      // The parent may be new; mkdir the chain and ignore "exists".
      await mkdirp(sftp, path.posix.dirname(remote));
      await uploadFile(sftp, local, remote, {});
      rec.uploads++;
      rec.lastFile = rel;
      rec.lastAt = Date.now();
      rec.lastError = null;
      onEvent?.(id, { ok: true, rel, bytes: st.size, at: rec.lastAt });
    } catch (e) {
      rec.errors++;
      rec.lastError = e.message;
      rec.lastAt = Date.now();
      onEvent?.(id, { ok: false, rel, error: e.message, at: rec.lastAt });
    }
  };

  const onChange = (_type, filename) => {
    if (!filename) return;
    const rel = String(filename);
    if (skip(rel.split(path.sep).join('/'))) return;
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => { pending.delete(rel); push(rel); }, SETTLE_MS));
  };

  try {
    rec.watcher = fs.watch(localDir, { recursive: true }, onChange);
  } catch {
    // Recursive watching is not available everywhere; a flat watch still
    // covers the common "edit files in this one directory" case, and saying
    // so is better than refusing.
    rec.watcher = fs.watch(localDir, onChange);
    rec.flatOnly = true;
  }
  rec.watcher.on('error', (e) => { rec.lastError = e.message; });

  watches.set(id, rec);
  return view(rec);
}

/**
 * Bring a remote file down, open it, and push every save back.
 *
 * The temporary copy keeps the original name so the editor gets its syntax
 * highlighting right, under a per-edit directory so two files called
 * `config.yaml` cannot collide.
 */
async function editRemote({ connId, label, remotePath, getSftp, open, onEvent }) {
  const id = 'e' + (++seq);
  const name = path.posix.basename(remotePath) || 'file';
  const dir = path.join(os.tmpdir(), `serverlife-edit-${crypto.randomBytes(5).toString('hex')}`);
  await fsp.mkdir(dir, { recursive: true });
  const local = path.join(dir, name);

  const sftp = await getSftp();
  await downloadFile(sftp, remotePath, local, {});

  const rec = {
    id, kind: 'edit', connId, label,
    remotePath, localDir: dir, localPath: local,
    started: Date.now(),
    uploads: 0, errors: 0, lastAt: null, lastError: null,
    watcher: null,
  };

  let timer = null;
  let lastSize = -1;
  let lastMtime = -1;
  const push = async () => {
    let st;
    try { st = await fsp.stat(local); } catch { return; }
    // An editor can touch the file without changing it (and some write twice);
    // uploading only on a real change keeps the audit log honest.
    if (st.size === lastSize && st.mtimeMs === lastMtime) return;
    lastSize = st.size;
    lastMtime = st.mtimeMs;
    try {
      const s = await getSftp();
      await uploadFile(s, local, remotePath, {});
      rec.uploads++;
      rec.lastAt = Date.now();
      rec.lastError = null;
      onEvent?.(id, { ok: true, rel: name, bytes: st.size, at: rec.lastAt });
    } catch (e) {
      rec.errors++;
      rec.lastError = e.message;
      rec.lastAt = Date.now();
      onEvent?.(id, { ok: false, rel: name, error: e.message, at: rec.lastAt });
    }
  };

  try {
    const st = await fsp.stat(local);
    lastSize = st.size;
    lastMtime = st.mtimeMs;
  } catch { /* nothing there yet */ }

  rec.watcher = fs.watch(local, () => {
    clearTimeout(timer);
    timer = setTimeout(push, SETTLE_MS);
  });
  rec.watcher.on('error', (e) => { rec.lastError = e.message; });

  watches.set(id, rec);
  // Handing it to the editor last: if opening fails there is still a watcher
  // and a path, and the caller can say where the file is.
  try { await open?.(local); } catch (e) { rec.openError = e.message; }
  return view(rec);
}

async function mkdirp(sftp, dir) {
  if (!dir || dir === '/' || dir === '.') return;
  const parts = dir.split('/').filter(Boolean);
  let at = dir.startsWith('/') ? '' : '.';
  for (const p of parts) {
    at = at === '' ? '/' + p : at + '/' + p;
    await sftp.mkdir(at).catch(() => {});
  }
}

function joinPosix(dir, rel) {
  if (!dir || dir === '/') return '/' + rel;
  return dir.endsWith('/') ? dir + rel : dir + '/' + rel;
}

function view(rec) {
  return {
    id: rec.id, kind: rec.kind, connId: rec.connId, label: rec.label,
    localDir: rec.localDir, localPath: rec.localPath || null,
    remoteDir: rec.remoteDir || null, remotePath: rec.remotePath || null,
    started: rec.started, uploads: rec.uploads, errors: rec.errors,
    lastFile: rec.lastFile || null, lastAt: rec.lastAt, lastError: rec.lastError || null,
    flatOnly: !!rec.flatOnly, openError: rec.openError || null,
  };
}

function list() {
  return [...watches.values()].map(view);
}

/** Stop one watch. A remote edit also takes its temporary copy with it. */
async function stop(id, { keepTemp = false } = {}) {
  const rec = watches.get(id);
  if (!rec) return list();
  try { rec.watcher?.close(); } catch { /* already closed */ }
  watches.delete(id);
  if (rec.kind === 'edit' && !keepTemp) {
    try { await fsp.rm(rec.localDir, { recursive: true, force: true }); } catch { /* a leftover temp dir is harmless */ }
  }
  return list();
}

/** Everything belonging to a connection that has gone away. */
async function stopForConnection(connId) {
  for (const rec of [...watches.values()]) {
    if (rec.connId === connId) await stop(rec.id);
  }
  return list();
}

module.exports = { watchDir, editRemote, list, stop, stopForConnection };
