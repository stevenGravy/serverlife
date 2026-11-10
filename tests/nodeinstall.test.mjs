import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const T = require_(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));

/** Install Teleport on an SSH host: the cluster's install.sh, then node configure with the name and labels. */
test('the chosen cluster\'s install.sh, node configure with name and labels, then the service', () => {
  const r = T.nodeInstallCommand({ proxy: 'teleport.example.com:443', token: 'abc123', nodeName: 'ssh-lab', labels: { env: 'lab', team: 'se' } });
  assert.deepEqual(r.command.split('\n'), [
    'curl -fsSL https://teleport.example.com/scripts/install.sh | sudo sh',
    'sudo teleport node configure --output=file:///etc/teleport.yaml --proxy=teleport.example.com:443 --token=abc123 --node-name=ssh-lab --labels=env=lab,team=se',
    'sudo systemctl enable --now teleport',
  ]);
  assert.equal(r.oneLine, r.command.split('\n').join(' && '));
});

test('no name or labels: node configure without them, and a placeholder until a token exists', () => {
  const r = T.nodeInstallCommand({ proxy: 'https://teleport.example.com/' });
  assert.match(r.command, /--proxy=teleport\.example\.com:443 --token=<join-token>$/m);
  assert.ok(!/--labels|--node-name/.test(r.command));
});

test('a proxy on another port keeps it', () => {
  assert.match(T.nodeInstallCommand({ proxy: 'teleport.example.com:3080' }).command, /--proxy=teleport\.example\.com:3080/);
});

test('anything that could break the command is refused, not quoted around', () => {
  for (const labels of [{ 'bad key': 'x' }, { env: 'a b' }, { env: 'a;b' }, { env: '$(id)' }]) {
    assert.equal(T.nodeInstallCommand({ proxy: 'p', labels }).ok, false, JSON.stringify(labels));
  }
  assert.equal(T.nodeInstallCommand({ proxy: 'p', nodeName: 'my host' }).ok, false);
  assert.equal(T.nodeInstallCommand({}).ok, false);
});
