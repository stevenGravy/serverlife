import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCrashLoops, detectStalledRollouts } from '../src/renderer/js/alerts.js';

const pod = (name, waitingReason) => ({ name, namespace: 'ns1', waitingReason });

test('detectCrashLoops finds a pod Kubernetes has labeled CrashLoopBackOff', () => {
  const pods = [pod('a', 'CrashLoopBackOff'), pod('b', undefined), pod('c', 'ImagePullBackOff')];
  const found = detectCrashLoops(pods);
  assert.deepEqual(found.map((p) => p.name), ['a']);
});

test('detectCrashLoops handles no pods at all', () => {
  assert.deepEqual(detectCrashLoops([]), []);
  assert.deepEqual(detectCrashLoops(undefined), []);
});

const workload = (name, desiredReplicas, readyReplicas) => ({
  kind: 'Deployment', name, namespace: 'ns1', desiredReplicas, readyReplicas,
});

test('detectStalledRollouts does not alert the first time a workload is seen unready — only once thresholdMs has passed', () => {
  const seenSince = new Map();
  const w = workload('app', 3, 1);
  const r1 = detectStalledRollouts([w], 1000, seenSince, 300000);
  assert.deepEqual(r1, []);
  assert.equal(seenSince.get('Deployment/ns1/app'), 1000);
  const r2 = detectStalledRollouts([w], 1000 + 299000, seenSince, 300000);
  assert.deepEqual(r2, []);
  const r3 = detectStalledRollouts([w], 1000 + 300000, seenSince, 300000);
  assert.deepEqual(r3, [w]);
});

test('detectStalledRollouts clears the clock once a workload becomes ready again', () => {
  const seenSince = new Map();
  detectStalledRollouts([workload('app', 3, 1)], 0, seenSince, 300000);
  assert.ok(seenSince.has('Deployment/ns1/app'));
  detectStalledRollouts([workload('app', 3, 3)], 1000, seenSince, 300000);
  assert.ok(!seenSince.has('Deployment/ns1/app'));
});

test('detectStalledRollouts forgets a workload that disappears entirely rather than counting it forever', () => {
  const seenSince = new Map();
  detectStalledRollouts([workload('app', 3, 1)], 0, seenSince, 300000);
  detectStalledRollouts([], 1000, seenSince, 300000);
  assert.ok(!seenSince.has('Deployment/ns1/app'));
});

test('detectStalledRollouts treats a missing readyReplicas as zero, and a missing desiredReplicas as 1', () => {
  const w = { kind: 'Deployment', name: 'bare', namespace: 'ns1' };
  const seenSince = new Map();
  detectStalledRollouts([w], 0, seenSince, 300000);
  const r = detectStalledRollouts([w], 300000, seenSince, 300000);
  assert.deepEqual(r, [w]);
});

test('detectStalledRollouts keys a StatefulSet separately from a Deployment of the same name/namespace', () => {
  const seenSince = new Map();
  const dep = workload('app', 3, 1);
  const sts = { ...workload('app', 3, 1), kind: 'StatefulSet' };
  detectStalledRollouts([dep, sts], 0, seenSince, 300000);
  assert.equal(seenSince.size, 2);
});
