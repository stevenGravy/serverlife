'use strict';
/**
 * Local filesystem browsing and local shell terminals — the left-hand pane of
 * the dual-pane file manager, and the "local shell" tab.
 */

const fs = require('fs');
const fsx = require('./fsx');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

function modeString(mode, isDir, isLink) {
  const t = isLink ? 'l' : isDir ? 'd' : '-';
  const bits = 'rwxrwxrwx';
  let s = t;
  for (let i = 0; i < 9; i++) s += (mode & (1 << (8 - i))) ? bits[i] : '-';
  return s;
}

/**
 * uid/gid to account names.
 *
 * Node exposes no getpwuid, so the databases are read directly and cached for
 * the life of the process — they are a few kilobytes and change about never.
 * This only knows about local accounts: a uid that comes from a directory
 * service is not in the file, and the caller shows the number instead, which
 * is the truth rather than a guess. Windows has no uid to translate at all.
 */
const idNames = { user: null, group: null };

function readIdFile(file) {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const f = line.split(':');
      // name:password:id:...
      if (f.length < 3 || !/^\d+$/.test(f[2])) continue;
      if (!map.has(Number(f[2]))) map.set(Number(f[2]), f[0]);
    }
  } catch { /* an unreadable file just maps no ids */ }
  return map;
}

function userName(uid) {
  if (process.platform === 'win32' || uid === undefined) return null;
  // The account this process runs as is known without reading anything, and on
  // a personal machine it owns nearly every file in sight.
  try { const me = os.userInfo(); if (me.uid === uid) return me.username; } catch { /* no name for this id; the number is shown instead */ }
  if (!idNames.user) idNames.user = readIdFile('/etc/passwd');
  return idNames.user.get(uid) || null;
}

function groupName(gid) {
  if (process.platform === 'win32' || gid === undefined) return null;
  if (!idNames.group) idNames.group = readIdFile('/etc/group');
  return idNames.group.get(gid) || null;
}

async function list(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let st = null;
    try { st = await fsp.lstat(full); } catch { continue; }
    const isLink = st.isSymbolicLink();
    let targetType = null;
    if (isLink) {
      try { const s2 = await fsp.stat(full); targetType = s2.isDirectory() ? 'directory' : 'file'; }
      catch { targetType = 'broken'; }
    }
    out.push({
      name: e.name,
      path: full,
      type: isLink ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'special',
      targetType,
      size: st.size,
      mode: st.mode & 0o7777,
      modeString: modeString(st.mode, st.isDirectory(), isLink),
      mtime: st.mtimeMs,
      atime: st.atimeMs,
      // Carried on every entry so the details columns cost no extra call:
      // lstat has already been paid for.
      uid: st.uid, gid: st.gid,
      owner: userName(st.uid),
      group: groupName(st.gid),
      links: st.nlink,
    });
  }
  return out;
}

// Guarded because a Windows drive root cannot be created, only found.
async function ensureDir(p) { return fsx.ensureDir(p); }

/**
 * What a folder (or file) actually is: the stat every file manager shows, plus
 * an immediate child count. The recursive total is deliberately not computed
 * here — on a deep tree that is a walk of everything, and it belongs behind a
 * button the user presses knowingly.
 */
async function info(p) {
  const st = await fsp.lstat(p);
  const isLink = st.isSymbolicLink();
  let target = null;
  if (isLink) {
    try { target = await fsp.readlink(p); } catch { /* not a link, or unreadable: no target to show */ }
  }
  const type = isLink ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'special';

  let files = null;
  let dirs = null;
  if (st.isDirectory()) {
    files = 0; dirs = 0;
    try {
      for (const e of await fsp.readdir(p, { withFileTypes: true })) {
        if (e.isDirectory()) dirs++; else files++;
      }
    } catch { files = null; dirs = null; }
  }

  return {
    path: p, name: path.basename(p) || p, type, target,
    size: st.size,
    mode: st.mode & 0o7777,
    modeString: modeString(st.mode, st.isDirectory(), isLink),
    uid: st.uid, gid: st.gid,
    owner: userName(st.uid), group: groupName(st.gid),
    mtime: st.mtimeMs, atime: st.atimeMs, ctime: st.ctimeMs, birthtime: st.birthtimeMs,
    links: st.nlink,
    files, dirs,
  };
}

/**
 * Add a tree up. Capped so that "get info" on `/` cannot turn into a job that
 * never ends — what comes back says whether it stopped early.
 */
