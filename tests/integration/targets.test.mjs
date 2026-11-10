/**
 * Everything ServerLife does to a host, against a plain OpenSSH server and a
 * Teleport node — the same machine and the same account, reached two ways.
 *
 * These are the paths where a wrong answer is silent: an upload whose mtime
 * the server quietly refused (so the next sync re-sends everything), a folder
 * removal that took more than it was asked to, a tmux session that did not
 * survive a detach. Unit tests cannot see any of it, because each depends on
 * what a real server actually does.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, targets, connect, finished, scratch, waitFor, NODE, LOGIN } from './helpers.mjs';

const { ConnectionManager } = main('connections.js');
const syncdirs = main('syncdirs.js');
const tmux = main('tmuxctl.js');
const { F } = main('sftp.js');

const all = await targets();

for (const target of all) {
  describe(`${target.name}`, () => {
    const manager = new ConnectionManager();
    let conn;
    let sftp;
    let local;

    before(async () => {
      conn = await connect(manager, target);
      sftp = await conn.getSftp();
      local = await fs.mkdtemp(path.join(os.tmpdir(), `sl-it-${target.name}-`));
    });

    after(async () => {
      await manager.shutdown();
      await fs.rm(local, { recursive: true, force: true });
    });

    test('connects once and knows who and where it is', async () => {
      assert.equal(conn.state, 'connected');
      assert.equal(await conn.checkMaster(), true, 'the ControlMaster answers -O check');
      assert.equal(conn.remoteUser, LOGIN);
      assert.equal(conn.homeDir, `/home/${LOGIN}`);
      assert.equal(conn.remoteHostname, NODE);
    });

    test('runs a command and reports a failing one as a failure', async () => {
      assert.equal((await conn.exec('printf "%s" "$((6*7))"')).trim(), '42');
      const r = await conn.execResult('echo to-stderr >&2; exit 3');
      assert.ok(r.error, 'a non-zero exit is an error');
      assert.match(r.stderr, /to-stderr/);
    });

    test('an interactive terminal echoes what is typed into it', async () => {
      const id = `term-${target.name}`;
      let seen = '';
      const onData = (p) => { if (p.id === id) seen += p.data; };
      conn.on('terminal-data', onData);
      try {
        await conn.openTerminal({ id });
        conn.writeTerminal(id, 'echo "TERM-$((40+2))"\r');
        // 45s: on a shared CI runner the first echo has taken longer than 20.
        await waitFor('the terminal to print TERM-42', () => seen.includes('TERM-42') || (() => {
          throw new Error(`the terminal had printed ${JSON.stringify(seen.slice(-120))}`);
        })(), { timeout: 45000, every: 200 });
      } finally {
        conn.closeTerminal(id);
        conn.off('terminal-data', onData);
      }
    });

    test('files go up and come back byte for byte, with their times', async () => {
      const dir = scratch(conn, 'files');
      await sftp.mkdir(dir);
      const body = Buffer.alloc(700 * 1024);
      for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff;
      const src = path.join(local, 'payload.bin');
      await fs.writeFile(src, body);
      const when = new Date('2024-03-04T05:06:07Z');
      await fs.utimes(src, when, when);

      const up = conn.queue.add({
        kind: 'upload', label: 'it upload',
        items: [{ local: src, remote: `${dir}/payload.bin`, size: body.length }],
        dirs: [dir], roots: [src],
      });
      await finished(conn.queue, up);

      const st = await sftp.stat(`${dir}/payload.bin`);
      assert.equal(st.size, body.length);
      assert.equal(st.mtime, Math.floor(when.getTime() / 1000), 'the server kept the modification time');

      const back = path.join(local, 'back.bin');
      const down = conn.queue.add({
        kind: 'download', label: 'it download',
        items: [{ remote: `${dir}/payload.bin`, local: back, size: body.length }],
        dirs: [], roots: [`${dir}/payload.bin`],
      });
      await finished(conn.queue, down);
      assert.ok(body.equals(await fs.readFile(back)), 'downloaded bytes match');

      await sftp.rename(`${dir}/payload.bin`, `${dir}/renamed.bin`);
      await sftp.chmod(`${dir}/renamed.bin`, 0o640);
      const renamed = (await sftp.list(dir)).find((e) => e.name === 'renamed.bin');
      assert.ok(renamed, 'rename is visible in the listing');
      assert.equal(renamed.mode & 0o777, 0o640);

      await sftp.removeTree(dir);
      await assert.rejects(sftp.stat(dir), 'the folder is gone');
    });

    test('synchronise uploads what is missing, then has nothing left to do', async () => {
      const remoteDir = scratch(conn, 'sync');
      const localDir = path.join(local, 'sync');
      await fs.mkdir(path.join(localDir, 'sub'), { recursive: true });
      await fs.writeFile(path.join(localDir, 'a.txt'), 'alpha\n');
      await fs.writeFile(path.join(localDir, 'sub', 'b.bin'), Buffer.alloc(300 * 1024, 7));
      await sftp.mkdir(remoteDir);

      const first = await syncdirs.plan(sftp, { localDir, remoteDir, direction: 'up' });
      assert.deepEqual(
        first.actions.filter((a) => a.op === 'upload').map((a) => a.rel).sort(),
        ['a.txt', 'sub/b.bin']);

      const { uploads, upDirs } = syncdirs.items(first, first.actions);
      await finished(conn.queue, conn.queue.add({
        kind: 'upload', label: 'it sync', items: uploads, dirs: upDirs, roots: [localDir],
      }));

      // The whole point of keeping mtimes: a second pass must find nothing.
      const second = await syncdirs.plan(sftp, { localDir, remoteDir, direction: 'up' });
      const pending = second.actions.filter((a) => a.op !== 'same');
      assert.deepEqual(pending, [], 'a second sync has nothing to do');

      // A local deletion, with removal asked for, becomes a remote delete of
      // exactly that file and nothing else.
      await fs.rm(path.join(localDir, 'a.txt'));
      const third = await syncdirs.plan(sftp, { localDir, remoteDir, direction: 'up', del: true });
      assert.deepEqual(
        third.actions.filter((a) => a.op.startsWith('delete')).map((a) => [a.op, a.rel]),
        [['deleteRemote', 'a.txt']]);

      await sftp.removeTree(remoteDir);
    });

    test('removing a folder that still has something in it', async (t) => {
      /*
       * ServerLife's synchronise never relies on the server to refuse here: it
       * lists the folder first and keeps it if anything is left, because a
       * Teleport node's SFTP service has removed non-empty folders whole. This
       * records what each server actually does, and fails if OpenSSH ever
       * stops refusing — the behaviour the rest of the file browser assumes.
       */
      const dir = scratch(conn, 'rmdir');
      await sftp.mkdir(dir);
      const h = await sftp.open(`${dir}/keep.txt`, F.WRITE | F.CREAT | F.TRUNC, null);
      await sftp.writeChunk(h, 0, Buffer.from('keep me\n'));
      await sftp.close(h);

      assert.equal((await sftp.list(dir)).length, 1, 'the listing the guard depends on sees the file');

      let refused = false;
      try { await sftp.rmdir(dir); } catch { refused = true; }
      const survived = await sftp.stat(`${dir}/keep.txt`).then(() => true, () => false);
      t.diagnostic(`${target.name}: RMDIR on a non-empty folder ${refused ? 'was refused' : 'succeeded'}; `
        + `its file ${survived ? 'survived' : 'was deleted'}`);

      if (target.name === 'openssh') {
        assert.ok(refused, 'OpenSSH refuses to remove a non-empty folder');
        assert.ok(survived);
      }
      if (survived) await sftp.removeTree(dir);
    });

    test('a tmux session survives being detached and is there to reattach', async () => {
      const probe = await tmux.probeTmux(conn);
      assert.ok(probe.ok, `tmux usable: ${probe.reason || probe.version}`);

      const name = `it-${target.name}-${Date.now().toString(36)}`;
      const first = new tmux.TmuxSession({ conn, sessionName: name, flowControl: probe.flowControl });
      await first.start();
      const pane = first.windowList()[0]?.panes[0];
      assert.ok(pane, 'the new session has a pane');

      first.writePane(pane, 'echo "TMUX-$((40+2))"\r');
      await waitFor('the marker in the pane', async () => (await first.capture(pane)).includes('TMUX-42'),
        { timeout: 20000, every: 300 });
      await first.detach();

      const listed = await waitFor('the detached session to be listed',
        async () => (await tmux.listSessions(conn)).find((s) => s.name === name && !s.attached),
        { timeout: 15000, every: 500 });
      assert.equal(listed.windows, 1);

      const again = new tmux.TmuxSession({ conn, sessionName: name, flowControl: probe.flowControl });
      await again.start();
      const pane2 = again.windowList()[0]?.panes[0];
      assert.match(await again.capture(pane2), /TMUX-42/, 'the scrollback is still there after reattaching');
      await again.kill();

      await waitFor('the session to be gone',
        async () => !(await tmux.listSessions(conn)).some((s) => s.name === name),
        { timeout: 15000, every: 500 });
    });
  });
}
