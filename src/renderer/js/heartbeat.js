import { state, tpKey } from './state.js';

/**
 * How long ago a node last said anything, and whether that is long enough to
 * be worth a warning.
 *
 * A Teleport node is in the inventory because its agent keeps announcing it.
 * The cluster does not publish a "last seen" time; what it publishes is
 * `metadata.expires`, the moment it will give up on the node if nothing more
 * arrives. Each heartbeat pushes that a full announce-TTL into the future, so
 *
 *     age = TTL - (expires - now)
 *
 * and a node that heartbeated a second ago has nearly the whole TTL left
 * while one that died four minutes ago is four minutes short of it.
 *
 * This matters because the list lies by omission. A node whose agent has
 * stopped looks exactly like a healthy one — same row, same labels, still
 * offering to connect — right up until the expiry passes and it vanishes
 * without ever having looked wrong. The window between the last heartbeat and
 * that disappearance is usually ten or fifteen minutes, and it is the only
 * chance to see an agent dying rather than to notice afterwards that it is
 * gone. A session opened into that window does not fail quickly; it hangs on
 * a proxy waiting for a tunnel nobody is on the other end of.
 *
 * The TTL itself is not in the output, and it is not the same everywhere —
 * it has been ten minutes and it has been fifteen, and a cluster can be
 * configured away from either. So it is inferred rather than assumed: see
 * `observe`.
 */

/** Minutes of silence before a node is called stale. 0 turns the warning off. */
const DEFAULT_MINUTES = 2;

/**
 * The announce TTL each cluster appears to use, in milliseconds, keyed the way
 * the node lists are.
 *
 * Kept for the life of the window rather than persisted: it is re-learned
 * within one refresh of opening the app, and a stored value would outlive the
 * configuration it was learned from.
 */
const ttls = new Map();

/**
 * When each cluster's list was last actually read.
 *
 * Without this the age is computed against the wall clock, and the wall
 * clock keeps going when the reading stops — the background poll pauses
 * while the window is hidden, it can be switched off in Settings, and a
 * proxy that will not answer leaves the previous list in place on purpose.
 * Any of those and a list that was correct at the time silently ages into
 * "every node in this cluster has gone quiet", which is both wrong and
 * exactly the alarming kind of wrong. The age is therefore worked out as of
 * the moment the list was read, and past a grace period it is not worked out
 * at all: not looking is not the same as nobody answering.
 */
const seenAt = new Map();

/** How old a list may be before it can no longer be judged, in ms. */
function grace() {
  const secs = Number(state.settings?.nodeRefreshSeconds) || 0;
  // Three polls of slack, and never less than ninety seconds — a single
  // slow `tsh ls` must not put the whole cluster in doubt.
  return Math.max(90000, secs * 3000);
}

/** The node list key for a node, matching the one its cluster is stored under. */
function keyFor(node) {
  return tpKey({ cluster: node.cluster, proxy: node.proxy, home: node.home });
}

/**
 * Learn a cluster's announce TTL from the list itself.
 *
 * The freshest node in a cluster has just heartbeated, so its remaining time
 * is the TTL, give or take the gap since the last poll — and every other node
 * is somewhere below it. Taking the maximum across the cluster therefore
 * reads the TTL off the healthy majority, which is exactly the population that
 * can be trusted to know it. It is rounded up to the next minute to absorb
 * the sampling gap, and only ever raised, because a single pass in which
 * every node happens to be mid-cycle would otherwise lower the ceiling and
 * make the whole cluster look fresher than it is.
 *
 * The failure mode is deliberately one-sided. Under-estimating the TTL (a
 * cluster with one node, which may be observed at any point in its cycle)
 * makes ages read low and warnings arrive late or not at all; over-estimating
 * it would invent staleness that is not there. Late is the tolerable half.
 */
export function observe(key, nodes) {
  const now = Date.now();
  // The read itself is the fact worth recording, whatever was in it: an
  // empty cluster that answered is still a cluster we have just looked at.
  seenAt.set(key, now);
  let max = 0;
  for (const n of nodes || []) {
    if (!n.expires) continue;
    max = Math.max(max, n.expires - now);
  }
  if (max <= 0) return;
  const ttl = Math.ceil(max / 60000) * 60000;
  if (ttl > (ttls.get(key) || 0)) ttls.set(key, ttl);
}

/**
 * Milliseconds since this node last heartbeated, or null when that is not a
 * question this node answers: anything without an expiry (an agentless host,
 * one registered with no TTL) and anything on a cluster whose TTL has not been
 * worked out yet.
 */
export function heartbeatAge(node) {
  if (!node || node.type !== 'teleport' || !node.expires) return null;
  const key = keyFor(node);
  const ttl = ttls.get(key);
  if (!ttl) return null;
  const read = seenAt.get(key);
  if (!read || Date.now() - read > grace()) return null;
  // Against the moment the list was read, not against now — see `seenAt`.
  // Clamped: a node read at the very moment it re-announced can sit a few
  // hundred milliseconds "in the future" of the learned ceiling.
  return Math.max(0, ttl - (node.expires - read));
}

