#!/usr/bin/env node
/**
 * Building Phases through the app, for real: a cluster gets two new Phases and
 * then loses them again.
 *
 *   1. New Phase… → built on top of an existing Phase (--from) from a command
 *      file (--commands-file): no console, the log streams in the tab.
 *   2. Right-click a Phase → Fork into a new Phase… (--fork-from): the build
 *      console opens in a tab, and `tsh phase snapshot --final` is typed in.
 *   3. Each new Phase is listed, its history names the Phase it came from, and
 *      then it is deleted with the Phase menu's Delete Phase….
 *
 * Opt-in, since it builds images on a real cluster: SERVERLIFE_E2E_BUILD_PHASES=1,
 * with SERVERLIFE_E2E_TSH a tsh that has Phases and SERVERLIFE_E2E_PHASE an
 * existing ready Phase to build from (default: the first one listed). Every
 * Phase it makes is named sl-e2e-…, and removed again whether the run passed
 * or not. Screenshots go to $TMPDIR/serverlife-phase-build-*.png.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep, execChosenTsh } from './harness.mjs';

const t = checks();
const tsh = process.env.SERVERLIFE_E2E_TSH;
const PROXY = process.env.SERVERLIFE_E2E_PROXY || 'red-fire.beams.sh:443';
if (process.env.SERVERLIFE_E2E_BUILD_PHASES !== '1' || !tsh) {
  console.log('  skipped: set SERVERLIFE_E2E_BUILD_PHASES=1 and SERVERLIFE_E2E_TSH to build real Phases');
  process.exit(0);
}

const stamp = Date.now().toString(36);
const FROM_NAME = `sl-e2e-from-${stamp}`;
const FORK_NAME = `sl-e2e-fork-${stamp}`;
const made = new Set();
const tmp = os.tmpdir();

const phaseLs = () => JSON.parse(execChosenTsh(tsh, [`--proxy=${PROXY}`, 'phase', 'ls', '--format=json']) || '[]');
const findPhase = (name) => phaseLs().find((p) => p.name === name) || null;

async function shot(app, label) {
  const s = await app.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(tmp, `serverlife-phase-build-${label}.png`);
  writeFileSync(file, Buffer.from(s.data, 'base64'));
  console.log(`  screenshot: ${file}`);
}

/*
 * What the build tab shows. xterm draws on a canvas, so the text is taken
 * where it passes through the preload bridge on its way there — the same
 * stream the terminal is drawn from — per terminal, with how each one ended.
 */
const tapTerminals = (app) => app.evaluate(`(() => {
  window.__e2eTerm = { out: {}, order: [], exit: {} };
  window.api.localTerm.onData(({ id, data }) => {
    const t = window.__e2eTerm;
    if (!(id in t.out)) { t.out[id] = ''; t.order.push(id); }
    t.out[id] = (t.out[id] + data).slice(-60000);
  });
  window.api.localTerm.onExit(({ id, exitCode }) => { window.__e2eTerm.exit[id] = exitCode; });
  return true;
})()`);
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
const OSC = new RegExp(ESC + '\\][^' + BEL + ']*' + BEL, 'g');
const newestTerm = (app) => app.evaluate(`window.__e2eTerm.order[window.__e2eTerm.order.length - 1] || null`);
const termText = async (app, id) => {
  const raw = await app.evaluate(`window.__e2eTerm.out[${JSON.stringify(id)}] || ''`);
  // Colours, cursor moves and titles out; what is left is what was printed.
  return raw.replace(CSI, '').replace(OSC, '').replace(/\r/g, '');
};
const termExit = (app, id) => app.evaluate(`window.__e2eTerm.exit[${JSON.stringify(id)}] ?? null`);

/** Wait for a Phase to reach ready (or fail), watching from outside the app. */
async function waitForPhase(app, name, minutes) {
  const until = Date.now() + minutes * 60000;
  let last = null;
  while (Date.now() < until) {
    try { last = findPhase(name); } catch { /* the list call failed once; try again */ }
    if (last && /ready|fail|error/i.test(last.state || '')) return last;
    await sleep(10000);
  }
  return last;
}

async function setField(app, labelText, value, kind = 'input') {
  await app.evaluate(`(() => {
    const m = [...document.querySelectorAll('.modal')].pop();
    const f = [...m.querySelectorAll('.field')].find((x) => x.querySelector('.field-label')?.textContent === ${JSON.stringify(labelText)});
    const n = f.querySelector(${JSON.stringify(kind)});
    n.value = ${JSON.stringify(value)};
    n.dispatchEvent(new Event(${JSON.stringify(kind === 'select' ? 'change' : 'input')}, { bubbles: true }));
  })()`);
}
const preview = (app) => app.evaluate(`[...document.querySelectorAll('.modal')].pop().querySelector('div[style*="var(--mono)"]')?.textContent || ''`);
const pressButton = (app, text) => app.evaluate(`(() => {
  const b = [...[...document.querySelectorAll('.modal')].pop().querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
  if (!b) return false; b.click(); return true; })()`);

