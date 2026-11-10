import { state, tpKey } from './state.js';
import { observe, heartbeatSignature } from './heartbeat.js';
import { groupKeyFor } from './folders.js';
import { noteSeen } from './watch.js';
import { isNarrowed, noteRead } from './narrowed.js';

/**
 * Teleport node lists, kept current in the background.
 *
 * A cluster's inventory changes while you are looking at it: a node is added,
 * an agent restarts and its labels move, a machine goes away. Before this the
 * list was whatever it was at launch, or at the last time somebody pressed
 * Refresh — so a host that appeared two minutes ago was not there to click,
 * and one that had gone was still offering to connect.
 *
 * Alongside them, whether each cluster's certificate is still good. `expired`
 * is worked out at the moment `tsh status` is parsed, so a cached profile's
 * flag is only as true as when it was read: a certificate with an hour left
 * is recorded as live and is still recorded as live an hour later, with every
 * list offering to connect to a cluster that will refuse. The check runs in
 * both directions, because the other half is a `tsh login` done in a terminal
 * — a cluster marked expired that is not one any more.
 *
 * This is deliberately only those two things. A full inventory sweep re-reads
 * the ssh configs, the trusted clusters, beams, requests, macros and S3
 * targets, and redraws the sidebar whatever it found; doing all of that every
 * few seconds would cost far more than it answers and would fight with
 * whatever you were doing in the list.
 */

/** Ten seconds. Frequent enough to feel live, and it is one `tsh ls` a cluster. */
const DEFAULT_SECONDS = 10;

let timer = null;
let inFlight = false;

/** How often to look, in seconds. 0 turns it off. */
export function refreshInterval() {
  const v = state.settings?.nodeRefreshSeconds;
  return v === undefined || v === null ? DEFAULT_SECONDS : Math.max(0, Number(v) || 0);
}

/**
 * What the list *is*, cheaply comparable.
 *
 * The sidebar is only redrawn when this changes, because a redraw on a timer
 * closes menus, loses a half-typed filter and makes the list twitch. Names,
 * addresses and labels are in it, since a label moving is exactly the kind of
 * change somebody is watching for.
 *
 * Heartbeat ages are in it too, but only the ones being drawn: an overdue
 * node's badge counts minutes and has to keep up, and so does every node's
 * once the ages are switched on, while a healthy node nobody is asking about
 * changes every second and must not make the list twitch.
 */
function signature(nodes) {
  return (nodes || []).map((n) => [
    n.id, n.name, n.addr, n.tunnel ? 't' : '',
    Object.entries(n.labels || {}).sort().map(([k, v]) => k + '=' + v).join(','),
  ].join('\u0001')).join('\u0002') + '\u0003' + heartbeatSignature(nodes);
}

/**
 * The signature each cluster was last drawn with.
 *
 * Comparing an incoming list against a freshly computed signature of the
 * stored one is enough while a signature is a pure function of the nodes, but
 * staleness is a function of the clock as well: the same unchanged list means
 * something different a minute later, and recomputing both sides at the same
 * instant would find them equal and never redraw. So what was last shown is
 * remembered rather than re-derived.
 */
const lastSig = new Map();

/**
 * What the window draws about a profile, cheaply comparable. Expiry is in it,
 * and so are the assumed requests, since those change what the roles allow.
 */
function profileSignature(profiles) {
  return (profiles || []).map((p) => [
    tpKey(p), p.username, p.validUntil, p.expired ? 'x' : '', p.active ? 'a' : '',
    (p.activeRequests || []).join(','),
  ].join('|')).join(';');
}

/**
 * Expiry from the clock alone, without asking tsh anything.
 *
 * The moment a certificate lapses is known in advance — `validUntil` is
 * already on the profile — so this needs no subprocess and cannot fail. It
 * only ever moves a profile *into* expiry, which is the direction arithmetic
 * can settle; coming back is a new certificate, and only tsh knows about
 * that.
 */
function markExpiredByClock() {
  let changed = false;
  for (const p of state.teleportProfiles || []) {
    if (!p.validUntil) continue;
    const expired = new Date(p.validUntil).getTime() < Date.now();
    if (expired !== !!p.expired) { p.expired = expired; changed = true; }
  }
  return changed;
}

