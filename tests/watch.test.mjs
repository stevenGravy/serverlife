import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings, node, sshHost } from './helpers.mjs';

const store = fakeSettings({ watchedHosts: {} });
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

// The toasts want a DOM; the logic does not. Everything user-visible goes
// through these two, so stubbing them keeps the module under test intact.
const said = [];
globalThis.document = {
  querySelector: () => ({ textContent: '', append: () => {}, classList: { add() {}, remove() {} } }),
};
const W = await import('../src/renderer/js/watch.js');

/**
 * Watching for a disappearance.
 *
 * Two things have to hold. It must notice — a node that leaves the
 * inventory is otherwise simply not drawn, and nothing says so. And it must
 * not cry wolf: a failed read, an expired certificate or a cluster that was
 * never asked all produce a list without the host in it, and declaring a
 * machine gone on that evidence would make the whole feature untrustworthy
 * within a day.
 */

const G = 'tp:example:443';
const web1 = node('web-1', { env: 'prod' });
const web2 = node('web-2', { env: 'prod' });
// A third machine, so a list can come back non-empty with the watched one
// absent from it — which is what "detected missing" actually looks like.
const db1 = node('db-1', { env: 'prod' });

async function reset() {
  W.forgetEmptyReads();
  store.watchedHosts = {};
  state.settings = store;
  said.length = 0;
}

test('marking a host keeps its id and its last known details', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  assert.ok(W.isWatched(web1));
  const rec = W.watchRecord(web1);
  assert.equal(rec.uuid, 'uuid-web-1');
  assert.equal(rec.name, 'web-1');
  assert.equal(rec.cluster, 'c1');
  assert.equal(rec.group, G);
  assert.deepEqual(rec.labels, { env: 'prod' });
  assert.ok(rec.lastSeen > 0);
  assert.equal(rec.missingSince, null);
  assert.equal(W.watchCount(), 1);
});

test('unmarking takes the record with it', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.toggleWatch(web1, G);
  assert.equal(W.isWatched(web1), false);
  assert.equal(W.watchCount(), 0);
});

test('a host that is still listed is not missing, and its record is refreshed', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  const moved = node('web-1', { env: 'prod', role: 'web' }, { addr: '10.0.0.9:3022' });
  await W.noteSeen(G, [moved, web2]);
  const rec = W.watchRecord(web1);
  assert.equal(rec.missingSince, null);
  assert.equal(rec.addr, '10.0.0.9:3022', 'the record follows the host while it is there');
  assert.deepEqual(rec.labels, { env: 'prod', role: 'web' });
  assert.deepEqual(W.missingIn(G, [moved, web2]), []);
});

test('a host that leaves the list is noticed once', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1, web2]);

  await W.noteSeen(G, [web2]);                 // web-1 is gone
  const first = W.watchRecord(web1).missingSince;
  assert.ok(first, 'noticed');

  await new Promise((r) => setTimeout(r, 5));
  await W.noteSeen(G, [web2]);                 // still gone, still the same moment
  assert.equal(W.watchRecord(web1).missingSince, first,
    'missingSince is when it went, not when it was last polled');
});

test('a missing host is drawn from the record, host-shaped', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1]);
  await W.noteSeen(G, [db1]);

  const ghosts = W.missingIn(G, []);
  assert.equal(ghosts.length, 1);
  const g = ghosts[0];
  assert.equal(g.missing, true);
  assert.equal(g.name, 'web-1');
  assert.equal(g.uuid, 'uuid-web-1');
  assert.equal(g.cluster, 'c1');
  assert.deepEqual(g.labels, { env: 'prod' });
  assert.ok(g.id.startsWith('missing:'));
  // It carries enough for the filter to match it like any other host.
  const { compileQuery } = await import('../src/renderer/js/tags.js');
  assert.ok(compileQuery('env=prod').match(g));
  assert.ok(compileQuery('name=web-1').match(g));
});

