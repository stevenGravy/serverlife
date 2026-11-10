import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings } from './helpers.mjs';

const store = fakeSettings({});
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

const A = await import('../src/renderer/js/activity.js');

/**
 * What a tab says about its session.
 *
 * The risk here is not missing a prompt — it is claiming one. A tab that
 * lights up amber whenever a line happens to end in a question mark is a
 * tab nobody believes by the end of the morning, and the highlight stops
 * meaning "this is stuck" and starts meaning nothing. So the wolf cases get
 * as much attention as the real ones.
 */

test('the things that really do stop a session are recognised', () => {
  const asks = [
    '[sudo] password for steven: ',
    "steven@web-1's password: ",
    'Enter passphrase for key /Users/steven/.ssh/id_ed25519: ',
    'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
    'Do you want to continue? [Y/n] ',
    'Overwrite /etc/nginx/nginx.conf? ',
    'Press enter to continue',
    'Press any key to continue . . .',
    'Enter an OTP code from a device: ',
    'Tap any security key',
    'MFA code: ',
  ];
  for (const line of asks) assert.ok(A.looksLikePrompt(line), `waiting: ${JSON.stringify(line)}`);
});

test('ordinary output is not a question, however it ends', () => {
  const noise = [
    '➜  ~ ',
    'steven@web-1:~$ ',
    '[root@db-2 ~]# ',
    'Reading package lists... Done',
    'What is this? It is a line in a log file that ends in a question mark?',
    'Compiling serde v1.0.203',
    '100%[===================>] 4.21M  --.-KB/s    in 0.4s',
    'error: failed to run custom build command for `openssl-sys`',
    // The words are there, in the past tense, as output rather than a question.
    'Password changed successfully',
    'sudo: 1 incorrect password attempt',
    '',
    '   ',
  ];
  for (const line of noise) assert.equal(A.looksLikePrompt(line), false, `not waiting: ${JSON.stringify(line)}`);
});

test('only the last line counts — a question already answered is not waiting', () => {
  const tail = [
    '[sudo] password for steven: ',
    'Reading package lists... Done',
    'Building dependency tree... Done',
  ].join('\n');
  assert.equal(A.looksLikePrompt(tail), false);
});

test('a prompt wearing colour is still a prompt', async () => {
  A.forgetPane('p1');
  // What a shell actually sends: bold red on, the words, colour off.
  const raw = '\u001b[1;31mPassword:\u001b[0m ';
  assert.equal(A.looksLikePrompt(raw), false,
    'the escape sequences sit between the colon and the end of the line');
  // Which is why the tail is cleaned on the way in, and that is what the
  // state is actually read from.
  A.noteOutput('p1', raw);
  assert.equal(A.paneActivity('p1'), 'moving', 'it only just arrived');
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(A.paneActivity('p1'), 'waiting', 'and the colour did not hide it');
});

test('a pane goes moving, then waiting, once the question has sat there', async () => {
  A.forgetPane('p2');
  A.noteOutput('p2', 'Reading package lists... ');
  assert.equal(A.paneActivity('p2'), 'moving');
  A.noteOutput('p2', '\nDo you want to continue? [Y/n] ');
  // Still arriving: output that has not settled is movement, not a wait.
  assert.equal(A.paneActivity('p2'), 'moving');
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(A.paneActivity('p2'), 'waiting');
});

test('output that stops without asking anything just goes quiet', async () => {
  A.forgetPane('p3');
  A.noteOutput('p3', 'make: Nothing to be done for `all\'.\n➜  ~ ');
  await new Promise((r) => setTimeout(r, 950));
  assert.equal(A.paneActivity('p3'), 'idle');
});

/*
 * A coding agent waiting for permission.
 *
 * The case this mark earns its keep on: an agent run in a tab you are not
 * looking at stops on a permission box and waits there all afternoon. The
 * question is several lines above the options, so none of the last-line
 * patterns can see it.
 */

const CLAUDE_BOX = [
  '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e',
  '\u2502 Bash command                                    \u2502',
  '\u2502                                                 \u2502',
  '\u2502   rm -rf build/                                 \u2502',
  '\u2502   Remove the build directory                    \u2502',
  '\u2502                                                 \u2502',
  '\u2502 Do you want to proceed?                         \u2502',
  '\u2502 \u276f 1. Yes                                       \u2502',
  "\u2502   2. Yes, and don't ask again for rm commands   \u2502",
  '\u2502   3. No, and tell Claude what to do differently \u2502',
  '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f',
].join('\n');

test('an agent asking permission is waiting, though the question is not the last line', async () => {
  A.forgetPane('agent');
  A.noteOutput('agent', CLAUDE_BOX);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(A.paneActivity('agent'), 'waiting');
});

test('the phrasings the agents actually use are recognised', () => {
  const asks = [
    'Do you want to make this edit to sessions.js?\n  1. Yes\n  2. No',
    'Do you want to create tools/run-tests.mjs?\n\u276f 1. Yes',
    'Would you like to run this command?\n  y / n',
    'Allow command?\n  1. Yes (y)\n  2. No (n)',
    'Approve this edit before it is applied?',
    "  2. Yes, and don't ask again this session",
    '  3. No, and tell Codex what to do differently',
    'Waiting for your approval',
    'Press y to confirm',
  ];
  for (const a of asks) assert.ok(A.looksLikePrompt(a), `waiting: ${JSON.stringify(a.slice(0, 40))}`);
});

