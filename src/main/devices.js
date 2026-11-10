'use strict';
/**
 * Sessions that are a byte stream rather than a shell: serial consoles and
 * telnet.
 *
 * Both are here for the same reason. The machines that still answer only on a
 * console cable or on port 23 are switches, routers, PDUs, BMCs, out-of-band
 * terminal servers and the odd appliance — exactly the things you reach for
 * when the thing you would rather use, SSH, is what has stopped working. A
 * tool for looking after servers that cannot talk to a console is a tool that
 * leaves at the moment it is needed.
 *
 * They are deliberately *not* connections in the `connections.js` sense.
 * There is no ControlMaster, no SFTP, no port forwarding and no second
 * channel: a serial port is one stream of bytes with no multiplexing in it at
 * all, and a telnet session is one socket. Modelling them as cut-down
 * connections would mean every file-transfer path in the app growing an `if`
 * for the case where there is no file transfer. So they are their own small
 * thing, shaped like `LocalTerminals` — open, write, resize, close, and two
 * events — and the renderer treats a pane running one as a terminal that
 * happens not to have a filesystem behind it.
 */

const net = require('net');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

/* ------------------------------------------------------------------ */
/* Telnet                                                              */
/* ------------------------------------------------------------------ */

const IAC = 255;
const DONT = 254, DO = 253, WONT = 252, WILL = 251;
const SB = 250, SE = 240;

const OPT_BINARY = 0, OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;

/* What we are prepared to do ourselves, and what we are happy for them to do. */
const WE_WILL = new Set([OPT_TTYPE, OPT_NAWS, OPT_SGA, OPT_BINARY]);
const THEY_MAY = new Set([OPT_ECHO, OPT_SGA, OPT_BINARY]);

/**
 * Pull the telnet protocol out of a stream of bytes.
 *
 * Telnet interleaves its negotiation with the data rather than framing it, so
 * every byte of output has to be walked: an unlucky 0xFF in the middle of a
 * `tcpdump` is the same byte that introduces a command. The parser therefore
 * keeps its state *between* chunks — a command can be split across two
 * packets, and a subnegotiation across several — which is the part a
 * line-at-a-time filter gets wrong and only on a busy session.
 *
 * Pure, and exported, so the awkward cases can be tested without a server:
 * takes the carried state and a chunk, returns the data to show, the bytes to
 * send back, and the state to carry on with.
 */
function telnetParse(state, chunk) {
  const st = state || { mode: 'data', opt: 0, sb: [], agreed: new Set() };
  const out = [];
  const replies = [];
  let sawNaws = false;

  for (const b of chunk) {
    switch (st.mode) {
      case 'data':
        if (b === IAC) st.mode = 'iac';
        else out.push(b);
        break;

      case 'iac':
        if (b === IAC) { out.push(IAC); st.mode = 'data'; }           // escaped 0xFF
        else if (b === DO || b === DONT || b === WILL || b === WONT) { st.cmd = b; st.mode = 'opt'; }
        else if (b === SB) { st.mode = 'sbopt'; }
        // Everything else is a two-byte command with nothing to answer:
        // NOP, Are You There, Interrupt Process and friends.
        else st.mode = 'data';
        break;

      case 'opt': {
        const opt = b;
        if (st.cmd === DO) {
          const yes = WE_WILL.has(opt);
          replies.push(IAC, yes ? WILL : WONT, opt);
          if (yes) st.agreed.add(opt);
          // The window size is sent once the other end has asked for it, and
          // then again on every resize.
          if (yes && opt === OPT_NAWS) sawNaws = true;
        } else if (st.cmd === DONT) {
          replies.push(IAC, WONT, opt);
          st.agreed.delete(opt);
        } else if (st.cmd === WILL) {
          replies.push(IAC, THEY_MAY.has(opt) ? DO : DONT, opt);
        } else if (st.cmd === WONT) {
          replies.push(IAC, DONT, opt);
        }
        st.mode = 'data';
        break;
      }

      case 'sbopt':
        st.opt = b;
        st.sb = [];
        st.mode = 'sb';
        break;

      case 'sb':
        if (b === IAC) st.mode = 'sbiac';
        else st.sb.push(b);
        break;

      case 'sbiac':
        if (b === IAC) { st.sb.push(IAC); st.mode = 'sb'; }
        else if (b === SE) {
          // The only subnegotiation worth answering: "what terminal are you?"
          if (st.opt === OPT_TTYPE && st.sb[0] === 1) {
            replies.push(IAC, SB, OPT_TTYPE, 0);
            for (const c of Buffer.from('xterm-256color', 'ascii')) replies.push(c);
            replies.push(IAC, SE);
          }
          st.mode = 'data';
        } else {
          st.mode = 'data';
        }
        break;

      default:
        st.mode = 'data';
    }
  }

  return { data: Buffer.from(out), replies: Buffer.from(replies), state: st, sawNaws };
}

