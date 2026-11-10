'use strict';
/**
 * Network diagnostics: the "why can't I reach this box" tools every SSH client
 * ends up carrying, plus a reader for a Teleport proxy's `/webapi/ping`.
 *
 * Everything here runs against a single named host. External commands are
 * spawned with execFile and an argument array — never a shell — so a hostname
 * can never become a command, and every target is validated first anyway.
 */

const { execFile } = require('child_process');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const https = require('https');
const os = require('os');

/*
 * A GUI app launched from the Dock (or by `launchd` generally) inherits
 * launchd's own PATH, not the shell's — so a Homebrew-installed `whois`,
 * `mtr`, `dig` or GNU `nc`/`traceroute` can be perfectly real and still
 * invisible to `execFile`, which then reports "not installed" for a tool
 * that plainly is. `localhost.js` and `local.js` already carry this same
 * fix for their own child processes; `run()` and `curlRequest()` below are
 * the two places in this file that spawn a binary and need it too.
 */
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin'];

function toolEnv(extra) {
  if (process.platform === 'win32') return { ...process.env, ...(extra || {}) };
  const current = process.env.PATH || '';
  const dirs = current.split(':');
  const add = EXTRA_PATH_DIRS.filter((d) => !dirs.includes(d));
  return { ...process.env, ...(extra || {}), PATH: add.length ? [current, ...add].join(':') : current };
}

/**
 * Hostnames, IPv4/IPv6 literals and nothing else. This is belt-and-braces
 * given execFile takes an argv, but it also keeps obvious nonsense out of the
 * diagnostics before a command is spawned.
 */
const HOST_RE = /^[A-Za-z0-9._:-]+$/;

function checkHost(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('Give a host name or address.');
  if (h.length > 253) throw new Error('That host name is too long.');
  if (!HOST_RE.test(h)) throw new Error('Host names may only contain letters, digits, dot, dash, underscore and colon.');
  return h;
}

/** Strip a scheme and any path, so "https://proxy:443/web" still works. */
function hostFromInput(value) {
  let v = String(value || '').trim();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  v = v.split('/')[0];
  return v;
}

function splitHostPort(value) {
  const v = hostFromInput(value);
  // [::1]:443
  const bracket = v.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : null };
  // A bare IPv6 literal has more than one colon and no port.
  const colons = (v.match(/:/g) || []).length;
  if (colons > 1) return { host: v, port: null };
  const [h, p] = v.split(':');
  return { host: h, port: p ? Number(p) : null };
}

function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: toolEnv() }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        // A non-zero exit still carries the useful part (ping prints its
        // summary before failing), so the text matters more than the status.
        text: (String(stdout || '') + String(stderr || '')).trim(),
        timedOut: !!(err && err.killed),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* ICMP and path                                                       */
/* ------------------------------------------------------------------ */

/**
 * Which binary and args ping this host with, optionally forced onto one IP
 * family. Shared between the real run and the preview/copy-command, so the
 * two cannot drift apart.
 *
 * macOS/BSD's `ping` has no `-6` of its own — `ping6` is the separate
 * IPv6-only sibling it ships instead — while Windows and Linux both take a
 * plain `-6`/`-4` flag on the one binary.
 */
function pingSpec(host, count, ipVersion) {
  const n = Math.min(Math.max(Number(count) || 5, 1), 20);
  const v6 = ipVersion === '6';
  const v4 = ipVersion === '4';
  if (process.platform === 'win32') {
    return { cmd: 'ping', args: ['-n', String(n), ...(v6 ? ['-6'] : v4 ? ['-4'] : []), host] };
  }
  if (process.platform === 'darwin' && v6) return { cmd: 'ping6', args: ['-c', String(n), host] };
  return {
    cmd: 'ping',
    args: ['-c', String(n), '-W', '2000', ...(process.platform !== 'darwin' ? (v6 ? ['-6'] : v4 ? ['-4'] : []) : []), host],
  };
}

/** Pure: the ping invocation for a host, with no I/O — the preview and the run share this. */
function pingCommand(host, count, ipVersion) {
  const { cmd, args } = pingSpec(host, count, ipVersion);
  return `${cmd} ${args.join(' ')}`;
}

async function ping({ host, count = 5, ipVersion } = {}) {
  // The target field takes "host:port"; ICMP has no ports, so drop it rather
  // than handing `example.com:443` to ping as a host name.
  const h = checkHost(splitHostPort(host).host);
  const n = Math.min(Math.max(Number(count) || 5, 1), 20);
  const { cmd, args } = pingSpec(h, count, ipVersion);
  const r = await run(cmd, args, { timeout: (n + 5) * 2000 });
  return { host: h, ...r, command: pingCommand(h, count, ipVersion) };
}

/** Same idea as pingSpec(), for traceroute's own IPv6-only sibling on macOS/BSD. */
function tracerouteSpec(host, maxHops, ipVersion) {
  const hops = Math.min(Math.max(Number(maxHops) || 20, 1), 40);
  const v6 = ipVersion === '6';
  const v4 = ipVersion === '4';
  if (process.platform === 'win32') {
    return { cmd: 'tracert', args: ['-h', String(hops), ...(v6 ? ['-6'] : v4 ? ['-4'] : []), host] };
  }
  if (process.platform === 'darwin' && v6) return { cmd: 'traceroute6', args: ['-m', String(hops), '-w', '2', host] };
  return {
    cmd: 'traceroute',
    args: ['-m', String(hops), '-w', '2', ...(v6 ? ['-6'] : v4 ? ['-4'] : []), host],
  };
}

/** Pure: the traceroute invocation, no I/O. */
function tracerouteCommand(host, maxHops, ipVersion) {
  const { cmd, args } = tracerouteSpec(host, maxHops, ipVersion);
  return `${cmd} ${args.join(' ')}`;
}

async function traceroute({ host, maxHops = 20, ipVersion } = {}) {
  const h = checkHost(splitHostPort(host).host);
  const { cmd, args } = tracerouteSpec(h, maxHops, ipVersion);
  const r = await run(cmd, args, { timeout: Math.min(Math.max(Number(maxHops) || 20, 1), 40) * 4000 });
  const command = tracerouteCommand(h, maxHops, ipVersion);
  if (!r.text && !r.ok) {
    return { host: h, ok: false, text: `${cmd} is not installed or not on PATH.`, command };
  }
  return { host: h, ...r, command };
}

