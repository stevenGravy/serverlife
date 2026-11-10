import { state, tpKey } from './state.js';

/**
 * What a cluster would let you ask for, by node id.
 *
 * Two lists describe a Teleport cluster and they do not overlap: `tsh ls` is
 * what you can reach, and `tsh request search` is what you could ask to
 * reach. A node moves between them without changing in any way — an
 * approved request expires, a role is edited — and the move looks, to
 * anything watching only the first list, exactly like the machine being
 * decommissioned.
 *
 * That is not a hypothetical. It is why a watched host said "gone 2h" while
 * it was sitting there answering heartbeats, waiting to be requested.
 *
 * So absence from one list is never a verdict on its own: it is a reason to
 * look at the other. This is the other one, kept behind a short cache
 * because a check that fires per watched host would otherwise be a `tsh`
 * invocation per host per poll.
 */

const TTL_MS = 60000;

/* key -> { at, byUuid: Map(uuid -> resource), error } */
const cache = new Map();

function keyOf({ proxy, home, kind }) {
  return `${proxy || ''}\u0000${home || ''}\u0000${kind || 'node'}`;
}

/** Forget what was cached, so the next question asks the cluster again. */
export function invalidateRequestable(where = null) {
  if (!where) { cache.clear(); return; }
  cache.delete(keyOf(where));
}

/**
 * The requestable resources of one cluster and kind, indexed by the id that
 * identifies a node for its whole life — the UUID. Names are not that: two
 * nodes can share one, and a rebuilt node keeps its name and loses its id.
 *
 * Returns an empty index on failure rather than throwing. Callers use this
 * to *soften* a conclusion ("it is not gone, it is requestable"), so a
 * failed lookup must leave them where they were rather than take the
 * decision for them.
 */
export async function requestableIndex({ proxy, home = null, kind = 'node', force = false } = {}) {
  const key = keyOf({ proxy, home, kind });
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit;

  const entry = { at: Date.now(), byUuid: new Map(), error: null };
  try {
    const r = await window.api.teleport.requestSearch({ proxy, home, kind });
    if (r?.ok) {
      for (const x of r.resources || []) {
        if (x.uuid) entry.byUuid.set(x.uuid, x);
        // Apps and databases are named rather than identified by a UUID, and
        // for those the name *is* the id the cluster uses.
        if (x.name && !entry.byUuid.has(x.name)) entry.byUuid.set(x.name, x);
      }
    } else {
      entry.error = r?.error || 'request search failed';
    }
  } catch (e) {
    entry.error = e.message;
  }
  cache.set(key, entry);
  return entry;
}

/** Is this node requestable on its cluster right now? */
export async function isRequestable({ uuid, proxy, home = null, kind = 'node' }) {
  if (!uuid) return false;
  const idx = await requestableIndex({ proxy, home, kind });
  return idx.byUuid.has(uuid);
}

/**
 * The other direction, and free: whether a resource is in the inventory this
 * window already holds. No call, no cache — the node lists are read on a
 * timer for the host list anyway, and a monitored resource that has
 * reappeared there has not gone missing, it has become reachable.
 */
export function inInventory(uuid, { proxy, home = null } = {}) {
  if (!uuid) return null;
  for (const p of state.teleportProfiles || []) {
    if ((p.proxy || '') !== (proxy || '')) continue;
    if ((p.homeDir || null) !== (home || null)) continue;
    const nodes = state.teleportNodes.get(tpKey(p));
    // No list for that profile is "cannot say", not "not there" — the
    // caller must not read a cluster that has never been read as an answer.
    if (!nodes) return null;
    return nodes.some((n) => n.uuid === uuid || n.name === uuid);
  }
  return null;
}

/**
 * The requestable resources of a cluster, shaped like hosts.
 *
 * Host-shaped on purpose, as the ghosts are: once a row carries a name, a
 * uuid, labels and a cluster, everything downstream handles it without
 * knowing what it is — the filter matches it, a folder rule claims it, it
 * can be dragged into a folder by hand, and it sorts with the rest. The one
 * flag that differs is `requestable`, which the row reads to draw its tag
 * and to decide what a double-click means.
 *
 * Nothing here is reachable: these are machines you would have to ask for.
 * They are offered because the question "what could I get at?" is asked of
 * the same list as "what have I got", and answering it somewhere else means
 * keeping two arrangements of the same cluster in your head.
 */
export async function requestableHosts({ proxy, home = null, cluster = '', kind = 'node', force = false } = {}) {
  const idx = await requestableIndex({ proxy, home, kind, force });
  const out = [];
  for (const r of new Set(idx.byUuid.values())) {
    out.push({
      id: `req:${r.id}`,
      type: 'teleport',
      requestable: true,
      resourceId: r.id,
      kind: r.kind || kind,
      name: r.name || r.uuid,
      hostname: r.name || '',
      uuid: r.uuid || r.name,
      cluster: r.cluster || cluster,
      proxy,
      home,
      labels: { ...(r.labels || {}) },
      addr: '',
      tunnel: false,
    });
  }
  /*
   * A node marked "needs MFA" ahead of its grant is still marked — the row
   * just carries `req:...` as its own id, which is not the id the mark was
   * filed under (see `inventoryNodeIds`). Worked out once per list here, so
   * the mfa tag draws without every row doing its own round trip.
   */
  const nodeRows = out.filter((h) => h.kind === 'node' && h.uuid);
  if (nodeRows.length) {
    try {
      const ids = await window.api.teleport.inventoryNodeIds({
        items: nodeRows.map((h) => ({ id: h.resourceId, cluster: h.cluster, uuid: h.uuid })),
        home,
      });
      for (const h of nodeRows) h.mfaId = ids[h.resourceId] || '';
    } catch { /* the row just won't show the mfa tag this time */ }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base', numeric: true }));
  return { hosts: out, error: idx.error };
}
