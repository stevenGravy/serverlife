#!/usr/bin/env node
/**
 * Which cloud a Kubernetes cluster is on, in the real app.
 *
 * Reads the sidebar's Kubernetes rows for provider badges (EKS, GKE, AKS…),
 * then opens the cluster browser on a cluster with a badge and its Cloud
 * view: the provider, its node pools, and — on EKS — workload identity and
 * aws-auth sections. Clicking a pool opens the Nodes list filtered to it.
 * Reads only. Needs a kubeconfig or Teleport cluster on a cloud; skips
 * without one. SERVERLIFE_E2E_KUBE names the cluster to open. Leaves
 * screenshots in $TMPDIR/serverlife-kube-badges.png and serverlife-kube-cloud.png.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const app = await start();
const shot = async (name) => {
  const s = await app.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(os.tmpdir(), name), Buffer.from(s.data, 'base64'));
};

try {
  await app.setViewport(1440, 960);
  await app.waitFor(`document.querySelectorAll('#sb-panel-hosts .kube-ico').length > 0`, 'Kubernetes rows', 60000).catch(() => {});
  await sleep(6000);
  const badges = await app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')].filter((r) => r.querySelector('.kprov'))
    .map((r) => ({ name: r.querySelector('.name')?.textContent, badge: r.querySelector('.kprov').textContent, guess: r.querySelector('.kprov').classList.contains('guess') }))`);
  await shot('serverlife-kube-badges.png');
  console.log(`  badges: ${JSON.stringify(badges)}`);
  if (!badges.length) {
    console.log('  skipped: no Kubernetes cluster on a cloud this can tell');
  } else {
    t.check('Kubernetes rows on a cloud carry its badge', () => assert.ok(badges.length > 0));
    // Open the browser on one: the named one, else an EKS one, else the first badged.
    const want = process.env.SERVERLIFE_E2E_KUBE || '';
    const opened = await app.evaluate(`(() => {
      const openable = [...document.querySelectorAll('#sb-panel-hosts .sb-item')].filter((r) => [...r.querySelectorAll('button')].some((b) => b.textContent === '⤢'));
      const rows = openable.filter((r) => r.querySelector('.kprov'));
      // A named cluster is opened badge or not: one reached only through Teleport shows its cloud once read.
      const pick = openable.find((r) => r.querySelector('.name')?.textContent === ${JSON.stringify(want)})
        || rows.find((r) => r.querySelector('.kprov').textContent === 'EKS' && !r.querySelector('.kprov.guess')) || rows[0];
      if (!pick) return null;
      [...pick.querySelectorAll('button')].find((b) => b.textContent === '⤢').click();
      return pick.querySelector('.name').textContent;
    })()`);
    if (!opened) {
      console.log('  skipped the browser: no logged-in cluster with a badge to open');
    } else {
      console.log(`  opened: ${opened}`);
      await app.waitFor(`[...document.querySelectorAll('.sb-item .name')].some((n) => n.textContent === '☁ Cloud')`, 'the Cloud entry', 30000);
      await app.evaluate(`[...document.querySelectorAll('.sb-item')].find((r) => r.querySelector('.name')?.textContent === '☁ Cloud').click()`);
      await app.waitFor(`[...document.querySelectorAll('div')].some((d) => /^(Node groups|Node pools|Agent pools) \\(/.test(d.textContent) && d.childElementCount === 0)`, 'the Cloud view', 60000);
      await sleep(500);
      const cloud = await app.evaluate(`(() => {
        const titles = [...document.querySelectorAll('div')].filter((d) => d.childElementCount === 0 && /^(Node groups|Node pools|Agent pools|Workload identity|IAM → Kubernetes)/.test(d.textContent)).map((d) => d.textContent);
        const pools = [...document.querySelectorAll('tr[title^="Show these nodes"]')].map((r) => r.querySelector('td span').textContent);
        return { titles, pools, badge: [...document.querySelectorAll('.kprov')].map((b) => b.textContent).pop() };
      })()`);
      await shot('serverlife-kube-cloud.png');
      console.log(`  cloud: ${JSON.stringify(cloud)}`);
      t.check('the Cloud view names the provider and lists node pools', () => {
        assert.ok(cloud.titles.some((x) => /^(Node groups|Node pools|Agent pools)/.test(x)), JSON.stringify(cloud.titles));
      });
      if (cloud.titles.some((x) => x.startsWith('Node groups'))) {
        t.check('EKS: workload identity (IRSA) and aws-auth sections', () => {
          assert.ok(cloud.titles.some((x) => x.startsWith('Workload identity')));
          assert.ok(cloud.titles.some((x) => x.startsWith('IAM → Kubernetes')));
        });
      }
      if (cloud.pools.length) {
        await app.evaluate(`document.querySelector('tr[title^="Show these nodes"]').click()`);
        await sleep(5000);
        const after = await app.evaluate(`({ text: document.body.innerText, cloudShown: [...document.querySelectorAll('div')].some((d) => d.childElementCount === 0 && /^Node groups \\(/.test(d.textContent)) })`);
        console.log(`  after the click: cloud view still shown=${after.cloudShown}, mentions the pool=${after.text.includes(cloud.pools[0])}`);
        t.check('clicking a pool shows its nodes, scoped to that pool', () => {
          assert.equal(after.cloudShown, false, 'still on the Cloud view');
          assert.ok(after.text.includes(cloud.pools[0]), 'the pool is not named on the Nodes list');
        });
      }
    }
  }
  // Connecting is when it asks: a Teleport-routed cluster with no labels gets its badge once expanded.
  await app.escape().catch(() => {});
  await app.evaluate(`document.querySelector('.kube-browser-close, [title="Close"]')?.click?.()`).catch(() => {});
  // A logged-in cluster with no cloud labels, named in SERVERLIFE_E2E_UNLABELLED; without one, this part is skipped.
  const target = process.env.SERVERLIFE_E2E_UNLABELLED || '';
  const expandRow = `[...document.querySelectorAll('#sb-panel-hosts .sb-item')].find((r) => r.querySelector('.name')?.textContent === ${JSON.stringify(target)} && [...r.querySelectorAll('button')].some((b) => b.textContent === '⤢'))`;
  const before = await app.evaluate(`(() => { const r = ${expandRow}; return r ? (r.querySelector('.kprov')?.textContent || 'none') : null; })()`);
  if (!target || before === null) {
    console.log(`  skipped detect-on-connect: no logged-in ${target}`);
  } else {
    await app.evaluate(`${expandRow}.click()`);
    await app.waitFor(`(() => { const r = ${expandRow}; return !!r?.querySelector('.kprov'); })()`, 'a badge after connecting', 30000).catch(() => {});
    const after = await app.evaluate(`(() => { const b = ${expandRow}?.querySelector('.kprov'); return b ? { text: b.textContent, title: b.title } : null; })()`);
    console.log(`  ${target}: before=${before} after=${JSON.stringify(after)}`);
    t.check('connecting to an unlabelled cluster asks it which cloud it is', () => {
      assert.ok(after, 'no badge after expanding');
      assert.match(after.title, /seen on the cluster itself|set by you/);
    });

    // By hand: Cloud → Azure AKS, then back to detecting.
    const menuOn = async (label) => {
      // Straight to the row: a first-run tour's backdrop may be over the window in a fresh profile.
      await app.evaluate(`(() => { const row = ${expandRow}; const b = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + b.height / 2, button: 2 })); })()`);
      await app.waitFor(`!!document.querySelector('#ctxmenu-root .ctxmenu')`, 'the row menu', 5000);
      await app.evaluate(`[...document.querySelectorAll('#ctxmenu-root .ctxmenu button')].find((b) => b.classList.contains('has-sub') && b.textContent.includes('Cloud'))?.dispatchEvent(new MouseEvent('mouseenter'))`);  // a row that is only a submenu opens it on hover
      await sleep(300);
      return app.evaluate(`(() => { const b = [...document.querySelectorAll('#ctxmenu-root .ctxmenu button')].find((x) => x.textContent.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
    };
    const marked = await menuOn('Azure AKS');
    await sleep(800);
    const tagged = await app.evaluate(`(() => { const b = ${expandRow}?.querySelector('.kprov'); return b ? { text: b.textContent, title: b.title } : null; })()`);
    t.check('Cloud → Azure AKS marks it by hand', () => {
      assert.ok(marked, 'no Azure AKS item in the Cloud submenu');
      assert.equal(tagged?.text, 'AKS');
      assert.match(tagged.title, /set by you/);
    });
    const undone = await menuOn('Detect automatically');
    await sleep(800);
    const back = await app.evaluate(`${expandRow}?.querySelector('.kprov')?.textContent || 'none'`);
    t.check('Detect automatically puts the detected one back', () => {
      assert.ok(undone, 'no Detect automatically item');
      assert.equal(back, after?.text);
    });
  }
  t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
}
process.exit(t.finish());
