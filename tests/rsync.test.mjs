import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

import { fakeSettings } from './helpers.mjs';

const store = fakeSettings({ folderFavorites: [] });
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

const R = await import('../src/renderer/js/rsyncsync.js');

// The main-process half, for the question of whether this machine can run it
// at all. Required by absolute path: it is CommonJS, and this file is bundled
// into a temp directory before it runs.
const require_ = createRequire(import.meta.url);
const main = require_(path.join(__PROJECT_ROOT__, 'src/main/rsync.js'));

/**
 * Building an rsync command.
 *
 * This is the piece worth pinning down, because rsync's two famous
 * foot-guns are both in it: a trailing slash means something, and
 * `--delete` means it permanently. Everything the user ticked has to land
 * as a flag, nothing they did not tick may, and the paths have to come out
 * in the order the direction says.
 */

const local = { kind: 'local', label: 'this machine' };
const remote = { kind: 'remote', label: 'web-1', target: 'ubuntu@web-1.lab' };
const modern = { infoProgress: true, protectArgs: true };

test('a trailing slash is the difference between the folder and its contents', () => {
  assert.equal(R.endpoint(local, '/Users/me/site', { contents: true }), '/Users/me/site/');
  assert.equal(R.endpoint(local, '/Users/me/site', { contents: false }), '/Users/me/site');
  // However the path was typed.
  assert.equal(R.endpoint(local, '/Users/me/site///', { contents: true }), '/Users/me/site/');
  assert.equal(R.endpoint(local, '/Users/me/site/', { contents: false }), '/Users/me/site');
});

test('a remote endpoint names the host rsync will ssh to', () => {
  assert.equal(R.endpoint(remote, '/srv/app', { contents: true }), 'ubuntu@web-1.lab:/srv/app/');
  assert.equal(R.endpoint(remote, '/srv/app', { contents: false }), 'ubuntu@web-1.lab:/srv/app');
});

test('the default is a dry run, and the flags are the safe ones', () => {
  const args = R.buildArgs({ from: '/a/', to: '/b', features: modern });
  assert.ok(args.includes('-n'), 'nothing moves until asked twice');
  assert.ok(args.includes('-a'));
  assert.ok(args.includes('-z'));
  assert.equal(args.includes('--delete'), false, 'never without being asked');
  assert.equal(args.includes('-c'), false);
  assert.deepEqual(args.slice(-2), ['/a/', '/b'], 'source then destination, last');
});

test('delete only appears when it was asked for', () => {
  assert.ok(R.buildArgs({ from: '/a/', to: '/b', del: true, features: modern }).includes('--delete'));
});

test('the real run is the dry run without -n', () => {
  const dry = R.buildArgs({ from: '/a/', to: '/b', dryRun: true, features: modern });
  const real = R.buildArgs({ from: '/a/', to: '/b', dryRun: false, features: modern });
  assert.deepEqual(real, dry.filter((x) => x !== '-n'),
    'what you approved is what runs');
});

test('an old rsync gets a command it understands', () => {
  // macOS ships openrsync as /usr/bin/rsync: it answers to 2.6.9 and has
  // neither of these. A clever flag it has never heard of is a failure on
  // the first line rather than a slower copy.
  const old = R.buildArgs({ from: '/a/', to: '/b', features: { infoProgress: false, protectArgs: false } });
  assert.ok(old.includes('--progress'));
  assert.equal(old.some((x) => x.startsWith('--info=')), false);
  assert.equal(old.includes('-s'), false);
});

test('excludes and extra flags are passed through, blanks are not', () => {
  const args = R.buildArgs({
    from: '/a/', to: '/b', features: modern,
    excludes: ['.git', '  ', 'node_modules', ''],
    extra: '  --bwlimit=8M   --partial ',
  });
  const ex = args.filter((x, i) => args[i - 1] === '--exclude');
  assert.deepEqual(ex, ['.git', 'node_modules']);
  assert.ok(args.includes('--bwlimit=8M'));
  assert.ok(args.includes('--partial'));
  assert.equal(args.includes(''), false);
});

test('the ssh it rides is passed as one argument, however long', () => {
  const shell = 'ssh -F /tmp/cfg -o IdentitiesOnly=yes -o ControlPath=/tmp/c-1 -o ControlMaster=no';
  const args = R.buildArgs({ from: '/a/', to: 'ubuntu@web-1:/b', features: modern, shellArg: shell });
  const i = args.indexOf('-e');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], shell, 'one argv entry: spawn takes a list, so nothing needs quoting');
});

test('the command shown is the command run, with spaces made visible', () => {
  const args = R.buildArgs({ from: '/a b/', to: '/c', features: modern });
  const line = R.commandLine(args);
  assert.ok(line.startsWith('rsync '));
  assert.match(line, /"\/a b\/"/, 'a path with a space is quoted for reading');
  assert.match(line, / \/c$/);
});

test('starred folders are offered per side, and only folders', () => {
  state.settings = {
    ...store,
    folderFavorites: [
      { path: '/Users/me/site', scope: 'local', kind: 'dir' },
      { path: '/Users/me/notes.md', scope: 'local', kind: 'file' },
      { path: '/var/log', scope: 'hosts', kind: 'dir', label: 'logs' },
      { path: '/srv/app', scope: 'uuid:abc', kind: 'dir' },
    ],
  };
  assert.deepEqual(R.starredFolders({ kind: 'local' }).map((f) => f.path), ['/Users/me/site'],
    'a starred file is not somewhere to sync to');
  assert.deepEqual(R.starredFolders({ kind: 'remote' }).map((f) => f.label), ['logs', '/srv/app'],
    'both the every-host stars and this host’s own');
  state.settings = store;
});

/*
 * And where it must not pretend to work.
 */

test('Windows is told no, and told what to use instead', () => {
  const why = main.unsupportedReason('win32');
  assert.match(why, /not available on Windows/);
  assert.match(why, /Synchronize with the other list/,
    'a refusal that names the thing that does work is worth twice one that does not');
});

test('everywhere else is allowed to try', () => {
  for (const p of ['darwin', 'linux', 'freebsd']) {
    assert.equal(main.unsupportedReason(p), '');
  }
});
