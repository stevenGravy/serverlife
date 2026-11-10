#!/usr/bin/env node
/**
 * The Beams | Phases tabs in a cluster's group: there only where tsh can do
 * Phases, and listing them from `tsh phase ls` when they are.
 *
 * Like start-beam-dialog.e2e.mjs, it runs against the real cluster — once with
 * the tsh the app finds, once with SERVERLIFE_E2E_TSH if set — and only reads:
 * it opens a Phase's menu and closes it again. Nothing is started or deleted.
 * Leaves a screenshot of the Phases tab in $TMPDIR/serverlife-phases.png.
 *
 *   SERVERLIFE_E2E_TSH=/path/to/tsh19 make test-e2e
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep, execChosenTsh } from './harness.mjs';

const t = checks();
// The app's own tsh as the app runs it; a chosen one with managed updates off.
const hasPhase = (tsh, chosen = false) => {
  try {
    if (chosen) execChosenTsh(tsh, ['phase', '--help']);
    else execFileSync(tsh, ['phase', '--help'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
};

async function look(tshPath) {
  const app = await start();
  try {
    if (tshPath) await app.evaluate(`window.api.settings.set({ tshPath: ${JSON.stringify(tshPath)} })`);
    await app.reload();
    await app.setViewport(1280, 900);
    try {
      await app.waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')].some((r) => r.textContent.includes('Start a beam'))`,
        'a cluster with beams', 45000);
    } catch { return null; }
    await sleep(1500);
    const tabs = await app.evaluate(`[...document.querySelectorAll('.beam-tabs .beam-tab')].map((b) => b.firstChild.textContent)`);
    if (!tabs.length) return { tabs };

    await app.clickOn('.beam-tabs .beam-tab:nth-child(2)');
    await app.waitFor(`document.querySelectorAll('.phase-row').length > 0
      || [...document.querySelectorAll('.sb-empty')].some((n) => /Phases yet|Could not|denied/i.test(n.textContent))`,
    'the Phases tab to fill', 30000);
    const rows = await app.evaluate(`[...document.querySelectorAll('.phase-row')].map((r) => ({
      name: r.querySelector('.name').textContent,
      tags: [...r.querySelectorAll('.tag')].map((x) => x.textContent),
    }))`);
    const shot = await app.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(os.tmpdir(), 'serverlife-phases.png'), Buffer.from(shot.data, 'base64'));

    let menu = null;
    if (rows.length) {
      const r = await app.evaluate(`(() => { const b = document.querySelector('.phase-row').getBoundingClientRect();
        return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
      await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
      await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
      await app.waitFor(`!!document.querySelector('#ctxmenu-root > .ctxmenu')`, 'the Phase menu', 5000);
      menu = await app.evaluate(`[...document.querySelectorAll('#ctxmenu-root > .ctxmenu > button')].map((b) => ({
        label: b.querySelector('span:not(.ctx-icon):not(.key)').textContent, disabled: b.disabled }))`);
      await app.escape();
    }
    return { tabs, rows, menu };
  } finally {
    await app.stop();
  }
}

try {
  const own = await look(null);
  if (!own) {
    console.log('  skipped: no logged-in cluster with beams');
  } else {
    const v = execFileSync('tsh', ['version'], { encoding: 'utf8' }).split('\n')[0];
    console.log(`  ${v}: ${JSON.stringify(own)}`);
    t.check(`${v}: tabs only if it has tsh phase (${hasPhase('tsh')})`, () => {
      assert.equal(own.tabs.length > 0, hasPhase('tsh'));
    });
  }

  const other = process.env.SERVERLIFE_E2E_TSH;
  if (other) {
    const v = execChosenTsh(other, ['version']).split('\n')[0];
    const seen = await look(other);
    if (!seen) {
      console.log('  skipped the second tsh: no logged-in cluster with beams');
    } else {
      console.log(`  ${v}: ${JSON.stringify(seen)}`);
      t.check(`${v}: Beams, Phases and failed tabs`, () => assert.deepEqual(seen.tabs, ['beams', 'phases', 'failed']));
      t.check(`${v}: the Phases tab lists tsh phase ls`, () => {
        assert.ok(seen.rows?.length, 'no Phase rows');
        assert.ok(seen.rows.every((r) => r.tags.length >= 1), 'each row carries its state');
      });
      t.check(`${v}: a Phase's menu starts a beam from it and deletes it`, () => {
        const labels = (seen.menu || []).map((m) => m.label);
        assert.ok(labels.some((l) => l.startsWith('Start a beam from it')), labels.join(', '));
        assert.ok(labels.some((l) => l.startsWith('Delete Phase')), labels.join(', '));
      });
      console.log(`  screenshot: ${path.join(os.tmpdir(), 'serverlife-phases.png')}`);
    }
  }
} catch (e) {
  t.fail('the run itself', e.message);
}

process.exit(t.finish());
