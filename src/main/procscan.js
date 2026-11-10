'use strict';

/**
 * The processes on a machine, for the 3D city's traffic.
 *
 * One `ps` and nothing else: pid, CPU share, resident memory, owner and
 * command. Every ps worth the name takes `-o` with these field names — GNU
 * procps, BSD and macOS all do — and the trailing `=` drops the header so
 * there is nothing to skip. `comm` goes last because it is the one field
 * that may contain spaces.
 *
 * Busybox's ps does not know `pcpu`, so the remote command falls back to the
 * fields it does know and the CPU column comes back empty; those machines get
 * traffic sized by memory alone, which is still the more interesting half.
 */

const { execFile } = require('child_process');
const path = require('path');

const FIELDS = 'pid=,pcpu=,rss=,user=,comm=';

function remoteCommand() {
  return `LC_ALL=C ps -axo ${FIELDS} 2>/dev/null || LC_ALL=C ps -eo ${FIELDS} 2>/dev/null || ps -o pid=,rss=,user=,comm=`;
}

/** Lines of `pid pcpu rss user comm`, or `pid rss user comm` from busybox. */
function parse(text, { top = 40 } = {}) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let m = t.match(/^(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    let pid, cpu, rssKb, user, comm;
    if (m) {
      [, pid, cpu, rssKb, user, comm] = m;
      cpu = parseFloat(cpu.replace(',', '.'));
    } else if ((m = t.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/))) {
      [, pid, rssKb, user, comm] = m;
      cpu = 0;
    } else continue;
    const name = path.posix.basename(comm.trim()) || comm.trim();
    out.push({
      pid: Number(pid),
      cpu: Number.isFinite(cpu) ? cpu : 0,
      mem: Number(rssKb) * 1024,
      user,
      name,
    });
  }
  // The busiest, by a mix of the two: a percent of CPU weighed against a
  // hundred megabytes of memory, which is roughly where each starts to matter.
  const weight = (p) => p.cpu + p.mem / (100 * 1024 * 1024);
  out.sort((a, b) => weight(b) - weight(a));
  return out.slice(0, top);
}

/*
 * Windows has no ps. Get-Process has the same facts in other units: memory
 * as a working set, and CPU as seconds used since the process started
 * rather than a share of now. The share is the difference between two
 * looks, so the first look after starting reports none and the next one is
 * right — the traffic is a poll anyway.
 */
const lastWin = { at: 0, cpu: new Map() };

function scanWindows(opts) {
  const script = 'Get-Process | ForEach-Object { "{0}`t{1}`t{2}`t{3}" -f $_.Id, $_.CPU, $_.WorkingSet64, $_.ProcessName }';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        const now = Date.now();
        const wall = lastWin.at ? (now - lastWin.at) / 1000 : 0;
        const seen = new Map();
        const rows = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const [pid, cpuS, ws, name] = line.split('\t');
          if (!/^\d+$/.test(pid || '') || !name) continue;
          const secs = parseFloat(String(cpuS).replace(',', '.')) || 0;
          seen.set(pid, secs);
          const before = lastWin.cpu.get(pid);
          const cpu = wall && before !== undefined ? Math.max(0, ((secs - before) / wall) * 100) : 0;
          rows.push(`${pid} ${cpu.toFixed(1)} ${Math.round((Number(ws) || 0) / 1024)} - ${name}`);
        }
        lastWin.at = now;
        lastWin.cpu = seen;
        resolve(parse(rows.join('\n'), opts));
      });
  });
}

function scanLocal(opts) {
  if (process.platform === 'win32') return scanWindows(opts);
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', FIELDS], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 8 * 1024 * 1024, timeout: 10000 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(parse(stdout, opts))));
  });
}

module.exports = { remoteCommand, parse, scanLocal };
