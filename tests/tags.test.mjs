import test from 'node:test';
import assert from 'node:assert/strict';

import {
  labelEntries, labelCount, collectTags, isInternalLabel,
  parseQuery, compileQuery, isBooleanQuery, regexError,
  termFor, hasTerm, toggleTerm,
} from '../src/renderer/js/tags.js';
import { node, sshHost } from './helpers.mjs';

/**
 * The query language, which is the piece with the most ways to be subtly
 * wrong: it decides what the filter box finds, what a fan-out targets, and
 * what a folder rule claims — three places where a quietly wrong answer
 * looks exactly like a correct one.
 */

const hosts = [
  node('web-01', { env: 'prod', role: 'web', 'aws/Name': 'prod-web-01' }),
  node('web-2', { env: 'prod', role: 'web' }),
  node('api-1', { env: 'prod', role: 'api' }),
  node('db-1', { env: 'dev', role: 'db', 'teleport.internal/resource-id': 'xyz' }),
  node('lone', {}),
  sshHost('plain'),
];

const names = (q) => hosts.filter(compileQuery(q).match).map((h) => h.name || h.alias);

/* ---------------- labels ---------------- */

test('labels are sorted, and the internal ones are kept out of the way', () => {
  const entries = labelEntries(hosts[3]);
  assert.deepEqual(entries, [['env', 'dev'], ['role', 'db']]);
  assert.equal(labelCount(hosts[3]), 2);
  const all = labelEntries(hosts[3], { includeInternal: true }).map(([k]) => k);
  assert.ok(all.includes('teleport.internal/resource-id'));
  assert.ok(isInternalLabel('teleport.internal/x'));
  assert.ok(!isInternalLabel('env'));
});

test('a label with no value survives as an empty string, not as undefined', () => {
  assert.deepEqual(labelEntries(node('x', { flag: null })), [['flag', '']]);
});

test('collectTags counts every value of every key', () => {
  const tags = collectTags(hosts);
  assert.equal(tags.get('env').get('prod'), 3);
  assert.equal(tags.get('role').get('web'), 2);
  assert.equal(tags.get('env').get('dev'), 1);
  // Sorted by key, so the dialog's list is stable between renders.
  assert.deepEqual([...tags.keys()], [...tags.keys()].sort());
});

/* ---------------- the plain terms ---------------- */

test('an empty query matches everything', () => {
  assert.equal(names('').length, hosts.length);
  assert.equal(compileQuery('   ').empty, true);
});

test('bare text matches name, labels and address', () => {
  assert.deepEqual(names('web'), ['web-01', 'web-2']);
  assert.deepEqual(names('rhel'), []);
  assert.deepEqual(names('db'), ['db-1']);
});

test('key=value is exact, key:value is contains', () => {
  assert.deepEqual(names('env=prod'), ['web-01', 'web-2', 'api-1']);
  assert.deepEqual(names('env=pro'), []);
  assert.deepEqual(names('env:pro'), ['web-01', 'web-2', 'api-1']);
});

test('a comma list is "either", because a label holds one value', () => {
  assert.deepEqual(names('env=prod,dev').length, 4);
});

test('a bare key asks only that the label exists', () => {
  assert.deepEqual(names('role:'), ['web-01', 'web-2', 'api-1', 'db-1']);
});

test('a glob on = ', () => {
  assert.deepEqual(names('name=web-*'), ['web-01', 'web-2']);
  assert.deepEqual(names('name=*-1'), ['api-1', 'db-1']);
});

test('tag: searches every key and value at once', () => {
  assert.deepEqual(names('tag:role'), ['web-01', 'web-2', 'api-1', 'db-1']);
  assert.deepEqual(names('tag:api'), ['api-1']);
});

test('non-label fields are addressable', () => {
  assert.equal(names('cluster=c1').length, 5);
  assert.deepEqual(names('type=ssh'), ['plain']);
  assert.deepEqual(names('alias=plain'), ['plain']);
  assert.equal(names('tunnel=true').length, 5);
});

test('a leading minus excludes', () => {
  assert.deepEqual(names('-env=prod'), ['db-1', 'lone', 'plain']);
});

/* ---------------- the bug that started it ---------------- */

test('a label does not hide a field of the same name', () => {
  // web-01 carries aws/Name, whose last segment is `name`. Before the fix
  // that label answered for `name=` and the host's own name never did.
  assert.deepEqual(names('name=web-01'), ['web-01']);
  assert.deepEqual(names('name=prod-web-01'), ['web-01']);   // the label still answers
  assert.deepEqual(names('name:web'), ['web-01', 'web-2']);
});

/* ---------------- regular expressions ---------------- */

test('~ is a regular expression, case-insensitive', () => {
  assert.deepEqual(names('name~^web-\\d+$'), ['web-01', 'web-2']);
  assert.deepEqual(names('name~^WEB'), ['web-01', 'web-2']);
  assert.deepEqual(names('name~^(web|api)'), ['web-01', 'web-2', 'api-1']);
});

