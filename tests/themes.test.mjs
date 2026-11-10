import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings } from './helpers.mjs';

const store = fakeSettings({});
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

const T = await import('../src/renderer/js/themes.js');
const { TERMINAL_PALETTES, appThemeAnsi } = T;

/**
 * Named themes.
 *
 * Dozens of palettes typed in by hand, and a typo in one does not fail loudly:
 * a colour that is not a colour drops its CSS rule and the panel falls back
 * to plain dark, and a light theme whose text barely differs from its
 * background still renders — it is just unreadable. These check what a
 * glance at one theme would not.
 */

const HEX = /^#[0-9a-f]{6}$/i;
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/** WCAG relative luminance and contrast ratio. */
const lum = (c) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('there are a lot of them, light and dark both', () => {
  assert.ok(T.APP_THEMES.length >= 30, `only ${T.APP_THEMES.length}`);
  assert.ok(T.APP_THEMES.filter((t) => t.tone === 'light').length >= 10);
  assert.ok(T.APP_THEMES.filter((t) => t.tone === 'dark').length >= 20);
});

test('every id is unique and none shadows a built-in setting', () => {
  const ids = T.APP_THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const reserved of ['auto', 'dark', 'light']) assert.ok(!ids.includes(reserved), reserved);
});

test('each theme says whether it is light or dark, and toneOf agrees', () => {
  for (const t of T.APP_THEMES) {
    assert.ok(t.tone === 'light' || t.tone === 'dark', t.id);
    assert.equal(T.toneOf(t.id), t.tone);
  }
  assert.equal(T.toneOf('light'), 'light');
  assert.equal(T.toneOf('dark'), 'dark');
  assert.equal(T.toneOf('auto'), null);
  assert.equal(T.toneOf('no-such-theme'), null);
});

test('every theme resolves to sixteen real colours, including the borrowed palettes', () => {
  for (const t of T.APP_THEMES) {
    const a = appThemeAnsi(t);
    assert.ok(a, `${t.id}: palette ${t.term} not found`);
    for (const k of ANSI) assert.match(a[k] || '', HEX, `${t.id}.${k}`);
    for (const k of ['bg', 'fg', 'accent']) assert.match(t[k], HEX, `${t.id}.${k}`);
  }
});

test('every derived UI token is a colour', () => {
  for (const t of T.APP_THEMES) {
    for (const [k, v] of Object.entries(T.themeTokens(t, appThemeAnsi(t)))) assert.match(v, HEX, `${t.id} ${k}`);
  }
});

test('text is readable on every background, and dimmed text, hints and the accent are too', () => {
  for (const t of T.APP_THEMES) {
    const tok = T.themeTokens(t, appThemeAnsi(t));
    assert.ok(contrast(tok['--text'], tok['--bg']) >= 4.5, `${t.id} text ${contrast(tok['--text'], tok['--bg']).toFixed(2)}`);
    assert.ok(contrast(tok['--text'], tok['--panel-3']) >= 4.5, `${t.id} text on panel-3`);
    assert.ok(contrast(tok['--text-dim'], tok['--bg']) >= 4.5, `${t.id} text-dim`);
    assert.ok(contrast(tok['--muted'], tok['--bg']) >= 3, `${t.id} muted`);
    assert.ok(contrast(tok['--accent'], tok['--bg']) >= 3, `${t.id} accent`);
  }
});

test('surfaces step away from the background in order, the way dark and light do', () => {
  for (const t of T.APP_THEMES) {
    const tok = T.themeTokens(t, appThemeAnsi(t));
    const d = (c) => contrast(c, tok['--bg']);
    assert.ok(d(tok['--panel']) <= d(tok['--panel-2']) && d(tok['--panel-2']) <= d(tok['--panel-3']), t.id);
    assert.ok(d(tok['--border']) > d(tok['--panel']), `${t.id} border lost against the panel`);
  }
});

test('the stylesheet has one rule per theme and nothing undefined in it', () => {
  const css = T.themeStylesheet();
  for (const t of T.APP_THEMES) assert.ok(css.includes(`:root[data-theme="${t.id}"] {`), t.id);
  assert.ok(!/undefined|NaN|null/.test(css));
});

test('themes with colours of their own can be picked for the terminal alone', () => {
  const values = TERMINAL_PALETTES.map((p) => p.value);
  assert.equal(new Set(values).size, values.length, 'a palette is listed twice');
  for (const t of T.APP_THEMES) {
    // Borrowed or own, the theme's colours are on the terminal list.
    assert.ok(values.includes(typeof t.term === 'string' ? t.term : t.id), t.id);
  }
});

test('mix goes from one colour to the other', () => {
  assert.equal(T.mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(T.mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(T.mix('#000000', '#ffffff', 0.5), '#808080');
});
