'use strict';
/**
 * tmux control mode: sessions that outlive the client.
 *
 * Everything else in this app dies with the connection. Close the lid, change
 * network, quit by accident, and the shell that was halfway through a
 * migration is gone — because an SSH session *is* the thing doing the work,
 * and when it ends the work ends. That is the single largest thing a terminal
 * can be wrong about, and the fix has existed for fifteen years: run the work
 * inside tmux on the far side, and let the client be something that can be
 * thrown away.
 *
 * `tmux -CC` is how that happens without the client pretending to be a
 * terminal inside a terminal. In control mode tmux stops drawing a status bar
 * and sends a line-based protocol instead: one notification per event, one
 * guarded block per command. Each tmux pane's output arrives tagged with the
 * pane it came from, so the client can put it in a real pane of its own —
 * which is why this is worth doing *here* rather than telling people to press
 * ctrl-b. ServerLife already has panes, splits, tabs and a layout tree; tmux
 * has panes, splits, windows and a layout string. They are the same shapes.
 *
 * What the far side needs is tmux. What this side needs is nothing: the
 * protocol is text over the connection that is already open, so there is no
 * client binary to install and no second port to reach.
 *
 * The parsing is pure and exported because every edge in it is a silent
 * corruption: an octal escape read wrongly puts a stray backslash in
 * somebody's config file, and a layout misread puts output in the wrong pane.
 */

const { EventEmitter } = require('events');

/* The DCS tmux sends on entering control mode. Everything before it is the
 * login banner and the terminal handshake; nothing before it is protocol. */
const DCS = '\u001bP1000p';

/* ------------------------------------------------------------------ */
/* Output escaping                                                     */
/* ------------------------------------------------------------------ */

/**
 * tmux escapes the output it forwards: every character below ASCII 32 and
 * the backslash itself become three octal digits. So an escape sequence
 * arrives as `\033[1m` — six characters where the terminal wants two — and a
 * literal backslash in someone's `grep` arrives as `\134`.
 *
 * The order matters. Decoding `\134` to a backslash *before* scanning means
 * the next three digits get read as another escape, so `\134033` — a
 * backslash followed by the text 033 — would turn into a backslash and an
 * ESC. One pass, left to right, is the only way this is right.
 */
function unescapeOutput(s) {
  const str = String(s);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\' && /^[0-7]{3}$/.test(str.slice(i + 1, i + 4))) {
      out += String.fromCharCode(parseInt(str.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      out += str[i];
    }
  }
  return out;
}