test('a host that comes back stops being missing', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [db1]);
  assert.equal(W.missingIn(G, []).length, 1);
  await W.noteSeen(G, [web1]);
  assert.equal(W.watchRecord(web1).missingSince, null);
  assert.deepEqual(W.missingIn(G, [web1]), []);
});

test('a group that was never read declares nothing missing', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  // No noteSeen at all: nothing has been looked at, so nothing is gone.
  assert.deepEqual(W.missingIn(G, []), []);
  assert.deepEqual(W.missingHosts(), []);
});

test('another group\'s read says nothing about this one', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen('tp:somewhere-else:443', []);
  assert.equal(W.watchRecord(web1).missingSince, null);
  assert.deepEqual(W.missingIn(G, []), []);
});

test('a host still present is never listed as a ghost', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [db1]);                   // gone
  assert.equal(W.missingIn(G, []).length, 1);
  // Present again in the list handed to the drawing code, before any read.
  assert.deepEqual(W.missingIn(G, [web1]), []);
});

test('ssh hosts can be watched too', async () => {
  await reset();
  const jump = sshHost('jump');
  await W.setWatched(jump, 'ssh', true);
  await W.noteSeen('ssh', [sshHost('bastion')]);
  const ghosts = W.missingIn('ssh', []);
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].alias, 'jump');
  assert.equal(ghosts[0].type, 'ssh');
});

test('how long it has been gone reads in the largest useful unit', () => {
  const now = Date.now();
  assert.match(W.goneFor(now - 30 * 1000), /^\d+s$/);
  assert.match(W.goneFor(now - 20 * 60000), /^\d+m$/);
  assert.match(W.goneFor(now - 5 * 3600000), /^\d+h$/);
  assert.match(W.goneFor(now - 6 * 86400000), /^\d+d$/);
});

test('the tooltip says what the cluster no longer can', async () => {
  await reset();
  await W.setWatched(node('web-1', {}, { addr: '10.0.0.9:3022' }), G, true);
  await W.noteSeen(G, [db1]);
  const line = W.missingLine(W.missingIn(G, [])[0]);
  assert.match(line, /Not in the inventory/);
  assert.match(line, /Last seen/);
  assert.match(line, /uuid-web-1/);
  assert.match(line, /10\.0\.0\.9:3022/);
});

test('the bell can be turned off without turning the watch off', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  assert.equal(W.showWatchMark(), true, 'shown by default');

  state.settings = { ...store, showWatchMark: false };
  assert.equal(W.showWatchMark(), false);
  // The watch is untouched by the preference: it still notices, and still
  // keeps drawing what has gone.
  assert.ok(W.isWatched(web1));
  await W.noteSeen(G, [db1]);
  assert.equal(W.missingIn(G, []).length, 1);
  state.settings = store;
});

/*
 * A watch ends when the person ends it.
 *
 * Everything below is one rule seen from four sides: nothing about the
 * *place* a host was watched in — a cluster logged out of, a profile
 * removed, an address written with its port one day and without it the next
 * — may quietly cancel the arrangement or hide what it found.
 */

test('a host whose group is not on screen is drawn, but no longer as a verdict', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [db1]);                    // a read that worked: it has gone
  // Its cluster is listed: it belongs to that group and nowhere else.
  assert.deepEqual(W.orphanGhosts([G]), []);

  // Its cluster is not listed at all — expired, logged out, or removed. It
  // is still drawn, because a watch must never go quiet, but it is drawn as
  // unchecked: nothing here can be re-tested, so "gone" is a claim the app
  // can no longer stand behind.
  const loose = W.orphanGhosts(['tp:other:443']);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].name, 'web-1');
  assert.equal(loose[0].missing, false, 'not asserted while it cannot be checked');
  assert.equal(loose[0].unconfirmed, true);
  assert.equal(loose[0].group, G, 'it remembers where it came from');
  // And the finding is not lost — it is in the record, and in the tooltip.
  assert.ok(loose[0].missingSince);
  assert.match(W.unconfirmedLine(loose[0]), /absent from the last list that could be read/);
  assert.deepEqual(W.orphanGhosts([]), loose, 'no groups drawn at all: still drawn');
});

