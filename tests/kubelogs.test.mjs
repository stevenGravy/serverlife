import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const kubelogs = require_(path.join(__PROJECT_ROOT__, 'src/main/kubelogs.js'));

/**
 * Only the guards that run before anything is spawned — same boundary
 * every other kube*.test.mjs keeps: no child_process here, that needs a
 * real cluster (see the Log Viewer's own verification notes).
 */

test('start refuses with no id, before building an argv or spawning anything', () => {
  assert.throws(() => kubelogs.start({ podName: 'web-1' }, () => {}), /id/);
});

test('stop on an id that was never started is a no-op, not an error', () => {
  assert.equal(kubelogs.stop('not-a-real-session'), false);
});

test('stopAll with nothing running does not throw', () => {
  assert.doesNotThrow(() => kubelogs.stopAll());
});
