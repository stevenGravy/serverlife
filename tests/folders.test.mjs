import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings, node, sshHost } from './helpers.mjs';

const store = fakeSettings({ hostFolders: [], folderMembers: {} });
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

const F = await import('../src/renderer/js/folders.js');

/**
 * The folder model: what is in a folder, what that means for the list, and
 * whether an arrangement survives the trip to somebody else's machine.
 *
 * Membership is the part worth guarding. It is three sources at once — what
 * was dragged in, what a rule claims, and what was taken back out — and each
 * of the three has a way of quietly winning over the others.
 */

const G = 'tp:example:443';
const hosts = [
  node('web-1', { env: 'prod', role: 'web' }),
  node('web-2', { env: 'prod', role: 'web' }),
  node('api-1', { env: 'prod', role: 'api' }),
  node('db-1', { env: 'dev', role: 'db' }),
  sshHost('jump'),
];
const names = (list) => list.map((h) => h.name || h.alias);

/** Start each test from an empty arrangement. */
async function reset() {
  store.hostFolders = [];
  store.folderMembers = {};
  state.settings = store;
}

/* ---------------- identity ---------------- */

test('a host is filed under its uuid, never its hostname', () => {
  assert.equal(F.hostKey(node('web-1')), 'uuid:uuid-web-1');
  // A Teleport node with no uuid falls back to cluster + name...
  assert.equal(F.hostKey({ type: 'teleport', cluster: 'c', name: 'x' }), 'tsh:c:x');
  // ...and an ssh_config host to its own id.
  assert.equal(F.hostKey(sshHost('jump')), 'ssh:jump');
  assert.equal(F.hostKey(null), '');
});

/* ---------------- membership ---------------- */

test('a folder holds what was dragged in', async () => {
  await reset();
  const f = await F.createFolder({ name: 'Mine', group: G });
  assert.deepEqual(names(F.hostsInFolder(f, hosts)), []);
  await F.fileHost(hosts[0], f.id);
  assert.deepEqual(names(F.hostsInFolder(F.folderById(f.id), hosts)), ['web-1']);
  assert.ok(F.isManualMember(hosts[0], f.id));
  assert.ok(F.isFiled(hosts[0], G));
  assert.ok(!F.isFiled(hosts[1], G));
});

test('a rule fills a folder on its own, and keeps up with the inventory', async () => {
  await reset();
  const f = await F.createFolder({ name: 'Prod', group: G, rule: 'env=prod' });
  assert.deepEqual(names(F.hostsInFolder(f, hosts)), ['web-1', 'web-2', 'api-1']);
  // A node that appears later and matches is in it without anyone acting.
  const late = node('web-3', { env: 'prod', role: 'web' });
  assert.ok(F.hostsInFolder(f, [...hosts, late]).includes(late));
  assert.ok(!F.isManualMember(late, f.id));
});

test('a boolean rule is honoured, brackets and all', async () => {
  await reset();
  const f = await F.createFolder({
    name: 'Edge', group: G,
    rule: 'env=prod and (role:web or role:api) and not name~^api',
  });
  assert.deepEqual(names(F.hostsInFolder(f, hosts)), ['web-1', 'web-2']);
});

test('hand-filed and rule-filled live together', async () => {
  await reset();
  const f = await F.createFolder({ name: 'Prod plus', group: G, rule: 'env=prod' });
  await F.fileHost(hosts[3], f.id);
  assert.deepEqual(names(F.hostsInFolder(F.folderById(f.id), hosts)), ['web-1', 'web-2', 'api-1', 'db-1']);
});

test('taking a rule match out sticks, and can be undone', async () => {
  await reset();
  const f = await F.createFolder({ name: 'Prod', group: G, rule: 'env=prod' });
  await F.unfileHost(hosts[1], f.id);
  assert.deepEqual(names(F.hostsInFolder(F.folderById(f.id), hosts)), ['web-1', 'api-1']);
  assert.ok(F.isExcluded(hosts[1], f.id));
  assert.ok(!F.isFiled(hosts[1], G));
  await F.clearExclusion(hosts[1], f.id);
  assert.deepEqual(names(F.hostsInFolder(F.folderById(f.id), hosts)), ['web-1', 'web-2', 'api-1']);
});

