#!/usr/bin/env node
/**
 * The live stats bar on a real session.
 *
 * Opens a session on a real node — the first one in a logged-in cluster's
 * group, or SERVERLIFE_E2E_HOST by name — and waits for the bar under it to
 * fill with numbers that make sense, then hides it from the pane's menu and
 * shows it again. Only reads: the monitor is one command printing /proc
 * figures, and nothing is typed into the session. Skips without a cluster.
 * Leaves a screenshot in $TMPDIR/serverlife-live-stats.png.
 *
 *   SERVERLIFE_E2E_HOST=bms-app-service make test-e2e
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const want = process.env.SERVERLIFE_E2E_HOST || '';
let app;

const readBar = () => app.evaluate(`(() => {
  const bar = document.querySelector('.pane:not(.hidden) .pane-stats');
  if (!bar) return null;
  const cells = Object.fromEntries([...bar.querySelectorAll('.ps-cell')].map((c) =>
    [c.querySelector('.ps-k').textContent, c.querySelector('.ps-v').textContent]));
  return { status: bar.dataset.status, cells, note: bar.querySelector('.ps-note')?.textContent || '',
    spark: bar.querySelector('.ps-spark')?.textContent || '' };
})()`);

try {
  app = await start();
  if (process.env.SERVERLIFE_E2E_TSH) await app.evaluate(`window.api.settings.set({ tshPath: ${JSON.stringify(process.env.SERVERLIFE_E2E_TSH)} })`);
  await app.reload();
  await app.setViewport(1400, 900);
  try {
    await app.waitFor(`/nodes/.test(document.querySelector('#tsh-badge')?.textContent || '')
      && !/^0 nodes/.test(document.querySelector('#tsh-badge')?.textContent || '')`, 'a cluster with nodes', 60000);
  } catch {
    console.log('  skipped: no logged-in cluster with nodes');
    await app.stop();
    process.exit(t.finish());
  }
  await sleep(1500);

  // A node row: in a cluster group, not a beam, not requestable, not a ghost.
  const opened = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#sb-panel-hosts .sb-group .sb-items > .sb-item')]
      .filter((r) => !r.classList.contains('beam-add') && !r.classList.contains('phase-row')
        && !r.querySelector('.tag.beams, .tag.req, .tag.gone, .tag.stale') && r.querySelector('input[type=checkbox]'));
    const r = ${JSON.stringify(want)} ? rows.find((x) => x.querySelector('.name')?.textContent.trim() === ${JSON.stringify(want)}) : rows[0];
    if (!r) return null;
    r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return r.querySelector('.name').textContent.trim();
  })()`);
  assert.ok(opened, want ? `no node called ${want}` : 'no node to open');
  console.log(`  opened a session on ${opened}`);
  await app.waitFor(`!!document.querySelector('.tab.active .dot.connected')`, 'the session to connect', 90000);

  // The bar fills once the first sample is in: one interval after the hello.
  let bar = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    bar = await readBar();
    if (bar?.cells?.CPU || /^(mfa|unsupported|ended)$/.test(bar?.status || '')) break;
  }
  console.log(`  bar: ${JSON.stringify(bar)}`);
  const shot = await app.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(os.tmpdir(), 'serverlife-live-stats.png');
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  screenshot: ${file}`);

  t.check('a bar appears under the session', () => assert.ok(bar, 'no .pane-stats'));
  if (bar?.status === 'mfa' || bar?.status === 'unsupported') {
    t.check(`it says why there are no stats (${bar.status})`, () => assert.ok(bar.note.length > 10));
  } else {
    t.check('it is running, with CPU, memory, load, disk, network and uptime', () => {
      assert.equal(bar.status, 'running');
      for (const k of ['CPU', 'Mem', 'Load', 'Disk /', 'Net', 'Up']) assert.ok(bar.cells[k], `no ${k}`);
    });
    t.check('the numbers make sense', () => {
      const cpu = parseFloat(bar.cells.CPU);
      assert.ok(cpu >= 0 && cpu <= 100, `CPU ${bar.cells.CPU}`);
      assert.match(bar.cells.Mem, /^[\d.]+ (B|KB|MB|GB|TB) \/ [\d.]+ (KB|MB|GB|TB)$/);
      const disk = parseFloat(bar.cells['Disk /']);
      assert.ok(disk >= 0 && disk <= 100, `disk ${bar.cells['Disk /']}`);
      assert.match(bar.cells.Net, /↓ .+\/s +↑ .+\/s/);
    });
    // Another sample: the sparkline grows.
    await sleep(6000);
    const later = await readBar();
    t.check('it keeps updating (the sparkline grows)', () => assert.ok(later.spark.length > bar.spark.length, `${bar.spark} → ${later.spark}`));
  }

  // Hidden from the pane's menu, then shown again.
  const menuItem = async (starts) => {
    const r = await app.evaluate(`(() => { const b = document.querySelector('.pane:not(.hidden) .pane-term').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await app.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
    }
    await app.waitFor(`!!document.querySelector('#ctxmenu-root > .ctxmenu')`, 'the pane menu', 5000);
    return app.evaluate(`(() => { const b = [...document.querySelectorAll('#ctxmenu-root .ctxmenu button')].find((x) => x.textContent.replace(/^\\W+/, '').startsWith(${JSON.stringify(starts)}));
      if (!b) return false; b.click(); return true; })()`);
  };
  const hid = await menuItem('Hide live stats');
  await sleep(800);
  const afterHide = await readBar();
  t.check('Hide live stats removes the bar', () => { assert.ok(hid, 'no Hide live stats item'); assert.equal(afterHide, null); });
  const showed = await menuItem('Show live stats');
  await sleep(7000);
  const afterShow = await readBar();
  t.check('Show live stats brings it back', () => { assert.ok(showed, 'no Show live stats item'); assert.ok(afterShow); });
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
}

process.exit(t.finish());
