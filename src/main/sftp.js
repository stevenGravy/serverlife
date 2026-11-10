'use strict';
/**
 * Minimal SFTP v3 client that speaks the protocol directly over a duplex pipe.
 *
 * The transport is `ssh -S <controlpath> <host> -s sftp`, so the connection
 * rides the existing ControlMaster: no second authentication, no extra
 * Teleport session, works the same for tsh-proxied and plain hosts.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const T = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6,
  LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10, OPENDIR: 11, READDIR: 12,
  REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18,
  READLINK: 19, SYMLINK: 20,
  STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105,
};

const F = { READ: 0x1, WRITE: 0x2, APPEND: 0x4, CREAT: 0x8, TRUNC: 0x10, EXCL: 0x20 };

const A = { SIZE: 0x1, UIDGID: 0x2, PERMISSIONS: 0x4, ACMODTIME: 0x8, EXTENDED: 0x80000000 };

const STATUS_TEXT = {
  0: 'OK', 1: 'End of file', 2: 'No such file', 3: 'Permission denied',
  4: 'Failure', 5: 'Bad message', 6: 'No connection', 7: 'Connection lost',
  8: 'Operation unsupported',
};

/** Grow-as-needed big-endian writer. */
class W {
  constructor() { this.chunks = []; }
  u8(v) { const b = Buffer.alloc(1); b[0] = v; this.chunks.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); this.chunks.push(b); return this; }
  u64(v) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(v))), 0);
    this.chunks.push(b); return this;
  }
  str(s) {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
    this.u32(b.length); this.chunks.push(b); return this;
  }
  raw(b) { this.chunks.push(b); return this; }
  done() { return Buffer.concat(this.chunks); }
}

