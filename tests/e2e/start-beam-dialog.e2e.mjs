#!/usr/bin/env node
/**
 * Start a beam…: the Phase and role choices appear only where tsh has them.
 *
 * Runs the real dialog twice against the real cluster — once with the tsh the
 * app finds on its own, and once with a second tsh named by
 * SERVERLIFE_E2E_TSH (one with Phases, say) through the app's own *tsh path*
 * setting. Reads what the dialog offers; never presses *Start it*, so no beam
 * is created. Needs a logged-in cluster that runs beams, and skips without one.
 *
 *   SERVERLIFE_E2E_TSH=/path/to/tsh19 make test-e2e
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { start, checks, sleep, execChosenTsh } from './harness.mjs';

const t = checks();

const helpOf = (tsh) => {
  try { return execFileSync(tsh, ['beams', 'add', '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return String(e.stdout || ''); }
};

async function readDialog(tshPath) {
  const app = await start();
  try {
    if (tshPath) await app.evaluate(`window.api.settings.set({ tshPath: ${JSON.stringify(tshPath)} })`);
    await app.reload();
    // The beams group fills in once the clusters have been read.
    try {
      await app.waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')].some((r) => r.textContent.includes('Start a beam'))`,
        'a cluster with beams', 45000);
    } catch { return null; }
    await app.evaluate(`[...document.querySelectorAll('#sb-panel-hosts .sb-item')]
      .find((r) => r.textContent.includes('Start a beam')).click()`);
    await app.waitFor(`[...document.querySelectorAll('.modal-head h2')].some((h) => h.textContent === 'Start a beam')`, 'the dialog', 15000);
    // Phases are read after the dialog opens; give tsh phase ls its moment.
    await sleep(6000);
    return await app.evaluate(`(() => {
      const m = [...document.querySelectorAll('.modal')].find((x) => x.querySelector('h2')?.textContent === 'Start a beam');
      const fields = [...m.querySelectorAll('.field')];
      const byLabel = (txt) => fields.find((f) => f.querySelector('label')?.textContent.startsWith(txt));
      const phase = byLabel('Start from');
      const roles = byLabel('Delegate roles');
      return {
        labels: fields.map((f) => f.querySelector('label')?.textContent || ''),
        phases: phase ? [...phase.querySelectorAll('option')].map((o) => o.value) : null,
        phaseNote: m.querySelector('.hint')?.textContent || '',
        roles: roles ? [...roles.querySelectorAll('label.check span')].map((s) => s.textContent) : null,
      };
    })()`);
  } finally {
    await app.stop();
  }
}

try {
  const found = await readDialog(null);
  if (!found) {
    console.log('  skipped: no logged-in cluster with beams');
  } else {
    console.log(`  app's own tsh: ${JSON.stringify(found)}`);
    const own = execFileSync('tsh', ['version'], { encoding: 'utf8' }).split('\n')[0];
    const hasPhase = /--phase[=\s]/.test(helpOf('tsh'));
    const hasRoles = /--roles[=\s]/.test(helpOf('tsh'));
    t.check(`${own}: Phase choice shown only if it has --phase (${hasPhase})`, () => {
      assert.equal(found.labels.includes('Start from') || /Phase/.test(found.phaseNote), hasPhase);
    });
    t.check(`${own}: role choice shown only if it has --roles (${hasRoles})`, () => {
      assert.equal(found.roles !== null, hasRoles);
    });
    t.check('the region choice is there either way', () => assert.ok(found.labels.includes('Region')));
  }

  const other = process.env.SERVERLIFE_E2E_TSH;
  if (other) {
    const v = execChosenTsh(other, ['version']).split('\n')[0];
    const seen = await readDialog(other);
    if (!seen) {
      console.log('  skipped the second tsh: no logged-in cluster with beams');
    } else {
      console.log(`  ${v}: ${JSON.stringify(seen)}`);
      t.check(`${v}: offers Phases, the standard image first`, () => {
        assert.ok(seen.phases, `no Start from field — ${seen.phaseNote}`);
        assert.equal(seen.phases[0], '');
        assert.ok(seen.phases.length > 1, 'no Phase listed');
      });
      t.check(`${v}: offers this login's roles to delegate`, () => {
        assert.ok(seen.roles && seen.roles.length, 'no Delegate roles field');
      });
    }
  }
} catch (e) {
  t.fail('the run itself', e.message);
}

process.exit(t.finish());
