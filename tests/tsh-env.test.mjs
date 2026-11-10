import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const teleport = require_(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));

/**
 * Variables for tsh from Settings: for every cluster, and per cluster on top.
 * TELEPORT_TOOLS_VERSION set for one cluster makes the same tsh another
 * version for that cluster alone, so which command gets which matters.
 */

test.after(() => { teleport.setEnvSettings({}); teleport.setTshPath(''); });

test('NAME=value lines, as the docs write them', () => {
  assert.deepEqual(teleport.parseEnvText('TELEPORT_TOOLS_VERSION=18.11.9'), { vars: { TELEPORT_TOOLS_VERSION: '18.11.9' }, errors: [] });
});

test('a line pasted from a shell profile reads the same: export, quotes', () => {
  assert.deepEqual(teleport.parseEnvText(`export TELEPORT_TOOLS_VERSION="18.11.9"\nA='x y'`).vars,
    { TELEPORT_TOOLS_VERSION: '18.11.9', A: 'x y' });
});

test('blank lines and comments are skipped; anything else is reported by line', () => {
  const r = teleport.parseEnvText('\n# a comment\nGOOD=1\nnot an assignment\n9BAD=x');
  assert.deepEqual(r.vars, { GOOD: '1' });
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /^line 4:/);
});

test('a cluster gets everyone’s variables and its own on top, whatever its proxy is written as', () => {
  teleport.setEnvSettings({
    global: 'SHARED=1\nTELEPORT_TOOLS_VERSION=18.11.7',
    clusters: { 'red-fire.beams.sh': 'TELEPORT_TOOLS_VERSION=18.11.9' },
  });
  for (const p of ['red-fire.beams.sh', 'red-fire.beams.sh:443', 'https://red-fire.beams.sh/web']) {
    assert.deepEqual(teleport.envFor(p), { SHARED: '1', TELEPORT_TOOLS_VERSION: '18.11.9' }, p);
  }
  assert.deepEqual(teleport.envFor('other.example.com:443'), { SHARED: '1', TELEPORT_TOOLS_VERSION: '18.11.7' });
  assert.deepEqual(teleport.envFor(null), { SHARED: '1', TELEPORT_TOOLS_VERSION: '18.11.7' }, 'no cluster: everyone’s only');
});

test('every tsh the app starts gets them — the cluster’s when it names one', () => {
  teleport.setEnvSettings({ clusters: { 'red-fire.beams.sh': 'TELEPORT_TOOLS_VERSION=18.11.9' } });
  assert.equal(teleport.tshEnv(null, 'red-fire.beams.sh:443').TELEPORT_TOOLS_VERSION, '18.11.9');
  assert.equal(teleport.tshEnv(null, 'other.example.com:443').TELEPORT_TOOLS_VERSION, undefined);
});

test('a tools version set here wins over a chosen tsh’s managed-updates-off', () => {
  delete process.env.TELEPORT_TOOLS_VERSION;
  teleport.setTshPath('/opt/tsh');
  teleport.setEnvSettings({ clusters: { 'red-fire.beams.sh': 'TELEPORT_TOOLS_VERSION=18.11.9' } });
  assert.equal(teleport.tshEnv(null, 'red-fire.beams.sh').TELEPORT_TOOLS_VERSION, '18.11.9');
  assert.equal(teleport.tshEnv(null, 'other.example.com').TELEPORT_TOOLS_VERSION, 'off', 'elsewhere the chosen tsh runs as itself');
  teleport.setTshPath('');
});

test('local shells get everyone’s only, and only when asked', () => {
  teleport.setEnvSettings({ global: 'A=1', clusters: { x: 'B=2' }, inShells: false });
  assert.deepEqual(teleport.envForShells(), {});
  teleport.setEnvSettings({ global: 'A=1', clusters: { x: 'B=2' }, inShells: true });
  assert.deepEqual(teleport.envForShells(), { A: '1' });
});
