import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const kube = require_(path.join(__PROJECT_ROOT__, 'src/main/kube.js'));

/**
 * Argv shape for the debugging specs (attach/debug/node-debug/logs) — no
 * live cluster needed, same spirit as kubeops.test.mjs's own tests. The
 * leading `baseArgs` (KUBECONFIG/--context plumbing, or a `tsh kubectl`
 * prefix) depends on what's actually installed wherever this runs, so
 * assertions only look at the tail starting at the kubectl subcommand.
 */

/** Everything from `token` onward — the part these specs are actually responsible for. */
function tailFrom(args, token) {
  const i = args.indexOf(token);
  assert.ok(i >= 0, `"${token}" not found in ${JSON.stringify(args)}`);
  return args.slice(i);
}

test('attachSpec attaches to the named container\'s own stdio', () => {
  const spec = kube.attachSpec({ podName: 'web-1', containerName: 'app' });
  assert.deepEqual(tailFrom(spec.args, 'attach'), ['attach', 'web-1', '-c', 'app', '-i']);
});

test('attachSpec omits -c with no container given', () => {
  const spec = kube.attachSpec({ podName: 'web-1' });
  assert.deepEqual(tailFrom(spec.args, 'attach'), ['attach', 'web-1', '-i']);
});

test('attachSpec never requests -t: kubectl refuses it outright on a container with no TTY of its own', () => {
  const spec = kube.attachSpec({ podName: 'web-1' });
  assert.ok(!spec.args.includes('-it'));
  assert.ok(!spec.args.includes('-t'));
});

test('debugSpec requires a pod and an image', () => {
  assert.throws(() => kube.debugSpec({ image: 'busybox' }));
  assert.throws(() => kube.debugSpec({ podName: 'web-1' }));
});

test('debugSpec targets the given container with an ephemeral debug container', () => {
  const spec = kube.debugSpec({ podName: 'web-1', containerName: 'app', image: 'nicolaka/netshoot:latest' });
  assert.deepEqual(tailFrom(spec.args, 'debug'),
    ['debug', '-it', 'web-1', '--image=nicolaka/netshoot:latest', '--target=app', '--', '/bin/sh']);
});

test('debugSpec respects a custom shell', () => {
  const spec = kube.debugSpec({ podName: 'web-1', image: 'busybox', shell: '/bin/bash' });
  assert.deepEqual(tailFrom(spec.args, 'debug'), ['debug', '-it', 'web-1', '--image=busybox', '--', '/bin/bash']);
});

test('nodeDebugSpec requires a node and an image', () => {
  assert.throws(() => kube.nodeDebugSpec({ image: 'busybox' }));
  assert.throws(() => kube.nodeDebugSpec({ nodeName: 'node-1' }));
});

test('nodeDebugSpec debugs node/NAME, not a pod', () => {
  const spec = kube.nodeDebugSpec({ nodeName: 'ip-10-0-0-1', image: 'nicolaka/netshoot:latest' });
  assert.deepEqual(tailFrom(spec.args, 'debug'),
    ['debug', 'node/ip-10-0-0-1', '-it', '--image=nicolaka/netshoot:latest', '--', '/bin/sh']);
});

test('logArgs needs exactly one of podName/selector', () => {
  assert.throws(() => kube.logArgs({}));
  assert.throws(() => kube.logArgs({ podName: 'web-1', selector: 'app=web' }));
});

test('logArgs for one pod, unchanged from a plain kubectl logs', () => {
  const { args } = kube.logArgs({ podName: 'web-1', containerName: 'app' }, { follow: true, tail: 50 });
  assert.deepEqual(tailFrom(args, 'logs'), ['logs', 'web-1', '-c', 'app', '-f', '--tail=50', '--timestamps']);
});

test('logArgs with allContainers adds --all-containers and --prefix for one pod', () => {
  const { args } = kube.logArgs({ podName: 'web-1' }, { allContainers: true, tail: null });
  assert.deepEqual(tailFrom(args, 'logs'), ['logs', 'web-1', '--all-containers=true', '--prefix', '-f', '--timestamps']);
});

test('logArgs with a selector tails every matching pod, prefixed, no pod name', () => {
  const { args } = kube.logArgs({ selector: 'app=web' }, { tail: 100 });
  assert.deepEqual(tailFrom(args, 'logs'),
    ['logs', '-l', 'app=web', '--all-containers=true', '--prefix', '-f', '--tail=100', '--timestamps']);
});

test('logSpec returns the same argv, shaped for a PTY (command/args/env, no "bin")', () => {
  const spec = kube.logSpec({ podName: 'web-1' }, { tail: 10 });
  assert.ok(spec.command);
  assert.equal(spec.bin, undefined);
  assert.deepEqual(tailFrom(spec.args, 'logs'), ['logs', 'web-1', '-f', '--tail=10', '--timestamps']);
});
