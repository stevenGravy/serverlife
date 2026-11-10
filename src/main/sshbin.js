'use strict';
/**
 * Finding the OpenSSH client — and coping when there isn't one.
 *
 * On macOS and Linux `ssh` is part of the system and a bare `ssh` always
 * resolves. Windows is different: the OpenSSH client is an *optional* feature,
 * absent by default on Server editions and on plenty of desktops, and where it
 * does exist it lives in `System32\OpenSSH` rather than anywhere on `PATH` for
 * a GUI process. Other copies arrive with Git for Windows or a manual install.
 *
 * So the binary is looked for in the places it actually lives, and its absence
 * is reported rather than discovered as a failed connection. A Teleport node
 * needs no ssh at all — `tsh ssh` dials it directly — so the app can carry on
 * without one; a plain ssh_config host genuinely cannot be reached, and saying
 * so plainly beats a spawn error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const WINDOWS = process.platform === 'win32';

function candidates() {
  const env = process.env;
  if (WINDOWS) {
    const sysRoot = env.SystemRoot || 'C:\\Windows';
    const programs = env.ProgramFiles || 'C:\\Program Files';
    const programsX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      env.SSH_PATH,
      // The optional Windows feature, and the one most machines have.
      path.join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe'),
      path.join(sysRoot, 'Sysnative', 'OpenSSH', 'ssh.exe'),
      // Manual installs of Win32-OpenSSH.
      path.join(programs, 'OpenSSH', 'ssh.exe'),
      path.join(programs, 'OpenSSH-Win64', 'ssh.exe'),
      path.join(programsX86, 'OpenSSH', 'ssh.exe'),
      // Bundled with Git for Windows.
      path.join(programs, 'Git', 'usr', 'bin', 'ssh.exe'),
      path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Programs', 'Git', 'usr', 'bin', 'ssh.exe'),
      'ssh.exe',
    ].filter(Boolean);
  }
  return [
    env.SSH_PATH,
    '/usr/bin/ssh',
    '/usr/local/bin/ssh',
    '/opt/homebrew/bin/ssh',
    '/opt/local/bin/ssh', // MacPorts
    path.join(os.homedir(), '.nix-profile', 'bin', 'ssh'), // per-user Nix profile
    '/nix/var/nix/profiles/default/bin/ssh', // system-wide Nix profile
    '/home/linuxbrew/.linuxbrew/bin/ssh', // Linuxbrew
    'ssh',
  ].filter(Boolean);
}

let cache = null;
let searched = [];
let override = null;
let versionCache = null;

function setSshPath(p) {
  override = String(p || '').trim() || null;
  cache = null;
  versionCache = null;
  return override;
}

/** Ask the OS, for an install in a place worth not hard-coding. */
function whichSsh() {
  try {
    const out = execFileSync(WINDOWS ? 'where' : 'which', ['ssh'], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    const first = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    return first && fs.existsSync(first) ? first : null;
  } catch { return null; }
}

/** The ssh to spawn. Always returns something runnable-looking. */
function findSsh() {
  if (cache) return cache;
  if (override) { cache = override; return cache; }
  const bare = WINDOWS ? 'ssh.exe' : 'ssh';
  searched = candidates();
  for (const p of searched) {
    if (p === bare) continue;
    try { if (fs.existsSync(p)) { cache = p; return cache; } } catch { /* unreadable path: not a candidate */ }
  }
  cache = whichSsh() || bare;
  return cache;
}

/** Is there really an ssh client here? */
function sshAvailable() {
  const resolved = findSsh();
  if (resolved === 'ssh' || resolved === 'ssh.exe') return !!whichSsh();
  try { return fs.existsSync(resolved); } catch { return false; }
}

function sshStatus() {
  return {
    path: findSsh(),
    found: sshAvailable(),
    override,
    searched,
    // Windows is the only platform where its absence is expected.
    optionalHere: WINDOWS,
    version: sshVersion(),
  };
}

/**
 * `ssh -V`'s one-line banner ("OpenSSH_9.4p1, LibreSSL 3.3.6"), parsed into a
 * comparable {major, minor, patch}. OpenSSH prints it to stderr and exits 0,
 * so it has to be read with spawnSync rather than execFileSync, which only
 * ever hands back stdout on success.
 */
function parseSshVersion(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/OpenSSH[_ ](?:for_Windows_)?(\d+)\.(\d+)(?:p(\d+))?/i);
  if (!m) return { raw, major: null, minor: null, patch: null };
  return { raw, major: Number(m[1]), minor: Number(m[2]), patch: m[3] ? Number(m[3]) : 0 };
}

