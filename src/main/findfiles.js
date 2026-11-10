'use strict';
/**
 * Recursive search, on this machine and on a server.
 *
 * The file browser's filter only ever looked at what was already listed, which
 * answers "where in this folder" and not "where on this box" — the question
 * people actually arrive with. Two searches, because they are different
 * questions: a name, and a string inside the files.
 *
 * On a server this is `find` and `grep`, built as argument arrays and quoted
 * for the shell exactly once, with a cap on results so a search of `/` cannot
 * fill the window or the connection. Locally it is a bounded walk in this
 * process, which costs nothing and avoids spawning anything at all.
 */

const fsp = require('fs/promises');
const path = require('path');

/** Never walk into these locally: they are big, boring, and rarely the answer. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.svn', '.hg', '.cache', 'Library', '.Trash',
  '.npm', '.nvm', '.rustup', '.cargo', 'venv', '.venv', '__pycache__',
]);

/*
 * Budgets, not just a result cap.
 *
 * A home directory is tens of thousands of entries three levels down and
 * millions twelve levels down, so a search for a name that is not there walks
 * the lot. The result cap only stops a search that is *finding* things; these
 * stop one that is not, which is the case that hangs.
 */
const DEFAULTS = {
  limit: 400,
  maxDepth: 6,
  contentBytes: 2 * 1024 * 1024,
  maxEntries: 250000,
  maxMs: 6000,
};

/** A shell-safe single-quoted argument. */
function q(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

/**
 * Turn what someone typed into a glob `find -name` will accept.
 *
 * A bare word means "contains", because that is what a search box implies —
 * requiring `*log*` to find `mylog.txt` is a rule nobody remembers. Anything
 * already carrying a wildcard is left exactly as written.
 */
function toGlob(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return '*';
  return /[*?[\]]/.test(p) ? p : '*' + p + '*';
}

/** Does this name match the glob? Used for the local walk. */
function globToRegex(glob, caseSensitive) {
  const body = String(glob).replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + body + '$', caseSensitive ? '' : 'i');
}

/* ------------------------------------------------------------------ */
/* Local                                                               */
/* ------------------------------------------------------------------ */

/**
 * Walk a local tree, matching names and optionally file contents.
 *
 * Breadth-first with a depth cap and a result cap, so a mistaken search of `/`
 * stops rather than running for a minute. Unreadable directories are skipped
 * silently — a permission error on one folder is not a failed search.
 */
async function searchLocal({
  dir, pattern, content, caseSensitive = false, kinds = 'all',
  limit = DEFAULTS.limit, maxDepth = DEFAULTS.maxDepth, contentBytes = DEFAULTS.contentBytes,
  maxEntries = DEFAULTS.maxEntries, maxMs = DEFAULTS.maxMs,
} = {}) {
  if (!dir) throw new Error('Which folder? A starting directory is needed.');
  const re = globToRegex(toGlob(pattern), caseSensitive);
  const needle = String(content || '');
  const needleCmp = caseSensitive ? needle : needle.toLowerCase();

  const results = [];
  const startedAt = Date.now();
  let scanned = 0;
  let truncated = false;
  let stopped = null;
  const queue = [{ dir, depth: 0 }];

  while (queue.length && results.length < limit) {
    if (Date.now() - startedAt > maxMs) { stopped = 'time'; break; }
    if (scanned > maxEntries) { stopped = 'entries'; break; }
    const { dir: here, depth } = queue.shift();
    let entries;
    try { entries = await fsp.readdir(here, { withFileTypes: true }); }
    catch { continue; }

    for (const e of entries) {
      if (results.length >= limit) { truncated = true; break; }
      // Checked inside the loop too: one directory can hold a hundred
      // thousand files, which is long enough to matter on its own.
      if ((scanned & 0x3ff) === 0 && Date.now() - startedAt > maxMs) { stopped = 'time'; break; }
      const full = path.join(here, e.name);
      const isDir = e.isDirectory();
      scanned++;

      if (isDir && depth < maxDepth && !SKIP_DIRS.has(e.name)) {
        queue.push({ dir: full, depth: depth + 1 });
      }
      if (kinds === 'files' && isDir) continue;
      if (kinds === 'dirs' && !isDir) continue;
      if (!re.test(e.name)) continue;

      // With a content search, a name match is only a candidate.
      if (needle && !isDir) {
        let text = '';
        try {
          const st = await fsp.stat(full);
          if (st.size > contentBytes) continue;
          text = await fsp.readFile(full, 'utf8');
        } catch { continue; }
        const hay = caseSensitive ? text : text.toLowerCase();
        const at = hay.indexOf(needleCmp);
        if (at < 0) continue;
        const line = text.slice(0, at).split('\n').length;
        results.push({ path: full, name: e.name, type: 'file', line, excerpt: excerptAt(text, at) });
        continue;
      }
      if (needle && isDir) continue;

      let size = null;
      let mtime = null;
      try { const st = await fsp.stat(full); size = st.size; mtime = st.mtimeMs; } catch { /* gone or unreadable: listed without size or time */ }
      results.push({ path: full, name: e.name, type: isDir ? 'directory' : 'file', size, mtime });
    }
  }
  return {
    results,
    scanned,
    truncated: truncated || stopped !== null || queue.length > 0,
    // Why it stopped, so the window can say so rather than implying the tree
    // holds nothing else.
    stopped,
    elapsedMs: Date.now() - startedAt,
    where: dir,
  };
}

