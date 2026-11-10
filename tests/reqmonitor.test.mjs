import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings } from './helpers.mjs';

const store = fakeSettings({ requestMonitor: [], requestMonitorMinutes: 5 });
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, append() {}, addEventListener() {} }),
};

const M = await import('../src/renderer/js/reqmonitor.js');

/**
 * Monitoring what you could ask for.
 *
 * The same trap as watching a host disappear, one level further out: the
 * evidence for "this is gone" is an absence, and absences are produced just
 * as readily by a failed search, a lapsed certificate or a role that cannot
 * search that kind at all. Every test here is about the difference between
 * "it is not there" and "I could not ask".
 */

const G = { proxy: 'lab.example.com:443', home: null, kind: 'node' };
const res = (id, name, labels = {}) => ({ id, name, kind: 'node', uuid: id.split('/').pop(), cluster: 'lab', labels });

const web1 = res('/lab/node/uuid-1', 'web-1', { env: 'prod' });
const web2 = res('/lab/node/uuid-2', 'web-2', { env: 'prod' });

function itemsOf(...list) {
  return list.map((r) => ({
    id: r.id, kind: 'node', name: r.name, uuid: r.uuid, cluster: r.cluster,
    proxy: G.proxy, home: G.home, labels: { ...r.labels },
    addedAt: 1000, lastSeen: 1000, lastCheck: 1000, missingSince: null,
  }));
}

test('a resource still in the search is confirmed, and its details follow it', () => {
  const items = itemsOf(web1);
  const renamed = res('/lab/node/uuid-1', 'web-1-rebuilt', { env: 'prod', role: 'web' });
  const out = M.applySearch(items, G, [renamed, web2], 5000);
  assert.deepEqual(out.gone, []);
  assert.deepEqual(out.back, []);
  assert.equal(out.items[0].lastSeen, 5000);
  assert.equal(out.items[0].missingSince, null);
  assert.equal(out.items[0].name, 'web-1-rebuilt', 'the record keeps the last thing that was true');
  assert.deepEqual(out.items[0].labels, { env: 'prod', role: 'web' });
});

test('a resource that has stopped being offered is noticed once', () => {
  const items = itemsOf(web1, web2);
  const first = M.applySearch(items, G, [web2], 5000);
  assert.equal(first.gone.length, 1);
  assert.equal(first.gone[0].name, 'web-1');
  assert.equal(first.items[0].missingSince, 5000);

  // Searched again a while later, still absent: the moment it went does not
  // move, or every check would announce it afresh.
  const second = M.applySearch(first.items, G, [web2], 9000);
  assert.deepEqual(second.gone, [], 'not news twice');
  assert.equal(second.items[0].missingSince, 5000);
  assert.equal(second.items[0].lastCheck, 9000, 'but it is still being looked for');
});

test('what was known at the last sighting is not overwritten while it is gone', () => {
  const items = itemsOf(web1);
  const gone = M.applySearch(items, G, [], 5000);
  const later = M.applySearch(gone.items, G, [], 9000);
  const rec = later.items[0];
  assert.equal(rec.lastSeen, 1000, 'last confirmed is when it was last there');
  assert.equal(rec.name, 'web-1');
  assert.deepEqual(rec.labels, { env: 'prod' });
});

test('a resource that comes back says so', () => {
  const items = itemsOf(web1);
  const gone = M.applySearch(items, G, [], 5000);
  const back = M.applySearch(gone.items, G, [web1], 9000);
  assert.equal(back.back.length, 1);
  assert.equal(back.items[0].missingSince, null);
  assert.equal(back.items[0].lastSeen, 9000);
});

test('a search of one cluster says nothing about another', () => {
  const mine = itemsOf(web1);
  const elsewhere = [{ ...itemsOf(web2)[0], proxy: 'other.example.com:443' }];
  const out = M.applySearch([...mine, ...elsewhere], G, [web1], 5000);
  assert.deepEqual(out.gone, [], 'the other cluster was not searched, so nothing of it is missing');
  assert.equal(out.items[1].lastCheck, 1000, 'and its record is untouched');
});

test('a search of one kind says nothing about another kind', () => {
  const nodes = itemsOf(web1);
  const apps = [{ ...itemsOf(web2)[0], kind: 'app', id: '/lab/app/grafana', name: 'grafana' }];
  const out = M.applySearch([...nodes, ...apps], G, [web1], 5000);
  assert.deepEqual(out.gone, []);
  assert.equal(out.items[1].missingSince, null);
});

