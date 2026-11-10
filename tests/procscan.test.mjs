import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const P = require_(path.join(__PROJECT_ROOT__, 'src/main/procscan.js'));

/**
 * The city's traffic. Each ps prints its columns its own way, and a parser
 * that loses a process to a space in its name draws a town missing a car.
 */

test('GNU and BSD output: full paths shortened, spaces in names kept', () => {
  const out = P.parse([
    '  633 44.3 111152 _windowserver /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
    '    1  0.0  12000 root /sbin/launchd',
    ' 4242  3,5 204800 steven /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].join('\n'));
  const byPid = Object.fromEntries(out.map((p) => [p.pid, p]));
  assert.equal(byPid[633].name, 'WindowServer');
  assert.equal(byPid[633].cpu, 44.3);
  assert.equal(byPid[633].mem, 111152 * 1024);
  assert.equal(byPid[4242].name, 'Google Chrome');
  assert.equal(byPid[4242].cpu, 3.5, 'a comma decimal is still a number');
  assert.equal(byPid[1].user, 'root');
});

test('busybox has no CPU column, and those rows still count', () => {
  const out = P.parse('  12 20480 root nginx\n  13 4096 www sh');
  assert.deepEqual(out.map((p) => [p.pid, p.cpu, p.name]), [[12, 0, 'nginx'], [13, 0, 'sh']]);
});

test('busiest first, and only the top few', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `${i + 1} ${i} 1024 u p${i}`);
  const out = P.parse(lines.join('\n'), { top: 5 });
  assert.equal(out.length, 5);
  assert.equal(out[0].name, 'p59');
});

test('junk lines are skipped, not misread', () => {
  assert.deepEqual(P.parse('PID %CPU RSS USER COMMAND\n\nps: something odd\n'), []);
});
