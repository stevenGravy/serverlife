import { state } from './state.js';
import { el } from './util.js';
import { beatText, beatClock } from './heartbeat.js';

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
 * And Teleport's own heartbeat for each cluster's agent, where tctl is
 * there: one `tctl get kube_servers` a minute per Teleport cluster, with your
 * login (main/kuberesources.js kubeAgents) — no Kubernetes access needed, so
 * a cluster your role cannot ask, or can only request, still says how long
 * ago its agent was heard from, and one whose agent has gone quiet says so.
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
const agentsByProxy = new Map();   // bare proxy -> { at, ok, state, clusters: { name: [{ ageMs, hostname, version }] } }
const AGENTS_EVERY_MS = 60000;
const bare = (p) => String(p || '').toLowerCase().replace(/^https?:\/\//, '').replace(/:443$/, '');
// Quiet past this, as for SSH nodes (Settings → Warn about nodes that have gone quiet).
const quietMs = () => Math.max(1, Number(state.settings?.staleNodeMinutes ?? 2) || 2) * 60000;

/** The freshest of a Kubernetes cluster's agents, as tctl last read them — or null when not known. */
export function kubeAgentInfo(proxy, name) {
  const e = agentsByProxy.get(bare(proxy));
  const list = e?.ok ? e.clusters?.[name] : null;
  if (!list?.length) return null;
  // Aged by how long ago the list was read, so a pause in reading never makes an agent look quiet.
  const since = Date.now() - e.at;
  const atRead = list.map((a) => a.ageMs).filter((x) => x !== null);
  const freshest = atRead.length ? Math.min(...atRead) : null;
  return {
    // Shown counting on from the read; judged quiet by the age at the read, so a minute between reads is never a missed heartbeat.
    ageMs: freshest === null ? null : freshest + since,
    readAgeMs: freshest,
    at: freshest === null ? null : e.at - freshest,
    count: list.length, versions: [...new Set(list.map((a) => a.version).filter(Boolean))],
  };
}

const on = () => !!state.settings?.showHeartbeats && state.settings?.quietRemote !== true;

/**
 * Start the loop once; it does nothing while Heartbeats is off. `getTargets`
 * gives what to ask now: { key, spec } for a kubeconfig context, or
 * { key, teleport: { proxy, kubeCluster, home } } for one not logged in to.
 */
export function startKubeHeartbeats(getTargets, getProfiles = () => []) {
  if (timer) return;
  const tick = async () => {
    if (running || !on()) return;
    running = true;
    try {
      // Teleport's agent heartbeats: one tctl call per Teleport cluster, from a home whose login is good.
      const seen = new Set();
      for (const p of getProfiles()) {
        const key = bare(p.proxy);
        if (seen.has(key)) continue;
        seen.add(key);
        const e = agentsByProxy.get(key);
        if (e && (Date.now() - e.at < AGENTS_EVERY_MS || e.state === 'notctl')) continue;
        const r = await window.api.kube.agents({ proxy: p.proxy, home: p.homeDir || null }).catch((err) => ({ ok: false, state: 'error', error: err.message }));
        agentsByProxy.set(key, { ...r, at: r.at || Date.now() });
      }
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

const agentLine = (a) => (a ? `Teleport agent${a.count > 1 ? `s (${a.count})` : ''}: last heartbeat ${secsAgo(a.ageMs)} ago${a.at ? `, at ${beatClock(a.at)}` : ''}${a.versions.length ? ` · Teleport ${a.versions.join(', ')}` : ''}` : '');
const secsAgo = (ms) => (ms === null ? '?' : ms < 60000 ? `${Math.round(ms / 1000)}s` : ago(ms));

/** The agent's own heartbeat as the tag, for a cluster that cannot be asked itself. */
function agentTag(a, extra = '') {
  if (a.readAgeMs !== null && a.readAgeMs > quietMs()) {
    return el('span', { class: 'tag stale', title: `${agentLine(a)} — it has gone quiet.${extra ? `\n${extra}` : ''}`, text: `⚠ agent ${beatText(a.at)}` });
  }
  // As an SSH node's heartbeat reads (Settings → Heartbeat times); the exact time is in the tooltip.
  return el('span', { class: 'tag hb', title: `${agentLine(a)}${extra ? `\n${extra}` : ''}`, text: `♥ ${a.at === null ? '?' : beatText(a.at)}` });
}

/** A cluster you could only request: Teleport's heartbeat for its agent when tctl can read it, else that Teleport lists it. */
export function listedBeatTag(proxy, name) {
  if (!on()) return null;
  const a = proxy && name ? kubeAgentInfo(proxy, name) : null;
  if (a) return agentTag(a, 'You have no access to ask the cluster itself.');
  return el('span', { class: 'tag hb', title: 'Listed by Teleport — its agent has heartbeated within the last few minutes. You have no access to ask the cluster itself.', text: '♥ listed' });
}

/** The row's heartbeat tag, or null while Heartbeats is off or nothing is known yet. */
export function kubeBeatTag(key, { proxy = null, name = null } = {}) {
  if (!on()) return null;
  const b = beats.get(key);
  const a = proxy && name ? kubeAgentInfo(proxy, name) : null;
  // The cluster itself cannot be asked (yet, or by this role): Teleport's agent heartbeat says what can be said.
  if (a && (!b || ['idle', 'noaccess', 'mfa', 'quiet', 'login'].includes(b.state))) return agentTag(a, b?.detail || '');
  if (!b) return el('span', { class: 'tag hb', title: 'Asking the cluster whether it answers…', text: '♥ …' });
  const when = `checked ${ago(Date.now() - b.at)} ago`;
  if (b.state === 'ok') {
    const okAt = b.okAt || b.at;
    return el('span', { class: 'tag hb', title: `Answering — /readyz in ${secs(b.ms)}, at ${beatClock(okAt)} (${when})${b.detail && b.detail !== 'ok' ? `\n${b.detail}` : ''}${a ? `\n${agentLine(a)}` : ''}`, text: `♥ ${beatText(okAt)}` });
  }
  if (b.state === 'idle' || b.state === 'mfa' || b.state === 'quiet') {
    return el('span', { class: 'tag hb', title: b.detail, text: '· not checked' });
  }
  // Teleport answered for it and lists it — its agent is heartbeating — but this role may not ask the cluster itself.
  if (b.state === 'noaccess') {
    return el('span', { class: 'tag hb', title: `${b.detail}\nTeleport lists it, so its agent is heartbeating; the cluster itself cannot be asked with this role. ${when}.`, text: '♥ listed · no access' });
  }
  if (b.state === 'login') return el('span', { class: 'tag stale', title: `${b.detail}\n${when}`, text: '⚠ log in' });
  const since = b.failingSince ? beatText(b.failingSince) : '';
  const last = (b.okAt ? `\nLast answered ${ago(Date.now() - b.okAt)} ago, at ${beatClock(b.okAt)}.` : '') + (a ? `\n${agentLine(a)}${a.ageMs !== null && a.ageMs <= quietMs() ? ' — the agent is fine; the API server is what is not answering.' : ''}` : '');
  return el('span', { class: 'tag stale', title: `${b.detail}\n${when}${last}`, text: `⚠ ${since}` });
}

/**
 * For sorting by heartbeat: when a row was last heard from (ms) and whether
 * that counts as quiet — the cluster's own answer, else its agent's.
 */
export function beatTimeFor(key, { proxy = null, name = null } = {}) {
  const b = key ? beats.get(key) : null;
  const a = proxy && name ? kubeAgentInfo(proxy, name) : null;
  if (b?.state === 'ok') return { at: b.okAt || b.at, quiet: false };
  if (b && !['idle', 'noaccess', 'mfa', 'quiet', 'login'].includes(b.state)) return { at: b.okAt || a?.at || null, quiet: true };
  if (a?.at) return { at: a.at, quiet: a.readAgeMs !== null && a.readAgeMs > quietMs() };
  return { at: null, quiet: false };
}

/** What the loop knows of one context — for tests and the tooltip elsewhere. */
export function kubeBeat(id) { return beats.get(id) || null; }
