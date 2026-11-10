'use strict';
/**
 * Live log tailing for the Log Viewer — one pod, or every pod behind a
 * label selector, streamed line by line to a renderer pane with its own
 * filter box and a Download button. A terminal pane running `kubectl logs
 * -f` already covers "watch it scroll"; this covers "search it, and keep
 * it after the fact," which a live PTY has no structured lines to do.
 *
 * Same spawn/keep-until-stopped lifecycle as kubeforward.js, just reading
 * stdout a line at a time instead of scanning for one match.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const kube = require('./kube');

/** id -> { child } */
const running = new Map();

/**
 * Start tailing. `onEvent({line})` fires once per line (stdout and stderr
 * both — a crashing container's last words are usually on stderr);
 * `onEvent({done, code})` fires once, on exit, after which `id` is no
 * longer running.
 */
function start({ id, spec = {}, podName, selector, namespace, containerName, allContainers, tail, previous } = {}, onEvent) {
  if (!id) throw new Error('No id given.');
  if (running.has(id)) throw new Error('That log session is already running.');
  const { bin, args, env } = kube.logArgs({ ...spec, namespace, podName, selector, containerName }, {
    follow: true, previous: !!previous, tail: tail ?? 200, allContainers: !!allContainers,
  });

  const child = spawn(bin, args, { env });
  running.set(id, { child });

  const pipe = (stream) => {
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => onEvent({ line }));
  };
  pipe(child.stdout);
  pipe(child.stderr);

  let settledCode = null;
  child.on('error', (e) => {
    running.delete(id);
    onEvent({ done: true, code: null, error: e.message });
  });
  child.on('exit', (code) => {
    settledCode = code;
    if (!running.has(id)) return; // already reported by the 'error' handler above
    running.delete(id);
    onEvent({ done: true, code: settledCode });
  });

  return { id };
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

module.exports = { start, stop, stopAll };