test('filing something again clears the exclusion that contradicted it', async () => {
  await reset();
  const f = await F.createFolder({ name: 'Prod', group: G, rule: 'env=prod' });
  await F.unfileHost(hosts[0], f.id);
  assert.ok(F.isExcluded(hosts[0], f.id));
  await F.fileHost(hosts[0], f.id);
  assert.ok(!F.isExcluded(hosts[0], f.id));
  assert.ok(F.hostsInFolder(F.folderById(f.id), hosts).includes(hosts[0]));
});

test('folders are scoped to their group', async () => {
  await reset();
  const f = await F.createFolder({ name: 'Elsewhere', group: 'tp:other:443', rule: 'env=prod' });
  assert.deepEqual(F.foldersForHost(hosts[0], G), []);
  assert.equal(F.isFiled(hosts[0], G), false);
  assert.deepEqual(F.foldersForHost(hosts[0], 'tp:other:443').map((x) => x.id), [f.id]);
  assert.equal(F.groupHasFolders(G), false);
  assert.equal(F.groupHasFolders('tp:other:443'), true);
});

/* ---------------- the tree ---------------- */

test('folders nest, and a tree counts each host once', async () => {
  await reset();
  const top = await F.createFolder({ name: 'Top', group: G });
  const mid = await F.createFolder({ name: 'Mid', group: G, parent: top.id });
  await F.fileHost(hosts[0], top.id);
  await F.fileHost(hosts[0], mid.id);   // the same host in both
  await F.fileHost(hosts[1], mid.id);

  assert.deepEqual(F.foldersIn(G, null).map((f) => f.name), ['Top']);
  assert.deepEqual(F.foldersIn(G, top.id).map((f) => f.name), ['Mid']);
  assert.deepEqual(F.folderPath(F.folderById(mid.id)).map((f) => f.name), ['Top', 'Mid']);
  assert.equal(F.rootOf(F.folderById(mid.id)).id, top.id);
  assert.deepEqual(names(F.hostsInTree(F.folderById(top.id), hosts)), ['web-1', 'web-2']);
  assert.deepEqual(F.subtreeIds(top.id).sort(), [top.id, mid.id].sort());
});

test('a folder cannot be put inside itself or its own child', async () => {
  await reset();
  const a = await F.createFolder({ name: 'A', group: G });
  const b = await F.createFolder({ name: 'B', group: G, parent: a.id });
  assert.equal(await F.reparentFolder(a.id, a.id), false);
  assert.equal(await F.reparentFolder(a.id, b.id), false);
  assert.equal(F.folderById(a.id).parent, null);
  assert.equal(await F.reparentFolder(b.id, null), true);
  assert.equal(F.folderById(b.id).parent, null);
});

test('deleting a folder takes its subtree and its membership, and no hosts', async () => {
  await reset();
  const a = await F.createFolder({ name: 'A', group: G });
  const b = await F.createFolder({ name: 'B', group: G, parent: a.id });
  await F.fileHost(hosts[0], b.id);
  await F.deleteFolder(a.id);
  assert.deepEqual(F.allFolders(), []);
  assert.deepEqual(store.folderMembers, {});
  // The host itself is untouched — it lives in the cluster, not in here.
  assert.equal(F.isFiled(hosts[0], G), false);
});

/* ---------------- dropping ---------------- */

test('a drop with nothing to clash with just files it', async () => {
  await reset();
  const f = await F.createFolder({ name: 'A', group: G });
  const r = await F.fileHostsInto([hosts[0]], f, G);
  assert.deepEqual(r, { count: 1, mode: 'move' });
  assert.ok(F.isManualMember(hosts[0], f.id));
});

test('a drop inside the same tree moves without asking', async () => {
  await reset();
  const top = await F.createFolder({ name: 'Top', group: G });
  const mid = await F.createFolder({ name: 'Mid', group: G, parent: top.id });
  await F.fileHost(hosts[0], top.id);
  const r = await F.fileHostsInto([hosts[0]], mid, G);
  assert.equal(r.mode, 'move');
  assert.deepEqual(names(F.hostsInFolder(F.folderById(top.id), hosts)), []);
  assert.deepEqual(names(F.hostsInFolder(F.folderById(mid.id), hosts)), ['web-1']);
});

test('several hosts land in one go', async () => {
  await reset();
  const f = await F.createFolder({ name: 'A', group: G });
  const r = await F.fileHostsInto([hosts[0], hosts[1], hosts[4]], f, G);
  assert.equal(r.count, 3);
  assert.deepEqual(names(F.hostsInFolder(F.folderById(f.id), hosts)), ['web-1', 'web-2', 'jump']);
});

