import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const T = require_(path.join(__PROJECT_ROOT__, 'src/main/tmuxctl.js'));

/**
 * tmux control mode.
 *
 * Everything here was checked against a real session first — locally against
 * tmux 3.7 and over Teleport against tmux 3.4 on a node — and the lines below
 * are what those actually sent. The reason to pin them down in tests is that
 * every mistake in this file is silent: an octal escape read wrongly puts a
 * stray backslash in somebody's config file, and a layout misread puts a
 * machine's output in the wrong pane.
 */

/* ---------------- output escaping ---------------- */

test('escape sequences survive the round trip', () => {
  // Straight from the wire: a zsh prompt as tmux forwarded it.
  assert.equal(
    T.unescapeOutput('\\033[1m\\033[7m%\\033[27m\\033[1m\\033[0m'),
    '\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m');
  assert.equal(T.unescapeOutput('hello\\015\\012'), 'hello\r\n');
});

test('a literal backslash is not read as the start of an escape', () => {
  // `\134` is a backslash. Decoding it first and then rescanning would turn
  // `\134033` — a backslash followed by the text 033 — into ESC.
  assert.equal(T.unescapeOutput('\\134033'), '\\033');
  assert.equal(T.unescapeOutput('C:\\134Users'), 'C:\\Users');
  // The sequence tmux sends for an OSC terminator: ESC backslash.
  assert.equal(T.unescapeOutput('\\033\\134'), '\u001b\\');
});

test('text that merely looks like an escape is left alone', () => {
  assert.equal(T.unescapeOutput('\\12'), '\\12', 'too few digits');
  assert.equal(T.unescapeOutput('\\899'), '\\899', 'not octal');
  assert.equal(T.unescapeOutput('plain text'), 'plain text');
  assert.equal(T.unescapeOutput(''), '');
});

test('keystrokes go out as hex, so no byte is read as a key name', () => {
  assert.equal(T.hexKeys('ls'), '0x6c 0x73');
  assert.equal(T.hexKeys('\r'), '0x0d');
  assert.equal(T.hexKeys('\u0003'), '0x03', 'ctrl-C is a byte, not the word Enter');
  // Multi-byte characters become their utf-8 bytes rather than one number.
  assert.equal(T.hexKeys('é'), '0xc3 0xa9');
});

/* ---------------- layouts ---------------- */

test('a single pane is a layout', () => {
  const t = T.parseLayout('aafd,120x40,0,0,0');
  assert.deepEqual(t, { w: 120, h: 40, x: 0, y: 0, pane: '%0' });
});

test('a horizontal split is a column of two panes', () => {
  // Captured from tmux after `split-window`.
  const t = T.parseLayout('3aab,120x40,0,0[120x20,0,0,0,120x19,0,21,2]');
  assert.equal(t.dir, 'col', 'square brackets stack top to bottom');
  assert.equal(t.children.length, 2);
  assert.deepEqual(T.panesInLayout(t), ['%0', '%2']);
  assert.equal(t.children[1].y, 21, 'the second pane starts below the divider');
});

test('nested splits come back as a tree, in tmux order', () => {
  const t = T.parseLayout('bb62,279x82,0,0[279x41,0,0,1,279x40,0,42{139x40,0,42,2,139x40,140,42,3}]');
  assert.equal(t.dir, 'col');
  assert.equal(t.children[1].dir, 'row', 'braces sit side by side');
  assert.deepEqual(T.panesInLayout(t), ['%1', '%2', '%3']);
});

test('a layout that makes no sense is refused rather than half-read', () => {
  assert.throws(() => T.parseLayout('abcd,120x40,0,0['), /bad layout/);
  assert.throws(() => T.parseLayout('abcd,notanumber'), /bad layout/);
});

/* ---------------- the protocol ---------------- */

const feed = (parser, ...chunks) => chunks.flatMap((c) => parser.feed(c));

