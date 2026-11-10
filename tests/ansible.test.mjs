import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const A = require_(path.join(__PROJECT_ROOT__, 'src/main/ansible.js'));

/**
 * The Ansible export.
 *
 * The export once set `stdout_callback = yaml`, community.general's plugin,
 * which that collection removed in 12.0 — and a current Ansible then refused
 * to run the bundle at all. Text checks alone would not have caught it: the
 * file was fine, the world moved. So where Ansible is installed, the bundle
 * is also written out and loaded by `ansible-playbook` itself, the way a
 * person would run it, without touching any host.
 */

const targets = [
  { type: 'ssh', name: 'web-1', alias: 'web-1', hostname: '10.0.0.1', login: 'ubuntu', port: 22 },
  { type: 'ssh', name: 'web-2', alias: 'web-2', hostname: '10.0.0.2', login: 'ubuntu', port: 22 },
];

test('ansible.cfg asks for YAML output from the built-in callback, not the removed plugin', () => {
  const { cfg } = A.build(targets, 'df -h');
  assert.doesNotMatch(cfg, /^stdout_callback\s*=\s*(community\.general\.)?yaml\s*$/m);
  assert.match(cfg, /^stdout_callback = ansible\.builtin\.default$/m);
  assert.match(cfg, /^callback_result_format = yaml$/m);
});

const ansible = spawnSync('ansible-playbook', ['--version'], { encoding: 'utf8' });
const haveAnsible = ansible.status === 0;

test('the exported bundle loads in the installed ansible-playbook', { skip: !haveAnsible && 'ansible-playbook is not installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ansible-'));
  try {
    await A.write(dir, A.build(targets, 'df -h'));
    // --syntax-check and --list-hosts read the config, inventory and play
    // and stop there: nothing is connected to.
    for (const flag of ['--syntax-check', '--list-hosts']) {
      const r = spawnSync('ansible-playbook', ['playbook.yml', flag], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, ANSIBLE_CONFIG: path.join(dir, 'ansible.cfg') },
      });
      assert.equal(r.status, 0, `ansible-playbook ${flag} failed:\n${r.stdout}\n${r.stderr}`);
      if (flag === '--list-hosts') {
        // Inventory names are slugs (web_1), and Ansible lists them in its
        // own order: both hosts, either way round.
        assert.match(r.stdout, /hosts \(2\)/);
        assert.match(r.stdout, /web_1/);
        assert.match(r.stdout, /web_2/);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command runs with raw, needing no Python on the host, and no tty', () => {
  const { playbook, cfg } = A.build(targets, 'df -h');
  assert.match(playbook, /ansible\.builtin\.raw: \|/);
  assert.doesNotMatch(playbook, /ansible\.builtin\.shell/);
  assert.match(cfg, /^usetty = False$/m);
  // A failure names its cause: stderr, else Ansible's own message.
  assert.match(playbook, /result\.msg/);
});

test('the export folder name is one safe folder, whatever was typed', () => {
  assert.equal(A.exportFolderName('db backups'), 'db backups');
  assert.equal(A.exportFolderName('../../etc/passwd'), 'etc-passwd');
  assert.equal(A.exportFolderName('a/b\\c:d*e?'), 'a-b-c-d-e');
  assert.equal(A.exportFolderName('trailing dots...'), 'trailing dots');
  assert.equal(A.exportFolderName('   '), 'serverlife-ansible');
  assert.equal(A.exportFolderName('CON'), 'serverlife-ansible');
});

test('the suggested name comes from the command', () => {
  assert.equal(A.suggestFolderName('df -h'), 'ansible-df');
  assert.equal(A.suggestFolderName('/usr/bin/systemctl restart nginx'), 'ansible-systemctl');
  assert.equal(A.suggestFolderName(''), 'serverlife-ansible');
});
