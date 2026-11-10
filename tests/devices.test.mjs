import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const D = require_(path.join(__PROJECT_ROOT__, 'src/main/devices.js'));
const RDP = require_(path.join(__PROJECT_ROOT__, 'src/main/rdp.js'));

const IAC = 255, DO = 253, DONT = 254, WILL = 251, WONT = 252, SB = 250, SE = 240;
const TTYPE = 24, NAWS = 31, ECHO = 1, SGA = 3;

const buf = (...b) => Buffer.from(b);
const parse = (chunks) => {
  let st = null;
  let data = Buffer.alloc(0);
  let replies = Buffer.alloc(0);
  let naws = false;
  for (const c of chunks) {
    const r = D.telnetParse(st, Buffer.isBuffer(c) ? c : buf(...c));
    st = r.state;
    data = Buffer.concat([data, r.data]);
    replies = Buffer.concat([replies, r.replies]);
    naws = naws || r.sawNaws;
  }
  return { data: data.toString('latin1'), replies: [...replies], state: st, naws };
};

/**
 * Telnet.
 *
 * The protocol is interleaved with the output rather than framed around it,
 * so the only way to be wrong is to be wrong in the middle of somebody's
 * `show running-config` — a byte eaten here is a character missing from a
 * configuration someone is about to paste somewhere. The cases below are the
 * ones that actually bite: a command split across packets, a 0xFF in the
 * data, and a server that asks a question we have no answer to.
 */

test('ordinary output passes through untouched', () => {
  const r = parse([Buffer.from('Switch> show version\r\n')]);
  assert.equal(r.data, 'Switch> show version\r\n');
  assert.deepEqual(r.replies, []);
});

test('the options we can honour are accepted, and the rest refused', () => {
  const r = parse([[IAC, DO, TTYPE, IAC, DO, NAWS, IAC, DO, 99]]);
  assert.deepEqual(r.replies, [IAC, WILL, TTYPE, IAC, WILL, NAWS, IAC, WONT, 99]);
  assert.ok(r.naws, 'the window size is offered once they ask for it');
});

test('a server that offers to echo is taken up on it', () => {
  const r = parse([[IAC, WILL, ECHO, IAC, WILL, SGA, IAC, WILL, 77]]);
  assert.deepEqual(r.replies, [IAC, DO, ECHO, IAC, DO, SGA, IAC, DONT, 77]);
});

test('the terminal type is answered when it is asked for', () => {
  const r = parse([[IAC, SB, TTYPE, 1, IAC, SE]]);
  assert.equal(Buffer.from(r.replies).toString('latin1'),
    `\xff\xfa\x18\x00xterm-256color\xff\xf0`);
});

test('a command split across two packets is still one command', () => {
  // The three bytes of IAC DO TTYPE arrive one per read, with data either side.
  const r = parse([[0x68, IAC], [DO], [TTYPE, 0x69]]);
  assert.equal(r.data, 'hi', 'no byte of the command leaks into the output');
  assert.deepEqual(r.replies, [IAC, WILL, TTYPE]);
});

test('a subnegotiation split across packets is reassembled', () => {
  const r = parse([[IAC, SB, TTYPE], [1], [IAC, SE]]);
  assert.equal(Buffer.from(r.replies).toString('latin1').includes('xterm-256color'), true);
});

test('0xFF in the output is one byte, not the start of a command', () => {
  const r = parse([[0x41, IAC, IAC, 0x42]]);
  assert.equal(r.data, 'A\xffB');
  assert.deepEqual(r.replies, []);
});

test('a two-byte command with nothing to answer is simply dropped', () => {
  // IAC NOP, IAC "Are You There", then real output.
  const r = parse([[IAC, 241, IAC, 246, 0x6f, 0x6b]]);
  assert.equal(r.data, 'ok');
  assert.deepEqual(r.replies, []);
});

test('the window size is framed as two big-endian pairs', () => {
  assert.deepEqual([...D.nawsFrame(132, 43)], [IAC, SB, NAWS, 0, 132, 0, 43, IAC, SE]);
  // A dimension that lands on 0xFF has to be escaped like any other byte.
  assert.deepEqual([...D.nawsFrame(255, 24)], [IAC, SB, NAWS, 0, IAC, IAC, 0, 24, IAC, SE]);
});

test('what the user types is escaped the same way', () => {
  assert.deepEqual([...D.escapeIac(Buffer.from([1, IAC, 2]))], [1, IAC, IAC, 2]);
});

/**
 * Enter.
 *
 * Nothing agrees about what it sends, and getting it wrong gives you either a
 * console that looks dead or one that double-spaces everything — both of
 * which get blamed on the cable.
 */
test('Return is translated to whatever the far end expects', () => {
  assert.equal(D.translateNewline('ls\r', 'cr'), 'ls\r');
  assert.equal(D.translateNewline('ls\r', 'lf'), 'ls\n');
  assert.equal(D.translateNewline('ls\r', 'crlf'), 'ls\r\n');
  // Already-correct input is not doubled.
  assert.equal(D.translateNewline('ls\r\n', 'crlf'), 'ls\r\n');
  assert.equal(D.translateNewline('ls\r\n', 'lf'), 'ls\n');
  // No setting means no translation at all.
  assert.equal(D.translateNewline('ls\r', null), 'ls\r');
});

