import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeSettings } from './helpers.mjs';

const store = fakeSettings({});
const { state } = await import('../src/renderer/js/state.js');
state.settings = store;

/**
 * Focus and the active tab.
 *
 * Focusing a pane makes its tab the active one — except for a pane that is in
 * no tab at all, an assistant in the AI panel. That one used to set the active
 * tab to none, and closing the panel then drew none: a blank workspace.
 */

const tab = state.createTab({ title: 'web-1', kind: 'remote', connId: 'c1' });
const other = state.createTab({ title: 'db-1', kind: 'remote', connId: 'c2' });
state.addPane({ id: 'p-web', tabId: tab.id });
state.addPane({ id: 'p-db', tabId: other.id });
state.addPane({ id: 'p-ai', tabId: null });

test('focusing a pane in a tab makes that tab active', () => {
  state.setActivePane('p-web');
  assert.equal(state.activeTabId, tab.id);
  state.setActivePane('p-db');
  assert.equal(state.activeTabId, other.id);
});

test('focusing an assistant pane leaves the active tab where it was', () => {
  state.setActivePane('p-web');
  state.setActivePane('p-ai');
  assert.equal(state.activePaneId, 'p-ai', 'it does take the focus');
  assert.equal(state.activeTabId, tab.id, 'but the tab on screen stays the tab on screen');
});

test('and coming back from it lands on that tab again', () => {
  state.setActivePane('p-ai');
  state.setActivePane('p-web');
  assert.equal(state.activeTabId, tab.id);
  assert.equal(state.getTab(tab.id).lastPaneId, 'p-web');
});