/** One line around a hit, trimmed for a list. */
function excerptAt(text, at) {
  const start = text.lastIndexOf('\n', at) + 1;
  let end = text.indexOf('\n', at);
  if (end < 0) end = text.length;
  return text.slice(start, Math.min(end, start + 300)).trim();
}

/* ------------------------------------------------------------------ */
/* Remote                                                             */
/* ------------------------------------------------------------------ */

/**
 * The command for a remote search.
 *
 * `find` for names; `grep -rIl` (or `-rIn` for the line) when there is text to
 * look for, which also does the walking. Both get `-print`-friendly output,
 * `2>/dev/null` so an unreadable directory does not fill the result with noise,
 * and `head` so the cap is enforced on the server rather than by reading a
 * million lines over the wire.
 */
function remoteCommand({
  dir, pattern, content, caseSensitive = false, kinds = 'all',
  limit = DEFAULTS.limit, maxDepth = DEFAULTS.maxDepth,
} = {}) {
  if (!dir) throw new Error('Which folder? A starting directory is needed.');
  const glob = toGlob(pattern);
  const nameFlag = caseSensitive ? '-name' : '-iname';
  const typeFlag = kinds === 'files' ? ' -type f' : kinds === 'dirs' ? ' -type d' : '';

  if (content) {
    /*
     * A content search is grep's job, and it walks the tree itself. `-I`
     * skips binaries, `-s` silences unreadable files, and the name pattern
     * becomes --include so a search can be narrowed to, say, *.conf.
     */
    const include = pattern ? ` --include=${q(glob)}` : '';
    const ci = caseSensitive ? '' : ' -i';
    return `grep -rIn${ci}${include} -e ${q(content)} -- ${q(dir)} 2>/dev/null | head -n ${Number(limit) || 200}`;
  }

  /*
   * `-printf` is GNU; BSD find does not have it. The type and size are worth
   * having, so it is tried and the caller falls back to plain paths when the
   * output comes back empty with an error about it.
   */
  return `find ${q(dir)} -maxdepth ${Number(maxDepth) || 12}${typeFlag} ${nameFlag} ${q(glob)} `
    + `-printf '%y\\t%s\\t%T@\\t%p\\n' 2>/dev/null | head -n ${Number(limit) || 200}`;
}

/** The same search without `-printf`, for a `find` that does not have it. */
function remoteCommandPlain(opts = {}) {
  const glob = toGlob(opts.pattern);
  const nameFlag = opts.caseSensitive ? '-name' : '-iname';
  const typeFlag = opts.kinds === 'files' ? ' -type f' : opts.kinds === 'dirs' ? ' -type d' : '';
  return `find ${q(opts.dir)} -maxdepth ${Number(opts.maxDepth) || 12}${typeFlag} `
    + `${nameFlag} ${q(glob)} -print 2>/dev/null | head -n ${Number(opts.limit) || 200}`;
}

/** Parse whichever of the three output shapes came back. */
function parseRemote(text, { content, limit = DEFAULTS.limit } = {}) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  const results = [];

  for (const line of lines) {
    if (results.length >= limit) break;
    if (content) {
      // grep -n: path:line:text
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      if (!m) continue;
      results.push({
        path: m[1], name: m[1].split('/').pop(), type: 'file',
        line: Number(m[2]), excerpt: m[3].trim().slice(0, 300),
      });
      continue;
    }
    if (line.includes('\t')) {
      const [y, size, t, ...rest] = line.split('\t');
      const p = rest.join('\t');
      if (!p) continue;
      results.push({
        path: p,
        name: p.split('/').pop(),
        type: y === 'd' ? 'directory' : y === 'l' ? 'symlink' : 'file',
        size: Number(size) || 0,
        mtime: Math.round((Number(t) || 0) * 1000) || null,
      });
      continue;
    }
    results.push({ path: line, name: line.split('/').pop(), type: 'file' });
  }
  return { results, truncated: lines.length >= limit };
}

module.exports = {
  searchLocal, remoteCommand, remoteCommandPlain, parseRemote, toGlob, DEFAULTS,
};