/** Big-endian reader over one packet body. */
class R {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() { return this.b[this.o++]; }
  u32() { const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64BE(this.o); this.o += 8; return Number(v); }
  str() { const n = this.u32(); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  text() { return this.str().toString('utf8'); }
  rest() { return this.b.subarray(this.o); }
  get left() { return this.b.length - this.o; }
}

function readAttrs(r) {
  const flags = r.u32();
  const a = { flags };
  if (flags & A.SIZE) a.size = r.u64();
  if (flags & A.UIDGID) { a.uid = r.u32(); a.gid = r.u32(); }
  if (flags & A.PERMISSIONS) a.mode = r.u32();
  if (flags & A.ACMODTIME) { a.atime = r.u32(); a.mtime = r.u32(); }
  if (flags & A.EXTENDED) {
    const n = r.u32();
    for (let i = 0; i < n; i++) { r.str(); r.str(); }
  }
  return a;
}

function writeAttrs(w, attrs) {
  if (!attrs) return w.u32(0);
  let flags = 0;
  if (attrs.size !== undefined) flags |= A.SIZE;
  if (attrs.uid !== undefined && attrs.gid !== undefined) flags |= A.UIDGID;
  if (attrs.mode !== undefined) flags |= A.PERMISSIONS;
  if (attrs.atime !== undefined && attrs.mtime !== undefined) flags |= A.ACMODTIME;
  w.u32(flags);
  if (flags & A.SIZE) w.u64(attrs.size);
  if (flags & A.UIDGID) { w.u32(attrs.uid); w.u32(attrs.gid); }
  if (flags & A.PERMISSIONS) w.u32(attrs.mode);
  if (flags & A.ACMODTIME) { w.u32(attrs.atime); w.u32(attrs.mtime); }
  return w;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function entryType(mode) {
  if (mode === undefined) return 'file';
  switch (mode & S_IFMT) {
    case S_IFDIR: return 'directory';
    case S_IFLNK: return 'symlink';
    case S_IFREG: return 'file';
    default: return 'special';
  }
}

function modeString(mode) {
  if (mode === undefined) return '?---------';
  const t = { [S_IFDIR]: 'd', [S_IFLNK]: 'l', [S_IFREG]: '-' }[mode & S_IFMT] || '?';
  const bits = 'rwxrwxrwx';
  let s = t;
  for (let i = 0; i < 9; i++) s += (mode & (1 << (8 - i))) ? bits[i] : '-';
  return s;
}

/**
 * Owner, group and link count out of an SFTP `longname`.
 *
 * `longname` is whatever the server's own `ls -l` would print, which is not a
 * specified format — so this reads it only when it looks like one: a mode
 * string first, then a link count, then two names. Anything else gives null
 * and the caller falls back to the numeric uid/gid.
 */
function parseLongname(longname) {
  const parts = String(longname || '').trim().split(/\s+/);
  if (parts.length < 6) return null;
  if (!/^[-dlbcps?][-rwxSsTt]{9}[.+@]?$/.test(parts[0])) return null;
  if (!/^\d+$/.test(parts[1])) return null;
  return { links: Number(parts[1]), owner: parts[2], group: parts[3] };
}

class SftpError extends Error {
  constructor(code, msg, path) {
    super(`${msg || STATUS_TEXT[code] || 'SFTP error ' + code}${path ? ': ' + path : ''}`);
    this.code = code;
    this.path = path;
    this.name = 'SftpError';
  }
}

class SftpClient extends EventEmitter {
  /**
   * @param transportArgs argv for the transport process
   * @param opts.command  executable to run (default `ssh`); `tsh` is used for
   *        nodes with per-session MFA, where the SFTP stream comes from
   *        exec'ing the remote sftp-server over a tsh session instead of
   *        requesting the subsystem.
   */
  constructor(transportArgs, opts = {}) {
    super();
    this.sshArgs = transportArgs;
    this.command = opts.command || require('./sshbin').findSsh();
    this.opts = opts;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.reqid = 0;
    this.pending = new Map();
    this.ready = false;
    this.version = 0;
    this.extensions = {};
    this.closed = false;
    // OpenSSH caps a single read/write payload; stay under it.
    this.maxRead = 32 * 1024;
    this.maxWrite = 32 * 1024;
  }

  connect() {
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };

      this.proc = spawn(this.command, this.sshArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/opt/homebrew/bin' },
      });
      let stderr = '';
      this.proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
        this.emit('stderr', d.toString());
      });
      this.proc.on('error', fail);
      this.proc.on('exit', (code) => {
        this.closed = true;
        const err = new Error(`sftp transport exited (${code})${stderr ? ': ' + stderr.trim() : ''}`);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        this.emit('close', code, stderr);
        fail(err);
      });
      this.proc.stdout.on('data', (d) => this._onData(d));

      this.once('_ready', () => { if (!settled) { settled = true; resolve(this); } });

      // INIT v3
      const body = new W().u8(T.INIT).u32(3).done();
      this._writePacket(body);

      const to = setTimeout(() => fail(new Error('SFTP handshake timed out')), this.opts.timeout || 30000);
      this.once('_ready', () => clearTimeout(to));
    });
    return this._connecting;
  }

  _writePacket(body) {
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(body.length, 0);
    if (this.proc && this.proc.stdin.writable) {
      this.proc.stdin.write(hdr);
      this.proc.stdin.write(body);
    }
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (len > 0x1000000) { this.destroy(new Error('SFTP packet too large')); return; }
      if (this.buf.length < 4 + len) return;
      const pkt = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try { this._handle(pkt); } catch (e) { this.emit('error', e); }
    }
  }

  _handle(pkt) {
    const r = new R(pkt);
    const type = r.u8();
    if (type === T.VERSION) {
      this.version = r.u32();
      while (r.left > 8) {
        const name = r.text();
        const data = r.text();
        this.extensions[name] = data;
      }
      this.ready = true;
      this.emit('_ready');
      return;
    }
    const id = r.u32();
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);

    switch (type) {
      case T.STATUS: {
        const code = r.u32();
        const msg = r.left >= 4 ? r.text() : '';
        if (code === 0) p.resolve({ ok: true });
        else if (code === 1) p.resolve({ eof: true });
        else p.reject(new SftpError(code, msg, p.path));
        break;
      }
      case T.HANDLE: p.resolve({ handle: r.str() }); break;
      case T.DATA: p.resolve({ data: r.str() }); break;
      case T.NAME: {
        const count = r.u32();
        const items = [];
        for (let i = 0; i < count; i++) {
          const filename = r.text();
          const longname = r.text();
          const attrs = readAttrs(r);
          items.push({ filename, longname, attrs });
        }
        p.resolve({ names: items });
        break;
      }
      case T.ATTRS: p.resolve({ attrs: readAttrs(r) }); break;
      default: p.reject(new Error('Unexpected SFTP packet type ' + type));
    }
  }

  _request(type, build, path) {
    if (this.closed) return Promise.reject(new Error('SFTP connection closed'));
    const id = (this.reqid = (this.reqid + 1) >>> 0);
    const w = new W().u8(type).u32(id);
    build(w);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, path });
      this._writePacket(w.done());
    });
  }

  async realpath(p) {
    const res = await this._request(T.REALPATH, (w) => w.str(p), p);
    return res.names[0].filename;
  }

  async stat(p) {
    const res = await this._request(T.STAT, (w) => w.str(p), p);
    return res.attrs;
  }

  async lstat(p) {
    const res = await this._request(T.LSTAT, (w) => w.str(p), p);
    return res.attrs;
  }

  async readlink(p) {
    const res = await this._request(T.READLINK, (w) => w.str(p), p);
    return res.names[0].filename;
  }

  /** Full directory listing, following READDIR until EOF. */
  async list(dir) {
    const { handle } = await this._request(T.OPENDIR, (w) => w.str(dir), dir);
    const out = [];
    try {
      for (;;) {
        const res = await this._request(T.READDIR, (w) => w.str(handle), dir);
        if (res.eof || !res.names) break;
        for (const n of res.names) {
          if (n.filename === '.' || n.filename === '..') continue;
          out.push(this._toEntry(n, dir));
        }
      }
    } finally {
      await this._request(T.CLOSE, (w) => w.str(handle)).catch(() => {});
    }
    return out;
  }

  _toEntry(n, dir) {
    const a = n.attrs || {};
    const long = parseLongname(n.longname);
    return {
      name: n.filename,
      path: dir.endsWith('/') ? dir + n.filename : dir + '/' + n.filename,
      type: entryType(a.mode),
      size: a.size ?? 0,
      mode: a.mode,
      modeString: modeString(a.mode),
      mtime: a.mtime ? a.mtime * 1000 : null,
      atime: a.atime ? a.atime * 1000 : null,
      uid: a.uid, gid: a.gid,
      // The names, not just the numbers. SFTP sends uid/gid as integers, and
      // the account they belong to lives on the server, so nothing here could
      // translate them — but the protocol also sends the `ls -l` line the
      // server itself produced, which has already done it.
      owner: long?.owner || null,
      group: long?.group || null,
      links: long?.links ?? null,
      longname: n.longname,
    };
  }

  /** Resolve a symlink's target type so the UI can navigate into link-to-dir. */
  async resolveEntry(entry) {
    if (entry.type !== 'symlink') return entry;
    try {
      const a = await this.stat(entry.path);
      return { ...entry, targetType: entryType(a.mode), size: a.size ?? entry.size };
    } catch { return { ...entry, targetType: 'broken' }; }
  }

  mkdir(p) { return this._request(T.MKDIR, (w) => { w.str(p); writeAttrs(w, null); }, p); }
  rmdir(p) { return this._request(T.RMDIR, (w) => w.str(p), p); }
  remove(p) { return this._request(T.REMOVE, (w) => w.str(p), p); }
  rename(from, to) {
    if (this.extensions['posix-rename@openssh.com']) {
      return this._request(200 /* EXTENDED */, (w) => {
        w.str('posix-rename@openssh.com'); w.str(from); w.str(to);
      }, from);
    }
    return this._request(T.RENAME, (w) => { w.str(from); w.str(to); }, from);
  }
  chmod(p, mode) { return this._request(T.SETSTAT, (w) => { w.str(p); writeAttrs(w, { mode }); }, p); }

  /**
   * Set access and modification times, in whole seconds.
   *
   * What makes an upload comparable to its source afterwards: without it a
   * freshly uploaded file has "now" as its mtime, so any sync that compares
   * timestamps decides it has changed again and sends it a second time, and a
   * third, forever.
   */
  utimes(p, atime, mtime) {
    const a = Math.floor(Number(atime) || 0);
    const m = Math.floor(Number(mtime) || 0);
    return this._request(T.SETSTAT, (w) => { w.str(p); writeAttrs(w, { atime: a, mtime: m }); }, p);
  }

  open(p, flags, attrs) {
    return this._request(T.OPEN, (w) => { w.str(p); w.u32(flags); writeAttrs(w, attrs); }, p)
      .then((r) => r.handle);
  }
  close(handle) { return this._request(T.CLOSE, (w) => w.str(handle)); }

  async readChunk(handle, offset, length) {
    const res = await this._request(T.READ, (w) => { w.str(handle); w.u64(offset); w.u32(length); });
    if (res.eof) return null;
    return res.data;
  }

  writeChunk(handle, offset, data) {
    return this._request(T.WRITE, (w) => { w.str(handle); w.u64(offset); w.str(data); });
  }

  /** Recursively delete a directory tree. */
  async removeTree(p, onProgress) {
    const entries = await this.list(p);
    for (const e of entries) {
      if (e.type === 'directory') await this.removeTree(e.path, onProgress);
      else await this.remove(e.path);
      if (onProgress) onProgress(e.path);
    }
    await this.rmdir(p);
  }

  destroy(err) {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(err || new Error('SFTP closed'));
    this.pending.clear();
    if (this.proc) { try { this.proc.kill(); } catch { /* the process may already have exited */ } }
  }
}

module.exports = { SftpClient, SftpError, F, A, entryType, modeString, T };
