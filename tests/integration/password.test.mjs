/**
 * A server that takes a password: an OpenSSH account with no key, reached
 * the way Quick connect reaches a typed-in address.
 *
 * ServerLife never stores a password. ssh asks for it on the connection's
 * own terminal, it is typed there once, and every terminal, file listing and
 * command after that rides the one ControlMaster. So what is tested is that
 * the prompt is seen, that answering it connects, that a wrong one fails
 * cleanly — and that the password is nowhere afterwards: not in the
 * connection's log, not in what it describes itself as, not in a file, and
 * not remembered, so the next connection asks again.
 */
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from './helpers.mjs';

const { ConnectionManager } = main('connections.js');

const PASSWORD = process.env.IT_SSH_PASSWORD || 'it-only-Pa55word';
const USER = 'pwtester';

/** The host as Quick connect builds it for "pwtester@node" (see quickHost). */
const host = {
  id: `direct:${USER}@node:22`, type: 'ssh', alias: null, name: `${USER}@node`,
  direct: { hostname: 'node', user: USER, port: 22, identityFile: null, proxyJump: null, extraOptions: '' },
};

const output = (conn) => conn.log.filter((l) => l.stream === 'out').map((l) => l.text).join('');

/**
 * Connect, answering each password prompt with `answer` — as a person does in
 * the connection's terminal. Resolves with how many times it was asked.
 */
async function connectWith(conn, answer) {
  let asked = 0;
  const seen = [];
  conn.on('state', ({ state }) => seen.push(state));
  const timer = setInterval(() => {
    const n = (output(conn).match(/password:/gi) || []).length;
    if (n > asked) { asked = n; conn.writeMaster(answer + '\r'); }
  }, 150);
  try {
    await conn.connect();
    return { asked, seen };
  } finally {
    clearInterval(timer);
  }
}

/** Every file under `dir` (to a depth) whose contents include `needle`. */
async function filesContaining(dir, needle, depth = 4) {
  const hits = [];
  const walk = async (d, left) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) await walk(p, left - 1);
      else if (e.isFile()) {
        try {
          const st = await fs.stat(p);
          if (st.size > 5_000_000) continue;
          if ((await fs.readFile(p, 'utf8')).includes(needle)) hits.push(p);
        } catch { /* a socket, or gone */ }
      }
    }
  };
  await walk(dir, depth);
  return hits;
}

describe('password authentication', () => {
  const managers = [];
  after(async () => { for (const m of managers) await m.shutdown(); });
  const fresh = () => { const m = new ConnectionManager(); managers.push(m); return m; };

  test('the prompt is seen, answering it connects, and the session works', async () => {
    const conn = await fresh().create(host, {});
    const { asked, seen } = await connectWith(conn, PASSWORD);
    assert.equal(asked, 1, 'asked for the password once');
    assert.ok(seen.includes('prompting'), `went through "prompting" (saw ${seen.join(' → ')})`);
    assert.equal(conn.state, 'connected');

    // Everything after rides the one master: no second prompt.
    const who = await conn.exec('whoami');
    assert.equal(who.trim(), USER);
    const sftp = await conn.getSftp();
    assert.ok(Array.isArray(await sftp.list(conn.homeDir || `/home/${USER}`)));
    assert.equal((output(conn).match(/password:/gi) || []).length, 1, 'no second prompt for exec or files');
  });

  test('the password is not kept anywhere', async () => {
    const m = fresh();
    const conn = await m.create(host, {});
    await connectWith(conn, PASSWORD);

    assert.ok(!output(conn).includes(PASSWORD), 'not echoed into the connection log');
    assert.ok(!JSON.stringify(conn.log).includes(PASSWORD), 'not in the log entries');
    const described = JSON.stringify(m.list ? m.list() : conn.spec);
    assert.ok(!described.includes(PASSWORD), 'not in what the connection reports about itself');

    const places = [os.tmpdir(), path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.config')];
    for (const dir of places) {
      assert.deepEqual(await filesContaining(dir, PASSWORD), [], `no file under ${dir} holds it`);
    }

    // Not remembered: once that connection is gone, the next one asks again.
    await m.shutdown();
    const again = await fresh().create(host, {});
    const r = await connectWith(again, PASSWORD);
    assert.equal(r.asked, 1, 'a new connection asks for the password again');
  });

  test('a wrong password fails with a clear error, not a hang', async () => {
    const conn = await fresh().create(host, {});
    await assert.rejects(connectWith(conn, 'not-the-password'), /permission denied|authentication/i);
    assert.equal(conn.state, 'error');
  });
});
