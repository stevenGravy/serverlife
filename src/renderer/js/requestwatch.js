import { state, tpKey } from './state.js';
import { el } from './util.js';

/**
 * Access requests that are still live, watched in the background.
 *
 * A request is a thing you are waiting on — someone has to review it — and
 * before this the only way to find out was to open the Teleport tab and press
 * a button. That is the wrong shape for waiting: an approval that arrived
 * twenty minutes ago is no use if nobody looked. So the list is re-read on a
 * timer and what it finds is put where it will be seen.
 *
 * "Live" means pending review, or approved and still usable — an approval that
 * has expired unused is history, not something to act on.
 */

const REFRESH_MS = 90000;

let timer = null;

/** Requests that are still worth showing, per Teleport profile. */
export function requestsFor(profile) {
  if (!profile) return [];
  return (state.accessRequests?.get(tpKey(profile)) || []);
}

/** Every live request across every logged-in cluster. */
export function allLiveRequests() {
  const out = [];
  for (const [key, list] of (state.accessRequests || new Map())) {
    for (const r of list) out.push({ ...r, profileKey: key });
  }
  return out;
}

export function liveCount() {
  return allLiveRequests().length;
}

/** Pending review, versus approved and ready to assume. */
export function requestSummary(list = allLiveRequests()) {
  const pending = list.filter((r) => r.state === 'PENDING').length;
  const approved = list.filter((r) => ['APPROVED', 'PROMOTED'].includes(r.state)).length;
  return { pending, approved, total: list.length };
}

function isLive(r) {
  if (r.state === 'PENDING') return true;
  if (!['APPROVED', 'PROMOTED'].includes(r.state)) return false;
  /*
   * An approval is only live while it can still be used. `maxDuration` is when
   * the access itself ends; `expires` is when the request stops accepting
   * review, and is the fallback for an older cluster that does not send the
   * other.
   */
  const until = Date.parse(r.maxDuration || r.expires || '') || 0;
  return !until || until > Date.now();
}

/**
 * Re-read the requests for every live profile.
 *
 * Failures are per cluster and silent: a proxy that will not answer should
 * cost an indicator, not an error toast every ninety seconds.
 */
export async function refreshRequests() {
  if (!state.accessRequests) state.accessRequests = new Map();
  const live = (state.teleportProfiles || []).filter((p) => !p.expired);
  if (!live.length) {
    state.accessRequests.clear();
    state.emit('requests');
    return;
  }

  await Promise.all(live.map(async (p) => {
    try {
      // Names are not resolved here: this runs on a timer, and resolving a
      // node UUID costs a `tsh request search` per cluster. The dialog does
      // that when someone actually looks.
      const r = await window.api.teleport.requests({
        proxy: p.proxy, home: p.homeDir, resolveNames: false,
      });
      const mine = (r.requests || []).filter((x) => isLive(x) && (!x.user || x.user === p.username));
      if (mine.length) state.accessRequests.set(tpKey(p), mine);
      else state.accessRequests.delete(tpKey(p));
    } catch {
      state.accessRequests.delete(tpKey(p));
    }
  }));
  state.emit('requests');
}

/**
 * A badge for the sidebar's Teleport tab.
 *
 * Amber for something waiting on a reviewer, green once there is an approval
 * to use — the two states you would act on differently. Nothing at all when
 * there is nothing outstanding, so it stays news.
 */
export function requestBadge() {
  const { pending, approved, total } = requestSummary();
  if (!total) return null;
  const cls = approved ? 'ok' : 'pending';
  return el('span', {
    class: 'req-badge ' + cls,
    title: [
      pending ? `${pending} request${pending === 1 ? '' : 's'} awaiting review` : '',
      approved ? `${approved} approved and ready to assume` : '',
      'Right-click the tabs for the request list',
    ].filter(Boolean).join('\n'),
    text: String(total),
  });
}

/** Per cluster, for its heading in the host list. */
export function clusterRequestTag(profile) {
  const list = requestsFor(profile);
  if (!list.length) return null;
  const { pending, approved } = requestSummary(list);
  /*
   * Short on purpose. This sits on a heading beside the home, leaf and beam
   * badges, and "4 approved" pushed the cluster's own name out of the way —
   * the count is the news, the colour says which kind, and the tooltip has the
   * detail for anyone who wants it.
   */
  const tag = el('span', {
    class: 'tag req' + (approved ? ' ok' : ''),
    title: [
      pending ? `${pending} awaiting review` : '',
      approved ? `${approved} approved — click to assume` : '',
      'Click for the request list',
    ].filter(Boolean).join('\n'),
    text: `${list.length} req`,
  });
  tag.addEventListener('click', async (e) => {
    // The heading collapses when clicked; opening the list is what was meant.
    e.preventDefault();
    e.stopPropagation();
    const { openRequestsDialog } = await import('./teleportpanel.js');
    openRequestsDialog(profile);
  });
  return tag;
}

/**
 * Keep it current. Skipped while the window is hidden — a request list is not
 * worth a `tsh` call a minute against a laptop that is closed.
 */
export function startRequestLoop() {
  if (timer) return;
  refreshRequests().catch(() => {});
  timer = setInterval(() => {
    if (document.hidden) return;
    refreshRequests().catch(() => {});
  }, REFRESH_MS);
}