test('a watched host that is still there is not an orphan — only the gone ones', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1]);
  assert.deepEqual(W.orphanGhosts([]), [], 'present, so there is nothing to report');
});

test('a logout is not a read that merely failed — it shows up at once, not after a wait', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1]);                   // confirmed present, moments ago
  assert.deepEqual(W.orphanGhosts([]), [], 'nothing to say yet — lastSeen is fresh');

  await W.noteLoggedOut(G);
  const loose = W.orphanGhosts([]);
  assert.equal(loose.length, 1, 'drawn immediately, without waiting out unconfirmedAfterMs');
  assert.equal(loose[0].name, 'web-1');
  assert.equal(loose[0].missing, false, 'nothing was actually re-read');
  assert.equal(loose[0].unconfirmed, true);
  assert.equal(loose[0].missingSince, null, 'no finding to claim — this is not a verdict');

  // Logged back in, and the next successful read sees it: the flag is
  // ordinary stale state, cleared the same way missingSince is.
  await W.noteSeen(G, [web1]);
  assert.deepEqual(W.orphanGhosts([]), [], 'back, and the record says so again');
});

test('the same cluster written with and without its port is the same cluster', async () => {
  await reset();
  await W.setWatched(web1, 'tp:lab.example.com:443', true);
  // The profile is re-read and the key arrives without the port.
  await W.noteSeen('tp:lab.example.com', [db1]);
  assert.ok(W.watchRecord(web1).missingSince, 'noticed through the drifted key');
  assert.equal(W.missingIn('tp:lab.example.com', []).length, 1, 'and drawn there');
  assert.equal(W.missingIn('tp:lab.example.com:443', []).length, 1, 'and there');
  assert.deepEqual(W.orphanGhosts(['tp:lab.example.com']), [], 'not orphaned by the difference');
});

test('what was known at the last sighting is never overwritten afterwards', async () => {
  await reset();
  const before = node('web-1', { env: 'prod', role: 'web' }, { addr: '10.0.4.9:3022' });
  await W.setWatched(before, G, true);
  await W.noteSeen(G, [before]);
  const seenAt = W.watchRecord(before).lastSeen;

  await new Promise((r) => setTimeout(r, 5));
  await W.noteSeen(G, [db1]);                       // gone
  await new Promise((r) => setTimeout(r, 5));
  await W.noteSeen(G, [web2]);                   // still gone, several reads later

  const rec = W.watchRecord(before);
  assert.equal(rec.lastSeen, seenAt, 'last seen is when it was last there');
  assert.equal(rec.addr, '10.0.4.9:3022');
  assert.deepEqual(rec.labels, { env: 'prod', role: 'web' });
  assert.equal(rec.hostname, 'web-1');
  assert.equal(rec.cluster, 'c1');
});

test('the tooltip carries the details the cluster can no longer be asked for', async () => {
  await reset();
  const h = node('web-1', { env: 'prod', 'teleport.internal/resource-id': 'x-1' }, { addr: '10.0.4.9:3022' });
  await W.setWatched(h, G, true);
  await W.noteSeen(G, [db1]);
  const line = W.missingLine(W.missingIn(G, [])[0]);
  assert.match(line, /node id: uuid-web-1/);
  assert.match(line, /last address: 10\.0\.4\.9:3022/);
  assert.match(line, /cluster: c1/);
  assert.match(line, /labels: env=prod/);
  assert.doesNotMatch(line, /resource-id/, 'teleport\'s own bookkeeping is not a detail about the host');
});

test('everything can be unwatched at once', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.setWatched(web2, G, true);
  assert.equal(W.watchCount(), 2);
  await W.forgetAll();
  assert.equal(W.watchCount(), 0);
  assert.deepEqual(W.missingIn(G, []), []);
});