test('the brackets in a pattern belong to the pattern', () => {
  assert.deepEqual(names('name~^(web|api)-\\d+$'), ['web-01', 'web-2', 'api-1']);
  // and a group around a regex term still closes
  assert.deepEqual(names('(name~^web) and env=prod'), ['web-01', 'web-2']);
});

test('a comma inside a pattern is not an alternative list', () => {
  assert.deepEqual(names('name~^web-\\d{1,2}$'), ['web-01', 'web-2']);
  assert.deepEqual(names('name~^web-\\d{2}$'), ['web-01']);
});

test('a pattern that will not compile is reported, not silently empty', () => {
  const c = compileQuery('name~[oops');
  assert.match(c.error, /will not compile/);
  assert.ok(regexError('[oops'));
  assert.equal(regexError('^ok$'), null);
});

test('a regex can be asked of labels too', () => {
  assert.deepEqual(names('env~^pro'), ['web-01', 'web-2', 'api-1']);
  assert.deepEqual(names('tag~^role$'), ['web-01', 'web-2', 'api-1', 'db-1']);
});

/* ---------------- boolean logic ---------------- */

test('space still means and', () => {
  assert.deepEqual(names('env=prod role:web'), ['web-01', 'web-2']);
  assert.deepEqual(names('env=prod and role:web'), ['web-01', 'web-2']);
});

test('or, not, and brackets', () => {
  assert.deepEqual(names('role=web or role=db'), ['web-01', 'web-2', 'db-1']);
  assert.deepEqual(names('not env=prod'), ['db-1', 'lone', 'plain']);
  assert.deepEqual(names('env=prod and (role:web or role:api)'), ['web-01', 'web-2', 'api-1']);
  assert.deepEqual(names('env=prod and not name=web-01'), ['web-2', 'api-1']);
});

test('and binds tighter than or', () => {
  // role=db or (env=prod and role=api)
  assert.deepEqual(names('role=db or env=prod and role=api'), ['api-1', 'db-1']);
});

test('the operators are case-insensitive, and quoting takes one out of the grammar', () => {
  assert.deepEqual(names('ENV=PROD AND ROLE:WEB'), ['web-01', 'web-2']);
  assert.deepEqual(names('"or"'), []);          // a word to search for, and nothing has it
  assert.equal(isBooleanQuery('a or b'), true);
  assert.equal(isBooleanQuery('env=prod'), false);
  assert.equal(isBooleanQuery('"or"'), false);
});

test('a half-written query still filters instead of blanking the list', () => {
  const c = compileQuery('env=prod and');
  assert.ok(c.error);
  assert.deepEqual(hosts.filter(c.match).map((h) => h.name), ['web-01', 'web-2', 'api-1']);
  const c2 = compileQuery('env=prod and (role:web');
  assert.ok(c2.error);
  assert.deepEqual(hosts.filter(c2.match).map((h) => h.name), ['web-01', 'web-2']);
});

test('a stray closing bracket is an error, not a crash', () => {
  const c = compileQuery('env=prod)');
  assert.ok(c.error);
});

/* ---------------- the chip helpers ---------------- */

test('parseQuery keeps returning a flat list of terms', () => {
  assert.deepEqual(parseQuery('env=prod -role:db'), [
    { neg: false, key: 'env', op: '=', value: 'prod' },
    { neg: true, key: 'role', op: ':', value: 'db' },
  ]);
});

test('termFor quotes a value with spaces', () => {
  assert.equal(termFor('env', 'prod'), 'env=prod');
  assert.equal(termFor('region', 'us east'), '"region=us east"');
  assert.equal(termFor('env', ''), 'env:');
});

test('toggleTerm adds, removes, and folds a second value into a comma list', () => {
  assert.equal(toggleTerm('', 'env=prod'), 'env=prod');
  assert.equal(toggleTerm('env=prod', 'env=staging'), 'env=prod,staging');
  assert.equal(toggleTerm('env=prod,staging', 'env=prod'), 'env=staging');
  assert.equal(toggleTerm('env=prod', 'env=prod'), '');
  assert.equal(toggleTerm('env=prod role:web', 'role:web'), 'env=prod');
});

test('hasTerm sees a value inside a comma list', () => {
  assert.ok(hasTerm('env=prod,staging', 'env=staging'));
  assert.ok(!hasTerm('env=prod,staging', 'env=dev'));
  assert.ok(hasTerm('env=prod', 'env:'));         // "any value of this key"
});

test('a quoted value survives a round trip', () => {
  const q = toggleTerm('', termFor('region', 'us east'));
  assert.ok(hasTerm(q, termFor('region', 'us east')));
  const h = node('e', { region: 'us east' });
  assert.ok(compileQuery(q).match(h));
});
