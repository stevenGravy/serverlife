import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const N = require_(path.join(__PROJECT_ROOT__, 'src/main/nettools.js'));

const IAC = 255, DO = 253, WILL = 251, ECHO = 1, TTYPE = 24;

/** A server on a free local port that does `onConn`, then the port. */
async function serve(onConn) {
  const server = net.createServer(onConn);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return { server, port: server.address().port };
}

/**
 * The telnet probe.
 *
 * Its one job is to report what a port says when it is connected to, and the
 * cases that matter are the ones where a careless probe reports the wrong
 * thing: a device that will not speak until its negotiation is answered, a
 * service that says nothing at all, and nothing listening.
 */

test('a banner is reported, and a server that names itself is recognised', async () => {
  const { server, port } = await serve((s) => s.end('SSH-2.0-OpenSSH_9.6\r\n'));
  try {
    const r = await N.telnetProbe({ host: '127.0.0.1', port, wait: 1500 });
    assert.equal(r.state, 'open');
    assert.equal(r.text, 'SSH-2.0-OpenSSH_9.6');
    assert.equal(r.guess, 'an SSH server');
    assert.equal(r.telnet, false);
    assert.equal(r.command, process.platform === 'win32'
      ? `Test-NetConnection -ComputerName 127.0.0.1 -Port ${port}`
      : `nc -v 127.0.0.1 ${port}`);
  } finally { server.close(); }
});

test('negotiation is answered, so a device that waits for it shows its prompt', async () => {
  const { server, port } = await serve((s) => {
    // Like a switch: ask first, and only greet once something has answered.
    s.write(Buffer.from([IAC, DO, TTYPE, IAC, WILL, ECHO]));
    s.once('data', () => {
      s.write('\x1b[1mUser Access Verification\x1b[0m\r\n\r\nUsername: ');
    });
  });
  try {
    const r = await N.telnetProbe({ host: '127.0.0.1', port, wait: 2000 });
    assert.equal(r.state, 'open');
    assert.equal(r.telnet, true);
    assert.equal(r.guess, 'a telnet server');
    // Escape sequences out, negotiation bytes out, line endings settled.
    assert.equal(r.text, 'User Access Verification\n\nUsername:');
  } finally { server.close(); }
});

test('a port that says nothing is open, not broken', async () => {
  const { server, port } = await serve(() => {});
  try {
    const r = await N.telnetProbe({ host: '127.0.0.1', port, wait: 500 });
    assert.equal(r.state, 'open');
    assert.equal(r.text, '');
    assert.equal(r.guess, null);
  } finally { server.close(); }
});

test('nothing listening reads as a refusal, in telnet’s words', async () => {
  const { server, port } = await serve(() => {});
  await new Promise((res) => server.close(res));
  const r = await N.telnetProbe({ host: '127.0.0.1', port, wait: 500 });
  assert.equal(r.state, 'closed');
  assert.match(r.error, /Connection refused/);
});

test('targets are validated, and the port field wins over one written into the target', async () => {
  await assert.rejects(N.telnetProbe({ host: 'bad host!', port: 23 }), /Host names may only/);
  await assert.rejects(N.telnetProbe({ host: 'example.com', port: 70000 }), /1 to 65535/);
  const { server, port } = await serve((s) => s.end('hi\r\n'));
  try {
    const r = await N.telnetProbe({ host: `127.0.0.1:1`, port, wait: 500 });
    assert.equal(r.port, port);
  } finally { server.close(); }
});

test('banners are cleaned and the obvious services named', () => {
  assert.equal(N.cleanBanner('\x1b[2J\x1b[Hhello\r\n\r\n\r\n\r\nworld\x07'), 'hello\n\nworld');
  assert.equal(N.guessService('220 mail.example.com ESMTP Postfix', false), 'a mail server (SMTP)');
  assert.equal(N.guessService('RFB 003.008', false), 'a VNC server');
  assert.equal(N.guessService('Password: ', false), 'something asking you to log in');
  assert.equal(N.guessService('', false), null);
});

/*
 * The renderer's half: what the shared target field becomes when telnet reads
 * it. From a host this lands on a command line, so what it refuses matters as
 * much as what it accepts.
 */
const { fakeSettings } = await import('./helpers.mjs');
fakeSettings({});
const R = await import('../src/renderer/js/nettools.js');

test('the target field is read as telnet would read it', () => {
  assert.deepEqual(R.telnetTarget('switch-1', '23'), { host: 'switch-1', port: 23 });
  assert.deepEqual(R.telnetTarget('switch-1', ''), { host: 'switch-1', port: 23 });
  assert.deepEqual(R.telnetTarget('telnet://console-1:2001', '23'), { host: 'console-1', port: 2001 });
  assert.deepEqual(R.telnetTarget('https://proxy.example.com/web', '22'), { host: 'proxy.example.com', port: 22 });
  assert.deepEqual(R.telnetTarget('[2001:db8::1]:23', ''), { host: '2001:db8::1', port: 23 });
  assert.deepEqual(R.telnetTarget('admin@10.0.0.5', '23'), { host: '10.0.0.5', port: 23 });
  assert.throws(() => R.telnetTarget('box; rm -rf /', '23'), /Host names may only/);
  assert.throws(() => R.telnetTarget('', '23'), /Give a host/);
  assert.throws(() => R.telnetTarget('box', '99999'), /1 to 65535/);
});