/*
 * And the watch nobody can answer.
 *
 * A cluster you are logged out of draws no hosts, so its watches used to
 * stop being mentioned at all — which reads as "all present" and is the one
 * thing an absence must never be allowed to imply.
 */

test('a watched host goes unconfirmed once reads stop landing', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1]);
  // Confirmed a moment ago, and in the list in front of us: nothing to say.
  assert.deepEqual(W.unconfirmedIn(G, [web1]), []);
  assert.deepEqual(W.unconfirmedIn(G, []), [], 'and not on one missed read either');

  // Hours later, with no successful read since.
  const later = Date.now() + 4 * 3600000;
  const loose = W.unconfirmedIn(G, [], later);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].unconfirmed, true);
  assert.equal(loose[0].missing, false, 'not a verdict — nobody has looked');
  assert.equal(loose[0].name, 'web-1', 'drawn from the record, like a ghost');
});

test('a host judged gone is gone, not unconfirmed', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [db1]);                       // a search that worked: it has left
  const later = Date.now() + 4 * 3600000;
  assert.deepEqual(W.unconfirmedIn(G, [], later), [], 'it has a verdict already');
  assert.equal(W.missingIn(G, []).length, 1);
});

test('a cluster that is not listed at all reports everything as unchecked', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.setWatched(web2, G, true);
  await W.noteSeen(G, [web1, web2]);
  await W.noteSeen(G, [web1, db1]);              // web-2 has gone

  const later = Date.now() + 4 * 3600000;
  const loose = W.orphanGhosts(['tp:somewhere-else:443'], later);
  assert.deepEqual(loose.map((h) => h.name).sort(), ['web-1', 'web-2'], 'both still watched');
  assert.deepEqual(loose.map((h) => h.missing), [false, false],
    'and neither is asserted gone while the cluster cannot be read');
  // The one that was seen to leave still carries the finding, for the tooltip.
  const gone = loose.find((h) => h.name === 'web-2');
  assert.ok(gone.missingSince);
  assert.equal(loose.find((h) => h.name === 'web-1').missingSince, null);
});

test('the unconfirmed tooltip blames the cluster, not the host', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  const later = Date.now() + 4 * 3600000;
  const line = W.unconfirmedLine(W.unconfirmedIn(G, [], later)[0]);
  assert.match(line, /could not be read/);
  assert.match(line, /says nothing/);
  assert.match(line, /Last confirmed/);
});

/*
 * What counts as having detected a disappearance.
 *
 * A host is gone when a list came back with other hosts in it and this one
 * was not among them. An empty list is a different thing entirely — a role
 * that changed, a leaf that dropped, a cluster mid-restart all produce one,
 * successfully — and "every machine you were watching left at the same
 * moment" is never the likeliest reading of it.
 */

test('an empty read marks nothing, however many times in a row it arrives quickly', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.setWatched(web2, G, true);
  await W.noteSeen(G, [web1, web2]);

  const t0 = Date.now();
  for (const at of [t0, t0 + 1000, t0 + 60000, t0 + 5 * 60000]) {
    await W.noteSeen(G, [], { now: at });
  }
  assert.equal(W.watchRecord(web1).missingSince, null, 'nothing concluded from nothing');
  assert.equal(W.watchRecord(web2).missingSince, null);
  assert.deepEqual(W.missingIn(G, []), []);
});

test('a cluster that stays empty is eventually taken at its word', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1]);

  const t0 = Date.now();
  await W.noteSeen(G, [], { now: t0 });
  assert.equal(W.watchRecord(web1).missingSince, null, 'not on the first empty answer');

  // Ten minutes later, still nothing there. A lab really can be torn down.
  const change = await W.noteSeen(G, [], { now: t0 + 11 * 60000 });
  assert.equal(W.watchRecord(web1).missingSince, t0 + 11 * 60000);
  assert.equal(change.gone.length, 1);
});

