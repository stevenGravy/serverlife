'use strict';
/**
 * A VNC screen, carried to the renderer.
 *
 * The viewer is noVNC, which speaks RFB over a WebSocket because a web page
 * cannot open a TCP socket — and the renderer here is a web page, deliberately
 * so: context isolation and no node integration are what keep a terminal full
 * of somebody else's output from being able to reach the filesystem. Rather
 * than weaken that for one feature, this is the smallest possible websockify:
 * a WebSocket server on the loopback interface that turns one connection into
 * one TCP socket and copies bytes.
 *
 * Two things keep it honest. It binds to 127.0.0.1 on a port the operating
 * system picks, so nothing off this machine can reach it. And the target is
 * never in the URL — the renderer asks main to prepare a session, main
 * remembers where that session goes and hands back an unguessable token, so
 * the page cannot point the bridge at an address of its own choosing. A page
 * that could would be an open TCP proxy running as the user.
 */

const net = require('net');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

class VncBridge {
  constructor() {
    this.wss = null;
    this.port = 0;
    /* token -> { host, port, used } */
    this.sessions = new Map();
  }

  /**
   * Prepare a session and return the URL the viewer should open. The server
   * starts on the first call and stays up while anything is using it.
   */
  async prepare({ host, port = 5900 }) {
    if (!host) throw new Error('No host given');
    await this._listen();
    const token = crypto.randomBytes(16).toString('hex');
    this.sessions.set(token, { host, port: Number(port) || 5900 });
    return { url: `ws://127.0.0.1:${this.port}/${token}`, token };
  }

  /** Forget a session. Any socket still on it is dropped. */
  release(token) {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    try { s.socket?.destroy(); } catch { /* already closed */ }
    try { s.ws?.close(); } catch { /* already closed */ }
    if (!this.sessions.size) this._stop();
  }

  releaseAll() { for (const t of [...this.sessions.keys()]) this.release(t); }

  _listen() {
    if (this.wss) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
        this.port = wss.address().port;
        resolve();
      });
      wss.on('error', reject);
      wss.on('connection', (ws, req) => this._join(ws, req));
      this.wss = wss;
    });
  }

  _stop() {
    const wss = this.wss;
    this.wss = null;
    this.port = 0;
    try { wss?.close(); } catch { /* already closed */ }
  }

  _join(ws, req) {
    const token = String(req.url || '').replace(/^\//, '').split('?')[0];
    const session = this.sessions.get(token);
    // An unknown token is the whole of the access control: no target, no
    // socket, and nothing said about why.
    if (!session) { try { ws.close(); } catch { /* already closed */ } return; }

    const socket = net.connect({ host: session.host, port: session.port });
    socket.setNoDelay(true);
    session.socket = socket;
    session.ws = ws;

    socket.on('data', (d) => {
      // Back-pressure matters here: a framebuffer update is megabytes and the
      // renderer is slower than the server on a fast LAN.
      if (ws.readyState === ws.OPEN) {
        ws.send(d, { binary: true });
        if (ws.bufferedAmount > 4 * 1024 * 1024) socket.pause();
      }
    });
    const drain = setInterval(() => {
      if (socket.isPaused() && ws.bufferedAmount < 1024 * 1024) socket.resume();
    }, 50);

    ws.on('message', (d) => { try { socket.write(d); } catch { /* the VNC socket may have closed under us */ } });
    const end = () => {
      clearInterval(drain);
      try { socket.destroy(); } catch { /* already closed */ }
      try { ws.close(); } catch { /* already closed */ }
    };
    socket.on('error', end);
    socket.on('close', end);
    ws.on('close', end);
    ws.on('error', end);
  }
}

module.exports = { VncBridge };
