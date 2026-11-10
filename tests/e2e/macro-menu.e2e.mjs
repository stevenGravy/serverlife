#!/usr/bin/env node
/**
 * The macro menu in the real app, at several window heights.
 *
 * Whether a menu fits is a question of layout — row heights, fonts, the
 * window — which nothing short of a renderer can answer, so this gives a
 * throwaway copy of the app a long macro list and opens the ▶ menu with
 * genuine clicks while the viewport is made shorter and shorter.
 *
 * What has to hold:
 *   - with room for everything, nothing is folded into a submenu;
 *   - without, the largest categories fold first, and only as many as needed —
 *     a short one stays listed;
 *   - the menu, and any submenu opened from it, is always inside the window.
 *
 *   make test-e2e        (builds first; see harness.mjs)
 */

import assert from 'node:assert/strict';
import { start, checks, sleep } from './harness.mjs';

const LONG = 'E2E Long';
const MID = 'E2E Mid';
const SHORT = 'E2E Short';
const SEED = [[LONG, 14], [MID, 6], [SHORT, 2]];

const t = checks();
let app;

/** What the open menu looks like: which categories are listed, which folded, and where it sits. */
const readMenu = () => app.evaluate(`(() => {
  const m = document.querySelector('#ctxmenu-root > .ctxmenu');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  // A folded category is a submenu row with no "?" — every macro row has one.
  const folded = [...m.querySelectorAll(':scope > button.has-sub')]
    .filter((b) => !b.querySelector('.ctx-help'))
    .map((b) => b.querySelector(':scope > span:not(.key):not(.ctx-icon)').textContent);
  return {
    top: r.top, bottom: r.bottom, inner: innerHeight,
    open: [...m.querySelectorAll(':scope > .ctx-heading')].map((h) => h.textContent),
    folded,
    scrolls: m.scrollHeight > m.clientHeight,
  };
})()`);

try {
  app = await start();

  // A long list in three sizes, saved for everywhere so a local shell has them.
  for (const [category, n] of SEED) {
    for (let i = 1; i <= n; i++) {
      await app.evaluate(`window.api.macros.save(${JSON.stringify({
        name: `${category} ${i}`, category, command: 'true', where: 'all',
      })})`);
    }
  }
  await app.reload();

  await app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')]
    .find((r) => r.textContent.includes('Local shell'))
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await app.waitFor(`(() => { const b = document.querySelector('.pane .pmacro');
    return b && b.getBoundingClientRect().width > 0; })()`, 'a pane with a ▶ button');
  await sleep(800);   // the shell starting, and focus settling on it

  const seen = {};
  for (const height of [1600, 1000, 760, 560, 320]) {
    await app.setViewport(1400, height);
    const at = await app.clickOn('.pane .pmacro');
    const menuOpen = `!!document.querySelector('#ctxmenu-root > .ctxmenu')`;
    try {
      // Once more if the first click came before the pane had settled.
      try {
        await app.waitFor(menuOpen, `the menu at ${height}px`, 2500);
      } catch {
        await app.click(at.x, at.y);
        await app.waitFor(menuOpen, `the menu at ${height}px`, 5000);
      }
    } catch (e) {
      // Say what the click actually landed on: an overlay, a modal, the wrong pane.
      const hit = await app.evaluate(`(() => { const el = document.elementFromPoint(${at.x}, ${at.y});
        return { hit: el ? el.outerHTML.slice(0, 160) : null,
          toast: [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | ') || null }; })()`);
      throw new Error(`${e.message} — ${JSON.stringify({ ...hit, errors: app.pageErrors.slice(-5) })}`, { cause: e });
    }
    const m = await readMenu();
    seen[height] = m;
    console.log(`  ${String(height).padStart(4)}px  open: ${m.open.join(', ') || '—'}  ·  folded: `
      + `${m.folded.join(', ') || '—'}${m.scrolls ? '  ·  scrolls' : ''}`);

    t.check(`${height}px: the menu is inside the window`, () => {
      assert.ok(m.top >= 0, `top at ${m.top}`);
      assert.ok(m.bottom <= m.inner, `bottom at ${m.bottom} of ${m.inner}`);
    });
    t.check(`${height}px: a category is either listed or folded, never both or neither`, () => {
      for (const [c] of SEED) assert.equal(m.open.includes(c) + m.folded.includes(c), 1, c);
    });
    t.check(`${height}px: folding takes the largest first`, () => {
      const order = [LONG, MID, SHORT];
      const foldedSeed = order.filter((c) => m.folded.includes(c));
      assert.deepEqual(foldedSeed, order.slice(0, foldedSeed.length));
    });
    t.check(`${height}px: it only scrolls once there is nothing left to fold`, () => {
      if (m.scrolls) assert.equal(m.open.length, 0, `still listed: ${m.open.join(', ')}`);
    });

    // A folded category opens on screen, and that is where its macros are.
    if (m.folded.includes(LONG)) {
      const row = await app.evaluate(`(() => {
        const b = [...document.querySelectorAll('#ctxmenu-root > .ctxmenu > button.has-sub')]
          .find((x) => x.textContent.startsWith(${JSON.stringify(LONG)}));
        // In a menu that scrolls, the row may be out of sight; a person would scroll to it.
        b.scrollIntoView({ block: 'nearest' });
        const r = b.getBoundingClientRect();
        return { x: r.left + 30, y: r.top + r.height / 2 };
      })()`);
      await app.click(row.x, row.y);
      // In a short window the menu covers the ▶ button, so the pointer left
      // there may have opened another category's panel; it closes on a timer.
      await sleep(500);
      const sub = await app.evaluate(`(() => {
        const s = [...document.querySelectorAll('#ctxmenu-root .ctxsub')].pop();
        if (!s) return null;
        const r = s.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, inner: innerHeight,
          macros: [...s.querySelectorAll(':scope > button')].length };
      })()`);
      t.check(`${height}px: a folded category opens, inside the window, with its macros`, () => {
        assert.ok(sub, 'no submenu opened');
        assert.equal(sub.macros, 14);
        assert.ok(sub.top >= 0 && sub.bottom <= sub.inner, `submenu at ${sub.top}–${sub.bottom} of ${sub.inner}`);
      });
    }
    await app.escape();
    await app.waitFor(`!document.querySelector('#ctxmenu-root > .ctxmenu')`, 'the menu to close', 3000);
  }

  t.check('with room for everything, nothing is folded', () => {
    assert.deepEqual(seen[1600].folded, []);
  });
  t.check('in between, the long category folds and the short one stays listed', () => {
    const partial = Object.values(seen).find((m) => m.folded.length && m.open.length);
    assert.ok(partial, 'no height showed some categories listed and some folded');
    assert.ok(partial.folded.includes(LONG));
    assert.ok(partial.open.includes(SHORT));
  });
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
}

process.exit(t.finish());
