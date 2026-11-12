#!/usr/bin/env node
/**
 * Heartbeats in the Hosts pane, and sorting by them.
 *
 * Opens a cluster's Hosts pane from its sidebar group ("… N more — open in a
 * pane"), with Heartbeats on: Kubernetes cards carry a heartbeat as SSH ones
 * do, Sort: Heartbeat puts quiet ones first and the rest by how long ago they
 * were heard, and Settings' exact-time style shows clock times instead of
 * <1m. Reads only. Leaves a screenshot in $TMPDIR/serverlife-pane-heartbeats.png.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const app = await start();
const cards = () => app.evaluate(`[...document.querySelectorAll('.hp-card')].map((c) => ({
  name: c.querySelector('.hp-name')?.textContent, kube: !!c.querySelector('.kube-ico'),
  beat: c.querySelector('.tag.hb, .tag.stale')?.textContent || '', quiet: !!c.querySelector('.tag.stale') }))`);
try {
  await app.setViewport(1500, 1000);
  await app.evaluate('window.api.settings.set({ showHeartbeats: true })');
  await app.reload();
  await app.waitFor(`document.querySelectorAll('#sb-panel-hosts .kube-ico').length > 0`, 'Kubernetes rows', 60000);
  await sleep(45000);   // a round of checks, and the agents read
  const more = await app.evaluate(`(() => { const m = [...document.querySelectorAll('#sb-panel-hosts .sb-more')].find((x) => x.closest('.sb-group')?.querySelector('.kube-ico')); if (!m) return false; m.click(); return true; })()`);
  if (!more) {
    console.log('  skipped: no group with Kubernetes clusters past the sidebar limit');
  } else {
    await app.waitFor(`document.querySelectorAll('.hp-card').length > 0`, 'the Hosts pane', 20000);
    await sleep(1500);
    const list = await cards();
    const kube = list.filter((c) => c.kube);
    console.log(`  kube cards: ${JSON.stringify(kube.map((c) => `${c.name}: ${c.beat}`))}`);
    t.check('Kubernetes cards in the pane carry a heartbeat', () => assert.ok(kube.length && kube.some((c) => /♥|⚠/.test(c.beat)), JSON.stringify(kube)));

    await app.evaluate(`(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'heartbeat')); s.value = 'heartbeat'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(1200);
    const sorted = await cards();
    console.log(`  sorted by heartbeat: ${JSON.stringify(sorted.slice(0, 8).map((c) => `${c.name}: ${c.beat || '-'}`))}`);
    t.check('Sort: Heartbeat puts quiet ones first and the ones with no heartbeat last', () => {
      const firstPlain = sorted.findIndex((c) => !c.quiet);
      assert.ok(sorted.slice(firstPlain).every((c) => !c.quiet), 'a quiet one after an answering one');
      const firstBlank = sorted.findIndex((c) => !c.beat);
      if (firstBlank >= 0) assert.ok(sorted.slice(firstBlank).every((c) => !c.beat), 'a heartbeat after one with none');
    });

    // All / SSH / K8s in the pane.
    const pill = (k) => app.evaluate(`document.querySelector('.hp-kinds .sb-kind-tab[data-kind="${k}"]').click()`);
    await pill('kube'); await sleep(1000);
    const onlyKube = await cards();
    await pill('ssh'); await sleep(1000);
    const onlySsh = await cards();
    await pill('all'); await sleep(1000);
    const both = await cards();
    t.check('the pane’s K8s shows only Kubernetes clusters, SSH only hosts, All both', () => {
      assert.ok(onlyKube.length && onlyKube.every((c) => c.kube), 'K8s');
      assert.ok(onlySsh.length && onlySsh.every((c) => !c.kube), 'SSH');
      assert.ok(both.some((c) => c.kube) && both.some((c) => !c.kube), 'All');
    });
    // One filter for both: the sidebar's SSH limits the pane, and the pane's K8s limits the sidebar.
    await app.evaluate(`[...document.querySelectorAll('.sb-kind-tab[data-kind="ssh"]')].find((b) => !b.closest('.hp-kinds')).click()`);
    await sleep(1500);
    const followed = await cards();
    t.check('the sidebar’s SSH filter limits the pane too', () => assert.ok(followed.length && followed.every((c) => !c.kube), JSON.stringify(followed.filter((c) => c.kube).map((c) => c.name))));
    await pill('kube'); await sleep(1500);
    const sidebarKube = await app.evaluate(`({ active: [...document.querySelectorAll('.sb-kind-tab.active')].filter((b) => !b.closest('.hp-kinds')).map((b) => b.dataset.kind), ssh: document.querySelectorAll('#sb-panel-hosts .sb-item .srv-ico').length })`);
    t.check('and the pane’s K8s sets the sidebar’s filter', () => { assert.deepEqual(sidebarKube.active, ['kube']); assert.equal(sidebarKube.ssh, 0); });
    await pill('all');

    // The table: a Heartbeat column, sortable from its header, and a second click turns it round.
    await app.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Table').click()`);
    await sleep(1200);
    const header = () => app.evaluate(`[...document.querySelectorAll('.hp-tr.head .hp-th')].map((h) => h.textContent)`);
    const beatCol = () => app.evaluate(`[...document.querySelectorAll('.hp-tr:not(.head)')].map((r) => ({ name: r.querySelector('.hp-name')?.textContent, beat: r.querySelector('.hp-td.beat')?.textContent || '' }))`);
    t.check('the table has a Heartbeat column', async () => assert.ok((await header()).some((h) => h.startsWith('Heartbeat'))));
    await app.evaluate(`[...document.querySelectorAll('.hp-th')].find((h) => h.textContent.startsWith('Heartbeat')).click()`);
    await sleep(1000);
    const up = await beatCol();
    const upHead = await header();
    await app.evaluate(`[...document.querySelectorAll('.hp-th')].find((h) => h.textContent.startsWith('Heartbeat')).click()`);
    await sleep(1000);
    const down = await beatCol();
    const downHead = await header();
    console.log(`  table by heartbeat: ${JSON.stringify(up.slice(0, 5))} … reversed: ${JSON.stringify(down.slice(0, 3))}`);
    t.check('its header sorts by heartbeat, and a second click reverses it (▲ ⇄ ▼)', () => {
      const a = upHead.find((h) => h.startsWith('Heartbeat'));
      const b = downHead.find((h) => h.startsWith('Heartbeat'));
      assert.ok(/[▲▼]$/.test(a) && /[▲▼]$/.test(b) && a !== b, JSON.stringify([upHead, downHead]));
      assert.deepEqual(down.map((r) => r.name), up.map((r) => r.name).reverse());
      assert.ok(up.some((r) => r.beat), 'no heartbeats in the column');
    });
    await app.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'List').click()`);

    await app.evaluate('window.api.settings.set({ heartbeatStyle: "exact" })');
    await app.reload();
    await app.waitFor(`document.querySelectorAll('#sb-panel-hosts .kube-ico').length > 0`, 'Kubernetes rows', 60000);
    await sleep(45000);
    const exact = await app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .tag.hb, #sb-panel-hosts .tag.stale')].map((x) => x.textContent).filter((x) => /♥|⚠/.test(x)).slice(0, 6)`);
    console.log(`  exact style: ${JSON.stringify(exact)}`);
    t.check('the exact style shows the clock time of the heartbeat', () => assert.ok(exact.some((x) => /\d{1,2}:\d{2}:\d{2}/.test(x)), JSON.stringify(exact)));
    const s = await app.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(os.tmpdir(), 'serverlife-pane-heartbeats.png'), Buffer.from(s.data, 'base64'));
  }
  t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
}
process.exit(t.finish());