/** Arbitrary bytes, in the one form `send-keys` cannot misread. */
function hexKeys(data) {
  const buf = Buffer.from(String(data), 'utf8');
  const parts = [];
  for (const b of buf) parts.push('0x' + b.toString(16).padStart(2, '0'));
  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Layouts                                                             */
/* ------------------------------------------------------------------ */

/**
 * A tmux layout string, as a tree.
 *
 *   bb62,279x82,0,0[279x41,0,0,1,279x40,0,42{139x40,0,42,2,139x40,140,42,3}]
 *
 * After the checksum it is one node: `WxH,x,y` followed by either a pane
 * index, `[...]` for children stacked top to bottom, or `{...}` for children
 * side by side. Which is exactly ServerLife's own split tree with the names
 * changed — `[` is a column of panes, `{` is a row — so a window's
 * arrangement can be rebuilt here rather than approximated.
 */
function parseLayout(layout) {
  const s = String(layout || '');
  // Drop the leading checksum, which is tmux's own integrity check on the
  // string and no use to a reader.
  const body = s.includes(',') ? s.slice(s.indexOf(',') + 1) : s;
  let i = 0;

  const fail = () => { throw new Error(`bad layout at ${i}: ${s}`); };

  const number = () => {
    const start = i;
    while (i < body.length && /[0-9]/.test(body[i])) i++;
    if (i === start) fail();
    return parseInt(body.slice(start, i), 10);
  };

  const node = () => {
    const w = number();
    if (body[i] !== 'x') fail();
    i++;
    const h = number();
    if (body[i] !== ',') fail();
    i++;
    const x = number();
    if (body[i] !== ',') fail();
    i++;
    const y = number();

    if (body[i] === ',') {
      i++;
      const pane = number();
      return { w, h, x, y, pane: `%${pane}` };
    }
    if (body[i] === '[' || body[i] === '{') {
      const close = body[i] === '[' ? ']' : '}';
      const dir = body[i] === '[' ? 'col' : 'row';
      i++;
      const children = [];
      for (;;) {
        children.push(node());
        if (body[i] === ',') { i++; continue; }
        if (body[i] === close) { i++; break; }
        fail();
      }
      return { w, h, x, y, dir, children };
    }
    return { w, h, x, y, pane: null };
  };

  const root = node();
  return root;
}

/** Every pane in a layout, in the order tmux lists them. */
function panesInLayout(node, out = []) {
  if (!node) return out;
  if (node.pane) out.push(node.pane);
  for (const c of node.children || []) panesInLayout(c, out);
  return out;
}

/* ------------------------------------------------------------------ */
/* The protocol                                                        */
/* ------------------------------------------------------------------ */

/**
 * A parser that can be fed arbitrary chunks.
 *
 * Three things make this fiddly, and all three were seen on a real session
 * rather than imagined. Output arrives split at any byte, including the
 * middle of an escape sequence, so nothing may be interpreted until a line is
 * complete. The protocol does not begin at byte zero — a login banner, and
 * tmux's own terminal probes, come first, and the probes have to be answered
 * or tmux waits forever. And once the DCS has gone past, this side's stdin is
 * the *command channel*: a late answer to a terminal query is parsed as a
 * command and comes back as `parse error: unknown command`.
 */
class Parser {
  /**
   * `plain` is for `tmux -C` with no terminal in between — a beam, where
   * nothing else is on the stream: there is no DCS and no probe, and the
   * protocol starts with the first line.
   */
  constructor({ plain = false } = {}) {
    this.plain = plain;
    this.announced = false;
    this.inControl = plain;
    this.buf = '';
    this.block = null;       // { num, lines } while inside %begin … %end
  }

  /**
   * Feed a chunk. Returns the events in it.
   *
   * A `probe` event carries what the caller should write back, and is only
   * ever emitted before control mode starts — afterwards the same bytes are
   * data, and answering them would corrupt the command channel.
   */
  feed(chunk) {
    const events = [];
    let text = String(chunk);

    if (!this.inControl) {
      const at = text.indexOf(DCS);
      const pre = at >= 0 ? text.slice(0, at) : text;
      for (const answer of probeAnswers(pre)) events.push({ type: 'probe', data: answer });
      if (pre) events.push({ type: 'preamble', text: pre });
      if (at < 0) return events;
      this.inControl = true;
      events.push({ type: 'ready' });
      text = text.slice(at + DCS.length);
    }

    this.buf += text;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this._line(line, events);
    }
    return events;
  }

  _line(line, events) {
    // Without a DCS to say so, control mode has begun when tmux first speaks.
    if (this.plain && !this.announced && line.startsWith('%')) {
      this.announced = true;
      events.push({ type: 'ready' });
    }
    // A notification never appears inside a block, so a block only ever ends
    // at its own guard line.
    if (this.block) {
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
        events.push({
          type: 'result',
          num: this.block.num,
          /*
           * The third field of the guard line. tmux marks the replies to a
           * client's commands with 1, and the block it sends on its own
           * account — the one that opens control mode — with 0. That
           * difference is the only thing that tells them apart, and telling
           * them apart is the difference between every answer being right and
           * every answer being the previous one.
           */
          flags: (line.split(' ')[3] || '').trim(),
          error: line.startsWith('%error'),
          lines: this.block.lines,
        });
        this.block = null;
        return;
      }
      this.block.lines.push(line);
      return;
    }

    if (line.startsWith('%begin ')) {
      this.block = { num: line.split(' ')[2] || '', lines: [] };
      return;
    }
    if (!line.startsWith('%')) {
      // Anything outside a block that is not a notification is noise from the
      // far side — a shell that printed something after tmux started.
      if (line.trim()) events.push({ type: 'noise', text: line });
      return;
    }

    const sp = line.indexOf(' ');
    const kind = sp < 0 ? line.slice(1) : line.slice(1, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1);

    switch (kind) {
      case 'output': {
        const i = rest.indexOf(' ');
        const pane = i < 0 ? rest : rest.slice(0, i);
        events.push({ type: 'output', pane, data: unescapeOutput(i < 0 ? '' : rest.slice(i + 1)) });
        break;
      }
      case 'extended-output': {
        // `%extended-output %0 <ms-behind> : <data>` — the form used once
        // flow control is on. The age is how far behind this client is.
        const m = rest.match(/^(%\d+) (\d+) :? ?([\s\S]*)$/);
        if (m) events.push({ type: 'output', pane: m[1], age: Number(m[2]), data: unescapeOutput(m[3]) });
        break;
      }
      case 'layout-change': {
        const [win, layout] = rest.split(' ');
        events.push({ type: 'layout', window: win, layout, tree: safeLayout(layout) });
        break;
      }
      case 'window-add':
      case 'unlinked-window-add':
        events.push({ type: 'window-add', window: rest.trim() });
        break;
      case 'window-close':
      case 'unlinked-window-close':
        events.push({ type: 'window-close', window: rest.trim() });
        break;
      case 'window-renamed':
      case 'unlinked-window-renamed': {
        const i = rest.indexOf(' ');
        events.push({ type: 'window-renamed', window: rest.slice(0, i), name: rest.slice(i + 1) });
        break;
      }
      case 'window-pane-changed': {
        const [win, pane] = rest.split(' ');
        events.push({ type: 'active-pane', window: win, pane });
        break;
      }
      case 'session-window-changed': {
        const [sess, win] = rest.split(' ');
        events.push({ type: 'active-window', session: sess, window: win });
        break;
      }
      case 'session-changed': {
        const i = rest.indexOf(' ');
        events.push({ type: 'session', id: rest.slice(0, i), name: rest.slice(i + 1) });
        break;
      }
      case 'session-renamed':
        events.push({ type: 'session-renamed', name: rest.trim() });
        break;
      case 'sessions-changed':
        events.push({ type: 'sessions-changed' });
        break;
      case 'pause':
        events.push({ type: 'pause', pane: rest.trim() });
        break;
      case 'continue':
        events.push({ type: 'continue', pane: rest.trim() });
        break;
      case 'exit':
        events.push({ type: 'exit', reason: rest.trim() || null });
        break;
      case 'subscription-changed': {
        const parts = rest.split(' ');
        events.push({ type: 'subscription', name: parts[0], value: parts.slice(5).join(' ') });
        break;
      }
      default:
        events.push({ type: 'other', kind, rest });
    }
  }
}

