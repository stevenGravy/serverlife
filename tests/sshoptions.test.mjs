import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const S = require_(path.join(__PROJECT_ROOT__, 'src/main/sshoptions.js'));

/** Per-host SSH options, and the flags they become for each client. */

test('forwards, SOCKS, jump host and -o become the flags both clients share', () => {
  const o = {
    localForwards: '5432:db.internal:5432', remoteForwards: ['9000:localhost:3000'],
    dynamicForwards: '1080', jumpHost: 'ops@bastion', extraOptions: 'ServerAliveInterval 30',
  };
  const flags = ['-L', '5432:db.internal:5432', '-R', '9000:localhost:3000', '-D', '1080',
    '-J', 'ops@bastion', '-o', 'ServerAliveInterval=30'];
  assert.deepEqual(S.opensshArgs(o), flags);
  assert.deepEqual(S.tshArgs(o), flags);
});

test('reason, invites and automatic requests are tsh flags, and need tsh', () => {
  const o = { reason: 'INC-42 disk', invite: 'alice, bob', requestMode: 'resource', requestReason: 'on call', noResume: true };
  assert.deepEqual(S.tshArgs(o), ['--reason=INC-42 disk', '--invite=alice,bob',
    '--request-mode=resource', '--request-reason=on call', '--no-resume']);
  assert.deepEqual(S.opensshArgs(o), []);
  assert.equal(S.needsTsh(o), true);
  assert.equal(S.needsTsh({ remoteForwards: ['1:a:1'] }), false);
});

test('a forward ssh would refuse is reported, not saved silently', () => {
  const { errors } = S.normalize({ remoteForwards: '9000', dynamicForwards: 'abc', localForwards: '1:h:99999' });
  assert.equal(errors.length, 3);
  assert.match(errors.join('\n'), /port:host:port/);
  assert.equal(S.normalize({ localForwards: '127.0.0.1:8080:[::1]:80' }).errors.length, 0);
});

test('unknown values fall back, and empty options are recognised', () => {
  const { options } = S.normalize({ x11: 'yes please', requestMode: 'always' });
  assert.equal(options.x11, 'off');
  assert.equal(options.requestMode, '');
  assert.equal(S.isEmpty({}), true);
  assert.equal(S.isEmpty({ x11: 'untrusted' }), false);
});

test('the summary says what is set, briefly', () => {
  assert.deepEqual(S.summary({ x11: 'trusted', remoteForwards: '9000:localhost:3000', invite: 'alice' }),
    ['X11 trusted', '-R 9000:localhost:3000', 'invites alice']);
});

test('copy command: tsh ssh for a Teleport host, with every flag and quoting', () => {
  const host = { type: 'teleport', name: 'bms-app-service', hostname: 'bms-app-service', cluster: 'red-fire.beams.sh', proxy: 'red-fire.beams.sh:443' };
  assert.equal(
    S.commandLine({ host, login: 'root', options: { x11: 'untrusted', localForwards: '15500:localhost:22', reason: "it's a test", invite: 'alice' } }),
    "tsh --proxy=red-fire.beams.sh:443 ssh --cluster=red-fire.beams.sh -X -L 15500:localhost:22 '--reason=it'\\''s a test' --invite=alice root@bms-app-service");
});

test('copy command: ssh for a config host, naming its config file', () => {
  const host = { type: 'ssh', alias: 'ent', configFile: '/Users/me/.ssh/extra config' };
  assert.equal(
    S.commandLine({ host, login: 'ubuntu', options: { dynamicForwards: '1080', jumpHost: 'ops@bastion' } }),
    "ssh -F '/Users/me/.ssh/extra config' -D 1080 -J ops@bastion ubuntu@ent");
});

test('-N: forwarding only, in the summary and the copied command', () => {
  const o = { noShell: true, localForwards: '5432:db:5432' };
  assert.equal(S.isEmpty(o), false);
  assert.deepEqual(S.summary(o), ['-L 5432:db:5432', 'no shell (-N)']);
  assert.equal(S.commandLine({ host: { type: 'ssh', alias: 'ent' }, options: o }), 'ssh -L 5432:db:5432 -N ent');
  // Not a flag for the master or for tsh's every command: only the session takes it.
  assert.deepEqual(S.opensshArgs(o), ['-L', '5432:db:5432']);
});

test('a forward may bind every interface — "*" or a leading empty bind', () => {
  assert.equal(S.normalize({ localForwards: '*:8080:localhost:80' }).errors.length, 0);
  assert.equal(S.normalize({ remoteForwards: ':9000:localhost:3000' }).errors.length, 0);
  assert.equal(S.normalize({ dynamicForwards: '*:1080' }).errors.length, 0);
});

test('a Unix-domain socket is a forward endpoint too, either side', () => {
  assert.equal(S.normalize({ localForwards: '8080:/var/run/app.sock' }).errors.length, 0);
  assert.equal(S.normalize({ localForwards: '/tmp/local.sock:db.internal:5432' }).errors.length, 0);
  assert.equal(S.normalize({ localForwards: '/tmp/local.sock:/tmp/remote.sock' }).errors.length, 0);
});

test('-J accepts a multi-hop chain, comma-separated', () => {
  const { errors, options } = S.normalize({ jumpHost: 'bastion1,user@bastion2:2222' });
  assert.equal(errors.length, 0);
  assert.equal(options.jumpHost, 'bastion1,user@bastion2:2222');
  assert.deepEqual(S.opensshArgs(options), ['-J', 'bastion1,user@bastion2:2222']);
  assert.match(S.normalize({ jumpHost: 'bastion1,,bastion2' }).errors[0], /empty hop/);
});

test('an unrecognized -o directive is a warning, not a blocking error', () => {
  const { errors, warnings } = S.normalize({ extraOptions: 'SeverAliveInterval=30' });
  assert.equal(errors.length, 0);
  assert.match(warnings.join('\n'), /not a recognized ssh_config directive/);
  assert.equal(S.normalize({ extraOptions: 'ServerAliveInterval=30' }).warnings.length, 0);
});

