import test from 'node:test';
import assert from 'node:assert/strict';

import { liveSessions } from '../src/renderer/js/quitguard.js';

/**
 * Which panes are worth asking about before quitting.
 *
 * The failure that matters is the false alarm: a question every time, about
 * a local shell or a session that ended an hour ago, is a question people
 * learn to dismiss without reading — and then it is no use on the day it is
 * right. So most of this is about what must *not* count.
 */

function fakeState({ tabs, panes, connections = {}, forwards = {} }) {
  const paneMap = new Map(panes.map((p) => [p.id, p]));
  return {
    tabs,
    panesOf: (tabId) => panes.filter((p) => p.tabId === tabId).map((p) => p.id),
    getPane: (id) => paneMap.get(id),
    getConnection: (id) => connections[id],
    forwards: new Map(Object.entries(forwards)),
  };
}

test('local shells never count', () => {
  const s = fakeState({
    tabs: [{ id: 't1', title: 'zsh' }],
    panes: [{ id: 'p1', tabId: 't1', kind: 'local', termId: 'l1', status: 'connected' }],
  });
  assert.deepEqual(liveSessions(s), []);
});

test('a connected remote pane counts under the connection label', () => {
  const s = fakeState({
    tabs: [{ id: 't1', title: 'web-1' }],
    panes: [{ id: 'p1', tabId: 't1', kind: 'remote', connId: 'c1', termId: 'x', status: 'connected' }],
    connections: { c1: { state: 'connected', type: 'teleport', label: 'web-1.prod' } },
  });
  assert.deepEqual(liveSessions(s), [{ kind: 'teleport', name: 'web-1.prod' }]);
});

test('failed, connecting and ended remote panes do not count', () => {
  const s = fakeState({
    tabs: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
    panes: [
      { id: 'p1', tabId: 't1', kind: 'remote', connId: 'c1', status: 'error' },
      { id: 'p2', tabId: 't2', kind: 'remote', connId: 'c2', status: 'connecting' },
      // The shell exited; the ControlMaster outlived it.
      { id: 'p3', tabId: 't3', kind: 'remote', connId: 'c3', termId: null, status: 'closed' },
    ],
    connections: {
      c1: { state: 'error', label: 'a' },
      c2: { state: 'connecting', label: 'b' },
      c3: { state: 'connected', label: 'c' },
    },
  });
  assert.deepEqual(liveSessions(s), []);
});

test('an ended shell still counts while a port forward rides its connection', () => {
  const s = fakeState({
    tabs: [{ id: 't1' }],
    panes: [{ id: 'p1', tabId: 't1', kind: 'remote', connId: 'c1', termId: null, status: 'closed' }],
    connections: { c1: { state: 'connected', type: 'ssh', label: 'db-jump' } },
    forwards: { c1: [{ kind: 'L', bindPort: 5432 }] },
  });
  assert.deepEqual(liveSessions(s), [{ kind: 'ssh', name: 'db-jump' }]);
});

test('files-only panes count; a host-list pane with no connection does not', () => {
  const s = fakeState({
    tabs: [{ id: 't1' }, { id: 't2' }],
    panes: [
      { id: 'p1', tabId: 't1', kind: 'remote', connId: 'c1', filesOnly: true, status: 'connected' },
      { id: 'p2', tabId: 't2', kind: 'remote', connId: null },
    ],
    connections: { c1: { state: 'connected', type: 'ssh', label: 'files' } },
  });
  assert.deepEqual(liveSessions(s), [{ kind: 'ssh', name: 'files' }]);
});

test('a tmux tab is one session however many panes it draws', () => {
  const s = fakeState({
    tabs: [{ id: 't1', title: 'tmux: build' }, { id: 't2', title: 'tmux: old' }],
    panes: [
      { id: 'p1', tabId: 't1', kind: 'tmux', termId: '%1' },
      { id: 'p2', tabId: 't1', kind: 'tmux', termId: '%2' },
      // Detached: termId cleared.
      { id: 'p3', tabId: 't2', kind: 'tmux', termId: null },
    ],
  });
  assert.deepEqual(liveSessions(s), [{ kind: 'tmux', name: 'tmux: build' }]);
});

test('consoles and screens count only while connected', () => {
  const s = fakeState({
    tabs: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }],
    panes: [
      { id: 'p1', tabId: 't1', kind: 'device', termId: 'd1', status: 'connected', title: 'switch-1', deviceSpec: { kind: 'telnet' } },
      { id: 'p2', tabId: 't2', kind: 'device', termId: null, status: 'closed', title: 'usb0', deviceSpec: { kind: 'serial' } },
      { id: 'p3', tabId: 't3', kind: 'vnc', status: 'connected', title: 'kvm:5900' },
      { id: 'p4', tabId: 't4', kind: 'vnc', status: 'closed', title: 'gone:5900' },
    ],
  });
  assert.deepEqual(liveSessions(s), [
    { kind: 'telnet', name: 'switch-1' },
    { kind: 'vnc', name: 'kvm:5900' },
  ]);
});

test('closing: a tab counts its live panes, tmux and local shells do not', async () => {
  const { liveSessionsIn } = await import('../src/renderer/js/quitguard.js');
  const conns = new Map([['c1', { state: 'connected', type: 'ssh', label: 'web-1' }]]);
  const panes = new Map([
    ['p1', { id: 'p1', tabId: 't1', kind: 'remote', connId: 'c1', termId: 'x', status: 'connected' }],
    ['p2', { id: 'p2', tabId: 't1', kind: 'local', termId: 'y' }],
    ['p3', { id: 'p3', tabId: 't2', kind: 'tmux', termId: '%1' }],
  ]);
  const tabs = new Map([['t1', { id: 't1', title: 'web-1' }], ['t2', { id: 't2', title: 'tmux' }]]);
  const st = {
    getTab: (id) => tabs.get(id), getPane: (id) => panes.get(id), getConnection: (id) => conns.get(id),
    panesOf: (id) => [...panes.values()].filter((p) => p.tabId === id).map((p) => p.id),
  };
  assert.deepEqual(liveSessionsIn(st, { tabIds: ['t1'] }).map((x) => x.name), ['web-1']);
  assert.deepEqual(liveSessionsIn(st, { tabIds: ['t2'] }), []);
  assert.deepEqual(liveSessionsIn(st, { paneIds: ['p2'] }), []);
  assert.equal(liveSessionsIn(st, { paneIds: ['p1'] }).length, 1);
});
