import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubewatch.js'));

/**
 * The pure half of kubewatch.js: splitting a buffer of kubectl's own
 * `-o yaml --watch` output into complete documents and what's left over.
 * No spawning here — that needs a real cluster (see the Section 3
 * verification notes), same boundary every other kube*.test.mjs keeps.
 */

test('one complete document, nothing left over', () => {
  const { complete, remainder } = K.splitDocuments('kind: Pod\nmetadata:\n  name: a\n');
  assert.deepEqual(complete, []);
  assert.equal(remainder, 'kind: Pod\nmetadata:\n  name: a\n');
});

test('two documents separated by a bare --- line: the first is complete, the second held back', () => {
  const buf = 'kind: Pod\nmetadata:\n  name: a\n---\nkind: Pod\nmetadata:\n  name: b\n';
  const { complete, remainder } = K.splitDocuments(buf);
  // The separator's own match consumes the newline right before `---` —
  // harmless (js-yaml does not need a document to end with one), so the
  // completed text is the document's lines with no trailing newline.
  assert.deepEqual(complete, ['kind: Pod\nmetadata:\n  name: a']);
  assert.equal(remainder, 'kind: Pod\nmetadata:\n  name: b\n');
});

test('three documents: the first two are complete, the third (still arriving) is held back', () => {
  const buf = 'name: a\n---\nname: b\n---\nname: c-still-arri';
  const { complete, remainder } = K.splitDocuments(buf);
  assert.deepEqual(complete, ['name: a', 'name: b']);
  assert.equal(remainder, 'name: c-still-arri');
});

test('a data value that merely contains the text "---", indented, never splits early', () => {
  // A real annotation or message field could easily contain this text —
  // only a line with nothing else on it is the separator.
  const buf = 'kind: Pod\nmetadata:\n  annotations:\n    note: "see --- section 3"\n---\nkind: Pod\nmetadata:\n  name: b\n';
  const { complete } = K.splitDocuments(buf);
  assert.equal(complete.length, 1);
  assert.match(complete[0], /see --- section 3/);
});

test('trailing whitespace after the separator (CR, stray spaces) still splits', () => {
  const buf = 'name: a\n---  \r\nname: b\n';
  const { complete, remainder } = K.splitDocuments(buf);
  assert.deepEqual(complete, ['name: a']);
  assert.equal(remainder, 'name: b\n');
});

test('an empty buffer: nothing complete, nothing left over', () => {
  const { complete, remainder } = K.splitDocuments('');
  assert.deepEqual(complete, []);
  assert.equal(remainder, '');
});

test('start() refuses with no id, before spawning anything', () => {
  assert.throws(() => K.start({ kind: 'pods' }, () => {}), /id/);
});

test('start() refuses with no kind, before spawning anything', () => {
  assert.throws(() => K.start({ id: 'x' }, () => {}), /kind/);
});

test('stop on an id that was never started is a no-op, not an error', () => {
  assert.equal(K.stop('not-a-real-watch'), false);
});

test('stopAll with nothing running does not throw', () => {
  assert.doesNotThrow(() => K.stopAll());
});
