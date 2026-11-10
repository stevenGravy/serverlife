'use strict';
/**
 * Directory synchronisation: walk both sides, work out what differs, and say
 * so before anything moves.
 *
 * The whole value of a sync tool is the sentence "here is what I am about to
 * do" — a transfer that silently overwrote the wrong side is worse than no
 * sync at all. So this module only ever *plans*. Applying a plan is a list of
 * ordinary transfers handed to the queue that already exists, which means sync
 * inherits its progress, its cancellation and its rates for free.
 *
 * Two deliberate refusals:
 *
 *   - **Symlinks are never followed and never transferred.** Following one
 *     turns a sync into an unbounded walk, and copying one replaces a link
 *     with the bytes it pointed at, which is not what the source directory
 *     said. They are counted and reported instead.
 *   - **Deleting is opt-in, per direction, and never in both-ways mode.**
 *     "Extra on the other side" means "delete it" only when someone has said
 *     that is what they meant.
 */

const fsp = require('fs/promises');
const path = require('path');

/** Names that are noise in every tree and would only ever cause churn. */
const ALWAYS_SKIP = new Set(['.DS_Store', 'Thumbs.db', '.localized']);

/**
 * How far apart two timestamps can be and still count as the same file.
 *
 * SFTP carries mtime in whole seconds while a local stat has milliseconds, so
 * a file that was just copied compares unequal to itself. Two seconds absorbs
 * that without hiding a real edit.
 */
const MTIME_SLACK_MS = 2000;

const LIMITS = { maxEntries: 200000, maxMs: 45000 };

/** Walk a local tree into files and directories, relative to `root`. */
async function walkLocal(root, limits = LIMITS) {
  const started = Date.now();
  const files = new Map();      // rel -> {size, mtime}
  const dirs = new Set();
  let links = 0;
  let truncated = false;

  async function walk(rel) {
    if (truncated) return;
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.size >= limits.maxEntries || Date.now() - started > limits.maxMs) {
        truncated = true;
        return;
      }
      if (ALWAYS_SKIP.has(e.name)) continue;
      const childRel = rel ? path.posix.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) { links++; continue; }
      if (e.isDirectory()) {
        dirs.add(childRel);
        await walk(childRel);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = await fsp.lstat(path.join(root, childRel));
        files.set(childRel, { size: st.size, mtime: st.mtimeMs });
      } catch { /* gone or unreadable: it is left out of the comparison */ }
    }
  }

  let exists = true;
  try { exists = (await fsp.stat(root)).isDirectory(); } catch { exists = false; }
  if (exists) await walk('');
  return { files, dirs, links, truncated, exists };
}

/** The same walk over SFTP. `sftp` is a connected SftpClient. */
async function walkRemote(sftp, root, limits = LIMITS) {
  const started = Date.now();
  const files = new Map();
  const dirs = new Set();
  let links = 0;
  let truncated = false;

  async function walk(rel) {
    if (truncated) return;
    const abs = rel ? posixJoin(root, rel) : root;
    let entries;
    try { entries = await sftp.list(abs); } catch { return; }
    for (const e of entries) {
      if (files.size >= limits.maxEntries || Date.now() - started > limits.maxMs) {
        truncated = true;
        return;
      }
      if (ALWAYS_SKIP.has(e.name)) continue;
      const childRel = rel ? path.posix.join(rel, e.name) : e.name;
      if (e.type === 'symlink') { links++; continue; }
      if (e.type === 'directory') {
        dirs.add(childRel);
        await walk(childRel);
        continue;
      }
      if (e.type !== 'file') continue;
      files.set(childRel, { size: e.size ?? 0, mtime: e.mtime || 0 });
    }
  }

  let exists = true;
  try {
    const a = await sftp.stat(root);
    exists = (a.mode & 0o170000) === 0o040000;
  } catch { exists = false; }
  if (exists) await walk('');
  return { files, dirs, links, truncated, exists };
}

