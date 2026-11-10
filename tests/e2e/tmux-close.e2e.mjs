#!/usr/bin/env node
/**
 * Closing a pane in tmux mode closes it in tmux, not just the view of it.
 *
 * On a real node with tmux (SERVERLIFE_E2E_HOST, default the first node of a
 * logged-in cluster): open a tmux session of its own through *Open in tmux…*,
 * split it from the server side so there are two panes, close one with its ✕
 * and check tmux has one left — then close the last, answer the "ends the
 * session" question, and check the session is gone. tmux itself is asked each
 * time, over `tsh ssh`, rather than trusting the app's view of it. The session
 * is named sl-e2e-… and killed afterwards whatever happened.
 *
 *   SERVERLIFE_E2E_HOST=bms-app-service SERVERLIFE_E2E_LOGIN=root node tests/e2e/tmux-close.e2e.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const HOST = process.env.SERVERLIFE_E2E_HOST || 'bms-app-service';
const LOGIN = process.env.SERVERLIFE_E2E_LOGIN || 'root';
const SESSION = `sl-e2e-${Date.now().toString(36)}`;
let app;

const onHost = (cmd) => {
  try { return execFileSync('tsh', ['ssh', `${LOGIN}@${HOST}`, cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim(); }
  catch (e) { return `ERR ${String(e.stderr || e.message).trim().split('\n').pop()}`; }
};
/** Live stats commands this test's app is running (the `SLMON` script) — never another copy's. */
const statsProcesses = () => app.descendants().filter((r) => r.command.includes('SLMON') && /\bssh\b|\btsh\b/.test(r.command)).length;
const bars = () => app.evaluate(`[...document.querySelectorAll('.pane')].filter((p) => p.offsetParent && !p.classList.contains('ai-pane'))
  .map((p) => { const b = p.querySelector('.pane-stats'); return b ? (b.dataset.status || 'shown') : null; })`);
const tmuxPanes = () => {
  const out = onHost(`tmux list-panes -s -t ${SESSION} -F '#{pane_id}' 2>&1`);
  return out.startsWith('%') ? out.split('\n').length : 0;
};
const visiblePanes = () => app.evaluate(`[...document.querySelectorAll('.pane')].filter((p) => p.offsetParent && !p.classList.contains('ai-pane')).length`);

async function clickCloseOn(index) {
  const r = await app.evaluate(`(() => {
    const panes = [...document.querySelectorAll('.pane')].filter((p) => p.offsetParent && !p.classList.contains('ai-pane'));
    const b = panes[${index}]?.querySelector('.pclose');
    if (!b) return null;
    const x = b.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 };
  })()`);
  if (!r) return false;
  await app.click(r.x, r.y);
  return true;
}
/** Answer whatever "close this?" question appears with its confirming button. */
async function confirmIfAsked(label) {
  await sleep(700);
  return app.evaluate(`(() => {
    const m = [...document.querySelectorAll('.modal')].pop();
    if (!m) return null;
    const b = [...m.querySelectorAll('button')].find((x) => ${JSON.stringify(label)} ? x.textContent.trim() === ${JSON.stringify(label)} : x.classList.contains('primary-btn') || x.classList.contains('danger-btn'));
    const title = m.querySelector('h2')?.textContent || '';
    if (b) b.click();
    return title;
  })()`);
}

