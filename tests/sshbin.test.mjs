import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const B = require_(path.join(__PROJECT_ROOT__, 'src/main/sshbin.js'));

/** `ssh -V`'s banner, parsed into a comparable version — and the feature gate built on it. */

test('parses OpenSSH’s -V banner, including the Windows-fork spelling', () => {
  assert.deepEqual(B.parseSshVersion('OpenSSH_9.4p1, LibreSSL 3.3.6'), { raw: 'OpenSSH_9.4p1, LibreSSL 3.3.6', major: 9, minor: 4, patch: 1 });
  assert.deepEqual(B.parseSshVersion('OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3'),
    { raw: 'OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3', major: 8, minor: 6, patch: 1 });
  assert.equal(B.parseSshVersion('').major, null);
  assert.equal(B.parseSshVersion('not ssh at all').major, null);
});

test('a patchless version still parses, with patch defaulting to 0', () => {
  assert.deepEqual(B.parseSshVersion('OpenSSH_9.9'), { raw: 'OpenSSH_9.9', major: 9, minor: 9, patch: 0 });
});
