import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { MultiExec, MultiExecRun } = require_(path.join(__PROJECT_ROOT__, 'src/main/multiexec.js'));

/**
 * `MultiExec.run()` used to build its `targets` with no `.transport` at
 * all, so `_spawnOne`'s `target.transport === 'tsh'` always compared
 * `undefined === 'tsh'` — false — and multi-exec against any tsh-transport
 * host (per-session MFA, a leaf cluster, no OpenSSH client) silently fell
 * through to a bare, config-less `ssh`, which cannot reach a Teleport node
 * at all. This is the regression test for that copy, independent of MFA.
 */
test('MultiExec.run() copies the real connection’s transport onto its targets', async () => {
  const conn = { id: 'c1', state: 'connected', transport: 'tsh', label: 'c1', target: 't', connect: async () => {} };
  const manager = { get: () => conn };
  const mx = new MultiExec(manager);
  // _spawnOne replaced so this test is about targets[], not a real exec.
  const seen = [];
  const realSpawnOne = MultiExecRun.prototype._spawnOne;
  // Only the targets[] shape matters here, not a real exec — replaced
  // entirely rather than called through, so this does not also need the
  // fake connection to support execInteractive/on/off.
  MultiExecRun.prototype._spawnOne = function (t) {
    seen.push(t);
    const r = this.results.get(t.connId);
    r.status = 'done';
    return Promise.resolve();
  };
  try {
    const view = await mx.run(['c1'], 'true', {});
    assert.equal(seen.length, 1);
    assert.equal(seen[0].transport, 'tsh');
    assert.equal(view.results[0].connId, 'c1');
  } finally {
    MultiExecRun.prototype._spawnOne = realSpawnOne;
  }
});

/** A fake Connection: an EventEmitter with the three methods execInteractive needs. */
function fakeConn(behavior) {
  const conn = new EventEmitter();
  // Already connected, so _runOne dispatches straight to _spawnOne rather
  // than trying (and failing) to connect a fake with no real connect().
  conn.state = 'connected';
  conn.writeExecCalls = [];
  conn.killed = false;
  conn.writeExec = (execId, data) => conn.writeExecCalls.push({ execId, data });
  conn.killExec = () => { conn.killed = true; };
  conn.execInteractive = (command, opts) => behavior(conn, command, opts);
  return conn;
}

test('_spawnOne dispatches a tsh-transport target through execInteractive, not spawn', async () => {
  const conn = fakeConn(async (c, command, opts) => {
    assert.equal(command, 'true');
    assert.equal(opts.execId, 'mx' + 'c1');
    return { execId: opts.execId, stdout: 'ok\n', exitCode: 0, error: null };
  });
  const run = new MultiExecRun('r1', [{ connId: 'c1', label: 'c1', transport: 'tsh', conn }], 'true', {});
  await run.start();
  const r = run.results.get('c1');
  assert.equal(r.status, 'done');
  assert.equal(r.stdout, '');   // exec-data never fired in this fake, so nothing accumulated
  assert.equal(r.exitCode, 0);
  assert.equal(r._execId, null);
});

test('a prompt mid-exec sets the host to prompting without blocking it', async () => {
  let resolveExec;
  const conn = fakeConn((c, command, opts) => new Promise((resolve) => {
    resolveExec = () => resolve({ execId: opts.execId, stdout: 'done\n', exitCode: 0, error: null });
    c.emit('exec-prompt', { execId: opts.execId, text: 'Enter an OTP code:' });
  }));
  const run = new MultiExecRun('r1', [{ connId: 'c1', label: 'c1', transport: 'tsh', conn }], 'sudo true', {});
  const done = run.start();
  for (let i = 0; i < 100 && run.results.get('c1').status !== 'prompting'; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(run.results.get('c1').status, 'prompting');
  assert.equal(run.results.get('c1').promptText, 'Enter an OTP code:');
  // Answering it through the same path the dock's inline input uses.
  run.answer('c1', '123456\n');
  assert.deepEqual(conn.writeExecCalls, [{ execId: 'mxc1', data: '123456\n' }]);
  resolveExec();
  await done;
  assert.equal(run.results.get('c1').status, 'done');
});

test('cancelling a run kills a still-waiting interactive exec', async () => {
  const conn = fakeConn(() => new Promise(() => {}));   // never resolves on its own
  const run = new MultiExecRun('r1', [{ connId: 'c1', label: 'c1', transport: 'tsh', conn }], 'sleep 999', {});
  run.start();
  for (let i = 0; i < 100 && !run.results.get('c1')._execId; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(run.results.get('c1')._execId, 'mxc1');
  run.cancel();
  assert.equal(conn.killed, true);
  assert.equal(run.results.get('c1').status, 'cancelled');
});
