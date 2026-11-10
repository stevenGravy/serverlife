'use strict';
/**
 * A Popeye scan — the cluster-linting roadmap item, scoped to Popeye
 * itself rather than kube-bench or image-vulnerability scanning: both of
 * those need a fundamentally different integration (a Job running inside
 * the cluster against node-local files, or a registry-aware scanner),
 * not "shell out to a CLI and parse its JSON" the way this is. Popeye
 * reads the kubeconfig directly through its own embedded client — it has
 * no `tsh` integration of its own, so it only works where a real
 * `kubectl` (and therefore a real, plain kubeconfig) is available.
 *
 * Popeye's own exit code is non-zero whenever it found anything to
 * report (by design — it's meant for CI gating, see its own
 * `--force-exit-zero`/`--min-score` flags) — confirmed against a real
 * cluster. Success here means "stdout parsed as JSON," not "exit 0."
 */

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const kube = require('./kube');
const kubebin = require('./kubebin');

function run(bin, args, { env, timeout = 120000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
  });
}

/** `kubectl describe`-style ANSI stripping — Popeye's own stderr/log lines carry colour codes too. */
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

/**
 * Popeye's own argv — pure, so the shape (context/namespace flags, JSON
 * output, logs redirected off stdout) is testable without spawning
 * anything. `logFile` is passed in rather than built here so a test can
 * supply a fixed one instead of a timestamped, impossible-to-predict name.
 */
function buildArgs(spec, { namespace } = {}, logFile) {
  return [
    ...(spec?.contextName ? ['--context', spec.contextName] : []),
    ...(namespace ? ['-n', namespace] : ['-A']),
    '-o', 'json', '--logs', logFile,
  ];
}

async function scan(spec = {}, { namespace } = {}) {
  if (!kubebin.kubectlAvailable()) {
    return { ok: false, error: 'Popeye needs a working kubectl on this machine to read your kubeconfig directly — install kubectl to enable cluster scans.' };
  }
  const bin = kubebin.findTool('popeye');
  if (!kubebin.toolAvailable('popeye')) {
    return { ok: false, error: 'Popeye is not installed. Get it from https://github.com/derailed/popeye and it will be picked up automatically.' };
  }
  const env = kube.kubeconfigEnvFor(spec);
  const logFile = path.join(os.tmpdir(), `serverlife-popeye-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const args = buildArgs(spec, { namespace }, logFile);
  const r = await run(bin, args, { env });
  // A log file is harmless clutter once read; nothing here depends on it surviving.
  fs.promises.unlink(logFile).catch(() => {});
  let data;
  try { data = JSON.parse(r.stdout); } catch {
    return { ok: false, error: plain(r.stderr) || 'Could not read Popeye\'s own output.' };
  }
  return { ok: true, report: data.popeye };
}

module.exports = { scan, buildArgs };
