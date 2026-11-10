const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * rsync, driven from the file browser.
 *
 * The browser's own synchronise walks both folders over SFTP and copies what
 * differs, which is honest work and the right answer for a handful of files.
 * It is the wrong answer for a tree: it compares by listing, moves whole
 * files, and pays a round trip per entry. rsync compares by rolling checksum,
 * sends only the changed blocks, and has spent thirty years on exactly this
 * problem. For "make this 4GB directory look like that one" it is not a
 * little faster, it is a different order of magnitude.
 *
 * What it needs that SFTP does not is a shell to run itself on the far side.
 * That is the whole reason this is a separate feature rather than a flag on
 * the existing one: it rides ssh, so it works where there is an ssh
 * connection to ride — and where there is not, it says so rather than
 * failing halfway.
 */

/* Where a Homebrew or MacPorts rsync would be, ahead of the system one. */
const CANDIDATES = [
  '/opt/homebrew/bin/rsync',
  '/usr/local/bin/rsync',
  '/opt/local/bin/rsync',
  '/usr/bin/rsync',
  '/bin/rsync',
];

let cached = null;

/**
 * Why this machine cannot run the rsync sync at all, or '' if it can.
 *
 * Windows is a deliberate no rather than an untested maybe. Three separate
 * things would have to be solved, and solving two of them badly is worse
 * than not offering it: there is no rsync in the platform to find, Win32
 * OpenSSH has no ControlMaster for it to ride — so the "no second
 * authentication" that makes this worth using is not available — and rsync
 * reads `C:\\Users\\me` as *host C, path \\Users\\me*, so every local path
 * needs translating into whichever convention the installed build happens
 * to use (/cygdrive/c, /c, /mnt/c). The file browser's own synchronise
 * works there and is the honest answer until someone can test the other.
 */
function unsupportedReason(platform = process.platform) {
  if (platform === 'win32') {
    return 'rsync sync is not available on Windows. Use the file browser\u2019s own '
      + 'Synchronize with the other list\u2026, which does the same job over the '
      + 'connection that is already open.';
  }
  return '';
}

/**
 * The newest rsync on this machine, not merely the first.
 *
 * macOS ships `openrsync` at /usr/bin/rsync, which answers to "rsync version
 * 2.6.9 compatible" and has neither `--info=progress2` nor `--protect-args`.
 * A Homebrew rsync alongside it is a real 3.x. Preferring the one with the
 * features, and recording which it is, is what lets the caller build a
 * command line the binary will actually accept.
 */
function find() {
  if (cached) return cached;
  const seen = [];
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) seen.push(p); } catch { /* unreadable path: not a candidate */ }
  }
  /*
   * And whatever is on PATH, which the fixed list above cannot know about:
   * an rsync under a version manager, in ~/bin, or in a Nix profile is as
   * real as one in /usr/bin, and "rsync was not found" is a poor answer
   * when `rsync` works perfectly well in the user's own shell.
   */
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'rsync');
    try { if (!seen.includes(p) && fs.existsSync(p)) seen.push(p); } catch { /* unreadable path: not a candidate */ }
  }
  if (!seen.length) return null;
  cached = seen[0];
  return cached;
}

function versionOf(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout || '').split('\n')[0] || '';
      const m = line.match(/version\s+(\d+)\.(\d+)(?:\.(\d+))?/);
      resolve({
        line: line.trim(),
        major: m ? Number(m[1]) : 0,
        minor: m ? Number(m[2]) : 0,
        // openrsync claims 2.6.9 compatibility and means it: the modern flags
        // are not there, whatever the binary is called.
        openrsync: /openrsync/i.test(stdout),
      });
    });
  });
}

/** Is rsync usable here, and which flags may the command use? */
async function check() {
  const no = unsupportedReason();
  if (no) return { ok: false, error: no, unsupported: true };
  const bin = find();
  if (!bin) {
    return {
      ok: false,
      error: 'rsync was not found on this machine. Install it (brew install rsync) and try again.',
    };
  }
  const v = await versionOf(bin);
  if (!v) return { ok: false, error: `${bin} would not report its version.` };
  const modern = !v.openrsync && (v.major > 3 || (v.major === 3 && v.minor >= 1));
  return {
    ok: true,
    bin,
    version: v.line,
    // What the command builder may use. An old rsync gets a plainer command
    // rather than a clever one that fails on the first flag it has never
    // heard of.
    features: {
      infoProgress: modern,      // --info=progress2
      protectArgs: modern,       // -s, for paths with spaces
    },
  };
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

const running = new Map();   // id -> child

/**
 * Start a run. Output is streamed as it arrives rather than collected: a
 * long sync is the case that matters, and a progress meter that appears
 * after it finishes is not a progress meter.
 */
function run(id, { args = [], onOut, onDone } = {}) {
  const bin = find();
  if (!bin) throw new Error('rsync was not found on this machine.');
  if (running.has(id)) throw new Error('That run is already going.');

  const child = spawn(bin, args, {
    // No shell: every argument is passed as it was built, so a path with a
    // space in it needs no quoting and cannot be re-split into two paths.
    shell: false,
    env: { ...process.env },
  });
  running.set(id, child);

  const push = (text, stream) => { try { onOut?.({ id, text: String(text), stream }); } catch { /* a listener failing must not stop the transfer */ } };
  push(`$ ${bin} ${args.join(' ')}\n`, 'sys');

  child.stdout.on('data', (d) => push(d, 'out'));
  child.stderr.on('data', (d) => push(d, 'err'));
  child.on('error', (e) => {
    running.delete(id);
    onDone?.({ id, code: -1, error: e.message });
  });
  child.on('close', (code, signal) => {
    running.delete(id);
    onDone?.({ id, code, signal: signal || null, error: null });
  });
  return { id, bin };
}

/** Stop a run. rsync leaves a partial file behind unless told otherwise. */
function cancel(id) {
  const child = running.get(id);
  if (!child) return { ok: false };
  try { child.kill('SIGINT'); } catch { /* the process may already have exited */ }
  // SIGINT lets rsync tidy up; if it will not go, insist shortly after.
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* the process may already have exited */ } }, 4000).unref?.();
  return { ok: true };
}

function cancelAll() {
  for (const id of [...running.keys()]) cancel(id);
}

/**
 * The exit codes worth explaining. rsync has about thirty and most of them
 * are "something went wrong"; these are the ones with a specific, actionable
 * cause that the output alone does not make obvious.
 */
const CODES = {
  1: 'syntax or usage error',
  2: 'protocol incompatibility — the rsync on the far side is too old',
  3: 'errors selecting input or output files',
  5: 'error starting the client-server protocol — often no rsync on the far side',
  10: 'error in socket I/O',
  11: 'error in file I/O',
  12: 'error in the rsync protocol data stream',
  20: 'interrupted',
  23: 'some files could not be transferred — check the errors above',
  24: 'some files vanished while it was running',
  30: 'timed out',
  127: 'rsync was not found on the far side',
};

function explain(code) {
  if (code === 0) return 'Finished.';
  return CODES[code] ? `rsync exited ${code}: ${CODES[code]}` : `rsync exited ${code}.`;
}

module.exports = { check, run, cancel, cancelAll, explain, find, unsupportedReason };
