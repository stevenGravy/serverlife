'use strict';

/**
 * What is under each folder of a directory, for the 3D view.
 *
 * A building's height is the bytes underneath that folder and its colour is
 * what those bytes are, so one directory needs one walk: for every immediate
 * child, the total size, how many files and folders are inside, and the bytes
 * per kind of file. Locally that is a bounded walk; on a server it is one
 * `find` piped through `awk`, so what comes back over the wire is a few lines
 * per folder rather than one per file.
 */

const fsp = require('fs/promises');
const path = require('path');

const { kindOf, extOf, EXT_KIND, KINDS } = require('./filekinds');

function blank() {
  return { bytes: 0, files: 0, dirs: 0, kinds: {} };
}

function addFile(rec, name, size) {
  rec.bytes += size;
  rec.files += 1;
  const k = kindOf(name);
  rec.kinds[k] = (rec.kinds[k] || 0) + size;
}

/**
 * Walk a local directory. Never follows symlinks — they loop — and stops at a
 * budget, saying so, because a home directory can be millions of entries.
 */
async function scanLocal(root, { maxEntries = 300000, maxMs = 15000 } = {}) {
  const started = Date.now();
  const children = {};
  let seen = 0;
  let truncated = false;

  let top;
  try { top = await fsp.readdir(root, { withFileTypes: true }); }
  catch (e) { throw new Error(`Cannot read ${root}: ${e.message}`, { cause: e }); }

  for (const d of top) {
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    const rec = children[d.name] = blank();
    const stack = [path.join(root, d.name)];
    while (stack.length) {
      if (seen >= maxEntries || Date.now() - started > maxMs) { truncated = true; break; }
      const dir = stack.pop();
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        seen++;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { rec.dirs++; stack.push(full); continue; }
        let size = 0;
        try { size = (await fsp.lstat(full)).size; } catch { /* gone or unreadable: it counts as empty */ }
        addFile(rec, e.name, size);
      }
    }
    if (truncated) rec.partial = true;
  }
  return { path: root, children, truncated, scanned: seen };
}

const q = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

/**
 * One shell command that answers the same question on a server.
 *
 * GNU find prints size and path itself; BSD and busybox find do not have
 * `-printf`, so they fall back to `stat` — which spells "format" `-c` on
 * busybox and `-f` on BSD, where busybox's `-f` means something else
 * entirely. Size goes first so a path with spaces survives. Either way awk adds it up per
 * top-level folder and extension and prints only the totals. `timeout` and
 * `head` keep a scan of `/` from running all afternoon.
 */
function remoteCommand(dir, { maxEntries = 300000, seconds = 20 } = {}) {
  const awk = [
    'BEGIN{FS="\\t"}',
    '{p=$3; sub(/^\\.\\//,"",p); n=index(p,"/"); if(n==0) next;',
    ' t=substr(p,1,n-1); seen[t]=1;',
    ' if($1=="d"){D[t]++; next}',
    ' if($1!="f") next;',
    ' b=p; sub(/.*\\//,"",b); e=""; m=split(b,a,"."); if(m>1 && a[1]!="") e=tolower(a[m]);',
    ' if(e ~ /^[0-9]+$/ && m>2 && tolower(a[m-1])=="log") e="log";',
    ' if(length(e)>10) e="";',
    ' F[t]++; B[t]+=$2; X[t "\\t" e]+=$2}',
    'END{for(t in seen) printf "D\\t%s\\t%d\\t%d\\t%.0f\\n", t, F[t], D[t], B[t];',
    ' for(k in X) printf "X\\t%s\\t%.0f\\n", k, X[k]; print "N\\t" NR; print "END"}',
  ].join('');
  const to = `$(command -v timeout >/dev/null 2>&1 && echo "timeout ${seconds}")`;
  return [
    `cd ${q(dir)} 2>/dev/null || { echo "ERR cannot enter"; exit 0; }`,
    `if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then`,
    `  ${to} find . -mindepth 2 -xdev \\( -type f -o -type d \\) -printf '%y\\t%s\\t%P\\n' 2>/dev/null;`,
    `else`,
    `  if stat -c %s . >/dev/null 2>&1; then SF=-c; FMT='%s %n'; else SF=-f; FMT='%z %N'; fi;`,
    `  ${to} find . -mindepth 2 -xdev -type f -exec stat $SF "$FMT" {} + 2>/dev/null |`,
    `    awk '{s=$1; sub(/^[^ ]+ /,""); print "f\\t" s "\\t" $0}';`,
    `  ${to} find . -mindepth 2 -xdev -type d 2>/dev/null | awk '{print "d\\t0\\t" $0}';`,
    `fi | head -n ${maxEntries | 0} | awk '${awk.replace(/'/g, `'\\''`)}'`,
  ].join('\n');
}

/** Turn the awk totals back into the same shape `scanLocal` returns. */
function parseRemote(text, dir, { maxEntries = 300000 } = {}) {
  const children = {};
  let complete = false;
  let rows = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('ERR ')) throw new Error(`Cannot read ${dir}`);
    if (line === 'END') { complete = true; continue; }
    const f = line.split('\t');
    if (f[0] === 'N') { rows = Number(f[1]) || 0; continue; }
    if (f[0] === 'D' && f.length >= 5) {
      const rec = children[f[1]] || (children[f[1]] = blank());
      rec.files = Number(f[2]) || 0;
      rec.dirs = Number(f[3]) || 0;
      rec.bytes = Number(f[4]) || 0;
    } else if (f[0] === 'X' && f.length >= 4) {
      const rec = children[f[1]] || (children[f[1]] = blank());
      const k = EXT_KIND.get(f[2]) || 'other';
      rec.kinds[k] = (rec.kinds[k] || 0) + (Number(f[3]) || 0);
    }
  }
  return { path: dir, children, truncated: !complete || rows >= maxEntries, scanned: rows };
}

module.exports = { scanLocal, remoteCommand, parseRemote, kindOf, extOf, KINDS };