/* ------------------------------------------------------------------ */
/* DNS                                                                 */
/* ------------------------------------------------------------------ */

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'SOA', 'NAPTR'];

/*
 * `nslookup -type=X [host] [server]` is one of the few diagnostic commands
 * spelled identically on every platform ServerLife runs on — it ships with
 * every Windows release and with every *nix's bind-utils/dnsutils. One line
 * per type, the same ones `lookup` asks about below, rather than
 * `dig … ANY`, which plenty of resolvers now silently refuse.
 *
 * The optional trailing `server` is nslookup's own syntax for "ask this
 * nameserver instead of the system default" — the same override `lookup`
 * takes. Without it, the two can genuinely disagree: this panel answers
 * from Node's own bundled resolver library, and the copied command answers
 * from whatever `nslookup` resolves through on this machine, which is not
 * always the same path. Naming the server, when one was given, is what
 * keeps the copy-and-paste honest for the one case this can actually fix.
 */
function dnsCommand(host, server) {
  return DNS_TYPES.map((t) => `nslookup -type=${t} ${host}${server ? ' ' + server : ''}`).join('\n');
}

/**
 * A DNS lookup, optionally through a specific nameserver rather than this
 * machine's own — "is this propagation, or is my resolver just stale?" is
 * one of the most common real DNS questions, and there was previously no
 * way to ask it here at all.
 */
async function lookup({ host, server } = {}) {
  const h = checkHost(splitHostPort(host).host);
  const customServer = server ? checkHost(splitHostPort(server).host) : null;
  let resolver = dns;
  if (customServer) {
    resolver = new dns.Resolver({ timeout: 5000 });
    resolver.setServers([customServer]);
  }

  const records = {};
  const ttls = {};
  await Promise.all(DNS_TYPES.map(async (type) => {
    try {
      /*
       * TTL is only available through the dedicated resolve4/resolve6 calls
       * (`{ ttl: true }`) — the generic `resolve(host, type)` Node uses for
       * every other record type has no equivalent option, so TTL can only
       * be shown for the two record types people ask about it the most.
       */
      if (type === 'A' || type === 'AAAA') {
        const v = await resolver[type === 'A' ? 'resolve4' : 'resolve6'](h, { ttl: true });
        if (v && v.length) {
          records[type] = v.map((r) => r.address);
          ttls[type] = Math.min(...v.map((r) => r.ttl));
        }
      } else {
        const v = await resolver.resolve(h, type);
        if (v && v.length) records[type] = v;
      }
    } catch {/* NODATA, NXDOMAIN and SERVFAIL are all just "nothing of this type" here */}
  }));

  let reverse = null;
  if (net.isIP(h)) {
    try { reverse = await resolver.reverse(h); } catch { /* no reverse name */ }
  }
  return {
    host: h, records, ttls, reverse,
    servers: customServer ? [customServer] : dns.getServers(),
    usingCustomServer: !!customServer,
    command: dnsCommand(h, customServer),
  };
}

/* ------------------------------------------------------------------ */
/* TCP reachability                                                    */
/* ------------------------------------------------------------------ */

/** Ports worth checking on a host you are trying to administer. */
const DEFAULT_PORTS = [22, 443, 3022, 3023, 3024, 3025, 3080];
const MAX_PORTS = 32;

/**
 * The closest thing to this probe a terminal can run by hand. Neither a
 * telnet client nor `nc` is installed on Windows by default — PowerShell's
 * `Test-NetConnection` is the one port-reachability check that always is.
 * `-z` (connect and immediately close) is what makes the *nix form a check
 * rather than a conversation; dropping it is `telnetCommand`'s job below.
 *
 * `Test-NetConnection` has no IPv4/IPv6-forcing flag of its own, so
 * `ipVersion` only changes the command on *nix, where `nc` takes a plain
 * `-4`/`-6`.
 */
function portCommand(host, port, ipVersion) {
  if (process.platform === 'win32') return `Test-NetConnection -ComputerName ${host} -Port ${port}`;
  const flag = ipVersion === '6' ? '-6 ' : ipVersion === '4' ? '-4 ' : '';
  return `nc -zv ${flag}${host} ${port}`;
}

/**
 * The hand-run form of this probe: stay connected and show what the far end
 * says, which is the whole point of reaching for telnet this way. `nc`
 * without `-z` does that; `Test-NetConnection` cannot — it reports open or
 * closed and nothing else — so Windows gets a note alongside it rather than
 * a command that quietly does less than it looks like it does.
 */
function telnetCommand(host, port) {
  return process.platform === 'win32'
    ? `Test-NetConnection -ComputerName ${host} -Port ${port}`
    : `nc -v ${host} ${port}`;
}

const TELNET_COMMAND_NOTE = process.platform === 'win32'
  ? 'Test-NetConnection only says whether the port is open — it will not show a banner. '
    + 'For that, enable the Telnet Client Windows feature (dism /online /Enable-Feature '
    + '/FeatureName:TelnetClient /All) or install netcat.'
  : null;

function parsePorts(spec) {
  if (!spec) return DEFAULT_PORTS;
  const out = [];
  for (const piece of String(spec).split(',')) {
    const part = piece.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) throw new Error(`"${part}" runs backwards.`);
      // A bounded list, deliberately: this is a reachability check for one
      // host, not a scanner.
      if (to - from + 1 > MAX_PORTS) throw new Error(`Ranges are limited to ${MAX_PORTS} ports.`);
      for (let p = from; p <= to; p++) out.push(p);
    } else {
      const p = Number(part);
      if (!Number.isInteger(p)) throw new Error(`"${part}" is not a port number.`);
      out.push(p);
    }
  }
  const ports = [...new Set(out)];
  if (!ports.length) throw new Error('Give at least one port.');
  if (ports.some((p) => p < 1 || p > 65535)) throw new Error('Ports run from 1 to 65535.');
  if (ports.length > MAX_PORTS) throw new Error(`At most ${MAX_PORTS} ports at a time.`);
  return ports;
}

