import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubemetrics.js'));

/**
 * Pure number-parsing — `kubectl top`'s own column strings into real
 * numbers, exactly what the history poller needs before it can push a
 * sample a chart can plot. No child_process here; the poll loop itself
 * needs a real cluster (see the Section 4 verification notes).
 */

test('parseCpu reads millicores directly', () => {
  assert.equal(K.parseCpu('123m'), 123);
  assert.equal(K.parseCpu('5m'), 5);
});

test('parseCpu reads a bare core count as millicores', () => {
  assert.equal(K.parseCpu('2'), 2000);
  assert.equal(K.parseCpu('0.5'), 500);
});

test('parseCpu never throws or returns NaN on garbage — a metrics-server gap should not break a chart', () => {
  assert.equal(K.parseCpu('<unknown>'), 0);
  assert.equal(K.parseCpu(undefined), 0);
  assert.equal(K.parseCpu(''), 0);
});

test('parseMemBytes reads binary suffixes (Ki/Mi/Gi/Ti)', () => {
  assert.equal(K.parseMemBytes('1Ki'), 1024);
  assert.equal(K.parseMemBytes('456Mi'), Math.round(456 * 1024 ** 2));
  assert.equal(K.parseMemBytes('1Gi'), 1024 ** 3);
  assert.equal(K.parseMemBytes('2Ti'), 2 * 1024 ** 4);
});

test('parseMemBytes reads decimal suffixes (K/M/G/T) too', () => {
  assert.equal(K.parseMemBytes('1K'), 1000);
  assert.equal(K.parseMemBytes('1M'), 1e6);
});

test('parseMemBytes reads a bare number as already-bytes', () => {
  assert.equal(K.parseMemBytes('2048'), 2048);
});

test('parseMemBytes never throws or returns NaN on garbage', () => {
  assert.equal(K.parseMemBytes('<unknown>'), 0);
  assert.equal(K.parseMemBytes(undefined), 0);
});

test('parsePercent reads the % sign off', () => {
  assert.equal(K.parsePercent('45%'), 45);
  assert.equal(K.parsePercent('100%'), 100);
});

test('parsePercent tolerates a missing % sign and garbage alike', () => {
  assert.equal(K.parsePercent('45'), 45);
  assert.equal(K.parsePercent('<unknown>'), 0);
  assert.equal(K.parsePercent(undefined), 0);
});

/** snapshotFrom() — one kuberesources.top() result, numbers instead of kubectl's own strings. */
test('snapshotFrom turns a real top() shape into parsed node/pod samples', () => {
  const topResult = {
    nodes: { ok: true, items: [{ name: 'node-1', cpu: '250m', cpuPercent: '12%', memory: '1Gi', memoryPercent: '40%' }] },
    pods: { ok: true, items: [{ namespace: 'ns', name: 'web-1', cpu: '5m', memory: '64Mi' }] },
  };
  const snap = K.snapshotFrom(topResult);
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.nodes, [{ name: 'node-1', cpuM: 250, cpuPercent: 12, memBytes: 1024 ** 3, memPercent: 40 }]);
  assert.deepEqual(snap.pods, [{ namespace: 'ns', name: 'web-1', cpuM: 5, memBytes: 64 * 1024 ** 2 }]);
});

test('snapshotFrom is not ok when both nodes and pods failed, same as top() itself', () => {
  const snap = K.snapshotFrom({ nodes: { ok: false, items: [] }, pods: { ok: false, items: [] } });
  assert.equal(snap.ok, false);
  assert.deepEqual(snap.nodes, []);
  assert.deepEqual(snap.pods, []);
});

test('snapshotFrom is still ok when only one of nodes/pods answered', () => {
  const snap = K.snapshotFrom({ nodes: { ok: true, items: [] }, pods: { ok: false, items: [] } });
  assert.equal(snap.ok, true);
});

test('start refuses with no id, before polling anything', () => {
  assert.throws(() => K.start({}, () => {}), /id/);
});

test('stop on an id that was never started is a no-op, not an error', () => {
  assert.equal(K.stop('not-a-real-poll'), false);
});

test('stopAll with nothing running does not throw', () => {
  assert.doesNotThrow(() => K.stopAll());
});
