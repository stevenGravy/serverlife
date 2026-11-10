import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/renderer/js/state.js';
import { arranged, macroKindOf, macrosFor } from '../src/renderer/js/macros.js';

const ids = (list) => list.map((m) => m.id);

test('dragged macros keep their order, unplaced ones fall in behind in their old order', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(ids(arranged(list, [])), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(arranged(list, ['c', 'a'])), ['c', 'a', 'b', 'd']);
  // An id in the saved order whose macro is gone is simply skipped.
  assert.deepEqual(ids(arranged(list, ['gone', 'd'])), ['d', 'a', 'b', 'c']);
});

test('a tmux pane in a beam is offered the beam macros', () => {
  state.setConnection('c1', { id: 'c1', type: 'beam' });
  state.setConnection('c2', { id: 'c2', type: 'teleport' });
  const macros = [{ id: 'b', where: 'beams' }, { id: 'h', where: 'hosts' }, { id: 'l', where: 'local' }];
  assert.equal(macroKindOf({ kind: 'tmux', connId: 'c1' }), 'beam');
  assert.deepEqual(ids(macrosFor(macroKindOf({ kind: 'tmux', connId: 'c1' }), macros)), ['b', 'h']);
  assert.equal(macroKindOf({ kind: 'tmux', connId: 'c2' }), 'remote');
  assert.deepEqual(ids(macrosFor('remote', macros)), ['h']);
});