/* ---------------- sharing ---------------- */

test('an export carries the tree, the rules and the membership — and nothing else', async () => {
  await reset();
  const a = await F.createFolder({ name: 'A', group: G, rule: 'env=prod', icon: '🔥', color: 'red' });
  await F.createFolder({ name: 'B', group: G, parent: a.id });
  await F.fileHost(hosts[3], a.id);
  await F.createFolder({ name: 'Other', group: 'tp:other:443' });

  const data = F.exportData(G);
  assert.equal(data.kind, 'serverlife-folders');
  assert.deepEqual(data.groups, [G]);
  assert.deepEqual(data.folders.map((f) => f.name), ['A', 'B']);   // the other group stays out
  assert.equal(data.folders[0].icon, '🔥');
  assert.equal(data.folders[0].color, 'red');
  assert.deepEqual(Object.values(data.members)[0].in, [F.hostKey(hosts[3])]);
  assert.ok(!JSON.stringify(data).includes('password'));
});

test('an import lands on the same machines, with new ids', async () => {
  await reset();
  const a = await F.createFolder({ name: 'A', group: G, rule: 'env=prod' });
  await F.fileHost(hosts[3], a.id);
  const text = JSON.stringify(F.exportData(G));

  await reset();
  const out = await F.importData(F.parseImport(text), { mode: 'merge' });
  assert.equal(out.folders, 1);
  const back = F.allFolders()[0];
  assert.notEqual(back.id, a.id);                       // a fresh id
  assert.equal(back.rule, 'env=prod');
  assert.deepEqual(names(F.hostsInFolder(back, hosts)), ['web-1', 'web-2', 'api-1', 'db-1']);
});

test('importing twice copies rather than overwriting, and replace does overwrite', async () => {
  await reset();
  await F.createFolder({ name: 'A', group: G });
  const text = JSON.stringify(F.exportData(G));
  await F.importData(F.parseImport(text), { mode: 'merge' });
  assert.equal(F.allFolders().length, 2);
  await F.importData(F.parseImport(text), { mode: 'replace' });
  assert.equal(F.allFolders().length, 1);
});

test('an import can be landed in another group', async () => {
  await reset();
  await F.createFolder({ name: 'A', group: G, rule: 'env=prod' });
  const text = JSON.stringify(F.exportData(G));
  await reset();
  await F.importData(F.parseImport(text), { mode: 'merge', remap: 'tp:elsewhere:443' });
  assert.equal(F.allFolders()[0].group, 'tp:elsewhere:443');
});

test('a file that is not one of ours is refused by name', () => {
  assert.throws(() => F.parseImport('not json'), /not JSON/);
  assert.throws(() => F.parseImport('{"kind":"something-else"}'), /not a ServerLife folder export/);
  assert.throws(() => F.parseImport('{"kind":"serverlife-folders"}'), /no folders/);
});

/* ---------------- the repair ---------------- */

test('folders filed under a proxy address are moved to the group that draws them', async () => {
  await reset();
  // Exactly what 0.6.0 wrote when a folder was made from a group heading.
  store.hostFolders = [
    { id: 'f1', name: 'Orphan', group: 'example:443', parent: null, rule: '' },
    { id: 'f2', name: 'Fine', group: G, parent: null, rule: '' },
    { id: 'f3', name: 'Unknown cluster', group: 'gone.example:443', parent: null, rule: '' },
  ];
  const moved = await F.repairFolderGroups([{ key: G }, { key: 'ssh' }]);
  assert.equal(moved, 1);
  assert.equal(F.folderById('f1').group, G);
  assert.equal(F.folderById('f2').group, G);
  // A group that is not here stays as it is rather than being guessed at.
  assert.equal(F.folderById('f3').group, 'gone.example:443');
});

/* ---------------- drawing ---------------- */

test('a folder shows its own icon, or the open and shut ones', async () => {
  await reset();
  const plain = await F.createFolder({ name: 'Plain', group: G });
  const fancy = await F.createFolder({ name: 'Fancy', group: G, icon: '🔥', color: 'red' });
  assert.equal(F.folderIcon(plain, false), '\u{1F4C1}');
  assert.equal(F.folderIcon(plain, true), '\u{1F4C2}');
  assert.equal(F.folderIcon(fancy, true), '🔥');
  assert.equal(F.folderColor(fancy), '#f85149');
  assert.equal(F.folderColor(plain), '');
});