test('the same tsh home is part of what identifies a resource', () => {
  const here = itemsOf(web1);
  const otherHome = [{ ...itemsOf(web1)[0], home: '/tmp/other-tsh' }];
  const out = M.applySearch([...here, ...otherHome], G, [], 5000);
  assert.equal(out.gone.length, 1, 'only the one reached through this home was searched');
  assert.equal(out.items[1].missingSince, null);
});

test('searches are grouped, so twelve nodes on one cluster are one search', () => {
  const items = [
    ...itemsOf(web1, web2),
    { ...itemsOf(web1)[0], kind: 'app', id: '/lab/app/grafana' },
    { ...itemsOf(web1)[0], proxy: 'other.example.com:443' },
  ];
  const groups = M.groupsOf(items);
  assert.equal(groups.length, 3, 'one per proxy+home+kind');
  const nodeGroup = groups.find((g) => g.kind === 'node' && g.proxy === G.proxy);
  assert.equal(nodeGroup.items.length, 2);
});

test('the interval is held to something a proxy can stand, and defaults to five minutes', () => {
  state.settings = { ...store, requestMonitorMinutes: undefined };
  assert.equal(M.monitorMinutes(), 5, 'what was asked for');
  for (const [given, want] of [[1, 1], [0, 5], [-4, 5], [0.2, 1], [90, 60], [15, 15], ['x', 5]]) {
    state.settings = { ...store, requestMonitorMinutes: given };
    assert.equal(M.monitorMinutes(), want, `${given} → ${want}`);
  }
  state.settings = store;
});

test('a monitored resource is identified by its id, its proxy and its home', () => {
  const a = { id: '/lab/node/uuid-1', proxy: 'p', home: null };
  assert.equal(M.monitorKey(a), M.monitorKey({ ...a }));
  assert.notEqual(M.monitorKey(a), M.monitorKey({ ...a, home: '/tmp/h' }));
  assert.notEqual(M.monitorKey(a), M.monitorKey({ ...a, proxy: 'q' }));
  assert.notEqual(M.monitorKey(a), M.monitorKey({ ...a, id: '/lab/node/uuid-2' }));
});

test('the detail kept is what the cluster will not be able to tell you later', () => {
  const items = itemsOf(web1);
  const gone = M.applySearch(items, G, [], 5000);
  const line = M.missingDetail(gone.items[0]);
  assert.match(line, /Not in tsh request search/);
  assert.match(line, /id: \/lab\/node\/uuid-1/);
  assert.match(line, /cluster: lab/);
  assert.match(line, /labels: env=prod/);
});

test('how long ago reads in the largest useful unit', () => {
  const now = Date.now();
  assert.equal(M.ago(0), '');
  assert.match(M.ago(now - 30 * 1000), /^\d+s$/);
  assert.match(M.ago(now - 20 * 60000), /^\d+m$/);
  assert.match(M.ago(now - 5 * 3600000), /^\d+h$/);
  assert.match(M.ago(now - 6 * 86400000), /^\d+d$/);
});

test('unticking stops monitoring — but a resource that has gone cannot be unticked away', () => {
  const profile = { proxy: G.proxy, homeDir: G.home, cluster: 'lab' };
  const items = [
    ...itemsOf(web1, web2),
    { ...itemsOf(res('/lab/node/uuid-3', 'retired-db-1'))[0], missingSince: 4000 },
    { ...itemsOf(web1)[0], proxy: 'other.example.com:443' },
  ];
  // The picker can only offer what the search returned: web-1 and web-2. The
  // user keeps web-1 and unticks web-2.
  const out = M.reconcileForProfile(items, profile, ['/lab/node/uuid-1']);
  const names = out.map((r) => `${r.name}@${r.proxy}`);
  assert.deepEqual(names, [
    'web-1@lab.example.com:443',
    'retired-db-1@lab.example.com:443',
    'web-1@other.example.com:443',
  ], 'web-2 goes; the missing one and the other cluster stay');
});

test('nothing is kept from a cluster the picker was not about', () => {
  const profile = { proxy: 'other.example.com:443', homeDir: null, cluster: 'other' };
  const items = itemsOf(web1, web2);
  assert.equal(M.reconcileForProfile(items, profile, []).length, 2);
});

