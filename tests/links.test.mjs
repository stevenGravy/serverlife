import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings } from './helpers.mjs';

const store = fakeSettings({});
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

const L = await import('../src/renderer/js/links.js');

/**
 * Links in terminal output.
 *
 * Two things can go wrong and only one of them is visible. The obvious one
 * is missing a link, which is an annoyance. The other is claiming one — the
 * menu offering to open an address that is not the address under the pointer,
 * or that quietly includes the full stop, the closing bracket or the comma
 * that followed it. That is how a click lands somewhere nobody chose, so the
 * edges get most of the attention here.
 */

test('ordinary URLs are found wherever the pointer lands in them', () => {
  const line = 'see https://example.com/a/b?x=1#frag for details';
  const start = line.indexOf('https');
  const end = line.indexOf(' for');
  for (let i = start; i < end; i++) {
    assert.equal(L.urlAt(line, i)?.url, 'https://example.com/a/b?x=1#frag', `offset ${i}`);
  }
});

test('nothing is claimed outside the link itself', () => {
  const line = 'see https://example.com/a for details';
  assert.equal(L.urlAt(line, 0), null);
  assert.equal(L.urlAt(line, 3), null);                       // the space before
  assert.equal(L.urlAt(line, line.indexOf('for')), null);
  assert.equal(L.urlAt(line, line.length + 5), null);
  assert.equal(L.urlAt('', 0), null);
  assert.equal(L.urlAt('no links here at all', 4), null);
});

test('the sentence’s punctuation is not part of the address', () => {
  const cases = [
    ['Try https://example.com/a.', 'https://example.com/a'],
    ['Try https://example.com/a, then stop', 'https://example.com/a'],
    ['(see https://example.com/a)', 'https://example.com/a'],
    ['[https://example.com/a]', 'https://example.com/a'],
    ['Try https://example.com/a!', 'https://example.com/a'],
    ['url: "https://example.com/a"', 'https://example.com/a'],
  ];
  for (const [line, want] of cases) {
    assert.equal(L.urlAt(line, line.indexOf('http') + 10)?.url, want, line);
  }
});

test('brackets the URL opened itself are kept', () => {
  const line = 'https://en.wikipedia.org/wiki/Foo_(disambiguation) ok';
  assert.equal(L.urlAt(line, 10)?.url, 'https://en.wikipedia.org/wiki/Foo_(disambiguation)');
});

test('clicking the punctuation after a link is not clicking the link', () => {
  const line = 'Try https://example.com/a. Next';
  const dot = line.indexOf('a.') + 1;
  assert.equal(L.urlAt(line, dot), null);
});

test('a bare www host is a link, and gains the scheme it was missing', () => {
  assert.equal(L.urlAt('go to www.example.com/x now', 8)?.url, 'https://www.example.com/x');
  assert.equal(L.normalize('www.example.com'), 'https://www.example.com');
  assert.equal(L.normalize('https://example.com'), 'https://example.com');
});

test('only http and https are ever offered to the browser', () => {
  assert.ok(L.openable('https://example.com'));
  assert.ok(L.openable('http://example.com'));
  assert.ok(L.openable('www.example.com'));
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ssh://host', 'data:text/html,x', '']) {
    assert.equal(L.openable(bad), false, bad);
  }
});

/*
 * A log line is not prose, and the character after a URL in one is as likely
 * to be a quote or a brace as a space. These are the shapes that actually
 * turn up.
 */
test('links embedded in machine output come out whole', () => {
  const json = '{"url":"https://api.example.com/v1/things?page=2","n":3}';
  assert.equal(L.urlAt(json, 20)?.url, 'https://api.example.com/v1/things?page=2');

  const log = '2026-10-02 12:00:01 WARN fetch failed <https://example.com/a/b> retrying';
  assert.equal(L.urlAt(log, log.indexOf('http') + 5)?.url, 'https://example.com/a/b');
});

test('the host is what the question will name', () => {
  assert.equal(L.hostOf('https://example.com/a/b'), 'example.com');
  assert.equal(L.hostOf('https://user@evil.test/login?x=example.com'), 'evil.test');
  assert.equal(L.hostOf('www.example.com'), 'www.example.com');
  assert.equal(L.hostOf('nonsense'), '');
});

test('asking first is the default, and the preference can turn it off', () => {
  state.settings = { ...store };
  assert.equal(L.confirmsLinks(), true, 'on unless the preference says otherwise');
  state.settings = { ...store, confirmLinkOpen: false };
  assert.equal(L.confirmsLinks(), false);
  state.settings = { ...store, confirmLinkOpen: true };
  assert.equal(L.confirmsLinks(), true);
  state.settings = store;
});
