#!/usr/bin/env node
/**
 * tsh variables for one cluster, set from its heading's menu, reach that
 * cluster's tsh.
 *
 * Phases are the visible proof: they are offered only where the tsh in use
 * has them, and TELEPORT_TOOLS_VERSION decides which tsh that is. On a beams
 * cluster (SERVERLIFE_E2E_PROXY, default red-fire.beams.sh) whose own tools
 * version has no Phases, with the app's own tsh: no variables (no Phases), then
 * TELEPORT_TOOLS_VERSION=18.11.9 — a tsh with Phases — which brings the tabs and
 * lists the cluster's Phases, then cleared again. Each is set through *tsh
 * environment for this cluster…*. Only reads the cluster. SERVERLIFE_E2E_TOOLS_ENV
 * swaps in other lines for that middle step.
 *
 *   SERVERLIFE_E2E_TOOLS_ENV='TELEPORT_TOOLS_VERSION=…' node tests/e2e/cluster-tsh-env.e2e.mjs
 */

import assert from 'node:assert/strict';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const PROXY = process.env.SERVERLIFE_E2E_PROXY || 'red-fire.beams.sh';
// Lines for a tsh that has Phases.
const PHASE_ENV = process.env.SERVERLIFE_E2E_TOOLS_ENV || 'TELEPORT_TOOLS_VERSION=18.11.9';
let app;

const group = `[...document.querySelectorAll('#sb-panel-hosts .sb-group')].find((g) => g.querySelector('.gname')?.textContent.includes(${JSON.stringify(PROXY)}))`;
const look = () => app.evaluate(`(() => { const g = ${group}; if (!g) return null;
  return { tabs: [...g.querySelectorAll('.beam-tabs .beam-tab')].map((b) => b.firstChild.textContent),
    env: !!g.querySelector('.sb-group-head .tag[title^="tsh runs with"]'),
    envTitle: g.querySelector('.sb-group-head .tag[title^="tsh runs with"]')?.title || '' }; })()`);

async function setVars(text) {
  const r = await app.evaluate(`(() => { const h = (${group}).querySelector('.sb-group-head').getBoundingClientRect(); return { x: h.left + 40, y: h.top + h.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await app.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
  await app.waitFor(`!!document.querySelector('#ctxmenu-root > .ctxmenu')`, 'the heading menu', 5000);
  assert.ok(await app.evaluate(`(() => { const b = [...document.querySelectorAll('#ctxmenu-root .ctxmenu button')].find((x) => x.textContent.includes('tsh environment for this cluster'));
    if (!b) return false; b.click(); return true; })()`), 'no tsh environment item');
  await app.waitFor(`[...document.querySelectorAll('.modal-head h2')].some((h) => h.textContent === 'tsh environment for this cluster')`, 'the dialog', 5000);
  const note = await app.evaluate(`(async () => { const m = [...document.querySelectorAll('.modal')].pop(); const a = m.querySelector('textarea');
    a.value = ${JSON.stringify(text)}; a.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const n = m.querySelector('.env-note').textContent;
    [...m.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click(); return n; })()`);
  return note;
}

/** Wait for the beams section to settle after a change: tabs come, or go. */
async function settle(expectTabs) {
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const s = await look();
    if (s && (expectTabs ? s.tabs.length > 0 : s.tabs.length === 0)) return s;
  }
  return look();
}

try {
  app = await start();
  await app.reload();
  await app.setViewport(1400, 900);
  try {
    await app.waitFor(`!!(${group})?.querySelector('.beam-add')`, `${PROXY} with beams`, 60000);
  } catch {
    console.log(`  skipped: ${PROXY} is not a logged-in beams cluster here`);
    await app.stop();
    process.exit(t.finish());
  }
  await sleep(3000);
  const base = await look();
  console.log(`  no variables: ${JSON.stringify(base)}`);

  t.check('with no variables this cluster offers no Phases (its tools version has none)', () => assert.deepEqual(base.tabs, []));

  {
    const n2 = await setVars(PHASE_ENV);
    console.log(`  dialog said: ${n2}`);
    const dev = await settle(true);
    console.log(`  with ${PHASE_ENV.replace(/\n/g, '; ')}: ${JSON.stringify(dev)}`);
    t.check('the dialog reads the line', () => assert.match(n2, /^Sets TELEPORT_TOOLS_VERSION=/));
    t.check('the heading shows an env tag naming it', () => { assert.ok(dev.env); assert.match(dev.envTitle, /TELEPORT_TOOLS_VERSION=/); });
    t.check('on a tsh that has Phases it offers Beams | Phases | failed', () => assert.deepEqual(dev.tabs, ['beams', 'phases', 'failed']));
    // The Phases tab reads them through the same tsh.
    await app.evaluate(`(${group}).querySelector('.beam-tabs .beam-tab:nth-child(2)').click()`);
    await app.waitFor(`(${group}).querySelectorAll('.phase-row').length > 0 || /No Phases|Could not/.test((${group}).textContent)`, 'the Phases tab', 60000);
    const names = await app.evaluate(`[...(${group}).querySelectorAll('.phase-row .name')].map((n) => n.textContent)`);
    console.log(`  Phases listed: ${JSON.stringify(names)}`);
    t.check('and lists the cluster’s Phases through it', () => assert.ok(names.length > 0));
  }

  await setVars('');
  const after = await settle(base.tabs.length > 0);
  t.check('cleared, the cluster is back as it was, with no env tag', () => { assert.deepEqual(after.tabs, base.tabs); assert.equal(after.env, false); });
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
}

process.exit(t.finish());
