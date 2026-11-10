import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSettings } from './helpers.mjs';

fakeSettings({});
const PC = await import('../src/renderer/js/paneclose.js');
const { state } = await import('../src/renderer/js/state.js');

/**
 * paneclose.js is almost entirely DOM manipulation (moving the real pane
 * node into an overlay, animating it) which is out of scope here by the
 * same rule as every other renderer test — but the registry itself, and
 * the on/off decision, are pure enough to pin down directly.
 */

test('there really are at least thirty animations, and no two share a name', () => {
  const names = PC.animationNames();
  assert.ok(names.length >= 30, `only ${names.length} registered`);
  assert.equal(new Set(names).size, names.length, 'a repeated name means two entries collide');
});

test('on by default; the setting and nothing else turns it off', () => {
  state.settings = {};
  assert.equal(PC.shouldAnimatePaneClose(), true);
  state.settings = { paneCloseAnimations: false };
  assert.equal(PC.shouldAnimatePaneClose(), false);
  state.settings = { paneCloseAnimations: true };
  assert.equal(PC.shouldAnimatePaneClose(), true);
  // Explicitly true or just absent both mean "on" — only `false` turns it off.
  state.settings = { paneCloseAnimations: undefined };
  assert.equal(PC.shouldAnimatePaneClose(), true);
});
