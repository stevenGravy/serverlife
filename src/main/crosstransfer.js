'use strict';
/**
 * Server-to-server file transfer.
 *
 * Two routes:
 *   direct — both endpoints are Teleport nodes on the same proxy and cluster,
 *            so `tsh scp` moves the bytes server-to-server and they never
 *            touch this machine.
 *   relay  — anything else (different clusters, plain SSH, or a mix). The
 *            data is pulled down to a temp directory and pushed back up, so
 *            the caller must confirm: it costs bandwidth and briefly writes
 *            the file to local disk.
 */

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const { downloadFile, uploadFile, posixJoin } = require('./transfers');
const teleport = require('./teleport');

/**
 * The oldest tsh that copies remote-to-remote.
 *
 * tsh 17 does not refuse `tsh scp user@a:/src user@b:/dest`: it reads the
 * destination as a *local* path, downloads the files into a folder named
 * `user@b:` in its working directory, and exits 0. The copy looks finished,
 * the destination never gets the files, and they land on this machine.
 * Found by tests/integration on tsh 17.7.30; tsh 18 copies as asked.
 */
const DIRECT_MIN_TSH_MAJOR = 18;

/** Can these two connections hand off directly? */
async function planRoute(srcConn, destConn) {
  const s = srcConn.spec?.node;
  const d = destConn.spec?.node;
  const bothTeleport = srcConn.type === 'teleport' && destConn.type === 'teleport';
  if (bothTeleport && s && d && s.proxy === d.proxy && s.cluster === d.cluster) {
    const v = await teleport.version().catch(() => null);
    const major = Number(String(v || '').split('.')[0]) || null;
    if (!major || major < DIRECT_MIN_TSH_MAJOR) {
      return {
        mode: 'relay',
        reason: `Both nodes are on ${s.cluster}, but tsh ${v || '(version unknown)'} cannot copy server-to-server `
          + `(that needs tsh ${DIRECT_MIN_TSH_MAJOR} or newer). Files will be downloaded to this machine and uploaded to the destination.`,
      };
    }
    return { mode: 'direct', reason: `Both nodes are on ${s.cluster}; tsh will copy them server-to-server.` };
  }
  const why = !bothTeleport
    ? 'At least one endpoint is a plain SSH host.'
    : 'The nodes are on different Teleport clusters.';
  return {
    mode: 'relay',
    reason: `${why} Files will be downloaded to this machine and uploaded to the destination.`,
  };
}

function scpTarget(conn, remotePath) {
  const node = conn.spec?.node;
  const login = conn.spec?.login || conn.remoteUser;
  return `${login ? login + '@' : ''}${node.hostname || node.name}:${remotePath}`;
}

/**
 * Direct hand-off with `tsh scp`. Progress is scraped from tsh's own meter,
 * which reports a percentage per file.
 */
function runDirect({ srcConn, destConn, entries, destDir, onProgress, setFile, signal, totalBytes }) {
  const node = srcConn.spec.node;
  return new Promise((resolve, reject) => {
    const args = [];
    if (node.proxy) args.push('--proxy=' + node.proxy);
    args.push('scp', '-r', '-q');
    if (node.cluster) args.push('--cluster=' + node.cluster);
    for (const e of entries) args.push(scpTarget(srcConn, e.path));
    args.push(scpTarget(destConn, destDir.endsWith('/') ? destDir : destDir + '/'));

    const p = spawn(teleport.findTsh(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Both ends are in the same cluster for a direct hand-off, so the source
      // node's tsh home is the one that holds the certificate.
      env: teleport.tshEnv(node.home || teleport.homeForProxy(node.proxy), node.proxy),
    });

    let err = '';
    let completedFiles = 0;
    const perFile = totalBytes && entries.length ? totalBytes / entries.length : 0;

    const onChunk = (buf) => {
      const text = buf.toString();
      err += text;
      if (err.length > 8000) err = err.slice(-8000);
      // tsh prints "name [####] NN%" and repeats per file.
      const matches = [...text.matchAll(/(\S+)\s+\[[^\]]*\]\s+(\d+)%/g)];
      for (const m of matches) {
        const name = m[1];
        const pct = Number(m[2]);
        setFile?.(name);
        if (perFile) onProgress?.(Math.min(totalBytes, completedFiles * perFile + (pct / 100) * perFile), totalBytes);
        if (pct === 100) completedFiles++;
      }
    };
    p.stdout.on('data', onChunk);
    p.stderr.on('data', onChunk);

    const onAbort = () => { try { p.kill('SIGKILL'); } catch { /* the process may already have exited */ } };
    signal?.addEventListener('abort', onAbort, { once: true });

    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      if (code !== 0) {
        const clean = err.replace(/\S+\s+\[[^\]]*\]\s+\d+%/g, '').replace(/\s+/g, ' ').trim();
        return reject(new Error(clean || `tsh scp failed (exit ${code})`));
      }
      onProgress?.(totalBytes, totalBytes);
      resolve();
    });
  });
}

