import { state } from './state.js';
import { el, clear } from './util.js';
import { toast, status } from './ui.js';
import { labelEntries } from './tags.js';

/**
 * Requestable resources, watched.
 *
 * `tsh request search` answers "what could I ask for?", and the answer is not
 * stable: a node is rebuilt and comes back under a new id, a role changes and
 * a whole kind stops being offered, a resource is retired and simply stops
 * appearing. None of that announces itself. You find out at the moment you
 * needed the access — which is the worst moment, because the request you were
 * about to raise is the thing that has gone.
 *
 * So: pick the resources you care about, and every few minutes the search is
 * run again and each one is confirmed still there. What is still requestable
 * says so, with when it was last confirmed; what is not is listed as missing,
 * with everything last known about it, because after it has gone the cluster
 * has nothing more to say about it.
 *
 * Same discipline as watching a host disappear, for the same reason: a
 * resource is only ever called missing off the back of a **successful**
 * search. An expired certificate, a proxy that will not answer, a role that
 * cannot search that kind at all — each produces an empty list that means
 * nothing, and declaring twelve resources gone on that evidence would make
 * this untrustworthy within a day.
 */

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

export function monitored() {
  return state.settings.requestMonitor || [];
}

export function monitorCount() {
  return monitored().length;
}

/** How many are missing right now — the number worth putting on a button. */
export function missingCount() {
  return monitored().filter((r) => r.missingSince).length;
}

/**
 * What identifies a monitored resource.
 *
 * The resource id — `/cluster/node/<uuid>` — plus the profile it was found
 * through, since the same cluster can be reached through two tsh homes and
 * they are not interchangeable.
 */
export function monitorKey(r) {
  return `${r.proxy || ''}\u0000${r.home || ''}\u0000${r.id || ''}`;
}

export function isMonitored(id, profile) {
  const key = monitorKey({ id, proxy: profile?.proxy, home: profile?.homeDir });
  return monitored().some((r) => monitorKey(r) === key);
}

async function save(list) {
  state.settings = await window.api.settings.set({ requestMonitor: list });
  state.emit('reqmonitor');
}

/** Everything worth keeping about a resource that may be about to vanish. */
function record(r, profile) {
  return {
    id: r.id,
    kind: r.kind || 'node',
    name: r.name || r.uuid || r.id,
    uuid: r.uuid || '',
    cluster: r.cluster || profile?.cluster || '',
    proxy: profile?.proxy || r.proxy || '',
    home: profile?.homeDir || r.home || null,
    labels: { ...(r.labels || {}) },
    addedAt: Date.now(),
    lastSeen: Date.now(),      // it was in a search a moment ago: that is how it got here
    lastCheck: Date.now(),
    missingSince: null,
  };
}

export async function addToMonitor(resources, profile) {
  const list = [...monitored()];
  const have = new Set(list.map(monitorKey));
  let added = 0;
  for (const r of resources || []) {
    const rec = record(r, profile);
    if (have.has(monitorKey(rec))) continue;
    list.push(rec);
    have.add(monitorKey(rec));
    added++;
  }
  if (!added) return 0;
  await save(list);
  status(`Monitoring ${added} more requestable resource${added === 1 ? '' : 's'}`);
  return added;
}

export async function removeFromMonitor(key) {
  await save(monitored().filter((r) => monitorKey(r) !== key));
}

export async function clearMonitor() {
  await save([]);
}

/* ------------------------------------------------------------------ */
/* Checking                                                            */
/* ------------------------------------------------------------------ */

/**
 * How long an empty answer has to keep being the answer before it counts.
 * The same ten minutes the host watch uses, for the same reason.
 */
export const EMPTY_CORROBORATION_MS = 10 * 60000;

/** The default, and what the user asked for: every five minutes. */
const DEFAULT_MINUTES = 5;

