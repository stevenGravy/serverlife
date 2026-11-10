/**
 * The tsh side of ServerLife against a real cluster.
 *
 * Every function here parses something tsh prints — JSON whose fields have
 * moved between releases before, and text where tsh exits 0 on failure. The
 * workflow runs this against the current Teleport major and the one before
 * it, so a change in either shows up as a failing release rather than as a
 * sidebar that is quietly empty for someone on the other version.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, teleportNode, connect, finished, scratch, waitFor, PROXY, CLUSTER, NODE, LOGIN } from './helpers.mjs';

const teleport = main('teleport.js');
const crosstransfer = main('crosstransfer.js');
const { ConnectionManager } = main('connections.js');

const node = await teleportNode();

describe('the cluster, as tsh reports it', () => {
  test('the client is the version under test', async () => {
    const want = process.env.TELEPORT_VERSION;
    const got = await teleport.version();
    assert.ok(got, 'tsh version was read');
    if (want) assert.equal(got, want);
  });

  test('both versions are read, and the verdict agrees with tsh’s own warning', async (t) => {
    const info = await teleport.versionInfo({ proxy: PROXY });
    assert.equal(info.client, process.env.TELEPORT_VERSION);
    if (process.env.IT_CLUSTER_VERSION) assert.equal(info.server, process.env.IT_CLUSTER_VERSION);

    /*
     * tsh warns at login when it is outside what the cluster supports, and
     * ServerLife works the same thing out for itself so it can say so where
     * tsh's warning never reaches. The day Teleport changes the rule, these
     * two stop agreeing and this fails — on the release, not on a laptop.
     */
    const compat = await teleport.compatFor({ proxy: PROXY, refresh: true });
    const warned = teleport.parseVersionWarning(await fs.readFile('/tmp/tsh-login.out', 'utf8'));
    t.diagnostic(`tsh ${info.client} on Teleport ${info.server}: ServerLife says ${compat.level}; `
      + `tsh ${warned ? `warned (${warned.direction})` : 'did not warn'}`);
    assert.notEqual(compat.level, 'unknown');
    assert.equal(!!warned, compat.level !== 'ok',
      `ServerLife's verdict (${compat.level}) and tsh's warning (${warned ? 'yes' : 'no'}) disagree`);
  });

  test('status finds the logged-in profile and what it may do', async () => {
    const s = await teleport.status();
    assert.equal(s.loggedIn, true, s.error || 'no profile');
    const p = s.profiles.find((x) => x.proxy === PROXY);
    assert.ok(p, `a profile for ${PROXY} among ${s.profiles.map((x) => x.proxy).join(', ')}`);
    assert.equal(p.cluster, CLUSTER);
    assert.equal(p.username, 'ci');
    assert.ok(p.logins.includes(LOGIN), `logins include ${LOGIN}: ${p.logins}`);
    assert.ok(p.roles.includes('serverlife-ci'), `roles: ${p.roles}`);
    assert.equal(p.expired, false);
    assert.ok(new Date(p.validUntil).getTime() > Date.now(), 'valid_until parses and is in the future');
  });

  test('the node is listed with its labels and a live heartbeat', async () => {
    assert.equal(node.name, NODE);
    assert.equal(node.cluster, CLUSTER);
    assert.equal(node.tunnel, true, 'an agent dialling out is a tunnel node');
    assert.equal(node.labels.env, 'ci');
    assert.equal(node.labels.role, 'web');
    assert.ok(node.uuid, 'the node has its UUID');
    assert.equal(node.ambiguous, false);
    assert.ok(node.expires && node.expires > Date.now(), 'the heartbeat expiry is read and in the future');
  });

  test('the cluster is a root, not a leaf', async () => {
    const r = await teleport.listClusters({ proxy: PROXY });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.clusters.some((c) => c.name === CLUSTER && !c.leaf), JSON.stringify(r.clusters));
    assert.equal(await teleport.isLeafCluster({ proxy: PROXY, cluster: CLUSTER }), false);
  });

  test('tsh config yields an ssh_config OpenSSH can dial through', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-it-cfg-'));
    try {
      const file = await teleport.writeClusterSshConfig(dir, { proxy: PROXY, cluster: CLUSTER });
      const text = await fs.readFile(file, 'utf8');
      assert.match(text, new RegExp(`Host \\*\\.${CLUSTER}\\b`));
      assert.match(text, /proxy ssh/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('sessions on the node', () => {
  const manager = new ConnectionManager();
  let conn;

  before(async () => { conn = await connect(manager, { host: node, login: LOGIN }); });
  after(() => manager.shutdown());

  test('an open terminal is a live session, and then a recording', async () => {
    const id = 'recorded';
    const marker = `RECORDED-${Date.now().toString(36)}`;
    let seen = '';
    const onData = (p) => { if (p.id === id) seen += p.data; };
    conn.on('terminal-data', onData);
    try {
      await conn.openTerminal({ id });
      conn.writeTerminal(id, `echo ${marker}\r`);
      await waitFor('the marker on screen', () => seen.includes(marker), { timeout: 20000, every: 200 });

      const live = await waitFor('the session in tsh sessions ls', async () => {
        const r = await teleport.listActiveSessions({ proxy: PROXY });
        assert.equal(r.ok, true, r.error);
        return r.sessions.find((s) => s.hostname === NODE && s.login === LOGIN);
      }, { timeout: 30000, every: 1000 });
      assert.equal(live.kind, 'ssh');
      assert.equal(live.joinable, true);

      conn.writeTerminal(id, 'exit\r');
    } finally {
      conn.off('terminal-data', onData);
      conn.closeTerminal(id);
    }

    // A start date and no end, as the recordings dialog asks. tsh refuses a
    // --to-utc in the future outright.
    const from = new Date(Date.now() - 86400_000);
    const rec = await waitFor('the recording to be listed', async () => {
      const r = await teleport.listRecordings({ proxy: PROXY, fromUtc: from });
      assert.equal(r.ok, true, r.error);
      return r.recordings.find((x) => x.node === NODE && x.login === LOGIN && x.interactive);
    }, { timeout: 90000, every: 3000 });
    assert.equal(rec.playable, true);

    /*
     * Readable only once the node has uploaded it, which on a shared CI runner
     * has taken over a minute (0.29.0's release: three timeouts at 60s, all on
     * one client/cluster pairing that passes locally in seconds). Three
     * minutes, and a failure says what tsh play last gave back.
     */
    const text = await waitFor('the transcript to contain the marker', async () => {
      const r = await teleport.playText(rec.sid, { proxy: PROXY });
      if (r.ok && r.text.includes(marker)) return r.text;
      throw new Error(r.ok ? `transcript so far (${r.text.length} chars): ${JSON.stringify(r.text.slice(-160))}` : (r.error || 'tsh play failed'));
    }, { timeout: 180000, every: 3000 });
    assert.ok(text.includes(marker));
  });

  test('tsh scp carries files both ways', async () => {
    const local = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-it-scp-'));
    const remote = scratch(conn, 'scp');
    try {
      await conn.exec(`mkdir -p ${remote}`);
      const src = path.join(local, 'up.txt');
      await fs.writeFile(src, 'over tsh scp\n');
      await conn.tshScp({ direction: 'upload', localPaths: [src], remotePath: `${remote}/` });
      assert.equal(await conn.exec(`cat ${remote}/up.txt`), 'over tsh scp\n');

      const down = path.join(local, 'down');
      await fs.mkdir(down);
      await conn.tshScp({ direction: 'download', remotePath: [`${remote}/up.txt`], localPaths: down });
      assert.equal(await fs.readFile(path.join(down, 'up.txt'), 'utf8'), 'over tsh scp\n');
    } finally {
      await conn.exec(`rm -rf ${remote}`).catch(() => {});
      await fs.rm(local, { recursive: true, force: true });
    }
  });
});

describe('server to server', () => {
  const manager = new ConnectionManager();
  let a;
  let b;
  let plain;

  before(async () => {
    a = await connect(manager, { host: node, login: LOGIN });
    b = await connect(manager, { host: node, login: LOGIN });
    plain = await connect(manager, { host: { id: 'ssh:opensshnode', type: 'ssh', alias: 'opensshnode', name: 'opensshnode' } });
  });
  after(() => manager.shutdown());

  async function copy(src, dest, label) {
    const from = scratch(src, `${label}-src`);
    const into = scratch(dest, `${label}-dst`);
    await src.exec(`mkdir -p ${from}/tree && printf one > ${from}/tree/1.txt && printf two > ${from}/tree/2.txt`);
    await dest.exec(`mkdir -p ${into}`);
    const sftp = await src.getSftp();
    const entry = (await sftp.list(from)).find((e) => e.name === 'tree');
    const r = await crosstransfer.transfer({ srcConn: src, destConn: dest, entries: [entry], destDir: into });
    await finished(dest.queue, r.jobId);
    const got = await dest.exec(`cat ${into}/tree/1.txt ${into}/tree/2.txt`);
    await src.exec(`rm -rf ${from} ${into}`);
    return { mode: r.mode, got };
  }

  test('two nodes on one cluster copy server-to-server, never via a stray local folder', async () => {
    /*
     * Remote-to-remote `tsh scp` is not documented — tsh's own help says one
     * side must be local. tsh 18 does it; tsh 17 exits 0 having written the
     * files into a local folder named after the destination. So the route is
     * direct only from tsh 18, and the copy must arrive either way.
     */
    const major = Number(String(await teleport.version()).split('.')[0]);
    const want = major >= crosstransfer.DIRECT_MIN_TSH_MAJOR ? 'direct' : 'relay';
    assert.equal((await crosstransfer.planRoute(a, b)).mode, want);
    const { mode, got } = await copy(a, b, 'direct');
    assert.equal(mode, want);
    assert.equal(got, 'onetwo');
    const strays = (await fs.readdir(process.cwd())).filter((n) => n.includes('@'));
    assert.deepEqual(strays, [], 'nothing was written to the local working directory');
  });

  test('a plain SSH host and a Teleport node go by relay', async () => {
    assert.equal((await crosstransfer.planRoute(plain, a)).mode, 'relay');
    const { mode, got } = await copy(plain, a, 'relay');
    assert.equal(mode, 'relay');
    assert.equal(got, 'onetwo');
  });
});
