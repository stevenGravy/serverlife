import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const C = require_(path.join(__PROJECT_ROOT__, 'src/main/cityscan.js'));
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/filekinds.js'));

/**
 * The 3D view's measurements. A building's height and colours come from
 * these numbers, so a scanner that miscounts draws a city that lies — and
 * the local walk and the remote find|awk have to tell the same story.
 */

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cityscan-'));
  const put = (rel, bytes) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(bytes));
  };
  put('app src/main.js', 100);
  put('app src/deep/er/util.ts', 50);
  put('app src/notes.md', 7);
  put('logs/syslog.log.3', 400);
  put('logs/app.log', 40);
  put('pics/a.PNG', 30);
  put('pics/b.tar.gz', 20);
  fs.mkdirSync(path.join(root, 'empty'));
  put('loose.txt', 5);            // in the directory itself: not under any folder
  return root;
}

test('kinds: extensions, case, rotated logs, and what is not an extension', () => {
  assert.equal(K.kindOf('main.JS'), 'code');
  assert.equal(K.kindOf('backup.tar.gz'), 'archives');
  assert.equal(K.kindOf('syslog.log.3'), 'logs');
  assert.equal(K.kindOf('report.2'), 'other');
  assert.equal(K.kindOf('.bashrc'), 'other');
  assert.equal(K.kindOf('Makefile'), 'other');
  assert.equal(K.kindOf('server.pem'), 'secrets');
});

test('local scan: totals per folder, by kind, loose files left out', async () => {
  const root = tree();
  const r = await C.scanLocal(root);
  assert.equal(r.truncated, false);
  assert.deepEqual(Object.keys(r.children).sort(), ['app src', 'empty', 'logs', 'pics']);
  const app = r.children['app src'];
  assert.equal(app.bytes, 157);
  assert.equal(app.files, 3);
  assert.equal(app.dirs, 2);
  assert.deepEqual(app.kinds, { code: 150, docs: 7 });
  assert.deepEqual(r.children.logs.kinds, { logs: 440 });
  assert.deepEqual(r.children.pics.kinds, { images: 30, archives: 20 });
  assert.equal(r.children.empty.bytes, 0);
});

test('remote command agrees with the local walk', { skip: process.platform === 'win32' }, async () => {
  const root = tree();
  const out = execFileSync('/bin/sh', ['-c', C.remoteCommand(root)]).toString();
  const remote = C.parseRemote(out, root);
  const local = await C.scanLocal(root);
  assert.equal(remote.truncated, false);
  for (const name of ['app src', 'logs', 'pics']) {
    const a = remote.children[name], b = local.children[name];
    assert.equal(a.bytes, b.bytes, name);
    assert.equal(a.files, b.files, name);
    assert.equal(a.dirs, b.dirs, name);
    assert.deepEqual(a.kinds, b.kinds, name);
  }
});

test('remote parse: a cut-off run is reported as partial, an unreadable folder as an error', () => {
  const partial = C.parseRemote('D\tlogs\t2\t0\t440\nX\tlogs\tlog\t440\n', '/var');
  assert.equal(partial.truncated, true);
  assert.equal(partial.children.logs.bytes, 440);
  assert.deepEqual(partial.children.logs.kinds, { logs: 440 });

  const capped = C.parseRemote('N\t300000\nEND\n', '/', { maxEntries: 300000 });
  assert.equal(capped.truncated, true);

  assert.throws(() => C.parseRemote('ERR cannot enter\n', '/root'), /Cannot read \/root/);
});

test('remote command quotes the directory', () => {
  const cmd = C.remoteCommand("/tmp/it's here");
  assert.match(cmd, /cd '\/tmp\/it'\\''s here'/);
});
