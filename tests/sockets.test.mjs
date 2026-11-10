import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const S = require_(path.join(__PROJECT_ROOT__, 'src/main/sockets.js'));

/**
 * Three tools, three column layouts, parsed into the same shape — tested
 * against real sample output from each, since that output is the whole
 * contract here (none of the three were designed to be machine-read).
 */

test('splitAddrPort: bracketed IPv6, bare IPv4, and the wildcard forms every tool uses for "nothing"', () => {
  assert.deepEqual(S.splitAddrPort('10.0.0.5:443'), { addr: '10.0.0.5', port: 443 });
  assert.deepEqual(S.splitAddrPort('[::1]:443'), { addr: '::1', port: 443 });
  assert.deepEqual(S.splitAddrPort(':::22'), { addr: '::', port: 22 });
  assert.deepEqual(S.splitAddrPort('0.0.0.0:*'), { addr: '0.0.0.0', port: null });
  assert.deepEqual(S.splitAddrPort('*:*'), { addr: null, port: null });
  assert.deepEqual(S.splitAddrPort(''), { addr: null, port: null });
});

test('ss -tulpn: a listening socket and an established connection, with their process', () => {
  const text = [
    'Netid  State   Recv-Q  Send-Q    Local Address:Port     Peer Address:Port   Process',
    'tcp    LISTEN  0       128             0.0.0.0:22            0.0.0.0:*      users:(("sshd",pid=123,fd=3))',
    'tcp    ESTAB   0       0              10.0.0.5:22           10.0.0.8:51515  users:(("sshd",pid=456,fd=4))',
    'udp    UNCONN  0       0               0.0.0.0:68             0.0.0.0:*     users:(("dhclient",pid=789,fd=20))',
  ].join('\n');
  const rows = S.parseSs(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    proto: 'tcp', state: 'LISTEN', localAddr: '0.0.0.0', localPort: 22,
    remoteAddr: null, remotePort: null, pid: 123, process: 'sshd', line: rows[0].line,
  });
  assert.equal(rows[1].remoteAddr, '10.0.0.8');
  assert.equal(rows[1].remotePort, 51515);
  assert.equal(rows[1].pid, 456);
  assert.equal(rows[2].proto, 'udp');
  assert.equal(rows[2].state, ''); // udp carries no meaningful state here
  assert.equal(rows[2].process, 'dhclient');
});

test('netstat -tulpn: tcp carries a State column, udp one fewer', () => {
  const text = [
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
    'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      123/sshd',
    'udp        0      0 0.0.0.0:68              0.0.0.0:*                           456/dhclient',
  ].join('\n');
  const rows = S.parseNetstatLinux(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, 'LISTEN');
  assert.equal(rows[0].pid, 123);
  assert.equal(rows[0].process, 'sshd');
  assert.equal(rows[1].proto, 'udp');
  assert.equal(rows[1].state, '');
  assert.equal(rows[1].pid, 456);
  assert.equal(rows[1].process, 'dhclient');
});

test('lsof -i -n -P: a listener and an established connection, state in parens', () => {
  const text = [
    'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
    'sshd      123   root   3u   IPv4 0x1234      0t0  TCP  *:22 (LISTEN)',
    'sshd      456   root   10u  IPv4 0x5678      0t0  TCP  10.0.0.5:22->10.0.0.8:51515 (ESTABLISHED)',
    'mdnsd     77    _mdns  4u   IPv4 0x9999      0t0  UDP  *:5353',
  ].join('\n');
  const rows = S.parseLsof(text);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].proto, rows[0].localPort, rows[0].state, rows[0].pid, rows[0].process],
    ['tcp', 22, 'LISTEN', 123, 'sshd']);
  assert.equal(rows[1].remoteAddr, '10.0.0.8');
  assert.equal(rows[1].remotePort, 51515);
  assert.equal(rows[1].state, 'ESTABLISHED');
  assert.equal(rows[2].proto, 'udp');
  assert.equal(rows[2].state, '');
});

test('netstat -ano (Windows): PID only, filled in afterwards from Get-Process', () => {
  const text = [
    'Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       1234',
    '  UDP    0.0.0.0:68             *:*                                    5678',
  ].join('\n');
  const rows = S.parseNetstatWindows(text, { 1234: 'sshd.exe', 5678: 'svchost.exe' });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].state, rows[0].pid, rows[0].process], ['LISTENING', 1234, 'sshd.exe']);
  assert.deepEqual([rows[1].proto, rows[1].pid, rows[1].process], ['udp', 5678, 'svchost.exe']);
});

test('remoteSocketsScript prefers ss, falls back to netstat, and is null with neither', () => {
  assert.equal(S.remoteSocketsScript({ tools: { ss: true, netstat: true } }).tool, 'ss');
  assert.equal(S.remoteSocketsScript({ tools: { netstat: true } }).tool, 'netstat');
  assert.equal(S.remoteSocketsScript({ tools: {} }), null);
  assert.equal(S.remoteSocketsScript(null), null);
});