/** The window size, in the shape telnet wants it. */
function nawsFrame(cols, rows) {
  const c = Math.max(1, Math.min(65535, cols | 0));
  const r = Math.max(1, Math.min(65535, rows | 0));
  const body = [c >> 8, c & 255, r >> 8, r & 255];
  // A dimension that happens to be 0xFF has to be escaped like any other byte.
  const esc = [];
  for (const b of body) { esc.push(b); if (b === IAC) esc.push(IAC); }
  return Buffer.from([IAC, SB, OPT_NAWS, ...esc, IAC, SE]);
}

/* ------------------------------------------------------------------ */
/* What the user types                                                 */
/* ------------------------------------------------------------------ */

/**
 * Translate Return on the way out.
 *
 * Nothing in a terminal agrees about what Enter means. xterm sends CR; a
 * Cisco console wants CR, a Linux getty over serial usually wants LF, and
 * some appliances insist on CRLF and show you a staircase if they do not get
 * it. Telnet's own answer, in its NVT, is CR LF. Guessing wrong produces a
 * console that looks dead or one that double-spaces every line, so it is a
 * setting on the saved connection with a sensible default per protocol, and
 * this is where it is applied.
 */
function translateNewline(data, mode) {
  if (!mode || mode === 'cr') return data;
  const s = String(data);
  if (mode === 'lf') return s.replace(/\r\n?/g, '\n');
  if (mode === 'crlf') return s.replace(/\r\n?|\n/g, '\r\n');
  return data;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

class DeviceSessions extends EventEmitter {
  constructor() { super(); this.sessions = new Map(); }

  /**
   * Output, held until there is somewhere to put it.
   *
   * A session is opened and *then* bound to a pane: the renderer learns the
   * id from the answer to `open`, which is one IPC round trip after the
   * socket connected. Anything the far end said in that gap — a switch's
   * banner, telnet's own greeting — arrived addressed to a pane that did not
   * exist yet and was dropped on the floor. Milliseconds, and exactly the
   * milliseconds that carry the first thing anyone wants to read.
   *
   * So it is queued until the renderer says it is listening.
   */
  _say(id, data) {
    const s = this.sessions.get(id);
    if (s && !s.ready) { s.pending.push(data); return; }
    this.emit('data', { id, data });
  }

  /** The renderer has a pane for this session: send what was said meanwhile. */
  ready(id) {
    const s = this.sessions.get(id);
    if (!s || s.ready) return;
    s.ready = true;
    const queued = s.pending.splice(0);
    for (const data of queued) this.emit('data', { id, data });
  }

  /** The serial ports this machine can see, newest-looking first. */
  async listPorts() {
    const { SerialPort } = requireSerial();
    const ports = await SerialPort.list();
    return (ports || []).map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      serialNumber: p.serialNumber || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
      // The name people actually recognise — "USB Serial", "KeySerial1" — is
      // not in a single field on every platform.
      label: [p.manufacturer, p.friendlyName || p.pnpId].filter(Boolean).join(' · '),
    }));
  }

  open(opts) {
    if (opts?.kind === 'serial') return this._openSerial(opts);
    if (opts?.kind === 'telnet') return this._openTelnet(opts);
    throw new Error(`unknown device kind: ${opts?.kind}`);
  }

  _openSerial({ id, path: devPath, baudRate = 115200, dataBits = 8, stopBits = 1,
    parity = 'none', rtscts = false, xon = false, xoff = false,
    newline = 'cr', localEcho = false }) {
    const { SerialPort } = requireSerial();
    if (!devPath) throw new Error('No serial port given');

    const port = new SerialPort({
      path: devPath,
      baudRate: Number(baudRate) || 115200,
      dataBits: Number(dataBits) || 8,
      stopBits: Number(stopBits) || 1,
      parity: parity || 'none',
      rtscts: !!rtscts,
      xon: !!xon,
      xoff: !!xoff,
      autoOpen: false,
    });

    const session = {
      id, kind: 'serial', port, newline, localEcho,
      /*
       * A decoder per session rather than `toString` per chunk: a serial port
       * hands over whatever happened to arrive, and a multi-byte character
       * split across two reads becomes two replacement characters if each
       * chunk is decoded alone. Rare on a switch console, routine on anything
       * that prints a box-drawing banner.
       */
      decoder: new StringDecoder('utf8'),
      ready: false,
      pending: [],
      label: `${devPath} · ${baudRate} ${dataBits}${(parity || 'none')[0].toUpperCase()}${stopBits}`,
    };
    this.sessions.set(id, session);

    port.on('data', (d) => this._say(id, session.decoder.write(d)));
    port.on('close', () => this._ended(id, 'port closed'));
    port.on('error', (e) => {
      /*
       * A cable pulled out of a laptop is an error on the port, not a clean
       * close, and it arrives while the user is looking at a terminal full of
       * output they still want. Saying so in the pane and ending the session
       * beats throwing it away silently.
       */
      this._say(id, `\r\n\x1b[31m[serial: ${e.message}]\x1b[0m\r\n`);
      this._ended(id, e.message);
    });

    return new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) {
          this.sessions.delete(id);
          return reject(new Error(serialHint(err, devPath)));
        }
        resolve({ id, kind: 'serial', label: session.label, path: devPath });
      });
    });
  }

  /**
   * What the telnet client everyone knows prints before anything else.
   *
   * `Trying 3.238.220.225...` / `Connected to host.` / `Escape character is
   * '^]'.` — three lines that have been the same for forty years, and the
   * reason half of telnet's remaining use works at all: pointed at a port
   * that says nothing until it is spoken to, they are the only evidence that
   * anything happened. Without them a session to an HTTPS port looks
   * identical to a session that failed.
   *
   * The resolved address is in there because it is frequently the question —
   * `telnet host 443` is how people find out which way DNS is pointing today.
   */
  _telnetGreeting(socket, host) {
    const addr = socket.remoteAddress ? socket.remoteAddress.replace(/^::ffff:/, '') : host;
    return `Trying ${addr}...\r\nConnected to ${host}.\r\n`
      + `Escape character is '^]'.\r\n`;
  }

  _openTelnet({ id, host, port = 23, cols = 100, rows = 30, newline = 'crlf', localEcho = false }) {
    if (!host) throw new Error('No host given');
    const socket = new net.Socket();
    const session = {
      id, kind: 'telnet', socket, newline, localEcho,
      decoder: new StringDecoder('utf8'),
      ready: false,
      pending: [],
      telnet: null, cols, rows, label: `${host}:${port}`,
    };
    this.sessions.set(id, session);

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      const r = telnetParse(session.telnet, chunk);
      session.telnet = r.state;
      if (r.replies.length) socket.write(r.replies);
      // The size is only worth sending once they have agreed to hear it.
      if (r.sawNaws) socket.write(nawsFrame(session.cols, session.rows));
      if (r.data.length) this._say(id, session.decoder.write(r.data));
    });
    socket.on('error', (e) => {
      /*
       * Only once. A failure to connect is already reported by the promise
       * below, which becomes the pane's error; writing it into the terminal
       * as well said the same thing twice in two different wordings.
       */
      if (!session.connected) return;
      this._say(id, `\r\n\x1b[31m${telnetError(e, host)}\x1b[0m\r\n`);
    });
    // What telnet says when the far end goes away, because that is what it is.
    socket.on('close', () => this._ended(id, 'connection closed by foreign host'));

    return new Promise((resolve, reject) => {
      socket.once('error', (e) => {
        if (this.sessions.get(id) === session && !session.connected) {
          this.sessions.delete(id);
          reject(new Error(telnetError(e, host, port)));
        }
      });
      socket.connect({ host, port: Number(port) || 23 }, () => {
        session.connected = true;
        this._say(id, this._telnetGreeting(socket, host));
        resolve({
          id, kind: 'telnet', label: session.label, host, port: Number(port) || 23,
          // The pane has already been told what happened, in telnet's words.
          greeted: true,
        });
      });
    });
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s) return;
    /*
     * `^]` ends a telnet session, as it has always done. The pane can be
     * closed from its menu too, but a hand that has typed this since the
     * nineties should not have to learn where that is — and the greeting
     * promises it works.
     */
    if (s.kind === 'telnet' && String(data).includes('\u001d')) {
      this._say(id, '\r\ntelnet> quit\r\nConnection closed.\r\n');
      this.close(id);
      this._ended(id, 'closed from this end');
      return;
    }
    const text = translateNewline(data, s.newline);
    /*
     * Local echo, for the consoles that do none.
     *
     * A device still in its boot loader, or a serial port with nothing on the
     * other end yet, shows nothing at all as you type — which is
     * indistinguishable from a dead cable, and is the first thing anybody
     * asks about. When it is on, what you typed is written back into the pane
     * so you can see it; when the far end echoes too you get it twice, which
     * is why it is off unless asked for.
     */
    if (s.localEcho) this._say(id, text);
    if (s.kind === 'serial') { try { s.port.write(Buffer.from(text, 'utf8')); } catch { /* the port may have closed under us */ } return; }
    if (s.kind === 'telnet') {
      // 0xFF in user input has to be doubled, or the far end reads it as the
      // start of a command.
      const buf = Buffer.from(text, 'utf8');
      try { s.socket.write(buf.includes(IAC) ? escapeIac(buf) : buf); } catch { /* the socket may have closed under us */ }
    }
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.cols = cols; s.rows = rows;
    // A serial line has no idea how big your window is and no way to be told;
    // `stty rows/cols` on the far side is the only answer, and that is the
    // user's to give.
    if (s.kind === 'telnet' && s.telnet?.agreed?.has(OPT_NAWS)) {
      try { s.socket.write(nawsFrame(cols, rows)); } catch { /* the socket may have closed under us */ }
    }
  }

  /** A serial break — how you interrupt a boot loader, and nothing else. */
  async sendBreak(id, ms = 250) {
    const s = this.sessions.get(id);
    if (!s || s.kind !== 'serial') throw new Error('Not a serial session');
    await new Promise((res, rej) => s.port.set({ brk: true }, (e) => (e ? rej(e) : res())));
    await new Promise((res) => setTimeout(res, Math.max(50, Math.min(2000, ms))));
    await new Promise((res, rej) => s.port.set({ brk: false }, (e) => (e ? rej(e) : res())));
    return true;
  }

  /** Raise or drop the modem control lines by hand. */
  async setSignals(id, signals) {
    const s = this.sessions.get(id);
    if (!s || s.kind !== 'serial') throw new Error('Not a serial session');
    await new Promise((res, rej) => s.port.set(signals, (e) => (e ? rej(e) : res())));
    return true;
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      if (s.kind === 'serial') s.port.close(() => {});
      else s.socket.destroy();
    } catch { /* already closed */ }
  }

  closeAll() { for (const [id] of this.sessions) this.close(id); }

  _ended(id, why) {
    const s = this.sessions.get(id);
    if (!s) return;
    // Anything said before the pane was bound still belongs to it: a server
    // that greets you and hangs up says everything it will ever say inside
    // that gap, and losing it leaves an empty pane and a verdict.
    const queued = s.pending.splice(0);
    this.sessions.delete(id);
    for (const data of queued) this.emit('data', { id, data });
    this.emit('exit', { id, exitCode: 0, reason: why });
  }
}

