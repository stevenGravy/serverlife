import { state } from './state.js';
import { el, fmtBytes } from './util.js';

/**
 * Live stats under a server session: CPU, memory, swap, load, disk and
 * network for the host the pane is connected to, as MobaXterm's bar shows.
 *
 * The numbers come from one long-running command per connection
 * (Connection.startMonitor in main), not a command per sample — on a Teleport
 * node every exec is an audit-log session. Every pane on a connection shares
 * that one command: the first pane starts it, the last one to go stops it.
 *
 * Off where it would cost something it should not: a per-session-MFA host
 * would ask for an approval, so the bar says it is off there and asks for
 * nothing. Off everywhere with Settings → "Live stats under each server
 * session", or for one host from the pane's menu.
 */

const HISTORY = 40;                 // samples kept for the CPU sparkline
const mons = new Map();             // connId -> { panes:Set, samples:[], hello, status, error }
const hiddenConns = new Set();      // hidden from a pane's menu, for this run

export function liveStatsEnabled() {
  // Settings → "No background commands on servers" outranks the stats switch.
  return state.settings?.liveStats !== false && state.settings?.quietRemote !== true;
}

function monFor(connId) {
  if (!mons.has(connId)) mons.set(connId, { panes: new Set(), samples: [], hello: null, status: 'idle', error: '' });
  return mons.get(connId);
}

/** Start (or join) the monitor for a remote pane, and give it its bar. */
/** A server session or a tmux pane on one: both ride a connection to the host. */
const onAHost = (pane) => (pane?.kind === 'remote' || pane?.kind === 'tmux') && !!pane.connId;

export async function attachMonitor(pane) {
  if (!onAHost(pane)) return;
  if (!liveStatsEnabled() || hiddenConns.has(pane.connId)) return;
  // Already showing: a reconnect restarts a monitor the drop ended.
  if (pane.statsBar) {
    const m = mons.get(pane.connId);
    if (m && m.status === 'ended') await start(pane.connId, m);
    return;
  }
  const m = monFor(pane.connId);
  m.panes.add(pane);
  pane.statsBar = el('div', { class: 'pane-stats', title: 'Live stats for this host — right-click the pane to hide them' });
  pane.element.append(pane.statsBar);
  // The terminal lost a row of height to the bar.
  requestAnimationFrame(() => pane.view?.fitNow?.());
  draw(m);
  if (m.status === 'idle' || m.status === 'ended') await start(pane.connId, m);
}

async function start(connId, m) {
  m.status = 'starting';
  m.error = '';
  draw(m);
  const r = await window.api.conn.startMonitor(connId, { interval: 5 }).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) {
    m.status = r?.reason === 'mfa' ? 'mfa' : 'ended';
    m.error = r?.error || 'Could not start live stats';
  }
  draw(m);
}

/** A pane going away leaves its connection's monitor; the last one stops it. */
export function detachMonitor(pane) {
  if (!pane?.statsBar) return;
  pane.statsBar.remove();
  pane.statsBar = null;
  // A pane tmux has just removed has no terminal left to refit.
  requestAnimationFrame(() => { try { pane.view?.fitNow?.(); } catch { /* disposed */ } });
  const m = mons.get(pane.connId);
  if (!m) return;
  m.panes.delete(pane);
  if (!m.panes.size) {
    window.api.conn.stopMonitor(pane.connId).catch(() => {});
    mons.delete(pane.connId);
  }
}

/** Hide or show the bar for every pane on this pane's host, until restart. */
export function toggleStatsFor(pane) {
  if (!pane?.connId) return;
  const panes = [...state.panes.values()].filter((p) => p.connId === pane.connId);
  if (pane.statsBar) {
    hiddenConns.add(pane.connId);
    for (const p of panes) detachMonitor(p);
  } else {
    hiddenConns.delete(pane.connId);
    for (const p of panes) attachMonitor(p);
  }
}

/** Settings changed: bring every remote pane in line with the switch. */
export function applyLiveStatsSetting() {
  for (const p of state.panes.values()) {
    if (!onAHost(p)) continue;
    if (liveStatsEnabled()) attachMonitor(p);
    else detachMonitor(p);
  }
}

