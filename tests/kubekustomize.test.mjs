import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * `build()` is a thin IO wrapper around `kubectl kustomize <dir>` — real
 * output needs a real kustomization on disk (see the Section 6
 * verification notes), so only the input-validation boundary is tested
 * here without mocking `execFile`.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubekustomize.js'));

test('build refuses up front when there is no directory given', async () => {
  const r = await K.build({}, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /directory/i);
});
