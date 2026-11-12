#!/usr/bin/env node
/**
 * Kubernetes heartbeats in the real app.
 *
 * With Heartbeats off, Kubernetes rows carry no heartbeat tag. On, each
 * context is asked GET /readyz: one that answers shows ♥ and how fast, one
 * reached through Teleport without a good cached certificate shows "not
 * checked" — and is not asked, so no tsh login is started. Reads only.
 * Leaves a screenshot in $TMPDIR/serverlife-kube-heartbeats.png.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const app = await start();
const tags = () => app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')].filter((r) => r.querySelector('.kube-ico'))
  .map((r) => ({ name: r.querySelector('.name')?.textContent, beat: [...r.querySelectorAll('.tag.hb, .tag.stale')].map((x) => x.textContent).join(' '), title: r.querySelector('.tag.hb, .tag.stale')?.title || '' }))`);
try {
  await app.setViewport(1400, 1000);
  await app.waitFor(`document.querySelectorAll('#sb-panel-hosts .kube-ico').length > 0`, 'Kubernetes rows', 60000).catch(() => {});
  await sleep(4000);
  const off = await tags();
  if (!off.length) {
    console.log('  skipped: no Kubernetes rows');
  } else {
    t.check('Heartbeats off: no heartbeat tags on Kubernetes rows', () => assert.ok(off.every((x) => !/[♥⚠]|not checked/.test(x.beat)), JSON.stringify(off.filter((x) => x.beat))));
    // More than one tsh home (SERVERLIFE_E2E_HOMES, ':'-separated): the same cluster may be in two of them.
    const homes = (process.env.SERVERLIFE_E2E_HOMES || '').split(':').filter(Boolean);
    await app.evaluate(`window.api.settings.set(${JSON.stringify({ showHeartbeats: true, ...(homes.length ? { tshHomes: homes } : {}) })})`);
    await app.reload();
    await app.waitFor(`document.querySelectorAll('#sb-panel-hosts .kube-ico').length > 0`, 'Kubernetes rows', 60000);
    // One round of checks: up to 3 at a time, each within 20 s.
    await app.waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item .tag.hb, #sb-panel-hosts .sb-item .tag.stale')].some((x) => /♥ \\d|not checked|⚠/.test(x.textContent))`, 'a heartbeat', 90000).catch(() => {});
    await sleep(70000);
    const seen = (await tags()).filter((x) => x.beat);
    console.log(`  heartbeats: ${JSON.stringify(seen.map((x) => `${x.name}: ${x.beat}`))}`);
    const s = await app.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(os.tmpdir(), 'serverlife-kube-heartbeats.png'), Buffer.from(s.data, 'base64'));
    t.check('Heartbeats on: Kubernetes rows get a heartbeat', () => assert.ok(seen.length > 0));
    t.check('a cluster that answers shows ♥ and how fast', () => assert.ok(seen.some((x) => /♥ \d/.test(x.beat)), 'none answered'));
    const idle = seen.filter((x) => /not checked/.test(x.beat));
    if (idle.length) t.check('one without a good Teleport certificate is "not checked", and says why', () => assert.match(idle[0].title, /certificate/));
    // Rows not logged in to (dimmed, "not connected") are asked through the app's own kubeconfig.
    const notConnected = await app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')].filter((r) => r.querySelector('.kube-ico') && /not connected/.test(r.textContent))
      .map((r) => ({ name: r.querySelector('.name')?.textContent, beat: r.querySelector('.tag.hb, .tag.stale')?.textContent || '' }))`);
    console.log(`  not logged in: ${JSON.stringify(notConnected.slice(0, 6))} (${notConnected.length})`);
    if (notConnected.length) t.check('a cluster not logged in to gets a heartbeat too', () => assert.ok(notConnected.some((x) => /♥ \d/.test(x.beat)), 'none answered'));
    const logins = await app.evaluate(`[...document.querySelectorAll('.tab')].map((t) => t.textContent).filter((x) => /login/i.test(x))`);
    t.check('no tsh login was started by the checks', () => assert.deepEqual(logins, []));
  }
  t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
}
process.exit(t.finish());
