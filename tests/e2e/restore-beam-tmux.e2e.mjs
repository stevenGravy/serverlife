#!/usr/bin/env node
/**
 * A saved layout's tmux tab on a beam comes back attached after a restart.
 *
 * Beams are listed per cluster and not read yet when a layout is restored,
 * so a beam pane used to be skipped outright. This starts a tmux session of
 * its own on the beam named by SERVERLIFE_E2E_BEAM (`proxy:port:beam`, e.g.
 * `example.beams.sh:443:my-beam`), saves a layout holding it, reloads
 * with "Always restore" on, and checks the tab is attached to that session.
 * The session is killed at the end; nothing else on the beam is touched.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { start, checks, sleep } from './harness.mjs';

const spec = process.env.SERVERLIFE_E2E_BEAM || '';
const m = /^(.+):([^:]+)$/.exec(spec);
if (!m) { console.log('  skipped: set SERVERLIFE_E2E_BEAM=proxy:port:beam'); process.exit(0); }
const [, proxy, beam] = m;
const session = `sl-e2e-${process.pid}`;
const onBeam = (cmd) => execFileSync('tsh', [`--proxy=${proxy}`, 'beams', 'exec', beam, '--', cmd], { timeout: 90000 }).toString();

const t = checks();
onBeam(`tmux new-session -d -s ${session}`);
const app = await start();
try {
  await app.setViewport(1440, 960);
  await app.waitFor(`[...document.querySelectorAll('#sb-panel-hosts .sb-item .name')].some((n) => n.textContent === 'Local shell')`, 'the Hosts tab', 30000);
  const ws = {
    tabs: [{ title: `${session} · ${beam}`, kind: 'local', root: { type: 'pane', pane: {
      kind: 'tmux', hostId: `beam:${proxy}:${beam}`, local: false, label: beam, login: null, session,
    } } }],
    activeIndex: 0,
  };
  await app.evaluate(`window.api.settings.set({ autoRestoreWorkspace: true }).then(() => window.api.workspace.save(${JSON.stringify(ws)}))`);
  await app.reload();
  await app.waitFor(`[...document.querySelectorAll('.tab')].some((x) => x.textContent.includes('· ${beam}') && !x.textContent.startsWith('tmux · '))
    && document.querySelectorAll('.ptmux-ctl:not(.hidden)').length > 0`, 'the beam’s tmux tab, attached', 120000);
  await sleep(1500);
  const tabs = await app.evaluate(`[...document.querySelectorAll('.tab')].map((x) => x.textContent.trim())`);
  const clients = onBeam(`tmux list-clients -t ${session} -F '#{client_control_mode}'`).trim().split('\n').filter(Boolean);
  console.log(`  tabs: ${JSON.stringify(tabs)}  control clients on ${session}: ${clients.length}`);
  t.check('the beam’s tmux tab is restored, attached to the same session', () => assert.ok(clients.length >= 1, 'no client on the session'));
  const saved = await app.evaluate('window.api.workspace.get()');
  t.check('and is saved as tmux again', () => assert.ok(JSON.stringify(saved).includes(`"session":"${session}"`), JSON.stringify(saved)));
  t.check('no page errors', () => assert.deepEqual(app.pageErrors, []));
} catch (e) {
  t.fail('the run itself', e.message);
} finally {
  await app.stop();
  try { onBeam(`tmux kill-session -t ${session}`); } catch { /* already gone */ }
}
process.exit(t.finish());
