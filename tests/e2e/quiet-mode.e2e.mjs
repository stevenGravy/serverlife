#!/usr/bin/env node
/**
 * Settings → "No background commands on servers": with it on, the app runs
 * nothing on a host by itself.
 *
 * Every command the app runs on an ssh-transport host is a local
 * `ssh … <script>` process, so they can be counted from outside: sample the
 * process list for the directory probe (`readlink "/proc/$p/cwd"`), the free
 * space footer (`df -Pk`) and the live stats (`SLMON`) while a real session
 * sits open, first with the switch off and then — turned on through the real
 * Settings dialog — with it on. Off, they appear; on, none do, and the stats
 * bar goes. Opens a session on a real node and types nothing into it. Skips
 * without a cluster.
 *
 *   SERVERLIFE_E2E_HOST=bms-app-service make test-e2e
 */

import assert from 'node:assert/strict';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const want = process.env.SERVERLIFE_E2E_HOST || '';
let app;

/** Background commands seen over `ms`, by kind, counted once per process. */
async function watch(ms) {
  const seen = { cwd: new Set(), df: new Set(), stats: new Set() };
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // This copy's processes only — not those of a ServerLife someone is using.
    for (const { pid, command: line } of app.descendants()) {
      if (!/\bssh\b|\btsh\b/.test(line)) continue;
      if (line.includes('/proc/$p/cwd')) seen.cwd.add(pid);
      if (line.includes('df -Pk')) seen.df.add(pid);
      if (line.includes('SLMON')) seen.stats.add(pid);
    }
    await sleep(120);
  }
  return { cwd: seen.cwd.size, df: seen.df.size, stats: seen.stats.size };
}

try {
  app = await start();
  await app.reload();
  await app.setViewport(1400, 900);
  try {
    await app.waitFor(`/nodes/.test(document.querySelector('#tsh-badge')?.textContent || '')
      && !/^0 nodes/.test(document.querySelector('#tsh-badge')?.textContent || '')`, 'a cluster with nodes', 60000);
  } catch {
    console.log('  skipped: no logged-in cluster with nodes');
    await app.stop();
    process.exit(t.finish());
  }
  await sleep(1500);
  const opened = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#sb-panel-hosts .sb-group .sb-items > .sb-item')]
      .filter((r) => !r.classList.contains('beam-add') && !r.classList.contains('phase-row')
        && !r.querySelector('.tag.beams, .tag.req, .tag.gone, .tag.stale') && r.querySelector('input[type=checkbox]'));
    const r = ${JSON.stringify(want)} ? rows.find((x) => x.querySelector('.name')?.textContent.trim() === ${JSON.stringify(want)}) : rows[0];
    if (!r) return null;
    r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return r.querySelector('.name').textContent.trim();
  })()`);
  assert.ok(opened, 'no node to open');
  console.log(`  opened a session on ${opened}`);
  await app.waitFor(`!!document.querySelector('.tab.active .dot.connected')`, 'the session to connect', 90000);
  await sleep(4000);

  // Off (the default): the app's own commands come and go.
  const before = await watch(20000);
  const barBefore = await app.evaluate(`!!document.querySelector('.pane-stats')`);
  console.log(`  switch off, 20s: ${JSON.stringify(before)}; stats bar ${barBefore ? 'shown' : 'absent'}`);
  t.check('with the switch off, the app does run background commands (so the test can see them)', () => {
    assert.ok(before.cwd + before.df + before.stats > 0, JSON.stringify(before));
  });

  // On, through Settings itself: search for the switch, tick it, Save.
  await app.clickOn('#global-search');
  await app.evaluate(`(() => { const i = document.querySelector('#global-search'); i.value = 'No background commands'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(700);
  for (const type of ['keyDown', 'keyUp']) await app.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await app.waitFor(`[...document.querySelectorAll('.modal label.check span')].some((s) => s.textContent.startsWith('No background commands'))`, 'Settings', 10000);
  const ticked = await app.evaluate(`(() => {
    const box = [...document.querySelectorAll('.modal label.check')].find((l) => l.textContent.startsWith('No background commands')).querySelector('input');
    box.click();
    const stats = [...document.querySelectorAll('.modal label.check')].find((l) => l.textContent.startsWith('Live stats under')).querySelector('input');
    return { quiet: box.checked, statsDisabled: stats.disabled };
  })()`);
  t.check('ticking it greys out the live stats switch it overrides', () => assert.deepEqual(ticked, { quiet: true, statsDisabled: true }));
  await app.evaluate(`[...[...document.querySelectorAll('.modal')].pop().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click()`);
  await sleep(3000);   // let anything already in flight finish

  const after = await watch(20000);
  const barAfter = await app.evaluate(`!!document.querySelector('.pane-stats')`);
  console.log(`  switch on, 20s: ${JSON.stringify(after)}; stats bar ${barAfter ? 'shown' : 'absent'}`);
  t.check('with it on, no folder probe, no df, no live stats', () => assert.deepEqual(after, { cwd: 0, df: 0, stats: 0 }));
  t.check('and the stats bar is gone', () => assert.equal(barAfter, false));

} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
}

process.exit(t.finish());