function probePort(host, port, timeout, family) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const done = (state, detail) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ port, state, ms: Date.now() - started, detail: detail || null });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done('open'));
    sock.once('timeout', () => done('filtered', 'no response'));
    // A refusal is fully described by "closed"; only the unexpected codes
    // (ENOTFOUND, EHOSTUNREACH, ENETDOWN…) are worth the extra words.
    sock.once('error', (e) => (e.code === 'ECONNREFUSED'
      ? done('closed')
      : done('error', e.code || e.message)));
    // `family` forces which A/AAAA answer net's own DNS lookup prefers when
    // `host` is a name rather than a literal — the same question ping and
    // traceroute's `-4`/`-6` answer, asked the one way a raw TCP connect can.
    sock.connect({ port, host, family: family || undefined });
  });
}

async function portCheck({ host, ports, timeout = 3000, ipVersion } = {}) {
  const parsed = splitHostPort(host);
  const h = checkHost(parsed.host);
  // A target written as "host:port" has already named the port to check.
  const list = ports ? parsePorts(ports) : (parsed.port ? [parsed.port] : DEFAULT_PORTS);
  const t = Math.min(Math.max(Number(timeout) || 3000, 500), 10000);
  const family = ipVersion === '6' ? 6 : ipVersion === '4' ? 4 : undefined;
  const results = await Promise.all(list.map((p) => probePort(h, p, t, family)));
  results.sort((a, b) => a.port - b.port);
  const command = list.map((p) => portCommand(h, p, ipVersion)).join('\n');
  return { host: h, results, command };
}

/* ------------------------------------------------------------------ */
/* Telnet: is anything there, and what does it say                    */
/* ------------------------------------------------------------------ */

/**
 * `telnet host port`, minus the part where you have to type `^]` and `quit`.
 *
 * Half of telnet's remaining use has nothing to do with telnet: it is how
 * people ask a port "are you there, and what are you?" — an SSH server
 * announces its version, a mail server its name, a switch its login prompt —
 * and how they find out which address a name resolves to today. So this
 * connects, listens for a few seconds, and reports what was said.
 *
 * The listening is done by the same parser the telnet sessions use. A switch
 * or terminal server will not show its prompt until the negotiation has been
 * answered, and a probe that sat on its hands through `DO TTYPE` would report
 * silence from a device that was trying quite hard to talk. Answering is also
 * what makes "it speaks telnet" a fact rather than a guess.
 *
 * Nothing is ever *sent* beyond the negotiation. Typing at a service you have
 * not identified yet is how a reachability check becomes an incident.
 */
async function telnetProbe({ host, port, wait = 3000, timeout = 5000 } = {}) {
  // Required here rather than at the top: devices.js is where the telnet
  // protocol lives, and borrowing it keeps there being exactly one of it.
  const { telnetParse, nawsFrame, telnetError } = require('./devices');
  const parsed = splitHostPort(host);
  const h = checkHost(parsed.host);
  // An explicit port wins over one written into the target, because the
  // field beside it is the more recent thing the user touched.
  const p = Number(port) || parsed.port || 23;
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Ports run from 1 to 65535.');
  const listen = Math.min(Math.max(Number(wait) || 3000, 500), 10000);
  const connectWithin = Math.min(Math.max(Number(timeout) || 5000, 500), 15000);

  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let st = null;
    let spokeTelnet = false;
    let connectMs = null;
    let address = null;
    let closedByPeer = false;
    let settled = false;
    let idle = null;
    const chunks = [];

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      sock.destroy();
      const text = cleanBanner(Buffer.concat(chunks).toString('utf8'));
      resolve({
        host: h,
        port: p,
        address,
        state: connectMs === null ? (extra.state || 'error') : 'open',
        connectMs,
        listenedMs: connectMs === null ? 0 : Date.now() - started - connectMs,
        text,
        telnet: spokeTelnet,
        closedByPeer,
        guess: connectMs === null ? null : guessService(text, spokeTelnet),
        command: telnetCommand(h, p),
        commandNote: TELNET_COMMAND_NOTE,
        error: extra.error || null,
      });
    };

    sock.setTimeout(connectWithin);
    sock.once('timeout', () => finish({ state: 'filtered', error: telnetError({ code: 'ETIMEDOUT' }, h, p) }));
    sock.once('connect', () => {
      connectMs = Date.now() - started;
      address = (sock.remoteAddress || '').replace(/^::ffff:/, '') || null;
      // Connected: the timeout that mattered was the connect. From here it
      // is a fixed listen, cut short once the far end has said its piece.
      sock.setTimeout(0);
      setTimeout(() => finish(), listen);
    });
    sock.on('data', (chunk) => {
      const r = telnetParse(st, chunk);
      st = r.state;
      if (r.replies.length) {
        spokeTelnet = true;
        try { sock.write(r.replies); } catch { /* the client may already have hung up */ }
      }
      if (r.sawNaws) { try { sock.write(nawsFrame(80, 24)); } catch { /* the client may already have hung up */ } }
      if (r.data.length) chunks.push(r.data);
      /*
       * Most services say everything they will say in one breath. Waiting the
       * full few seconds after a banner has arrived is waiting for nothing, so
       * a short quiet spell after some output ends the listen early.
       */
      if (chunks.length) {
        clearTimeout(idle);
        idle = setTimeout(() => finish(), 700);
      }
      if (chunks.reduce((n, c) => n + c.length, 0) > 16384) finish();
    });
    sock.once('end', () => { closedByPeer = true; finish(); });
    sock.once('close', () => { if (connectMs !== null) closedByPeer = true; finish(); });
    sock.once('error', (e) => {
      if (connectMs !== null) { closedByPeer = true; return finish(); }
      const state = e.code === 'ECONNREFUSED' ? 'closed'
        : (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') ? 'dns' : 'error';
      finish({ state, error: telnetError(e, h, p) });
    });
    sock.connect(p, h);
  });
}

/**
 * What a banner says, made fit to read: escape sequences out (a login prompt
 * in colour is still a login prompt), line endings settled, and the control
 * characters a device sends to clear a screen nobody is looking at removed.
 */