/** Silence past which a node is called stale, in ms. 0 means never. */
export function staleAfter() {
  const v = state.settings?.staleNodeMinutes;
  const m = v === undefined || v === null ? DEFAULT_MINUTES : Number(v) || 0;
  return Math.max(0, m) * 60000;
}

/** Whether every node's row spells out how long ago it last checked in. */
export function showHeartbeats() { return !!state.settings?.showHeartbeats; }

/**
 * What the host list is doing about the nodes that have gone quiet:
 *
 *   all    every node, quiet ones marked where they stand
 *   hide   only the ones still answering
 *   only   only the quiet ones, which is the list you want when something
 *          has just taken a rack or a subnet with it
 */
export function quietFilter() {
  const v = state.settings?.quietNodeFilter;
  return v === 'hide' || v === 'only' ? v : 'all';
}

/**
 * How long ago, to the minute.
 *
 * Minutes rather than seconds on purpose: the list is rebuilt to change this
 * text, and a rebuild loses the scroll position and closes anything open over
 * it. A badge counting seconds would do that every few seconds for as long as
 * the mode is on. The tooltip carries the exact figure, which is where the
 * question "did it just check in?" is actually answered.
 */
/*
 * How a heartbeat's time reads on a row — SSH and Kubernetes alike.
 * Settings → Heartbeat times: "relative" (the default: <1m, 2m, 1h 5m) or
 * "exact" (the clock time it was heard, 14:32:05). The tooltip always gives
 * the exact time. `at` is when the heartbeat happened, in ms.
 */
export const exactHeartbeats = () => state.settings?.heartbeatStyle === 'exact';
export function beatClock(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function beatText(at, now = Date.now()) {
  if (exactHeartbeats()) return beatClock(at);
  const mins = Math.floor(Math.max(0, now - at) / 60000);
  if (mins < 1) return '<1m';
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** When a node's last heartbeat happened (ms), or null — its age is as of the moment its list was read. */
export function heartbeatAt(node) {
  const age = heartbeatAge(node);
  if (age === null) return null;
  return (seenAt.get(keyFor(node)) || Date.now()) - age;
}

export function ageLabel(node) {
  const at = heartbeatAt(node);
  if (at === null) return '';
  // Relative to the read, as the age always has been.
  return beatText(at, seenAt.get(keyFor(node)) || Date.now());
}

/** Is this node overdue, by the user's own definition of overdue? */
export function isStale(node) {
  const limit = staleAfter();
  if (!limit) return false;
  const age = heartbeatAge(node);
  return age !== null && age >= limit;
}

/** "7m", "1h 4m" — the age as a badge, or '' for a node that is not stale. */
export function staleLabel(node) {
  if (!isStale(node)) return '';
  const at = heartbeatAt(node);
  if (at === null) return '';
  if (exactHeartbeats()) return beatClock(at);
  const mins = Math.floor((heartbeatAge(node) || 0) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * The tooltip's version: the same fact spelled out, plus what follows from it.
 * Returned for any node that has an age, stale or not, because "last
 * heartbeat: 20 seconds ago" is the reassuring half of the same answer.
 */
export function heartbeatLine(node) {
  const age = heartbeatAge(node);
  if (age === null) return '';
  const mins = Math.floor(age / 60000);
  const when = (mins < 1 ? `${Math.floor(age / 1000)}s ago` : staleAgeText(mins)) + `, at ${beatClock(heartbeatAt(node))}`;
  if (!isStale(node)) return `last heartbeat: ${when}`;
  const ttl = ttls.get(keyFor(node)) || 0;
  const left = Math.max(0, Math.round((node.expires - (seenAt.get(keyFor(node)) || Date.now())) / 60000));
  return `last heartbeat: ${when} — the agent may be gone.\n`
    + `The cluster drops a node ${Math.round(ttl / 60000)} minutes after its last heartbeat; `
    + `this one has ${left} minute${left === 1 ? '' : 's'} left.`;
}

function staleAgeText(mins) {
  return mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'} ago`
    : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

/**
 * The part of a node's heartbeat worth redrawing for.
 *
 * Folded into the signature the refresh loop compares against, so a node
 * crossing into "quiet" repaints the list and so does each further minute of
 * it — but while nothing is being shown about a healthy node, its age changes
 * constantly, means nothing, and must not make the sidebar twitch. With the
 * ages on show every node counts, and the list then rebuilds once a minute:
 * that is the price of the mode, and the reason the badge is in minutes.
 */
export function heartbeatSignature(nodes) {
  const everyone = showHeartbeats();
  if (!everyone && !staleAfter()) return '';
  return (nodes || []).map((n) => {
    const age = everyone || isStale(n) ? heartbeatAge(n) : null;
    return age === null ? '' : n.id + ':' + Math.floor(age / 60000);
  }).join('');
}