export function initMonitor() {
  window.api.conn.onMonitor((connId, payload) => {
    const m = mons.get(connId);
    if (!m) return;
    if (payload.kind === 'hello') { m.hello = payload; m.status = 'running'; }
    else if (payload.kind === 'sample') {
      m.status = 'running';
      m.samples.push(payload);
      if (m.samples.length > HISTORY) m.samples.shift();
    } else if (payload.kind === 'unsupported') { m.status = 'unsupported'; m.error = payload.os; }
    else if (payload.kind === 'ended') {
      if (m.status !== 'unsupported') m.status = 'ended';
      m.error = payload.error || '';
    }
    draw(m);
  });
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

// Exported for kubebrowser.js's own CPU/memory history — the same
// text-and-CSS sparkline, not a second one reinvented there.
export const BLOCKS = '▁▂▃▄▅▆▇█';
export function sparkline(values) {
  return values.map((v) => BLOCKS[Math.min(7, Math.max(0, Math.round((v / 100) * 7)))]).join('');
}
const level = (pct, warn = 80, bad = 92) => (pct >= bad ? 'bad' : pct >= warn ? 'warn' : '');
const rate = (n) => `${fmtBytes(n)}/s`;
function uptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function cell(label, value, cls = '', title = '') {
  return el('span', { class: 'ps-cell' + (cls ? ' ' + cls : ''), title: title || null },
    el('span', { class: 'ps-k', text: label }), el('span', { class: 'ps-v', text: value }));
}

function contents(m) {
  if (m.status === 'mfa') return [el('span', { class: 'ps-note', text: 'Live stats are off on this host: it uses per-session MFA, and they would need another approval.' })];
  if (m.status === 'unsupported') return [el('span', { class: 'ps-note', text: `Live stats read Linux’s /proc, which this host (${m.error || 'not Linux'}) does not have.` })];
  if (m.status === 'ended') {
    return [el('span', { class: 'ps-note', text: 'Live stats stopped' + (m.error ? ': ' + m.error : '.') }),
      el('button', { class: 'ps-retry', text: 'Restart', onClick: (e) => { e.stopPropagation(); const [p] = m.panes; if (p) start(p.connId, m); } })];
  }
  const s = m.samples[m.samples.length - 1];
  if (!s) return [el('span', { class: 'ps-note', text: 'Reading live stats…' })];
  const memPct = s.memTotal ? (100 * s.memUsed) / s.memTotal : 0;
  const swapPct = s.swapTotal ? (100 * s.swapUsed) / s.swapTotal : 0;
  const cpus = m.hello?.cpus || 1;
  const perCpu = s.load / cpus;
  return [
    cell('CPU', `${s.cpu.toFixed(0)}%`, level(s.cpu), `CPU busy across ${cpus} CPU${cpus === 1 ? '' : 's'}, over the last ${m.hello?.interval || 5}s`),
    el('span', { class: 'ps-spark ' + level(s.cpu), title: 'CPU over the last few minutes', text: sparkline(m.samples.map((x) => x.cpu)) }),
    cell('Mem', `${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}`, level(memPct, 85, 95), `${memPct.toFixed(0)}% of memory in use (MemTotal − MemAvailable)`),
    s.swapTotal ? cell('Swap', `${swapPct.toFixed(0)}%`, level(swapPct, 50, 80), `${fmtBytes(s.swapUsed)} of ${fmtBytes(s.swapTotal)} swap in use`) : null,
    cell('Load', s.load.toFixed(2), perCpu >= 2 ? 'bad' : perCpu >= 1 ? 'warn' : '', `1-minute load average, on ${cpus} CPU${cpus === 1 ? '' : 's'}`),
    cell('Disk /', `${s.disk}%`, level(s.disk, 85, 95), 'How full the root filesystem is'),
    cell('Net', `↓ ${rate(s.rx)}  ↑ ${rate(s.tx)}`, '', 'Received and sent, every interface but loopback'),
    cell('Up', uptime(s.uptime)),
  ].filter(Boolean);
}

function draw(m) {
  for (const p of m.panes) {
    if (!p.statsBar) continue;
    p.statsBar.replaceChildren(...contents(m));
    p.statsBar.dataset.status = m.status;
  }
}
