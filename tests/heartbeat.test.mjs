import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings, withClock, node } from './helpers.mjs';

const store = fakeSettings({ staleNodeMinutes: 2, nodeRefreshSeconds: 10 });
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

const H = await import('../src/renderer/js/heartbeat.js');

/**
 * Heartbeat ages, which are arithmetic on two numbers the cluster never
 * states outright: when it will give up on a node, and how long it gives a
 * node in the first place. Both halves have already been wrong once — the
 * first against the wall clock instead of the read, the second assumed
 * rather than measured — and both were wrong in the direction that invents
 * an alarm, which is the expensive direction.
 */

const MIN = 60000;
const TTL = 15 * MIN;

/** A cluster's list as it would be read now: `age` is how long ago each spoke. */
function listFor(cluster, ages) {
  const now = Date.now();
  return ages.map(([name, ageMs]) => node(name, {}, {
    cluster,
    expires: now + TTL - ageMs,
  }));
}

test('the announce interval is read off the freshest node, rounded up', () => {
  const nodes = listFor('c-ttl', [['a', 5000], ['b', 90000], ['c', 200000]]);
  H.observe('c-ttl', nodes);
  // The freshest has 15m less 5s left; rounded up to the minute, that is 15m.
  assert.equal(H.heartbeatAge(nodes[0]) < MIN, true);
  assert.equal(Math.round(H.heartbeatAge(nodes[1]) / 1000), 90);
  assert.equal(Math.round(H.heartbeatAge(nodes[2]) / 1000), 200);
});

test('a node with no expiry has no age — it has no heartbeat to be late', () => {
  const n = node('agentless', {}, { cluster: 'c-ttl', expires: null });
  assert.equal(H.heartbeatAge(n), null);
  assert.equal(H.isStale(n), false);
  assert.equal(H.ageLabel(n), '');
});

test('a cluster nobody has read yet has no ages', () => {
  const n = node('x', {}, { cluster: 'never-read', expires: Date.now() + TTL });
  assert.equal(H.heartbeatAge(n), null);
});

test('an ssh host is not a Teleport node and is never judged', () => {
  assert.equal(H.heartbeatAge({ type: 'ssh', alias: 'a', expires: Date.now() }), null);
});

test('the age is taken as of the read, not of the clock', async () => {
  const nodes = listFor('c-clock', [['fresh', 5000], ['old', 9 * MIN]]);
  H.observe('c-clock', nodes);
  const atRead = H.heartbeatAge(nodes[1]);

  // Ten seconds later — a poll would have happened — nothing has moved.
  await withClock(10000, () => {
    assert.equal(H.heartbeatAge(nodes[1]), atRead);
  });
});

test('past the grace period the answer is "we have not looked", not "everyone is quiet"', async () => {
  const nodes = listFor('c-grace', [['fresh', 5000], ['old', 9 * MIN]]);
  H.observe('c-grace', nodes);
  assert.ok(H.isStale(nodes[1]));

  // The window was hidden for four minutes: the list is too old to judge.
  await withClock(4 * MIN, () => {
    assert.equal(H.heartbeatAge(nodes[0]), null);
    assert.equal(H.heartbeatAge(nodes[1]), null);
    assert.equal(H.isStale(nodes[1]), false, 'a stale list must not make every node look quiet');
  });
});

test('the grace period follows the refresh interval', async () => {
  state.settings = { ...store, nodeRefreshSeconds: 300 };
  const nodes = listFor('c-slow', [['fresh', 5000], ['old', 9 * MIN]]);
  H.observe('c-slow', nodes);
  // Three polls of a five-minute cycle is fifteen minutes of slack.
  await withClock(10 * MIN, () => {
    assert.notEqual(H.heartbeatAge(nodes[1]), null);
  });
  await withClock(20 * MIN, () => {
    assert.equal(H.heartbeatAge(nodes[1]), null);
  });
  state.settings = store;
});

test('stale is the user\'s own threshold, and 0 turns it off', () => {
  const nodes = listFor('c-thresh', [['fresh', 5000], ['three', 3 * MIN], ['nine', 9 * MIN]]);
  H.observe('c-thresh', nodes);

  state.settings = { ...store, staleNodeMinutes: 2 };
  assert.deepEqual(nodes.filter(H.isStale).map((n) => n.name), ['three', 'nine']);

  state.settings = { ...store, staleNodeMinutes: 5 };
  assert.deepEqual(nodes.filter(H.isStale).map((n) => n.name), ['nine']);

  state.settings = { ...store, staleNodeMinutes: 0 };
  assert.deepEqual(nodes.filter(H.isStale).map((n) => n.name), []);

  state.settings = store;
});

test('the labels read as minutes, and under a minute says so', () => {
  const nodes = listFor('c-label', [['fresh', 5000], ['seven', 7 * MIN], ['hours', 70 * MIN]]);
  H.observe('c-label', nodes);
  assert.equal(H.ageLabel(nodes[0]), '<1m');
  assert.equal(H.ageLabel(nodes[1]), '7m');
  assert.equal(H.ageLabel(nodes[2]), '1h 10m');
  assert.equal(H.staleLabel(nodes[0]), '');        // not stale: no badge
  assert.equal(H.staleLabel(nodes[1]), '7m');
});

test('the tooltip says how long is left before the cluster forgets it', () => {
  const nodes = listFor('c-tip', [['fresh', 5000], ['nine', 9 * MIN]]);
  H.observe('c-tip', nodes);
  assert.match(H.heartbeatLine(nodes[0]), /^last heartbeat: \d+s ago$/);
  const line = H.heartbeatLine(nodes[1]);
  assert.match(line, /9 minutes ago/);
  assert.match(line, /may be gone/);
  assert.match(line, /6 minutes left/);
});

test('the redraw signature only carries what is being drawn', () => {
  const nodes = listFor('c-sig', [['fresh', 5000], ['nine', 9 * MIN]]);
  H.observe('c-sig', nodes);

  state.settings = { ...store, showHeartbeats: false, staleNodeMinutes: 2 };
  const quietOnly = H.heartbeatSignature(nodes);
  assert.ok(quietOnly.includes('nine'));
  assert.ok(!quietOnly.includes('fresh'), 'a healthy node must not make the list twitch');

  state.settings = { ...store, showHeartbeats: true, staleNodeMinutes: 2 };
  const all = H.heartbeatSignature(nodes);
  assert.ok(all.includes('fresh') && all.includes('nine'));

  state.settings = { ...store, showHeartbeats: false, staleNodeMinutes: 0 };
  assert.equal(H.heartbeatSignature(nodes), '');
  state.settings = store;
});

test('the quiet filter and the heartbeat toggle read their settings', () => {
  state.settings = { ...store };
  assert.equal(H.quietFilter(), 'all');
  assert.equal(H.showHeartbeats(), false);
  state.settings = { ...store, quietNodeFilter: 'only', showHeartbeats: true };
  assert.equal(H.quietFilter(), 'only');
  assert.equal(H.showHeartbeats(), true);
  state.settings = { ...store, quietNodeFilter: 'nonsense' };
  assert.equal(H.quietFilter(), 'all', 'an unknown value falls back to showing everything');
  state.settings = store;
});
