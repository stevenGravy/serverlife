import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { Connection } = require_(path.join(__PROJECT_ROOT__, 'src/main/connections.js'));

/**
 * `IdentitiesOnly=yes` is what keeps a full ssh-agent from burning through
 * sshd's MaxAuthTries before the one key that actually works gets offered —
 * see the comment above sshArgs() in connections.js. It was only ever added
 * for a Teleport-generated config; a plain ~/.ssh/config alias with its own
 * IdentityFile hit the same "Too many authentication failures" failure with
 * nothing to stop it.
 */

test('a plain ssh_config alias with its own IdentityFile gets IdentitiesOnly=yes', () => {
  const c = new Connection({
    type: 'ssh',
    target: 'ubuntu@203.0.113.9',
    configFile: null,
    identityFile: '/Users/x/.ssh/some-key.pem',
  });
  const args = c.sshArgs();
  assert.ok(args.includes('IdentitiesOnly=yes'), args.join(' '));
});

test('a plain ssh_config alias with no IdentityFile is left alone', () => {
  const c = new Connection({
    type: 'ssh',
    target: 'ubuntu@203.0.113.9',
    configFile: null,
  });
  const args = c.sshArgs();
  assert.equal(args.includes('IdentitiesOnly=yes'), false, args.join(' '));
});

test('a Teleport-generated config still forces IdentitiesOnly=yes, as before', () => {
  const c = new Connection({
    type: 'teleport',
    target: 'node.cluster',
    configFile: '/tmp/some-generated-config',
  });
  const args = c.sshArgs();
  assert.ok(args.includes('-F') && args.includes('/tmp/some-generated-config'));
  assert.ok(args.includes('IdentitiesOnly=yes'), args.join(' '));
});

test('a direct (app-defined) host with an identity file still forces it too', () => {
  const c = new Connection({
    type: 'ssh',
    target: 'ubuntu@203.0.113.9',
    configFile: null,
    direct: { hostname: '203.0.113.9', identityFile: '/Users/x/.ssh/some-key.pem' },
  });
  const args = c.sshArgs();
  assert.ok(args.includes('IdentitiesOnly=yes'), args.join(' '));
});
