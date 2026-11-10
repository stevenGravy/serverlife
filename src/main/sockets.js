'use strict';
/**
 * What is listening, and what is connected — the question that normally
 * means reaching for `ss`, `netstat` or `lsof -i` by hand, because nothing
 * in the rest of this file's diagnostics (a reachability check against a
 * *named* target) answers it. This does, for this machine and — mirroring
 * how ping/traceroute/the port check already work on a host — for one
 * reached over an open session too.
 *
 * Three different tools, three different column layouts, one shape out:
 * `{ proto, state, localAddr, localPort, remoteAddr, remotePort, pid,
 * process, line }`. `line` is the row exactly as the tool printed it, kept
 * on every entry — a parser for text that was never meant to be parsed is
 * a best effort, not a contract, and the raw line is the honest fallback
 * when a column comes back empty that plainly should not have.
 */

const { execFile } = require('child_process');

/** `*` or empty means "not applicable" (a listening socket has no peer). */
function splitAddrPort(s) {
  const v = String(s || '').trim();
  if (!v || v === '*' || v === '*:*') return { addr: null, port: null };
  // [::1]:443 — bracketed, unambiguous.
  const bracket = v.match(/^\[([^\]]*)\]:(\*|\d+)$/);
  if (bracket) return { addr: bracket[1] || null, port: bracket[2] === '*' ? null : Number(bracket[2]) };
  // Everything else splits on the *last* colon: an IPv4 address has none to
  // confuse it with, and these tools print IPv6 either bracketed or with
  // enough colons that "the last one is the port" still holds (`::1.22`
  // never happens; `:::22` and `::1:22` both still end in `:port`).
  const i = v.lastIndexOf(':');
  if (i < 0) return { addr: v || null, port: null };
  const addr = v.slice(0, i) || null;
  const portStr = v.slice(i + 1);
  return { addr, port: portStr === '*' ? null : (Number(portStr) || null) };
}

/**
 * `ss -tulpn` (Linux, and the format `hostTools()` prefers remotely too):
 *   Netid  State   Recv-Q  Send-Q   Local Address:Port   Peer Address:Port   Process
 *   tcp    LISTEN  0       128      0.0.0.0:22           0.0.0.0:*           users:(("sshd",pid=123,fd=3))
 */
function parseSs(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^netid\s/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5 || !/^(tcp|tcp6|udp|udp6)$/i.test(parts[0])) continue;
    const [proto, state, , , local, peer] = parts;
    const rest = parts.slice(6).join(' ');
    const pm = rest.match(/\(\("([^"]+)",pid=(\d+)/);
    const l = splitAddrPort(local);
    const p = splitAddrPort(peer);
    rows.push({
      proto: proto.toLowerCase(),
      state: /^udp/i.test(proto) ? '' : state,
      localAddr: l.addr, localPort: l.port,
      remoteAddr: p.port != null ? p.addr : null, remotePort: p.port,
      pid: pm ? Number(pm[2]) : null,
      process: pm ? pm[1] : null,
      line,
    });
  }
  return rows;
}

/**
 * `netstat -tulpn` (Linux's older/busier systems, and the fallback when
 * `ss` is not installed). TCP lines carry a State column; UDP lines, having
 * no state to report, carry one column fewer — so the split is by count,
 * not by fixed position:
 *   Proto Recv-Q Send-Q Local Address    Foreign Address    State    PID/Program name
 *   tcp   0      0      0.0.0.0:22       0.0.0.0:*          LISTEN   123/sshd
 *   udp   0      0      0.0.0.0:68       0.0.0.0:*                   456/dhclient
 */
function parseNetstatLinux(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!/^(tcp|tcp6|udp|udp6)\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const proto = parts[0];
    const udp = /^udp/i.test(proto);
    const local = parts[3];
    const foreign = parts[4];
    const state = udp ? '' : (parts[5] || '');
    const pidProg = parts[udp ? 5 : 6] || '';
    let pid = null;
    let process = null;
    if (pidProg && pidProg !== '-') {
      const slash = pidProg.indexOf('/');
      if (slash > 0) { pid = Number(pidProg.slice(0, slash)) || null; process = pidProg.slice(slash + 1) || null; }
    }
    const l = splitAddrPort(local);
    const f = splitAddrPort(foreign);
    rows.push({
      proto: proto.toLowerCase(), state,
      localAddr: l.addr, localPort: l.port,
      remoteAddr: f.port != null ? f.addr : null, remotePort: f.port,
      pid, process, line,
    });
  }
  return rows;
}

/**
 * `lsof -i -n -P` (macOS/BSD, where neither `ss` nor a process-aware
 * `netstat` exists). `-n`/`-P` keep it from reverse-resolving names and
 * ports, which would otherwise make every row a DNS lookup:
 *   COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
 *   sshd      123  root   3u   IPv4 0x...  0t0      TCP  *:22 (LISTEN)
 *   sshd      456  root   10u  IPv4 0x...  0t0      TCP  10.0.0.5:22->10.0.0.8:51515 (ESTABLISHED)
 */