test('nothing is protocol until the DCS has gone past', () => {
  const p = new T.Parser();
  const evs = feed(p, 'Welcome to Ubuntu 24.04\r\n12 updates can be applied\r\n');
  assert.equal(evs.filter((e) => e.type === 'preamble').length, 1);
  assert.ok(!evs.some((e) => e.type === 'ready'));
  // A line that looks like a notification but arrives before control mode is
  // the login banner, not protocol.
  assert.ok(!evs.some((e) => e.type === 'output'));
});

test('the terminal probes are answered, and only before control mode', () => {
  const p = new T.Parser();
  const before = feed(p, '\u001b]11;?\u001b\\\u001b[6n');
  assert.deepEqual(before.filter((e) => e.type === 'probe').map((e) => e.data),
    ['\u001b[1;1R', '\u001b]11;rgb:1212/1414/1a1a\u001b\\']);

  feed(p, T.DCS);
  // tmux asks again once control mode is running. Answering then would be
  // writing to the command channel — which a real session answered with
  // "parse error: unknown command".
  const after = feed(p, '%output %0 \\033]11;?\\033\\134\n');
  assert.equal(after.filter((e) => e.type === 'probe').length, 0);
});

test('the DCS can arrive in the same read as the banner and the first lines', () => {
  const p = new T.Parser();
  const evs = feed(p, `motd here\r\n${T.DCS}%begin 1 2 0\r\n%end 1 2 0\r\n%window-add @0\r\n`);
  assert.ok(evs.some((e) => e.type === 'ready'));
  assert.ok(evs.some((e) => e.type === 'result'));
  assert.ok(evs.some((e) => e.type === 'window-add' && e.window === '@0'));
});

/*
 * A beam: `tmux -C` over `tsh beams exec`, which never has a terminal. These
 * are the lines tmux 3.3a sent on glacial-ring — no DCS, no probes, protocol
 * from the first byte.
 */
const BEAM_OPENING = '%begin 1791124214 267 0\n%end 1791124214 267 0\n%window-add @0\n%sessions-changed\n%session-changed $0 slprobe\n';

test('on a beam, control mode starts with the first line, with no DCS', () => {
  const p = new T.Parser({ plain: true });
  const evs = feed(p, BEAM_OPENING);
  assert.equal(evs[0].type, 'ready', 'ready comes before the first block it belongs to');
  assert.ok(evs.some((e) => e.type === 'result' && e.flags === '0'), 'tmux\u2019s own opening block');
  assert.ok(evs.some((e) => e.type === 'window-add' && e.window === '@0'));
  assert.equal(evs.filter((e) => e.type === 'ready').length, 1);
});

test('on a beam, nothing is ever answered as a terminal probe', () => {
  const p = new T.Parser({ plain: true });
  // The same bytes a terminal would be asked, arriving as pane output.
  const evs = feed(p, BEAM_OPENING, '%output %0 \\033]11;?\\033\\134\\033[6n\n');
  assert.equal(evs.filter((e) => e.type === 'probe').length, 0);
  assert.ok(evs.some((e) => e.type === 'output' && e.pane === '%0'));
});

test('on a beam, a warning from tsh before tmux speaks is noise, not the start', () => {
  const p = new T.Parser({ plain: true });
  const before = feed(p, 'WARNING: your credentials expire in 5 minutes\n');
  assert.ok(!before.some((e) => e.type === 'ready'));
  assert.ok(before.some((e) => e.type === 'noise'));
  const after = feed(p, BEAM_OPENING);
  assert.equal(after[0].type, 'ready');
});

test('a DCS parser is unchanged: plain lines before the DCS are still the banner', () => {
  const p = new T.Parser();
  const evs = feed(p, '%begin 1 2 0\n');
  assert.ok(!evs.some((e) => e.type === 'ready' || e.type === 'result'));
});

test('output is tagged with the pane it came from', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  const evs = feed(p, '%output %2 hello\\015\\012\n');
  assert.deepEqual(evs, [{ type: 'output', pane: '%2', data: 'hello\r\n' }]);
});