/**
 * A failure in telnet's words rather than node's.
 *
 * `connect ECONNREFUSED 127.0.0.1:23` is accurate and unlike anything the
 * tool has ever said; the phrasing below is what the client prints, which is
 * what someone searching for the message will find.
 */
function telnetError(err, host, port) {
  const code = err?.code || '';
  const where = port ? `${host}:${port}` : host;
  if (code === 'ECONNREFUSED') return `telnet: Unable to connect to remote host: Connection refused (${where})`;
  if (code === 'ETIMEDOUT') return `telnet: Unable to connect to remote host: Operation timed out (${where})`;
  if (code === 'EHOSTUNREACH') return `telnet: Unable to connect to remote host: No route to host (${where})`;
  if (code === 'ENETUNREACH') return `telnet: Unable to connect to remote host: Network is unreachable (${where})`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `telnet: could not resolve ${host}: Name or service not known`;
  if (code === 'ECONNRESET') return 'telnet: Connection reset by peer';
  return `telnet: ${err?.message || 'connection failed'}`;
}

function escapeIac(buf) {
  const out = [];
  for (const b of buf) { out.push(b); if (b === IAC) out.push(IAC); }
  return Buffer.from(out);
}

/**
 * Serial support is a native module, and a native module is the one
 * dependency that can be missing from a working app — a build where the
 * rebuild step did not run, or a platform nobody packaged for. Required here
 * rather than at the top of the file so that failure costs the serial feature
 * and not the whole application.
 */
