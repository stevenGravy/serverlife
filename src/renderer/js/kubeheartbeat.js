import { state } from './state.js';
import { el } from './util.js';

/*
 * Kubernetes heartbeats: is each cluster's API server answering, and how
 * fast — the ♥ an SSH node gets, for a Kubernetes row.
 *
 * Teleport publishes no heartbeat for a Kubernetes cluster (tsh kube ls
 * carries no expiry), so the cluster is asked: `GET /readyz`, once a minute
 * per cluster, only while Heartbeats is on and never with "No background
 * commands on servers" (main/kuberesources.js heartbeat). A cluster reached
 * through Teleport is asked only while its cached certificate is good, so a
 * check never makes tsh log in again or ask for MFA; without one it is
 * "not checked" until you open it.
 *
 * A cluster you can use but have not logged in to is asked too, while its
 * Teleport login is good: through a kubeconfig of the app's own, every five
 * minutes rather than every one (there can be dozens). One you could only
 * request cannot be asked — but Teleport lists a cluster only while its
 * agent keeps heartbeating, so being listed is said as such.
 *
 * Every target has its own key — its context and kubeconfig file, or its
 * Teleport cluster, tsh home and name — so the same cluster name in two
 * clusters or two homes never shares a heartbeat, and a round never starts
 * while the last is still running.
 */

const EVERY_MS = 60000;
const NOT_LOGGED_IN_EVERY_MS = 5 * 60000;
const TICK_MS = 15000;
const AT_ONCE = 3;
const beats = new Map();      // context id -> { state, ms, at, detail, okAt, failingSince }
let timer = null;
let running = false;

const on = () => !!state.settings?.showHeartbeats && state.settings?.quietRemote !== true;

/**
 * Start the loop once; it does nothing while Heartbeats is off. `getTargets`
 * gives what to ask now: { key, spec } for a kubeconfig context, or
 * { key, teleport: { proxy, kubeCluster, home } } for one not logged in to.
 */
export function startKubeHeartbeats(getTargets) {
  if (timer) return;
  const tick = async () => {
    if (running || !on()) return;
    running = true;
    try {
      const due = getTargets().filter((t) => {
        const b = beats.get(t.key);
        // MFA is not asked again this run: a check must not keep asking for a touch.
        if (b?.state === 'mfa') return false;
        return !b || Date.now() - b.at > (t.teleport ? NOT_LOGGED_IN_EVERY_MS : EVERY_MS);
      });
      for (let i = 0; i < due.length; i += AT_ONCE) {
        await Promise.all(due.slice(i, i + AT_ONCE).map(async (t) => {
          const ask = t.teleport ? window.api.kube.heartbeatTeleport(t.teleport) : window.api.kube.heartbeat({ spec: t.spec });
          const r = await ask.catch((e) => ({ ok: false, state: 'error', detail: e.message, ms: 0 }));
          const prev = beats.get(t.key) || {};
          const failing = !['ok', 'idle', 'mfa', 'quiet', 'noaccess'].includes(r.state);
          beats.set(t.key, {
            ...r, at: Date.now(),
            okAt: r.state === 'ok' ? Date.now() : prev.okAt || null,
            failingSince: failing ? (prev.failingSince || Date.now()) : null,
          });
        }));
        state.emit('kubeContexts');
      }
    } finally { running = false; }
  };
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 1500);
}

const ago = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};
const secs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** A kubeconfig context's key: its id and its own name and files, so two contexts never share one. */
export const contextBeatKey = (c) => `ctx\u0000${c.id}\u0000${c.contextName || c.name}\u0000${(c.kubeconfigPaths || []).join(':')}`;
/** A cluster not logged in to: its Teleport cluster, tsh home and name. */
export const teleportBeatKey = (proxy, home, name) => `tsh\u0000${String(proxy || '').replace(/:443$/, '')}\u0000${home || ''}\u0000${name}`;

/** Being listed by Teleport is a heartbeat of its own: the agent has announced itself within the last few minutes. */
export function listedBeatTag() {
  if (!on()) return null;
  return el('span', { class: 'tag hb', title: 'Listed by Teleport — its agent has heartbeated within the last few minutes. You have no access to ask the cluster itself.', text: '♥ listed' });
}

/** The row's heartbeat tag, or null while Heartbeats is off or nothing is known yet. */
export function kubeBeatTag(key) {
  if (!on()) return null;
  const b = beats.get(key);
  if (!b) return el('span', { class: 'tag hb', title: 'Asking the cluster whether it answers…', text: '♥ …' });
  const when = `checked ${ago(Date.now() - b.at)} ago`;
  if (b.state === 'ok') {
    return el('span', { class: 'tag hb', title: `Answering — /readyz in ${secs(b.ms)}, ${when}${b.detail && b.detail !== 'ok' ? `\n${b.detail}` : ''}`, text: `♥ ${secs(b.ms)}` });
  }
  if (b.state === 'idle' || b.state === 'mfa' || b.state === 'quiet') {
    return el('span', { class: 'tag hb', title: b.detail, text: '· not checked' });
  }
  if (b.state === 'noaccess') return el('span', { class: 'tag hb', title: b.detail, text: '· no access' });
  if (b.state === 'login') return el('span', { class: 'tag stale', title: `${b.detail}\n${when}`, text: '⚠ log in' });
  const since = b.failingSince ? ago(Date.now() - b.failingSince) : '';
  const last = b.okAt ? `\nLast answered ${ago(Date.now() - b.okAt)} ago.` : '';
  return el('span', { class: 'tag stale', title: `${b.detail}\n${when}${last}`, text: `⚠ ${since}` });
}

/** What the loop knows of one context — for tests and the tooltip elsewhere. */
export function kubeBeat(id) { return beats.get(id) || null; }
