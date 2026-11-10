import { tpKey } from './state.js';

/**
 * A cluster seen through an assumed resource request.
 *
 * Assuming a request for particular resources does not add them to what you
 * had: it narrows the certificate to exactly those, and nothing else. `tsh
 * ls` then lists the one node you asked for, and every other machine on the
 * cluster drops out of the list — still there, still running, just out of
 * reach until the request is dropped.
 *
 * Read as an inventory, that list says everything else has gone. The watch
 * said exactly that, at the next poll; the sidebar emptied out to one row.
 * Neither is true, so a narrowed list is treated as what it is — a partial
 * view: what is in it was seen, and what is missing from it says nothing.
 * The last full list is remembered so the rest can still be drawn, dimmed,
 * for as long as the request is in force.
 *
 * The same record serves a second, unrelated reason to distrust a list:
 * the cluster it came from has since logged out or expired, not narrowed
 * anything. `lastFullReadFor` reads it for that case — see Settings →
 * "Show the last known hosts" — which is why a timestamp travels with it
 * now and not just the nodes.
 */

/** Whether this profile's certificate is limited to particular resources. */
export function isNarrowed(p) {
  return !!(p && (p.allowedResources || []).length);
}

/** The last list read without a request narrowing it, per profile: `{ nodes, at }`. */
const full = new Map();

/** Record a successful read. Only an un-narrowed one stands for the whole cluster. */
export function noteRead(p, nodes) {
  if (!isNarrowed(p)) full.set(tpKey(p), { nodes: nodes || [], at: Date.now() });
}

const idOf = (n) => n.uuid || n.id || n.name;

/**
 * The machines the request is keeping out of the list: what the last full
 * read had that this one does not, marked so the row can say why.
 */
export function heldBackFor(p, reachable) {
  if (!isNarrowed(p)) return [];
  const have = new Set((reachable || []).map(idOf));
  return (full.get(tpKey(p))?.nodes || [])
    .filter((n) => !have.has(idOf(n)))
    .map((n) => ({ ...n, heldBack: true, heldBy: [...(p.activeRequests || [])] }));
}

/**
 * The last full read of a cluster that has since logged out or expired —
 * still there whether or not it was ever watched, unlike the ghosts
 * `watch.js` draws, which only exist for a host someone marked ahead of
 * time. `null` once it is older than `maxAgeMs` (or always, if `maxAgeMs`
 * is `null` — "always" is a real setting, not "forever by accident"), and
 * `null` if this cluster was never read at all this run — in memory only,
 * so a restart within the window still loses it, the same as every other
 * cache in this module.
 */
export function lastFullReadFor(p, maxAgeMs) {
  const rec = full.get(tpKey(p));
  if (!rec) return null;
  if (maxAgeMs != null && Date.now() - rec.at > maxAgeMs) return null;
  return rec;
}
