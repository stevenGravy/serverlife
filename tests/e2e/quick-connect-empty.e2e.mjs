#!/usr/bin/env node
/**
 * Quick connect with nothing recent: no stray "null".
 *
 * A fresh profile has no recent connections, so the dialog's Recent row is
 * absent — which a dialog body once printed as the word "null". Opens Quick
 * connect from the tab bar's + menu and reads its text. Changes nothing.
 */

import assert from 'node:assert/strict';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const app = await start();
try {
  await app.evaluate('window.api.settings.set({ quickConnects: [] })');
  await app.reload();
  // The tab bar's + offers it on right-click, as a person would find it.
  await app.evaluate(`document.querySelector('#tab-add').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 20 }))`);
  await app.waitFor(`!!document.querySelector('#ctxmenu-root .ctxmenu')`, 'the + menu', 5000);
  await app.evaluate(`[...document.querySelectorAll('#ctxmenu-root .ctxmenu button')].find((b) => b.textContent.includes('Quick connect')).click()`);
  await app.waitFor(`[...document.querySelectorAll('.modal-head h2')].some((h) => h.textContent === 'Quick connect')`, 'Quick connect', 10000);
  await sleep(300);
  const seen = await app.evaluate(`(() => { const m = [...document.querySelectorAll('.modal')].find((x) => x.querySelector('h2')?.textContent === 'Quick connect');
    return { text: m.querySelector('.modal-body').innerText, recent: !!m.querySelector('.qc-recent') }; })()`);
  t.check('with nothing recent there is no Recent row', () => assert.equal(seen.recent, false));
  t.check('and no stray "null" in the dialog', () => assert.ok(!/\bnull\b/.test(seen.text), seen.text.slice(0, 300)));
  await app.escape();
  t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
}
process.exit(t.finish());
