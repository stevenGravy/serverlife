import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubefs.js'));

/** `stat -c %F`'s file-type text, read back into the local.js-shaped `type` field. */

test('GNU coreutils directory/file/symlink wording', () => {
  assert.equal(K.parseType('directory'), 'directory');
  assert.equal(K.parseType('regular file'), 'file');
  assert.equal(K.parseType('regular empty file'), 'file');
  assert.equal(K.parseType('symbolic link'), 'symlink');
});

test('anything unrecognised is treated as a plain file, never thrown on', () => {
  assert.equal(K.parseType(''), 'file');
  assert.equal(K.parseType('socket'), 'file');
});