async function treeSize(root, { maxEntries = 400000, maxMs = 20000 } = {}) {
  const started = Date.now();
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let truncated = false;
  const stack = [root];

  while (stack.length) {
    if (files + dirs >= maxEntries || Date.now() - started > maxMs) { truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { files++; continue; }   // never follow: loops
      if (e.isDirectory()) { dirs++; stack.push(full); continue; }
      files++;
      try { bytes += (await fsp.lstat(full)).size; } catch { /* gone or unreadable: it adds nothing to the total */ }
    }
  }
  return { bytes, files, dirs, truncated };
}

async function removeEntry(p) {
  const st = await fsp.lstat(p);
  if (st.isDirectory() && !st.isSymbolicLink()) await fsp.rm(p, { recursive: true, force: true });
  else await fsp.unlink(p);
}

function parentOf(p) {
  const up = path.dirname(p);
  return up === p ? p : up;
}

function homeDir() { return os.homedir(); }

/** Common places worth one click. */
function shortcuts() {
  const home = os.homedir();
  const candidates = [
    { name: 'Home', path: home },
    { name: 'Desktop', path: path.join(home, 'Desktop') },
    { name: 'Documents', path: path.join(home, 'Documents') },
    { name: 'Downloads', path: path.join(home, 'Downloads') },
    { name: 'Root', path: '/' },
    { name: 'Temp', path: os.tmpdir() },
  ];
  return candidates.filter((c) => { try { return fs.statSync(c.path).isDirectory(); } catch { return false; } });
}

/**
 * Of the paths given, the ones that are directories on this machine.
 *
 * Used for the automatically-starred folders: a star that points at something
 * which is not there is worse than no star, and only the app knows which of a
 * configured list actually exists.
 */
function existingDirs(paths) {
  const home = os.homedir();
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = String(raw || '').trim();
    if (!p) continue;
    const full = p === '~' ? home : (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
    try { if (fs.statSync(full).isDirectory()) out.push({ given: p, path: full }); } catch { /* not there: it is simply not listed */ }
  }
  return out;
}

/** The shell to open a local tab with, per platform. */
function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/** POSIX shells take -l for a login shell; Windows shells do not. */
function loginArgs(shellPath) {
  if (process.platform === 'win32') return [];
  return /\/(bash|zsh|sh|fish|ksh)$/.test(shellPath) ? ['-l'] : [];
}

/**
 * Start without reading any startup file.
 *
 * Worth having for two quite different reasons: reproducing what a *script*
 * sees (no aliases, no prompt, no PATH your rc file added), and getting a
 * working shell when an rc file is what just broke. Each shell spells it
 * differently, and one that has no way to say it is opened normally.
 */
function blankArgs(shellPath) {
  const name = String(shellPath).split('/').pop();
  if (name === 'bash') return ['--noprofile', '--norc'];
  if (name === 'zsh') return ['-f', '-d'];          // no rc files, no global ones
  if (name === 'fish') return ['--no-config'];
  if (name === 'tcsh' || name === 'csh') return ['-f'];
  if (name === 'ksh' || name === 'mksh') return ['-p'];
  // sh reads no rc file when it is neither a login shell nor interactive-with
  // -ENV set, so plain is already blank.
  return [];
}

/**
 * The shells on this machine, for the "open a shell" menu.
 *
 * `/etc/shells` is the list the system itself considers legitimate; the common
 * paths are checked as well because a shell installed by Homebrew is often
 * missing from it. Only what actually exists and is executable is returned.
 */
