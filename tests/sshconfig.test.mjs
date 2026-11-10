import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const require_ = createRequire(import.meta.url);
const C = require_(path.join(__PROJECT_ROOT__, 'src/main/sshconfig.js'));

/**
 * The no-ssh-client fallback parser (readAliasFromFile) is pure file
 * reading, so it is tested directly rather than through `ssh -G`. Repeated
 * IdentityFile/CertificateFile lines should collect into a list, the same
 * shape `ssh -G` itself returns once a key repeats.
 */
test('IdentityFile and CertificateFile accumulate; every other key keeps its first value', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'serverlife-sshconfig-'));
  const file = path.join(dir, 'config');
  await fs.writeFile(file, [
    'Host bastion',
    '  HostName bastion.example.com',
    '  User first',
    '  User second',
    '  CertificateFile ~/.ssh/id_ed25519-cert.pub',
    '  IdentityFile ~/.ssh/id_ed25519',
    '  IdentityFile ~/.ssh/id_rsa_fallback',
    '',
  ].join('\n'));
  try {
    const cfg = await C.readAliasFromFile({ alias: 'bastion', source: file });
    assert.equal(cfg.user, 'first'); // first value wins, same as ssh_config itself
    assert.deepEqual(cfg.identityfile, ['~/.ssh/id_ed25519', '~/.ssh/id_rsa_fallback']);
    assert.equal(cfg.certificatefile, '~/.ssh/id_ed25519-cert.pub'); // only one: stays a bare string
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
