import { state } from './state.js';
import { el, clear, fmtBytes, fmtDate, fmtDuration } from './util.js';
import { modal, field, textInput, select, toast, status, checkbox, contextMenu } from './ui.js';
import { labelEntries } from './tags.js';

/**
 * Host-level actions that need a live connection but not a terminal:
 * port forwarding and the on-demand server profile.
 */

/** Get (or create and dial) a connection for a sidebar host descriptor. */
export async function ensureConnection(host, login, { fresh = false } = {}) {
  /*
   * `fresh` is for "try that again as somebody else".
   *
   * The reuse below matches on the host alone, so without this a retry with
   * a different login would hand back the very connection that was opened
   * as the wrong user — and the retry would fail identically, which looks
   * like the new name being refused too.
   */
  if (!fresh) {
    for (const c of state.connections.values()) {
      if (c.hostId === host.id && ['connected', 'connecting'].includes(c.state)) {
        if (c.state !== 'connected') await window.api.conn.connect(c.id);
        return c.id;
      }
    }
  }
  /*
   * The sidebar's own `open()` skips straight to the `tsh` transport for a
   * host remembered as needing per-session MFA, because the shared (mux)
   * path cannot satisfy it — `tsh proxy ssh` just proxies the existing
   * long-lived certificate through, the node refuses it every time, and
   * OpenSSH gives up with "too many authentication failures" or "Permission
   * denied (publickey)" having never attempted the ceremony at all. This
   * dialog (the single-command run, the port-forward opener) used to go
   * straight to the shared path regardless, so even a host already known to
   * need MFA failed here every time.
   */
  const { isMfaHost, setMfaHost } = await import('./sidebar.js');
  const known = host.type === 'teleport' && isMfaHost(host.id);
  try {
    return await dial(known);
  } catch (e) {
    /*
     * First time seeing this host fail this way: `conn:connect` tags the
     * error `[mfa]` (see `looksLikeMfa` in the main process) precisely so a
     * caller can retry over `tsh` instead of leaving the user with a bare
     * "Permission denied (publickey)". Nothing here was reading that tag —
     * retry once, and remember it so the next run goes straight to `tsh`.
     */
    if (known || host.type !== 'teleport' || !/\[mfa\]\s*$/.test(e.message || '')) throw e;
    setMfaHost(host, true).catch(() => {});
    return dial(true);
  }

  async function dial(mfa) {
    const payload = host.type === 'teleport'
      ? {
          type: 'teleport', name: host.name, hostname: host.hostname, uuid: host.uuid,
          cluster: host.cluster, proxy: host.proxy, home: host.home || null,
          ambiguous: !!host.ambiguous,
        }
      // A host defined in the app carries its own details instead of an alias.
      : {
          type: 'ssh', alias: host.alias, name: host.name, direct: host.direct || null,
          configFile: host.configFile || null, id: host.id,
          proxyJump: host.proxyJump || null,
        };
    const created = await window.api.conn.create(payload, { login, transport: mfa ? 'tsh' : undefined });
    state.setConnection(created.id, {
      id: created.id, label: created.label, target: created.target,
      type: created.type, state: 'idle', hostId: host.id, login,
      // Without this, the run-command dialog had no way to tell a tsh-transport
      // connection from a muxed one, and always used the non-interactive
      // `conn:exec` path — which has no pty for an MFA prompt to appear on.
      transport: created.transport || (mfa ? 'tsh' : 'mux'),
    });
    try {
      const info = await window.api.conn.connect(created.id);
      state.setConnection(created.id, { state: 'connected', ...info });
      return created.id;
    } catch (e) {
      // A connection that never came up is nothing worth keeping around —
      // least of all one about to be retried over a different transport,
      // which would otherwise leave the failed attempt sitting in the list
      // forever in state 'error'.
      await window.api.conn.disconnect(created.id).catch(() => {});
      state.removeConnection(created.id);
      throw e;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Port forwarding                                                     */
/* ------------------------------------------------------------------ */

const FORWARD_KINDS = [
  { value: 'L', label: 'Local  (-L)  — a port on this Mac reaches a remote service' },
  { value: 'R', label: 'Remote (-R)  — a port on the server reaches a local service' },
  { value: 'D', label: 'Dynamic (-D) — SOCKS5 proxy through the server' },
];

/**
 * Choose a host from the whole inventory.
 *
 * Needed wherever something is set up *for* a host without one being in hand
 * — a favourite tunnel is defined before anything is open. Searchable because
 * an inventory is not a list you point at.
 */
export async function pickHost() {
  const all = [
    ...[...state.teleportNodes.values()].flat(),
    ...(state.sshHosts || []),
  ];
  const search = textInput({ placeholder: 'Search hosts…', autofocus: true });
  const rows = el('div', { class: 'picker-list' });
  const count = el('div', { class: 'hint', style: 'margin-top:8px' });

  return modal({
    title: 'Choose a host',
    subtitle: `${all.length} host${all.length === 1 ? '' : 's'} in the list`,
    render: (body, { close }) => {
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const shown = (q
          ? all.filter((h) => `${h.name || ''} ${h.alias || ''} ${h.hostname || ''} ${h.cluster || ''}`
            .toLowerCase().includes(q))
          : all).slice(0, 300);
        clear(rows);
        for (const h of shown) {
          rows.append(el('div', { class: 'picker-item', onClick: () => close(h) },
            el('span', { class: 'pname', text: h.name || h.alias }),
            el('span', { class: 'tag', text: h.type === 'teleport' ? (h.cluster || 'tsh') : 'ssh' })));
        }
        if (!shown.length) rows.append(el('div', { class: 'sb-empty', text: 'No matches.' }));
        count.textContent = `${shown.length} shown${shown.length < all.length ? ` of ${all.length}` : ''}`;
      };
      search.addEventListener('input', draw);
      body.append(field('Host', search), rows, count);
      draw();
    },
    buttons: [{ label: 'Cancel', value: null }],
  });
}

/**
 * What a favourite has to remember about its host.
 *
 * Kept whole rather than as an id, because a favourite outlives the inventory
 * it was made from: log out of the cluster and back in, restart the app, and
 * the row must still know what to dial. Only the fields a connection needs.
 */
export function favoriteHostRef(host) {
  if (!host) return null;
  return {
    id: host.id,
    type: host.type || 'ssh',
    name: host.name || host.alias || '',
    alias: host.alias || null,
    hostname: host.hostname || null,
    uuid: host.uuid || null,
    cluster: host.cluster || null,
    proxy: host.proxy || null,
    home: host.home || null,
    direct: host.direct || null,
    configFile: host.configFile || null,
  };
}

/** Star a forward: this shape, on this host, worth having again tomorrow. */
export async function saveForwardFavorite(host, fwd, { login, name } = {}) {
  const ref = favoriteHostRef(host);
  if (!ref) throw new Error('Nothing to open this on — the host is no longer in the list.');
  await window.api.forward.favoriteAdd({
    name: name || '',
    kind: fwd.kind,
    bindPort: fwd.bindPort,
    bindAddr: fwd.bindAddr || '',
    destHost: fwd.destHost || '',
    destPort: fwd.destPort || 0,
    host: ref,
    login: login || null,
  });
}

/** Open a favourite: dial its host if needed, then put the tunnel back up. */
export async function openForwardFavorite(fav) {
  status('Opening tunnel…', 0);
  try {
    const id = await ensureConnection(fav.host, fav.login || undefined);
    await window.api.forward.add(id, {
      kind: fav.kind,
      bindPort: fav.bindPort,
      bindAddr: fav.bindAddr || '',
      destHost: fav.destHost || '',
      destPort: fav.destPort || undefined,
    });
    await window.api.forward.favoriteUsed(fav.id).catch(() => {});
    toast('Tunnel open — ' + describeFavorite(fav), 'success');
    const { openDock } = await import('./dock.js');
    openDock('forwards');
  } catch (e) {
    toast(e.message, 'error');
  } finally { status(''); }
}

export function describeFavorite(f) {
  if (f.kind === 'D') return `SOCKS5 on ${f.bindAddr || 'localhost'}:${f.bindPort}`;
  if (f.kind === 'L') return `${f.bindAddr || 'localhost'}:${f.bindPort} → ${f.destHost}:${f.destPort}`;
  return `server:${f.bindPort} → ${f.destHost}:${f.destPort}`;
}

export async function openPortForwardDialog(host, { login, connId, preset } = {}) {
  const kindSel = select(FORWARD_KINDS, preset?.kind || 'L');
  const bindPort = textInput({ type: 'number', value: String(preset?.bindPort || 8080), min: 1, max: 65535 });
  const destHost = textInput({ value: preset?.destHost || 'localhost', placeholder: 'localhost' });
  const destPort = textInput({ type: 'number', value: String(preset?.destPort || 80), min: 1, max: 65535 });
  const bindAddr = textInput({ value: preset?.bindAddr || '', placeholder: 'localhost (default)' });
  // Keeping it is a tick and a name, on the dialog that already has every
  // other detail — the moment you know it is worth keeping is now.
  const favIn = checkbox('Keep this as a favourite', !!preset?.name);
  const favName = textInput({ value: preset?.name || '', placeholder: 'Database on the replica' });
  const favRow = field('Name it', favName);
  const syncFav = () => favRow.classList.toggle('hidden', !favIn.input.checked);
  favIn.input.addEventListener('change', syncFav);

  const destBlock = el('div', { class: 'field-row' },
    field('Destination host', destHost),
    field('Destination port', destPort));

  const explain = el('div', { class: 'hint', style: 'margin-top:2px' });
  const syncExplain = () => {
    const k = kindSel.value;
    destBlock.classList.toggle('hidden', k === 'D');
    const bp = bindPort.value || '?';
    if (k === 'L') {
      explain.textContent = `localhost:${bp} on this Mac → ${destHost.value || '?'}:${destPort.value || '?'} as seen from the server.`;
    } else if (k === 'R') {
      explain.textContent = `Port ${bp} on the server → ${destHost.value || '?'}:${destPort.value || '?'} as seen from this Mac. Needs GatewayPorts on the server to accept non-local clients.`;
    } else {
      explain.textContent = `SOCKS5 proxy on localhost:${bp}; point a browser or curl at it to exit through the server.`;
    }
  };
  [kindSel, bindPort, destHost, destPort].forEach((i) => i.addEventListener('input', syncExplain));
  kindSel.addEventListener('change', syncExplain);

  const res = await modal({
    title: 'Port forward',
    subtitle: host?.name || host?.alias || '',
    render: (body) => {
      body.append(
        field('Type', kindSel),
        el('div', { class: 'field-row' },
          field('Listen port', bindPort),
          field('Listen address (optional)', bindAddr)),
        destBlock,
        explain,
        el('div', { style: 'margin-top:10px' }, favIn, favRow));
      syncExplain();
      syncFav();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Create tunnel', class: 'primary-btn',
        onClick: ({ close }) => {
          const port = parseInt(bindPort.value, 10);
          if (!port || port < 1 || port > 65535) return toast('Enter a valid listen port', 'error');
          if (kindSel.value !== 'D') {
            const dp = parseInt(destPort.value, 10);
            if (!destHost.value.trim()) return toast('Destination host is required', 'error');
            if (!dp) return toast('Enter a valid destination port', 'error');
          }
          close({
            kind: kindSel.value,
            bindPort: port,
            bindAddr: bindAddr.value.trim(),
            destHost: destHost.value.trim(),
            destPort: parseInt(destPort.value, 10) || undefined,
            favorite: favIn.input.checked,
            favoriteName: favName.value.trim(),
          });
        },
      },
    ],
  });
  if (!res) return;

  try {
    status('Opening tunnel…', 0);
    const id = connId || await ensureConnection(host, login);
    const rec = await window.api.forward.add(id, res);
    const desc = rec.kind === 'D'
      ? `SOCKS5 on localhost:${rec.bindPort}`
      : rec.kind === 'L'
        ? `localhost:${rec.bindPort} → ${rec.destHost}:${rec.destPort}`
        : `server:${rec.bindPort} → ${rec.destHost}:${rec.destPort}`;
    if (res.favorite) {
      await saveForwardFavorite(host, res, { login, name: res.favoriteName })
        .catch((e) => toast('Tunnel is open, but it was not saved: ' + e.message, 'error'));
    }
    toast('Tunnel open — ' + desc, 'success');
    const { openDock } = await import('./dock.js');
    openDock('forwards');
  } catch (e) {
    toast(e.message, 'error');
  } finally { status(''); }
}

/* ------------------------------------------------------------------ */
/* Server profile                                                      */
/* ------------------------------------------------------------------ */

export async function openServerInfo(host, { login, connId } = {}) {
  let info = null;
  let body = null;
  let id = connId;

  /*
   * Which account the probe is running as.
   *
   * Tracked rather than fixed, because the commonest reason a profile fails
   * is that it was attempted as an account that does not exist on the box —
   * a cluster granting `ec2-user`, `ubuntu` and `rocky` will happily offer
   * the first of them for a host that only has the third.
   */
  let currentLogin = login;

  const load = async (refresh, retryAs) => {
    if (!body) return;
    if (retryAs) {
      currentLogin = retryAs;
      // The connection that failed belongs to the old user; reusing it would
      // reproduce the failure and blame the new name for it.
      id = null;
    }
    body.replaceChildren(el('div', {
      class: 'sb-empty',
      text: (refresh ? 'Refreshing' : 'Probing server')
        + (currentLogin ? ` as ${currentLogin}…` : '…'),
    }));
    try {
      id = id || await ensureConnection(host, currentLogin, { fresh: !!retryAs });
      info = await window.api.conn.serverInfo(id, { refresh });
      // It worked, so this is the login for this host from now on — the same
      // bargain "Open as another user" already makes.
      if (retryAs) {
        const { rememberLogin } = await import('./sidebar.js');
        await rememberLogin(host.id, currentLogin).catch(() => {});
      }
      render();
    } catch (e) {
      /*
       * A reason and a way forward, rather than a wall of shell.
       *
       * This used to print the raw rejection, which for a failing probe was
       * Node's `Command failed: /usr/bin/ssh -F … <the whole script>` — four
       * lines of flattened one-liner that says nothing about the host and
       * cannot be acted on. The main process now yields a sentence; this
       * gives it somewhere to sit, with the retry that is the obvious next
       * thing to want.
       */
      const { loginOptionsFor, pickLogin } = await import('./sidebar.js');
      const options = (loginOptionsFor(host) || []).filter((l) => l !== currentLogin);

      body.replaceChildren(el('div', { style: 'padding:14px 2px' },
        el('div', {
          style: 'font-weight:600;margin-bottom:6px',
          text: currentLogin
            ? `Could not read the server profile as ${currentLogin}`
            : 'Could not read the server profile',
        }),
        el('div', { style: 'color:var(--red);font-size:12px;line-height:1.5', text: e.message }),
        /*
         * The account is named in the heading and the other ones are offered
         * here, because "wrong user" is the likeliest cause and the fix is a
         * name the cluster already knows. Saying which logins exist turns a
         * dead end into a choice.
         */
        options.length
          ? el('div', {
              class: 'hint',
              style: 'margin-top:10px',
              text: `This cluster also grants ${options.join(', ')} on this host’s `
                + 'behalf. If the account does not exist on the box, the profile fails '
                + 'exactly like this while another login works fine.',
            })
          : el('div', {
              class: 'hint',
              style: 'margin-top:10px',
              text: 'The profile is one command run over this session. A host behind a '
                + 'restricted shell or a forced command will refuse it while the terminal '
                + 'itself still works.',
            }),
        el('div', { style: 'display:flex;gap:6px;margin-top:12px' },
          el('button', {
            class: 'primary-btn sm',
            text: 'Try another user…',
            title: 'Dial again as a different account and remember it if it works',
            onClick: async () => {
              const who = await pickLogin(loginOptionsFor(host) || [], host, {
                title: 'Read the profile as',
                subtitle: host.name || host.alias,
                note: currentLogin
                  ? `${currentLogin} did not work. Pick another account on this host.`
                  : undefined,
              });
              if (who) load(true, who);
            },
          }),
          el('button', {
            class: 'ghost-btn sm',
            text: currentLogin ? `Try ${currentLogin} again` : 'Try again',
            onClick: () => load(true),
          }))));
    }
  };

  const render = () => {
    body.replaceChildren();
    const osId = (info.os_id || '').toLowerCase();

    /*
     * Some of it came back and some of it did not. Said out loud, because a
     * row that is simply absent reads as "this host has no such thing" rather
     * than "nobody managed to ask".
     */
    if (info.partial) {
      body.append(el('div', {
        class: 'hint',
        style: 'margin-bottom:12px;color:var(--amber)',
        text: `Some of this is missing — ${info.partial}`,
      }));
    }

    body.append(el('div', {
      style: 'display:flex;align-items:center;gap:11px;margin-bottom:14px;padding-bottom:13px;border-bottom:1px solid var(--border-soft)',
    },
      el('span', { style: 'font-size:30px', text: distroGlyph(osId, info.kernel_sys) }),
      el('div', {},
        el('div', { style: 'font-size:15px;font-weight:600', text: info.osLabel || 'Unknown system' }),
        el('div', { style: 'font-size:11.5px;color:var(--muted);font-family:var(--mono)', text: `${info.kernel_sys || ''} ${info.kernel || ''} · ${info.arch || ''}` }))));

    const rows = [
      ['Hostname', info.hostname],
      ['Logged in as', info.user],
      ['Login shell', info.shell],
      ['Uptime', info.uptime],
      ['Load average', info.load],
      ['CPU', info.cpu_model ? `${info.cpus || '?'} × ${info.cpu_model}` : info.cpus],
      ['Memory', info.memTotal
        ? `${fmtBytes(info.memTotal)} total${info.memAvail ? ` · ${fmtBytes(info.memAvail)} available` : ''}`
        : null],
      ['Disk /', info.disk_root],
      ['Virtualisation', info.virt && info.virt !== 'none' ? info.virt : null],
      ['Init system', info.init],
      ['Package manager', info.pkg],
      ['Users online', info.users_online],
      ['Tooling', [info.has_docker && 'docker', info.has_kubectl && 'kubectl', info.has_podman && 'podman',
        info.has_helm && 'helm', info.has_kustomize && 'kustomize']
        .filter(Boolean).join(', ') || null],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');

    const table = el('div', { style: 'display:grid;grid-template-columns:132px 1fr;gap:6px 14px;font-size:12px' });
    for (const [k, v] of rows) {
      table.append(
        el('div', { style: 'color:var(--muted)', text: k }),
        el('div', { style: 'font-family:var(--mono);font-size:11.5px;word-break:break-word', text: String(v) }));
    }
    body.append(table);

    // Teleport labels come from the cluster, not from probing the box, so they
    // belong here beside what the machine says about itself.
    const tags = labelEntries(host);
    if (tags.length) {
      body.append(el('div', {
        style: 'margin-top:15px;padding-top:13px;border-top:1px solid var(--border-soft)',
      },
        el('div', { style: 'font-size:11px;color:var(--muted);margin-bottom:7px', text: `Teleport tags (${tags.length})` }),
        el('div', { class: 'tagb-values' },
          ...tags.map(([k, v]) => el('span', { class: 'chip', style: 'cursor:default', title: `${k} = ${v}` },
            el('span', { class: 'k', text: k }),
            el('span', { class: 'v', text: v || '—' }))))));
    }

    body.append(el('div', {
      class: 'hint', style: 'margin-top:14px',
      text: `Probed ${fmtDate(info.fetchedAt)} over the existing connection.`,
    }));
  };

  await modal({
    title: 'Server profile',
    subtitle: host?.name || host?.alias || '',
    width: 'min(600px, 94vw)',
    render: (b) => { body = b; load(false); },
    buttons: [
      {
        label: 'Copy',
        onClick: () => {
          if (!info) return;
          const text = Object.entries(info)
            .filter(([k]) => !['fetchedAt', 'memTotal', 'memAvail'].includes(k))
            .map(([k, v]) => `${k}=${v}`).join('\n');
          window.api.clipboard.write(text);
          status('Server profile copied');
        },
      },
      { label: 'Refresh', onClick: () => load(true) },
      { label: 'Close', value: null },
    ],
  });
}

function distroGlyph(osId, kernelSys) {
  if (kernelSys === 'Darwin' || osId === 'macos') return '\u{1F34E}';
  if (/ubuntu/.test(osId)) return '\u{1F7E0}';
  if (/debian/.test(osId)) return '\u{1F300}';
  if (/rhel|centos|rocky|alma|fedora/.test(osId)) return '\u{1F3A9}';
  if (/amzn|amazon/.test(osId)) return '\u{1F4E6}';
  if (/alpine/.test(osId)) return '\u{1F3D4}';
  if (/suse/.test(osId)) return '\u{1F98E}';
  if (/arch/.test(osId)) return '\u{1F3F9}';
  if (/bsd/.test(osId)) return '\u{1F608}';
  return '\u{1F427}';
}


/* ------------------------------------------------------------------ */
/* Run one command on one server                                       */
/* ------------------------------------------------------------------ */

/**
 * The commands this dialog has actually run, most recent first — not a
 * Snippet: nothing here was named or deliberately kept, it is just what was
 * typed before, the way a shell's own history is. Capped and deduplicated
 * so running the same check five times in a row does not fill the list with
 * five copies of it.
 */
const MAX_COMMAND_HISTORY = 25;

function commandHistory() {
  return state.settings.commandHistory || [];
}

async function rememberCommand(cmd) {
  const list = [cmd, ...commandHistory().filter((c) => c !== cmd)].slice(0, MAX_COMMAND_HISTORY);
  state.settings = await window.api.settings.set({ commandHistory: list });
}

/**
 * Run a single command on a single host and show what it said.
 *
 * The common case is a question — "is it up", "what version", "is the disk
 * full" — that does not justify opening a session and typing. Multi-exec
 * answers it across a fleet; this answers it for one box, in place.
 */
export async function openRunCommandDialog(host, { login, logins = [], connId, command, title, autoRun = true } = {}) {
  const cmdIn = el('textarea', {
    style: 'width:100%;height:78px;font-family:var(--mono);font-size:12px',
    placeholder: 'systemctl status nginx',
    spellcheck: 'false',
  });
  // A caller that supplies a command (a macro, say) has already chosen it; the
  // last ad-hoc command is only a convenience for the empty case.
  cmdIn.value = command || commandHistory()[0] || '';

  const output = el('pre', {
    style: 'margin:0;padding:9px 11px;background:var(--panel-2);border:1px solid var(--border);'
      + 'border-radius:var(--radius);font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;'
      + 'word-break:break-word;max-height:320px;overflow:auto;min-height:64px',
    text: 'Output appears here.',
  });
  const meta = el('div', { class: 'hint', style: 'margin-top:6px' });
  let running = false;
  let lastOutput = '';
  let id = connId;
  /*
   * Set only while a tsh-transport exec is waiting on an answer — per-session
   * MFA, which has no pty on the plain `conn:exec` path to prompt on at all.
   * See Connection.execInteractive.
   */
  let activeExecId = null;

  const promptInput = el('input', {
    type: 'password', placeholder: 'MFA code, or press Enter after tapping your key',
    style: 'width:100%',
  });
  const promptLabel = el('div', { class: 'hint', text: 'Waiting for a response…' });
  const promptRow = el('div', { style: 'margin-top:8px;display:none' }, promptLabel, promptInput);
  promptInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !activeExecId) return;
    window.api.conn.writeExec(id, activeExecId, promptInput.value + '\n');
    promptInput.value = '';
  });
  const showPrompt = (text) => {
    promptLabel.textContent = (text || '').trim().split('\n').filter(Boolean).pop() || 'Waiting for a response…';
    promptRow.style.display = '';
    promptInput.focus();
  };
  const hidePrompt = () => { promptRow.style.display = 'none'; };

  /*
   * Who it runs as, shown and changeable — as multi-exec has it. Filled with
   * the account that would be used now: an open session's, else the one
   * this host was last reached as. A different name opens a connection as
   * that user rather than reusing the open session, which is somebody else.
   */
  const openConn = connId ? state.getConnection(connId)
    : [...state.connections.values()].find((c) => c.hostId === host?.id && c.state === 'connected');
  const startAs = openConn?.login || login || '';
  const listId = `rc-logins-${Date.now()}`;
  const runAsIn = el('input', {
    class: 'mx-runas', value: startAs, placeholder: 'default login', spellcheck: 'false', list: listId,
    title: 'The account the command runs as on this host',
    style: 'width:100%',
  });
  const loginList = el('datalist', { id: listId },
    ...[...new Set([startAs, ...logins].filter(Boolean))].map((l) => el('option', { value: l })));
  const runAsNote = el('div', { class: 'hint', style: 'margin-top:4px' });
  const noteAs = () => {
    const who = runAsIn.value.trim();
    const conn = id ? state.getConnection(id) : openConn;
    runAsNote.textContent = !who ? 'Runs as the host’s default login.'
      : conn?.login === who ? `Runs as ${who}, over the session already open.`
        : `Runs as ${who}${conn?.login ? ` — a new connection; the open session is ${conn.login}` : ''}.`;
  };
  runAsIn.addEventListener('input', noteAs);
  noteAs();

  const run = async () => {
    const cmd = cmdIn.value.trim();
    if (!cmd) return toast('Enter a command', 'error');
    if (running) return;
    running = true;
    rememberCommand(cmd).catch(() => {});
    output.textContent = 'Running…';
    meta.textContent = '';
    hidePrompt();
    const t0 = Date.now();
    try {
      const who = runAsIn.value.trim() || login || null;
      const cur = id ? state.getConnection(id) : null;
      // The open connection only if it is the account asked for.
      if (!cur || (who && cur.login && cur.login !== who)) {
        const reuse = !who || openConn?.login === who;
        id = await ensureConnection(host, who, { fresh: !reuse });
      }
      meta.textContent = `Running as ${state.getConnection(id)?.login || who || 'the default login'}…`;

      const conn = state.getConnection(id);
      let out, failed = null;
      if (conn?.transport === 'tsh') {
        // Per-session MFA: `conn:exec` has no pty for the prompt to appear on
        // or be answered from, so this goes through the interactive exec
        // instead — the prompt row above shows and answers it.
        activeExecId = 'rc' + Date.now();
        const r = await window.api.conn.execInteractive(id, cmd, { execId: activeExecId });
        activeExecId = null;
        hidePrompt();
        out = r.stdout || '';
        if (r.exitCode !== 0) failed = (r.error || '').trim() || `exited ${r.exitCode}`;
      } else {
        out = await window.api.conn.exec(id, cmd);
      }

      lastOutput = failed ? (out.trim() ? `${out.trim()}\n\n${failed}` : failed) : out;
      output.textContent = failed
        ? (out.trim() ? `${out.trim()}\n\n${failed}` : failed)
        : (out.trim() || '(no output)');
      output.style.color = failed ? 'var(--red)' : '';
      meta.textContent = failed
        ? `Failed after ${fmtDuration(Date.now() - t0)}`
        : `As ${state.getConnection(id)?.login || 'the default login'} · finished in ${fmtDuration(Date.now() - t0)} · ${out.length} bytes`;
    } catch (e) {
      // A non-zero exit arrives here too; the message is the server's stderr.
      lastOutput = e.message;
      output.textContent = e.message || 'Command failed';
      output.style.color = 'var(--red)';
      meta.textContent = `Failed after ${fmtDuration(Date.now() - t0)}`;
    } finally {
      running = false;
      activeExecId = null;
      hidePrompt();
    }
  };

  cmdIn.addEventListener('keydown', (e) => {
    // Enter runs; Shift+Enter makes a multi-line script.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
  });

  await modal({
    title: title || 'Run a command',
    subtitle: host?.name || host?.alias || '',
    width: 'min(720px, 94vw)',
    render: (body) => {
      const recentBtn = el('button', {
        class: 'ghost-btn sm',
        style: 'position:absolute;top:4px;right:4px',
        text: 'Recent…',
        title: 'Pick a command run here before',
        onClick: (e) => {
          const list = commandHistory();
          if (!list.length) return toast('Nothing run yet', 'info');
          contextMenu(e.clientX, e.clientY, list.map((c) => ({
            // A script is several lines; the menu shows only the first so a
            // long one does not blow out the list, same as a shell history
            // search would.
            label: c.split('\n')[0].slice(0, 60) + (c.length > 60 || c.includes('\n') ? '…' : ''),
            onClick: () => { cmdIn.value = c; cmdIn.focus(); },
          })));
        },
      });
      body.append(
        field('Command', el('div', { style: 'position:relative' }, cmdIn, recentBtn), 'Enter runs it · Shift+Enter for a new line'),
        field('Run as', el('div', {}, runAsIn, loginList, runAsNote)),
        el('label', { style: 'font-size:11px;color:var(--muted);margin-bottom:5px;display:block', text: 'Output' }),
        output, meta, promptRow);
      setTimeout(() => cmdIn.focus(), 40);
      // Handed a command, get on with it rather than making the user press Run.
      if (command && autoRun) run();

      const offPrompt = window.api.conn.onExecPrompt((_connId, payload) => {
        if (payload.execId !== activeExecId) return;
        showPrompt(payload.text);
      });
      // Closed mid-prompt: stop listening, and stop the tsh process waiting
      // on an answer that is never coming rather than leave it running.
      return () => {
        offPrompt();
        if (activeExecId && id) window.api.conn.killExec(id, activeExecId);
      };
    },
    buttons: [
      {
        label: 'Copy output',
        onClick: () => {
          if (!lastOutput) return toast('Nothing to copy yet', 'info');
          window.api.clipboard.write(lastOutput);
          status('Output copied');
        },
      },
      {
        label: 'Save as snippet',
        onClick: async () => {
          const cmd = cmdIn.value.trim();
          if (!cmd) return toast('Enter a command first', 'error');
          const { editSnippet } = await import('./snippets.js');
          editSnippet({ command: cmd });
        },
      },
      { label: 'Run', class: 'primary-btn', onClick: () => run() },
      { label: 'Close', value: null },
    ],
  });
}