/*
 * ipVersion forcing for ping/traceroute/port-check. macOS/BSD's own ping and
 * traceroute have no -6 of their own — ping6/traceroute6 are the separate
 * IPv6-only siblings — so the assertion branches on platform rather than
 * assuming the Linux/Windows -4/-6 shape everywhere.
 */
test('ping and traceroute can be forced onto one IP family', () => {
  const ping6 = N.previewCommand({ tool: 'ping', host: 'example.com', ipVersion: '6' }).command;
  const trace6 = N.previewCommand({ tool: 'traceroute', host: 'example.com', ipVersion: '6' }).command;
  if (process.platform === 'darwin') {
    assert.match(ping6, /^ping6 /);
    assert.match(trace6, /^traceroute6 /);
  } else {
    assert.match(ping6, /-6\b/);
    assert.match(trace6, /-6\b/);
  }
  const ping4 = N.previewCommand({ tool: 'ping', host: 'example.com', ipVersion: '4' }).command;
  assert.doesNotMatch(ping4, /-6\b/);
  assert.doesNotMatch(ping4, /^ping6/);
});

test('a port check can be forced onto one IP family too, where the platform has a flag for it', () => {
  const r = N.previewCommand({ tool: 'ports', host: 'example.com', ports: '443', ipVersion: '6' });
  if (process.platform === 'win32') assert.doesNotMatch(r.command, /-6/);
  else assert.match(r.command, /^nc -zv -6 /);
});

test('a DNS lookup can be pointed at a specific nameserver, and the copied command matches', () => {
  const r = N.previewCommand({ tool: 'dns', host: 'example.com', server: '1.1.1.1' });
  assert.match(r.command, /nslookup -type=A example\.com 1\.1\.1\.1/);
  const noServer = N.previewCommand({ tool: 'dns', host: 'example.com' });
  assert.doesNotMatch(noServer.command, /1\.1\.1\.1/);
});

test('STARTTLS protocols have the right default port and show up in openssl’s own flag', () => {
  assert.deepEqual(N.STARTTLS_PORTS, { smtp: 587, imap: 143, pop3: 110 });
  const r = N.previewCommand({ tool: 'tls', host: 'mail.example.com', starttls: 'smtp' });
  if (process.platform !== 'win32') assert.match(r.command, /-starttls smtp/);
  assert.match(r.command, /mail\.example\.com:587/);
});

test('every DNS type the review asked for is actually queried', () => {
  for (const t of ['CAA', 'SOA', 'NAPTR']) assert.ok(N.DNS_TYPES.includes(t), t);
});

/*
 * curl's own argv: --resolve, a custom CA and a client cert/key, each only
 * added when asked for, and a malformed --resolve entry caught before it
 * ever reaches the real binary.
 */
test('curl: --resolve, a private CA and a client cert are opt-in flags on the real argv', () => {
  const { args } = N.curlArgs({
    url: 'https://internal.example.com',
    resolve: 'internal.example.com:443:10.0.0.5',
    caCert: '/etc/ssl/internal-ca.pem',
    clientCert: '/home/me/client.pem',
    clientKey: '/home/me/client.key',
  });
  assert.deepEqual(args.slice(args.indexOf('--resolve'), args.indexOf('--resolve') + 2),
    ['--resolve', 'internal.example.com:443:10.0.0.5']);
  assert.deepEqual(args.slice(args.indexOf('--cacert'), args.indexOf('--cacert') + 2),
    ['--cacert', '/etc/ssl/internal-ca.pem']);
  assert.deepEqual(args.slice(args.indexOf('--cert'), args.indexOf('--cert') + 2),
    ['--cert', '/home/me/client.pem']);
  assert.deepEqual(args.slice(args.indexOf('--key'), args.indexOf('--key') + 2),
    ['--key', '/home/me/client.key']);
  assert.ok(!N.curlArgs({ url: 'https://example.com' }).args.includes('--resolve'));
});

test('a malformed --resolve entry is rejected before it reaches curl', () => {
  assert.throws(() => N.curlArgs({ url: 'https://example.com', resolve: 'not-the-right-shape' }), /--resolve/);
});

/*
 * The plain HTTP check can now carry its own headers too — the one curl-only
 * capability closest to "just need one header" rather than a whole request.
 */
test('the plain HTTP check sends custom headers, and the copied curl command carries them too', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.end(req.headers['x-request-id'] || 'none');
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  try {
    const r = await N.httpCheck({ url: `http://127.0.0.1:${port}/`, headers: 'X-Request-Id: abc123' });
    assert.equal(r.final.preview, 'abc123');
    assert.match(r.command, /-H 'X-Request-Id: abc123'/);
  } finally { server.close(); }
});

