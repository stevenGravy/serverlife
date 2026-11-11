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
 *
 * A local shell on macOS or Linux has the same bar for this computer, read
 * by the main process rather than a command (main/localmonitor.js) and sent
 * as the connection "local". Hiding it from a local pane's menu is kept
 * (settings.localStats) — it is the same computer every time.
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

/** A server session or a tmux pane on one: both ride a connection to the host. */
const onAHost = (pane) => (pane?.kind === 'remote' || pane?.kind === 'tmux') && !!pane.connId;
const LOCAL = 'local';
/** A plain local shell, where this computer can be read: macOS and Linux. */
const isLocal = (pane) => pane?.kind === 'local' && !!pane.plainShell && ['darwin', 'linux'].includes(state.appInfo?.platform);
const monitored = (pane) => onAHost(pane) || isLocal(pane);
const keyOf = (pane) => (isLocal(pane) ? LOCAL : pane.connId);
// No background commands on servers does not touch this computer; the stats switch and a hidden local bar do.
const localStatsEnabled = () => state.settings?.liveStats !== false && state.settings?.localStats !== false;
const enabledFor = (pane) => (isLocal(pane) ? localStatsEnabled() : liveStatsEnabled() && !hiddenConns.has(pane.connId));
/*
 * Settings → "One live stats bar per machine in a tab": split panes on the
 * same host (or several local shells) in one tab show one bar between them,
 * on the first; the others give the terminal that row back. Off by default.
 */
const onePerTab = () => state.settings?.statsOncePerTab === true;
const shownInTab = (pane, key) => [...state.panes.values()].some((p) => p !== pane && p.tabId === pane.tabId && p.statsBar && keyOf(p) === key);

/** Start (or join) the monitor for a pane, and give it its bar. */
export async function attachMonitor(pane) {
  if (!monitored(pane) || !enabledFor(pane)) return;
  const key = keyOf(pane);
  if (!pane.statsBar && onePerTab() && shownInTab(pane, key)) return;
  // Already showing: a reconnect restarts a monitor the drop ended.
  if (pane.statsBar) {
    const m = mons.get(key);
    if (m && m.status === 'ended') await start(key, m);
    return;
  }
  const m = monFor(key);
  m.panes.add(pane);
  pane.statsBar = el('div', {
    class: 'pane-stats' + (key === LOCAL ? ' local' : ''),
    title: key === LOCAL ? 'Live stats for this computer — right-click the pane to hide them' : 'Live stats for this host — right-click the pane to hide them',
  });
  pane.element.append(pane.statsBar);
  // The terminal lost a row of height to the bar.
  requestAnimationFrame(() => pane.view?.fitNow?.());
  draw(m);
  if (m.status === 'idle' || m.status === 'ended') await start(key, m);
}

async function start(connId, m) {
  m.status = 'starting';
  m.error = '';
  draw(m);
  const r = await (connId === LOCAL
    ? window.api.conn.startLocalMonitor({ interval: 5 })
    : window.api.conn.startMonitor(connId, { interval: 5 })).catch((e) => ({ ok: false, error: e.message }));
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
  const key = [...mons.entries()].find(([, mon]) => mon.panes.has(pane))?.[0];
  const m = key && mons.get(key);
  if (!m) return;
  m.panes.delete(pane);
  // One bar per machine in a tab: the next pane on it takes the bar over — unless the bar is being hidden.
  if (onePerTab() && enabledFor(pane)) {
    const next = [...state.panes.values()].find((p) => p !== pane && p.tabId === pane.tabId && !p.statsBar && monitored(p) && keyOf(p) === key);
    if (next) { attachMonitor(next); return; }
  }
  if (!m.panes.size) {
    (key === LOCAL ? window.api.conn.stopLocalMonitor() : window.api.conn.stopMonitor(key)).catch(() => {});
    mons.delete(key);
  }
}

/** Hide or show the bar for every pane on this pane's host, until restart. */
export async function toggleStatsFor(pane) {
  if (isLocal(pane)) {
    // Every local shell at once, and remembered: it is this computer each time.
    const showing = !!pane.statsBar;
    state.settings = await window.api.settings.set({ localStats: !showing });
    for (const p of state.panes.values()) if (isLocal(p)) (showing ? detachMonitor(p) : attachMonitor(p));
    return;
  }
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
  const panes = [...state.panes.values()].filter(monitored);
  for (const p of panes) {
    // Turned on: the extra bars in a tab go first, so the first pane keeps its own.
    const extra = onePerTab() && p.statsBar && panes.some((q) => q !== p && q.tabId === p.tabId && q.statsBar && keyOf(q) === keyOf(p) && panes.indexOf(q) < panes.indexOf(p));
    if (!enabledFor(p) || extra) detachMonitor(p);
  }
  for (const p of panes) if (enabledFor(p)) attachMonitor(p);
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
