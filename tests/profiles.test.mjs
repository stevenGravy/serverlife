import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * The main process is CommonJS, and this test is bundled into a temp
 * directory — so the module is required by absolute path, from the root the
 * runner defines, rather than relative to a file that has moved.
 */
const require = createRequire(import.meta.url);
const teleport = require(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));

/**
 * Removing a dead tsh profile.
 *
 * This is the one piece of the app that deletes files in somebody's home
 * directory, so it is the piece most worth pinning down: what it takes as a
 * name, what it will and will not touch, and whether it reports honestly
 * about what went. The alternative — finding out by running it — is not
 * available twice.
 */

function home({ proxy = 'lab.example.com', port = ':443', keys = true, current = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsh-home-'));
  writeFileSync(path.join(dir, `${proxy}.yaml`), 'web_proxy_addr: ' + proxy + port + '\n');
  if (keys) {
    mkdirSync(path.join(dir, 'keys', proxy), { recursive: true });
    writeFileSync(path.join(dir, 'keys', proxy, 'cert'), 'stale');
  }
  if (current) writeFileSync(path.join(dir, 'current-profile'), current);
  return dir;
}

test('the profile is named after the host, and the address carries a port', () => {
  const dir = home();
  const files = teleport.profileFiles({ proxy: 'lab.example.com:443', home: dir });
  assert.equal(files.length, 2, 'the yaml and the keys are both found through the ported address');
  assert.ok(files[0].endsWith('lab.example.com.yaml'));
  assert.ok(files[1].endsWith(path.join('keys', 'lab.example.com')));
});

test('removing takes the profile, its keys, and nothing else', async () => {
  const dir = home({ current: 'lab.example.com' });
  writeFileSync(path.join(dir, 'other.example.com.yaml'), 'keep me');
  mkdirSync(path.join(dir, 'keys', 'other.example.com'), { recursive: true });

  const r = await teleport.removeProfile({ proxy: 'lab.example.com:443', home: dir });
  assert.equal(r.ok, true);
  assert.equal(r.removed.length, 3, 'the yaml, the keys, and the current-profile that named it');

  assert.ok(!existsSync(path.join(dir, 'lab.example.com.yaml')));
  assert.ok(!existsSync(path.join(dir, 'keys', 'lab.example.com')));
  assert.ok(!existsSync(path.join(dir, 'current-profile')));
  // The other cluster in the same home is untouched.
  assert.ok(existsSync(path.join(dir, 'other.example.com.yaml')));
  assert.ok(existsSync(path.join(dir, 'keys', 'other.example.com')));
});

test('a current-profile naming somebody else is left alone', async () => {
  const dir = home({ current: 'other.example.com' });
  await teleport.removeProfile({ proxy: 'lab.example.com', home: dir });
  assert.equal(readFileSync(path.join(dir, 'current-profile'), 'utf8'), 'other.example.com');
});

test('a profile with no key material left still goes', async () => {
  const dir = home({ keys: false });
  const r = await teleport.removeProfile({ proxy: 'lab.example.com', home: dir });
  assert.equal(r.ok, true);
  assert.equal(r.removed.length, 1);
  assert.ok(!existsSync(path.join(dir, 'lab.example.com.yaml')));
});

test('a proxy that is not a proxy is refused, and nothing is touched', async () => {
  const dir = home();
  for (const bad of ['../../etc/passwd', 'a/b', '', '  ', 'lab.example.com/../..', './lab']) {
    const r = await teleport.removeProfile({ proxy: bad, home: dir });
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.match(r.error, /does not look like a proxy/);
  }
  // Everything that was there before is still there.
  assert.ok(existsSync(path.join(dir, 'lab.example.com.yaml')));
  assert.deepEqual(teleport.profileFiles({ proxy: '../../etc', home: dir }), []);
});

test('removing something that is not there says so rather than pretending', async () => {
  const dir = home();
  const r = await teleport.removeProfile({ proxy: 'never-logged-in.example.com', home: dir });
  // The file was already absent, so the removal is a no-op that still
  // succeeds — what matters is that it reports nothing was deleted.
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed.filter((f) => existsSync(f)), []);
  assert.ok(existsSync(path.join(dir, 'lab.example.com.yaml')), 'and the real profile survives');
});

/**
 * Two nodes, one hostname.
 *
 * Everything downstream of a duplicate hangs off this one boolean — the
 * transport the node is forced onto, the name it is dialled by, the label
 * on its tab, the mark on its row — and getting it wrong is silent both
 * ways. A false positive dials an ordinary node by UUID; a false negative
 * hands tsh a name that means two machines, and tsh refuses to guess.
 */

const node = (hostname, uuid) => ({ hostname, uuid, cluster: 'tele1c' });

test('nodes sharing a hostname are marked, and the rest are not', () => {
  const nodes = [
    node('duplicate', 'uuid-1'),
    node('duplicate', 'uuid-2'),
    node('web-1', 'uuid-3'),
  ];
  teleport.markAmbiguous(nodes);
  assert.deepEqual(nodes.map((n) => n.ambiguous), [true, true, false]);
});

test('a hostname that appears once is never ambiguous, whatever else is there', () => {
  const nodes = [node('a', '1'), node('b', '2'), node('c', '3')];
  teleport.markAmbiguous(nodes);
  assert.deepEqual(nodes.map((n) => n.ambiguous), [false, false, false]);
});

