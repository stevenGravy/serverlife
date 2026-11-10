import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/sshkeys.js'));

/**
 * The openssh-key-v1 header: magic bytes, then a length-prefixed cipher
 * name. Only enough of the real format to exercise opensshKeyEncrypted() —
 * it never reads past the cipher-name field, so nothing after it matters.
 */
function header(cipher, trailing = '') {
  const magic = Buffer.from('openssh-key-v1\0', 'latin1');
  const cipherBuf = Buffer.from(cipher, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(cipherBuf.length, 0);
  const raw = Buffer.concat([magic, len, cipherBuf, Buffer.from(trailing, 'latin1')]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${raw.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

test('"none" cipher means unencrypted', () => {
  assert.equal(K.opensshKeyEncrypted(header('none')), false);
});

test('any other cipher means encrypted, read from the length-prefixed field itself', () => {
  assert.equal(K.opensshKeyEncrypted(header('aes256-ctr')), true);
});

test('a comment further down that happens to contain "none" does not get mistaken for the cipher', () => {
  // Regression: the old check scanned the whole decoded header for the
  // substring "none", which a key's own -C comment can contain even when
  // the real cipher is not "none" at all.
  assert.equal(K.opensshKeyEncrypted(header('aes256-ctr', 'steven@none-prod-bastion')), true);
});

test('a header too short or not openssh-key-v1 at all is inconclusive, not a guess', () => {
  assert.equal(K.opensshKeyEncrypted('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'), null);
  assert.equal(K.opensshKeyEncrypted('-----BEGIN OPENSSH PRIVATE KEY-----\n\n-----END OPENSSH PRIVATE KEY-----\n'), null);
});