function parseLsof(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(\S+)\s+(\d+)\s+\S+\s+\S+\s+IPv[46]\s+\S+\s+\S+\s+(TCP|UDP)\s+(.+)$/i);
    if (!m) continue;
    const [, process, pidStr, proto, tail] = m;
    const sm = tail.match(/^(.+?)(?:\s+\(([A-Za-z_]+)\))?$/);
    const addrPart = sm ? sm[1] : tail;
    const state = sm && sm[2] ? sm[2] : '';
    const [localPart, remotePart] = addrPart.split('->');
    const l = splitAddrPort(localPart);
    const r = remotePart ? splitAddrPort(remotePart) : { addr: null, port: null };
    rows.push({
      proto: proto.toLowerCase(),
      state: /^udp$/i.test(proto) ? '' : state,
      localAddr: l.addr, localPort: l.port,
      remoteAddr: r.port != null ? r.addr : null, remotePort: r.port,
      pid: Number(pidStr) || null,
      process,
      line,
    });
  }
  return rows;
}

/**
 * `netstat -ano` (Windows — the one switch combination every version takes
 * without the optional `Get-NetTCPConnection` cmdlet). It names a PID, never
 * a process name, so the process column is filled in afterwards from a
 * single `Get-Process` call rather than one lookup per row:
 *   Proto  Local Address    Foreign Address    State        PID
 *   TCP    0.0.0.0:22       0.0.0.0:0          LISTENING    1234
 *   UDP    0.0.0.0:68       *:*                             5678
 */
function parseNetstatWindows(text, pidNames) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const parts = line.split(/\s+/);
    if (parts.length < 4 || !/^(TCP|UDP)v?[46]?$/i.test(parts[0])) continue;
    const proto = parts[0];
    const udp = /^UDP/i.test(proto);
    const local = parts[1];
    const foreign = parts[2];
    const state = udp ? '' : (parts[3] || '');
    const pidStr = parts[udp ? 3 : 4];
    const pid = Number(pidStr) || null;
    const l = splitAddrPort(local);
    const f = splitAddrPort(foreign === '*:*' ? null : foreign);
    rows.push({
      proto: proto.toLowerCase(), state,
      localAddr: l.addr, localPort: l.port,
      remoteAddr: f.port != null ? f.addr : null, remotePort: f.port,
      pid, process: pid != null ? (pidNames?.[pid] || null) : null,
      line,
    });
  }
  return rows;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, missing: err?.code === 'ENOENT', text: String(stdout || stderr || '').trim() });
    });
  });
}

/** `Get-Process` once, as a pid→name map, for Windows's PID-only netstat. */
function windowsProcessNames() {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', 'Get-Process | Select-Object Id,ProcessName | ConvertTo-Csv -NoTypeInformation'], {
      timeout: 10000, windowsHide: true,
    }, (err, stdout) => {
      const map = {};
      if (!err) {
        for (const line of String(stdout || '').split('\n').slice(1)) {
          const m = line.match(/^"(\d+)","(.*)"\s*$/);
          if (m) map[Number(m[1])] = m[2];
        }
      }
      resolve(map);
    });
  });
}

/**
 * Local listening sockets and connections. `ss` on Linux, `lsof -i -n -P` on
 * macOS/BSD (which has no process-aware `netstat`), `netstat -ano` plus a
 * `Get-Process` pass on Windows.
 */
async function listSockets() {
  if (process.platform === 'darwin') {
    const r = await run('lsof', ['-i', '-n', '-P']);
    if (r.missing) return { ok: false, rows: [], text: '', missing: 'lsof', command: 'lsof -i -n -P' };
    return { ok: true, rows: parseLsof(r.text), text: r.text, tool: 'lsof', command: 'lsof -i -n -P' };
  }
  if (process.platform === 'win32') {
    const [r, pidNames] = await Promise.all([run('netstat', ['-ano']), windowsProcessNames()]);
    if (r.missing) return { ok: false, rows: [], text: '', missing: 'netstat', command: 'netstat -ano' };
    return { ok: true, rows: parseNetstatWindows(r.text, pidNames), text: r.text, tool: 'netstat', command: 'netstat -ano' };
  }
  // Linux and anything else POSIX-like: ss first, netstat as the fallback
  // for the handful of images that only carry that.
  const ss = await run('ss', ['-tulpn']);
  if (ss.ok) return { ok: true, rows: parseSs(ss.text), text: ss.text, tool: 'ss', command: 'ss -tulpn' };
  const nt = await run('netstat', ['-tulpn']);
  if (!nt.missing && nt.text) return { ok: true, rows: parseNetstatLinux(nt.text), text: nt.text, tool: 'netstat', command: 'netstat -tulpn' };
  return { ok: false, rows: [], text: '', missing: 'ss', command: 'ss -tulpn' };
}

/**
 * The remote half: a script to run over an open session's `exec`, and the
 * parser for whichever tool it found — `connections.js`'s own `hostTools()`
 * capability probe already knows whether `ss`/`netstat` exist, which is
 * also every Linux-family remote this app otherwise diagnoses (`hostFacts`,
 * `hostTrace`); a BSD/macOS or Windows target is out of scope here, same as
 * those.
 */
function remoteSocketsScript(caps) {
  if (caps?.tools?.ss) return { tool: 'ss', cmd: 'ss -tulpn 2>&1' };
  if (caps?.tools?.netstat) return { tool: 'netstat', cmd: 'netstat -tulpn 2>&1' };
  return null;
}

function parseRemote(tool, text) {
  return tool === 'ss' ? parseSs(text) : parseNetstatLinux(text);
}

module.exports = { listSockets, splitAddrPort, parseSs, parseNetstatLinux, parseLsof, parseNetstatWindows, remoteSocketsScript, parseRemote };