/*
 * "Could not ask" is a third answer.
 *
 * Without it a pane full of green ticks confirmed last Friday looks exactly
 * like a pane full of green ticks confirmed a minute ago, and the moment
 * monitoring quietly stops working is the moment it stops being worth
 * anything.
 */

const STATUS_KEY = M.groupStatusKey({ proxy: G.proxy, home: G.home, kind: 'node' });

test('a cluster whose last search failed leaves its resources unchecked, not confirmed', () => {
  const r = { ...itemsOf(web1)[0], lastCheck: Date.now() };
  assert.equal(M.rowState(r, { [STATUS_KEY]: { okAt: 1000, failAt: 2000, error: 'proxy unreachable' } }), 'unchecked');
  assert.match(M.groupError(r, { [STATUS_KEY]: { okAt: 1000, failAt: 2000, error: 'proxy unreachable' } }), /proxy unreachable/);
});

test('a later success clears it again', () => {
  const r = { ...itemsOf(web1)[0], lastCheck: Date.now() };
  assert.equal(M.rowState(r, { [STATUS_KEY]: { okAt: 3000, failAt: 2000 } }), 'ok');
  assert.equal(M.groupError(r, { [STATUS_KEY]: { okAt: 3000, failAt: 2000 } }), '');
});

test('a check that simply stopped happening also reads as unchecked', () => {
  const now = Date.now();
  const fresh = { ...itemsOf(web1)[0], lastCheck: now - 60000 };
  const stale = { ...itemsOf(web1)[0], lastCheck: now - 4 * 3600000 };
  assert.equal(M.rowState(fresh, {}, 5, now), 'ok');
  assert.equal(M.rowState(stale, {}, 5, now), 'unchecked', 'four hours with no check is not a confirmation');
});

test('a verdict is withdrawn while the cluster cannot be searched', () => {
  const r = { ...itemsOf(web1)[0], missingSince: 4000, lastCheck: Date.now() };
  // Reachable: the verdict stands, because it can be re-tested and is.
  assert.equal(M.rowState(r, { [STATUS_KEY]: { okAt: Date.now() } }), 'gone');
  // Unreachable: "not requestable" is a claim with nothing behind it, and
  // the honest answer is that nobody has been able to look.
  assert.equal(M.rowState(r, { [STATUS_KEY]: { okAt: 1000, failAt: 9000 } }), 'unchecked');
  // The verdict is not lost, only withheld — the tooltip still reports it,
  // and a search that works again will restate it.
  assert.match(M.uncheckedDetail(r, { [STATUS_KEY]: { failAt: 9000 } }), /absent from the last search that worked/);
});

test('the unchecked tooltip says it is about the cluster, not the resource', () => {
  const r = itemsOf(web1)[0];
  const line = M.uncheckedDetail(r, { [STATUS_KEY]: { failAt: 2000, error: 'certificate has expired' } });
  assert.match(line, /says nothing/);
  assert.match(line, /reason: certificate has expired/);
  assert.match(line, /Last confirmed/);
});

test('an empty search is inconclusive, and is described as such', () => {
  // The same rule the host watch uses, and the reason the pane distinguishes
  // "could not search" from "the search came back empty": both leave every
  // resource exactly as it was.
  const r = { ...itemsOf(web1)[0], lastCheck: Date.now() };
  const status = { [STATUS_KEY]: { okAt: 1000, failAt: 2000, emptyAt: 2000, error: 'the search returned nothing — roles, or a cluster that cannot answer for this kind' } };
  assert.equal(M.rowState(r, status), 'unchecked', 'not gone: nothing was detected missing');
  assert.match(M.uncheckedDetail(r, status), /returned nothing/);
  assert.ok(M.EMPTY_CORROBORATION_MS >= 10 * 60000, 'and a second empty answer is required, well apart from the first');
});

test('the pane does not appear by itself unless it has been asked to', () => {
  // Default off: a floating window that opens itself over the app at launch
  // is an interruption, and the watching runs either way.
  state.settings = { ...store };
  assert.equal(M.autoOpenPane(), false);
  // Nor does "it was open when you quit" count as asking.
  state.settings = { ...store, requestMonitorOpen: true };
  assert.equal(M.autoOpenPane(), false);
  state.settings = { ...store, requestMonitorAutoOpen: true };
  assert.equal(M.autoOpenPane(), true);
  state.settings = store;
});
