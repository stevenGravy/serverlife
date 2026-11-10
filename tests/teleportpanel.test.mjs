import test from 'node:test';
import assert from 'node:assert/strict';

import { clusterMatchesFilter } from '../src/renderer/js/teleportpanel.js';
import { compileQuery } from '../src/renderer/js/tags.js';

/**
 * The shared `#host-filter` box, asked about a Teleport cluster instead of a
 * host — a live profile (`cluster`/`proxy`/`username`) or a saved login
 * (`name`/`cluster`/`proxy`/`user`), the two shapes the Teleport tab lists.
 *
 * Before this, switching to the Teleport tab and typing into that box did
 * nothing at all — `renderTeleportTab` and `renderSavedLogins` drew the full
 * list unconditionally. The fix is `clusterMatchesFilter`, so these tests
 * exercise it directly rather than the DOM it is drawn into, same as
 * `tags.test.mjs` does for the Hosts tab's own query language.
 */

const profile = { cluster: 'prod.example.com', proxy: 'proxy.prod.example.com:443', username: 'alice' };
const saved = { name: 'Prod', cluster: 'prod.example.com', proxy: 'proxy.prod.example.com:443', user: 'alice' };
const other = { cluster: 'staging.example.com', proxy: 'proxy.staging.example.com:443', username: 'bob' };

const matches = (c, q) => clusterMatchesFilter(c, compileQuery(q));

test('an empty query matches every cluster', () => {
  assert.ok(matches(profile, ''));
  assert.ok(matches(saved, ''));
});

test('a plain word matches the cluster name', () => {
  assert.ok(matches(profile, 'prod'));
  assert.ok(!matches(profile, 'staging'));
});

test('a plain word matches the proxy address too — this was the gap the box left open', () => {
  assert.ok(matches(profile, 'proxy.prod'));
  assert.ok(!matches(other, 'proxy.prod'));
});

test('a bare word hits every proxy with it anywhere in the name, not just a prefix', () => {
  const fire = { cluster: 'ops', proxy: 'firewall-proxy.example.com:443', username: 'alice' };
  const alsoFire = { cluster: 'ops2', proxy: 'proxy2.wildfire.example.com:443', username: 'alice' };
  const notFire = { cluster: 'ops3', proxy: 'proxy3.example.com:443', username: 'alice' };
  const list = [fire, alsoFire, notFire];
  const shown = list.filter((c) => matches(c, 'fire'));
  assert.deepEqual(shown, [fire, alsoFire]);
});

test('the keyed forms the Hosts tab already understands work here as well', () => {
  assert.ok(matches(profile, 'cluster=prod.example.com'));
  assert.ok(matches(profile, 'proxy=proxy.prod.example.com:443'));
  assert.ok(!matches(profile, 'cluster=staging.example.com'));
});

test('a saved cluster matches the same way a live profile does — same for saved', () => {
  assert.ok(matches(saved, 'prod'));
  assert.ok(matches(saved, 'proxy.prod'));
  assert.ok(matches(saved, 'cluster=prod.example.com'));
  assert.ok(matches(saved, 'user=alice'));
  assert.ok(!matches(saved, 'bob'));
});

test('boolean queries read across clusters, same as the Hosts tab', () => {
  const list = [profile, other];
  assert.equal(list.filter((c) => matches(c, 'prod or staging')).length, 2);
  assert.equal(list.filter((c) => matches(c, 'prod and bob')).length, 0);
  assert.equal(list.filter((c) => matches(c, 'prod and alice')).length, 1);
});
