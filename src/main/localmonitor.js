'use strict';

/*
 * Live stats for this computer, under a local shell — the same bar a server
 * session has (renderer/js/monitor.js), fed the same samples, but read here
 * rather than by a command on a host: Linux's /proc, and on macOS what
 * stands in for it (vm_stat, sysctl, netstat), with Node's os module for
 * CPU, load and uptime on both. One sampler however many local shells are
 * open; the renderer starts it with the first and stops it with the last.
 */

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

/** CPU busy %, from the change in os.cpus() times since the last call. */
function cpuSampler() {
  let prev = null;
  const totals = () => os.cpus().reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
  return () => {
    const now = totals();
    const pct = prev && now.total > prev.total ? 100 * (1 - (now.idle - prev.idle) / (now.total - prev.total)) : 0;
    prev = now;
    return Math.max(0, Math.min(100, pct));
  };
}

/** Linux: /proc/meminfo, in bytes. */
function linuxMemory() {
  const kb = {};
  for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  const memTotal = kb.MemTotal || os.totalmem();
  return {
    memTotal,
    memUsed: Math.max(0, memTotal - (kb.MemAvailable ?? kb.MemFree ?? 0)),
    swapTotal: kb.SwapTotal || 0,
    swapUsed: Math.max(0, (kb.SwapTotal || 0) - (kb.SwapFree || 0)),
  };
}

/**
 * macOS: used memory as Activity Monitor counts it, near enough — what is not
 * free, inactive or speculative (os.freemem counts only truly free pages, so
 * a Mac would always look nearly full) — and swap from sysctl.
 */
async function macMemory() {
  const [vm, swap] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage'])]);
  const memTotal = os.totalmem();
  const page = Number((vm.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const pages = (name) => Number((vm.match(new RegExp(`${name}:\\s+(\\d+)`)) || [])[1]) || 0;
  const avail = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page;
  const unit = (v, u) => Number(v) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[u] || 1);
  const sw = (k) => { const m = swap.match(new RegExp(`${k} = ([\\d.]+)([KMG])`)); return m ? unit(m[1], m[2]) : 0; };
  return { memTotal, memUsed: Math.max(0, memTotal - avail), swapTotal: sw('total'), swapUsed: sw('used') };
}

/** How full the disk is, %. On macOS / is the sealed system volume; the Data volume is where files go. */
function diskPct() {
  const target = process.platform === 'darwin' && fs.existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/';
  try {
    const s = fs.statfsSync(target);
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    return used + avail > 0 ? Math.round((100 * used) / (used + avail)) : 0;
  } catch { return 0; }
}

/** Bytes received and sent so far, every interface but loopback. */
async function netTotals() {
  if (process.platform === 'linux') {
    let rx = 0;
    let tx = 0;
    try {
      for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
        const m = line.match(/^\s*([^:]+):\s*(.*)$/);
        if (!m || m[1].trim() === 'lo') continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        rx += f[0] || 0;
        tx += f[8] || 0;
      }
    } catch { /* none to count */ }
    return { rx, tx };
  }
  // netstat -ibn: one <Link#n> row per interface carries its byte counts.
  const out = await run('netstat', ['-ibn']);
  const lines = out.split('\n');
  const head = (lines[0] || '').trim().split(/\s+/);
  const iI = head.indexOf('Ibytes');
  const iO = head.indexOf('Obytes');
  let rx = 0;
  let tx = 0;
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < head.length || !/^<Link#/.test(f[2] || '') || f[0].startsWith('lo') || seen.has(f[0])) continue;
    seen.add(f[0]);
    // A row with no address has one field fewer, before the counts.
    const shift = f.length - head.length;
    rx += Number(f[iI + shift]) || 0;
    tx += Number(f[iO + shift]) || 0;
  }
  return { rx, tx };
}

let timer = null;

/** Start sampling every `interval` seconds; `emit` gets hello, then samples. Linux and macOS only. */
function start({ interval = 5 } = {}, emit) {
  stop();
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    emit({ kind: 'unsupported', os: process.platform });
    return { ok: false, error: 'Live stats for this computer are for macOS and Linux' };
  }
  const cpu = cpuSampler();
  cpu();
  let prevNet = null;
  let prevAt = 0;
  emit({ kind: 'hello', cpus: os.cpus().length || 1, interval });
  const sample = async () => {
    try {
      const [mem, net] = await Promise.all([process.platform === 'linux' ? linuxMemory() : macMemory(), netTotals()]);
      const now = Date.now();
      const secs = prevAt ? (now - prevAt) / 1000 : 0;
      const rate = (k) => (prevNet && secs > 0 ? Math.max(0, (net[k] - prevNet[k]) / secs) : 0);
      const s = {
        kind: 'sample', at: now, cpu: cpu(), ...mem, load: os.loadavg()[0],
        disk: diskPct(), rx: rate('rx'), tx: rate('tx'), uptime: Math.round(os.uptime()),
      };
      prevNet = net;
      prevAt = now;
      if (timer) emit(s);
    } catch (e) {
      emit({ kind: 'ended', error: e.message });
      stop();
    }
  };
  timer = setInterval(sample, Math.max(1, interval) * 1000);
  // The first numbers sooner than a whole interval in.
  setTimeout(() => { if (timer) sample(); }, 1200);
  return { ok: true };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  return true;
}

module.exports = { start, stop, netTotals, diskPct, macMemory, linuxMemory };