export function monitorMinutes() {
  const v = Number(state.settings.requestMonitorMinutes);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MINUTES;
  // A search is a round trip to the proxy per kind per cluster; a minute is
  // as often as that is reasonable, and an hour is as rare as it can be
  // before "monitored" stops being a fair description.
  return Math.min(60, Math.max(1, Math.round(v)));
}

/**
 * One search covers every monitored resource of the same kind on the same
 * profile, so the work is grouped rather than done per resource. Twelve nodes
 * on one cluster is one `tsh request search`, not twelve.
 */
export function groupsOf(items = monitored()) {
  const groups = new Map();
  for (const r of items) {
    const key = `${r.proxy || ''}\u0000${r.home || ''}\u0000${r.kind || 'node'}`;
    if (!groups.has(key)) {
      groups.set(key, { proxy: r.proxy || '', home: r.home || null, kind: r.kind || 'node', items: [] });
    }
    groups.get(key).items.push(r);
  }
  return [...groups.values()];
}

/**
 * Whether each cluster could actually be asked.
 *
 * Kept in settings rather than in memory, because the state it describes
 * outlives the window: log out on Friday, open the app on Monday, and the
 * pane should say "could not search since Friday" rather than showing a
 * tidy list of green ticks confirmed three days ago. A stale confirmation
 * looks exactly like a fresh one unless something says otherwise.
 */
export function groupStatusKey(g) {
  return `${g.proxy || ''}\u0000${g.home || ''}\u0000${g.kind || 'node'}`;
}

export function monitorStatus() {
  return state.settings.requestMonitorStatus || {};
}

/**
 * What to say about one resource right now.
 *
 * Three answers, and the third is the one that was missing: `gone` is a
 * conclusion drawn from a search that worked, `ok` is the same, and
 * `unchecked` is what is left when the cluster could not be reached — which
 * is neither good news nor bad news about the resource, and is exactly what
 * somebody needs to be told rather than left to infer from a timestamp.
 */
export function rowState(r, status = monitorStatus(), minutes = monitorMinutes(), now = Date.now()) {
  const st = status[groupStatusKey(r)] || {};
  /*
   * Whether it can be checked comes first, even for a resource already
   * judged gone. A verdict is only worth showing while it can still be
   * re-tested — the moment the cluster cannot be searched, "not
   * requestable" is a claim with nothing behind it, and the honest answer
   * is that nobody has been able to look. The record keeps the verdict, and
   * the tooltip repeats it; a search that works again will restate it.
   */
  const unreachable = (st.failAt || 0) > (st.okAt || 0);
  if (unreachable) return 'unchecked';
  if (r.missingSince) return 'gone';
  // And a check that simply stopped happening — the app was asleep, the
  // loop was not running, the cluster was never reachable to begin with.
  const due = Math.max(3 * minutes * 60000, 15 * 60000);
  if (now - (r.lastCheck || r.lastSeen || 0) > due) return 'unchecked';
  return 'ok';
}

/** The reason the last search failed, for the row and the banner. */
export function groupError(r, status = monitorStatus()) {
  const st = status[groupStatusKey(r)] || {};
  return (st.failAt || 0) > (st.okAt || 0) ? (st.error || 'the cluster could not be searched') : '';
}

/**
 * Fold the result of one successful search back into the list.
 *
 * Pure, and the whole of the logic worth being sure about: what counts as
 * still there, what counts as newly gone, and what must not be touched. Only
 * the resources of the group that was searched are considered — everything
 * else in the list belongs to a cluster this search says nothing about.
 *
 * `missingSince` is set once, the first time it is noticed, and kept: it is
 * when the resource went, not when it was last looked for, and it is what
 * stops the news being announced again every five minutes.
 */
