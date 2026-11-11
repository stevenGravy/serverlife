import { state } from './state.js';
import { status } from './ui.js';
import { hostKey } from './folders.js';

/**
 * Hosts you want to be told about when they stop existing.
 *
 * A cluster's list is the truth about what is there, which makes it useless
 * for noticing what is *not*: a node that is decommissioned, rebuilt under a
 * new id, or quietly dropped by an autoscaler simply stops being drawn, and
 * nothing anywhere says so. The row is gone, so there is no row to carry the
 * news. People find out when they go looking for the box and it is not in
 * the list — usually while trying to do something else.
 *
 * Marking a host says: keep a record of this one, and if it leaves the
 * inventory, tell me and keep drawing it. What is kept is the node's **UUID**
 * and the last thing we knew about it — its name, its address, its labels,
 * its cluster, and when it was last seen — because after it has gone the
 * cluster cannot be asked any of that, and "a host called something has
 * vanished" is not enough to act on.
 *
 * The hard part is not noticing an absence. It is not crying wolf: a cluster
 * whose certificate lapsed, a proxy that would not answer, a `tsh ls` that
 * failed — in every one of those the node is missing from a list that is
 * itself worthless. So a host is only ever declared gone off the back of a
 * *successful* read of the group it belongs to, recorded at the moment that
 * read came back.
 */

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function all() {
  return state.settings.watchedHosts || {};
}

export function isWatched(host) {
  const k = hostKey(host);
  return !!k && !!all()[k];
}

/** What we last knew about a watched host, or null. */
export function watchRecord(host) {
  return all()[hostKey(host)] || null;
}

/**
 * The same group, allowing for the address having been written differently.
 *
 * A record is filed against the group it was made in, and that key is built
 * from the proxy address — which is not as fixed as it looks. The same
 * cluster is `lab.example.com` in one profile and `lab.example.com:443` in
 * the next, and a key that drifts by a port takes every watch on that
 * cluster with it: nothing matches, so nothing is noticed and nothing is
 * drawn. Compared without the port, they are the cluster they always were.
 */
function sameGroup(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const bare = (k) => String(k).replace(/:\d+(?=$|@)/, '');
  return bare(a) === bare(b);
}

/** Every watched host filed against one group. */
export function watchedIn(groupKey) {
  return Object.values(all()).filter((w) => sameGroup(w.group, groupKey));
}

/**
 * Watched hosts that are gone and have nowhere to be drawn.
 *
 * Every ghost is drawn inside the group it belongs to, which works right up
 * until that group is not on screen: a certificate lapses and the cluster is
 * listed without its hosts, a profile is removed outright, a proxy is
 * renamed. The record survives all of that — it is kept in settings, not in
 * the cluster — but nothing was drawing it, so a machine you had asked to be
 * told about quietly stopped being mentioned. Which is the one way this
 * feature must never fail: a watch ends when the person ends it, not when
 * the place it was made in stops being listed.
 *
 * Given the groups that are actually being drawn, this is what is left over,
 * for the caller to give a home of its own.
 */
export function orphanGhosts(drawnKeys = [], now = Date.now()) {
  const drawn = [...drawnKeys].filter(Boolean);
  const after = unconfirmedAfterMs();
  const loose = Object.values(all()).filter((w) => !drawn.some((k) => sameGroup(w.group, k)));
  /*
   * Everything here belongs to a cluster that is not on screen at all —
   * logged out of, expired, removed — which means none of it can be checked
   * now and none of it can be checked until that changes.
   *
   * So none of it is reported as *gone*, whatever the record says. A verdict
   * is only worth showing while it can still be re-tested: the moment the
   * cluster cannot be read, "gone" is a claim with nothing behind it, and a
   * row asserting that a machine has been decommissioned when the honest
   * answer is "we have not been able to look since you logged out" is worse
   * than saying nothing. The mark itself is kept — it is in the record, and
   * the tooltip says what the last readable list did and did not contain —
   * so if the cluster comes back and the host really has gone, the next
   * successful read says so again.
   */
  return loose
    .filter((w) => w.missingSince || w.requestableSince || w.loggedOut || now - (w.lastSeen || 0) > after)
    .map((w) => (w.requestableSince
      // Something positive was learned about this one, and it holds while
      // the cluster is away: it is askable for — as of the last check, which
      // with the cluster off screen is as stale as any other watch here.
      ? { ...requestableGhost(w), requestUncheckedSince: requestCheckedAt(w) }
      : { ...ghostFrom(w), missing: false, unconfirmed: true }));
}