function safeLayout(layout) {
  try { return parseLayout(layout); } catch { return null; }
}

/**
 * What a terminal would answer to tmux's opening questions.
 *
 * tmux asks before it will start: where is the cursor, and what colour is the
 * background. A real terminal replies; a control-mode client is the terminal,
 * so it has to reply too, and tmux sits in silence if nobody does. The
 * answers are deliberately boring — this terminal is at the top left and has
 * a dark background — because nothing here depends on them being true.
 */
function probeAnswers(text) {
  const out = [];
  if (text.includes('\u001b[6n')) out.push('\u001b[1;1R');
  if (text.includes('\u001b]11;?')) out.push('\u001b]11;rgb:1212/1414/1a1a\u001b\\');
  // eslint-disable-next-line no-control-regex
  if (/\u001b\[>?c/.test(text)) out.push('\u001b[?1;2c');
  return out;
}

/* ------------------------------------------------------------------ */
/* Is tmux there at all?                                               */
/* ------------------------------------------------------------------ */

/**
 * Whether this host can do it, asked of the host.
 *
 * Only the server needs tmux: this side speaks the protocol itself, so there
 * is nothing to install on the laptop and nothing to keep in step between the
 * two. That is worth stating in the answer, because "tmux is required" sounds
 * like two installations and is one.
 *
 * A missing tmux is not an error — it is the ordinary state of a machine
 * nobody has set up yet — so it comes back as an answer with a reason, and
 * the reason is the command to run.
 */
async function probeTmux(conn) {
  const r = await conn.execResult('tmux -V 2>/dev/null || command -v tmux || true', { timeout: 15000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const m = text.match(/tmux\s+(?:next-)?(\d+)\.(\d+)([a-z])?/i);
  if (!m) {
    return {
      ok: false,
      clientNeeded: false,
      reason: text.includes('/tmux')
        ? 'tmux is installed but did not report a version'
        : (conn.transport === 'local' ? 'tmux is not installed on this machine' : 'tmux is not installed on this host'),
      install: conn.transport === 'local' && process.platform === 'darwin'
        ? 'brew install tmux'
        : 'apt install tmux · dnf install tmux · apk add tmux',
    };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const version = `${major}.${minor}${m[3] || ''}`;
  /*
   * 2.1 is where control mode became usable at all; 3.2 added flow control,
   * without which one `cat` of a large file leaves the client minutes behind
   * with no way to say stop. Below 3.2 it still works, just without the
   * brakes — which is worth knowing but not worth refusing over.
   */
  const supported = major > 2 || (major === 2 && minor >= 1);
  return {
    ok: supported,
    version,
    major,
    minor,
    flowControl: major > 3 || (major === 3 && minor >= 2),
    clientNeeded: false,
    reason: supported ? null : `tmux ${version} is too old for control mode (2.1 or newer)`,
  };
}

/** The sessions already running there, for the "attach to which?" question. */
async function listSessions(conn) {
  const fmt = '#{session_name}\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_created}';
  // `-u` for the same reason as in `start`: without it a host with no UTF-8
  // locale sends the tabs back as `_`, and every session is dropped as a
  // line with too few fields — "nothing to attach to" on a host that has some.
  const r = await conn.execResult(`tmux -u list-sessions -F '${fmt}' 2>/dev/null || true`, { timeout: 15000 });
  const out = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const f = line.split('\t');
    if (f.length < 5) continue;
    out.push({
      name: f[0],
      id: f[1],
      windows: Number(f[2]) || 0,
      attached: Number(f[3]) > 0,
      created: Number(f[4]) * 1000 || null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* A control-mode session                                              */
/* ------------------------------------------------------------------ */

/**
 * One attached tmux session, over one connection.
 *
 * Commands and their answers are matched by order rather than by the number
 * in the guard line: tmux answers in the order it was asked, every command
 * produces exactly one block, and a queue is both simpler and harder to get
 * subtly wrong than bookkeeping on an id this side never chose.
 */
class TmuxSession extends EventEmitter {
  constructor({ conn, sessionName, cols = 100, rows = 30, flowControl = true }) {
    super();
    this.conn = conn;
    this.sessionName = sessionName || 'serverlife';
    this.cols = cols;
    this.rows = rows;
    this.flowControl = flowControl;
    /*
     * A beam has no way to give tmux a terminal, so it runs as `tmux -C` over
     * pipes: the same protocol, without the DCS that `-CC` opens with.
     */
    this.plain = conn.transport === 'beam';
    this.parser = new Parser({ plain: this.plain });
    this.pending = [];        // FIFO of {resolve, reject}
    /*
     * Whether tmux's own opening block has gone past, and whether we have
     * asked it anything yet. Control mode begins with an empty block that is
     * nobody's reply; matching it to the first command shifts every answer
     * after it by one, which looks like "it only works the second time".
     */
    this.greeted = false;
    this.sentAny = false;
    this.pty = null;
    this.ready = false;
    this.windows = new Map(); // @id -> { name, layout, tree, activePane }
    this.activeWindow = null;
    this.pendingInput = new Map();  // pane -> buffered keystrokes
    this.flushTimer = null;
  }

  /** Attach, or create if there is nothing to attach to. */
  async start({ attach = true } = {}) {
    const name = shellQuote(this.sessionName);
    // `new-session -A` is attach-or-create in one command, which avoids the
    // race between asking whether a session exists and attaching to it.
    /*
     * `-u`, because without a UTF-8 locale tmux replaces control characters
     * in `-F` output with `_` — tabs included — and every format this file
     * asks for is tab-separated. `@0\tbash\t1\t<layout>` came back as
     * `@0_bash_1_<layout>`, which parses as a window with no layout and so no
     * panes: a session that opens blank. It happens on any host whose shell
     * gets no LANG, which is most plain-OpenSSH hosts reached from an app
     * launched outside a terminal. Found by tests/integration.
     */
    const mode = this.plain ? '-u -C' : '-u -CC';
    const cmd = attach
      ? `tmux ${mode} new-session -A -s ${name} -x ${this.cols} -y ${this.rows}`
      : `tmux ${mode} new-session -s ${name} -x ${this.cols} -y ${this.rows}`;

    this.pty = this.plain
      ? this.conn.spawnCommandPipe({ command: cmd })
      : this.conn.spawnCommandPty({ command: cmd, cols: this.cols, rows: this.rows });

    this.pty.onData((d) => {
      for (const ev of this.parser.feed(d)) this._event(ev);
    });
    this.pty.onExit(({ exitCode }) => {
      this.ready = false;
      this._failAll(new Error('the tmux client exited'));
      this.emit('exit', { exitCode });
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(
        'tmux did not enter control mode — is tmux installed on this host?')), 25000);
      this.once('ready', () => { clearTimeout(t); resolve(); });
      this.once('exit', () => { clearTimeout(t); reject(new Error('the session ended before it opened')); });
    });

    /*
     * Let the opening block go past before asking anything.
     *
     * Commands and their answers are matched by order, and that only works if
     * the first thing in the stream is an answer to something we asked. With
     * a grace period rather than a wait without end: a tmux that does not
     * send one must not leave the session hanging, and the flag check above
     * catches it either way.
     */
    if (!this.greeted) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1500);
        this.once('greeted', () => { clearTimeout(t); resolve(); });
      });
    }

    if (this.flowControl) {
      // Without this a client that falls behind a flood of output simply
      // falls further behind. With it tmux pauses the pane and says so.
      await this.command('refresh-client -f pause-after=10').catch(() => {});
    }
    await this.refreshWindows();
    return this;
  }

  _event(ev) {
    switch (ev.type) {
      case 'probe':
        // Only ever before control mode; the parser guarantees it.
        try { this.pty.write(ev.data); } catch { /* the pty may have exited */ }
        break;
      case 'ready':
        this.ready = true;
        this.emit('ready');
        break;
      case 'result': {
        if (!this.greeted) {
          this.greeted = true;
          this.emit('greeted');
          // tmux's own opening block: it arrived before we asked anything, or
          // it carries the flag that says it is not a reply to a client.
          if (!this.sentAny || ev.flags === '0') break;
        }
        const p = this.pending.shift();
        if (!p) break;
        if (ev.error) p.reject(new Error(ev.lines.join('\n') || 'tmux command failed'));
        else p.resolve(ev.lines);
        break;
      }
      case 'layout': {
        const w = this.windows.get(ev.window) || {};
        w.layout = ev.layout;
        w.tree = ev.tree;
        this.windows.set(ev.window, w);
        this.emit('layout', { window: ev.window, layout: ev.layout, tree: ev.tree });
        break;
      }
      case 'window-add':
        this.windows.set(ev.window, this.windows.get(ev.window) || {});
        this.emit('windows', this.windowList());
        this.refreshWindows().catch(() => {});
        break;
      case 'window-close':
        this.windows.delete(ev.window);
        this.emit('window-close', ev.window);
        this.emit('windows', this.windowList());
        break;
      case 'window-renamed': {
        const w = this.windows.get(ev.window) || {};
        w.name = ev.name;
        this.windows.set(ev.window, w);
        this.emit('windows', this.windowList());
        break;
      }
      case 'active-window':
        this.activeWindow = ev.window;
        this.emit('active-window', ev.window);
        break;
      case 'active-pane': {
        const w = this.windows.get(ev.window) || {};
        w.activePane = ev.pane;
        this.windows.set(ev.window, w);
        break;
      }
      case 'output':
        this.emit('output', ev);
        break;
      case 'pause':
      case 'continue':
        this.emit(ev.type, ev.pane);
        break;
      case 'exit':
        this.ready = false;
        this.emit('ended', ev.reason);
        break;
      default:
        break;
    }
  }

  _failAll(err) {
    const pending = this.pending.splice(0);
    for (const p of pending) p.reject(err);
  }

  /** Run one tmux command and get its block back. */
  command(cmd) {
    if (!this.pty) return Promise.reject(new Error('not attached'));
    return new Promise((resolve, reject) => {
      this.sentAny = true;
      this.pending.push({ resolve, reject });
      try { this.pty.write(cmd + '\n'); } catch (e) { this.pending.pop(); reject(e); }
    });
  }

  /**
   * Keystrokes for a pane.
   *
   * Hex, because `send-keys` otherwise reads its argument as key *names* and
   * a literal `Enter` typed into a file would be sent as a Return. Batched on
   * a short timer: every keystroke is a command round trip, and someone
   * typing quickly should not generate forty of them.
   */
  writePane(paneId, data) {
    const have = this.pendingInput.get(paneId) || '';
    this.pendingInput.set(paneId, have + data);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = new Map(this.pendingInput);
      this.pendingInput.clear();
      for (const [pane, text] of batch) {
        if (!text) continue;
        this.command(`send-keys -t ${pane} -H ${hexKeys(text)}`).catch(() => {});
      }
    }, 6);
  }

  /**
   * The size of this client, which is what decides the size of the panes.
   *
   * tmux sizes a window to its smallest attached client, so this is the only
   * lever: there is no per-pane resize that the server will honour from a
   * control client.
   */
  async resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    if (!this.ready) return;
    try { this.pty.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* the pty may have exited */ }
    await this.command(`refresh-client -C ${Math.max(10, cols)},${Math.max(5, rows)}`).catch(() => {});
  }

  /** What is on a pane's screen now, so a reattached pane is not blank. */
  async capture(paneId, { lines = 2000 } = {}) {
    const out = await this.command(`capture-pane -p -e -J -S -${lines} -t ${paneId}`);
    return out.join('\n');
  }

  async refreshWindows() {
    const fmt = '#{window_id}\t#{window_name}\t#{window_active}\t#{window_layout}\t#{window_zoomed_flag}';
    const lines = await this.command(`list-windows -F '${fmt}'`).catch(() => []);
    for (const line of lines) {
      const f = line.split('\t');
      if (f.length < 4) continue;
      const w = this.windows.get(f[0]) || {};
      w.name = f[1];
      w.active = f[2] === '1';
      w.layout = f[3];
      w.tree = safeLayout(f[3]);
      w.zoomed = f[4] === '1';
      this.windows.set(f[0], w);
      if (w.active) this.activeWindow = f[0];
    }
    this.emit('windows', this.windowList());
    return this.windowList();
  }

  windowList() {
    return [...this.windows.entries()].map(([id, w]) => ({
      id, name: w.name || '', active: !!w.active, layout: w.layout || '',
      tree: w.tree || null, panes: panesInLayout(w.tree), zoomed: !!w.zoomed,
    }));
  }

  /** Leave the session running on the server. */
  async detach() {
    try { await this.command('detach-client'); } catch { /* the server may already be gone */ }
    this.close();
  }

  /** End it for good. */
  async kill() {
    try { await this.command(`kill-session -t ${shellQuote(this.sessionName)}`); } catch { /* the session may already be gone */ }
    this.close();
  }

  close() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this._failAll(new Error('detached'));
    try { this.pty?.kill(); } catch { /* the pty may have exited */ }
    this.pty = null;
    this.ready = false;
  }
}

/** Single-quote for a remote shell, the only way that is always right. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  TmuxSession, Parser, probeTmux, listSessions,
  // Exported for the tests: these are the parts that corrupt data silently.
  unescapeOutput, hexKeys, parseLayout, panesInLayout, probeAnswers, shellQuote, DCS,
};
