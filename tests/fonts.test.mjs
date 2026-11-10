import test from 'node:test';
import assert from 'node:assert/strict';
import { fontStack, DEFAULT_STACK, MONO_FONTS } from '../src/renderer/js/fonts.js';

/** What a font setting becomes in the terminal. */

test('nothing chosen is the default stack', () => {
  assert.equal(fontStack(''), DEFAULT_STACK);
  assert.equal(fontStack(undefined), DEFAULT_STACK);
});

test('one family from the list is quoted and given the fallbacks', () => {
  assert.equal(fontStack('JetBrains Mono'), `"JetBrains Mono", ${DEFAULT_STACK}`);
  assert.equal(fontStack('"Fira Code"'), `"Fira Code", ${DEFAULT_STACK}`);
});

test('a stack someone typed is used as it is', () => {
  assert.equal(fontStack('"My Font", Menlo, monospace'), '"My Font", Menlo, monospace');
});

test('the default ends in a generic family, and the list has no repeats', () => {
  assert.match(DEFAULT_STACK, /monospace$/);
  assert.equal(new Set(MONO_FONTS).size, MONO_FONTS.length);
});