/**
 * Re-read `tsh status`.
 *
 * This is what catches a cluster that is *no longer* expired: someone runs
 * `tsh login` in a terminal, or the app's own login finishes, and the window
 * should stop saying the certificate has lapsed. It reads the files under
 * TELEPORT_HOME and asks the cluster nothing, so it is a local read rather
 * than a round trip.
 *
 * A read that fails leaves the profiles alone. `tsh` briefly unavailable, or
 * a home being rewritten as a login completes, must not empty the sidebar and
 * disconnect nothing — a list a few seconds out of date is the better wrong
 * answer.
 */
export async function refreshProfiles() {
  let res;
  try { res = await window.api.teleport.status(); } catch { return false; }
  if (!res || !Array.isArray(res.profiles)) return false;
  // An error with no profiles is "could not read", not "logged out of
  // everything"; the difference matters because one of them is a lie.
  if (res.error && !res.profiles.length && (state.teleportProfiles || []).length) return false;
  if (profileSignature(res.profiles) === profileSignature(state.teleportProfiles)) return false;

  state.teleportProfiles = res.profiles;
  state.tshInfo = res.tsh || state.tshInfo;
  state.teleportError = res.loggedIn ? null : (res.error || 'Not logged in to Teleport');
  return true;
}

/**
 * Re-read every live profile's nodes.
 *
 * Failures are per cluster and silent — a proxy that will not answer should
 * cost a stale list, not an error toast every ten seconds — and, importantly,
 * a failed read leaves the *previous* list alone rather than emptying the
 * cluster. A blink to "no nodes" and back is worse than a list a few seconds
 * out of date.
 */
export async function refreshNodes({ emit = true } = {}) {
  const live = (state.teleportProfiles || []).filter((p) => !p.expired);
  if (!live.length) return false;

  let changed = false;
  await Promise.all(live.map(async (p) => {
    const key = tpKey(p);
    try {
      const r = await window.api.teleport.nodes({ proxy: p.proxy, cluster: p.cluster, home: p.homeDir });
      if (!r.ok) return;
      // Before the signature, which asks how stale each node is and needs the
      // cluster's announce TTL to answer.
      observe(key, r.nodes);
      /*
       * The same read answers "what has gone?" for anything being watched.
       * Announced from here rather than left to the redraw: a node that
       * disappears stops being drawn, so there is no row left to carry the
       * news, which is the entire reason the watch exists.
       */
      noteRead(p, r.nodes);
      const change = await noteSeen(groupKeyFor(p), r.nodes, { partial: isNarrowed(p) });
      if (change) (await import('./sidebar.js')).announceWatch(change);
      const before = lastSig.has(key) ? lastSig.get(key) : signature(state.teleportNodes.get(key));
      const now = signature(r.nodes);
      state.teleportNodes.set(key, r.nodes);
      if (now === before) return;
      lastSig.set(key, now);
      changed = true;
    } catch { /* keep what we had */ }
  }));

  if (changed && emit) state.emit('inventory');
  return changed;
}

/**
 * Start the loop, or restart it after the interval was changed in Settings.
 *
 * Nothing runs while the window is hidden, while a full inventory load is
 * already in progress, or while the previous pass is still out — a slow proxy
 * must not queue up a second `tsh ls` behind the first.
 */
export function startNodeLoop() {
  stopNodeLoop();
  const seconds = refreshInterval();
  if (!seconds) return;
  timer = setInterval(async () => {
    if (document.hidden || inFlight || state.loadingInventory) return;
    inFlight = true;
    try {
      /*
       * Expiry first, and nodes after it. A cluster that has just come back
       * should have its nodes read in the same pass rather than ten seconds
       * later, and one that has just lapsed should not be asked for them at
       * all — `tsh ls` on a dead certificate is a prompt or an error, and
       * neither belongs in a background poll.
       */
      const byClock = markExpiredByClock();
      const byStatus = await refreshProfiles();
      // One redraw for the tick, whichever parts of it found something.
      const nodes = await refreshNodes({ emit: false });
      if (byClock || byStatus || nodes) state.emit('inventory');
    } catch { /* each part already keeps what it had */ }
    finally { inFlight = false; }
  }, seconds * 1000);
}

export function stopNodeLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
