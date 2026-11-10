'use strict';
/**
 * Browsing a pod's filesystem — the same explorer SSH sessions get, for a
 * kube exec session.
 *
 * There is no SFTP subsystem inside a container, and no sftp-server binary
 * to rely on being there (`kubectl exec`'s target is whatever the image
 * ships, often nothing but the application itself and a shell). So listing,
 * making and removing things run as POSIX shell one-liners over `kubectl
 * exec`, shaped to work under both GNU coreutils and BusyBox — the two
 * userlands almost every real-world image ships one of — the same
 * portability concern cityscan.js's remote scan already solved for ssh
 * hosts. Reading and writing a file's contents has no exec equivalent at
 * all, so those go through `kubectl cp`, which is its own protocol (tar
 * over the exec stream) and therefore has no byte-range or resume support —
 * worth knowing, not worth hiding.
 *
 * Every function here takes the same `spec` shape listContexts() already
 * returns (kubeconfigPaths, contextName) plus namespace/podName/
 * containerName — the file browser's "connection" is just those fields,
 * not a Connection instance.
 */

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const kube = require('./kube');

function run(bin, args, { env, timeout = 20000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
  });
}

/** `kubectl exec <pod> [-c container] -- sh -c <script> sh <args...>` — args land in the script as $1, $2, … */
function execSh(spec, script, args = []) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(spec);
  const argv = [...baseArgs, 'exec', spec.podName];
  if (spec.containerName) argv.push('-c', spec.containerName);
  argv.push('--', 'sh', '-c', script, 'sh', ...args);
  return run(bin, argv, { env });
}

function podTarget(spec, remotePath) {
  return `${spec.namespace}/${spec.podName}:${remotePath}`;
}

/** All entries directly inside one directory, hidden files included, `.`/`..` excluded. */
const LS_SCRIPT = `
dir=$1
for f in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  stat -c '%n\t%F\t%s\t%Y\t%a' "$f" 2>/dev/null || stat -c '%n\t%F\t%s\t%Y\t%a' -L "$f" 2>/dev/null
done
`;

function parseType(ftype) {
  if (/directory/i.test(ftype)) return 'directory';
  if (/symbolic/i.test(ftype)) return 'symlink';
  return 'file';
}

async function ls(spec, dir) {
  // Stripped so the script's "$dir"/* glob never doubles up at the root
  // (dir='/' + '/*' would otherwise read back as '//bin', not '/bin').
  const cleanDir = dir.replace(/\/+$/, '') || '/';
  const r = await execSh(spec, LS_SCRIPT, [cleanDir]);
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'Could not list that directory', entries: [] };
  const entries = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [full, ftype, size, mtime, mode] = line.split('\t');
    const name = full.slice(cleanDir.length).replace(/^\/+/, '');
    return {
      name,
      path: cleanDir === '/' ? '/' + name : `${cleanDir}/${name}`,
      type: parseType(ftype || ''),
      size: Number(size) || 0,
      mode: parseInt(mode, 8) || 0,
      modeString: '',
      mtime: (Number(mtime) || 0) * 1000,
      owner: null,
      group: null,
    };
  }).filter((e) => e.name);
  return { ok: true, entries };
}

function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

async function mkdir(spec, dir) {
  const r = await execSh(spec, 'mkdir -p "$1"', [dir]);
  return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'mkdir failed' };
}

/** Recursive, same as the local/SFTP "remove" action — the caller already confirmed. */
async function rm(spec, target) {
  const r = await execSh(spec, 'rm -rf "$1"', [target]);
  return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'rm failed' };
}

async function rename(spec, from, to) {
  const r = await execSh(spec, 'mv "$1" "$2"', [from, to]);
  return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'mv failed' };
}

/** `kubectl cp` through a temp file — the one operation with no plain-exec equivalent. */
async function readFile(spec, remotePath) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(spec);
  const tmp = path.join(os.tmpdir(), `kubelife-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const r = await run(bin, [...baseArgs, 'cp', podTarget(spec, remotePath), tmp], { env, timeout: 30000 });
  if (!r.ok) { try { await fsp.unlink(tmp); } catch { /* never written */ } return { ok: false, error: plain(r.stderr) || 'kubectl cp failed' }; }
  try {
    const data = await fsp.readFile(tmp);
    return { ok: true, data: data.toString('base64') };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { await fsp.unlink(tmp); } catch { /* best effort */ }
  }
}

async function writeFile(spec, remotePath, base64Data) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(spec);
  const tmp = path.join(os.tmpdir(), `kubelife-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await fsp.writeFile(tmp, Buffer.from(base64Data || '', 'base64'));
    const r = await run(bin, [...baseArgs, 'cp', tmp, podTarget(spec, remotePath)], { env, timeout: 30000 });
    return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'kubectl cp failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { await fsp.unlink(tmp); } catch { /* best effort */ }
  }
}

/**
 * Moving a file or a whole directory in or out, straight to/from a real
 * path on disk — `kubectl cp` already speaks tar over the exec stream, so
 * unlike readFile/writeFile (shaped for the single-file edit-in-a-textarea
 * case, which needs the bytes in hand to show them) there is no reason to
 * round-trip this through base64 over IPC: large or binary files just go
 * straight through. The timeout is generous and there is still no progress
 * reporting or resume — the same limitation documented at the top of this
 * file — so this is the right tool for "move this file" and the wrong one
 * for "move this 20GB volume."
 */
async function downloadPath(spec, remotePath, localPath) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(spec);
  const r = await run(bin, [...baseArgs, 'cp', podTarget(spec, remotePath), localPath], { env, timeout: 300000 });
  return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'kubectl cp failed' };
}

async function uploadPath(spec, localPath, remotePath) {
  const { bin, baseArgs, env } = kube.kubectlArgsFor(spec);
  const r = await run(bin, [...baseArgs, 'cp', localPath, podTarget(spec, remotePath)], { env, timeout: 300000 });
  return r.ok ? { ok: true } : { ok: false, error: plain(r.stderr) || 'kubectl cp failed' };
}

module.exports = { ls, mkdir, rm, rename, readFile, writeFile, downloadPath, uploadPath, parseType };
