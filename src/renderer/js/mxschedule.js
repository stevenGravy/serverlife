/**
 * When a scheduled multi-exec runs: the arithmetic, kept apart from the
 * dock so it can be tested.
 *
 * A schedule is a first run (`startAt`, ms) and, optionally, a repeat —
 * every `every` minutes, hours, days or weeks — that ends never, after
 * `endAfter` runs, or at `endAt`. Days and weeks are counted on the calendar,
 * so "every day at 09:00" stays at 09:00 across a change of clocks; minutes
 * and hours are counted in elapsed time.
 */

export const UNITS = { minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 };

/** The `i`th run of a schedule (0 is the first), as ms. */
export function occurrence(s, i) {
  const r = s.repeat;
  if (!r || i === 0) return s.startAt;
  const n = Math.max(1, Math.floor(Number(r.every)) || 1);
  if (r.unit === 'days' || r.unit === 'weeks') {
    const d = new Date(s.startAt);
    d.setDate(d.getDate() + i * n * (r.unit === 'weeks' ? 7 : 1));
    return d.getTime();
  }
  return s.startAt + i * n * (UNITS[r.unit] || UNITS.hours);
}

/** Whether the `i`th run is still within the schedule's end. */
function withinEnd(s, i, at) {
  if (s.endAfter && i >= s.endAfter) return false;
  if (s.endAt && at > s.endAt) return false;
  return true;
}

/** The index of the first run at or after `t`. */
function firstIndexFrom(s, t) {
  if (!s.repeat || t <= s.startAt) return 0;
  const n = Math.max(1, Math.floor(Number(s.repeat.every)) || 1);
  const approx = n * (UNITS[s.repeat.unit] || UNITS.hours);
  let i = Math.max(0, Math.floor((t - s.startAt) / approx) - 2);
  while (occurrence(s, i) < t) i++;
  return i;
}

/**
 * The next run at or after `now`, or null when there is none left. A
 * schedule that has run `runs` times never goes back to one before its last.
 */
export function nextRunAt(s, now = Date.now()) {
  if (!s.repeat) return (s.runs || 0) > 0 ? null : s.startAt;
  const from = Math.max(now, s.lastRunAt ? s.lastRunAt + 1 : 0);
  const i = firstIndexFrom(s, from);
  const at = occurrence(s, i);
  return withinEnd(s, i, at) ? at : null;
}

/** How many runs fell between `from` (inclusive) and `to` (exclusive). */
export function runsBetween(s, from, to) {
  if (to <= from) return 0;
  if (!s.repeat) return s.startAt >= from && s.startAt < to ? 1 : 0;
  let n = 0;
  for (let i = firstIndexFrom(s, from); n < 10000; i++) {
    const at = occurrence(s, i);
    if (at >= to || !withinEnd(s, i, at)) break;
    n++;
  }
  return n;
}

/** The next `count` runs from `now`, for a preview. */
export function upcoming(s, count = 3, now = Date.now()) {
  const out = [];
  let i = firstIndexFrom(s, now);
  if (!s.repeat) return s.startAt >= now ? [s.startAt] : [];
  while (out.length < count) {
    const at = occurrence(s, i);
    if (!withinEnd(s, i, at)) break;
    out.push(at);
    i++;
  }
  return out;
}

/** "every 2 hours, 10 times" — the repeat in words. */
export function describeRepeat(s) {
  if (!s.repeat) return 'once';
  const n = Math.max(1, Math.floor(Number(s.repeat.every)) || 1);
  const unit = n === 1 ? s.repeat.unit.replace(/s$/, '') : s.repeat.unit;
  const every = n === 1 ? `every ${unit}` : `every ${n} ${unit}`;
  const end = s.endAfter ? `, ${s.endAfter} time${s.endAfter === 1 ? '' : 's'}`
    : s.endAt ? `, until ${new Date(s.endAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  return every + end;
}

/** A time the way a person reads one: "Mon 12 Oct, 09:00". */
export function fmtWhen(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** A Date as the value of an <input type="datetime-local">. */
export function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