/**
 * Telnet's own voice.
 *
 * Half of telnet's remaining use is pointing it at a port to see whether
 * anything is listening — and such a port says nothing until it is spoken
 * to, so the client's own three lines are the only evidence that anything
 * happened. A session to an HTTPS port that prints nothing is
 * indistinguishable from one that failed.
 */
test('connecting says what the client has always said', () => {
  const d = new D.DeviceSessions();
  const greeting = d._telnetGreeting({ remoteAddress: '3.238.220.225' }, 'enterprise.example.com');
  assert.equal(greeting,
    "Trying 3.238.220.225...\r\nConnected to enterprise.example.com.\r\nEscape character is '^]'.\r\n");
});

test('an IPv4 address mapped into IPv6 is shown as the address it is', () => {
  const d = new D.DeviceSessions();
  assert.match(d._telnetGreeting({ remoteAddress: '::ffff:10.0.0.5' }, 'h'), /^Trying 10\.0\.0\.5\.\.\./);
  // Nothing resolved yet: the name is better than nothing at all.
  assert.match(d._telnetGreeting({}, 'host-only'), /^Trying host-only\.\.\./);
});

test('a refusal is reported in telnet\u2019s words, not node\u2019s', () => {
  assert.equal(D.telnetError({ code: 'ECONNREFUSED' }, 'switch-1', 23),
    'telnet: Unable to connect to remote host: Connection refused (switch-1:23)');
  assert.equal(D.telnetError({ code: 'ENOTFOUND' }, 'no-such.invalid'),
    'telnet: could not resolve no-such.invalid: Name or service not known');
  assert.match(D.telnetError({ code: 'ETIMEDOUT' }, 'h', 23), /Operation timed out/);
  assert.match(D.telnetError({ code: 'EHOSTUNREACH' }, 'h', 23), /No route to host/);
  assert.match(D.telnetError({ code: 'ECONNRESET' }, 'h'), /reset by peer/);
  // Anything unforeseen still arrives as a sentence rather than a code.
  assert.equal(D.telnetError({ message: 'something else' }, 'h'), 'telnet: something else');
});

test('the three ways a serial port refuses are each said plainly', () => {
  const perm = D.serialHint(new Error('Permission denied, cannot open /dev/ttyUSB0'), '/dev/ttyUSB0');
  assert.match(perm, /permission denied/i);
  assert.match(D.serialHint(new Error('Resource temporarily unavailable'), '/dev/x'), /in use by something else/);
  assert.match(D.serialHint(new Error('No such file or directory'), '/dev/x'), /not there/);
});

/**
 * RDP: the settings, written into the file the platform's own client reads.
 * What is checked here is that the file says what the dialog said — a wrong
 * key is a setting that silently does nothing.
 */
test('the .rdp file carries the connection', () => {
  const f = RDP.rdpFile({ hostname: 'win-1', port: 3389, username: 'admin', width: 1600, height: 1000 });
  assert.match(f, /^full address:s:win-1$/m, 'the default port is not appended');
  assert.match(f, /^username:s:admin$/m);
  assert.match(f, /^desktopwidth:i:1600$/m);
  assert.match(f, /^screen mode id:i:1$/m);
  assert.equal(f.includes('\r\n'), true, 'the format is CRLF');
});

test('a non-default port goes on the address, where that client wants it', () => {
  const f = RDP.rdpFile({ hostname: 'win-1', port: 33389 });
  assert.match(f, /^full address:s:win-1:33389$/m);
});

test('full screen drops the size and can span monitors', () => {
  const f = RDP.rdpFile({ hostname: 'w', fullscreen: true, multimon: true });
  assert.match(f, /^screen mode id:i:2$/m);
  assert.match(f, /^use multimon:i:1$/m);
  assert.equal(/desktopwidth/.test(f), false);
});

test('redirections are off unless asked for', () => {
  const f = RDP.rdpFile({ hostname: 'w' });
  assert.match(f, /^drivestoredirect:s:$/m);
  assert.match(f, /^redirectprinters:i:0$/m);
  assert.match(f, /^redirectclipboard:i:1$/m);
});

test('FreeRDP gets the same connection as command-line arguments', () => {
  const a = RDP.freerdpArgs({ hostname: 'win-1', port: 3389, username: 'admin', fullscreen: true }, 3);
  assert.ok(a.includes('/v:win-1:3389'));
  assert.ok(a.includes('/u:admin'));
  assert.ok(a.includes('/f'));
  assert.ok(a.includes('/cert:ignore'), 'FreeRDP 3 spells it with a colon');
  assert.ok(RDP.freerdpArgs({ hostname: 'w' }, 2).includes('/cert-ignore'));
});
