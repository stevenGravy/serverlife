#!/usr/bin/env node
/**
 * Phases from setups, and the Start a beam warning, in the real app.
 *
 * Start a beam says a beam started there cannot be saved as a Phase, and its
 * button opens New Phase instead. The Phases tab's "From setups…" opens the
 * builder, where adding setups to stages fills in phase.yaml and the check
 * passes. Reads and clicks only — never presses Start it or Build it, so
 * nothing is created. Needs a logged-in cluster that runs beams with a tsh
 * that has `tsh phase apply`, and skips without one.
 *
 * Leaves screenshots in $TMPDIR: serverlife-start-beam-warning.png and
 * serverlife-phase-builder.png.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, checks, sleep } from './harness.mjs';

const t = checks();
const shot = async (app, name) => {
  const s = await app.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(os.tmpdir(), name), Buffer.from(s.data, 'base64'));
};
const modalOpen = (title) => `[...document.querySelectorAll('.modal-head h2')].some((h) => h.textContent === ${JSON.stringify(title)})`;
const inModal = (title, body) => `(() => { const m = [...document.querySelectorAll('.modal')].find((x) => x.querySelector('h2')?.textContent === ${JSON.stringify(title)}); ${body} })()`;

const app = await start();
try {
  await app.setViewport(1440, 960);
  let ready = true;
  try {
    await app.waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')].some((r) => r.textContent.includes('Start a beam'))`,
      'a cluster with beams', 45000);
    await sleep(2500);
  } catch { ready = false; }
  const tabs = ready ? await app.evaluate(`document.querySelectorAll('.beam-tabs .beam-tab').length`) : 0;
  if (!ready || !tabs) {
    console.log('  skipped: no logged-in cluster with beams and Phases');
  } else {
    /* ---- Start a beam: the warning and its way out ---- */
    await app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')].find((r) => r.textContent.includes('Start a beam')).click()`);
    await app.waitFor(modalOpen('Start a beam'), 'Start a beam', 15000);
    await sleep(4000);
    const note = await app.evaluate(inModal('Start a beam', `const n = m.querySelector('.beam-save-note');
      return n ? { text: n.textContent, button: n.querySelector('button')?.textContent || '' } : null;`));
    await shot(app, 'serverlife-start-beam-warning.png');
    // Start from: the picker — the standard image first, your Phases, a search that narrows them.
    const picker = await app.evaluate(inModal('Start a beam', `const p = m.querySelector('.phase-picker');
      if (!p) return null;
      const names = () => [...p.querySelectorAll('.phase-pick .name')].map((n) => n.textContent);
      const all = names();
      const target = all.find((n) => n !== 'The standard image') || '';
      const s = p.querySelector('input'); s.value = target; s.dispatchEvent(new Event('input', { bubbles: true }));
      const narrowed = names();
      s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
      return { all, target, narrowed, folders: p.querySelectorAll('.phase-pick-folder').length };`));
    console.log(`  picker: ${JSON.stringify(picker)}`);
    t.check('Start from is a searchable Phase picker, the standard image first', () => {
      assert.ok(picker, 'no picker');
      assert.equal(picker.all[0], 'The standard image');
      assert.ok(picker.all.length > 1, 'no Phases listed');
    });
    t.check('searching narrows the list to the matching Phase', () => {
      assert.ok(picker.narrowed.includes(picker.target), JSON.stringify(picker.narrowed));
      assert.ok(picker.narrowed.length < picker.all.length, 'the search did not narrow anything');
    });
    t.check('Start a beam says the beam cannot be saved as a Phase', () => {
      assert.ok(note, 'no warning');
      assert.match(note.text, /can.t be saved as a Phase/);
    });
    t.check('…with a button to start a Phase build instead', () => assert.match(note?.button || '', /start a Phase build instead/i));
    await app.evaluate(inModal('Start a beam', `m.querySelector('.beam-save-note button').click();`));
    let switched = true;
    try { await app.waitFor(modalOpen('New Phase'), 'New Phase', 15000); } catch { switched = false; }
    t.check('the button closes Start a beam and opens New Phase', async () => {
      assert.ok(switched, 'New Phase did not open');
      assert.equal(await app.evaluate(modalOpen('Start a beam')), false, 'Start a beam is still open');
    });
    if (switched) await app.escape();
    await sleep(500);

    /* ---- The builder ---- */
    await app.clickOn('.beam-tabs .beam-tab:nth-child(2)');
    await app.waitFor(`[...document.querySelectorAll('.phase-add')].some((r) => r.textContent.includes('From setups'))`, 'From setups row', 30000);
    await app.evaluate(`[...document.querySelectorAll('.phase-add')].find((r) => r.textContent.includes('From setups')).click()`);
    const T = 'Build a Phase from setups';
    await app.waitFor(modalOpen(T), 'the builder', 20000);
    await app.waitFor(inModal(T, `return m.querySelector('.phase-problems').textContent.length > 0;`), 'the first check', 10000).catch(() => {});
    const fresh = await app.evaluate(inModal(T, `return m.querySelector('.phase-problems').textContent;`));
    t.check('a new, empty builder shows no errors yet (and no stray "null")', () => {
      assert.ok(!/✕/.test(fresh), fresh);
      assert.ok(!/null/.test(fresh), fresh);
      assert.match(fresh, /Add a setup to begin/);
    });
    // Stage 1: Go. Picked the way a person does: the "Add a setup…" list.
    const pick = (stageIndex, id) => app.evaluate(inModal(T, `const sel = [...m.querySelectorAll('select')].filter((s) => s.options[0]?.text === 'Add a setup…')[${stageIndex}];
      sel.value = ${JSON.stringify(id)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return true;`));
    await pick(0, 'go');
    await app.waitFor(inModal(T, `return (m.querySelector('.phase-yaml-view').dataset.yaml || '').includes('Install Go');`), 'Go in the YAML', 10000);
    // Stage 2: a copy stage with dotfiles.
    await app.evaluate(inModal(T, `[...m.querySelectorAll('button')].find((b) => b.textContent === '+ Add a stage').click(); return true;`));
    await sleep(300);
    await pick(1, 'dotfiles');
    await app.evaluate(inModal(T, `const ta = [...m.querySelectorAll('textarea')].pop(); ta.value = '~/.gitconfig';
      ta.dispatchEvent(new Event('input', { bubbles: true })); return true;`));
    await sleep(800);
    const seen = await app.evaluate(inModal(T, `return { yaml: m.querySelector('.phase-yaml-view').dataset.yaml || '',
      colored: m.querySelectorAll('.phase-yaml-view .cm-line span').length,
      problems: [...m.querySelectorAll('.phase-problems div')].map((d) => d.textContent) };`));
    await shot(app, 'serverlife-phase-builder.png');
    console.log(`  problems: ${JSON.stringify(seen.problems)}`);
    t.check('the phase.yaml view is colour-coded', () => assert.ok(seen.colored > 10, `only ${seen.colored} highlighted spans`));
    t.check('two stages, the second built on the first', () => {
      assert.equal(seen.yaml.split('\n---\n').length, 2);
      assert.match(seen.yaml, /from: my-setup\b/);
    });
    t.check('the copy stage brings dotfiles in with a pre-start service', () => {
      assert.match(seen.yaml, /to: \/opt\/serverlife\/home\/\.gitconfig/);
      assert.match(seen.yaml, /name: serverlife-home/);
    });
    t.check('the check passes (or names only a missing local file)', () => {
      const bad = seen.problems.filter((p) => p.startsWith('✕') && !/not on this computer/.test(p));
      assert.deepEqual(bad, []);
    });
    const buttons = await app.evaluate(inModal(T, `return [...m.querySelectorAll('.modal-foot button')].map((b) => b.textContent);`));
    t.check('the builder offers building it and then working in it interactively', () => {
      assert.ok(buttons.includes('Build it'), JSON.stringify(buttons));
      assert.ok(buttons.some((b) => b.startsWith('Build it, then work in it')), JSON.stringify(buttons));
    });
    const opens = await app.evaluate(inModal(T, `return [...m.querySelectorAll('button')].some((b) => b.textContent.startsWith('Open a phase.yaml'));`));
    t.check('the builder can open an existing phase.yaml', () => assert.ok(opens));
    // By hand: the text is what is built, the stages follow it, Escape stays in the editor.
    await app.evaluate(inModal(T, `[...m.querySelectorAll('button')].find((b) => b.textContent === 'Edit by hand').click(); return true;`));
    await sleep(300);
    const typed = '# my own\nversion: v1\nmetadata:\n  name: hand-made\ncommands:\n  - comment: Say hi\n    shell: echo hi\n';
    await app.evaluate(inModal(T, `const ed = [...m.querySelectorAll('.phase-yaml-view .yaml-editor')].find((x) => x.style.display !== 'none');
      ed.yamlView.setValue(${JSON.stringify(typed)}); ed.querySelector('.cm-content').focus(); return true;`));
    await sleep(900);
    const hand = await app.evaluate(inModal(T, `return { yaml: m.querySelector('.phase-yaml-view').dataset.yaml,
      problems: m.querySelector('.phase-problems').textContent,
      stageNames: [...m.querySelectorAll('input')].map((i) => i.value).filter((v) => v === 'hand-made') };`));
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    const stillOpen = await app.evaluate(modalOpen(T));
    t.check('Edit by hand: the typed text is the phase.yaml, comment and all, and it checks out', () => {
      assert.equal(hand.yaml, typed);
      assert.match(hand.problems, /tsh phase apply will accept this/);
    });
    t.check('the stages on the left follow the hand-written text', () => assert.equal(hand.stageNames.length, 1));
    t.check('Escape in the editor does not close the builder', () => assert.equal(stillOpen, true));
    await app.evaluate(inModal(T, `[...m.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Cancel').click(); return true;`));
    t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
  }
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
}

process.exit(t.finish());
