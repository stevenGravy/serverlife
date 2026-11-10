import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { MultiExecRun } = require_(path.join(__PROJECT_ROOT__, 'src/main/multiexec.js'));

/**
 * A run whose hosts "run" instantly: each fails its first `failFirst[id]`
 * tries and then succeeds.
 */
function fakeRun(failFirst, opts) {
  const ids = Object.keys(failFirst);
  const run = new MultiExecRun('r1', ids.map((id) => ({ connId: id, label: id })), 'true', opts);
  const tried = {};
  run._spawnOne = async (t) => {
    const r = run.results.get(t.connId);
    tried[t.connId] = (tried[t.connId] || 0) + 1;
    r.stderr = `try ${tried[t.connId]}`;
    r.status = tried[t.connId] > failFirst[t.connId] ? 'done' : 'error';
  };
  return { run, tried };
}

test('a failing host is tried again, and only its last try counts', async () => {
  const { run, tried } = fakeRun({ a: 0, b: 2, c: 5 }, { retries: 2, retryDelay: 0 });
  await run.start();
  const v = Object.fromEntries(run.view().results.map((r) => [r.connId, r]));
  assert.deepEqual(tried, { a: 1, b: 3, c: 3 });
  assert.equal(v.a.status, 'done');
  assert.equal(v.a.tries.length, 0);
  assert.equal(v.b.status, 'done');
  assert.equal(v.b.attempt, 3);
  assert.deepEqual(v.b.tries.map((t) => t.error), ['try 1', 'try 2']);
  assert.equal(v.c.status, 'error');
  assert.equal(v.c.attempts, 3);
  assert.equal(run.view().retries, 2);
});

test('without retries a failure is final', async () => {
  const { run, tried } = fakeRun({ a: 1 }, {});
  await run.start();
  assert.deepEqual(tried, { a: 1 });
  assert.equal(run.view().results[0].status, 'error');
});

test('cancelling during the wait before a retry ends it at once', async () => {
  const { run, tried } = fakeRun({ a: 9 }, { retries: 3, retryDelay: 60 });
  const done = run.start();
  for (let i = 0; i < 100 && run.results.get('a').status !== 'retrying'; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(run.results.get('a').status, 'retrying');
  assert.ok(run.results.get('a').retryAt > Date.now());
  run.cancel();
  await done;
  assert.equal(tried.a, 1);
  assert.equal(run.results.get('a').status, 'cancelled');
});

test('a staged run sees how a host ended after its retries', async () => {
  const { run } = fakeRun({ a: 1, b: 0, c: 0 }, { retries: 1, retryDelay: 0, stages: { first: 1, batch: 5, pause: false, stopOnFail: true } });
  await run.start();
  // The canary failed once and then passed, so the run went on.
  assert.deepEqual(run.view().results.map((r) => r.status), ['done', 'done', 'done']);
});
