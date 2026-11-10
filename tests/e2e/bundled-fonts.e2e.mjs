#!/usr/bin/env node
/**
 * The bundled fonts: every one loads, the fixed-width ones really are, and
 * the font pickers offer them.
 *
 * A font in a stylesheet fails quietly — a wrong file name, the content
 * security policy, a file left out of the build — and the page falls back to
 * the next family, which still looks like *a* font. And whether a face is
 * fixed-width is a property of the file, not of its name: Google's own
 * catalogue files several monospaced fonts under sans-serif. So this asks the
 * renderer: load each face, then measure a run of narrow letters against a run
 * of wide ones.
 *
 *   make test-e2e        (builds first; see harness.mjs)
 */

import assert from 'node:assert/strict';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
let app;

try {
  app = await start();
  await app.reload();

  const fonts = await app.evaluate(`(async () => {
    const faces = [...document.fonts];
    const families = [...new Set(faces.map((f) => f.family.replace(/^["']|["']$/g, '')))];
    const out = [];
    for (const family of families) {
      let status = 'error';
      try { await document.fonts.load('32px "' + family + '"'); status = document.fonts.check('32px "' + family + '"') ? 'loaded' : 'missing'; }
      catch { status = 'error'; }
      const c = document.createElement('canvas').getContext('2d');
      c.font = '32px "' + family + '", serif';
      const narrow = c.measureText('iiiiiiiiii').width;
      const wide = c.measureText('WWWWWWWWWW').width;
      out.push({ family, status, narrow, wide });
    }
    return out;
  })()`);
  const fixedList = await app.evaluate(`(async () => {
    // The list the pickers are built from, as the renderer has it.
    const sel = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href'));
    return sel;
  })()`);

  t.check('fonts.css is loaded ahead of styles.css', () => {
    const names = fixedList.map((h) => h.split('/').pop());
    assert.ok(names.includes('fonts.css') && names.indexOf('fonts.css') < names.indexOf('styles.css'), names.join(', '));
  });
  t.check('all 51 bundled faces are declared', () => assert.equal(fonts.length, 51, fonts.map((f) => f.family).join(', ')));
  t.check('every one of them loads', () => {
    const bad = fonts.filter((f) => f.status !== 'loaded');
    assert.deepEqual(bad.map((f) => `${f.family}: ${f.status}`), []);
  });

  // Open Settings the way a person can from inside the window: search for the
  // setting and press Enter. (The menu bar's Settings is native, out of reach.)
  await app.clickOn('#global-search');
  await app.evaluate(`(() => { const i = document.querySelector('#global-search');
    i.value = 'Font family'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(700);
  for (const type of ['keyDown', 'keyUp']) {
    await app.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  const groups = await app.evaluate(`(async () => {
    for (let i = 0; i < 40; i++) {
      const sel = [...document.querySelectorAll('.modal select')].find((s) => [...s.options].some((o) => o.value === '__other'));
      if (sel) return [...sel.querySelectorAll('optgroup')].map((g) => ({ label: g.label, fonts: [...g.children].map((o) => o.value) }));
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  })()`);
  if (!groups) {
    t.fail('the Settings font picker', 'could not open Settings to read it');
  } else {
    const fixed = groups.find((g) => g.label === 'Bundled with ServerLife')?.fonts || [];
    const display = groups.find((g) => g.label.startsWith('Bundled display fonts'))?.fonts || [];
    console.log(`  picker: ${groups.map((g) => `${g.label} (${g.fonts.length})`).join(' · ')}`);
    t.check('the picker offers 42 bundled fixed-width fonts and 9 display fonts', () => {
      assert.equal(fixed.length, 42);
      assert.equal(display.length, 9);
    });
    t.check('the ones offered as fixed-width are fixed-width', () => {
      const byName = new Map(fonts.map((f) => [f.family, f]));
      const off = fixed.map((n) => byName.get(n)).filter((f) => !f || Math.abs(f.narrow - f.wide) > 0.5);
      assert.deepEqual(off.map((f) => f ? `${f.family} (i ${f.narrow.toFixed(1)} vs W ${f.wide.toFixed(1)})` : 'missing'), []);
    });
    t.check('and the display ones are labelled as not', () => {
      assert.ok(display.includes('UnifrakturMaguntia') && display.includes('Creepster'));
    });
    t.check('a bundled font is not listed twice as installed', () => {
      const installed = groups.find((g) => g.label === 'Installed on this machine')?.fonts || [];
      assert.deepEqual(installed.filter((f) => fixed.includes(f) || display.includes(f)), []);
    });
  }
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
}

process.exit(t.finish());