export function applySearch(items, group, resources, now = Date.now()) {
  const present = new Set((resources || []).map((r) => r.id));
  const inGroup = (r) => (r.proxy || '') === (group.proxy || '')
    && (r.home || null) === (group.home || null)
    && (r.kind || 'node') === (group.kind || 'node');

  const gone = [];
  const back = [];
  const next = items.map((r) => {
    if (!inGroup(r)) return r;
    if (present.has(r.id)) {
      const found = (resources || []).find((x) => x.id === r.id);
      const updated = {
        ...r,
        // While it is there, the record follows it: a resource can be
        // relabelled or renamed, and the copy kept should be the last thing
        // that was true, not the first.
        name: found?.name || r.name,
        labels: found?.labels ? { ...found.labels } : r.labels,
        lastSeen: now,
        lastCheck: now,
        missingSince: null,
      };
      if (r.missingSince) back.push(updated);
      return updated;
    }
    const updated = { ...r, lastCheck: now, missingSince: r.missingSince || now };
    if (!r.missingSince) gone.push(updated);
    return updated;
  });

  return { items: next, gone, back };
}

let checking = false;
let lastRun = 0;
let lastErrors = [];

export function monitorErrors() { return lastErrors; }
export function lastRunAt() { return lastRun; }
export function isChecking() { return checking; }

/**
 * Run the searches now.
 *
 * A group whose search fails leaves its resources exactly as they were — not
 * marked missing, not marked seen — and the failure is shown in the pane
 * instead, because "I could not ask" and "it is not there" are different
 * answers and only one of them is about the resource.
 */
export async function checkNow({ quiet = false } = {}) {
  if (checking) return;
  const groups = groupsOf();
  if (!groups.length) { lastRun = Date.now(); render(); return; }

  checking = true;
  lastErrors = [];
  render();

  const status = { ...monitorStatus() };
  let items = monitored();
  const gone = [];
  const back = [];

  for (const g of groups) {
    let res;
    try {
      res = await window.api.teleport.requestSearch({ proxy: g.proxy, home: g.home, kind: g.kind });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res?.ok) {
      const error = res?.error || 'search failed';
      lastErrors.push({ ...g, error });
      status[groupStatusKey(g)] = { ...(status[groupStatusKey(g)] || {}), failAt: Date.now(), error };
      continue;
    }
    /*
     * A search that worked but returned nothing concludes nothing either.
     *
     * `tsh request search` comes back empty for reasons that have nothing to
     * do with the resources: roles that no longer allow requesting that
     * kind, a leaf that is not connected, a cluster mid-restart. Marking
     * every monitored resource missing on that evidence is exactly the false
     * alarm this whole feature is built to avoid, so an empty answer is
     * recorded as inconclusive and the rows read as unchecked.
     */
    const key = groupStatusKey(g);
    if (!res.resources?.length && g.items.length) {
      const st = status[key] || {};
      const first = st.emptyAt || Date.now();
      status[key] = {
        ...st,
        emptyAt: first,
        failAt: Date.now(),
        error: 'the search returned nothing — roles, or a cluster that cannot answer for this kind',
      };
      // Corroboration, as for a host that has stopped being listed: one
      // empty answer marks nothing, a second ten minutes later is taken at
      // its word.
      if (Date.now() - first < EMPTY_CORROBORATION_MS) {
        lastErrors.push({ ...g, empty: true, error: 'the search returned nothing' });
        continue;
      }
    }
    status[key] = { okAt: Date.now(), failAt: 0, error: '', emptyAt: 0 };
    const out = applySearch(items, g, res.resources, Date.now());
    items = out.items;
    gone.push(...out.gone);
    back.push(...out.back);
  }

  checking = false;
  lastRun = Date.now();
  state.settings = await window.api.settings.set({ requestMonitorStatus: status });
  await save(items);

  if (!quiet) {
    for (const r of gone) {
      toast(`${r.name} is no longer requestable on ${r.cluster || r.proxy} — you were monitoring it`, 'error', 12000);
    }
    for (const r of back) toast(`${r.name} can be requested again on ${r.cluster || r.proxy}`, 'success', 8000);
  }
  render();
}

let timer = null;