function listShells() {
  const seen = new Set();
  const out = [];
  const add = (p, note) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    try {
      fs.accessSync(p, fs.constants.X_OK);
    } catch { return; }
    const name = p.split(/[\\/]/).pop();
    out.push({
      path: p,
      name,
      // Whether a no-rc start is possible, so the menu can say so honestly.
      canBlank: blankArgs(p).length > 0 || name === 'sh',
      // Which one a plain "local shell" opens, so a list of shells can name it
      // rather than offering the same thing twice.
      isDefault: p === defaultShell(),
      note: note || '',
    });
  };

  if (process.platform === 'win32') {
    add(process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe', 'cmd');
    add('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'PowerShell');
    add('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'PowerShell 7');
    return out;
  }

  add(process.env.SHELL || '', 'your login shell');
  try {
    for (const line of fs.readFileSync('/etc/shells', 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) add(t);
    }
  } catch { /* no /etc/shells: the login shell is enough */ }
  for (const p of [
    '/bin/bash', '/bin/zsh', '/bin/sh', '/bin/ksh', '/bin/tcsh', '/bin/dash',
    '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish',
    '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/fish',
    '/usr/local/bin/bash', '/usr/local/bin/zsh', '/usr/local/bin/fish',
  ]) add(p);
  return out;
}

class LocalTerminals extends EventEmitter {
  constructor() { super(); this.terms = new Map(); }

  /**
   * Open a local PTY. With no `command` this is the user's login shell; with
   * one it runs that program directly, which is how recorded sessions are
   * replayed (`tsh play …`) in a tab.
   */
  open({ id, cols = 100, rows = 30, cwd, shell, command, args, teleportHome, blank, env: extraEnv }) {
    const useCommand = !!command;
    const file = useCommand ? command : (shell || defaultShell());
    const argv = useCommand
      ? (args || [])
      // A blank start is deliberately *not* a login shell: -l is what reads
      // the profile this is trying to avoid.
      : (blank ? blankArgs(file) : loginArgs(file));

    /*
     * A tsh run in a tab — a login, a recording, a Phase build console — is
     * the tsh the app chose, the same as every tsh it runs in the background:
     * with a picked binary, client-tools managed updates are off, or another
     * build named `tsh` hands the console to v18 (see tshEnv in teleport.js).
     */
    let toolsEnv = {};
    const teleport = require('./teleport');
    if (useCommand && command === teleport.findTsh()) {
      // The tsh variables from Settings, for the cluster this command names.
      toolsEnv = { ...teleport.envFor(teleport.proxyInArgs(argv)) };
      if (teleport.chosenTsh() && process.env.TELEPORT_TOOLS_VERSION === undefined
        && toolsEnv.TELEPORT_TOOLS_VERSION === undefined) {
        toolsEnv.TELEPORT_TOOLS_VERSION = 'off';
      }
    } else if (!useCommand) {
      // A plain shell: the every-cluster variables, if Settings asks for them there too.
      toolsEnv = teleport.envForShells();
    }
    const term = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols, rows,
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        // Inherited from a parent Electron/VS Code process this would make
        // any nested Electron tool misbehave.
        ELECTRON_RUN_AS_NODE: undefined,
        PATH: (process.env.PATH || '') + ':/usr/local/bin:/opt/homebrew/bin',
        // A replayed recording runs `tsh play`, which has to read the same tsh
        // home the recording was listed from.
        ...(teleportHome ? { TELEPORT_HOME: String(teleportHome) } : {}),
        ...toolsEnv,
        // A launched program's own settings — an AI assistant's session config.
        ...(extraEnv && typeof extraEnv === 'object' ? Object.fromEntries(
          Object.entries(extraEnv).map(([k, v]) => [String(k), String(v)])) : {}),
        // A blank shell says so, so a prompt or a script can tell.
        ...(blank ? { SERVERLIFE_BLANK_SHELL: '1' } : {}),
      },
    });
    this.terms.set(id, term);
    this._meta = this._meta || new Map();
    this._meta.set(id, { shell: file, blank: !!blank });
    term.onData((d) => this.emit('data', { id, data: d }));
    term.onExit(({ exitCode }) => { this.terms.delete(id); this.emit('exit', { id, exitCode }); });
    return { id, shell: file, blank: !!blank, args: argv };
  }

  /**
   * Where the shell in this tab currently is.
   *
   * Read from the process rather than asked of the shell: writing `pwd` into
   * someone's terminal to find out would show up in their session and in
   * their history. `/proc` on Linux, `lsof` elsewhere — both give the pty's
   * own cwd, which is the shell's, which is what `cd` moved.
   */
  async cwd(id) {
    const t = this.terms.get(id);
    const pid = t?.pid;
    if (!pid) return null;

    if (process.platform === 'linux') {
      try { return await fsp.readlink(`/proc/${pid}/cwd`); } catch { return null; }
    }
    if (process.platform === 'win32') return null;

    return new Promise((resolve) => {
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        timeout: 4000,
      }, (err, stdout) => {
        if (err) return resolve(null);
        // -Fn prints fields one per line; the cwd is the `n`-prefixed one.
        const line = String(stdout).split('\n').find((l) => l.startsWith('n'));
        resolve(line ? line.slice(1).trim() : null);
      });
    });
  }

  write(id, data) { const t = this.terms.get(id); if (t) t.write(data); }
  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (t) { try { t.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* the shell may already have exited */ } }
  }
  close(id) { const t = this.terms.get(id); if (t) { try { t.kill(); } catch { /* the shell may already have exited */ } this.terms.delete(id); } }
  closeAll() { for (const [id] of this.terms) this.close(id); }
}

/**
 * Free and total space on the volume holding `p`, in bytes — what the file
 * browser's footer shows beside the item count. `bavail`, not `bfree`: the
 * blocks reserved for root are not space this account can write into.
 */
async function diskSpace(p) {
  const st = await fsp.statfs(p);
  return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
}

module.exports = {
  list, ensureDir, removeEntry, parentOf, homeDir, shortcuts, LocalTerminals, modeString,
  listShells, existingDirs,
  info, treeSize, diskSpace,
};