test('a list that comes back in between clears the count', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  const t0 = Date.now();
  await W.noteSeen(G, [], { now: t0 });
  await W.noteSeen(G, [web1], { now: t0 + 60000 });          // it was there all along
  await W.noteSeen(G, [], { now: t0 + 11 * 60000 });         // first empty again
  assert.equal(W.watchRecord(web1).missingSince, null,
    'the pair has to be two empty answers, not one from either side of a good one');
});

test('one host absent from a list of others is detected at once', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1, web2, db1]);
  const change = await W.noteSeen(G, [web2, db1]);
  assert.equal(change.gone.length, 1, 'no corroboration needed: the cluster answered, and it was not in the answer');
  assert.ok(W.watchRecord(web1).missingSince);
});

/*
 * Out of reach is not gone.
 *
 * `tsh ls` is what you can reach and `tsh request search` is what you could
 * ask to reach, and a node moves between them without changing in any way —
 * an approved request expires, a role is edited. Watching only the first
 * list, that move is indistinguishable from the machine being
 * decommissioned, which is how a host that was answering heartbeats came to
 * read "gone 2h".
 */

function stubRequestSearch(resources) {
  globalThis.window.api.teleport = {
    requestSearch: async () => ({ ok: true, resources }),
  };
}

const reqOf = (n) => ({ id: `/c1/node/${n.uuid}`, uuid: n.uuid, name: n.name, kind: 'node', cluster: 'c1', labels: {} });

test('a watched host that has become requestable is not called gone', async () => {
  await reset();
  const { invalidateRequestable } = await import('../src/renderer/js/requestable.js');
  invalidateRequestable();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1, db1]);

  // It leaves the inventory — and turns up in the request search instead.
  stubRequestSearch([reqOf(web1)]);
  const change = await W.noteSeen(G, [db1]);
  const rec = W.watchRecord(web1);
  assert.equal(rec.missingSince, null, 'not a disappearance');
  assert.ok(rec.requestableSince, 'a state of its own, noted once');
  assert.equal(change.gone.length, 0);
  assert.equal(change.askable.length, 1);

  // It is drawn, as something to ask for rather than something lost.
  assert.deepEqual(W.missingIn(G, []), []);
  const askable = W.requestableIn(G, []);
  assert.equal(askable.length, 1);
  assert.equal(askable[0].requestable, true);
  assert.equal(askable[0].missing, false);
  assert.equal(askable[0].name, 'web-1');
});

test('and it is not drawn twice', async () => {
  // It is absent from the node list and its lastSeen is old, which is the
  // shape of an unchecked watch — but it has been checked, and the answer
  // was "requestable". One row, not two.
  const later = Date.now() + 4 * 3600000;
  assert.deepEqual(W.unconfirmedIn(G, [], later), []);
  assert.equal(W.requestableIn(G, []).length, 1);
});

test('a requestable watch says when it was last checked, once checks stop landing', async () => {
  // Just confirmed requestable: req alone.
  assert.equal(W.requestableIn(G, [])[0].requestUncheckedSince, null);

  // Hours without a check: still req, and unchecked since the last one.
  const at = W.watchRecord(web1).requestCheckedAt;
  assert.ok(at, 'the check is stamped');
  const later = Date.now() + 4 * 3600000;
  const [row] = W.requestableIn(G, [], later);
  assert.equal(row.requestable, true);
  assert.equal(row.requestUncheckedSince, at);
  assert.match(W.requestUncheckedLine(row), /Last confirmed requestable/);

  // A logout says so at once, without waiting the checks out.
  await W.noteLoggedOut(G);
  assert.equal(W.requestableIn(G, [])[0].requestUncheckedSince, at);

  // And the next check that finds it requestable clears both.
  await W.noteSeen(G, [db1]);
  assert.equal(W.watchRecord(web1).loggedOut, false);
  assert.equal(W.requestableIn(G, [])[0].requestUncheckedSince, null);
});

