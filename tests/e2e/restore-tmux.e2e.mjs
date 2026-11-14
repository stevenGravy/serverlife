#!/usr/bin/env node
/**
 * Reopening a saved layout puts tmux sessions and Kubernetes clusters back.
 *
 * Opens a tmux session on this machine (its own name, killed at the end) and,
 * when a logged-in cluster is listed, that cluster's browser; then reloads
 * with "Always restore" on. The tmux tab must come back attached to the same
 * session — not as a plain shell — and the cluster's browser as a browser.
 * Needs tmux here; skips on Windows or without it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const session = `sl-e2e-${process.pid}`;
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
if (!hasTmux) { console.log('  skipped: no tmux on this machine'); process.exit(0); }

const app = await start();
const tabs = () => app.evaluate(`[...document.querySelectorAll('.tab')].map((x) => x.textContent.trim())`);
const tmuxPanes = () => app.evaluate(`document.querySelectorAll('.ptmux-ctl:not(.hidden)').length`);
try {
  await app.setViewport(1440, 960);
  await app.evaluate('window.api.settings.set({ autoRestoreWorkspace: true })');
  await app.waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item .name')].some((n) => n.textContent === 'Local shell')`, 'the Hosts tab', 30000);

  // tmux on this machine, from the Local shell row's menu.
  await app.evaluate(`(() => { const r = [...document.querySelectorAll('#sb-panel-hosts .sb-item')].find((x) => x.querySelector('.name')?.textContent === 'Local shell');
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 })); })()`);
  await app.waitFor(`[...document.querySelectorAll('.ctxmenu button')].some((x) => x.textContent.includes('Open in tmux'))`, 'the tmux menu item');
  await app.evaluate(`[...document.querySelectorAll('.ctxmenu button')].find((x) => x.textContent.includes('Open in tmux')).click()`);
  await app.waitFor(`[...document.querySelectorAll('.modal select option')].length > 0`, 'the tmux dialog', 20000);
  await app.evaluate(`(() => { const m = document.querySelector('.modal'); const s = m.querySelector('select'); s.value = ''; s.dispatchEvent(new Event('change'));
    const i = m.querySelector('input[placeholder="serverlife"]'); i.value = ${JSON.stringify(session)}; i.dispatchEvent(new Event('input'));
    [...m.querySelectorAll('button')].find((b) => b.textContent === 'Attach').click(); })()`);
  await app.waitFor(`[...document.querySelectorAll('.tab')].some((x) => /· this machine/.test(x.textContent) && !/tmux · /.test(x.textContent))`, 'the tmux tab', 30000);

  // A cluster's browser, if a logged-in one is listed.
  await app.waitFor(`document.querySelectorAll('#sb-panel-hosts .kube-ico').length > 0`, 'Kubernetes rows', 30000).catch(() => {});
  await sleep(3000);
  const kube = await app.evaluate(`(() => {
    const r = [...document.querySelectorAll('#sb-panel-hosts .sb-item')].find((x) => [...x.querySelectorAll('button')].some((b) => b.textContent === '⤢'));
    if (!r) return null; [...r.querySelectorAll('button')].find((b) => b.textContent === '⤢').click(); return r.querySelector('.name').textContent; })()`);
  if (kube) await app.waitFor(`document.querySelector('.kube-browser-pane')`, 'the cluster browser', 30000);
  await sleep(2500);   // the layout is saved a moment after it changes
  const before = await tabs();
  const saved = await app.evaluate('window.api.workspace.get()');
  console.log(`  before: ${JSON.stringify(before)}  kube: ${kube || 'none listed'}`);
  t.check('the saved layout holds the tmux session as tmux', () => {
    const kinds = JSON.stringify(saved.tabs.map((x) => x.root));
    assert.ok(kinds.includes(`"kind":"tmux"`) && kinds.includes(`"session":"${session}"`), kinds);
  });
  if (kube) t.check('and the cluster as a cluster browser', () => assert.ok(JSON.stringify(saved).includes('"kind":"kubeBrowser"')));

  await app.reload();
  await app.waitFor(`[...document.querySelectorAll('.tab')].some((x) => /· this machine/.test(x.textContent) && !/tmux · /.test(x.textContent))`, 'the tmux tab back', 40000);
  if (kube) await app.waitFor(`document.querySelector('.kube-browser-pane')`, 'the cluster browser back', 40000);
  await sleep(1500);
  const after = await tabs();
  const clients = execFileSync('tmux', ['list-clients', '-t', session, '-F', '#{client_control_mode}']).toString().trim().split('\n').filter(Boolean);
  console.log(`  after: ${JSON.stringify(after)}  control clients on ${session}: ${clients.length}`);
  t.check('reopening attaches to the same tmux session', async () => {
    assert.ok(after.some((x) => /· this machine/.test(x)), JSON.stringify(after));
    assert.ok(clients.length >= 1, 'no client attached to the session');
    assert.ok(await tmuxPanes() >= 1, 'no tmux pane on screen');
  });
  if (kube) t.check('and reopens the cluster browser', async () => assert.ok(await app.evaluate(`!!document.querySelector('.kube-browser-pane')`)));
  t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
  try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* already gone */ }
}
process.exit(t.finish());
