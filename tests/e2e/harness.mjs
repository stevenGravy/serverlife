/**
 * A second copy of ServerLife in Electron, driven over the DevTools protocol.
 *
 * For the tests under tests/e2e: what they check is layout — whether a menu
 * fits, whether a panel moves — which only a real renderer can answer. Each
 * run gets a throwaway profile (SERVERLIFE_USER_DATA), so it can run beside
 * a ServerLife already in use, and `start()` refuses to hand the app over
 * until the app itself confirms that is the profile it is using.
 *
 * Input is genuine (`Input.dispatchMouseEvent`), not synthetic DOM events:
 * a real click is a mousedown and then a mouseup, and menus here care.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let s = ''; r.on('data', (d) => { s += d; }); r.on('end', () => res(JSON.parse(s))); })
    .on('error', rej);
});

export async function start() {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'serverlife-e2e-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const env = { ...process.env, SERVERLIFE_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  /*
   * The Electron binary itself, not node_modules/.bin/electron: that is a node
   * wrapper which starts Electron as its own child, so killing it — after an
   * app that asks before quitting with sessions open has ignored the polite
   * signal — left the real app running, orphaned, with its profile in use.
   */
  const electronBin = createRequire(path.join(root, 'package.json'))('electron');
  const proc = spawn(electronBin,
    ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  let ws = null;
  let seq = 0;
  const pageErrors = [];

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    const on = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== id) return;
      ws.off('message', on);
      if (m.error) rej(new Error(`${method}: ${m.error.message}`)); else res(m.result);
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const waitFor = async (expression, what, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if (await evaluate(expression)) return; } catch { /* page still loading */ }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  const click = async (x, y) => {
    const common = { x, y, button: 'left', clickCount: 1, buttons: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
  };

  const clickOn = async (selector) => {
    const c = await evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await click(c.x, c.y);
    return c;
  };

  const escape = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
  };

  const setViewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
  };

  /** Reload, and wait for the Hosts tab to be drawn again. */
  const reload = async () => {
    await send('Page.reload');
    await sleep(500);
    await waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item .name')]
      .some((n) => n.textContent === 'Local shell')`, 'the Hosts tab');
  };

  /** Stop the app and wait for it, since it writes its profile on the way out. */
  const stop = async () => {
    try { ws?.close(); } catch { /* closed */ }
    // Gone is exitCode or signalCode: a process killed by a signal has no exit code.
    const running = () => proc.exitCode === null && proc.signalCode === null;
    if (running()) {
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([gone, sleep(5000)]);
      if (running()) {
        const killed = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGKILL');
        await Promise.race([killed, sleep(3000)]);
      }
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  try {
    for (let i = 0; i < 120 && !ws; i++) {
      try {
        const page = (await getJson(`http://127.0.0.1:${port}/json`))
          .find((p) => p.type === 'page' && !p.url.startsWith('devtools'));
        if (page) {
          const sock = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
          ws = sock;
        }
      } catch { /* not listening yet */ }
      if (!ws) await sleep(250);
    }
    if (!ws) throw new Error('The app never opened a window');

    // The page's own errors, for when something does not appear.
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
    await send('Runtime.enable');
    await waitFor('!!window.api', 'the preload bridge');

    // Before anything is written: is this really the throwaway profile?
    const info = await evaluate('window.api.app.info()');
    assert.equal(realpathSync(info.userData), realpathSync(profile),
      `the app is using ${info.userData}, not the test profile — stopping before it is changed`);

    // No first-run tour over the window.
    await evaluate('window.api.settings.set({ tourSeenVersion: 4 })');
  } catch (e) {
    if (log) console.error(log.split('\n').slice(-30).join('\n'));
    await stop();
    throw e;
  }

  /*
   * The app's own process tree, so a test counting what it runs (ssh, tsh)
   * counts this copy's and never those of a ServerLife someone is using.
   */
  const descendants = () => {
    let rows = [];
    try {
      rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        .split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
        .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
    } catch { return []; }
    const mine = new Set([proc.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; }
    }
    return rows.filter((r) => r.pid !== proc.pid && mine.has(r.pid));
  };

  return { send, evaluate, waitFor, click, clickOn, escape, setViewport, reload, stop, pageErrors, log: () => log, pid: proc.pid, descendants };
}

/** A tiny runner: named checks, a summary, and the exit code. */
export function checks() {
  const results = [];
  return {
    check(name, fn) {
      try { fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
    },
    fail(name, why) { results.push(['FAIL', name, why]); },
    finish() {
      for (const [mark, name, why] of results) console.log(`${mark === 'ok' ? '✔' : '✖'} ${name}${why ? ' — ' + why : ''}`);
      const failed = results.filter(([mark]) => mark !== 'ok').length;
      console.log(`\n${results.length - failed} passed, ${failed} failed`);
      return failed ? 1 : 0;
    },
  };
}

/**
 * Run a tsh the way the app runs a *chosen* one: with client-tools managed
 * updates off, so a build named `tsh` answers as itself (see tshEnv).
 */
export function execChosenTsh(bin, args) {
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TELEPORT_TOOLS_VERSION: process.env.TELEPORT_TOOLS_VERSION ?? 'off' },
    });
  } catch (e) {
    const err = new Error(String(e.stderr || e.message));
    err.stdout = String(e.stdout || '');
    throw err;
  }
}