/** Pull down to a temp dir, push back up, then clean up. */
async function runRelay({ srcConn, destConn, files, destDir, onProgress, setFile, signal }) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'serverlife-relay-'));
  const srcSftp = await srcConn.getSftp();
  const destSftp = await destConn.getSftp();

  // Each byte is moved twice, so the progress denominator is doubled.
  const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
  const grand = totalBytes * 2;
  let moved = 0;

  try {
    // Recreate the directory structure on the destination first.
    const madeDirs = new Set();
    for (const f of files) {
      const rel = f.rel;
      const destPath = posixJoin(destDir, rel);
      const parent = destPath.slice(0, destPath.lastIndexOf('/'));
      if (parent && !madeDirs.has(parent)) {
        await mkdirp(destSftp, parent, madeDirs);
      }
    }

    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) throw new Error('cancelled');
      const f = files[i];
      setFile?.(f.rel, i + 1);

      const local = path.join(tmpRoot, f.rel.replace(/\//g, '__'));
      const base = moved;
      await downloadFile(srcSftp, f.path, local, {
        signal,
        onProgress: (d) => onProgress?.(base + d, grand),
      });
      moved = base + (f.size || 0);

      const base2 = moved;
      await uploadFile(destSftp, local, posixJoin(destDir, f.rel), {
        signal,
        onProgress: (d) => onProgress?.(base2 + d, grand),
      });
      moved = base2 + (f.size || 0);

      await fsp.unlink(local).catch(() => {});
    }
    onProgress?.(grand, grand);
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function mkdirp(sftp, dir, made) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    if (made.has(cur)) continue;
    await sftp.mkdir(cur).catch(() => {}); // already-exists is fine
    made.add(cur);
  }
}

/** Flatten the selection into files with destination-relative paths. */
async function planCross(srcConn, entries) {
  const sftp = await srcConn.getSftp();
  const files = [];
  for (const e of entries) {
    const isDir = e.type === 'directory' || e.targetType === 'directory';
    if (!isDir) {
      const a = await sftp.stat(e.path).catch(() => ({ size: 0 }));
      files.push({ path: e.path, rel: e.name, size: a.size ?? 0 });
      continue;
    }
    const walk = async (dir, prefix) => {
      const kids = await sftp.list(dir);
      for (const k of kids) {
        const rel = prefix + '/' + k.name;
        if (k.type === 'directory') await walk(k.path, rel);
        else if (k.type === 'file') files.push({ path: k.path, rel, size: k.size || 0 });
      }
    };
    await walk(e.path, e.name);
  }
  return files;
}

/**
 * Queue a server-to-server transfer on the destination connection.
 * Returns {jobId, mode}.
 */
async function transfer({ srcConn, destConn, entries, destDir, mode }) {
  const route = await planRoute(srcConn, destConn);
  // Relay can always be asked for; direct only where the route allows it — a
  // caller asking for direct with a tsh that cannot do it would get the
  // silent misdelivery described at DIRECT_MIN_TSH_MAJOR.
  const chosen = route.mode === 'direct' ? (mode || 'direct') : 'relay';

  const files = await planCross(srcConn, entries);
  const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
  const label = entries.length === 1 ? entries[0].name : `${entries.length} items`;

  const jobId = destConn.queue.add({
    kind: 'cross',
    label: `${srcConn.label}: ${label} → ${destConn.label}:${destDir}`,
    items: files.map((f) => ({ size: f.size })),
    dirs: [],
    customRun: ({ onProgress, setFile, signal }) => (
      chosen === 'direct'
        ? runDirect({ srcConn, destConn, entries, destDir, onProgress, setFile, signal, totalBytes })
        : runRelay({ srcConn, destConn, files, destDir, onProgress, setFile, signal })
    ),
  });

  return { jobId, mode: chosen, route, fileCount: files.length, totalBytes };
}

module.exports = { transfer, planRoute, planCross, DIRECT_MIN_TSH_MAJOR };
