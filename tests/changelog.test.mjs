import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseChangelog, plainText } from '../src/renderer/js/changelog.js';

/**
 * The version history is read from CHANGELOG.md, so these run the parser over
 * the real file: the thing that went wrong before was the history and the
 * changelog drifting apart, and only the real file can show that they agree.
 */

const md = fs.readFileSync(path.join(__PROJECT_ROOT__, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__PROJECT_ROOT__, 'package.json'), 'utf8'));
const releases = parseChangelog(md);

test('the newest release in the history is the version being built', () => {
  assert.equal(releases[0].version, pkg.version,
    `package.json says ${pkg.version}; CHANGELOG.md's newest entry is ${releases[0].version}`);
});

test('every release has a date and something in it', () => {
  for (const r of releases) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.version} has no date`);
    const items = r.sections.reduce((n, s) => n + s.items.length, 0);
    assert.ok(items || r.summary, `${r.version} is empty`);
  }
});

test('the releases since the move are all there, not just the early ones', () => {
  const versions = new Set(releases.map((r) => r.version));
  for (const v of ['0.1.16', '0.13.0', '0.14.0', '0.14.1']) assert.ok(versions.has(v), `${v} missing`);
});

test('a wrapped bullet is one entry, read as plain text', () => {
  const [r] = parseChangelog([
    '## [9.9.9] — 2030-01-01', '', 'The summary', 'over two lines.', '',
    '### Added', '', '- **Bold** and `code` and a [link](https://x),',
    '  continued here.', '- Second.', '', '### Fixed', '', '- Third.', '', '---',
  ].join('\n'));
  assert.equal(r.summary, 'The summary over two lines.');
  assert.deepEqual(r.sections.map((s) => s.name), ['Added', 'Fixed']);
  assert.deepEqual(r.sections[0].items, ['Bold and code and a link, continued here.', 'Second.']);
  assert.deepEqual(r.sections[1].items, ['Third.']);
});

test('emphasis comes off, asterisks in prose do not break it', () => {
  assert.equal(plainText('*Open in tmux…* on the menu'), 'Open in tmux… on the menu');
  assert.equal(plainText('a * b'), 'a * b');
});