function requireSerial() {
  try {
    return require('serialport');
  } catch (e) {
    throw new Error('Serial support is not available in this build '
      + `(${e.message.split('\n')[0]})`, { cause: e });
  }
}

/**
 * The three things that actually go wrong when opening a port, said plainly.
 * "Error: Permission denied, cannot open /dev/ttyUSB0" is true and useless;
 * "you are not in the dialout group" is the next command to run.
 */
function serialHint(err, devPath) {
  const msg = err.message || String(err);
  if (/access denied|permission denied|EACCES/i.test(msg)) {
    if (process.platform === 'linux') {
      return `${devPath}: permission denied — add yourself to the dialout group `
        + `(sudo usermod -aG dialout $USER) and log in again`;
    }
    return `${devPath}: permission denied`;
  }
  if (/busy|EBUSY|Resource temporarily unavailable/i.test(msg)) {
    return `${devPath} is in use by something else — screen, minicom or another window`;
  }
  if (/no such file|ENOENT|cannot open/i.test(msg)) {
    return `${devPath} is not there — the adapter may have been unplugged`;
  }
  return `${devPath}: ${msg}`;
}

module.exports = {
  DeviceSessions,
  // Exported for the tests: the protocol parsing is the part with edges.
  telnetParse, nawsFrame, translateNewline, escapeIac, serialHint, telnetError,
};
