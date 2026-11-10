import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch, rank } from '../src/renderer/js/search.js';

test('every word has to be found, and a name that starts with it ranks first', () => {
  assert.equal(scoreMatch('prod web', 'web-01', 'env=staging'), 0);
  assert.ok(scoreMatch('prod web', 'web-01', 'env=prod') > 0);
  assert.ok(scoreMatch('web', 'web-01') > scoreMatch('web', 'old-web-01'));
  assert.ok(scoreMatch('web', 'old-web-01') > scoreMatch('web', 'cobweb'));
  assert.ok(scoreMatch('web', 'cobweb') > scoreMatch('web', 'db-01', 'role=web'));
  assert.equal(scoreMatch('', 'anything'), 0);
  // Characters that mean something in a pattern are only characters.
  assert.ok(scoreMatch('a.b(', 'x a.b( y') > 0);
});

test('results come grouped by kind, the kind with the best match first, a few of each', () => {
  const items = [
    { kind: 'command', name: 'Multi-exec', extra: 'run command' },
    ...Array.from({ length: 9 }, (_, i) => ({ kind: 'host', name: `db-${i}`, extra: 'multi' })),
  ];
  const g = rank(items, 'multi');
  assert.equal(g[0].kind, 'command');
  assert.equal(g[1].kind, 'host');
  assert.equal(g[1].items.length, 6);
  assert.equal(g[1].more, 3);
});
