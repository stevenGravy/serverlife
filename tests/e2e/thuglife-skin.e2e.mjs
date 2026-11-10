#!/usr/bin/env node
/**
 * The Thug Life skin: its bundled blackletter loads, and lands only where it
 * should.
 *
 * A font in the stylesheet can fail silently — a wrong path, the content
 * security policy, a file left out of the build — and the page simply falls
 * back to the next family, which still looks like *a* font. So this asks the
 * renderer whether the face actually loaded, and which elements use it: the
 * sidebar's headings and host names do, the terminal must not (blackletter is
 * not fixed-width, and a terminal drawn in it would not line up).
 *
 * Leaves a screenshot in $TMPDIR/serverlife-thuglife.png to look at.
 *
 *   make test-e2e        (builds first; see harness.mjs)
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
let app;

try {
  app = await start();
  await app.evaluate(`window.api.settings.set({ skin: 'thuglife' })`);
  await app.reload();
  await app.setViewport(1280, 800);

  // A pane, so there is a terminal to check is left alone.
  await app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')]
    .find((r) => r.textContent.includes('Local shell'))
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await app.waitFor(`!!document.querySelector('.pane .xterm')`, 'a terminal', 15000);
  await app.evaluate('document.fonts.ready.then(() => true)');
  await sleep(500);

  const seen = await app.evaluate(`(() => {
    const family = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).fontFamily : null; };
    return {
      skin: document.documentElement.dataset.skin,
      loaded: document.fonts.check('15px "UnifrakturMaguntia"'),
      faces: [...document.fonts].filter((f) => f.family.includes('UnifrakturMaguntia')).map((f) => f.status),
      heading: family('.sb-group-head'),
      hostName: family('.sb-item .name'),
      tab: family('.sb-tab'),
      terminal: family('.pane .xterm-rows') || family('.pane .xterm'),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    };
  })()`);
  console.log(`  ${JSON.stringify(seen)}`);

  t.check('the skin is applied', () => assert.equal(seen.skin, 'thuglife'));
  t.check('the bundled blackletter actually loaded', () => {
    assert.ok(seen.faces.includes('loaded'), `font face status: ${seen.faces.join(', ') || 'none declared'}`);
    assert.ok(seen.loaded);
  });
  t.check('sidebar headings, tabs and host names are set in it', () => {
    for (const [what, f] of [['heading', seen.heading], ['host name', seen.hostName], ['tab', seen.tab]]) {
      assert.match(f || '', /UnifrakturMaguntia/, `${what}: ${f}`);
    }
  });
  t.check('the terminal keeps its own font', () => {
    assert.ok(seen.terminal, 'no terminal found');
    assert.doesNotMatch(seen.terminal, /UnifrakturMaguntia/);
  });
  t.check('it is gold', () => assert.equal(seen.accent.toLowerCase(), '#d4af37'));

  const shot = await app.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(os.tmpdir(), 'serverlife-thuglife.png');
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  screenshot: ${file}`);
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
}

process.exit(t.finish());