export function watchCount() {
  return Object.keys(all()).length;
}

/**
 * Whether a watched host wears its bell.
 *
 * On by default, and worth turning off: mark thirty machines and the column
 * of names grows thirty bells, which is the point at which a mark stops
 * meaning anything. The watch itself carries on either way — the message
 * when something goes, and the row that stays behind, are the part that
 * matters; the bell is only the reminder that an arrangement is in force.
 */
export function showWatchMark() {
  return state.settings.showWatchMark !== false;
}

/** Stop watching everything. For when the answer to "how many" is "too many". */
export async function forgetAll() {
  await save({});
}

/** The watched hosts that are currently missing, wherever they were. */
export function missingHosts() {
  return Object.values(all()).filter((w) => w.missingSince);
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

async function save(map) {
  state.settings = await window.api.settings.set({ watchedHosts: map });
  state.emit('folders');   // the sidebar and the hosts panes both redraw on this
}

/** Everything worth keeping about a host that may be about to disappear. */
function snapshot(host, groupKey) {
  return {
    key: hostKey(host),
    group: groupKey,
    type: host.type || 'teleport',
    // A Kubernetes cluster's watch must come back as one, ☸ and all, when it is drawn from this record.
    kind: host.kind || null,
    uuid: host.uuid || null,
    name: host.name || host.alias || '',
    hostname: host.hostname || '',
    alias: host.alias || null,
    cluster: host.cluster || null,
    proxy: host.proxy || null,
    home: host.home || null,
    addr: host.addr || '',
    tunnel: !!host.tunnel,
    labels: { ...(host.labels || {}) },
    lastSeen: Date.now(),
    missingSince: null,
  };
}

export async function setWatched(host, groupKey, on) {
  const k = hostKey(host);
  if (!k) return;
  const map = { ...all() };
  if (on) map[k] = { ...(map[k] || {}), ...snapshot(host, groupKey) };
  else delete map[k];
  await save(map);
  status(on
    ? `Watching ${host.name || host.alias} — you will be told if it leaves the inventory`
    : `No longer watching ${host.name || host.alias}`);
}

export async function toggleWatch(host, groupKey) {
  return setWatched(host, groupKey, !isWatched(host));
}

/** Stop watching, and take the record with it. */
export async function forget(key) {
  const map = { ...all() };
  delete map[key];
  await save(map);
}

/**
 * A cluster the person just logged out of — deliberately, not a read that
 * merely failed.
 *
 * `orphanGhosts` otherwise waits out `unconfirmedAfterMs` (five minutes at
 * least) before drawing a watch whose group has gone quiet, because most of
 * the time that silence is a lapsed certificate or a slow proxy and the
 * right answer is to say nothing rather than cry wolf. A logout is not that
 * kind of silence: the person just told the app, as directly as it is
 * possible to, that this cluster is gone right now. Making them wait five
 * minutes for the watch list to agree is exactly the kind of quiet this
 * feature exists to refuse.
 *
 * Marks every watch filed against the group so `orphanGhosts` draws it at
 * once, without touching `lastSeen` or `missingSince` — nothing was actually
 * re-read, so the record must not claim otherwise. Cleared the ordinary way:
 * the next successful read of the group, logged back in or not, overwrites
 * it like any other record.
 */
export async function noteLoggedOut(groupKey) {
  const map = { ...all() };
  let changed = false;
  for (const [k, w] of Object.entries(map)) {
    if (sameGroup(w.group, groupKey) && !w.loggedOut) {
      map[k] = { ...w, loggedOut: true };
      changed = true;
    }
  }
  if (changed) await save(map);
}

/* ------------------------------------------------------------------ */
/* Noticing                                                            */
/* ------------------------------------------------------------------ */

/**
 * When each group last answered with nothing at all, so a second such answer
 * can be told from the first. In memory on purpose: after a restart the
 * clock starts again, which errs towards saying less.
 */
const emptyReadAt = new Map();
const EMPTY_CORROBORATION_MS = 10 * 60000;

/** For tests, and for a group that has just been re-read properly. */
export function forgetEmptyReads(groupKey) {
  groupKey ? emptyReadAt.delete(groupKey) : emptyReadAt.clear();
}

/**
 * A group's list has just been read: update what we know, and work out what
 * has gone.
 *
 * Called only where a read actually succeeded. A host present in the list
 * has its record refreshed — the whole point of the record is that it is the
 * *last* thing that was true — and one that is absent is marked missing, but
 * only once: `missingSince` is the moment it was first noticed, not the
 * moment of the most recent poll, and it is what stops the news being
 * announced again every ten seconds.
 */
/**
 * Of the watched hosts missing from a cluster's list, which are merely out
 * of reach rather than gone?
 *
 * A node you have standing access to is in `tsh ls`. The same node, after
 * an approved request expires or a role changes, is in `tsh request search`
 * instead — unchanged, answering heartbeats, and completely absent from the
 * only list the watch used to read. Calling that "gone 2h" is the most
 * misleading thing this feature can say: the machine is fine, the access
 * is what went.
 *
 * Asked only about hosts that have just turned up missing, so a healthy
 * cluster never pays for it.
 */
async function requestableAmong(records) {
  const out = new Map();
  const groups = new Map();
  for (const w of records) {
    if (!w.uuid || !w.proxy) continue;
    const key = `${w.proxy}\u0000${w.home || ''}`;
    if (!groups.has(key)) groups.set(key, { proxy: w.proxy, home: w.home || null, items: [] });
    groups.get(key).items.push(w);
  }
  for (const g of groups.values()) {
    try {
      const { requestableIndex } = await import('./requestable.js');
      const idx = await requestableIndex({ proxy: g.proxy, home: g.home, kind: 'node' });
      // A failed search says nothing either way, and must not be read as
      // "not requestable" — that would put the wrong verdict back.
      if (idx.error) continue;
      for (const w of g.items) if (idx.byUuid.has(w.uuid)) out.set(w.key, idx.byUuid.get(w.uuid));
    } catch { /* leave them as they were */ }
  }
  return out;
}

/**
 * `partial` is a list known to be incomplete — a certificate narrowed by an
 * assumed resource request lists only what it was granted (see narrowed.js).
 * What is in it was seen; what is missing from it is not evidence of
 * anything, so nothing is concluded about the absent.
 */
export async function noteSeen(groupKey, hosts, { now = Date.now(), partial = false } = {}) {
  const watched = watchedIn(groupKey);
  if (!watched.length) return;

  /*
   * A read that came back empty is not, on its own, evidence of anything.
   *
   * The caller has already checked that `tsh ls` succeeded, which rules out
   * the proxy being down — but not every way a cluster can answer without
   * telling you anything. A role that changed, a leaf that dropped out, a
   * cluster mid-restart: each returns an empty list, successfully, and
   * "every machine you were watching left at the same moment" is never the
   * likeliest reading of that. The evidence for a host being gone is a list
   * of the ones still there with it absent from them, and an empty list is
   * not that list.
   *
   * It is not impossible either — a lab really can be torn down to nothing
   * — so the answer is corroboration rather than refusal: the first empty
   * read marks nothing and the second, ten minutes or more later, is taken
   * at its word. Anything transient is gone by then, and a cluster that is
   * genuinely empty stays empty.
   *
   * Meanwhile nothing is refreshed either, so `lastSeen` stops advancing
   * and the rows read as unchecked rather than as confirmed.
   */
  const emptyRead = !hosts || !hosts.length;
  if (partial) {
    // Leaves the corroboration clock alone: a narrowed read is neither the
    // first empty read nor the end of a run of them.
  } else if (emptyRead) {
    if (!emptyReadAt.has(groupKey)) emptyReadAt.set(groupKey, now);
  } else {
    emptyReadAt.delete(groupKey);
  }
  /*
   * Whether an empty read may *conclude* anything. It never stops the rest
   * of this function running: an empty list is weak evidence of a loss and
   * no evidence at all against the other list, and a verdict already on the
   * books has to be able to be withdrawn by something positive. That was
   * the bug — a cluster you have lost all access to answers `tsh ls` with
   * nothing, so the function returned here and a host wrongly marked gone
   * could never be corrected by discovering it was merely requestable.
   */
  const mayConclude = !emptyRead
    || (now - (emptyReadAt.get(groupKey) || now)) >= EMPTY_CORROBORATION_MS;

  const present = new Set((hosts || []).map((h) => hostKey(h)));
  const byKey = new Map((hosts || []).map((h) => [hostKey(h), h]));
  const map = { ...all() };
  const gone = [];
  const back = [];
  const askable = [];
  let changed = false;

  /*
   * Before concluding anything about the absent ones, ask the other list.
   * A host that has become requestable is not missing — it is out of reach,
   * which is a different thing to be told and a different thing to do
   * something about.
   */
  const absent = partial ? [] : watched.filter((w) => !present.has(w.key));
  const requestable = absent.length ? await requestableAmong(absent) : new Map();

  for (const w of watched) {
    if (present.has(w.key)) {
      const host = byKey.get(w.key);
      if (w.missingSince || w.requestableSince) { back.push(w); changed = true; }
      // Refreshed every read: cheap, and it keeps the record honest. A
      // logout flag from before this read is stale news the moment the
      // group answers again, the same as missingSince or requestableSince.
      map[w.key] = { ...w, ...snapshot(host, groupKey), requestableSince: null, loggedOut: false };
      changed = true;
    } else if (partial) {
      continue;
    } else if (requestable.has(w.key)) {
      // Alive, and askable. Noted once, like a disappearance, so the news
      // is not repeated at every poll — but the check itself is stamped
      // every time, as `lastSeen` is for a host in the list, so the row can
      // tell "requestable as of just now" from "requestable as of Friday".
      if (!w.requestableSince) {
        map[w.key] = { ...w, missingSince: null, requestableSince: now, requestCheckedAt: now, loggedOut: false };
        askable.push(map[w.key]);
      } else {
        map[w.key] = { ...w, missingSince: null, requestCheckedAt: now, loggedOut: false };
      }
      changed = true;
    } else if (!w.missingSince && mayConclude) {
      map[w.key] = { ...w, missingSince: now, requestableSince: null };
      gone.push(map[w.key]);
      changed = true;
    }
  }

  if (!changed) return null;
  await save(map);
  // The requestable index is the thing most likely to have moved on.
  if (askable.length) {
    import('./requestable.js').then((m) => m.invalidateRequestable()).catch(() => {});
  }
  /*
   * What changed, for the caller to announce.
   *
   * Saying it is the UI's job, not this module's: the detection runs from
   * the background poll and from two refresh paths, and a module that
   * reaches for a toast is a module that cannot be tested without a
   * browser. The caller knows whether anyone is looking.
   */
  return gone.length || back.length || askable.length ? { gone, back, askable } : null;
}

/** The sentence to show when a watched host goes, or comes back. */
export function announcement(w, kind) {
  return kind === 'gone'
    ? `${w.name} is no longer in ${w.cluster || w.group} — you were watching it`
    : `${w.name} is back in ${w.cluster || w.group}`;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

/**
 * The hosts a group should draw that are not in its list any more.
 *
 * Built from the record rather than from the cluster, because the cluster no
 * longer has anything to say about them. They are host-shaped on purpose:
 * everything downstream — folders, the filter, the hosts pane — then handles
 * them without knowing they are ghosts, and `missing` is the one flag the
 * row itself reads.
 */
export function missingIn(groupKey, present = []) {
  const here = new Set(present.map((h) => hostKey(h)));
  return watchedIn(groupKey)
    .filter((w) => w.missingSince && !w.requestableSince && !here.has(w.key))
    .map(ghostFrom);
}

/**
 * Watched hosts that are out of reach but askable for.
 *
 * Drawn like the ghosts are — from the record, since the cluster's node
 * list has nothing to say about them — but they are not ghosts: the machine
 * is there, and what has lapsed is the access to it. The row says so, and
 * offers the one thing worth doing about it.
 */
export function requestableIn(groupKey, present = [], now = Date.now()) {
  const here = new Set(present.map((h) => hostKey(h)));
  const after = unconfirmedAfterMs();
  return watchedIn(groupKey)
    .filter((w) => w.requestableSince && !here.has(w.key))
    /*
     * "Requestable" is a finding, and it ages like one. When the checks stop
     * landing — logged out, the request search failing — the row keeps its
     * req tag, since that is still the last thing known, and also says how
     * long ago that was, the same way an unchecked watch does.
     */
    .map((w) => {
      const at = requestCheckedAt(w);
      const stale = w.loggedOut || now - at > after;
      return { ...requestableGhost(w), requestUncheckedSince: stale ? at : null };
    });
}

function requestableGhost(w) {
  return { ...ghostFrom(w), missing: false, requestable: true, requestableSince: w.requestableSince };
}

/** When a requestable watch was last confirmed so. Older records only have `requestableSince`. */
function requestCheckedAt(w) {
  return w.requestCheckedAt || w.requestableSince || w.lastSeen || 0;
}

/** The tooltip for a requestable watch whose cluster has not been checked lately. */
export function requestUncheckedLine(host) {
  const at = host.requestUncheckedSince;
  return [
    'Not rechecked. The cluster could not be read, so this is the last thing known',
    'about the host, not what is true now.',
    `Last confirmed requestable ${at ? new Date(at).toLocaleString() : 'never'} (${goneFor(at)} ago)`,
    host.uuid ? `node id: ${host.uuid}` : '',
    host.cluster ? `cluster: ${host.cluster}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * A record, drawn as the host it used to be.
 *
 * Everything here comes from the last time the machine was actually seen —
 * the name it answered to, its hostname, its address, its labels, the
 * cluster it was in. None of it can be asked for any more, which is why it
 * was written down while it could be, and why nothing overwrites it once the
 * host has gone.
 */
function ghostFrom(w) {
  return {
    id: `missing:${w.key}`,
    type: w.type,
    // Records from before the kind was kept: a kube cluster's key says what it is.
    kind: w.kind || (String(w.key || '').startsWith('kube:') ? 'kube' : undefined),
    missing: true,
    watchKey: w.key,
    group: w.group,
    missingSince: w.missingSince,
    lastSeen: w.lastSeen,
    name: w.name,
    hostname: w.hostname,
    alias: w.alias,
    uuid: w.uuid,
    cluster: w.cluster,
    proxy: w.proxy,
    home: w.home,
    addr: w.addr,
    tunnel: w.tunnel,
    labels: w.labels || {},
  };
}

/**
 * A watch nobody can currently answer.
 *
 * "Gone" is a conclusion, and it is only ever drawn from a successful read.
 * That leaves a third state the app used to say nothing at all about: the
 * cluster could not be read — logged out, certificate lapsed, proxy down,
 * the machine asleep all weekend — so a watched host is neither confirmed
 * there nor known to have left. Saying nothing is the one wrong answer,
 * because a list of watched hosts with no marks on it reads as "all
 * present" when what it actually means is "nobody has checked since
 * Friday".
 *
 * A host qualifies when no successful read has covered it for a good while:
 * it is not in the list in front of us, it has not been judged missing, and
 * the last time it was actually seen is older than several polls. The last
 * part is what keeps this quiet in normal running — a cluster read every
 * thirty seconds confirms its hosts long before this trips — and what makes
 * it fire exactly when reads have stopped landing.
 */
export function unconfirmedAfterMs() {
  const secs = Number(state.settings?.nodeRefreshSeconds);
  const poll = Number.isFinite(secs) && secs > 0 ? secs : 30;
  // Six missed reads, and never less than five minutes: long enough that a
  // slow cluster or a paused window is not called a problem.
  return Math.max(5 * 60000, poll * 6000);
}

export function unconfirmedIn(groupKey, present = [], now = Date.now()) {
  const here = new Set(present.map((h) => hostKey(h)));
  const after = unconfirmedAfterMs();
  return watchedIn(groupKey)
    /*
     * A host known to be requestable is not unchecked: it has been looked
     * at, and the answer was "alive, out of reach". Without this it is both
     * at once and the list draws it twice — the same machine, once as a
     * thing you can ask for and once as a thing nobody has checked.
     */
    .filter((w) => !w.missingSince && !w.requestableSince
      && !here.has(w.key) && (w.loggedOut || now - (w.lastSeen || 0) > after))
    .map((w) => ({ ...ghostFrom(w), missing: false, unconfirmed: true }));
}

/** The tooltip for a host nobody has been able to check. */
export function unconfirmedLine(host) {
  const when = host.lastSeen ? new Date(host.lastSeen).toLocaleString() : 'never';
  return [
    'Not confirmed. The cluster it is in could not be read, so this says nothing',
    'about the host itself — only that nobody has been able to look.',
    `Last confirmed ${when} (${goneFor(host.lastSeen)} ago)`,
    /*
     * What the last list we could actually read had to say. Kept as a note
     * rather than a verdict: it may well be why you are looking, and it is
     * no longer something the app can stand behind.
     */
    host.missingSince
      ? `It was absent from the last list that could be read (${new Date(host.missingSince).toLocaleString()}).`
      : '',
    host.uuid ? `node id: ${host.uuid}` : '',
    host.cluster ? `cluster: ${host.cluster}` : '',
  ].filter(Boolean).join('\n');
}

/** "3 minutes", "2 days" — how long something has been gone. */
export function goneFor(ms) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 90) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The tooltip for a host that is not there any more.
 *
 * Everything the cluster can no longer be asked, written down while it
 * could be: what it was called, where it was, what it was labelled. This is
 * the whole return on having watched it — a row saying something has gone
 * is a fact you can do nothing with, and "it was 10.0.4.9, in staging,
 * labelled env=prod, last seen at nine this morning" is a place to start.
 */
export function missingLine(host) {
  const when = new Date(host.lastSeen || host.missingSince).toLocaleString();
  const labels = Object.entries(host.labels || {})
    .filter(([k]) => !k.startsWith('teleport.internal/'))
    .map(([k, v]) => `${k}=${v}`);
  return [
    `Not in the inventory. You asked to be told about this one.`,
    `Last seen ${when} (${goneFor(host.missingSince)} ago)`,
    host.hostname && host.hostname !== host.name ? `hostname: ${host.hostname}` : '',
    host.uuid ? `node id: ${host.uuid}` : '',
    host.addr ? `last address: ${host.addr}` : '',
    host.cluster ? `cluster: ${host.cluster}${host.proxy ? ` (${host.proxy})` : ''}` : '',
    labels.length ? `labels: ${labels.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}
