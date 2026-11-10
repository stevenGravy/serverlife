'use strict';
/**
 * `kubectl kustomize <dir>` — kustomize is built into kubectl itself, so
 * this needs nothing extra installed (the standalone `kustomize` binary
 * `kubebin.js` separately tracks is unrelated). A pure local render, same
 * as `helm template`: nothing here touches the cluster, which is exactly
 * why the result still goes through the regular diff/apply flow before
 * anything is sent to one.
 */

const { execFile } = require('child_process');
const kube = require('./kube');

function run(bin, args, { env, timeout = 20000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

async function build(spec = {}, { dir } = {}) {
  if (!dir) return { ok: false, error: 'No kustomization directory given.' };
  const { bin, baseArgs, env } = kube.kubectlArgsFor(spec);
  const r = await run(bin, [...baseArgs, 'kustomize', dir], { env });
  return r.ok ? { ok: true, yaml: r.stdout } : { ok: false, error: plain(r.stderr) || 'kubectl kustomize failed' };
}

module.exports = { build };
