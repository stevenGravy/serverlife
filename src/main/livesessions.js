/**
 * Sessions in progress on a Teleport cluster, and how to join one.
 *
 * `tsh sessions ls --format=json` returns session trackers: one per live
 * session of any kind — SSH, Kubernetes, database, app, desktop. Only two of
 * those have a terminal another person can share, so only those are offered
 * a join; the rest are listed, because knowing who is in what is half of why
 * anyone opens the list.
 *
 * Pure: no tsh here, only the shapes. teleport.js runs the commands.
 */

/** Kinds with a terminal on the far side, which `tsh join` / `tsh kube join` can share. */
const JOINABLE_KINDS = new Set(['ssh', 'k8s']);

/**
 * The three ways in, in the order they are offered.
 *
 * Observer watches and cannot type; peer types alongside; moderator watches
 * with the power to end the session, and is what a moderated session waits
 * for before it starts. Which of these a user may take is the cluster's
 * decision (the role's `join_sessions`), so tsh is the one that says no.
 */
const JOIN_MODES = ['observer', 'peer', 'moderator'];

/** SessionState as the tracker numbers it; an omitted state is the zero value. */
const STATES = { 0: 'pending', 1: 'running', 2: 'terminated' };

function toActiveSession(t) {
  const s = (t && t.spec) || {};
  const kind = String(s.kind || '');
  const kube = s.kubernetes_cluster || s.kube_cluster || '';
  return {
    id: s.session_id || t?.metadata?.name || '',
    kind,
    state: STATES[s.state || 0] || String(s.state),
    created: s.created || null,
    // What the session is *on*, in the words the kind uses for it.
    target: kind === 'k8s' ? kube
      : kind === 'app' ? (s.app_name || s.target_hostname || '')
      : kind === 'db' ? (s.database_name || s.target_hostname || '')
      : kind === 'desktop' ? (s.desktop_name || s.target_hostname || '')
      : (s.target_hostname || s.target_address || ''),
    hostname: s.target_hostname || '',
    address: s.target_address || '',
    kubeCluster: kube,
    cluster: s.cluster_name || '',
    login: s.login || '',
    owner: s.host_user || '',
    command: Array.isArray(s.initial_command) ? s.initial_command.join(' ') : '',
    reason: s.reason || '',
    participants: (s.participants || []).map((p) => ({ user: p.user || '', mode: p.mode || '' })),
    joinable: JOINABLE_KINDS.has(kind) && (s.state || 0) !== 2,
  };
}

/**
 * The list from `tsh sessions ls --format=json`, newest first.
 *
 * tsh prints `null` rather than `[]` when nothing is running, and a cluster
 * with nothing going on is the common case, so that is an empty list and not
 * an error.
 */
function parseSessionList(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === 'null') return [];
  const at = raw.indexOf('[');
  const data = JSON.parse(at > 0 ? raw.slice(at) : raw);
  if (!Array.isArray(data)) return [];
  return data.map(toActiveSession)
    .filter((s) => s.id)
    .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
}

/** `tsh [--proxy] join|kube join --mode=<mode> [--cluster] <id>`. */
function joinArgs(sid, { proxy, cluster, kind, mode } = {}) {
  if (!sid) throw new Error('no session id');
  if (!JOINABLE_KINDS.has(kind)) throw new Error(`a ${kind || 'session'} session cannot be joined from a terminal`);
  const m = JOIN_MODES.includes(mode) ? mode : 'observer';
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  args.push(...(kind === 'k8s' ? ['kube', 'join'] : ['join']));
  args.push('--mode=' + m);
  if (cluster) args.push('--cluster=' + cluster);
  args.push(sid);
  return args;
}

module.exports = { JOINABLE_KINDS, JOIN_MODES, toActiveSession, parseSessionList, joinArgs };
