import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../src/renderer/js/csv.js';

test('toCsv writes a header row from the column labels, falling back to the key', () => {
  const text = toCsv([], [{ key: 'name', label: 'Name' }, { key: 'ns' }]);
  assert.equal(text, 'Name,ns\r\n');
});

test('toCsv writes one row per item, reading each column\'s key', () => {
  const text = toCsv([{ name: 'a', ns: 'default' }, { name: 'b', ns: 'kube-system' }], [{ key: 'name' }, { key: 'ns' }]);
  assert.equal(text, 'name,ns\r\na,default\r\nb,kube-system\r\n');
});

test('toCsv quotes a field containing a comma', () => {
  const text = toCsv([{ a: 'x,y' }], [{ key: 'a' }]);
  assert.equal(text, 'a\r\n"x,y"\r\n');
});

test('toCsv quotes a field containing a newline', () => {
  const text = toCsv([{ a: 'line1\nline2' }], [{ key: 'a' }]);
  assert.equal(text, 'a\r\n"line1\nline2"\r\n');
});

test('toCsv quotes a field containing a double quote, doubling it', () => {
  const text = toCsv([{ a: 'say "hi"' }], [{ key: 'a' }]);
  assert.equal(text, 'a\r\n"say ""hi"""\r\n');
});

test('toCsv writes a missing/null/undefined value as an empty field', () => {
  const text = toCsv([{ a: null }, { a: undefined }, {}], [{ key: 'a' }]);
  assert.equal(text, 'a\r\n\r\n\r\n\r\n');
});

test('toCsv with no rows still writes the header', () => {
  assert.equal(toCsv(undefined, [{ key: 'a' }]), 'a\r\n');
});
