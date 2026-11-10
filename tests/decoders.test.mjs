import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const D = require_(path.join(__PROJECT_ROOT__, 'src/main/decoders.js'));

/** The subnet calculator, the URL helper and the three credential decoders. */

test('a subnet with host bits set, checked against an address', () => {
  const r = D.cidr('10.0.0.5/24 10.0.0.200');
  assert.equal(r.cidr, '10.0.0.0/24');
  assert.equal(r.hostBitsSet, true);
  assert.equal(r.first, '10.0.0.1');
  assert.equal(r.last, '10.0.0.254');
  assert.equal(r.broadcast, '10.0.0.255');
  assert.equal(r.usable, '254');
  assert.deepEqual(r.check, { address: '10.0.0.200', inside: true });
  assert.equal(D.cidr('172.16.0.0/12', { check: '172.32.0.1' }).check.inside, false);
});

test('a dotted netmask, /31 and /32', () => {
  assert.equal(D.cidr('192.168.1.0 255.255.240.0').cidr, '192.168.0.0/20');
  assert.equal(D.cidr('10.0.0.0/31').usable, '2');
  assert.equal(D.cidr('10.0.0.9').cidr, '10.0.0.9/32');
  assert.equal(D.maskToPrefix('255.0.255.0'), null);
});

test('IPv6 is compressed the RFC 5952 way', () => {
  const r = D.cidr('2001:db8:0:0:1::1/64');
  assert.equal(r.network, '2001:db8::');
  assert.equal(r.lastAddress, '2001:db8::ffff:ffff:ffff:ffff');
  assert.equal(D.bigToV6(D.v6ToBig('::ffff:10.0.0.1')), '::ffff:a00:1');
  assert.throws(() => D.cidr('10.0.0.0/33'), /prefix/);
});

test('a URL is decoded, encoded and taken apart', () => {
  const r = D.url('https://ex.com/a%20b?x=1&y=hello%20world');
  assert.equal(r.decoded, 'https://ex.com/a b?x=1&y=hello world');
  assert.deepEqual(r.query, [{ key: 'x', value: '1' }, { key: 'y', value: 'hello world' }]);
  assert.equal(D.url('a b&c').encoded, 'a%20b%26c');
  assert.equal(D.url('plain').decoded, null);
});

test('a JWT: claims, times, and what kind it is', () => {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = [part({ alg: 'RS256' }), part({ sub: 'spiffe://ex.org/w', exp: 2000, iat: 1000 }), 'c2ln'].join('.');
  const r = D.jwt('Bearer ' + tok, { now: 1500 * 1000 });
  assert.equal(r.state, 'valid');
  assert.equal(r.kind, 'JWT-SVID (SPIFFE)');
  assert.equal(r.expiresIn, 500);
  assert.equal(r.signature.verified, false);
  assert.equal(D.jwt(tok, { now: 3000 * 1000 }).state, 'expired');
  assert.throws(() => D.jwt('a.b'), /three parts/);
});

const haveKeygen = (() => { try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); return true; } catch (e) { return e.status !== undefined && e.status !== 127 && e.code !== 'ENOENT'; } })();

test('an SSH certificate reads as ssh-keygen -L prints it', { skip: !haveKeygen && 'no ssh-keygen' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcert-'));
  const k = (n, t) => execFileSync('ssh-keygen', ['-q', '-t', t, '-N', '', '-f', path.join(dir, n)]);
  k('ca', 'ed25519'); k('user', 'ecdsa');
  execFileSync('ssh-keygen', ['-q', '-s', path.join(dir, 'ca'), '-I', 'alice', '-n', 'alice,root', '-V', '+1h',
    '-O', 'extension:teleport-roles=dev', path.join(dir, 'user.pub')]);
  const r = D.sshCert(fs.readFileSync(path.join(dir, 'user-cert.pub'), 'utf8'));
  const listed = execFileSync('ssh-keygen', ['-L', '-f', path.join(dir, 'user-cert.pub')]).toString();
  assert.equal(r.type, 'user');
  assert.deepEqual(r.principals, ['alice', 'root']);
  assert.equal(r.state, 'valid');
  assert.equal(r.teleport, true);
  assert.ok(listed.includes(r.keyFingerprint));
  assert.ok(listed.includes(r.ca.fingerprint));
  assert.throws(() => D.sshCert(fs.readFileSync(path.join(dir, 'user.pub'), 'utf8')), /plain key/);
});

const haveOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('an X.509-SVID and the SPIFFE rules', { skip: !haveOpenssl && 'no openssl' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slsvid-'));
  const make = (san, ca) => {
    const out = path.join(dir, `c${Math.random()}.pem`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', path.join(dir, 'k.pem'), '-out', out, '-days', '1', '-subj', '/O=SPIFFE',
      '-addext', `subjectAltName=${san}`, '-addext', `basicConstraints=critical,CA:${ca}`], { stdio: 'ignore' });
    return fs.readFileSync(out, 'utf8');
  };
  const good = D.svid(make('URI:spiffe://example.org/ns/prod/sa/web', 'FALSE'));
  assert.equal(good.ok, true);
  assert.equal(good.spiffeId, 'spiffe://example.org/ns/prod/sa/web');
  const bad = D.svid(make('URI:spiffe://Example.org', 'TRUE'));
  assert.equal(bad.ok, false);
  assert.equal(bad.certificates[0].problems.length, 3);
});

test('a certificate’s extensions are sorted into what they mean', { skip: !haveKeygen && 'no ssh-keygen' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcert2-'));
  const k = (n) => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, n)]);
  k('ca'); k('user');
  execFileSync('ssh-keygen', ['-q', '-s', path.join(dir, 'ca'), '-I', 'bob@example.com', '-n', 'bob,-teleport-internal-join', '-V', '+1h',
    '-O', 'clear', '-O', 'permit-pty', '-O', 'source-address=10.0.0.0/8',
    '-O', 'extension:teleport-roles={"roles":["access","editor"]}',
    '-O', 'extension:teleport-traits={"logins":["bob"],"groups":["a","b",""]}',
    '-O', 'extension:teleport-route-to-cluster=example.com',
    '-O', 'extension:teleport-device-asset-tag=TAG1',
    '-O', 'extension:something@else.org=x',
    path.join(dir, 'user.pub')]);
  const file = path.join(dir, 'user-cert.pub');
  const r = D.sshCert(fs.readFileSync(file, 'utf8'));
  const x = r.readable;
  assert.deepEqual(x.permissions, ['Interactive terminal']);
  assert.deepEqual(x.roles, ['access', 'editor']);
  assert.deepEqual(x.traits, [{ name: 'groups', values: ['a', 'b'] }, { name: 'logins', values: ['bob'] }]);
  assert.deepEqual(x.teleport, [{ name: 'Cluster', value: 'example.com' }]);
  assert.deepEqual(x.device, [{ name: 'Asset tag', value: 'TAG1' }]);
  assert.deepEqual(x.other, [{ name: 'something@else.org', value: 'x' }]);
  assert.deepEqual(x.restrictions, [{ name: 'Only from', value: '10.0.0.0/8' }]);
  // The raw view is ssh-keygen -L's own layout, line for line where both print text.
  const listed = execFileSync('ssh-keygen', ['-L', '-f', file]).toString().split('\n').slice(1, 7)
    .map((l) => l.trimEnd());
  assert.deepEqual(r.raw.split('\n').slice(0, 6), listed);
});

test('JWT claims come out in reading order, roles and traits apart', () => {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = [part({ alg: 'RS256' }),
    part({ exp: 2000, roles: ['access'], traits: { logins: ['bob'] }, iss: 'teleport', sub: 'bob', aud: ['https://app'], iat: 1000 }),
    'c2ln'].join('.');
  const r = D.jwt(tok, { now: 1500 * 1000 });
  assert.deepEqual(r.claims.fields.map((f) => f.key), ['iss', 'sub', 'aud', 'iat', 'exp']);
  assert.equal(r.claims.fields.find((f) => f.key === 'exp').time, new Date(2000 * 1000).toISOString());
  assert.deepEqual(r.claims.fields.find((f) => f.key === 'aud').list, ['https://app']);
  assert.deepEqual(r.claims.roles, ['access']);
  assert.deepEqual(r.claims.traits, [{ name: 'logins', values: ['bob'] }]);
  assert.equal(r.raw.signature, 'c2ln');
});
