import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const teleport = require(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));

/**
 * Marking a requestable server as needing MFA happens before the grant
 * exists, so the only id in hand is the one `request search` returned. This
 * is what turns that into the id the node will carry once it actually shows
 * up in the inventory (see the `id:` built in `listNodes`) — the two have to
 * agree exactly, or `isMfaHost()` would never recognise the node once it
 * arrives.
 */

test('a default-home node gets the plain tsh:<cluster>:<uuid> id', () => {
  const ids = teleport.inventoryNodeIds({
    items: [{ id: '/lab.example.com/node/abc-123', cluster: 'lab.example.com', uuid: 'abc-123' }],
  });
  assert.deepEqual(ids, { '/lab.example.com/node/abc-123': 'tsh:lab.example.com:abc-123' });
});

test('a non-default home folds its own name into the id, same as listNodes does', () => {
  const ids = teleport.inventoryNodeIds({
    items: [{ id: '/lab.example.com/node/abc-123', cluster: 'lab.example.com', uuid: 'abc-123' }],
    home: '/Users/steven/.tsh-work',
  });
  assert.deepEqual(ids, { '/lab.example.com/node/abc-123': 'tsh:work:lab.example.com:abc-123' });
});

test('several resources are matched back up by their own id, not by array order', () => {
  const items = [
    { id: '/a.example.com/node/1', cluster: 'a.example.com', uuid: '1' },
    { id: '/b.example.com/node/2', cluster: 'b.example.com', uuid: '2' },
  ];
  const ids = teleport.inventoryNodeIds({ items });
  assert.equal(ids['/a.example.com/node/1'], 'tsh:a.example.com:1');
  assert.equal(ids['/b.example.com/node/2'], 'tsh:b.example.com:2');
});

test('a resource with no uuid (apps and databases have none) is skipped rather than mis-keyed', () => {
  const ids = teleport.inventoryNodeIds({
    items: [{ id: '/lab.example.com/app/billing', cluster: 'lab.example.com', uuid: '' }],
  });
  assert.deepEqual(ids, {});
});

test('no items, or no argument at all, is just an empty map', () => {
  assert.deepEqual(teleport.inventoryNodeIds({}), {});
  assert.deepEqual(teleport.inventoryNodeIds(), {});
});