function posixJoin(dir, name) {
  if (!dir || dir === '/') return '/' + name;
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

/**
 * Whether two files count as already in sync.
 *
 * `both` — size and time — is the honest default: it is the only one of the
 * three that never calls two different files the same. The others exist
 * because timestamps are not always preserved on the way across, and a whole
 * tree that compares unequal on time alone is a whole tree re-uploaded every
 * run:
 *
 *   - `size` ignores time, which suits an artefact directory where the
 *     contents are what matter and the clock is noise.
 *   - `time` ignores size, which suits a source tree where an editor rewrites
 *     a file to the same length.
 */
function sameFile(a, b, criterion = 'both') {
  const sameSize = a.size === b.size;
  const sameTime = Math.abs((a.mtime || 0) - (b.mtime || 0)) <= MTIME_SLACK_MS;
  if (criterion === 'size') return sameSize;
  if (criterion === 'time') return sameTime;
  return sameSize && sameTime;
}

/**
 * Compare two trees and return the work.
 *
 * `direction` is 'up' (local → remote), 'down' (remote → local) or 'both',
 * where the newer side of each pair wins and nothing is ever deleted.
 */
async function plan(sftp, { localDir, remoteDir, direction = 'up', del = false, compare = 'both' } = {}) {
  const [local, remote] = await Promise.all([
    walkLocal(localDir),
    walkRemote(sftp, remoteDir),
  ]);

  const actions = [];
  const both = direction === 'both';
  const names = new Set([...local.files.keys(), ...remote.files.keys()]);

  for (const rel of [...names].sort()) {
    const l = local.files.get(rel);
    const r = remote.files.get(rel);

    if (l && !r) {
      if (direction === 'up' || both) {
        actions.push({ op: 'upload', rel, size: l.size, why: 'not on the server' });
      } else if (del) {
        actions.push({ op: 'deleteLocal', rel, size: l.size, why: 'not on the server' });
      } else {
        actions.push({ op: 'skip', rel, size: l.size, why: 'only here' });
      }
      continue;
    }
    if (r && !l) {
      if (direction === 'down' || both) {
        actions.push({ op: 'download', rel, size: r.size, why: 'not on this machine' });
      } else if (del) {
        actions.push({ op: 'deleteRemote', rel, size: r.size, why: 'not on this machine' });
      } else {
        actions.push({ op: 'skip', rel, size: r.size, why: 'only on the server' });
      }
      continue;
    }
    if (sameFile(l, r, compare)) {
      actions.push({
        op: 'same', rel, size: l.size,
        why: compare === 'size' ? 'same size' : compare === 'time' ? 'same time' : 'same size and time',
      });
      continue;
    }

    const localNewer = (l.mtime || 0) > (r.mtime || 0) + MTIME_SLACK_MS;
    const why = localNewer ? 'newer here' : 'newer on the server';
    if (both) {
      actions.push({ op: localNewer ? 'upload' : 'download', rel, size: localNewer ? l.size : r.size, why });
    } else if (direction === 'up') {
      // Uploading something the server has newer is the one case worth
      // flagging rather than doing quietly.
      actions.push({ op: 'upload', rel, size: l.size, why, overwritesNewer: !localNewer });
    } else {
      actions.push({ op: 'download', rel, size: r.size, why, overwritesNewer: localNewer });
    }
  }

  // Directories that only exist on one side have to be created before any
  // file lands in them; the transfer queue makes them, so they only need
  // listing when they are empty of work.
  const dirsUp = [...local.dirs].filter((d) => !remote.dirs.has(d)).sort();
  const dirsDown = [...remote.dirs].filter((d) => !local.dirs.has(d)).sort();

  /*
   * Folders the other side no longer has.
   *
   * Deleting the files inside a folder and leaving the folder is not what
   * "make these two the same" means, and it is what happens if only files are
   * compared: the tree keeps the shape of everything ever deleted. Deepest
   * first, so each one is empty by the time it is removed — and a folder that
   * still has something in it (a row the user unticked, a file this walk never
   * saw) fails to remove and is reported rather than forced.
   */
  if (del && direction !== 'both') {
    const gone = direction === 'up' ? dirsDown : dirsUp;
    const deepestFirst = [...gone].sort((x, y) =>
      y.split('/').length - x.split('/').length || y.localeCompare(x));
    for (const rel of deepestFirst) {
      actions.push({
        op: direction === 'up' ? 'rmdirRemote' : 'rmdirLocal',
        rel,
        size: 0,
        dir: true,
        why: direction === 'up' ? 'folder not on this machine' : 'folder not on the server',
      });
    }
  }

  const counted = (op) => actions.filter((a) => a.op === op);
  return {
    localDir,
    remoteDir,
    direction,
    compare,
    actions,
    dirsUp: direction === 'down' ? [] : dirsUp,
    dirsDown: direction === 'up' ? [] : dirsDown,
    summary: {
      upload: counted('upload').length,
      download: counted('download').length,
      deleteRemote: counted('deleteRemote').length,
      deleteLocal: counted('deleteLocal').length,
      rmdirRemote: counted('rmdirRemote').length,
      rmdirLocal: counted('rmdirLocal').length,
      /*
       * What deleting *would* remove, when it is switched off. Without this
       * the dialog has nothing to say about a file the source no longer has,
       * and "sync did not remove my deletion" looks like a bug rather than an
       * option that is off.
       */
      wouldDelete: counted('skip').length,
      same: counted('same').length,
      skip: counted('skip').length,
      bytes: [...counted('upload'), ...counted('download')].reduce((a, b) => a + (b.size || 0), 0),
      overwritesNewer: actions.filter((a) => a.overwritesNewer).length,
      links: local.links + remote.links,
      truncated: local.truncated || remote.truncated,
      localMissing: !local.exists,
      remoteMissing: !remote.exists,
    },
  };
}

/**
 * Turn a plan into the transfer items the queue takes.
 *
 * Only the actions the caller kept: the preview is editable, so what comes
 * back here may be a subset of what was planned.
 */
function items(planned, actions) {
  const uploads = [];
  const downloads = [];
  for (const a of actions) {
    if (a.op === 'upload') {
      uploads.push({
        local: path.join(planned.localDir, a.rel),
        remote: posixJoin(planned.remoteDir, a.rel),
        size: a.size || 0,
      });
    } else if (a.op === 'download') {
      downloads.push({
        remote: posixJoin(planned.remoteDir, a.rel),
        local: path.join(planned.localDir, a.rel),
        size: a.size || 0,
      });
    }
  }
  const upDirs = [...new Set([
    ...uploads.map((u) => path.posix.dirname(u.remote)),
    // Folders with nothing in them to transfer, which the queue would
    // otherwise never create.
    ...(planned.dirsUp || []).map((d) => posixJoin(planned.remoteDir, d)),
  ])].filter((d) => d && d !== '.');
  const downDirs = [...new Set([
    ...downloads.map((d) => path.dirname(d.local)),
    ...(planned.dirsDown || []).map((d) => path.join(planned.localDir, d)),
  ])];
  return { uploads, downloads, upDirs, downDirs };
}

module.exports = { plan, items, walkLocal, walkRemote, posixJoin, MTIME_SLACK_MS };
