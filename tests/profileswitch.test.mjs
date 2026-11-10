import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const T = require_(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));

/**
 * Switching the active profile.
 *
 * `tsh login` on a still-valid certificate does not record the switch, so
 * the app writes tsh's `current-profile` itself. These use a throwaway tsh
 * home: the real one is the user's, and the point is what lands in the file.
 */

function home(...profiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-tsh-'));
  for (const p of profiles) fs.writeFileSync(path.join(dir, `${p}.yaml`), 'web_proxy_addr: x\n');
  fs.writeFileSync(path.join(dir, 'current-profile'), 'old.example.com\n');
  return dir;
}

test('the proxy host becomes the current profile, as tsh writes it', () => {
  const dir = home('old.example.com', 'red-fire.beams.sh');
  assert.equal(T.markCurrentProfile('https://red-fire.beams.sh:443/web', dir), true);
  assert.equal(fs.readFileSync(path.join(dir, 'current-profile'), 'utf8'), 'red-fire.beams.sh\n');
});

test('a proxy with no profile in that home changes nothing', () => {
  const dir = home('old.example.com');
  assert.equal(T.markCurrentProfile('nowhere.example.com:443', dir), false);
  assert.equal(fs.readFileSync(path.join(dir, 'current-profile'), 'utf8'), 'old.example.com\n');
});
