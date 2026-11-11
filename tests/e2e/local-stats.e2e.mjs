#!/usr/bin/env node
/**
 * A local shell's live stats, and Redraw, in the real app.
 *
 * Opens a local shell from the sidebar and waits for the bar under it to
 * show this computer's numbers (macOS and Linux; skipped elsewhere), hides it
 * from the pane's menu — kept, as settings.localStats — and shows it again,
 * then presses Redraw and checks the terminal is still sized and nothing
 * threw. Types nothing into the shell. Leaves a screenshot in
 * $TMPDIR/serverlife-local-stats.png.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const app = await start();

const readBar = () => app.evaluate(`(() => {
  const bar = document.querySelector('.pane:not(.hidden) .pane-stats');
  if (!bar) return null;
  return { local: bar.classList.contains('local'), status: bar.dataset.status,
    cells: Object.fromEntries([...bar.querySelectorAll('.ps-cell')].map((c) => [c.querySelector('.ps-k').textContent, c.querySelector('.ps-v').textContent])) };
})()`);
const menuItem = async (starts) => {
  const r = await app.evaluate(`(() => { const b = document.querySelector('.pane:not(.hidden) .pane-term').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
  }
  await app.waitFor(`!!document.querySelector('#ctxmenu-root > .ctxmenu')`, 'the pane menu', 5000);
  return app.evaluate(`(() => { const b = [...document.querySelectorAll('#ctxmenu-root .ctxmenu button')].find((x) => x.textContent.replace(/^\\W+/, '').startsWith(${JSON.stringify(starts)}));
    if (!b) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return false; } b.click(); return true; })()`);
};

try {
  if (!['darwin', 'linux'].includes(process.platform)) {
    console.log('  skipped: local live stats are for macOS and Linux');
  } else {
    await app.setViewport(1200, 800);
    await app.reload();
    const openShell = () => app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')]
      .find((r) => r.textContent.includes('Local shell')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const barsInTab = () => app.evaluate(`document.querySelectorAll('.pane:not(.hidden) .pane-stats').length`);
    await openShell();
    await app.waitFor(`!!document.querySelector('.pane:not(.hidden) .pane-stats')`, 'the stats bar', 15000);
    await app.waitFor(`!!document.querySelector('.pane:not(.hidden) .pane-stats .ps-cell')`, 'numbers in it', 15000);
    await sleep(6000);
    const bar = await readBar();
    console.log(`  bar: ${JSON.stringify(bar)}`);
    const shot = await app.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(os.tmpdir(), 'serverlife-local-stats.png'), Buffer.from(shot.data, 'base64'));
    t.check('a local shell has a live stats bar for this computer', () => {
      assert.ok(bar?.local, 'no local bar');
      assert.equal(bar.status, 'running');
    });
    t.check('its numbers are this computer’s', () => {
      const cpu = Number(String(bar.cells.CPU).replace('%', ''));
      assert.ok(cpu >= 0 && cpu <= 100, `CPU ${bar.cells.CPU}`);
      assert.match(bar.cells.Mem, /\d.* \/ \d/, `Mem ${bar.cells.Mem}`);
      assert.ok(Math.abs(Number(bar.cells.Load) - os.loadavg()[0]) < Math.max(3, os.loadavg()[0]), `Load ${bar.cells.Load} vs ${os.loadavg()[0]}`);
      assert.match(bar.cells['Disk /'], /^\d+%$/);
    });

    const hid = await menuItem('Hide live stats');
    await sleep(600);
    const afterHide = await readBar();
    const kept = await app.evaluate('window.api.settings.get().then((s) => s.localStats)');
    t.check('Hide live stats removes it and keeps it off', () => {
      assert.ok(hid, 'no Hide live stats item');
      assert.equal(afterHide, null);
      assert.equal(kept, false);
    });
    const showed = await menuItem('Show live stats');
    await app.waitFor(`!!document.querySelector('.pane:not(.hidden) .pane-stats .ps-cell')`, 'the bar back', 15000).catch(() => {});
    t.check('Show live stats brings it back', async () => {
      assert.ok(showed, 'no Show live stats item');
      assert.ok(await readBar());
      assert.equal(await app.evaluate('window.api.settings.get().then((s) => s.localStats)'), true);
    });

    const before = await app.evaluate(`(() => { const t = document.querySelector('.pane:not(.hidden) .xterm-screen'); return t ? t.getBoundingClientRect().width : 0; })()`);
    const redrew = await menuItem('Redraw');
    await sleep(800);
    const after = await app.evaluate(`(() => { const t = document.querySelector('.pane:not(.hidden) .xterm-screen'); return t ? t.getBoundingClientRect().width : 0; })()`);
    t.check('Redraw is on the menu and leaves the terminal its size', () => {
      assert.ok(redrew, 'no Redraw item');
      assert.ok(after > 0 && Math.abs(after - before) < 2, `width ${before} → ${after}`);
    });
    // Split panes on this computer: a bar each by default, one between them with the setting on.
    await menuItem('Split right');
    await app.waitFor(`document.querySelectorAll('.pane:not(.hidden) .xterm').length >= 2`, 'the split', 10000);
    await sleep(1500);
    const defaultBars = await barsInTab();
    t.check('by default each split pane on the same machine has its own bar', () => assert.equal(defaultBars, 2));
    await app.evaluate('window.api.settings.set({ statsOncePerTab: true })');
    await app.reload();
    await openShell();
    await app.waitFor(`!!document.querySelector('.pane:not(.hidden) .pane-stats')`, 'the stats bar', 15000);
    await menuItem('Split right');
    await app.waitFor(`document.querySelectorAll('.pane:not(.hidden) .xterm').length >= 2`, 'the split', 10000);
    await sleep(1500);
    const oneBar = await barsInTab();
    t.check('with "one bar per machine in a tab", the split shares one bar', () => assert.equal(oneBar, 1));
    t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
  }
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
}

process.exit(t.finish());
