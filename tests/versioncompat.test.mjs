import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const T = require_(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));

/**
 * Client and cluster versions.
 *
 * The rule is Teleport's: a cluster supports clients of its own major and the
 * one before. The cases below are the ones seen against real clusters in
 * tests/integration — 18 on 17 logs in with a warning, 18 on 16 cannot log in
 * at all — so a wrong verdict here is a login that fails with no explanation.
 */

test('the same major, and one behind, are supported', () => {
  assert.equal(T.compatibility('18.11.3', '18.11.2').level, 'ok');
  assert.equal(T.compatibility('17.7.30', '18.11.3').level, 'ok');
  assert.equal(T.compatibility('v18.0.0', '18.11.3').level, 'ok', 'a leading v is allowed');
});

test('a client one major ahead works but is warned about', () => {
  const c = T.compatibility('18.11.3', '17.7.30');
  assert.equal(c.level, 'warn');
  assert.match(c.message, /newer than this cluster/);
  assert.match(c.message, /up to 17\.x/);
  assert.match(c.message, /Install tsh 17\.x/);
});

test('two majors ahead, or two behind, is expected to fail', () => {
  const ahead = T.compatibility('18.11.3', '16.5.18');
  assert.equal(ahead.level, 'error');
  assert.match(ahead.message, /2 major versions ahead/);
  const behind = T.compatibility('16.5.18', '18.11.3');
  assert.equal(behind.level, 'error');
  assert.match(behind.message, /too old .* needs 17\.x or newer/);
});

test('an unreadable version is unknown, never a verdict', () => {
  assert.equal(T.compatibility(null, '18.1.0').level, 'unknown');
  assert.equal(T.compatibility('18.1.0', '').level, 'unknown');
  assert.equal(T.compatibility('dev', '18.1.0').level, 'unknown');
});

// Exactly as tsh 18.11.3 printed it against a 17.7.30 cluster, colour and all.
const NEWER = `\u001b]11;?\u001b\\
WARNING
Detected potentially incompatible client and server versions.
Maximum client version supported by the server is 17.x.x but you are using 18.11.3.
Please downgrade tsh to 17.x.x or use the --skip-version-check flag to bypass this check.
Future versions of tsh will fail when incompatible versions are detected.

Enter password for Teleport user ci:
> Profile URL:        https://proxy:3080
`;

test('tsh’s own warning is read from login output', () => {
  const w = T.parseVersionWarning(NEWER);
  assert.equal(w.direction, 'client-newer');
  assert.equal(w.serverLimit, '17.x.x');
  assert.equal(w.client, '18.11.3');
  assert.match(w.text, /^Detected potentially incompatible/);
  assert.match(w.text, /Future versions of tsh will fail/);
  assert.doesNotMatch(w.text, /Enter password/, 'the warning stops where it ends');
});

test('the minimum-version form is read too', () => {
  const w = T.parseVersionWarning(
    'WARNING\nDetected potentially incompatible client and server versions.\n'
    + 'Minimum client version supported by the server is 17.0.0 but you are using 16.5.18.\n'
    + 'Please upgrade tsh to 17.0.0 or newer.\n');
  assert.equal(w.direction, 'client-older');
  assert.equal(w.serverLimit, '17.0.0');
  assert.equal(w.client, '16.5.18');
});

test('a login with no warning has none', () => {
  assert.equal(T.parseVersionWarning('> Profile URL: https://proxy:3080\n  Logged in as: ci\n'), null);
  assert.equal(T.parseVersionWarning(''), null);
});
