import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { MultiExecRun, planStages } = require_(path.join(__PROJECT_ROOT__, 'src/main/multiexec.js'));

test('stages: the first few, then batches until every host has had a turn', () => {
  assert.deepEqual(planStages(12, { first: 1, batch: 5 }), [1, 5, 5, 1]);
  assert.deepEqual(planStages(3, { first: 1, batch: 5 }), [1, 2]);
  assert.deepEqual(planStages(1, { first: 3, batch: 5 }), [1]);
  assert.deepEqual(planStages(0), []);
  assert.deepEqual(planStages(7, { first: 0, batch: 0 }), [1, 5, 1]);
});

/** A run whose hosts "run" instantly, failing the ones named in `fail`. */
function fakeRun(n, stages, fail = []) {
  const targets = Array.from({ length: n }, (_, i) => ({ connId: `c${i}`, label: `h${i}` }));
  const run = new MultiExecRun('r1', targets, 'true', { stages });
  run._runOne = async (t) => {
    const r = run.results.get(t.connId);
    if (run.cancelled) return;
    r.status = fail.includes(t.connId) ? 'error' : 'done';
  };
  return run;
}
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 2)); };

test('a staged run waits after each stage, and goes on when told', async () => {
  const run = fakeRun(7, { first: 1, batch: 3, pause: true, stopOnFail: true });
  const done = run.start();
  await until(() => run.paused);
  assert.equal(run.view().staged.paused.reason, 'review');
  assert.deepEqual(run.view().results.map((r) => r.status), ['done', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  run.decide('next');
  await until(() => run.paused && run.stageIndex === 1);
  assert.equal(run.view().results.filter((r) => r.status === 'done').length, 4);
  run.decide('all');
  await done;
  assert.ok(run.view().results.every((r) => r.status === 'done'));
  assert.deepEqual(run.view().results.map((r) => r.stage), [1, 2, 2, 2, 3, 3, 3]);
});

test('a stage with a failure stops the run there, and Stop leaves the rest untouched', async () => {
  const run = fakeRun(6, { first: 1, batch: 5, pause: false, stopOnFail: true }, ['c0']);
  const done = run.start();
  await until(() => run.paused);
  assert.equal(run.paused.reason, 'failed');
  run.decide('stop');
  await done;
  assert.equal(run.view().running, false);
  assert.deepEqual(run.view().results.map((r) => r.status), ['error', 'cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
});

test('without pauses or failures a staged run goes straight through', async () => {
  const run = fakeRun(11, { first: 2, batch: 4, pause: false, stopOnFail: true });
  await run.start();
  assert.deepEqual(run.stageSizes, [2, 4, 4, 1]);
  assert.ok(run.view().results.every((r) => r.status === 'done'));
});
