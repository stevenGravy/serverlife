import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings } from './helpers.mjs';

const store = fakeSettings({ quickConnects: [] });
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

const Q = await import('../src/renderer/js/quickconnect.js');

/**
 * What someone typed, turned into a connection.
 *
 * The address nearly always arrives from somewhere else — a ticket, a chat
 * message, a colleague reading it out — and the whole point of this path is
 * not retyping it into five fields. So the shapes people actually paste are
 * what is pinned down here, including the ones that are not ssh at all.
 */

const p = (s) => Q.parseTarget(s);

test('the ssh shapes still parse as they did', () => {
  assert.deepEqual(
    { ...p('ubuntu@10.0.0.5'), kind: p('ubuntu@10.0.0.5').kind },
    { kind: 'ssh', user: 'ubuntu', hostname: '10.0.0.5', port: 22, identityFile: '', proxyJump: '', command: '' });
  assert.equal(p('web-1.example.com:2222').port, 2222);
  assert.equal(p('ssh -p 2222 -i ~/.ssh/id_ed25519 ops@box').user, 'ops');
  assert.equal(p('ssh -p 2222 ops@box').port, 2222);
  assert.equal(p('nonsense with spaces'), null);
});

test('a protocol can be a scheme or a first word', () => {
  for (const s of ['telnet://switch-1', 'telnet switch-1', 'TELNET://switch-1']) {
    const t = p(s);
    assert.equal(t.kind, 'telnet', s);
    assert.equal(t.hostname, 'switch-1', s);
  }
});

test('each protocol brings its own default port', () => {
  assert.equal(p('telnet://switch-1').port, 23);
  assert.equal(p('vnc://10.0.0.5').port, 5900);
  assert.equal(p('rdp://win-1').port, 3389);
  assert.equal(p('box').port, 22);
});

test('a port given explicitly wins over the protocol default', () => {
  assert.equal(p('vnc://10.0.0.5:5901').port, 5901);
  assert.equal(p('telnet://10.0.0.9:2323').port, 2323);
});

test('a user survives in front of a protocol address', () => {
  const t = p('rdp administrator@win-1');
  assert.equal(t.kind, 'rdp');
  assert.equal(t.user, 'administrator');
  assert.equal(t.hostname, 'win-1');
});

/*
 * A serial port is a path, not an address — the one input here with no host
 * in it at all, and the one most likely to be typed from a `ls /dev/tty*`.
 */
test('a device path is a serial console', () => {
  for (const s of ['/dev/tty.usbserial-1410', '/dev/ttyUSB0', '/dev/cu.usbmodem1', 'COM3', 'serial:/dev/ttyS0']) {
    const t = p(s);
    assert.equal(t?.kind, 'serial', s);
    assert.equal(t.path, s.replace(/^serial:/, ''), s);
    assert.equal(t.baudRate, 115200, 'the speed almost everything uses');
  }
});

test('a speed after the path is taken as the speed', () => {
  assert.equal(p('/dev/ttyUSB0@9600').baudRate, 9600);
  assert.equal(p('/dev/ttyUSB0@9600').path, '/dev/ttyUSB0');
  assert.equal(p('/dev/ttyUSB0,57600').baudRate, 57600);
});

test('a path that is not a device is not a console', () => {
  // Only /dev/… and COM<n> are ports. A stray path is not an address either,
  // so it is refused rather than dialled as a hostname.
  assert.equal(p('/etc/hosts'), null);
  assert.equal(p('/var/log/syslog'), null);
  // `COMEDY` is a perfectly good hostname, so it stays one: a serial port is
  // COM followed by a number, and nothing else.
  assert.equal(p('COMEDY').kind, 'ssh');
  assert.equal(p('COM3').kind, 'serial');
});

/**
 * The label is what the recent list remembers and what a tab is called, so
 * it has to say which protocol it was: `win-1` and `win-1` are the same word
 * for a desktop and a shell.
 */
test('the label carries the protocol, and drops a default port', () => {
  assert.equal(Q.targetLabel(p('ubuntu@10.0.0.5')), 'ubuntu@10.0.0.5');
  assert.equal(Q.targetLabel(p('box:2222')), 'box:2222');
  assert.equal(Q.targetLabel(p('telnet://switch-1')), 'telnet://switch-1');
  assert.equal(Q.targetLabel(p('telnet://switch-1:2323')), 'telnet://switch-1:2323');
  assert.equal(Q.targetLabel(p('vnc://10.0.0.5:5900')), 'vnc://10.0.0.5', 'the default port is not repeated');
  assert.equal(Q.targetLabel(p('/dev/ttyUSB0')), '/dev/ttyUSB0');
  assert.equal(Q.targetLabel(p('/dev/ttyUSB0@9600')), '/dev/ttyUSB0@9600');
});

test('a label parses back to the same thing, so the recent list round-trips', () => {
  for (const s of ['ubuntu@10.0.0.5', 'box:2222', 'telnet://switch-1:2323', 'vnc://10.0.0.5:5901',
    'rdp://win-1', '/dev/ttyUSB0@9600']) {
    const first = p(s);
    const again = p(Q.targetLabel(first));
    assert.equal(again.kind, first.kind, s);
    assert.equal(again.hostname, first.hostname, s);
    assert.equal(again.port, first.port, s);
    assert.equal(again.path, first.path, s);
    assert.equal(again.baudRate, first.baudRate, s);
  }
});
