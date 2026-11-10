import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAt, runsBetween, upcoming, describeRepeat, occurrence } from '../src/renderer/js/mxschedule.js';

const H = 3600000;
const t0 = new Date(2026, 9, 12, 9, 0).getTime();   // Mon 12 Oct 2026, 09:00 local

test('a one-off runs at its time, once', () => {
  const s = { startAt: t0, repeat: null };
  assert.equal(nextRunAt(s, t0 - H), t0);
  assert.equal(nextRunAt({ ...s, runs: 1, lastRunAt: t0 }, t0 + 1), null);
});

test('a repeat runs at the first occurrence not yet past, never before its last run', () => {
  const s = { startAt: t0, repeat: { every: 2, unit: 'hours' } };
  assert.equal(nextRunAt(s, t0 - 5), t0);
  assert.equal(nextRunAt(s, t0 + 1), t0 + 2 * H);
  assert.equal(nextRunAt(s, t0 + 5 * H), t0 + 6 * H);
  assert.equal(nextRunAt({ ...s, lastRunAt: t0 + 2 * H }, t0 + 2 * H), t0 + 4 * H);
});

test('days are counted on the calendar, so the time of day holds', () => {
  const s = { startAt: t0, repeat: { every: 1, unit: 'days' } };
  for (let i = 0; i < 60; i++) {
    const d = new Date(occurrence(s, i));
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 0);
  }
  const w = { startAt: t0, repeat: { every: 1, unit: 'weeks' } };
  assert.equal(new Date(nextRunAt(w, t0 + 1)).getDay(), new Date(t0).getDay());
});

test('a schedule ends after so many runs, or at a time', () => {
  const s = { startAt: t0, repeat: { every: 1, unit: 'hours' }, endAfter: 3 };
  assert.equal(nextRunAt(s, t0 + 1.5 * H), t0 + 2 * H);
  assert.equal(nextRunAt(s, t0 + 2.5 * H), null);
  const e = { startAt: t0, repeat: { every: 1, unit: 'hours' }, endAt: t0 + 90 * 60000 };
  assert.equal(nextRunAt(e, t0 + 1), t0 + H);
  assert.equal(nextRunAt(e, t0 + H + 1), null);
});

test('runs missed while closed are counted, and the preview lists what comes', () => {
  const s = { startAt: t0, repeat: { every: 30, unit: 'minutes' } };
  assert.equal(runsBetween(s, t0, t0 + 2 * H), 4);
  assert.equal(runsBetween({ ...s, endAfter: 2 }, t0, t0 + 2 * H), 2);
  assert.deepEqual(upcoming(s, 3, t0 + 1), [t0 + 0.5 * H, t0 + H, t0 + 1.5 * H]);
  assert.equal(describeRepeat(s), 'every 30 minutes');
  assert.equal(describeRepeat({ startAt: t0, repeat: { every: 1, unit: 'days' }, endAfter: 5 }), 'every day, 5 times');
  assert.equal(describeRepeat({ startAt: t0, repeat: null }), 'once');
});