function sshVersion() {
  const resolved = findSsh();
  if (versionCache && versionCache.path === resolved) return versionCache.info;
  let info = null;
  try {
    const res = spawnSync(resolved, ['-V'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    const text = (res && (res.stderr || res.stdout)) || '';
    info = text.trim() ? parseSshVersion(text) : null;
  } catch { info = null; }
  versionCache = { path: resolved, info };
  return info;
}

/**
 * The minimum OpenSSH release a feature needs, so a stale system client (the
 * macOS-shipped one is a frequent offender) can be named as the reason
 * something doesn't work, instead of a bare "that flag isn't understood."
 */
const FEATURE_MIN_VERSION = {
  securityKeyIdentities: [8, 2],  // ed25519-sk / ecdsa-sk (FIDO2) keys
  proxyJumpFlag: [7, 3],          // -J, rather than a ProxyCommand workaround
  certificateFiles: [5, 6],       // CertificateFile in ssh_config
};

/** Unknown feature or unreadable version: never block on what can't be checked. */
function supportsFeature(name) {
  const min = FEATURE_MIN_VERSION[name];
  if (!min) return true;
  const v = sshVersion();
  if (!v || v.major == null) return true;
  if (v.major !== min[0]) return v.major > min[0];
  return v.minor >= min[1];
}

/**
 * A sibling OpenSSH tool — `ssh-add`, `ssh-keygen`, `ssh-copy-id`.
 *
 * They ship in the same directory as `ssh`, so the search that already found
 * `ssh` answers for them too: look next to it first, then ask the OS, then fall
 * back to the bare name so a spawn still has something to try. Resolving them
 * separately matters on Windows, where none of this is on a GUI process's PATH,
 * and on any machine where the client was installed somewhere unusual.
 */
function findTool(name) {
  const exe = WINDOWS ? `${name}.exe` : name;
  const beside = path.join(path.dirname(findSsh()), exe);
  try { if (fs.existsSync(beside)) return beside; } catch { /* unreadable path: try PATH instead */ }
  try {
    const out = execFileSync(WINDOWS ? 'where' : 'which', [name], {
      timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    const first = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch { /* not on PATH: the bare name is the last resort */ }
  return exe;
}

/**
 * Is that tool really here? Distinguishing "missing" from "failed" is the
 * whole point: a spawn of something absent throws, and a caller that cannot
 * tell the two apart reports a broken agent when the truth is no client.
 */
function toolAvailable(name) {
  const resolved = findTool(name);
  const exe = WINDOWS ? `${name}.exe` : name;
  if (resolved === exe) return false;      // nothing but the bare name to go on
  try { return fs.existsSync(resolved); } catch { return false; }
}

/** Environment for a spawned ssh: the binary's own directory has to be findable. */
function sshEnv(extra) {
  const resolved = findSsh();
  const dir = path.dirname(resolved);
  const current = process.env.PATH || process.env.Path || '';
  const env = { ...process.env, ...(extra || {}) };
  if (dir && dir !== '.' && !current.split(path.delimiter).includes(dir)) {
    env.PATH = [current, dir].filter(Boolean).join(path.delimiter);
  }
  return env;
}

module.exports = {
  findSsh, sshAvailable, sshStatus, setSshPath, sshEnv, findTool, toolAvailable,
  sshVersion, supportsFeature, parseSshVersion,
};
