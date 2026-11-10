import test from 'node:test';
import assert from 'node:assert/strict';

import { HOST_COLORS, colorCss, ICON_CHOICES, uid, shellQuote, fileIcon } from '../src/renderer/js/util.js';

/**
 * The small shared pieces. They are boring until one of them drifts: the
 * palette is shared between hosts and folders so the two can match, and
 * `shellQuote` is the difference between a filename with a quote in it and
 * a command that does something else entirely.
 */

test('the palette is the one shared set, and every colour is usable', () => {
  assert.ok(HOST_COLORS.length >= 8);
  const values = HOST_COLORS.map((c) => c.value);
  assert.equal(new Set(values).size, values.length, 'no duplicate colour names');
  assert.equal(values[0], '', 'the first entry is "none"');
  for (const c of HOST_COLORS.slice(1)) {
    assert.match(c.css, /^#[0-9a-f]{6}$/i, `${c.value} has a real colour`);
    assert.ok(c.label, `${c.value} is named`);
  }
});

test('colorCss resolves a name, and refuses anything else', () => {
  assert.equal(colorCss('red'), '#f85149');
  assert.equal(colorCss(''), '');
  assert.equal(colorCss('mauve'), '');
  assert.equal(colorCss(undefined), '');
});

test('the icon list is distinct and free of blanks', () => {
  assert.ok(ICON_CHOICES.length >= 12);
  assert.equal(new Set(ICON_CHOICES).size, ICON_CHOICES.length);
  for (const i of ICON_CHOICES) assert.ok(i.trim().length, 'no empty icons');
});

test('uid carries its prefix and does not repeat itself', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(uid('fld'));
  assert.equal(ids.size, 500);
  assert.ok([...ids][0].startsWith('fld_'));
});

test('shellQuote survives the characters that break a command', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('a b; rm -rf /'), "'a b; rm -rf /'");
  assert.equal(shellQuote('$(whoami)'), "'$(whoami)'");
});

test('a file icon is chosen by kind first and extension second', () => {
  // 'directory' is the word the SFTP listing uses; 'dir' is not one of ours.
  assert.equal(fileIcon({ type: 'directory', name: 'x' }), '\u{1F4C1}');
  assert.equal(fileIcon({ type: 'symlink', targetType: 'directory', name: 'x' }), '\u{1F4C1}');
  assert.equal(fileIcon({ type: 'symlink', name: 'x' }), '\u{1F517}');
  assert.equal(fileIcon({ type: 'file', name: 'a.png' }), '\u{1F5BC}');
  assert.equal(fileIcon({ type: 'file', name: 'id_rsa.pem' }), '\u{1F511}');
  assert.equal(fileIcon({ type: 'file', name: 'notes.md' }), '\u{1F4DD}');
});

test('names sort the way people read them, not the way bytes do', async () => {
  const { compareNames } = await import('../src/renderer/js/util.js');
  const by = (names) => [...names].sort(compareNames);

  // Case is not a sort key.
  assert.deepEqual(by(['banana', 'Apple', 'cherry']), ['Apple', 'banana', 'cherry']);
  assert.deepEqual(by(['README', 'readme.txt', 'Readme.md']).length, 3);
  // Numbers count as numbers.
  assert.deepEqual(by(['node-10', 'node-2', 'node-1']), ['node-1', 'node-2', 'node-10']);
  assert.deepEqual(by(['web10', 'WEB2']), ['WEB2', 'web10']);
  assert.equal(compareNames(undefined, ''), 0);
});

test('a listing puts folders first and never reshuffles itself', async () => {
  const { sortEntries } = await import('../src/renderer/js/util.js');
  const entries = [
    { name: 'zebra.txt', type: 'file', size: 10, mtime: 5 },
    { name: 'Alpha', type: 'directory', size: 0, mtime: 1 },
    { name: 'beta.txt', type: 'file', size: 10, mtime: 5 },
    { name: 'gamma', type: 'directory', size: 0, mtime: 9 },
  ];
  assert.deepEqual(sortEntries(entries, { key: 'name', dir: 1 }).map((e) => e.name),
    ['Alpha', 'gamma', 'beta.txt', 'zebra.txt']);
  // Ties on size fall back to the name, so the order is the same every draw.
  assert.deepEqual(sortEntries(entries, { key: 'size', dir: 1 }).map((e) => e.name),
    ['Alpha', 'gamma', 'beta.txt', 'zebra.txt']);
  assert.deepEqual(sortEntries(entries, { key: 'mtime', dir: -1 }).map((e) => e.name),
    ['gamma', 'Alpha', 'beta.txt', 'zebra.txt']);
});

test('folders can be mixed in with the files', async () => {
  const { sortEntries } = await import('../src/renderer/js/util.js');
  const entries = [
    { name: 'zebra', type: 'directory', size: 0, mtime: 1 },
    { name: 'apple.txt', type: 'file', size: 10, mtime: 9 },
    { name: 'mango', type: 'directory', size: 0, mtime: 5 },
  ];
  // The default is the convention: folders in a block at the top.
  assert.deepEqual(sortEntries(entries, { key: 'name', dir: 1 }).map((e) => e.name),
    ['mango', 'zebra', 'apple.txt']);
  // Off, everything sorts together — which is the only way a date sort can
  // answer "what changed here last".
  assert.deepEqual(sortEntries(entries, { key: 'name', dir: 1, foldersFirst: false }).map((e) => e.name),
    ['apple.txt', 'mango', 'zebra']);
  assert.deepEqual(sortEntries(entries, { key: 'mtime', dir: -1, foldersFirst: false }).map((e) => e.name),
    ['apple.txt', 'mango', 'zebra']);
  assert.deepEqual(sortEntries(entries, { key: 'mtime', dir: -1 }).map((e) => e.name),
    ['mango', 'zebra', 'apple.txt']);
});

/**
 * Which sessions cost an MFA approval before the file browser may load.
 *
 * The distinction that matters is the transport, and the case worth
 * pinning down is the one that used to get it wrong: a node whose hostname
 * is shared with another is dialled by its UUID over the shared
 * connection, so it is an ordinary session with nothing to approve — and
 * telling someone to "approve MFA" for it is an instruction nothing will
 * act on. Should that same node also want MFA, it lands on tsh like any
 * other MFA host and is gated again.
 */
const { needsMfaApproval } = await import('../src/renderer/js/state.js');

test('a shared-connection session needs no approval, whatever its name', () => {
  assert.equal(needsMfaApproval({ transport: 'mux', hostId: 'x' }), false);
  // A duplicate-named node: same transport, dialled by UUID, nothing to approve.
  assert.equal(needsMfaApproval({ transport: 'mux', hostId: 'tsh:tele1c:uuid-1' }), false);
  assert.equal(needsMfaApproval({ transport: 'beam' }), false);
  assert.equal(needsMfaApproval(null), false);
});

test('a tsh session does, however it got there', () => {
  // Chosen because the host asks for MFA, forced by a leaf cluster, or
  // forced because this machine has no ssh client at all.
  assert.equal(needsMfaApproval({ transport: 'tsh', transportForced: null }), true);
  assert.equal(needsMfaApproval({ transport: 'tsh', transportForced: 'leaf' }), true);
  assert.equal(needsMfaApproval({ transport: 'tsh', transportForced: 'no-ssh' }), true);
});
