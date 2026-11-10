import { el, clear } from './util.js';
import { modal, toast, status, contextMenu } from './ui.js';
import { openLocalShell } from './sessions.js';

/**
 * Sessions going on right now in a cluster, and a way into the ones with a
 * terminal.
 *
 * Opened from the right-click menu of a cluster (everything), of a Teleport
 * host or of a beam (what is happening on that machine). SSH and Kubernetes
 * sessions can be joined — watched, typed into, or moderated — in a local tab
 * running `tsh join` or `tsh kube join`; database, app and desktop sessions
 * are listed for who-is-where, without a join they could not honour.
 */

const MODES = [
  { mode: 'observer', label: 'Watch', title: 'Observer: see everything, type nothing' },
  { mode: 'peer', label: 'Join', title: 'Peer: type alongside whoever is in it' },
  { mode: 'moderator', label: 'Moderate', title: 'Moderator: watch, with the power to end it — what a moderated session waits for' },
];

const KIND_LABEL = { ssh: 'ssh', k8s: 'kube', db: 'database', app: 'app', desktop: 'desktop' };

/** "3m", "2h 5m" — how long a session has been going. */
function age(created) {
  const t = Date.parse(created || '');
  if (!t) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Join a session in a local tab.
 *
 * tsh does the joining, so MFA for a moderated session, a mode the role does
 * not allow, or a session that ended a moment ago all come back as tsh's own
 * words in the tab, which is where they can be read.
 */
export async function joinSession(s, mode, { proxy, home } = {}) {
  try {
    const { command, args, teleportHome } = await window.api.teleport.joinArgs(s.id, {
      proxy, home, cluster: s.cluster, kind: s.kind, mode,
    });
    const verb = mode === 'observer' ? 'watching' : mode === 'moderator' ? 'moderating' : 'joined';
    await openLocalShell(undefined, {
      command, args, teleportHome,
      title: `⇄ ${s.target || s.id.slice(0, 8)} · ${verb}`,
    });
    status(`${verb[0].toUpperCase() + verb.slice(1)} session ${s.id.slice(0, 8)}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** The command a person would type, for the clipboard. */
function joinCommand(s, mode, proxy) {
  return ['tsh', proxy ? `--proxy=${proxy}` : null, ...(s.kind === 'k8s' ? ['kube', 'join'] : ['join']),
    `--mode=${mode}`, s.cluster ? `--cluster=${s.cluster}` : null, s.id].filter(Boolean).join(' ');
}

function rowMenu(e, s, ctx) {
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: s.target || s.id, heading: true },
    ...(s.joinable
      ? MODES.map((m) => ({ label: `${m.label} (${m.mode})`, title: m.title, onClick: () => ctx.join(s, m.mode) }))
      : [{ label: `A ${KIND_LABEL[s.kind] || s.kind} session cannot be joined from a terminal`, disabled: true }]),
    { sep: true },
    {
      label: 'Copy session id',
      onClick: () => { window.api.clipboard.write(s.id); status('Copied ' + s.id); },
    },
    s.joinable ? {
      label: 'Copy the join command',
      onClick: () => { window.api.clipboard.write(joinCommand(s, 'observer', ctx.proxy)); status('Copied'); },
    } : null,
  ].filter(Boolean));
}

/**
 * The list, for one cluster.
 *
 * `match`, when given, narrows it to one machine: a host's menu passes its
 * names, since a session tracker names its target by hostname and that is
 * not always the name the node is listed under.
 */
export async function openActiveSessions({ proxy, home = null, match = null, title = 'Active sessions', subtitle } = {}) {
  let body = null;
  let closeFn = null;
  const ctx = {
    proxy,
    join: (s, mode) => { closeFn?.(null); joinSession(s, mode, { proxy, home }); },
  };

  const load = async () => {
    clear(body);
    body.append(el('div', { class: 'sb-empty', text: 'Asking the cluster…' }));
    let res;
    try { res = await window.api.teleport.activeSessions({ proxy, home }); } catch (e) { res = { ok: false, error: e.message }; }
    clear(body);
    if (!res.ok) {
      body.append(el('div', { class: 'sb-empty', style: 'color:var(--red);white-space:pre-wrap', text: res.error }));
      return;
    }
    const names = match ? match.filter(Boolean).map((n) => String(n).toLowerCase()) : null;
    const shown = names
      ? res.sessions.filter((s) => [s.hostname, s.address, s.target].some((v) => v && names.includes(v.toLowerCase())))
      : res.sessions;

    if (!shown.length) {
      body.append(el('div', { class: 'sb-empty', text: names
        ? 'Nothing is going on here right now.'
        : 'No sessions are in progress on this cluster.' }));
      return;
    }

    const list = el('div', { class: 'picker-list' });
    for (const s of shown) {
      const who = s.participants.length
        ? s.participants.map((p) => p.mode && p.mode !== 'peer' ? `${p.user} (${p.mode})` : p.user).join(', ')
        : s.owner;
      const row = el('div', { class: 'picker-item', style: 'cursor:default;gap:10px' },
        el('div', { style: 'flex:1;min-width:0' },
          el('div', { class: 'pname' },
            s.target || '(no target)',
            el('span', { class: 'tag', style: 'margin-left:7px', text: KIND_LABEL[s.kind] || s.kind }),
            s.state !== 'running'
              ? el('span', { class: 'tag', style: 'margin-left:5px;color:var(--amber)', text: s.state,
                  title: s.state === 'pending' ? 'Waiting for a moderator before it starts' : '' })
              : null),
          el('div', { class: 'pmeta', text: [
            s.login ? `as ${s.login}` : '',
            who,
            s.command,
            s.id.slice(0, 8),
          ].filter(Boolean).join('  ·  '), title: s.reason || '' })),
        el('span', { class: 'pmeta', style: 'width:64px;text-align:right', text: age(s.created) }),
        ...(s.joinable
          ? MODES.map((m) => el('button', {
              class: 'ghost-btn sm', text: m.label, title: m.title,
              onClick: () => ctx.join(s, m.mode),
            }))
          : [el('span', { class: 'pmeta', style: 'width:150px;text-align:right', text: 'not joinable from here' })]));
      row.addEventListener('contextmenu', (e) => rowMenu(e, s, ctx));
      list.append(row);
    }
    body.append(list);
  };

  await modal({
    title,
    subtitle: subtitle || proxy || '',
    width: 'min(860px, 96vw)',
    render: (b, { close }) => { body = b; closeFn = close; load(); },
    buttons: [
      { label: 'Refresh', onClick: () => { load(); return false; } },
      { label: 'Close', value: null },
    ],
  });
}