function cleanBanner(s) {
  return String(s || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[\]P^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 8192);
}

/**
 * A guess at what answered, from what it said first.
 *
 * Only the ones that announce themselves unmistakably — the point is to save
 * someone reading a version string, not to be a fingerprinting tool. Silence
 * is an answer too, and the commonest one: HTTP, TLS and most databases wait
 * to be spoken to, so an open port that says nothing is usually one of those
 * and not a fault.
 */
function guessService(text, spokeTelnet) {
  const t = String(text || '');
  if (/^SSH-\d/m.test(t)) return 'an SSH server';
  if (/^220[ -].*(?:SMTP|ESMTP|mail)/im.test(t)) return 'a mail server (SMTP)';
  if (/^220[ -].*FTP/im.test(t)) return 'an FTP server';
  if (/^\+OK/m.test(t)) return 'a POP3 server';
  if (/^\* OK/m.test(t)) return 'an IMAP server';
  if (/^-ERR|^-NOAUTH|^\+PONG/m.test(t)) return 'Redis, or something that talks like it';
  if (/mysql_native_password|caching_sha2_password/.test(t)) return 'MySQL or MariaDB';
  if (/^RFB \d{3}\.\d{3}/m.test(t)) return 'a VNC server';
  if (spokeTelnet) return 'a telnet server';
  if (/(?:login|username|user name|password)\s*:\s*$/im.test(t)) return 'something asking you to log in';
  return null;
}

/* ------------------------------------------------------------------ */
/* TLS                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The hand-run form of this check. `openssl s_client` is the standard answer
 * everywhere it is installed — which on macOS and Linux is everywhere. It is
 * not bundled with Windows, so that gets the native PowerShell equivalent
 * instead: no extra install, three lines instead of one pipe.
 *
 * `-starttls <proto>` is openssl's own flag for exactly the plaintext-then-
 * upgrade dance `starttlsHandshake()` does below, so the copyable command
 * stays a one-liner even for a STARTTLS port.
 */
function tlsCommand(host, port, starttls) {
  if (process.platform === 'win32') {
    return [
      `$c = New-Object System.Net.Sockets.TcpClient('${host}', ${port})`,
      `$s = New-Object System.Net.Security.SslStream($c.GetStream(), $false, {$true})`,
      `$s.AuthenticateAsClient('${host}'); $s.RemoteCertificate | Format-List *`,
    ].join('\n');
  }
  const flag = starttls ? ` -starttls ${starttls}` : '';
  return `openssl s_client -connect ${host}:${port}${flag} -servername ${host} </dev/null 2>/dev/null | openssl x509 -noout -text`;
}

function tlsCommandNote(host, port, starttls) {
  if (process.platform === 'win32') {
    return starttls
      ? `Or, if OpenSSL is on PATH (Git for Windows carries one): openssl s_client -connect ${host}:${port} -starttls ${starttls} -servername ${host} 2>$null | openssl x509 -noout -text`
      : `Or, if OpenSSL is on PATH (Git for Windows carries one): openssl s_client -connect ${host}:${port} -servername ${host} 2>$null | openssl x509 -noout -text`;
  }
  return null;
}

/** The default plaintext port each STARTTLS protocol usually answers on. */
const STARTTLS_PORTS = { smtp: 587, imap: 143, pop3: 110 };

/**
 * The plaintext half of STARTTLS: say hello, ask to upgrade, and wait for
 * the server to agree — all three protocols spell this differently — before
 * handing the raw socket to `tls.connect({ socket })`. Opportunistic TLS on
 * 25/587/143/110 is otherwise invisible to this tool: the port never speaks
 * TLS until asked, in cleartext, first.
 */
function starttlsHandshake(sock, protocol) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let stage = 0;
    const fail = (msg) => { sock.removeListener('data', onData); reject(new Error(msg)); };
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      if (protocol === 'smtp') {
        // Multi-line greeting/EHLO replies continue "250-…"; the final line
        // of a block is the only one spelled "250 " (a space, not a dash).
        if (stage === 0 && /^220[ -]/.test(buf)) {
          if (!/^220 /m.test(buf)) return;
          buf = ''; stage = 1; return sock.write('EHLO serverlife.local\r\n');
        }
        if (stage === 1 && /^250[ -]/.test(buf)) {
          if (!/^250 /m.test(buf)) return;
          buf = ''; stage = 2; return sock.write('STARTTLS\r\n');
        }
        if (stage === 2) {
          if (/^220/.test(buf)) { sock.removeListener('data', onData); return resolve(); }
          if (/^5\d\d/.test(buf)) return fail(buf.split('\r\n')[0] || 'STARTTLS refused.');
        }
      } else if (protocol === 'imap') {
        if (stage === 0 && /^\*\s+OK/i.test(buf)) {
          buf = ''; stage = 1; return sock.write('a1 STARTTLS\r\n');
        }
        if (stage === 1) {
          if (/^a1\s+OK/im.test(buf)) { sock.removeListener('data', onData); return resolve(); }
          if (/^a1\s+(NO|BAD)/im.test(buf)) return fail(buf.split('\r\n')[0] || 'STARTTLS refused.');
        }
      } else if (protocol === 'pop3') {
        if (stage === 0 && /^\+OK/.test(buf)) {
          buf = ''; stage = 1; return sock.write('STLS\r\n');
        }
        if (stage === 1) {
          if (/^\+OK/.test(buf)) { sock.removeListener('data', onData); return resolve(); }
          if (/^-ERR/.test(buf)) return fail(buf.split('\r\n')[0] || 'STLS refused.');
        }
      }
    };
    sock.on('data', onData);
    sock.once('error', (e) => fail(e.message));
  });
}

/**
 * The full certificate chain the server presented, leaf first — not just
 * the one `getPeerCertificate` singles out. `.issuerCertificate` links each
 * cert to the one that signed it, down to a self-signed root (which points
 * to itself, hence the `seen` check rather than walking until `null`).
 */
