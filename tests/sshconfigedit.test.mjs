import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const C = require_(path.join(__PROJECT_ROOT__, 'src/main/sshconfig.js'));

/** Deleting or commenting out a Host in a config file someone wrote by hand. */

const CONFIG = [
  'Host *',
  '  ServerAliveInterval 30',
  '',
  '# the web box',
  'Host web',
  '  HostName 10.0.0.5',
  '  User deploy',
  '',
  '# the database',
  'Host db db-replica',
  '  HostName 10.0.0.6',
  '',
  'Match host other',
  '  User x',
  '',
].join('\n');

function tmpConfig(text = CONFIG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcfg-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

test('a block ends before the next host’s description', () => {
  const b = C.findHostBlock(CONFIG.split('\n'), 'web');
  assert.deepEqual(CONFIG.split('\n').slice(b.start, b.end), ['Host web', '  HostName 10.0.0.5', '  User deploy']);
  assert.deepEqual(b.shared, []);
});

test('delete removes only that block and keeps a backup', async () => {
  const file = tmpConfig();
  await C.removeHostFromFile({ file, alias: 'web', mode: 'delete' });
  const out = fs.readFileSync(file, 'utf8');
  assert.ok(!/Host web/.test(out));
  assert.ok(!out.includes('# the web box'));
  assert.ok(out.includes('  ServerAliveInterval 30\n\n# the database\nHost db db-replica'));
  assert.equal(fs.readFileSync(file + '.serverlife-backup', 'utf8'), CONFIG);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('comment out keeps every line, prefixed', async () => {
  const file = tmpConfig();
  await C.removeHostFromFile({ file, alias: 'web', mode: 'comment' });
  const out = fs.readFileSync(file, 'utf8');
  assert.match(out, /# Commented out by ServerLife, \d{4}-\d\d-\d\d\n# Host web\n# {3}HostName 10\.0\.0\.5\n# {3}User deploy\n/);
  const names = (await C.collectAliases(file)).map((a) => a.alias);
  assert.deepEqual(names, ['db', 'db-replica']);
});

test('a name sharing a Host line is taken off the line, not the block', async () => {
  const file = tmpConfig();
  await C.removeHostFromFile({ file, alias: 'db-replica', mode: 'delete' });
  const out = fs.readFileSync(file, 'utf8');
  assert.ok(out.includes('Host db\n  HostName 10.0.0.6'));
});

test('an alias that is not there is an error, and the file is untouched', async () => {
  const file = tmpConfig();
  await assert.rejects(C.removeHostFromFile({ file, alias: 'nope' }), /not defined/);
  assert.equal(fs.readFileSync(file, 'utf8'), CONFIG);
});
