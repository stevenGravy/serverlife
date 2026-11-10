'use strict';
/**
 * History for the full browser's own CPU/memory charts. `kubectl top`
 * has no streaming mode — metrics-server only ever answers a point-in-
 * time question — so unlike kubeforward.js/kubelogs.js/kubewatch.js
 * (each tailing one long-lived kubectl process) this is a plain poll:
 * ask kuberesources.top() on an interval, turn its string-valued columns
 * ("123m", "456Mi", "45%" — exactly what `kubectl top` itself prints)
 * into numbers once here, and push each sample on. The renderer keeps
 * the actual history buffer and draws it, the same split the SSH "Live
 * stats" sparkline already uses (src/renderer/js/monitor.js) — this
 * module is the kube-flavoured half of that same shape, polling instead
 * of tailing because there is nothing here to tail.
 */

const kuberesources = require('./kuberesources');

/** "123m" -> 123, "2" -> 2000, anything unparseable -> 0 (never NaN, so a chart never breaks on a metrics-server gap). */
function parseCpu(v) {
  const s = String(v ?? '').trim();
  if (/m$/.test(s)) return Math.round(parseFloat(s)) || 0;
  return Math.round((parseFloat(s) || 0) * 1000);
}

const MEM_MULT = {
  '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
};
/** "456Mi" -> bytes, "1Gi" -> bytes, a bare number -> itself (bytes). Unparseable -> 0. */
function parseMemBytes(v) {
  const m = String(v ?? '').trim().match(/^([\d.]+)([KMGT]i?)?$/);
  if (!m) return 0;
  return Math.round((parseFloat(m[1]) || 0) * (MEM_MULT[m[2] || ''] ?? 1));
}

/** "45%" -> 45. Unparseable -> 0. */
function parsePercent(v) {
  const m = String(v ?? '').trim().match(/^([\d.]+)%?$/);
  return m ? Math.round(parseFloat(m[1])) : 0;
}

/** One kuberesources.top() result, numbers instead of kubectl's own strings — pure given that result. */
function snapshotFrom(topResult) {
  const nodes = (topResult.nodes?.ok ? topResult.nodes.items : []).map((n) => ({
    name: n.name, cpuM: parseCpu(n.cpu), cpuPercent: parsePercent(n.cpuPercent),
    memBytes: parseMemBytes(n.memory), memPercent: parsePercent(n.memoryPercent),
  }));
  const pods = (topResult.pods?.ok ? topResult.pods.items : []).map((p) => ({
    namespace: p.namespace, name: p.name, cpuM: parseCpu(p.cpu), memBytes: parseMemBytes(p.memory),
  }));
  return { at: Date.now(), ok: !!(topResult.nodes?.ok || topResult.pods?.ok), nodes, pods };
}

/** id -> { stopped: boolean, timer } */
const running = new Map();

/**
 * Poll `kubectl top` on an interval, starting immediately rather than
 * waiting a full interval for the first sample. `onSample(snapshot)`
 * fires on every poll, including a failed one (metrics-server missing or
 * slow) — `snapshot.ok` says which, same as kuberesources.top() itself,
 * so a gap reads as a gap rather than silence.
 */
function start({ id, spec = {}, intervalMs = 15000 } = {}, onSample) {
  if (!id) throw new Error('No id given.');
  if (running.has(id)) throw new Error('That metrics poll is already running.');
  const state = { stopped: false, timer: null };
  running.set(id, state);

  const tick = async () => {
    let snap;
    try { snap = snapshotFrom(await kuberesources.top(spec, {})); }
    catch (e) { snap = { at: Date.now(), ok: false, error: e.message, nodes: [], pods: [] }; }
    if (!state.stopped) onSample(snap);
  };
  tick();
  state.timer = setInterval(tick, intervalMs);
  return { id };
}

function stop(id) {
  const r = running.get(id);
  if (!r) return false;
  r.stopped = true;
  clearInterval(r.timer);
  running.delete(id);
  return true;
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

module.exports = { start, stop, stopAll, parseCpu, parseMemBytes, parsePercent, snapshotFrom };