try {
  if (!/^tmux /.test(onHost('tmux -V'))) {
    console.log(`  skipped: no tmux on ${HOST}`);
    process.exit(0);
  }
  app = await start();
  await app.reload();
  await app.setViewport(1400, 900);
  await app.waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item .name')].some((n) => n.textContent.trim() === ${JSON.stringify(HOST)})`, HOST, 60000);

  // Open in tmux…, on a session of our own.
  const r = await app.evaluate(`(() => { const row = [...document.querySelectorAll('#sb-panel-hosts .sb-item')].find((x) => x.querySelector('.name')?.textContent.trim() === ${JSON.stringify(HOST)});
    const b = row.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
  await app.waitFor(`!!document.querySelector('#ctxmenu-root > .ctxmenu')`, 'the host menu', 5000);
  assert.ok(await app.evaluate(`(() => { const b = [...document.querySelectorAll('#ctxmenu-root .ctxmenu button')].find((x) => x.textContent.includes('Open in tmux'));
    if (!b) return false; b.click(); return true; })()`), 'no Open in tmux… item');
  await app.waitFor(`[...document.querySelectorAll('.modal .field-label')].some((l) => l.textContent === 'Name')`, 'the tmux dialog', 60000);
  await app.evaluate(`(() => { const m = [...document.querySelectorAll('.modal')].pop();
    const sel = m.querySelector('select'); if (sel) { sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    const name = [...m.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === 'Name').querySelector('input');
    name.value = ${JSON.stringify(SESSION)}; name.dispatchEvent(new Event('input', { bubbles: true }));
    [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Attach').click(); })()`);
  // tmux has the session, and the app shows its one pane.
  for (let i = 0; i < 40 && tmuxPanes() < 1; i++) await sleep(1500);
  await sleep(3000);
  t.check(`the tmux session ${SESSION} is running`, () => assert.equal(tmuxPanes(), 1));

  // A second pane, made on the server, arrives in the app.
  onHost(`tmux split-window -h -t ${SESSION}`);
  await app.waitFor(`[...document.querySelectorAll('.pane')].filter((p) => p.offsetParent && !p.classList.contains('ai-pane')).length >= 2`, 'the split to arrive', 20000);
  console.log(`  panes: tmux ${tmuxPanes()}, app ${await visiblePanes()}`);
  // Live stats under each tmux pane, from one command for the host.
  let shown = [];
  for (let i = 0; i < 15; i++) { await sleep(1000); shown = await bars(); if (shown.every((b) => b === 'running')) break; }
  const procs = statsProcesses();
  console.log(`  stats bars: ${JSON.stringify(shown)}; stats commands running: ${procs}`);
  t.check('each tmux pane has the live stats bar, running', () => assert.deepEqual(shown, ['running', 'running']));
  t.check('two panes on one host share one stats command', () => assert.equal(procs, 1));

  // Close one by hand: tmux loses it too.
  assert.ok(await clickCloseOn(1), 'no ✕ on the second pane');
  const asked1 = await confirmIfAsked();
  if (asked1) console.log(`  asked: ${asked1}`);
  for (let i = 0; i < 20 && tmuxPanes() > 1; i++) await sleep(1000);
  await sleep(1500);
  const afterOne = { tmux: tmuxPanes(), app: await visiblePanes() };
  console.log(`  after closing one: ${JSON.stringify(afterOne)}`);
  t.check('closing a pane closes it in tmux, and the app follows', () => assert.deepEqual(afterOne, { tmux: 1, app: 1 }));

  // Close the last: it asks, then the session ends.
  assert.ok(await clickCloseOn(0), 'no ✕ on the last pane');
  let asked2 = await confirmIfAsked();
  if (asked2 && asked2 !== 'Close the last pane?') asked2 = await confirmIfAsked('Close it and end the session') || asked2;
  console.log(`  asked: ${asked2}`);
  t.check('closing the last pane asks first, since it ends the session', () => assert.match(String(asked2), /last pane/));
  for (let i = 0; i < 20 && !/no server|can't find|ERR/.test(onHost(`tmux has-session -t ${SESSION} 2>&1 && echo alive`)); i++) await sleep(1000);
  const gone = onHost(`tmux has-session -t ${SESSION} 2>&1 && echo alive`);
  t.check('and then the session is gone from tmux', () => assert.doesNotMatch(gone, /alive/));
  await sleep(2000);
  t.check('with no pane left on the host, its stats command has stopped', () => assert.equal(statsProcesses(), 0));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
  onHost(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
}

process.exit(t.finish());
