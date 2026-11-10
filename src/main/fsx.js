'use strict';
/**
 * Small filesystem helpers whose only reason to exist is Windows.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Make sure a directory exists.
 *
 * `fs.mkdir(dir, { recursive: true })` is documented as a no-op for a directory
 * that is already there — except at the root of a Windows drive, where it fails
 * with EPERM. Downloading into `C:\` therefore died before a byte moved, on
 * the one call that was meant to be harmless. Existence is checked first, and
 * the two errors that mean "it is already there" are treated as success.
 */
async function ensureDir(dir) {
  if (!dir) return dir;
  try {
    if (fs.existsSync(dir)) return dir;
  } catch { /* fall through to mkdir and let it report */ }

  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    if ((e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES') && isDir(dir)) return dir;
    throw e;
  }
  return dir;
}

/** The parent of a path, or null when it has none — a drive root, or `/`. */
function parentDir(p) {
  const dir = path.dirname(p);
  return dir && dir !== p ? dir : null;
}

/** Ensure the directory a file is about to be written into exists. */
async function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  // At a root there is nothing to create, and asking would be the bug above.
  if (!dir || dir === filePath || isRoot(dir)) return dir;
  return ensureDir(dir);
}

/**
 * A path that cannot be created because it is a root: `/`, a Windows drive
 * (`C:\`), or the root of a UNC share (`\\server\share`). Spelled out rather
 * than left to `path.parse`, so a Windows path is still recognised when it
 * turns up somewhere the posix module is in charge.
 */
function isRoot(dir) {
  if (!dir) return false;
  if (path.parse(dir).root === dir) return true;
  if (/^[A-Za-z]:[\\/]?$/.test(dir)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/.test(dir);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

module.exports = { ensureDir, ensureParentDir, parentDir, isRoot, isDir };
