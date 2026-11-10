'use strict';
/**
 * Connection manager.
 *
 * Each connection owns one OpenSSH ControlMaster. Authentication happens once,
 * there; terminals and the SFTP browser then ride that socket with no further
 * prompts. The master runs inside a PTY so password, key-passphrase and
 * Teleport MFA prompts can be surfaced to the UI and answered.
 */

const os = require('os');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const pty = require('node-pty');
const sshoptions = require('./sshoptions');
const { SftpClient } = require('./sftp');
const { TransferQueue } = require('./transfers');
const teleport = require('./teleport');
const beams = require('./beams');
const sshbin = require('./sshbin');
const sockets = require('./sockets');

const RUNTIME_DIR = path.join(os.tmpdir(), 'serverlife-' + (process.getuid ? process.getuid() : 'u'));
fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });

/** Unix socket paths cap at ~104 chars, so keep the control path short. */
function controlPathFor(key) {
  const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return path.join(RUNTIME_DIR, 'c-' + h);
}

const PROMPT_RE = /(password:|passphrase for|passcode|verification code|otp|tap any security key|touch your|enter your |2fa|yubikey|\(yes\/no|press any key)/i;

/**
 * Connection multiplexing needs ControlMaster, which rides a Unix domain
 * socket. Win32 OpenSSH has never supported it, so on Windows each channel
 * dials its own connection instead. Everything above this layer is unchanged;
 * the cost is one SSH handshake per terminal/transfer rather than one total.
 */
const SUPPORTS_MUX = process.platform !== 'win32';

/**
 * The master is held in the foreground by our own PTY rather than
 * daemonised. ControlPersist would background it inside the same PTY session,
 * where closing the PTY SIGHUPs it out of existence; owning the process
 * outright gives a lifetime we control and a real signal when it drops.
 */
const BASE_OPTS = [
  '-o', 'ControlMaster=yes',
  '-o', 'ControlPersist=no',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=no',
];

let connSeq = 0;
let fwdSeq = 0;
let execSeq = 0;

/** A local port nothing is listening on, for a temporary proxy. */
function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Shell history files, which no two shells write the same way.
 *
 * - **bash** writes the command and nothing else, unless `HISTTIMEFORMAT` is
 *   set, in which case a `#1700000000` line precedes each one.
 * - **zsh** with `EXTENDED_HISTORY` writes `: 1700000000:0;the command`, and
 *   continues a multi-line command on the next line with a trailing
 *   backslash. Without the option it is bare lines, like bash.
 * - **fish** writes a small YAML-ish record, `- cmd: the command`.
 *
 * Anything unrecognised is taken as a bare command line, which is what every
 * one of these degrades to.
 */
function parseHistory(text) {
  const out = [];
  let shell = '';
  let pending = null;   // a zsh command continued across lines

  const push = (command, at) => {
    const c = String(command || '').trim();
    // Blank lines, and the `: 1234:0;` of an empty zsh entry.
    if (c) out.push({ command: c, shell, at: at || null });
  };

  for (const raw of String(text || '').split('\n')) {
    const marker = raw.startsWith('@@SLHIST@@');
    if (marker) {
      if (pending) { push(pending.command, pending.at); pending = null; }
      const path = raw.slice('@@SLHIST@@'.length);
      shell = /zsh|histfile/.test(path) ? 'zsh'
        : /fish/.test(path) ? 'fish'
          : /bash/.test(path) ? 'bash' : 'sh';
      continue;
    }

    // A continued zsh command: everything up to the line that does not end
    // in a backslash belongs to the same entry.
    if (pending) {
      const more = raw.replace(/\\$/, '');
      pending.command += '\n' + more;
      if (!/\\$/.test(raw)) { push(pending.command, pending.at); pending = null; }
      continue;
    }

    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;

    const zsh = line.match(/^:\s*(\d+):\d+;(.*)$/);
    if (zsh) {
      const at = Number(zsh[1]) * 1000;
      if (/\\$/.test(line)) pending = { command: zsh[2].replace(/\\$/, ''), at };
      else push(zsh[2], at);
      continue;
    }

    const fish = line.match(/^- cmd:\s?(.*)$/);
    if (fish) { push(fish[1]); continue; }
    // fish's other keys, and its continuation lines, are not commands.
    if (shell === 'fish' && /^\s/.test(line)) continue;

    // bash's `HISTTIMEFORMAT` stamp, which is a time and not a command.
    const stamp = line.match(/^#(\d{9,})$/);
    if (stamp) continue;

    push(line);
  }
  if (pending) push(pending.command, pending.at);
  return out;
}

/** The line of ssh's complaint that actually says what went wrong. */
function firstProblem(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /open failed|refused|timed out|unreachable|Could not resolve|No route/i.test(l))
    || lines[lines.length - 1]
    || '';
}

/**
 * Exec the first sftp-server that exists, writing nothing to stdout before it
 * so the SFTP stream starts clean. Paths differ across distributions.
 */
const SFTP_SERVER_CHAIN = [
  'for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server',
  '/usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server',
  '/usr/lib/ssh/sftp-server; do [ -x "$p" ] && exec "$p"; done;',
  'command -v sftp-server >/dev/null 2>&1 && exec sftp-server;',
  'echo "sftp-server not found on this host" >&2; exit 127',
].join(' ');

/**
 * Best-effort "what directory is the user's shell in".
 *
 * A naive `pgrep -n -f "bash|zsh|..."` matches the probe's own command line —
 * the pattern text is literally in its argv — so it returns a PID that has
 * already exited by the time its cwd is read. This walks real shell processes
 * newest-first, skipping this probe and its parent, and takes the first whose
 * cwd can actually be resolved. /proc on Linux, lsof elsewhere.
 */
const CWD_PROBE = `
self=$$
parent=$PPID
for p in $(ps -u "$(id -un)" -o pid=,comm= 2>/dev/null \
           | awk '$2 ~ /^-?(bash|zsh|sh|fish|ksh|dash|tcsh|csh)$/ { print $1 }' \
           | sort -rn); do
  [ "$p" = "$self" ] && continue
  [ "$p" = "$parent" ] && continue
  d=$(readlink "/proc/$p/cwd" 2>/dev/null)
  if [ -z "$d" ]; then
    d=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  fi
  case "$d" in
    /*) echo "$d"; break ;;
  esac
done
`.trim();

/**
 * The live monitor: one long-running command that prints a line of numbers
 * every few seconds, for the bar under a session.
 *
 * One process for as long as the bar is shown, not a command per sample: on
 * a Teleport node every exec is a session in the audit log, and one session
 * that stays open is one entry, where a poll every five seconds would be
 * seventeen thousand a day. CPU and network are rates, so the script keeps
 * the previous reading and prints the difference. Linux reads /proc; a host
 * without it says so once and stops, rather than printing zeros.
 */
const MONITOR_SCRIPT = (interval) => `
i=${Math.max(2, Math.min(60, Math.round(interval) || 5))}
if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then echo "SLMON unsupported=$(uname -s 2>/dev/null)"; exit 0; fi
cpu() { awk '/^cpu /{t=0; for(k=2;k<=NF;k++) t+=$k; print t, $5+$6; exit}' /proc/stat; }
net() { awk -F'[: ]+' 'NR>2 && $2!="lo" {rx+=$3; tx+=$11} END{print rx+0, tx+0}' /proc/net/dev 2>/dev/null || echo "0 0"; }
n=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)
set -- $(cpu); pt=$1; pi=$2
set -- $(net); prx=$1; ptx=$2
echo "SLMON hello cpus=$n interval=$i"
while :; do
  sleep $i
  set -- $(cpu); t=$1; idle=$2
  set -- $(net); rx=$1; tx=$2
  dt=$((t-pt)); di=$((idle-pi)); c=0
  [ "$dt" -gt 0 ] && c=$(( (1000*(dt-di)) / dt ))
  set -- $(awk '/^MemTotal:/{a=$2} /^MemAvailable:/{b=$2} /^SwapTotal:/{c=$2} /^SwapFree:/{d=$2} END{print a+0, b+0, c+0, d+0}' /proc/meminfo)
  mt=$1; ma=$2; st=$3; sf=$4
  l=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
  d=$(df -P / 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')
  u=$(cut -d. -f1 /proc/uptime 2>/dev/null)
  echo "SLMON cpu=$c memt=$mt mema=$ma swapt=$st swapf=$sf load=\${l:-0} disk=\${d:-0} rx=$(( (rx-prx)/i )) tx=$(( (tx-ptx)/i )) up=\${u:-0}"
  pt=$t; pi=$idle; prx=$rx; ptx=$tx
done
`.trim();

/**
 * One line of the monitor's output as numbers, or null for anything else.
 * CPU arrives in tenths of a percent so the shell never needs floating point.
 */
function parseMonitorLine(line) {
  const m = String(line || '').match(/^SLMON (.*)$/);
  if (!m) return null;
  const kv = {};
  for (const part of m[1].trim().split(/\s+/)) {
    const i = part.indexOf('=');
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
    else kv[part] = true;
  }
  if (kv.unsupported !== undefined) return { kind: 'unsupported', os: kv.unsupported || '' };
  if (kv.hello) return { kind: 'hello', cpus: Number(kv.cpus) || 1, interval: Number(kv.interval) || 5 };
  const num = (k) => (Number.isFinite(Number(kv[k])) ? Number(kv[k]) : 0);
  const memTotal = num('memt') * 1024;
  const memAvail = num('mema') * 1024;
  const swapTotal = num('swapt') * 1024;
  return {
    kind: 'sample',
    at: Date.now(),
    cpu: Math.max(0, Math.min(100, num('cpu') / 10)),
    memTotal,
    memUsed: Math.max(0, memTotal - memAvail),
    swapTotal,
    swapUsed: Math.max(0, swapTotal - num('swapf') * 1024),
    load: num('load'),
    disk: Math.max(0, Math.min(100, num('disk'))),
    rx: Math.max(0, num('rx')),
    tx: Math.max(0, num('tx')),
    uptime: num('up'),
  };
}

/**
 * Probe script for remote host facts. Written to run under any POSIX shell and
 * to stay silent about anything the box does not have.
 */
const INFO_SCRIPT = `
echo "kernel_sys=$(uname -s 2>/dev/null)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "hostname=$(hostname 2>/dev/null)"
echo "user=$(id -un 2>/dev/null)"
echo "shell=$SHELL"
if [ -r /etc/os-release ]; then
  . /etc/os-release 2>/dev/null
  echo "os_pretty=$PRETTY_NAME"
  echo "os_name=$NAME"
  echo "os_version=$VERSION"
  echo "os_id=$ID"
elif [ "$(uname -s)" = "Darwin" ]; then
  echo "os_pretty=macOS $(sw_vers -productVersion 2>/dev/null)"
  echo "os_id=macos"
fi
echo "uptime=$(uptime -p 2>/dev/null || uptime 2>/dev/null | sed 's/^ *//')"
echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"
echo "cpu_model=$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null || sysctl -n machdep.cpu.brand_string 2>/dev/null)"
echo "mem_total_kb=$(awk '/^MemTotal/{print $2}' /proc/meminfo 2>/dev/null)"
echo "mem_avail_kb=$(awk '/^MemAvailable/{print $2}' /proc/meminfo 2>/dev/null)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
echo "disk_root=$(df -Ph / 2>/dev/null | awk 'NR==2{print $2" used "$3" ("$5")"}')"
echo "virt=$(systemd-detect-virt 2>/dev/null)"
echo "init=$(command -v systemctl >/dev/null 2>&1 && echo systemd || echo other)"
echo "users_online=$(who 2>/dev/null | wc -l | tr -d ' ')"
for p in apt dnf yum zypper apk pacman brew; do
  if command -v "$p" >/dev/null 2>&1; then echo "pkg=$p"; break; fi
done
for c in docker kubectl podman helm kustomize; do
  if command -v "$c" >/dev/null 2>&1; then echo "has_$c=yes"; fi
done
# The script is a report, not a test. Without this its exit status is whatever
# the last thing in it happened to return, and a perfectly good read gets
# thrown away because some box's final \`command -v\` found nothing.
exit 0
`.trim();

class Connection extends EventEmitter {
  /**
   * @param {object} spec
   *   {type:'ssh'|'teleport', target, label, configFile?, identityFile?, login?, node?, host?}
   */
  constructor(spec) {
    super();
    this.id = spec.id || 'conn' + (++connSeq);
    this.spec = spec;
    this.type = spec.type;
    this.target = spec.target;           // e.g. "ubuntu@node.example-cluster" or "ent"
    this.label = spec.label || spec.target;
    this.configFile = spec.configFile || null;
    /*
     * Set only for a plain ssh_config alias that resolves (via `ssh -G`) to
     * an explicit IdentityFile. Teleport hosts carry their own key on
     * configFile's IdentitiesOnly below; a direct host carries it on
     * directArgs(). This is the third place the same key can come from.
     */
    this.identityFile = spec.identityFile || null;
    this.state = 'idle';                 // idle|connecting|prompting|connected|error|closed
    this.error = null;
    this.log = [];
    this.controlPath = controlPathFor(this.id + '|' + this.target + '|' + (this.configFile || ''));
    this.master = null;
    this.sftp = null;
    this._sftpPromise = null;
    this.terminals = new Map();
    // One-off commands on the tsh transport that can prompt for MFA — see
    // execInteractive(). Keyed by execId, not terminal id: these are not
    // terminals, they never show in a pane's own terminal list.
    this.execs = new Map();
    // 'off' | 'untrusted' (-X) | 'trusted' (-Y)
    this.x11 = spec.x11 || 'off';
    this.agentForward = !!spec.agentForward;   // -A
    this.compression = !!spec.compression;     // -C
    // Forwards, jump host, Teleport's reason and invites — see sshoptions.js.
    this.sshOptions = spec.sshOptions || null;
    /**
     * 'mux'  — OpenSSH ControlMaster through `tsh proxy ssh` (default): one
     *          authentication serves every channel.
     * 'tsh'  — dial with `tsh ssh` directly. Needed for nodes with per-session
     *          MFA, where the ceremony has to happen on the session itself and
     *          is answered in the terminal; also the only route to a node in a
     *          leaf cluster, and the only one at all without an ssh client.
     */
    /*
     * A beam is reached by `tsh beams ssh` and nothing else — there is no host
     * to point ssh at, and no ControlMaster to share — so it is its own
     * transport rather than a variety of the tsh one.
     */
    this.beam = spec.beam || null;
    this.transport = this.beam ? 'beam' : (spec.transport === 'tsh' ? 'tsh' : 'mux');
    /**
     * Whether tsh is in use because the *user* asked for it, or because there
     * was no alternative. Only the first implies per-session MFA, and the
     * restrictions that exist to avoid spending an approval follow that, not
     * the transport alone.
     */
    this.tshByNecessity = this.transport === 'tsh' && !!spec.transportForced;
    /**
     * Which MFA method `tsh` should use. Left unset, tsh tries the platform
     * authenticator first; that needs a Touch ID prompt this app's spawned
     * process often cannot present, and the failed attempt consumes the
     * challenge so the browser fallback then fails too. Choosing up front
     * avoids the doomed first attempt.
     */
    this.mfaMode = spec.mfaMode || null;
    this.forwards = [];
    this._info = null;
    this.homeDir = null;
    this.remoteUser = null;
    this.remoteHostname = null;
    this.queue = new TransferQueue(() => this.getSftp());
    // A speed limit is a preference about the link, so a connection opened
    // later starts with whatever limit is already in force.
    if (spec.transferLimitBytes) this.queue.setLimit(spec.transferLimitBytes);
    this.queue.on('update', (v) => this.emit('transfers', v));
    // Passed on with the connection's own label attached: the record of a
    // download wants to say which server it came off, and the queue has never
    // heard of servers.
    this.queue.on('finished', (job) => this.emit('xferdone', { ...job, from: this.label }));
  }

  /**
   * argv for a beam: a terminal with no command, a command with one.
   *
   * The same shape as `tshArgs`, so every call site that already branches on
   * the transport needs one more branch and nothing else.
   */
  beamArgs(command = null) {
    const b = this.beam || {};
    return command
      ? beams.execArgs({ name: b.name, proxy: b.proxy }, command)
      : beams.sshArgs({ name: b.name, proxy: b.proxy });
  }

  /** Args common to every ssh invocation for this connection. */
  sshArgs(extra = []) {
    const a = [];
    if (this.configFile) {
      a.push('-F', this.configFile);
      /*
       * Offer only the Teleport certificate.
       *
       * Without this, ssh presents every key in the agent first and the
       * cert last. sshd's MaxAuthTries defaults to 6, so an agent holding a
       * handful of keys exhausts the server's patience before the one
       * credential that can work is ever tried — "too many authentication
       * failures", intermittently, depending on how full the agent is.
       * For a Teleport node the cert is the only thing that authenticates.
       */
      a.push('-o', 'IdentitiesOnly=yes');
    } else if (this.identityFile) {
      /*
       * The same "too many authentication failures" risk as above, for a
       * plain ssh_config alias rather than a Teleport-generated one: its own
       * Host block names an IdentityFile, but ssh still tries every key the
       * agent offers first unless told otherwise, and sshd's MaxAuthTries
       * (default 6) can run out before the one key that works is offered.
       * A command-line `-o` wins over the same setting resolved from a config
       * file, and OpenSSH keeps the first of several command-line `-o`s with
       * the same name — so this also overrides an alias that set
       * `IdentitiesOnly no` on purpose, same as directArgs() already does for
       * a host defined in the app. Narrow enough, against how often a full
       * agent breaks a key-based alias, to accept rather than plumb through
       * a check against this host's own extra-options.
       */
      a.push('-o', 'IdentitiesOnly=yes');
    }
    if (SUPPORTS_MUX) a.push('-o', 'ControlPath=' + this.controlPath);
    /*
     * A jump host asked for on a profile that otherwise resolves through
     * ssh_config. `-J` overrides whatever ProxyJump the alias already sets, so
     * it works on top of an alias as well as for a host defined in the app —
     * where it comes in through directArgs instead.
     */
    if (!this.spec.direct && this.spec.proxyJump) a.push('-J', this.spec.proxyJump);
    a.push(...this.directArgs());
    return a.concat(extra);
  }

  /**
   * What `rsync -e` needs to reach this host, or why it cannot.
   *
   * rsync runs itself on the far side over a shell of our choosing, so it
   * can ride the ControlMaster this connection is already holding: no second
   * authentication, no second Teleport session, and on a recorded cluster no
   * extra entry in the audit log beyond the exec itself.
   *
   * `ControlMaster=no` matters — this is a client on the existing socket,
   * not a candidate to become the master — and the arguments are handed
   * over as a list so the caller never has to guess at quoting.
   */
  rsyncTransport() {
    if (this.transport === 'tsh') {
      return {
        ok: false,
        reason: 'This node authenticates per session (MFA), so every rsync would raise its own prompt. '
          + 'Use the file browser\u2019s own synchronise for it.',
      };
    }
    if (this.transport === 'beam') {
      return { ok: false, reason: 'A beam is reached through tsh rather than ssh, so rsync cannot ride it.' };
    }
    if (!SUPPORTS_MUX) {
      return { ok: false, reason: 'Connection multiplexing is unavailable on this platform.' };
    }
    if (this.state !== 'connected') {
      return { ok: false, reason: 'Connect the session first: rsync rides the connection it already holds.' };
    }
    const args = ['ssh', ...this.sshArgs(['-o', 'ControlMaster=no'])];
    return { ok: true, target: this.target, argv: args, shell: args.join(' ') };
  }

  /**
   * Connection details for a host defined in the app rather than in
   * ssh_config. `ssh -G` never sees these, so they are passed explicitly.
   */
  directArgs() {
    const d = this.spec.direct;
    if (!d) return [];
    const a = [];
    if (d.port && Number(d.port) !== 22) a.push('-p', String(d.port));
    if (d.identityFile) a.push('-i', d.identityFile, '-o', 'IdentitiesOnly=yes');
    /*
     * No key at all, but still meant to be reached by password — set by a
     * saved SFTP profile with nothing in its "Private key" field. Without
     * this, every key a loaded ssh-agent offers gets tried first, and a
     * dedicated SFTP account's sshd commonly has a low `MaxAuthTries` —
     * reproduced live against a plain password-only SFTP server, agent
     * fully loaded: it disconnected with "Too many authentication
     * failures" before ssh ever reached the password prompt. `IdentitiesOnly`
     * with no identity configured skips every key, agent included, straight
     * to password/keyboard-interactive.
     */
    else if (d.identitiesOnly) a.push('-o', 'IdentitiesOnly=yes');
    if (d.proxyJump) a.push('-J', d.proxyJump);
    for (const opt of String(d.extraOptions || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      a.push('-o', opt.replace(/^-o\s*/, ''));
    }
    // A host typed in by hand has no known key yet; accept it on first use and
    // pin it thereafter, rather than failing or trusting blindly every time.
    a.push('-o', 'StrictHostKeyChecking=accept-new');
    return a;
  }

  /**
   * X11 forwarding flags. With multiplexing the forwarding is negotiated on
   * the master, so the flags belong there and sessions inherit it.
   */
  x11Args() {
    if (!this.x11 || this.x11 === 'off') return [];
    const args = this.x11 === 'trusted' ? ['-Y'] : ['-X'];
    args.push('-o', 'ForwardX11Timeout=' + (this.spec.x11Timeout || '596h'));
    return args;
  }

  /**
   * Options negotiated when the connection is established. Like X11, agent
   * forwarding is a property of the master, so it belongs here rather than on
   * individual sessions.
   */
  featureArgs() {
    const args = [];
    if (this.agentForward) args.push('-A');
    if (this.compression) args.push('-C');
    return args;
  }

  /*
   * Forwards in both directions, SOCKS and a jump host belong to the master:
   * set up once, there for every session on it. A session riding the master
   * must not repeat them, or each new tab asks for the same port again and
   * prints a forwarding failure. Without multiplexing every session is its
   * own connection, and carries them itself.
   */
  optionArgs({ session = false } = {}) {
    if (!this.sshOptions || (session && SUPPORTS_MUX)) return [];
    return sshoptions.opensshArgs(this.sshOptions);
  }

  /** Argv for `tsh ssh` against this connection's node. */
  tshArgs(extra = [], command = null) {
    const node = this.spec.node || {};
    const args = [];
    if (node.proxy) args.push('--proxy=' + node.proxy);
    if (this.mfaMode) args.push('--mfa-mode=' + this.mfaMode);
    args.push('ssh');
    if (node.cluster) args.push('--cluster=' + node.cluster);
    if (this.agentForward) args.push('-A');
    if (this.x11 === 'trusted') args.push('-Y');
    else if (this.x11 === 'untrusted') args.push('-X');
    if (this.sshOptions) args.push(...sshoptions.tshArgs(this.sshOptions));
    args.push(...extra);
    args.push(this.tshTarget());
    if (command) args.push(command);
    return args;
  }

  /**
   * The tsh home this connection belongs to.
   *
   * It matters for more than `tsh ssh`: a Teleport node reached over plain
   * OpenSSH goes through `tsh proxy ssh` from the generated ssh_config, so the
   * ssh processes need the variable just as much as the tsh ones do.
   */
  get tshHome() {
    const node = this.spec?.node || {};
    return node.home || teleport.homeForProxy(node.proxy) || null;
  }

  /** Environment for anything this connection spawns. */
  procEnv(extra) {
    // tsh's environment (TELEPORT_HOME) plus whatever ssh needs to be found —
    // on Windows the OpenSSH directory is usually not on a GUI process's PATH.
    // The cluster this connection is to, for any tsh variables set for it.
    const proxy = this.spec.node?.proxy || this.beam?.proxy || null;
    return { ...sshbin.sshEnv(), ...teleport.tshEnv(this.tshHome, proxy), ...(extra || {}) };
  }

  tshTarget() {
    const node = this.spec.node || {};
    const login = this.spec.login;
    /*
     * A hostname another node in the cluster also answers to is not something
     * tsh can resolve — it refuses rather than choosing — so such a node is
     * dialled by UUID. The cluster is already a flag in `tshArgs`, so only
     * the host part is in question here.
     */
    const host = (node.ambiguous && node.uuid)
      || node.hostname || node.name || this.target.replace(/^.*@/, '').replace(/\..*$/, '');
    return login ? `${login}@${host}` : host;
  }

  _pushLog(text, stream = 'out') {
    const entry = { t: Date.now(), text, stream };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.emit('log', entry);
  }

  _setState(s, err) {
    if (this.state === s && !err) return;
    this.state = s;
    if (err) this.error = err;
    this.emit('state', { state: s, error: this.error });
  }

  /** True if the control socket is live. */
  checkMaster() {
    if (!SUPPORTS_MUX) return Promise.resolve(this.state === 'connected');
    return new Promise((resolve) => {
      const args = this.sshArgs(['-O', 'check', this.target]);
      execFile(sshbin.findSsh(), args, { timeout: 8000, env: this.procEnv() }, (err) => resolve(!err));
    });
  }

  async connect() {
    if (this.state === 'connected') return this;
    /*
     * A connect already in flight, not one that finished long ago.
     *
     * This used to hold the resolved promise of the *first* successful
     * connect forever, because it was only ever cleared on failure. As long
     * as the connection stayed up that was harmless — the line above returns
     * early anyway. The moment the master died, though, it became the bug
     * that made reconnecting impossible: the state is `error`, so the early
     * return does not fire, and this handed back the stale promise instead.
     * Every reconnect then "succeeded" in a millisecond without starting
     * anything, and the terminal opened on a connection that was not there.
     */
    if (this._connecting) return this._connecting;

    this._connecting = (async () => {
      this._setState('connecting');
      this.error = null;
      /*
       * A fresh attempt, not another chapter of the last one. `this.log`
       * used to live for the whole Connection — every reconnect appended to
       * it rather than starting it over — so clicking Reconnect once after a
       * timeout replayed the failed attempt's own "$ ssh …" line back
       * through the "Connecting…" overlay (`conn:log`, read whole, fresh
       * every time `connectPane` opens one) right alongside the new one:
       * one real dial looked like two. The overlay is "what is happening
       * with this attempt", not a transcript across every attempt ever
       * made on this connection, so each one starts clean.
       */
      this.log = [];

      /*
       * A beam has no master to hold open either: `tsh beams ssh` is the
       * session, and `tsh beams exec` is every other channel. Marking it
       * connected immediately is what lets the file browser open beside a
       * terminal that has not been started yet.
       */
      if (this.transport === 'beam') {
        this._pushLog(`$ ${teleport.findTsh()} ${this.beamArgs().join(' ')}\n`, 'sys');
        this._setState('connected');
        return this;
      }

      // `tsh ssh` performs its own MFA ceremony per session, interactively.
      // There is nothing to establish up front: the terminal is the session.
      if (this.transport === 'tsh') {
        this._pushLog(`$ ${teleport.findTsh()} ${this.tshArgs().join(' ')}\n`, 'sys');
        this._pushLog('Per-session MFA: the prompt appears in the terminal.\n', 'sys');
        this._setState('connected');
        return this;
      }

      // Without multiplexing there is no master to hold open; just prove the
      // host is reachable and let each channel dial on its own.
      if (!SUPPORTS_MUX) {
        this._pushLog('$ ssh ' + this.target + ' (no multiplexing on this platform)\n', 'sys');
        await new Promise((resolve, reject) => {
          const args = this.sshArgs([
            '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-T', this.target, 'true',
          ]);
          execFile(sshbin.findSsh(), args, { timeout: 40000, env: this.procEnv() }, (err, stdout, stderr) => {
            if (err) {
              const msg = cleanupError(String(stderr || '')) || 'Could not connect';
              return reject(new Error(msg));
            }
            resolve();
          });
        });
        await this._afterConnect();
        return this;
      }

      // Reuse a still-live master from a previous run.
      if (fs.existsSync(this.controlPath)) {
        if (await this.checkMaster()) {
          this._pushLog('Reusing existing control connection.\n', 'sys');
          await this._afterConnect();
          return this;
        }
        /*
         * There is a socket and nothing is listening on it: the master was
         * killed, the network went, the laptop slept, the certificate
         * lapsed mid-session. OpenSSH will not start a new master on a path
         * that already exists — "ControlSocket ... already exists, disabling
         * multiplexing" — so the reconnect would fail for as long as the
         * file sat there, which is to say until the app was restarted.
         */
        this._pushLog('Removing the dead control socket before reconnecting.\n', 'sys');
        try { fs.unlinkSync(this.controlPath); } catch { /* no stale socket to remove */ }
      }

      /*
       * Reaching here can follow exactly the certificate lapse named above —
       * and a relogin elsewhere (the sidebar's own "tsh login", or the
       * renderer's own retry-after-relogin) may have already happened since
       * this connection's config was written. `tsh config` only reformats
       * whatever is on disk right now, so re-running it is cheap and safe,
       * and is the difference between this retry offering a fresh
       * certificate or the same expired one that got it here.
       *
       * Gated on the transport, not on `this.configFile` being set: a
       * connection whose cluster was not logged in yet when `create` ran
       * started with `configFile: null` rather than failing outright (see
       * there) precisely so it could get a real one here, once the
       * renderer's own relogin has had its turn — gating on the file
       * instead would have skipped this for exactly the connections that
       * need it most, the ones that never got one the first time.
       */
      if (this.type === 'teleport' && this.transport !== 'tsh') {
        const node = this.spec.node || {};
        this.configFile = await teleport
          .writeClusterSshConfig(path.join(RUNTIME_DIR, 'ssh-config'), { proxy: node.proxy, cluster: node.cluster, home: node.home })
          .catch(() => this.configFile);
      }

      const args = this.sshArgs([...BASE_OPTS, ...this.x11Args(), ...this.featureArgs(), ...this.optionArgs(), '-N', this.target]);
      this._pushLog(`$ ssh ${args.join(' ')}\n`, 'sys');

      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          clearTimeout(timeout);
          err ? reject(err) : resolve();
        };

        this.master = pty.spawn(sshbin.findSsh(), args, {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: os.homedir(),
          env: this.procEnv(),
        });

        this.master.onData((d) => {
          this._pushLog(d, 'out');
          if (PROMPT_RE.test(d)) this._setState('prompting');
        });

        // The master runs in the foreground, so its exit is meaningful:
        // before we are up it means authentication or dialling failed; after,
        // it means the connection dropped.
        this.master.onExit(({ exitCode, signal }) => {
          this.master = null;
          if (!settled) {
            const tail = this.log.filter((l) => l.stream === 'out').slice(-14).map((l) => l.text).join('');
            const err = new Error(cleanupError(tail) || `Connection failed (ssh exited with code ${exitCode}${signal ? ', signal ' + signal : ''})`);
            // Surfaced to the UI so it can offer the tsh transport instead of
            // leaving the user to guess why an MFA node will not connect.
            if (this.type === 'teleport' && looksLikeMfa(tail)) err.mfaLikely = true;
            /*
             * The same signal, for a plain ssh_config host — which has no
             * "switch to tsh" escape hatch to offer instead. What it does
             * have is authprobe.js: a verbose, non-authenticating replay of
             * the same attempt that reports which keys were offered, in
             * what order, and whether sshd's MaxAuthTries ran out before the
             * one that would have worked was ever tried. Worth the extra
             * ssh invocation only when the failure actually looks like that
             * kind of problem, rather than a host that is simply down.
             */
            if (this.type !== 'teleport' && looksLikeMfa(tail)) err.authFailedLikely = true;
            // Surfaced the same way, for any host type — so the UI can offer
            // forgetting the stale key instead of a retry that fails the
            // same way every time.
            if (looksLikeHostKeyChanged(tail)) err.hostKeyChanged = true;
            done(err);
          } else if (this.state !== 'closed') {
            clearInterval(this._health);
            this._setState('error', 'Connection closed');
            this._teardownChildren();
            // Whatever happens next has to be a fresh attempt.
            this._connecting = null;
          }
        });

        // The master never prints "ready"; poll the control socket instead.
        const poll = setInterval(async () => {
          if (settled) return;
          if (await this.checkMaster()) done(null);
        }, 600);

        const timeout = setTimeout(() => {
          /*
           * Giving up on our own wait must not leave the master running: it
           * is still out there trying (hung on a dead route, a server that
           * stopped answering) with nothing left tracking it, and a later
           * reconnect spawns a fresh master on the very same ControlPath —
           * two ssh processes now racing to be the multiplexer for it,
           * confirmed live with `ps` as two real, independent connections.
           * The success path below (`poll`) clears this timeout before it
           * ever fires, so a master that is about to come up is never cut
           * off by it.
           */
          if (this.master) { try { this.master.kill(); } catch { /* already on its way out */ } this.master = null; }
          done(new Error('Connection timed out. ' + (this.state === 'prompting'
            ? 'Authentication is still waiting for input.'
            : 'The host did not respond.')));
        }, this.spec.timeout || 120000);
      });

      await this._afterConnect();
      return this;
    })().then((r) => {
      // Settled: this is no longer an attempt in flight, and a later
      // reconnect must be allowed to start a new one.
      this._connecting = null;
      return r;
    }, async (e) => {
      this.lastErrorMfaLikely = !!e.mfaLikely;
      this.lastErrorHostKeyChanged = !!e.hostKeyChanged;
      this.lastErrorAuthFailedLikely = !!e.authFailedLikely;
      await this._explainVersion(e);
      this._setState('error', e.message);
      this._connecting = null;
      throw e;
    });

    return this._connecting;
  }

  /**
   * Add the version mismatch to a failed Teleport connection, if there is one.
   *
   * A tsh the cluster does not support fails with whatever broke first — "ssh:
   * no key found", a handshake error — and nothing in it says "versions". tsh
   * itself only ever mentions it during login. Unchanged when the versions
   * are fine or cannot be read: the original error is the better answer then.
   */
  async _explainVersion(err) {
    if (this.type !== 'teleport') return;
    const node = this.spec.node || {};
    const c = await teleport.compatFor({ proxy: node.proxy, home: this.tshHome }).catch(() => null);
    if (!c || (c.level !== 'warn' && c.level !== 'error')) return;
    err.versionMismatch = c;
    err.message = `${err.message}\n\n${c.message}`;
  }

  /** The daemonised master has no process to watch, so poll the socket. */
  _startHealthCheck() {
    if (!SUPPORTS_MUX) return;
    clearInterval(this._health);
    this._health = setInterval(async () => {
      if (this.state !== 'connected') return;
      /*
       * Asked twice before believing it. One `ssh -O check` that misses its
       * timeout — the first seconds after a wake from sleep, a stalled disk —
       * is not a dead master, and calling it one tears down the file channel
       * and the forwards while everything riding the master (a tmux control
       * stream, say) carries on regardless, leaving the app sure it is
       * disconnected from a host it is still talking to.
       */
      if (await this.checkMaster()) return;
      await new Promise((r) => setTimeout(r, 3000));
      if (this.state !== 'connected') return;
      if (!(await this.checkMaster())) {
        clearInterval(this._health);
        this._setState('error', 'Control connection lost');
        this._teardownChildren();
        this._connecting = null;
      }
    }, 15000);
    if (this._health.unref) this._health.unref();
  }

  async _afterConnect() {
    this._setState('connected');
    this._startHealthCheck();
    // Cheap identity probe over the mux; also warms the channel path.
    try {
      const out = await this.exec('echo "$HOME"; id -un; hostname');
      const [home, user, host] = out.trim().split('\n');
      this.homeDir = home || null;
      this.remoteUser = user || null;
      this.remoteHostname = host || null;
      this.emit('info', { homeDir: this.homeDir, user: this.remoteUser, hostname: this.remoteHostname });
    } catch { /* non-fatal */ }
  }

  /**
   * Run a command over the mux and capture stdout.
   *
   * `keepOutput` is for the commands whose *output* is the answer whatever
   * they exit with — a traceroute that ran out of hops, a ping that lost every
   * packet. Rejecting those throws away the thing that was asked for and
   * replaces it with "Command failed: ssh -o ControlPath=…", which is neither
   * the answer nor anything to show a person.
   */
  exec(command, opts = {}) {
    return this.execResult(command, opts).then(({ stdout, stderr, error }) => {
      if (error && opts.keepOutput && (stdout || stderr)) return stdout + stderr;
      if (error) throw error;
      return stdout;
    });
  }

  /**
   * The same run, reported rather than thrown.
   *
   * Some commands are a best-effort read where a partial answer is still
   * worth having: the server profile is a long chain of `uname`, `awk`, `df`
   * and `who`, any link of which can be missing on a minimal image. Handing
   * back what was printed *and* what went wrong lets the caller decide, which
   * a rejected promise cannot.
   */
  execResult(command, opts = {}) {
    return new Promise((resolve) => {
      const useTsh = this.transport === 'tsh' || this.transport === 'beam';
      const file = useTsh ? teleport.findTsh() : sshbin.findSsh();
      const args = this.transport === 'beam'
        ? this.beamArgs(command)
        : useTsh
          ? this.tshArgs([], command)
          : this.sshArgs(['-T', this.target, command]);
      execFile(file, args, { timeout: opts.timeout || 20000, maxBuffer: 8 * 1024 * 1024, env: this.procEnv() },
        (err, stdout, stderr) => resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? this._execError(err, stderr, useTsh ? 'tsh' : 'ssh') : null,
        }));
    });
  }

  /**
   * Why a remote command failed, in words that do not contain the command.
   *
   * Node builds `Command failed: <the entire argv>` and puts it in
   * `err.message`. For anything longer than a one-liner that is a wall of
   * flattened shell — the server profile's probe runs to several hundred
   * characters — and none of it says what went wrong. Worse, it is the
   * *fallback*, so it appears exactly when there is no stderr to explain
   * things and a person most needs a sentence.
   *
   * stderr is the real answer whenever the far side wrote one. Failing that,
   * the exit status is, and it is worth saying plainly that the command
   * failed without saying anything.
   */
  _execError(err, stderr, via = 'ssh') {
    const text = String(stderr || '').trim();
    /*
     * Short stderr is kept whole — several "command not found" lines are all
     * part of the same answer and dropping any of them hides what is missing.
     * A long one is reduced to the line that actually says what went wrong,
     * since past a few lines it is ssh being verbose rather than the host
     * being informative.
     */
    if (text) return new Error(text.length <= 400 ? text : (firstProblem(text) || text.slice(0, 400)));

    const where = this.label || this.target;
    // Order matters: a timeout is killed, so it carries a signal too.
    if (err.killed || err.code === 'ETIMEDOUT') {
      return new Error(`${where} did not answer within the time allowed.`);
    }
    if (err.code === 'ENOENT') {
      return new Error(`The ${via} client could not be found to run this.`);
    }
    if (err.signal) return new Error(`The command was killed on ${where} (${err.signal}).`);
    if (typeof err.code === 'number') {
      return new Error(`The command exited ${err.code} on ${where} and printed no error.`);
    }
    return new Error(`The command could not be run on ${where}.`);
  }

  /**
   * A one-off command on the `tsh` transport that can prompt — per-session
   * MFA, the same WebAuthn/OTP ceremony the interactive master already
   * surfaces via `PROMPT_RE`/`writeMaster`. `execResult()`/`exec()` run this
   * transport through a plain non-interactive `execFile` with no pty and no
   * stdin, so a prompt had nowhere to appear or be answered — confirmed by
   * `ps` showing two real, independent `tsh ssh`/`ssh` processes for what was
   * meant to be one connection (see the timed-out-master fix on `connect()`
   * for the companion bug). This is a parallel path, not a replacement for
   * `execResult()`: single-command and multi-exec use this only for the
   * `tsh` transport; every other caller (`serverInfo`, `hostTools`,
   * `shellHistory`, …) keeps the clean, parseable stdout `execResult()` gives.
   *
   * For a tsh-by-necessity host that never actually needs MFA, `PROMPT_RE`
   * just never matches and this behaves the same as a plain run — no need to
   * ask `isMfaHost()` first.
   */
  execInteractive(command, { timeout = 20000, execId } = {}) {
    const id = execId || 'exec' + (++execSeq);
    return new Promise((resolve) => {
      const args = this.tshArgs([], command);
      const term = pty.spawn(teleport.findTsh(), args, {
        name: 'xterm-256color', cols: 100, rows: 30, cwd: os.homedir(), env: this.procEnv(),
      });
      this.execs.set(id, term);
      let out = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { term.kill(); } catch { /* already on its way out */ }
      }, timeout);

      term.onData((d) => {
        out += d;
        if (out.length > 2_000_000) out = out.slice(-2_000_000);
        this.emit('exec-data', { execId: id, data: d });
        if (PROMPT_RE.test(d)) this.emit('exec-prompt', { execId: id, text: d });
      });
      term.onExit(({ exitCode }) => {
        clearTimeout(timer);
        this.execs.delete(id);
        resolve({
          execId: id,
          stdout: out,
          exitCode: timedOut ? null : exitCode,
          error: timedOut
            ? 'Timed out waiting for the command, or for an answer to a prompt.'
            : (exitCode === 0 ? null : (cleanupError(out) || `exited ${exitCode}`)),
        });
      });
    });
  }

  /** Answer a prompt `execInteractive` raised — an MFA code, a tap confirmed. */
  writeExec(execId, data) { this.execs.get(execId)?.write(data); }

  /** Stop a still-running interactive exec — a cancelled run, a closed dialog. */
  killExec(execId) {
    const term = this.execs.get(execId);
    if (!term) return;
    try { term.kill(); } catch { /* already on its way out */ }
    this.execs.delete(execId);
  }

  /** Lazily create (and keep) one SFTP channel for the file browser. */
  getSftp() {
    if (this.sftp && !this.sftp.closed) return Promise.resolve(this.sftp);
    if (this._sftpPromise) return this._sftpPromise;
    this._sftpPromise = (async () => {
      await this.connect();
      let client;
      if (this.transport === 'beam') {
        /*
         * `tsh beams exec` runs a command in the beam, so it can run the
         * beam's own sftp-server and speak SFTP down its stdio — the same
         * trick the MFA path uses, and what makes the file browser, the
         * transfer queue, synchronise and drag-and-drop work on a beam with
         * no special cases above this line.
         */
        client = new SftpClient(this.beamArgs(SFTP_SERVER_CHAIN), {
          command: teleport.findTsh(), timeout: 120000,
        });
      } else if (this.transport === 'tsh') {
        // Re-opening costs another approval, so a dropped channel waits for
        // the user rather than quietly prompting again.
        if (this._sftpClosedByPeer) {
          this._sftpClosedByPeer = false;
          throw new Error('The file channel closed. Press Refresh to reopen it (needs MFA approval).');
        }
        // `tsh ssh` has no subsystem flag, but it can run a command — so exec
        // the remote sftp-server and speak SFTP over that session. One MFA
        // ceremony, then a channel that stays open like any other.
        this.emit('log', { t: Date.now(), stream: 'sys', text: 'Opening a file channel (approve MFA once).\n' });
        client = new SftpClient(this.tshArgs([], SFTP_SERVER_CHAIN), { command: teleport.findTsh(), timeout: 120000 });
      } else {
        client = new SftpClient(this.sshArgs([this.target, '-s', 'sftp']));
      }
      client.on('close', () => {
        if (this.sftp === client) {
          this.sftp = null;
          this._sftpPromise = null;
          if (this.transport === 'tsh') this._sftpClosedByPeer = true;
        }
      });
      await client.connect();
      this.sftp = client;
      return client;
    })().catch((e) => { this._sftpPromise = null; throw e; });
    return this._sftpPromise;
  }

  /** Open an interactive shell (or run a command) over the mux. */
  async openTerminal({ id, cols = 100, rows = 30, command = null }) {
    await this.connect();
    const isBeam = this.transport === 'beam';
    const useTsh = this.transport === 'tsh' || isBeam;
    const file = useTsh ? teleport.findTsh() : sshbin.findSsh();
    /*
     * -N, "forwarding only": the session holds the forwards and runs nothing.
     * Only the interactive session gets it — exec, SFTP and the probes on the
     * same connection run commands, which -N would stop them doing.
     */
    const noShell = !command && !!this.sshOptions?.noShell;
    const args = isBeam
      ? this.beamArgs(command)
      : useTsh
      ? this.tshArgs(noShell ? ['-N'] : [], command)
      : (() => {
          const a = this.sshArgs([...this.x11Args(), ...this.featureArgs(), ...this.optionArgs({ session: true }), ...(noShell ? ['-N'] : []), '-tt', this.target]);
          if (command) a.push(command);
          return a;
        })();

    const term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: os.homedir(),
      env: this.procEnv({ TERM: 'xterm-256color' }),
    });

    const rec = { id, term, cols, rows, title: this.label, cwd: null, logStream: null, logPath: null };
    this.terminals.set(id, rec);

    term.onData((d) => {
      if (rec.logStream) rec.logStream.write(stripAnsi(d));
      this.emit('terminal-data', { id, data: d });
    });
    term.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      this.emit('terminal-exit', { id, exitCode });
    });
    return rec;
  }

  /**
   * A command on this connection, with a pty, that nothing else manages.
   *
   * `openTerminal` registers what it starts and broadcasts its output to
   * every window, which is right for a shell someone is looking at and wrong
   * for a protocol stream: tmux control mode is not output, it is a
   * conversation, and it belongs to whoever started it. Same authentication,
   * same multiplexed connection, same transports — the caller just owns the
   * result.
   */
  spawnCommandPty({ command, cols = 100, rows = 30 }) {
    if (!command) throw new Error('no command given');
    const isBeam = this.transport === 'beam';
    const useTsh = this.transport === 'tsh' || isBeam;
    const file = useTsh ? teleport.findTsh() : sshbin.findSsh();
    const args = isBeam
      ? this.beamArgs(command)
      : useTsh
        ? this.tshArgs([], command)
        : (() => {
            const a = this.sshArgs([...this.featureArgs(), ...this.optionArgs({ session: true }), '-tt', this.target]);
            a.push(command);
            return a;
          })();

    return pty.spawn(file, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: os.homedir(),
      env: this.procEnv({ TERM: 'xterm-256color' }),
    });
  }

  /**
   * A command on a beam over plain pipes, shaped like the pty `spawnCommandPty`
   * returns.
   *
   * `tsh beams exec` never gives the far side a terminal, and a local pty in
   * front of it only gets in the way: its line discipline echoes everything
   * written back into the stream, cuts a line off at the canonical limit
   * (about a kilobyte — one pasted paragraph sent as `send-keys`), and turns
   * a stray ^C or ^D in it into a signal. What runs here — tmux in control
   * mode — speaks lines on stdin and stdout and wants none of that.
   */
  spawnCommandPipe({ command }) {
    if (!command) throw new Error('no command given');
    const child = spawn(teleport.findTsh(), this.beamArgs(command), {
      cwd: os.homedir(),
      env: this.procEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const data = [];
    const exit = [];
    let exited = false;
    const emit = (d) => { for (const h of data) h(String(d)); };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    const done = (exitCode) => {
      if (exited) return;
      exited = true;
      for (const h of exit) h({ exitCode });
    };
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
    return {
      onData: (h) => { data.push(h); },
      onExit: (h) => { exit.push(h); },
      write: (s) => { if (!exited) child.stdin.write(s); },
      // There is no terminal to resize; tmux takes its size from the client.
      resize: () => {},
      kill: () => { try { child.kill(); } catch { /* already gone */ } },
    };
  }

  writeTerminal(id, data) {
    const t = this.terminals.get(id);
    if (t) t.term.write(data);
  }

  resizeTerminal(id, cols, rows) {
    const t = this.terminals.get(id);
    if (!t) return;
    try { t.term.resize(Math.max(2, cols), Math.max(2, rows)); t.cols = cols; t.rows = rows; } catch { /* the terminal may have exited */ }
  }

  closeTerminal(id) {
    const t = this.terminals.get(id);
    if (!t) return;
    this.stopLogging(id);
    try { t.term.kill(); } catch { /* the terminal may have exited */ }
    this.terminals.delete(id);
  }

  /**
   * Tee a terminal's output to a file. Escape sequences are stripped so the
   * log is readable afterwards rather than a screenful of cursor movement.
   */
  startLogging(id, filePath) {
    const t = this.terminals.get(id);
    if (!t) throw new Error('No such terminal');
    this.stopLogging(id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    t.logStream = fs.createWriteStream(filePath, { flags: 'a' });
    t.logPath = filePath;
    t.logStream.write(`\n==== ServerLife session log - ${this.label} - ${new Date().toISOString()} ====\n`);
    this.emit('logging', { id, path: filePath, active: true });
    return filePath;
  }

  stopLogging(id) {
    const t = this.terminals.get(id);
    if (!t || !t.logStream) return null;
    const p = t.logPath;
    try { t.logStream.end(`\n==== ended ${new Date().toISOString()} ====\n`); } catch { /* the log may already be closed */ }
    t.logStream = null;
    t.logPath = null;
    this.emit('logging', { id, path: p, active: false });
    return p;
  }

  loggingState(id) {
    const t = this.terminals.get(id);
    return t ? { active: !!t.logStream, path: t.logPath } : { active: false, path: null };
  }

  /**
   * Best-effort working directory of a terminal's remote shell, used for the
   * "follow terminal folder" behaviour. Resolved over the mux by inspecting
   * the sshd child process on the remote side.
   */
  async terminalCwd(id) {
    const t = this.terminals.get(id);
    if (!t) return null;
    /*
     * Only over the mux, where an exec is a channel on a connection that is
     * already open. On a per-session-MFA host every exec is another approval
     * prompt, and in a beam it is another `tsh beams exec` process and another
     * session in the audit log — neither is worth a convenience that polls.
     */
    if (this.transport !== 'mux') return null;
    try {
      const out = await this.exec(CWD_PROBE, { timeout: 8000 });
      const cwd = out.trim().split('\n').pop();
      return cwd && cwd.startsWith('/') ? cwd : null;
    } catch { return null; }
  }

  /**
   * Copy with `tsh scp`, for nodes where an SFTP channel cannot be held open.
   * Each call performs its own MFA ceremony, so it is spawned in a PTY and its
   * output is surfaced for the prompt.
   */
  tshScp({ direction, localPaths, remotePath, recursive = true, onOutput }) {
    const node = this.spec.node || {};
    const args = [];
    if (node.proxy) args.push('--proxy=' + node.proxy);
    if (this.mfaMode) args.push('--mfa-mode=' + this.mfaMode);
    args.push('scp');
    if (node.cluster) args.push('--cluster=' + node.cluster);
    if (recursive) args.push('-r');

    if (direction === 'upload') {
      args.push(...localPaths, `${this.tshTarget()}:${remotePath}`);
    } else {
      for (const p of remotePath) args.push(`${this.tshTarget()}:${p}`);
      args.push(localPaths);
    }

    return new Promise((resolve, reject) => {
      const term = pty.spawn(teleport.findTsh(), args, {
        name: 'xterm-256color', cols: 100, rows: 24,
        env: this.procEnv(),
      });
      let out = '';
      term.onData((d) => {
        out += d;
        if (out.length > 20000) out = out.slice(-20000);
        onOutput?.(d);
        this.emit('log', { t: Date.now(), stream: 'out', text: d });
      });
      term.onExit(({ exitCode }) => {
        if (exitCode === 0) return resolve(out);
        // eslint-disable-next-line no-control-regex
        const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+/g, ' ').trim();
        reject(new Error(cleanupError(clean) || clean.slice(-200) || `tsh scp failed (${exitCode})`));
      });
      this._scpTerm = term;
    });
  }

  /* ---------------- port forwarding ---------------- */

  /**
   * Forwarding rides the existing ControlMaster via `ssh -O forward`, so a
   * tunnel costs no extra authentication and can be added or cancelled while
   * sessions stay up.
   *
   * kind: 'L' local, 'R' remote, 'D' dynamic SOCKS.
   */
  static forwardSpec({ kind, bindAddr, bindPort, destHost, destPort }) {
    const bind = bindAddr ? `${bindAddr}:` : '';
    if (kind === 'D') return `${bind}${bindPort}`;
    return `${bind}${bindPort}:${destHost}:${destPort}`;
  }

  _controlCommand(op, kind, spec) {
    return new Promise((resolve, reject) => {
      const args = this.sshArgs(['-O', op, `-${kind}`, spec, this.target]);
      execFile(sshbin.findSsh(), args, { timeout: 15000, env: this.procEnv() }, (err, stdout, stderr) => {
        const out = ((stderr || '') + (stdout || '')).trim();
        if (err) return reject(new Error(cleanupError(out) || out || `ssh -O ${op} failed`));
        resolve(out);
      });
    });
  }

  /**
   * Which diagnostic tools this host actually has.
   *
   * One exec rather than one per tool: on a per-session-MFA node every exec is
   * a prompt, and on any Teleport node it is an audit event. Cached for the
   * life of the connection, because a box does not grow a `dig` while you are
   * looking at it — `refresh` is there for after someone installs one.
   */
  async hostTools({ refresh = false } = {}) {
    if (this._tools && !refresh) return this._tools;

    const wanted = [
      'ping', 'ping6', 'traceroute', 'tracepath', 'mtr', 'dig', 'host', 'nslookup',
      'getent', 'nc', 'ncat', 'socat', 'openssl', 'curl', 'wget', 'python3',
      'ip', 'ss', 'netstat', 'timeout', 'whois',
      // Not for any check — for opening a telnet session *from* the host, to
      // the switch that only it can reach.
      'telnet',
    ];
    /*
     * LC_ALL=C so anything parsed later is in English, and `command -v` rather
     * than `which`, which is not everywhere and lies on some shells.
     */
    const script = [
      'LC_ALL=C',
      `for t in ${wanted.join(' ')}; do command -v "$t" >/dev/null 2>&1 && printf 'tool=%s\\n' "$t"; done`,
      // The bash builtin that makes a port check need no tools at all.
      `printf 'devtcp=%s\\n' "$(bash -c 'exec 3<>/dev/tcp/127.0.0.1/22' 2>/dev/null && echo yes || echo no)"`,
      // nc comes in three incompatible flavours; the first line of its help
      // says which, and the flags depend on the answer.
      `printf 'ncflavour=%s\\n' "$(nc -h 2>&1 | head -1 | tr -d '\\n')"`,
      // So an install hint can name the right command.
      `for p in apt dnf yum zypper apk pacman brew; do command -v "$p" >/dev/null 2>&1 && { printf 'pkg=%s\\n' "$p"; break; }; done`,
      `printf 'os=%s\\n' "$( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME" )"`,
    ].join('; ');

    const out = await this.exec(script);
    const tools = {};
    let devtcp = false;
    let ncFlavour = '';
    let pkg = '';
    let os = '';
    for (const line of String(out || '').split('\n')) {
      const [k, ...rest] = line.trim().split('=');
      const v = rest.join('=');
      if (k === 'tool') tools[v] = true;
      else if (k === 'devtcp') devtcp = v === 'yes';
      else if (k === 'ncflavour') ncFlavour = v;
      else if (k === 'pkg') pkg = v;
      else if (k === 'os') os = v;
    }
    this._tools = {
      tools,
      devtcp,
      ncFlavour,
      // busybox reduces every applet's flags and changes its output, so it is
      // worth knowing before anything is parsed.
      busybox: /busybox/i.test(ncFlavour),
      pkg,
      os,
      // What the app can do without anything installed on the far side.
      // Two different questions: a tsh session takes a port forward (its own
      // `tsh ssh -D` process holds it, so curl through a proxy works) but has
      // no ControlMaster to run `ssh -W` over, so the port check there falls
      // back to the host's own tools. Only a mux session can do both.
      canForward: this.transport !== 'beam',
      canProbeDirect: this.transport === 'mux',
      transport: this.transport,
      at: Date.now(),
    };
    return this._tools;
  }

  /** Addresses, routes and resolvers, as the host sees them. */
  async hostFacts() {
    const script = [
      'LC_ALL=C',
      'echo "--hostname"; hostname 2>/dev/null',
      'echo "--addresses"; { ip -brief addr 2>/dev/null || ifconfig 2>/dev/null; }',
      'echo "--routes"; { ip route 2>/dev/null || netstat -rn 2>/dev/null; }',
      'echo "--resolvers"; { cat /etc/resolv.conf 2>/dev/null; }',
    ].join('; ');
    const text = await this.exec(script);
    const out = { hostname: '', addresses: '', routes: '', resolvers: '' };
    let key = null;
    for (const line of String(text || '').split('\n')) {
      const m = line.match(/^--(hostname|addresses|routes|resolvers)$/);
      if (m) { key = m[1]; continue; }
      if (key) out[key] += (out[key] ? '\n' : '') + line;
    }
    for (const k of Object.keys(out)) out[k] = out[k].trim();
    return out;
  }

  /**
   * Whether this box already runs Teleport — asked only of a direct
   * connection (this is not a `tsh`/`beam` transport), where the answer is a
   * genuine "did you know," not a tautology. One cheap round trip, cached
   * for the life of the connection: a process does not appear or vanish
   * between two clicks, and a host that already has it is a candidate to
   * bring under Teleport properly rather than keep reaching by raw SSH.
   */
  async teleportPresence({ refresh = false } = {}) {
    if (this._teleportPresence && !refresh) return this._teleportPresence;
    const script = 'command -v teleport >/dev/null 2>&1 && echo bin=yes || echo bin=no; '
      + 'pgrep -x teleport >/dev/null 2>&1 && echo running=yes || echo running=no';
    const { stdout } = await this.execResult(script, { timeout: 10000 });
    const text = String(stdout || '');
    this._teleportPresence = {
      installed: /bin=yes/.test(text),
      running: /running=yes/.test(text),
      checkedAt: Date.now(),
    };
    return this._teleportPresence;
  }

  /**
   * Can this host open a TCP connection to `host:port`?
   *
   * Preferably with nothing installed on it: `ssh -W` asks the server to open
   * the connection *for* us over the session already authenticated, so the
   * answer comes from the host's own network stack and needs no tools at all.
   *
   * **The verdict is ssh's exit status, not what came down the channel.** With
   * stdin at EOF, `ssh -W` to an open port connects, sees the empty input and
   * exits **0**; a refusal exits 255 with `open failed: connect failed:
   * Connection refused` on stderr; a dropped packet never connects at all, so
   * nothing exits and the timeout is itself the answer — filtered. Reading a
   * banner instead only worked for services that speak first: a TLS port says
   * nothing until the client does, so 443 was open, silent, and reported
   * closed.
   *
   * Three outcomes, not two, because they mean different things: refused is a
   * host with nothing listening, filtered is a firewall, and only the first is
   * something you can fix on the far end.
   *
   * Where `-W` is not available — a session dialled with `tsh ssh`, or a beam —
   * it falls back to what the host has: the bash /dev/tcp builtin, then nc.
   */
  async probeTcp(host, port, { timeout = 4000 } = {}) {
    const started = Date.now();

    if (this.transport === 'mux') {
      const args = this.sshArgs(['-W', `${host}:${port}`, this.target]);
      return new Promise((resolve) => {
        const p = spawn(sshbin.findSsh(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.procEnv() });
        let banner = '';
        let err = '';
        let settled = false;
        const done = (state, note) => {
          if (settled) return;
          settled = true;
          try { p.kill(); } catch { /* the process may already have exited */ }
          const open = state === 'open';
          resolve({
            port, open, state, ms: Date.now() - started, how: 'ssh -W',
            // Free evidence of *what* answered, when it happens to speak first.
            banner: banner.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 120) || null,
            // A note is given only where it says more than ssh's own wording.
            error: open ? null : (note || firstProblem(err) || null),
          });
        };
        p.stdout.on('data', (d) => { banner += d.toString(); });
        p.stderr.on('data', (d) => { err += d.toString(); });
        p.on('error', (e) => done('error', e.message));
        p.on('exit', (code) => {
          if (code === 0) return done('open');
          /*
           * A name that does not resolve *on the host* is a different answer
           * from a port that is shut, and the one people most need to see:
           * the address is wrong, or that host's resolver cannot see it. Only
           * a direct connection says so — through the ControlMaster the two
           * arrive as the same "refused by peer", so that case is reported as
           * closed with the ambiguity spelled out rather than resolved by a
           * guess.
           */
          if (/not known|Name or service|could not resolve|no address/i.test(err)) return done('dns');
          if (/refused by peer|Session open refused/i.test(err)) {
            return done('closed', 'the host refused it — nothing listening, or the name '
              + 'does not resolve from there');
          }
          done('closed');
        });
        /*
         * Nothing either way: the connection is still being attempted, which
         * is what a dropped SYN looks like from here.
         */
        setTimeout(() => done('filtered', 'no answer before the timeout'), Math.max(1500, timeout));
      });
    }

    const [r] = await this.probePortsWithTools(host, [port], { timeout });
    return r;
  }

  /**
   * The same question for several ports, asked in **one** command on the host.
   *
   * Used where `ssh -W` is not available. One exec rather than one per port:
   * on a per-session-MFA node every exec is a prompt, and on any Teleport node
   * it is an audit event, so a five-port check should not be five of either.
   */
  async probePortsWithTools(host, ports, { timeout = 4000 } = {}) {
    const started = Date.now();
    const caps = await this.hostTools().catch(() => null);
    const secs = Math.max(1, Math.round((Number(timeout) || 4000) / 1000));
    // Already validated by the caller; narrowed again because it is going into
    // a shell command on someone else's machine.
    const h = String(host).replace(/[^A-Za-z0-9._:-]/g, '');
    const list = ports.map((p) => Number(p)).filter((p) => p > 0 && p < 65536);

    let how = null;
    let probe = null;
    if (caps?.devtcp) {
      how = 'bash /dev/tcp';
      // `timeout` turns a filtered port from a two-minute kernel wait into a
      // known exit status; without it the builtin is still used, just slower.
      const to = caps.tools?.timeout ? `timeout ${secs} ` : '';
      probe = (p) => `${to}bash -c 'exec 3<>/dev/tcp/${h}/${p}'`;
    } else if (caps?.tools?.nc || caps?.tools?.ncat) {
      const bin = caps.tools.nc ? 'nc' : 'ncat';
      how = bin;
      // -z is a scan with no data; busybox has no -z, so it gets a redirect.
      probe = (p) => (caps.busybox
        ? `${bin} -w ${secs} ${h} ${p} </dev/null >/dev/null`
        : `${bin} -z -w ${secs} ${h} ${p}`);
    } else if (caps?.tools?.python3) {
      how = 'python3';
      probe = (p) => `python3 -c 'import socket,sys;s=socket.socket();s.settimeout(${secs});`
        + `sys.exit(s.connect_ex(("${h}",${p})))'`;
    } else {
      return list.map((p) => ({
        port: p, open: null, state: 'unknown', ms: 0, how: null,
        error: 'This session cannot forward, and the host has no nc, python3 or bash /dev/tcp',
      }));
    }

    /*
     * rc and the message, per port, on one line each. 124 is `timeout`'s own
     * status for "it did not finish", which is exactly the filtered case.
     */
    const script = ['LC_ALL=C', ...list.map((p) =>
      `e=$( { ${probe(p)}; } 2>&1 ); printf 'p=%s rc=%s %s\\n' ${p} "$?" "$(printf '%s' "$e" | tr '\\n' ' ')"`,
    )].join('; ');

    let out = '';
    try {
      out = await this.exec(script);
    } catch (e) {
      return list.map((p) => ({ port: p, open: null, state: 'unknown', ms: Date.now() - started, how, error: e.message }));
    }

    const ms = Date.now() - started;
    const byPort = new Map();
    for (const line of String(out || '').split('\n')) {
      const m = line.match(/^p=(\d+) rc=(\d+)\s*(.*)$/);
      if (!m) continue;
      const rc = Number(m[2]);
      const note = m[3].trim();
      let state = 'closed';
      if (rc === 0) state = 'open';
      else if (rc === 124 || rc === 137 || /timed out|timeout/i.test(note)) state = 'filtered';
      else if (/not known|Name or service|could not resolve|no address|nodename/i.test(note)) state = 'dns';
      byPort.set(Number(m[1]), {
        port: Number(m[1]), open: state === 'open', state, ms, how, banner: null,
        error: state === 'open' ? null : (note || (state === 'filtered' ? 'no answer before the timeout' : 'connection refused')),
      });
    }
    return list.map((p) => byPort.get(p)
      || { port: p, open: null, state: 'unknown', ms, how, error: 'the host gave no answer for this port' });
  }

  /**
   * The same question for several ports, whichever route this session has.
   *
   * `ssh -W` is one process per port, but they ride the ControlMaster that is
   * already up, so they cost nothing to authenticate and are run a few at a
   * time — a five-port check should not be five sequential waits. The
   * tool-based route batches into a single exec instead.
   */
  async probePorts(host, ports, { timeout = 4000, concurrency = 4 } = {}) {
    const list = ports.map((p) => Number(p)).filter((p) => p > 0 && p < 65536);
    if (this.transport !== 'mux') return this.probePortsWithTools(host, list, { timeout });

    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        out[i] = await this.probeTcp(host, list[i], { timeout });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return out;
  }

  /**
   * Ping, from the host.
   *
   * ICMP is the first thing anyone reaches for and `ping` is on almost every
   * box, so it is worth running there rather than explaining why it cannot be.
   * It is not free of caveats: a container without `cap_net_raw` gets
   * "Operation not permitted", and plenty of networks drop ICMP while passing
   * TCP perfectly well — so the output is shown as the host printed it, which
   * is the honest form of the answer.
   */
  async hostPing(host, { count = 5 } = {}) {
    const caps = await this.hostTools().catch(() => null);
    const h = String(host).replace(/[^A-Za-z0-9._:-]/g, '');
    const n = Math.min(Math.max(Number(count) || 5, 1), 20);
    if (caps && !caps.tools?.ping) {
      return { ok: false, text: '', missing: 'ping', command: `ping -c ${n} ${h}` };
    }
    /*
     * `-W` is seconds on Linux's iputils and busybox but *milliseconds* on
     * macOS, and busybox has no `-W` at all; the total is bounded by `timeout`
     * where it exists, which is the same guarantee without the guesswork.
     */
    const cmd = `ping -c ${n} -i 0.3 ${h} 2>&1`;
    const command = caps?.tools?.timeout ? `timeout ${n * 2 + 8} ${cmd}` : cmd;
    /*
     * A ping that lost every packet exits non-zero, and that summary is the
     * answer — so the output is kept whatever the status.
     */
    const text = await this.exec(`LC_ALL=C; ${command}`, { keepOutput: true, timeout: (n * 2 + 20) * 1000 })
      .catch((e) => String(e.message || e));
    return {
      ok: /bytes from|packets transmitted/i.test(text),
      text: String(text || '').trim(),
      command: `ping -c ${n} ${h}`,
    };
  }

  /**
   * The path from the host, with whatever traces routes there.
   *
   * `traceroute` is the name everyone knows and the one least often installed:
   * it is absent from most minimal images, where `tracepath` (iputils, no root
   * needed) or `mtr --report` is present instead. All three answer the same
   * question, so the first one that exists is used and the output says which.
   */
  async hostTrace(host, { maxHops = 20 } = {}) {
    const caps = await this.hostTools().catch(() => null);
    const h = String(host).replace(/[^A-Za-z0-9._:-]/g, '');
    const hops = Math.min(Math.max(Number(maxHops) || 20, 1), 40);

    const chain = [
      // One query per hop, two-second wait: a trace that takes a minute gets
      // abandoned before it finishes, which is worse than a thinner trace.
      { tool: 'traceroute', cmd: `traceroute -m ${hops} -w 2 -q 1 ${h}` },
      { tool: 'tracepath', cmd: `tracepath -m ${hops} ${h}` },
      { tool: 'mtr', cmd: `mtr --report --report-cycles 1 -m ${hops} ${h}` },
    ];
    const pick = chain.find((c) => caps?.tools?.[c.tool]);
    if (!pick) {
      return { ok: false, text: '', missing: 'traceroute', tool: null, command: chain[0].cmd };
    }

    const budget = hops * 3 + 10;
    const command = caps?.tools?.timeout ? `timeout ${budget} ${pick.cmd}` : pick.cmd;
    // `tracepath` exits non-zero on "Too many hops" and traceroute on a hop
    // that never answers; both have already printed the path by then.
    const text = await this.exec(`LC_ALL=C; ${command} 2>&1`, { keepOutput: true, timeout: (budget + 15) * 1000 })
      .catch((e) => String(e.message || e));
    return {
      ok: !!String(text || '').trim(),
      text: String(text || '').trim(),
      tool: pick.tool,
      command: pick.cmd,
    };
  }

  /**
   * What is listening, and what is connected, on the host — joining what
   * `hostFacts` knows about addresses with the one question neither that
   * nor the port check answers: what is actually bound to a port, and by
   * which process. `ss` first, `netstat` as the fallback; see sockets.js.
   */
  async hostSockets() {
    const caps = await this.hostTools().catch(() => null);
    const pick = sockets.remoteSocketsScript(caps);
    if (!pick) return { ok: false, rows: [], text: '', missing: 'ss', command: 'ss -tulpn' };
    const text = await this.exec(`LC_ALL=C; ${pick.cmd}`, { keepOutput: true, timeout: 15000 })
      .catch((e) => String(e.message || e));
    return {
      ok: true,
      rows: sockets.parseRemote(pick.tool, text),
      text: String(text || '').trim(),
      tool: pick.tool,
      command: pick.tool === 'ss' ? 'ss -tulpn' : 'netstat -tulpn',
    };
  }

  /**
   * Run something with a SOCKS proxy through this host.
   *
   * The point is DNS *and* the connection happening on the far side, with
   * nothing installed there — curl on this machine, pointed through the
   * session, with `--socks5-hostname` so the name is resolved by the host.
   * The forward is torn down afterwards whatever happened.
   */
  async withSocks(fn) {
    if (this.transport === 'beam') {
      throw new Error('A beam does not take port forwards, so there is no proxy to run through.');
    }
    const port = await freeLocalPort();
    const rec = await this.addForward({ kind: 'D', bindPort: port, bindAddr: '127.0.0.1' });
    try {
      return await fn({ proxy: `127.0.0.1:${port}` });
    } finally {
      try { await this.removeForward(rec.id); } catch { /* it is going away anyway */ }
    }
  }

  async addForward(fwd) {
    await this.connect();
    const spec = Connection.forwardSpec(fwd);
    if (this.forwards.some((f) => f.kind === fwd.kind && f.spec === spec)) {
      throw new Error('That forward already exists');
    }

    /*
     * A beam publishes services rather than forwarding ports: `tsh beams
     * publish` puts an HTTP or TCP service behind the cluster's own address,
     * which is the beams-shaped answer to the same question. Saying so beats
     * spawning something that cannot work.
     */
    if (this.transport === 'beam') {
      throw new Error('A beam does not take port forwards — publish the service instead '
        + '(right-click the beam → Publish a service…).');
    }

    let proc = null;
    if (this.transport === 'tsh') {
      // tsh ssh carries -L/-R/-D itself; hold the tunnel with its own process.
      proc = await new Promise((resolve, reject) => {
        const flag = `-${fwd.kind}`;
        const args = this.tshArgs([flag, spec, '-N']);
        const p = spawn(teleport.findTsh(), args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.procEnv() });
        let err = '';
        p.stderr.on('data', (d) => { err += d.toString(); });
        p.on('error', reject);
        const settle = setTimeout(() => resolve(p), 1500);
        p.on('exit', (code) => {
          clearTimeout(settle);
          reject(new Error(cleanupError(err) || `tunnel failed (exit ${code})`));
        });
      });
    } else if (SUPPORTS_MUX) {
      await this._controlCommand('forward', fwd.kind, spec);
    } else {
      // No master to attach to: hold the tunnel open with its own ssh process.
      proc = await new Promise((resolve, reject) => {
        const args = this.sshArgs(['-N', `-${fwd.kind}`, spec, this.target]);
        const p = spawn(sshbin.findSsh(), args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.procEnv() });
        let err = '';
        p.stderr.on('data', (d) => { err += d.toString(); });
        p.on('error', reject);
        // ssh exits immediately if the local port is taken or the spec is bad.
        const settle = setTimeout(() => resolve(p), 1200);
        p.on('exit', (code) => {
          clearTimeout(settle);
          reject(new Error(cleanupError(err) || `tunnel failed (exit ${code})`));
        });
      });
    }

    const rec = {
      id: 'fwd' + (++fwdSeq),
      kind: fwd.kind,
      spec,
      bindAddr: fwd.bindAddr || (fwd.kind === 'R' ? '' : 'localhost'),
      bindPort: fwd.bindPort,
      destHost: fwd.destHost || null,
      destPort: fwd.destPort || null,
      label: fwd.label || '',
      createdAt: Date.now(),
      _proc: proc,
    };
    this.forwards.push(rec);
    this.emit('forwards', this.listForwards());
    return rec;
  }

  async removeForward(id) {
    const i = this.forwards.findIndex((f) => f.id === id);
    if (i < 0) return false;
    const f = this.forwards[i];
    if (f._proc) {
      try { f._proc.kill(); } catch { /* the process may already have exited */ }
    } else {
      // `-O cancel` fails if the master already dropped it; either way the
      // entry should leave our list.
      try { await this._controlCommand('cancel', f.kind, f.spec); } catch { /* the master already dropped it */ }
    }
    this.forwards.splice(i, 1);
    this.emit('forwards', this.listForwards());
    return true;
  }

  listForwards() {
    // Strip the child-process handle; this crosses the IPC boundary.
    return this.forwards.map(({ _proc, ...f }) => ({ ...f, connId: this.id, connLabel: this.label }));
  }

  /* ---------------- remote host facts ---------------- */

  /**
   * Free and total space on the filesystem holding `dir`, for the file
   * browser's footer. One `df -Pk` — POSIX output, so the same columns on
   * Linux, macOS and the BSDs — and `null` rather than an error wherever it
   * cannot be had cheaply: a per-session-MFA host (an approval nobody asked
   * for, same reasoning as `serverInfo`), a restricted shell, a `df` that
   * printed something unparseable. A footer that says nothing is fine; one
   * that throws is not.
   */
  async diskSpace(dir) {
    if (this.transport === 'tsh' && !this.tshByNecessity) return null;
    if (this.state !== 'connected') return null;
    const q = `'${String(dir || '.').replace(/'/g, "'\\''")}'`;
    const { stdout } = await this.execResult(`df -Pk -- ${q} 2>/dev/null`, { timeout: 8000 });
    const line = String(stdout || '').trim().split('\n')[1];
    const cols = line ? line.trim().split(/\s+/) : [];
    const total = Number(cols[1]) * 1024;
    const free = Number(cols[3]) * 1024;
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
    return { total, free };
  }

  /**
   * One round trip that describes the box: distribution, kernel, arch, CPU,
   * memory, disk and which package manager it speaks. Cached until asked to
   * refresh, since none of it changes minute to minute.
   */
  async serverInfo({ refresh = false } = {}) {
    if (this._info && !refresh) return this._info;
    // Refused only where the transport was chosen *for* per-session MFA: there
    // the profile would cost an approval nobody asked for. On tsh by necessity
    // — a leaf cluster, or no ssh client — an exec is as cheap as any other, so
    // the button does what it says.
    if (this.transport === 'tsh' && !this.tshByNecessity) {
      throw new Error(
        'Server profile needs a command session, which on a per-session-MFA host '
        + 'means another approval. Run it from the terminal instead.');
    }
    await this.connect();
    const { stdout: raw, error } = await this.execResult(INFO_SCRIPT, { timeout: 25000 });

    const info = {};
    for (const line of raw.split('\n')) {
      const i = line.indexOf('=');
      if (i < 1) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (v) info[k] = v;
    }
    /*
     * A profile is a read, so it is judged on what came back rather than on
     * an exit status.
     *
     * Nothing at all is a real failure and says why. Some of it is worth
     * keeping and showing: a host that answered the first ten questions and
     * fell over on `who` has still told you what it is, and replacing that
     * with an error helps nobody. The reason travels with the partial answer
     * so the panel can say the picture is incomplete rather than quietly
     * implying the missing fields do not exist.
     */
    if (!Object.keys(info).length) {
      throw error || new Error(
        `${this.label || this.target} ran the profile probe but printed nothing. `
        + 'A restricted shell or a forced command will do that.');
    }
    if (error) info.partial = error.message;

    if (info.mem_total_kb) info.memTotal = Number(info.mem_total_kb) * 1024;
    if (info.mem_avail_kb) info.memAvail = Number(info.mem_avail_kb) * 1024;
    info.osLabel = info.os_pretty || [info.os_name, info.os_version].filter(Boolean).join(' ') || info.kernel_sys || 'Unknown';
    info.fetchedAt = Date.now();
    this._info = info;
    this.emit('serverinfo', info);
    return info;
  }

  /**
   * What this account has typed on this host before.
   *
   * Read from the history *files*, not from `history`. That is a shell
   * builtin backed by the interactive shell's own memory, so it prints
   * nothing at all down a non-interactive exec — running it and scraping the
   * result would mean driving the terminal and parsing whatever came back,
   * which is a worse answer than reading the file the shell is writing.
   *
   * Every common file is read in one command rather than one apiece: on a
   * per-session-MFA node each exec is an approval, and on any Teleport node
   * an audit entry.
   */
  async shellHistory({ limit = 1000, refresh = false } = {}) {
    if (this._history && !refresh) return this._history;

    /*
     * `$HISTFILE` is not set in a non-interactive shell, so the usual paths
     * are named instead. The tail bounds a history that has been growing for
     * years; nobody scrolls back past a few thousand lines, and the whole
     * file would come back over the connection.
     */
    const files = [
      '$HOME/.bash_history', '$HOME/.zsh_history', '$HOME/.histfile',
      '$HOME/.local/share/fish/fish_history', '$HOME/.ash_history',
      '$HOME/.sh_history',
    ];
    const script = [
      'LC_ALL=C',
      `for f in ${files.map((f) => `"${f}"`).join(' ')}; do`,
      '  [ -r "$f" ] || continue',
      "  printf '@@SLHIST@@%s\\n' \"$f\"",
      '  tail -n 4000 "$f" 2>/dev/null',
      'done',
      // A report, not a test — see INFO_SCRIPT.
      'exit 0',
    ].join('\n');

    const { stdout, error } = await this.execResult(script, { timeout: 25000 });
    const entries = parseHistory(stdout);
    if (!entries.length && error) throw error;

    /*
     * Newest first, and each command only once. A history is mostly
     * repetition — the same `systemctl status` fifty times — and a list that
     * shows it fifty times is a list nobody can search. The most recent use
     * is the one kept, so the ordering still means something.
     */
    const seen = new Set();
    const out = [];
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = entries[i];
      if (seen.has(e.command)) continue;
      seen.add(e.command);
      out.push(e);
    }

    this._history = {
      entries: out,
      // Said out loud in the window: bash writes its history when the shell
      // exits, so whatever is being typed in the session next to this list
      // is usually not in it yet.
      truncated: entries.length >= 4000,
      at: Date.now(),
    };
    return this._history;
  }

  /** Write the master's PTY (answers password / MFA prompts). */
  writeMaster(data) {
    if (this.master) this.master.write(data);
  }

  /**
   * Start the live monitor (see MONITOR_SCRIPT), shared by every pane on this
   * connection: the second caller is told it is already running.
   *
   * Refused where serverInfo is, and for the same reason: on a host whose tsh
   * transport was chosen for per-session MFA, a command session is one more
   * approval nobody asked for.
   */
  async startMonitor({ interval = 5 } = {}) {
    if (this.transport === 'tsh' && !this.tshByNecessity) {
      return { ok: false, reason: 'mfa', error: 'Live stats need a command session, which on a per-session-MFA host means another approval.' };
    }
    if (this._monitor) return { ok: true, running: true };
    await this.connect();
    const script = MONITOR_SCRIPT(interval);
    const useTsh = this.transport === 'tsh' || this.transport === 'beam';
    const file = useTsh ? teleport.findTsh() : sshbin.findSsh();
    const args = this.transport === 'beam'
      ? this.beamArgs(script)
      : useTsh
        ? this.tshArgs([], script)
        : this.sshArgs(['-T', this.target, script]);
    const child = spawn(file, args, { env: this.procEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const mon = { child, buf: '', err: '' };
    this._monitor = mon;
    child.stdout.on('data', (d) => {
      mon.buf += String(d);
      let nl;
      while ((nl = mon.buf.indexOf('\n')) >= 0) {
        const line = mon.buf.slice(0, nl).trim();
        mon.buf = mon.buf.slice(nl + 1);
        const s = parseMonitorLine(line);
        if (s) this.emit('monitor', s);
      }
    });
    child.stderr.on('data', (d) => { mon.err = (mon.err + String(d)).slice(-2000); });
    const ended = (code) => {
      if (this._monitor !== mon) return;
      this._monitor = null;
      this.emit('monitor', { kind: 'ended', code, error: mon.stopped ? '' : (firstProblem(mon.err) || mon.err.trim().slice(0, 300)) });
    };
    child.on('exit', (code) => ended(code ?? 1));
    child.on('error', (e) => { mon.err += e.message; ended(1); });
    return { ok: true };
  }

  stopMonitor() {
    const mon = this._monitor;
    if (!mon) return false;
    mon.stopped = true;
    try { mon.child.kill(); } catch { /* already gone */ }
    return true;
  }

  _teardownChildren() {
    this.stopMonitor();
    for (const [id] of this.terminals) this.closeTerminal(id);
    for (const [id] of this.execs) this.killExec(id);
    for (const f of this.forwards) { if (f._proc) { try { f._proc.kill(); } catch { /* the process may already have exited */ } } }
    this.forwards = [];
    if (this.sftp) { this.sftp.destroy(); this.sftp = null; this._sftpPromise = null; }
  }

  async disconnect() {
    this._setState('closed');
    clearInterval(this._health);
    this._teardownChildren();
    await new Promise((resolve) => {
      execFile(sshbin.findSsh(), this.sshArgs(['-O', 'exit', this.target]), { timeout: 6000, env: this.procEnv() }, () => resolve());
    });
    if (this.master) { try { this.master.kill(); } catch { /* the master may already have exited */ } this.master = null; }
    this._connecting = null;
    try { fs.existsSync(this.controlPath) && fs.unlinkSync(this.controlPath); } catch { /* no stale socket to remove */ }
  }
}

/**
 * Remove ANSI escape sequences so a session log reads as plain text.
 * Covers CSI, OSC and the single-character escapes terminals emit constantly.
 */
function stripAnsi(text) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[=>]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}

