'use strict';
/**
 * A local control socket, so another program can drive the app.
 *
 * The point of it is setup work: "open these six servers", "load the layout I
 * use for an upgrade", "which clusters am I logged into". Doing that by hand is
 * repetitive, and an agent — Claude Code, a script, a hotkey — can do it if
 * there is something to talk to. The MCP server in `mcp/` is one such client;
 * the protocol here is deliberately plainer than MCP so anything can use it.
 *
 * What it is not: a way for anything on the machine to open SSH sessions
 * unnoticed. So:
 *
 *   - it is off unless the user turns it on;
 *   - the socket lives in the user's own runtime directory, mode 0600, and on
 *     Windows is a named pipe under their account;
 *   - every connection must present a token that is only readable by them;
 *   - what it can do is a fixed list of verbs, none of which runs arbitrary
 *     commands — running a *saved macro* is as far as it goes, because a macro
 *     is something the user wrote and can read;
 *   - every accepted call is logged where the user can see it.
 *
 * The transport is newline-delimited JSON: one request object per line, one
 * response object per line. No framing, no versions to negotiate.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const WINDOWS = process.platform === 'win32';
const MAX_LINE = 1 << 20;        // a request bigger than 1 MB is a mistake

class ControlServer {
  /**
   * @param {object} opts
   * @param {string} opts.dir        where the token file lives (the app's config dir)
   * @param {function} opts.handle   async (verb, params, ctx) => result
   * @param {function} opts.onLog    (entry) => void, for the connection log
   */
  constructor({ dir, handle, onLog }) {
    this.dir = dir;
    this.handle = handle;
    this.onLog = onLog || (() => {});
    this.server = null;
    this.token = null;
    this.socketPath = null;
    this.clients = new Set();
  }

  get running() { return !!this.server; }

  /** Where the socket lives. A path on unix, a named pipe on Windows. */
  static socketPathFor(dir) {
    if (WINDOWS) return '\\\\.\\pipe\\serverlife-' + hash(dir + os.userInfo().username);
    // Not in the config dir: a socket under a synced or backed-up directory is
    // a recipe for confusion, and macOS prunes TMPDIR for us.
    return path.join(os.tmpdir(), `serverlife-${hash(dir + String(process.getuid?.() ?? ''))}.sock`);
  }

  tokenFile() { return path.join(this.dir, 'control-token'); }

  /** Read the token, creating one on first use. */
  ensureToken() {
    const file = this.tokenFile();
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length >= 32) { this.token = existing; return this.token; }
    } catch { /* no token yet: a new one is written */ }
    this.token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, this.token + '\n', { mode: 0o600 });
    return this.token;
  }

  /** Forget the token, so anything holding it loses access. */
  rotateToken() {
    try { fs.rmSync(this.tokenFile(), { force: true }); } catch { /* already gone */ }
    this.token = null;
    return this.ensureToken();
  }

  async start() {
    if (this.server) return this.info();
    this.ensureToken();
    this.socketPath = ControlServer.socketPathFor(this.dir);

    // A socket left behind by a crash would block binding; nothing else owns
    // this name, so removing it is safe.
    if (!WINDOWS) { try { fs.rmSync(this.socketPath, { force: true }); } catch { /* already gone */ } }

    await new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._onConnection(sock));
      this.server.once('error', (e) => { this.server = null; reject(e); });
      this.server.listen(this.socketPath, () => {
        if (!WINDOWS) { try { fs.chmodSync(this.socketPath, 0o600); } catch { /* the socket keeps its default mode */ } }
        resolve();
      });
    });

    this.onLog({ kind: 'start', text: `Control socket listening on ${this.socketPath}` });
    return this.info();
  }

  async stop() {
    for (const c of this.clients) { try { c.destroy(); } catch { /* the client may already have hung up */ } }
    this.clients.clear();
    if (this.server) {
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
    if (!WINDOWS && this.socketPath) { try { fs.rmSync(this.socketPath, { force: true }); } catch { /* already gone */ } }
    this.onLog({ kind: 'stop', text: 'Control socket stopped' });
  }

  info() {
    return {
      running: this.running,
      socketPath: this.socketPath || ControlServer.socketPathFor(this.dir),
      tokenFile: this.tokenFile(),
      token: this.token,
      clients: this.clients.size,
    };
  }

  _onConnection(sock) {
    this.clients.add(sock);
    let buf = '';
    let authed = false;

    const reply = (obj) => {
      try { sock.write(JSON.stringify(obj) + '\n'); } catch { /* the client may already have hung up */ }
    };

    sock.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE) {
        reply({ ok: false, error: 'request too large' });
        sock.destroy();
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;

        let req;
        try { req = JSON.parse(line); } catch {
          reply({ ok: false, error: 'malformed JSON' });
          continue;
        }

        // The first line has to authenticate; a wrong token ends the
        // conversation rather than inviting another guess.
        if (!authed) {
          const given = String(req.token || '');
          if (!this.token || !safeEqual(given, this.token)) {
            this.onLog({ kind: 'deny', text: 'Control connection rejected: bad token' });
            reply({ ok: false, error: 'unauthorized' });
            sock.destroy();
            return;
          }
          authed = true;
          if (!req.verb) { reply({ ok: true, id: req.id ?? null, data: { hello: true } }); continue; }
        }

        const verb = String(req.verb || '');
        try {
          const data = await this.handle(verb, req.params || {}, { client: req.client || 'unknown' });
          reply({ ok: true, id: req.id ?? null, data });
        } catch (e) {
          reply({ ok: false, id: req.id ?? null, error: e && e.message ? e.message : String(e) });
        }
      }
    });

    sock.on('error', () => {});
    sock.on('close', () => this.clients.delete(sock));
  }
}

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

module.exports = { ControlServer };
