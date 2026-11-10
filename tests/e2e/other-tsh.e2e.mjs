#!/usr/bin/env node
/**
 * The whole app on another tsh — a particular build, say — not just its beam dialog.
 *
 * Reads the inventory with the tsh the app finds and with SERVERLIFE_E2E_TSH
 * (set through the app's own Path to tsh setting), and compares what each
 * sees: profiles, clusters, nodes. Then, on the second tsh, opens a real
 * session on a beam and on a node and waits for each to connect. Opening a
 * session is all it does — nothing is typed into either.
 *
 *   SERVERLIFE_E2E_TSH=$HOME/core/build/tsh19 node tests/e2e/other-tsh.e2e.mjs
 */

import assert from 'node:assert/strict';
import { start, checks, sleep, execChosenTsh } from './harness.mjs';

const t = checks();
const other = process.env.SERVERLIFE_E2E_TSH;

const inventory = (app) => app.evaluate(`(() => ({
  badge: document.querySelector('#tsh-badge')?.textContent || '',
  clusters: [...document.querySelectorAll('#sb-panel-hosts .sb-group-head .gname')].map((g) => g.textContent),
  info: null,
}))()`);

async function readWith(tshPath) {
  const app = await start();
  try {
    if (tshPath) await app.evaluate(`window.api.settings.set({ tshPath: ${JSON.stringify(tshPath)} })`);
    await app.reload();
    await app.waitFor(`/nodes/.test(document.querySelector('#tsh-badge')?.textContent || '')`, 'the inventory', 60000);
    await sleep(1500);
    const inv = await inventory(app);
    inv.info = await app.evaluate('window.api.app.info().then((i) => i.tshVersion)');
    return { app, inv };
  } catch (e) {
    await app.stop();
    throw e;
  }
}

/** Double-click a row, then wait for the tab it opens to say connected. */
async function connect(app, rowSelectorJs, what) {
  // Counted first, so a tab that was already connected cannot pass for this one.
  const before = await app.evaluate(`document.querySelectorAll('.tab .dot.connected').length`);
  const opened = await app.evaluate(`(() => { const r = ${rowSelectorJs}; if (!r) return false;
    r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return r.querySelector('.name')?.textContent.trim() || true; })()`);
  if (!opened) return { skipped: `no ${what} to open` };
  try {
    await app.waitFor(`document.querySelectorAll('.tab .dot.connected').length > ${before}`, `${what} to connect`, 90000);
    return { ok: true, row: opened, title: await app.evaluate(`document.querySelector('.tab.active')?.textContent.trim()`) };
  } catch (e) {
    const err = await app.evaluate(`[...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | ')`);
    return { ok: false, error: `${e.message}${err ? ' — ' + err : ''}` };
  }
}

if (!other) {
  console.log('  skipped: set SERVERLIFE_E2E_TSH to the tsh to try');
  process.exit(0);
}

let a;
let b;
try {
  a = await readWith(null);
  const own = a.inv;
  await a.app.stop();
  a = null;
  b = await readWith(other);
  const theirs = b.inv;
  const v = execChosenTsh(other, ['version']).split('\n')[0];
  console.log(`  app's own tsh: ${JSON.stringify(own)}`);
  console.log(`  ${v}: ${JSON.stringify(theirs)}`);

  t.check(`${v} is the tsh the app is using`, () => assert.match(String(theirs.info || ''), /19\./));
  t.check('it reads the same profiles and nodes', () => assert.equal(theirs.badge, own.badge));
  t.check('and the same clusters', () => assert.deepEqual(theirs.clusters, own.clusters));

  // A session on a beam, then on an ordinary node — both through this tsh.
  const beam = await connect(b.app, `[...document.querySelectorAll('#sb-panel-hosts .sb-item')]
    .find((r) => r.querySelector('.tag.beams'))`, 'a running beam');
  console.log(`  beam session: ${JSON.stringify(beam)}`);
  if (!beam.skipped) t.check(`${v}: a beam session connects`, () => assert.ok(beam.ok, beam.error));

  const node = await connect(b.app, `[...document.querySelectorAll('#sb-panel-hosts .sb-group')]
    .find((g) => /red-fire/i.test(g.querySelector('.gname')?.textContent || ''))
    ?.querySelector('.sb-items > .sb-item:not(.beam-add):not(.phase-row)')`, 'a red-fire node');
  console.log(`  node session: ${JSON.stringify(node)}`);
  if (!node.skipped) t.check(`${v}: a node session connects`, () => assert.ok(node.ok, node.error));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await a?.app.stop();
  await b?.app.stop();
}

process.exit(t.finish());
