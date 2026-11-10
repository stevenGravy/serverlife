/**
 * Drive the running app's renderer over the Chrome DevTools Protocol.
 *
 * Useful because synthetic DOM events do not reproduce real input: a hardware
 * click fires mousedown before click, which has caught at least one bug here.
 * `click` below dispatches genuine trusted input events.
 *
 *   make run-debug                              # start the app with CDP open
 *   node tools/cdp.mjs eval "<expression>"
 *   node tools/cdp.mjs click <x> <y> [left|right]
 *   node tools/cdp.mjs errors [seconds]
 */

import WebSocket from 'ws';
import http from 'http';

const PORT = process.env.CDP_PORT || 9222;

const pages = () => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}/json`, (r) => {
    let s = ''; r.on('data', (d) => s += d); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej);
});

async function connect() {
  const list = await pages();
  const page = list.find((p) => p.type === 'page' && p.title === 'ServerLife') || list.find((p) => p.type === 'page');
  if (!page) throw new Error('No ServerLife page. Start it with: make run-debug');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params) => new Promise((res) => {
    const myId = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id === myId) { ws.off('message', on); res(m); } };
    ws.on('message', on);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');
  return { ws, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [cmd, ...args] = process.argv.slice(2);
const { ws, send } = await connect();

if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', {
    expression: args.join(' '), awaitPromise: true, returnByValue: true,
  });
  const ex = r.result?.exceptionDetails;
  console.log(ex
    ? 'EXCEPTION: ' + (ex.exception?.description || ex.text)
    : JSON.stringify(r.result?.result?.value, null, 1));
} else if (cmd === 'click') {
  const [x, y, button = 'left'] = args;
  const common = { x: +x, y: +y, button, clickCount: 1, buttons: button === 'right' ? 2 : 1 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
  console.log(`${button}-clicked at ${x},${y}`);
} else if (cmd === 'errors') {
  const seconds = Number(args[0] || 5);
  const found = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.method === 'Runtime.exceptionThrown') {
      found.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      found.push('console.error: ' + m.params.args.map((a) => a.description || a.value).join(' '));
    }
  });
  console.log(`listening ${seconds}s…`);
  await sleep(seconds * 1000);
  console.log(found.length ? found.join('\n') : '(no errors)');
} else {
  console.log('usage: cdp.mjs eval <expr> | click <x> <y> [left|right] | errors [seconds]');
}

ws.close();
process.exit(0);