function certChain(leaf) {
  const chain = [];
  const seen = new Set();
  let c = leaf;
  while (c && Object.keys(c).length && !seen.has(c.fingerprint256)) {
    seen.add(c.fingerprint256);
    chain.push({
      subject: c.subject || null,
      issuer: c.issuer || null,
      validFrom: c.valid_from || null,
      validTo: c.valid_to || null,
      fingerprint256: c.fingerprint256 || null,
      serialNumber: c.serialNumber || null,
    });
    c = c.issuerCertificate;
  }
  return chain;
}

function tlsResult(sock, h, p, command, commandNote) {
  const cert = sock.getPeerCertificate(true) || {};
  const now = Date.now();
  const to = cert.valid_to ? new Date(cert.valid_to).getTime() : null;
  const chain = certChain(cert);
  const last = chain[chain.length - 1] || null;
  return {
    ok: true,
    host: h,
    port: p,
    command,
    commandNote,
    authorized: sock.authorized,
    authorizationError: sock.authorizationError ? String(sock.authorizationError) : null,
    protocol: sock.getProtocol(),
    cipher: sock.getCipher(),
    alpn: sock.alpnProtocol || null,
    subject: cert.subject || null,
    issuer: cert.issuer || null,
    validFrom: cert.valid_from || null,
    validTo: cert.valid_to || null,
    daysLeft: to ? Math.round((to - now) / 86400000) : null,
    san: cert.subjectaltname || null,
    fingerprint256: cert.fingerprint256 || null,
    serialNumber: cert.serialNumber || null,
    // The rest of the chain, intermediates then root — empty when the leaf
    // is all the server sent, which is itself worth knowing.
    chain,
    // A guess at "did it send the whole chain", from whether the last cert
    // in it is self-signed (subject === issuer) rather than just truncated.
    chainComplete: last ? JSON.stringify(last.subject) === JSON.stringify(last.issuer) : null,
  };
}

async function tlsInfo({ host, port, starttls } = {}) {
  const parsed = splitHostPort(host);
  const h = checkHost(parsed.host);
  const proto = STARTTLS_PORTS[starttls] ? starttls : null;
  const p = Number(port) || parsed.port || (proto ? STARTTLS_PORTS[proto] : 443);
  const command = tlsCommand(h, p, proto);
  const commandNote = tlsCommandNote(h, p, proto);

  if (proto) {
    return new Promise((resolve) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { plain.destroy(); } catch { /* already gone */ }
        resolve({ ok: false, host: h, port: p, command, commandNote, error });
      };
      const timer = setTimeout(() => fail('Timed out waiting on STARTTLS.'), 12000);
      const plain = net.connect({ host: h, port: p });
      plain.once('error', (e) => fail(e.message));
      plain.once('connect', async () => {
        try { await starttlsHandshake(plain, proto); } catch (e) { return fail(e.message); }
        if (settled) return;
        const sock = tls.connect({
          socket: plain, servername: net.isIP(h) ? undefined : h, rejectUnauthorized: false, timeout: 10000,
        }, () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(tlsResult(sock, h, p, command, commandNote));
          sock.end();
        });
        sock.once('timeout', () => fail('Timed out.'));
        sock.once('error', (e) => fail(e.message));
      });
    });
  }

  return new Promise((resolve) => {
    const sock = tls.connect({
      host: h, port: p, servername: net.isIP(h) ? undefined : h,
      // Report what the server presents, including a chain that does not
      // validate — "the certificate is expired" is the answer, not an error.
      rejectUnauthorized: false,
      timeout: 10000,
    }, () => {
      resolve(tlsResult(sock, h, p, command, commandNote));
      sock.end();
    });
    sock.once('timeout', () => { sock.destroy(); resolve({ ok: false, host: h, port: p, command, commandNote, error: 'Timed out.' }); });
    sock.once('error', (e) => resolve({ ok: false, host: h, port: p, command, commandNote, error: e.message }));
  });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const MAX_REDIRECTS = 5;

function requestOnce(url, { method, insecure, timeout, headers }) {
  const mod = url.protocol === 'http:' ? require('http') : https;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const reqHeaders = { 'User-Agent': 'ServerLife', Accept: '*/*' };
    for (const h of headerLines(headers)) {
      const i = h.indexOf(':');
      if (i < 1) continue;
      reqHeaders[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    const req = mod.request(url, {
      method,
      timeout,
      rejectUnauthorized: !insecure,
      headers: reqHeaders,
    }, (res) => {
      let bytes = 0;
      let body = '';
      res.on('data', (c) => {
        bytes += c.length;
        // Enough to see what came back, never enough to hold a download.
        if (body.length < 2048) body += c.toString('utf8', 0, 2048);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.headers,
        ms: Date.now() - started,
        bytes,
        preview: body.slice(0, 2048),
      }));
    });
    req.once('timeout', () => req.destroy(new Error('Timed out.')));
    req.once('error', reject);
    req.end();
  });
}

/**
 * An HTTP(S) check: status, headers, timing and the redirect chain. Bodies are
 * read only far enough to show what came back — this is a reachability probe,
 * not a download.
 */
/*
 * curl is the one HTTP client spelled the same on every platform this check
 * runs on — it has shipped in Windows itself since the 2018 update, same
 * binary name and flags as macOS and Linux. Quoted even though a URL rarely
 * needs it: `&` and `?` are shell-special in bash/zsh, and an unquoted one
 * pasted straight from here would run a different command than the one
 * shown.
 */