test('an ambiguous node is dialled by its id, an ordinary one by its name', () => {
  const dupe = { hostname: 'duplicate', uuid: 'uuid-1', cluster: 'tele1c', ambiguous: true };
  const plain = { hostname: 'web-1', uuid: 'uuid-3', cluster: 'tele1c', ambiguous: false };
  assert.equal(teleport.teleportSshTarget(dupe, 'steven'), 'steven@uuid-1.tele1c',
    'the UUID is the only name that means exactly one node');
  assert.equal(teleport.teleportSshTarget(plain, 'steven'), 'steven@web-1.tele1c');
  // And with no login, which is how a target is built before one is chosen.
  assert.equal(teleport.teleportSshTarget(dupe), 'uuid-1.tele1c');
});

test('a node with no uuid falls back to its name rather than to nothing', () => {
  const odd = { hostname: 'legacy', uuid: '', cluster: 'tele1c', ambiguous: true };
  assert.equal(teleport.teleportSshTarget(odd, 'steven'), 'steven@legacy.tele1c');
});

/**
 * The question tsh stops to ask.
 *
 * `tsh request create` for a resource works out which of your
 * search_as_roles could grant it, and with more than one it stops and asks
 * which. From a spawned process that is "failed reading prompt response:
 * EOF" and no request — the most confusing way for this to fail, since
 * everything in the dialog was right. The names it was about to offer are
 * in the output, so they are read back and put to the person instead.
 */

test('the roles tsh was about to offer are read back out', () => {
  const numbered = [
    'Available roles:',
    '  1. access',
    '  2. dev-access',
    '  3. prod-access',
    'Choose roles to request [1]: ',
    'ERROR: failed reading prompt response: EOF',
  ].join('\n');
  assert.deepEqual(teleport.roleChoicesFrom(numbered), ['access', 'dev-access', 'prod-access']);

  // Some versions print the set inline instead.
  assert.deepEqual(
    teleport.roleChoicesFrom('Choose roles to request [access, dev-access]: failed reading prompt response: EOF'),
    ['access', 'dev-access'],
  );
});

test('an error that is not that question offers nothing', () => {
  // A wrong parse would put nonsense in front of someone as roles, so the
  // bar is a message that actually looks like the prompt.
  assert.deepEqual(teleport.roleChoicesFrom('ERROR: access denied'), []);
  assert.deepEqual(teleport.roleChoicesFrom('ERROR: request reason must be specified'), []);
  assert.deepEqual(teleport.roleChoicesFrom(''), []);
  // A numbered list that is not about roles is not harvested either.
  assert.deepEqual(teleport.roleChoicesFrom('Nodes:\n  1. web-1\n  2. web-2'), []);
});

/**
 * Which roles a resource request should carry.
 *
 * Teleport will not say. There is no dry run on `tsh request create`, the
 * resource search carries no roles, and `request search --roles` lists role
 * requests rather than the search_as_roles a resource request resolves
 * through — the only way to make the cluster name them is to raise a
 * request, which is not something a dialog may do to find out what to put
 * in a dialog. Your own history, though, has said it already.
 */

const req = (roles, ids) => ({ roles, resources: ids.map((id) => ({ id })) });

test('the roles a resource was granted through before are offered', () => {
  const history = [
    req(['access'], ['/c1/node/aaa']),
    req(['access', 'staging-access'], ['/c1/node/bbb']),
    req(['aws-access'], []),
  ];
  assert.deepEqual(teleport.rolesForResources(history, ['/c1/node/bbb']), ['access', 'staging-access']);
  assert.deepEqual(teleport.rolesForResources(history, ['/c1/node/aaa']), ['access']);
});

test('several resources at once give the union, each role once', () => {
  const history = [
    req(['access'], ['/c1/node/aaa']),
    req(['access', 'staging-access'], ['/c1/node/bbb']),
  ];
  assert.deepEqual(teleport.rolesForResources(history, ['/c1/node/aaa', '/c1/node/bbb']),
    ['access', 'staging-access']);
});

test('a resource never requested before offers nothing, rather than everything', () => {
  const history = [req(['admin-access'], ['/c1/node/aaa'])];
  assert.deepEqual(teleport.rolesForResources(history, ['/c1/node/zzz']), []);
  assert.deepEqual(teleport.rolesForResources(history, []), []);
  assert.deepEqual(teleport.rolesForResources([], ['/c1/node/aaa']), []);
});

test('requestable roles are read as tsh spells them, with their descriptions', () => {
  // `request search --roles` answers { Role, Description } — capitalised,
  // and `Role` rather than the `Name` its own resource search uses. Reading
  // `Name` returned nothing, so a cluster offering two perfectly good roles
  // looked like one offering none.
  const raw = [
    { Role: 'staging-access', Description: 'SSH to staging RHEL hosts and Kibana.' },
    { Role: 'aws-access', Description: 'AWS console access to account 123456789012.' },
  ];
  assert.deepEqual(teleport.parseRequestableRoles(raw), [
    { name: 'aws-access', description: 'AWS console access to account 123456789012.' },
    { name: 'staging-access', description: 'SSH to staging RHEL hosts and Kibana.' },
  ], 'sorted, and nothing dropped');
});

test('other shapes of the same answer still read', () => {
  assert.deepEqual(teleport.parseRequestableRoles(['plain']), [{ name: 'plain', description: '' }]);
  assert.deepEqual(teleport.parseRequestableRoles([{ name: 'lower' }]), [{ name: 'lower', description: '' }]);
  assert.deepEqual(teleport.parseRequestableRoles([{ nothing: true }]), []);
  assert.deepEqual(teleport.parseRequestableRoles(null), []);
});
