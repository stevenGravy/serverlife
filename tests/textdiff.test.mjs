import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/renderer/js/textdiff.js';

test('diffLines reports no changes when the two blobs are identical', () => {
  const r = diffLines('a\nb\nc', 'a\nb\nc');
  assert.ok(r.every((x) => x.type === 'same'));
  assert.deepEqual(r.map((x) => x.line), ['a', 'b', 'c']);
});

test('diffLines finds an added line', () => {
  const r = diffLines('a\nb', 'a\nx\nb');
  assert.deepEqual(r, [{ type: 'same', line: 'a' }, { type: 'add', line: 'x' }, { type: 'same', line: 'b' }]);
});

test('diffLines finds a removed line', () => {
  const r = diffLines('a\nx\nb', 'a\nb');
  assert.deepEqual(r, [{ type: 'same', line: 'a' }, { type: 'remove', line: 'x' }, { type: 'same', line: 'b' }]);
});

test('diffLines handles a changed line as remove+add, not a false "same"', () => {
  const r = diffLines('key: old', 'key: new');
  assert.deepEqual(r, [{ type: 'remove', line: 'key: old' }, { type: 'add', line: 'key: new' }]);
});

test('diffLines handles one side being empty', () => {
  assert.deepEqual(diffLines('', 'a\nb'), [{ type: 'add', line: 'a' }, { type: 'add', line: 'b' }]);
  assert.deepEqual(diffLines('a\nb', ''), [{ type: 'remove', line: 'a' }, { type: 'remove', line: 'b' }]);
});

test('diffLines handles both sides empty', () => {
  assert.deepEqual(diffLines('', ''), []);
});