function httpCommand(url, method, insecure, headers) {
  const m = String(method || 'GET').toUpperCase();
  const h = headerLines(headers).map((x) => ` -H '${x.replace(/'/g, `'\\''`)}'`).join('');
  return `curl -sv${m === 'HEAD' ? ' -I' : ' -X ' + m}${insecure ? ' -k' : ''}${h} -- '${url}'`;
}

async function httpCheck({ url, method = 'GET', insecure = false, timeout = 15000, headers = '' } = {}) {
  let raw = String(url || '').trim();
  if (!raw) throw new Error('Give a URL or host.');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  let target;
  try { target = new URL(raw); } catch { throw new Error('That is not a valid URL.'); }
  if (!/^https?:$/.test(target.protocol)) throw new Error('Only http and https are supported.');
  checkHost(target.hostname);

  const m = String(method).toUpperCase();
  if (!['GET', 'HEAD'].includes(m)) throw new Error('Only GET and HEAD are supported.');

  const chain = [];
  let current = target;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await requestOnce(current, { method: m, insecure, timeout, headers });
    chain.push({ url: current.toString(), ...res });
    const loc = res.headers?.location;
    if (!loc || res.status < 300 || res.status >= 400 || i === MAX_REDIRECTS) break;
    try { current = new URL(loc, current); } catch { break; }
    checkHost(current.hostname);
  }
  return { chain, final: chain[chain.length - 1], redirects: chain.length - 1, command: httpCommand(target.toString(), m, insecure, headers) };
}

/* ------------------------------------------------------------------ */
/* Whois                                                               */
/* ------------------------------------------------------------------ */

/** Windows carries no whois client at all, built in or otherwise. */
const WHOIS_COMMAND_NOTE = process.platform === 'win32'
  ? 'Windows has no built-in whois client. `winget install whois`, Sysinternals\' '
    + 'whois64, or a web lookup all work; this machine was asked for `whois` on PATH.'
  : null;

function whoisCommand(host) { return `whois ${host}`; }

async function whois({ host } = {}) {
  const h = checkHost(splitHostPort(host).host);
  const r = await run('whois', [h], { timeout: 25000 });
  if (!r.text) {
    return { host: h, ok: false, text: 'whois is not installed or returned nothing.', commandNote: WHOIS_COMMAND_NOTE };
  }
  return { host: h, ...r, command: whoisCommand(h), commandNote: WHOIS_COMMAND_NOTE };
}

/* ------------------------------------------------------------------ */
/* Teleport proxy                                                      */
/* ------------------------------------------------------------------ */

/** Pure: the proxy ping URL, no I/O — shared by the real call and the preview. */
function webapiPingUrl(host, port) {
  return `https://${net.isIP(host) && host.includes(':') ? `[${host}]` : host}:${port}/webapi/ping`;
}

function teleportPingCommand(url, insecure) { return `curl -s${insecure ? 'k' : ''} -- '${url}'`; }

/**
 * A proxy's `/webapi/ping`: cluster name, version, edition, which auth
 * connector is in play and what the proxy listens on. It needs no credentials,
 * which makes it the one thing you can always ask a cluster.
 */
async function webapiPing({ proxy, insecure = false } = {}) {
  const parsed = splitHostPort(proxy);
  const h = checkHost(parsed.host);
  const port = parsed.port || 443;
  const url = webapiPingUrl(h, port);
  const started = Date.now();

  const body = await new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 15000,
      rejectUnauthorized: !insecure,
      headers: { 'User-Agent': 'ServerLife', Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(new Error('Response too large.')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${url} returned HTTP ${res.statusCode}`));
        resolve(data);
      });
    });
    req.once('timeout', () => req.destroy(new Error('Timed out.')));
    req.once('error', reject);
  });

  let json;
  try { json = JSON.parse(body); } catch { throw new Error('The proxy did not return JSON.'); }
  return { url, ms: Date.now() - started, ping: json, command: teleportPingCommand(url, insecure) };
}

/* ------------------------------------------------------------------ */

/** The local side of the picture, for when nothing external works at all. */
function localInfo() {
  const addrs = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal) continue;
      addrs.push({ name, family: a.family, address: a.address, mac: a.mac, cidr: a.cidr });
    }
  }
  return { hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, addresses: addrs, dnsServers: dns.getServers() };
}

/* ------------------------------------------------------------------ */
/* curl                                                               */
/* ------------------------------------------------------------------ */

const CURL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * A request, as curl would make it.
 *
 * The real binary rather than Node's http: what people want from this is the
 * answer their `curl` would give — the same proxy variables, the same CA
 * store, the same HTTP/2 — and a command line they can paste elsewhere. So
 * the argv is built once and used for both.
 *
 * Nothing goes near a shell: execFile takes the array, and the printable
 * command is quoted separately for display only.
 */
function curlArgs(o) {
  const method = CURL_METHODS.includes(String(o.method || '').toUpperCase())
    ? o.method.toUpperCase() : 'GET';
  const args = [
    // Fail quietly on progress, but keep the error text; include the response
    // headers; never read a local .curlrc that could change the result.
    '-sS', '-q', '-i',
    '--max-time', String(Math.min(Math.max(Number(o.timeout) || 20, 1), 300)),
    '-X', method,
  ];
  if (o.followRedirects) args.push('-L', '--max-redirs', '5');
  /*
   * Through a host rather than from here.
   *
   * `--socks5-hostname` resolves the name at the *proxy*, which is the whole
   * point: the question is what that host can reach and how it resolves, not
   * what this laptop can.
   */
  if (o.proxy) args.push('--socks5-hostname', String(o.proxy));
  if (o.insecure) args.push('-k');
  if (o.http2) args.push('--http2');
  if (o.compressed) args.push('--compressed');
  // "What would this look like after the cutover" without touching DNS or
  // /etc/hosts: curl's own way to pin a name to an address for one request.
  for (const entry of resolveEntries(o.resolve)) args.push('--resolve', entry);
  // A private CA, or mutual TLS — both common enough against an internal
  // proxy or a service mesh that "just use -k" is the wrong answer to them.
  if (o.caCert) args.push('--cacert', String(o.caCert));
  if (o.clientCert) args.push('--cert', String(o.clientCert));
  if (o.clientKey) args.push('--key', String(o.clientKey));

  for (const h of headerLines(o.headers)) args.push('-H', h);

  if (o.bearer) args.push('-H', 'Authorization: Bearer ' + String(o.bearer).trim());
  else if (o.basicUser) args.push('-u', `${o.basicUser}:${o.basicPass || ''}`);

  const body = String(o.body || '');
  if (body && !['GET', 'HEAD'].includes(method)) {
    // --data-binary, so a JSON body with newlines arrives as written rather
    // than with curl stripping them the way --data does.
    args.push('--data-binary', body);
    if (!headerLines(o.headers).some((h) => /^content-type\s*:/i.test(h)) && o.contentType) {
      args.push('-H', 'Content-Type: ' + o.contentType);
    }
  }
  args.push('--', checkUrl(o.url));
  return { args, method };
}

function headerLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l.includes(':'));
}

/**
 * `--resolve host:port:address` entries, one per line or comma-separated.
 * Only checked for the right shape — curl is the authority on whether the
 * address itself makes sense, same as every other field here that hands
 * curl something to judge rather than re-implementing its own validation.
 */
function resolveEntries(text) {
  return String(text || '').split(/[\n,]+/).map((l) => l.trim()).filter(Boolean).map((entry) => {
    if (!/^.+:\d{1,5}:.+$/.test(entry)) throw new Error(`"${entry}" is not host:port:address for --resolve.`);
    return entry;
  });
}

function checkUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('Give a URL.');
  let parsed;
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : 'https://' + u); }
  catch { throw new Error('That is not a URL curl can fetch.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are fetched here.');
  }
  return parsed.toString();
}

/**
 * A copy-pasteable form of the same call, for a terminal or a ticket.
 *
 * `curl` itself takes the same flags on every platform — this only has to
 * get *quoting* right for wherever it is pasted, and that differs: a
 * PowerShell single-quoted string escapes an embedded `'` by doubling it,
 * not POSIX's `'\''`. cmd.exe is left out on purpose — its quoting is
 * inconsistent enough that nothing reliable fits in one line, and
 * PowerShell is the default prompt `Win+X` opens since Windows 10.
 */
function curlCommand(args) {
  const win = process.platform === 'win32';
  const q = (s) => {
    if (/^[\w@%+=:,./-]+$/.test(s)) return s;
    return win ? "'" + String(s).replace(/'/g, "''") + "'"
      : "'" + String(s).replace(/'/g, `'\\''`) + "'";
  };
  return 'curl ' + args.map(q).join(' ');
}

/**
 * Run it, and split the response into headers and body.
 *
 * `-i` puts the headers in stdout, which means a redirect chain arrives as
 * several header blocks; all of them are kept, because "which hop set that
 * cookie" is a question this is used to answer.
 */
async function curlRequest(opts = {}) {
  const { args, method } = curlArgs(opts);
  const started = Date.now();
  const r = await new Promise((resolve) => {
    execFile('curl', args, {
      timeout: (Math.min(Math.max(Number(opts.timeout) || 20, 1), 300) + 5) * 1000,
      maxBuffer: 24 * 1024 * 1024,
      // A secret in an argv is visible to `ps`; this is the same exposure a
      // hand-typed curl has, and the alternative (a temp file) leaves it on
      // disk instead. Said plainly in the UI rather than hidden here.
      env: toolEnv(),
    }, (err, stdout, stderr) => resolve({
      err, stdout: String(stdout || ''), stderr: String(stderr || ''),
    }));
  });
  const ms = Date.now() - started;

  if (r.err && !r.stdout) {
    const msg = r.stderr.trim() || r.err.message;
    if (r.err.code === 'ENOENT') throw new Error('curl was not found on this machine.');
    throw new Error(msg.replace(/^curl:\s*/, ''));
  }

  // Header blocks, then whatever is left is the body.
  const text = r.stdout;
  const blocks = [];
  let rest = text;
  while (/^HTTP\/[\d.]+ \d{3}/.test(rest)) {
    const cut = rest.search(/\r?\n\r?\n/);
    if (cut < 0) { blocks.push(rest); rest = ''; break; }
    blocks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\r?\n\r?\n/, '');
  }

  const hops = blocks.map((b) => {
    const lines = b.split(/\r?\n/).filter(Boolean);
    const statusLine = lines.shift() || '';
    const m = statusLine.match(/^HTTP\/([\d.]+)\s+(\d{3})\s*(.*)$/);
    const headers = {};
    for (const l of lines) {
      const i = l.indexOf(':');
      if (i < 1) continue;
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim();
      headers[k] = headers[k] ? headers[k] + ', ' + v : v;
    }
    return {
      httpVersion: m?.[1] || '', status: Number(m?.[2]) || 0, statusText: m?.[3] || '',
      headers,
    };
  });

  const last = hops[hops.length - 1] || null;
  const type = last?.headers ? (last.headers['Content-Type'] || last.headers['content-type'] || '') : '';
  return {
    ok: !!last && last.status < 400,
    method,
    url: args[args.length - 1],
    command: curlCommand(args),
    status: last?.status || 0,
    statusText: last?.statusText || '',
    httpVersion: last?.httpVersion || '',
    headers: last?.headers || {},
    hops: hops.length > 1 ? hops : [],
    contentType: type,
    body: rest,
    bytes: Buffer.byteLength(rest),
    ms,
    stderr: r.stderr.trim(),
    // A non-zero exit with output still says something went wrong late on.
    exitCode: r.err ? (r.err.code === undefined ? null : r.err.code) : 0,
  };
}

/**
 * Which package installs a tool, for an honest hint rather than a shrug.
 *
 * Only the ones worth suggesting: a missing `curl` or `dig` is an apt-get
 * away, and saying so beats greying a button out in silence.
 */
const TOOL_PACKAGES = {
  dig: { apt: 'dnsutils', dnf: 'bind-utils', yum: 'bind-utils', zypper: 'bind-utils', apk: 'bind-tools', pacman: 'bind', brew: 'bind' },
  host: { apt: 'dnsutils', dnf: 'bind-utils', yum: 'bind-utils', zypper: 'bind-utils', apk: 'bind-tools', brew: 'bind' },
  nslookup: { apt: 'dnsutils', dnf: 'bind-utils', yum: 'bind-utils', brew: 'bind' },
  traceroute: { apt: 'traceroute', dnf: 'traceroute', yum: 'traceroute', zypper: 'traceroute', apk: 'traceroute', pacman: 'traceroute' }, // macOS/BSD traceroute is bundled, not a brew formula
  tracepath: { apt: 'iputils-tracepath', dnf: 'iputils', yum: 'iputils' },
  mtr: { apt: 'mtr-tiny', dnf: 'mtr', yum: 'mtr', apk: 'mtr', pacman: 'mtr', brew: 'mtr' },
  nc: { apt: 'netcat-openbsd', dnf: 'nmap-ncat', yum: 'nmap-ncat', zypper: 'netcat-openbsd', apk: 'netcat-openbsd', pacman: 'openbsd-netcat', brew: 'netcat' },
  curl: { apt: 'curl', dnf: 'curl', yum: 'curl', zypper: 'curl', apk: 'curl', pacman: 'curl', brew: 'curl' },
  openssl: { apt: 'openssl', dnf: 'openssl', yum: 'openssl', zypper: 'openssl', apk: 'openssl', pacman: 'openssl', brew: 'openssl' },
  ping: { apt: 'iputils-ping', dnf: 'iputils', yum: 'iputils', apk: 'iputils' }, // macOS/BSD ping is bundled, not a brew formula
  whois: { apt: 'whois', dnf: 'whois', yum: 'whois', apk: 'whois', brew: 'whois' },
  python3: { apt: 'python3', dnf: 'python3', yum: 'python3', apk: 'python3' },
  ss: { apt: 'iproute2', dnf: 'iproute', yum: 'iproute', zypper: 'iproute2', apk: 'iproute2', pacman: 'iproute2' },
  netstat: { apt: 'net-tools', dnf: 'net-tools', yum: 'net-tools', zypper: 'net-tools', apk: 'net-tools', pacman: 'net-tools' },
  // KubeLife's ecosystem launchers (kubebin.js ECOSYSTEM_TOOLS) — most of
  // these have no apt/dnf/yum package at all (upstream ships only a binary
  // or a brew/snap formula), so most rows here are deliberately sparse: an
  // honest "no hint" beats inventing a package name that does not exist.
  kubectl: { apk: 'kubectl', brew: 'kubernetes-cli' },
  helm: { apk: 'helm', brew: 'helm', pacman: 'helm' },
  k9s: { brew: 'k9s', pacman: 'k9s' },
  stern: { brew: 'stern', pacman: 'stern' },
  kubectx: { apt: 'kubectx', dnf: 'kubectx', brew: 'kubectx', pacman: 'kubectx' },
  kubens: { apt: 'kubectx', dnf: 'kubectx', brew: 'kubectx', pacman: 'kubectx' }, // same package as kubectx upstream
  kind: { brew: 'kind', pacman: 'kind' },
  k3d: { brew: 'k3d', pacman: 'k3d' },
  minikube: { brew: 'minikube', pacman: 'minikube' },
  kustomize: { apk: 'kustomize', brew: 'kustomize', pacman: 'kustomize' },
};

/** `sudo apt install dnsutils`, or nothing if we cannot say. */
function installHint(tool, pkgManager) {
  const pkg = TOOL_PACKAGES[tool]?.[pkgManager];
  if (!pkg) return '';
  const verb = ({ apt: 'apt install', dnf: 'dnf install', yum: 'yum install',
    zypper: 'zypper install', apk: 'apk add', pacman: 'pacman -S', brew: 'brew install' })[pkgManager];
  if (!verb) return '';
  return `${pkgManager === 'brew' ? '' : 'sudo '}${verb} ${pkg}`;
}

/**
 * The command a tool would run, with no I/O at all — for a live preview and
 * the "Copy command" button, both answerable before the target is even
 * dialled. Every branch mirrors the real function's own host/port parsing
 * exactly, so what is copied here is never a command the real run would not
 * have made. A target that is not valid yet — empty, or mid-keystroke — is
 * not an error, just nothing to preview.
 */
function previewCommand({ tool, host, ports, count, method, insecure, telnetPort, server, ipVersion, starttls, headers } = {}) {
  const raw = String(host || '').trim();
  if (!raw) return { command: null };
  try {
    switch (tool) {
      case 'ping': return { command: pingCommand(checkHost(splitHostPort(raw).host), count, ipVersion) };
      case 'traceroute': return { command: tracerouteCommand(checkHost(splitHostPort(raw).host), undefined, ipVersion) };
      case 'dns': return { command: dnsCommand(checkHost(splitHostPort(raw).host), server ? checkHost(splitHostPort(server).host) : null) };
      case 'ports': {
        const parsed = splitHostPort(raw);
        const h = checkHost(parsed.host);
        const list = ports ? parsePorts(ports) : (parsed.port ? [parsed.port] : DEFAULT_PORTS);
        return { command: list.map((p) => portCommand(h, p, ipVersion)).join('\n') };
      }
      case 'telnet': {
        const parsed = splitHostPort(raw);
        const h = checkHost(parsed.host);
        const p = Number(telnetPort) || parsed.port || 23;
        return { command: telnetCommand(h, p), commandNote: TELNET_COMMAND_NOTE };
      }
      case 'tls': {
        const parsed = splitHostPort(raw);
        const h = checkHost(parsed.host);
        const proto = STARTTLS_PORTS[starttls] ? starttls : null;
        const p = parsed.port || (proto ? STARTTLS_PORTS[proto] : 443);
        return { command: tlsCommand(h, p, proto), commandNote: tlsCommandNote(h, p, proto) };
      }
      case 'http': {
        let u = raw;
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        const target = new URL(u);
        checkHost(target.hostname);
        return { command: httpCommand(target.toString(), method, insecure, headers) };
      }
      case 'whois': return { command: whoisCommand(checkHost(splitHostPort(raw).host)), commandNote: WHOIS_COMMAND_NOTE };
      case 'teleport': {
        const parsed = splitHostPort(raw);
        const h = checkHost(parsed.host);
        const port = parsed.port || 443;
        return { command: teleportPingCommand(webapiPingUrl(h, port), insecure) };
      }
      default: return { command: null };
    }
  } catch (e) {
    return { command: null, error: e.message };
  }
}

module.exports = {
  ping, traceroute, lookup, portCheck, tlsInfo, httpCheck, whois, webapiPing, localInfo,
  telnetProbe, cleanBanner, guessService,
  curlRequest, curlArgs, curlCommand, CURL_METHODS,
  installHint, TOOL_PACKAGES,
  previewCommand,
  // Shared with the remote versions of these checks, which parse a target and
  // a port list exactly as the local ones do.
  splitHostPort, parsePorts, checkHost,
  DEFAULT_PORTS, MAX_PORTS, DNS_TYPES, STARTTLS_PORTS,
};
