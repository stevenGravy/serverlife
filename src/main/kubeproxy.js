'use strict';
/**
 * `tsh proxy kube` — a local proxy to a Teleport-proxied cluster's API
 * server, serving a kubeconfig any plain kubectl (or any other external
 * tool this app knows nothing about, running outside it) can point at
 * directly, with no exec plugin and no rewriting of the user's own
 * kubeconfig. KubeLife's own internal calls keep using kubectlArgsFor()'s
 * `tsh kube login`-based contexts (see kube.js) — this exists purely to
 * hand a cluster to something else.
 *
 * One proxy per context, kept running until stopped or the app quits — the
 * same lifecycle `tsh proxy aws` already has in awsproxy.js, mirrored here
 * almost exactly.
 */

const { spawn } = require('child_process');
const teleport = require('./teleport');

/** context id -> { child, info: { port, kubeconfig, kubeClusterName, startedAt } } */
const running = new Map();

const PORT_RE = /Started local proxy for Kubernetes on [^:]+:(\d+)/;
const KUBECONFIG_RE = /KUBECONFIG="([^"]+)"/;

// eslint-disable-next-line no-control-regex
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

/** Start (or reuse) a proxy for one Teleport kube cluster context. */
function ensure(id, { kubeClusterName, proxy, home, teleportCluster } = {}) {
  if (!id) throw new Error('No context given.');
  if (!kubeClusterName) throw new Error('No Kubernetes cluster chosen.');
  const existing = running.get(id);
  if (existing && !existing.child.killed) return Promise.resolve(existing.info);

  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push('proxy', 'kube', kubeClusterName, '--proxy-log-output=stdout');
  if (teleportCluster) args.push('--cluster=' + teleportCluster);

  return new Promise((resolve, reject) => {
    const child = spawn(teleport.findTsh(), args, {
      env: teleport.tshEnv(home || teleport.homeForProxy(proxy), proxy),
    });

    let out = '';
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { try { child.kill(); } catch { /* already gone */ } reject(err); }
      else resolve(info);
    };

    const timer = setTimeout(() => {
      done(new Error(`Timed out waiting for "tsh proxy kube ${kubeClusterName}".`));
    }, 30000);

    const scan = (chunk) => {
      out += chunk;
      const portM = PORT_RE.exec(out);
      const cfgM = KUBECONFIG_RE.exec(out);
      if (portM && cfgM) {
        const info = { port: Number(portM[1]), kubeconfig: cfgM[1], kubeClusterName, startedAt: Date.now() };
        running.set(id, { child, info });
        done(null, info);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', (e) => done(new Error(`Could not run tsh: ${e.message}`)));
    child.on('exit', (code) => {
      running.delete(id);
      if (settled) return;
      const text = stripAnsi(out).trim();
      done(new Error(text.split('\n').filter(Boolean).pop() || `tsh proxy kube exited with code ${code}`));
    });
  });
}

function stop(id) {
  const r = running.get(id);
  if (!r) return false;
  try { r.child.kill(); } catch { /* already gone */ }
  running.delete(id);
  return true;
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

function status(id) {
  const r = running.get(id);
  return r ? r.info : null;
}

module.exports = { ensure, stop, stopAll, status };