/*
 * The real thing, pasted out of a terminal: an MCP tool-use box, the
 * question, the options, a blank line, and a footer. Everything that makes
 * it hard is here — the question is five lines up, the last line mentions
 * neither yes nor no, and the screen has blank rows under it.
 */
const REAL_BOX = [
  ' \u2500'.repeat(40),
  ' Tool use',
  '',
  '   Google Calendar \u2014 Lists calendar events in a gi\u2026 Tool: (MCP)',
  '',
  '   startTime: "2026-09-24T00:00:00-04:00"',
  '   orderBy: "startTime"',
  '',
  ' Do you want to proceed?',
  ' \u276f 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel \u00b7 Tab to amend',
  '',
  '',
].join('\n');

test('a real agent permission box is recognised, footer and blank rows and all', () => {
  assert.ok(A.looksLikePrompt(REAL_BOX));
});

test('blank rows under the box do not hide the line that matters', () => {
  // A screen is a fixed height and what is drawn on it rarely fills the
  // last row, so the rows below are empty. Reading the last line literally
  // would find nothing and conclude nothing was being asked.
  assert.ok(A.looksLikePrompt(CLAUDE_BOX + '\n\n\n   \n'));
});

test('an agent that is working, not asking, does not light the tab up', () => {
  const busy = [
    '\u2733 Thinking\u2026 (12s \u00b7 esc to interrupt)',
    '\u2022 Running tests\u2026 (esc to interrupt)',
    '\u23fa Reading src/renderer/js/activity.js',
    'Tool use: Bash(npm test)',
    // The agent quoting its own instructions back in a transcript is not a
    // prompt, because nothing is waiting on it.
    'I will ask before I proceed.',
    'The docs explain what to do if you want to continue from here.',
  ];
  for (const line of busy) assert.equal(A.looksLikePrompt(line), false, `not waiting: ${JSON.stringify(line)}`);
});

test('a box still on screen is a question; the same words with the shell back are not', () => {
  // Waiting: the options are the last thing drawn.
  assert.ok(A.looksLikePrompt(CLAUDE_BOX));
  // Answered, or simply printed — the shell has its prompt back, and the
  // words above it are scrollback. This is the case that would otherwise
  // leave a tab amber all afternoon with nothing wrong.
  for (const back of ['\u279c  ~ ', 'steven@web-1:~$ ', '[root@db-2 ~]# ']) {
    assert.equal(A.looksLikePrompt(CLAUDE_BOX + '\n' + back), false, `back at ${JSON.stringify(back)}`);
  }
});

test('a box that has already been answered stops counting once it scrolls away', () => {
  // Twelve lines of output after the question: it is off the end of what is
  // looked at, which is what stops an answered prompt holding the tab amber.
  const after = Array.from({ length: 14 }, (_, i) => `running step ${i + 1}`).join('\n');
  assert.equal(A.looksLikePrompt(CLAUDE_BOX + '\n' + after), false);
});

test('a pane nobody has written to, and one that has been closed, are idle', () => {
  assert.equal(A.paneActivity('never-seen'), 'idle');
  A.noteOutput('p4', 'something');
  assert.equal(A.paneActivity('p4'), 'moving');
  A.forgetPane('p4');
  assert.equal(A.paneActivity('p4'), 'idle', 'a closed pane stops holding its tab busy');
});

test('a tab takes the state of whichever pane wants you most', async () => {
  for (const id of ['t1:a', 't1:b']) A.forgetPane(id);
  state.panesOf = (tabId) => (tabId === 't1' ? ['t1:a', 't1:b'] : []);

  assert.equal(A.tabActivity('t1'), 'idle');
  A.noteOutput('t1:a', 'building...');
  assert.equal(A.tabActivity('t1'), 'moving');

  // The other pane stops on a password. A build is worth a ripple; something
  // that will sit there until it is answered outranks it.
  A.noteOutput('t1:b', '[sudo] password for steven: ');
  await new Promise((r) => setTimeout(r, 450));
  A.noteOutput('t1:a', 'building...');           // still going
  assert.equal(A.tabActivity('t1'), 'waiting');
});

test('a big chunk costs no more than a small one, and still reads at the end', () => {
  A.forgetPane('p5');
  A.noteOutput('p5', 'x'.repeat(200000) + '\n[sudo] password for steven: ');
  const rec = A.paneActivity('p5');
  assert.equal(rec, 'moving', 'it has only just arrived');
  // The tail kept is short, and the question survived the trimming.
  assert.ok(A.looksLikePrompt('[sudo] password for steven: '));
});

test('the marks can be turned off, and are on until they are', () => {
  assert.equal(A.showTabActivity(), true, 'on unless the preference says otherwise');
  state.settings = { ...store, showTabActivity: false };
  assert.equal(A.showTabActivity(), false);
  // Nothing else changes: the sessions carry on being read exactly as before,
  // so turning the marks back on needs no catching up.
  A.noteOutput('pref', 'still listening');
  assert.equal(A.paneActivity('pref'), 'moving');
  state.settings = { ...store, showTabActivity: true };
  assert.equal(A.showTabActivity(), true);
  state.settings = store;
});
