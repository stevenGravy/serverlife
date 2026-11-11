#!/usr/bin/env node
/**
 * Settings, in sections with a dropdown and a search.
 *
 * Opens Settings the way the app menu does, checks it is split into named
 * sections, that choosing one in the dropdown shows only it, and that a
 * search keeps only matching settings (with their explanations). Changes
 * nothing — the dialog is cancelled. Leaves a screenshot in
 * $TMPDIR/serverlife-settings.png.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const app = await start();
const inSettings = (body) => `(() => { const m = [...document.querySelectorAll('.modal')].find((x) => x.querySelector('h2')?.textContent === 'Settings'); ${body} })()`;
const visibleSections = () => app.evaluate(inSettings(`return [...m.querySelectorAll('.settings-section')].filter((s) => s.style.display !== 'none').map((s) => s.dataset.title);`));

try {
  await app.setViewport(1300, 950);
  // Through the title bar's search, as a person finds a setting: it opens Settings.
  await app.clickOn('#global-search');
  await app.evaluate(`(() => { const i = document.querySelector('#global-search'); i.value = 'Theme'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(700);
  for (const type of ['keyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await app.waitFor(`[...document.querySelectorAll('.modal-head h2')].some((h) => h.textContent === 'Settings')`, 'Settings', 10000);
  await sleep(900);
  const jumped = await app.evaluate(inSettings(`return m.querySelector('.settings-nav input').value;`));
  t.check('the title-bar search opens Settings filtered to what was asked', () => assert.equal(jumped, 'Theme'));
  await app.evaluate(inSettings(`const q = m.querySelector('.settings-nav input'); q.value = ''; q.dispatchEvent(new Event('input')); return true;`));
  await sleep(150);
  const all = await visibleSections();
  console.log(`  sections: ${JSON.stringify(all)}`);
  t.check('Settings is split into named sections', () => {
    assert.ok(all.length >= 10, `only ${all.length}`);
    for (const name of ['Teleport homes and tsh', 'Appearance', 'Sessions and the interface', 'Editors']) assert.ok(all.includes(name), `no ${name}`);
  });

  await app.evaluate(inSettings(`const s = m.querySelector('.settings-nav select'); s.value = [...s.options].find((o) => o.text === 'Appearance').value; s.dispatchEvent(new Event('change')); return true;`));
  await sleep(200);
  t.check('the dropdown shows one section', async () => assert.deepEqual(await visibleSections(), ['Appearance']));

  await app.evaluate(inSettings(`const s = m.querySelector('.settings-nav select'); s.value = ''; s.dispatchEvent(new Event('change'));
    const q = m.querySelector('.settings-nav input'); q.value = 'live stats'; q.dispatchEvent(new Event('input')); return true;`));
  await sleep(200);
  const found = await app.evaluate(inSettings(`return [...m.querySelectorAll('.settings-section')].filter((s) => s.style.display !== 'none')
    .flatMap((s) => [...s.children].filter((c) => c.style.display !== 'none' && !c.classList.contains('settings-section-title')).map((c) => c.textContent.slice(0, 60)));`));
  const shot = await app.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(os.tmpdir(), 'serverlife-settings.png'), Buffer.from(shot.data, 'base64'));
  console.log(`  "live stats": ${JSON.stringify(found)}`);
  t.check('a search keeps only the matching settings', () => {
    assert.ok(found.some((x) => /Live stats under each server session/.test(x)), 'the live stats switch is missing');
    assert.ok(found.length <= 6, `${found.length} things shown`);
  });

  await app.evaluate(inSettings(`const q = m.querySelector('.settings-nav input'); q.value = 'zzzz-nothing'; q.dispatchEvent(new Event('input')); return true;`));
  await sleep(150);
  t.check('a search that matches nothing says so', async () => assert.deepEqual(await visibleSections(), []));
  await app.evaluate(inSettings(`[...m.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Cancel').click(); return true;`));
  t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
}
process.exit(t.finish());