/**
 * A host that answers with a *different* key than the one already recorded
 * for it — a rebuilt box, a reimaged VM, a container recreated from
 * scratch. Distinct from a brand-new host, which `StrictHostKeyChecking
 * accept-new` already trusts silently without this ever firing: this is
 * ssh refusing outright, and the fix (forgetting the stale known_hosts
 * entry) is never done automatically — only ever offered, same as the MFA
 * alternative below.
 */
function looksLikeHostKeyChanged(text) {
  return /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(String(text || ''));
}

/**
 * Does this failure look like a node that requires per-session MFA?
 *
 * `tsh proxy ssh` does not perform the MFA ceremony, so the OpenSSH path just
 * runs out of keys — "too many authentication failures" is the signature of an
 * MFA-protected node, not a misconfigured key.
 */
function looksLikeMfa(text) {
  const t = String(text || '');
  // An explicit RBAC refusal names the login and is not an MFA problem.
  if (/access denied to \S+ connecting/i.test(t)) return false;
  return /mfa|multi.?factor|second factor|per-session|webauthn|security key/i.test(t)
    || /too many authentication failures/i.test(t)
    || /permission denied \(publickey/i.test(t);
}

/** Turn noisy ssh output into something worth showing a user. */
function cleanupError(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter((l) =>
    /permission denied|connection refused|connection closed|could not resolve|no route to host|timed out|host key|offline or does not exist|not found|access denied|ERROR|Too many authentication/i.test(l));
  const pick = (interesting.length ? interesting : lines).slice(-2).join(' — ');
  // eslint-disable-next-line no-control-regex
  return pick.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300) || null;
}

class ConnectionManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.configDir = path.join(RUNTIME_DIR, 'ssh-config');
  }

  list() {
    return [...this.connections.values()].map((c) => ({
      id: c.id, label: c.label, type: c.type, target: c.target,
      state: c.state, error: c.error, homeDir: c.homeDir,
      user: c.remoteUser, hostname: c.remoteHostname,
      terminals: [...c.terminals.keys()],
      forwards: c.listForwards(),
    }));
  }

  /** Every active tunnel across every connection. */
  allForwards() {
    return [...this.connections.values()].flatMap((c) => c.listForwards());
  }

  get(id) { return this.connections.get(id); }

  /**
   * Build (but do not yet dial) a connection for a host descriptor from the
   * sidebar. Teleport nodes get a freshly generated tsh ssh_config.
   */
  async create(host, { login, x11, agentForward, compression, transport, mfaMode, sshOptions } = {}) {
    let spec;

    /*
     * No OpenSSH client on this machine — a normal state of affairs on Windows,
     * where it is an optional feature.
     *
     * A Teleport node does not need one: `tsh ssh` dials it itself, carries its
     * own MFA ceremony, and serves the file browser through the same channel.
     * So the transport falls back rather than the connection failing. A plain
     * ssh_config host has no such route, and says so instead of dying on a
     * spawn error nobody can read.
     */
    /*
     * A beam: no ssh_config, no target, no OpenSSH at all — `tsh beams ssh`
     * for the terminal and `tsh beams exec` for everything else. Handled
     * before the ssh-availability check because none of it applies.
     */
    if (host.type === 'beam') {
      const conn = this._register(new Connection({
        type: 'beam',
        target: host.name,
        label: `${host.name} (beam)`,
        beam: { name: host.name, proxy: host.proxy || '', home: host.home || null },
        node: host,
        transport: 'beam',
      }));
      return conn;
    }

    const haveSsh = sshbin.sshAvailable();
    if (!haveSsh) {
      if (host.type !== 'teleport') {
        throw new Error('No OpenSSH client found on this machine, and a plain SSH host needs one. '
          + 'On Windows: Settings → Apps → Optional features → OpenSSH Client. '
          + 'Teleport nodes work without it.');
      }
      transport = 'tsh';
    }

    let leafForced = false;
    if (host.type === 'teleport') {
      /*
       * A node in a leaf cluster goes through `tsh ssh` whatever was asked
       * for. The ssh_config route would connect — the leaf trusts the root's
       * user CA — but it would do so holding the root's certificate, which is
       * the only one `tsh config` names. Going through tsh gets a certificate
       * issued for the leaf, so the leaf's role mapping and principals decide
       * what the session can do. See teleport.isLeafCluster.
       */
      if (transport !== 'tsh' && await teleport.isLeafCluster({
        proxy: host.proxy, cluster: host.cluster, home: host.home,
      })) {
        transport = 'tsh';
        leafForced = true;
      }
      /*
       * A node sharing its hostname with another needs no special transport:
       * it needs a name that means one machine, which is its UUID, and the
       * generated ssh_config takes that as readily as a hostname — its Host
       * pattern is `*.cluster`, and `tsh proxy ssh` resolves a UUID on the
       * other side. `teleportSshTarget` supplies it.
       *
       * This used to force `tsh ssh` instead, on the reasoning that the
       * config addresses everything as `hostname.cluster` and the hostname
       * was the ambiguous part. That was wrong, and expensively so: `tsh
       * ssh` has no subsystem flag, so the file browser has to exec the
       * host's own sftp-server — and a container node that has no such
       * binary answered every listing with "sftp-server not found on this
       * host (127)". Over the shared connection the file channel asks for
       * the `sftp` subsystem, which the Teleport agent serves itself,
       * needing nothing installed. Keeping the ControlMaster also keeps one
       * authentication, and `ssh -W` for port checks.
       */
      // The generated config only matters to the ssh path; with tsh there is
      // nothing to point ssh at, so skip a spawn that cannot be used.
      //
      // Caught rather than left to throw: `tsh config` needs a cluster that
      // is actually logged in, and on one that just expired this ran before
      // the renderer's own relogin-and-retry ever got a turn — `create`
      // failing outright meant no `Connection` was ever registered for
      // `connect` to retry later, so an ordinary node on an expired cluster
      // never got the login prompt an MFA-marked one did (that one skips
      // this file entirely, which is the only reason it was unaffected). A
      // `null` here is not a problem on its own: `connect` regenerates it
      // right before dialling, once whatever relogin was needed has had its
      // turn to run.
      const configFile = transport === 'tsh'
        ? null
        : await teleport.writeClusterSshConfig(this.configDir, {
            proxy: host.proxy, cluster: host.cluster, home: host.home,
          }).catch(() => null);
      const target = teleport.teleportSshTarget(host, login);
      spec = {
        type: 'teleport',
        target,
        configFile,
        /*
         * Two nodes with one hostname would otherwise open two tabs with the
         * same title — the same ambiguity, one layer up. The first block of
         * the UUID tells them apart and is short enough to live in a tab.
         */
        label: host.ambiguous && host.uuid
          ? `${host.name} (${host.cluster}) · ${String(host.uuid).slice(0, 8)}`
          : `${host.name} (${host.cluster})`,
        node: host,
        login,
        x11,
        agentForward,
        compression,
        sshOptions,
        transport,
        mfaMode,
        // Recorded so the UI can explain a transport it did not ask for.
        transportForced: !haveSsh ? 'no-ssh' : (leafForced ? 'leaf' : null),
      };
    } else if (host.direct) {
      // A server defined in the app: no ssh_config entry, so the details go
      // on the command line instead of behind an alias.
      const user = login || host.direct.user;
      const target = user ? `${user}@${host.direct.hostname}` : host.direct.hostname;
      spec = {
        type: 'ssh',
        target,
        configFile: null,
        label: host.name || host.alias || host.direct.hostname,
        direct: host.direct,
        host,
        login,
        x11,
        agentForward,
        compression,
        sshOptions,
        transport,
        mfaMode,
      };
    } else {
      const target = login ? `${login}@${host.alias}` : host.alias;
      spec = {
        type: 'ssh',
        target,
        /*
         * An alias from an extra config file only exists inside that file, so
         * the file has to be named on the command line — `ssh -F` — exactly as
         * it was when the alias was resolved for the list. An alias from
         * ~/.ssh/config names nothing, because naming it would exclude the
         * system config and the defaults ssh applies on its own.
         */
        configFile: host.configFile || null,
        identityFile: host.identityFile || null,
        proxyJump: host.proxyJump || null,
        label: host.alias + (login ? ` (${login})` : ''),
        host,
        login,
        x11,
        agentForward,
        compression,
        sshOptions,
        transport,
        mfaMode,
      };
    }

    return this._register(new Connection(spec));
  }

  /** Track a connection and forward its events under the manager's names. */
  _register(conn) {
    this.connections.set(conn.id, conn);
    for (const ev of ['state', 'log', 'info', 'transfers', 'xferdone', 'terminal-data', 'terminal-exit', 'forwards', 'serverinfo', 'logging', 'exec-data', 'exec-prompt', 'monitor']) {
      conn.on(ev, (payload) => this.emit('conn:' + ev, conn.id, payload));
    }
    this.emit('changed');
    conn.on('state', () => this.emit('changed'));
    return conn;
  }

  async remove(id) {
    const c = this.connections.get(id);
    if (!c) return;
    await c.disconnect();
    this.connections.delete(id);
    this.emit('changed');
  }

  async shutdown() {
    await Promise.all([...this.connections.values()].map((c) => c.disconnect().catch(() => {})));
    this.connections.clear();
  }
}

module.exports = { ConnectionManager, Connection, RUNTIME_DIR, MONITOR_SCRIPT, parseMonitorLine };