test('a line split across reads is not interpreted until it is whole', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  // Split in the middle of an escape sequence, which is where it hurts.
  const a = feed(p, '%output %0 \\03');
  assert.deepEqual(a, [], 'nothing is emitted from half a line');
  const b = feed(p, '3[1mbold\n');
  assert.deepEqual(b, [{ type: 'output', pane: '%0', data: '\u001b[1mbold' }]);
});

test('a command block is collected and reported as one result', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  const evs = feed(p, '%begin 1790971668 285 1\n@0 zsh aafd,120x40,0,0,0\n%end 1790971668 285 1\n');
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], {
    type: 'result', num: '285', flags: '1', error: false,
    lines: ['@0 zsh aafd,120x40,0,0,0'],
  });
});

/*
 * The one that made it "work the second time".
 *
 * Control mode opens with an empty block that is nobody's reply. Matched to
 * the first command, every answer after it is the previous one's — so
 * `list-windows` returns what `refresh-client` would have, the window list
 * comes back empty, and no panes are built. The guard line's third field is
 * what tells them apart.
 */
test('the opening block is marked as not a reply', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  const open = feed(p, '%begin 1790971667 279 0\n%end 1790971667 279 0\n');
  assert.equal(open[0].flags, '0', 'tmux marks its own block with 0');
  const mine = feed(p, '%begin 1790971668 285 1\n@0 zsh\n%end 1790971668 285 1\n');
  assert.equal(mine[0].flags, '1', 'a reply to a command is marked 1');
  assert.deepEqual(mine[0].lines, ['@0 zsh']);
});

test('a failed command is a result that says so, not a thrown line', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  const evs = feed(p, '%begin 1 2 1\nparse error: unknown command\n%error 1 2 1\n');
  assert.equal(evs[0].error, true);
  assert.deepEqual(evs[0].lines, ['parse error: unknown command']);
});

test('a line inside a block is never read as a notification', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  // `capture-pane` of a screen that happens to show protocol text.
  const evs = feed(p, '%begin 1 2 1\n%output %0 this is captured text\n%end 1 2 1\n');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'result');
  assert.deepEqual(evs[0].lines, ['%output %0 this is captured text']);
});

test('a layout change carries the parsed tree', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  const evs = feed(p,
    '%layout-change @0 3aab,120x40,0,0[120x20,0,0,0,120x19,0,21,2] 3aab,120x40,0,0[120x20,0,0,0,120x19,0,21,2] -\n');
  assert.equal(evs[0].type, 'layout');
  assert.equal(evs[0].window, '@0');
  assert.deepEqual(T.panesInLayout(evs[0].tree), ['%0', '%2']);
});

test('the window and session notifications are understood', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  const evs = feed(p, [
    '%window-add @1',
    '%window-renamed @1 vim',
    '%window-pane-changed @0 %2',
    '%session-window-changed $0 @1',
    '%session-changed $0 serverlife',
    '%window-close @1',
    '%exit',
  ].join('\n') + '\n');
  const kinds = evs.map((e) => e.type);
  assert.deepEqual(kinds, ['window-add', 'window-renamed', 'active-pane',
    'active-window', 'session', 'window-close', 'exit']);
  assert.equal(evs[1].name, 'vim');
  assert.equal(evs[2].pane, '%2');
  assert.equal(evs[4].name, 'serverlife');
});

test('flow control output carries how far behind this client is', () => {
  const p = new T.Parser();
  feed(p, T.DCS);
  const evs = feed(p, '%extended-output %0 1200 : still\\040going\n');
  assert.equal(evs[0].type, 'output');
  assert.equal(evs[0].pane, '%0');
  assert.equal(evs[0].age, 1200);
  assert.equal(evs[0].data, 'still going');
  const pause = feed(p, '%pause %0\n%continue %0\n');
  assert.deepEqual(pause.map((e) => e.type), ['pause', 'continue']);
});

/* ---------------- quoting ---------------- */

test('a session name cannot escape its quotes', () => {
  assert.equal(T.shellQuote('serverlife'), `'serverlife'`);
  assert.equal(T.shellQuote("it's"), `'it'\\''s'`);
  assert.equal(T.shellQuote('; rm -rf /'), `'; rm -rf /'`);
});
