import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings } from './helpers.mjs';

const store = fakeSettings({ watchedHosts: {} });
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

const { savedOnlyProfiles } = await import('../src/renderer/js/pinned.js');
const { groupKeyFor } = await import('../src/renderer/js/folders.js');

/**
 * Saved clusters pinned to the Hosts tab.
 *
 * The point is a group that survives a logout, so what matters is that it
 * appears exactly when tsh status has nothing for the cluster, never as a
 * second heading beside a live or expired profile, and under the group key
 * the real profile used — or its watches and folders would land elsewhere.
 */

const saved = (over = {}) => ({
  id: 'tl_1', name: 'corp', proxy: 'corp.example.com', cluster: '', user: '', home: '', showInHosts: true, ...over,
});

test('a pinned saved cluster with no profile is drawn as a logged-out one', () => {
  state.teleportProfiles = [];
  state.savedLogins = [saved()];
  const [p] = savedOnlyProfiles();
  assert.equal(p.savedOnly, true);
  assert.equal(p.expired, true);
  assert.equal(p.saved.id, 'tl_1');
  // The port is added so the group key is the one the profile had.
  assert.equal(groupKeyFor(p), 'tp:corp.example.com:443');
});

test('it steps aside while tsh status lists the cluster, expired or not', () => {
  state.savedLogins = [saved()];
  for (const expired of [false, true]) {
    state.teleportProfiles = [{ proxy: 'corp.example.com:443', cluster: 'corp', home: null, expired }];
    assert.deepEqual(savedOnlyProfiles(), []);
  }
});

test('only the pinned ones, once per cluster, and per tsh home', () => {
  state.teleportProfiles = [];
  state.savedLogins = [
    saved(),
    saved({ id: 'tl_2', user: 'alice' }),                 // the same cluster, another account
    saved({ id: 'tl_3', proxy: 'other.example.com:3080', showInHosts: false }),
    saved({ id: 'tl_4', home: '/Users/me/.tsh-lab' }),
  ];
  const ps = savedOnlyProfiles();
  assert.deepEqual(ps.map((p) => p.saved.id), ['tl_1', 'tl_4']);
  assert.equal(groupKeyFor(ps[1]), 'tp:corp.example.com:443@/Users/me/.tsh-lab');
});

test('an unnamed saved cluster takes its name from what was being watched there', () => {
  state.teleportProfiles = [];
  state.savedLogins = [saved()];
  store.watchedHosts = {
    'uuid:1': { key: 'uuid:1', group: 'tp:corp.example.com:443', cluster: 'corp.example.com', name: 'web-1' },
  };
  assert.equal(savedOnlyProfiles()[0].cluster, 'corp.example.com');
  store.watchedHosts = {};
});
