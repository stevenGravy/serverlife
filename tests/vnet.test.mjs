import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { VnetManager, scopedHome } = require_(path.join(__PROJECT_ROOT__, 'src/main/vnet.js'));

/**
 * Starting and stopping VNet, against a stand-in tsh.
 *
 * The real `tsh vnet` reconfigures the machine's network, so it is no thing to
 * run in a test. The stand-in is a shell script that behaves the way matters
 * here: says it is up and waits, leaving cleanly on Ctrl-C — or fails.
 */

const posix = process.platform !== 'win32';

/** A tsh home with the given profiles in it, as tsh lays them out. */
function tshHome(...names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-tshhome-'));
  for (const n of names) {
    fs.writeFileSync(path.join(dir, `${n}.yaml`), 'web_proxy_addr: x\n');
    fs.mkdirSync(path.join(dir, 'keys', n), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keys', n, 'certs.pem'), 'cert');
  }
  fs.writeFileSync(path.join(dir, 'known_hosts'), '');
  fs.writeFileSync(path.join(dir, 'current-profile'), names[names.length - 1] + '\n');
  return dir;
}

function fakeTsh(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-vnet-'));
  const file = path.join(dir, 'tsh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function until(mgr, home, want, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`never reached ${want}`)), ms);
    const check = (v) => {
      if ((v.home || null) === home && v.state === want) { clearTimeout(t); mgr.off('state', check); resolve(v); }
    };
    mgr.on('state', check);
  });
}

test('start reaches running, and stop leaves it stopped', { skip: !posix && 'POSIX shell needed' }, async () => {
  const tsh = fakeTsh(`trap 'echo stopping; exit 0' INT\necho "VNet is running"\nwhile :; do sleep 0.2; done`);
  const home = tshHome('a.example.com');
  const mgr = new VnetManager({ findTsh: () => tsh, tshEnv: () => process.env });
  mgr.scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-scope-'));
  mgr.start({ home, proxy: 'a.example.com:443' });
  await until(mgr, home, 'running');
  mgr.stop('a.example.com:443');
  const v = await until(mgr, home, 'stopped');
  assert.ok(v.log.includes('VNet is running'));
  assert.equal(v.cluster, 'a.example.com');
});

test('a VNet that exits on its own is an error, with the reason from its output', { skip: !posix && 'POSIX shell needed' }, async () => {
  const tsh = fakeTsh('echo "ERROR: VNet requires the signed tsh.app" >&2\nexit 1');
  const home = tshHome('b.example.com');
  const mgr = new VnetManager({ findTsh: () => tsh, tshEnv: () => process.env });
  mgr.scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-scope-'));
  mgr.start({ home, proxy: 'b.example.com:443' });
  const v = await until(mgr, home, 'error');
  assert.match(v.error, /requires the signed tsh\.app/);
});

test('one VNet at a time: the same cluster is not started twice, another is refused', { skip: !posix && 'POSIX shell needed' }, async () => {
  const tsh = fakeTsh(`trap 'exit 0' INT\necho ready\nwhile :; do sleep 0.2; done`);
  const home = tshHome('c.example.com', 'd.example.com');
  const mgr = new VnetManager({ findTsh: () => tsh, tshEnv: () => process.env });
  mgr.scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-scope-'));
  mgr.start({ home, proxy: 'c.example.com:443' });
  await until(mgr, home, 'running');
  mgr.start({ home, proxy: 'c.example.com:443' });
  assert.equal(mgr.status().length, 1);
  assert.throws(() => mgr.start({ home, proxy: 'd.example.com:443' }), /already running for c\.example\.com/);
  mgr.stop('c.example.com:443');
  await until(mgr, home, 'stopped');
});

test('VNet sees one cluster: its home holds that profile and no other', () => {
  const real = tshHome('wanted.example.com', 'expired.example.com');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-scope-'));
  const dir = scopedHome(real, 'https://wanted.example.com:443', root);
  const yamls = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.deepEqual(yamls, ['wanted.example.com.yaml']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'keys')), ['wanted.example.com']);
  assert.equal(fs.readFileSync(path.join(dir, 'current-profile'), 'utf8'), 'wanted.example.com\n');
  // Linked, not copied: a renewed certificate is the one VNet reads.
  assert.ok(fs.lstatSync(path.join(dir, 'keys', 'wanted.example.com')).isSymbolicLink());
  assert.equal(scopedHome(real, 'not-logged-in.example.com', root), null);
});
