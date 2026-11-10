import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { parseMonitorLine, MONITOR_SCRIPT } = require_(path.join(__PROJECT_ROOT__, 'src/main/connections.js'));

/**
 * The live stats bar's numbers, as the remote script prints them.
 *
 * The lines below are what a beam actually printed (3 CPUs, 8 GB, no swap),
 * so the parser is checked against the script's real output rather than
 * against a format written down separately.
 */

test('the hello line says how many CPUs and how often', () => {
  assert.deepEqual(parseMonitorLine('SLMON hello cpus=3 interval=2'), { kind: 'hello', cpus: 3, interval: 2 });
});

test('a sample becomes bytes and percentages', () => {
  const s = parseMonitorLine('SLMON cpu=36 memt=8282492 mema=7789728 swapt=0 swapf=0 load=0.01 disk=5 rx=23549 tx=564425 up=2062');
  assert.equal(s.kind, 'sample');
  assert.equal(s.cpu, 3.6, 'cpu arrives in tenths of a percent');
  assert.equal(s.memTotal, 8282492 * 1024);
  assert.equal(s.memUsed, (8282492 - 7789728) * 1024, 'used is total less available');
  assert.equal(s.swapTotal, 0);
  assert.equal(s.load, 0.01);
  assert.equal(s.disk, 5);
  assert.equal(s.rx, 23549);
  assert.equal(s.tx, 564425);
  assert.equal(s.uptime, 2062);
});

test('out-of-range numbers are held to sense, not shown as nonsense', () => {
  const s = parseMonitorLine('SLMON cpu=1500 memt=100 mema=200 swapt=10 swapf=20 load=x disk=140 rx=-5 tx=3 up=1');
  assert.equal(s.cpu, 100);
  assert.equal(s.memUsed, 0, 'never negative');
  assert.equal(s.swapUsed, 0);
  assert.equal(s.load, 0, 'a non-number reads as 0');
  assert.equal(s.disk, 100);
  assert.equal(s.rx, 0);
});

test('a host without /proc says what it is, once', () => {
  assert.deepEqual(parseMonitorLine('SLMON unsupported=Darwin'), { kind: 'unsupported', os: 'Darwin' });
});

test('anything else on the channel is ignored', () => {
  for (const l of ['', 'Last login: Tue', 'bash: warning: setlocale', 'SLMONcpu=3']) assert.equal(parseMonitorLine(l), null, l);
});

test('the interval is clamped to between 2 and 60 seconds', () => {
  assert.match(MONITOR_SCRIPT(0.5), /^i=2\n/);
  assert.match(MONITOR_SCRIPT(5), /^i=5\n/);
  assert.match(MONITOR_SCRIPT(600), /^i=60\n/);
});
