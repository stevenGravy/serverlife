import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFromLines, looksSecret, macroCommand } from '../src/renderer/js/macrorecord.js';

test('the command is read from where its typing began, wrapped lines joined', () => {
  assert.equal(commandFromLines([{ text: 'user@web-1:~$ systemctl status teleport   ' }], 14), 'systemctl status teleport');
  assert.equal(commandFromLines([
    { text: '$ echo aaaaaaaaaa' }, { text: 'bbbbbbbbbb', wrapped: true },
  ], 2), 'echo aaaaaaaaaabbbbbbbbbb');
  // A shell continuation is a line of its own, without its "> ".
  assert.equal(commandFromLines([
    { text: '$ for h in a b; do' }, { text: '>   echo $h' }, { text: '> done' },
  ], 2), 'for h in a b; do\n  echo $h\ndone');
  // Accepted from reverse search before the shell redrew the line.
  assert.equal(commandFromLines([{ text: "(reverse-i-search)`sys': systemctl restart nginx" }], 0), 'systemctl restart nginx');
  assert.equal(commandFromLines([{ text: '$    ' }], 2), '');
});

test('lines that carry a secret are recognised', () => {
  for (const c of ['export DB_PASSWORD=hunter2', 'mysql -u root -phunter22', 'curl -H "Authorization: Bearer abc"', 'psql --password=x', 'TOKEN=abc ./run']) {
    assert.ok(looksSecret(c), c);
  }
  for (const c of ['passwd', 'ls -la', 'cat /etc/passwd', 'grep -p foo', 'tsh login --proxy=x']) {
    assert.ok(!looksSecret(c), c);
  }
});

test('the kept steps become one command, optionally stopping at the first failure', () => {
  assert.equal(macroCommand(['cd /srv', '', 'git pull ']), 'cd /srv\ngit pull');
  assert.equal(macroCommand(['cd /srv', 'git pull'], { stopOnFail: true }), 'cd /srv &&\ngit pull');
});