test('an empty node list does not stop a wrong verdict being corrected', async () => {
  await reset();
  const { invalidateRequestable } = await import('../src/renderer/js/requestable.js');
  invalidateRequestable();
  await W.setWatched(web1, G, true);
  // Already marked gone — by the old code, or by a cluster that really had
  // lost it — and now every `tsh ls` comes back empty because access to the
  // whole cluster has lapsed.
  const map = { ...(store.watchedHosts || {}) };
  map[Object.keys(map)[0]].missingSince = Date.now() - 7200000;
  stubRequestSearch([reqOf(web1)]);

  await W.noteSeen(G, []);
  const rec = W.watchRecord(web1);
  assert.equal(rec.missingSince, null, 'positive evidence outranks an absence');
  assert.ok(rec.requestableSince);
});

test('coming back to standing access clears it again', async () => {
  await reset();
  const { invalidateRequestable } = await import('../src/renderer/js/requestable.js');
  invalidateRequestable();
  await W.setWatched(web1, G, true);
  stubRequestSearch([reqOf(web1)]);
  await W.noteSeen(G, [db1]);
  assert.ok(W.watchRecord(web1).requestableSince);

  // The request is approved: it is in the inventory again.
  const change = await W.noteSeen(G, [web1, db1]);
  assert.equal(W.watchRecord(web1).requestableSince, null);
  assert.equal(W.watchRecord(web1).missingSince, null);
  assert.equal(change.back.length, 1, 'said once, like any other return');
  assert.deepEqual(W.requestableIn(G, []), []);
});

test('a search that fails leaves the verdict alone rather than softening it', async () => {
  await reset();
  const { invalidateRequestable } = await import('../src/renderer/js/requestable.js');
  invalidateRequestable();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1, db1]);
  globalThis.window.api.teleport = { requestSearch: async () => ({ ok: false, error: 'proxy unreachable' }) };
  await W.noteSeen(G, [db1]);
  // Absent from a list that worked, and the other list could not be asked:
  // gone is the honest answer, and "requestable" would be a guess.
  assert.ok(W.watchRecord(web1).missingSince);
  assert.equal(W.watchRecord(web1).requestableSince, null);
});

/*
 * A list narrowed by an assumed request.
 *
 * Assuming a request for one node limits the certificate to that node, so
 * `tsh ls` lists it and nothing else. Every other watched host was declared
 * gone at the next poll — which is what this guards.
 */

test('a narrowed read says nothing about the hosts it leaves out', async () => {
  await reset();
  globalThis.window.api.teleport = { requestSearch: async () => { throw new Error('must not be asked'); } };
  await W.setWatched(web1, G, true);
  await W.setWatched(web2, G, true);
  await W.noteSeen(G, [web1, web2, db1]);
  const change = await W.noteSeen(G, [db1], { partial: true });
  assert.equal(change?.gone?.length || 0, 0);
  assert.equal(W.watchRecord(web1).missingSince, null);
  assert.equal(W.watchRecord(web1).requestableSince, null);
  assert.deepEqual(W.missingIn(G, [db1]), []);
});

test('but what it does list still counts as seen', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web2, db1]);
  assert.ok(W.watchRecord(web1).missingSince, 'gone from a full list');
  const change = await W.noteSeen(G, [web1], { partial: true });
  assert.equal(change.back.length, 1, 'granted by the request: it is plainly there');
  assert.equal(W.watchRecord(web1).missingSince, null);
});

test('an empty narrowed read does not start the empty-cluster clock', async () => {
  await reset();
  await W.setWatched(web1, G, true);
  await W.noteSeen(G, [web1, db1]);
  const t0 = Date.now();
  await W.noteSeen(G, [], { partial: true, now: t0 });
  await W.noteSeen(G, [], { now: t0 + 11 * 60 * 1000 });
  assert.equal(W.watchRecord(web1).missingSince, null, 'one real empty read is not corroborated by a narrowed one');
});
