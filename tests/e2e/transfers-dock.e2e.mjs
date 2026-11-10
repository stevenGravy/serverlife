#!/usr/bin/env node
/**
 * The Transfers tab of the dock holds still.
 *
 * Fitted to its content, the dock grew a row at a time as a sync queued its
 * files and shrank as they finished, so the terminal above it jumped with
 * every one; opening it for an upload threw it to whatever height it had last
 * been dragged to on another tab. Now it is one fixed, small height. This
 * checks that in the real app: open it with a tall drag remembered, fill it
 * a row at a time, switch away and back, close and reopen — and watch both
 * the dock and the pane above it for any movement.
 *
 *   make test-e2e        (builds first; see harness.mjs)
 */

import assert from 'node:assert/strict';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
let app;

const measure = () => app.evaluate(`(() => {
  const d = document.querySelector('#dock');
  const panel = document.querySelector('#dock-transfers');
  return {
    shown: !d.classList.contains('hidden'),
    height: Math.round(d.getBoundingClientRect().height),
    // The bottom edge of the workspace above: this is what "jumping" moves.
    above: Math.round(document.querySelector('#bottom-resizer').getBoundingClientRect().top),
    scrolls: panel.scrollHeight > panel.clientHeight,
  };
})()`);

try {
  app = await start();
  // A dock once dragged tall on another tab: transfers must not inherit it.
  await app.evaluate(`window.api.settings.set({ panelSizes: { '#bottom-resizer': 420 } })`);
  await app.reload();
  await app.setViewport(1400, 1000);

  await app.clickOn('#titlebar-actions [data-action="toggle-transfers"]');
  await app.waitFor(`!document.querySelector('#dock').classList.contains('hidden')`, 'the dock to open', 5000);
  await sleep(200);
  const opened = await measure();
  console.log(`  opened at ${opened.height}px`);

  t.check('it opens at the small fixed height, not the tall remembered one', () => {
    assert.ok(opened.height >= 108 && opened.height <= 140, `${opened.height}px`);
  });

  // A sync queuing its files into an empty queue: rows arrive one at a time.
  await app.evaluate(`document.querySelector('#dock-transfers').replaceChildren()`);
  await sleep(150);
  const heights = [];
  const edges = [];
  for (let i = 1; i <= 20; i++) {
    await app.evaluate(`(() => {
      const row = document.createElement('div');
      row.className = 'xfer-row running';
      row.innerHTML = '<div class="xlabel"><div class="main">file-${i}.tar.gz</div><div class="sub">queued</div></div>';
      document.querySelector('#dock-transfers').append(row);
    })()`);
    await sleep(60);
    const m = await measure();
    heights.push(m.height);
    edges.push(m.above);
  }
  const full = await measure();
  console.log(`  with 20 rows: ${full.height}px${full.scrolls ? ', scrolling' : ''}`);

  t.check('rows arriving do not change its height', () => {
    assert.deepEqual([...new Set(heights)], [opened.height]);
  });
  t.check('and the pane above it does not move', () => {
    assert.deepEqual([...new Set(edges)], [opened.above]);
  });
  t.check('a long queue scrolls inside it instead', () => assert.ok(full.scrolls));

  // Away to a tab that sizes to its content, and back.
  await app.clickOn('.dock-tab[data-dock="multiexec"]');
  await sleep(200);
  await app.clickOn('.dock-tab[data-dock="transfers"]');
  await sleep(200);
  const back = await measure();
  t.check('back on Transfers, it is the same height again', () => assert.equal(back.height, opened.height));

  // Closed, then opened again for the next upload.
  await app.clickOn('#titlebar-actions [data-action="toggle-transfers"]');
  await app.waitFor(`document.querySelector('#dock').classList.contains('hidden')`, 'the dock to close', 5000);
  await app.clickOn('#titlebar-actions [data-action="toggle-transfers"]');
  await app.waitFor(`!document.querySelector('#dock').classList.contains('hidden')`, 'the dock to reopen', 5000);
  await sleep(200);
  const again = await measure();
  t.check('reopened, it is the same height again', () => assert.equal(again.height, opened.height));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
}

process.exit(t.finish());
