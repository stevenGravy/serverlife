import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const teleport = require_(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));

/**
 * A tsh you chose is the tsh that runs.
 *
 * Client-tools managed updates hand a command to whichever tsh they installed
 * for the cluster, so a build of another version named `tsh` and picked in Settings ran as
 * 18.11.7 and the pick changed nothing. A chosen binary is run with the
 * updates off; one the app found for itself is left to them.
 */

const saved = { TSH_PATH: process.env.TSH_PATH, TELEPORT_TOOLS_VERSION: process.env.TELEPORT_TOOLS_VERSION };
function reset() {
  teleport.setTshPath('');
  delete process.env.TSH_PATH;
  delete process.env.TELEPORT_TOOLS_VERSION;
}
test.after(() => {
  teleport.setTshPath('');
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('a tsh found by searching keeps managed updates', () => {
  reset();
  assert.equal(teleport.tshEnv(null).TELEPORT_TOOLS_VERSION, undefined);
});

test('a tsh picked in Settings runs as itself', () => {
  reset();
  teleport.setTshPath('/Users/me/tools/tsh');
  assert.equal(teleport.tshEnv(null).TELEPORT_TOOLS_VERSION, 'off');
  assert.equal(teleport.findTsh(), '/Users/me/tools/tsh');
});

test('so does one named by TSH_PATH', () => {
  reset();
  process.env.TSH_PATH = '/opt/teleport/tsh';
  assert.equal(teleport.tshEnv(null).TELEPORT_TOOLS_VERSION, 'off');
});

test('clearing the setting gives the updates back', () => {
  reset();
  teleport.setTshPath('/Users/me/tools/tsh');
  teleport.setTshPath('');
  assert.equal(teleport.tshEnv(null).TELEPORT_TOOLS_VERSION, undefined);
});

test('a TELEPORT_TOOLS_VERSION set by the person is left as they set it', () => {
  reset();
  process.env.TELEPORT_TOOLS_VERSION = '18.11.7';
  teleport.setTshPath('/Users/me/tools/tsh');
  assert.equal(teleport.tshEnv(null).TELEPORT_TOOLS_VERSION, '18.11.7');
});