async function rightClickPhase(app, name) {
  const r = await app.evaluate(`(() => { const row = [...document.querySelectorAll('.phase-row')].find((x) => x.querySelector('.name')?.textContent === ${JSON.stringify(name)});
    if (!row) return null; row.scrollIntoView({ block: 'nearest' }); const b = row.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  if (!r) {
    // Say what was there instead, for the next look at a failure.
    const seen = await app.evaluate(`[...document.querySelectorAll('.beam-tabs, .phase-row, .sb-empty')].map((x) => x.textContent.trim()).join(' | ')`);
    console.log(`  no row for ${name}; the section showed: ${seen.slice(0, 600)}`);
    return false;
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await app.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
  }
  await app.waitFor(`!!document.querySelector('#ctxmenu-root > .ctxmenu')`, 'the Phase menu', 5000);
  return true;
}
const menuClick = (app, starts) => app.evaluate(`(() => {
  const b = [...document.querySelectorAll('#ctxmenu-root > .ctxmenu > button')].find((x) => x.textContent.replace(/^\\W+/, '').startsWith(${JSON.stringify(starts)}));
  if (!b) return false; b.click(); return true; })()`);

async function openPhasesTab(app) {
  await app.clickOn('.beam-tabs .beam-tab:nth-child(2)');
  await app.waitFor(`document.querySelectorAll('.phase-row').length > 0`, 'the Phases tab', 60000);
}
async function refreshPhasesTab(app) {
  await app.evaluate(`document.querySelector('.beam-tab-refresh')?.click()`);
  await sleep(4000);
}

let app;
try {
  const ready = phaseLs().filter((p) => p.state === 'ready');
  const base = process.env.SERVERLIFE_E2E_PHASE || ready[0]?.name;
  if (!base) throw new Error('No ready Phase to build from');
  console.log(`  building from ${base}; new Phases: ${FROM_NAME}, ${FORK_NAME}`);

  app = await start();
  await app.evaluate(`window.api.settings.set({ tshPath: ${JSON.stringify(tsh)} })`);
  await app.reload();
  await tapTerminals(app);
  await app.setViewport(1400, 950);
  await app.waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')].some((r) => r.textContent.includes('Start a beam'))`, 'beams', 60000);
  await openPhasesTab(app);

  /* ---- 1. --from + --commands-file, through New Phase… ---- */
  const yaml = path.join(tmp, `sl-e2e-build-${stamp}.yaml`);
  writeFileSync(yaml, [
    'commands:',
    // The raw format: command and args. (shell: is only for tsh phase apply.)
    '  - comment: Leave a mark',
    '    command: /bin/sh',
    `    args: ["-c", "echo built-by-serverlife-${stamp} > /opt/serverlife-e2e.txt"]`,
    '',
  ].join('\n'));
  await app.evaluate(`[...document.querySelectorAll('.phase-add')].pop().click()`);
  await app.waitFor(`[...document.querySelectorAll('.modal-head h2')].some((h) => h.textContent === 'New Phase')`, 'New Phase', 10000);
  await setField(app, 'Name', FROM_NAME);
  await setField(app, 'Start from', 'from', 'select');
  await setField(app, 'Phase', base);
  await setField(app, 'Build it', 'file', 'select');
  await setField(app, 'Command file', yaml);
  await sleep(600);
  const cmd1 = await preview(app);
  console.log(`  preview: ${cmd1}`);
  t.check('New Phase previews --from and --commands-file', () => {
    assert.match(cmd1, new RegExp(`phase add ${FROM_NAME} --from=${base} --commands-file=`));
  });
  assert.ok(await pressButton(app, 'Start the build'), 'no Start the build button');
  made.add(FROM_NAME);
  await sleep(8000);
  const term1 = await newestTerm(app);
  await shot(app, '1-commands-file');
  const built1 = await waitForPhase(app, FROM_NAME, 20);
  console.log(`  ${FROM_NAME}: ${JSON.stringify(built1)}`);
  await sleep(5000);
  console.log(`  tab said (exit ${await termExit(app, term1)}):\n${(await termText(app, term1)).split('\n').filter((l) => l.trim()).slice(-14).join('\n')}`);
  t.check('the command-file build becomes a ready Phase', () => assert.equal(built1?.state, 'ready'));
  t.check('built on the Phase it was asked for', () => assert.equal(String(built1?.parent || '').split('@')[0], base));

  /* ---- 2. --fork-from, from the Phase's own menu, in a build console ---- */
  await refreshPhasesTab(app);
  assert.ok(await rightClickPhase(app, base), `no row for ${base}`);
  assert.ok(await menuClick(app, 'Fork into a new Phase'), 'no Fork into a new Phase item');
  await app.waitFor(`[...document.querySelectorAll('.modal-head h2')].some((h) => h.textContent === 'New Phase')`, 'New Phase', 10000);
  await setField(app, 'Name', FORK_NAME);
  await sleep(600);
  const cmd2 = await preview(app);
  console.log(`  preview: ${cmd2}`);
  t.check('Fork into a new Phase previews --fork-from', () => {
    assert.match(cmd2, new RegExp(`phase add ${FORK_NAME} --fork-from=${base}`));
  });
  assert.ok(await pressButton(app, 'Start the build'), 'no Start the build button');
  made.add(FORK_NAME);
  // The console is ready when the build beam's shell prompt is on screen.
  await sleep(3000);
  const term2 = await newestTerm(app);
  let consoleUp = false;
  for (let i = 0; i < 60 && !consoleUp; i++) {
    await sleep(10000);
    const text = await termText(app, term2);
    consoleUp = /beams@[^\n]*[$#]\s*$/.test(text.trimEnd() + ' ') || /beams@\S+[^\n]*\$ ?$/m.test(text);
    if (await termExit(app, term2) !== null) break;
    if (i % 3 === 0) console.log(`  waiting for the build console… ${text.split('\n').filter((l) => l.trim()).slice(-1)[0] || ''}`);
  }
  await shot(app, '2-fork-console');
  t.check('the fork opens a build console in a tab', () => assert.ok(consoleUp, 'no shell prompt appeared'));
  if (consoleUp) {
    // Typed into that terminal, as the keyboard would.
    await app.evaluate(`window.api.localTerm.write(${JSON.stringify(term2)}, 'tsh phase snapshot --final\\r')`);
  } else {
    console.log(`  the tab said:\n${(await termText(app, term2)).split('\n').filter((l) => l.trim()).slice(-14).join('\n')}`);
  }
  const built2 = await waitForPhase(app, FORK_NAME, 20);
  console.log(`  ${FORK_NAME}: ${JSON.stringify(built2)}`);
  await sleep(8000);
  console.log(`  tab said (exit ${await termExit(app, term2)}):\n${(await termText(app, term2)).split('\n').filter((l) => l.trim()).slice(-14).join('\n')}`);
  await shot(app, '3-fork-saved');
  t.check('the forked build, saved with snapshot --final, becomes a ready Phase', () => assert.equal(built2?.state, 'ready'));

  /* ---- 3. history, then delete both through the app ---- */
  await refreshPhasesTab(app);
  assert.ok(await rightClickPhase(app, base), `no row for ${base}`);
  assert.ok(await menuClick(app, 'History and beams'), 'no History and beams item');
  await sleep(1500);
  const history = await app.evaluate(`[...document.querySelectorAll('.modal')].pop().innerText`);
  await shot(app, '4-history');
  t.check(`${base}'s history lists the Phases built and forked from it`, () => {
    if (built1?.state === 'ready') assert.ok(history.includes(FROM_NAME), history);
    if (built2?.state === 'ready') assert.ok(history.includes('forked: ' + FORK_NAME), history);
  });
  await pressButton(app, 'Close');
  // And the fork's own history names the Phase it was forked from — which
  // tsh's list does not keep (its parent is the base image).
  if (built2?.state === 'ready') {
    await sleep(500);
    assert.ok(await rightClickPhase(app, FORK_NAME), `no row for ${FORK_NAME}`);
    assert.ok(await menuClick(app, 'History and beams'), 'no History and beams item');
    await sleep(1500);
    const forkHistory = await app.evaluate(`[...document.querySelectorAll('.modal')].pop().innerText`);
    console.log(`  ${FORK_NAME} history:\n${forkHistory.split('\n').slice(0, 14).join('\n')}`);
    await shot(app, '5-fork-history');
    t.check(`${FORK_NAME}'s history says it was forked from ${base}`, () => {
      assert.ok(forkHistory.includes(base) && forkHistory.includes('forked from the one above'), forkHistory);
      assert.match(forkHistory, /forked from .* · build console · saved/);
    });
    await pressButton(app, 'Close');
  }

  for (const name of [...made]) {
    if (!findPhase(name)) continue;
    assert.ok(await rightClickPhase(app, name), `no row for ${name}`);
    assert.ok(await menuClick(app, 'Delete Phase'), 'no Delete Phase item');
    await app.waitFor(`[...document.querySelectorAll('.modal button')].some((b) => b.textContent.trim() === 'Delete it')`, 'the delete confirmation', 5000);
    await pressButton(app, 'Delete it');
    await sleep(8000);
    t.check(`Delete Phase… removes ${name}`, () => assert.equal(findPhase(name), null));
    if (!findPhase(name)) made.delete(name);
    await refreshPhasesTab(app);
  }
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app?.stop();
  // Whatever happened, take away what was made.
  for (const name of made) {
    try { execChosenTsh(tsh, [`--proxy=${PROXY}`, 'phase', 'rm', name]); console.log(`  cleaned up ${name}`); }
    catch (e) { console.log(`  could not remove ${name}: ${e.message}`); }
  }
}

process.exit(t.finish());
