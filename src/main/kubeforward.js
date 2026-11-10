'use strict';
/**
 * `kubectl port-forward` to one pod/service/workload — table-stakes for a
 * cluster browser that KubeLife did not have at all. Same
 * spawn/scan-stdout/keep-running-until-stopped lifecycle
 * as kubeproxy.js's `tsh proxy kube`, just keyed so several of these can run
 * at once (one per resource, rather than one per context).
 */

const { spawn } = require('child_process');
const kube = require('./kube');

/** id -> { child, info: { port, resource, name, namespace, remotePort, contextName, startedAt } } */
const running = new Map();

const PORT_RE = /Forwarding from 127\.0\.0\.1:(\d+) ->/;

/*
 * Pushed, not polled: the UI (the sidebar's "active port-forwards" list and
 * the full browser's own count badge) needs to reflect a forward starting,
 * stopping, or dying on its own without the user ever reopening a menu to
 * find out. One `onChange` registration, called from main.js once at
 * startup to broadcast kube:forwardUpdate — this module stays IPC-agnostic,
 * same reasoning kubeproxy.js's own status() has for not owning its own
 * broadcast.
 */
const changeListeners = [];
function onChange(fn) { changeListeners.push(fn); }
function notify() { for (const fn of changeListeners) { try { fn(); } catch { /* one bad listener should not break the others */ } } }

/**
 * Start (or reuse) a port-forward. `localPort` left blank/0 lets kubectl
 * itself pick an open local port (its own `:REMOTE_PORT` syntax) — read back
 * out of its own "Forwarding from…" line rather than guessed at.
 */
function start({ id, spec = {}, resource, name, namespace, localPort, remotePort } = {}) {
  if (!id) throw new Error('No id given.');
  if (!resource || !name) throw new Error('No resource to forward.');
  if (!remotePort) throw new Error('No remote port given.');
  const existing = running.get(id);
  if (existing && !existing.child.killed) return Promise.resolve(existing.info);

  const { bin, baseArgs, env } = kube.kubectlArgsFor({ ...spec, namespace });
  const ports = `${localPort ? localPort : ''}:${remotePort}`;
  const args = [...baseArgs, 'port-forward', `${resource}/${name}`, ports];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env });

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
      done(new Error(`Timed out waiting for "kubectl port-forward ${resource}/${name}".`));
    }, 20000);

    const scan = (chunk) => {
      out += chunk;
      // stdout and stderr both run through this, and the match keeps
      // matching against the same accumulated `out` on every later chunk —
      // without the settled guard, a second chunk (even just a trailing
      // newline) re-ran the success path and double-fired notify().
      if (settled) return;
      const m = PORT_RE.exec(out);
      if (m) {
        const info = { port: Number(m[1]), resource, name, namespace, remotePort, contextName: spec.contextName || null, startedAt: Date.now() };
        running.set(id, { child, info });
        done(null, info);
        notify();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', (e) => done(new Error(`Could not run kubectl: ${e.message}`)));
    child.on('exit', (code) => {
      // An unexpected death (the pod went away, the cluster dropped the
      // connection) is still a change the UI needs to hear about, not just
      // a deliberate stop() — it is the same running.delete() either way.
      const wasRunning = running.has(id);
      running.delete(id);
      if (wasRunning) notify();
      if (settled) return;
      const text = out.trim();
      done(new Error(text.split('\n').filter(Boolean).pop() || `kubectl port-forward exited with code ${code}`));
    });
  });
}

function stop(id) {
  const r = running.get(id);
  if (!r) return false;
  try { r.child.kill(); } catch { /* already gone */ }
  running.delete(id);
  notify();
  return true;
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

function list() {
  return [...running.entries()].map(([id, r]) => ({ id, ...r.info }));
}

module.exports = { start, stop, stopAll, list, onChange };