/**
 * The loop. Started at launch whether or not the pane is open — the point of
 * monitoring something is that it carries on while you are doing something
 * else, and the pane is a window onto it rather than the thing itself.
 */
export function startMonitorLoop() {
  clearInterval(timer);
  if (!monitorCount()) return;
  timer = setInterval(() => checkNow({ quiet: false }), monitorMinutes() * 60000);
}

export async function setMonitorMinutes(minutes) {
  state.settings = await window.api.settings.set({ requestMonitorMinutes: minutes });
  startMonitorLoop();
  render();
}

/* ------------------------------------------------------------------ */
/* The pane                                                            */
/* ------------------------------------------------------------------ */

const KIND_LABELS = {
  node: 'server', app: 'application', db: 'database', kube_cluster: 'kube cluster',
  windows_desktop: 'windows desktop', linux_desktop: 'linux desktop', user_group: 'user group',
  saml_idp_service_provider: 'SAML app', git_server: 'git server',
  aws_ic_account: 'AWS account', aws_ic_account_assignment: 'AWS assignment',
};

/** "4m", "2h", "3d" — how long ago, in the largest useful unit. */
export function ago(ms) {
  if (!ms) return '';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 90) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Everything the cluster will not be able to tell you once it has gone. */
export function missingDetail(r) {
  const labels = Object.entries(r.labels || {})
    .filter(([k]) => !k.startsWith('teleport.internal/'))
    .map(([k, v]) => `${k}=${v}`);
  return [
    r.missingSince
      ? `Not in tsh request search. Last confirmed ${new Date(r.lastSeen).toLocaleString()} (${ago(r.missingSince)} ago).`
      : `Requestable. Last confirmed ${r.lastSeen ? new Date(r.lastSeen).toLocaleString() : 'not yet'}.`,
    `id: ${r.id}`,
    r.uuid && r.uuid !== r.name ? `node id: ${r.uuid}` : '',
    r.cluster ? `cluster: ${r.cluster}` : '',
    r.proxy ? `proxy: ${r.proxy}` : '',
    labels.length ? `labels: ${labels.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * The labels, on the row.
 *
 * Written down when the resource was last seen and drawn from the record,
 * which is the entire point of keeping them: once something has stopped
 * being offered, `env=prod` and the name it went by are all anyone has to go
 * on, and a row reading `/prod.example.com/node/ea9f6ccd-…` is a row
 * nobody can act on. The noisy ones a cluster attaches to everything —
 * uptime, live statistics, the hostname that repeats the name — are left for
 * the tooltip: they change by the minute and say nothing about which machine
 * this was.
 */
const DULL = /^(uptime|stats|hostname)$/;

function tagStrip(r) {
  const tags = labelEntries(r).filter(([k]) => !DULL.test(k.split('/').pop()));
  if (!tags.length) return null;
  const strip = el('div', { class: 'rmon-tags' });
  for (const [k, v] of tags.slice(0, 3)) {
    strip.append(el('span', { class: 'chip', style: 'cursor:default', title: `${k} = ${v}` },
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v', text: String(v).length > 14 ? String(v).slice(0, 13) + '…' : v })));
  }
  if (tags.length > 3) strip.append(el('span', { class: 'chip more', text: `+${tags.length - 3}` }));
  return strip;
}

/** Why this one could not be confirmed, in three or four words. */
function shortReason(r, status = monitorStatus()) {
  const why = groupError(r, status);
  if (!why) return 'not checked recently';
  return /returned nothing/.test(why) ? 'the search came back empty' : 'cluster unreachable';
}

/** The tooltip for a resource nobody has been able to ask about. */
export function uncheckedDetail(r, status = monitorStatus()) {
  const why = groupError(r, status);
  return [
    'Not checked. The cluster could not be searched, so this says nothing',
    'about the resource — only that nobody has been able to look.',
    why ? `reason: ${why}` : '',
    `Last confirmed ${r.lastSeen ? new Date(r.lastSeen).toLocaleString() : 'never'}`,
    r.missingSince
      ? `It was absent from the last search that worked (${new Date(r.missingSince).toLocaleString()}).`
      : '',
    `id: ${r.id}`,
    r.cluster ? `cluster: ${r.cluster}` : '',
  ].filter(Boolean).join('\n');
}

let root = null;

export function isPaneOpen() { return !!root; }

export async function toggleMonitorPane() {
  if (root) return closeMonitorPane();
  return openMonitorPane();
}

export async function openMonitorPane() {
  if (root) { root.classList.add('flash'); setTimeout(() => root?.classList.remove('flash'), 400); return; }
  root = el('div', { class: 'rmon', role: 'dialog', 'aria-label': 'Requestable resource monitor' });
  document.body.append(root);
  placePane();
  render();
  state.settings = await window.api.settings.set({ requestMonitorOpen: true });
  // Opening it is a reason to look: if the last answer is older than the
  // interval it is re-checked now rather than showing a stale list.
  if (monitorCount() && Date.now() - lastRun > monitorMinutes() * 60000) checkNow({ quiet: true });
}

export async function closeMonitorPane() {
  root?.remove();
  root = null;
  state.settings = await window.api.settings.set({ requestMonitorOpen: false });
}

/** Where it was left. Kept on screen, whatever the window has done since. */
function placePane() {
  const pos = state.settings.requestMonitorPos || {};
  const w = 340;
  const x = Math.min(Math.max(8, Number(pos.x) || (window.innerWidth - w - 24)), Math.max(8, window.innerWidth - w - 8));
  const y = Math.min(Math.max(34, Number(pos.y) || 90), Math.max(34, window.innerHeight - 120));
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
}

async function savePos() {
  if (!root) return;
  const r = root.getBoundingClientRect();
  state.settings = await window.api.settings.set({
    requestMonitorPos: { x: Math.round(r.x), y: Math.round(r.y) },
  });
}

function dragBy(head) {
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, select')) return;
    const start = { x: e.clientX, y: e.clientY };
    const r = root.getBoundingClientRect();
    const move = (ev) => {
      const x = Math.min(Math.max(4, r.x + ev.clientX - start.x), window.innerWidth - r.width - 4);
      const y = Math.min(Math.max(30, r.y + ev.clientY - start.y), window.innerHeight - 60);
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      savePos();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  });
}

function render() {
  if (!root) return;
  clear(root);
  const items = monitored();
  const st = monitorStatus();
  const missing = items.filter((r) => r.missingSince);
  const unchecked = items.filter((r) => rowState(r, st) === 'unchecked');

  const head = el('div', { class: 'rmon-head' },
    el('span', { class: 'rmon-title', text: 'Requestable resources' }),
    missing.length
      ? el('span', { class: 'tag gone', title: `${missing.length} no longer in the search`, text: `${missing.length} missing` })
      : null,
    /*
     * Said in the head, not only per row: a cluster that cannot be reached
     * makes every row under it meaningless, and the one thing worse than
     * bad news is a pane that looks calm while nothing is being checked.
     */
    unchecked.length
      ? el('span', {
          class: 'tag stale',
          title: 'The cluster could not be searched — nothing here is being confirmed',
          text: `${unchecked.length} unchecked`,
        })
      : null,
    !missing.length && !unchecked.length
      ? el('span', { class: 'badge', text: String(items.length) })
      : null,
    el('span', { style: 'flex:1' }),
    el('button', {
      class: 'icon-btn sm', text: '↻',
      title: 'Check now',
      onClick: () => checkNow(),
    }),
    el('button', {
      class: 'icon-btn sm', text: '+',
      title: 'Monitor more requestable resources…',
      onClick: () => addDialog(),
    }),
    el('button', {
      class: 'icon-btn sm', text: '×',
      title: 'Close this pane (monitoring carries on)',
      onClick: () => closeMonitorPane(),
    }));
  dragBy(head);
  root.append(head);

  const body = el('div', { class: 'rmon-body' });
  if (!items.length) {
    body.append(el('div', { class: 'rmon-empty' },
      el('div', { text: 'Nothing is being monitored yet.' }),
      el('div', { class: 'hint', style: 'margin-top:6px' },
        'Pick resources you expect to be able to request. Every '
        + `${monitorMinutes()} minutes the search is run again, and anything that stops `
        + 'being offered is listed here rather than discovered when you need it.'),
      el('button', {
        class: 'ghost-btn', style: 'margin-top:9px',
        text: 'Choose resources…', onClick: () => addDialog(),
      })));
  }

  const status = monitorStatus();
  for (const r of items) {
    const st = rowState(r, status);
    const gone = st === 'gone';
    const unsure = st === 'unchecked';
    body.append(el('div', {
      class: 'rmon-row' + (gone ? ' gone' : unsure ? ' unsure' : ''),
      title: unsure ? uncheckedDetail(r, status) : missingDetail(r),
    },
      el('span', { class: 'rmon-dot' + (gone ? ' bad' : unsure ? ' unsure' : r.lastSeen ? ' ok' : '') }),
      el('div', { class: 'rmon-main' },
        el('div', { class: 'rmon-name', text: r.name }),
        /*
         * What kind of thing this is, and where. "Requestable" is said in
         * words on the line below rather than implied by the pane it is in:
         * a row that reads only `web-3 · server` could as easily be a
         * host you can already reach, and the whole point of this list is
         * that these are resources you cannot.
         */
        el('div', { class: 'rmon-meta', text: [
          KIND_LABELS[r.kind] || r.kind,
          r.cluster,
        ].filter(Boolean).join(' · ') }),
        el('div', { class: 'rmon-state' + (gone ? ' bad' : unsure ? ' unsure' : '') },
          el('span', {
            class: 'rmon-word',
            text: gone ? '⊘ not requestable'
              : unsure ? '? not checked'
              : '✓ requestable',
          }),
          el('span', {
            class: 'rmon-when-row',
            text: gone
              ? ` — missing ${ago(r.missingSince)}, last confirmed ${ago(r.lastSeen)} ago`
              : unsure
              ? ` — ${shortReason(r, status)}, last confirmed ${r.lastSeen ? ago(r.lastSeen) + ' ago' : 'never'}`
              : r.lastSeen ? ` — confirmed ${ago(r.lastSeen)} ago` : ' — not checked yet',
          })),
        tagStrip(r)),
      el('button', {
        class: 'icon-btn sm', text: '×',
        title: 'Stop monitoring this one',
        onClick: () => removeFromMonitor(monitorKey(r)),
      })));
  }

  for (const e of lastErrors) {
    body.append(el('div', { class: 'rmon-err', title: e.error },
      e.empty
        ? `The search for ${KIND_LABELS[e.kind] || e.kind}s on ${e.proxy || 'this cluster'} came back empty — nothing was judged missing.`
        : `Could not search ${KIND_LABELS[e.kind] || e.kind}s on ${e.proxy || 'this cluster'} — nothing was judged missing.`));
  }
  root.append(body);

  const mins = el('select', { class: 'rmon-int', title: 'How often the search is run' });
  for (const m of [1, 5, 15, 30, 60]) {
    mins.append(el('option', { value: String(m), text: m === 60 ? 'hourly' : `every ${m}m` }));
  }
  mins.value = String(monitorMinutes());
  mins.addEventListener('change', () => setMonitorMinutes(Number(mins.value)));

  root.append(el('div', { class: 'rmon-foot' },
    mins,
    el('span', {
      class: 'rmon-when',
      text: checking ? 'checking…' : lastRun ? `checked ${ago(lastRun)} ago` : 'not checked yet',
    })));
}

// The pane redraws when the list changes underneath it — added from the
// Teleport panel, removed from here, or a check coming back.
state.on('reqmonitor', () => render());

/**
 * Choose what to monitor: a cluster, then its requestable resources, using
 * the same picker as an access request. The list is the same question after
 * all — "what could I ask for?" — and learning a second one would be a poor
 * trade for a feature that exists to save you looking.
 */
async function addDialog() {
  const profiles = (state.teleportProfiles || []).filter((p) => !p.expired);
  if (!profiles.length) return toast('Log in to a cluster first', 'error');

  let profile = profiles[0];
  if (profiles.length > 1) {
    const { contextMenu } = await import('./ui.js');
    const r = root.getBoundingClientRect();
    profile = await new Promise((resolve) => {
      contextMenu(r.x + 20, r.y + 40, profiles.map((p) => ({
        label: p.cluster || p.proxy,
        onClick: () => resolve(p),
      })).concat([{ sep: true }, { label: 'Cancel', onClick: () => resolve(null) }]));
    });
    if (!profile) return;
  }

  const { pickRequestResources } = await import('./requestpicker.js');
  const picked = await pickRequestResources(profile, [], {
    title: 'Monitor requestable resources',
    subtitle: profile.cluster || profile.proxy,
    confirmLabel: 'Monitor selected',
  });
  if (!picked?.length) return;
  await addToMonitor(picked, profile);
  startMonitorLoop();
  render();
}

/**
 * What the monitor should hold for one cluster after the picker comes back.
 *
 * The picker opens with what is already monitored ticked, so unticking
 * something is how you stop monitoring it. There is one thing that must
 * survive that gesture: a resource that has **gone** is not in the search,
 * so the picker cannot offer it, so it cannot be ticked — and treating
 * "not returned" as "unticked" would quietly delete exactly the records
 * this feature exists to keep, at exactly the moment they matter. A missing
 * resource therefore stays until it is removed from the pane, deliberately,
 * one row at a time.
 */
export function reconcileForProfile(items, profile, pickedIds) {
  const keep = new Set(pickedIds || []);
  const mine = (r) => (r.proxy || '') === (profile.proxy || '')
    && (r.home || null) === (profile.homeDir || null);
  return items.filter((r) => !mine(r) || keep.has(r.id) || r.missingSince);
}

/**
 * Add to the monitor from a cluster that has already been chosen — the
 * cluster heading in the host list knows which one it is, so asking again
 * would be a question with one answer.
 */
export async function addForProfile(profile) {
  if (!profile) return;
  const { pickRequestResources } = await import('./requestpicker.js');
  const already = monitored().filter((r) => (r.proxy || '') === (profile.proxy || '')
    && (r.home || null) === (profile.homeDir || null));
  const picked = await pickRequestResources(profile, already, {
    title: 'Monitor requestable resources',
    subtitle: profile.cluster || profile.proxy,
    confirmLabel: 'Monitor selected',
  });
  if (!picked) return;
  const rest = reconcileForProfile(monitored(), profile, picked.map((r) => r.id));
  if (rest.length !== monitored().length) await save(rest);
  await addToMonitor(picked, profile);
  startMonitorLoop();
  render();
}

/** Whether the pane is allowed to appear by itself when the app starts. */
export function autoOpenPane() {
  return state.settings.requestMonitorAutoOpen === true;
}

/** Called once at startup. */
export function initReqMonitor() {
  startMonitorLoop();
  /*
   * The pane does not come back on its own unless it has been asked to.
   *
   * Off by default, and deliberately not "reopen if it was open when you
   * quit": a floating window that appears over the app at launch is an
   * interruption, and this one has nothing urgent to say most mornings. The
   * watching happens either way — that is the whole point of it — and the
   * cluster heading, the Teleport tab button and the menu all carry the
   * count, so a resource that has gone is findable without the pane having
   * shown itself.
   */
  if (autoOpenPane()) openMonitorPane();
  // A first pass shortly after launch, so an overnight disappearance is on
  // screen when you sit down rather than five minutes later.
  if (monitorCount()) setTimeout(() => checkNow({ quiet: false }), 8000);
}
